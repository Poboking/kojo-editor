import { createElement as h, useEffect, useState, type ReactElement } from 'react';
import { basename, nextWindow, windowSize, type RenderWindow } from '@kojo/plugin-api';
import type { ErbFunction, ErbIndex, ErbIndexState } from '@kojo/plugin-api';
import {
  callHierarchyIndexCopy,
  callHierarchyIndexTitle,
} from './index-state-copy';
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
   * 索引这一轮的**可查事实**（ST-CONSUMERS，**additive 可选**）：`erb.parser` 的
   * `indexState()` 原样转述，宿主不代判形状（判据单源 `erb-parser/index-state.ts`）。
   * 缺席 = 提供方是旧实现 ⇒ 那一格逐字退回原句。
   */
  indexState?(): ErbIndexState | null;
  /**
   * 位置 → 包围函数（三态语义见 `FunctionAtResolver`：命中 / `undefined` 权威答否 /
   * `null` 通道缺席 ⇒ 数据层退化索引自扫）。
   */
  functionAt(path: string, line: number): ErbFunction | null | undefined;
  reveal(path: string, line: number, column?: number): void;
  close(): void;
}

/**
 * 行清单的渲染窗口（PS-15）：与问题 / 检索面板**同一套契约参数**——首帧 `initial` 行，
 * 哨兵步进 `step` 行直到全量。旧实现是 `RENDER_CAP = 300` 的**死顶**：超过 300 行的
 * 调用清单永远看不全（"另有 N 行未列出"就是句告别）；窗口化后全量可达
 * （`windowSize` / `nextWindow` 契约见 `plugin-api/sugar-panels.ts`）。
 */
const CALL_HIERARCHY_WINDOW: RenderWindow = { initial: 120, step: 240 };
/** 首帧最多画多少行（导出供测试按它钉首帧行数） */
export const CALL_HIERARCHY_WINDOW_INITIAL = CALL_HIERARCHY_WINDOW.initial;

/** 一个 section（被调用 / 调用）一份窗口上界 + 哨兵的步进回调 */
interface SectionWindow {
  /** 首帧上界（请求换了身份 ⇒ 回落） */
  inEnd: number;
  outEnd: number;
  grow(which: 'in' | 'out', total: number): void;
}

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
    /**
     * 窗口挂在**这一次查看请求**上（与检索面板的结果窗口同一招）：换一次请求 ⇒
     * 请求对象换了身份 ⇒ 两个 section 各自回落首帧，不需要 `useEffect`、也不会
     * 出现"旧窗口套到新请求上"的中间帧。state 在 hook 之后再取，但窗口
     * useState 必须在提前 return **之前**（hook 顺序稳定是硬约束）。
     */
    const [win, setWin] = useState<{ key: CallHierarchyRequest | null; inEnd: number; outEnd: number }>({
      key: null,
      inEnd: CALL_HIERARCHY_WINDOW_INITIAL,
      outEnd: CALL_HIERARCHY_WINDOW_INITIAL,
    });
    const state = getCallHierarchyState();
    const requestKey = state !== null && state.kind !== 'rejected' ? state.request : null;
    const inEnd = win.key !== null && win.key === requestKey ? win.inEnd : CALL_HIERARCHY_WINDOW_INITIAL;
    const outEnd = win.key !== null && win.key === requestKey ? win.outEnd : CALL_HIERARCHY_WINDOW_INITIAL;
    const sectionWindow: SectionWindow = {
      inEnd,
      outEnd,
      grow: (which, total) =>
        setWin((cur) => {
          if (requestKey === null) return cur;
          const step = nextWindow(which === 'in' ? inEnd : outEnd, total, CALL_HIERARCHY_WINDOW);
          return which === 'in' ? { key: requestKey, inEnd: step, outEnd: cur.outEnd } : { key: requestKey, inEnd: cur.inEnd, outEnd: step };
        }),
    };

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

    return renderRequest(state.request, deps, closeBtn, sectionWindow);
  };
}

function renderRequest(
  request: CallHierarchyRequest,
  deps: CallHierarchyDeps,
  closeBtn: ReactElement,
  sectionWindow: SectionWindow,
): ReactElement {
  // 索引这一轮的事实（ST-CONSUMERS）：查表得到的那一句**只在既有文案面**上替换原文，
  // 不给本面板新开显示面；查表交回 `null` ⇒ 逐字用回改前那两句。
  const indexState = deps.indexState?.() ?? null;
  const blockedCopy = callHierarchyIndexCopy(indexState);
  const blockedTitle = callHierarchyIndexTitle(indexState);
  /** 那一格 `p.dim`（两个面共用一枚构造函数，字符串只有一处） */
  const notice = (text: string): ReactElement =>
    h('p', blockedTitle === undefined ? { className: 'dim' } : { className: 'dim', title: blockedTitle }, text);

  const index = deps.currentIndex();
  if (!index) {
    return h(
      'div',
      { className: 'wizard kd-host' },
      h('h3', null, '调用层级'),
      notice(blockedCopy ?? 'ERB 函数索引未建（索引随项目打开自动构建，稍后再试）。'),
      closeBtn,
    );
  }
  const target = resolveEnclosingFunction(index, deps.functionAt, request.filePath, request.line);
  if (!target) {
    // 「第 N 行不在任何函数体内」只在**本轮确实扫出了东西**时才成立：一个位置都没走到 /
    // 扫过但名录为空时，那句是把"索引没内容"污蔑成"你把光标放错了"（同一张表判的相位）
    if (blockedCopy !== null) {
      return h(
        'div',
        { className: 'wizard kd-host' },
        h('h3', null, '调用层级'),
        notice(blockedCopy),
        closeBtn,
      );
    }
    return h(
      'div',
      { className: 'wizard kd-host' },
      h('h3', null, '调用层级'),
      notice(
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

  const section = (heading: string, emptyText: string, rows: Row[], which: 'in' | 'out'): ReactElement[] => {
    const out: ReactElement[] = [];
    if (!referencesAvailable) return out;
    out.push(h('h4', { key: `${heading}:h` }, heading));
    if (rows.length === 0) {
      out.push(h('p', { key: `${heading}:e`, className: 'dim' }, emptyText));
      return out;
    }
    const limit = which === 'in' ? sectionWindow.inEnd : sectionWindow.outEnd;
    const shown = rows.slice(0, windowSize(rows.length, limit, CALL_HIERARCHY_WINDOW));
    const hiddenRows = rows.length - shown.length;
    // 行样式复用检索面板的通用行类（search-rows / search-match / search-loc）——
    // 同一形态的清单视图，不为它开第二份 CSS。
    out.push(h('div', { key: `${heading}:rows`, className: 'search-rows' }, rowsToElements(heading, shown, deps)));
    if (hiddenRows > 0) {
      // 哨兵是一枚 <button>（与问题面板同一形态）：Tab 得到它、Enter 按得动，
      // 点一次多画 STEP 行——不再是"另有 N 行未列出"的告别（RENDER_CAP 死顶已除）
      out.push(
        h(
          'button',
          {
            key: `${heading}:more`,
            className: 'ghost small conv-more',
            onClick: () => sectionWindow.grow(which, rows.length),
          },
          `继续显示后面的行（还有 ${hiddenRows} 行，共 ${rows.length} 行）`,
        ),
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
      'in',
    ),
    ...section(
      `调用（${outgoing.length} 个目标 · ${outgoingCallCount} 处）`,
      '函数体内没有 CALL 直系族调用（或目标不在函数索引里）。',
      outgoingRows,
      'out',
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
