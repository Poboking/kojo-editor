#!/usr/bin/env node
/**
 * erb-paint-coverage.mjs —— 内联文本形三元 `\@<条件>?<真文>#<假文>\@` 的**着色覆盖率与弃涂成因**读数
 * （真实语料只读；ERB-PAINT-21 的长期判据，见 `docs/BOARD.md` 该行）。
 *
 * ## 为什么仓里需要这一枚
 * 体感批 v2（落 dev 提交 07decf3f）把内联三元的着色做成了「整形状一次匹配」的群组发射
 * （`packages/app/src/monaco/erb-language.ts::erbInlineTernaryShape`），代价是真源认得的形状里
 * 只有约四分之三涂得上（看板记的 21.3% 弃涂是旧量法的低估值，本脚本量到 26.2%，见下面首跑读数）：
 * 量法当时写在 gitignore 的 `.local/erb-gap/paint-coverage.mjs` 里，**不构成长期判据**。ERB-PAINT-21 要把弃涂的那部分拿下（改成 Monarch 相位机），判据是
 * 「覆盖率只升不降且 `%…%`/`{…}` 既有插值着色零回退」——所以先把**成因量清楚、并把量法固化**：
 * 本脚本就是改造前后各跑一次的同一把尺子（跑两次逐字节相同）。
 *
 * ## 口径（一把尺子，两半）
 * 1. **分母 = 语义真源认得的完整形状**：逐行调
 *    `packages/plugins/condition-extractor/src/inline.ts` 的 `scanTextTernaries`（`?` 界 / `\@` 收，
 *    只在**顶层**认，引号与 `{}()[]` 内一律是正文）——**不另造第二把认形状的尺子**。
 *    本脚本需要一个区间才能数「段内字符」，故带一份 `findTopLevel` 的**字形镜像**（与真源逐字同语义），
 *    并对**每一行**把镜像产出的 `{column, text}` 序列与 `scanTextTernaries` 的返回值逐字对拍，
 *    不一致即抛（fail-closed：真源改了口径 ⇒ 本读数立刻红，绝不静默换尺子）。装载形态同
 *    `packages/erb-syntax-tree/tools/gen-erb-structure.mjs`：裸 node（Node ≥ 22.18 类型擦除）直读 TS 源码；
 *    `inline.ts` 零运行期 import，故无需 `module.registerHooks`，也无需镜像除 `findTopLevel` 之外的任何东西。
 * 2. **弃涂成因 = 今天形状判据的字符类**：真源认得的形状里，今天的判据要求三段
 *    （条件 / 真文 / 假文）只由「不含 `"` `\` `%` `{` `}` `(` `)` `[` `]`（root 态再加 `;`）的原子」
 *    与「一层配平的 `(...)` / `[...]`」拼成，且必须含顶层 `#`。因此成因名册（固定八项，**不许**出现没登记的）：
 *    - `pct`    段内出现 `%`（`%…%` 插值），**或**整枚形状落在 `%…%` 插值层里（那层今天被 `strStr` 一口吃成 `variable`）；
 *    - `brace`  段内出现 `{` 或 `}`（`{…}` 插值），**或**整枚落在 `{…}` 插值层里（`strExpr` 同理）；
 *    - `paren-inner-bound` 一级 `(...)` / `[...]` 内含 `?` 或 `#`——**注意这类今天有的已涂、有的没涂**：
 *      假文段的原子不禁 `?`/`#`，故 `(A?B#C)` 出现在假文段就涂得（真语料实测 8 枚里 3 枚已涂）；
 *      出现在条件段/真文段则弃。脚本另出 `innerBoundPainted` 单列这一格，正是看板要的「单独量清」。
 *    - `paren-deep` 两层及以上嵌套括号（语料高频形是 `[[角色]]`）；名册没给「括号未配平」单列一格，
 *      而今天的形状判据把「未配平」与「两层嵌套」算同一条括号账（判据头注原文「括号未配平/两层嵌套」），
 *      故一并归此格，另用 `parenUnbalanced` 单列枚数备复验（真语料实测 0 枚，两者不混）；
 *    - `quote`  段内有 `"`；`backslash` 段内有 `\`；
 *    - `semicolon` **裸文本行（root 态）**才有：段内含 `;`，或该形状整体落在引号外 `;` 之后的注释区
 *      （串里的 `;` 是正文，与 root 态「引号外 `;` 起注释」同一纪律 ⇒ 串内不计）；
 *    - `clean`  以上全无 ⇒ 今天就该涂上（唯一例外见下面 `noElse`）。
 *    **主因优先级 = 名册列出顺序**（`pct > brace > paren-inner-bound > paren-deep > quote > backslash > semicolon`）：
 *    一只形状可同时命中多项，名册按此定序取**首个**命中作主因，`byCause` 因此逐枚不重不漏、各数相加恰等于分母。
 * 3. **今天涂得上否**：把 `erbInlineTernaryShape` 的正则（含 `str` 态 `extraForbid=''` / root 态 `';'` 两条）
 *    与一个**极简状态机**在本行走一遍：root / str / strExpr / strStr / comment 五态逐字符镜像
 *    `erb-language.ts` 的 `"`、`;`、`\\.`、`%…%`、`{…}` 五条转移；再加一格跨行的 **skip**（`[SKIPSTART]`…
 *    `[SKIPEND]` 原样块，块内引擎不解析 ⇒ 三元规则根本轮不到；块内出现 `[SKIPSTART]` 不重入，与
 *    `erbSkipRule` 的"嵌套不解析"同口径）。标记两枚字符串是本脚本的**字形镜像**（契约真源
 *    `plugin-api/src/erb.ts::ERB_SKIP_MARKERS`，裸 node 吃不下那枚桶的桶，见 PITFALLS 151/207），
 *    由 `tools/tests/erb-paint-coverage.test.ts` 逐字节对拍契约常量钉住。
 *    **没去跑 Monaco 真 lexer** 是刻意的：那要把 app 侧模块拖进构建链（同一道坑），且相位机一落地
 *    这格就作废；字符级成因才是长期口径。已知不建模的一格：行续 `\`（`str` 态规则 ⑩ 只管行尾）。
 * 4. **理论上限 `ceiling`**：相位机把 `%`/`{}`/括号统统能吃下之后仍**必须**弃涂的，只有
 *    `quote` / `backslash` / `semicolon` 三项（它们打断的是串边界、转义与注释/死区界——不是着色层，是**语义边界**）。
 *    故 `ceiling` = 不含这三项**任一**命中（不看主因，看全标志）的形状数，`mustDrop` = 分母 − `ceiling`。
 *
 * ## 读数怎么自洽（跑完当场可验，无需第二个工具）
 * `completeShapes === Σ byCause`；`ceiling + mustDrop === completeShapes`；
 * `paintableToday ≤ byCause.clean + byCause["paren-inner-bound"]`，两者之差 = `noElse`（真源认、
 * 但缺顶层 `#` 的无 else 残形——看板给的八项名册**不含**这一格，故它计入 `clean` 却不计入
 * `paintableToday`，用 `noElse` 单列说明；本仓真语料实测 0 枚）+ 落在条件段/真文段而被弃的
 * `paren-inner-bound`（这类今天一半涂得一半涂不得，`innerBoundPainted` 就是「今天就已涂」那半）。
 *
 * JSON 除看板点名的 `files / linesScanned / completeShapes / byCause / paintableToday / ceiling`
 * 六格外，另附五格把上面的自洽式补齐：`mustDrop` / `noElse` / `innerBoundPainted` / `parenUnbalanced`
 * / `skipBlockShapes`（后者是 `semicolon` 那格里"整枚坐在 `[SKIPSTART]` 死区"的那部分，与"段内含 `;`"分开）。
 *
 * 2026-10-26 首跑全量读数（eraTW 画蛇添足 4.980，`ERB/` 3,971 份 / 4,126,929 行，只读）：
 *   分母 9,244 枚（看板那格 9,248 是旧量法的 naive `indexOf`，多认了 4 枚区间嵌套）；
 *   今天涂上 6,818（73.8%）。**看板那格 7,282 / 78.7% 是旧量法的高估**：它只查段内 `" \ % { }` 五个字符，
 *   看不见三类"今天 lexer 根本不进三元规则"的落点（引号外 `;` 注释区、`[SKIPSTART]` 死区 234 枚、
 *   整枚坐在 `%…%`/`{…}` 插值层）与括号结构——差额不是回退，是同一分母下量得更严。
 *   弃涂 2,426 = `pct` 1,879 + `semicolon` 287（含死区 234）+ `paren-deep` 117 + `quote` 85
 *   + `brace` 57 + 条件段那枚 `paren-inner-bound`；自洽式当场成立：`ΣbyCause = 9,244`、
 *   `paintableToday 6,818 = clean 6,816 + innerBoundPainted 2`（`noElse` 0 枚）、`ceiling + mustDrop = 9,244`。
 *   相位机理论上限 `ceiling` 8,477 = **91.7%**（余下 767 枚撞串边界/转义/注释与死区界，必须继续弃涂）。
 *
 * ## 落地后的口径（PAINT-21 交付批 2026-10-26，读这一条再看数）
 * `paintableToday` 这格**冻结在"改造前"**：它建模的是体感批 v2 那条"整形状一次匹配"的判据，留着它是为了
 * 让"改前 / 改后"永远有同一把尺可以对照，不代表当前 lexer 的能力（相位机一落地它就成了历史数）。
 * **当前覆盖率由活闸量**：`packages/app/tests/erb-ternary-paint.corpus.test.ts` 跑的是真 Monarch，
 * 交付批实测（同一份语料，活代码视野分母）＝默认取样面 **0.902**、全树 **0.937**（对照本脚本的
 * 改前 73.8% ⇒ 涨 16 个百分点，且①插值零回退 / ②涂 ⊆ 认两条违例均为 0）。本脚本与活闸的差值不是矛盾：
 * 前者按字符类建模"会不会弃涂"，后者按真状态机数"涂没涂上"，分母口径也不同（后者摘除注释视野）。
 * 剩下的缺口以 `quote` / `semicolon` / 未配对 `%`（取模 `LOCAL/1000%60` 与插值 `%…%` 同形）为主。
 *
 * ## 用法（仓库根）
 *   node tools/erb-paint-coverage.mjs                       # 默认：按内容自动发现语料，扫其 ERB/ 全量
 *   node tools/erb-paint-coverage.mjs --root <目录>          # 显式指语料根或其 ERB/ 子目录（显式即授权）
 *   node tools/erb-paint-coverage.mjs --limit 800           # 只扫前 N 份（路径升序取前 N，控成本用）
 *   node tools/erb-paint-coverage.mjs --samples 0           # 只要 JSON 行，不打印样例
 *   node tools/erb-paint-coverage.mjs --help
 * 输出：第一行 JSON 汇总（确定性），其后每成因最多 N 条**原样语料样例**（文件相对路径:行号 + 整行原文），
 * 样例按「文件路径升序 → 行号升序 → 列升序」取前 N ——同输入两次逐字节相同。
 * 退出码：0 正常 / 1 语料不在位或 `--root` 不成立 / 2 镜像与真源对拍不一致（fail-closed，尺子漂了）。
 *
 * ## 只读纪律
 * 全程只 `readdirSync` / `readFileSync`，绝不写语料盘（AGENTS.md §二 6：游戏目录整体只读）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCorpusDir, CorpusError, ENV_VAR } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const INLINE_TS = path.join(repoRoot, 'packages', 'plugins', 'condition-extractor', 'src', 'inline.ts');

/** 成因名册（顺序即主因优先级；`clean` 恒末）。新增一格必须先在看板 ERB-PAINT-21 那行登记。 */
export const CAUSES = Object.freeze([
  'pct',
  'brace',
  'paren-inner-bound',
  'paren-deep',
  'quote',
  'backslash',
  'semicolon',
  'clean',
]);
/** 相位机也吃不下的三项（串边界 / 转义 / 注释与死区界），`ceiling` 的扣减依据 */
export const MUST_DROP = Object.freeze(['quote', 'backslash', 'semicolon']);

/** 路径码点升序（与 locale 无关的确定性序；样例取前 N 与 --limit 取前 N 都用它）。 */
const cmpPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ───────────────────────── 真源镜像：区间切分 ─────────────────────────
// 与 inline.ts 的 findTopLevel / scanTextTernaries **逐字同语义**（那份不导出区间，本脚本要区间）；
// 每行都拿真源的返回值对拍，漂开即抛——见文件头「口径 1」。
function findTopLevel(s, from, hit) {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; continue; }
    if (c === '}' || c === ')' || c === ']') { if (depth > 0) depth--; continue; }
    if (depth === 0 && hit(s, i)) return i;
  }
  return -1;
}
const atTextOpen = (s, i) => s[i] === '\\' && s[i + 1] === '@';

/** 一行里真源认得的每枚形状：`{open, q, close, text}`（open/close 是 `\@` 的 `\` 位置）。 */
export function shapeSpansOf(line) {
  const out = [];
  let cursor = 0;
  for (;;) {
    const open = line.indexOf('\\@', cursor);
    if (open < 0) break;
    const q = findTopLevel(line, open + 2, (s, i) => s[i] === '?' || atTextOpen(s, i));
    if (q < 0) break; // 无顶层 `?`：残句，后面也不会有完整三元（与真源同一 break 口径）
    if (atTextOpen(line, q)) { cursor = q + 2; continue; } // 空条件 `\@\@`
    const text = line.slice(open + 2, q).trim();
    const close = findTopLevel(line, q + 1, atTextOpen);
    if (close < 0) break; // 未闭合：不猜
    if (text.length > 0) out.push({ open, q, close, text });
    cursor = close + 2;
  }
  return out;
}

/** 逐行对拍：镜像与真源必须给出逐字相同的 `{text, column}` 序列。 */
function assertMirrorAgrees(line, spans, truth, where) {
  const mine = spans.map((s) => ({ text: s.text, column: s.open }));
  if (JSON.stringify(mine) !== JSON.stringify(truth)) {
    throw new Error(
      `[尺子漂移] ${where}\n  真源 scanTextTernaries = ${JSON.stringify(truth)}\n  本脚本镜像      = ${JSON.stringify(mine)}\n  行原文 = ${JSON.stringify(line)}`,
    );
  }
}

// ───────────────────────── 状态模型（今天 lexer 状态栈的极简镜像）─────────────────────────
/**
 * 插值层的「闭合记号在闭合引号之前」前瞻（镜像 `str` 态规则 ④⑤ 的 `(?=[^"}]*\})` / `(?=[^"%]*%)`：
 * 从开层记号之后扫，遇 `"` 或行尾即否，遇收栈记号即真）。
 * 必须**就地锚定**：写成「在剩余串里任意处 test」会把闭引号之后的记号也算进来，
 * `"%…\@…\@%"` 那种「层没成、整枚其实在 root」的判读就会翻车。
 */
function layerCloses(line, from, closeCh) {
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '"') return false;
    if (c === closeCh) return true;
  }
  return false;
}

/**
 * 逐字符给出「本字符之前的 lexer 状态」：root / str / strExpr / strStr / comment。
 * 转移只镜像 `erb-language.ts` 里会改栈的五条：root 的 `"` 进串、root 引号外 `;` 起注释、
 * str 的 `%…%` / `{…}` 两层开层（前瞻见 `layerCloses`）、str 的 `"` 出栈、
 * str 的 `\\.` 吃掉下一字符（转义的 `"` 不闭合）。子层里 `%` / `}` 收栈回 str。
 */
export function statesOf(line) {
  const st = new Array(line.length + 1).fill('root');
  let s = 'root';
  for (let i = 0; i < line.length; i++) {
    st[i] = s;
    const c = line[i];
    if (s === 'root') {
      if (c === ';') s = 'comment';
      else if (c === '"') s = 'str';
    } else if (s === 'str') {
      if (c === '\\') { st[i + 1] = 'str'; i++; continue; } // ① 转义吃掉下一字符
      if (c === '"') s = 'root';
      else if (c === '%' && layerCloses(line, i + 1, '%')) s = 'strStr';
      else if (c === '{' && layerCloses(line, i + 1, '}')) s = 'strExpr';
    } else if (s === 'strStr') {
      if (c === '%') s = 'str';
    } else if (s === 'strExpr') {
      if (c === '}') s = 'str';
    }
    // comment 到行尾，无回栈
    st[i + 1] = s;
  }
  return st;
}

// ───────────────────────── 今天形状判据的镜像（str / root 两条）─────────────────────────
/** `erbInlineTernaryShape(extraForbid)` 的正则镜像；Monarch 是「当前位」匹配，故加 `^` 锚。 */
function todayShapeRegex(extraForbid) {
  const never = `"\\\\%{}()\\[\\]${extraForbid}`;
  const unit = (forbid) => {
    const atom = `[^${never}${forbid}]`;
    return `(?:${atom}|\\(${atom}*\\)|\\[${atom}*\\])`;
  };
  return new RegExp(`^(\\\\@)(${unit('?#')}+)(\\?)(${unit('#')}*)(#)(${unit('')}*)(\\\\@)`);
}
const RX_STR = todayShapeRegex('');
const RX_ROOT = todayShapeRegex(';');

// ───────────────────────── 成因判定 ─────────────────────────
/** 一段文本里的括号结构事实：一级组内含 `?`/`#`、两层及以上嵌套、配平与否。 */
function bracketFacts(seg) {
  const stack = [];
  let deep = false;
  let innerBound = false;
  let strayClose = 0;
  for (const c of seg) {
    if (c === '(' || c === '[' || c === '{') {
      if (stack.length >= 1) deep = true;
      stack.push({ bound: false });
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (top) { if (top.bound) innerBound = true; } else strayClose++;
      continue;
    }
    if (stack.length > 0 && (c === '?' || c === '#')) stack[stack.length - 1].bound = true;
  }
  return { deep, innerBound, unbalanced: stack.length + strayClose > 0 };
}

/**
 * 一枚形状的成因标志（全量标志，非主因——`ceiling` 要看全标志，主因才按定序收敛）。
 * @param segs 三段（条件 / 真文 / 假文；缺顶层 `#` 时假文段即 `?` 之后全部）
 * @param state 形状起点 `\@` 之前的 lexer 状态（statesOf 给出）
 */
export function flagsOfShape(segs, state) {
  const all = segs.join('\u0001');
  const bf = segs.map(bracketFacts);
  return {
    // 段内撞插值记号，**或整枚形状就坐在插值子层里**（那层今天被 strStr/strExpr 整块吃成 `variable`，
    // 三元规则根本轮不到——同一成因、同一条「既有插值着色不许回退」的纪律，故并进同名册格）。
    pct: /%/.test(all) || state === 'strStr',
    brace: /[{}]/.test(all) || state === 'strExpr',
    'paren-inner-bound': bf.some((x) => x.innerBound),
    // 名册没单列「括号未配平」：形状判据头注把「未配平」与「两层嵌套」并成同一格（`(` 之后要一层就收口），
    // 故归 `paren-deep`，另在 summary 的 `parenUnbalanced` 单列枚数以便复验（真语料实测 0 枚）。
    'paren-deep': bf.some((x) => x.deep || x.unbalanced),
    quote: /"/.test(all),
    backslash: /\\/.test(all),
    // `;` 只在引号外生效（串里的 `;` 是正文，与 codeViewOf 的注释隔离同口径）：
    // root 态段内含 `;`，或整枚落在引号外 `;` 之后的注释区 / `[SKIPSTART]` 原样块，都算这一格。
    // 注释区与 SKIP 死区是**同一族屏蔽语义**（引擎既不编译也不执行；`erb-parser/src/folding.ts`
    // 的屏蔽判据把「`[SKIPSTART]`…`[SKIPEND]` 死区」与 `;!;`/`;#;` 前缀并列，见 PITFALLS 211），
    // 名册不再为死区另开一格；两族各多少枚由 summary 的 `semicolon` 与 `skipBlockShapes` 分别可查。
    semicolon: state === 'comment' || state === 'skip' || (state === 'root' && /;/.test(all)),
    unbalanced: bf.some((x) => x.unbalanced),
  };
}

/** 主因：按 `CAUSES` 定序取首个命中（`clean` 兜底）。 */
export function mainCause(flags) {
  for (const c of CAUSES) if (flags[c]) return c;
  return 'clean';
}

/**
 * 一行 → 每枚形状的成因判定（行内状态在这里算；跨行的屏蔽死区由调用方按 `SKIP_MARKERS` 判后传进来，
 * 因为 Monarch 的 `skip` 态本来就是**跨行**的栈，逐行独立算不出来）。
 * @param line 单行原文（不含行尾换行）
 * @param scanTextTernaries 语义真源（由调用方注入，本函数绝不换尺子）
 * @param where 出错信息里的定位（`文件:行号`）
 * @param inSkipBlock 本行是否落在 `[SKIPSTART]`…`[SKIPEND]` 原样块内（引擎不编译不执行）
 */
export function classifyLine(line, scanTextTernaries, where = '', inSkipBlock = false) {
  if (!line.includes('\\@')) return [];
  const spans = shapeSpansOf(line);
  assertMirrorAgrees(line, spans, scanTextTernaries(line), where);
  const st = inSkipBlock ? null : statesOf(line);
  const out = [];
  for (const s of spans) {
    const state = inSkipBlock ? 'skip' : st[s.open];
    // 顶层 `#` 切真/假（`假文段`之后全是假文，与引擎「首个顶层 #」一致）
    const hash = findTopLevel(line, s.q + 1, (t, i) => t[i] === '#' && i < s.close);
    const segs = [
      line.slice(s.open + 2, s.q),
      hash > 0 ? line.slice(s.q + 1, hash) : '',
      hash > 0 ? line.slice(hash + 1, s.close) : line.slice(s.q + 1, s.close),
    ];
    const flags = flagsOfShape(segs, state);
    // 注释区 / 死区 / 插值子层里今天轮不到三元规则；root 与 str 两条各吃自己的 extraForbid。
    const rx = state === 'str' ? RX_STR : state === 'root' ? RX_ROOT : null;
    const painted = rx !== null && rx.exec(line.slice(s.open)) !== null;
    out.push({
      column: s.open,
      cause: mainCause(flags),
      flags,
      painted,
      noElse: hash < 0,
      skip: state === 'skip',
      text: s.text,
    });
  }
  return out;
}

// ───────────────────────── 扫盘 ─────────────────────────
const FILE_RE = /\.(erb|erh)$/i;

/**
 * `[SKIPSTART]` / `[SKIPEND]` 的**字形镜像**（契约真源 = `packages/plugin-api/src/erb.ts::ERB_SKIP_MARKERS`）。
 * 为什么在这里手抄而不是 import：本脚本走裸 node 类型擦除直读源码，而 `@kojo/plugin-api` 桶会连带装载
 * `io.ts` 的参数属性 ⇒ `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（PITFALLS 151 / 207 同一道坑）。
 * 抄来的两枚字符串由 `tools/tests/erb-paint-coverage.test.ts` 逐字节对拍契约常量钉住，漂开即红。
 */
export const SKIP_MARKERS = Object.freeze({ start: '[SKIPSTART]', end: '[SKIPEND]' });

/** 递归收集语料文件，码点升序（确定性：`--limit` 与样例前 N 都依赖这份序）。 */
export function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    const dirs = [];
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue; // 语料盘无链，防环照 tools/corpus.mjs 的口径
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) dirs.push(p);
      else if (ent.isFile() && FILE_RE.test(ent.name)) out.push(p);
    }
    dirs.sort(cmpPath);
    for (const d of dirs.reverse()) stack.push(d);
  }
  return out.sort(cmpPath);
}

/** 大小写不敏感找 `ERB` 子目录（语料根直接给的是外层时）。 */
function findErbDir(root) {
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.toLowerCase() === 'erb') return path.join(root, ent.name);
    }
  } catch { /* 交给调用方判不存在 */ }
  return null;
}

/**
 * 扫语料出读数。`--root` / `--limit` 的语义在这里收口，CLI 与测试共用一条路。
 * @returns {{summary: object, samples: Map<string, string[]>}}
 */
export function scan({ root, limit = 0, samples = 3, scanTextTernaries }) {
  const byCause = Object.create(null);
  let files = 0;
  let linesScanned = 0;
  let completeShapes = 0;
  let paintableToday = 0;
  let ceiling = 0;
  let mustDrop = 0;
  let noElse = 0;
  let innerBoundPainted = 0;
  let parenUnbalanced = 0;
  let skipBlockShapes = 0;
  /** 成因 → 样例队列（队列在扫盘序即「文件路径升序 → 行号升序 → 列升序」下入队，取前 N 就是确定性的前 N） */
  const sampleLines = new Map();
  const sampleOf = (cause) => {
    const hit = sampleLines.get(cause);
    if (hit) return hit;
    const fresh = [];
    sampleLines.set(cause, fresh);
    return fresh;
  };

  let target = root;
  const erbDir = findErbDir(root);
  if (erbDir) target = erbDir;
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`扫描根不成立（既不是目录，也不是语料根/ERB 子目录）：${target}`);
  }
  // 样例里的路径锚在语料根（读起来是 `ERB/xxx.ERB:190`），既不带机器绝对前缀（跨机可比），
  // 也不带仓库根的 `../../`（那是相对仓库的路噪）。
  const anchor = erbDir ? root : target;
  const list = listFiles(target);
  const picked = limit > 0 ? list.slice(0, limit) : list;

  for (const file of picked) {
    files++;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // 语料有带 BOM 的
    const lines = text.split(/\r?\n/);
    linesScanned += lines.length;
    // 样例里的路径锚在语料根（读起来是 `ERB/xxx.ERB:190`），既不带机器绝对前缀（跨机可比），
    // 也不带仓库根的 `../../`（那是相对仓库的路噪）。
    const rel = path.relative(anchor, file).replace(/\\/g, '/');
    let inSkip = false; // 是否正落在 `[SKIPSTART]`…`[SKIPEND]` 原样块内（Monarch 的 skip 态跨行，逐行算不出来）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // 三条等值判据照 Monarch `skip` 态与 `erbSkipRule` 的口径：块**外**只有 `[SKIPSTART]` 进块；
      // 块**内**只有 `[SKIPEND]` 出块，块内的 `[SKIPSTART]` 是原样文本（判据注释原文：嵌套不解析）。
      const thisLineInSkip = inSkip;
      if (!inSkip && trimmed === SKIP_MARKERS.start) inSkip = true;
      else if (inSkip && trimmed === SKIP_MARKERS.end) inSkip = false;
      const hits = classifyLine(line, scanTextTernaries, `${rel}:${i + 1}`, thisLineInSkip);
      if (hits.length === 0) continue;
      for (const h of hits) {
        completeShapes++;
        byCause[h.cause] = (byCause[h.cause] || 0) + 1;
        if (h.painted) paintableToday++;
        if (h.cause === 'paren-inner-bound' && h.painted) innerBoundPainted++;
        if (h.cause === 'paren-deep' && h.flags.unbalanced) parenUnbalanced++;
        if (h.noElse) noElse++;
        if (h.skip) skipBlockShapes++;
        const drop = MUST_DROP.some((c) => h.flags[c]);
        if (drop) mustDrop++; else ceiling++;
        const queue = sampleOf(h.cause);
        if (queue.length < samples) queue.push(`${rel}:${i + 1}\t${line.replace(/\s+$/, '')}`);
      }
    }
  }

  const ordered = Object.create(null);
  for (const c of CAUSES) if (byCause[c] !== undefined) ordered[c] = byCause[c];
  return {
    summary: {
      files, linesScanned, completeShapes, byCause: ordered, paintableToday, ceiling,
      mustDrop, noElse, innerBoundPainted, parenUnbalanced, skipBlockShapes,
    },
    samples: sampleLines,
  };
}

// ───────────────────────── CLI ─────────────────────────
const HELP = `erb-paint-coverage.mjs —— 内联文本形三元 \\@…?…#…\\@ 的着色覆盖率与弃涂成因读数（真实语料只读；ERB-PAINT-21 长期判据）

  --root <目录>   语料根目录或其 ERB/ 子目录；缺省按 tools/corpus.mjs 的内容判据自动发现（${ENV_VAR} 可指定）
  --limit N       只扫路径升序的前 N 份文件（控成本；N<=0 或不给 = 全量）
  --samples N     每成因打印几条原样语料样例（缺省 3；0 = 只出 JSON 行）
  --help          本帮助

输出：一行 JSON 汇总 + 每成因最多 N 条 "成因<TAB>文件:行号<TAB>整行原文"（确定性：文件路径升序 → 行号 → 列）。
退出码：0 正常 / 1 语料不在位或 --root 不成立 / 2 镜像与真源对拍不一致（尺子漂了，读数不可信）。`;

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limitRaw = opt('--limit');
  const limit = limitRaw === undefined ? 0 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 0) {
    process.stderr.write(`--limit 要非负整数，收到：${limitRaw}\n`);
    return 1;
  }
  const samplesRaw = opt('--samples');
  const samples = samplesRaw === undefined ? 3 : Number(samplesRaw);
  if (!Number.isInteger(samples) || samples < 0) {
    process.stderr.write(`--samples 要非负整数，收到：${samplesRaw}\n`);
    return 1;
  }
  const rootArg = opt('--root');

  let root;
  if (rootArg) {
    root = path.resolve(rootArg);
    if (!fs.existsSync(root)) {
      process.stderr.write(`--root 指向的目录不存在：${root}\n`);
      return 1;
    }
  } else {
    let dir;
    try {
      // print:false —— 自动选盘那行必须进 stderr，否则 stdout 的第一行就不是 JSON（消费方按行取 JSON）
      dir = resolveCorpusDir({ label: 'erb-paint-coverage', print: false });
    } catch (e) {
      process.stderr.write(`[FAIL] ${e instanceof CorpusError ? e.message : e?.stack ?? e}\n`);
      return 1;
    }
    if (!dir) {
      process.stderr.write(`[FAIL] 盘上未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）\n`);
      return 1;
    }
    process.stderr.write(`[erb-paint-coverage] 语料根 ${dir}\n`);
    root = dir;
  }

  // 语义真源：裸 node 类型擦除直读 TS（形态同 packages/erb-syntax-tree/tools/gen-erb-structure.mjs）
  const { scanTextTernaries } = await import(pathToFileURL(INLINE_TS).href);
  const { summary, samples: sampleLines } = scan({ root, limit, samples, scanTextTernaries });

  process.stdout.write(JSON.stringify(summary) + '\n');
  for (const cause of CAUSES) {
    const list = sampleLines.get(cause);
    if (!list || list.length === 0) continue;
    process.stdout.write(`# ${cause}（${summary.byCause[cause]} 枚）\n`);
    for (const s of list) process.stdout.write(`${cause}\t${s}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(2);
  });
}
