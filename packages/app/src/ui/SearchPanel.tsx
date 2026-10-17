import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { SearchMatch } from '../bridge/search';
import { revealSpanOf, type RevealSpan } from '../monaco/reveal-position';
import {
  clearSearchResult,
  requestReplaceFocus,
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
  flattenSearchResults,
  matchLocationLabel,
  previewParts,
  searchNoticeText,
  searchProgressText,
  searchSummaryText,
  shortSearchPath,
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

/**
 * 侧栏「在文件中搜索」面板（2026-10-15 全文检索批）。
 *
 * 落点取舍 = **宿主内建视图**（与 `ProblemPanel` / `problem-store` 同族），不做成
 * `ui.panel` 插件：检索要调的是**宿主专属原生命令**（`search_text`，见 Rust 侧），
 * 而插件只许依赖 `@kojo/plugin-api`——为一个宿主能力去扩 `PlatformBridge` 契约，
 * 等于让四个桥实现（tauri / node / 两处测试桩）跟着改；且"搜整个项目"是工作台级
 * 能力（VSCode 里搜索也在 workbench，不在 extension host），与插件的领域贡献不同层。
 *
 * 结果行点击走既有 `editor.revealLocation`（与问题面板同一条通道，宿主 App.tsx 落地）。
 * 状态全在 `search-store`（模块级）：侧栏切走面板会卸载，结果必须活得比面板久。
 */

/** 最多渲染多少行（与问题面板同精神：上万行 DOM 会拖垮面板） */
const RENDER_CAP = 300;

/** 两个列表 props 的缺省值：模块级常量，默认参数每次渲染新建数组会丢掉引用稳定性 */
const EMPTY_SCOPES: readonly SearchScopeItem[] = [];
const EMPTY_NOTICES: readonly string[] = [];

function useSearchState(): SearchState {
  const [s, setS] = useState<SearchState>(() => snapshot());
  useEffect(() => subscribe(() => setS(snapshot())), []);
  return s;
}

/** 开关按钮（正则在左、大小写居中、全词在右——固定顺序，不随状态漂） */
const TOGGLES: ReadonlyArray<{ key: keyof SearchOptionsState; label: string; title: string }> = [
  { key: 'caseSensitive', label: 'Aa', title: '区分大小写' },
  { key: 'isRegex', label: '.*', title: '正则表达式' },
  { key: 'wholeWord', label: '全词', title: '全词匹配' },
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

export function SearchPanel({
  roots,
  scopes = EMPTY_SCOPES,
  scopeNotices = EMPTY_NOTICES,
  onReveal,
}: SearchPanelProps): ReactElement {
  const s = useSearchState();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // 挂载即聚焦；快捷键/命令再次命中（focusNonce 变化）也重新聚焦并全选——
  // 这是"Ctrl+Shift+F 就该能直接打字"的那一步（面板可能早就开着）。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [s.focusNonce]);

  // 「在文件中替换」命令命中（replaceFocusNonce 变化）：聚焦替换框并全选。
  // 挂载时记住当时已在的 nonce：只响应**此后**的请求——否则侧栏切走再切回来，
  // 一次历史请求会把焦点从检索框抢到替换框（控件还没碰就换落点 = 闹鬼）。
  const seenReplaceNonce = useRef(s.replaceFocusNonce);
  useEffect(() => {
    if (s.replaceFocusNonce === seenReplaceNonce.current) return;
    seenReplaceNonce.current = s.replaceFocusNonce;
    const el = replaceInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [s.replaceFocusNonce]);

  const result = s.result;
  const { rows, hidden } = result
    ? flattenSearchResults(result.files, RENDER_CAP)
    : { rows: [], hidden: 0 };
  /** 选择器**现在**显示的范围（陈旧 key 归一成 `''`）；与 `appliedScope`（结果的范围）不是一回事 */
  const selectedScopeKey = findSearchScope(scopes, s.scopeKey) ? s.scopeKey : '';
  const staleScopeText = scopeStaleText(selectedScopeKey, s.appliedScope);

  const start = (): void => {
    // 范围收窄发生在发请求**之前**：扫描代价在原生侧，少扫就是少扫（不是全扫再挑）。
    const scope = findSearchScope(scopes, s.scopeKey);
    const narrowing = narrowRoots(roots, scope);
    void runSearch(narrowing.roots, describeAppliedScope(scope, narrowing));
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

  return (
    <div className="panel-search">
      <div className="search-bar">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="在文件中搜索…"
          title="回车开始检索（Ctrl+Shift+F）"
          value={s.query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              start();
            }
          }}
        />
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            className={`search-toggle ${s.options[t.key] ? 'on' : ''}`}
            title={t.title}
            aria-pressed={s.options[t.key]}
            onClick={() => toggleOption(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 替换行（R7 搜索替换批）：VSCode 同构——检索行下一条替换输入行，Enter = 全部替换。
          空替换串 = 删除命中（合法操作，不拦截）。$1 引用捕获组，$& = 整个命中。 */}
      <div className="search-bar">
        <input
          ref={replaceInputRef}
          className="search-input"
          placeholder="替换为…（空 = 删除；$1 引用捕获组）"
          title="支持 $1–$99 引用正则捕获组；$& = 整个命中；$$ = 字面 $。回车 = 全部替换。"
          value={s.replaceText}
          onChange={(e) => setReplaceText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              replaceAll();
            }
          }}
        />
        <button
          className="search-toggle"
          title="全部替换：结果里的每个文件都按当前文本逐处替换"
          disabled={
            result === null || s.replaceRunning || result.truncated || result.cancelled || s.phase !== 'done'
          }
          onClick={replaceAll}
        >
          全部替换
        </button>
      </div>

      <div className="search-ext-row">
        <span className="dim">类型</span>
        <input
          className="search-ext"
          title="扩展名，逗号分隔；留空 = 不限扩展名"
          value={s.extensionText}
          onChange={(e) => setExtensionText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              start();
            }
          }}
        />
      </div>

      {scopes.length > 0 ? (
        <div className="search-scope-row">
          <label className="dim" htmlFor="search-scope-select">
            只看
          </label>
          <select
            id="search-scope-select"
            className="search-scope"
            title="默认不限：整个项目加作者工作区一起搜。选定后只搜那一处，速度更快，但范围外的文件这一轮不会搜。"
            // 陈旧 key（换过项目）按"不限"显示与生效，不猜
            value={findSearchScope(scopes, s.scopeKey) ? s.scopeKey : ''}
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
        </div>
      ) : null}

      {scopeNotices.length > 0 ? (
        // 提供方抛错 / 候选非法：坏在明处（铁律 4），不静默少画几行候选
        <div className="search-status search-scope-notice">{scopeNotices.join(' · ')}</div>
      ) : null}

      <div className="search-actions">
        {s.phase === 'running' ? (
          <button className="small" onClick={() => void stopSearch()}>
            停止
          </button>
        ) : (
          <button className="primary small" onClick={start}>
            搜索 <span className="hint">Ctrl+Shift+F</span>
          </button>
        )}
        {result !== null || s.error !== null ? (
          <button className="ghost small" onClick={clearSearchResult}>
            清空
          </button>
        ) : null}
      </div>

      {s.phase === 'running' ? (
        <div className="search-status dim">
          {s.progress ? searchProgressText(s.progress) : '检索中…'}
        </div>
      ) : s.error !== null ? (
        <div className="search-status search-error">{s.error}</div>
      ) : result !== null ? (
        <>
          {s.appliedScope !== null ? (
            <div className="search-status dim" title={scopeRootsTitle(s.appliedScope)}>
              {scopeStatusText(s.appliedScope)}
            </div>
          ) : null}
          <div className={`search-status ${result.cancelled ? 'search-stopped' : ''}`}>
            {searchSummaryText(result)}
          </div>
          {s.replaceSummary !== null ? (
            <div className="search-status search-replace-summary" title={s.replaceSummary}>
              {s.replaceSummary}
            </div>
          ) : null}
          {s.appliedScope !== null && result.filesScanned === 0 ? (
            <div className="search-status search-scope-empty">
              {scopeEmptyText(s.appliedScope, result.skipped.filtered)}
            </div>
          ) : null}
          {searchNoticeText(result) !== null ? (
            <div className="search-status dim">{searchNoticeText(result)}</div>
          ) : null}
          {staleScopeText !== null ? (
            <div className="search-status search-scope-stale">{staleScopeText}</div>
          ) : null}
        </>
      ) : (
        <div className="search-status dim">输入检索词后回车；点结果行跳转到该位置。</div>
      )}

      {rows.length > 0 ? (
        <div className="search-rows">
          {rows.map((row, i) =>
            row.kind === 'file' ? (
              // 文件头不是按钮：点它没有"跳转到某行"的语义，做成可点只会误导
              <div key={`f:${row.path}:${i}`} className="search-file" title={row.path}>
                <span className="search-file-name">{shortSearchPath(row.path)}</span>
                <span className="search-file-count dim">{row.count}</span>
              </div>
            ) : (
              // 单条命中行：主按钮跳转；行尾一枚替换钮（hover/focus-within 显形，
              // 键盘可达——Tab 到它即可替换当前这条，与 VSCode 的行内替换钮同构）
              <div key={`m:${row.path}:${i}`} className="search-match-row">
                <button
                  className="search-match"
                  title={`${row.path}:${row.match.line}`}
                  onClick={() => onReveal(row.path, row.match.line, searchMatchSpan(row.match))}
                >
                  <span className="search-loc dim">{matchLocationLabel(row.match)}</span>
                  <MatchPreview match={row.match} />
                </button>
                <button
                  className="search-replace-one"
                  title="替换这一处（文本已变化时会跳过并说明）"
                  disabled={s.replaceRunning}
                  onClick={() => replaceOne(row.path, row.match)}
                >
                  替换
                </button>
              </div>
            ),
          )}
        </div>
      ) : null}

      {hidden > 0 ? (
        <div className="search-status dim">仅显示前 {RENDER_CAP} 行（另有 {hidden} 行未列出）</div>
      ) : null}
    </div>
  );
}
