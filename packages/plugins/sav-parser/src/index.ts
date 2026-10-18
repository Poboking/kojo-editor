/**
 * @kojo/plugin-sav-parser
 *
 * 存档二进制解析插件（服务 `snapshot.source`；v0.2 第四批 / v1.0 快照回放先行）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 引擎级通用二进制协议解析（跨游戏一致），**零游戏知识**；
 * - 项目侧语义（存档目录在哪）由 game adapter 经 `GameProject.savDir` 提供，
 *   本插件只消费、不解释（无此字段 → 扫描得空结果，显式呈现）；
 * - 读（snapshot.source）与写（snapshot.writer，v0.2 第十五批注入链路）职责分离，
 *   但共用同一引擎实例——写链路含 Int64 守卫 / 双闸 / 备份 / 回读验证。
 *
 * 响应式：订阅 `project.opened` 自动扫描存档目录（浅解析列档，不阻塞事件）；
 * `project.closed` 清空。深解析由消费者按需调用 `parse(path)`。
 *
 * W13 ARCHIVE-READ：本插件同时是**归档读取单源**（`archive.reader`）的归属地——
 * 列条目 / 取一个条目的字节 / 解析一个条目 / 把一个条目落到合法落点四个动作一条链，
 * 消费方面板不再自写落盘与路径拼接。读侧与 `snapshot.source` 共用同一个引擎实例，
 * 落点只有契约里的两种形态（常驻可写根内 / `exportFile` 法定通道）。
 */

import type { FileIO, OpJournal, Plugin, ProjectService, WorkspaceService } from '@kojo/plugin-api';
import { ArchiveServices, KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from './engine';
import { ArchiveReaderEngine } from './archive-reader';

export function createSavParserPlugin(): Plugin {
  return {
    id: 'sav-parser',
    version: '0.3.0',
    provides: [WellKnownServices.SnapshotSource, WellKnownServices.SnapshotWriter, ArchiveServices.Reader],
    requires: [KernelServices.IO, KernelServices.Project],
    // 软依赖：工作区服务缺席时读侧照常工作，只有"落到常驻可写根"这条落点如实拒绝
    optionalRequires: [KernelServices.Workspaces],
    activate(ctx) {
      const io = ctx.inject<FileIO>(KernelServices.IO);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      // 批操作 journal（2026-10-16 undo 批，additive 可选）：缺席 = 注入行为退回原样
      const journal = ctx.tryInject<OpJournal>(KernelServices.Ops);
      // 作者工作区 = 常驻可写根（不受项目开闭清空）；缺席时由读取器转成可读拒绝
      const workspaces = ctx.tryInject<WorkspaceService>(KernelServices.Workspaces);

      const engine = new SnapshotSourceEngine({
        log: ctx.log,
        getProject: () => project.current(),
        readBytes: (p) => io.readBytes(p),
        listDir: (p) => io.listDir(p),
        stat: (p) => io.stat(p),
        writeBytes: (p, d) => io.writeBytes(p, d),
        backup: (p) => io.backup(p),
        journal: journal ?? undefined,
      });

      // 归档读取单源：包裹**同一个**引擎（列档/解析判据不另起一份）
      const reader = new ArchiveReaderEngine({
        log: ctx.log,
        source: engine,
        io,
        workspaceRoot: () => {
          if (!workspaces) throw new Error('kernel.workspaces 服务不可用');
          return workspaces.rootDir();
        },
      });

      // 读写职责分离：只读消费者依赖 snapshot.source / archive.reader；注入面板依赖 snapshot.writer
      ctx.provide(WellKnownServices.SnapshotSource, engine);
      ctx.provide(WellKnownServices.SnapshotWriter, engine);
      ctx.provide(ArchiveServices.Reader, reader);

      const scanSafely = (): void => {
        void engine.scan().catch((err: unknown) => {
          ctx.log.error(`Snapshot scan failed: ${String(err)}`);
        });
      };

      // 响应式：项目打开 → 自动扫描；项目关闭 → 清空
      ctx.onDispose(ctx.bus.on('project.opened', () => scanSafely()));
      ctx.onDispose(ctx.bus.on('project.closed', () => engine.clear()));

      // 缓存失效接线（2026-10-18 修复批）：**谁改盘谁发事件、谁消费谁逐出**——
      // 内核 io 的二进制写路径（writeBytes / removeFile / restoreBackup，撤销注入与
      // 恢复备份都从这里落盘）广播 `file.changed`，文件监视器对外部改盘兜底投同一条；
      // 本订阅把事件路径的深解析记忆显式逐出。**不能只信 mtime/size 判据**：
      // 注入原地改值字节数不变，FAT32/SMB/OneDrive 的 mtime 粒度可达 1–2s，
      // 撤销/恢复落在同一 tick 时判据同值 ⇒ 面板会一直显示注入前的旧值还毫无察觉
      // （内核铁律 4「不静默」）。路径判等口径见 engine.invalidate（pathKey 折叠写法）。
      ctx.onDispose(
        ctx.bus.on('file.changed', (ev) => {
          engine.invalidate(ev.path);
        }),
      );

      // 激活时项目已打开（插件晚于项目加载）→ 补扫一次
      if (project.current()) scanSafely();
    },
  };
}

export { SnapshotSourceEngine, type SnapshotEngineDeps } from './engine';
export { ArchiveReaderEngine, type ArchiveReaderDeps } from './archive-reader';
export { parseArchive, FORMAT_VERSION, MAGIC_GZIP, MAGIC_RAW } from './parse';
export { ByteReader, ArchiveParseError } from './binary';
export { gunzipBytes } from './gunzip';
export { gzipBytes, assembleArchiveFile } from './container';
export { verifyOverrides, verifyReadbackBytes, type VerifyReport } from './verify';
