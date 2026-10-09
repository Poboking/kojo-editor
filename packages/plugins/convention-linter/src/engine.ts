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
  private readonly builtinRules: readonly ConventionRule[] = [duplicateFunctionRule];
  private last: ConventionReport | null = null;
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

  async run(): Promise<ConventionReport> {
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

    for (const rule of executed) {
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
    this.commit(report);
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
