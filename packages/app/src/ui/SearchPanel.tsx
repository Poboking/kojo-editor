import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { SearchMatch, SearchProgress, SearchResult } from '../bridge/search';
import { nextWindow, type RenderWindow } from '@kojo/plugin-api';
import { revealSpanOf, type RevealSpan } from '../monaco/reveal-position';
import { Icon } from './icons';
import {
  clearSearchResult,
  runReplace,
  runSearch,
  setExtensionText,
  setQuery,
  setReplaceText,
  setSearchScope,
  snapshot,
  stopSearch,
  subscribe,
  toggleOption,
  type SearchOptionsState,
  type SearchState,
} from './search-store';
import {
  DEFAULT_SEARCH_EXTENSIONS,
  flattenSearchResults,
  matchLocationLabel,
  parseExtensions,
  previewParts,
  searchNoticeText,
  searchProgressText,
  searchSummaryText,
  shortSearchPath,
  type SearchRow,
} from './search-query';
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
import '../search-panel.css';

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
 * 结果区的渲染窗口（PS-6 第 5 项：把"死顶"换成"可长"）。
 *
 * 旧实现 `flattenSearchResults(files, 300)` 是个**够不着的上限**：真实一次全项目检索
 * 出 2,870 条命中（真语料壳内读数，25 个文件），面板只画 300 行、其余 2,570 条
 * 一句"未列出"就把作者挡在外面——点不到、也 Tab 不到（内核铁律 4：不许静默）。
 *
 * 现在与仓里其余长列表同一把尺（契约层的 `RenderWindow`；文件树过滤窗、状态回放、
 * 糖预览共用同一套数学）：首帧上界 120 行（**比旧实现的 300 行还轻**），
 * 末尾那枚「继续显示」是一枚真 `<button>` ⇒ Tab 得到它、Enter 按得动，
 * 每次 +240 直到全量可达。折叠/分组形态一字未动。
 */
const SEARCH_WINDOW: RenderWindow = { initial: 120, step: 240 };
/** 首帧最多画多少行（导出给测试钉首帧行数） */
export const SEARCH_WINDOW_INITIAL = SEARCH_WINDOW.initial;

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
   */
  onReveal: (path: string, line: number, span?: RevealSpan) => void;
}

/** 单条命中行：主按钮跳转；行尾一枚替换钮（hover / focus-within 显形，键盘可达） */
function SearchMatchRow({
  path,
  match,
  replaceDisabled,
  onReveal,
  onReplace,
}: {
  path: string;
  match: SearchMatch;
  replaceDisabled: boolean;
  onReveal: SearchPanelProps['onReveal'];
  onReplace: () => void;
}): ReactElement {
  return (
    <div className="search-match-row ksp-row">
      <button
        type="button"
        className="search-match ksp-row-main"
        title={`${path}:${match.line}`}
        onClick={() => onReveal(path, match.line, searchMatchSpan(match))}
      >
        <span className="search-loc ksp-loc">{matchLocationLabel(match)}</span>
        <MatchPreview match={match} />
      </button>
      <button
        type="button"
        className="search-replace-one ksp-row-replace"
        title="替换这一处（文本已变化时会跳过并说明）"
        disabled={replaceDisabled}
        onClick={onReplace}
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
  const optionsBodyId = useId();
  const replaceRowId = useId();

  /** 替换行展开（UI 局部状态：VSCode 同构——默认收起，命令入口会自动展开） */
  const [replaceOpen, setReplaceOpen] = useState(false);
  /** 「选项」区展开（UI 局部状态；折叠只改 `display`，控件仍在 DOM，展开即用） */
  const [optionsOpen, setOptionsOpen] = useState(false);
  /** 折叠的文件块（key = path；局部状态，切视图卸载后回到全展开） */
  const [foldedFiles, setFoldedFiles] = useState<ReadonlySet<string>>(() => new Set());

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
   * 窗口挂在**这一份结果**上（与文件树过滤窗同一招）：换一次检索 ⇒ 结果对象换了身份
   * ⇒ 自动回落到首帧上界，不需要 `useEffect`、也不会出现"旧窗口套到新结果上"的中间帧。
   */
  const [resultWin, setResultWin] = useState<{ readonly key: SearchResult; readonly end: number } | null>(null);
  const windowEnd = resultWin?.key === result ? resultWin.end : SEARCH_WINDOW_INITIAL;
  /**
   * 结果行族的派生量（PS-15）全部 memo 化：`flattenSearchResults`（扁平化+截窗）与
   * `groupSearchRows` / `locationGutterCh`（分段+量列宽）只随**这一份结果**与窗口上界变。
   * 此前每次渲染重算一遍——输入框每打一个字（`s` 换新对象）、切一个文件折叠，
   * 全项目检索的上万行扁平化就白算一次。`rows` 引用稳定也顺带给下游
   * `useEffect` / 行组件的依赖比较省了一层。
   */
  const { rows, hidden } = useMemo(
    () => (result ? flattenSearchResults(result.files, windowEnd) : { rows: [], hidden: 0 }),
    [result, windowEnd],
  );
  /** 这批结果一共多少行（含没画的）：`flattenSearchResults` 的 `hidden` 就是差额 ⇒ 全量可达 */
  const totalRowCount = rows.length + hidden;
  const groups = useMemo(() => groupSearchRows(rows), [rows]);
  const gutterCh = useMemo(() => locationGutterCh(rows), [rows]);
  const progressPercent = searchProgressPercent(s.progress);

  /** 选择器**现在**显示的范围（陈旧 key 归一成 `''`）；与 `appliedScope`（结果的范围）不是一回事 */
  const selectedScope = findSearchScope(scopes, s.scopeKey);
  const selectedScopeKey = selectedScope === null ? '' : s.scopeKey;
  const staleScopeText = scopeStaleText(selectedScopeKey, s.appliedScope);
  const extensionSummary = extensionSummaryText(s.extensionText);

  const start = (): void => {
    // 范围收窄发生在发请求**之前**：扫描代价在原生侧，少扫就是少扫（不是全扫再挑）。
    const narrowing = narrowRoots(roots, selectedScope);
    void runSearch(narrowing.roots, describeAppliedScope(selectedScope, narrowing));
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

  const toggleFile = (path: string): void => {
    setFoldedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="panel-search ksp" role="search" aria-label="在文件中搜索">
      {/* 控制区 + 状态区：单面板侧栏里整块 sticky（结果滚走、条件与读数常驻） */}
      <div className="ksp-head">
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
            <Icon name={replaceOpen ? 'chevron-down' : 'chevron-right'} size={16} />
          </button>

          <div className="ksp-field">
            <input
              ref={inputRef}
              className="search-input ksp-input"
              placeholder="在文件中搜索…"
              title="回车开始检索（Ctrl+Shift+F）"
              aria-label="在文件中搜索"
              autoComplete="off"
              spellCheck={false}
              value={s.query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  start();
                }
              }}
            />
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
          </div>

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
              onClick={start}
            >
              <Icon name="search" size={14} />
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
              <Icon name={optionsOpen ? 'chevron-down' : 'chevron-right'} size={12} />
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

            {scopes.length > 0 ? (
              <label className="search-scope-row ksp-opt-row">
                <span className="ksp-opt-label">只看</span>
                <select
                  className="search-scope ksp-opt-select"
                  title="默认不限：整个项目加作者工作区一起搜。选定后只搜那一处，速度更快，但范围外的文件这一轮不会搜。"
                  // 陈旧 key（换过项目）按"不限"显示与生效，不猜
                  value={selectedScopeKey}
                  onChange={(e) => setSearchScope(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      start();
                    }
                  }}
                >
                  <option value="">全部目录</option>
                  {scopes.map((o) => (
                    <option key={o.key} value={o.key} title={o.detail || undefined}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        {scopeNotices.length > 0 ? (
          // 提供方抛错 / 候选非法：坏在明处（铁律 4），不静默少画几行候选
          <div className="search-status search-scope-notice ksp-note ksp-note-warn">
            {scopeNotices.join(' · ')}
          </div>
        ) : null}

        <div className="ksp-status-zone">
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
                >
                  {searchSummaryText(result)}
                </span>
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
              {s.appliedScope !== null ? (
                <div className="search-status ksp-note" title={scopeRootsTitle(s.appliedScope)}>
                  {scopeStatusText(s.appliedScope)}
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
              {s.appliedScope !== null && result.filesScanned === 0 ? (
                <div className="search-status search-scope-empty ksp-note ksp-note-warn">
                  {scopeEmptyText(s.appliedScope, result.skipped.filtered)}
                </div>
              ) : null}
              {searchNoticeText(result) !== null ? (
                <div className="search-status dim ksp-note">{searchNoticeText(result)}</div>
              ) : null}
              {staleScopeText !== null ? (
                <div className="search-status search-scope-stale ksp-note ksp-note-warn">
                  {staleScopeText}
                </div>
              ) : null}
              {hidden > 0 ? (
                // 读数是"这一屏画了多少"，不是"最多只能给你这么多"（下面结果区末尾那枚按钮才是入口）
                <div className="search-status dim ksp-note">
                  本屏显示前 {rows.length} 行 · 共 {totalRowCount} 行命中
                </div>
              ) : null}
            </>
          ) : (
            <div className="search-status dim ksp-hint">输入检索词后回车；点结果行跳转到该位置。</div>
          )}
        </div>
      </div>

      {/* 结果区：分组 + 文件头折叠。行号槽宽由本屏最长读数定（CSS 自定义属性，一处写全列表） */}
      {rows.length > 0 ? (
        <div
          className="search-rows ksp-results"
          style={{ '--ksp-gutter': String(gutterCh) } as CSSProperties}
        >
          {groups.map((g) => {
            const folded = foldedFiles.has(g.path);
            const { base, dir } = splitSearchPath(g.path);
            return (
              <div key={g.path} className="ksp-group">
                <button
                  type="button"
                  className="search-file ksp-file"
                  title={g.path}
                  aria-expanded={!folded}
                  onClick={() => toggleFile(g.path)}
                >
                  <span className="ksp-file-caret" aria-hidden="true">
                    <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={12} />
                  </span>
                  {/* 可读名 = 完整的末两段路径（AT 与静态渲染判据都吃这一条）；
                      视觉上拆成 文件名 + 目录（dim）两段，两段对 AT 隐藏，避免读两遍 */}
                  <span className="ksp-sr">{shortSearchPath(g.path)}</span>
                  <span className="ksp-file-base" aria-hidden="true">
                    {base}
                  </span>
                  {dir !== '' ? (
                    <span className="ksp-file-dir" aria-hidden="true">
                      {dir}
                    </span>
                  ) : null}
                  <span className="search-file-count ksp-file-count">{g.count}</span>
                </button>

                {folded
                  ? null
                  : g.matches.map((m, i) => (
                      <SearchMatchRow
                        key={`${g.path}:${m.line}:${m.column}:${i}`}
                        path={g.path}
                        match={m}
                        replaceDisabled={s.replaceRunning}
                        onReveal={onReveal}
                        onReplace={() => replaceOne(g.path, m)}
                      />
                    ))}
              </div>
            );
          })}
          {result !== null && hidden > 0 ? (
            /* 「继续显示」是一枚真按钮，挂在结果末尾（PS-6 第 5 项）：
               Tab 顺序就在最后一行之后、Enter 按得动、每按一次多画 STEP 行，
               按到没有为止 ⇒ 上一批"硬截 300 行"挡在外面的那两千条现在全部可达。 */
            <button
              type="button"
              className="ghost small ksp-more"
              onClick={() =>
                setResultWin({ key: result, end: nextWindow(windowEnd, totalRowCount, SEARCH_WINDOW) })
              }
            >
              继续显示后面的命中（还有 {hidden} 行）
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
