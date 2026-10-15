import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { SearchMatch } from '../bridge/search';
import {
  clearSearchResult,
  runSearch,
  setExtensionText,
  setQuery,
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
  onReveal: (path: string, line: number, column: number) => void;
}

export function SearchPanel({ roots, onReveal }: SearchPanelProps): ReactElement {
  const s = useSearchState();
  const inputRef = useRef<HTMLInputElement>(null);

  // 挂载即聚焦；快捷键/命令再次命中（focusNonce 变化）也重新聚焦并全选——
  // 这是"Ctrl+Shift+F 就该能直接打字"的那一步（面板可能早就开着）。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [s.focusNonce]);

  const result = s.result;
  const { rows, hidden } = result
    ? flattenSearchResults(result.files, RENDER_CAP)
    : { rows: [], hidden: 0 };

  const start = (): void => {
    void runSearch(roots);
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
          <div className={`search-status ${result.cancelled ? 'search-stopped' : ''}`}>
            {searchSummaryText(result)}
          </div>
          {searchNoticeText(result) !== null ? (
            <div className="search-status dim">{searchNoticeText(result)}</div>
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
              <button
                key={`m:${row.path}:${i}`}
                className="search-match"
                title={`${row.path}:${row.match.line}`}
                onClick={() => onReveal(row.path, row.match.line, row.match.column)}
              >
                <span className="search-loc dim">{matchLocationLabel(row.match)}</span>
                <MatchPreview match={row.match} />
              </button>
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
