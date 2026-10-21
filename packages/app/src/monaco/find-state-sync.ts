/**
 * 查找状态的宿主接线（FIND-STATE-PERSIST A）。
 *
 * ## 为什么这一层必须存在
 *
 * 恢复"上次的查找词 + 三个开关"这件事，monaco 的公开 API 面做不到：
 * `IEditorFindOptions` 不含搜索词，`FindReplaceState` 未公开导出。
 * 唯一零补丁的路是执行 `editor.actions.findWithArgs` 命令，实测副作用是**弹查找框 +
 * 每次 56–84ms 的焦点劫持 + 首个恢复词被光标所在词按 `seedSearchStringFromSelection`
 * 顶掉**。本仓因此走 vendor 补丁（`patches/monaco-editor@0.57.0.patch`），在 find 贡献上
 * 公开三个有类型的方法；本文件是它们的**唯一**调用点——全是类型化调用，没有一处 `as any`。
 *
 * ## 静默语义（补丁给的口径，别拿命令面代替）
 *
 * 只改状态：不创建 FindWidget、不动 `isRevealed`、不改焦点、不吃选区/光标 seed、不写查找历史。
 *
 * ## 未打补丁时的行为（刻意不静默）
 *
 * 三枚方法任一缺失 ⇒ 读回 / 写存整拍跳过，返回 null。功能退回"没有这回事"，
 * 但绝不假装成功；`tests/find-state-persist.test.ts` 钉着"补丁已生效"的源码级断言，
 * 补丁没打上就红，不允许静默退化。
 */
import type * as Monaco from './entry';
import type { SerializedFind } from '../ui/view-state-store';

/** find 贡献的注册 id（与补丁所在的 CommonFindController.ID 逐字一致） */
export const FIND_CONTROLLER_ID = 'editor.contrib.findController';

/**
 * 取补丁后的 find 控制器。拿不到（贡献未注册 / **vendor 补丁没生效**）⇒ null，
 * 调用方据此整拍跳过；这一条判据同时也是"补丁生效"的运行时探针。
 */
export function findControllerOf(ed: Monaco.editor.IStandaloneCodeEditor): Monaco.editor.IFindController | null {
  const controller = ed.getContribution<Monaco.editor.IFindController>(FIND_CONTROLLER_ID);
  if (!controller) return null;
  if (
    typeof controller.setFindStateSilently !== 'function' ||
    typeof controller.getFindStateSilently !== 'function' ||
    typeof controller.onDidChangeFindState !== 'function'
  ) {
    return null;
  }
  return controller;
}

/**
 * 本会话"查找被动过"的登记册（键 = find 控制器实例，编辑器销毁即随 WeakSet 回收）。
 * 判据来源只有两处：`onDidChangeFindState` 的任一事件（作者拨框、程序放回都算——放回的值
 * 就是该文件此刻的真状态，理应当"有可写"）与 `writeFindState` 成功一拍。
 * 口径（FIND-STATE-PERSIST 覆盖修复①）：**全默认空 且 本会话没动过** ⇒ 这一拍无可写。
 * 真壳读数（停机前记 PERSIST2ND、开机首拍后全空）的根因就在这：补丁的 `getFindStateSilently`
 * 对从没用过查找框的 widget 也返回结构完整的**全空记录**，旧口径把它当合法值写存，
 * 把已记录的词覆盖掉。空串本身仍是合法值（作者清空过查找框＝动过 ⇒ 已登记）。
 */
const touchedFindControllers = new WeakSet<Monaco.editor.IFindController>();

/** 全默认空（词/替换词皆空串、三开关皆 false）＝ widget 从没被拨过的形状 */
export function isPristineFind(s: SerializedFind): boolean {
  return s.searchString === '' && s.replaceString === '' && !s.isRegex && !s.wholeWord && !s.matchCase;
}

/**
 * 读当前查找状态（逐字返回，交给 view-state-store 清洗）；补丁未生效 ⇒ null。
 * 追加一条无可写判据：本会话未登记且当前值全默认空 ⇒ 也返回 null（这一拍不写存，
 * 覆盖闸的另一半在 store 的 `setViewState`——入参不带 find 时保留既有条目的 find）。
 */
export function readFindState(ed: Monaco.editor.IStandaloneCodeEditor): SerializedFind | null {
  const controller = findControllerOf(ed);
  if (!controller) return null;
  const s = controller.getFindStateSilently();
  const find: SerializedFind = {
    searchString: s.searchString,
    replaceString: s.replaceString,
    isRegex: s.isRegex,
    wholeWord: s.wholeWord,
    matchCase: s.matchCase,
  };
  if (!touchedFindControllers.has(controller) && isPristineFind(find)) return null;
  return find;
}

/**
 * 静默放回查找状态：三开关全传（monaco 对省略的开关是"保持现值"，漏传就是把上一个文件的
 * 值带进来）。成功返回 true；补丁未生效 ⇒ 不动状态、返回 false。
 */
export function writeFindState(ed: Monaco.editor.IStandaloneCodeEditor, find: SerializedFind): boolean {
  const controller = findControllerOf(ed);
  if (!controller) return false;
  controller.setFindStateSilently({
    searchString: find.searchString,
    replaceString: find.replaceString,
    isRegex: find.isRegex,
    wholeWord: find.wholeWord,
    matchCase: find.matchCase,
  });
  // 程序放回同样登记：放回值就是本文件此刻真状态，之后的快照拍必须照常写存
  // （不靠事件回环兜底——monaco 的 change 只在值真变时才发事件）。
  touchedFindControllers.add(controller);
  return true;
}

/**
 * 订阅查找状态变更（作者改词、拨开关都要写存；store 侧自带 600ms 防抖）。
 * 补丁未生效 ⇒ 返回 null，调用方不必挂退订。
 */
export function subscribeFindState(
  ed: Monaco.editor.IStandaloneCodeEditor,
  onChange: () => void,
): Monaco.IDisposable | null {
  const controller = findControllerOf(ed);
  if (!controller) return null;
  return controller.onDidChangeFindState(() => {
    // 先登记再上抛：宿主这次快照拍必须能读到"有可写"的判定（含作者清空查找框那拍）
    touchedFindControllers.add(controller);
    onChange();
  });
}
