/**
 * 跳转可达性建模（2026-11-06 状态回放边界批 2 · 车道 W；游戏无关；本插件私有；纯函数、零 IO）。
 *
 * ## 为什么要有这一层
 *
 * 上一批把**写点**交回面板时，只有一条直线扫描：`GOTO` 跳过的区间照报，跳转本身则按
 * "后面还有写点"笼统标成 `kind:'jump'`（不确定面）。作者读到的信息是"这函数里有跳转，
 * 后面可能写也可能不写"——等于没说。本模块把**能证明的可达性**建出来：
 * 静态字面量标签的跳转按图走，跳过去之后的行才算可达；只有**动态**跳转（目标算不出来）
 * 才退回保守全可达。于是
 *
 * - 静态 `GOTO` 跳过的死区间里的写 ⇒ 不可达 ⇒ 不报（少误报）；
 * - 静态 `GOTO` 目标之后的可达写 ⇒ 照报（不漏报）；
 * - 动态 `GOTO` ⇒ 目标不可知 ⇒ 该行之后一律按可达（**不误杀**：宁可多报一行，也不许
 *   把真写点藏起来——面板拿它给结论打「近似」，藏一行就是给假信心）。
 *
 * ## 判据
 *
 * 窗口 = `[startLine, endLine]`（1 基、闭区间；超文件长度按文件截断）。只在这个窗口里
 * 建标签、建边——标签是**函数局部**作用域，窗口外同名标签不算数。
 *
 * 1. **标签行**：`trim`（必要时剥 `;!;` / `;#;` 代码前缀）后以 `$` 起首；名字到空白或
 *    `;` 为止（与 `parseErbText` 的 `parseLabelDefinition` 同口径），去掉尾随 `:`（语料
 *    存在 `$LABEL:` 写法）。**同名取第一处**（引擎也是从入口向下找第一个）。
 * 2. **默认边**：`行 → 下一行`（顺序流）。
 * 3. **静态跳转**：`GOTO` / `JUMP` 后接裸标签字面量且该标签在本窗口内存在 ⇒ 连
 *    `行 → 标签行`（`resolvedJumps`）。
 *    目标不是裸字面量（`(X)` / `%X%` / `"X"` / 空 / 纯数字行号 / `X:Y` 成员形）或标签
 *    在窗口内不存在 ⇒ `dynamicJumps`，并**从该行起**把窗口内其余行全部标可达（保守）。
 *    注意"从该行起"以**走到该行**为前提：位于死代码里的动态跳转不复活后面的行
 *    （否则 `RETURN` 之后一行永不可达的 `GOTO %X%` 会把整段死代码重新点亮）。
 *    `GOTOFORM` / `JUMPFORM` 的目标是算出来的 ⇒ 恒为动态。
 * 4. **条件跳转**：`TRYGOTO*` / `TRYJUMP*` 一族（含 `TRYC*` 与 `*LIST` 变体）⇒
 *    `conditionalJumps`，**不产生边、不改变可达性**（跳不跳得成两条边都可能：顺序落到
 *    下一行照常，目标侧不额外标可达）。
 * 5. **块终止**：**无条件** `RETURN` / `RETURNF` / `RETURNFORM` ⇒ 该行不落下一行
 *    （`stops`）。`BREAK` / `CONTINUE` 仍落下一行（循环语义不在本模块建模）。
 * 6. 注释 / 空行 / `@` 函数头 / `#` 指令行 / `[SKIPSTART]`…`[SKIPEND]` 区：**不建标签、
 *    不算跳转、不算块结构**，但按顺序流处理（不阻塞）。SKIP 区间内的一切判据都不生效
 *    （引擎不编译）。
 * 7. 复杂度 O(窗口行数)：一次标签/边扫描 + 一次 BFS（栈 + Set，不递归、不建邻接表）。
 *
 * ## 取舍：只有"无条件直线控制流"才允许抹掉下一行
 *
 * 本模块**没有**建模 IF/ENDIF 的括号边（真值分支怎么走不在射程内），所以只要一行
 * "可能不执行"，它的 `GOTO` / `RETURN` 就**不许**抹掉顺序边——否则会把真写点藏起来。
 * 判据落成两枚极简状态（都是一次扫描内的 O(1) 更新）：
 *
 * - **块深度**：`IF` / `WHILE` / `FOR` / `SELECTCASE` / `REPEAT` / `DO` +1，
 *   `ENDIF` / `WEND` / `NEXT` / `ENDSELECT` / `REND` / `LOOP` −1（配不上的收尾压到 0）；
 * - **SIF 守护**：`SIF` 只护**下一行**（单行条件，没有 ENDIF）。
 *
 * 于是：块内 / SIF 守护下的静态 `GOTO` ⇒ 目标边**与**顺序边都算（`softJumps`，仍然
 * `resolvedJumps`，不进"不确定面"）；块内 / SIF 守护下的 `RETURN` ⇒ 不算块终止。
 * 只有顶格无条件的那条 `GOTO` / `RETURN` 才按"只连标签 / 到此为止"处理。
 *
 * **为什么必须这样**（真语料 eraTW 4.981 实测，1,200 份 ERB / 9,109 段函数）：
 * 按"字面直线"建模（块内 RETURN 也终止、块内 GOTO 只连标签）时写点从 55,074 掉到
 * 43,071（−22%），而掉的那批绝大多数是**活代码**——era 的口上/指令函数里
 * `IF cond / RETURN / ENDIF` 与 `SIF cond / GOTO RETRY` 是主流写法，线条流建模会把
 * ENDIF 之后的整段判死。写点少报 = 面板谎报"结论可信"，是本模块最不能犯的错；
 * 加这两枚状态后读数回到 54,9xx 量级（见批次回执）。代价只有每行一次首字母 dispatch。
 *
 * ## 上层怎么用（`writes.ts`）
 *
 * - `reachable.has(line)` 为假的写点一律不报（不可达 = 写不发生）；
 * - 只有 `dynamicJumps` 里的行、且其后仍有可达写点，才报 `kind:'jump'`；
 *   `resolvedJumps` 已经由本模块建模，不再进"不确定面"。
 */
import { MODEL_TOKEN_CLASS } from '@kojo/plugin-api';

/** 跳转可达性读数（`writes.ts` 消费；只读） */
export interface ReachabilityReading {
  /** 区间内可达行（1 基，闭区间） */
  reachable: ReadonlySet<number>;
  /** 动态跳转行（`GOTO` 后无静态标签 / 目标标签不存在）：这些行之后一律按可达（保守） */
  dynamicJumps: readonly number[];
  /** 静态解析成功的跳转行（这些不再算"不确定面"） */
  resolvedJumps: readonly number[];
  /** 条件跳转行（`TRYGOTO`/`TRYJUMP` 一族：两条边都算，不限制可达性） */
  conditionalJumps: readonly number[];
}

/**
 * **跳转族**（平跳形；2026-11-05 边界批的 `JUMP_INSTRUCTIONS` 从这里出）。
 *
 * 名字逐条对引擎指令表（`erb-parser/src/instructions.ts` 的 `ERB_INSTRUCTION_NAMES`），
 * 测试用那张表钉住。`TRYGOTO*` / `TRYJUMP*` 是条件跳转，单独一张表（见下）。
 * 移到本模块只为"谁建模跳转、谁持有跳转词表"只有一份（`writes.ts` 原样再导出）。
 */
export const JUMP_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'GOTO',
  'GOTOFORM',
  'JUMP',
  'JUMPFORM',
]);

/**
 * **条件跳转族**（`TRYGOTO*` / `TRYJUMP*` 一族；引擎表逐条对过）。
 *
 * 名字 = 引擎指令表里所有 `TRYC?(GOTO|JUMP)` 起首的动词（`*FORM` / `*LIST` 变体都算），
 * 测试用那张表钉住等式，防手写漂移。语义：跳得成 / 跳不成两条边都可能 ⇒ 本模块只登记
 * （`conditionalJumps`）不限制可达性。
 */
export const CONDITIONAL_JUMP_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCGOTOFORM',
  'TRYCJUMP',
  'TRYCJUMPFORM',
  'TRYGOTO',
  'TRYGOTOFORM',
  'TRYGOTOLIST',
  'TRYJUMP',
  'TRYJUMPFORM',
  'TRYJUMPLIST',
]);

/** `FORM` 变体：目标是表达式算出来的，永远是动态跳转 */
const FORM_JUMP_INSTRUCTIONS: ReadonlySet<string> = new Set(['GOTOFORM', 'JUMPFORM']);

/**
 * **块终止候选动词**（`RETURN` 族；引擎表逐条对过：`RETURN` / `RETURNF` / `RETURNFORM`）。
 *
 * 这里只是"候选"：真终止还得看它是不是**无条件直线**（块内 / SIF 守护下 / catch 区里
 * 的 `RETURN` 只是"可能返回"）。`writes.ts` 用同一枚表当可达性的**触发位**
 * （窗口里有非末行的 RETURN ⇒ 值得跑一次可达性），单源一份、不各写各的。
 */
export const RETURN_STOP_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'RETURN',
  'RETURNF',
  'RETURNFORM',
]);

/** 记号游标（sticky：免 `slice` 分配，直接从下标处起读一段 Unicode 名字；字符集单源 = 契约 `MODEL_TOKEN_CLASS`） */
const LABEL_RUN_STICKY = new RegExp(`${MODEL_TOKEN_CLASS}+`, 'uy');

/** 纯数字名字不认：`GOTO 123` 在引擎里是**行号**目标，本模块不跟自己猜 */
const LABEL_NAME_DIGITS = /^\p{N}+$/u;

/**
 * 「连续行」集合（`[from, to]` 闭区间；空区间 `from > to`）。
 *
 * 为什么要这枚惰性实现：本模块最常见的读数是"整段都可达"（无跳转、无早退）。给 600 行
 * 的函数造一枚 600 项的 `Set` 要 ~0.03ms/次，而判据本身只需要 `has()` 和一次 `size`
 * 比较 ⇒ 用区间表示既**语义等价**（它就是那个集合），又只花一次对象分配。
 * 接口面如实实现 `ReadonlySet`（迭代器惰性生成），消费方不必知道底下是什么。
 */
class LineRange implements ReadonlySet<number> {
  constructor(
    private readonly from: number,
    private readonly to: number,
  ) {}

  get size(): number {
    return this.to >= this.from ? this.to - this.from + 1 : 0;
  }

  has(value: number): boolean {
    return Number.isInteger(value) && value >= this.from && value <= this.to;
  }

  forEach(callbackfn: (value: number, value2: number, set: ReadonlySet<number>) => void, thisArg?: unknown): void {
    for (let v = this.from; v <= this.to; v++) callbackfn.call(thisArg, v, v, this);
  }

  *entries(): IterableIterator<[number, number]> {
    for (let v = this.from; v <= this.to; v++) yield [v, v];
  }

  *keys(): IterableIterator<number> {
    for (let v = this.from; v <= this.to; v++) yield v;
  }

  *values(): IterableIterator<number> {
    for (let v = this.from; v <= this.to; v++) yield v;
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this.values();
  }

  get [Symbol.toStringTag](): string {
    return 'LineRange';
  }
}

/** 空读数（非法 / 落空区间共用一枚，零分配） */
const EMPTY_READING: ReachabilityReading = Object.freeze({
  reachable: new LineRange(1, 0),
  dynamicJumps: Object.freeze([]) as readonly number[],
  resolvedJumps: Object.freeze([]) as readonly number[],
  conditionalJumps: Object.freeze([]) as readonly number[],
});

/** 窗口内的临时读数（扫描阶段攒，BFS 阶段消费） */
interface ScanTemps {
  /** 标签名（大写归一）→ 行号（同名取第一处） */
  readonly labels: Map<string, number>;
  /** 静态跳转：行 → 目标标签行（窗口外目标也收，BFS 时不展开） */
  readonly jumpTo: Map<number, number>;
  /** **软**静态跳转（带条件的 GOTO：目标边与顺序边都算，见文件头"取舍"） */
  readonly softJumps: Set<number>;
  /** 动态跳转行（升序） */
  readonly dynamic: number[];
  /** 静态解析成功的跳转行（升序） */
  readonly resolved: number[];
  /** 条件跳转行（升序） */
  readonly conditional: number[];
  /** 块终止行（**无条件** `RETURN` 族） */
  readonly stops: Set<number>;
}

/** 待解析的静态跳转（`GOTO 名字`；前向跳转要等整窗口扫完才知道标签在不在） */
interface PendingJump {
  readonly line: number;
  readonly token: string;
  /** 带条件（块内 / SIF 守护）：标签存在时**两条边都算**，不抹掉顺序边 */
  readonly soft: boolean;
}

/** 扫描期的控制流状态（块深度 + SIF 守护 + catch 区） */
interface FlowState {
  /** `IF`/`WHILE`/`FOR`/`SELECTCASE`/`REPEAT`/`DO` 的嵌套深度（>0 = 当前行在条件块里） */
  depth: number;
  /** `SIF` 守护下一行（单行条件：只护一条语句） */
  sifGuard: boolean;
  /** 在 `CATCH … ENDCATCH` 区里（只有出错才会走到 ⇒ 区内一切都不是"无条件"） */
  inCatch: boolean;
}

/** 首字符是 ASCII 字母（大小写都算；ERB 关键字大小写不敏感） */
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** 关键字边界：其后必须是空白 / `(` / `;` / 行尾，防止 `IF` 吞掉 `IF_DEBUG` / `RETURN_FOO` 一类长名 */
function keywordBoundary(raw: string, end: number): boolean {
  if (end >= raw.length) return true;
  const c = raw.charCodeAt(end);
  return c === 32 || c === 9 || c === 0x3000 || c === 40 || c === 59;
}

/** `raw` 在 `at` 处是否以 ASCII 关键字 `kw`（大写）起首，且带合法边界（大小写不敏感） */
function isKeywordAt(raw: string, at: number, kw: string): boolean {
  const end = at + kw.length;
  if (end > raw.length) return false;
  for (let i = 0; i < kw.length; i++) {
    const c = raw.charCodeAt(at + i);
    const upper = c >= 97 && c <= 122 ? c - 32 : c;
    if (upper !== kw.charCodeAt(i)) return false;
  }
  return keywordBoundary(raw, end);
}

/** 行首前导空白宽度（`trimStart` 的免分配版：只认空格 / 制表符 / 全角空格） */
function leadingBlankWidth(raw: string): number {
  let i = 0;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 0x3000) break;
    i++;
  }
  return i;
}

/** `raw` 从 `at` 起是否恰好是 `marker`（其后只许空白 / 行尾；`[SKIPSTART]` 一族按严格等值判） */
function isMarkerAt(raw: string, at: number, marker: string): boolean {
  if (at + marker.length > raw.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (raw.charCodeAt(at + i) !== marker.charCodeAt(i)) return false;
  }
  for (let i = at + marker.length; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 0x3000) return false;
  }
  return true;
}

/** `$` 标签定义行的名字（大写归一；空名字 → null）。与 `parseLabelDefinition` 同口径 + 去尾 `:` */
function labelNameOf(raw: string, at: number): string | null {
  let end = raw.length;
  for (let i = at + 1; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 32 || c === 9 || c === 0x3000 || c === 59) {
      end = i;
      break;
    }
  }
  let name = raw.slice(at + 1, end).trim();
  // `$LABEL:` —— 语料存在冒号后缀写法（冒号不是名字的一部分）
  if (name.endsWith(':') || name.endsWith('：')) name = name.slice(0, -1);
  return name.length > 0 ? name.toUpperCase() : null;
}

/**
 * 跳转目标槽里的**裸标签字面量**（无 ⇒ null）：关键字之后只许空白，目标必须是整段标识符
 * （Unicode 字母/数字/下划线），且其后只能是行尾 / `;` 注释。
 *
 * 与 `symbols.ts::jumpSlotOf` 同一条判据（动态形态 `(X)` / `%X%` / `"X"` / `X:Y` 一律不认，
 * 纯数字按引擎行号目标处理）。多一个"其后必须干净"的收紧：`GOTO A + 1` 这类看不懂的尾巴
 * 直接当动态，不猜。
 */
function staticJumpTargetOf(raw: string, afterVerb: number): string | null {
  let i = afterVerb;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 0x3000) break;
    i++;
  }
  if (i >= raw.length) return null;
  LABEL_RUN_STICKY.lastIndex = i;
  const run = LABEL_RUN_STICKY.exec(raw);
  if (run === null) return null;
  const token = run[0];
  if (LABEL_NAME_DIGITS.test(token)) return null;
  let after = i + token.length;
  const c = raw.charCodeAt(after);
  if (c === 58 || c === 0xff1a) return null; // `:` / `：` ⇒ 成员访问 / 动态
  while (after < raw.length) {
    const d = raw.charCodeAt(after);
    if (d !== 32 && d !== 9 && d !== 0x3000) break;
    after++;
  }
  // 尾巴只许行尾或 `;` 注释
  if (after < raw.length && raw.charCodeAt(after) !== 59) return null;
  return token;
}

/** `raw` 从 `at` 起的行首动词（`[A-Za-z_][A-Za-z0-9_]*`，免分配扫描；无 → null） */
function leadingVerbOf(raw: string, at: number): { verb: string; end: number } | null {
  const c0 = raw.charCodeAt(at);
  if (!isAsciiLetter(c0)) return null;
  let i = at + 1;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (!(isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 95)) break;
    i++;
  }
  return { verb: raw.slice(at, i).toUpperCase(), end: i };
}

/**
 * 行首字符粗筛表：只给这些字符起首的行才做控制流判定。
 *
 * - `$`（标签定义）；
 * - 可能开/关块的字母：`C`（CATCH）`D`（DO）`E`（ENDIF / ENDSELECT / ENDCATCH）
 *   `F`（FOR）`I`（IF）`L`（LOOP）`N`（NEXT）`R`（RETURN 族 / REPEAT / REND）
 *   `S`（SELECTCASE / SIF）`W`（WHILE / WEND）；
 * - 跳转族首字母：`G`（GOTO 族）`J`（JUMP 族）`T`（TRYGOTO 族 / TRYJUMP 族）。
 *
 * 大小写都登记（ERB 关键字大小写不敏感）。表外字符 ⇒ 这行既不可能建标签，也不可能
 * 改块结构或建跳转边，直接跳过（`PRINTL` / 赋值 / 空行占真语料绝大多数）。
 */
const CONTROL_FLOW_LEAD: Uint8Array = (() => {
  const table = new Uint8Array(128);
  for (const ch of '$CDEFGIJLNRSTW') {
    table[ch.charCodeAt(0)] = 1;
    table[ch.toLowerCase().charCodeAt(0)] = 1;
  }
  return table;
})();

/**
 * 窗口内（含 SKIP 区判定）扫描一次：标签表 + 跳转边 + 块终止行。
 *
 * 与 `writes.ts` 同口径：`trim` 后必要时剥 `;!;` / `;#;` 代码前缀；`[SKIPSTART]` /
 * `[SKIPEND]` 按严格等值判。SKIP 区内不建标签、不算跳转（引擎不编译那些行）。
 * 全程按 `raw + 偏移` 走，正常代码行**零字符串分配**。
 */
function scanWindow(lines: readonly string[], first: number, last: number): ScanTemps {
  const labels = new Map<string, number>();
  const jumpTo = new Map<number, number>();
  const softJumps = new Set<number>();
  const dynamic: number[] = [];
  const resolved: number[] = [];
  const conditional: number[] = [];
  const stops = new Set<number>();
  /** 静态字面量目标、等标签表齐了再解析（前向跳转是常态，不能边扫边判） */
  const pending: PendingJump[] = [];
  /** 条件块深度 + SIF 守护（只用来区分"无条件直线控制流"与"可能不执行"） */
  const flow: FlowState = { depth: 0, sifGuard: false, inCatch: false };
  let inSkip = false;
  for (let ln = first; ln <= last; ln++) {
    const raw = lines[ln - 1];
    if (raw === undefined) break;
    const at = leadingBlankWidth(raw);
    if (at >= raw.length) continue; // 空行（不建边也不阻塞）
    const c0 = raw.charCodeAt(at);
    if (inSkip) {
      if (c0 === 91 && isMarkerAt(raw, at, '[SKIPEND]')) inSkip = false;
      continue;
    }
    if (c0 === 91 && isMarkerAt(raw, at, '[SKIPSTART]')) {
      inSkip = true;
      continue;
    }
    if (c0 === 59) {
      // 注释 or `;!;` / `;#;` 代码前缀（只有这两种前缀后的正文算代码）
      if (at + 3 > raw.length) continue;
      const c1 = raw.charCodeAt(at + 1);
      const c2 = raw.charCodeAt(at + 2);
      if (!((c1 === 33 || c1 === 35) && c2 === 59)) continue; // `;!;` / `;#;`
      scanCodeLine(raw, at + 3, ln, labels, pending, dynamic, conditional, stops, flow);
      continue;
    }
    // 首字母粗筛：只有这些字母起首的行才可能建标签 / 建跳转边 / 改块结构。
    // 其余行（`PRINTL` / `CFLAG:` 一类读行与赋值）连内层函数都不进——语义上它们本来就
    // 不建标签、不算跳转（本层唯一的性能取舍，见文件头）。
    if (c0 < 128 && CONTROL_FLOW_LEAD[c0] === 0) continue;
    scanCodeLine(raw, at, ln, labels, pending, dynamic, conditional, stops, flow);
  }
  // 标签表齐全 ⇒ 解析待定跳转：找得到 = 静态边；找不到 = 动态（保守，后面全可达）
  const pendingCount = pending.length;
  for (let i = 0; i < pendingCount; i++) {
    const jump = pending[i]!;
    const target = labels.get(jump.token);
    if (target === undefined) {
      dynamic.push(jump.line);
      continue;
    }
    jumpTo.set(jump.line, target);
    if (jump.soft) softJumps.add(jump.line);
    resolved.push(jump.line);
  }
  if (dynamic.length > 1) dynamic.sort(ascending);
  return { labels, jumpTo, softJumps, dynamic, resolved, conditional, stops };
}

/** 升序（行号数组；`dynamic` 由扫描期与解析期两段拼成，必须归一） */
function ascending(a: number, b: number): number {
  return a - b;
}

/** 关一层块（配不上的收尾行把深度压到 0 即可，负深度只会让"保守"失效） */
function closeBlock(flow: FlowState): void {
  if (flow.depth > 0) flow.depth--;
}

/**
 * 单行代码的标签/跳转/块结构判定（scanWindow 的内层；拆出来避免两处重复）。
 *
 * **守护状态**（`guarded`）在这里消费：`SIF` 只护下一行、块内的一切按"可能不执行"算。
 * 守护行上的 `GOTO` ⇒ 目标边与顺序边都算（标签存在时进 `softJumps`）；
 * 守护行上的 `RETURN` ⇒ 不算块终止。取舍理由见文件头。
 */
function scanCodeLine(
  raw: string,
  at: number,
  ln: number,
  labels: Map<string, number>,
  pending: PendingJump[],
  dynamic: number[],
  conditional: number[],
  stops: Set<number>,
  flow: FlowState,
): void {
  const c0 = raw.charCodeAt(at);
  if (c0 === 36) {
    // `$` 标签定义行（标签不是语句：不消费 SIF 守护）
    const name = labelNameOf(raw, at);
    if (name !== null && !labels.has(name)) labels.set(name, ln);
    return;
  }
  if (!isAsciiLetter(c0)) return;
  const guarded = flow.depth > 0 || flow.sifGuard || flow.inCatch;
  flow.sifGuard = false;
  const letter = c0 >= 97 ? c0 - 32 : c0;
  switch (letter) {
    case 73: // I：IF
      if (isKeywordAt(raw, at, 'IF')) flow.depth++;
      return;
    case 87: // W：WHILE / WEND
      if (isKeywordAt(raw, at, 'WHILE')) flow.depth++;
      else if (isKeywordAt(raw, at, 'WEND')) closeBlock(flow);
      return;
    case 70: // F：FOR
      if (isKeywordAt(raw, at, 'FOR')) flow.depth++;
      return;
    case 83: // S：SELECTCASE / SIF
      if (isKeywordAt(raw, at, 'SELECTCASE')) flow.depth++;
      else if (isKeywordAt(raw, at, 'SIF')) flow.sifGuard = true;
      return;
    case 68: // D：DO
      if (isKeywordAt(raw, at, 'DO')) flow.depth++;
      return;
    case 67: // C：CATCH（`TRYCCALL*` 一族的错误分支入口：区内只有出错才会走到）
      if (isKeywordAt(raw, at, 'CATCH')) flow.inCatch = true;
      return;
    case 69: // E：ENDIF / ENDSELECT / ENDCATCH
      if (isKeywordAt(raw, at, 'ENDCATCH')) flow.inCatch = false;
      else if (isKeywordAt(raw, at, 'ENDIF') || isKeywordAt(raw, at, 'ENDSELECT')) closeBlock(flow);
      return;
    case 78: // N：NEXT
      if (isKeywordAt(raw, at, 'NEXT')) closeBlock(flow);
      return;
    case 76: // L：LOOP（`LOCAL` 一族被边界检查挡住）
      if (isKeywordAt(raw, at, 'LOOP')) closeBlock(flow);
      return;
    case 82: // R：RETURN 族 / REPEAT / REND
      if (RETURN_STOP_INSTRUCTIONS.has(leadingVerbOf(raw, at)?.verb ?? '')) {
        // 无条件 RETURN 才是块终止；条件块里 / SIF 守护下 / catch 区里"返回"只是可能发生
        if (!guarded) stops.add(ln);
        return;
      }
      if (isKeywordAt(raw, at, 'REPEAT')) flow.depth++;
      else if (isKeywordAt(raw, at, 'REND')) closeBlock(flow);
      return;
    case 71: // G：GOTO / GOTOFORM
    case 74: // J：JUMP / JUMPFORM
    case 84: // T：TRYGOTO* / TRYJUMP*
      break;
    default:
      return;
  }
  // 跳转族
  const head = leadingVerbOf(raw, at);
  if (head === null) return;
  const verb = head.verb;
  if (CONDITIONAL_JUMP_INSTRUCTIONS.has(verb)) {
    conditional.push(ln);
    return;
  }
  if (!JUMP_INSTRUCTIONS.has(verb)) return;
  if (FORM_JUMP_INSTRUCTIONS.has(verb)) {
    dynamic.push(ln);
    return;
  }
  const token = staticJumpTargetOf(raw, head.end);
  if (token === null) {
    dynamic.push(ln);
    return;
  }
  pending.push({ line: ln, token: token.toUpperCase(), soft: guarded });
}

/**
 * 区间内（1 基、闭区间）的跳转可达性读数。
 *
 * 纯函数：只读 `lines`（整份文件的行数组，0 基取用），不碰磁盘 / 缓存；同输入恒同输出。
 * 一次标签/边扫描 + 一次 BFS，O(窗口行数)。
 */
export function analyzeReachability(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): ReachabilityReading {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return EMPTY_READING;
  const first = Math.max(1, Math.trunc(startLine));
  const last = Math.min(Math.trunc(endLine), lines.length);
  if (last < first) return EMPTY_READING;

  const { jumpTo, softJumps, dynamic, resolved, conditional, stops } = scanWindow(lines, first, last);

  // 快路①：窗口里**没有跳转**（静态 / 动态都没有）⇒ 可达性就是一条直线，
  // 唯一的断点是第一条无条件 RETURN 之后。
  if (jumpTo.size === 0 && dynamic.length === 0) {
    const cut = firstStopAt(stops, first, last);
    return {
      reachable: new LineRange(first, cut < 0 ? last : cut - 1),
      dynamicJumps: dynamic,
      resolvedJumps: resolved,
      conditionalJumps: conditional,
    };
  }

  // 一般路：BFS（位图记账；只有真出现不可达行时才需要造 Set）
  const count = last - first + 1;
  const seen = new Uint8Array(count);
  const stack: number[] = [first];
  while (stack.length > 0) {
    const ln = stack.pop()!;
    const bit = ln - first;
    if (seen[bit] === 1) continue;
    seen[bit] = 1;
    if (stops.has(ln)) continue;
    const target = jumpTo.get(ln);
    if (target !== undefined) {
      if (target >= first && target <= last && seen[target - first] === 0) stack.push(target);
      if (!softJumps.has(ln)) continue; // 硬跳转：不落下一行
    }
    // 动态跳转行：本行之后的全部行按可达（含本行）
    if (isDynamicLine(dynamic, ln)) {
      for (let k = ln; k <= last; k++) seen[k - first] = 1;
      continue;
    }
    const next = ln + 1;
    if (next <= last && seen[next - first] === 0) stack.push(next);
  }
  const reachable = collectReachable(seen, count, first);
  return {
    reachable,
    dynamicJumps: dynamic,
    resolvedJumps: resolved,
    conditionalJumps: conditional,
  };
}

/** 窗口内第一条无条件 RETURN 行（无 → -1）；快路①的断点 */
function firstStopAt(stops: Set<number>, first: number, last: number): number {
  let cut = -1;
  for (const ln of stops) {
    if (ln >= first && ln <= last && (cut < 0 || ln < cut)) cut = ln;
  }
  return cut;
}

/**
 * 位图 → 读数集合：全 1 就给惰性区间（零拷贝），否则造 Set（不可达行才有的少数派）。
 */
function collectReachable(seen: Uint8Array, count: number, first: number): ReadonlySet<number> {
  let unreachable = 0;
  for (let i = 0; i < count; i++) if (seen[i] === 0) unreachable++;
  if (unreachable === 0) return new LineRange(first, first + count - 1);
  const out = new Set<number>();
  for (let i = 0; i < count; i++) if (seen[i] === 1) out.add(first + i);
  return out;
}

/** 动态跳转行判定（数组很小，线性查够用；避免为几十行建 Set 的第二份结构） */
function isDynamicLine(dynamic: readonly number[], ln: number): boolean {
  for (let i = 0; i < dynamic.length; i++) if (dynamic[i] === ln) return true;
  return false;
}
