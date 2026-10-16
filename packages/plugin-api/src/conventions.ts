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
import type { ErbFile, ErbIndex } from './erb';
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

/**
 * 规则的计算粒度（决定它能不能被逐文件增量复用）。
 *
 * - `'project'`（**缺省**）：判定依赖跨文件事实（某名函数在别处出现过吗、这个角色的面集齐了吗）。
 *   任一 ERB 变化都可能改变结论 ⇒ 只能整项目重算。
 * - `'file'`：判定**只看这个文件自身**（它的正文 + 它在索引里的函数表）。
 *   于是"作者改了一个 ERB"只需要重算那一个文件，其余文件的结论照用。
 *
 * 为什么要**声明**而不是让引擎猜：这是语义承诺，静态检查证明不了。
 * 判错方向的代价不是变慢，而是**悄悄吐出过期结论**。
 */
export type ConventionRuleScope = 'project' | 'file';

/**
 * 跨文件规则的**分区复用**端口（PERF-12b，2026-10-16）。
 *
 * `scope:'project'` 的规则默认"任一 ERB 变 ⇒ 整包重算"。但多数跨文件判定的真实形态是
 * **逐文件的结构化贡献**（这棵文件里有哪些函数名/家族面/签名槽）+ **一次廉价合并**：
 * 重活（正文扫描、名字解析、逐条比对）全部只依赖该文件自身的事实，可以由引擎按
 * `ErbIndex.fileMtimes` 逐文件缓存；合并只看贡献集合，与文件内容无额外耦合。
 *
 * 声明 `partition` 是继 `scope` 之后的第二个**语义承诺**：
 * - `fileUnit(file)` 只能是该文件自身事实（`ctx` 读到的文本、`index` 里该文件的条目、
 *   以及 `key()` 所摘要的外部输入）的**纯函数**，产出必须是 JSON 可序列化值
 *   （引擎会落盘复用）；返回 `undefined` = "本文件这轮没有结论"（引擎不入合并、
 *   **不缓存**，下次必重算它——读盘失败等瞬态要用这条，绝不把"没结论"编造成结论）；
 * - `combine(entries)` 只看传入贡献（walk 序）与 `ctx`，产出必须与 `check(ctx)`
 *   在全部文件新鲜计算时**逐条相同**——`check` 保留为对拍基准，引擎在分区路径
 *   不再调用它；
 * - `key(ctx)` 摘要规则吃掉的**非 ERB 外部输入**（如路由表内容摘要）；两次运行
 *   `key` 不等 ⇒ 该规则全部分区作废重算（fail-closed，绝不拿旧分区配新外部输入）；
 * - `isUnit(v)` 校验从盘上还原的分区结构；任一不符 ⇒ 该规则分区整体弃用重算。
 *   缺省 = 结构由 JSON 往返保证。
 *
 * 引擎侧的失效判据与逐文件桶完全同族：mtime 任一侧取不到 ⇒ 该文件必重算。
 */
export interface ConventionProjectUnitEntry {
  /** 本文件（贡献来自它的自身事实） */
  readonly file: ErbFile;
  /** `fileUnit` 的产出（JSON 值） */
  readonly unit: unknown;
}

export interface ConventionProjectPartition {
  fileUnit(ctx: ConventionCheckContext, file: ErbFile): unknown | Promise<unknown>;
  combine(
    ctx: ConventionCheckContext,
    entries: readonly ConventionProjectUnitEntry[],
  ): ConventionIssue[] | Promise<ConventionIssue[]>;
  key?(ctx: ConventionCheckContext): string | Promise<string>;
  isUnit?(unit: unknown): boolean;
}

/** 可校验的剧本约定。`check` 缺省 = 仅登记元数据（未实现校验）。 */
export interface ConventionRule {
  readonly id: string;
  readonly description: string;
  readonly severity: ConventionSeverity;
  /** 依据出处（源文件:行号 / 逆向文档章节），用于校验报告展示 */
  readonly source?: string;
  /** 计算粒度；缺省 `'project'`（跨文件语义，只能整项目重算） */
  readonly scope?: ConventionRuleScope;
  check?(ctx: ConventionCheckContext): ConventionIssue[] | Promise<ConventionIssue[]>;
  /**
   * 逐文件判定（`scope: 'file'` 的规则**必须**实现它，此时 `check` 不需要）。
   * 引擎按本次索引顺序、限并发调用，并**只把它自己产出的 issue 归到这个文件**；
   * 因此这里的 issue `key` 不得跨文件聚合（否则作者改 A 文件会让 B 文件的结论过期）。
   */
  checkFile?(ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] | Promise<ConventionIssue[]>;
  /**
   * 跨文件分区复用（见 {@link ConventionProjectPartition}）。仅对 `scope:'project'`
   * 生效；缺省 = 不分区（整包重算，旧行为）。实现后 `check` 仍必须存在（对拍基准 +
   * 判据不全时的兜底路径）。
   */
  readonly partition?: ConventionProjectPartition;
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
  /**
   * 执行全部规则并返回报告（覆盖缓存并通知订阅者）。
   *
   * `force: true` = 无视结果缓存真重算（面板「重新校验」按钮的语义）；
   * 缺省允许命中快照——开项目级联里校验实测 3.1 s，而产出仅 307 KB。
   */
  run(opts?: { force?: boolean }): Promise<ConventionReport>;
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
