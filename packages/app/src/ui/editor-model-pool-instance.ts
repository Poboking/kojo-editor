/**
 * EditorPane 用的 model 池真身单例（SPLIT-1 分屏批）。
 *
 * 独立成模块的理由：池的工厂（`editor-model-pool.ts`）刻意零值依赖 monaco，
 * 纯逻辑可单测；而单例的装配必须引用 `monaco.editor.createModel`——monaco 的
 * 模块图一加载就摸 `window`（`vs/base/browser/window`），把工厂与单例放同一个
 * 文件会让 node 环境下的纯逻辑测试在 import 阶段就炸。真身单例**必须**模块级——
 * 池的生命周期是整个应用会话，两组（两个 EditorPane 实例）共享的是同一个池；
 * 组件级实例会各计各的引用，等于没有池。
 */
import * as monaco from '../monaco/entry';
import { createEditorModelPool, languageFor } from './editor-model-pool';

export const editorModelPool = createEditorModelPool({
  readText: (kernel, path) => kernel.io.readText(path),
  createModel: (path, text) => monaco.editor.createModel(text, languageFor(path), monaco.Uri.file(path)),
});
