// @vitest-environment happy-dom
/**
 * 启动器 · 实例详情「存档」面板（车道 UI-SAVES）。
 *
 * 两层判据：
 * 1. **纯函数层**（`saves-panel-model.ts`）：分组与排序、时间/大小格式化（缺失说「未记录」）、
 *    任务三态文案、错误码 → 建议、备份来源归类、恢复确认文案（含「先自动备份当前存档，再覆盖」
 *    那一句）、导入预检投影、空态文案；
 * 2. **渲染冒烟**（`saves-panel.tsx`）：空态 / 有备份 / 未授权根 / 错误面 / 导出取消 / 导入三态，
 *    逐条看界面上真的说清了什么，以及命令是否按契约形状下发（`backupCurrent` 默认不下发）。
 *
 * 断言的硬口径：
 * - 默认恢复**不传** `backupCurrent`（缺省归契约）；只有勾了「不保留当前存档」才传 `false`；
 * - shared 未授权根**不给**「确认恢复」按钮（没有「强行恢复」这条路）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LauncherInstance,
  LauncherService,
  LauncherTask,
  RestoreOptions,
  SaveBackup,
  SaveBackupRequest,
  SaveEntry,
  SaveExportRequest,
  SaveImportPlan,
  SaveRootSpec,
} from '@kojo/plugin-api';
import { SavesPanel } from '../src/launcher/saves-panel';
import {
  backupOrigin,
  backupView,
  describeSavesFailure,
  exportNote,
  groupSaves,
  importPlanView,
  restoreConfirm,
  restoreOptions,
  saveEntryView,
  saveSizeText,
  saveTimeText,
  savesEmptyText,
  savesErrorAdvice,
  savesTaskBanner,
  savesTaskPhaseLabel,
  savesTaskTitle,
  savesWarnings,
  sortBackups,
  unapprovedRootLabels,
} from '../src/launcher/saves-panel-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ══════════════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════════════ */

const ROOTS: readonly SaveRootSpec[] = [
  { id: 'manual', label: '手动存档', relativePath: 'save/manual', writableInShared: false },
  { id: 'auto', label: '自动存档', relativePath: 'save/auto', writableInShared: false },
];

function rootOf(id: string): SaveRootSpec {
  const found = ROOTS.find((root) => root.id === id);
  if (found === undefined) throw new Error(`夹具里没有根 ${id}`);
  return found;
}

function entry(overrides: Partial<SaveEntry> = {}): SaveEntry {
  return {
    path: 'slot1.dat',
    rootId: 'manual',
    name: 'slot1',
    bytes: 2048,
    mtimeMs: Date.parse('2026-10-20T08:00:00.000Z'),
    ...overrides,
  };
}

function backup(overrides: Partial<SaveBackup> = {}): SaveBackup {
  return {
    id: 'b-1',
    instanceId: 'i-1',
    createdAt: '2026-10-24T12:00:00.000Z',
    label: '打完第三章',
    bytes: 4096,
    entryCount: 3,
    reason: 'manual',
    ...overrides,
  };
}

function plan(overrides: Partial<SaveImportPlan> = {}): SaveImportPlan {
  return {
    planId: 'plan-1',
    backupId: 'roll-1',
    overwrites: ['slot1.dat'],
    warnings: ['导入包包含 2 个条目、合计 4096 字节', '将覆盖 1 个同名存档'],
    ...overrides,
  };
}

function taskOf(overrides: Partial<LauncherTask> = {}): LauncherTask {
  return {
    id: 'task-1',
    kind: 'save-backup',
    instanceId: 'i-1',
    state: 'running',
    progress: { done: 1, total: 4, unit: 'files', message: '正在打包' },
    createdAt: '2026-10-26T10:00:00.000Z',
    startedAt: '2026-10-26T10:00:01.000Z',
    endedAt: null,
    error: null,
    result: null,
    cancellable: true,
    ...overrides,
  };
}

function instanceOf(overrides: Partial<LauncherInstance> = {}): LauncherInstance {
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
    executable: { relativePath: 'game.exe', args: [], env: {}, windowMode: 'auto', sha256: null },
    runtimeId: null,
    locale: { mode: 'inherit' },
    encoding: { mode: 'auto', fallback: 'utf-8' },
    saveRoots: [...ROOTS],
    contentRoots: [],
    executableTrust: null,
    launchCount: 0,
    lastLaunchedAt: null,
    lastExit: null,
    schemaVersion: 1,
    ...overrides,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数层
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('存档面板 · 按根分组与排序', () => {
  it('声明顺序即分组顺序；宿主多给的根不丢，标签退化为根 id 排在末尾', () => {
    const groups = groupSaves(ROOTS, [entry({ rootId: 'auto', path: 'a.dat' }), entry()], 'copy');

    expect(groups.map((group) => group.rootId)).toEqual(['manual', 'auto']);
    expect(groups[0]?.label).toBe('手动存档');
    expect(groups[0]?.relativePath).toBe('save/manual');
    expect(groups[0]?.entries).toHaveLength(1);

    const withStray = groupSaves(
      [rootOf('manual')],
      [entry(), entry({ rootId: 'stray', path: 'x.dat' })],
      'copy',
    );
    expect(withStray.map((group) => group.rootId)).toEqual(['manual', 'stray']);
    expect(withStray[1]?.label).toBe('stray');
    expect(withStray[1]?.relativePath).toBeNull();
    expect(withStray[1]?.declared).toBe(false);
  });

  it('组内条目：修改时间新的在前，同刻按路径码点，缺失时间垫底', () => {
    const groups = groupSaves(
      [rootOf('manual')],
      [
        entry({ path: 'old.dat', mtimeMs: Date.parse('2026-10-01T00:00:00.000Z') }),
        entry({ path: 'b.dat', mtimeMs: Date.parse('2026-10-20T00:00:00.000Z') }),
        entry({ path: 'a.dat', mtimeMs: Date.parse('2026-10-20T00:00:00.000Z') }),
        entry({ path: 'missing.dat', mtimeMs: 0 }),
      ],
      'copy',
    );
    expect(groups[0]?.entries.map((view) => view.path)).toEqual([
      'a.dat',
      'b.dat',
      'old.dat',
      'missing.dat',
    ]);
    // 缺失时间显示「未记录」，不是 1970 年
    expect(groups[0]?.entries[3]?.time).toBe('未记录');
  });

  it('shared 下没条目的声明根 = 需要逐根授权；copy 档不判，有条目就是可读', () => {
    const entries = [entry({ rootId: 'manual' })];
    const shared = groupSaves(ROOTS, entries, 'shared');
    expect(shared.map((group) => group.access)).toEqual(['readable', 'needs-approval']);
    expect(unapprovedRootLabels(shared)).toEqual(['自动存档']);

    const copy = groupSaves(ROOTS, entries, 'copy');
    expect(copy.map((group) => group.access)).toEqual(['copy', 'copy']);
    expect(unapprovedRootLabels(copy)).toEqual([]);
  });

  it('分组统计：条数与总字节只算真读数（非法字节不参与求和）', () => {
    const groups = groupSaves(
      [rootOf('manual')],
      [entry({ bytes: 1024 }), entry({ path: 'b.dat', bytes: Number.NaN })],
      'copy',
    );
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[0]?.totalBytes).toBe(1024);
  });
});

describe('存档面板 · 时间与大小格式化', () => {
  it('大小：0 照实显示，缺失 / 非法 / 负数一律「未记录」', () => {
    expect(saveSizeText(0)).toBe('0 B');
    expect(saveSizeText(1536)).toBe('1.5 KB');
    expect(saveSizeText(null)).toBe('未记录');
    expect(saveSizeText(undefined)).toBe('未记录');
    expect(saveSizeText(Number.NaN)).toBe('未记录');
    expect(saveSizeText(-3)).toBe('未记录');
  });

  it('时间：ISO 与 epoch 毫秒给同一串本地时间；缺失说「未记录」且不出现 1970', () => {
    const iso = '2026-10-20T08:00:00.000Z';
    const fromIso = saveTimeText(iso, 'zh-CN');
    const fromMs = saveTimeText(Date.parse(iso), 'zh-CN');
    expect(fromIso).toBe(fromMs);
    expect(fromIso).toContain('2026');
    // 本地化格式（不是 `toISOString` 那串带 T/Z 的 UTC）
    expect(fromIso).not.toContain('T');
    expect(fromIso).not.toContain('Z');

    expect(saveTimeText(0)).toBe('未记录');
    expect(saveTimeText(null)).toBe('未记录');
    expect(saveTimeText('')).toBe('未记录');
    expect(saveTimeText('不是时间')).toBe('未记录');
    expect(saveTimeText(-5)).toBe('未记录');
  });

  it('条目投影：名字缺失退化为路径，渲染键按根 + 路径稳定', () => {
    const view = saveEntryView(entry({ name: '   ' }), 'zh-CN');
    expect(view.name).toBe('slot1.dat');
    expect(view.key).toBe('manual/slot1.dat');
    expect(view.size).toBe('2.0 KB');
    expect(view.time).toContain('2026');
  });
});

describe('存档面板 · 备份来源与排序', () => {
  it('四档 reason 归类：manual 手动，其余三档自动但各说清是哪一次', () => {
    expect(backupOrigin('manual')).toMatchObject({ kind: 'manual', label: '手动' });
    expect(backupOrigin('auto')).toMatchObject({ kind: 'auto', label: '自动' });
    expect(backupOrigin('pre-restore')).toMatchObject({ kind: 'auto', label: '自动' });
    expect(backupOrigin('pre-plugin')).toMatchObject({ kind: 'auto', label: '自动' });
    // 回退点与普通自动备份必须能分辨（用户找的是「恢复前那份」）
    expect(backupOrigin('pre-restore').detail).toContain('恢复前');
    expect(backupOrigin('pre-plugin').detail).toContain('装插件前');
    expect(new Set([backupOrigin('auto').detail, backupOrigin('pre-restore').detail]).size).toBe(2);
  });

  it('未知来源不吞：回显原值并声明只影响显示', () => {
    const origin = backupOrigin('some-future-reason' as SaveBackup['reason']);
    expect(origin.kind).toBe('unknown');
    expect(origin.label).toContain('some-future-reason');
    expect(origin.detail).toContain('只影响显示');
  });

  it('排序：新的在前；时间不可解析的垫底；同刻按 id', () => {
    const sorted = sortBackups([
      backup({ id: 'b-old', createdAt: '2026-10-01T00:00:00.000Z' }),
      backup({ id: 'b-new', createdAt: '2026-10-25T00:00:00.000Z' }),
      backup({ id: 'b-bad', createdAt: '不是时间' }),
      backup({ id: 'b-tie-a', createdAt: '2026-10-10T00:00:00.000Z' }),
      backup({ id: 'b-tie-b', createdAt: '2026-10-10T00:00:00.000Z' }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual([
      'b-new',
      'b-tie-a',
      'b-tie-b',
      'b-old',
      'b-bad',
    ]);
  });

  it('备份投影：时间 / 理由 / 大小 / 条目数 / 来源五列都在；空理由不显示空白', () => {
    const view = backupView(backup(), 'zh-CN');
    expect(view.label).toBe('打完第三章');
    expect(view.time).toContain('2026');
    expect(view.size).toBe('4.0 KB');
    expect(view.entryCount).toBe('3 个条目');
    expect(view.origin.kind).toBe('manual');
    expect(backupView(backup({ label: '   ' })).label).toBe('未命名备份');
    // 条目数缺失不编：说「未记录」而不是 0
    expect(backupView(backup({ entryCount: Number.NaN })).entryCount).toBe('条目数未记录');
  });
});

describe('存档面板 · 任务三态', () => {
  it('排队与进行中都算「进行中」这一档，完成 / 失败 / 取消各一档', () => {
    expect(savesTaskPhaseLabel('queued')).toBe('排队中');
    expect(savesTaskPhaseLabel('running')).toBe('进行中');
    expect(savesTaskPhaseLabel('succeeded')).toBe('完成');
    expect(savesTaskPhaseLabel('failed')).toBe('失败');
    expect(savesTaskPhaseLabel('cancelled')).toBe('已取消');
  });

  it('标题用存档名词（不落进「后台任务（save-backup）」那种排障串）', () => {
    expect(savesTaskTitle('save-backup')).toBe('备份存档');
    expect(savesTaskTitle('save-restore')).toBe('恢复存档');
    expect(savesTaskTitle('save-import')).toBe('导入存档');
    expect(savesTaskTitle('download')).toContain('download');
  });

  it('横幅：进度读数复用任务中心口径，失败带原文，终态标明可收起', () => {
    const running = savesTaskBanner(taskOf());
    expect(running.title).toBe('备份存档');
    expect(running.phase).toBe('pending');
    expect(running.terminal).toBe(false);
    expect(running.percent).toBe(25);
    expect(running.detail).toContain('1 / 4 个文件');
    expect(running.detail).toContain('正在打包');

    const failed = savesTaskBanner(
      taskOf({
        state: 'failed',
        error: { code: 'LAUNCHER_TASK_BUSY', message: '同一实例的同类存档操作正在进行', retryable: true },
      }),
    );
    expect(failed.phase).toBe('failed');
    expect(failed.phaseLabel).toBe('失败');
    expect(failed.terminal).toBe(true);
    expect(failed.errorText).toBe('同一实例的同类存档操作正在进行');
    expect(failed.tone).toBe('warn');
  });
});

describe('存档面板 · 错误码 → 为什么 + 下一步', () => {
  const CODES = [
    'LAUNCHER_SOURCE_NOT_APPROVED',
    'LAUNCHER_TASK_BUSY',
    'LAUNCHER_PATH_ESCAPE',
    'LAUNCHER_PLATFORM_UNSUPPORTED',
  ] as const;

  it('四类各给一条，且各不相同（不合并成一句「出错了」）', () => {
    const headings = CODES.map((code) => savesErrorAdvice(code)?.heading ?? '');
    expect(headings.every((heading) => heading !== '')).toBe(true);
    expect(new Set(headings).size).toBe(CODES.length);
    for (const code of CODES) {
      const advice = savesErrorAdvice(code);
      expect(advice?.explanation.length ?? 0).toBeGreaterThan(10);
      expect(advice?.nextStep.length ?? 0).toBeGreaterThan(10);
    }
    expect(savesErrorAdvice('LAUNCHER_TASK_BUSY')?.nextStep).toContain('任务横幅');
    expect(savesErrorAdvice('LAUNCHER_SOURCE_NOT_APPROVED')?.nextStep).toContain('目录对话框');
  });

  it('未知码 / 无码：建议为 null，但码与原文仍原样带出（不改写、不伪造）', () => {
    const known = describeSavesFailure(
      { code: 'LAUNCHER_TASK_BUSY', message: '忙', detail: 'i-1:backup', retryable: true },
      'backup',
    );
    expect(known.title).toBe('新建备份失败');
    expect(known.code).toBe('LAUNCHER_TASK_BUSY');
    expect(known.message).toBe('忙');
    expect(known.detail).toBe('i-1:backup');
    expect(known.retryable).toBe(true);
    expect(known.advice?.heading).toBe('上一件存档操作还没结束');

    const unknown = describeSavesFailure(
      { code: 'LAUNCHER_SAVE_RESTORE_FAILED', message: '写回失败', retryable: false },
      'restore',
    );
    expect(unknown.title).toBe('恢复存档失败');
    expect(unknown.advice).toBeNull();
    expect(unknown.hint.length).toBeGreaterThan(10);

    const shapeless = describeSavesFailure(new Error('原生对话框炸了'), 'pick-archive');
    expect(shapeless.code).toBeNull();
    expect(shapeless.message).toBe('原生对话框炸了');
    expect(shapeless.title).toBe('选择导入包失败');
    expect(shapeless.retryable).toBe(false);
  });
});

describe('存档面板 · 恢复确认', () => {
  it('第一句写清「先自动备份当前存档，再覆盖」，并说清跳过备份的代价', () => {
    const view = restoreConfirm(backup(), groupSaves(ROOTS, [entry()], 'copy'));
    expect(view.title).toContain('打完第三章');
    expect(view.steps[0]).toContain('先自动备份当前存档，再覆盖');
    expect(view.steps[1]).toContain('正在运行');
    expect(view.steps[2]).toContain('回滚');
    expect(view.skipLine).toContain('不保留当前存档');
    expect(view.skipLine).toContain('默认不勾');
    expect(view.blockedReason).toBeNull();
  });

  it('shared 未授权根：明确说「这个存档根还没被批准（要用目录对话框逐根授权）」', () => {
    const groups = groupSaves(ROOTS, [entry({ rootId: 'manual' })], 'shared');
    const view = restoreConfirm(backup(), groups);
    expect(view.blockedReason).toContain('这个存档根还没被批准（要用目录对话框逐根授权）');
    expect(view.blockedReason).toContain('自动存档');
    // 多条未授权根逐枚点名
    const both = groupSaves(
      [
        { id: 'a', label: 'A 根', relativePath: 'a', writableInShared: false },
        { id: 'b', label: 'B 根', relativePath: 'b', writableInShared: false },
      ],
      [],
      'shared',
    );
    expect(restoreConfirm(backup(), both).blockedReason).toContain('A 根、B 根');
  });

  it('restoreOptions：默认不传这个字段，勾选后才传 backupCurrent=false', () => {
    expect(restoreOptions(false)).toBeUndefined();
    const skip = restoreOptions(true);
    expect(skip).toEqual({ backupCurrent: false });
    expect(Object.keys(skip ?? {})).toEqual(['backupCurrent']);
    // 类型面：返回形状就是契约的 RestoreOptions
    const typed: RestoreOptions | undefined = skip;
    expect(typed?.backupCurrent).toBe(false);
  });
});

describe('存档面板 · 导入预检投影', () => {
  it('明说预检不写盘、列覆盖清单、警告原样带出', () => {
    const view = importPlanView(plan(), groupSaves(ROOTS, [entry()], 'copy'));
    expect(view.title).toBe('导入预检结果');
    expect(view.preview).toContain('还没有写回任何存档');
    expect(view.preview).toContain('只读');
    const overwriteRow = view.rows.find((row) => row.label === '覆盖');
    expect(overwriteRow?.value).toBe('1 个同名存档会被覆盖');
    expect(overwriteRow?.tone).toBe('warn');
    expect(view.rows.find((row) => row.label === '覆盖清单')?.value).toBe('slot1.dat');
    expect(view.rows.find((row) => row.label === '回滚快照')?.value).toContain('roll-1');
    expect(view.warnings).toEqual([
      '导入包包含 2 个条目、合计 4096 字节',
      '将覆盖 1 个同名存档',
    ]);
    expect(view.blockedReason).toBeNull();
  });

  it('没有覆盖 ⇒ 明说是新增；shared 未授权根 ⇒ 挡住确认导入', () => {
    const fresh = importPlanView(plan({ overwrites: [] }), groupSaves(ROOTS, [entry()], 'copy'));
    expect(fresh.rows.find((row) => row.label === '覆盖')?.value).toContain('全是新增');
    expect(fresh.rows.some((row) => row.label === '覆盖清单')).toBe(false);

    const blocked = importPlanView(plan(), groupSaves(ROOTS, [entry()], 'shared'));
    expect(blocked.blockedReason).toContain('还没被批准');
  });

  it('导出说明与空态文案：逐根逐条数出范围，空态说清下一步', () => {
    const groups = groupSaves(ROOTS, [entry()], 'shared');
    expect(exportNote(groups)).toContain('2 个存档根');
    expect(exportNote(groups)).toContain('1 个条目');
    expect(exportNote([])).toContain('空包');

    expect(savesEmptyText([], [])).toContain('没有声明存档根');
    expect(savesEmptyText(ROOTS, groups)).toBeNull();
    expect(savesEmptyText(ROOTS, groupSaves(ROOTS, [], 'copy'))).toContain('点「刷新」');
  });
});

describe('存档面板 · 实现侧警告通道', () => {
  it('读得到就原样带出，没有这条方法 / 抛错就是空数组', () => {
    const withWarnings = { warnings: () => ['存档目录「自动存档」尚未获得写入授权，已跳过'] };
    expect(savesWarnings(withWarnings as never, 'i-1')).toEqual([
      '存档目录「自动存档」尚未获得写入授权，已跳过',
    ]);

    expect(savesWarnings({} as never, 'i-1')).toEqual([]);
    expect(
      savesWarnings(
        {
          warnings: () => {
            throw new Error('炸了');
          },
        } as never,
        'i-1',
      ),
    ).toEqual([]);
    expect(savesWarnings({ warnings: () => ['  ', '有效'] } as never, 'i-1')).toEqual(['有效']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 渲染冒烟
 * ══════════════════════════════════════════════════════════════════════════════ */

interface FakeOptions {
  readonly instance?: LauncherInstance | null;
  readonly entries?: readonly SaveEntry[];
  readonly backups?: readonly SaveBackup[];
  readonly listError?: unknown;
  readonly backupError?: unknown;
  readonly restoreError?: unknown;
  readonly importPlan?: SaveImportPlan;
  readonly planError?: unknown;
  readonly applyError?: unknown;
  readonly warnings?: readonly string[];
}

interface Harness {
  readonly service: LauncherService;
  /** 命令序列（`backup` / `restore` / `planImport` / `applyImport`） */
  readonly calls: string[];
  readonly backupRequests: SaveBackupRequest[];
  readonly restoreCalls: readonly { readonly backupId: string; readonly opts: RestoreOptions | undefined }[];
  readonly planPaths: readonly string[];
  readonly appliedPlans: readonly string[];
  readonly listCalls: () => number;
  readonly pushTask: (task: LauncherTask) => void;
}

function fakeService(options: FakeOptions = {}): Harness {
  const calls: string[] = [];
  const backupRequests: SaveBackupRequest[] = [];
  const restoreCalls: { backupId: string; opts: RestoreOptions | undefined }[] = [];
  const planPaths: string[] = [];
  const appliedPlans: string[] = [];
  const listeners = new Set<(next: LauncherTask) => void>();
  let latestTask: LauncherTask | null = null;
  let listCalls = 0;
  const instance = options.instance === undefined ? instanceOf() : options.instance;

  const saves = {
    list: async (): Promise<readonly SaveEntry[]> => {
      listCalls += 1;
      if (options.listError !== undefined) throw options.listError;
      return options.entries ?? [];
    },
    backups: async (): Promise<readonly SaveBackup[]> => options.backups ?? [],
    backup: async (_instanceId: string, req: SaveBackupRequest): Promise<LauncherTask> => {
      calls.push('backup');
      backupRequests.push(req);
      if (options.backupError !== undefined) throw options.backupError;
      latestTask = taskOf();
      return latestTask;
    },
    restore: async (
      _instanceId: string,
      backupId: string,
      opts?: RestoreOptions,
    ): Promise<LauncherTask> => {
      calls.push('restore');
      restoreCalls.push({ backupId, opts });
      if (options.restoreError !== undefined) throw options.restoreError;
      latestTask = taskOf({ id: 'task-restore', kind: 'save-restore' });
      return latestTask;
    },
    removeBackup: async (): Promise<void> => undefined,
    planImport: async (_instanceId: string, archivePath: string): Promise<SaveImportPlan> => {
      calls.push('planImport');
      planPaths.push(archivePath);
      if (options.planError !== undefined) throw options.planError;
      return options.importPlan ?? plan();
    },
    applyImport: async (planId: string): Promise<LauncherTask> => {
      calls.push('applyImport');
      appliedPlans.push(planId);
      if (options.applyError !== undefined) throw options.applyError;
      latestTask = taskOf({ id: 'task-import', kind: 'save-import' });
      return latestTask;
    },
    exportArchive: async (): Promise<string | null> => null,
    ...(options.warnings === undefined ? {} : { warnings: () => options.warnings ?? [] }),
  };

  const service = {
    instances: {
      get: async (): Promise<LauncherInstance | null> => instance,
      list: async () => (instance === null ? [] : [instance]),
      inspect: async () => {
        throw new Error('测试壳不实现详情');
      },
      create: async () => {
        throw new Error('测试壳不实现创建');
      },
      update: async () => {
        throw new Error('测试壳不实现更新');
      },
      remove: async () => undefined,
      duplicate: async () => {
        throw new Error('测试壳不实现复制');
      },
      subscribe: () => () => undefined,
    },
    saves,
    tasks: {
      list: () => (latestTask === null ? [] : [latestTask]),
      get: (id: string) => (latestTask !== null && latestTask.id === id ? latestTask : null),
      cancel: async () => undefined,
      subscribe: (listener: (next: LauncherTask) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    initialize: async () => undefined,
    dispose: async () => undefined,
  } as unknown as LauncherService;

  return {
    service,
    calls,
    backupRequests,
    restoreCalls,
    planPaths,
    appliedPlans,
    listCalls: () => listCalls,
    pushTask: (next: LauncherTask) => {
      latestTask = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

describe('SavesPanel 渲染冒烟', () => {
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

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** 轮询到条件成立（墙钟 10 s 预算，理由同 `launcher-view.render` 的同名工具） */
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

  function text(): string {
    return container.textContent ?? '';
  }

  function buttons(): HTMLButtonElement[] {
    return [...container.querySelectorAll('button')];
  }

  function buttonByText(label: string): HTMLButtonElement {
    const found = buttons().find((button) => (button.textContent ?? '').trim() === label);
    if (found === undefined) throw new Error(`找不到按钮「${label}」`);
    return found;
  }

  function hasButton(label: string): boolean {
    return buttons().some((button) => (button.textContent ?? '').trim() === label);
  }

  async function mount(
    service: LauncherService,
    overrides: {
      readonly isolation?: 'shared' | 'copy';
      readonly onPickArchive?: () => Promise<string | null>;
      readonly onExport?: (req: SaveExportRequest) => Promise<string | null>;
    } = {},
  ): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        h(SavesPanel, {
          service,
          instanceId: 'i-1',
          isolation: overrides.isolation ?? 'copy',
          ...(overrides.onPickArchive === undefined ? {} : { onPickArchive: overrides.onPickArchive }),
          ...(overrides.onExport === undefined ? {} : { onExport: overrides.onExport }),
        }),
      );
    });
    await waitFor(() => !text().includes('正在读取存档'), '存档面板离开装载态');
    await settle();
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
    await settle();
  }

  it('空态：没有存档根时解释为什么、导入导出缺席时按钮禁用并写明原因', async () => {
    const harness = fakeService({ instance: instanceOf({ saveRoots: [] }) });
    await mount(harness.service);

    expect(text()).toContain('没有声明存档根');
    expect(text()).toContain('备份也做不了');
    expect(buttonByText('新建备份').disabled).toBe(true);
    expect(buttonByText('选择导入包…').disabled).toBe(true);
    expect(buttonByText('导出全部存档…').disabled).toBe(true);
    expect(text()).toContain('先由外壳接上');
    expect(text()).toContain('onPickArchive');
    expect(text()).toContain('onExport');
    // 备份列表空态要解释下一步，不是一张空白
    expect(text()).toContain('点「新建备份」');
  });

  it('有备份：五列读数齐全；恢复默认不下发 backupCurrent，勾选后才传 false', async () => {
    const harness = fakeService({
      // 两个声明根都有条目 ⇒ shared 下没有未授权根，恢复按钮该给出来
      entries: [entry(), entry({ rootId: 'auto', path: 'auto1.dat', name: 'auto1' })],
      backups: [
        backup(),
        backup({
          id: 'b-auto',
          label: '恢复前自动备份（打完第三章）',
          reason: 'pre-restore',
          createdAt: '2026-10-25T09:30:00.000Z',
        }),
      ],
    });
    await mount(harness.service, { isolation: 'shared' });

    // 存档列表：根标签 + 相对路径 + 大小 + 时间
    expect(text()).toContain('手动存档');
    expect(text()).toContain('save/manual');
    expect(text()).toContain('2.0 KB');
    expect(text()).toContain('slot1.dat');

    // 备份列表：时间 / 理由 / 大小 / 来源（新的在前）
    const rows = [...container.querySelectorAll('.launcher-saves-backup')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('恢复前自动备份');
    expect(rows[0]?.textContent).toContain('自动');
    expect(rows[0]?.textContent).toContain('恢复前');
    expect(rows[1]?.textContent).toContain('打完第三章');
    expect(rows[1]?.textContent).toContain('手动');
    expect(rows[1]?.textContent).toContain('4.0 KB');
    expect(rows[1]?.textContent).toContain('3 个条目');
    expect(rows[1]?.textContent).toContain('2026');

    // 恢复确认：第一句 + 默认不勾
    await click(buttonByText('恢复…'));
    expect(text()).toContain('先自动备份当前存档，再覆盖');
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);
    await click(buttonByText('确认恢复'));
    expect(harness.restoreCalls).toHaveLength(1);
    // 最新的那份排在第一位（2026-10-25 的自动备份）
    expect(harness.restoreCalls[0]?.backupId).toBe('b-auto');
    // 默认不传 backupCurrent：缺省语义归契约
    expect(harness.restoreCalls[0]?.opts).toBeUndefined();

    // 第二次：勾了「不保留当前存档」才下发 backupCurrent=false
    await click(buttonByText('恢复…'));
    const again = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      again?.click();
    });
    await settle();
    await click(buttonByText('确认恢复'));
    expect(harness.restoreCalls).toHaveLength(2);
    expect(harness.restoreCalls[1]?.opts).toEqual({ backupCurrent: false });
  });

  it('未授权根：写明「这个存档根还没被批准」，恢复面板不给「确认恢复」按钮', async () => {
    const harness = fakeService({ entries: [entry({ rootId: 'manual' })], backups: [backup()] });
    await mount(harness.service, { isolation: 'shared' });

    expect(text()).toContain('这个存档根还没被批准（要用目录对话框逐根授权）');
    expect(text()).toContain('自动存档');

    await click(buttonByText('恢复…'));
    expect(text()).toContain('先自动备份当前存档，再覆盖');
    expect(hasButton('确认恢复')).toBe(false);
    expect(hasButton('取消')).toBe(true);
    expect(harness.restoreCalls).toHaveLength(0);
  });

  it('备份撞上 LAUNCHER_TASK_BUSY：码与原文原样 + 为什么 + 下一步', async () => {
    const harness = fakeService({
      entries: [entry()],
      backupError: {
        code: 'LAUNCHER_TASK_BUSY',
        message: '同一实例的同类存档操作正在进行：i-1:backup',
        detail: 'i-1:backup',
        retryable: true,
      },
    });
    await mount(harness.service);

    await click(buttonByText('新建备份'));

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('LAUNCHER_TASK_BUSY');
    expect(alert?.textContent).toContain('新建备份失败');
    expect(alert?.textContent).toContain('同一实例的同类存档操作正在进行');
    expect(alert?.textContent).toContain('上一件存档操作还没结束');
    expect(alert?.textContent).toContain('等它走到「完成」或「失败」再点一次');
    expect(alert?.textContent).toContain('按上面的建议处理后可以重试');
  });

  it('导出返回 null = 用户取消：只留一行说明，不弹错误条', async () => {
    const harness = fakeService({ entries: [entry()] });
    const exportReqs: SaveExportRequest[] = [];
    await mount(harness.service, {
      onExport: async (req) => {
        exportReqs.push(req);
        return null;
      },
    });

    await click(buttonByText('导出全部存档…'));

    expect(exportReqs).toHaveLength(1);
    // 空请求 = 导出全部存档根（不发任何具体条目，交给 core 取全量）
    expect(exportReqs[0]).toEqual({});
    expect(text()).toContain('已取消导出');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('导入：选包 → 预检（明说不写盘）→ 确认 → 任务三态推进并刷新列表', async () => {
    const harness = fakeService({ entries: [entry()], backups: [] });
    await mount(harness.service, { onPickArchive: async () => 'D:/inbox/save-pack.zip' });

    await click(buttonByText('选择导入包…'));
    await waitFor(() => (container.textContent ?? '').includes('导入预检结果'), '预检结果出现');

    expect(harness.planPaths).toEqual(['D:/inbox/save-pack.zip']);
    expect(text()).toContain('预检是只读的');
    expect(text()).toContain('还没有写回任何存档');
    expect(text()).toContain('1 个同名存档会被覆盖');
    expect(text()).toContain('导入包包含 2 个条目、合计 4096 字节');
    expect(text()).toContain('还没有写盘');

    const listsBefore = harness.listCalls();
    await click(buttonByText('确认导入'));
    expect(harness.appliedPlans).toEqual(['plan-1']);
    expect(harness.calls).toEqual(['planImport', 'applyImport']);
    // 预检面板用掉即收起；任务横幅接上
    expect(text()).not.toContain('导入预检结果');
    expect(text()).toContain('导入存档');
    expect(text()).toContain('进行中');

    await act(async () => {
      harness.pushTask(
        taskOf({
          id: 'task-import',
          kind: 'save-import',
          state: 'succeeded',
          progress: { done: 2, total: 2, unit: 'files', message: '已写回' },
        }),
      );
    });
    await settle();
    expect(text()).toContain('完成');
    // 任务成功 ⇒ 列表重读一次（备份 / 存档都可能变了）
    await waitFor(() => harness.listCalls() > listsBefore, '任务成功后重读列表');
  });
});
