/**
 * @kojo/plugin-ui-condition-matrix
 *
 * 条件矩阵面板（`ui.panel` 槽贡献；任务 HK-14）。
 *
 * 对选定角色呈现「状态 × 时机」网格：行 = 状态变量键（经变量字典给出人读标签），
 * 列 = 该角色的时机面（系统时机 + 作者自定指令/自定事件都以 face 呈现）。
 * 填色的格子 = 该时机有函数响应了这个状态，点击跳到源；空白 = 尚未写反应。
 *
 * 数据全来自既有契约（插件不得交叉 import）：
 *   - `erb.parser`：函数索引（`kojo.functionChanged` / `project.opened` / `project.closed`
 *     驱动重建，同一索引实例去重）；
 *   - `game.adapter` 槽位查询 + `project.adapterId` 过滤 → `functionFamilyIndex`
 *     （角色/面归属）与 `variableSchema`（状态键标签）；
 *   - `condition.extractor`：单函数状态依赖（`functionConditions(...).dependencies`），
 *     其索引就绪后经 `subscribe` 刷新填色。
 *
 * 呈现层只做「浏览 + 跳转意图」：点击函数 → `editor.revealLocation`（宿主消费）。
 */

import {
  createElement,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type {
  ConditionExtractorService,
  ErbIndex,
  ErbParserService,
  FamilyIndexRule,
  GameProject,
  KojoInstructionTable,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateDependency,
  UIPanelProps,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, pathKey, shortPath } from '@kojo/plugin-api';
import {
  buildCharacterIndex,
  buildMatrix,
  cellKeysOfFunction,
  clampDetailHeight,
  clampRowheadWidth,
  computeViewportWindow,
  createMatrixMemo,
  DETAIL_MIN_H,
  faceLabel,
  functionRangeAt,
  instructionNoOfSlot,
  MATRIX_OVERSCAN,
  MATRIX_ROW_H,
  ROWHEAD_MIN_W,
  type CharacterIndex,
  type ColumnDesc,
  type ConditionMatrix,
  type CursorSight,
  type FaceFunction,
  type FunctionRange,
  type MatrixCell,
  type MatrixCellFunction,
  type MatrixColumnGroup,
  type MatrixRow,
} from './matrix-logic';
import { MatrixRowView, type RevealTarget } from './row-view';
import { buildColgroup, renderGridHead, spacerRow } from './grid-parts';
import { renderDetail } from './detail-pane';
import { createMatrixStore } from './matrix-store';
import { createAdapterServices } from './adapter-services';
import { measureColSnap, toggleHandles } from './col-resize';
import type {
  ColResizePointer,
  ColSnap,
  GridKeyEvent,
  ScrollBox,
  ScrollEvent,
  SplitterPointer,
} from './dom-shims';

/** 矩阵行渲染上限（防 DOM 爆炸；过滤后仍受此限）——**仅全量（非视口化）路径** */
const ROW_RENDER_CAP = 400;

/** 光标没命中任何格时的空集合（常量身份：无命中路径零分配，行 memo 也据此跳过） */
const NO_CURSOR_CELLS: ReadonlyMap<string, string> = new Map<string, string>();

export function createUiConditionMatrixPlugin(): Plugin {
  return {
    id: 'ui-condition-matrix',
    version: '0.1.0',
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

      // ---- 适配器查询面（家族规则 / 变量字典 / 指令表 / 标签）：见 ./adapter-services.ts ----
      const services = createAdapterServices({ project, slots, conditionExtractor });

      // ---- 外部状态源（索引重建 / 抽取代次 / 矩阵记忆化 / 事件订阅）：见 ./matrix-store.ts ----
      const store = createMatrixStore(ctx, { parser, project, conditionExtractor, services });

      /* ------------------------------ 面板组件 ------------------------------ */

      function ConditionMatrixPanel(props: UIPanelProps): unknown {
        const [, force] = useState(0);
        const [selectedNo, setSelectedNo] = useState<number | null>(null);
        const [filter, setFilter] = useState('');
        const [selected, setSelected] = useState<{ rowKey: string; columnKey: string } | null>(null);
        /** 已折叠的大时机类面集合（默认全展开；点分组表头切换） */
        const [foldedFaces, setFoldedFaces] = useState<Set<string>>(new Set<string>());
        /** 详情区高度（px；null = 未拖过，走样式默认）——会话级，与壳层分栏同口径不持久化 */
        const [detailH, setDetailH] = useState<number | null>(null);
        /** 分隔线拖拽中（仅用于高亮） */
        const [splitDragging, setSplitDragging] = useState(false);
        /** 首列（「状态 \ 时机」）拖拽宽度（px；null = 未拖过，走自然宽度）——会话级，与详情高度同口径 */
        const [rowheadW, setRowheadW] = useState<number | null>(null);
        /**
         * 首列列宽拖拽（HK-27 / HK-28）：接管期把表切成 `table-layout: fixed` + `<colgroup>` 列宽快照
         * + **显式表宽**，每帧只直写第 0 个 `<col>` 与表宽这两个内联样式。
         *
         * 原实现每帧改 `.cm-scroll` 上的 `--cm-rowhead-w`：自定义属性按继承失效整棵万节点子树，
         * 且 `table-layout: auto` 要重测全表内容。CDP 实测（6487 格 / 26 行）：p50 483ms / max 567ms。
         * 切定宽后同一张表实测 p50 33ms / avg 35ms / max 50ms（预热后；首帧仍 ~67ms）。
         *
         * 显式表宽**不能省**：只切 `table-layout: fixed` 时这张表的 `<col>` 宽会被浏览器忽略
         * （探针实测：col0 由 160 改 300，角格恒 160、表宽纹丝不动）；把表宽写死成
         * 「快照表宽 + (首列宽 - 首列原始宽)」后角格 160→320、表宽 12466→12724，几何精确跟手。
         */
        const [colSnap, setColSnap] = useState<ColSnap | null>(null);
        const colSnapRef = useRef<ColSnap | null>(null);
        const colRef = useRef<{ style: { width: string } } | null>(null);
        const tableRef = useRef<{ style: { width: string } } | null>(null);
        /** 拖拽中最后算出的宽度（pointerup 时 commit 回 state） */
        const lastColW = useRef<number | null>(null);
        const rootRef = useRef<{ clientHeight: number } | null>(null);
        const detailRef = useRef<{ clientHeight: number } | null>(null);
        const cornerRef = useRef<{ offsetWidth: number } | null>(null);
        const scrollRef = useRef<ScrollBox | null>(null);
        const dragSeed = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);
        const colDragSeed = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
        /** 过滤输入走 deferred：输入即时响应，重表延后重渲（大矩阵逐键打字不卡） */
        const deferredFilter = useDeferredValue(filter);

        /** 视口化开关（宿主下传；缺省 / false = 改动前的全量渲染路径，逐字不变） */
        const virtualize = props.uiPrefs?.panelVirtualize === true;
        /** 滚动位置（视口化路径驱动窗口；全量路径恒为 0，不参与渲染） */
        const [scrollTop, setScrollTop] = useState(0);
        /** 滚动容器可视高（视口化路径算窗口用；首帧未量到 → 0，仅画 overscan 行） */
        const [viewportH, setViewportH] = useState(0);
        /** 跨窗口键盘导航待聚焦的格子（渲染出该格后由 effect 落焦点，绝不聚焦不存在的节点） */
        const pendingFocus = useRef<{ r: number; c: number } | null>(null);
        /** 当前（过滤后）行数——键盘导航判上界用 */
        const rowCountRef = useRef(0);

        /** 点击格子：发跳转意图 + 落选中态（稳定引用 → 行 memo 生效） */
        const onCell = useCallback((rowKey: string, columnKey: string, target: RevealTarget | null): void => {
          if (target) {
            ctx.bus.emit('editor.revealLocation', {
              filePath: target.filePath,
              line: target.line,
              source: target.source,
            });
          }
          setSelected({ rowKey, columnKey });
        }, []);

        /** 网格方向键导航：格子带 data-r/data-c，按渲染序上下左右移动焦点（折叠组的空 td 不参与） */
        const onGridKeyDown = (e: GridKeyEvent): void => {
          const t = e.target as {
            classList?: { contains(c: string): boolean };
            getAttribute?: (n: string) => string | null;
          } | null;
          if (!t || !t.classList?.contains('cm-cell') || !t.getAttribute) return;
          const r = Number(t.getAttribute('data-r'));
          const c = Number(t.getAttribute('data-c'));
          if (!Number.isFinite(r) || !Number.isFinite(c)) return;
          let dr = 0;
          let dc = 0;
          if (e.key === 'ArrowUp') dr = -1;
          else if (e.key === 'ArrowDown') dr = 1;
          else if (e.key === 'ArrowLeft') dc = -1;
          else if (e.key === 'ArrowRight') dc = 1;
          else return;
          const tr = r + dr;
          const tc = c + dc;
          if (tr < 0 || tc < 0) return;
          const next = scrollRef.current?.querySelector(`.cm-cell[data-r="${tr}"][data-c="${tc}"]`);
          if (next) {
            e.preventDefault();
            next.focus();
            return;
          }
          // 目标格不在当前渲染窗口内 → 只可能是视口化路径下的**纵向**跨窗移动
          // （横向同列在本窗内；纵向切到的是同一列，该列必然有格子）。
          // 先把目标行滚进视野（顶到视口上沿，必落在窗口内），记账待重渲后聚焦——
          // 分两步，绝不聚焦到尚未渲染的节点。
          if (!virtualize || dr === 0) return;
          if (tr >= rowCountRef.current) return; // 越过末行：无目标，保持原焦点
          const box = scrollRef.current;
          if (!box) return;
          e.preventDefault();
          box.scrollTop = tr * MATRIX_ROW_H;
          setScrollTop(box.scrollTop);
          pendingFocus.current = { r: tr, c: tc };
        };

        const onSplitDown = (e: SplitterPointer): void => {
          e.preventDefault();
          dragSeed.current = {
            pointerId: e.pointerId,
            startY: e.clientY,
            // 首次拖拽从「当前真实高度」起步（未拖过时 = 内容自然高度），不跳变
            startH: detailH ?? detailRef.current?.clientHeight ?? DETAIL_MIN_H,
          };
          setSplitDragging(true);
          // 指针捕获：拖快了指头滑出命中区也不丢事件
          e.currentTarget.setPointerCapture(e.pointerId);
        };

        const onSplitMove = (e: SplitterPointer): void => {
          const seed = dragSeed.current;
          if (!seed || seed.pointerId !== e.pointerId) return;
          const dy = seed.startY - e.clientY; // 向上拖 = 详情区变高
          setDetailH(clampDetailHeight(seed.startH + dy, rootRef.current?.clientHeight ?? 0));
        };

        const onSplitEnd = (e: { pointerId: number }): void => {
          if (dragSeed.current?.pointerId !== e.pointerId) return;
          dragSeed.current = null;
          setSplitDragging(false);
        };

        // 首列（「状态 \ 时机」）列宽拖拽（HK-25 / HK-27·28）：与详情分隔线同范式（pointer 捕获 + 钳制）。
        // 把手遍布**整列**（表头角格 + 每一行的行头），故事件挂在 .cm-scroll 上**委派**：
        // 行组件不为拖拽持有 handler ⇒ `memo` 不被破坏；命中与否只看 target 落在不落在把手上。
        const onColDown = (e: ColResizePointer): void => {
          if (!e.target?.closest?.('.cm-corner-resize')) return;
          e.preventDefault();
          // 快照列宽；仅在失效时重量（快照有效 = 已经在定宽模式里，再量会量到定宽本身）
          const cached = colSnapRef.current;
          if (!cached || cached.key !== matrixKey) {
            const snap = measureColSnap(scrollRef.current, matrixKey);
            if (!snap) return; // 量不到就不接管：保持原行为，绝不半途而废
            colSnapRef.current = snap;
            setColSnap(snap);
          }
          lastColW.current = null;
          colDragSeed.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            // 首次拖拽从「当前真实列宽」起步（未拖过时 = 角格自然宽度），不跳变
            startW: rowheadW ?? cornerRef.current?.offsetWidth ?? ROWHEAD_MIN_W,
          };
          // 拖拽高亮：直接给**把手自己**加类，不走 React state。早先写的是 `.cm-scroll.col-resizing`
          // ——后代选择器 ⇒ 一次类切换就让整棵 6.5k 格子子树失效重算（CDP 实测那一记 ~450ms 长帧的
          // 头号嫌疑）；改挂到 37 枚把手上后失效面只剩 37 个元素，且拖拽起止不再触发 React 重渲。
          toggleHandles(scrollRef.current, true);
          // 指针捕获：拖快了指头滑出命中区也不丢事件
          e.currentTarget.setPointerCapture(e.pointerId);
        };

        const onColMove = (e: ColResizePointer): void => {
          const seed = colDragSeed.current;
          if (!seed || seed.pointerId !== e.pointerId) return;
          const w = clampRowheadWidth(seed.startW + (e.clientX - seed.startX));
          lastColW.current = w;
          // 只写两个内联样式：第 0 个 `<col>` 的 width + 表宽（快照表宽 + 首列宽增量）。
          // 同步写即可：浏览器把布局推迟到下一帧，同帧多次 pointermove 只落一次重排。
          // 表宽必须同步写——定宽布局下「显式表宽」才让 `<col>` 生效（见上方注释）。
          const snap = colSnapRef.current;
          if (colRef.current) colRef.current.style.width = `${w}px`;
          if (snap && tableRef.current) tableRef.current.style.width = `${snap.tableW + w - snap.widths[0]!}px`;
        };

        const onColEnd = (e: { pointerId: number }): void => {
          if (colDragSeed.current?.pointerId !== e.pointerId) return;
          colDragSeed.current = null;
          // 落库：commit 回 React state，由 `<colgroup>` 第 0 个 col 承接；定宽模式**保留**到换角色
          // （matrixKey 变）为止 ⇒ 松手不再触发「1 万节点样式失效 + 整表重排」那一下。
          if (lastColW.current !== null) setRowheadW(lastColW.current);
          toggleHandles(scrollRef.current, false);
        };

        /** 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入；缺省回退纯文本字形（绝不空白） */
        const ic = (name: string, size: number, fallback: string): ReactNode =>
          (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

        const toggleFace = (face: string): void => {
          setFoldedFaces((prev) => {
            const next = new Set(prev);
            if (next.has(face)) next.delete(face);
            else next.add(face);
            return next;
          });
        };

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          store.listeners.add(cb);
          return () => {
            store.listeners.delete(cb);
          };
        }, []);

        // 视口化路径：滚动即同步位置并重量可视高（分栏拖动会改变网格区高度）
        const onScroll = (e: ScrollEvent): void => {
          const box = e.currentTarget;
          setScrollTop(box.scrollTop);
          setViewportH((prev) => (prev === box.clientHeight ? prev : box.clientHeight));
        };

        // 视口化路径：量滚动容器可视高（首帧为 0 → 只画 overscan 行，量到后下一帧补全）。
        // 每帧重量：分栏拖动 / 面板改尺寸都会改网格区高度，窗口须随之收放。
        useEffect(() => {
          if (!virtualize) return;
          const h = scrollRef.current?.clientHeight ?? 0;
          setViewportH((prev) => (prev === h ? prev : h));
        });

        // 视口化路径：切换角色 / 改过滤后回到顶部——否则旧滚动位置可能落到新内容的窗口之外
        useEffect(() => {
          if (!virtualize) return;
          const box = scrollRef.current;
          if (box && box.scrollTop !== 0) box.scrollTop = 0;
          setScrollTop(0);
        }, [virtualize, selectedNo, deferredFilter]);

        // 视口化路径：跨窗口键盘导航——目标行滚进视野并重渲后，把焦点落到它的格子上
        // （未渲染出该格前一直挂账，绝不聚焦不存在的节点）
        useEffect(() => {
          const pf = pendingFocus.current;
          if (!pf) return;
          const cell = scrollRef.current?.querySelector(`.cm-cell[data-r="${pf.r}"][data-c="${pf.c}"]`);
          if (cell) {
            cell.focus();
            pendingFocus.current = null;
          }
        });

        /* --------- C1 反向下行：光标位点 → 矩阵高亮（判据全在 matrix-logic 的纯函数） --------- */

        /**
         * 最近一次光标位点（宿主 `editor.cursorMoved` 广播）。只留 文件 + 行 + 派生视图
         * 三件：同一行上的列级移动不该惊动面板（载荷变了、这里的判据没变 → 不重渲）。
         */
        const [cursorSight, setCursorSight] = useState<CursorSight | null>(null);
        useEffect(() => {
          const un = ctx.bus.on('editor.cursorMoved', (p) => {
            setCursorSight((prev) =>
              prev && prev.filePath === p.filePath && prev.line === p.line && prev.derivedView === p.derivedView
                ? prev
                : { filePath: p.filePath, line: p.line, derivedView: p.derivedView },
            );
          });
          return un;
        }, []);

        // 换文件即清高亮：新位点稍后才到（读盘 + 建 model），中间这一拍若留着旧文件
        // 的行号，就会拿它对上**别的文件**的机会去高亮（宁可清，不乱高亮）
        useEffect(() => {
          const un = ctx.bus.on('editor.activeFileChanged', () => setCursorSight(null));
          return un;
        }, []);

        /**
         * 光标行 → 函数祖先（区间包含，最紧一层）。数据取 `erb.parser` 当前索引的
         * 逐文件函数区间：`FunctionConditions` 没有 endLine、`functionPredicates`
         * 是按名现拉的异步明细（读盘）——光标路径上只能用同步索引。无位点 / 派生视图
         * （行号不属于真文件）/ 无索引 / 文件或行对不上 → null = 清高亮，不是错误。
         * depsEpoch：索引重建后同一光标位点的数据源变了，须重算（它正是索引代次）。
         */
        const cursorHit: FunctionRange | null = useMemo(() => {
          if (!cursorSight || cursorSight.derivedView || cursorSight.filePath === null) return null;
          const index = parser.currentIndex();
          if (!index) return null;
          // 直取索引键；不中再按 pathKey 扫一遍（大小写 / 分隔符写法差异）
          let file = index.files.get(cursorSight.filePath);
          if (!file) {
            const want = pathKey(cursorSight.filePath);
            for (const f of index.files.values()) {
              if (pathKey(f.path) === want) {
                file = f;
                break;
              }
            }
          }
          return file ? functionRangeAt(file.functions, cursorSight) : null;
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [cursorSight, store.depsEpoch]);

        /**
         * 光标高亮格的滚动跟随：只在**命中函数换人**时滚一次（nearest——已在视野内就不动）。
         * 目标格不在当前渲染窗口（视口化 / 超出全量上限）→ 静默跳过：面板的滚动位置是
         * 用户的，不为了跟随而劫持；也不按帧重滚（滚动重渲不会重触发本 effect）。
         */
        const cursorFollowRef = useRef<FunctionRange | null>(null);
        useEffect(() => {
          if (cursorHit === cursorFollowRef.current) return;
          cursorFollowRef.current = cursorHit;
          if (!cursorHit) return;
          scrollRef.current?.querySelector('.cm-cell.cur')?.scrollIntoView?.({ block: 'nearest' });
        }, [cursorHit]);

        /** 光标高亮格集合的手工记忆化仓（键 = 命中函数 + 矩阵；两者都是身份稳定的记忆化产物） */
        const cursorCellsRef = useRef<{
          hit: FunctionRange | null;
          matrix: ConditionMatrix | null;
          cells: ReadonlyMap<string, string>;
        } | null>(null);

        // 失败态优先：显示原因 + 重试（不静默停在占位）。可见文案给**中文原因**，
        // 原始错误串留在悬停 title 里——技术信息不丢，但不是甩给作者的第一眼。
        if (store.loadError) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement(
              'div',
              { className: 'cm-error', title: store.loadError },
              '条件矩阵加载失败：口上函数索引构建出错（悬停查看原始错误）',
            ),
            createElement('button', { className: 'small', onClick: () => store.refresh() }, '重试'),
          );
        }

        const current = project.current();
        if (!current) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '打开项目后可用（条件矩阵需要口上函数索引）'),
          );
        }

        const idx = store.characterIndex;
        if (idx && !idx.hasFamilyIndex) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '适配器未提供家族规则，无法按角色聚合条件矩阵'),
          );
        }

        if (!store.indexReady || !idx) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '正在构建函数索引…（首次打开项目需要数秒）'),
          );
        }

        const charas = [...idx.entries.values()].sort((a, b) => a.no - b.no);
        const entry = selectedNo === null ? null : idx.entries.get(selectedNo) ?? null;

        /** 角色下拉标签：`K{no} {name}` / `K{no}` 再缀函数数 */
        const charaLabel = (no: number, count: number): string => {
          const info = current.charaIndex.get(no);
          return `${info ? `K${no} ${info.name}` : `K${no}`}（${count}）`;
        };

        const charaSelect = createElement(
          'select',
          {
            className: 'cm-chara-select',
            value: selectedNo === null ? '' : String(selectedNo),
            onChange: (e: { target: { value: string } }) => {
              const v = e.target.value;
              setSelectedNo(v === '' ? null : Number(v));
              setSelected(null);
            },
          },
          createElement('option', { key: '', value: '' }, `选择角色（${charas.length}）`),
          ...charas.map((c) =>
            createElement('option', { key: c.no, value: String(c.no) }, charaLabel(c.no, c.functions.length)),
          ),
        );

        const filterInput = createElement('input', {
          className: 'cm-filter',
          type: 'search',
          placeholder: '过滤状态键 / 标签',
          value: filter,
          onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
        });

        const floatBtn = createElement(
          'button',
          {
            className: 'cm-float',
            title: '浮动到大窗口查看',
            onClick: () => ctx.bus.emit('ui.panel.float', { id: 'condition-matrix' }),
          },
          (props.renderIcon?.('popout', 14) as ReactNode) ?? '浮动',
        );
        // 已在浮窗里时不再渲染「浮动」入口（浮窗框自带拖动 / 缩放 / 停靠）
        const toolbar = createElement(
          'div',
          { className: 'cm-toolbar' },
          charaSelect,
          filterInput,
          props.floating ? null : floatBtn,
        );

        const status = createElement(
          'div',
          { className: 'cm-status dim' },
          `${idx.totalFunctions} 函数 · ${charas.length} 角色` +
            (idx.hasFamilyIndex ? ` · 未归属 ${idx.orphanCount}` : ' · 适配器未提供家族规则'),
        );

        // 指令承载面 → 每指令一列（按面分组、UI 可折叠）；非指令面整面成列。
        const instructionFaces = new Set(services.currentFamilyIndex()?.instructionFaces ?? []);
        const columnOf = (fn: FaceFunction): ColumnDesc => {
          if (!instructionFaces.has(fn.face)) return { key: fn.face, instructionNo: null };
          const no = instructionNoOfSlot(fn.match.slot);
          if (no === null) return { key: fn.face, instructionNo: null };
          const name = services.instructionTable()?.lookupByNo(no);
          // 表里查不到名字时给**可读中文兜底**（「指令 310」，与「时机 指令 310：」同词序）：
          // 裸 `#310` 是查表记号，作者读到的是又一个要背的格式。
          return { key: `${fn.face}#${no}`, instructionNo: no, label: name ?? `指令 ${no}` };
        };
        // 记忆化：选择 / 过滤 / 折叠 / 无关刷新都不重算矩阵，仅「角色 × 依赖版本 × 适配器」变化才重建
        const matrixKey = `${entry?.no}|${store.depsEpoch}|${current.adapterId}`;
        const matrix = entry
          ? store.matrixMemo.resolve(matrixKey, () =>
              buildMatrix(entry, services.depsOf, services.labelOf, services.faceLabels(), columnOf),
            )
          : null;

        // 光标命中函数贡献的格子（行键 → 列键；高亮只落在确实由它贡献的格上，判据在 matrix-logic）。
        // 手工记忆化（不能用 useMemo：matrix 在早退分支之后才算出来，hook 不能放那儿）：
        // 键 = 命中函数 + 矩阵两个记忆化产物（身份稳定）——滚动 / 无关重渲命中缓存，零重扫。
        const cursorCache = cursorCellsRef.current;
        let cursorCells: ReadonlyMap<string, string>;
        if (cursorCache && cursorCache.hit === cursorHit && cursorCache.matrix === matrix) {
          cursorCells = cursorCache.cells;
        } else {
          cursorCells = cursorHit && matrix ? cellKeysOfFunction(matrix, cursorHit) : NO_CURSOR_CELLS;
          cursorCellsRef.current = { hit: cursorHit, matrix, cells: cursorCells };
        }

        // ---- 定位（网格）----
        let grid: ReactNode;
        if (!entry || !matrix) {
          grid = createElement('div', { className: 'cm-empty dim' }, '从上方选择角色以浏览其状态 × 时机矩阵');
        } else if (matrix.rows.length === 0) {
          grid = createElement('div', { className: 'cm-empty dim' }, '该角色尚未抽取到状态条件（无状态依赖）');
        } else {
          const needle = deferredFilter.trim().toLowerCase();
          const rows = needle
            ? matrix.rows.filter(
                (r) => r.key.toLowerCase().includes(needle) || (r.label ?? '').toLowerCase().includes(needle),
              )
            : matrix.rows;
          const groups = matrix.groups;
          // 键盘导航上界：当前（过滤后）行数——跨窗口纵向移动时判「是否越过末行」
          rowCountRef.current = rows.length;

          const head = renderGridHead({
            groups: matrix.groups,
            foldedFaces,
            onToggleFace: toggleFace,
            ic,
            cornerRef,
          });

          const colCount = matrix.columns.length;
          // 首列列宽拖拽接管判据：快照的 matrixKey 须与当前一致（换角色 / 依赖版本即失效）且列数吻合。
          // 有效 ⇒ 表切 `table-layout: fixed` + `<colgroup>`（见 .cm-scroll.col-pinned）。
          const activeSnap =
            colSnap && colSnap.key === matrixKey && colSnap.widths.length === colCount + 1 ? colSnap : null;

          let body: ReactNode;
          let moreNotice: ReactNode = null;
          if (virtualize) {
            // 视口化：只渲染可见窗口（+上下 overscan），两段占位还原完整滚动高度——
            // 全部行都可浏览、可键盘到达，不再受 400 行上限约束。
            const win = computeViewportWindow(scrollTop, viewportH, MATRIX_ROW_H, rows.length, MATRIX_OVERSCAN);
            body = createElement(
              'tbody',
              { key: 'bd' },
              spacerRow(win.topPad, 'pad-top', colCount + 1),
              ...rows.slice(win.start, win.end).map((row, i) =>
                createElement(MatrixRowView, {
                  key: row.key,
                  row,
                  groups,
                  foldedFaces,
                  selectedColumn: selected && selected.rowKey === row.key ? selected.columnKey : null,
                  cursorColumn: cursorCells.get(row.key) ?? null,
                  rowIndex: win.start + i, // 绝对行索引（data-r 跨窗一致，方向键据此平移）
                  onCell,
                }),
              ),
              spacerRow(win.bottomPad, 'pad-bottom', colCount + 1),
            );
          } else {
            const shown = rows.slice(0, ROW_RENDER_CAP);
            body = createElement(
              'tbody',
              { key: 'bd' },
              ...shown.map((row, rowIndex) =>
                createElement(MatrixRowView, {
                  key: row.key,
                  row,
                  groups,
                  foldedFaces,
                  selectedColumn: selected && selected.rowKey === row.key ? selected.columnKey : null,
                  cursorColumn: cursorCells.get(row.key) ?? null,
                  rowIndex,
                  onCell,
                }),
              ),
            );
            if (rows.length > ROW_RENDER_CAP) {
              moreNotice = createElement(
                'div',
                { className: 'cm-more dim' },
                `其余 ${rows.length - ROW_RENDER_CAP} 行未显示（可用过滤缩小范围）`,
              );
            }
          }

          // 网格区 CSS 变量：行高常量唯一真源（视口化路径用）+ 首列拖拽宽度（HK-25，拖过才设）
          const gridStyle: Record<string, string> = {};
          if (virtualize) gridStyle['--cm-row-h'] = `${MATRIX_ROW_H}px`;
          // 定宽接管期由 `<colgroup>` 第 0 个 col 承接首列宽 ⇒ 不再设 var（设了会按继承失效整棵子树）。
          // 未接管（无有效快照）时仍走 var：这是「换角色后仍保留拖过的宽度」的唯一通道。
          if (rowheadW !== null && activeSnap === null) gridStyle['--cm-rowhead-w'] = `${rowheadW}px`;

          const colgroup = buildColgroup(activeSnap, rowheadW, colRef);
          // 接管期的**显式表宽**：没有它，定宽布局下浏览器会忽略 `<col>` 宽（首列拖了不动）。
          // 值 = 快照表宽 + (首列当前宽 - 首列原始宽) ⇒ 只动首列，其余列几何逐字不变。
          const colW0 = activeSnap ? rowheadW ?? activeSnap.widths[0]! : 0;
          const tableStyle: CSSProperties | undefined = activeSnap
            ? { width: `${activeSnap.tableW + colW0 - activeSnap.widths[0]!}px` }
            : undefined;

          grid = createElement(
            'div',
            {
              className:
                'cm-scroll' + (virtualize ? ' cm-virt' : '') + (activeSnap ? ' col-pinned' : ''),
              ref: scrollRef,
              onKeyDown: onGridKeyDown,
              // 首列拖拽 **委派**到本容器：把手遍布整列（角格 + 每个行头），行组件不持有 handler
              onPointerDown: onColDown,
              onPointerMove: onColMove,
              onPointerUp: onColEnd,
              onPointerCancel: onColEnd,
              onScroll: virtualize ? onScroll : undefined,
              // 未拖过时变量未设 ⇒ CSS 回退 auto（自然宽度，逐字不变）
              style: Object.keys(gridStyle).length > 0 ? (gridStyle as CSSProperties) : undefined,
            },
            createElement('table', { className: 'cm-table', ref: tableRef, style: tableStyle }, colgroup, head, body),
            moreNotice,
          );
        }

        // ---- 详情（选中格 → 详情区；呈现件见 ./detail-pane.ts）----
        const detail = renderDetail({
          matrix,
          selected,
          faceLabels: () => services.faceLabels(),
          detailH,
          detailRef,
          emitReveal: (target) => ctx.bus.emit('editor.revealLocation', target),
        });

        // 网格区 ↔ 详情区的拖拽分隔线（HK-14）：只在网格有内容时显形（无内容可拉伸时克制不出），
        // 静息一条细线，悬停 / 拖拽中亮起（与壳层 .resizer / .kp-splitter 同族）；键盘不接。
        const splitter =
          entry && matrix && matrix.rows.length > 0
            ? createElement('div', {
                className: 'cm-split' + (splitDragging ? ' dragging' : ''),
                role: 'separator',
                'aria-orientation': 'horizontal',
                'aria-label': '拖动调整详情区高度',
                title: '拖动调整详情区高度',
                onPointerDown: onSplitDown,
                onPointerMove: onSplitMove,
                onPointerUp: onSplitEnd,
                onPointerCancel: onSplitEnd,
              })
            : null;

        return createElement(
          'div',
          { className: 'panel-condition-matrix', ref: rootRef },
          toolbar,
          status,
          grid,
          splitter,
          detail,
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'condition-matrix',
        title: '条件矩阵',
        icon: 'matrix',
        order: 45,
        location: 'sidebar',
        defaultActive: true,
        component: ConditionMatrixPanel,
      });
    },
  };
}
