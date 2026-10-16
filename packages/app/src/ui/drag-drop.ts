import type { FileIO } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { isTauri } from '../bridge/invoke';

/**
 * 从系统资源管理器拖文件/文件夹进窗口即打开（drag-drop 批）。
 *
 * 链路：Rust 侧 `kojo:drag-drop` 事件（src-tauri/src/lib.rs）→ `subscribeDragDrop`
 * → 宿主落地 `routeDroppedPaths`。**全程只读**——路径只喂给既有的打开入口
 * （开标签 / 开项目），编辑权限仍由写允许域既有分野决定，这里零写通道。
 */

/**
 * 能拖进来打开的扩展名（小写、含点）。
 *
 * ERB 方言那一段**不手抄**，从契约层单一真源 `plugin-api/erb-ext` 展开（FT-2 收口）：
 * 拖得开的集合与索引收的集合从此同一条口径，不会再出现"索引里有、拖进来被拒"。
 * 新增非方言类型才动这一行；覆盖提示文案由它派生（`App.tsx`）。
 */
export const OPENABLE_EXT: readonly string[] = ['.kojo', ...ERB_DIALECT_EXTENSIONS, '.md', '.txt'];

/**
 * 覆盖提示文案（拖拽悬停时浮层那句）。**由 {@link OPENABLE_EXT} 派生**，不另抄一份清单——
 * FT-2 的 `.ERH` 进面就是靠这条：清单加一项，提示自动跟着变，不会有"能拖不能说"的错位。
 */
export function dropHintText(): string {
  return `松手就能打开：${OPENABLE_EXT.join(' / ')}`;
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
/** 项目态拖入新文件夹但有脏标签：拒切，一句话说清，不静默也不弹多余确认框 */
export const DIRTY_SWITCH_REASON = '还有没保存的修改，先保存或关掉再换项目';
/** opening/boot 态拖入：项目还没就绪，什么都接不住——说一句，不静默 */
export const NOT_READY_MESSAGE = '正在准备界面，等就绪后再拖一次就能打开了。';

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
 */
export function classifyDrop(rawPaths: readonly string[]): ClassifiedDrop {
  const files: string[] = [];
  const rejected: RejectedDrop[] = [];
  for (const p of rawPaths) {
    const ext = extensionOf(fileNameOf(p));
    if (ext !== '' && OPENABLE_EXT.includes(ext)) files.push(p);
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
  /** 项目态下有没有脏标签（true = 拒绝切到别的项目，给一句人话不静默） */
  readonly hasUnsavedChanges: boolean;
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
 * - 项目态换目录但有脏标签 → 拒切并说人话；拖入当前目录 → 重载；
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
    else if (r.projectOpen && r.hasUnsavedChanges) rejected.push({ path: dir, reason: DIRTY_SWITCH_REASON });
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
  onEnter(): void;
  onOver(): void;
  onLeave(): void;
  onDrop(paths: string[]): void;
}

/**
 * 订阅 OS 文件拖放（形态照 `tauri-bridge.watchDirs`：动态 import + isTauri 守卫 +
 * 返回取消订阅）。浏览器开发壳没有这个平台能力 ⇒ 静默返回空取消函数，绝不抛——
 * 拖放是增强项，不该让网页壳报错。
 */
export async function subscribeDragDrop(handlers: DragDropHandlers): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  type Payload = { phase: DragDropPhase; paths: string[] };
  const unlisten = await listen<Payload>(DRAG_DROP_EVENT_NAME, (e) => {
    const { phase, paths } = e.payload;
    switch (phase) {
      case 'enter':
        handlers.onEnter();
        break;
      case 'over':
        handlers.onOver();
        break;
      case 'leave':
        handlers.onLeave();
        break;
      case 'drop':
        handlers.onDrop(paths);
        break;
    }
  });
  return () => unlisten();
}
