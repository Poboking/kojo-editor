import type { Unsubscribe } from './base';
import type { GameProject } from './game';
import type { PluginStatus } from './plugin';

/**
 * 通用 diff 视图的一侧内容（`ui.diffView.open` 载荷成员）。
 *
 * `text` 与 `path` 至少给一个：`text` = 发起方已在内存里算好的内容
 * （如转译产物，盘上根本没有这份字节）；`path` = 磁盘真文件，由宿主经
 * 内核 io 现读（读侧无写闸，游戏目录与备份目录同样读得到）。
 * 两者都给时 `text` 优先——发起方最清楚哪份是权威。
 */
export interface DiffViewSide {
  /** 人读标签（视图头部显示；如「工作区 · 事件.kojo 的产物」） */
  label: string;
  /** 内联文本（给了即优先） */
  text?: string;
  /** 磁盘路径（`text` 缺席时由宿主读取） */
  path?: string;
}

/**
 * 一行内的**列区间**（W9 落点 span 批，2026-10-17）。
 *
 * 口径（与 Monaco / 糖线源映射同一条，本契约不换算）：1 基、UTF-16 码元、
 * `columnEnd` **不含**（Monaco range 的 `endColumn` 语义）。
 *
 * 为什么是"区间"而不是"一个列"：作者要看见的是**那一处**（命中的词、引用的名字、
 * 波浪线盖住的那一段），而单一 `column` 只说得出起点——发起方各给各的粒度，
 * 落点必然分叉（实测：同一处位置 F12 落在名字那一列、问题面板落在行首）。
 * `span` 缺席 = 发起方给不出区间，落点退化成**零宽**（只落 `column`，不给列就落行首）；
 * 退化判据全仓唯一，住在 `app/src/monaco/reveal-position.ts`，**不许被复制**。
 */
export interface RevealSpan {
  readonly columnStart: number;
  readonly columnEnd: number;
}

/** 文件变更类型 */
export type FileChangeKind = 'add' | 'change' | 'unlink';

export interface FileChangedEvent {
  kind: FileChangeKind;
  /**
   * 改动条目路径 —— **平台原样透传**，内核刻意不做归一化。
   *
   * （此前这行注释写的是"归一化后的绝对路径"，与 `kernel/src/watcher.ts` 的
   * `flush()` 相反：那里明写"路径原样透传：消费方用同一个字符串做键"。）
   * 为什么原样是对的：消费方拿它去查自己的表（`EditorPane` 的 entriesRef、
   * 文件树的 dirCache、面板的目录缓存），而那些表的键来自 io/平台同一条路径；
   * 内核中途改分隔符会让"这个文件正打开着"判空 ⇒ **事件静默失效**，比形态不统一更糟。
   *
   * ⇒ 消费方若要用它查表，**判等一律走 `pathKey()`**（折叠大小写与分隔符），
   * 别拿字符串直接 `has()`。
   */
  path: string;
}

/** 文件监视的判级结果（`file.watchState` 载荷；由内核监视器产生） */
export type FileWatchStatus = 'watching' | 'partial' | 'unavailable' | 'stopped';

export interface FileWatchStateEvent {
  /**
   * - `watching`：全部请求根都监视上了；
   * - `partial`：部分根监视失败（`failures` 逐条给原因）——**必须可见**，
   *   否则用户以为"外部改动会自动重载"，而某个目录其实没在监视；
   * - `unavailable`：一个根都没监视上 / 平台没有监视能力（如浏览器开发壳）/
   *   **监视器运行期自身失效**（目录被卸载、底层句柄没了）——三种都意味着
   *   "从现在起不会再有自动重载"，所以同一判级、同一呈现；
   * - `stopped`：显式停止（project.closed / 应用退出），不是故障。
   */
  status: FileWatchStatus;
  /** 实际监视中的根目录（绝对路径） */
  roots: string[];
  /** 逐条失败的根与原因；`watching` / `stopped` 时为空 */
  failures: Array<{ root: string; reason: string }>;
}

/**
 * 内核预定义事件（兼容性承诺：不改名、不删除，新增走次要版本）。
 */
export interface KernelEventMap {
  /** 文件系统变更（由内核 io 监视器产生） */
  'file.changed': FileChangedEvent;
  /**
   * 文件监视器自身的状态（BUG-5，2026-10-13）：监视了哪些根、哪些根没监视上、
   * 监视停摆了。与 `file.changed` 的分工：后者说"某个文件变了"，
   * 前者说"这套自动重载机制此刻是否可信"。
   *
   * 通用、游戏无关。**内核专属**：安全提示类事件由内核垄断发出
   * （插件伪造 `watching` = 伪造"外部改动会自动重载"的保证，
   * 与 `project.writableApprovalMismatch` 同类，见下方分类表）。
   */
  'file.watchState': FileWatchStateEvent;
  /** 项目已打开（onboarding 骨架完成 loadProject 后） */
  'project.opened': { project: GameProject };
  /** 项目已关闭 */
  'project.closed': { rootDir: string };
  /** 口上函数集合发生变化（解析器完成一次索引重建后） */
  'kojo.functionChanged': { projectRoot: string; files: string[] };
  /** 插件状态迁移（内核保证：任何插件状态变化都会发此事件） */
  'plugin.statusChanged': { pluginId: string; status: PluginStatus };
  /** 状态快照已加载（v1.0） */
  'state.snapshotLoaded': { source: string; characterId?: number };
  /**
   * 编辑器导航意图（v0.2）：打开文件并定位到行。
   * 通用、游戏无关——由宿主（编辑器壳）消费；任意插件可发起
   * （校验面板点击问题、函数树点击函数、未来的引用跳转）。
   *
   * **落点粒度（W9 落点 span 批，2026-10-17；additive）**：`span` 给得出就给，
   * 它才是"这一处"的权威（起点 + 终点）；`column` 只带起点，等价于零宽 `span`。
   * 两者都不给 = 落行首。**发起方一律发自己知道的真实区间**（问题面板发波浪线
   * 盖住的那一段、检索发命中的那几个码元、定义/引用发那个名字），
   * 不许有的发区间、有的发行首——同一处位置两条腿落两个地方就是这个 bug。
   * 越界与缺省怎么夹取**不由发起方决定**：判据只在宿主那一处（`reveal-position`）。
   */
  'editor.revealLocation': {
    filePath: string;
    line?: number;
    column?: number;
    span?: RevealSpan;
    source?: string;
  };
  /**
   * 编辑器当前文件变更（v0.3 批 S5-UI）：宿主在"当前编辑的文件"发生变化时广播。
   *
   * 通用、游戏无关——「当前打开的是哪个文件」是**宿主状态**，不是任何插件的
   * 私有状态。把它做成事件而非服务方法：面板只想"知道变了"，不想"查询宿主"
   * （查询式接口会逼面板持有宿主引用，破坏"插件不得依赖宿主实现"的分层）。
   *
   * `filePath: null` = 当前无打开文件（项目关闭 / 回到欢迎页）。
   */
  'editor.activeFileChanged': { filePath: string | null };
  /**
   * 编辑器文档真相变更（C2，2026-10-16 面板真相统一批）：宿主在"这个文件当前的
   * **可编译真相**"变化时广播。`text` = 编辑器**缓冲区**的当前文本，不是盘上那份——
   * 未保存编辑时波浪线与面板数字必须看到同一份文本，否则两屏真相分叉。
   *
   * 消费方契约：拿同一 `filePath` 的**最新一条**当权威文本；磁盘读取降级为
   * "还没收到广播前"（首开窗口期）的兜底，**不是**第二真源。
   * `dirty = true` 表示缓冲与盘上不同步（保存后文本没变则不再广播——真相没变；
   * 消费方别拿"没收到 dirty=false"当异常）。
   *
   * 通用、游戏无关。**内核/宿主专属**：文件真相的真源在编辑器缓冲，插件伪造本事件
   * = 谎报文件内容（消费方会拿伪造文本当权威去转译/校验），与 `editor.codeLens.set`
   * 同档，见下方 `KERNEL_ONLY_EVENT_NAMES`。
   *
   * 宿主侧抑制约定（消费方不必自备防御）：糖视图（derived 只读内存 model）激活时
   * **不发**——派生文本不是文件真相（行号对不上）；切回原码后立即补发一条。
   */
  'editor.documentChanged': { filePath: string; text: string; dirty: boolean };
  /**
   * 编辑器光标位点变更（2026-10-16 反向下行批）：宿主在光标移动 / 切文件完成 /
   * 糖视图翻转后广播**最新位点**，让面板（条件矩阵 / 糖预览 / 糖判定）跟着光标走。
   *
   * 通用、游戏无关——「光标在哪」是宿主状态（与 `editor.activeFileChanged` 同档：
   * 面板只想"知道变了"，不想持有宿主引用）。方向与 `editor.revealLocation` 相反：
   * 那条是面板点一下、编辑器跳过去；本条是光标动、面板跟过来。
   *
   * `line` / `column` 为 1 基模型坐标；`filePath: null` = 无打开文件。
   * `derivedView: true` = 屏幕上显示的是转出来的糖视图，行号不属于真文件——
   * 消费方据此**清高亮**，不许拿它当源文件行号用。
   */
  'editor.cursorMoved': { filePath: string | null; line: number; column: number; derivedView: boolean };
  /**
   * 升糖预览意图（2026-10-12 升糖重定位批）：请求宿主在编辑器内**就地**显示
   * 某段原生 ERB 的语法糖写法（折叠原文区间 + 打字机透镜），**纯前端、不写盘**。
   *
   * 通用、游戏无关——插件发意图、宿主落地（与 `editor.revealLocation` 同款模式）。
   * 定位修正：升糖只用于"看"，因此不再有"写回源文件"的对应事件。
   */
  'editor.liftPreview.show': {
    filePath: string;
    /** 源区间起点（1 基，含） */
    fromLine: number;
    /** 源区间终点（1 基，含） */
    toLine: number;
    /** 糖写法（多行，`\n` 分隔） */
    sugarText: string;
    source?: string;
  };
  /** 收起升糖预览（与 `show` 对称；`filePath` 缺省 = 清空全部）。 */
  'editor.liftPreview.hide': { filePath?: string; source?: string };
  /**
   * 整文件**糖视图**开关意图（2026-10-12 语法糖批）：把当前（或指定）ERB 文件
   * **整份**显示为语法糖，或切回原代码。
   *
   * 与 `editor.liftPreview.show` 的分工：后者是"这一段"（点击某处、逐条候选、
   * 强自证口径，命中面窄）；本事件是"这一份文件"（逐行局部映射、单行降级，
   * 命中面宽）——服务"打开别人写的 ERB，像看剧本一样读懂它"。
   *
   * 通用、游戏无关；**只影响显示**（零写盘）。插件发意图、宿主落地。
   */
  'editor.sugarView.set': {
    /**
     * `true` = 显示为糖；`false` = 显示原代码；**省略 = 反转当前状态**
     * （状态所有者是宿主：请求方不必知道当前是开是关——命令面板的"切换"就是这种）。
     */
    on?: boolean;
    /** 目标文件；缺省 = 当前活动文件 */
    filePath?: string;
    source?: string;
  };
  /**
   * 写权限批准记录失效（2026-10-11 写权限闭环批 P0）：持久化的批准与适配器
   * 本次提议不一致（游戏更新等）——内核**未**放行写权限，等待用户重新确认。
   *
   * 通用、游戏无关——由宿主消费（重弹批准对话框 + 状态栏只读徽章）。
   * 修复点：此前仅 log.warn，宿主无从感知，旧批准记录场景会静默永久只读（F1/F2）。
   */
  'project.writableApprovalMismatch': { rootDir: string };
  /**
   * 回放意图（v0.2 第八批）：请求回放面板解释一个口上函数。
   * 通用、游戏无关——由回放面板（`state.replay` 的 UI 消费者）响应；
   * 任意插件可发起（导航面板"回放此函数"、未来的矩阵/预览联动）。
   *
   * `locate`（G1 跳到命中状态，2026-10-16；additive 可选，缺省 = 旧行为逐字不变）：
   * 发起方手上有**一个位置**（作者正看着的那一行），要求面板把这条记录拉到眼前。
   * 语义由消费方解释——它拿 `locate.filePath` 与本次结果的来源文件对一遍，
   * 对得上就定位到那一行的判定并高亮，对不上就说清为什么对不上（绝不静默）。
   * 之所以带上 `filePath`：同一份内容有两种写法视图时行号会错位，
   * 只给行号就等于让消费方猜"这些行号属于哪份文本"。
   * W9 落点 span 批（2026-10-17，additive）：位点同样可以带 `column` / `span`，
   * 语义与 `editor.revealLocation` 的同名字段**逐字相同**（同一处位置的两种写法）——
   * 面板把这条记录拉到眼前时、与编辑器把光标放到这一处时，落点必须是同一个地方。
   *
   * 分层口径：这个成员**只说"看哪一行"，不说"这一行是什么"**——发起方（宿主）
   * 交出的是中性位点，函数名仍由它按符号树折好放在 `functionName` 里，
   * 命中与否的判定权全在回放侧（避免第二套判据）。
   */
  'kojo.replayFunction': {
    functionName: string;
    source?: string;
    locate?: { filePath: string; line: number; column?: number; span?: RevealSpan };
  };
  /**
   * 打开 overlay 意图（2026-10-11 UI 重设计批 P2）：请求宿主打开某 `ui.overlay`
   * 贡献（新建向导 / 重授权 / 设置等模态）。
   * 通用、游戏无关——插件发意图、宿主落地，插件间零依赖
   * （与 `editor.revealLocation` 同款模式）。
   *
   * `payload` **不会送到组件手里**：宿主只按 id 找贡献并渲染其组件，而组件无 props，
   * 读的是拥有插件的闭包状态（`import-wizard.ts` 的 `pendingImport`、
   * `deploy-wizard.ts` 的 `pendingDeploy` 就是这个模式）。要跨插件送东西，
   * 走语义事件（如 `workspace.newProjectRequested`），别把 payload 当参数用。
   */
  'ui.overlay.open': { id: string; payload?: unknown; source?: string };
  /**
   * 浮动面板意图（2026-10-14 UI 浮动批）：请求宿主把某个 `ui.panel` 贡献弹出为
   * 可移动浮窗（非模态，不遮挡编辑器）。通用、游戏无关——插件发意图、宿主落地
   * （与 `ui.overlay.open` 同款模式）；停靠由宿主浮窗自带的按钮完成。
   */
  'ui.panel.float': { id: string; source?: string };
  /**
   * 关闭 overlay 意图（UI 重设计批 P2）：请求宿主关闭某 `ui.overlay` 贡献。
   * 与 `ui.overlay.open` 对称——overlay 内组件（向导完成/取消）经此自行退出，
   * 无需持有宿主引用。
   */
  'ui.overlay.close': { id: string; source?: string };
  /**
   * 教程打开意图（用户反馈 8 批，2026-10-17）：请求教程提供方打开某一本内置教程。
   *
   * 通用、游戏无关。载荷只给**语义 id**（口上工作流 / 语法 / 语法全表），
   * 刻意不携带 overlay 贡献 id：发起方（欢迎页等）不该知道提供方那个模态叫什么——
   * 与 `workspace.newProjectRequested` 同款分工（意图进、映射与落地归消费方）。
   * 没有教程提供方在场时无人响应，发起方无须关心（与 `ui.overlay.open` 同一模式）。
   */
  'ui.tutorial.open': { tutorial: 'kojo' | 'sugar' | 'reference'; source?: string };
  /**
   * 打开通用 diff 视图意图（2026-10-15 比对/历史批）：请求宿主弹一枚独立模态，
   * 逐行对比发起方给定的两侧内容（宿主用 Monaco 内建 diff 编辑器渲染，行级差异
   * 与并排/内联切换由 Monaco 提供，宿主零 diff 算法零业务判定）。
   *
   * 通用、游戏无关——插件发意图、宿主落地（与 `editor.revealLocation` 同款模式）；
   * 消费场景：工作区版 vs 游戏目录版比对、历史版本 vs 当前内容对比。
   * 载荷两侧各「内联文本或磁盘路径」二选一（见 `DiffViewSide`）；都不给 = 无效请求，
   * 宿主必须**可见地拒绝**（呈现原因），不得静默。
   */
  'ui.diffView.open': {
    title: string;
    /** 左（旧/参照侧） */
    original: DiffViewSide;
    /** 右（新/对照侧） */
    modified: DiffViewSide;
    source?: string;
  };
  /**
   * 外链打开意图（2026-10-16 市场外链批）：请求宿主用**系统默认浏览器**打开一个外链。
   * 通用、游戏无关——插件够不着平台，跨层意图走总线（与 `workspace.importRequested`
   * 同款分工：发起方发意图，壳层消费方调桥接落地）。
   *
   * 闸（scheme 必须 https + 主机过平台放行列表）的**唯一执法点在 Rust**
   * `open_url_external`——本载荷只冻结 `{ url }` 一项，白名单不进契约、不进插件
   * （第二份真相必然漂）；被拒时由壳层用户可见地反馈，不由发起方猜原因。
   */
  'ui.openExternal': { url: string };
  /**
   * 归档选中意图（v0.2 第十三批）：归档浏览器面板选中某档后广播。
   * 通用、游戏无关——任意插件可响应（未来的状态注入器 / 对比视图）；
   * 载荷只含归档路径与文件名（消费者按需自行深解析）。
   */
  'kojo.snapshotSelected': { path: string; fileName: string; source?: string };
  /**
   * 工作区导入意图（2026-10-12 工作区批）：请求把某个外部目录导入作者工作区。
   * 通用、游戏无关——宿主（如文件树右键菜单）只携带源目录与建议名发出；
   * 「导入成什么形态的制品」由工作区消费方（适配器）解释。
   */
  'workspace.importRequested': { sourceDir: string; suggestedName?: string; source?: string };
  /**
   * 请工作区消费方打开「新建口上项目」向导（2026-10-13 反馈 3 批）：
   * 作者手上有一份还没落盘的新文件，但没有项目可放——先发这个意图，
   * 由拥有项目向导的一方决定怎么开门、问哪些字段。
   *
   * 通用、游戏无关——**刻意不叫 overlay id**：发起方不该知道对方那个模态叫什么
   * （`eratw.newKojoProject` 这种字面量一旦进契约，插件层就长出了游戏词，
   * 审计 A 项当场会红）。
   *
   * `requestToken` 是**关联号**不是凭据：兑现见 `workspace.projectCreated`。
   */
  'workspace.newProjectRequested': { requestToken?: string; source?: string };
  /**
   * 工作区项目已创建（2026-10-13 反馈 3 批）：谁建的、为什么建，本事件都不解释——
   * 只广播「多了一个项目」这一事实。
   *
   * 通用、游戏无关。`requestToken` 是**关联号**而非凭据：发起方经
   * `workspace.newProjectRequested` 把它送来，创建方在广播时原样带回，发起方据此
   * 判断「这次创建是不是我引出来的」。带它，是为了让被取消的请求**不会**在下一次
   * 无关的创建里凭空造出一个作者没要过的文件（关联号不匹配即作废）。
   */
  'workspace.projectCreated': { projectId: string; requestToken?: string; source?: string };
  /**
   * 「发布口上」意图（用户反馈 4 批）：市场面板只表达「作者要把自己的口上作品发到市场」，
   * **怎么发一概不解释**——项目选择 / 包内容转译 / 许可与分发选项 / 打包与上传，
   * 全部由拥有口上项目模型的消费方（适配器）按自己的领域知识落地。分工与
   * `workspace.importRequested` 同款：发起方只递意图，消费方决定开哪扇门、问哪些字段。
   *
   * 通用、游戏无关：事件名与载荷里没有任何游戏词，`source` 只标「谁点的」。
   * 载荷**刻意不携带项目 / 包 / 许可**：那些是消费方从自己的工作区现读的事实；
   * 让发起方隔空指定「发哪个项目」，等于把别人的模型抄进自己的界面（第二份真相，
   * 而且发起方一升级就得跟着改）。同理它也不叫某个 overlay id——模态名叫什么
   * 是消费方的私事，字面量一旦进契约，插件层就长出了本不该有的知识。
   */
  'market.publishRequested': { source?: string };
  /**
   * 「全部修复」意图（E3，2026-10-16 批量快速修复批）：请求宿主把**当前文档**里
   * 每一条"只有唯一改法"的问题一次补好。
   *
   * 通用、游戏无关——批量判据（哪些算唯一解、改写相撞怎么排）全在宿主一侧，
   * 发起方只表达"我要一次补好"这一个意图（与 `editor.sugarView.set` 同款分工：
   * 命令面板/快捷键发意图，编辑器宿主落地）。
   *
   * **只改编辑器缓冲区**：不写盘（落盘仍由作者 Ctrl+S 决定）、可 `Ctrl+Z` 撤销、
   * 多解的问题一条都不动。宿主必须把结果如实说一句（补了几处 / 剩下几处为什么要
   * 逐处选），不得静默返回"没反应"。
   */
  'editor.fixAll.request': { source?: string };
  /**
   * 行上内联注解开关（B8，2026-10-16 行内注解批）：设置页那一项的真值由宿主写入偏好，
   * 并广播这一意图让**编辑器**把它落到 Monaco 的 `codeLens` 选项上。
   *
   * 通用、游戏无关；状态所有者是编辑器（同 `editor.sugarView.set` 的分工：壳层的设置页
   * 只写偏好 + 发意图，不在自己这里另存一份业务态）。
   *
   * 为什么非要有这条事件而不是"编辑器每次自己读偏好"：`codeLens` 是 Monaco 的**编辑器选项**，
   * 翻开关后必须让 Monaco 重算一次才当场见效（取证 `codelensController.js`
   * `e.hasChanged(EditorOption.codeLens) → _onModelChange()`）。只读不推 = 作者关掉设置页
   * 回到编辑器，注解一条都没动，要等下一次打字才变——那是"按了没反应"。
   */
  'editor.codeLens.set': { on: boolean };
  /**
   * 编辑器动作意图（R8 命令面板补齐批，2026-10-16）：命令面板/键位请求宿主在
   * **当前活动编辑器**上执行一条 Monaco 内建动作（查找 / 替换 / 格式化文档 /
   * 重命名符号 / 查找引用）。
   *
   * 通用、游戏无关——壳层发意图、编辑器宿主落地（与 `editor.fixAll.request` 同款
   * 分工：动作真源在编辑器，发起方不必也不该知道 Monaco 的 action id）。
   * **刻意不带缺省键位**：编辑器内这些动作 Monaco 已有内建键（Ctrl+F / Ctrl+H /
   * Shift+Alt+F / F2 / Shift+F12），宿主命令不抢键；命令面板是无键入口。
   */
  'editor.action.request': {
    action: 'find' | 'replace' | 'formatDocument' | 'rename' | 'references';
    source?: string;
  };
}

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
  // 监视状态 = "自动重载机制是否可信"的保证，与写权限同意度同类（BUG-5）
  'file.watchState',
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

/** 插件自定义事件键：必须携带 "插件id:" 前缀（例：'my-plugin:indexReady'） */
export type CustomEventKey = `${string}:${string}`;

/** 插件自定义事件（payload 由插件自行约定；内核不做类型校验） */
export type PluginEventMap = { [K in CustomEventKey]: unknown };

/** 总线接受的完整事件表 */
export type AnyEventMap = KernelEventMap & PluginEventMap;

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

/**
 * 类型化事件总线。
 * - 内核事件享有编译期 payload 校验；
 * - 插件自定义事件受前缀约定约束；
 * - 单个 handler 抛错不会影响其它 handler（内核隔离并记录日志）。
 */
export interface EventBus {
  on<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe;
  once<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe;
  emit<K extends keyof AnyEventMap>(type: K, payload: AnyEventMap[K]): void;
  /**
   * 订阅 **+ 回放**（additive，2026-10-18）：与 `on` 一样订阅后续广播，并立即
   * （同步，在本调用返回前）拿该事件**最后一条**载荷回调一次。
   *
   * 语义边界：
   * - **只对 `STICKY_EVENT_NAMES` 里的事件回放**，其余事件等价于 `on`（永不回放）；
   * - 回放恰好一次：订阅那一刻的最后值补一发，之后照常按 `emit` 派发，不重复投递；
   * - 订阅者从未收到过该事件（总线里没有最后值）⇒ 不回放；
   * - 退订后不再回调（回放发生在订阅时，退订只掐后续广播）；
   * - 回放回调抛错与正常派发同一待遇：走总线的 `onHandlerError`，不影响其它订阅者。
   *
   * **为什么是 optional**：本方法是对既有 `EventBus` 的 additive 扩展——旧测试替身 /
   * 极简总线可以没有它，消费方必须退回 `on`（行为与引入前逐字一致），不得因缺席而崩。
   * 反过来，声明实现了 `EventBus` 并提供本方法的总线，语义必须与本节一致。
   */
  onSticky?<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe;
}
