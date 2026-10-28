/**
 * 全局搜索（Search Everywhere，对标 IDEA 双击 Shift）的**纯逻辑**（体验对等批）。
 *
 * 与 `palette-search.ts` 同一拆法：查询、分组、跨类排序、档位切换判据都是**数据判据**，
 * 脱离 React 才钉得住；渲染层（`Palette.tsx` 的 `SearchEverywhere`）只照单画。
 *
 * ## 三条口径
 *
 * 1. **一屏三类的综合档**：命令 / 文件 / 符号三类候选都吃现成的**同步**数据源
 *    （注册表、快速打开候选、`ui.editor.languageService` 的 `workspaceSymbol` 应答——
 *    宿主不自拼词表，符号候选只许从槽来，与 `search-scope.ts` / `workspace-symbols.ts` 同纪律）。
 *    全文检索那条**流式链不合并进来**：综合档底部只固定一条「在项目内全文搜索…」动作行，
 *    Enter 把词递给既有 `SearchPanel` 通道。
 * 2. **跨类统一排序用 `fuzzyMatch` 的分数**（面板现有那把尺子，不新造第四把）：
 *    同类内按分数降序、同分保持来源序（稳定）；组间按各类最高分排（空查询回固定序
 *    命令→文件→符号），每组挂分组标题。动作行**恒在最后一组**，不参与打分。
 * 3. **前缀兼容零改动**：`parsePaletteMode` 与现有四模式一行未动——综合档是新面板的新档位，
 *    靠 Alt+1..4 / Ctrl+Tab 族切换，输入框里没有"首字符开关"（前缀在这里就是普通字符）。
 *
 * 预算纪律沿用契约层：每类一屏量（`SE_ALL_CATEGORY_CAP`，走 `candidateBudget` 收口），
 * 被截掉的条数如实进 footnote（"预算 ≠ 丢弃"，铁律 4）。
 */
import { candidateBudget } from '@kojo/plugin-api';
import type { EditorCommandContext, EditorWorkspaceSymbol } from '@kojo/plugin-api';
import type { CommandEntry } from './commands';
import { dirLabelParts } from './path-label';
import {
  commandRows,
  fuzzyMatch,
  quickOpenView,
  type ActiveFileSymbolSource,
  type QuickOpenViewInput,
  type QuickOpenItem,
} from './palette-search';
import { symbolPickerItems, type WorkspaceSymbolCollection } from './workspace-symbols';

/* ------------------------------ 档位（tab） ------------------------------ */

export type SearchEverywhereTab = 'all' | 'commands' | 'files' | 'symbols';

/** 档位序（Alt+1..4 的映射与 Ctrl+Tab 环向共用这一张表，两处两套序迟早分叉） */
export const SEARCH_EVERYWHERE_TABS: readonly SearchEverywhereTab[] = ['all', 'commands', 'files', 'symbols'];

/** 一次档位键的现场读数（与 DOM KeyboardEvent 同名同形的结构子集；测试手搓替身） */
export interface SearchEverywhereKeyEvidence {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/**
 * 面板内的范围切换键（裁决口径：Alt+1..4 直选 + Ctrl+Tab / Ctrl+Shift+Tab 环向）。
 * 命中 ⇒ 返回目标档位；不命中 ⇒ `null`（其余键原样交回面板的列表导航）。
 * Alt+数字族宿主键位表里全空（书签用的是 Alt+F2/F3 族），不会与全局命令抢键。
 */
export function planSearchEverywhereKey(
  e: SearchEverywhereKeyEvidence,
  current: SearchEverywhereTab,
): SearchEverywhereTab | null {
  if (e.metaKey) return null;
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= SEARCH_EVERYWHERE_TABS.length) {
      return SEARCH_EVERYWHERE_TABS[digit - 1] as SearchEverywhereTab;
    }
    return null;
  }
  if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
    const at = SEARCH_EVERYWHERE_TABS.indexOf(current);
    const step = e.shiftKey ? -1 : 1;
    // 环向：最后一档再往前回到第一档（与 roving tabindex 的"一圈"同手感）
    return SEARCH_EVERYWHERE_TABS[
      (at + step + SEARCH_EVERYWHERE_TABS.length) % SEARCH_EVERYWHERE_TABS.length
    ] as SearchEverywhereTab;
  }
  return null;
}

/* ------------------------------ 分组与动作行 ------------------------------ */

/** 综合档三类的分组标题（一处措辞表；渲染层不许再抄一遍） */
export const SE_GROUP_LABELS: Record<'commands' | 'files' | 'symbols', string> = {
  commands: '命令',
  files: '文件',
  symbols: '符号',
};

/** 底部动作行的分组标题 */
export const SE_ACTION_GROUP = '全文搜索';

/**
 * 底部动作行的键（`\u0000` 前缀保证不与命令 id / 路径 / 符号键相撞——
 * 与 `palette-search` 的 `line:` 前缀同一手法：造与拆都在这一处）。
 */
const TEXT_ACTION_KEY_PREFIX = '\u0000se-text:';
export const TEXT_SEARCH_ACTION_KEY = `${TEXT_ACTION_KEY_PREFIX}search`;

/** 动作行文案（空词也有话可说：那一发是"打开搜索面板并聚焦"，同样不骗人） */
export function textSearchActionLabel(term: string): string {
  const q = term.trim();
  return q === '' ? '在项目内全文搜索…' : `在项目内全文搜索「${q}」`;
}

/** 一屏综合档里每类的行数上限（三类并排，取 quickOpen 档再收一半；走 candidateBudget 收口） */
export const SE_ALL_CATEGORY_CAP = candidateBudget('quickOpen', 20);

/* ------------------------------ 视图 ------------------------------ */

export interface SearchEverywhereViewInput {
  readonly tab: SearchEverywhereTab;
  /** 查询原样（综合档不吃前缀；trim 由打分侧自己做） */
  readonly term: string;
  readonly commands: readonly CommandEntry[];
  readonly commandCtx: EditorCommandContext;
  /** 命令最近使用（只服务命令类——MRU 语义不扩到档位，与 `>` 模式同口径） */
  readonly commandRecent?: readonly string[];
  readonly files: readonly string[];
  readonly filesRecent?: readonly string[];
  /** 工作区符号应答（宿主经 `ui.editor.languageService` 槽问过一次的合并结果） */
  readonly symbols: WorkspaceSymbolCollection;
  /** `:` 与符号落点兜底需要（`quickOpenView` 复用时的入参形状） */
  readonly symbolSource: ActiveFileSymbolSource | null;
  readonly activeFile: string | null;
}

export interface SearchEverywhereView {
  readonly items: readonly QuickOpenItem[];
  readonly emptyText: string;
  readonly footnote: string | null;
}

/** 一条候选的分数（null = 与查询不相干，综合档里不进列表） */
function rowScore(item: QuickOpenItem, term: string): number | null {
  if (term === '') return 0;
  const direct = fuzzyMatch(item.primary, term);
  if (direct !== null) return direct.score;
  // 主行不中再看副行坐标（文件的目录段 / 符号的 title `文件:行`）——与单档模式同一条补位思路
  if (item.secondaryDir !== undefined) {
    const tail = fuzzyMatch(dirLabelParts(item.secondaryDir).tail, term);
    if (tail !== null) return tail.score;
  }
  if (item.title !== undefined) {
    const viaTitle = fuzzyMatch(item.title, term);
    if (viaTitle !== null) return viaTitle.score;
  }
  return null;
}

/** 分数序（降序）+ 同分保来源序（显式比下标，不依赖引擎排序稳定性——同 `rankFiles` 纪律） */
function byScoreDesc<T>(rows: readonly { readonly item: T; readonly score: number; readonly i: number }[]): T[] {
  return [...rows]
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i))
    .map((r) => r.item);
}

/** 档位占位与空态文案（与 `MODE_TEXT` 同句式，一处措辞表） */
export const SE_TAB_TEXT: Record<SearchEverywhereTab, { placeholder: string; empty: string }> = {
  all: { placeholder: '搜命令、文件、符号（Alt+1..4 切范围）…', empty: '没有匹配项——底部一行可直接全文搜索' },
  commands: { placeholder: '搜命令…', empty: '无匹配命令' },
  files: { placeholder: '按名称或路径搜文件…', empty: '无匹配文件' },
  symbols: { placeholder: '按名字搜工作区符号…', empty: '无匹配符号' },
};

/** 复用 `quickOpenView` 的单档判据（文件 / 命令两档一行不抄——同一把尺子量两处） */
function viewInputFor(base: SearchEverywhereViewInput, kind: 'files' | 'commands'): QuickOpenViewInput {
  return {
    mode: { kind, term: base.term },
    files: base.files,
    ...(base.filesRecent === undefined ? {} : { recent: base.filesRecent }),
    commands: base.commands,
    ...(base.commandRecent === undefined ? {} : { commandRecent: base.commandRecent }),
    commandCtx: base.commandCtx,
    symbolSource: base.symbolSource,
    activeFile: base.activeFile,
  };
}

/** 单档视图里取一类（files 走 quickOpenView；commands 走 quickOpenView + `commandRows` 整形；symbols 走 symbolPickerItems） */
function categoryRows(
  base: SearchEverywhereViewInput,
  kind: 'commands' | 'files' | 'symbols',
): QuickOpenItem[] {
  if (kind === 'symbols') {
    return symbolRowsOf(base.symbols.symbols, base.term);
  }
  const raw = [...quickOpenView(viewInputFor(base, kind)).items];
  // 命令档与 F1 同一份显示层整形（分类名搬分组标签）；综合档的分组标题稍后被统一盖成「命令」，
  // **打分仍用整形前的主行**（`分类: 标题` 整串），只命中分类名的行不会因为整形而消失
  return kind === 'commands' ? commandRows(raw, base.commands) : raw;
}

/** 符号 → 面板条目 + 按查询过滤（提供方口径不动：候选集合是槽给的，这里只排不造） */
function symbolRowsOf(symbols: readonly EditorWorkspaceSymbol[], term: string): QuickOpenItem[] {
  const scored = symbols
    .map((s, i) => ({
      s,
      i,
      score:
        term === ''
          ? 0
          : (fuzzyMatch(s.name, term)?.score ?? fuzzyMatch(s.filePath, term)?.score ?? null),
    }))
    .filter((r): r is { s: EditorWorkspaceSymbol; i: number; score: number } => r.score !== null);
  const kept = scored
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i))
    .slice(0, candidateBudget('render', SE_ALL_CATEGORY_CAP));
  return symbolPickerItems(kept.map((r) => r.s));
}

/**
 * 综合档一屏（tab='all'）：三类各按分数排、组间按最高分排、每组截到上限，
 * 底部恒挂动作行。单档（commands/files/symbols）：只给那一类，同样带动作行。
 */
export function searchEverywhereView(input: SearchEverywhereViewInput): SearchEverywhereView {
  const term = input.term.trim();
  const action: QuickOpenItem = {
    key: TEXT_SEARCH_ACTION_KEY,
    primary: textSearchActionLabel(term),
    group: SE_ACTION_GROUP,
  };

  if (input.tab !== 'all') {
    const kind = input.tab;
    const rows = categoryRows(input, kind).slice(0, candidateBudget('render', SE_ALL_CATEGORY_CAP));
    return {
      items: [...rows, action],
      emptyText: SE_TAB_TEXT[kind].empty,
      footnote: `Alt+1..4 / Ctrl+Tab 切范围 · Enter 选中，末行是${SE_ACTION_GROUP}`,
    };
  }

  type Group = { readonly kind: 'commands' | 'files' | 'symbols'; readonly rows: QuickOpenItem[]; readonly top: number };
  const groups: Group[] = [];
  let hiddenTotal = 0;
  for (const kind of ['commands', 'files', 'symbols'] as const) {
    // 综合档**打分用整形前的主行**（命令是 `分类: 标题` 整串）——只命中分类名的行不该被跨类尺子裁掉；
    // 出场前再做与 F1 同一份显示层整形（分类名搬分组标签，随后统一盖成「命令」）
    const all =
      kind === 'commands' ? [...quickOpenView(viewInputFor(input, 'commands')).items] : categoryRows(input, kind);
    const scored = all
      .map((item, i) => ({ item, i, score: rowScore(item, term) }))
      .filter((r): r is { item: QuickOpenItem; i: number; score: number } => r.score !== null);
    const ordered = byScoreDesc(scored);
    hiddenTotal += Math.max(0, ordered.length - SE_ALL_CATEGORY_CAP);
    const shownRaw = ordered.slice(0, SE_ALL_CATEGORY_CAP);
    const shown = (kind === 'commands' ? commandRows(shownRaw, input.commands) : shownRaw).map((item) => ({
      ...item,
      group: SE_GROUP_LABELS[kind],
    }));
    const top = scored.length === 0 ? -Infinity : Math.max(...scored.map((r) => r.score));
    groups.push({ kind, rows: shown, top });
  }
  // 组间序：有查询 ⇒ 各类最高分降序（同分回固定序）；空查询 ⇒ 固定序（命令→文件→符号）
  const fixedOrder = ['commands', 'files', 'symbols'] as const;
  groups.sort((a, b) =>
    term === ''
      ? fixedOrder.indexOf(a.kind) - fixedOrder.indexOf(b.kind)
      : b.top !== a.top
        ? b.top - a.top
        : fixedOrder.indexOf(a.kind) - fixedOrder.indexOf(b.kind),
  );

  const items = groups.flatMap((g) => g.rows);
  // 符号类被提供方预算挡掉的条数也如实入账（`hidden` 是槽侧合并时算好的，这里只转述）
  const symbolHidden = input.symbols.symbols.length > 0 ? Math.max(0, input.symbols.totalMatched - input.symbols.symbols.length) : 0;
  const truncated = hiddenTotal + symbolHidden;
  return {
    items: [...items, action],
    emptyText: SE_TAB_TEXT.all.empty,
    footnote:
      truncated > 0
        ? `各类已截到 ${SE_ALL_CATEGORY_CAP} 条（另有 ${truncated} 条未列出）——切单档或继续输入缩小范围`
        : 'Alt+1..4 / Ctrl+Tab 切范围 · Enter 选中，末行是全文搜索',
  };
}
