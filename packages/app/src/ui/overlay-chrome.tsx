import { createElement as h, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * 浮层族统一外框（批次十一 L12-overlays）。
 *
 * 五家浮层（比对 / 文件时间线 / 操作历史 / 调用层级 / 快速修复预览）原先各写各的
 * `div.wizard *-host > h3 + 正文 + div.wizard-actions`，于是同一扇窗里出现了四种 chrome：
 * 标题会不会卷出视野、有没有 ✕、宽度吃哪一档、遮罩重不重——全看点开的是哪一家。
 * 本模块把**外框**收成一处，五家只交正文与页脚：
 *
 * - `tier`：宿主宽度档（`md` 560 / `wide` 920 / `xl` 1160）。档由浮层自己挂类声明，
 *   不再由内层 `width: min(1180px…)` 反向撑破外层（原 `.kd-host` 1180 塞在
 *   `.overlay-host-wide` 920 里 ⇒ 横向被裁 + 双滚动条）。
 * - `mode`：遮罩档。`modal` = 确认/破坏性（应用修复、恢复、批回滚），吃既有全遮罩磨砂；
 *   `query` = 只读查询（时间线、调用层级、比对），遮罩减淡一档，与 `.floating-panel` 同族。
 *   刻意保留遮罩 ⇒ 点遮罩关闭的既有行为一字不变，只改"读起来像不像模态"。
 * - `fill`：正文里挂 Monaco 编辑器的两家用 `true`——正文不滚，只留编辑器自己那道滚动。
 *
 * 关闭只有 `onClose` 一个口：标题栏的 ✕ 与页脚按钮交的是**同一个函数**，各家把
 * 自己的收尾（比对的清栈、预览的撤账）包在里面，Esc / 遮罩那两条通道如何并进来见
 * 本批「待接线」——那是 `ShellLayout.tsx` 的地盘，不在本模块的权限里。
 *
 * 样式一律走 `styles-project.css` 的 `ov-*` 区块（本模块零内联样式）。
 */

/** 宿主宽度档（与 `shell-overlays.ts` 注册贡献的 `size` 同族；`xl` 是本批新增的第四档） */
export type OverlayTier = 'md' | 'wide' | 'xl';

/**
 * 退场动画类（批次十一 L12）：钉在 `.overlay-host` 上跑 `overlay-out`（`--dur-2` 那一档，
 * 入场 `--dur-3` 的回声；规则见 `styles-project.css` 的 `ov-*` 区块）。
 *
 * **本 lane 只能把类与动画备好**：宿主节点的卸载时机握在 `ShellLayout.tsx` 手里
 * （Esc 全局键盘 1654 行、点遮罩 2557 行都是直接 `setActiveOverlay(null)`），
 * 要真退场需要壳层先挂类、等 `--dur-2` 再卸载——那是 L12 边界外的接线，见批次回执。
 */
export const OVERLAY_EXIT_CLASS = 'ov-exiting';

/** 遮罩档：确认/破坏性 = `modal`，只读查询 = `query` */
export type OverlayMode = 'modal' | 'query';

export interface OverlayFrameOptions {
  /**
   * 既有宿主类（`kd-host` / `fh-host` / `oh-host` / `ch-host` / `qfp-host`）原样保留——
   * 它们已被 `styles-project.css` 与既有测试认账，本批不重命名、不摘除。
   */
  hostClass: string;
  /** 标题栏文本（短：文件名 / 动作名；长路径仍由正文那行 `p.fh-path` 承载） */
  title: ReactNode;
  /** 收口动作：与页脚按钮同源，必须包含各家自己的收尾（清比对栈 / 撤预览账） */
  onClose(): void;
  tier?: OverlayTier;
  mode?: OverlayMode;
  /** 正文里挂编辑器（比对 / 快速修复预览）⇒ 正文不滚，编辑器填满剩余高度 */
  fill?: boolean;
  /** ✕ 的无障碍名（缺省「关闭」；比对那一家的 ✕ 语义是"收掉整扇窗"，用它说清） */
  closeLabel?: string;
  /** ✕ 的悬停说明（可选：说清"关掉整扇窗"与页脚"只关这一本"的分工） */
  closeHint?: string;
  children?: ReactNode;
  /** 页脚：既有的 `wizard-actions` 内容原样交进来，本模块负责把它钉在窗口底部 */
  footer?: ReactNode;
  /**
   * 浮层根上的 `data-context-surface`（右键菜单面的身份标记，批次十菜单接线用）。
   * 写在**外框根 div** 上——菜单构建器从任意命中点 `closest('[data-context-surface]')`
   * 找面，外框换了壳不能让它找不到。
   */
  contextSurface?: string;
  /**
   * 面级事实属性（`data-ch-subject-name` 一类），同样钉在外框根 div 上：
   * 模块顶层的菜单 `build` 只读 DOM、不靠 React 闭包，外框不许把它们吃掉。
   */
  surfaceData?: Readonly<Record<string, string>>;
}

/**
 * 一扇浮层的外框：`标题栏（钉住 + ✕） / 正文（唯一滚动的地方） / 页脚（钉底）`。
 *
 * 纯呈现函数、无状态、无副作用——各家把它包在最外层即可，比对栈 / 历史 / 调用层级
 * 的数据语义一律不碰。
 */
export function overlayFrame(opts: OverlayFrameOptions): ReactNode {
  const tier = opts.tier ?? 'md';
  const mode = opts.mode ?? 'modal';
  const closeLabel = opts.closeLabel ?? '关闭';
  const head = h(
    'div',
    { key: 'head', className: 'ov-head' },
    h('h3', { className: 'ov-title' }, opts.title),
    h(
      'button',
      {
        className: 'ghost small ov-close',
        type: 'button',
        'aria-label': closeLabel,
        ...(opts.closeHint !== undefined ? { title: opts.closeHint } : {}),
        onClick: () => opts.onClose(),
      },
      // 批次十一 L12：字符 `✕` 换成内置 `close` SVG（L10 四档刻度里的 `sm`=14）——
      // 字形随字体族漂移、屏幕阅读器等工具读它也不如带 aria-label 的图形稳。
      h(Icon, { name: 'close', size: 'sm' }),
    ),
  );
  const cls = [
    'wizard',
    'ov',
    `ov-${tier}`,
    `ov-${mode}`,
    ...(opts.fill === true ? ['ov-fill'] : []),
    opts.hostClass,
  ].join(' ');
  return h(
    'div',
    {
      className: cls,
      ...(opts.contextSurface !== undefined ? { 'data-context-surface': opts.contextSurface } : {}),
      ...(opts.surfaceData ?? {}),
    },
    head,
    h('div', { key: 'body', className: 'ov-body' }, opts.children ?? null),
    opts.footer !== undefined && opts.footer !== null
      ? h('div', { key: 'foot', className: 'wizard-actions ov-foot' }, opts.footer)
      : null,
  );
}

/**
 * 浮层的装载态：转圈 + 一句话。
 *
 * 原先五家的加载态都是一枚裸 `.dim` 段落，既有 `.spinner` / `.skeleton` 一处没用——
 * 于是"正在读"在屏幕上读作"这里什么都没有"。
 */
export function overlaySpinner(label: string): ReactNode {
  return h(
    'div',
    { className: 'ov-loading', role: 'status' },
    h('span', { className: 'spinner', 'aria-hidden': 'true' }),
    h('span', null, label),
  );
}

/**
 * 装载态的**占位骨架**：`n` 行 shimmer，替掉空白，避免读数回来时整窗跳动。
 * 与 `overlaySpinner` 叠用（一句话在上，骨架在下）。
 */
export function overlaySkeletonRows(n: number): ReactNode {
  const rows: ReactNode[] = [];
  for (let i = 0; i < n; i++) rows.push(h('div', { key: i, className: 'skeleton ov-skeleton-row' }));
  return h('div', { className: 'ov-skeleton', 'aria-hidden': 'true' }, ...rows);
}

/**
 * 编辑器井的骨架（比对 / 快速修复预览专用）：尺寸照 `.kd-editor` / `.qfp-editor` 的
 * 井给，编辑器就位后原地换成 Monaco，不留高度塌陷。
 */
export function overlaySkeletonWell(): ReactNode {
  return h('div', { className: 'skeleton ov-skeleton-well', 'aria-hidden': 'true' });
}
