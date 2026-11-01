import { describe, expect, it } from 'vitest';
import type { FileIO, ScopedStorage } from '@kojo/plugin-api';
import {
  blankProjectDirName,
  blankSourceExtension,
  buildBlankProject,
  firstOpenPath,
  probeRememberedLocation,
  projectKindChoiceOf,
  projectKindChoices,
  readWizardProfile,
  REMEMBERED_LOCATION_FALLBACK_NOTICE,
  rememberedLocationView,
  rememberedRootAuthorized,
  WIZARD_PROFILE_KEY,
  writeWizardProfile,
} from '../src/new-project-flow';

/**
 * 新建流程通用半边（2026-11-02 NPF-1）。
 *
 * 判据只钉两件机器核得了的事：
 * 1. **没有游戏项目也能建**——类型分流里"口上作品"被标成不可选并给出下一步，
 *    但"空白工作区"恒可选；
 * 2. **产物与落点口径**——空白工作区只有 README + 起手文件，定位的是起手文件而不是说明；
 *    作者档案容错归空，读坏 / 写失败都不该挡住建项目。
 */

describe('projectKindChoices（新建什么）', () => {
  it('有游戏项目：两档都可选', () => {
    const choices = projectKindChoices(true);
    expect(choices.map((c) => c.value)).toEqual(['kojo', 'blank']);
    expect(choices.every((c) => c.disabledReason === null)).toBe(true);
  });

  it('没有游戏项目：口上作品不可选且说明"先打开游戏项目"，空白工作区仍可选', () => {
    const choices = projectKindChoices(false);
    const kojo = choices.find((c) => c.value === 'kojo')!;
    const blank = choices.find((c) => c.value === 'blank')!;
    expect(kojo.disabledReason).toContain('先打开游戏项目');
    expect(blank.disabledReason).toBeNull();
  });

  it('认不出的类型回落空白工作区（它不需要任何前置条件）', () => {
    expect(projectKindChoiceOf(projectKindChoices(false), 'kojo').value).toBe('kojo');
    expect(projectKindChoiceOf(projectKindChoices(false), 'blank').value).toBe('blank');
  });
});

describe('空白工作区（buildBlankProject）', () => {
  it('目录名 = 作品名 v版本（逐段消毒，没有角色段）', () => {
    expect(blankProjectDirName('  东方 合集  ', ' 1.0 ')).toBe('东方 合集 v1.0');
    expect(blankProjectDirName('a/b:c', '1.0')).toBe('abc v1.0');
  });

  it('ERB 起手：README + 一枚空白的正文文件（扩展名从语言档契约现算）', () => {
    expect(blankSourceExtension('erb')).toBe('.ERB');
    const out = buildBlankProject({
      workName: '东方合集',
      authorName: '张三',
      version: '1.0',
      sourceKind: 'erb',
    });
    expect(out.dirName).toBe('东方合集 v1.0');
    expect(Object.keys(out.files)).toEqual(['README.md', '正文.ERB']);
    expect(out.files['正文.ERB']).toBe('');
    expect(out.files['README.md']).toContain('# 东方合集');
    expect(out.files['README.md']).toContain('作者：张三');
    expect(out.files['README.md']).toContain('空白工作区');
  });

  it('笔记起手：文件名是 .md，作者留空时 README 明说未署名', () => {
    const out = buildBlankProject({
      workName: '设定集',
      authorName: '   ',
      version: '0.1',
      sourceKind: 'md',
    });
    expect(Object.keys(out.files)).toEqual(['README.md', '笔记.md']);
    expect(out.files['README.md']).toContain('（未填写署名）');
    expect(out.files['README.md']).toContain('版本：0.1');
  });

  it('空作品名不抛、也不生成非法目录名以外的内容（由向导的禁用态兜住创建）', () => {
    const out = buildBlankProject({ workName: ' ', authorName: '', version: '1.0', sourceKind: 'erb' });
    expect(out.dirName).toBe(' v1.0');
  });
});

describe('firstOpenPath（创建后定位哪枚文件）', () => {
  it('跳过 README，优先正文', () => {
    const p = firstOpenPath('C:\\work\\p1', '东方合集 v1.0', {
      'README.md': 'x',
      '正文.ERB': '',
    });
    expect(p).toBe('C:\\work\\p1\\东方合集 v1.0\\正文.ERB');
  });

  it('附加文件排在正文之前时，仍然挑正文（不把角色表当"我的正文"）', () => {
    const p = firstOpenPath('/work/p1', 'pkg', {
      'README.md': 'x',
      '角色表.csv': 'a,b',
      'M_KOJO_K1_日常.kojo': '',
    });
    expect(p).toBe('/work/p1/pkg/M_KOJO_K1_日常.kojo');
  });

  it('正文扩展名按契约单源大小写不敏感（.kojo1 / .erb / .erm 都认）', () => {
    expect(firstOpenPath('/w', 'p', { 'README.md': 'x', 'a.kojo1': '' })).toBe('/w/p/a.kojo1');
    expect(firstOpenPath('/w', 'p', { 'README.md': 'x', 'a.erb': '' })).toBe('/w/p/a.erb');
    expect(firstOpenPath('/w', 'p', { 'README.md': 'x', 'a.erm': '' })).toBe('/w/p/a.erm');
  });

  it('只有 README 时退回它（总比"什么都不打开"好）', () => {
    expect(firstOpenPath('/work/p1', 'pkg', { 'README.md': 'x' })).toBe('/work/p1/pkg/README.md');
  });

  it('没有正文但有其他文件 → 第一枚非 README', () => {
    expect(firstOpenPath('/work/p1', 'pkg', { 'README.md': 'x', '备注.txt': '' })).toBe(
      '/work/p1/pkg/备注.txt',
    );
  });

  it('空文件集 → null（不猜一个不存在的路径）', () => {
    expect(firstOpenPath('/work/p1', 'pkg', {})).toBeNull();
  });
});

/** 内存存储域替身（档案键 → 值；`get`/`set`/`delete`/`keys` 四件套） */
const fakeStore = (initial?: unknown): ScopedStorage & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set(WIZARD_PROFILE_KEY, initial);
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
    keys: async () => [...data.keys()],
  };
};

describe('作者档案（readWizardProfile / writeWizardProfile）', () => {
  it('没有存储域 → 空档案（向导与历史逐字一致）', async () => {
    expect(await readWizardProfile(undefined)).toEqual({});
    await expect(writeWizardProfile(undefined, { authorName: '张三' })).resolves.toBeUndefined();
  });

  it('写进去的档案能读回来（只保留认得的字段）', async () => {
    const store = fakeStore();
    await writeWizardProfile(store, {
      authorName: '  张三 ',
      version: '1.2',
      kind: 'blank',
      blankSource: 'md',
    });
    expect(await readWizardProfile(store)).toEqual({
      authorName: '张三',
      version: '1.2',
      kind: 'blank',
      blankSource: 'md',
    });
  });

  it('存储里是坏形状 / 越界值 → 一律当没有档案（不把半个档案渲染成默认值）', async () => {
    expect(await readWizardProfile(fakeStore('nope'))).toEqual({});
    expect(await readWizardProfile(fakeStore({ authorName: 7, kind: 'wat', blankSource: 'x' }))).toEqual({});
  });

  it('读抛错 / 写抛错都不外溢（档案只是默认值，不该让创建失败）', async () => {
    const broken = {
      ...fakeStore(),
      get: async () => {
        throw new Error('boom');
      },
      set: async () => {
        throw new Error('boom');
      },
    } as unknown as ScopedStorage;
    await expect(readWizardProfile(broken)).resolves.toEqual({});
    await expect(writeWizardProfile(broken, { authorName: '张三' })).resolves.toBeUndefined();
  });
});

describe('项目位置记忆（P0-6b）', () => {
  const fakeIo = (
    stat: (p: string) => Promise<{ isDirectory: boolean; size: number; mtimeMs: number } | null>,
  ): Pick<FileIO, 'stat'> => ({ stat }) as unknown as Pick<FileIO, 'stat'>;

  it('旧档案没有 location：读回来的形状与历史逐字一致，行为不变', async () => {
    const store = fakeStore({
      authorName: '张三',
      version: '1.0',
      kind: 'kojo',
      blankSource: 'erb',
    });
    const profile = await readWizardProfile(store);
    expect(profile).toEqual({ authorName: '张三', version: '1.0', kind: 'kojo', blankSource: 'erb' });
    expect(profile).not.toHaveProperty('location');
  });

  it('档案里的 location 能读回来（首尾空白归一；非法类型一律忽略）', async () => {
    expect(await readWizardProfile(fakeStore({ location: '  D:\\作品库  ' }))).toEqual({
      location: 'D:\\作品库',
    });
    expect(await readWizardProfile(fakeStore({ location: 7 }))).toEqual({});
  });

  it('有 location 且探针 ok → 预填该位置，位置行回显同一路径且不提示', () => {
    const view = rememberedLocationView('D:\\作品库', 'ok', 'C:\\data\\workspaces');
    expect(view.chosenRoot).toBe('D:\\作品库');
    expect(view.line).toBe('D:\\作品库');
    expect(view.notice).toBeNull();
  });

  it('失效回落（missing / not-directory / read-failed / not-writable）→ 默认位置 + 一句人话提示', () => {
    for (const status of ['missing', 'not-directory', 'read-failed', 'not-writable'] as const) {
      const view = rememberedLocationView('D:\\旧作品库', status, 'C:\\data\\workspaces');
      expect(view.chosenRoot).toBeNull();
      expect(view.line).toBe('（默认）C:\\data\\workspaces');
      expect(view.notice).toBe(REMEMBERED_LOCATION_FALLBACK_NOTICE);
    }
  });

  it('没有记忆位置 → 默认位置且不提示（与历史逐字一致）', () => {
    const view = rememberedLocationView(undefined, null, '/data/workspaces');
    expect(view.chosenRoot).toBeNull();
    expect(view.line).toBe('（默认）/data/workspaces');
    expect(view.notice).toBeNull();
  });

  it('清空回默认：不带 location 写档案，下次读不到 location（不会永久钉在旧目录）', async () => {
    const store = fakeStore({ authorName: '张三', location: 'D:\\旧作品库' });
    expect((await readWizardProfile(store)).location).toBe('D:\\旧作品库');
    // 「用默认位置」走的就是这条：整份档案重写且不带 location 键
    await writeWizardProfile(store, { authorName: '张三' });
    expect(await readWizardProfile(store)).not.toHaveProperty('location');
  });

  it('写档案失败（含 location）不外溢：选择位置 / 创建都不该被档案写失败挡住', async () => {
    const broken = {
      ...fakeStore(),
      set: async () => {
        throw new Error('boom');
      },
    } as unknown as ScopedStorage;
    await expect(writeWizardProfile(broken, { location: 'D:\\作品库' })).resolves.toBeUndefined();
  });

  it('probeRememberedLocation：目录在位 → ok；没有记忆路径 → null', async () => {
    const io = fakeIo(async () => ({ isDirectory: true, size: 0, mtimeMs: 0 }));
    expect(await probeRememberedLocation(io, 'D:\\作品库')).toBe('ok');
    expect(await probeRememberedLocation(io, null)).toBeNull();
  });

  it('probeRememberedLocation：stat 返回 null → missing；不是目录 → not-directory', async () => {
    expect(await probeRememberedLocation(fakeIo(async () => null), 'D:\\作品库')).toBe('missing');
    const fileIo = fakeIo(async () => ({ isDirectory: false, size: 1, mtimeMs: 0 }));
    expect(await probeRememberedLocation(fileIo, 'D:\\作品库\\README.md')).toBe('not-directory');
  });

  it('probeRememberedLocation：stat 抛错（读取失败）→ read-failed，不外溢', async () => {
    const broken = fakeIo(async () => {
      throw new Error('boom');
    });
    await expect(probeRememberedLocation(broken, 'D:\\作品库')).resolves.toBe('read-failed');
  });

  it('rememberedRootAuthorized：大小写 / 尾分隔符折叠后同一根才算在授权清单里', () => {
    expect(rememberedRootAuthorized('D:\\Works', ['d:\\works\\'])).toBe(true);
    expect(rememberedRootAuthorized('D:\\Works', ['D:\\works2'])).toBe(false);
    expect(rememberedRootAuthorized('/work/lib', ['/work/lib'])).toBe(true);
    expect(rememberedRootAuthorized('/work/lib', ['/work/lib-old'])).toBe(false);
  });
});
