/**
 * `MarketService` 实现（KM-2 的落盘侧 + KM-8/KM-9 的索引面 + KM-10..12 的安装面）。
 *
 * 三条链路，**校验与搬运只有一条**：
 *
 * **装（本机目录源）**
 * ```
 * <sourceDir>/pack.json ── 全量校验（零写盘）──┐
 *                                              ├─ .staging/<id>-<version>/ ── 逐文件 sha256 复核
 *                                              │        （字节级 writeBytes，绝不 readText/writeText）
 *                                              └─ rename ──> packs/<kind>/<id>/<version>/
 * ```
 *
 * **装（注册表容器源 = `installFromIndex`）**
 * ```
 * zip.url ──marketDownload──> .staging/<id>-<version>.zip ── TS 复算 sha256 对平
 *                                  └──marketExtract──> .staging/<id>-<version>.unpacked/
 *                                            └── 双向对平（packContainerProblem）──┐
 *                                                                                  └─ 上面那条路径，一次调用都不多
 * ```
 * 容器源**不新写任何校验**：解出来的目录就是一个普通 sourceDir，交给同一个
 * `installFromManifestDir`（逐文件 sha256 复核、原子搬运、`.staging.__previous__` 回滚、
 * 记账全部沿用），只多带一份"事实"（容器摘要 + 解出的条目清单 + 注册表那一行的身份）。
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
 *    装包用的 `marketDownload` 与 `fetchText` 在 Rust 侧共用同一条 `guarded_send`（同一份闸）。
 *    本文件只多做一件纯形态的事：出网前用契约的 `endpointProblem` 拦掉"一看就打不开"的地址，
 *    让作者不联网也拿到一句人话——**这不是白名单**（白名单在平台侧，两处各写必然漂）。
 * 5. **数据时间只记"什么时候拉的"**：内容真相只有 `index.json` 一份，存储域里不再存第二份列表。
 */

import {
  MARKET_CONTENT_DIR,
  MARKET_DEFAULT_INDEX_URL,
  MARKET_INDEX_FILE,
  MARKET_INDEX_TIMEOUT_MS,
  MARKET_INDEX_TTL_MS,
  MARKET_MANIFEST_FILE,
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_INDEX_BYTES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_PACKS_DIR,
  MARKET_STAGING_DIR,
  MarketError,
  SHA256_HEX_RE,
  dirname,
  endpointProblem,
  join,
  marketDownloadTimeoutMs,
  packContainerName,
  packIdKindConflicts,
  packStagingName,
  packStagingNames,
  packStaleName,
  packUnpackedName,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketDownloadProgress,
  type MarketIndex,
  type MarketIndexEntry,
  type MarketIndexRefresh,
  type MarketIndexState,
  type MarketService,
  type PackKind,
  type PackManifest,
  type PackRef,
  type RemoteDownload,
  type RemoteDownloadOptions,
  type RemoteExtractLimits,
  type RemoteExtractResult,
  type RemoteService,
  type RemoteText,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { contentDigestOf, sha256Hex } from './digest';
import { packContainerProblem, parseIndex, parseManifest, type ContainerFacts } from './manifest';

/**
 * 清单变更通知的形状：**从契约 `MarketService` 的订阅面反推**，本文件不复制字段表。
 * （契约里那个具名类型没进 `plugin-api` 的出口清单，而出口清单本批不在可改面内；
 * 自己再写一遍 `{change,kind,id,version}` 就是第二份真相——反推写法让它跟着契约漂。）
 */
type MarketInstalledChange = Parameters<Parameters<MarketService['onInstalledChanged']>[0]>[0];

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
   * 远程面（`kernel.remote`）：索引取文本 + 容器下载/解压，**三条都在这一张面上**。
   * **没它就没有索引刷新、也没有从注册表装包**——
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

/**
 * 装包搬运的分批大小（2026-10-16 市场与导入 IO 批）。
 *
 * 与内核批量读的读批同量级（`kernel/src/io.ts` 的 `READ_BATCH_SIZE = 64`）：本数只决定
 * "一批几趟压成一条批量命令"，**不改任何逐文件的判定顺序**。取 64 而不是"整包一批"：
 * 上限是 5000 条目 / 128 MiB（契约 `MARKET_MAX_FILE_ENTRIES` / `MARKET_MAX_UNPACKED_BYTES`），
 * 一次全读进 JS 等于把包体上限当堆上限用，而解帧的同步段也随时线性涨。
 */
const COMMIT_CHUNK_SIZE = 64;

/** 按批切片（保持原序；批内顺序 = 清单顺序 ⇒ 拒因先后与逐文件形态一致） */
function* chunked<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
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

  /**
   * 已装清单变更的订阅者（MK-1 即时失效）。
   *
   * 通知的形状**从契约 `MarketService` 的订阅面反推**（`Parameters<…>`），本文件不另写
   * 一份字段表——契约的 `MarketInstalledChange` 没进 `plugin-api` 的出口清单（`index.ts`
   * 不在本批可改面内），而复制一份字段表正是全仓拦了两轮的那种第二份真相。
   *
   * 只有这一个数组：通知的**发出时机**由 `notifyInstalledChanged` 一处决定
   * （记账写完、Promise 落回调用方之前），装/卸的两条路径都只调它 ⇒
   * "什么时候该重取"不存在第二份口径（消费者也就不用自己猜时序）。
   */
  const installedListeners = new Set<(change: MarketInstalledChange) => void>();

  /**
   * 同步广播一次清单变更。**逐个隔离监听器抛错**（与内核总线同一条口径）：
   * 消费者自己的 bug 不许把一次**已经成功**的装卸倒过来变成失败——那等于作者看见
   * "没装上"而盘上明明有（本条正是 MK-1 要消灭的那类错位）。抛错必须出声（`log.warn`）。
   */
  function notifyInstalledChanged(
    change: MarketInstalledChange['change'],
    kind: PackKind,
    id: string,
    version: string,
  ): void {
    const event: MarketInstalledChange = { change, kind, id, version };
    for (const listener of [...installedListeners]) {
      try {
        listener(event);
      } catch (err: unknown) {
        log.warn(`已装清单变更的通知有一个消费者抛错（不影响本次装卸的结果）：${errMessage(err)}`);
      }
    }
  }

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

  /**
   * 已装记录的唯一核验口径：一趟批量 stat 核派生落点在位 → 剔除丢失条目 → 丢了就写回（自愈）。
   * `installed()` 与 `installedBytes()` 都走这一条 ⇒ 清单与占用两个读数永远同一份在位真相
   * （面板 `Promise.all` 并发双调会跑两趟 stat——批量 stat 是毫秒级，为此加缓存不值得）。
   */
  async function verifiedRecords(): Promise<InstalledPack[]> {
    const list = await readRecords();
    // 落点**不存字段**（契约 A3）：按派生路径核，记账里没有第二份真相。
    // 趟数形态（PERF-10b）：旧写法是 N 条记录 = N 趟串行 `await io.exists`，
    // 现在 N 条 = **一趟**批量 stat（内核侧按 512 分块走平台现成的 `statFiles` 命令，
    // 判定与 `exists` 同源：同一个 metadata/stat 调用、取不到一律 `exists:false`，不猜、不补位）。
    const dirs = list.map((r) => dirOf(r.kind, r.id, r.version));
    const stats = dirs.length === 0 ? [] : await io.statFiles(dirs);
    const alive: InstalledPack[] = [];
    const lost: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (stats[i]?.exists === true) alive.push(r);
      else lost.push(`${r.kind}/${r.id} v${r.version}`);
    }
    if (lost.length > 0) {
      log.warn(`已装清单里有 ${lost.length} 条目录已不在位，一并剔除：${lost.join('；')}`);
      await writeRecords(alive);
    }
    return alive;
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

  /**
   * 一次刷新周期内共享的「索引读」槽（PERF-10b）。
   *
   * **生命周期 = 一次 `refreshIndex()` 调用之内**（局部变量，随调用结束一起消失），
   * 全仓没有第二个持有者，也就没有"跨调用留一份索引在内存里"这种东西。
   */
  interface IndexReadSlot {
    /** 本周期已经读到的那一份；`undefined` = 还没读过 */
    memo?: Promise<ParsedIndex>;
  }

  /** 索引文件的原始读结果（**不出声**——出声口径在 `readIndexState()`，装前查重不该把"没有索引"当错误报） */
  async function readIndexFileOnce(): Promise<ParsedIndex> {
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

  /**
   * 读索引文件；给了 `slot` ⇒ **同一个刷新周期内只真读盘一次**，后来的读点复用那一份
   * （PERF-10b 要压掉的就是"一次刷新的多个分支各自 `exists`+`readText`+`JSON.parse`+查重 一遍"）。
   *
   * ⚠ **这不是缓存，也绝不许做成缓存**：`readIndexState` 同时是索引的**失效判据**来源
   * （契约 `MarketService.index()` 的三态就是"盘上这一份现在到底是什么样"）。
   * - **读到旧值的唯一情形**：同一个 `refreshIndex()` 调用内部、且这中间**没有发生过写盘**
   *   ——此时几个读点要的就是同一个事实，合并是刻意的（`writeText` 之后本槽立刻作废，见下）；
   * - **跨周期每次重读**：`index()`、装前查重（`findIdKindClash`）都不带 `slot`，
   *   两次 `refreshIndex()` 之间也不共享任何东西 ⇒ 外部改了 `index.json` 下一次一定读得到。
   */
  async function parseIndexFile(slot?: IndexReadSlot): Promise<ParsedIndex> {
    if (slot === undefined) return readIndexFileOnce();
    if (slot.memo === undefined) slot.memo = readIndexFileOnce();
    return slot.memo;
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
  async function readIndexState(slot?: IndexReadSlot): Promise<MarketIndexState> {
    const parsed = await parseIndexFile(slot);
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
    // 一次刷新的**读盘合并槽**：下面这些分支各自要盘上那份状态时只真读一次（PERF-10b）。
    // 它是本函数的局部量 ⇒ 出了这一次调用就作废，两次刷新之间不共享任何东西。
    const slot: IndexReadSlot = {};
    const url = await effectiveEndpoint();
    const problem = endpointProblem(url);
    if (problem !== null) {
      const reason = `注册表地址不合法：${problem}`;
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', stage: 'check', reason, detail: url, index: await readIndexState(slot) };
    }
    const previous = await readFetchedAt();
    if (opts?.force !== true && previous !== null && now() - previous < MARKET_INDEX_TTL_MS) {
      // TTL 窗口内**不回源**（开一次面板打一次 1.6 KB 也是打，但每次点开都打就没必要）
      return { state: 'cached', fetchedAt: previous, index: await readIndexState(slot) };
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
      return { state: 'failed', stage: 'check', reason, detail: url, index: await readIndexState(slot) };
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(fetched.text);
    } catch (err) {
      const reason = `注册表回来的内容不是合法 JSON：${errMessage(err)}`;
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', stage: 'check', reason, detail: url, index: await readIndexState(slot) };
    }
    const checked = parseIndex(rawJson);
    if (checked.index === null) {
      const reason = '注册表回来的列表形状不受支持（本机这份原样未动）';
      log.warn(`${reason} —— ${url}`);
      return { state: 'failed', stage: 'check', reason, detail: url, index: await readIndexState(slot) };
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
      return { state: 'failed', stage: 'check', reason, detail: indexPath, index: await readIndexState(slot) };
    }
    // 盘上刚换过一份 ⇒ 合并槽里那份立刻作废，下面这一次读**必须回盘**读到刚写的那一份
    // （不然"刷新成功却返回刷新前的旧列表"就是本次合并唯一可能引进的错，钉死在这里）。
    slot.memo = undefined;
    await storage.set(FETCHED_AT_KEY, stamped);
    log.info(
      `注册表列表已更新（${checked.index.packs.length} 个包 / ${fetched.bytes} 字节）：${url}`,
    );
    return { state: 'refreshed', fetchedAt: stamped, index: await readIndexState(slot) };
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

  /**
   * 源目录里的 `pack.json`：读 + 全量校验 + id/kind 查重。**此刻零写盘**（纪律 1）。
   *
   * 本机目录源与容器解出来的目录**共用这一句** ⇒ "什么算合法的包"全仓只有一份口径。
   */
  async function readSourceManifest(sourceDir: string): Promise<PackManifest> {
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
    return manifest;
  }

  /**
   * **本机目录源**（KM-2）：读清单 + 全量校验 → `commitPack`。
   * 目录源额外要求源目录里有 `files/` 子目录（zip 源由 `packContainerProblem` 的双向对平担保
   * 每一个清单条目都真在容器里，不需要再看目录本身）。
   */
  async function installLocalDir(sourceDir: string): Promise<InstalledPack> {
    const manifest = await readSourceManifest(sourceDir);
    if (!(await io.exists(join(sourceDir, MARKET_CONTENT_DIR)))) {
      throw new MarketError('content-missing', `源目录里没有 ${MARKET_CONTENT_DIR}/ 子目录：${sourceDir}`, sourceDir);
    }
    return commitPack(sourceDir, manifest);
  }

  /**
   * **唯一的搬运路径**（纪律 1/2/3 + KM-12 的回滚形态都住在这里，两个源共用）：
   * 逐文件字节级搬进 `.staging` → 逐文件重算 sha256 复核 → `rename` 原子搬进落点
   * （同版本重装 = 旧副本先搬进 `.staging` 再删）→ 清 `.staging` → `ctx.storage` 记账。
   *
   * `container` 只影响两件事：记账里多一个 `containerSha256`、以及**在写第一个字节之前**
   * 先做容器双向对平（`packContainerProblem`）。搬运与逐文件复核一步都不新增、不复制。
   */
  async function commitPack(
    sourceDir: string,
    manifest: PackManifest,
    container?: ContainerFacts,
  ): Promise<InstalledPack> {
    if (container !== undefined) {
      const problem = packContainerProblem(manifest, container);
      if (problem !== null) {
        log.warn(`容器与清单对不平（${problem.code}）：${problem.why}`);
        throw new MarketError(problem.code, `${problem.why}（注册表那一行：${container.declared.id} v${container.declared.version}）`, problem.detail);
      }
    }
    /* ---------- 2. 写进暂存区（字节级）+ 逐文件重算复核 ---------- */
    const staging = join(stagingRoot, packStagingName(manifest.id, manifest.version));
    const stale = join(stagingRoot, packStaleName(manifest.id, manifest.version));
    const target = dirOf(manifest.kind, manifest.id, manifest.version);
    await quietRemove(staging); // 上次崩在这里的残壳
    await quietRemove(stale);
    try {
      // 源侧：一批一趟读回字节（`readBytesMany`），逐个核字节数后写进暂存区。
      // `ensureDir(dirname(dst))` 那一趟删了：平台的写命令本来就 `create_dir_all` 父目录，
      // 而写允许域的判定对象是**落点文件本身**（`writeBytes` 已断言）——目录那趟从未参与判闸，
      // 却让每文件多付一次往返（旧形态合计 4N 趟读写）。
      for (const chunk of chunked(manifest.files, COMMIT_CHUNK_SIZE)) {
        const got = await io.readBytesMany(chunk.map((f) => join(sourceDir, f.path)));
        for (let k = 0; k < chunk.length; k++) {
          const f = chunk[k]!;
          const bytes = got[k] ?? null;
          if (bytes === null) {
            // 批量语义下失败位是 null（契约：不整批抛）；拒因与旧形态同一条码、同一句人话，
            // 底层为什么读不动由内核 io 的 warn 出声（此处不再逐文件重试一趟单读）
            throw new MarketError(
              'source-unreadable',
              `清单声明的文件在源目录里读不到：${f.path} —— 批量读回该位为失败`,
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
          await io.writeBytes(join(staging, f.path), bytes);
        }
      }
      // 暂存区读回算锚：哈希**必须**来自落盘那一份（源侧哈希会让"写的"与"核的"是两个东西）。
      // 这条读回是故意的，压趟只压"每文件一趟"的形态，不压"读谁"的语义。
      for (const chunk of chunked(manifest.files, COMMIT_CHUNK_SIZE)) {
        const got = await io.readBytesMany(chunk.map((f) => join(staging, f.path)));
        for (let k = 0; k < chunk.length; k++) {
          const f = chunk[k]!;
          const bytes = got[k] ?? null;
          if (bytes === null) {
            // 刚写回来的东西读不到 = 盘上出事，不是清单不符 ⇒ 抛普通错，
            // 由下面那条 catch 汇成 `install-move-failed`（与旧形态里 readBytes 抛错的落点一致）
            throw new Error(`暂存区的文件读不回来：${f.path}`);
          }
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
      // 逐文件锚的折叠摘要：两个源都有，且是"内容是不是同一份东西"的唯一答案
      contentDigest: await contentDigestOf(manifest.files),
      // 目录源没有容器 ⇒ `containerSha256` 刻意不写（缺省即"无容器"，也是"来源"的判据）
      ...(container === undefined ? {} : { containerSha256: container.sha256 }),
      installedAt: now(),
      files: manifest.files,
    };
    const rest = (await readRecords()).filter((r) => !samePack(r, record.kind, record.id, record.version));
    rest.push(record);
    await writeRecords(rest);
    log.info(`装好了 ${record.kind}/${record.id} v${record.version}（${record.files.length} 个文件）→ ${target}`);
    // MK-1：记账写完**立刻**出声（就在 Promise 落回调用方之前）——目录源的 `installLocalDir`
    // 与容器源的 `installFromIndex` 共用这条唯一搬运路径 ⇒ 通知点也只有一处。
    // 失败路径走不到这一行（上面任一 `throw` 都不落地，也就一声不出）。
    notifyInstalledChanged('installed', record.kind, record.id, record.version);
    return record;
  }

  /**
   * 清掉容器源留在暂存区的两样东西（容器文件 + 解压目录），成功与失败走同一条。
   *
   * `FileIO` 只暴露 `removeDir`（递归删**目录**），而容器是一个**文件** ⇒ 先把它搬进
   * 那棵要整棵删掉的解压目录，一次 `removeDir` 清两样；不为市场给内核加一条删文件原语。
   * 搬运失败就单独出声（暂存区会留下 `<id>-<version>.zip`），但**绝不抛**——
   * 清理永远不该盖住主错误（照 `quietRemove` 的口径）。
   */
  async function quietRemoveContainer(containerName: string, unpackedDir: string): Promise<void> {
    const containerPath = join(stagingRoot, containerName);
    try {
      if (await io.exists(containerPath)) {
        await io.ensureDir(unpackedDir);
        await io.rename(containerPath, join(unpackedDir, containerName));
      }
    } catch (err) {
      log.warn(`暂存区里的容器没能搬进解压目录（下一次装同一个包会原样覆盖它）：${containerName} —— ${errMessage(err)}`);
    }
    await quietRemove(unpackedDir);
  }

  /**
   * **注册表容器源**（KM-10..12）：下载 → 容器整包摘要对平 → 解压 → 读清单 → 双向对平
   * → **`commitPack`（与目录源同一条校验+搬运路径，一个环节都不重写）**。
   *
   * 三条只在容器源出现的口径：
   * - 体积上限取**索引声明的 `zip.bytes`**（平台侧的 Content-Length 预核与逐块累计都按这把尺
   *   ⇒ 比声明多一个字节就不收），但声明本身可以撒谎，故再与 `MARKET_MAX_UNPACKED_BYTES` 取小；
   * - **哈希只在 TS 算**（`sha256Hex` 是全仓唯一实现点；宿主层算哈希有机器闸拦着）；
   * - 任何一步失败 ⇒ 暂存区里这一次的容器与解出目录全部删掉，落点要么完整要么不存在。
   */
  async function installFromIndex(
    entry: MarketIndexEntry,
    onProgress?: (p: MarketDownloadProgress) => void,
  ): Promise<InstalledPack> {
    const containerName = packContainerName(entry.id, entry.version);
    const unpackedName = packUnpackedName(entry.id, entry.version);
    const unpackedDir = join(stagingRoot, unpackedName);
    try {
      // 0) 形态闸（零网络、与端点共用同一份 `endpointProblem`）：先让作者拿到一句人话。
      //    **这不是白名单**——哪些地址可信只由平台侧那一条链路决定（两份必然漂）。
      const urlProblem = endpointProblem(entry.zip.url);
      if (urlProblem !== null) {
        throw new MarketError('download-failed', `容器地址不合法：${urlProblem}`, entry.zip.url);
      }

      /* ---------- 1. 下载容器（落点由平台侧在暂存区内自己拼） ---------- */
      // 体积上限与超时都从**同一份**声明换算：上限 = 声明与解压上限取小（撒谎的声明换不来
      // 无上限下载），超时 = `marketDownloadTimeoutMs`（慢网直连 ~1MB/s ⇒ 每 MiB 1s 预算）。
      const maxBytes = Math.min(entry.zip.bytes, MARKET_MAX_UNPACKED_BYTES);
      let downloaded: RemoteDownload;
      try {
        downloaded = await remote.marketDownload(entry.zip.url, containerName, {
          maxBytes,
          timeoutMs: marketDownloadTimeoutMs(maxBytes),
          // 进度只透传（节流在平台侧），本层不加工；解压/搬运快，不发进度
          onProgress,
        });
      } catch (err) {
        throw new MarketError('download-failed', `容器没能从注册表取回来：${errMessage(err)}`, entry.zip.url);
      }
      let blob: Uint8Array;
      try {
        blob = await io.readBytes(join(stagingRoot, containerName));
      } catch (err) {
        throw new MarketError('download-failed', `容器落盘后读不出来：${errMessage(err)}`, containerName);
      }
      if (blob.length !== entry.zip.bytes || downloaded.bytes !== entry.zip.bytes) {
        throw new MarketError(
          'container-bytes',
          `容器字节数与注册表声明不符：下载回报 ${downloaded.bytes}B、盘上 ${blob.length}B，那一行写的是 ${entry.zip.bytes}B`,
          `${downloaded.bytes}/${blob.length}/${entry.zip.bytes}`,
        );
      }
      // 整包锚：容器本体与注册表钉的那一份是同一个文件（逐文件锚在下面那条路径里核）
      const hex = await sha256Hex(blob);
      if (hex !== entry.zip.sha256) {
        throw new MarketError(
          'container-sha256',
          `容器整包摘要与注册表不符（下载回来的不是那一行说的包）：期望 ${entry.zip.sha256}，实算 ${hex}`,
          containerName,
        );
      }

      /* ---------- 2. 解压到暂存子树（限额三个数全取契约常量，平台侧不写死） ---------- */
      const limits: RemoteExtractLimits = {
        maxEntries: MARKET_MAX_FILE_ENTRIES,
        maxDepth: MARKET_MAX_PATH_DEPTH,
        maxUnpackedBytes: MARKET_MAX_UNPACKED_BYTES,
      };
      let extracted: RemoteExtractResult;
      try {
        extracted = await remote.marketExtract(containerName, unpackedName, limits);
      } catch (err) {
        throw new MarketError('extract-failed', `容器解压没有成功：${errMessage(err)}`, containerName);
      }

      /* ---------- 3. 读清单 + 双向对平 + 搬运：与目录源同一条路径 ---------- */
      const manifest = await readSourceManifest(unpackedDir);
      return await commitPack(unpackedDir, manifest, {
        sha256: hex,
        entries: extracted.entries,
        declared: entry,
      });
    } finally {
      await quietRemoveContainer(containerName, unpackedDir);
    }
  }

  return {
    async rootDir(): Promise<string> {
      return deps.root;
    },

    /**
     * 契约面**不接受任何入参**（`MarketService.index()`）：不直接写 `readIndexState` 是为了
     * 不让"外来的第一个实参"意外变成一个刷新作用域（带 slot 就会复用那一次读，而契约要的是每次现读）。
     */
    index: (): Promise<MarketIndexState> => readIndexState(),

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
      return verifiedRecords();
    },

    installLocalDir,

    installFromIndex,

    async installedBytes(): Promise<number> {
      // 口径：**核验在位**的各包 files 声明字节之和。`pack.json` 的 `files[]` 只列 `files/`
      // 之内的条目（契约 `packEntryPathProblem` 的前缀闸保证这一点），所以这个数**就是落点的
      // 内容字节**——不摸盘逐文件求和（摸盘那份会跟真实目录漂）；在位与否只信 `verifiedRecords`
      // 那一趟批量 stat，目录已丢的包不计入（与 `installed()` 同一条核验、同一次自愈写回）。
      let total = 0;
      for (const r of await verifiedRecords()) {
        for (const f of r.files) total += f.bytes;
      }
      return total;
    },

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
      // KM-11：卸完不许在暂存区留下这个包的任何残壳（崩在半路的容器 / 解压目录 / 回滚副本）。
      // 名字全部由契约派生 ⇒ 这里是一张表而不是四条抄写；只碰这一个 id-version，
      // 不动别人的暂存条目（并发装同一个包本来就会被 `commitPack` 的残壳清扫覆盖）。
      for (const name of packStagingNames(id, version)) await quietRemove(join(stagingRoot, name));
      if (hadDir) {
        log.info(`卸掉了 ${kind}/${id} v${version}：${dir}`);
      } else {
        log.warn(`卸掉了 ${kind}/${id} v${version}（目录本来就不在位，只清了清单条目）`);
      }
      // MK-1：清单与盘都清完了 ⇒ 立刻作废消费者的显示（上面那条 `installed-missing` 的
      // 早退路径不到这里：什么都没动，自然不该有一次重取）。
      notifyInstalledChanged('uninstalled', kind, id, version);
    },

    /**
     * 订阅已装清单变更（契约面）。退订句柄幂等：重复调用只摘一次，摘掉后不再收。
     *
     * ⚠ `verifiedRecords()` 的**自愈**（目录丢失 ⇒ 清单剔除并写回）刻意**不**走这里：
     * 自愈发生在"有人来读"的那一刻，从读路径里再发一次通知 = 通知又触发一次读（自激环）。
     * 消费者的这一次读数本身就是最新真相，不需要再被通知一次。
     */
    onInstalledChanged(listener: (change: MarketInstalledChange) => void): () => void {
      installedListeners.add(listener);
      return (): void => {
        installedListeners.delete(listener);
      };
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
