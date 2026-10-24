import type { ReactElement } from 'react';

/**
 * 宿主内置图标（看板 HK-4 · UI 系统化第三轮；批次十一 L10 定尺寸刻度与 filled 规则）。
 *
 * 统一口径（`packages/app/tests/icons-system.test.ts` 逐条钉住，漂一枚即红）：
 * - **16×16 网格、单色、`currentColor`**——颜色永远跟着文字色走
 *   （悬停变亮、禁用变暗、`.on` 变 accent 都不用为图标另写规则）。
 * - **尺寸只有四档**（`ICON_SIZES`：xs=12 / sm=14 / md=16 / lg=22）。新调用一律传档位名；
 *   数字 `size` 是历史遗留形态（此前调用侧散装出 9/11/12/13/14/15/16/18/22 共 9 档），
 *   渲染时**就近吸附到档位**（平局取大档）——宿主未接线文件里的旧数字因此先收敛，
 *   逐处换成档位名见各批次「待接线」清单。
 * - **filled 规则：状态族 filled、其余全 stroke。** `fill="currentColor"` 子形只许出现在
 *   状态族（`FILLED_ICON_NAMES`：circle-filled / warning / info——诊断与未保存这类
 *   "状态灯"要一眼可读，filled 是它们的语法）；视图 / 动作 / 导航 / 布局 / 窗口 / 教程 /
 *   联系各族**整条路径纯描边**。批前混用的 structure 实心点、refresh / reset 实心箭头、
 *   target / wand 实心点已按此改齐。
 * - 对齐两套场景见 `styles.css` 的 `.icon` 基线规则（flex 行 `align-self:center`；
 *   行内文字流 `vertical-align:-0.16em`）。
 *
 * `UIPanelContribution.icon` 契约写的是「单字符或内置图标名（渲染器解释）」，
 * 本模块就是那个「渲染器」：命中注册表 → SVG；没命中 → 原样当字形渲染，
 * 因此未迁移的贡献方（含第三方插件）不会画成空白。
 */

/** 内置图标名（贡献方与壳层共用这一份词表） */
export type IconName = keyof typeof ICONS;

/** 四档尺寸刻度：全站图标尺寸只有这四个值（档位名调用，数字仅供吸附兜底）。 // ui-kit-candidate: 图标尺寸四档刻度 */
export const ICON_SIZES = { xs: 12, sm: 14, md: 16, lg: 22 } as const;

/** 尺寸档位名 */
export type IconSize = keyof typeof ICON_SIZES;

/** 允许出现 `fill="currentColor"` 子形的状态族图标（filled 规则的白名单，测试据此扫描全表） */
export const FILLED_ICON_NAMES: readonly string[] = ['circle-filled', 'warning', 'info'];

/**
 * 把历史遗留的数字尺寸就近吸附到四档刻度（平局取大档：13→14、15→16）。
 * 档位名与缺省（md）走直取。对外暴露是为了让自检测试能钉住吸附表，而不是只信渲染结果。
 */
export function resolveIconSize(size?: IconSize | number): number {
  if (size === undefined) return ICON_SIZES.md;
  if (typeof size === 'string') return ICON_SIZES[size];
  let best: number = ICON_SIZES.xs;
  for (const tier of Object.values(ICON_SIZES) as number[]) {
    const d = Math.abs(tier - size);
    if (d < Math.abs(best - size) || (d === Math.abs(best - size) && tier > best)) best = tier;
  }
  return best;
}

const stroke = (d: string): ReactElement => <path key={d} d={d} />;

export const ICONS = {
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
      <circle key="a" cx="2.7" cy="3.6" r="1.15" />
      <circle key="b" cx="2.7" cy="8" r="1.15" />
      <circle key="c" cx="2.7" cy="12.4" r="1.15" />
    </>
  ),
  preview: (
    <>
      {stroke('M2.4 3.4h11.2v9.2H2.4z')}
      {stroke('M9.6 3.4v9.2')}
    </>
  ),
  check: stroke('M3.2 8.4 6.4 11.6 12.8 4.6'),
  search: (
    <>
      <circle key="l" cx="7.1" cy="7.1" r="4.3" />
      {stroke('M10.3 10.3 13.8 13.8')}
    </>
  ),
  /**
   * 「全部保存」专用（视觉批十一收尾）：软盘轮廓 + 下标签，两笔。
   * 之前借 `archive`（收纳箱）——14px 下与 `trash` 同形，标签行最右那枚被读成"删除"，
   * 而它恰恰是最不该误认的一个动作。
   */
  'save-all': (
    <>
      {stroke('M3.2 2.8h7.2l2.4 2.4v8H3.2z')}
      {stroke('M5.6 9h4.8v4.2H5.6z')}
    </>
  ),
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
  /* 店面（口上市场入口，2026-10-18 用户反馈 3）：横向遮阳棚（上宽下窄）+ 门面 + 门。
     与 archive（方盒档案）靠"上宽下窄的棚 + 居中的门"区分，不做成又一只盒子。 */
  store: (
    <>
      {stroke('M2.4 3.2h11.2l-1 2.9H3.4z')}
      {stroke('M4.2 6.1v7.4h7.6V6.1')}
      {stroke('M6.6 13.5v-3.7h2.8v3.7')}
    </>
  ),
  target: (
    <>
      <circle key="r" cx="8" cy="8" r="5.8" />
      <circle key="d" cx="8" cy="8" r="2.1" />
    </>
  ),
  history: (
    <>
      <circle key="f" cx="8" cy="8" r="5.8" />
      {stroke('M8 4.6V8l2.6 1.8')}
    </>
  ),
  matrix: (
    <>
      {stroke('M2.4 2.4h11.2v11.2H2.4z')}
      {stroke('M6.2 2.4v11.2M9.8 2.4v11.2')}
      {stroke('M2.4 6.2h11.2M2.4 9.8h11.2')}
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
  /* refresh / reset 的箭头头部批前是实心三角（动作族混进 filled），按"状态 filled、其余 stroke"
     改齐成同坐标的描边三角；16 网格上观感不变（头部本来就贴着小尺寸）。 */
  refresh: (
    <>
      {stroke('M13.2 8A5.2 5.2 0 1 1 8 2.8')}
      {stroke('M8.2 1.3 10.6 2.8 8.2 4.3z')}
    </>
  ),
  reset: (
    <>
      {stroke('M2.8 8A5.2 5.2 0 1 0 8 2.8')}
      {stroke('M7.8 1.3 5.4 2.8 7.8 4.3z')}
    </>
  ),
  /* 垃圾桶（b/kbset/1017 快捷键页「移除键位」用）：盖沿 + 提手 + 桶身 + 两道竖肋 */
  trash: (
    <>
      {stroke('M2.6 4.4h10.8')}
      {stroke('M6.4 4.4V2.9h3.2v1.5')}
      {stroke('M4.3 4.4l.7 9.1h6l.7-9.1')}
      {stroke('M6.6 6.9v4.2M9.4 6.9v4.2')}
    </>
  ),
  settings: (
    <>
      {/* 齿轮（原「菊花」式八向辐条已否，用户 2026-10-14）：描齿廓 + 中心轴孔 */}
      {stroke('M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34z')}
      <circle key="h" cx="8" cy="8" r="2.9" />
    </>
  ),
  /* 键盘（b/kbset/1017 快捷键设置节导航用）：外框 + 两排键位 + 空格条，同款单色描边 */
  keyboard: (
    <>
      {stroke('M2.2 4.4h11.6v7.2H2.2z')}
      {stroke('M4.4 6.8h1.2M7.4 6.8h1.2M10.4 6.8h1.2')}
      {stroke('M4.4 9h1.2M7.4 9h1.2M10.4 9h1.2')}
      {stroke('M5.6 11h4.8')}
    </>
  ),

  /* --- 状态（filled 家族：状态灯要一眼可读，实心是这一族合法的画法） --- */
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

  /* --- 窗口控制（2026-10-17 永久无边框框架）：Windows 11 口径的 16×16 线条，
     全部 currentColor，hover 变亮由按钮规则统一给，不为图标另写颜色。 --- */
  minimize: stroke('M3 8.5h10'),
  maximize: stroke('M3.5 3.5h9v9h-9z'),
  /* 还原：两枚错位方框（后框只画露出的两条边），一眼看出「叠了一层」 */
  restore: (
    <>
      {stroke('M3.5 5.5v7h7')}
      {stroke('M5.5 3.5h7v7')}
    </>
  ),
  /* 进入全屏：四角向外张（与退出全屏的向内收方向相反） */
  fullscreen: stroke('M3.2 6V3.2H6M10 3.2h2.8V6M12.8 10v2.8H10M6 12.8H3.2V10'),
  /* 退出全屏：四角向内收（还原成普通窗口的手势） */
  'exit-fullscreen': stroke('M6 3.2V6H3.2M10 3.2V6h2.8M12.8 10H10v2.8M3.2 10H6v2.8'),

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
      <circle key="s" cx="13.2" cy="5.9" r="1.05" />
    </>
  ),

  /* --- 折叠指示 --- */
  /* 左箭头是右箭头的 x 轴镜像（16 网格上 x → 16 − x）：同一笔折线、同一 stroke 口径，
     不另造第二套画法。两批各自独立注册过它一次（视觉批十一 R1 把标签栏左滚从 CSS 旋转 180°
     换成真图标；批次十三同一改动同一几何 `M9.8 3.4 5.2 8l4.6 4.6`）——合树时并成一枚，
     方向是图标语义的一部分，注册表里有名字才谈得上在册闸（`icons-system.test.ts`）。 */
  'chevron-left': stroke('M9.8 3.4 5.2 8l4.6 4.6'),
  'chevron-right': stroke('M6.2 3.4 10.8 8l-4.6 4.6'),
  'chevron-down': stroke('M3.4 5.2 8 9.8l4.6-4.6'),

  /* --- 浮动窗口 --- */
  popout: (
    <>
      {stroke('M6.4 3.2H3.2v9.6h9.6V9.6')}
      {stroke('M8.4 7.6 13.2 2.8')}
      {stroke('M9.6 2.8h3.6v3.6')}
    </>
  ),

  /* --- 联系（2026-10-18 用户反馈 3）：信封 + 封舌折线，单色 currentColor --- */
  mail: (
    <>
      {stroke('M2.4 3.6h11.2v8.8H2.4z')}
      {stroke('M2.6 4.2 8 8.4l5.4-4.2')}
    </>
  ),
} satisfies Record<string, ReactElement>;

/** 未命中注册表时按字形文本渲染（兼容第三方贡献的单字符 `icon`） */
export function Icon({
  name,
  size = 'md',
  className,
}: {
  name: string;
  /** 档位名（首选）或历史遗留数字（就近吸附到档位） */
  size?: IconSize | number;
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
  const px = resolveIconSize(size);
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={px}
      height={px}
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
