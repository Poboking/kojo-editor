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
  /** 作者工作区（通用 project/artifact 模型；游戏语义由消费方解释） */
  Workspaces: 'kernel.workspaces',
  /**
   * 计算池（2026-10-12「内核优化」批）：把 CPU 密集的批量工作切成时间片、
   * 片间让出主线程，使级联扫描不再表现为连续卡顿。
   *
   * 契约 `ComputePool`（`kernel/src/compute.ts` 定义实现与其语义；本键是内核设施，
   * 零游戏词汇零插件概念）。优先级 `interactive` > `background`；无 Worker 环境
   * 自动内联（同一套调度代码，只是运输层不同）。
   */
  Compute: 'kernel.compute',
  /**
   * 远程取文本（2026-10-15 市场索引批 KM-8）：契约 `RemoteService`，实现 = 平台桥的零逻辑透传。
   *
   * 与 `kernel.io` 分键的理由：出网是**另一种能力**（能力面 = 服务键面，插件要网络就得显式 require）。
   * 本键是插件侧**唯一**的远程入口：`kernel.io`（`FileIO`）里没有、也不许再有远程方法
   * （两处各开一条口子 = 两条链路各自演化，白名单与限额迟早漂）。
   * 本键里**没有主机白名单语义**——哪些地址可信只由平台侧那一条链路决定，两处各写必然漂；
   * 平台无此能力（Node 桥）时抛错，调用侧自解释呈现。
   */
  Remote: 'kernel.remote',
  /**
   * 批操作 journal（2026-10-16 undo 批，additive）：操作级 begin/record/commit/abort
   * + 历史撤销（undo 也进历史，可重做）。契约 `plugin-api/journal.ts`。
   *
   * 独立服务键的理由与 `kernel.remote` 同源（能力面 = 服务键面）：记操作历史是
   * 一种能力，消费方显式 require/tryInject，不藏在 `kernel.io` 里顺带发放。
   * 旧消费方零改动：缺席时消费方降级为自有行为（可选依赖，不阻塞激活）。
   */
  Ops: 'kernel.ops',
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
   * 格式为引擎级通用二进制协议（跨游戏一致）。
   * 消费者：state-replay（v1.0）/ 归档浏览器 / 注入面板。
   */
  SnapshotSource: 'snapshot.source',
  /**
   * 快照注入写服务（v0.2 第十五批）：改槽覆盖 → 重序列化（raw passthrough +
   * Int64 守卫）→ 容器组装 → 写前备份 → 内核 io 写入（双闸）→ 回读验证。
   * 读写职责分离：只读消费者只依赖 `snapshot.source`，本服务额外要求写权限。
   * 消费者：注入面板（ui-snapshot-injector）。
   */
  SnapshotWriter: 'snapshot.writer',
  /**
   * 状态回放服务（v0.2 第五批）：快照状态视图 + 条件谓词近似求值
   * （置信度三档标注，架构文档 §5.3）。消费 `snapshot.source` + `condition.extractor`；
   * 作为消费者与编辑器 UI（回放面板）的数据源。
   */
  StateReplay: 'state.replay',
  /**
   * 语法糖转译服务（v0.3 批 S1）：表层语法（`.kojo`）→ 原生 ERB 产物
   * + 行级源映射 + 诊断。**纯函数语义**（不读不写文件）；转译产物的写盘
   * 由消费方按内核双闸承担（S3 批）。契约 `plugin-api/sugar.ts`，
   * 实现插件 `kojo-sugar`（S2 批建）。
   */
  SugarTranspile: 'sugar.transpile',
  /**
   * 语法糖预览服务（v0.3 批 S4）：糖源码 → 转译 → **复用 `state.replay`**
   * 的存档状态回放（不新建模拟器）→ 输出「糖源码行 ↔ 生成 ERB 行 ↔
   * 回放消息块」三向映射。只读、纯数据层（无 UI）；归档缺失 / 回放服务
   * 缺席时**结构化降级**（`archive: null`），不抛错、不静默。
   * 事件纪律：只消费 `file.changed`，**绝不发射**（S3 已落其 payload 契约）。
   * 契约 `plugin-api/sugar.ts`，实现插件 `kojo-sugar`（S4 批建）。
   */
  SugarPreview: 'sugar.preview',
  /**
   * 语法糖提升建议服务（v0.3 批 S5）：**原生 ERB → 糖候选**（与降糖方向相反）。
   *
   * 每个候选都经「生成糖片段 → 复用 `sugar.transpile` → 与原文本区间逐字节比对」
   * 自证（round-trip）；**不一致者一律不入结果**（宁可漏报不可错报）。
   * 纯函数、不写盘、不发事件；不产候选的情形显式记入 `skipped`（不静默）。
   * 契约 `plugin-api/sugar.ts`，实现插件 `kojo-sugar`（S5 批建）。
   */
  SugarLift: 'sugar.lift',
  /**
   * 语法糖升糖**应用**服务（v0.3 批 S5-UI）：把选中的升糖候选写回 `.kojo` 源文件。
   *
   * 与 `sugar.lift` 的**关键差别**：`sugar.lift` 是只读观察面（不读盘、不写盘、
   * 不发事件）；本服务**持有写能力**——`apply` 是纯函数（内存态文本 → 文本），
   * `applyToFile` 走与 `sugar.transpile` 的 `compileToFile` **完全同款**的写链路
   * （编码组装 → 目录 → 备份 → 内核 io 写盘〔第一道闸〕→ 回读验证），成功后发
   * `file.changed`。
   *
   * **能力面 = 服务键面**：写能力必须显式可审计，不得藏在只读服务里。
   * 契约 `plugin-api/sugar.ts`，实现插件 `kojo-sugar`（S5-UI 批建）。
   */
  SugarLiftApply: 'sugar.liftApply',
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
