import type { EditorInlayHint, ErbIndex } from '@kojo/plugin-api';
import { MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { normalizedUpper, visibleCodeLines } from './references';

/**
 * 实参位行内提示（LS-R6，2026-10-16 语言服务批）——**纯函数**：缓冲区文本进、提示出，
 * 不读盘、不碰项目状态，可脱离 Monaco 单测。
 *
 * ## 说什么（可证明边界，逐条对过引擎语义）
 *
 * `CALL FOO, a, b` 的第 j 个实参按**位置**落入 FOO 的第 j 个声明槽（引擎参数槽语义，
 * 六批核验：`ErbLoader.cs:694-741` getEl1forArg = 下标、`ConvertArg
 * Process.CalledFunction.cs:162-239` 声明槽被调用必有值——HANDOFF §九-17 的既有结论，
 * 不凭直觉）。所以提示 = **第 j 个声明槽的名字**：
 *
 * - 具名槽（`@CHANGE_CFLAG(変動フラグ,対象,…)`）→ `変動フラグ:`（作者不用跳定义就知道
 *   这个实参是什么）；
 * - ARG 式槽（`@MESSAGE_TALK(ARG,ARG:1,ARG:2)`，真语料主流形态）→ `ARG:1`——这正是
 *   「CALL 参数槽 ↔ ARG:0/ARG:1 对位」：作者在调用点直接看到这个实参会进被调方的哪一槽；
 * - 声明槽比实参少 / 被调名不在索引 / 多处定义形参表不一致 ⇒ **那一格不给**（不猜）；
 *   FORM 动态拼接、变量占槽与 T3 同判据不答。
 *
 * ## 不说什么（勘察结论，留档防复立）
 *
 * - **函数体内的 `ARG:n` 序号提示**：「ARG:n = 第几个实参」在混合类型签名下不成立
 *   （数值/字符串槽各排各的序），引擎源码未核验的映射一律不做；
 * - **`.kojo` 指令参数位提示**：指令字典（`KojoInstructionTable`）只有中文名 ↔ 编号，
 *   **没有形参名数据**——"有数据才做"的前置不成立。
 *
 * ## 性能纪律
 *
 * hints 供方高频调用：行可见性与记号字符集**逐字共用** `visibleCodeLines`
 * （单一真源），每请求一次单遍线性扫描 + 每个调用点一次 `Map` 命中；索引缺席由
 * 调用方（插件）直接不注册应答，本模块对"索引长什么样"零知识。
 */

/** 被调方声明槽名字表（null = 名字不在索引 / 多处定义不一致；空数组 = 声明槽为零） */
export type SlotNamesOf = (normalizedName: string) => readonly string[] | null;

/**
 * 从项目索引构建「归一化名 → 声明槽名字表」的查询（**纯函数**，不读盘）。
 *
 * `byName` 里存的是 `ErbFunctionRef`（无形参），形参表在 `files` 的同名定义上——
 * 按 `filePath + startLine` 对回 `ErbFunction`。多处定义（重名函数）**全部一致**
 * （个数相同且逐名大小写不敏感相等）才给表；分歧 = 我们证明不了作者调的是哪一个
 * ⇒ `null`，那一行一个提示都不放（错标比不标危险）。
 */
export function inlaySlotsOf(index: ErbIndex, normalizedName: string): readonly string[] | null {
  const defs = index.byName.get(normalizedName);
  if (!defs || defs.length === 0) return null;
  let names: readonly string[] | null = null;
  for (const def of defs) {
    const fn = index.files.get(def.filePath)?.functions.find((f) => f.startLine === def.startLine);
    const params = fn?.params;
    if (!params) return null; // 定义体缺席（快照裁剪等）＝证明不了 ⇒ 不猜
    if (names === null) {
      names = params.map((p) => p.name);
      continue;
    }
    if (names.length !== params.length) return null;
    for (let i = 0; i < params.length; i++) {
      if (names[i]!.toUpperCase() !== params[i]!.name.toUpperCase()) return null;
    }
  }
  return names;
}

/** 名字槽记号（Unicode 字母/数字/下划线，与反向索引同一字符集——CJK 函数名 21% 不能漏） */
const SLOT_TOKEN_RE = new RegExp(`^[\\t \\u3000]*(${MODEL_TOKEN_CLASS}+)`, 'u');

/** ARG 式槽名（ARG / ARG:n / ARGS / ARGS:n）：标签就是槽位坐标本身，不再缀冒号 */
const ARG_STYLE_RE = /^(ARG|ARGS)(:\d+)?$/;

/** 一处实参的行内 0 基半开区间（列坐标与原文逐位对齐） */
interface ArgSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * 从 `from` 起切一份实参表（**纯函数**；感知双引号字符串与 `()` `[]` 嵌套深度）。
 *
 * 两种引擎语法共用一条切分：括号形 `CALL FOO(a, b)`（`from` 在 `(` 之后，
 * 顶层 `)` 收尾）与逗号形 `CALL FOO, a, b`（`from` 在首个 `,` 之后，行内注释 `;`
 * 收尾——字符串里的 `;` 与 `，` 不是注释/分隔符）。顶层逗号（半/全角）分隔；
 * 空槽（`CALL FOO,,b`）照样占位——位置赋值按逗号序，只是那一格没有可显示的实参。
 * 未闭合的括号按到行尾处理（作者正在写的半截调用也提示到已写的格）。
 */
function splitCallArguments(raw: string, from: number, paren: boolean): ArgSpan[] {
  const spans: ArgSpan[] = [];
  let start = from;
  let depth = 0;
  let inStr = false;
  for (let i = from; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === ';' && depth === 0) break; // 行内注释尾巴：后面整段不是实参
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      if (paren && depth === 0 && ch === ')') {
        spans.push({ start, end: i });
        return spans;
      }
      depth = Math.max(0, depth - 1);
    } else if ((ch === ',' || ch === '，') && depth === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  spans.push({ start, end: raw.length });
  return spans;
}

/**
 * 扫描整篇缓冲区的调用点实参位提示（**纯函数**：文本 + 槽名查询进、提示出）。
 *
 * 行可见性与名字槽判据逐字共用 `visibleCodeLines`（与反向索引 / T3 波浪线同一把尺子）；
 * 名字槽之后只认两种实参形态（括号形 / 逗号形），之间夹了别的东西（FORM 动态拼接、
 * 成员访问占槽）一律整行不答——与 `scanUndefinedCallTargets` 同款 fail-open。
 */
export function callArgumentHints(text: string, slotsOf: SlotNamesOf): EditorInlayHint[] {
  const out: EditorInlayHint[] = [];
  for (const { line, raw, isCallLine, keywordEnd, codeView } of visibleCodeLines(text)) {
    if (!isCallLine) continue;
    const m = SLOT_TOKEN_RE.exec(codeView().slice(keywordEnd));
    if (!m) continue; // 名字槽空着（`CALL` 单独一行）＝无括号全默认，无实参可标
    const slots = slotsOf(normalizedUpper(m[1]!));
    if (!slots || slots.length === 0) continue; // 不在索引 / 声明槽为零 ⇒ 不猜

    const tokenEnd = keywordEnd + m[0]!.length;
    // 名字之后到实参区起点之间只许空白（否则是 FORM 动态拼接等未知形态）
    let at = tokenEnd;
    while (at < raw.length && (raw[at] === ' ' || raw[at] === '\t' || raw[at] === '\u3000')) at++;
    if (at >= raw.length || raw[at] === ';') continue; // 本行没有实参
    const paren = raw[at] === '(';
    if (!paren && raw[at] !== ',' && raw[at] !== '，') continue;

    const spans = splitCallArguments(raw, at + 1, paren);
    for (let j = 0; j < spans.length && j < slots.length; j++) {
      const span = spans[j]!;
      // 实参起点：跳过前导空白（在原文上找——字符串实参以引号开头，代码视野里它被刷白）
      let s = span.start;
      while (s < span.end && (raw[s] === ' ' || raw[s] === '\t' || raw[s] === '\u3000')) s++;
      if (s >= span.end) continue; // 空槽：占位但不标（没有实参可对位）
      const name = slots[j]!;
      out.push({
        line,
        column: s + 1,
        label: ARG_STYLE_RE.test(name) ? name : `${name}:`,
        tooltip: `第 ${j + 1} 参：${name}`,
      });
    }
  }
  return out;
}
