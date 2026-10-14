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
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  buildCharacterIndex,
  buildMatrix,
  clampDetailHeight,
  clampRowheadWidth,
  computeViewportWindow,
  createMatrixMemo,
  DETAIL_MIN_H,
  faceLabel,
  instructionNoOfSlot,
  MATRIX_OVERSCAN,
  MATRIX_ROW_H,
  ROWHEAD_MIN_W,
  type CharacterIndex,
  type ColumnDesc,
  type FaceFunction,
  type MatrixCell,
  type MatrixCellFunction,
  type MatrixColumnGroup,
  type MatrixRow,
} from './matrix-logic';

/** 矩阵行渲染上限（防 DOM 爆炸；过滤后仍受此限）——**仅全量（非视口化）路径** */
const ROW_RENDER_CAP = 400;

/** 取路径末两段（工具提示/详情里短显示） */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/** 按「行号升序、同号按路径」排序（详情展示 / 取最早贡献函数） */
function orderByLine(fns: readonly MatrixCellFunction[]): MatrixCellFunction[] {
  return [...fns].sort((a, b) => a.startLine - b.startLine || a.filePath.localeCompare(b.filePath));
}

/** 单元格工具提示：其贡献函数的比较合并去重（无比较或无响应 → '无'） */
function cellComparisons(cell: MatrixCell): string {
  const seen = new Set<string>();
  for (const f of cell.functions) for (const c of f.comparisons) seen.add(c);
  return seen.size > 0 ? [...seen].join('、') : '无';
}

/** 跳转意图载荷（`editor.revealLocation` 消费） */
interface RevealTarget {
  readonly filePath: string;
  readonly line: number;
  readonly source: string;
}

/** 分隔线指针事件的最小形状（React 合成事件满足它；插件 tsconfig 无 DOM lib） */
type SplitterPointer = {
  pointerId: number;
  clientY: number;
  preventDefault(): void;
  currentTarget: { setPointerCapture(pointerId: number): void };
};

/** 首列列宽拖拽指针事件的最小形状（水平方向，读 clientX；事件在 .cm-scroll 上委派 ⇒ 读 target） */
type ColResizePointer = {
  pointerId: number;
  clientX: number;
  target: { closest?: (selector: string) => unknown } | null;
  preventDefault(): void;
  currentTarget: { setPointerCapture(pointerId: number): void };
};

/** 网格键盘事件的最小形状 */
type GridKeyEvent = {
  key: string;
  target: unknown;
  preventDefault(): void;
};

/** 滚动容器的最小形状（视口化路径读滚动位置 / 可视高、按属性选择器聚焦格子） */
type ScrollBox = {
  scrollTop: number;
  clientHeight: number;
  querySelector(sel: string): { focus(): void } | null;
};

/** 滚动事件的最小形状 */
type ScrollEvent = {
  currentTarget: { scrollTop: number; clientHeight: number };
};

/* --------------------------- 行视图（memo：选中/折叠只重渲受影响行） --------------------------- */

interface MatrixRowViewProps {
  readonly row: MatrixRow;
  readonly groups: readonly MatrixColumnGroup[];
  readonly foldedFaces: ReadonlySet<string>;
  /** 本行含选中格则为其列键，否则 null（非选中行传同一原始值，memo 得以整表跳过重渲） */
  readonly selectedColumn: string | null;
  readonly rowIndex: number;
  readonly onCell: (rowKey: string, columnKey: string, target: RevealTarget | null) => void;
}

/**
 * 单行渲染（`memo`）：选中态只在「选中行 ↔ 取消选中行」两行间变化，其余行 props 不变 → 跳过重渲。
 * 格子带 `data-r`/`data-c`（渲染序索引）供网格方向键导航定位。
 */
const MatrixRowView = memo(function MatrixRowView(props: MatrixRowViewProps): ReactNode {
  const { row, groups, foldedFaces, selectedColumn, rowIndex, onCell } = props;
  const cells: ReactNode[] = [];
  let c = 0;
  for (const group of groups) {
    const folded = foldedFaces.has(group.face);
    for (const col of group.columns) {
      if (folded) {
        // 折叠组：占位格**保留同形 DOM**（td + button），只给按钮加 `.cm-hid`（visibility:hidden）。
        // 实测（10224 格 / 276 列）：卡顿主因有两份——①浏览器样式重算，其中「改动 td 的 class」
        // 一份就占 ~583ms、「只动 button 的 class」仅 ~134ms；②`table-layout:auto` 的整表重排
        // （清空 subth 标签 / `display:none` 改内容尺寸都会触发，~1.8s）。故：td **不改 class**、
        // 按钮只加 `.cm-hid`（visibility 不改布局、保留盒子）、表头 subth 标签照常渲染
        // （由既有 `.cm-subth.folded{opacity:.3}` 弱化）——全流程只改非布局属性 ⇒ 只重绘不重排。
        // 折叠格不给 data-r/data-c（沿用「折叠组不参与方向键导航」的原口径）。
        cells.push(
          createElement(
            'td',
            { key: col.key },
            createElement('button', { className: 'cm-cell off cm-hid', 'aria-hidden': 'true' }, '·'),
          ),
        );
        continue;
      }
      const cell = row.cells[col.key];
      const dataC = c++;
      if (!cell || !cell.present) {
        // 空白格：这个时机还没有针对该状态写过的反应（点击不导航）
        cells.push(
          createElement(
            'td',
            { key: col.key },
            createElement(
              'button',
              { className: 'cm-cell off', title: '无', 'data-r': rowIndex, 'data-c': dataC },
              '·',
            ),
          ),
        );
        continue;
      }
      const isSel = selectedColumn === col.key;
      cells.push(
        createElement(
          'td',
          { key: col.key },
          createElement(
            'button',
            {
              className: 'cm-cell on' + (isSel ? ' sel' : ''),
              title: cellComparisons(cell),
              'data-r': rowIndex,
              'data-c': dataC,
              onClick: () => {
                const earliest = orderByLine(cell.functions)[0];
                onCell(
                  row.key,
                  col.key,
                  earliest
                    ? { filePath: earliest.filePath, line: earliest.startLine, source: earliest.name }
                    : null,
                );
              },
            },
            String(cell.count),
          ),
        ),
      );
    }
  }
  return createElement(
    'tr',
    null,
    createElement(
      'th',
      { className: 'cm-rowhead', title: row.key },
      createElement('span', { className: 'cm-row-name' }, row.label ?? row.key),
      row.label ? createElement('span', { className: 'cm-row-key dim' }, row.key) : null,
      // 列宽拖拽把手（HK-25）：**整列**每一行的行头右缘都放一枚，使「状态 \ 时机」列
      // 在任意行都能拉伸（不再只有表头角格可抓）。事件由 .cm-scroll 委派，此处不挂 handler。
      createElement('div', { className: 'cm-corner-resize', 'aria-hidden': 'true' }),
    ),
    ...cells,
  );
});

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

      /** 当前适配器的变量语义字典（按 adapterId 精确匹配；与注入器同通道） */
      const schemaLookup = (): VariableSchema | undefined => {
        const current = project.current();
        if (!current) return undefined;
        for (const c of slots.query('game.adapter')) {
          if (c.adapter.gameId !== current.adapterId) continue;
          return c.adapter.variableSchema;
        }
        return undefined;
      };

      /** 当前适配器的指令表（编号 ↔ 中文名；按 adapterId 精确匹配；缺省 → undefined） */
      const instructionTable = (): KojoInstructionTable | undefined => {
        const current = project.current();
        if (!current) return undefined;
        for (const c of slots.query('game.adapter')) {
          if (c.adapter.gameId !== current.adapterId) continue;
          return c.adapter.kojoInstructionTable;
        }
        return undefined;
      };

      /** 当前适配器的面 → 中文标签（与家族规则同源；缺省 → 消费方原样显示 token） */
      const faceLabels = (): Readonly<Record<string, string>> | undefined => currentFamilyIndex()?.faceLabels;

      /** 状态键标签：按首个 ':' 切出变量名与首下标，查变量字典 */
      const labelOf = (key: string): string | null => {
        const schema = schemaLookup();
        if (!schema) return null;
        const i = key.indexOf(':');
        const name = i < 0 ? key : key.slice(0, i);
        const firstIndex = i < 0 ? undefined : key.slice(i + 1).split(':')[0];
        return schema.lookup(name, firstIndex)?.description ?? null;
      };

      /** 单函数状态依赖（抽取索引未含该函数时为空数组） */
      const depsOf = (normalizedName: string): StateDependency[] =>
        conditionExtractor.functionConditions(normalizedName)?.dependencies ?? [];

      // ---- 状态（React 外部源；面板组件读取并订阅） ----
      let characterIndex: CharacterIndex | null = null;
      let indexReady = false;
      /** 上一次建索引所用的索引实例（去重判据：同一实例不重复全量遍历） */
      let lastBuiltIndex: ErbIndex | null = null;
      /** 抽取索引代次：每次重建索引 / 条件索引就绪即 +1——矩阵记忆化的失效判据 */
      let depsEpoch = 0;
      /** 矩阵结果记忆化（按「角色 × 依赖版本 × 适配器」缓存，杜绝选择/过滤时整表重算） */
      const matrixMemo = createMatrixMemo();
      /** 索引/建表失败原因（必须可见 + 可重试，不静默停在占位） */
      let loadError: string | null = null;
      const listeners = new Set<() => void>();

      const notify = (): void => {
        for (const cb of [...listeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`Condition matrix listener threw: ${String(err)}`);
          }
        }
      };

      const rebuild = (index: ErbIndex | null): void => {
        // 去重：`project.opened` 与 `kojo.functionChanged` 会双双触发 refresh，
        // 两者拿到同一索引实例——同一实例不重复全量遍历（一次扫描即全量重算）。
        if (lastBuiltIndex === index) return;
        lastBuiltIndex = index;
        depsEpoch++;
        if (!index || !project.current()) {
          characterIndex = null;
          indexReady = index !== null;
        } else {
          characterIndex = buildCharacterIndex(index, currentFamilyIndex());
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
            const msg = err instanceof Error ? err.message : String(err);
            loadError = msg;
            indexReady = false;
            ctx.log.error(`Condition matrix load failed: ${msg}`);
            notify();
          });
      };

      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.opened', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.closed', () => rebuild(null)));
      // 条件抽取索引就绪后重绘（填色依赖 functionConditions；立即回调一次，无副作用）
      // 代次 +1：抽取索引可能已更新，矩阵缓存须失效重算
      ctx.onDispose(
        conditionExtractor.subscribe(() => {
          depsEpoch++;
          notify();
        }),
      );

      // 激活时已有现成索引（插件晚于项目打开加载）→ 立即构建
      if (project.current()) refresh();

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
        /** 首列列宽拖拽中（仅用于高亮） */
        const [colDragging, setColDragging] = useState(false);
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

        // 首列（「状态 \ 时机」）列宽拖拽（HK-25）：与详情分隔线同范式（pointer 捕获 + 钳制）。
        // 把手遍布**整列**（表头角格 + 每一行的行头），故事件挂在 .cm-scroll 上**委派**：
        // 行组件不为拖拽持有 handler ⇒ `memo` 不被破坏；命中与否只看 target 落在不落在把手上。
        const onColDown = (e: ColResizePointer): void => {
          if (!e.target?.closest?.('.cm-corner-resize')) return;
          e.preventDefault();
          colDragSeed.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            // 首次拖拽从「当前真实列宽」起步（未拖过时 = 角格自然宽度），不跳变
            startW: rowheadW ?? cornerRef.current?.offsetWidth ?? ROWHEAD_MIN_W,
          };
          setColDragging(true);
          // 指针捕获：拖快了指头滑出命中区也不丢事件
          e.currentTarget.setPointerCapture(e.pointerId);
        };

        const onColMove = (e: ColResizePointer): void => {
          const seed = colDragSeed.current;
          if (!seed || seed.pointerId !== e.pointerId) return;
          setRowheadW(clampRowheadWidth(seed.startW + (e.clientX - seed.startX)));
        };

        const onColEnd = (e: { pointerId: number }): void => {
          if (colDragSeed.current?.pointerId !== e.pointerId) return;
          colDragSeed.current = null;
          setColDragging(false);
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
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
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

        // 失败态优先：显示原因 + 重试（不静默停在占位）
        if (loadError) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-error', title: loadError }, `条件矩阵加载失败：${loadError}`),
            createElement('button', { className: 'small', onClick: () => refresh() }, '重试'),
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

        const idx = characterIndex;
        if (idx && !idx.hasFamilyIndex) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '适配器未提供家族规则，无法按角色聚合条件矩阵'),
          );
        }

        if (!indexReady || !idx) {
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
        const instructionFaces = new Set(currentFamilyIndex()?.instructionFaces ?? []);
        const columnOf = (fn: FaceFunction): ColumnDesc => {
          if (!instructionFaces.has(fn.face)) return { key: fn.face, instructionNo: null };
          const no = instructionNoOfSlot(fn.match.slot);
          if (no === null) return { key: fn.face, instructionNo: null };
          const name = instructionTable()?.lookupByNo(no);
          return { key: `${fn.face}#${no}`, instructionNo: no, label: name ?? `#${no}` };
        };
        // 记忆化：选择 / 过滤 / 折叠 / 无关刷新都不重算矩阵，仅「角色 × 依赖版本 × 适配器」变化才重建
        const matrixKey = `${entry?.no}|${depsEpoch}|${current.adapterId}`;
        const matrix = entry
          ? matrixMemo.resolve(matrixKey, () => buildMatrix(entry, depsOf, labelOf, faceLabels(), columnOf))
          : null;

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

          // 两行表头：第一行 = 大时机类（可点折叠，跨该组子列）；第二行 = 子列头。
          // 折叠组仍渲染占位格（空白）以维持列对齐，只是不渲染其内容。
          const head = createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              createElement(
                'th',
                { className: 'cm-corner', rowSpan: 2, ref: cornerRef },
                '状态 \\ 时机',
                // 首列列宽拖拽把手（HK-25）：右缘一枚竖条，静息隐形、悬停 / 拖拽中亮起；
                // 角格 sticky ⇒ 纵向滚动时随表头常驻，横向滚动时首列钉在 left:0 不漂移。
                // 事件在 .cm-scroll 上委派（见 onColDown），此处只放标记。
                createElement('div', {
                  className: 'cm-corner-resize',
                  role: 'separator',
                  'aria-orientation': 'vertical',
                  'aria-label': '拖动调整状态列宽',
                  title: '拖动调整状态列宽',
                }),
              ),
              ...matrix.groups.map((group) => {
                const folded = foldedFaces.has(group.face);
                return createElement(
                  'th',
                  {
                    key: group.face,
                    className: 'cm-group-th' + (folded ? ' folded' : ''),
                    colSpan: group.columns.length,
                    title: group.face,
                    onClick: () => toggleFace(group.face),
                  },
                  createElement('span', { className: 'cm-fold', 'aria-hidden': 'true' }, ic(folded ? 'chevron-right' : 'chevron-down', 12, folded ? '▸' : '▾')),
                  group.label,
                );
              }),
            ),
            createElement(
              'tr',
              null,
              ...matrix.groups.flatMap((group) => {
                const folded = foldedFaces.has(group.face);
                // 非指令的单列组：第二行留空（避免与第一行重复）。
                // 折叠**不再清空标签**——清空会让该列固有宽度塌陷、逼 `table-layout:auto` 重排全表
                // （实测折叠一次卡 ~1.8s + 整列闪白）；改由 `.cm-subth.folded{opacity:.3}` 弱化。
                const blank = group.columns.length === 1 && group.columns[0]?.instructionNo === null;
                return group.columns.map((col) =>
                  createElement(
                    'th',
                    { key: col.key, className: 'cm-subth' + (folded ? ' folded' : ''), title: col.key },
                    blank ? null : col.label,
                  ),
                );
              }),
            ),
          );

          const colCount = matrix.columns.length;
          /** 占位块：单个 td 跨全部列、钉死高度撑出滚动条（视口化路径专用） */
          const spacer = (h: number, key: string): ReactNode =>
            h > 0
              ? createElement(
                  'tr',
                  { key, className: 'cm-spacer', 'aria-hidden': 'true', style: { height: h } },
                  createElement('td', { colSpan: colCount + 1, style: { height: h } }),
                )
              : null;

          let body: ReactNode;
          let moreNotice: ReactNode = null;
          if (virtualize) {
            // 视口化：只渲染可见窗口（+上下 overscan），两段占位还原完整滚动高度——
            // 全部行都可浏览、可键盘到达，不再受 400 行上限约束。
            const win = computeViewportWindow(scrollTop, viewportH, MATRIX_ROW_H, rows.length, MATRIX_OVERSCAN);
            body = createElement(
              'tbody',
              null,
              spacer(win.topPad, 'pad-top'),
              ...rows.slice(win.start, win.end).map((row, i) =>
                createElement(MatrixRowView, {
                  key: row.key,
                  row,
                  groups,
                  foldedFaces,
                  selectedColumn: selected && selected.rowKey === row.key ? selected.columnKey : null,
                  rowIndex: win.start + i, // 绝对行索引（data-r 跨窗一致，方向键据此平移）
                  onCell,
                }),
              ),
              spacer(win.bottomPad, 'pad-bottom'),
            );
          } else {
            const shown = rows.slice(0, ROW_RENDER_CAP);
            body = createElement(
              'tbody',
              null,
              ...shown.map((row, rowIndex) =>
                createElement(MatrixRowView, {
                  key: row.key,
                  row,
                  groups,
                  foldedFaces,
                  selectedColumn: selected && selected.rowKey === row.key ? selected.columnKey : null,
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
          if (rowheadW !== null) gridStyle['--cm-rowhead-w'] = `${rowheadW}px`;

          grid = createElement(
            'div',
            {
              className: 'cm-scroll' + (virtualize ? ' cm-virt' : '') + (colDragging ? ' col-resizing' : ''),
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
            createElement('table', { className: 'cm-table' }, head, body),
            moreNotice,
          );
        }

        // ---- 详情 ----
        // 拖过分隔线后按拖拽高度固定（inline height+maxHeight 覆盖样式默认的 max-height），未拖过走样式默认
        const detailProps = {
          className: 'cm-detail',
          ref: detailRef,
          style: detailH === null ? undefined : { height: detailH, maxHeight: detailH },
        };
        let detail: ReactNode;
        const selRow = selected && matrix ? matrix.rows.find((r) => r.key === selected.rowKey) ?? null : null;
        const selCell = selRow && selected ? selRow.cells[selected.columnKey] : undefined;
        /** 选中列的显示名（列标签；找不到则回退面标签） */
        const selColumn = selected && matrix ? matrix.columns.find((c) => c.key === selected.columnKey) ?? null : null;
        const selColumnLabel = selColumn ? selColumn.label : selected ? faceLabel(selected.columnKey, faceLabels()) : '';
        if (selRow && selCell && selCell.present) {
          const fns = orderByLine(selCell.functions);
          detail = createElement(
            'div',
            detailProps,
            createElement(
              'div',
              { className: 'cm-detail-head' },
              createElement('span', { className: 'cm-detail-key' }, selRow.label ?? selRow.key),
              createElement(
                'span',
                { className: 'dim' },
                ` · ${selColumnLabel} · ${selCell.count} 处响应`,
              ),
            ),
            createElement(
              'ul',
              { className: 'cm-detail-list' },
              ...fns.map((f, i) =>
                createElement(
                  'li',
                  { key: `${f.filePath}:${f.startLine}:${i}` },
                  createElement(
                    'button',
                    {
                      className: 'cm-detail-btn',
                      title: `${f.filePath}:${f.startLine}`,
                      onClick: () =>
                        ctx.bus.emit('editor.revealLocation', {
                          filePath: f.filePath,
                          line: f.startLine,
                          source: f.name,
                        }),
                    },
                    createElement('span', { className: 'cm-detail-name' }, f.name),
                    f.comparisons.length > 0
                      ? createElement('span', { className: 'cm-detail-comps dim' }, f.comparisons.join('、'))
                      : null,
                    createElement('span', { className: 'cm-detail-loc dim' }, `${shortPath(f.filePath)}:${f.startLine}`),
                  ),
                ),
              ),
            ),
          );
        } else {
          detail = createElement(
            'div',
            detailProps,
            createElement('div', { className: 'cm-empty dim' }, '点击一个已填色的格子，查看其对应的口上函数'),
          );
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
