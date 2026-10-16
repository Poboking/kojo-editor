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
  /**
   * 宿主注入的图标注册表桥（additive，2026-10-13 教程批）：传「图标名 + 像素尺寸」，
   * 返回可直接嵌入为子节点的内容（宿主通常返回一枚 SVG）。
   *
   * **可选**：旧宿主 / 无渲染环境（纯函数单测等）下缺省——贡献方须按「缺省即回退
   * 纯文本字形」编写；图标是锦上添花，绝不能在缺省时渲染成空白。
   */
  readonly renderIcon?: (name: string, size?: number) => unknown;
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
}

/**
 * 宿主下传给面板的 UI 偏好（additive，2026-10-14 面板偏好批）。
 *
 * 这里只放**容器语义**的偏好（「怎么渲染」），不放游戏知识、不放面板私有配置；
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
 * 转到定义请求（单槽 + 请求判别，2026-10-15 语言服务批）。
 *
 * 为什么**单槽 + `kind` 判别**而不是每能力一个槽：definition 与将来的
 * references / documentHighlight 的**输入形状完全相同**（文件 + 光标位置 + 项目），
 * 差异只在产出。分槽会让宿主接线 N 次、让每个贡献方各抄一份"取光标位置的样板"；
 * 单槽 + 判别式则**新增能力 = 往联合里加一个成员**——宿主与既有贡献方零改动。
 */
export interface EditorDefinitionRequest {
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
export interface EditorDocumentSymbolRequest {
  readonly kind: 'documentSymbol';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
}

/** 语言服务请求（`definition` / `documentSymbol` / `foldingRange` / `workspaceSymbol` / `codeLens` / `semanticToken` / `references` / `rename`；新增能力 additive 追加联合成员，不改旧成员） */
export type EditorLanguageServiceRequest =
  | EditorDefinitionRequest
  | EditorDocumentSymbolRequest
  | EditorFoldingRangeRequest
  | EditorWorkspaceSymbolRequest
  | EditorCodeLensRequest
  | EditorSemanticTokenRequest
  | EditorReferencesRequest
  | EditorRenameRequest;

/** 一个目标位置（1 基行列；`column` 缺省 = 行首） */
export interface EditorSymbolLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column?: number;
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
export interface EditorFoldingRangeRequest {
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
  | EditorRenameResult;

/**
 * 工作区符号请求（D2，2026-10-15 工作区符号批）——同一单槽的**第四个**判别成员
 * （additive：往联合末尾追加，宿主与既有贡献方零改动）。
 *
 * 与前三员的输入差异：**没有文件**。问的是"整个工作区里谁叫这个名字"，
 * 所以只给查询串与项目；数据源（项目索引 / 别的名录）由提供方自己认得，宿主不递文件。
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
export interface EditorCodeLensRequest {
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
export interface EditorSemanticTokenRequest {
  readonly kind: 'semanticToken';
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
}

/** 语义着色响应；空数组 = 认这个文件但整篇没有"结构才知道的名字" */
export interface EditorSemanticTokenResult {
  readonly kind: 'semanticToken';
  readonly spans: readonly EditorSemanticTokenSpan[];
}

/**
 * 查找引用请求（R2，2026-10-16 语言服务批）——同一单槽的**第七个**判别成员
 * （additive：往联合末尾追加，宿主与既有贡献方零改动）。
 *
 * 输入形状与 `definition` **逐字同族**（文件 + 光标位置 + 项目）：引用与定义回答的
 * 本就是同一个名字的两面。产出按 {@link EditorSymbolLocation} 给"文件:行:列"——
 * 落地（Peek / 跳转）由宿主决定，贡献方不碰导航。
 */
export interface EditorReferencesRequest {
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
}

/** 查找引用响应；空数组 = 认这个文件但这个名字没有可证明的引用（**不猜**） */
export interface EditorReferencesResult {
  readonly kind: 'references';
  readonly locations: readonly EditorSymbolLocation[];
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
}

/**
 * 重命名请求（R1，2026-10-16 语言服务批）——同一单槽的**第八个**判别成员。
 *
 * 与 `references` 同族（文件 + 光标位置），多带 `newName`。ERB 方言的全项目
 * rename 走 `erb-rename` 的专用通道（双通道送达 + 只读全或无，2026-10-16 已交付），
 * **不经本成员**；本成员服务 `.kojo` 这类"单文件、判据在转译器"的改名面。
 */
export interface EditorRenameRequest {
  readonly kind: 'rename';
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly newName: string;
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供贡献方按文件大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
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

/**
 * 编辑器语言服务贡献（槽 `ui.editor.languageService`）。
 *
 * **纯函数纪律**：`provide` 不读盘、不写盘、不发事件——数据**全部**来自贡献方，
 * 宿主只做 Monaco 协议翻译（位置进、位置出），绝不认识 ERB / 家族 / 角色。
 *
 * 返回值三态，宿主据此合并，无歧义（以 `definition` 为例；`documentSymbol` /
 * `foldingRange` 同构，把"目标"换成"顶层符号树 / 折叠区间"）：
 * - `undefined` = **我不认这个请求 / 这个文件**（不该由我应答）——宿主跳过；
 * - `{ locations: [] }` = 认这个文件、但此处没有定义（**不猜**）；
 * - `{ locations: [...] }` = 目标（可多个）。
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
