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
  CALL_HIERARCHY_SURFACE_ID,
  CALL_HIERARCHY_MENU_IDS,
  buildCallHierarchyMenu,
  callChainText,
  callSiteLocationText,
  getCallHierarchyState,
  readCallHierarchyMenuInput,
  setCallHierarchyState,
  subscribeCallHierarchy,
  type CallHierarchyMenuInput,
  type CallHierarchyRequest,
} from './call-hierarchy';
import { declareContextSurface } from './context-surfaces';
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
  | {
      kind: 'group';
      label: string;
      count: number;
      path: string;
      line: number;
      title: string;
      /** 这一组名下的全部点位（右键「复制调用链」直接从这里拼，不再二次查询） */
      sites: readonly CallSite[];
    }
  | { kind: 'site'; site: CallSite; group: string };

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
      sites: g.sites,
    });
    for (const site of g.sites) {
      rows.push({ kind: 'site', site, group: g.name });
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

/* ------------------------------ 右键菜单（WP3.4） ------------------------------ */

/** 剪贴板入口（缺席 ⇒ null：复制项禁用并说清原因，不假装能复制） */
function clipboardApi(): Clipboard | null {
  return typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null);
}

/**
 * 面 ↔ 组件之间的动作桥。
 *
 * 面在**模块顶层**声明（`build` 读不到 React 闭包），所以把"这一屏此刻的回调"放在
 * 这里：每次渲染后刷新一次，卸载时只撤自己那一份（不会把后来者的桥拆掉）。
 */
interface CallHierarchyFaceBridge {
  readonly clipboardAvailable: boolean;
  run(id: string, input: CallHierarchyMenuInput): void;
}

let faceBridge: CallHierarchyFaceBridge | null = null;

declareContextSurface({
  id: CALL_HIERARCHY_SURFACE_ID,
  ariaLabel: '调用层级菜单',
  area: 'panel',
  build: ({ target }) => {
    const bridge = faceBridge;
    if (bridge === null) return null;
    const input = readCallHierarchyMenuInput(target, { clipboardAvailable: bridge.clipboardAvailable });
    const menu = buildCallHierarchyMenu(input);
    if (menu === null) return null;
    return { items: menu.items, onSelect: (id) => bridge.run(id, input) };
  },
});

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

    /** 复制反馈（成败都要上屏——剪贴板拒绝时静默等于"点了没反应"，铁律 4） */
    const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
    const copyToClipboard = (text: string, doneNote: string): void => {
      const clip = clipboardApi();
      if (clip === null) {
        setNotice({ tone: 'err', text: '复制失败：当前环境没有可用的剪贴板' });
        return;
      }
      void clip.writeText(text).then(
        () => setNotice({ tone: 'ok', text: doneNote }),
        () => setNotice({ tone: 'err', text: '复制失败：剪贴板拒绝了这次写入' }),
      );
    };

    /**
     * 右键菜单的动作桥（每次渲染后刷新）。菜单项**只做入口**：
     * 跳转 → `deps.reveal`（与行点击同一条导航），重定查询 → `setCallHierarchyState`
     * （命令面板开这一屏走的就是这条通道），展开更多行 → 两个 section 既有的窗口步进。
     * 刷新 = 把同一份请求再声明一次 ⇒ 订阅表重画并重读索引（不新造取数通道）。
     */
    useEffect(() => {
      const entry: CallHierarchyFaceBridge = {
        clipboardAvailable: clipboardApi() !== null,
        run: (id, input) => {
          const row = input.row;
          switch (id) {
            case CALL_HIERARCHY_MENU_IDS.jump:
              if (row !== null) deps.reveal(row.path, row.line, row.column ?? 1);
              return;
            case CALL_HIERARCHY_MENU_IDS.recenter:
              if (row !== null) {
                setCallHierarchyState({ kind: 'request', request: { filePath: row.path, line: row.line } });
              } else if (input.subject !== null) {
                setCallHierarchyState({
                  kind: 'request',
                  request: { filePath: input.subject.path, line: input.subject.line },
                });
              }
              return;
            case CALL_HIERARCHY_MENU_IDS.copyChain:
              if (row !== null) copyToClipboard(callChainText(row), '已复制调用链');
              return;
            case CALL_HIERARCHY_MENU_IDS.copyLocation:
              if (row !== null) copyToClipboard(callSiteLocationText(row), '已复制位置');
              return;
            case CALL_HIERARCHY_MENU_IDS.copyList:
              copyToClipboard(input.listText, '已复制调用清单');
              return;
            case CALL_HIERARCHY_MENU_IDS.expandIn:
              sectionWindow.grow('in', input.total.in);
              return;
            case CALL_HIERARCHY_MENU_IDS.expandOut:
              sectionWindow.grow('out', input.total.out);
              return;
            case CALL_HIERARCHY_MENU_IDS.refresh:
              setCallHierarchyState(getCallHierarchyState());
              return;
            case CALL_HIERARCHY_MENU_IDS.close:
              deps.close();
              return;
            default:
              return;
          }
        },
      };
      faceBridge = entry;
      return () => {
        if (faceBridge === entry) faceBridge = null;
      };
    });

    if (state === null) {
      return h(
        'div',
        { className: 'wizard kd-host', 'data-context-surface': CALL_HIERARCHY_SURFACE_ID },
        h('p', { className: 'dim' }, '没有要查看的调用。'),
        closeBtn,
      );
    }
    if (state.kind === 'rejected') {
      return h(
        'div',
        { className: 'wizard kd-host', 'data-context-surface': CALL_HIERARCHY_SURFACE_ID },
        h('h3', null, '无法查看调用层级'),
        h('p', { className: 'kd-error' }, state.reason),
        closeBtn,
      );
    }

    return renderRequest(
      state.request,
      deps,
      closeBtn,
      sectionWindow,
      notice === null ? null : h('p', { className: notice.tone === 'ok' ? 'kd-banner ok' : 'kd-error' }, notice.text),
    );
  };
}

function renderRequest(
  request: CallHierarchyRequest,
  deps: CallHierarchyDeps,
  closeBtn: ReactElement,
  sectionWindow: SectionWindow,
  /** 复制一类的轻反馈（有才画；没有这一行也不占位） */
  feedback: ReactElement | null,
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
      { className: 'wizard kd-host', 'data-context-surface': CALL_HIERARCHY_SURFACE_ID },
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
        { className: 'wizard kd-host', 'data-context-surface': CALL_HIERARCHY_SURFACE_ID },
        h('h3', null, '调用层级'),
        notice(blockedCopy),
        closeBtn,
      );
    }
    return h(
      'div',
      { className: 'wizard kd-host', 'data-context-surface': CALL_HIERARCHY_SURFACE_ID },
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

  /** 两个 section 的行数与"还没画出来"的行数（右键「展开更多行」的判据，与 `section` 同一把尺） */
  const totalIn = referencesAvailable ? incomingRows.length : 0;
  const totalOut = referencesAvailable ? outgoingRows.length : 0;
  const hiddenIn =
    totalIn === 0 ? 0 : Math.max(0, totalIn - windowSize(totalIn, sectionWindow.inEnd, CALL_HIERARCHY_WINDOW));
  const hiddenOut =
    totalOut === 0 ? 0 : Math.max(0, totalOut - windowSize(totalOut, sectionWindow.outEnd, CALL_HIERARCHY_WINDOW));

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
    out.push(
      h('div', { key: `${heading}:rows`, className: 'search-rows' }, rowsToElements(heading, shown, deps, which)),
    );
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
    {
      className: 'wizard kd-host',
      'data-context-surface': CALL_HIERARCHY_SURFACE_ID,
      // 面板级事实写在根上：模块顶层的 `build` 靠它读"正在看谁 / 还藏了几行"（不靠 React 闭包）
      'data-ch-subject-name': target.name,
      'data-ch-subject-path': target.filePath,
      'data-ch-subject-line': String(target.startLine),
      'data-ch-hidden-in': String(hiddenIn),
      'data-ch-hidden-out': String(hiddenOut),
      'data-ch-total-in': String(totalIn),
      'data-ch-total-out': String(totalOut),
    },
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
      ? h('p', { className: 'dim', key: 'no-refs' }, '反向引用索引缺席（解析器还没交出引用台账），出入边不可用。')
      : null,
    feedback,
    closeBtn,
  );
}

function rowsToElements(
  heading: string,
  shown: readonly Row[],
  deps: CallHierarchyDeps,
  which: 'in' | 'out',
): ReactElement[] {
  return shown.map((row, i) => {
    if (row.kind === 'group') {
      return h(
        'button',
        {
          key: `g:${heading}:${i}`,
          className: 'search-match',
          title: `转到定义：${row.title}`,
          // 右键菜单靠这四个属性认出这一行（模块顶层的 build 读 DOM，不靠闭包）
          'data-ch-row': 'group',
          'data-ch-section': which,
          'data-ch-name': row.label,
          'data-ch-path': row.path,
          'data-ch-line': String(row.line),
          'data-ch-count': String(row.count),
          'data-ch-chain': row.sites.map((site) => `${site.filePath}:${site.line}:${site.column}`).join('\n'),
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
        'data-ch-row': 'site',
        'data-ch-section': which,
        'data-ch-name': row.group,
        'data-ch-path': site.filePath,
        'data-ch-line': String(site.line),
        'data-ch-column': String(site.column),
        onClick: () => deps.reveal(site.filePath, site.line, site.column),
      },
      h('span', { className: 'search-loc' }, `↳ ${siteLabel(site)}`),
    );
  });
}
