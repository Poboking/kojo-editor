/**
 * @kojo/plugin-ui-kojo-navigator
 *
 * 口上函数树导航面板（`ui.panel` 槽贡献；v0.2 第二批，HANDOFF §六）。
 *
 * 三维导航：角色 → 家族 → 面 → 函数。数据全来自既有契约：
 *   - `erb.parser`：函数索引（响应式，`kojo.functionChanged` 驱动重建）；
 *   - `game.adapter` 槽位查询 + `project.adapterId` 过滤 → `functionFamilyIndex`
 *     （**不 import 适配器包**——解耦铁律，多游戏共存天然正确）；
 *   - `project.charaIndex`：角色显示名。
 *
 * 呈现层只做「浏览 + 跳转意图」：点击函数 → `editor.revealLocation`（宿主消费）。
 * 文件维度的浏览由 app 壳的 FileTree 承担，本面板负责函数/家族维度。
 */

import {
  createElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  ConditionExtractorService,
  ErbParserService,
  ErbIndex,
  FamilyIndexRule,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateDependency,
  UIPanelProps,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  FACE_WINDOW_INITIAL,
  buildNavigatorTree,
  faceWindowSize,
  functionTooltip,
  nextFaceWindow,
  searchFunctionsCached,
  shouldRebuildIndex,
  type FunctionNode,
  type NavigatorTree,
  type SearchHit,
} from './tree';

/** 搜索结果上限 */
const SEARCH_LIMIT = 200;
/** 搜索最少输入长度 */
const MIN_QUERY = 2;
/** 每行最多显示的条件标签数（其余折叠为 +n） */
const COND_BADGE_CAP = 2;

/* ------------------------------ 面行窗口 ------------------------------ */

/**
 * 「显示更多」哨兵行（面窗口触底器）。
 *
 * 进入滚动视口即自动追加下一窗（IntersectionObserver —— 滚动容器 `.nav-tree` 自带
 * `overflow-y: auto`，浏览器对滚动裁剪后的可见矩形判相交，不必手动传 root）；
 * 观察器不可用（SSR / 测试 / 旧环境）时退化为**纯点击按钮**——功能不丢。
 *
 * 类型口径：本包装在 `lib: ES2022` 下编译（无 DOM lib），`IntersectionObserver` 与
 * 元素一律走最小结构化类型；ref 用**稳定回调 ref**（`useCallback` 空依赖）拿真实节点，
 * 避免每次渲染重挂 observer。
 */
type IntersectionObserverLike = new (
  cb: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void,
) => { observe(target: object): void; disconnect(): void };

function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => {
    const el = anchor.current as object | null;
    const IO = (globalThis as { IntersectionObserver?: IntersectionObserverLike }).IntersectionObserver;
    if (!el || !IO) return;
    const io = new IO((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMoreRef.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return createElement(
    'li',
    { ref: setAnchor, className: 'nav-more' },
    createElement(
      'button',
      {
        className: 'nav-more-btn',
        title: '滚到此处会自动加载下一批；也可直接点击',
        onClick: () => onMore(),
      },
      `显示更多（其余 ${remaining} 个）`,
    ),
  );
}

/** 面函数列表（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface FaceListProps {
  /** 面窗口键（`chara|family|face`——`onGrow` 按它定位窗口） */
  readonly faceKey: string;
  readonly functions: readonly FunctionNode[];
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 请求扩大该面窗口（新值由 `nextFaceWindow` 计算） */
  readonly onGrow: (faceKey: string, total: number) => void;
  /** 行尾徽章（条件 / 回放；宿主闭包提供） */
  readonly badges: (fn: FunctionNode) => ReactNode[];
  /** 点击行 = 跳函数意图 */
  readonly onOpen: (fn: FunctionNode) => void;
  /** 悬停提示 */
  readonly tooltip: (fn: FunctionNode) => string;
}

export function FaceList(props: FaceListProps): ReactElement {
  const { functions, limit } = props;
  const win = faceWindowSize(functions.length, limit);
  const rows = functions.slice(0, win);
  return createElement(
    'ul',
    { className: 'nav-funcs' },
    ...rows.map((fn) =>
      createElement(
        'li',
        { key: `${fn.filePath}:${fn.startLine}` },
        createElement(
          'button',
          {
            className: 'nav-func-btn',
            title: props.tooltip(fn),
            onClick: () => props.onOpen(fn),
          },
          createElement('span', { className: 'nav-func-name' }, fn.name),
          ...props.badges(fn),
        ),
      ),
    ),
    functions.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: functions.length - win,
          onMore: () => props.onGrow(props.faceKey, functions.length),
        })
      : null,
  );
}

/** 依赖的悬停提示（标签 + 阈值） */
function dependencyTitle(d: StateDependency): string {
  const label = d.schema?.description ? `${d.schema.description}（${d.key}）` : d.key;
  const comps = d.comparisons.map((c) => `${c.op} ${c.text}`).join('、');
  return comps.length > 0 ? `${label} ${comps}` : label;
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/** 家族显示名：'' = 初始家族 */
function familyLabel(family: string): string {
  return family === '' ? '初始家族' : family;
}

/**
 * 面显示名：'' → '其它'；'declare' → '家族声明'；其余查 `labels`（适配器提供的
 * 面 → 中文），未收录 / 未注入则原样显示面 token（fail-visible，不猜）。
 */
function faceLabel(face: string, labels?: Readonly<Record<string, string>>): string {
  switch (face) {
    case '':
      return '其它';
    case 'declare':
      return '家族声明';
    default:
      return labels?.[face] ?? face;
  }
}

/**
 * 函数树失败态的第一眼文案（模块级纯函数 ⇒ 可单测；范式抄 `ui-condition-matrix` 的收口）。
 *
 * 上屏的必须是**作者读得懂的中文短句**，内部原始错误串（`ensureIndex` / `buildNavigatorTree`
 * 抛出的 message，往往是路径 + 栈式英文片段）只进悬停 `title`——技术信息一条不丢，
 * 但它不是甩给作者的第一眼。
 */
export function navLoadErrorCopy(loadError: string): { readonly text: string; readonly title: string } {
  return {
    text: '函数树加载失败：口上函数索引构建出错（悬停查看原始错误）',
    title: loadError,
  };
}

export function createUiKojoNavigatorPlugin(): Plugin {
  return {
    id: 'ui-kojo-navigator',
    version: '0.2.0',
    requires: [
      WellKnownServices.ErbParser,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const conditionExtractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配） */
      const currentFamilyIndex = (): FamilyIndexRule | null => {
        const current: GameProject | null = project.current();
        if (!current) return null;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId === current.adapterId && contribution.adapter.functionFamilyIndex) {
            return contribution.adapter.functionFamilyIndex;
          }
        }
        return null;
      };

      /** 当前适配器的面 → 中文标签（与家族规则同源；缺省 → 原样显示 token） */
      const currentFaceLabels = (): Readonly<Record<string, string>> | undefined =>
        currentFamilyIndex()?.faceLabels;

      // ---- 状态（React 外部源；面板组件读取并订阅） ----
      let tree: NavigatorTree | null = null;
      let indexReady = false;
      /** 上一次建树所用的索引实例（去重判据：同一实例不重复建树，见 `shouldRebuildIndex`） */
      let lastBuiltIndex: ErbIndex | null = null;
      /** 索引/建树失败原因（2026-10-11 实机反馈）：此前只在 catch 里 log.warn，
       *  面板永久停在「打开项目后自动构建函数索引…」占位，用户既不知失败也无从重试 */
      let loadError: string | null = null;
      const treeListeners = new Set<() => void>();

      const notify = (): void => {
        for (const cb of [...treeListeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`Navigator listener threw: ${String(err)}`);
          }
        }
      };

      const rebuild = (index: ErbIndex | null): void => {
        // 去重（2026-10-12 内核优化批）：`project.opened` 与 `kojo.functionChanged` 会
        // 双双触发 refresh，两者拿到的是同一个索引实例——同一实例不重复建树
        // （`buildNavigatorTree` 在 95k 函数上是近秒级开销，白跑第二遍纯属浪费）。
        if (!shouldRebuildIndex(lastBuiltIndex, index)) return;
        lastBuiltIndex = index;
        if (!index || !project.current()) {
          tree = null;
          indexReady = index !== null;
        } else {
          tree = buildNavigatorTree(index, currentFamilyIndex(), project.current()!.charaIndex);
          indexReady = true;
        }
        loadError = null;
        notify();
      };

      /** 等待索引就绪并重建（项目刚打开时索引可能在途） */
      const refresh = (): void => {
        if (!project.current()) {
          rebuild(null);
          return;
        }
        loadError = null;
        notify();
        void parser
          .ensureIndex()
          .then((index) => rebuild(index))
          .catch((err: unknown) => {
            // 失败必须可见（含建树抛错，此前被同一个 catch 静默吞掉）
            const msg = err instanceof Error ? err.message : String(err);
            loadError = msg;
            indexReady = false;
            ctx.log.error(`Navigator load failed: ${msg}`);
            notify();
          });
      };

      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.opened', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.closed', () => rebuild(null)));

      // 激活时已有现成索引（插件晚于项目打开加载）→ 立即构建
      if (project.current()) refresh();

      /* ------------------------------ 面板组件 ------------------------------ */

      function NavigatorPanel(props: UIPanelProps): unknown {
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
          // 索引不变时 deferredQuery 驱动；parser.currentIndex() 在面板生命周期内稳定。
          // 结果按（索引实例 × 查询串）记忆（searchFunctionsCached）——无关重渲染
          // （徽章刷新 / 面板宿主重渲）不再重跑 99k 扫描。
          const idx = parser.currentIndex();
          return idx ? searchFunctionsCached(idx, deferredQuery, currentFamilyIndex(), SEARCH_LIMIT) : [];
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

        // 失败态优先：显示中文原因 + 重试（此前静默停在占位，用户无从判断与自救）。
        // 原始错误串不在第一眼——它进悬停 title，一条技术信息都不丢。
        if (loadError) {
          const copy = navLoadErrorCopy(loadError);
          return createElement(
            'div',
            { className: 'panel-kojo-nav' },
            createElement('div', { className: 'nav-empty err', title: copy.title }, copy.text),
            createElement(
              'button',
              { className: 'small', onClick: () => refresh() },
              '重试',
            ),
          );
        }

        if (!indexReady) {
          return createElement(
            'div',
            { className: 'panel-kojo-nav' },
            createElement('div', { className: 'nav-empty dim' }, '正在构建函数索引…（首次打开项目需要数秒）'),
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

        const statusBar = treeNow
          ? createElement(
              'div',
              { className: 'nav-status dim' },
              `${treeNow.totalFunctions} 函数 · ${treeNow.charas.length} 角色` +
                (treeNow.hasFamilyIndex ? ` · 未归属 ${treeNow.orphanCount}` : ' · 适配器未提供家族规则'),
            )
          : null;

        // ---- 搜索模式 ----
        // 模式切换也走 deferred：结果与列表同步出现，不闪「无匹配」中间态
        if (deferredQuery.trim().length >= MIN_QUERY) {
          return createElement(
            'div',
            { className: 'panel-kojo-nav' },
            createElement('div', { className: 'nav-toolbar' }, charaSelect, searchBox),
            statusBar,
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
                        { key: `${h.node.filePath}:${h.node.startLine}:${i}` },
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
          body = createElement('div', { className: 'nav-empty dim' }, '从上方选择角色以浏览其口上函数树');
        } else {
          body = createElement(
            'div',
            { className: 'nav-tree' },
            ...chara.families.map((family) => {
              const fKey = `${chara.no}|${family.family}`;
              const fOpen = openFamilies.has(fKey);
              return createElement(
                'div',
                { key: fKey, className: 'nav-family' },
                createElement(
                  'button',
                  { className: 'nav-family-btn', onClick: () => toggle(setOpenFamilies, fKey) },
                  createElement('span', { className: 'caret' }, ic(fOpen ? 'chevron-down' : 'chevron-right', 12, fOpen ? '▾' : '▸')),
                  createElement('span', { className: 'nav-family-name' }, familyLabel(family.family)),
                  createElement(
                    'span',
                    { className: 'nav-count dim' },
                    String(family.faces.reduce((n, f) => n + f.functions.length, 0)),
                  ),
                ),
                fOpen
                  ? createElement(
                      'div',
                      { className: 'nav-faces' },
                      ...family.faces.map((face) => {
                        const fcKey = `${fKey}|${face.face}`;
                        const fcOpen = openFaces.has(fcKey);
                        return createElement(
                          'div',
                          { key: fcKey, className: 'nav-face' },
                          createElement(
                            'button',
                            { className: 'nav-face-btn', onClick: () => toggle(setOpenFaces, fcKey) },
                            createElement('span', { className: 'caret' }, ic(fcOpen ? 'chevron-down' : 'chevron-right', 12, fcOpen ? '▾' : '▸')),
                            createElement('span', { className: 'nav-face-name' }, faceLabel(face.face, currentFaceLabels())),
                            createElement('span', { className: 'nav-count dim' }, String(face.functions.length)),
                          ),
                          // 面函数列表：窗口化渲染（初始 80 行；触底/点击「显示更多」按 160 步进——
                          // 旧实现是硬截 300 行 + 其余不可达，见 FaceList / tree.ts 的窗口口径）
                          fcOpen
                            ? createElement(FaceList, {
                                key: `${fcKey}|funcs`,
                                faceKey: fcKey,
                                functions: face.functions,
                                limit: faceWindows.get(fcKey),
                                onGrow: growFace,
                                badges: (fn: FunctionNode): ReactNode[] => {
                                  const badges: ReactNode[] = [];
                                  // 徽标写作者的词，不写查表记号（裸 `MC` / `#n` 是内部缩记，
                                  // 作者读到的是又一个要背的格式）：MESSAGECHECK 否决钩子是
                                  // 「隐藏情景:」「隐藏口上:」的产物；剧本编号沿用项目管理面板的「剧本N」。
                                  if (fn.match?.isMessageCheck)
                                    badges.push(
                                      createElement(
                                        'span',
                                        {
                                          key: 'mc',
                                          className: 'nav-badge',
                                          title:
                                            '隐藏钩子（MESSAGECHECK 否决钩子）：写「隐藏情景:」「隐藏口上:」时由工具生成，' +
                                            '按 RETURN 位掩码决定跳过游戏情景还是这份口上',
                                        },
                                        '隐藏钩子',
                                      ),
                                    );
                                  if (fn.match && fn.match.kind === 'declare' && fn.match.selector > 0)
                                    badges.push(
                                      createElement(
                                        'span',
                                        {
                                          key: 'sel',
                                          className: 'nav-badge',
                                          title: `剧本${fn.match.selector}：同一家族的这一版口上（多剧本作品按剧本号分开）`,
                                        },
                                        `剧本${fn.match.selector}`,
                                      ),
                                    );
                                  badges.push(...condBadges(fn.name));
                                  badges.push(replayBadge(fn.name));
                                  return badges;
                                },
                                onOpen: (fn: FunctionNode) => open(fn.filePath, fn.startLine, fn.name),
                                tooltip: (fn: FunctionNode) => functionTooltip(fn, shortPath),
                              })
                            : null,
                        );
                      }),
                    )
                  : null,
              );
            }),
          );
        }

        return createElement(
          'div',
          { className: 'panel-kojo-nav' },
          createElement('div', { className: 'nav-toolbar' }, charaSelect, searchBox),
          statusBar,
          body,
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'kojo-navigator',
        title: '函数树',
        icon: 'structure',
        order: 40,
        // UI 重设计批 P1：与壳层内建口上文件树合并为单 Explorer（定稿 Q5）
        group: 'explorer',
        component: NavigatorPanel,
      });
    },
  };
}
