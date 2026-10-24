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
  MARKET_DEFAULT_PUBLISH_URL,
  MARKET_INDEX_FILE,
  MARKET_INDEX_TIMEOUT_MS,
  MARKET_INDEX_TTL_MS,
  MARKET_MANIFEST_FILE,
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_INDEX_BYTES,
  MARKET_MAX_CONTAINER_UPLOAD_BYTES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_PACKS_DIR,
  MARKET_SCHEMA_VERSION,
  MARKET_STAGING_DIR,
  MarketError,
  SHA256_HEX_RE,
  buildZip,
  coreVersion,
  dirname,
  endpointProblem,
  join,
  marketDownloadTimeoutMs,
  marketPublishTimeoutMs,
  packContainerName,
  packEntryPathProblem,
  packIdKindConflicts,
  packStagingName,
  packStagingNames,
  packStaleName,
  packUnpackedName,
  readZipContainer,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketDownloadProgress,
  type MarketIndex,
  type MarketIndexEntry,
  type MarketIndexRefresh,
  type MarketIndexState,
  type MarketPackDraft,
  type MarketPublishManifestSummary,
  type MarketPublishOutcome,
  type MarketPublishPackOpts,
  type MarketPublishProgress,
  type MarketService,
  type MarketZipInspection,
  type OpJournal,
  type PackFileEntry,
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
  type ZipEntry,
} from '@kojo/plugin-api';
import { inspectAuthorZip } from './author-zip';
import { contentDigestOf, sha256Hex, utf8Bytes } from './digest';
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
/** 设备令牌在存储域里的键（令牌由平台侧 `POST /device-token` 换出，本文件只存取、不解释） */
const DEVICE_TOKEN_KEY = 'deviceToken';
/**
 * 发布预校验的暂存名（**固定名**）。预校验 = 把用户选定的 zip 复制进自家暂存区再解
 * （解压原语只认暂存区容器），名字不随 id/version 走——那两样在 zip 里、此刻还不知道。
 * 固定名 ⇒ 并发发布会互踩，这是**接受的**：发布是单面板串行动作，且上一次的残壳
 * 下一次进来先被覆盖/清扫（`finally` 全清），不留跨次污染。
 */
const PUBLISH_PREVIEW_CONTAINER = 'publish-preview.zip';
const PUBLISH_PREVIEW_UNPACKED = 'publish-preview.unpacked';

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
  /**
   * 批操作 journal（2026-10-18 undo 覆盖批，additive 可选）：在场时装 / 卸整包进账，
   * OpsHistoryOverlay 可整批撤销；缺席 = 旧的不进账行为（旧内核兼容）。
   */
  journal?: Pick<OpJournal, 'begin' | 'record' | 'commit' | 'abort'>;
}

function samePack(r: InstalledPack, kind: PackKind, id: string, version: string): boolean {
  return r.kind === kind && r.id === id && r.version === version;
}

/** 错误 → 一句可诊断的话（平台桥 / JSON / IO 抛的都是 Error，非 Error 也不许变成 `undefined`） */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 发布预校验里"解压失败"的作者面人话（纯函数，单测直接钉两种错误串）。
 *
 * `entry-name-encoding` 是最常见、也最可执行的一类：Windows 自带压缩 / 7-Zip 默认参数
 * 不置 UTF-8 标志位（bit 11），条目名会被按 CP437 解成乱码（作者看到的是乱码路径）。
 * 此时要告诉作者**怎么办**（换支持 UTF-8 文件名的工具重压，或直接走工作区发布），
 * 而不是只说"打不开"。原始诊断（含拒因码）留在末尾——真正的解析错误一个都不吞。
 * 其余失败沿用既有"不是合法的发布容器"一句。
 */
export function extractFailureMessage(err: unknown): string {
  const raw = errMessage(err);
  if (raw.includes('entry-name-encoding')) {
    return (
      '这个 zip 的文件名不是 UTF-8（Windows 压缩工具/7-Zip 常见）。' +
      '请用支持 UTF-8 文件名的工具重新压缩（7-Zip 可加 -mcu=on），或直接在编辑器里从工作区发布。' +
      `（原始错误：${raw}）`
    );
  }
  return `这个包打不开（不是合法的发布容器）：${raw}`;
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
  const { io, remote, storage, log, journal } = deps;
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
    | {
        readonly kind: 'parsed';
        readonly index: MarketIndex;
        readonly dropped: readonly string[];
        readonly coverIgnored: readonly string[];
      };

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
    const { index, dropped, coverIgnored } = parseIndex(rawJson);
    if (index === null) {
      return {
        kind: 'invalid',
        reason: '列表文件的形状不受支持（schema / generatedAt / packs 三项里有一项不合格）',
        detail: indexPath,
      };
    }
    return { kind: 'parsed', index, dropped, coverIgnored };
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
    coverIgnored: readonly string[],
  ): Promise<{ index: MarketIndex; dropped: string[]; coverIgnored: readonly string[] }> {
    const refs: PackRef[] = [...index.packs, ...(await readRecords())];
    const ids = packIdKindConflicts(refs);
    if (ids.length === 0) return { index, dropped: [...dropped], coverIgnored };
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
    const kept = await dropIdKindConflicts(parsed.index, parsed.dropped, parsed.coverIgnored);
    if (kept.dropped.length > 0) {
      log.warn(
        `注册表索引丢掉了 ${kept.dropped.length} 条（不呈现、不许装）：${kept.dropped.slice(0, 5).join('；')}`,
      );
    }
    return {
      state: 'ok',
      index: kept.index,
      dropped: kept.dropped,
      coverIgnored: kept.coverIgnored,
      fetchedAt: await readFetchedAt(),
    };
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
    // 装包整批进 OpJournal（2026-10-18 undo 覆盖批，additive 可选）：动盘之前 begin，
    // 失败 ⇒ 整个安装取消（装得上却撤不回的批量写不做——与部署 / 批量替换同口径）。
    const opId = journal !== undefined
      ? await journal.begin(
          'market-install',
          `安装市场包 ${manifest.name} ${manifest.kind}/${manifest.id} v${manifest.version}（${manifest.files.length} 个文件）`,
        )
      : null;
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
      // rename 前对最终落点逐文件记账（2026-10-18 undo 覆盖批）：新装 = 全部 before=null
      // （undo 即整包删除）；重装 = 抓旧版本字节（undo 恢复旧版）。只记 manifest.files——
      // pack.json 是包内容的唯一真源，超出清单的文件本就是异常态，不为它们猜测性快照。
      if (opId !== null) {
        for (const f of manifest.files) await journal!.record(opId, join(target, f.path));
      }
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
      // 到这里安装已成定局：commit 进历史（OpsHistoryOverlay 可整批撤销 / 重装恢复旧版）。
      // commit 失败：包已装好、storage 记账照写 ⇒ 不回滚不抛错，log.warn 出声
      // （open 态残留由 journal 的 list() 巡检点名）。
      if (opId !== null) {
        await journal!.commit(opId).catch((err: unknown) => {
          log.warn(
            `市场包已装好但批操作收尾失败（本批不可撤销，快照已保留待人工处置）：` +
              `${manifest.id} v${manifest.version} — ${String(err)}`,
          );
        });
      }
    } catch (err) {
      if (opId !== null) {
        try {
          // 半途而废：abort 逆序回滚落点侧的已记账条目（新装未到落点 = 空操作；
          // 重装 = 还原旧字节——abort 对"新建条目实际不在盘上"本身容忍）。
          await journal!.abort(opId);
        } catch (abortErr: unknown) {
          // 主错与回滚失败都要见人（半批态 + 快照保留待人工处置——契约：宁可吵不可静默）
          const main = err instanceof MarketError ? err.message : String(err);
          const why = abortErr instanceof Error ? abortErr.message : String(abortErr);
          if (err instanceof MarketError) {
            throw new MarketError(err.code, `${main}（且回滚失败，快照已保留待人工处置：${why}）`, err.detail);
          }
          throw new MarketError('install-move-failed', `安装失败：${main}（且回滚失败，快照已保留待人工处置：${why}）`, target);
        }
      }
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

  /* --------------------- 发布面（2026-10-16 发布通道批） --------------------- */

  /**
   * 预览一个用户选定的 zip（ZIP-1，2026-10-18）：根有 `pack.json` ⇒ 市场容器，原样走
   * `publish`；否则按普通作品包在**内存里**解出（不落盘、不改源文件），交给发布向导补元数据。
   *
   * 这里刻意**不**调用 `previewForPublish` 的严格解包：普通作品包会有中文/日文 CP932 条目名、
   * 显式目录条目和一层包裹文件夹，严格解包第一条就会以 `entry-name-encoding` 拒。
   * 宽松读取的路径/限额闸仍复用同一份契约原语（见 `author-zip.ts`）。
   */
  async function inspectZip(zipPath: string): Promise<MarketZipInspection> {
    const stat = await io.stat(zipPath);
    if (stat === null || stat.isDirectory) {
      throw new MarketError('source-unreadable', `要发布的 zip 读不到：${zipPath}`, zipPath);
    }
    if (stat.size > MARKET_MAX_CONTAINER_UPLOAD_BYTES) {
      throw new MarketError(
        'bytes-limit',
        `这个 zip 有 ${stat.size} 字节，超过发布上限 ${MARKET_MAX_CONTAINER_UPLOAD_BYTES} 字节；请先瘦身。`,
        zipPath,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await io.readBytes(zipPath);
    } catch (err) {
      throw new MarketError('source-unreadable', `这个 zip 读不出来：${errMessage(err)}`, zipPath);
    }
    let container: ReturnType<typeof readZipContainer>;
    try {
      container = readZipContainer(bytes);
    } catch (err) {
      throw new MarketError(
        'extract-failed',
        `这个 zip 读不出来（不是完整可读的 zip）：${errMessage(err)}`,
        zipPath,
      );
    }
    // 根有 pack.json 就按市场容器走原链路（清单校验仍只有 previewForPublish 那一份）
    if (container.entries.some((e) => e.name.replaceAll('\\', '/') === MARKET_MANIFEST_FILE)) {
      return { kind: 'market-container', bytes: stat.size };
    }
    try {
      const inspected = await inspectAuthorZip(container);
      return {
        kind: 'author-package',
        files: inspected.files,
        bytes: stat.size,
        skipped: inspected.skipped,
        ...(inspected.strippedRoot === undefined ? {} : { strippedRoot: inspected.strippedRoot }),
      };
    } catch (err) {
      if (err instanceof MarketError) throw err;
      throw new MarketError('extract-failed', `这个 zip 解不开：${errMessage(err)}`, zipPath);
    }
  }

  async function readDeviceToken(): Promise<string | null> {
    const v = await storage.get<unknown>(DEVICE_TOKEN_KEY);
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  /**
   * 发布的**本地预校验**（零出网）：把用户选定的 zip 复制进自家暂存区 → 平台解压原语
   * → `pack.json` 全量校验（**与安装同一条** `readSourceManifest`——schema/字段/路径/限额/
   * id-kind 查重全在里面，不出现第二份校验）→ 容器与清单**双向对平**（`packContainerProblem`，
   * `declared` 用这份容器的**真事实**现造：kind/id/version 取自解出的清单本身 ⇒ identity 判定
   * 恒真不是漏洞——对平要抓的是"清单声明与 zip 实际内容不符"）。
   *
   * zip 原文件**一个字节不动**（复制体才被解）；暂存痕迹由调用方的 `finally` 全清
   * （`quietRemoveContainer` 同一条）。拒因全部来自既有清单类码——人话与安装面逐字一致。
   *
   * **发布面的两句拒因要面向作者**：`manifest-missing` / `content-missing` 由这里重新包装，
   * 说"这个 zip 不是市场发布格式"并指向工作区发布，**不许把 `.staging` 内部路径漏给作者**
   * （作者拿普通作品包 zip 选进来是最常见的误用）。`detail` 也改指作者选定的那个 zip。
   */
  async function previewForPublish(
    zipPath: string,
  ): Promise<{ summary: MarketPublishManifestSummary; bytes: number }> {
    const stat = await io.stat(zipPath);
    if (stat === null || stat.isDirectory) {
      throw new MarketError('source-unreadable', `要发布的包文件读不到：${zipPath}`, zipPath);
    }
    if (stat.size > MARKET_MAX_CONTAINER_UPLOAD_BYTES) {
      throw new MarketError(
        'bytes-limit',
        `包体 ${stat.size} 字节超过发布上限 ${MARKET_MAX_CONTAINER_UPLOAD_BYTES}（CF 免费档边缘请求体上限 100,000,000 字节，本地上限留整 1 MB 余量），先瘦身再发——超限包过不了 CF 边缘，别浪费流量`,
        zipPath,
      );
    }
    const containerPath = join(stagingRoot, PUBLISH_PREVIEW_CONTAINER);
    const unpackedDir = join(stagingRoot, PUBLISH_PREVIEW_UNPACKED);
    await quietRemove(unpackedDir); // 上一次的解压残壳（容器残壳由 copyFile 覆盖）
    try {
      await io.copyFile(zipPath, containerPath);
      let extracted: RemoteExtractResult;
      try {
        extracted = await remote.marketExtract(
          PUBLISH_PREVIEW_CONTAINER,
          PUBLISH_PREVIEW_UNPACKED,
          { maxEntries: MARKET_MAX_FILE_ENTRIES, maxDepth: MARKET_MAX_PATH_DEPTH, maxUnpackedBytes: MARKET_MAX_UNPACKED_BYTES },
        );
      } catch (err) {
        throw new MarketError('extract-failed', extractFailureMessage(err), zipPath);
      }
      let manifest: PackManifest;
      try {
        manifest = await readSourceManifest(unpackedDir);
      } catch (err) {
        if (err instanceof MarketError && err.code === 'manifest-missing') {
          // 作者面重新包装：内部暂存路径不出场，并告诉作者下一步（工作区发布）
          throw new MarketError(
            'manifest-missing',
            '这个 zip 不是市场发布格式：根目录缺少 pack.json。如果它是普通作品包，请在发布向导里重新选择它（编辑器会解出内容让你补包信息），或从工作区直接发布。',
            zipPath,
          );
        }
        throw err;
      }
      // pack.json 在、files/ 却缺失 = 不是完整的市场容器。只在清单**声明了内容文件**时改判
      // （此时逐文件对平必然 entry-missing，本判据只是把话说明白，不改变任何成功/失败判定）；
      // 空清单容器维持原样，交给后面的容器对平。
      if (manifest.files.length > 0 && !(await io.exists(join(unpackedDir, MARKET_CONTENT_DIR)))) {
        throw new MarketError(
          'content-missing',
          `这个 zip 不是完整的市场容器：pack.json 在，但缺少 ${MARKET_CONTENT_DIR}/ 目录（没有可发布的内容）。` +
            '普通作品包请在发布向导里重新选择它，或从工作区直接发布。',
          zipPath,
        );
      }
      const blob = await io.readBytes(containerPath);
      const hex = await sha256Hex(blob);
      const declared: MarketIndexEntry = {
        kind: manifest.kind,
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        author: manifest.author,
        license: manifest.license,
        minAppVersion: manifest.minAppVersion,
        zip: { url: '', sha256: hex, bytes: blob.length },
        fileCount: manifest.files.length,
        unpackedBytes: manifest.files.reduce((s, f) => s + f.bytes, 0),
      };
      const problem = packContainerProblem(manifest, { sha256: hex, entries: extracted.entries, declared });
      if (problem !== null) {
        log.warn(`发布预校验：容器与清单对不平（${problem.code}）：${problem.why}`);
        throw new MarketError(problem.code, `这个包发不出去：${problem.why}`, problem.detail);
      }
      return {
        summary: {
          kind: manifest.kind,
          id: manifest.id,
          version: manifest.version,
          name: manifest.name,
          author: manifest.author,
        },
        bytes: stat.size,
      };
    } finally {
      await quietRemoveContainer(PUBLISH_PREVIEW_CONTAINER, unpackedDir);
    }
  }

  /**
   * **发布编排**（契约 `MarketService.publish`）：
   * 能力闸 + 端点形态闸（零网络）→ 设备令牌（storage 复用，缺则平台换一枚并落存储）
   * → 本地预校验（`previewForPublish`，零出网）→ 平台发布原语（zip 原样字节上传、进度透传，
   * 节流在平台侧）。后端**明确拒绝**不是异常（返回 rejected 分支）；平台侧故障抛错带人话。
   *
   * `zipPath` 必须来自**用户经系统对话框选定的文件**（对话框即授权，照 `exportFile`
   * 的哲学——不是游戏目录扫盘）。欠账已清（2026-10-16 发布面板批）：桥已补
   * `FileIO.chooseFile`（additive 可选，只选不读不写），ui-market 面板经它选 zip。
   */
  async function publish(
    zipPath: string,
    opts?: { endpoint?: string; onProgress?: (p: MarketPublishProgress) => void },
  ): Promise<MarketPublishOutcome> {
    if (remote.marketPublish === undefined || remote.marketDeviceToken === undefined) {
      throw new Error('当前平台没有发布能力（发布通道需要桌面壳）');
    }
    const endpoint = (opts?.endpoint ?? MARKET_DEFAULT_PUBLISH_URL).trim();
    const shapeProblem = endpointProblem(endpoint);
    if (shapeProblem !== null) {
      throw new MarketError('endpoint-invalid', `发布地址不合法：${shapeProblem}`, endpoint);
    }
    let token = await readDeviceToken();
    if (token === null) {
      let fetched: string;
      try {
        fetched = await remote.marketDeviceToken(endpoint);
      } catch (err) {
        throw new Error(`设备令牌没拿到（无法发布）：${errMessage(err)}`);
      }
      await storage.set(DEVICE_TOKEN_KEY, fetched);
      token = fetched;
    }
    const preview = await previewForPublish(zipPath);
    try {
      return await remote.marketPublish(zipPath, preview.summary, token, {
        endpoint,
        maxBytes: MARKET_MAX_CONTAINER_UPLOAD_BYTES,
        timeoutMs: marketPublishTimeoutMs(preview.bytes),
        onProgress: opts?.onProgress,
      });
    } catch (err) {
      throw new Error(`发布没有成功：${errMessage(err)}`);
    }
  }

  /* --------------- 「发布口上」：从作者工作区草案现打包（用户反馈 4 批） --------------- */

  /**
   * 草案临时容器的序号。
   *
   * 临时名**不掺 id / version**：那两样此刻还没过校验（可能带任意字符），拿来做文件名
   * 等于先让一个未验证的字符串参与路径拼接；名字只用 `[a-z0-9._-]` 的安全字符，
   * 唯一性靠时间戳 + 序号。它与 `PUBLISH_PREVIEW_CONTAINER` 不同名 ⇒ 预校验复制那一步
   * 不会覆盖草案容器本身。
   */
  let publishDraftSeq = 0;

  /** 删一个**文件**（`quietRemove` 只管目录）：清理失败只出声，绝不盖住主错误 */
  async function quietRemoveFile(path: string): Promise<void> {
    try {
      if (await io.exists(path)) await io.removeFile(path);
    } catch (err) {
      log.warn(`清理草案容器失败（不影响本次结果）：${path} —— ${errMessage(err)}`);
    }
  }

  /**
   * 草案 → `PackManifest`（**逐文件 sha256 在这里算**，字节就是调用方交上来的那一份）。
   *
   * 字段装配与 `parseManifest` 的必填面一一对应；`minAppVersion` 缺省取
   * `coreVersion(deps.appVersion)`（`0.4.0-beta.1` → `0.4.0`，与安装面同一条口径）。
   * 本函数不做**任何拒绝判定**——形状合不合法由随后 `previewForPublish` 里的
   * `parseManifest` / `packFilesProblem` 说了算（唯一一份校验）。
   */
  async function manifestOfDraft(draft: MarketPackDraft): Promise<PackManifest> {
    const files: PackFileEntry[] = [];
    for (const f of draft.files) {
      files.push({
        // 前缀在这里补一次（调用方只给相对 files/ 的路径）
        path: `${MARKET_CONTENT_DIR}/${f.path}`,
        bytes: f.bytes.length,
        sha256: await sha256Hex(f.bytes),
      });
    }
    const manifest: PackManifest = {
      schema: MARKET_SCHEMA_VERSION,
      kind: draft.kind,
      id: draft.id,
      version: draft.version,
      name: draft.name,
      author: draft.author,
      license: draft.license,
      redistribute: draft.redistribute,
      minAppVersion: draft.minAppVersion ?? coreVersion(deps.appVersion),
      files,
    };
    // 可选字段"有才给"：缺省不写空串（空串是"作者填了空"，与"没这一项"不是一回事）
    if (draft.summary !== undefined) manifest.summary = draft.summary;
    if (draft.sourceUrl !== undefined) manifest.sourceUrl = draft.sourceUrl;
    if (draft.gameId !== undefined) manifest.gameId = draft.gameId;
    return manifest;
  }

  /**
   * **从工作区草案现打包并发布**（契约 `MarketService.publishPack`）。
   *
   * 流程：草案路径形态轻检（防拼出会让解包端歧义的条目）→ 逐文件 sha256 + `pack.json`
   * → `buildZip`（`contract: 'extractable'`，违例在写第一个字节前抛）→ 写进自家暂存区
   * 的唯一临时名 → **调用既有的 `publish(zipPath)`**（预校验 / 令牌 / 上传一条链路，
   * 一个环节都不重写）→ `finally` 删临时容器（成功失败都不留残壳）。
   *
   * 关于那一步"轻检"：判据就是契约的 `packEntryPathProblem` 本身（先补 `files/` 前缀
   * 再判），**不是第二套校验**——真正的权威拒绝仍发生在 `previewForPublish` 里的
   * `parseManifest`（同一个函数、同一张码表）。在这里先拦一道，只是因为条目名一旦
   * 长得像 `..`，`buildZip` 会在压缩前抛**普通 Error**（没有市场拒因码），
   * 而作者面需要的是与安装面同一句人话、同一个码。
   *
   * 0 个文件的草案直接拒：`packFilesProblem([])` 合法（空数组不违规），空包能一路
   * 上传到后端才被发现"发出去没有内容"，那不叫校验、叫浪费作者流量。
   */
  async function publishPack(
    draft: MarketPackDraft,
    opts?: MarketPublishPackOpts,
  ): Promise<MarketPublishOutcome> {
    if (draft.files.length === 0) {
      throw new MarketError(
        'content-missing',
        `「${draft.name}」里一个文件都没有，发出去也没有内容——先往包里写口上文件再发布`,
        draft.id,
      );
    }
    const seen = new Set<string>();
    for (const f of draft.files) {
      if (f.path === MARKET_CONTENT_DIR || f.path.startsWith(`${MARKET_CONTENT_DIR}/`)) {
        throw new MarketError(
          'path-prefix',
          `文件路径不要以 ${MARKET_CONTENT_DIR}/ 开头（服务会自动补前缀）：${f.path}`,
          f.path,
        );
      }
      const problem = packEntryPathProblem(`${MARKET_CONTENT_DIR}/${f.path}`);
      if (problem !== null) {
        throw new MarketError(
          problem,
          `这个包里有个文件路径不合法（${problem}）：${f.path}`,
          f.path,
        );
      }
      if (seen.has(f.path)) {
        throw new MarketError('entry-duplicate', `同一个路径在包里出现了两次：${f.path}`, f.path);
      }
      seen.add(f.path);
    }

    const manifest = await manifestOfDraft(draft);
    // 容器结构：根 `pack.json` + 全部内容条目（顺序 = 草案顺序，便于作者对照）
    const entries: ZipEntry[] = [
      { name: MARKET_MANIFEST_FILE, data: utf8Bytes(JSON.stringify(manifest, null, 2)) },
      ...draft.files.map((f) => ({ name: `${MARKET_CONTENT_DIR}/${f.path}`, data: f.bytes })),
    ];
    const zip = await buildZip(entries, { contract: 'extractable', date: now() });

    const containerName = `publish-draft-${now()}-${publishDraftSeq++}.zip`;
    const containerPath = join(stagingRoot, containerName);
    await io.writeBytes(containerPath, zip);
    try {
      // 预校验 / 令牌 / 上传只有 `publish` 那一条 —— 本函数只负责"把包打出来"
      return await publish(containerPath, opts);
    } finally {
      await quietRemoveFile(containerPath);
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

    publish,

    inspectZip,

    publishPack,

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
      // 卸载前整包进 OpJournal（2026-10-18 undo 覆盖批，additive 可选）：walk 逐文件
      // record（before=当前字节，undo 恢复）。begin 失败 ⇒ 取消卸载——宁可不卸，
      // 也不给一个撤不回的删除；journal 缺席 = 旧行为。`!hadDir` 只清清单条目
      // （journal 只管文件字节，不管 storage 清单），不进账。
      const opId = journal !== undefined && hadDir
        ? await journal.begin('market-uninstall', `卸载市场包 ${kind}/${id} v${version}（目录将整体移除）`)
        : null;
      try {
        if (opId !== null) {
          for (const e of await io.walkDir(dir, { includeFiles: true })) {
            if (!e.isDirectory) await journal!.record(opId, e.path);
          }
        }
        if (hadDir) await io.removeDir(dir);
        await writeRecords(rest);
        await removeEmptyAncestors(dir);
        // KM-11：卸完不许在暂存区留下这个包的任何残壳（崩在半路的容器 / 解压目录 / 回滚副本）。
        // 名字全部由契约派生 ⇒ 这里是一张表而不是四条抄写；只碰这一个 id-version，
        // 不动别人的暂存条目（并发装同一个包本来就会被 `commitPack` 的残壳清扫覆盖）。
        for (const name of packStagingNames(id, version)) await quietRemove(join(stagingRoot, name));
      } catch (err) {
        if (opId !== null) {
          try {
            // 删到一半 / 清单写失败：abort 按快照恢复已删文件（removeEmptyAncestors
            // 收掉的空层由平台 create_dir_all 复建——undo 恢复字节本就重建父目录）。
            await journal!.abort(opId);
          } catch (abortErr: unknown) {
            const main = err instanceof Error ? err.message : String(err);
            const why = abortErr instanceof Error ? abortErr.message : String(abortErr);
            throw new Error(`卸载失败：${main}（且回滚失败，快照已保留待人工处置：${why}）`, { cause: err });
          }
        }
        throw err;
      }
      if (opId !== null) {
        // 卸载已成定局：commit 进历史（误卸载可整包恢复）。commit 失败不回滚不抛错
        // （包已卸掉、清单已清，抛错只会呈现一个"假失败"），log.warn 出声 +
        // 快照保留待人工处置。
        await journal!.commit(opId).catch((err: unknown) => {
          log.warn(
            `市场包已卸掉但批操作收尾失败（本批不可撤销，快照已保留待人工处置）：` +
              `${kind}/${id} v${version} — ${String(err)}`,
          );
        });
      }
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
