import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import type { SearchMatch, SearchProgress } from '../bridge/search';
import { errorText } from '@kojo/plugin-api';
import { isTauri } from '../bridge/invoke';
import { revealSpanOf, type RevealSpan } from '../monaco/reveal-position';
import { Icon } from './icons';
import { revealFailureText, revealInExplorer } from './reveal-explorer';
import { setSearchMenuContext } from './search-menu';
import { KitCount, KitKbd } from '../ui-kit';
import {
  clearSearchResult,
  runReplace,
  runSearch,
  selectSearchMatch,
  setExtensionText,
  setQuery,
  setReplaceText,
  setSearchScope,
  setSearchSortMode,
  snapshot,
  stepSearchHistory,
  stepSearchMatch,
  stopSearch,
  subscribe,
  toggleOption,
  type SearchOptionsState,
  type SearchState,
} from './search-store';
import {
  DEFAULT_SEARCH_EXTENSIONS,
  isValidSearchQuery,
  matchLocationLabel,
  parseExtensions,
  previewParts,
  searchMatchCounterText,
  searchNoticeText,
  searchProgressText,
  searchSummaryDetail,
  searchSummaryText,
  shortSearchPath,
} from './search-query';
import {
  sameRowWindow,
  SEARCH_ROW_HEIGHTS_FALLBACK,
  searchRowOffsets,
  searchRowWindow,
  searchRowsOf,
  type SearchRow,
  type SearchRowHeights,
  type SearchRowWindow,
} from './search-rows';
import { SEARCH_SORT_OPTIONS, sortSearchFiles, type SearchSortMode } from './search-stream';
import { rowNavDecision } from './panel-row-nav';
import {
  describeAppliedScope,
  findSearchScope,
  narrowRoots,
  scopeEmptyText,
  scopeRootsTitle,
  scopeStaleText,
  scopeStatusText,
  type SearchScopeItem,
} from './search-scope';
import { SearchFilterBar } from './SearchFilterBar';
import { KitPanelHeader } from '../ui-kit/kit-panel-header';
import { KitSearchField } from '../ui-kit/kit-search-field';
// 下拉井与勾选取自基座叶子（1026 C2-b / C2-a）：排序与范围两枚、"打字即搜"一颗。
// 键盘腿（Enter 即搜）挂在行本体上——keydown 会冒泡，件因此不必多开一个 onKeyDown 口子。
import { KitCheck } from '../ui-kit/kit-check';
import { KitSelect } from '../ui-kit/kit-select';
import '../search-panel.css';
import './context-menu-search.css';

/**
 * 侧栏「在文件中搜索」面板（2026-10-15 全文检索批；2026-10-17 用户反馈 5 重排）。
 *
 * 落点取舍 = **宿主内建视图**（与 `ProblemPanel` / `problem-store` 同族），不做成
 * `ui.panel` 插件：检索要调的是**宿主专属原生命令**（`search_text`，见 Rust 侧），
 * 而插件只许依赖 `@kojo/plugin-api`——为一个宿主能力去扩 `PlatformBridge` 契约，
 * 等于让四个桥实现（tauri / node / 两处测试桩）跟着改；且"搜整个项目"是工作台级
 * 能力（VSCode 里搜索也在 workbench，不在 extension host），与插件的领域贡献不同层。
 *
 * 结果行点击走既有 `editor.revealLocation`（与问题面板同一条通道，宿主 App.tsx 落地）。
 * 状态全在 `search-store`（模块级）：侧栏切走面板会卸载，结果必须活得比面板久。
 *
 * **排版基准 = VSCode 搜索面板同构**（本轮重做，行为与数据流一行未动）：
 *   ① 首行 = 替换展开 chevron + 检索井（框内右侧 Aa / 全词 / .*）+ 行尾动作；
 *   ② 替换行只在展开时出现（命令「在文件中替换」命中时自动展开并聚焦）；
 *   ③ 类型 / 只看范围收进可折叠「选项」区（CSS 折叠，控件仍在 DOM，展开即用）；
 *   ④ 状态区（检索中 / 错误 / 摘要 / 替换回执 / 范围 / 截断）在控制区下方整块可读；
 *   ⑤ 结果按文件分组、文件头可折叠（局部 state，key = path），行号左列 + 预览右列，
 *      单条替换钮 hover / focus 显形。
 * 样式住 `search-panel.css`（`ksp-` 前缀 + 根上 `.ksp` 提高特异性）：`styles.css`
 * 里的 `.search-*` 旧规则**一个字都没改**，本文件先于它注入也能压过它。
 */

/**
 * 结果区的渲染窗口（PERF 批：从"死顶 / 逐步加长"改成**真虚拟列表**）。
 *
 * 旧实现是 `flattenSearchResults(files, 120)` + 末尾一枚「继续显示」：DOM 行数封在
 * 120，但 120 行仍是**一次全建**——真语料一次全项目检索出 2,000 条命中（本项目
 * 2,325 文件）时，出结果那一帧实测 50–82ms（`bySource` 归 `(render)`），每按一次
 * 「继续显示」再付一遍。命中上万条时这个数会继续长。
 *
 * 现在与文件树过滤窗同一套思路的**升级版**：按视口算窗口，只挂载可见行 + 上下各
 * `SEARCH_VROW_OVERSCAN_PX` 的行，两侧用留白顶起滚动高度 ⇒
 *   ① DOM 行数不随命中数长（可见 ~25 行 + overscan ≤ 60 行，含文件头）；
 *   ② 全量可达不再是"按 N 次继续显示"，滚到哪画到哪（2,000 条与 20 万条同价）；
 *   ③ 窗口数学住 `search-rows` 的纯函数里（`searchRowOffsets` / `searchRowWindow`），
 *      不靠"行高相等"的假设——文件头与命中行是两档高度，会累积漂。
 *
 * 首次提交（含服务端渲染 / happy-dom 这类量不到布局的环境）还不知道视口多高：
 * 先画**前 40 行**（`SEARCH_VROWS_FALLBACK`），挂载后量到真视口再收口。
 */
export const SEARCH_VROWS_FALLBACK = 40;
/** 视口上下各多画多少像素（滚动时新行已在位，不闪白） */
const SEARCH_VROW_OVERSCAN_PX = 240;

/**
 * 打字即搜的防抖毫秒（P2-11）。
 *
 * 300ms 的理由：输入法组词 / 中英文切换的停顿间隙通常在 100–250ms，逐字打路径或
 * 变量名也难快到 100ms 以内；300ms 落在"一个词打完了"与"别每个字都全量重读"之间。
 * Rust 侧检索已多线程化，但语料 3.8k 文件的全量重读仍是秒级 IO——防抖与单飞
 * （见下方 `liveSearch` 注释）双管齐下，才扛得住"边打边看"。
 */
const SEARCH_DEBOUNCE_MS = 300;

/** 两个列表 props 的缺省值：模块级常量，默认参数每次渲染新建数组会丢掉引用稳定性 */
const EMPTY_SCOPES: readonly SearchScopeItem[] = [];
const EMPTY_NOTICES: readonly string[] = [];

/** 默认扩展名集合的指纹（排序后 join）：判断"类型过滤是否还是默认"只比这一串 */
const DEFAULT_EXTENSION_KEY = [...DEFAULT_SEARCH_EXTENSIONS].sort().join(',');

/**
 * 上一次**真正落地**的替换框聚焦请求（跨挂载保留）。
 *
 * 命令入口的顺序是「先自增 nonce、再激活侧栏视图」——面板可能晚于 nonce 变化才挂载，
 * 组件内的 ref 分不清"刚发生的请求"和"上一次挂载前的旧请求"（拿 ref 记当前值会把
 * 前者也吞掉：命令变成只打开视图、不聚焦）。模块级这一格把两者分开：
 *   旧请求（已服务过）⇒ 切走再切回来不抢焦点；
 *   新请求（晚于上次服务）⇒ 挂载时就展开替换行并聚焦。
 */
let servicedReplaceNonce = 0;

function useSearchState(): SearchState {
  const [s, setS] = useState<SearchState>(() => snapshot());
  useEffect(() => subscribe(() => setS(snapshot())), []);
  return s;
}

/**
 * 三个开关（VSCode 同序：Aa / 全词 / .*——顺序固定，不随状态漂）。
 * 视觉是框内紧凑 toggle，语义仍是 `aria-pressed` 按钮：切换不改已出结果，下次检索才生效。
 */
const TOGGLES: ReadonlyArray<{ key: keyof SearchOptionsState; label: string; title: string }> = [
  { key: 'caseSensitive', label: 'Aa', title: '区分大小写' },
  { key: 'wholeWord', label: '全词', title: '全词匹配' },
  { key: 'isRegex', label: '.*', title: '正则表达式' },
];

/** 命中行预览（命中段高亮）：切分口径在 `search-query.previewParts`（可单测） */
function MatchPreview({ match }: { match: SearchMatch }): ReactElement {
  const p = previewParts(match);
  return (
    <span className="search-preview">
      {p.head}
      <mark className="search-hit">{p.hit}</mark>
      {p.tail}
    </span>
  );
}

/* ============================ 纯逻辑（可单测，无 React） ============================ */

/** 文件头的两段展示：`shortSearchPath` 的最后一段 = 文件名，前一段 = 目录（dim） */
export interface SearchPathParts {
  readonly base: string;
  readonly dir: string;
}

/**
 * 路径 → 文件名 + 目录（均取 `shortSearchPath` 的末两段，与旧版展示同一口径）。
 * 目录只保留紧邻的一层：侧栏 260px 时多一层就是多一次省略，全路径在 `title` 里。
 * 末两段只含一段（相对文件名 / 无分隔符）⇒ 目录为空串，界面不画空段。
 */
export function splitSearchPath(path: string): SearchPathParts {
  const rel = shortSearchPath(path);
  const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
  if (cut < 0) return { base: rel, dir: '' };
  return { base: rel.slice(cut + 1), dir: rel.slice(0, cut) };
}

/** 一个文件块：文件头（命中总数）+ 该文件下（可能被渲染窗口截到一半的）命中行 */
export interface SearchFileGroup {
  readonly path: string;
  /** 后端给的文件级命中总数：截断只裁渲染行，不许把这个数裁小（否则读数撒谎） */
  readonly count: number;
  readonly matches: readonly SearchMatch[];
}

/**
 * 扁平行 → 文件分组（渲染层据此画"可折叠的文件块"；纯函数，可单测）。
 *
 * `flattenSearchResults` 的产物天然是"文件头 + 其下命中"的连续段，这里只做分段，
 * 不改顺序、不排序、不做跨段合并。两条防御（不丢行、不静默）：同路径连续出现
 * 两个文件头时计数相加；命中行前面缺文件头时自成一组（计数 1），照画不吞。
 */
export function groupSearchRows(rows: readonly SearchRow[]): SearchFileGroup[] {
  const groups: { path: string; count: number; matches: SearchMatch[] }[] = [];
  for (const row of rows) {
    const prev = groups[groups.length - 1];
    if (row.kind === 'file') {
      if (prev !== undefined && prev.path === row.path) prev.count += row.count;
      else groups.push({ path: row.path, count: row.count, matches: [] });
      continue;
    }
    if (prev !== undefined && prev.path === row.path) prev.matches.push(row.match);
    else groups.push({ path: row.path, count: 1, matches: [row.match] });
  }
  return groups;
}

/**
 * 左列「行:列」槽宽（ch）：按**本屏最长的一条读数**定，短结果列表不白占横向空间。
 * 下限 3（`9:9`）：数字突然从一位涨到两三位时，列宽只在跨档时变一次，不逐行抖。
 */
export function locationGutterCh(rows: readonly SearchRow[]): number {
  let longest = 0;
  for (const row of rows) {
    if (row.kind === 'match') longest = Math.max(longest, matchLocationLabel(row.match).length);
  }
  return Math.max(3, longest);
}

/**
 * 检索进度百分比；总量未知（原生侧还没枚举完）⇒ `null`——界面画不确定条，
 * 不假装 0%。越过 100 一律夹回（进度是显示量，不该让后端读数把条顶出轨道）。
 */
export function searchProgressPercent(p: SearchProgress | null): number | null {
  if (p === null || p.totalFiles <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.filesScanned / p.totalFiles) * 100)));
}

/**
 * 「选项」折叠时的一行摘要：类型过滤还是默认值 ⇒ `null`（不占位、不噪音）；
 * 改过 ⇒ 原文本上屏；清空 ⇒「不限」（这是个会影响结果的状态，不许藏）。
 */
export function extensionSummaryText(text: string): string | null {
  if (parseExtensions(text).join(',') === DEFAULT_EXTENSION_KEY) return null;
  const raw = text.trim();
  return raw === '' ? '类型：不限' : `类型：${raw}`;
}

/**
 * 一条命中 → 落点区间（纯函数，可单测）。
 *
 * `column` 是命中在**原行**里的 1 基起点，`start` / `end` 是命中在 `preview` 里的偏移
 * （预览以命中为中心开窗，命中本身整段在内 ⇒ `end - start` 就是它在原行里的宽度）。
 * 这里**只算宽度、不夹取**：越界怎么收（终点超过行长 / 起点超过终点）全归
 * `clampRevealPosition`，第二份夹取必然与编辑器那头漂。
 */
export function searchMatchSpan(match: SearchMatch): RevealSpan | undefined {
  const start = revealSpanOf({ column: match.column });
  if (!start) return undefined;
  const width = Math.max(0, Math.trunc(match.end) - Math.trunc(match.start));
  return { columnStart: start.columnStart, columnEnd: start.columnStart + width };
}

/**
 * 最近的**可滚动祖先**（虚拟列表的视口 = 它，而不是结果区自己）。
 *
 * 为什么不能只看结果区：侧栏是单列滚动容器（`.sidebar-views`，overflow auto），
 * 结果区的 `overflow-y:auto` 在高度不受限时**永远不会自己滚**——实测
 * `clientHeight === scrollHeight === 3130px`，真正滚的是祖先。硬编码那个类名
 * 等于把面板焊死在当前壳层布局上，所以这里按"能滚的那个祖先是哪个"现找。
 * 量不到（服务端渲染 / happy-dom）⇒ `null`，调用方回落到首屏 N 行。
 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  if (typeof getComputedStyle !== 'function') return null;
  let node = el.parentElement;
  while (node !== null && node !== document.body && node !== document.documentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/* ================================ 组件 ================================ */

export interface SearchPanelProps {
  /** 检索根（项目根 ∪ 作者工作区根；由宿主 ProjectView 提供） */
  roots: readonly string[];
  /**
   * 可选的检索范围候选（C3 领域限定检索批；由宿主经 `search.scope` 槽向提供方取）。
   * **空数组 ⇒ 整行不画**：没有提供方（没开项目 / 游戏无此概念）时面板与今天逐字一致。
   */
  scopes?: readonly SearchScopeItem[];
  /** 范围提供方侧的可见故障说明（提供方抛错 / 候选非法；空 = 不画） */
  scopeNotices?: readonly string[];
  /**
   * 跳源：路径 + 行 + **命中的列区间**（W9 落点 span 批）。
   * 第 3 位此前是裸 `column`——同一处位置，定义那条腿给的是区间、这条给的是一头，
   * 落点必然分叉；现在六条发起方统一交区间（缺区间才退化，退化判据在 `reveal-position`）。
   *
   * 第 4 位是**焦点选项**（W7-B，2026-10-20；additive）：`{ focus: false }` = 定位后
   * 不把焦点交给编辑器。键盘逐项跳（输入框回车 / Shift+回车）必须带它，否则第一跳
   * 就把焦点抢到编辑器、连续回车全部落空；鼠标点行不传（与旧行为一致，定位即聚焦）。
   */
  onReveal: (path: string, line: number, span?: RevealSpan, options?: { readonly focus?: boolean }) => void;
}

/** 单条命中行：主按钮跳转；行尾一枚替换钮（hover / focus-within 显形，键盘可达） */
function SearchMatchRow({
  path,
  match,
  ordinal,
  replaceDisabled,
  onReveal,
  onReplace,
}: {
  path: string;
  match: SearchMatch;
  /**
   * 这条命中在**显示序的命中行**里排第几（0 基，与 `data-panel-row` 名单同序）。
   * 行导航按它做绝对定位：虚拟列表只挂载窗口内的行，DOM 序不再等于全量序。
   */
  ordinal: number;
  replaceDisabled: boolean;
  onReveal: SearchPanelProps['onReveal'];
  /** 替换这一处（**收路径 + 命中**：回调要能被面板做成稳定身份，见 `replaceOneStable`） */
  onReplace: (path: string, match: SearchMatch) => void;
}): ReactElement {
  return (
    <div
      className="search-match-row ksp-row"
      // 右键菜单的行身份（1023 覆盖面批）：只存"是哪一条"，命中本体由面的上下文回查
      data-search-match=""
      data-search-path={path}
      data-search-line={match.line}
      data-search-column={match.column}
    >
      <button
        type="button"
        className="search-match ksp-row-main"
        data-panel-row=""
        data-ksp-row={ordinal}
        title={`${path}:${match.line}`}
        onClick={() => {
          // F4 的行导航也是敲这枚按钮（`panel-row-nav`）⇒ 鼠标与键盘同一条
          // 「当前项」判据，计数文案不会只在回车时跟手
          selectSearchMatch(path, match.line, match.column);
          onReveal(path, match.line, searchMatchSpan(match));
        }}
      >
        <span className="search-loc ksp-loc">{matchLocationLabel(match)}</span>
        <MatchPreview match={match} />
      </button>
      <button
        type="button"
        className="search-replace-one ksp-row-replace"
        title="替换这一处（文本已变化时会跳过并说明）"
        disabled={replaceDisabled}
        onClick={() => onReplace(path, match)}
      >
        替换
      </button>
    </div>
  );
}

export function SearchPanel({
  roots,
  scopes = EMPTY_SCOPES,
  scopeNotices = EMPTY_NOTICES,
  onReveal,
}: SearchPanelProps): ReactElement {
  const s = useSearchState();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  /** 结果区（行导航只在这一段里找行：工具条不参与漫游，见 `panel-row-nav`） */
  const resultsRef = useRef<HTMLDivElement>(null);
  /** 结果区里的虚拟列表本体（行都挂在它下面；它的 rect 就是"内容坐标 0"） */
  const vlistRef = useRef<HTMLDivElement>(null);
  /** 控制区（sticky）：算可见区间时要把它挡住的那一段扣掉 */
  const headRef = useRef<HTMLDivElement>(null);
  const optionsBodyId = useId();
  const replaceRowId = useId();
  const helpBodyId = useId();

  /** 替换行展开（UI 局部状态：VSCode 同构——默认收起，命令入口会自动展开） */
  const [replaceOpen, setReplaceOpen] = useState(false);
  /** 「选项」区展开（UI 局部状态；折叠只改 `display`，控件仍在 DOM，展开即用） */
  const [optionsOpen, setOptionsOpen] = useState(false);
  /**
   * 空态「键位速查」展开（批次十一 L08，UI 局部状态）：默认折叠成一行，
   * 悬浮/聚焦提示行时 CSS 临时展开，点「键位」钮则钉住——三径同体，控件仍在 DOM。
   */
  const [helpOpen, setHelpOpen] = useState(false);
  /** 折叠的文件块（key = path；局部状态，切视图卸载后回到全展开） */
  const [foldedFiles, setFoldedFiles] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 打字即搜开关（P2-11）：**默认开**。
   *
   * 理由：语料 3.8k 文件一次全量重读是秒级 IO，但 Rust 侧检索已多线程化（8 路并发，
   * 与索引阶段同款），单次检索墙钟已从"不敢想"降到"等得起"；而"打完词还要按一下
   * 回车"在检索面板里是纯粹的额外一步。默认开 + `SEARCH_DEBOUNCE_MS` 防抖 +
   * 运行中不重发（单飞，见下方 effect 注释），把这一步省掉，又不把连续打字变成
   * 连续全量重读。开关住面板自己行内（选项区），不占全局设置。
   */
  const [liveSearch, setLiveSearch] = useState(true);

  /**
   * 菜单动作的回执（复制 / 资源管理器；1023 覆盖面批）。
   *
   * 右键菜单里的动作没有行内按钮那样的落点，成败必须有一句话上屏（铁律 4：
   * 复制失败 / 资源管理器打不开都不许静默）。收 1.8s 后自动收起——与问题面板的
   * `prob-flash` 同一套反馈语言，不新增第二套通知机制。
   */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    },
    [],
  );
  const showFlash = (text: string): void => {
    setFlash(text);
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 1_800);
  };

  /** 写剪贴板（成败都说一句；没有剪贴板时菜单项本身已经整项不显示，这里是双保险） */
  const copyText = (text: string): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      showFlash('复制失败：当前环境没有剪贴板能力');
      return;
    }
    try {
      void clipboard.writeText(text).then(
        () => showFlash('已复制到剪贴板'),
        () => showFlash('复制失败：剪贴板拒绝了这次写入'),
      );
    } catch (e: unknown) {
      showFlash(`复制失败：${errorText(e)}`);
    }
  };

  // 挂载即聚焦；快捷键/命令再次命中（focusNonce 变化）也重新聚焦并全选——
  // 这是"Ctrl+Shift+F 就该能直接打字"的那一步（面板可能早就开着）。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [s.focusNonce]);

  // 「在文件中替换」命令命中（replaceFocusNonce 变化）：展开替换行并聚焦全选。
  // 只响应**尚未服务过**的请求（判据见模块级 `servicedReplaceNonce`）：切走再切回来，
  // 一次历史请求不会把焦点从检索框抢到替换框（控件还没碰就换落点 = 闹鬼）。
  const wantReplaceFocus = useRef(false);
  useEffect(() => {
    if (s.replaceFocusNonce === servicedReplaceNonce) return;
    servicedReplaceNonce = s.replaceFocusNonce;
    const el = replaceInputRef.current;
    if (el !== null) {
      // 已经展开：直接聚焦
      el.focus();
      el.select();
      return;
    }
    wantReplaceFocus.current = true;
    setReplaceOpen(true);
  }, [s.replaceFocusNonce]);
  // 展开那一步落定后再聚焦（条件渲染的输入框只有这一次提交之后才存在）
  useEffect(() => {
    if (!replaceOpen || !wantReplaceFocus.current) return;
    wantReplaceFocus.current = false;
    const el = replaceInputRef.current;
    if (el === null) return;
    el.focus();
    el.select();
  }, [replaceOpen]);

  const result = s.result;
  /**
   * 结果行族的派生量（PS-15）全部 memo 化：扁平化 / 行高账本 / 列宽只随**投影出的清单**变。
   * 此前每次渲染重算一遍——输入框每打一个字（`s` 换新对象）、切一个文件折叠，
   * 全项目检索的上万行扁平化就白算一次。`rows` 引用稳定也顺带给下游
   * `useLayoutEffect` / 行组件的依赖比较省了一层。
   *
   * P2-11 流式：清单来源 = 完成态优先，在途取累积批次（`displayFiles`）——
   * 每个批次到达都会重算一次投影，这正是"随到随画"要付的代价（排序 + 扁平化
   * 都是 O(n log n) 以下的纯函数，n = 已到文件数）。
   */
  const displayFiles = useMemo(
    () =>
      result !== null
        ? sortSearchFiles(result.files, s.sortMode)
        : s.phase === 'running' && s.streamFiles !== null
          ? sortSearchFiles(s.streamFiles, s.sortMode)
          : null,
    [result, s.phase, s.streamFiles, s.sortMode],
  );
  /**
   * 扁平行清单 = **全量**（不截断）且已按折叠裁决裁掉命中行。
   * 虚拟列表要的是"这份清单有多长"，所以折叠必须在投影层完成（见 `searchRowsOf`）。
   */
  const rows = useMemo<SearchRow[]>(
    () => (displayFiles === null ? [] : searchRowsOf(displayFiles, foldedFiles)),
    [displayFiles, foldedFiles],
  );
  /**
   * 行高的**真源是量出来的自然高度**（文件头 23 / 命中行 25.6 @12px，随 `--fs-*` 缩放变）。
   * 写死常量会在字号缩放后把窗口算错；"行高相等"的假设又会从第一个文件头之后开始漂。
   *
   * 住 ref 而不是 state：行高只参与**窗口计算**，不参与渲染（渲染只读 `vwin` 的留白），
   * 所以不需要为它再提交一帧——这一帧正是出结果那个热路径上最不该多付的。
   */
  const heightsRef = useRef<SearchRowHeights>(SEARCH_ROW_HEIGHTS_FALLBACK);
  /**
   * 上一次量到的可见区（坐标相对虚拟列表顶边）。
   *
   * 为什么留一份：**新结果到达时那一帧也要画对**。渲染期不能去量布局（量一次就是一次
   * 强制 flush），只好拿"上次量到的可见区"当估算——估算对了，`computeWindow` 随后算出的
   * 窗口与它同形，`sameRowWindow` 直接吞掉那次 setState ⇒ **一次提交出结果**。
   * 没有这个缓存时是两次提交（先按首屏缺省窗口画 40 行，再按真窗口重画），
   * 实测那一帧 28–35ms，砍掉后 20ms 上下。
   */
  const viewportRef = useRef<{ readonly top: number; readonly height: number } | null>(null);
  /**
   * 当前渲染窗口（视口 → `[start, end)` + 上下留白）。
   *
   * 记成"跟着哪份清单算的"（`rows` 身份）：换了一份结果（新检索 / 新批次 / 折叠变化）⇒
   * 立刻按缓存的可见区重算，绝不留上一份结果的窗口（那会把旧的行套到新结果上）。
   * 一份结果里，窗口由 `computeWindow` 写回；写回前渲染读的是这里算出的估算值。
   */
  const [vwinState, setVwinState] = useState<{
    readonly rows: readonly SearchRow[];
    readonly win: SearchRowWindow;
  } | null>(null);
  /** 上一次渲染**真的画出去**的窗口（`commitWindow` 据此判断"要不要再提交一帧"） */
  const renderedWinRef = useRef<SearchRowWindow | null>(null);
  const vwin = useMemo<SearchRowWindow>(() => {
    if (vwinState !== null && vwinState.rows === rows) return vwinState.win;
    // 首屏 / 量不到布局（服务端渲染、happy-dom）⇒ 画前 `SEARCH_VROWS_FALLBACK` 行
    const vp = viewportRef.current;
    const { offsets, total } = searchRowOffsets(rows, heightsRef.current);
    if (vp === null) {
      const end = Math.min(rows.length, SEARCH_VROWS_FALLBACK);
      return { start: 0, end, topPad: 0, bottomPad: total, total };
    }
    return searchRowWindow(offsets, vp.top, vp.height, SEARCH_VROW_OVERSCAN_PX);
  }, [rows, vwinState]);
  // 记下这一帧画出去的窗口（纯记账，不参与渲染决策；供 `commitWindow` 判"同形"）
  renderedWinRef.current = vwin;
  /** 写窗口（同形不写：滚动时大量帧的窗口根本没变） */
  const commitWindow = useCallback(
    (win: SearchRowWindow) => {
      // 与**已经画在屏上**的窗口同形 ⇒ 一个 setState 都不发。
      // 这条是本批热路径的关键：新结果到达时渲染期已按缓存的可见区算对了窗口，
      // 这里若再写一次就是"同一份 DOM 再渲染一遍"（实测多 6–10ms）。
      if (renderedWinRef.current !== null && sameRowWindow(renderedWinRef.current, win)) return;
      setVwinState({ rows, win });
    },
    [rows],
  );
  /**
   * 行导航要去的那一行**不在窗口里**时先记这儿（`null` = 没有待办）。
   * 虚拟列表只挂载可见行 ⇒ `focus()` 够不着第 900 行；先把窗口挪过去、下一帧再聚焦。
   * 用 state 而不是 ref：窗口要跟着它重算（ref 不会触发渲染）。
   */
  const [navTarget, setNavTarget] = useState<number | null>(null);
  /** 这一趟导航要不要顺手"打开"（F4 / F8）；`navTarget` 落定后由聚焦 effect 消费 */
  const navPendingOpen = useRef(false);
  /**
   * 行高 / 视口 / 滚动位置的**唯一**重算入口（layout effect 与滚动监听共用）。
   *
   * 纪律：这一个函数里**先把所有几何读光，再决定写什么**。读之间一旦夹了写
   * （`setState` → 提交 → DOM 变更），下一次读就得重新 flush 一遍布局——
   * 52,000px 高的滚动容器上，一次强制 flush 实测 4–5ms，夹三次就是十几毫秒。
   */
  const computeWindow = useCallback(() => {
    const el = resultsRef.current;
    const list = vlistRef.current;
    if (el === null || list === null) return;
    // —— 读：行高（已挂载的行是自然高度，面板不下发行高）+ 各层 rect
    const headerH = list.querySelector('.ksp-vrow-file')?.getBoundingClientRect().height ?? 0;
    const matchH = list.querySelector('.ksp-vrow-match')?.getBoundingClientRect().height ?? 0;
    const listRect = list.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const headRect = headRef.current?.getBoundingClientRect() ?? null;
    const scroller = scrollParentOf(el);
    const scRect = scroller?.getBoundingClientRect() ?? null;
    // —— 算
    const prev = heightsRef.current;
    const heights: SearchRowHeights = {
      file: headerH > 0 ? headerH : prev.file,
      match: matchH > 0 ? matchH : prev.match,
    };
    if (Math.abs(heights.file - prev.file) > 0.01 || Math.abs(heights.match - prev.match) > 0.01) {
      heightsRef.current = heights;
    }
    const { offsets, total } = searchRowOffsets(rows, heightsRef.current);
    const headBottom = headRect === null ? elRect.top : headRect.bottom;
    // 可见区 = 结果区 ∩（可滚动祖先 / 视口）再扣掉 sticky 控制区挡住的那一段
    const viewportTop =
      scRect === null ? Math.max(elRect.top, headBottom) : Math.max(elRect.top, scRect.top, headBottom);
    const viewportBottom = scRect === null ? elRect.bottom : Math.min(elRect.bottom, scRect.bottom);
    const height = viewportBottom - viewportTop;
    // 缓存给"下一份结果到达时那一帧"用（相对虚拟列表顶边，与滚动位置无关）
    viewportRef.current = { top: viewportTop - listRect.top, height: Math.max(0, height) };
    let next: SearchRowWindow;
    if (!(height > 0) || !(listRect.height > 0)) {
      // 量不到布局（服务端渲染 / happy-dom）或结果区整个在视口外：退回首屏 N 行
      const end = Math.min(rows.length, SEARCH_VROWS_FALLBACK);
      next = { start: 0, end, topPad: 0, bottomPad: total, total };
    } else {
      next = searchRowWindow(offsets, viewportTop - listRect.top, height, SEARCH_VROW_OVERSCAN_PX);
      // 行导航的目标行可能落在窗口外：把窗口撑到它（多带入一行即可，`focus()` 会把它滚进视口）
      if (navTarget !== null && (navTarget < next.start || navTarget >= next.end)) {
        const start = Math.min(next.start, navTarget);
        const end = Math.max(next.end, navTarget + 1);
        next = {
          start,
          end,
          topPad: offsets[start]!,
          bottomPad: total - offsets[end]!,
          total,
        };
      }
    }
    commitWindow(next);
  }, [rows, navTarget, commitWindow]);

  /**
   * 窗口重算：**只在结果清单 / 导航目标变化后**跑一次（不是每次提交都跑）。
   * 这里不能把 `vwin` 放进依赖：窗口本来就是这一步算出来的，再依赖它就成了
   * "写一帧 → 重新量 → 再写一帧"的自激环——每次提交多付一次强制布局。
   */
  useLayoutEffect(() => {
    computeWindow();
  }, [computeWindow]);
  useEffect(() => {
    let raf = 0;
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        computeWindow();
      });
    };
    // 滚动事件不冒泡，但**捕获**相能拿到全部后代滚动容器（侧栏滚的是祖先，不是结果区自己）
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [computeWindow]);

  /** 命中行在扁平行里的位置（行导航按**绝对序号**走，DOM 序只覆盖窗口） */
  const matchRowFlat = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < rows.length; i += 1) if (rows[i]!.kind === 'match') out.push(i);
    return out;
  }, [rows]);
  /** 扁平行下标 → 该行是第几条命中（-1 = 不是命中行）；渲染时给每行贴号 */
  const ordinalOf = useMemo(() => {
    const out = new Int32Array(rows.length).fill(-1);
    for (let i = 0; i < matchRowFlat.length; i += 1) out[matchRowFlat[i]!] = i;
    return out;
  }, [rows.length, matchRowFlat]);
  /**
   * 行导航落定：窗口里已经有那一行了就聚焦（`open` = F4，顺手敲它自己的 onClick）。
   * 放在 layout effect 里：`navTarget` 一变，这一帧的窗口已经把它带进来了才对得上号。
   */
  useLayoutEffect(() => {
    if (navTarget === null) return;
    const host = resultsRef.current;
    const el = host?.querySelector<HTMLElement>(`[data-panel-row][data-ksp-row="${navTarget}"]`);
    if (el === undefined || el === null) return; // 窗口还没跟上：下一次提交再试
    el.focus();
    if (navPendingOpen.current) el.click();
    navPendingOpen.current = false;
    setNavTarget(null);
  }, [navTarget, vwin.start, vwin.end]);

  const gutterCh = useMemo(() => locationGutterCh(rows), [rows]);
  const progressPercent = searchProgressPercent(s.progress);
  /**
   * 「第 X 项 / 共 Y 项」的 Y 取后端 `totalMatches`（与摘要「N 条结果」同一个数，
   * 两处读数不许对不上）；X 是 `matchCursor`（0 基显示序，-1 = 还没导航）。
   */
  const matchCounter = result !== null ? searchMatchCounterText(s.matchCursor, result.totalMatches) : null;

  /** 选择器**现在**显示的范围（陈旧 key 归一成 `''`）；与 `appliedScope`（结果的范围）不是一回事 */
  const selectedScope = findSearchScope(scopes, s.scopeKey);
  const selectedScopeKey = selectedScope === null ? '' : s.scopeKey;
  const staleScopeText = scopeStaleText(selectedScopeKey, s.appliedScope);
  /**
   * 结果态的第二行（视觉批十四）：范围 / 截断 / 陈旧原先各占一行，260px 里叠成
   * 四行 11px 的墙（真机读数）。合并成**一行**（` · ` 连接、超长省略），完整文本逐条进悬停。
   * （"本屏 X/Y 行"那条随虚拟列表退场：现在滚到哪画到哪，全量一直可达，没有"未列出"要交代。）
   */
  const resultNotes: { text: string; title: string; warn: boolean }[] = [];
  if (result !== null) {
    if (s.appliedScope !== null) {
      resultNotes.push({
        text: scopeStatusText(s.appliedScope),
        title: scopeRootsTitle(s.appliedScope),
        warn: false,
      });
      if (result.filesScanned === 0) {
        const empty = scopeEmptyText(s.appliedScope, result.skipped.filtered);
        resultNotes.push({ text: empty, title: empty, warn: true });
      }
    }
    const notice = searchNoticeText(result);
    if (notice !== null) resultNotes.push({ text: notice, title: notice, warn: true });
    if (staleScopeText !== null) resultNotes.push({ text: staleScopeText, title: staleScopeText, warn: true });
  }
  const extensionSummary = extensionSummaryText(s.extensionText);

  /**
   * 空态引导用的最近检索（批次十一 L08，纯呈现）：最近 6 条、新的在前。
   * 数据面就是 ↑/↓ 回溯用的同一份 `queryHistory`（store 里 pushSearchHistory 维护），
   * 不另开第二份账。
   */
  const recentQueries = useMemo(() => s.queryHistory.slice(-6).reverse(), [s.queryHistory]);

  /**
   * 发起检索。`query` 只影响"记住本轮真正发出去的是哪个词"（失败重试判据），
   * 实际发词由 `setQuery` 先行写入 store——空态最近检索 chips 走这条路
   * （先落词再发，与手动打字回车同一条 `runSearch` 通道，语义零差异）。
   */
  const start = (query?: string): void => {
    // 记下"这一次真正发出去的是哪个词"（自动补搜与手动点的都记）：失败后据此判断
    // 是不是同一个词在原地重试。放在 `start` 首行而不是防抖回调里——手动按钮也走这里。
    attemptedQueryRef.current = query ?? s.query;
    // 范围收窄发生在发请求**之前**：扫描代价在原生侧，少扫就是少扫（不是全扫再挑）。
    const narrowing = narrowRoots(roots, selectedScope);
    void runSearch(narrowing.roots, describeAppliedScope(selectedScope, narrowing));
  };

  /**
   * 结果间逐项跳（回车 = 下一项 / Shift+回车 = 上一项；与 F4 / Shift+F4 同一条数据面）。
   * 返回 `false` = 没有可导航的结果（没搜过 / 查询改过 / 零命中）——调用方退回"开始检索"，
   * 这样"打完词按回车"的老路一步不少（判据在 `search-store.stepSearchMatch`）。
   */
  const stepMatch = (delta: 1 | -1): boolean => {
    const target = stepSearchMatch(delta);
    if (target === null) return false;
    // W7-B：逐项跳只定位、不抢焦点——焦点留在检索框，连续回车才能一项项往下走。
    onReveal(target.path, target.match.line, searchMatchSpan(target.match), { focus: false });
    return true;
  };

  /**
   * 打字即搜（P2-11）：查询停顿 `SEARCH_DEBOUNCE_MS` 后自动发起。
   *
   * 单飞策略 = **运行中不重发**（"不重发 / 取消旧检索再发新的"二选一里选前者，
   * 与 store 的 `runSearch` 单飞同口径）：语料全量重读是秒级 IO，"取消旧检索
   * 再发新的"在最坏情况下（持续打字）永远出不了结果——每次都从头扫、每次都被
   * 打断。运行中输入新词只是不触发，在途结果照常随扫随到。
   *
   * **落定补搜（2026-10-20 修复用户反馈"第二次打字搜不出来"）**：单飞有个被忽略
   * 的尾巴——结果随到随画（`phase` 仍是 running 时就已经在画首批命中），作者看到
   * 命中就改词时，那一次防抖正撞在 running 上被 `runSearch` 静默丢掉，而这一丢
   * **永不补发**：屏幕停在旧词的结果（看着像"一条都搜不出来"），只有再点搜索钮
   * （那时早已 done）才动。修法＝把 `s.phase` / `s.resultQuery` 放进依赖：这一轮
   * 跑完（相位落定）effect 会再跑一次，若输入框的词已不是这份结果用的词，
   * 就补一次防抖检索——不取消在跑的（保住单飞），但也不再吞掉新词。
   *
   * `startRef`：防抖回调 300ms 后才执行，必须拿得到**当时的**根目录 / 范围，
   * 不能拿调度那一刻的闭包（store 的进度 tick 会让面板频繁重渲染，闭包会过期）。
   * 用 ref 而不是把 `start` 写进依赖：那会让每个进度 tick 都重置计时器，
   * 300ms 水远不到。
   */
  const startRef = useRef<() => void>(() => {});
  useEffect(() => {
    startRef.current = start;
  });
  // 挂载时带来的旧查询**不自动搜**：状态活得比面板久（切走再切回来结果已在，
  // 白跑一次全量检索只是浪费）。只有挂载后的查询变化才触发。
  const mountedQueryRef = useRef(s.query);
  /** 最近一次**真正发出去**的查询词（`start` 首行写；null = 本次挂载还没发过） */
  const attemptedQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!liveSearch) return;
    if (!isValidSearchQuery(s.query)) return;
    if (s.query === mountedQueryRef.current) return;
    // 单飞：正在跑就不发（取消在跑的再发新的在最坏情况下永远出不了结果）。
    // 但不吞词：跑完相位一变本 effect 会重跑，届时按下面两条判据补搜。
    if (s.phase === 'running') return;
    // 这一屏结果已经就是当前词的 ⇒ 无事可做。它同时是"补搜不自我循环"的闸：
    // 补搜跑完后 `resultQuery` 追上 `query`，effect 哪怕因相位变化重跑也会被这条挡住。
    if (s.phase === 'done' && s.resultQuery === s.query) return;
    // 这个词刚发过且失败了：自动补搜不许原地重试（失败相位下 `resultQuery` 被清成 null，
    // 上一条闸拦不住 ⇒ error→running→error 每 300ms 一次，永不停止；未打开项目 /
    // runner 抛错都会命中）。作者改词或手动点检索才再发。
    if (s.phase === 'error' && attemptedQueryRef.current === s.query) return;
    const timer = setTimeout(() => {
      startRef.current();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [s.query, liveSearch, s.phase, s.resultQuery]);

  /** 空态 chips：先落词再发（与手动输入回车同一条 `runSearch` 通道） */
  const runQuery = (q: string): void => {
    setQuery(q);
    start(q);
  };

  /** 全部替换 → 盘上事实变了 ⇒ 用同一组条件重跑检索，结果行/计数当场说新真相 */
  const replaceAll = (): void => {
    void runReplace({ kind: 'all' }).then((o) => {
      if (o !== null && o.applied > 0) start();
    });
  };

  /** 单条替换：只落这一处；改了盘上事实同样重跑检索 */
  const replaceOne = (path: string, match: SearchMatch): void => {
    void runReplace({ kind: 'one', target: { path, line: match.line, column: match.column } }).then((o) => {
      if (o !== null && o.applied > 0) start();
    });
  };

  /**
   * 行组件的两个稳定回调（身份不许每次渲染都换）。
   *
   * 理由：结果区是**整个 memo 出去**的（见下方 `resultsBody`）。打字时面板每敲一个字
   * 都重渲染一次，但结果区与它无关——只要依赖没变，React 拿到同一个元素引用就整棵跳过
   * （一行都不重建）。这条豁免的代价是回调身份必须稳：所以实现走 ref 现取，
   * 壳函数只在首次渲染时建一次。
   */
  const replaceOneRef = useRef(replaceOne);
  replaceOneRef.current = replaceOne;
  const replaceOneStable = useCallback((path: string, match: SearchMatch) => {
    replaceOneRef.current(path, match);
  }, []);
  const toggleFile = useCallback((path: string) => {
    setFoldedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /* ---------------------- 右键菜单面（1023 覆盖面批 · WP3.1） ---------------------- */

  /**
   * 文件路径 → 这一屏投影里它的命中（菜单按 `data-search-*` 认领行，再回这里取命中本体）。
   *
   * 为什么不在 DOM 属性里塞命中：属性只能存字符串，且结果一刷新就会指向一条已经不存在的
   * 命中；菜单只认"是哪一条"，命中本体留在现场这份投影里（找不到 ⇒ 菜单整级不表态）。
   */
  const matchesByPath = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    // 源是**全量投影**（不是屏上挂载的那几十行）：右键菜单要能对着滚出视口的行动作，
    // 虚拟列表不该把"这一屏"当成"这份结果"。
    if (displayFiles !== null) for (const f of displayFiles) map.set(f.path, [...f.matches]);
    return map;
  }, [displayFiles]);

  /**
   * 每次提交后刷新菜单上下文（`useEffect` 无依赖 = 每次渲染后重灌）。
   *
   * 不在渲染体里写模块状态：并发渲染下被放弃的那一次会把菜单指向一棵从未上屏的树。
   * 也不在卸载时清空 —— 面（`search-results`）只认 DOM 上的 `data-context-surface`，
   * 面板卸载后这颗元素随之消失，菜单根本走不到这里。
   */
  useEffect(() => {
    setSearchMenuContext({
      capabilities: {
        // 替换要落盘：必须有完成态结果、且没有别的替换在写
        canReplace: result !== null && s.phase === 'done' && !s.replaceRunning,
        canReveal: isTauri(),
        canCopy:
          typeof navigator !== 'undefined' &&
          typeof navigator.clipboard?.writeText === 'function',
      },
      handlers: {
        openMatch: (path, match) => {
          // 与点行同一条「当前项」判据（`selectSearchMatch`），菜单跳转不该另立一套游标
          selectSearchMatch(path, match.line, match.column);
          onReveal(path, match.line, searchMatchSpan(match));
        },
        copyText,
        revealPath: (path) => {
          void revealInExplorer(path).then(
            () => showFlash('已在资源管理器中显示'),
            (e: unknown) => showFlash(revealFailureText(e)),
          );
        },
        replaceMatch: (path, match) => replaceOne(path, match),
      },
      findMatch: (path, line, column) =>
        matchesByPath.get(path)?.find((m) => m.line === line && m.column === column) ?? null,
      firstMatchOf: (path) => matchesByPath.get(path)?.[0] ?? null,
    });
  });

  /**
   * 结果行导航（↑↓ 移焦点 / F4·F8 移过去并打开）在**虚拟列表**上的落地。
   *
   * 旧版直接调 `applyPanelRowNav`：它按**已挂载的 DOM 行**取名单，而虚拟列表只挂 40 行左右
   * ⇒ 走到窗口末尾时会长回第一行（`nextRovingIndex` 的回绕），F4 从此再也走不到第 41 条。
   * 所以这里把"该去哪一行"仍交给同一条判据（`rowNavDecision`：键位语义、回绕、下拉框让位
   * 全在那一处），只是名单换成**全量命中行**（`matchRowFlat`）：
   *   - 目标行已在窗口里 ⇒ 直接聚焦（与旧行为逐字相同）；
   *   - 目标行在窗口外 ⇒ 记成 `navTarget`，渲染时把窗口撑过去，下一帧再聚焦
   *     （`focus()` 自己会把它滚进视口）。
   * 返回 `true` = 这一下已消费。
   */
  const handleRowNav = (e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    const target = e.target as { closest?: (sel: string) => Element | null } | null;
    if (typeof target?.closest !== 'function') return false;
    const owner = target.closest('[data-panel-row]');
    const current = owner === null ? -1 : Number((owner as HTMLElement).dataset.kspRow ?? '-1');
    const decision = rowNavDecision({
      key: e.key,
      shiftKey: e.shiftKey,
      current,
      count: matchRowFlat.length,
      inField: target.closest('select, textarea') !== null,
    });
    if (decision === null) return false;
    const flatIndex = matchRowFlat[decision.index];
    if (flatIndex === undefined) return false;
    e.preventDefault();
    navPendingOpen.current = decision.open;
    const mounted = resultsRef.current?.querySelector<HTMLElement>(
      `[data-panel-row][data-ksp-row="${decision.index}"]`,
    );
    if (mounted !== null && mounted !== undefined) {
      mounted.focus();
      if (decision.open) mounted.click();
      navPendingOpen.current = false;
      return true;
    }
    setNavTarget(decision.index);
    return true;
  };

  /**
   * 结果区（虚拟列表）整块 memo。
   *
   * 依赖只有"真的会改变屏上那几十行"的几样：清单身份、窗口、折叠集合、行号槽宽、
   * 替换在途（替换钮 disabled）、跳转回调。输入框每敲一个字、进度 tick、切选项
   * 都不在这份依赖里 ⇒ React 拿到同一个元素引用，整棵子树直接跳过。
   * 这也是"逐字输入不掉帧"的落脚点：打字的主线程成本从"重建 34 行"降到"改一个字符"。
   */
  const resultsBody = useMemo<ReactElement | null>(() => {
    if (rows.length === 0) return null;
    return (
      <div
        ref={resultsRef}
        className="search-rows ksp-results"
        // 结果区的右键面（1023 批）：命中行 / 文件头由下面的 `data-search-*` 认领，
        // 空白处本面不表态（走兜底通用菜单）
        data-context-surface="search-results"
        style={{ '--ksp-gutter': String(gutterCh) } as CSSProperties}
      >
        <div
          ref={vlistRef}
          className="ksp-vlist"
          // 上下留白 = 窗口外那些行的总高：滚动高度与"全量都画出来"逐像素一致，
          // 滚动条不撒谎、滚到底就是最后一行（不留半截空白）。
          style={{ paddingTop: vwin.topPad, paddingBottom: vwin.bottomPad }}
          data-ksp-vrows={rows.length}
        >
          {rows.slice(vwin.start, vwin.end).map((row, i) => {
            const index = vwin.start + i;
            const isFirst = index === 0;
            if (row.kind === 'file') {
              const folded = foldedFiles.has(row.path);
              const { base, dir } = splitSearchPath(row.path);
              return (
                <div
                  key={index}
                  className={`ksp-group ksp-vrow ksp-vrow-file${isFirst ? ' ksp-vrow-first' : ''}`}
                  data-ksp-index={index}
                >
                  <button
                    type="button"
                    className="search-file ksp-file"
                    title={row.path}
                    aria-expanded={!folded}
                    // 右键菜单的文件组身份（见 `search-menu` 的 `SEARCH_FILE_ATTR`）
                    data-search-file=""
                    data-search-path={row.path}
                    onClick={() => toggleFile(row.path)}
                  >
                    <span className="ksp-file-caret" aria-hidden="true">
                      <Icon name={folded ? 'chevron-right' : 'chevron-down'} size="xs" />
                    </span>
                    {/* 可读名 = 完整的末两段路径（AT 与静态渲染判据都吃这一条）；
                        视觉上拆成 文件名 + 目录（dim）两段，两段对 AT 隐藏，避免读两遍 */}
                    <span className="ksp-sr">{shortSearchPath(row.path)}</span>
                    <span className="ksp-file-base" aria-hidden="true">
                      {base}
                    </span>
                    {dir !== '' ? (
                      <span className="ksp-file-dir" aria-hidden="true">
                        {dir}
                      </span>
                    ) : null}
                    {/* 计数徽标统一语言（批次十一 L08）：本体用 ui-kit 的 `KitCount`
                        （含 99+ 溢出形态）；`ksp-file-count` 只留面板差异（右靠 + 防 hover 同色的沉底） */}
                    <KitCount value={row.count} className="search-file-count ksp-file-count" />
                  </button>
                </div>
              );
            }
            return (
              <div key={index} className="ksp-group ksp-vrow ksp-vrow-match" data-ksp-index={index}>
                <SearchMatchRow
                  path={row.path}
                  match={row.match}
                  ordinal={ordinalOf[index] ?? 0}
                  replaceDisabled={s.replaceRunning}
                  onReveal={onReveal}
                  onReplace={replaceOneStable}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }, [rows, vwin, foldedFiles, ordinalOf, gutterCh, s.replaceRunning, onReveal, toggleFile, replaceOneStable]);

  return (
    <div
      className="panel-search ksp"
      role="search"
      aria-label="在文件中搜索"
      // 行导航（1020 编辑器体感批）：↑↓ 在可见结果行之间移焦点，F4/Shift+F4 移过去并当场打开。
      // 判据与问题面板共用 `panel-row-nav.rowNavDecision`；名单换成全量命中行（虚拟列表，见 handleRowNav）。
      onKeyDown={(e) => {
        handleRowNav(e);
      }}
    >
      {/* 控制区 + 状态区：单面板侧栏里整块 sticky（结果滚走、条件与读数常驻）。
          骨架与问题面板 / 大纲读数条同源 = ui-kit `KitPanelHeader`（1026 C1-a；
          无标题只有控件行——本档不填标题槽，追加行走 children）。 */}
      <KitPanelHeader ref={headRef}>
        <div className="ksp-row ksp-search-row">
          {/* 替换行开关：VSCode 同位（最左 chevron），展开/收起是纯 UI 状态 */}
          <button
            type="button"
            className="ksp-icon-btn ksp-twisty"
            aria-expanded={replaceOpen}
            // 只在展开时挂 aria-controls：折叠时替换行不在 DOM，指向一个不存在的 id 是坏引用
            {...(replaceOpen ? { 'aria-controls': replaceRowId } : {})}
            aria-label={replaceOpen ? '收起替换' : '展开替换'}
            title={replaceOpen ? '收起替换行' : '展开替换行'}
            onClick={() => setReplaceOpen((v) => !v)}
          >
            <Icon name={replaceOpen ? 'chevron-down' : 'chevron-right'} size="md" />
          </button>

          {/* 检索井：ui-kit `KitSearchField`（1026 C1-b 三处接入之一）。`ksp-field` 类逐字
              保留（本面板的度量细则仍住 search-panel.css 的 `.ksp-*` 段）；框内 toggle 组
              走右侧动作槽；判据锚类 `search-input ksp-input` 由 inputClassName 原样落上。 */}
          <KitSearchField
            className="ksp-field"
            inputClassName="search-input ksp-input"
            inputRef={inputRef}
            type="text"
            value={s.query}
            onChange={setQuery}
            placeholder="在文件中搜索…"
            title="回车开始检索；已有结果时回车 / Shift+回车逐项跳（与 F4 / Shift+F4 同效；Ctrl+Shift+F）；↑/↓ 回溯最近检索"
            ariaLabel="在文件中搜索"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              // 输入法组词中的 ↑↓ 是在候选词里翻页、回车是在确认候选词——一律不接管
              // （中文作者的主路径；不挡会把一次组词变成一次历史回溯 / 跳转）
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                // ↑/↓ 回溯最近检索（W7-E；数据面在 `search-store.stepSearchHistory`）：
                // ↑ 从草稿进入历史并向更旧走，↓ 向更新走、退到最新一条再按 = 还原草稿。
                // 没有历史 / 还没进入回溯时的 ↓ **不消费**——既有「↓ 进结果第一行」的
                // 行导航（`panel-row-nav`）原样保留；消费时必须停住冒泡，否则同一下按键
                // 会被面板根上的行导航再处理一遍（输入框与结果区各动一次）。
                if (stepSearchHistory(e.key === 'ArrowUp' ? -1 : 1)) {
                  e.preventDefault();
                  e.stopPropagation();
                }
                return;
              }
              // 回车 = 有结果逐项跳 / 没结果开始检索（输入法组词中的回车已在上面
              // 让位给候选词确认——中文作者的主路径，不挡会把一次组词变成一次跳转）
              if (e.key !== 'Enter') return;
              e.preventDefault();
              // 有结果优先逐项跳（VSCode 查找控件的 Enter 手感）；查询改过 / 没结果
              // ⇒ `stepSearchMatch` 返回 null，退回"回车开始检索"
              if (stepMatch(e.shiftKey ? -1 : 1)) return;
              start();
            }}
            actions={
              <div className="ksp-toggles" role="group" aria-label="检索选项">
                {TOGGLES.map((t) => {
                  const on = s.options[t.key];
                  return (
                    <button
                      key={t.key}
                      type="button"
                      className={`search-toggle ksp-toggle${on ? ' on' : ''}`}
                      title={t.title}
                      aria-label={t.title}
                      aria-pressed={on}
                      onClick={() => toggleOption(t.key)}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            }
          />

          {s.phase === 'running' ? (
            <button
              type="button"
              className="ksp-go ksp-go-stop"
              title="停止检索（保留已扫到的部分结果）"
              aria-label="停止检索"
              onClick={() => void stopSearch()}
            >
              <span className="ksp-stop-glyph" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="primary ksp-go"
              title="搜索（回车触发；Ctrl+Shift+F 聚焦本面板）"
              aria-label="搜索"
              onClick={() => start()}
            >
              <Icon name="search" size="sm" />
            </button>
          )}
        </div>

        {/* 替换行（R7 搜索替换批）：仅在展开时出现，Enter = 全部替换。
            空替换串 = 删除命中（合法操作，不拦截）。$1 引用捕获组，$& = 整个命中。 */}
        {replaceOpen ? (
          <div className="ksp-row ksp-replace-row" id={replaceRowId}>
            <span className="ksp-twisty-gap" aria-hidden="true" />
            <div className="ksp-field">
              <input
                ref={replaceInputRef}
                className="search-input ksp-input"
                placeholder="替换为…（空 = 删除；$1 引用捕获组）"
                title="支持 $1–$99 引用正则捕获组；$& = 整个命中；$$ = 字面 $。回车 = 全部替换。"
                aria-label="替换为"
                autoComplete="off"
                spellCheck={false}
                value={s.replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    replaceAll();
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="ksp-replace-all"
              title="全部替换：结果里的每个文件都按当前文本逐处替换"
              disabled={
                result === null || s.replaceRunning || result.truncated || result.cancelled || s.phase !== 'done'
              }
              onClick={replaceAll}
            >
              全部替换
            </button>
          </div>
        ) : null}

        {/* 选项区：类型 / 只看范围收进一行；折叠时用摘要 chip 交代非默认状态 */}
        <div className="ksp-options">
          <button
            type="button"
            className="ksp-options-toggle"
            aria-expanded={optionsOpen}
            aria-controls={optionsBodyId}
            title={optionsOpen ? '收起检索选项' : '展开检索选项'}
            onClick={() => setOptionsOpen((v) => !v)}
          >
            <span className="ksp-caret" aria-hidden="true">
              <Icon name={optionsOpen ? 'chevron-down' : 'chevron-right'} size="xs" />
            </span>
            <span className="ksp-options-label">选项</span>
            {/* 摘要只在折叠时出现：展开后同一事实已在下面的控件里，重复一遍只是噪音。
                范围 chip 再收一档——结果本来就来自同一个范围时，状态区的范围说明已经说了，
                这里只在"下次检索会换范围"（或还没搜过）时提示。 */}
            {optionsOpen ? null : (
              <>
                {selectedScope !== null && selectedScope.key !== s.appliedScope?.key ? (
                  <span
                    className="ksp-chip ksp-chip-scope"
                    title={selectedScope.detail || selectedScope.label}
                  >
                    只看「{selectedScope.label}」
                  </span>
                ) : null}
                {extensionSummary !== null ? (
                  <span className="ksp-chip" title={s.extensionText.trim()}>
                    {extensionSummary}
                  </span>
                ) : null}
              </>
            )}
          </button>

          {/* 折叠用 class 而不是条件渲染：控件留在 DOM（静态渲染判据与键盘展开都不必等重挂） */}
          <div
            id={optionsBodyId}
            className={`ksp-options-body${optionsOpen ? '' : ' ksp-collapsed'}`}
          >
            <label className="search-ext-row ksp-opt-row">
              <span className="ksp-opt-label">类型</span>
              <input
                className="search-ext ksp-opt-input"
                title="扩展名，逗号分隔；留空 = 不限扩展名"
                autoComplete="off"
                spellCheck={false}
                value={s.extensionText}
                onChange={(e) => setExtensionText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    start();
                  }
                }}
              />
            </label>

            {/* 排序（P2-11）：三选一，默认按路径（与今天逐字一致）。只改投影序，
                不重发检索；在途流式结果也当场重排（排序是纯函数，住 search-stream）。
                井本体 = ui-kit `KitSelect`（1026 C2-b）：`appearance` 归零 + 自绘 chevron，
                开合 / 键盘 / 读屏仍归原生 `<select>`。Enter 即搜那条腿在行本体上接住
                （keydown 从 select 冒泡上来），件因此不必为它多开一个口子。 */}
            <label
              className="search-sort-row ksp-opt-row"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  start();
                }
              }}
            >
              <span className="ksp-opt-label">排序</span>
              <KitSelect
                className="search-sort ksp-opt-select"
                ariaLabel="排序方式"
                title="结果排序：按路径（默认）/ 按命中数 / 按文件名。只改投影顺序，不重新检索。"
                value={s.sortMode}
                onChange={(v) => setSearchSortMode(v as SearchSortMode)}
                options={SEARCH_SORT_OPTIONS.map((o) => ({ value: o.mode, label: o.label }))}
              />
            </label>

            {scopes.length > 0 ? (
              // 范围（只看那一处）同上：井在基座，逐档说明走 `option.title`（KitSelectOption
              // 那条 additive 的腿），陈旧 key 按"不限"显示与生效，不猜。
              <label
                className="search-scope-row ksp-opt-row"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    start();
                  }
                }}
              >
                <span className="ksp-opt-label">只看</span>
                <KitSelect
                  className="search-scope ksp-opt-select"
                  ariaLabel="只看的目录范围"
                  title="默认不限：整个项目加作者工作区一起搜。选定后只搜那一处，速度更快，但范围外的文件这一轮不会搜。"
                  value={selectedScopeKey}
                  onChange={(v) => setSearchScope(v)}
                  options={[
                    { value: '', label: '全部目录' },
                    ...scopes.map((o) => ({
                      value: o.key,
                      label: o.label,
                      title: o.detail || undefined,
                    })),
                  ]}
                />
              </label>
            ) : null}

            {/* 打字即搜开关（P2-11）：住面板自己行内，不占全局设置。
                默认开的理由见组件顶部 `liveSearch` 注释。
                勾本体 = ui-kit `KitCheck`（1026 C2-a）：可见文字走件自己的 label 档
                （外层因此从 `<label>` 退成 `<div>`，不套嵌套 label）。 */}
            <div
              className="search-live-row ksp-opt-row"
              title="打字即搜：停止输入约 0.3 秒后自动检索（回车 / 搜索钮随时可手动搜）"
            >
              <KitCheck
                className="search-live"
                checked={liveSearch}
                label="打字即搜"
                onChange={setLiveSearch}
              >
                打字即搜
              </KitCheck>
            </div>

            {/* P2-15：glob 过滤 + 保留大小写开关（自带状态的新组件；一行接线，不重排既有行） */}
            <SearchFilterBar onRequestSearch={start} />
          </div>
        </div>

        {scopeNotices.length > 0 ? (
          // 提供方抛错 / 候选非法：坏在明处（铁律 4），不静默少画几行候选
          <div className="search-status search-scope-notice ksp-note ksp-note-warn">
            {scopeNotices.join(' · ')}
          </div>
        ) : null}

        <div className="ksp-status-zone">
          {/* 菜单动作回执（复制 / 在资源管理器中显示）：1.8s 后自动收起，不占常驻版面 */}
          {flash !== null ? (
            <div className="search-status ksp-note ksp-menu-flash" role="status">
              {flash}
            </div>
          ) : null}
          {s.phase === 'running' ? (
            <div className="search-status ksp-status ksp-progress">
              <span className="ksp-spinner" aria-hidden="true" />
              <span className="ksp-progress-text">
                {s.progress ? searchProgressText(s.progress) : '检索中…'}
              </span>
              <span className="ksp-progress-track" aria-hidden="true">
                <span
                  className={`ksp-progress-bar${progressPercent === null ? ' indeterminate' : ''}`}
                  style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
                />
              </span>
            </div>
          ) : s.error !== null ? (
            <div className="search-status search-error ksp-status ksp-error" role="alert">
              <span className="ksp-error-text">{s.error}</span>
              <button type="button" className="ghost small ksp-clear" onClick={clearSearchResult}>
                清空
              </button>
            </div>
          ) : result !== null ? (
            <>
              <div className="ksp-summary-line">
                {/* 完成/停止的读数：结果集的一句话事实（role=status 只在这里，进度条不刷屏） */}
                <span
                  className={`search-status ksp-summary${result.cancelled ? ' search-stopped' : ''}`}
                  role="status"
                  title={searchSummaryDetail(result)}
                >
                  {searchSummaryText(result)}
                </span>
                {matchCounter !== null ? (
                  // 「第 X 项 / 共 Y 项」：与查找控件同语义；X 由回车 / Shift+回车 /
                  // F4 / 点行同一条游标给出（`search-store.stepSearchMatch`）
                  <span
                    className="search-status ksp-match-counter"
                    title="回车 = 下一项，Shift+回车 = 上一项（F4 / Shift+F4 同效）"
                  >
                    {matchCounter}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ghost small ksp-clear"
                  title="清空结果（保留检索条件与开关）"
                  onClick={clearSearchResult}
                >
                  清空
                </button>
              </div>
              {s.replaceRunning ? (
                // 写盘在途：按钮已锁，这句负责说"不是没反应，是在写"
                <div className="search-status ksp-status ksp-progress">
                  <span className="ksp-spinner" aria-hidden="true" />
                  <span className="ksp-progress-text">替换中…（正在写盘）</span>
                </div>
              ) : null}
              {s.replaceSummary !== null ? (
                <div
                  className="search-status search-replace-summary ksp-note ksp-note-replace"
                  title={s.replaceSummary}
                  role="status"
                >
                  {s.replaceSummary}
                </div>
              ) : null}
              {resultNotes.length > 0 ? (
                // 四类边角说明合并成一行：超长省略，完整文本逐条进悬停（视觉批十四）
                <div
                  className={`search-status ksp-note ksp-notes-line${
                    resultNotes.some((n) => n.warn) ? ' ksp-note-warn' : ' dim'
                  }`}
                  title={resultNotes.map((n) => n.title).join('\n')}
                >
                  {resultNotes.map((n) => n.text).join(' · ')}
                </div>
              ) : null}
            </>
          ) : (
            // 空态（批次十一 L08）：一行引导 + 可折叠键位速查 + 最近检索 chips。
            // 旧的 4 行说明书收进折叠区——键位提示统一走 `<kbd>` 芯片语言（`KitKbd`），
            // 不再用文本符号混排（↵ ⇧ ↑↓ F4 各写各的）。行为零改动：chips 只是
            // "先 setQuery 再 start"，与手动输入回车同一条数据面。
            <div className="ksp-empty">
              <div className="ksp-empty-line">
                <span className="search-status dim ksp-hint">输入检索词后回车开始检索；点结果行可跳转到该位置。</span>
                <button
                  type="button"
                  className="ksp-help-toggle"
                  aria-expanded={helpOpen}
                  aria-controls={helpBodyId}
                  title="键位速查（悬停此行也可临时展开）"
                  onClick={() => setHelpOpen((v) => !v)}
                >
                  <span className="ksp-caret" aria-hidden="true">
                    <Icon name={helpOpen ? 'chevron-down' : 'chevron-right'} size="xs" />
                  </span>
                  键位
                </button>
              </div>
              {/* 折叠用 class（与「选项」区同一手法）：控件留在 DOM，悬浮/聚焦即展开。
                  键位芯片统一走 ui-kit 的 `KitKbd`（combo 语言：修饰键用词、方向键用符号），
                  本面板不再自带第二份 Kbd 实现。 */}
              <div id={helpBodyId} className={`ksp-help-body${helpOpen ? '' : ' ksp-collapsed'}`}>
                <ul className="ksp-help-list">
                  <li>
                    <span className="ksp-keys">
                      <KitKbd combo="Enter" />
                    </span>
                    <span>开始检索；已有结果时逐项跳下一处</span>
                  </li>
                  <li>
                    <span className="ksp-keys">
                      <KitKbd combo="Shift+Enter" />
                    </span>
                    <span>
                      逐项跳上一处（<KitKbd combo="F4" /> / <KitKbd combo="Shift+F4" /> 同效并当场打开）
                    </span>
                  </li>
                  <li>
                    <span className="ksp-keys">
                      <KitKbd combo="↑" />
                      <KitKbd combo="↓" />
                    </span>
                    <span>输入框内回溯最近检索；结果区内逐行移动焦点</span>
                  </li>
                  <li>
                    <span className="ksp-keys">
                      <KitKbd combo="Ctrl+Shift+F" />
                    </span>
                    <span>唤起检索面板并聚焦输入框</span>
                  </li>
                </ul>
              </div>
              {recentQueries.length > 0 ? (
                <div className="ksp-recent" role="group" aria-label="最近检索">
                  <span className="ksp-recent-label">最近检索</span>
                  {recentQueries.map((q, i) => (
                    <button
                      key={`${i}:${q}`}
                      type="button"
                      className="ksp-recent-chip"
                      title={`再次检索「${q}」`}
                      onClick={() => runQuery(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="ksp-suggest">默认检索整个项目 + 作者工作区；展开「选项」可按类型 / glob / 范围收窄。</div>
              )}
            </div>
          )}
        </div>
      </KitPanelHeader>

      {/* 结果区：**虚拟列表**（只挂视口内的行 + overscan，两侧留白顶起滚动高度）。
          行号槽宽由整份结果的最长读数定（CSS 自定义属性，一处写全列表）。
          整块 memo 出去：打字 / 切开关 / 进度 tick 都只重渲染控制区，结果区一行都不重建。 */}
      {resultsBody}
    </div>
  );
}
