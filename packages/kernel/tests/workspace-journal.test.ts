import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileIO } from '@kojo/plugin-api';
import { FileIOServiceImpl, OpsJournalImpl } from '../src';
import { WorkspaceServiceImpl } from '../src/workspace';
import { NodeBridge } from './helpers/node-bridge';

/**
 * createArtifact × 批操作 journal（2026-10-16 undo 批）：
 * - 成功 → commit（操作历史可整批撤销，manifest 登记一并回退）；
 * - 中途失败 → abort 零残留（旧形态留半成品目录，重试撞 already exists——本批治理）。
 */

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let appData: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-wsj-'));
  appData = path.join(tmpDir, 'appdata');
});

async function makeWorld(ioOverride?: Partial<FileIO>): Promise<{
  ws: WorkspaceServiceImpl;
  ops: OpsJournalImpl;
  io: FileIOServiceImpl;
}> {
  const bridge = new NodeBridge(appData);
  const io = new FileIOServiceImpl(bridge, noopLog);
  const ops = new OpsJournalImpl({ bridge, io, log: noopLog });
  // ioOverride 覆盖写路径：类实例方法在原型上，spread 会丢——原型继承 + 自有字段 + 覆盖。
  // 覆盖闭包回落**真 io**（闸语义同源）；init 后把常驻根同步给真 io，回落调用不误拒。
  let ioForWs: FileIO = io;
  if (ioOverride) {
    ioForWs = Object.assign(Object.create(Object.getPrototypeOf(io)), io, ioOverride) as FileIO;
  }
  const ws = new WorkspaceServiceImpl({
    bridge,
    io: ioForWs,
    log: noopLog,
    journal: ops,
  });
  await ws.init();
  if (ioOverride) io.setAppWritableRoots([ws.rootDir()]);
  return { ws, ops, io };
}

const TWO_FILES = {
  'ERB/一.ERB': '第一份',
  'ERB/二.ERB': '第二份',
};

describe('createArtifact × journal', () => {
  it('成功：commit 进历史，undo 整批撤销（文件删除 + manifest 登记回退）', async () => {
    const { ws, ops } = await makeWorld();
    const project = await ws.create({ name: '撤销面测试' });
    const artifact = await ws.createArtifact(project.id, {
      name: '角色包',
      dirName: 'chara1',
      files: TWO_FILES,
    });
    expect(artifact.dirName).toBe('chara1');

    const records = await ops.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'scaffold', fileCount: 3 }); // 2 文件 + manifest
    const manifestBefore = await fs.readFile(
      path.join(ws.projectDir(project.id), 'workspace.json'),
      'utf-8',
    );
    expect(JSON.parse(manifestBefore).artifacts).toHaveLength(1);

    await ops.undo(records[0]!.id);

    // 文件全部删除（回收站兜底，原位清空）
    const dir = path.join(ws.projectDir(project.id), 'chara1');
    await expect(fs.access(dir)).rejects.toThrow();
    // manifest 登记同步回退：面板不再挂着空制品
    const manifestAfter = JSON.parse(
      await fs.readFile(path.join(ws.projectDir(project.id), 'workspace.json'), 'utf-8'),
    );
    expect(manifestAfter.artifacts).toHaveLength(0);
  });

  it('中途失败：abort 回滚已写文件（零残留），manifest 未登记，重试不再撞 already exists', async () => {
    let exploded = false; // 盘满只发生一次：重试（abort 治理后）应当成功
    const { ws, ops, io } = await makeWorld({
      // 第二份文件写失败（模拟盘满/越权）：第一份已落盘 → 旧形态半成品
      writeText: async (p: string, text: string, o?: Parameters<FileIO['writeText']>[2]) => {
        if (p.endsWith('二.ERB') && !exploded) {
          exploded = true;
          throw new Error('ENOSPC: 模拟盘满');
        }
        return io.writeText(p, text, o);
      },
    });
    const project = await ws.create({ name: '半成品治理' });

    await expect(
      ws.createArtifact(project.id, { name: '角色包', dirName: 'chara2', files: TWO_FILES }),
    ).rejects.toThrow(/ENOSPC/);

    // 零残留：制品目录里只剩空壳都不该有——已写的"一.ERB"被 abort 删除
    const dir = path.join(ws.projectDir(project.id), 'chara2');
    await expect(fs.access(path.join(dir, '一.ERB'))).rejects.toThrow();
    const manifest = JSON.parse(
      await fs.readFile(path.join(ws.projectDir(project.id), 'workspace.json'), 'utf-8'),
    );
    expect(manifest.artifacts).toHaveLength(0);

    // 历史无痕（abort 即撤销），重试成功不再撞 already exists
    expect(await ops.list()).toHaveLength(0);
    const artifact = await ws.createArtifact(project.id, {
      name: '角色包',
      dirName: 'chara2',
      files: TWO_FILES,
    });
    expect(artifact.dirName).toBe('chara2');
    expect(await ops.list()).toHaveLength(1);
  });
});
