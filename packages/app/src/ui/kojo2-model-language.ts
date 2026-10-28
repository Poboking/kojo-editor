/**
 * Kojo 2.0 · **model 语言重挂**（K2-CUTOVER-THEME）。
 *
 * ## 为什么需要"重挂"
 *
 * 认路判据只在**建 model 那一刻**答一次，而下面两件事会迟到：
 *
 * 1. **路径变了**（另存为 / 树里改名）：`.kojo1` ↔ `.kojo` 换了扩展名，语言就该跟着换；
 * 2. **阶段 / per-file override 变了**：封存层开合、override 把某份文件钉到另一侧——
 *    已打开的 model 要重判；`2.0-default → dual` 时纯文本的 `.kojo1` 也在这里被重新认领。
 *
 * 正文**不参与**认路（LAU-3b-FLIP：只看扩展名）；内容变化只触发一次防抖重判，结论仍是
 * 同一枚扩展名判据——重判幂等，通常直接 skip。
 *
 * ## 约束（每条都有测试）
 *
 * 1. **只在开关开时动作**：`isEnabled()` 为 false ⇒ 不订阅、不排定时器（v1 行为逐字不变）；
 * 2. **防抖**：击键只排一个尾沿定时器，窗口内多次变化合并成一次；
 * 3. **幂等**：目标语言与 `model.getLanguageId()` 相同 ⇒ 不调 `setModelLanguage`；
 * 4. **不碰 model 池**：只读 / 只 `setModelLanguage`，从不建 / dispose / acquire / release；
 * 5. **纯逻辑可单测**：路由、调度、`setModelLanguage` 全部注入，不 import `monaco/entry`；
 * 6. **门不回头改语言**（LAU-3 / §4.4）：重挂时把当前语言交给
 *    {@link languageIdForKojo2Model} 的第三格；门封掉一门语言后**已认领**的 model 保持原语言，
 *    只有新开的落 `plaintext`。判据住在 `monaco/language-registry.ts::keepClaimedLanguageWhenGated`。
 *
 * 真身装配在 `ui/editor-model-pool-instance.ts`：建完 model 立刻 `attach`，与建 model 用
 * 同一枚 {@link languageIdForKojo2Model}。阶段变化时 `refreshAll()` 重判所有挂着的 model。
 */

import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { keepClaimedLanguageWhenGated } from '../monaco/language-registry';
import { languageFor } from './editor-model-pool';
import { getKojo2CutoverController } from './kojo2-cutover';
import { isKojo2CutoverEnabled } from './kojo2-flag';

/* ============================== 判据 ============================== */

/**
 * 一份文件该挂哪个 Monaco 语言 id（建 model 与重挂**共用****这一枚**）。
 *
 * 判据顺序：
 * 1. 切流阶段停在 `v1-only`（开关关）⇒ 恒等于 `languageFor(path)`；语言面与工具链无关；
 * 2. 开关开 ⇒ 交给切换控制器路由：
 *    - `resolved` 且 parser 是 `kojo2` ⇒ `kojo2`（`.kojo` / `.kojo2` 恒走这一条）；
 *    - `resolved` 且 parser 是 v1 ⇒ `languageFor(path)`（`.kojo1`）；
 *    - `blocked`（`v1-only` 下把非 kojo 文件显式钉成 2.0）⇒ `plaintext`：不拿 v1 词法
 *      去啃 2.0 文本，也不假装那条 override 已经可用；
 *    - `not-kojo`（以及历史成员 `ambiguous` / `needs-content`）⇒ `languageFor(path)`。
 *
 * ## 第三格 `currentLanguageId`（LAU-3 / §4.4：门不回头改语言）
 *
 * **只有重挂路径传它**（建 model 那一刻没有"当前语言"）。传了 ⇒ 结论再过一道
 * {@link keepClaimedLanguageWhenGated}：语言可用性门把 kojo1（封存层）关掉之后，
 * 一份封存的 `.kojo1` 会答 `plaintext`；若照单重挂，作者眼前这份在编文件当场丢高亮与
 * 四面——比"这一层暂时不可用"严重得多。守门后的口径：**已认领的保持原语言，新开的落兜底**。
 */
export function languageIdForKojo2Model(
  filePath: string,
  text: string,
  currentLanguageId?: string,
): string {
  const resolved = resolveKojo2ModelLanguage(filePath, text);
  return keepClaimedLanguageWhenGated(currentLanguageId, resolved);
}

/** 不带守门的原始判据（{@link languageIdForKojo2Model} 的内层；单独导出只为可读性） */
function resolveKojo2ModelLanguage(filePath: string, text: string): string {
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
  /** 正文（认路已不读它；重判时只作为路由入参的兼容字段） */
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
  /**
   * 目标语言判据（真身 = {@link languageIdForKojo2Model}）。
   *
   * 第三格 = **这份 model 此刻挂着的语言 id**，重挂路径必传：真身据此走 §4.4 的守门
   * （门把一门语言封掉时，已认领的 model 不被刷成 `plaintext`）。少给一格的注入面
   * （旧测试 / 假体）仍合法——TS 允许形参更少的函数赋进来，只是那道守门不生效。
   */
  readonly resolveLanguage: (filePath: string, text: string, currentLanguageId?: string) => string;
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
   * `attach` 不再多判一次（判据已由调用方按同一枚扩展名判过）；不一致或没给 ⇒
   * 立刻对齐一次（兜住别的调用方建错的 model）。
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

/** 防抖窗口：一次停手（~300ms）之后就重判，人眼几乎察觉不到，又不会逐键重判 */
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
    // 当前语言**先取一次**：既作幂等判据，也交给判据那一格做 §4.4 的守门
    // （门把 kojo1 封掉时，不许把这份在编文件刷成 `plaintext`）。
    const current = attachment.model.getLanguageId();
    let desired: string;
    try {
      desired = deps.resolveLanguage(attachment.path, attachment.model.getValue(), current);
    } catch (error: unknown) {
      warnOnce(attachment, `重判语言失败（${attachment.path}）：${messageOf(error)}`);
      return;
    }
    if (desired === current) {
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
    // 多判一次；否则立刻对齐一次，兜住"别的调用方建 model 时判错 / 没判"。
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
