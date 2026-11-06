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
 * - **Wave4 余项 ③（外部写盘感知 → 失效信号）**：只读腿的应答一律附 `fsFreshness` 字段
 *   （判定器 / 真源出处 / 监视覆盖 / 有界账读数），真源见 `./fs-freshness`：
 *   `kernel.fileWatch.state()`（`start_watch` 回执的宿主侧形态）+ 总线 `file.changed` /
 *   `file.watchState`。本批**只做感知与标注**：写腿的响应形状、双闸与落盘语义零改动，
 *   只在广播同一调用栈里补一次自写记账（`noteSelfWrite`，用于把「自己刚写的」与「外部改的」
 *   分开归因）；**绝不新建写通道、绝不因感知需要而放宽写闸**。
 *   判定缺席一律可见：监视不可用 / 路径不在监视域 / 会话内没有可比基线 / 账已溢出
 *   ⇒ `stale:null` + `staleReason`，绝不用乐观 `false`、绝不用空串或默认值假装有。
 * - 长任务面（Wave4 余项⑤「长任务 progress」· ADR-0013 P5「Tasks over MCP」）：`tasks.start` /
 *   `tasks.status` / `tasks.cancel` 三枚具名工具与 `kojo://tasks` resource 都**只分派**给注入的
 *   `McpTaskLegs`（真源在 `real-sources-tasks.ts`：表、进度投影、有界性、取消语义都在那一层）。
 *   `deps.tasks` 缺席 ⇒ 工具显式 `NOT_WIRED`、resource 显式 `RESOURCE_UNAVAILABLE`（铁律 4：
 *   没有真任务表就不装出任务来，也不空表冒充「没有在跑的任务」）。`kojo://tasks` 的数据腿必须拿
 *   **真 scope**（表按 sessionId+clientId 隔离）——组装点过去给 `null` 顶替，本批一并修掉。
 */
import { McpFailure, truncateResourceText } from '@kojo/mcp-host';
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
import {
  fsFreshnessAbsentPayload,
  fsFreshnessPayload,
  type FsFreshnessTracker,
} from './fs-freshness';

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
   * 是否被 `cancel_search` 提前收尾（真 `SearchResult` 有这一位；长任务面按它判终态
   * `cancelled`，缺席按 false 处理 ⇒ 可选，既有假件零改动）。
   */
  readonly cancelled?: boolean;
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
  };
  readonly plugins: { readonly list: () => unknown[] };
  readonly services: { readonly tryGet: <T = unknown>(key: string) => T | undefined };
  readonly bus: {
    readonly on: (name: string, cb: (payload: unknown) => void) => () => void;
    /** 写成功后广播 `file.changed`（宿主刷新既有通道）；缺席 ⇒ 跳过并在结果里如实标注。 */
    readonly emit?: (name: string, payload: unknown) => void;
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
   * 外部写盘失效判定器（Wave4 余项 ③；生产由 `real-sources.ts` 绑定内核后给到，
   * 测试可注入或缺席）。缺席 ⇒ 只读应答仍附 `fsFreshness`，值如实为
   * `{available:false, stale:null, staleReason}`（铁律 4：字段不因缺席而消失）。
   */
  readonly fsFreshness?: () => FsFreshnessTracker | null;
  /** 长任务面（`tasks.*` 工具 + `kojo://tasks` 数据腿）；缺席 ⇒ 显式 NOT_WIRED。 */
  readonly tasks?: McpTaskLegs;
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
 * 单文件读取的失效标注：判定器在场就给完整判定（并把本次读取进账作为下次基线），
 * 缺席也**照样给字段**，值为 `stale:null` + 理由——客户端永远能区分「判定器没装」与「没改过」。
 */
function fsFreshnessField(
  deps: McpIoDeps,
  abs: string,
  rel: string,
  scope: McpSessionScope | null | undefined,
): Record<string, unknown> {
  if (abs === '') return fsFreshnessNoBasePayload(rel, 'file');
  const tracker = trackerOf(deps);
  if (!tracker) return fsFreshnessAbsentPayload(rel, 'file');
  try {
    return fsFreshnessPayload(tracker.verdictOf({ abs, rel, scope }));
  } catch (err) {
    return {
      available: false,
      stale: null,
      staleReason: `失效判定器调用失败（${err instanceof Error ? err.message : String(err)}）：无法判定，不冒充 false`,
      target: rel,
      granularity: 'file',
    };
  }
}

/** 目录 / 检索级标注：覆盖期内该目录下任何路径被动过即 `stale:true`。 */
function fsFreshnessListing(
  deps: McpIoDeps,
  dirAbs: string,
  dirRel: string,
  scope: McpSessionScope | null | undefined,
): Record<string, unknown> {
  if (dirAbs === '') return fsFreshnessNoBasePayload(dirRel, 'listing');
  const tracker = trackerOf(deps);
  if (!tracker) return fsFreshnessAbsentPayload(dirRel, 'listing');
  try {
    return fsFreshnessPayload(tracker.listingOf({ dirAbs, dirRel, scope }));
  } catch (err) {
    return {
      available: false,
      stale: null,
      staleReason: `失效判定器调用失败（${err instanceof Error ? err.message : String(err)}）：无法判定，不冒充 false`,
      target: dirRel,
      granularity: 'listing',
    };
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
    const cap = clampInt((args ?? {})['maxEntries'], 500, 1, 5000);
    const raw = (await kernel.io.walkDir(rootDir, {
      maxDepth,
      includeFiles: true,
      includeDirs: true,
    })) as unknown[];
    const entries: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (entries.length >= cap) break;
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      const path = asString(e['path']);
      if (path === '') continue;
      entries.push({
        path: toRelativePath(path, rootDir),
        name: asString(e['name']),
        isDirectory: e['isDirectory'] === true,
      });
    }
    return {
      root: '.',
      maxDepth,
      entries,
      total: raw.length,
      truncated: raw.length > entries.length,
      // 目录级失效标注（工具 projectFileTree 与 resource kojo://project/file-tree 同源同标注）。
      fsFreshness: fsFreshnessListing(deps, rootDir, '.', scope),
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
    const maxResults = clampInt((args ?? {})['maxResults'], 50, 1, 200);
    const result = await deps.searchInFiles({
      searchId: nextSearchId(),
      roots: [rootDir],
      query,
      options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] },
    });
    const hits: Record<string, unknown>[] = [];
    for (const file of result.files) {
      for (const match of file.matches) {
        if (hits.length >= maxResults) break;
        hits.push({ path: toRelativePath(file.path, rootDir), line: match.line, preview: match.preview });
      }
      if (hits.length >= maxResults) break;
    }
    return {
      hits,
      total: result.totalMatches,
      truncated: result.truncated || result.totalMatches > hits.length,
      filesScanned: result.filesScanned,
      elapsedMs: result.elapsedMs,
      skipped: result.skipped,
      // 检索结果是从盘上现算的：这里说「自你上一次从本根检索以来，根下动过几处」。
      fsFreshness: fsFreshnessListing(deps, rootDir, '.', scope),
    };
  };

  return { projectInfo, fileTree, searchAll };
}

/* ------------------------------- runSupplemental（IO 腿 + 写腿） ------------------------------- */

/**
 * 只读 IO 腿 + 写腿（fileTree.create / update / remove / rename）。写腿一律走**编辑器既有
 * 写通道**（内核 `kernel.io` 的 FileIO 写原语；删 / 改名也走此，绝不 `deps.invoke` 直调 Rust
 * 写命令绕开内核写允许域），前面叠第四张表 approvedRoots 复核（见模块头注释），绝不新建旁路
 * 写通道。`problems.quickFix` 与暂无真源的（diff.compare / state.replay / preview.document）由
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
    const maxResults = clampInt((args ?? {})['maxResults'], 200, 1, 500);
    const all = deps.getCommands();
    const commands = all.slice(0, maxResults).map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.tier !== undefined ? { tier: c.tier } : {}),
    }));
    return {
      commands,
      total: all.length,
      truncated: all.length > commands.length,
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
    const maxChars = clampInt(args['maxChars'], 24_000, 1, 200_000);
    const text = await deps.invoke('read_file_bytes', { path: abs });
    if (typeof text !== 'string') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'read_file_bytes 未返回文本（不静默）');
    }
    const { text: cut, truncated } = truncateChars(text, maxChars);
    return {
      path: rel,
      text: cut,
      textLength: text.length,
      truncated,
      // Wave4 ③：本次给的是 `atMs` 这一刻的盘态；`stale` 说的是「你上一次从本宿主读到的那份」
      // 之后盘上是否又被动过（真源 = 监视回执 + file.changed 短账，判不了即 null + 理由）。
      fsFreshness: fsFreshnessField(deps, abs, rel, scope),
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
        fsFreshness: fsFreshnessField(deps, abs, rel, scope),
      };
    }
    const s = stat as Record<string, unknown>;
    return {
      path: rel,
      exists: true,
      size: typeof s['size'] === 'number' ? s['size'] : null,
      mtimeMs: typeof s['mtimeMs'] === 'number' ? s['mtimeMs'] : null,
      isDirectory: s['isDirectory'] === true,
      fsFreshness: fsFreshnessField(deps, abs, rel, scope),
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
    const maxEntries = clampInt(args['maxEntries'], 500, 1, 5000);
    const raw = await deps.invoke('list_dir', { path: abs });
    const items: Record<string, unknown>[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (items.length >= maxEntries) break;
        if (!item || typeof item !== 'object') continue;
        const e = item as Record<string, unknown>;
        items.push({
          name: asString(e['name']),
          path: toRelativePath(asString(e['path']), rootDir),
          isDirectory: e['isDirectory'] === true,
        });
      }
    }
    const total = Array.isArray(raw) ? raw.length : 0;
    return {
      path: relativeOrDot(abs, rootDir),
      entries: items,
      total,
      truncated: total > items.length,
      // 目录级：覆盖期内该目录下任何路径被动过即 stale:true（逐条计数在 entries 账里）。
      fsFreshness: fsFreshnessListing(deps, abs, relativeOrDot(abs, rootDir), scope),
    };
  };

  const workspaceRoots: McpReaderFn = async (args) => {
    const maxResults = clampInt((args ?? {})['maxResults'], 50, 1, 200);
    const raw = await deps.invoke('workspace_roots');
    const roots = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
    return { roots: roots.slice(0, maxResults), total: roots.length, truncated: roots.length > maxResults };
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
    // scope:'sources' ⇒ 以 adapter 填充的作品域目录为根集合（契约字段投影，不硬编码领域）。
    const roots = searchRootsOf(project, rootDir, (args ?? {})['scope'] === 'sources');
    const maxResults = clampInt((args ?? {})['maxResults'], 50, 1, 200);
    const result = await deps.searchInFiles({
      searchId: nextSearchId(),
      roots,
      query,
      options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] },
    });
    const hits: Record<string, unknown>[] = [];
    for (const file of result.files) {
      for (const match of file.matches) {
        if (hits.length >= maxResults) break;
        hits.push({ path: toRelativePath(file.path, rootDir), line: match.line, preview: match.preview });
      }
      if (hits.length >= maxResults) break;
    }
    return {
      hits,
      total: result.totalMatches,
      truncated: result.truncated || result.totalMatches > hits.length,
      filesScanned: result.filesScanned,
      elapsedMs: result.elapsedMs,
      skipped: result.skipped,
      // 检索结果是从盘上现算的：`fsFreshness` 说「自你上一次检索以来，根下动过几处」。
      // 多根（scope:'sources'）只对第一根建基线，其余根在 target 里点名——不假装全覆盖。
      fsFreshness: fsFreshnessListing(
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

  /** 单个目标：路径闸（与 Rust 同尺）+ 域内解析（fail-closed）+ 写闸一（第四张表）⇒ 绝对路径。 */
  function resolveWriteTarget(rootDir: string, relPath: string, approvedRoots: readonly string[]): string {
    const abs = resolveWithinRoot(rootDir, relPath);
    assertMcpWriteDomain(approvedRoots, relPath); // 写闸一：第四张表（独立授权，不继承三张表）
    return abs;
  }

  /** 单目标写腿（create / update / remove，收 `relPath`）一次性取齐上下文 + 解析。 */
  function requireWriteTarget(
    args: Record<string, unknown>,
    scope: McpSessionScope,
  ): { readonly kernel: McpKernelLike; readonly rootDir: string; readonly relPath: string; readonly abs: string } {
    const { kernel, rootDir } = requireWriteContext();
    const relPath = asString(args['relPath']);
    const abs = resolveWriteTarget(rootDir, relPath, scope.approvedRoots);
    return { kernel, rootDir, relPath, abs };
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
    const { kernel, relPath, abs } = requireWriteTarget(input, scope);
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
    const { kernel, relPath, abs } = requireWriteTarget(input, scope);
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
    const { kernel, relPath, abs } = requireWriteTarget(input, scope); // 路径闸 + 域内解析 + 写闸一
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
    const { kernel, rootDir } = requireWriteContext();
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
    return { from: fromRel, to: toRel, renamed: true, refreshed: fromRefreshed && toRefreshed };
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

  const pathExists = async (args: Record<string, unknown>): Promise<unknown> => {
    const kernel = deps.getKernel();
    const project = requireProject(kernel);
    const rootDir = asString(project['rootDir']);
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：pathExists 无域基准根（不静默）');
    }
    const abs = resolveWithinRoot(rootDir, asString(args['relPath'])); // 路径闸 + 域内解析（fail-closed）
    const exists = await deps.invoke('path_exists', { path: abs });
    if (typeof exists !== 'boolean') {
      throw new McpFailure('TOOL_EXECUTION_FAILED', 'path_exists 未返回布尔值（不静默、不伪造）');
    }
    return { path: toRelativePath(abs, rootDir), exists };
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
    if (Array.isArray(raw)) {
      raw.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const e = entry as Record<string, unknown>;
        // 逐项失效标注用**请求侧解析出的绝对路径**为准（Rust 未回显 path 时也有基准，不猜）。
        const abs = asString(e['path']) !== '' ? asString(e['path']) : (kept[index] ?? '');
        const rel = toRelativePath(abs, rootDir);
        items.push({
          path: rel,
          exists: e['exists'] === true,
          size: typeof e['size'] === 'number' ? e['size'] : null,
          mtimeMs: typeof e['mtimeMs'] === 'number' ? e['mtimeMs'] : null,
          fsFreshness: fsFreshnessField(deps, abs, rel, scope),
        });
      });
    }
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

  const ioTools = new Map<string, (args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown> | unknown>([
    ['commands.list', commandsList],
    ['fs.readFile', readFile],
    ['fs.stat', statFile],
    ['io.listDir', listDir],
    ['io.workspaceRoots', workspaceRoots],
    ['workspace.searchAll', workspaceSearchAll],
    ['app.dataDir', appDataDir],
    ['codec.encodeString', encodeString],
    ['fs.pathExists', pathExists],
    ['fs.statFiles', statFiles],
    ['fileTree.create', fileTreeCreate],
    ['fileTree.update', fileTreeUpdate],
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
  ]);

  return async (name, args, scope) => {
    const tool = ioTools.get(name);
    if (tool) return tool(args ?? {}, scope);
    // 仍 NOT_WIRED 的写类 / 危险动作：逐个写明缺什么（不静默、不造假实现）。
    if (
      name.startsWith('fileTree.') ||
      name.startsWith('remove_') ||
      name.startsWith('rename_') ||
      name.startsWith('launcher_') ||
      name.startsWith('market_')
    ) {
      throw new McpFailure(
        'NOT_WIRED',
        `工具 ${name} 未接线：写类 / 危险动作不经 MCP 擅自开放执行（需宿主授权面）`,
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
          fsFreshness: fsFreshnessListing(deps, asString(project['rootDir']), '.', scope),
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
      '无协议级推送，失效事实随读取给（on-request）',
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
