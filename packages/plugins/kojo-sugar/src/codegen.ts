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
  HeartLine,
  IfBlock,
  IfExpr,
  Interpolation,
  KojoFaceTable,
  KojoFaceTemplate,
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
import type { TopNode } from './parser';
import type { AliasTable, DiagnosticSink, DictionaryLookup } from './types';

/* ============================== 输出缓冲 ============================== */

/** 逐行产物缓冲（同时维护行级源映射） */
class Emitter {
  private readonly lines: string[] = [];
  private readonly map: SugarSourceMapEntry[] = [];

  /** 追加一行（`sourceLine` = null → 纯生成行，如 `ENDIF` / 骨架） */
  push(indent: number, text: string, sourceLine: number | null = null): void {
    this.lines.push('\t'.repeat(indent) + text);
    this.map.push({ generatedLine: this.lines.length, sourceLine });
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

  // ---- 头部：登记函数 + 开关（规范 §5.5 三件套之登记/开关）----
  emitRegistration(em, fm, charNo, familySeg, opts.faceTable, opts.sink);

  // ---- 时机块 ----
  const timings = topLevel.filter((n): n is TimingBlock => n.kind === 'timingBlock');
  for (const timing of timings) {
    if (em.length > 0) em.blank();
    emitTiming(em, timing, {
      charNo,
      familySeg,
      frontMatter: fm,
      aliases: opts.aliases,
      dictionary: opts.dictionary,
      faceTable: opts.faceTable,
      sink: opts.sink,
    });
  }

  // ---- 配色函数（规范 §5.5 三件套之配色；golden §6.1 排在全部时机之后）----
  if (charNo.length > 0 && fm.color) {
    if (em.length > 0) em.blank();
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
    for (const line of raw.lines) em.pushRaw(line, raw.loc.start.line);
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
  sink: DiagnosticSink;
}

function emitTiming(em: Emitter, timing: TimingBlock, ctx: TimingEmitContext): void {
  const face = resolveFace(timing.face, timing, ctx);
  if (!face) return;

  const baseName = buildFunctionName(face.template, ctx.familySeg, ctx.charNo, timing.index, face.paramIndex);

  // ---- 成否判定函数（规范 §5.5：写了 `成否:` 时生成 SUCCESS 函数）----
  // 位协议目标与原语来自 adapter（`KojoFaceTable.successFlag`）；缺省 → 跳过
  // 并记 INFO（该游戏无成否位协议，非错误）。
  const flagProto = ctx.faceTable?.successFlag;
  if (face.success && flagProto) {
    const successName = buildFunctionName(
      face.success.template,
      ctx.familySeg,
      ctx.charNo,
      timing.index,
      face.success.paramIndex,
    );
    em.pushGenerated(0, `@${successName}`);
    em.pushGenerated(0, `${flagProto.target} = ${successFlag(timing, flagProto.values)}`);
    em.blank();
  }

  // ---- MESSAGECHECK 函数（写了 隐藏情景/隐藏口上 时）----
  if (timing.messageCheck.length > 0) {
    emitMessageCheck(em, timing, ctx);
  }

  // ---- 主体两函数（规范 §5.5：包装 + `_1` 正文）----
  em.pushGenerated(0, `@${baseName}`);
  em.pushGenerated(0, `CALL ${baseName}_1`);
  em.pushGenerated(0, `RETURN RESULT`);
  em.blank();

  em.pushGenerated(0, `@${baseName}_1`);
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
 */
function segmentParamName(segName: string): string | undefined {
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
function emitMessageCheck(em: Emitter, timing: TimingBlock, ctx: TimingEmitContext): void {
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
  const base = resolveFaceNameForMessageCheck(timing, ctx);
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
      timing.index,
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

function resolveFaceNameForMessageCheck(timing: TimingBlock, ctx: TimingEmitContext): string | null {
  const face = resolveFace(timing.face, timing, ctx);
  if (!face) return null;
  return buildFunctionName(face.template, ctx.familySeg, ctx.charNo, timing.index, face.paramIndex);
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
  // 片段内可能含 `%…%`（原生写法）与裸中文（作者误写）——只做运算符/代词降糖
  return lowerExpression(fragment, exprCtx(ctx, loc));
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
  return `PRINTFORM${suffix} ${text}`;
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
