import type { Unsubscribe } from './base';
import type { PluginContextMenuRequest } from './context-menu';
import type { RevealRange, RevealSpan } from './events';
import type { GameAdapter } from './game';
import type { GameProject } from './game';
import type { EolStyle } from './io';
import type { InlineCompletionSourceContribution } from './inline-completion';
import type { MonacoLanguageContribution } from './monaco-language';

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

/**
 * 图标尺寸**档位名**（additive，批次十一 L07 · 与宿主 `icons.tsx` 的 `ICON_SIZES` 同名词表）。
 *
 * 契约侧只认档位，不认像素：`xs / sm / md / lg` 各是多少由宿主决定（现值 12 / 14 / 16 / 22），
 * 贡献方传数字仍然受理——宿主按就近吸附收敛到档位，但**新调用一律传档位名**，
 * 免得散装尺寸数字再一次长出来（L10 的刻度纪律）。
 */
export type IconSizeTier = 'xs' | 'sm' | 'md' | 'lg';

export interface UIPanelProps {
  /** 渲染器提供的刷新信号（面板可选择忽略并通过事件自行驱动） */
  readonly refreshTick?: number;
  /**
   * 宿主注入的图标注册表桥（additive，2026-10-13 教程批）：传「图标名 + 尺寸档位」，
   * 返回可直接嵌入为子节点的内容（宿主通常返回一枚 SVG）。
   *
   * **可选**：旧宿主 / 无渲染环境（纯函数单测等）下缺省——贡献方须按「缺省即回退」编写，
   * 图标是锦上添花，绝不能在缺省时渲染成空白。回退形态自选：文本字形或**纯 CSS 画出的记号**
   * （批次十一 L07 起，本仓纪律是「字符不当图标用」——画面上的图标一律走本桥取注册表 SVG）。
   */
  readonly renderIcon?: (name: string, size?: number | IconSizeTier) => unknown;
  /**
   * 宿主注入的浮窗态（additive，2026-10-14 UI 浮动批）：本面板正渲染在可移动浮窗里时为 true。
   *
   * **可选**：旧宿主 / 无渲染环境缺省（视作非浮动）——贡献方可据此隐藏面板自身的「浮动」
   * 入口等冗余 chrome，但必须容忍缺省。浮窗本体的拖动/缩放/停靠由宿主的窗口框提供。
   */
  readonly floating?: boolean;
  /**
   * 宿主注入的 UI 偏好投影（additive，2026-10-14 面板偏好批）：**只读**，值随设置页
   * 开关即时变化（宿主在开关变化时重新下传）。
   *
   * **可选**：旧宿主 / 无渲染环境缺省——贡献方必须按「缺省 = 最保守值」编写，
   * 即一切偏好缺省时等价于改动前的行为。
   */
  readonly uiPrefs?: UiPrefs;
  /**
   * 宿主注入的**右键菜单通道**（additive，1023 批 · 右键覆盖面 WP5.1）。
   *
   * 面板把「刚才右击的行 / 单元格的菜单」交给宿主统一渲染（固定层，压过模态与浮动窗），
   * 面板自己不开浮层——就地渲染的菜单会被自己的层叠上下文裁掉，也会与宿主菜单打架。
   *
   * **可选**：旧宿主 / 无渲染环境（纯函数单测）缺省。贡献方必须写成
   * `props.openContextMenu?.(req)`：缺席即「没有右键菜单」，不抛错、不退化出自造浮层。
   * 宿主侧还会再过一道中文化闸（非中文项整项丢弃），但插件**应当**自己就保证全中文
   * （`hasCjkLabel` 可自查）。
   */
  readonly openContextMenu?: (request: PluginContextMenuRequest) => void;
}

/**
 * 宿主下传给面板的 UI 偏好（additive，2026-10-14 面板偏好批）。
 *
 * 这里只放**容器语义**的偏好（「怎么渲染」）与**宿主能力投影**（「宿主这侧开没开某项
 * 能力」，如 {@link UiPrefs.kojo2}），不放游戏知识、不放面板私有配置；
 * 面板自己的私有开关应自行持久化，不进本契约。
 */
export interface UiPrefs {
  /**
   * 面板内长列表是否走视口化（只渲染可见窗口，滚出即撤、滚入即建；设置页开关，缺省 false）。
   *
   * 缺省 false = 全量渲染（改动前行为）。贡献方据此选择渲染策略，**不得**据此隐藏数据
   * 或改变数据面口径——它只影响「画多少」，不影响「有什么」。
   */
  readonly panelVirtualize?: boolean;
  /**
   * Kojo 2.0 语言面投影（additive，K2-EDITOR-OPEN-PATHS）：宿主这侧 2.0 面可用时下传，
   * 缺省**不提供**（旧宿主 / 无渲染环境 ⇒ 贡献方按「没有 2.0」编写，即改动前行为）。
   *
   * 为什么扩展名也在这里、而不是让贡献方自己写：2.0 源扩展名的字面量住在宿主
   * （`app/monaco/kojo2-constants.ts`，全仓唯一处）。新建向导是**插件**，只许依赖本包，
   * 拿不到宿主模块；它要产出一份"扩展名与模板语言一致"的文件，就只能由宿主告诉它
   * 是哪一个扩展名——插件侧因此**零** `.kojo2` 字面量。
   */
  readonly kojo2?: Kojo2SurfacePref;
}

/**
 * 2.0 面的能力投影（见 {@link UiPrefs.kojo2}）。
 *
 * **不是**偏好开关的镜像：宿主只在 2.0 面真的可用（预演开关打开）时提供本对象，
 * 贡献方据此**追加**一个入口；不提供 = 一个入口都不许多（开关关 ⇒ 界面逐字不变）。
 */
export interface Kojo2SurfacePref {
  /** 2.0 源扩展名（含点、小写；宿主单源，贡献方**不得**自写一份字面量） */
  readonly extension: string;
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
  /**
   * 动作类别。宿主按它映射 Monaco 的 `CodeActionKind`：
   * `quickfix` = **修一条诊断**（波浪线上 `Ctrl+.` 的那一栏），`refactor` = 改写写法
   * （只在"重构"请求里出现，显式按 quickfix 过滤时会被 Monaco 剔除）。缺省按 `quickfix`。
   */
  readonly kind?: 'quickfix' | 'refactor';
  /**
   * 这条动作**消解的是哪几条诊断**（B9，additive：不给就是"没有可关联的诊断"）。
   *
   * 填法：原样给出波浪线那条 `LineDecoration`（同行、同 `code`、同 `message`）——
   * 宿主翻成 Monaco 的 marker 形状挂进 `CodeAction.diagnostics`，Monaco 据此
   * 把它认作"这条诊断的修复"（排序优先、应用后高亮被修区间、`hasAutoFix` 判据）。
   *
   * **没有对应修复就不要填**，也别填"差不多那条"：关联错了，作者按 `Ctrl+.`
   * 拿到的是一个改不动眼前红线的动作（本仓口径：不猜、不静默）。
   */
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
     * 请求范围（additive，E3「全部修复」批 2026-10-16）：
     * - 缺省 / `'range'` = **区间请求**（💡 / `Ctrl+.` 那一下），`line` 与 `diagnostics`
     *   说的是光标所在的这一小段——既有供方的位置判据逐字不变；
     * - `'document'` = **整篇批量**：`diagnostics` 是**整份文档**当下的波浪线（宿主直接
     *   问 `ui.editor.decorator` 拿，与面上画的同一份真源），`line` 不给。
     *
     * 为什么要单独说这一件事，而不是让供方"看 `line` 缺省就知道是批量"：
     * `line` 缺省在既有语义里是**位置未知**（旧宿主 / 非编辑器消费方），供方的既定纪律是
     * "位置未知就不猜 ⇒ 返回空"。批量要的恰恰是"把整篇每一条唯一解都交出来"——
     * 同一种输入形态、两种相反的期望 ⇒ 必须给出一枚显式意图，不能让供方去猜。
     * 不实现批量的供方对 `'document'` 返回空数组即可（**批量能力按供方逐家开通**，
     * 宿主不会因为"有供方没答"就少修别家的问题）。
     */
    scope?: 'range' | 'document';
    /**
     * 当前**落在请求区间内的波浪线**（additive，B9 2026-10-15 快速修复批）：
     * 宿主把**面上正画着的那些 marker**（来源是 `ui.editor.decorator` 各贡献的
     * `LineDecoration`）按请求区间求交后原样递回来。
     *
     * 为什么要给：`Ctrl+.` 是**针对某一条诊断**的请求，"光标在哪一行"不足以定位——
     * 一条跨列的诊断、一行里两条同族问题、或作者把光标停在波浪线旁边的空白列，
     * 都只有一处权威答案，就是当下渲染出来的那条 marker。贡献方按 `code`（+行）
     * 精确应答即可，别再自己扫一遍文本重算诊断（两处各算一份必然漂移）。
     *
     * 缺省 / 空数组 = 宿主没给（旧宿主、或该区间本来就没有波浪线）。此时**不该**
     * 凭空造 quickfix：按既有位置判据降级即可，或干脆返回空。
     */
    diagnostics?: LineDecoration[];
    /**
     * 文件行数（additive，2026-10-12「内核优化」批）：宿主提供的中性事实，
     * 供贡献方**按文件体量自行决定是否降级**——超长文件上的全量分析会阻塞
     * 主线程（实测见 `docs/archive/PERF-REVIEW-2026-10-11.md` §7.6）。
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
  /**
   * native 兜底段标记（additive，2026-10-17 全中文化系列 ZH-P 批）。
   *
   * `true` = 该段不是"工具认得出的糖"，而是**显式兜底显示**（`未识别语句 · <原文>`，
   * 契约口径住 `SugarProjectSegment.nativeOnly`）。宿主愿意给兜底段不同的读感时用这
   * 一位区分，缺省 = 真糖段（旧消费方零改动）。
   */
  readonly nativeOnly?: boolean;
  /**
   * 段内每一行糖文本对应的**源行号**（1 基；additive，契约口径住 `SugarProjectSegment.sourceLines`）。
   *
   * `sourceLines[k]` ↔ `sugarText.split('\n')[k]`，长度必须等于糖行数；没有源行的行（纯收束/装饰）
   * 填 0。宿主只有拿到它才能在预览面上把"点的那一行"换算回源文件的行——糖段是 N 源行 ⇄ M 糖行，
   * 第一段多行糖一出现，预览行号就和源行号分叉；缺这一位时宿主按 `min(fromLine + k, toLine)` 退化。
   */
  readonly sourceLines?: readonly number[];
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
  /**
   * 承载宽度档（additive，2026-10-14 教程打磨批 E9）：缺省 = 'default'（560px 向导尺度，
   * 旧行为不变）；'wide' 给长文阅读类浮层（教程），宿主放宽到文档宽度（920px 级）。
   * 宿主不认识浮层内容，只按本字段选容器度量。
   */
  readonly size?: 'default' | 'wide';
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

/* -------------------- ui.editor.languageService -------------------- */

/**
 * 一份文档所属的**载体**（`ARCH-language-unification.md` §5.1 三轴之一：语法 / 载体 / 方言）。
 * 取值与 `@kojo/kojo-core` 的 `DialectCarrier` 逐字相同——**这里刻意不 import 那个包**：
 * plugin-api 是插件唯一的共享 API，零依赖（`packages/plugin-api/package.json` 没有 dependencies），
 * 让它反向依赖 kojo-core 会把"契约层"拖进语言核心的实现里。结构一致就够：
 * TS 按形状赋值，宿主把 core 的 `DialectBinding` 原样递进来即成立。
 */
export type DialectCarrierKind = 'erb' | 'xml' | 'inline';

/**
 * 方言上下文的**最小结构**（LAU-D1，additive；§5.2 ③）。
 *
 * 为什么不把 2.0 的 `GameAdapter` 整枚塞进来：那一格的类型住在 `@kojo/kojo-core`，
 * 而本包**不许**依赖它（依赖方向：kernel → plugin-api，插件 → plugin-api；
 * kojo-core 与 plugin-api 今天互不 import，造出环就没有窄门可守）。
 * 所以这里只留三格**便利**字段，事实由供方自己取：
 *
 * - `dialect`：方言 id，**口径 = `request.project.adapterId`**（真源是识别链
 *   `detect()` → 恰一命中 → `loadProject`，内核并强制 `project.adapterId === gameId`）。
 *   ⚠ 这一格只是把"宿主已解析一次"显式化，**不是第二真源**：与 `project.adapterId` 分叉
 *   即 `core/dialect/response-mismatch`（宿主对账后丢弃该响应），供方**不许**拿它覆盖工程事实；
 * - `factsVersion`：事实版本（= 那枚 `GameAdapter.version`），方言包升级 ⇒ 供方缓存自行失效；
 * - `carrier`：这份文件的载体归属；`null` = 该方言未声明 `carriers` 或这份文件不在任何 glob 里。
 *
 * **没有默认方言这一格**（D12）：缺省（`undefined`）= 未绑定 ⇒ 事实类服务必须按"无事实"降级
 * （返回空 + 一条 `core/dialect/unbound`），**绝不回落到任何默认方言**——借别游戏的事实出提示，
 * 比不给提示更危险（它看起来是对的）。
 */
export interface DialectContext {
  readonly dialect: string;
  readonly factsVersion: string;
  readonly carrier: DialectCarrierKind | null;
}

/**
 * 一份文档在语言服务请求里的**模型身份**（LANG-CONTRACT，2026-10-20，additive 可选两格）。
 *
 * 为什么不是每个能力各写一份：按语言分派、按版本判陈旧是**所有**文档型请求的共同前提；
 * 写在这里，新增能力只要 `extends` 就自动带上。
 *
 * - `languageId`：宿主从 `ITextModel.getLanguageId()` 原样递来。供方**按它认语言**，
 *   不拿 `path` 扩展名猜——扩展名只是文件身份，糖投影、无标题缓冲、大小写不一的方言
 *   后缀都会让"扩展名 = 语言"失灵。缺省 = 旧行为（按 `path` 自认），既有贡献方零改动。
 * - `version`：宿主从 `ITextModel.getVersionId()` 递来（内容每变一次 +1）。供方可拿它
 *   当缓存键；异步产出在落地前拿它与 model 现版本对照，**不等就整批丢弃并重问**——
 *   绝不把按旧坐标算出的结果写进新文本。
 *
 * **取消语义**：`provide` 是同步纯函数，调用返回即结束，没有"在途响应"可取消；
 * 契约**刻意不发明** `CancellationToken`（发明了也只能是永远不触发的假令牌）。
 * 取消/过期只发生在宿主把结果交给 Monaco 或 worker 之前，判据统一是 `version`。
 */
export interface EditorDocumentIdentity {
  readonly languageId?: string;
  readonly version?: number;
  /**
   * 这份文档的方言上下文（LAU-D1，**additive 可选**）。
   *
   * 13 处语言服务请求今天就带 `readonly project: GameProject | null`——`project.adapterId`
   * 已经是方言 id 的口径，供方也已经在按它失败关闭。这一格的作用是让宿主把
   * "已解析的归属 + 事实版本"随请求一次性下传，供方**不必**再各自去猜载体；
   * 既有 13 处请求与所有旧供方**零改动**（缺省 = 未绑定 = 旧行为）。
   *
   * 见 {@link DialectContext} 的分叉纪律：它不得与 `project.adapterId` 分叉。
   */
  readonly dialect?: DialectContext;
}

/**
 * 转到定义请求（单槽 + 请求判别，2026-10-15 语言服务批）。
 *
 * 为什么**单槽 + `kind` 判别**而不是每能力一个槽：definition 与将来的
 * references / documentHighlight 的**输入形状完全相同**（文件 + 光标位置 + 项目），
 * 差异只在产出。分槽会让宿主接线 N 次、让每个贡献方各抄一份"取光标位置的样板"；
 * 单槽 + 判别式则**新增能力 = 往联合里加一个成员**——宿主与既有贡献方零改动。
 */
export interface EditorDefinitionRequest extends EditorDocumentIdentity {
  readonly kind: 'definition';
  readonly path: string;
  /** 模型全文（宿主给的是**真文件**的文本，糖视图下不供——见宿主接线注） */
  readonly text: string;
  /** 光标行（1 基） */
  readonly line: number;
  /** 光标列（1 基；UTF-16 码元，与 Monaco 同坐标系） */
  readonly column: number;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按文件大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
}

/**
 * 文档大纲请求（B3，2026-10-15 编辑器特性批）——同一单槽的第二个判别成员。
 *
 * 与 `definition` 的输入差异**只有位置**：大纲要的是整篇结构，不是光标处那一个记号。
 * `text` 仍是**模型全文**（不是磁盘内容）——大纲行号必须对得上作者正在看的那份缓冲区，
 * 用索引里磁盘上的行号会随未保存编辑整体错位。
 */
export interface EditorDocumentSymbolRequest extends EditorDocumentIdentity {
  readonly kind: 'documentSymbol';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
}

/**
 * 语言服务请求（`definition` / `documentSymbol` / `foldingRange` / `workspaceSymbol` /
 * `codeLens` / `semanticToken` / `references` / `rename` / `inlayHint`，LS-B0 起另有
 * `completion` / `hover` / `formatting` / `signatureHelp`；
 * 新增能力 additive 追加联合成员，不改旧成员）。**文档型成员一律 `extends
 * EditorDocumentIdentity`**（带 `languageId` / `version`），`workspaceSymbol` 除外——
 * 它不钉在任何一份缓冲区上。
 *
 * **`diagnostics` / `codeAction` 刻意不在本联合里**：它们已经各有专用槽
 * （`ui.editor.decorator` / `ui.editor.codeAction`），再开一个判别成员就是同一能力
 * 两条路径。理由写在下方 LS-B0 区块头。
 */
export type EditorLanguageServiceRequest =
  | EditorDefinitionRequest
  | EditorDocumentSymbolRequest
  | EditorFoldingRangeRequest
  | EditorWorkspaceSymbolRequest
  | EditorCodeLensRequest
  | EditorSemanticTokenRequest
  | EditorReferencesRequest
  | EditorRenameRequest
  | EditorInlayHintRequest
  | EditorCompletionRequest
  | EditorHoverRequest
  | EditorFormattingRequest
  | EditorSignatureHelpRequest
  // B3f（2026-10-29）：同符号高亮与结构化扩选（additive，加在联合末尾）。
  | EditorDocumentHighlightRequest
  | EditorSelectionRangeRequest;

/** 一个目标位置（1 基行列；`column` 缺省 = 行首） */
export interface EditorSymbolLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column?: number;
  /**
   * 出现点种类（**additive 可选**，W8 XLANG-RENAME 批）：与 {@link ErbReferenceKind}
   * **同一值域**（`definition` / `call` / `mention`），契约层不复述类型以免两处漂移。
   *
   * 为什么放这里：`references` 的产物原本只有"文件:行:列"，分类死在贡献方一侧，
   * 于是 F12 的"N 处"（全种类）、调用层级面板的"被调用 M 处"（只 `call`）、
   * code-lens 的计数三套口径互不覆盖、差值无人解释。落成可选字段后，
   * **同一条位置的分类可以穿过槽到达宿主**——供方不填即"未分类"，消费方按
   * `mention` 保守计数，既有零改动（铁律：additive，旧消费方看不见新字段照常工作）。
   */
  readonly kind?: 'definition' | 'call' | 'mention';
  /**
   * 一行内的**列区间**（**additive 可选**，W9 落点 span 批 → 契约收口 2026-12-28）：
   * 与 {@link RevealSpan} 同一个形状、同一条口径（1 基、UTF-16 码元、`columnEnd` 不含），
   * 因为"跳到的那一处"与"波浪线盖住的那一段"本来就是同一件事的两种写法——
   * 定义 / 引用 / 跳到实现 / 行上注解四条腿的产物自此与 `editor.revealLocation.span`
   * 逐字同形，宿主两侧不再需要按可选字段 cast 读。
   *
   * 为什么放这里：区间的数据源只有插件知道（那个名字占几个码元），而落点判据
   * 必须**只有一份**——此前它死在各发起方手里，同一处位置 F12 落在名字那一列、
   * 问题面板落在行首。缺席 = 发起方给不出区间 ⇒ 退化成**零宽**，
   * 退化判据唯一住在 `app/src/monaco/reveal-position.ts`，**不许在任何供方或宿主里重抄**。
   */
  readonly span?: RevealSpan;
  /**
   * 跨行的**整段落点**（**additive 可选**，B3b 2026-10-24）。
   *
   * 与 {@link RevealSpan} 同口径（1 基、UTF-16 码元、`endColumn` 不含），多一个行维度；
   * 形状与 core 的 `KojoSpan` 结构兼容（`{start:{line,column}, end:{…}}` 那边是嵌套的，
   * 这里摊平，免得契约层为了"少一层大括号"去依赖 core）。
   *
   * 为什么单独立一格而不是把 `span` 扩成两行：`span` 的消费方（`clampRevealPosition`，
   * 六条腿共用的落点判据）只认单行，扩它会动到引用 / 跳到实现 / 问题面板 / 检索面板 /
   * 回放五条腿。这一格只服务"落点本身就是一整段"的场景（目前 = 2.0 展开体的模板 / 池
   * 定义），消费方是 `toDefinitionLinks` 一条腿。
   *
   * **退化口径**：`range` 缺席 ⇒ 逐字沿用 `line` / `column` / `span`（与加这一格之前相同）。
   * `range` 在场时 `line` / `column` **仍应给出**（取 `range.startLine` / `range.startColumn`）：
   * 落点若走了事件通道那条腿（目标文件没打开），它只读得到 `line` / `column`，
   * 那时高亮退化成起点行、**位置不会错**。
   */
  readonly range?: RevealRange;
}

/** 转到定义响应 */
export interface EditorDefinitionResult {
  readonly kind: 'definition';
  /** 候选目标（重名函数的多处定义都给）；空数组 = 认这个文件但这处没有定义 */
  readonly locations: readonly EditorSymbolLocation[];
}

/**
 * 文档符号的**中性类别**（B3）：契约只说"这是哪种层次的东西"，具体是什么语言结构
 * （ERB 的 `@` 函数 / 表层 DSL 的时机块 / `#DIM` 声明）由贡献方决定并写进 `name`。
 * 宿主按本字段映射编辑器图标，**零格式知识**。
 */
export type EditorDocumentSymbolKind = 'function' | 'section' | 'block' | 'declaration';

/**
 * 一条大纲项（B3）。行号为**模型坐标**（1 基、闭区间；宿主负责夹取越界值）。
 * `children` 给出层次（时机块 → 段 → 分支…）；扁平结构省略。
 */
export interface EditorDocumentSymbol {
  readonly name: string;
  readonly kind: EditorDocumentSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  /** 副标题（形参 / 条件原文等；编辑器按空间截断） */
  readonly detail?: string;
  readonly children?: readonly EditorDocumentSymbol[];
}

/** 文档大纲响应 */
export interface EditorDocumentSymbolResult {
  readonly kind: 'documentSymbol';
  /** 顶层符号（含 `children` 树）；空数组 = 认这个文件但整篇无结构 */
  readonly symbols: readonly EditorDocumentSymbol[];
}

/**
 * 折叠范围请求（D3，2026-10-15 折叠/面包屑批）——同一单槽的第三个判别成员。
 *
 * 输入形状与 `documentSymbol` 一致（整篇结构、不是光标处记号）；`text` 同样是
 * **模型全文**（折叠区间必须对得上作者正在看的缓冲区）。
 */
export interface EditorFoldingRangeRequest extends EditorDocumentIdentity {
  readonly kind: 'foldingRange';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
}

/**
 * 一条可折叠区间（D3）。行号为**模型坐标**（1 基、闭区间；宿主负责夹取越界值）。
 * 语义上"折起来的是 `startLine` 之后到 `endLine` 的那一段"，`startLine` 那行留在面上。
 */
export interface EditorFoldingRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** 折叠范围响应 */
export interface EditorFoldingRangeResult {
  readonly kind: 'foldingRange';
  /** 可折叠区间（可重叠、可嵌套，宿主只夹取与去重，不解释层次）；空数组 = 认这个文件但整篇无可折块 */
  readonly ranges: readonly EditorFoldingRange[];
}

/** 语言服务响应（按 `kind` 与请求一一对应） */
export type EditorLanguageServiceResult =
  | EditorDefinitionResult
  | EditorDocumentSymbolResult
  | EditorFoldingRangeResult
  | EditorWorkspaceSymbolResult
  | EditorCodeLensResult
  | EditorSemanticTokenResult
  | EditorReferencesResult
  | EditorRenameResult
  | EditorInlayHintResult
  | EditorCompletionResult
  | EditorHoverResult
  | EditorFormattingResult
  | EditorSignatureHelpResult
  // B3f（2026-10-29）：与请求侧同批追加，成员顺序逐项对齐。
  | EditorDocumentHighlightResult
  | EditorSelectionRangeResult;

/**
 * 工作区符号请求（D2，2026-10-15 工作区符号批）——同一单槽的**第四个**判别成员
 * （additive：往联合末尾追加，宿主与既有贡献方零改动）。
 *
 * 与前三员的输入差异：**没有文件**。问的是"整个工作区里谁叫这个名字"，
 * 所以只给查询串与项目；数据源（项目索引 / 别的名录）由提供方自己认得，宿主不递文件。
 * 因此它**不 extends `EditorDocumentIdentity`**：查询不钉在任何一份缓冲区上，
 * 没有语言与版本可言。
 *
 * `query` 是**原样字符串**（未归一大小写、未 trim）：匹配口径归提供方——ERB 名按引擎
 * 惯例大小写不敏感，别的方言未必，宿主不替各方归一。
 * `limit` 是宿主给的**产出预算**：十万条名字不许整份递回去（渲染与 IPC 都付不起）。
 */
export interface EditorWorkspaceSymbolRequest {
  readonly kind: 'workspaceSymbol';
  readonly query: string;
  readonly project: GameProject | null;
  readonly limit?: number;
}

/** 一条工作区符号（位置 = 定义点，1 基行号；`column` 缺省 = 行首） */
export interface EditorWorkspaceSymbol {
  readonly name: string;
  /** 中性类别（与大纲同表；宿主只按它挑图标，零格式知识） */
  readonly kind: EditorDocumentSymbolKind;
  readonly filePath: string;
  readonly line: number;
  readonly column?: number;
  /** 副行补充（形参 / 注释块首行等；可缺省，宿主不依赖其存在） */
  readonly detail?: string;
}

/** 工作区符号响应 */
export interface EditorWorkspaceSymbolResult {
  readonly kind: 'workspaceSymbol';
  /** 至多 `limit` 条；空数组 = 提供方认得这个查询但一条没命中（**不猜**） */
  readonly symbols: readonly EditorWorkspaceSymbol[];
  /**
   * 命中**总数**（可大于 `symbols.length` = 提供方按预算截断了）。
   * 宿主据此显示"另有 N 条未列出"：上限是渲染预算，不是把结果悄悄丢掉（铁律 4）。
   * 缺省 = 提供方未给（宿主只显示"结果已达上限"，不编数字）。
   */
  readonly totalMatched?: number;
}

/**
 * 行上内联注解请求（B8，2026-10-16 行内注解批）——同一单槽的**第五个**判别成员
 * （additive：往联合末尾追加，宿主与既有贡献方零改动）。
 *
 * 输入形状与 `documentSymbol` / `foldingRange` 同族（要的是整篇结构，不是光标处那一个
 * 记号），`text` 同样是**模型全文**——注解钉在定义行上，行号必须对得上作者正在看的缓冲区。
 *
 * **为什么不发 `limit`**（与 `workspaceSymbol` 唯一的形态差别，值得写清楚）：Monaco 的
 * code lens 供给器**没有可视区间参数**（`provideCodeLenses(model, token)`，取证
 * monaco-editor 0.57 `editor/contrib/codelens/browser/codelens.js:42`），一次请求就是
 * 整篇文档的注解，且每次内容变化后都会重算（同文件 `onDidChangeModelContent` 那段
 * "Ask for all references again"）。预算因此**只能由宿主按"整篇"裁决**（判据与实测见宿主
 * `monaco/kojo-code-lens.ts`），不能让供方"少报一部分"——**行上注解的缺席本身就是一句话**
 * （"这一行没有可证明的东西可说"），一旦把它用来表示"额度用完了"，作者读到的是假事实。
 * 工作区符号那种"另有 N 条未列出"的补白在这里没有落点（code lens 没有列表头可写），
 * 所以那条口径**刻意不搬**过来。
 */
export interface EditorCodeLensRequest extends EditorDocumentIdentity {
  readonly kind: 'codeLens';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实；宿主据此整篇降级。供方按 `documentSymbol` 同款纪律**不据此少报**） */
  readonly lineCount?: number;
}

/**
 * 一条行上注解：显示在 `line` 那一行**上方**的一小段文本。
 *
 * 字段刻意只有两个主语——**说什么**（`label`）与**点了去哪**（`target?`）：
 * Monaco 的 code lens 标签就是一个纯字符串（渲染的是 `command.title`，无富文本、无分段、
 * 无逐段配色），所以契约不伪造"文本段 / 强调档"这类渲染面给不出的结构——那只会让宿主
 * 凭空长出一套按语义分支的样式表（业务判据进宿主，破铁律 1）。
 * 要突出什么，请贡献方**把话说在 `label` 里**；不想让某行有话说，就别给那行注解。
 */
export interface EditorCodeLens {
  /** 锚点行（1 基，**模型坐标**）。越界行由宿主**丢弃**而非夹取——"挪到最近的有效行"等于把这句话安在隔壁那个函数头上 */
  readonly line: number;
  /** 面向作者的一行文本（宿主原样显示，不解释内容、不加工、不截断） */
  readonly label: string;
  /** 点击落点（省略 = 这条注解不可点）；落地走宿主既有导航通道，供方不自己跳 */
  readonly target?: EditorSymbolLocation;
}

/** 行上内联注解响应 */
export interface EditorCodeLensResult {
  readonly kind: 'codeLens';
  /** 注解（宿主按行升序排列并按 行+文本 去重）；空数组 = 认这个文件，但整篇无话可说 */
  readonly lenses: readonly EditorCodeLens[];
}

/**
 * 语义着色（B6，2026-10-16 结构化着色批）——同一枚单槽的**第六个**判别成员
 * （additive：往两个联合的末尾各加一行，宿主与既有贡献方零改动）。
 *
 * ## 这条能力回答什么
 *
 * 「**这个名字在这处是什么角色**」——定义 / 形参声明位 / 引用，只有解析器（结构）
 * 或字典才知道；词法正则答不了（`@` 行与 `CALL` 行上的同一个名字，词法形状一模一样）。
 *
 * ## 与词法高亮的分工（本契约的核心边界，宿主注释里再抄一遍）
 *
 * - **词法归 Monarch**：关键字、字符串、数字、注释、变量族多段引用（`CFLAG:ARG:1`
 *   这类"形状可判"的东西）；
 * - **结构归本成员**：定义 vs 调用、形参声明位、声明出的名字——**只覆盖词法判不出来的
 *   span**，不去重画 Monarch 已经着色的区间。
 *
 * Monaco 的合并规则是**覆盖区间上语义 token 优先**，所以两处各画一份就是第二真相源：
 * 同一个名字今天词法色、明天语义色，漂移无人能解释。贡献方交出的每个 span 必须是
 * "结构才知道的"，否则就该删掉这条产出。
 *
 * ## 词表（为什么住在契约而不是宿主）
 *
 * 下面两张表是**类别的名字**（三个中性词 + 两个中性修饰），没有任何游戏名词；
 * 它们必须住在契约，否则贡献方无法类型标注（`EditorSemanticTokenType` 就是它们的派生）。
 * **legend（实际生效的那份 + 颜色）的唯一真源在宿主**：宿主可以只把词表的一个子集
 * 放进 legend，命中不了的名字**不着色且 `console.warn` 出去**（铁律 4：退化可见，
 * 不静默、不猜）。
 */

/** 语义着色的中性类别（词表；宿主 legend 是其子集，名字对不上即不着色 + 可见退化） */
export const EDITOR_SEMANTIC_TOKEN_TYPES = ['function', 'variable', 'parameter'] as const;

/** 语义着色的中性修饰（同上口径；`declaration` = 声明位，`readonly` = 写了会编译不过的只读名字） */
export const EDITOR_SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'readonly'] as const;

export type EditorSemanticTokenType = (typeof EDITOR_SEMANTIC_TOKEN_TYPES)[number];
export type EditorSemanticTokenModifier = (typeof EDITOR_SEMANTIC_TOKEN_MODIFIERS)[number];

/**
 * 一处着色（**模型坐标**：1 基行、1 基 UTF-16 码元列、`endColumn` 半开）。
 *
 * 与 `LineDecoration` 同一条列口径（同一份源文本、同一个 Monaco 坐标系），
 * 越界由宿主夹取（参照 `clampRevealPosition` 的既有纪律）——贡献方不许假定自己算准了列。
 */
export interface EditorSemanticTokenSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly tokenType: EditorSemanticTokenType;
  readonly modifiers?: readonly EditorSemanticTokenModifier[];
}

/**
 * 语义着色请求：形状与 `documentSymbol` / `foldingRange` 逐字同族（整篇结构、不是光标处记号），
 * 因此 `text` 同样是**模型全文**、`provide` 同样是**纯函数**（不读盘、不写盘、不发事件）。
 */
export interface EditorSemanticTokenRequest extends EditorDocumentIdentity {
  readonly kind: 'semanticToken';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
  /**
   * 宿主这次**真的**要哪一段（additive，R3 2026-10-28）。缺省 = 整篇。
   *
   * 与行内提示那一格同形同义（{@link EditorLineWindow}），所以两处不用各学一套：
   * 供方**可以**只算这一段，但**不许改变它对这一段里每一行的说法**——窗口内的行必须
   * 逐条等价于整篇路径按行过滤的结果，跨行状态（ERB 的 `[SKIPSTART]` 块）自己从头算。
   *
   * 谁在填：宿主只在**这份文档被编辑过**时才填（变更行窗口），并且只对它验证过
   * "逐行自洽"的供方下传（`semanticTokensWindowed`，今天只认 ERB 方言）；
   * 其余情况一律不填 ⇒ 供方走整篇，与旧行为逐字相同。
   *
   * 为什么值得多这一格：本槽的整篇成本 88% 在引用扫描（`scanFileRefs`）——
   * 24,197 行实测整腿 **73.5 ms**（其中引用腿 64.7 ms、解析 2.95 ms、宿主编码 0.58 ms）。
   * 只有按窗口取数才能把它压到 1 ms 量级；`edits` 通道省的是那 0.58 ms，不是这 64 ms。
   */
  readonly range?: EditorLineWindow;
}

/** 语义着色响应；空数组 = 认这个文件但整篇没有"结构才知道的名字" */
export interface EditorSemanticTokenResult {
  readonly kind: 'semanticToken';
  readonly spans: readonly EditorSemanticTokenSpan[];
}

/* ------------------------------ inlayHint（第七员） ------------------------------ */

/**
 * 行内提示（LS-R6，2026-10-16 语言服务批）——同一枚单槽的**第七个**判别成员
 * （additive：往两个联合的末尾各加一行，宿主与既有贡献方零改动）。
 *
 * ## 这条能力回答什么
 *
 * 「**这一格实参会落到形参表的哪一格**」——调用点实参的形参名。它必须由持有函数签名
 * 索引的一方回答（ERB 是解析器的 `@` 头形参表），词法正则答不了。
 *
 * ## 与签名帮助（`kojo-signature`）的分工
 *
 * 签名帮助是**拉**（光标进括号才弹一次浮层），行内提示是**常驻**（整屏实参位都标着）；
 * 数据源可以同源（槽位表 / 形参表），呈现面互不替代。
 *
 * ## 与 codeLens 的预算口径差异
 *
 * 行内提示**不插行**（Monaco 里是行内嵌片，行高不变、只把本行余部往右推），所以
 * codeLens 那套"每 5 行 1 条"的密度档在这里**不适用**；宿主侧仍保留体量档与条数上限
 * （见宿主 `kojo-inlay-hints.ts` 的代价模型）。供方纪律不变：索引缺席返回空数组、
 * 不读盘、绝不触发整项目扫描——只对请求给进来的这份缓冲区做单遍线性扫描。
 */
export interface EditorInlayHintRequest extends EditorDocumentIdentity {
  readonly kind: 'inlayHint';
  readonly path: string;
  /** 模型全文（与 documentSymbol / foldingRange 同族：提示钉在缓冲区坐标上） */
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实；宿主据此降级。供方按既有纪律**不据此少报**） */
  readonly lineCount?: number;
  /**
   * 宿主这次想看的行窗口（additive，R1 2026-10-28）——Monaco `provideInlayHints` 第二参
   * 原样下传（可视区 ±30 行，每段各问一次）；缺省 = 整篇。
   *
   * 供方**可以**只算这一段（成本从"正比于行数"变成"正比于视口"，这是大文件能不给提示
   * 整档让路的唯一办法），但**不许改变它对这一段里每一行的说法**：窗口外的行本来也不该
   * 出现，窗口内的行必须逐条等价。跨行状态（如 ERB 的 `[SKIPSTART]` 块）自己从头算——
   * 窗口是"少答"，不是"换个判据"。
   */
  readonly range?: EditorLineWindow;
}

/**
 * 行窗口（1 基闭区间；结构子集，与 Monaco `IRange` 的行字段同形，不需要整枚 Range）。
 *
 * 两条腿共用一个类型（R3 2026-10-28 从 `EditorInlayHintRange` 改名）：行内提示按**视口**
 * 取数、语义着色按**变更行**取数，窗口的语义与校验规则一字不差——分两个类型只会让
 * `startOffset` 的契约说明写两遍，然后漂移。
 */
export interface EditorLineWindow {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  /**
   * `startLineNumber` 那一行**行首**在 `text` 里的字符偏移（additive，R1 2026-10-28）。
   *
   * 存在的唯一理由：供方要跳过窗口之前那几万行，只能靠"数换行"逐行走位，
   * 而这条路实测 **42 ns/行**——52,601 行的文末窗口光走位就 2.2 ms，把窗口化省下的钱
   * 又还回去了。宿主（Monaco model）本来就有行首表，`getOffsetAt` 是一次二分。
   *
   * 提供方契约（供方据此校验，不满足就当没给）：`0 <= 值 <= text.length`，且
   * `值 === 0 || text.charCodeAt(值 - 1) === 10`（`\n`）——即**行首**，不是行内某列。
   * 缺省 = 供方自己按行号走位（纯函数调用方与老宿主走这条，结果逐条等价）。
   */
  readonly startOffset?: number;
}

/**
 * 行内提示的**语义类别**（additive，B2c 2026-10-24）。
 *
 * 值域刻意只有三格，且与 Monaco `InlayHintKind` 的语义一一对应（`type` / `parameter` /
 * 无颜色），因为它的**唯一用途**就是让宿主挑一种颜色——多一格就得在宿主里加一张映射表，
 * 而那张表迟早会与 Monaco 的枚举打架。
 */
export type EditorInlayHintKind = 'type' | 'parameter' | 'text';

/**
 * 一条行内提示：画在 `line:column` 所指字符**之前**的一小段文本。
 *
 * 坐标为**模型坐标**（1 基行、1 基 UTF-16 码元列），与 `EditorSemanticTokenSpan` 同一
 * 口径——越界与乱序由宿主夹取/丢弃，贡献方不许假定自己算准了列。
 * `label` 宿主原样显示不加工；`tooltip` 可选（中文，面向作者）。
 */
export interface EditorInlayHint {
  readonly line: number;
  readonly column: number;
  /** 提示文本（如形参名 `変動フラグ:` / `ARG:1:`） */
  readonly label: string;
  /** 悬停说明（缺省 = 无） */
  readonly tooltip?: string;
  /** 提示与前方文字之间留空（Monaco `paddingLeft`；缺省 = 不留） */
  readonly paddingLeft?: boolean;
  /**
   * 语义类别（**additive 可选**，B2c）：宿主据此选 `InlayHintKind`（决定颜色 / 图标）。
   *
   * 为什么需要它：宿主那条槽腿此前**对全部提示硬写 `Parameter`**——那对 ERB 的形参名
   * 是对的，对 kojo2 的"类型提示"就是假话（`# 设 好感度 整数` 行尾那个 `整数` 不是形参）。
   * 缺省 = `parameter`，与补这一格之前**逐字相同**（旧供方零改动，旧宿主零改动）。
   */
  readonly kind?: EditorInlayHintKind;
}

/** 行内提示响应；空数组 = 认这个文件但这篇没有可证明的提示 */
export interface EditorInlayHintResult {
  readonly kind: 'inlayHint';
  readonly hints: readonly EditorInlayHint[];
}


/** 项目内一份文档的快照（B3e，additive）；缺席 = 只答请求文件这一篇。 */
export interface EditorProjectFile {
  readonly path: string;
  readonly text: string;
}

/**
 * 查找引用请求（R2，2026-10-16 语言服务批）——同一单槽的**第七个**判别成员
 * （additive：往联合末尾追加，宿主与既有贡献方零改动）。
 *
 * 输入形状与 `definition` **逐字同族**（文件 + 光标位置 + 项目）：引用与定义回答的
 * 本就是同一个名字的两面。产出按 {@link EditorSymbolLocation} 给"文件:行:列"——
 * 落地（Peek / 跳转）由宿主决定，贡献方不碰导航。
 */
export interface EditorReferencesRequest extends EditorDocumentIdentity {
  readonly kind: 'references';
  readonly path: string;
  /** 模型全文（宿主给的是**真文件**的文本，糖视图下不供——与 `definition` 同一判据） */
  readonly text: string;
  /** 光标行（1 基） */
  readonly line: number;
  /** 光标列（1 基；UTF-16 码元，与 Monaco 同坐标系） */
  readonly column: number;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按文件大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
  /** 项目内其他文档的快照（additive，B3e）；缺席 = 只答本篇 */
  readonly projectFiles?: readonly EditorProjectFile[];
  /** 快照是否完整（additive，B3e）；`false` = 宿主少给了，须如实降级 */
  readonly projectFilesComplete?: boolean;
}

/** 查找引用响应；空数组 = 认这个文件但这个名字没有可证明的引用（**不猜**） */
export interface EditorReferencesResult {
  readonly kind: 'references';
  readonly locations: readonly EditorSymbolLocation[];
  /** 结果被截断（additive，B3e）：上限命中或快照不完整；缺省 = 未截断 */
  readonly truncated?: boolean;
}

/**
 * 一处**列级**文本编辑（`rename` 的产物；1 基行列，`endColumn` 不含端点——与
 * `ErbReference` 同一口径）。rename 只改名字记号，行级 `EditorTextEdit` 的粒度
 * 表达不了"行内哪一段"，故本成员自带列区间；宿主按行号降序合并成一次编辑。
 */
export interface EditorRenameEdit {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly newText: string;
  /**
   * 落点文件（**additive 可选**，W8 XLANG-RENAME 批）：缺省 = 请求所在文件
   * （既有 `.kojo` 文件局部改名的形态，零改动）。给出且与请求文件不同时，
   * 宿主**不得**把它落到请求的 model 上——那是跨文件编辑，走 `erb-rename` 的
   * 双通道送达，不经本成员。宿主侧的判据见 `app/monaco/kojo-rename.ts`。
   */
  readonly resourcePath?: string;
}

/**
 * 重命名请求（R1，2026-10-16 语言服务批）——同一单槽的**第八个**判别成员。
 *
 * 与 `references` 同族（文件 + 光标位置），多带 `newName`。ERB 方言的全项目
 * rename 走 `erb-rename` 的专用通道（双通道送达 + 只读全或无，2026-10-16 已交付），
 * **不经本成员**；本成员服务 `.kojo` 这类"单文件、判据在转译器"的改名面。
 */
export interface EditorRenameRequest extends EditorDocumentIdentity {
  readonly kind: 'rename';
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly newName: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按文件大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
  /** 项目内其他文档的快照（additive，B3e；口径同 {@link EditorReferencesRequest.projectFiles}） */
  readonly projectFiles?: readonly EditorProjectFile[];
  /** 快照是否完整（additive，B3e）；`false` ⇒ 改名全或无，整次拒绝并给理由 */
  readonly projectFilesComplete?: boolean;
}

/** 重命名响应：可证明的编辑集，或一条给作者看的拒绝理由（二选一，铁律 4 不静默） */
export interface EditorRenameResult {
  readonly kind: 'rename';
  readonly edits: readonly EditorRenameEdit[];
  /**
   * 被改的原名（宿主落地前逐处对照 live model 现文本验证——请求与落地之间作者可能
   * 已继续打字，坐标失效就整次拒绝让作者重按 F2，绝不按陈旧坐标硬写；与 `erb-rename`
   * 的"陈旧索引防误写"同一条纪律）。
   */
  readonly oldName?: string;
  /** 给出时宿主原样弹给作者（Monaco `rejectReason`），`edits` 必为空 */
  readonly rejectReason?: string;
}

/* ------------------- 编辑器面第二批（LS-B0，2026-10-24）：4 个新 kind ------------------- */

/**
 * **本批不加的两个能力**（`diagnostics` / `codeAction`）——不是遗漏，是已经各有专用槽：
 *
 * - 诊断 = 槽 `ui.editor.decorator`（{@link LineDecoration} 就是 LSP 诊断的形状：
 *   行 / 列区间 / severity / message / code / source），供方 `decorate()` 直接产出；
 * - 快速修复 = 槽 `ui.editor.codeAction`（{@link EditorCodeActionContribution}，
 *   `provideActions` 已经收 `line` / `scope` / `diagnostics` 三个位置判据）。
 *
 * 再给这两件事开一个 `languageService` 判别成员，等于**同一能力两条路径**：
 * 两处各算一份判据，必然漂移（本仓最贵的一类债）。kojo2 现在绕过这两个槽
 * （`kojo2-diagnostics.ts` 直接 `setModelMarkers`、`kojo2-code-actions.ts` 自带
 * 一条 command 通道），要改的是**让它们改注册这两个槽**，不是给它们开新路。
 */

/**
 * 补全请求（LS-B0 之一）。
 *
 * 与 `definition` 同族（文件 + 光标位置），多带**触发字符**：键入 `.` / `:` 这类字符
 * 引起的补全，候选集与手动触发（`Ctrl+Space`）不同，而"这个字符算不算触发符"是
 * **语言知识**——宿主只把字符原样递来，不判定。
 */
export interface EditorCompletionRequest extends EditorDocumentIdentity {
  readonly kind: 'completion';
  readonly path: string;
  /** 模型全文（补全要看的上下文就在光标前后，不能只看当前行） */
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly project: GameProject | null;
  readonly lineCount?: number;
  /** 触发字符（键入的那一个字符）；缺省 = 手动触发 */
  readonly triggerCharacter?: string;
}

/**
 * 补全与悬停**共用**的落点区间（B3c additive 新格；口径与 {@link LineDecoration} 的
 * 列级区间一致：行号 1 基、列按 UTF-16 码元、区间 **[startColumn, endColumn)** 尾列不含）。
 *
 * 为什么这格必须进契约：这一行里的"词"归谁吞并由**语言知识**决定（词首的记号算不算词
 * 的一部分、分隔符在哪切），宿主替供方切词的那一天，就是新增写形要么被切碎、要么被
 * 并错的那一天。供方要表达"插入时替换哪一段 / 浮层落在哪一段"，唯一诚实的位置就是这里。
 *
 * **缺格 = 旧行为逐字不变**：宿主按自己的现行口径取区间（补全＝光标所在词的区间、
 * 悬停＝不指定区间），本格出现之前没有任何供方给过它。
 */
export interface EditorLanguageRange {
  /** 1 基行号 */
  readonly line: number;
  /** 1 基起始列（UTF-16 码元） */
  readonly startColumn: number;
  /** 1 基结束列（**不含**，即半开区间端点），须 ≥ `startColumn` */
  readonly endColumn: number;
}

/**
 * 候选的中性类别（宿主按它挑**图标与排序档**，**零语言知识**）。
 * 具体是什么（ERB 函数 / `.kojo` 时机词 / 变量名）由供方决定，写进 `label`。
 *
 * 每一档在这里只说一件事：宿主拿它挑哪一枚图标。供方不许借它声明"我属于哪门语言"
 * （那是 `detail` 的事），宿主也不许给某一档另发明第二重语义。
 *
 * B3c 把缺省联合从六档 additive 扩到十二档（末尾六枚）。这不是补装饰：补全收口进
 * 槽之后，宿主能挑的图标若比语言包能区分的类别少，供方就被迫**降级图标**（运算符挤成
 * 文本、事件挤成变量）——图标一旦降级，作者对候选集的视觉记忆就断了。扩档保持逐枚
 * 互斥的"挑图标"语义，旧六档逐字不动。
 */
export type EditorCompletionItemKind =
  | 'keyword'
  | 'function'
  | 'variable'
  | 'value'
  /**
   * 带占位符的模板候选。宿主侧规则（B3c 写进契约——此前只在宿主翻译层隐式发生）：
   * `insertTextFormat` 取 {@link EditorCompletionItem.insertTextFormat} 的 snippet 值时打开
   * Monaco `InsertAsSnippet` 通道（注意：这里**不写字面量引号**——`kindLiterals` 直接扫这段
   * 联合的原文，引号里的同名字面会被算成第二档），`insertText` 里的占位语法按模板落地。
   * 桩环境缺该枚举时宿主**丢弃 snippet 档**，绝不把占位符当字面文本插入。
   *
   * **这一档本身只管挑图标与排位，不管插入文本怎么解释**——占位符是否生效归
   * {@link EditorCompletionItem.insertTextFormat}。为什么必须拆（B3c 实测到的真冲突）：
   * 2.0 的 `# 模 <名字>` 声明名今天**吃 snippet 图标、但不吃 snippet 插入**（名字里没有
   * 占位符，按模板插入会把 `$` / `}` 这类字面字符解释成槽位）。合成一格的后果＝供方只是
   * 想挑一枚图标，却顺手改了插入语义。
   */
  | 'snippet'
  | 'text'
  /* ---- B3c additive：以下六档与上面六档同规（宿主据此挑图标，零语言知识） ---- */
  /** 运算符 / 连接符一类的符号候选（宿主挑运算符图标；`keyword` 是给语句词的，不混用） */
  | 'operator'
  /** 事件 / 时机一类的候选（宿主挑事件图标——`function` 的落点是一次调用，这里的落点是一处时机） */
  | 'event'
  /** 只读的固定值槽（宿主挑常量图标；可赋值的归 `variable`） */
  | 'constant'
  /** 表 / 聚合结构一类的符号（宿主挑结构体图标；成员级归 `variable`） */
  | 'struct'
  /** 固定值域里列举出来的成员（宿主挑枚举图标；不属于任何值域的归 `value`） */
  | 'enum'
  /** 容器级候选——跳过去的是"一块区域"而不是"一条定义"（宿主挑模块图标） */
  | 'module';

/** 一条补全候选 */
export interface EditorCompletionItem {
  /** 列表里显示的字面（也是缺省的插入文本） */
  readonly label: string;
  readonly kind?: EditorCompletionItemKind;
  /** 行尾浅色补充（类型 / 形参摘要） */
  readonly detail?: string;
  /**
   * 展开的说明文档（缺省按**纯文本**处理，多行用 `\n`；要宿主按 Markdown 渲染的
   * 用 {@link documentationFormat} 声明）。
   */
  readonly documentation?: string;
  /**
   * `documentation` 的渲染形态（B3c additive，**缺省 = `'text'` = 旧行为逐字不变**：
   * 原样纯文本）。
   *
   * 为什么补这一格而不是把 Markdown 强加给所有人：形参表、定义正文这类说明，纯文本
   * 的行结构表达不出来（表头与正文糊成一团）；但契约不许逼每个供方都关心宿主怎么
   * 渲染——不给这格的供方，今天看到什么以后就看到什么。
   */
  readonly documentationFormat?: 'text' | 'markdown';
  /** 插入文本（缺省 = `label`）；含占位符的模板见 {@link insertTextFormat} */
  readonly insertText?: string;
  /**
   * `insertText` 怎么解释（B3c additive，**缺省 = `'plainText'` = 旧行为逐字不变**：
   * 原文插入，不把任何字符当模板语法）。
   *
   * 为什么不复用 `kind: 'snippet'` 来表达：`kind` 是"宿主挑哪枚图标"，而"插入文本里
   * 的 `$` / `}` 算不算槽位"是另一件事。2.0 有一类候选**要 snippet 图标但不要 snippet
   * 插入**（`# 模` 的声明名），合成一格就会让"挑图标"顺手改掉插入语义——那是作者在
   * 别家供方身上绝对看不到的变化。拆开之后：图标照挑，插入照旧。
   */
  readonly insertTextFormat?: 'plainText' | 'snippet';
  /**
   * 过滤文本（B3c additive，**缺省 = `label`**，不给与 Monaco 缺省逐字相同）。
   *
   * 为什么这格必须存在：`label` 是人读显示名——供方在 `label` 里带显示性修饰时，
   * 作者键入的字面不再是 `label` 的前缀，编辑器缺省过滤会把这一家的候选**整段滤掉**，
   * 症状是"插件给了、屏上没有"。这一格只管"拿什么匹配键入"，不影响显示、不影响插入。
   */
  readonly filterText?: string;
  /** 排序权重（字典序，小在前）；缺省 = 宿主按 `label` 排 */
  readonly sortText?: string;
  /**
   * 插入时替换的区间（B3c additive，**缺省 = 宿主自己的现行口径**＝光标所在词到
   * 光标处的区间，与本格存在之前逐字相同）。
   *
   * 为什么这格必须存在：见 {@link EditorLanguageRange}——"词"的边界是语言知识，
   * 宿主按通用词法替所有语言切词，新增写形的那天必然切错。
   */
  readonly range?: EditorLanguageRange;
}

/** 补全响应；空数组 = 认这个位置但一个候选都没有（**不猜**，宿主不弹窗） */
export interface EditorCompletionResult {
  readonly kind: 'completion';
  readonly items: readonly EditorCompletionItem[];
}

/**
 * 悬停请求（LS-B0 之二）——与 `definition` 逐字同族。
 *
 * 悬停是**单答**能力：浮层只有一块，两家各说一套只会互相盖住。故宿主按注册顺序问，
 * **第一家给出 `contents` 的说了算**（与 `rename` 同一条纪律）。
 */
export interface EditorHoverRequest extends EditorDocumentIdentity {
  readonly kind: 'hover';
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly project: GameProject | null;
  readonly lineCount?: number;
}

/**
 * 悬停响应。`contents` 的**缺省形态仍是纯文本**（多行用 `\n`）：契约不逼每个供方
 * 关心宿主怎么渲染，需要强调的地方供方用行结构表达——不给 {@link format} 的供方，
 * 行为与本格存在之前**逐字相同**。
 *
 * B3c **additive 打开 Markdown**（`format: 'markdown'` ⇒ 宿主把 `contents` 按 Markdown
 * 渲染）：声明正文与参数表这类结构，纯文本行结构表达不动；打开的是选择权，不是
 * 默认值。
 *
 * 空串 = 认这个位置但无话可说（宿主不弹浮层，也不去问下一家——见"单答"）。
 */
export interface EditorHoverResult {
  readonly kind: 'hover';
  readonly contents: string;
  /**
   * `contents` 的渲染形态（B3c additive，**缺省 = `'text'` = 旧行为**：原样纯文本）。
   */
  readonly format?: 'text' | 'markdown';
  /**
   * 浮层落点区间（B3c additive，**缺省 = 不给**，宿主按自己的现行词区间处理）。
   * 与补全的 `range` 同一口径（见 {@link EditorLanguageRange}）："哪一段是这个词"
   * 归供方，不归宿主。
   */
  readonly range?: EditorLanguageRange;
}

/**
 * 一处文本编辑（`formatting` 用）。
 *
 * **与 `EditorTextEdit` 的分工**（别混）：`EditorTextEdit` 是**整行**替换
 * （`fromLine`..`toLine` 整段换掉，用于 `.kojo` 的语法糖改写，贡献方自带缩进）；
 * 本类型是**列级**区间替换（可只动行内一段），用于格式化这类需要精确到列的场景
 * ——与 `EditorRenameEdit` 同族。
 *
 * 列缺省口径：`startColumn` 缺省 = 行首，`endColumn` 缺省 = 行尾；
 * `endLine` 可以与 `startLine` 不同（跨行替换）。**不做"插入到某行之前/之后"的
 * 特殊形态**——`startLine == endLine` 且两列相同就是零宽插入，一种形态表达全部。
 */
export interface EditorRangeEdit {
  readonly startLine: number;
  readonly startColumn?: number;
  readonly endLine: number;
  readonly endColumn?: number;
  readonly newText: string;
}

/**
 * 格式化请求（LS-B0 之三）——整篇文本，可**手选一段**。
 *
 * **单答**：同一篇文本两份格式化结果只会打架，故第一家给出 `edits` 的说了算
 * （给出空数组也算"我认这篇、且不需要改"，不再问下一家）。
 */
export interface EditorFormattingRequest extends EditorDocumentIdentity {
  readonly kind: 'formatting';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly lineCount?: number;
  /**
   * 只格式化这一段行（B3d additive，**缺省 = 整篇**：不传与本格存在之前逐字相同）。
   *
   * 语义写死成一句话：**只落这几行、其余行原样**。所以它带的是
   * `{ startLine, endLine }` 两枚**行号**，不带列——"选区从哪里切到哪一列"是编辑器的事，
   * 而"这一段该排成什么样"往往要看**整篇**的结构（缩进深度从文件头压下来、围栏状态跨行），
   * 供方拿整篇 `text` + 这两枚行号自己决定怎么裁；宿主不切串、不折列、不夹取。
   *
   * 行号口径与全仓一致：**1 基**、**闭区间**（`startLine === endLine` = 只排这一行）。
   * 越界 / 倒置由供方按自己的纪律处置（2.0 的实现是"原样返回、`changed=false`"）。
   */
  readonly lineRange?: EditorFormattingLineRange;
}

/** 格式化的行区间（1 基、闭区间；见 {@link EditorFormattingRequest.lineRange}） */
export interface EditorFormattingLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** 格式化响应：编辑集（按行号升序给出；宿主负责按降序落地，避免坐标位移） */
export interface EditorFormattingResult {
  readonly kind: 'formatting';
  readonly edits: readonly EditorRangeEdit[];
}

/**
 * 签名帮助请求（LS-B0 之四）——与 `definition` 同族（文件 + 光标位置）。
 *
 * 与 `inlayHint` 的分工（契约里早有记录）：签名帮助是**拉**（光标进括号弹一次浮层），
 * 行内提示是**常驻**。两者数据源可以同源，呈现面互不替代。
 *
 * 为什么需要它（回应 `app/src/monaco/kojo-signature.ts` 头注里"暂不加成员"的旧判断）：
 * 那条判断的理由是"唯一缺的知识是 `game.adapter` 的槽语义表，其余是引擎级语法"，
 * 在当时成立。但"引擎级语法"具体指**哪一门语言的**括号 / 逗号 / 引号规则——
 * kojo2 与 ERB 的实参切分并不相同（跨行收未闭合括号、字符串内逗号、`#DIM` 形参名）。
 * 只要这段胶水留在宿主，这门语言的签名帮助就**无法整块搬进插件**。故按该注自己
 * 写明的条件（"将来若插件要交自己的形参表再按 additive 形态加成员"）补上成员。
 */
export interface EditorSignatureHelpRequest extends EditorDocumentIdentity {
  readonly kind: 'signatureHelp';
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly project: GameProject | null;
  readonly lineCount?: number;
}

/** 一份签名（`label` 原样显示，宿主不重新拼装） */
export interface EditorSignature {
  /** 整串签名（如 `KOJO_DEFINE_KOJO_INFO_K1000(CHARA_ID)`） */
  readonly label: string;
  /** 形参名（逐格高亮用；顺序即形参顺序） */
  readonly parameters: readonly string[];
  /** 光标落在第几格（0 基；越界由宿主夹取） */
  readonly activeParameter: number;
  /** 展开说明（纯文本，可缺省） */
  readonly documentation?: string;
}

/** 签名帮助响应；空数组 = 认这个位置但给不出签名 */
export interface EditorSignatureHelpResult {
  readonly kind: 'signatureHelp';
  readonly signatures: readonly EditorSignature[];
  /** 多份签名时默认高亮哪一份（0 基；缺省 = 0） */
  readonly activeSignature?: number;
}

/* --------------- 编辑器面第三批（B3f，2026-10-29）：2 个新 kind --------------- */

/**
 * 同符号高亮的出现档位：`write` 声明位 / `read` 代码面与插值里的引用 / `text` 叙事正文
 * 里的同名词（不参与解析，编辑器可弱化）。供方**必给**，宿主只翻 Monaco 的三种画法。
 */
export type EditorDocumentHighlightKind = 'text' | 'read' | 'write';

/** 一处同符号出现（1 基行、1 基 UTF-16 码元列、`endColumn` 不含；模型坐标）。 */
export interface EditorDocumentHighlight {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  /** 必填、没有缺省：这一处算声明还是引用是语言知识，猜错的表现是「声明被画成引用色」。 */
  readonly kind: EditorDocumentHighlightKind;
}

/** 同符号高亮请求（与 `definition` 同族；**单答型**：同符号高亮只有一套颜色）。 */
export interface EditorDocumentHighlightRequest extends EditorDocumentIdentity {
  readonly kind: 'documentHighlight';
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly project: GameProject | null;
  readonly lineCount?: number;
}

/** 同符号高亮响应；空数组 = 认这个位置但光标下没有可高亮的符号（**不猜**）。 */
export interface EditorDocumentHighlightResult {
  readonly kind: 'documentHighlight';
  readonly highlights: readonly EditorDocumentHighlight[];
}

/**
 * 一条扩选链：**经典 LSP 形状** `{ range, parent? }`——返回值就是最内层，`parent` 逐级向外。
 * Monaco 0.57 的「每位点扁平数组」摊平只在宿主安装层做（契约不钉某个编辑器版本）。
 */
export interface EditorSelectionChain {
  readonly range: RevealRange;
  readonly parent?: EditorSelectionChain;
}

/** 结构化扩选请求（**单答型**；一次问多个位点，与 Monaco 的多光标一一对应）。 */
export interface EditorSelectionRangeRequest extends EditorDocumentIdentity {
  readonly kind: 'selectionRange';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly lineCount?: number;
  /** 要扩选的位点（1 基行列；顺序即输出顺序） */
  readonly positions: readonly { readonly line: number; readonly column: number }[];
}

/**
 * 结构化扩选响应：与 `positions` **同序同长**；`null` = 该位点显式空链（空文件 / 越界 /
 * 非法坐标，**不夹取、不猜**）。整条能力无人应答是另一件事（宿主交回空数组）。
 */
export interface EditorSelectionRangeResult {
  readonly kind: 'selectionRange';
  readonly selections: readonly (EditorSelectionChain | null)[];
}

/**
 * 编辑器语言服务贡献（槽 `ui.editor.languageService`）。
 *
 * **纯函数纪律**：`provide` 不读盘、不写盘、不发事件——数据全部来自贡献方与请求。
 *
 * 返回值三态（所有 kind 同一套）：`undefined` = 这家不认这个请求 / 文件 / 语言（弃权，
 * 宿主问下一家）；空结果（`[]` / `''`）= 认，但这里没有（**作答**，不再问下一家）；
 * 非空 = 结果。返回空结果不等于弃权。
 *
 * 同 kind 多家供方时按注册顺序逐家问、不排序不投票：集合型（definition / references /
 * documentSymbol / foldingRange / codeLens / semanticToken / inlayHint / workspaceSymbol /
 * completion）取并集去重，一家抛错只让这家缺席；单答型（rename / hover / formatting /
 * signatureHelp / documentHighlight / selectionRange）第一家作答的说了算。
 * 不引入 priority：需要主 / 备的只在 Monaco provider 层裁决。
 *
 * 文档型请求带 `languageId` 时以它为准，缺席才按 `path` 自认；`provide` 同步返回，
 * 无在途响应、不设取消令牌，`version` 只用于异步产出落地前的复核。
 */
export interface EditorLanguageServiceContribution extends ContributionBase {
  provide(request: EditorLanguageServiceRequest): EditorLanguageServiceResult | undefined;
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
  /**
   * 诊断码的**可读标签**（additive，DIAG-LINK 2026-10-18；宿主直喂 Monaco
   * `IMarkerData.code = { value: code, target?, label? }` 的 `label` 槽——零额外加工，
   * 破折号形态由 Monaco 自己给）。
   *
   * 为什么需要它（而不是把来源名拼进 `message`）：多来源发布之后，一个 `code` 可能同时
   * 住在好几条发布流水线上（同一条糖写法既被转译器算过、也被某个域插件的静态扫描算过），
   * 而 `code` 本身是**稳定标识**、不许带来源限定词（改名即断链）。作者要看的是"这条是谁
   * 说的"，那是一句人读标签，归 `label`——**缺省 = 旧行为**（Monaco 只显示 `code`）。
   */
  readonly source?: string;
}

/**
 * `offloadKind` 任务的**统一载荷**（纯数据，可结构化克隆——"传数据不传函数"）。
 *
 * 宿主在装饰刷新时按贡献的 `offloadKind` 把 `{path, text}` 送进计算池，任务实现
 * 返回 `LineDecoration[]`。**不含 `project`**：可搬运的任务只吃文本与路径
 * （要读项目内注入服务的装饰器因此天生搬不进 worker——见 `offloadKind` 注）。
 */
export interface EditorDecoratePayload {
  readonly path: string;
  readonly text: string;
}

export interface EditorDecoratorContribution extends ContributionBase {
  readonly title: string;
  /**
   * 对单个文件产出行级装饰（**纯函数**：给定同输入必得同输出，不读盘不写盘）。
   * 不适用该文件的贡献应返回空数组（`matcher` 语义内聚在实现里）。
   *
   * 声明了 `offloadKind` 的贡献：本方法是**就地回退路径**（无并行通道 / 该 kind
   * 只能在宿主执行时走它），语义必须与任务实现**逐字段相同**——两者应共用同一个纯函数。
   */
  decorate(file: { path: string; text: string; project: GameProject | null }): LineDecoration[];
  /**
   * 可选（additive，2026-10-16 装饰热路径批）：**把本贡献的重计算请出同步装饰轮**。
   *
   * 值 = 已在计算池任务体系里注册的 kind（`ComputePool.registerTask` / 装配层
   * `compute-tasks.ts` 两侧共用那张表）。载荷 `EditorDecoratePayload`，返回 `LineDecoration[]`。
   * 宿主据此将本贡献改为**异步派发**：`compute.runLatest`（同文件尾缘合并背压，
   * 交互档）里执行——kind 在 worker 侧在表 → `compute.offload`（真并行，主线程只装配）；
   * 不在表（实现依赖插件内注入的服务，worker 复现不了）→ 宿主异步**就地**调 `decorate`。
   * 两种走法都脱离同步装饰轮，结果落地前一律校验 model 版本（陈旧即丢）。
   *
   * **不声明 = 行为与本批之前完全一致**（同步、就地、零缓存语义变化）。
   */
  readonly offloadKind?: string;
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
  /**
   * **行尾覆盖档**（EOL-OVERRIDE-SAVE 批，additive——旧接管者零改动）：
   * 作者对这份文件做了显式 EOL 切换（状态栏 LF/CRLF 菜单）时，宿主随保存请求
   * 递上 `'crlf' | 'lf'`，接管者写**源文件**时应传给 `io.writeText` 的 `{ eol }`
   * （内核语义：显式 eol ⇒ 整段统一到该档，不走逐行保换行）。缺席 = 无覆盖，
   * 按缺省"保编码保换行"写。**只约束源文件**：编译产物（如 `.kojo` → `.ERB`）
   * 的行尾归产物管线自己的策略管。
   */
  readonly eol?: EolStyle;
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
  'ui.editor.languageService': EditorLanguageServiceContribution;
  'ui.editor.liftPreview': EditorLiftPreviewContribution;
  'ui.editor.saveHandler': EditorSaveHandlerContribution;
  'game.adapter': GameAdapterContribution;
  'export.target': ExportTargetContribution;
  'search.scope': SearchScopeContribution;
  /**
   * 内联补全（幽灵文本）候选源（IC 批）。贡献物是**领域事实**（一批候选文本），界面由宿主
   * 画，故与 `search.scope` / `export.target` 同族、不带 `ui.` 前缀。
   * 契约 `plugin-api/inline-completion.ts`；为什么走槽而不是服务键、为什么
   * **不塞进 `ui.editor.languageService`**，理由写在那份契约的头里（两处各说一遍必漂）。
   */
  'completion.source': InlineCompletionSourceContribution;
  /**
   * 一门语言的 **Monaco 语言面**（SDK B4）：Monarch 词法 / 语言配置 / 主题规则，
   * 插件供纯数据、宿主落 `setMonarchTokensProvider` 等三枚 API。
   * 契约 `plugin-api/monaco-language.ts`——**没有供方时的退化口径**（语言仍认领、面不存在、
   * 必须 warn 一条）写在那份头注里，宿主不留兜底实现（判据只有一份）。
   */
  'ui.monaco.language': MonacoLanguageContribution;
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

/* ----------------------------- search.scope ----------------------------- */

/**
 * 一条**限定检索范围**的候选（C3 领域限定检索批）。
 *
 * 宿主拿到的只有两样它**不需要理解**的东西：`label`（原样画进下拉，不解析、不改写）
 * 与 `roots`（当作"更小的检索根"直接交给原生检索命令）。**"哪个范围对应哪些文件"是
 * 领域判据，住提供方**；宿主里不许出现任何按名字/目录形状判定归属的代码
 * （那条判据抄第二份就抄进了最不该有的层）。
 */
export interface SearchScopeOption {
  /** 提供方内唯一的稳定 id（同一提供方的 id 之间不重复；改名即换 id，宿主不猜） */
  readonly id: string;
  /** 面向作者的短标签（下拉项文本；由提供方生成，宿主原文显示） */
  readonly label: string;
  /** 补充说明（宿主仅用作悬浮提示，不解释其含义；缺省 = 无补充） */
  readonly detail?: string;
  /**
   * 该范围的**检索根**（绝对路径）。目录与单个文件皆可：原生检索命令对每个根做
   * 一次目录遍历（`src-tauri` 的 `collect_files` → walkdir），文件根只产出它自己。
   * 因此"范围细到某几个文件"与"范围粗到一个目录"**共用这一个形状**，不需要第二套
   * 机制——粒度差在提供方给什么路径，不在宿主多认什么概念。
   */
  readonly roots: readonly string[];
}

/**
 * 检索范围提供方（槽 `search.scope`）。
 *
 * 命名口径：`ui.*` 槽的贡献物**自己就是界面**（面板 / 工具栏 / 装饰器）；本槽的贡献物
 * 是**领域事实**，由域插件算、宿主界面消费——同 `export.target` / `game.adapter` 一族，
 * 所以不带 `ui.` 前缀。
 *
 * **纯函数纪律**：`provide` 不读盘、不写盘、不发事件——它只把**已加载的项目数据**
 * 投影成候选清单（宿主已握着这份数据并原样递回来）。不提供范围 = 返回空数组
 * （宿主据此**不画选择器**，与"今天完全一致"，这是新功能默认关的形态）。
 *
 * 同槽多注册（与除 `game.adapter` 外的所有槽同语义）：查询结果已按 `order` 排好，
 * 消费者按顺序拼接各提供方的候选，并用 `pluginId` 给 id 加命名空间——
 * 因此两个提供方的 `id` 相同也不会串线。
 */
export interface SearchScopeContribution extends ContributionBase {
  provide(project: GameProject | null): SearchScopeOption[];
}
