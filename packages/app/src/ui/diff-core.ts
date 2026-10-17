import type { DiffViewSide } from '@kojo/plugin-api';

/**
 * 比对栈（W10 DIFF-UNIFY 第 2 点）：宿主侧「同时开着哪几组比对」。
 *
 * 旧实现是 `diff-view.ts` 里一个 `let current` 格子——后开者顶掉前一个，
 * 于是**一次只能开一个比对**。这里换成一条栈：
 *
 * - 一格 = 一个比对，`key` 由请求内容派生（同内容重开只置顶不复制，
 *   不同内容即便同名也各占一格）；
 * - 关中间那格不动其余；栈空才收模态；
 * - 每格的两侧读取快照由 overlay 组件按 `key` 各自缓存，格子之间互不污染。
 *
 * **判等口径一律不在本文件**：按组长收窄令，字节态/行态的判据保持各自现状
 * （deploy-diff 字节四态、回读断言值级），本文件只管"开着哪几组"。
 *
 * 零 React、零 Monaco import，node 环境可直接单测。事件形态
 * （`ui.diffView.open`）一个字没改——`key` 是宿主内部身份，发起方无需知道。
 */

/** 一次比对请求（左 original = 参照侧，右 modified = 对照侧） */
export interface DiffRequest {
  title: string;
  original: DiffViewSide;
  modified: DiffViewSide;
}

/** 一格比对的呈现状态：就绪 / 被拒（拒绝必须可见——铁律「不静默」） */
export type DiffViewState =
  | { kind: 'request'; key: string; request: DiffRequest }
  | { kind: 'rejected'; key: string; reason: string };

/** 栈里的一格 */
export interface DiffPane {
  key: string;
  state: DiffViewState;
}

/* ------------------------------ key 派生 ------------------------------ */

/** 极小稳定串哈希（djb2）：只为给"内联文本"侧一个可复现的格子身份，不做内容寻址 */
function stableKeyOf(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function sideKeyOf(side: DiffViewSide): string {
  if (typeof side.path === 'string' && side.path.length > 0) return `p:${side.path.toLowerCase()}`;
  if (typeof side.text === 'string') return `t:${side.label}:${stableKeyOf(side.text)}`;
  return `l:${side.label}`;
}

/** 同一对内容 = 同一格（重开只置顶刷新，不堆重复比对） */
export function diffPaneKeyOf(request: DiffRequest): string {
  return `${request.title}||${sideKeyOf(request.original)}||${sideKeyOf(request.modified)}`;
}

/* ------------------------------ 栈（状态单源） ------------------------------ */

let panes: DiffPane[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of [...listeners]) cb();
}

/** 栈快照（末位 = 当前可见格） */
export function getDiffPanes(): readonly DiffPane[] {
  return panes;
}

export function topDiffPane(): DiffPane | null {
  return panes.length === 0 ? null : panes[panes.length - 1]!;
}

/** 栈顶那格的状态（空栈 = null） */
export function getDiffState(): DiffViewState | null {
  return topDiffPane()?.state ?? null;
}

/**
 * 入栈（按 key 隔离）：已有同 key ⇒ 就地替换内容并置顶；没有 ⇒ 追加为新格。
 * 别的格子原样留在栈里——这正是"多开互不覆盖"的全部含义。
 */
export function pushDiff(state: DiffViewState): void {
  panes = [...panes.filter((p) => p.key !== state.key), { key: state.key, state }];
  notify();
}

/**
 * 关掉指定的那一格（缺省关栈顶）。返回**是否已关到空栈**——
 * 空栈才该收模态；关中间一格不许把别的比对一起带走。
 */
export function closeDiffPane(key?: string): boolean {
  const target = key ?? topDiffPane()?.key;
  if (target === undefined) return true;
  panes = panes.filter((p) => p.key !== target);
  notify();
  return panes.length === 0;
}

/** 置顶某一格（多开时的"切过去"） */
export function focusDiffPane(key: string): void {
  const hit = panes.find((p) => p.key === key);
  if (!hit) return;
  panes = [...panes.filter((p) => p.key !== key), hit];
  notify();
}

/** 清空（模态整体关闭时调用；留着旧格子会让下次开窗读到陈年比对） */
export function clearDiff(): void {
  if (panes.length === 0) return;
  panes = [];
  notify();
}

/**
 * 旧单格 API 的兼容写口形态（不带 key——key 由内容派生）。
 * 新代码请直接用 `pushDiff` / `closeDiffPane`；保留它只为让既有调用方
 * （写一个请求 / 传 null 收摊）零改动即可继续读写同一份状态。
 */
export type DiffStateInput =
  | { kind: 'request'; request: DiffRequest }
  | { kind: 'rejected'; reason: string };

/** 旧写口：null ⇒ 清整条栈；否则按派生 key 入栈（等价于 pushDiff） */
export function setDiffState(next: DiffStateInput | null): void {
  if (next === null) {
    clearDiff();
    return;
  }
  pushDiff(
    next.kind === 'request'
      ? { kind: 'request', key: diffPaneKeyOf(next.request), request: next.request }
      : { kind: 'rejected', key: `rejected||${next.reason}`, reason: next.reason },
  );
}

export function subscribeDiff(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
