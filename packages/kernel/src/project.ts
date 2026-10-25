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
 */

const KEY_RECENT = 'recent-projects';
const KEY_APPROVED = 'approved-writable';
const MAX_RECENT = 10;

export interface ProjectServiceDeps {
  slots: SlotRegistry;
  bus: EventBus;
  io: FileIO;
  globalStorage: ScopedStorage;
  log: Logger;
}

export class ProjectServiceImpl implements ProjectService {
  private currentProject: GameProject | null = null;

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

    if (this.currentProject) await this.close();

    this.currentProject = project;
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
}

/** 供 UI 的类型窄化辅助 */
export type GameAdapterContributionType = SlotMap['game.adapter'];
