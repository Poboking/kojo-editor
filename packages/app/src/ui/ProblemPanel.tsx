import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import {
  diagnosticDisplay,
  errorText,
  shortPath,
  nextWindow,
  type RenderWindow,
} from '@kojo/plugin-api';
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
import { applyPanelRowNav } from './panel-row-nav';
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
  type ProblemGroup,
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
 *    过滤后序列的首次出现序（判据与理由见 `groupProblems`）。折叠是**纯视觉**：
 *    渲染窗口按全局过滤序列裁剪，不因折叠而重排——折叠的组少画几行，窗口推进
 *    的口径不变（哨兵数字永远说的是全局序列）。
 * 2. **过滤**：严重级多选 + 来源（单选，来源清单见 `sourceOptions`）+ 文本子串（判据在
 *    `filterProblems`；默认全开 + 全部来源 + 空文本 = 与旧版逐字一致）。过滤条件一变，
 *    窗口回到首帧上界（换了一把尺就重新从第一屏看起，旧窗口深度对新结果没有意义）。
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
 * 问题列表的渲染窗口（PS-6 第 5 项：把"死顶"换成"可长"；1025 性能批改口径）。
 *
 * 旧实现硬截 300 条 + 一句「仅显示前 300 条（共 N 条）」——第 301 条**没有任何入口可达**，
 * 全项目校验一轮报上千条时，作者看到的就是一个到不了的谎（内核铁律 4：不许静默）。
 * 现在与仓里其余面板同一把尺（`plugin-api` 的 `RenderWindow`）：点一次哨兵 +step，直到全量可达。
 *
 * ## 1025 性能批：预算单位从「行」改成「条目（组头也算一条）」
 *
 * 真机实测（eratw 语料 2,633 条 / 62 个文件分组，调试宿 CDP 探针）：打开面板最长帧
 * **137ms**、两条长任务（124 / 77ms），一次提交建 **2,533** 个 DOM 节点。拆开看：
 * 每行 8 个节点 × 120 行 = 960，**每个组头 26 个节点 × 62 = 1,612**——旧注释里
 * 「组头成本可忽略」是错的：三枚计数徽标（`.prob-count` = span + SVG path + 数字腿 +
 * 读数腿）比一行还重三倍，62 个组头就吃掉了首帧六成预算。
 *
 * 于是预算改成**条目**：组头 1 条、行 1 条，同一个预算里排队——首帧上界 60 条
 * （典型形态 ≈ 1 个组头 + 59 行 ≈ 500 节点，最坏形态全组头 ≈ 1,020 节点，两头都在
 * 800/1,200 的目标内），点哨兵按 step 增长。代价是「所有组头恒可见」这条旧口径
 * 退成「窗口内可见」：62 个组头本身就要 1,612 节点，跟"首帧只建最小可见集"直接冲突，
 * 而这批的判据是体感（不卡），不是"组头一屏看全"。**可达性一根没掉**——哨兵照旧
 * 是一枚 `<button>`（Tab 得到、Enter 按得动），点到底就是全量。
 *
 * 首帧 60 条是按实测定的：底栏 `.container-body` 可视高约 170px、每行 22px ⇒ 一屏 7–8 行，
 * 60 条（约 8 屏）足够"扫一眼 + 往下滚两下"而不至于拉一下就到底；再大就把首帧又喂回长任务。
 *
 * **调这个数前先算代价**（1025 批裁决：保留 60，但不许后人拍脑袋抬）：`initial` 是**条目数**
 * （组头也占额），代价近似**每 10 条 ≈ 80 节点**（10 行 = 80；若这 10 条全是组头则 ≈ 260）。
 * 底栏被用户拉高（可视 400px+）时确实会显得"一屏就没了"，但那属于"把底栏拉多大"的偏好，
 * 不是首帧预算该背的账——抬高它会把打开面板那一条长任务又养回来。
 */
const PROBLEM_WINDOW: RenderWindow = { initial: 60, step: 120 };
/** 首帧最多画多少条**条目**（旧导出名沿用：测试与面板按它钉首帧上界） */
export const PROBLEM_WINDOW_INITIAL = PROBLEM_WINDOW.initial;

/**
 * 增窗的分片粒度（条目数）：哨兵 / 滚动增窗一次要加 `step` 条，但**一帧只建 40 条**
 * （≈ 320 节点），余下的在 `requestIdleCallback`（无该 API 时退回 `setTimeout(0)`）
 * 里接着补。一批建完 = 一次大提交 = 一条长任务，那正是本批要消掉的东西。
 */
const ENTRY_CHUNK = 40;

/** 一次「该画哪些条目」的纯判据产物（`planVisibleEntries` 的返回；可单测） */
export interface ProblemEntryPlan {
  /** 全部条目数（每组 1 条组头 + 未折叠组的每行 1 条） */
  readonly totalEntries: number;
  /** 本帧实际画出的条目数 */
  readonly shownEntries: number;
  /** 本帧实际画出的行数（哨兵的「还有 N 条」说行数，不说条目数——作者数的是问题） */
  readonly shownRows: number;
  /** 本帧要画的分组（预算用尽的那些组不在名单里，也不再占节点） */
  readonly groups: readonly {
    readonly group: ProblemGroup;
    readonly rows: readonly { readonly idx: number; readonly p: EditorProblem }[];
  }[];
}

/**
 * 分组 + 折叠集 + 条目预算 → 这一帧到底画什么（**纯函数**，不碰 React / DOM）。
 *
 * 组头与行在同一条预算里排队，按组序逐条扣（组序 = 过滤后首次出现序，见 `groupProblems`）。
 * 折叠组的行不占预算（它们本来就不画），于是"折叠一切"会立刻把预算全让给组头。
 */
export function planVisibleEntries(
  groups: readonly ProblemGroup[],
  collapsed: ReadonlySet<string>,
  budget: number,
): ProblemEntryPlan {
  let totalEntries = 0;
  for (const g of groups) totalEntries += 1 + (collapsed.has(g.path) ? 0 : g.items.length);
  let used = 0;
  let shownRows = 0;
  const out: { group: ProblemGroup; rows: { idx: number; p: EditorProblem }[] }[] = [];
  for (const g of groups) {
    if (used >= budget) break;
    used += 1; // 组头
    const rows: { idx: number; p: EditorProblem }[] = [];
    if (!collapsed.has(g.path)) {
      const room = Math.max(0, budget - used);
      for (let i = 0; i < g.items.length && i < room; i++) {
        rows.push({ idx: g.indices[i]!, p: g.items[i]! });
      }
    }
    used += rows.length;
    shownRows += rows.length;
    out.push({ group: g, rows });
  }
  return { totalEntries, shownEntries: used, shownRows, groups: out };
}

/**
 * 哨兵那枚按钮的**文案**（纯函数）：分片补齐中与"真的到底等下一次点击"必须是两种话说。
 *
 * 为什么这不是性能问题而是诚实性问题（1025 批裁决第 3 条）：分片把"一次提交建 120 条"
 * 摊成三帧，于是从点下到补齐有几十毫秒里，列表**看起来**已经到底而实际还在长。若这期间
 * 仍写「继续显示后面的问题（还有 N 条）」，读到的是"你点了没反应、还是那一句"，作者会
 * 以为按钮坏了；写成补齐中文案 + `aria-busy`，再自动收敛到终态（补齐后
 * `windowEnd === windowTarget` ⇒ `filling` 自落），才既说真话又不骗手。
 */
export function moreButtonText(state: {
  readonly filling: boolean;
  readonly hiddenRows: number;
  readonly hiddenEntries: number;
  readonly total: number;
}): string {
  if (state.filling) return `正在补齐后面的问题…（还剩 ${state.hiddenEntries} 条待上屏）`;
  // 说人话用行数（作者数的是问题）；只差组头时（全部组都折叠着）改说"分组"
  if (state.hiddenRows > 0) {
    return `继续显示后面的问题（还有 ${state.hiddenRows} 条，共 ${state.total} 条）`;
  }
  return `继续显示后面的文件分组（还有 ${state.hiddenEntries} 组）`;
}

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
   * 窗口的**已提交**条目数（渲染按它裁；分片补窗时一帧只推进 `ENTRY_CHUNK` 条）。
   * 旧实现只有 `windowEnd` 一个数——点一次哨兵一帧建完 240 行，等于把首帧的长任务
   * 原样搬到第二次点击上；拆成"意图 / 已提交"两个数才分得开片。
   */
  const [windowEnd, setWindowEnd] = useState<number>(PROBLEM_WINDOW.initial);
  /** 窗口的**目标**条目数（点哨兵涨这里；分片泵把它追平后自己停下） */
  const [windowTarget, setWindowTarget] = useState<number>(PROBLEM_WINDOW.initial);
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
  /** 列表区（行导航只在这一段里找行：过滤框与勾选框不参与漫游，见 `panel-row-nav`） */
  const listRef = useRef<HTMLUListElement>(null);

  // 过滤尺一换，窗口回到首帧上界（旧深度对新结果没有意义）
  useEffect(() => {
    setWindowEnd(PROBLEM_WINDOW.initial);
    setWindowTarget(PROBLEM_WINDOW.initial);
  }, [filterPrefs]);

  /**
   * 分片补窗：`windowTarget > windowEnd` 时，每次空闲（`requestIdleCallback`；
   * 没有该 API 的环境退回 `setTimeout(0)`）补 `ENTRY_CHUNK` 条，直到追平。
   *
   * 为什么要 rIC 而不是 `requestAnimationFrame`：这一批补的是**屏外的行**，
   * 与下一帧画面无关——rIC 会把活儿塞进浏览器的空闲段，滚动 / 输入优先；rAF 则会
   * 抢在下一帧前跑，帧预算只有 16.7ms，补满 120 条正好把它撑爆。
   * 卸载即取消（标签切走 / 面板关掉时不留半截定时器）。
   */
  useEffect(() => {
    if (windowEnd >= windowTarget) return;
    const host = globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let cancelled = false;
    let idle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = (): void => {
      if (cancelled) return;
      setWindowEnd((cur) => Math.min(windowTarget, cur + ENTRY_CHUNK));
    };
    if (typeof host.requestIdleCallback === 'function') {
      // timeout 兜底：一直有活干（滚动 / 输入）时也必须补齐，否则哨兵按了没反应
      idle = host.requestIdleCallback(step, { timeout: 200 });
    } else {
      timer = setTimeout(step, 0);
    }
    return () => {
      cancelled = true;
      if (idle !== null && typeof host.cancelIdleCallback === 'function') host.cancelIdleCallback(idle);
      if (timer !== null) clearTimeout(timer);
    };
  }, [windowEnd, windowTarget]);

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

  /** 面板态 → 纯判据（严重级集合 / 来源集合 / 文本；判据全在 `problem-filter`） */
  const activeFilter = filterOfPrefs(filterPrefs);
  const filtered = filterProblems(items, activeFilter);
  const groups = groupProblems(filtered);
  /**
   * 这一帧该画什么（条目预算，判据见 `planVisibleEntries`）。
   * 组头与行同队排队 ⇒ 首帧不再一次建 62 个组头 + 120 行。
   */
  const plan = planVisibleEntries(groups, collapsed, windowEnd);
  /** 还差多少条目没画（0 = 全量到屏，不出哨兵） */
  const hiddenEntries = plan.totalEntries - plan.shownEntries;
  /** 还差多少**行**（哨兵说人话用行数；只差组头时那句话改说"分组"） */
  const hiddenRows = filtered.length - plan.shownRows;
  /**
   * 分片补齐中（已提交 < 目标）：哨兵换一套文案，补齐后自动收敛（判据见 `moreButtonText`）。
   * 过滤尺一换两个数一起回落，这里自然为 false。
   */
  const filling = windowEnd < windowTarget;
  /** 组头数字走同一份派生（键 = 原始路径，与 `groupProblems` 的组键逐字同形） */
  const filteredSummary = summarizeProblems(filtered);
  const filtering = isFiltering(activeFilter);
  /** 来源过滤下拉的选项（序 = 首次出现序；来源只有一种时不给下拉——没有第二个选项的开关是噪音） */
  const srcOpts = sourceOptions(items);
  const clearFilter = (): void => {
    setFilterPrefs({ severities: ALL_SEVERITIES, source: null, text: '' });
  };

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

  const renderRow = (p: EditorProblem, globalIndex: number): ReactElement => {
    // ZH-D2：码位第一眼给**中文短名**，原码逐字留在悬停 title——真源在契约层
    // （`plugin-api/diagnostic-copy.ts`），本面板**不自带映射**（两处口径必分叉）。
    const code = p.code ? diagnosticDisplay(p.code) : null;
    const fixAction = rowFixAction(p);
    const rowKey = rowFixKey(p);
    return (
      <li
        key={`${rowKey}:${globalIndex}`}
        className="prob-item"
        // 右键菜单的行身份（1023 覆盖面批）：只存"是哪一条"，问题本体由面的上下文回查
        data-problem-row=""
        data-problem-path={p.path}
        data-problem-line={p.line}
        data-problem-code={p.code ?? ''}
      >
        <button
          className="conv-issue-btn prob-row"
          data-panel-row=""
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
        applyPanelRowNav(listRef.current, e);
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
        <div className="prob-head">
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
        <ul ref={listRef} className="prob-list">
          {plan.groups.map(({ group: g, rows }) => {
            const isCollapsed = collapsed.has(g.path);
            // 组头数字来自 `filteredSummary`（与表头 / 状态栏 / 树徽标同一次遍历）；
            // `g.counts` 仍留在 `groupProblems` 的产物里供别处用，但**不再上屏**——
            // 上屏的第二把尺子就是分叉的开始。
            const gc = filteredSummary.byPath.get(g.path)!;
            return (
              <li key={g.path} className="prob-group">
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
                {rows.length > 0 ? (
                  <ul className="prob-group-rows">
                    {rows.map(({ p, idx }) => renderRow(p, idx))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {hiddenEntries > 0 ? (
        // 哨兵在末尾：Tab 得到它、Enter 按得动；点一次把**目标**抬 step 条，分片泵
        // 一帧补 `ENTRY_CHUNK` ——— 连点几下也只是把目标抬高，不会有一次性大提交。
        // `filling`（已提交 < 目标）期间换一套文案 + `aria-busy`：补齐中别让作者以为"点了没反应"。
        <button
          type="button"
          className="ghost small conv-more prob-more"
          aria-busy={filling}
          onClick={() =>
            setWindowTarget((cur) => nextWindow(cur, plan.totalEntries, PROBLEM_WINDOW))
          }
        >
          {moreButtonText({
            filling,
            hiddenRows,
            hiddenEntries,
            total: filtered.length,
          })}
        </button>
      ) : null}
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
