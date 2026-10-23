// @vitest-environment happy-dom
/**
 * 设置页 / 快捷键页两个右键菜单面（1023 覆盖面批 · WP4.5/4.6；2026-10 从 `pages-menus`
 * 拆出并搬到懒模块 `settings-menu.ts`）。
 *
 * ## 为什么这两面单独一份测试
 *
 * 它们的数据面原先与欢迎页同住 `context-menu-pages.ts`——而那个模块在**开机图**上，
 * 于是 `settings-search`（设置项索引）/ `editor-display-prefs`（外观偏好，连带
 * `editor-options`）/ `keybindings`（键位表）全被拖进首屏，可这三样只在设置浮层里才有用。
 * 搬走之后，"搬干净了没有"不能靠肉眼看，所以本文件最后一块是**源码守门**：
 *
 * 1. `context-menu-pages.ts` 不许再有对那四个模块的**值导入**（判据：与
 *    `ps10-eager-graph.test.ts` 同一套走图规则——`import type …` 与「整串都是 type 的
 *    具象导入」（`import { type X }`）会被 Vite 擦除，**不算**；裸副作用 import
 *    （`import './x'`）与 `export … from` 会把模块真加载进来，**算**）；
 * 2. `settings-menu.ts` 必须由 `SettingsPanel.tsx`（懒 chunk）直接 import，且
 *    **只**被懒 chunk 里的文件 import——任何人从常驻模块 re-export 一下都算把懒边接回首屏；
 * 3. `settings` / `keybindings` 两个面在全仓各**恰好一处** `declareContextSurface`。
 *
 * 前面几块是功能断言：菜单项集合 × 能力矩阵、label 与禁用原因全中文、DOM 行属性 →
 * 面的 build → 选中分发这条线真的接通了（纯函数对了但面没接上，用户按下去照样是兜底菜单）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KEYBINDING_ACTION,
  SETTINGS_ACTION,
  SETTINGS_RESET_TABLE,
  buildKeybindingRowMenu,
  buildSettingsRowMenu,
  keybindingMenuStateOf,
  registerKeybindingsMenuBridge,
  registerSettingsMenuBridge,
  settingsResetEntryOf,
  settingsRowJsonOf,
  settingsSectionLabelOf,
  type KeybindingRowMenuInput,
} from '../src/ui/settings-menu';
import {
  buildContextMenuRoute,
  getContextSurface,
  CONTEXT_SURFACE_MANIFEST,
} from '../src/ui/context-surfaces';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import type { KeybindingRow } from '../src/ui/keybindings';

/** 每条项（含子菜单）的 label 与禁用原因都必须是中文 */
function expectAllChinese(items: readonly ContextMenuItem[], where: string): void {
  for (const item of items) {
    expect(isChineseMenuLabel(item.label), `${where} · ${item.id} 的 label`).toBe(true);
    if (item.disabled) {
      expect(item.disabledReason, `${where} · ${item.id} 灰着却没说原因`).toBeTruthy();
      expect(isChineseMenuLabel(item.disabledReason ?? ''), `${where} · ${item.id} 的禁用原因`).toBe(true);
    }
    if (item.children) expectAllChinese(item.children, where);
  }
}

const ids = (items: readonly ContextMenuItem[]): string[] => items.map((i) => i.id);

const itemOf = (items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined =>
  items.find((i) => i.id === id);

describe('设置页（WP4.5）', () => {
  const resettable = { label: '正文字号', isDefault: false } as const;

  it('非默认值 ⇒「重置此项」可按；同时给出复制两项与搜索', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '编辑器',
      resettable,
      canCopy: true,
    });
    expect(ids(items)).toEqual([
      SETTINGS_ACTION.reset,
      SETTINGS_ACTION.copyId,
      SETTINGS_ACTION.copyJson,
      SETTINGS_ACTION.searchSection,
    ]);
    expect(itemOf(items, SETTINGS_ACTION.reset)?.disabled).toBeUndefined();
    expectAllChinese(items, '设置行');
  });

  it('已是默认值 ⇒ 灰着并说明「已是默认值」', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '编辑器',
      resettable: { label: '正文字号', isDefault: true },
      canCopy: true,
    });
    const reset = itemOf(items, SETTINGS_ACTION.reset);
    expect(reset?.disabled).toBe(true);
    expect(reset?.disabledReason).toBe('已是默认值');
    expectAllChinese(items, '设置行 · 默认值');
  });

  it('这一行没有默认值可回（没登记真源）⇒ 重置与「复制为 JSON」都不出现', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '关于',
      resettable: null,
      canCopy: true,
    });
    expect(itemOf(items, SETTINGS_ACTION.reset)).toBeUndefined();
    expect(itemOf(items, SETTINGS_ACTION.copyJson)).toBeUndefined();
    expect(itemOf(items, SETTINGS_ACTION.copyId)).toBeDefined();
    expect(itemOf(items, SETTINGS_ACTION.searchSection)).toBeDefined();
  });

  it('没有剪贴板 ⇒ 复制两项整组消失（搜索仍在）', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '编辑器',
      resettable,
      canCopy: false,
    });
    expect(ids(items)).toEqual([SETTINGS_ACTION.reset, SETTINGS_ACTION.searchSection]);
    expectAllChinese(items, '设置行 · 无剪贴板');
  });

  it('「搜索同类设置」的文案带上节名（填进搜索框的就是这个词）', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '外观',
      resettable: null,
      canCopy: true,
    });
    expect(itemOf(items, SETTINGS_ACTION.searchSection)?.label).toBe('搜索「外观」类设置');
  });

  it('节名：搜索索引登记过的走索引，没登记的退回键前缀', () => {
    expect(settingsSectionLabelOf('editor.fontSize')).toBe('编辑器');
    expect(settingsSectionLabelOf('about.update')).toBe('关于');
    expect(settingsSectionLabelOf('market.endpoint')).toBe('口上市场');
    // 这一行没进搜索索引（真源是 theme-pref），前缀兜底仍给出同一个节名
    expect(settingsSectionLabelOf('appearance.followSystem')).toBe('外观');
    // 前缀也不认识的：给一个中文兜底，绝不返回空串（空串 = 把搜索框清空）
    expect(settingsSectionLabelOf('nobody.knows')).toBe('设置');
  });

  it('可重置登记表：每项键与页面锚点同串、叫法全中文、初始即默认值', () => {
    expect(SETTINGS_RESET_TABLE.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const entry of SETTINGS_RESET_TABLE) {
      expect(entry.key).toMatch(/^[a-z]+\.[A-Za-z]+$/);
      expect(seen.has(entry.key), `${entry.key} 重复登记`).toBe(false);
      seen.add(entry.key);
      expect(isChineseMenuLabel(entry.label), entry.key).toBe(true);
      // node 环境没有 localStorage ⇒ 各偏好读到缺省值，故「是不是默认」恒真
      expect(entry.isDefault(), `${entry.key} 初始应为默认`).toBe(true);
      expect(entry.read(), `${entry.key} 读不到值`).not.toBeUndefined();
      expect(settingsResetEntryOf(entry.key)).toBe(entry);
    }
    expect(settingsResetEntryOf('about.contact')).toBeUndefined();
  });

  it('「复制为 JSON」有值来源：键与当前值成对；未登记的行没有 JSON', () => {
    expect(settingsRowJsonOf('editor.fontSize')).toBe('{"editor.fontSize":14}');
    expect(settingsRowJsonOf('about.contact')).toBeNull();
  });
});

describe('快捷键页（WP4.6）', () => {
  const row: KeybindingRowMenuInput = {
    id: 'layout.toggleSidebar',
    title: '切换主侧栏',
    rebindable: true,
    hasOverride: true,
    hasKeys: true,
    conflictWith: null,
    conflictCount: 0,
    canCopy: true,
  };

  it('可改键且有覆盖：复制命令 ID / 重置键位 / 移除键位', () => {
    const items = buildKeybindingRowMenu(row);
    expect(ids(items)).toEqual([
      KEYBINDING_ACTION.copyId,
      KEYBINDING_ACTION.reset,
      KEYBINDING_ACTION.remove,
    ]);
    expect(items.some((i) => i.disabled === true)).toBe(false);
    expectAllChinese(items, '快捷键行');
  });

  it('没有覆盖 ⇒「重置键位」灰着说明', () => {
    const items = buildKeybindingRowMenu({ ...row, hasOverride: false });
    const reset = itemOf(items, KEYBINDING_ACTION.reset);
    expect(reset?.disabled).toBe(true);
    expect(reset?.disabledReason).toBe('这一条还是默认键位');
    expectAllChinese(items, '快捷键行 · 无覆盖');
  });

  it('解绑后没有键位 ⇒「移除键位」灰着说明', () => {
    const items = buildKeybindingRowMenu({ ...row, hasKeys: false });
    const remove = itemOf(items, KEYBINDING_ACTION.remove);
    expect(remove?.disabled).toBe(true);
    expect(remove?.disabledReason).toBe('这一条本来就没有键位');
  });

  it('不可改键的行（和弦 / Monaco 内建）⇒ 改键两项整组不显示', () => {
    const items = buildKeybindingRowMenu({ ...row, rebindable: false });
    expect(itemOf(items, KEYBINDING_ACTION.reset)).toBeUndefined();
    expect(itemOf(items, KEYBINDING_ACTION.remove)).toBeUndefined();
    expect(itemOf(items, KEYBINDING_ACTION.copyId)).toBeDefined();
  });

  it('有撞键才出现「查看同键位冲突」，且冲突条数上屏', () => {
    expect(itemOf(buildKeybindingRowMenu(row), KEYBINDING_ACTION.showConflict)).toBeUndefined();
    const items = buildKeybindingRowMenu({ ...row, conflictWith: '切换底部区', conflictCount: 4 });
    const conflict = itemOf(items, KEYBINDING_ACTION.showConflict);
    expect(conflict).toBeDefined();
    expect(conflict?.label).toBe('查看同键位冲突（共 4 项）');
    expectAllChinese(items, '快捷键行 · 撞键');
  });

  it('没有剪贴板 ⇒「复制命令 ID」不显示', () => {
    const items = buildKeybindingRowMenu({ ...row, canCopy: false });
    expect(itemOf(items, KEYBINDING_ACTION.copyId)).toBeUndefined();
    expectAllChinese(items, '快捷键行 · 无剪贴板');
  });

  it('KeybindingRow → 菜单读数：三态与键位有无各归各位', () => {
    const base: KeybindingRow = {
      id: 'editor.action.rename',
      title: '重命名符号',
      category: '编辑器',
      keys: 'f2',
      display: 'F2',
      rebindable: true,
      note: null,
      state: 'overridden',
      conflictWith: '查找',
    };
    expect(keybindingMenuStateOf(base)).toEqual({
      id: 'editor.action.rename',
      title: '重命名符号',
      rebindable: true,
      hasOverride: true,
      hasKeys: true,
      conflictWith: '查找',
    });
    expect(keybindingMenuStateOf({ ...base, keys: undefined, state: 'unbound' })).toMatchObject({
      hasOverride: true,
      hasKeys: false,
    });
    expect(keybindingMenuStateOf({ ...base, state: 'default' }).hasOverride).toBe(false);
  });
});

describe('面注册：settings / keybindings 已登记且无障碍名与清单一致', () => {
  it('两面都在注册表里，都有 build，无障碍名与清单逐字一致', () => {
    for (const id of ['settings', 'keybindings']) {
      const spec = getContextSurface(id);
      const manifest = CONTEXT_SURFACE_MANIFEST.find((entry) => entry.id === id);
      expect(spec, `${id} 未声明`).toBeDefined();
      expect(spec?.build, `${id} 没有 build`).toBeTypeOf('function');
      expect(spec?.ariaLabel).toBe(manifest?.ariaLabel);
      expect(isChineseMenuLabel(spec?.ariaLabel ?? '')).toBe(true);
    }
  });
});

describe('接线：DOM 行属性 → 面的 build → 选中分发', () => {
  const event = (): MouseEvent =>
    new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 9 });

  /** 造一棵「面根 + 行」的 DOM，返回行里那个最深的可点元素 */
  const mountRow = (surfaceId: string, attrs: Record<string, string>): HTMLElement => {
    const root = document.createElement('div');
    root.setAttribute('data-context-surface', surfaceId);
    const row = document.createElement('div');
    for (const [key, value] of Object.entries(attrs)) row.setAttribute(key, value);
    const deep = document.createElement('span');
    row.appendChild(deep);
    root.appendChild(row);
    document.body.appendChild(root);
    return deep;
  };

  it('设置行：按 data-settings-key 定位，重置默认值时灰着说明，「搜索同类设置」写进搜索框', () => {
    const searched: string[] = [];
    registerSettingsMenuBridge({
      searchSection: (label) => searched.push(label),
      note: () => undefined,
    });
    const deep = mountRow('settings', { 'data-settings-key': 'editor.lineHeight' });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('settings');
    const reset = route?.items.find((i) => i.id === SETTINGS_ACTION.reset);
    expect(reset?.disabled).toBe(true);
    expect(reset?.disabledReason).toBe('已是默认值');
    route?.onSelect(SETTINGS_ACTION.searchSection);
    expect(searched).toEqual(['编辑器']);
    registerSettingsMenuBridge(null);
  });

  it('设置页空白处（不在任何设置行上）不表态，落回兜底菜单', () => {
    registerSettingsMenuBridge({ searchSection: () => undefined, note: () => undefined });
    const deep = mountRow('settings', { 'data-nothing': '1' });
    expect(buildContextMenuRoute(deep, event())?.source).toBe('app-fallback');
    registerSettingsMenuBridge(null);
  });

  it('快捷键行：按 data-kb-id 定位，「查看同键位冲突」交给页面切范围档', () => {
    const calls: string[] = [];
    registerKeybindingsMenuBridge({
      rowOf: (id) =>
        id === 'layout.toggleSidebar'
          ? {
              id,
              title: '切换主侧栏',
              rebindable: true,
              hasOverride: true,
              hasKeys: true,
              conflictWith: '切换底部区',
            }
          : undefined,
      conflictCount: () => 2,
      onlyConflicts: () => calls.push('onlyConflicts'),
      note: (line) => calls.push(`note:${line}`),
    });
    const deep = mountRow('keybindings', { 'data-kb-id': 'layout.toggleSidebar' });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('keybindings');
    expect(route?.items.map((i) => i.id)).toContain(KEYBINDING_ACTION.showConflict);
    route?.onSelect(KEYBINDING_ACTION.showConflict);
    expect(calls).toEqual(['onlyConflicts']);
    // 不认识的 id：这一级不表态
    const stranger = mountRow('keybindings', { 'data-kb-id': 'nobody.knows' });
    expect(buildContextMenuRoute(stranger, event())?.source).toBe('app-fallback');
    registerKeybindingsMenuBridge(null);
  });
});

/* ==========================================================================================
 * 源码守门：懒边不许被接回首屏
 * ========================================================================================== */

/**
 * 源码目录。
 *
 * 本文件跑在 happy-dom 下（接线那段要造 DOM），而在这个环境里 `import.meta.url` 不是
 * file scheme ⇒ `fileURLToPath` 会抛。故照 `find-pref.test.ts` 的先例从 `process.cwd()`
 * 往上找仓库根（认 `pnpm-workspace.yaml`），不依赖模块 URL。
 */
function uiDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) return path.join(dir, 'packages/app/src/ui');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'packages/app/src/ui');
}

const readUi = (name: string): string => readFileSync(path.join(uiDir(), name), 'utf8');

/**
 * 走图规则与 `ps10-eager-graph.test.ts` 对齐（那边是开机图闸，这边只管"单个文件往外拉了谁"）：
 * `import type …` 与整串都是 type 的具象导入会被 Vite 擦除，**不算值依赖**；
 * 裸副作用 import 与 `export … from` 真会加载模块，**算**。
 */
const STATIC_IMPORT_RE = /(?:^|\n)\s*import\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|\n)\s*export\s+(?!type\b)(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;

/** 具名导入里是否含"有值"绑定（`{ type Foo }` 这种整串都是类型的会被擦除） */
function hasValueBinding(clause: string): boolean {
  return clause
    .split(',')
    .some((part) => part.trim() !== '' && !/^\s*type\b/.test(part.trim()));
}

/** 某份源码的**值依赖** spec 列表（擦除型 import 已剔除） */
function valueSpecsOf(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(STATIC_IMPORT_RE)) if (hasValueBinding(m[1]!)) specs.push(m[2]!);
  for (const m of src.matchAll(BARE_IMPORT_RE)) specs.push(m[1]!);
  for (const m of src.matchAll(EXPORT_FROM_RE)) specs.push(m[1]!);
  return specs;
}

/** src 下全部 .ts/.tsx（相对 ui 目录的路径 + 源码）：几个守门用例共用一份，只读一次盘 */
let uiSourceCache: readonly { readonly rel: string; readonly src: string }[] | null = null;

function uiSources(): readonly { readonly rel: string; readonly src: string }[] {
  if (uiSourceCache !== null) return uiSourceCache;
  const walk = (dir: string, prefix: string): { rel: string; src: string }[] => {
    const out: { rel: string; src: string }[] = [];
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) {
        out.push(...walk(abs, `${prefix}${name}/`));
        continue;
      }
      if (name.endsWith('.ts') || name.endsWith('.tsx')) {
        out.push({ rel: `${prefix}${name}`, src: readFileSync(abs, 'utf8') });
      }
    }
    return out;
  };
  uiSourceCache = walk(uiDir(), '');
  return uiSourceCache;
}

describe('源码守门：设置/快捷键两面只在懒 chunk 里', () => {
  it('context-menu-pages.ts（开机图）不再值导入设置与键位那四坨', () => {
    const heavy = ['./editor-display-prefs', './editor-options', './settings-search', './keybindings'];
    const leaked = valueSpecsOf(readUi('context-menu-pages.ts')).filter((s) => heavy.includes(s));
    // 判据：`import type` / `import { type X }` 放行（编译期擦除），裸 import 与 export-from 不放行
    expect(leaked).toEqual([]);
  });

  it('context-menu-pages.ts 也不许转发搬走的符号（re-export 等于把懒边接回首屏）', () => {
    const src = readUi('context-menu-pages.ts');
    const forwarded = valueSpecsOf(src).filter((s) => s === './settings-menu' || s === '../ui/settings-menu');
    expect(forwarded).toEqual([]);
    // 搬走的符号一个都不许在本模块出现（`isPrimaryButton` 之类仍属公共小件，不在名单里）
    for (const gone of [
      'SETTINGS_RESET_TABLE',
      'buildSettingsRowMenu',
      'registerSettingsMenuBridge',
      'settingsSectionLabelOf',
      'KEYBINDING_ACTION',
      'buildKeybindingRowMenu',
      'registerKeybindingsMenuBridge',
    ]) {
      expect(src.includes(gone), `${gone} 仍留在 context-menu-pages.ts`).toBe(false);
    }
  });

  it('settings-menu.ts 由 SettingsPanel.tsx 直接 import（懒边成立）', () => {
    const panel = readUi('SettingsPanel.tsx');
    expect(valueSpecsOf(panel)).toContain('./settings-menu');
    expect(panel).toContain('registerSettingsMenuBridge');
  });

  it('settings-menu.ts 只被懒 chunk 里的文件 import（谁把它拉进常驻模块就等于取消了拆分）', () => {
    const isSettingsMenuSpec = (s: string): boolean => s === './settings-menu' || s === '../ui/settings-menu';
    const importers = uiSources()
      .filter(({ rel }) => rel !== 'settings-menu.ts')
      .filter(({ src }) => valueSpecsOf(src).some(isSettingsMenuSpec))
      .map(({ rel }) => rel)
      .sort();
    // SettingsPanel 与 KeybindingsPage 同属设置浮层那枚懒 chunk（前者静态引入后者）
    expect(importers).toEqual(['KeybindingsPage.tsx', 'SettingsPanel.tsx']);
  });

  it('settings / keybindings 两个面全仓各恰好一处 declareContextSurface', () => {
    const sources = uiSources();
    for (const id of ['settings', 'keybindings']) {
      const re = new RegExp(`declareContextSurface\\(\\s*\\{\\s*id:\\s*'${id}'`, 'g');
      const where = sources.filter(({ src }) => (src.match(re) ?? []).length > 0).map(({ rel }) => rel);
      expect(where.length, `${id} 的声明处数`).toBe(1);
      expect(where).toEqual(['settings-menu.ts']);
    }
  });
});
