import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { diagnosticDisplay, errorText, shortPath } from '@kojo/plugin-api';
import type { EditorCodeAction } from '@kojo/plugin-api';
import { revealSpanOf, type RevealSpan } from '../monaco/reveal-position';
import {
  snapshot,
  subscribe,
  currentVersion,
  summarizeProblems,
  SEVERITY_TINT,
  PROBLEM_SCOPE,
  type EditorProblem,
} from './problem-store';
import { rowNavDecision } from './panel-row-nav';
import {
  ALL_SEVERITIES,
  filterOfPrefs,
  filterProblems,
  groupProblems,
  isFiltering,
  loadProblemFilterPrefs,
  saveProblemFilterPrefs,
  sourceOptions,
  type ProblemFilterPrefs,
  type ProblemSeverity,
} from './problem-filter';
import {
  collectRowFix,
  planLineEdits,
  problemCopyText,
  problemLineDecoration,
  readProblemFixHost,
  rowFixKey,
} from './problem-fix';
import {
  PROBLEM_ROW_HEIGHTS_FALLBACK,
  problemItemRowIndex,
  problemOrdinalMap,
  problemRowOffsets,
  problemRowWindow,
  problemRowsOf,
  sameProblemRowWindow,
  type ProblemRow,
  type ProblemRowHeights,
  type ProblemRowWindow,
} from './problem-rows';
import {
  COPY_ALL_DISABLED_REASON,
  setProblemsMenuContext,
} from './problem-menu';
import './context-menu-search.css';
import { Icon } from './icons';

/**
 * 底部「问题」面板（看板 HK-4 · UI-6；P2-13 分组/过滤/行内修复/复制批）。
 *
 * 数据源 = `problem-store`（`EditorPane.refreshMarkers` 逐文件整份发布）：
 * `erb-parser`（结构类，error）与 `condition-extractor`（表达式类，warning）两层
 * 波浪线在此汇总成可展开的列表。每条可点击 → 经宿主回调跳源行（跳转通道由
 * ProjectView 走 `editor.revealLocation` 事件，见其内建视图接线）。
 *
 * **跳的是"这一处"，不是"这一行"**（W9 落点 span 批）：`onReveal` 的第 3 位就是
 * 波浪线盖住的列区间，与检索面板、转到定义、G1 回放跳转**同一个形状**；
 * 区间给不出就整个省略，退化由 `reveal-position` 判一次（面板不许自己补列）。
 *
 * 视觉族（批次十一 L03）：行体沿用「约定校验」面板的语言（`.conv-summary` / `.conv-count` /
 * `.conv-dot` / `.conv-issue-btn`），**控件与密度**与检索面板（`.ksp-*`，见 `search-panel.css`）
 * 同尺——工具条 / 过滤控件 / 分组头 / 行内动作的规则全部住 `problem-panel.css`
 * （根类 `.prob` 提特异性，压过 `styles-project.css` 里遗留的单类旧档）。
 *
 * ## P2-13（2026-10-19）四件事
 *
 * 1. **按文件分组（可折叠）**：组头 = 短路径 + 按严重级分色的计数徽标；组序 =
 *    过滤后序列的首次出现序（判据与理由见 `groupProblems`）。折叠在**投影层**减行
 *    （`problemRowsOf` 不把折叠组的行放进清单）——账本按这份清单算偏移，若只在渲染时
 *    跳过，行高账本会多出一整块空白（滚到后面全是空气）。组头一律保留（折叠态要能点开）。
 * 2. **过滤**：严重级多选 + 来源（单选，来源清单见 `sourceOptions`）+ 文本子串（判据在
 *    `filterProblems`；默认全开 + 全部来源 + 空文本 = 与旧版逐字一致）。过滤条件一变，
 *    滚动**回到列表头**（换了一把尺就重新从第一屏看起，旧深度对新结果没有意义）。
 *    **条件会被记住**（S14）：`saveProblemFilterPrefs` / `loadProblemFilterPrefs` 走壳层
 *    localStorage（`kojo.ui.problemFilter.v1`），无 window / 坏值一律回默认、绝不抛。
 * 3. **行内 fix**：**唯一解才给按钮**（判据＝`collectRowFix`，与 💡 的 `isPreferred`
 *    同一条底座）；点击直接落地（改写计划 `planLineEdits` → 宿主座 `applyRowFix`，
 *    一次编辑调用 = 一个撤销步）。本面板**不出预览 diff**——预览是 💡 那条路的判据
 *    （P2-14），面板按钮是"这一条就这一个解"的快捷路，两条路各司其职。
 * 4. **复制消息**：文案 = `路径:行号 [级别] 消息`（判据见 `problemCopyText`）；
 *    成败都有一句反馈（不静默，铁律 4）。
 *
 * ## 行内 fix 的问询缓存
 *
 * 问槽一次 = 供方按**整篇文本**算一遍动作。渲染期逐行问就是每帧 120 次全篇扫——
 * 所以按 `rowFixKey`（路径 ⊕ 诊断身份）缓存答案，带 `(store 版本, model 版本,
 * 贡献方数量, 文本长度)` 四元指纹：同版本重渲零重问（供方自身还有 PS-4 的版本
 * 记忆化兜底），文本一改自动作废重问。指纹含 `contributions.length` 是个务实的
 * 粗判：贡献方表变而数量不变的场景（重载同数插件）会多缓存一轮旧答案，下一版
 * 本发布即自愈——面板按钮最坏情况是多/少给一轮，不会落错编辑（落地前判据重算）。
 */

/**
 * 一条问题 → 交回宿主的落点区间（纯函数，可单测；判据全在 `revealSpanOf`）。
 * 坏区间 / 缺区间 ⇒ `undefined` = "只有一行"，与没接线前逐字一致。
 */
export function problemRevealSpan(problem: Pick<EditorProblem, 'span'>): RevealSpan | undefined {
  return revealSpanOf({ span: problem.span });
}

/** 严重度配色：真源在 `problem-store.SEVERITY_TINT`（面板 / 状态栏 / 文件树共用一色） */
const SEVERITY_COLOR = SEVERITY_TINT;

/** 严重级的中文短名（过滤勾选框与表头计数同一份；文案真源在此一处） */
const SEVERITY_LABEL: Record<ProblemSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};

/**
 * 严重级 → 内置图标名（`icons.tsx` 的 SVG）。批次十一 L03：字符 `✕ ⚠ ℹ` 不再被**画**出来，
 * 屏上的图标一律 SVG；这里只映射语义，不映射颜色（颜色仍单源 `SEVERITY_TINT`）。
 */
const SEVERITY_ICON: Record<ProblemSeverity, 'error' | 'warning' | 'info'> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/**
 * 严重级 → 上屏**读数腿**的符号（`符号 空格 数字`）。
 *
 * 这一格文字不上屏（CSS 视觉隐藏），吃它的是两只眼睛：屏幕阅读器，和
 * `tests/problem-truth-single-source.test.ts` 那把「四处一个真相」的尺（它按文本形态取数，
 * 正是为了钉住状态栏 / 面板组头 / 树徽标读同一个数）。可见腿换成 SVG 时把这条腿留着，
 * 单源闸继续 armed——与 `search-panel.css` 的 `ksp-sr` 同一族做法（可见与读数分离）。
 */
const SEVERITY_GLYPH: Record<ProblemSeverity, string> = {
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

/**
 * 一枚严重级计数徽标（SVG 图标 + 数字 + 读数腿）。
 *
 * `// ui-kit-candidate: KitCount` —— 计数徽标现在全仓四套并存（`.conv-count` / `.ksp-file-count` /
 * `.tree-prob-mark` / 状态栏 `.sb-problems-item`）；这一枚按 `ksp-file-count` 的尺度写
 * （胶囊 / `--fs-0` / `tabular-nums` / 底纹由 `currentColor` 派生 ⇒ 零新增色值），
 * 收编时把另三套换成它，而不是再造第五套。
 */
function SeverityCount({
  severity,
  count,
}: {
  severity: ProblemSeverity;
  count: number;
}): ReactElement {
  return (
    <span
      className="prob-count"
      style={{ color: SEVERITY_COLOR[severity] }}
      title={`${SEVERITY_LABEL[severity]} ${count}`}
    >
      <Icon name={SEVERITY_ICON[severity]} size={11} className="prob-count-icon" />
      <span className="prob-count-num" aria-hidden="true">
        {count}
      </span>
      <span className="prob-count-sr">{`${SEVERITY_GLYPH[severity]} ${count}`}</span>
    </span>
  );
}

/**
 * 来源下拉里「全部来源」的哨兵值：与「未标注来源」的键 `''` 必须分开——
 * 两个选项共用一个空值，选中哪个都是同一份 DOM 值，过滤就再也切不回全部。
 */
const ALL_SOURCES_VALUE = '\u0000all';

/**
 * 问题列表的渲染窗口：**真虚拟列表**（1025 性能批 A 线，2026-10-25）。
 *
 * 沿革（三版，别再往回退）：
 *  ① PS-6：硬截 300 条 + 「仅显示前 300 条」——第 301 条没有任何入口可达（铁律 4）。
 *  ② 1025 上一批：预算单位从「行」改成「条目（组头也占一条）」，首帧 60 条 + 哨兵
 *     + rIC 分片补窗。首帧从 137ms 降到 53ms，但**滚动/连点仍慢**：哨兵连点实测
 *     52/90/109ms，基数越大越慢（59 行 31.5ms → 296 行 99ms → 648 行 100–160ms）；
 *     perf 报告 `scriptMs 0 / renderMs 159` —— 行组件 memo 化确实把"渲染次数"降了，
 *     **墙钟不动**：钱付在布局上，不是付在 JS 上。
 *  ③ 本批：照检索面板（`search-rows` + `SearchPanel`，`0bcad61c`）的模板改成**真窗口化**：
 *     DOM 只保留视口内的行 + 上下 overscan，两侧用留白顶起滚动高度。
 *     DOM 行数与总诊断数**解耦**（2,641 条与 26 条同价），布局成本封在"一屏 + 两圈缓冲"。
 *
 * 代价（诚实记账）：组头不再恒可见（与上一批同一条取舍）、行导航要按**全量行**而不是
 * DOM 名单走（判据仍住 `panel-row-nav.rowNavDecision`，只是名单换了，见 `handleRowNav`）。
 * 可达性一根没掉：全量靠滚动可达，滚动高度 = 全量行高之和（账本在 `problem-rows`）。
 *
 * 首帧还不认识视口（服务端渲染 / happy-dom / 第一次挂载）：先画前
 * `PROBLEM_VROWS_FALLBACK` 条，挂载后由 layout effect 量到真视口再收口（与检索面板同法）。
 */
export const PROBLEM_VROWS_FALLBACK = 40;
/** 视口上下各多画多少像素（滚动时新行已在位，不闪白；底栏可视高约 170px） */
const PROBLEM_VROW_OVERSCAN_PX = 240;

function useProblems(): readonly EditorProblem[] {
  const [items, setItems] = useState<readonly EditorProblem[]>(() => snapshot());
  useEffect(() => subscribe(() => setItems(snapshot())), []);
  return items;
}

/** 行内 fix 问询缓存的一条值（指纹四元组 + 答案） */
interface RowFixEntry {
  readonly version: number;
  readonly docVersionId: number;
  readonly contribLen: number;
  readonly textLen: number;
  readonly action: EditorCodeAction | undefined;
}

/** 过滤工具条的输入井占位（与检索面板的 `ksp-field` 同一族，见 `problem-panel.css`） */
const FILTER_INPUT_PLACEHOLDER = '过滤：消息 / 诊断码 / 来源 / 路径…';

/**
 * 过滤条件的比对指纹（"没变不写 localStorage"用）。字段与 `saveProblemFilterPrefs` 的
 * 落盘形状逐字同形——两边各写一份就是下次加字段时漏一处。
 */
function prefsSignature(prefs: ProblemFilterPrefs): string {
  return JSON.stringify({ severities: prefs.severities, source: prefs.source, text: prefs.text });
}

/**
 * 最近的**可滚动祖先**（虚拟列表的视口 = 它，而不是列表自己）。
 *
 * 为什么不能只看列表：底部面板的滚动交回壳层容器 `.container-body`（`overflow:auto`），
 * `.prob-list` 自己 `overflow: visible`——实测 `clientHeight === scrollHeight === 1384px`，
 * 真正滚的是祖先。硬编码那个类名等于把面板焊死在当前壳层布局上，所以这里按
 * "能滚的那个祖先是哪个"现找（与检索面板 `scrollParentOf` 同一条判据）。
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

/**
 * 自绘勾选控件：真 `<input type="checkbox">` 只把外观换成画出来的方框，语义一格不动
 * （Tab 得到它、空格切得动、`checked` 受控、屏幕阅读器读得出）——与 `Switch.tsx` 同一
 * 语言，只是形态是勾选而非拨动。
 *
 * `// ui-kit-candidate: KitCheck` —— 收编后可替掉检索面板那颗 `ksp-opt-check`
 * 与设置页里靠 `accent-color` 的散勾选，全仓一族的方框。
 */
function KitCheck({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  /** 直接给布尔值（同 `Switch`）：调用方不必再读 event，也不给"第二处偷偷读 event"留口子 */
  onChange: (checked: boolean) => void;
  /** 无障碍名（放进 `<label>` 时与可见文字同词，满足 WCAG 2.5.3 label-in-name） */
  label: string;
}): ReactElement {
  return (
    <span className="prob-check">
      <input
        type="checkbox"
        className="prob-check-input"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="prob-check-box" aria-hidden="true">
        <Icon name="check" size={10} className="prob-check-glyph" />
      </span>
    </span>
  );
}

export function ProblemPanel({
  onReveal,
}: {
  /** 跳源：路径 + 行 + **能给得出的列区间**（与检索面板、定义、G1 同一条通道同一个形状） */
  onReveal: (path: string, line: number, span?: RevealSpan) => void;
}): ReactElement {
  const items = useProblems();
  /**
   * 过滤条件（严重级 + 来源 + 文本；S14 起整体持久化）。
   * 初值从壳层 localStorage 读（缺省 = 全开 / 全部来源 / 空文本 = 旧口径）。
   */
  const [filterPrefs, setFilterPrefs] = useState<ProblemFilterPrefs>(() => loadProblemFilterPrefs());
  const sevSel = filterPrefs.severities;
  const sourceSel = filterPrefs.source;
  const filterText = filterPrefs.text;
  /** 折叠的组（键 = 完整路径；纯视觉，见窗口注） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** 行级反馈（复制 / 修复的成败，1.8s 自动收起；不静默） */
  const [flash, setFlash] = useState<{ readonly key: string; readonly text: string } | null>(null);
  /** 行内 fix 问询缓存（判据见模块头） */
  const fixCacheRef = useRef<Map<string, RowFixEntry>>(new Map());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 列表区（= 虚拟列表本体：行都挂在它下面，它的 rect 就是"内容坐标 0"）。
   * 行导航也只在这一段里找行：过滤框与勾选框不参与漫游，见 `panel-row-nav`。
   */
  const listRef = useRef<HTMLUListElement>(null);
  /** 常驻头（sticky）：算可见区间时要把它挡住的那一段扣掉 */
  const headRef = useRef<HTMLDivElement>(null);

  // 过滤条件持久化（S14）：选择一变就记一笔，下次打开沿同一把尺；写不进去静默降级。
  // **首帧不写**（1025 性能批）：挂载时写回的必然是刚读出来的同一份值，而 WebView 的
  // localStorage 首写实测 39ms（CDP 采样 `setItem` selfTime）——它落在打开面板那一条
  // 长任务里，纯属白花。用"序列化后比对"把"没变不写"钉住（初值 = 刚读出来的那份）。
  const lastSavedPrefsRef = useRef<string>(prefsSignature(filterPrefs));
  useEffect(() => {
    const next = prefsSignature(filterPrefs);
    if (next === lastSavedPrefsRef.current) return;
    lastSavedPrefsRef.current = next;
    saveProblemFilterPrefs(filterPrefs);
  }, [filterPrefs]);

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // 计数只从 `summarizeProblems` 来（工包 E 判据①：状态栏那颗、面板表头、面板组头、
  // 文件树徽标共用同一次遍历的同一份结果；这里再数一遍就是分叉的起点）
  const summary = summarizeProblems(items);
  const { error, warning, info } = summary.counts;

  const header =
    items.length === 0
      ? ({ kind: 'empty' } as const)
      : ({ kind: 'counts', error, warning, info } as const);

  /**
   * 面板态 → 纯判据（严重级集合 / 来源集合 / 文本；判据全在 `problem-filter`）。
   *
   * 三步都 memo（1025 批新增）：虚拟列表每滚一帧就要重算窗口，而 `items` 的进度 tick /
   * 面板自身 state 都会让组件重渲染——`filterProblems` + `groupProblems` 是 O(n)，
   * 2,600 条上每次提交白算两遍就是每帧的纯浪费。引用稳定同时让下游
   * `rows` / `offsets` / `vwin` 的 useMemo 真正生效（这是"滚动不掉帧"的地基）。
   */
  const activeFilter = useMemo(() => filterOfPrefs(filterPrefs), [filterPrefs]);
  const filtered = useMemo(() => filterProblems(items, activeFilter), [items, activeFilter]);
  const groups = useMemo(() => groupProblems(filtered), [filtered]);
  /** 扁平行清单 = **全量**（组头 + 未折叠组的行；折叠在投影层就减行，见 `problem-rows`） */
  const rows = useMemo(() => problemRowsOf(groups, collapsed), [groups, collapsed]);
  /** 组头数字走同一份派生（键 = 原始路径，与 `groupProblems` 的组键逐字同形） */
  const filteredSummary = useMemo(() => summarizeProblems(filtered), [filtered]);
  const filtering = isFiltering(activeFilter);
  /** 来源过滤下拉的选项（序 = 首次出现序；来源只有一种时不给下拉——没有第二个选项的开关是噪音） */
  const srcOpts = sourceOptions(items);
  const clearFilter = (): void => {
    setFilterPrefs({ severities: ALL_SEVERITIES, source: null, text: '' });
  };

  /* ------------------------- 虚拟列表：视口 → 渲染窗口 ------------------------- */

  /**
   * 行高的**真源是量出来的自然高度**（组头 25 / 问题行 22 @12px，随 `--fs-*` 缩放变）。
   * 写死常量会在字号缩放后把窗口算错；"行高相等"的假设又会从第一个组头之后开始漂。
   *
   * 住 ref 而不是 state：行高只参与**窗口计算**，不参与渲染（渲染只读 `vwin` 的留白），
   * 所以不需要为它再提交一帧——那一帧正是打开面板那个热路径上最不该多付的。
   */
  const heightsRef = useRef<ProblemRowHeights>(PROBLEM_ROW_HEIGHTS_FALLBACK);
  /**
   * 上一次量到的可见区（坐标相对列表顶边）。
   *
   * 为什么留一份：**新清单（过滤 / 折叠 / 诊断刷新）到达时那一帧也要画对**。渲染期不能
   * 去量布局（量一次就是一次强制 flush），只好拿"上次量到的可见区"当估算——估算对了，
   * `problemRowWindow` 随后算出的窗口与它同形，`sameProblemRowWindow` 直接吞掉那次
   * setState ⇒ **一次提交出结果**（与检索面板同法）。
   */
  const viewportRef = useRef<{ readonly top: number; readonly height: number } | null>(null);
  /**
   * 当前渲染窗口，记成"跟着哪份清单算的"（`rows` 身份）：换清单（过滤 / 折叠 / 诊断刷新）
   * ⇒ 立刻按缓存的可见区重算，绝不留上一份清单的窗口（那会把旧的行套到新结果上）。
   */
  const [vwinState, setVwinState] = useState<{
    readonly rows: readonly ProblemRow[];
    readonly win: ProblemRowWindow;
  } | null>(null);
  /** 上一次渲染**真的画出去**的窗口（`commitWindow` 据此判断"要不要再提交一帧"） */
  const renderedWinRef = useRef<ProblemRowWindow | null>(null);
  const vwin = useMemo<ProblemRowWindow>(() => {
    if (vwinState !== null && vwinState.rows === rows) return vwinState.win;
    // 首屏 / 量不到布局（服务端渲染、happy-dom）⇒ 画前 `PROBLEM_VROWS_FALLBACK` 条
    const vp = viewportRef.current;
    const { offsets, total } = problemRowOffsets(rows, heightsRef.current);
    if (vp === null) {
      const end = Math.min(rows.length, PROBLEM_VROWS_FALLBACK);
      return { start: 0, end, topPad: 0, bottomPad: total, total };
    }
    return problemRowWindow(offsets, vp.top, vp.height, PROBLEM_VROW_OVERSCAN_PX);
  }, [rows, vwinState]);
  // 记下这一帧画出去的窗口（纯记账，不参与渲染决策；供 `commitWindow` 判"同形"）
  renderedWinRef.current = vwin;
  /** 写窗口（同形不写：滚动时大量帧的窗口根本没变，这一条省掉的是每帧一次 setState） */
  const commitWindow = useCallback(
    (win: ProblemRowWindow) => {
      if (renderedWinRef.current !== null && sameProblemRowWindow(renderedWinRef.current, win)) return;
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
   * 59,000px 高的滚动容器上，一次强制 flush 是实打实的钱。
   */
  const computeWindow = useCallback(() => {
    const list = listRef.current;
    if (list === null) return;
    // —— 读：两档行高（已挂载的行是自然高度，面板不下发行高）+ 各层 rect
    const groupH = list.querySelector('.prob-vrow-group')?.getBoundingClientRect().height ?? 0;
    const itemH = list.querySelector('.prob-item')?.getBoundingClientRect().height ?? 0;
    const listRect = list.getBoundingClientRect();
    const headRect = headRef.current?.getBoundingClientRect() ?? null;
    const scroller = scrollParentOf(list);
    const scRect = scroller?.getBoundingClientRect() ?? null;
    // —— 算
    const prev = heightsRef.current;
    const heights: ProblemRowHeights = {
      group: groupH > 0 ? groupH : prev.group,
      item: itemH > 0 ? itemH : prev.item,
    };
    if (Math.abs(heights.group - prev.group) > 0.01 || Math.abs(heights.item - prev.item) > 0.01) {
      heightsRef.current = heights;
    }
    const { offsets, total } = problemRowOffsets(rows, heightsRef.current);
    const headBottom = headRect === null ? listRect.top : headRect.bottom;
    // 可见区 = 列表区 ∩（可滚动祖先 / 视口）再扣掉 sticky 控制区挡住的那一段
    const viewportTop =
      scRect === null ? Math.max(listRect.top, headBottom) : Math.max(listRect.top, scRect.top, headBottom);
    const viewportBottom = scRect === null ? listRect.bottom : Math.min(listRect.bottom, scRect.bottom);
    const height = viewportBottom - viewportTop;
    // 缓存给"下一份清单到达时那一帧"用（相对列表顶边，与滚动位置无关）
    viewportRef.current = { top: viewportTop - listRect.top, height: Math.max(0, height) };
    let next: ProblemRowWindow;
    if (!(height > 0) || !(listRect.height > 0)) {
      // 量不到布局（服务端渲染 / happy-dom）或列表整个在视口外：退回首屏 N 条
      const end = Math.min(rows.length, PROBLEM_VROWS_FALLBACK);
      next = { start: 0, end, topPad: 0, bottomPad: total, total };
    } else {
      next = problemRowWindow(offsets, viewportTop - listRect.top, height, PROBLEM_VROW_OVERSCAN_PX);
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
   * 窗口重算：**只在清单 / 导航目标变化后**跑一次（不是每次提交都跑）。
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
    // 滚动事件不冒泡，但**捕获**相能拿到全部后代滚动容器（底栏滚的是祖先，不是列表自己）
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    /**
     * 底栏是**可拖高**的（`.bottombar` 上直接写 inline height）：拉高 / 拉低既不产生
     * `scroll` 也不产生 `window.resize`，窗口就会停在旧高度上——列表下方留一段空白
     * （实测从 170px 拉到 590px 留 171px）。观察滚动容器自己的尺寸，量到变化就重算。
     * 观察的是**祖先**而不是 `.prob-list`：列表高度本身就是窗口的产物，观察它会
     * 变成"写一帧 → 观察回调 → 再量一帧"的自激环。
     */
    const scroller = listRef.current === null ? null : scrollParentOf(listRef.current);
    const ro =
      typeof ResizeObserver === 'undefined' || scroller === null
        ? null
        : new ResizeObserver(() => onScroll());
    if (ro !== null && scroller !== null) ro.observe(scroller);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      ro?.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [computeWindow]);

  /** 问题行在扁平清单里的位置（行导航按**绝对序号**走，DOM 序只覆盖窗口） */
  const itemRowFlat = useMemo(() => problemItemRowIndex(rows), [rows]);
  /** 扁平行下标 → 该行是第几条问题（-1 = 组头）；渲染时给每行贴号 */
  const ordinalOf = useMemo(() => problemOrdinalMap(rows), [rows]);
  /**
   * 行导航落定：窗口里已经有那一行了就聚焦（`open` = F4，顺手敲它自己的 onClick）。
   * 放在 layout effect 里：`navTarget` 一变，这一帧的窗口已经把它带进来了才对得上号。
   */
  useLayoutEffect(() => {
    if (navTarget === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-panel-row][data-prob-ordinal="${navTarget}"]`,
    );
    if (el === undefined || el === null) return; // 窗口还没跟上：下一次提交再试
    el.focus();
    if (navPendingOpen.current) el.click();
    navPendingOpen.current = false;
    setNavTarget(null);
  }, [navTarget, vwin.start, vwin.end]);

  /**
   * 过滤尺一换，**滚回列表头**（旧实现的"窗口回到首帧上界"在虚拟列表里的等价物）。
   *
   * 不这么做的话：作者在 600 条深处打了个过滤词，新清单只有 5 行，滚动位置被浏览器
   * 夹到末尾——屏幕上是一小截尾部，看起来像"过滤出一条都没有"。这里直接把容器滚到
   * 列表顶边（扣掉 sticky 头），与"换一把尺就重新从第一屏看"同一个意思。
   */
  const prevFilterSigRef = useRef<string>(prefsSignature(filterPrefs));
  useEffect(() => {
    const sig = prefsSignature(filterPrefs);
    if (prevFilterSigRef.current === sig) return;
    prevFilterSigRef.current = sig;
    const list = listRef.current;
    if (list === null) return;
    const scroller = scrollParentOf(list);
    if (scroller === null) return;
    const headH = headRef.current?.getBoundingClientRect().height ?? 0;
    const top =
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - headH;
    scroller.scrollTo({ top: Math.max(0, top) });
  }, [filterPrefs]);

  const showFlash = (key: string, text: string): void => {
    setFlash({ key, text });
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 1_800);
  };

  /**
   * 一条问题行有没有**唯一解**行内修复（判据与缓存见模块头）。
   * 宿主座缺席 / 文件没开 ⇒ `undefined` = 不给按钮（可见的"没能力"，非死按钮）。
   */
  const rowFixAction = (p: EditorProblem): EditorCodeAction | undefined => {
    const host = readProblemFixHost();
    if (!host) return undefined;
    const doc = host.documentOf(p.path);
    if (!doc) return undefined;
    const version = currentVersion();
    const key = rowFixKey(p);
    const hit = fixCacheRef.current.get(key);
    const contribs = host.codeActionContributions();
    if (
      hit &&
      hit.version === version &&
      hit.docVersionId === doc.versionId &&
      hit.contribLen === contribs.length &&
      hit.textLen === doc.text.length
    ) {
      return hit.action;
    }
    const action = collectRowFix(contribs, {
      path: p.path,
      text: doc.text,
      project: host.project(),
      lineCount: doc.lineCount,
      line: p.line,
      diagnostic: problemLineDecoration(p),
    });
    if (fixCacheRef.current.size > 2_000) fixCacheRef.current.clear();
    fixCacheRef.current.set(key, {
      version,
      docVersionId: doc.versionId,
      contribLen: contribs.length,
      textLen: doc.text.length,
      action,
    });
    return action;
  };

  /** 行内修复落地：带 `edits` 走改写计划（一次撤销步），否则退回 `run` 语义 */
  const applyFix = (p: EditorProblem, action: EditorCodeAction): void => {
    const host = readProblemFixHost();
    if (!host) return;
    const key = rowFixKey(p);
    if (action.edits && action.edits.length > 0) {
      const doc = host.documentOf(p.path);
      if (!doc) {
        showFlash(key, '落地失败：文件已不在打开的标签里');
        return;
      }
      const planned = planLineEdits(doc.lineCount, action.edits);
      fixCacheRef.current.delete(key); // 落地即文本要变，缓存条目作废（版本指纹也会变，双保险）
      void host
        .applyRowFix(p.path, planned)
        .then((ok) =>
          showFlash(key, ok ? '已应用修复（Ctrl+Z 可撤）' : '落地失败：文件已不在打开的标签里'),
        )
        .catch((e: unknown) => showFlash(key, `落地失败：${errorText(e)}`));
      return;
    }
    void Promise.resolve(
      action.run({ project: host.project(), activeFile: p.path, line: p.line }),
    )
      .then(() => showFlash(key, '已执行动作'))
      .catch((e: unknown) => showFlash(key, `动作失败：${errorText(e)}`));
  };

  /**
   * 写剪贴板 + 回执（复制消息 / 复制全部共用）：成败都说一句，不静默。
   *
   * `key` = 回执挂在哪儿（行键 ⇒ 那一行；`'panel'` ⇒ 汇总行）——菜单动作没有自己的
   * 落点，回执位置就是它唯一的"我收到了"。
   */
  const writeClipboard = (key: string, text: string, okText: string): void => {
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) {
        showFlash(key, '复制失败：当前环境没有剪贴板能力');
        return;
      }
      void clipboard.writeText(text).then(
        () => showFlash(key, okText),
        () => showFlash(key, '复制失败：剪贴板拒绝了这次写入'),
      );
    } catch (e: unknown) {
      showFlash(key, `复制失败：${errorText(e)}`);
    }
  };

  /** 复制消息：文案判据在 `problemCopyText`（纯函数）；成败都有反馈（不静默） */
  const copyProblem = (p: EditorProblem): void => {
    // 回执挂在**这一行**（`rowFixKey`）：此前用的 `copy\0…` 前缀与渲染侧的判等键对不上，
    // 行内「复制」按下去永远看不到回执（菜单动作同样会哑掉）
    writeClipboard(rowFixKey(p), problemCopyText(p), '已复制到剪贴板');
  };

  /** 复制全部：文案逐条走同一个 `problemCopyText`（不另写一份格式） */
  const copyAllProblems = (): void => {
    if (items.length === 0) {
      showFlash('panel', COPY_ALL_DISABLED_REASON);
      return;
    }
    writeClipboard('panel', items.map((p) => problemCopyText(p)).join('\n'), `已复制 ${items.length} 条问题`);
  };

  /** 菜单里的快速修复：与行内「修复」按钮同一条判据与落地路径 */
  const quickFixProblem = (p: EditorProblem): void => {
    const action = rowFixAction(p);
    if (action === undefined) {
      showFlash(rowFixKey(p), '这条问题没有唯一解修复');
      return;
    }
    applyFix(p, action);
  };

  /* ---------------------- 右键菜单面（1023 覆盖面批 · WP3.2） ---------------------- */

  /**
   * 每次提交后刷新菜单上下文（无依赖 = 每次渲染后重灌）。
   *
   * 面板会随底部面板切换反复挂载，而面是模块级注册的（重复声明会告警）——所以面只声明
   * 一次（见 `problem-menu`），这里只把"此刻有哪些通道 + 动作落在哪"换新。卸载不清空：
   * 面只认 DOM 上的 `data-context-surface="problems"`，面板没了，菜单也走不到这里。
   */
  useEffect(() => {
    setProblemsMenuContext({
      capabilities: {
        canCopy:
          typeof navigator !== 'undefined' &&
          typeof navigator.clipboard?.writeText === 'function',
      },
      handlers: {
        reveal: (p) => onReveal(p.path, p.line, problemRevealSpan(p)),
        quickFix: quickFixProblem,
        copyProblem,
        // 「按此码过滤」只改文本这一维（严重级 / 来源保持原样：菜单项说的是码，不是整把尺）
        filterByCode: (code) => setFilterPrefs((cur) => ({ ...cur, text: code })),
        copyAll: copyAllProblems,
        clearFilter,
      },
      // 行身份 → 问题本体：路径 + 行 + 码（码可能为空串，与 DOM 属性同一口径）
      problemAt: (path, line, code) =>
        items.find(
          (p) => p.path === path && p.line === line && (p.code ?? '') === code,
        ) ?? null,
      // 唯一解判据与行内「修复」按钮同一条：有解才给菜单项，没解整项不显示
      quickFixAvailable: (p) => rowFixAction(p) !== undefined,
      itemCount: () => items.length,
      filtering: () => filtering,
    });
  });

  /**
   * 一条问题行。
   *
   * `flatIndex` = 它在**扁平清单**里的下标（`data-prob-index`，切片自检用）；
   * `ordinal` = 它是第几条问题（`data-prob-ordinal`，行导航按这个绝对序号跨窗口走）；
   * `globalIndex` = 过滤后全序下标（渲染 key 与回执键的一部分，窗口换了也不变）。
   */
  const renderRow = (p: EditorProblem, flatIndex: number, ordinal: number, globalIndex: number): ReactElement => {
    // ZH-D2：码位第一眼给**中文短名**，原码逐字留在悬停 title——真源在契约层
    // （`plugin-api/diagnostic-copy.ts`），本面板**不自带映射**（两处口径必分叉）。
    const code = p.code ? diagnosticDisplay(p.code) : null;
    const fixAction = rowFixAction(p);
    const rowKey = rowFixKey(p);
    return (
      <li
        key={`${rowKey}:${globalIndex}`}
        className="prob-item"
        data-prob-index={flatIndex}
        // 右键菜单的行身份（1023 覆盖面批）：只存"是哪一条"，问题本体由面的上下文回查
        data-problem-row=""
        data-problem-path={p.path}
        data-problem-line={p.line}
        data-problem-code={p.code ?? ''}
      >
        <button
          className="conv-issue-btn prob-row"
          data-panel-row=""
          data-prob-ordinal={ordinal}
          // 严重级只以 CSS 自定义属性下传一次（圆点 + hover 导轨共用它），值仍取自
          // `SEVERITY_TINT` 那一份——面板不自带色值（静态闸 `problem-truth-single-source` 钉着）。
          style={{ '--prob-tint': SEVERITY_COLOR[p.severity] } as CSSProperties}
          title={`${p.path}:${p.line}`}
          onClick={() => onReveal(p.path, p.line, problemRevealSpan(p))}
        >
          <span className="conv-dot" />
          <span className="conv-issue-loc dim">
            {shortPath(p.path)}:{p.line}
          </span>
          <span className="conv-issue-msg">{p.message}</span>
          {code ? (
            <code className="prob-code dim" title={code.title}>
              {code.name}
            </code>
          ) : null}
        </button>
        <span className="prob-row-actions">
          {fixAction ? (
            <button
              type="button"
              className="ghost small prob-fix"
              title={`唯一解行内修复：${fixAction.title}`}
              onClick={() => applyFix(p, fixAction)}
            >
              修复
            </button>
          ) : null}
          <button
            type="button"
            className="ghost small prob-copy"
            title={`复制消息：${problemCopyText(p)}`}
            onClick={() => copyProblem(p)}
          >
            复制
          </button>
        </span>
        {flash !== null && flash.key === rowKey ? (
          <span className="prob-flash" role="status">
            {flash.text}
          </span>
        ) : null}
      </li>
    );
  };

  const toggleGroup = (path: string): void => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /**
   * 行导航（↑↓ 移焦点 / F4·F8 移过去并打开）在**虚拟列表**上的落地。
   *
   * 旧版直接调 `applyPanelRowNav`：它按**已挂载的 DOM 行**取名单，而虚拟列表只挂几十行
   * ⇒ 走到窗口末尾时会长回第一行（`nextRovingIndex` 的回绕），F4 / ↑↓ 从此再也走不到
   * 窗口外的那一条。所以"该去哪一行"仍交给同一份判据（`rowNavDecision`：键位语义、回绕、
   * 下拉框让位全在那一处，本文件不改语义），只是名单换成**全量问题行**（`itemRowFlat`）：
   *   - 目标行已在窗口里 ⇒ 直接聚焦（与旧行为逐字相同）；
   *   - 目标行在窗口外 ⇒ 记成 `navTarget`，渲染时把窗口撑过去，下一帧再聚焦
   *     （`focus()` 自己会把它滚进视口）。
   * 返回 `true` = 这一下已消费。
   */
  const handleRowNav = (e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    const target = e.target as { closest?: (sel: string) => Element | null } | null;
    if (typeof target?.closest !== 'function') return false;
    const owner = target.closest('[data-panel-row]');
    const current = owner === null ? -1 : Number((owner as HTMLElement).dataset.probOrdinal ?? '-1');
    const decision = rowNavDecision({
      key: e.key,
      shiftKey: e.shiftKey,
      current,
      count: itemRowFlat.length,
      inField: target.closest('select, textarea') !== null,
    });
    if (decision === null) return false;
    if (itemRowFlat[decision.index] === undefined) return false;
    e.preventDefault();
    navPendingOpen.current = decision.open;
    const mounted = listRef.current?.querySelector<HTMLElement>(
      `[data-panel-row][data-prob-ordinal="${decision.index}"]`,
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

  return (
    <div
      className="panel-problems prob"
      // 右键面（1023 覆盖面批）：行由 `data-problem-row` 认领；汇总行 / 空白区出面板级菜单；
      // 过滤框与勾选框由 `problem-menu` 主动让给全局输入框面（粘贴/全选在那一面）
      data-context-surface="problems"
      // 行导航（1020 编辑器体感批）：↑↓ 逐条看，F8/Shift+F8 跳过去并当场打开。
      // 焦点在编辑器里时这一对键仍归 Monaco 的 `marker.nextInFiles`（见「键盘快捷键」页的内建组）；
      // 焦点落到本面板时由这里按**过滤后的可见列表**代跳——被筛掉的条不该用键跳过去。
      // 回车定位不另接线：每一行本身就是 `<button data-panel-row>`，焦点在行上时
      // Enter / Space 由浏览器的按钮语义直接触发它的 `onClick`（同一条跳源通道），
      // 这里再补一次 click 反而会跳两回。
      onKeyDown={(e) => {
        // 名单是全量问题行（`itemRowFlat`），不是已挂载的 DOM 行：虚拟列表只挂窗口内的
        // 几十行，按 DOM 名单走会从窗口末尾回绕到第一行（见 `handleRowNav`）。
        handleRowNav(e);
      }}
    >
      {header.kind === 'empty' ? (
        <div className="conv-empty prob-empty dim">
          未发现问题
          <Icon name="check" size={13} className="prob-empty-icon" />
        </div>
      ) : (
        // 表头 + 工具条合成一块 sticky 头：列表的滚动交回容器（`.container-body`）之后，
        // 过滤条件与三档读数必须常驻，否则"滚下去就找不到那把尺了"（与 `ksp-head` 同一处理）。
        <div className="prob-head" ref={headRef}>
          <div className="conv-summary">
            <span className="conv-count" style={{ color: SEVERITY_COLOR.error }}>
              错误 {error}
            </span>
            <span className="conv-count" style={{ color: SEVERITY_COLOR.warning }}>
              警告 {warning}
            </span>
            <span className="conv-count" style={{ color: SEVERITY_COLOR.info }}>
              提示 {info}
            </span>
            {/* 面板级动作的回执（复制全部）：与行内回执同一个类，挂在汇总行 */}
            {flash !== null && flash.key === 'panel' ? (
              <span className="prob-flash" role="status">
                {flash.text}
              </span>
            ) : null}
          </div>
          <div className="prob-toolbar">
            {ALL_SEVERITIES.map((s) => (
              <label key={s} className="prob-sev-check">
                <KitCheck
                  checked={sevSel.includes(s)}
                  label={SEVERITY_LABEL[s]}
                  onChange={() =>
                    setFilterPrefs((cur) => ({
                      ...cur,
                      // 回填按契约固定序（勾选/取消都不重排工具条上的三个开关）
                      severities: cur.severities.includes(s)
                        ? cur.severities.filter((x) => x !== s)
                        : ALL_SEVERITIES.filter((x) => x === s || cur.severities.includes(x)),
                    }))
                  }
                />
                <span className="prob-sev-label" style={{ color: SEVERITY_COLOR[s] }}>
                  {SEVERITY_LABEL[s]}
                </span>
              </label>
            ))}
            {srcOpts.length > 1 ? (
              // 来源过滤（S14）：单一来源时不给下拉——只有一个选项的开关是噪音
              // 外观自绘（`appearance:none` + SVG 箭头 + token 化井面），选项语义与键盘行为仍归原生
              // `// ui-kit-candidate: KitSelect`（列表弹层仍由系统画；换全自绘要另写开合与键盘态）
              <span className="prob-select-wrap">
                <select
                  className="prob-filter prob-select"
                  aria-label="按诊断来源过滤问题"
                  title="按诊断来源过滤"
                  value={sourceSel === null ? ALL_SOURCES_VALUE : sourceSel}
                  onChange={(e) =>
                    setFilterPrefs((cur) => ({
                      ...cur,
                      source: e.target.value === ALL_SOURCES_VALUE ? null : e.target.value,
                    }))
                  }
                >
                  <option value={ALL_SOURCES_VALUE}>全部来源</option>
                  {srcOpts.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}（{o.count}）
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={12} className="prob-select-caret" />
              </span>
            ) : null}
            {/* 与检索面板的 `ksp-field` 同族：边框与焦点环画在井上，输入框自己无框 */}
            <span className="prob-field">
              <input
                className="prob-filter prob-input"
                type="text"
                value={filterText}
                placeholder={FILTER_INPUT_PLACEHOLDER}
                aria-label="按消息、诊断码、来源或路径过滤问题"
                onChange={(e) => setFilterPrefs((cur) => ({ ...cur, text: e.target.value }))}
              />
            </span>
            {filtering ? (
              <>
                <span className="prob-filtered-count dim">
                  筛出 {filtered.length}/{items.length}
                </span>
                <button type="button" className="ghost small prob-clear" onClick={clearFilter}>
                  清除过滤
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        items.length > 0 ? (
          // 过滤把所有条目筛光了：直说，不留一片"看起来空了"的谜（铁律 4）。
          // 与"根本没有问题"是两种空态：这里是「过滤后无结果」，顶部还有一枚「清除过滤」。
          <div className="conv-empty prob-empty-filtered dim">
            没有匹配过滤条件的问题（{items.length} 条被过滤隐藏，点「清除过滤」回到全部）
          </div>
        ) : null
      ) : (
        // 虚拟列表：只挂窗口内的行 + 上下留白。`paddingTop + Σ行高 + paddingBottom`
        // 恒等于全量行高之和（账本在 `problem-rows`）⇒ 滚动高度与"全量都画出来"逐像素一致，
        // 滚动条不撒谎、滚到底就是最后一条（不留半截空白）。
        //
        // 这里的 `<li>` 序列是**扁平的**：组头也是一项（`prob-vrow-group`）。虚拟窗口可以从
        // 任意一行开始（甚至从某个组的中段），嵌套的"组容器"在跨窗口截断时必然留下半截组。
        <ul
          ref={listRef}
          className="prob-list"
          data-prob-vrows={rows.length}
          style={{ paddingTop: vwin.topPad, paddingBottom: vwin.bottomPad }}
        >
          {rows.slice(vwin.start, vwin.end).map((row, i) => {
            const index = vwin.start + i;
            if (row.kind === 'item') {
              return renderRow(row.problem, index, ordinalOf[index]!, row.itemIndex);
            }
            const g = row.group;
            const isCollapsed = collapsed.has(g.path);
            // 组头数字来自 `filteredSummary`（与表头 / 状态栏 / 树徽标同一次遍历）；
            // `g.counts` 仍留在 `groupProblems` 的产物里供别处用，但**不再上屏**——
            // 上屏的第二把尺子就是分叉的开始。
            const gc = filteredSummary.byPath.get(g.path)!;
            return (
              <li
                key={`g:${g.path}`}
                // 组头兼作组分隔线（border 计入行高，账本量的是 rect，含它）；
                // 全量第 0 行不画线（顶线交给 sticky 头那条，不画双线）
                className={`prob-vrow-group${index === 0 ? ' prob-vrow-first' : ''}`}
                data-prob-index={index}
              >
                <button
                  type="button"
                  className="prob-group-head"
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? '展开这一组' : '折叠这一组'}
                  onClick={() => toggleGroup(g.path)}
                >
                  <span className="prob-group-caret" aria-hidden="true">
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                  </span>
                  <span className="prob-group-path" title={g.path}>
                    {g.label}
                  </span>
                  <span className="prob-group-counts">
                    {gc.error > 0 ? <SeverityCount severity="error" count={gc.error} /> : null}
                    {gc.warning > 0 ? (
                      <SeverityCount severity="warning" count={gc.warning} />
                    ) : null}
                    {gc.info > 0 ? <SeverityCount severity="info" count={gc.info} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 状态栏「问题」小件：订阅 problem-store，显示 `✕ n  ⚠ n  ℹ n`，点击打开问题面板。
 *
 * 配色口径与 `ui-convention-report` 的 `StatusCounts` 注释一致：**只给 error 上色**，
 * 其余走 dim——状态栏是常态计数，不该全量铺严重度色（否则视觉重量压过同排控件）。
 * 全为 0 时显示 dim 的「无问题」，不描红。
 *
 * **标签与计数同源同口径**（工包 E，2026-10-19）：可见标签 `{PROBLEM_SCOPE.label}` 与
 * tooltip 都取自 `problem-store`，计数取 `summarizeProblems(items).counts`——与面板表头、
 * 面板组头、文件树徽标是同一次派生的同一个数字。旧形态是标签写「本文件」、数字却是
 * **全部已打开文件的合并值**（活动文件换了，其余标签的诊断照旧留在计数里），
 * 那就是"三处三个口径"里最难发现的一处：读的人以为自己在看当前文件。
 * 按活动文件计数需要宿主把活动路径送进来（`ShellLayout` / `EditorPane` 不在本批独占集里），
 * 所以这一批让标签说实话，而不是给一个假口径。
 *
 * 同排那枚「项目级约定计数」数的是整份校验报告（含未打开文件与整项目结论），两数天生不等，
 * 各自的 tooltip 说清自己数的是什么（`styles-project.css` 给 `.sb-diag` 补「项目」标签，
 * 两簇之间有分隔线）。
 */
export function ProblemsStatusItem({ onClick }: { onClick: () => void }): ReactElement {
  const items = useProblems();
  const { error, warning, info } = summarizeProblems(items).counts;

  if (items.length === 0) {
    return (
      <button className="sb-problems" data-status-cell="" title={PROBLEM_SCOPE.title} onClick={onClick}>
        {/* 可见范围标签：同排左边那枚是「项目」（插件的 `.sb-diag`，标签由 CSS 补），
            这一枚数的是**已打开文件**的波浪线——不悬停也该一眼分清，中间由 CSS 画一道分隔。 */}
        <span className="sb-scope-tag">{PROBLEM_SCOPE.label}</span>
        <span className="dim">无问题</span>
      </button>
    );
  }

  return (
    <button className="sb-problems" data-status-cell="" title={PROBLEM_SCOPE.title} onClick={onClick}>
      <span className="sb-scope-tag">{PROBLEM_SCOPE.label}</span>
      <span className="sb-problems-item" style={error > 0 ? { color: SEVERITY_COLOR.error } : undefined}>
        ✕ {error}
      </span>
      <span className="sb-problems-item">⚠ {warning}</span>
      <span className="sb-problems-item">ℹ {info}</span>
    </button>
  );
}
