/**
 * 三段式转译 · 第三段：codegen（AST → ERB 产物 + 行级源映射）。
 *
 * 硬约束（照抄规范 §5，不自由发挥）：
 * - 产物缩进统一 **TAB**（规范 §5.3：与语料一致）；
 * - 台词/旁白按 §5.1 算法选 `PRINTFORM` 变体；
 * - 纯条件行（整行只有一个条件插值且假分支为空）→ `IF` 块（§5.2 前置判定）；
 * - 随机块 `LOCAL:N` **每块独占、嵌套递增**（§5.4）；
 * - 表达式 `如果`/`当` 必须穷尽（`expr-missing-else` 由 AST 段拦下）；
 * - **可回放形态**：产物落在直线赋值 / IF 链 / SELECTCASE / CALL 子集内，
 *   能被 `condition-extractor` 解析。
 *
 * 生成器逐行 push 并同时记源映射——**不靠事后 diff 反推**（契约要求）。
 */

import type {
  AliasDecl,
  ChoiceBlock,
  ColorBlock,
  CustomCommandBlock,
  HeartLine,
  IfBlock,
  IfExpr,
  Interpolation,
  KojoFaceTable,
  KojoFaceTemplate,
  KojoInstructionTable,
  RandomBlock,
  RandomInline,
  RawFunctionBlock,
  RawLine,
  SugarDiagnostic,
  SugarFrontMatter,
  SugarNode,
  SugarSourceMapEntry,
  SugarTranspileOptions,
  TextLine,
  TimingBlock,
  WhenBlock,
  WhenBranch,
  WhenCaseValue,
  WhenExpr,
} from '@kojo/plugin-api';
import { lowerExpression, expandTarget, type ExprContext } from './expression';
import { checkTimingArgsDeclaration } from './lexer';
import { TIMING_ARGS_PARAM } from './keywords';
import type { TopNode } from './parser';
import type { AliasTable, DiagnosticSink, DictionaryLookup } from './types';

/* ============================== 输出缓冲 ============================== */

/** 函数头记号：产物第 1 列的 `@NAME`（带缩进的不是函数头） */
const FUNCTION_HEADER_RE = /^@([A-Za-z0-9_一-龥]+)$/;

/**
 * **生成**头的函数名（`@NAME` 或 `@NAME(ARG,ARG:1)`；规范 §3.2 `参数:` 声明）。
 * 撞名比对按**纯函数名**——声明了形参的时机若绕过比对，就等于把「重复定义」
 * 的检测口子按写法关掉了。原生直通块走 `FUNCTION_HEADER_RE`（块的写法归作者）。
 */
const GENERATED_HEADER_RE = /^@([A-Za-z0-9_一-龥]+)(?:\([^\s)]*\))?$/;

/** 一次函数定义（按产物行记账） */
interface FunctionDefinition {
  /** 产物行（1 基） */
  line: number;
  /** 对应源行（时机头 / 原生直通块可得；纯生成骨架为 null） */
  owner: number | null;
}

/** 撞名记录：同一文件里第二次出现的同名函数头 */
interface DuplicateDefinition {
  name: string;
  first: FunctionDefinition;
  again: FunctionDefinition;
}

/** 逐行产物缓冲（同时维护行级源映射） */
class Emitter {
  private readonly lines: string[] = [];
  private readonly map: SugarSourceMapEntry[] = [];
  private readonly definitions = new Map<string, FunctionDefinition>();
  private readonly duplicates: DuplicateDefinition[] = [];
  /**
   * 当前发射单元的源行（时机 / 原生块 / 三件套各设一次）。
   * 函数头本身是纯生成行、没有源行，撞名诊断要给作者一个**点对得开**的位置——
   * 由发射单元提供，而不是让每个 push 点多带一个参数。
   */
  private owner: number | null = null;

  setOwner(sourceLine: number | null): void {
    this.owner = sourceLine;
  }

  /** 追加一行（`sourceLine` = null → 纯生成行，如 `ENDIF` / 骨架） */
  push(indent: number, text: string, sourceLine: number | null = null): void {
    this.lines.push('\t'.repeat(indent) + text);
    this.map.push({ generatedLine: this.lines.length, sourceLine });
    // 生成头允许带 `参数:` 声明（`@NAME(ARG,ARG:1)`）——比对时剥掉声明，
    // 否则带形参的时机头**逃过**「重复定义」检测（旧正则只认裸 `@NAME`）。
    if (indent === 0) {
      const name = GENERATED_HEADER_RE.exec(text)?.[1];
      if (name) this.noteDefinition(name, sourceLine ?? this.owner);
    }
  }

  /** 追加一行但**不**记源映射（用于纯骨架行；等价于 sourceLine=null） */
  pushGenerated(indent: number, text: string): void {
    this.push(indent, text, null);
  }

  /** 追加空行 */
  blank(): void {
    this.lines.push('');
    this.map.push({ generatedLine: this.lines.length, sourceLine: null });
  }

  /** 原始行（原生直通块）：逐行透传，保留原缩进 */
  pushRaw(text: string, sourceLine: number | null): void {
    this.lines.push(text);
    this.map.push({ generatedLine: this.lines.length, sourceLine });
    if (/^@/.test(text)) {
      const m = FUNCTION_HEADER_RE.exec(text);
      if (m) this.noteDefinition(m[1]!, sourceLine ?? this.owner);
    }
  }

  /**
   * 函数头记账：同名第二次出现即记一条撞名（**跨分野也算**——
   * `指令 310 成否: …` 与独立的 `时机 成功 310：` 在写法面上看不出冲突，
   * 渲染出的却是同一个 `@…_SUCCESS_COM_K12_310`，引擎侧是「重复定义」）。
   *
   * `name` 是**纯函数名**（不含 `参数:` 声明段），由调用方按各自口径剥好：
   * 生成行走 `GENERATED_HEADER_RE`、原生块走 `FUNCTION_HEADER_RE`。
   */
  private noteDefinition(name: string, owner: number | null): void {
    const here: FunctionDefinition = { line: this.lines.length, owner };
    const first = this.definitions.get(name);
    if (!first) {
      this.definitions.set(name, here);
      return;
    }
    this.duplicates.push({ name, first, again: here });
  }

  duplicateDefinitions(): readonly DuplicateDefinition[] {
    return this.duplicates;
  }

  get length(): number {
    return this.lines.length;
  }

  result(): { erb: string; sourceMap: SugarSourceMapEntry[] } {
    // 产物末尾保留换行（规范 §8 编码自动化：文件末尾保留换行）
    const erb = this.lines.join('\n') + (this.lines.length > 0 ? '\n' : '');
    return { erb, sourceMap: this.map };
  }
}

/* ============================== codegen 上下文 ============================== */

export interface CodegenOptions {
  frontMatter: SugarFrontMatter;
  aliases: AliasTable;
  dictionary?: DictionaryLookup;
  /**
   * 时机分野模板表（game adapter 提供；游戏知识）。
   * **缺省 = 无法生成时机函数名** —— 转译器对含 `时机` 块的文档报
   * `timing-face-unknown`（fail-closed，不产半成品；见 `resolveFace`）。
   */
  faceTable?: KojoFaceTable;
  /**
   * 指令名表（adapter 提供；游戏知识）。
   * **HK-11②**：`时机 指令 <中文名>：` 里的中文名经本表查编号；查不到则报
   * `timing-instruction-unknown`（fail-closed，不产半成品）。数字路径不查表、
   * 逐字节保持旧行为。
   */
  instructionTable?: KojoInstructionTable;
  sink: DiagnosticSink;
  options: SugarTranspileOptions;
}

/** `LOCAL:N` 槽位分配器（规范 §5.4：每块独占、嵌套递增） */
class SlotAllocator {
  private next = 0;
  /** 进入嵌套块时保存当前游标（保证嵌套递增不冲突） */
  private stack: number[] = [];
  allocate(): number {
    const n = this.next;
    this.next++;
    return n;
  }
  enter(): void {
    this.stack.push(this.next);
  }
  exit(): void {
    const prev = this.stack.pop();
    if (prev !== undefined) this.next = prev;
  }
}

/** 每个时机独立一份分配器（`LOCAL:N` 在函数内作用域——时机即函数） */
export interface TimingContext {
  allocator: SlotAllocator;
  /** 该时机的产物行区间（用于 `RETURN 1` / `ENDIF` 的源映射） */
  line: number;
}

/* ============================== 主入口 ============================== */

export function codegen(
  topLevel: readonly TopNode[],
  opts: CodegenOptions,
): { erb: string; sourceMap: SugarSourceMapEntry[] } {
  const em = new Emitter();
  const fm = opts.frontMatter;
  const charNo = fm.charNo ?? '';
  const familySeg = familySegment(fm.family);

  // ---- 文件头注释（第 3 条：注释不能丢）----
  // 放在最前面：它们按源顺序出现在文件头（`角色:` 之前），常是整份口上的标题/出处，
  // 生成的三件套函数是**从头部声明派生**的，注释自然该在派生结果之前。
  for (const node of topLevel) {
    if (node.kind !== 'comment') continue;
    em.push(0, node.text, node.loc.start.line);
  }

  // ---- 头部：登记函数 + 开关（规范 §5.5 三件套之登记/开关）----
  emitRegistration(em, fm, charNo, familySeg, opts.faceTable, opts.sink);

  // ---- 时机块 ----
  const timings = topLevel.filter((n): n is TimingBlock => n.kind === 'timingBlock');
  for (const timing of timings) {
    if (em.length > 0) em.blank();
    em.setOwner(timing.loc.start.line); // 函数头是生成行，撞名诊断要能点回这个时机
    emitTiming(em, timing, {
      charNo,
      familySeg,
      frontMatter: fm,
      aliases: opts.aliases,
      dictionary: opts.dictionary,
      faceTable: opts.faceTable,
      instructionTable: opts.instructionTable,
      sink: opts.sink,
    });
  }

  // ---- 自定指令块（HK-12：NAME / ABLE / 本体 函数组）----
  // 编号分配需先扫全文档占号（原生 `@` 直通块 + 本文件已声明的显式编号），
  // 故在写盘前一次性收集，再逐个分配——保证同项目内不撞车（与真实语料命名对齐）。
  const customs = topLevel.filter((n): n is CustomCommandBlock => n.kind === 'custom-command');
  if (customs.length > 0) {
    const occupied = collectOccupiedCustomIndices(topLevel, charNo);
    const allocated = new Set<number>();
    for (const cc of customs) {
      if (em.length > 0) em.blank();
      em.setOwner(cc.loc.start.line);
      emitCustomCommand(em, cc, {
        charNo,
        familySeg,
        frontMatter: fm,
        aliases: opts.aliases,
        dictionary: opts.dictionary,
        sink: opts.sink,
        hooks: opts.faceTable?.customHooks,
        range: opts.faceTable?.customComRange,
        occupied,
        allocated,
      });
    }
  }

  // ---- 配色函数（规范 §5.5 三件套之配色；golden §6.1 排在全部时机之后）----
  if (charNo.length > 0 && fm.color) {
    if (em.length > 0) em.blank();
    em.setOwner(null); // 三件套派生自头部声明，不挂在任何一个时机上
    const colorTpl = opts.faceTable?.registration?.color;
    if (colorTpl) {
      em.pushGenerated(0, `@${renderSkeleton(colorTpl, charNo)}`);
      em.pushGenerated(0, `SETCOLOR ${fm.color}`);
    } else {
      // 该游戏无配色函数概念 → 显式告知（绝不静默丢弃）
      opts.sink.report({
        code: 'face-table-missing',
        severity: 'warning',
        message: '写了 `口上色:` 但当前适配器未声明配色函数模板——未生成配色函数。',
        loc: null,
      });
    }
  }

  // ---- 原生函数块（顶层 `@` 块）----
  const raws = topLevel.filter((n): n is RawFunctionBlock => n.kind === 'rawFunctionBlock');
  for (const raw of raws) {
    if (em.length > 0) em.blank();
    em.setOwner(raw.loc.start.line);
    for (const line of raw.lines) em.pushRaw(line, raw.loc.start.line);
  }

  // ---- 产物层撞名（写法面上看不出冲突、引擎侧却是「重复定义」）----
  for (const dup of em.duplicateDefinitions()) {
    const at = dup.again.owner ?? dup.first.owner ?? null;
    const cause =
      dup.name.includes('_SUCCESS_') || dup.name.includes('_FAILURE_')
        ? '常见成因：同一编号既写了 `成否:`，又写了独立的 `时机 成功/失败 …：`——两者渲染成同一个函数。'
        : '常见成因：同一编号的分野写了两次，或两种写法（中文子句与英文别名）落进了同一个模板。';
    opts.sink.report({
      code: 'function-name-duplicate',
      severity: 'error',
      message:
        `生成的函数 \`@${dup.name}\` 在本文件里定义了两次` +
        `（产物第 ${dup.first.line} 与第 ${dup.again.line} 行）——引擎会撞「重复定义」。${cause}`,
      loc: at !== null ? { line: at, column: 1 } : null,
    });
  }

  return em.result();
}

/* ============================== 三件套 ============================== */

/**
 * 登记 / 配色 / 开关三件套（规范 §5.5：**不带家族段**，只有 `K{角色号}`）。
 *
 * 函数名模板来自 **adapter 的 `KojoFaceTable.registration`**（游戏知识只进
 * adapter）——本函数只做"有内容才生成"的存在性判断与体内容拼装。
 *
 * - 登记函数（`declare`）：`口上:` / `显示名:` / `简介:` 有其一即生成
 *   （家族声明是"引擎存在判定"的前提）；
 * - 开关函数（`flagSetting`）：写了 `开关:` 时生成；
 * - 配色函数（`color`）：在 `codegen` 主入口统一处理（排在全部时机之后）。
 */
function emitRegistration(
  em: Emitter,
  fm: SugarFrontMatter,
  charNo: string,
  familySeg: string,
  faceTable: KojoFaceTable | undefined,
  sink: DiagnosticSink,
): void {
  if (charNo.length === 0) return;

  const declareTpl = faceTable?.registration?.declare;
  const flagTpl = faceTable?.registration?.flagSetting;

  // 登记函数只在**有内容可写**时生成（规范 §3.1：未声明的可选项，工具不生成
  // 对应函数——引擎侧自然回退）。`口上:` 省略 = 标准版 = RESULTS 保持为空，
  // 此时登记函数无内容可写，省略以保持产物最小。
  const hasRegistration =
    familySeg.length > 0 || Boolean(fm.displayName) || Boolean(fm.description);
  if (hasRegistration) {
    if (declareTpl) {
      em.pushGenerated(0, `@${renderSkeleton(declareTpl, charNo)}`);
      if (familySeg.length > 0) em.pushGenerated(0, `RESULTS = ${JSON.stringify(familySeg)}`);
      if (fm.displayName) em.pushGenerated(0, `RESULTS:1 = "${fm.displayName}"`);
      if (fm.description) em.pushGenerated(0, `RESULTS:2 = "${fm.description}"`);
    } else {
      sink.report({
        code: 'face-table-missing',
        severity: 'warning',
        message: '需要生成登记函数，但当前适配器未声明登记函数模板——已跳过（请检查适配器）。',
        loc: null,
      });
    }
  }

  // 开关函数
  if (fm.switches.length > 0) {
    if (em.length > 0) em.blank();
    if (flagTpl) {
      em.pushGenerated(0, `@${renderSkeleton(flagTpl, charNo)}`);
      for (const sw of fm.switches) {
        const on = sw.value === '是' || sw.value === 'true' || sw.value === '1';
        em.pushGenerated(0, `FLAG:${sw.name} = ${on ? 1 : 0}`);
      }
    } else {
      sink.report({
        code: 'face-table-missing',
        severity: 'warning',
        message: '写了 `开关:` 但当前适配器未声明开关函数模板——已跳过（请检查适配器）。',
        loc: fm.switches[0]?.loc.start ?? null,
      });
    }
  }
}

/**
 * 纯骨架模板求值（登记 / 配色 / 开关三件套用）：只替换 `{n}`（角色号）。
 * 三件套模板按规范 §5.5 不含家族段，故无需 `{t}` / `{i}`。
 */
function renderSkeleton(template: string, charNo: string): string {
  return template.replace(/\{n\}/g, charNo);
}

/** 家族段（规范 §5.5）：标准版 `""`；别人版 `"_" + 口上名` */
function familySegment(family?: string): string {
  if (!family || family.length === 0) return '';
  const name = family.startsWith('_') ? family.slice(1) : family;
  return `_${name}`;
}

/* ============================== 时机块 → 函数组 ============================== */

interface TimingEmitContext {
  charNo: string;
  familySeg: string;
  frontMatter: SugarFrontMatter;
  aliases: AliasTable;
  dictionary?: DictionaryLookup;
  /** 分野模板表（adapter 提供；缺省 → 无法生成时机函数名，fail-closed） */
  faceTable?: KojoFaceTable;
  /** 指令名表（adapter 提供；HK-11② 中文指令名 → 编号，缺省/查不到 → fail-closed） */
  instructionTable?: KojoInstructionTable;
  sink: DiagnosticSink;
}

function emitTiming(em: Emitter, timing: TimingBlock, ctx: TimingEmitContext): void {
  const face = resolveFace(timing.face, timing, ctx);
  if (!face) return;

  // HK-11②：编号解析（中文名 → 编号；查不到 fail-closed）——**在 resolveFace 之后**，
  // 三者（本体 / 成否 / MESSAGECHECK）共用同一个已验证的编号。
  const resolved = resolveTimingIndex(timing, ctx);
  if (!resolved.ok) return;
  const index = resolved.index;

  const baseName = buildFunctionName(face.template, ctx.familySeg, ctx.charNo, index, face.paramIndex);

  // ---- 成否判定函数（规范 §5.5：写了 `成否:` 时生成 SUCCESS 函数）----
  // 位协议目标与原语来自 adapter（`KojoFaceTable.successFlag`）；缺省 → 跳过
  // 并记 INFO（该游戏无成否位协议，非错误）。
  // ⚠ **不转发 `参数:`**：SUCCESS 是另一条调用面（分发器以 `TRYCCALLFORM` 无实参
  // 调用，见规范附录 C #13），真实语料的 `@…_SUCCESS_…` 头一律不带形参。
  // 保守口径：`参数:` 只作用于**本时机自己的主体两函数**，不外溢到伴生函数。
  const flagProto = ctx.faceTable?.successFlag;
  if (face.success && flagProto) {
    const successName = buildFunctionName(
      face.success.template,
      ctx.familySeg,
      ctx.charNo,
      index,
      face.success.paramIndex,
    );
    em.pushGenerated(0, `@${successName}`);
    em.pushGenerated(0, `${flagProto.target} = ${successFlag(timing, flagProto.values)}`);
    em.blank();
  }

  // ---- MESSAGECHECK 函数（写了 隐藏情景/隐藏口上 时）----
  // 同样**不带 `参数:` 声明**：MESSAGECHECK 由分发器以 `TRYCALLFORM …(RESULT)` 之类
  // 的自有协议调用，与本体形参无关（保守口径同上）。
  if (timing.messageCheck.length > 0) {
    emitMessageCheck(em, timing, ctx, index);
  }

  // ---- 主体两函数（规范 §5.5：包装 + `_1` 正文）----
  // `参数:` 声明（规范 §3.2，v1.5）→ **三个发射点**同带一份声明：包装头、
  // 包装体里转发给 `_1` 的 `CALL`、`_1` 头。少任何一处，引擎侧就出现
  // "调用面带实参、被调面未声明" 的形态——实测里这种实参被**静默丢弃**（ARG 读到 0）。
  const argsDecl = timingArgsDeclaration(timing);
  const declClause = argsDecl === null ? '' : `(${argsDecl})`;
  em.pushGenerated(0, `@${baseName}${declClause}`);
  em.pushGenerated(0, `CALL ${baseName}_1${declClause}`);
  em.pushGenerated(0, `RETURN RESULT`);
  em.blank();

  em.pushGenerated(0, `@${baseName}_1${declClause}`);
  em.pushGenerated(0, `;-------------------------------------------------`);
  em.pushGenerated(0, `;記入チェック（=0, 非表示、1, 表示）`);
  const empty = timing.body.length === 0;
  em.pushGenerated(0, `LOCAL = ${empty ? 0 : 1}`);
  em.pushGenerated(0, `;-------------------------------------------------`);

  if (!empty) {
    em.pushGenerated(0, `IF LOCAL`);
    const bodyIndent = 1;
    const bodyCtx: BodyContext = {
      aliases: ctx.aliases,
      dictionary: ctx.dictionary,
      sink: ctx.sink,
      frontMatter: ctx.frontMatter,
      allocator: new SlotAllocator(),
      baseIndent: bodyIndent,
    };
    for (const node of timing.body) {
      emitStatement(em, node, bodyCtx, bodyIndent);
    }
    em.pushGenerated(0, `ENDIF`);
  }

  em.pushGenerated(0, `RETURN 1`);
}

/**
 * 时机块头 `参数:` 的取值（规范 §3.2，v1.5）→ 形参声明串（`ARG,ARG:1`）；
 * 未声明 → `null`（产物与历史口径**逐字节一致**）。
 *
 * 取值非法（`参数: FOO` 一类）时 AST 段已报 error 并阻止落盘，这里**不重复诊断**，
 * 只按"未声明"处理——保证错误路径下也不会拼出半个非法函数头。
 */
function timingArgsDeclaration(timing: TimingBlock): string | null {
  const declared = timing.namedParams.find((p) => p.name === TIMING_ARGS_PARAM);
  if (!declared) return null;
  const checked = checkTimingArgsDeclaration(declared.value);
  return checked.ok ? checked.decl : null;
}

/**
 * 时机的分野解析（规范 §3.2 / §5.5 / 附录 C）——**查 adapter 的分野表**
 * （`KojoFaceTable.faces`；游戏知识只进 adapter，转译器只消费不解释）。
 *
 * 返回 null 时报 `timing-face-unknown` 并**不产出半成品**（规范 §5.3 精神：
 * 无法确定函数名时宁可拒绝）。适配器整体缺表时同样拒绝（记同一码），
 * 绝不回退到内建模板——回退就等于把游戏知识搬回通用插件。
 */
interface FaceResolution {
  /** 函数名模板：含 `{t}` / `{n}` / `{i}` 占位（求值见 `buildFunctionName`） */
  template: string;
  /** 是否把 `timing.index` 用作 `{i}`（模板含 `{i}` 时为真） */
  paramIndex: boolean;
  /** 成否函数模板（写了 `成否:` 时生成） */
  success?: { template: string; paramIndex: boolean };
}

function resolveFace(face: string, timing: TimingBlock, ctx: TimingEmitContext): FaceResolution | null {
  const key = face.trim();

  /** 无法识别的分野 → 统一诊断（含"适配器未提供分野表"的情形） */
  const unknown = (detail: string): null => {
    ctx.sink.report({
      code: 'timing-face-unknown',
      severity: 'error',
      message: `无法识别的时机分野「${key}」——${detail}`,
      loc: timing.loc.start,
    });
    return null;
  };

  const table = ctx.faceTable;
  if (!table) {
    return unknown('当前适配器未提供分野模板表（kojoFaceTemplates）。');
  }
  const spec: KojoFaceTemplate | undefined = table.faces[key];
  if (!spec) {
    return unknown('请使用规范 §3.2 的分野表（附录 C 列有完整入口）。');
  }

  // 上下文段求值：`${段名}` → 段文本（取值来自本时机的命名参数，映射表由
  // adapter 声明）。缺省段（无 `类型:` 等命名参数）→ 用段的第一个候选值，
  // 与规范 §3.2「`类型:` 默认 COM」一致。
  const segments: Record<string, string> = {};
  for (const [segName, candidates] of Object.entries(spec.segments ?? {})) {
    const paramName = segmentParamName(segName);
    const declared = paramName ? timing.namedParams.find((p) => p.name === paramName)?.value : undefined;
    const keys = Object.keys(candidates);
    // 取值优先 `类型:` 声明；未声明时用第一个候选（adapter 保证默认值在首位）
    const chosen = declared !== undefined && candidates[declared] !== undefined ? declared : keys[0];
    if (chosen !== undefined) segments[segName] = candidates[chosen]!;
  }

  const template = applySegments(spec.template, segments);
  const successTpl = hasSuccessNamed(timing)
    ? { template: applySegments(spec.success?.template ?? template, segments), paramIndex: true }
    : undefined;

  return {
    template,
    paramIndex: template.includes('{i}'),
    // `成功` 划分野自身即 SUCCESS 函数（避免重复生成同名函数）——由 adapter
    // 在表里把 `success` 留空表达（见 face-templates.ts 的 `成功` 条目）。
    success: successTpl,
  };
}

/**
 * 上下文段名 → 命名参数名（当前唯一映射：`com` ← `类型:`）。
 * 新增段时在此登记；adapter 只声明段与其取值候选，不声明命名参数名
 * （那是**语法层**语义，属跨游戏语言层，不属 adapter）。
 *
 * 导出给**反糖**（`faces-reverse.ts`）共用：正向写糖与反向读糖必须认同一个命名参数名，
 * 否则投影出来的标签作者读不出、也写不回。
 */
export function segmentParamName(segName: string): string | undefined {
  if (segName === 'com') return '类型';
  return undefined;
}

/** 把模板里的 `${段名}` 替换为段文本（未命中的段保持原样，便于诊断） */
function applySegments(template: string, segments: Record<string, string>): string {
  return template.replace(/\$\{([^}]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(segments, name) ? segments[name]! : whole,
  );
}

function hasSuccessNamed(timing: TimingBlock): boolean {
  return timing.namedParams.some((p) => p.name === '成否');
}

/** `成否:` 取值 → 适配器位协议目标变量的值（规范 §3.2 表；默认 `游戏判定` = 0） */
function successFlag(timing: TimingBlock, values?: Readonly<Record<string, number>>): number {
  const p = timing.namedParams.find((x) => x.name === '成否');
  const v = p?.value;
  // 未写 `成否:` 或写默认值 `游戏判定` → 适配器映射表的默认项（eraTW = 0，
  // 与引擎兜底 `TFLAG:192 = 0` 等价，见规范 §3.2 命名参数表注）。
  const map = values ?? {};
  if (v !== undefined && map[v] !== undefined) return map[v]!;
  return map['游戏判定'] ?? 0;
}

/**
 * 函数名拼接（规范 §5.5，严格复刻分发器）：
 * `函数名 = "M_KOJO" + 家族段 + "_" + 分野段 + "_K" + 角色号 + ["_" + 编号]`
 *
 * 模板里的 `{t}` = 家族段（含前导下划线或空串）；`{n}` = 角色号；`{i}` = 编号。
 * **`M_KOJO` 与 `分野段` 之间那一个下划线由公式提供**，不由家族段提供——
 * 模板由 adapter 声明（`KojoFaceTable.faces[*].template`），本函数只做占位符
 * 求值，**不含任何游戏字面量**。
 */
export function buildFunctionName(
  template: string,
  familySeg: string,
  charNo: string,
  index: string | undefined,
  paramIndex: boolean,
): string {
  let name = template.replace('{t}', familySeg).replace('{n}', charNo);
  if (paramIndex && index !== undefined && index.length > 0) {
    name = name.replace('{i}', index);
  } else {
    // 无编号的分野：去掉 `_{i}` 段
    name = name.replace(/_(?:\{i\})/g, '').replace(/\{i\}/g, '').trim();
    if (name.endsWith('_')) name = name.slice(0, -1);
  }
  return name;
}

/**
 * MESSAGECHECK 函数（规范 §3.2：`SETBIT RESULT, 0/1`）。
 *
 * 函数名模板 / 作用域段 / 位号 / 置位原语**全部来自 adapter**
 * （`KojoFaceTable.messageCheck`）；缺省 → 记 INFO 并跳过（该游戏无此概念）。
 */
function emitMessageCheck(
  em: Emitter,
  timing: TimingBlock,
  ctx: TimingEmitContext,
  index: string | undefined,
): void {
  const proto = ctx.faceTable?.messageCheck;
  if (!proto) {
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'warning',
      message: '写了 `隐藏情景:` / `隐藏口上:`，但当前适配器未声明 MESSAGECHECK 位协议——已跳过。',
      loc: timing.messageCheck[0]?.loc.start ?? null,
    });
    return;
  }
  const base = resolveFaceNameForMessageCheck(timing, ctx, index);
  if (!base) return;
  for (const mc of timing.messageCheck) {
    const scopeSeg = proto.scopes[mc.scope];
    const bit = proto.bits[mc.scope];
    if (scopeSeg === undefined || bit === undefined) {
      ctx.sink.report({
        code: 'face-table-missing',
        severity: 'warning',
        message: `适配器的 MESSAGECHECK 协议未声明作用域「${mc.scope}」的段/位号——已跳过该条。`,
        loc: mc.loc.start,
      });
      continue;
    }
    const fnName = buildFunctionName(
      proto.template
        .replace(/\{base\}/g, base)
        .replace(/\{scope\}/g, scopeSeg),
      ctx.familySeg,
      ctx.charNo,
      index,
      true, // 模板含 `{i}`：有编号时消费、无编号时由 buildFunctionName 归一去掉
    );
    const exprCtx: ExprContext = {
      aliases: ctx.aliases,
      dictionary: ctx.dictionary,
      report: (d) => ctx.sink.report(d),
      loc: mc.loc.start,
    };
    em.pushGenerated(0, `@${fnName}`);
    em.pushGenerated(0, `IF ${lowerExpression(mc.condition, exprCtx)}`);
    em.pushGenerated(0, (proto.setBit ?? 'SETBIT RESULT, {bit}').replace(/\{bit\}/g, String(bit)));
    em.pushGenerated(0, `ENDIF`);
    em.blank();
  }
}

function resolveFaceNameForMessageCheck(
  timing: TimingBlock,
  ctx: TimingEmitContext,
  index: string | undefined,
): string | null {
  const face = resolveFace(timing.face, timing, ctx);
  if (!face) return null;
  return buildFunctionName(face.template, ctx.familySeg, ctx.charNo, index, face.paramIndex);
}

/* ============================== HK-11②：指令编号解析 ============================== */

interface IndexResolution {
  ok: boolean;
  /** 已解析的编号字符串（数字原文，或中文名经表查得的编号） */
  index?: string;
}

/**
 * 时机编号解析（HK-11②）——**数字路径不查表**（旧写法 `时机 指令 310：` 逐字节不破，
 * 也不新增诊断）；**中文名路径**经 adapter 指令表查编号，**查不到 fail-closed**
 * （报 `timing-instruction-unknown`，措辞含「未命名指令（编号 N）」，绝不猜、
 * 不产半成品——规范 §5.3 精神）。
 */
function resolveTimingIndex(timing: TimingBlock, ctx: TimingEmitContext): IndexResolution {
  const name = timing.indexName;
  if (name === undefined) return { ok: true, index: timing.index };

  const no = ctx.instructionTable?.lookupByName(name);
  if (no === undefined) {
    const shown = timing.index ?? name;
    ctx.sink.report({
      code: 'timing-instruction-unknown',
      severity: 'error',
      message:
        `未命名指令（编号 ${shown}）：「${name}」不在当前工程的指令表里（CSV/Train.csv）。` +
        '为避免拼出指向错误函数的产物，已停止编译本时机——请改用数字编号（`时机 指令 310：`），' +
        '或让该指令名出现在当前项目的 Train.csv 里（换汉化/魔改包即换表）。',
      loc: timing.loc.start,
    });
    return { ok: false };
  }
  return { ok: true, index: String(no) };
}

/* ============================== HK-12：自定指令块 → 函数组 ============================== */

interface CustomEmitContext {
  charNo: string;
  familySeg: string;
  frontMatter: SugarFrontMatter;
  aliases: AliasTable;
  dictionary?: DictionaryLookup;
  sink: DiagnosticSink;
  /** 自定钩子模板（adapter；缺 comName/comAble/com 任一 → 跳过并告警） */
  hooks?: KojoFaceTable['customHooks'];
  /** 编号自动分配可用段（adapter；缺省且未显式写 `编号:` → fail-closed） */
  range?: { min: number; max: number };
  /** 全文档占号集合（原生 `@` 直通块 + 显式 `编号:`），分配时排除 */
  occupied: Set<number>;
  /** 本次 codegen 已自动分配的编号（防同批自撞车） */
  allocated: Set<number>;
}

/**
 * 收集"已被占用"的自定指令编号：
 * - 原生直通块（`@` 块）里手写的自定指令函数头（`KOJO…_COM…_K{角色}_{编号}`）；
 * - 本文件里显式写了 `编号: N` 的自定指令块。
 *
 * 判据刻意收窄：只认**自定指令族**（`KOJO…` 且含 `_COM`），**排除**
 * `M_KOJO_MESSAGE_COM_K…`（那是消息函数，不是自定钩子）——否则把语言时机
 * 的编号也算进来会让分配凭空跳号。跨**项目**（别的 `.ERB` 文件）的占号不在本
 * 转译器可见范围（转译是纯函数、只看单文件），由函数树视图侧统一汇总。
 */
function collectOccupiedCustomIndices(topLevel: readonly TopNode[], charNo: string): Set<number> {
  const occupied = new Set<number>();
  const headerRe = /^@(.+)_K(\d+)_(\d+)$/;
  for (const node of topLevel) {
    if (node.kind === 'rawFunctionBlock') {
      for (const line of node.lines) {
        const m = headerRe.exec(line.trim());
        if (!m) continue;
        if (m[2] !== charNo) continue;
        const base = m[1]!;
        if (!/^KOJO/.test(base) || !/_COM/.test(base)) continue;
        occupied.add(Number(m[3]));
      }
    } else if (node.kind === 'custom-command' && node.index !== undefined) {
      occupied.add(node.index);
    }
  }
  return occupied;
}

/** 在 `[min, max]` 内取**最小未用**编号（排除 occupied ∪ allocated）；无空位 → undefined */
function allocateCustomIndex(
  range: { min: number; max: number },
  occupied: Set<number>,
  allocated: Set<number>,
): number | undefined {
  for (let no = range.min; no <= range.max; no++) {
    if (!occupied.has(no) && !allocated.has(no)) return no;
  }
  return undefined;
}

/**
 * 自定钩子函数名求值：`{t}`=家族段、`{n}`=角色号、`{i}`=编号。
 *
 * 附录 C 的 NAME/ABLE/本体三模板是裸写（`KOJO{t}_COM_NAME`），**不含** `_K{n}_{编号}`
 * 后缀；而真实语料函数名带该后缀（`KOJO_少女之梦_COM_NAME_K1_0`）⇒ 缺 `{n}` 时补齐
 * `_K{角色号}_{编号}`（标准版 → `KOJO_COM_NAME_K{角色号}_{编号}`）。模板自带 `{n}`
 * 的（如 `comCounter`）不追加。
 */
function renderCustomHook(template: string, familySeg: string, charNo: string, no: number): string {
  let name = template.replace(/\{t\}/g, familySeg).replace(/\{n\}/g, charNo).replace(/\{i\}/g, String(no));
  if (!template.includes('{n}')) name += `_K${charNo}_${no}`;
  return name;
}

/**
 * 自定指令块（HK-12）→ 「NAME / ABLE / 本体」函数组。
 *
 * - **编号**：显式 `编号: N` 优先；缺省在 `customComRange` 内取最小未用（防撞车）。
 *   分配只依赖「占号集合」，故**改名不改号**（同一占号下重跑仍是同一编号）;
 * - **NAME**：`RESULTS = <中文名>`（不带引号——对齐真实语料 `RESULTS = 赛钱`）；
 * - **ABLE**：契约无 ABLE 子句 ⇒ 缺省放行 `RETURN 1`（对齐语料 `_COM_ABLE` 缺省形态）；
 * - **本体**：与时机块同款"記入チェック"骨架（`LOCAL = 0/1` + `IF LOCAL … ENDIF` + `RETURN 1`）；
 * - **fail-closed**：缺可用段 / 段耗尽 / 缺钩子模板 → 报诊断、**不产半成品**。
 *
 * 关于"可选钩子按需"：`可否使用:`（canCom）/ `计数器不发:`（comCounter）为本批新增的
 * **块头可选子句**（HK-12 五钩子，附录 C #34）。值为**条件**，产物走 adapter 的
 * `customHooks` 模板块；**缺省不生成**（与既有 `success?` 同口径）。
 */
function emitCustomCommand(em: Emitter, node: CustomCommandBlock, ctx: CustomEmitContext): void {
  // ---- 编号：显式优先，否则自动分配 ----
  let no: number;
  if (node.index !== undefined) {
    no = node.index;
  } else {
    if (ctx.range === undefined) {
      ctx.sink.report({
        code: 'custom-command-no-range',
        severity: 'error',
        message:
          `「自定指令 ${node.name}：」未写 \`编号:\`，且当前适配器未声明编号可用段（customComRange）——` +
          '无法自动分配编号，已停止编译本块（不产半成品）。请显式写 `编号: N`，或让适配器声明可用段。',
        loc: node.loc.start,
      });
      return;
    }
    const picked = allocateCustomIndex(ctx.range, ctx.occupied, ctx.allocated);
    if (picked === undefined) {
      ctx.sink.report({
        code: 'custom-command-range-exhausted',
        severity: 'error',
        message:
          `「自定指令 ${node.name}：」自动分配编号失败——可用段 ${ctx.range.min}–${ctx.range.max} 已被占满。` +
          '请显式写 `编号: N` 改到别的编号，或先删掉不再用的自定指令。',
        loc: node.loc.start,
      });
      return;
    }
    no = picked;
  }

  const hooks = ctx.hooks;
  if (!hooks || !hooks.comName || !hooks.comAble || !hooks.com) {
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'warning',
      message:
        `写了「自定指令 ${node.name}：」但当前适配器未声明自定指令钩子模板（comName / comAble / com）——已跳过。`,
      loc: node.loc.start,
    });
    return;
  }
  ctx.allocated.add(no);

  const comName = renderCustomHook(hooks.comName, ctx.familySeg, ctx.charNo, no);
  const comAble = renderCustomHook(hooks.comAble, ctx.familySeg, ctx.charNo, no);
  const com = renderCustomHook(hooks.com, ctx.familySeg, ctx.charNo, no);

  // ---- NAME：显示名（`RESULTS = <中文名>`，不带引号）----
  em.pushGenerated(0, `@${comName}`);
  em.pushGenerated(0, `RESULTS = ${node.name}`);
  em.blank();

  // ---- ABLE：可否使用（契约无 ABLE 子句 ⇒ 缺省放行）----
  em.pushGenerated(0, `@${comAble}`);
  em.pushGenerated(0, `RETURN 1`);
  em.blank();

  // ---- 可选钩子（HK-12 五钩子之 CAN_COM / COM_Counter不发）：**缺省不生成** ----
  // 与既有 `success?` 同口径：写了子句才产对应函数（引擎侧无该函数 → 自然回退）。
  // 值为**条件**，产物 = 「条件成立则 RETURN 1，否则 RETURN 0」的门（对齐语料
  // `KOJO_COM_Counter不发_K75_0` 的 `RETURN 1` 抑制语义 / `CAN_COM` 的 RESULT==0 拦截）。
  emitCustomHook(em, node.name, node.canCom, 'canCom', hooks.canCom, ctx, no);
  emitCustomHook(em, node.name, node.comCounter, 'comCounter', hooks.comCounter, ctx, no);

  // ---- 本体：与时机块同款骨架（空体 → `LOCAL = 0` 且不产 IF 块）----
  em.pushGenerated(0, `@${com}`);
  em.pushGenerated(0, `;-------------------------------------------------`);
  em.pushGenerated(0, `;記入チェック（=0, 非表示、1, 表示）`);
  const empty = node.body.length === 0;
  em.pushGenerated(0, `LOCAL = ${empty ? 0 : 1}`);
  em.pushGenerated(0, `;-------------------------------------------------`);
  if (!empty) {
    em.pushGenerated(0, `IF LOCAL`);
    const bodyIndent = 1;
    const bodyCtx: BodyContext = {
      aliases: ctx.aliases,
      dictionary: ctx.dictionary,
      sink: ctx.sink,
      frontMatter: ctx.frontMatter,
      allocator: new SlotAllocator(),
      baseIndent: bodyIndent,
    };
    for (const child of node.body) emitStatement(em, child, bodyCtx, bodyIndent);
    em.pushGenerated(0, `ENDIF`);
  }
  em.pushGenerated(0, `RETURN 1`);
}

/**
 * 自定指令可选钩子（HK-12 五钩子；附录 C #34 `_CAN_COM` / `_COM_Counter不发`）。
 *
 * - `condition` 缺省（未写子句）→ **不生成**（缺省不生成，引擎自然回退）；
 * - 写了子句但 adapter 未声明对应模板 → `face-table-missing` warning 并跳过（fail-closed）；
 * - 产物 = 「条件成立则 `RETURN 1`，否则 `RETURN 0`」的门；条件经表达式降糖（与正文同口径）。
 */
function emitCustomHook(
  em: Emitter,
  commandName: string,
  condition: string | undefined,
  clause: string,
  template: string | undefined,
  ctx: CustomEmitContext,
  no: number,
): void {
  if (condition === undefined) return;
  if (!template) {
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'warning',
      message:
        `写了「自定指令 ${commandName}：」的 \`${clause}:\` 子句，但当前适配器未声明对应钩子模板——已跳过该钩子。`,
      loc: null,
    });
    return;
  }
  const hookName = renderCustomHook(template, ctx.familySeg, ctx.charNo, no);
  const cond = lowerExpression(condition, {
    aliases: ctx.aliases,
    dictionary: ctx.dictionary,
    report: (d) => ctx.sink.report(d),
    loc: null,
  });
  em.pushGenerated(0, `@${hookName}`);
  em.pushGenerated(0, `IF ${cond}`);
  em.pushGenerated(0, `RETURN 1`);
  em.pushGenerated(0, `ENDIF`);
  em.pushGenerated(0, `RETURN 0`);
  em.blank();
}

/* ============================== 语句 → 产物 ============================== */

interface BodyContext {
  aliases: AliasTable;
  dictionary?: DictionaryLookup;
  sink: DiagnosticSink;
  frontMatter: SugarFrontMatter;
  allocator: SlotAllocator;
  baseIndent: number;
}

function emitStatement(em: Emitter, node: SugarNode, ctx: BodyContext, indent: number): void {
  switch (node.kind) {
    case 'textLine':
      emitTextLine(em, node, ctx, indent, false);
      break;
    case 'heartLine':
      emitTextLine(em, node, ctx, indent, true);
      break;
    case 'ifBlock':
      emitIfBlock(em, node, ctx, indent);
      break;
    case 'whenBlock':
      emitWhenBlock(em, node, ctx, indent);
      break;
    case 'randomBlock':
      emitRandomBlock(em, node, ctx, indent);
      break;
    case 'randomInline':
      emitRandomInline(em, node, ctx, indent);
      break;
    case 'choiceBlock':
      emitChoiceBlock(em, node, ctx, indent);
      break;
    case 'colorBlock':
      emitColorBlock(em, node, ctx, indent);
      break;
    case 'rawLine':
      emitRawLine(em, node, ctx, indent);
      break;
    case 'comment':
      // 注释原样落进产物（第 3 条：注释不能丢）。缩进跟着所在层级走——产物里的
      // 注释在 ERB 里是惰性的，缩进只影响可读性，但"和代码同层"才看得出它属于谁。
      em.push(indent, node.text, node.loc.start.line);
      break;
    case 'rawFunctionBlock':
      for (const line of node.lines) em.pushRaw(line, node.loc.start.line);
      break;
    case 'ifExpr':
      emitIfExpr(em, node, ctx, indent);
      break;
    case 'whenExpr':
      emitWhenExpr(em, node, ctx, indent);
      break;
    default:
      // aliasDecl / timingBlock 不该出现在块体（AST 段已保证）
      break;
  }
}

/* ------------------------------ 原生直通行 / 语句赋值 ------------------------------ */

/**
 * `rawLine` 两种来源：
 * - **语句赋值** `X = 表达式`（parser 挂了 `_assign` 标记）→ 左值按 §5.0 展开
 *   （只读别名报 `readonly-alias-assignment` 并中止该行），右值走表达式降糖；
 * - **原生直通行**（全大写指令 / `$标签`）→ 原样透传，不降糖（规范 §3.10）。
 */
function emitRawLine(
  em: Emitter,
  node: Extract<SugarNode, { kind: 'rawLine' }>,
  ctx: BodyContext,
  indent: number,
): void {
  const assign = (node as { _assign?: { target: string; expr: string } })._assign;
  if (!assign) {
    em.push(indent, node.text, node.loc.start.line);
    return;
  }
  const target = expandTarget(assign.target, exprCtx(ctx, node.loc.start));
  if (target === null) return; // 只读别名：已在 expandTarget 报诊断，不产出半成品
  const value = lowerExpression(assign.expr, exprCtx(ctx, node.loc.start));
  em.push(indent, `${target} = ${value}`, node.loc.start.line);
}

/* ------------------------------ 文本行 / 心形（§5.1 / §5.2 / §3.9） ------------------------------ */

function emitTextLine(em: Emitter, node: TextLine | HeartLine, ctx: BodyContext, indent: number, heart: boolean): void {
  const sourceLine = node.loc.start.line;

  // ---- §5.2 第 0 步（前置判定）：纯条件行 → IF 块 ----
  const pure = pureConditionalBody(node, ctx);
  if (pure) {
    const cond = lowerExpression(pure.condText, exprCtx(ctx, pure.condLoc));
    em.push(indent, `IF ${cond}`, sourceLine);
    const inner = pure.thenText;
    const speech = detectSpeechText(inner);
    if (heart) {
      em.push(indent + 1, heartCall(inner, speech, node.wait), sourceLine);
    } else {
      em.push(indent + 1, printLine(inner, speech, node.wait, ctx), sourceLine);
    }
    em.push(indent + 1 - 1, `ENDIF`, null);
    return;
  }

  // ---- 常规：整行文本体转译 ----
  const body = textBody(node, ctx);
  if (heart) {
    em.push(indent, heartCall(body.raw, node.speech, node.wait), sourceLine);
  } else {
    em.push(indent, printLine(body.raw, node.speech, node.wait, ctx), sourceLine);
  }
}

/**
 * 纯条件行判定（规范 §5.2 第 0 步）：
 * 整行**除空白与注释外**恰含一个条件插值，且假分支为空/省略。
 */
function pureConditionalBody(
  node: TextLine | HeartLine,
  ctx: BodyContext,
): { condText: string; thenText: string; condLoc: { line: number; column: number } } | null {
  if (node.interpolations.length !== 1) return null;
  const only = node.interpolations[0]!;
  if (only.form !== 'cond') return null;
  if (only.elseText !== undefined && only.elseText.length > 0) return null;

  // 整行除该插值外只能是空白
  const it = only.loc;
  if (it.start.line !== it.end.line) return null;
  const raw = rawLineOf(node, ctx);
  const before = raw.slice(0, it.start.column - 1);
  const after = raw.slice(it.end.column - 1);
  if (before.trim().length > 0 || after.trim().length > 0) return null;
  return {
    condText: only.condText ?? '',
    thenText: only.thenText ?? '',
    condLoc: it.start,
  };
}

/** 重建文本行原文（契约：`text` 未存储剥离插值后的字面片段，按 `loc` 从源切片） */
function rawLineOf(node: TextLine | HeartLine, _ctx: BodyContext): string {
  // 源文本按 loc 切片由 emitter 的调用方保证；此处用节点自带的 `_raw`（见 parser 注入）
  return (node as TextLine & { _raw?: string })._raw ?? '';
}

/** 取该行重建的文本（含插值原文）——由 parser 在 `loc` 上附带 */
function sourceTextOf(node: TextLine | HeartLine): string {
  return (node as TextLine & { _raw?: string })._raw ?? '';
}

/**
 * 常规文本体转译（规范 §5.2）。
 * 逐字符扫描：插值 → 分支；落单 `%` → 告警；其它原样。
 */
function textBody(node: TextLine | HeartLine, ctx: BodyContext): { raw: string } {
  const source = sourceTextOf(node);
  const interps = [...node.interpolations].sort((a, b) => a.loc.start.column - b.loc.start.column);
  let out = '';
  let cursor = 0;
  for (const it of interps) {
    if (it.loc.start.line !== it.loc.end.line) continue;
    out += source.slice(cursor, it.loc.start.column - 1);
    out += renderInterpolation(it, ctx);
    cursor = it.loc.end.column - 1;
  }
  out += source.slice(cursor);
  out = scanStrayPercent(out, node, ctx);
  return { raw: out };
}

/** 插值 → FORM 片段（规范 §3.4 表） */
function renderInterpolation(it: Interpolation, ctx: BodyContext): string {
  if (it.form === 'cond') {
    const cond = lowerExpression(it.condText ?? '', exprCtx(ctx, it.loc.start));
    const thenText = expandFragment(it.thenText ?? '', ctx, it.loc.start);
    const elseText = it.elseText !== undefined ? expandFragment(it.elseText, ctx, it.loc.start) : undefined;
    if (elseText === undefined || elseText.length === 0) return `\\@${cond}?${thenText}\\@`;
    return `\\@${cond}?${thenText}#${elseText}\\@`;
  }
  // expr 形态：字符串族 → `%…%`；数值族 → `{…}`
  const text = it.text;
  const lowered = lowerExpression(text, exprCtx(ctx, it.loc.start));
  // 字符串**字面量别名**展开（`别名 昵称 = "小露"` → `{昵称}`）：lowered 是带引号的
  // 字符串字面量，它要**原样嵌进 FORM 文本**（不包 `{}`——`{"小露"}` 不是合法 FORM，
  // 包成 `{小露}` 更错：FORM 会把小露当变量名求值）。只认"整支恰是一个带引号字面量"，
  // 与 project.ts 属性反糖的整支判据同款口径。
  const lit = /^"([^"\\]*)"$/.exec(lowered.trim());
  if (lit) return lit[1]!;
  return classifyInterpolation(text, lowered, ctx);
}

/**
 * 值插值沉降（规范 §3.4 表 / §5.2 b-c）：
 * - 命中**字符串族**（`CALLNAME` 等）→ `%表达式%`；
 * - 否则（数值表达式）→ `{表达式}`。
 *
 * 判定依据：原文本身是代词（`她`/`你`）或被降糖为 `%CALLNAME:…%` → 字符串族；
 * 变量族由字典提供"哪些族是字符串族"（`CALLNAME` / `NAME` / `CALLNAME` 系）。
 */
function classifyInterpolation(original: string, lowered: string, ctx: BodyContext): string {
  if (lowered.startsWith('%') && lowered.endsWith('%')) return lowered;
  if (/^(她|你)$/.test(original.trim())) return lowered; // 已含 `%…%`
  // 变量族判定：直接从**已降糖**的表达式取族名（`CALLNAME:TARGET:名字` → `CALLNAME`），
  // 比拿原文（含 `她的`/`你的` 前缀）再去查字典更稳。
  const head = lowered.split(/[:(]/)[0]!.trim().toUpperCase();
  if (STRING_FAMILIES.has(head)) return `%${lowered}%`;
  // 原文本身是族名（`CALLNAME:12` 之类原生写法）——同样按族判定
  const family = ctx.dictionary?.resolveFamily(original.trim());
  if (family && STRING_FAMILIES.has(family.toUpperCase())) {
    return `%${lowered}%`;
  }
  return `{${lowered}}`;
}

/** 字符串族（规范 §3.4：`CALLNAME` 等）——引擎级语言知识，非游戏知识 */
const STRING_FAMILIES = new Set(['CALLNAME', 'NAME', 'CALLNAME_MASTER', 'STR', 'STR:']);

/** 行内条件的分支片段：字面量原样、插值再降糖（规范 §5.2 a） */
function expandFragment(fragment: string, ctx: BodyContext, loc: { line: number; column: number }): string {
  // 分支是 **FORM 字面量片段**（规范 §3.4："字面量原样"）——整段当代码降糖会把
  // 中文散文逐词报成 `unknown-identifier`（真实语料：分支里就是人话），也会把碰巧
  // 与变量同名的汉字静默改写。故只降糖 `%…%` 内的原生表达式（真实语料
  // `\@…?%CALLNAME:MASTER%#…\@` 的写法），其余一律原样。
  return fragment.replace(
    /%([^%]+)%/g,
    (whole, inner: string) => `%${lowerExpression(inner, exprCtx(ctx, loc))}%`,
  );
}

/** 落单 `%` 检测（规范 §3.3 / §5.2：FORM 串里 `%…%` 是变量记号） */
function scanStrayPercent(text: string, node: TextLine | HeartLine, ctx: BodyContext): string {
  const indices = [...text.matchAll(/%/g)].map((m) => m.index ?? 0);
  if (indices.length % 2 === 1) {
    ctx.sink.report({
      code: 'stray-percent',
      severity: 'warning',
      message: '文本里出现落单的半角 `%`——FORM 字符串里 `%…%` 是变量记号，落单会被引擎吞掉后面的内容；如需输出字面百分号请写成 `％`（全角）。',
      loc: node.loc.start,
    });
  }
  return text;
}

/** 判定文本（已是 FORM 片段）是否台词（规范 §5.1 第 2 步） */
function detectSpeechText(text: string): boolean {
  const first = text.replace(/^[\s\u3000]+/, '')[0];
  return first === '「' || first === '｢';
}

/**
 * `PRINTFORM` 变体选择（规范 §5.1，逐条照抄）：
 * ```
 * d    = (旁白色 == 默认) 且 (not speech)
 * 后缀 = (d ? "D" : "") + (wait ? "W" : "L")
 * ```
 */
function printLine(text: string, speech: boolean, wait: boolean, ctx: BodyContext): string {
  const narrationDefault = (ctx.frontMatter.narrationColor ?? '默认') === '默认';
  const d = narrationDefault && !speech;
  const suffix = (d ? 'D' : '') + (wait ? 'W' : 'L');
  // **空文本体**（`空行`，规范 §3.3 / 批 P）不留尾随空格：语料里打空行的写法就是裸指令
  // （`PRINTFORMW` / `PRINTL`），多一个空格是平白给 diff 与逐字节自证添噪。
  return text.length === 0 ? `PRINTFORM${suffix}` : `PRINTFORM${suffix} ${text}`;
}

/**
 * 心形（规范 §3.9 / §5.1）：`CALL HPH_PRINT(@"…", "<mode>")`。
 *
 * - **引号剥离**：§3.9 的示例 `心形 「……嗯。」` → `CALL HPH_PRINT(@"……嗯。","w")`，
 *   即台词引号不进入 `@""` 字面量；
 * - 模式字母由与文本行完全相同的规则决定：`w` / `l` / `dw` / `dl`。
 */
function heartCall(text: string, speech: boolean, wait: boolean): string {
  const d = !speech; // 心形沿用"旁白走 D 系"的同构规则（w/l ↔ dw/dl）
  const mode = (d ? 'd' : '') + (wait ? 'w' : 'l');
  const inner = speech ? stripQuotesForHeart(text) : text;
  return `CALL HPH_PRINT(@"${inner}","${mode}")`;
}

/** 剥离台词引号（`「…」` / `｢…｣` / `"…"`）——仅心形使用 */
function stripQuotesForHeart(text: string): string {
  const t = text.trim();
  if ((t.startsWith('「') && t.endsWith('」')) || (t.startsWith('｢') && t.endsWith('｣'))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return text;
}

/* ------------------------------ 如果块（§3.5） ------------------------------ */

function emitIfBlock(em: Emitter, node: IfBlock, ctx: BodyContext, indent: number): void {
  for (const branch of node.branches) {
    if (branch.kind === 'if') {
      const cond = lowerExpression(branch.condition, exprCtx(ctx, branch.loc.start));
      em.push(indent, `IF ${cond}`, branch.loc.start.line);
    } else if (branch.kind === 'elseif') {
      const cond = lowerExpression(branch.condition, exprCtx(ctx, branch.loc.start));
      em.push(indent, `ELSEIF ${cond}`, branch.loc.start.line);
    } else {
      em.push(indent, `ELSE`, branch.loc.start.line);
    }
    for (const child of branch.body) emitStatement(em, child, ctx, indent + 1);
  }
  em.push(indent, `ENDIF`, null);
}

/* ------------------------------ 当块（§3.6） ------------------------------ */

function emitWhenBlock(em: Emitter, node: WhenBlock, ctx: BodyContext, indent: number): void {
  const subject = lowerExpression(node.subject, exprCtx(ctx, node.loc.start));
  em.push(indent, `SELECTCASE ${subject}`, node.loc.start.line);
  for (const branch of node.branches) {
    if (branch.kind === 'case') {
      em.push(indent + 1, `CASE ${renderCaseValues(branch.values, ctx, branch.loc.start)}`, branch.loc.start.line);
    } else {
      em.push(indent + 1, `CASEELSE`, branch.loc.start.line);
    }
    for (const child of branch.body) emitStatement(em, child, ctx, indent + 2);
  }
  em.push(indent, `ENDSELECT`, null);
}

/** `CASE 1` / `CASE 2, 3` / `CASE 5 TO 8` / `CASE "1"`（规范 §3.6） */
function renderCaseValues(
  values: WhenCaseValue[],
  ctx: BodyContext,
  loc: { line: number; column: number },
): string {
  return values
    .map((v) => {
      const from = renderCaseValue(v.from, ctx, loc);
      if (v.to === null) return from;
      const to = renderCaseValue(v.to, ctx, loc);
      return `${from} TO ${to}`;
    })
    .join(', ');
}

function renderCaseValue(raw: string, ctx: BodyContext, loc: { line: number; column: number }): string {
  const trimmed = raw.trim();
  // 字面量别名在分支值位置**纯文本展开**（规范 §5.0 / §6.3）
  const alias = ctx.aliases.get(trimmed);
  if (alias) {
    const v = alias.value;
    if (v.kind === 'number') return v.text;
    if (v.kind === 'string') return `"${v.text}"`;
    if (v.kind === 'variable') return v.text;
    if (v.kind === 'character') return `%CALLNAME:${v.no}%`;
  }
  if (/^".*"$/.test(trimmed)) return trimmed;
  return lowerExpression(trimmed, exprCtx(ctx, loc));
}

/* ------------------------------ 随机块（§3.6 末 / §5.4） ------------------------------ */

/**
 * 随机块（规范 §3.6）：
 * ```
 * LOCAL:N = RAND:count
 * SELECTCASE LOCAL:N
 *     CASE 0
 *         …
 *     CASE 1
 *         …
 * ENDSELECT
 * ```
 * 槽位**每块独占、嵌套递增**（§5.4）。
 */
function emitRandomBlock(em: Emitter, node: RandomBlock, ctx: BodyContext, indent: number): void {
  const count = node.alternatives.length;
  const slot = slotName(ctx.allocator.allocate());
  em.push(indent, `${slot} = RAND:${count}`, node.loc.start.line);
  em.push(indent, `SELECTCASE ${slot}`, null);
  ctx.allocator.enter();
  node.alternatives.forEach((alt, i) => {
    em.push(indent + 1, `CASE ${i}`, alt.loc.start.line);
    for (const child of alt.body) emitStatement(em, child, ctx, indent + 2);
  });
  ctx.allocator.exit();
  em.push(indent, `ENDSELECT`, null);
}

/** 随机行内简写（§3.6）：与块形态同构（`RAND:n` + SELECTCASE） */
function emitRandomInline(em: Emitter, node: RandomInline, ctx: BodyContext, indent: number): void {
  const count = node.alternatives.length;
  const slot = slotName(ctx.allocator.allocate());
  em.push(indent, `${slot} = RAND:${count}`, node.loc.start.line);
  em.push(indent, `SELECTCASE ${slot}`, null);
  ctx.allocator.enter();
  node.alternatives.forEach((raw, i) => {
    em.push(indent + 1, `CASE ${i}`, node.loc.start.line);
    const text = stripOuterQuotes(raw);
    const speech = detectSpeechText(text);
    em.push(indent + 2, printLine(text, speech, true, ctx), node.loc.start.line);
  });
  ctx.allocator.exit();
  em.push(indent, `ENDSELECT`, null);
}

/**
 * `LOCAL:N` 槽位名（规范 §5.4 + golden §6.2 冻结口径）。
 *
 * 规范 §5.4 写 `LOCAL:N`（N 从 0 起），而 frozen golden §6.2 的产物是
 * **bare `LOCAL`**（第 0 块）——两者一致：`LOCAL` 即 `LOCAL:0` 的省略写法
 * （引擎 `LOCAL:0` ≡ `LOCAL`）。故第 0 块写 `LOCAL`，第 N>0 块写 `LOCAL:N`，
 * 这既逐字节满足 golden，又保留"每块独占、嵌套递增"的语义。
 */
function slotName(n: number): string {
  return n === 0 ? 'LOCAL' : `LOCAL:${n}`;
}

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('「') && t.endsWith('」')) || (t.startsWith('｢') && t.endsWith('｣'))) return t;
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/* ------------------------------ 选项块（§3.7） ------------------------------ */

/**
 * 选项块（规范 §3.7）：
 * ```
 * PRINTBUTTON "文本", "n"     ← 按书写顺序
 * INPUTS
 * SELECTCASE RESULTS
 *     CASE "n"
 *         …
 * ENDSELECT
 * ```
 */
function emitChoiceBlock(em: Emitter, node: ChoiceBlock, ctx: BodyContext, indent: number): void {
  node.items.forEach((item, i) => {
    em.push(indent, `PRINTBUTTON ${JSON.stringify(item.label)}, ${JSON.stringify(String(i + 1))}`, item.loc.start.line);
  });
  em.push(indent, `INPUTS`, null);
  em.push(indent, `SELECTCASE RESULTS`, null);
  node.items.forEach((item, i) => {
    em.push(indent + 1, `CASE ${JSON.stringify(String(i + 1))}`, item.loc.start.line);
    for (const child of item.body) emitStatement(em, child, ctx, indent + 2);
  });
  em.push(indent, `ENDSELECT`, null);
}

/* ------------------------------ 着色块（§3.9） ------------------------------ */

function emitColorBlock(em: Emitter, node: ColorBlock, ctx: BodyContext, indent: number): void {
  em.push(indent, `SETCOLOR ${node.color}`, node.loc.start.line);
  for (const child of node.body) emitStatement(em, child, ctx, indent);
  em.push(indent, `RESETCOLOR`, null);
}

/* ------------------------------ 表达式 如果 / 当（§3.5 / §3.6） ------------------------------ */

/**
 * 表达式 `如果`：逐分支写 `左值 = 分支值`（规范 §3.5）。
 * 左值先按 §5.0 展开（别名 → 目标变量；只读别名 → 报错并中止）。
 */
function emitIfExpr(em: Emitter, node: IfExpr, ctx: BodyContext, indent: number): void {
  const target = expandTarget(node.target, exprCtx(ctx, node.loc.start));
  if (target === null) return;
  for (const branch of node.block.branches) {
    if (branch.kind === 'else') {
      em.push(indent, `ELSE`, branch.loc.start.line);
    } else {
      const cond = lowerExpression(branch.condition, exprCtx(ctx, branch.loc.start));
      em.push(indent, branch.kind === 'if' ? `IF ${cond}` : `ELSEIF ${cond}`, branch.loc.start.line);
    }
    const valueNode = branch.body[0];
    if (valueNode) {
      em.push(indent + 1, `${target} = ${renderExprValue(valueNode, ctx)}`, valueNode.loc.start.line);
    }
  }
  em.push(indent, `ENDIF`, null);
}

/**
 * 表达式 `当`：逐分支写 `左值 = 分支值`（规范 §3.6）。
 */
function emitWhenExpr(em: Emitter, node: WhenExpr, ctx: BodyContext, indent: number): void {
  const target = expandTarget(node.target, exprCtx(ctx, node.loc.start));
  if (target === null) return;
  const subject = lowerExpression(node.block.subject, exprCtx(ctx, node.loc.start));
  em.push(indent, `SELECTCASE ${subject}`, node.loc.start.line);
  for (const branch of node.block.branches) {
    if (branch.kind === 'else') {
      em.push(indent + 1, `CASEELSE`, branch.loc.start.line);
    } else {
      em.push(indent + 1, `CASE ${renderCaseValues(branch.values, ctx, branch.loc.start)}`, branch.loc.start.line);
    }
    const valueNode = branch.body[0];
    if (valueNode) {
      em.push(indent + 2, `${target} = ${renderExprValue(valueNode, ctx)}`, valueNode.loc.start.line);
    }
  }
  em.push(indent, `ENDSELECT`, null);
}

/** 表达式分支的值：分支体是**单个表达式节点**（AST 段已保证）。
 *  行式词法把裸表达式行（`"热情"` / `她的好感度`）归为 `textLine`（正文在
 *  `_raw` 上），故这里同时接受 `rawLine.text` 与 `textLine._raw` 两种承载形态。 */
function renderExprValue(node: SugarNode, ctx: BodyContext): string {
  let text: string | undefined;
  if (node.kind === 'rawLine') text = node.text;
  else if (node.kind === 'textLine') text = (node as { _raw?: string })._raw;
  if (text !== undefined) {
    const trimmed = text.trim();
    if (/^".*"$/.test(trimmed)) return trimmed;
    // 字面量别名展开
    const alias = ctx.aliases.get(trimmed);
    if (alias) {
      const v = alias.value;
      if (v.kind === 'number') return v.text;
      if (v.kind === 'string') return `"${v.text}"`;
      if (v.kind === 'variable') return v.text;
      if (v.kind === 'character') return `%CALLNAME:${v.no}%`;
    }
    return lowerExpression(trimmed, exprCtx(ctx, node.loc.start));
  }
  return String(node);
}

/* ============================== 共享工具 ============================== */

function exprCtx(ctx: BodyContext, loc: { line: number; column: number }): ExprContext {
  return {
    aliases: ctx.aliases,
    dictionary: ctx.dictionary,
    report: (d: SugarDiagnostic) => ctx.sink.report(d),
    loc,
  };
}

/** 需要的最小节点类型（避免宽泛 import） */
type RawLineNode = Extract<SugarNode, { kind: 'rawLine' }>;
