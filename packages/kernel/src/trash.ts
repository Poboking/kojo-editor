import type { Logger, PlatformBridge, TrashEntry } from '@kojo/plugin-api';
import { dirname, isPathUnder, join, pathKey } from '@kojo/plugin-api';
import { fnv1a, timestamp } from './io';

/**
 * 回收站条目 id 形态（`<ts>-<hash8>`；列举/恢复/彻底删除只认它，不放宽）。
 * 时间戳段与备份版本文件名同一形态（io.timestamp 的唯一合法产出）。
 */
export const TRASH_ID_RE = /^\d{8}-\d{6}-\d{3}-[0-9a-f]{8}$/;

/**
 * 内核回收站（2026-10-16 undo 批；W11 回收站可见批补上对外读面与引用保护）。
 *
 * 语义：`io.removeDir` / `io.removeFile` 从"直接删"改为"移入 `{appData}/trash/`"。
 * 条目结构：
 *
 *   trash/<ts>-<hash>/        条目（id = 时间戳-原路径哈希；哈希折叠大小写/分隔符写法）
 *     payload/                原目录内容（或原文件本体，文件条目时 payload 即该文件）
 *     manifest.json           { originalPath, deletedAt, kind }
 *
 * 安全口径：
 * - 本类是**内核内部管理动作**，直连平台桥原语（与 `io.backup` 同一先例）——
 *   trash 根在 appData 恒可写，不进也不该进用户写允许域的判定面；
 * - 但**谁进 trash 由调用方的闸决定**：`io.removeDir/removeFile` 仍先过
 *   `assertWritable`，回收站不改变写允许域语义（源侧照旧拒绝越权删）；
 * - **恢复方向一样有闸，而且闸住在调用方**（`FileIOServiceImpl.restoreFromTrash`）：
 *   把 payload 搬回 `originalPath` 是一次**写盘**，落点完全可能在只读的游戏目录里。
 *   本类的 `restore` 是**低层原语**（只保证"不覆盖"、不判写允许域），
 *   它不是对外通道——契约面上暴露的必须是过闸那一个；
 * - 内核自己的管理性删除（备份裁剪、trash 自身的 purge）**绕过**本类直走桥——
 *   管理性删除进回收站会让 trash 自增殖，是明显错位。
 *
 * 跨卷：rename 搬不动（EXDEV 类错误）自动回落"逐文件 copy + 删源"；其余错误
 * 原样上抛（权限问题伪装成搬运问题去做 copy 会留下更乱的一半）。
 *
 * 市场线注意：`kojo-market` 的 stale→target 回滚走 `io.rename`（不进 trash），
 * 本类不触碰 rename 语义；其暂存残壳经 `io.removeFile` 进 trash 属安全副作用
 * （30 天 purge 收走），不破坏其还原逻辑。
 */

export const TRASH_DIR_NAME = 'trash';
/** 条目保留期（天）：purge 自动清理超期条目 */
export const TRASH_KEEP_DAYS = 30;
/**
 * 回收站字节总量上限（2026-10-18 字节上限批）：30 天保留期内的大批删除（整包卸载 /
 * 部署回滚）可短时把 appData 占满——超限从**最旧**条目起裁（先过超期档再过字节档）。
 * 取值：STATE §W 全盘 603MB，2GB 给足"同时容纳几棵整目录"的余量，同时与备份账（1GB）、
 * op 快照账（1GB）合计封顶 appData（~4GB）。裁剪跳过 `hold` 引用与大小未知的条目
 * （无法证明大小 ⇒ 不猜，宁可少裁），**裁了多少必须出声**（铁律 4）。
 */
export const TRASH_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
/** 字节档巡检最小间隔（moveIntoTrash 每次都全量 walkDir 求和太贵，节流成分钟级） */
const TRASH_BYTES_SWEEP_INTERVAL_MS = 60_000;
/** 条目内的内容根目录名（契约的 `payloadPath` 就是它；文件条目时 payload 即该文件本体） */
export const TRASH_PAYLOAD_NAME = 'payload';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashManifest {
  v: 1;
  originalPath: string;
  deletedAt: number;
  kind: 'dir' | 'file';
}

/** `list` 的相关性筛选（见 `isRelatedTo`） */
export interface TrashListOptions {
  forPath?: string;
}

/** `restore` 的覆盖许可（默认 false = 原位有东西就拒绝；见该方法注释） */
export interface TrashRestoreOptions {
  /**
   * true ⇒ 原位站着**同 kind 的东西**时仍然搬回去（调用方已把现状落进别的账）。
   * 只对 `kind='file'` 生效：目录永远不覆盖——整棵子树没有"一份现状"可以备份，
   * 覆盖它等于吃掉一整棵目录树，那不是恢复数据而是换个数据。
   */
  overwrite?: boolean;
}

function isCrossDevice(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.toUpperCase().includes('EXDEV')) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /EXDEV|cross-device|cross device|os error 18|not same/i.test(msg);
}

/**
 * 条目名的时间戳段 → 本地时刻（ms）；形态不合或日期非法 → null（判据不猜）。
 *
 * **年龄只认这一把尺**：`purge` 按条目名算超期，"剩余保留天数"也必须按同一把尺算。
 * manifest 的 `deletedAt` 是另一个时钟（搬运用 `Date.now()`），拿它显示"还剩 3 天"、
 * 却在下一趟按条目名把人收走 = 给用户一个假承诺。
 */
export function trashEntryTimeMs(id: string): number | null {
  const m = /^(\d{8})-(\d{6})-(\d{3})-/.exec(id);
  if (!m) return null;
  const d = new Date(
    Number(m[1]!.slice(0, 4)),
    Number(m[1]!.slice(4, 6)) - 1,
    Number(m[1]!.slice(6, 8)),
    Number(m[2]!.slice(0, 2)),
    Number(m[2]!.slice(2, 4)),
    Number(m[2]!.slice(4, 6)),
    Number(m[3]),
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * 相关性判定（`list({forPath})` 的筛子，同删除侧的 `pathKey` 尺）：
 * 原路径与查询路径**是同一个东西**，或**互为祖先**（文件在被删目录里 / 被删文件在查询目录下）。
 * 只认这三形，不做模糊匹配——"看着像同一个包"不是判据。
 */
function isRelatedTo(originalPath: string, forPath: string): boolean {
  if (pathKey(originalPath) === pathKey(forPath)) return true;
  return isPathUnder(originalPath, forPath) || isPathUnder(forPath, originalPath);
}

export class TrashManager {
  /**
   * 本会话被时间线引用的条目 id（`FileIO.holdTrash` 写入，整替语义）。
   * 只影响**自动清理**（超期清扫）：用户正看着的那一条不能在脚下消失。
   * 它不落盘、不延长保留期，也**拦不住**显式彻底删除——那是"别抽走"不是"永远留着"。
   */
  private readonly held = new Set<string>();
  /**
   * 最近一次"顺手超期清扫"的在途 Promise（`moveIntoTrash` 里是尽力而为的异步动作）。
   * 需要确定性顺序的调用方（测试、以及"删完就想看到清单"的读面）用 `flushSweep` 等它落定。
   */
  private sweep: Promise<void> = Promise.resolve();
  /** 字节档巡检的节流锚（上次真扫时刻）；上限的测试注入口（缺省 = 契约常量） */
  private lastBytesSweepAt = 0;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly bridge: PlatformBridge,
    private readonly log?: Logger,
    byteCaps: { maxTotalBytes?: number } = {},
  ) {
    this.maxTotalBytes = byteCaps.maxTotalBytes ?? TRASH_MAX_TOTAL_BYTES;
  }

  private async root(): Promise<string> {
    return join(await this.bridge.appDataDir(), TRASH_DIR_NAME);
  }

  /** 声明"这些条目正被引用"（整替；空数组 = 撤回全部） */
  hold(ids: readonly string[]): void {
    this.held.clear();
    for (const id of ids) this.held.add(id);
  }

  private async entryDir(id: string): Promise<string> {
    // id 必须命中单层段形态（拒绝分隔符/`..`，路径不可逃逸出 trash 根）
    if (!TRASH_ID_RE.test(id)) throw new Error(`无效的回收站条目：${id}`);
    return join(await this.root(), id);
  }

  /**
   * 把 target 移入回收站。**不判存在、不判权限**——两件事都是调用方
   * （`io.removeDir`/`io.removeFile`）的既有契约，本类只负责"移"。
   */
  async moveIntoTrash(target: string, kind: 'dir' | 'file'): Promise<void> {
    const root = await this.root();
    await this.bridge.ensureDir(root);
    const id = `${timestamp()}-${fnv1a(pathKey(target))}`;
    const entry = join(root, id);
    await this.bridge.ensureDir(entry);
    const payload = join(entry, 'payload');
    const manifest: TrashManifest = { v: 1, originalPath: target, deletedAt: Date.now(), kind };
    // 两阶段提交，**manifest 先行**：先把引用写进账本再搬货。旧序（先 rename 后写 manifest）
    // 在两步之间崩溃 = 货已离开原位、账上无名 —— 文件从 list/entryOf/restore 全部消失，
    // 是数据"隐形"丢失。新序的中间态只剩"有账无货"（rename 是原子操作，要么成要么没动），
    // 源文件原位不动，零丢失窗口；失败路径回滚账本（见下）。
    const manifestPath = join(entry, 'manifest.json');
    await this.bridge.writeFileBytes(manifestPath, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    try {
      await this.bridge.rename(target, payload);
    } catch (err) {
      if (!isCrossDevice(err)) {
        // 账已立、货没进来：回滚账本（条目目录整体撤掉）后把失败如实上抛，
        // 不留一个"列不出来也删不掉"的半成品条目
        await this.bridge.removeDir(entry).catch(() => undefined);
        throw err;
      }
      this.log?.warn(`回收站：rename 搬运失败（按跨卷回落 copy+delete）：${target} — ${String(err)}`);
      try {
        await this.copyInto(payload, target, kind);
      } catch (copyErr) {
        // 复制半途失败：源还在原位，撤账重抛（部分复制的 payload 随条目目录一起清）
        await this.bridge.removeDir(entry).catch(() => undefined);
        throw copyErr;
      }
      await this.deleteSource(target, kind);
    }
    // 顺手清超期 + 字节档（尽力而为：清理失败不影响本次移入；跳过被时间线引用的条目）
    // 先 `then(() => undefined)` 把 purge 的计数抹掉：`.catch` 只兜错误，
    // 直接挂会让 sweep 变成 `Promise<void | number>`（字段口径就是 Promise<void>）
    this.sweep = this.purge()
      .then(() => this.sweepBytesOverLimit())
      .then(() => undefined)
      .catch((err: unknown) => {
        this.log?.warn(`回收站：超期清理失败（不影响本次移入）：${String(err)}`);
      });
  }

  /** 跨卷回落：逐文件字节级复制进 payload（保真零转码，与 io.copyFile 同为纯搬运） */
  private async copyInto(payload: string, target: string, kind: 'dir' | 'file'): Promise<void> {
    if (kind === 'file') {
      const bytes = await this.bridge.readFileBytes(target);
      await this.bridge.writeFileBytes(payload, bytes);
      return;
    }
    const files = await this.bridge.walkDir(target, { includeFiles: true });
    for (const f of files) {
      if (f.isDirectory) continue;
      const rel = f.path.slice(target.length).replace(/^[\\/]+/, '');
      const bytes = await this.bridge.readFileBytes(f.path);
      await this.bridge.writeFileBytes(join(payload, rel), bytes);
    }
  }

  private async deleteSource(target: string, kind: 'dir' | 'file'): Promise<void> {
    // 源已复制进 trash，此处是"清掉原位"——管理性删除，直走桥原语
    if (kind === 'dir') await this.bridge.removeDir(target);
    else await this.bridge.removeFile(target);
  }

  /**
   * 回收站清单（新在前；`opts.forPath` = 只留与该路径相关的条目）。
   *
   * 两种"看着像条目、其实用不了"的目录**整条剔除并出声**，不猜也不给半个：
   * - 目录名不合 id 形态 ⇒ restore / purge 都不认它，列出来只会摆一个点不动的按钮；
   * - manifest 缺失 / 字段不合 ⇒ 连"它原来在哪"都不知道，恢复无从谈起。
   */
  async list(opts?: TrashListOptions): Promise<TrashEntry[]> {
    const root = await this.root();
    const entries = await this.bridge.listDir(root).catch(() => []);
    const out: TrashEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (!TRASH_ID_RE.test(e.name)) {
        this.log?.warn(`回收站：目录名不合条目形态（跳过，它也无法恢复）：${e.path}`);
        continue;
      }
      const view = await this.readEntry(e.name, e.path);
      if (view === null) continue;
      if (opts?.forPath !== undefined && !isRelatedTo(view.originalPath, opts.forPath)) continue;
      out.push(view);
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  /** 单条读取（恢复/彻底删除的前置查询；不在位 / 形态不合 / manifest 坏 ⇒ null，不动盘） */
  async entryOf(id: string): Promise<TrashEntry | null> {
    if (!TRASH_ID_RE.test(id)) return null;
    const dir = join(await this.root(), id);
    if (!(await this.bridge.exists(dir))) return null;
    return this.readEntry(id, dir);
  }

  private async readEntry(id: string, dir: string): Promise<TrashEntry | null> {
    const manifestPath = join(dir, 'manifest.json');
    let raw: Partial<TrashManifest>;
    try {
      const bytes = await this.bridge.readFileBytes(manifestPath);
      raw = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TrashManifest>;
    } catch (err) {
      this.log?.warn(`回收站：条目 manifest 不可读（跳过）：${dir} — ${String(err)}`);
      return null;
    }
    if (
      typeof raw.originalPath !== 'string' ||
      typeof raw.deletedAt !== 'number' ||
      (raw.kind !== 'dir' && raw.kind !== 'file')
    ) {
      this.log?.warn(`回收站：条目 manifest 字段缺失（跳过）：${dir}`);
      return null;
    }
    const payload = join(dir, TRASH_PAYLOAD_NAME);
    // 账对货的核验：payload 不在位（两阶段提交在搬货前崩溃的残留、或人为动过目录）
    // ⇒ 不列进清单（恢复必败，列出来只会摆一个点不动的按钮）；残留由超期清理收走。
    if (!(await this.bridge.exists(payload))) {
      this.log?.warn(`回收站：条目 payload 缺失（跳过，残留待超期清理）：${dir}`);
      return null;
    }
    // 年龄按条目名那把尺（与 purge 同源）；名字合形态却日期非法（2 月 30 日那类）
    // 才回落 manifest——**回落的是显示口径，超期判定仍是条目名，宁缺毋滥**
    const atMs = trashEntryTimeMs(id) ?? raw.deletedAt;
    return {
      id,
      originalPath: raw.originalPath,
      kind: raw.kind,
      deletedAtMs: atMs,
      expiresAtMs: atMs + TRASH_KEEP_DAYS * DAY_MS,
      bytes: await this.sizeOf(raw.kind, payload),
      payloadPath: payload,
    };
  }

  /**
   * 条目内容字节数：一趟带元数据的遍历（目录）或一次 stat（文件）。
   * 任一处取不到 size ⇒ 整条 `null`（"大小未知"），**绝不拿 0 兜底**。
   */
  private async sizeOf(kind: 'dir' | 'file', payload: string): Promise<number | null> {
    if (kind === 'file') {
      const st = await this.bridge.stat(payload).catch(() => null);
      return st !== null && !st.isDirectory ? st.size : null;
    }
    const files = await this.bridge.walkDir(payload, { includeFiles: true, withMetadata: true }).catch(() => null);
    if (files === null) return null;
    let sum = 0;
    for (const f of files) {
      if (f.isDirectory) continue;
      if (typeof f.size !== 'number') return null;
      sum += f.size;
    }
    return sum;
  }

  /**
   * 恢复条目到原路径。
   *
   * 原位站着东西时的两种结局（闸不在此层，见类头注与 `FileIO.restoreFromTrash`）：
   * - 默认（`overwrite` 未开）：**拒绝**——回收站不做覆盖；
   * - `overwrite: true` 且条目是**文件**、原位也是**文件**：搬回去（平台 rename 就地替换）。
   *   这一形态必须由调用方先把原位那份现状落进别的账（写前备份），否则等于吃掉现状；
   * - 目录形对目录形 / 目录形对文件：一律拒绝——整棵子树没有"一份现状"可备份。
   */
  async restore(id: string, opts?: TrashRestoreOptions): Promise<string> {
    const entry = await this.entryDir(id);
    const view = await this.entryOf(id);
    if (!view) throw new Error(`回收站条目不存在或已失效：${id}`);
    const payload = join(entry, TRASH_PAYLOAD_NAME);
    if (!(await this.bridge.exists(payload))) throw new Error(`回收站条目内容缺失：${id}`);
    const occupant = await this.bridge.stat(view.originalPath);
    if (occupant !== null) {
      if (opts?.overwrite !== true || view.kind !== 'file' || occupant.isDirectory) {
        throw new Error(`原位置已存在，不能恢复（回收站不覆盖）：${view.originalPath}`);
      }
    }
    // 原父目录可能已随其他操作消失：先补齐
    const parent = dirname(view.originalPath);
    if (parent && parent !== view.originalPath) await this.bridge.ensureDir(parent);
    try {
      await this.bridge.rename(payload, view.originalPath);
    } catch (err) {
      if (!isCrossDevice(err)) throw err;
      await this.copyInto(view.originalPath, payload, view.kind);
      await this.deleteSource(payload, view.kind);
    }
    await this.bridge.removeDir(entry);
    this.held.delete(id);
    this.log?.info(`回收站：已恢复 ${id} → ${view.originalPath}`);
    return view.originalPath;
  }

  /**
   * 自动清理：只动**已超保留期**（按条目名那把尺）且**未被本会话引用**（`hold`）的条目。
   * 形态不对的条目不动（判据不猜）；删除失败保留现场并出声。
   */
  async purge(now = Date.now()): Promise<number> {
    const root = await this.root();
    const entries = await this.bridge.listDir(root).catch(() => []);
    let purged = 0;
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (this.held.has(e.name)) continue; // 时间线正在引用它：这一次不动（显式彻底删除仍可）
      const atMs = trashEntryTimeMs(e.name);
      if (atMs === null) continue;
      if (now - atMs > TRASH_KEEP_DAYS * DAY_MS) {
        try {
          await this.bridge.removeDir(e.path);
          purged++;
          this.held.delete(e.name);
        } catch (err) {
          this.log?.warn(`回收站：超期条目清理失败（保留现场）：${e.path} — ${String(err)}`);
        }
      }
    }
    if (purged > 0) this.log?.info(`回收站：清理超期条目 ${purged} 个`);
    return purged;
  }

  /**
   * 字节总量档（2026-10-18 字节上限批，公开可测）：全部条目 payload 字节之和超
   * `maxTotalBytes` ⇒ 从**最旧**条目（id 时序）起裁到预算内。跳过 `hold` 引用与
   * 大小未知（`bytes === null`）的条目——无法证明大小就不猜，宁可少裁；
   * 删除失败保留现场并出声；裁了多少必须 warn（铁律 4）。
   * 节流：距上次真扫不足 {@link TRASH_BYTES_SWEEP_INTERVAL_MS} 就跳过（`force` 绕过，测试用）。
   */
  async sweepBytesOverLimit(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.lastBytesSweepAt < TRASH_BYTES_SWEEP_INTERVAL_MS) return 0;
    this.lastBytesSweepAt = now;
    const all = await this.list();
    let total = 0;
    for (const e of all) {
      if (e.bytes !== null) total += e.bytes;
    }
    if (total <= this.maxTotalBytes) return 0;
    // list 已新在前（id 降序）⇒ 尾部即最旧；从最旧开始裁
    let over = total;
    let pruned = 0;
    for (let i = all.length - 1; i >= 0 && over > this.maxTotalBytes; i--) {
      const e = all[i]!;
      if (this.held.has(e.id)) continue; // 时间线正引用：这一次不动（同 purge 口径）
      if (e.bytes === null) continue; // 大小未知：不拿 0 参与判定，不猜
      try {
        await this.bridge.removeDir(join(await this.root(), e.id));
        over -= e.bytes;
        pruned++;
        this.held.delete(e.id);
      } catch (err) {
        this.log?.warn(`回收站：字节超限裁剪失败（保留现场）：${e.id} — ${String(err)}`);
      }
    }
    if (pruned > 0) {
      this.log?.warn(
        `回收站：字节总量超限（实算 ${total}B > 上限 ${this.maxTotalBytes}B），按最旧先裁清掉 ${pruned} 个条目（裁后约 ${over}B）`,
      );
    }
    return pruned;
  }

  /**
   * 显式彻底删除（用户对着这一条点了"彻底删除"）：命中即删，
   * **不看保留期也不看 `hold`**——那句话就是最终答案。
   *
   * id 形态不合即抛（`entryDir` 的闸），条目不在位也抛：
   * "我以为删掉了"和"没删掉"必须是两种能听见的结果，不静默跳过。
   */
  async purgeIds(ids: readonly string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      const dir = await this.entryDir(id);
      if (!(await this.bridge.exists(dir))) throw new Error(`回收站条目不存在或已被清理：${id}`);
      await this.bridge.removeDir(dir);
      this.held.delete(id);
      removed++;
    }
    if (removed > 0) this.log?.info(`回收站：彻底删除条目 ${removed} 个`);
    return removed;
  }

  /** 等待本会话内"顺手超期清扫"跑完（`moveIntoTrash` 是尽力而为的异步清理；测试与需要确定性顺序的调用方用它） */
  async flushSweep(): Promise<void> {
    await this.sweep;
  }
}
