/**
 * `MarketService` 实现（KM-2 的落盘侧）。
 *
 * 装卸链路（本批只有 local-dir 源；remote/index-entry 源等 Rust 解压命令落地再扩契约）：
 *
 * ```
 * <sourceDir>/pack.json ── 全量校验（零写盘）──┐
 *                                              ├─ .staging/<id>-<version>/ ── 逐文件 sha256 复核
 *                                              │        （字节级 writeBytes，绝不 readText/writeText）
 *                                              └─ rename ──> packs/<kind>/<id>/<version>/
 * ```
 *
 * 三条不可让步的纪律：
 * 1. **先全量校验再落盘**：`pack.json` 的任何一个字段/路径/限额不合格，一个字节都不写；
 * 2. **字节级**：口上包里的 `.ERB`/`.kojo` 可能是 Shift-JIS 或带 BOM，
 *    经一次 `readText`/`writeText` 就被转码毁掉——所以只走 `readBytes`/`writeBytes`；
 * 3. **失败不留半成品**：暂存区整体删掉，落点要么完整要么不存在。
 */

import {
  MARKET_CONTENT_DIR,
  MARKET_INDEX_FILE,
  MARKET_MANIFEST_FILE,
  MARKET_PACKS_DIR,
  MARKET_STAGING_DIR,
  MarketError,
  dirname,
  join,
  type FileIOWithPaths,
  type InstalledPack,
  type Logger,
  type MarketIndex,
  type MarketService,
  type PackKind,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { contentDigestOf, sha256Hex } from './digest';
import { parseIndex, parseManifest } from './manifest';

/** `ctx.storage`（域 = 本插件 id）里存已装清单的键 */
const INSTALLED_KEY = 'installed';

export interface MarketServiceDeps {
  /** 内核 io（已过第一道闸；`rename`/`removeDir` 两端都要断言） */
  io: FileIOWithPaths;
  /** 本插件的存储域 */
  storage: ScopedStorage;
  log: Logger;
  /** `<appData>/market`（由 activate 派生、登记常驻可写根并 ensureDir 后传入） */
  root: string;
  /** 当前应用版本（装配层注入；**插件源码不写版本号**） */
  appVersion: string;
  /** 时间源（测试注入固定值以钉死 `installedAt`） */
  now?: () => number;
}

function samePack(r: InstalledPack, kind: PackKind, id: string, version: string): boolean {
  return r.kind === kind && r.id === id && r.version === version;
}

/** 存储域里的记录形状核（被人手改过也不崩，坏条目丢弃并出声） */
function isInstalledPack(v: unknown): v is InstalledPack {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['kind'] === 'string' &&
    typeof o['id'] === 'string' &&
    typeof o['version'] === 'string' &&
    typeof o['name'] === 'string' &&
    typeof o['author'] === 'string' &&
    typeof o['license'] === 'string' &&
    typeof o['zipSha256'] === 'string' &&
    typeof o['installedAt'] === 'number' &&
    typeof o['dir'] === 'string' &&
    Array.isArray(o['files'])
  );
}

export function createMarketService(deps: MarketServiceDeps): MarketService {
  const { io, storage, log } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const packsRoot = join(deps.root, MARKET_PACKS_DIR);
  const stagingRoot = join(deps.root, MARKET_STAGING_DIR);
  const dirOf = (kind: PackKind, id: string, version: string): string =>
    join(packsRoot, kind, id, version);

  async function readRecords(): Promise<InstalledPack[]> {
    const raw = await storage.get<unknown>(INSTALLED_KEY);
    if (!Array.isArray(raw)) return [];
    const bad = raw.filter((r) => !isInstalledPack(r));
    if (bad.length > 0) log.warn(`已装清单里有 ${bad.length} 条形如破坏，已忽略（存储域被外部改过？）`);
    return raw.filter(isInstalledPack);
  }

  async function writeRecords(list: InstalledPack[]): Promise<void> {
    await storage.set(INSTALLED_KEY, list);
  }

  /** 删目录但不在"目录本就不存在/被占用"这类清理副作用上炸（清理永远不该盖住主错误） */
  async function quietRemove(path: string): Promise<void> {
    try {
      await io.removeDir(path);
    } catch (err) {
      log.warn(`清理失败（不影响本次结果）：${path} —— ${String(err)}`);
    }
  }

  /** 空壳父目录逐级收掉，直到 packs 根（装卸完留下的 `packs/<kind>/<id>` 空层没意义） */
  async function removeEmptyAncestors(dir: string): Promise<void> {
    let parent = dirname(dir);
    while (parent.length > 0 && parent !== packsRoot && parent !== dirname(parent)) {
      if (!(await io.exists(parent))) break;
      const entries = await io.listDir(parent);
      if (entries.length > 0) break;
      await quietRemove(parent);
      parent = dirname(parent);
    }
  }

  async function installLocalDir(sourceDir: string): Promise<InstalledPack> {
    /* ---------- 1. 读清单 + 全量校验（此刻零写盘） ---------- */
    const manifestPath = join(sourceDir, MARKET_MANIFEST_FILE);
    if (!(await io.exists(manifestPath))) {
      throw new MarketError('manifest-missing', `源目录里没有 ${MARKET_MANIFEST_FILE}：${sourceDir}`, sourceDir);
    }
    let rawText: string;
    try {
      rawText = (await io.readText(manifestPath)).text;
    } catch (err) {
      throw new MarketError('manifest-json', `${MARKET_MANIFEST_FILE} 读不出来：${String(err)}`, manifestPath);
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawText);
    } catch (err) {
      throw new MarketError('manifest-json', `${MARKET_MANIFEST_FILE} 不是合法 JSON：${String(err)}`, manifestPath);
    }
    const manifest = parseManifest(rawJson, deps.appVersion);
    if (!(await io.exists(join(sourceDir, MARKET_CONTENT_DIR)))) {
      throw new MarketError('content-missing', `源目录里没有 ${MARKET_CONTENT_DIR}/ 子目录：${sourceDir}`, sourceDir);
    }

    /* ---------- 2. 写进暂存区（字节级）+ 逐文件重算复核 ---------- */
    const staging = join(stagingRoot, `${manifest.id}-${manifest.version}`);
    const stale = join(stagingRoot, `${manifest.id}-${manifest.version}.__previous__`);
    const target = dirOf(manifest.kind, manifest.id, manifest.version);
    await quietRemove(staging); // 上次崩在这里的残壳
    await quietRemove(stale);
    try {
      for (const f of manifest.files) {
        let bytes: Uint8Array;
        try {
          bytes = await io.readBytes(join(sourceDir, f.path));
        } catch (err) {
          throw new MarketError(
            'source-unreadable',
            `清单声明的文件在源目录里读不到：${f.path} —— ${String(err)}`,
            f.path,
          );
        }
        if (bytes.length !== f.bytes) {
          throw new MarketError(
            'entry-bytes',
            `字节数对不上清单：${f.path} 声明 ${f.bytes}B，实读 ${bytes.length}B`,
            f.path,
          );
        }
        const dst = join(staging, f.path);
        await io.ensureDir(dirname(dst));
        await io.writeBytes(dst, bytes);
      }
      for (const f of manifest.files) {
        const bytes = await io.readBytes(join(staging, f.path));
        if (bytes.length !== f.bytes) {
          throw new MarketError(
            'entry-bytes',
            `暂存区里的字节数和清单不符：${f.path} 声明 ${f.bytes}B，实读 ${bytes.length}B`,
            f.path,
          );
        }
        const hex = await sha256Hex(bytes);
        if (hex !== f.sha256) {
          throw new MarketError(
            'entry-sha256',
            `校验锚不符（包内容与 pack.json 说的不是同一份东西）：${f.path} 期望 ${f.sha256}，实算 ${hex}`,
            f.path,
          );
        }
      }

      /* ---------- 3. 原子搬进落点（同版本重装 = 覆盖） ---------- */
      await io.ensureDir(dirname(target));
      const hadPrev = await io.exists(target);
      if (hadPrev) await io.rename(target, stale);
      try {
        await io.rename(staging, target);
      } catch (err) {
        if (hadPrev) {
          try {
            await io.rename(stale, target); // 搬不动就还原旧的，别让落点空着
          } catch (restoreErr) {
            log.warn(`覆盖安装回滚失败，旧版本暂存在 ${stale}：${String(restoreErr)}`);
          }
        }
        throw new MarketError('install-move-failed', `暂存区搬进落点失败：${String(err)}`, target);
      }
      if (hadPrev) await quietRemove(stale);
    } catch (err) {
      await quietRemove(staging); // 半成品绝不留在暂存区
      if (err instanceof MarketError) throw err;
      throw new MarketError('install-move-failed', `安装失败：${String(err)}`, target);
    }

    /* ---------- 4. 记账（ctx.storage，插件域） ---------- */
    const record: InstalledPack = {
      kind: manifest.kind,
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      author: manifest.author,
      license: manifest.license,
      zipSha256: await contentDigestOf(manifest.files),
      installedAt: now(),
      dir: target,
      files: manifest.files,
    };
    const rest = (await readRecords()).filter((r) => !samePack(r, record.kind, record.id, record.version));
    rest.push(record);
    await writeRecords(rest);
    log.info(`装好了 ${record.kind}/${record.id} v${record.version}（${record.files.length} 个文件）→ ${target}`);
    return record;
  }

  return {
    async rootDir(): Promise<string> {
      return deps.root;
    },

    async index(): Promise<MarketIndex | null> {
      const path = join(deps.root, MARKET_INDEX_FILE);
      if (!(await io.exists(path))) {
        log.warn(`注册表索引不在位（没同步过 index.json）：${path}`);
        return null;
      }
      let rawJson: unknown;
      try {
        rawJson = JSON.parse((await io.readText(path)).text);
      } catch (err) {
        log.warn(`注册表索引读不来或 JSON 坏了：${path} —— ${String(err)}`);
        return null;
      }
      const { index, dropped } = parseIndex(rawJson);
      if (index === null) {
        log.warn(`注册表索引形状不受支持（schema/generatedAt/packs 不合格），当作没有：${path}`);
        return null;
      }
      if (dropped.length > 0) {
        log.warn(`注册表索引丢掉了 ${dropped.length} 条坏条目：${dropped.slice(0, 5).join('；')}`);
      }
      return index;
    },

    async installed(): Promise<InstalledPack[]> {
      const list = await readRecords();
      const alive: InstalledPack[] = [];
      const lost: string[] = [];
      for (const r of list) {
        if (await io.exists(r.dir)) alive.push(r);
        else lost.push(`${r.kind}/${r.id} v${r.version}`);
      }
      if (lost.length > 0) {
        log.warn(`已装清单里有 ${lost.length} 条目录已不在位，一并剔除：${lost.join('；')}`);
        await writeRecords(alive);
      }
      return alive;
    },

    installLocalDir,

    async uninstall(kind: PackKind, id: string, version: string): Promise<void> {
      const dir = dirOf(kind, id, version);
      const list = await readRecords();
      const rest = list.filter((r) => !samePack(r, kind, id, version));
      const hadDir = await io.exists(dir);
      if (!hadDir && rest.length === list.length) {
        throw new MarketError('installed-missing', `没有装过 ${kind}/${id} v${version}，无需卸载`, dir);
      }
      if (hadDir) await io.removeDir(dir);
      await writeRecords(rest);
      await removeEmptyAncestors(dir);
      if (hadDir) {
        log.info(`卸掉了 ${kind}/${id} v${version}：${dir}`);
      } else {
        log.warn(`卸掉了 ${kind}/${id} v${version}（目录本来就不在位，只清了清单条目）`);
      }
    },

    async isInstalled(kind: PackKind, id: string, version: string): Promise<boolean> {
      if (!(await io.exists(dirOf(kind, id, version)))) return false;
      return (await readRecords()).some((r) => samePack(r, kind, id, version));
    },

    async installDir(kind: PackKind, id: string, version: string): Promise<string> {
      return dirOf(kind, id, version);
    },

    async contentDir(kind: PackKind, id: string, version: string): Promise<string> {
      return join(dirOf(kind, id, version), MARKET_CONTENT_DIR);
    },
  };
}
