/**
 * Kojo 2.0 问题同步：**debounce + 仅活动 model + 版本过期丢弃 + 显式清理**（K2-EDITOR-DIAGNOSTICS）。
 *
 * ## 为什么单独成文件
 *
 * `EditorPane.tsx` 是热点：它只该问"这份源现在有什么问题"，不该自己管定时器、版本号与
 * marker owner。这里把**时间轴**（debounce、在飞请求、过期判据）与**上屏**（`setModelMarkers`）
 * 收进一个小控制器；判据全是纯状态机，node 池可单测。
 *
 * ## 四条硬口径
 *
 * 1. **只认活动 model**：非活动 model 的 `schedule` 直接拒绝（返回 `false`），不排队——
 *    后台标签的每次敲键都算一遍会把大文件切标签变成 CPU 尖峰；
 * 2. **版本过期丢弃**：每次调度记下 `model.getVersionId()` + 自增 `generation`；异步诊断
 *    回来时任一不匹配就**不写 markers**（旧结果不许覆盖新文本）；
 * 3. **清理不静默**：换标签 / 关文件 / 显式 `clear` / 诊断失败都会真的 `setModelMarkers(..., [])`，
 *    并且经 `onCleared` 告诉面板"这一份已经撤下"。空诊断也会写一次空数组（不是"跳过不发"）；
 * 4. **失败可见**：诊断入口抛错 ⇒ 清旧波浪线 + `onFailure`（message/cause 原样带上），
 *    绝不把旧诊断留在屏上假装没事。
 *
 * ## 接线点（本批不改 EditorPane）
 *
 * 宿主在 `onDidChangeModelContent`（debounce 后来）里调 `schedule`，在 model 切换 /
 * 关文件时调 `setActive` / `clear`；`onDiagnostics` 把结果转给问题面板，`onFailure` 进
 * 可见的提示台账。真实 adapter/backend 由 `kojo2-diagnostics.ts` 注入，本文件不认识游戏事实。
 */

import type * as Monaco from '../monaco/entry';
import type { KojoDiagnostic } from '@kojo/kojo-core';

/* ---------------------- 诊断结果形状（B3 收口最后一格的落点） ---------------------- */

/**
 * 一次文档级诊断的身份输入（源文本 + 文件路径）。
 *
 * 判据搬进 `@kojo/kojo-lang/diagnostics` 之后，这组形状的"家"从
 * 宿主旧 `monaco/kojo2-diagnostics.ts`（B3 收口已删）落到本层：本层是**时间轴 + 结果形状**的消费者与再分发者，
 * 翻译（markers / 问题面板行）在 `kojo2-problem-wiring.ts`。这样同步器不必反向 import 上层。
 */
export interface Kojo2DiagnosticsInput {
  readonly source: string;
  readonly filePath: string;
}

/** 同一次编译的产物 + source map（预览 / 展开视图读的那一份） */
export interface Kojo2DiagnosticsArtifacts {
  /** 产物文本（core 成功口径：`lines.join('\n') + '\n'`；编译失败 = `''`） */
  readonly erb: string;
  /** 与 `erb` 同一次编译的 source map（`lineCount === splitKojo2GeneratedLines(erb).length`） */
  readonly sourceMap: import('@kojo/kojo-core').SourceMap;
}

/** marker 换算只需要 `MarkerSeverity` 这一格（避免把整个 Monaco 运行时拖进纯逻辑） */
export type Kojo2MarkerSeveritySource = Pick<typeof Monaco, 'MarkerSeverity'>;

/** 一次诊断的完整结果：原始诊断 + 已翻译的 markers + 失败读数 */
export interface Kojo2DiagnosticsResult {
  readonly filePath: string;
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly markers: readonly Monaco.editor.IMarkerData[];
  /** 同一次编译的产物 + source map（`null` = 这一轮没有可预览的产物） */
  readonly artifacts?: Kojo2DiagnosticsArtifacts | null;
  /** **方言体检**的结论（LAU-D2；`undefined` = 这一轮没跑体检 / 方言未绑定） */
  readonly lint?: {
    readonly dialect: string;
    readonly diagnostics: readonly KojoDiagnostic[];
  };
  /** 编译入口抛错时的消息（`null` = 正常返回；不是诊断） */
  readonly error: string | null;
  readonly errorCount: number;
  readonly warningCount: number;
  /** 无 error 诊断且编译入口未抛错 */
  readonly ok: boolean;
}

/** 本层独占的 marker owner（与 `kojo-decorators` / `kojo-structure-syntax` 并存不覆盖） */
export const KOJO2_PROBLEM_MARKER_OWNER = 'kojo2-diagnostics';

/** 缺省 debounce（敲键间隔内的连续编辑合并成一次编译） */
export const KOJO2_PROBLEM_DEBOUNCE_MS = 200;

/** marker 上屏端（只依赖 `setModelMarkers`；真实 Monaco 结构上满足） */
export interface Kojo2MarkerHost {
  readonly editor: {
    setModelMarkers(
      model: Monaco.editor.ITextModel,
      owner: string,
      markers: Monaco.editor.IMarkerData[],
    ): void;
  };
}

/** debounce 调度器（测试注入手动时钟；缺省用 `globalThis` 定时器） */
export interface Kojo2DebounceScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 诊断入口（同步或异步；异步时本层负责版本校验） */
export type Kojo2DiagnoseFn = (
  input: Kojo2DiagnosticsInput,
) => Kojo2DiagnosticsResult | Promise<Kojo2DiagnosticsResult>;

export interface Kojo2ProblemSyncOptions {
  readonly markerHost: Kojo2MarkerHost;
  readonly diagnose: Kojo2DiagnoseFn;
  readonly debounceMs?: number;
  readonly markerOwner?: string;
  readonly scheduler?: Kojo2DebounceScheduler;
  /** 一轮诊断已上屏（空诊断也发：面板据此清空） */
  readonly onDiagnostics?: (event: Kojo2ProblemSyncApplied) => void;
  /** 某份源的 markers 被撤下（换标签 / 关文件 / 显式清理 / 诊断失败） */
  readonly onCleared?: (event: Kojo2ProblemSyncCleared) => void;
  /** 诊断链路失败（抛错 / 结果自报 error）；旧 markers 已清 */
  readonly onFailure?: (event: Kojo2ProblemSyncFailure) => void;
}

export type Kojo2ProblemClearReason = 'inactive' | 'explicit' | 'dispose' | 'failure';

export interface Kojo2ProblemSyncApplied {
  readonly model: Monaco.editor.ITextModel;
  readonly filePath: string;
  readonly result: Kojo2DiagnosticsResult;
}

export interface Kojo2ProblemSyncCleared {
  readonly model: Monaco.editor.ITextModel;
  readonly filePath: string;
  readonly reason: Kojo2ProblemClearReason;
  /** 仅 `reason === 'failure'` 时带失败消息 */
  readonly message?: string;
}

export interface Kojo2ProblemSyncFailure {
  readonly model: Monaco.editor.ITextModel;
  readonly filePath: string;
  readonly message: string;
  readonly cause: unknown;
}

export interface Kojo2ProblemSync {
  /** 切到某份源（同 model + 同路径重复调用是幂等的；换目标会清旧 markers） */
  setActive(model: Monaco.editor.ITextModel, filePath: string): void;
  /** 调度一次诊断；非活动 model / 不匹配的路径返回 `false` 且不排队 */
  schedule(model: Monaco.editor.ITextModel, filePath: string, source: string): boolean;
  /** 取消 debounce 并立即跑最后一次调度（测试 / 保存前）；等待所有在飞轮次 */
  flush(): Promise<void>;
  /** 显式清理（给 model = 只清这份；缺省 = 清全部挂过的 model） */
  clear(model?: Monaco.editor.ITextModel): void;
  /** 退场：取消定时器、清所有 markers、之后 schedule 一律拒绝 */
  dispose(): void;
}

interface RunRequest {
  readonly model: Monaco.editor.ITextModel;
  readonly filePath: string;
  readonly source: string;
  readonly generation: number;
  readonly version: number;
}

const GLOBAL_SCHEDULER: Kojo2DebounceScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function assertFilePath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new TypeError('Kojo 2.0 问题同步：filePath 不能为空');
  }
}

interface ActiveTarget {
  readonly model: Monaco.editor.ITextModel;
  readonly filePath: string;
}

/**
 * 创建问题同步控制器（纯状态机；所有 Monaco 交互只走注入的 `markerHost`）。
 *
 * 生命周期：`setActive` →（编辑）`schedule` → `onDiagnostics` → 换标签/关文件
 * `setActive`/`clear` → `dispose`。
 */
export function createKojo2ProblemSync(options: Kojo2ProblemSyncOptions): Kojo2ProblemSync {
  const markerHost = options.markerHost;
  const diagnose = options.diagnose;
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? KOJO2_PROBLEM_DEBOUNCE_MS));
  const markerOwner = options.markerOwner ?? KOJO2_PROBLEM_MARKER_OWNER;
  const scheduler = options.scheduler ?? GLOBAL_SCHEDULER;

  /** 当前活动 model（只有它能收 markers） */
  let active: ActiveTarget | null = null;
  /** 本控制器挂过 markers 的 model → 文件身份（清理时要报得出是哪份） */
  const tracked = new Map<Monaco.editor.ITextModel, string>();
  /** 调度代数：任何"换目标 / 清理 / 新调度"都自增，旧异步结果据此作废 */
  let generation = 0;
  let timer: unknown = null;
  let pendingRequest: RunRequest | null = null;
  const inflight = new Set<Promise<void>>();
  let disposed = false;

  const clearMarkers = (model: Monaco.editor.ITextModel): void => {
    if (model.isDisposed()) return;
    markerHost.editor.setModelMarkers(model, markerOwner, []);
  };

  const notifyCleared = (
    model: Monaco.editor.ITextModel,
    filePath: string,
    reason: Kojo2ProblemClearReason,
    message?: string,
  ): void => {
    options.onCleared?.({ model, filePath, reason, ...(message === undefined ? {} : { message }) });
  };

  const cancelPending = (): void => {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    pendingRequest = null;
  };

  const isCurrent = (request: RunRequest): boolean => {
    return (
      !disposed &&
      active !== null &&
      active.model === request.model &&
      active.filePath === request.filePath &&
      generation === request.generation &&
      !request.model.isDisposed() &&
      request.model.getVersionId() === request.version
    );
  };

  const fail = (request: RunRequest, message: string, cause: unknown): void => {
    clearMarkers(request.model);
    notifyCleared(request.model, request.filePath, 'failure', message);
    options.onFailure?.({ model: request.model, filePath: request.filePath, message, cause });
  };

  const execute = async (request: RunRequest): Promise<void> => {
    try {
      if (!isCurrent(request)) return;
      let result: Kojo2DiagnosticsResult;
      try {
        result = await diagnose({ source: request.source, filePath: request.filePath });
      } catch (thrown) {
        if (isCurrent(request)) fail(request, messageOf(thrown), thrown);
        return;
      }
      if (!isCurrent(request)) return;
      if (result.error !== null) {
        // 诊断入口自报失败：旧波浪线必须撤下，不能假装"这一轮没问题"
        fail(request, result.error, result.error);
        return;
      }
      markerHost.editor.setModelMarkers(request.model, markerOwner, [...result.markers]);
      options.onDiagnostics?.({
        model: request.model,
        filePath: request.filePath,
        result,
      });
    } catch (thrown) {
      // 回调自身抛错不能把编辑器链路带下水；但失败仍要可见
      if (isCurrent(request)) {
        try {
          fail(request, messageOf(thrown), thrown);
        } catch {
          // onFailure 自己抛错时无处再报（避免递归通知）；markers 已在上面的 fail 里清掉
        }
      }
    }
  };

  const startRun = (request: RunRequest): void => {
    const run = execute(request);
    inflight.add(run);
    void run.finally(() => {
      inflight.delete(run);
    });
  };

  return {
    setActive(model, filePath) {
      if (disposed) return;
      assertFilePath(filePath);
      if (active !== null && active.model === model && active.filePath === filePath) return;
      generation += 1;
      cancelPending();
      if (active !== null) {
        const previous = active;
        clearMarkers(previous.model);
        tracked.delete(previous.model);
        notifyCleared(previous.model, previous.filePath, 'inactive');
      }
      if (model.isDisposed()) {
        active = null;
        return;
      }
      active = { model, filePath };
      tracked.set(model, filePath);
    },

    schedule(model, filePath, source) {
      if (disposed || active === null) return false;
      if (active.model !== model || active.filePath !== filePath) return false;
      if (model.isDisposed()) return false;
      assertFilePath(filePath);
      if (typeof source !== 'string') {
        throw new TypeError('Kojo 2.0 问题同步：source 必须是字符串');
      }
      generation += 1;
      cancelPending();
      const request: RunRequest = {
        model,
        filePath,
        source,
        generation,
        version: model.getVersionId(),
      };
      pendingRequest = request;
      timer = scheduler.setTimeout(() => {
        timer = null;
        const pending = pendingRequest;
        pendingRequest = null;
        if (pending !== null) startRun(pending);
      }, debounceMs);
      return true;
    },

    async flush() {
      if (disposed) return;
      if (timer !== null) {
        scheduler.clearTimeout(timer);
        timer = null;
        const pending = pendingRequest;
        pendingRequest = null;
        if (pending !== null) startRun(pending);
      }
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
    },

    clear(model) {
      if (disposed) return;
      generation += 1;
      cancelPending();
      if (model !== undefined) {
        const filePath =
          tracked.get(model) ?? (active !== null && active.model === model ? active.filePath : '');
        tracked.delete(model);
        if (active !== null && active.model === model) active = null;
        clearMarkers(model);
        notifyCleared(model, filePath, 'explicit');
        return;
      }
      // 先快照再通知：回调里若再调 clear/setActive，不会把正在遍历的 Map 改出跳项
      const cleared = [...tracked.entries()];
      tracked.clear();
      active = null;
      for (const [trackedModel, filePath] of cleared) {
        clearMarkers(trackedModel);
        notifyCleared(trackedModel, filePath, 'explicit');
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelPending();
      const cleared = [...tracked.entries()];
      tracked.clear();
      active = null;
      for (const [trackedModel, filePath] of cleared) {
        clearMarkers(trackedModel);
        notifyCleared(trackedModel, filePath, 'dispose');
      }
    },
  };
}
