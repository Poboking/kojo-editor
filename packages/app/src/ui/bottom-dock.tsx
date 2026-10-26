import { memo, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import type { UIPanelContribution, UIPanelProps } from '@kojo/plugin-api';
import { Icon } from './icons';
import { PanelBody } from './PanelHost';
import { snapshot as problemsSnapshot, subscribe as subscribeProblems, summarizeProblems } from './problem-store';
// 底栏 dock 的样式切片（VIS-13 · D-2）：只吃 var()，不新增颜色真源
import './bottom-dock.css';

/**
 * 底栏 dock 的**容器级**渲染片段（VIS-13 · D-2）。
 *
 * 口径边界（重要，别越线）：
 * - 本文件只做**容器**那一条头（面板名 + 计数 ─ 筛选槽 / 浮出 / 关闭）。
 *   面板**内部**自己的 header 归车道 C（她在抽 `KitPanelHeader`），这里一行都不碰；
 * - 容器不认得任何面板的领域词汇：计数走 `DOCK_COUNT_SOURCES` 那张**只读登记表**
 *   （没登记的面板就是没有计数，那条头自然少一格，不占位）；
 * - 拖把手**不在这里 dispatch**：`onCellResizeStart` 交回 ShellLayout，
 *   由 `layout.ts` 的 `beginDockCellResize` 走"拖拽期只写内联、松手才 commit"那一条纪律
 *   （PS-6；每次 pointermove 都 setState 会把整壳重渲一遍 + 每帧写一次盘）。
 */

/** 面板体 props 的 UI 偏好投影（与 `PanelHost` 同一形状，宿主原样转下） */
type UiPrefs = NonNullable<UIPanelProps['uiPrefs']>;

/**
 * 头部计数读数（左档）：**只读**登记表。
 *
 * 每格是一个"订阅 + 读数"的最小面，读数必须是**原始值**（`useSyncExternalStore` 的
 * 幂等判据）；返回 `null` = 这条读数当前没资格说话（不显示，而不是显示 0）。
 */
export interface DockCountSource {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number | null;
  /** 悬停文案（说清这颗数的是什么范围，别让人对着一个数字猜） */
  readonly title: string;
}

const problemsCountSource: DockCountSource = {
  subscribe: subscribeProblems,
  // `snapshot()` 干净时返回同一引用 ⇒ 这一路只在真变了才算一次；读数取原始数字
  getSnapshot: () => {
    const { error, warning, info } = summarizeProblems(problemsSnapshot()).counts;
    const total = error + warning + info;
    return total > 0 ? total : null;
  },
  title: '当前诊断条数（已打开文件 + 项目扫描的对外那一簇）',
};

/**
 * panelId → 计数读数。底栏在场的面板里只有登记过的才带那颗数；
 * 别的面板要加计数，往这张表里登记一条即可（容器代码零改动、零游戏知识）。
 */
export const DOCK_COUNT_SOURCES: Readonly<Record<string, DockCountSource>> = Object.freeze({
  'kojo.problems': problemsCountSource,
});

/** 没登记读数时的稳定空面（`useSyncExternalStore` 的 subscribe 换引用 = 每次重订阅，必须是常量） */
const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_SNAPSHOT = (): number | null => null;

/** 一格头部读数（自己订阅 ⇒ 重渲半径就是这一小片文字，不牵动面板体与整壳） */
const DockCount = memo(function DockCount({ panelId }: { panelId: string }): ReactElement | null {
  const source = DOCK_COUNT_SOURCES[panelId];
  // hooks 序列恒定：缺登记时走上面那两个模块级常量，不现造函数
  const value = useSyncExternalStore(
    source?.subscribe ?? NO_SUBSCRIBE,
    source?.getSnapshot ?? NO_SNAPSHOT,
    source?.getSnapshot ?? NO_SNAPSHOT,
  );
  if (value === null || source === undefined) return null;
  return (
    <span className="dock-cell-count" title={source.title}>
      {value}
    </span>
  );
});

export interface DockCellProps {
  panel: UIPanelContribution;
  /** 该格的记忆高度 px；`undefined` = 没拖过 = 跟着 dock 均分（不写内联，交给 CSS stretch） */
  heightPx?: number;
  /** 这一格是不是当前激活格（tab 条上的选中态与它同源） */
  active: boolean;
  uiPrefs?: UiPrefs;
  hostVersion?: number;
  registerEl: (id: string, el: HTMLElement | null) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLElement>, id: string) => void;
  onFloat: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * dock 里的一格：一条头（名 + 计数 / 筛选槽 + 浮出 + 关闭）+ 面板体 + 底沿高度把手。
 *
 * `memo` 的口径与 `PanelBody` 一致——props 全是引用稳定或原始值：
 * `panel` 是编排结果里的贡献对象（同引用穿过 `organizePanels`）、`registerEl/onFloat/…`
 * 由宿主 `useCallback` 固定。无关状态（索引读数、光标位）重渲整壳时，一格都不跟着重渲。
 */
export const DockCell = memo(function DockCell({
  panel,
  heightPx,
  active,
  uiPrefs,
  hostVersion,
  registerEl,
  onResizeStart,
  onFloat,
  onClose,
}: DockCellProps): ReactElement {
  return (
    <section
      className={`dock-cell ${active ? 'active' : ''}`}
      // 记忆高度写在元素上：拖拽期 `beginDockCellResize` 往同一个属性写同一个坐标系里的
      // 数 ⇒ 松手 React 落地的字符串与内联逐字相同，零跳变（PS-6 那条硬不变量）
      style={heightPx === undefined ? undefined : { height: `${heightPx}px` }}
      ref={(node) => {
        registerEl(panel.id, node);
      }}
      role="region"
      aria-label={panel.title}
      data-dock-cell={panel.id}
      {...(heightPx === undefined ? {} : { 'data-dock-pinned': '' })}
      {...(active ? { 'data-dock-active': '' } : {})}
    >
      <header className="dock-cell-head">
        <span className="dock-cell-title">
          {panel.icon !== undefined ? <Icon name={panel.icon} size={14} /> : null}
          {panel.title}
        </span>
        <DockCount panelId={panel.id} />
        <span className="spacer" />
        {/* 筛选槽：容器只提供这一格落点（面板自己的筛选器由各自的 lane portal 进来），
            容器绝不代它渲染筛选项——那是要害进别人面板内部 */}
        <span className="dock-cell-slot" data-dock-slot="filter" data-panel-id={panel.id} />
        <button
          type="button"
          className="ghost small dock-cell-float"
          title="浮出为独立浮窗"
          aria-label={`浮出 ${panel.title}`}
          onClick={() => onFloat(panel.id)}
        >
          <Icon name="popout" size={14} />
        </button>
        <button
          type="button"
          className="ghost small dock-cell-close"
          title="从底栏摘掉这一格"
          aria-label={`关闭 ${panel.title}`}
          onClick={() => onClose(panel.id)}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="dock-cell-body">
        <PanelBody contribution={panel} uiPrefs={uiPrefs} hostVersion={hostVersion} />
      </div>
      <div
        className="resizer resizer-y dock-cell-resizer"
        role="separator"
        aria-label={`调整 ${panel.title} 高度`}
        onPointerDown={(e) => onResizeStart(e, panel.id)}
      />
    </section>
  );
});

export interface BottomDockProps {
  /** 并排在 dock 里的面板（序 = 编排序；长度 ≥2 就是"同看两颗"的那条判据） */
  cells: readonly UIPanelContribution[];
  /** 当前激活格（与 tab 条的选中态同源） */
  activeId: string | null;
  /** 逐格高度记忆（`LayoutState.bottomHeights`；缺省 = 全部均分） */
  heights?: Record<string, number>;
  uiPrefs?: UiPrefs;
  hostVersions?: Record<string, number>;
  registerEl: (id: string, el: HTMLElement | null) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLElement>, id: string) => void;
  onFloat: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * dock 的**面板体区**：横向并排的若干格。
 *
 * `data-dock-cell-count` 是给判据/调试用的现场读数（并排挂了几颗），不是样式钩子。
 */
export function BottomDock({
  cells,
  activeId,
  heights,
  uiPrefs,
  hostVersions,
  registerEl,
  onResizeStart,
  onFloat,
  onClose,
}: BottomDockProps): ReactElement {
  return (
    <div className="bottom-dock" data-dock-cell-count={cells.length}>
      {cells.map((p) => (
        <DockCell
          key={p.id}
          panel={p}
          heightPx={heights?.[p.id]}
          active={p.id === activeId}
          uiPrefs={uiPrefs}
          hostVersion={hostVersions?.[p.id]}
          registerEl={registerEl}
          onResizeStart={onResizeStart}
          onFloat={onFloat}
          onClose={onClose}
        />
      ))}
    </div>
  );
}
