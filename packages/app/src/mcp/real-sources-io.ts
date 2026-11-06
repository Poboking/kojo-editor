/**
 * MCP 真源腿 · IO 面（A3：消灭可接而未接的 NOT_WIRED，只接真源）。
 *
 * 覆盖：kernelIo 3 腿（projectInfo / fileTree / searchAll）、runSupplemental 的
 * 只读 IO 腿（commands.list / fs.readFile / fs.stat / io.listDir / io.workspaceRoots /
 * workspace.searchAll）、resource 数据源里不依赖 Monaco 的 6 个 URI。
 *
 * 纪律（POOL-HANDOFF §3.1 / ADR-0013）：
 * - 本模块只被 `real-sources.ts`（ShellLayout 登记点动态 import）装载，不进 ps10 开机静态图；
 *   顶层不 import kernel / Monaco / bridge 运行时——内核实例、invoke、检索全部经 deps 注入，
 *   生产由 `installRealMcpSources` 动态 import 后传入，测试给假实现。
 * - **只收项目根内相对路径 + 域复核**：`validateRelativePath` 与 Rust 侧
 *   `mcp::protocol::validate_relative_path` 同尺（拒空 / 过长 / 控制字符 / 不可见格式字符 /
 *   百分号编码含双重编码 / 盘符与 ADS 冒号 / `~` / 反斜杠 / 绝对与 UNC 前缀 / `.` 与 `..` 段 /
 *   空组件 / 组件过长 / 尾点尾空格 / 设备保留名），`resolveWithinRoot` 再做一次
 *   resolve-后前缀复核（纵深，fail-closed）。绝不给 MCP 暴露任意目标路径参数。
 * - 读文件一律有截断上限 + 显式 `truncated` 标记；接不到真源一律显式
 *   `NOT_WIRED` / `RESOURCE_UNAVAILABLE`（铁律 4：不静默、不伪造读数、不空串冒充成功）。
 * - 写腿（2026-11-06 MCP 写腿批）：`fileTree.create` / `fileTree.update` 接**编辑器既有写通道**
 *   （内核 `kernel.io` 的 FileIO 契约写原语，测试假件 / 精简桥缺原语 ⇒ 显式 NOT_WIRED），
 *   双闸叠加、绝不新建旁路写通道：
 *     ① MCP 侧第四张表复核（`scope.approvedRoots`，相对根前缀；不覆盖 ⇒ `WRITE_DISABLED`）；
 *     ② 内核 `io` 自带的写允许域（`assertWritable` + Rust `ensure_write_allowed`）——
 *        内核写域拒绝（`WriteNotAllowedError`）⇒ 显式 `WRITE_DISABLED`（这是正确行为不是缺陷）。
 *   create 用独占创建原语（已存在 ⇒ 显式报错，绝不覆盖）；update 先判存在（不存在 ⇒ 显式报错，
 *   绝不静默改成 create 语义）再走 `writeText` 既有保存语义（保编码 / 保换行 / 写前备份）；
 *   remove 先经只读 `stat_file`（`deps.invoke` seam）判文件/目录，删目录须显式 recursive:true，
 *   文件走 `io.removeFile`、目录走 `io.removeDir`；rename 的 `from` / `to` **两端都过**路径闸与
 *   第四张表复核（任一越界整批拒绝）再走 `io.rename`。四腿一律绑内核 `kernel.io` 既有写原语，
 *   **绝不 `deps.invoke` 直调 Rust 写命令绕开内核第一道写允许域**（`assertWritable` / Rust
 *   `ensure_write_allowed` 双闸都不绕）。
 *   成功后尽力广播内核既有 `file.changed` 事件喂给宿主刷新（App.tsx 同款通道），缺席如实标注；
 *   删除 / 改名广播沿用 `@kojo/plugin-api` 既有 `FileChangeKind` 的 `'unlink'` / `'add'`（additive，
 *   旧 `'add' | 'change'` 调用方零改动）。
 *   `problems.quickFix`（Wave4 余项①，2026-11-06）接的是宿主既有 codeAction 反查表 +
 *   `applyTextEdits`：Monaco **模型内**单次编辑（一个撤销步、可见脏、**不落盘、不触 io、不 invoke**，
 *   铁律 5/6/7 不新建写通道）；稳定 actionId 台账 + 逐闸显式拒绝见 `quick-fix.ts`，
 *   `run` 式意图 / 糖投影仍保持显式 NOT_WIRED（能力没接上的部分不假成功）。
 * - **打开文档面（B10 批，LaneV 2026-11-06）**：`editor.openDocument` 执行体**只复用**宿主既有事件
 *   `editor.revealLocation`（App.tsx 通用导航落地点）——MCP 侧不加机制、只加观察：发射后**有界轮询**
 *   `livePanes` 登记簿（窗与间隔是常量，依据写在 `editor-open-legs.ts` 模块头），读到「实例的活动文件
 *   就是这条 path + 上屏 model 就是它那一份标签的 model」才回 `opened:true`；读不到一律显式失败并交代
 *   账目（等了多久 / 几个实例 / 各实例正显示什么 / 为什么判没打开），**绝不 opened:true 冒充**。
 *   入参只收项目根内相对路径，走的是与 `fs.readFile` **同一条** `resolveWithinRoot`；
 *   `getRootDir` / 路径闸**不接受注入替换**（测试只能换观察件与发射件，换不了闸）。
 *   本腿零写盘、零改模型、零改光标：`saved:false` + `contentChanged:false` 恒定如实回报
 *   （铁律 5/6/7：本批同样零新增写盘通道）。
 * - **Wave4 余项 ③（外部写盘感知 → 失效信号）**：只读腿的应答一律附 `fsFreshness` 字段
 *   （判定器 / 真源出处 / 监视覆盖 / 有界账读数），真源见 `./fs-freshness`：
 *   `kernel.fileWatch.state()`（`start_watch` 回执的宿主侧形态）+ 总线 `file.changed` /
 *   `file.watchState`。本批**只做感知与标注**：写腿的响应形状、双闸与落盘语义零改动，
 *   只在广播同一调用栈里补一次自写记账（`noteSelfWrite`，用于把「自己刚写的」与「外部改的」
 *   分开归因）；**绝不新建写通道、绝不因感知需要而放宽写闸**。
 *   判定缺席一律可见：监视不可用 / 路径不在监视域 / 会话内没有可比基线 / 账已溢出
 *   ⇒ `stale:null` + `staleReason`，绝不用乐观 `false`、绝不用空串或默认值假装有。
 *   B13（2026-11-06）：只读腿改走**读时复核**异步入口（`verdictOfRechecked` /
 *   `listingOfRechecked`；批量面 `fs.statFiles` / `fs.readMany` 逐条标注一趟
 *   `verdictsOfRechecked`）——自写回声窗内命中时本次读数即定档，复核做不了仍如实 null。
 * - 长任务面（Wave4 余项⑤「长任务 progress」· ADR-0013 P5「Tasks over MCP」）：`tasks.start` /
 *   `tasks.status` / `tasks.cancel` 三枚具名工具与 `kojo://tasks` resource 都**只分派**给注入的
 *   `McpTaskLegs`（真源在 `real-sources-tasks.ts`：表、进度投影、有界性、取消语义都在那一层）。
 *   `deps.tasks` 缺席 ⇒ 工具显式 `NOT_WIRED`、resource 显式 `RESOURCE_UNAVAILABLE`（铁律 4：
 *   没有真任务表就不装出任务来，也不空表冒充「没有在跑的任务」）。`kojo://tasks` 的数据腿必须拿
 *   **真 scope**（表按 sessionId+clientId 隔离）——组装点过去给 `null` 顶替，本批一并修掉。
 */
import {
  McpFailure,
  assertCursorShape,
  decodePageCursor,
  encodePageCursor,
  pageFingerprint,
  pageParamsFor,
  paginateByCursor,
  paginateText,
  truncateResourceText,
} from '@kojo/mcp-host';
import type {

  McpKernelIo,
  McpReaderFn,
  McpResource,
  McpSessionScope,
} from '@kojo/mcp-host';
import type { CommandEntry } from '../ui/commands';
import { createQuickFixApplyLeg, type QuickFixPaneResolver } from './quick-fix';
// B3 批（LaneO，2026-11-06）：编辑器写 / 光标副作用五枚具名工具的执行腿。
// 真源 = debug/install-debug.ts 已实现并测过的同一批腿；与调试面唯一差别是 MCP 面**没有
// 「当前聚焦」语义**，一律按 paneId 显式反查（见 editor-write-legs.ts 模块头判性）。
import { createEditorWriteLegs, type EditorWritePaneResolver } from './editor-write-legs';
// B10 批（LaneV，2026-11-06）：`editor.openDocument` 的执行腿——发射宿主既有
// `editor.revealLocation`，再**有界轮询登记簿**把落地读回来（回执只认登记簿读数，读不到即显式失败）。
// 机制一条没加、观察加一层；实现腿的形状照 editor-write-legs.ts（seam 注入 + 生产动态 import）。
import {
  createEditorOpenLegs,
  productionEmitOpenIntent,
  productionObserveEditorPanes,
  type McpEditorOpenDeps,
} from './editor-open-legs';
// B4 批（LaneS，2026-11-06）：启动器族 27 枚具名 privileged 工具的执行腿。
// 真源 = `kernel.launcherHost`（一方法一条 Rust `launcher_*` 命令）；档位与批准语义零改动
// （`launcher_` 前缀在 Rust `is_launcher_tool()` 与 WebView `PRIVILEGED_TOOL_PREFIXES` 两侧
// 都判 privileged，第四张表只认精确名），授权面零放宽（第三张表复验全在宿主，本面不收落点）。
import { createLauncherLegs } from './real-sources-launcher';
import type { McpLauncherHostLike } from './real-sources-launcher';
import {
  fsFreshnessAbsentPayload,
  fsFreshnessPayload,
  type FsFreshnessTracker,
} from './fs-freshness';
// B2 批（LaneT，2026-11-06）：结构化批读面 `fs.readMany` 的执行腿（真源 = 内核 io.readTexts）。
// 路径闸 / 项目上下文 / 失效标注器由本模块注入——该模块只 `import type` 本文件的形状，
// 不反向 import 运行时（零循环依赖）；改动集中在独立新模块，减少对本热点文件的编辑面。
import { createBatchReadLeg, type BatchTextFile } from './batch-read-leg';
// B16 批（LaneZ，2026-11-06）：检索墙（单次 5,000 条命中）的**分片续取**腿。
// 每片＝一次既有 search_text 调用（零新 Rust 命令 / 零新写通道），只在可选新入参
// resumeBySlice:true 时接管；判性由 Rust 侧真引擎用例实测（search_tests.rs 的 wall_* 七条）。
import { createSearchSliceRunner } from './search-slice-leg';
// 写域多根（2026-11-06，additive）：rootId 是常驻可写根的**稳定枚举标识**，不是目标路径。
// 纯函数真源单独成文件（零依赖、零副作用），本模块只做「批准面复核 + 只读真源反查 + 选根」。
import { findRootById, isRootIdShape, rootIdOf } from './workspace-root-id';

/* ------------------------------- 窄结构类型 ------------------------------- */

/** Tauri invoke 的最小形状（生产 = `bridge/invoke` 的 invoke，测试 = 假）。 */
export type McpInvokeLike = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 检索请求（与 `bridge/search.ts` 的 SearchRequest 结构同形的最窄投影）。 */
export interface McpSearchRequestLike {
  readonly searchId: number;
  readonly roots: readonly string[];
  readonly query: string;
  readonly options: {
    readonly isRegex: boolean;
    readonly caseSensitive: boolean;
    readonly wholeWord: boolean;
    readonly extensions: readonly string[];
    readonly maxResults?: number;
    /**
     * **逐文件续取凭据**（B18，additive）：先丢掉每个文件的前 N 条命中再按原闸收口。
     * 缺省不传 ⇒ 请求体与旧面逐字相同；引擎回显见 `McpSearchResultLike.resumeAppliedMatches`。
     */
    readonly resumeAfterMatches?: number;
    /**
     * 软时限（MCP-PERF-S1 的 Rust DTO / bridge 类型已在；MCP-PERF-S8 起 MCP 面真收这个入参）：
     * 自检索起点起算的毫秒预算，到点不再领新文件、在手的扫完收口。缺省不传 ⇒ 请求体与
     * 旧面逐字相同（无时限）。MCP 面闸：正整数 ≤120000（`searchDeadlineMsOf`，越界显式拒收）。
     */
    readonly deadlineMs?: number;
  };
}

/** 检索结果（与 `bridge/search.ts` 的 SearchResult 结构同形的最窄投影）。 */
export interface McpSearchResultLike {
  readonly files: readonly {
    readonly path: string;
    readonly matches: readonly { readonly line: number; readonly preview: string }[];
  }[];
  readonly totalMatches: number;
  readonly truncated: boolean;
  /**
   * **续取回显**（B18）：本次调用因 `options.resumeAfterMatches` **实际丢掉**的命中条数。
   * 可选：旧宿主 / 调试宿 Node 镜像没有这个键 ⇒ 读取侧按「这台宿主不认凭据」处理
   * （分片腿据此退回 B16 那堵墙的原话术），绝不把「没回显」当成「续上了」。
   * 缺省不带凭据时引擎给 0。
   */
  readonly resumeAppliedMatches?: number;
  /**
   * 是否被 `cancel_search` 提前收尾（真 `SearchResult` 有这一位；长任务面按它判终态
   * `cancelled`，缺席按 false 处理 ⇒ 可选，既有假件零改动）。
   */
  readonly cancelled?: boolean;
  /**
   * 软时限账（MCP-PERF-S1，additive）：结果不完整是因为 `deadlineMs` 到点（与
   * `truncated`（命中上限）/ `cancelled`（取消）账分立）。可选：旧宿主没这个键 ⇒
   * 按 false 处理，MCP 应答不带 partial 键（零漂移）。
   */
  readonly partial?: boolean;
  /** `partial` 的原因码：partial=false 恒缺席；当前唯一取值 "deadline"。 */
  readonly partialReason?: string;
  readonly filesScanned: number;
  readonly elapsedMs: number;
  readonly skipped: unknown;
}

/**
 * 内核实例的最窄结构投影（真 `Kernel` 在组装点一次性断言进来：project/io/plugins/
 * services/bus 五面逐字段核对过；测试直接给假对象）。
 *
 * `io` 的写原语 / `bus.emit` 为**可选**：真 `FileIO` 契约都有（生产内核结构满足），
 * 测试假件与精简桥可缺席——缺席时写腿显式 NOT_WIRED（不静默、不造假实现）。
 */
export interface McpKernelLike {
  readonly project: { readonly current: () => unknown };
  readonly io: {
    readonly walkDir: (path: string, opts?: Record<string, unknown>) => Promise<unknown[]>;
    /** FileIO 契约写读原语（写腿用；缺席 ⇒ NOT_WIRED）。 */
    readonly exists?: (path: string) => Promise<boolean>;
    readonly createFileExclusive?: (path: string) => Promise<boolean>;
    readonly createDirExclusive?: (path: string) => Promise<boolean>;
    readonly writeText?: (path: string, text: string, opts?: Record<string, unknown>) => Promise<void>;
    /** 删除 / 改名写原语（同为 FileIO 契约，内部各自 `assertWritable`；缺席 ⇒ NOT_WIRED）。 */
    readonly removeFile?: (path: string) => Promise<void>;
    readonly removeDir?: (path: string) => Promise<void>;
    readonly rename?: (from: string, to: string) => Promise<void>;
    /**
     * FileIO 契约的**批量读**原语（`fs.readMany` 用；B2 批 LaneT 2026-11-06，additive）。
     * 语义（契约真源 `@kojo/plugin-api` io.ts）：与 readText 同一条编码/BOM/EOL 管线、
     * 每批一次 IPC、逐文件失败不抛整批 ⇒ 失败位 `null`、可命中会话文本缓存、
     * 返回数组与入参一一对应（含重复路径）。测试假件 / 精简桥可缺席 ⇒ 该腿显式 NOT_WIRED。
     */
    readonly readTexts?: (paths: readonly string[]) => Promise<readonly (BatchTextFile | null)[]>;
    /**
     * FileIO 契约的**写前备份**原语（`fileTree.applyChangeset` 用；MCP-PERF-S3 批，additive）。
     * 语义（契约真源 `@kojo/plugin-api` io.ts）：与 writeText 内部调的是**同一个**备份机制
     * （`{appDataDir}/backup/{bucket}/{timestamp}.bak`，属主清单 + 版本同桶）；盘上无此文件
     * ⇒ `null`（如实，不编造路径）。测试假件 / 精简桥可缺席 ⇒ 批量腿显式 NOT_WIRED。
     */
    readonly backup?: (path: string) => Promise<string | null>;
  };
  readonly plugins: { readonly list: () => unknown[] };
  readonly services: { readonly tryGet: <T = unknown>(key: string) => T | undefined };
  readonly bus: {
    readonly on: (name: string, cb: (payload: unknown) => void) => () => void;
    /** 写成功后广播 `file.changed`（宿主刷新既有通道）；缺席 ⇒ 跳过并在结果里如实标注。 */
    readonly emit?: (name: string, payload: unknown) => void;
    /**
     * 当前订阅者数（`editor.openDocument` 的发射前预检用，B10 批 LaneV 2026-11-06，additive）。
     * 真实现 = 内核 `EventBus.listenerCount`（调试辅助，**不在 `@kojo/plugin-api` 的 EventBus 契约里**）
     * ⇒ 这里按可选投影：读不到 ⇒ 腿如实 `subscribers:null`，不编造订阅数、也不为它抬契约。
     */
    readonly listenerCount?: (name: string) => number;
  };
  readonly slots: { readonly query: (slot: string) => readonly unknown[] };
  /**
   * 文件监视控制器（真 `Kernel.fileWatch: FileWatchController`）。MCP 只读它自己的
   * `state()`——即 `start_watch` 回执的宿主侧形态（哪些根监视上了、哪些没监视上、为什么）；
   * **不调 `start` / `stop`**（内核是 `watchDirs` 唯一调用方，监视语义零改动）。
   * 测试假件可缺席 ⇒ 失效判定降级为「覆盖不可用」并如实标注（不静默）。
   */
  readonly fileWatch?: {
    readonly state: () => {
      status: string;
      roots: readonly string[];
      failures: readonly { root: string; reason: string }[];
    };
  };
}

/**
 * 长任务面（Wave4 余项⑤）的四腿形状（实现见 `real-sources-tasks.ts`，本模块只做分派与兜底）：
 * `start` / `status` / `cancel` 是工具腿，`list` 是 `kojo://tasks` resource 的数据腿。
 * 缺席 ⇒ 每一腿显式 `NOT_WIRED` / `RESOURCE_UNAVAILABLE`（铁律 4：不静默、不伪造任务读数）。
 */
export interface McpTaskLegs {
  readonly start: (args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown>;
  readonly status: (args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown>;
  readonly cancel: (args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown>;
  readonly list: (scope: McpSessionScope) => Promise<unknown>;
}

/**
 * `semantic.projectSymbols` 消费的 erb-parser 索引服务**最窄结构投影**
 * （MCP-PERF-S4，LaneK 2026-11-07）。真源 = `kernel.services.tryGet('erb.parser')`
 * （与 ui/editor-global-providers.ts 的宿主软取同一条键）；本投影**零插件 import**
 * ——按结构认（铁律纪律：接口隔离 + 不给 ps10 开机静态图加边），字段缺席逐个判。
 * `byName.forEachDef` 是 ErbFunctionLookup 的逐定义回调（不建组数组，10 万级名录全量
 * 遍历的首选口径）。
 */
export interface ErbParserServiceLike {
  readonly currentIndex?: () => unknown;
  readonly ensureIndex?: () => Promise<unknown>;
  readonly indexState?: () => unknown;
}

/** `ErbParserServiceLike.currentIndex()` 产出的索引最窄投影：只用 byName 一条腿。 */
export interface ErbIndexLike {
  readonly byName?: {
    readonly forEachDef?: (cb: (ref: Record<string, unknown>, normalizedName: string) => void) => void;
  };
}

/** 宿主真源的窄投影（与 `McpWiringSources` 的 commands 同源）。 */
export interface McpIoDeps {
  readonly getKernel: () => McpKernelLike | null;
  readonly getCommands: () => readonly CommandEntry[];
  readonly invoke: McpInvokeLike;
  readonly searchInFiles: (request: McpSearchRequestLike) => Promise<McpSearchResultLike>;
  /** `problems.quickFix` 的 pane 反查 seam（缺席 ⇒ 生产动态 import 解析，见 quick-fix.ts）。 */
  readonly getQuickFixPane?: QuickFixPaneResolver;
  /**
   * `editor.*` 五枚（setValue / type / setCursor / setSelection / revealLine）的 pane 反查 seam
   * （B3 批，LaneO 2026-11-06）。缺席 ⇒ 生产动态 import `livePanes` 解析（见 editor-write-legs.ts）。
   * 本面**不设「当前聚焦编辑器」兜底**：paneId 不在册即显式 `NOT_WIRED`（铁律 4：不静默迁移到别的 pane）。
   */
  readonly getEditorPane?: EditorWritePaneResolver;
  /**
   * `editor.openDocument` 的注入面（B10 批，LaneV 2026-11-06）：只给要换的那几位
   * （生产缺省 = `productionEmitOpenIntent(kernel.bus)` + `productionObserveEditorPanes` 动态
   * import `livePanes`）。`getRootDir` / `resolveWithinRoot` **不由注入面给**——根读法与路径闸
   * 必须与 `fs.readFile` 同一条，测试不许从这里换闸。
   */
  readonly editorOpen?: Partial<McpEditorOpenDeps>;
  /**
   * 外部写盘失效判定器（Wave4 余项 ③；生产由 `real-sources.ts` 绑定内核后给到，
   * 测试可注入或缺席）。缺席 ⇒ 只读应答仍附 `fsFreshness`，值如实为
   * `{available:false, stale:null, staleReason}`（铁律 4：字段不因缺席而消失）。
   */
  readonly fsFreshness?: () => FsFreshnessTracker | null;
  /** 长任务面（`tasks.*` 工具 + `kojo://tasks` 数据腿）；缺席 ⇒ 显式 NOT_WIRED。 */
  readonly tasks?: McpTaskLegs;
  /**
   * 启动器宿主面（B4 批，LaneS 2026-11-06）：真源 = `kernel.launcherHost`
   * （一条方法 = 一条 Rust `launcher_*` 命令，实现腿见 `real-sources-launcher.ts`）。
   * 生产装配不给这一枚 ⇒ 腿自己从注入的内核实例上取；测试注入假件。
   * 缺席（浏览器宿 / 无内核）⇒ 每一腿显式 `NOT_WIRED` 带理由，**绝不空数组冒充「没有实例」**
   * （铁律 4），也绝不从 MCP 面拿任何落点决定权（铁律 6/7：第三张表只在宿主复验）。
   */
  readonly getLauncher?: () => McpLauncherHostLike | null;
}

/* ------------------------------- 路径闸（与 Rust 同尺） ------------------------------- */

const MAX_PATH_CHARS = 512;
const MAX_COMPONENT_CHARS = 255;
const DEVICE_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);

function isControlCodePoint(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

function isInvisibleFormatChar(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff ||
    cp === 0x00ad
  );
}

function isDeviceComponent(comp: string): boolean {
  const stem = (comp.split('.')[0] ?? '').toUpperCase();
  if (DEVICE_NAMES.has(stem)) return true;
  if (stem.length === 4 && (stem.startsWith('COM') || stem.startsWith('LPT'))) {
    const tail = stem.slice(3);
    return tail >= '0' && tail <= '9';
  }
  return false;
}

/** 回显前净化：控制 / 不可见字符替成可见占位并限长（不把脏字节再打回调用方）。 */
export function sanitizeEcho(raw: string, limit = 128): string {
  let out = '';
  for (const ch of Array.from(raw.slice(0, limit))) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isControlCodePoint(cp) || isInvisibleFormatChar(cp) ? '\uFFFD' : ch;
  }
  return out;
}

/** 项目内相对路径判据：与 Rust `mcp::protocol::validate_relative_path` 同尺，越界抛 INVALID_ARGS。 */
export function validateRelativePath(raw: string): void {
  const bad = (why: string): never => {
    throw new McpFailure('INVALID_ARGS', `路径越界（${why}）：${sanitizeEcho(raw)}`);
  };
  if (raw === '') bad('空路径');
  if (raw.length > MAX_PATH_CHARS) bad('过长');
  for (const ch of Array.from(raw)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isControlCodePoint(cp)) bad('含 NUL / 控制字符（含 C1、DEL）');
    if (isInvisibleFormatChar(cp)) bad('含双向 / 零宽不可见字符');
  }
  // 任何百分号都拒：URL 编码与双重编码整类形状一次性掐断，避免下游按不同解码口径二次解释。
  if (raw.includes('%')) bad('含百分号编码（URL 编码 / 双重编码）');
  if (raw.includes(':')) bad('盘符 / scheme / ADS 冒号');
  if (raw.includes('~')) bad('家目录展开前缀');
  if (raw.includes('\\')) bad('反斜杠分隔 / 正反斜杠混用');
  if (raw.startsWith('/')) bad('绝对路径或 UNC 前缀');
  for (const comp of raw.split('/')) {
    if (comp === '') bad('空组件（双斜杠或尾斜杠）');
    if (Array.from(comp).length > MAX_COMPONENT_CHARS) bad('组件过长');
    if (comp === '.' || comp === '..') bad('点 / 上跳组件');
    if (comp.endsWith('.') || comp.endsWith(' ')) bad('尾点或尾空格');
    if (isDeviceComponent(comp)) bad('设备保留名');
  }
}

/** 根目录归一：分隔符统一 `/`、去尾斜杠；空串（无根）⇒ null。 */
export function normalizeRoot(rootDir: string): string | null {
  const norm = rootDir.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  return norm === '' ? null : norm;
}

/** 绝对路径是否落在根内（大小写不敏感、分隔符边界判据；纵深复核用）。 */
export function isWithinRoot(rootDir: string, absPath: string): boolean {
  const root = normalizeRoot(rootDir)?.toLowerCase() ?? '';
  if (root === '') return false;
  const abs = normalizeRoot(absPath)?.toLowerCase() ?? '';
  return abs === root || abs.startsWith(`${root}/`);
}

/** 相对路径 → 根内绝对路径：先过同尺路径闸，再 resolve 后复核域（fail-closed 纵深）。 */
export function resolveWithinRoot(rootDir: string, relPath: string): string {
  validateRelativePath(relPath);
  const root = normalizeRoot(rootDir);
  if (root === null) {
    throw new McpFailure('RESOURCE_UNAVAILABLE', '项目未打开：没有可复核的域基准根（fail-closed）');
  }
  const abs = `${root}/${relPath}`;
  if (!isWithinRoot(rootDir, abs)) {
    throw new McpFailure('INVALID_ARGS', `路径越界：解析结果不在项目根内：${sanitizeEcho(relPath)}`);
  }
  return abs;
}

/** 绝对路径 → 项目根内相对路径；根缺席或不为前缀 ⇒ 归一后原样返回（不编造相对路径）。 */
export function toRelativePath(absPath: string, rootDir: string | null): string {
  const text = absPath.replace(/\\/g, '/');
  const root = rootDir === null ? null : normalizeRoot(rootDir);
  if (root === null || text.length <= root.length) return text;
  if (text.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return text;
  if (text[root.length] !== '/') return text;
  return text.slice(root.length + 1);
}

/** 路径恰为项目根本身时投影成 `.`（与 file-tree 的 root 字段同一口径）。 */
export function relativeOrDot(abs: string, rootDir: string): string {
  const rel = toRelativePath(abs, rootDir);
  const root = normalizeRoot(rootDir)?.toLowerCase() ?? '';
  return rel !== '' && rel.toLowerCase() !== root ? rel : '.';
}

/* --------------------------- 写闸一：第四张表 approvedRoots 复核 --------------------------- */

/**
 * 目标相对路径是否落在第四张表（MCP 会话授权 `mcp_approvals.json`）的至少一个
 * `approvedRoots` 内。approvedRoots 是**项目根内相对路径**（Rust `build_scope` 已按
 * `validate_relative_path` 逐根校验）；此处再防御性复验一次——形态不合法的根**跳过**
 * （只可能收窄写域，绝不可能放宽，fail-closed），前缀必须落在分隔符边界上、大小写不敏感
 * （与 `isWithinRoot` 同尺）。
 */
export function isWithinApprovedRoots(approvedRoots: readonly string[], relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').toLowerCase();
  if (rel === '') return false;
  for (const root of approvedRoots) {
    try {
      validateRelativePath(root);
    } catch {
      continue; // 形态不合法的根不参与判定（收窄不减宽，fail-closed）
    }
    const norm = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (norm === '') continue;
    if (rel === norm || rel.startsWith(`${norm}/`)) return true;
  }
  return false;
}

/**
 * 写闸一：第四张表复核。目标不在任何 approvedRoots 内（含会话一个根都没批）⇒
 * `WRITE_DISABLED` 结构化失败。这是第四张表独立授权语义的正确行为，不是缺陷——
 * 它不继承内核 `writablePaths` / `exportFile` / 启动器三张表。
 */
export function assertMcpWriteDomain(approvedRoots: readonly string[], relPath: string): void {
  if (isWithinApprovedRoots(approvedRoots, relPath)) return;
  const rootsNote =
    approvedRoots.length === 0
      ? '本会话没有任何已批准写根（第四张表 approvedRoots 为空）'
      : `已批准根：${approvedRoots.slice(0, 8).map((r) => sanitizeEcho(r)).join('、')}`;
  throw new McpFailure(
    'WRITE_DISABLED',
    `MCP 写被禁用（写闸一：第四张表 approvedRoots 未覆盖目标 ${sanitizeEcho(relPath)}；${rootsNote}）。` +
      'MCP 会话授权独立签发，不继承其它三张表；请宿主在 AI 接入面板复核该会话的批准根。',
  );
}

/**
 * 写闸二的拒绝翻译：内核 `io` 写原语抛 `WriteNotAllowedError`（writablePaths +
 * 常驻可写根未覆盖，游戏目录整体只读）⇒ 显式 `WRITE_DISABLED`；McpFailure 原样透出；
 * 其余执行失败原样上抛（registry 兜底包成 TOOL_EXECUTION_FAILED，不洗码、不静默）。
 * 恒不返回（`never`）：调用点据此通过定赋值分析。
 */
function rethrowWriteGate(err: unknown, relPath: string): never {
  if (err instanceof McpFailure) throw err;
  if (err instanceof Error && err.name === 'WriteNotAllowedError') {
    throw new McpFailure(
      'WRITE_DISABLED',
      `MCP 写被禁用（写闸二：内核写允许域拒绝——游戏目录整体只读，写仅限用户批准的写允许域）。` +
        `目标：${sanitizeEcho(relPath)}；内核原话：${err.message}`,
    );
  }
  throw err;
}

/**
 * 写成功后尽力广播内核既有 `file.changed`（宿主刷新既有通道，App.tsx 同款）；缺席/失败如实回报。
 * `kind` 沿用 `@kojo/plugin-api` 的 `FileChangeKind`：新建 / 改名落点用 `'add'`、内容改写用
 * `'change'`、删除 / 改名源用 `'unlink'`（additive 扩 kind，旧 `'add' | 'change'` 调用方零改动）。
 *
 * Wave4 余项 ③：广播**之前**先向失效判定器记一笔自写（同一调用栈 ⇒ 归因精确，
 * 紧随其后的监视回声会被并成同一条事实而不是第二次改动）。**只记账，不改写腿语义**：
 * `refreshed` 的取值仍只由广播成功与否决定，判定器缺席 / 抛错都不影响落盘与回执形状。
 */
function emitFileChanged(
  kernel: McpKernelLike,
  kind: 'add' | 'change' | 'unlink',
  absPath: string,
  freshness?: { readonly tracker: FsFreshnessTracker | null; readonly scope: McpSessionScope | null | undefined },
): boolean {
  if (freshness?.tracker) {
    try {
      freshness.tracker.noteSelfWrite({ abs: absPath, kind, scope: freshness.scope });
    } catch {
      /* 自写记账失败不改变写结果：判定器自身会在应答里如实标出账未接上 */
    }
  }
  const emit = kernel.bus.emit;
  if (typeof emit !== 'function') return false;
  try {
    emit.call(kernel.bus, 'file.changed', { kind, path: absPath });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------- 失效标注（只读应答附加） ------------------------------- */

function trackerOf(deps: McpIoDeps): FsFreshnessTracker | null {
  try {
    return deps.fsFreshness?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * 单文件读取的失效标注（B13：读时复核版）：判定器在场就走
 * `verdictOfRechecked`——窗内自写回声命中时多核一趟盘态，**本次读数即定档**
 * （复核证明没变 ⇒ `stale:false` + `recheck.basis:'mtime-recheck'`；核出真实外部写 ⇒
 * `stale:true`；复核做不了 ⇒ `stale:null` + 理由，绝不乐观 false）。
 * 窗外 / 没命中 ⇒ 与同步档同判据且**零额外 syscall**（复核只在命中时发，见 buildSettled
 * 的 `union.size > 0` 闸）。缺席也**照样给字段**，值为 `stale:null` + 理由——
 * 客户端永远能区分「判定器没装」与「没改过」。
 */
async function fsFreshnessField(
  deps: McpIoDeps,
  abs: string,
  rel: string,
  scope: McpSessionScope | null | undefined,
): Promise<Record<string, unknown>> {
  if (abs === '') return fsFreshnessNoBasePayload(rel, 'file');
  const tracker = trackerOf(deps);
  if (!tracker) return fsFreshnessAbsentPayload(rel, 'file');
  try {
    return fsFreshnessPayload(await tracker.verdictOfRechecked({ abs, rel, scope }));
  } catch (err) {
    return fsFreshnessRecheckFailedPayload(rel, 'file', err);
  }
}

/**
 * 批量单文件标注（B13 判据 2）：`fs.statFiles`（≤200）与 `fs.readMany`（≤64）的逐条
 * 标注**只付一趟** `verdictsOfRechecked`——窗内命中 N 条也并进同一趟 `statFiles`
 * （fs-freshness.ts 的 buildSettled 全局候选集去重）。注入面只有 `stat` 没有 `statFiles`
 * 时该趟退化为逐条单路径 stat（口径由 fs-freshness 侧如实投影在 recheck.trips），本层
 * 不假装一趟。无基准（abs 空串）的条目不送复核、逐条如实 noBase；复核调用本身抛错 ⇒
 * 全体 `stale:null` + 理由（不乐观 false）。
 */
async function fsFreshnessFields(
  deps: McpIoDeps,
  targets: readonly { readonly abs: string; readonly rel: string }[],
  scope: McpSessionScope | null | undefined,
): Promise<Record<string, unknown>[]> {
  if (targets.length === 0) return [];
  const tracker = trackerOf(deps);
  if (!tracker) return targets.map((t) => fsFreshnessAbsentPayload(t.rel, 'file'));
  const indexes: number[] = [];
  const inputs: { abs: string; rel: string; scope: McpSessionScope | null | undefined }[] = [];
  targets.forEach((t, i) => {
    if (t.abs === '') return; // 无基准条目不进复核账（下面逐条 noBase 如实给）
    indexes.push(i);
    inputs.push({ abs: t.abs, rel: t.rel, scope });
  });
  const out: (Record<string, unknown> | undefined)[] = new Array<Record<string, unknown>>(targets.length);
  targets.forEach((t, i) => {
    if (t.abs === '') out[i] = fsFreshnessNoBasePayload(t.rel, 'file');
  });
  try {
    const verdicts = await tracker.verdictsOfRechecked(inputs);
    indexes.forEach((itemIndex, k) => {
      const verdict = verdicts[k];
      out[itemIndex] =
        verdict !== undefined
          ? fsFreshnessPayload(verdict)
          : fsFreshnessRecheckFailedPayload(targets[itemIndex]!.rel, 'file', '批量复核返回条数与入参不等');
    });
  } catch (err) {
    indexes.forEach((itemIndex) => {
      out[itemIndex] = fsFreshnessRecheckFailedPayload(targets[itemIndex]!.rel, 'file', err);
    });
  }
  return out.map((v, i) => v ?? fsFreshnessRecheckFailedPayload(targets[i]!.rel, 'file', '批量复核未给出该条标注'));
}

/** 复核调用抛错 / 形状不对时的兜底档：null + 理由，绝不冒充 false（与单条 catch 同口径）。 */
function fsFreshnessRecheckFailedPayload(
  target: string,
  granularity: 'file' | 'listing',
  err: unknown,
): Record<string, unknown> {
  return {
    available: false,
    stale: null,
    staleReason: `失效判定器调用失败（${err instanceof Error ? err.message : String(err)}）：无法判定，不冒充 false`,
    target,
    granularity,
  };
}

/** 目录 / 检索级标注：覆盖期内该目录下任何路径被动过即 `stale:true`（B13：读时复核版，窗内命中本次定档）。 */
async function fsFreshnessListing(
  deps: McpIoDeps,
  dirAbs: string,
  dirRel: string,
  scope: McpSessionScope | null | undefined,
): Promise<Record<string, unknown>> {
  if (dirAbs === '') return fsFreshnessNoBasePayload(dirRel, 'listing');
  const tracker = trackerOf(deps);
  if (!tracker) return fsFreshnessAbsentPayload(dirRel, 'listing');
  try {
    return fsFreshnessPayload(await tracker.listingOfRechecked({ dirAbs, dirRel, scope }));
  } catch (err) {
    return fsFreshnessRecheckFailedPayload(dirRel, 'listing', err);
  }
}

/** 无基准根（项目未开 / 载荷缺 rootDir）：判定不可做，如实标注而不是给个 false。 */
function fsFreshnessNoBasePayload(target: string, granularity: 'file' | 'listing'): Record<string, unknown> {
  return {
    available: false,
    stale: null,
    staleReason: '没有可判定的绝对路径基准（项目未打开或载荷缺 rootDir）：失效判定无从谈起（不静默）',
    target,
    granularity,
  };
}

/* ------------------------------- 通用小件 ------------------------------- */

/**
 * 文本面单页上限（字符）。**这是闸，不是便利**：Rust 转发任何不可信字符串时按
 * `mcp::protocol::MAX_UNTRUSTED_CHARS = 64 * 1024` 再切一刀（超长直接 `…[truncated]`）。
 * 旧 `maxChars` 允许到 200_000，意思是「JS 报完完整性账、Rust 再悄悄截」——账面必假。
 * 把单页压在闸下，JS 说的就是客户端收到的，「逐页拼接 == 全文」才成立。
 * 65_000 < 65_536 留出的余量覆盖净化器追加的标记长度。
 */
export const MCP_PAGE_TEXT_MAX_CHARS = 65_000;
/** 文本面单页默认长度（＝旧 `fs.readFile` 的默认 maxChars，零参调用行为逐字不变）。 */
export const MCP_PAGE_TEXT_DEFAULT_CHARS = 24_000;

/**
 * 行区间面单批行数硬上限（MCP-PERF-S4，`fs.readRange`）：窗再大也只给 2000 行，
 * 截尾如实 truncated + hasMore（不是报错）。2000 行 × 行宽与 24_000 字符的文本默认页
 * 同一量级，宿主不可信串闸内绰绰有余；续取＝startLine 接着上一窗的 endLine+1，无需游标。
 */
export const MCP_READ_RANGE_MAX_LINES = 2_000;
/** 全项目函数清单单页默认条数（与语义列举面 SYMBOL_LIMIT=200 同尺，不放宽既有列举档）。 */
export const MCP_PROJECT_SYMBOLS_DEFAULT_LIMIT = 200;
/** 全项目函数清单单页上限（10 万级名录按 1000 条/页 ≈ 十几帧翻完，单页体积仍在响应闸下）。 */
export const MCP_PROJECT_SYMBOLS_MAX_LIMIT = 1_000;

export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(Math.max(min, n), max);
}

export function truncateChars(text: string, cap: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

/** 无项目时统一口径：数据源此刻接不到 ⇒ RESOURCE_UNAVAILABLE（不伪造读数）。 */
export function requireProject(kernel: McpKernelLike | null): Record<string, unknown> {
  if (!kernel) {
    throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：项目数据源不可用（不静默）');
  }
  const current = kernel.project.current();
  if (!current || typeof current !== 'object') {
    throw new McpFailure('RESOURCE_UNAVAILABLE', '项目未打开：该读数需要已打开的项目（不静默、不空串冒充）');
  }
  return current as Record<string, unknown>;
}

/** GameProject → 对外摘要（只取通用契约字段；KOJO 目录/适配器 id 是契约面，非编造）。 */
export function projectSummaryOf(raw: unknown): Record<string, unknown> {
  const o = raw as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    rootDir: o['rootDir'],
    adapterId: o['adapterId'],
    kojoPaths: Array.isArray(o['kojoPaths']) ? o['kojoPaths'] : [],
  };
  if (Array.isArray(o['libraryPaths'])) summary['libraryPaths'] = o['libraryPaths'];
  if (typeof o['gameVersion'] === 'string') summary['gameVersion'] = o['gameVersion'];
  const charaIndex = o['charaIndex'];
  summary['charaCount'] =
    charaIndex instanceof Map ? charaIndex.size : Array.isArray(charaIndex) ? charaIndex.length : 0;
  return summary;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** 项目载荷 → 基准根字符串（空串 = 没有根；调用方须显式失败，绝不猜基准根）。 */
export function rootDirOf(project: Record<string, unknown>): string {
  return asString(project['rootDir']);
}

/**
 * 检索根集合：`sourcesOnly` ⇒ 用 adapter 填进契约的作品域目录（`kojoPaths`，字段投影，
 * 本模块不认识任何领域名词）；否则项目根。非字符串 / 空串逐项剔除（不把脏根送到壳层）。
 * **可能返回空数组**（给了 sources 但 kojoPaths 形态不合法）：调用方自己判——
 * 一次性检索按既有语义照发，任务面则显式拒绝（不建没有根可扫的「在跑」任务）。
 */
export function searchRootsOf(
  project: Record<string, unknown>,
  rootDir: string,
  sourcesOnly: boolean,
): string[] {
  if (sourcesOnly && Array.isArray(project['kojoPaths']) && (project['kojoPaths'] as unknown[]).length > 0) {
    return (project['kojoPaths'] as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '');
  }
  return [rootDir];
}

/* ------------------------------- 检索腿分页（引擎封顶口径） ------------------------------- */

/** 与 Rust `lib.rs` 的 `SEARCH_HARD_CAP` 同尺：引擎一次最多回 5000 条命中（闸，本批不放宽）。 */
const SEARCH_ENGINE_HARD_CAP = 5000;
/**
 * 与 Rust `lib.rs` 的 `SEARCH_PER_FILE_CAP` 同尺：引擎对**单个文件**一次最多回 500 条命中
 * （B18 的逐段续取把它当段长；这一格闸本批同样一字未动）。
 * 只在这里出现一次，由注入递给分片腿——TS 侧不许长出第二份抄本（抄本会漂）。
 */
const SEARCH_ENGINE_PER_FILE_CAP = 500;


/**
 * 检索命中列表的游标分页。
 *
 * 与列举面的区别：**全量拿不到**（引擎自己在 5000 条处封顶，且 `totalMatches` 只统计已收到的）。
 * 因此这里用「**已消费前缀指纹**」而不是全量指纹：游标里带的是「前 offset 条命中的 key 哈希」，
 * 下次取页时引擎窗口头部若与已消费前缀一致 ⇒ 拼接可自证无重无漏；不一致 ⇒ 显式
 * `changedDuringPaging` 并从 0 重来。触到引擎硬墙时**绝不假称能续**：
 * `hasMore:false` + `engineWallReached:true` + `knownTotal:false`，并把「缩小查询 / 改用
 * fs.readFile 分页」写进 note——这正是「不知道就承认」的口径。
 */
function pageSearchHits(
  allHits: readonly Record<string, unknown>[],
  args: Record<string, unknown>,
  limit: number,
  offset: number,
  engine: { readonly totalMatches: number; readonly truncated: boolean },
): Record<string, unknown> {
  const keyOf = (h: Record<string, unknown>): string => `${String(h['path'] ?? '')}|${String(h['line'] ?? '')}|${String(h['preview'] ?? '')}`;
  const decoded = decodePageCursor(args['cursor']);
  let start = offset;
  let changedDuringPaging = false;
  if (decoded) {
    start = Math.min(Math.max(0, decoded.index), allHits.length);
    changedDuringPaging = pageFingerprint(allHits.slice(0, start).map(keyOf)) !== decoded.fingerprint;
    if (changedDuringPaging) start = 0;
  } else {
    start = Math.min(Math.max(0, start), allHits.length);
  }
  const page = allHits.slice(start, start + limit);
  const next = start + page.length;
  const engineWallReached = engine.truncated || next >= SEARCH_ENGINE_HARD_CAP;
  const hasMore = next < allHits.length ? true : !engineWallReached && next < engine.totalMatches;
  return {
    hits: page,
    total: engine.totalMatches,
    knownTotal: !engine.truncated,
    truncated: engine.truncated || page.length < allHits.length || next < engine.totalMatches,
    offset: start,
    limit,
    hasMore,
    nextCursor: hasMore ? encodePageCursor(pageFingerprint(allHits.slice(0, next).map(keyOf)), next) : null,
    ...(changedDuringPaging ? { changedDuringPaging: true } : {}),
    ...(engineWallReached
      ? {
          engineWallReached: true,
          note: `检索引擎单次封顶 ${SEARCH_ENGINE_HARD_CAP} 条命中：超出部分无法用本游标续取。请缩小 query / 收窄 scope，或逐文件用 fs.readFile 分页读全文（该面拼接可自证完整）。`,
        }
      : {}),
  };
}

/** 本腿取多少条引擎命中：`offset + limit`（夹到引擎硬墙，不放宽）。 */
function searchWindow(offset: number, limit: number): number {
  return Math.min(SEARCH_ENGINE_HARD_CAP, Math.max(1, offset + limit));
}

/**
 * 检索墙的分片续取腿（B16 批，LaneZ 2026-11-06）：**只在 `resumeBySlice:true` 时接管**。
 * 每片都是一次既有 `search_text` 调用 ⇒ 零新 Rust 命令；窗口逐字复用上面那条
 * `searchWindow`（闸不放宽）。缺省（不给这个入参）走下面的旧路，一行行为都没变——
 * 旧面 `search.all` / `workspace.searchAll` / `tasks.start(kind:search)` 的既有语义
 * （含触墙时 `hasMore:false` + `engineWallReached` + note 那一套）零回退。
 * 判性与实测账目见 `search-slice-leg.ts` 模块头 + Rust 侧 `search_tests.rs` 的 `wall_*` 用例。
 */
function createSliceRunner(deps: McpIoDeps) {
  return createSearchSliceRunner({
    getKernel: deps.getKernel,
    requireProject,
    searchRootsOf,
    searchInFiles: deps.searchInFiles,
    nextSearchId,
    toRelativePath,
    searchWindow,
    engineCap: SEARCH_ENGINE_HARD_CAP,
    perFileCap: SEARCH_ENGINE_PER_FILE_CAP,
  });
}

/** 分片续取的开关（可选新入参；非 true 一律按旧路走，不留别名）。 */
function wantsSliceResume(args: Record<string, unknown> | undefined): boolean {
  return args?.['resumeBySlice'] === true;
}

/* ----------------- MCP-PERF-S8（LaneR，2026-11-07）三腿 additive 入参闸 ----------------- */

/** 两枚检索面 `deadlineMs` 的上限（毫秒；正整数 ≤ 2 分钟，闸值与 BOARD 卡逐字同尺）。 */
export const MCP_SEARCH_DEADLINE_MS_MAX = 120_000;

/**
 * 腿1（S8）：软时限入参闸。缺省（undefined）= 无时限 ⇒ 请求体与旧面逐字同形（S1 的
 * Rust DTO `deadline_ms: Option<u64>` 同义）；其余形状一律显式 INVALID_ARGS——越界
 * **不夹取**（夹取会把「agent 要的预算」静默换成另一个预算，账面必假），与
 * `editor.openDocument` 的 `deadlineOf` 同一纪律。
 */
function searchDeadlineMsOf(args: Record<string, unknown>, face: string): number | undefined {
  const raw = args['deadlineMs'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MCP_SEARCH_DEADLINE_MS_MAX) {
    throw new McpFailure(
      'INVALID_ARGS',
      `${face} 的 deadlineMs 须为 1..${MCP_SEARCH_DEADLINE_MS_MAX} 的整数（毫秒软时限；收到 ` +
        `${JSON.stringify(raw)}）：越界不夹取，脏值不静默回落「无时限」。`,
    );
  }
  return raw;
}

/**
 * 腿2（S8）：命中载荷模式。缺省 full = 逐字旧形态；"none" ⇒ 投影层剥 preview 字段
 * （`stripPreviewFields`），命中账（total/游标/指纹/knownTotal）在剥字段**之前**已按
 * 全量命中算好 ⇒ 与 full 逐位一致、游标跨模式互认。枚举外脏值显式拒收，不静默当 full。
 */
function searchPreviewModeOf(args: Record<string, unknown>, face: string): 'full' | 'none' {
  const raw = args['preview'];
  if (raw === undefined) return 'full';
  if (raw !== 'full' && raw !== 'none') {
    throw new McpFailure(
      'INVALID_ARGS',
      `${face} 的 preview 只收 "full" | "none"（缺省 full；"none" = 投影层剥每条命中的 ` +
        `preview 字段省 token；收到 ${JSON.stringify(raw)}）：脏值不静默当 full。`,
    );
  }
  return raw;
}

/** preview:"none" 的投影腿：浅拷贝剥 preview 一格；其余字段（含未来 additive 字段）原样保留。 */
function stripPreviewFields(hits: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return hits.map((h) => {
    const out = { ...h };
    delete out['preview'];
    return out;
  });
}

/**
 * 腿1 的组合闸：`deadlineMs` 与 `resumeBySlice:true` 不同收——分片路每片是一次独立
 * `search_text` 调用，软时限账（partial/partialReason）只在一次性路收口；静默丢掉时限
 * 就是铁律 4 那一刀，显式拒收点名二选一。
 */
function assertDeadlineNotWithSlice(
  args: Record<string, unknown>,
  face: string,
  deadlineMs: number | undefined,
): void {
  if (deadlineMs !== undefined && wantsSliceResume(args)) {
    throw new McpFailure(
      'INVALID_ARGS',
      `${face} 的 deadlineMs 与 resumeBySlice:true 不同收：分片路每片是一次独立 search_text 调用，` +
        '软时限账（partial/partialReason）只在一次性路收口。二选一：要时限请走一次性窗，要分片续取就别带时限。',
    );
  }
}

/**
 * 腿3（S8）：`semantic.projectSymbols` 的 query 过滤 needle——**次序无关子串**（照 B11 的
 * Damerau-Levenshtein 0.34 形态二选一，选子串的理由：ERB 函数名碎片普遍 3..8 字符，
 * 绝对编辑距离 ≤2 在这个长度段近乎任意匹配、归一化 0.34 又是给长 camelCase 键名手误
 * 调教的，搬来过滤短符号名＝子串加噪声；子串判性一目了然、零分配、结果 ⊆ 全量且序稳定）。
 * 空白切 token、预折大写（归一化名就是 byName 键的大写形态）⇒ 逐条 `includes` 零分配。
 * 空 / 缺席 = [] = 全量零行为变化；脏类型显式拒收。
 */
function symbolQueryNeedlesOf(args: Record<string, unknown>): readonly string[] {
  const raw = args['query'];
  if (raw === undefined) return [];
  if (typeof raw !== 'string') {
    throw new McpFailure(
      'INVALID_ARGS',
      `semantic.projectSymbols 的 query 须为字符串（次序无关子串过滤；收到 ${JSON.stringify(raw)}）：` +
        '脏类型不静默当全量。',
    );
  }
  return raw
    .split(/\s+/)
    .filter((t) => t !== '')
    .map((t) => t.toUpperCase());
}

/* ------------------------------- kernelIo 3 腿 ------------------------------- */

let searchSeq = 0;

/**
 * 壳层检索请求的发号器（与 `bridge/search` 的 `searchId` 同一口径）。
 * 内联检索与长任务面**共用这一条序列**：进度帧与取消都按 `searchId` 认领，
 * 两条路各自发号会撞号 ⇒ 迟到帧/取消会串到别人的任务上。
 */
export function nextSearchId(): number {
  searchSeq += 1;
  return searchSeq;
}

export function createKernelIo(deps: McpIoDeps): McpKernelIo {
  const projectInfo: McpReaderFn = async () => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    return projectSummaryOf(project);
  };

  const fileTree: McpReaderFn = async (args, scope) => {
    const kernel = deps.getKernel();
    if (!kernel) {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：文件树数据源不可用（不静默）');
    }
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：文件树无基准根（不静默）');
    }
    const maxDepth = clampInt((args ?? {})['maxDepth'], 6, 0, 16);
    const raw = (await kernel.io.walkDir(rootDir, {
      maxDepth,
      includeFiles: true,
      includeDirs: true,
    })) as unknown[];
    // 分页游标批：先投影**全量**合法条目，再按 limit+cursor 取页（旧行为是 slice(0,cap)，
    // 尾部永不可达）。稳定 key＝根内相对路径（walkDir 返回的 path 逐条唯一）。
    const allEntries: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      const path = asString(e['path']);
      if (path === '') continue;
      allEntries.push({
        path: toRelativePath(path, rootDir),
        name: asString(e['name']),
        isDirectory: e['isDirectory'] === true,
      });
    }
    const p = paginateByCursor(allEntries, (e) => String(e['path']), args ?? {}, {
      defaultLimit: 500,
      maxLimit: 5000,
    });
    return {
      root: '.',
      maxDepth,
      entries: p.page,
      total: p.total,
      truncated: p.truncated,
      offset: p.offset,
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      fingerprint: p.fingerprint,
      ...(p.changedDuringPaging === true ? { changedDuringPaging: true } : {}),
      ...(raw.length !== allEntries.length
        ? { sourceCount: raw.length, droppedUnparsable: raw.length - allEntries.length }
        : {}),
      // 目录级失效标注（工具 projectFileTree 与 resource kojo://project/file-tree 同源同标注）。
      fsFreshness: await fsFreshnessListing(deps, rootDir, '.', scope),
    };
  };

  const searchAll: McpReaderFn = async (args, scope) => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：检索无基准根（不静默）');
    }
    const query = (args ?? {})['query'];
    if (typeof query !== 'string' || query.length === 0) {
      throw new McpFailure('INVALID_ARGS', 'searchAll 的 query 须为非空字符串');
    }
    // S8 腿1/腿2：软时限与命中载荷模式（都可省；缺省 = 旧请求体逐字同形、应答零漂移）
    const deadlineMs = searchDeadlineMsOf(args ?? {}, 'search.all');
    const previewMode = searchPreviewModeOf(args ?? {}, 'search.all');
    assertDeadlineNotWithSlice(args ?? {}, 'search.all', deadlineMs);
    const page = pageParamsFor(args ?? {}, { defaultLimit: 50, maxLimit: 200 });
    if (wantsSliceResume(args)) {
      // B16：闸下命中不可续（实测），给了 resumeBySlice 才走分片路；不给 ⇒ 下面旧路逐字不变
      const res = await createSliceRunner(deps)({
        args: args ?? {},
        query,
        project,
        rootDir,
        sourcesOnly: false,
        limit: page.limit,
        offset: page.offset,
        hasCursor: page.hasCursor,
        // 与旧路同一枚 await 口径（fsFreshnessListing 是 async：不 await 会把 Promise 塞进返回体）
        fsFreshness: await fsFreshnessListing(deps, rootDir, '.', scope),
      });
      // S8 腿2：分片路同样在投影层剥 preview——账在 runner 内部按全量命中算好 ⇒ 与 full 逐位一致
      return previewMode === 'none'
        ? { ...res, hits: stripPreviewFields((res['hits'] as Record<string, unknown>[]) ?? []) }
        : res;
    }
    const result = await deps.searchInFiles({
      searchId: nextSearchId(),
      roots: [rootDir],
      query,
      options: {
        isRegex: false,
        caseSensitive: false,
        wholeWord: false,
        extensions: [],
        maxResults: searchWindow(page.offset, page.limit),
        // S8 腿1：缺省不带键（旧请求体逐字同形）；给了才带（S1 的 Rust DTO / bridge 类型已在）
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      },
    });
    const hits: Record<string, unknown>[] = [];
    for (const file of result.files) {
      for (const match of file.matches) {
        hits.push({ path: toRelativePath(file.path, rootDir), line: match.line, preview: match.preview });
      }
    }
    const account = pageSearchHits(hits, args ?? {}, page.limit, page.offset, {
      totalMatches: result.totalMatches,
      truncated: result.truncated,
    });
    return {
      ...account,
      // S8 腿2："none" ⇒ 投影层剥 preview（账已按全量命中算好，与 full 逐位一致、游标跨模式互认）
      ...(previewMode === 'none' ? { hits: stripPreviewFields((account['hits'] as Record<string, unknown>[]) ?? []) } : {}),
      filesScanned: result.filesScanned,
      elapsedMs: result.elapsedMs,
      skipped: result.skipped,
      // S8 腿1：软时限账透传（S1 语义，不重造）。引擎没报 partial ⇒ 应答不带这个键（旧宿主零漂移）。
      ...(result.partial === true
        ? {
            partial: true,
            ...(typeof result.partialReason === 'string' && result.partialReason !== ''
              ? { partialReason: result.partialReason }
              : {}),
          }
        : {}),
      // 检索结果是从盘上现算的：这里说「自你上一次从本根检索以来，根下动过几处」。
      fsFreshness: await fsFreshnessListing(deps, rootDir, '.', scope),
    };
  };

  return { projectInfo, fileTree, searchAll };
}

/* ------------------------------- runSupplemental（IO 腿 + 写腿） ------------------------------- */

/**
 * 只读 IO 腿 + 写腿（fileTree.create / update / remove / rename）。写腿一律走**编辑器既有
 * 写通道**（内核 `kernel.io` 的 FileIO 写原语；删 / 改名也走此，绝不 `deps.invoke` 直调 Rust
 * 写命令绕开内核写允许域），前面叠第四张表 approvedRoots 复核（见模块头注释），绝不新建旁路
 * 写通道。`problems.quickFix` 自 2026-11-06 起已真接线（稳定 actionId 台账 + 宿主受控 apply
 * 通道，端到端见 `mcp-quickfix-apply.test.ts`）；暂无真源的（diff.compare / state.replay /
 * preview.document）由
 * default 分支显式报 `NOT_WIRED`——不擅自开放执行、不造假实现。
 * B3 批（LaneO 2026-11-06）另登记 `editor.*` 五枚：它们改的是 **Monaco 模型 / 编辑器状态**，
 * 不经 `kernel.io`、不碰磁盘，因此不落入上面这条「写腿一律走编辑器既有写通道」的闸——
 * 落盘仍只有 `fileTree.update` 双闸与 `exportFile` 对话框两条法定路（铁律 5/6/7 零新增写盘通道）。
 */
export function createRunSupplemental(deps: McpIoDeps): (
  name: string,
  args: Record<string, unknown>,
  scope: McpSessionScope,
) => Promise<unknown> {
  const commandsList: McpReaderFn = (args) => {
    const a = args ?? {};
    const all = deps.getCommands();
    // 分页游标批：稳定 key＝命令 id（重复 id 用下标兜底，保证 key 唯一 ⇒ 游标定位不歧义）。
    const seen = new Map<string, number>();
    const p = paginateByCursor(all, (c, i) => {
      const base = c.id !== '' ? c.id : `#${i}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}#${n}`;
    }, a, { defaultLimit: 200, maxLimit: 500 });
    const commands = p.page.map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.tier !== undefined ? { tier: c.tier } : {}),
    }));
    return {
      commands,
      total: p.total,
      truncated: p.truncated,
      offset: p.offset,
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      fingerprint: p.fingerprint,
      ...(p.changedDuringPaging === true ? { changedDuringPaging: true } : {}),
    };
  };

  const readFile = async (
    args: Record<string, unknown>,
    scope: McpSessionScope | null | undefined,
  ): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：读文件无域基准根（不静默）');
    }
    const abs = resolveWithinRoot(rootDir, asString(args['relPath']));
    const rel = toRelativePath(abs, rootDir);
    const text = await deps.invoke('read_file_bytes', { path: abs });
    if (typeof text !== 'string') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'read_file_bytes 未返回文本（不静默）');
    }
    // 分页游标批：offset/length（+ maxChars 旧别名）→ 窗口；游标自带快照指纹，
    // 文件在翻页之间被改就显式 changedDuringPaging + 从头部重发，绝不盲切旧偏移。
    const p = paginateText(text, args, {
      defaultLimit: MCP_PAGE_TEXT_DEFAULT_CHARS,
      maxLimit: MCP_PAGE_TEXT_MAX_CHARS,
    });
    return {
      path: rel,
      text: p.page,
      textLength: p.total,
      truncated: p.truncated,
      offset: p.offset,
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      fingerprint: p.fingerprint,
      ...(p.changedDuringPaging === true
        ? {
            changedDuringPaging: true,
            note: '文件在两次取页之间被改过：本页是新快照的第 0 页，不可与旧页拼接（旧行为会静默错位）。',
          }
        : {}),
      // Wave4 ③：本次给的是 `atMs` 这一刻的盘态；`stale` 说的是「你上一次从本宿主读到的那份」
      // 之后盘上是否又被动过（真源 = 监视回执 + file.changed 短账，判不了即 null + 理由）。
      // B13：读时复核版——自写回声窗内命中时本次读数即定档（复核做不了仍如实 null）。
      fsFreshness: await fsFreshnessField(deps, abs, rel, scope),
    };
  };

  /* ---- MCP-PERF-S4（LaneK，2026-11-07）：fs.readRange 腿（行区间读）----
   * TRAE 性能分析 P1「范围读必须先有，否则 agent 只能整文件读 5 万行」。判据：
   *  - 行号 1 基、闭区间，与 Monaco position 同口径；行切分 CRLF/LF/CR（行尾换行
   *    ⇒ 末行空串，与编辑器行数一致）；行号→内容走 fs.readFile 同一条 read_file_bytes。
   *  - 路径闸与 fs.readFile 同一条 resolveWithinRoot；可选 rootId 与写腿同一条
   *    resolveWriteRoot 三道拦截（缺席 ⇒ 项目根零额外 IPC）。
   *  - 越界与 start>end 照 paginateText 既有语义：越界夹取进 [1, totalLines] 且夹取
   *    经 truncated + requested 可见；start>end INVALID_ARGS 点名双字段。单批 2000 行
   *    硬上限（超限夹取截尾，不是报错）——不发明新账。
   */
  const readRange = async (
    args: Record<string, unknown>,
    scope: McpSessionScope | null | undefined,
  ): Promise<unknown> => {
    // 可选 rootId：与写腿同一条三道拦截（形状 / 第四张表精确列名 / workspace_roots 反查）；
    // 缺席原路返回项目根，一次 IPC 都不多发。relPath 永远相对「选出来的那颗根」解析。
    const { rootDir, rootId } = await resolveWriteRoot(args, scope as McpSessionScope);
    const abs = resolveWithinRoot(rootDir, asString(args['relPath']));
    const rel = toRelativePath(abs, rootDir);
    const text = await deps.invoke('read_file_bytes', { path: abs });
    if (typeof text !== 'string') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'read_file_bytes 未返回文本（不静默）');
    }
    const startRaw = args['startLine'];
    const endRaw = args['endLine'];
    const isLineNo = (v: unknown): v is number =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1;
    if (!isLineNo(startRaw) || !isLineNo(endRaw)) {
      throw new McpFailure(
        'INVALID_ARGS',
        `fs.readRange 的 startLine / endLine 须为 1 基整数（与 Monaco position 同口径，0 基被拒）：` +
          `startLine=${sanitizeEcho(String(startRaw))}, endLine=${sanitizeEcho(String(endRaw))}`,
      );
    }
    if (startRaw > endRaw) {
      throw new McpFailure(
        'INVALID_ARGS',
        `fs.readRange 的 startLine (${startRaw}) 大于 endLine (${endRaw})：区间为空。` +
          '两界都是 1 基闭区间行号；越界交由夹取处理（truncated 可见），方向反了才报错。',
      );
    }
    // 行切分与编辑器同口径：CRLF / LF / CR 都算一次换行；行尾换行 ⇒ 末行空串
    // （'' 也切出 1 行——空文件在编辑器里就是 1 行，不编造 0 行）。
    const lines = text.split(/\r\n|\r|\n/);
    const totalLines = lines.length;
    const requested = { startLine: startRaw, endLine: endRaw };
    // 越界夹取（paginateText 裸窗口语义）：夹进 [1, totalLines]，夹取经 truncated + requested 可见。
    const start = Math.min(Math.max(1, startRaw), totalLines);
    const endWanted = Math.min(Math.max(1, endRaw), totalLines);
    // 单批行数硬上限：窗再大也只给 2000 行（响应体积闸留死余量），截尾如实 truncated + hasMore。
    const end = Math.min(endWanted, start + MCP_READ_RANGE_MAX_LINES - 1);
    const rows: Record<string, unknown>[] = [];
    for (let line = start; line <= end; line += 1) {
      rows.push({ line, text: lines[line - 1] ?? '' });
    }
    const truncated = startRaw !== start || endRaw !== end;
    return {
      path: rel,
      ...(rootId !== null ? { rootId } : {}), // 诚实标明本次读的是哪个域基准根
      lines: rows,
      startLine: start,
      endLine: end,
      requested, // 夹取可见：原始请求原样回显（铁律 4：少给了就说少给了）
      totalLines,
      lineCount: rows.length,
      truncated,
      hasMore: end < totalLines,
      maxLinesPerCall: MCP_READ_RANGE_MAX_LINES,
      fsFreshness: await fsFreshnessField(deps, abs, rel, scope),
    };
  };

  /* ---- MCP-PERF-S4（LaneK，2026-11-07）：semantic.projectSymbols 腿（全项目函数清单）----
   * 走 erb-parser 既有 byName 索引（ErbFunctionLookup.forEachDef，逐定义回调不建组数组），
   * paginateByCursor 分页。侦察结论：semantic.documentSymbols 的腿依赖 requireWorkspace +
   * documentSymbolProvider（打开的编辑器）⇒ 抬不成 project 范围；本面直连
   * kernel.services.tryGet('erb.parser')（currentIndex()/ensureIndex()，与宿主
   * editor-global-providers 的软取同一条键）——结构类型投影，零插件 import，
   * 不给开机静态图加边（ps10 纪律）。服务缺席 ⇒ NOT_WIRED 点名；服务在而索引未就绪
   * ⇒ RESOURCE_UNAVAILABLE，绝不冒充空清单。
   */
  const projectSymbols = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：函数清单无域基准根（不静默）');
    }
    const parser = (kernel ?? (undefined as unknown as McpKernelLike)).services.tryGet<ErbParserServiceLike>('erb.parser');
    if (!parser || typeof parser.currentIndex !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        'semantic.projectSymbols 未接线：内核里没有 erb.parser 索引服务（插件未装配 / 未启用）——不静默、不伪造空清单',
      );
    }
    let index = (parser.currentIndex() ?? null) as ErbIndexLike | null;
    if (!index && typeof parser.ensureIndex === 'function') {
      // 索引还没产出（刚开项目 / 首次调用）：跟宿主 use-project-session 同一条 ensureIndex
      // 语义——在途构建直接共享，没起跑才起跑。取不到仍显式失败，不空表冒充。
      index = ((await parser.ensureIndex()) ?? null) as ErbIndexLike | null;
    }
    if (!index || typeof index.byName?.forEachDef !== 'function') {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        'ERB 索引未就绪（无项目打开或构建尚未产出索引）——不伪造空清单，请稍后重试',
      );
    }
    const state = typeof parser.indexState === 'function' ? parser.indexState() : null;
    // S8 腿3：query 过滤 needle（空 / 缺席 = [] = 全量零行为变化）。走 byName 键过滤
    // **不重扫**：只是把不匹配的定义不收进页清单，索引遍历与脏行口径原样不动。
    const needles = symbolQueryNeedlesOf(args ?? {});
    const items: Record<string, unknown>[] = [];
    index.byName.forEachDef((ref, normalizedName) => {
      const filePath = typeof ref['filePath'] === 'string' ? ref['filePath'] : '';
      const name = typeof ref['name'] === 'string' ? ref['name'] : '';
      const startLine = typeof ref['startLine'] === 'number' ? ref['startLine'] : 0;
      if (filePath === '' || name === '' || !(startLine >= 1)) return; // 脏行丢弃（total 含脏行账在 paginate 外）
      // S8 腿3：次序无关子串过滤——对归一化名（byName 键，大写）逐 token includes；
      // 序 = byName 迭代序 ⇒ 结果 ⊆ 全量且序稳定。分页账（total/游标/指纹）作用在
      // 过滤后的集合上，不同 query 的页靠指纹互斥（changedDuringPaging 从头重来），不串接。
      if (needles.length > 0) {
        const key = typeof normalizedName === 'string' && normalizedName !== '' ? normalizedName : name.toUpperCase();
        if (!needles.every((n) => key.includes(n))) return;
      }
      items.push({
        name,
        path: toRelativePath(filePath, rootDir),
        startLine,
        endLine: typeof ref['endLine'] === 'number' ? ref['endLine'] : startLine,
        ...(typeof ref['nameColumn'] === 'number' ? { nameColumn: ref['nameColumn'] } : {}),
      });
    });
    const p = paginateByCursor(
      items,
      (it, i) => `${String(it['path'])}|${String(it['name'])}|${String(it['startLine'])}|#${i}`,
      args,
      { defaultLimit: MCP_PROJECT_SYMBOLS_DEFAULT_LIMIT, maxLimit: MCP_PROJECT_SYMBOLS_MAX_LIMIT },
    );
    const s = (state ?? {}) as Record<string, unknown>;
    return {
      items: p.page,
      total: p.total,
      truncated: p.truncated,
      offset: p.offset,
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      fingerprint: p.fingerprint,
      ...(p.changedDuringPaging === true ? { changedDuringPaging: true } : {}),
      // 索引事实（additive）：覆盖形状与规模由提供方陈述，缺席如实 null（不编造读数）。
      index:
        typeof s['phase'] === 'string'
          ? {
              phase: s['phase'],
              coverage: s['coverage'] ?? null,
              filesScanned: typeof s['filesScanned'] === 'number' ? s['filesScanned'] : null,
              functions: typeof s['functions'] === 'number' ? s['functions'] : null,
            }
          : null,
      // S11 覆盖收口：这份清单是全项目盘扫描产物（erb.parser 索引）的投影 ⇒ 与 fs.tree 同尺
      // 补根级 listing 标注（「自你上一次读清单以来，根下动过几处」）；窗内自写回声命中才复核，
      // 多候补并进恰 1 趟 statFiles、0 次单 stat；窗外 / 无命中 / 判不了 stale:null + 理由如实。
      fsFreshness: await fsFreshnessListing(deps, rootDir, '.', scope),
    };
  };

  const statFile = async (
    args: Record<string, unknown>,
    scope: McpSessionScope | null | undefined,
  ): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：stat 无域基准根（不静默）');
    }
    const abs = resolveWithinRoot(rootDir, asString(args['relPath']));
    const rel = toRelativePath(abs, rootDir);
    const stat = await deps.invoke('stat_file', { path: abs });
    // Rust 返回 Option<FileStatDto>：null = 不存在 ⇒ {exists:false} 是真读数（不编造 size=0）。
    if (!stat || typeof stat !== 'object') {
      return {
        path: rel,
        exists: false,
        fsFreshness: await fsFreshnessField(deps, abs, rel, scope),
      };
    }
    const s = stat as Record<string, unknown>;
    return {
      path: rel,
      exists: true,
      size: typeof s['size'] === 'number' ? s['size'] : null,
      mtimeMs: typeof s['mtimeMs'] === 'number' ? s['mtimeMs'] : null,
      isDirectory: s['isDirectory'] === true,
      fsFreshness: await fsFreshnessField(deps, abs, rel, scope),
    };
  };

  const listDir = async (
    args: Record<string, unknown>,
    scope: McpSessionScope | null | undefined,
  ): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：列目录无域基准根（不静默）');
    }
    const rel = args['relPath'];
    // relPath 可选：缺省 = 项目根本身（空串合法），给了才过闸。
    const abs = rel === undefined || rel === '' ? rootDir : resolveWithinRoot(rootDir, asString(rel));
    const raw = await deps.invoke('list_dir', { path: abs });
    const allItems: Record<string, unknown>[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const e = item as Record<string, unknown>;
        allItems.push({
          name: asString(e['name']),
          path: toRelativePath(asString(e['path']), rootDir),
          isDirectory: e['isDirectory'] === true,
        });
      }
    }
    const sourceCount = Array.isArray(raw) ? raw.length : 0;
    const p = paginateByCursor(allItems, (e) => `${String(e['path'])}|${e['isDirectory'] === true ? 'd' : 'f'}`, args, {
      defaultLimit: 500,
      maxLimit: 5000,
    });
    return {
      path: relativeOrDot(abs, rootDir),
      entries: p.page,
      total: p.total,
      truncated: p.truncated,
      offset: p.offset,
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      fingerprint: p.fingerprint,
      ...(p.changedDuringPaging === true ? { changedDuringPaging: true } : {}),
      ...(sourceCount !== allItems.length ? { sourceCount, droppedUnparsable: sourceCount - allItems.length } : {}),
      // 目录级：覆盖期内该目录下任何路径被动过即 stale:true（逐条计数在 entries 账里）。
      fsFreshness: await fsFreshnessListing(deps, abs, relativeOrDot(abs, rootDir), scope),
    };
  };

  const workspaceRoots: McpReaderFn = async (args) => {
    const raw = await deps.invoke('workspace_roots');
    const roots = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
    const p = paginateByCursor(roots, (r, i) => `${r}#${i}`, args ?? {}, { defaultLimit: 50, maxLimit: 200 });
    // additive 发现面：与 roots **逐项对齐**的稳定 rootId（按根绝对路径算，不随顺序漂移）。
    // 只是「可枚举的候选标识」，本身不构成写授权；仍须人类在第四张表 approvedRootIds
    // 里精确批准，且落盘照旧过 approvedRoots 相对前缀 + 内核写允许域双闸。
    return {
      roots: p.page,
      rootIds: p.page.map((r) => rootIdOf(r)),
      total: p.total,
      truncated: p.truncated,
      offset: p.offset,
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      fingerprint: p.fingerprint,
      ...(p.changedDuringPaging === true ? { changedDuringPaging: true } : {}),
    };
  };

  const workspaceSearchAll: McpReaderFn = async (args, scope) => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：检索无基准根（不静默）');
    }
    const query = (args ?? {})['query'];
    if (typeof query !== 'string' || query.length === 0) {
      throw new McpFailure('INVALID_ARGS', 'workspace.searchAll 的 query 须为非空字符串');
    }
    // S8 腿1/腿2：软时限与命中载荷模式（都可省；缺省 = 旧请求体逐字同形、应答零漂移）
    const deadlineMs = searchDeadlineMsOf(args ?? {}, 'workspace.searchAll');
    const previewMode = searchPreviewModeOf(args ?? {}, 'workspace.searchAll');
    assertDeadlineNotWithSlice(args ?? {}, 'workspace.searchAll', deadlineMs);
    // scope:'sources' ⇒ 以 adapter 填充的作品域目录为根集合（契约字段投影，不硬编码领域）。
    const roots = searchRootsOf(project, rootDir, (args ?? {})['scope'] === 'sources');
    const page = pageParamsFor(args ?? {}, { defaultLimit: 50, maxLimit: 200 });
    if (wantsSliceResume(args)) {
      // B16：引擎闸下的命中集实测不可续 ⇒ 给了 resumeBySlice 才按互不相交的目录 / 文件分片续取。
      // 不给这个入参 ⇒ 走下面旧路，触墙时那套三件套 + note 逐字不变（旧面零回退）。
      const res = await createSliceRunner(deps)({
        args: args ?? {},
        query,
        project,
        rootDir,
        sourcesOnly: (args ?? {})['scope'] === 'sources',
        limit: page.limit,
        offset: page.offset,
        hasCursor: page.hasCursor,
        // 与旧路同一枚 await 口径（否则 Promise 会被原样塞进返回体）
        fsFreshness: await fsFreshnessListing(
          deps,
          roots[0] ?? rootDir,
          roots.length > 1
            ? `${roots[0] ?? rootDir}（本次共 ${roots.length} 个根，另 ${roots.length - 1} 个根未单独建基线）`
            : '.',
          scope,
        ),
      });
      // S8 腿2：分片路同样在投影层剥 preview——账在 runner 内部按全量命中算好 ⇒ 与 full 逐位一致
      return previewMode === 'none'
        ? { ...res, hits: stripPreviewFields((res['hits'] as Record<string, unknown>[]) ?? []) }
        : res;
    }
    const result = await deps.searchInFiles({
      searchId: nextSearchId(),
      roots,
      query,
      options: {
        isRegex: false,
        caseSensitive: false,
        wholeWord: false,
        extensions: [],
        maxResults: searchWindow(page.offset, page.limit),
        // S8 腿1：缺省不带键（旧请求体逐字同形）；给了才带（S1 的 Rust DTO / bridge 类型已在）
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      },
    });
    const hits: Record<string, unknown>[] = [];
    for (const file of result.files) {
      for (const match of file.matches) {
        hits.push({ path: toRelativePath(file.path, rootDir), line: match.line, preview: match.preview });
      }
    }
    const account = pageSearchHits(hits, args ?? {}, page.limit, page.offset, {
      totalMatches: result.totalMatches,
      truncated: result.truncated,
    });
    return {
      ...account,
      // S8 腿2："none" ⇒ 投影层剥 preview（账已按全量命中算好，与 full 逐位一致、游标跨模式互认）
      ...(previewMode === 'none' ? { hits: stripPreviewFields((account['hits'] as Record<string, unknown>[]) ?? []) } : {}),
      filesScanned: result.filesScanned,
      elapsedMs: result.elapsedMs,
      skipped: result.skipped,
      // S8 腿1：软时限账透传（S1 语义，不重造）。引擎没报 partial ⇒ 应答不带这个键（旧宿主零漂移）。
      ...(result.partial === true
        ? {
            partial: true,
            ...(typeof result.partialReason === 'string' && result.partialReason !== ''
              ? { partialReason: result.partialReason }
              : {}),
          }
        : {}),
      // 检索结果是从盘上现算的：`fsFreshness` 说「自你上一次检索以来，根下动过几处」。
      // 多根（scope:'sources'）只对第一根建基线，其余根在 target 里点名——不假装全覆盖。
      fsFreshness: await fsFreshnessListing(
        deps,
        roots[0] ?? rootDir,
        roots.length > 1
          ? `${roots[0] ?? rootDir}（本次共 ${roots.length} 个根，另 ${roots.length - 1} 个根未单独建基线）`
          : '.',
        scope,
      ),
    };
  };

  /* ---------------- 写腿（双闸：第四张表 approvedRoots + 内核写允许域） ---------------- */

  /** 写腿共同前置：内核到场 + 项目已开 + 有 rootDir（rename 双路径共用一次上下文）。 */
  function requireWriteContext(): { readonly kernel: McpKernelLike; readonly rootDir: string } {
    const kernel = deps.getKernel();
    if (!kernel) {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：写类工具不可用（不静默）');
    }
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：写无域基准根（不静默）');
    }
    return { kernel, rootDir };
  }

  /**
   * additive 写域多根（2026-11-06，用户拍板的 additive 方案）：按**枚举标识**选域基准根。
   *
   * - `rootId` 缺席 ⇒ 原路返回项目根，**一次 IPC 都不多发**，旧行为一字不变；
   * - 有 `rootId` ⇒ 三道拦截后才会换根：① 形状闸（绝不把 rootId 当路径用）
   *   ② 第四张表 `scope.approvedRootIds` 精确列名批准（默认空 ⇒ 一律拒绝）
   *   ③ 只读真源 `workspace_roots` 反查（找不到 ⇒ 显式拒绝，绝不退回项目根 / 绝不猜测）；
   * - 换根只改「`relPath` 相对谁解析」，**不新建写通道**：`approvedRoots` 相对前缀闸
   *   与内核 / Rust 写允许域两道闸原样保留，Rust 端点还会再复核一次 rootId。
   */
  async function resolveWriteRoot(
    args: Record<string, unknown>,
    scope: McpSessionScope,
  ): Promise<{
    readonly kernel: McpKernelLike;
    readonly rootDir: string;
    readonly rootId: string | null;
  }> {
    const ctx = requireWriteContext();
    const rawId = args['rootId'];
    if (rawId === undefined || rawId === null) {
      return { ...ctx, rootId: null }; // 零额外 IPC：默认拒绝面一字不变
    }
    if (!isRootIdShape(rawId)) {
      throw new McpFailure(
        'INVALID_ARGS',
        `rootId 形状非法（只收 ws: + 8 位小写十六进制的枚举标识，绝不是目标路径）：${sanitizeEcho(String(rawId))}`,
      );
    }
    const approved = scope.approvedRootIds ?? [];
    if (!approved.includes(rawId)) {
      throw new McpFailure(
        'PERMISSION_DENIED',
        `rootId ${rawId} 未获本会话批准（第四张表 approvedRootIds 为空或不含该标识）。` +
          '请由人类在「AI 接入」面板对候选常驻根逐项显式批准；默认拒绝，绝不退回项目根。',
      );
    }
    let rawRoots: unknown;
    try {
      rawRoots = await deps.invoke('workspace_roots');
    } catch (err) {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        `rootId 反查失败：只读真源 workspace_roots 不可用（${String(err)}）；不猜测根、不退回项目根`,
      );
    }
    const abs = Array.isArray(rawRoots) ? findRootById(rawRoots, rawId) : null;
    if (abs === null) {
      throw new McpFailure(
        'PERMISSION_DENIED',
        `rootId ${rawId} 在当前常驻可写根读数里找不到（授权可能被撤销 / 目录已不存在）。` +
          '请用 io.workspaceRoots 重新枚举；绝不退回项目根、绝不猜测路径。',
      );
    }
    return { kernel: ctx.kernel, rootDir: abs, rootId: rawId };
  }

  /** 单个目标：路径闸（与 Rust 同尺）+ 域内解析（fail-closed）+ 写闸一（第四张表）⇒ 绝对路径。 */
  function resolveWriteTarget(rootDir: string, relPath: string, approvedRoots: readonly string[]): string {
    const abs = resolveWithinRoot(rootDir, relPath);
    assertMcpWriteDomain(approvedRoots, relPath); // 写闸一：第四张表（独立授权，不继承三张表）
    return abs;
  }

  /** 单目标写腿（create / update / remove，收 `relPath`）一次性取齐上下文 + 解析。 */
  async function requireWriteTarget(
    args: Record<string, unknown>,
    scope: McpSessionScope,
  ): Promise<{
    readonly kernel: McpKernelLike;
    readonly rootDir: string;
    readonly relPath: string;
    readonly abs: string;
    readonly rootId: string | null;
  }> {
    const { kernel, rootDir, rootId } = await resolveWriteRoot(args, scope);
    const relPath = asString(args['relPath']);
    const abs = resolveWriteTarget(rootDir, relPath, scope.approvedRoots);
    return { kernel, rootDir, relPath, abs, rootId };
  }

  /** fileTree.create：独占创建（已存在 ⇒ 显式报错，绝不覆盖）；目录不收 content。 */
  const fileTreeCreate: McpReaderFn = async (args, scope) => {
    const input = args ?? {};
    const kind = input['kind'];
    if (kind !== 'file' && kind !== 'directory') {
      throw new McpFailure(
        'INVALID_ARGS',
        `fileTree.create 的 kind 须为 'file' | 'directory'：${sanitizeEcho(String(kind))}`,
      );
    }
    const content = input['content'];
    if (content !== undefined && typeof content !== 'string') {
      throw new McpFailure('INVALID_ARGS', 'fileTree.create 的 content 须为字符串');
    }
    const { kernel, relPath, abs, rootId } = await requireWriteTarget(input, scope);
    const io = kernel.io;
    if (kind === 'directory') {
      if (content !== undefined) {
        throw new McpFailure('INVALID_ARGS', 'fileTree.create 的 kind=directory 不收 content（不静默吞掉入参）');
      }
      const createDirExclusive = io.createDirExclusive;
      if (typeof createDirExclusive !== 'function') {
        throw new McpFailure('NOT_WIRED', 'fileTree.create 未接线：内核实例未提供 createDirExclusive 写原语（不静默）');
      }
      let created: boolean;
      try {
        created = await createDirExclusive.call(io, abs);
      } catch (err) {
        rethrowWriteGate(err, relPath);
      }
      if (!created) {
        throw new McpFailure(
          'TOOL_EXECUTION_FAILED',
          `目标已存在，create 绝不覆盖既有条目（先 io.listDir / fs.stat 确认再调用）：${sanitizeEcho(relPath)}`,
        );
      }
      return {
        path: relPath,
        kind: 'directory',
        created: true,
        ...(rootId !== null ? { rootId } : {}), // 诚实标明本次落点用的是哪个域基准根
        refreshed: emitFileChanged(kernel, 'add', abs, { tracker: trackerOf(deps), scope }),
      };
    }
    // kind === 'file'：独占创建 + （可选）经既有 writeText 通道写初始内容。
    const createFileExclusive = io.createFileExclusive;
    if (typeof createFileExclusive !== 'function') {
      throw new McpFailure('NOT_WIRED', 'fileTree.create 未接线：内核实例未提供 createFileExclusive 写原语（不静默）');
    }
    const wantsContent = typeof content === 'string' && content.length > 0;
    if (wantsContent && typeof io.writeText !== 'function') {
      throw new McpFailure('NOT_WIRED', 'fileTree.create 未接线：内核实例未提供 writeText 写原语（带初始内容的创建需要它，不静默）');
    }
    let created: boolean;
    try {
      created = await createFileExclusive.call(io, abs);
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    if (!created) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `目标已存在，create 绝不覆盖既有条目（先 io.listDir / fs.stat 确认再调用）：${sanitizeEcho(relPath)}`,
      );
    }
    if (wantsContent) {
      try {
        await io.writeText!(abs, content as string); // 既有保存语义：保编码 / 保换行 / 写前自动备份
      } catch (err) {
        rethrowWriteGate(err, relPath);
      }
    }
    return {
      path: relPath,
      kind: 'file',
      created: true,
      ...(typeof content === 'string' ? { contentChars: content.length } : {}),
      ...(rootId !== null ? { rootId } : {}),
      refreshed: emitFileChanged(kernel, 'add', abs, { tracker: trackerOf(deps), scope }),
    };
  };

  /** fileTree.update：全文替换既有文件（不存在 ⇒ 显式报错，绝不静默改成 create 语义）。 */
  const fileTreeUpdate: McpReaderFn = async (args, scope) => {
    const input = args ?? {};
    const content = input['content'];
    if (typeof content !== 'string') {
      throw new McpFailure('INVALID_ARGS', 'fileTree.update 的 content 须为字符串（全文替换，不收部分编辑）');
    }
    const { kernel, relPath, abs, rootId } = await requireWriteTarget(input, scope);
    const io = kernel.io;
    if (typeof io.writeText !== 'function' || typeof io.exists !== 'function') {
      throw new McpFailure('NOT_WIRED', 'fileTree.update 未接线：内核实例未提供 writeText / exists 原语（不静默）');
    }
    let present: boolean;
    try {
      present = await io.exists.call(io, abs);
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    if (!present) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `目标不存在，update 绝不静默改成 create 语义（先 fs.stat 确认，或改用 fileTree.create）：${sanitizeEcho(relPath)}`,
      );
    }
    try {
      await io.writeText.call(io, abs, content); // 既有保存语义：保编码 / 保换行 / 写前自动备份
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    return {
      path: relPath,
      updated: true,
      textLength: content.length,
      ...(rootId !== null ? { rootId } : {}),
      refreshed: emitFileChanged(kernel, 'change', abs, { tracker: trackerOf(deps), scope }),
    };
  };

  /* ---------------- fileTree.applyChangeset（MCP-PERF-S3 批，2026-11-06）----------------
   * 批量变更事务：一次 MCP 往返应用 ≤32 个全文替换（每项语义与 fileTree.update 逐字同尺），
   * 换来 ① 一份备份清单 ② 一串逐文件 `file.changed`（宿主既有防抖合并成**一轮**失效/诊断）
   * ③ 一趟批量 stat 读回真实落盘字节数。逐条 applied/refused 可见：refused 不抛整个批次，
   * 但 schema / 授权级的批次缺陷（超 32 项、批内重复路径、rootId 形状/批准/反查失败）在
   * **任何写发生之前**整批 INVALID_ARGS / PERMISSION_DENIED——不落半批。写通道零新增：
   * 落盘仍是内核 `io.writeText`（写闸二 assertWritable 原样生效），备份仍走内核 `io.backup`
   * 那一份单一真源（先备份拿路径、再 `writeText{backup:false}`，时序与 writeText 内部一致），
   * rootId 走与四写腿同一条 resolveWriteRoot 三道拦截 + Rust 端点二次复核。
   */
  const APPLY_CHANGESET_MAX_ITEMS = 32;
  const APPLY_CHANGESET_ENCODING_IDS = [
    'utf-8',
    'utf-8-bom',
    'shift_jis',
    'gbk',
    'gb18030',
    'big5',
    'utf-16le',
    'utf-16be',
  ] as const;

  const fileTreeApplyChangeset: McpReaderFn = async (args, scope) => {
    const input = args ?? {};
    const raw = input['changes'];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new McpFailure('INVALID_ARGS', 'fileTree.applyChangeset 的 changes 须为非空数组（每项 {path, content}）');
    }
    if (raw.length > APPLY_CHANGESET_MAX_ITEMS) {
      throw new McpFailure(
        'INVALID_ARGS',
        `fileTree.applyChangeset 单批 ≤${APPLY_CHANGESET_MAX_ITEMS} 项：收到 ${raw.length} 项；拆批重发（整批未执行，盘上零改动）`,
      );
    }
    // 批次级形状预检：每一项的 path / content / encoding / eol 都过闸，坏一项 = 调用方的账，
    // 整批拒收（绝不"能写的先写"——半批落盘比整批拒绝更难交代）。批内重复路径同理：执行序
    // 语义歧义（后者覆盖前者？）不猜，点名重复项整批拒。
    const items: { path: string; content: string; encoding?: string; eol?: string }[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const label = `changes[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new McpFailure('INVALID_ARGS', `${label} 须为对象 {path, content}`);
      }
      const e = entry as Record<string, unknown>;
      const rel = asString(e['path']);
      try {
        validateRelativePath(rel); // 与 schema 同尺（绝对路径 / 盘符 / .. / 设备名），fail-closed
      } catch (err) {
        throw new McpFailure(
          'INVALID_ARGS',
          `${label}.path 非项目根内相对路径：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const content = e['content'];
      if (typeof content !== 'string') {
        throw new McpFailure('INVALID_ARGS', `${label}.content 须为字符串（全文替换，不收部分编辑）`);
      }
      if (content.length > 1_000_000) {
        throw new McpFailure('INVALID_ARGS', `${label}.content 超过单文件上限 1_000_000 字符（与 fileTree.update 同尺）`);
      }
      const encoding = e['encoding'];
      if (encoding !== undefined && !(encoding === 'preserve' || (APPLY_CHANGESET_ENCODING_IDS as readonly string[]).includes(String(encoding)))) {
        throw new McpFailure('INVALID_ARGS', `${label}.encoding 非法：${sanitizeEcho(String(encoding))}（可选 preserve / ${APPLY_CHANGESET_ENCODING_IDS.join(' / ')}）`);
      }
      const eol = e['eol'];
      if (eol !== undefined && eol !== 'preserve' && eol !== 'crlf' && eol !== 'lf') {
        throw new McpFailure('INVALID_ARGS', `${label}.eol 非法：${sanitizeEcho(String(eol))}（可选 preserve / crlf / lf）`);
      }
      if (seen.has(rel)) {
        throw new McpFailure('INVALID_ARGS', `批内重复 path（执行序语义歧义，不猜）：${sanitizeEcho(rel)} 首见于更早的 changes 项；拆批或合并后重发`);
      }
      seen.add(rel);
      items.push({
        path: rel,
        content,
        ...(encoding !== undefined ? { encoding: String(encoding) } : {}),
        ...(eol !== undefined ? { eol: String(eol) } : {}),
      });
    });

    // 批次级授权：整批一个 rootId（一次三道拦截，绝不逐项重复 IPC；拒绝 ⇒ 盘上零改动）。
    const { kernel, rootDir, rootId } = await resolveWriteRoot(input, scope);
    const io = kernel.io;
    if (typeof io.writeText !== 'function' || typeof io.exists !== 'function' || typeof io.backup !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        'fileTree.applyChangeset 未接线：内核实例未提供 writeText / exists / backup 写原语（不静默）',
      );
    }

    const tracker = trackerOf(deps);
    const applied: Record<string, unknown>[] = [];
    const refused: Record<string, unknown>[] = [];
    const backups: Record<string, unknown>[] = [];
    const absByRel = new Map<string, string>();

    for (const it of items) {
      try {
        const abs = resolveWriteTarget(rootDir, it.path, scope.approvedRoots); // 路径闸 + 写闸一（第四张表）
        absByRel.set(it.path, abs);
        let present: boolean;
        try {
          present = await io.exists.call(io, abs);
        } catch (err) {
          rethrowWriteGate(err, it.path);
        }
        if (!present) {
          refused.push({
            path: it.path,
            code: 'TOOL_EXECUTION_FAILED',
            message: `目标不存在，update 语义绝不静默改成 create（先 fs.stat 确认，或逐项走 fileTree.create）：${sanitizeEcho(it.path)}`,
          });
          continue;
        }
        let backupPath: string | null;
        try {
          backupPath = await io.backup.call(io, abs); // 写前备份（内核单一真源），路径进清单
        } catch (err) {
          rethrowWriteGate(err, it.path);
        }
        const opts: Record<string, unknown> = { backup: false }; // 备份已手动落账，避免二次备份
        if (it.encoding !== undefined) opts['encoding'] = it.encoding;
        if (it.eol !== undefined) opts['eol'] = it.eol;
        try {
          await io.writeText.call(io, abs, it.content, opts); // 写闸二：内核 assertWritable 先于落盘
        } catch (err) {
          rethrowWriteGate(err, it.path);
        }
        backups.push({ path: it.path, ...(backupPath !== null ? { backupPath } : { backupPath: null }) });
        applied.push({
          path: it.path,
          ...(backupPath !== null ? { backupPath } : {}),
          refreshed: emitFileChanged(kernel, 'change', abs, { tracker, scope }),
        });
      } catch (err) {
        // 逐条失败可见：refused 带 code + message，批次继续（部分失败语义）。
        refused.push({
          path: it.path,
          code: err instanceof McpFailure ? err.code : 'TOOL_EXECUTION_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 落盘字节数一趟批量 stat 读回（真实读数，不按 content.length 编造——preserve 编码下
    // 两者本就不等）；stat 失败位如实 null，绝不冒充 0。
    let sizes = new Map<string, number | null>();
    if (applied.length > 0) {
      try {
        const stats = (await deps.invoke('stat_files', {
          paths: applied.map((a) => absByRel.get(String(a['path'])) ?? ''),
        })) as unknown;
        if (Array.isArray(stats)) {
          stats.forEach((entry, i) => {
            const rel = applied[i] !== undefined ? String(applied[i]!['path']) : '';
            const size = entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['size'] === 'number'
              ? ((entry as Record<string, unknown>)['size'] as number)
              : null;
            sizes.set(rel, size);
          });
        }
      } catch {
        sizes = new Map(); // 读不到就全体 null，不阻塞回执
      }
    }
    for (const a of applied) {
      a['bytes'] = sizes.get(String(a['path'])) ?? null;
      a['contentChars'] = items.find((it) => it.path === a['path'])?.content.length ?? null;
    }

    return {
      applied,
      refused,
      manifest: {
        backups,
        takenAtMs: Date.now(),
        note: '一次批次一份清单：backupPath 来自内核 io.backup 单一真源（写前自动备份桶）；backupPath:null = 备份时盘上已无此文件（竞态，如实标注）。',
      },
      totals: { total: items.length, applied: applied.length, refused: refused.length, backups: backups.length },
      ...(rootId !== null ? { rootId } : {}),
    };
  };

  /* ---------------- fileTree.patchLines（MCP-PERF-S6 批，2026-11-07）----------------
   * patch 级写（TRAE P1 原文）：单文件多 hunk（≤32），agent 改 5 万行文件不必上传全文。
   * 每 hunk 二选一：①1 基行区间 [startLine,endLine] → replacement（行号与 Monaco position
   * 同口径；CRLF/LF/CR 切分沿用 fs.readRange 的既有实现，行尾换行 ⇒ 末行空串）；
   * ②锚点替换 oldText → newText（oldText 在当前文本中必须唯一命中）。
   * 链路照抄 S3 applyChangeset 的成功形态：read 全文（read_file_bytes，与 fs.readRange 同一条
   * 读取通道）→ 内存应用 hunk → `io.backup` 拿备份路径 → `writeText{backup:false}` →
   * read_file_bytes 回读验证；一次 MCP 往返 → 一次备份 / 一次 `file.changed`（宿主防抖合并成
   * 一轮失效/诊断）→ 一次 stat 读回落盘字节 + diff 摘要。
   * 缺陷分级（半批落盘比整批拒绝更难交代，语义级缺陷才逐条放行）：
   *  - 批次级（任何写之前整批 INVALID_ARGS / PERMISSION_DENIED）：超 32、hunk 双形混用 / 半形、
   *    行界非 1 基整数、start>end、行区间重叠（执行序语义歧义不猜）、oldText 空串、
   *    relPath / rootId 形状与批准、写闸一；
   *  - 语义级（逐条 refused，批次继续）：行区间越界（写面绝不夹取——fs.readRange 的读窗口
   *    语义不适用于写）、锚点零命中 / 多命中。全部 refused ⇒ 零副作用（不备份、不写、不发事件）。
   * 应用序钉死：行区间先（按 startLine 升序单趟合并——坐标一律指**原始文件**，永不漂移），
   * 锚点后（按提交序，作用于行区间应用后的文本）。写通道零新增：落盘仍是内核 `io.writeText`
   * （保编码/EOL 的既有保存语义，与 fileTree.update 同尺；写闸二 assertWritable 原样生效），
   * 备份仍走内核 `io.backup` 单一真源；rootId 走与写腿同一条 resolveWriteRoot 三道拦截 +
   * Rust 端点二次复核。
   */
  const PATCH_LINES_MAX_HUNKS = 32;
  const PATCH_LINES_TEXT_CAP = 1_000_000; // replacement / newText / oldText 单串上限（与 fileTree.update content 同尺）

  interface PatchLinesHunk {
    readonly index: number;
    readonly kind: 'lines' | 'anchor';
    readonly startLine?: number;
    readonly endLine?: number;
    readonly replacement?: string;
    readonly oldText?: string;
    readonly newText?: string;
  }

  const fileTreePatchLines: McpReaderFn = async (args, scope) => {
    const input = args ?? {};
    const rawHunks = input['hunks'];
    if (!Array.isArray(rawHunks) || rawHunks.length === 0) {
      throw new McpFailure('INVALID_ARGS', 'fileTree.patchLines 的 hunks 须为非空数组（每项是行区间 {startLine, endLine, replacement} 或锚点 {oldText, newText} 二选一）');
    }
    if (rawHunks.length > PATCH_LINES_MAX_HUNKS) {
      throw new McpFailure(
        'INVALID_ARGS',
        `fileTree.patchLines 单批 ≤${PATCH_LINES_MAX_HUNKS} 个 hunk：收到 ${rawHunks.length} 个；拆批重发（整批未执行，盘上零改动）`,
      );
    }
    // 批次级形状预检（先于任何 IPC / 读盘）：每项必须恰为两形之一，坏一项整批拒收。
    const isLineNo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
    const hunks: PatchLinesHunk[] = [];
    rawHunks.forEach((entry, index) => {
      const label = `hunks[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new McpFailure('INVALID_ARGS', `${label} 须为对象：行区间 {startLine, endLine, replacement} 或锚点 {oldText, newText} 二选一`);
      }
      const h = entry as Record<string, unknown>;
      const hasLine = h['startLine'] !== undefined || h['endLine'] !== undefined || h['replacement'] !== undefined;
      const hasAnchor = h['oldText'] !== undefined || h['newText'] !== undefined;
      if (hasLine && hasAnchor) {
        throw new McpFailure('INVALID_ARGS', `${label} 行区间与锚点两形混用（startLine/endLine/replacement 与 oldText/newText 互斥）；拆成两个 hunk 重发`);
      }
      if (hasLine) {
        const startLine = h['startLine'];
        const endLine = h['endLine'];
        if (!isLineNo(startLine) || !isLineNo(endLine)) {
          throw new McpFailure(
            'INVALID_ARGS',
            `${label}.startLine / endLine 须为 1 基整数（与 Monaco position 同口径，0 基被拒）：` +
              `startLine=${sanitizeEcho(String(startLine))}, endLine=${sanitizeEcho(String(endLine))}`,
          );
        }
        if (startLine > endLine) {
          throw new McpFailure(
            'INVALID_ARGS',
            `${label} 的 startLine (${startLine}) 大于 endLine (${endLine})：区间为空。` +
              'fs.readRange 的读窗口越界是夹取，写面绝不夹取——写错了就是写错了。',
          );
        }
        const replacement = h['replacement'];
        if (typeof replacement !== 'string') {
          throw new McpFailure('INVALID_ARGS', `${label}.replacement 须为字符串（替换该行区间的全新文本；空串 = 整段删除）`);
        }
        if (replacement.length > PATCH_LINES_TEXT_CAP) {
          throw new McpFailure('INVALID_ARGS', `${label}.replacement 超过单串上限 ${PATCH_LINES_TEXT_CAP} 字符（与 fileTree.update content 同尺）`);
        }
        hunks.push({ index, kind: 'lines', startLine, endLine, replacement });
        return;
      }
      if (hasAnchor) {
        const oldText = h['oldText'];
        if (typeof oldText !== 'string' || oldText === '') {
          throw new McpFailure('INVALID_ARGS', `${label}.oldText 须为非空字符串（空串处处命中 = 永远多命中，不收）`);
        }
        if (oldText.length > PATCH_LINES_TEXT_CAP) {
          throw new McpFailure('INVALID_ARGS', `${label}.oldText 超过单串上限 ${PATCH_LINES_TEXT_CAP} 字符（与 fileTree.update content 同尺）`);
        }
        const newText = h['newText'];
        if (typeof newText !== 'string') {
          throw new McpFailure('INVALID_ARGS', `${label}.newText 须为字符串（空串 = 删除该锚点文本）`);
        }
        if (newText.length > PATCH_LINES_TEXT_CAP) {
          throw new McpFailure('INVALID_ARGS', `${label}.newText 超过单串上限 ${PATCH_LINES_TEXT_CAP} 字符（与 fileTree.update content 同尺）`);
        }
        hunks.push({ index, kind: 'anchor', oldText, newText });
        return;
      }
      throw new McpFailure('INVALID_ARGS', `${label} 两形都不全：行区间要 {startLine, endLine, replacement}，锚点要 {oldText, newText}（缺键拒收，不猜）`);
    });
    // 行区间重叠：纯坐标可判（无须读盘）⇒ 批次级拒绝（执行序语义歧义，绝不猜）。锚点无坐标，
    // 与行区间/彼此的交叠无法预判，应用序已钉死（行区间先、锚点后），结果确定且逐条可见。
    const lineHunks = hunks
      .filter((h): h is PatchLinesHunk & { kind: 'lines'; startLine: number; endLine: number; replacement: string } => h.kind === 'lines')
      .sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < lineHunks.length; i += 1) {
      const prev = lineHunks[i - 1]!;
      const cur = lineHunks[i]!;
      if (cur.startLine <= prev.endLine) {
        throw new McpFailure(
          'INVALID_ARGS',
          `hunk 行区间重叠（hunks[${prev.index}] 的 [${prev.startLine},${prev.endLine}] 与 hunks[${cur.index}] 的 [${cur.startLine},${cur.endLine}]）：` +
            '执行序语义歧义，写面绝不猜——合并或拆开后重发（整批未执行，盘上零改动）',
        );
      }
    }

    const relPath = asString(input['relPath']);
    try {
      validateRelativePath(relPath); // 与 schema 同尺（绝对路径 / 盘符 / .. / 设备名），fail-closed
    } catch (err) {
      throw new McpFailure('INVALID_ARGS', `relPath 非项目根内相对路径：${err instanceof Error ? err.message : String(err)}`);
    }
    // 批次级授权：整批一个根（一次三道拦截；拒绝 ⇒ 盘上零改动）。
    const { kernel, rootDir, rootId } = await resolveWriteRoot(input, scope);
    const io = kernel.io;
    if (typeof io.writeText !== 'function' || typeof io.exists !== 'function' || typeof io.backup !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        'fileTree.patchLines 未接线：内核实例未提供 writeText / exists / backup 写原语（不静默）',
      );
    }
    const abs = resolveWriteTarget(rootDir, relPath, scope.approvedRoots); // 路径闸 + 写闸一（第四张表）
    let present: boolean;
    try {
      present = await io.exists.call(io, abs);
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    if (!present) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `目标不存在，patchLines 不静默改成 create 语义（先 fs.stat 确认，或改用 fileTree.create）：${sanitizeEcho(relPath)}`,
      );
    }
    const textBefore = await deps.invoke('read_file_bytes', { path: abs }); // 与 fs.readRange 同一条读取通道
    if (typeof textBefore !== 'string') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', `read_file_bytes 未返回文本（不静默）：${sanitizeEcho(relPath)}`);
    }

    // 行切分与 fs.readRange / Monaco 同口径：CRLF / LF / CR 都算一次换行；行尾换行 ⇒ 末行空串。
    const linesBefore = textBefore.split(/\r\n|\r|\n/);
    const totalLines = linesBefore.length;
    const applied: Record<string, unknown>[] = [];
    const refused: Record<string, unknown>[] = [];

    // 第一趟：行区间 hunk 按 startLine 升序**单趟合并**——所有坐标指原始文件，永不漂移。
    // replacement 切行后原位替换整段（空串 = 整段删除，统一 diff 口径）。
    const outLines: string[] = [];
    let cursor = 0; // 已消费到的原始行下标（0 基）
    const countOccurrences = (hay: string, needle: string): number => {
      let n = 0;
      let at = hay.indexOf(needle);
      while (at !== -1) {
        n += 1;
        at = hay.indexOf(needle, at + needle.length);
      }
      return n;
    };
    for (const h of lineHunks) {
      const s = h.startLine - 1; // 0 基
      const e = h.endLine; // 0 基开区间端（不含）
      if (h.endLine > totalLines) {
        refused.push({
          index: h.index,
          kind: 'lines',
          startLine: h.startLine,
          endLine: h.endLine,
          code: 'INVALID_ARGS',
          message: `行区间越界：endLine (${h.endLine}) 大于文件总行数 (${totalLines})。写面绝不夹取（fs.readRange 的读窗口语义不适用于写）；先 fs.readRange 看清边界再发。`,
        });
        continue;
      }
      while (cursor < s) outLines.push(linesBefore[cursor]!), cursor += 1;
      const spanBefore = linesBefore.slice(s, e);
      const replacementLines = h.replacement === '' ? [] : h.replacement.split(/\r\n|\r|\n/);
      outLines.push(...replacementLines);
      cursor = e;
      applied.push({
        index: h.index,
        kind: 'lines',
        startLine: h.startLine,
        endLine: h.endLine,
        linesRemoved: spanBefore.length,
        linesAdded: replacementLines.length,
        charsBefore: spanBefore.join('\n').length,
        charsAfter: replacementLines.join('\n').length,
      });
    }
    while (cursor < totalLines) outLines.push(linesBefore[cursor]!), cursor += 1;
    let current = outLines.join('\n');

    // 第二趟：锚点 hunk 按提交序作用于行区间应用后的文本（零命中 / 多命中逐条 refused，不猜）。
    for (const h of hunks) {
      if (h.kind !== 'anchor' || h.oldText === undefined || h.newText === undefined) continue;
      const hits = countOccurrences(current, h.oldText);
      if (hits === 0) {
        refused.push({
          index: h.index,
          kind: 'anchor',
          code: 'INVALID_ARGS',
          message: `锚点零命中：oldText 在当前文本中不存在（多命中/零命中都逐条拒，绝不猜第一处；先 fs.readFile / fs.readRange 核对原文再发）：${sanitizeEcho(h.oldText)}`,
        });
        continue;
      }
      if (hits > 1) {
        refused.push({
          index: h.index,
          kind: 'anchor',
          code: 'INVALID_ARGS',
          message: `锚点多命中：oldText 命中 ${hits} 处（要求恰好唯一命中；扩大上下文再发，或改用行区间）：${sanitizeEcho(h.oldText)}`,
        });
        continue;
      }
      const at = current.indexOf(h.oldText);
      current = current.slice(0, at) + h.newText + current.slice(at + h.oldText.length);
      applied.push({
        index: h.index,
        kind: 'anchor',
        charsBefore: h.oldText.length,
        charsAfter: h.newText.length,
        matchOffset: at,
      });
    }
    // 回执按提交序排（与入参 hunks 对位，调用方逐条核对不换算）。
    applied.sort((a, b) => (a['index'] as number) - (b['index'] as number));
    refused.sort((a, b) => (a['index'] as number) - (b['index'] as number));

    // 全部 refused ⇒ 零副作用：不备份、不写、不发事件（半点不装作写过了）。
    const linesAfter = current.split(/\r\n|\r|\n/);
    if (applied.length === 0) {
      return {
        path: relPath,
        applied,
        refused,
        totals: { hunks: hunks.length, applied: 0, refused: refused.length },
        diff: {
          linesBefore: totalLines,
          linesAfter: linesAfter.length,
          lineDelta: linesAfter.length - totalLines,
          charsBefore: textBefore.length,
          charsAfter: current.length,
          charDelta: current.length - textBefore.length,
        },
        written: false,
        ...(rootId !== null ? { rootId } : {}),
      };
    }

    let backupPath: string | null;
    try {
      backupPath = await io.backup.call(io, abs); // 写前备份（内核单一真源）
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    try {
      await io.writeText.call(io, abs, current, { backup: false }); // 写闸二：内核 assertWritable 先于落盘；保编码/EOL 交给内核 preserve
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    // 回读验证：盘上真相与本次拼出的全文逐行比对（EOL 风格交由内核 preserve 的既定语义，
    // 故按 \n 归一后比对行内容——内容级诚实，风格差异不误报）。
    const readBack = await deps.invoke('read_file_bytes', { path: abs });
    if (typeof readBack !== 'string' || readBack.replace(/\r\n?/g, '\n') !== current.replace(/\r\n?/g, '\n')) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `fileTree.patchLines 回读验证失败：写入后从盘上读回的内容与本次 patch 结果不一致（写已发生；先 fs.readRange 核对盘态再决定是否重试）：${sanitizeEcho(relPath)}`,
      );
    }

    // 落盘字节数 stat 读回（真实读数，不按 current.length 编造）；读不到如实 null。
    let bytes: number | null = null;
    try {
      const stats = (await deps.invoke('stat_files', { paths: [abs] })) as unknown;
      const first = Array.isArray(stats) ? (stats[0] as Record<string, unknown> | undefined) : undefined;
      if (first && typeof first['size'] === 'number') bytes = first['size'] as number;
    } catch {
      bytes = null; // 读不到就如实 null，不阻塞回执
    }

    return {
      path: relPath,
      applied,
      refused,
      totals: { hunks: hunks.length, applied: applied.length, refused: refused.length },
      diff: {
        linesBefore: totalLines,
        linesAfter: linesAfter.length,
        lineDelta: linesAfter.length - totalLines,
        charsBefore: textBefore.length,
        charsAfter: current.length,
        charDelta: current.length - textBefore.length,
      },
      backupPath, // 来自内核 io.backup 单一真源；null = 备份时盘上已无此文件（竞态，如实标注）
      bytes,
      written: true,
      ...(rootId !== null ? { rootId } : {}),
      refreshed: emitFileChanged(kernel, 'change', abs, { tracker: trackerOf(deps), scope }),
    };
  };

  /**
   * fileTree.remove：删除项目根内文件 / 目录。先经只读 `stat_file`（`deps.invoke` seam，与
   * fs.stat 腿同口径）判类型：不存在 ⇒ 显式失败（不静默成功）；目录须显式 `recursive:true`
   * 才放行（destructive 保守，空 / 非空无法从 stat 判定）。写动作走内核 `io.removeFile` /
   * `io.removeDir`——写闸二（内核 `assertWritable`）与 Rust `ensure_write_allowed` 都不绕。
   */
  const fileTreeRemove: McpReaderFn = async (args, scope) => {
    const input = args ?? {};
    const { kernel, relPath, abs, rootId } = await requireWriteTarget(input, scope); // 选根 + 路径闸 + 域内解析 + 写闸一
    const io = kernel.io;
    const stat = await deps.invoke('stat_file', { path: abs }); // 只读判类型，绝不经它写盘
    if (!stat || typeof stat !== 'object') {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `目标不存在，remove 不静默成功（先 fs.stat / io.listDir 确认）：${sanitizeEcho(relPath)}`,
      );
    }
    const isDir = (stat as Record<string, unknown>)['isDirectory'] === true;
    if (isDir && input['recursive'] !== true) {
      throw new McpFailure(
        'INVALID_ARGS',
        `目标是目录，删除目录须显式 recursive:true（destructive 保守，不猜空 / 非空）：${sanitizeEcho(relPath)}`,
      );
    }
    const primitive = isDir ? io.removeDir : io.removeFile;
    if (typeof primitive !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        `fileTree.remove 未接线：内核实例未提供 ${isDir ? 'removeDir' : 'removeFile'} 写原语（不静默）`,
      );
    }
    try {
      await primitive.call(io, abs); // 写闸二：内核 `assertWritable`（writablePaths）先于落盘
    } catch (err) {
      rethrowWriteGate(err, relPath);
    }
    return {
      path: relPath,
      removed: true,
      removedKind: isDir ? 'directory' : 'file',
      ...(rootId !== null ? { rootId } : {}),
      refreshed: emitFileChanged(kernel, 'unlink', abs, { tracker: trackerOf(deps), scope }),
    };
  };

  /**
   * fileTree.rename：`from` / `to` **两端都过**路径闸 + 域内解析 + 写闸一（任一越界整批拒绝，
   * 写原语零触达），再走内核 `io.rename`（对两端 `assertWritable` + Rust 两端
   * `ensure_write_allowed`）。成功后广播源 `'unlink'` + 落点 `'add'`（additive）。
   */
  const fileTreeRename: McpReaderFn = async (args, scope) => {
    const input = args ?? {};
    // 两端共用同一个域基准根：一次反查 / 一次批准，绝不出现「from 在 A 根、to 在 B 根」的跨域搬运。
    const { kernel, rootDir, rootId } = await resolveWriteRoot(input, scope);
    const fromRel = asString(input['from']);
    const toRel = asString(input['to']);
    const fromAbs = resolveWriteTarget(rootDir, fromRel, scope.approvedRoots);
    const toAbs = resolveWriteTarget(rootDir, toRel, scope.approvedRoots);
    const io = kernel.io;
    if (typeof io.rename !== 'function') {
      throw new McpFailure('NOT_WIRED', 'fileTree.rename 未接线：内核实例未提供 rename 写原语（不静默）');
    }
    try {
      await io.rename.call(io, fromAbs, toAbs); // 写闸二：内核对 from / to 两端 `assertWritable`
    } catch (err) {
      rethrowWriteGate(err, `${fromRel} → ${toRel}`);
    }
    const freshness = { tracker: trackerOf(deps), scope };
    const fromRefreshed = emitFileChanged(kernel, 'unlink', fromAbs, freshness);
    const toRefreshed = emitFileChanged(kernel, 'add', toAbs, freshness);
    return {
      from: fromRel,
      to: toRel,
      renamed: true,
      ...(rootId !== null ? { rootId } : {}),
      refreshed: fromRefreshed && toRefreshed,
    };
  };

  /* ---- 第四波（LaneF）：4 枚 Rust 只读真源腿，全部经既有 invoke seam + 域内路径闸 ---- */
  const ENCODE_STRING_ENCODINGS: readonly string[] = [
    'utf-8', 'utf-8-bom', 'shift_jis', 'gbk', 'gb18030', 'big5', 'utf-16le', 'utf-16be',
  ];

  const appDataDir = async (): Promise<unknown> => {
    const dir = await deps.invoke('app_data_dir');
    if (typeof dir !== 'string' || dir === '') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'app_data_dir 未返回路径字符串（不静默、不编造）');
    }
    return { path: dir };
  };

  const encodeString = async (args: Record<string, unknown>): Promise<unknown> => {
    const text = args['text'];
    if (typeof text !== 'string') {
      throw new McpFailure('INVALID_ARGS', 'codec.encodeString 的 text 须为字符串');
    }
    const encoding = asString(args['encoding']);
    if (!ENCODE_STRING_ENCODINGS.includes(encoding)) {
      throw new McpFailure('INVALID_ARGS', `codec.encodeString 的 encoding 不在白名单：${sanitizeEcho(encoding)}`);
    }
    const base64 = await deps.invoke('encode_string', { text, encoding });
    if (typeof base64 !== 'string') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'encode_string 未返回 base64 字符串（不静默、不编造）');
    }
    return { encoding, charLength: text.length, base64 };
  };

  const pathExists = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：pathExists 无域基准根（不静默）');
    }
    const abs = resolveWithinRoot(rootDir, asString(args['relPath'])); // 路径闸 + 域内解析（fail-closed）
    const rel = toRelativePath(abs, rootDir);
    const exists = await deps.invoke('path_exists', { path: abs });
    if (typeof exists !== 'boolean') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'path_exists 未返回布尔值（不静默、不伪造）');
    }
    return {
      path: rel,
      exists,
      // S11 覆盖收口：盘读面（path_exists）与 fs.stat 同尺补 file 档标注——单路径 ≤1 趟 stat
      // 复核（窗内自写回声命中才发；窗外 / 无命中 / 判不了 stale:null + staleReason 分档如实）。
      fsFreshness: await fsFreshnessField(deps, abs, rel, scope),
    };
  };

  const statFiles = async (
    args: Record<string, unknown>,
    scope: McpSessionScope | null | undefined,
  ): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：statFiles 无域基准根（不静默）');
    }
    const relPaths = args['relPaths'];
    if (!Array.isArray(relPaths) || relPaths.length === 0) {
      throw new McpFailure('INVALID_ARGS', 'fs.statFiles 的 relPaths 须为非空数组');
    }
    const maxResults = clampInt(args['maxResults'], 200, 1, 200);
    // 逐项过路径闸 + 域内解析：任何一个越界整批拒绝（fail-closed，绝不把域外路径送到 Rust）。
    const absPaths: string[] = [];
    for (const rel of relPaths) {
      if (typeof rel !== 'string' || rel === '') {
        throw new McpFailure('INVALID_ARGS', 'fs.statFiles.relPaths 的每一项须为非空字符串');
      }
      absPaths.push(resolveWithinRoot(rootDir, rel));
    }
    const kept = absPaths.slice(0, maxResults);
    const raw = await deps.invoke('stat_files', { paths: kept });
    const items: Record<string, unknown>[] = [];
    // B13 判据 2：逐项失效标注走**一趟** `verdictsOfRechecked`（窗内命中 N 条也只付
    // 一趟 statFiles；没命中 ⇒ 零额外 syscall）。逐条 await 单条复核 = N 趟，本面禁止。
    const freshnessTargets: { abs: string; rel: string }[] = [];
    if (Array.isArray(raw)) {
      raw.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const e = entry as Record<string, unknown>;
        // 逐项失效标注用**请求侧解析出的绝对路径**为准（Rust 未回显 path 时也有基准，不猜）。
        const abs = asString(e['path']) !== '' ? asString(e['path']) : (kept[index] ?? '');
        const rel = toRelativePath(abs, rootDir);
        freshnessTargets.push({ abs, rel });
        items.push({
          path: rel,
          exists: e['exists'] === true,
          size: typeof e['size'] === 'number' ? e['size'] : null,
          mtimeMs: typeof e['mtimeMs'] === 'number' ? e['mtimeMs'] : null,
        });
      });
    }
    const freshnesses = await fsFreshnessFields(deps, freshnessTargets, scope);
    items.forEach((item, i) => {
      item['fsFreshness'] = freshnesses[i] ?? fsFreshnessAbsentPayload(String(item['path']), 'file');
    });
    return { items, total: relPaths.length, truncated: relPaths.length > items.length };
  };

  // Wave4 余项①：quickFix 受控 apply 腿（稳定 actionId 台账 + 模型内一次撤销步，见 quick-fix.ts）。
  const quickFixApply = createQuickFixApplyLeg(deps);
  // B3 批（LaneO）：编辑器写 / 光标副作用五枚（editor.setValue / type / setCursor /
  // setSelection / revealLine）。五枚都**只改 Monaco 模型**：回包恒定 `saved:false`，
  // 磁盘一个字节不动——本批零新增写盘通道（铁律 5/6/7），落盘仍是 fileTree.update
  // 双闸（第四张表 approvedRoots × 内核 writablePaths）/ exportFile 对话框那两条法定路。
  const editorWriteLegs = createEditorWriteLegs(deps);
  // 解构成裸标识符：腿表条目形状是 `['工具名', 标识符]`，tools/mcp-inventory.mjs 的
  // parseLegMaps 按这个锚判 wired（成员表达式不命中 ⇒ 会把已接线的腿算成 NOT_WIRED 假红）。
  const { editorSetValue, editorType, editorSetCursor, editorSetSelection, editorRevealLine } =
    editorWriteLegs;
  /* ---------------- 打开文档腿（B10 批，LaneV 2026-11-06）----------------
   * 执行体 = 宿主既有事件 `editor.revealLocation`（App.tsx 的通用导航落地点，与转到定义 /
   * 问题面板 / 大纲同一条路）；MCP 侧**只加观察、不加机制**：发射后有界轮询 `livePanes` 登记簿，
   * 读到「某实例的活动文件就是这条 path 且上屏 model 就是它那一份标签的 model」才算 opened:true。
   * 根读法与路径闸**不从注入面给**：`getRootDir` 走 `requireProject`、`resolveWithinRoot` 用本模块
   * 那一条（与 fs.readFile 逐字同尺）——Wave4 #4 那句「routeOpenPath 不校验项目根域」就在这里补上，
   * 域外路径当场 INVALID_ARGS，永远到不了宿主事件。 */
  const openDeps: McpEditorOpenDeps = {
    getRootDir: () => {
      const root = rootDirOf(requireProject(deps.getKernel()));
      return root === '' ? null : root;
    },
    resolveWithinRoot,
    emitIntent: deps.editorOpen?.emitIntent ?? productionEmitOpenIntent(() => deps.getKernel()?.bus ?? null),
    observePanes: deps.editorOpen?.observePanes ?? productionObserveEditorPanes,
    sleep: deps.editorOpen?.sleep,
    now: deps.editorOpen?.now,
  };
  const editorOpenDocument = createEditorOpenLegs(openDeps).editorOpenDocument;
  /* ---------------- 启动器族腿（B4 批，LaneS 2026-11-06）----------------
   * 27 枚具名 `launcher_*` 工具的执行体全部转交 `real-sources-launcher.ts`（真源
   * `kernel.launcherHost`，一方法一条 Rust 命令）。这里只做「解构成裸标识符 + 进腿表」，
   * 理由与上面 editorWriteLegs 逐字相同：`tools/mcp-inventory.mjs::parseLegMaps` 只认
   * `['工具名', 标识符]` 这一形状，成员表达式不命中 ⇒ 已接线的腿会被算成 NOT_WIRED 假红。
   * 授权面零放宽：第三张表（实例 × rootId 逐根授权，宿主 approvals.json）复验、确认闸、
   * 信任闸一律留在宿主，本批**没有任何一腿**向模型开放写落点或对话框授权入口。 */
  const launcherLegs = createLauncherLegs({ getLauncher: deps.getLauncher, getKernel: deps.getKernel });
  const {
    launcher_instance_list: launcherInstanceList,
    launcher_instance_get: launcherInstanceGet,
    launcher_instance_update: launcherInstanceUpdate,
    launcher_instance_remove: launcherInstanceRemove,
    launcher_instance_duplicate: launcherInstanceDuplicate,
    launcher_content_list: launcherContentList,
    launcher_content_diagnose: launcherContentDiagnose,
    launcher_content_apply: launcherContentApply,
    launcher_content_uninstall: launcherContentUninstall,
    launcher_content_set_enabled: launcherContentSetEnabled,
    launcher_content_set_order: launcherContentSetOrder,
    launcher_process_list: launcherProcessList,
    launcher_process_status: launcherProcessStatus,
    launcher_task_list: launcherTaskList,
    launcher_task_cancel: launcherTaskCancel,
    launcher_save_list: launcherSaveList,
    launcher_save_backups: launcherSaveBackups,
    launcher_save_backup: launcherSaveBackup,
    launcher_save_restore: launcherSaveRestore,
    launcher_save_delete_backup: launcherSaveDeleteBackup,
    launcher_save_apply_import: launcherSaveApplyImport,
    launcher_log_sessions: launcherLogSessions,
    launcher_log_tail: launcherLogTail,
    launcher_log_read: launcherLogRead,
    launcher_project_hash: launcherProjectHash,
    launcher_start: launcherStart,
    launcher_stop: launcherStop,
  } = launcherLegs;

  /* ---------------- 长任务面腿（Wave4 余项⑤：只登记「进度 + 取消 + 可查询状态」三件套齐备的族） ----------------
   * 真源在 `real-sources-tasks.ts`（表 + 投影 + 有界性都在那一层）；本模块只做分派与缺席兜底。
   * 进度契约是**轮询读**：`tasks.status` / `kojo://tasks`，服务端不推送（无状态单请求端点，
   * capabilities 的 resources.subscribe 保持 false，不因本批抬成 true）。 */
  function requireTaskLegs(name: string): McpTaskLegs {
    const legs = deps.tasks;
    if (!legs) {
      throw new McpFailure(
        'NOT_WIRED',
        `工具 ${name} 未接线：宿主未注入长任务面（real-sources-tasks.ts 的 createMcpTaskLegs）——` +
          '没有真任务表就不装出任务来（不静默、不伪造进度读数）。',
      );
    }
    return legs;
  }

  const tasksStart = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> =>
    requireTaskLegs('tasks.start').start(args ?? {}, scope);

  const tasksStatus = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> =>
    requireTaskLegs('tasks.status').status(args ?? {}, scope);

  const tasksCancel = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> =>
    requireTaskLegs('tasks.cancel').cancel(args ?? {}, scope);

  // B2 批（LaneT，2026-11-06）：结构化批读面 `fs.readMany`（只读，真源 = 内核 io.readTexts 的
  // 批量原语；逐条路径闸与 fs.readFile / fs.statFiles 同一个 resolveWithinRoot，超限整批
  // INVALID_ARGS，失败位显式带原因）。实现见 batch-read-leg.ts；此处只做注入与分派。
  // B13 判据 2：逐条失效标注改**一趟** `verdictsOfRechecked`（fsFreshnessBatch 注入形状，
  // 批内窗内命中 ≤64 条也只付一趟 statFiles）。
  const readMany = createBatchReadLeg({
    getKernel: deps.getKernel,
    invoke: deps.invoke,
    requireProject,
    resolveWithinRoot,
    toRelativePath,
    fsFreshnessBatch: (targets, scope2) => fsFreshnessFields(deps, targets, scope2),
    pageChars: { defaultChars: MCP_PAGE_TEXT_DEFAULT_CHARS, maxChars: MCP_PAGE_TEXT_MAX_CHARS },
  });

  const ioTools = new Map<string, (args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown> | unknown>([
    ['commands.list', commandsList],
    ['fs.readFile', readFile],
    // MCP-PERF-S4 批（LaneK，2026-11-07）：行区间读（1 基、Monaco 同口径；越界夹取 + truncated
    // 可见，start>end INVALID_ARGS 点名；路径闸同 fs.readFile，可选 rootId 同写腿三道拦截）。
    ['fs.readRange', readRange],
    ['fs.stat', statFile],
    ['io.listDir', listDir],
    ['io.workspaceRoots', workspaceRoots],
    ['workspace.searchAll', workspaceSearchAll],
    ['app.dataDir', appDataDir],
    ['codec.encodeString', encodeString],
    ['fs.pathExists', pathExists],
    ['fs.statFiles', statFiles],
    // B2 批（LaneT）：结构化批读（一次调用读多文件）；只读，不触任何写命令 / 索引重建。
    ['fs.readMany', readMany],
    ['fileTree.create', fileTreeCreate],
    ['fileTree.update', fileTreeUpdate],
    // MCP-PERF-S3 批（2026-11-06）：批量变更事务（≤32 文件 / 一次备份清单 / 逐条 applied/refused）。
    ['fileTree.applyChangeset', fileTreeApplyChangeset],
    // MCP-PERF-S6 批（2026-11-07）：patch 级写（单文件 ≤32 hunk，行区间/锚点二选一；
    // read→应用→io.backup→writeText{backup:false}→回读验证，逐条 applied/refused + diff 摘要）。
    ['fileTree.patchLines', fileTreePatchLines],
    ['fileTree.remove', fileTreeRemove],
    ['fileTree.rename', fileTreeRename],
    // Wave4 余项①：稳定 actionId 台账 + 宿主受控 apply（模型内一次撤销步，不落盘、
    // 不新建写通道）；逐闸拒绝显式报错，run 式意图 / 糖投影保持显式 NOT_WIRED。
    ['problems.quickFix', quickFixApply],
    ['tasks.start', tasksStart],
    ['tasks.status', tasksStatus],
    ['tasks.cancel', tasksCancel],
    // B3 批（LaneO）：编辑器写 / 光标副作用五枚，按 paneId 显式反查实例（无焦点兜底）；
    // 内容写两枚（setValue / type）在只读实例显式 PERMISSION_DENIED，回读核对失败显式报错，
    // 成功回报必带 dirty 真读数 + saved:false（磁盘没动这件事每次都说，不是可选字段）。
    ['editor.setValue', editorSetValue],
    ['editor.type', editorType],
    ['editor.setCursor', editorSetCursor],
    ['editor.setSelection', editorSetSelection],
    ['editor.revealLine', editorRevealLine],
    // B10 批（LaneV）：打开文档一枚（edit 档）。回执只认登记簿读数：读不到就显式失败并交代账目
    // （等了多久 / 看到几个实例 / 各实例正显示什么 / 为什么判没打开），绝不 opened:true 冒充。
    // 本腿不写盘、不改模型、不改光标（`saved:false` + `contentChanged:false` 恒定如实回报）。
    ['editor.openDocument', editorOpenDocument],
    // B4 批（LaneS）：启动器族 27 枚具名 privileged 工具（真源 kernel.launcherHost，
    // 一方法一条 Rust `launcher_*` 命令）。只读那 13 枚零副作用；生命周期 / 写那 14 枚的
    // 第三张表复验、确认闸、信任闸全在宿主，本面不收任何写落点参数。
    ['launcher_instance_list', launcherInstanceList],
    ['launcher_instance_get', launcherInstanceGet],
    ['launcher_instance_update', launcherInstanceUpdate],
    ['launcher_instance_remove', launcherInstanceRemove],
    ['launcher_instance_duplicate', launcherInstanceDuplicate],
    ['launcher_content_list', launcherContentList],
    ['launcher_content_diagnose', launcherContentDiagnose],
    ['launcher_content_apply', launcherContentApply],
    ['launcher_content_uninstall', launcherContentUninstall],
    ['launcher_content_set_enabled', launcherContentSetEnabled],
    ['launcher_content_set_order', launcherContentSetOrder],
    ['launcher_process_list', launcherProcessList],
    ['launcher_process_status', launcherProcessStatus],
    ['launcher_task_list', launcherTaskList],
    ['launcher_task_cancel', launcherTaskCancel],
    ['launcher_save_list', launcherSaveList],
    ['launcher_save_backups', launcherSaveBackups],
    ['launcher_save_backup', launcherSaveBackup],
    ['launcher_save_restore', launcherSaveRestore],
    ['launcher_save_delete_backup', launcherSaveDeleteBackup],
    ['launcher_save_apply_import', launcherSaveApplyImport],
    ['launcher_log_sessions', launcherLogSessions],
    ['launcher_log_tail', launcherLogTail],
    ['launcher_log_read', launcherLogRead],
    ['launcher_project_hash', launcherProjectHash],
    ['launcher_start', launcherStart],
    ['launcher_stop', launcherStop],
    // MCP-PERF-S4 批（LaneK，2026-11-07）：全项目函数清单（直连 erb.parser 的 byName 索引，
    // 无编辑器依赖；paginateByCursor 分页；服务缺席 NOT_WIRED、索引未就绪 RESOURCE_UNAVAILABLE）。
    ['semantic.projectSymbols', projectSymbols],
  ]);

  return async (name, args, scope) => {
    const tool = ioTools.get(name);
    if (tool) return tool(args ?? {}, scope);
    // 仍 NOT_WIRED 的写类 / 危险动作：逐个写明缺什么（不静默、不造假实现）。
    // B4 批后 `launcher_*` 的口径（铁律 4：缺席必须逐条可解释，不是一句「未接线」）：
    //   · 27 枚有诚实数据面 / 宿主复验链齐备的已登记成具名工具（上面腿表），走得到腿；
    //   · `launcher_pick_*`（对话框即授权本身）、`launcher_trust_executable`（信任授予必须是
    //     人的动作）、`launcher_instance_open_folder`（OS shell 面向人）、`launcher_log_export` /
    //     `launcher_save_export`（落点由系统对话框选定＝法定通道）、`launcher_content_plan` /
    //     `launcher_save_import` / `launcher_project_extract`（入参是对话框产出的输入件绝对路径，
    //     登记即给模型一条任意的本机读侧通道）、`launcher_instance_create`（profile 由 adapter
    //     编译，MCP 腿零游戏知识 ⇒ 造不出诚实载荷）、`launcher_runtime_*`（宿主未落地＝真源不存在）
    //     ⇒ **刻意永不登记**，逐条判性写在 `@kojo/mcp-host` 的 MCP_DEFERRED_GAP_NOTES；
    //   · `market_*` 全族维持 Rust `validate_tool_name` 的 fail-closed（铸凭据 / 不可逆外发 /
    //     网络 + 安装副作用），本批零改动。
    if (
      name.startsWith('fileTree.') ||
      name.startsWith('remove_') ||
      name.startsWith('rename_') ||
      name.startsWith('launcher_') ||
      name.startsWith('market_')
    ) {
      throw new McpFailure(
        'NOT_WIRED',
        `工具 ${name} 未接线：这一条刻意没有登记成模型可调用工具。` +
          (name.startsWith('launcher_')
            ? '启动器族已登记的 27 枚见 tools/list（只读 13 + 生命周期/写 14，档位 privileged、第四张表精确名批准）；' +
              '剩下的是对话框即授权（launcher_pick_*）、信任授予（launcher_trust_executable）、' +
              'OS shell（launcher_instance_open_folder）、导出法定通道（launcher_log_export / launcher_save_export）、' +
              '输入件绝对路径（launcher_content_plan / launcher_save_import / launcher_project_extract）、' +
              'adapter 编译载荷（launcher_instance_create）与宿主未落地的 launcher_runtime_* 一族，' +
              '逐条理由见 MCP_DEFERRED_GAP_NOTES。'
            : '写类 / 危险动作不经 MCP 擅自开放执行（需宿主授权面）。'),
      );
    }
    throw new McpFailure('NOT_WIRED', `工具 ${name} 未接线：宿主未提供该只读真源（不静默、不造假实现）`);
  };
}

/* ------------------------------- resource 数据源（IO 面 6 URI） ------------------------------- */

export type McpResourceDataReader = (uri: string, scope: McpSessionScope) => Promise<unknown>;

/** resource URI 常量（真源 = `@kojo/mcp-host` 的 MCP_RESOURCE_SPECS；Wave4 余项⑤加 `kojo://tasks`）。 */
export const KOJO_RESOURCE_URIS = {
  snapshot: 'kojo://project/snapshot',
  fileTree: 'kojo://project/file-tree',
  diagnostics: 'kojo://project/diagnostics',
  validationFailures: 'kojo://project/validation-failures',
  commands: 'kojo://project/commands',
  plugins: 'kojo://project/plugins',
  events: 'kojo://project/events',
  activeDocument: 'kojo://project/active-document',
  /**
   * Wave4 余项 ③新增：**宿主侧追加**的第 9 项（经 `McpWiringSources.resources` 登记，
   * 不动 `@kojo/mcp-host` 的冻结契约表）。外部写盘失效账本 + 监视覆盖自述 + 能力面自述。
   */
  fsFreshness: 'kojo://project/fs-freshness',
  /**
   * Wave4 余项 ⑤新增：长任务表。与前 8 项同进 `@kojo/mcp-host` 的 `MCP_RESOURCE_SPECS`
   * （该表本就随批 additive 追加，非字面冻结），故这里是第 10 项。
   */
  tasks: 'kojo://tasks',
} as const;

function conventionReport(kernel: McpKernelLike | null): { readonly failedRules: unknown[] } | null {
  const linter = kernel?.services.tryGet<{ report?: () => unknown }>('convention.linter');
  if (!linter || typeof linter.report !== 'function') return null;
  const report = linter.report();
  if (!report || typeof report !== 'object') return null;
  const failed = (report as Record<string, unknown>)['failedRules'];
  return { failedRules: Array.isArray(failed) ? failed : [] };
}

/**
 * 不依赖 Monaco 的 6 个 resource：snapshot / file-tree / validation-failures / commands /
 * plugins / events。diagnostics 与 active-document（需 Monaco）由 `real-sources.ts` 组装进
 * 同一个 readResourceData 分派。events 的环形缓冲与 plugins 状态都来自注入的内核实例。
 */
export function createIoResourceData(
  deps: McpIoDeps,
  readEvents: (max: number) => unknown[],
  countEvents: () => number,
): McpResourceDataReader {
  const fileTreeData = createKernelIo(deps).fileTree;

  return async (uri, scope) => {
    const kernel = deps.getKernel();
    switch (uri) {
      case KOJO_RESOURCE_URIS.snapshot: {
        const project = requireProject(kernel);
        const docCounts = {
          commands: deps.getCommands().length,
          plugins: kernel ? kernel.plugins.list().length : 0,
          eventsBuffered: countEvents(),
        };

        return {
          project: projectSummaryOf(project),
          document: null,
          counts: docCounts,
          // 快照是聚合读数：附项目根级失效事实，让「这份快照是否还代表盘上」可见。
          fsFreshness: await fsFreshnessListing(deps, asString(project['rootDir']), '.', scope),
        };
      }
      case KOJO_RESOURCE_URIS.fileTree:
        return fileTreeData({}, scope);
      case KOJO_RESOURCE_URIS.validationFailures: {
        if (!kernel) {
          throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：校验报告数据源不可用（不静默）');
        }
        const report = conventionReport(kernel);
        if (report === null) {
          throw new McpFailure('RESOURCE_UNAVAILABLE', '校验服务未装配或尚未运行：没有可读的 report.failedRules（不静默）');
        }
        return { failedRules: report.failedRules };
      }
      case KOJO_RESOURCE_URIS.commands:
        return { commands: deps.getCommands() };
      case KOJO_RESOURCE_URIS.plugins: {
        if (!kernel) {
          throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：插件状态数据源不可用（不静默）');
        }
        const records = kernel.plugins.list().filter(
          (r): r is Record<string, unknown> => !!r && typeof r === 'object',
        );
        const active: unknown[] = [];
        const inactive: Record<string, unknown>[] = [];
        const missing: Record<string, unknown>[] = [];
        for (const r of records) {
          const entry: Record<string, unknown> = {
            id: asString(r['id']),
            ...(typeof r['version'] === 'string' ? { version: r['version'] } : {}),
            status: asString(r['status']),
          };
          if (r['status'] === 'active') {
            active.push(entry);
          } else {
            // inactive 必须可见：missing[] 一律给数组（缺字段显式补，不静默）。
            entry['missing'] = Array.isArray(r['missing']) ? r['missing'] : [];
            if (typeof r['error'] === 'string') entry['error'] = r['error'];
            inactive.push(entry);
            if (Array.isArray(r['missing']) && (r['missing'] as unknown[]).length > 0) {
              missing.push({ id: asString(r['id']), missing: r['missing'] });
            }
          }
        }
        return { active, inactive, missing };
      }
      case KOJO_RESOURCE_URIS.events: {
        if (!kernel) {
          throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：事件环形缓冲未绑定（不静默）');
        }
        return readEvents(500);
      }
      case KOJO_RESOURCE_URIS.tasks: {
        // 长任务表：轮询读的真源（服务端不推送）。按会话过滤 ⇒ 必须用真 scope，不许 null 顶替。
        const legs = deps.tasks;
        if (!legs) {
          throw new McpFailure(
            'RESOURCE_UNAVAILABLE',
            'resource kojo://tasks 没有已接线的真源：宿主未注入长任务面（不静默、不空表冒充「没有在跑的任务」）',
          );
        }
        return legs.list(scope);
      }
      default:
        throw new McpFailure('RESOURCE_UNAVAILABLE', `resource ${sanitizeEcho(uri)} 没有已接线的真源（不静默）`);
    }
  };
}

/* ------------------------------- 追加 resource：外部写盘失效账本 ------------------------------- */

/**
 * `kojo://project/fs-freshness`（Wave4 余项 ③，宿主侧追加的第 9 项）。
 *
 * 走 `McpWiringSources.resources` 登记（`@kojo/mcp-host` 的冻结契约表零改动）：registry 直接调
 * 本资源的 `read(scope)`，因此**不经过 `slimResourceData`**——新增字段不会被投影丢掉，
 * 但文本上限仍复用 `truncateResourceText`（24 000 字符 + 结构化 `truncated` envelope，铁律 4）。
 *
 * 内容全部来自真源：`kernel.fileWatch.state()`（`start_watch` 回执：哪些根监视上了、
 * 哪些没监视上、为什么）+ 总线 `file.changed` / `file.watchState` 的有界短账 +
 * 本宿主写腿的自写记账。能力面自述（`push.subscribe:false` / `listChanged:false` /
 * `mode:'on-request'`）随读数一起给，客户端才知道「这里没有推送」是判性结论而不是漏接。
 */
export function createFsFreshnessResource(deps: McpIoDeps): McpResource {
  return {
    uri: KOJO_RESOURCE_URIS.fsFreshness,
    name: '外部写盘失效账本',
    description:
      '文件监视覆盖（含没监视上的根与原因）+ 最近被改动的路径与时刻 + 只读应答里 stale 的判据自述；' +
      '无协议级推送，失效事实随读取给（on-request）。B13 起只读腿走读时 mtime 复核：' +
      '应答里 recheck.basis:"mtime-recheck" 的 stale:false 是"复核核过盘态、证明没变"；' +
      'recheck:null 的 false 才是"监视事件流没报到改动"（窗外没多付 syscall）；' +
      '复核做不了 ⇒ null + 理由，绝不乐观判没变',
    mimeType: 'application/json',
    read: async (scope: McpSessionScope) => {
      const tracker = trackerOf(deps);
      if (!tracker) {
        throw new McpFailure(
          'RESOURCE_UNAVAILABLE',
          '外部写盘失效账本未装配：宿主未绑定 fs-freshness 判定器（内核未到场或 MCP 真源未登记）' +
            '——没有账本可读，不返回空账冒充「一切正常」（不静默）',
        );
      }
      const report = tracker.report({ maxEntries: 50 });
      const sessionView = tracker.sessionView(scope?.sessionId, 20);
      const payload = { ...report, session: sessionView };
      const { text } = truncateResourceText(JSON.stringify(payload, null, 2));
      return { contents: [{ uri: KOJO_RESOURCE_URIS.fsFreshness, text }] };
    },
  };
}
