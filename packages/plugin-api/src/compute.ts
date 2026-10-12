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

  stats(): ComputePoolStats;
  resetStats(): void;
}
