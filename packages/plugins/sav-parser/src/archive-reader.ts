/**
 * 归档读取单源实现（契约 `plugin-api/archive.ts`，服务键 `archive.reader`）。
 *
 * 职责边界（"一切皆插件"）：
 * - **不重做二进制协议**：列条目 / 深解析全部委托同一个解析引擎实例（`snapshot.source`），
 *   本类只加"取一个条目的字节"与"把一个条目落到合法落点"两件事；
 * - 落盘只有契约里的两种形态：常驻可写根内（`kind:'workspace'`，普通写路径，内核 io
 *   第一道闸 + 宿主第二道闸照常生效）或法定导出通道（`kind:'dialog'` = `exportFile`，
 *   对话框与写盘绑在同一个平台命令内）。**没有**任何"调用方递目标路径"的参数位。
 *
 * 顺序即安全语义：条目名闸（zip-slip 形态）先于任何 IO；读失败先于任何写；
 * 落点判定先于 `ensureDir`（不在域内就连目录都不造）。
 */

import type {
  ArchiveExtractOutcome,
  ArchiveExtractRequest,
  ArchiveParseOptions,
  ArchiveReaderIo,
  ArchiveReaderService,
  Logger,
  SnapshotArchive,
  SnapshotScanResult,
  SnapshotSourceService,
} from '@kojo/plugin-api';
import {
  ArchiveExtractError,
  archiveExtractFileName,
  archiveWorkspaceLanding,
  isArchiveLandingAllowed,
} from '@kojo/plugin-api';
import { dirname } from '@kojo/plugin-api';

export interface ArchiveReaderDeps {
  log: Logger;
  /** 解析引擎（同一个实例：列档 + 深解析判据只有一份） */
  source: Pick<SnapshotSourceService, 'scan' | 'current' | 'parse'>;
  /** 内核 io 原语（写侧只用 `ensureDir` / `writeBytes` / `exportFile`，一条也不绕） */
  io: ArchiveReaderIo;
  /**
   * 常驻可写根（作者工作区默认根）。
   * 不可用时**抛**——本层转成 code `'workspace-unavailable'` 的可读拒绝，绝不退回到
   * "另找一个目录"（那正是绕过只读闸的形态）。
   */
  workspaceRoot(): string;
}

export class ArchiveReaderEngine implements ArchiveReaderService {
  constructor(private readonly deps: ArchiveReaderDeps) {}

  scan(): Promise<SnapshotScanResult> {
    return this.deps.source.scan();
  }

  current(): SnapshotScanResult | null {
    return this.deps.source.current();
  }

  parse(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive> {
    return this.deps.source.parse(path, opts);
  }

  parseEntry(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive> {
    return this.deps.source.parse(path, opts);
  }

  /** 取条目字节：读侧不受写允许域约束（只读的游戏目录照样读得到） */
  readEntry(path: string): Promise<Uint8Array> {
    return this.deps.io.readBytes(path);
  }

  async extractEntry(request: ArchiveExtractRequest): Promise<ArchiveExtractOutcome> {
    // 1) 名字闸先于一切 IO：畸形条目名（上跳 / 绝对路径 / 盘符 / 多分隔符）直接拒，不动盘
    const fileName = archiveExtractFileName(request.entryPath);

    // 2) 取字节（读失败 = 一个字节都不写）
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.io.readBytes(request.entryPath);
    } catch (err) {
      throw new ArchiveExtractError(
        'entry-unreadable',
        request.entryPath,
        `归档条目读不出来，未写任何字节：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3) dialog 形态：落点由系统对话框显式选定（法定域外写通道，JS 拿不到落点决定权）
    if (request.kind === 'dialog') {
      const picked = await this.deps.io.exportFile(fileName, bytes, {
        title: request.title ?? `取出归档条目「${fileName}」为…`,
      });
      if (picked === null) {
        this.deps.log.info(`Archive extract cancelled by user: ${request.entryPath}`);
        return { kind: 'dialog', entryPath: request.entryPath, landing: '', bytes: bytes.length, cancelled: true };
      }
      this.deps.log.info(`Archive extract exported: ${request.entryPath} → ${picked}（${bytes.length}B）`);
      return { kind: 'dialog', entryPath: request.entryPath, landing: picked, bytes: bytes.length, cancelled: false };
    }

    // 4) workspace 形态：落点 = 常驻可写根 + 契约固定子目录 + 闸过的文件名（三无：无路径参数）
    let root: string;
    try {
      root = this.deps.workspaceRoot();
    } catch (err) {
      throw new ArchiveExtractError(
        'workspace-unavailable',
        '',
        `没有可用的常驻可写根（作者工作区），归档条目不落盘：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const landing = archiveWorkspaceLanding(root, fileName);
    if (!isArchiveLandingAllowed(root, landing)) {
      throw new ArchiveExtractError(
        'landing-domain',
        landing,
        `落点不在常驻可写根内，已拒绝写入：${landing}（根：${root}）`,
      );
    }
    if (!this.deps.io.isWritable(landing)) {
      throw new ArchiveExtractError(
        'landing-domain',
        landing,
        `落点不在写允许域内（游戏目录整体只读，只写常驻可写根），已拒绝写入：${landing}`,
      );
    }

    // 判定全过才动盘；内核 io 的双闸仍在写这一跳上兜底（本层判定只是让理由可读）
    await this.deps.io.ensureDir(dirname(landing));
    await this.deps.io.writeBytes(landing, bytes);
    this.deps.log.info(`Archive extract written: ${request.entryPath} → ${landing}（${bytes.length}B）`);
    return { kind: 'workspace', entryPath: request.entryPath, landing, bytes: bytes.length, cancelled: false };
  }
}
