import type { PluginStateRecord, ServiceKey } from './plugin';

/**
 * 内核预定义服务键（兼容性承诺：不改名）。
 */
export const KernelServices = {
  Bus: 'kernel.bus',
  IO: 'kernel.io',
  Storage: 'kernel.storage',
  Slots: 'kernel.slots',
  Plugins: 'kernel.plugins',
  Project: 'kernel.project',
} as const;

/**
 * 生态通用服务键（由插件提供；内核不感知具体实现）。
 */
export const WellKnownServices = {
  /** 当前激活的游戏适配器（消费者声明注入；单激活语义见 slots.ts） */
  GameAdapter: 'game.adapter',
  /** ERB 解析器服务 */
  ErbParser: 'erb.parser',
  /**
   * 约定校验器服务（v0.2）。规则来自各 game.adapter 的 `conventions` +
   * 引擎内置通用规则；消费者为校验结果面板 / 命令面板 / 未来 CI。
   */
  ConventionLinter: 'convention.linter',
  /**
   * 条件谓词抽取服务（v0.2 第三批）。控制流骨架 → 表达式解析 → 函数级状态依赖；
   * 语义标签来自当前 game.adapter 的 `variableSchema`（引擎透传，不解释）。
   * 消费者：导航面板徽章 / 条件矩阵 / 快照回放（v1.0）。
   */
  ConditionExtractor: 'condition.extractor',
  /**
   * 快照来源服务（v0.2 第四批）：存档二进制解析（只读）+ 存档目录扫描。
   * 格式为引擎级通用二进制协议（跨游戏一致）；写/注入（架构文档 §5.5）随 v1.1。
   * 消费者：state-replay（v1.0）/ 归档浏览器。
   */
  SnapshotSource: 'snapshot.source',
  /**
   * 状态回放服务（v0.2 第五批）：快照状态视图 + 条件谓词近似求值
   * （置信度三档标注，架构文档 §5.3）。消费 `snapshot.source` + `condition.extractor`；
   * 作为消费者与编辑器 UI（回放面板）的数据源。
   */
  StateReplay: 'state.replay',
} as const;

export type KernelServiceKey = (typeof KernelServices)[keyof typeof KernelServices];
export type WellKnownServiceKey = (typeof WellKnownServices)[keyof typeof WellKnownServices];

/**
 * 插件注册表服务（内核 `kernel.plugins`）。
 * 状态面板与插件管理 UI 的数据源；内核保证数据永远可得（可观测性 > 优雅）。
 */
export interface PluginRegistry {
  list(): PluginStateRecord[];
  get(id: string): PluginStateRecord | undefined;
  /** 手动重试一个 inactive / error 插件（依赖已满足或原因已排除时使用） */
  retry(id: string): Promise<void>;
  /** 运行期注册并尝试激活新插件 */
  register(plugin: unknown): Promise<void>;
  /** 停用插件（含执行 deactivate 与清理） */
  stop(id: string): Promise<void>;
}

export type { ServiceKey };
