/**
 * 迁移引擎 · 语义升级层（K2-MIGRATE-SEMANTIC）——**只加不改**：机械层 `./index.ts` 一行不动。
 *
 * ## 为什么需要这一层
 *
 * 机械层只做"能逐字说清"的改写；三类构造在它那里是硬 unsupported（原块逐字保留）：
 *
 * | v1 构造 | 机械层现状 | 本层能证到的 2.0 落点（§12.1） |
 * |---|---|---|
 * | `当 / 是 / 到 / 否则` | `core/migration/switch` | `# 表` + 引用点（仅数值分档、可证非重叠） |
 * | `分支：` + `[条件]` | `core/migration/branch` | `# 池` + `! 池名`（条件可解析、有兜底、无副作用） |
 * | `初回 / 询问 / 确认` | `core/migration/ask` | `@原生` 缩进围栏（整块逐行搬，不解释） |
 *
 * 本层在**机械层之前**跑：先把可证的构造改写成 2.0 文本（中间态），再把中间态交给
 * `migrateKojoSource` 收口。**落盘判据仍然是机械层的 `ok`**：只要还有一处没迁完，
 * `ok === false`，调用方依旧不许写盘——本层不放松 fail-closed，也不产半成品。
 *
 * ## 三条改写口径（可证才动，不可证维持 unsupported）
 *
 * ### 1. `当 / 是 / 到 / 否则` → `# 表`
 *
 * 只认**值查找**形态：`当 <判别式>：` 下全是 `是 <精确值 | a 到 b>` 臂（英文 `is` / `to` 同形，
 * 逗号列表 `是 1, 2` 也认），可选且必须最后的 `否则：` 兜底。细则：
 *
 * - **同一判别式**：整块只有一个 `当` 头，判别式原文照搬到 `由 <表达式>`（不改写、不降糖）；
 * - **数值比较（精确 / 区间）**：臂值只允许十进制整数（`是 3` / `是 0 到 99` / `是 1, 2`）；
 *   字符串、别名、变量、表达式一律不认（`# 表` 端点只允许整数或整数 `# 常量`，§6.1）；
 * - **静态非重叠**：所有臂按 `[from, to]` 求交，两两不重叠（端点相等即重叠）；重叠/空区间/重复
 *   一律不认——`# 表` 不排序、不取"第一条命中"（§6.2），重叠就**不可能**等价；
 * - **`否则` → `否`**：`# 表` 的 `否` 必填且必须最后，所以缺兜底、兜底不在最后都不认；
 * - **值列 = 臂正文（= v1 打印文本）**：臂正文必须**恰好一行、形态一致**的打印行（全是旁白、或全是
 *   同一说话人的台词），因为 `# 表` 的值列只能装一个字面量（§6.1「不能写 `{表达式}`」）。引用点因此写成
 *   `> {表名}`（旁白）或 `角色：「{表名}」`（台词）：表按当前值分档，打印结果与 v1 分支一致。
 *   **台词臂的 `「…」` 是 v1 的内容、要打印**（K2-MIGRATE-QUOTE）：值列收 `「甲。」` 整段，
 *   运行期由 `{表}` 插值原样打印；值列是字面量、不参与 2.0 语法配对，所以引号安全。
 *   正文里带插值 `{}` / 行尾等待（`续` / `~` / `⏎` / `cont`）/ 多行 / 注释 / 更深块的臂**不认**
 *   （表值列表达不了它们，硬塞就是猜）。
 *
 * 表达式位置（赋值右侧）的 `当 … -> 值` **不在本层**：它要落到"已声明变量 + `@算`"，而变量声明
 * 在 v1 里无法证明，硬写 `# 变量` 就是编造。这条维持 unsupported（见交付说明的接线点）。
 *
 * > 为什么语句形态走 `# 表` 而不是 `?` 链：§6.5 说"`# 表` 是值查找，不替代 `当` 语句块的全部场景"，
 * > 纯语句分叉确实该落 `?` 链。本层只做**可证的值查找**那一半（分支正文就是一个字面量值 ⇒ 值列 +
 * > 引用点），其余语句形态仍交给机械层记 unsupported；`?` 链落点是另一条路（§12.1 的 `# 表` / `?`
 * > 双落点里本批次只取前者），不在本文件里偷偷实现。
 *
 * ### 2. `分支：` + `[条件]` → `# 池`
 *
 * - 条件文本**原样**进 `?` 链（与机械层对 `如果` 的条件照搬同口径）；但要求**可解析**：
 *   非空、无方括号、无分号 / `//`、无全角标点（2.0 表达式只认半角，`literal.ts` 同一份表）；
 * - **`? 否` 等价兜底**：必须有 `[其他]` / `[否则]` / `[else]`，且必须在最后（`# 池` 的 `? 否` 必填）；
 * - **无副作用**：每个分支正文先用机械层单独迁一遍（复用真实文本迁移，不抄第二份 text 转换），
 *   再按 `# 池` 白名单逐行核（只许台词 / 旁白 / 行内注释 / 嵌套 `?` / `@随机` / `@组` / `空行`）；
 *   出现 `@算`、`!` 调用、`@着色`、`@标` / `@跳`、`@原生`、赋值等一律不认（§7.1 池内禁止副作用）；
 * - **不改变"谁先命中"**：v1 的 `分支：` 在"同主语 + 同运算符 + 整数阈值"时会自动**按阈值排序**
 *   （§3.11），而 `# 池` 的 `?` 链是书写顺序 first-match。因此这种可排序形态只在**书写顺序恰好
 *   等于 v1 排序结果**时才改写；顺序不同就不认（否则会静默改变命中分支）。
 *
 * 落点：池声明**提升到文件顶层**（2.0 声明只能是顶层，§3.2），原块位置换成 `! 池名`——池在编译期
 * 条件展开，展开点就是原块位置，语义不变（§7.1）。
 *
 * ### 3. `初回 / 询问 / 确认` → `@原生`
 *
 * §12.1 的处置就是"2.0 暂无对应 → `@原生`"。本层把**块头 + 缩进体**整块逐行搬进围栏：
 * 去基准缩进（= 块内非空行最小前导空白，与 §8.5 同口径）、再整体缩进一级，**块内一个字节都不解释**
 * （`@原生` 里 `;` 是 ERB 注释、`[插槽]` 只是字符，§8.5）。搬运本身总可证；空块（v1 也报空块）
 * 不认。围栏内容的作者责任用 **warning** 标出来（`ok` 不受影响）：块内还是 v1 写法，得按 ERB 手改。
 *
 * ## 中间态 / 源映射
 *
 * 生成的声明行回源到**触发它的 v1 块头行**；`migrateKojoSource` 的 `sourceMap` 是"新行 → 中间态行"，
 * 本层再复合一次得到"新行 → v1 行"。诊断 / 台账的行号同样回映到 v1 行（列级不保证：行级映射是
 * 契约底线）。
 *
 * ## 纪律
 *
 * - 纯函数、零 IO；不读盘不写盘，不碰 `options` 以外的环境；
 * - 不解释围栏区：`@` 原生块、`[SKIPSTART]…[SKIPEND]`、`#DIM` 族预处理器整段原样放行（机械层
 *   会把它们包成 `@原生`；在围栏里改字 = 破坏逃生舱语义）；
 * - 幂等：已经是 2.0 的文本（含本层自己的产物）再跑一遍逐字节不变——它没有 `当` / `分支` / `初回`
 *   块可改写，全部原样放行；
 * - 改写不看"外层是谁"：块套在机械层最终仍会整块拒绝的块里（`循环` / `心形` …）也照改，但那块的
 *   unsupported 还在 ⇒ 整份结果 `ok === false` ⇒ 调用方不写盘，不会留下半旧半新的文件。
 */
import type { CoreDiagnosticCode, KojoDiagnostic } from '../diagnostics.js';
import { decodeIntegerLiteral } from '../lexer.js';
import { FULLWIDTH_EXPR_PUNCT } from '../literal.js';
import { migrateKojoSource, type MigrateOptions, type MigrateResult, type MigrateUnsupported } from './index.js';
import { classifyV1, hasWaitMark, parseDialogueShape, type Classified } from './classify.js';
import { indentOfLevel, isBlankBody, lineSpan, readSource, type V1Line, type V1Source } from './source.js';

/* ============================== 公共类型 ============================== */

/** 语义升级的三种落点（台账 / 迁移向导逐条上屏用） */
export type SemanticRewriteKind = 'switch-table' | 'branch-pool' | 'ask-native';

/** 一条已完成的语义升级（行号均为 v1 1 基源行） */
export interface SemanticRewrite {
  readonly kind: SemanticRewriteKind;
  /** 被改写的 v1 构造块头行 */
  readonly line: number;
  /** 该构造最后一行（含缩进体） */
  readonly endLine: number;
  /** 生成的表 / 池声明名；`ask-native` 为 null */
  readonly declName: string | null;
  /** 原位置替换出的引用行（`> {表}` / `! 池` / `@原生`） */
  readonly reference: string;
}

/** 语义升级的迁移结果：机械层结果的**超集**（字段语义不变） */
export interface SemanticMigrateResult extends MigrateResult {
  readonly rewrites: readonly SemanticRewrite[];
}

/* ============================== 内部形状 ============================== */

/** 中间态一行（`text` 不含 EOL；`source` = v1 1 基行号） */
interface OutLine {
  readonly text: string;
  readonly source: number;
  /** 本行是语义层**生成的 2.0**（表 / 池声明与引用行）：机械层不再按 v1 同形裁决（K2-MIGRATE-SHAPE） */
  readonly generated?: boolean;
}

/** 一条 `是` 臂的整数区间（两端含；精确值退化为 from === to） */
interface ArmRange {
  readonly from: number;
  readonly to: number;
}

/** 臂正文的打印形态（表值列 = 打印出来的那段字） */
type PrintShape =
  | { readonly kind: 'narration'; readonly text: string }
  | { readonly kind: 'dialogue'; readonly speaker: string | null; readonly text: string };

/** 一次改写尝试：成功给出行，失败给出**不猜的理由** */
type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** 表声明名 / 池声明名（自动生成，避开源文本里已有的同名标识符） */
const TABLE_PREFIX = '迁移表';
const POOL_PREFIX = '迁移池';

/**
 * 未采纳的语义升级在台账里追加的**可行动落点**（K2-MIGRATE-SHAPE）。
 *
 * 机械层的通用提示不能说错（教程表逐字引用它）：`当` 的值全是字面量时 `# 表` 仍是正解；
 * 但值列装不下正文时（`{}` / 多行 / 行尾等待），唯一可走的是 `?` 链或 `@原生`。
 */
const DECLINED_ACTIONS: Partial<Record<CoreDiagnosticCode, string>> = {
  'core/migration/switch':
    '`# 表` 值列只收一行字面量、不做插值：正文带 `{}` / 多行 / 行尾等待时，改写成 `?` 链或整块放进 `@原生`（§6.5 / §12.1）',
  'core/migration/branch': '改写成 `?` 链或整块放进 `@原生`（§7.1 / §12.1）',
  'core/migration/ask': '整块放进 `@原生` 后按 ERB 手工改写（§12.1）',
};

/** 池体分支正文的目标缩进级（`# 池` 0 级 → 分支 1 级 → 分支正文 2 级） */
const POOL_BODY_LEVEL = 2;

/** 全角标点表（与 2.0 表达式诊断共用同一份：`literal.ts`） */
const FULLWIDTH_PUNCT = FULLWIDTH_EXPR_PUNCT;

/* ============================== 公共入口 ============================== */

/**
 * 迁移 v1 `.kojo` 源文本到 2.0，含语义升级（纯函数；不读盘、不写盘、零副作用）。
 *
 * 返回 = 机械层 `MigrateResult` + `rewrites`；`ok` 语义与机械层完全一致（有 unsupported 即 false，
 * 调用方不许写盘）。已迁移过的 2.0 文本再传入 → `ok = true`、`code` 逐字节不变、`rewrites` 为空。
 */
export function migrateKojoSourceSemantic(source: string, options: MigrateOptions = {}): SemanticMigrateResult {
  if (typeof source !== 'string') {
    throw new TypeError('migrateKojoSourceSemantic 的输入必须是字符串（v1 .kojo 源文本）');
  }
  const src = readSource(source);
  return new SemanticUpgrader(source, src, options).run();
}

/* ============================== 升级器 ============================== */

class SemanticUpgrader {
  /** 原源文本（生成名查重用） */
  private readonly sourceText: string;
  private readonly src: V1Source;
  private readonly lines: readonly V1Line[];
  private readonly options: MigrateOptions;
  /** 说话人：`options.speaker` 优先、v1 文件头 `角色:` 兜底（与机械层同口径） */
  private readonly speaker: string | null;
  /** 提升到顶层的声明（表 / 池） */
  private readonly decls: OutLine[] = [];
  /** 中间态正文（被改写的块已换成引用行；其余原样） */
  private readonly body: OutLine[] = [];
  private readonly rewrites: SemanticRewrite[] = [];
  private readonly notes: KojoDiagnostic[] = [];
  /** 未采纳的语义升级（v1 行号 → 码 + 原因）：用于把**可行动提示**补进机械层台账（K2-MIGRATE-SHAPE） */
  private readonly declined = new Map<number, { readonly code: CoreDiagnosticCode; readonly reason: string }>();
  /** 已生成的声明名（表 / 池共用命名空间，但前缀不同） */
  private readonly generated = new Set<string>();
  private readonly seq = new Map<string, number>();

  constructor(source: string, src: V1Source, options: MigrateOptions) {
    this.sourceText = source;
    this.src = src;
    this.lines = src.lines;
    this.options = options;
    const optionSpeaker =
      options.speaker !== undefined && options.speaker.trim().length > 0 ? options.speaker.trim() : null;
    let headerChara: string | null = null;
    for (const line of this.lines) {
      if (isBlankBody(line.body)) continue;
      const cls = classifyV1(line.body);
      if (cls.kind.kind !== 'headDecl') continue;
      if (cls.kind.word !== '角色' && cls.kind.word !== 'char') continue;
      if (headerChara === null && cls.kind.value.length > 0) headerChara = cls.kind.value;
    }
    this.speaker = optionSpeaker ?? headerChara;
  }

  /* ---------------------------- 主流程 ---------------------------- */

  run(): SemanticMigrateResult {
    this.scan();
    const intermediate = this.renderIntermediate();
    // 语义层生成的 2.0 行（表 / 池 / 引用）跳过机械层的 v1 同形裁决：
    // 它们是本层按 2.0 语法写出来的，再被当成"v1 的 `角色：「…」` 打印"会误报歧义、甚至误改成旁白。
    const mechOptions: MigrateOptions = {
      ...this.options,
      ...(intermediate.trustedLines.length === 0
        ? {}
        : { trustedLines: [...(this.options.trustedLines ?? []), ...intermediate.trustedLines] }),
    };
    const mech = migrateKojoSource(intermediate.code, mechOptions);
    const toV1 = (line: number): number => {
      if (line <= 0) return line;
      const mapped = intermediate.lineMap[line - 1];
      return mapped === undefined ? line : mapped;
    };
    return {
      ...mech,
      sourceMap: mech.sourceMap.map(toV1),
      diagnostics: [...this.notes, ...mech.diagnostics.map((diagnostic) => remapDiagnostic(diagnostic, toV1))],
      unsupported: mech.unsupported.map((entry) => this.enrichDeclined(remapUnsupported(entry, toV1))),
      rewrites: this.rewrites,
    };
  }

  /**
   * 未采纳的语义升级：把**具体原因 + 可行动落点**补进机械层台账的 `targetHint`。
   *
   * 机械层的 `targetHint` 是"这类构造该去哪"的通用话（`TARGET_HINTS`，教程表逐字引用它，
   * 不能改）；但对 `当` 块来说，"值查找写 `# 表`"在值列装不下正文时是**错误指引**——
   * `# 表` 值列是字面量、不做插值，正文带 `{}` / 多行 / 行尾等待时只能改 `?` 链或 `@原生`。
   * 这里按行追加本次的具体原因，让台账直接可行动（K2-MIGRATE-SHAPE）。
   */
  private enrichDeclined(entry: MigrateUnsupported): MigrateUnsupported {
    const declined = this.declined.get(entry.line);
    if (declined === undefined || declined.code !== entry.code) return entry;
    const action = DECLINED_ACTIONS[declined.code];
    const suffix = `（本次未自动改写：${declined.reason}${action === undefined ? '' : `。${action}`}）`;
    return { ...entry, targetHint: `${entry.targetHint}${suffix}` };
  }

  /** 逐行扫；围栏区整段原样放行，三类块各试一次语义升级 */
  private scan(): void {
    let i = 0;
    while (i < this.lines.length) {
      const line = this.lines[i]!;
      if (isBlankBody(line.body)) {
        this.copyLine(line);
        i++;
        continue;
      }
      const fenceEnd = this.fencedEnd(i);
      if (fenceEnd !== null) {
        i = this.copyRange(i, fenceEnd);
        continue;
      }
      const cls = classifyV1(line.body);
      switch (cls.kind.kind) {
        case 'whenHead':
          i = this.handleSwitch(i, cls);
          break;
        case 'branchHead':
          i = this.handleBranch(i, cls);
          break;
        case 'askHead':
          i = this.handleAsk(i);
          break;
        default:
          this.copyLine(line);
          i++;
          break;
      }
    }
  }

  /* ---------------------------- 发射原语 ---------------------------- */

  private copyLine(line: V1Line): void {
    this.body.push({ text: line.raw, source: line.number });
  }

  /** 原样复制 [from, to)，返回 to */
  private copyRange(from: number, to: number): number {
    for (let i = from; i < to; i++) this.copyLine(this.lines[i]!);
    return to;
  }

  private pushComment(level: number, comment: string | null, source: number): void {
    if (comment === null) return;
    this.body.push({ text: `${indentOfLevel(level)}//${comment}`, source });
  }

  /**
   * 提升一条声明到文件顶层（2.0 声明只能写顶层，§3.2），并按 §6.1 "表前后各空一行" 补一个空行。
   * 空行同时是声明体的自然收束（缩进回 0 也会收，但空行让产物读起来是 2.0 的样子）。
   */
  private pushDecl(lines: readonly string[], source: number): void {
    for (const text of lines) this.decls.push({ text, source, generated: true });
    this.decls.push({ text: '', source, generated: true });
  }

  /** 成功改写的 warning：**不阻断**（warning 不进 `ok`），但作者要知道名字是自动生成的 */
  private note(code: CoreDiagnosticCode, line: V1Line, message: string): void {
    this.notes.push({ code, severity: 'warning', message, span: lineSpan(line) });
  }

  /** 未采纳的 warning：块原样交给机械层记 unsupported（**不猜**） */
  private decline(code: CoreDiagnosticCode, line: V1Line, reason: string): void {
    this.declined.set(line.number, { code, reason });
    this.notes.push({
      code,
      severity: 'warning',
      message: `语义升级未采纳（${reason}）：整块保持 v1 原样，由机械层记 unsupported——不猜。`,
      span: lineSpan(line),
    });
  }

  private pushRewrite(
    kind: SemanticRewriteKind,
    line: number,
    end: number,
    declName: string | null,
    reference: string,
  ): void {
    const last = this.lines[Math.max(line - 1, end - 1)];
    this.rewrites.push({ kind, line, endLine: last === undefined ? line : last.number, declName, reference });
  }

  /* ---------------------------- 范围工具 ---------------------------- */

  /** 块缩进体区间（不含块头；尾随空行归还外层）——与机械层同口径 */
  private rangeEnd(headIndex: number, limit: number): number {
    const head = this.lines[headIndex]!;
    let end = headIndex + 1;
    let i = headIndex + 1;
    while (i < limit) {
      const line = this.lines[i]!;
      if (isBlankBody(line.body)) {
        i++;
        continue;
      }
      if (line.indent <= head.indent) break;
      end = i + 1;
      i++;
    }
    return end;
  }

  /**
   * 围栏区终点（null = 不在围栏区）。三类一律**不解释**：
   * `[SKIPSTART]…[SKIPEND]`、`#` 预处理器族、`@` 起（v1 原生函数块 / 2.0 调度块，直到下一个 `@` 行）。
   */
  private fencedEnd(index: number): number | null {
    const body = this.lines[index]!.body;
    if (body === '[SKIPSTART]') {
      for (let i = index + 1; i < this.lines.length; i++) {
        if (this.lines[i]!.body === '[SKIPEND]') return i + 1;
      }
      return this.lines.length;
    }
    if (/^#[A-Za-z_]/.test(body)) {
      let i = index;
      while (i < this.lines.length && /^#[A-Za-z_]/.test(this.lines[i]!.body)) i++;
      return i;
    }
    if (body.startsWith('@')) {
      for (let i = index + 1; i < this.lines.length; i++) {
        if (this.lines[i]!.body.startsWith('@')) return i;
      }
      return this.lines.length;
    }
    return null;
  }

  /* ---------------------------- 当 → # 表 ---------------------------- */

  private handleSwitch(index: number, cls: Classified): number {
    const line = this.lines[index]!;
    const end = this.rangeEnd(index, this.lines.length);
    const attempt = this.buildSwitchTable(index, end, line, cls);
    if (!attempt.ok) {
      this.decline('core/migration/switch', line, attempt.reason);
      return this.copyRange(index, end);
    }
    const { name, decl, reference } = attempt.value;
    this.pushDecl(decl, line.number);
    this.body.push({ text: `${indentOfLevel(line.indent)}${reference}`, source: line.number, generated: true });
    this.pushComment(line.indent, cls.comment, line.number);
    this.pushRewrite('switch-table', line.number, end, name, reference);
    this.note(
      'core/migration/switch',
      line,
      `已把 \`当\` 的数值分档改写成 \`# 表 ${name}\`（值列 = 原分支正文），原处写成 \`${reference}\`；表名自动生成，可在编辑器里改名（§6.5）。`,
    );
    return end;
  }

  private buildSwitchTable(
    index: number,
    end: number,
    head: V1Line,
    cls: Classified,
  ): Attempt<{ readonly name: string; readonly decl: readonly string[]; readonly reference: string }> {
    const kind = cls.kind;
    if (kind.kind !== 'whenHead') return { ok: false, reason: '不是 `当` 块头' };
    const subject = kind.rest.trim();
    const subjectProblem = expressionTextProblem(subject);
    if (subjectProblem !== null) return { ok: false, reason: subjectProblem };

    const arms: { readonly ranges: readonly ArmRange[]; readonly isDefault: boolean; readonly value: PrintShape }[] = [];
    let i = index + 1;
    while (i < end) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) {
        i++;
        continue;
      }
      if (cur.indent !== head.indent + 1) {
        return { ok: false, reason: '`是` / `否则` 臂不在块头下恰好一级（v1 结构不可证）' };
      }
      const armCls = classifyV1(cur.body);
      const armEnd = this.rangeEnd(i, end);
      const body = this.readArmValue(i, armEnd, cur);
      if (!body.ok) return { ok: false, reason: body.reason };
      if (armCls.kind.kind === 'elseHead') {
        if (arms.some((arm) => arm.isDefault)) return { ok: false, reason: '出现两个 `否则` 兜底' };
        arms.push({ ranges: [], isDefault: true, value: body.value });
      } else if (armCls.kind.kind === 'isHead') {
        const ranges = parseArmRanges(armCls.kind.rest);
        if (ranges === null) {
          return {
            ok: false,
            reason: `\`是 ${armCls.kind.rest.trim()}\` 不是十进制整数（精确值 / 区间）——非数值判别式不进 \`# 表\``,
          };
        }
        arms.push({ ranges, isDefault: false, value: body.value });
      } else {
        return { ok: false, reason: '`当` 块第一层出现 `是` / `否则` 之外的行' };
      }
      i = armEnd;
    }

    if (arms.length === 0) return { ok: false, reason: '`当` 块没有任何 `是` 臂' };
    const defaultIndex = arms.findIndex((arm) => arm.isDefault);
    if (defaultIndex < 0) return { ok: false, reason: '缺 `否则` 兜底（`# 表` 的 `否` 行必填）' };
    if (defaultIndex !== arms.length - 1) return { ok: false, reason: '`否则` 不在最后（`# 表` 的 `否` 必须最后）' };

    const ranges: ArmRange[] = [];
    for (const arm of arms) for (const range of arm.ranges) ranges.push(range);
    if (ranges.length === 0) return { ok: false, reason: '`当` 块没有任何 `是` 臂' };
    if (rangesOverlap(ranges)) {
      return {
        ok: false,
        reason: '`是` 臂的整数区间静态重叠——`# 表` 要求两两不重叠，不排序、不取“第一条命中”',
      };
    }

    const first = arms[0]!.value;
    const values: string[] = [];
    for (const arm of arms) {
      if (arm.value.kind !== first.kind) return { ok: false, reason: '臂正文形态不一致（台词 / 旁白混用）' };
      if (arm.value.kind === 'dialogue' && first.kind === 'dialogue' && arm.value.speaker !== first.speaker) {
        return { ok: false, reason: '台词臂的说话人不一致（表值列只能装同一说话人的正文）' };
      }
      const problem = tableValueProblem(arm.value.text);
      if (problem !== null) return { ok: false, reason: problem };
      values.push(arm.value.text.trim());
    }

    const name = this.allocName(TABLE_PREFIX);
    const decl: string[] = [`# 表 ${name} 由 ${subject}`];
    arms.forEach((arm, armIndex) => {
      const value = values[armIndex]!;
      if (arm.isDefault) {
        decl.push(`    否 ${value}`);
        return;
      }
      for (const range of arm.ranges) decl.push(`    ${rangeText(range)} ${value}`);
    });

    let reference: string;
    if (first.kind === 'narration') {
      reference = `> {${name}}`;
    } else {
      const speaker = first.speaker ?? this.speaker;
      if (speaker === null) {
        return { ok: false, reason: '台词臂缺说话人（补 v1 文件头 `角色:` 或 options.speaker）' };
      }
      reference = `${speaker}：「{${name}}」`;
    }
    return { ok: true, value: { name, decl, reference } };
  }

  /** 读一条臂的正文：**恰好一行**、形态可装的打印行 */
  private readArmValue(armIndex: number, armEnd: number, armLine: V1Line): Attempt<PrintShape> {
    const contentIndent = armLine.indent + 1;
    let found: PrintShape | null = null;
    for (let i = armIndex + 1; i < armEnd; i++) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) continue;
      if (cur.indent !== contentIndent) {
        return { ok: false, reason: '臂正文里有更深的块（`# 表` 值列只能装一行正文）' };
      }
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'comment') return { ok: false, reason: '臂正文里带 `;` 注释，迁进 `# 表` 会丢注释' };
      if (sameShapeDialogueLine(cls, cur.body)) {
        return {
          ok: false,
          reason:
            '臂正文是 `X：「…」`：v1 里它是旁白打印（连前缀与引号一起打印），2.0 却当台词——同形歧义不猜，整块保持 v1 原样',
        };
      }
      if (found !== null) return { ok: false, reason: '臂正文多于一行（`# 表` 值列只能装一行正文）' };
      const shape = printShapeOf(cls, cur.body);
      if (shape === null) {
        return { ok: false, reason: `臂正文「${cur.body.trim()}」不是可整行打印的台词 / 旁白` };
      }
      found = shape;
    }
    if (found === null) return { ok: false, reason: '臂正文为空' };
    return { ok: true, value: found };
  }

  /* ---------------------------- 分支 → # 池 ---------------------------- */

  private handleBranch(index: number, cls: Classified): number {
    const line = this.lines[index]!;
    const end = this.rangeEnd(index, this.lines.length);
    const attempt = this.buildBranchPool(index, end, line, cls);
    if (!attempt.ok) {
      this.decline('core/migration/branch', line, attempt.reason);
      return this.copyRange(index, end);
    }
    const { name, decl, reference } = attempt.value;
    this.pushDecl(decl, line.number);
    this.body.push({ text: `${indentOfLevel(line.indent)}${reference}`, source: line.number, generated: true });
    this.pushComment(line.indent, cls.comment, line.number);
    this.pushRewrite('branch-pool', line.number, end, name, reference);
    this.note(
      'core/migration/branch',
      line,
      `已把 \`分支：\` 规则池改写成 \`# 池 ${name}\`（\`[其他]\` → \`? 否\`），原处写成 \`${reference}\`；池名自动生成，可在编辑器里改名（§7.1）。`,
    );
    return end;
  }

  private buildBranchPool(
    index: number,
    end: number,
    head: V1Line,
    cls: Classified,
  ): Attempt<{ readonly name: string; readonly decl: readonly string[]; readonly reference: string }> {
    if (cls.kind.kind !== 'branchHead') return { ok: false, reason: '不是 `分支：` 块头' };

    interface Draft {
      readonly condition: string | null;
      readonly start: number;
      readonly end: number;
    }
    const drafts: Draft[] = [];
    let i = index + 1;
    while (i < end) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) {
        i++;
        continue;
      }
      if (cur.indent !== head.indent + 1) {
        return { ok: false, reason: '`[条件]` 标签不在 `分支：` 下恰好一级' };
      }
      const label = parsePoolLabel(cur.body);
      if (label === null) return { ok: false, reason: '`分支：` 第一层不是整行 `[条件]` 标签' };
      const labelEnd = this.rangeEnd(i, end);
      drafts.push({ condition: label.condition, start: i + 1, end: labelEnd });
      i = labelEnd;
    }

    const fallbacks = drafts.filter((draft) => draft.condition === null).length;
    if (fallbacks === 0) return { ok: false, reason: '没有 `[其他]` / `[否则]` 兜底——`# 池` 的 `? 否` 必填' };
    if (fallbacks > 1) return { ok: false, reason: '出现多个兜底标签（`# 池` 只能有一个 `? 否`）' };
    if (drafts[drafts.length - 1]!.condition !== null) return { ok: false, reason: '兜底标签不在最后' };

    const conditions: string[] = [];
    for (const draft of drafts) {
      if (draft.condition === null) continue;
      const problem = conditionProblem(draft.condition);
      if (problem !== null) return { ok: false, reason: problem };
      conditions.push(draft.condition);
    }
    if (conditions.length === 0) return { ok: false, reason: '`分支：` 没有条件分支' };
    const normalized = conditions.map((text) => text.replace(/[ \t\u3000]+/g, ' ').trim());
    if (new Set(normalized).size !== normalized.length) {
      return { ok: false, reason: '两条条件的规范化文本相同（v1 对重复条件报错）' };
    }
    const sortProblem = rulePoolOrderProblem(conditions);
    if (sortProblem !== null) return { ok: false, reason: sortProblem };

    const bodies: string[][] = [];
    for (const draft of drafts) {
      const body = this.convertPoolBody(draft.start, draft.end);
      if (!body.ok) return { ok: false, reason: body.reason };
      bodies.push([...body.value.lines]);
    }

    const name = this.allocName(POOL_PREFIX);
    const decl: string[] = [`# 池 ${name}`];
    drafts.forEach((draft, draftIndex) => {
      const condition = draft.condition === null ? '否' : draft.condition;
      decl.push(`    ? ${condition}`);
      for (const text of bodies[draftIndex]!) decl.push(text);
    });
    return { ok: true, value: { name, decl, reference: `! ${name}` } };
  }

  /**
   * 一个 `[条件]` 分支的正文：先用机械层**真迁一遍**（speaker / `;` 注释 / `如果` 链都走同一份实现），
   * 再按 `# 池` 白名单逐行核。分支正文里 v1 空行只是分隔符（不进产物），这里一并丢掉——
   * 2.0 `?` 链里物理空行会断链。
   */
  private convertPoolBody(start: number, end: number): Attempt<{ readonly lines: readonly string[] }> {
    const rawLines: string[] = [];
    for (let i = start; i < end; i++) rawLines.push(this.lines[i]!.raw);
    if (rawLines.length === 0) return { ok: false, reason: '条件分支没有正文' };
    // 同形歧义（K2-MIGRATE-SHAPE）：`X：「…」` 在 v1 是旁白打印、在 2.0 是台词。语义层不解释它，
    // 整块保持 v1 原样（机械层记 unsupported）——把正文拆成独立片段再迁时片段可能丢掉 v1 证据，
    // 不能指望子调用替我们裁决。
    for (let i = start; i < end; i++) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) continue;
      if (sameShapeDialogueLine(classifyV1(cur.body), cur.body)) {
        return {
          ok: false,
          reason: '分支正文里有 `X：「…」`：v1 里它是旁白打印（连前缀与引号一起打印），2.0 却当台词——同形歧义不猜，整块保持 v1 原样',
        };
      }
    }
    const sub = migrateKojoSource(`${rawLines.join('\n')}\n`, this.subOptions());
    if (!sub.ok) {
      return { ok: false, reason: '分支正文里仍有机械层不可迁移的写法（`# 池` 内禁止副作用）' };
    }
    const out = sub.code
      .split(/\r\n|\r|\n/)
      .filter((text) => text.trim().length > 0);
    if (out.length === 0) return { ok: false, reason: '条件分支正文迁移后为空' };
    for (const text of out) {
      if (!poolBodyLineOk(text)) {
        return { ok: false, reason: `分支正文里有 \`# 池\` 不允许的构造「${text.trim()}」` };
      }
    }
    const levels = out.map((text) => leadLevel(text));
    const base = Math.min(...levels);
    const lines = out.map(
      (text, i) => `${indentOfLevel(POOL_BODY_LEVEL + levels[i]! - base)}${stripLead(text)}`,
    );
    return { ok: true, value: { lines } };
  }

  /* ---------------------------- 初回 → @原生 ---------------------------- */

  private handleAsk(index: number): number {
    const line = this.lines[index]!;
    const end = this.rangeEnd(index, this.lines.length);
    let hasBody = false;
    for (let i = index + 1; i < end; i++) {
      if (!isBlankBody(this.lines[i]!.body)) {
        hasBody = true;
        break;
      }
    }
    if (!hasBody) {
      this.decline('core/migration/ask', line, '`初回 / 询问 / 确认` 块没有正文（v1 也报空块）');
      return this.copyRange(index, end);
    }

    let base = Number.POSITIVE_INFINITY;
    for (let i = index; i < end; i++) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) continue;
      base = Math.min(base, cur.lead.length);
    }
    if (!Number.isFinite(base)) base = 0;

    const level = line.indent;
    this.body.push({ text: `${indentOfLevel(level)}@原生`, source: line.number });
    for (let i = index; i < end; i++) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) {
        this.body.push({ text: '', source: cur.number });
        continue;
      }
      this.body.push({ text: `${indentOfLevel(level + 1)}${cur.raw.slice(base)}`, source: cur.number });
    }
    this.pushRewrite('ask-native', line.number, end, null, '@原生');
    this.note(
      'core/migration/ask',
      line,
      '`初回 / 询问 / 确认` 已整块搬进 `@原生`：块内仍是 v1 写法、2.0 不再解释，请按 ERB 手工改写（§12.1）。',
    );
    return end;
  }

  /* ---------------------------- 中间态 / 命名 ---------------------------- */

  private subOptions(): MigrateOptions {
    return this.speaker === null ? {} : { speaker: this.speaker };
  }

  /**
   * 声明名自动生成：`迁移表1` / `迁移池1` …，**避开源文本里已有的同名标识符**（表 / 池 / 变量 / 常量 /
   * 模板 / 函数共用文件命名空间，§3.2）。这是确定性的：同一份输入永远得到同一批名字。
   */
  private allocName(prefix: string): string {
    for (let n = (this.seq.get(prefix) ?? 0) + 1; ; n++) {
      const candidate = `${prefix}${n}`;
      if (this.generated.has(candidate)) continue;
      if (sourceMentionsName(this.sourceText, candidate)) continue;
      this.seq.set(prefix, n);
      this.generated.add(candidate);
      return candidate;
    }
  }

  private renderIntermediate(): {
    readonly code: string;
    readonly lineMap: readonly number[];
    /** 语义层生成的 2.0 行（1 基中间态行号）；机械层跳过同形裁决（K2-MIGRATE-SHAPE） */
    readonly trustedLines: readonly number[];
  } {
    const out: OutLine[] = [...this.decls, ...this.body];
    if (this.body.length === 0) {
      while (out.length > 0 && out[out.length - 1]!.text.length === 0) out.pop();
    }
    if (out.length === 0) return { code: '', lineMap: [], trustedLines: [] };
    const text = out.map((line) => line.text).join(this.src.eol);
    const withFinal = this.src.finalNewline ? `${text}${this.src.eol}` : text;
    // BOM 码元**取自输入首字符**（本层不凭空造 BOM，只把输入的 BOM 带过去；复用机械层同一契约）
    const bom = this.src.bom ? this.sourceText.slice(0, 1) : '';
    const trustedLines: number[] = [];
    out.forEach((line, index) => {
      if (line.generated === true) trustedLines.push(index + 1);
    });
    return { code: `${bom}${withFinal}`, lineMap: out.map((line) => line.source), trustedLines };
  }
}

/* ============================== 纯工具：表达式 / 臂 ------------------------------ */

/** 判别式 / 条件文本能不能原样当 2.0 表达式用（全角标点、花括号、分号都不认） */
function expressionTextProblem(text: string): string | null {
  const value = text.trim();
  if (value.length === 0) return '`当` 缺判别式';
  if (/[{}]/.test(value)) return '判别式里有 `{` / `}`（2.0 表达式不认插值括号）';
  for (const ch of value) {
    if (FULLWIDTH_PUNCT.has(ch)) return `判别式里有全角标点「${ch}」（2.0 表达式只认半角）`;
  }
  if (/[;；]/.test(value)) return '判别式里有分号（2.0 无行尾注释）';
  return null;
}

/**
 * 一条 `是` 臂的值 → 整数区间（逗号列表展开成多条；`到` / `..` / `to` 是闭区间）。
 * null = 不是可证的十进制整数（字符串 / 别名 / 变量 / 表达式一律不认）。
 */
function parseArmRanges(rest: string): readonly ArmRange[] | null {
  const parts = rest.split(/[,，]/).map((part) => part.trim());
  const out: ArmRange[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    const range = /^(-?\d+)\s*(?:到|\.\.|to)\s*(-?\d+)$/u.exec(part);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return null;
      out.push({ from, to });
      continue;
    }
    const exact = /^(-?\d+)$/u.exec(part);
    if (exact !== null) {
      const value = Number(exact[1]);
      if (!Number.isSafeInteger(value)) return null;
      out.push({ from: value, to: value });
      continue;
    }
    return null;
  }
  return out;
}

/** 静态非重叠：闭区间求交（端点相等即重叠） */
function rangesOverlap(ranges: readonly ArmRange[]): boolean {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;
      if (a.from <= b.to && b.from <= a.to) return true;
    }
  }
  return false;
}

/** 表行范围列（精确值写单值，区间写 `a..b`） */
function rangeText(range: ArmRange): string {
  return range.from === range.to ? `${range.from}` : `${range.from}..${range.to}`;
}

/**
 * 臂正文的打印形态：`{表}` 引用点只能插进一条打印行，所以只认"整行旁白"或"整行台词"。
 * 行尾等待 / 表演提示 / 行内 `;` 不在表值列的表达范围内（表值列是字面量，§6.1）。
 *
 * **引号口径（K2-MIGRATE-QUOTE）**：值列装的是**v1 打印出来的那段字**，所以 v1 台词臂
 * `「甲。」` 的值是 `「甲。」`（连引号），引用点 `角色：「{表}」` 在运行期把值原样打印。
 * 这是 §15.2.3「只换行首分类」的直接推论：v1 台词的引号是内容，不是语法。
 */
function printShapeOf(cls: Classified, body: string): PrintShape | null {
  const text = body.trim();
  if (text.length === 0) return null;
  if (hasWaitMark(text)) return null;
  if (cls.kind.kind === 'kojo2') return dialogueShape(text);
  if (cls.kind.kind !== 'text') return null;
  if (text.startsWith('「') || text.startsWith('｢')) {
    const close = text.startsWith('｢') ? '｣' : '」';
    if (!text.endsWith(close)) return null;
    const inner = text.slice(1, -1);
    // `｢｣` 按 §12.1 归一成全角；值列可以带引号（运行期字面量，不参与 2.0 语法配对）
    return { kind: 'dialogue', speaker: null, text: `「${inner}」` };
  }
  return { kind: 'narration', text };
}

/** 已经是 2.0 的台词行（`角色：「…」`）→ 说话人 + 引号内正文（正文 = 打印文本） */
function dialogueShape(text: string): PrintShape | null {
  const quote = text.indexOf('「');
  if (quote <= 1) return null;
  const colon = text.indexOf('：');
  if (colon <= 0 || colon !== quote - 1) return null;
  const speaker = text.slice(0, colon).trim();
  if (speaker.length === 0) return null;
  if (/[{}\s「」：:]/.test(speaker)) return null;
  if (!text.endsWith('」')) return null;
  const inner = text.slice(quote + 1, -1);
  if (inner.length === 0) return null;
  return { kind: 'dialogue', speaker, text: inner };
}

/** 表值列的字面量安全：不许插值、不许变整数、不许引号开头（都会改变打印出来的字） */
function tableValueProblem(text: string): string | null {
  const value = text.trim();
  if (value.length === 0) return '臂正文（表值）为空';
  if (/[{}]/.test(value)) return '臂正文里有 `{` / `}`（`# 表` 值列不做插值，打印结果会变）';
  if (/^"/.test(value)) return '臂正文以双引号开头（表值列会按引号字符串解码，改变正文）';
  // 与 2.0 表值列的解码同一入口（`decodeIntegerLiteral`：十进制 / 0x / 带符号都算数值）
  if (decodeIntegerLiteral(value) !== null) {
    return '臂正文是整数字面量（`# 表` 值列会把它解码成数值；文字表不能混整数）';
  }
  // 台词臂的 `「…」` 是**打印文本**（v1 引号是内容）：值列原样收，运行期由 `{表}` 插值打印，
  // 不参与 2.0 语法配对，所以这里不拦引号（K2-MIGRATE-QUOTE）。
  return null;
}

/* ============================== 纯工具：规则池 ------------------------------ */

/** `[条件]` 标签行：整行恰为 `[…]`；`[其他]` / `[否则]` / `[else]` 是兜底（condition = null） */
function parsePoolLabel(body: string): { readonly condition: string | null } | null {
  const text = body.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  if (inner.length === 0) return null;
  if (inner === '其他' || inner === '否则' || inner === 'else') return { condition: null };
  // ERB 原生记号（`[SKIPSTART]` / `[0]` …）不当标签：v1 标签判定同一口径
  if (/^[A-Z0-9_]+$/.test(inner)) return null;
  return { condition: inner };
}

/** 条件文本能不能原样进 `?` 行（可解析 = 词法上干净；条件语义仍交给 adapter 管线，不在这层猜） */
function conditionProblem(text: string): string | null {
  const value = text.trim();
  if (value.length === 0) return '条件的 `[条件]` 标签是空的';
  if (value === '否') return '条件文本是 `否`（2.0 里 `? 否` 是兜底，不能当条件）';
  if (/[[\]]/.test(value)) return '条件里带方括号（`?` 行不支持标签形态）';
  if (value.endsWith('：') || value.endsWith(':')) return '条件以冒号结尾（`分支：` 的标签形态漏写进条件里）';
  if (/[;；]/.test(value)) return '条件里有分号（2.0 无行尾注释）';
  if (value.includes('//')) return '条件里有 `//`（2.0 无行尾注释）';
  for (const ch of value) {
    if (FULLWIDTH_PUNCT.has(ch)) return `条件里有全角标点「${ch}」（2.0 表达式只认半角）`;
  }
  if (!balancedQuotes(value)) return '条件里的引号不成对';
  if (!balancedParens(value)) return '条件里的括号不成对';
  return null;
}

function balancedQuotes(text: string): boolean {
  let double = 0;
  let open = 0;
  let close = 0;
  for (const ch of text) {
    if (ch === '"') double++;
    else if (ch === '「') open++;
    else if (ch === '」') close++;
  }
  return double % 2 === 0 && open === close;
}

function balancedParens(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** 同主语 + 同运算符 + 整数阈值的条件（v1 会对这种形态**自动排序**，§3.11） */
interface ThresholdCondition {
  readonly subject: string;
  readonly op: string;
  readonly threshold: number;
}

function thresholdCondition(text: string): ThresholdCondition | null {
  const m = /^(.+?)\s*(>=|<=|>|<|至少|至多|超过|不足)\s*(-?\d+)$/u.exec(text.trim());
  if (m === null) return null;
  const threshold = Number(m[3]);
  if (!Number.isSafeInteger(threshold)) return null;
  return { subject: m[1]!.trim(), op: m[2]!, threshold };
}

/**
 * v1 的 `分支：` 在"同主语同运算符整数阈值"时会自动排序；`# 池` 的 `?` 链是书写顺序 first-match。
 * 只有书写顺序**恰好等于** v1 排序结果时才等价；否则改写会静默改变命中分支 ⇒ 不认。
 * 不可排序的形态（含 `且` / `或`、不同主语、混合运算符、字符串比较、变量阈值）v1 保序 ⇒ 原样可搬。
 */
function rulePoolOrderProblem(conditions: readonly string[]): string | null {
  const parsed = conditions.map((text) => thresholdCondition(text));
  if (parsed.some((item) => item === null)) return null;
  const items = parsed.map((item) => item!);
  const subjects = new Set(items.map((item) => item.subject));
  const operators = new Set(items.map((item) => item.op));
  if (subjects.size !== 1 || operators.size !== 1) return null;
  const op = items[0]!.op;
  const descending = op === '>=' || op === '>' || op === '至少' || op === '超过';
  const values = items.map((item) => item.threshold);
  const sorted = [...values].sort((a, b) => (descending ? b - a : a - b));
  if (values.every((value, i) => value === sorted[i])) return null;
  return `v1 会对同一主语的数值条件按阈值自动排序（${descending ? '严格条件在前' : '宽松条件在前'}），而书写顺序不是排序结果——先按排序口径重排，或改写条件形态后再迁移`;
}

/** `# 池` 分支正文白名单（§7.1：只许叙事 / 嵌套 `?` / 纯文本随机；禁止一切副作用） */
function poolBodyLineOk(text: string): boolean {
  const value = text.trim();
  if (value.length === 0) return true;
  if (value.startsWith('//')) return true;
  if (value.startsWith('?')) return true;
  if (value.startsWith('>')) return true;
  if (value === '空行' || value.startsWith('空行 ')) return true;
  if (value === '@随机' || value === '@组') return true;
  return isDialogueLine(value);
}

/** 2.0 台词行（`角色：「…」`，可带一个行尾表演提示组 / `续`）；正文可含引号（v1 引号是内容） */
function isDialogueLine(text: string): boolean {
  return /^\S+?：「.*」(?:\([^()]*\))?(?:\s+续)?$/u.test(text);
}

/**
 * v1 文件里与 2.0 台词同形的行（`X：「…」`，K2-MIGRATE-SHAPE）。
 *
 * 判据与机械层 `migrate/index.ts::parseDialogueShape` 同一入口。语义层遇到这种行**不解释**
 * （不把它当台词值塞进 `# 表` / `# 池`）：v1 里它是连前缀与引号一起打印的旁白文本，
 * 两种读法都说得通，猜错会静默改掉打印内容 ⇒ 整块交给机械层记 unsupported。
 */
function sameShapeDialogueLine(cls: Classified, body: string): boolean {
  return cls.kind.kind === 'kojo2' && parseDialogueShape(body) !== null;
}

/* ============================== 纯工具：文本 ------------------------------ */

/** 行首空白宽度（4 = 一级；TAB / 全角空格与迁移层同口径） */
function leadLevel(text: string): number {
  const lead = /^[ \t\u3000]*/.exec(text)![0]!;
  let width = 0;
  for (const ch of lead) width += ch === '\t' ? 4 : ch === '\u3000' ? 2 : 1;
  return Math.floor(width / 4);
}

function stripLead(text: string): string {
  return text.replace(/^[ \t\u3000]*/, '');
}

function isNameChar(ch: string): boolean {
  return ch.length > 0 && /[\p{L}\p{N}_]/u.test(ch);
}

/** 源文本里是否已出现这个标识符（生成声明名查重；词边界按 Unicode 字母 / 数字 / 下划线） */
function sourceMentionsName(source: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = source.indexOf(name, from);
    if (at < 0) return false;
    const before = at > 0 ? source[at - 1]! : '';
    const after = at + name.length < source.length ? source[at + name.length]! : '';
    if (!isNameChar(before) && !isNameChar(after)) return true;
    from = at + 1;
  }
}

/** 诊断回映到 v1 行（只回映行号：行级映射是契约底线，列级不承诺） */
function remapDiagnostic(diagnostic: KojoDiagnostic, toV1: (line: number) => number): KojoDiagnostic {
  const span = diagnostic.span;
  if (span === null) return diagnostic;
  const startLine = toV1(span.start.line);
  const endLine = toV1(span.end.line);
  if (startLine === span.start.line && endLine === span.end.line) return diagnostic;
  return {
    ...diagnostic,
    span: {
      start: { line: startLine, column: span.start.column },
      end: { line: endLine, column: span.end.column },
    },
  };
}

/** 台账回映到 v1 行（`line` = v1 1 基） */
function remapUnsupported(entry: MigrateUnsupported, toV1: (line: number) => number): MigrateUnsupported {
  const line = toV1(entry.line);
  return line === entry.line ? entry : { ...entry, line };
}
