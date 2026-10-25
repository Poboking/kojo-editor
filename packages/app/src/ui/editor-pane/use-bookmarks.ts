/**
 * 书签的**编辑器装饰层**（1026 编辑器体感 C 批）：把 `ui/bookmarks.ts` 的行号集合铺到
 * glyph margin 与行背景上，并把 Monaco 的内容变更折回书签（行号漂移）。
 *
 * 形态照 `use-breadcrumb.ts`：不是 React hook，而是一枚**安装器**——调用点在
 * `use-monaco-instance.ts` 的创建 effect 里（create 之后、卸载清账段对应一处拆），
 * 时序与既有的偏好 / 面包屑安装同拍。判据全在 `ui/bookmarks.ts`，这里只做三件事：
 *
 * 1. **铺**：按当前 model 对应路径的书签行建装饰（`createDecorationsCollection`，
 *    vendor `codeEditorWidget.js:981` 核过）。**没有全文扫描**——书签集合本身稀疏，
 *    只按行号造 Range，与 `editor-options.ts` 的大文件性能纪律不冲突。
 * 2. **收**：四类边界都清干净——销毁（退订 + `collection.clear()`）、换标签
 *    （`onDidChangeModel` → 按新路径重铺）、挂/撤糖预览（`isDerivedView()` 为真 ⇒ 清空：
 *    投影行号与原文行号不是一把尺，画上去就是错位）、只读面（装饰可画，书签是内存态，
 *    不落盘、不越写盘闸）。
 * 3. **漂**：`onDidChangeModelContent` 把 Monaco 的 `changes` 折成
 *    `BookmarkChange` 交给 `applyContentChanges`——**原文面**才折（投影面是派生物，
 *    不动书签）；MAX 行数取编辑后的 `model.getLineCount()`，给夹取一个上界。
 */
import * as monaco from '../../monaco/entry';
import {
  BOOKMARK_GLYPH_CLASS,
  BOOKMARK_LINE_CLASS,
  applyContentChanges,
  bookmarkLinesOf,
  subscribeBookmarks,
  type BookmarkChange,
} from '../bookmarks';

/** 安装器入参：宿主只交"当下在哪份文件、是不是投影面"两条活读数，不复制书签判据 */
export interface BookmarkDecorationHost {
  /** 当前文件路径（`''` = 没有文件） */
  getPath: () => string;
  /** 屏幕上是不是糖预览投影（真 ⇒ 不铺装饰：投影行号不是原文行号） */
  isDerivedView: () => boolean;
}

/**
 * 装饰选项（**每次重铺复用同一份**：Monaco 读的是值，不在热路径上反复造对象）。
 * 颜色走主题 token（`bookmark-gutter.css`），overview ruler 那一枚用固定色——
 * 缩略图色块不随主题翻是刻意的（与 VSCode 书签扩展同观感）。
 */
const BOOKMARK_DECORATION_OPTIONS: monaco.editor.IModelDecorationOptions = {
  isWholeLine: true,
  className: BOOKMARK_LINE_CLASS,
  glyphMarginClassName: BOOKMARK_GLYPH_CLASS,
  glyphMarginHoverMessage: { value: '书签（切换书签命令可取消）' },
  overviewRuler: { color: '#4a86e8cc', position: monaco.editor.OverviewRulerLane.Left },
};

/** Monaco 的一次内容变更 → 行锚视图（旧坐标 + 行数差；口径见 `BookmarkChange`） */
function toBookmarkChange(change: monaco.editor.IModelContentChange): BookmarkChange {
  const startLine = change.range.startLineNumber;
  const endLine = change.range.endLineNumber;
  const replacedLines = change.text.length === 0 ? 0 : change.text.split('\n').length;
  return { startLine, endLine, lineDelta: replacedLines - (endLine - startLine + 1) };
}

/**
 * 把书签装饰挂到一个编辑器实例上；返回卸载函数（退订两条监听 + 清装饰）。
 *
 * 装饰集合 `createDecorationsCollection()` 由本函数独占，卸载只 `clear()` 不 `dispose()`：
 * Monaco 的集合随 model / 编辑器一并回收，多 dispose 一次没有意义，clear 已足够摘干净。
 */
export function installBookmarkDecorations(
  ed: monaco.editor.IStandaloneCodeEditor,
  host: BookmarkDecorationHost,
): () => void {
  const collection = ed.createDecorationsCollection();

  const refresh = (): void => {
    const model = ed.getModel();
    const path = host.getPath();
    // 投影面 / 无文件 / 模型已 dispose ⇒ 一枚都不画（换标签与挂撒预览都落到这一条上）
    if (model === null || model.isDisposed() || path === '' || host.isDerivedView()) {
      collection.set([]);
      return;
    }
    const maxLine = model.getLineCount();
    const lines = bookmarkLinesOf(path).filter((line) => line >= 1 && line <= maxLine);
    if (lines.length === 0) {
      collection.set([]);
      return;
    }
    collection.set(
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: BOOKMARK_DECORATION_OPTIONS,
      })),
    );
  };

  const unsubscribe = subscribeBookmarks(refresh);
  const modelSub = ed.onDidChangeModel(refresh);
  // 编辑热路径：投影面不折（派生行号不是原文行号），原文面把变更交给书签纯逻辑。
  // 无书签的文件在 applyContentChanges 里第一行就返回，零落盘零广播。
  const contentSub = ed.onDidChangeModelContent((event) => {
    if (host.isDerivedView()) return;
    const path = host.getPath();
    if (path === '') return;
    applyContentChanges(
      path,
      event.changes.map(toBookmarkChange),
      ed.getModel()?.getLineCount(),
    );
  });

  refresh();
  return () => {
    unsubscribe();
    modelSub.dispose();
    contentSub.dispose();
    collection.clear();
  };
}