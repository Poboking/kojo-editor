import type * as Monaco from './entry';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { labelScopeAt, type ErbLabelOccurrence, type ErbLabelScope } from '@kojo/plugin-erb-parser';
import { erbFactsPathOf } from './erb-completion-declared';
import {
  derivedLegSurfaceOf,
  isDerivedModelUri,
  type DerivedLegSurface,
} from './erb-dim-navigation';

/**
 * `$` 标签的**宿主导航面**（W-2，2026-10-19）：F12 定义自跳、Shift+F12 查找引用、
 * F2 重命名共用同一份作用域读数（`@kojo/plugin-erb-parser` 的 `labelScopeAt`）。
 *
 * 与 `#DIM` 那条腿（`erb-dim-navigation.ts`）同口径：
 * - 数据源是**当前缓冲区文本**（脏缓冲也正确），项目索引零参与——标签是函数局部事实；
 * - `.kojo` 是派生文本，行号不属于原文 ⇒ 只答 ERB 方言后缀；
 * - **升糖预览面按存档坐标作答**（2026-10-20 源坐标批）：读的是投影文本，交回的是
 *   存档路径 + 存档行，换算不出来的那一条整枚丢（判据与 `#DIM` 腿**同一枚**
 *   {@link derivedLegSurfaceOf}，两条本地腿不许各持一套映射）；
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
 * 作用域折到存档坐标（只在投影面上发生）：出现点逐条换算，**换算不出的那一条整枚丢**，
 * 列收进行首（投影行的列不属于存档行 ⇒ `column === endColumn` = 没有区间可说，
 * 下游 `revealSpanOf` 自然退化成零宽）。
 *
 * `erb-rename.ts` 也吃这份作用域，但**写**类动作只认原文 model（`canAnswer` = `owningPaneOf`，
 * 投影 model 是派生物、判据相反），这条腿在投影面上根本走不到这里；真有一天走到，
 * 折过的列对不上光标 ⇒ `occurrenceAt` 落空 → 带理由拒绝，fail-closed，不会按投影坐标硬写。
 * `functionStartLine` 无消费方读它（作用域边界已在解析器一侧用掉），折不回时留投影面的值，
 * 不假装知道存档那一头。
 */
function scopeToArchive(scope: ErbLabelScope, surface: DerivedLegSurface): ErbLabelScope {
  const occurrences: ErbLabelOccurrence[] = [];
  for (const occurrence of scope.occurrences) {
    const line = surface.lineOf(occurrence.line);
    if (line === null) continue;
    occurrences.push({ ...occurrence, filePath: surface.path, line, column: 1, endColumn: 1 });
  }
  return {
    ...scope,
    functionStartLine: surface.lineOf(scope.functionStartLine) ?? scope.functionStartLine,
    occurrences,
  };
}

/**
 * Monaco model + 位置 → 标签作用域（定义 + 本函数内全部跳转点；`null` = 此处不是标签）。
 * 取路径 / 取文本 / 解析全程 fail-open——导航不能把编辑器弄崩。
 *
 * 投影面上：闸走**存档路径**的后缀（投影 URI 只是编码过的字符串，拿它的尾巴当方言判据是巧合，
 * 不是判据），读数折成存档坐标；原文面逐字直通，一个字段都不碰。
 */
export function resolveErbLabelScopeAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): ErbLabelScope | null {
  try {
    const surface = derivedLegSurfaceOf(model);
    // 登记簿认不出归属实例的派生面：没有存档可依，交回的每一枚都是幻影 ⇒ 不应答
    if (surface === null && isDerivedModelUri(model)) return null;
    const path = surface === null ? erbFactsPathOf(model) : surface.path;
    if (path.length === 0 || !ERB_PATH_RE.test(path)) return null;
    const lineText = model.getLineContent(position.lineNumber);
    if (!LABEL_ENTRY_RE.test(lineText)) return null;
    const text = model.getValue();
    if (text.length === 0) return null;
    const scope = labelScopeAt(text, path, position.lineNumber, position.column);
    return scope === null || surface === null ? scope : scopeToArchive(scope, surface);
  } catch {
    return null;
  }
}

/**
 * 一处出现 → 落点。
 *
 * 区间只在**真有宽度**时才给：`column === endColumn` 是"这一枚被折到过行首"（投影面换算的
 * 必然形状，见 {@link scopeToArchive}），硬拼一个 `{n,n}` 的 span 是给下游发假区间。
 */
function labelLocation(occurrence: ErbLabelOccurrence, kind: EditorSymbolLocation['kind']): EditorSymbolLocation {
  return {
    filePath: occurrence.filePath,
    line: occurrence.line,
    column: occurrence.column,
    ...(occurrence.endColumn > occurrence.column
      ? { span: { columnStart: occurrence.column, columnEnd: occurrence.endColumn } }
      : {}),
    kind,
  };
}

/** 作用域里的 `$` 定义 → 导航落点（F12 自跳；重复定义全部保留） */
export function labelDefinitionLocations(scope: ErbLabelScope): EditorSymbolLocation[] {
  return scope.occurrences
    .filter((occurrence) => occurrence.kind === 'definition')
    .map((occurrence) => labelLocation(occurrence, 'definition'));
}

/**
 * 作用域里的全部出现 → 引用落点（Shift+F12）。
 *
 * 跳转目标记 `mention` 而不是 `call`：`GOTO` 是跳转不是调用，台账里的「被调用 M 处」
 * 不该把它算进去；定义行算 `definition`，面板差值因此可解释。
 */
export function labelReferenceLocations(scope: ErbLabelScope): EditorSymbolLocation[] {
  return scope.occurrences.map((occurrence) =>
    labelLocation(occurrence, occurrence.kind === 'definition' ? 'definition' : 'mention'),
  );
}
