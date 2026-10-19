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
 * - 数据源是**缓冲区文本**（脏缓冲也正确），项目索引零参与——标签是函数局部事实；
 * - `.kojo` 是派生文本，行号不属于原文 ⇒ 只答 ERB 方言后缀；
 * - **升糖预览面问原文、答存档坐标**（2026-10-20 中文谓词批）：投影面上那一行是中文谓词，
 *   而 `labelScopeAt` 只认 `$` 前缀与 `JUMP/GOTO` 系的行首原生记号 ⇒ 拿投影文本发问恒 `null`
 *   （F12 在 `跳到 NEXT` 上按了没反应）。派生面因此拿**原文缓冲 + 换算过的存档位点**发问，
 *   读数直接落在存档侧；归属与行换算与 `#DIM` 腿**同一枚** {@link derivedLegSurfaceOf}，
 *   两条本地腿不许各持一套映射。原文面（`isDerivedModelUri()` 为假）逐字直通，一个字段不碰。
 * - fail-open：路径缺席 / 文本为空 / 行越界 / 位点落不到入口 ⇒ `null`，不抛。
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
 * 源行文本（`\r\n` 归一后按 `\n` 切；与 `erb-dim-navigation.ts` 的 `linesOf`、解析器
 * `labelScopeAt` 内部的切法逐字同一条）。派生面只交 `sourceText` + 行数，本层不自建第二张
 * 行表——切同一份文本两次得到的必然是同一批行。
 */
function sourceRowOf(sourceText: string, line: number): string | undefined {
  return sourceText.replace(/\r\n?/g, '\n').split('\n')[line - 1];
}

/**
 * 投影面上的光标 → **发问用的存档位点**（`null` = 位点越界 / 那一格根本没有源行）。
 *
 * 行：{@link DerivedLegSurface.lineOf}（认的就是与投影 model 同批换上的那张 `sugarLineMapRef`，
 * 本层不许自建第二份映射），再夹一道 `sourceLineCount` 界。
 * 列：**源行与投影行按行尾对齐**（`column` 相对行尾的距离在两面上同一把尺子），两头各夹一次：
 * 不许落到源行首列之前，也不许越过源行行尾（`+1` = 行尾那一格仍是合法列）。为什么列不能照抄：
 * 投影把**行首那串原生记号**换成中文谓词（`GOTO NEXT` → `跳到 NEXT`、`$NEXT` → `标签 NEXT`），
 * 谓词几字长随词形变；而载荷（标签名）**逐字带走并停在行尾**（`kojo-sugar/native-display/control.ts`
 * 的 `showTarget` / `renderLabel`，行尾 `;` 注释也原样缀回）⇒ 只剩"离行尾多远"在两面上等价。
 * 落不到入口上就是落不到 ⇒ **不再试别的列**（多试一格 = 光标停在谓词上也答，原文面没这规矩），
 * 宁可不给也不给假。
 */
function archivePointOf(
  surface: DerivedLegSurface,
  position: Monaco.Position,
): { readonly line: number; readonly column: number; readonly row: string } | null {
  const line = surface.lineOf(position.lineNumber);
  if (line === null || line < 1 || line > surface.sourceLineCount) return null;
  const shown = surface.shownLineOf(position.lineNumber);
  if (shown === undefined) return null;
  const row = sourceRowOf(surface.sourceText, line);
  if (row === undefined) return null;
  const column = Math.min(Math.max(row.length - shown.length + position.column, 1), row.length + 1);
  return { line, column, row };
}

/**
 * Monaco model + 位置 → 标签作用域（定义 + 本函数内全部跳转点；`null` = 此处不是标签）。
 * 取路径 / 取文本 / 解析全程 fail-open——导航不能把编辑器弄崩。
 *
 * **原文面**（`isDerivedModelUri()` 为假）：逐字直通——屏幕上那份 model 就是原文，判据、
 * 文本、行列一个字节都不碰。
 *
 * **投影面**：发问吃**原文缓冲 + 换算过的存档位点**（2026-10-20 中文谓词批）。为什么必须换
 * 文本：`labelScopeAt` 只认原文形状（`$` 前缀与 `JUMP/GOTO` 系的行首记号），中文谓词占了
 * 那个位置 ⇒ 拿投影文本发问**恒 `null`**，作者明知"这一行就是一个标签"却按了没反应。
 * 前置闸同样要吃原文（拿投影行判 `LABEL_ENTRY_RE` = 又一次恒 null）。
 * 原文 model 取不到 / 空文本（{@link derivedLegSurfaceOf} 回 `null`）⇒ 本腿**不给结果**，
 * 绝不退回投影文本凑一个形状。
 *
 * 出口**不折行号**（`#DIM` 腿那条 `toArchiveCoords` 用在这里是错的：那份作用域的行列本来就生在
 * 存档侧，再折一遍就是折两遍），只把身份钉回存档路径。于是这里交出的**是真列、真区间**
 * （量的是源行自己的宽度），与 `#DIM` 两条腿（取投影面的列、一律收到行首）形状不同——
 * 裁决书点名接受这个不同：原文面上的行为逐字不变是唯一硬约束。
 */
export function resolveErbLabelScopeAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): ErbLabelScope | null {
  try {
    const surface = derivedLegSurfaceOf(model);
    if (surface === null) {
      // 登记簿认不出归属实例的派生面 / 原文 model 取不到：没有原文可依，交回的每一枚都是幻影 ⇒ 不应答
      if (isDerivedModelUri(model)) return null;
      const path = erbFactsPathOf(model);
      if (path.length === 0 || !ERB_PATH_RE.test(path)) return null;
      const lineText = model.getLineContent(position.lineNumber);
      if (!LABEL_ENTRY_RE.test(lineText)) return null;
      const text = model.getValue();
      if (text.length === 0) return null;
      return labelScopeAt(text, path, position.lineNumber, position.column);
    }
    // 方言闸走**存档路径**的后缀（投影 URI 只是编码过的字符串，拿它的尾巴当判据是巧合不是判据）
    if (surface.path.length === 0 || !ERB_PATH_RE.test(surface.path)) return null;
    if (surface.sourceText.length === 0 || surface.sourceLineCount === 0) return null;
    const at = archivePointOf(surface, position);
    if (at === null || !LABEL_ENTRY_RE.test(at.row)) return null;
    const scope = labelScopeAt(surface.sourceText, surface.path, at.line, at.column);
    return scope === null ? null : toArchiveSideScope(scope, surface);
  } catch {
    return null;
  }
}

/**
 * 源侧作用域 → 存档作用域：只做**身份**这一件事（解析器把传进去的 `path` 原样带回，这里再钉
 * 一遍，绝不让任何一枚带着投影 URI 出门——`mergeSymbolLocations` 把本地腿排在最前、
 * `planDefinitionJump` 的事件通道兜底只取第一枚，一枚幻影就顶掉一次真跳转）。
 * 行、列、区间**逐字照原样交回**：它们量的就是存档那一行（见 {@link resolveErbLabelScopeAt}）。
 */
function toArchiveSideScope(scope: ErbLabelScope, surface: DerivedLegSurface): ErbLabelScope {
  return {
    ...scope,
    occurrences: scope.occurrences.map((occurrence) => ({ ...occurrence, filePath: surface.path })),
  };
}

/**
 * 一处出现 → 落点。
 *
 * 区间只在**真有宽度**时才给：`column === endColumn` = 没有区间可说（零宽那一格交给下游
 * `revealSpanOf` 自然退化），硬拼一个 `{n,n}` 的 span 是给下游发假区间。
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
