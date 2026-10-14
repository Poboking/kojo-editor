import type { FileIO } from '@kojo/plugin-api';
import { isTauri } from '../bridge/invoke';

/**
 * 从系统资源管理器拖文件进窗口即打开（drag-drop 批）。
 *
 * 链路：Rust 侧 `kojo:drag-drop` 事件（src-tauri/src/lib.rs）→ `subscribeDragDrop`
 * → 宿主落地 `processDroppedFiles`。**全程只读**——路径只喂给既有的打开入口
 * （requestOpenFile），编辑权限仍由写允许域既有分野决定，这里零写通道。
 */

/** 能拖进来打开的扩展名（小写、含点）；新增即改这一行 + 覆盖提示文案随它派生 */
export const OPENABLE_EXT: readonly string[] = ['.kojo', '.erb', '.erm', '.md', '.txt'];

/** 拒绝理由（面向零基础作者的中文人话，不出现内部词） */
export const UNKNOWN_FILE_REASON = '这类文件本软件打不开';
export const DIRECTORY_REASON = '拖进来要是文件，不是文件夹';
export const UNREADABLE_REASON = '找不到这个文件，或当前读不了它';
/** 未打开游戏项目时的落地拒绝文案（宿主在 phase ≠ 项目态时使用） */
export const PROJECT_GATE_MESSAGE = '拖进来的文件没有打开：请先在欢迎页选好游戏目录，再把文件拖进来。';

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
 * 只管扩展名这一层：目录判定字符串层面做不了，由 `processDroppedFiles` 的 stat 落地。
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
  return `这些文件没能打开：${parts.join('；')}`;
}

export interface DroppedFileLanding {
  /** 只需要 stat：落地处用它剔目录/失踪项，绝不给写通道留位置 */
  readonly io: Pick<FileIO, 'stat'>;
  readonly paths: readonly string[];
  readonly openFile: (path: string) => void;
  readonly notifyRejections: (message: string) => void;
}

/**
 * drop 落地（宿主调用）：扩展名分类 → 逐个 stat 剔掉目录与失踪项 → 可开的按拖入顺序
 * 逐个开标签；被拒的聚合成一条人话通知，不静默丢弃。
 */
export async function processDroppedFiles(landing: DroppedFileLanding): Promise<void> {
  const { io, paths, openFile, notifyRejections } = landing;
  const { files, rejected } = classifyDrop(paths);
  const all: RejectedDrop[] = [...rejected];
  for (const f of files) {
    const st = await io.stat(f);
    if (st === null) all.push({ path: f, reason: UNREADABLE_REASON });
    else if (st.isDirectory) all.push({ path: f, reason: DIRECTORY_REASON });
    else openFile(f);
  }
  if (all.length > 0) notifyRejections(formatRejections(all));
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
