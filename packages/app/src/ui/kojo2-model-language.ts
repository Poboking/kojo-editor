/**
 * Kojo 2.0 · **model 语言重挂**（K2-CUTOVER-THEME）。
 *
 * ## 为什么需要"重挂"，而不是只在建 model 时判一次
 *
 * `monaco/languages.ts` 的 descriptor 是**按扩展名**选语言的；2.0 切流还多了一条
 * **内容指纹**判据（`ui/kojo2-cutover.ts` 的 `2.0-default` 阶段：`.kojo` 由正文决定
 * 走 v1 还是 2.0）。建 model 只发生一次，而正文会变——作者把一份老文件改成 2.0 写法
 * 存盘之后，model 仍挂在 `kojo`（v1）语言面上：词法错、着色错、诊断全落在错的那条链上。
 * 扩展名也可能变（另存为 `.kojo2` / 树里改名）。所以需要一条**重判 → `setModelLanguage`**
 * 的通道。
 *
 * ## 设计约束（每条都有对应的测试）
 *
 * 1. **只在 flag 开时动作**：`isEnabled()` 为 false ⇒ `attach` 连监听都不挂、内容变化
 *    连定时器都不排（v1 行为逐字不变，零副作用）；运行中 flag 被关掉，已排队的回调也
 *    只做一次 no-op 判定，不碰 model。
 * 2. **防抖**：击键触发的 `onDidChangeContent` 只排一个尾沿定时器（窗口内多次变化合并成
 *    一次重判）。`.kojo` 的指纹要扫全文，逐键重判是拿主线程换延迟。
 * 3. **幂等**：目标语言与 `model.getLanguageId()` 相同 ⇒ 不调 `setModelLanguage`
 *    （重挂会重置 tokenization / 装饰 / 折叠状态，白挂一次就是可见的闪动）。
 * 4. **不与 model 池的引用计数打架**：本模块只读 model（`getValue` / `getLanguageId`）
 *    与调 `setModelLanguage`——从不建 / 不 dispose / 不 acquire / 不 release。model 被
 *    池回收时（`onWillDispose`）自动解绑，不留悬空监听。
 * 5. **纯逻辑可单测**：路由函数、调度器、`setModelLanguage` 全部注入；本模块不 import
 *    `monaco/entry`（node 环境可直接跑）。
 *
 * ## 调用面
 *
 * 真身装配在 `ui/editor-model-pool-instance.ts`：`createModel` 建完 model 立刻 `attach`，
 * 语言判据与建 model 时用的是**同一个** {@link languageIdForKojo2Model}（两处各写一套是
 * 漂移的源头）。宿主将来接"另存为 / 改名"时调 `controller.retarget(model, newPath)`（或
 * 手里的 `handle.retarget`）即可立即重判；切流阶段变化时 `refreshAll()` 让所有挂着的
 * model 重新路由（真身已订 `getKojo2CutoverController().subscribe`）。
 */

import { KOJO2_LANGUAGE_ID } from '../monaco/kojo2-constants';
import { languageFor } from './editor-model-pool';
import { getKojo2CutoverController } from './kojo2-cutover';
import { isKojo2CutoverEnabled } from './kojo2-flag';

/* ============================== 判据 ============================== */

/**
 * 一份文件该挂哪个 Monaco 语言 id（建 model 与重挂**共用****这一枚**）。
 *
 * 判据顺序与 `editor-model-pool-instance` 收口前逐字一致：
 * 1. flag 关 ⇒ 恒等于 `languageFor(path)`（与没有任何 2.0 面时逐字等价）；
 * 2. flag 开 ⇒ 交给切换控制器路由：
 *    - `resolved` 且 parser 是 `kojo2` ⇒ `kojo2`；
 *    - `resolved` 且 parser 是 v1 / `ambiguous` / `needs-content` / `not-kojo` ⇒ `languageFor(path)`；
 *    - `blocked`（`v1-only` 阶段的 `.kojo2`）⇒ `plaintext`：不把 2.0 文件塞给 v1 词法
 *      （那会把整篇标成错误），也不假装 2.0 面存在。
 */
export function languageIdForKojo2Model(filePath: string, text: string): string {
  if (!isKojo2CutoverEnabled()) return languageFor(filePath);
  const route = getKojo2CutoverController().route({ filePath, source: text });
  switch (route.kind) {
    case 'resolved':
      return route.parser === 'kojo2' ? KOJO2_LANGUAGE_ID : languageFor(filePath);
    case 'ambiguous':
      // 唯一兜底是 v1（`route.fallback`）；提示由打开链路露给作者，这里不另造文案。
      return languageFor(filePath);
    case 'blocked':
      return 'plaintext';
    case 'needs-content':
    case 'not-kojo':
      return languageFor(filePath);
  }
}

/* ============================== 端口类型 ============================== */

/**
 * 本模块眼里的一份 Monaco model——**结构最小面**，故意不引 `Monaco.editor.ITextModel`：
 * 真身类型天然满足它，node 测试给个假体即可。
 */
export interface Kojo2LanguageModelLike {
  /** 正文（指纹路由要读；只在防抖到点后读一次） */
  getValue(): string;
  /** 当前语言 id（幂等判据） */
  getLanguageId(): string;
  /** 正文变化（击键 / 程序性改写都会触发；本模块只在防抖后重判） */
  onDidChangeContent(listener: () => void): { dispose(): void };
  /**
   * model 即将销毁（可选；真身 `ITextModel` 有）。挂上 ⇒ 池回收 model 时自动解绑，
   * 不依赖调用方记得 `detach`。
   */
  onWillDispose?(listener: () => void): { dispose(): void };
}

/** 可 dispose 的最小面（Monaco 的 `IDisposable` 结构上满足它） */
export interface Kojo2Disposable {
  dispose(): void;
}

/** 控制器注入面（真身见 `ui/editor-model-pool-instance.ts`；测试逐格替换） */
export interface Kojo2ModelLanguageDeps {
  /** 2.0 预演开关（读 localStorage；**每次动作现判**，运行中关掉立即失效） */
  readonly isEnabled: () => boolean;
  /** 目标语言判据（真身 = {@link languageIdForKojo2Model}） */
  readonly resolveLanguage: (filePath: string, text: string) => string;
  /** 真身 = `monaco.editor.setModelLanguage`；本模块只经这个出口碰 Monaco */
  readonly setModelLanguage: (model: Kojo2LanguageModelLike, languageId: string) => void;
  /** 防抖窗口（毫秒）；缺省 {@link KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS} */
  readonly debounceMs?: number;
  /**
   * 定时器端口（返回取消函数）。缺省 = `setTimeout`；测试注入假队列，
   * 不碰真时钟（避免 flaky）也不必 `vi.useFakeTimers`。
   */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  /** 可见性出口；缺省 `console.warn`（铁律 4：失败不静默） */
  readonly warn?: (message: string) => void;
}

/** 一份挂载的对外手柄 */
export interface Kojo2ModelLanguageHandle {
  /** 当前路径（`retarget` 后跟着变） */
  readonly path: string;
  /**
   * 改路径后**立即**重判（另存为 / 改名改了扩展名时调；不等防抖——那一刻作者是停手的）。
   * 目标语言没变 ⇒ 只更新路径，不重挂（幂等）。
   */
  retarget(nextPath: string): void;
  /** 立即按当前路径 + 正文重判（阶段/override 变化后调；同样幂等） */
  refresh(): void;
  /** 解绑：取消排队中的回调、摘掉监听；之后内容再变也零动作。可重复调用。 */
  detach(): void;
}

/** `attach` 的可选项 */
export interface Kojo2ModelLanguageAttachOptions {
  /**
   * 建 model 时**已经用同一枚判据**选定的语言 id。与 `model.getLanguageId()` 一致时，
   * `attach` 不再重扫一次正文（`.kojo` 在 `2.0-default` 阶段的指纹要扫全文，开一份
   * 大文件不该扫两遍）；不一致或没给 ⇒ 立刻对齐一次（兜住别的调用方建错的 model）。
   */
  readonly languageId?: string;
}

/** 观测面（调试面板 / 测试读数；`remounts` 只数真的调了 `setModelLanguage` 的次数） */
export interface Kojo2ModelLanguageStats {
  /** 当前挂着的 model 数 */
  readonly attached: number;
  /** 累计真正重挂次数 */
  readonly remounts: number;
  /** 累计"判完不需要挂"的次数（同语言 / flag 关）——幂等性的读数面 */
  readonly skipped: number;
  /** 排队中的防抖回调数（0 或 1 × 挂载数） */
  readonly pending: number;
}

/** 模型语言重挂控制器 */
export interface Kojo2ModelLanguageController {
  /**
   * 挂上一份 model。flag 关 ⇒ 返回一个 no-op 手柄（不订阅、不重判、零副作用）。
   * 同一 model 重复 attach ⇒ 返回同一个手柄（不重复订阅）。
   */
  attach(
    model: Kojo2LanguageModelLike,
    filePath: string,
    options?: Kojo2ModelLanguageAttachOptions,
  ): Kojo2ModelLanguageHandle;
  /**
   * 全部挂载立即重判一次（切流阶段 / per-file override / flag 变化后调）。
   * 与 `refresh()` 同一条幂等路径；flag 关时逐份 no-op 并计入 `skipped`。
   */
  refreshAll(): void;
  /**
   * 按 model 改路径（"另存为 / 改名改了扩展名"的**接线口**，调用方不必持手柄）。
   * 命中一份挂载 ⇒ 立即按新路径重判并返回 `true`；未挂 / flag 关 / 已解绑 ⇒ `false`。
   */
  retarget(model: Kojo2LanguageModelLike, nextPath: string): boolean;
  /** 当前读数（每次现算） */
  stats(): Kojo2ModelLanguageStats;
  /** 全部解绑（宿主重启 / 测试收尾）；之后 `attach` 返回 no-op 手柄 */
  dispose(): void;
}

/** 防抖窗口：一次停手（~300ms）之后就重判，人眼几乎察觉不到，又不会逐键扫全文 */
export const KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS = 300;

/* ============================== 控制器 ============================== */

interface Attachment {
  readonly model: Kojo2LanguageModelLike;
  path: string;
  /** 排队中的防抖回调（0 或 1 个） */
  cancelPending: (() => void) | null;
  /** 内容变化 / 销毁 两条订阅（解绑时一起摘） */
  readonly subscriptions: Kojo2Disposable[];
  detached: boolean;
  /** 失败告警去抖（同一份挂载只吵一次，别在击键路径刷屏） */
  warned: boolean;
  readonly handle: Kojo2ModelLanguageHandle;
}

/** 错误里取一句话（`unknown` 收窄，别把 `[object Object]` 上屏） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noopHandle(filePath: string): Kojo2ModelLanguageHandle {
  return {
    path: filePath,
    retarget(): void {
      /* flag 关：v1 判据不依赖路径变化，零动作 */
    },
    refresh(): void {
      /* 同上 */
    },
    detach(): void {
      /* 从未挂上，无需解绑 */
    },
  };
}

export function createKojo2ModelLanguageController(
  deps: Kojo2ModelLanguageDeps,
): Kojo2ModelLanguageController {
  const debounceMs = Math.max(
    0,
    deps.debounceMs ?? KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS,
  );
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
  const warn = deps.warn ?? ((message: string) => console.warn(`[kojo2-model-language] ${message}`));

  const attachments = new Map<Kojo2LanguageModelLike, Attachment>();
  let remounts = 0;
  let skipped = 0;
  let pending = 0;
  let disposed = false;

  function warnOnce(attachment: Attachment, message: string): void {
    if (attachment.warned) return;
    attachment.warned = true;
    warn(`${message}（后续同类失败不再重复上报）`);
  }

  /** 重判 + 幂等重挂：唯一真正碰 model 的地方 */
  function reconcile(attachment: Attachment): void {
    if (attachment.detached) return;
    if (!deps.isEnabled()) {
      skipped += 1;
      return;
    }
    let desired: string;
    try {
      desired = deps.resolveLanguage(attachment.path, attachment.model.getValue());
    } catch (error: unknown) {
      warnOnce(attachment, `重判语言失败（${attachment.path}）：${messageOf(error)}`);
      return;
    }
    if (desired === attachment.model.getLanguageId()) {
      skipped += 1; // 同语言不重挂（幂等判据）
      return;
    }
    try {
      deps.setModelLanguage(attachment.model, desired);
      remounts += 1;
    } catch (error: unknown) {
      warnOnce(
        attachment,
        `setModelLanguage 失败（${attachment.path} → ${desired}）：${messageOf(error)}`,
      );
    }
  }

  /** 取消排队中的防抖回调（如果有） */
  function cancelPendingOf(attachment: Attachment): void {
    attachment.cancelPending?.();
  }

  /** 内容变化 ⇒ 尾沿防抖排一次重判；窗口内多次变化合并成一次 */
  function scheduleReconcile(attachment: Attachment): void {
    if (attachment.detached) return;
    if (!deps.isEnabled()) {
      skipped += 1; // flag 关：连定时器都不排（零动作）
      return;
    }
    if (attachment.cancelPending !== null) return;

    pending += 1;
    let live = true;
    const cancel = schedule(() => {
      if (!live) return;
      live = false;
      attachment.cancelPending = null;
      pending -= 1;
      reconcile(attachment);
    }, debounceMs);
    const cancelPending = (): void => {
      if (!live) return;
      live = false;
      cancel();
      attachment.cancelPending = null;
      pending -= 1;
    };
    attachment.cancelPending = cancelPending;
    // 调度器若同步触发（注入端口不该这样，但别让它成为一条暗坑）：回调已清过这一格
    if (!live) attachment.cancelPending = null;
  }

  function detachAttachment(attachment: Attachment): void {
    if (attachment.detached) return;
    attachment.detached = true;
    cancelPendingOf(attachment);
    for (const subscription of attachment.subscriptions.splice(0)) subscription.dispose();
    if (attachments.get(attachment.model) === attachment) attachments.delete(attachment.model);
  }

  function attach(
    model: Kojo2LanguageModelLike,
    filePath: string,
    options?: Kojo2ModelLanguageAttachOptions,
  ): Kojo2ModelLanguageHandle {
    if (disposed) return noopHandle(filePath);
    const existing = attachments.get(model);
    if (existing !== undefined) return existing.handle;
    // flag 关 ⇒ 不订阅、不重判：与没有任何 2.0 面时逐字等价
    if (!deps.isEnabled()) return noopHandle(filePath);

    // handle 与 attachment 互相引用：先建 handle（闭包延迟读 attachment），再补骨架
    let attachment: Attachment;
    const handle: Kojo2ModelLanguageHandle = {
      get path(): string {
        return attachment.path;
      },
      retarget(nextPath: string): void {
        if (attachment.detached) return;
        attachment.path = nextPath;
        cancelPendingOf(attachment); // 显式改路径：以这一刻的正文为准，不等旧窗口
        reconcile(attachment);
      },
      refresh(): void {
        if (attachment.detached) return;
        cancelPendingOf(attachment);
        reconcile(attachment);
      },
      detach(): void {
        detachAttachment(attachment);
      },
    };
    attachment = {
      model,
      path: filePath,
      cancelPending: null,
      subscriptions: [],
      detached: false,
      warned: false,
      handle,
    };

    attachment.subscriptions.push(
      model.onDidChangeContent(() => scheduleReconcile(attachment)),
    );
    const onWillDispose = model.onWillDispose;
    if (onWillDispose !== undefined) {
      // 池回收 model（refs 归零 / 弃档）时自动解绑，不让本表拖住已销毁的 model
      attachment.subscriptions.push(
        onWillDispose.call(model, () => detachAttachment(attachment)),
      );
    }
    attachments.set(model, attachment);
    // 建 model 时若已用同一枚判据选定语言（`options.languageId` 且与当前一致），就不再
    // 重扫正文——`.kojo` 在 2.0-default 阶段的指纹要扫全文，开一份大文件不该扫两遍；
    // 否则立刻对齐一次，兜住"别的调用方建 model 时判错 / 没判"。
    if (options?.languageId !== undefined && options.languageId === model.getLanguageId()) {
      skipped += 1;
    } else {
      reconcile(attachment);
    }
    return handle;
  }

  return {
    attach,
    refreshAll(): void {
      for (const attachment of [...attachments.values()]) {
        if (attachment.detached) continue;
        cancelPendingOf(attachment);
        reconcile(attachment);
      }
    },
    retarget(model, nextPath): boolean {
      const attachment = attachments.get(model);
      if (attachment === undefined || attachment.detached) return false;
      attachment.handle.retarget(nextPath);
      return true;
    },
    stats(): Kojo2ModelLanguageStats {
      return { attached: attachments.size, remounts, skipped, pending };
    },
    dispose(): void {
      disposed = true;
      for (const attachment of [...attachments.values()]) detachAttachment(attachment);
      attachments.clear();
    },
  };
}

/* ============================== 另存为 / 改名的接线口（K2-EDITOR-MOUNT ③） ============================== */

/** 路径改写接线的注入面（真身绑 `editor-model-pool-instance`，测试逐格替换） */
export interface Kojo2ModelPathRetargetDeps {
  /** 按路径取**活着的** model（真身 = `editorModelPool.liveModel`，判等走 `pathKey`） */
  readonly liveModel: (filePath: string) => Kojo2LanguageModelLike | undefined;
  /** 真身 = `kojo2ModelLanguage.retarget`（未挂 / flag 关 ⇒ `false`） */
  readonly retarget: (model: Kojo2LanguageModelLike, nextPath: string) => boolean;
}

/**
 * 改名 / 另存为之后：把逗留着的 model 按**新路径**立即重判语言面。
 *
 * ## 为什么要有这一格（而不是让调用方自己拼两句）
 *
 * 路径改写发生在壳层（`App` 的盘上事实收尾：`{ from, to }` 一对），而 model 住在池里；
 * 判据（路径相等 / 空路径 / 池里没有 / flag 关）与失败方向必须只有一份。改名把
 * `.kojo` 变成 `.kojo2` 时，`languageIdForKojo2Model` 的答案会跟着变——不重判就是
 * "文件已经叫 2.0 了，词法还挂在 v1 上"（整篇假错误）。
 *
 * ## 口径
 *
 * - `from === to` / `nextPath` 为空 ⇒ `false`（没有可改的事实，零动作）；
 * - 池里没有这份（改名链路重建了 model 的常见情形）⇒ `false`：新 model 建的时候
 *   `attach` 已经按新路径判过，这里再猜一次只会瞎改；
 * - 任何一格抛错 ⇒ `false`（`false` 只是"没改"，不是失败；绝不抛进壳层的事件链）；
 * - flag 关 ⇒ 控制器那一格自己就是 `false`（没有挂载，零监听），本函数不做第二判定。
 */
export function retargetKojo2ModelPath(
  input: { readonly fromPath: string; readonly nextPath: string },
  deps: Kojo2ModelPathRetargetDeps,
): boolean {
  if (input.fromPath === input.nextPath) return false;
  if (input.nextPath.length === 0) return false;
  let model: Kojo2LanguageModelLike | undefined;
  try {
    model = deps.liveModel(input.fromPath);
  } catch {
    return false;
  }
  if (model === undefined) return false;
  try {
    return deps.retarget(model, input.nextPath);
  } catch {
    return false;
  }
}
