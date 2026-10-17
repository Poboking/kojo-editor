/**
 * `.kojo` 转译波浪线的**快速修复**（W3；零 React、零内核依赖，可单测）。
 *
 * ## 这个模块为什么存在
 *
 * `.kojo` 面上的转译诊断（`SugarDiagnosticCode` 闭集 37 码，`internal` 之外 36 条）此前
 * **一条都没有 quickfix**：`ui-sugar-editor` 只注册 decorator + saveHandler，本槽位的唯一
 * `.kojo` 供方是 `ui-sugar-lift`，而它给的是 `kind:'refactor'`（「改为 .kojo 写法」不是
 * "某条红线的解"）。宿主 `kojo-fix-all.ts` 明确把 refactor 排除在"唯一解"判据外 ⇒
 * `fixAllSummary` 永远只能说"目前没有可自动补的改法"。本模块补的就是这一格：
 * **消解诊断**的 `kind:'quickfix'`。
 *
 * ## 三条不可让步的纪律
 *
 * 1. **判据收敛 ⇒ 码是闭集**（见 `QUICKFIX_SUGAR_CODES`）。只收"文案已经把一个改法说出口、
 *    且那一处改法写在**本行内**就能落地"的码。要补内容 / 要挪行 / 要查字典的码一律不做——
 *    宁可"这一条没有改法"（作者看得见），不给一个会把文档改坏的按钮。
 * 2. **不造第二套判定**：本模块**不重新解析糖语法**，只读两样既有事实——
 *    ① 宿主递进来的那条 `LineDecoration`（= 面上正画着的 marker，`code`/`message`/`line`
 *    都由 `kojo-sugar` 的转译器说了算）；② 那一行的原文。改法从**诊断文案自己**里取
 *    （文案就是判据的第一手输出），不自己再判一遍"这个名字像不像拼错"。
 * 3. **自证后才交付**（与 `sugar.lift` 的 round-trip 自证同一条精神）：把改写**代回转译器**
 *    再跑一遍波浪线，要求①那条红线的身份键**消失**、②**没有多出**任何新的波浪线。
 *    不过关就一条都不给。于是"这条 quickfix 修得了眼前这条红线"不是我们的乐观假设，
 *    而是转译器当场签的字。
 *
 * ## 只改 model，不写盘
 *
 * 产出的是 `EditorTextEdit`（整行替换语义）——宿主经 Monaco `executeEdits` 落地 = **一次可撤销
 * 的模型编辑**，`Ctrl+Z` 撤回，落盘仍由作者自己按 Ctrl+S 走既有 `sugar-save` 链路
 * （与 `ui-sugar-lift` 的 `lift-action.ts` 同一口径；跨插件不许 import，故这里自带行级
 * 改写器，只消费 `sugar.transpile` 这枚**既有服务槽**）。
 *
 * ## 身份键（B9 的成败就在这）
 *
 * `diagnostics` 里放的是**宿主递进来的那一个对象本身**（不重建、不改字段）：
 * 宿主 `kojo-code-action.ts` 的 `diagnosticKey` 按 `severity|line|message|code`（**刻意不含列**）
 * 认领，列在正向/反向翻译之间未必逐字相等，一旦重建就静默判成两条不同诊断 ⇒
 * 💡 里躺着修不了的动作。这里的 `decorationKey` 与之同口径，只用于**本模块内部**分组，
 * 不与宿主共享一份实现。
 *
 * ## 代价（两遍筛，顺序不能反）
 *
 * Monaco 的 💡 可用性探测在**光标移动**时自动触发，绝大多数请求根本没有可修的红线：
 * 第一遍只做"码在不在闭集 + 那一行的原文"这种零转译的成形判定，一个候选都没有就直接返回；
 * 基准波浪线（一次整篇转译，通常命中服务缓存）与逐候选自证只在真有候选时才付。
 * 候选另有 `verifyBudget` 上限，超额**出声**（`onDegrade`）而不是静默少给。
 *
 * `.kojo` 后缀与写允许域（`kernel.io.isWritable`）两道闸**在接线层**（`index.ts`）——
 * 本模块不认识路径、也不认识 IO，只吃"文本 + 波浪线 + 一枚同源 decorate"。
 */

import type { EditorCodeAction, EditorTextEdit, LineDecoration } from '@kojo/plugin-api';

/* ============================== 收敛的码（闭集） ============================== */

/**
 * 有"唯一解"改法的转译诊断码。
 *
 * - `stray-percent`（warning）：文案自己说「如需输出字面百分号请写成 `％`（全角）」——
 *   一行内**只有一个**半角 `%` 时，"哪个是落单的"没有第二种读法（成对的那些是 `%…%`
 *   变量记号，动不得）；
 * - `function-name-typo`（error，且 error 存在即拒绝编译/写盘）：文案说「两张表里只有
 *   一个相近名「X」…请改成「X(…)」」，唯一改法已写在文案里。
 *
 * 其余码为什么**不在**这张表（都是"拿不准的不做"）：
 * `expr-missing-else` / `rand-case-incomplete`（要补内容 = 替作者编一个值）、
 * `interpolation-*`（要补 `}` / 拆嵌套 = 猜意图）、`indent-mismatch`（正确缩进层级只有
 * 解析器知道，重算就是第二套判定）、`block-empty`（删块头还是补正文？两解）、
 * `alias-not-in-header`（文件头里有 N 个合法落点）、`timing-*`/`unknown-identifier`/
 * `bit-name-unknown`/`family-name-unknown`（要查字典或表 = 游戏知识，不属本插件）、
 * `cont-inside-quotes`（`续` 该挪到引号外还是本就不是标记？文案给了两条路）、
 * `alias-duplicate`/`*-conflict`（删哪一条要作者定）——一律只报位置，不给动作。
 */
export const QUICKFIX_SUGAR_CODES = ['stray-percent', 'function-name-typo'] as const;

export type QuickFixSugarCode = (typeof QUICKFIX_SUGAR_CODES)[number];

/** 一次请求里最多自证几条候选（每条 = 一遍整文转译；预算耗尽**可见退化**，不静默） */
export const DEFAULT_VERIFY_BUDGET = 24;

/* ============================== 行级改写规则 ============================== */

/** 一处收敛的改写：替换进去的**整行**文本（不含行尾 `\r`）+ 作者面标题 */
interface LineRewrite {
  readonly newText: string;
  readonly title: string;
}

/**
 * 规则签名：`(诊断消息, 那一行的原文) → 改写`，判据不收敛就返回 `null`（**不猜**）。
 * 拿消息而不是拿 AST：消息就是转译器（第一判定者）已经给出的结论，本模块只照它动手。
 */
type RewriteRule = (message: string, lineText: string) => LineRewrite | null;

/** `stray-percent`：把落单的半角 `%` 写成全角 `％` */
const fixStrayPercent: RewriteRule = (_message, lineText) => {
  // `split('%').length !== 2` ⇔ 这行有 0 个或 ≥2 个半角 %：
  // 0 个 ⇒ 这条诊断不是本行报的（陈旧/别处）；≥2 个 ⇒ 分不清哪个落单（成对的是变量记号）
  if (lineText.split('%').length !== 2) return null;
  return {
    newText: lineText.replace('%', '\uFF05'),
    title: '把落单的半角 % 写成全角 ％·可 Ctrl+Z 撤回',
  };
};

/**
 * `function-name-typo` 文案的两处取值（唯一真源 = `kojo-sugar/src/expression.ts` 的 error 文案）。
 * 措辞变了这两枚正则就取不到值 ⇒ **一条动作都不给**（fail-closed，绝不照着半截文案改行）。
 */
const TYPO_WRITTEN = /^「([^「」]+?)\(…\)」既不在系统函数表/;
const TYPO_SUGGESTED = /只有一个相近名「([^「」]+?)」/;

/** `function-name-typo`：把那一个调用名换成文案点名的唯一近名 */
const fixFunctionNameTypo: RewriteRule = (message, lineText) => {
  const written = TYPO_WRITTEN.exec(message)?.[1];
  const suggested = TYPO_SUGGESTED.exec(message)?.[1];
  if (written === undefined || suggested === undefined) return null;
  if (written === suggested) return null;
  // 落点只有一个合法答案才动手：`名字(` 在本行出现一次。（诊断的列是**表达式**起点，
  // 不是记号起点，故本模块不猜列——出现次数就是唯一的定位信息，多于一处即放弃。）
  const needle = `${written}(`;
  if (countOccurrences(lineText, needle) !== 1) return null;
  const at = lineText.indexOf(needle);
  return {
    newText: lineText.slice(0, at) + suggested + lineText.slice(at + written.length),
    title: `把「${written}(…)」改成「${suggested}(…)」·可 Ctrl+Z 撤回`,
  };
};

const RULES: Readonly<Partial<Record<QuickFixSugarCode, RewriteRule>>> = {
  'stray-percent': fixStrayPercent,
  'function-name-typo': fixFunctionNameTypo,
};

/* ============================== 身份键 ============================== */

/** 一条波浪线的身份键（`severity|line|message|code`；**不含列**——与宿主 `diagnosticKey` 同口径） */
export function decorationKey(decoration: LineDecoration): string {
  return [decoration.severity, decoration.line, decoration.message, decoration.code ?? ''].join('\u0000');
}

function keyCounts(decorations: readonly LineDecoration[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of decorations) {
    const k = decorationKey(d);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * 自证是否过关：**目标那条消失** 且 **没有任何波浪线变多或新增**。
 *
 * 允许"顺带少了几条"（一处改写消掉两处的确会发生），禁止"修一条冒出另一条"——
 * 后者说明这一下改写动了不该动的东西，作者看到的会是新的红而不是干净的文档。
 */
function converges(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  targetKey: string,
): boolean {
  if ((after.get(targetKey) ?? 0) > 0) return false;
  for (const [key, count] of after) {
    if (count > (before.get(key) ?? 0)) return false;
  }
  return true;
}

/* ============================== 小工具 ============================== */

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/** 整行替换（1 基闭区间，`fromLine === toLine`）；保留行尾 `\r`（CRLF 文件不被改成 LF） */
function lineEdit(line: number, body: string, carryCr: string): EditorTextEdit {
  return { fromLine: line, toLine: line, newText: `${body}${carryCr}` };
}

/* ============================== 主入口 ============================== */

export interface SugarQuickFixRequest {
  /** 当前模型全文（宿主给的缓冲区文本，**不是**磁盘内容） */
  readonly text: string;
  /**
   * 本次请求区间内的波浪线（契约 B9）。**空 / 未给 ⇒ 一条动作都不产**：
   * `Ctrl+.` 是"针对某一条诊断"的请求，没有点明的诊断就是没有可修的对象（不凭空造）。
   */
  readonly diagnostics: readonly LineDecoration[];
  /**
   * 波浪线的**同源真源**：由调用方注入（本插件里就是 `diagnosticDecorations(sugar.transpile(…))`）。
   * 自证要把改写后的文本再喂给它一次——同一个判据跑两遍，不是第二套判定。
   */
  readonly decorate: (source: string) => readonly LineDecoration[];
  /** 自证预算（缺省 `DEFAULT_VERIFY_BUDGET`；`0` = 关闭自证 ⇒ 本模块一律不产动作） */
  readonly verifyBudget?: number;
  /** 预算耗尽 / 跳过候选时的可见退化回执（调用方接 `ctx.log.warn`；铁律 4：不静默） */
  readonly onDegrade?: (reason: string) => void;
}

/**
 * 产出 `.kojo` 转译诊断的快速修复动作（**纯函数**：不读盘、不写盘、不发事件）。
 *
 * 每条动作都**自带 `edits` + 关联诊断**（`kind:'quickfix'`）；同一请求里 refactor 类动作
 * 由别的贡献方（`ui-sugar-lift`）各归各类地共存——本函数只产自己那一类，不去重、不顶替、
 * 不替宿主解释别人的动作（宿主 `quickFixOwnership` 只把 quickfix 计成"某条红线的解"）。
 */
export function buildSugarQuickFixes(request: SugarQuickFixRequest): EditorCodeAction[] {
  const { text, diagnostics, decorate } = request;
  if (diagnostics.length === 0) return [];
  const budget = request.verifyBudget ?? DEFAULT_VERIFY_BUDGET;
  if (budget <= 0) return [];

  const lines = text.split('\n');

  /* 第一遍：**便宜**的成形判定（只看码在不在闭集 + 那一行的原文），一次转译都不跑。
     💡 的可用性探测由 Monaco 在光标移动时自动触发 ⇒ 绝大多数请求压根没有可修的红线，
     这一遍要保证那种请求的代价 ≈ 0（基准转译留给真正有候选的场合）。 */
  const candidates: {
    readonly decoration: LineDecoration;
    readonly rewrite: LineRewrite;
    readonly carryCr: string;
  }[] = [];
  for (const decoration of diagnostics) {
    const code = decoration.code;
    if (code === undefined) continue;
    const rule = RULES[code as QuickFixSugarCode];
    if (rule === undefined) continue;
    if (decoration.line < 1 || decoration.line > lines.length) continue; // 越界行号（夹取归宿主，这里直接放弃）
    const raw = lines[decoration.line - 1] ?? '';
    const carryCr = raw.endsWith('\r') ? '\r' : '';
    const body = carryCr === '' ? raw : raw.slice(0, -1);
    const rewrite = rule(decoration.message, body);
    if (rewrite === null || rewrite.newText === body) continue; // 判据不收敛，或这一下根本什么都没改
    candidates.push({ decoration, rewrite, carryCr });
  }
  if (candidates.length === 0) return [];

  /* 第二遍：**准入 + 自证**。基准那份波浪线必须与面上同源（`transpile` 自带按
     (文本, 路径) 的缓存 ⇒ 这一次调用通常命中缓存，代价是一次映射不是重转译）。 */
  const before = keyCounts(decorate(text));
  const actions: EditorCodeAction[] = [];
  let spent = 0;
  let degraded = false;
  for (const { decoration, rewrite, carryCr } of candidates) {
    const key = decorationKey(decoration);
    if ((before.get(key) ?? 0) === 0) continue; // 陈旧 / 别家装饰器的波浪线 ⇒ 不应答

    if (spent >= budget) {
      if (!degraded) {
        degraded = true;
        request.onDegrade?.(
          `本文件的可自动修候选超过自证预算 ${budget} 条，其余本轮未评估（整篇转译自证的代价上限；下一轮会重新取用额度）。`,
        );
      }
      continue;
    }
    spent++;

    const fixedLines = [...lines];
    fixedLines[decoration.line - 1] = rewrite.newText;
    const after = keyCounts(decorate(fixedLines.join('\n')));
    if (!converges(before, after, key)) continue; // 消不掉、或改出新红 ⇒ 不交

    actions.push({
      title: rewrite.title,
      kind: 'quickfix',
      // **原样**递回宿主给的那条 LineDecoration（同一对象、同一身份键）——B9：关联错了
      // 等于给作者一个修不动眼前红线的动作
      diagnostics: [decoration],
      edits: [lineEdit(decoration.line, rewrite.newText, carryCr)],
      // 有 `edits` 时宿主不调 `run`；仍给以满足契约（且在没有改写通道的宿主下无害退化）
      run: () => undefined,
    });
  }
  return actions;
}
