import type {
  EditorCodeLens,
  EditorCodeLensRequest,
  EditorCodeLensResult,
  EditorInlayHint,
  EditorInlayHintRequest,
  EditorInlayHintResult,
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  EditorWorkspaceSymbol,
  EditorWorkspaceSymbolRequest,
  EditorWorkspaceSymbolResult,
  SugarPosition,
  SugarTranspileOptions,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { resolveSugarTarget } from '@kojo/plugin-api';
import { sourceMapIndex, type SourceMapIndex } from './column-map';

/**
 * `.kojo` 的**语言服务能力面**（W6 PARITY-EXT，2026-10-17）：`workspaceSymbol` /
 * `codeLens` / `inlayHint` 三员在糖线上的应答。
 *
 * ## 为什么本包必须自己答，而不是让 erb-parser 松守门
 *
 * `erb-parser` 那几个应答方的守门（`isErbDialectPath`）**是对的**：它交出的行号是
 * 方言原文的行号，而 `.kojo` 缓冲区里那些行是**派生文本**——让 ERB 那条线去答 `.kojo`
 * 就等于把产物行号贴到源文件脸上（错标比不标危险，本仓一贯口径）。所以缺的不是
 * "守门太严"，是 `.kojo` 这一腿的应答方。
 *
 * ## 判据零第二份（本模块的全部技术内容）
 *
 * 三件事本包都**不自己判**，只做一次坐标换算：
 *
 * | 能力 | 判据住在哪 | 本包只做 |
 * |---|---|---|
 * | 「被谁调用」/ 大数降噪 / 无引用不说 | `erb-parser/usage-lens.ts` + 项目反向索引 | 产物行折回源行 |
 * | 实参落哪个形参槽 | `erb-parser/inlay-hints.ts` + `ErbIndex` 形参表 | 产物 (行,列) 折回源 (行,列) |
 * | 工作区里谁叫这个名字（匹配 / 排序 / 预算） | `erb-parser/workspace-symbols.ts` + `ErbIndex.byName` | 命中项若是我们某个 `.kojo` 的产物 ⇒ 换成源路径与源行 |
 *
 * 通道 = 同一枚 `ui.editor.languageService` 槽（{@link KojoLangSvcDeps.ask}，经内核
 * 槽位服务查询，**不是**插件间 import——解耦审计 C 项），把自己刚注册的那几枚摘掉
 * 免得自问自答（{@link KOJO_LANGSVC_IDS}）。抄一份"被谁调用"算法的代价本仓已经写死在
 * `usage-lens.ts` 头注里：两份口径迟早分叉，分叉的表现是"引用面板说有、行上注解没有"。
 *
 * ## 折不回就不说（三态纪律）
 *
 * - 折不回源行的注解/提示 ⇒ **整条丢弃**（不夹取、不猜列——与 `kojo-code-lens.ts`
 *   的"越界行丢弃"同一条理由）；
 * - 通道里**没有任何一方答**这个判别成员（erb-parser 未激活 / 项目索引未建）⇒
 *   `undefined` = 本包不答，**不等于**"这文件里没有可标注的东西"（铁律 4：
 *   "真没有"与"我还没有名录"是两件事）；
 * - 有名录、但本篇确实无话可说 / 这个查询一条 `.kojo` 命中都没有 ⇒ 空数组。
 *
 * 转译产 `error` 诊断时**产物本身不成立**（规范 §5.3 不生成半成品），此时本篇"无可
 * 证明的注解"是实话 ⇒ 空数组（文件确实归本包，不是"不归我管"）。
 */

/**
 * 本包注册的三枚语言服务应答 id（单一真源在这里，`index.ts` 装配与 {@link ask} 通道
 * 的摘除判据都读它——写两处就会有一处漏掉自己，然后自问自答递归）。
 */
export const KOJO_LANGSVC_IDS: ReadonlySet<string> = new Set<string>([
  'kojo-workspace-symbols',
  'kojo-code-lens',
  'kojo-inlay-hints',
]);

/** 装配层注入的通道（全部软取；缺席语义见各函数注） */
export interface KojoLangSvcDeps {
  /** 本包 `sugar.transpile`（当前 adapter 代际；含共享结果缓存） */
  transpile(source: string, options?: SugarTranspileOptions): SugarTranspileResult;
  /** 本包 `sugar.transpile`.`sourceColumnOf`（S6 列级；行级 `sourceOf` 的逐字超集） */
  sourceColumnOf(result: SugarTranspileResult, generatedLine: number, generatedColumn: number): SugarPosition | null;
  /**
   * 把整枚请求**原样**问给槽上的其余应答方（本包自己那几枚由装配层摘掉）。
   * 返回各家应答（已剔除 `undefined` 与抛错项）；**长度 0 = 没有名录**。
   */
  ask(request: EditorLanguageServiceRequest): readonly EditorLanguageServiceResult[];
}

/** `workspaceSymbol` 那条腿额外要的坐标源（装配层注入 `kojo-function-catalog`） */
export interface KojoWorkspaceSymbolDeps extends KojoLangSvcDeps {
  /** `.kojo` 名录是否已经建好（未建 = 本包**不答**，不谎称"没有 `.kojo` 命中"） */
  catalogReady(): boolean;
  /** 产物路径 + 函数名（原样，内部按契约归一）→ 源坐标；证不了 → `null`（**不猜**，那一条就不重定基） */
  locate(productPath: string, name: string): { sourcePath: string; line: number } | null;
}

/** 转译一次（失败 = 没有产物可问；与 `compileToBytes` 的守卫同口径：不拿半成品当产物） */
function productOf(deps: KojoLangSvcDeps, source: string, path: string): SugarTranspileResult | null {
  try {
    const result = deps.transpile(source, { filePath: path });
    if (result.diagnostics.some((d) => d.severity === 'error')) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * 产物行 → 源行（**与转到定义同一条折回规则**，`definition.ts` 的 `sourceLineNear`）。
 *
 * 精确命中优先；纯生成行（`@` 函数头就是编译器造的）向下取**最近一条有源行**，
 * 但一旦越过下一个 `@` 定义头就放弃——那条保守路只保证"落在本函数体内"，
 * 越界就是别个函数，宁可不给位置。
 *
 * PS-8：`lines` 切分与 `sourceMap` 排序**按结果对象记忆一次**（WeakMap），
 * 每条注解/提示只付二分定位 + 常数次前扫——Monaco 每次滚动都重请求整屏提示，
 * 改前在 3,000 行产物上每条 ~17 µs 全花在重复 split+sort 上。
 * 行级精确命中走 `sourceMapIndex().exact`（与 `find` 同语义：首条匹配）。
 */
interface FoldIndex {
  readonly lines: string[];
  readonly index: SourceMapIndex;
}

const foldIndexCache = new WeakMap<SugarTranspileResult, FoldIndex>();
const AT_HEAD_RE = /^@/;

function foldIndexOf(result: SugarTranspileResult): FoldIndex {
  let value = foldIndexCache.get(result);
  if (value === undefined) {
    value = { lines: result.erb.split('\n'), index: sourceMapIndex(result) };
    foldIndexCache.set(result, value);
  }
  return value;
}

export function foldGeneratedLine(result: SugarTranspileResult, generatedLine: number): number | null {
  const { lines, index } = foldIndexOf(result);
  const exact = index.exact.get(generatedLine);
  if (exact?.sourceLine != null) return exact.sourceLine;
  const { ordered } = index;
  // 第一个 generatedLine > 查询行 的下标（升序稳定，与原全量扫描的访问序一致）
  let lo = 0;
  let hi = ordered.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ordered[mid]!.generatedLine <= generatedLine) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < ordered.length; i++) {
    const entry = ordered[i]!;
    if (AT_HEAD_RE.test(lines[entry.generatedLine - 1] ?? '')) return null;
    if (entry.sourceLine !== null) return entry.sourceLine;
  }
  return null;
}

/* ------------------------------ codeLens（B8 的 `.kojo` 那一腿） ------------------------------ */

/**
 * `.kojo` 的行上内联注解：把产物交给 ERB 那条线判，再把行号折回源。
 *
 * 同一份反向索引、同一套"没人调用就不说 / 重名不计数 / 大数报 `1000+`"口径
 * （全在 `erb-parser/usage-lens.ts`，本包零抄写）。`target` **原样保留**：它指的是
 * 真实存在的方言文件里的使用处，作者点过去看的正是"谁在调用这个函数"，
 * 换成源坐标反而会把落点编出来。
 */
export function kojoCodeLens(request: EditorCodeLensRequest, deps: KojoLangSvcDeps): EditorCodeLensResult | undefined {
  const productPath = resolveSugarTarget(request.path);
  if (productPath === null) return undefined;
  const result = productOf(deps, request.text, request.path);
  if (result === null) return { kind: 'codeLens', lenses: [] };

  const answers = deps.ask({
    kind: 'codeLens',
    path: productPath,
    text: result.erb,
    project: request.project,
    lineCount: countLines(result.erb),
  });
  const given = answers.filter((a): a is EditorCodeLensResult => a.kind === 'codeLens');
  if (given.length === 0) return undefined; // 没有名录 = 本包不答（不谎称"这里没有引用"）

  const out: EditorCodeLens[] = [];
  const seen = new Set<string>();
  for (const answer of given) {
    for (const lens of answer.lenses) {
      const line = foldGeneratedLine(result, lens.line);
      if (line === null) continue; // 折不回 = 无法把这句话钉在源文件的具体行上 ⇒ 不说
      const key = `${line}\u0000${lens.label}`;
      if (seen.has(key)) continue; // 一个源块产出多个产物函数时同一行同一句话只说一遍
      seen.add(key);
      out.push({ line, label: lens.label, ...(lens.target ? { target: lens.target } : {}) });
    }
  }
  return { kind: 'codeLens', lenses: out.sort((a, b) => a.line - b.line) };
}

/* ------------------------------ inlayHint（LS-R6 的 `.kojo` 那一腿） ------------------------------ */

/**
 * `.kojo` 的实参位行内提示：产物交给 ERB 那条线判，行列一起折回源。
 *
 * 列**必须走 S6 列级映射**（`sourceColumnOf`）：一条提示钉在"某个实参的首字符之前"，
 * 只折行不折列等于把槽名贴到错误的实参脸上。列级映射给不出（降糖改写区、
 * `调用` 这类整行重写的产物行）⇒ **整条丢弃**（契约 `SugarColumnRun` 的"绝不记录
 * 猜出来的列"在这里落地）。
 */
export function kojoInlayHint(
  request: EditorInlayHintRequest,
  deps: KojoLangSvcDeps,
): EditorInlayHintResult | undefined {
  const productPath = resolveSugarTarget(request.path);
  if (productPath === null) return undefined;
  const result = productOf(deps, request.text, request.path);
  if (result === null) return { kind: 'inlayHint', hints: [] };

  const answers = deps.ask({
    kind: 'inlayHint',
    path: productPath,
    text: result.erb,
    project: request.project,
    lineCount: countLines(result.erb),
  });
  const given = answers.filter((a): a is EditorInlayHintResult => a.kind === 'inlayHint');
  if (given.length === 0) return undefined;

  const out: EditorInlayHint[] = [];
  const seen = new Set<string>();
  for (const answer of given) {
    for (const hint of answer.hints) {
      const line = foldGeneratedLine(result, hint.line);
      if (line === null) continue;
      const position = deps.sourceColumnOf(result, hint.line, hint.column);
      if (!position || position.line !== line) continue; // 列证不了 ⇒ 整条不说
      const key = `${line}\u0000${position.column}\u0000${hint.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        line,
        column: position.column,
        label: hint.label,
        ...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
        ...(hint.paddingLeft !== undefined ? { paddingLeft: hint.paddingLeft } : {}),
      });
    }
  }
  return { kind: 'inlayHint', hints: out.sort((a, b) => a.line - b.line || a.column - b.column) };
}

/* ------------------------------ workspaceSymbol（D2 的 `.kojo` 那一腿） ------------------------------ */

/**
 * `.kojo` 的工作区符号候选：**重定基**，不是第二份名录。
 *
 * 匹配 / 排序 / 预算全部复用 ERB 那条线（同一枚槽、同一个请求原样问下去），本包只做
 * 一件事：命中项的定义点若是某个 `.kojo` 的**产物**，就把 `filePath`/`line` 换成
 * 那份源文件的对应位置（`locate` 来自本包的 `.kojo` 名录，见 `kojo-function-catalog.ts`）。
 * 于是：
 * - 结果形状与 ERB **逐键一致**（`{...symbol}` 摊开只改两个字段，不新造第四种形状）；
 * - 顺序、`limit`、命中总数口径不另立一份；
 * - 作者按 `Ctrl+T` 打的是函数名，落点是**他能改的那份文件**，不是编译产物。
 *
 * 证不了源位置（名录里没有这个文件 / 这个名 / 折不回源行）⇒ **那一条不重定基**：
 * 它仍以产物路径出现在 ERB 那条线的结果里，功能上没有东西被吞掉。
 */
export function kojoWorkspaceSymbol(
  request: EditorWorkspaceSymbolRequest,
  deps: KojoWorkspaceSymbolDeps,
): EditorWorkspaceSymbolResult | undefined {
  // 名录还没建好就先闭嘴：答空数组等于宣称"这些名字都不在 `.kojo` 里"，而本包此刻
  // 根本还没有那份名录（与 `erb-workspace-symbols` 的"不答 ≠ 没有"同一区分）。
  if (!deps.catalogReady()) return undefined;
  const answers = deps.ask(request);
  const given = answers.filter((a): a is EditorWorkspaceSymbolResult => a.kind === 'workspaceSymbol');
  if (given.length === 0) return undefined; // 名录缺席 = 不答（与 erb-workspace-symbols 同一区分）

  const symbols: EditorWorkspaceSymbol[] = [];
  const seen = new Set<string>();
  for (const answer of given) {
    for (const symbol of answer.symbols) {
      const hit = deps.locate(symbol.filePath, symbol.name);
      if (hit === null) continue;
      const key = `${symbol.name}\u0000${hit.sourcePath}\u0000${hit.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ ...symbol, filePath: hit.sourcePath, line: hit.line });
    }
  }
  return { kind: 'workspaceSymbol', symbols, totalMatched: symbols.length };
}

/** 产物行数（`lineCount` 只是体量事实，供贡献方自行降级；按 `\n` 数与模型口径一致） */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  // PS-8：O(1) 内存计数（码元扫数 `\n`），不再为拿一个数 split 整篇产物
  //（与 `ui-sugar-lift/large-file.ts` 同款做法——插件间禁 import，故本地实现一份）
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
