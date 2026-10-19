import { describe, expect, it } from 'vitest';
import type { EditorCommandContext, EditorDocumentSymbol } from '@kojo/plugin-api';
import type { CommandEntry } from '../src/ui/commands';
import { CANDIDATE_BUDGETS } from '@kojo/plugin-api';
import {
  activeSymbolKey,
  commandItems,
  fuzzyMatch,
  lineFromKey,
  lineKeyOf,
  lineNumberOf,
  MODE_TEXT,
  parsePaletteMode,
  quickOpenView,
  rankFiles,
  rankKeyed,
  revealHome,
  type PaletteMode,
} from '../src/ui/palette-search';

/**
 * 快速打开多模式的纯逻辑单测（1020 编辑器体感批）。
 *
 * 钉住四件事，每件都对应一条"改了会立刻坏"的判据：
 * ① 前缀只在开头才算开关（中间的 `:` 是 Windows 盘符）；
 * ② 桶序仍是契约层 `candidateRank` 那一条，模糊子序列**严格排在子串命中之后**（既有读数不翻盘）；
 * ③ 「最近打开」只换出场顺序，不参与任何判定，且清单外的路径不会凭空出现；
 * ④ 补位趟"够一屏就停"这条门是可数的（同清单、不同 cap ⇒ 模糊项进不进来得有据）。
 */

const P = {
  a: 'D:\\Game\\eratw\\ERB\\口上\\M_KOJO_K1_日常.kojo',
  b: 'D:\\Game\\eratw\\ERB\\口上\\M_KOJO_K12_日常.kojo',
  c: 'D:\\Game\\eratw\\ERB\\别的目录\\日常补丁.ERB',
};

describe('parsePaletteMode：前缀开关', () => {
  it('四个前各归一路，其余一律当文件找', () => {
    expect(parsePaletteMode('')).toEqual({ kind: 'files', term: '' });
    expect(parsePaletteMode('日常')).toEqual({ kind: 'files', term: '日常' });
    expect(parsePaletteMode('>格式化')).toEqual({ kind: 'commands', term: '格式化' });
    expect(parsePaletteMode('@onEnter')).toEqual({ kind: 'symbols', term: 'onEnter' });
    expect(parsePaletteMode(':88')).toEqual({ kind: 'line', term: '88' });
  });

  it('前缀只认首字符：盘符里的冒号不许把路径吃掉', () => {
    expect(parsePaletteMode('C:\\game\\口上.ERB')).toEqual({ kind: 'files', term: 'C:\\game\\口上.ERB' });
    // 前缀后头的内容原样交出（含空白），由排序侧自己 trim —— 面板不许改作者的输入
    expect(parsePaletteMode('@ ')).toEqual({ kind: 'symbols', term: ' ' });
  });
});

describe('lineNumberOf：行号只认纯数字', () => {
  it('前后空白容忍，0 与负数与半个数字一律不认', () => {
    expect(lineNumberOf('12')).toBe(12);
    expect(lineNumberOf(' 7 ')).toBe(7);
    expect(lineNumberOf('000123')).toBe(123);
    expect(lineNumberOf('')).toBeNull();
    expect(lineNumberOf('  ')).toBeNull();
    expect(lineNumberOf('0')).toBeNull();
    expect(lineNumberOf('-3')).toBeNull();
    expect(lineNumberOf('12x')).toBeNull();
    expect(lineNumberOf('1e3')).toBeNull();
    expect(lineNumberOf('12345678')).toBeNull(); // 超过 7 位 = 不是一份文件里的行
  });
});

/** 命中区间摊平成字符串，便于逐字比对（`[0,3) [5,6)` ⇒ `'0-3 5-6'`） */
const flat = (ranges: readonly [number, number][]): string =>
  ranges.map(([s, e]) => `${s}-${e}`).join(' ');

describe('fuzzyMatch：子序列 + 连续段 + 边界加权', () => {
  it('不是子序列就不命中（不做半个匹配的子集）', () => {
    expect(fuzzyMatch('MESSAGE.ERB', 'MEZ')).toBeNull(); // Z 在整串里不存在
    expect(fuzzyMatch('', 'a')).toBeNull();
    expect(fuzzyMatch('abc', '   ')).toBeNull();
  });

  it('相邻的命中字符合成一区间，被跳过的字符隔开', () => {
    expect(flat(fuzzyMatch('aXbc', 'abc')!.ranges)).toBe('0-1 2-4');
    expect(flat(fuzzyMatch('Message', 'msg')!.ranges)).toBe('0-1 3-4 5-6');
  });

  it('右靠压缩：把匹配尽量并成连续段（区间数就是"看起来连不连"的读数）', () => {
    // `aXbbc` 搜 `abc`：贪心先落 0,2,4；右靠把 b 挪到 3 ⇒ 与 c 连成一截（三块变两块）
    expect(flat(fuzzyMatch('aXbbc', 'abc')!.ranges)).toBe('0-1 3-5');
    // 本来就连续的写法不必右靠：`abXabc` 的两块是 0-1-2 与结尾那一枚 c
    expect(flat(fuzzyMatch('abXabc', 'abc')!.ranges)).toBe('0-2 5-6');
    // 同一条查询下，连续版本的分数必须高于到处跳格的版本
    expect(fuzzyMatch('abXabc', 'abc')!.score).toBeGreaterThan(fuzzyMatch('a1b2c3d4e5', 'abc')!.score);
  });

  it('词首（分隔符后 / 驼峰 / 串首）比串中间值钱', () => {
    const boundary = fuzzyMatch('readmeFile', 'F')!.score;
    const middle = fuzzyMatch('abcdefg', 'F')!.score;
    expect(boundary).toBeGreaterThan(middle);
    expect(fuzzyMatch('kojo.erb', 'k')!.score).toBeGreaterThan(fuzzyMatch('xkojo', 'k')!.score);
  });

  it('大小写不敏感，但区间下标是原样文本的（高亮切的是显示串）', () => {
    // 贪心取**最左**可行解：`M_KOJO_K12.kojo` 里的 k 先落在第 3 个字符，`12` 才是连续的
    const hit = fuzzyMatch('M_KOJO_K12.kojo', 'k12');
    expect(flat(hit!.ranges)).toBe('2-3 8-10');
  });
});

describe('rankFiles：一条尺子 + 模糊补位', () => {
  const paths = [P.a, P.b, P.c];

  it('文件名命中排在目录命中之前（与既有 Ctrl+P 读数一致）', () => {
    expect(rankFiles(paths, '日常补丁').map((h) => h.path)[0]).toBe(P.c);
    // 只有目录段命中的那批仍然全数在场，不丢项
    expect(rankFiles(paths, '口上')).toHaveLength(2);
  });

  it('模糊补位一律排在所有子串命中之后（桶序不被新档翻盘）', () => {
    const list = ['D:\\e\\axd.ERB', 'D:\\e\\zzadq.ERB', 'D:\\e\\ad.ERB'];
    const out = rankFiles(list, 'ad', { cap: 3 });
    expect(out.map((h) => h.path)).toEqual(['D:\\e\\ad.ERB', 'D:\\e\\zzadq.ERB', 'D:\\e\\axd.ERB']);
    expect(out.map((h) => h.tier)).toEqual([1, 2, 4]); // 4 = 只有子序列命中
  });

  it('子串命中够一屏就不再扫补位趟（够用的时候不付第二趟的钱）', () => {
    const list = ['D:\\e\\ad.ERB', 'D:\\e\\zzadq.ERB', 'D:\\e\\axd.ERB'];
    expect(rankFiles(list, 'ad', { cap: 2 }).map((h) => h.path)).toEqual([
      'D:\\e\\ad.ERB',
      'D:\\e\\zzadq.ERB',
    ]);
    expect(rankFiles(list, 'ad', { cap: 3 })).toHaveLength(3);
  });

  it('空查询：最近打开置顶成节，清单外的路径不会凭空出现', () => {
    const out = rankFiles(paths, '', { recent: [P.c, 'D:\\别的\\项目\\x.ERB', P.a] });
    expect(out.map((h) => h.path)).toEqual([P.c, P.a, P.b]);
    expect(out.map((h) => h.recent)).toEqual([true, true, false]);
    // 同一条路径在 recent 里出现两次也只占一格
    expect(rankFiles(paths, '', { recent: [P.c, P.c] }).map((h) => h.path)).toEqual([P.c, P.a, P.b]);
  });

  it('空查询无 recent 时保持清单原序，cap 说话算数', () => {
    expect(rankFiles(paths, '').map((h) => h.path)).toEqual(paths);
    expect(rankFiles(paths, '', { cap: 2 })).toHaveLength(2);
    expect(rankFiles([], '', { cap: 2 })).toEqual([]);
  });

  it('脏输入不炸：非数组回空，条目里的非字符串被跳过', () => {
    expect(rankFiles(null as unknown as readonly string[], 'x')).toEqual([]);
    expect(rankFiles([P.a, 42 as unknown as string], 'kojo').map((h) => h.path)).toEqual([P.a]);
  });

  it('同输入两次调用给出同一个序（不依赖引擎的排序稳定性）', () => {
    const a = rankFiles(paths, 'kojo');
    const b = rankFiles(paths, 'kojo');
    expect(a.map((h) => h.path)).toEqual(b.map((h) => h.path));
  });

  it('base / dir 两段随候选一起给出（面板不再自己拆一次路径）', () => {
    const [hit] = rankFiles(paths, '日常补丁');
    expect(hit!.base).toBe('日常补丁.ERB');
    expect(hit!.dir).toBe('D:\\Game\\eratw\\ERB\\别的目录');
  });
});

describe('rankKeyed：命令与符号共用的那条尺子', () => {
  const items = [
    { item: '1', name: '切换写作模式', path: 'layout.toggleZen' },
    { item: '2', name: '快速打开文件', path: 'workbench.quickOpen' },
    { item: '3', name: '保存当前文件', path: 'editor.internal.save' },
  ];

  it('空查询按给定顺序出场并受预算约束', () => {
    expect(rankKeyed(items, '', { cap: 2 }).map((h) => h.item)).toEqual(['1', '2']);
  });

  it('名字命中优先于 id 命中，模糊补位仍排最后', () => {
    const out = rankKeyed(items, 'save', { cap: 10 });
    expect(out[0]!.item).toBe('3');
    expect(out[0]!.tier).toBeLessThan(4);
    // 'zo' 不是任何名字/id 的子串，但 `toggleZen` 里有 z…o？（没有）⇒ 不命中，列表该空
    expect(rankKeyed(items, 'zx', { cap: 10 })).toEqual([]);
  });

  it('非数组输入回空', () => {
    expect(rankKeyed(null as unknown as typeof items, 'a', { cap: 10 })).toEqual([]);
  });
});

/* -------------------------- 一栏四用：列表内容 -------------------------- */

const CTX: EditorCommandContext = { project: null };
const mode = (kind: PaletteMode['kind'], term: string): PaletteMode => ({ kind, term });
const sym = (name: string, startLine: number): EditorDocumentSymbol => ({
  name,
  kind: 'function',
  startLine,
  endLine: startLine + 4,
});
const CMD: readonly CommandEntry[] = [
  { id: 'layout.toggleZen', title: '切换写作模式', category: '布局', run: () => undefined },
  { id: 'workbench.saveAll', title: '全部保存', category: '工作台', keybinding: 'ctrl+shift+s', run: () => undefined },
  { id: 'editor.action.rename', title: '重命名符号', run: (ctx) => undefined, when: (ctx) => ctx.activeFile !== undefined },
];

const NO_RECENT = { files: [P.a, P.b], commands: CMD, commandCtx: CTX, symbolSource: null, activeFile: P.a };

describe('quickOpenView · 文件模式', () => {
  it('空查询给「最近打开」一节 + 一条用法提示（一栏四用要看得见）', () => {
    const view = quickOpenView({ ...NO_RECENT, mode: mode('files', ''), recent: [P.b] });
    expect(view.items.map((i) => i.key)).toEqual([P.b, P.a]);
    expect(view.items[0]!.group).toBe('最近打开');
    expect(view.items[1]!.group).toBeUndefined();
    expect(view.footnote).toContain('@');
    expect(view.footnote).toContain('>');
  });

  it('命中区间画在主行上；只有目录命中时画在目录的**最深一层**上', () => {
    const view = quickOpenView({ ...NO_RECENT, mode: mode('files', 'kojo') });
    const first = view.items[0]!;
    expect(first.ranges).toBeDefined();
    expect(first.secondaryRanges).toBeUndefined();
    const dirOnly = quickOpenView({ ...NO_RECENT, mode: mode('files', '口上') }).items[0]!;
    expect(dirOnly.ranges).toBeUndefined();
    // 「口上」正是 tail 那一段（head 会被中段省略改写，下标不能对着整条目录算）
    expect(dirOnly.secondaryRanges).toEqual([[0, 2]]);
  });
});

describe('quickOpenView · 命令模式', () => {
  it('与 F1 同一份条目构造（分类名参与匹配、when 决定禁态、键位进 hint）', () => {
    const view = quickOpenView({ ...NO_RECENT, mode: mode('commands', '工作台') });
    expect(view.items.map((i) => i.key)).toEqual(['workbench.saveAll']);
    expect(view.items[0]!.primary).toBe('工作台: 全部保存');
    expect(view.items[0]!.hint).toBe('Ctrl+Shift+S');
    expect(commandItems(CMD, '', CTX).find((i) => i.key === 'editor.action.rename')!.disabled).toBe(true);
    expect(
      commandItems(CMD, '', { project: null, activeFile: P.a }).find((i) => i.key === 'editor.action.rename')!.disabled,
    ).toBe(false);
  });
});

describe('quickOpenView · 当前文件符号（@）', () => {
  it('探针不在场 / 派生视图：各说一句人话，不给假列表', () => {
    expect(quickOpenView({ ...NO_RECENT, mode: mode('symbols', 'on') }).items).toEqual([]);
    expect(quickOpenView({ ...NO_RECENT, mode: mode('symbols', 'on') }).emptyText).toContain('还没有打开文件');
    const derived = quickOpenView({
      ...NO_RECENT,
      mode: mode('symbols', 'on'),
      symbolSource: { path: P.a, symbols: null },
    });
    expect(derived.items).toEqual([]);
    expect(derived.emptyText).toContain('写法视图');
  });

  it('空查询列出全部程序段，选中键能找回那一枚（行号进 hint 与 title）', () => {
    const source = { path: P.a, symbols: [sym('M_KOJO_K1_日常', 12), sym('', 99), sym('道中', 40)] };
    const view = quickOpenView({ ...NO_RECENT, mode: mode('symbols', ''), symbolSource: source });
    expect(view.items.map((i) => i.primary)).toEqual(['M_KOJO_K1_日常', '道中']); // 空名不列（点了不知道跳哪）
    expect(view.items[0]!.key).toBe(activeSymbolKey(source.symbols[0]!));
    expect(view.items[0]!.hint).toBe(':12');
    expect(view.items[0]!.title).toBe(`${P.a}:12`);
    expect(view.footnote).toBeNull(); // 没被预算挡掉就不报"列了前 N 段"
  });

  it('名字命中排在前面，区间高亮跟着画', () => {
    const source = { path: P.a, symbols: [sym('入口检查', 3), sym('M_KOJO_K1_日常', 12)] };
    const view = quickOpenView({ ...NO_RECENT, mode: mode('symbols', '日常'), symbolSource: source });
    expect(view.items[0]!.primary).toBe('M_KOJO_K1_日常');
    expect(view.items[0]!.ranges).toEqual([[10, 12]]);
  });

  it('溢出提示只在"预算真的挡掉了东西"时出现（带查询时列得少不是截断）', () => {
    const many = Array.from({ length: CANDIDATE_BUDGETS.render + 5 }, (_, i) => sym(`段${i}`, i + 1));
    const cut = quickOpenView({ ...NO_RECENT, mode: mode('symbols', ''), symbolSource: { path: P.a, symbols: many } });
    expect(cut.items).toHaveLength(CANDIDATE_BUDGETS.render);
    expect(cut.footnote).toContain(`本文件共 ${many.length} 段`);
    // 带着查询时这一屏没列满是"没匹配上"，不是被预算截断 ⇒ 不许报"列了前 N 段"（假读数）
    const one = quickOpenView({ ...NO_RECENT, mode: mode('symbols', '段104'), symbolSource: { path: P.a, symbols: many } });
    expect(one.items).toHaveLength(1);
    expect(one.footnote).toBeNull();
  });
});

describe('quickOpenView · 行号（:）', () => {
  it('合法行号给一条候选，非法的照实说', () => {
    const view = quickOpenView({ ...NO_RECENT, mode: mode('line', '88') });
    expect(view.items).toEqual([
      { key: lineKeyOf(88), primary: '跳到第 88 行', hint: 'M_KOJO_K1_日常.kojo' },
    ]);
    expect(lineFromKey(view.items[0]!.key)).toBe(88);
    expect(quickOpenView({ ...NO_RECENT, mode: mode('line', 'x') }).items).toEqual([]);
    expect(quickOpenView({ ...NO_RECENT, mode: mode('line', 'x') }).emptyText).toBe(MODE_TEXT.line.empty);
  });

  it('没打开文件 ⇒ 一句人话（不是空列表装死）', () => {
    const view = quickOpenView({ ...NO_RECENT, mode: mode('line', '88'), activeFile: null });
    expect(view.items).toEqual([]);
    expect(view.emptyText).toContain('还没有打开文件');
  });

  it('键的拆装只在 palette-search 一处：非本前缀的键一律回 null', () => {
    expect(lineFromKey(P.a)).toBeNull();
    expect(lineFromKey('line:12')).toBe(12);
    expect(lineFromKey('line:0')).toBeNull();
  });
});

describe('revealHome：落点归属', () => {
  it('探针在场用探针那份文件（分屏时活动标签可以是另一组的那份）', () => {
    expect(revealHome({ path: P.b, symbols: null }, P.a)).toBe(P.b);
    expect(revealHome(null, P.a)).toBe(P.a);
    expect(revealHome({ path: '', symbols: [] }, null)).toBe('');
  });
});
