import type * as Monaco from './entry';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { parseDimDeclaration } from '@kojo/plugin-erb-parser';
import { livePanes, sourceModelOf, sugarOwningPaneOf, sugarSourceOf, type PaneCtx } from '../ui/editor-pane-registry';
import { isDimNameChar, normalizePathKey, spanAround } from './kojo-hover';

/**
 * `#DIM` 系列声明的**导航面**（转到定义 F12 / 查找引用 Shift+F12；2026-10-19）。
 *
 * 与悬停那条腿（`kojo-hover.ts` 的 `resolveErbDimHover`）同一口径，但数据源不同：
 * - 悬停读 `ErbIndex.files[].dims`（项目索引，只在文件**已落盘且干净**时可信）；
 * - 导航读**当前缓冲区文本**（`model.getValue()`）——声明与引用都是本文件事实，
 *   脏缓冲区也要给出正确答案，且不依赖项目开闭（与文档大纲 / 标签导航同款）。
 *
 * 边界（本批有意为之）：
 * - **只答本文件**。跨文件 `#DIM` 需要别处文件的原文才能算出声明列，而本层拿不到
 *   索引通道（`installDefinitionProvider` / `installReferenceProvider` 的 handlers 不带
 *   `ErbIndex`）⇒ 一律返回空数组，**不猜、不新建索引字段**。
 * - `.kojo` 是派生文本，行号不属于原文 ⇒ 只答 ERB 方言后缀（`.erb` / `.erh` / `.erd`）。
 * - **升糖预览（`inmemory://sugar/…`）按存档坐标作答**（2026-10-20 源坐标批）：本层与
 *   `$` 标签层是"缓冲区本地腿"，交出去的每一枚落点必须落在**存档那一行、存档那份文件**上
 *   ——换算判据全在 {@link derivedLegSurfaceOf}，两条腿共用同一份（见下方"派生面 → 存档坐标"段）。
 * - **两条本地腿都问原文缓冲**（2026-10-20 中文谓词批 + DIM-1 收口；判据边界，照抄前先读这一段）：
 *   ① 本层 `#DIM` 两腿问**原文**：行首的 `#DIM` 记号在投影上被中文谓词换掉了（`#DIM X` →
 *      `声明数组 X`，`native-display/control.ts` 的 `PREPROCESSORS`）⇒ 拿投影文本扫声明行
 *      **恒 0 命中**；而投影列与原列不同源，投影列不能直接套到原文那一行。派生面因此只拿
 *      "这个位置对应哪一条源行"（`sugarLineMapRef`）+ 行尾对齐换算出一个**存档位点**，发问与
 *      取词全部落在原文缓冲（`sourceText`）上；出口就是源坐标（真行、真列、真区间），
 *      **不再折回行首**——与下面 `$` 标签腿同一判据（{@link resolveErbDimDefinitionAt} /
 *      {@link resolveErbDimReferencesAt}）。
 *   ② `$` 标签腿（`erb-label-navigation.ts`）同一条判据：`labelScopeAt` 认的是 `$` 前缀与
 *      `JUMP/GOTO` 系的**行首原生记号**（`erb-parser/symbols.ts`），投影面上那个位置是中文谓词
 *      （`GOTO NEXT` → `跳到 NEXT`）⇒ 拿投影文本发问**恒 `null`**（拿译稿对原稿的页码）。
 *      派生面拿"原文缓冲 + 换算过的存档位点"发问，位点算术与 `#DIM` 腿同形。
 * - 名字字符集与悬停**同一枚** `isDimNameChar`（中文 / 全角字母都合法，绝不用 `\w`）；
 *   路径比较与合并去重**同一枚** `normalizePathKey`（Windows 分隔符 / 大小写不敏感）。
 * - fail-open：路径缺席 / 文本为空 / 行越界 / 不是声明名 / 名字不存在 ⇒ `[]`，不抛。
 */

/** ERB 方言后缀（与 `registerForLanguageServices` 的 ERB 面同族；`.kojo` 不参与） */
const ERB_PATH_RE = /\.(?:erb|erh|erd)$/i;

/** 行首 `#DIM*` 判据（名字与修饰词的切分仍以解析器的 `parseDimDeclaration` 为准） */
const DIM_HEAD_RE = /^#(?:DIMSTR|DIMCHAR|DIMS|DIM)\b/i;

/** 与 `erb-parser/scanner.ts` 的 `DIM_MODIFIERS` 同一组（只用来跳过修饰词定位名字列） */
const DIM_MODIFIERS = new Set(['CONST', 'SAVEDATA', 'GLOBAL', 'REF', 'NOINIT', 'CHARA']);

/** 一条 `#DIM*` 声明的行内事实（`nameStart` = 0 基列偏移） */
export interface DimDeclaration {
  readonly directive: string;
  readonly name: string;
  readonly nameStart: number;
}

/**
 * 一行的"代码视野"：字符串内容与引号外的 `;` 注释尾巴**等长刷白**（列坐标不变）。
 *
 * 与 `erb-parser/references.ts` 的 `codeViewOf` 同一规则（那边未导出，宿主侧只需这一条
 * 用于"光标是不是落在注释 / 字符串里"与"引用记号在哪里"；规则本身仍是那一份口径：
 * 未闭合引号按到行尾都是字符串处理）。
 */
function codeViewOf(line: string): string {
  if (line.indexOf('"') === -1 && line.indexOf(';') === -1) return line;
  let out = '';
  let seg = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (inStr) {
      if (c === 34 /* " */) {
        out += ' '.repeat(i - seg + 1);
        seg = i + 1;
        inStr = false;
      }
      continue;
    }
    if (c === 34 /* " */) {
      out += line.slice(seg, i) + ' ';
      seg = i + 1;
      inStr = true;
    } else if (c === 59 /* ; */) {
      return out + line.slice(seg, i) + ' '.repeat(line.length - i);
    }
  }
  return inStr ? out + ' '.repeat(line.length - seg) : out + line.slice(seg);
}

/** 归一化换行后切行（1 基行号 = 下标 + 1；与解析器同规则） */
function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 解析一行 `#DIM*` 声明：名字与指令取解析器 `parseDimDeclaration`（**不另写一套**），
 * 本函数只补"名字从第几列开始"——悬停 / 定义都需要列，而索引里的 `ErbDim` 只有行号。
 *
 * 修饰形（`#DIM CONST 名字` / `#DIM SAVEDATA` / `#DIM GLOBAL`）逐个剥掉；
 * `#DIM 名字[10]` 的数组后缀不计入名字（光标记号本来也不会包含 `[`）。
 */
export function dimDeclarationOf(line: string): DimDeclaration | null {
  const trimmed = line.trim();
  const parsed = parseDimDeclaration(trimmed);
  if (!parsed) return null;
  const head = DIM_HEAD_RE.exec(trimmed);
  if (!head) return null;
  const indent = line.length - line.trimStart().length;
  let i = head[0].length;
  let nameStart = -1;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    const start = i;
    while (i < trimmed.length && !/[\s,=[\]]/.test(trimmed[i]!)) i++;
    if (start === i) break;
    const token = trimmed.slice(start, i);
    if (!DIM_MODIFIERS.has(token.toUpperCase())) {
      nameStart = start;
      break;
    }
  }
  if (nameStart < 0) return null;
  const name = parsed.name.replace(/\[[^\]]*\]$/, '');
  if (name.length === 0 || !trimmed.startsWith(name, nameStart)) return null;
  return { directive: parsed.directive, name, nameStart: indent + nameStart };
}

/** 本文件里全部 `#DIM*` 声明（跳过 `[SKIPSTART]…[SKIPEND]` 区间，与解析器同口径） */
function dimDeclarationsOf(text: string): { line: number; dim: DimDeclaration }[] {
  const out: { line: number; dim: DimDeclaration }[] = [];
  let inSkipBlock = false;
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    const dim = dimDeclarationOf(lines[i]!);
    if (dim) out.push({ line: i + 1, dim });
  }
  return out;
}

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
 * 屏幕上这份 model 是不是某实例的糖投影（三条本地腿共用的唯一判据）。
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
 * （两条本地腿都改问原文，没有原文就没有答案，同样不许蒙）。
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
 * 与 `$` 标签腿（`erb-label-navigation.ts` 的 `archivePointOf`）同一形状、同一判据：
 * - 行：{@link DerivedLegSurface.lineOf}（认的就是与投影 model 同批换上的那张 `sugarLineMapRef`，
 *   本层不许自建第二份映射），再夹一道 `sourceLineCount` 界；
 * - 列：**源行与投影行按行尾对齐**（`column` 相对行尾的距离在两面上同一把尺子），两头各夹一次。
 *   为什么列不能照抄：投影把**行首那串原生记号**换成中文谓词（`#DIM X` → `声明数组 X`），
 *   谓词几字长随词形变；而载荷（声明名 / 变量名）**逐字带走并停在行尾**
 *   （`kojo-sugar/native-display/control.ts` 的 `renderPreprocessor` / `showExpr`）⇒
 *   只剩"离行尾多远"在两面上等价。投影面只负责把**位置**对到源行上，取词一律回到原文。
 * 落不到名字上就是落不到 ⇒ **不再试别的列**（多试一格 = 光标停在谓词上也答，原文面没这规矩），
 * 宁可不给也不给假。
 */
function archivePointOf(
  surface: DerivedLegSurface,
  position: Monaco.Position,
): { readonly line: number; readonly column: number } | null {
  const line = surface.lineOf(position.lineNumber);
  if (line === null || line < 1 || line > surface.sourceLineCount) return null;
  const shown = surface.shownLineOf(position.lineNumber);
  if (shown === undefined) return null;
  const row = sourceRowOf(surface.sourceText, line);
  if (row === undefined) return null;
  const column = Math.min(Math.max(row.length - shown.length + position.column, 1), row.length + 1);
  return { line, column };
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
 * 光标处的变量名 → **本文件**里同名声明的落点（转到定义的 `#DIM` 腿，纯函数）。
 *
 * 同文件优先 = 这里只答同文件；找不到 ⇒ `[]`（跨文件不在本层能力内，见文件头）。
 * 注释 / 字符串内不算变量位置：记号在"代码视野"上切，刷白区自然切不出名字。
 */
export function resolveErbDimDefinition(
  text: string,
  line: number,
  column: number,
  filePath: string | null,
): EditorSymbolLocation[] {
  if (!filePath || !ERB_PATH_RE.test(filePath)) return [];
  const lines = linesOf(text);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return [];
  const lineText = lines[Math.trunc(line) - 1];
  if (lineText === undefined) return [];
  const col0 = Math.trunc(column) - 1;
  if (col0 < 0) return [];
  const span = spanAround(codeViewOf(lineText), col0, isDimNameChar);
  if (!span) return [];
  const token = lineText.slice(span.start, span.end);
  if (token.length === 0) return [];
  const want = token.toUpperCase();
  const out: EditorSymbolLocation[] = [];
  for (const { line: atLine, dim } of dimDeclarationsOf(text)) {
    if (dim.name.toUpperCase() !== want) continue;
    out.push({
      filePath,
      line: atLine,
      column: dim.nameStart + 1,
      span: { columnStart: dim.nameStart + 1, columnEnd: dim.nameStart + 1 + dim.name.length },
    });
  }
  return out;
}

/** 引用扫描的可见代码行（与 `erb-parser/references.ts` 的 `visibleCodeLines` 同屏蔽面） */
function* codeLinesOf(text: string): Generator<{ line: number; view: string }> {
  const lines = linesOf(text);
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (
      trimmed.length === 0 ||
      trimmed.startsWith(';') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('$') ||
      trimmed.startsWith('@')
    ) {
      continue;
    }
    yield { line: i + 1, view: codeViewOf(raw) };
  }
}

/**
 * `#DIM` 声明名上的查找引用（Shift+F12，纯函数）：**只在本文件**内列出现点。
 *
 * 命中前提（严格）：光标必须落在**声明行**的名字上——这是本批唯一可证明的入口
 * （任意变量位置上按 Shift+F12 会把同名散文 / 成员名一起卷进来，误报比少答更坏）。
 * 声明行自身算一条 `definition`，其余同记号出现算 `mention`；注释 / 字符串 / `@` / `$` /
 * 其它 `#` 指令行不参与（与解析器的可见行口径一致）。
 */
export function resolveErbDimReferences(
  text: string,
  line: number,
  column: number,
  filePath: string | null,
): EditorSymbolLocation[] {
  if (!filePath || !ERB_PATH_RE.test(filePath)) return [];
  if (!Number.isFinite(line) || !Number.isFinite(column)) return [];
  const lines = linesOf(text);
  const lineText = lines[Math.trunc(line) - 1];
  if (lineText === undefined) return [];
  const decl = dimDeclarationOf(lineText);
  if (!decl) return [];
  const col0 = Math.trunc(column) - 1;
  // Monaco 的光标是"字符之间"：名字末尾那一列（nameStart + len）也算落在名字上
  if (col0 < decl.nameStart || col0 > decl.nameStart + decl.name.length) return [];
  const want = decl.name.toUpperCase();
  const out: EditorSymbolLocation[] = [];
  const seen = new Set<string>();
  const push = (atLine: number, start: number, length: number, kind: 'definition' | 'mention'): void => {
    const key = `${atLine}\u0000${start}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      filePath,
      line: atLine,
      column: start + 1,
      span: { columnStart: start + 1, columnEnd: start + 1 + length },
      kind,
    });
  };
  // 声明行（同名重声明也各算一条定义）
  for (const { line: atLine, dim } of dimDeclarationsOf(text)) {
    if (dim.name.toUpperCase() === want) push(atLine, dim.nameStart, dim.name.length, 'definition');
  }
  // 可见代码行上的同记号出现
  for (const { line: atLine, view } of codeLinesOf(text)) {
    let i = 0;
    while (i < view.length) {
      if (!isDimNameChar(view[i]!)) {
        i++;
        continue;
      }
      const start = i;
      while (i < view.length && isDimNameChar(view[i]!)) i++;
      if (view.slice(start, i).toUpperCase() !== want) continue;
      // 成员访问（`FLAG:名字`）里的名字不是变量引用（半/全角冒号都算）
      const prev = start > 0 ? view[start - 1] : '';
      if (prev === ':' || prev === '：') continue;
      push(atLine, start, i - start, 'mention');
    }
  }
  out.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
  return out;
}

/**
 * 合并两批位置（`#DIM` 腿在前，既有管线的结果在后），按
 * `路径(归一) + 行 + 区间起点` 去重；同处先到者没区间、后到者有时补上区间。
 *
 * 路径归一用 `normalizePathKey`：两条腿的 `filePath` 可能一条来自 model（反斜杠 /
 * 小写盘符）、一条来自插件索引（正斜杠 / 大写），裸字符串比会静默留下两份。
 */
export function mergeSymbolLocations(
  primary: readonly EditorSymbolLocation[],
  secondary: readonly EditorSymbolLocation[],
): EditorSymbolLocation[] {
  const out: EditorSymbolLocation[] = [];
  const at = new Map<string, number>();
  for (const loc of [...primary, ...secondary]) {
    const start = loc.span?.columnStart ?? loc.column ?? 0;
    const key = `${normalizePathKey(loc.filePath)}\u0000${loc.line}\u0000${start}`;
    const seenAt = at.get(key);
    if (seenAt === undefined) {
      at.set(key, out.length);
      out.push(loc);
      continue;
    }
    const kept = out[seenAt]!;
    if (!kept.span && loc.span) out[seenAt] = { ...kept, span: loc.span };
    if (kept.column === undefined && loc.column !== undefined) out[seenAt] = { ...out[seenAt]!, column: loc.column };
  }
  return out;
}

/**
 * 一次导航请求里**三条腿的优先序**（F12-TOKEN 2026-10-19 收口；转到定义与查找引用
 * 共用这一枚函数，不再各自排两遍）。
 *
 * 序 = `$` 标签腿 → `#DIM` 声明腿 → 槽腿（项目函数索引，由各 `ui.editor.languageService`
 * 贡献方给）。理由：前两腿是**本缓冲区可证明**的局部事实（脏缓冲也要给正确答案，而且
 * 标签名 / 声明名的字符集比函数名那把尺更宽），槽腿是项目级名录——同一点位两条腿都答得出
 * 时（`充填率` 既是 `#DIM` 声明名又是函数名，正是本批放宽取词尺之后**新出现**的形态），
 * 先给证得了的那个。
 *
 * 为什么收成**一枚函数**而不是两条 `if`：此前 definition 与 find-references 各写了一遍
 * "labels 盖过 dims 盖过槽"的嵌套，两处 `if` 就是两份优先序；漏改一处会让 F12 与
 * `Shift+F12` 对同一个点位给出不同的第一落点（事件通道兜底跳的就是数组第一个）。
 */
export function mergeNavigationLegs(
  labels: readonly EditorSymbolLocation[],
  dims: readonly EditorSymbolLocation[],
  slot: readonly EditorSymbolLocation[],
): EditorSymbolLocation[] {
  return mergeSymbolLocations(labels, mergeSymbolLocations(dims, slot));
}

/**
 * Monaco model + 位置 → `#DIM` 定义落点（取文本 / 路径全程 fail-open）。
 *
 * **原文面**（`derivedLegSurfaceOf` 回 `null` 且不是派生 URI）：屏幕上那份 model 就是原文，
 * 判据、文本、行列一个字节都不碰。
 *
 * **投影面**：发问吃**原文缓冲 + 换算过的存档位点**（DIM-1 收口）。为什么必须换文本：
 * 投影把 `#DIM X` 显示成 `声明数组 X`（`native-display/control.ts` 的 `PREPROCESSORS`），
 * 在投影文本里扫声明行**恒 0 命中**；而投影列与原列不同源，不能把投影列套到原文那一行。
 * 出口**不折行号、不收列**：命中与取词都生在存档侧，交出的就是源坐标（真行真列真区间）。
 * 原文 model 取不到 / 位点越界 / 那一格没有源行 ⇒ 本腿**不给结果**，
 * 绝不退回投影文本凑一个形状。
 */
export function resolveErbDimDefinitionAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): EditorSymbolLocation[] {
  try {
    const surface = derivedLegSurfaceOf(model);
    if (surface !== null) {
      // 方言闸走**存档路径**的后缀（投影 URI 只是编码过的字符串，拿它的尾巴当判据是巧合不是判据）
      if (surface.path.length === 0 || !ERB_PATH_RE.test(surface.path)) return [];
      if (surface.sourceText.length === 0 || surface.sourceLineCount === 0) return [];
      const at = archivePointOf(surface, position);
      if (at === null) return [];
      return resolveErbDimDefinition(surface.sourceText, at.line, at.column, surface.path);
    }
    // 登记簿认不出归属实例的派生面：没有原文可依，交回的每一枚都是猜的 ⇒ 不应答
    if (isDerivedModelUri(model)) return [];
    const path = modelPathOf(model);
    if (path === null) return [];
    const text = model.getValue();
    if (text.length === 0) return [];
    return resolveErbDimDefinition(text, position.lineNumber, position.column, path);
  } catch {
    return [];
  }
}

/** Monaco model + 位置 → `#DIM` 引用点（与定义腿同一判据：投影面问原文、交源坐标；fail-open） */
export function resolveErbDimReferencesAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): EditorSymbolLocation[] {
  try {
    const surface = derivedLegSurfaceOf(model);
    if (surface !== null) {
      if (surface.path.length === 0 || !ERB_PATH_RE.test(surface.path)) return [];
      if (surface.sourceText.length === 0 || surface.sourceLineCount === 0) return [];
      const at = archivePointOf(surface, position);
      if (at === null) return [];
      return resolveErbDimReferences(surface.sourceText, at.line, at.column, surface.path);
    }
    if (isDerivedModelUri(model)) return [];
    const path = modelPathOf(model);
    if (path === null) return [];
    const text = model.getValue();
    if (text.length === 0) return [];
    return resolveErbDimReferences(text, position.lineNumber, position.column, path);
  } catch {
    return [];
  }
}
