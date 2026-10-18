import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
// 真实链路层：借用内核 io 做端到端落盘验证（与 deploy.test.ts 同一先例）
import { FileIOServiceImpl } from '../../kernel/src/io';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { writeScaffoldFiles } from '../src/scaffold-writer';

/**
 * 脚手架落盘（`GameAdapter.scaffold?()` 的实现半边）。
 *
 * 三条口径各钉一条：**不覆盖**（别人目录里的同名文件不许动）、
 * **建父目录**（游戏的目录层级比作者想的多）、**筛选生效**（`faces` 只影响写哪些）。
 */
let root: string;
let io: FileIOServiceImpl;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-kit-scaffold-'));
  io = new FileIOServiceImpl(new NodeBridge(root));
  io.setAppWritableRoots([root]);
});

const FILES: Record<string, string> = {
  'README.md': '# 说明',
  'ERB/EVENT_K/67/EVENT_K67.kojo': '口上: 主',
  'ERB/EVENT_K/67/COMM_K67.kojo': '口上: 通信',
};

describe('writeScaffoldFiles · 落盘', () => {
  it('按相对路径铺开，逐条报告，返回绝对路径', async () => {
    const r = await writeScaffoldFiles({ io, files: FILES, targetDir: root });

    expect(r.createdFiles).toHaveLength(3);
    for (const abs of r.createdFiles) {
      expect(abs.startsWith(root)).toBe(true);
      await expect(fs.readFile(abs, 'utf8')).resolves.toBeTypeOf('string');
    }
    // 深层目录被自动建出（调用方不必先 ensureDir）
    await expect(
      fs.readFile(path.join(root, 'ERB/EVENT_K/67/COMM_K67.kojo'), 'utf8'),
    ).resolves.toBe('口上: 通信');
    expect(r.report).toHaveLength(4); // 3 个文件 + 1 行汇总
    expect(r.report.at(-1)).toContain('共 3 个文件');
  });

  it('目标文件已存在 ⇒ 报错且**不覆盖**（原文逐字保留）', async () => {
    const abs = path.join(root, 'README.md');
    await fs.writeFile(abs, '别人的东西', 'utf8');

    await expect(writeScaffoldFiles({ io, files: FILES, targetDir: root })).rejects.toThrow(
      /已存在，未覆盖/,
    );
    await expect(fs.readFile(abs, 'utf8')).resolves.toBe('别人的东西');
  });

  it('`only` 只写点名的文件（其余连父目录都不建）', async () => {
    const r = await writeScaffoldFiles({
      io,
      files: FILES,
      targetDir: root,
      only: ['README.md'],
    });

    expect(r.createdFiles).toHaveLength(1);
    await expect(fs.stat(path.join(root, 'ERB'))).rejects.toThrow();
  });

  it('`only` 里的名字一个都不匹配 ⇒ 不写任何文件（不静默写全量）', async () => {
    const r = await writeScaffoldFiles({
      io,
      files: FILES,
      targetDir: root,
      only: ['不存在的面'],
    });

    expect(r.createdFiles).toHaveLength(0);
    expect(r.report.at(-1)).toContain('共 0 个文件');
  });
});
