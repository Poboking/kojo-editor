/**
 * 实例库（契约 §6.3）。
 *
 * ## 薄编排的边界（这一节是评审重点）
 *
 * 持久化、路径拼装、`instance.json` 原子写与 `.bak`、`running.lock`、路径规范化与前缀
 * 校验——**全部在宿主**（§7.1 命令表）。本层不 import `node:fs`、不拼绝对路径、不写盘，
 * 它只做四件事：
 * 1. **adapter 调用编排**：`probe` 找候选 → `buildProfile` 编译启动描述 → 连同请求交给
 *    宿主（宿主不认识 adapter，见 `host.ts` 缺口 1）；
 * 2. **缓存**：`list` / `get` / `inspect` 的读结果与变更事件共用一份；实例不是高频数据，
 *    但详情页每次重进都整表重拉是浪费；
 * 3. **`subscribe` 广播**：本层发起的变更立刻广播（UI 手感），宿主回执的同一条变更按
 *    「回声抑制」只吞一次（不因「命令 + 事件」把同一次变更播两遍，见 `applyChange`）；
 * 4. **`inspect` 的语义组装**：宿主给的是**读数**（程序在不在、哈希变没变、运行时解析没），
 *    面向作者的「警告行」是领域语义，住这里——读数转人话不跨层。
 */

import type {
  CreateInstanceRequest,
  GameLaunchAdapter,
  InstanceChange,
  InstanceCreation,
  InstanceInspection,
  InstancePatch,
  InstanceStore,
  LauncherInstance,
  LauncherTask,
  RemoveInstanceOptions,
  Unsubscribe,
} from '@kojo/plugin-api';
import type { LauncherHostBridge } from './host';
import { launcherError, normalizeLauncherError } from './errors';

/**
 * 实例可改字段白名单（与契约 `InstancePatch` 同集）。
 * **结构性不可改**的是 `id` / `sourceRoot` / `isolation` / `gameId`：改这些等于换一个实例，
 * 只能新建。运行时多传的键在这里就被拒（宿主还会再拒一次：闸不嫌多，怕的是只有一道）。
 */
const PATCHABLE_KEYS: ReadonlySet<string> = new Set<keyof InstancePatch>([
  'name',
  'args',
  'env',
  'locale',
  'encoding',
  'executableRelativePath',
  'runtimeId',
  'notes',
  'tags',
]);

export interface InstanceStoreOptions {
  readonly host: LauncherHostBridge;
  /**
   * 按 adapterId 取该游戏的启动面（`GameAdapter.launch`）。
   * 缺席 / 无 `launch` ⇒ 该游戏只能编辑不能启动（§6.1 的缺省语义），创建实例直接报错。
   */
  readonly adapterOf?: (adapterId: string) => GameLaunchAdapter | undefined;
  /** 创建/复制返回的后台任务交给任务中心收养（`InstanceCreation.task` 非空时） */
  readonly adoptTask?: (task: LauncherTask) => void;
  /** 派发前先停进程（`remove` 用）：由组合根接上进程监督 */
  readonly stopIfRunning?: (instanceId: string) => Promise<void>;
}

export class InstanceStoreImpl implements InstanceStore {
  private readonly host: LauncherHostBridge;
  private readonly adapterOf: (adapterId: string) => GameLaunchAdapter | undefined;
  private readonly adoptTask: ((task: LauncherTask) => void) | undefined;
  private readonly stopIfRunning: ((instanceId: string) => Promise<void>) | undefined;
  private readonly cache = new Map<string, LauncherInstance>();
  private readonly listeners = new Set<(change: InstanceChange) => void>();
  /**
   * 回声抑制：本层广播过的变更记一笔，宿主随后推来的同一条（同 kind + 同实例）吞掉一次。
   * 计数而非布尔：同一实例连续两次 `updated` 时，第一条回执只该吞掉一个。
   */
  private readonly pendingEchoes = new Map<string, number>();
  private disposed = false;

  constructor(options: InstanceStoreOptions) {
    this.host = options.host;
    this.adapterOf = options.adapterOf ?? (() => undefined);
    this.adoptTask = options.adoptTask;
    this.stopIfRunning = options.stopIfRunning;
  }

  /* ------------------------------ 契约面 ------------------------------ */

  async list(): Promise<readonly LauncherInstance[]> {
    try {
      const instances = await this.host.instanceList();
      this.cache.clear();
      for (const instance of instances) this.cache.set(instance.id, instance);
      return instances;
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '读取实例列表失败' });
    }
  }

  async get(id: string): Promise<LauncherInstance | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const inspection = await this.host.instanceInspect(id);
      this.cache.set(inspection.instance.id, inspection.instance);
      return inspection.instance;
    } catch (err) {
      const error = normalizeLauncherError(err);
      if (error.code === 'LAUNCHER_INSTANCE_NOT_FOUND') return null;
      throw error;
    }
  }

  async inspect(id: string): Promise<InstanceInspection> {
    let inspection: InstanceInspection;
    try {
      inspection = await this.host.instanceInspect(id);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INSTANCE_NOT_FOUND' });
    }
    this.cache.set(inspection.instance.id, inspection.instance);
    return { ...inspection, warnings: this.assembleWarnings(inspection) };
  }

  /**
   * 创建实例：**adapter 编译启动描述，宿主落盘**。
   *
   * 三步各自守着一条纪律：
   * - `probe` 的候选必须包含 `candidateId`——JS 给不了目标程序路径，只能指一个候选 id；
   * - `buildProfile` 产出 exe 相对路径 / argv / 存档与内容根（游戏侧知识全在 adapter）；
   * - 落盘交给宿主（来源根批准表、前缀校验、copy 任务的排队都在那边）。
   */
  async create(req: CreateInstanceRequest): Promise<InstanceCreation> {
    const adapter = this.adapterOf(req.adapterId);
    if (!adapter) {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        detail: `适配器 ${req.adapterId} 未提供启动能力（只能编辑，不能启动）`,
      });
    }
    let creation: InstanceCreation;
    try {
      const candidates = await adapter.probe(req.sourceRoot);
      if (!candidates.some((candidate) => candidate.id === req.candidateId)) {
        throw launcherError('LAUNCHER_EXECUTABLE_INVALID', {
          detail: `候选 ${req.candidateId} 不在 ${req.sourceRoot} 的探测结果里`,
        });
      }
      const profile = await adapter.buildProfile(req.sourceRoot, req.candidateId, {
        includeSaves: req.includeSaves,
        runtimeId: req.runtimeId ?? null,
        locale: req.locale,
        encoding: req.encoding,
      });
      const created = await this.host.instanceCreate(req, profile);
      creation = { instance: created.instance, task: created.task };
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '创建实例失败' });
    }
    if (creation.task) this.adoptTask?.(creation.task);
    this.cache.set(creation.instance.id, creation.instance);
    this.broadcast({ kind: 'created', instanceId: creation.instance.id });
    return creation;
  }

  async update(id: string, patch: InstancePatch): Promise<LauncherInstance> {
    const offending = Object.keys(patch).filter((key) => !PATCHABLE_KEYS.has(key));
    if (offending.length > 0) {
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: `实例清单的以下字段不可修改：${offending.join('、')}（换实例请新建）`,
      });
    }
    let updated: LauncherInstance;
    try {
      updated = await this.host.instanceUpdate(id, patch);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INSTANCE_NOT_FOUND' });
    }
    this.cache.set(updated.id, updated);
    this.broadcast({ kind: 'updated', instanceId: updated.id });
    return updated;
  }

  async remove(id: string, opts?: RemoveInstanceOptions): Promise<void> {
    try {
      // 先停进程（宿主也会先停一次；这里是 core 侧的显式顺序，避免"删到一半还在写日志"）
      await this.stopIfRunning?.(id);
      await this.host.instanceRemove(id, {
        deleteFiles: opts?.deleteFiles ?? false,
        ...(opts?.keepBackups === undefined ? {} : { keepBackups: opts.keepBackups }),
      });
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INSTANCE_NOT_FOUND' });
    }
    this.cache.delete(id);
    this.broadcast({ kind: 'removed', instanceId: id });
  }

  /** 复制实例（§7.2 标 P1；宿主缺席时如实拒绝，不造空结果） */
  async duplicate(id: string, name?: string): Promise<InstanceCreation> {
    const duplicate = this.host.instanceDuplicate;
    if (!duplicate) {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        detail: '当前宿主未提供实例复制（launcher_instance_duplicate）',
      });
    }
    let creation: InstanceCreation;
    try {
      const created = await duplicate.call(this.host, id, name);
      creation = { instance: created.instance, task: created.task };
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INSTANCE_NOT_FOUND', detail: '复制实例失败' });
    }
    if (creation.task) this.adoptTask?.(creation.task);
    this.cache.set(creation.instance.id, creation.instance);
    this.broadcast({ kind: 'created', instanceId: creation.instance.id });
    return creation;
  }

  subscribe(listener: (change: InstanceChange) => void): Unsubscribe {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ------------------------------ 事件与缓存 ------------------------------ */

  /**
   * `kojo:launcher-instance`：缓存立即失效（下次 `get` 走宿主现取），广播按回声抑制去重。
   *
   * 为什么是「失效」而不是「就地改」：事件只带 `kind` 与实例 id（§7.3），没有整条清单；
   * 拿旧快照 + 猜字段 = 第二份真相。失效是唯一不会漂的处置。
   */
  applyChange(change: InstanceChange): void {
    if (this.disposed) return;
    this.cache.delete(change.instanceId);
    if (this.consumeEcho(change)) return;
    this.notify(change);
  }

  /** 缓存快照（同步；日志服务据此定编码策略，不走一轮 IPC） */
  peek(id: string): LauncherInstance | null {
    return this.cache.get(id) ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.pendingEchoes.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private broadcast(change: InstanceChange): void {
    this.pendingEchoes.set(echoKey(change), (this.pendingEchoes.get(echoKey(change)) ?? 0) + 1);
    this.notify(change);
  }

  private consumeEcho(change: InstanceChange): boolean {
    const key = echoKey(change);
    const pending = this.pendingEchoes.get(key);
    if (pending === undefined || pending <= 0) return false;
    if (pending === 1) this.pendingEchoes.delete(key);
    else this.pendingEchoes.set(key, pending - 1);
    return true;
  }

  private notify(change: InstanceChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // 订阅者异常不影响其它订阅者
      }
    }
  }

  /**
   * 读数 → 面向作者的人话。宿主只报「在不在、变没变、解析没」，**为什么值得在意**是语义。
   */
  private assembleWarnings(inspection: InstanceInspection): readonly string[] {
    const warnings: string[] = [];
    const seen = new Set<string>();
    const push = (text: string): void => {
      if (seen.has(text)) return;
      seen.add(text);
      warnings.push(text);
    };
    for (const warning of inspection.warnings) push(warning);
    if (!inspection.executable.exists) {
      push('目标程序不存在：可能被改名、移动或删除');
    }
    if (inspection.executable.exists && !inspection.executable.trusted) {
      push('目标程序尚未确认：首次启动前会弹出系统确认框');
    }
    if (inspection.executable.changedSinceTrust) {
      push('目标程序在确认之后被修改：启动会被拒绝，需重新确认');
    }
    if (inspection.runtime.required && !inspection.runtime.resolved) {
      push('所需运行时尚未解析：启动可能失败');
    }
    if (inspection.instance.state === 'broken') {
      push('实例状态为「已损坏」：修复前不要安装内容或插件');
    }
    return warnings;
  }
}

function echoKey(change: InstanceChange): string {
  return `${change.kind}:${change.instanceId}`;
}
