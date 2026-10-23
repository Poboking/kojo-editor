/**
 * 调用层级 overlay 的宿主状态（2026-10-16 批 E；批次十 2026-10-23 补 kojo2 分派）。
 *
 * 形态照 `diff-view.ts` / `file-history.ts` 同款：模块级单源 + 订阅，零 React、
 * 零 Monaco 运行时，node 可单测。意图经 `editor.command` 进来（命令面板条目，宿主
 * App.tsx 注册）；位点（文件 + 光标行）由命令侧现取 `readJumpProbe()`（G1 既有
 * 探针，EditorPane 挂载时注册）——不新建第二套"光标在哪"的通道。
 *
 * kojo2 的取数（"位点 → 可调用声明 → 出入边"）不在本模块：它随
 * `monaco/kojo2-callhierarchy.ts` 一起**懒装载**——那边的解析器会让开机图多出一大坨
 * （PS-10 ① 的体积闸），面板首次遇到 kojo2 文件时才走 {@link loadKojo2CallHierarchyPanel}
 * 的动态边；本模块保持零值依赖（`import type` 会被擦除，不进开机图）。
 */

/** ui.overlay 贡献 id（`App.tsx` 接线注册；开/关窗走 `ui.overlay.open`/`close`） */
export const CALL_HIERARCHY_OVERLAY_ID = 'kojo.callHierarchy';

/** editor.command 贡献 id（命令面板条目） */
export const CALL_HIERARCHY_COMMAND_ID = 'kojo.showCallHierarchy';

/** 一次查询的位点：文件 + 光标行/列（1 基，模型坐标） */
export interface CallHierarchyRequest {
  readonly filePath: string;
  readonly line: number;
  /** 光标列（additive 可选：kojo2 的 prepare 按格子判定，缺席时按行首问） */
  readonly column?: number;
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

/* ============================== kojo2 分支的懒装载边 ============================== */

/**
 * kojo2 取数模块的形状（`import type` 只活到编译期：本模块不进开机图）。
 *
 * 取数与 provider 都在 `monaco/kojo2-callhierarchy.ts`（纯模型 + 宿主自建面板的取数层），
 * 那里会拉起 `@kojo/kojo-core` 的解析器——所以只能走动态边，见模块头。
 */
export type Kojo2PanelApi = typeof import('../monaco/kojo2-callhierarchy');

let kojo2PanelModule: Promise<Kojo2PanelApi> | null = null;

/**
 * 懒装载 kojo2 取数模块（进程内一次；失败也记住，由面板把错误画成可见态）。
 *
 * 动态 `import()` 是 PS-10 ① 的既有形态：静态图不许有解析器，首次打开 kojo2 文件时才拉。
 */
export function loadKojo2CallHierarchyPanel(): Promise<Kojo2PanelApi> {
  kojo2PanelModule ??= import('../monaco/kojo2-callhierarchy');
  return kojo2PanelModule;
}

