import { useEffect, useState, type ReactElement } from 'react';
import { diagnosticDisplay } from '@kojo/plugin-api';
import { snapshot, subscribe, type EditorProblem } from './problem-store';

/**
 * 底部「问题」面板（看板 HK-4 · UI-6）。
 *
 * 数据源 = `problem-store`（`EditorPane.refreshMarkers` 逐文件整份发布）：
 * `erb-parser`（结构类，error）与 `condition-extractor`（表达式类，warning）两层
 * 波浪线在此汇总成可展开的列表。每条可点击 → 经宿主回调跳源行（跳转通道由
 * ProjectView 走 `editor.revealLocation` 事件，见其内建视图接线）。
 *
 * 视觉与「约定校验」面板同族（复用 `.conv-summary` / `.conv-count` / `.conv-dot`
 * 等约定面板类），只补少量 `.prob-*`。
 */

/** 严重度配色：与 `ui-convention-report`、`.conv-dot` 同口径 */
const SEVERITY_COLOR: Record<EditorProblem['severity'], string> = {
  error: '#e06c75',
  warning: '#d19a66',
  info: '#7f9cc0',
};

/** 单列表最多渲染条数（与约定面板 `RENDER_CAP` 同精神：避免上万行 DOM 拖垮面板） */
const RENDER_CAP = 300;

/** 短路径口径（与 `ui-convention-report` 一致）：取末两段 */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

function useProblems(): readonly EditorProblem[] {
  const [items, setItems] = useState<readonly EditorProblem[]>(() => snapshot());
  useEffect(() => subscribe(() => setItems(snapshot())), []);
  return items;
}

export function ProblemPanel({ onReveal }: { onReveal: (path: string, line: number) => void }): ReactElement {
  const items = useProblems();

  let error = 0;
  let warning = 0;
  let info = 0;
  for (const it of items) {
    if (it.severity === 'error') error++;
    else if (it.severity === 'warning') warning++;
    else info++;
  }

  const header =
    items.length === 0
      ? ({ kind: 'empty' } as const)
      : ({ kind: 'counts', error, warning, info } as const);

  const shown = items.slice(0, RENDER_CAP);

  return (
    <div className="panel-problems">
      {header.kind === 'empty' ? (
        <div className="conv-empty dim">未发现问题 ✅</div>
      ) : (
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
        </div>
      )}

      {shown.length > 0 ? (
        <ul className="prob-list">
          {shown.map((it, i) => {
            // ZH-D2：码位第一眼给**中文短名**，原码逐字留在悬停 title——真源在契约层
            // （`plugin-api/diagnostic-copy.ts`），本面板**不自带映射**（两处口径必分叉）。
            const code = it.code ? diagnosticDisplay(it.code) : null;
            return (
              <li key={`${it.path}:${it.line}:${it.severity}:${i}`} className="prob-item">
                <button
                  className="conv-issue-btn"
                  title={`${it.path}:${it.line}`}
                  onClick={() => onReveal(it.path, it.line)}
                >
                  <span className="conv-dot" style={{ backgroundColor: SEVERITY_COLOR[it.severity] }} />
                  <span className="conv-issue-loc dim">
                    {shortPath(it.path)}:{it.line}
                  </span>
                  <span className="conv-issue-msg">{it.message}</span>
                  {code ? (
                    <code className="prob-code dim" title={code.title}>
                      {code.name}
                    </code>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {items.length > RENDER_CAP ? (
        <div className="conv-more dim">仅显示前 {RENDER_CAP} 条（共 {items.length} 条）</div>
      ) : null}
    </div>
  );
}

/**
 * 状态栏「问题」小件：订阅 problem-store，显示 `✕ n  ⚠ n  ℹ n`，点击打开问题面板。
 *
 * 配色口径与 `ui-convention-report` 的 `StatusCounts` 注释一致：**只给 error 上色**，
 * 其余走 dim——状态栏是项目级常态计数，不该全量铺严重度色（否则视觉重量压过同排控件）。
 * 全为 0 时显示 dim 的「无问题」，不描红。
 */
export function ProblemsStatusItem({ onClick }: { onClick: () => void }): ReactElement {
  const items = useProblems();

  if (items.length === 0) {
    return (
      <button className="sb-problems" title="问题面板 (Ctrl+Shift+M)" onClick={onClick}>
        <span className="dim">无问题</span>
      </button>
    );
  }

  let error = 0;
  let warning = 0;
  let info = 0;
  for (const it of items) {
    if (it.severity === 'error') error++;
    else if (it.severity === 'warning') warning++;
    else info++;
  }

  return (
    <button className="sb-problems" title="问题面板 (Ctrl+Shift+M)" onClick={onClick}>
      <span className="sb-problems-item" style={error > 0 ? { color: SEVERITY_COLOR.error } : undefined}>
        ✕ {error}
      </span>
      <span className="sb-problems-item">⚠ {warning}</span>
      <span className="sb-problems-item">ℹ {info}</span>
    </button>
  );
}
