/**
 * 内容包编排（契约 §6.6 `ContentManager`；规格 §10.1 / §10.2 / §10.3 / §9.1）。
 *
 * ## 本层做什么、不做什么
 *
 * 解包、暂存、写盘、备份、回滚、ownership 落盘**全在宿主**（§7.2 的 `launcher_content_*`）。
 * 这里只做四件事：
 * 1. **只读预检的裁决**：计划过期、目标根授权、清单与限额、路径闸、包内大小写碰撞、
 *    计划与清单逐条对账——全部是「不动盘就能判」的拒绝面；
 * 2. **两阶段之间的记账**：`planId → (instanceId, 计划)` 只在本层存活，`apply` 一次性消费；
 * 3. **每实例单飞**：第二次并发的变更在**发宿主命令之前**就被拒（`LAUNCHER_TASK_BUSY`），
 *    不排进队列——排队会让 UI 以为「点了两次就是装两次」。锁的**真源是
 *    `instance-lock.ts`**：本层与插件门禁共用同一把（同一实例同一时刻只许一条写盘链），
 *    本文件不再自持锁表；
 * 4. **任务与取消语义**：把宿主返回的任务认领进 `TaskCenter`（进度、可取消），取消时让宿主
 *    回滚并把任务落 `cancelled`；本层**从不写 ownership**，所以「取消后已落盘」不可能发生
 *    在本层手里。
 *
 * ## 三条硬边界（与 `index.ts` 文件头同源）
 *
 * - 本文件不 import `node:fs`，也不拼绝对路径：落点只有「根 id + 根内相对路径」一种形态；
 * - 限额**不抄数字**：缺省取 `ZIP_EXTRACT_LIMITS`（`zip.ts` 单源），逐调用可用 `opts.limits`
 *   换档；路径闸复用 `zipEntryContractProblem`（与 Rust 解包器逐字同源的那一套）；
 * - 宿主命令缺席 = 如实拒绝（`LAUNCHER_PLATFORM_UNSUPPORTED` 并点名缺哪条命令），
 *   不造假计划、不返回空列表。
 *
 * ## 宿主读数从哪来（L1c 收口：形状只有契约一份）
 *
 * 1. **大小写碰撞**：领域面 `ContentConflict.kind` 只有二分，而 §10.7 要求「大小写折叠冲突
 *    检测」。宿主计划多报一档 `'case-collision'`（带既有文件的实际大小写 `existingPath`，
 *    见契约 `HostContentConflict`），本层**映射**成二分（有 `existingPackId` → `other-pack`，
 *    否则 `base-file`）并追加一条人话 warning。宿主若已自行折叠成二分，本层原样放行。
 * 2. **孤儿文件与启用顺序**：领域面 `ContentDiagnosis` 码表装不下这两档，契约把它们收进
 *    `HostContentIssueCode`（`orphan-file` / `load-order`）。本层映射进 `conflict` 并用人话
 *    `message` 的固定前缀区分；同时给报告加了 `warnings`（附加字段，领域形状不变）。
 * 3. 没有「计划过期 / 计划不存在」的专用码：本层用 `LAUNCHER_INTERNAL` + 具体中文 `message`
 *    （`retryable` 为真），detail 说清要重新预检。
 * 4. 没有「内容包未安装」「顺序参数不合法」「内容根不接受该包类型」的专用码：
 *    分别落到 `LAUNCHER_CONTENT_BROKEN` / `LAUNCHER_CONTENT_CONFLICT` /
 *    `LAUNCHER_CONTENT_CONFLICT`，`message` 覆盖成具体人话。
 * 5. `launcher_content_uninstall` 除 `{ instanceId, packId }` 外还带一个可选 `files`
 *    （契约已收）：那是本层算出的「本包独占」ownership 快照，宿主仍须以 `ownership.json`
 *    复核（纵深防御），不碰别的包写过的同名文件。
 */

import type {
  ConflictResolution,
  ContentConflict,
  ContentDiagnosis,
  ContentFileRef,
  ContentInstallPlan,
  ContentManager,
  ContentPackManifest,
  ContentRootSpec,
  HostContentConflict,
  HostContentDiagnosis,
  HostContentIssue,
  HostContentIssueCode,
  HostContentPlan,
  InstalledContent,
  InstallPlanOptions,
  LauncherErrorCode,
  LauncherInstance,
  LauncherTask,
  ProcessSupervisor,
  TaskCenter,
  ZipContractLimits,
} from '@kojo/plugin-api';
import { ZIP_EXTRACT_LIMITS, zipEntryContractProblem } from '@kojo/plugin-api';
import type { ZipContractCode } from '@kojo/plugin-api';
import { launcherError, normalizeLauncherError } from './errors';
import type { LauncherHostBridge } from './host';
import { InstanceLock } from './instance-lock';
import { isTerminalTaskState } from './task-center';

/* ══════════════════════════════════════════════════════════════════════════════
 * 宿主命令面（形状真源在契约 §7.4；本文件只做**投影与探测**，不持有第二份定义）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * `launcher_content_*` 七条命令的 camelCase 投影（一个方法 = 一条命令，不带任何路径拼装）。
 *
 * 形状**没有第二份**（L1c 收口）：`HostContentPlan` / `HostContentConflict` /
 * `HostContentIssue*` / `HostContentDiagnosis` 都住 `plugin-api/launcher.ts` §7.4，
 * 本文件只把契约上**可选**的 P1 方法收成一组非可选，供调用点探测后使用。
 */
export type ContentHostCommands = Required<
  Pick<
    LauncherHostBridge,
    | 'contentList'
    | 'contentPlan'
    | 'contentApply'
    | 'contentUninstall'
    | 'contentSetEnabled'
    | 'contentSetOrder'
    | 'contentDiagnose'
  >
>;

/** 宿主读数（纯 re-export；名字是本包公开面已用惯的那些，形状只有契约一份） */
export type {
  HostContentConflict,
  HostContentDiagnosis,
  HostContentIssue,
  HostContentIssueCode,
  HostContentPlan,
} from '@kojo/plugin-api';

/** 方法名 → 宿主命令名（报缺失时点名，不让用户对着「未提供该能力」猜） */
const HOST_COMMAND_NAMES: Readonly<Record<keyof ContentHostCommands, string>> = {
  contentList: 'launcher_content_list',
  contentPlan: 'launcher_content_plan',
  contentApply: 'launcher_content_apply',
  contentUninstall: 'launcher_content_uninstall',
  contentSetEnabled: 'launcher_content_set_enabled',
  contentSetOrder: 'launcher_content_set_order',
  contentDiagnose: 'launcher_content_diagnose',
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 诊断报告（契约形状 + 附加字段）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 诊断报告。`issues` 严格守契约码表（消费方的 switch 不会撞到未知码）；
 * `warnings` 是人话汇总——契约没有这个字段，这里是**加性**附加（结构上仍是 `ContentDiagnosis`）。
 */
export interface ContentDiagnosisReport extends ContentDiagnosis {
  /** 人话汇总（一条 issue 一行；UI 可直接贴） */
  readonly warnings: readonly string[];
  readonly checkedAt: string;
}

/** 契约码表（映射的落点；`orphan-file` / `load-order` 没有位置，见缺口 2） */
type ContentIssueCode = ContentDiagnosis['issues'][number]['code'];
type ContentIssue = ContentDiagnosis['issues'][number];

const ISSUE_LABELS: Readonly<Record<HostContentIssueCode, { code: ContentIssueCode; label: string }>> = {
  'missing-file': { code: 'missing-file', label: '文件缺失' },
  'hash-mismatch': { code: 'hash-mismatch', label: '文件被改动' },
  conflict: { code: 'conflict', label: '文件归属冲突' },
  'missing-dependency': { code: 'missing-dependency', label: '依赖缺失' },
  // 缺口 2：契约内容诊断没有孤儿文件 / 启用顺序两档，映射到 `conflict`，
  // 人话前缀把两者区分开（`PluginDiagnosis` 有 `load-order`，内容侧没有）。
  'orphan-file': { code: 'conflict', label: '孤儿文件' },
  'load-order': { code: 'conflict', label: '启用顺序异常' },
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 实现
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ContentManagerOptions {
  /** 宿主桥；内容命令按 `ContentHostCommands` 在调用点探测（缺席即如实拒绝） */
  readonly host: LauncherHostBridge;
  readonly tasks: ContentTaskSink;
  /** 启停 / 卸载前停游戏（§10.3：任何变更前必须先停） */
  readonly processes: ProcessSupervisor;
  /** 取实例快照（组合根接实例库；取不到 = `LAUNCHER_INSTANCE_NOT_FOUND`） */
  readonly getInstance: (instanceId: string) => Promise<LauncherInstance | null>;
  /**
   * 每实例写盘单飞锁。组合根（`index.ts`）**必须**把同一把锁也交给 `PluginManagerImpl`
   * ——那正是「内容包与插件共用一条写盘闸」的装配点；缺席则本层自建一把（单测 / 独立装配），
   * 只保证内容包自身串行。
   */
  readonly lock?: InstanceLock;
  readonly now?: () => number;
}

/**
 * 本层用到的任务中心面：契约的 `TaskCenter` + `adopt`（把宿主任务快照认领进来）。
 * 只声明用到的两件，不复制 `TaskCenterImpl` 的整套写入面。
 */
export interface ContentTaskSink extends TaskCenter {
  adopt(
    task: LauncherTask,
    channel?: { readonly onCancel?: () => void | Promise<void> },
  ): LauncherTask;
}

interface PlanRecord {
  readonly instanceId: string;
  readonly plan: ContentInstallPlan;
}

/** 未在运行 = 无需停，可以继续（§10.3 的「若未运行则继续」；缺口：没有专用码） */
const NOT_RUNNING_CODES: ReadonlySet<LauncherErrorCode> = new Set<LauncherErrorCode>([
  'LAUNCHER_INSTANCE_NOT_FOUND',
  'LAUNCHER_INSTANCE_NOT_READY',
]);

/** 真的「越界」的路径码；其余路径问题归归档不合法（与 `zipEntryContractProblem` 同源） */
const ESCAPE_PATH_CODES: ReadonlySet<ZipContractCode> = new Set<ZipContractCode>([
  'path-dotdot',
  'path-absolute',
  'path-drive',
]);

export class ContentManagerImpl implements ContentManager {
  private readonly host: LauncherHostBridge;
  private readonly tasks: ContentTaskSink;
  private readonly processes: ProcessSupervisor;
  private readonly getInstance: (instanceId: string) => Promise<LauncherInstance | null>;
  private readonly now: () => number;
  private readonly plans = new Map<string, PlanRecord>();
  /** 每实例单飞（与插件门禁同一把，见 `instance-lock.ts`）：instance → 正在进行的计划 / 任务 */
  private readonly lock: InstanceLock;
  /** 锁是自建还是外部注入：外部注入的归组合根 dispose，本层不许替它清表 */
  private readonly ownsLock: boolean;

  constructor(options: ContentManagerOptions) {
    this.host = options.host;
    this.tasks = options.tasks;
    this.processes = options.processes;
    this.getInstance = options.getInstance;
    this.now = options.now ?? Date.now;
    this.ownsLock = options.lock === undefined;
    this.lock = options.lock ?? new InstanceLock({ tasks: options.tasks });
  }

  /* ------------------------------ 契约面 ------------------------------ */

  async list(instanceId: string): Promise<readonly InstalledContent[]> {
    const list = this.cmd('contentList');
    try {
      return await list(instanceId);
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_INTERNAL',
        detail: '读取已装内容失败',
      });
    }
  }

  /**
   * 只读预检。**不碰实例**：宿主解到暂存，本层只裁决。
   *
   * 拒绝面（按判定顺序，先便宜后昂贵）：
   * 宿主能力 → 实例存在 → 计划过期 → 包类型/游戏一致 → 条目数与总字节
   * （`ZIP_EXTRACT_LIMITS` 或逐调用档）→ 目标根授权与 accepts → 路径闸
   * → 包内重复/大小写碰撞 → 计划与清单逐条对账。
   */
  async planInstall(
    instanceId: string,
    archivePath: string,
    opts?: InstallPlanOptions,
  ): Promise<ContentInstallPlan> {
    // 先探能力再问实例：宿主根本没有这条命令时，「实例不存在」是误导性结论
    const plan = this.cmd('contentPlan');
    const instance = await this.requireInstance(instanceId);
    const limits = opts?.limits ?? ZIP_EXTRACT_LIMITS;

    let raw: HostContentPlan;
    try {
      raw = await plan(instanceId, archivePath, { limits });
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_ARCHIVE_INVALID',
        detail: '内容包预检失败',
      });
    }

    const mapped = this.validatePlan(instance, raw, limits);
    this.prunePlans();
    this.plans.set(mapped.planId, { instanceId, plan: mapped });
    return mapped;
  }

  /**
   * 真落盘。**每实例单飞**：同实例第二次并发调用直接 `LAUNCHER_TASK_BUSY`（不排队）。
   *
   * 冲突决议必须**逐条覆盖**计划里的每个冲突：漏一条就整包拒绝（一半决议一半没决议 =
   * 「看起来装上了、其实少了一半文件」）。`replace` 只对 `other-pack` 有意义，
   * `overwrite` 只对 `base-file` 有意义——用错即拒。
   */
  async applyInstall(
    planId: string,
    resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask> {
    const record = this.plans.get(planId);
    if (!record) {
      throw launcherError('LAUNCHER_INTERNAL', {
        message: '安装计划不存在或已失效，请重新预检',
        detail: `planId=${planId}`,
      });
    }
    this.assertPlanFresh(record.plan.expiresAt, planId);
    await this.requireInstance(record.instanceId);
    this.lock.assertFree(record.instanceId, 'content', { planId, action: '内容包安装' });
    if (record.plan.missingRequirements.length > 0) {
      throw launcherError('LAUNCHER_PLUGIN_DEPENDENCY', {
        message: '内容包声明的依赖未满足，已拒绝安装',
        detail: record.plan.missingRequirements.join('、'),
      });
    }
    const decisions = resolveConflicts(record.plan, resolutions);
    const apply = this.cmd('contentApply');

    return this.runTask({
      instanceId: record.instanceId,
      planId,
      fallbackCode: 'LAUNCHER_CONTENT_CONFLICT',
      context: '内容包安装失败',
      start: () => {
        // 计划一次性消费：宿主一旦被叫到，这条 planId 就不再可用（陈旧 applies 的唯一防线）
        this.plans.delete(planId);
        return apply(planId, decisions.length === 0 ? undefined : decisions);
      },
    });
  }

  /**
   * 卸载。只交「本包独占」的 ownership 记录给宿主：
   * 两个包声明了同一路径时（own 冲突），那条路径**不进删除清单**，只记 warning——
   * 删掉它等于替另一个包把一个还在用的文件撤了。
   */
  async uninstall(instanceId: string, packId: string): Promise<LauncherTask> {
    await this.requireInstance(instanceId);
    const packs = await this.list(instanceId);
    const target = packs.find((pack) => pack.manifest.id === packId);
    if (!target) {
      throw launcherError('LAUNCHER_CONTENT_BROKEN', {
        message: '该内容包未安装，或安装记录已损坏',
        detail: `packId=${packId}`,
      });
    }
    const split = splitOwnership(target, packs);
    const commands = this.cmd('contentUninstall');

    return this.runTask({
      instanceId,
      planId: null,
      fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
      context: '内容包卸载失败',
      start: async () => {
        await this.stopGame(instanceId);
        const task = await commands(instanceId, packId, split.removable);
        return split.shared.length === 0
          ? task
          : {
              ...task,
              result: {
                ...(task.result ?? {}),
                sharedPaths: split.shared.map((item) => ({
                  rootId: item.ref.rootId,
                  path: item.ref.path,
                  otherPackId: item.otherPackId,
                })),
              },
            };
      },
    });
  }

  /**
   * 启停。先停游戏再写（§10.3）；宿主失败则原样抛出，**本地不预改任何状态**
   * （`list` 永远读宿主，所以「半截状态」在本层无立锥之地）。
   */
  async setEnabled(instanceId: string, packId: string, enabled: boolean): Promise<LauncherTask> {
    await this.requireInstance(instanceId);
    const packs = await this.list(instanceId);
    if (!packs.some((pack) => pack.manifest.id === packId)) {
      throw launcherError('LAUNCHER_CONTENT_BROKEN', {
        message: '该内容包未安装，无法切换启停',
        detail: `packId=${packId}`,
      });
    }
    const command = this.cmd('contentSetEnabled');

    return this.runTask({
      instanceId,
      planId: null,
      fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
      context: enabled ? '启用内容包失败' : '停用内容包失败',
      start: async () => {
        await this.stopGame(instanceId);
        return command(instanceId, packId, enabled);
      },
    });
  }

  /** 排序：只接受已安装 id 的排列（漏项 / 多项 / 重复 / 未安装 一律拒，不「尽量排」） */
  async setOrder(instanceId: string, packIds: readonly string[]): Promise<void> {
    await this.requireInstance(instanceId);
    const packs = await this.list(instanceId);
    assertPermutation(packIds, packs.map((pack) => pack.manifest.id));
    const command = this.cmd('contentSetOrder');

    // 排序也是写盘（宿主改写 state.json 的 loadOrder）：与安装共用同一把每实例锁
    const hold = this.lock.acquire(instanceId, 'content', { action: '调整加载顺序' });
    try {
      await this.stopGame(instanceId);
      await command(instanceId, packIds);
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
        detail: '调整加载顺序失败',
      });
    } finally {
      this.lock.release(hold);
    }
  }

  /**
   * 只读汇总。宿主给机器读数（缺文件 / 哈希不符 / 冲突 / 孤儿），本层补两件它看不见的事：
   * 依赖是否齐（按已装清单）、启用顺序是否仍有歧义；并统一成人话 `warnings`。
   */
  async diagnose(instanceId: string): Promise<ContentDiagnosis> {
    await this.requireInstance(instanceId);
    const packs = await this.list(instanceId);
    const diagnose = this.cmd('contentDiagnose');

    let raw: HostContentDiagnosis;
    try {
      raw = await diagnose(instanceId);
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
        detail: '内容诊断失败',
      });
    }

    const issues = collectIssues(raw.issues, packs);
    const warnings = issues.map((issue) => `${issue.packId}：${issue.message}`);
    const report: ContentDiagnosisReport = {
      instanceId,
      issues,
      warnings: warnings.length === 0 ? [] : [`共检出 ${warnings.length} 项内容问题`, ...warnings],
      checkedAt: new Date(this.now()).toISOString(),
    };
    return report;
  }

  /** 断订阅（任务快照保留，供 UI 收尾）；自建的单飞锁一并收表（注入的归组合根） */
  dispose(): void {
    this.plans.clear();
    if (this.ownsLock) this.lock.dispose();
  }

  /* ------------------------------ 内部：计划裁决 ------------------------------ */

  /**
   * 宿主计划 → 契约计划的**唯一出口**（所有字段逐条核过才放行）。
   * 核不过即整份拒绝：半信的计划比没有计划更危险（UI 会按它给用户看清单）。
   */
  private validatePlan(
    instance: LauncherInstance,
    raw: HostContentPlan,
    limits: ZipContractLimits,
  ): ContentInstallPlan {
    const manifest = raw.manifest;
    if (!manifest || typeof manifest !== 'object') {
      throw launcherError('LAUNCHER_ARCHIVE_INVALID', { detail: '计划里没有清单' });
    }
    if (manifest.kind === 'plugin') {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '该包是游戏插件，需走插件安装通道',
        detail: `${manifest.id} 的 kind 为 plugin`,
      });
    }
    if (manifest.gameId !== instance.gameId) {
      throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
        message: '内容包声明的游戏与实例不一致，已拒绝',
        detail: `包 ${manifest.gameId} / 实例 ${instance.gameId}`,
      });
    }
    // 计划过期即作废（§10.1：两次预检之间不持有实例锁，只能靠时间界）
    this.assertPlanFresh(raw.expiresAt, raw.planId);
    if (manifest.files.length > limits.maxEntries) {
      throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
        message: '内容包的条目数超出限额，已中止',
        detail: `${manifest.files.length} > ${limits.maxEntries}`,
      });
    }

    const roots = new Map(instance.contentRoots.map((root) => [root.id, root]));
    const seen = new Set<string>();
    const folded = new Map<string, string>();
    let totalBytes = 0;

    for (const file of manifest.files) {
      this.requireRoot(roots, instance, file.rootId, file.path, manifest.kind);
      assertEntryPath(file.rootId, file.path, limits);
      if (!Number.isInteger(file.size) || file.size < 0) {
        throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
          message: '清单里的文件大小不合法，已拒绝',
          detail: `${file.rootId}/${file.path}：${String(file.size)}`,
        });
      }
      const key = refKey(file);
      const exact = `${file.rootId}/${file.path}`;
      if (seen.has(exact)) {
        throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
          message: '清单里同一路径声明了两次，已拒绝',
          detail: exact,
        });
      }
      seen.add(exact);
      const previous = folded.get(key);
      if (previous !== undefined && previous !== file.path) {
        throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
          message: '包内存在仅大小写不同的路径，无法安全落盘',
          detail: `${previous} / ${file.path}（大小写不敏感的文件系统上等价）`,
        });
      }
      folded.set(key, file.path);
      totalBytes += file.size;
    }
    if (totalBytes > limits.maxUnpackedBytes) {
      throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
        message: '内容包解压后的总体积超出限额，已中止',
        detail: `${totalBytes} > ${limits.maxUnpackedBytes}`,
      });
    }

    for (const target of raw.targets) {
      if (!roots.has(target.rootId)) {
        throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
          message: '计划要把文件写进一个未授权的目标根，已拒绝',
          detail: `根 ${target.rootId} 不在实例已声明的内容根内`,
        });
      }
      if (target.relativePath !== '') {
        assertEntryPath(target.rootId, target.relativePath, limits);
      }
    }
    for (const ref of [...raw.additions, ...raw.overwrites, ...raw.conflicts]) {
      if (!roots.has(ref.rootId)) {
        throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
          message: '计划要把文件写进一个未授权的目标根，已拒绝',
          detail: `根 ${ref.rootId} 不在实例已声明的内容根内`,
        });
      }
      assertEntryPath(ref.rootId, ref.path, limits);
    }
    assertPlanMatchesManifest(raw);

    const conflicts = raw.conflicts.map((conflict) => ({
      rootId: conflict.rootId,
      path: conflict.path,
      kind: classifyConflict(conflict),
      existingPackId: conflict.existingPackId,
      resolution: conflict.resolution,
    }));
    const warnings = [...raw.warnings];
    for (const conflict of raw.conflicts) {
      if (conflict.kind !== 'case-collision') continue;
      warnings.push(
        `大小写碰撞：${conflict.rootId}/${conflict.path} 与既有 ` +
          `${conflict.existingPath ?? '同名条目'} 在大小写不敏感的文件系统上等价` +
          (conflict.existingPackId ? `（属于 ${conflict.existingPackId}）` : ''),
      );
    }

    return {
      planId: raw.planId,
      manifest,
      targets: raw.targets,
      additions: raw.additions,
      overwrites: raw.overwrites,
      conflicts,
      missingRequirements: raw.missingRequirements,
      warnings,
      expiresAt: raw.expiresAt,
    };
  }

  /** 目标根本身的三道闸：存在、shared 下已声明可写、accepts 含该包类型（§9.1 / §10.2） */
  private requireRoot(
    roots: ReadonlyMap<string, ContentRootSpec>,
    instance: LauncherInstance,
    rootId: string,
    path: string,
    kind: ContentPackManifest['kind'],
  ): ContentRootSpec {
    const root = roots.get(rootId);
    if (!root) {
      throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
        message: '内容包的目标根不在实例声明的内容根内，已拒绝',
        detail: `${rootId}/${path}`,
      });
    }
    if (instance.isolation === 'shared' && !root.writableInShared) {
      throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
        message: '该内容根在共享实例下未声明可写，需先逐根授权',
        detail: `${root.id}（${root.label}）：${path}`,
      });
    }
    if (!root.accepts.includes(kind)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '目标内容根不接受该类型的包，已拒绝',
        detail: `${root.id} 接受 [${root.accepts.join('、')}]，包类型为 ${kind}`,
      });
    }
    return root;
  }

  private assertPlanFresh(expiresAt: string, planId: string): void {
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) {
      throw launcherError('LAUNCHER_INTERNAL', {
        message: '安装计划缺少有效的过期时间，请重新预检',
        detail: `planId=${planId} expiresAt=${String(expiresAt)}`,
      });
    }
    if (deadline <= this.now()) {
      throw launcherError('LAUNCHER_INTERNAL', {
        message: '安装计划已过期，请重新预检',
        detail: `planId=${planId} 过期于 ${expiresAt}`,
      });
    }
  }

  /** 过期的计划不再占位（`planId → 计划` 只在确认阶段存活） */
  private prunePlans(): void {
    const now = this.now();
    for (const [planId, record] of [...this.plans]) {
      if (Date.parse(record.plan.expiresAt) <= now) this.plans.delete(planId);
    }
  }

  /* ------------------------------ 内部：任务与单飞 ------------------------------ */

  private async runTask(input: {
    readonly instanceId: string;
    readonly planId: string | null;
    readonly fallbackCode: LauncherErrorCode;
    readonly context: string;
    readonly start: () => Promise<LauncherTask>;
  }): Promise<LauncherTask> {
    // 落票在**发宿主命令之前**（挡住「同一瞬间两个请求都过闸」）；票的判据全在 `instance-lock.ts`
    const hold = this.lock.acquire(input.instanceId, 'content', { planId: input.planId });

    let task: LauncherTask;
    try {
      task = await input.start();
    } catch (err) {
      // 失败路径：宿主命令直接抛错 ⇒ 立刻还票，不让一次拒绝卡死整台实例
      this.lock.release(hold);
      throw normalizeLauncherError(err, {
        fallbackCode: input.fallbackCode,
        detail: input.context,
      });
    }

    // 任务 id 记到票上：异步终态（成功 / 失败 / 取消）到达时按它释放
    this.lock.attachTask(hold, task.id);
    this.tasks.adopt(task, {
      onCancel: () => this.cancelHostTask(input.planId, task.id, task),
    });

    const settled = this.tasks.get(task.id) ?? task;
    if (isTerminalTaskState(settled.state)) this.lock.release(hold);
    if (settled.state === 'failed') {
      // 宿主给的码原样透传（`normalizeLauncherError` 只补 detail，不改码）
      throw normalizeLauncherError(settled.error ?? launcherError(input.fallbackCode), {
        detail: input.context,
      });
    }
    return settled;
  }

  /**
   * 取消：先让宿主回滚，再把任务落 `cancelled`。
   * 本层从不写 ownership，所以「取消后 ownership 落盘」唯一可能的来源是宿主没回滚干净——
   * 那种情况由宿主的下一条终态快照纠正（终态冻结：迟到的 `succeeded` 不会把 `cancelled` 拉回）。
   * 票由锁的终态订阅按 `taskId` 收回（`adopt` 落 `cancelled` 的同一次广播里完成）。
   */
  private async cancelHostTask(
    planId: string | null,
    taskId: string,
    snapshot: LauncherTask,
  ): Promise<void> {
    await this.host.taskCancel(taskId);
    const latest = this.tasks.get(taskId) ?? snapshot;
    if (isTerminalTaskState(latest.state)) return;
    this.tasks.adopt({
      ...latest,
      state: 'cancelled',
      endedAt: new Date(this.now()).toISOString(),
    });
    if (planId !== null) this.plans.delete(planId);
    this.lock.releaseByTask(taskId);
  }

  /**
   * 停游戏。`ProcessSupervisor.stop` 对已停状态本就幂等（不发宿主命令）；
   * 宿主明确报「没在运行 / 实例没登记」时继续，其余错误照抛（带着它往上走，不猜「大概停了吧」）。
   */
  private async stopGame(instanceId: string): Promise<void> {
    try {
      await this.processes.stop(instanceId);
    } catch (err) {
      const error = normalizeLauncherError(err);
      if (NOT_RUNNING_CODES.has(error.code)) return;
      throw error;
    }
  }

  private async requireInstance(instanceId: string): Promise<LauncherInstance> {
    const instance = await this.getInstance(instanceId);
    if (!instance) {
      throw launcherError('LAUNCHER_INSTANCE_NOT_FOUND', { detail: `实例 ${instanceId} 不存在` });
    }
    return instance;
  }

  /**
   * 取一条宿主内容命令；缺席即如实拒绝（点名缺哪条，不让 UI 以为「这里就是没有」）。
   *
   * 探测看的是**契约上的可选方法**（§7.4 全标 P1）：内核透传层在场时这些方法恒在，
   * 由内核给一句人话；绕过内核的装配（单测 / 旧宿主）仍在这里被点名拦下。
   */
  private cmd<K extends keyof ContentHostCommands>(name: K): ContentHostCommands[K] {
    const fn = this.host[name];
    if (typeof fn !== 'function') {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '当前宿主未提供内容包能力',
        detail: `宿主缺少 ${HOST_COMMAND_NAMES[name]}（P1 命令尚未接通）`,
      });
    }
    return fn.bind(this.host) as ContentHostCommands[K];
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数（冲突决议 / 归属拆分 / 诊断归并）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 根内引用的比较键：大小写折叠（Windows 落盘语义；`Data/A` 与 `data/a` 是同一个文件） */
function refKey(ref: ContentFileRef): string {
  return `${ref.rootId.toLowerCase()}/${ref.path.toLowerCase()}`;
}

/** 契约只认二分；宿主多给的大小写碰撞按「有没有别的包」折进去（缺口 1） */
function classifyConflict(conflict: HostContentConflict): ContentConflict['kind'] {
  if (conflict.kind === 'case-collision') {
    return conflict.existingPackId ? 'other-pack' : 'base-file';
  }
  if (conflict.kind === 'other-pack') {
    return conflict.existingPackId ? 'other-pack' : 'base-file';
  }
  return 'base-file';
}

function assertEntryPath(rootId: string, path: string, limits: ZipContractLimits): void {
  const problem = zipEntryContractProblem(path, limits.maxDepth);
  if (problem === null) return;
  const detail = `${rootId}/${path}（${problem}）`;
  if (problem === 'path-depth') {
    throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
      message: '包内路径层级超出限额，已中止',
      detail,
    });
  }
  if (ESCAPE_PATH_CODES.has(problem)) {
    throw launcherError('LAUNCHER_PATH_ESCAPE', {
      message: '包内路径越出了目标根，已拒绝',
      detail,
    });
  }
  throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
    message: '包内路径不合法，已拒绝',
    detail,
  });
}

/**
 * 计划与清单必须逐条对得上（§10.1：「展示的数量与实际应用必须逐条对得上」）。
 * 少一条 = 有文件被悄悄漏装；多一条 = 要写清单之外的东西。两者都整份拒。
 */
function assertPlanMatchesManifest(raw: HostContentPlan): void {
  const expected = new Map(raw.manifest.files.map((file) => [refKey(file), `${file.rootId}/${file.path}`]));
  const planned = [...raw.additions, ...raw.overwrites, ...raw.conflicts];
  const actual = new Set<string>();
  for (const ref of planned) {
    const key = refKey(ref);
    if (!expected.has(key)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '安装计划要写入清单之外的文件，已拒绝',
        detail: `${ref.rootId}/${ref.path}`,
      });
    }
    if (actual.has(key)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '安装计划里同一文件出现了多次，已拒绝',
        detail: `${ref.rootId}/${ref.path}`,
      });
    }
    actual.add(key);
  }
  if (actual.size !== expected.size) {
    const missing = [...expected.entries()]
      .filter(([key]) => !actual.has(key))
      .map(([, label]) => label);
    throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
      message: '安装计划与清单不一致，已拒绝',
      detail: `清单里这些文件没有出现在计划中：${missing.join('、')}`,
    });
  }
}

/**
 * 逐条决议。漏一条即整份拒绝；`replace` / `overwrite` 用错即拒（`other-pack` 的
 * `overwrite` 不会转移归属，`base-file` 的 `replace` 没有「从谁手里拿」的对象）。
 */
function resolveConflicts(
  plan: ContentInstallPlan,
  resolutions: readonly ConflictResolution[] | undefined,
): readonly ConflictResolution[] {
  const given = new Map<string, ConflictResolution>();
  for (const resolution of resolutions ?? []) {
    const key = refKey(resolution);
    if (given.has(key)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '同一个文件给了多条冲突决议，已拒绝',
        detail: `${resolution.rootId}/${resolution.path}`,
      });
    }
    given.set(key, resolution);
  }
  const out: ConflictResolution[] = [];
  for (const conflict of plan.conflicts) {
    const key = refKey(conflict);
    const decision = given.get(key);
    if (!decision) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '还有冲突没有决断，已中止安装',
        detail: `${conflict.rootId}/${conflict.path}（${conflict.kind}）`,
      });
    }
    if (conflict.kind === 'other-pack' && decision.action === 'overwrite') {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '覆盖别的包写过的文件需用 replace（转移归属）',
        detail: `${conflict.rootId}/${conflict.path}`,
      });
    }
    if (conflict.kind === 'base-file' && decision.action === 'replace') {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '基础游戏文件只能用 overwrite 或 skip',
        detail: `${conflict.rootId}/${conflict.path}`,
      });
    }
    out.push({ rootId: conflict.rootId, path: conflict.path, action: decision.action });
  }
  if (given.size > plan.conflicts.length) {
    const extra = [...given.values()]
      .filter((resolution) => !plan.conflicts.some((conflict) => refKey(conflict) === refKey(resolution)))
      .map((resolution) => `${resolution.rootId}/${resolution.path}`);
    throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
      message: '决议里有计划之外的冲突项，已拒绝',
      detail: extra.join('、'),
    });
  }
  return out;
}

/** 本包独占的 ownership 记录 vs 与别的包共有的路径（共有 = 不删，只记警告） */
function splitOwnership(
  target: InstalledContent,
  packs: readonly InstalledContent[],
): {
  readonly removable: readonly ContentFileRef[];
  readonly shared: readonly { ref: ContentFileRef; otherPackId: string }[];
} {
  const others = new Map<string, string>();
  for (const pack of packs) {
    if (pack.manifest.id === target.manifest.id) continue;
    for (const file of pack.ownedFiles) others.set(refKey(file), pack.manifest.id);
  }
  const removable: ContentFileRef[] = [];
  const shared: { ref: ContentFileRef; otherPackId: string }[] = [];
  const seen = new Set<string>();
  for (const file of target.ownedFiles) {
    const key = refKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    const otherPackId = others.get(key);
    if (otherPackId === undefined) removable.push({ rootId: file.rootId, path: file.path });
    else shared.push({ ref: { rootId: file.rootId, path: file.path }, otherPackId });
  }
  return { removable, shared };
}

/** 排序参数必须是已安装 id 的**排列**：不多、不少、不重（§6.6「只接受已安装 id 的排列」） */
function assertPermutation(packIds: readonly string[], installed: readonly string[]): void {
  const wanted = new Set<string>();
  for (const id of packIds) {
    if (wanted.has(id)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '加载顺序里同一个包出现了两次，已拒绝',
        detail: id,
      });
    }
    wanted.add(id);
  }
  const known = new Set(installed);
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
      message: '加载顺序里有未安装的包，已拒绝',
      detail: unknown.join('、'),
    });
  }
  const missing = installed.filter((id) => !wanted.has(id));
  if (missing.length > 0) {
    throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
      message: '加载顺序漏掉了已安装的包，已拒绝',
      detail: missing.join('、'),
    });
  }
}

/** 宿主诊断 + 本层两次只读核对（依赖齐不齐、启用顺序有没有歧义）→ 契约码表的 issue 表 */
function collectIssues(
  raw: readonly HostContentIssue[],
  packs: readonly InstalledContent[],
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: ContentIssue): void => {
    const key = `${issue.packId}|${issue.code}|${issue.path ?? ''}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const issue of raw) {
    const label = ISSUE_LABELS[issue.code] ?? { code: 'conflict' as ContentIssueCode, label: '内容异常' };
    const text = issue.message.trim();
    push({
      packId: issue.packId,
      code: label.code,
      ...(issue.path === undefined ? {} : { path: issue.path }),
      message: text === '' ? label.label : `${label.label}：${text}`,
    });
  }

  const installed = new Set(packs.map((pack) => pack.manifest.id));
  for (const pack of packs) {
    for (const requirement of pack.manifest.requires ?? []) {
      if (installed.has(requirement.id)) continue;
      push({
        packId: pack.manifest.id,
        code: 'missing-dependency',
        message: `依赖缺失：需要 ${requirement.id} ${requirement.version}`,
      });
    }
  }

  const byOrder = new Map<number, string[]>();
  for (const pack of packs) {
    if (!Number.isInteger(pack.order) || pack.order < 0) {
      push({
        packId: pack.manifest.id,
        code: 'conflict',
        message: `启用顺序异常：order 必须是 ≥0 的整数（当前 ${String(pack.order)}）`,
      });
      continue;
    }
    if (!pack.enabled) continue;
    const group = byOrder.get(pack.order) ?? [];
    group.push(pack.manifest.id);
    byOrder.set(pack.order, group);
  }
  for (const [order, ids] of byOrder) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const others = ids.filter((other) => other !== id);
      push({
        packId: id,
        code: 'conflict',
        message: `启用顺序异常：与 ${others.join('、')} 并列在 ${order}，加载次序不确定`,
      });
    }
  }

  return issues.sort(
    (a, b) =>
      a.packId.localeCompare(b.packId) ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}
