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
 */
import * as monaco from '../monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../monaco/kojo2-language';
import { isKojo2CutoverEnabled } from './kojo2-flag';
import { getKojo2CutoverController } from './kojo2-cutover';
import { createEditorModelPool, languageFor } from './editor-model-pool';

/** 建 model 时选语言：开关关 / 非 2.0 文件 ⇒ 与收口前同一条 `languageFor` */
function languageIdForModel(path: string, text: string): string {
  if (!isKojo2CutoverEnabled()) return languageFor(path);
  const route = getKojo2CutoverController().route({ filePath: path, source: text });
  switch (route.kind) {
    case 'resolved':
      return route.parser === 'kojo2' ? KOJO2_LANGUAGE_ID : languageFor(path);
    case 'ambiguous':
      // 唯一兜底是 v1（`route.fallback`），提示由打开链路露给作者，这里不另造文案。
      return languageFor(path);
    case 'blocked':
      // 阶段把 2.0 面关着：不把 2.0 文件塞给 v1 词法（那会把整篇标成错误）。
      return 'plaintext';
    case 'needs-content':
    case 'not-kojo':
      return languageFor(path);
  }
}

export const editorModelPool = createEditorModelPool({
  readText: (kernel, path) => kernel.io.readText(path),
  createModel: (path, text) =>
    monaco.editor.createModel(text, languageIdForModel(path, text), monaco.Uri.file(path)),
  // PS-12 冷档三注入（缺一即冷档禁用）：
  // 码元记账走 getValueLength（不拼整篇字符串）；干净判据与 EditorPane 脏判定同口径
  // （getAlternativeVersionId，BUG-4）；补写盘经 kernel.io.writeText（写域强制由内核把关）。
  // `file.changed` 订阅不在此注入——bus 经 acquire 流入的 kernel 幂等挂（见 bindFileChanges）。
  modelUnits: (model) => model.getValueLength(),
  modelVersion: (model) => model.getAlternativeVersionId(),
  writeText: (kernel, path, text) => kernel.io.writeText(path, text),
});
