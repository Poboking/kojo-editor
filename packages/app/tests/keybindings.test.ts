import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindingStateOf,
  buildKeybindingRows,
  chordToBinding,
  defaultKeybindingOf,
  effectiveKeybindingOf,
  filterKeybindingRows,
  hasKeybindingOverride,
  keybindingChips,
  keybindingConflictWith,
  keybindingsVersion,
  keybindingSpecOf,
  KEYBINDING_CATEGORY_ORDER,
  KEYBINDING_SPECS,
  overrideCount,
  resetAllKeybindings,
  setKeybindingOverride,
  subscribeKeybindings,
} from '../src/ui/keybindings';
import { formatKeybinding, parseKeybinding, type CommandEntry } from '../src/ui/commands';

/**
 * 键位注册表单测（R8 快捷键批 + 快捷键设置页批）。
 *
 * 钉的是几件事：①注册表自身的完整性（id 唯一、可改键的条目有据可查）；
 * ②覆盖的语义（设置/解绑/复原/幂等、非法键位串拒绝、不可改键的条目拒绝）；
 * ③chord ↔ 键位串往返（捕获改键的落库格式与解析器互逆）；
 * ④快捷键页的表格视图（行数据、排序、撞键互指、搜索、按键芯片、解绑经存储往返不丢）。
 */

describe('KEYBINDING_SPECS 完整性', () => {
  it('id 唯一（同 id 会让键位表出现两行说不清的真相）', () => {
    const ids = KEYBINDING_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条有缺省键位的条目都能被 parseKeybinding 解析（含和弦）', () => {
    for (const s of KEYBINDING_SPECS) {
      if (s.keys === undefined) continue;
      expect(parseKeybinding(s.keys), s.id).not.toBeNull();
    }
  });

  it('标题一律中文（英文标题 = 面板里混进生肉）', () => {
    for (const s of KEYBINDING_SPECS) {
      expect(/[\u4e00-\u9fff]/.test(s.title), s.id).toBe(true);
    }
  });

  it('已知锚点：命令面板缺省 Ctrl+Shift+P，写作模式不可改键', () => {
    expect(defaultKeybindingOf('workbench.commandPalette')).toBe('ctrl+shift+p');
    const zen = keybindingSpecOf('layout.toggleZen');
    expect(zen?.rebindable).toBe(false);
  });
});

describe('覆盖表（改键）', () => {
  afterEach(() => {
    setKeybindingOverride('workbench.problems', null);
    setKeybindingOverride('layout.toggleZen', null);
  });

  it('设置生效 → 生效键位随覆盖走，复原回缺省', () => {
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+shift+m');
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+alt+p');
    expect(hasKeybindingOverride('workbench.problems')).toBe(true);
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+shift+m');
    expect(hasKeybindingOverride('workbench.problems')).toBe(false);
  });

  it('复原幂等（无覆盖时复原仍算成功——重复点「复原」不该报错）', () => {
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
  });

  it('非法键位串拒绝（坏数据不进持久化）', () => {
    expect(setKeybindingOverride('workbench.problems', 'not a chord')).toBe(false);
    expect(hasKeybindingOverride('workbench.problems')).toBe(false);
  });

  it('不可改键的条目（和弦 / 编辑器内部键）拒绝', () => {
    expect(setKeybindingOverride('layout.toggleZen', 'ctrl+alt+z')).toBe(false);
    expect(setKeybindingOverride('editor.internal.save', 'ctrl+return')).toBe(false);
  });

  it('不在注册表的 id 拒绝（改键只对登记过的键位开放）', () => {
    expect(setKeybindingOverride('made.up.command', 'ctrl+1')).toBe(false);
  });
});

describe('冲突检测', () => {
  it('同 chord 的其它命令被点名（展示但不阻止——分发先到先得）', () => {
    const chord = parseKeybinding('ctrl+shift+m')!;
    expect(keybindingConflictWith(chord, 'workbench.problems')).toBeNull();
    expect(keybindingConflictWith(chord, 'layout.reset')).toBe('问题面板');
  });
});

describe('chordToBinding ↔ parseKeybinding 往返', () => {
  it('修饰键顺序归一（捕获落库格式与解析器互逆）', () => {
    for (const binding of ['ctrl+shift+p', 'ctrl+alt+b', 'f1', 'ctrl+k']) {
      const chord = parseKeybinding(binding)!;
      expect(parseKeybinding(chordToBinding(chord))).toEqual(chord);
    }
  });
});

/* ---------------------------- 快捷键设置页的数据面 ---------------------------- */

/** 把命令项凑成注册表形状（`run` 在这里用不上，但行数据只能从真实命令项派生） */
const cmd = (input: { id: string; title: string; category?: string; keybinding?: string }): CommandEntry => ({
  ...input,
  run: () => {},
});

/**
 * 与键位表一一对应的命令清单，形状照壳层：`keybinding` 由 `effectiveKeybindingOf` 现取
 * （ShellLayout / ProjectView 就是这么传的）。
 * 必须是**函数**而不是常量：常量在收集阶段算一次，之后的解绑就反映不进来了
 * ——而行数据本来就该随覆盖表走，这正是这一页存在的理由。
 */
const allCommands = (): CommandEntry[] =>
  KEYBINDING_SPECS.map((s) => cmd({ id: s.id, title: s.title, category: s.category, keybinding: effectiveKeybindingOf(s.id) }));

const rowOf = <T extends { id: string }>(rows: readonly T[], id: string): T | undefined =>
  rows.find((r) => r.id === id);

describe('解绑（三态）', () => {
  beforeEach(() => {
    resetAllKeybindings();
  });

  afterEach(() => {
    resetAllKeybindings();
  });

  it('解绑后没有生效键位，状态是 unbound，但仍算作者改过（条数与复原都还在）', () => {
    expect(bindingStateOf('workbench.problems')).toBe('default');
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    expect(effectiveKeybindingOf('workbench.problems')).toBeUndefined();
    expect(bindingStateOf('workbench.problems')).toBe('unbound');
    expect(defaultKeybindingOf('workbench.problems')).toBe('ctrl+shift+m'); // 缺省本身没被动过
    expect(hasKeybindingOverride('workbench.problems')).toBe(true);
    expect(overrideCount()).toBe(1);
  });

  it('改过键位是 overridden，复原回缺省又变回 default', () => {
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    expect(bindingStateOf('workbench.problems')).toBe('overridden');
    expect(overrideCount()).toBe(1);
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
    expect(bindingStateOf('workbench.problems')).toBe('default');
    expect(overrideCount()).toBe(0);
  });

  it('不可改键的条目同样拒绝解绑（不许把和弦或编辑器内部键悄悄关掉）', () => {
    expect(setKeybindingOverride('layout.toggleZen', '')).toBe(false);
    expect(setKeybindingOverride('editor.internal.save', '')).toBe(false);
    expect(setKeybindingOverride('made.up.command', '')).toBe(false);
    expect(overrideCount()).toBe(0);
    expect(bindingStateOf('layout.toggleZen')).toBe('default');
    expect(effectiveKeybindingOf('layout.toggleZen')).toBe('ctrl+k z');
  });

  it('重复解绑幂等（第二次不再惊动界面）', () => {
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    const before = keybindingsVersion();
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    expect(keybindingsVersion()).toBe(before);
    expect(overrideCount()).toBe(1);
  });

  it('解绑让出来的键位不再算撞别人', () => {
    const chord = parseKeybinding('ctrl+shift+m')!;
    expect(keybindingConflictWith(chord, 'layout.reset')).toBe('问题面板');
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    expect(keybindingConflictWith(chord, 'layout.reset')).toBeNull();
  });
});

describe('全部恢复缺省', () => {
  beforeEach(() => {
    resetAllKeybindings();
  });

  afterEach(() => {
    resetAllKeybindings();
  });

  it('清掉每一条覆盖（含解绑）并返回被清的条数', () => {
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    expect(setKeybindingOverride('layout.toggleSidebar', '')).toBe(true);
    expect(overrideCount()).toBe(2);
    expect(resetAllKeybindings()).toBe(2);
    expect(overrideCount()).toBe(0);
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+shift+m');
    expect(effectiveKeybindingOf('layout.toggleSidebar')).toBe('ctrl+b');
  });

  it('本来就没有覆盖 ⇒ 返回 0 且不广播（一次没改动的点击不该让界面抖一下）', () => {
    expect(overrideCount()).toBe(0);
    const listener = vi.fn();
    const off = subscribeKeybindings(listener);
    const before = keybindingsVersion();
    expect(resetAllKeybindings()).toBe(0);
    expect(keybindingsVersion()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});

describe('解绑经存储往返', () => {
  const STORAGE = 'kojo.keybindings.v1';

  /** node 环境没有 localStorage：装一个假的并按需重装模块，才走得到启动那一次的存储清洗 */
  function useLocalStorage(seed: Record<string, unknown> | null): Map<string, string> {
    const store = new Map<string, string>();
    if (seed !== null) store.set(STORAGE, JSON.stringify(seed));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    return store;
  }

  /** 每次都重装模块再取：这份实例的覆盖表与静态导入那份无关，测完不留脏状态 */
  const freshInstance = async () => {
    vi.resetModules();
    return await import('../src/ui/keybindings');
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('解绑存进去、重启后还是解绑（空串是合法值，不会被清洗悄悄抹掉）', async () => {
    const store = useLocalStorage(null);
    const first = await freshInstance();
    expect(first.setKeybindingOverride('workbench.problems', '')).toBe(true);
    expect(JSON.parse(store.get(STORAGE)!)).toEqual({ 'workbench.problems': '' });

    vi.resetModules();
    const again = await freshInstance();
    expect(again.effectiveKeybindingOf('workbench.problems')).toBeUndefined();
    expect(again.bindingStateOf('workbench.problems')).toBe('unbound');
    expect(again.overrideCount()).toBe(1);
  });

  it('存储里的非键位垃圾照旧丢弃，好值照收', async () => {
    useLocalStorage({
      'workbench.quickOpen': '+++', // 解析不出主键
      'workbench.saveAll': 42, // 不是字符串
      'workbench.commandPalette': null,
      'layout.toggleSidebar': 'ctrl+g',
    });
    const mod = await freshInstance();
    expect(mod.overrideCount()).toBe(1);
    expect(mod.effectiveKeybindingOf('layout.toggleSidebar')).toBe('ctrl+g');
    expect(mod.bindingStateOf('layout.toggleSidebar')).toBe('overridden');
    // 被丢弃的那几条回到缺省，而不是带着一身垃圾进表
    expect(mod.effectiveKeybindingOf('workbench.quickOpen')).toBe('ctrl+p');
    expect(mod.bindingStateOf('workbench.saveAll')).toBe('default');
    expect(mod.bindingStateOf('workbench.commandPalette')).toBe('default');
  });

  it('覆盖与解绑都写在同一份存储里（全部恢复后不留空壳）', async () => {
    const store = useLocalStorage(null);
    const first = await freshInstance();
    first.setKeybindingOverride('workbench.problems', 'ctrl+alt+p');
    first.setKeybindingOverride('workbench.quickOpen', '');
    expect(JSON.parse(store.get(STORAGE)!)).toEqual({ 'workbench.problems': 'ctrl+alt+p', 'workbench.quickOpen': '' });
    expect(first.resetAllKeybindings()).toBe(2);
    expect(JSON.parse(store.get(STORAGE)!)).toEqual({});
  });
});

describe('KEYBINDING_CATEGORY_ORDER', () => {
  it('覆盖键位表里出现的全部分类（漏一个那分类就被排到最后）', () => {
    for (const category of new Set(KEYBINDING_SPECS.map((s) => s.category))) {
      expect(KEYBINDING_CATEGORY_ORDER, category).toContain(category);
    }
  });

  it('自身不重复且已知锚点在前（工作台是作者最常改的一类）', () => {
    expect(new Set(KEYBINDING_CATEGORY_ORDER).size).toBe(KEYBINDING_CATEGORY_ORDER.length);
    expect(KEYBINDING_CATEGORY_ORDER.slice(0, 2)).toEqual(['工作台', '布局']);
  });
});

describe('buildKeybindingRows 排序', () => {
  beforeEach(() => {
    resetAllKeybindings();
  });

  afterEach(() => {
    resetAllKeybindings();
  });

  it('分类按序表走，未登记的分类排最后', () => {
    const rows = buildKeybindingRows([...allCommands(), cmd({ id: 'outsider.foo', title: '外来命令', category: '归档' })]);
    const seen: string[] = [];
    for (const r of rows) if (!seen.includes(r.category)) seen.push(r.category);
    expect(seen).toEqual([...KEYBINDING_CATEGORY_ORDER, '归档']);
  });

  it('同分类内按码点排（与比较器同一口径，不写死名字，也不随运行环境区域设置漂移）', () => {
    for (const category of KEYBINDING_CATEGORY_ORDER) {
      const titles = buildKeybindingRows(allCommands())
        .filter((r) => r.category === category)
        .map((r) => r.title);
      for (let i = 1; i < titles.length; i++) {
        expect(titles[i - 1]! <= titles[i]!).toBe(true);
      }
    }
  });

  it('同样的输入给同样的顺序（纯派生，界面重画不跳行）', () => {
    setKeybindingOverride('workbench.problems', 'ctrl+alt+p');
    expect(buildKeybindingRows(allCommands())).toEqual(buildKeybindingRows(allCommands()));
  });

  it('已知锚点：命令面板那一行在布局的「重置布局」之前', () => {
    const rows = buildKeybindingRows(allCommands());
    expect(rows.findIndex((r) => r.id === 'workbench.commandPalette')).toBeLessThan(
      rows.findIndex((r) => r.id === 'layout.reset'),
    );
  });
});

describe('buildKeybindingRows 行数据', () => {
  beforeEach(() => {
    resetAllKeybindings();
  });

  afterEach(() => {
    resetAllKeybindings();
  });

  it('展示形与生效键位同源（不许一处一个键、另一处又一个键）', () => {
    for (const r of buildKeybindingRows(allCommands())) {
      expect(r.display).toBe(r.keys === undefined ? '' : formatKeybinding(r.keys));
    }
    const palette = rowOf(buildKeybindingRows(allCommands()), 'workbench.commandPalette');
    expect(palette?.keys).toBe('ctrl+shift+p');
    expect(palette?.display).toBe('Ctrl+Shift+P');
  });

  it('解绑的行没有键位也没有展示形，状态是 unbound', () => {
    setKeybindingOverride('workbench.problems', '');
    const row = rowOf(buildKeybindingRows(allCommands()), 'workbench.problems');
    expect(row?.keys).toBeUndefined();
    expect(row?.display).toBe('');
    expect(row?.state).toBe('unbound');
  });

  it('标题与分类跟着命令项走（面板显示什么这里就显示什么），命令项没给才退回键位表', () => {
    const rows = buildKeybindingRows([cmd({ id: 'workbench.problems', title: '问题清单', category: '我的分类' })]);
    expect(rows[0]!.title).toBe('问题清单');
    expect(rows[0]!.category).toBe('我的分类');
    const fallback = buildKeybindingRows([cmd({ id: 'workbench.problems', title: '' })]);
    expect(fallback[0]!.title).toBe('问题面板');
    expect(fallback[0]!.category).toBe('工作台');
  });

  it('没登记进键位表的命令看得见但不许改键，两边都没分类就是空串', () => {
    const rows = buildKeybindingRows([
      cmd({ id: 'outsider.plugin.action', title: '外来命令', category: '归档', keybinding: 'ctrl+9' }),
      cmd({ id: 'outsider.bare', title: '没分类的' }),
    ]);
    const outsider = rowOf(rows, 'outsider.plugin.action');
    expect(outsider?.rebindable).toBe(false);
    expect(outsider?.keys).toBe('ctrl+9'); // 命令项自带的键位仍展示，只是改不了
    expect(outsider?.note).toBeNull();
    expect(outsider?.state).toBe('default');
    expect(rowOf(rows, 'outsider.bare')?.category).toBe('');
  });

  it('备注沿用键位表（和弦与编辑器内部键的「暂不支持改键」要说清楚）', () => {
    const rows = buildKeybindingRows(allCommands());
    expect(rowOf(rows, 'layout.toggleZen')?.note).toBe('和弦，暂不支持改键');
    expect(rowOf(rows, 'workbench.problems')?.note).toBeNull();
  });
});

describe('buildKeybindingRows 撞键', () => {
  beforeEach(() => {
    resetAllKeybindings();
  });

  afterEach(() => {
    resetAllKeybindings();
  });

  it('撞同一键的两行互指对方标题', () => {
    expect(setKeybindingOverride('layout.reset', 'ctrl+shift+m')).toBe(true);
    const rows = buildKeybindingRows(allCommands());
    expect(rowOf(rows, 'workbench.problems')?.conflictWith).toBe('重置布局');
    expect(rowOf(rows, 'layout.reset')?.conflictWith).toBe('问题面板');
  });

  it('修饰键写法不同也算撞（先归一再比）', () => {
    expect(setKeybindingOverride('layout.reset', 'shift+ctrl+m')).toBe(true);
    const rows = buildKeybindingRows(allCommands());
    expect(rowOf(rows, 'workbench.problems')?.conflictWith).toBe('重置布局');
  });

  it('和弦不参与判重（走的是另一条分发路径）', () => {
    const rows = buildKeybindingRows([
      ...allCommands(),
      cmd({ id: 'outsider.same', title: '假和弦', category: '归档', keybinding: 'ctrl+k z' }),
    ]);
    expect(rowOf(rows, 'layout.toggleZen')?.conflictWith).toBeNull();
    expect(rowOf(rows, 'outsider.same')?.conflictWith).toBeNull();
  });

  it('没有键位的行不参与判重', () => {
    const rows = buildKeybindingRows(allCommands());
    for (const id of ['layout.openSettings', 'layout.reset', 'editor.action.find']) {
      expect(rowOf(rows, id)?.conflictWith, id).toBeNull();
    }
  });

  it('解绑让出来的键位不再撞人', () => {
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    const rows = buildKeybindingRows(allCommands());
    expect(rowOf(rows, 'layout.toggleZen')?.conflictWith).toBeNull();
    expect(rowOf(rows, 'workbench.problems')?.conflictWith).toBeNull();
  });
});

describe('filterKeybindingRows', () => {
  // 每次现取：表格行是「命令清单 + 覆盖表」的派生物，测试之间不许共享一份带状态的快照
  const rowsOf = () => buildKeybindingRows(allCommands());

  it('命中中文标题', () => {
    expect(filterKeybindingRows(rowsOf(), '问题').map((r) => r.id)).toEqual(['workbench.problems']);
  });

  it('命中展示键位：大小写与空格都不敏感', () => {
    for (const query of ['ctrl+shift+p', 'CTRL+SHIFT+P', 'Ctrl + Shift + p']) {
      expect(filterKeybindingRows(rowsOf(), query).map((r) => r.id), query).toEqual(['workbench.commandPalette']);
    }
  });

  it('命中分类与命令标识', () => {
    const rows = rowsOf();
    const hits = filterKeybindingRows(rows, '编辑器');
    expect(hits.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.category === '编辑器') expect(hits.some((h) => h.id === r.id), r.id).toBe(true);
    }
    expect(filterKeybindingRows(rows, 'toggleZen').map((r) => r.id)).toEqual(['layout.toggleZen']);
  });

  it('空串（以及只有空格的串）返回全部，且给的是新数组', () => {
    const rows = rowsOf();
    for (const query of ['', '   ']) {
      const out = filterKeybindingRows(rows, query);
      expect(out).toHaveLength(rows.length);
      expect(out).toEqual(rows);
      expect(out).not.toBe(rows);
    }
  });

  it('无命中返回空表（不许把整张表当「没搜到」摊给作者）', () => {
    expect(filterKeybindingRows(rowsOf(), '不可能存在的键位')).toEqual([]);
  });
});

describe('keybindingChips', () => {
  it('单键与功能键各一枚芯片（一步 = 一组芯片，哪怕只有一枚）', () => {
    expect(keybindingChips('f1')).toEqual([['F1']]);
    expect(keybindingChips('b')).toEqual([['B']]);
  });

  it('多个修饰键排成一行芯片（展示口径与命令面板的提示同词）', () => {
    expect(keybindingChips('ctrl+shift+p')).toEqual([['Ctrl', 'Shift', 'P']]);
    expect(keybindingChips('ctrl+alt+b')).toEqual([['Ctrl', 'Alt', 'B']]);
    expect(keybindingChips('ctrl+arrowdown')).toEqual([['Ctrl', 'arrowdown']]);
  });

  it('和弦按步分组成两行', () => {
    expect(keybindingChips('ctrl+k z')).toEqual([['Ctrl', 'K'], ['Z']]);
    expect(keybindingChips('ctrl+k  z')).toEqual([['Ctrl', 'K'], ['Z']]); // 步之间几个空格都一样
  });

  it('非法或空串返回空数组，不抛（表格里抛一次就是整页白屏）', () => {
    for (const bad of ['', '   ', '+++', 'ctrl+', 'shift+']) {
      expect(keybindingChips(bad), bad).toEqual([]);
    }
  });

  it('键位表里每条缺省键位都画得出芯片（登记了却画不出 = 页面上那行是空的）', () => {
    for (const spec of KEYBINDING_SPECS) {
      if (spec.keys === undefined) continue;
      expect(keybindingChips(spec.keys).length, spec.id).toBeGreaterThan(0);
    }
  });
});
