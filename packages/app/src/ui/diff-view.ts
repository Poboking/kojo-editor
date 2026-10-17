import type { DiffViewSide, KernelEventMap } from '@kojo/plugin-api';
import { compareContent, type ContentEquality } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { ERB_LANGUAGE_ID } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../monaco/kojo-language';
import { diffPaneKeyOf, pushDiff, type DiffRequest } from './diff-core';

/**
 * 通用 diff 视图的宿主接线（2026-10-15 比对/历史批；W10 第 2 点改多开栈）。
 *
 * 形态照 `search-store.ts`：状态单源 + 订阅，组件只读投影，意图经内核事件
 * `ui.diffView.open` 进来（插件发意图、宿主落地）。
 *
 * 本文件只留**校验 / 取侧语言 / 事件落地**三件事；"开着哪几组比对"的状态格子
 * 住在 `diff-core.ts`（比对栈），所以这里不再有任何单例字段。判等口径按组长
 * 收窄令**保持原样**，不在本批动。零 React、零 Monaco import，node 可单测。
 */

/** 宿主 overlay 贡献 id（`App.tsx` 接线注册；`ui.overlay.open` 按此找组件） */
export const DIFF_VIEW_OVERLAY_ID = 'kojo.diffView';

export type { DiffPane, DiffRequest, DiffStateInput, DiffViewState } from './diff-core';
export {
  clearDiff,
  closeDiffPane,
  diffPaneKeyOf,
  focusDiffPane,
  getDiffPanes,
  getDiffState,
  pushDiff,
  setDiffState,
  subscribeDiff,
  topDiffPane,
} from './diff-core';

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

/* ------------------------------ 判等（W17 DIFF-EQ） ------------------------------ */

/** 一侧已解析的内容证据：文本必有（行态）；路径侧还能拿到原始字节（字节态） */
export interface DiffContentSide {
  readonly text: string;
  readonly bytes?: Uint8Array;
}

/** 两侧内容 → 同一份判等核的两态读数（字节态 + 行态从同一次比对派生） */
export function diffEqualityOf(a: DiffContentSide, b: DiffContentSide): ContentEquality {
  return compareContent({ bytes: a.bytes, text: a.text }, { bytes: b.bytes, text: b.text });
}

export interface DiffEqualityBanner {
  /** 行级无差异 ⇒ 不必建 diff 编辑器（Monaco 会给出空 diff，白占一整块） */
  readonly noLineDiff: boolean;
  readonly message: string;
}

/**
 * 「无差异」横幅的**唯一判据**（宿主侧不再各写 if 链）。
 *
 * - 行态不同 / 判不了 ⇒ null（交给 Monaco 行级 diff；判不了时不冒充一致）；
 * - 行态相同、字节态也相同 ⇒ 完全一致；
 * - 行态相同、字节态不同 ⇒ 行级看不出差异，但**按字节并不相同**（编码 / 换行风格）——
 *   必须说出来，否则"完全一致"是假话；
 * - 行态相同、字节态判不了（内联文本侧没有字节）⇒ 只说行级一致。
 */
export function diffEqualityBanner(eq: ContentEquality): DiffEqualityBanner | null {
  if (eq.linesEqual !== true) return null;
  if (eq.bytesEqual === true) return { noLineDiff: true, message: '两侧内容完全一致（无差异）。' };
  if (eq.bytesEqual === false) {
    return {
      noLineDiff: true,
      message: '两侧行内容一致，但字节不同（编码或换行风格差异）——按字节看并不相同。',
    };
  }
  return { noLineDiff: true, message: '两侧行内容一致（无差异）。' };
}

/* ------------------------------ 内核接线 ------------------------------ */

type DiffOpenPayload = KernelEventMap['ui.diffView.open'];

function toRequest(p: DiffOpenPayload): DiffRequest {
  return { title: p.title, original: p.original, modified: p.modified };
}

/**
 * 订阅 `ui.diffView.open` → 入栈一格比对 → 打开宿主 overlay。
 * 返回卸载函数。校验失败**照样开窗**（rejected 态由 overlay 呈现原因）——
 * 拒绝如果只进控制台，用户看到的仍是"点了没反应"。
 *
 * 多开：不同内容各占一格（`diffPaneKeyOf` 派生身份），同一对内容重开只把那一格
 * 置顶刷新；关掉当前这格回到上一格比对。事件形态未变 ⇒ 既有发起方零改动。
 */
export function bindDiffView(kernel: Kernel): () => void {
  return kernel.bus.on('ui.diffView.open', (p) => {
    const request = toRequest(p);
    const key = diffPaneKeyOf(request);
    const reason = validateDiffRequest(request);
    pushDiff(reason !== null ? { kind: 'rejected', key, reason } : { kind: 'request', key, request });
    kernel.bus.emit('ui.overlay.open', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' });
  });
}
