/**
 * 归档读取单源契约（W13 ARCHIVE-READ）。
 *
 * 定位：把"**从归档里取东西**"这一类活收成一个判据——列举条目 / 取一个条目的字节 /
 * 解析一个条目 / 把一个条目落到盘上，四个动作只有一条链路（实现住归档解析插件，
 * 键 `archive.reader`）；展示用的字节格式化与条目路径解析也住本文件，插件不再各写一份。
 *
 * 为什么必须有这一份（实测到的漂移）：
 * - 消费方面板自写 `formatBytes` / 自写 `path.split(/[\\/]/)` 取末两段 = 与内核 paths
 *   通道**并存的第二份**判据（分隔符、大小写、盘符口径迟早漂）；
 * - 而"把条目落到盘上"这类动作一旦由面板自己拼目录，就必然落在**写允许域之外**
 *   （项目写授权与常驻可写根都不认它拼出来的路径）= 绕过只读闸。所以本契约把落盘
 *   收进来并**只留两种形态**，面板侧连一个目录参数都拿不到。
 *
 * 落盘铁律（架构铁律 6，本契约的**唯一**形态）：`ArchiveExtractRequest` **不接受任何
 * 目标路径参数**，只有两个合法落点——
 *   1. `kind: 'workspace'`：常驻可写根（作者工作区）内的固定子目录 `ARCHIVE_EXTRACT_DIR`
 *      —— 普通写路径，内核 io 第一道闸 + 宿主第二道闸照常生效；
 *   2. `kind: 'dialog'`：`FileIO.exportFile` 那条法定通道（对话框与写盘绑在同一个平台
 *      命令内，落点由用户显式选定，JS 拿不到落点决定权）。
 * 新增第三种落点 = 改本契约的联合类型，评审时看得见；不给"顺手传个目录"留参数位。
 *
 * 术语：archive（归档）统称，零游戏名词。
 */

import type { ArchiveParseOptions, SnapshotArchive, SnapshotScanResult, SnapshotSourceService } from './snapshot';
import type { FileIO } from './io';
import { basename, dirname, isPathUnder, join } from './paths';
import { isWindowsReservedDeviceNameSegment, normalizeEntryName } from './zip';

/** 归档读取服务键（实现 = 归档解析插件；只读消费者依赖本键，不再自己拼链路） */
export const ArchiveServices = {
  Reader: 'archive.reader',
} as const;

/**
 * `kind: 'workspace'` 的固定落点子目录名（**住在常驻可写根里**，不是 appData 野目录）。
 * 面板与实现只准引用本常量——两处各写一个字面量就是两条落点判据。
 */
export const ARCHIVE_EXTRACT_DIR = 'archive-extractions';

/** 取一个条目的落点请求（无目标路径参数，见文件头铁律） */
export type ArchiveExtractRequest =
  | { readonly kind: 'workspace'; readonly entryPath: string }
  | { readonly kind: 'dialog'; readonly entryPath: string; readonly title?: string };

/** 落盘结果（取消 = `cancelled: true` + `landing: ''`，不是错误） */
export interface ArchiveExtractOutcome {
  readonly kind: ArchiveExtractRequest['kind'];
  /** 源条目路径 */
  readonly entryPath: string;
  /** 实际落点绝对路径；对话框取消时为空串 */
  readonly landing: string;
  /** 落盘字节数 */
  readonly bytes: number;
  readonly cancelled: boolean;
}

/** 拒绝落盘的原因码（可读拒绝：每条都带人话消息） */
export type ArchiveExtractRefusal =
  /** 条目名畸形（zip-slip 形态：上跳 / 绝对路径 / 盘符 / 多分隔符） */
  | 'entry-name'
  /** 落点不在允许域（常驻可写根之外的任何目标） */
  | 'landing-domain'
  /** 工作区根不可用（无平台数据目录 ⇒ 没有合法的域内落点，如实拒绝） */
  | 'workspace-unavailable'
  /** 条目读不到（空归档 / 文件缺失——不写半截东西出去） */
  | 'entry-unreadable';

/** 落盘被拒（消费方面板呈现 `message`，`code` 供机器判定） */
export class ArchiveExtractError extends Error {
  constructor(
    public readonly code: ArchiveExtractRefusal,
    /** 与拒绝相关的**展示用**路径（可能是候选落点，绝不是写入目标参数） */
    public readonly at: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveExtractError';
  }
}

/**
 * 归档读取服务（键 `archive.reader`）。
 *
 * 与 `snapshot.source` 的关系：本服务**包裹**同一份解析引擎（实现方内部委托，
 * 不重做二进制协议），额外补上"取一个条目的字节"与"把条目落到合法落点"两件事。
 * 只读消费方面板只依赖本键——列档 / 深解析 / 落盘一条链，判据一份。
 */
export interface ArchiveReaderService extends Pick<SnapshotSourceService, 'parse'> {
  /** 扫描归档来源目录（列条目；无目录 / 无项目时 `dir` 为空串，显式呈现不报错） */
  scan(): Promise<SnapshotScanResult>;
  /** 最近一次扫描结果（未扫描 = null） */
  current(): SnapshotScanResult | null;
  /** 深解析一个条目（完整结构模型；`parse` 的同义别名，便于"条目"口径统一） */
  parseEntry(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive>;
  /** 取一个条目的**原始字节**（读侧不受写允许域约束；与解析用的是同一份字节） */
  readEntry(path: string): Promise<Uint8Array>;
  /**
   * 把一个条目落盘到**合法落点**（workspace 常驻可写根内 / dialog 法定通道）。
   * @throws ArchiveExtractError 条目名畸形、落点越界、工作区根不可用
   * @throws WriteNotAllowedError workspace 落点不在内核 io 可写域（第一道闸原样上抛）
   */
  extractEntry(request: ArchiveExtractRequest): Promise<ArchiveExtractOutcome>;
}

/* ------------------------------ 共享展示 / 路径原语 ------------------------------ */

/**
 * 字节数人类可读（B / KB / MB / GB；非法输入 → 占位符 `—`）。
 * **全仓归档读取链路只有这一份实现**：面板不得再写一个同名函数
 * （结构自证见 `plugins/ui-archive-browser/tests/single-source.test.ts`）。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]!}`;
}

/**
 * 条目文件名（走 `paths` 通道，不留第二份 `split(/[\\/]/)` 拼接）。
 */
export function archiveEntryFileName(path: string): string {
  return basename(path);
}

/**
 * 条目**展示用**短标签（父目录名 + 文件名；纯展示，不参与任何路径判定）。
 * 同样只用 `paths` 通道的 `dirname` / `basename`。
 */
export function archiveEntryLabel(path: string): string {
  const name = basename(path);
  const parentName = basename(dirname(path));
  return parentName.length === 0 ? name : `${parentName}/${name}`;
}

/**
 * 落盘用的**单层**条目名校验（zip-slip 闸）。
 *
 * 复用既有条目名校验 `normalizeEntryName`（绝对路径 / 盘符 / 上跳 / 空段 / NUL 全拒），
 * 再要求结果不含分隔符——多一层次目录就意味着要多一次 `ensureDir` 判据，
 * 而"取一个条目"的产物本来就是一个文件。
 *
 * 任何**来自容器内部的**条目名都必须先过这里再谈落盘；`archiveExtractFileName` 只是
 * "文件系统路径 → 单层名"的那一半。
 *
 * @throws ArchiveExtractError code `'entry-name'`
 */
export function assertArchiveEntryName(name: string): string {
  let normalized: string;
  try {
    normalized = normalizeEntryName(name);
  } catch (err) {
    throw new ArchiveExtractError(
      'entry-name',
      name,
      `归档条目名不能直接落盘：${name} —— ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (normalized.includes('/')) {
    throw new ArchiveExtractError(
      'entry-name',
      name,
      `归档条目必须是单层文件名才能落盘（收到多层名 ${normalized}）`,
    );
  }
  if (isWindowsReservedDeviceNameSegment(normalized)) {
    throw new ArchiveExtractError(
      'entry-name',
      name,
      `归档条目名是 Windows 保留设备名，无法落盘：${name}`,
    );
  }
  return normalized;
}

/**
 * 由条目路径推出落盘文件名：先按 `paths` 通道取 basename（文件系统路径天然收口掉上跳），
 * 再过条目名闸——两道都在契约里，插件侧不再各写一份。
 *
 * @throws ArchiveExtractError code `'entry-name'`
 */
export function archiveExtractFileName(entryPath: string): string {
  return assertArchiveEntryName(basename(entryPath));
}

/**
 * workspace 落点组装（**唯一的**一条拼接）：常驻可写根 + 契约固定子目录 + 闸过的文件名。
 * 三个输入里没有一个是"调用方递进来的目标目录"。
 */
export function archiveWorkspaceLanding(workspaceRoot: string, fileName: string): string {
  return join(workspaceRoot, ARCHIVE_EXTRACT_DIR, fileName);
}

/** 落点在允许域内吗（域外一律拒；与内核 io 第一道闸同判据的**前置**可读版） */
export function isArchiveLandingAllowed(workspaceRoot: string, landing: string): boolean {
  return isPathUnder(workspaceRoot, landing);
}

/** 契约要求的 io 能力面（实现方只用到这些原语——写侧一条都不绕） */
export type ArchiveReaderIo = Pick<
  FileIO,
  'readBytes' | 'writeBytes' | 'ensureDir' | 'isWritable' | 'exportFile'
>;
