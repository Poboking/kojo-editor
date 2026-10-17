/**
 * 约定校验问题 → **编辑器诊断面**（DIAG-LINK，2026-10-18）。
 *
 * 补的断层：`convention.linter` 的报告一直只有面板在读——项目级校验（含
 * `erb.duplicate-function` 这种大问题）在 Monaco **零波浪线**、不进问题面板、`Ctrl+.`
 * 捞不到、`workbench.fixAll` 永远碰不到；状态栏「问题 n」与面板的 convention-counts
 * 是两本互不对账的数。本模块把同一份 `ConventionIssue` 折成两个面共用的**同一批对象**：
 * 槽 `ui.editor.decorator`（波浪线 + 问题面板）与槽 `ui.editor.codeAction`（💡）。
 *
 * 为什么身份键收在这里而不是两个面各写一遍：宿主把 `LineDecoration` 翻成 Monaco marker，
 * `Ctrl+.` 时又把面上 marker 反翻译回来（`app/src/monaco/kojo-code-action.ts` 的
 * `markersToDecorations`），按 **严重级 + 行 + 消息 + 诊断码** 认定"这条动作修的就是这条
 * 红线"（`diagnosticKey`）。⇒ 装饰与动作必须出自同一个 {@link conventionIssueDecoration}：
 * 两处各拼一遍 `{line, severity, message, code}`，改一处忘另一处的症状是"波浪线上按不出
 * 菜单"——静默、不报错。{@link conventionIssueKey} 的尺子逐字对齐宿主那个 `diagnosticKey`
 * （刻意**不含列**：列在正反向翻译里会被补默认值，进了键就成了两条不同诊断）。
 *
 * 纪律（与全仓同口径）：
 * - **无 `edits` ⇒ 无动作**：给不出可证明改法的规则只出波浪线，绝不凭空造 quickfix；
 * - **落点失效 ⇒ 整条动作不给**：`loc`/`end` 的列越过当下缓冲区那行的实际长度（作者已经
 *   继续打字）就放弃这次动作，绝不按陈旧坐标硬写；
 * - **严重度三档如实**：`info` 不许折成 `warning` 也不许被吞（`erb.duplicate-function`
 *   整条就是 info，吞了等于"重复定义在编辑器里不存在"）；
 * - **只按文件归属**：`filePath` 缺失的整项目级结论不进装饰面（它不属于任何一行），
 *   面板与报告照旧统计它们 ⇒ 不是静默；
 * - **线只由最近邻画一次**：`.kojo` 上的糖族行装饰归 `ui-sugar-editor`（本层**不再发第二条**，
 *   但 issue 逐条照旧进桶，项目级结论一条不少）；判据见 {@link conventionSquiggleOwnedElsewhere}。
 *
 * 纯函数：issues 进、装饰与动作出，不读盘不写盘不碰 Monaco（`ui.editor.*` 槽契约）。
 */

import type {
  ConventionIssue,
  ConventionSeverity,
  EditorCodeAction,
  EditorTextEdit,
  LineDecoration,
} from '@kojo/plugin-api';
import { diagnosticDisplay, isKojoFile, pathKey } from '@kojo/plugin-api';
import { isSugarFamilyRuleId, sugarFamilyCodeOf } from './rules/sugar-conventions';

/**
 * ## 波浪线**归属**（2026-10-19 自造重叠清账批）
 *
 * `.kojo` 源里的糖族诊断，行装饰归 `ui-sugar-editor#sugar-diagnostics`：它对着**实时转译
 * 产物**画（作者敲下的每一拍都算数），列区间也是它给的——它是那份真相的最近邻。本层过去
 * 本层过去**也为同一件事发一条**行装饰（只差 `sugar.` 前缀），于是同一行两条 marker ⇒ 问题面板每条显示
 * 两行、计数翻倍。这一笔是本轮并行批自己欠作者的账，就在这里清掉。
 *
 * 只裁决**"线归谁画"这一层**：
 * - `issues` 照旧逐条进桶 ⇒ 整项目报告、`report.counts`、面板分组、💡 供方读的还是同一份
 *   项目级结论（**没有**为了去重把结论一起删掉）；
 * - 非糖族规则（`erb.duplicate-function` 那些）波浪线照旧由本层发——它们没有别家；
 * - 归属判据住在本层（ruleId 前缀 + 契约的 `.kojo` 判定两个事实），**不在宿主合并层**：
 *   宿主按行去重就是第三把尺子。
 */
export function conventionSquiggleOwnedElsewhere(issue: ConventionIssue): boolean {
  return isKojoFile(issue.filePath) && isSugarFamilyRuleId(issue.ruleId);
}

/**
 * 一条问题**在面上的身份**（{@link conventionIssueDecoration} 的入参预处理）。
 *
 * 归属在别家时，`code` 必须回落到**画上去那一条**用的转译器码本名（去掉面板前缀）：
 * 宿主 `diagnosticKey` 按 `严重级 + 行 + 消息 + 码` 认领，本层若继续挂 `sugar.*` 那份码，
 * `Ctrl+.` 就再也认不出面上那条线——症状是"搬「续」/注释只读别名这两条一键修法凭空消失"
 * （静默的功能倒退）。前缀与逆运算同住 `rules/sugar-conventions.ts`，此处不另算。
 */
function surfaceIdentityOf(issue: ConventionIssue): ConventionIssue {
  return conventionSquiggleOwnedElsewhere(issue)
    ? { ...issue, ruleId: sugarFamilyCodeOf(issue.ruleId) }
    : issue;
}

/**
 * 一条问题的一键修法 = 契约里那条 **`ConventionIssue.edits` 的元素**（就是糖侧那条
 * `SugarEdit`：`{ loc: Loc; end?: Loc; newText; description? }`，1 基行 / **0 基列**、`end` 不含）。
 *
 * 刻意**从 `ConventionIssue` 上取**而不是另 import 一个同名类型：本层与契约之间因此不可能
 * 漂移（契约改名/改形，这里立刻跟着红），也不会出现"折叠层自己的一套 edit 形状"这第二真相。
 */
export type ConventionIssueEdit = NonNullable<ConventionIssue['edits']>[number];

/** 修法的落点形状（同样从契约上取，不另 import、不另造） */
type IssueEditLoc = ConventionIssueEdit['loc'];

/** 按文件归属后的一棵文件（`issues` 保报告序；`decorations` 按行升序 = 面上顺序） */
export interface ConventionFileBucket {
  readonly path: string;
  readonly issues: readonly ConventionIssue[];
  readonly decorations: readonly LineDecoration[];
}

/** 一次报告的装饰视图（键 = {@link pathKey}；两个面都只按路径查它） */
export type ConventionIssueView = ReadonlyMap<string, ConventionFileBucket>;

/** 逐规则的修法供给方（`fixes.ts`）。问题自带 `edits` 时**优先用自带**，本供给方只兜底 */
export type ConventionIssueFixResolver = (
  issue: ConventionIssue,
  lines: readonly string[],
) => readonly ConventionIssueEdit[];

export interface ConventionCodeActionRequest {
  readonly path: string;
  /** 当前**缓冲区**全文（宿主给的 model 文本，不是盘上那份） */
  readonly text: string;
  /** 光标行（1 基；区间请求的缺省筛选） */
  readonly line?: number;
  /** 请求范围（E3：`'document'` = 整篇批量，不按 `line` 筛） */
  readonly scope?: 'range' | 'document';
  /** 面上正画着的波浪线（B9）；给了就**只应答对得上的那些**，空数组 ⇒ 一条都不应答 */
  readonly diagnostics?: readonly LineDecoration[];
  /** 该文件可写？（缺省 = 未知，按可写处理）只读文件给动作会造出"只读文件被改脏"的怪态 */
  readonly writable?: boolean;
  /** 逐规则修法兜底（见 {@link ConventionIssueFixResolver}） */
  readonly fixResolver?: ConventionIssueFixResolver;
}

/** 严重度 → marker 严重级（**三档如实**；新增一档忘了映射即编译期红，绝不静默降级） */
export function conventionSeverityToDecoration(
  severity: ConventionSeverity,
): LineDecoration['severity'] {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  if (severity === 'info') return 'info';
  const exhaustive: never = severity;
  return exhaustive;
}

/**
 * 一条问题 → 那一条波浪线（**装饰与动作共用的唯一真源**）。
 *
 * `code` 取 `ruleId`：问题面板分组、`Ctrl+.` 的关联判据、💡 动作的反查读的都是它，
 * 三处必须给同一个字符串。列**只在这里 +1**（契约的 `column` 是 **0 基**、`LineDecoration.startColumn`
 * 是 **1 基** UTF-16 码元；尺子见 `plugin-api/src/conventions.ts` 头注与 `sugar.ts` 的 `Loc`——
 * 全链这一次加法是**唯一**一次，别处再减再加就是第二把尺子）。
 * `source` 取 `ruleId` 的**中文显示名**（走 plugin-api 的公开函数 `diagnosticDisplay`，
 * 不抄表、不抠消息）；未登记的码 `diagnosticDisplay` 会原样回落 ⇒ 此时**不给 `source`**
 * （给了就是拿原码冒充中文名，Monaco 会显示成「原码 — 原码」；登记归 `diagnostic-copy.ts`，
 * 全覆盖闸会红，不该由折叠层遮）。
 *
 * 返回 `null` = 这条问题**没有可画的位置**（无 `filePath` 或无 `line`）——不猜行号。
 */
export function conventionIssueDecoration(issue: ConventionIssue): LineDecoration | null {
  const line = issue.line;
  if (!issue.filePath || typeof line !== 'number' || line < 1) return null;
  const display = diagnosticDisplay(issue.ruleId);
  return {
    line,
    severity: conventionSeverityToDecoration(issue.severity),
    message: issue.message,
    // 0 基列 → 1 基起始列：全链唯一一次 `+1`（负数/非有限值 = 生产者算坏了，宁可退回整行也不画 NaN 列）
    ...(isContractColumn(issue.column) ? { startColumn: issue.column + 1 } : {}),
    ...(display.name !== issue.ruleId ? { source: display.name } : {}),
    code: issue.ruleId,
  };
}

/**
 * 一条问题**在面上那一条波浪线的身份**（归属在别家时按别家发布的码，见 {@link surfaceIdentityOf}）。
 * 本层自己发装饰走 {@link conventionIssueDecoration}，💡 认领走这一枚——两处读同一份归属判据。
 */
export function conventionSurfaceDecoration(issue: ConventionIssue): LineDecoration | null {
  return conventionIssueDecoration(surfaceIdentityOf(issue));
}

/** 契约列（**0 基**，见 `conventions.ts` 头注）是否是一个可用的列位 */
function isContractColumn(column: number | undefined): column is number {
  return typeof column === 'number' && Number.isFinite(column) && column >= 0;
}

/** 一条波浪线的身份键（尺子逐字对齐宿主 kojo-code-action.ts:68-70 的 diagnosticKey：
 * 严重级 + 行 + 消息 + 诊断码；**不含列**（正反向翻译会补默认列），**不含 `source`**
 * （它是显示标签，写进身份键就是拿呈现当判据）。 */
export function conventionIssueKey(d: LineDecoration): string {
  return [d.severity, d.line, d.message, d.code ?? ''].join(SEP);
}

const SEP = String.fromCharCode(0);

/**
 * 一次报告的 issues → 按文件归属的装饰视图（{@link ConventionIssueView}）。
 *
 * 为什么先折成表：`decorate` 每次装饰刷新都要按路径取一次（宿主按打开的标签逐棵调），
 * 报告可以有几千条 ⇒ 现算就是每棵文件全表扫。这里一次遍历建表，装饰面 O(1) 取。
 * issues **按 `pathKey` 归桶**（Windows 折叠大小写）——分隔符/大小写两种写法来自
 * 不同通道（索引 vs 事件 vs 编辑器），拿原始字符串当键就是"同文件两种归属"。
 */
export function buildConventionIssueView(
  issues: readonly ConventionIssue[],
): ConventionIssueView {
  const out = new Map<string, { path: string; issues: ConventionIssue[]; decorations: LineDecoration[] }>();
  for (const issue of issues) {
    const path = issue.filePath;
    if (!path) continue; // 整项目级结论（无文件归属）不进装饰面：它不属于任何一行
    const key = pathKey(path);
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { path, issues: [], decorations: [] };
      out.set(key, bucket);
    }
    bucket.issues.push(issue);
    // 归属在别家（`.kojo` 的糖族线 = `ui-sugar-editor#sugar-diagnostics`）⇒ **只记账、不再画线**
    if (conventionSquiggleOwnedElsewhere(issue)) continue;
    const decoration = conventionIssueDecoration(issue);
    if (decoration) bucket.decorations.push(decoration);
  }
  for (const bucket of out.values()) bucket.decorations.sort((a, b) => a.line - b.line);
  return out;
}

/** 某一棵文件当下该画的波浪线（无归属/无问题 ⇒ 空数组，不是 undefined） */
export function conventionDecorationsForFile(
  view: ConventionIssueView,
  path: string,
): LineDecoration[] {
  const bucket = view.get(pathKey(path));
  return bucket ? [...bucket.decorations] : [];
}

/** 与规则侧 `split(/\r\n|\n|\r/)` 同一口径：行号坐标系必须和产 issue 的那批扫描器一致 */
export function toIssueLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 一处列级修法 → 宿主的**整行替换**语义（`EditorTextEdit` 只有行区间，没有列）。
 *
 * ## 尺子（全仓一把，换算只在这几行）
 * `edit.loc` / `edit.end` **就是契约里的 `Loc`**（`plugin-api/src/sugar.ts:85-90`）：
 * **行 1 基、列 0 基、`end` 不含**——`ConventionIssue.edits` 与糖侧回写共用同一个形状，
 * 于是这里拿列**零换算**（`String.slice` 天生吃 0 基下标）。唯一需要 `+1` 的是
 * {@link conventionIssueDecoration} 里的 `issue.column → startColumn`（marker 那一头是 1 基）。
 * 语法节点那一族（`SugarPosition`，1 基列）的 `-1` 归**规则投影那一端**做一次
 * （`rules/sugar-conventions.ts`），折进本层之后再减一次就是双份换算 = 错位一列。
 *
 * 做法：把 `newText` 按列缝回它所在的那几行（首行保留起点之前的部分、末行保留终点之后的
 * 部分）——整行重写时**不吞掉作者写在这一行的别的东西**。
 * **`end` 省略 = 整行替换 `loc.line`**（契约 `sugar.ts:103` 写死的口径，`loc.column` 此时不参与）：
 * 一键修法里"搬标记 / 注释掉无效赋值"这类改法天生吃整行，缝列反而会保住不该保的东西。
 * 缺 `loc`（契约要求、运行时兜底）⇒ 退回替换该条 issue 的 `line`。
 *
 * 返回 `null` = 落点在当下缓冲区里不成立（行号越界 / 列超过那行的实际长度：报告算自**盘上
 * 那份文本**，缓冲区可能已被继续编辑）⇒ 放弃，不硬写。
 */
export function foldIssueEdit(
  edit: ConventionIssueEdit,
  issueLine: number | undefined,
  lines: readonly string[],
): EditorTextEdit | null {
  if (lines.length === 0) return null;
  const start = edit.loc as IssueEditLoc | undefined;
  if (!start) {
    if (typeof issueLine !== 'number' || issueLine < 1 || issueLine > lines.length) return null;
    return { fromLine: issueLine, toLine: issueLine, newText: edit.newText };
  }
  const from = start.line;
  const to = edit.end?.line ?? from;
  if (from < 1 || to < from || to > lines.length) return null;
  if (!edit.end) return { fromLine: from, toLine: to, newText: edit.newText }; // 整行替换（见上）
  // `Loc.column` 已是 0 基下标 ⇒ 直接用（这一层不减不加；见上方尺子注）
  const startOffset = start.column;
  const endOffset = edit.end.column;
  if (startOffset < 0 || endOffset < startOffset) return null;
  const first = lines[from - 1]!;
  const last = lines[to - 1]!;
  if (startOffset > first.length || endOffset > last.length) return null;
  return {
    fromLine: from,
    toLine: to,
    newText: first.slice(0, startOffset) + edit.newText + last.slice(endOffset),
  };
}

/**
 * 某一棵文件的 💡 动作（`ui.editor.codeAction` 的 `provideActions` 本体）。
 *
 * 三条筛选，一条都不许含糊：
 * 1. **位置**：区间请求（缺省）必须有 `line`——位置未知就不猜（与 `erb-structure-fix`
 *    同一条口径）；`scope: 'document'`（E3「全部修复」）不按行筛。
 * 2. **面上画着什么**（B9）：宿主递来 `diagnostics` 时**只应答对得上的那些**
 *    （按 {@link conventionIssueKey} 精确匹配，不近似）；递来空数组 = 这个区间压根没有
 *    波浪线 ⇒ 一条都不应答。没递（旧宿主）才退回按行筛。
 * 3. **有没有修法**：`issue.edits` 优先；没有就问 {@link ConventionIssueFixResolver}；
 *    两者都空 ⇒ **不产动作**（波浪线照旧在，绝不给一个修不动红线的 quickfix）。
 *    多处修法里任一处落点失效 ⇒ 整条动作不给（不给半截）。
 */
export function conventionCodeActionsForFile(
  view: ConventionIssueView,
  request: ConventionCodeActionRequest,
): EditorCodeAction[] {
  if (request.writable === false) return [];
  const scope = request.scope ?? 'range';
  if (scope !== 'document' && request.line === undefined) return [];
  const bucket = view.get(pathKey(request.path));
  if (!bucket) return [];
  const lines = toIssueLines(request.text);
  const requested = request.diagnostics
    ? new Set(request.diagnostics.map((d) => conventionIssueKey(d)))
    : null;
  const out: EditorCodeAction[] = [];
  for (const issue of bucket.issues) {
    if (scope !== 'document' && issue.line !== request.line) continue;
    // 认领的是**面上那一条**的身份（糖族在 `.kojo` 上由 `sugar-diagnostics` 发布 ⇒ 码不带面板前缀），
    // 否则 B9 的键对不上、这两条一键修法会凭空消失（见 {@link conventionSquiggleOwnedElsewhere}）
    const decoration = conventionSurfaceDecoration(issue);
    if (!decoration) continue;
    if (requested && !requested.has(conventionIssueKey(decoration))) continue;
    const rawEdits = issue.edits?.length
      ? issue.edits
      : (request.fixResolver?.(issue, lines) ?? []);
    if (rawEdits.length === 0) continue; // 无修法 ⇒ 无动作（不猜）
    const edits: EditorTextEdit[] = [];
    let stale = false;
    for (const edit of rawEdits) {
      const folded = foldIssueEdit(edit, issue.line, lines);
      if (!folded) {
        stale = true;
        break;
      }
      edits.push(folded);
    }
    if (stale) continue;
    out.push({
      // 动作名**一律不含原码**（W1f 的呈现纪律：面板/💡 的 title 只显示一次，原码由
      // `code` 那份通道给）。优先用修法自带的说明（契约字段 `description`）；规则没给就取
      // `ruleId` 的中文显示名，**绝不拿 message 当标题**（消息已经挂在关联诊断上，再拼进
      // 标题就是双份显示）。
      title: rawEdits[0]!.description || diagnosticDisplay(issue.ruleId).name,
      kind: 'quickfix',
      // B9：原样交出**同一条** LineDecoration（身份键与装饰面一致 ⇒ Monaco 认得出
      // "这个修复消解的就是这条红线"，于是排序优先、应用后高亮被修区间、hasAutoFix 都成立）
      diagnostics: [decoration],
      edits,
      // 有 edits 时宿主不调 run；给空函数只为满足契约（无改写通道的宿主下无害退化）
      run: () => undefined,
    });
  }
  return out;
}