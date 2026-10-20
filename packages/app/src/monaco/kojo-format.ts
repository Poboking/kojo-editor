import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import {
  computeFormatEdits,
  sugarEnterIndentAfter,
  type FormatDialect,
  type FormatEdit,
} from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';
import { registerForLanguageServices } from './register-dialects';

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
  /**
   * 规则开关（P2-14，additive；字段名与插件 `computeFormatEdits` 的第三参逐字对应，
   * 结构相容直传、不引插件类型——插件公共面本批冻结）。`undefined` = 全开，与
   * 规则开关出现之前逐字等价。开关的偏好面在 `ui/format-pref.ts`，**由宿主在组请求时
   * 现读填入**（`editor-global-providers.ts` 的 `formatResolve`），本层不自取偏好——
   * 纯函数层不读 localStorage，请求里带了什么就执行什么。
   */
  readonly rules?: FormatRuleSwitches;
}

/**
 * 规则开关的最小面（P2-14）：只声明宿主会传的两个布尔。
 * 与 `ui/format-pref.ts` 的 `FormatRules`（两布尔都落地）结构相容。
 */
export interface FormatRuleSwitches {
  readonly fullWidthSpace?: boolean;
  readonly indent?: boolean;
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
        console.warn(`[kojo-format] resolve 抛错：${errorText(e)}`);
        return [];
      }
      if (!request) return [];
      let edits: FormatEdit[];
      try {
        // 规则开关随请求走（缺省全开 = 与今天逐字等价）；偏好读取在宿主组请求时现读
        edits = computeFormatEdits(request.text, request.dialect, request.rules);
      } catch (e: unknown) {
        // 规则层出错就"这次不格式化"，不能让命令本身炸掉编辑器
        console.warn(`[kojo-format] computeFormatEdits 抛错：${errorText(e)}`);
        return [];
      }
      return toTextEdits(model, edits);
    },
  };
  return registerForLanguageServices(monaco, (m, id) =>
    m.languages.registerDocumentFormattingEditProvider(id, provider),
  );
}

/* ============================ ZH-D4：区间格式化 / 回车缩进 ============================ */

/** 行首空白串（口径同 formatter 的 `isIndentChar`：空格 / TAB / 全角空格） */
function leadingIndent(text: string): string {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\u3000')) i++;
  return text.slice(0, i);
}

/**
 * **区间格式化**（`Ctrl+Shift+I` / 命令面板「格式化选择区域」）：判据读**整篇**，
 * 但只把落在选区行内的 edits 交出去 ⇒ "选一段只重排那一段"。
 *
 * 为什么不切一段单独喂 `computeFormatEdits`：缩进单位探测与 `@` 原生块状态都是
 * **文档级**判据——片段视角下，块外的行会被当成糖行重排、单位探测会数错多数派。
 * 整篇判定 + 行区间过滤 = 与 `Shift+Alt+F` 逐字同口径，且代价相同（显式命令，一次一篇）。
 *
 * **只注册 `.kojo`**：ERB 的区间格式化由 `kojo-format-range.ts`（宿主 resolve 判据的
 * **带闸版**，同样只注册 ERB）独家负责。两边都注册 ERB 会让同一语言挂两枚 provider，
 * 选区格式化结果取决于注册表顺序、且带闸版的判据形同虚设——一门语言一枚 provider。
 */
export function installRangeFormatter(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentRangeFormattingEditProvider = {
    displayName: 'kojo-editor',
    provideDocumentRangeFormattingEdits(model, range) {
      const dialect = dialectForLanguage(model.getLanguageId());
      if (!dialect) return [];
      const lo = Math.min(range.startLineNumber, range.endLineNumber);
      const hi = Math.max(range.startLineNumber, range.endLineNumber);
      let edits: FormatEdit[];
      try {
        edits = computeFormatEdits(model.getValue(), dialect);
      } catch (e: unknown) {
        console.warn(`[kojo-format] 区间格式化抛错：${errorText(e)}`);
        return [];
      }
      return toTextEdits(model, edits.filter((edit) => edit.line >= lo && edit.line <= hi));
    },
  };
  const subs = [
    monaco.languages.registerDocumentRangeFormattingEditProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}

/**
 * **回车缩进兜底层**（on-type formatter，触发字符 `\n`）：块头行回车后，把新行的
 * 行首空白改成 `sugarEnterIndentAfter` 的精确判定结果。
 *
 * 与语言配置里的 `onEnterRules`（同步近似层）的分工：正则层负责按键瞬间的手感；
 * 本层负责正则层的已知缺口（块头行尾带 `;` 注释——`classifyLine` 先剥注释再判冒号，
 * 正则只看得到原文）。**Monaco 只在 `editor.formatOnType` 开启时才派发 on-type 请求**，
 * 所以它是增强层、不是唯一通路；单次代价 = 两行的词法分类（O(1)，与文档行数无关，
 * 大文件降级阈值不会被击穿——量测读数见 `tests/kojo-enter.test.ts`）。
 */
export function installEnterIndenter(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.OnTypeFormattingEditProvider = {
    autoFormatTriggerCharacters: ['\n'],
    provideOnTypeFormattingEdits(model, position) {
      if (model.getLanguageId() !== KOJO_LANGUAGE_ID) return [];
      if (position.lineNumber <= 1) return [];
      const current = model.getLineContent(position.lineNumber);
      // 只接手"新行还是空的/纯空白"：行中回车切出来的半截是原行的延续，不是新块体
      if (current.trim().length !== 0) return [];
      const desired = sugarEnterIndentAfter(model.getLineContent(position.lineNumber - 1));
      if (desired === null) return [];
      const currentIndent = leadingIndent(current);
      if (currentIndent === desired) return [];
      return [
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: currentIndent.length + 1,
          },
          text: desired,
        },
      ];
    },
  };
  return monaco.languages.registerOnTypeFormattingEditProvider(KOJO_LANGUAGE_ID, provider);
}
