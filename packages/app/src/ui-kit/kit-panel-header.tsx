/**
 * KitPanelHeader —— 面板常驻头的单品叶子（1026 kit-converge C1-a / VIS-22）。
 *
 * 现状是同一块「sticky 头 + 读数 + 动作」被三处各写一遍（`prob-head` / `ksp-head` /
 * `outline-panel__meta`），字号、内衬、粘底策略三档混用。本件收编成一副骨架：
 * 标题槽 · 计数槽 · 动作槽（右靠）在同一主行，`children` 是主行之外的追加行（工具条 /
 * 状态区，纵排）。样式住 `ui-kit.css`（`.kit-panel-header*`，只吃 token）；面板自己的
 * 度量差异由各域切片双类压一格（与到达顺序无关）。
 *
 * 叶子纪律照 `kit-radio`：消费方直引本文件，不经桶棒（开机图只为真用到的件付费）。
 */
import { type CSSProperties, type ReactElement, type ReactNode, type Ref } from 'react';

/** 类名拼接（ui-kit 总纲里那枚私有小工具；叶子各自内联一份，不为一行工具拉桶棒进图） */
const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export interface KitPanelHeaderProps {
  /** 标题槽（缺省不画——`ksp-head` 档只有控件行没有标题） */
  title?: ReactNode;
  /** 计数槽（紧随标题；读数徽标建议交 `KitCount`，本槽只管落位） */
  count?: ReactNode;
  /** 动作槽（右靠 `margin-left:auto`；无动作就缺省——`outline-panel__meta` 档） */
  actions?: ReactNode;
  /** 主行之外的追加行（工具条 / 状态区），纵排、沟 `--space-1` */
  children?: ReactNode;
  /** 粘顶常驻（缺省 true；false 退成普通头，滚动时跟着走） */
  sticky?: boolean;
  /** 负外边距反衬宿主 `.panel` 内衬：粘住时整条带横到容器边缘、条目从底下滚过（`prob-head` 档） */
  bleed?: boolean;
  /** 底色取 `--surface-raised`（侧栏 meta 档；缺省 `--bg-2`） */
  raised?: boolean;
  /** 元信息档：单行 fs-0 + dim + tabular-nums + 紧内衬（`outline-panel__meta` 的度量） */
  meta?: boolean;
  id?: string;
  className?: string;
  style?: CSSProperties;
  /** 虚拟列表要量常驻头挡住多高：ref 直落根 div（ProblemPanel / SearchPanel 的 headRef） */
  ref?: Ref<HTMLDivElement>;
}

/** 面板常驻头统一骨架（槽：标题 · 计数 · 动作；追加行走 children）。 */
export function KitPanelHeader({
  title,
  count,
  actions,
  children,
  sticky = true,
  bleed = false,
  raised = false,
  meta = false,
  id,
  className,
  style,
  ref,
}: KitPanelHeaderProps): ReactElement {
  const hasMain = title !== undefined || count !== undefined || actions !== undefined;
  return (
    <div
      id={id}
      ref={ref}
      style={style}
      className={cx(
        'kit-panel-header',
        !sticky && 'kit-panel-header-static',
        bleed && 'kit-panel-header-bleed',
        raised && 'kit-panel-header-raised',
        meta && 'kit-panel-header-meta',
        className,
      )}
    >
      {hasMain ? (
        <div className="kit-panel-header-main">
          {title !== undefined ? <span className="kit-panel-header-title">{title}</span> : null}
          {count !== undefined ? <span className="kit-panel-header-count">{count}</span> : null}
          {actions !== undefined ? <span className="kit-panel-header-actions">{actions}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
