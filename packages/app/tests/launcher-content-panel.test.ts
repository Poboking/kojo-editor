// @vitest-environment happy-dom
/**
 * 内容包面板（UI-CONTENT 车道）——纯函数逐条 + 渲染冒烟。
 *
 * 纯函数面（`content-panel-model.ts`）点名七件事：计划读数、冲突→选项、决议收集、
 * 任务三态文案、任务订阅/轮询取舍、诊断四组、错误码建议。
 *
 * 渲染面沿用 `launcher-view.render.test.ts` 的同一基座（happy-dom + `act` + 10 s 墙钟
 * `waitFor`）：空态、有包（卸载确认）、安装全流程（计划 → 决议 → 应用 → 成功）、
 * 诊断分组、错误码人话。断言只断内容与调用，不断实现形状。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ConflictResolution,
  ContentDiagnosis,
  ContentInstallPlan,
  ContentPackManifest,
  InstalledContent,
  LauncherService,
  LauncherTask,
} from '@kojo/plugin-api';
import {
  buildResolutions,
  conflictOptions,
  conflictRows,
  contentErrorAdvice,
  contentRows,
  contentTaskView,
  describeContentFailure,
  diagnosisView,
  moveOrder,
  packKindLabel,
  planReadout,
  rowConfirmText,
  taskWatchMode,
  watchContentTask,
  type ContentTaskTimer,
} from '../src/launcher/content-panel-model';
import { ContentPanel } from '../src/launcher/content-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-26T00:00:00.000Z');
const HASH = 'a'.repeat(64);

/* ══════════════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════════════ */

function manifest(overrides: Partial<ContentPackManifest> = {}): ContentPackManifest {
  return {
    schemaVersion: 1,
    id: 'author.pack-a',
    name: '示例内容包',
    version: '1.0.0',
    kind: 'script',
    gameId: 'game-a',
    files: [{ rootId: 'scripts', path: 'a.erb', sha256: HASH, size: 1024 }],
    loadOrder: 0,
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledContent> = {}): InstalledContent {
  return {
    manifest: manifest(),
    enabled: true,
    order: 0,
    installedAt: '2026-10-01T00:00:00.000Z',
    ownedFiles: [
      { rootId: 'scripts', path: 'a.erb' },
      { rootId: 'scripts', path: 'b.erb' },
    ],
    status: 'ok',
    ...overrides,
  };
}

function planFixture(overrides: Partial<ContentInstallPlan> = {}): ContentInstallPlan {
  return {
    planId: 'plan-1',
    manifest: manifest({
      files: [
        { rootId: 'scripts', path: 'a.erb', sha256: HASH, size: 1024 },
        { rootId: 'scripts', path: 'b.erb', sha256: HASH, size: 512 },
      ],
    }),
    targets: [{ rootId: 'scripts', relativePath: 'pack-a' }],
    additions: [{ rootId: 'scripts', path: 'a.erb' }],
    overwrites: [{ rootId: 'scripts', path: 'b.erb' }],
    conflicts: [
      { rootId: 'scripts', path: 'b.erb', kind: 'other-pack', existingPackId: 'author.pack-b', resolution: 'abort' },
      { rootId: 'scripts', path: 'c.erb', kind: 'base-file', existingPackId: null, resolution: 'abort' },
    ],
    missingRequirements: [],
    warnings: [],
    // 默认相对**真墙钟**给一个未来时刻：渲染冒烟里组件按 `Date.now()` 判过期
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    ...overrides,
  };
}

function task(overrides: Partial<LauncherTask> = {}): LauncherTask {
  return {
    id: 'task-1',
    kind: 'content-install',
    instanceId: 'i-1',
    state: 'running',
    progress: { done: 50, total: 100, unit: 'files', message: '正在写入 scripts/' },
    createdAt: '2026-10-26T00:00:00.000Z',
    startedAt: '2026-10-26T00:00:01.000Z',
    endedAt: null,
    error: null,
    result: null,
    cancellable: true,
    ...overrides,
  };
}

/** 手动推进的定时器：验「轮询兜底」这一条时不必等真墙钟 */
function fakeTimer(): {
  readonly timer: ContentTaskTimer;
  readonly tick: () => void;
  readonly cleared: () => number;
  readonly armed: () => boolean;
} {
  let callback: (() => void) | null = null;
  let clearedCount = 0;
  const timer = {
    setInterval: (fn: () => void) => {
      callback = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      clearedCount += 1;
    },
  } as unknown as ContentTaskTimer;
  return {
    timer,
    tick: () => callback?.(),
    cleared: () => clearedCount,
    armed: () => callback !== null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 名词与计划读数
 * ══════════════════════════════════════════════════════════════════════════════ */
describe('content-panel-model · 名词与计划读数', () => {
  it('包类型逐档有人话；未知值回显原值而不是装作认识', () => {
    expect(packKindLabel('script')).toBe('脚本');
    expect(packKindLabel('resource')).toBe('资源');
    expect(packKindLabel('data')).toBe('数据');
    expect(packKindLabel('plugin')).toBe('插件');
    expect(packKindLabel('bundle')).toBe('整合包');
    expect(packKindLabel('brand-new')).toBe('未知类型（brand-new）');
  });

  it('计划读数：条目 / 字节 / 新增 / 覆盖 / 冲突 逐条来自计划本体', () => {
    const readout = planReadout(planFixture({ expiresAt: new Date(NOW + 90_000).toISOString() }), NOW);
    const row = (label: string): string | undefined => readout.rows.find((r) => r.label === label)?.value;
    expect(readout.title).toBe('示例内容包（1.0.0）');
    expect(readout.subtitle).toContain('author.pack-a');
    expect(readout.subtitle).toContain('脚本');
    expect(readout.subtitle).toContain('scripts');
    expect(readout.entryCount).toBe(2);
    expect(readout.byteTotal).toBe(1536);
    expect(row('条目')).toBe('2 个文件');
    expect(row('体积')).toBe('1.5 KB');
    expect(row('新增')).toBe('1 个');
    expect(row('覆盖')).toBe('1 个');
    expect(row('冲突')).toBe('2 条');
    expect(readout.conflictCount).toBe(2);
    expect(readout.expired).toBe(false);
    expect(readout.expiresText).toContain('还有 1 分 30 秒');
  });

  it('计划过期：expired 置真且读数点名「需重新预检」（过期时刻读不出也算过期）', () => {
    const stale = planReadout(
      planFixture({ expiresAt: new Date(NOW - 5_000).toISOString() }),
      NOW,
    );
    expect(stale.expired).toBe(true);
    expect(stale.expiresText).toContain('计划已过期');
    expect(stale.expiresText).toContain('重新预检');
    expect(stale.rows.find((row) => row.label === '过期')?.tone).toBe('warn');

    const broken = planReadout(planFixture({ expiresAt: 'not-a-date' }), NOW);
    expect(broken.expired).toBe(true);
    expect(broken.expiresText).toContain('过期时刻不可读');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 冲突 → 选项 → 决议
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('content-panel-model · 冲突决议', () => {
  it('撞别的包：只给「跳过 / 替换」（overwrite 不转移归属，核心会拒）', () => {
    const options = conflictOptions({
      rootId: 'scripts',
      path: 'b.erb',
      kind: 'other-pack',
      existingPackId: 'author.pack-b',
      resolution: 'abort',
    });
    expect(options.map((option) => option.action)).toEqual(['skip', 'replace']);
    expect(options[1]?.label).toContain('替换');
  });

  it('撞基础游戏文件：只给「跳过 / 覆盖」（replace 没有「从谁手里拿」的对象）', () => {
    const options = conflictOptions({
      rootId: 'scripts',
      path: 'c.erb',
      kind: 'base-file',
      existingPackId: null,
      resolution: 'abort',
    });
    expect(options.map((option) => option.action)).toEqual(['skip', 'overwrite']);
    expect(options[1]?.label).toContain('覆盖');
  });

  it('冲突行：路径 / 撞谁 / 归属者三件事都写清', () => {
    const rows = conflictRows(planFixture());
    expect(rows.map((row) => row.path)).toEqual(['scripts/b.erb', 'scripts/c.erb']);
    expect(rows[0]?.kindLabel).toContain('别的包');
    expect(rows[0]?.ownerLabel).toContain('author.pack-b');
    expect(rows[1]?.kindLabel).toContain('基础游戏');
    expect(rows[1]?.ownerLabel).toContain('不属于任何已装包');
  });

  it('决议收集：全部决断 ⇒ 按计划顺序给出 ConflictResolution', () => {
    const plan = planFixture();
    const built = buildResolutions(plan, {
      'scripts/b.erb': 'replace',
      'scripts/c.erb': 'overwrite',
    });
    expect(built.pending).toEqual([]);
    expect(built.resolutions).toEqual([
      { rootId: 'scripts', path: 'b.erb', action: 'replace' },
      { rootId: 'scripts', path: 'c.erb', action: 'overwrite' },
    ]);
  });

  it('决议收集：漏一条 / 用了非法动作 ⇒ pending 点名，且不把它当成已决断', () => {
    const plan = planFixture();
    const built = buildResolutions(plan, { 'scripts/b.erb': 'overwrite' });
    expect(built.resolutions).toEqual([]);
    expect(built.pending).toEqual(['scripts/b.erb', 'scripts/c.erb']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 已装列表 / 顺序 / 确认文案
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('content-panel-model · 已装列表与顺序', () => {
  it('列表投影：按 order 排序、位次从 1 起、首尾的移动键置灰、启停与状态双编码', () => {
    const rows = contentRows([
      installed({
        manifest: manifest({ id: 'author.pack-b', name: 'B 包', version: '2.0.0', kind: 'data' }),
        order: 1,
        enabled: false,
        status: 'conflict',
      }),
      installed({ order: 0 }),
    ]);
    expect(rows.map((row) => row.name)).toEqual(['示例内容包', 'B 包']);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(rows[0]?.canMoveUp).toBe(false);
    expect(rows[0]?.canMoveDown).toBe(true);
    expect(rows[1]?.canMoveUp).toBe(true);
    expect(rows[1]?.canMoveDown).toBe(false);
    expect(rows[1]?.enabledLabel).toBe('已停用');
    expect(rows[1]?.enabledTone).toBe('idle');
    expect(rows[1]?.statusLabel).toBe('有冲突');
    expect(rows[1]?.statusTone).toBe('warn');
    expect(rows[1]?.kindLabel).toBe('数据');
    expect(rows[0]?.fileCount).toBe(2);
  });

  it('上移 / 下移给出整份 id 排列；边界返回 null（按钮该是灰的）', () => {
    const packs = [
      installed({ manifest: manifest({ id: 'p1' }), order: 0 }),
      installed({ manifest: manifest({ id: 'p2' }), order: 1 }),
      installed({ manifest: manifest({ id: 'p3' }), order: 2 }),
    ];
    expect(moveOrder(packs, 'p2', -1)).toEqual(['p2', 'p1', 'p3']);
    expect(moveOrder(packs, 'p2', 1)).toEqual(['p1', 'p3', 'p2']);
    expect(moveOrder(packs, 'p1', -1)).toBeNull();
    expect(moveOrder(packs, 'p3', 1)).toBeNull();
    expect(moveOrder(packs, 'nope', 1)).toBeNull();
  });

  it('确认条文案：卸载说清「只删本包写入的文件」，排序说清下次启动生效', () => {
    const uninstall = rowConfirmText({ kind: 'uninstall', name: '示例内容包', fileCount: 2 });
    expect(uninstall).toContain('只删本包写入的 2 个文件');
    expect(uninstall).toContain('别的包或基础游戏写过的同名文件不动');
    expect(uninstall).toContain('游戏存档不受影响');
    expect(rowConfirmText({ kind: 'order', name: 'X', direction: 'up' })).toContain('上移一位');
    expect(rowConfirmText({ kind: 'order', name: 'X', direction: 'down' })).toContain('下移一位');
    expect(rowConfirmText({ kind: 'disable', name: 'X' })).toContain('停用');
    expect(rowConfirmText({ kind: 'enable', name: 'X' })).toContain('启用');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 任务三态文案 + 进度来源
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('content-panel-model · 任务三态', () => {
  it('进行中：标题带动作名、进度读数与百分比都算出来', () => {
    const view = contentTaskView(task());
    expect(view.headline).toBe('正在安装内容包…');
    expect(view.detail).toContain('50 / 100 个文件');
    expect(view.percent).toBe(50);
    expect(view.terminal).toBe(false);
    expect(view.cancellable).toBe(true);
  });

  it('成功 / 失败 / 取消：三态各自说清磁盘上发生了什么', () => {
    const succeeded = contentTaskView(task({ state: 'succeeded' }));
    expect(succeeded.headline).toBe('安装内容包完成');
    expect(succeeded.note).toContain('写盘完成');
    expect(succeeded.terminal).toBe(true);

    const failed = contentTaskView(
      task({ state: 'failed', error: { code: 'LAUNCHER_CONTENT_CONFLICT', message: '还有冲突没有决断', retryable: true } }),
    );
    expect(failed.headline).toBe('安装内容包失败');
    expect(failed.errorText).toBe('还有冲突没有决断');
    expect(failed.note).toContain('回滚');

    const cancelled = contentTaskView(task({ state: 'cancelled' }));
    expect(cancelled.headline).toBe('安装内容包已取消');
    expect(cancelled.note).toContain('没有写入任何文件');
  });

  it('卸载任务用同一套文案但动作名换成卸载', () => {
    expect(contentTaskView(task({ kind: 'content-uninstall', state: 'succeeded' })).headline).toBe(
      '卸载内容包完成',
    );
    expect(contentTaskView(task({ kind: 'content-toggle', state: 'running' })).headline).toBe(
      '正在切换内容包启停…',
    );
  });

  it('进度来源：有推送就订阅，没有就轮询（面板上如实显示这一条）', () => {
    const withPush = { get: () => null, subscribe: () => () => undefined };
    const withoutPush = { get: () => null };
    expect(taskWatchMode(withPush)).toBe('subscribe');
    expect(taskWatchMode(withoutPush as unknown as { subscribe: () => () => undefined })).toBe('poll');
  });

  it('watchContentTask：先补一拍快照，再只转交同 id 的事件', () => {
    const seen: string[] = [];
    const listeners: ((value: LauncherTask) => void)[] = [];
    const off = watchContentTask(
      {
        get: () => task({ id: 'task-1', state: 'queued' }),
        subscribe: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
      },
      'task-1',
      (value) => seen.push(value.state),
    );
    expect(seen).toEqual(['queued']);
    listeners[0]?.(task({ id: 'task-2', state: 'running' }));
    listeners[0]?.(task({ id: 'task-1', state: 'succeeded' }));
    expect(seen).toEqual(['queued', 'succeeded']);
    off();
  });

  it('watchContentTask：服务没有推送能力时退化为轮询，终态快照不再挂定时器', () => {
    const fake = fakeTimer();
    let current = task({ state: 'running' });
    const seen: string[] = [];
    const off = watchContentTask(
      { get: () => current } as unknown as { get: () => LauncherTask | null; subscribe: never },
      'task-1',
      (value) => seen.push(value.state),
      fake.timer,
    );
    expect(seen).toEqual(['running']);
    current = task({ state: 'succeeded' });
    fake.tick();
    expect(seen).toEqual(['running', 'succeeded']);
    off();
    expect(fake.cleared()).toBe(1);

    // 一上来就是终态：不再挂任何定时器
    const terminal = fakeTimer();
    watchContentTask(
      { get: () => task({ state: 'cancelled' }) } as unknown as { get: () => LauncherTask | null; subscribe: never },
      'task-2',
      () => undefined,
      terminal.timer,
    );
    expect(terminal.armed()).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 诊断四组
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('content-panel-model · 诊断分组', () => {
  it('无问题：一行「未发现问题」，四组仍是 0 计数（看得见「查过了」）', () => {
    const view = diagnosisView({ instanceId: 'i-1', issues: [] });
    expect(view.ok).toBe(true);
    expect(view.headline).toBe('未发现问题');
    expect(view.groups.map((group) => group.key)).toEqual(['missing', 'tampered', 'orphan', 'order']);
    expect(view.groups.every((group) => group.items.length === 0)).toBe(true);
  });

  it('四组归类：缺失（含依赖）/ 篡改 / 孤儿 / 顺序异常，计数写进标题', () => {
    const diagnosis: ContentDiagnosis = {
      instanceId: 'i-1',
      issues: [
        { packId: 'p1', code: 'missing-file', path: 'a.erb', message: '文件缺失：a.erb' },
        { packId: 'p1', code: 'missing-dependency', message: '依赖缺失：需要 p2 1.0.0' },
        { packId: 'p1', code: 'hash-mismatch', path: 'b.erb', message: '文件被改动：b.erb' },
        { packId: 'p2', code: 'conflict', path: 'c.erb', message: '孤儿文件：c.erb' },
        { packId: 'p2', code: 'conflict', message: '启用顺序异常：与 p1 并列在 0' },
      ],
    };
    const view = diagnosisView(diagnosis);
    expect(view.ok).toBe(false);
    expect(view.issueCount).toBe(5);
    const byKey = new Map(view.groups.map((group) => [group.key, group]));
    expect(byKey.get('missing')?.items).toHaveLength(2);
    expect(byKey.get('tampered')?.items).toHaveLength(1);
    expect(byKey.get('orphan')?.items).toHaveLength(1);
    expect(byKey.get('order')?.items).toHaveLength(1);
    expect(view.headline).toContain('共检出 5 项内容问题');
    expect(view.headline).toContain('缺失 2');
    expect(view.headline).toContain('篡改 1');
    expect(view.headline).toContain('孤儿 1');
    expect(view.headline).toContain('顺序 1');
    // 每组都有人话解释与下一步（不是一张只有计数的表）
    for (const group of view.groups) {
      expect(group.explanation.length).toBeGreaterThan(4);
      expect(group.nextStep.length).toBeGreaterThan(4);
    }
  });

  it('对不上任何前缀的 conflict 进「其它冲突」组，不静默丢弃', () => {
    const view = diagnosisView({
      instanceId: 'i-1',
      issues: [{ packId: 'p1', code: 'conflict', path: 'd.erb', message: '归属冲突：d.erb' }],
    });
    expect(view.groups.map((group) => group.key)).toEqual(['missing', 'tampered', 'orphan', 'order', 'other']);
    expect(view.groups[4]?.items[0]?.message).toContain('归属冲突');
    expect(view.headline).toContain('其它 1');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 错误码 → 人话 + 下一步
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('content-panel-model · 错误建议', () => {
  it('四类内容错误的「为什么 + 下一步」都在（码与原文不在这一层改写）', () => {
    const conflict = contentErrorAdvice('LAUNCHER_CONTENT_CONFLICT');
    expect(conflict?.heading).toContain('文件冲突');
    expect(conflict?.nextStep).toContain('重新预检');

    const busy = contentErrorAdvice('LAUNCHER_TASK_BUSY');
    expect(busy?.heading).toContain('正忙');
    expect(busy?.explanation).toContain('不排队');

    const notApproved = contentErrorAdvice('LAUNCHER_SOURCE_NOT_APPROVED');
    expect(notApproved?.nextStep).toContain('逐根批准');

    const unsupported = contentErrorAdvice('LAUNCHER_PLATFORM_UNSUPPORTED');
    expect(unsupported?.explanation).toContain('launcher_content_');
    expect(unsupported?.nextStep).toContain('继续编辑');
  });

  it('其余码与空码不给建议（原样显示 code 由调用方负责）', () => {
    expect(contentErrorAdvice('LAUNCHER_INTERNAL')).toBeNull();
    expect(contentErrorAdvice(null)).toBeNull();
    expect(contentErrorAdvice(undefined)).toBeNull();
  });

  it('结构化错误：标题按动作分档、码原样、建议接上；非结构化不伪造错误码', () => {
    const shaped = describeContentFailure(
      { code: 'LAUNCHER_TASK_BUSY', message: '该实例正在写盘', detail: 'plan=plan-1', retryable: true },
      'uninstall',
    );
    expect(shaped.title).toBe('卸载失败');
    expect(shaped.code).toBe('LAUNCHER_TASK_BUSY');
    expect(shaped.message).toBe('该实例正在写盘');
    expect(shaped.detail).toBe('plan=plan-1');
    expect(shaped.retryable).toBe(true);
    expect(shaped.advice?.heading).toContain('正忙');

    const raw = describeContentFailure(new Error('宿主连接断了'), 'diagnose');
    expect(raw.title).toBe('内容诊断失败');
    expect(raw.code).toBeNull();
    expect(raw.message).toBe('宿主连接断了');
    expect(raw.retryable).toBe(false);
    expect(raw.advice).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 渲染冒烟
 * ══════════════════════════════════════════════════════════════════════════════ */

interface FakeOptions {
  readonly packs?: readonly InstalledContent[];
  readonly listError?: unknown;
  readonly picker?: () => Promise<string | null>;
  readonly plan?: () => Promise<ContentInstallPlan>;
  readonly apply?: (planId: string, resolutions?: readonly ConflictResolution[]) => Promise<LauncherTask>;
  readonly uninstall?: (instanceId: string, packId: string) => Promise<LauncherTask>;
  readonly setOrder?: (instanceId: string, packIds: readonly string[]) => Promise<void>;
  readonly diagnose?: () => Promise<ContentDiagnosis>;
}

interface Harness {
  readonly service: LauncherService;
  readonly applied: { planId: string; resolutions?: readonly ConflictResolution[] }[];
  readonly orders: (readonly string[])[];
  readonly uninstalled: string[];
  readonly pushTask: (value: LauncherTask) => void;
}

function fakeService(options: FakeOptions = {}): Harness {
  const packs = [...(options.packs ?? [])];
  const instances = new Map<string, LauncherTask>();
  const listeners = new Set<(value: LauncherTask) => void>();
  const applied: { planId: string; resolutions?: readonly ConflictResolution[] }[] = [];
  const orders: (readonly string[])[] = [];
  const uninstalled: string[] = [];

  const service = {
    content: {
      list: async () => {
        if (options.listError !== undefined) throw options.listError;
        return [...packs];
      },
      planInstall: async () => {
        if (options.plan === undefined) throw new Error('测试壳不实现预检');
        return options.plan();
      },
      applyInstall: async (planId: string, resolutions?: readonly ConflictResolution[]) => {
        applied.push({ planId, ...(resolutions === undefined ? {} : { resolutions }) });
        if (options.apply === undefined) throw new Error('测试壳不实现应用');
        return options.apply(planId, resolutions);
      },
      uninstall: async (instanceId: string, packId: string) => {
        uninstalled.push(`${instanceId}/${packId}`);
        if (options.uninstall === undefined) throw new Error('测试壳不实现卸载');
        return options.uninstall(instanceId, packId);
      },
      setEnabled: async () => task({ kind: 'content-toggle', state: 'succeeded' }),
      setOrder: async (_instanceId: string, packIds: readonly string[]) => {
        orders.push(packIds);
        if (options.setOrder !== undefined) await options.setOrder(_instanceId, packIds);
      },
      diagnose: async () => {
        if (options.diagnose === undefined) throw new Error('测试壳不实现诊断');
        return options.diagnose();
      },
    },
    tasks: {
      list: () => [...instances.values()],
      get: (id: string) => instances.get(id) ?? null,
      cancel: async () => undefined,
      subscribe: (listener: (value: LauncherTask) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as LauncherService;

  return {
    service,
    applied,
    orders,
    uninstalled,
    pushTask: (value: LauncherTask) => {
      instances.set(value.id, value);
      for (const listener of [...listeners]) listener(value);
    },
  };
}

describe('ContentPanel 渲染冒烟', () => {
  let container: HTMLElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = undefined;
  });

  function text(): string {
    return container.textContent ?? '';
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** 墙钟预算 10 s（满池并行时定时器会被抢占；断言仍只断内容） */
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw new Error(`等待超时（10 s）：${label}`);
  }

  function buttonByText(label: string, scope: ParentNode = container): HTMLButtonElement {
    const found = [...scope.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === label,
    );
    if (found === undefined) throw new Error(`找不到按钮「${label}」`);
    return found;
  }

  async function click(button: HTMLButtonElement | null | undefined): Promise<void> {
    if (button === null || button === undefined) throw new Error('要点的按钮不存在');
    await act(async () => {
      button.click();
    });
    await settle();
  }

  async function mount(service: LauncherService, onPickArchive?: () => Promise<string | null>): Promise<void> {
    const props = onPickArchive === undefined
      ? { service, instanceId: 'i-1' }
      : { service, instanceId: 'i-1', onPickArchive };
    root = createRoot(container);
    await act(async () => {
      root!.render(h(ContentPanel, props));
    });
    await waitFor(() => !text().includes('读取中…'), '已装列表离开读取态');
    await settle();
  }

  it('空态：引导安装；没有 onPickArchive 就禁用按钮并写明「宿主未提供选择器」', async () => {
    await mount(fakeService().service);

    expect(text()).toContain('还没有安装内容包');
    expect(text()).toContain('预检');
    const pick = buttonByText('选择安装包…');
    expect(pick.disabled).toBe(true);
    expect(text()).toContain('宿主未提供选择器');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('有包：名称 / 版本 / 类型 / 启停 / 顺序都在；卸载要确认且说清只删本包写入的文件', async () => {
    const harness = fakeService({
      packs: [
        installed({ order: 0 }),
        installed({
          manifest: manifest({ id: 'author.pack-b', name: 'B 包', version: '2.0.0', kind: 'data' }),
          order: 1,
          enabled: false,
        }),
      ],
      uninstall: async () => task({ id: 'task-u', kind: 'content-uninstall', state: 'succeeded' }),
    });
    await mount(harness.service, async () => null);

    const rows = [...container.querySelectorAll('.launcher-content-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('示例内容包');
    expect(rows[0]?.textContent).toContain('1.0.0');
    expect(rows[0]?.textContent).toContain('脚本');
    expect(rows[0]?.textContent).toContain('已启用');
    expect(rows[0]?.textContent).toContain('顺序 1');
    expect(rows[1]?.textContent).toContain('已停用');
    // 首行不能上移、末行不能下移（按钮灰而不是点了没反应）
    expect(buttonByText('上移', rows[0]).disabled).toBe(true);
    expect(buttonByText('下移', rows[1]).disabled).toBe(true);

    // 卸载：先出确认条，确认后才发命令
    await click(buttonByText('卸载', rows[0]));
    expect(harness.uninstalled).toEqual([]);
    expect(text()).toContain('只删本包写入的 2 个文件');
    expect(text()).toContain('游戏存档不受影响');
    await click(buttonByText('确认'));
    expect(harness.uninstalled).toEqual(['i-1/author.pack-a']);
    await waitFor(() => text().includes('卸载内容包完成'), '卸载任务收尾');
  });

  it('安装全流程：计划读数 → 逐条决议 → 应用 → 任务进度 → 成功', async () => {
    const harness = fakeService({
      packs: [],
      plan: async () => planFixture(),
      apply: async () => task({ id: 'task-i', state: 'running' }),
    });
    await mount(harness.service, async () => 'C:/packs/pack-a.zip');

    await click(buttonByText('选择安装包…'));
    await waitFor(() => container.querySelector('.launcher-content-plan-head') !== null, '计划卡片出现');

    const facts = container.querySelector('.launcher-content-facts')?.textContent ?? '';
    expect(facts).toContain('2 个文件');
    expect(facts).toContain('1.5 KB');
    expect(facts).toContain('2 条');
    expect(facts).toContain('计划还有');
    expect(text()).toContain('冲突（2 条）');

    // 两条冲突各自都有合法选项（撞别的包 ⇒ 替换；撞基础文件 ⇒ 覆盖）
    const conflicts = [...container.querySelectorAll('.launcher-content-conflict')];
    expect(conflicts).toHaveLength(2);
    expect(buttonByText('替换（接管归属）', conflicts[0]).disabled).toBe(false);
    expect(buttonByText('覆盖（先备份）', conflicts[1]).disabled).toBe(false);

    // 没决断之前不能安装
    expect(buttonByText('开始安装').disabled).toBe(true);
    await click(buttonByText('替换（接管归属）', conflicts[0]));
    await click(buttonByText('覆盖（先备份）', conflicts[1]));
    expect(buttonByText('开始安装').disabled).toBe(false);

    await click(buttonByText('开始安装'));
    await waitFor(() => harness.applied.length === 1, 'apply 发出');
    expect(harness.applied[0]).toEqual({
      planId: 'plan-1',
      resolutions: [
        { rootId: 'scripts', path: 'b.erb', action: 'replace' },
        { rootId: 'scripts', path: 'c.erb', action: 'overwrite' },
      ],
    });
    expect(text()).toContain('正在安装内容包…');
    expect(text()).toContain('50 / 100 个文件');
    expect(text()).toContain('任务中心订阅');
    expect(container.querySelector('progress')).not.toBeNull();

    await act(async () => {
      harness.pushTask(
        task({ id: 'task-i', state: 'succeeded', progress: { done: 100, total: 100, unit: 'files', message: '' } }),
      );
    });
    await settle();
    expect(text()).toContain('安装内容包完成');
    expect(text()).toContain('写盘完成');
  });

  it('诊断：分组与计数上屏；四组都有人话解释', async () => {
    const harness = fakeService({
      packs: [installed()],
      diagnose: async () => ({
        instanceId: 'i-1',
        issues: [
          { packId: 'author.pack-a', code: 'missing-file', path: 'a.erb', message: '文件缺失：a.erb' },
          { packId: 'author.pack-a', code: 'hash-mismatch', path: 'b.erb', message: '文件被改动：b.erb' },
          { packId: 'author.pack-a', code: 'conflict', path: 'c.erb', message: '孤儿文件：c.erb' },
        ],
      }),
    });
    await mount(harness.service, async () => null);

    await click(buttonByText('诊断'));
    await waitFor(() => container.querySelector('.launcher-content-diagnosis') !== null, '诊断结果出现');

    const groups = [...container.querySelectorAll('.launcher-content-group')];
    expect(groups.map((group) => group.getAttribute('data-group'))).toEqual([
      'missing',
      'tampered',
      'orphan',
      'order',
    ]);
    expect(groups[0]?.textContent).toContain('缺失');
    expect(groups[0]?.textContent).toContain('1 项');
    expect(groups[0]?.textContent).toContain('文件缺失：a.erb');
    expect(groups[1]?.textContent).toContain('篡改');
    expect(groups[2]?.textContent).toContain('孤儿');
    expect(groups[3]?.textContent).toContain('0 项');
    expect(text()).toContain('共检出 3 项内容问题');
  });

  it('LAUNCHER_TASK_BUSY：错误码原样上屏 + 「为什么 + 下一步」，排序按钮不被静默吞掉', async () => {
    const harness = fakeService({
      packs: [installed({ order: 0 }), installed({ manifest: manifest({ id: 'author.pack-b', name: 'B 包' }), order: 1 })],
      setOrder: async () => {
        throw { code: 'LAUNCHER_TASK_BUSY', message: '该实例正在写盘', retryable: true };
      },
    });
    await mount(harness.service, async () => null);

    const rows = [...container.querySelectorAll('.launcher-content-row')];
    await click(buttonByText('上移', rows[1]));
    expect(text()).toContain('上移一位');
    await click(buttonByText('确认'));

    await waitFor(() => container.querySelector('[role="alert"]') !== null, '错误条出现');
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('调整加载顺序失败');
    expect(alert).toContain('LAUNCHER_TASK_BUSY');
    expect(alert).toContain('该实例正在写盘');
    expect(alert).toContain('这个实例正忙');
    expect(alert).toContain('按上面的建议处理后可以重试');
    expect(harness.orders).toEqual([['author.pack-b', 'author.pack-a']]);
  });
});
