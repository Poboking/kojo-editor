/**
 * 插件测试基座：`PluginManagerImpl` + **真** `ContentManagerImpl`（插件把 list / uninstall /
 * setEnabled / setOrder / diagnose 全委托给它，用假的把要证的东西证掉了）+ 真任务中心 + 真进程监督，
 * 底下是一台内存假宿主（`FakeContentHost` 的子类，只补插件侧的两样：暂存视图与函数索引夹具）。
 *
 * 只做接线与固定时钟，不伪造业务：断言点全在 `src/plugin-manager.ts` 与假宿主之间。
 */

import type {
  ContentPackManifest,
  ContentRootSpec,
  ConventionPolicy,
  GamePluginRules,
  LauncherInstance,
  LauncherTask,
  SaveBackup,
  SaveBackupRequest,
  ScriptFunctionDefinition,
} from '@kojo/plugin-api';
import { ContentManagerImpl } from '../../src/content-manager';
import { InstanceLock } from '../../src/instance-lock';
import type { HostPluginPlan, PluginSaveGuard } from '../../src/plugin-manager';
import { PluginManagerImpl } from '../../src/plugin-manager';
import { ProcessSupervisorImpl } from '../../src/process-supervisor';
import { TaskCenterImpl } from '../../src/task-center';
import {
  FakeContentHost,
  makeContentFile,
  makeContentManifest,
  makeContentRoot,
  makeHostContentPlan,
  makeInstance,
  makeStatus,
  makeTask,
} from './fake-host';
import type { HostContentConflict } from '../../src/content-manager';

/** 固定时钟：`2026-10-26T12:00:00Z`（计划默认过期时间远在其后） */
export const PLUGIN_NOW = Date.parse('2026-10-26T12:00:00.000Z');

export const PLUGIN_ARCHIVE = 'C:/tmp/plugin.zip';

/** 一条插件根（`accepts` 必须显式含 `plugin`，否则无处可落） */
export function makePluginRoot(
  id: string,
  kind: ContentRootSpec['kind'] = 'script',
  patch: Partial<ContentRootSpec> = {},
): ContentRootSpec {
  return {
    id,
    label: `插件根 ${id}`,
    relativePath: id,
    kind,
    accepts: kind === 'plugin' ? ['plugin'] : ['plugin', kind],
    writableInShared: false,
    ...patch,
  };
}

/** 一份插件清单（唯一与内容包不同的字段是 `kind: 'plugin'`，其余同源） */
export function makePluginManifest(patch: Partial<ContentPackManifest> = {}): ContentPackManifest {
  return makeContentManifest({
    id: 'demo.plugin',
    name: '演示插件',
    kind: 'plugin',
    gameId: 'demo',
    capabilities: ['add-content'],
    saveImpact: 'none',
    ...patch,
  });
}

export function makePluginRules(patch: Partial<GamePluginRules> = {}): GamePluginRules {
  return {
    roots: [makePluginRoot('plugins')],
    manifestNames: ['pack.json'],
    orderSource: 'manifest',
    requiresRestart: false,
    saveImpact: 'none',
    ...patch,
  };
}

/** 一条函数定义（`path` 用目标根内相对路径，与 adapter 的返回同一口径） */
export function makeFunction(
  name: string,
  path: string,
  line = 1,
  normalizedName = name.toUpperCase(),
): ScriptFunctionDefinition {
  return { name, normalizedName, path, line };
}

/** 存档备份通道（记录调用；可让它失败 / 不落账） */
export class FakeSaveGuard implements PluginSaveGuard {
  readonly calls: SaveBackupRequest[] = [];
  readonly backupsList: SaveBackup[] = [];
  fail = false;
  /** true = 备份任务成功但不落进 `backups()`（演练「备份没落账」） */
  omitFromList = false;
  /** true = 备份任务本身落 failed */
  taskFailed = false;

  async backup(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask> {
    this.calls.push(req);
    if (this.fail) throw { code: 'LAUNCHER_SAVE_RESTORE_FAILED', message: '备份失败' };
    const backupId = `b-${this.backupsList.length + 1}`;
    if (!this.omitFromList) {
      this.backupsList.push({
        id: backupId,
        instanceId,
        createdAt: new Date(PLUGIN_NOW).toISOString(),
        label: req.label ?? '',
        bytes: 1024,
        entryCount: 1,
        reason: req.reason ?? 'manual',
      });
    }
    return makeTask(`t-backup-${backupId}`, {
      kind: 'save-backup',
      instanceId,
      state: this.taskFailed ? 'failed' : 'succeeded',
      startedAt: '2026-10-26T12:00:01.000Z',
      endedAt: '2026-10-26T12:00:02.000Z',
      result: { backupId },
      ...(this.taskFailed
        ? { error: { code: 'LAUNCHER_SAVE_RESTORE_FAILED', message: '备份失败', retryable: true } }
        : {}),
    });
  }

  async backups(_instanceId: string): Promise<readonly SaveBackup[]> {
    return this.backupsList;
  }
}

export interface PluginHarnessOptions {
  readonly rules?: Partial<GamePluginRules>;
  readonly conventionPolicy?: ConventionPolicy;
  /** 实例的游戏版本（`gameVersionOf` 注入口；缺省不注入 = null） */
  readonly gameVersion?: string | null;
  /** 提供基础游戏函数索引（缺省不注入：函数冲突只比对已装插件） */
  readonly baseIndex?: readonly ScriptFunctionDefinition[];
  /** 装插件后回放给 `analyzeFunctions` 的定义表：暂存相对路径 → 定义 */
  readonly functions?: Readonly<Record<string, readonly ScriptFunctionDefinition[]>>;
  /** 覆盖 adapter 的 `analyzeFunctions`（异常路径用） */
  readonly analyze?: GamePluginRules['analyzeFunctions'];
  /** 存档备份通道；`false` = 不装配（演练「没有备份能力」） */
  readonly saves?: false | FakeSaveGuard;
  readonly openProject?: (projectId: string) => Promise<void>;
  readonly instance?: Partial<LauncherInstance>;
}

export interface PluginHarness {
  readonly host: FakeContentHost;
  readonly content: ContentManagerImpl;
  readonly manager: PluginManagerImpl;
  /** 内容包与插件**共用**的那把每实例写盘锁（`index.ts` 装配同形） */
  readonly lock: InstanceLock;
  readonly tasks: TaskCenterImpl;
  readonly processes: ProcessSupervisorImpl;
  readonly instance: LauncherInstance;
  readonly rules: GamePluginRules;
  readonly saves: FakeSaveGuard;
  /** 记一条宿主侧计划（`archivePath` → 计划），并返回 archivePath */
  registerPlan(input: RegisterPlanInput): string;
  /** 装一个插件（plan + apply），返回 apply 的任务 */
  install(input: RegisterPlanInput, opts?: { resolutions?: Parameters<PluginManagerImpl['applyInstall']>[1]; applyOptions?: Parameters<PluginManagerImpl['applyInstall']>[2] }): Promise<LauncherTask>;
  /** 直接往「宿主已装清单」里塞一条（演练重启后 / 用户手放进去的插件） */
  seedHostPack(manifest: ContentPackManifest, patch?: { enabled?: boolean; order?: number; ownedFiles?: readonly { rootId: string; path: string }[] }): void;
  setRunning(running: boolean): void;
  advance(ms: number): void;
  /** 宿主调用次序（只保留整条链里与本批相关的那几条） */
  calls(): readonly string[];
}

export interface RegisterPlanInput {
  readonly manifest: ContentPackManifest;
  readonly archivePath?: string;
  readonly additions?: readonly { readonly rootId: string; readonly path: string }[];
  readonly overwrites?: readonly { readonly rootId: string; readonly path: string }[];
  readonly conflicts?: readonly HostContentConflict[];
  readonly missingRequirements?: readonly string[];
  readonly warnings?: readonly string[];
  readonly planId?: string;
  readonly expiresAt?: string;
  /** `null` = 宿主不回传暂存视图（演练「无法做函数级分析」） */
  readonly staging?: { readonly dir: string; readonly files: Readonly<Record<string, string>> } | null;
}

const ADAPTER_ID = 'demo-adapter';

export function makePluginHarness(options: PluginHarnessOptions = {}): PluginHarness {
  const functions = new Map<string, readonly ScriptFunctionDefinition[]>(
    Object.entries(options.functions ?? {}),
  );
  /** 缺省的分析回调：按暂存相对路径查夹具表（缺省空表 = 真的没有函数定义） */
  const analyze =
    options.analyze ??
    (async (_baseDir: string, files: readonly string[]) =>
      files.flatMap((file) => functions.get(file.replaceAll('\\', '/')) ?? []));
  const rules = makePluginRules({ analyzeFunctions: analyze, ...options.rules });
  const instance = makeInstance({
    id: 'i1',
    gameId: 'demo',
    adapterId: ADAPTER_ID,
    isolation: 'copy',
    contentRoots: rules.roots,
    ...options.instance,
  });
  const host = new FakeContentHost();
  host.instances = [instance];
  let clock = PLUGIN_NOW;
  const now = (): number => clock;
  let seq = 0;
  const tasks = new TaskCenterImpl({ throttleMs: 0, now, newId: () => `t-${++seq}` });
  const processes = new ProcessSupervisorImpl({ host, now });
  // 一把锁、两个服务（L7a 缺口第 7 条的修法）：与 `index.ts` 的装配逐字同形
  const lock = new InstanceLock({ tasks });
  const content = new ContentManagerImpl({
    host,
    tasks,
    processes,
    lock,
    getInstance: async (instanceId) =>
      host.instances.find((item) => item.id === instanceId) ?? null,
    now,
  });
  const saves = options.saves === false ? null : (options.saves ?? new FakeSaveGuard());

  const manager = new PluginManagerImpl({
    content,
    host,
    tasks,
    processes,
    lock,
    getInstance: async (instanceId) =>
      host.instances.find((item) => item.id === instanceId) ?? null,
    pluginRulesOf: (adapterId) => (adapterId === ADAPTER_ID ? rules : undefined),
    conventionPolicyOf: (adapterId) =>
      adapterId === ADAPTER_ID ? options.conventionPolicy : undefined,
    ...(options.baseIndex === undefined
      ? {}
      : { baseFunctionIndexOf: async () => options.baseIndex ?? [] }),
    ...(options.gameVersion === undefined
      ? {}
      : { gameVersionOf: () => options.gameVersion ?? null }),
    ...(saves === null ? {} : { saves }),
    ...(options.openProject === undefined ? {} : { openProject: options.openProject }),
    now,
  });

  const harness: PluginHarness = {
    host,
    content,
    manager,
    lock,
    tasks,
    processes,
    instance,
    rules,
    saves: saves ?? new FakeSaveGuard(),
    registerPlan(input: RegisterPlanInput): string {
      const archivePath = input.archivePath ?? PLUGIN_ARCHIVE;
      const base = makeHostContentPlan({
        manifest: input.manifest,
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        ...(input.additions === undefined ? {} : { additions: input.additions }),
        ...(input.overwrites === undefined ? {} : { overwrites: input.overwrites }),
        ...(input.conflicts === undefined ? {} : { conflicts: input.conflicts }),
        ...(input.missingRequirements === undefined
          ? {}
          : { missingRequirements: input.missingRequirements }),
        ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      const plan: HostPluginPlan =
        input.staging === null
          ? base
          : {
              ...base,
              staging: input.staging ?? {
                dir: `C:/appData/launcher/instances/i1/tmp/${base.planId}`,
                files: Object.fromEntries(
                  input.manifest.files.map((file) => [
                    `${file.rootId}/${file.path}`,
                    file.path,
                  ]),
                ),
              },
            };
      host.planByArchive.set(archivePath, plan);
      return archivePath;
    },
    async install(input, opts): Promise<LauncherTask> {
      const archivePath = harness.registerPlan(input);
      const plan = await manager.planInstall('i1', archivePath);
      return manager.applyInstall(plan.planId, opts?.resolutions, opts?.applyOptions);
    },
    seedHostPack(manifest, patch = {}): void {
      const packs = host.packs.get('i1') ?? [];
      packs.push({
        manifest,
        enabled: patch.enabled ?? true,
        order: patch.order ?? packs.length,
        installedAt: '2026-10-26T00:00:00.000Z',
        ownedFiles: patch.ownedFiles ?? [],
        status: 'ok',
      });
      host.packs.set('i1', packs);
    },
    setRunning(running: boolean): void {
      processes.applySnapshot([
        makeStatus('i1', {
          state: running ? 'running' : 'idle',
          pid: running ? 4242 : null,
          sessionId: running ? 's1' : null,
          startedAt: running ? '2026-10-26T11:59:00.000Z' : null,
        }),
      ]);
    },
    advance(ms: number): void {
      clock += ms;
    },
    calls(): readonly string[] {
      return host.calls;
    },
  };
  return harness;
}

/** 一条插件的待写文件（默认落在 `plugins` 根） */
export function pluginFile(path: string, rootId = 'plugins', size = 8) {
  return makeContentFile(rootId, path, size);
}
