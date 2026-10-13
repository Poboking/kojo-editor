import type { ReactElement } from 'react';

/**
 * 宿主内置图标（看板 HK-4 · UI 系统化第三轮）。
 *
 * 统一口径：**16×16 网格、单色、`currentColor`**——颜色永远跟着文字色走
 * （悬停变亮、禁用变暗、`.on` 变 accent 都不用为图标另写规则）。
 *
 * `UIPanelContribution.icon` 契约写的是「单字符或内置图标名（渲染器解释）」，
 * 本模块就是那个「渲染器」：命中注册表 → SVG；没命中 → 原样当字形渲染，
 * 因此未迁移的贡献方（含第三方插件）不会画成空白。
 */

/** 内置图标名（贡献方与壳层共用这一份词表） */
export type IconName = keyof typeof ICONS;

const stroke = (d: string): ReactElement => <path key={d} d={d} />;

const ICONS = {
  /* --- 视图 --- */
  files: (
    <>
      {stroke('M9 1.8H4.5v12.4h7V5.3z')}
      {stroke('M9 1.8v3.5h2.5')}
    </>
  ),
  home: (
    <>
      {stroke('M2.4 7.6 8 2.6l5.6 5')}
      {stroke('M4.3 6.9v7.1h7.4V6.9')}
      {stroke('M6.8 14v-3.6h2.4V14')}
    </>
  ),
  structure: (
    <>
      {stroke('M5.4 3.6h7.8M5.4 8h7.8M5.4 12.4h7.8')}
      <circle key="a" cx="2.7" cy="3.6" r="1.05" fill="currentColor" stroke="none" />
      <circle key="b" cx="2.7" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle key="c" cx="2.7" cy="12.4" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  preview: (
    <>
      {stroke('M2.4 3.4h11.2v9.2H2.4z')}
      {stroke('M9.6 3.4v9.2')}
    </>
  ),
  check: stroke('M3.2 8.4 6.4 11.6 12.8 4.6'),
  archive: (
    <>
      {stroke('M2.4 2.8h11.2v3H2.4z')}
      {stroke('M3.4 5.8v7.4h9.2V5.8')}
      {stroke('M6.4 8.6h3.2')}
    </>
  ),
  snapshot: (
    <>
      {stroke('M2.4 5.6h2.2l1.4-1.8h4l1.4 1.8h2.2v7.8H2.4z')}
      <circle key="l" cx="8" cy="9.2" r="2.4" />
    </>
  ),
  code: (
    <>
      {stroke('M5.6 4.4 2 8l3.6 3.6')}
      {stroke('M10.4 4.4 14 8l-3.6 3.6')}
    </>
  ),
  module: (
    <>
      {stroke('M8 1.9 13.4 4.9v6.2L8 14.1 2.6 11.1V4.9z')}
      {stroke('M2.6 4.9 8 8l5.4-3.1M8 8v6.1')}
    </>
  ),
  target: (
    <>
      <circle key="r" cx="8" cy="8" r="5.8" />
      <circle key="d" cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  history: (
    <>
      <circle key="f" cx="8" cy="8" r="5.8" />
      {stroke('M8 4.6V8l2.6 1.8')}
    </>
  ),

  /* --- 动作 --- */
  add: stroke('M8 3v10M3 8h10'),
  close: stroke('M4 4l8 8M12 4l-8 8'),
  edit: (
    <>
      {stroke('M11.2 2.4 13.6 4.8 5.2 13.2l-3.2.8.8-3.2z')}
      {stroke('M9.6 4 12 6.4')}
    </>
  ),
  refresh: (
    <>
      {stroke('M13.2 8A5.2 5.2 0 1 1 8 2.8')}
      <path key="h" d="M8.2 1.3 10.6 2.8 8.2 4.3z" fill="currentColor" stroke="none" />
    </>
  ),
  reset: (
    <>
      {stroke('M2.8 8A5.2 5.2 0 1 0 8 2.8')}
      <path key="h" d="M7.8 1.3 5.4 2.8 7.8 4.3z" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <circle key="h" cx="8" cy="8" r="3" />
      {stroke('M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2')}
      {stroke('M3.33 3.33 4.89 4.89M11.11 11.11 12.67 12.67')}
      {stroke('M12.67 3.33 11.11 4.89M3.33 12.67 4.89 11.11')}
    </>
  ),

  /* --- 状态 --- */
  'circle-filled': <circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none" />,
  warning: (
    <>
      {stroke('M8 2.2 14.2 13.4H1.8z')}
      {stroke('M8 6.4v3.1')}
      <circle key="d" cx="8" cy="11.5" r="0.65" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle key="r" cx="8" cy="8" r="5.8" />
      {stroke('M8 7.2v4.2')}
      <circle key="d" cx="8" cy="4.9" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  error: (
    <>
      <circle key="r" cx="8" cy="8" r="5.8" />
      {stroke('M5.7 5.7 10.3 10.3M10.3 5.7 5.7 10.3')}
    </>
  ),

  /* --- 布局切换 --- */
  'layout-sidebar-left': (
    <>
      {stroke('M2.4 3.4h11.2v9.2H2.4z')}
      {stroke('M6.2 3.4v9.2')}
    </>
  ),
  'layout-sidebar-right': (
    <>
      {stroke('M2.4 3.4h11.2v9.2H2.4z')}
      {stroke('M9.8 3.4v9.2')}
    </>
  ),
  'layout-panel-bottom': (
    <>
      {stroke('M2.4 3.4h11.2v9.2H2.4z')}
      {stroke('M2.4 9.6h11.2')}
    </>
  ),

  /* --- 教程（内置教程入口两枚：书 = 全流程教程；魔杖 = 写法魔法） --- */
  book: (
    <>
      {stroke('M8 3.4C6.6 2.6 4.8 2.2 2.8 2.2v10c2 0 3.8.4 5.2 1.2')}
      {stroke('M8 3.4c1.4-.8 3.2-1.2 5.2-1.2v10c-2 0-3.8.4-5.2 1.2')}
      {stroke('M8 3.4v10')}
    </>
  ),
  wand: (
    <>
      {stroke('M2.8 13.2 11.2 4.8')}
      {stroke('M13 1.8v2M12 2.8h2')}
      <circle key="s" cx="13.2" cy="5.9" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),

  /* --- 折叠指示 --- */
  'chevron-right': stroke('M6.2 3.4 10.8 8l-4.6 4.6'),
  'chevron-down': stroke('M3.4 5.2 8 9.8l4.6-4.6'),
} satisfies Record<string, ReactElement>;

/** 未命中注册表时按字形文本渲染（兼容第三方贡献的单字符 `icon`） */
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}): ReactElement {
  const shape = ICONS[name as IconName];
  if (shape === undefined) {
    return (
      <span className={`icon-glyph${className ? ` ${className}` : ''}`} aria-hidden="true">
        {name}
      </span>
    );
  }
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape}
    </svg>
  );
}
