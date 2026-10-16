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
 */

import type { FileIO, OpJournal, Plugin, ProjectService } from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from './engine';

export function createSavParserPlugin(): Plugin {
  return {
    id: 'sav-parser',
    version: '0.3.0',
    provides: [WellKnownServices.SnapshotSource, WellKnownServices.SnapshotWriter],
    requires: [KernelServices.IO, KernelServices.Project],
    activate(ctx) {
      const io = ctx.inject<FileIO>(KernelServices.IO);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      // 批操作 journal（2026-10-16 undo 批，additive 可选）：缺席 = 注入行为退回原样
      const journal = ctx.tryInject<OpJournal>(KernelServices.Ops);

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

      // 读写职责分离：只读消费者依赖 snapshot.source；注入面板依赖 snapshot.writer
      ctx.provide(WellKnownServices.SnapshotSource, engine);
      ctx.provide(WellKnownServices.SnapshotWriter, engine);

      const scanSafely = (): void => {
        void engine.scan().catch((err: unknown) => {
          ctx.log.error(`Snapshot scan failed: ${String(err)}`);
        });
      };

      // 响应式：项目打开 → 自动扫描；项目关闭 → 清空
      ctx.onDispose(ctx.bus.on('project.opened', () => scanSafely()));
      ctx.onDispose(ctx.bus.on('project.closed', () => engine.clear()));

      // 激活时项目已打开（插件晚于项目加载）→ 补扫一次
      if (project.current()) scanSafely();
    },
  };
}

export { SnapshotSourceEngine, type SnapshotEngineDeps } from './engine';
export { parseArchive, FORMAT_VERSION, MAGIC_GZIP, MAGIC_RAW } from './parse';
export { ByteReader, ArchiveParseError } from './binary';
export { gunzipBytes } from './gunzip';
export { gzipBytes, assembleArchiveFile } from './container';
export { verifyOverrides, type VerifyReport } from './verify';
