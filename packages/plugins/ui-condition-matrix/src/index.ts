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
  FileIO,
  GameProject,
  KojoInstructionTable,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateDependency,
  UIPanelProps,
  VariableSchema,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, pathKey, shortPath } from '@kojo/plugin-api';
import {
  buildCharacterIndex,
  buildCharaOptions,
  buildMatrix,
  cellKeysOfFunction,
  clampDetailHeight,
  clampRowheadWidth,
  createMatrixMemo,
  DETAIL_MIN_H,
  faceLabel,
  functionRangeAt,
  instructionNoOfSlot,
  planMatrixWindow,
  rowHasVisibleGap,
  rowHeightChanged,
  rowScrollTop,
  sameMatrixWindow,
  ROWHEAD_MIN_W,
  type CharacterEntry,
  type CharacterIndex,
  type ColumnDesc,
  type ConditionMatrix,
  type CursorSight,
  type FaceFunction,
  type FunctionRange,
  type MatrixCell,
  type MatrixCellFunction,
  type MatrixColumnGroup,
  type MatrixLayout,
  type MatrixRow,
} from './matrix-logic';
import { MatrixRowView, type RevealTarget } from './row-view';
import { buildColgroup, renderGridHead, spacerRow } from './grid-parts';
import { renderDetail } from './detail-pane';
import { createMatrixStore } from './matrix-store';
import { createAdapterServices } from './adapter-services';
import { CharaPicker, type CharaChoice } from './chara-picker';
import {
  CONDITION_MATRIX_FILL_OVERLAY_ID,
  createConditionMatrixFillOverlay,
  type FillDraft,
} from './fill-overlay';
import {
  EXTERNAL_PACK_KEY,
  collectAuthorPacks,
  coveragePercent,
  filterEntryByPack,
  gapCellsOfRows,
  matchWorkspacePacks,
  storyLineRows,
  type AuthorPack,
  type CellRef,
  type WorkspacePackRef,
} from './matrix-scope';
import { dominantFamilyOfEntry, dominantSelectorOfEntry, type FillPack } from './matrix-fill';
import { measureColSnap, toggleHandles } from './col-resize';
import {
  createSizeWatcher,
  getFrameScheduler,
  isFramePending,
  type ColResizePointer,
  type ColSnap,
  type FrameHandle,
  type FrameScheduler,
  type GridKeyEvent,
  type ScrollBox,
  type SplitterPointer,
} from './dom-shims';

/** 光标没命中任何格时的空集合（常量身份：无命中路径零分配，行 memo 也据此跳过） */
const NO_CURSOR_CELLS: ReadonlyMap<string, string> = new Map<string, string>();

/** 口上包下拉里「全部」的哨兵（包键 '' = 角色根目录，不能拿空串兼作「全部」） */
const ALL_PACKS = '\u0000all';
/** 行无填空选中时的空集合（常量身份，保住行 memo） */
const EMPTY_FILL_COLUMNS: ReadonlySet<string> = new Set<string>();

/** 填空选择键（行/列可能含任意字符；用 NUL 分隔避免拼接歧义） */
function fillCellKey(rowKey: string, columnKey: string): string {
  return `${rowKey}\u0000${columnKey}`;
}

export function createUiConditionMatrixPlugin(): Plugin {
  return {
    id: 'ui-condition-matrix',
    version: '0.1.0',
    requires: [
      WellKnownServices.ErbParser,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
      KernelServices.IO,
    ],
    activate(ctx) {
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const conditionExtractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);
      const io = ctx.inject<FileIO>(KernelServices.IO);
      /** 工作区服务（软依赖：缺席时「我的口上项目」标注与写源入口隐藏，矩阵本体照常） */
      const workspaces = ctx.tryInject<WorkspaceService>(KernelServices.Workspaces);

      // ---- 适配器查询面（家族规则 / 变量字典 / 指令表 / 标签）：见 ./adapter-services.ts ----
      const services = createAdapterServices({ project, slots, conditionExtractor });

      // ---- 外部状态源（索引重建 / 抽取代次 / 矩阵记忆化 / 事件订阅）：见 ./matrix-store.ts ----
      const store = createMatrixStore(ctx, {
        parser,
        project,
        conditionExtractor,
        services,
        ...(workspaces ? { workspaces } : {}),
      });

      /** 填格浮层的请求快照（面板打开前写入；overlay 组件无 props 参数通道） */
      let pendingFill: FillDraft | null = null;

      /* ------------------------------ 面板组件 ------------------------------ */

      function ConditionMatrixPanel(props: UIPanelProps): unknown {
        const [, force] = useState(0);
        const [selectedNo, setSelectedNo] = useState<number | null>(null);
        const [filter, setFilter] = useState('');
        const [selected, setSelected] = useState<{ rowKey: string; columnKey: string } | null>(null);
        /** 已折叠的大时机类面集合（默认全展开；点分组表头切换） */
        const [foldedFaces, setFoldedFaces] = useState<Set<string>>(new Set<string>());
        /** 口上包筛选：null = 全部口上包；'' = 角色根散文件；其余 = 包目录名 */
        const [packKey, setPackKey] = useState<string | null>(null);
        /** 填空模式（空白格可勾选）+ 已选格集合（键 = fillCellKey） */
        const [fillMode, setFillMode] = useState(false);
        const [fillSel, setFillSel] = useState<Set<string>>(new Set<string>());
        /** 生成模板的目标口上包（null = 自动取当前筛选包 / 第一个可写包） */
        const [fillTargetKey, setFillTargetKey] = useState<string | null>(null);
        /** 只看有缺口的行（按当前可见列算） */
        const [gapOnly, setGapOnly] = useState(false);
        /** 一次性提示（剧情线无命中 / 生成前拦截等）——只显示，不拦矩阵本体 */
        const [notice, setNotice] = useState<string | null>(null);
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
        /** 填空模式的最新读数（onCell 是稳定引用，靠 ref 读模式，避免整表重渲） */
        const fillModeRef = useRef(false);
        fillModeRef.current = fillMode;
        /** 填空选择 → 每行 Set 的缓存（键 = 选择签名；滚动帧不重建 Set，行 memo 稳定） */
        const fillSetsRef = useRef<{
          sig: string;
          byRow: Map<string, Set<string>>;
        } | null>(null);
        /** 选择集签名缓存：Set 身份不变就不重排序（滚动帧每帧都会走到这里） */
        const fillSigCacheRef = useRef<{ sel: ReadonlySet<string>; sig: string } | null>(null);

        /**
         * 行视口化：**有矩阵就开**（宿主偏好只是额外兜底）。按函数数猜阈值会漏判
         * ——30 个函数也可能铺出几百行状态 × 上百列，整表 DOM 一旦落下，滚动、
         * 「只看空缺」、填格模式切换都会重渲整张表；视口化对再小的表也只是多一次
         * 窗口计算，对任何规模都安全。
         */
        const autoEntry =
          selectedNo === null ? null : store.characterIndex?.entries.get(selectedNo) ?? null;
        const virtualize = autoEntry !== null || props.uiPrefs?.panelVirtualize === true;
        /** 滚动位置（仅窗口计算用）——**按帧合并**且只在跨行时落 state */
        const [scrollTop, setScrollTop] = useState(0);
        /** 滚动容器可视高（视口化路径算窗口用；首帧未量到 → 0，仅画 overscan 行） */
        const [viewportH, setViewportH] = useState(0);
        /**
         * **实测**行高（px；null = 还没量到 ⇒ `planMatrixWindow` 回退 `MATRIX_ROW_H`）。
         *
         * PS-7 的正确性修复：字号 / 缩放偏好一改，行就比 22px 高，占位块按 22 算会把
         * 「滚到哪一行」和「画出哪一行」彻底错开。真源是首行的 rect 高，不是常量。
         */
        const [measuredRowH, setMeasuredRowH] = useState<number | null>(null);
        /** 几何读数镜像：滚动 rAF 回调里判断窗口用，避免闭包里拿到旧 state */
        const viewportHRef = useRef(0);
        viewportHRef.current = viewportH;
        const measuredRowHRef = useRef<number | null>(null);
        measuredRowHRef.current = measuredRowH;
        /** 跨窗口键盘导航待聚焦的格子（渲染出该格后由 effect 落焦点，绝不聚焦不存在的节点） */
        const pendingFocus = useRef<{ r: number; c: number } | null>(null);
        /** 上面那笔挂账的**渲染信号**（effect 只在有账时跑，不再每帧空转一次 querySelector） */
        const [focusPending, setFocusPending] = useState(false);
        /** 当前（过滤后）行数——键盘导航判上界用 */
        const rowCountRef = useRef(0);
        /** 滚动位置的最新读数（rAF 那帧才抬 state：一帧多次 scroll 事件只重算一次窗口） */
        const scrollTopRef = useRef(0);
        const scrollFrameRef = useRef<FrameHandle>(null);
        /** 尺寸观察器的重量帧（与滚动帧各自一条句柄，卸载时都撤） */
        const geometryFrameRef = useRef<FrameHandle>(null);
        /** 逐帧调度器（跨渲染持有同一份；卸载时把排上的帧撤干净） */
        const frameRef = useRef<FrameScheduler | null>(null);
        /** 组件是否已卸载（rAF 回调可能比组件活得久；StrictMode 重挂载时由 setup 相位复位） */
        const unmountedRef = useRef(false);
        /**
         * 本帧算出的视口化布局（行高真源）。键盘跨窗跳转要按**同一把尺**把目标行顶到视口上沿，
         * 自己再乘一个常量就是第二套口径（PS-7 修的就是这第二套）。渲染期镜像，null = 还没布局。
         */
        const layoutRef = useRef<MatrixLayout | null>(null);

        /**
         * 点击格子：发跳转意图 + 落选中态（稳定引用 → 行 memo 生效）。
         * 填空模式拦截跳转：空白格切换「选入草稿」，已填格只更新详情（作者在挑格时
         * 误触已填格不应把编辑器带走）。
         */
        const onCell = useCallback(
          (rowKey: string, columnKey: string, target: RevealTarget | null, present: boolean): void => {
            setSelected({ rowKey, columnKey });
            if (fillModeRef.current) {
              if (present) return;
              const key = fillCellKey(rowKey, columnKey);
              setFillSel((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
              setNotice(null);
              return;
            }
            if (target) {
              ctx.bus.emit('editor.revealLocation', {
                filePath: target.filePath,
                line: target.line,
                source: target.source,
              });
            }
          },
          [],
        );

        /** 退出填空模式（清空选择，避免隐藏状态在下次进入时突然出现） */
        const exitFillMode = useCallback((): void => {
          setFillMode(false);
          setFillSel(new Set<string>());
          setNotice(null);
        }, []);

        /** 网格方向键导航：格子带 data-r/data-c，按渲染序上下左右移动焦点（折叠组的空 td 不参与） */
        const onGridKeyDown = (e: GridKeyEvent): void => {
          if (e.key === 'Escape' && fillModeRef.current) {
            e.preventDefault();
            exitFillMode();
            return;
          }
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
          // 目标行的落点由**同一把尺**算：优先用本帧布局（窗口与占位就是按它排的）；
          // 首帧还没布局过时按实测行高现算一次——两处都不许自己乘一个常量。
          const layout = layoutRef.current ?? planMatrixWindow(0, 0, rowCountRef.current, measuredRowH);
          box.scrollTop = rowScrollTop(layout, tr);
          scrollTopRef.current = box.scrollTop;
          setScrollTop(box.scrollTop);
          pendingFocus.current = { r: tr, c: tc };
          setFocusPending(true);
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

        // 视口化路径：一次读数 = 可视高 + **真实行高**（首行 rect 高）。
        // 行高不取常量：字号 / 缩放偏好一改，22px 就成了假尺子，占位块与真实行错位
        // ——滚到第 100 行、画出来的是第 109 行（PS-7 的头号正确性修复）。
        const readGeometry = (): void => {
          const box = scrollRef.current;
          if (!box) return;
          const h = box.clientHeight;
          setViewportH((prev) => (prev === h ? prev : h));
          const row = box.querySelector('tbody tr:not(.cm-spacer)');
          if (!row) return;
          const rh = row.getBoundingClientRect().height;
          // 亚像素抖动不值得一次全表重渲：超过 0.5px 才算"行高变了"（判据在 matrix-logic）
          setMeasuredRowH((prev) => (rowHeightChanged(prev, rh) ? rh : prev));
        };

        /** 排一帧重量（同一帧里多次触发只读一次） */
        const scheduleGeometry = (): void => {
          if (isFramePending(geometryFrameRef.current)) return;
          const frame = (frameRef.current ??= getFrameScheduler());
          geometryFrameRef.current = frame.request(() => {
            geometryFrameRef.current = null;
            if (unmountedRef.current) return;
            readGeometry();
          });
        };

        // 视口化路径：滚动**按帧合并**，且只在**窗口行区间变化**时抬 state。
        // 同一行窗口内滚动（绝大多数 scroll 事件）内容与占位都不变——让浏览器自己滚，
        // 不重渲面板；跨过一行才换 tbody。逐帧 readGeometry 也在这里去掉：行高/可视高
        // 由尺寸观察器负责，滚动本身不会改变它们。
        const onScroll = (): void => {
          const box = scrollRef.current;
          if (!box) return;
          const next = box.scrollTop;
          scrollTopRef.current = next;
          const rendered = layoutRef.current;
          if (rendered) {
            const candidate = planMatrixWindow(next, viewportH, rowCountRef.current, measuredRowH);
            if (sameMatrixWindow(candidate.win, rendered.win)) return;
          }
          if (isFramePending(scrollFrameRef.current)) return;
          const frame = (frameRef.current ??= getFrameScheduler());
          scrollFrameRef.current = frame.request(() => {
            scrollFrameRef.current = null;
            if (unmountedRef.current) return;
            const latest = scrollTopRef.current;
            const last = layoutRef.current;
            if (last) {
              const candidate = planMatrixWindow(
                latest,
                viewportHRef.current,
                rowCountRef.current,
                measuredRowHRef.current,
              );
              if (sameMatrixWindow(candidate.win, last.win)) return;
            }
            setScrollTop((prev) => (prev === latest ? prev : latest));
          });
        };

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          store.listeners.add(cb);
          return () => {
            store.listeners.delete(cb);
          };
        }, []);

        // 视口化路径：可视高与行高都交给尺寸观察器（分栏拖动 / 面板改尺寸 / 字号 / 缩放一改就重量）。
        // 观察两处：滚动容器（可视高）与 `<tbody>`（行高一变，表体总高必变）。
        // `selectedNo` 进依赖是挂载时机：网格只在选中角色后才出现，那一拍 `scrollRef` 才有节点可挂。
        useEffect(() => {
          if (!virtualize) return;
          const box = scrollRef.current;
          if (!box) return;
          let cancelled = false;
          const watcher = createSizeWatcher(() => {
            if (!cancelled) scheduleGeometry();
          });
          if (watcher) {
            watcher.observe(box);
            const body = box.querySelector('tbody');
            if (body) watcher.observe(body);
          }
          scheduleGeometry(); // 首帧先量一次（观察器只报"变化"，不报初值）
          return () => {
            cancelled = true;
            watcher?.disconnect();
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [virtualize, selectedNo]);

        // 卸载后不要再抬 state（观察器 / rAF 的回调都可能比组件活得久）
        useEffect(() => {
          unmountedRef.current = false; // StrictMode 的"卸载再挂载"要复位
          return () => {
            unmountedRef.current = true;
            const frame = frameRef.current ?? getFrameScheduler();
            for (const handle of [scrollFrameRef.current, geometryFrameRef.current]) {
              if (isFramePending(handle)) frame.cancel(handle);
            }
            scrollFrameRef.current = null;
            geometryFrameRef.current = null;
          };
        }, []);

        // 切换角色 / 口上包 / 改过滤 / 视口化开关翻转后回到顶部——否则旧滚动位置
        // 可能落到新内容的窗口之外（大角色 → 小角色时尤其明显：新表更短，视口停在旧深处）
        useEffect(() => {
          const box = scrollRef.current;
          if (box && box.scrollTop !== 0) box.scrollTop = 0;
          scrollTopRef.current = 0;
          setScrollTop(0);
        }, [virtualize, selectedNo, packKey, deferredFilter, gapOnly]);

        // 筛选/角色/包一变，已勾选的空格可能落到视野外或不再是空格：清掉草稿，别让
        // 「已选 37 格」里混着看不见的旧状态
        useEffect(() => {
          setFillSel(new Set<string>());
          setNotice(null);
        }, [selectedNo, packKey, deferredFilter, gapOnly]);

        // 视口化路径：跨窗口键盘导航——目标行滚进视野并重渲后，把焦点落到它的格子上
        // （有账才查，无账零成本；账本 `focusPending` 是 state ⇒ 重渲到目标行出现为止）
        useEffect(() => {
          if (!focusPending) return;
          const pf = pendingFocus.current;
          if (!pf) {
            setFocusPending(false);
            return;
          }
          const cell = scrollRef.current?.querySelector(`.cm-cell[data-r="${pf.r}"][data-c="${pf.c}"]`);
          if (!cell) return; // 还没渲染出这一格：继续挂账，绝不聚焦不存在的节点
          cell.focus();
          pendingFocus.current = null;
          setFocusPending(false);
        }, [focusPending, scrollTop, viewportH, measuredRowH]);

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

        /** 角色搜索器的手工记忆化仓（键 = 角色索引实例 + 角色名字典；见下方构建处） */
        const charasCacheRef = useRef<{
          idx: CharacterIndex;
          charaIndex: unknown;
          count: number;
          choices: CharaChoice[];
        } | null>(null);

        /** 口上包清单 / 工作区匹配的手工记忆化仓（键 = 角色聚合 + 角色目录 + 工作区清单） */
        const packsCacheRef = useRef<{
          entry: CharacterEntry;
          charaDir: string | undefined;
          roots: readonly string[];
          packs: AuthorPack[];
        } | null>(null);
        const minePacksRef = useRef<{
          packs: readonly AuthorPack[];
          projects: readonly WorkspaceProject[];
          map: ReadonlyMap<string, WorkspacePackRef>;
        } | null>(null);

        /** 过滤后行清单的手工记忆化仓（键 = 矩阵 + 过滤词 + 缺口模式 + 可见列） */
        const rowsFilterRef = useRef<{
          matrix: ConditionMatrix;
          needle: string;
          gapOnly: boolean;
          visibleSig: string;
          rows: MatrixRow[];
        } | null>(null);

        /** 网格表头元素缓存：矩阵 / 折叠集不变就复用同一棵元素树（滚动帧不重造数百列） */
        const headCacheRef = useRef<{
          matrix: ConditionMatrix;
          folded: ReadonlySet<string>;
          node: ReactNode;
        } | null>(null);
        /** 详情区元素缓存：滚动帧不重跑行/列查找、函数排序与整段子树的 React diff */
        const detailCacheRef = useRef<{
          matrix: ConditionMatrix | null;
          selected: { readonly rowKey: string; readonly columnKey: string } | null;
          detailH: number | null;
          fillMode: boolean;
          fillSelected: boolean;
          node: ReactNode;
        } | null>(null);

        /** 切换角色时把口上包与生成目标复位（旧包键可能在新角色里不存在） */
        useEffect(() => {
          setPackKey(null);
          setFillTargetKey(null);
        }, [selectedNo]);

        const stateIcon = (name: string, fallback: string): ReactNode =>
          (props.renderIcon?.(name, 20) as ReactNode | undefined) ?? fallback;

        // 失败态优先：显示原因 + 重试（不静默停在占位）。可见文案给**中文原因**，
        // 原始错误串留在悬停 title 里——技术信息不丢，但不是甩给作者的第一眼。
        if (store.loadError) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement(
              'div',
              { className: 'cm-state cm-state-error' },
              createElement('div', { className: 'cm-state-icon' }, stateIcon('warning', '⚠')),
              createElement('div', { className: 'cm-state-title' }, '条件矩阵加载失败'),
              createElement(
                'div',
                { className: 'cm-state-text dim', title: store.loadError },
                '口上函数索引构建出错。原始错误在悬停提示里；修好后可重试。',
              ),
              createElement(
                'button',
                { className: 'small', type: 'button', onClick: () => store.refresh() },
                '重试',
              ),
            ),
          );
        }

        const current = project.current();
        if (!current) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement(
              'div',
              { className: 'cm-state' },
              createElement('div', { className: 'cm-state-icon' }, stateIcon('matrix', '▦')),
              createElement('div', { className: 'cm-state-title' }, '打开项目后可用'),
              createElement(
                'div',
                { className: 'cm-state-text dim' },
                '条件矩阵从口上函数索引里聚合「状态 × 时机」。打开一个游戏项目，索引就绪后这里会自动出现角色与矩阵。',
              ),
            ),
          );
        }

        const idx = store.characterIndex;
        if (idx && !idx.hasFamilyIndex) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement(
              'div',
              { className: 'cm-state' },
              createElement('div', { className: 'cm-state-icon' }, stateIcon('info', 'ℹ')),
              createElement('div', { className: 'cm-state-title' }, '当前适配器没有家族规则'),
              createElement(
                'div',
                { className: 'cm-state-text dim' },
                '条件矩阵需要把函数名解析成「角色 × 时机」。当前游戏的适配器没有提供 functionFamilyIndex，无法按角色聚合；不是项目坏了。',
              ),
            ),
          );
        }

        if (!store.indexReady || !idx) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement(
              'div',
              { className: 'cm-state' },
              createElement('div', { className: 'cm-state-icon cm-spin' }, stateIcon('refresh', '↻')),
              createElement('div', { className: 'cm-state-title' }, '正在构建函数索引…'),
              createElement(
                'div',
                { className: 'cm-state-text dim' },
                '首次打开项目需要数秒；语料很大时会更久。构建完成后会自动显示角色与矩阵，不需要手动刷新。',
              ),
            ),
          );
        }

        const entry = selectedNo === null ? null : idx.entries.get(selectedNo) ?? null;

        /**
         * 角色搜索器数据的**记忆化**产物（PS-7）：角色索引实例与角色名字典都不变时，
         * 排序与 ~250 条选项一次构建、逐帧复用。
         *
         * 手工记忆而非 `useMemo`：它在早退分支之后，hook 不能放那儿（同 `cursorCellsRef` 的口径）。
         */
        const charasCache = charasCacheRef.current;
        let charasMemo = charasCache;
        if (!charasMemo || charasMemo.idx !== idx || charasMemo.charaIndex !== current.charaIndex) {
          // 角色清单 = 游戏角色表 ∪ 已有函数的角色（前者是全集：0 函数的角色也要能看到，
          // 「还没有口上」本身就是最大的缺口；索引里多出来的编号也一个不漏）。
          const choices = buildCharaOptions(
            current.charaIndex.values(),
            [...idx.entries.values()].map((c) => ({ no: c.no, count: c.functions.length })),
          );
          charasMemo = {
            idx,
            charaIndex: current.charaIndex,
            count: choices.length,
            choices,
          };
          charasCacheRef.current = charasMemo;
        }

        /** 当前角色的口上目录（口上包归属的锚；无目录时按索引根兜底，见 matrix-scope） */
        const charaDir = selectedNo === null ? undefined : current.charaIndex.get(selectedNo)?.kojoDir;

        // ---- 口上包清单（含「我的口上项目」匹配）：见 ./matrix-scope.ts ----
        let packs: AuthorPack[];
        const packsCache = packsCacheRef.current;
        if (
          !packsCache ||
          packsCache.entry !== entry ||
          packsCache.charaDir !== charaDir ||
          packsCache.roots !== current.kojoPaths
        ) {
          packs = entry ? collectAuthorPacks(entry, charaDir, current.kojoPaths) : [];
          packsCacheRef.current = entry
            ? { entry, charaDir, roots: current.kojoPaths, packs }
            : null;
        } else {
          packs = packsCache.packs;
        }

        const mineCache = minePacksRef.current;
        let mineMap: ReadonlyMap<string, WorkspacePackRef>;
        if (!mineCache || mineCache.packs !== packs || mineCache.projects !== store.workspaceProjects) {
          mineMap = matchWorkspacePacks(packs, store.workspaceProjects, (id) => store.projectDir(id));
          minePacksRef.current = { packs, projects: store.workspaceProjects, map: mineMap };
        } else {
          mineMap = mineCache.map;
        }
        /** 状态里的包键可能来自上一个角色：不在当前清单就当「全部」（不静默筛出空表） */
        const effectivePackKey =
          packKey !== null && packs.some((p) => p.key === packKey) ? packKey : null;

        const packOption = (pack: AuthorPack): ReactNode => {
          const mine = mineMap.get(pack.key);
          return createElement(
            'option',
            { key: pack.key || '\u0000root', value: pack.key },
            `${pack.label}（${pack.functionCount}）` + (mine ? ` · 我的：${mine.artifactName}` : ''),
          );
        };
        const minePacks = packs.filter((p) => mineMap.has(p.key));
        const otherPacks = packs.filter((p) => !mineMap.has(p.key));
        const packSelect = createElement(
          'select',
          {
            className: 'cm-pack-select',
            value: effectivePackKey ?? ALL_PACKS,
            disabled: packs.length === 0,
            title:
              store.workspaceError !== null
                ? `我的口上项目读取失败：${store.workspaceError}`
                : minePacks.length > 0
                  ? `我的口上项目：${minePacks.map((p) => mineMap.get(p.key)?.artifactName ?? p.label).join('、')}`
                  : '按作者口上包筛选（第一层子目录）',
            onChange: (e: { target: { value: string } }) => {
              const v = e.target.value;
              const next = v === ALL_PACKS ? null : v;
              setPackKey(next);
              setFillTargetKey(next !== null && next !== EXTERNAL_PACK_KEY ? next : null);
              setSelected(null);
              setNotice(null);
            },
          },
          createElement('option', { key: ALL_PACKS, value: ALL_PACKS }, `全部口上包（${packs.length}）`),
          minePacks.length > 0
            ? createElement(
                'optgroup',
                { key: 'mine', label: '我的口上项目' },
                ...minePacks.map(packOption),
              )
            : null,
          otherPacks.length > 0
            ? createElement(
                'optgroup',
                { key: 'other', label: minePacks.length > 0 ? '其它口上包' : '口上包' },
                ...otherPacks.map(packOption),
              )
            : null,
        );

        const filterInput = createElement('input', {
          className: 'cm-filter',
          type: 'search',
          placeholder: '过滤状态键 / 标签',
          value: filter,
          onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
        });

        const toggleChip = (
          label: string,
          on: boolean,
          onClick: () => void,
          title: string,
        ): ReactNode =>
          createElement(
            'button',
            {
              className: 'cm-toggle' + (on ? ' on' : ''),
              type: 'button',
              'aria-pressed': on,
              title,
              onClick,
            },
            on ? createElement('span', { className: 'cm-toggle-mark' }, '✓') : null,
            label,
          );

        const floatBtn = createElement(
          'button',
          {
            className: 'cm-float',
            title: '浮动到大窗口查看',
            onClick: () => ctx.bus.emit('ui.panel.float', { id: 'condition-matrix' }),
          },
          (props.renderIcon?.('popout', 14) as ReactNode) ?? '浮动',
        );

        const toolbar = createElement(
          'div',
          { className: 'cm-toolbar' },
          createElement(
            'div',
            { className: 'cm-toolbar-row cm-toolbar-top' },
            createElement(CharaPicker, {
              choices: charasMemo.choices,
              value: selectedNo,
              onChange: (no: number | null) => {
                setSelectedNo(no);
                setSelected(null);
                setNotice(null);
              },
              renderIcon: props.renderIcon,
            }),
            packSelect,
          ),
          createElement(
            'div',
            { className: 'cm-toolbar-row cm-toolbar-bottom' },
            filterInput,
            toggleChip('只看空缺', gapOnly, () => setGapOnly((v) => !v), '只显示在当前可见时机上仍有空缺的状态行；已填格会淡出，空缺一眼可见'),
            toggleChip(
              '填格子',
              fillMode,
              () => {
                if (fillModeRef.current) exitFillMode();
                else {
                  setFillMode(true);
                  setNotice(null);
                }
              },
              '把空缺补成口上函数骨架：点空缺格选中 → 选写入包 → 生成模板，时机与条件自动写好，台词由你填（Esc 退出）',
            ),
            props.floating ? null : floatBtn,
          ),
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
        // 记忆化：选择 / 过滤 / 折叠 / 无关刷新都不重算矩阵；角色 × 依赖版本 × 适配器 × 口上包变化才重建。
        // 按包查看时列/行仍取全角色（整列缺席、别人写过而我方没写都能看见），只有填色来自该包。
        const matrixKey =
          `${entry?.no}|${store.depsEpoch}|${current.adapterId}|` +
          (effectivePackKey === null ? 'p:<all>' : `p:${effectivePackKey}`);
        const matrix = entry
          ? store.matrixMemo.resolve(matrixKey, () => {
              const scoped =
                effectivePackKey === null
                  ? entry
                  : filterEntryByPack(entry, effectivePackKey, charaDir, current.kojoPaths);
              return buildMatrix(
                scoped,
                services.depsOf,
                services.labelOf,
                services.faceLabels(),
                columnOf,
                effectivePackKey === null ? undefined : { columnsFrom: entry, rowsFrom: entry },
              );
            })
          : null;

        // ---- 状态条：全局读数 + 当前作用域覆盖率 ----
        const pct = matrix ? coveragePercent(matrix.filledCells, matrix.totalCells) : 0;
        const status = createElement(
          'div',
          { className: 'cm-status' },
          createElement(
            'div',
            { className: 'cm-status-main' },
            createElement('span', { className: 'cm-stat' }, `${idx.totalFunctions} 函数`),
            createElement('span', { className: 'cm-stat-sep dim' }, '·'),
            createElement('span', { className: 'cm-stat' }, `${charasMemo.count} 角色`),
            matrix
              ? createElement(
                  'span',
                  { className: 'cm-stat cm-stat-scope' },
                  effectivePackKey === null
                    ? '全部口上包'
                    : packs.find((p) => p.key === effectivePackKey)?.label ?? '口上包',
                )
              : null,
            minePacks.length > 0
              ? createElement(
                  'span',
                  { className: 'cm-stat cm-stat-mine', title: '工作区 artifact 目录名与本项目包目录同名' },
                  `我的口上项目 ${minePacks.length}`,
                )
              : null,
            store.workspaceLoading
              ? createElement('span', { className: 'cm-stat dim' }, '读取我的口上项目…')
              : store.workspaceError !== null
                ? createElement(
                    'span',
                    { className: 'cm-stat cm-stat-warn', title: store.workspaceError },
                    '我的口上项目读取失败',
                  )
                : null,
          ),
          matrix
            ? createElement(
                'div',
                { className: 'cm-status-cov', title: `已填 ${matrix.filledCells} / 总 ${matrix.totalCells} 格` },
                createElement(
                  'span',
                  { className: 'cm-cov-bar', 'aria-hidden': 'true' },
                  createElement('span', { className: 'cm-cov-fill', style: { width: `${pct}%` } }),
                ),
                createElement('span', { className: 'cm-cov-pct' }, `${pct}%`),
                createElement(
                  'button',
                  {
                    className:
                      'cm-gap-count' + (matrix.gapCells > 0 ? ' has-gap' : '') + (gapOnly ? ' on' : ''),
                    type: 'button',
                    title: gapOnly ? '正在只看空缺，点击显示全部' : '只看空缺（只显示仍有空缺的状态行）',
                    'aria-pressed': gapOnly,
                    onClick: () => setGapOnly((v) => !v),
                  },
                  `${matrix.gapCells} 空缺`,
                ),
              )
            : null,
        );

        /** 当前展开（可见）的列——「只看缺口」、剧情线选格、填空生成提示都按它算 */
        const visibleColumns = matrix ? matrix.columns.filter((c) => !foldedFaces.has(c.face)) : [];
        const visibleColumnKeys = visibleColumns.map((c) => c.key);

        // ---- 填空条：目标包 / 剧情线 / 生成入口 ----
        const fillTargets = packs.filter((p) => !p.isExternal && p.dirPath !== null);
        const fillTarget =
          (fillTargetKey !== null ? fillTargets.find((p) => p.key === fillTargetKey) : undefined) ??
          (effectivePackKey !== null ? fillTargets.find((p) => p.key === effectivePackKey) : undefined) ??
          fillTargets[0] ??
          null;

        const fillTargetSelect = createElement(
          'select',
          {
            className: 'cm-fill-target',
            value: fillTarget?.key ?? '',
            disabled: fillTargets.length <= 1,
            title: '模板写入哪个口上包（我的口上项目会优先生成到工作区源文件）',
            onChange: (e: { target: { value: string } }) => {
              setFillTargetKey(e.target.value);
              setNotice(null);
            },
          },
          fillTarget === null
            ? createElement('option', { key: '', value: '' }, '无可写口上包')
            : null,
          ...fillTargets.map((p) => {
            const mine = mineMap.get(p.key);
            return createElement(
              'option',
              { key: p.key || '\u0000root', value: p.key },
              `${p.label}${mine ? ` · 我的：${mine.artifactName}` : ''}`,
            );
          }),
        );

        const applyStoryLine = (preset: { id: string; label: string; description?: string; keys: readonly string[] }): void => {
          if (!matrix) return;
          const rows = storyLineRows(matrix, preset);
          if (rows.length === 0) {
            setNotice(`「${preset.label}」：当前角色的状态里没有匹配的状态键。`);
            return;
          }
          const rowKeys = new Set(rows.map((r) => r.key));
          const refs = gapCellsOfRows(matrix, rowKeys, visibleColumnKeys);
          if (refs.length === 0) {
            setNotice(`「${preset.label}」：当前筛选/可见时机下没有空缺。`);
            return;
          }
          setFillMode(true);
          setFillSel((prev) => {
            const next = new Set(prev);
            for (const ref of refs) next.add(fillCellKey(ref.rowKey, ref.columnKey));
            return next;
          });
          setNotice(`已选中「${preset.label}」的 ${refs.length} 个空缺——可继续手动增减。`);
        };

        const openFill = (): void => {
          if (!entry || !matrix) return;
          if (fillSel.size === 0) {
            setNotice('先在「填格子」模式下选中至少一个空缺（点矩阵里的 + 格）。');
            return;
          }
          if (!fillTarget) {
            setNotice('没有可写入的口上包：角色没有口上目录，或只有索引外文件。');
            return;
          }
          const targetEntry = filterEntryByPack(entry, fillTarget.key, charaDir, current.kojoPaths);
          const targetMatrixKey =
            `${entry.no}|${store.depsEpoch}|${current.adapterId}|fill:${fillTarget.key}`;
          const targetMatrix = store.matrixMemo.resolve(targetMatrixKey, () =>
            buildMatrix(
              targetEntry,
              services.depsOf,
              services.labelOf,
              services.faceLabels(),
              columnOf,
              { columnsFrom: entry, rowsFrom: entry },
            ),
          );
          const cells: CellRef[] = [];
          for (const key of fillSel) {
            const at = key.indexOf('\u0000');
            if (at < 0) continue;
            cells.push({ rowKey: key.slice(0, at), columnKey: key.slice(at + 1) });
          }
          const faceTable = services.faceTable();
          const workspace = mineMap.get(fillTarget.key);
          const draft: FillDraft = {
            chara: {
              no: entry.no,
              name: current.charaIndex.get(entry.no)?.name ?? `K${entry.no}`,
            },
            pack: {
              key: fillTarget.key,
              dirName: fillTarget.dirName,
              label: fillTarget.label,
              dirPath: fillTarget.dirPath,
              family: dominantFamilyOfEntry(targetEntry),
              selector: dominantSelectorOfEntry(targetEntry),
            },
            matrix: targetMatrix,
            cells,
            ...(faceTable ? { faceTable } : {}),
            ...(workspace ? { workspace } : {}),
            io,
            ...(workspaces ? { workspaces } : {}),
            reveal: (path: string, line: number) =>
              ctx.bus.emit('editor.revealLocation', { filePath: path, line, source: '条件矩阵' }),
            onWritten: () => {
              setFillSel(new Set<string>());
              setNotice('模板已写入并打开——在模板里填台词即可。');
            },
            close: () =>
              ctx.bus.emit('ui.overlay.close', {
                id: CONDITION_MATRIX_FILL_OVERLAY_ID,
                source: 'ui-condition-matrix',
              }),
          };
          pendingFill = draft;
          ctx.bus.emit('ui.overlay.open', {
            id: CONDITION_MATRIX_FILL_OVERLAY_ID,
            source: 'ui-condition-matrix',
          });
        };

        // 常驻一行术语解释：新人不必先点开「填格子」才知道空缺和它能做什么
        const entryHint =
          matrix && !fillMode
            ? createElement(
                'div',
                { className: 'cm-entry-hint dim' },
                createElement('span', { className: 'cm-entry-hint-mark', 'aria-hidden': 'true' }, '·'),
                '空缺 = 此时机还没有针对该状态的响应。点「填格子」可把空缺批量补成口上函数骨架，台词由你填。',
              )
            : null;

        const storyPresets = services.stateLinePresets();
        const fillBar = fillMode
          ? createElement(
              'div',
              { className: 'cm-fillbar' },
              createElement(
                'div',
                { className: 'cm-fill-guide' },
                createElement(
                  'span',
                  { className: 'cm-fill-guide-what' },
                  createElement('strong', null, '填格子 = 把空缺补成模板'),
                  '——把选中的空缺生成口上函数骨架：时机与条件自动写好，你只需在生成的文件里填台词。',
                ),
                createElement(
                  'span',
                  { className: 'cm-fill-guide-steps' },
                  createElement('b', null, '①'),
                  ' 点空缺格选中 ',
                  createElement('span', { className: 'cm-fill-guide-arrow dim' }, '→'),
                  createElement('b', null, '②'),
                  ' 选写入包 ',
                  createElement('span', { className: 'cm-fill-guide-arrow dim' }, '→'),
                  createElement('b', null, '③'),
                  ' 生成模板并写入',
                ),
              ),
              createElement(
                'div',
                { className: 'cm-fillbar-row' },
                createElement('span', { className: 'cm-fillbar-title' }, '填格子'),
                createElement(
                  'span',
                  { className: 'cm-fillbar-count' + (fillSel.size > 0 ? ' has' : '') },
                  `已选 ${fillSel.size} 格`,
                ),
                createElement('span', { className: 'cm-fillbar-write dim' }, '写入'),
                fillTargetSelect,
                createElement(
                  'button',
                  {
                    className: 'cm-fillbar-btn',
                    type: 'button',
                    disabled: fillSel.size === 0,
                    title: '清空已选格子',
                    onClick: () => setFillSel(new Set<string>()),
                  },
                  '清空',
                ),
                createElement(
                  'button',
                  {
                    className: 'small primary cm-fillbar-go',
                    type: 'button',
                    disabled: fillSel.size === 0 || fillTarget === null,
                    title: '生成可填台词的口上函数骨架（时机与条件自动写好）',
                    onClick: openFill,
                  },
                  '生成模板…',
                ),
                createElement(
                  'button',
                  {
                    className: 'ghost small cm-fillbar-exit',
                    type: 'button',
                    title: '退出填格子模式（Esc）',
                    onClick: exitFillMode,
                  },
                  '退出',
                ),
              ),
              storyPresets.length > 0
                ? createElement(
                    'div',
                    { className: 'cm-fillbar-lines' },
                    createElement('span', { className: 'cm-fillbar-label dim' }, '剧情线一键选'),
                    ...storyPresets.map((preset) =>
                      createElement(
                        'button',
                        {
                          key: preset.id,
                          type: 'button',
                          className: 'cm-line-chip',
                          title:
                            (preset.description ? `${preset.description}\n` : '') +
                            `状态键：${preset.keys.join('、')}`,
                          onClick: () => applyStoryLine(preset),
                        },
                        preset.label,
                      ),
                    ),
                  )
                : null,
            )
          : null;

        const noticeEl = notice
          ? createElement(
              'div',
              { className: 'cm-notice', role: 'status' },
              notice,
              createElement(
                'button',
                {
                  className: 'cm-notice-close',
                  type: 'button',
                  'aria-label': '关闭提示',
                  onClick: () => setNotice(null),
                },
                '×',
              ),
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
        /** 过滤后的可见性反馈：点了「只看空缺」必须立刻看到行数变化与空态原因 */
        let filterNote: ReactNode = null;
        let grid: ReactNode;
        if (!entry || !matrix) {
          const selectedInfo = selectedNo === null ? null : current.charaIndex.get(selectedNo) ?? null;
          grid =
            selectedNo === null
              ? createElement('div', { className: 'cm-empty dim' }, '从上方选择角色以浏览其状态 × 时机矩阵')
              : createElement(
                  'div',
                  { className: 'cm-empty dim' },
                  selectedInfo && selectedInfo.kojoDir === undefined
                    ? `K${selectedNo} 在游戏里没有个人口上目录，无法建立口上矩阵。`
                    : `K${selectedNo} 还没有任何口上函数——这本身就是最大的缺口。先在口上包里为这个角色新建口上，矩阵会自动出现。`,
                );
        } else if (matrix.rows.length === 0) {
          grid = createElement('div', { className: 'cm-empty dim' }, '该角色尚未抽取到状态条件（无状态依赖）');
        } else {
          const needle = deferredFilter.trim().toLowerCase();
          const visibleSig = visibleColumnKeys.join('\u0000');
          // 过滤清单记忆化（PS-7）：矩阵 / 过滤词 / 缺口模式 / 可见列都不变 ⇒ 复用上一次结果，
          // 滚动帧（每帧一次重渲）不再逐帧扫几千行、也不再产出新数组（行 memo 据此保持稳定）。
          const rowsCache = rowsFilterRef.current;
          let rows: MatrixRow[];
          if (
            rowsCache &&
            rowsCache.matrix === matrix &&
            rowsCache.needle === needle &&
            rowsCache.gapOnly === gapOnly &&
            rowsCache.visibleSig === visibleSig
          ) {
            rows = rowsCache.rows;
          } else {
            let next = matrix.rows;
            if (needle) {
              next = next.filter(
                (r) => r.key.toLowerCase().includes(needle) || (r.label ?? '').toLowerCase().includes(needle),
              );
            }
            if (gapOnly) {
              next = next.filter((r) => rowHasVisibleGap(r, visibleColumnKeys));
            }
            rows = needle || gapOnly ? next : [...next];
            rowsFilterRef.current = { matrix, needle, gapOnly, visibleSig, rows };
          }
          if (gapOnly || needle) {
            const reason =
              rows.length > 0
                ? null
                : gapOnly
                  ? needle
                    ? '没有同时匹配筛选词、且仍有空缺的状态行。'
                    : '当前可见时机已经全部有响应——没有空缺。可点开其它时机分组或切换口上包。'
                  : '没有匹配的状态键。';
            filterNote = createElement(
              'div',
              { className: 'cm-filter-note', role: 'status' },
              createElement(
                'span',
                { className: 'cm-filter-count' },
                gapOnly ? `只看空缺 · ${rows.length} / ${matrix.rows.length} 行` : `匹配 · ${rows.length} / ${matrix.rows.length} 行`,
              ),
              reason
                ? createElement('span', { className: 'cm-filter-reason dim' }, reason)
                : createElement(
                    'span',
                    { className: 'cm-filter-reason dim' },
                    gapOnly ? '空缺（暗格）保留；已填格已淡出。' : '仅显示匹配的状态行。',
                  ),
              gapOnly
                ? createElement(
                    'button',
                    {
                      className: 'cm-filter-clear',
                      type: 'button',
                      onClick: () => setGapOnly(false),
                    },
                    '显示全部',
                  )
                : null,
            );
          }
          // 填空选择 → 每行 Set（签名缓存：滚动帧 / 无关重渲不重建，行 memo 不被打断）
          const fillSigCache = fillSigCacheRef.current;
          let fillSig: string;
          if (fillSigCache && fillSigCache.sel === fillSel) {
            fillSig = fillSigCache.sig;
          } else {
            fillSig = [...fillSel].sort().join('\u0001');
            fillSigCacheRef.current = { sel: fillSel, sig: fillSig };
          }
          let fillByRow: Map<string, Set<string>>;
          let fillCache = fillSetsRef.current;
          if (!fillCache || fillCache.sig !== fillSig) {
            const colsByRow = new Map<string, string[]>();
            for (const key of fillSel) {
              const at = key.indexOf('\u0000');
              if (at < 0) continue;
              const rowKey = key.slice(0, at);
              const colKey = key.slice(at + 1);
              const list = colsByRow.get(rowKey);
              if (list) list.push(colKey);
              else colsByRow.set(rowKey, [colKey]);
            }
            // 逐行复用旧 Set：只改一格时，别的已选行仍保持同一引用 ⇒ 行 memo 不连坐重渲
            const prevByRow = fillCache?.byRow;
            const map = new Map<string, Set<string>>();
            for (const [rowKey, cols] of colsByRow) {
              const prev = prevByRow?.get(rowKey);
              map.set(
                rowKey,
                prev && prev.size === cols.length && cols.every((c) => prev.has(c))
                  ? prev
                  : new Set(cols),
              );
            }
            fillCache = { sig: fillSig, byRow: map };
            fillSetsRef.current = fillCache;
          }
          fillByRow = fillCache.byRow;
          const groups = matrix.groups;
          // 键盘导航上界：当前（过滤后）行数——跨窗口纵向移动时判「是否越过末行」
          rowCountRef.current = rows.length;

          // 表头元素缓存：滚动帧只换 tbody 窗口，表头没必要每帧重建（几百列时是实打实的 diff 成本）
          const headCache = headCacheRef.current;
          let head: ReactNode;
          if (headCache && headCache.matrix === matrix && headCache.folded === foldedFaces) {
            head = headCache.node;
          } else {
            head = renderGridHead({
              groups: matrix.groups,
              foldedFaces,
              onToggleFace: toggleFace,
              ic,
              cornerRef,
            });
            headCacheRef.current = { matrix, folded: foldedFaces, node: head };
          }

          const colCount = matrix.columns.length;
          // 首列列宽拖拽接管判据：快照的 matrixKey 须与当前一致（换角色 / 依赖版本即失效）且列数吻合。
          // 有效 ⇒ 表切 `table-layout: fixed` + `<colgroup>`（见 .cm-scroll.col-pinned）。
          const activeSnap =
            colSnap && colSnap.key === matrixKey && colSnap.widths.length === colCount + 1 ? colSnap : null;

          // 行视口化是唯一渲染路径：只画可见窗口（+上下 overscan），两段占位还原
          // 完整滚动高度——全部行可浏览、可键盘到达，模式切换/过滤也只重渲窗口内行。
          // 行高走**实测值**，窗口 / 占位 / 键盘跳转共用同一把尺。
          const layout = planMatrixWindow(scrollTop, viewportH, rows.length, measuredRowH);
          layoutRef.current = layout;
          const win = layout.win;
          const body = createElement(
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
                fillColumns: fillByRow.get(row.key) ?? EMPTY_FILL_COLUMNS,
                rowIndex: win.start + i, // 绝对行索引（data-r 跨窗一致，方向键据此平移）
                onCell,
              }),
            ),
            spacerRow(win.bottomPad, 'pad-bottom', colCount + 1),
          );

          // 网格区 CSS 变量：行高常量唯一真源（视口化路径用）+ 首列拖拽宽度（HK-25，拖过才设）。
          // 这里的"真源"是**实测**行高（`layoutRef` 那次算出来的同一个值）——写常量就等于
          // 让 CSS 钉一个尺子、窗口数学按另一个尺子算，正是 PS-7 之前的错位。
          const gridStyle: Record<string, string> = {};
          if (layoutRef.current) gridStyle['--cm-row-h'] = `${layoutRef.current.rowHeight}px`;
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
                'cm-scroll cm-virt' +
                (activeSnap ? ' col-pinned' : '') +
                (gapOnly ? ' gap-focus' : '') +
                (fillMode ? ' cm-fill' : ''),
              ref: scrollRef,
              onKeyDown: onGridKeyDown,
              // 首列拖拽 **委派**到本容器：把手遍布整列（角格 + 每个行头），行组件不持有 handler
              onPointerDown: onColDown,
              onPointerMove: onColMove,
              onPointerUp: onColEnd,
              onPointerCancel: onColEnd,
              onScroll,
              // 未拖过时变量未设 ⇒ CSS 回退 auto（自然宽度，逐字不变）
              style: Object.keys(gridStyle).length > 0 ? (gridStyle as CSSProperties) : undefined,
            },
            createElement('table', { className: 'cm-table', ref: tableRef, style: tableStyle }, colgroup, head, body),
          );
        }

        // ---- 详情（选中格 → 详情区；呈现件见 ./detail-pane.ts）----
        // 缓存同一份元素树：滚动帧只改网格窗口，详情不必重跑 find/sort 与整段 diff。
        const fillSelected = selected
          ? fillSel.has(fillCellKey(selected.rowKey, selected.columnKey))
          : false;
        const detailCache = detailCacheRef.current;
        let detail: ReactNode;
        if (
          detailCache &&
          detailCache.matrix === matrix &&
          detailCache.selected === selected &&
          detailCache.detailH === detailH &&
          detailCache.fillMode === fillMode &&
          detailCache.fillSelected === fillSelected
        ) {
          detail = detailCache.node;
        } else {
          detail = renderDetail({
            matrix,
            selected,
            faceLabels: () => services.faceLabels(),
            detailH,
            detailRef,
            emitReveal: (target) => ctx.bus.emit('editor.revealLocation', target),
            fillMode,
            fillSelected,
          });
          detailCacheRef.current = {
            matrix,
            selected,
            detailH,
            fillMode,
            fillSelected,
            node: detail,
          };
        }

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
          entryHint,
          status,
          noticeEl,
          fillBar,
          filterNote,
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

      // 填格浮层（用户反馈 2026-10-18）：宽版承载代码预览与落点设置；面板在打开前
      // 把请求写进 pendingFill（overlay 组件无 props 参数通道，与其它向导同款分工）。
      ctx.slots.register('ui.overlay', {
        id: CONDITION_MATRIX_FILL_OVERLAY_ID,
        order: 24,
        size: 'wide',
        component: createConditionMatrixFillOverlay(() => pendingFill),
      });
    },
  };
}
