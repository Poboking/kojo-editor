/**
 * EditorPane 的多实例基座：活着的每个编辑器实例在模块登记簿里的一条档案（SPLIT-1 分屏）。
 *
 * 为什么单独成模块：standalone Monaco 的 language provider / `registerCommand` / 跳转探针都是
 * **全局单表**，注册只能有一份（见 `editor-global-providers.ts`）；那一份要判"这份 model 属于
 * 哪个实例"，就必须有一份跨实例的登记簿。本模块只管登记簿，以及由它派生的反查（归属实例 /
 * 焦点实例 / 跨组已开标签 / 单 kernel 来源），不注册任何 provider，也不 import React。
 *
 * 两条语义不许动：
 * - 档案里存的是组件持有的**同一批 ref 壳**（`{ current: X }`）。复制 ref = 让 provider 读到
 *   一个影子，每一条反查都会静默失效。
 * - 焦点位与 kernel 来源只有这一份真源：组件经 `setPaneFocused` / `setGlobalKernel` 写，
 *   provider 经 `focusedCtx` / `requireKernel` 读。
 */
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type { EditorCodeAction, EditorDocumentSymbol } from '@kojo/plugin-api';
import { matchOpenedPath } from './external-change';

/** 单个打开文件的 model 记录（多标签：model 随标签存续，切换不销毁） */
export interface ModelEntry {
  model: Monaco.editor.ITextModel;
  listener: Monaco.IDisposable;
  /** 打开时的编码/EOL（状态栏展示用；保存由内核 io 保编码） */
  encoding: string;
  eol: string;
}

/**
 * 每个活着的 EditorPane 实例在模块注册表里的一条档案。全局（`monaco.languages.*` /
 * `registerCommand` / 跳转探针）provider **只注册一份**（standalone Monaco 的 language
 * provider 是全局单表，双实例注册 = 补全候选成对重复），resolve 回调收到 `model` 后经
 * `owningPaneOf` 反查归属实例，再读该实例的 ref——单实例时行为与旧版（闭包直读自身
 * ref）逐字等价。
 */
export interface PaneCtx {
  paneId: string;
  editorRef: { current: Monaco.editor.IStandaloneCodeEditor | null };
  entriesRef: { current: Map<string, ModelEntry> };
  filePathRef: { current: string };
  sugarModelRef: { current: Monaco.editor.ITextModel | null };
  pendingActionsRef: { current: Map<string, EditorCodeAction> };
  actionSeqRef: { current: number };
  crumbTreeCacheRef: { current: { path: string; versionId: number; symbols: EditorDocumentSymbol[] } | null };
}

/** 活实例登记簿（导出的是**同一个 Map**，不是快照）：接线层按 id 反查 / 全表扫描都读它。 */
export const livePanes = new Map<string, PaneCtx>();
let paneSeq = 0;
/** 最后一次获得焦点的实例（跳转探针读它；编辑器 focus 与实例首挂时刷新） */
let focusedPaneId: string | null = null;
/** 全局 provider 的 kernel 来源（单 kernel 应用；随最新实例刷新，等价旧版闭包捕获） */
let globalKernel: Kernel | null = null;

/** 登记时由调用方提供的档案字段（`paneId` 由本模块分配，不接受外部编号） */
export type PaneRefs = Omit<PaneCtx, 'paneId'>;

/**
 * 实例挂载登记：分配 `pane-N` 并把它放进注册表，返回那条档案的 id。
 * **首个实例即焦点**（与宿主初始焦点组同源）——焦点位在这里初始化，正因为它是模块私有的。
 */
export function registerPane(refs: PaneRefs): string {
  const paneId = `pane-${++paneSeq}`;
  livePanes.set(paneId, { paneId, ...refs });
  if (focusedPaneId === null) focusedPaneId = paneId;
  return paneId;
}

/**
 * 实例退册，并把焦点位让给还活着的实例。返回「本实例是不是最后一个」——全局 provider 属于
 * "活实例集合"，最后一个实例退场才拆；**拆的动作留在卸载路径**（`disposeGlobalProviders()`
 * 与跳转探针 / 问题清理的先后顺序由 EditorPane 钉死，本模块不越界去调它）。
 */
export function unregisterPane(paneId: string): boolean {
  livePanes.delete(paneId);
  if (focusedPaneId === paneId) focusedPaneId = livePanes.keys().next().value ?? null;
  return livePanes.size === 0;
}

/** 编辑器聚焦 ⇒ 焦点位随编辑器焦点走（跳转探针读"最后聚焦的实例"） */
export function setPaneFocused(paneId: string): void {
  focusedPaneId = paneId;
}

/** 单 kernel 应用：全局 provider 的 kernel 来源随最新实例刷新（等价旧版闭包捕获） */
export function setGlobalKernel(kernel: Kernel): void {
  globalKernel = kernel;
}

export function requireKernel(): Kernel {
  if (!globalKernel) throw new Error('[EditorPane] 全局 provider 在无实例时被调用（不应发生）');
  return globalKernel;
}

/** 跨组反查：哪组的活动编辑器正显示这份 model（糖 model 是派生物，无主 → null） */
export function owningPaneOf(model: Monaco.editor.ITextModel): PaneCtx | null {
  for (const ctx of livePanes.values()) {
    const ed = ctx.editorRef.current;
    if (!ed || ed.getModel() !== model) continue;
    return ctx.sugarModelRef.current === model ? null : ctx;
  }
  return null;
}

export function focusedCtx(): PaneCtx | null {
  const focused = focusedPaneId ? livePanes.get(focusedPaneId) : undefined;
  return focused ?? livePanes.values().next().value ?? null;
}

/**
 * 跨组版「目标文件是否已开着」（原单实例版经 `matchOpenedPath` 找回宿主键，HK-7）：
 * 任一组的打开表命中即返回那份共享 model——Peek / 重命名 / 引用的跨文件腿由此看见
 * 另一组开着的文件。
 */
export function openModelAcrossGroups(filePath: string): Monaco.editor.ITextModel | undefined {
  for (const ctx of livePanes.values()) {
    const key = matchOpenedPath(ctx.entriesRef.current.keys(), filePath);
    if (key) return ctx.entriesRef.current.get(key)?.model;
  }
  return undefined;
}

/** 跨组版 URI → 宿主路径（Monaco opener 反查）：遍历全部组的打开表 */
export function pathForUriAcrossGroups(uri: string): string | undefined {
  for (const ctx of livePanes.values()) {
    for (const [path, entry] of ctx.entriesRef.current) {
      if (entry.model.uri.toString() === uri) return path;
    }
  }
  return undefined;
}
