import type { Unsubscribe } from './base';
import type { GameProject } from './game';
import type { PluginStatus } from './plugin';

/** 文件变更类型 */
export type FileChangeKind = 'add' | 'change' | 'unlink';

export interface FileChangedEvent {
  kind: FileChangeKind;
  /** 归一化后的绝对路径 */
  path: string;
}

/**
 * 内核预定义事件（兼容性承诺：不改名、不删除，新增走次要版本）。
 */
export interface KernelEventMap {
  /** 文件系统变更（由内核 io 监视器产生） */
  'file.changed': FileChangedEvent;
  /** 项目已打开（onboarding 骨架完成 loadProject 后） */
  'project.opened': { project: GameProject };
  /** 项目已关闭 */
  'project.closed': { rootDir: string };
  /** 口上函数集合发生变化（解析器完成一次索引重建后） */
  'kojo.functionChanged': { projectRoot: string; files: string[] };
  /** 插件状态迁移（内核保证：任何插件状态变化都会发此事件） */
  'plugin.statusChanged': { pluginId: string; status: PluginStatus };
  /** 状态快照已加载（v1.0） */
  'state.snapshotLoaded': { source: string; characterId?: number };
  /**
   * 编辑器导航意图（v0.2）：打开文件并定位到行。
   * 通用、游戏无关——由宿主（编辑器壳）消费；任意插件可发起
   * （校验面板点击问题、函数树点击函数、未来的引用跳转）。
   */
  'editor.revealLocation': { filePath: string; line?: number; column?: number; source?: string };
  /**
   * 编辑器当前文件变更（v0.3 批 S5-UI）：宿主在"当前编辑的文件"发生变化时广播。
   *
   * 通用、游戏无关——「当前打开的是哪个文件」是**宿主状态**，不是任何插件的
   * 私有状态。把它做成事件而非服务方法：面板只想"知道变了"，不想"查询宿主"
   * （查询式接口会逼面板持有宿主引用，破坏"插件不得依赖宿主实现"的分层）。
   *
   * `filePath: null` = 当前无打开文件（项目关闭 / 回到欢迎页）。
   */
  'editor.activeFileChanged': { filePath: string | null };
  /**
   * 写权限批准记录失效（2026-10-11 写权限闭环批 P0）：持久化的批准与适配器
   * 本次提议不一致（游戏更新等）——内核**未**放行写权限，等待用户重新确认。
   *
   * 通用、游戏无关——由宿主消费（重弹批准对话框 + 状态栏只读徽章）。
   * 修复点：此前仅 log.warn，宿主无从感知，旧批准记录场景会静默永久只读（F1/F2）。
   */
  'project.writableApprovalMismatch': { rootDir: string };
  /**
   * 回放意图（v0.2 第八批）：请求回放面板解释一个口上函数。
   * 通用、游戏无关——由回放面板（`state.replay` 的 UI 消费者）响应；
   * 任意插件可发起（导航面板"回放此函数"、未来的矩阵/预览联动）。
   */
  'kojo.replayFunction': { functionName: string; source?: string };
  /**
   * 归档选中意图（v0.2 第十三批）：归档浏览器面板选中某档后广播。
   * 通用、游戏无关——任意插件可响应（未来的状态注入器 / 对比视图）；
   * 载荷只含归档路径与文件名（消费者按需自行深解析）。
   */
  'kojo.snapshotSelected': { path: string; fileName: string; source?: string };
}

/** 插件自定义事件键：必须携带 "插件id:" 前缀（例：'my-plugin:indexReady'） */
export type CustomEventKey = `${string}:${string}`;

/** 插件自定义事件（payload 由插件自行约定；内核不做类型校验） */
export type PluginEventMap = { [K in CustomEventKey]: unknown };

/** 总线接受的完整事件表 */
export type AnyEventMap = KernelEventMap & PluginEventMap;

/**
 * 类型化事件总线。
 * - 内核事件享有编译期 payload 校验；
 * - 插件自定义事件受前缀约定约束；
 * - 单个 handler 抛错不会影响其它 handler（内核隔离并记录日志）。
 */
export interface EventBus {
  on<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe;
  once<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe;
  emit<K extends keyof AnyEventMap>(type: K, payload: AnyEventMap[K]): void;
}
