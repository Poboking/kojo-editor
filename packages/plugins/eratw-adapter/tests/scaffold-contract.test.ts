import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CharaInfo, FileIO, GameAdapter, GameProject, PluginContext } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { createEratwAdapterPlugin } from '../src/plugin';
import { createErakumamaidAdapterPlugin } from '../../eraakumamaid-adapter/src/plugin';

/**
 * `GameAdapter.scaffold?()` 契约（v0.3 的落盘态位）——两个 adapter 各一条。
 *
 * 这条契约的意义是**不经 UI 直通**：脚本 / 批量初始化要能在没有面板的情况下
 * 把角色骨架铺进游戏目录。所以本组用例只钉三件事：
 * ① 落点按本游戏的布局（eraTW = 角色口上目录；eraAkumaMaid = 游戏根子树）；
 * ② 已存在不覆盖（游戏目录里可能是别人的东西）；
 * ③ 产物形态与本游戏的真实文件布局一致（eraAkumaMaid 的角色表 CSV 必须带 BOM）。
 *
 * 不测内容正确性——那是各包 `scaffold.test.ts` 的事。
 */
const GAME = 'C:/game';

function projectOf(charaIndex: Map<number, CharaInfo>, rootDir = GAME): GameProject {
  return {
    rootDir,
    adapterId: 'test',
    kojoPaths: [],
    writablePaths: [],
    charaIndex,
  };
}

/** 取插件里注册的 adapter（契约位的宿主） */
function adapterOf(createPlugin: () => { activate(ctx: PluginContext): void }, opts: {
  io: FileIO;
  project: GameProject;
}): GameAdapter {
  let adapter: GameAdapter | null = null;
  const ctx = {
    pluginId: 'test',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: () => {},
    bus: { emit: () => {}, on: () => () => {} },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return opts.io as unknown as T;
      if (key === 'kernel.project') return { current: () => opts.project } as unknown as T;
      // 本组只测 scaffold；工作区只要够 activate 走完（eratw 会拉一次项目列表）
      if (key === 'kernel.workspaces') {
        return {
          rootDir: () => '/appdata/workspaces',
          roots: () => ['/appdata/workspaces'],
          list: async () => [],
          projectDir: (id: string) => `/appdata/workspaces/${id}`,
          listDir: async () => [],
        } as unknown as T;
      }
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: unknown) => {
        if (slot === 'game.adapter') adapter = (item as { adapter: GameAdapter }).adapter;
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createPlugin().activate(ctx);
  if (adapter === null) throw new Error('插件未注册 game.adapter');
  return adapter;
}

let root: string;
let io: FileIOServiceImpl;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-scaffold-contract-'));
  io = new FileIOServiceImpl(new NodeBridge(root));
  io.setAppWritableRoots([root]);
});

describe('eraTW · scaffold 契约', () => {
  const kojoDir = (): string => path.join(root, 'kojo', '001 灵梦');

  it('落在该角色的个人口上目录，文件形态是扁平核心面空壳', async () => {
    const adapter = adapterOf(createEratwAdapterPlugin, {
      io,
      project: projectOf(new Map([[1, { no: 1, name: '灵梦', kojoDir: kojoDir() }]])),
    });

    const r = await adapter.scaffold!(1);

    expect(r.createdFiles.length).toBeGreaterThan(1);
    for (const f of r.createdFiles) expect(path.dirname(f)).toBe(kojoDir());
    await expect(fs.stat(path.join(kojoDir(), '事件.kojo'))).resolves.toBeDefined();
    expect(r.report.at(-1)).toContain(`${r.createdFiles.length} 个文件`);
  });

  it('角色没有个人口上目录 ⇒ 报错（不替调用方猜落点）', async () => {
    const adapter = adapterOf(createEratwAdapterPlugin, {
      io,
      project: projectOf(new Map([[1, { no: 1, name: '灵梦' }]])),
    });

    await expect(adapter.scaffold!(1)).rejects.toThrow(/没有个人口上目录/);
  });

  it('`faces` 只写点名的空壳', async () => {
    const adapter = adapterOf(createEratwAdapterPlugin, {
      io,
      project: projectOf(new Map([[1, { no: 1, name: '灵梦', kojoDir: kojoDir() }]])),
    });

    const r = await adapter.scaffold!(1, { faces: ['事件'] });

    expect(r.createdFiles).toHaveLength(1);
    expect(path.basename(r.createdFiles[0]!)).toBe('事件.kojo');
  });

  it('已存在不覆盖：第二次调用报错，原文件一字不动', async () => {
    const adapter = adapterOf(createEratwAdapterPlugin, {
      io,
      project: projectOf(new Map([[1, { no: 1, name: '灵梦', kojoDir: kojoDir() }]])),
    });

    await adapter.scaffold!(1, { faces: ['事件'] });
    const target = path.join(kojoDir(), '事件.kojo');
    const before = await fs.readFile(target);
    await expect(adapter.scaffold!(1, { faces: ['事件'] })).rejects.toThrow(/已存在，未覆盖/);
    expect(await fs.readFile(target)).toEqual(before);
  });
});

describe('eraAkumaMaid · scaffold 契约', () => {
  it('落在游戏根子树（ERB/EVENT_K/<n>/ + CSV/CHARA/），不是角色口上目录', async () => {
    const adapter = adapterOf(createErakumamaidAdapterPlugin, {
      io,
      project: projectOf(
        new Map([[67, { no: 67, name: '测试角色', kojoDir: 'C:/game/ERB/EVENT_K/67' }]]),
        root,
      ),
    });

    const r = await adapter.scaffold!(67);

    const rel = r.createdFiles.map((f) => path.relative(root, f).replaceAll('\\', '/'));
    expect(rel).toContain('CSV/CHARA/CHARA67.csv');
    expect(rel.some((p) => p.startsWith('ERB/EVENT_K/67/'))).toBe(true);
    // 落点是根：不存在「再套一层角色目录」这种按 eraTW 直觉的错位
    expect(rel.every((p) => !p.startsWith('kojo/'))).toBe(true);
  });

  it('角色表 CSV 是 UTF-8-BOM（游戏侧读表口径），且没有双 BOM', async () => {
    const adapter = adapterOf(createErakumamaidAdapterPlugin, {
      io,
      project: projectOf(new Map([[67, { no: 67, name: '测试角色' }]]), root),
    });

    await adapter.scaffold!(67);

    const bytes = await fs.readFile(path.join(root, 'CSV/CHARA/CHARA67.csv'));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // 第二枚 BOM 就说明落盘层又加了一遍
    const again = bytes.subarray(3).indexOf(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(again === -1 || again > 0).toBe(true);
    expect(bytes.subarray(3, 6)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('`faces` 收 `EVENT_K{n}` 形态的文件名干', async () => {
    const adapter = adapterOf(createErakumamaidAdapterPlugin, {
      io,
      project: projectOf(new Map([[67, { no: 67, name: '测试角色' }]]), root),
    });

    const r = await adapter.scaffold!(67, { faces: ['EVENT_K{n}'] });

    expect(r.createdFiles).toHaveLength(1);
    expect(path.basename(r.createdFiles[0]!)).toBe('EVENT_K67.kojo');
  });
});
