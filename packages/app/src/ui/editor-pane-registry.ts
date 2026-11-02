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
import type { EditorCodeAction, EditorDocumentSymbol, EditorSymbolLocation } from '@kojo/plugin-api';
import { matchOpenedPath } from './external-change';
import { sourceLineToSugar } from './sugar-view';

/** 单个打开文件的 model 记录（多标签：model 随标签存续，切换不销毁） */
export interface ModelEntry {
  model: Monaco.editor.ITextModel;
  listener: Monaco.IDisposable;
  /** 打开时的编码/EOL（状态栏展示用；保存由内核 io 保编码） */
  encoding: string;
  eol: string;
  /**
   * **EOL 保存覆盖位**（EOL-OVERRIDE-SAVE 批）：作者经状态栏菜单**显式切换**过
   * 换行档才置位（打开读盘 / 重载不置位）；保存仅当此位在场时给 `writeText`
   * 显式 `{ eol }`（内核语义 = 整段统一），落盘成功即清位；重载 / 外部冲突
   * （含合并）/ 放弃修改（强制重载 / 关标签随条目销毁）时复位。
   * 缺席（undefined）= 保存走缺省"保编码保换行"。
   */
  eolOverride?: 'LF' | 'CRLF';
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
  /**
   * 屏幕上这份糖投影的「预览行 → 源行」表（`[i]` = 预览第 i+1 行的源行号，1 基；0 = 无源行）。
   * 与 `sugarModelRef` 同批换上 / 同批清空；空数组 = 还没装配出来，只读动作据此退化而不是猜。
   */
  sugarLineMapRef: { current: readonly number[] };
  pendingActionsRef: { current: Map<string, EditorCodeAction> };
  actionSeqRef: { current: number };
  crumbTreeCacheRef: { current: { path: string; versionId: number; symbols: EditorDocumentSymbol[] } | null };
  /**
   * 本实例**本会话已解锁编辑**的路径集合（KW16 标签色轨批，2026-11-02）。
   *
   * 交出去的是组件持有的同一只 ref 壳（与上面每一位同一条纪律：复制 ref＝让读方拿到影子）。
   * 登记簿外**没有第二份**解锁账——标签侧经 `ui/editor-editability.ts` 现扫这一位给警示色，
   * 从而不必在组件里再抄一遍 `canEdit` 表达式。生命周期仍随实例（退册即随 ref 消失）。
   */
  unlockedPathsRef: { current: Set<string> };
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

/* --------------------------- 判据腿的只读登记簿（DEBUG-SEMANTIC-PROBE 批） --------------------------- */

/**
 * 一条"位置 → 目标"的**判据腿**：纯读、不导航、不改光标、不发事件。
 *
 * 为什么需要这一格（PITFALLS 305 的根因）：Monaco 的 definition / references provider 在本仓
 * **不是纯读数**——`provideLocations`（`monaco/kojo-definition.ts`）拿到目标后走三条腿：
 * 目标全都已开着 ⇒ 返回 `LocationLink[]`；否则**发 `editor.revealLocation` 把文件打开、
 * 然后返回 `undefined`**。也就是说"跨文件目标"与"这里真没有定义"在 provider 的返回值上
 * **长得一模一样**。调试面 `definitionAt` / `referencesAt` 原先量的正是 provider，于是真机
 * 恒回空（`selfCheck().semantic.providers` 却报 `true`，因为它问的是注册表而不是这一次请求）。
 *
 * 这里登记的是判据腿**本体**（`readDefinitionTargets` / `readReferences`）：位置进、目标数组出。
 * 调试面优先读它，登记簿缺席才退回 provider 那条旧路（旧行为一个字节都不动）。这与
 * references 让位车立的"判据与通道分家"是同一条纪律——量"有没有答案"要问判据，不能问通道。
 *
 * 只由装配点（`editor-global-providers.ts` 的 `ensureGlobalProviders`）写一次；单测 / 欢迎页
 * 早注册时是 `null` ⇒ 调试面走旧路。
 */
export interface SemanticLegs {
  /** `definition` 判据腿（糖面已折回预览行；纯读） */
  readonly definition: (
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ) => readonly EditorSymbolLocation[];
  /** `references` 判据腿（交回源坐标 + 归属路径；纯读） */
  readonly references: (
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ) => { readonly path: string; readonly locations: readonly EditorSymbolLocation[] } | null;
}

let semanticLegs: SemanticLegs | null = null;

/** 装配点登记判据腿（幂等：重挂 / 回滚重试后覆盖成最新那一份） */
export function registerSemanticLegs(legs: SemanticLegs): void {
  semanticLegs = legs;
}

/** 读登记簿；没装配 ⇒ `null`（调试面据此退回 provider 旧路） */
export function semanticLegsNow(): SemanticLegs | null {
  return semanticLegs;
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

/**
 * 这份 model 是不是某实例**正在显示**的糖投影。
 *
 * 与 `owningPaneOf` 是两条相反的判据，别合一条：那条问"这 model 有没有可写的原文主人"
 * （派生物答无），这条问"它是不是投影面"（派生物答有）。**写**类动作只认前者（糖上改一个
 * 字节都是事故）；**读**类动作（跳转、符号、折叠、诊断落点）该认这条——拿着 `sugarLineMapRef`
 * 换算回源就有意义，整条早退才是缺陷。
 */
export function sugarOwningPaneOf(model: Monaco.editor.ITextModel): PaneCtx | null {
  for (const ctx of livePanes.values()) {
    const ed = ctx.editorRef.current;
    if (!ed || ed.getModel() !== model) continue;
    return ctx.sugarModelRef.current === model ? ctx : null;
  }
  return null;
}

/** 预览行（1 基）→ 源侧路径 + 行号；映射缺席 = `null`（宁可不出结果，不给一个猜的行号） */
export function sugarSourceOf(ctx: PaneCtx, previewLine: number): { path: string; line: number } | null {
  const line = ctx.sugarLineMapRef.current[previewLine - 1];
  return line === undefined || line <= 0 ? null : { path: ctx.filePathRef.current, line };
}

/**
 * 源行（1 基）→ 屏幕上这份投影的预览行（1 基）；映射缺席 / 折不回 = `null`。
 *
 * 与 `sugarSourceOf` 是**同一张表**的两个方向（换算判据单源在 `sourceLineToSugar`：精确命中取
 * 第一次出现，源行被折进糖段、没有独立成行时停在"包住它的那段糖"）。
 * 存在的理由：落点类腿在**事件通道**上（`editor.revealLocation` → `EditorPane.applyReveal`）
 * 由那一跳折回，所以取数腿刻意留源坐标；而 Peek 树里点同一枚走的是 Monaco 的**同 model 就地跳**，
 * 一条事件都不发 ⇒ 不在这里折就没有任何人折（见 `monaco/find-references.ts` 的投影面段）。
 */
export function sugarPreviewLineOf(ctx: PaneCtx, sourceLine: number): number | null {
  return sourceLineToSugar(ctx.sugarLineMapRef.current, sourceLine);
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

/**
 * 归属实例那份**原文** model（`entriesRef` 的键就是 `filePathRef`，HK-7 同款 `pathKey` 兜底，
 * 最后退一步跨组找）。
 *
 * 住登记簿而不是住某条腿的理由：**"哪一份 model 是这份投影的原文"这条反查只许有一份**。
 * 读类腿（`ui/editor-global-providers.ts`）与三条缓冲区本地腿（`monaco/erb-dim-navigation.ts`）
 * 都要问它；本地腿那一侧的套件跑在 node 池里，而 `editor-global-providers.ts` 顶层带 Monaco
 * 运行时——静态引它 = 把整棵 Monaco 拖进每条本地腿的测试图（`window is not defined`）。
 * 本模块只 `import type` monaco，所以两侧都能干净地引到这里。
 */
export function sourceModelOf(ctx: PaneCtx): Monaco.editor.ITextModel | null {
  const want = ctx.filePathRef.current;
  if (!want) return null;
  const direct = ctx.entriesRef.current.get(want)?.model;
  if (direct) return direct;
  const key = matchOpenedPath(ctx.entriesRef.current.keys(), want);
  if (key) return ctx.entriesRef.current.get(key)?.model ?? null;
  return openModelAcrossGroups(want) ?? null;
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
