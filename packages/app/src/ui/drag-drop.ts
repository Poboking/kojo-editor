import type { FileIO } from '@kojo/plugin-api';
import {errorText,  ERB_DIALECT_EXTENSIONS, KOJO_V1_SOURCE_EXTENSIONS, basename } from '@kojo/plugin-api';
import { isTauri } from '../bridge/invoke';
import { joinPath } from './file-tree-ops';
import { kojo2SourceExtensions } from './kojo2-open';

/**
 * 从系统资源管理器拖文件/文件夹进窗口即打开（drag-drop 批）。
 *
 * 链路：Rust 侧 `kojo:drag-drop` 事件（src-tauri/src/lib.rs）→ `subscribeDragDrop`
 * → 宿主落地 `routeDroppedPaths`。**全程只读**——路径只喂给既有的打开入口
 * （开标签 / 开项目），编辑权限仍由写允许域既有分野决定，这里零写通道。
 *
 * B6 扩展（拖文件进树 = 复制进项目）：Rust 侧自本批起透传光标坐标（webview 客户区
 * 物理像素），drop 落点命中目录行/包节点（`data-drop-dir` 属性）时改走
 * `copyDroppedFiles` 复制链路（唯一写通道 = `kernel.io.copyFile`，只对 to 过闸）；
 * 未命中任何目录 → 原样走打开语义（A1 行为零变化）。
 */

/**
 * 能拖进来打开的扩展名（小写、含点）。
 *
 * ERB 方言那一段**不手抄**，从契约层单一真源 `plugin-api/erb-ext` 展开（FT-2 收口）：
 * 拖得开的集合与索引收的集合从此同一条口径，不会再出现"索引里有、拖进来被拒"。
 * 新增非方言类型才动这一行；覆盖提示文案由它派生（`App.tsx`）。
 */
export const OPENABLE_EXT: readonly string[] = [...KOJO_V1_SOURCE_EXTENSIONS, ...ERB_DIALECT_EXTENSIONS, '.md', '.txt'];

/**
 * 拖放**实际**认的扩展名 = {@link OPENABLE_EXT} + 开关打开时应追加的 2.0 后缀。
 *
 * 追加那一段取 `ui/kojo2-open.ts` 的 `kojo2SourceExtensions()`（开关只在那一个地方读）；
 * 开关关着时它返回空数组 ⇒ 本函数与 {@link OPENABLE_EXT} 逐项相同，拖放行为与改动前**逐字
 * 一致**（`erh-open-surface.test.ts` 还钉着悬停文案的逐字形态）。
 *
 * 为什么不在 `OPENABLE_EXT` 上就地追加：那是一枚**静态**导出常量（改前清单也是它），
 * 在模块求值时读开关等于把"窗口重载后才生效"焊进拖放判据；本函数每次现读，判据与
 * 语言面/路由面同一时刻生效。
 */
export function openableExtensions(): readonly string[] {
  const extra = kojo2SourceExtensions();
  return extra.length === 0 ? OPENABLE_EXT : [...OPENABLE_EXT, ...extra];
}

/**
 * 覆盖提示文案（拖拽悬停时浮层那句）。**由 {@link openableExtensions} 派生**，不另抄一份
 * 清单——FT-2 的 `.ERH` 进面就是靠这条：清单加一项，提示自动跟着变，不会有"能拖不能说"
 * 的错位。开关关着时文案与 `OPENABLE_EXT` 派生的那一句逐字相同。
 */
export function dropHintText(): string {
  return `松手就能打开：${openableExtensions().join(' / ')}`;
}

/** 拒绝理由（面向零基础作者的中文人话，不出现内部词） */
export const UNKNOWN_FILE_REASON = '这类文件本软件打不开';
/** 文件落地面里目录仍不给开（stat 落地处剔下时给的理由） */
export const DIRECTORY_REASON = '拖进来要是文件，不是文件夹';
export const UNREADABLE_REASON = '找不到这个文件，或当前读不了它';
/** 未打开项目时拖文件的拒绝理由：逐文件进聚合通知（宿主不再单独弹 gate） */
export const PROJECT_GATE_MESSAGE = '没打开游戏项目之前，文件拖不进来：请先在欢迎页选好游戏目录。';
/** 一次拖了多个文件夹：第一个生效，其余进聚合通知 */
export const ONE_DIRECTORY_REASON = '文件夹一次只打开一个，其余先忽略';
/** opening/boot 态拖入：项目还没就绪，什么都接不住——说一句，不静默 */
export const NOT_READY_MESSAGE = '正在准备界面，等就绪后再拖一次就能打开了。';

/* ------- 检测失败的人话化（ProjectDetectionError 绝不让内部术语上屏，铁律 4） ------- */

/**
 * 判定是否 `ProjectDetectionError`：只认 `name`（跨 realm 稳），不做 message 字符串匹配
 * ——message 是内核给开发者的英文原文，用户面绝不能透传（"No registered game adapter…"）。
 */
export function isProjectDetectionError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ProjectDetectionError';
}

/** 检测失败的人话（其它入口：欢迎页对话框 / recent 点击）——只报错，不引导。
 *  壳层零游戏名词（铁律 1）：支持哪些游戏是适配器的事，这里不点名，只说"不认识"。 */
export function notGameDirMessage(dir: string): string {
  return `「${basename(dir)}」不是可识别的游戏目录。`;
}

/** 拖拽这条路径检测失败：顺势引导去「导入项目」向导的人话 */
export function dragDropImportHintMessage(dir: string): string {
  return `「${basename(dir)}」不是游戏目录——已打开「导入项目」向导，可作为口上项目导入。`;
}

/**
 * 判定是否 `AdapterConflictError`：同样只认 `name`。
 * 多适配器同时认领是**程序性冲突**（识别规则重叠），不是用户选错目录，文案必须分开。
 */
export function isAdapterConflictError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AdapterConflictError';
}

/** 适配器冲突的人话：点名「谁和谁」（displayName 来自适配器，宿主不内置游戏名） */
export function adapterConflictMessage(e: unknown, dir: string): string {
  const candidates = (e as { candidates?: Array<{ displayName?: unknown; adapterId?: unknown }> })
    ?.candidates;
  const names = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (typeof c?.displayName === 'string' ? c.displayName : String(c?.adapterId ?? '')))
    .filter((name) => name.length > 0);
  const who = names.length > 0 ? names.join('、') : '多个游戏适配器';
  return `「${basename(dir)}」同时被 ${who} 认领，无法确定该用哪一套规则。请把这一屏反馈给作者。`;
}

/**
 * `workspace.importRequested` 载荷（口径对齐 eratw-adapter 的 kojo.importKojoProject 命令）：
 * 末段名做预填建议；根目录（`/`、`C:\`）没有末段 → 不带 suggestedName 键，
 * 绝不让空串混进事件载荷，由导入向导按自己的回退链取名。
 */
export function importRequestedPayload(
  dir: string,
): { sourceDir: string; suggestedName?: string; source: string } {
  const suggestedName = basename(dir);
  return {
    sourceDir: dir,
    ...(suggestedName.length > 0 ? { suggestedName } : {}),
    source: 'drag-drop',
  };
}

export interface RejectedDrop {
  readonly path: string;
  readonly reason: string;
}

export interface ClassifiedDrop {
  readonly files: string[];
  readonly rejected: RejectedDrop[];
}

function fileNameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

/** `.kojo` 这类整名以点开头的文件视为无扩展名（i > 0），与 `extname` 口径一致 */
function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * 按扩展名把拖入路径分成"可开 / 被拒"两组，各自保持拖入顺序。
 * 只管扩展名这一层：目录判定字符串层面做不了，由 stat 落地（见 `splitByStat`）。
 *
 * 认的清单取 {@link openableExtensions}（不是静态的 `OPENABLE_EXT`）：开关打开时 2.0 的
 * `.kojo2` 也拖得进来；关着时两份清单逐项相同，行为与改动前一致。
 */
export function classifyDrop(rawPaths: readonly string[]): ClassifiedDrop {
  const files: string[] = [];
  const rejected: RejectedDrop[] = [];
  const openable = openableExtensions();
  for (const p of rawPaths) {
    const ext = extensionOf(fileNameOf(p));
    if (ext !== '' && openable.includes(ext)) files.push(p);
    else rejected.push({ path: p, reason: UNKNOWN_FILE_REASON });
  }
  return { files, rejected };
}

export type DropOverlayState = 'hidden' | 'shown';

export type DropOverlayEvent = { readonly type: 'enter' | 'over' | 'leave' | 'drop' };

/**
 * 覆盖提示状态机。enter/over 亮、leave/drop 灭。
 * 必须幂等：WebView 里 dragover（对应 over）每秒几十次刷屏，
 * enter/over 在已亮时原样返回 'shown'，宿主 setState 同值即不重渲染（同族处理见
 * `panel-drop.nextDropTarget` 的"闪断即噪声"口径）。
 */
export function nextDropOverlay(current: DropOverlayState, event: DropOverlayEvent): DropOverlayState {
  switch (event.type) {
    case 'enter':
    case 'over':
      return current === 'shown' ? current : 'shown';
    case 'leave':
    case 'drop':
      return current === 'hidden' ? current : 'hidden';
  }
}

export function formatRejections(rejected: readonly RejectedDrop[]): string {
  const parts = rejected.map((r) => `${fileNameOf(r.path)}（${r.reason}）`);
  return `这些没能打开：${parts.join('；')}`;
}

/** stat 三态拆分的结果（各组都保持拖入顺序） */
export interface DroppedPathsByKind {
  readonly directories: string[];
  readonly files: string[];
  /** stat 拿不到：失踪 / 无权限——不管在哪个 phase 都不许静默丢弃 */
  readonly unreadable: string[];
}

/**
 * 逐路径 stat 分三态。目录判定只有文件系统说了算（字符串层面做不了），
 * 所以 stat 在扩展名分类**之前**：文件夹不管叫什么名字都是项目入口。
 */
export async function splitByStat(
  paths: readonly string[],
  io: Pick<FileIO, 'stat'>,
): Promise<DroppedPathsByKind> {
  const directories: string[] = [];
  const files: string[] = [];
  const unreadable: string[] = [];
  for (const p of paths) {
    const st = await io.stat(p);
    if (st === null) unreadable.push(p);
    else if (st.isDirectory) directories.push(p);
    else files.push(p);
  }
  return { directories, files, unreadable };
}

export interface DropRouting {
  /** 只需要 stat：落地处用它分三态，绝不给写通道留位置 */
  readonly io: Pick<FileIO, 'stat'>;
  readonly paths: readonly string[];
  /** 已打开项目（phase = project）：文件开标签、目录可切换/重载 */
  readonly projectOpen: boolean;
  /** 当前项目根目录（null = 未开）；拖入同一个目录视作重载 */
  readonly currentProjectDir: string | null;
  readonly openFile: (path: string) => void;
  readonly openProject: (dir: string) => void;
  readonly reloadProject: () => void;
  readonly notify: (message: string) => void;
}

/**
 * drop 落地总路由（宿主调用）：
 * - 文件夹是项目入口（欢迎页与项目态同权，对标 VSCode）：第一个生效，其余进聚合通知；
 * - 项目态换目录 → 交给宿主 openProject（SAFE-1 起换根脏确认收口在它的守卫里，
 *   与 recent 点击 / chooseAndOpen 同一条决策链）；拖入当前目录 → 重载；
 * - 文件只在项目态开标签；欢迎页拖文件逐个给 gate 理由；
 * - 所有拒绝聚合成**一条**人话通知，绝不静默丢弃。
 */
export async function routeDroppedPaths(r: DropRouting): Promise<void> {
  const split = await splitByStat(r.paths, r.io);
  const rejected: RejectedDrop[] = split.unreadable.map((p) => ({ path: p, reason: UNREADABLE_REASON }));
  for (const [i, dir] of split.directories.entries()) {
    if (i > 0) {
      rejected.push({ path: dir, reason: ONE_DIRECTORY_REASON });
      continue;
    }
    if (r.projectOpen && r.currentProjectDir === dir) r.reloadProject();
    else r.openProject(dir);
  }
  if (split.files.length > 0) {
    if (r.projectOpen) {
      const { files, rejected: badExt } = classifyDrop(split.files);
      for (const f of files) r.openFile(f);
      rejected.push(...badExt);
    } else {
      for (const f of split.files) rejected.push({ path: f, reason: PROJECT_GATE_MESSAGE });
    }
  }
  if (rejected.length > 0) r.notify(formatRejections(rejected));
}

export interface DroppedFileLanding {
  /** 只需要 stat：落地处用它剔目录/失踪项，绝不给写通道留位置 */
  readonly io: Pick<FileIO, 'stat'>;
  readonly paths: readonly string[];
  readonly openFile: (path: string) => void;
  readonly notifyRejections: (message: string) => void;
}

/**
 * 文件落地面（stat 三态剔掉目录与失踪项 → 可开的按拖入顺序逐个开标签；
 * 被拒聚合成一条人话通知，不静默丢弃）。宿主主链路已改走 `routeDroppedPaths`
 * （文件夹即项目入口）；这里保留纯文件的落地面，供只读语义自证复用。
 */
export async function processDroppedFiles(landing: DroppedFileLanding): Promise<void> {
  const { io, paths, openFile, notifyRejections } = landing;
  const split = await splitByStat(paths, io);
  const rejected: RejectedDrop[] = [
    ...split.directories.map((p) => ({ path: p, reason: DIRECTORY_REASON })),
    ...split.unreadable.map((p) => ({ path: p, reason: UNREADABLE_REASON })),
  ];
  const { files, rejected: badExt } = classifyDrop(split.files);
  rejected.push(...badExt);
  for (const f of files) openFile(f);
  if (rejected.length > 0) notifyRejections(formatRejections(rejected));
}

/** Rust `DRAG_DROP_EVENT` 的事件名（与 src-tauri/src/lib.rs 的常量成对） */
export const DRAG_DROP_EVENT_NAME = 'kojo:drag-drop';

export type DragDropPhase = 'enter' | 'over' | 'leave' | 'drop';

export interface DragDropHandlers {
  /** enter/over 携带光标坐标（webview 客户区物理像素；B6 拖悬高亮的命入口） */
  onEnter(x: number, y: number): void;
  onOver(x: number, y: number): void;
  onLeave(): void;
  onDrop(paths: string[], x: number | null, y: number | null): void;
}

/**
 * 订阅 OS 文件拖放（形态照 `tauri-bridge.watchDirs`：动态 import + isTauri 守卫 +
 * 返回取消订阅）。浏览器开发壳没有这个平台能力 ⇒ 静默返回空取消函数，绝不抛——
 * 拖放是增强项，不该让网页壳报错。
 *
 * 坐标字段（B6）是 additive：老版本 Rust 不发 x/y，这里按可缺省读——
 * 缺了就把 null 交给宿主（宿主在坐标缺失时退回打开语义，不炸）。
 */
export async function subscribeDragDrop(handlers: DragDropHandlers): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  type Payload = { phase: DragDropPhase; paths: string[]; x?: number; y?: number };
  const unlisten = await listen<Payload>(DRAG_DROP_EVENT_NAME, (e) => {
    const { phase, paths, x, y } = e.payload;
    switch (phase) {
      case 'enter':
        handlers.onEnter(x ?? 0, y ?? 0);
        break;
      case 'over':
        handlers.onOver(x ?? 0, y ?? 0);
        break;
      case 'leave':
        handlers.onLeave();
        break;
      case 'drop':
        handlers.onDrop(paths, x ?? null, y ?? null);
        break;
    }
  });
  return () => unlisten();
}

/* ------------------- B6：拖文件到树内目录 = 复制进项目 ------------------- */

/** 拖入目录（文件夹）到目录行上：递归复制是新功能，本批只接文件——说人话，不静默 */
export const COPY_DIR_UNSUPPORTED_REASON = '文件夹暂不支持复制进项目，请拖文件';
/** 目标目录在只读区（写允许域之外）：预检拦截的统一口径（照 B1 文案风格） */
export const COPY_READONLY_REASON = '这个目录在只读区，文件放不进来。要先在「只读」徽章那里批准写权限。';
/** 目标已有同名文件：默认拒绝（不许静默覆盖——覆盖是数据毁灭），想覆盖请先删/改名 */
export function copyExistsReason(name: string): string {
  return `目标目录里已有同名文件「${name}」，为防覆盖没有复制`;
}

/** drop 落点计划（纯函数的输出形态）：命中目录行 = 复制；否则维持 A1 打开语义 */
export type DropAtPlan = { readonly kind: 'copy'; readonly targetDir: string } | { readonly kind: 'open' };

/**
 * drop 点 → 计划（纯函数，可单测）：`hitDir` 由 {@link dropTargetDirAt} 按坐标命中，
 * 这里只做决策。命中 → 复制进该目录；未命中（树外/文件行/欢迎页）→ 打开语义。
 */
export function planDropAt(hitDir: string | null): DropAtPlan {
  return hitDir ? { kind: 'copy', targetDir: hitDir } : { kind: 'open' };
}

/**
 * 命中判定（纯函数，可单测）：从 `elementFromPoint` 命中的最深元素**向上**找最近的
 * `[data-drop-dir]` 祖先——目录行可能只有 20px 高，命中其内层 span / 子行都算数。
 * 形态取 `Element` 的最小面（closest + dataset），node 单测可用替身。
 */
export function dropTargetDirFrom(el: { closest(selectors: string): unknown } | null): string | null {
  const hit = el?.closest('[data-drop-dir]') as { dataset?: { dropDir?: string } } | null | undefined;
  const dir = hit?.dataset?.dropDir;
  return dir ? dir : null;
}

/** Rust 坐标（webview 客户区物理像素）→ elementFromPoint 要的 CSS 像素 */
function cssPoint(x: number, y: number): [number, number] {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return [x / dpr, y / dpr];
}

/**
 * 物理像素 → CSS 像素并命中（DOM 适配层）：Rust 透传的坐标是 webview 客户区
 * **物理像素**（wry webview2 `ScreenToClient` 口径），`elementFromPoint` 吃 CSS 像素
 * ——除以 `devicePixelRatio` 兑换。node 测试环境没有 DOM，测试走 `dropTargetDirFrom`。
 */
export function dropTargetDirAt(x: number, y: number): string | null {
  if (typeof document === 'undefined') return null;
  const [cx, cy] = cssPoint(x, y);
  return dropTargetDirFrom(document.elementFromPoint(cx, cy));
}

/** 拖悬命中目录行的样式类（styles.css 同名规则；克制的描边 + 一层底色） */
export const DROP_HOVER_CLASS = 'kojo-drop-hover';

let hoverEl: Element | null = null;

/**
 * 拖悬高亮（Over 坐标驱动）：命中目录行加类、离开摘类。React 状态这里**刻意不用**
 * ——over 每秒刷屏几十次，直接操作 DOM 类既不重渲染也不打架（命中元素被 React
 * 重挂也只是类丢一次，下一个 over 事件立刻补上）。无命中 = 清掉旧高亮。
 */
export function updateDropHover(x: number, y: number): void {
  if (typeof document === 'undefined') return;
  const [cx, cy] = cssPoint(x, y);
  const el = document.elementFromPoint(cx, cy);
  const target = el?.closest('[data-drop-dir]') ?? null;
  if (hoverEl === target) return;
  hoverEl?.classList.remove(DROP_HOVER_CLASS);
  target?.classList.add(DROP_HOVER_CLASS);
  hoverEl = target;
}

/** 拖悬高亮收尾（leave/drop 必调；元素可能已被重挂，摘类尽力而为即可） */
export function clearDropHover(): void {
  hoverEl?.classList.remove(DROP_HOVER_CLASS);
  hoverEl = null;
}

export interface DropCopyInput {
  /** 复制链路需要的最小 io 面：stat（三态拆分）/ statFiles（防覆盖预检）/ copyFile / isWritable */
  readonly io: Pick<FileIO, 'stat' | 'statFiles' | 'copyFile' | 'isWritable'>;
  readonly paths: readonly string[];
  /** drop 命中的目标目录（`data-drop-dir` 的值，绝对路径） */
  readonly targetDir: string;
  readonly notify: (message: string) => void;
  /** 至少一个文件落了地 → 失效目标目录（宿主 bump 树刷新 nonce） */
  readonly onLanded: () => void;
}

/** 复制失败聚合的前缀（与 formatRejections 的「打开」分家：动词不同不算复读） */
function formatCopyRejections(rejected: readonly RejectedDrop[]): string {
  const parts = rejected.map((r) => `${fileNameOf(r.path)}（${r.reason}）`);
  return `这些没能复制：${parts.join('；')}`;
}

/**
 * 拖文件到树内目录的复制落地（B6）。纪律：
 *
 * - **只复制文件**：目录递归复制是新功能，拖目录进来给一句人话，绝不静默；
 * - **预检在先，零绕闸**：目标目录不可写（只读游戏区）→ 全部文件人话拒绝，
 *   `copyFile` 一次都不碰（写允许域只对 to 断言，from 是读取源不受限）；
 * - **默认拒绝覆盖**：`copyFile` 是后写为准（会覆盖同名目标），这里先 `statFiles`
 *   查重，同名一律拒绝并说人话——覆盖是数据毁灭，宁可让用户手动改名；
 * - 多文件逐个复制，聚合反馈：成功一句（「已复制 N 个文件到 X」）、失败一条清单
 *   （照 formatRejections 形态）；部分成功时两条各说各话，绝不静默丢弃。
 */
export async function copyDroppedFiles(input: DropCopyInput): Promise<void> {
  const { io, paths, targetDir, notify, onLanded } = input;
  const split = await splitByStat(paths, io);
  const rejected: RejectedDrop[] = [
    ...split.directories.map((p) => ({ path: p, reason: COPY_DIR_UNSUPPORTED_REASON })),
    ...split.unreadable.map((p) => ({ path: p, reason: UNREADABLE_REASON })),
  ];
  const files = split.files;
  if (files.length === 0) {
    if (rejected.length > 0) notify(formatCopyRejections(rejected));
    return;
  }

  // 预检第一道闸（kernel.isWritable）：不可行就整批人话拒绝，copyFile 一次都不碰
  if (!io.isWritable(targetDir)) {
    for (const f of files) rejected.push({ path: f, reason: COPY_READONLY_REASON });
    notify(formatCopyRejections(rejected));
    return;
  }

  // 防覆盖预检：statFiles 一趟查重（copyFile 是"后写为准"，查重必须在它前面）
  const targets = files.map((f) => joinPath(targetDir, fileNameOf(f)));
  const stats = await io.statFiles(targets);
  const copyPairs: Array<{ from: string; to: string }> = [];
  for (const [i, f] of files.entries()) {
    const name = fileNameOf(f);
    if (stats[i]?.exists) rejected.push({ path: f, reason: copyExistsReason(name) });
    else copyPairs.push({ from: f, to: targets[i]! });
  }

  let copied = 0;
  for (const { from, to } of copyPairs) {
    try {
      await io.copyFile(from, to);
      copied += 1;
    } catch (e: unknown) {
      const msg = errorText(e);
      rejected.push({ path: from, reason: `复制失败：${msg}` });
    }
  }

  if (copied > 0) {
    onLanded();
    const dirName = fileNameOf(targetDir.replace(/[\\/]+$/, ''));
    notify(`已复制 ${copied} 个文件到「${dirName}」`);
  }
  if (rejected.length > 0) notify(formatCopyRejections(rejected));
}
