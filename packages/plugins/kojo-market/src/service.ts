/**
 * `MarketService` 实现（KM-2 的落盘侧 + KM-8/KM-9 的索引面）。
 *
 * 两条链路：
 *
 * **装（本批仍只有 local-dir 源）**
 * ```
 * <sourceDir>/pack.json ── 全量校验（零写盘）──┐
 *                                              ├─ .staging/<id>-<version>/ ── 逐文件 sha256 复核
 *                                              │        （字节级 writeBytes，绝不 readText/writeText）
 *                                              └─ rename ──> packs/<kind>/<id>/<version>/
 * ```
 *
 * **索引（KM-8：拉 → 校验 → 落 `<appData>/market/index.json`）**
 * ```
 * endpoint ──remote.fetchText──> 文本 ── parseIndex ──通过──> writeText(原文镜像) + 记数据时间
 *                                        └─ 不通过 ⇒ failed，盘上旧列表原样不动
 * ```
 *
 * 五条不可让步的纪律：
 * 1. **先全量校验再落盘**：`pack.json` 的任何一个字段/路径/限额不合格，一个字节都不写；
 * 2. **字节级**：口上包里的 `.ERB`/`.kojo` 可能是 Shift-JIS 或带 BOM，
 *    经一次 `readText`/`writeText` 就被转码毁掉——所以装卸只走 `readBytes`/`writeBytes`；
 *    索引是 JSON 文本，反过来**只走 `writeText`**（同一份内容两种真相才是问题）；
 * 3. **失败不留半成品**：暂存区整体删掉，落点要么完整要么不存在；
 * 4. **可信主机白名单不在本文件**（也不在 TS 任何地方）：出网判定唯一住在 Rust `market.rs`，
 *    Node 桥没有远程能力 ⇒ 抛错 ⇒ 显式 `failed`，**不降级去 `fetch()`**；
 * 5. **数据时间只记"什么时候拉的"**：内容真相只有 `index.json` 一份，存储域里不再存第二份列表。
 */

import {
  MARKET_CONTENT_DIR,
  MARKET_DEFAULT_INDEX_URL,
  MARKET_INDEX_FILE,
  MARKET_INDEX_TIMEOUT_MS,
  MARKET_INDEX_TTL_MS,
  MARKET_MANIFEST_FILE,
  MARKET_MAX_INDEX_BYTES,
  MARKET_PACKS_DIR,
  MARKET_STAGING_DIR,
  MarketError,
  SHA256_HEX_RE,
  dirname,
  endpointProblem,
  join,
  packIdKindConflicts,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketIndex,
  type MarketIndexEntry,
  type MarketIndexRefresh,
  type MarketIndexState,
  type MarketService,
  type PackKind,
  type PackRef,
  type RemoteService,
  type RemoteText,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { contentDigestOf, sha256Hex } from './digest';
import { parseIndex, parseManifest } from './manifest';

/** `ctx.storage`（域 = 本插件 id）里存已装清单的键 */
const INSTALLED_KEY = 'installed';
/** 注册表端点覆盖值（缺省 = 没有覆盖 = 用 `MARKET_DEFAULT_INDEX_URL`） */
const ENDPOINT_KEY = 'indexEndpoint';
/** 本机这份索引的拉取时刻（TTL 与"数据时间"的唯一真源；**不存内容**，内容只有 index.json 一份） */
const FETCHED_AT_KEY = 'indexFetchedAt';

export interface MarketServiceDeps {
  /** 内核 io（已过第一道闸；`rename`/`removeDir` 两端都要断言） */
  io: FileIO;
  /**
   * 远程取文本（`kernel.remote`）。**没它就没有索引刷新**——
   * 出网与读写文件是两种能力，故分键；白名单不住这里（唯一真源在平台侧）。
   */
  remote: RemoteService;
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

/** 错误 → 一句可诊断的话（平台桥 / JSON / IO 抛的都是 Error，非 Error 也不许变成 `undefined`） */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 存储域里的记录形状核（被人手改过也不崩，坏条目丢弃并出声） */
function isInstalledPack(v: unknown): v is InstalledPack {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o['kind'] !== 'string' ||
    typeof o['id'] !== 'string' ||
    typeof o['version'] !== 'string' ||
    typeof o['name'] !== 'string' ||
    typeof o['author'] !== 'string' ||
    typeof o['license'] !== 'string' ||
    typeof o['installedAt'] !== 'number' ||
    !SHA256_HEX_RE.test(String(o['contentDigest'])) ||
    !Array.isArray(o['files'])
  ) {
    return false;
  }
  // 容器摘要只有 zip 源才有；出现即必须是摘要形状（缺省合法）
  return o['containerSha256'] === undefined || SHA256_HEX_RE.test(String(o['containerSha256']));
}

export function createMarketService(deps: MarketServiceDeps): MarketService {
  const { io, remote, storage, log } = deps;
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

  /* ------------------------- 索引面（读 + 刷新 + 端点） ------------------------- */

  /** 盘上索引的唯一路径（内容只有这一份真相；`FETCHED_AT_KEY` 只记"什么时候拉的"） */
  const indexPath = join(deps.root, MARKET_INDEX_FILE);

  /** 读 + 解析的中间态（`index()` 的三态在它之上叠"唯一性查重"与"出声"） */
  type ParsedIndex =
    | { readonly kind: 'absent' }
    | { readonly kind: 'invalid'; readonly reason: string; readonly detail: string }
    | { readonly kind: 'parsed'; readonly index: MarketIndex; readonly dropped: readonly string[] };

  /** 索引文件的原始读结果（**不出声**——出声口径在 `readIndexState()`，装前查重不该把"没有索引"当错误报） */
  async function parseIndexFile(): Promise<ParsedIndex> {
    if (!(await io.exists(indexPath))) return { kind: 'absent' };
    let rawJson: unknown;
    try {
      rawJson = JSON.parse((await io.readText(indexPath)).text);
    } catch (err) {
      return {
        kind: 'invalid',
        reason: '列表文件读不出内容（JSON 坏了，或本机磁盘/权限读不动）',
        detail: errMessage(err),
      };
    }
    const { index, dropped } = parseIndex(rawJson);
    if (index === null) {
      return {
        kind: 'invalid',
        reason: '列表文件的形状不受支持（schema / generatedAt / packs 三项里有一项不合格）',
        detail: indexPath,
      };
    }
    return { kind: 'parsed', index, dropped };
  }

  async function readFetchedAt(): Promise<number | null> {
    const v = await storage.get<unknown>(FETCHED_AT_KEY);
    // 只认"过去某个时刻"：非有限值 / 非正数 / 未来的时间戳都不当数（时钟被改过也别装死）
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > now()) return null;
    return v;
  }

  /**
   * 契约 A4：同 id 异 kind 的条目一律不呈现（拒并出声，绝不"取一条"）。
   * 查重面 = 索引自身 + 已装集。**被剔掉的条目进 `dropped`**（铁律 4：冲突必须可见，
   * 不许像以前那样只留一句日志、面板上静默消失）。
   */
  async function dropIdKindConflicts(
    index: MarketIndex,
    dropped: readonly string[],
  ): Promise<{ index: MarketIndex; dropped: string[] }> {
    const refs: PackRef[] = [...index.packs, ...(await readRecords())];
    const ids = packIdKindConflicts(refs);
    if (ids.length === 0) return { index, dropped: [...dropped] };
    log.warn(
      `id-kind-conflict：${ids.length} 个包 id 同时挂在多个种类下（索引内部，或索引与已装集相冲），` +
        `这些条目全部不呈现、也不许被装 —— ${ids.join('、')}`,
    );
    const blocked = new Set(ids);
    const removed = index.packs.filter((p) => blocked.has(p.id));
    return {
      index: { ...index, packs: index.packs.filter((p) => !blocked.has(p.id)) },
      dropped: [...dropped, ...removed.map((p) => `${p.id}: id-kind-conflict（同名挂在多个种类下）`)],
    };
  }

  /** 三态判别联 + 出声（缺 / 坏 / 可用；可用时把被剔除条目一并带出） */
  async function readIndexState(): Promise<MarketIndexState> {
    const parsed = await parseIndexFile();
    if (parsed.kind === 'absent') {
      log.warn(`注册表索引不在位（本机还没拉过）：${indexPath}`);
      return { state: 'absent' };
    }
    if (parsed.kind === 'invalid') {
      log.warn(`注册表索引不可用：${indexPath} —— ${parsed.reason}（${parsed.detail}）`);
      return { state: 'invalid', reason: parsed.reason, detail: parsed.detail };
    }
    const kept = await dropIdKindConflicts(parsed.index, parsed.dropped);
    if (kept.dropped.length > 0) {
      log.warn(
        `注册表索引丢掉了 ${kept.dropped.length} 条（不呈现、不许装）：${kept.dropped.slice(0, 5).join('；')}`,
      );
    }
    return { state: 'ok', index: kept.index, dropped: kept.dropped, fetchedAt: await readFetchedAt() };
  }

  /** 生效端点：用户覆盖优先，否则契约默认值（**默认值只住契约常量**） */
  async function effectiveEndpoint(): Promise<string> {
    const v = await storage.get<unknown>(ENDPOINT_KEY);
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : MARKET_DEFAULT_INDEX_URL;
  }

  async function refreshIndex(opts?: { force?: boolean }): Promise<MarketIndexRefresh> {
    const url = await effectiveEndpoint();
    const problem = endpointProblem(url);
    if (problem !== null) {
      const reason = `注册表地址不合法：${problem}`;
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', reason, detail: url, index: await readIndexState() };
    }
    const previous = await readFetchedAt();
    if (opts?.force !== true && previous !== null && now() - previous < MARKET_INDEX_TTL_MS) {
      // TTL 窗口内**不回源**（开一次面板打一次 1.6 KB 也是打，但每次点开都打就没必要）
      return { state: 'cached', fetchedAt: previous, index: await readIndexState() };
    }
    let fetched: RemoteText;
    try {
      // 白名单 / 逐跳重核 / 体积 / 超时**全在平台侧**（Node 桥没有这项能力 ⇒ 抛错 ⇒ failed）
      fetched = await remote.fetchText(url, {
        timeoutMs: MARKET_INDEX_TIMEOUT_MS,
        maxBytes: MARKET_MAX_INDEX_BYTES,
      });
    } catch (err) {
      const reason = `从注册表拉列表没有成功：${errMessage(err)}`;
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', reason, detail: url, index: await readIndexState() };
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(fetched.text);
    } catch (err) {
      const reason = `注册表回来的内容不是合法 JSON：${errMessage(err)}`;
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', reason, detail: url, index: await readIndexState() };
    }
    const checked = parseIndex(rawJson);
    if (checked.index === null) {
      const reason = '注册表回来的列表形状不受支持（本机这份原样未动）';
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', reason, detail: url, index: await readIndexState() };
    }
    // 校验通过**才**覆盖：失败的刷新永远不许把好用的旧列表换成坏文件。
    // 写的是**原文**（一字不改的镜像）⇒ 坏条目留在盘上、每次读都重新报进 `dropped`，
    // 不在这里悄悄"洗成干净的"——洗掉 = 把注册表的问题藏起来。
    const stamped = now();
    try {
      await io.writeText(indexPath, fetched.text, { encoding: 'utf-8', eol: 'lf', backup: false });
    } catch (err) {
      const reason = `列表落盘失败：${errMessage(err)}`;
      log.warn(`${reason} —— ${indexPath}`);
      return { state: 'failed', reason, detail: indexPath, index: await readIndexState() };
    }
    await storage.set(FETCHED_AT_KEY, stamped);
    log.info(
      `注册表列表已更新（${checked.index.packs.length} 个包 / ${fetched.bytes} 字节）：${url}`,
    );
    return { state: 'refreshed', fetchedAt: stamped, index: await readIndexState() };
  }

  /**
   * 注册表不变量查重（契约 A4）：一个 `id` 只能属于一个 `kind`。
   * 查重面 = 已装集 + 索引**原样**（含坏条目剔掉之前的全部条目）；命中 ⇒ 调用方拒 + 出声。
   */
  async function findIdKindClash(ref: PackRef): Promise<PackRef | null> {
    const parsed = await parseIndexFile();
    const known: PackRef[] = [
      ...(await readRecords()),
      ...(parsed.kind === 'parsed' ? parsed.index.packs : []),
    ];
    return known.find((r) => r.id === ref.id && r.kind !== ref.kind) ?? null;
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
    const clash = await findIdKindClash({ kind: manifest.kind, id: manifest.id });
    if (clash !== null) {
      // 一个 id 只能属于一个 kind（tag `<id>-v<version>` 不含 kind ⇒ 撞了就是两份内容抢一个名）
      const detail = `${manifest.id}: ${clash.kind} vs ${manifest.kind}`;
      log.warn(`id-kind-conflict：拒绝安装 —— ${detail}`);
      throw new MarketError(
        'id-kind-conflict',
        `包 id ${manifest.id} 已经以「${clash.kind}」这个种类在用，不能再装成「${manifest.kind}」——同名不同类会让注册表 tag 相撞`,
        detail,
      );
    }
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
      // 本地目录源没有容器 ⇒ 只有折叠摘要；`containerSha256` 刻意不写（缺省即"无容器"）
      contentDigest: await contentDigestOf(manifest.files),
      installedAt: now(),
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

    index: readIndexState,

    refreshIndex,

    endpoint: effectiveEndpoint,

    async setEndpoint(url: string): Promise<void> {
      const trimmed = url.trim();
      if (trimmed === '') {
        // 空串 = 撤销覆盖 = 回到契约默认值（默认值只有契约常量一份，这里不复制）
        await storage.delete(ENDPOINT_KEY);
        log.info(`注册表地址已恢复默认：${MARKET_DEFAULT_INDEX_URL}`);
        return;
      }
      const problem = endpointProblem(trimmed);
      if (problem !== null) {
        throw new MarketError('endpoint-invalid', `注册表地址不合法：${problem}`, trimmed);
      }
      await storage.set(ENDPOINT_KEY, trimmed);
      log.info(`注册表地址已改为：${trimmed}`);
    },

    async installed(): Promise<InstalledPack[]> {
      const list = await readRecords();
      const alive: InstalledPack[] = [];
      const lost: string[] = [];
      for (const r of list) {
        // 落点**不存字段**（契约 A3）：按派生路径核，记账里没有第二份真相
        if (await io.exists(dirOf(r.kind, r.id, r.version))) alive.push(r);
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
