import type {
  EventBus,
  FileIO,
  GameProject,
  Logger,
  ProjectService,
  RecentProject,
  ScopedStorage,
  SlotMap,
  SlotRegistry,
} from '@kojo/plugin-api';
import { AdapterConflictError, ProjectDetectionError, normalizeAdapterDetection } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';

/**
 * 项目服务实现（onboarding 通用骨架）。
 *
 * 内核在此流程中的全部职责：
 *   轮询全部 game.adapter 候选 → detect → 命中者 loadProject（黑盒）→ 广播事件。
 * 内核不了解 CHARA CSV / sav / 口上目录的存在——它们都在适配器内部与 GameProject 字段里。
 *
 * 写权限模型（架构文档 §5.7）：适配器在 GameProject.writablePaths 里**提议**；
 * 用户经 UI 显式批准后调用 approveWritablePaths 持久化；重开项目时若批准记录与
 * 提议一致则自动放行。未经批准一切写入被内核拒绝。
 *
 * 多项目驻留（MCP-PERF-S19，2026-11-07）：TRAE daemon 场景下开项目是序列动作，
 * 每一次切换的旧项目若只靠 GC 回收，驻留规模就没有账本。本服务为**退役项目**
 * 建一张有界驻留档案（LRU，缺省 3，可配）：
 *   - 退役 ≠ 驻留：切换那一拍**逐字执行现行 close 全套语义**（`project.closed` 广播、
 *     写允许域收回、文本缓存释放、各插件与宿主按既有契约清缓存 / 停监视）——当前
 *     项目的世界与引入前逐字节同拍。档案在此之后才接住 `loadProject` 产物。
 *   - 档案里只有可安全重建的派生数据（重新 open 同目录即完整重建）；未保存的作者态
 *     从来不在 GameProject 上（编辑缓冲 / 快照写盘各走宿主与 io 通道），逐出绝不碰盘面。
 *   - 超限逐「最旧非当前」，`project.evicted` 出声（KERNEL_ONLY）。当前项目在结构上
 *     进不了档案（档案只收退役项目）⇒「当前项目绝不逐出」不是纪律是结构。
 *   - 重开驻留目录**仍走完整 detect→loadProject**：适配器服务态（变量字典 / 路由表
 *     等）在 loadProject 里重建，跳读不健全——档案不替代重读盘面，也不省那次重读。
 */

const KEY_RECENT = 'recent-projects';
const KEY_APPROVED = 'approved-writable';
const MAX_RECENT = 10;

/** 驻留上限的存储域键（`_global` 域；宿主/设置页可写，读一次记档，本内核实例内不再变） */
const KEY_RESIDENCY_CAP = 'project-residency-cap';

/** 驻留上限的环境变量名（部署/测试侧兜底；与存储域键分开：一个进 `_global`，一个进进程环境） */
const KEY_ENV_RESIDENCY_CAP = 'KOJO_PROJECT_RESIDENCY_CAP';

/** 缺省驻留上限（含当前项目）：保守 3——4 项目开第 4 个时第 1 个被逐 */
const DEFAULT_PROJECT_RESIDENCY_CAP = 3;

/** 驻留上限硬顶：驻留的每一份都是真内存，上限本身也要有上限 */
const PROJECT_RESIDENCY_CAP_MAX = 16;

/**
 * 上限值消毒：非有限数 / 负数 = 没说（回退下一级来源）；小数向下取整；
 * 超硬顶截到 {@link PROJECT_RESIDENCY_CAP_MAX}。返回 null 表示该来源无效。
 */
function sanitizeResidencyCap(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  if (n < 0) return null;
  return Math.min(n, PROJECT_RESIDENCY_CAP_MAX);
}

/** 一份退役项目驻留档案：只有 loadProject 产物与其身份，无任何盘面句柄 */
interface RetiredProject {
  readonly rootDir: string;
  readonly adapterId: string;
  /** 退役那一拍的 GameProject（可安全重建的派生数据，逐出即交给 GC） */
  readonly project: GameProject;
  readonly retiredAt: number;
}

export interface ProjectServiceDeps {
  slots: SlotRegistry;
  bus: EventBus;
  io: FileIO;
  globalStorage: ScopedStorage;
  log: Logger;
  /** 驻留上限（`CreateKernelOptions.projectResidencyCap` 直通；缺省走存储域 → env → 3） */
  residencyCap?: number;
}

export class ProjectServiceImpl implements ProjectService {
  private currentProject: GameProject | null = null;

  /**
   * 驻留档案（MCP-PERF-S19）：退役项目的 LRU，插入序 = 退役序（档案无「访问」操作，
   * 最旧 = 首个键）。同键覆盖式：同一目录只留最新一份档案。
   */
  private readonly retired = new Map<string, RetiredProject>();

  /** 上限解析缓存：三级来源（启动参数 → 存储域 → env → 缺省）只解析一次 */
  private residencyCapPromise: Promise<number> | null = null;

  constructor(private readonly deps: ProjectServiceDeps) {}

  async open(rootDir: string): Promise<GameProject> {
    const candidates = this.deps.slots.query('game.adapter');
    if (candidates.length === 0) {
      throw new ProjectDetectionError(rootDir, []);
    }

    // 先把「谁认领」全部收齐再决定——detect 是只读探测，loadProject 才可能有副作用。
    const matches: Array<{
      adapterId: string;
      displayName: string;
      evidence: readonly string[];
      adapter: (typeof candidates)[number]['adapter'];
    }> = [];
    for (const entry of candidates) {
      const adapter = entry.adapter;
      try {
        const detection = normalizeAdapterDetection(await adapter.detect(rootDir));
        if (!detection.matched) continue;
        matches.push({
          adapterId: adapter.gameId,
          displayName: adapter.displayName,
          evidence: detection.evidence ?? [],
          adapter,
        });
      } catch (err) {
        this.deps.log.warn(`Adapter '${adapter.gameId}' detect() threw: ${String(err)}`);
      }
    }

    if (matches.length === 0) {
      throw new ProjectDetectionError(rootDir, candidates.map((c) => c.adapter.gameId));
    }
    if (matches.length > 1) {
      this.deps.log.error(
        `Adapter conflict for '${rootDir}': ${matches.map((m) => m.adapterId).join(', ')}`,
      );
      throw new AdapterConflictError(
        rootDir,
        matches.map(({ adapterId, displayName, evidence }) => ({ adapterId, displayName, evidence })),
      );
    }

    const chosen = matches[0]!;
    let project: GameProject;
    try {
      project = await chosen.adapter.loadProject(rootDir);
    } catch (err) {
      throw new Error(`Detection matched but project failed to load: ${chosen.adapterId}: ${String(err)}`);
    }
    if (project.adapterId !== chosen.adapterId) {
      throw new Error(
        `Adapter '${chosen.adapterId}' returned a project tagged '${project.adapterId}'; ` +
          `adapterId must equal gameId (${rootDir})`,
      );
    }

    if (this.currentProject) {
      const retired = this.currentProject;
      // 切换语义逐字：现行 close 全套（事件/写域/文本缓存/各插件清缓存）都在这一拍，
      // 与引入驻留前同序同拍——档案只接住 close 之后的 GameProject 引用。
      await this.close();
      this.parkRetired(retired, project.rootDir);
    }
    // 本次加载是完整重读盘面 ⇒ 目标目录若有旧驻留档案必是过时副本，superseded 出声换代
    //（放在 park 之后：park 键 = 退役目录 ≠ 目标目录——同目录 reload 在 parkRetired 里已被拦）
    this.supersedeRetired(project.rootDir);

    this.currentProject = project;
    await this.enforceResidencyCap();
    await this.pushRecent(project);
    await this.applyApprovedWritable(project);

    this.deps.bus.emit('project.opened', { project });
    this.deps.log.info(
      `Project opened via '${chosen.adapterId}': ${project.rootDir} ` +
        `(${project.charaIndex.size} characters, ${project.kojoPaths.length} kojo roots)`,
    );
    return project;
  }

  async close(): Promise<void> {
    const project = this.currentProject;
    if (!project) return;
    this.currentProject = null;
    // 写权限随项目生命周期收回
    this.deps.io.setWritableRoots([]);
    this.deps.bus.emit('project.closed', { rootDir: project.rootDir });
  }

  current(): GameProject | null {
    return this.currentProject;
  }

  async recent(): Promise<RecentProject[]> {
    const list = (await this.deps.globalStorage.get<RecentProject[]>(KEY_RECENT)) ?? [];
    return list;
  }

  async clearRecent(): Promise<void> {
    await this.deps.globalStorage.delete(KEY_RECENT);
  }

  /** 按归一键移除单条最近记录；不存在时幂等 no-op，其余条目顺序与内容逐字保留 */
  async removeRecent(rootDir: string): Promise<void> {
    const list = (await this.deps.globalStorage.get<RecentProject[]>(KEY_RECENT)) ?? [];
    const target = pathKey(rootDir);
    const kept = list.filter((r) => pathKey(r.rootDir) !== target);
    if (kept.length === list.length) return; // 未命中：不动存储，避免无谓写放大
    await this.deps.globalStorage.set(KEY_RECENT, kept);
  }

  /**
   * 用户批准写权限：立即生效 + 持久化（下次打开同一目录自动放行）。
   * paths 必须是 project.writablePaths 的子集（不允许 UI 越权扩权）。
   */
  async approveWritablePaths(project: GameProject, paths: string[]): Promise<void> {
    const allowed = new Set(project.writablePaths.map((p) => pathKey(p)));
    for (const p of paths) {
      if (!allowed.has(pathKey(p))) {
        throw new Error(`Path '${p}' is not part of the adapter's proposed writable paths`);
      }
    }
    this.deps.io.setWritableRoots(paths);
    const record = (await this.deps.globalStorage.get<Record<string, string[]>>(KEY_APPROVED)) ?? {};
    record[pathKey(project.rootDir)] = paths;
    await this.deps.globalStorage.set(KEY_APPROVED, record);
    this.deps.log.info(`Writable paths approved for ${project.rootDir}: ${paths.join('; ')}`);
  }

  /** 查询某目录是否已有批准记录（UI 用来决定是否弹确认） */
  async approvedWritableFor(rootDir: string): Promise<string[] | null> {
    const record = (await this.deps.globalStorage.get<Record<string, string[]>>(KEY_APPROVED)) ?? {};
    return record[pathKey(rootDir)] ?? null;
  }

  private async applyApprovedWritable(project: GameProject): Promise<void> {
    const approved = await this.approvedWritableFor(project.rootDir);
    if (!approved) return;
    // 批准记录与本次提议一致才自动放行；不一致（游戏更新等）则等待重新确认
    const proposed = new Set(project.writablePaths.map((p) => pathKey(p)));
    const consistent = approved.length === proposed.size && approved.every((p) => proposed.has(pathKey(p)));
    if (consistent) {
      this.deps.io.setWritableRoots(approved);
      this.deps.log.info(`Writable paths restored from previous approval: ${approved.join('; ')}`);
    } else {
      this.deps.log.warn(
        `Stored writable approval for ${project.rootDir} no longer matches the adapter's proposal; ` +
          'waiting for re-confirmation.',
      );
      // 通知宿主重弹批准对话框（此前仅告警 → 宿主无从感知，旧记录场景静默永久只读）
      this.deps.bus.emit('project.writableApprovalMismatch', { rootDir: project.rootDir });
    }
  }

  private async pushRecent(project: GameProject): Promise<void> {
    const list = (await this.deps.globalStorage.get<RecentProject[]>(KEY_RECENT)) ?? [];
    const filtered = list.filter((r) => pathKey(r.rootDir) !== pathKey(project.rootDir));
    filtered.unshift({
      rootDir: project.rootDir,
      adapterId: project.adapterId,
      lastOpenedAt: Date.now(),
    });
    await this.deps.globalStorage.set(KEY_RECENT, filtered.slice(0, MAX_RECENT));
  }

  /* ------------------- 多项目驻留（MCP-PERF-S19） ------------------- */

  /**
   * 退役入档。同目录 reload 不入档（用户明确要求重读盘面，退役副本按定义已过时，
   * 留着只会制造 stale 命中）；同键覆盖式（同一目录只留最新一份档案）。
   * 这里**绝不**再触发任何 close 语义——退役那一拍已逐字执行过完整 close。
   */
  private parkRetired(retired: GameProject, incomingDir: string): void {
    if (pathKey(retired.rootDir) === pathKey(incomingDir)) return;
    const key = pathKey(retired.rootDir);
    this.retired.delete(key); // 覆盖式：理论上到不了（同目录不会既在档又当值），防御性同键唯一
    this.retired.set(key, {
      rootDir: retired.rootDir,
      adapterId: retired.adapterId,
      project: retired,
      retiredAt: Date.now(),
    });
  }

  /**
   * 目标目录的旧档案被本次完整加载取代（`reason:'superseded'`，出声换代）。
   * 丢弃的只是可安全重建的派生产物（旧 loadProject 结果），无盘面副作用。
   */
  private supersedeRetired(incomingDir: string): void {
    const key = pathKey(incomingDir);
    const stale = this.retired.get(key);
    if (!stale) return;
    this.retired.delete(key);
    this.deps.bus.emit('project.evicted', {
      rootDir: stale.rootDir,
      adapterId: stale.adapterId,
      reason: 'superseded',
    });
    this.deps.log.debug(`Residency archive superseded by a fresh load: ${stale.rootDir}`);
  }

  /**
   * 驻留上限执法：上限计**全部驻留**（当前项目 + 档案）——缺省 3 ⇒ 合成 4 项目
   * 开第 4 个时第 1 个被逐。只从档案表逐（当前项目结构上进不了档案 ⇒ 绝不逐出），
   * 最旧优先（Map 插入序 = 退役序），逐出即 `project.evicted {reason:'lru'}` 出声。
   */
  private async enforceResidencyCap(): Promise<void> {
    const cap = await this.resolveResidencyCap();
    const limit = Math.max(0, cap - (this.currentProject ? 1 : 0));
    while (this.retired.size > limit) {
      const oldest = this.retired.keys().next();
      if (oldest.done) break;
      const entry = this.retired.get(oldest.value)!;
      this.retired.delete(oldest.value);
      this.deps.bus.emit('project.evicted', {
        rootDir: entry.rootDir,
        adapterId: entry.adapterId,
        reason: 'lru',
      });
      this.deps.log.info(`Project evicted from residency (lru): ${entry.rootDir}`);
    }
  }

  /**
   * 上限三级来源（只解析一次记档；本内核实例内不再变——改配置重启动生效）：
   * ① kernel 启动参数 `CreateKernelOptions.projectResidencyCap`（宿主显式意愿，最优先）；
   * ② 存储域 `_global.project-residency-cap`（宿主/设置页落盘的持久配置）；
   * ③ 环境变量 `KOJO_PROJECT_RESIDENCY_CAP`（部署/测试侧兜底；浏览器壳无 `process` 则跳过）；
   * ④ 缺省 {@link DEFAULT_PROJECT_RESIDENCY_CAP}（3）。
   * 任一级值非法（非有限数/负数）即视为「没说」，落到下一级。
   */
  private resolveResidencyCap(): Promise<number> {
    if (!this.residencyCapPromise) {
      this.residencyCapPromise = this.resolveResidencyCapOnce().catch((err: unknown) => {
        // 解析自身不许炸 open()：记账 + 回缺省（读存储失败 ≠ 配置了小上限）
        this.deps.log.warn(`Failed to resolve project residency cap; falling back to default: ${String(err)}`);
        this.residencyCapPromise = null;
        return DEFAULT_PROJECT_RESIDENCY_CAP;
      });
    }
    return this.residencyCapPromise;
  }

  private async resolveResidencyCapOnce(): Promise<number> {
    const fromOption = sanitizeResidencyCap(this.deps.residencyCap);
    if (fromOption !== null) return fromOption;
    try {
      const stored = await this.deps.globalStorage.get<unknown>(KEY_RESIDENCY_CAP);
      const fromStorage = sanitizeResidencyCap(stored);
      if (fromStorage !== null) return fromStorage;
    } catch (err: unknown) {
      // 读不动 ≠ 配了小上限：照旧落下一级
      this.deps.log.warn(`Unreadable residency cap config in storage; skipping: ${String(err)}`);
    }
    const envRaw =
      typeof process !== 'undefined' ? process.env?.[KEY_ENV_RESIDENCY_CAP] : undefined;
    const fromEnv = sanitizeResidencyCap(typeof envRaw === 'string' ? Number(envRaw) : undefined);
    if (fromEnv !== null) return fromEnv;
    return DEFAULT_PROJECT_RESIDENCY_CAP;
  }
}

/** 供 UI 的类型窄化辅助 */
export type GameAdapterContributionType = SlotMap['game.adapter'];
