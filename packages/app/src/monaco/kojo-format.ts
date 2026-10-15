import type * as Monaco from 'monaco-editor';
import { computeFormatEdits, type FormatDialect, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * 文档格式化的**宿主接线**（E1，`Shift+Alt+F`）。
 *
 * 分层照 `kojo-code-action` / `kojo-definition`：**规则与 edits 全在插件**
 * （`@kojo/plugin-kojo-sugar` 的 `computeFormatEdits`，纯函数），这里只做
 * Monaco 协议翻译 + "该不该应答这次请求"的宿主判断——宿主不认识缩进、不认识
 * 全角空格、更不认识结构错误该补什么。
 *
 * 三条与 Monaco 行为直接相关的取舍：
 * - **不给 `eol` 字段**：`formattingEdit.js` 见到 `edit.eol` 就会 `model.pushEOL()`
 *   整体改写行尾。规则层本来就不跨行，这里也不把行尾决定权交给格式化。
 * - **多条整行 edit**：Monaco 把返回值一次 `executeEdits('formatEditsCommand', …)`
 *   落地 ⇒ 天然**一个撤销步**（按一次 Ctrl+Z 撤销"这次格式化"，不是逐行撤销）。
 *   不用"整篇一条 edit"是因为整篇替换会丢光标锚定与最小 diff。
 * - **陈旧坐标夹取**：provider 与用户编辑之间没有锁，行号/列号可能已经过期，
 *   夹取而不是抛错（越界坐标不该让命令面板红一条 stack trace）。
 */

/** 一次格式化请求的中性事实（宿主给出文本与方言，纯逻辑才测得动） */
export interface FormatRequest {
  readonly text: string;
  readonly dialect: FormatDialect;
}

/** 只用到 model 的行列读数——纯函数因此可在 node 里拿假 model 测 */
export interface FormatModelShape {
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
}

/** 语言 id → 方言；认不出来 = `null`（不给格式化，而不是猜一种规则） */
export function dialectForLanguage(languageId: string): FormatDialect | null {
  if (languageId === KOJO_LANGUAGE_ID) return 'kojo';
  if (languageId === ERB_LANGUAGE_ID) return 'erb';
  return null;
}

/**
 * 规则 edits → Monaco `TextEdit`（`range` 用普通对象：Monaco 内部 `Range.lift`
 * 只读这四个字段，构造 `new monaco.Range` 反而把纯函数绑到运行时上）。
 */
export function toTextEdits(
  model: FormatModelShape,
  edits: readonly FormatEdit[],
): Monaco.languages.TextEdit[] {
  const lineCount = model.getLineCount();
  const out: Monaco.languages.TextEdit[] = [];
  for (const edit of edits) {
    const line = Math.min(Math.max(1, Math.trunc(edit.line) || 1), lineCount);
    const maxColumn = model.getLineMaxColumn(line);
    const endColumn = Math.min(Math.max(1, Math.trunc(edit.endColumn) || 1), maxColumn);
    const startColumn = Math.min(Math.max(1, Math.trunc(edit.startColumn) || 1), endColumn);
    out.push({
      range: { startLineNumber: line, startColumn, endLineNumber: line, endColumn },
      text: edit.text,
    });
  }
  return out;
}

/** 宿主注入：这份 model 该不该被格式化（返回 `null` = 不应答） */
export interface FormatHandlers {
  resolve(model: Monaco.editor.ITextModel): FormatRequest | null;
}

/**
 * 为 ERB 方言与 `.kojo` 两个语言 id 注册整篇格式化 provider。
 *
 * `Shift+Alt+F` 是 Monaco 内建动作（`editor.action.formatDocument`），
 * **不需要**新命令、也不动快捷键表——注册 provider 就是全部的接线面。
 */
export function installDocumentFormatter(
  monaco: typeof Monaco,
  handlers: FormatHandlers,
): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentFormattingEditProvider = {
    displayName: 'kojo-editor',
    provideDocumentFormattingEdits(model) {
      let request: FormatRequest | null;
      try {
        request = handlers.resolve(model);
      } catch (e: unknown) {
        console.warn(`[kojo-format] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
      if (!request) return [];
      let edits: FormatEdit[];
      try {
        edits = computeFormatEdits(request.text, request.dialect);
      } catch (e: unknown) {
        // 规则层出错就"这次不格式化"，不能让命令本身炸掉编辑器
        console.warn(`[kojo-format] computeFormatEdits 抛错：${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
      return toTextEdits(model, edits);
    },
  };
  const subs = [
    monaco.languages.registerDocumentFormattingEditProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerDocumentFormattingEditProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
