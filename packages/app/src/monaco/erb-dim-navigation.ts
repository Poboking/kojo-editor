import { splitEolLines } from '@kojo/plugin-api/eol';
import type * as Monaco from './entry';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { resolveErbDimDefinition } from '@kojo/plugin-erb-parser';
import { livePanes, sourceModelOf, sugarOwningPaneOf, sugarSourceOf, type PaneCtx } from '../ui/editor-pane-registry';

// 判据已随供方搬进解析器插件（LAU-4；不留在语言面库是因为整包会进首屏）。
// 用例（`erb-dim-navigation.test.ts`）仍从本模块取这几枚，故原样转出。
export {
  dimDeclarationOf,
  mergeNavigationLegs,
  mergeSymbolLocations,
  resolveErbDimDefinition,
} from '@kojo/plugin-erb-parser';

/**
 * `#DIM` 系列声明的**宿主侧剩余部分**。
 *
 * ## 2026-10-31（LAU-4 引用腿）之后这个模块还剩什么
 *
 * `#DIM` 的**名字判据**（`dimDeclarationOf` / `resolveErbDimDefinition` / 声明名取词 /
 * 合并优先序）与**查找引用那条腿**（`erbDimReferencesAt` / 三腿合一 `erbReferencesAt`）
 * 全部住在解析器插件（`@kojo/plugin-erb-parser` 的 `symbols.ts`）：转到定义与查找引用的
 * 供方都是它，宿主 `monaco/kojo-definition.ts` / `monaco/find-references.ts` 不再有本地腿。
 * 本模块只剩**宿主才有资格做**的两件事：
 *
 * 1. **投影面坐标换算**（`derivedLegSurfaceOf` / `surfaceRequestPointOf`）：升糖预览那份
 *    `inmemory://sugar/…` model 的行列不属于存档，换算要问登记簿（`editor-pane-registry`）
 *    ——那是宿主事实，包不认识、插件也拿不到；
 * 2. **定义腿的转换壳**（`resolveErbDimDefinitionAt`）：投影面问原文、答存档坐标。
 *
 * 查找引用那条腿的位点也走同一枚 `surfaceRequestPointOf`（`ui/editor-global-providers.ts`
 * 的 `referenceRequestPointOf`），族内几条本地腿不许各持一套映射。
 *
 * ## 两条本地腿共同的坐标纪律
 *
 * - `.kojo` 是派生文本，行号不属于原文 ⇒ 只答 ERB 方言后缀，判据单源 `isErbDefinitionPath`。
 * - **升糖预览按存档坐标作答**：投影把行首原生记号换成中文谓词（`#DIM X` → `声明数组 X`、
 *   `GOTO NEXT` → `跳到 NEXT`），拿投影文本发问恒 0 命中 ⇒ 发问一律吃**原文缓冲 + 换算过的
 *   存档位点**，位点算术单源 {@link surfaceRequestPointOf}（列按"离行尾多远"对齐）。
 * - 登记簿认不出归属实例的派生面 ⇒ 一律不应答（交出去的每一枚都是幻影）；fail-open 不抛。
 */
/**
 * 这份 model 的 URI 是不是"没有文件可依"的派生面。
 *
 * 真文件 model 一律 `Uri.file(path)`（`scheme = 'file'`），投影是 `inmemory://sugar/…`：
 * 把后者的 URI 路径当文件路径交回去，就是一条落在内存模型上的**幻影落点**——那条路径上
 * 没有文件，`openModelFor` 问不到 model，`planDefinitionJump` 的事件通道兜底又只取第一枚，
 * 结果是一次"按了没反应"顶替掉一次正确的跳转。登记簿认不出归属实例时（实例已退册 /
 * 迟到的请求）也只能闭嘴，不能猜。桩 model 常不带 `scheme` ⇒ 不设限。
 */
export function isDerivedModelUri(model: Monaco.editor.ITextModel): boolean {
  const scheme = (model as { uri?: { scheme?: unknown } }).uri?.scheme;
  return typeof scheme === 'string' && scheme.length > 0 && scheme !== 'file';
}

/** 一条缓冲区本地腿在屏上这一面的坐标归属（`null` = 原文面 ⇒ 判据逐字直通、零换算） */
export interface DerivedLegSurface {
  /** 存档路径 = 投影归属实例那一份文件；空串 = 实例还没挂上文件 ⇒ 这一面无处可答 */
  readonly path: string;
  /**
   * **原文**缓冲区文本（发问用的那一份）。两条本地腿都只认原文形状：`#DIM` 声明行被投影换成
   * 中文谓词、`labelScopeAt` 认 `$` 前缀与 `JUMP/GOTO` 行首记号——吃投影文本就是 0 命中 / 恒 `null`。
   * 取原文 model 走登记簿的 `sourceModelOf`（同一条反查只此一份），空文本不当真 ⇒ 整条腿不给结果。
   */
  readonly sourceText: string;
  /** 原文行数（`\r\n` 已归一）；换算出的源行越过这一界 ⇒ 不当真、不发问 */
  readonly sourceLineCount: number;
  /** 投影行（1 基）→ 屏幕上那一行的文本（列换算按"到行尾的距离"对齐）；越界 = `undefined` */
  shownLineOf(previewLine: number): string | undefined;
  /** 投影行（1 基）→ 存档行（1 基）；映射缺席 / 那一格没有源行 ⇒ `null`（= 这一枚不交） */
  lineOf(previewLine: number): number | null;
}

/**
 * 屏幕上这份 model 是不是某实例的糖投影（缓冲区本地腿共用的唯一判据）。
 *
 * 先问 `sugarOwningPaneOf`（登记簿的官方判据 = "这份投影正在某实例屏上"），再退一步扫
 * `sugarModelRef`：provider 也会收到装配过但已切走的那一份（Peek 列表 / 迟到的请求），
 * 那一面同样没有文件可依，不该交预览坐标。
 * 行换算只认 `sugarSourceOf` 读的那张 `sugarLineMapRef`——它与投影 model 同批换上，
 * 本层不许自建第二份映射（两张表一漂移，跳的就是隔壁一行）。
 *
 * 原文那一份走登记簿的 `sourceModelOf`（"哪一份 model 是这份投影的原文"这条反查只此一份，
 * 读类腿与本地腿共用）。**为什么不住 `editor-global-providers.ts`**：那模块顶层带 Monaco 运行时，
 * 而本层这套件跑在 node 池里——静态引它 = 当场 `ReferenceError: window is not defined`；
 * 登记簿只 `import type` monaco，两侧都能干净地引。
 * 取不到 / 空文本 ⇒ 回 `null`：这一面没有原文可问，交出去的每一枚都只能是猜的
 * （本地腿都改问原文，没有原文就没有答案，同样不许蒙）。
 */
export function derivedLegSurfaceOf(model: Monaco.editor.ITextModel): DerivedLegSurface | null {
  const ctx: PaneCtx | null =
    sugarOwningPaneOf(model) ?? [...livePanes.values()].find((pane) => pane.sugarModelRef.current === model) ?? null;
  if (ctx === null) return null;
  const source = sourceModelOf(ctx);
  if (!source) return null;
  let sourceText = '';
  let shownText = '';
  try {
    sourceText = source.getValue() ?? '';
    shownText = model.getValue() ?? '';
  } catch {
    return null;
  }
  // 空原文 = 没有可问的缓冲区（`''.split('\n')` 还会切出一行空行，那是一枚假行号，不是一行）
  if (sourceText.length === 0) return null;
  const shownLines = linesOf(shownText);
  return {
    path: ctx.filePathRef.current,
    sourceText,
    sourceLineCount: linesOf(sourceText).length,
    shownLineOf: (previewLine: number) => shownLines[previewLine - 1],
    lineOf: (previewLine: number) => sugarSourceOf(ctx, previewLine)?.line ?? null,
  };
}

/** 归一化换行后切行（1 基行号 = 下标 + 1；与解析器同规则） */
function linesOf(text: string): string[] {
  return splitEolLines(text);
}

/**
 * 源行文本（`\r\n` 归一后按 `\n` 切；与 {@link linesOf}、解析器 `labelScopeAt` 内部的切法
 * 逐字同一条）。派生面只交 `sourceText` + 行数，本层不自建第二张行表——切同一份文本两次
 * 得到的必然是同一批行。
 */
function sourceRowOf(sourceText: string, line: number): string | undefined {
  return linesOf(sourceText)[line - 1];
}

/**
 * 投影面上的光标 → **发问用的存档位点**（`null` = 位点越界 / 那一格根本没有源行）。
 *
 * 这是两条缓冲区本地腿**唯一**的位点算术（转到定义的供方搬进插件之后，宿主
 * `ui/editor-global-providers.ts` 的读类腿也读它——定义那条腿现在把位点交给槽）：
 * - 行：{@link DerivedLegSurface.lineOf}（认的就是与投影 model 同批换上的那张 `sugarLineMapRef`，
 *   本层不许自建第二份映射），再夹一道 `sourceLineCount` 界；
 * - 列：**源行与投影行按行尾对齐**（`column` 相对行尾的距离在两面上同一把尺子），两头各夹一次。
 *   为什么列不能照抄：投影把**行首那串原生记号**换成中文谓词（`#DIM X` → `声明数组 X`、
 *   `GOTO NEXT` → `跳到 NEXT`），谓词几字长随词形变；而载荷（声明名 / 标签名）**逐字带走并停在
 *   行尾**（`kojo-sugar/native-display/control.ts` 的 `renderPreprocessor` / `showTarget`）⇒
 *   只剩"离行尾多远"在两面上等价。投影面只负责把**位置**对到源行上，取词一律回到原文。
 * 落不到名字上就是落不到 ⇒ **不再试别的列**（多试一格 = 光标停在谓词上也答，原文面没这规矩），
 * 宁可不给也不给假。
 */
export function surfaceRequestPointOf(
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
 * 旧口径（2026-10-20 源坐标批）：本地腿在**投影文本**上取词后，把结果按行折回存档坐标
 * （列一律收到行首、不给区间）。
 *
 * DIM-1 起 `#DIM` 两腿也改问原文缓冲（见文件头），本函数不再被两条腿调用；保留导出是因为
 * "投影行 → 存档行"这条换算本身仍有消费方（用例 / 后续腿），且它的三条纪律仍是投影折回的
 * 同一口径，不许另写一份：
 * ① 换算不出的那一枚**直接丢**——不猜行号，也不留一枚 `inmemory` 上的幻影；
 * ② **列不折算**：投影行与存档行连文本都不是同一串，跨面一律落到行首（`column: 1`、不给 span）；
 * ③ 行号**留存档侧**：源行 → 投影行的那一跳住在 `EditorPane` 的 `applyReveal`（读同一张表），
 *    在这里折一遍就是折两遍。
 */
export function toArchiveCoords(
  locations: readonly EditorSymbolLocation[],
  surface: DerivedLegSurface | null,
): EditorSymbolLocation[] {
  if (surface === null) return [...locations];
  const out: EditorSymbolLocation[] = [];
  for (const location of locations) {
    const line = surface.lineOf(location.line);
    if (line === null) continue;
    out.push({
      filePath: surface.path,
      line,
      column: 1,
      ...(location.kind === undefined ? {} : { kind: location.kind }),
    });
  }
  return out;
}

/** 从 Monaco model 取当前文件路径（`fsPath` 优先；桩 model 可能只有 `path` / 都没有） */
function modelPathOf(model: Monaco.editor.ITextModel): string | null {
  if (isDerivedModelUri(model)) return null;
  const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return null;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  return null;
}

/**
 * 一次**缓冲区本地腿**发问的完整位点：问哪份文本、哪一行哪一列、答案是哪个路径的坐标。
 *
 * 这是 `#DIM` 定义腿 / `$` 标签腿 / 查找引用腿**唯一**的投影面换算（族内几条腿不许各持
 * 一套映射）：原文面直通（一个字节都不碰），投影面问**原文缓冲 + 换算过的存档位点**
 * （判据见 `derivedLegSurfaceOf` / `surfaceRequestPointOf`）。
 *
 * 生产消费方两处：`resolveErbDimDefinitionAt`（定义腿）与 `ui/editor-global-providers.ts`
 * 的 `referenceRequestPointOf`（引用腿发问）；判据本身全在 `@kojo/plugin-erb-parser`。
 * 登记簿认不出归属实例的派生面 / 原文取不到 / 空文本 ⇒ `null`（这一面没有可问的文本）。
 */
export interface LocalLegPoint {
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

export function localLegPointOf(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): LocalLegPoint | null {
  try {
    const surface = derivedLegSurfaceOf(model);
    if (surface !== null) {
      if (surface.path.length === 0 || surface.sourceText.length === 0 || surface.sourceLineCount === 0) {
        return null;
      }
      const at = surfaceRequestPointOf(surface, position);
      return at === null
        ? null
        : { path: surface.path, text: surface.sourceText, line: at.line, column: at.column };
    }
    if (isDerivedModelUri(model)) return null;
    const path = modelPathOf(model);
    if (path === null) return null;
    const text = model.getValue();
    return text.length === 0
      ? null
      : { path, text, line: position.lineNumber, column: position.column };
  } catch {
    return null;
  }
}

/**
 * Monaco model + 位置 → `#DIM` 定义落点（取文本 / 路径全程 fail-open）。
 *
 * 判据本身在解析器插件（`resolveErbDimDefinition`），本函数只做**投影面换算**：
 * 投影把 `#DIM X` 显示成 `声明数组 X`，在投影文本里扫声明行恒 0 命中 ⇒ 发问一律吃
 * 原文缓冲 + 换算过的存档位点；出口不折行号、不收列（命中与取词都生在存档侧）。
 * 方言闸（`isErbDefinitionPath`）也在判据里，这里不再抄一份。
 */
export function resolveErbDimDefinitionAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): EditorSymbolLocation[] {
  const at = localLegPointOf(model, position);
  return at === null ? [] : resolveErbDimDefinition(at.text, at.line, at.column, at.path);
}
