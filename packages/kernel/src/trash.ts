import type { Logger, PlatformBridge } from '@kojo/plugin-api';
import { dirname, join, pathKey } from '@kojo/plugin-api';
import { fnv1a, timestamp } from './io';

/**
 * 回收站条目 id 形态（`<ts>-<hash8>`；列举/恢复只认它，不放宽）。
 * 时间戳段与备份版本文件名同一形态（io.timestamp 的唯一合法产出）。
 */
export const TRASH_ID_RE = /^\d{8}-\d{6}-\d{3}-[0-9a-f]{8}$/;

/**
 * 内核回收站（2026-10-16 undo 批）。
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
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashManifest {
  v: 1;
  originalPath: string;
  deletedAt: number;
  kind: 'dir' | 'file';
}

export interface TrashEntryView {
  /** 条目目录名（`<ts>-<hash8>`；restore 用） */
  id: string;
  originalPath: string;
  deletedAt: number;
  kind: 'dir' | 'file';
}

function isCrossDevice(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.toUpperCase().includes('EXDEV')) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /EXDEV|cross-device|cross device|os error 18|not same/i.test(msg);
}

export class TrashManager {
  constructor(
    private readonly bridge: PlatformBridge,
    private readonly log?: Logger,
  ) {}

  private async root(): Promise<string> {
    return join(await this.bridge.appDataDir(), TRASH_DIR_NAME);
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
    try {
      await this.bridge.rename(target, payload);
    } catch (err) {
      if (!isCrossDevice(err)) throw err;
      this.log?.warn(`回收站：rename 搬运失败（按跨卷回落 copy+delete）：${target} — ${String(err)}`);
      await this.copyInto(payload, target, kind);
      await this.deleteSource(target, kind);
    }
    const manifest: TrashManifest = { v: 1, originalPath: target, deletedAt: Date.now(), kind };
    await this.bridge.writeFileBytes(join(entry, 'manifest.json'), new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    // 顺手清超期（尽力而为：清理失败不影响本次移入）
    void this.purge().catch((err: unknown) => {
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

  /** 回收站清单（新在前；manifest 缺失/损坏的条目剔除并出声，不猜） */
  async list(): Promise<TrashEntryView[]> {
    const root = await this.root();
    const entries = await this.bridge.listDir(root).catch(() => []);
    const out: TrashEntryView[] = [];
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const manifestPath = join(e.path, 'manifest.json');
      try {
        const bytes = await this.bridge.readFileBytes(manifestPath);
        const raw = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TrashManifest>;
        if (
          typeof raw.originalPath !== 'string' ||
          typeof raw.deletedAt !== 'number' ||
          (raw.kind !== 'dir' && raw.kind !== 'file')
        ) {
          throw new Error('manifest 字段缺失');
        }
        out.push({ id: e.name, originalPath: raw.originalPath, deletedAt: raw.deletedAt, kind: raw.kind });
      } catch (err) {
        this.log?.warn(`回收站：条目 manifest 不可读（跳过）：${e.path} — ${String(err)}`);
      }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  /** 恢复条目到原路径（原路径已存在时拒绝——回收站不做覆盖） */
  async restore(id: string): Promise<string> {
    const entry = await this.entryDir(id);
    const view = (await this.list()).find((v) => v.id === id);
    if (!view) throw new Error(`回收站条目不存在或已失效：${id}`);
    const payload = join(entry, 'payload');
    if (!(await this.bridge.exists(payload))) throw new Error(`回收站条目内容缺失：${id}`);
    if (await this.bridge.exists(view.originalPath)) {
      throw new Error(`原位置已存在，不能恢复（回收站不覆盖）：${view.originalPath}`);
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
    this.log?.info(`回收站：已恢复 ${id} → ${view.originalPath}`);
    return view.originalPath;
  }

  /** 清理超过保留期的条目（返回清掉的条目数；形态不对的条目不动——判据不猜） */
  async purge(now = Date.now()): Promise<number> {
    const root = await this.root();
    const entries = await this.bridge.listDir(root).catch(() => []);
    let purged = 0;
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const m = /^(\d{8})-(\d{6})-(\d{3})-/.exec(e.name);
      if (!m) continue;
      const d = new Date(
        Number(m[1]!.slice(0, 4)),
        Number(m[1]!.slice(4, 6)) - 1,
        Number(m[1]!.slice(6, 8)),
        Number(m[2]!.slice(0, 2)),
        Number(m[2]!.slice(2, 4)),
        Number(m[2]!.slice(4, 6)),
        Number(m[3]),
      );
      if (Number.isNaN(d.getTime())) continue;
      if (now - d.getTime() > TRASH_KEEP_DAYS * DAY_MS) {
        try {
          await this.bridge.removeDir(e.path);
          purged++;
        } catch (err) {
          this.log?.warn(`回收站：超期条目清理失败（保留现场）：${e.path} — ${String(err)}`);
        }
      }
    }
    if (purged > 0) this.log?.info(`回收站：清理超期条目 ${purged} 个`);
    return purged;
  }
}
