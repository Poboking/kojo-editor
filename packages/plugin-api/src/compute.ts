/**
 * 计算池契约（内核设施 `kernel.compute`）。
 *
 * 与 `FileIO` / `StorageService` / `SlotRegistry` 同款：**类型在公共包，实现在 kernel**
 * ——因为插件（不能 import kernel）需要按服务键注入它。
 *
 * 语义与设计理由见 `kernel/src/compute.ts` 头注（时间片 / 优先级 / 单飞 + 尾缘合并 /
 * 统计；无 Worker 环境自动内联，同一套调度代码）。
 */

/** 计算优先级：交互档（波浪线 / 补全）优先于背景档（索引 / 抽取 / 建树） */
export type ComputePriority = 'interactive' | 'background';

export interface ComputeRunOptions {
  /** 每片时间预算（ms）；缺省由实现决定（建议约半帧）。0 = 每项都让路（测试/极端场景） */
  sliceMs?: number;
  priority?: ComputePriority;
  /** 统计标签（缺省 `anonymous`） */
  label?: string;
  /**
   * 窗口内并发数（缺省 1 = 严格串行）。
   *
   * **为什么需要它**：IO 与 CPU 混合的循环（逐文件读盘 + 解析）若改成严格串行，
   * 会丢掉 IPC 的并发重叠、把索引构建拖慢数倍。故按"窗口"并发执行，**窗口之间**
   * 再让路——既保住并行度，又给交互留出确定性间隙。
   */
  concurrency?: number;
}

export interface ComputeTaskStat {
  label: string;
  priority: ComputePriority;
  /** 累计处理项数 */
  items: number;
  /** 累计片数 */
  slices: number;
  /** 累计让路次数 */
  yields: number;
  /** 累计耗时（ms，含让路等待） */
  durationMs: number;
  /** 累计调用次数 */
  runs: number;
}

export interface ComputePoolStats {
  /** 按 label 聚合（首次出现顺序） */
  tasks: ComputeTaskStat[];
  /** 全局让路次数 */
  yields: number;
  /** 当前是否有交互档任务在运行 */
  interactiveActive: boolean;
  /** 可搬运任务的执行统计 */
  offload: {
    /** 是否有并行通道 */
    parallel: boolean;
    /** 经通道执行成功次数 */
    dispatched: number;
    /** 通道失败后回退本地实现的次数 */
    fellBack: number;
    /** 本地（内联）执行次数 */
    inline: number;
  };
}

/**
 * 可搬运任务的载荷：必须是**可结构化克隆**的纯数据（不带函数/闭包/类实例）。
 */
export type ComputePayload = unknown;

/**
 * 并行通道（运输层）：把"kind + 纯数据载荷"送到别处执行。
 *
 * **为什么是 kind 字符串而不是函数**：函数跨不过结构化克隆。故约定
 * "**传数据不传函数**"——kind 标识由装配层在两侧各自映射到同一份实现
 * （宿主侧 `registerTask`、worker 侧由装配层合并各插件导出的映射表）。
 * 内核只认识字符串，插件不认识 Worker。
 */
export interface ComputeTransport {
  readonly available: boolean;
  invoke(kind: string, payload: ComputePayload): Promise<unknown>;
  dispose?(): void;
}

export interface ComputePool {
  /** 让出主线程到宏任务边界（浏览器得以处理输入与渲染） */
  yieldToMain(): Promise<void>;

  /**
   * 分片执行（保序）。`fn` 可同步可异步；返回值与入参一一对应。
   *
   * 每项执行后检查本片预算：超出 `sliceMs` 且仍有后续项 → 让路并开新片。
   * 单项自身超预算时无法切分（调用方若需要，应在 `fn` 内自行分段）。
   */
  runSliced<T, R>(
    items: readonly T[],
    opts: ComputeRunOptions,
    fn: (item: T, index: number) => R | Promise<R>,
  ): Promise<R[]>;

  /**
   * 单飞 + 尾缘合并：同一 `key` 同时只跑一个；在跑期间到达的调用**只保留最后一个
   * `fn`**（中间版本直接跳过），但**所有等待者的 Promise 都用那一次执行的结果兑现**。
   */
  runLatest<R>(key: string, opts: ComputeRunOptions, fn: () => R | Promise<R>): Promise<R>;

  /** 是否已有交互档任务在运行（背景任务据此让路） */
  busyInteractive(): boolean;

  /**
   * 注册可搬运任务的**本地实现**（内联与"通道失败回退"都用它）。
   *
   * 由**任务的所有者**（通常是插件）在 activate 时注册；worker 侧不重复注册——
   * 装配层把同一份映射交给 worker（见 `ComputeTransport` 头注）。
   */
  registerTask(kind: string, impl: (payload: never) => unknown): void;

  /** 是否已接上可用的并行通道 */
  parallel(): boolean;

  /** 接上并行通道（无 Worker 环境不调用；重复调用以最后一次为准） */
  attachTransport(transport: ComputeTransport): void;

  /**
   * 执行一个可搬运任务：有并行通道 → **分发到通道**（真并行）；否则本地实现。
   *
   * 通道异常（worker 崩溃 / 任务抛错）→ **回退本地实现**并记一次 `fellBack`
   * （宁可慢，不可错；回退不静默，走 `log`）。
   */
  offload<R = unknown>(kind: string, payload: ComputePayload): Promise<R>;

  stats(): ComputePoolStats;
  resetStats(): void;
}
