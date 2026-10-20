import { errorText } from '@kojo/plugin-api';
import type { NoticeInput } from './NotificationCenter';

/** autosave journal 的强制清空面（只收这一条能力，测试可裸替身） */
export interface RecoveryJournalLike {
  discard(): Promise<void>;
}

/**
 * 强制丢弃崩溃恢复件；**失败不静默**——返回一条作者可见的通知，由宿主上屏。
 *
 * 为什么要单独一条：欢迎页「丢弃」与崩溃卡「丢弃未保存改动」原先都用
 * `catch(() => undefined)` 吞掉清理失败。后果不是当场报错，而是**下次启动又弹恢复横幅**，
 * 作者会以为「我明明点了丢弃」。清理失败不挡后续动作（关项目照常），但必须说出来。
 *
 * 没有引擎（浏览器壳 / 装配失败）⇒ `null`，无事可做也不制造噪声。
 */
export async function discardRecoveryJournal(
  journal: RecoveryJournalLike | null,
): Promise<NoticeInput | null> {
  if (!journal) return null;
  try {
    await journal.discard();
    return null;
  } catch (err) {
    return {
      kind: 'error',
      message: '恢复件清理失败：下次启动可能仍会提示恢复未保存内容。',
      // 技术原文只进悬停（口径同 NoticeInput.detail）
      detail: errorText(err),
    };
  }
}
