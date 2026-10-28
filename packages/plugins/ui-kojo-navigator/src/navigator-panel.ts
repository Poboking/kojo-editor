/**
 * 函数树面板组件（从 `index.ts` 的 `activate()` 原样迁出：DOM 结构、`className`、文案逐字不变）。
 *
 * 保持**闭包工厂**形态（原样保留对外部源的直接读法，不改 props 化）：
 *   - 状态源 `store`（树 / 就绪位 / 失败原因 / "只看"范围）住 `navigator-store.ts`，
 *     每帧开头取一次——与原先读 activate 闭包变量同值；
 *   - 家族规则与面标签由 `index.ts` 的槽位查询注入（本模块不 inject、不查槽位，
 *     更不 import 适配器包——解耦铁律）；
 *   - 意图只有两条：跳转 `editor.revealLocation`、回放 `kojo.replayFunction`。
 * 三态渲染都在本文件：失败态（中文短句 + 重试）→ 搜索态（命中列表）→ 树态（选定角色后）。
 */

import {
  createElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  ConditionExtractorService,
  ErbParserService,
  FamilyIndexRule,
  PluginContext,
  PluginContextMenuAnchor,
  UIPanelProps,
} from '@kojo/plugin-api';
import { CANDIDATE_BUDGETS, shortPath } from '@kojo/plugin-api';
import {
  FACE_WINDOW_INITIAL,
  functionTooltip,
  nextFaceWindow,
  searchFunctionsCached,
  type SearchHit,
} from './tree';
import {
  navCoverageCopy,
  navIndexPendingCopy,
  navLoadErrorCopy,
  navScanReadout,
  navTreeBodyCopy,
  navigatorScopeSuffix,
  navigatorScopeTitle,
} from './panel-copy';
import { dependencyTitle } from './labels';
import { renderTreeRows } from './tree-rows';
import type { NavigatorStore } from './navigator-store';
import {
  copyNavigatorText,
  openNavigatorFunctionMenu,
  openNavigatorGroupMenu,
  openNavigatorPanelMenu,
  type NavigatorMenuHost,
} from './context-menu';

/** 面板依赖（全部由 `index.ts` 的 `activate()` 注入） */
export interface NavigatorPanelDeps {
  readonly ctx: PluginContext;
  readonly parser: ErbParserService;
  readonly conditionExtractor: ConditionExtractorService;
  readonly store: NavigatorStore;
  /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配） */
  readonly currentFamilyIndex: () => FamilyIndexRule | null;
  /** 当前适配器的面 → 中文标签（缺省 ⇒ 面原样显示 token） */
  readonly currentFaceLabels: () => Readonly<Record<string, string>> | undefined;
}

/** 搜索结果上限（档位表在契约层：与全文检索 / `Ctrl+T` / `Ctrl+P` 同读一张预算表） */
const SEARCH_LIMIT = CANDIDATE_BUDGETS.providerQuery;
/** 搜索最少输入长度 */
const MIN_QUERY = 2;
/** 每行最多显示的条件标签数（其余折叠为 +n） */
const COND_BADGE_CAP = 2;

export function createNavigatorPanel(deps: NavigatorPanelDeps): (props: UIPanelProps) => unknown {
  const { ctx, conditionExtractor, store, currentFamilyIndex, currentFaceLabels } = deps;

  /* ------------------------------ 面板组件 ------------------------------ */

  function NavigatorPanel(props: UIPanelProps): unknown {
    /** 每帧开头取一次外部源（与原先直接读闭包变量同值：状态只在 `notify()` 前后变化） */
    const { tree, indexReady, loadError, scope, treeListeners, refresh, indexState, index } = store;
    const [, force] = useState(0);
    const [selectedNo, setSelectedNo] = useState<number | null>(null);
    const [query, setQuery] = useState('');
    /** 搜索走 deferred：输入框即时响应，99k 全量扫只对**已落定**的查询值跑 */
    const deferredQuery = useDeferredValue(query);
    const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
    const [openFaces, setOpenFaces] = useState<Set<string>>(new Set());
    /** 各已展开面的渲染窗口（行数；缺省 = FACE_WINDOW_INITIAL——见 tree.ts 的窗口口径） */
    const [faceWindows, setFaceWindows] = useState<Map<string, number>>(new Map());
    /** 触底 / 点击「显示更多」→ 按 STEP 追加（单调不减、步长有界；计算在 tree.ts 可单测） */
    const growFace = useCallback((faceKey: string, total: number): void => {
      setFaceWindows((prev) => {
        const cur = prev.get(faceKey);
        const next = nextFaceWindow(cur, total);
        if (next === (cur ?? FACE_WINDOW_INITIAL)) return prev; // 无变化不重渲
        const m = new Map(prev);
        m.set(faceKey, next);
        return m;
      });
    }, []);

    /** 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入；缺省回退纯文本字形（绝不空白） */
    const ic = (name: string, size: number, fallback: string): ReactNode =>
      (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

    useEffect(() => {
      const cb = (): void => force((n) => n + 1);
      treeListeners.add(cb);
      return () => {
        treeListeners.delete(cb);
      };
    }, []);

    // 条件索引（后台全量抽取完成后刷新徽章）
    useEffect(() => {
      const off = conditionExtractor.subscribe(() => force((n) => n + 1));
      return off;
    }, []);

    /** 函数行的条件徽章（schema 标签优先；悬停显示阈值） */
    const condBadges = (name: string): ReactNode[] => {
      const cond = conditionExtractor.functionConditions(name.toUpperCase());
      if (!cond) return [];
      const labelled = cond.dependencies.filter((d) => d.schema?.description);
      const out: ReactNode[] = [];
      for (const d of labelled.slice(0, COND_BADGE_CAP)) {
        out.push(
          createElement(
            'span',
            { key: `cond-${d.key}`, className: 'nav-badge cond', title: dependencyTitle(d) },
            d.schema!.description!,
          ),
        );
      }
      if (labelled.length > COND_BADGE_CAP) {
        out.push(
          createElement(
            'span',
            {
              key: 'cond-more',
              className: 'nav-badge dim',
              title: labelled.map((d) => dependencyTitle(d)).join('\n'),
            },
            `+${labelled.length - COND_BADGE_CAP}`,
          ),
        );
      }
      return out;
    };

    const treeNow = tree;
    const chara = treeNow?.charas.find((c) => c.no === selectedNo) ?? null;

    const hits: SearchHit[] = useMemo(() => {
      if (!indexReady || deferredQuery.trim().length < MIN_QUERY) return [];
      // 索引不变时 deferredQuery 驱动；store.index 在面板生命周期内稳定（同一源索引实例）。
      // 结果按（索引实例 × 查询串 × 范围 × 归属表）记忆（searchFunctionsCached）——无关重渲染
      // （徽章刷新 / 面板宿主重渲）不再重跑 99k 扫描。
      const idx = index;
      return idx
        ? searchFunctionsCached(idx, deferredQuery, currentFamilyIndex(), SEARCH_LIMIT, { scope })
        : [];
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deferredQuery, indexReady, treeNow]);

    const toggle = (setter: typeof setOpenFamilies, key: string): void => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    const open = (filePath: string, line: number, name: string): void => {
      ctx.bus.emit('editor.revealLocation', { filePath, line, source: name });
    };

    /** 回放意图：请求回放面板解释该函数（内核事件，回放面板响应） */
    const requestReplay = (name: string): void => {
      ctx.bus.emit('kojo.replayFunction', { functionName: name, source: 'ui-kojo-navigator' });
    };

    /** 函数行尾的回放按钮（阻止冒泡——外层是跳转按钮） */
    const replayBadge = (name: string): ReactNode =>
      createElement(
        'span',
        {
          className: 'nav-badge replay',
          title: `在状态回放面板中解释 ${name}`,
          onClick: (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            requestReplay(name);
          },
        },
        ic('history', 12, '⟲'),
      );

    /**
     * 右键菜单落点（1023 批）：三条都接回本面板已有的两条意图与刷新，不新增通道。
     * `menuNote` 是复制失败那类"按了没反应"的回执，挂在状态行下面一行，不另起浮层。
     */
    const [menuNote, setMenuNote] = useState('');
    const menuHost: NavigatorMenuHost = {
      openFunction: (t) => open(t.filePath, t.startLine, t.name),
      replayFunction: (name) => requestReplay(name),
      copy: (text) => {
        void copyNavigatorText(text).then((ok) => {
          if (ok) {
            setMenuNote('已复制');
            return;
          }
          setMenuNote('复制失败：当前环境不允许写剪贴板');
          ctx.log.warn('函数树复制失败：剪贴板不可用');
        });
      },
      refresh: () => void refresh(),
    };

    // 失败态优先：显示中文原因 + 重试（此前静默停在占位，用户无从判断与自救）。
    // 原始错误串不在第一眼——它进悬停 title，一条技术信息都不丢。
    if (loadError) {
      const copy = navLoadErrorCopy(loadError);
      return createElement(
        'div',
        {
          className: 'panel-kojo-nav',
          onContextMenu: (e: PluginContextMenuAnchor) => openNavigatorPanelMenu(props, e, menuHost),
        },
        createElement('div', { className: 'nav-empty err', title: copy.title }, copy.text),
        createElement(
          'button',
          { className: 'small', onClick: () => refresh() },
          '重试',
        ),
      );
    }

    if (!indexReady) {
      // 三态人话（IDX-STATE）：还在建 / 没找到可扫描的位置 / 扫了确实一个函数都没有。
      // 判据是提供方那枚 `phase`，这里只查表 + 把原始读数交给悬停（一条技术信息都不丢）。
      const copy = navIndexPendingCopy(indexState);
      return createElement(
        'div',
        {
          className: 'panel-kojo-nav',
          onContextMenu: (e: PluginContextMenuAnchor) => openNavigatorPanelMenu(props, e, menuHost),
        },
        createElement('div', { className: 'nav-empty dim', title: copy.title }, copy.text),
      );
    }

    const charaSelect = createElement(
      'select',
      {
        className: 'nav-chara-select',
        value: selectedNo === null ? '' : String(selectedNo),
        onChange: (e: { target: { value: string } }) => {
          const v = e.target.value;
          setSelectedNo(v === '' ? null : Number(v));
        },
      },
      createElement('option', { value: '' }, treeNow ? `选择角色（${treeNow.charas.length}）` : '选择角色'),
      ...(treeNow?.charas ?? []).map((c) =>
        createElement('option', { key: c.no, value: String(c.no) }, `${c.label}（${c.functionCount}）`),
      ),
    );

    const searchBox = createElement('input', {
      className: 'nav-search',
      type: 'search',
      placeholder: `搜索函数名（≥${MIN_QUERY} 字符，含未归属函数）`,
      value: query,
      onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
    });

    // 降级与成功**不同形**（铁律 4）：只由读得到的那些位置建成的那棵树，状态行就得看得见，
    // 悬停给出逐来源原始读数。标记取自提供方那枚 `coverage` tag（判据单源，本文件不重算）。
    const coverage = navCoverageCopy(indexState);
    const statusBar = treeNow
      ? createElement(
          'div',
          { className: 'nav-status dim', title: navigatorScopeTitle(treeNow, indexState) },
          `${treeNow.totalFunctions} 函数 · ${treeNow.charas.length} 角色` +
            (treeNow.hasFamilyIndex ? ` · 未归属 ${treeNow.orphanCount}` : ' · 适配器未提供家族规则') +
            navigatorScopeSuffix(treeNow) +
            coverage.mark,
        )
      : null;

    // ---- 搜索模式 ----
    // 模式切换也走 deferred：结果与列表同步出现，不闪「无匹配」中间态
    if (deferredQuery.trim().length >= MIN_QUERY) {
      return createElement(
        'div',
        {
          className: 'panel-kojo-nav',
          onContextMenu: (e: PluginContextMenuAnchor) => openNavigatorPanelMenu(props, e, menuHost),
        },
        createElement('div', { className: 'nav-toolbar' }, charaSelect, searchBox),
        statusBar,
        menuNote === '' ? null : createElement('div', { className: 'nav-status dim' }, menuNote),
        createElement(
          'div',
          { className: 'nav-hits' },
          hits.length === 0
            ? createElement('div', { className: 'nav-empty dim' }, '无匹配函数')
            : createElement(
                'ul',
                { className: 'nav-hit-list' },
                ...hits.map((h, i) =>
                  createElement(
                    'li',
                    {
                      key: `${h.node.filePath}:${h.node.startLine}:${i}`,
                      // 搜索命中的行与树里的函数行是同一件事 ⇒ 同一份菜单
                      onContextMenu: (e: PluginContextMenuAnchor) =>
                        openNavigatorFunctionMenu(
                          props,
                          e,
                          { name: h.node.name, filePath: h.node.filePath, startLine: h.node.startLine },
                          menuHost,
                        ),
                    },
                    createElement(
                      'button',
                      {
                        className: 'nav-hit-btn',
                        title: functionTooltip(h.node, shortPath),
                        onClick: () => open(h.node.filePath, h.node.startLine, h.node.name),
                      },
                      createElement('span', { className: 'nav-hit-name' }, h.node.name),
                      ...condBadges(h.node.name),
                      replayBadge(h.node.name),
                      createElement(
                        'span',
                        { className: 'nav-hit-loc dim' },
                        // 归属列写作者的词，不写破折号记号：`—` 要读者自己反推「没归到角色」，
                        // 而状态栏与占位文案用的就是「未归属」这一词（同词同义，不再二义）。
                        `${h.charaNo !== null ? `K${h.charaNo}` : '未归属'} · ${shortPath(h.node.filePath)}:${h.node.startLine}`,
                      ),
                    ),
                  ),
                ),
              ),
        ),
      );
    }

    // ---- 树模式 ----
    let body: ReactNode;
    if (!chara) {
      const verdict = navTreeBodyCopy(indexState, '从上方选择角色以浏览其口上函数树');
      body = createElement(
        'div',
        { className: 'nav-empty dim', title: indexState ? navScanReadout(indexState) : undefined },
        verdict,
      );
    } else {
      body = renderTreeRows({
        chara,
        openFamilies,
        openFaces,
        faceWindows,
        onToggleFamily: (key) => toggle(setOpenFamilies, key),
        onToggleFace: (key) => toggle(setOpenFaces, key),
        onGrowFace: growFace,
        faceLabels: currentFaceLabels,
        icon: ic,
        condBadges,
        replayBadge,
        onOpen: (fn) => open(fn.filePath, fn.startLine, fn.name),
        onFunctionMenu: (fn, e) =>
          openNavigatorFunctionMenu(
            props,
            e,
            { name: fn.name, filePath: fn.filePath, startLine: fn.startLine },
            menuHost,
          ),
        onGroupMenu: (target, e) =>
          openNavigatorGroupMenu(props, e, target, menuHost, () =>
            target.kind === 'family'
              ? toggle(setOpenFamilies, target.key)
              : toggle(setOpenFaces, target.key),
          ),
      });
    }

    return createElement(
      'div',
      {
        className: 'panel-kojo-nav',
        onContextMenu: (e: PluginContextMenuAnchor) => openNavigatorPanelMenu(props, e, menuHost),
      },
      createElement('div', { className: 'nav-toolbar' }, charaSelect, searchBox),
      statusBar,
      menuNote === '' ? null : createElement('div', { className: 'nav-status dim' }, menuNote),
      body,
    );
  }

  return NavigatorPanel;
}
