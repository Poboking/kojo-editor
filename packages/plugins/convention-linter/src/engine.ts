/**
 * 约定校验引擎（游戏无关）。
 *
 * 职责：装配规则 → **按 `scope` 分流**运行 → 归一化/去重/排序 → 汇总报告 → 通知订阅者。
 * 规则来源：
 *   - 内置通用规则（本插件自带，零游戏知识）；
 *   - 当前适配器的 `conventions`（游戏知识，注入回调提供）。
 *
 * 两档粒度（2026-10-12「按文件增量」批）：
 *   - `scope:'project'`（缺省）：判定依赖跨文件事实 → 每次整项目重算；
 *   - `scope:'file'`：判定只看单文件 → 引擎按 `ErbIndex.fileMtimes` **逐文件复用上次结论**，
 *     作者改一个 ERB 只重算那一个文件。
 *   逐规则计时实测（真实语料）显示 55% 的成本在一条**纯逐文件**规则上，这就是切分的依据。
 *
 * 稳健性原则（对应内核「不静默」铁律）：
 *   - 单条规则抛错不中断全局 → 记入 `failedRules`，报告中显式呈现；
 *   - 抛错的规则/文件**不进快照**：坏一次不能永久缓存坏结果；
 *   - 声明 `scope:'file'` 却没实现 `checkFile` ⇒ 显式记失败，不静默跳过；
 *   - 文件读取失败 → 记入日志并跳过该规则本次对该文件的判定（不伪造结果）。
 */

import type {
  CacheExpect,
  ConventionCheckContext,
  ConventionIssue,
  ConventionLinterService,
  ConventionReport,
  ConventionRule,
  ConventionSeverity,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { CONVENTION_SEVERITY_ORDER } from '@kojo/plugin-api';
import { duplicateFunctionRule } from './rules/duplicate-function';
import { sugarStaticConventionsRule } from './rules/sugar-conventions';
import type { LintCache, LintFileBucket } from './snapshot';

/**
 * 逐文件规则的并发上限（沿用规则内部原来的 `mapLimit(…, 12, …)` 口径）。
 * 现在由**引擎**驱动这个循环：桶归引擎持有，规则只描述"一个文件怎么判"。
 */
const LINT_FILE_CONCURRENCY = 12;

/** 限并发执行（结果写进调用方的 Map；装配仍按 walk 顺序取 ⇒ 输出与完成顺序无关） */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

export interface ConventionEngineDeps {
  log: Logger;
  /** 当前打开的项目（未打开时 null） */
  getProject(): GameProject | null;
  /** 当前已构建的索引（未就绪时 null） */
  getIndex(): ErbIndex | null;
  /** 读文件纯文本（引擎在一次运行内记忆化） */
  readFile(path: string): Promise<string>;
  /** 当前激活适配器提供的规则（按 project.adapterId 过滤后的结果） */
  getAdapterRules(): readonly ConventionRule[];
  /**
   * 结果快照端口（2026-10-12「体感丝滑」批 →「按文件增量」批；缺省 = 不缓存）。
   *
   * 三层判据各管各的粒度（详见 `./snapshot.ts`）：全局层由插件组装（引擎不懂 adapter 吃了
   * 哪些非 ERB 输入），整项目层比 `ErbIndex.fingerprint`，逐文件层比 `ErbIndex.fileMtimes`。
   * `save` 收到的是**本次实际拿到的结果**（复用 + 新算），且**不含**任何抛错规则/文件的结论。
   */
  snapshot?: {
    expectFor(args: { project: GameProject; rules: readonly ConventionRule[] }): CacheExpect | null;
    load(expect: CacheExpect): Promise<LintCache | null>;
    save(cache: LintCache, expect: CacheExpect): void;
  };
}

/** 空报告（未打开项目 / 索引未就绪时返回，保证 UI 有稳定数据形状） */
function emptyReport(adapterId: string): ConventionReport {
  const now = Date.now();
  return {
    adapterId,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    issues: [],
    counts: { error: 0, warning: 0, info: 0 },
    ruleCount: 0,
    failedRules: [],
  };
}

function compareIssues(a: ConventionIssue, b: ConventionIssue): number {
  const s = CONVENTION_SEVERITY_ORDER[a.severity] - CONVENTION_SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  const r = a.ruleId.localeCompare(b.ruleId);
  if (r !== 0) return r;
  const f = (a.filePath ?? '').localeCompare(b.filePath ?? '');
  if (f !== 0) return f;
  return (a.line ?? 0) - (b.line ?? 0);
}

export class ConventionEngine implements ConventionLinterService {
  private readonly builtinRules: readonly ConventionRule[] = [
    duplicateFunctionRule,
    sugarStaticConventionsRule,
  ];
  private last: ConventionReport | null = null;
  /** 在途运行（自动触发与面板手动重跑叠跑 = 白跑两遍 3.1 s，故共享同一次） */
  private inFlight: Promise<ConventionReport> | null = null;
  private readonly listeners = new Set<(report: ConventionReport | null) => void>();

  constructor(private readonly deps: ConventionEngineDeps) {}

  rules(): readonly ConventionRule[] {
    return [...this.builtinRules, ...this.deps.getAdapterRules()];
  }

  report(): ConventionReport | null {
    return this.last;
  }

  subscribe(cb: (report: ConventionReport | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.last);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 执行全部规则并返回报告（覆盖缓存并通知订阅者）。
   *
   * `force` = **一定真重算**：面板「重新校验」按钮是用户的显式意图，
   * 不该被结果缓存糊住（命中与否都由本次运行落盘最新快照）。
   */
  run(opts?: { force?: boolean }): Promise<ConventionReport> {
    if (this.inFlight) return this.inFlight;
    const p = this.runOnce(opts).finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async runOnce(opts?: { force?: boolean }): Promise<ConventionReport> {
    const project = this.deps.getProject();
    const index = this.deps.getIndex();
    if (!project || !index) {
      const rep = emptyReport(project?.adapterId ?? '');
      this.commit(rep);
      return rep;
    }

    const startedAt = Date.now();
    const rules = this.rules();
    const force = opts?.force === true;

    /**
     * 按声明粒度分流。`scope` 缺省 = `'project'`（跨文件语义，只能整项目重算）。
     * 声明 `'file'` 却没实现 `checkFile` 的规则**显式记失败**，不静默跳过——
     * 否则"加了 scope 忘了改实现"会表现成"这条规则什么都没报"，正是本项目的铁律禁止的形态。
     */
    const projectRules = rules.filter((r) => r.scope !== 'file' && typeof r.check === 'function');
    const fileRules = rules.filter((r) => r.scope === 'file');
    const runnableFileRules = fileRules.filter((r) => typeof r.checkFile === 'function');
    const failedRules: { ruleId: string; error: string }[] = rules
      .filter((r) => (r.scope === 'file' ? typeof r.checkFile !== 'function' : typeof r.check !== 'function'))
      .map((r) => ({
        ruleId: r.id,
        error: `scope='${r.scope ?? 'project'}' 但缺 ${r.scope === 'file' ? 'checkFile' : 'check'} 实现（已跳过）`,
      }));

    // 一次运行内的文件读取记忆化：多条规则共享同一份文本（避免重复读 2k+ 文件）
    const textCache = new Map<string, Promise<string>>();
    const checkCtx: ConventionCheckContext = {
      project,
      index,
      readFile: (path: string): Promise<string> => {
        let p = textCache.get(path);
        if (!p) {
          p = this.deps.readFile(path);
          textCache.set(path, p);
        }
        return p;
      },
      log: this.deps.log,
    };

    /** 全局判据（不含 ERB 指纹）；null ⇒ 既不还原也不落盘 */
    const expect = this.deps.snapshot ? this.deps.snapshot.expectFor({ project, rules }) : null;
    const stored = this.deps.snapshot && expect && !force ? await this.deps.snapshot.load(expect) : null;

    /**
     * 整项目层能否复用：**必须**本次索引带 `fingerprint` 且与缓存里那条相等。
     * 逐文件层不看它，只看桶里的 mtime（见下）——把两件事合成一个判据就是
     * "改一个文件重算全库"的由来（§5.70 同一课）。
     */
    const canReuseProject = !force && !!stored && !!index.fingerprint && stored.erbFingerprint === index.fingerprint;

    const ruleTimings: { ruleId: string; ms: number; issues: number; reused: boolean }[] = [];
    const projectResults: Record<string, ConventionIssue[]> = {};

    for (const rule of projectRules) {
      const t0 = Date.now();
      const cached = canReuseProject ? stored!.projectResults[rule.id] : undefined;
      if (cached) {
        projectResults[rule.id] = cached;
        ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: cached.length, reused: true });
        continue;
      }
      try {
        const produced = (await rule.check!(checkCtx)) ?? [];
        projectResults[rule.id] = produced;
        ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: produced.length, reused: false });
      } catch (err) {
        // 抛错的规则**不写 projectResults** ⇒ 下次必然重算它（坏一次不能永久缓存坏结果）
        failedRules.push({ ruleId: rule.id, error: err instanceof Error ? err.message : String(err) });
        this.deps.log.warn(`Convention rule '${rule.id}' failed: ${String(err)}`);
        ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: 0, reused: false });
      }
    }

    /**
     * 逐文件层：按本次索引顺序（= walk 顺序）决定"复用桶"还是"只算这个文件"。
     * 任一侧 mtime 取不到 ⇒ 该文件判过期（保守重算），别的路径不受影响。
     */
    const files = [...index.files.values()];
    const buckets: Record<string, Record<string, LintFileBucket>> = {};
    let recomputedFiles = 0;
    for (const rule of runnableFileRules) {
      const t0 = Date.now();
      const prev = stored?.buckets[rule.id] ?? {};
      const fresh = new Map<string, LintFileBucket>();
      const stale = files.filter((f) => {
        const mtime = index.fileMtimes?.get(f.path) ?? null;
        const b = prev[f.path];
        return !(b && b.mtimeMs !== null && mtime !== null && b.mtimeMs === mtime);
      });
      let ruleFailed = false;
      await mapLimit(stale, LINT_FILE_CONCURRENCY, async (file) => {
        try {
          const produced = (await rule.checkFile!(checkCtx, file)) ?? [];
          fresh.set(file.path, { mtimeMs: index.fileMtimes?.get(file.path) ?? null, issues: produced });
        } catch (err) {
          // 抛错的文件**不留桶**：下次重算它，而不是把"这次没结论"当成永久结论
          ruleFailed = true;
          this.deps.log.warn(`Convention rule '${rule.id}' failed on ${file.path}: ${String(err)}`);
        }
      });
      if (ruleFailed) {
        failedRules.push({ ruleId: rule.id, error: `逐文件判定失败 ${stale.length - fresh.size} 个文件（详见日志）` });
      }
      recomputedFiles += fresh.size;
      // 装配按 walk 顺序 ⇒ 增量与全量同序（与索引/抽取段同一份纪律）
      const out: Record<string, LintFileBucket> = {};
      let count = 0;
      for (const file of files) {
        const b = fresh.get(file.path) ?? prev[file.path];
        if (!b) continue; // 这次没结论（读失败 / 索引换了） ⇒ 不伪造
        out[file.path] = b;
        count += b.issues.length;
      }
      buckets[rule.id] = out;
      ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: count, reused: stale.length === 0 });
    }

    // 汇总：整项目结论在前、逐文件结论按 (规则, walk 顺序) 在后，再统一去重 + 排序
    const issues: ConventionIssue[] = [];
    const seen = new Set<string>();
    const push = (raw: ConventionIssue, fallbackRuleId: string, severity: ConventionSeverity): void => {
      const normalized: ConventionIssue = {
        ...raw,
        ruleId: raw.ruleId || fallbackRuleId,
        severity: raw.severity ?? severity,
      };
      const key =
        normalized.key ??
        `${normalized.ruleId}|${normalized.filePath ?? ''}|${normalized.line ?? 0}|${normalized.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ ...normalized, key });
    };
    for (const rule of projectRules) {
      for (const raw of projectResults[rule.id] ?? []) push(raw, rule.id, rule.severity);
    }
    for (const rule of runnableFileRules) {
      for (const path of Object.keys(buckets[rule.id] ?? {})) {
        for (const raw of buckets[rule.id]![path]!.issues) push(raw, rule.id, rule.severity);
      }
    }

    issues.sort(compareIssues);
    const counts: Record<ConventionSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const i of issues) counts[i.severity]++;

    const finishedAt = Date.now();
    const executed = projectRules.length + runnableFileRules.length;
    const report: ConventionReport = {
      adapterId: project.adapterId,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      issues,
      counts,
      ruleCount: executed,
      failedRules,
    };
    this.deps.log.info(
      `Convention lint: ${issues.length} issue(s) ` +
        `(error ${counts.error} / warning ${counts.warning} / info ${counts.info}) ` +
        `in ${report.durationMs}ms across ${executed} rule(s)` +
        (failedRules.length ? `, ${failedRules.length} rule(s) failed` : ''),
    );
    // 规则顺序 = 执行顺序（确定性）；`复用` 标记是"增量到底命中没有"的读数
    this.deps.log.info(
      `  lint breakdown: ${ruleTimings
        .map((t) => `${t.ruleId} ${t.ms}ms/${t.issues}项${t.reused ? '(复用)' : ''}`)
        .join(' · ')}` + ` ｜ 逐文件重算 ${recomputedFiles} 个文件`,
    );
    this.commit(report);

    /**
     * 落盘：只在真算过东西时写（全命中再刷一遍是纯浪费）。
     * `index.fingerprint` 缺失时存空串——下次 `canReuseProject` 仍判假，保守不命中。
     */
    if (this.deps.snapshot && expect && (recomputedFiles > 0 || ruleTimings.some((t) => !t.reused))) {
      this.deps.snapshot.save(
        { erbFingerprint: index.fingerprint ?? '', projectResults, buckets },
        expect,
      );
    }
    return report;
  }

  private commit(report: ConventionReport): void {
    this.last = report;
    for (const cb of [...this.listeners]) {
      try {
        cb(report);
      } catch (err) {
        this.deps.log.warn(`Convention listener threw: ${String(err)}`);
      }
    }
  }
}
