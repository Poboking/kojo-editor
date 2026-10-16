/**
 * 控制流与预处理行的中文显示形（**任务线 ZH-C**）。
 *
 * 覆盖面（认得出就翻，认不出返回 `null`，**绝不原样返回**）：
 * - 块：`IF` / `ELSEIF` / `ELSE` / `ENDIF` / `SIF`；`SELECTCASE` / `CASE` / `CASEELSE` / `ENDSELECT`；
 * - 循环：`FOR … NEXT` / `WHILE … WEND` / `REPEAT … REND` / `DO … LOOP`（糖层不做循环**语法**，
 *   但**显示**不许留 ERB ⇒ 本层负责给出可读形）；
 * - 跳转与出口：`GOTO` / `JUMP` / `CALLJUMP` / `$标签` / `BREAK` / `CONTINUE` / `RESTART` / `CATCH`；
 * - 预处理行：`#DIM` / `#DIMS` / `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#FUNCTION` /
 *   `#FUNCTIONS` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY` 等。
 *
 * ## 词形从哪来（两条轴，绝不混）
 *
 * 1. **语言层词形零手抄**：`如果 / 否则如果 / 否则 / 当 / 是 / 到 / 则 / 调用` 一律由
 *    `keywords.ts` 的 `SUGAR_LEXICON_WORDS`（中文主形投影）与 `operatorTable()`（**反向**投影）给出，
 *    闭合行是同一套 `<块头词> + 结束`（`如果结束` / `当结束` / `循环结束` / `出错结束`）。
 *    本表与 `project.ts` 的 `SUGAR_CONTROL`（`如果 X：` / `当 X：` / `是 v：` / `否则：`）同一口径——
 *    预览里同一种块只会有一种中文写法。
 * 2. **本层新增词形只在循环/跳转/声明这三族**（糖层没有对应语法，故关键字表里没有词可用）：
 *    `循环`（`循环 计数 …` / `循环 当 …` / `循环 至少一次` / `循环 …`）· `步进`（循环变量自增减）·
 *    `跳到` / `调用跳转` / `标签` · `跳出循环` / `跳过本轮` / `重跑本轮` · `出错处理` ·
 *    `声明…` / `预处理 <记号原文>`。词形在本文件**定义一次**，测试逐字钉住。
 *
 * ## 三条判据（都与契约 `types.ts` 的红线绑在一起）
 *
 * - **表里没有的指令 ⇒ `null`**（宁缺勿猜：猜错中文义项比留兜底更坏）；
 *   认得记号但**不担保义项**的预处理指令（`#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY`）只翻
 *   「预处理」这一层，记号原样保留——翻的是**类**，不是**义**；
 * - **`lookup` 缺席 ⇒ 只做语言层**（关键字照翻，整行仍是中文形），绝不因为没名表就返 `null`；
 * - **出口自证**：任何返回都与 `input.content` 逐字不等（装配层还会再拒一次）。
 *
 * 条件表达式里的中文化**只走 `lookup`**（族头别名）与 `keywords.ts` 的反向运算符，
 * 属性名反糖（`CFLAG:TARGET:1088` → `她的好感度`）不在本层——那是 `project.ts` 的 `nameAt` 判据，
 * 这里重抄就成了第二份口径。
 */

import { NOTIN_KEYWORDS, SUGAR_LEXICON_WORDS, operatorTable } from '../keywords';
import type { KeywordId } from '../keywords';
import type { NativeDisplayInput, NativeDisplayLookup } from './types';

/* ------------------------- 词形：全部由既有真源派生 ------------------------- */

/** `KeywordId` → 中文主形（`SUGAR_LEXICON_WORDS` 的投影；本模块零硬编码语言层词形） */
const PRIMARY_WORDS: ReadonlyMap<KeywordId, string> = new Map(
  SUGAR_LEXICON_WORDS.filter((w) => w.primary).map((w) => [w.id, w.word] as const),
);

/** 取中文主形；缺词形 = 词表缺陷，把 id 原样显示到屏上（fail-visible，绝不静默兜个假词） */
function word(id: KeywordId): string {
  return PRIMARY_WORDS.get(id) ?? id;
}

const IF_W = word('block.if'); // 如果
const ELIF_W = word('block.elif'); // 否则如果
const ELSE_W = word('block.else'); // 否则
const WHEN_W = word('block.when'); // 当
const IS_W = word('block.is'); // 是
const TO_W = word('inline.to'); // 到
const THEN_W = word('inline.then'); // 则
const CALL_W = word('inline.call'); // 调用
/** `不在`（只从既有表取；表里缺这项就整条 `不在` 反显不触发，绝不现造一个词） */
const NOTIN_W = NOTIN_KEYWORDS.find((k) => !/^[a-z]+$/i.test(k)) ?? '';

const END_W = '结束'; // 闭合族：`<块头词> + 结束`
const LOOP_W = '循环';
const LOOP_COUNT_W = '计数';
const LOOP_ONCE_W = '至少一次';
const LOOP_STEP_W = '步进';
const PLUS_W = '加';
const MINUS_W = '减';
const FROM_W = '从';
const STRIDE_W = '步长';
const SIZE_W = '大小';
const JUMP_W = '跳到'; // `GOTO` 与其别名 `JUMP` 同一词形（别名关系见 app 的 `JUMP_KEYWORDS`）
const CALLJUMP_W = `${CALL_W}跳转`;
const LABEL_W = '标签';
const BREAK_W = '跳出循环';
const CONTINUE_W = '跳过本轮';
const RESTART_W = '重跑本轮';
const CATCH_W = '出错处理';
const PRE_W = '预处理';

/* --------------------------- 表达式侧（条件形） --------------------------- */

/** ERB 运算符 → 中文运算符（`operatorTable()` 的反向投影，正反对称是构造事实） */
const ERB_TO_WORD: ReadonlyMap<string, string> = new Map(
  operatorTable().map(([cn, erb]) => [erb, cn] as const),
);

/** `等于` = 同一张反向表里 `==` 的中文主形（条件位的裸 `=` 借它显示，本层不另造词） */
const EQ_W = ERB_TO_WORD.get('==') ?? '';

/** 正则转义（`||` 这类记号进 alternation 前必须逃） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 长式优先（`>=` 先于 `>`、`!=` 先于 `!`），由表本身排序得到，不另抄一份序列 */
const OPERATOR_RE = new RegExp(
  [...ERB_TO_WORD.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'),
  'g',
);

/** `!(X >= a && X <= b)` → `X 不在 a 到 b`（逐字符对齐写侧 `lowerNotIn` 的产物形） */
const NOTIN_RE = /!\(\s*([^()]+?)\s*>=\s*([^()]+?)\s*&&\s*\1\s*<=\s*([^()]+?)\s*\)/g;

/** 条件位的裸 `=` 就是相等（写侧表只登记 `==` ⇒ 赋值位不折，见 `compareEquals` 入参） */
const COMPARE_EQ_RE = /(?<![=+\-*/<>!&|])=(?!=)/g;

/** `族头:` → 中文别名 + **全角冒号**（与 `project.ts` 的 D2 反糖同一形态；查不到原样保留） */
const FAMILY_HEAD_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;

/** 双引号字面量整段跳过（条件里的 `"…"` 可能恰好写着运算符字样） */
const STRING_SEG_RE = /("(?:[^"]*)")/g;

function mapCode(text: string, fn: (code: string) => string): string {
  return text
    .split(STRING_SEG_RE)
    .map((seg) => (seg.startsWith('"') ? seg : fn(seg)))
    .join('');
}

/**
 * 条件/表达式 → 显示形。四步各管一件事，顺序即判据：
 * ① `不在` 还原（要看到**原生** `>=`/`&&` 才认，故必须在运算符中文化之前）
 * ② 族头别名（`lookup` 缺席就整步跳过）
 * ③ 比较位 `=` → `等于`（只在条件位）
 * ④ 运算符中文化 + 收掉多余空白（`!` → `非 ` 会留双空格；引号段已在第 ③ 步前被隔离）
 */
function showExpr(raw: string, lookup: NativeDisplayLookup | undefined, compareEquals: boolean): string {
  const text = raw.trim();
  if (text.length === 0) return '';
  return mapCode(text, (code) => {
    let out = code;
    if (NOTIN_W.length > 0) {
      out = out.replace(NOTIN_RE, (whole, x: string, lo: string, hi: string) =>
        lo.length === 0 || hi.length === 0 ? whole : `${x} ${NOTIN_W} ${lo} ${TO_W} ${hi}`,
      );
    }
    if (lookup) {
      out = out.replace(FAMILY_HEAD_RE, (whole, name: string) => {
        const alias = lookup.familyAlias(name.toUpperCase());
        return alias === undefined || alias === name ? whole : `${alias}：`;
      });
    }
    if (compareEquals && EQ_W.length > 0) out = out.replace(COMPARE_EQ_RE, ` ${EQ_W} `);
    return out.replace(OPERATOR_RE, (whole) => {
      const cn = ERB_TO_WORD.get(whole);
      if (cn === undefined) return whole;
      return whole === '!' ? `${cn} ` : cn; // 逻辑否定要留出词界（`非A` 读不出）
    });
  })
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** `CASE 1 TO 5` → `1 到 5`（`到` 与写侧同一个词形；引号段不碰） */
function showCaseValues(raw: string, lookup: NativeDisplayLookup | undefined): string {
  const spaced = mapCode(raw.trim(), (code) => code.replace(/\s+TO\s+/gi, ` ${TO_W} `));
  return showExpr(spaced, lookup, false);
}

/* ----------------------------- 行形状的拆解 ----------------------------- */

/** 块头/语句：`词` + 分隔（空白或 `:`） + 余文 */
const HEAD_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:|\s+|$)([\s\S]*)$/;
/** `FOR i = 0 TO 10 STEP 2`（`STEP` 可选；界限体交回 `showExpr`） */
const FOR_RE = /^([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*)\s*=\s*(.+?)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i;
/** 循环变量步进：`X + 1` / `X += 1` / `X - 1` / `X -= 1`（右侧只收数与标识符，不收算式 ⇒ 不猜） */
const STEP_RE =
  /^([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*)\s*([+-])\s*=?\s*(\d+|[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*)$/;

/** 需要表达式的语句：空表达式 = 形态不完整，不猜（`如果 ：` 比留兜底更误导读者） */
function needExpr(payload: string, make: () => string): string | null {
  return payload.length === 0 ? null : make();
}

/** 行尾 `;` 注释与语句体分离（引号内的 `;` 不算注释起点），注释原样缀回行尾 */
function splitComment(line: string): { body: string; comment: string } {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === ';' && !inString) return { body: line.slice(0, i), comment: line.slice(i) };
  }
  return { body: line, comment: '' };
}

/** 跳转目标：剥掉标签记号 `$` / `*`，让名字与 `$标签` 定义行的显示形对齐 */
function showTarget(payload: string): string {
  return payload.replace(/^[$*]\s*/, '').trim();
}

/** `SIF` 冒号形的界标：引号外的第一个「`:` 后跟空白」——`TFLAG:193` 这类段分隔不是冒号形 */
function sifColonSplit(payload: string): { cond: string; cmd: string } | null {
  let inString = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === '"') inString = !inString;
    else if (ch === ':' && !inString && /\s/.test(payload[i + 1] ?? ' ')) {
      const cmd = payload.slice(i + 1).trim();
      return cmd.length === 0 ? null : { cond: payload.slice(0, i), cmd };
    }
  }
  return null;
}

/* ------------------------------- 两张表 ------------------------------- */

type Opener = (payload: string, input: NativeDisplayInput) => string | null;

/** 带表达式/带体的语句 → 中文开块形 */
const OPENERS: ReadonlyMap<string, Opener> = new Map<string, Opener>([
  ['IF', (p, i) => needExpr(p, () => `${IF_W} ${showExpr(p, i.lookup, true)}：`)],
  ['ELSEIF', (p, i) => needExpr(p, () => `${ELIF_W} ${showExpr(p, i.lookup, true)}：`)],
  ['SIF', (p, i) => renderSif(p, i)],
  ['SELECTCASE', (p, i) => needExpr(p, () => `${WHEN_W} ${showExpr(p, i.lookup, true)}：`)],
  ['CASE', (p, i) => needExpr(p, () => `${IS_W} ${showCaseValues(p, i.lookup)}：`)],
  ['WHILE', (p, i) => needExpr(p, () => `${LOOP_W} ${WHEN_W} ${showExpr(p, i.lookup, true)}：`)],
  [
    'REPEAT',
    (p, i) =>
      p.length === 0
        ? `${LOOP_W} ${LOOP_ONCE_W}：`
        : `${LOOP_W} ${LOOP_ONCE_W} ${WHEN_W} ${showExpr(p, i.lookup, true)}：`,
  ],
  ['FOR', (p, i) => renderFor(p, i)],
  ['GOTO', (p) => needExpr(showTarget(p), () => `${JUMP_W} ${showTarget(p)}`)],
  ['JUMP', (p) => needExpr(showTarget(p), () => `${JUMP_W} ${showTarget(p)}`)],
  ['CALLJUMP', (p) => needExpr(showTarget(p), () => `${CALLJUMP_W} ${showTarget(p)}`)],
]);

/** 无体的独立行 / 收束行：`词` → 中文形（带体的这类行 = 形态不认识 ⇒ `null`） */
const STANDALONE: ReadonlyMap<string, string> = new Map<string, string>([
  ['ELSE', `${ELSE_W}：`],
  ['CASEELSE', `${ELSE_W}：`],
  ['ENDIF', `${IF_W}${END_W}`],
  ['ENDSELECT', `${WHEN_W}${END_W}`],
  ['NEXT', `${LOOP_W}${END_W}`],
  ['WEND', `${LOOP_W}${END_W}`],
  ['REND', `${LOOP_W}${END_W}`],
  ['LOOP', `${LOOP_W}${END_W}`],
  ['DO', `${LOOP_W}：`],
  ['BREAK', BREAK_W],
  ['CONTINUE', CONTINUE_W],
  ['RESTART', RESTART_W],
  ['CATCH', `${CATCH_W}：`],
  ['ENDCATCH', `${CATCH_W}${END_W}`],
]);

/** 预处理指令中有把握给出义项的那批（`sized` = 「名 + 大小」形） */
const PREPROCESSORS: ReadonlyMap<string, { cn: string; sized: boolean }> = new Map<
  string,
  { cn: string; sized: boolean }
>([
  ['DIM', { cn: '声明数组', sized: true }],
  ['DIMS', { cn: '声明字符串数组', sized: true }],
  ['GLOBAL', { cn: '声明全局数组', sized: true }],
  ['LOCALSIZE', { cn: '声明局部数组规模', sized: true }],
  ['LOCALSSIZE', { cn: '声明局部字符串规模', sized: true }],
  ['FUNCTION', { cn: '声明值函数', sized: false }],
  ['FUNCTIONS', { cn: '声明字符串值函数', sized: false }],
]);

/** **认得记号、不担保义项**的预处理指令：只翻「预处理」这一层，记号原样留着（翻类不翻义） */
const PRE_TOKEN_ONLY: ReadonlySet<string> = new Set(['SFUNCTION', 'XFUNCTION', 'TESTMEMORY']);

function renderSif(payload: string, input: NativeDisplayInput): string | null {
  if (payload.length === 0) return null;
  const split = sifColonSplit(payload);
  if (split === null) return `${IF_W} ${showExpr(payload, input.lookup, true)}：`;
  // 冒号形语料 0 例：只在界标清楚（`:` 后跟空白、右侧非空）时才走 `如果 … 则 …`，否则按两行形处理
  return `${IF_W} ${showExpr(split.cond, input.lookup, true)} ${THEN_W} ${showExpr(split.cmd, input.lookup, false)}`;
}

function renderFor(payload: string, input: NativeDisplayInput): string | null {
  const m = FOR_RE.exec(payload);
  if (!m) return null;
  const [, name, from, to, step] = m;
  if (name === undefined || from === undefined || to === undefined) return null;
  const stride = step === undefined ? '' : ` ${STRIDE_W} ${showExpr(step, input.lookup, false)}`;
  return `${LOOP_W} ${LOOP_COUNT_W} ${name} ${FROM_W} ${showExpr(from, input.lookup, false)} ${TO_W} ${showExpr(to, input.lookup, false)}${stride}：`;
}

/** `#DIM A 10` / `#FUNCTION A(x)` / `#SFUNCTION …` */
function renderPreprocessor(body: string): string | null {
  const m = /^#([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/.exec(body);
  if (!m) return null;
  const name = (m[1] ?? '').toUpperCase();
  const payload = (m[2] ?? '').trim();
  const spec = PREPROCESSORS.get(name);
  if (spec !== undefined) {
    if (!spec.sized) return payload.length === 0 ? spec.cn : `${spec.cn} ${payload}`;
    const tokens = payload.split(/\s+/).filter((t) => t.length > 0);
    const declared = tokens[0];
    if (declared === undefined) return spec.cn;
    const rest = tokens.slice(1).join(' ');
    return rest.length === 0 ? `${spec.cn} ${declared}` : `${spec.cn} ${declared} ${SIZE_W} ${rest}`;
  }
  if (PRE_TOKEN_ONLY.has(name)) {
    return payload.length === 0 ? `${PRE_W} ${name}` : `${PRE_W} ${name} ${payload}`;
  }
  return null;
}

/** `$标签` 定义行 */
function renderLabel(body: string): string | null {
  const name = body.slice(1).trim();
  return name.length === 0 ? null : `${LABEL_W} ${name}`;
}

/* ------------------------------- 入口 ------------------------------- */

/** ZH-C 的入口（签名由 lead 钉死，禁止改名或加参） */
export function renderControlLine(input: NativeDisplayInput): string | null {
  const line = input.content.trim();
  if (line.length === 0 || line.startsWith(';') || line.startsWith('@')) return null; // 空行/注释/函数头不归本层
  const { body, comment } = splitComment(line);
  const rendered = renderBody(body.trim(), input);
  if (rendered === null) return null;
  const tail = comment.trim().length > 0 ? ` ${comment.trim()}` : '';
  const out = `${rendered}${tail}`;
  return out === input.content ? null : out; // 红线在出口处的结构性自证
}

function renderBody(body: string, input: NativeDisplayInput): string | null {
  if (body.startsWith('#')) return renderPreprocessor(body);
  if (body.startsWith('$')) return renderLabel(body);
  const m = HEAD_RE.exec(body);
  if (!m) return null;
  const kind = (m[1] ?? '').toUpperCase();
  const payload = (m[2] ?? '').trim();
  const opener = OPENERS.get(kind);
  if (opener !== undefined) return opener(payload, input);
  const standalone = STANDALONE.get(kind);
  if (standalone !== undefined) return payload.length === 0 ? standalone : null;
  const step = STEP_RE.exec(body);
  if (step) {
    const [, name, sign, delta] = step;
    if (name !== undefined && sign !== undefined && delta !== undefined) {
      return `${LOOP_STEP_W} ${name} ${sign === '+' ? PLUS_W : MINUS_W} ${delta}`;
    }
  }
  return null;
}
