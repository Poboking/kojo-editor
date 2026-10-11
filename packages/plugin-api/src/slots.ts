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

/**
 * 行级装饰（高亮 / 警告 / 内联提示）——宿主（app 壳）把它消费为 Monaco
 * **markers**（波浪线 + 悬浮提示 + 问题列表）。
 *
 * v0.3 批 S6 起支持**列级区间**（`startColumn`/`endColumn`）：源里有精确
 * 位置的诊断（如语法糖 `SugarDiagnostic.loc`/`span`）能画出下划线而不是整行标红。
 * 两字段均可缺省——缺省即整行装饰（与 v0.2 行级形态完全兼容）。
 */
export interface LineDecoration {
  /** 1 基行号 */
  readonly line: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  /** 1 基起始列（UTF-16 码元）；缺省 = 行首（列 1） */
  readonly startColumn?: number;
  /** 1 基结束列（**不含**，即半开区间端点）；缺省 = 行尾 */
  readonly endColumn?: number;
  /** 可选诊断码（工具提示/分组用；游戏无关的稳定标识，如 `sugar.expr-missing-else`） */
  readonly code?: string;
}

export interface EditorDecoratorContribution extends ContributionBase {
  readonly title: string;
  /**
   * 对单个文件产出行级装饰（**纯函数**：给定同输入必得同输出，不读盘不写盘）。
   * 不适用该文件的贡献应返回空数组（`matcher` 语义内聚在实现里）。
   */
  decorate(file: { path: string; text: string; project: GameProject | null }): LineDecoration[];
}

/* ----------------------- ui.editor.saveHandler ----------------------- */

/**
 * 保存期告警（**非阻断**）——目前只有一种：全角空格。
 *
 * 语义与规范 §8「全角空格检测在保存时**告警**」一致：告警不阻止保存，但提供
 * "一键修复"的决策点（宿主拿到 `needs-choice` 后弹确认，由用户选择"仍然保存 /
 * 替换为半角空格"。见 IMPLEMENTATION-LOG §5.37 决策）。
 */
export interface EditorSaveWarning {
  readonly kind: 'fullwidth-space';
  /** 人读消息（中文；面向作者） */
  readonly message: string;
  /** 触发告警的源行号（1 基，升序） */
  readonly lines: readonly number[];
}

/** 保存意图选项（宿主就告警取得用户决策后**二次调用**时回传，避免重复弹窗） */
export interface EditorSaveChoices {
  /** 已确认全角空格告警、无需修复，继续保存 */
  readonly acknowledgeFullwidthSpace?: boolean;
}

/** 保存请求（宿主把内存态文本 + 路径交给接管者；与具体文件类型无关） */
export interface EditorSaveRequest {
  readonly path: string;
  /** 编辑器内存态文本（未落盘的最新内容） */
  readonly text: string;
  readonly project: GameProject | null;
  readonly choices?: EditorSaveChoices;
}

/**
 * 保存结果。
 *
 * - `saved`：已落盘（`message` 供状态栏；`note` 为**非阻断**补充，如"产物因编译
 *   错误未生成"，此时源文件仍已保存）；
 * - `needs-choice`：**尚未落盘**，需用户就告警（全角空格）决策——宿主弹确认后
 *   带 `choices` **重新调用**同一接管者；
 * - `error`：失败（越权 / 编译或写盘异常），未完成落盘；`message` 面向作者。
 */
export type EditorSaveOutcome =
  | { readonly status: 'saved'; readonly message: string; readonly note?: string }
  | { readonly status: 'needs-choice'; readonly warning: EditorSaveWarning }
  | { readonly status: 'error'; readonly message: string };

/**
 * 编辑器保存接管者（槽 `ui.editor.saveHandler`）——**宿主在保存一个文件前按
 * `matches(path)` 就近征询**，命中即把落盘完全交给它；未命中则走内核 io
 * `writeText` 缺省路径（保编码保换行）。
 *
 * 之所以是槽而非宿主硬编码：`.kojo` 的"保存"要"转译 + 编译落盘"（该逻辑属
 * `kojo-sugar` 域），宿主不该认得它。做成通用槽后，任何文件类型都能自带保存
 * 语义（如未来的格式化/生成物），而宿主保持**零具体格式知识**；能力缺席（提供
 * 者未激活）时自动退化为缺省保存——不静默、不报错、不阻塞浏览。
 *
 * 同一文件的多个贡献：宿主取 `order` 最小的命中项（唯一接管，不做链式级联）。
 */
export interface EditorSaveHandlerContribution extends ContributionBase {
  readonly title: string;
  /** 是否接管该文件的保存（纯判定；不适用返回 false） */
  matches(path: string): boolean;
  /** 执行保存（可含 IO；宿主不假定其实现，只消费其 `EditorSaveOutcome`） */
  save(request: EditorSaveRequest): Promise<EditorSaveOutcome>;
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
  'ui.editor.saveHandler': EditorSaveHandlerContribution;
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
