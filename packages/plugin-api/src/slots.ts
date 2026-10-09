import type { Unsubscribe } from './base';
import type { GameAdapter } from './game';
import type { GameProject } from './game';

/**
 * 槽位系统（对应架构文档 §4）。
 *
 * 与 DSH 客户端槽的差异（刻意反着设计的地方）：
 * 1. 同槽默认多注册；冲突用显式 `order` 字段解决（order 小者在前，缺省 0；同 order 按注册顺序）。
 *    ——DSH 的 root 槽被独占、后挂载被 shadow 的教训。
 * 2. 除 `game.adapter` 外全部无人独占；`game.adapter` 的单激活语义 = 同一项目同一时刻
 *    只有一个激活实现（detect 阶段仍轮询全部候选）。
 */

/** 所有注册项的公共字段 */
export interface ContributionBase {
  readonly id: string;
  /** 排序权重：小者在前（缺省 0） */
  readonly order?: number;
  /** 注册时由内核注入的插件 id */
  readonly pluginId?: string;
}

/* ------------------------------ ui.panel ------------------------------ */

export interface UIPanelProps {
  /** 渲染器提供的刷新信号（面板可选择忽略并通过事件自行驱动） */
  readonly refreshTick?: number;
}

/**
 * 面板组件（框架无关的结构化类型；React 函数组件天然满足。
 * plugin-api 刻意不依赖 React——渲染绑定由 app 壳完成）。
 */
export type UIPanelComponent = (props: UIPanelProps) => unknown;

export interface UIPanelContribution extends ContributionBase {
  readonly title: string;
  /** 单字符或内置图标名（渲染器解释） */
  readonly icon?: string;
  readonly component: UIPanelComponent;
}

/* --------------------------- editor.command --------------------------- */

export interface EditorCommandContext {
  readonly project: GameProject | null;
  /** 当前活动文件路径（编辑器上下文） */
  readonly activeFile?: string;
  /** 当前光标行（1 基） */
  readonly line?: number;
}

export interface EditorCommandContribution extends ContributionBase {
  readonly title: string;
  readonly category?: string;
  /** 返回 false 时命令在命令面板中禁用 */
  readonly when?: (ctx: EditorCommandContext) => boolean;
  run(ctx: EditorCommandContext): void | Promise<void>;
}

/* ----------------------- ui.editor.decorator ----------------------- */

/** 行级装饰（高亮/警告/内联提示）；v0.2 起由 Monter 消费 */
export interface LineDecoration {
  /** 1 基行号 */
  readonly line: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface EditorDecoratorContribution extends ContributionBase {
  readonly title: string;
  /** 对单个文件产出行级装饰（纯函数） */
  decorate(file: { path: string; text: string; project: GameProject | null }): LineDecoration[];
}

/* --------------------------- game.adapter --------------------------- */

export interface GameAdapterContribution extends ContributionBase {
  readonly adapter: GameAdapter;
}

/* --------------------------- export.target --------------------------- */

export interface ExportOptions {
  readonly targetDir: string;
  readonly includeReadme?: boolean;
}

export interface ExportResult {
  readonly files: string[];
  readonly warnings: string[];
}

export interface ExportTargetContribution extends ContributionBase {
  readonly title: string;
  export(project: GameProject, options: ExportOptions): Promise<ExportResult>;
}

/* ------------------------------ 槽位表 ------------------------------ */

export interface SlotMap {
  'ui.panel': UIPanelContribution;
  'editor.command': EditorCommandContribution;
  'ui.editor.decorator': EditorDecoratorContribution;
  'game.adapter': GameAdapterContribution;
  'export.target': ExportTargetContribution;
}

export type SlotName = keyof SlotMap;

/** 注册入口（插件上下文里拿到的就是它） */
export interface SlotRegistrar {
  register<S extends SlotName>(slot: S, item: SlotMap[S]): Unsubscribe;
}

/** 查询入口（内核服务 `kernel.slots`；消费者拿快照，渲染时按 order 排序） */
export interface SlotRegistry extends SlotRegistrar {
  query<S extends SlotName>(slot: S): ReadonlyArray<SlotMap[S]>;
}
