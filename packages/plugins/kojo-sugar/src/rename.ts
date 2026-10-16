import type {
  EditorSymbolLocation,
  SugarDiagnostic,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { MODEL_TOKEN_CLASS, splitModelLines, unicodeTokenAt } from '@kojo/plugin-api';

/**
 * `.kojo` 用户函数改名 / 查找引用（R1，2026-10-16 语言服务批）。
 *
 * ## 可证明引用面（一句话，其余都从它推）
 *
 * **本文件「函数」块声明的名字**（规范 §7.2 最小形：`函数 <名>(…)` 声明、`调用 <名>(…)`
 * 语句、表达式位 `名(…)`）——引用面**只在同一份文件内**（跨文件可见 / 导出被规范明确
 * 排除，`spec §7.2`），所以改名 = 单文件编辑，不需要 ERB rename 那套双通道送达。
 *
 * ## 判读为什么交给转译器（本模块的核心取舍）
 *
 * "这个出现点是不是函数引用"没有任何词法正则答得对：`问候(` 在条件里是真引用、在
 * 台词旁白里是**要打印的文本**、在注释里是散文、在原生直通行里指向的是**别的**（引擎侧）
 * 名字。逐个判读就得把 `lexer` / `codegen` 的行分类与降糖管线抄第二份——两处各写一遍
 * 就是第二判据（B6 着色批已为此吃过一次"宁可只画声明位"的收窄）。
 *
 * 本模块换了一条路：**转译器自己当判官**（探针法）。把单个出现点换成一枚源里不可能
 * 存在的哨兵名再转译一次，看产物哪里变了：
 * - **定义点探针**：哨兵顶替名字进命名模板 ⇒ `@` 头行上的产物名变成「模板 + 哨兵」；
 * - **调用点探针**：哨兵不是已声明的函数，降糖器查不到 ⇒ 该调用在产物里**不再降糖**，
 *   产物名 token 被裸哨兵顶替（`CALL K101_问候()` → `CALL __probe()`）——两种形态都
 *   证明"这处出现流进了函数名"，是**可证明的引用**；
 * - 变的是裸旧名（台词文本原样透传 / 注释回显 / 原生直通行）⇒ 不是引用；
 * - 没变 ⇒ 更不是。
 *
 * 于是"引用"的定义与转译器的实际行为**逐字节同源**，零第二份词法。代价是每个出现点
 * 一次转译（O(n) 次，n = 该名在文件里的出现数，单文件量级 ≤ 十几次，转译毫秒级且带
 * LRU 缓存——用户显式动作（F2 / Shift+F12）付得起）。
 *
 * ## 全或无（与 `erb-rename` 同一条纪律）
 *
 * 引用集上还压一道**整卷复核**：把全部引用一起换成新名再转译，产物 diff 必须逐行
 * 落在"产物名 token 的替换"上（"改名后产物 diff 只在预期行"这条验收判据的运行时形态）。
 * 任何一行越界 ⇒ 整次取消并给出作者能读懂的理由——宁可不改，不许拿到一套名字分叉的
 * 半成品。编译错误同理：改前有错 ⇒ 产物不可信，拒绝；改后编译不过 ⇒ 拒绝。
 *
 * ## 刻意不做（不硬造）
 *
 * - **时机 / 自定指令块头**：`时机 指令 310：` 的分野是关键字闭集、编号是数字，
 *   产物函数名 `M_KOJO_…` 由工具按模板拼装——**作者在源里没有可改的名字**，
 *   改名无从谈起（要改产物名只能改模板 / 编号，那是另一类动作）；
 * - **引擎变量族头 / 指令名**：引擎内置，改名=产物跑不起来；中文族头别名是 adapter
 *   的游戏知识表（全游戏共享），从单个文件改名只会造成表与文本分叉；
 * - **别名 / 常量**：声明在 AST 上，但使用点散在表达式原文里且**不带括号**，与函数
 *   调用的探针判据不同形，本批不并入（记为后续候选）。
 *
 * 本模块是**纯函数**：转译由装配层注入，不读盘、不写盘、不发事件。
 */

/** 转译依赖（契约 `SugarTranspileService.transpile` 的纯函数面；`filePath` 只进诊断） */
export type SugarTranspileFn = (source: string, options?: { filePath?: string }) => SugarTranspileResult;

/** 一个名字出现点（1 基行、1 基列、`endColumn` 不含端点——与 `ErbReference` 同一口径） */
export interface KojoNameOccurrence {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
}

/** 记号整串（Unicode 字母/数字/下划线，与 `MODEL_TOKEN_CLASS` 同一张尺子） */
const RUN_RE = new RegExp(`${MODEL_TOKEN_CLASS}+`, 'gu');
/** 新名合法性：整串都是记号字符（含中文；其余交给转译器的编译门） */
const NAME_RE = new RegExp(`^${MODEL_TOKEN_CLASS}+$`, 'u');

/**
 * 全文扫描一个名字的**全部整串出现点**（**纯函数**；不做任何方言判读——判读交给探针）。
 *
 * 刻意不排除注释 / 台词 / 字符串：那些位置的出现点由探针逐个裁决，这里多收不误事、
 * 漏收才是错（漏了 = 改名后旧名残留 = 调用悬空）。`\r\n` 与裸 `\r` 归一（与
 * `splitModelLines` 同一条规则），行列在两种换行下逐位一致。
 */
export function scanNameOccurrences(source: string, name: string): KojoNameOccurrence[] {
  if (name.length === 0) return [];
  const out: KojoNameOccurrence[] = [];
  const lines = splitModelLines(source);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    RUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RUN_RE.exec(text)) !== null) {
      if (m[0] !== name) continue;
      out.push({ line: i + 1, column: m.index + 1, endColumn: m.index + 1 + name.length });
    }
  }
  return out;
}

/** 一行的标识符 run 序列（产物 diff 的对齐单位；`g` 旗标共享正则须每次复位） */
function identRuns(line: string): string[] {
  RUN_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(line)) !== null) out.push(m[0]!);
  return out;
}

/** 一对产物的逐行 diff：行数必须相等，每对差异行折成 run 级 `(from, to)` 对 */
function productDiff(before: string, after: string): Array<{ line: number; from: string; to: string }> | null {
  const a = splitModelLines(before);
  const b = splitModelLines(after);
  if (a.length !== b.length) return null;
  const out: Array<{ line: number; from: string; to: string }> = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ra = identRuns(a[i]!);
    const rb = identRuns(b[i]!);
    if (ra.length !== rb.length) return null; // 结构性变化（不该发生）→ 整卷判不可用
    for (let k = 0; k < ra.length; k++) {
      if (ra[k] !== rb[k]) out.push({ line: i + 1, from: ra[k]!, to: rb[k]! });
    }
  }
  return out;
}

/** 转译有无 error（error = 阻止出码，产物不可信——规范 §5.3 fail-closed） */
function hasError(result: SugarTranspileResult): boolean {
  return result.diagnostics.some((d: SugarDiagnostic) => d.severity === 'error');
}

/** 单个出现点换成哨兵名后的源文本（其余出现点原样保留） */
function withReplaced(source: string, occurrences: readonly KojoNameOccurrence[], picks: readonly number[], sentinel: string): string {
  const lines = splitModelLines(source);
  const pick = new Set(picks);
  for (const [i, occ] of occurrences.entries()) {
    if (!pick.has(i)) continue;
    const text = lines[occ.line - 1]!;
    lines[occ.line - 1] = text.slice(0, occ.column - 1) + sentinel + text.slice(occ.endColumn - 1);
  }
  return lines.join('\n');
}

/** 探针名：源里不可能存在的整串标识符（撞上就加长，绝不与作者文本重合） */
function sentinelName(source: string): string {
  let base = '__kojo_rename_probe__';
  while (source.includes(base)) base += '0';
  return base;
}

/** 一次探针的读数：产物差异 + 是否动了 `@` 头行 */
interface Probe {
  readonly diff: Array<{ line: number; from: string; to: string }>;
  readonly headerChanged: boolean;
}

/**
 * 一条探针是否证明"该出现点流进了命名模板"（引用判据，两个形态）：
 * - **定义点探针**：哨兵顶替名字进模板 ⇒ 产物名变成「模板 + 哨兵」（`@` 头行上的那对）；
 * - **调用点探针**：哨兵**不是**已声明的函数 ⇒ 降糖器查不到，名字在产物里**原样保留**
 *   ⇒ 产物名 token 被裸哨兵顶替（`CALL K101_问候()` → `CALL __probe()`）。
 * 台词 / 注释 / 原生行的探针变化是 `(旧名 → 裸哨兵)`，`from` 不是产物名，两个形态都不命中。
 */
function probeHitsProductToken(
  probe: Probe,
  productName: string,
  sentinelProductName: string,
  sentinel: string,
): boolean {
  return probe.diff.some((d) => d.from === productName && (d.to === sentinelProductName || d.to === sentinel));
}

/**
 * 探一次：第 `index` 号出现点 → 哨兵名，转译并与基线 diff。
 * 改后编译不过 / 行数漂移 ⇒ `null`（该出现点按"不可证明"处理，不猜）。
 * `headerChanged` = 差异落在基线产物的 `@` 函数头行上（只有定义点探针会动头行——
 * 调用点探针只改 `CALL` / 表达式行上的产物名）。
 */
function probeOccurrence(
  transpile: SugarTranspileFn,
  source: string,
  filePath: string,
  baseline: SugarTranspileResult,
  baselineLines: readonly string[],
  occurrences: readonly KojoNameOccurrence[],
  index: number,
  sentinel: string,
): Probe | null {
  const mutated = withReplaced(source, occurrences, [index], sentinel);
  const result = transpile(mutated, { filePath });
  if (hasError(result)) return null;
  const diff = productDiff(baseline.erb, result.erb);
  if (diff === null) return null;
  const headerChanged = diff.some(
    (d) => d.line >= 1 && d.line <= baselineLines.length && baselineLines[d.line - 1]!.trimStart().startsWith('@'),
  );
  return { diff, headerChanged };
}

/**
 * `planKojoRename` 的产物：可证明的编辑集（含定义点）或一条给作者看的拒绝理由。
 * `productName` 供调用方记读数 / 判撞名（改名后该文件产出的函数叫什么）。
 */
export type KojoRenamePlan =
  | {
      readonly kind: 'hit';
      readonly edits: readonly KojoNameOccurrence[];
      readonly productName: string;
      /** 被改的原名（宿主落地前对照 live model 现文本验证用） */
      readonly oldName: string;
    }
  | { readonly kind: 'reject'; readonly reason: string };

export interface KojoRenameArgs {
  readonly source: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly newName: string;
  readonly transpile: SugarTranspileFn;
  /**
   * 产物名撞名判据（可选；装配层拿 ERB 索引 `byName` 提供）：新名的产物函数若已在
   * 项目里存在（同一角色号下同名）⇒ 拒绝。缺席 = 不判（宁缺此守门，不猜索引外的事）。
   */
  readonly productNameExists?: (productName: string) => boolean;
}

/**
 * 重命名计划（**纯函数**；F2 的数据面）。
 *
 * 全部判定按文件头的三条纪律：转译器当判官、引用集必须整卷复核、任何不可证明的形态
 * 都整次取消并明说原因。编辑点顺序 = 扫描序（行 → 列），宿主落地时自行按行降序合并。
 */
export function planKojoRename(args: KojoRenameArgs): KojoRenamePlan {
  const { source, path, line, column, newName, transpile } = args;
  if (!NAME_RE.test(newName)) {
    return { kind: 'reject', reason: '新名只能是字母 / 数字 / 下划线 / 中文，不能含空白或标点' };
  }
  const lines = splitModelLines(source);
  const lineText = Number.isFinite(line) && line >= 1 && line <= lines.length ? lines[Math.trunc(line) - 1] : undefined;
  if (lineText === undefined) return { kind: 'reject', reason: '光标行越界，没有可重命名的名字' };
  const token = unicodeTokenAt(lineText, column);
  if (!token) return { kind: 'reject', reason: '光标处没有可重命名的名字' };
  const oldName = token.text;
  if (oldName === newName) return { kind: 'reject', reason: '新名与原名相同，没有可改的内容' };

  const baseline = transpile(source, { filePath: path });
  if (hasError(baseline)) {
    return { kind: 'reject', reason: '本文件当前有编译错误，转译产物不可信——请先修错误再改名' };
  }
  const occurrences = scanNameOccurrences(source, oldName);
  if (occurrences.length === 0) {
    return { kind: 'reject', reason: `「${oldName}」在本文件里没有出现，无从改名` };
  }
  const sentinel = sentinelName(source);

  // 第一轮探针：逐点裁决 + 从 @ 头行变化里钉出产物名（只有定义点探针会动头行）
  const baselineLines = splitModelLines(baseline.erb);
  const probes: Array<Probe | null> = [];
  const headerFroms = new Set<string>();
  for (let i = 0; i < occurrences.length; i++) {
    const probe = probeOccurrence(transpile, source, path, baseline, baselineLines, occurrences, i, sentinel);
    probes.push(probe);
    if (probe?.headerChanged) {
      for (const d of probe.diff) {
        if (d.from.includes(oldName) && d.to.includes(sentinel)) headerFroms.add(d.from);
      }
    }
  }
  if (headerFroms.size === 0) {
    return {
      kind: 'reject',
      reason:
        `「${oldName}」不是本文件「函数」块声明的名字，不能在这里改名——` +
        '时机 / 自定指令的产物函数名由工具按模板生成（源里没有可改的名字），' +
        '原生直通行里的函数名请到对应的 .erb 文件里改',
    };
  }
  if (headerFroms.size > 1) {
    return { kind: 'reject', reason: '改名目标歧义：产物函数名无法唯一确定，改名取消（不猜）' };
  }
  const productName = [...headerFroms][0]!;
  const sentinelProductName = productName.replace(oldName, sentinel);

  // 第二轮：引用集 = 探针改动了"那枚产物名 token"的出现点（定义点的头行变化天然命中）
  const refIndexes: number[] = [];
  for (const [i, probe] of probes.entries()) {
    if (probe === null) continue;
    if (probeHitsProductToken(probe, productName, sentinelProductName, sentinel)) refIndexes.push(i);
  }
  if (refIndexes.length === 0) {
    return { kind: 'reject', reason: `「${oldName}」的引用集不可证明（探针未命中产物名），改名取消（不猜）` };
  }

  // 产物名撞名守门（判据由装配层注入；索引缺席 = 不判，不猜索引外的事）
  const newProductName = productName.replace(oldName, newName);
  if (args.productNameExists?.(newProductName)) {
    return {
      kind: 'reject',
      reason: `新名「${newName}」的产物函数「${newProductName}」已被项目里的同名函数占用，改名取消`,
    };
  }

  // 整卷复核（验收判据的运行时形态）：全部引用一起换名再转译，
  // 产物 diff 必须逐行落在「产物名 token 的替换」上，越界一行即整次取消。
  const renamed = withReplaced(source, occurrences, refIndexes, newName);
  const full = transpile(renamed, { filePath: path });
  if (hasError(full)) {
    return {
      kind: 'reject',
      reason: `改名后编译不过：新名「${newName}」的产物无法编译（可能撞上关键字或既有名字），改名取消`,
    };
  }
  const fullDiff = productDiff(baseline.erb, full.erb);
  if (fullDiff === null) {
    return { kind: 'reject', reason: '改名会改变产物行数，超出"只改名字"的预期，改名取消（不猜）' };
  }
  for (const d of fullDiff) {
    if (d.from !== productName || d.to !== newProductName) {
      return {
        kind: 'reject',
        reason: `改名会波及预期之外的产物行（产物第 ${d.line} 行），为避免名字分叉，改名取消`,
      };
    }
  }

  const edits = refIndexes.map((i) => occurrences[i]!);
  return { kind: 'hit', edits, productName, oldName };
}

export interface KojoReferencesArgs {
  readonly source: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly transpile: SugarTranspileFn;
}

/**
 * 光标处名字的引用点全集（find-references 的数据面，**纯函数**）。
 *
 * 判据与 `planKojoRename` 的前两轮完全同源（同一套探针、同一个产物名钉取）；
 * 编译错误 / 不是本文件「函数」声明的名字 / 探针判不可用 ⇒ 空数组（**不猜**，
 * 作者看到"没有引用"而不是被跳到错地方）。
 */
export function kojoReferencesAt(args: KojoReferencesArgs): EditorSymbolLocation[] {
  const { source, path, line, column, transpile } = args;
  const lines = splitModelLines(source);
  const lineText = Number.isFinite(line) && line >= 1 && line <= lines.length ? lines[Math.trunc(line) - 1] : undefined;
  if (lineText === undefined) return [];
  const token = unicodeTokenAt(lineText, column);
  if (!token) return [];
  const baseline = transpile(source, { filePath: path });
  if (hasError(baseline)) return [];
  const occurrences = scanNameOccurrences(source, token.text);
  const sentinel = sentinelName(source);
  const baselineLines = splitModelLines(baseline.erb);
  const headerFroms = new Set<string>();
  const probes: Array<Probe | null> = [];
  for (let i = 0; i < occurrences.length; i++) {
    const probe = probeOccurrence(transpile, source, path, baseline, baselineLines, occurrences, i, sentinel);
    probes.push(probe);
    if (probe?.headerChanged) {
      for (const d of probe.diff) {
        if (d.from.includes(token.text) && d.to.includes(sentinel)) headerFroms.add(d.from);
      }
    }
  }
  if (headerFroms.size !== 1) return [];
  const productName = [...headerFroms][0]!;
  const sentinelProductName = productName.replace(token.text, sentinel);
  const out: EditorSymbolLocation[] = [];
  for (const [i, probe] of probes.entries()) {
    if (probe === null) continue;
    if (!probeHitsProductToken(probe, productName, sentinelProductName, sentinel)) continue;
    const occ = occurrences[i]!;
    out.push({ filePath: path, line: occ.line, column: occ.column });
  }
  return out;
}
