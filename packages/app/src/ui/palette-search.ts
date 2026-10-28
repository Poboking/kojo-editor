import { CANDIDATE_BUDGETS, candidateBudget, candidateRank } from '@kojo/plugin-api';
import type { EditorCommandContext, EditorDocumentSymbol } from '@kojo/plugin-api';
import { commandEnabled, filterCommands, formatKeybinding, type CommandEntry } from './commands';
import { dirLabelParts, splitPath } from './path-label';

/**
 * 快速打开（Ctrl+P）多模式的**纯逻辑**（1020 编辑器体感批）。
 *
 * 拆出来的理由与 `commands.ts` / `workspace-symbols.ts` 同一口径：**查询与排序是数据判据，
 * 不是渲染细节**——只有脱离 React 才钉得住。本文件零 React、零 IO、零内核。
 *
 * ## 一条尺子，两趟收集
 *
 * 桶序**不在本文件**：子串四档（名字精确 → 名字前缀 → 名字含 → 只有路径含）用的仍是契约层
 * `candidateRank`，与 `Ctrl+T` / 函数树搜索 / 全文检索候选同桶同序（W7 NAV-SCOPE 的成果，
 * 不许在这里悄悄换成第五把尺子）。本文件只加**严格更低的一档**：子串四档全部落空
 * （契约给 `rank = 4` = "认不出"）时，才允许按**模糊子序列**补一排候选，排在所有子串命中之后。
 * 顺序因此永远是「子串命中优先，模糊补位在后」，既有读数不会翻盘。
 *
 * 补位趟**只在子串命中不够一屏时才扫**（`rankFiles` 里那条 `subs.length < budget` 门）：
 * 一次 Ctrl+P 铺满预算时不再对 2,325 条路径各扫一遍子序列；够用就停是刻意的取舍，
 * 代价是"命中已经够多时看不到模糊项"——那种时候作者要的是继续打字，不是翻页。
 *
 * ## 归一化缓存（PS-6 那条账）
 *
 * 路径清单是宿主 `useMemo` 出来的，**数组身份不变 = 内容不变** ⇒ 小写形与拆段只做一次，
 * 键在 `WeakMap` 上（清单换身份跟着回收）。模糊趟读的也是这份缓存里的小写串，
 * 所以每击键的真实分配仍是「查询串那一次」——`tests/ps6-rows.test.ts` 的计数闸钉着这条。
 */

/* ------------------------------ 模式（前缀） ------------------------------ */

/**
 * `Ctrl+P` 的四种输入模式（对标 VS Code Quick Open 的前缀族）。
 *
 * 判据只看**首字符**，不看"后面像不像路径"：`:` 出现在中间是 Windows 盘符
 * （`C:\game\…`），拿它当"转行号"会把作者的路径吃掉。前缀只在开头才算开关。
 */
export type PaletteModeKind = 'files' | 'commands' | 'symbols' | 'line';

export interface PaletteMode {
  readonly kind: PaletteModeKind;
  /** 去掉前缀之后的查询串（原样保留大小写与空白，由排序侧自己 trim） */
  readonly term: string;
}

/** `>` 命令 · `@` 当前文件符号 · `:` 跳到行号 · 其余 = 文件 */
export function parsePaletteMode(query: string): PaletteMode {
  const first = query.charAt(0);
  if (first === '>') return { kind: 'commands', term: query.slice(1) };
  if (first === '@') return { kind: 'symbols', term: query.slice(1) };
  if (first === ':') return { kind: 'line', term: query.slice(1) };
  return { kind: 'files', term: query };
}

/**
 * `:123` 里的行号（1 基）。只认「可选空白 + 纯数字 + 可选空白」：
 * 带任何别的东西（`12k`、空串、超长）回 `null`，由面板说"这不是行号"，
 * 不猜、也不把半个数字当成一次跳转。
 */
export function lineNumberOf(term: string): number | null {
  const m = /^\s*(\d{1,7})\s*$/.exec(term);
  if (!m) return null;
  const line = Number(m[1]);
  return Number.isSafeInteger(line) && line >= 1 ? line : null;
}

/**
 * `:` 模式那一条候选的键（前缀只为不与文件路径、命令 id 撞车）。
 * 造与拆都在这一处：组件里再手写一遍 `'line:' + n` 就是第二个真源。
 */
const LINE_KEY_PREFIX = 'line:';
export function lineKeyOf(line: number): string {
  return `${LINE_KEY_PREFIX}${line}`;
}
export function lineFromKey(key: string): number | null {
  return key.startsWith(LINE_KEY_PREFIX) ? lineNumberOf(key.slice(LINE_KEY_PREFIX.length)) : null;
}

/* ------------------------------ 模糊子序列 ------------------------------ */

/** 命中区间（左闭右开，按文本原样的下标；相邻的匹配字符合并成一段） */
export type HitRanges = readonly [number, number][];

const SEPARATORS = '/\\-_ .:';

/** 这个词是不是"新起一截"（分隔符之后 / 首字符 / 驼峰大写）——命中在这里的权重最高 */
function isWordBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text.charAt(at - 1);
  if (SEPARATORS.indexOf(prev) >= 0 || prev === '\t' || prev === '\n') return true;
  const cur = text.charAt(at);
  // 小写/数字 后接大写 = 驼峰边界（`mKojo` 里搜 `k` 该比 `ma` 里搜 `a` 更值钱）
  return cur >= 'A' && cur <= 'Z' && !(prev >= 'A' && prev <= 'Z');
}

/**
 * 左到右贪心 + 右靠压缩（fzf 那一路的两步）。
 * 两侧都**必须已是小写形**：本函数一次都不做归一化（每击键对整张清单小写就是 PS-6 那笔账）。
 * 找不到子序列 → `null`。
 */
function matchPositions(lowerText: string, lowerTerm: string): number[] | null {
  const pos: number[] = [];
  let from = 0;
  for (let k = 0; k < lowerTerm.length; k++) {
    const at = lowerText.indexOf(lowerTerm.charAt(k), from);
    if (at < 0) return null;
    pos.push(at);
    from = at + 1;
  }
  // 右靠：在不撞上下一枚的前提下，把每一枚尽量往后挪 ⇒ 相邻字符并成连续段
  for (let k = pos.length - 2; k >= 0; k--) {
    const next = pos[k + 1] as number;
    let cur = pos[k] as number;
    while (cur < next - 1 && lowerText.charAt(cur + 1) === lowerTerm.charAt(k)) cur++;
    pos[k] = cur;
  }
  return pos;
}

/** 位置串 → 打分（越大越好）：连续与边界加分，跳格扣分，长名轻微扣分 */
function scorePositions(text: string, pos: readonly number[]): number {
  let score = 0;
  let prev = -2;
  for (const at of pos) {
    score += at === prev + 1 ? 12 : -Math.min(20, at - prev - 1);
    if (isWordBoundary(text, at)) score += 18;
    prev = at;
  }
  if (pos.length > 0 && pos[0] === 0) score += 24;
  return score - Math.round(text.length / 40);
}

/** 已小写两侧的分数（排序趟用它：不新建任何字符串） */
function fuzzyScoreOf(lowerText: string, lowerTerm: string): number | null {
  if (lowerTerm === '' || lowerText === '') return null;
  const pos = matchPositions(lowerText, lowerTerm);
  return pos === null ? null : scorePositions(lowerText, pos);
}

/**
 * 面向**显示串**的模糊匹配：返回分数 + 命中区间（高亮用）。
 *
 * 区间下标是相对原样文本的，所以这里必须自己归一化（不能拿小写缓存的下标去切原串——
 * 少数字符 `toLowerCase()` 会改长度，如 `İ`）。只对该屏看得见的行调用。
 */
export function fuzzyMatch(text: string, term: string): { score: number; ranges: HitRanges } | null {
  const q = term.trim();
  if (q === '' || text === '') return null;
  const pos = matchPositions(text.toLowerCase(), q.toLowerCase());
  if (pos === null) return null;
  return { score: scorePositions(text, pos), ranges: rangesOf(pos) };
}

function rangesOf(pos: readonly number[]): HitRanges {
  const out: [number, number][] = [];
  if (pos.length === 0) return out;
  let start = pos[0] as number;
  let last = start;
  for (let k = 1; k < pos.length; k++) {
    const at = pos[k] as number;
    if (at === last + 1) {
      last = at;
      continue;
    }
    out.push([start, last + 1]);
    start = at;
    last = at;
  }
  out.push([start, last + 1]);
  return out;
}

/* ------------------------------ 文件候选排序 ------------------------------ */

interface NormalizedFile {
  readonly path: string;
  readonly base: string;
  readonly dir: string;
  readonly lowerBase: string;
  readonly lowerPath: string;
}

/** 归一化清单钉在 **files 数组的身份**上（与 `commands.ts` 的 `filterFileCandidates` 同款纪律） */
const normalizedByList = new WeakMap<readonly string[], NormalizedFile[]>();

function normalizedFiles(paths: readonly string[]): NormalizedFile[] {
  const hit = normalizedByList.get(paths);
  if (hit) return hit;
  const built: NormalizedFile[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const lowerPath = p.toLowerCase();
    const { dir, base } = splitPath(p);
    built.push({ path: p, base, dir, lowerBase: base.toLowerCase(), lowerPath });
  }
  try {
    normalizedByList.set(paths, built);
  } catch {
    // 键不是对象 ⇒ 缓存跳过：判定结果一样，只是这一路不省
  }
  return built;
}

/** 一条文件候选（`tier` = 契约桶序，4 = 只有模糊补位命中；`score` 只在同桶内比） */
export interface FileHit {
  readonly path: string;
  readonly base: string;
  readonly dir: string;
  readonly tier: number;
  readonly score: number;
  /** 由「最近打开」置顶带入（只作分组标签，不参与任何判定） */
  readonly recent: boolean;
}

export interface RankFileOptions {
  /** 最近打开（倒序）：空查询时置顶成一节；不在当前候选清单里的条目直接跳过 */
  readonly recent?: readonly string[];
  readonly cap?: number;
}

/**
 * 文件候选排序 + 截断（纯函数）。
 *
 * - 空查询：`recent` 里那些（仍在清单内的）先出场，其余按清单原序补上，一起受预算约束；
 * - 有查询：契约桶序在前，模糊补位在后（见文件头「一条尺子，两趟收集」）；
 * - 同桶内**保持入参顺序**（`i` 兜底），两次点出同一个查询必给同一个序。
 */
export function rankFiles(
  paths: readonly string[],
  term: string,
  opts: RankFileOptions = {},
): FileHit[] {
  if (!Array.isArray(paths)) return [];
  const budget = candidateBudget('quickOpen', opts.cap ?? CANDIDATE_BUDGETS.quickOpen);
  const files = normalizedFiles(paths);
  const q = term.trim();
  if (q === '') {
    const recentOf = opts.recent ?? [];
    const byPath = new Map<string, NormalizedFile>();
    for (const f of files) if (!byPath.has(f.path)) byPath.set(f.path, f);
    const out: FileHit[] = [];
    const taken = new Set<string>();
    for (const p of recentOf) {
      const f = byPath.get(p);
      if (!f || taken.has(f.path)) continue;
      taken.add(f.path);
      out.push({ path: f.path, base: f.base, dir: f.dir, tier: 0, score: 0, recent: true });
      if (out.length >= budget) return out;
    }
    for (const f of files) {
      if (taken.has(f.path)) continue;
      out.push({ path: f.path, base: f.base, dir: f.dir, tier: 1, score: 0, recent: false });
      if (out.length >= budget) return out;
    }
    return out;
  }
  const lq = q.toLowerCase();
  type Row = { readonly hit: FileHit; readonly i: number };
  const rows: Row[] = [];
  const fuzzy: Row[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as NormalizedFile;
    // 契约的两位都喂**已经小写过的**形态：它内部还要各自 toLowerCase() 一次，
    // 对已小写的串那是同引用返回，不再新建字符串（判定逐字等价，省的是整表重造）。
    const tier = candidateRank(f.lowerBase, f.lowerPath, lq);
    const hit: FileHit = { path: f.path, base: f.base, dir: f.dir, tier, score: 0, recent: false };
    if (tier < 4) {
      rows.push({ hit, i });
      continue;
    }
    const score = fuzzyScoreOf(f.lowerBase, lq) ?? fuzzyScoreOf(f.lowerPath, lq);
    if (score !== null) fuzzy.push({ hit: { ...hit, tier: 4, score }, i });
  }
  // 补位趟只在子串命中不够一屏时才扫过（见文件头「一条尺子，两趟收集」）
  if (fuzzy.length > 0 && rows.length < budget) {
    fuzzy.sort((a, b) => (b.hit.score !== a.hit.score ? b.hit.score - a.hit.score : a.i - b.i));
    rows.push(...fuzzy.slice(0, budget - rows.length));
  }
  // 先按桶、再按入参序（`Array#sort` 在现代引擎稳定，但这里不依赖实现：显式比 `i`）
  rows.sort((a, b) => (a.hit.tier !== b.hit.tier ? a.hit.tier - b.hit.tier : a.i - b.i));
  return rows.slice(0, budget).map((r) => r.hit);
}

/**
 * 符号项的身份（面板回传时按它找回那一枚）。与 `workspace-symbols.symbolPickerKey`
 * 同款结构，但不带路径 —— `@` 找的是**当前文件**里的程序，落点文件另由来源给。
 */
export function activeSymbolKey(symbol: EditorDocumentSymbol): string {
  return `${symbol.startLine}\u0000${symbol.name}`;
}

/**
 * `@` 模式的符号来源（编辑器现况，按下前缀才取）：
 * `path` = 光标真正所在的那份文件（`@` 的落点必须用它，不能拿壳层记的"活动标签"猜——
 * 分屏时两者可以不是同一份），`symbols` = `null` 表示给不出（编辑器没挂载 /
 * 屏幕上的是转出来的写法视图，那份行号不属于这份文件）。
 */
export interface ActiveFileSymbolSource {
  readonly path: string;
  readonly symbols: readonly EditorDocumentSymbol[] | null;
}

/** 落点归属：探针在场用探针那份文件，不在场才回落到壳层记的活动标签 */
export function revealHome(source: ActiveFileSymbolSource | null, activeFile: string | null): string {
  return source !== null && source.path !== '' ? source.path : activeFile ?? '';
}

/* ------------------------------ 面板条目（命令 / 文件 / 符号 / 行号） ------------------------------ */

/** 一行候选的呈现形状（就是 `Picker` 的条目；判据在这里，渲染层只照单画） */
export interface QuickOpenItem {
  readonly key: string;
  readonly primary: string;
  readonly secondaryDir?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  /** 主行上的命中区间（高亮）；下标相对 `primary` 的原样文本 */
  readonly ranges?: HitRanges;
  /** 副行上的命中区间；下标相对**最深一层目录**（`dirLabelParts(dir).tail`，head 会被中段省略改写） */
  readonly secondaryRanges?: HitRanges;
  /** 小节标题（与上一行不同时，在这一行上方插一条分组标签） */
  readonly group?: string;
}

/** 四种模式的文案（一处措辞表：占位符与"为什么没有结果"必须同词同形） */
export const MODE_TEXT: Record<PaletteModeKind, { placeholder: string; empty: string }> = {
  files: { placeholder: '按名称或路径快速打开文件…', empty: '无匹配文件' },
  commands: { placeholder: '> 输入命令名称…', empty: '无匹配命令' },
  symbols: { placeholder: '@ 在当前文件里按名字找一段程序…', empty: '当前文件里没有匹配的程序' },
  line: { placeholder: ': 输入行号，跳到当前文件的某一行…', empty: '行号得是 1 以上的整数' },
};

/** 文件模式下那一屏的高亮下标最多花多少行：预算就是 quickOpen 档 */
const FILE_HIT_LIMIT = CANDIDATE_BUDGETS.quickOpen;

/**
 * 命令面板里「最近使用」那节的分组标签（WS-16）。
 * 一处措辞两面共用（F1 与 `Ctrl+P` 的 `>`），也与文件模式的「最近打开」同句式；
 * `Palette.commandRows` 认这个常量决定"要不要把分类名盖回分组"。
 */
export const COMMAND_MRU_GROUP = '最近使用';

/**
 * 命令 → 置顶序（**纯函数**，稳定排序）。
 *
 * 规则只有一条：`recent`（队首最新）里出现的命令按那份顺序提到最前，**其余保持
 * `filterCommands` 给的码点序**（分类 + 标题）。不打分、不按使用次数排——
 * 清单本身只有序没有数，硬编一个"用得越多越靠前"的分数就是假读数。
 *
 * `recent` 里在场命令没有的 id（插件卸载后留下的旧条目）自然被忽略：这里按
 * **在场命令求交**，不反过来按清单生成行（否则会造出点不动的幽灵行）。
 */
export function orderCommandsByMru(
  commands: readonly CommandEntry[],
  recent: readonly string[] | undefined,
): CommandEntry[] {
  if (recent === undefined || recent.length === 0) return [...commands];
  const rank = new Map<string, number>();
  recent.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  // Array.prototype.sort 稳定 ⇒ 同档（都不在清单里）的相对序就是传进来的码点序
  return [...commands].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return ra === rb ? 0 : ra < rb ? -1 : 1;
  });
}

/**
 * 命令条目的**显示层整形**：把 `commandItems` 拼在主行里的分类名挪到分组标签上
 * （`工作台: 全部保存` → 分组「工作台」+ 主行「全部保存」）。
 *
 * **只动形状、不动判定**：过滤与排序仍是 `commands.filterCommands` 那一条尺子（按
 * category + title 稳定排序 ⇒ 同类的条目必然相邻，分组标签只需在换组那一行插一条）。
 * 分类真源取命令注册表的 `category` 字段，不去拆主行文本反推；主行去掉前缀后命中原点
 * 左移，故命中区间跟着平移（查询只命中分类名时整行不再高亮——分组标题本身就是答案）。
 *
 * （2026-10-28 全局搜索批：本函数从 `Palette.tsx` 搬进来并原样再导出——综合档的纯视图
 * `search-everywhere.ts` 也要用它做显示层整形，而它不许反向 import 渲染层；
 * 判据逐字未动，`palette-groups.test.ts` 仍从 `Palette` 一侧钉住行为。）
 */
export function commandRows(items: readonly QuickOpenItem[], commands: readonly CommandEntry[]): QuickOpenItem[] {
  const categoryById = new Map<string, string>();
  for (const c of commands) if (c.category !== undefined) categoryById.set(c.id, c.category);
  return items.map((it) => {
    const cat = categoryById.get(it.key);
    if (cat === undefined) return it;
    const prefix = `${cat}: `;
    // 分组标签：MRU 置顶那几条已由 `commandItems` 打上「最近使用」（WS-16），
    // 这里只给**没标过**的行补分类名。反过来把「最近使用」盖掉，置顶就只剩顺序、
    // 作者看不出这一节为什么在顶上（而分类名仍在主行前缀里被剥掉，两头都没了）。
    // `QuickOpenItem` 各字段是 readonly ⇒ 整行一次构造出来，不再逐字段改写（搬家的唯一机械改动）。
    if (!it.primary.startsWith(prefix)) return { ...it, group: it.group ?? cat };
    const shifted = shiftRanges(it.ranges, prefix.length);
    // 剥前缀后必须**丢掉旧 ranges**（整段落进分类名 ⇒ 这行不再高亮，而不是拿原下标画错位置）
    const { ranges: _dropped, ...rest } = it;
    return {
      ...rest,
      group: it.group ?? cat,
      primary: it.primary.slice(prefix.length),
      ...(shifted !== undefined ? { ranges: shifted } : {}),
    };
  });
}

/**
 * 去掉前缀后平移命中区间，并裁掉落在被切掉那截里的高亮。
 * 整段都被裁光 ⇒ `undefined`（这行不再高亮，而不是画半枚 `<mark>`）。
 */
function shiftRanges(ranges: HitRanges | undefined, cut: number): HitRanges | undefined {
  if (ranges === undefined) return undefined;
  const out: [number, number][] = [];
  for (const [start, end] of ranges) {
    const s = Math.max(start, cut) - cut;
    const e = end - cut;
    if (e > s) out.push([s, e]);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 命令 → 面板条目（**F1 命令面板与 Ctrl+P 的 `>` 共用这一份**）：
 * 过滤判据是 `filterCommands` 一条（分类名也参与匹配，作者记得的是"工作台"而不是 id），
 * 高亮只在标题真含/含子序列时画——只在 id 里命中就不画，不做假高亮。
 *
 * `opts.recent`（WS-16）：最近使用的命令置顶，并打上「最近使用」分组标签——
 * 与文件模式那节「最近打开」同一形态（同一种"我刚刚用过"的语言，两个面不该两套画法）。
 * 置顶**只改顺序不改判据**：禁态（`when` 求值为假）照旧灰着，匹配/高亮照旧按同一条尺子。
 */
export function commandItems(
  commands: readonly CommandEntry[],
  term: string,
  commandCtx: EditorCommandContext,
  opts: { recent?: readonly string[] } = {},
): QuickOpenItem[] {
  const trimmed = term.trim();
  const ranked = orderCommandsByMru(filterCommands(commands, term), opts.recent);
  const top = new Set(opts.recent ?? []);
  return ranked.map((c) => {
    const primary = c.category ? `${c.category}: ${c.title}` : c.title;
    const hit = trimmed === '' ? null : fuzzyMatch(primary, trimmed);
    return {
      key: c.id,
      primary,
      ...(hit !== null ? { ranges: hit.ranges } : {}),
      ...(c.keybinding !== undefined ? { hint: formatKeybinding(c.keybinding) } : {}),
      ...(top.has(c.id) ? { group: COMMAND_MRU_GROUP } : {}),
      disabled: !commandEnabled(c, commandCtx),
    };
  });
}

export interface QuickOpenViewInput {
  readonly mode: PaletteMode;
  readonly files: readonly string[];
  readonly recent?: readonly string[];
  /** `>` 模式：与 F1 命令面板同一张注册表、同一条过滤判据（`filterCommands`） */
  readonly commands: readonly CommandEntry[];
  /**
   * `>` 模式的最近使用清单（WS-16 · 队首最新）：置顶那几枚并打「最近使用」分组。
   * 缺省 / 空 ⇒ 与改动前逐字一致（纯码点序）。
   */
  readonly commandRecent?: readonly string[];
  readonly commandCtx: EditorCommandContext;
  /** `@` 模式的符号来源（编辑器位点探针；组件侧按下前缀才取） */
  readonly symbolSource: ActiveFileSymbolSource | null;
  /** 探针不在场时的回落落点（`:` 用） */
  readonly activeFile: string | null;
}

export interface QuickOpenView {
  readonly items: readonly QuickOpenItem[];
  readonly emptyText: string;
  readonly footnote: string | null;
}

/**
 * 一栏四用的列表内容（纯函数 ⇒ 四种模式、空态文案、高亮区间都脱离 React 钉得住）。
 *
 * 高亮只算**这一屏看得见的行**（≤ 预算），整张清单只付桶序的钱——这是 PS-6 那笔账
 * 在新模式下的同款纪律：一次 Ctrl+P 铺满预算时，不许给两千多条路径各造一遍中间字符串。
 */
export function quickOpenView(input: QuickOpenViewInput): QuickOpenView {
  const { mode, symbolSource, activeFile } = input;
  const trimmed = mode.term.trim();

  if (mode.kind === 'files') {
    const ranked = rankFiles(input.files, trimmed, input.recent === undefined ? {} : { recent: input.recent });
    const items: QuickOpenItem[] = ranked.slice(0, FILE_HIT_LIMIT).map((h) => {
      const baseHit = trimmed === '' ? null : fuzzyMatch(h.base, trimmed);
      const tailHit =
        baseHit === null && trimmed !== '' && h.dir !== '' ? fuzzyMatch(dirLabelParts(h.dir).tail, trimmed) : null;
      return {
        key: h.path,
        primary: h.base,
        ...(h.dir !== '' ? { secondaryDir: h.dir } : {}),
        ...(baseHit !== null ? { ranges: baseHit.ranges } : {}),
        ...(tailHit !== null ? { secondaryRanges: tailHit.ranges } : {}),
        ...(h.recent ? { group: '最近打开' } : {}),
      };
    });
    return {
      items,
      emptyText: MODE_TEXT.files.empty,
      // 一栏四用不写在 placeholder 里（打字时才看得见），初始态给一条用法提示
      footnote: trimmed === '' && items.length > 0 ? '输入 > 找命令 · @ 找当前文件里的程序 · : 跳行号' : null,
    };
  }

  if (mode.kind === 'commands') {
    return { items: commandItems(input.commands, mode.term, input.commandCtx, { recent: input.commandRecent }), emptyText: MODE_TEXT.commands.empty, footnote: null };
  }

  if (mode.kind === 'symbols') {
    if (symbolSource === null || symbolSource.path === '') {
      return { items: [], emptyText: '还没有打开文件（先在编辑器里按 Ctrl+P 再打 @）', footnote: null };
    }
    if (symbolSource.symbols === null) {
      // 派生视图（`.kojo` 写法视图）的行号不属于这份文件本体 —— 照实说，不给假列表
      return {
        items: [],
        emptyText: '当前屏幕上的是转出来的写法视图，它的行号对不上这份文件——按 Ctrl+Alt+T 切回原代码再找',
        footnote: null,
      };
    }
    const named = symbolSource.symbols.filter((s) => s.name.trim() !== '');
    const budget = CANDIDATE_BUDGETS.render;
    const ranked = rankKeyed(
      named.map((s) => ({ item: s, name: s.name, path: symbolSource.path })),
      mode.term,
      { cap: budget, tier: 'render' },
    );
    const items: QuickOpenItem[] = ranked.map((h) => {
      const hit = trimmed === '' ? null : fuzzyMatch(h.item.name, trimmed);
      return {
        key: activeSymbolKey(h.item),
        primary: h.item.name,
        hint: `:${h.item.startLine}`,
        title: `${symbolSource.path}:${h.item.startLine}`,
        ...(hit !== null ? { ranges: hit.ranges } : {}),
      };
    });
    return {
      items,
      emptyText: trimmed === '' ? '这份文件里没有可列出的程序段' : MODE_TEXT.symbols.empty,
      // 只有"预算真的挡掉了东西"才报数：带着查询时列得少是**没匹配上**，不是被截断，
      // 把前者说成"这里列了前 N 段"就是假读数（铁律 4 的反面）。
      footnote:
        ranked.length >= budget && named.length > budget
          ? `本文件共 ${named.length} 段，这一屏列了 ${items.length} 段——继续输入可缩小范围`
          : null,
    };
  }

  const line = lineNumberOf(mode.term);
  const home = revealHome(symbolSource, activeFile);
  if (line === null || home === '') {
    return {
      items: [],
      emptyText: home === '' ? '还没有打开文件（先在编辑器里按 Ctrl+P 再打 :）' : MODE_TEXT.line.empty,
      footnote: null,
    };
  }
  return {
    items: [{ key: lineKeyOf(line), primary: `跳到第 ${line} 行`, hint: splitPath(home).base }],
    emptyText: MODE_TEXT.line.empty,
    footnote: null,
  };
}

/* ------------------------------ 通用桶序 + 模糊补位（命令 / 符号） ------------------------------ */

/** 一份带来源标识的候选（命令、符号都用这一形状；`name` 主行、`path` 只是第二坐标） */
export interface KeyedItem<T> {
  readonly item: T;
  /** 主行文本（文件名 / 命令标题 / 符号名） */
  readonly name: string;
  /** 次坐标（id / 文件路径）：与契约桶序的 `filePath` 一位对齐 */
  readonly path: string;
}

export interface KeyedHit<T> {
  readonly item: T;
  readonly name: string;
  readonly path: string;
  readonly tier: number;
  readonly score: number;
}

export interface RankKeyedOptions {
  readonly cap: number;
  /**
   * 借哪一档预算（契约的档位表按**层**取值，不许跨层借用数字）：
   * 命令与符号都是"面板一屏灌不下"那一层 ⇒ `render`；文件候选才走 `quickOpen`。
   */
  readonly tier?: 'render' | 'quickOpen';
}

/**
 * 命令 / 符号这类**有界清单**的排序（与 `rankFiles` 同一条尺子，只是没有归一化缓存）：
 * 候选数天然被提供方预算压住（最多几百到一千），逐条小写一次换掉一整层缓存的复杂度不划算。
 * 清单若真变大，接的应该是 `rankFiles` 那套 WeakMap 身份缓存，不是第二把尺子。
 */
export function rankKeyed<T>(
  items: readonly KeyedItem<T>[],
  term: string,
  opts: RankKeyedOptions,
): KeyedHit<T>[] {
  if (!Array.isArray(items)) return [];
  const budget = candidateBudget(opts.tier ?? 'render', opts.cap);
  const q = term.trim();
  if (q === '') {
    return items.slice(0, budget).map((k) => ({ item: k.item, name: k.name, path: k.path, tier: 0, score: 0 }));
  }
  const lq = q.toLowerCase();
  const out: Array<KeyedHit<T> & { i: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const k = items[i] as KeyedItem<T>;
    const tier = candidateRank(k.name, k.path, lq);
    if (tier < 4) {
      out.push({ item: k.item, name: k.name, path: k.path, tier, score: 0, i });
      continue;
    }
    const score = fuzzyScoreOf(k.name.toLowerCase(), lq) ?? fuzzyScoreOf(k.path.toLowerCase(), lq);
    if (score !== null) out.push({ item: k.item, name: k.name, path: k.path, tier: 4, score, i });
  }
  out.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : b.score !== a.score ? b.score - a.score : a.i - b.i));
  return out.slice(0, budget);
}
