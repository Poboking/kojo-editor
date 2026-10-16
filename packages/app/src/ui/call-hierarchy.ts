/**
 * 调用层级 overlay 的宿主状态（2026-10-16 批 E）。
 *
 * 形态照 `diff-view.ts` / `file-history.ts` 同款：模块级单源 + 订阅，零 React、
 * 零 Monaco，node 可单测。意图经 `editor.command` 进来（命令面板条目，宿主
 * App.tsx 注册）；位点（文件 + 光标行）由命令侧现取 `readJumpProbe()`（G1 既有
 * 探针，EditorPane 挂载时注册）——不新建第二套"光标在哪"的通道。
 */

/** ui.overlay 贡献 id（`App.tsx` 接线注册；开/关窗走 `ui.overlay.open`/`close`） */
export const CALL_HIERARCHY_OVERLAY_ID = 'kojo.callHierarchy';

/** editor.command 贡献 id（命令面板条目） */
export const CALL_HIERARCHY_COMMAND_ID = 'kojo.showCallHierarchy';

/** 一次查询的位点：文件 + 光标行（1 基，模型坐标） */
export interface CallHierarchyRequest {
  readonly filePath: string;
  readonly line: number;
}

/**
 * 状态三态：就绪请求 / 可见拒绝（位点取不到时的原因——拒绝必须进面板，不许
 * 只进控制台，铁律「不静默」）/ 无（未开过或已清）。
 */
export type CallHierarchyState =
  | { readonly kind: 'request'; readonly request: CallHierarchyRequest }
  | { readonly kind: 'rejected'; readonly reason: string }
  | null;

let current: CallHierarchyState = null;
const listeners = new Set<() => void>();

export function getCallHierarchyState(): CallHierarchyState {
  return current;
}

export function setCallHierarchyState(next: CallHierarchyState): void {
  current = next;
  for (const cb of [...listeners]) cb();
}

export function subscribeCallHierarchy(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
