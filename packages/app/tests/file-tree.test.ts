import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CharaInfo, DirEntry, ErbIndex, GameProject, WalkOptions } from '@kojo/plugin-api';
import { FileTree, middleEllipsis, walkDialectPaths } from '../src/ui/FileTree';
import { DirRows } from '../src/ui/file-tree-dir-rows';
import { FileRows } from '../src/ui/file-tree-rows';
import { resetSelectionForTest, setActivePath } from '../src/ui/file-tree-selection';
import { buildFileGroups, dirsToRelist, kojoOwners, visibleEntries } from '../src/ui/file-tree-model';
import {
  FILTER_WINDOW_INITIAL,
  FILTER_WINDOW_STEP,
  filterRenderPlan,
  nextFilterWindow,
} from '../src/ui/file-tree-filter-window';

/**
 * 真实文件夹视图的条目筛选（反馈 6/7）。
 *
 * 这里锁的是**对文件系统诚实**这条不变量：作者包展开后，嵌套目录必须原样显示自己的
 * 内容。实现第一版把「包层已平铺的 ERB」去重应用到了整棵递归，结果
 * `灵梦-少女之梦/没写的`（实有 10 个 ERB）被渲染成空目录 —— 用户点进去看到空的，
 * 会以为这个包没写完，而事实恰恰相反。这条断言就是那次踩坑的固化。
 */

const entry = (name: string, isDirectory: boolean, base = 'C:/game/kojo/001/包'): DirEntry => ({
  name,
  path: `${base}/${name}`,
  isDirectory,
});

const ROOT_ERBS = [entry('M_KOJO_K1_2_イベント.ERB', false), entry('readme.txt', false)];
const NESTED = [entry('M_KOJO_K1_2_コマンド.ERB', false), entry('M_KOJO_K1_2_依頼.ERB', false)];

describe('visibleEntries · 真实文件夹条目筛选', () => {
  it('包根层（depth 0）：与平铺列表同级的 ERB 去重，非 ERB 保留', () => {
    const skip = new Set(['c:/game/kojo/001/包/m_kojo_k1_2_イベント.erb']);
    expect(visibleEntries(ROOT_ERBS, 0, skip).map((e) => e.name)).toEqual(['readme.txt']);
  });

  it('嵌套目录（depth ≥ 1）：**一律原样返回**，绝不因"包层已平铺"而被吃掉', () => {
    // 极端情形：嵌套目录里的每个文件都出现在包层平铺列表中——仍然必须全部显示
    const skip = new Set(NESTED.map((e) => e.path.toLowerCase()));
    expect(visibleEntries(NESTED, 1, skip).map((e) => e.name)).toEqual([
      'M_KOJO_K1_2_コマンド.ERB',
      'M_KOJO_K1_2_依頼.ERB',
    ]);
    expect(visibleEntries(NESTED, 3, skip)).toHaveLength(2);
  });

  it('skip 键按归一后的路径比对（反斜杠 / 大小写差异不影响命中）', () => {
    // 反斜杠写的 Windows 路径、大写盘符与扩展名，归一后应与正斜杠小写形式等价
    const skip = new Set(['c:/game/kojo/001/包/a.erb']);
    const entries = [entry('A.ERB', false), entry('B.txt', false)];
    expect(visibleEntries(entries, 0, skip).map((e) => e.name)).toEqual(['B.txt']);
  });

  it('skip 为空时全量返回（不吞任何条目）', () => {
    expect(visibleEntries(ROOT_ERBS, 0, new Set())).toHaveLength(2);
  });

  it('不修改入参数组', () => {
    const input = [...ROOT_ERBS];
    const out = visibleEntries(input, 0, new Set());
    expect(out).not.toBe(input);
    expect(input).toEqual(ROOT_ERBS);
  });
});

describe('dirsToRelist · 外部改动后该重列哪些目录（HK-5）', () => {
  const PKGS = [
    { key: '#1 灵梦::少女之梦', dir: 'C:/game/kojo/001/少女之梦' },
    { key: '#1 灵梦::没写的', dir: 'C:/game/kojo/001/没写的' },
    { key: '#4 觉::深掘り', dir: 'C:/game/kojo/004/深掘り' },
  ];

  it('已点开真实文件夹视图的包 + 展开着的子目录，两者都重列', () => {
    const out = dirsToRelist(new Set(['C:/game/kojo/001/少女之梦/裏']), new Set(['#1 灵梦::少女之梦']), PKGS);
    expect(new Set(out)).toEqual(
      new Set(['C:/game/kojo/001/少女之梦', 'C:/game/kojo/001/少女之梦/裏']),
    );
  });

  it('折叠着的包**不**重列（看不见的东西不打 IO），但展开的子目录要（包可能整个折叠而子层还开着）', () => {
    expect(dirsToRelist(new Set(), new Set(), PKGS)).toEqual([]);
    expect(dirsToRelist(new Set(['C:/x/子']), new Set(), PKGS)).toEqual(['C:/x/子']);
    expect(dirsToRelist(new Set(), new Set(['#4 觉::深掘り']), PKGS)).toEqual(['C:/game/kojo/004/深掘り']);
  });

  it('同一个目录只出现一次（子目录恰好与包同名路径时不去重＝重复请求）', () => {
    const out = dirsToRelist(new Set(['C:/game/kojo/001/少女之梦']), new Set(['#1 灵梦::少女之梦']), PKGS);
    expect(out).toEqual(['C:/game/kojo/001/少女之梦']);
  });

  it('菜单项按 key 认，不认目录名（改包名不会把失效指错地方）', () => {
    expect(dirsToRelist(new Set(), new Set(['#1 灵梦::不存在的包']), PKGS)).toEqual([]);
  });
});

/* ==================== 冷开即时化批（2026-10-16）：分组构建 + walk 快照 ==================== */

/**
 * 角色归属表：`charaIndex → 目录前缀`（长前缀优先）。
 * 这层单测锁的是"同一 owners 表同时供索引路径与 walk 快照使用"的前提——
 * 二者共用 `buildFileGroups` 才可能结构逐字一致。
 */
describe('kojoOwners · 角色目录归属表', () => {
  it('只收有 kojoDir 的角色；长前缀排前（嵌套角色目录不误归属）', () => {
    const charaIndex = new Map<number, CharaInfo>([
      [1, { no: 1, name: '霊夢', kojoDir: 'C:/p/koa/001 A' }],
      [2, { no: 2, name: '裏', kojoDir: 'C:/p/koa/001 A/裏' }],
      [3, { no: 3, name: '无口上目录' }],
    ]);
    const owners = kojoOwners({ charaIndex } as unknown as GameProject);
    expect(owners.map((o) => o.label)).toEqual(['#2 裏', '#1 霊夢']);
    expect(owners[0]!.prefix.length).toBeGreaterThan(owners[1]!.prefix.length);
  });
});

describe('buildFileGroups · 索引路径与冷开 walk 快照共用同一构建函数', () => {
  const owners = [
    { prefix: 'C:/p/koa/001 A', label: '#1 霊夢' },
    { prefix: 'C:/p/koa/011 B', label: '#11 魔理沙' },
  ];
  const walkPaths = [
    'C:/p/koa/001 A/M_KOJO_K1.ERB', // 根散文件（无包目录）
    'C:/p/koa/001 A/少女之梦/M_KOJO_MESSAGE_COM_K1_2.ERB',
    'C:/p/koa/001 A/少女之梦/M_KOJO_MESSAGE_COM_K1_1.ERB',
    'C:/p/koa/011 B/包A/x.ERB',
    'C:/p/koa/杂项.ERB', // 未归属
  ];

  it('分组结构与既有口径一致：角色按编号升序、未归属垫底；包按字典序、根散文件在前', () => {
    const groups = buildFileGroups(walkPaths, owners);
    expect(groups.map((g) => g.label)).toEqual(['#1 霊夢', '#11 魔理沙', '(未归属)']);
    const k1 = groups[0]!;
    expect(k1.total).toBe(3);
    expect(k1.subs.map((s) => s.label)).toEqual([null, '少女之梦']); // 根散文件在前
    expect(k1.subs[1]!.files.map((f) => f.split('/').pop())).toEqual([
      'M_KOJO_MESSAGE_COM_K1_1.ERB',
      'M_KOJO_MESSAGE_COM_K1_2.ERB',
    ]); // 包内按路径字典序
    expect(groups[2]!.prefix).toBe('');
  });

  it('索引键序（Map.keys）与 walk 数组序输入 → 结构逐字相同（索引就绪切换不重排）', () => {
    const indexKeys = new Map(walkPaths.map((p) => [p, {}])).keys(); // 模拟 index.files.keys()
    expect(buildFileGroups(indexKeys, owners)).toEqual(buildFileGroups(walkPaths, owners));
  });

  it('同一输入两次构建结果稳定（快照刷新/索引重建不产生顺序抖动）', () => {
    expect(buildFileGroups(walkPaths, owners)).toEqual(buildFileGroups([...walkPaths], owners));
  });
});

/* ---------------- walk 快照：一次 walkDir 拿全口上域方言文件 ---------------- */

/** 伪文件树（值 'DIR' = 目录；叶子为文件名） */
type WalkTree = Record<string, 'DIR' | string>;

/**
 * 伪 `walkDir`：**与真实实现同构**——整棵树照常枚举，`filter` 只筛输出条目、**不剪枝**
 * （2026-10-16 桥分叉批：谓词改由内核 `FileIO.walkDir` 一处兑现，闭包不再跨进程，
 * 旧口径「目录判 false ⇒ 剪掉整棵子树」随之废止；见契约 `WalkOptions.filter`）。
 */
function fakeWalkDir(tree: WalkTree, calls: string[] = []) {
  return async (root: string, opts?: WalkOptions): Promise<DirEntry[]> => {
    calls.push(root);
    const out: DirEntry[] = [];
    const visit = (dir: string): void => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const seen = new Set<string>();
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        if (seen.has(name)) continue;
        seen.add(name);
        const path = `${prefix}${name}`;
        const isDirectory = tree[path] === 'DIR' || rest.includes('/');
        const entry: DirEntry = { name, path, isDirectory };
        // 子孙一律递归（剪枝已不是本契约的能力）；筛的只是"这条进不进输出"
        if (isDirectory) visit(path);
        if (opts?.filter && !opts.filter(entry)) continue;
        if (isDirectory ? opts?.includeDirs === true : opts?.includeFiles !== false) out.push(entry);
      }
    };
    visit(root);
    return out;
  };
}

describe('walkDialectPaths · 冷开快照（索引未就绪时先出树）', () => {
  const ROOT = 'C:/p/koa/個人口上';
  const tree: WalkTree = {
    [`${ROOT}/001 A`]: 'DIR',
    [`${ROOT}/001 A/M_KOJO_K1.ERB`]: '',
    [`${ROOT}/001 A/少女之梦`]: 'DIR',
    [`${ROOT}/001 A/少女之梦/M_KOJO_MESSAGE_COM_K1_1.ERB`]: '',
    [`${ROOT}/001 A/少女之梦/readme.txt`]: '', // 非方言：不收
    [`${ROOT}/001 A/少女之梦/裏`]: 'DIR',
    [`${ROOT}/001 A/少女之梦/裏/M_KOJO_MESSAGE_COM_K1_2.erb`]: '', // 深度 3 的方言文件（深层不筛掉的守卫）
    [`${ROOT}/001 A/少女之梦/裏/note.md`]: '',
    [`${ROOT}/001 A/包A`]: 'DIR',
    [`${ROOT}/001 A/包A/M_KOJO_COMMAND_K1_1.ERH`]: '', // 方言扩展名命中
    [`${ROOT}/011 B`]: 'DIR',
    [`${ROOT}/011 B/x.ERB`]: '',
  };

  it('只收方言文件、深度不限（目录一律放行 + 深层不筛掉——旧「静默少收」形的守卫）', async () => {
    const paths = await walkDialectPaths(fakeWalkDir(tree), [ROOT]);
    expect(paths.sort()).toEqual(
      [
        `${ROOT}/001 A/M_KOJO_K1.ERB`,
        `${ROOT}/001 A/少女之梦/M_KOJO_MESSAGE_COM_K1_1.ERB`,
        `${ROOT}/001 A/少女之梦/裏/M_KOJO_MESSAGE_COM_K1_2.erb`,
        `${ROOT}/001 A/包A/M_KOJO_COMMAND_K1_1.ERH`,
        `${ROOT}/011 B/x.ERB`,
      ].sort(),
    );
    expect(paths.some((p) => p.endsWith('readme.txt') || p.endsWith('note.md'))).toBe(false);
  });

  it('每根只发一次 walkDir（N 根 → N 次请求）；根不存在 → 空数组不抛', async () => {
    const calls: string[] = [];
    await walkDialectPaths(fakeWalkDir(tree, calls), [ROOT]);
    expect(calls).toEqual([ROOT]);

    const calls2: string[] = [];
    const two = await walkDialectPaths(fakeWalkDir(tree, calls2), [`${ROOT}/001 A`, `${ROOT}/011 B`]);
    expect(calls2).toEqual([`${ROOT}/001 A`, `${ROOT}/011 B`]);
    expect(two).toHaveLength(5); // 001 A 子树 4 份 + 011 B 1 份

    const missing = await walkDialectPaths(fakeWalkDir(tree), ['C:/nope']);
    expect(missing).toEqual([]);
  });

  it('walk 结果可直接喂给 buildFileGroups（快照 → 分组的端到端形状）', async () => {
    const paths = await walkDialectPaths(fakeWalkDir(tree), [ROOT]);
    const owners = [{ prefix: `${ROOT}/001 A`, label: '#1 霊夢' }];
    const groups = buildFileGroups(paths, owners);
    expect(groups.map((g) => g.label)).toEqual(['#1 霊夢', '(未归属)']);
    expect(groups[0]!.total).toBe(4);
    expect(groups[1]!.subs[0]!.files.map((f) => f.split('/').pop())).toEqual(['x.ERB']);
  });
});

/* ============ 过滤态渲染窗口（PERF-6：filter 强制全展开的卡顿处理） ============ */

/** 造 N 个组的分组表（每组一个包、包内 filesEach 个文件） */
function mkGroups(nGroups: number, filesEach: number) {
  return Array.from({ length: nGroups }, (_, gi) => {
    const label = `#${gi + 1} 角色`;
    const files = Array.from({ length: filesEach }, (_, i) => `C:/koa/${gi}/M_KOJO_K${gi}_${i}.ERB`);
    return { label, prefix: `C:/koa/${gi}`, subs: [{ label: '包A', files }], total: files.length };
  });
}

describe('filterRenderPlan · 强制全展开时的每帧渲染预算', () => {
  it('默认首帧 = FILTER_WINDOW_INITIAL 行（不随命中数放大）', () => {
    const plan = filterRenderPlan(mkGroups(155, 20), undefined); // 命中 3100
    expect(plan.matched).toBe(3100);
    expect(plan.rendered).toBe(FILTER_WINDOW_INITIAL);
    expect(plan.hidden).toBe(3100 - FILTER_WINDOW_INITIAL);
    // 预算按显示顺序切：前 6 组满（20×6=120），第 7 组起一行不给
    expect([...plan.perPackage.values()].reduce((n, v) => n + v, 0)).toBe(FILTER_WINDOW_INITIAL);
    expect(plan.perPackage.get('#1 角色::包A')).toBe(20);
    expect(plan.perPackage.get('#6 角色::包A')).toBe(20);
    expect(plan.perPackage.has('#7 角色::包A')).toBe(false);
  });

  it('命中少于窗口 ⇒ 全渲染、hidden = 0（短词/常见路径 = 改动前行为）', () => {
    const plan = filterRenderPlan(mkGroups(2, 10), undefined);
    expect(plan).toMatchObject({ rendered: 20, matched: 20, hidden: 0 });
    expect(plan.perPackage.size).toBe(2);
  });

  it('窗口是累加的：同一计划下前一窗渲染的行一定还在（不清旧添新 ⇒ 视觉不跳）', () => {
    const groups = mkGroups(30, 15); // 450 命中
    const w1 = filterRenderPlan(groups, undefined);
    const w2 = filterRenderPlan(groups, nextFilterWindow(undefined, w1.matched));
    for (const [k, n1] of w1.perPackage) expect(w2.perPackage.get(k)).toBeGreaterThanOrEqual(n1);
    expect(w2.rendered).toBe(FILTER_WINDOW_INITIAL + FILTER_WINDOW_STEP);
  });

  it('反复按 STEP 生长到全量可达（不存在"截了就不给看"的死上限）', () => {
    const groups = mkGroups(30, 15); // 450
    let win: number | undefined = undefined;
    let steps = 0;
    for (;;) {
      const plan = filterRenderPlan(groups, win);
      if (plan.hidden === 0) break;
      const next = nextFilterWindow(win, plan.matched);
      expect(next).toBeGreaterThan(win ?? FILTER_WINDOW_INITIAL);
      expect(next - (win ?? FILTER_WINDOW_INITIAL)).toBeLessThanOrEqual(FILTER_WINDOW_STEP);
      win = next;
      expect(++steps).toBeLessThan(50); // 不收敛必须红
    }
    expect(filterRenderPlan(groups, win).rendered).toBe(450);
  });

  it('零命中/空表 ⇒ 空计划且不抛', () => {
    expect(filterRenderPlan([], undefined)).toEqual({ perPackage: new Map(), rendered: 0, matched: 0, hidden: 0 });
  });

  it('只读输入：计划不改动分组数组（组头计数继续显示真实命中数）', () => {
    const groups = mkGroups(20, 10);
    const snapshot = JSON.stringify(groups);
    filterRenderPlan(groups, 5);
    expect(JSON.stringify(groups)).toBe(snapshot);
  });
});

describe('FileRows · 过滤态 DOM 行树上界（SSR 真实产出的行数）', () => {
  const many = Array.from({ length: 3000 }, (_, i) => `C:/koa/0/M_KOJO_K1_${i}.ERB`);
  const count = (markup: string): number => (markup.match(/class="tree-file/g) ?? []).length;
  // 选中态自 PERF 批起走模块级订阅（不再穿 props）：SSR 没有 store 通知，按渲染时那一刻的值算
  afterEach(() => resetSelectionForTest());

  it('3000 个命中只挂 FILTER_WINDOW_INITIAL 行（旧实现：强制全展开 ⇒ 3000 行一起挂）', () => {
    const html = renderToStaticMarkup(h(FileRows, { files: many, limit: FILTER_WINDOW_INITIAL, onOpenFile: () => {} }));
    expect(count(html)).toBe(FILTER_WINDOW_INITIAL);
  });

  it('limit ≥ 文件数 ⇒ 全量渲染（非过滤态行为逐字不变）', () => {
    const html = renderToStaticMarkup(h(FileRows, { files: many, limit: many.length, onOpenFile: () => {} }));
    expect(count(html)).toBe(3000);
  });

  it('高亮当前文件不丢（PERF 不许改的那条行为）', () => {
    const files = ['C:/a.ERB', 'C:/b.ERB'];
    setActivePath('C:/b.ERB');
    const html = renderToStaticMarkup(h(FileRows, { files, limit: 120, onOpenFile: () => {} }));
    expect(html).toContain('class="tree-file active"');
    expect(html.match(/class="tree-file active"/g)).toHaveLength(1);
    expect(html).toContain('title="C:/b.ERB"');
    // 读屏语义只有一行（`aria-current` 与 `.active` 同一个布尔，不许两份判据）
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('首帧渲染数 = 计划的 rendered（计划与渲染同一条预算，两处不许各算各的）', () => {
    const groups = mkGroups(40, 12); // 480 命中
    const plan = filterRenderPlan(groups, undefined);
    const rows = groups.flatMap((g) => g.subs.map((s) => plan.perPackage.get(`${g.label}::${s.label ?? ''}`) ?? 0));
    expect(rows.reduce((n, v) => n + v, 0)).toBe(plan.rendered);
  });

  it('微基准：一次提交的行挂载成本 before（全量 3000 行）/ after（首帧 120 行）', () => {
    const files = many;
    const render = (limit: number): number => {
      const t0 = performance.now();
      renderToStaticMarkup(h(FileRows, { files, limit, onOpenFile: () => {} }));
      return performance.now() - t0;
    };
    for (let i = 0; i < 5; i++) {
      render(FILTER_WINDOW_INITIAL);
      render(files.length);
    }
    const sample = (limit: number, n: number): number => {
      const ds: number[] = [];
      for (let i = 0; i < n; i++) ds.push(render(limit));
      ds.sort((a, b) => a - b);
      return ds[Math.floor(n / 2)]!;
    };
    const before = sample(files.length, 15);
    const after = sample(FILTER_WINDOW_INITIAL, 15);
    console.log(
      `[PERF tree] 过滤态一帧的行构造成本（3,000 命中 / SSR 计行 + 建元素）：\n` +
        `  before（强制全展开 = 3000 行）median ${before.toFixed(3)} ms\n` +
        `  after（首帧窗口 = ${FILTER_WINDOW_INITIAL} 行）median ${after.toFixed(3)} ms\n` +
        `  ⇒ median 比 ${(before / Math.max(after, 1e-6)).toFixed(1)}×`,
    );
    expect(after).toBeLessThan(before);
  });
});

/* ============ 文件树编辑批（B1/B2/B4）：文件行右键 / 行内重命名 / data-locate ============ */

describe('FileRows · 文件行右键与行内重命名（B1）', () => {
  const files = ['C:/koa/001/M_KOJO_K1.ERB', 'C:/koa/001/M_KOJO_K2.ERB'];
  const base = {
    files,
    limit: 10,
    onOpenFile: () => {},
  };

  it('缺省（无 edit / 无 onFileContext）：旧行为逐字不变', () => {
    const html = renderToStaticMarkup(h(FileRows, base));
    expect(html.match(/<button class="tree-file/g)).toHaveLength(2);
    expect(html).not.toContain('tree-edit-input');
    expect(html).not.toContain('oncontextmenu');
  });

  it('文件行挂 data-locate（B4 定位的查询锚），值 = 完整路径', () => {
    const html = renderToStaticMarkup(h(FileRows, base));
    expect(html).toContain('data-locate="C:/koa/001/M_KOJO_K1.ERB"');
  });

  it('onFileContext / edit 缺省时旧行为逐字不变（SSR 不序列化事件处理器，行为面以 DOM 形状为准）', () => {
    const html = renderToStaticMarkup(h(FileRows, base));
    expect(html).not.toContain('tree-edit-input');
    expect(html.match(/<button class="tree-file/g)?.length).toBe(2);
  });

  it('edit.path 命中的那一行换画输入框（同名只此一行，其余行照常）', () => {
    const html = renderToStaticMarkup(
      h(FileRows, {
        ...base,
        edit: { path: files[0]!, node: h('input', { className: 'tree-edit-input' }) },
      }),
    );
    expect(html.match(/tree-edit-input/g)).toHaveLength(1);
    expect(html.match(/<button class="tree-file/g)).toHaveLength(1);
    expect(html).toContain('data-locate="C:/koa/001/M_KOJO_K2.ERB"');
    expect(html).not.toContain('data-locate="C:/koa/001/M_KOJO_K1.ERB"'); // 编辑中的行不是按钮
  });

  it('长文件名显示名裁中段保住扩展名，title 仍是完整路径（L16 行级接线）', () => {
    const long = 'C:/koa/001/M_KOJO_K1_2_超长口上事件脚本测试.ERB';
    const html = renderToStaticMarkup(
      h(FileRows, { files: [long], limit: 1, onOpenFile: () => {} }),
    );
    expect(html).toContain('…');
    expect(html).toContain('.ERB');
    expect(html).toContain(`title="${long}"`);
  });
});

describe('DirRows · 行级文件名中段省略与缩进 token（L16 接线）', () => {
  const dir = 'C:/game/kojo/001/包';
  const longName = 'M_KOJO_K1_2_超长口上事件脚本测试.ERB';
  const props = {
    dir,
    depth: 2,
    skip: new Set<string>(),
    dirCache: new Map([[dir, [{ name: longName, path: `${dir}/${longName}`, isDirectory: false }]]]),
    subOpen: new Set<string>(),
    edit: null,
    editValue: '',
    glossOf: (n: string) => n,
    activeFile: null,
    setEditValue: () => {},
    commitEdit: () => {},
    cancelEdit: () => {},
    toggleSub: () => {},
    onOpenFile: () => {},
  };

  it('缩进 = calc(var(--tree-indent) * depth)（depth 2 仍是 28px 的倍数，不再写死裸 px）', () => {
    const html = renderToStaticMarkup(h(DirRows, props));
    expect(html).toContain('calc(var(--tree-indent) * 2)');
    expect(html).not.toContain('padding-left:28px');
  });

  it('深层目录里的文件行同样裁中段、title 保完整路径', () => {
    const html = renderToStaticMarkup(h(DirRows, props));
    expect(html).toContain('…');
    expect(html).toContain('.ERB');
    expect(html).toContain(`title="${dir}/${longName}"`);
  });
});

/* ============ 冷开占位文案（PERF-6 即时化批） ============ */

describe('FileTree · 索引未就绪时的占位自解释（SSR）', () => {
  const project = { charaIndex: new Map(), kojoPaths: ['C:/koa'] } as unknown as GameProject;
  const render = (walkDir?: (p: string, o?: WalkOptions) => Promise<DirEntry[]>): string =>
    renderToStaticMarkup(
      h(FileTree, { project, index: null, activeFile: null, onOpenFile: () => {}, walkDir }),
    );

  it('有 walkDir ⇒ 说"正在读取口上目录"（真的在读）', () => {
    expect(render(async () => [])).toContain('正在读取口上目录…');
  });

  it('无 walkDir（纯浏览器宿主）⇒ 退回旧文案「索引中…」，不对人撒谎', () => {
    expect(render(undefined)).toContain('索引中…');
  });

  it('占位期不渲染树（没有半棵空树、也没有过滤框）', () => {
    expect(render(async () => [])).not.toContain('tree-filter');
  });
});

/* ============ 文件系统视图（B5）：工具条已撤后的默认态 ============ */

describe('FileTree · 文件系统视图（B5，工具条撤除后 SSR 默认态）', () => {
  const project = {
    charaIndex: new Map(),
    kojoPaths: ['C:/koa'],
    rootDir: 'C:/game',
  } as unknown as GameProject;
  const index = { files: new Map(), byName: new Map() } as unknown as ErbIndex;
  const render = (listDir?: (p: string) => Promise<DirEntry[]>): string =>
    renderToStaticMarkup(
      h(FileTree, { project, index, activeFile: null, onOpenFile: () => {}, listDir }),
    );

  it('有 listDir（桌面壳）：不再渲染顶部按钮带，默认口上视图且 fs 根层不被预取（惰性不变）', () => {
    const html = render(async () => []);
    expect(html).not.toContain('tree-actions'); // 六个按钮整条撤了
    expect(html).not.toContain('全部文件'); // 视图切换入口随之退场（view 机器仍在，暂无 UI 入口）
    expect(html).not.toContain('读取目录…'); // fs 根层不该被预先拉取（惰性，切过去才取）
  });

  it('无 listDir（浏览器壳）：同样一颗按钮都不给——没有能力的东西不该以灰态出现', () => {
    const html = render(undefined);
    expect(html).not.toContain('tree-actions');
    expect(html).not.toContain('全部文件');
  });

  it('默认仍是口上树：过滤框在、fs 根层不在（切换态是浏览现场，不改变默认视图）', () => {
    const html = render(async () => []);
    expect(html).toContain('tree-filter');
    expect(html).not.toContain('C:/game'); // 项目根路径不出现在默认口上视图里
  });
});

describe('middleEllipsis · 长名中段省略保住扩展名（L16）', () => {
  it('②核心判据：样本名截后**仍含 .ERH**（尾部 ellipsis 吃掉的正是它）', () => {
    const out = middleEllipsis('长长的目录名/very.long.file.ERH', 16);
    expect(out).toContain('.ERH');
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.startsWith('长长的目录名/')).toBe(true); // 头部保住，裁的是中段
  });

  it('不超长原样返回；上限小于 4 没有裁的意义也原样返回', () => {
    expect(middleEllipsis('q.ERB', 24)).toBe('q.ERB');
    expect(middleEllipsis('恰好等于上限的名字.x'.slice(0, 10), 10)).toBe('恰好等于上限的名字.x'.slice(0, 10));
    expect(middleEllipsis('很长的名字不该被三位上限吃掉.ERB', 3)).toBe('很长的名字不该被三位上限吃掉.ERB');
  });

  it('无扩展名：保头裁中，末尾只剩省略号；隐藏名（点开头）不算扩展名', () => {
    const noExt = middleEllipsis('非常非常长的作者包目录名没有后缀', 10);
    expect(noExt).toHaveLength(10);
    expect(noExt.endsWith('…')).toBe(true);
    const hidden = middleEllipsis('.kojoprofileveryveryverylong', 10);
    expect(hidden.endsWith('…')).toBe(true); // dot=0 ⇒ 无后缀口径
  });

  it('后缀比预算还长时先保后缀（.ERH 优先于头部可读性）', () => {
    const out = middleEllipsis('a.very.long.trailing.kojo', 8);
    expect(out).toContain('…');
    expect(out.endsWith('.kojo')).toBe(true);
  });
});
