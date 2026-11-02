import { type CSSProperties, type ReactElement, type ReactNode } from 'react';
import {
  downloadPercent,
  downloadProgressText,
  formatBytes,
} from './update-check';
import '../update-progress.css';

/**
 * 更新反馈的两枚基元（状态胶囊 + 下载进度）——详情模态、右下提醒卡、设置页三张面共用一份。
 *
 * 放在这里的理由与 `update-progress.css` 文件头同：这三件东西今天出现在三张面上，
 * 过去只有模态用得起（类名钉在 `.update-dialog-*` 上），另两张面各写一种文字形态。
 * 呈现层不许再造第三份：新加的更新界面请从这里取。
 */

/** 胶囊的语义档：进行中（accent 呼吸）/ 装好（success 常亮）/ 没装好（danger 常亮） */
export type UpdateStatusTone = 'active' | 'done' | 'failed';

export interface UpdateStatusProps {
  /** 缺省 active：带呼吸点的「某事正在进行」 */
  tone?: UpdateStatusTone;
  children: ReactNode;
}

/**
 * 状态胶囊：这是**状态**，不是动作按钮。
 *
 * 下载态原先在页脚里画一枚禁用的「正在下载…」按钮，和「下载并安装」并排极易误读
 * （用户反馈批掐掉的第一个点）；页脚只留真动作，状态住正文。
 */
export function UpdateStatus({ tone = 'active', children }: UpdateStatusProps): ReactElement {
  return (
    <span
      className="update-status"
      data-tone={tone}
      role="status"
      {...(tone === 'active' ? { 'aria-busy': 'true' } : {})}
    >
      <span className="update-status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export interface UpdateProgressProps {
  /** 已下载字节数 */
  received: number;
  /** 总字节数；null = 总量未知（`Started` 还没报 contentLength），轨道转不定态光带 */
  total: number | null;
  /** `sm` = 右下卡那种窄槽位；模态与设置页用缺省的 `md` */
  size?: 'sm' | 'md';
  /** 读数与轨道同排（卡里只给得起一行高） */
  inline?: boolean;
  /** 读数行的无障碍名 */
  label?: string;
}

/**
 * 下载进度：一条轨道 + 合成缩放填充 + 一行读数。
 *
 * 三条口径钉死在这里，别让三张面各算各的：
 * - 百分数与条宽同源（都走 `downloadPercent`，见 `update-check.ts` 的算式注释）；
 * - 总量未知时读数退化成「已下载 X，总量未知」，**不画假百分比**；
 * - 条宽走 `transform: scaleX()` 不吃 `width`——分片事件很密，逐帧重排会卡。
 */
export function UpdateProgress({
  received,
  total,
  size = 'md',
  inline = false,
  label = '更新下载进度',
}: UpdateProgressProps): ReactElement {
  const pct = downloadPercent(received, total);
  const text = downloadProgressText(received, total) ?? `已下载 ${formatBytes(received)}，总量未知`;
  return (
    <div
      className="update-progress"
      data-size={size}
      {...(inline ? { 'data-inline': 'true' } : {})}
    >
      <div
        className="update-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct !== null ? { 'aria-valuenow': pct } : {})}
        {...(pct === null ? { 'aria-valuetext': '正在下载安装，总量未知' } : {})}
        data-indeterminate={pct === null ? 'true' : 'false'}
      >
        <div
          className="update-progress-fill"
          style={pct !== null ? ({ '--ud-progress': String(pct / 100) } as CSSProperties) : undefined}
        />
      </div>
      <div className="update-progress-line">
        <span>{text}</span>
      </div>
    </div>
  );
}
