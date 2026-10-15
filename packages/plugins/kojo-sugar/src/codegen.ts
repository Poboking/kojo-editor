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
  AskMBlock,
  AskYNBlock,
  ChoiceBlock,
  ColorBlock,
  CustomCommandBlock,
  FunctionBlock,
  HeartLine,
  IfBlock,
  IfExpr,
  Interpolation,
  KojoFaceTable,
  KojoFaceTemplate,
  KojoInstructionTable,
  KojoLibraryTable,
  MenuBlock,
  OnceBlock,
  RandomBlock,
  RandomInline,
  RawFunctionBlock,
  RawLine,
  ReturnStatement,
  SectionBlock,
  SingleIfStatement,
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
import {
  buildColumnRuns,
  clipAndShift,
  identitySpec,
  verbatimSpec,
  type RunSpec,
  type SourceLineView,
} from './column-map';
import { checkTimingArgsDeclaration, CJK, type SectionPreset } from './lexer';
import { argPositionToken, RESERVED_PRONOUNS, TIMING_ARGS_PARAM, TIMING_NAMED_PARAMS, TIMING_SUCCESS_PARAM } from './keywords';
import { isIdentPart, isIdentStart } from './identifier-chars';
import { STATEMENT_FUNCTIONS } from './statement-functions';
import type { TopNode } from './parser';
import type { AliasTable, DiagnosticSink, DictionaryLookup, HeartBlock, RandomShape } from './types';

/* ============================== 输出缓冲 ============================== */

/** 函数头记号：产物第 1 列的 `@NAME`（带缩进的不是函数头） */
const FUNCTION_HEADER_RE = /^@([A-Za-z0-9_一-龥]+)$/;

/** 无源侧视图（= 关掉列级记录，行级行为逐字同旧版） */
const EMPTY_VIEWS: ReadonlyMap<number, SourceLineView> = new Map();

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
  /**
   * 源侧逻辑行视图（S6 列级映射）。缺省 = 无视图 ⇒ 全部只记行级（旧行为逐字不变）。
   */
  private views: ReadonlyMap<number, SourceLineView> = EMPTY_VIEWS;

  setViews(views: ReadonlyMap<number, SourceLineView>): void {
    this.views = views;
  }

  /** 源侧逻辑行视图（发射点用它定位 needle；无视图 ⇒ 该行不记列） */
  viewOf(sourceLine: number): SourceLineView | undefined {
    return this.views.get(sourceLine);
  }

  setOwner(sourceLine: number | null): void {
    this.owner = sourceLine;
  }

  /**
   * 追加一行（`sourceLine` = null → 纯生成行，如 `ENDIF` / 骨架）。
   *
   * `runs` = 生成时就地拿到的列区段规格（源偏移 ↔ 产物偏移）；能否落账由
   * `buildColumnRuns` 的逐码元相等校验决定，不通过则该行退化为纯行级映射。
   */
  push(indent: number, text: string, sourceLine: number | null = null, runs?: readonly RunSpec[]): void {
    this.lines.push('\t'.repeat(indent) + text);
    this.map.push({
      generatedLine: this.lines.length,
      sourceLine,
      ...this.columnRuns(runs, text, indent, sourceLine),
    });
    // 生成头允许带 `参数:` 声明（`@NAME(ARG,ARG:1)`）——比对时剥掉声明，
    // 否则带形参的时机头**逃过**「重复定义」检测（旧正则只认裸 `@NAME`）。
    if (indent === 0) {
      const name = GENERATED_HEADER_RE.exec(text)?.[1];
      if (name) this.noteDefinition(name, sourceLine ?? this.owner);
    }
  }

  /** 列区段落账（无视图 / 无源行 ⇒ 空对象，条目形状与旧版逐字相同）；`text` 是**未加缩进**的行文本 */
  private columnRuns(
    runs: readonly RunSpec[] | undefined,
    text: string,
    indent: number,
    sourceLine: number | null,
  ): Pick<SugarSourceMapEntry, 'runs'> {
    if (!runs || runs.length === 0 || sourceLine === null) return {};
    const built = buildColumnRuns(runs, text, indent, sourceLine, this.views.get(sourceLine));
    return built.length > 0 ? { runs: built } : {};
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

  /** 原始行（原生直通块）：逐行透传，保留原缩进（列基准 = 逻辑全文 0 偏移，校验不过不记） */
  pushRaw(text: string, sourceLine: number | null, runs?: readonly RunSpec[]): void {
    this.lines.push(text);
    this.map.push({
      generatedLine: this.lines.length,
      sourceLine,
      ...this.columnRuns(runs, text, 0, sourceLine),
    });
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
   * **P-5**：`当 …： 是 <中文名>：` 的 `CASE` 值同表同码——裸中文词查表得编号，
   * 查不到报 `timing-instruction-unknown` 并**保留原文**（不猜、不换成编号）。
   */
  instructionTable?: KojoInstructionTable;
  /**
   * 基础库 / 常用函数名表（adapter 提供；游戏知识；ZH-F1）。
   * 表达式里的**中文函数名调用形态**经本表（系统函数表优先，本表次之）降为原生 ERB
   * 函数名；缺省 = 该适配器未声明 → 未收录的中文调用形态原样保留并报
   * `function-name-unknown`（warning，fail-visible）。
   */
  libraryTable?: KojoLibraryTable;
  sink: DiagnosticSink;
  options: SugarTranspileOptions;
  /**
   * 源侧逻辑行视图（S6 列级映射）。缺省 = 不记列，`sourceMap` 与旧版逐字同形。
   * 由调用方（`service.transpile`）从**同一份源文本**切出；键 = 逻辑行首个物理行号。
   */
  views?: ReadonlyMap<number, SourceLineView>;
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
  em.setViews(opts.views ?? EMPTY_VIEWS);
  const fm = opts.frontMatter;
  const charNo = fm.charNo ?? '';
  const familySeg = familySegment(fm.family);

  // ---- 文件头注释（第 3 条：注释不能丢）----
  // 放在最前面：它们按源顺序出现在文件头（`角色:` 之前），常是整份口上的标题/出处，
  // 生成的三件套函数是**从头部声明派生**的，注释自然该在派生结果之前。
  for (const node of topLevel) {
    if (node.kind !== 'comment') continue;
    em.push(0, node.text, node.loc.start.line, verbatimRow(em, node));
  }

  // ---- 文件级常量（7 号批 → 宏化修订）：**只落一行注释，不发射 `#DIM CONST`** ----
  // 原实现把常量写成函数外顶格的 `#DIM CONST`——而 Emuera 里函数外的 `#DIM CONST` 是
  // **游戏级全局**：两个 `.kojo` 各声明一个同名常量，或与语料既有 `.ERH` 全局名撞上，
  // 都会让游戏**加载期**整体失败（实测语料：顶层声明 6,011 条、跨文件重名 0 条——作者
  // 一贯守规，正因撞上就是崩）。而糖内**全部**引用早已被字面量替换（`常量 X = 1022`
  // ⇒ 表达式里就是 `1022`）⇒ 该声明对糖语义是死重，却是**唯一的引擎全局足迹与全部
  // 撞名面** ⇒ 直接去掉，"用户 × 用户"与"用户 × 语料 `.ERH`"两类撞名构造性消失。
  // 留一行注释：常量不凭空消失，产物里仍看得到它被展开成了什么。
  // ⚠ 本行会进产物（进而进 golden），**不许含被 `no-sugar-jargon.test.ts` 封禁的术语**。
  for (const node of topLevel) {
    if (node.kind !== 'constDecl') continue;
    em.push(0, `; 常量 ${node.name} = ${node.value}（编译期展开为字面量，不占引擎全局名）`, node.loc.start.line);
  }

  // ---- 头部：登记函数 + 开关（规范 §5.5 三件套之登记/开关）----
  emitRegistration(em, fm, charNo, familySeg, opts.faceTable, opts.sink);

  // ---- 用户函数（B4 批）：先扫全文件的「函数」声明，合成 per-file 函数名表 ----
  // 产物命名走 adapter 的 `userFunction.template`（游戏知识不进转译器）；合成的表**并入**
  // 既有 `libraryTable`（用户声明的名字优先），供正文里的表达式/语句调用降糖使用。
  const userFunctions = collectUserFunctions(topLevel, opts.faceTable?.userFunction?.template, charNo);
  const libraryTable = userFunctions.size > 0 ? mergeUserFunctionLibrary(opts.libraryTable, userFunctions) : opts.libraryTable;

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
      libraryTable,
      userFunctions,
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
        faceTable: opts.faceTable,
        hooks: opts.faceTable?.customHooks,
        range: opts.faceTable?.customComRange,
        instructionTable: opts.instructionTable,
        libraryTable,
        userFunctions,
        occupied,
        allocated,
      });
    }
  }

  // ---- 用户函数块（B4 批）：逐块发「可选 `#FUNCTION`/`#FUNCTIONS` + 函数头 + 函数体」----
  for (const node of topLevel) {
    if (node.kind !== 'functionBlock') continue;
    if (em.length > 0) em.blank();
    em.setOwner(node.loc.start.line);
    emitFunction(em, node, {
      charNo,
      template: opts.faceTable?.userFunction?.template,
      frontMatter: fm,
      aliases: opts.aliases,
      dictionary: opts.dictionary,
      instructionTable: opts.instructionTable,
      libraryTable,
      faceTable: opts.faceTable,
      userFunctions,
      sink: opts.sink,
    });
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
    for (const line of raw.lines) em.pushRaw(line, raw.loc.start.line, verbatimSpec(0, line.length));
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
  const declareSelTpl = faceTable?.registration?.declareSelector;
  const flagTpl = faceTable?.registration?.flagSetting;

  // 登记函数只在**有内容可写**时生成（规范 §3.1：未声明的可选项，工具不生成
  // 对应函数——引擎侧自然回退）。`口上:` 省略 = 标准版 = RESULTS 保持为空，
  // 此时登记函数无内容可写，省略以保持产物最小。
  const hasRegistration =
    familySeg.length > 0 || Boolean(fm.displayName) || Boolean(fm.description);
  if (hasRegistration) {
    if (fm.selector !== undefined) {
      // 选择器形态（别人版）：登记函数名带 `_{s}` 段，并附预处理行（如 LOCALSIZE）。
      if (declareSelTpl) {
        em.pushGenerated(0, `@${renderSkeleton(declareSelTpl.template, charNo, fm.selector)}`);
        for (const p of declareSelTpl.pragmas ?? []) em.pushGenerated(0, p);
        emitRegistrationResults(em, fm, familySeg);
      } else {
        sink.report({
          code: 'face-table-missing',
          severity: 'warning',
          message: '写了 `选择器:` 但当前适配器未声明选择器登记函数模板——已跳过（请检查适配器）。',
          loc: null,
        });
      }
    } else if (declareTpl) {
      em.pushGenerated(0, `@${renderSkeleton(declareTpl, charNo)}`);
      emitRegistrationResults(em, fm, familySeg);
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

/** 登记函数的 RESULTS 体（`口上:` / `显示名:` / `简介:` 有其一才发；规范 §5.5） */
function emitRegistrationResults(em: Emitter, fm: SugarFrontMatter, familySeg: string): void {
  if (familySeg.length > 0) em.pushGenerated(0, `RESULTS = ${JSON.stringify(familySeg)}`);
  if (fm.displayName) em.pushGenerated(0, `RESULTS:1 = "${fm.displayName}"`);
  if (fm.description) em.pushGenerated(0, `RESULTS:2 = "${fm.description}"`);
}

/**
 * 纯骨架模板求值（登记 / 配色 / 开关三件套用）：替换 `{n}`（角色号）；
 * 传了选择器时再替换 `{s}`（登记函数的别人版段）。
 * 三件套模板按规范 §5.5 不含家族段，故无需 `{t}` / `{i}`。
 */
function renderSkeleton(template: string, charNo: string, selector?: number): string {
  let out = template.replace(/\{n\}/g, charNo);
  if (selector !== undefined) out = out.replace(/\{s\}/g, String(selector));
  return out;
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
  /** 基础库 / 常用函数名表（adapter；ZH-F1：中文函数名调用形态 → 原生 ERB 名） */
  libraryTable?: KojoLibraryTable;
  /** 本文件声明的用户函数（B4 批；供正文调用降糖与插值判型） */
  userFunctions: ReadonlyMap<string, UserFunctionInfo>;
  sink: DiagnosticSink;
}

function emitTiming(em: Emitter, timing: TimingBlock, ctx: TimingEmitContext): void {
  const face = resolveFace(timing.face, timing, ctx);
  if (!face) return;

  // HK-11②：编号解析（中文名 → 编号；查不到 fail-closed）——**在 resolveFace 之后**，
  // 三者（本体 / 成否 / MESSAGECHECK）共用同一个已验证的编号。
  const resolved = resolveTimingIndex(timing, ctx, face);
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
    emitMessageCheck(em, timing, ctx, index, face);
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

  // ---- 段块（E13 批）：顶层含 `段` 时改用「逐段信封」骨架 ----
  //
  // 两种骨架**不可混排**：段块的产物里**没有**外层那对 `IF LOCAL`/`ENDIF`
  // （每段自己带 `IF LOCAL && <条件>`），而普通正文靠外层信封守卫。混在一起
  // 没有唯一可写回的形状 ⇒ 报 `section-mixed` 且**不产半成品**（与既有
  // fail-closed 口径一致：宁可拒绝，不拼半个函数）。
  const sections = timing.body.filter((n) => n.kind === 'sectionBlock');
  const plain = timing.body.filter((n) => n.kind !== 'sectionBlock' && n.kind !== 'comment');
  if (sections.length > 0 && plain.length > 0) {
    ctx.sink.report({
      code: 'section-mixed',
      severity: 'error',
      message:
        '「若」块不能和别的语句混在同一个「时机」的最外层——「若」的产物没有外层 `IF LOCAL` 信封，混排没有唯一可写回的形状。请把普通语句挪进某一段里，或把段单独放在一个「时机」里。',
      loc: timing.loc.start,
    });
    // **判据在发包装头之前**：报错后 return，产物里一个字都不留（"不产半成品"）。
    return;
  }
  const sectionMode = sections.length > 0;

  em.pushGenerated(0, `@${baseName}_1${declClause}`);
  const empty = timing.body.length === 0;
  if (!sectionMode) {
    em.pushGenerated(0, `;-------------------------------------------------`);
    em.pushGenerated(0, `;記入チェック（=0, 非表示、1, 表示）`);
    em.pushGenerated(0, `LOCAL = ${empty ? 0 : 1}`);
    em.pushGenerated(0, `;-------------------------------------------------`);
  }
  // 段模式**不发**函数级記入チェック信封：库内该形态（`M_KOJO_K101_絶頂 .ERB` 的
  // 噴乳/射精/放尿/絶頂）本就是「每段自带 `LOCAL = n`」——函数级那三行在原文件里
  // 根本不存在。多发一行的副作用是**投影读不回来**：`planSkeleton` 的 `funcHeadAbove`
  // 从第一段的 `LOCAL = n` 往上撞见它（缩进 0、非注释、未被吸收）⇒ 段折叠整段落空，
  // 投出 `如果 LOCAL && …：`（作者写不出的糖形）。故段模式与语料同形：无信封头。
  // 语义不变：`LOCAL` 由每段在各自 `IF` 之前赋值，函数返回值取最后一次赋值。

  // 正文发射上下文：段块路径的正文在**最外层**（段头自己带信封），普通正文在
  // `IF LOCAL` 里面一层。
  const bodyIndent = sectionMode ? 0 : 1;
  const bodyCtx: BodyContext = {
    aliases: ctx.aliases,
    dictionary: ctx.dictionary,
    instructionTable: ctx.instructionTable,
    libraryTable: ctx.libraryTable,
    faceTable: ctx.faceTable,
    userFunctions: ctx.userFunctions,
    sink: ctx.sink,
    frontMatter: ctx.frontMatter,
    allocator: new SlotAllocator(),
    baseIndent: bodyIndent,
    argSlotCount: argsDecl === null ? 0 : argsDecl.split(',').length,
  };

  if (sectionMode) {
    // 逐段发信封；`RETURN 1` 全函数只发一次（在末尾）
    for (const node of timing.body) {
      if (node.kind === 'sectionBlock') emitSectionBlock(em, node, bodyCtx, bodyIndent);
      // 顶层注释仍然落进产物（"注释不能丢"）——它不是语句，不参与混排判据
      else if (node.kind === 'comment') em.push(bodyIndent, node.text, node.loc.start.line, verbatimRow(em, node));
    }
  } else if (!empty) {
    em.pushGenerated(0, `IF LOCAL`);
    emitBody(em, timing.body, bodyCtx, bodyIndent);
    em.pushGenerated(0, `ENDIF`);
  }

  em.pushGenerated(0, `RETURN 1`);
}

/**
 * `若 …：` 块 → 库内手写的那 6 行信封（E13 批；旧形 `段 …：` 兼容）。
 *
 * 产物逐字对齐语料里的主流写法（`M_KOJO_K101_絶頂 .ERB` 的 噴乳 / 射精 / 放尿 三段）：
 *
 * ```
 * ;-------------------------------------------------
 * ;<段头原文>（記入チェック＝n）      ← n = 1；写了 `关` 的段写 0
 * LOCAL = n
 * ;-------------------------------------------------
 * IF LOCAL && <段条件降糖后的 ERB 条件>
 *     <段体>
 * ENDIF
 * ```
 *
 * 段的**条件**走与 `如果` 完全相同的表达式降糖管线（`lowerExpression`）——
 * 不另造一套条件语法（`若 NOWEX:噴乳：` 与 `如果 NOWEX:噴乳：` 的表达式口径同源）。
 */
function emitSectionBlock(em: Emitter, node: SectionBlock, ctx: BodyContext, indent: number): void {
  const check = node.disabled ? 0 : 1;
  // P-3 保留段名（`首次`）：**整串硬编译**——`LOCAL:1 = n` + `IF LOCAL:1 && FIRSTTIME(SELECTCOM)`
  // （M6 子信封口径，与普通段的 bare `LOCAL` 不同）。段名不走 `lowerExpression`
  // （`SELECTCOM` 在糖表达式里不可解析）。产物无 `;---` 分节线（对齐库内全形）。
  const preset = (node as { _preset?: SectionPreset })._preset;
  if (preset) {
    em.push(indent, `LOCAL:${preset.local} = ${check}`, node.loc.start.line);
    em.push(indent, `IF LOCAL:${preset.local} && ${preset.condition}`, null);
    emitBody(em, node.body, ctx, indent + 1);
    em.push(indent, `ENDIF`, null);
    return;
  }
  const condition = lowerExpression(node.condition, exprCtx(ctx, node.loc.start));
  em.pushGenerated(indent, `;-------------------------------------------------`);
  em.pushGenerated(indent, `;${node.condition}（記入チェック＝${check}）`);
  em.pushGenerated(indent, `LOCAL = ${check}`);
  em.pushGenerated(indent, `;-------------------------------------------------`);
  em.push(indent, `IF LOCAL && ${condition}`, node.loc.start.line);
  emitBody(em, node.body, ctx, indent + 1);
  em.push(indent, `ENDIF`, null);
}

/**
 * `初回 "key"：` 块（1 号任务）——产物 `IF ONCE(<key>)` … `ENDIF`。
 *
 * 块头走**表达式降糖**：把 `初回(<key>)` 交给 `lowerExpression`（复用 `lowerOnceCalls`
 * 的同一重写），故二参形同样会补角色号，与表达式形产物**同源**。块体一律经 `emitBody`
 * ——块内 `你：` 自机台词 / `着色` 的 run 与其它块完全同口径。
 *
 * 语义：`ONCE` 是变量式访问器，作为 `IF` 条件即"这个 key 还没被置位（是第一次）"——
 * 与语料 `IF ONCE("…", 1, 11)` 同形。
 */
function emitOnceBlock(em: Emitter, node: OnceBlock, ctx: BodyContext, indent: number): void {
  const condition = lowerExpression('初回(' + node.key + ')', exprCtx(ctx, node.loc.start));
  em.push(indent, `IF ${condition}`, node.loc.start.line);
  emitBody(em, node.body, ctx, indent + 1);
  em.push(indent, `ENDIF`, null);
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
  /**
   * `{i}` 槽的取值口径（adapter 声明；缺省 `'command'`）。`'literal'` = 令牌原样
   * 透传、**不查指令名表**（尾部是运行期形态名的面，如 `图像`）。
   */
  indexKind: 'command' | 'literal';
  /** 成否函数模板（写了 `成否:` 时生成） */
  success?: { template: string; paramIndex: boolean };
  /**
   * MESSAGECHECK 函数名模板（**逐面**，段已求值）；`undefined` = 该面**无** MESSAGECHECK
   * 钩子（写了 `隐藏情景/隐藏口上` 时报 `face-table-missing`，不静默）。
   */
  messageCheckTemplate?: string;
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
    indexKind: spec.indexKind ?? 'command',
    // `成功` 划分野自身即 SUCCESS 函数（避免重复生成同名函数）——由 adapter
    // 在表里把 `success` 留空表达（见 face-templates.ts 的 `成功` 条目）。
    success: successTpl,
    // MESSAGECHECK 模板**逐面**（adapter 声明在同条的 `messageCheck`）；同一套段求值。
    messageCheckTemplate:
      spec.messageCheck === undefined ? undefined : applySegments(spec.messageCheck.template, segments),
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
  return TIMING_NAMED_PARAMS.find((p) => p.segmentName === segName)?.name;
}

/** 把模板里的 `${段名}` 替换为段文本（未命中的段保持原样，便于诊断） */
function applySegments(template: string, segments: Record<string, string>): string {
  return template.replace(/\$\{([^}]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(segments, name) ? segments[name]! : whole,
  );
}

function hasSuccessNamed(timing: TimingBlock): boolean {
  return timing.namedParams.some((p) => p.name === TIMING_SUCCESS_PARAM);
}

/** `成否:` 取值 → 适配器位协议目标变量的值（规范 §3.2 表；默认 `游戏判定` = 0） */
function successFlag(timing: TimingBlock, values?: Readonly<Record<string, number>>): number {
  const p = timing.namedParams.find((x) => x.name === TIMING_SUCCESS_PARAM);
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
 * 函数名模板**逐面**来自 adapter（`KojoFaceTemplate.messageCheck`，`_MESSAGECHECK`
 * 插入点逐面不同——见契约头注释）；位号 / 置位原语来自位协议
 * （`KojoFaceTable.messageCheck`）。一个面只有**一个**钩子函数，`隐藏情景` 与
 * `隐藏口上` 是它的两条 `IF` 分支（各置各的位），故这里**只发一个函数头**。
 *
 * 缺位协议 → warning 跳过（该游戏无此概念）；面**无钩子**（模板缺省）→ error
 * 忽略该子句（**不静默**：引擎从不调用无钩子面的 MESSAGECHECK）。
 */
function emitMessageCheck(
  em: Emitter,
  timing: TimingBlock,
  ctx: TimingEmitContext,
  index: string | undefined,
  face: FaceResolution,
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
  const tpl = face.messageCheckTemplate;
  if (tpl === undefined) {
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'error',
      message: `分野「${timing.face.trim()}」没有 MESSAGECHECK 钩子（引擎不调用该面的 MESSAGECHECK）——\`隐藏情景:\` / \`隐藏口上:\` 无处落地，已忽略。`,
      loc: timing.messageCheck[0]?.loc.start ?? null,
    });
    return;
  }
  const fnName = buildFunctionName(tpl, ctx.familySeg, ctx.charNo, index, tpl.includes('{i}'));
  em.pushGenerated(0, `@${fnName}`);
  for (const mc of timing.messageCheck) {
    const bit = proto.bits[mc.scope];
    if (bit === undefined) {
      ctx.sink.report({
        code: 'face-table-missing',
        severity: 'warning',
        message: `适配器的 MESSAGECHECK 协议未声明作用域「${mc.scope}」的位号——已跳过该条。`,
        loc: mc.loc.start,
      });
      continue;
    }
    const exprCtx: ExprContext = {
      aliases: ctx.aliases,
      dictionary: ctx.dictionary,
      libraryTable: ctx.libraryTable,
      report: (d) => ctx.sink.report(d),
      loc: mc.loc.start,
    };
    em.pushGenerated(0, `IF ${lowerExpression(mc.condition, exprCtx)}`);
    em.pushGenerated(0, (proto.setBit ?? 'SETBIT RESULT, {bit}').replace(/\{bit\}/g, String(bit)));
    em.pushGenerated(0, `ENDIF`);
  }
  em.blank();
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
 *
 * 例外：面声明了 `indexKind: 'literal'`（如 `图像`）时，令牌是**运行期形态名**
 * （引擎以 `%ARGS:1%` 拼名），指令表里根本没有它 ⇒ **原样透传**，不查表、不报错。
 */
function resolveTimingIndex(
  timing: TimingBlock,
  ctx: TimingEmitContext,
  face: FaceResolution,
): IndexResolution {
  const name = timing.indexName;
  if (name === undefined) return { ok: true, index: timing.index };
  if (face.indexKind === 'literal') return { ok: true, index: name };

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
  /** 分野模板表（adapter；仅供正体内 `你：` 自机台词的缺省自机色兜底） */
  faceTable?: KojoFaceTable;
  sink: DiagnosticSink;
  /** 自定钩子模板（adapter；缺 comName/comAble/com 任一 → 跳过并告警） */
  hooks?: KojoFaceTable['customHooks'];
  /** 编号自动分配可用段（adapter；缺省且未显式写 `编号:` → fail-closed） */
  range?: { min: number; max: number };
  /** 指令名表（adapter；P-5：体内 `当/是` 的中文 CASE 值查此表，同时机头口径） */
  instructionTable?: KojoInstructionTable;
  /** 基础库 / 常用函数名表（adapter；ZH-F1） */
  libraryTable?: KojoLibraryTable;
  /** 本文件声明的用户函数（B4 批；名字 → 产物名 + 返回类型），供正文调用降糖与插值判型 */
  userFunctions: ReadonlyMap<string, UserFunctionInfo>;
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
      instructionTable: ctx.instructionTable,
      libraryTable: ctx.libraryTable,
      faceTable: ctx.faceTable,
      userFunctions: ctx.userFunctions,
      sink: ctx.sink,
      frontMatter: ctx.frontMatter,
      allocator: new SlotAllocator(),
      baseIndent: bodyIndent,
    };
    emitBody(em, node.body, bodyCtx, bodyIndent);
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
    libraryTable: ctx.libraryTable,
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
  /** 指令名表（adapter；P-5：`当/是` 的中文 CASE 值查此表得编号） */
  instructionTable?: KojoInstructionTable;
  /** 基础库 / 常用函数名表（adapter；ZH-F1） */
  libraryTable?: KojoLibraryTable;
  /** 分野模板表（adapter；`你：` 自机台词缺省自机色的兜底来源，游戏知识只住 adapter） */
  faceTable?: KojoFaceTable;
  /** 本文件声明的用户函数（B4 批；插值调用判型 + 语句调用降糖） */
  userFunctions?: ReadonlyMap<string, UserFunctionInfo>;
  /** 当前是否在「函数 …：」块体内（B4 批；`返回` 仅在此为真时合法） */
  inFunction?: boolean;
  /**
   * 当前「函数 …：」块体是否为**值函数**（存在带值返回；本批）。裸 `返回` 据此落
   * `RETURNF`（值函数，空返回）/ `RETURN`（过程函数）——与函数头是否挂 `#FUNCTION` 同一判据。
   */
  functionIsValueFunction?: boolean;
  /** 当前作用域声明的**实参槽位数**（v1.7；`实参:n` 未声明位置在此 fail-visible，见 `ExprContext`） */
  argSlotCount?: number;
  sink: DiagnosticSink;
  frontMatter: SugarFrontMatter;
  allocator: SlotAllocator;
  baseIndent: number;
  /** 缺省自机色告警去重（每时机一次；内部可变） */
  _playerColorWarned?: boolean;
  /**
   * 当前所处 `着色` 块的**环境色**（可选）。自机色 run 收尾时**复原**到它（而非 `RESETCOLOR`
   * 打回默认）——否则着色块里一段自机台词之后，同块后续非 D 行会丢掉块色。缺省 = 无环境色（打 `RESETCOLOR`）。
   */
  ambientColor?: string;
}

function emitStatement(em: Emitter, node: SugarNode | HeartBlock, ctx: BodyContext, indent: number): void {
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
    case 'groupBlock':
      // `组：` 候选组（E18）：组体**逐句透传**进所在候选——同缩进、不产生包装行，
      // 产物与「几行裸行候选」同构（`随机：` 的候选边界是行，本写法只把多行收成一条候选）。
      emitBody(em, node.body, ctx, indent);
      break;
    case 'sectionBlock':
      // 段块**只**在时机正文最外层走逐段信封（`emitTiming` 的 sectionMode 路径）；
      // 落到这里说明它出现在别的块体里（判据外），仍按信封形态发——不静默丢内容。
      emitSectionBlock(em, node, ctx, indent);
      break;
    case 'onceBlock':
      emitOnceBlock(em, node, ctx, indent);
      break;
    case 'choiceBlock':
      emitChoiceBlock(em, node, ctx, indent);
      break;
    case 'menuBlock':
      emitMenuBlock(em, node, ctx, indent);
      break;
    case 'askMBlock':
    case 'askYNBlock':
      emitAskBlock(em, node, ctx, indent);
      break;
    case 'colorBlock':
      emitColorBlock(em, node, ctx, indent);
      break;
    case 'heartBlock':
      emitHeartBlock(em, node, ctx, indent);
      break;
    case 'rawLine':
      emitRawLine(em, node, ctx, indent);
      break;
    case 'comment':
      // 注释原样落进产物（第 3 条：注释不能丢）。缩进跟着所在层级走——产物里的
      // 注释在 ERB 里是惰性的，缩进只影响可读性，但"和代码同层"才看得出它属于谁。
      em.push(indent, node.text, node.loc.start.line, verbatimRow(em, node));
      break;
    case 'callStatement':
      // `调用 名字(实参)`（B4 批）：语句位置调用 → `CALL <产物名>[(实参)]`。
      emitCallStatement(em, node, ctx, indent);
      break;
    case 'returnStatement':
      // `返回 [值]`（B4 批）：只在「函数」块体内合法（非 inFunction → 报错，不产半成品）。
      emitReturnStatement(em, node, ctx, indent);
      break;
    case 'singleIfStatement':
      // 单行条件（本批）：`SIF <条件>` + 一条语句；语句多行时自动退化 `IF`/`ENDIF`。
      emitSingleIfStatement(em, node, ctx, indent);
      break;
    case 'rawFunctionBlock':
      for (const line of node.lines) em.pushRaw(line, node.loc.start.line, verbatimSpec(0, line.length));
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

/* ------------------------------ 自机台词（`你：` 行首前缀） ------------------------------ */

/**
 * 语句列表发射（含 `你：` 自机台词的**色切换合并**）。
 *
 * 连续 `你：` 行只发**一次** `SETCOLOR <自机色>`（run 起点），run 结束（遇到非自机
 * 语句或列表末尾）发**一次** `RESETCOLOR` 复原——避免逐行重复 SETCOLOR/RESETCOLOR。
 * 非自机行照常走 `emitStatement`；进入任何块语句前先把当前 run 收尾，保证块内颜色
 * 与块外互不串扰（块体自带一次 run 收尾，语义与运行期一致）。
 */
function emitBody(em: Emitter, body: readonly SugarNode[], ctx: BodyContext, indent: number): void {
  let run = false; // 当前是否有生效的自机色 run
  const closeRun = (): void => {
    if (run) {
      // 复原到所处 `着色` 块的环境色（有则 `SETCOLOR <环境色>`，否则 `RESETCOLOR` 打回默认）——
      // 否则着色块里自机台词之后的非 D 行会丢掉块色（真语料同一回改处也是手动重发 SETCOLOR）。
      em.push(indent, ambientRestoreLine(ctx), null);
      run = false;
    }
  };
  for (const node of body) {
    if (!isPlayerLine(node)) {
      closeRun();
      emitStatement(em, node, ctx, indent);
      continue;
    }
    const base = rawBase(em, node);
    const parsed = textBody(node, ctx, base);
    // `你：` 前缀不进产物 ⇒ 区段整体左移其宽度；位移后为负的段（落在被剥掉的前缀里）自动丢弃
    const text = parsed.raw.replace(PLAYER_PREFIX_RE, '');
    const stripped = parsed.raw.length - text.length;
    const runs = clipAndShift(parsed.runs, stripped, parsed.raw.length, 0);
    const color = resolvePlayerColor(node, ctx);
    if (color === null) {
      // 未声明 `自机色:` 且 adapter 无缺省 → 退化：按普通旁白输出（已报 `face-table-missing`）
      closeRun();
      const line = printLine(text, detectSpeechText(text), node.wait, ctx);
      em.push(indent, line, node.loc.start.line, clipAndShift(runs, 0, Number.POSITIVE_INFINITY, line.length - text.length));
      continue;
    }
    if (!run) {
      em.push(indent, `SETCOLOR ${color}`, node.loc.start.line);
      run = true;
    }
    // 非 D 变体：D 系忽略 `SETCOLOR`（= 旁白色），自机台词靠 `SETCOLOR` 上色。
    const line =
      text.length === 0
        ? node.wait
          ? 'PRINTFORMDW'
          : 'PRINTFORML'
        : `PRINTFORM${node.wait ? 'W' : 'L'} ${text}`;
    em.push(indent, line, node.loc.start.line, clipAndShift(runs, 0, Number.POSITIVE_INFINITY, text.length === 0 ? 0 : line.length - text.length));
  }
  closeRun();
}

/** 自机色 run / `着色` 块收尾的**复原行**（同一口径的唯一来源）：有环境色回退环境色，否则打回默认 */
function ambientRestoreLine(ctx: BodyContext): string {
  return ctx.ambientColor !== undefined ? `SETCOLOR ${ctx.ambientColor}` : 'RESETCOLOR';
}

/** `你：` 行首前缀（全/半角冒号各一；**只认行首**，正文中间的「你」不替换） */
const PLAYER_PREFIX_RE = /^你[:：]/;

/** 该节点是否 `你：` 自机台词行（只看**行首前缀**，避免正文中间误伤） */
function isPlayerLine(node: SugarNode): node is TextLine {
  return node.kind === 'textLine' && PLAYER_PREFIX_RE.test(sourceTextOf(node));
}

/** `心形：` 块内的 `你：` 行——块体一律存成 `heartLine`，故不能复用 `isPlayerLine`，只按行首前缀判 */
function isPlayerHeartLine(node: TextLine | HeartLine): boolean {
  return PLAYER_PREFIX_RE.test(sourceTextOf(node));
}

/**
 * 自机色解析：作者 `自机色:` 优先，否则回退 adapter 的缺省自机色（`KojoFaceTable.playerColor`）。
 * 两者都缺省 → 报 `face-table-missing`（每时机一次）并返回 `null`（调用方按普通旁白输出，不静默）。
 */
function resolvePlayerColor(node: TextLine | HeartLine, ctx: BodyContext): string | null {
  const declared = ctx.frontMatter.playerColor;
  if (declared !== undefined && declared.length > 0) return declared;
  const fallback = ctx.faceTable?.playerColor;
  if (fallback !== undefined && fallback.length > 0) return fallback;
  if (!ctx._playerColorWarned) {
    ctx._playerColorWarned = true;
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'warning',
      message:
        '写了 `你：` 自机台词，但文件头既未声明 `自机色:`，当前适配器也未提供缺省自机色——' +
        '该行已按普通旁白输出（不上色）。请补 `自机色: <颜色>` 或使用支持自机色的适配器。',
      loc: node.loc.start,
    });
  }
  return null;
}

/* ------------------------------ 原生直通行 / 语句赋值 ------------------------------ */

/**
 * `rawLine` 三种来源：
 * - **语句形中文函数调用** `设置标记 X, n`（parser 挂了 `_statementFn` 标记；位糖 = 方案 E）
 *   → 目标 `X` 走左值展开（`expandTarget`，只读别名报错中止），位槽 `n` 走表达式降糖
 *   （`lowerExpression`）；产 `SETBIT/CLEARBIT/INVERTBIT X, n`；
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
  const stmtFn = (node as { _statementFn?: { engine: string; target: string; slot: string } })._statementFn;
  if (stmtFn) {
    const target = expandTarget(stmtFn.target, exprCtx(ctx, node.loc.start));
    if (target === null) return; // 只读别名：已在 expandTarget 报诊断，不产出半成品
    if (stmtFn.slot.trim().length === 0) {
      // 缺逗号 / 空位槽：报既有码（零新诊断码），位置指回该行，且**不产半成品**
      const cnName = [...STATEMENT_FUNCTIONS.entries()].find(([, e]) => e === stmtFn.engine)?.[0] ?? stmtFn.engine;
      ctx.sink.report({
        code: 'unknown-identifier',
        severity: 'error',
        message: `「${cnName}」需要写成「${cnName} <变量引用>, <位号表达式>」——缺逗号或位号为空。`,
        loc: node.loc.start,
      });
      return;
    }
    const slot = lowerExpression(stmtFn.slot, exprCtx(ctx, node.loc.start));
    em.push(indent, `${stmtFn.engine} ${target}, ${slot}`, node.loc.start.line);
    return;
  }
  const assign = (node as { _assign?: { target: string; expr: string } })._assign;
  if (!assign) {
    em.push(indent, node.text, node.loc.start.line, verbatimRow(em, node));
    return;
  }
  const target = expandTarget(assign.target, exprCtx(ctx, node.loc.start));
  if (target === null) return; // 只读别名：已在 expandTarget 报诊断，不产出半成品
  const value = lowerExpression(assign.expr, exprCtx(ctx, node.loc.start));
  const line = `${target} = ${value}`;
  const view = viewTextOf(em, node.loc.start.line);
  em.push(indent, line, node.loc.start.line, [
    ...identitySpec(view, assign.target, contentBase(node), 0),
    ...identitySpec(view, assign.expr, contentBase(node), line.length - value.length),
  ]);
}

/* ------------------------------ 用户函数（B4 批：公共段 / 自定义函数最小形） ------------------------------ */

/**
 * 用户函数信息：产物函数名 + 返回类型（是否字符串返回——决定插值走 `%…%` 还是 `{…}`）。
 * 返回类型由「函数体内首个 `返回`」的值形态判定：字符串字面量 → 字符串（`#FUNCTIONS`），
 * 其余（含过程函数）→ 数值（`{…}`）。
 */
interface UserFunctionInfo {
  readonly productName: string;
  readonly returnsString: boolean;
}

/** 渲染用户函数产物名：`{n}` = 角色号、`{name}` = 作者写的函数名原文 */
function renderUserFunctionName(template: string, charNo: string, name: string): string {
  return template.replace(/\{n\}/g, charNo).replace(/\{name\}/g, name);
}

/**
 * 形参位置记号：声明位第 k 个（0 基）→ 数值视图 `ARG`（k=0）/`ARG:<k>`（k≥1）；
 * 形参名以 `$` 结尾（`名字$`）= **字符串视图** `ARGS`（k=0）/`ARGS:<k>`（k≥1）。
 * 数值 / 字符串是**同一实参位置表**的两种视图（引擎证据：spec 附录 C #37）。
 */
function paramDeclToken(name: string, k: number): string {
  return argPositionToken(name.endsWith('$'), k);
}

/** 返回值是否为字符串字面量（`"…"`）——决定 `#FUNCTIONS` vs `#FUNCTION` */
function isStringLiteralReturn(value: string): boolean {
  return /^\s*"[^"]*"\s*$/.test(value);
}

/**
 * 递归查找块体里**首个带值的** `返回` 语句（含嵌套块体）——用于判定函数是否为「值函数」。
 *
 * 口径（本批修正）：`@K11_ZE` 一类值函数的**首个**返回可能是裸 `RETURNF`（提前返回），
 * 其后才是带值返回 ⇒ 只看"首个返回"会把值函数误判成过程。故改为"**存在任一**带值返回
 * 即为值函数"。只认语句位置；表达式块（`ifExpr`/`whenExpr`）分支体里不会出现 `返回`。
 */
function findReturnNode(nodes: readonly SugarNode[]): ReturnStatement | undefined {
  for (const node of nodes) {
    if (node.kind === 'returnStatement' && node.value !== undefined) return node;
    const kids = bodyOf(node);
    if (kids) {
      const found = findReturnNode(kids);
      if (found) return found;
    }
  }
  return undefined;
}

/** 取出块类节点的子语句体（无子体 → null） */
function bodyOf(node: SugarNode): readonly SugarNode[] | null {
  switch (node.kind) {
    case 'ifBlock':
    case 'whenBlock':
      return node.branches.flatMap((b) => b.body);
    case 'randomBlock':
      return node.alternatives.flatMap((a) => a.body);
    case 'colorBlock':
    case 'groupBlock':
    case 'sectionBlock':
    case 'onceBlock':
      return node.body;
    case 'choiceBlock':
      return node.items.flatMap((i) => i.body);
    case 'singleIfStatement':
      // 单行条件守护的**一条语句**也是子语句——`返回` 藏在这里时值函数判定必须找得到它
      // （否则带值返回的函数会漏挂 `#FUNCTION`，引擎侧 `RETURNF` 落空）。
      return [node.statement];
    default:
      return null;
  }
}

/**
 * 扫全文件的「函数」声明，合成 per-file 名字表（名字 → 产物名 + 返回类型）。
 * 无 adapter 模板 → 空表（emitFunction 逐块报 `face-table-missing`，fail-closed）。
 */
function collectUserFunctions(
  topLevel: readonly TopNode[],
  template: string | undefined,
  charNo: string,
): Map<string, UserFunctionInfo> {
  const out = new Map<string, UserFunctionInfo>();
  if (!template) return out;
  for (const node of topLevel) {
    if (node.kind !== 'functionBlock') continue;
    if (out.has(node.name)) continue; // 同名第二次由 Emitter 的撞名记账报出
    const ret = findReturnNode(node.body);
    const valueFn = ret !== undefined && ret.value !== undefined;
    out.set(node.name, {
      productName: renderUserFunctionName(template, charNo, node.name),
      returnsString: valueFn && isStringLiteralReturn(ret!.value!),
    });
  }
  return out;
}

/**
 * 合成 per-file 函数名表：**用户声明的名字优先**，其余落到既有 adapter 表。
 * 只在有用户函数时才构造（无用户函数时原样透传 `opts.libraryTable`，既有产物逐字节不变）。
 */
function mergeUserFunctionLibrary(
  base: KojoLibraryTable | undefined,
  fns: ReadonlyMap<string, UserFunctionInfo>,
): KojoLibraryTable {
  // 产物名集合：让表**幂等**——`lowerSystemFunctions` 已把 `问候(` 降为 `M_KOJO_K145_问候(`，
  // 其后 `lowerPronounsAndAttributes` 再遇该产物名时，若表只认作者名，`isKnownFunctionName`
  // 会把它当"未收录的中文函数名"报 `function-name-unknown`（假告警）。收录产物名即可消解。
  const productNames = new Set<string>();
  for (const info of fns.values()) productNames.add(info.productName);
  return {
    hasTable: true,
    lookupByName(name) {
      const info = fns.get(name);
      if (info) return info.productName;
      if (productNames.has(name)) return name;
      return base?.lookupByName(name);
    },
    lookupByFunction(functionName) {
      return base?.lookupByFunction?.(functionName);
    },
  };
}

interface FunctionEmitContext {
  charNo: string;
  template?: string;
  frontMatter: SugarFrontMatter;
  aliases: AliasTable;
  dictionary?: DictionaryLookup;
  instructionTable?: KojoInstructionTable;
  libraryTable?: KojoLibraryTable;
  /** 分野模板表（adapter）——函数体内 `你：` 也要吃缺省自机色，与时机正文同口径 */
  faceTable?: KojoFaceTable;
  userFunctions: ReadonlyMap<string, UserFunctionInfo>;
  sink: DiagnosticSink;
}

/**
 * `函数 …：` 块 → 「函数头（带形参声明）+ 可选 `#FUNCTION`/`#FUNCTIONS` + 函数体」。
 *
 * **不套** `IF LOCAL` 信封、**不追加** `RETURN 1`——与时机块不同：时机块是引擎入口、
 * 必须有返回 1；用户函数是作者自己的过程 / 值函数，返回值由作者的 `返回` 决定。
 * 形参 → `ARG` 位置记号，并注入 per-function 别名表（作者照形参名读写即可）。
 */
function emitFunction(em: Emitter, node: FunctionBlock, ctx: FunctionEmitContext): void {
  if (!ctx.template) {
    // 同一个码 `face-table-missing` 有**两种成因**，靠文案区分（不新增诊断码）：
    // ①作者写了非法的 `函数前缀:`（`resolveFaceTableForPrefix` 已摘掉模板）——该改文件头那行；
    // ②没写前缀、但当前适配器压根没声明用户函数命名模板——该找适配器 / 自行加前缀。
    // 两文案互斥：①含「命名模板非法」不含「适配器」，②含「适配器」不含「命名模板非法」。
    const prefix = ctx.frontMatter.functionPrefix;
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'error',
      message:
        prefix !== undefined
          ? `写了「函数 ${node.name}：」，但文件头「函数前缀: ${prefix}」的命名模板非法——请改文件头那一行（命名模板只认「{n}」（角色编号）与「{name}」（函数名）两个占位，且不能留空）；在改好之前，本文件的「函数」块都不会生成。`
          : `写了「函数 ${node.name}：」，但当前适配器没有为你这一类「函数」声明命名模板——无法确定产物函数名。请让所用的适配器补上该模板，或在本文件头加一行「函数前缀: <你的前缀>」自行指定命名。`,
      loc: node.loc.start,
    });
    return;
  }
  const productName = renderUserFunctionName(ctx.template, ctx.charNo, node.name);
  const ret = findReturnNode(node.body);
  const valueFn = ret !== undefined && ret.value !== undefined;

  const decl = node.params
    .map((name, i) => {
      const token = paramDeclToken(name, i);
      const def = node.defaults?.[i];
      return def === undefined ? token : `${token} = ${def}`;
    })
    .join(',');
  em.pushGenerated(0, decl.length > 0 ? `@${productName}(${decl})` : `@${productName}`);
  if (valueFn) em.pushGenerated(0, isStringLiteralReturn(ret!.value!) ? '#FUNCTIONS' : '#FUNCTION');

  const bodyCtx: BodyContext = {
    aliases: withFunctionParams(ctx.aliases, node.params, node.loc.start.line),
    dictionary: ctx.dictionary,
    instructionTable: ctx.instructionTable,
    libraryTable: ctx.libraryTable,
    faceTable: ctx.faceTable,
    userFunctions: ctx.userFunctions,
    sink: ctx.sink,
    frontMatter: ctx.frontMatter,
    allocator: new SlotAllocator(),
    baseIndent: 1,
    inFunction: true,
    functionIsValueFunction: valueFn,
    argSlotCount: node.params.length,
  };
  // 函数体一律经 `emitBody`（不是裸 `emitStatement` 循环）：`你：` 自机台词的
  // 换色/复原合并只住在 `emitBody` 里，绕开它就等于函数体内 `你：` 静默降级成旁白。
  emitBody(em, node.body, bodyCtx, 1);
}

/**
 * 形参注入：在既有别名表之上叠一层「形参名 → 位置视图记号」（形参优先）。
 * `名字$`（字符串视图）与 `名字`（数值视图）各按声明位绑 `ARGS:<k>` / `ARG:<k>`
 * （`$` 已在标识符字符集里，故 `名字$` 在函数体内按整词扫描，同 `实参$`）。
 * 无参 → 原样返回（既有产物逐字节不变）。
 */
function withFunctionParams(aliases: AliasTable, params: readonly string[], line: number): AliasTable {
  if (params.length === 0) return aliases;
  const out = new Map(aliases);
  params.forEach((name, i) => {
    out.set(name, { value: { kind: 'variable', text: paramDeclToken(name, i) }, readonly: false, line });
  });
  return out;
}

/** `调用 名字(实参,…)` → `CALL <产物名>` / `CALL <产物名>(<降糖后的实参>)` */
function emitCallStatement(
  em: Emitter,
  node: Extract<SugarNode, { kind: 'callStatement' }>,
  ctx: BodyContext,
  indent: number,
): void {
  // 调用名一律**带括号**交给降糖器：`lowerSystemFunctions` 只认「标识符后随 `(`」的调用
  // 形态，无括号的裸名不会被降到产物函数名（零实参也要写成 `名字()` 才命中）。
  // 产物 `CALL 产物名()` / `CALL 产物名(实参)`——与真实语料同形（`CALL qol_Xxx()`）。
  const lowered = lowerExpression(`${node.name}(${node.args})`, exprCtx(ctx, node.loc.start));
  em.push(indent, `CALL ${lowered}`, node.loc.start.line);
}

/** `返回 [值]` → `RETURNF <值>`（值函数）/ `RETURN`（过程函数）；非函数体 → 报错不产半成品 */
function emitReturnStatement(em: Emitter, node: ReturnStatement, ctx: BodyContext, indent: number): void {
  if (!ctx.inFunction) {
    ctx.sink.report({
      code: 'indent-mismatch',
      severity: 'error',
      message: '「返回」只能写在「函数 …：」块里——时机正文 / 其它块体里没有可返回的函数。',
      loc: node.loc.start,
    });
    return;
  }
  if (node.value !== undefined && node.value.trim().length > 0) {
    const lowered = lowerExpression(node.value, exprCtx(ctx, node.loc.start));
    em.push(indent, `RETURNF ${lowered}`, node.loc.start.line);
  } else if (ctx.functionIsValueFunction) {
    // 值函数里的裸 `返回`（提前返回，如 `@K11_ZE` 的 `SIF !CFLAG:…` + `RETURNF`）→ 裸 `RETURNF`。
    em.push(indent, `RETURNF`, node.loc.start.line);
  } else {
    em.push(indent, `RETURN`, node.loc.start.line);
  }
}

/**
 * 单行条件 `如果 <条件> 则 <语句>`（本批）→ `SIF <条件>` + **恰好一条**语句行，不产 `ENDIF`。
 *
 * 引擎 `SIF` 只守护**下一行** ⇒ 只有能编译为单行产物的语句才走 `SIF`；若语句会展开成
 * 多行（`你：` 自机台词的换色 run、纯条件行的 `IF`/`ENDIF`），**自动退化**为完整
 * `IF` / 语句 / `ENDIF` 块——不静默改变语义，也不给作者"条件没生效"的假象。
 */
function emitSingleIfStatement(em: Emitter, node: SingleIfStatement, ctx: BodyContext, indent: number): void {
  const single = isSingleLineStatement(node.statement, ctx);
  const cond = lowerExpression(node.condition, exprCtx(ctx, node.loc.start));
  em.push(indent, `${single ? 'SIF' : 'IF'} ${cond}`, node.loc.start.line, [
    ...identitySpec(viewTextOf(em, node.loc.start.line), node.condition, contentBase(node), single ? 4 : 3),
  ]);
  emitBody(em, [node.statement], ctx, indent + 1);
  if (!single) em.push(indent, `ENDIF`, null);
}

/** 语句能否编译为**单行**产物（`SIF` 前提）：白名单——只认确定单行的语句形态 */
function isSingleLineStatement(node: SugarNode, ctx: BodyContext): boolean {
  switch (node.kind) {
    case 'rawLine':
    case 'callStatement':
    case 'returnStatement':
      return true;
    case 'textLine':
    case 'heartLine':
      // 自机台词换色 run（≥2 行）与纯条件行（`IF`/`ENDIF` 两行）不是单行 → 退化 `IF` 块
      return !isPlayerLine(node) && pureConditionalBody(node, ctx) === null;
    default:
      return false;
  }
}

/* ------------------------------ 文本行 / 心形（§5.1 / §5.2 / §3.9） ------------------------------ */

/**
 * 列基准（S6）：节点内容在**逻辑全文**里的 0 基码元偏移。
 *
 * `-1` = 该行没有可用的源侧视图（⇒ 本行不记列，退现行级）。行内体（`如果 …： 内容`
 * 的单行形，parser 的合成逻辑行）与块首混写时基准会失配，由 `buildColumnRuns` 的
 * 逐码元相等校验兜底丢弃——本函数只做**便宜的**前缀一致预检，不承诺精确。
 */
function rawBase(em: Emitter, node: TextLine | HeartLine): number {
  const base = node.loc.start.column - 1;
  if (base < 0) return -1;
  return em.viewOf(node.loc.start.line) ? base : -1;
}

/** 该源行的逻辑全文（无视图 ⇒ 空串 ⇒ `identitySpec` 一律定位不到 ⇒ 不记列） */
function viewTextOf(em: Emitter, sourceLine: number): string {
  return em.viewOf(sourceLine)?.text ?? '';
}

/** 节点内容在逻辑全文里的起点（块头 / 注释 / 原生行同一口径） */
function contentBase(node: { loc: { start: { line: number; column: number } } }): number {
  return node.loc.start.column - 1;
}

/** 产物行 = 源文本原样（注释 / 原生直通行）⇒ 一条覆盖整行的恒等区段 */
function verbatimRow(em: Emitter, node: { text: string; loc: { start: { line: number; column: number } } }): RunSpec[] {
  if (!em.viewOf(node.loc.start.line)) return [];
  return verbatimSpec(contentBase(node), node.text.length);
}

function emitTextLine(
  em: Emitter,
  node: TextLine | HeartLine,
  ctx: BodyContext,
  indent: number,
  heart: boolean,
  stripPlayerPrefix = false,
  forceNonD = false,
): void {
  const sourceLine = node.loc.start.line;
  const base = rawBase(em, node);
  const view = em.viewOf(sourceLine);

  // ---- §5.2 第 0 步（前置判定）：纯条件行 → IF 块 ----
  const pure = pureConditionalBody(node, ctx);
  if (pure) {
    const cond = lowerExpression(pure.condText, exprCtx(ctx, pure.condLoc));
    em.push(
      indent,
      `IF ${cond}`,
      sourceLine,
      view ? identitySpec(view.text, pure.condText, base < 0 ? 0 : base, 3) : [],
    );
    const inner = pure.thenText;
    const speech = detectSpeechText(inner);
    // `thenText` 是插值内的字面片段（源里原样存在）；产物把它包进 `PRINTFORM`/`HPH_PRINT`
    // 前缀之后 ⇒ 定位 needle、算出体起始偏移，仍是一段恒等区段。
    const line = heart ? heartCall(inner, speech, node.wait) : printLine(inner, speech, node.wait, ctx);
    const at = inner.length > 0 ? line.indexOf(inner) : -1;
    em.push(
      indent + 1,
      line,
      sourceLine,
      view && at >= 0 ? identitySpec(view.text, inner, base < 0 ? 0 : base, at) : [],
    );
    em.push(indent + 1 - 1, `ENDIF`, null);
    return;
  }

  // ---- 常规：整行文本体转译 ----
  const body = textBody(node, ctx, base);
  // `心形：` 块内的 `你：` 行：只剥行首前缀（色由调用方按 run 口径另发），正文进 `HPH_PRINT` 时不留前缀
  const text = stripPlayerPrefix ? body.raw.replace(PLAYER_PREFIX_RE, '') : body.raw;
  // 剥掉的行首宽度：区段窗口整体左移它，落在前缀内的段丢弃（位移后为负 ⇒ 窗外）
  const stripped = body.raw.length - text.length;
  const windowed = clipAndShift(body.runs, stripped, body.raw.length, 0);
  if (heart) {
    // `forceNonD`：自机台词一律非 D 变体——`dw/dl` 忽略 `SETCOLOR`，上了色也看不见
    const call = heartCallAnchored(text, forceNonD ? true : node.speech, node.wait);
    em.push(
      indent,
      call.line,
      sourceLine,
      call.innerAt < 0
        ? []
        : clipAndShift(windowed, call.innerAt, call.innerAt + call.inner.length, HEART_PRINT_PREFIX.length),
    );
  } else {
    const line = printLine(text, node.speech, node.wait, ctx);
    // 体在产物行里的起始偏移 = 行宽 - 体宽（`printLine` 只在体前加前缀，不削体）
    em.push(indent, line, sourceLine, clipAndShift(windowed, 0, Number.POSITIVE_INFINITY, line.length - text.length));
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
 *
 * `base` ≥ 0 时**顺路记下列区段**（S6）：字面片段是逐码元恒等拷贝 ⇒ 源偏移 = base +
 * 片段起点，产物偏移 = 拼接时的 `out.length`；插值展开位是生成内容 ⇒ 留空（查询端夹紧）。
 */
function textBody(node: TextLine | HeartLine, ctx: BodyContext, base = -1): { raw: string; runs: RunSpec[] } {
  const source = sourceTextOf(node);
  const interps = [...node.interpolations].sort((a, b) => a.loc.start.column - b.loc.start.column);
  let out = '';
  let cursor = 0;
  const runs: RunSpec[] = [];
  // 恒等拷贝一段源文本（同时记区段）
  const copy = (from: number, to: number): void => {
    const slice = source.slice(from, to);
    if (slice.length === 0) return;
    if (base >= 0) runs.push({ generatedOffset: out.length, length: slice.length, sourceOffset: base + from });
    out += slice;
  };
  for (const it of interps) {
    if (it.loc.start.line !== it.loc.end.line) continue;
    copy(cursor, it.loc.start.column - 1);
    out += renderInterpolation(it, ctx);
    cursor = it.loc.end.column - 1;
  }
  copy(cursor, source.length);
  // `scanStrayPercent` 只报诊断、不改文本 ⇒ 区段保持对齐
  return { raw: scanStrayPercent(out, node, ctx), runs };
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
  // 条件别名展开产物 = 行内条件 `\@条件?真#假\@`（`expression.ts` 的
  // `conditionalAliasExpression`）：它是 **FORM 片段**，不是表达式——既不能包 `{}`
  // （`{\@…\@}` 非法）也不能包 `%…%`。原样落进文本，与 `{}` 行内条件同款。
  const inlineCond = lowered.trim();
  if (inlineCond.startsWith('\\@') && inlineCond.endsWith('\\@')) return inlineCond;
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
  // 用户函数调用（B4 批）：按**声明时的返回类型**决定 `%…%`（字符串）/ `{…}`（数值）。
  // 名字已在 `lowerExpression` 里降为产物名；这里只看原文首 token 是否是被声明的函数名。
  const userKind = lookupUserFunctionCall(original, ctx.userFunctions);
  if (userKind !== undefined) return userKind ? `%${lowered}%` : `{${lowered}}`;
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

/**
 * 原文是否以某个**被声明的用户函数**开头并跟 `(`（B4 批）→ 返回该函数的「字符串返回」标志。
 * 未命中 → `undefined`（走既有族判定）。取**最长**匹配名，避免前缀吞并（`问候` vs `问候语`）。
 */
function lookupUserFunctionCall(
  original: string,
  fns?: ReadonlyMap<string, UserFunctionInfo>,
): boolean | undefined {
  if (!fns || fns.size === 0) return undefined;
  const text = original.trim();
  let best: UserFunctionInfo | undefined;
  let bestLen = -1;
  for (const [name, info] of fns) {
    if (name.length <= bestLen || !text.startsWith(name)) continue;
    const rest = text.slice(name.length).replace(/^\s*/, '');
    if (rest.startsWith('(') || rest.startsWith('（')) {
      best = info;
      bestLen = name.length;
    }
  }
  return best ? best.returnsString : undefined;
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
 * 例外：**空文本体**（`空行`）走上面 `printLine` 里的短路径（`L` / `DW`，无 `D` 归属）。
 */
function printLine(text: string, speech: boolean, wait: boolean, ctx: BodyContext): string {
  // **空文本体**（`空行`，规范 §3.3 / 批 P）：空行没有可着色的内容，故 ①忽略 `d`（不落 `D` 后缀）；
  // ②默认**不等待** → 裸 `PRINTFORML`（对齐真实语料 20,244 : 10）；等待形（`空行 等待`）才落 `PRINTFORMDW`。
  // 两种形态都**不留尾随空格**：语料里打空行的写法就是裸指令，多一个空格是平白给 diff 与字节自证添噪。
  if (text.length === 0) return wait ? 'PRINTFORMDW' : 'PRINTFORML';
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
  return `${HEART_PRINT_PREFIX}${inner}","${mode}")`;
}

/** `CALL HPH_PRINT(@"` —— 心形调用里文本体之前的固定前缀（宽 = 文本体在产物行的起始偏移） */
const HEART_PRINT_PREFIX = 'CALL HPH_PRINT(@"';

/**
 * 同 `heartCall`，另给「体原文里 `@""` 内那段文本的起点」（S6 列区段的裁剪窗口）。
 * 引号剥离/`trim` 后找不到定位点（空体）⇒ `-1`，调用方不记列。
 */
function heartCallAnchored(text: string, speech: boolean, wait: boolean): { line: string; inner: string; innerAt: number } {
  const inner = speech ? stripQuotesForHeart(text) : text;
  return { line: heartCall(text, speech, wait), inner, innerAt: inner.length > 0 ? text.indexOf(inner) : -1 };
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
      em.push(indent, `IF ${cond}`, branch.loc.start.line, [
        ...identitySpec(viewTextOf(em, branch.loc.start.line), branch.condition, contentBase(branch), 3),
      ]);
    } else if (branch.kind === 'elseif') {
      const cond = lowerExpression(branch.condition, exprCtx(ctx, branch.loc.start));
      em.push(indent, `ELSEIF ${cond}`, branch.loc.start.line, [
        ...identitySpec(viewTextOf(em, branch.loc.start.line), branch.condition, contentBase(branch), 7),
      ]);
    } else {
      em.push(indent, `ELSE`, branch.loc.start.line);
    }
    emitBody(em, branch.body, ctx, indent + 1);
  }
  em.push(indent, `ENDIF`, null);
}

/* ------------------------------ 当块（§3.6） ------------------------------ */

function emitWhenBlock(em: Emitter, node: WhenBlock, ctx: BodyContext, indent: number): void {
  const subject = lowerExpression(node.subject, exprCtx(ctx, node.loc.start));
  em.push(indent, `SELECTCASE ${subject}`, node.loc.start.line, [
    ...identitySpec(viewTextOf(em, node.loc.start.line), node.subject, contentBase(node), 11),
  ]);
  for (const branch of node.branches) {
    if (branch.kind === 'case') {
      em.push(indent + 1, `CASE ${renderCaseValues(branch.values, ctx, branch.loc.start)}`, branch.loc.start.line);
    } else {
      em.push(indent + 1, `CASEELSE`, branch.loc.start.line);
    }
    emitBody(em, branch.body, ctx, indent + 2);
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
  // P-5：`是 <中文指令名>：` 的裸中文词经 adapter 指令表查编号（与 `时机 指令 <中文名>：`
  // 同表同码；查不到保留原文并报 `timing-instruction-unknown`，绝不猜）。
  const named = resolveCaseValueInstructionName(trimmed, ctx, loc);
  if (named !== undefined) return named;
  return lowerExpression(trimmed, exprCtx(ctx, loc));
}

/**
 * 是否为**裸单词指令名形态**：整串是一个标识符（字符集走 `identifier-chars` 单一真源）、
 * 至少含一个 CJK、且不是保留代词（`她`/`你`——它们降糖成 `%CALLNAME:…%`，不属指令名申说）。
 * 带冒号索引（`TCVAR:20`）、带空白/括号（`首次(SELECTCOM)`、`5 到 8`）、纯 ASCII（`20`、
 * `SELECTCOM`）一律**不算**——既有路径逐字节不动。
 */
function isBareCjkIdentifier(s: string): boolean {
  if (!CJK.test(s)) return false;
  if (RESERVED_PRONOUNS.includes(s)) return false;
  if (s.length === 0 || !isIdentStart(s[0]!)) return false;
  for (const ch of s) if (!isIdentPart(ch)) return false;
  return true;
}

/**
 * P-5：`CASE` 值位置的指令名查表（复用 `时机 指令 <中文名>` 的同一条通道——
 * adapter 的 `KojoInstructionTable.lookupByName`，糖侧不内建任何游戏知识）。
 *
 * - 命中 → 编号字符串（`接吻` → `20`）；
 * - 查不到 → **不立刻报错**：`她的恋慕` 这类属性糖同样是裸中文词，常规降糖能解析
 *   （探针跑一次 `lowerExpression`，零 error 即放行原样，前后产物逐字节一致）；
 * - 查不到**且**常规降糖也失败（裸中文词既不在指令表也不是可解析变量）→ 报
 *   `timing-instruction-unknown`（复用 HK-11② 的码，不新增），产物**保留原文**——
 *   绝不把名字换成猜来的编号（fail-closed，规范 §5.3 精神）。
 */
function resolveCaseValueInstructionName(
  trimmed: string,
  ctx: BodyContext,
  loc: { line: number; column: number },
): string | undefined {
  if (!isBareCjkIdentifier(trimmed)) return undefined;
  const no = ctx.instructionTable?.lookupByName(trimmed);
  if (no !== undefined) return String(no);

  const probeErrors: SugarDiagnostic[] = [];
  const lowered = lowerExpression(trimmed, {
    aliases: ctx.aliases,
    dictionary: ctx.dictionary,
    libraryTable: ctx.libraryTable,
    report: (d) => {
      if (d.severity === 'warning') ctx.sink.report(d);
      else probeErrors.push(d);
    },
    loc,
  });
  if (probeErrors.length === 0) return lowered;

  ctx.sink.report({
    code: 'timing-instruction-unknown',
    severity: 'error',
    message:
      `「当」块的「是」值「${trimmed}」不在当前工程的指令表里（CSV/Train.csv），也不是可解析的变量写法。` +
      '为避免产出无效 ERB，本值已保留原文、未换成编号——请改用数字（`是 20：`），' +
      '或确认该指令名出现在当前项目的 Train.csv 里（换汉化/魔改包即换表）。',
    loc,
  });
  return trimmed;
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
  // P-4 直出形（文件头 `随机形: 直出`）：`SELECTCASE RAND:n` 直出，不占 `LOCAL` 槽。
  if (randomShapeOf(node) === 'direct') {
    em.push(indent, `SELECTCASE RAND:${count}`, node.loc.start.line);
    node.alternatives.forEach((alt, i) => {
      em.push(indent + 1, `CASE ${i}`, alt.loc.start.line);
      emitBody(em, alt.body, ctx, indent + 2);
    });
    em.push(indent, `ENDSELECT`, null);
    return;
  }
  const slot = slotName(ctx.allocator.allocate());
  em.push(indent, `${slot} = RAND:${count}`, node.loc.start.line);
  em.push(indent, `SELECTCASE ${slot}`, null);
  ctx.allocator.enter();
  node.alternatives.forEach((alt, i) => {
    em.push(indent + 1, `CASE ${i}`, alt.loc.start.line);
    emitBody(em, alt.body, ctx, indent + 2);
  });
  ctx.allocator.exit();
  em.push(indent, `ENDSELECT`, null);
}

/** 随机行内简写（§3.6）：与块形态同构（`RAND:n` + SELECTCASE） */
function emitRandomInline(em: Emitter, node: RandomInline, ctx: BodyContext, indent: number): void {
  const count = node.alternatives.length;
  // P-4 直出形同块形态（`随机形: 直出`）。
  if (randomShapeOf(node) === 'direct') {
    em.push(indent, `SELECTCASE RAND:${count}`, node.loc.start.line);
    node.alternatives.forEach((raw, i) => {
      em.push(indent + 1, `CASE ${i}`, node.loc.start.line);
      const text = stripOuterQuotes(raw);
      const speech = detectSpeechText(text);
      em.push(indent + 2, printLine(text, speech, true, ctx), node.loc.start.line);
    });
    em.push(indent, `ENDSELECT`, null);
    return;
  }
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

/** 读取随机节点上的产物模式标记（parser 附 `_randomShape`；缺省 = 旧形） */
function randomShapeOf(node: RandomBlock | RandomInline): RandomShape {
  return (node as { _randomShape?: RandomShape })._randomShape === 'direct' ? 'direct' : 'default';
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
 * 选项块（规范 §3.7）——按钮形：
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
    emitBody(em, item.body, ctx, indent + 2);
  });
  em.push(indent, `ENDSELECT`, null);
}

/**
 * 菜单块（数字输入菜单形）的产物——**逐字照语料主流写法**。
 *
 * 语料实测（全 ERB 1,770 处裸 `INPUT`）：主流是**标签回跳环**（`$标签` 紧贴 `INPUT`
 * 之前、无效输入 `GOTO` 回跳，量 ~590 处），远多于 `DO`/`LOOP` 环（~105 处）；标签
 * 命名以 `INPUT_LOOP` 为首（43 处）；菜单项打印命令 `PRINTL` 居首（1,186 行）。
 * 故产物取：
 * ```
 * PRINTL [1] 标签          ← 编号项（普通打印，非 PRINTBUTTON）
 * …
 * $INPUT_LOOP             ← 回跳落点（紧贴 INPUT 之前；项打印在其上方，回跳不重打印）
 * INPUT
 * SELECTCASE RESULT       ← 引擎约定变量是 RESULT（INPUT），不是按钮形的 RESULTS
 *     CASE 1
 *         …
 *     CASEELSE
 *         GOTO INPUT_LOOP ← 无效/默认分支回菜单；正常分支透出 ENDSELECT 即退出
 * ENDSELECT
 * ```
 */
function emitMenuBlock(em: Emitter, node: MenuBlock, ctx: BodyContext, indent: number): void {
  node.items.forEach((item, i) => {
    em.push(indent, `PRINTL [${i + 1}] ${item.label}`, item.loc.start.line);
  });
  em.pushGenerated(indent, `$INPUT_LOOP`);
  em.pushGenerated(indent, `INPUT`);
  em.pushGenerated(indent, `SELECTCASE RESULT`);
  node.items.forEach((item, i) => {
    em.push(indent + 1, `CASE ${i + 1}`, item.loc.start.line);
    emitBody(em, item.body, ctx, indent + 2);
  });
  em.pushGenerated(indent + 1, `CASEELSE`);
  em.pushGenerated(indent + 2, `GOTO INPUT_LOOP`);
  em.pushGenerated(indent, `ENDSELECT`);
}

/* ------------------------------ 问答块（询问 / 确认） ------------------------------ */

/**
 * `询问` / `确认` 块的产物——**引擎封装问答函数调用**（函数名 / 参数 / 读回变量由 adapter 声明，
 * 糖里零硬编码）。形态**逐字照语料主流写法**（`CALL ASK_M(...)` / `CALL ASK_YN(...)` +
 * `SELECTCASE RESULT` + `CASE 0..n-1` + `ENDSELECT`）：
 * ```
 * <提示行（可选，经 emitBody）>
 * CALL ASK_M("甲",1,"乙",1)   ← 逐项 `标签,逐项显示条件`（无空格、ASCII 双引号）；条件取自槽、缺省用模板值
 * SELECTCASE RESULT           ← 读回变量名由 adapter 声明
 *     CASE 0
 *         …
 *     CASE 1
 *         …
 * ENDSELECT
 * ```
 *
 * fail-closed（不产半成品）：
 * - adapter 未声明问答模板（`faceTable.ask`）→ `face-table-missing`（error），一条字节都不产；
 * - 项数不满足模板 `minOptions`/`maxOptions` → 复用 `block-empty`（error），不产半成品；
 * - 模板 `option` 不含 `{value}`（二择形）却写了逐项显示条件 / 多选形却无从取值 → 复用 `block-empty`（error），不产半成品。
 *
 * 复用既有诊断码（`SugarDiagnosticCode` 是闭集，绝不新增）。
 */
function emitAskBlock(em: Emitter, node: AskMBlock | AskYNBlock, ctx: BodyContext, indent: number): void {
  const isYN = node.kind === 'askYNBlock';
  const blockName = isYN ? '确认' : '询问';
  const form = isYN ? ctx.faceTable?.ask?.askYN : ctx.faceTable?.ask?.askM;
  if (!form) {
    ctx.sink.report({
      code: 'face-table-missing',
      severity: 'error',
      message: `写了「${blockName}：」块，但当前适配器未声明问答函数模板——已忽略（不产半成品）。`,
      loc: node.loc.start,
    });
    return;
  }
  const usesValue = form.option.includes('{value}');
  if (node.items.length > 0 && node.items.length < form.minOptions) {
    ctx.sink.report({
      code: 'block-empty',
      severity: 'error',
      message: `「${blockName}」块至少需要 ${form.minOptions} 个选项。`,
      loc: node.loc.start,
    });
    return;
  }
  if (form.maxOptions !== undefined && node.items.length > form.maxOptions) {
    ctx.sink.report({
      code: 'block-empty',
      severity: 'error',
      message: `「${blockName}」块最多 ${form.maxOptions} 个选项。`,
      loc: node.loc.start,
    });
    return;
  }
  if (!usesValue && node.items.some((it) => it.value !== undefined)) {
    ctx.sink.report({
      code: 'block-empty',
      severity: 'error',
      message: `「${blockName}」块的条目不接受逐项显示条件（引擎函数只收标签）——已忽略，不产半成品。`,
      loc: node.loc.start,
    });
    return;
  }
  if (usesValue && form.defaultValue === undefined && node.items.some((it) => it.value === undefined)) {
    ctx.sink.report({
      code: 'block-empty',
      severity: 'error',
      message: `「${blockName}」块的每个条目都必须写逐项显示条件（当前适配器未提供缺省值）。`,
      loc: node.loc.start,
    });
    return;
  }
  // 头部可选提示行：经 emitBody 发（文本行管线——插值 / 台词色都照常）
  if (node.prompt) emitBody(em, [node.prompt], ctx, indent);
  const opts = node.items.map((item) => {
    const labelLiteral = JSON.stringify(item.label);
    if (!usesValue) return form.option.replace('{label}', labelLiteral);
    const value = lowerExpression(item.value ?? form.defaultValue ?? '', exprCtx(ctx, item.loc.start));
    return form.option.replace('{label}', labelLiteral).replace('{value}', value);
  });
  em.push(indent, form.call.replace('{options}', opts.join(',')), node.loc.start.line);
  em.pushGenerated(indent, `SELECTCASE ${form.result}`);
  node.items.forEach((item, i) => {
    em.push(indent + 1, `CASE ${i}`, item.loc.start.line);
    emitBody(em, item.body, ctx, indent + 2);
  });
  em.pushGenerated(indent, `ENDSELECT`);
}

/* ------------------------------ 着色块（§3.9） ------------------------------ */

function emitColorBlock(em: Emitter, node: ColorBlock, ctx: BodyContext, indent: number): void {
  em.push(indent, `SETCOLOR ${node.color}`, node.loc.start.line);
  // 块体在块色下发射：块内自机台词 run 收尾须复原到**块色**（而非默认色），故暂存并换环境色。
  const prevAmbient = ctx.ambientColor;
  ctx.ambientColor = node.color;
  emitBody(em, node.body, ctx, indent);
  ctx.ambientColor = prevAmbient;
  // 收尾复原到**上一层**的环境色（嵌套 `着色` 块逐层回退）；顶层无环境色才打 `RESETCOLOR`。
  // 与自机台词 run 的收尾同一口径——裸 `RESETCOLOR` 会把外层块色一起抹掉。
  em.push(indent, ambientRestoreLine(ctx), null);
}

/* ------------------------------ 心形连续块（P-7） ------------------------------ */

/**
 * `心形：` 连续块（P-7）——块体**逐行**产 `CALL HPH_PRINT(@"…","<mode>")`。
 *
 * 复用单行形的发射管线（`emitTextLine(..., heart=true)` → `heartCall`），故模式字母
 * 规则与 `心形 「…」` 逐字一致；`{条件 ? A}` 这类**纯条件行**也照常折成 `IF` 块
 * （与文本行同源）。块体逐行**顺序展开**——无包装行。
 *
 * **宁缺勿编**：`_invalid` 为真（块体混入了非文本行）时**一条字节都不产**——
 * 半成品比没有更坏（§5.3 口径）。
 *
 * **`你：` 行（B1 口径）**：块内行首写 `你：` 即自机台词——前缀**剥掉**（不进 `@"…"`），
 * 色按 `emitBody` 同一 run 规则发（连续 `你：` 行只发一次 `SETCOLOR <自机色>`，run 结束
 * 复原环境色/默认），且模式字母**强制非 D**（`dw/dl` 忽略 `SETCOLOR`，上了色也看不见）。
 * 自机色仍走 `resolvePlayerColor`：文件头 `自机色:` 优先，否则 adapter 缺省，两者皆缺才报
 * `face-table-missing` 并退化成该块原本的 D 系打印（前缀照剥，不静默带前缀输出）。
 */
function emitHeartBlock(em: Emitter, node: HeartBlock, ctx: BodyContext, indent: number): void {
  if (node._invalid) return;
  let run = false; // 块内生效的 `你：` 自机色 run（与 `emitBody` 同一口径：连续行只发一次 SETCOLOR）
  const closeRun = (): void => {
    if (run) {
      em.push(indent, ambientRestoreLine(ctx), null);
      run = false;
    }
  };
  for (const child of node.body) {
    if (child.kind === 'comment') {
      closeRun();
      em.push(indent, child.text, child.loc.start.line, verbatimRow(em, child));
      continue;
    }
    // 块体在 parser 段已保证只有「文本行（`heartLine`）/ 注释」两类（`_invalid` 拦下其余）
    const line = child as TextLine | HeartLine;
    // `你：` 行照旧走心形管线（块的打印家族不变），但前缀要剥、色按自机色发
    if (!isPlayerHeartLine(line)) {
      closeRun();
      emitTextLine(em, line, ctx, indent, true);
      continue;
    }
    const color = resolvePlayerColor(line, ctx);
    if (color === null) {
      // 未声明 `自机色:` 且 adapter 无缺省 → 退化：仍打印（已报 `face-table-missing`），只收掉 run
      closeRun();
    } else if (!run) {
      em.push(indent, `SETCOLOR ${color}`, line.loc.start.line);
      run = true;
    }
    emitTextLine(em, line, ctx, indent, true, true, color !== null);
  }
  closeRun();
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
      em.push(indent, branch.kind === 'if' ? `IF ${cond}` : `ELSEIF ${cond}`, branch.loc.start.line, [
        ...identitySpec(
          viewTextOf(em, branch.loc.start.line),
          branch.condition,
          contentBase(branch),
          branch.kind === 'if' ? 3 : 7,
        ),
      ]);
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
    libraryTable: ctx.libraryTable,
    report: (d: SugarDiagnostic) => ctx.sink.report(d),
    loc,
    charNo: ctx.frontMatter.charNo,
    argSlotCount: ctx.argSlotCount,
  };
}

/** 需要的最小节点类型（避免宽泛 import） */
type RawLineNode = Extract<SugarNode, { kind: 'rawLine' }>;
