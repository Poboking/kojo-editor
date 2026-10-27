import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorCommandContext } from '@kojo/plugin-api';
import type { CommandEntry } from '../src/ui/commands';
import { commandItems, orderCommandsByMru } from '../src/ui/palette-search';
import {
  COMMAND_MRU_KEY,
  COMMAND_MRU_LIMIT,
  loadCommandMru,
  normalizeCommandMru,
  recordCommandUse,
  saveCommandMru,
  touchCommandMru,
} from '../src/ui/command-mru';

/**
 * 命令面板最近使用（WS-16）的账与序。
 *
 * 钉两件事：①**账**（读写损坏容忍、去重、上限、写不进也不炸）；②**序**（MRU 只改顺序，
 * 不改过滤/禁用/高亮那几条判据——置顶一旦顺手换了尺子，命令面板就有了第二把排序真源）。
 */

/** 内存版 localStorage（node 环境没有 window；缺失态由"删掉 globalThis.window"另测） */
function fakeStorage(): Storage & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => map,
  };
}

const ctx = {} as EditorCommandContext;

const cmd = (id: string, title: string, category = '工作台'): CommandEntry => ({
  id,
  title,
  category,
  run: () => undefined,
});

const REGISTRY: readonly CommandEntry[] = [
  cmd('a.first', '第一条'),
  cmd('b.second', '第二条'),
  cmd('c.third', '第三条'),
  cmd('d.fourth', '第四条'),
];

describe('normalizeCommandMru / touchCommandMru · 清单本体', () => {
  it('只收非空字符串、去重保序、按上限截断（坏元素逐条丢，不半读）', () => {
    expect(normalizeCommandMru(['x', '', 'y', 1, null, 'x', undefined, 'z'])).toEqual(['x', 'y', 'z']);
    expect(normalizeCommandMru(['   '])).toEqual([]); // 光一串空白不算一条命令
    const many = Array.from({ length: 40 }, (_, i) => `id${i}`);
    const cut = normalizeCommandMru(many);
    expect(cut).toHaveLength(COMMAND_MRU_LIMIT);
    expect(cut[0]).toBe('id0');
    expect(cut).not.toContain(`id${COMMAND_MRU_LIMIT}`);
  });

  it('再点同一条只把它提前，不在清单里塞第二份（幂等靠"去重 + 队首"）', () => {
    const one = touchCommandMru([], 'a');
    const two = touchCommandMru(one, 'b');
    const again = touchCommandMru(two, 'a');
    expect(again).toEqual(['a', 'b']);
    expect(touchCommandMru(again, 'a')).toEqual(['a', 'b']);
  });

  it('超出上限挤掉最旧那条（队尾出局）', () => {
    let list: string[] = [];
    for (let i = 0; i < COMMAND_MRU_LIMIT + 3; i += 1) list = touchCommandMru(list, `id${i}`);
    expect(list).toHaveLength(COMMAND_MRU_LIMIT);
    expect(list[0]).toBe(`id${COMMAND_MRU_LIMIT + 2}`);
    expect(list).not.toContain('id0');
  });

  it('空 / 空白 id 不改账（点了个没有身份的行不该造出一条幽灵记录）', () => {
    expect(touchCommandMru(['a'], '')).toEqual(['a']);
    expect(touchCommandMru(['a'], '   ')).toEqual(['a']);
  });
});

describe('load / save / record · 存储面', () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('写下去读得回（同一条 JSON 数组，队首仍是最新）', () => {
    saveCommandMru(['a', 'b']);
    expect(loadCommandMru()).toEqual(['a', 'b']);
    expect(storage.dump().get(COMMAND_MRU_KEY)).toBe(JSON.stringify(['a', 'b']));
  });

  it('坏载荷一律空清单：坏 JSON / 非数组 / 全坏元素（缺省 = 与改动前逐字一致的码点序）', () => {
    storage.setItem(COMMAND_MRU_KEY, '{不是 JSON');
    expect(loadCommandMru()).toEqual([]);
    storage.setItem(COMMAND_MRU_KEY, JSON.stringify({ 0: 'a' }));
    expect(loadCommandMru()).toEqual([]);
    storage.setItem(COMMAND_MRU_KEY, JSON.stringify([1, null, {}]));
    expect(loadCommandMru()).toEqual([]);
  });

  it('recordCommandUse 落盘并返回**这一拍**的清单（调用方不回读存储拿旧账）', () => {
    saveCommandMru(['a']);
    const next = recordCommandUse('b');
    expect(next).toEqual(['b', 'a']);
    expect(loadCommandMru()).toEqual(['b', 'a']);
    expect(recordCommandUse('a')).toEqual(['a', 'b']);
  });

  it('没有 window（node / SSR）⇒ 读空、写不炸', () => {
    vi.unstubAllGlobals();
    expect(loadCommandMru()).toEqual([]);
    expect(() => saveCommandMru(['a'])).not.toThrow();
  });

  it('存储抛错（隐私模式 / 配额满）⇒ 本次照常，只丢下一次的账', () => {
    const boom = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    vi.stubGlobal('window', boom);
    expect(loadCommandMru()).toEqual([]);
    expect(() => saveCommandMru(['a'])).not.toThrow();
  });
});

describe('orderCommandsByMru · 置顶只改顺序', () => {
  it('没有清单 ⇒ 原样（同序新数组；与改动前逐字一致）', () => {
    const out = orderCommandsByMru(REGISTRY, undefined);
    expect(out.map((c) => c.id)).toEqual(REGISTRY.map((c) => c.id));
    expect(out).not.toBe(REGISTRY);
  });

  it('清单里的按新→旧提前，其余保持传入序（稳定排序，不是重打分）', () => {
    const out = orderCommandsByMru(REGISTRY, ['c.third', 'a.first']).map((c) => c.id);
    expect(out).toEqual(['c.third', 'a.first', 'b.second', 'd.fourth']);
  });

  it('注册表里没有的旧 id 被忽略（插件卸载后不留幽灵行）；重复 id 只按第一次算', () => {
    expect(orderCommandsByMru(REGISTRY, ['gone.plugin', 'b.second']).map((c) => c.id)).toEqual([
      'b.second',
      'a.first',
      'c.third',
      'd.fourth',
    ]);
    expect(orderCommandsByMru(REGISTRY, ['d.fourth', 'd.fourth']).map((c) => c.id)).toEqual([
      'd.fourth',
      'a.first',
      'b.second',
      'c.third',
    ]);
  });

  it('不改入参（注册表数组身份在别处被 memo 复用，就地改会串味）', () => {
    const before = REGISTRY.map((c) => c.id);
    orderCommandsByMru(REGISTRY, ['d.fourth']);
    expect(REGISTRY.map((c) => c.id)).toEqual(before);
  });
});

describe('commandItems · 置顶行带着「最近使用」标签', () => {
  it('命中的行打分组标签，未命中的行没有这个键（不造空分组）', () => {
    const items = commandItems(REGISTRY, '', ctx, { recent: ['c.third'] });
    expect(items[0]!.key).toBe('c.third');
    expect(items[0]!.group).toBe('最近使用');
    expect(items[1]!.group === undefined).toBe(true);
  });

  it('置顶不动判据：过滤仍按同一条尺子、禁态照旧灰、快捷键 hint 照旧带', () => {
    const withKb: CommandEntry[] = [
      { ...cmd('a.first', '第一条'), keybinding: 'ctrl+1' },
      { ...cmd('b.second', '第二条'), when: () => false },
    ];
    const items = commandItems(withKb, '第二', ctx, { recent: ['a.first', 'b.second'] });
    // 查询"第二"只命中第二条：a.first 被过滤掉了，置顶不许把它塞回来
    expect(items.map((i) => i.key)).toEqual(['b.second']);
    expect(items[0]!.disabled).toBe(true);
    expect(items[0]!.group).toBe('最近使用');
    const all = commandItems(withKb, '', ctx, { recent: [] });
    expect(all.find((i) => i.key === 'a.first')?.hint).toBe('Ctrl+1');
    expect(all.find((i) => i.key === 'a.first')?.group).toBeUndefined();
  });

  it('主行仍是「分类: 标题」原样（分组标签只是第二坐标，不把分类吃掉）', () => {
    const items = commandItems(REGISTRY, '', ctx, { recent: ['b.second'] });
    expect(items[0]!.primary).toBe('工作台: 第二条');
  });
});
