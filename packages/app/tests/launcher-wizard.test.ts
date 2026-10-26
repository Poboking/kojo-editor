/**
 * 启动器纯函数层（L10 批）：新建实例向导 / 候选卡片 / 创建请求 / 任务进度 /
 * 信任流 / 四类错误人话 / 进程读数监听。
 *
 * 判据一律**行为级**：给读数、要下一态或人话；每条断言都点名具体字段或具体字样，
 * 不写 `expect(true)` 那种空断——迁移规则换了、文案挪了，这里必须红。
 */
import { describe, expect, it } from 'vitest';
import type {
  InstanceInspection,
  LauncherInstance,
  LauncherTask,
  ProcessStatus,
  ProcessSupervisor,
} from '@kojo/plugin-api';
import {
  ISOLATION_CHOICES,
  NO_LAUNCH_SURFACE_TEXT,
  PROCESS_POLL_INTERVAL_MS,
  candidateCards,
  describeTrustInterruption,
  emptyProbeNotice,
  formatBytes,
  includeSavesHint,
  launchErrorAdvice,
  launchPlan,
  taskKindLabel,
  taskProgressView,
  watchProcessStatus,
  wizardAdvance,
  wizardApplyPickedRoot,
  wizardBlockedReason,
  wizardCancel,
  wizardCreateRequest,
  wizardRetreat,
  wizardSelectCandidate,
  wizardStart,
  wizardStepIndex,
  wizardSummaryRows,
  type CandidateCard,
} from '../src/launcher/model';

/* ------------------------------ 夹具 ------------------------------ */

function instance(overrides: Partial<LauncherInstance> = {}): LauncherInstance {
  return {
    id: 'i-1',
    name: '示例实例',
    adapterId: 'game-a',
    gameId: 'game-a',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceRoot: 'D:/games/a',
    isolation: 'shared',
    instanceRoot: 'C:/appData/instances/i-1',
    gameRoot: 'D:/games/a',
    state: 'ready',
    executable: { relativePath: 'game.exe', args: [], env: {}, windowMode: 'auto', sha256: null },
    runtimeId: null,
    locale: { mode: 'inherit' },
    encoding: { mode: 'auto', fallback: 'utf-8' },
    saveRoots: [],
    contentRoots: [],
    executableTrust: null,
    launchCount: 0,
    lastLaunchedAt: null,
    lastExit: null,
    schemaVersion: 1,
    ...overrides,
  };
}

function inspection(overrides: { trusted?: boolean; changedSinceTrust?: boolean; exists?: boolean } = {}): InstanceInspection {
  const entry = instance();
  return {
    instance: entry,
    executable: {
      absolutePath: 'D:/games/a/game.exe',
      exists: overrides.exists ?? true,
      sha256: 'a'.repeat(64),
      trusted: overrides.trusted ?? true,
      changedSinceTrust: overrides.changedSinceTrust ?? false,
    },
    runtime: { required: null, resolved: null },
    paths: {
      instanceRoot: entry.instanceRoot,
      gameRoot: entry.gameRoot,
      saveRoots: [],
      logDir: 'C:/appData/instances/i-1/logs',
      backupDir: 'C:/appData/instances/i-1/backups',
    },
    diskUsageBytes: 0,
    warnings: [],
  };
}

function card(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    key: 'game-a::only',
    adapterId: 'game-a',
    gameId: 'game-a',
    gameName: 'game-a 游戏',
    candidateId: 'only',
    label: '唯一候选',
    relativePath: 'game.exe',
    arch: null,
    notes: null,
    recommended: false,
    ...overrides,
  };
}

function task(overrides: Partial<LauncherTask> = {}): LauncherTask {
  return {
    id: 'task-1',
    kind: 'instance-copy',
    instanceId: 'i-1',
    state: 'running',
    progress: { done: 1, total: 4, unit: 'bytes', message: '' },
    createdAt: '2026-10-26T00:00:00.000Z',
    startedAt: '2026-10-26T00:00:01.000Z',
    endedAt: null,
    error: null,
    result: null,
    cancellable: true,
    ...overrides,
  };
}

/* ------------------------------ 向导迁移 ------------------------------ */

describe('新建实例向导：三步迁移（前进 / 后退 / 取消）', () => {
  it('初始态停在第一步，什么都没有选', () => {
    expect(wizardStart()).toEqual({
      step: 'source',
      sourceRoot: null,
      candidateKey: null,
      name: '',
      isolation: 'shared',
      includeSaves: false,
    });
    expect(wizardStepIndex('source')).toBe(0);
    expect(wizardStepIndex('details')).toBe(2);
  });

  it('第一步没选目录就点「下一步」：原地不动并说清为什么', () => {
    const move = wizardAdvance(wizardStart(), { candidateCount: 0 });
    expect(move.kind).toBe('blocked');
    expect(move.reason).toContain('还没有选来源目录');
    expect(move.state.step).toBe('source');
  });

  it('目录对话框取消（回执 null）：停在原步、不算错误', () => {
    const state = wizardStart();
    const outcome = wizardApplyPickedRoot(state, null);
    expect(outcome.kind).toBe('cancelled');
    expect(outcome.state).toBe(state);
  });

  it('选了目录：进第二步并记住来源根（候选清空）', () => {
    const outcome = wizardApplyPickedRoot(wizardStart(), '  D:/games/a  ');
    expect(outcome.kind).toBe('picked');
    expect(outcome.state.step).toBe('candidate');
    expect(outcome.state.sourceRoot).toBe('D:/games/a');
    expect(outcome.state.candidateKey).toBeNull();
  });

  it('第二步：零候选 / 没选候选分别给不同的拦截理由', () => {
    const atCandidate = { ...wizardStart(), step: 'candidate' as const, sourceRoot: 'D:/games/a' };
    expect(wizardBlockedReason(atCandidate, { candidateCount: 0 })).toContain(
      '这个目录没有可启动的候选',
    );
    expect(wizardBlockedReason(atCandidate, { candidateCount: 1 })).toContain('先选一个要启动的程序');

    expect(wizardAdvance(atCandidate, { candidateCount: 0 }).kind).toBe('blocked');
  });

  it('选了候选：名字默认取游戏显示名；用户改过的名字不被覆盖', () => {
    const atCandidate = { ...wizardStart(), step: 'candidate' as const, sourceRoot: 'D:/games/a' };
    const picked = wizardSelectCandidate(atCandidate, card());
    expect(picked.candidateKey).toBe('game-a::only');
    expect(picked.name).toBe('game-a 游戏');

    const named = wizardSelectCandidate({ ...atCandidate, name: '主存档' }, card());
    expect(named.name).toBe('主存档');

    const moved = wizardAdvance(picked, { candidateCount: 1 });
    expect(moved.kind).toBe('moved');
    expect(moved.state.step).toBe('details');
  });

  it('后退：候选步 → 来源步时清掉候选（换目录后旧 id 不一定还成立）', () => {
    const state = {
      ...wizardStart(),
      step: 'candidate' as const,
      sourceRoot: 'D:/games/a',
      candidateKey: 'game-a::only',
    };
    const back = wizardRetreat(state);
    expect(back.step).toBe('source');
    expect(back.candidateKey).toBeNull();
    expect(back.sourceRoot).toBe('D:/games/a');
  });

  it('后退：详情步 → 候选步保留选中的候选；第一步再后退是无操作', () => {
    const state = {
      ...wizardStart(),
      step: 'details' as const,
      sourceRoot: 'D:/games/a',
      candidateKey: 'game-a::only',
      name: '主存档',
    };
    const back = wizardRetreat(state);
    expect(back.step).toBe('candidate');
    expect(back.candidateKey).toBe('game-a::only');

    const atSource = wizardStart();
    expect(wizardRetreat(atSource)).toBe(atSource);
  });

  it('最后一步再点「前进」= 原地不动（提交按钮才是出口）', () => {
    const state = { ...wizardStart(), step: 'details' as const, name: '主存档' };
    const move = wizardAdvance(state, { candidateCount: 1 });
    expect(move.kind).toBe('blocked');
    expect(move.reason).toContain('已经在最后一步');
  });

  it('取消：整份草稿丢弃（目录 / 候选 / 名字全清）', () => {
    expect(wizardCancel()).toEqual(wizardStart());
  });
});

/* ------------------------------ 候选卡片 ------------------------------ */

describe('候选卡片（显示名 / 相对路径证据 / 推荐位）', () => {
  const raw = [
    { id: 'x64', label: '主程序（x64 · 推荐）', executableRelativePath: 'Emuera_x64.exe', arch: 'x64' as const, notes: '本机实测' },
    { id: 'x86', label: '主程序（x86）', executableRelativePath: 'Emuera_x86.exe' },
  ];

  it('多候选：顺序即推荐序，只有第一条标推荐位', () => {
    const cards = candidateCards('game-a', 'game-a', 'game-a 游戏', raw);
    expect(cards.map((c) => c.key)).toEqual(['game-a::x64', 'game-a::x86']);
    expect(cards[0]).toMatchObject({
      candidateId: 'x64',
      relativePath: 'Emuera_x64.exe',
      arch: 'x64',
      notes: '本机实测',
      recommended: true,
      gameName: 'game-a 游戏',
    });
    expect(cards[1]?.recommended).toBe(false);
  });

  it('唯一候选不标推荐位（把「唯一」叫推荐是噪声）', () => {
    const cards = candidateCards('game-a', 'game-a', 'game-a 游戏', [raw[1]!]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.recommended).toBe(false);
    expect(cards[0]?.arch).toBeNull();
    expect(cards[0]?.notes).toBeNull();
  });

  it('零候选：明确说「这个目录不能作为实例」并逐条给原因', () => {
    const notice = emptyProbeNotice([]);
    expect(notice.title).toBe('这个目录不能作为实例');
    expect(notice.reasons[0]).toContain('一个候选都没有的目录不能作为实例');
    expect(notice.reasons.join('\n')).toContain('适配器在这个目录的根层没有找到');

    const withFailure = emptyProbeNotice([{ adapterId: 'game-a', message: '目录读不动' }]);
    expect(withFailure.reasons.join('\n')).toContain('适配器 game-a 探测时出错：目录读不动');
    expect(withFailure.reasons.join('\n')).not.toContain('适配器在这个目录的根层没有找到');
  });

  it('「没有 adapter 启动面」是一条独立分档提示（不是宿主未就绪）', () => {
    expect(NO_LAUNCH_SURFACE_TEXT).toContain('没有提供启动面的适配器');
    expect(NO_LAUNCH_SURFACE_TEXT).toContain('只能编辑，不能启动');
    expect(NO_LAUNCH_SURFACE_TEXT).not.toContain('宿主未就绪');
  });
});

/* ------------------------------ 创建请求 ------------------------------ */

describe('草稿 → CreateInstanceRequest', () => {
  const base = {
    ...wizardStart(),
    step: 'details' as const,
    sourceRoot: 'D:/games/a',
    candidateKey: 'game-a::only',
    name: '  主存档  ',
  };

  it('shared 档：不带 includeSaves（传了就是假话）', () => {
    const submission = wizardCreateRequest(base, card());
    expect(submission.problem).toBeNull();
    expect(submission.request).toEqual({
      name: '主存档',
      sourceRoot: 'D:/games/a',
      adapterId: 'game-a',
      gameId: 'game-a',
      candidateId: 'only',
      isolation: 'shared',
    });
    expect(submission.request).not.toHaveProperty('includeSaves');
  });

  it('copy 档：includeSaves 按勾选下发', () => {
    const submission = wizardCreateRequest({ ...base, isolation: 'copy', includeSaves: true }, card());
    expect(submission.request).toMatchObject({ isolation: 'copy', includeSaves: true });
  });

  it('缺目录 / 缺候选 / 空名字各有各的拦截理由', () => {
    expect(wizardCreateRequest({ ...base, sourceRoot: null }, card()).problem).toContain(
      '还没有来源目录',
    );
    expect(wizardCreateRequest(base, null).problem).toContain('还没有选定启动程序');
    expect(wizardCreateRequest(base, card({ key: 'game-a::other' })).problem).toContain(
      '还没有选定启动程序',
    );
    expect(wizardCreateRequest({ ...base, name: '   ' }, card()).problem).toContain(
      '实例需要一个名字',
    );
  });

  it('摘要行：游戏 / 程序 / 目录 / 隔离 / 存档五格', () => {
    const rows = wizardSummaryRows(base, card({ arch: 'x64' }));
    expect(rows.map((row) => row.label)).toEqual(['游戏', '程序', '来源目录', '隔离模式', '存档']);
    expect(rows.find((row) => row.label === '程序')?.value).toBe('game.exe（x64）');
    expect(rows.find((row) => row.label === '存档')?.value).toBe('使用原目录存档');
    expect(
      wizardSummaryRows({ ...base, isolation: 'copy', includeSaves: true }, card()).find(
        (row) => row.label === '存档',
      )?.value,
    ).toBe('随副本复制现有存档');
  });

  it('隔离两档的说明：copy 明说会复制 / 体积量级，shared 明说不复制', () => {
    expect(ISOLATION_CHOICES.map((choice) => choice.mode)).toEqual(['shared', 'copy']);
    expect(ISOLATION_CHOICES[0]?.hint).toContain('不复制文件');
    expect(ISOLATION_CHOICES[1]?.hint).toContain('数百 MB 到数 GB');
    expect(includeSavesHint('shared')).toContain('这一项不生效');
    expect(includeSavesHint('copy')).toContain('从全新存档开始');
  });
});

/* ------------------------------ 信任 / 启动 ------------------------------ */

describe('启动按钮的形态：未信任 ⇒「信任并启动」', () => {
  it('未信任：按钮改文案，needsTrust 为真', () => {
    const plan = launchPlan(instance(), inspection({ trusted: false }));
    expect(plan.label).toBe('信任并启动');
    expect(plan.needsTrust).toBe(true);
    expect(plan.blockedReason).toBeNull();
  });

  it('已信任：只是「启动」', () => {
    const plan = launchPlan(instance(), inspection({ trusted: true }));
    expect(plan.label).toBe('启动');
    expect(plan.needsTrust).toBe(false);
  });

  it('确认之后被改动：仍需重新确认（等同未信任）', () => {
    const plan = launchPlan(instance(), inspection({ trusted: false, changedSinceTrust: true }));
    expect(plan.label).toBe('信任并启动');
    expect(plan.needsTrust).toBe(true);
  });

  it('详情还没读到时退回实例快照的 executableTrust', () => {
    expect(launchPlan(instance({ executableTrust: null }), null).needsTrust).toBe(true);
    expect(
      launchPlan(
        instance({
          executableTrust: {
            sha256: 'a'.repeat(64),
            size: 1,
            approvedAt: '2026-10-01T00:00:00.000Z',
            approvedBy: 'native-dialog',
          },
        }),
        null,
      ).needsTrust,
    ).toBe(false);
  });

  it('实例没就绪 / 程序不在位：连点都不给，并说清原因', () => {
    expect(launchPlan(instance({ state: 'preparing' }), inspection()).blockedReason).toContain(
      '准备中',
    );
    expect(launchPlan(instance({ state: 'broken' }), inspection()).blockedReason).toContain('已损坏');
    expect(launchPlan(instance(), inspection({ exists: false })).blockedReason).toContain(
      '目标程序不在位',
    );
    expect(launchPlan(instance(), inspection()).blockedReason).toBeNull();
  });

  it('原生确认框取消：一行说明、不启动、不重试', () => {
    const cancelled = describeTrustInterruption({
      code: 'LAUNCHER_TRUST_CANCELLED',
      message: '用户取消了确认',
      retryable: false,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.note).toContain('已取消系统确认框');
    expect(cancelled.note).toContain('不会自动重试');

    const failed = describeTrustInterruption(new Error('dialog closed'));
    expect(failed.cancelled).toBe(false);
    expect(failed.note).toContain('dialog closed');
    expect(failed.note).toContain('这次没有启动游戏');
  });
});

/* ------------------------------ 任务进度 ------------------------------ */

describe('复制任务进度（不要假装立刻 ready）', () => {
  it('进行中：字节进度 + 百分比 + 忙碌档', () => {
    const view = taskProgressView(
      task({
        progress: {
          done: 512 * 1024 * 1024,
          total: 2 * 1024 * 1024 * 1024,
          unit: 'bytes',
          message: '正在复制 resources/',
        },
      }),
    );
    expect(view.headline).toBe('正在复制实例目录…');
    expect(view.detail).toBe('512.0 MB / 2.00 GB · 正在复制 resources/');
    expect(view.percent).toBe(25);
    expect(view.tone).toBe('busy');
    expect(view.terminal).toBe(false);
  });

  it('文件 / 步数两种单位也读得懂', () => {
    expect(
      taskProgressView(task({ progress: { done: 3, total: 10, unit: 'files', message: '' } })).detail,
    ).toBe('3 / 10 个文件');
    expect(
      taskProgressView(task({ progress: { done: 1, total: 4, unit: 'steps', message: '' } })).detail,
    ).toBe('1 / 4 步');
  });

  it('没有进度读数时明说，不留空白', () => {
    const view = taskProgressView(task({ progress: null }));
    expect(view.detail).toBe('这个任务没有进度读数。');
    expect(view.percent).toBeNull();
  });

  it('完成 / 失败 / 取消：终态与档位；失败带原文', () => {
    expect(taskProgressView(task({ state: 'succeeded' }))).toMatchObject({
      headline: '复制实例目录完成',
      tone: 'ok',
      terminal: true,
      cancellable: false,
    });
    expect(taskProgressView(task({ state: 'cancelled' })).tone).toBe('idle');
    const failed = taskProgressView(
      task({
        state: 'failed',
        error: { code: 'LAUNCHER_INTERNAL', message: '磁盘已满', retryable: false },
      }),
    );
    expect(failed.headline).toBe('复制实例目录失败');
    expect(failed.tone).toBe('warn');
    expect(failed.errorText).toBe('磁盘已满');
    expect(failed.terminal).toBe(true);
  });

  it('未知任务类别回显原 kind（不套一个已知档）', () => {
    expect(taskKindLabel('instance-copy')).toBe('复制实例目录');
    expect(taskKindLabel('something-new')).toBe('后台任务（something-new）');
  });

  it('字节格式化四档', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * 1024)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });
});

/* ------------------------------ 四类错误人话 ------------------------------ */

describe('四类启动错误：人话 + 下一步（码与原文不改写）', () => {
  it('信任失效：解释「确认与文件绑定」并指向重新确认', () => {
    const advice = launchErrorAdvice('LAUNCHER_TRUST_CHANGED');
    expect(advice?.heading).toContain('确认之后被改动');
    expect(advice?.explanation).toContain('文件一变');
    expect(advice?.nextStep).toContain('重新走一次系统确认框');
  });

  it('目标程序不合法：说清路径规则与改候选的出口', () => {
    const advice = launchErrorAdvice('LAUNCHER_EXECUTABLE_INVALID');
    expect(advice?.heading).toBe('启动目标不合法');
    expect(advice?.explanation).toContain('相对路径');
    expect(advice?.nextStep).toContain('重新选一个候选');
  });

  it('已在运行（LAUNCHER_ALREADY_RUNNING 不在契约码表里，照样给人话）与实例忙', () => {
    expect(launchErrorAdvice('LAUNCHER_ALREADY_RUNNING')?.heading).toContain('已经在运行');
    expect(launchErrorAdvice('LAUNCHER_ALREADY_RUNNING')?.nextStep).toContain('先点「停止」');
    expect(launchErrorAdvice('LAUNCHER_INSTANCE_BUSY')?.heading).toContain('正忙');
    expect(launchErrorAdvice('LAUNCHER_INSTANCE_BUSY')?.nextStep).toContain('「运行中」或「未运行」');
  });

  it('平台未接入：说清「这一版还没这条能力」并给可走的路', () => {
    const advice = launchErrorAdvice('LAUNCHER_PLATFORM_UNSUPPORTED');
    expect(advice?.heading).toContain('还没有这条宿主能力');
    expect(advice?.nextStep).toContain('共享目录');
  });

  it('其余码 / 无码：不冒充有针对性解释（返回 null，界面走通用建议）', () => {
    expect(launchErrorAdvice('LAUNCHER_RUNTIME_MISSING')).toBeNull();
    expect(launchErrorAdvice(null)).toBeNull();
    expect(launchErrorAdvice(undefined)).toBeNull();
  });
});

/* ------------------------------ 进程读数监听 ------------------------------ */

describe('进程读数：订阅优先，3 s 轮询兜底', () => {
  function status(state: ProcessStatus['state']): ProcessStatus {
    return {
      instanceId: 'i-1',
      state,
      pid: null,
      sessionId: null,
      startedAt: null,
      elapsedMs: 0,
      exitCode: null,
      exitReason: null,
      lastError: null,
    };
  }

  it('有 subscribe 就用订阅（不装定时器）', () => {
    const pushed: string[] = [];
    let listener: ((value: ProcessStatus) => void) | null = null;
    const unsubscribe = () => {
      pushed.push('unsubscribed');
    };
    let timerArmed = false;
    const off = watchProcessStatus(
      {
        status: () => status('idle'),
        subscribe: (fn: (value: ProcessStatus) => void) => {
          listener = fn;
          return unsubscribe;
        },
      },
      'i-1',
      (value) => pushed.push(value.state),
      {
        setInterval: (() => {
          timerArmed = true;
          return 1 as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearInterval: (() => undefined) as unknown as typeof clearInterval,
      },
    );
    expect(timerArmed).toBe(false);
    listener!(status('running'));
    expect(pushed).toEqual(['running']);
    off();
    expect(pushed).toEqual(['running', 'unsubscribed']);
  });

  it('没有 subscribe：3 s 轮询 status，取消即清定时器', () => {
    let intervalMs = 0;
    let tick: (() => void) | null = null;
    let cleared = false;
    const seen: string[] = [];
    const off = watchProcessStatus(
      { status: () => status('running') } as unknown as Pick<
        ProcessSupervisor,
        'status' | 'subscribe'
      >,
      'i-1',
      (value) => seen.push(value.state),
      {
        setInterval: ((fn: () => void, ms: number) => {
          tick = fn;
          intervalMs = ms;
          return 7 as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearInterval: (() => {
          cleared = true;
        }) as unknown as typeof clearInterval,
      },
    );
    expect(intervalMs).toBe(PROCESS_POLL_INTERVAL_MS);
    expect(PROCESS_POLL_INTERVAL_MS).toBe(3_000);
    tick!();
    expect(seen).toEqual(['running']);
    off();
    expect(cleared).toBe(true);
  });
});
