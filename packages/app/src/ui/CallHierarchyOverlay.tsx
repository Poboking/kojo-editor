import { createElement as h, useEffect, useState, type ReactElement } from 'react';
import { basename, nextWindow, windowSize, type RenderWindow } from '@kojo/plugin-api';
import type { ErbFunction, ErbIndex, ErbIndexState } from '@kojo/plugin-api';
import type * as Monaco from '../monaco/entry';
import {
  callHierarchyIndexCopy,
  callHierarchyIndexTitle,
} from './index-state-copy';
import {
  incomingCalls,
  outgoingCalls,
  resolveEnclosingFunction,
} from '../monaco/erb-call-hierarchy';
import type {
  Kojo2CallHierarchyProvider,
  Kojo2PanelGroup,
  Kojo2PanelResolution,
  Kojo2PanelSite,
} from '../monaco/kojo2-callhierarchy';
import { KOJO2_LANGUAGE_ID } from '../monaco/kojo2-constants';
import {
  getCallHierarchyState,
  loadKojo2CallHierarchyPanel,
  subscribeCallHierarchy,
  type CallHierarchyRequest,
  type Kojo2PanelApi,
} from './call-hierarchy';
import { referenceTallyFor, subscribeReferenceTally } from './reference-tally-store';

/**
 * 调用层级 overlay（2026-10-16 批 E；批次十 2026-10-23 补 kojo2 分派）——「这个函数被谁
 * 调用 / 它调用谁」的只读查询面板。
 *
 * 形态照 `DiffViewOverlay` / `FileHistoryOverlay` 同款（工厂注依赖 + 模块级状态单源）。
 * **按当前 model 的语言分派取数依赖**：
 * - `.erb`（及 v1 `.kojo`）⇒ 既有 `monaco/erb-call-hierarchy.ts`（`erb.parser` 的反向索引）；
 * - `kojo2` ⇒ `createKojo2CallHierarchyProvider()`（纯模型 `monaco/kojo2-callhierarchy.ts`
 *   的 provider 面，宿主自建面板消费；两个分支的"位点 → 声明 → 出入边"搬运都在
 *   `ui/call-hierarchy.ts` 的 `resolveKojo2CallHierarchy`）。
 * 本组件只做展示与跳转：行点击 → 注入的 `reveal`（宿主落成既有的
 * `editor.revealLocation`，与转到定义同一条导航通道），**零写操作**。
 *
 * 语言判据只有一条：`modelFor(请求文件).getLanguageId()`——没有 model（文件已关 / 旧
 * 宿主）⇒ 逐字退回 ERB 分支的旧行为（additive，不改变任何既有调用方）。
 *
 * 跳不出 Monaco Peek 的原因（取舍记档案）：Monaco standalone 无 CallHierarchy API
 * （PITFALLS §83），面板形态是审查过的替代而非降级——调用层级天然是"一次看全"
 * 的清单视图，列表比 peek 弹窗承载得多。
 *
 * **处数不是这里数的**（W8 收口的第二判据，仅 ERB 分支）：面板头的「被调用 · N 处」读
 * `ui/reference-tally-store` 里 F12 那一次计算的 `tally.nonDefinitionCount`，
 * 差值解释直接交回 `explainReferenceCounts` 的原文（文案也只有一份真源）。
 * 本面板自己那份 `incomingCalls` 只用来**列清单**（哪个调用者、哪一处点位），
 * 组行的「k 处」是"这位调用者名下的点位行数"——列表的形状数据，不是第二把尺子。
 * 没有读数（这个名字还没按过 F12）就明说"处数未读"，不拿清单长度冒充台账读数。
 * kojo2 没有 F12 台账这条腿，面板只列清单，不为它伪造第二份"处数"。
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
  /**
   * 请求文件的活动 model（**additive 可选**）：语言分派（`getLanguageId()`）与 kojo2
   * 取数都读它。缺席 / 返回 `null`（文件已关）= 旧行为：一律走 ERB 分支。
   */
  modelFor?(path: string): Monaco.editor.ITextModel | null;
  /** kojo2 provider（additive 可选；缺席 = 取数模块内的 `createKojo2CallHierarchyProvider()`） */
  kojo2Provider?(): Kojo2CallHierarchyProvider;
  /**
   * kojo2 取数模块（additive 可选；缺席 = 首次遇到 kojo2 文件时走动态装载）。
   * 注入口留给测试与预载宿主——默认腿见 `loadKojo2CallHierarchyPanel`（PS-10 ①）。
   */
  kojo2Panel?(): Kojo2PanelApi | null;
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
  | { kind: 'site'; site: Kojo2PanelSite };

/** 把一组出入边折成扁平行序列（组行 = 跳定义，点位行 = 跳调用处），便于统一截断 */
function flatten(groups: readonly Kojo2PanelGroup[]): Row[] {
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

function siteLabel(site: Kojo2PanelSite): string {
  return `${basename(site.filePath)}:${site.line}:${site.column}`;
}

/** 一组出入边的点位总数（清单形状数据，不是台账读数；写法避开 `incoming.reduce`） */
function totalSites(groups: readonly Kojo2PanelGroup[]): number {
  let total = 0;
  for (const group of groups) total += group.sites.length;
  return total;
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

    // 语言分派只问一次 model（渲染与装载共用同一枚，避免二次反查；旧 deps 缺席 ⇒ null）。
    const activeModel = requestKey === null ? null : deps.modelFor?.(requestKey.filePath) ?? null;
    const needsKojo2 = activeModel !== null && languageIdOf(activeModel) === KOJO2_LANGUAGE_ID;
    // kojo2 取数模块是动态边（PS-10 ①）：首次碰到 kojo2 文件时装载一次，失败也记成可见态。
    const [panelApi, setPanelApi] = useState<Kojo2PanelApi | null>(null);
    const [panelLoadFailed, setPanelLoadFailed] = useState(false);
    useEffect(() => {
      if (!needsKojo2 || deps.kojo2Panel !== undefined || panelApi !== null || panelLoadFailed) return;
      let alive = true;
      loadKojo2CallHierarchyPanel().then(
        (api) => {
          if (alive) setPanelApi(api);
        },
        () => {
          if (alive) setPanelLoadFailed(true);
        },
      );
      return () => {
        alive = false;
      };
    }, [needsKojo2, panelApi, panelLoadFailed, deps.kojo2Panel]);

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

    return renderRequest(state.request, deps, closeBtn, sectionWindow, {
      model: activeModel,
      api: deps.kojo2Panel?.() ?? panelApi,
      loadFailed: panelLoadFailed,
    });
  };
}

/** kojo2 分支的装载上下文（模型 = 语言判据；api 缺席 = 还在拉 / 拉失败） */
interface Kojo2PanelContext {
  readonly model: Monaco.editor.ITextModel | null;
  readonly api: Kojo2PanelApi | null;
  readonly loadFailed: boolean;
}

function renderRequest(
  request: CallHierarchyRequest,
  deps: CallHierarchyDeps,
  closeBtn: ReactElement,
  sectionWindow: SectionWindow,
  kojo2: Kojo2PanelContext,
): ReactElement {
  // 语言分派：先问当前文件的 model 是什么语言，再决定取数依赖（kojo2 / 其余 = ERB 旧路）。
  // model 缺席（文件已关 / 旧宿主）⇒ 不吃掉请求，逐字退回 ERB 分支的原有空态与文案。
  if (kojo2.model !== null && languageIdOf(kojo2.model) === KOJO2_LANGUAGE_ID) {
    return renderKojo2Request(request, kojo2, deps, closeBtn, sectionWindow);
  }

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

  const section = (heading: string, emptyText: string, rows: Row[], which: 'in' | 'out'): ReactElement[] =>
    referencesAvailable ? renderSection(heading, emptyText, rows, which, deps, sectionWindow) : [];

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
      ? h('p', { className: 'dim', key: 'no-refs' }, '反向引用索引缺席（解析器还没交出引用台账），出入边不可用。')
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

/**
 * 一段出入边区块（两个语言分支共用同一套窗口 / 行样式；标题、空态文案由分支各给）。
 * 哨兵是一枚 <button>（与问题面板同一形态）：Tab 得到它、Enter 按得动，点一次多画
 * STEP 行——不再是"另有 N 行未列出"的告别（RENDER_CAP 死顶已除）。
 */
function renderSection(
  heading: string,
  emptyText: string,
  rows: readonly Row[],
  which: 'in' | 'out',
  deps: CallHierarchyDeps,
  sectionWindow: SectionWindow,
): ReactElement[] {
  const out: ReactElement[] = [];
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
}

/** 语言 id 软取（模型被释放时不抛；取不到 ⇒ `null`，退回 ERB 旧路） */
function languageIdOf(model: Monaco.editor.ITextModel): string | null {
  try {
    return typeof model.getLanguageId === 'function' ? model.getLanguageId() : null;
  } catch {
    return null;
  }
}

/**
 * kojo2 分支（批次十）：取数在 `resolveKojo2CallHierarchy`（纯搬运），本函数只画。
 *
 * 五条可见态各有自己的那一句（`erro/unreadable/stale/not-callable/call-without-declaration`）：
 * 空态与错误态都不许静默——铁律 4「内核不静默」在面板这一层的落点。
 */
function renderKojo2Request(
  request: CallHierarchyRequest,
  kojo2: Kojo2PanelContext,
  deps: CallHierarchyDeps,
  closeBtn: ReactElement,
  sectionWindow: SectionWindow,
): ReactElement {
  const panel = (body: ReactElement[]): ReactElement =>
    h('div', { className: 'wizard kd-host' }, h('h3', null, '调用层级'), ...body, closeBtn);
  const notice = (text: string, key: string): ReactElement => h('p', { className: 'dim', key }, text);
  const model = kojo2.model;
  if (model === null) {
    // 分派前已判过；留这一句是给"模型在两帧之间被关掉"的兜底（不静默）。
    return panel([notice('当前文件没有打开的编辑器模型——先打开这份文件再运行命令。', 'k2-no-model')]);
  }

  if (kojo2.api === null) {
    // 两种装载态都可见：还在拉（第一次打开要拉解析器）与拉失败（打包 / 磁盘问题）。
    return panel([
      notice(
        kojo2.loadFailed
          ? 'kojo2 调用层级的取数模块没载入（打包或磁盘读失败）——收起面板重开一次；仍然这样就报这个错。'
          : '正在载入 kojo2 调用层级（首次打开要拉解析器，只这一次）…',
        kojo2.loadFailed ? 'k2-load-failed' : 'k2-loading',
      ),
    ]);
  }
  const api = kojo2.api;

  let resolution: Kojo2PanelResolution;
  try {
    const requestForKojo2 = { line: request.line, column: request.column, path: request.filePath };
    const provider = deps.kojo2Provider?.();
    resolution =
      provider === undefined
        ? api.resolveKojo2CallHierarchy(model, requestForKojo2)
        : api.resolveKojo2CallHierarchy(model, requestForKojo2, provider);
  } catch (error) {
    // provider 的失败自己吞了；能漏到这里的只剩真异常——照样可见，不装作空态。
    return panel([
      notice(
        `调用层级这一轮没算出来：${error instanceof Error ? error.message : String(error)}——这是取数错误，不是"没有调用关系"。`,
        'k2-error',
      ),
    ]);
  }

  /* eslint-disable no-case-declarations */
  switch (resolution.kind) {
    case 'unreadable':
      return panel([notice('读不到当前文件的内容（模型可能已关闭或还在载入）——重新打开这份文件后再试。', 'k2-unreadable')]);
    case 'stale-item':
      return panel([notice('这枚声明已经不在当前模型里（文件刚被改过？）——收起面板，重新运行命令。', 'k2-stale')]);
    case 'not-callable':
      return panel([
        notice(
          `第 ${resolution.line} 行不在任何 @函 / # 模 的正文里——把光标放到某个可调用声明的名字或正文中再试。`,
          'k2-off',
        ),
      ]);
    case 'call-without-declaration':
      return panel([
        notice(
          '这一格是一次调用，但本文件里没有同名声明（可能是跨文件函数或 adapter 基础库）——跨文件落点要等项目索引接线后才可见。',
          'k2-call',
        ),
      ]);
    case 'ready':
      break;
  }
  /* eslint-enable no-case-declarations */

  const view = resolution.view;
  const incomingRows = flatten(view.incoming);
  const outgoingRows = flatten(view.outgoing);
  // 处数走 `totalSites`：ERB 那一侧的"第二把尺子"卫生检查钉住面板不得用 `incoming.reduce`
  // 把清单长度冒充台账读数；这里同样只数清单行，且不写回任何"处数"文案。
  const incomingSites = totalSites(view.incoming);
  const outgoingSites = totalSites(view.outgoing);
  return panel([
    h(
      'p',
      { key: 'k2-target' },
      h('span', null, `${view.target.name}　`),
      h(
        'button',
        {
          className: 'ghost small',
          title: `转到定义：${view.target.path}:${view.target.line}`,
          onClick: () => deps.reveal(view.target.path, view.target.line, 1),
        },
        `@ ${locLabel(view.target.path, view.target.line)}`,
      ),
    ),
    ...renderSection(
      `被调用（${view.incoming.length} 个调用者 · ${incomingSites} 处）`,
      '当前文件里没有别的 @函 / # 模 调用它。',
      incomingRows,
      'in',
      deps,
      sectionWindow,
    ),
    ...renderSection(
      `调用（${view.outgoing.length} 个目标 · ${outgoingSites} 处）`,
      '函数体内没有落到本文件的调用（跨文件目标要等项目索引接线）。',
      outgoingRows,
      'out',
      deps,
      sectionWindow,
    ),
    notice(
      'kojo2 分支按当前文件算出入边：组行 = 跳声明，点位行 = 跳调用处；「处」是清单里的点位行数，不是第二份台账读数。',
      'k2-tally',
    ),
  ]);
}

