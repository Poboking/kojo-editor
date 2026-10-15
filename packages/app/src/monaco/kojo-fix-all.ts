import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorDecoratorContribution,
  EditorTextEdit,
  GameProject,
  LineDecoration,
} from '@kojo/plugin-api';
import {
  diagnosticKey,
  monacoActionKind,
  pickPreferred,
  quickFixOwnership,
  type PreferredCandidate,
} from './kojo-code-action';

/**
 * E3「全部修复」——**当前文档**范围内的批量快速修复。
 *
 * ## 它到底是什么
 *
 * 💡（`Ctrl+.`）一次只解一条红线。本模块把同一份文档里**所有"唯一解"的快速修复**
 * 一次落地：判据与 `isPreferred` 的星标**是同一条**（`quickFixOwnership` ⇒ `pickPreferred`），
 * 于是"星标亮起来的那几条 = 一键能补的那几条"，作者看到的两处信号不会互相说谎。
 *
 * ## 三条不可让步的纪律
 *
 * 1. **不替作者选**：一条诊断有两个及以上改法 ⇒ 批量**永不碰它**（多解计数如实报，
 *    见 `FixAllRound.ambiguous`）；`refactor` 类动作（如「改为 .kojo 写法」）压根不是
 *    "某条红线的解"，一并排除——批量只改"错了的地方"，不改"能更好的地方"。
 * 2. **相撞不静默**：修法会重写**整条锚行**（`structure-fix.ts`），于是嵌套未闭合块的
 *    补词天然撞在同一行上。撞了就**分轮**：本轮只落地互不相交的一批，剩下的下一轮
 *    重新采集再判。绝不出现"后写覆盖先写"。
 * 3. **只有当前文档**：批量写盘要横跨未打开的文件与写允许域（铁律 5/6），不属于这里；
 *    落地只经宿主既有的 `applyTextEdits` 通道 = 改 model、不碰磁盘、`Ctrl+Z` 可撤。
 *
 * ## 分层
 *
 * `planFixAllRound`（纯函数：判定 + 挑互不相交的一批）／`runFixAll`（轮次循环，一切
 * 外部世界经 `FixAllDeps` 的四个回调注入）／`fixAllSummary`（作者面那句话说什么）。
 * 本文件**不 import Monaco、不 import React、不读盘**——宿主接线在 `EditorPane.tsx`，
 * 只做"model 进、executeEdits 出"的协议翻译。
 */

/** 轮次上界。每轮至少落地一个碰撞簇里的一条 ⇒ 正常收敛远早于此；
 * 留上界只为防"改完又长出新问题"的不收敛贡献方把主线程挂死（一次采集 = 一遍全文扫描）。 */
export const MAX_FIX_ALL_ROUNDS = 16;

/** 一条候选动作的**中性事实**（归一后的类别 + 它认领的诊断 + 它要改的行） */
export interface BulkFixCandidate extends PreferredCandidate {
  readonly edits: readonly EditorTextEdit[];
  /** 作者面标题（调试与日志用；不进批量判据） */
  readonly title?: string;
}

/** 一轮的产出与残留（**计数单位一律是"处"= 诊断条数**，作者心里的量词就是它） */
export interface FixAllRound {
  /** 本轮可安全合并落地的改写（彼此行区间不相交；落地侧按行号降序应用） */
  readonly edits: readonly EditorTextEdit[];
  /** 本轮消解掉的诊断条数 */
  readonly fixed: number;
  /** 有两个及以上改法 ⇒ 一条都不碰 */
  readonly ambiguous: number;
  /** 与已选批次行区间相撞 ⇒ 让给下一轮 */
  readonly conflicted: number;
  /** 唯一解但改不了文本（只能靠 `run` 发意图的动作）⇒ 不自动执行 */
  readonly manual: number;
  /** 唯一解，但那一条改法同时还要解另一条"有多种改法"的问题 ⇒ 跟着一起等 */
  readonly bundled: number;
  /** 这份文档里压根没有对应改法的诊断条数 */
  readonly unclaimed: number;
}

/** `runFixAll` 的总账（跨轮累加 fixed；残留取**最后一轮**的采集结果，不重复计数） */
export interface FixAllReport extends Omit<FixAllRound, 'edits'> {
  /** 实际落地了几轮（= 几个撤销步；0 = 什么都没改） */
  readonly rounds: number;
  /** 撞上轮次上界被停下（残留里还有没动的） */
  readonly capped: boolean;
}

/** 行区间归一（`EditorTextEdit` 是 1 基闭区间；`fromLine > toLine` 是贡献方的手滑，不是错误） */
function rangeOf(edit: EditorTextEdit): readonly [number, number] {
  const lo = Math.min(edit.fromLine, edit.toLine);
  const hi = Math.max(edit.fromLine, edit.toLine);
  return [lo, hi];
}

function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** 相邻行**不算**相撞：降序应用时下方替换不动上方行号（与 `applyTextEdits` 同一口径） */
function conflictsWith(taken: readonly (readonly [number, number])[], ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some((r) => taken.some((t) => overlaps(r, t)));
}

/**
 * 一轮批量计划：从「面上的诊断 + 供方给出的动作」里挑出**本轮就能自动落地**的那一批。
 *
 * 选择顺序刻意按**锚行升序**（文档自上而下），同锚行按槽位查询顺序——同样的输入必得
 * 同样的输出，作者 `Ctrl+Z` 后重按不会拿到另一份结果。
 *
 * 残留计数把**每一条诊断恰好归进一个桶**（fixed / ambiguous / conflicted / manual /
 * bundled / unclaimed）：作者听到的数字必须对得上他眼前的红线条数，"有一条没动但没说
 * 为什么"就是静默（铁律 4）。
 */
export function planFixAllRound(
  actions: readonly BulkFixCandidate[],
  diagnostics: readonly LineDecoration[],
): FixAllRound {
  const { owners } = quickFixOwnership(actions, diagnostics);
  const unique = pickPreferred(actions, diagnostics); // ← 与 isPreferred 同一条判据

  const accepted = new Set<number>();
  const conflicted = new Set<number>();
  const manual = new Set<number>();
  const taken: (readonly [number, number])[] = [];
  const order = [...unique]
    .map((index) => ({ index, ranges: actions[index]!.edits.map(rangeOf) }))
    .sort((a, b) => {
      const la = a.ranges[0]?.[0] ?? Number.MAX_SAFE_INTEGER;
      const lb = b.ranges[0]?.[0] ?? Number.MAX_SAFE_INTEGER;
      return la !== lb ? la - lb : a.index - b.index;
    });
  for (const { index, ranges } of order) {
    // 没有行级改写的动作 = 只能由作者自己点那一下（批量不代跑 `run`：它可能弹框、可能写盘）
    if (ranges.length === 0) manual.add(index);
    else if (conflictsWith(taken, ranges)) conflicted.add(index);
    else {
      accepted.add(index);
      taken.push(...ranges);
    }
  }

  let fixed = 0;
  let ambiguous = 0;
  let conflictedCount = 0;
  let manualCount = 0;
  let bundled = 0;
  let unclaimed = 0;
  const seen = new Set<string>();
  for (const decoration of diagnostics) {
    const key = diagnosticKey(decoration);
    if (seen.has(key)) continue; // 同一条诊断画成两条重叠波浪线只算一处
    seen.add(key);
    const claimants = owners.get(key) ?? [];
    if (claimants.length === 0) unclaimed++;
    else if (claimants.length > 1) ambiguous++;
    else {
      const index = claimants[0]!;
      if (!unique.has(index)) bundled++; // 它自己只有一个解，但那个解还绑着别处的多解
      else if (accepted.has(index)) fixed++;
      else if (manual.has(index)) manualCount++;
      else conflictedCount++;
    }
  }
  return {
    // 产出顺序 = 选择顺序（锚行升序）：同一份文档重按必得同一批，日志与调试也读得懂
    edits: order.filter(({ index }) => accepted.has(index)).flatMap(({ index }) => [...actions[index]!.edits]),
    fixed,
    ambiguous,
    conflicted: conflictedCount,
    manual: manualCount,
    bundled,
    unclaimed,
  };
}

/* ------------------------- 采集（两枚槽，抛错隔离） ------------------------- */

/** 整篇文档当下的诊断：直接问 `ui.editor.decorator` 全部贡献（**渲染面上那些波浪线的同源真源**）。 */
export function documentDiagnostics(
  decorators: readonly EditorDecoratorContribution[],
  file: { path: string; text: string; project: GameProject | null },
): LineDecoration[] {
  const out: LineDecoration[] = [];
  for (const contribution of decorators) {
    try {
      out.push(...contribution.decorate(file));
    } catch {
      // 单个装饰器抛错不影响其余（与波浪线刷新同一条隔离纪律：退化可见，不让批量整轮崩）
    }
  }
  return out;
}

/**
 * 整篇文档当下的批量候选动作：问 `ui.editor.codeAction` 全部贡献，**scope = 'document'**
 * （= 明确告诉供方"这是一次全文批量，不是某一行上的 💡"）。
 *
 * 为什么不复用 `collectCodeActions`：那一份的产物是 Monaco 的 CodeAction 形状（要挂进 💡
 * 菜单、要反查 command id），批量只要"类别 + 认领的诊断 + 改写"三样中性事实。
 * 抛错隔离与那边同口径：单个贡献抛错只丢它自己的动作。
 */
export function documentQuickFixes(
  contributions: readonly EditorCodeActionContribution[],
  file: { path: string; text: string; project: GameProject | null; lineCount: number; diagnostics: readonly LineDecoration[] },
): BulkFixCandidate[] {
  const out: BulkFixCandidate[] = [];
  for (const contribution of contributions) {
    let provided: EditorCodeAction[];
    try {
      provided = contribution.provideActions({
        path: file.path,
        text: file.text,
        project: file.project,
        lineCount: file.lineCount,
        diagnostics: [...file.diagnostics],
        scope: 'document',
      });
    } catch {
      continue;
    }
    for (const action of provided) {
      out.push({
        kind: monacoActionKind(action.kind),
        diagnostics: action.diagnostics ?? [],
        edits: action.edits ?? [],
        title: action.title,
      });
    }
  }
  return out;
}

/* ------------------------------ 轮次循环 ------------------------------ */

/**
 * 外部世界的四个口子（宿主注入）：批量本身不认识 Monaco、不认识文件系统。
 * `readText` / `lineCount` **每轮重取**——上一轮已经把文档改过了，行号坐标系跟着动。
 */
export interface FixAllDeps {
  readonly decorators: readonly EditorDecoratorContribution[];
  readonly codeActions: readonly EditorCodeActionContribution[];
  readonly path: string;
  readonly project: GameProject | null;
  readText(): string;
  lineCount(): number;
  /** 落一批行级改写（宿主 = 一次 `executeEdits` = **一个撤销步**）；返回是否真落了 */
  apply(edits: readonly EditorTextEdit[]): boolean;
}

/**
 * 一轮一轮地补，直到「本轮无可落地的一批」。
 *
 * 为什么分轮而不是"一次算完全部再合并"：撞在同一锚行上的两个补词，**谁先谁后是语义选择**
 * （决定哪个块覆盖到哪一行），批量不替作者做这个选择——但也不该因此永远动不了。
 * 分轮正好：本轮先落地其中不与人相撞的那一条，下一轮重新采集时另一条的锚点已经变了、
 * 不再相撞，于是自然排开。代价是**多轮 = 多个撤销步**（`Ctrl+Z` 一次退一轮），
 * 这是刻意的取舍：把它们硬合成一次全文替换，要另起一套"宿主自己算最终文本"的机制，
 * 等于给同一份文档造第二个真源。
 */
export function runFixAll(deps: FixAllDeps): FixAllReport {
  let fixed = 0;
  let rounds = 0;
  let residual: FixAllRound = {
    edits: [],
    fixed: 0,
    ambiguous: 0,
    conflicted: 0,
    manual: 0,
    bundled: 0,
    unclaimed: 0,
  };
  let capped = false;
  for (;;) {
    const text = deps.readText();
    const diagnostics = documentDiagnostics(deps.decorators, { path: deps.path, text, project: deps.project });
    const actions = documentQuickFixes(deps.codeActions, {
      path: deps.path,
      text,
      project: deps.project,
      lineCount: deps.lineCount(),
      diagnostics,
    });
    const plan = planFixAllRound(actions, diagnostics);
    residual = plan;
    if (plan.edits.length === 0) break;
    if (rounds >= MAX_FIX_ALL_ROUNDS) {
      capped = true;
      break;
    }
    if (!deps.apply(plan.edits)) break;
    fixed += plan.fixed;
    rounds++;
  }
  return {
    fixed,
    rounds,
    capped,
    ambiguous: residual.ambiguous,
    conflicted: residual.conflicted,
    manual: residual.manual,
    bundled: residual.bundled,
    unclaimed: residual.unclaimed,
  };
}

/* ---------------------------- 作者面那一句话 ---------------------------- */

/**
 * 结果的人话措辞（**单一真源**：命令面板、通知、将来的按钮都从这里取，别抄第二份）。
 *
 * 去黑话：不出现 CodeAction / quickfix / marker；量词一律"处"。
 * 残留必须说清**为什么没动**（多解 / 要逐处确认 / 跟着别处一起定 / 没有改法），
 * 否则作者会以为"点了没反应"（铁律 4）。
 */
export function fixAllSummary(report: FixAllReport): string {
  const tail: string[] = [];
  if (report.ambiguous > 0) tail.push(`${report.ambiguous} 处有多种改法，需要你逐处选`);
  if (report.bundled > 0) tail.push(`${report.bundled} 处要跟那些待选的改法一起定`);
  if (report.manual > 0) tail.push(`${report.manual} 处要你在波浪线上逐处确认`);
  if (report.conflicted > 0) tail.push(`${report.conflicted} 处补的位置撞在一起，本轮没动`);
  if (report.capped) tail.push(`已到 ${MAX_FIX_ALL_ROUNDS} 轮上限，剩下的请手动处理`);
  if (report.unclaimed > 0) tail.push(`${report.unclaimed} 处目前没有可自动补的改法`);
  if (report.fixed === 0) {
    return tail.length === 0
      ? '这一份没有要补的问题'
      : `这一份没有能一起补好的问题：${tail.join('；')}`;
  }
  const head = `已补好 ${report.fixed} 处（只改了编辑器里的内容，可按 Ctrl+Z 撤销）`;
  return tail.length === 0 ? head : `${head}；${tail.join('；')}`;
}
