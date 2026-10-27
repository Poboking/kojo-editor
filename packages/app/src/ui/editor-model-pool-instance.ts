/**
 * EditorPane 用的 model 池真身单例（SPLIT-1 分屏批）。
 *
 * 独立成模块的理由：池的工厂（`editor-model-pool.ts`）刻意零值依赖 monaco，
 * 纯逻辑可单测；而单例的装配必须引用 `monaco.editor.createModel`——monaco 的
 * 模块图一加载就摸 `window`（`vs/base/browser/window`），把工厂与单例放同一个
 * 文件会让 node 环境下的纯逻辑测试在 import 阶段就炸。真身单例**必须**模块级——
 * 池的生命周期是整个应用会话，两组（两个 EditorPane 实例）共享的是同一个池；
 * 组件级实例会各计各的引用，等于没有池。
 *
 * K2-CUTOVER-PRE 接线（`ui/kojo2-cutover.ts`）：建的 model 用哪个 language id 由
 * 切换控制器**路由**决定，不是只看扩展名。开关关着时路由恒等于 `languageFor(path)`
 * （逐字等价于收口前），开关打开后 `.kojo2` 才挂到 `kojo2` 语言面、`v1-only` 阶段
 * 的 `.kojo2` 则落 `plaintext`（打不开但也不塞给 v1 词法）。
 *
 * K2-CUTOVER-THEME 接线（`ui/kojo2-model-language.ts`）：建 model 时判一次不够——
 * `2.0-default` 阶段 `.kojo` 的解析器由**正文指纹**决定，正文变了、路径改了都得重判。
 * 所以每建一份 model 就挂一个重挂手柄：内容变化防抖后 `monaco.editor.setModelLanguage`，
 * 同语言不重挂、flag 关时整条链零动作；model 被池回收时手柄自动解绑（`onWillDispose`），
 * 不碰引用计数。判据与建 model 共用 {@link languageIdForKojo2Model} 一枚函数。
 */
import * as monaco from '../monaco/entry';
import { getKojo2CutoverController } from './kojo2-cutover';
import { isKojo2CutoverEnabled } from './kojo2-flag';
import {
  createKojo2ModelLanguageController,
  languageIdForKojo2Model,
  retargetKojo2ModelPath,
  type Kojo2LanguageModelLike,
} from './kojo2-model-language';
import { createEditorModelPool } from './editor-model-pool';
import { resolveModelLanguage, subscribeLanguageOverride } from './language-mode-pref';

/**
 * 建 model / 重挂共用的语言判据（LANG-OVERRIDE-MODEL）：作者手工选过的语言覆盖 >
 * 2.0 路由 / 扩展名判据。优先级那一格只有一份（`resolveModelLanguage`），
 * 本文件与状态栏读数都调它——建 model 与重挂也不会各写一套。
 *
 * 第三格 `currentLanguageId` **只有重挂路径会给**（控制器把 model 当前语言交回来）：
 * 语言可用性门封掉一门语言时，已认领的 model 不被刷成 `plaintext`（LAU §4.4；守门判据在
 * `monaco/language-registry.ts::keepClaimedLanguageWhenGated`）。建 model 那一刻没有
 * "当前语言"，不传即可。
 *
 * 覆盖变更那条跟随路（{@link subscribeLanguageOverride}  below）**故意不传**：那是作者
 * 亲手改了这一格的语言选择，答案就该如实——封存档里清掉覆盖 ⇒ 落 `plaintext`，
 * 而不是悄悄保持一门菜单里已经选不到的语言。
 */
function languageIdForModel(path: string, text: string, currentLanguageId?: string): string {
  return resolveModelLanguage(path, languageIdForKojo2Model(path, text, currentLanguageId));
}

/**
 * 进程级 model 语言重挂器（与池同生）。
 *
 * `setModelLanguage` 是唯一碰 Monaco 的出口；模型结构上满足 `Kojo2LanguageModelLike`
 * （`getValue` / `getLanguageId` / `onDidChangeContent` / `onWillDispose`），无需适配层。
 */
export const kojo2ModelLanguage = createKojo2ModelLanguageController({
  isEnabled: isKojo2CutoverEnabled,
  // 判据与建 model 同一枚（含语言覆盖）：内容变化重判时不能把作者手工选的语言拉回扩展名判据
  resolveLanguage: languageIdForModel,
  setModelLanguage: (model, languageId) => {
    monaco.editor.setModelLanguage(model as monaco.editor.ITextModel, languageId);
  },
});

// 切流阶段 / per-file override 是"路由事实"，不是"正文变化"：改档后开着的标签必须立刻
// 重新路由（`v1-only → dual` 时已开的 `.kojo2` 从 plaintext 挂回 `kojo2`）。flag 关时
// 不订阅——一个监听都不挂，与没有任何 2.0 面时逐字等价。
if (isKojo2CutoverEnabled()) {
  getKojo2CutoverController().subscribe(() => {
    kojo2ModelLanguage.refreshAll();
  });
}

export const editorModelPool = createEditorModelPool({
  readText: (kernel, path) => kernel.io.readText(path),
  createModel: (path, text) => {
    // 判据只算一次：建 model 用这一枚，attach 时也把它交回去 ⇒ 首次对齐不再重扫正文
    // （`.kojo` 在 2.0-default 阶段的指纹要扫全文，开一份大文件不该扫两遍）。
    const languageId = languageIdForModel(path, text);
    const model = monaco.editor.createModel(
      text,
      languageId,
      monaco.Uri.file(path),
    );
    kojo2ModelLanguage.attach(model, path, { languageId });
    return model;
  },
  // PS-12 冷档三注入（缺一即冷档禁用）：
  // 码元记账走 getValueLength（不拼整篇字符串）；干净判据与 EditorPane 脏判定同口径
  // （getAlternativeVersionId，BUG-4）；补写盘经 kernel.io.writeText（写域强制由内核把关）。
  // `file.changed` 订阅不在此注入——bus 经 acquire 流入的 kernel 幂等挂（见 bindFileChanges）。
  modelUnits: (model) => model.getValueLength(),
  modelVersion: (model) => model.getAlternativeVersionId(),
  writeText: (kernel, path, text) => kernel.io.writeText(path, text),
  // 覆盖变更时的跟随出口（LANG-OVERRIDE-MODEL）；缺省会让 `retargetLanguage` 静默不动，所以在这里给真身
  setModelLanguage: (model, languageId) => monaco.editor.setModelLanguage(model, languageId),
});

/**
 * 语言模式覆盖变更 ⇒ 该路径在池里的**全部 model** 立即跟随（LANG-OVERRIDE-MODEL）。
 *
 * 状态栏那一格只写偏好（同步广播）；订阅在这里装配，判据仍走 {@link languageIdForModel}
 * ——建 model / 重挂 / 跟随三处同一枚。同一路径不同拼写（大小写 / 分隔符）由池按 `pathKey`
 * 收口；`null`（撤销）时 `languageIdForModel` 自然回到 descriptor / 2.0 路由。
 */
subscribeLanguageOverride((filePath) => {
  editorModelPool.retargetLanguage(filePath, (model) =>
    languageIdForModel(filePath, model.getValue()),
  );
});

/* ============================== 另存为 / 改名接线（K2-EDITOR-MOUNT ③） ============================== */

/**
 * 盘上改名 / 另存为之后，把**仍活着的** model 按新路径重判 2.0 语言面。
 *
 * 接线点在壳层的盘上事实收尾（`App.tsx` 的 `onFilesGone`：`{ from, to }` 的唯一产地处）——
 * 改名把 `.kojo` 变 `.kojo2` 时，语言判据的答案会跟着变，不重判就是"文件已经叫 2.0 了，
 * 词法还挂在 v1 上"。
 *
 * 判据全在 `retargetKojo2ModelPath`（纯函数、可单测）；本函数只把池与控制器绑上去：
 * - 池里没有这一份（改名链路重建 model 的常见情形）⇒ `false`，新 model 建时 `attach`
 *   已按新路径判过，这里不猜；
 * - flag 关 ⇒ 控制器无挂载 ⇒ `false`（零监听、零动作，v1 行为逐字不变）。
 */
export function retargetKojo2RenamedModel(fromPath: string, nextPath: string): boolean {
  return retargetKojo2ModelPath(
    { fromPath, nextPath },
    {
      liveModel: (filePath) =>
        editorModelPool.liveModel(filePath) as unknown as Kojo2LanguageModelLike | undefined,
      retarget: (model, path) => kojo2ModelLanguage.retarget(model, path),
    },
  );
}
