import type * as Monaco from './entry';

/**
 * 重命名（F2）的**拒绝回执**构造（两条方言通道共用一份）。
 *
 * monaco 0.57 standalone 的 rename 控制器见 `rejectReason` 会**丢弃全部** `WorkspaceEdit`
 * （`rename.js:241`）⇒ 一次拒绝的形状恒为「空编辑集 + 理由」，`.kojo` 与 `.erb` 两条通道
 * 因此不需要各持一份构造函数。理由文案是屏上给作者看的话，一律由调用方自带，
 * 本模块不掺任何文案、也不做全或无判定（那在各自文件里）。
 */
export function reject(reason: string): Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection {
  return { edits: [], rejectReason: reason };
}
