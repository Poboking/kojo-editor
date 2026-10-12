/**
 * 开项目级联的**体感水位**计时器（2026-10-12「体感丝滑批」）。
 *
 * 用户体感的"卡不卡"不是某一段的耗时，而是**从按下打开项目到某个面板能用**的等待长度。
 * 所以这里量的三个数都相对同一个起点 `project.opened`：
 *
 * - `index可用` —— 函数树的数据就绪（erb-parser 索引完成广播）
 * - `条件可用` —— 抽取摘要就绪（函数树条件徽章 / 条件矩阵依赖）
 * - `校验有结果` —— 约定报告就绪（校验面板依赖）
 *
 * 两条语义约束（都有测试钉着）：
 * 1. **起点之前不该记账**——启动期插件自己的首次运行不该被算成"用户等了多久"；
 * 2. **每轮开项目各段只记首次达成**——后续同段回调（快照覆盖写、规则重跑）不该再计入，
 *    而 `project.opened` 会把资格全部重置 ⇒ 交替开项目能逐次对比冷热。
 */

export interface CascadeWatermarks {
  /** 一次开项目开始：设起点并重置各段的"已达成"资格 */
  projectOpened(): void;
  /** 某段达成（`stage` 是段的身份，`name` 是记录到探针里的计时点名） */
  mark(stage: string, name: string): void;
}

/**
 * @param record 落到探针的动作（生产传 `perf.record`；测试传假函数）
 * @param now    毫秒时钟（生产传 `performance.now`；测试传假时钟）
 */
export function createCascadeWatermarks(
  record: (name: string, ms: number) => void,
  now: () => number,
): CascadeWatermarks {
  let openedAt: number | null = null;
  const done = new Set<string>();

  return {
    projectOpened(): void {
      openedAt = now();
      done.clear();
    },
    mark(stage: string, name: string): void {
      if (openedAt === null || done.has(stage)) return;
      done.add(stage);
      record(name, now() - openedAt);
    },
  };
}
