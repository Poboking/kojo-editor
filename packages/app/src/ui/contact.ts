/**
 * 开发者联系方式的**单一真源**（用户反馈 2 / 3 批，2026-10-18）。
 *
 * 纸条弹窗（`DevNoteDialog.tsx`）与设置页「关于」节（`SettingsPanel.tsx`）都要展示这个邮箱，
 * 两处各写一遍字面量的话，改一次地址就得记住两个地方——所以收在这里一份。
 *
 * 只在**呈现层**消费（展示文案 / `mailto:` 链接），不进任何偏好键、不进内核契约。
 */

/** 联系邮箱（作者可直接抄写） */
export const CONTACT_EMAIL = 'poboking@163.com';

/** 同一个地址的 `mailto:` 形态：交给系统默认邮件客户端，不经过 WebView 新窗口 */
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;
