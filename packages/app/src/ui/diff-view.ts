import type { DiffViewSide, KernelEventMap } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { ERB_LANGUAGE_ID } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../monaco/kojo-language';

/**
 * 通用 diff 视图的宿主状态（2026-10-15 比对/历史批）。
 *
 * 形态照 `search-store.ts`：模块级单源 + 订阅；组件只读投影，意图经内核事件
 * `ui.diffView.open` 进来（插件发意图、宿主落地）。逻辑（校验/取侧语言/落地）
 * 全部住本文件——零 React、零 Monaco import，node 环境可直接单测。
 */

/** 宿主 overlay 贡献 id（`App.tsx` 接线注册；`ui.overlay.open` 按此找组件） */
export const DIFF_VIEW_OVERLAY_ID = 'kojo.diffView';

export interface DiffRequest {
  title: string;
  original: DiffViewSide;
  modified: DiffViewSide;
}

/** diff 视图状态：就绪 / 被拒（拒绝必须可见——铁律「不静默」） */
export type DiffViewState =
  | { kind: 'request'; request: DiffRequest }
  | { kind: 'rejected'; reason: string };

/**
 * 校验 diff 请求，返回拒绝原因（null = 合法）。
 * 判据只有一条硬规则：每一侧至少要有 `text` 或可用 `path` 之一，
 * 否则视图打开后是一片读不出内容的空白——那比不打开更坏。
 */
export function validateDiffRequest(r: DiffRequest): string | null {
  const bad = (side: DiffViewSide, which: string): string | null => {
    const hasText = typeof side.text === 'string';
    const hasPath = typeof side.path === 'string' && side.path.length > 0;
    if (!hasText && !hasPath) return `${which}侧既没有内联文本也没有可读路径，无法对比。`;
    return null;
  };
  return bad(r.original, '左') ?? bad(r.modified, '右') ?? null;
}

/** 从标签/路径尾推断 Monaco 语言 id（未知即 plaintext——高亮是锦上添花，不能猜错） */
export function languageIdForSide(side: DiffViewSide): string {
  const probe = (side.path ?? side.label).toLowerCase();
  if (/\.kojo$/.test(probe)) return KOJO_LANGUAGE_ID;
  if (/\.(erb|erh)$/.test(probe)) return ERB_LANGUAGE_ID;
  return 'plaintext';
}

/* ------------------------------ 状态单源 ------------------------------ */

let current: DiffViewState | null = null;
const listeners = new Set<() => void>();

export function getDiffState(): DiffViewState | null {
  return current;
}

export function setDiffState(next: DiffViewState | null): void {
  current = next;
  for (const cb of [...listeners]) cb();
}

export function subscribeDiff(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ------------------------------ 内核接线 ------------------------------ */

type DiffOpenPayload = KernelEventMap['ui.diffView.open'];

function toRequest(p: DiffOpenPayload): DiffRequest {
  return { title: p.title, original: p.original, modified: p.modified };
}

/**
 * 订阅 `ui.diffView.open` → 落状态 → 打开宿主 overlay。
 * 返回卸载函数。校验失败**照样开窗**（rejected 态由 overlay 呈现原因）——
 * 拒绝如果只进控制台，用户看到的仍是"点了没反应"。
 */
export function bindDiffView(kernel: Kernel): () => void {
  return kernel.bus.on('ui.diffView.open', (p) => {
    const request = toRequest(p);
    const reason = validateDiffRequest(request);
    setDiffState(reason !== null ? { kind: 'rejected', reason } : { kind: 'request', request });
    kernel.bus.emit('ui.overlay.open', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' });
  });
}
