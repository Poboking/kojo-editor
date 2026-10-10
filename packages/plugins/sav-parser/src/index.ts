/**
 * @kojo/plugin-sav-parser
 *
 * 存档二进制解析插件（服务 `snapshot.source`；v0.2 第四批 / v1.0 快照回放先行）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 引擎级通用二进制协议解析（跨游戏一致），**零游戏知识**；
 * - 项目侧语义（存档目录在哪）由 game adapter 经 `GameProject.savDir` 提供，
 *   本插件只消费、不解释（无此字段 → 扫描得空结果，显式呈现）；
 * - 纯读先行；写 / 注入（架构文档 §5.5 状态注入器）随 v1.1 扩展。
 *
 * 响应式：订阅 `project.opened` 自动扫描存档目录（浅解析列档，不阻塞事件）；
 * `project.closed` 清空。深解析由消费者按需调用 `parse(path)`。
 */

import type { FileIO, Plugin, ProjectService } from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from './engine';

export function createSavParserPlugin(): Plugin {
  return {
    id: 'sav-parser',
    version: '0.2.0',
    provides: [WellKnownServices.SnapshotSource],
    requires: [KernelServices.IO, KernelServices.Project],
    activate(ctx) {
      const io = ctx.inject<FileIO>(KernelServices.IO);
      const project = ctx.inject<ProjectService>(KernelServices.Project);

      const engine = new SnapshotSourceEngine({
        log: ctx.log,
        getProject: () => project.current(),
        readBytes: (p) => io.readBytes(p),
        listDir: (p) => io.listDir(p),
        stat: (p) => io.stat(p),
      });

      ctx.provide(WellKnownServices.SnapshotSource, engine);

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
