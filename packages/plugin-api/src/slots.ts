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

/**
 * 面板归属容器（2026-10-11 UI 重设计批 P1；additive，缺省 = 旧行为 sidebar 堆叠）：
 * - `sidebar`：主侧栏（活动栏图标 + 视图容器）；
 * - `aux`：副侧栏（编辑器右侧，预览/低频工具位）；
 * - `bottom`：底部区（诊断列表位，tab 形态）。
 */
export type PanelLocation = 'sidebar' | 'aux' | 'bottom';

export interface UIPanelContribution extends ContributionBase {
  readonly title: string;
  /** 单字符或内置图标名（渲染器解释） */
  readonly icon?: string;
  readonly component: UIPanelComponent;
  /** 归属容器；缺省 'sidebar'（旧行为） */
  readonly location?: PanelLocation;
  /** 缺省 true；低频工具设 false（容器打开时才激活，不抢占首屏） */
  readonly defaultActive?: boolean;
  /** 同 group 的 sidebar 面板共享一枚活动栏图标，容器内折叠堆叠；缺省 = 独占一枚图标 */
  readonly group?: string;
}

/* ----------------------------- ui.toolbar ----------------------------- */

/**
 * 顶部工具栏贡献（UI 重设计 P2；additive 新槽）。
 * **动作真源在 `editor.command`**——本槽只引用命令 id，不自带 run
 * （避免两套动作定义漂移）。
 */
export interface ToolbarContribution extends ContributionBase {
  readonly title: string;
  readonly icon?: string;
  /** 引用 `editor.command` 贡献的 id */
  readonly command: string;
  readonly when?: (ctx: EditorCommandContext) => boolean;
}

/* ---------------------------- ui.statusbar ---------------------------- */

/** 状态栏贡献（UI 重设计 P3；additive 新槽）。小型件，复用面板组件形态。 */
export interface StatusbarContribution extends ContributionBase {
  /** 缺省 right */
  readonly align?: 'left' | 'right';
  readonly component: UIPanelComponent;
}

/* ------------------------- ui.editor.codeAction ------------------------ */

/**
 * 就地改写（additive，2026-10-12 语法糖视图批）：把动作落成一次**可撤销**的模型编辑。
 *
 * ## 与 `run` 的分工
 *
 * 两者语义不同，别混：
 * - `run` = **发意图**（宿主可能只做显示或导航，如 `editor.revealLocation`）；
 * - `edits` = **改文本本身**（宿主用 Monaco `executeEdits` 落地，用户 `Ctrl+Z` 可撤回）。
 *
 * 典型场景：`.kojo` 里光标停在原生 ERB 直通行上 → 💡「改为语法糖写法」——
 * 这是**改源文件**，不是预览，所以走 `edits` 而不是 `run`。
 *
 * ## 坐标与缩进
 *
 * 行区间为**模型坐标**（1 基、闭区间）；宿主负责夹取越界值（陈旧行号不崩）。
 * `newText` 自带完整行内缩进（含首行），宿主**不做任何加工**——贡献方最清楚
 * 替进来的糖写法在原缩进层里该长什么样。
 *
 * 多处改写由宿主**合并为一次编辑**（一个撤销步），并按行号降序应用（避免位移）。
 */
export interface EditorTextEdit {
  readonly fromLine: number;
  readonly toLine: number;
  /** 替换进来的文本（多行，`\n` 分隔） */
  readonly newText: string;
}

/** 编辑器 CodeAction（💡 形态；宿主适配为 Monaco registerCodeActionProvider，宿主零绘制） */
export interface EditorCodeAction {
  readonly title: string;
  readonly kind?: 'quickfix' | 'refactor';
  /** 关联诊断（quickfix 形态） */
  readonly diagnostics?: LineDecoration[];
  /**
   * 就地改写（可选）。给出时宿主**优先**执行改写（可撤销），不再调用 `run`；
   * 省略则退回旧语义（`run` 发意图）。
   */
  readonly edits?: readonly EditorTextEdit[];
  run(ctx: EditorCommandContext): void | Promise<void>;
}

export interface EditorCodeActionContribution extends ContributionBase {
  /**
   * 对单个文件产出动作（纯函数；不适用该文件返回空数组）。
   *
   * `line`（additive，2026-10-12 升糖重定位批）：光标所在行（1 基；未提供 =
   * 位置未知）。供"就近动作"（如光标所在片段的升糖预览）筛选；不依赖位置的
   * 贡献可忽略本字段——**缺省行为与旧版完全一致**。
   */
  provideActions(file: {
    path: string;
    text: string;
    project: GameProject | null;
    line?: number;
    /**
     * 文件行数（additive，2026-10-12「内核优化」批）：宿主提供的中性事实，
     * 供贡献方**按文件体量自行决定是否降级**——超长文件上的全量分析会阻塞
     * 主线程（实测见 `docs/PERF-REVIEW-2026-10-11.md` §7.6）。
     * 缺省 = 体量未知，请按"不降级"处理（与旧版行为一致）。
     */
    lineCount?: number;
  }): EditorCodeAction[];
}

/* ------------------------ ui.editor.liftPreview ------------------------ */

/**
 * 升糖预览项（前端透镜；2026-10-12 升糖重定位批）——一段"可显示为语法糖"的
 * 原生 ERB 区间。
 *
 * **定位**：升糖**只用于看**。宿主把它渲染成"可折叠透镜"——原 ERB 折叠、糖写法
 * 就地打字机显示；**绝不写盘**（写盘语义见 `sugar.liftApply`，已从主路径摘除）。
 * 契约层面刻意只承载"要显示什么"，不含任何 Monaco 概念（渲染由 app 壳落地）。
 */
export interface EditorLiftPreviewItem {
  /** 源区间起点（1 基，含） */
  readonly fromLine: number;
  /** 源区间终点（1 基，含）；单行候选时 `fromLine === toLine` */
  readonly toLine: number;
  /** 糖写法（多行，`\n` 分隔；前端原样显示，不做二次加工） */
  readonly sugarText: string;
  /** 动作标题（💡 文案，面向作者） */
  readonly title: string;
  /** 可选人读说明（中文；不暴露内部术语） */
  readonly reason?: string;
}

export interface EditorLiftPreviewContribution extends ContributionBase {
  /**
   * 逐条候选的**就地预览**项（**已停用**，2026-10-12 语法糖视图批）。
   *
   * 为什么保留类型而不删：契约的兼容承诺（不改名不删成员）。**没有任何生产消费方**
   * 会调用它——单片段"折叠原文 + 打字机显示"的做法已被**整文件糖视图**取代
   * （用户 2026-10-12 明确：糖视图是编辑器内的前端改动，不是逐条点开的面板）。
   * 新贡献不要再实现它。
   */
  provideLiftPreview?(file: {
    path: string;
    text: string;
    project: GameProject | null;
    /**
     * 文件行数（additive，2026-10-12「内核优化」批）：宿主提供的中性事实。
     *
     * **为什么需要它**：本槽在宿主侧被接成 Monaco 的**折叠范围供给器**，而
     * Monaco 会在文件打开时就把整篇文档的折叠范围要一遍（且内容变化后重算）
     * ——超长文件上一次全量升糖扫描实测达 231 ms（52,601 行 ERB），直接表现
     * 为"打开大文件卡一下"。贡献方据此自行降级即可，宿主不需要知道"多少行算大"。
     * 缺省 = 体量未知，请按"不降级"处理（与旧版行为一致）。
     */
    lineCount?: number;
  }): EditorLiftPreviewItem[];

  /**
   * 整文件**糖投影**（B 层）——把整个 ERB 文件投影成糖显示，返回可映射的**连续段**
   * （每段形如 `EditorLiftPreviewItem`：区间 + 糖文本）。
   *
   * 这是本槽的**主方法**：宿主据此在编辑器里就地做前端改动（隐藏原文区间 + 在其上方
   * 显示糖写法），**读者不需要点开任何面板**。
   *
   * **可选**：不提供该方法的贡献只是不参与整文件糖视图（宿主零段、不显示开关效果），
   * 不影响其它槽。
   *
   * 纯函数：同输入必得同输出，不读盘不写盘。不适用该文件的贡献返回空数组。
   */
  provideLiftProject?(file: {
    path: string;
    text: string;
    project: GameProject | null;
  }): EditorLiftPreviewItem[];
}

/* ----------------------------- ui.overlay ----------------------------- */

/**
 * 模态/向导 overlay 贡献（UI 重设计 P2；additive 新槽）。
 * 宿主提供遮罩与 Esc/关闭语义；打开经内核事件 `ui.overlay.open`（插件发意图，
 * 宿主落地，插件间零依赖——与 `editor.revealLocation` 同款模式）。
 */
export interface OverlayContribution extends ContributionBase {
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
  /** 快捷键（additive；如 'ctrl+n' / 'ctrl+shift+p'），宿主统一注册 */
  readonly keybinding?: string;
  /** 返回 false 时命令在命令面板中禁用 */
  readonly when?: (ctx: EditorCommandContext) => boolean;
  run(ctx: EditorCommandContext): void | Promise<void>;
}

/**
 * **跨包共用的知名命令 id**（单一真源；与 `WellKnownServices` 同款模式）。
 *
 * 场景：宿主（如空态按钮）与插件（注册者自身 / 工具栏引用）需要引用**同一个**
 * 命令 id 字符串。硬编码两份会漂移（改名时只改一处，另一处静默失效）——统一从
 * 本表取。additive：新增命令在此登记；**不改名、不删除**（同事件兼容性承诺）。
 */
export const WellKnownCommands = {
  /** 新建口上文件（注册者 `ui-sugar-editor`；宿主空态按钮按 id 引用，缺席即隐藏） */
  NewKojoFile: 'kojo.newKojoFile',
} as const;

/** 知名命令 id 联合（注册/引用双方共用的字面量类型） */
export type WellKnownCommandId = (typeof WellKnownCommands)[keyof typeof WellKnownCommands];

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
  'ui.toolbar': ToolbarContribution;
  'ui.statusbar': StatusbarContribution;
  'ui.overlay': OverlayContribution;
  'editor.command': EditorCommandContribution;
  'ui.editor.decorator': EditorDecoratorContribution;
  'ui.editor.codeAction': EditorCodeActionContribution;
  'ui.editor.liftPreview': EditorLiftPreviewContribution;
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
