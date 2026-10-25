import type { AdapterConflictCandidate, AdapterDetection, AdapterDetectResult } from './adapter-contract';
import type { GameProject } from './game';

/** 最近打开的项目记录（内核通用持久化，不感知游戏概念） */
export interface RecentProject {
  rootDir: string;
  adapterId: string;
  lastOpenedAt: number;
}

/**
 * 项目服务（内核 `kernel.project`）。
 *
 * onboarding 骨架（架构文档 §5.7）：
 * 用户选目录 → 内核轮询全部已注册的 `game.adapter` 候选 detect(dir)
 * → 命中的适配器 execute loadProject(dir)（黑盒）
 * → 内核持有不透明载荷 GameProject，发出 project.opened
 * → 各插件各自响应，内核编排到此为止。
 *
 * 内核不了解 CHARA CSV / sav / 口上目录——那些全部在适配器内部与 GameProject 字段中。
 */
export interface ProjectService {
  /** 轮询适配器并打开项目；无适配器命中时抛 ProjectDetectionError */
  open(rootDir: string): Promise<GameProject>;
  close(): Promise<void>;
  current(): GameProject | null;
  recent(): Promise<RecentProject[]>;
  /** 清空最近项目列表 */
  clearRecent(): Promise<void>;
  /**
   * 从最近列表移除单条记录。路径判等走 pathKey（折叠大小写与分隔符），
   * 与 pushRecent 的去重口径一致；目录不在列表时静默返回（幂等），
   * 其余条目原样保留——UI 删除按钮对用户来说「点了就没了」，不该再弹错。
   */
  removeRecent(rootDir: string): Promise<void>;
  /**
   * 用户批准写权限（onboarding 确认步骤调用）：
   * 立即对 io 生效 + 按 rootDir 持久化，下次打开同一目录自动恢复。
   * paths 必须是 project.writablePaths 的子集——UI 不能越权扩权。
   */
  approveWritablePaths(project: GameProject, paths: string[]): Promise<void>;
  /** 查询某目录已有的批准记录（UI 用来决定是否弹确认框） */
  approvedWritableFor(rootDir: string): Promise<string[] | null>;
}

export class ProjectDetectionError extends Error {
  constructor(
    public readonly rootDir: string,
    public readonly candidates: readonly string[],
  ) {
    super(
      candidates.length === 0
        ? `No game adapter is registered; cannot open project at ${rootDir}`
        : `No registered game adapter recognized the directory: ${rootDir} (candidates: ${candidates.join(', ')})`,
    );
    this.name = 'ProjectDetectionError';
  }
}

/** `detect()` 的 boolean / 证据对象两形归一（老适配器零改动） */
export function normalizeAdapterDetection(result: AdapterDetectResult): AdapterDetection {
  return typeof result === 'boolean' ? { matched: result } : result;
}

/**
 * 多个适配器同时认领同一目录。
 * 这不是「取 order 最小者」能解决的：任意取舍都会让另一枚适配器的领域面板静默错位，
 * 所以内核在 loadProject 之前就停下，把全部认领者与证据交给宿主显式呈现。
 */
export class AdapterConflictError extends Error {
  constructor(
    public readonly rootDir: string,
    public readonly candidates: readonly AdapterConflictCandidate[],
  ) {
    super(
      `Multiple game adapters recognized the directory: ${rootDir} (` +
        candidates
          .map((c) => `${c.adapterId}${c.evidence.length > 0 ? ` [${c.evidence.join('; ')}]` : ''}`)
          .join(' | ') +
        ')',
    );
    this.name = 'AdapterConflictError';
  }
}
