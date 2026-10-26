/**
 * 启动器视图纯函数层（L5）：过滤 / 排序 / 状态文案 / 错误解读（错误码 → 人话）。
 *
 * 判据都是**行为级**：给读数、要人话。每条断言都点名具体字样或具体布尔值，
 * 不写 `expect(true)` 那种空断——文案换了、分档挪了，这里必须红。
 */
import { describe, expect, it } from 'vitest';
import type {
  InstanceInspection,
  LauncherInstance,
  ProcessStatus,
} from '@kojo/plugin-api';
import {
  describeFailure,
  describeServiceGap,
  detailFacts,
  detailHeadline,
  filterInstances,
  instanceRowView,
  instanceStateLabel,
  instanceStatusLine,
  isolationLabel,
  lastLaunchedText,
  launcherErrorHint,
  processStateLabel,
  sortInstances,
  startStopControls,
} from '../src/launcher/model';

/* ------------------------------ 夹具 ------------------------------ */

function instance(overrides: Partial<LauncherInstance> = {}): LauncherInstance {
  return {
    id: 'i-1',
    name: '示例实例',
    adapterId: 'adapter-a',
    gameId: 'game-a',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceRoot: 'D:/games/a',
    isolation: 'shared',
    instanceRoot: 'C:/appData/instances/i-1',
    gameRoot: 'D:/games/a',
    state: 'ready',
    executable: {
      relativePath: 'game.exe',
      args: [],
      env: {},
      windowMode: 'auto',
      sha256: null,
    },
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

function processStatus(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
  return {
    instanceId: 'i-1',
    state: 'idle',
    pid: null,
    sessionId: null,
    startedAt: null,
    elapsedMs: 0,
    exitCode: null,
    exitReason: null,
    lastError: null,
    ...overrides,
  };
}

function inspection(overrides: Partial<InstanceInspection> = {}): InstanceInspection {
  return {
    instance: instance(),
    executable: {
      absolutePath: 'D:/games/a/game.exe',
      exists: true,
      sha256: 'a'.repeat(64),
      trusted: true,
      changedSinceTrust: false,
    },
    runtime: { required: { kind: 'engine', versionRange: '1.0' }, resolved: null },
    paths: {
      instanceRoot: 'C:/appData/instances/i-1',
      gameRoot: 'D:/games/a',
      saveRoots: ['D:/games/a/save'],
      logDir: 'C:/appData/instances/i-1/logs',
      backupDir: 'C:/appData/instances/i-1/backups',
    },
    diskUsageBytes: 1024,
    warnings: [],
    ...overrides,
  };
}

/* ------------------------------ 名词 ------------------------------ */

describe('名词 → 中文（未知值回显，不悄悄套已知档）', () => {
  it('隔离模式三档各有中文名', () => {
    expect(isolationLabel('shared')).toBe('共享目录');
    expect(isolationLabel('copy')).toBe('独立副本');
    expect(isolationLabel('overlay')).toBe('覆盖层');
  });

  it('未知隔离模式回显原值（新版宿主加档时界面上看得见）', () => {
    expect(isolationLabel('sandbox')).toBe('未知模式（sandbox）');
  });

  it('实例状态四档与未知档', () => {
    expect(instanceStateLabel('preparing')).toBe('准备中');
    expect(instanceStateLabel('ready')).toBe('就绪');
    expect(instanceStateLabel('broken')).toBe('已损坏');
    expect(instanceStateLabel('removing')).toBe('移除中');
    expect(instanceStateLabel('frozen')).toBe('未知状态（frozen）');
  });

  it('进程状态六档全有中文名', () => {
    expect(processStateLabel('idle')).toBe('未运行');
    expect(processStateLabel('starting')).toBe('启动中');
    expect(processStateLabel('running')).toBe('运行中');
    expect(processStateLabel('stopping')).toBe('停止中');
    expect(processStateLabel('exited')).toBe('已退出');
    expect(processStateLabel('crashed')).toBe('异常退出');
  });
});

describe('一行状态：进程态优先，静息时看实例态（颜色档与文字同步）', () => {
  it('运行中压过「已损坏」的实例态（用户此刻最关心跑没跑）', () => {
    expect(instanceStatusLine('broken', 'running')).toEqual({ label: '运行中', tone: 'ok' });
  });

  it('过渡态是 busy 档，异常退出是 warn 档', () => {
    expect(instanceStatusLine('ready', 'starting')).toEqual({ label: '启动中', tone: 'busy' });
    expect(instanceStatusLine('ready', 'crashed')).toEqual({ label: '异常退出', tone: 'warn' });
  });

  it('就绪但没在跑读作「未运行」；损坏读作「已损坏」', () => {
    expect(instanceStatusLine('ready', 'idle')).toEqual({ label: '未运行', tone: 'idle' });
    expect(instanceStatusLine('broken', 'idle')).toEqual({ label: '已损坏', tone: 'warn' });
    expect(instanceStatusLine('preparing', 'idle')).toEqual({ label: '准备中', tone: 'busy' });
  });
});

/* ------------------------------ 上次启动 ------------------------------ */

describe('上次启动的相对时间', () => {
  const base = Date.parse('2026-10-26T12:00:00.000Z');

  it('从未启动 / 无法解析', () => {
    expect(lastLaunchedText(null, base)).toBe('从未启动');
    expect(lastLaunchedText('', base)).toBe('从未启动');
    expect(lastLaunchedText('不是时间', base)).toBe('时间未知');
  });

  it('刚刚 / 分钟 / 小时 / 天', () => {
    expect(lastLaunchedText('2026-10-26T11:59:40.000Z', base)).toBe('刚刚');
    expect(lastLaunchedText('2026-10-26T11:55:00.000Z', base)).toBe('5 分钟前');
    expect(lastLaunchedText('2026-10-26T09:00:00.000Z', base)).toBe('3 小时前');
    expect(lastLaunchedText('2026-10-24T12:00:00.000Z', base)).toBe('2 天前');
  });

  it('超过 30 天回 ISO 日期前 10 位（不随机器时区漂移）', () => {
    expect(lastLaunchedText('2026-08-01T12:00:00.000Z', base)).toBe('2026-08-01');
  });

  it('未来时间（时钟偏差）也算刚刚，不产出「-3 分钟前」', () => {
    expect(lastLaunchedText('2026-10-26T12:05:00.000Z', base)).toBe('刚刚');
  });
});

/* ------------------------------ 过滤 / 排序 ------------------------------ */

describe('搜索过滤', () => {
  const a = instance({ id: 'a', name: 'Alice 存档', gameId: 'game-a', isolation: 'shared' });
  const b = instance({ id: 'b', name: 'bob 试验', gameId: 'game-b', isolation: 'copy' });

  it('空查询返回全量副本（不是原数组——调用方可能排序）', () => {
    const input = [a, b];
    const out = filterInstances(input, '   ');
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('名字大小写不敏感', () => {
    expect(filterInstances([a, b], 'alice').map((x) => x.id)).toEqual(['a']);
    expect(filterInstances([a, b], 'BOB').map((x) => x.id)).toEqual(['b']);
  });

  it('也搜游戏 id 与隔离模式的中文名', () => {
    expect(filterInstances([a, b], 'game-b').map((x) => x.id)).toEqual(['b']);
    expect(filterInstances([a, b], '独立副本').map((x) => x.id)).toEqual(['b']);
  });

  it('没有命中就是空数组（不回落成全量）', () => {
    expect(filterInstances([a, b], '不存在的东西')).toEqual([]);
  });
});

describe('实例排序', () => {
  const older = instance({ id: 'o', name: '乙', lastLaunchedAt: '2026-10-01T00:00:00.000Z' });
  const newer = instance({ id: 'n', name: '甲', lastLaunchedAt: '2026-10-20T00:00:00.000Z' });
  const never = instance({ id: 'x', name: '丙', lastLaunchedAt: null });

  it('最近启动在前、从未启动垫底', () => {
    expect(sortInstances([never, older, newer]).map((x) => x.id)).toEqual(['n', 'o', 'x']);
  });

  it('同档按名字码点序（区域设置不参与）', () => {
    const same1 = instance({ id: 'p', name: 'B', lastLaunchedAt: '2026-10-20T00:00:00.000Z' });
    const same2 = instance({ id: 'q', name: 'A', lastLaunchedAt: '2026-10-20T00:00:00.000Z' });
    expect(sortInstances([same1, same2]).map((x) => x.id)).toEqual(['q', 'p']);
  });
});

/* ------------------------------ 按钮可用态 ------------------------------ */

describe('启动 / 停止按钮', () => {
  it('运行中只给停止；静息只给启动', () => {
    expect(startStopControls('running', null)).toEqual({
      canStart: false,
      canStop: true,
      busyText: null,
    });
    expect(startStopControls('idle', null)).toEqual({ canStart: true, canStop: false, busyText: null });
  });

  it('过渡态锁死两颗按钮并给出忙碌文案（不许「按了没反应」）', () => {
    expect(startStopControls('starting', null)).toEqual({
      canStart: false,
      canStop: false,
      busyText: '正在启动…',
    });
    expect(startStopControls('stopping', null)).toEqual({
      canStart: false,
      canStop: false,
      busyText: '正在停止…',
    });
  });

  it('本地在飞动作也算忙碌（防双击重复下发）', () => {
    const controls = startStopControls('running', 'stop');
    expect(controls.canStart).toBe(false);
    expect(controls.canStop).toBe(false);
    expect(controls.busyText).toBe('正在停止…');
  });
});

/* ------------------------------ 错误：码与原文都不改写 ------------------------------ */

describe('错误码 → 下一步建议（不是话术翻译）', () => {
  it('信任缺失指向系统确认框', () => {
    expect(launcherErrorHint('LAUNCHER_TRUST_REQUIRED')).toContain('系统确认框');
    expect(launcherErrorHint('LAUNCHER_TRUST_CHANGED')).toContain('先重新确认');
  });

  it('实例忙 / 平台未接入各有各的下一步', () => {
    expect(launcherErrorHint('LAUNCHER_INSTANCE_BUSY')).toContain('等当前操作结束');
    expect(launcherErrorHint('LAUNCHER_PLATFORM_UNSUPPORTED')).toContain('还没接入');
  });

  it('未登记的码给通用一句，不冒充知道原因', () => {
    expect(launcherErrorHint('LAUNCHER_SOMETHING_NEW')).toBe(
      '把错误码连同上面的说明一起反馈给开发者。',
    );
  });

  it('没有错误码时说清「没有码」，不伪造 LAUNCHER_INTERNAL', () => {
    expect(launcherErrorHint(null)).toContain('没有带错误码');
  });
});

describe('describeFailure：结构化错误原样呈现', () => {
  it('码 / 原文 / 可重试都照抄，只补标题与建议', () => {
    const failure = describeFailure(
      {
        code: 'LAUNCHER_INSTANCE_BUSY',
        message: '该实例正在启动或停止，请等当前操作结束',
        detail: 'step=start',
        retryable: true,
      },
      'start',
    );
    expect(failure).toMatchObject({
      title: '启动失败',
      code: 'LAUNCHER_INSTANCE_BUSY',
      message: '该实例正在启动或停止，请等当前操作结束',
      detail: 'step=start',
      retryable: true,
    });
    expect(failure.hint).toContain('等当前操作结束');
  });

  it('普通 Error：保留原文、码为 null、不假装可重试', () => {
    const failure = describeFailure(new Error('bridge timeout'), 'stop');
    expect(failure.title).toBe('停止失败');
    expect(failure.code).toBeNull();
    expect(failure.message).toBe('bridge timeout');
    expect(failure.retryable).toBe(false);
  });

  it('字符串与空对象都有可读兜底（不出现空白错误条）', () => {
    expect(describeFailure('纯字符串原因', 'list').message).toBe('纯字符串原因');
    const empty = describeFailure({}, 'inspect');
    expect(empty.code).toBeNull();
    expect(empty.message).toContain('未分类异常');
    expect(empty.title).toBe('读取实例详情失败');
  });
});

describe('服务缺席：说清缺哪一块', () => {
  it('插件不在表里', () => {
    expect(describeServiceGap(null)).toContain('不在插件表里');
  });

  it('缺宿主桥时直说「宿主未就绪」并点名服务键', () => {
    const text = describeServiceGap({ status: 'inactive', missing: ['kernel.launcher'], error: null });
    expect(text).toContain('宿主未就绪');
    expect(text).toContain('kernel.launcher');
  });

  it('激活报错原样带出；其它缺依赖逐条列出', () => {
    expect(
      describeServiceGap({ status: 'error', missing: [], error: 'boom in activate' }),
    ).toBe('启动器核心插件激活失败：boom in activate');
    expect(
      describeServiceGap({ status: 'inactive', missing: ['kernel.io'], error: null }),
    ).toContain('kernel.io');
  });

  it('没激活但也不缺依赖时回显状态', () => {
    expect(describeServiceGap({ status: 'pending', missing: [], error: null })).toContain('pending');
  });
});

/* ------------------------------ 列表行 / 详情 ------------------------------ */

describe('列表行投影', () => {
  it('名字 / 隔离 / 状态 / 上次启动一次收齐', () => {
    const row = instanceRowView(
      instance({
        id: 'r',
        name: '主实例',
        isolation: 'copy',
        lastLaunchedAt: '2026-10-26T11:00:00.000Z',
      }),
      processStatus({ instanceId: 'r', state: 'running' }),
      Date.parse('2026-10-26T12:00:00.000Z'),
    );
    expect(row).toMatchObject({
      id: 'r',
      name: '主实例',
      isolation: '独立副本',
      lastLaunched: '1 小时前',
      process: '运行中',
      status: { label: '运行中', tone: 'ok' },
    });
  });
});

describe('详情三块只读事实', () => {
  it('读不到详情时明说「未读取」，不拿空白冒充空值', () => {
    const facts = detailFacts(instance(), null);
    const saveRow = facts.paths.find((row) => row.label === '存档根');
    expect(saveRow?.value).toContain('未读取');
    expect(facts.runtime.find((row) => row.label === '解析结果')?.value).toContain('未读取');
  });

  it('有读数时给路径 / 运行时要求 / 程序完整性', () => {
    const facts = detailFacts(instance(), inspection());
    expect(facts.paths[0]).toMatchObject({ label: '游戏目录', value: 'D:/games/a' });
    const runtimeRow = facts.runtime.find((row) => row.label === '指定运行时');
    expect(runtimeRow?.hint).toContain('engine 1.0');
    expect(facts.runtime.find((row) => row.label === '解析结果')?.tone).toBe('warn');
  });

  it('程序被改动 / 文件不存在都进警告档', () => {
    const changed = detailFacts(
      instance(),
      inspection({
        executable: {
          absolutePath: 'D:/games/a/game.exe',
          exists: true,
          sha256: 'b'.repeat(64),
          trusted: false,
          changedSinceTrust: true,
        },
      }),
    );
    const row = changed.trust.find((item) => item.label === '当前程序');
    expect(row?.value).toContain('需重新确认');
    expect(row?.tone).toBe('warn');
  });

  it('从未确认过时信任块第一行就是警告档', () => {
    const facts = detailFacts(instance(), inspection());
    expect(facts.trust[0]).toMatchObject({ label: '确认状态', tone: 'warn' });
  });
});

describe('详情一句「现在能不能启动」', () => {
  it('运行中 / 准备中 / 损坏 / 未确认 / 可以启动', () => {
    expect(detailHeadline(instance(), processStatus({ state: 'running' }))).toContain('正在运行');
    expect(detailHeadline(instance({ state: 'preparing' }), undefined)).toContain('正在准备');
    expect(detailHeadline(instance({ state: 'broken' }), undefined)).toContain('已损坏');
    expect(detailHeadline(instance(), undefined)).toContain('首次启动前需要确认');
    expect(
      detailHeadline(
        instance({
          executableTrust: {
            sha256: 'c'.repeat(64),
            size: 10,
            approvedAt: '2026-10-01T00:00:00.000Z',
            approvedBy: 'native-dialog',
          },
        }),
        undefined,
      ),
    ).toBe('可以启动。');
  });
});
