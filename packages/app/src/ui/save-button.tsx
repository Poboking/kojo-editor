import type { ReactElement } from 'react';
import { projectErrorNoticeId } from './project-error-notice';
import { writeDomainSaveBlockedMessage } from './write-domain';

/**
 * 编辑器工具条的保存按钮（SAVE-BUTTON-IO-SEAM 出路②，2026-10-21）。
 *
 * 从 `EditorPane.tsx` 的 JSX 里析出来，只为收口一件事：这颗按钮的可用性判定从此**同时认
 * 宿主那份事实**。上一批（出路①）只收了项目级可写态——只读横幅、状态栏胶囊、带
 * 「重新选择这个文件夹」的常驻错误条都到位了，但每个文件这颗保存按钮仍按
 * `kernel.io.isWritable`（TS 批准记录）判定，宿主准入门拒过的目录里解锁后按钮物理上
 * 仍可点、按下才吃一句内核的域外拒绝。**按下去必然失败的动作就不该按得动**：
 * - `hostBlocked = true` ⇒ 按钮渲染但**置灰**（disabled），悬停说清原因与出路；
 * - 可达性交给常驻错误条：`aria-describedby` 指向 `projectErrorNoticeId`，屏上那句话和
 *   那颗出路按钮就在同一条错误条上（不强行 `focus()`——切一次标签抢一次编辑器焦点，
 *   比按不动的按钮更打扰作者）。
 *
 * 判定本身住在 `write-domain.ts`（`saveBlockedByHostWriteDomain`），这里只消费布尔值 ⇒
 * 纯展示组件，happy-dom 直接挂载断言，不需要 Monaco。渲染条件（`kernel.io.isWritable`
 * 为假整颗不渲染的 P3-4 三段式口径）**留在调用方**，本组件一字不改那条既有语义。
 */
export interface SaveButtonProps {
  /** 当前文件有未保存修改（既有三段式：无改动 = .idle 弱化档 + disabled） */
  readonly dirty: boolean;
  /** 宿主准入门拒绝态覆盖这份文件（write-domain 会话单例现读，见 saveBlockedByHostWriteDomain） */
  readonly hostBlocked: boolean;
  readonly onSave: () => void;
}

export function SaveButton({ dirty, hostBlocked, onSave }: SaveButtonProps): ReactElement {
  return (
    <button
      className={`primary small${dirty ? '' : ' idle'}`}
      onClick={onSave}
      disabled={!dirty || hostBlocked}
      {...(hostBlocked
        ? { title: writeDomainSaveBlockedMessage, 'aria-describedby': projectErrorNoticeId }
        : {})}
    >
      保存 (Ctrl+S)
    </button>
  );
}
