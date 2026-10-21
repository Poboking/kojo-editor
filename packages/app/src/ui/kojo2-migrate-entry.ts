/**
 * Kojo 2.0 迁移向导 · **宿主入口**（K2-MIGRATE-MOUNT）——纯逻辑，零 React。
 *
 * 向导组件（`kojo2-migrate.tsx`）只管画；"它怎么被打开、IO 从哪来、应用完谁去刷新"
 * 全在这一层。抽出来的理由和 `kojo2-cutover.ts` 一样：这些判据要能在 node 里单测，
 * 塞进 `App.tsx` 就只能靠真实壳冒烟。
 *
 * ## 四件事
 *
 * 1. **开合状态机**：`closed → opening → open | failed`，`close()` 随时可回。开合是**幂等**的
 *    （重复 `open()` 不重走列举、`close()` 不重复通知），因为命令面板连点两下不该炸出两趟 walk。
 * 2. **命令入口**：`commands()` 返回 `ShellCommandSpec[]`。**开关关 = 零注册**（返回空数组，
 *    命令面板 / 快捷键表里一个字都不出现），开关开才有一条。
 * 3. **IO 注入**：`io` 由宿主给（真身 `kernel.io`），本层不 import 内核、不碰 `window`。
 *    列举面 `listFiles` 与刷新面 `refreshFiles` 同样是注入的——测试给假的就能断言调用序。
 * 4. **应用 / 撤销后的刷新**：写过的文件经 `refreshFiles(paths)` **一次**交给宿主，
 *    宿主用**既有**通道（`kernel.bus.emit('file.changed', …)`：文件树按
 *    `affectsKojoTree` 合批重列、已开编辑器按外部改动重载）落地。本层不自造第二条刷新链。
 *
 * ## 刷新为什么只报"真写过的文件"
 *
 * `file.changed` 的消费方会重列目录 / 重读 model，都是有代价的动作；已 2.0 的文件在
 * `applyMigratePlan` 里根本不写盘（mtime 不变），把它们也报一遍就是纯噪声。同理，回滚掉的
 * 文件不算"写入成功"，不报——它们的盘面已经回到迁移前，编辑器里的那份本来就没动过。
 *
 * ## 目标口径
 *
 * **原地改写**：迁移只改文件内容，不改扩展名、不删源（裁决写在 `kojo2-migrate-model.ts`）。
 * 因此刷新报的路径就是原路径，宿主不需要处理"旧标签失效 / 新标签出现"的改名语义。
 */
import { KOJO_SOURCE_EXTENSION, pathKey } from '@kojo/plugin-api';
import type { ShellCommandSpec } from './commands';
import { isKojo2CutoverEnabled } from './kojo2-flag';
import {
  applyMigratePlan,
  undoMigratePlan,
  type MigrateApplyResult,
  type MigrateDryRun,
  type MigrateIoPort,
  type MigrateUndoResult,
} from './kojo2-migrate-model';

/* ============================== 命令 ============================== */

/** 命令 id（命令面板 / 键位注册表 / 测试共用的唯一标识） */
export const KOJO2_MIGRATE_COMMAND_ID = 'workbench.kojo2Migrate';

/**
 * 命令标题：与其余壳层命令同形（裸动宾、无括号、无省略号）。
 *
 * 「迁移」这个词在作者面已有固定含义（老 `.kojo` → 2.0），故标题直接把版本说全，
 * 不写"升级向导"这种要猜的说法。
 */
export const KOJO2_MIGRATE_COMMAND_TITLE = '打开 Kojo 2.0 迁移向导';

/** 命令分类（与「工作台」其余入口同一格，命令面板可搜） */
export const KOJO2_MIGRATE_COMMAND_CATEGORY = '工作台';

/* ============================== 端口 / 形状 ============================== */

/** 宿主注入的四个能力（全部可替换；测试给假的） */
export interface Kojo2MigrateEntryDeps {
  /** 读写端口（真身 = `kernel.io`，结构子集见 `MigrateIoPort`） */
  readonly io: MigrateIoPort;
  /** 候选文件列举（宿主用自己的递归列举；本层只按扩展名收口） */
  readonly listFiles: () => Promise<readonly string[]>;
  /**
   * 刷新通道（**必须**是宿主既有那条）：宿主把路径翻成 `file.changed` 事件，
   * 文件树与已开编辑器各自按既有口径重载。本层一次调用给全部路径，不逐条发。
   */
  readonly refreshFiles: (paths: readonly string[]) => void;
  /** 人话通知（可选；不传则只在向导内部显示） */
  readonly notify?: (message: string) => void;
  /** 开关读取（缺省 = `isKojo2CutoverEnabled`；测试注入固定值） */
  readonly isEnabled?: () => boolean;
  /** 说话人兜底（缺省 = 无兜底，与模型层同口径） */
  readonly speaker?: () => string | undefined;
}

/** 入口状态（`opening` 是**可见**的中间态：列举可能要走一趟递归 walk） */
export type Kojo2MigrateEntryStatus = 'closed' | 'opening' | 'open' | 'failed';

/** 入口快照（`useSyncExternalStore` / 订阅者读的那一份；引用稳定见 `snapshot()`） */
export interface Kojo2MigrateEntrySnapshot {
  readonly status: Kojo2MigrateEntryStatus;
  /** `status === 'open'` 时才有意义：待迁移的 v1 `.kojo` 文件（去重、按列举顺序） */
  readonly filePaths: readonly string[];
  /** `failed` 时的人话原因；其余状态为 null */
  readonly message: string | null;
  /** 开关此刻是否开着（关 = 命令不存在、`open()` 不做事） */
  readonly enabled: boolean;
}

/** `open()` 的结果（命令 `run` 只关心"有没有开成"，但测试要能分辨这四种） */
export type Kojo2MigrateOpenOutcome =
  /** 已列举完、向导可见（可能零文件——空态由向导呈现） */
  | 'opened'
  /** 开关关：什么都没发生 */
  | 'disabled'
  /** 正在列举 / 已经开着：不重走第二趟 */
  | 'busy'
  /** 列举失败（已上屏，状态 = failed） */
  | 'failed';

/** 宿主入口（命令 + 开合 + 应用/撤销的刷新收尾） */
export interface Kojo2MigrateEntry {
  isEnabled(): boolean;
  /** 开关关 ⇒ 空数组（零注册）；开 ⇒ 恰好一条 */
  commands(): readonly ShellCommandSpec[];
  open(): Promise<Kojo2MigrateOpenOutcome>;
  close(): void;
  getSnapshot(): Kojo2MigrateEntrySnapshot;
  subscribe(listener: (snapshot: Kojo2MigrateEntrySnapshot) => void): () => void;
  /** 应用一份 dry-run 计划；成功（或部分写入）后刷新一次并通知 */
  apply(plan: MigrateDryRun): Promise<MigrateApplyResult>;
  /** 撤销一次成功应用；成功恢复后刷新一次并通知 */
  undo(plan: MigrateDryRun, applied: MigrateApplyResult): Promise<MigrateUndoResult>;
  /** 宿主回调入口（向导自己调 `apply` 时由它内部走这里；也供外部结果复用） */
  handleApplied(result: MigrateApplyResult): readonly string[];
  handleUndone(result: MigrateUndoResult): readonly string[];
  /** 说话人兜底（向导的 `speaker` 属性） */
  speaker(): string | undefined;
}

/* ============================== 纯判据 ============================== */

/**
 * 这个路径是不是迁移的候选：只认 v1 源扩展名 `.kojo`（大小写不敏感）。
 *
 * `.kojo2` 已经是 2.0 写法，不在候选里——把它塞进迁移列表只会让作者看见一堆
 * "已是 2.0" 的空行；`.erb` 那几类是原生方言，迁移引擎不认识，也不该进来。
 */
export function isMigrateCandidate(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  const dot = path.lastIndexOf('.');
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= sep) return false;
  return path.slice(dot).toLowerCase() === KOJO_SOURCE_EXTENSION;
}

/**
 * 候选收口：按扩展名过滤 + 按 `pathKey`（折叠大小写与分隔符）去重，保持列举顺序。
 *
 * 去重是必要的：宿主列举可能同时给"项目根"与"会话附加根"，两处指向同一份文件时
 * 会出现两条只差分隔符的路径——照着写盘就是同一份文件备份两次、刷新两次。
 */
export function selectMigrateFiles(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!isMigrateCandidate(path)) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * 本次应用**真写过盘**的文件（刷新靶子）。
 *
 * 口径：`status === 'applied' && changed`。已 2.0 的跳过（`changed=false`）、阻断 /
 * stale / 回滚的都不算——盘面没有"需要重载的新内容"。
 */
export function appliedPaths(result: MigrateApplyResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of result.files) {
    if (file.status !== 'applied' || !file.changed) continue;
    const key = pathKey(file.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file.filePath);
  }
  return out;
}

/** 本次撤销**真恢复过**的文件（刷新靶子；口径同 `appliedPaths`） */
export function restoredPaths(result: MigrateUndoResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of result.files) {
    if (file.status !== 'restored') continue;
    const key = pathKey(file.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file.filePath);
  }
  return out;
}

/* ============================== 入口 ============================== */

/** 建一个宿主入口（一次装配一个；命令表与状态机同生） */
export function createKojo2MigrateEntry(deps: Kojo2MigrateEntryDeps): Kojo2MigrateEntry {
  const readEnabled = deps.isEnabled ?? isKojo2CutoverEnabled;

  let status: Kojo2MigrateEntryStatus = 'closed';
  let filePaths: readonly string[] = [];
  let message: string | null = null;
  /** 列举的世代号：`close()` / 新一次 `open()` 都会自增，旧结果回来时直接丢弃 */
  let openSeq = 0;
  const listeners = new Set<(snapshot: Kojo2MigrateEntrySnapshot) => void>();
  /** 快照缓存（`getSnapshot` 必须在状态不变时返回同一引用，否则订阅方会自激重渲） */
  let cached: Kojo2MigrateEntrySnapshot | null = null;

  function snapshot(): Kojo2MigrateEntrySnapshot {
    const enabled = readEnabled();
    if (
      cached !== null &&
      cached.status === status &&
      cached.filePaths === filePaths &&
      cached.message === message &&
      cached.enabled === enabled
    ) {
      return cached;
    }
    cached = { status, filePaths, message, enabled };
    return cached;
  }

  function emit(): void {
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  }

  function setState(next: Kojo2MigrateEntryStatus, paths: readonly string[], reason: string | null): void {
    status = next;
    filePaths = paths;
    message = reason;
    emit();
  }

  function notify(text: string): void {
    deps.notify?.(text);
  }

  /** 刷新 + 通知的公共收尾：路径非空才刷新（一次给全部），通知恒发（结果必须可见） */
  function refreshThenNotify(paths: readonly string[], text: string): readonly string[] {
    if (paths.length > 0) deps.refreshFiles(paths);
    notify(text);
    return paths;
  }

  function commandSpec(): ShellCommandSpec {
    return {
      id: KOJO2_MIGRATE_COMMAND_ID,
      title: KOJO2_MIGRATE_COMMAND_TITLE,
      category: KOJO2_MIGRATE_COMMAND_CATEGORY,
      run: () => {
        // 命令 `run` 是同步签名：开合在后台走，结果经状态机 / 通知露出，不阻塞命令面板
        void entry.open();
      },
    };
  }

  /** 应用后的收尾（也是 `apply` 走的那条）：真写过的路径刷新一次，结果通知一次 */
  function handleApplied(result: MigrateApplyResult): readonly string[] {
    return refreshThenNotify(appliedPaths(result), result.message);
  }

  /** 撤销后的收尾：真恢复过的路径刷新一次，结果通知一次 */
  function handleUndone(result: MigrateUndoResult): readonly string[] {
    return refreshThenNotify(restoredPaths(result), result.message);
  }

  const entry: Kojo2MigrateEntry = {
    isEnabled: () => readEnabled(),

    commands: () => (readEnabled() ? [commandSpec()] : []),

    async open(): Promise<Kojo2MigrateOpenOutcome> {
      if (!readEnabled()) return 'disabled';
      if (status === 'opening' || status === 'open') return 'busy';

      const seq = ++openSeq;
      setState('opening', [], null);

      let listed: readonly string[];
      try {
        listed = await deps.listFiles();
      } catch (error) {
        if (seq !== openSeq) return 'busy'; // 期间被关掉：这次失败已经作废，不上屏
        const reason = `列举可迁移文件失败：${errorText(error)}`;
        setState('failed', [], reason);
        notify(reason);
        return 'failed';
      }
      if (seq !== openSeq) return 'busy';

      setState('open', selectMigrateFiles(listed), null);
      return 'opened';
    },

    close(): void {
      if (status === 'closed') return;
      openSeq += 1; // 在途列举作废（否则它回来会把刚关掉的向导又弹出来）
      setState('closed', [], null);
    },

    getSnapshot: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async apply(plan: MigrateDryRun): Promise<MigrateApplyResult> {
      const result = await applyMigratePlan(deps.io, plan);
      // 写过一个文件就要刷新：整批 ok=false（有回滚）但其余文件写成功时，盘面确实变了
      if (result.ok || result.written > 0) handleApplied(result);
      else notify(result.message);
      return result;
    },

    async undo(plan: MigrateDryRun, applied: MigrateApplyResult): Promise<MigrateUndoResult> {
      const result = await undoMigratePlan(deps.io, plan, applied);
      if (result.ok) handleUndone(result);
      else notify(result.message);
      return result;
    },

    handleApplied,
    handleUndone,

    speaker: () => deps.speaker?.(),
  };

  return entry;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
