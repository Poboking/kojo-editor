/**
 * 约定校验引擎（游戏无关）。
 *
 * 职责：装配规则 → 逐条运行 → 归一化/去重/排序 → 汇总报告 → 通知订阅者。
 * 规则来源：
 *   - 内置通用规则（本插件自带，零游戏知识）；
 *   - 当前适配器的 `conventions`（游戏知识，注入回调提供）。
 *
 * 稳健性原则（对应内核「不静默」铁律）：
 *   - 单条规则抛错不中断全局 → 记入 `failedRules`，报告中显式呈现；
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
   * 结果快照端口（2026-10-12「体感丝滑」批；缺省 = 不缓存）。
   *
   * 全量校验真实语料实测 3.1 s，而产出只有 307 KB——级联三段里性价比最高的缓存目标。
   * 与抽取同款分层：**判据由插件组装**（引擎不懂 adapter 吃了哪些非 ERB 输入），
   * 引擎只管"判据齐且命中就跳过重算"。见 `./snapshot.ts`。
   */
  snapshot?: {
    expectFor(args: { project: GameProject; index: ErbIndex; rules: readonly ConventionRule[] }): CacheExpect | null;
    load(expect: CacheExpect): Promise<ConventionReport | null>;
    save(report: ConventionReport, expect: CacheExpect): void;
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
    const executed = rules.filter((r) => typeof r.check === 'function');

    // 判据由插件组装（ERB 指纹 / adapter 输入摘要 / 语义版本 / 规则清单四路）
    const expect = this.deps.snapshot ? this.deps.snapshot.expectFor({ project, index, rules }) : null;
    if (this.deps.snapshot && expect && !opts?.force) {
      const cached = await this.deps.snapshot.load(expect);
      if (cached) {
        this.deps.log.info(
          `Convention lint restored from snapshot: ${cached.issues.length} issue(s) ` +
            `(error ${cached.counts.error} / warning ${cached.counts.warning} / info ${cached.counts.info}) ` +
            `across ${cached.ruleCount} rule(s), originally ${cached.durationMs}ms — compute skipped`,
        );
        this.commit(cached);
        return cached;
      }
    }

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

    const issues: ConventionIssue[] = [];
    const failedRules: { ruleId: string; error: string }[] = [];
    const seen = new Set<string>();
    /**
     * 逐规则耗时（**只进日志，不进报告**：加进 `ConventionReport` 会牵动快照结构与规则摘要，
     * 而"哪条规则贵"是增量缓存设计的输入，不是用户数据）。
     */
    const ruleTimings: { ruleId: string; ms: number; issues: number }[] = [];

    for (const rule of executed) {
      const ruleStartedAt = Date.now();
      const before = issues.length;
      try {
        const produced = (await rule.check!(checkCtx)) ?? [];
        for (const raw of produced) {
          const normalized: ConventionIssue = {
            ...raw,
            ruleId: raw.ruleId || rule.id,
            severity: raw.severity ?? rule.severity,
          };
          const key =
            normalized.key ??
            `${normalized.ruleId}|${normalized.filePath ?? ''}|${normalized.line ?? 0}|${normalized.message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({ ...normalized, key });
        }
      } catch (err) {
        failedRules.push({ ruleId: rule.id, error: err instanceof Error ? err.message : String(err) });
        this.deps.log.warn(`Convention rule '${rule.id}' failed: ${String(err)}`);
      }
      ruleTimings.push({ ruleId: rule.id, ms: Date.now() - ruleStartedAt, issues: issues.length - before });
    }

    issues.sort(compareIssues);
    const counts: Record<ConventionSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const i of issues) counts[i.severity]++;

    const finishedAt = Date.now();
    const report: ConventionReport = {
      adapterId: project.adapterId,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      issues,
      counts,
      ruleCount: executed.length,
      failedRules,
    };
    this.deps.log.info(
      `Convention lint: ${issues.length} issue(s) ` +
        `(error ${counts.error} / warning ${counts.warning} / info ${counts.info}) ` +
        `in ${report.durationMs}ms across ${executed.length} rule(s)` +
        (failedRules.length ? `, ${failedRules.length} rule(s) failed` : ''),
    );
    // 规则顺序 = 执行顺序（确定性）；"哪条规则贵 + 它产出几条"是逐文件增量设计的唯一输入
    this.deps.log.info(
      `  lint breakdown: ${ruleTimings.map((t) => `${t.ruleId} ${t.ms}ms/${t.issues}项`).join(' · ')}`,
    );
    this.commit(report);
    if (this.deps.snapshot && expect) this.deps.snapshot.save(report, expect);
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
