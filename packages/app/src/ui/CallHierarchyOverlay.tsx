import { createElement as h, useEffect, useState, type ReactElement } from 'react';
import { basename } from '@kojo/plugin-api';
import type { ErbFunction, ErbIndex } from '@kojo/plugin-api';
import {
  incomingCalls,
  outgoingCalls,
  resolveEnclosingFunction,
  type CallSite,
} from '../monaco/erb-call-hierarchy';
import {
  getCallHierarchyState,
  subscribeCallHierarchy,
  type CallHierarchyRequest,
} from './call-hierarchy';
import { referenceTallyFor, subscribeReferenceTally } from './reference-tally-store';

/**
 * 调用层级 overlay（2026-10-16 批 E）——「这个函数被谁调用 / 它调用谁」的只读查询面板。
 *
 * 形态照 `DiffViewOverlay` / `FileHistoryOverlay` 同款（工厂注依赖 + 模块级状态单源）。
 * 判定与收集全在 `monaco/erb-call-hierarchy.ts`（纯函数，假索引可单测），本组件只做
 * 展示与跳转：行点击 → 注入的 `reveal`（宿主落成既有的 `editor.revealLocation`，
 * 与转到定义同一条导航通道），**零写操作**。
 *
 * 跳不出 Monaco Peek 的原因（取舍记档案）：Monaco standalone 无 CallHierarchy API
 * （PITFALLS §83），面板形态是审查过的替代而非降级——调用层级天然是"一次看全"
 * 的清单视图，列表比 peek 弹窗承载得多。
 *
 * **处数不是这里数的**（W8 收口的第二判据）：面板头的「被调用 · N 处」读
 * `ui/reference-tally-store` 里 F12 那一次计算的 `tally.nonDefinitionCount`，
 * 差值解释直接交回 `explainReferenceCounts` 的原文（文案也只有一份真源）。
 * 本面板自己那份 `incomingCalls` 只用来**列清单**（哪个调用者、哪一处点位），
 * 组行的「k 处」是"这位调用者名下的点位行数"——列表的形状数据，不是第二把尺子。
 * 没有读数（这个名字还没按过 F12）就明说"处数未读"，不拿清单长度冒充台账读数。
 */

export interface CallHierarchyDeps {
  /** 当前 ERB 索引（`null` = 未建 / 服务缺席；软取不抛） */
  currentIndex(): ErbIndex | null;
  /**
   * 位置 → 包围函数（三态语义见 `FunctionAtResolver`：命中 / `undefined` 权威答否 /
   * `null` 通道缺席 ⇒ 数据层退化索引自扫）。
   */
  functionAt(path: string, line: number): ErbFunction | null | undefined;
  reveal(path: string, line: number, column?: number): void;
  close(): void;
}

/** 最多渲染多少行（与检索面板同精神：上万行 DOM 会拖垮面板） */
const RENDER_CAP = 300;

type Row =
  | { kind: 'group'; label: string; count: number; path: string; line: number; title: string }
  | { kind: 'site'; site: CallSite };

/** 把一组出入边折成扁平行序列（组行 = 跳定义，点位行 = 跳调用处），便于统一截断 */
function flatten(
  groups: ReadonlyArray<{ name: string; path: string; startLine: number; sites: readonly CallSite[] }>,
): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    rows.push({
      kind: 'group',
      label: g.name,
      count: g.sites.length,
      path: g.path,
      line: g.startLine,
      title: `${g.path}:${g.startLine}`,
    });
    for (const site of g.sites) {
      rows.push({ kind: 'site', site });
    }
  }
  return rows;
}

function siteLabel(site: CallSite): string {
  return `${basename(site.filePath)}:${site.line}:${site.column}`;
}

function locLabel(path: string, line: number): string {
  return `${basename(path)}:${line}`;
}

export function createCallHierarchyOverlay(deps: CallHierarchyDeps): () => unknown {
  return function CallHierarchyOverlay(): unknown {
    const [, setTick] = useState(0);
    // 两路都要订：请求态（谁被查看）+ 台账读数（这个名字被 F12 查过之后数才落地）
    useEffect(() => {
      const unsubscribeRequest = subscribeCallHierarchy(() => setTick((t) => t + 1));
      const unsubscribeTally = subscribeReferenceTally(() => setTick((t) => t + 1));
      return () => {
        unsubscribeRequest();
        unsubscribeTally();
      };
    }, []);
    const state = getCallHierarchyState();

    const closeBtn = h(
      'div',
      { className: 'wizard-actions' },
      h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
    );

    if (state === null) {
      return h('div', { className: 'wizard kd-host' }, h('p', { className: 'dim' }, '没有要查看的调用。'), closeBtn);
    }
    if (state.kind === 'rejected') {
      return h(
        'div',
        { className: 'wizard kd-host' },
        h('h3', null, '无法查看调用层级'),
        h('p', { className: 'kd-error' }, state.reason),
        closeBtn,
      );
    }

    return renderRequest(state.request, deps, closeBtn);
  };
}

function renderRequest(request: CallHierarchyRequest, deps: CallHierarchyDeps, closeBtn: ReactElement): ReactElement {
  const index = deps.currentIndex();
  if (!index) {
    return h(
      'div',
      { className: 'wizard kd-host' },
      h('h3', null, '调用层级'),
      h('p', { className: 'dim' }, 'ERB 函数索引未建（索引随项目打开自动构建，稍后再试）。'),
      closeBtn,
    );
  }
  const target = resolveEnclosingFunction(index, deps.functionAt, request.filePath, request.line);
  if (!target) {
    return h(
      'div',
      { className: 'wizard kd-host' },
      h('h3', null, '调用层级'),
      h(
        'p',
        { className: 'dim' },
        `第 ${request.line} 行不在任何 ERB 函数体内（或该文件不在函数索引里）——把光标放到某个 @ 函数的正文中再试。`,
      ),
      closeBtn,
    );
  }

  const referencesAvailable = index.references !== undefined;
  const incoming = referencesAvailable ? incomingCalls(index, deps.functionAt, target.normalizedName) : [];
  const outgoing = referencesAvailable ? outgoingCalls(index, target) : [];
  const incomingRows = flatten(
    incoming.map((g) => ({
      name: g.caller.name,
      path: g.caller.filePath,
      startLine: g.caller.startLine,
      sites: g.sites,
    })),
  );
  const outgoingRows = flatten(
    outgoing.map((g) => ({
      name: g.callee.name,
      path: g.callee.filePath,
      startLine: g.callee.startLine,
      sites: g.sites,
    })),
  );
  // 入边**处数**只从台账读数取（F12 那一次计算的 `nonDefinitionCount` 投影）；
  // 清单本身（哪些调用者、哪些点位）仍是本面板的视图数据。
  const incomingTally = referencesAvailable ? referenceTallyFor(target.filePath, target.normalizedName) : null;
  const incomingCountText = incomingTally === null ? '处数未读' : `${incomingTally.tally.nonDefinitionCount} 处`;
  const outgoingCallCount = outgoing.reduce((n, g) => n + g.sites.length, 0);

  const section = (heading: string, emptyText: string, rows: Row[]): ReactElement[] => {
    const out: ReactElement[] = [];
    if (!referencesAvailable) return out;
    out.push(h('h4', { key: `${heading}:h` }, heading));
    if (rows.length === 0) {
      out.push(h('p', { key: `${heading}:e`, className: 'dim' }, emptyText));
      return out;
    }
    const shown = rows.slice(0, RENDER_CAP);
    // 行样式复用检索面板的通用行类（search-rows / search-match / search-loc）——
    // 同一形态的清单视图，不为它开第二份 CSS。
    out.push(h('div', { key: `${heading}:rows`, className: 'search-rows' }, rowsToElements(heading, shown, deps)));
    if (rows.length > shown.length) {
      out.push(
        h('p', { key: `${heading}:cap`, className: 'dim' }, `仅显示前 ${RENDER_CAP} 行（另有 ${rows.length - shown.length} 行未列出）`),
      );
    }
    return out;
  };

  return h(
    'div',
    { className: 'wizard kd-host' },
    h('h3', null, '调用层级'),
    h(
      'p',
      null,
      h('span', null, `${target.name}　`),
      h(
        'button',
        {
          className: 'ghost small',
          title: `转到定义：${target.filePath}:${target.startLine}`,
          onClick: () => deps.reveal(target.filePath, target.startLine, 1),
        },
        `@ ${locLabel(target.filePath, target.startLine)}`,
      ),
    ),
    ...section(
      `被调用（${incoming.length} 个调用者 · ${incomingCountText}）`,
      '索引里没有别的函数调用它。',
      incomingRows,
    ),
    ...section(
      `调用（${outgoing.length} 个目标 · ${outgoingCallCount} 处）`,
      '函数体内没有 CALL 直系族调用（或目标不在函数索引里）。',
      outgoingRows,
    ),
    // 差值那句话交回 `explainReferenceCounts` 的原文（文案真源只有一份，面板不另写一份）；
    // 还没读数就明说"没读过"，不拿清单行数冒充台账读数（宁缺毋错）
    referencesAvailable
      ? incomingTally === null
        ? h(
            'p',
            { className: 'dim', key: 'tally' },
            '「被调用」的处数与 F12 出自同一份台账读数：在这个函数上按一次 F12（查找引用）即可接入；还没读过就留空，不拿清单行数冒充。',
          )
        : h('p', { className: 'dim', key: 'tally' }, incomingTally.explanation)
      : null,
    !referencesAvailable
      ? h('p', { className: 'dim', key: 'no-refs' }, '反向引用索引缺席（解析器未构建 references），出入边不可用。')
      : null,
    closeBtn,
  );
}

function rowsToElements(heading: string, shown: readonly Row[], deps: CallHierarchyDeps): ReactElement[] {
  return shown.map((row, i) => {
    if (row.kind === 'group') {
      return h(
        'button',
        {
          key: `g:${heading}:${i}`,
          className: 'search-match',
          title: `转到定义：${row.title}`,
          onClick: () => deps.reveal(row.path, row.line, 1),
        },
        h('span', { className: 'search-loc' }, row.label),
        h('span', { className: 'dim' }, `${row.count} 处`),
      );
    }
    const site = row.site;
    return h(
      'button',
      {
        key: `s:${heading}:${i}`,
        className: 'search-match',
        title: `${site.filePath}:${site.line}:${site.column}`,
        onClick: () => deps.reveal(site.filePath, site.line, site.column),
      },
      h('span', { className: 'search-loc' }, `↳ ${siteLabel(site)}`),
    );
  });
}
