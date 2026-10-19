import type * as Monaco from './entry';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { labelScopeAt, type ErbLabelScope } from '@kojo/plugin-erb-parser';
import { erbFactsPathOf } from './erb-completion-declared';

/**
 * `$` 标签的**宿主导航面**（W-2，2026-10-19）：F12 定义自跳、Shift+F12 查找引用、
 * F2 重命名共用同一份作用域读数（`@kojo/plugin-erb-parser` 的 `labelScopeAt`）。
 *
 * 与 `#DIM` 那条腿（`erb-dim-navigation.ts`）同口径：
 * - 数据源是**当前缓冲区文本**（脏缓冲也正确），项目索引零参与——标签是函数局部事实；
 * - `.kojo` 是派生文本，行号不属于原文 ⇒ 只答 ERB 方言后缀；
 * - fail-open：路径缺席 / 文本为空 / 行越界 / 光标不在标签入口 ⇒ `null`，不抛。
 *
 * 判别与作用域**不在本模块**：哪些字符算标签名、跳转槽怎么认、`[SKIPSTART]`
 * 怎么屏蔽、跨函数如何隔离，全部单源于解析器的 `labelScopeAt`（引用索引与导航
 * 各写一套就是"面板说有一处、F12 跳空"的漂移源）。
 */

/** ERB 方言后缀（`.kojo` 不参与；与 `erb-dim-navigation` 同一枚） */
const ERB_PATH_RE = /\.(?:erb|erh|erd)$/i;

/** 廉价前置：只有 `$` 定义行与跳转系语句才可能承载标签入口（避免每次 F12 全文 parse） */
const LABEL_ENTRY_RE = /^\s*(?:\$|(?:JUMP|GOTO|TRYJUMP|TRYGOTO)\b)/i;

/**
 * Monaco model + 位置 → 标签作用域（定义 + 本函数内全部跳转点；`null` = 此处不是标签）。
 * 取路径 / 取文本 / 解析全程 fail-open——导航不能把编辑器弄崩。
 */
export function resolveErbLabelScopeAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): ErbLabelScope | null {
  try {
    const path = erbFactsPathOf(model);
    if (path.length === 0 || !ERB_PATH_RE.test(path)) return null;
    const lineText = model.getLineContent(position.lineNumber);
    if (!LABEL_ENTRY_RE.test(lineText)) return null;
    const text = model.getValue();
    if (text.length === 0) return null;
    return labelScopeAt(text, path, position.lineNumber, position.column);
  } catch {
    return null;
  }
}

/** 作用域里的 `$` 定义 → 导航落点（F12 自跳；重复定义全部保留） */
export function labelDefinitionLocations(scope: ErbLabelScope): EditorSymbolLocation[] {
  return scope.occurrences
    .filter((occurrence) => occurrence.kind === 'definition')
    .map((occurrence) => ({
      filePath: occurrence.filePath,
      line: occurrence.line,
      column: occurrence.column,
      span: { columnStart: occurrence.column, columnEnd: occurrence.endColumn },
      kind: 'definition',
    }));
}

/**
 * 作用域里的全部出现 → 引用落点（Shift+F12）。
 *
 * 跳转目标记 `mention` 而不是 `call`：`GOTO` 是跳转不是调用，台账里的「被调用 M 处」
 * 不该把它算进去；定义行算 `definition`，面板差值因此可解释。
 */
export function labelReferenceLocations(scope: ErbLabelScope): EditorSymbolLocation[] {
  return scope.occurrences.map((occurrence) => ({
    filePath: occurrence.filePath,
    line: occurrence.line,
    column: occurrence.column,
    span: { columnStart: occurrence.column, columnEnd: occurrence.endColumn },
    kind: occurrence.kind === 'definition' ? 'definition' : 'mention',
  }));
}
