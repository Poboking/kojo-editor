/**
 * 约定校验器契约（v0.2）。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：规则形状、运行上下文、问题、报告、服务接口；
 * - **引擎**（`convention-linter` 插件）：收集规则 → 依次运行 → 汇总报告 → 订阅广播；
 * - **规则实现**：游戏知识类规则住在 game adapter（`adapter.conventions`），
 *   引擎通用类规则住在引擎插件自身（如"函数重名"）。
 *
 * 关键设计：
 * - 规则是**纯函数**（输入上下文 → 输出问题数组），便于单测与复用；
 * - 上下文只暴露通用能力（项目 / 索引 / 读文件 / 日志）——**零游戏知识**；
 * - 单条规则抛错不中断全局，但**绝不静默**（进入 report.failedRules）。
 */

import type { Logger } from './base';
import type { ErbIndex } from './erb';
import type { GameProject } from './game';

/** 问题严重度。产品原则：宁可漏报不可误报（见 RESEARCH.md §7）。 */
export type ConventionSeverity = 'error' | 'warning' | 'info';

/** 一条校验问题 */
export interface ConventionIssue {
  /** 产出它的规则 id */
  ruleId: string;
  severity: ConventionSeverity;
  /** 人类可读描述 */
  message: string;
  /** 定位：文件绝对路径 */
  filePath?: string;
  /** 定位：1 基行号 */
  line?: number;
  /** 关联角色编号（面板分组用） */
  characterNo?: number;
  /** 关联家族名 */
  family?: string;
  /**
   * 稳定去重键：同一问题跨多次运行、跨报告合并时用它判定"同一个"。
   * 缺省由引擎按 `ruleId|filePath|line|message` 合成。
   */
  key?: string;
}

/**
 * 校验运行上下文 —— 引擎构造、规则消费。
 * **刻意不暴露**：适配器对象、家族解析规则、任何游戏常量。
 * 游戏知识规则住在适配器内部，自带私有工具，无需经上下文下发。
 */
export interface ConventionCheckContext {
  readonly project: GameProject;
  /** 口上域函数索引（引擎保证已构建完成） */
  readonly index: ErbIndex;
  /** 读文件文本（UTF-8 内部表示、换行归一化）；引擎在一次运行内记忆化，规则可放心重复调用 */
  readFile(path: string): Promise<string>;
  readonly log: Logger;
}

/** 可校验的剧本约定。`check` 缺省 = 仅登记元数据（未实现校验）。 */
export interface ConventionRule {
  readonly id: string;
  readonly description: string;
  readonly severity: ConventionSeverity;
  /** 依据出处（源文件:行号 / 逆向文档章节），用于校验报告展示 */
  readonly source?: string;
  check?(ctx: ConventionCheckContext): ConventionIssue[] | Promise<ConventionIssue[]>;
}

/** 某条规则本次未能产出结果（执行抛错）——绝不静默 */
export interface ConventionRuleFailure {
  ruleId: string;
  error: string;
}

/** 一次校验运行的完整报告 */
export interface ConventionReport {
  /** 参与运行的适配器 id（无法确定时为 ''） */
  adapterId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** 全部问题（按严重度降序、规则 id 稳定排序） */
  issues: readonly ConventionIssue[];
  /** 按严重度计数 */
  counts: Record<ConventionSeverity, number>;
  /** 本次参与的规则数 */
  ruleCount: number;
  /** 执行失败的规则 */
  failedRules: readonly ConventionRuleFailure[];
}

/**
 * 约定校验服务（服务键 `convention.linter`）。
 * 消费者：校验结果面板（订阅）、命令面板（手动重跑）、未来 CI。
 */
export interface ConventionLinterService {
  /** 执行全部规则并返回报告（覆盖缓存并通知订阅者） */
  run(): Promise<ConventionReport>;
  /** 最近一次报告（尚未运行时 null） */
  report(): ConventionReport | null;
  /** 订阅报告更新（立即以当前值回调一次，返回退订函数） */
  subscribe(cb: (report: ConventionReport | null) => void): () => void;
  /** 当前装配的规则清单（内置 + 当前适配器） */
  rules(): readonly ConventionRule[];
}

/** 严重度排序权重（error 最前） */
export const CONVENTION_SEVERITY_ORDER: Readonly<Record<ConventionSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};
