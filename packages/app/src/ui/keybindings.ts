import { useEffect, useState } from 'react';
import {
  parseKeybinding,
  chordEquals,
  formatKeybinding,
  byCodePoint,
  type KeyChord,
  type CommandEntry,
} from './commands';
import {
  KEYBINDING_CATEGORY_ORDER,
  KEYBINDING_SPECS,
  defaultKeybindingOf,
  keybindingSpecOf,
} from './keybinding-specs';

/**
 * 集中键位注册表（R8 快捷键批）——宿主层单一真源。
 *
 * ## 为什么要有这一层
 *
 * 键位此前散在两处字面量里（ShellLayout 壳层命令、ProjectView 编辑器区命令），加上
 * Monaco 内部 addCommand（Ctrl+S）与硬编码特例（F1 / Ctrl+K Z），「到底有哪些快捷键」
 * 只能靠读源码回答。本模块把它们收敛成一张可查、可显示、可改的表：
 *
 * - **一处可查**：`KEYBINDING_SPECS` 是全部宿主键位的清单（含 Monaco 内部的 Ctrl+S）；
 * - **可显示**：命令面板与「键盘快捷键」对话框都从这里拿缺省键位；
 * - **可改**：覆盖表持久化在 localStorage，改动经订阅广播，壳层命令表随版本号重建
 *   ——全局键盘处理器读的就是命令表的 `keybinding`，改键即刻生效，无需第二套分发逻辑；
 * - **可整页管理**：`buildKeybindingRows` / `filterKeybindingRows` / `keybindingChips` 给快捷键
 *   设置页提供行数据（含解绑、全部恢复缺省、撞键提示），页面自身不含任何键位判据。
 *
 * ## 边界（刻意不做的）
 *
 * - **不劫持 Monaco 内建键**：编辑器内的 Ctrl+F / Ctrl+H / F2 / Shift+Alt+F 等仍是
 *   Monaco 的键位服务在管，宿主注册表只登记我们**自己**处理的键；编辑器动作命令
 *   （查找/替换/重命名/查找引用/格式化）进命令面板但**不带缺省键位**——想要的话
 *   作者可以自己绑（覆盖表只影响宿主分发，不会与 Monaco 抢键）。
 * - **和弦不改**：Ctrl+K Z 是两键序列，全局处理器是特例分支，改键不在本批射程
 *   （`rebindable: false`，对话框里明示）。
 * - **不与 UI-4 roving tabindex 冲突**：本模块只定义键位数据，键盘可达性（方向键
 *   漫游、focus-visible）仍在各组件的漫游逻辑里，两不相干。
 *
 * ## 规格表已下沉（1023 开机图减重批）
 *
 * 中文标题、缺省键与分类序这张**纯数据表**搬到了 `./keybinding-specs`：右键菜单的
 * 数据面（`context-menu-model.ts`）只需要查表，从前为两根展示字符串把本模块整包
 * （localStorage 覆盖表、持久化、订阅、React 钩子）拖进首屏。这里保留原样的再导出，
 * 调用方一行不用改；**表仍只有一份**，本文件不再持有任何键位字面量。
 */

// 纯数据与纯查表函数住在 `./keybinding-specs`（零 import 的叶子模块）。这里再导出，
// 是为了让既有 `import { keybindingSpecOf } from './keybindings'` 的调用面保持不变。
export {
  KEYBINDING_CATEGORY_ORDER,
  KEYBINDING_SPECS,
  defaultKeybindingOf,
  keybindingSpecOf,
};
export type { KeybindingSpec } from './keybinding-specs';

/** 键位现状三态：原样 / 被改过 / 被作者关掉（解绑） */
export type BindingState = 'default' | 'overridden' | 'unbound';

/**
 * 快捷键页一行的行数据（纯派生，不含 React）。
 *
 * 为什么要在这一层算好而不是让组件各算各的：这一行要同时给出键位串（给分发与改键用）、
 * 人读展示形（给作者看）、状态与撞键提示；组件里各算一套就会出现「面板显示一个键、
 * 表格显示另一个键」——同一页两个真相是事故。
 */
export interface KeybindingRow {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** 生效键位串（和弦含空格，如 `'ctrl+k z'`）；无键位 = `undefined` */
  readonly keys: string | undefined;
  /** 人读展示形（走 `formatKeybinding`）；无键位 = 空串 */
  readonly display: string;
  readonly rebindable: boolean;
  readonly note: string | null;
  readonly state: BindingState;
  /** 与哪条命令撞了同一个键（对方展示名）；无冲突 = `null`。和弦不参与判重 */
  readonly conflictWith: string | null;
}

const STORAGE_KEY = 'kojo.keybindings.v1';

/** 覆盖表（id → 键位串）。node/无 localStorage 环境退化为内存表（测试与 SSR 不炸） */
let overrides: Record<string, string> = loadOverrides();

function loadOverrides(): Record<string, string> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      // 空串 = 作者显式要求「这个命令没有键位」，是合法持久化值。
      // 旧写法一刀切 `parseKeybinding(v) !== null` 会把它当坏数据滤掉（parseKeybinding('') 返回 null），
      // 于是解绑存进去、下次启动悄悄复活——作者以为解绑没生效。
      if (v === '' || parseKeybinding(v) !== null) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // 存储不可写（隐私模式等）：覆盖仍在内存里活到本会话结束，改键不因此坏掉
  }
}

/* ---------------------------- 订阅（版本号驱动重建） ---------------------------- */

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** 订阅覆盖表变化（返回退订函数） */
export function subscribeKeybindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前版本号（React 侧经 useKeybindingsVersion 消费） */
export function keybindingsVersion(): number {
  return version;
}

/** React 钩子：覆盖表变化即重渲染（命令表据此重建，改键即刻生效） */
export function useKeybindingsVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => subscribeKeybindings(() => setV(keybindingsVersion())), []);
  return v;
}

/* ---------------------------- 查询与修改 ---------------------------- */

/** 生效键位 = 覆盖 ?? 缺省；不在注册表 = undefined；已解绑也 = undefined（无键位可用） */
export function effectiveKeybindingOf(id: string): string | undefined {
  const o = overrides[id];
  if (o === '') return undefined; // 显式解绑：覆盖表里存空串，对分发与展示都等于「没有键位」
  if (o !== undefined) return o;
  return defaultKeybindingOf(id);
}

/** 这条键位现在是原样、被改过，还是被作者关掉了（快捷键页的行徽标据此画） */
export function bindingStateOf(id: string): BindingState {
  const o = overrides[id];
  if (o === undefined) return 'default';
  return o === '' ? 'unbound' : 'overridden';
}

/**
 * 「这一行的键位被作者动过没有」——**全仓唯一定义**。
 *
 * 为什么必须是一枚函数而不是各处一遍比较：问这句话的有两处，而且是同一件事的两张面孔——
 * ① 快捷键页的范围档「已改」与计数读数（`KeybindingsPage.tsx`）；
 * ② 右键菜单里「重置键位」到底可不可点（`settings-menu.ts` 的 `hasOverride`）。
 * 改前两处各抄了一份同样的比较，口径漂移在语法上完全合法（谁都不会报错），只有读代码
 * 的人能发现——正是 `problem-truth-single-source` 那一类事故的形状。判据从此只住这里，
 * 消费侧一律 import；`tests/keybinding-modified-single-source.test.ts` 把「只有一处定义」
 * 钉成静态断言。
 *
 * 真值仍来自 `bindingStateOf`（localStorage 覆盖表）：三态里除 `default`（原样）都算动过
 * ——`overridden` 是改了键，`unbound` 是作者明确表达过「这条不要键位」，那也是一次改动。
 */
export function isKeybindingRowModified(row: KeybindingRow): boolean {
  return row.state !== 'default';
}

/** 覆盖条数（含已解绑——解绑也是作者做过的改动，得计入「有几处不是缺省」） */
export function overrideCount(): number {
  return Object.keys(overrides).length;
}

/**
 * 全部回到缺省（含解绑），返回被清掉的条数。
 * 空表**不落盘也不广播**：一次无改动的点击让整张命令表重建一遍，只是白白抖一次界面，
 * 还会把「恢复过」这个信号抹平成「刚刚改过」。
 */
export function resetAllKeybindings(): number {
  const cleared = overrideCount();
  if (cleared === 0) return 0;
  overrides = {};
  persist();
  bump();
  return cleared;
}

/** 该 id 是否有用户覆盖 */
export function hasKeybindingOverride(id: string): boolean {
  return overrides[id] !== undefined;
}

/**
 * 设置覆盖（`keys` = 键位串；`''` = 解绑，即作者显式要求这个命令没有键位；`null` = 回缺省）。
 * 非法键位串与不可改键的条目拒绝并返回 false
 * ——改键是持久化操作，宁可按不下也不能写进坏数据。
 */
export function setKeybindingOverride(id: string, keys: string | null): boolean {
  const spec = keybindingSpecOf(id);
  if (!spec || !spec.rebindable) return false;
  if (keys === null) {
    if (overrides[id] === undefined) return true; // 幂等：本来就没有覆盖
    delete overrides[id];
    persist();
    bump();
    return true;
  }
  if (keys === '') {
    if (overrides[id] === '') return true; // 幂等：已经是解绑态
    overrides[id] = '';
    persist();
    bump();
    return true;
  }
  const parsed = parseKeybinding(keys);
  if (parsed === null || /\s/.test(parsed.key)) return false; // 主键带空白 = 不是一键（坏数据不进持久化）
  overrides[id] = keys;
  persist();
  bump();
  return true;
}

/**
 * 键位冲突检测：除 `excludeId` 外还有哪条命令占了同一个 chord（展示给作者看，
 * 不阻止——分发按注册表顺序先到先得，冲突方让位，对话框里一句话说清）。
 */
export function keybindingConflictWith(chord: KeyChord, excludeId: string): string | null {
  for (const spec of KEYBINDING_SPECS) {
    if (spec.id === excludeId) continue;
    const keys = effectiveKeybindingOf(spec.id);
    if (keys === undefined || keys.includes(' ')) continue; // 和弦走全局处理器特例，不算单键冲突
    const parsed = parseKeybinding(keys);
    if (parsed && chordEquals(parsed, chord)) return spec.title;
  }
  return null;
}

/** KeyChord → 键位串（`parseKeybinding` 的逆；捕获改键时落库用） */
export function chordToBinding(c: KeyChord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('ctrl');
  if (c.shift) parts.push('shift');
  if (c.alt) parts.push('alt');
  if (c.meta) parts.push('meta');
  parts.push(c.key);
  return parts.join('+');
}

/* ---------------------------- 快捷键页的表格视图 ---------------------------- */

/** 分类在序表里的位次；未登记的分类一律排到最后（漏登记只是靠后，不是消失） */
function categoryRank(category: string): number {
  const i = KEYBINDING_CATEGORY_ORDER.indexOf(category);
  return i === -1 ? KEYBINDING_CATEGORY_ORDER.length : i;
}

function compareRows(a: KeybindingRow, b: KeybindingRow): number {
  const ra = categoryRank(a.category);
  const rb = categoryRank(b.category);
  if (ra !== rb) return ra - rb;
  // 同位次只可能是「都没登记的不同分类」，否则就是同一分类 ⇒ 按码点序（不用 localeCompare，理由见 commands.ts）
  if (a.category !== b.category) return byCodePoint(a.category, b.category);
  return byCodePoint(a.title, b.title);
}

/**
 * 命令注册表 + 键位表 ⇒ 快捷键页的表格行。
 *
 * 行的**有无**取自命令注册表（那里才是「到底有哪些命令」的真相），键位表只补充
 * 「能不能改、缺省是什么、有什么要说」——只在键位表登记、命令面板里没有的东西不该出现在页面上，
 * 反之新命令忘了登记键位也必须看得见（否则作者无从知道它存在，只是改不了键）。
 *
 * 纯派生：同样的命令清单 + 同样的覆盖表 ⇒ 同样的行序，组件侧不必再排序或去重。
 */
export function buildKeybindingRows(commands: readonly CommandEntry[]): KeybindingRow[] {
  const rows: KeybindingRow[] = commands.map((c) => {
    const spec = keybindingSpecOf(c.id);
    const keys = effectiveKeybindingOf(c.id) ?? c.keybinding;
    return {
      id: c.id,
      // 展示名以命令项为准——命令面板显示什么，这里就显示什么；命令项没给词才退回键位表
      title: c.title === '' ? (spec?.title ?? '') : c.title,
      category: c.category ?? spec?.category ?? '',
      keys,
      display: keys === undefined ? '' : formatKeybinding(keys),
      // 没在键位表登记过的命令一律不许改键：改键只对「知道缺省、也知道怎么复原」的键位开放
      rebindable: spec?.rebindable ?? false,
      note: spec?.note ?? null,
      state: bindingStateOf(c.id),
      conflictWith: null,
    };
  });
  rows.sort(compareRows);

  // 撞键分组：先把键位串归一再比（`shift+ctrl+p` 与 `ctrl+shift+p` 是同一个键，字面不同而已）。
  // 和弦（含空格）不参与判重——它由全局处理器的特例分支分发，与单键不同一条路径。
  const groups = new Map<string, KeybindingRow[]>();
  for (const row of rows) {
    const keys = row.keys;
    if (keys === undefined || keys.includes(' ')) continue;
    const parsed = parseKeybinding(keys);
    if (parsed === null) continue;
    const canonical = chordToBinding(parsed);
    const bucket = groups.get(canonical);
    if (bucket) bucket.push(row);
    else groups.set(canonical, [row]);
  }

  const partners = new Map<KeybindingRow, string>();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    bucket.forEach((row, at) => {
      // 「第一个对方」按排序后的行序取，故同输入同输出（不依赖分组遍历以外的顺序）
      const partner = bucket[at === 0 ? 1 : 0];
      if (partner) partners.set(row, partner.title);
    });
  }
  if (partners.size === 0) return rows;
  return rows.map((row) => {
    const partner = partners.get(row);
    return partner === undefined ? row : { ...row, conflictWith: partner };
  });
}

/** 搜索用的归一形：小写 + 去空白，作者敲 `ctrl + k` 也命中展示形 `Ctrl+K` */
function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

/** 快捷键页的搜索框过滤（命中 标题/分类/展示键位/id；空串返回全部且是**新数组**） */
export function filterKeybindingRows(rows: readonly KeybindingRow[], query: string): KeybindingRow[] {
  const q = normalizeForSearch(query);
  if (q === '') return [...rows];
  return rows.filter(
    (r) => normalizeForSearch(`${r.title} ${r.category} ${r.display} ${r.id}`).includes(q),
  );
}

/**
 * 键位串 → 一枚枚按键芯片（`'ctrl+k z'` ⇒ `[['Ctrl','K'],['Z']]`；和弦一步一组，画成「按这组，再按这组」）。
 *
 * 展示口径直接借 `formatKeybinding` 再拆开，不在这里重排修饰键——两处各写一套顺序，
 * 命令面板的提示和快捷键页的芯片就会两个词。非法串返回空数组而不抛：
 * 表格渲染里抛一次 = 整页白屏，比画不出芯片严重得多。
 */
export function keybindingChips(binding: string): string[][] {
  if (typeof binding !== 'string') return [];
  const steps = binding.trim().split(/\s+/).filter(Boolean);
  const out: string[][] = [];
  for (const step of steps) {
    if (parseKeybinding(step) === null) return []; // 任一步不认得 ⇒ 整串不画芯片
    out.push(formatKeybinding(step).split('+'));
  }
  return out;
}
