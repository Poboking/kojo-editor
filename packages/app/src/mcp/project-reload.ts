/**
 * MCP-RELOAD-HOOK：驻留档案换代时的**可选** reload 钩子与同源回执账（2026-11-28）。
 *
 * 内核只发 `project.evicted` / `project.reload` 两个事件（都带 `rootId`），不替任何
 * 消费方宣称「已重载」。本模块是消费方契约：
 * - **不登记钩子 = 旧行为逐字不变**——没有回执账、没有额外副作用；事件本来就存在。
 * - 钩子可用 S1 索引快照做增量重载（`createS1SnapshotReloadHook` 提供现成形态），
 *   只读 `snapshot()`、不重扫整棵树。
 * - 回执只有在 `rootId`、`rootDir` 反查、快照 `sourceStamp` 三者同源时才记 `reloaded`；
 *   缺任一环一律 `unverified` + 理由，绝不乐观报「已重载」。
 * - 账本按 channel 分开：调试宿与真壳各记各的，既不共享钩子也不互借读数。
 *
 * 本模块由宿主按需动态 import；顶层只有契约层纯函数与类型，不静态拖 Monaco / React。
 */
import type { EventBus, ProjectReloadEvent, ProjectEvictedEvent } from '@kojo/plugin-api';
import { isRootIdShape, rootIdOf } from '@kojo/plugin-api';

/** 取证面复用同一枚纯函数（调试宿 / 真壳两侧各自算自己的 rootId，绝不互借）。 */
export { rootIdOf } from '@kojo/plugin-api';

/** 消费方钩子：拿到换代请求，回一份「重载依据」；是否真的重载由消费方决定。 */
export type ProjectReloadHook = (
  request: ProjectReloadRequest,
) => ProjectReloadResult | Promise<ProjectReloadResult>;

export interface ProjectReloadRequest extends ProjectReloadEvent {}

/**
 * S1 快照的最小读数面（够算同源 stamp，不暴露内部 Map）。
 * 不 `import type` S1 索引模块——那是 language-parity 钉住的消费者清单，
 * 多一枚 import 就触发重判；这里按结构同形声明，生产由 `kojo2ProjectIndex.snapshot()` 满足。
 */
export interface S1SnapshotLike {
  readonly generation: number;
  readonly fileCount: number;
}

export interface ProjectReloadResult {
  readonly rootId: string;
  readonly rootDir: string;
  /** `${rootId}:${generation}`；由读取 S1 快照的那一拍算出，见 {@link sourceStampOf}。 */
  readonly sourceStamp: string;
  readonly generation: number;
  readonly reusedSnapshot: boolean;
}

/** 账本中一行；`event` 区分原始事件与回执，两种都记在同一条有界账里。 */
export interface ReloadLedgerEntry {
  readonly event: 'project.evicted' | 'project.reload' | 'reload.result';
  readonly rootId: string | null;
  /** `reloaded` 只在同源证明齐全时出现；原始事件恒为 `unverified`。 */
  readonly claim: 'reloaded' | 'unverified';
  readonly sourceStamp: string | null;
  readonly generation: number | null;
  readonly reason?: string;
  readonly trigger?: ProjectReloadEvent['trigger'];
  readonly elapsedMs: number;
  readonly at: number;
}

export type ReloadChannel = string;

const DEFAULT_CHANNEL: ReloadChannel = 'default';
/** 与既有改动账同量级：有界、溢出可见（这里用 FIFO 丢弃，读面另给 `dropped`）。 */
export const RELOAD_LEDGER_CAPACITY = 64;

interface ChannelState {
  hook: ProjectReloadHook | null;
  ledger: ReloadLedgerEntry[];
  dropped: number;
}

const channels = new Map<ReloadChannel, ChannelState>();

function stateOf(channel: ReloadChannel): ChannelState {
  let state = channels.get(channel);
  if (!state) {
    state = { hook: null, ledger: [], dropped: 0 };
    channels.set(channel, state);
  }
  return state;
}

function append(state: ChannelState, entry: ReloadLedgerEntry): void {
  state.ledger.push(entry);
  if (state.ledger.length > RELOAD_LEDGER_CAPACITY) {
    state.ledger.shift();
    state.dropped += 1;
  }
}

/** 同源 stamp 的口径：根枚举标识 + S1 快照 generation，缺一不可。 */
export function sourceStampOf(rootId: string, generation: number): string {
  return `${rootId}:${generation}`;
}

/** 登记 / 撤销某条通道的钩子；`null` ＝ 撤销（此后该通道只记 unverified，不借别的通道）。 */
export function registerProjectReloadHook(
  hook: ProjectReloadHook | null,
  channel: ReloadChannel = DEFAULT_CHANNEL,
): void {
  stateOf(channel).hook = hook;
}

/** 当前钩子（未登记返回 `null`）。 */
export function getProjectReloadHook(channel: ReloadChannel = DEFAULT_CHANNEL): ProjectReloadHook | null {
  return channels.get(channel)?.hook ?? null;
}

/** 只读账本副本（按登记序；溢出后最老的已丢弃）。 */
export function reloadLedger(channel: ReloadChannel = DEFAULT_CHANNEL): readonly ReloadLedgerEntry[] {
  return [...(channels.get(channel)?.ledger ?? [])];
}

/** 该通道溢出丢弃条数（有界账不静默）。 */
export function reloadDropped(channel: ReloadChannel = DEFAULT_CHANNEL): number {
  return channels.get(channel)?.dropped ?? 0;
}

/** 回执耗时的 p95（无回执返回 0）；样本只取本通道，绝不从别的通道补。 */
export function reloadP95(rows: readonly ReloadLedgerEntry[]): number {
  const samples = rows
    .filter((r) => r.event === 'reload.result' && r.claim === 'reloaded')
    .map((r) => r.elapsedMs)
    .sort((a, b) => a - b);
  if (samples.length === 0) return 0;
  const index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1);
  return samples[Math.max(0, index)]!;
}

/** 清空所有通道的钩子与账（仅测试 / 显式停用；生产不调用）。 */
export function clearProjectReloadState(): void {
  channels.clear();
}

/**
 * 现成的「复用 S1 快照」钩子：只读 `snapshot()` 一趟，拿 generation 算同源 stamp；
 * 不调 `updateFile` / 不遍历文件 / 不重解析。消费方若要真的重建索引，可在此处
 * 自行做增量更新，但 stamp 必须仍取自这一趟快照。
 */
export function createS1SnapshotReloadHook(
  snapshot: () => S1SnapshotLike,
): ProjectReloadHook {
  return (request) => {
    const current = snapshot();
    return {
      rootId: request.rootId,
      rootDir: request.rootDir,
      generation: current.generation,
      sourceStamp: sourceStampOf(request.rootId, current.generation),
      reusedSnapshot: true,
    };
  };
}

interface VerifyResult {
  readonly claim: 'reloaded' | 'unverified';
  readonly sourceStamp: string | null;
  readonly generation: number | null;
  readonly reason?: string;
}

/** 同源证明：三环全齐才准报 reloaded；任一环缺/错都出声。 */
function verify(
  request: ProjectReloadRequest,
  result: ProjectReloadResult,
  fallbackSnapshot?: () => S1SnapshotLike,
): VerifyResult {
  const reject = (reason: string): VerifyResult => ({
    claim: 'unverified',
    sourceStamp: null,
    generation: null,
    reason,
  });
  if (!isRootIdShape(result.rootId) || result.rootId !== request.rootId) {
    return reject('回执 rootId 与请求 rootId 不一致（不是同一根）');
  }
  if (rootIdOf(result.rootDir) !== request.rootId) {
    return reject('回执 rootDir 反查出的 rootId 与请求不一致（不是同一根）');
  }
  if (
    typeof result.generation !== 'number' ||
    !Number.isFinite(result.generation) ||
    !Number.isInteger(result.generation) ||
    result.generation < 0
  ) {
    return reject('回执没有可用的 S1 generation（未证明同源）');
  }
  if (result.reusedSnapshot !== true) {
    return reject('回执未声明复用 S1 快照（可能全量重扫）');
  }
  // 钩子没给 stamp 时允许一次兜底快照读；给了就以它为准，不重复付 syscall。
  const stamp =
    typeof result.sourceStamp === 'string' && result.sourceStamp.length > 0
      ? result.sourceStamp
      : fallbackSnapshot
        ? sourceStampOf(request.rootId, fallbackSnapshot().generation)
        : '';
  if (stamp !== sourceStampOf(request.rootId, result.generation)) {
    return reject('S1 快照 stamp 与 generation 对不上（未证明同源）');
  }
  return { claim: 'reloaded', sourceStamp: stamp, generation: result.generation };
}

export interface InstallObserverOptions {
  /** 本通道缺失 stamp 时的一次兜底快照读；不传就一律 unverified。 */
  readonly snapshot?: () => S1SnapshotLike;
  /** 账本通道名；'debug-host' 与 'real-shell' 各记各的，绝不互借。 */
  readonly ledger?: ReloadChannel;
}

/**
 * 挂上观察器（幂等由调用方保证；返回的 off 只退订本次订阅）。
 * `project.evicted` 记原始事件，`project.reload` 记请求 + 回执；没有钩子时回执仍记
 * `unverified` + 理由，绝不静默、也绝不拿别的通道的数来填。
 */
export function installProjectReloadObserver(
  bus: EventBus,
  options: InstallObserverOptions = {},
): () => void {
  const channel = options.ledger ?? DEFAULT_CHANNEL;
  const state = stateOf(channel);
  const onEvicted = (payload: ProjectEvictedEvent): void => {
    append(state, {
      event: 'project.evicted',
      rootId: payload.rootId ?? null,
      claim: 'unverified',
      sourceStamp: null,
      generation: null,
      elapsedMs: 0,
      at: Date.now(),
    });
  };
  const onReload = (payload: ProjectReloadEvent): void => {
    append(state, {
      event: 'project.reload',
      rootId: payload.rootId,
      claim: 'unverified',
      sourceStamp: null,
      generation: null,
      trigger: payload.trigger,
      elapsedMs: 0,
      at: Date.now(),
    });
    const started = performance.now();
    const hook = state.hook;
    if (!hook) {
      append(state, {
        event: 'reload.result',
        rootId: payload.rootId,
        claim: 'unverified',
        sourceStamp: null,
        generation: null,
        reason: `通道 ${channel} 没有登记 reload 钩子（不借其它通道的数）`,
        trigger: payload.trigger,
        elapsedMs: performance.now() - started,
        at: Date.now(),
      });
      return;
    }
    void Promise.resolve()
      .then(() => hook(payload))
      .then((result) => {
        const verdict = verify(payload, result, options.snapshot);
        append(state, {
          event: 'reload.result',
          rootId: payload.rootId,
          ...verdict,
          trigger: payload.trigger,
          elapsedMs: performance.now() - started,
          at: Date.now(),
        });
      })
      .catch((err: unknown) => {
        append(state, {
          event: 'reload.result',
          rootId: payload.rootId,
          claim: 'unverified',
          sourceStamp: null,
          generation: null,
          reason: `reload 钩子抛错：${String(err)}`,
          trigger: payload.trigger,
          elapsedMs: performance.now() - started,
          at: Date.now(),
        });
      });
  };
  const offEvicted = bus.on('project.evicted', onEvicted);
  const offReload = bus.on('project.reload', onReload);
  return () => {
    offEvicted();
    offReload();
  };
}
