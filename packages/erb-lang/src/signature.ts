/**
 * ERB **签名帮助**的判据（`@kojo/erb-lang/signature`，LAU-1031-SIG 判据搬家批）。
 *
 * ## 这一格回答什么（B5 形参槽语义 + R5 跨行）
 *
 * 调用位点解析（哪一个是被调的函数、实参表、光标落在第几参、来源文本怎么读）与签名组装
 * 全在这一枚叶子里：`splitArguments` / `findCallSite` / `findCallSiteAt` 是**纯文本判据**
 * （括号 / 逗号 / 引号，只认半角逗号），`describeCallSignature` / `describeErbSignature` 是
 * **中性组装**（label 逐字包含每个参数标签——Monaco 用参数标签在 label 串上正则定位高亮）。
 * 行为与住在宿主 `monaco/kojo-signature.ts` 时期**逐字一致**（用例经那层的 re-export 原样
 * 覆盖，搬家前后一条判据没改，只换了住址）。
 *
 * ## 两张表的来路（宿主事实，本包不生产）
 *
 * 签名帮助的数据面是两张**宿主表**：① adapter 的调用协议（槽语义，`KojoCallProtocol`）；
 * ② ERB 用户函数形参（解析器索引）。二者都随项目开闭重建，**请求时现取**——本包为此内置
 * 一枚**模块级登记表**（`registerErbSignatureSource` / `erbSignatureNow`，范式照
 * `@kojo/kojo-lang/adapter-source`：宿主组合根登记 getter、插件供方请求时问一次；
 * 零登记 ⇒ 空表 ⇒ 不应答，getter 抛错 ⇒ 问下一枚，注销只撤自己）。
 * 「随请求递下去」的形状本批**没有**采用：契约面 `plugin-api/slots.ts` 在开机图内，
 * ps10 字节余量只剩 ~404 B，加不动请求字段；登记表是同一件事（宿主持有的事实交给插件）的
 * 既有合法出路，且与 2.0 那条签名腿的 adapter 取数**同形**。
 *
 * ## 分层纪律
 *
 * - 零 Monaco / 零 IO / 零 DOM：翻 `SignatureHelp`、注册 provider 的是宿主
 *   （`app/src/monaco/kojo-signature.ts` 旧桥 + `slot-service-providers.ts` 槽腿）；
 * - 唯一外部依赖是 `@kojo/plugin-api`：`slotParameterLabel`（槽 → `ARG:n`/`ARGS:n` 标签的
 *   **唯一实现**，LAU-4 补全腿第三批上提契约层——在这里抄第二份，浮层与候选列表就会漂移）
 *   与 `KojoCallProtocol` / `KojoCallSlot` 两枚类型。
 */
import type { KojoCallProtocol, KojoCallSlot } from '@kojo/plugin-api';
// 槽标签格式化的**唯一实现**在契约层（本包与宿主旧桥、插件供方共读这一份，不各抄一份）。
import { slotParameterLabel } from '@kojo/plugin-api';

/** 一个实参的区间（0 基，`[start, end)`：`end` 落在分隔符或右括号那一格，不含它） */
export interface CallArgumentSpan {
  readonly start: number;
  readonly end: number;
}

/** 调用位点的解析产物（纯文本事实，不含任何语义解释） */
export interface CallSite {
  /** 紧邻左括号的被调者名（已剥 `@` 前缀；糖线的中文名同样按"非分隔符串"整段取） */
  readonly callee: string;
  readonly args: readonly CallArgumentSpan[];
  /** 光标落在第几个实参（0 基） */
  readonly activeIndex: number;
  /** 左括号是否已闭合（未闭合照常应答——作者正在写最后一个实参） */
  readonly closed: boolean;
}

/** 实参分隔符：**仅半角逗号**。Emuera 只认半角 `,`，全角 `，` 不是分隔符（钉住此判据，防止将来放宽）。 */
const SEPARATORS = new Set([',']);

/** 标识串字符：除空白与结构字符外都算名字的一部分（中文名 / `:` 段 / `%` 插值都不切） */
const CALLEE_RE = /([^\s(),;[\]"']+)$/;

/**
 * 从 `open+1` 起找顶层（深度 0）的实参区间；遇顶层右括号停止并报告闭合。
 * 字符串（`"…"` 或 `'…'`）内的逗号与括号一律不数；嵌套 `()` / `[]` 内的逗号不数。
 * 导出供单测直接验证判据（一份判据，两处消费：旧桥与槽供方）。
 */
export function splitArguments(
  lineText: string,
  open: number,
): { args: CallArgumentSpan[]; closed: boolean } {
  const args: CallArgumentSpan[] = [];
  let start = open + 1;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = open + 1; i < lineText.length; i++) {
    const ch = lineText[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      if (depth === 0) {
        args.push({ start, end: i });
        return { args, closed: true };
      }
      depth--;
    } else if (depth === 0 && SEPARATORS.has(ch)) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  return { args: [...args, { start, end: lineText.length }], closed: false };
}

/**
 * 解析光标所在的**调用位点**（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * 返回 `null` = 这里没有可认的调用位点（**不猜**）：注释行（`;` 起头，与位槽解析同口径）／
 * 光标落在字符串字面量里／光标不在任何未闭合左括号之内／左括号前没有名字（如 `(1,2)` 裸一段）。
 *
 * 取的是**最内层**未闭合括号（`f(g(a,|), b)` 认 `g` 不认 `f`）——光标紧挨哪一层就在填哪一层的槽。
 * 这是**单行**入口；跨行形态走 {@link findCallSiteAt}——它把向上收来的行拼成单串后
 * **复用本函数**，"最内层括号"语义天然跨行一致（同一段扫描代码）。
 */
export function findCallSite(lineText: string, column: number): CallSite | null {
  if (!Number.isFinite(column) || column < 1) return null;
  if (/^\s*;/.test(lineText)) return null;
  const col0 = Math.min(column - 1, lineText.length);

  // 光标之前的扫描：字符串态 + 左括号栈（栈里剩的就是未闭合的那些）
  const stack: number[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < col0; i++) {
    const ch = lineText[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') stack.push(i);
    else if (ch === ')') stack.pop();
  }
  if (quote !== null) return null; // 光标落在字符串字面量里
  const open = stack[stack.length - 1];
  if (open === undefined) return null;

  const callee = CALLEE_RE.exec(lineText.slice(0, open).trimEnd())?.[1]?.replace(/^@+/, '');
  if (!callee) return null;

  const { args, closed } = splitArguments(lineText, open);
  // 落点归属：取第一个满足 `col0 <= end` 的区间。区间首尾相接、分隔符自身体积为 0，
  // 所以光标停在逗号**之后**才切到下一槽（`f(a,|)` 已在第 1 槽、`f(a|,)` 仍在第 0 槽）
  let activeIndex = args.length - 1;
  for (let i = 0; i < args.length; i++) {
    if (col0 <= args[i]!.end) {
      activeIndex = i;
      break;
    }
  }
  return { callee, args, activeIndex, closed };
}

/**
 * 跨行回看的**窗口上限**（行数）。签名帮助在**每次击键**时同步应答，回看必须封顶：
 * 口上的调用实参撑死几行，64 行窗口覆盖一切真实形态；无界回看在大文件上每键 O(n)
 * 纯浪费。窗口走满仍找不到调用起点 ⇒ 就地判 `null`（不猜）。
 */
export const SIGNATURE_LOOKBACK_LINES = 64;

/**
 * 截断一行里**引号外**的行内注释（`;` 起、至行尾；与 `kojo-completion-instructions`
 * 的 `insideStringOrComment` 同口径：引号配平后第一个 `;`）。注释里的括号 / 逗号 / 引号
 * 不能参与跨行深度与拼接——截掉，注释行自然截成空串。
 */
function stripInlineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inString = !inString;
    else if (!inString && ch === ';') return line.slice(0, i);
  }
  return line;
}

/** 单行括号净增量（开 - 闭；字符串感知；**行内注释先截断**——注释里的括号不参与深度） */
function lineParenDelta(line: string): number {
  let delta = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inString = !inString;
    else if (!inString) {
      if (ch === ';') break; // 引号外 `;` 起是注释（与 stripInlineComment 同口径）
      if (ch === '(' || ch === '[') delta++;
      else if (ch === ')' || ch === ']') delta--;
    }
  }
  return delta;
}

/**
 * **跨行**调用位点解析（R5；**纯函数**；`column` = Monaco 的 1 基列，`lineIndex` 0 基）。
 *
 * 从光标行**向上**收未闭合括号：逐行累加 `lineParenDelta`（注释已截断、字符串感知），
 * **"关多"行**（累计深度变负——它的闭合属于别的调用）即停；平衡行（delta=0）与正值行
 * 都收进来——平衡行深度不变、拼进来无害（调用实参经常摊在没有括号的行上）。收到的区间
 * **截掉行内注释后拼接**，光标列平移到拼串坐标，**复用** {@link findCallSite} 做切分
 * ——"最内层括号 / 活跃槽 / 闭合"语义与单行完全同源，不存在第二套括号模型（两个真源
 * 比没测更坏）。
 *
 * 边界口径：
 * - 拼接后 {@link findCallSite} 的行首注释判定作用于拼串首行 = 调用起点行，语义不变；
 * - 光标行**不截注释**（光标列平移后必须逐格对应原行）；
 * - "关多"截断后拼串内括号若不闭合 ⇒ `findCallSite` 自然判 `null`（不猜）；
 * - 回看窗口 {@link SIGNATURE_LOOKBACK_LINES} 走满仍未找到调用起点 ⇒ 就地收手
 *   （签名帮助在每次击键时同步应答，回看必须 O(窗口)）。
 */
export function findCallSiteAt(lines: readonly string[], lineIndex: number, column: number): CallSite | null {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) return null;
  const cursorLine = lines[lineIndex]!;
  let start = lineIndex;
  let depth = 0;
  for (let k = lineIndex - 1; k >= 0 && lineIndex - k <= SIGNATURE_LOOKBACK_LINES; k--) {
    depth += lineParenDelta(lines[k]!);
    if (depth < 0) {
      start = k + 1; // 关多：这枚闭合属于别的调用，起点在它之后
      break;
    }
    start = k; // 平衡 / 正值都收进来（平衡行深度不变，拼进来无害）
  }
  const middle = lines
    .slice(start, lineIndex)
    .map(stripInlineComment)
    .join('');
  return findCallSite(middle + cursorLine, middle.length + column);
}

/** ERB 用户函数的形参（宿主从解析器索引取；本层不触盘、不查内核） */
export interface ErbFunctionParam {
  readonly name: string;
}

/** 按被调者名取形参表的宿主回调（缺席 / 不认识 ⇒ `null`，**不猜**） */
export type ErbFunctionParamsResolver = (callee: string) => readonly ErbFunctionParam[] | null;

/** 一次签名的中性呈现（不含 Monaco 类型，便于纯测） */
export interface CallSignature {
  readonly label: string;
  /** 各参数标签：与 `label` 里的片段**逐字一致**——Monaco 拿参数标签在 `label` 串上做正则
   * 定位（`parameterHintsWidget.getParameterLabelOffsets`），对不上就高亮不出来 */
  readonly parameters: readonly string[];
  readonly activeParameter: number;
}

/** 解析 + 查表的合并产物 */
export interface ResolvedSignature {
  readonly callee: string;
  readonly signature: CallSignature;
}

/**
 * 组装签名（**纯函数**）：`函数名(ARG:0 含义, ARGS:1 含义)`。
 *
 * `activeParameter` 夹到**最后一个声明槽**：实参比声明槽多（作者写了超出协议的数量）时
 * 高亮停在最后一格，而不是假造一个不存在的第 N 槽——`slots.length === 0` 时取 0
 * （Monaco 自己按 `parameters[activeParameter]` 取值，越界只渲染成"无高亮"，不崩）。
 */
export function describeCallSignature(
  callee: string,
  slots: readonly KojoCallSlot[],
  activeIndex: number,
): CallSignature {
  const parameters = slots.map(slotParameterLabel);
  const activeParameter = parameters.length === 0 ? 0 : Math.min(Math.max(0, activeIndex), parameters.length - 1);
  return { label: `${callee}(${parameters.join(', ')})`, parameters, activeParameter };
}

/**
 * ERB 用户函数签名（R5）：`函数名(形参, 形参:1)`。
 *
 * 形参名**原文照抄**解析器索引（`ErbFunction.params` 的 `name`——作者在 `@` 头里写的
 * 引擎记号，如 `ARG` / `ARGS:1 = 3` 里解析出的名）：这就是"有数据就用数据"——没有
 * 形参表时本函数不会被调到（宿主回调回 `null`），**不存在 ARG:n 兜底造名**。
 * `activeParameter` 夹取口径与 {@link describeCallSignature} 一致。
 */
export function describeErbSignature(
  callee: string,
  params: readonly ErbFunctionParam[],
  activeIndex: number,
): CallSignature {
  const parameters = params.map((p) => p.name);
  const activeParameter = parameters.length === 0 ? 0 : Math.min(Math.max(0, activeIndex), parameters.length - 1);
  return { label: `${callee}(${parameters.join(', ')})`, parameters, activeParameter };
}

/**
 * 行文本 + 光标列 → 签名（**纯函数**，旧桥与单测共用这一层）。
 * 单行入口；跨行走 {@link resolveSignatureInText}。
 *
 * `protocol` 缺省（项目没开 / adapter 没这张表）⇒ `null`；`slotsFor(callee)` 返回 `null`
 * （协议不认识这个函数）⇒ `null`；`slotsFor` 抛错 ⇒ `null`（能力出错退化可见，不让提示崩）。
 */
export function resolveSignature(
  lineText: string,
  column: number,
  protocol: KojoCallProtocol | undefined,
): ResolvedSignature | null {
  if (!protocol) return null;
  const callSite = findCallSite(lineText, column);
  if (!callSite) return null;
  let slots: readonly KojoCallSlot[] | null;
  try {
    slots = protocol.slotsFor(callSite.callee);
  } catch {
    return null;
  }
  if (!slots) return null; // 协议不认识 ⇒ 不应答（不猜）
  return { callee: callSite.callee, signature: describeCallSignature(callSite.callee, slots, callSite.activeIndex) };
}

/**
 * **多行文本** + 光标行列 → 签名（R5；**纯函数**，宿主与单测共用）。
 *
 * 查表顺序（先具体后泛化）：调用协议表（槽语义，游戏知识）命中 ⇒ 用它；不认识且宿主
 * 提供了 ERB 用户函数形参回调（`erbParams`，解析器索引）⇒ 用形参原文组装签名；两表
 * 皆不认识 ⇒ `null`（**不猜**——既不造 ARG:n 兜底名，也不猜形参个数）。`erbParams`
 * 抛错按"不认识"处理（退化可见、不让提示崩）。
 *
 * 跨行口径见 {@link findCallSiteAt}；`lineNumber` / `column` 都是 Monaco 1 基。
 */
export function resolveSignatureInText(
  text: string,
  lineNumber: number,
  column: number,
  protocol: KojoCallProtocol | undefined,
  erbParams?: ErbFunctionParamsResolver,
): ResolvedSignature | null {
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
  if (!Number.isFinite(column) || column < 1) return null;
  const lines = text.split(/\r\n|\n/);
  const lineIndex = lineNumber - 1;
  if (lineIndex >= lines.length) return null;
  const callSite = findCallSiteAt(lines, lineIndex, column);
  if (!callSite) return null;
  if (protocol) {
    try {
      const slots = protocol.slotsFor(callSite.callee);
      if (slots) {
        return { callee: callSite.callee, signature: describeCallSignature(callSite.callee, slots, callSite.activeIndex) };
      }
    } catch {
      return null; // 协议表出错退化可见（与单行口径一致：不让提示崩）
    }
  }
  if (!erbParams) return null;
  let params: readonly ErbFunctionParam[] | null;
  try {
    params = erbParams(callSite.callee);
  } catch {
    return null;
  }
  if (!params) return null;
  return { callee: callSite.callee, signature: describeErbSignature(callSite.callee, params, callSite.activeIndex) };
}

/* ============================== 宿主事实的取表缝（模块级登记表） ============================== */

/**
 * 签名帮助要的两张**宿主表**（additive 形态，两格都可缺）：
 *
 * - `callProtocol`：adapter 的调用协议（槽语义）。缺席 = 项目没开 / adapter 没这张表
 *   ⇒ 这一路零产出（**不猜**）；
 * - `paramsOf`：ERB 用户函数形参表（宿主按解析器索引现查）。协议不认识时的第二查表面。
 */
export interface ErbSignatureTables {
  readonly callProtocol?: KojoCallProtocol;
  readonly paramsOf?: ErbFunctionParamsResolver;
}

/** 宿主 getter：此刻的两张表（抛错 = 这一枚取不出，问下一枚） */
export type ErbSignatureSource = () => ErbSignatureTables;

/** 登记顺序 = 查询顺序的逆序（后登记的优先：最新装配的那一份才是当前的）——照 `adapter-source` */
const sources: ErbSignatureSource[] = [];

/**
 * 登记一枚"从哪里拿两张表"；返回**只撤自己**的注销函数（重复调用幂等）。
 *
 * 宿主组合根在全局 provider 装配处登记一次；测试直接登记桩。
 */
export function registerErbSignatureSource(source: ErbSignatureSource): () => void {
  sources.push(source);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = sources.lastIndexOf(source);
    if (at >= 0) sources.splice(at, 1);
  };
}

/**
 * 此刻的两张表（没有登记 / getter 全部抛错 ⇒ 空对象 `{}` = 整条能力零产出，**不猜**）。
 *
 * **每次现取**：表随项目开闭重建，缓存会把上一个项目的表带过来（与 `adapter-source`
 * / `editorTables` 同一条纪律）。
 */
export function erbSignatureNow(): ErbSignatureTables {
  for (let index = sources.length - 1; index >= 0; index--) {
    try {
      const tables = sources[index]!();
      if (tables !== null && tables !== undefined && typeof tables === 'object') return tables;
    } catch {
      continue; // 这一枚取不出（组合根正在重建等）⇒ 问下一枚，不把异常带出去
    }
  }
  return {};
}

/** 当前登记了几枚（观测面：测试钉"注销不留登记"） */
export function erbSignatureSourceCount(): number {
  return sources.length;
}

/* ============================== 击键路径的窗口入口 ============================== */

/** 第 `n` 行（1 基）的行首偏移；行不存在 ⇒ `-1`（换行按 `\n` 计数，`\r` 归上行尾巴——与 `split(/\r\n|\n/)` 同界） */
function lineStartOffset(text: string, n: number): number {
  if (n <= 1) return 0;
  let offset = 0;
  for (let i = 1; i < n; i++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return -1;
    offset = next + 1;
  }
  return offset;
}

/**
 * **整篇文本** + Monaco 行列 + 两张表 → 签名（供方与旧桥共用的击键入口；`null` = 不应答）。
 *
 * 窗口口径与宿主旧桥的 `signatureHelpAt`（`getValueInRange` 那条 PS-4 seam）等价：
 * 只取 `[line - SIGNATURE_LOOKBACK_LINES, line]` 这一段行集合，`findCallSiteAt` 本来也只读
 * 这些行（向上封顶、向下不读）——光标行以下的内容对结果零影响。窗口的行号换算回窗口坐标后
 * 交给 {@link resolveSignatureInText}，判据仍是**同一份**（不存在第二套括号模型）。
 *
 * 为什么要这一刀：签名帮助**每次击键**同步应答，整篇 `split` 在 5 万行档每键都要付一次
 * （PS-4 ③ 当年就是从整篇视角改成窗口取文的）。
 */
export function erbSignatureAt(
  text: string,
  line: number,
  column: number,
  tables: ErbSignatureTables = erbSignatureNow(),
): ResolvedSignature | null {
  if (!Number.isInteger(line) || line < 1) return null;
  if (!Number.isFinite(column) || column < 1) return null;
  const from = Math.max(1, line - SIGNATURE_LOOKBACK_LINES);
  const start = lineStartOffset(text, from);
  if (start < 0) return null; // 光标行号越界（模型已缩短等）⇒ 不猜
  const nextLineStart = lineStartOffset(text, line + 1);
  const windowText = text.slice(start, nextLineStart < 0 ? text.length : nextLineStart);
  return resolveSignatureInText(windowText, line - from + 1, column, tables.callProtocol, tables.paramsOf);
}
