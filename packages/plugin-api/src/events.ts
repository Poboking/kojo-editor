/**
 * 事件契约——**运行时面**（emit 白名单 / sticky 白名单与它们的编译期 guard）。
 *
 * 类型面（`KernelEventMap` / `EventBus` / 各载荷形状）已整块拆到 `./events-types`
 * （2026-11-07 MCP-PERF-S17）：类型经 `import type` / `export type` 擦除、不进开机图，
 * 本文件只留运行时真源。旧导入路径不变——文件尾 `export type *` 原样转出全部类型。
 */
import type { KernelEventMap } from './events-types';

/** 类型面已拆到 ./events-types（图外文件）：这里 re-export 只为保持旧的 ./events 导入路径可用。
 *  `export type *` 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './events-types';

/* ------------------- 内核事件 emit 权限（单一真源 + 防漂移断言） ------------------- */

/**
 * **插件可经 scopedBus emit 的内核事件名**（scopedBus 命名空间纪律执法白名单
 * `KERNEL_EVENT_NAMES` 的内容来源）。
 *
 * 语义（P0 写权限闭环批定案，IMPLEMENTATION-LOG §5.36）：白名单 ≠ 全部内核事件——
 * **内核专属事件**（`KERNEL_ONLY_EVENT_NAMES`）只由内核/宿主发出，插件可 `on`
 * 但不可 `emit`（插件伪造 `project.writableApprovalMismatch` 等于伪造安全提示）。
 *
 * 本表与 `KernelEventMap` 的**分类完整性由编译期断言保证**（文末 guard 常量）：
 * 新增内核事件时必须在本表或 `KERNEL_ONLY_EVENT_NAMES` 之一登记，否则编译失败——
 * 根治 `0bf2eb9` 式「契约加了类型、kernel 白名单漏同步」的双源漂移事故
 * （该事故当时只在运行时暴露：插件 emit 被拦截抛错、向导命令链断裂）。
 */
const PLUGIN_EMITTABLE_EVENT_NAMES = [
  'file.changed',
  'project.opened',
  'project.closed',
  'kojo.functionChanged',
  'plugin.statusChanged',
  'state.snapshotLoaded',
  'editor.revealLocation',
  'kojo.replayFunction',
  // 口上调试统一批：注入面板写盘成功后广播（回放面板热更新）
  'debug.snapshotInjected',
  'kojo.snapshotSelected',
  'editor.activeFileChanged',
  'editor.liftPreview.show',
  'editor.liftPreview.hide',
  'editor.sugarView.set',
  'ui.overlay.open',
  'ui.overlay.close',
  // 用户反馈 8 批：教程打开意图（欢迎页只发语义 id，教程提供方映射到自己的 overlay）
  'ui.tutorial.open',
  'ui.diffView.open',
  'ui.panel.float',
  'ui.panel.reveal',
  'ui.openExternal',
  'workspace.importRequested',
  'workspace.newProjectRequested',
  'workspace.projectCreated',
  // 用户反馈 4 批：市场面板只表达「作者要发布」，项目选择/打包/许可/上传由拥有
  // 口上项目模型的适配器解释（同 workspace.importRequested 的分工）
  'market.publishRequested',
] as const satisfies readonly (keyof KernelEventMap)[];

/** 内核/宿主专属事件：插件可 `on`、不可 `emit`（安全语义事件由内核垄断发出）。 */
const KERNEL_ONLY_EVENT_NAMES = [
  'project.writableApprovalMismatch',
  // 驻留档案逐出（MCP-PERF-S19）：逐出是内核驻留账本的独占决定（谁被逐 = 内核 LRU 事实），
  // 插件伪造 = 谎报内存事实（与写权限事件同档）。
  'project.evicted',
  // 监视状态 = "自动重载机制是否可信"的保证，与写权限事件同类（BUG-5）
  'file.watchState',
  // 失效波（MCP-PERF-S12）：盘面变更的集合事实由内核监视器垄断发出（与 file.watchState 同档）。
  'file.changedBatch',
  // 「全部修复」= 改作者笔下的内容。批量落地只在宿主编辑器一侧，插件没有 emit 的理由，
  // 而"插件能广播一次批量改写"显然不该成立（与写权限事件同一档）。
  'editor.fixAll.request',
  // 显示偏好开关：真源是宿主的 localStorage 偏好 + Monaco 编辑器选项，插件既不持有偏好
  // 也不碰选项（B8）。放开 emit 只会让插件能"替作者改设置"。
  'editor.codeLens.set',
  // 编辑器动作（查找/替换/格式化/重命名/引用）落在作者笔下的内容与编辑器会话上，
  // 与「全部修复」同档：宿主编辑器一侧落地，插件没有 emit 的理由（R8）。
  'editor.action.request',
  // 文档真相 = "这个文件当前的可编译真相"（编辑器缓冲文本）。宿主状态真源在编辑器缓冲，
  // 插件伪造 = 谎报文件内容（消费方会拿伪造文本当权威去转译/校验）——与
  // `editor.codeLens.set` 同档：白名单即信任面，不放开 emit（C2）。
  'editor.documentChanged',
  // 光标位点 = 编辑器此刻的宿主状态（与 editor.codeLens.set 同档：插件伪造"光标在哪"
  // 就是谎报编辑器状态，面板据此乱高亮/乱清高亮）。宿主广播，插件只许听。
  'editor.cursorMoved',
  // 导航既成事实（NAV-1）：导航栈是宿主状态，插件伪造 = 往作者的回退历史里塞幽灵条目
  //（与 editor.cursorMoved 同档：宿主广播，插件只许听）。
  'editor.navigated',
] as const satisfies readonly (keyof KernelEventMap)[];

/** 内核事件名（= 插件可 emit 的集合；供 kernel `scopedBus` 执法使用） */
export type KernelEventName = (typeof PLUGIN_EMITTABLE_EVENT_NAMES)[number];

/** scopedBus emit 纪律的执法白名单（值 = 插件可 emit 的内核事件全集） */
export const KERNEL_EVENT_NAMES: ReadonlySet<KernelEventName> = new Set(PLUGIN_EMITTABLE_EVENT_NAMES);

/**
 * 编译期分类完整性断言：`KernelEventMap` 中每一键都必须被上方两表之一收录，
 * 且两表不得重叠。任一不满足时本常量的类型退化为 `never`，下方赋值即编译失败
 * ——这是「防再犯」的机制本体，不是文档性注释。
 */
type UnclassifiedKernelEvent = Exclude<
  keyof KernelEventMap,
  (typeof PLUGIN_EMITTABLE_EVENT_NAMES)[number] | (typeof KERNEL_ONLY_EVENT_NAMES)[number]
>;
type OverlappingKernelEvent = Extract<
  (typeof PLUGIN_EMITTABLE_EVENT_NAMES)[number],
  (typeof KERNEL_ONLY_EVENT_NAMES)[number]
>;
export const KERNEL_EVENT_CLASSIFICATION_GUARD: [UnclassifiedKernelEvent, OverlappingKernelEvent] extends [
  never,
  never,
]
  ? true
  : never = true;

/* ------------------- sticky（可回放最后一条）事件白名单 ------------------- */

/**
 * **sticky 事件白名单**（2026-10-18 面板挂载补真相批）：这些事件的**最后一条载荷**
 * 由总线保留，晚到的订阅者经 `EventBus.onSticky` 立即补收一次——「当前值」型事件
 * 天然可回放，不再要求"订阅恰好赶在广播之前"这种时序巧合。
 *
 * 实况：浮动「.kojo 校验」面板挂载晚于文件打开，首帧漏掉 `editor.activeFileChanged`，
 * 显示 `无打开文件`，要切一次文件才恢复。事件流本身没错，错在把**状态**当**通知**用。
 *
 * 收录判据（两条都满足才收）：
 * - 载荷就是"此刻是什么"（覆盖式更新，回放不会制造幽灵历史）；
 * - 体积小（常驻总线 = 一份全生命周期缓存，不许变成第二份文档缓存）。
 * `editor.documentChanged` 刻意**不收**：正文大文本常驻总线就是第二份文档缓存。
 *
 * 与 `KERNEL_EVENT_NAMES` 同一条纪律：本表是**唯一真源**，内核 `TypedEventBus`
 * 按它记 sticky；新增条目必须先过上面两条判据。
 */
const STICKY_EVENT_NAMES_ARR = [
  // 当前编辑的文件（null = 无文件 / 项目关闭）——面板挂载时必须立刻知道
  'editor.activeFileChanged',
] as const satisfies readonly (keyof KernelEventMap)[];

/** sticky 事件名（白名单成员；`onSticky` 只对这些事件产生回放） */
export type StickyEventName = (typeof STICKY_EVENT_NAMES_ARR)[number];

/** sticky 白名单（运行时视图；值 = 可回放最后一条的事件全集） */
export const STICKY_EVENT_NAMES: ReadonlySet<StickyEventName> = new Set(STICKY_EVENT_NAMES_ARR);
