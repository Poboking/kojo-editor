import type { ConventionLinterService, ConventionReport, ConventionRuleFailure } from '@kojo/plugin-api';

/**
 * 「跑一轮全项目校验」的唯一驱动（ZH-F4）。
 *
 * 命令面板那条命令与面板的「重新校验」按钮**共用这一个入口**——两处各写一遍
 * `linter.run(...)` 的取数口径迟早分叉（判据、进度、失败原因都要一致）。
 * 本模块零 React、零内核：只管状态与时序，判定仍在 convention-linter 引擎。
 */

/** 命令面板条目 id（宿主按 `editor.command` 槽合并进统一注册表） */
export const LINT_PROJECT_COMMAND_ID = 'kojo.lintProject';
export const LINT_PROJECT_COMMAND_TITLE = '校验全项目口上';
export const LINT_PROJECT_COMMAND_CATEGORY = '校验';

export type LintRunPhase = 'idle' | 'running' | 'done' | 'failed';

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
}

const IDLE: LintRunState = {
  phase: 'idle',
  startedAt: 0,
  coveredFiles: 0,
  durationMs: 0,
  issueCount: 0,
  failedRules: [],
  errorText: '',
};

export interface LintRunStore {
  get(): LintRunState;
  subscribe(cb: (state: LintRunState) => void): () => void;
  begin(coveredFiles: number, startedAt: number): void;
  finish(report: ConventionReport, coveredFiles: number): void;
  fail(errorText: string, coveredFiles: number): void;
}

/**
 * 运行态仓（订阅形态与 `ConventionLinterService.subscribe` 一致：立即以当前值回调一次）。
 * 只在状态真的变了时通知——校验中的那一秒里宿主会渲染很多次，不能让订阅者空转。
 */
export function createLintRunStore(): LintRunStore {
  let state = IDLE;
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
      set({ ...state, phase: 'running', startedAt, coveredFiles, errorText: '' });
    },
    finish(report, coveredFiles) {
      set({
        phase: 'done',
        startedAt: report.startedAt,
        coveredFiles,
        durationMs: report.durationMs,
        issueCount: report.issues.length,
        failedRules: report.failedRules,
        errorText: '',
      });
    },
    fail(errorText, coveredFiles) {
      set({ ...state, phase: 'failed', coveredFiles, errorText, failedRules: [] });
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
 */
export async function driveLintRun(deps: DriveLintRunDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  if (deps.store.get().phase === 'running') return;
  const filesAtStart = deps.coveredFiles();
  deps.store.begin(filesAtStart, now());
  try {
    const report = await deps.linter.run({ force: true });
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
    case 'failed':
      return '校验没跑完';
    default:
      return '';
  }
}
