import type * as Monaco from './entry';
import { labelScopeAt, type ErbLabelScope } from '@kojo/plugin-erb-parser';
import { isErbDefinitionPath } from '@kojo/plugin-erb-parser';
import { erbFactsPathOf } from './erb-completion-declared';
import {
  derivedLegSurfaceOf,
  isDerivedModelUri,
  surfaceRequestPointOf,
  type DerivedLegSurface,
} from './erb-dim-navigation';

// 标签落点投影已随供方搬进解析器插件；用例仍从本模块取（生产码只经插件读它）。
export { labelDefinitionLocations, labelReferenceLocations } from '@kojo/plugin-erb-parser';

/**
 * `$` 标签的**宿主侧剩余部分**（W-2，2026-10-19；LAU-4 第二步后只剩作用域读数）。
 *
 * ## 2026-10-30 之后这个模块还剩什么
 *
 * 标签的**落点投影**（`labelDefinitionLocations` / `labelReferenceLocations`）已搬进
 * `@kojo/plugin-erb-parser`：转到定义的供方是插件，查找引用那条腿也从它取。
 * 本模块只剩**作用域读数本身**（`resolveErbLabelScopeAt`）——它是 F2 改名与
 * `Shift+F12` 的共同入口，而这两条腿今天仍住宿主：
 * - F2 要的不只是落点，还要"这一处是不是标签、作用域里有哪几处"（写回计划用）；
 * - 引用腿要把它与 `#DIM` / 槽结果在宿主里合。
 *
 * ## 与 `#DIM` 那条腿同口径的坐标纪律（一字未改）
 *
 * - 数据源是**缓冲区文本**（脏缓冲也正确），项目索引零参与——标签是函数局部事实；
 * - `.kojo` 是派生文本 ⇒ 只答 ERB 方言后缀，判据单源 `isErbDefinitionPath`；
 * - **升糖预览面问原文、答存档坐标**（2026-10-20 中文谓词批）：投影面上那一行是中文谓词，
 *   而 `labelScopeAt` 只认 `$` 前缀与 `JUMP/GOTO` 系的行首原生记号 ⇒ 拿投影文本发问恒 `null`
 *   （F12 在 `跳到 NEXT` 上按了没反应）。派生面因此拿**原文缓冲 + 换算过的存档位点**发问，
 *   读数直接落在存档侧；归属与位点换算与 `#DIM` 腿**同一枚**（`derivedLegSurfaceOf` /
 *   `surfaceRequestPointOf`），几条本地腿不许各持一套映射。
 *   原文面（`isDerivedModelUri()` 为假）逐字直通，一个字段不碰。
 * - fail-open：路径缺席 / 文本为空 / 行越界 / 位点落不到入口 ⇒ `null`，不抛。
 *
 * 判别与作用域**不在本模块**：哪些字符算标签名、跳转槽怎么认、`[SKIPSTART]`
 * 怎么屏蔽、跨函数如何隔离，全部单源于解析器的 `labelScopeAt`（引用索引与导航
 * 各写一套就是"面板说有一处、F12 跳空"的漂移源）。
 */

/** 廉价前置：只有 `$` 定义行与跳转系语句才可能承载标签入口（避免每次 F12 全文 parse） */
const LABEL_ENTRY_RE = /^\s*(?:\$|(?:JUMP|GOTO|TRYJUMP|TRYGOTO)\b)/i;

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
 * 原文 model 取不到 / 空文本（`derivedLegSurfaceOf` 回 `null`）⇒ 本腿**不给结果**，
 * 绝不退回投影文本凑一个形状。
 *
 * 出口**不折行号**（`#DIM` 腿那条 `toArchiveCoords` 用在这里是错的：那份作用域的行列本来就生在
 * 存档侧，再折一遍就是折两遍），只把身份钉回存档路径。于是这里交出的**是真列、真区间**
 * （量的是源行自己的宽度）。
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
      if (path.length === 0 || !isErbDefinitionPath(path)) return null;
      const lineText = model.getLineContent(position.lineNumber);
      if (!LABEL_ENTRY_RE.test(lineText)) return null;
      const text = model.getValue();
      if (text.length === 0) return null;
      return labelScopeAt(text, path, position.lineNumber, position.column);
    }
    // 方言闸走**存档路径**的后缀（投影 URI 只是编码过的字符串，拿它的尾巴当判据是巧合不是判据）
    if (surface.path.length === 0 || !isErbDefinitionPath(surface.path)) return null;
    if (surface.sourceText.length === 0 || surface.sourceLineCount === 0) return null;
    const at = surfaceRequestPointOf(surface, position);
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