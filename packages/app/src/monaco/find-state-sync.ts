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

/** 读当前查找状态（逐字返回，交给 view-state-store 清洗）；补丁未生效 ⇒ null */
export function readFindState(ed: Monaco.editor.IStandaloneCodeEditor): SerializedFind | null {
  const controller = findControllerOf(ed);
  if (!controller) return null;
  const s = controller.getFindStateSilently();
  return {
    searchString: s.searchString,
    replaceString: s.replaceString,
    isRegex: s.isRegex,
    wholeWord: s.wholeWord,
    matchCase: s.matchCase,
  };
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
  return true;
}

/**
 * 订阅查找状态变更（作者改词、拨开关都要写存；store 侧自带 600ms 防抖）。
 * 补丁未生效 ⇒ 返回 null，调用方不必挂退订。
 *
 * **换 model 触发的 searchScope 事件不是作者改词，写存会串档**：`ed.setModel()` 会同步调起
 * find 贡献的 `_state.change({ searchScope: null, matchCase: … })`，而 findState 对
 * `searchScope=null` 恒置 `somethingChanged=true` ⇒ 每次换文件都无条件来一发。此刻
 * `searchString` 还是**上一个文件**的词（`change()` 不动它）、光标/折叠也还没恢复，写存就把
 * 上一个词 + 1:1 空视图盖进新文件的键。searchScope 只服务"仅在选区内查找"、不参与持久化，
 * 所以这类事件整条丢掉。
 *
 * 类型面：补丁里的 `IFindStateChangeEvents` 没有这个字段，而补丁文件是冻结件（不改），
 * 所以只能就地做运行时结构判断——不为此往补丁 d.ts 里加字段，也不 `as any` 整个事件。
 */
export function subscribeFindState(
  ed: Monaco.editor.IStandaloneCodeEditor,
  onChange: () => void,
): Monaco.IDisposable | null {
  const controller = findControllerOf(ed);
  if (!controller) return null;
  return controller.onDidChangeFindState((e) => {
    const ev = e as Monaco.editor.IFindStateChangeEvents & { searchScope?: boolean };
    if (ev.searchScope) return;
    onChange();
  });
}
