import type * as Monaco from './entry';
import type { KojoCallProtocol, KojoCallSlot } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * 签名帮助（B5，形参槽语义）——`Ctrl+Shift+Space` / 打字触发的参数提示。
 *
 * **唯一真源是 adapter 的调用协议表**（`game.adapter` → `kojoCallProtocol.slotsFor(name)`），
 * 宿主**运行时现取**（同 `kojo-hover` / `editorTables` 的纪律：表随项目开闭重建，缓存会把
 * 上一个项目的表带过来）；表缺席、`slotsFor` 返回 `null`（协议不认识这个函数）、或解析抛错
 * ⇒ **不应答**（不猜）。槽的 `label` 原文照抄进提示，宿主不解释它是什么场景参数。
 *
 * 落点取舍（为什么不往 `ui.editor.languageService` 判别式联合里加 `signatureHelp` 成员）：
 * 这条能力唯一缺的知识是**槽语义表**，而它已经在 `game.adapter` 槽上；剩下的"谁在被调、
 * 光标在第几个实参"是**引擎级语法**（括号 / 逗号 / 引号），不是游戏知识，本层已有同种先例
 * （`erb-completion-bits.ts` 的 `matchingParen` / `topLevelComma`）。加判别成员要动两枚插件的
 * 注册码却换不来任何新数据 ⇒ 只做宿主层，将来若插件要交**自己的**形参表（如 ERB 声明的
 * 实参名）再按 additive 形态加成员。
 *
 * 分层照旧：`findCallSite`（纯文本解析，单行）→ `resolveSignature`（查表 + 夹取，纯函数）→
 * `installSignatureHelp`（只做 Monaco 协议翻译）。R5 起另有跨行链：`findCallSiteAt`
 * （向上收未闭合括号拼串）**复用** `findCallSite` 切分，`resolveSignatureInText` 是宿主
 * 的多行入口；ERB 用户函数形参签名（`describeErbSignature`）作为调用协议不认识时的
 * 第二查表面，由宿主按 additive 回调注入。
 */

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

/** 实参分隔符：半角逗号 + **全角逗号**（口上文本里 `，` 是真出现的形态，漏了它等于半个功能） */
const SEPARATORS = new Set([',', '，']);

/** 标识串字符：除空白与结构字符外都算名字的一部分（中文名 / `:` 段 / `%` 插值都不切） */
const CALLEE_RE = /([^\s(),;[\]"']+)$/;

/** 从 `open+1` 起找顶层（深度 0）的实参区间；遇顶层右括号停止并报告闭合 */
function splitArguments(
  lineText: string,
  open: number,
): { args: CallArgumentSpan[]; closed: boolean } {
  const args: CallArgumentSpan[] = [];
  let start = open + 1;
  let depth = 0;
  let inString = false;
  for (let i = open + 1; i < lineText.length; i++) {
    const ch = lineText[i]!;
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue; // 字符串里的逗号 / 括号一律不是分隔符
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
 * 这是**单行**入口（行为与本批前逐字一致）；跨行形态走 {@link findCallSiteAt}——它把
 * 向上收来的行拼成单串后**复用本函数**，"最内层括号"语义天然跨行一致（同一段扫描代码）。
 */
export function findCallSite(lineText: string, column: number): CallSite | null {
  if (!Number.isFinite(column) || column < 1) return null;
  if (/^\s*;/.test(lineText)) return null;
  const col0 = Math.min(column - 1, lineText.length);

  // 光标之前的扫描：字符串态 + 左括号栈（栈里剩的就是未闭合的那些）
  const stack: number[] = [];
  let inString = false;
  for (let i = 0; i < col0; i++) {
    const ch = lineText[i]!;
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '(') stack.push(i);
    else if (ch === ')') stack.pop();
  }
  if (inString) return null;
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

/* ============================== 跨行调用位点（R5） ============================== */

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
 * 槽 → 参数标签。`kind` 决定前缀（契约自述：数值槽 `ARG:n`、字符串槽 `ARGS:n`），
 * `index` 与 `label` 原文照抄，宿主不加解释。
 */
export function slotParameterLabel(slot: KojoCallSlot): string {
  return `${slot.kind === 'str' ? 'ARGS' : 'ARG'}:${slot.index} ${slot.label}`;
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
 * 行文本 + 光标列 → 签名（**纯函数**，`installSignatureHelp` 与单测共用这一层）。
 * 单行入口：行为与本批前逐字一致（跨行走 {@link resolveSignatureInText}）。
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

/** 宿主注入：这个位置该答什么签名（宿主在此做糖视图判据 + **运行时**现取 adapter 表） */
export interface SignatureHandlers {
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): ResolvedSignature | null;
}

/**
 * 签名帮助要的那张表（`editorTables` 的 additive 字段）：`callProtocol` 缺席 =
 * 项目没开 / adapter 不提供调用协议 ⇒ 整条能力零产出（**不猜**）。
 */
export interface SignatureTables {
  readonly callProtocol?: KojoCallProtocol;
}

/**
 * 触发字符（自定并说明）：
 * - `(` —— 进入调用括号，作者正要开始填第一个槽；
 * - `,` / `，` —— 换到下一槽（**全角逗号是口上的真形态**，只认半角等于一半调用位点没提示）。
 * 不列 `)`：右括号意味着这次调用写完了，提示该收而不是该留（Monaco 会把触发字符同时当
 * 重触发字符，无需再声明一遍）。
 */
export const SIGNATURE_TRIGGER_CHARACTERS: readonly string[] = ['(', ',', '，'];

/** 中性签名 → Monaco `SignatureHelp`（`activeSignature` 恒 0：一张表只给一张最具体签名） */
export function toMonacoSignatureHelp(hit: ResolvedSignature): Monaco.languages.SignatureHelp {
  const parameters: Monaco.languages.ParameterInformation[] = hit.signature.parameters.map((label) => ({ label }));
  return {
    signatures: [{ label: hit.signature.label, parameters }],
    activeSignature: 0,
    activeParameter: hit.signature.activeParameter,
  };
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册签名帮助 provider。
 *
 * 不应答一律返回 `undefined`（**不返回空 help**）：Monaco 会继续问下一家 provider，
 * 空 `signatures` 数组反而会把这条能力占住又显示不出东西。
 */
export function installSignatureHelp(monaco: typeof Monaco, handlers: SignatureHandlers): Monaco.IDisposable {
  const provider: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: SIGNATURE_TRIGGER_CHARACTERS,
    provideSignatureHelp(model, position) {
      let hit: ResolvedSignature | null;
      try {
        hit = handlers.resolve(model, position);
      } catch (e: unknown) {
        console.warn(`[kojo-signature] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      if (!hit) return undefined;
      return { value: toMonacoSignatureHelp(hit), dispose: () => undefined };
    },
  };
  const subs = [
    monaco.languages.registerSignatureHelpProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerSignatureHelpProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
