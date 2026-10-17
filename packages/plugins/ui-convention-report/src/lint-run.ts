import type { ConventionLinterService, ConventionReport, ConventionRuleFailure, ConventionRunIncomplete } from '@kojo/plugin-api';

/**
 * 「跑一轮全项目校验」的唯一驱动（ZH-F4）。
 *
 * 命令面板那条命令与面板的「重新校验」按钮**共用这一个入口**——两处各写一遍
 * `linter.run(...)` 的取数口径迟早分叉（判据、进度、失败原因都要一致）。
 * 本模块零 React、零内核：只管状态与时序，判定仍在 convention-linter 引擎。
 *
 * 叫停（ZH-F4b）同样只有一条路：`store` 持有这一轮的取消位，按钮/命令只按它一下；
 * **"这一轮算完了没有"由引擎在报告上说 (`incomplete`)，这里只搬运那个事实**——
 * 面板不许自己判定"我按了按钮所以结论不完整"。
 */

/** 命令面板条目 id（宿主按 `editor.command` 槽合并进统一注册表） */
export const LINT_PROJECT_COMMAND_ID = 'kojo.lintProject';
export const LINT_PROJECT_COMMAND_TITLE = '校验全项目口上';
export const LINT_PROJECT_COMMAND_CATEGORY = '校验';
/** 叫停那条命令：它不取任何数，只按下同一个 `store` 的取消位 */
export const LINT_STOP_COMMAND_ID = 'kojo.stopLintProject';
export const LINT_STOP_COMMAND_TITLE = '停止校验全项目口上';
export const LINT_STOP_COMMAND_CATEGORY = '校验';

export type LintRunPhase = 'idle' | 'running' | 'done' | 'stopped' | 'failed';

export interface LintRunState {
  readonly phase: LintRunPhase;
  /** 本轮开始时刻（`Date.now()` 量纲；idle = 0） */
  readonly startedAt: number;
  /** 本轮覆盖的文件数（引擎走的就是索引那份清单） */
  readonly coveredFiles: number;
  /** 上一轮耗时（运行中 = 上一轮的，不猜进度） */
  readonly durationMs: number;
  readonly issueCount: number;
  readonly failedRules: readonly ConventionRuleFailure[];
  /** `phase === 'failed'` 的原因（整轮抛错，绝不静默） */
  readonly errorText: string;
  /**
   * `phase === 'stopped'` 时才有：这一轮**只算完了这些**文件判定单元（分母 = 本轮计划要现算的总数）。
   * 数字来自引擎那份 `report.incomplete`，不在这里另算一遍。
   */
  readonly incomplete: ConventionRunIncomplete | null;
}

const IDLE: LintRunState = {
  phase: 'idle',
  startedAt: 0,
  coveredFiles: 0,
  durationMs: 0,
  issueCount: 0,
  failedRules: [],
  errorText: '',
  incomplete: null,
};

export interface LintRunStore {
  get(): LintRunState;
  subscribe(cb: (state: LintRunState) => void): () => void;
  /**
   * 起一轮：登记状态并**交出这一轮的取消位**（驱动方把它原样交给引擎）。
   * 取消位由本仓铸造与保管：`cancel()` 按的必然是 `begin` 交出去的那一枚 ⇒ 按钮与命令
   * 叫停的是同一轮，不存在第二条收摊的路。
   */
  begin(coveredFiles: number, startedAt: number): AbortSignal;
  finish(report: ConventionReport, coveredFiles: number): void;
  fail(errorText: string, coveredFiles: number): void;
  /** 叫停在跑的那一轮；没有在跑的轮、或已经叫停过 ⇒ 空操作（不许造第二次收摊） */
  cancel(): void;
}

/**
 * 运行态仓（订阅形态与 `ConventionLinterService.subscribe` 一致：立即以当前值回调一次）。
 * 只在状态真的变了时通知——校验中的那一秒里宿主会渲染很多次，不能让订阅者空转。
 *
 * 取消位归这里管：`begin` 登记、`finish`/`fail` 交还，`cancel` 只按手上这一个。
 * 于是"面板按钮"和"命令面板"叫停的是同一轮，不存在第二条收摊的路。
 */
export function createLintRunStore(): LintRunStore {
  let state = IDLE;
  /** 在跑那一轮的取消位（`begin` 铸造并交出，`finish`/`fail` 交还；不在跑 = null） */
  let stopper: AbortController | null = null;
  const listeners = new Set<(s: LintRunState) => void>();
  const set = (next: LintRunState): void => {
    if (next === state) return;
    state = next;
    for (const cb of [...listeners]) cb(state);
  };
  return {
    get: () => state,
    subscribe(cb) {
      listeners.add(cb);
      cb(state);
      return () => {
        listeners.delete(cb);
      };
    },
    begin(coveredFiles, startedAt) {
      const controller = new AbortController();
      stopper = controller;
      set({ ...state, phase: 'running', startedAt, coveredFiles, errorText: '', incomplete: null });
      return controller.signal;
    },
    finish(report, coveredFiles) {
      stopper = null;
      set({
        phase: report.incomplete ? 'stopped' : 'done',
        startedAt: report.startedAt,
        coveredFiles,
        durationMs: report.durationMs,
        issueCount: report.issues.length,
        failedRules: report.failedRules,
        errorText: '',
        incomplete: report.incomplete ?? null,
      });
    },
    fail(errorText, coveredFiles) {
      stopper = null;
      set({ ...state, phase: 'failed', coveredFiles, errorText, failedRules: [], incomplete: null });
    },
    cancel() {
      if (!stopper || stopper.signal.aborted) return;
      stopper.abort();
    },
  };
}

export interface DriveLintRunDeps {
  linter: Pick<ConventionLinterService, 'run'>;
  store: LintRunStore;
  /** 本轮覆盖的文件数（引擎吃的就是这份索引清单；未就绪给 0） */
  coveredFiles(): number;
  now?(): number;
}

/**
 * 跑一轮并落定状态。
 * 已在跑就**不再起第二轮**（引擎的在途合流只省算力，状态仓那边却会记成两次开始时刻，
 * 于是"已 X 秒"会跳回去——对作者是一张会说谎的读数）。
 * 抛错在这里收口成一句话：`linter.run` 的错过去是裸 `void …`，作者看不到任何动静。
 * 被叫停的那一轮由引擎**照常返回**（带 `incomplete`），所以这里不接 `AbortError`；
 * 服务侧要是不理取消位、真把整轮跑完了，读数就说整轮跑完——不完整与否不由这里猜。
 */
export async function driveLintRun(deps: DriveLintRunDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  if (deps.store.get().phase === 'running') return;
  const filesAtStart = deps.coveredFiles();
  const signal = deps.store.begin(filesAtStart, now());
  try {
    const report = await deps.linter.run({ force: true, signal });
    deps.store.finish(report, deps.coveredFiles());
  } catch (err) {
    deps.store.fail(err instanceof Error ? err.message : String(err), filesAtStart);
  }
}

const seconds = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;

/**
 * 一句话读数（作者面；面板与状态栏共用同一判据，别让同一件事有三种说法）。
 * 运行中只报**已经过的时间**——引擎没有分片进度可问，编一个百分比就是假象。
 */
export function lintRunText(state: LintRunState, now: number): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'running':
      return `正在校验 ${state.coveredFiles} 个文件 · 已 ${seconds(now - state.startedAt)}`;
    case 'failed':
      return `这轮校验没跑完：${state.errorText}`;
    case 'stopped': {
      const done = state.incomplete?.unitsDone ?? 0;
      const total = state.incomplete?.unitsTotal ?? 0;
      return [
        `这轮校验被你叫停：${total} 项里算完了 ${done} 项`,
        `已经查出 ${state.issueCount} 处问题 · 结论不完整，没存进结果缓存`,
        '下面那张清单没跟着变',
      ].join(' · ');
    }
    case 'done':
      return [
        `查了 ${state.coveredFiles} 个文件 · 用时 ${seconds(state.durationMs)} · ${state.issueCount} 处问题`,
        state.failedRules.length > 0 ? `${state.failedRules.length} 条规则没跑成（原因列在下面）` : '',
      ]
        .filter(Boolean)
        .join(' · ');
  }
}

/** 状态栏那枚小件的极简版（同一次运行、同一判据，只是装不下整句话） */
export function lintRunBrief(state: LintRunState, now: number): string {
  switch (state.phase) {
    case 'running':
      return `校验中 · 已 ${seconds(now - state.startedAt)}`;
    case 'stopped':
      return '校验被叫停 · 结论不完整';
    case 'failed':
      return '校验没跑完';
    default:
      return '';
  }
}
