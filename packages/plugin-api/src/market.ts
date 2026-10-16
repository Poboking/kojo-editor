/**
 * 口上市场契约（KM-1）——全仓市场语义的**唯一真源**。
 *
 * 形态：**无服务器**。注册表 = 一个公开 GitHub 仓里的 `index.json`；容器 = ZIP；
 * 权威校验锚 = `pack.json` 内**逐文件 sha256**（不是包级摘要，不是清单指纹，
 * 也不是本包 `fingerprint.ts` 的 `stableHash`/`foldDigest`——那两个是非密码学哈希，
 * 拿来当校验锚等于没有校验）。
 *
 * 本文件住契约层的理由：注册表 CI、Rust 解压命令、插件实现、UI 四方都按同一份
 * schema 对齐，字段名/类型改一个字就是三方撕裂。故：
 * - schema 常量与校验规则（纯函数）住这里；
 * - 唯一实现 = `packages/plugins/kojo-market/src/digest.ts` 的 `sha256Hex`
 *   （守门测试断言全仓无第二处 SHA-256 实现）；
 * - 落点/装卸（要读盘写盘的）住插件，本文件零 IO。
 *
 * 零游戏名词（铁律 1）：市场只认"包"，包内容是什么游戏口径由消费者解释。
 */

/** 当前（也是唯一在用的）清单/索引 schema 版本 */
export const MARKET_SCHEMA_VERSION = 1;

/** 包种类（跨游戏通用：口上包 / 字典包 / 模板包） */
export type PackKind = 'kojo-pack' | 'dict-pack' | 'template-pack';

export const MARKET_PACK_KINDS: readonly PackKind[] = ['kojo-pack', 'dict-pack', 'template-pack'];

/** zip 根 / 本地源目录根**唯一**的元数据文件名 */
export const MARKET_MANIFEST_FILE = 'pack.json';

/** 包内容一律住在这个子目录下（清单里的 path 恒以它开头） */
export const MARKET_CONTENT_DIR = 'files';

/** 市场在应用数据区的根目录名：`<appData>/market` */
export const MARKET_DIR_NAME = 'market';

/** 注册表索引文件名（`<appData>/market/index.json`，由注册表仓同步下来） */
export const MARKET_INDEX_FILE = 'index.json';

/** 已装包目录段名：`<appData>/market/packs/<kind>/<id>/<version>` */
export const MARKET_PACKS_DIR = 'packs';

/** 暂存目录段名（装完/失败都必须被清空；崩溃残壳由下次安装清扫） */
export const MARKET_STAGING_DIR = '.staging';

/**
 * 容器（zip 本体）的名字后缀：Rust 侧 `container_name_problem` 也要求它以 `.zip` 结尾，
 * 且**下载与解压共用同一个名字**（两个命令指向同一个文件 ⇒ 不存在"写 .bin 读 .zip"的两份真相）。
 * 名字由这两个函数派生，插件/面板/测试都从这里拿，不在别处拼第二次。
 */
export const MARKET_ZIP_SUFFIX = '.zip';

/** 解压目录后缀（与容器名同主体、不同条目 ⇒ 暂存区内两者不互相覆盖） */
export const MARKET_UNPACKED_SUFFIX = '.unpacked';

/** `<id>-<version>.zip`：暂存区里的容器名（主体受平台侧字符集与 64 字符闸约束） */
export function packContainerName(id: string, version: string): string {
  return `${id}-${version}${MARKET_ZIP_SUFFIX}`;
}

/** `<id>-<version>.unpacked`：容器解出来的目录名（只当中间态，装完即删） */
export function packUnpackedName(id: string, version: string): string {
  return `${id}-${version}${MARKET_UNPACKED_SUFFIX}`;
}

/** 旧副本的暂存名后缀（同版本重装时先把它挪开，搬不动就还原回去） */
export const MARKET_STALE_SUFFIX = '.__previous__';

/** `<id>-<version>`：搬运用的暂存目录名（字节级写进来、逐文件复核后才 rename 进落点） */
export function packStagingName(id: string, version: string): string {
  return `${id}-${version}`;
}

/** `<id>-<version>.__previous__`：重装同版本时被挪开的旧副本 */
export function packStaleName(id: string, version: string): string {
  return `${id}-${version}${MARKET_STALE_SUFFIX}`;
}

/**
 * 一个包在暂存区里可能留下的**全部**名字（卸载后清扫、失败后清扫都从这一张表来）。
 * 名字规则改了只需改这里——面板/插件/测试都不自己拼，不留第二份真相。
 */
export function packStagingNames(id: string, version: string): string[] {
  return [
    packContainerName(id, version),
    packUnpackedName(id, version),
    packStagingName(id, version),
    packStaleName(id, version),
  ];
}

/* ------------------------- 注册表索引端点（KM-9） ------------------------- */

/**
 * 默认注册表端点（GitHub Pages 上注册表仓的 `index.json`）。
 * 作者**可以覆盖**端点（`MarketService.setEndpoint`，内测源同理），但**只有主机落在
 * 平台放行列表内才真正可用**——当前放行 = GitHub 系主机 + 一级子域 `*.github.io`
 * （唯一真源在平台侧 `market.rs` 的 `host_in_allowlist`，此处只如实转述、不复制名单）；
 * 索引条目 `zip.url` 的容器下载主机同受此限。另**没有"代理"这一项**：受众绝大部分
 * 没有代理客户端，跟随系统 / 进程环境即可，做一个代理输入框等于把"没配好就一片红"
 * 的成本摊到所有人头上。
 */
export const MARKET_DEFAULT_INDEX_URL = 'https://poboking.github.io/kojo-market/index.json';

/* --------------------------- 硬限额（DoS 面） --------------------------- */

/** 清单条目数上限 */
export const MARKET_MAX_FILE_ENTRIES = 5000;

/** 单个内容路径的段数上限（深目录嵌套 = 解压端路径处理风险） */
export const MARKET_MAX_PATH_DEPTH = 12;

/** 解压后总字节上限（128 MiB） */
export const MARKET_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

/**
 * 索引体积上限（512 KiB）。实测线上 `index.json` = 1,586 B ⇒ 这是**注册表增长余量**，
 * 不是猜测：超了就是有人在往索引里塞不该塞的东西，拒得对。
 */
export const MARKET_MAX_INDEX_BYTES = 512 * 1024;

/** 拉索引的超时（索引是索引不是包体，不该让面板挂着转圈） */
export const MARKET_INDEX_TIMEOUT_MS = 15_000;

/**
 * 容器下载进度（平台侧流式回报）。`totalBytes` = `Content-Length`（重定向后的终态响应头）；
 * 缺失（chunked 传输等）⇒ `null`，UI 只能报"已收多少"而不是百分比。
 */
export interface MarketDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

/** 容器下载超时的基础段（TLS 握手 / 302 逐跳重核 / 首字节延迟；与体积无关的那部分） */
export const MARKET_DOWNLOAD_TIMEOUT_BASE_MS = 60_000;
/** 容器下载超时的体积段（每 MiB 1s） */
export const MARKET_DOWNLOAD_TIMEOUT_MS_PER_MIB = 1_000;

/**
 * 按容器声明体积换算下载超时（纯函数）。
 *
 * 依据：受众直连 GitHub release 资产的慢网量级 ~1 MB/s（无代理环境实测），原 60s 常量
 * 只够 60 MB 以下的包；公式 = 60s 基础 + 每 MiB 1s，即按**比慢网再慢一倍**的速率预算
 * （≈0.5 MB/s），128 MiB 上限下最坏 188s——够慢网走完，又不至于让真断线挂到天荒地老
 * （断线由平台侧请求错误与逐块读错兜住，不需要超时单扛）。
 * 非有限 / 非正数按 0 处理 ⇒ 回基础段（调用方传入的声明值已过契约校验，这里只兜形状）。
 */
export function marketDownloadTimeoutMs(declaredBytes: number): number {
  const safe = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
  return MARKET_DOWNLOAD_TIMEOUT_BASE_MS + Math.ceil(safe / (1024 * 1024)) * MARKET_DOWNLOAD_TIMEOUT_MS_PER_MIB;
}

/**
 * 索引新鲜度窗口（6 小时）：窗口内开面板**不回源**（`refreshIndex()` 直接给 `fresh`）。
 * 口径 = TTL 而非 ETag：远程拉取只有一条不落盘的窄原语，条件请求要它带请求头
 * ⇒ 命令面就得收"任意头部"，那是比"多打一次 1.6 KB"大得多的口子。
 */
export const MARKET_INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/* ------------------------------ 字面约束 ------------------------------ */

/** 包 id：小写、首字符字母数字、可含 `.` `_` `-`，总长 ≤ 64 */
export const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 包版本：严格三段数字（不做宽松 semver，CI 与本地校验同一把尺） */
export const PACK_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 版本段：纯数字、≤ 9 位（防 `Number` 溢出成 Infinity 的畸形段） */
export const VERSION_SEG_RE = /^\d{1,9}$/;

/** sha256 摘要字面形（64 位小写十六进制） */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/* ------------------------------- schema ------------------------------- */

/**
 * 包内单个文件条目。
 * `path` = **posix 相对路径**，恒以 `files/` 开头；绝对路径 / `..` / 反斜杠 /
 * 空段 / 盘符一律非法（见 `packEntryPathProblem`）。
 */
export interface PackFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** `pack.json` 的内容（zip 根 / 本地源目录根各一份，同一 schema） */
export interface PackManifest {
  schema: 1;
  kind: PackKind;
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  /**
   * 原作者是否许可**代理分发**。`false` ⇒ 本地安装一律拒绝
   * （二次配布允许，但作者不许可时编辑器不得替它分发/落地——唯一一条内容类硬闸）。
   */
  redistribute: boolean;
  sourceUrl?: string;
  summary?: string;
  /** 装这个包要求的最低应用版本（三段，`x.y.z`） */
  minAppVersion: string;
  /** 游戏限定（可空 = 跨游戏通用）；市场层只透传比较，不解释取值 */
  gameId?: string;
  files: PackFileEntry[];
}

/** 注册表索引里的一条包（无逐文件明细；`fileCount`/`unpackedBytes` 是摘要） */
export interface MarketIndexEntry {
  kind: PackKind;
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  summary?: string;
  minAppVersion: string;
  gameId?: string;
  sourceUrl?: string;
  /** zip 本体：落点 + 校验锚（**整包 sha256**，与 pack.json 的逐文件锚两层并存） */
  zip: { url: string; sha256: string; bytes: number };
  fileCount: number;
  unpackedBytes: number;
}

export interface MarketIndex {
  schema: 1;
  /** ISO 时间串（注册表 CI 生成时刻；本层不校验新鲜度） */
  generatedAt: string;
  packs: MarketIndexEntry[];
}

/**
 * 本机已装记录（`ctx.storage` 持久化的形状；卸载即删这条）。
 *
 * **落点路径不是字段**：装在哪儿永远由 `installDir(kind,id,version)` 派生
 * （KM-1 契约收口 A3）。存一份 = 两份真相，目录被外部改名后记账会指着空气。
 */
export interface InstalledPack {
  kind: PackKind;
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  /**
   * 逐文件校验锚的折叠摘要（口径见 `kojo-market` 的 `contentDigestOf`）。
   * **恒有**，与源容器格式无关——它是"内容是不是同一份东西"的唯一答案。
   */
  contentDigest: string;
  /**
   * **容器**（zip 本体）的整包 sha256。
   * 仅 zip 容器源有；本地目录源没有容器，此字段缺省。
   * （KM-1 契约收口 A2：拆掉旧 `zipSha256` 的一词两义。）
   */
  containerSha256?: string;
  installedAt: number;
  files: PackFileEntry[];
}

/* ------------------------------- 服务键 ------------------------------- */

/** `MarketService` 的服务键（装配形态照 `WellKnownServices`：插件 provide、消费方 inject） */
export const MARKET_SERVICE_KEY = 'market';

/**
 * 本机索引的**三态判别联**（取代旧的 `MarketIndex | null`）。
 *
 * 为什么不留 `null`：`null` 同时表达"本机还没有列表"和"有文件但读不出"，
 * 面板要分辨就只能自己摸盘 ⇒ 摸盘的那份判定是第二份真相（而且它会漂）。
 * 三态互斥、各带自己那句话，`absent` 不需要 reason（"没有"不是错误）。
 */
export type MarketIndexState =
  | { readonly state: 'absent' }
  /** 文件在位但读不出内容，或形状不受支持：`reason` 给人话，`detail` 给机器 */
  | { readonly state: 'invalid'; readonly reason: string; readonly detail?: string }
  | {
      readonly state: 'ok';
      readonly index: MarketIndex;
      /**
       * **被剔除条目的人话清单**（形状不合格的、以及同 id 异 kind 冲突的都在这里，
       * 铁律 4：冲突必须可见——过去它被静默过滤在函数内部）。空数组 = 一条没丢。
       */
      readonly dropped: readonly string[];
      /** 本机这份列表的拉取时刻（epoch ms）；手工放的/从没拉过的 = `null` */
      readonly fetchedAt: number | null;
    };

/** 一次"从注册表刷新索引"的结果（失败也是一等态，不许"加载中"常驻） */
export type MarketIndexRefresh =
  | {
      readonly state: 'refreshed';
      readonly index: MarketIndexState;
      readonly fetchedAt: number;
    }
  /** TTL 窗口内 ⇒ 没回源（不是失败，也不该装作拉过） */
  | { readonly state: 'cached'; readonly index: MarketIndexState; readonly fetchedAt: number }
  | { readonly state: 'failed'; readonly reason: string; readonly detail?: string; readonly index: MarketIndexState };

/**
 * 市场装卸服务（由 `kojo-market` 插件 provide）。
 *
 * 落点全部住在 `<appData>/market` 下——这是本插件 activate 时**一次性**登记的
 * 常驻可写根（应用自有目录，铁律 5），因此装卸不触碰游戏目录。
 *
 * **索引的唯一真源是 `<appData>/market/index.json`**（由注册表仓同步下来）。
 * GitHub release 的 `latest` / 排序语义在本客户端**一律不作为依据**（KM-1 契约收口 A5）：
 * 实测 `make_latest=false` **去不掉** Latest 徽章（`GET /releases/latest` 照样 200 命中），
 * 也就是说"哪个是最新"这件事在平台上根本不可靠——版本只从 `index.json` 的条目读。
 * 这条不是注释礼仪：`kojo-market/tests/single-source.test.ts` 有守卫测试，
 * 市场相关源码里出现 `releases/latest` 字面量即红。
 *
 * 本批（KM-8/KM-9）索引面 = **读 + 从注册表刷新 + 端点覆盖**；
 * 安装面（KM-10..12）= `installLocalDir`（本机目录源）+ `installFromIndex`（注册表容器源）。
 */
export interface MarketService {
  /** `<appData>/market` */
  rootDir(): Promise<string>;
  /**
   * 读 `<appData>/market/index.json` 的**三态判别联**（零网络）。
   * 被 id/kind 唯一性剔除的条目如实出现在 `dropped` 里，并且**出声**（铁律 4）。
   */
  index(): Promise<MarketIndexState>;
  /**
   * 从生效端点拉索引 → 校验 schema → 经 `io.writeText` 落 `<appData>/market/index.json`
   * → 记数据时间。TTL 窗口内不回源（`cached`）；任何一步失败都 ⇒ `failed` + 盘上旧列表原样保留。
   *
   * 写落点住在常驻可写根 `<appData>/market` 之内 ⇒ **不新增任何写允许域**（铁律 5）。
   * 远程能力由平台侧唯一决定（Node 桥没有 ⇒ `failed`，不在别处复刻白名单）。
   */
  refreshIndex(opts?: { readonly force?: boolean }): Promise<MarketIndexRefresh>;
  /** 生效端点（用户覆盖优先，否则 `MARKET_DEFAULT_INDEX_URL`） */
  endpoint(): Promise<string>;
  /**
   * 覆盖注册表端点（内测源 / 镜像）；空串 = 恢复默认。
   * **自定义主机仅当落在平台放行列表内才真正可用**（当前 = GitHub 系主机 +
   * 一级子域 `*.github.io`；唯一真源在平台侧 `market.rs`，此处不复制名单）。
   * @throws MarketError `endpoint-invalid` 形态不合格（只核形态：**可信主机的唯一真源在平台侧**）
   */
  setEndpoint(url: string): Promise<void>;
  /** 本机已装包（读 `ctx.storage`；派生落点不在位的条目会被剔除并出声） */
  installed(): Promise<InstalledPack[]>;
  /**
   * 已装包占用的字节数（KM-11 的"占用"读数；面板显示用）。
   *
   * 口径 = **核验在位**的那部分包的 `files[]` 声明字节之和（`packEntryPathProblem` 的前缀闸
   * 保证这些条目就是落点 `files/` 的全部内容）——不摸盘逐文件求和、不在两处各算一遍。
   * 在位核验与 `installed()` 同一条路径（一趟批量 stat，毫秒级；与 `installed()` 并发双调
   * 即两趟），目录已丢的包不计入、并按 `installed()` 同语义从记账剔除写回（自愈）。
   * 不含市场根下的其它文件（`index.json` 与暂存区不属于任何已装包）。
   */
  installedBytes(): Promise<number>;
  /**
   * 从本地目录装（目录内须有 `pack.json` + `files/`）。
   * @throws MarketError `id-kind-conflict` 当同 id 已按**另一个 kind** 装着
   *   （一个 id 只能属于一个 kind，见 `packIdKindConflicts`）
   */
  installLocalDir(sourceDir: string): Promise<InstalledPack>;
  /**
   * 从注册表条目装（**容器源**，KM-10..12）：
   * *平台侧容器下载原语（容器名 = `packContainerName(id,version)`，体积上限取索引声明的
   * `zip.bytes` ⇒ 比声明多一个字节都不收）→ 容器整包 sha256 与索引锚对平 → 平台侧解压原语
   * （限额取契约常量）→ 解出的根 `pack.json` 与容器条目**双向对平**（清单声明而没解出 = 拒；
   * 解出而清单没声明 = 拒，根 `pack.json` 本身算元数据不算内容；逐条目字节数不符 = 拒）
   * → **走与 `installLocalDir` 完全同一条**校验+落暂存+逐文件复核+原子搬运+记账路径。
   *
   * 记账比目录源多一个 `containerSha256`（容器本体的整包摘要；"内容是不是注册表说的那份"
   * 的答案仍是逐文件锚折出来的 `contentDigest`）。
   *
   * 任一步失败 ⇒ 暂存区内这一次的全部痕迹（容器 / 解压目录 / 半成品）被删掉，
   * 落点要么完整要么不存在（同版本重装时旧副本先搬进 `.staging` 再删）。
   *
   * @throws MarketError：`download-failed` / `container-sha256` / `container-bytes` /
   *   `extract-failed` / `container-identity` / `entry-missing` / `entry-extra` /
   *   `entry-bytes` / `entry-sha256`，以及 `installLocalDir` 会抛的全部清单类码
   *
   * @param onProgress 容器下载的进度回调（**只覆盖下载段**；解压/搬运快，不发进度、不造假进度）。
   *   体积上限与超时都从声明的 `zip.bytes` 换算（`marketDownloadTimeoutMs`），调用方不用管。
   */
  installFromIndex(
    entry: MarketIndexEntry,
    onProgress?: (p: MarketDownloadProgress) => void,
  ): Promise<InstalledPack>;
  uninstall(kind: PackKind, id: string, version: string): Promise<void>;
  isInstalled(kind: PackKind, id: string, version: string): Promise<boolean>;
  /** `<appData>/market/packs/<kind>/<id>/<version>`（**唯一**的落点真源，记账里不存路径） */
  installDir(kind: PackKind, id: string, version: string): Promise<string>;
  /** `installDir(...)` + `files` */
  contentDir(kind: PackKind, id: string, version: string): Promise<string>;
}

/* ------------------------------- 拒绝码 ------------------------------- */

/**
 * 安装被拒的原因码（错误消息给人话，本码给机器：UI 后续按码分组呈现，
 * 注册表 CI 也可按同一份码表自查，别自造新码——加了就得同步这里）。
 */
export type MarketRejectCode =
  | 'manifest-missing'
  | 'manifest-json'
  | 'manifest-shape'
  | 'schema-version'
  | 'kind-unknown'
  | 'id-invalid'
  | 'id-kind-conflict'
  | 'version-invalid'
  | 'min-app-version-invalid'
  | 'redistribute-denied'
  | 'app-version-too-low'
  | 'path-prefix'
  | 'path-absolute'
  | 'path-drive'
  | 'path-backslash'
  | 'path-dotdot'
  | 'path-empty-segment'
  /** 任一段尾随 `.` 或空格（Windows 落盘静默改名面）——盘符位之外的 `:` 是 ADS 注入面，归 `path-drive` */
  | 'path-windows-unsafe'
  | 'path-depth'
  | 'entry-duplicate'
  | 'entries-limit'
  | 'bytes-limit'
  | 'entry-bytes'
  | 'entry-sha256'
  | 'content-missing'
  | 'source-unreadable'
  | 'install-move-failed'
  | 'installed-missing'
  | 'endpoint-invalid'
  /* ---- 容器源（KM-10..12）新增：全部只由 `installFromIndex` 抛出 ---- */
  /** 下载没成功（出网闸拒、非 2xx、体积超声明、超时；平台侧那句人话原样带在消息里） */
  | 'download-failed'
  /** 容器里的 `pack.json` 与注册表那一行不是同一个包（`kind`/`id`/`version` 逐字比） */
  | 'container-identity'
  /** 容器整包摘要与注册表声明的 `zip.sha256` 不是同一份东西 */
  | 'container-sha256'
  /** 容器字节数与注册表声明的 `zip.bytes` 不符（先于摘要核，给一句更快的话） */
  | 'container-bytes'
  /** 解压被平台侧拒（条目路径/类型/深度/条数/总字节违例，或容器不可读） */
  | 'extract-failed'
  /** 清单声明了、容器里没解出来（缺内容） */
  | 'entry-missing'
  /** 容器解出来了、清单却没声明（多内容；根 `pack.json` 不算） */
  | 'entry-extra';

/** 带原因码的市场错误（装卸路径上所有拒绝都从这里出） */
export class MarketError extends Error {
  constructor(
    public readonly code: MarketRejectCode,
    message: string,
    /** 触发拒绝的字段/路径（可选，便于 UI 定位） */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'MarketError';
  }
}

/* ----------------------------- 纯校验函数 ----------------------------- */

/**
 * 单个清单条目路径的非法形态；合法返回 `null`。
 *
 * 只认 posix 相对路径（`files/` 前缀）——Windows 反斜杠**不许**出现在清单里，
 * 否则同一份包在两个平台上会解成两种树。盘符判定独立于 `isAbsolute`，
 * 因为 `C:x` 这种"相对盘符"形态 `isAbsolute` 不认。
 * **顺序与拒绝码字面与 Rust `market.rs::entry_path_problem` 逐条对齐**（两层错误逐字对上）：
 * 盘符位之外的 `:` 一律拒（NTFS 备用数据流 ADS 注入面，复用 `path-drive` 码）；
 * 任一段尾随 `.` 或空格拒（Windows 落盘会静默剥掉它们，清单与落盘从此不平）。
 */
export function packEntryPathProblem(path: string): MarketRejectCode | null {
  if (typeof path !== 'string' || path.length === 0) return 'path-empty-segment';
  if (/^[A-Za-z]:/.test(path)) return 'path-drive';
  if (path.includes(':')) return 'path-drive';
  if (path.includes('\\')) return 'path-backslash';
  if (path.startsWith('/')) return 'path-absolute';
  const segments = path.split('/');
  // 空段与 `.` 段都算"路径里掺了非成分"——两种写法都会让解压端对同一份清单给出两种树
  if (segments.some((s) => s.length === 0 || s === '.')) return 'path-empty-segment';
  if (segments.some((s) => s === '..')) return 'path-dotdot';
  // 尾随 `.` / 空格：资源管理器与文件系统落盘时悄悄剥掉（`a.txt.` → `a.txt`），一视同仁逐段核
  if (segments.some((s) => s.endsWith('.') || s.endsWith(' '))) return 'path-windows-unsafe';
  if (segments[0] !== MARKET_CONTENT_DIR) return 'path-prefix';
  // 必须**在 files/ 之内**（裸 `files` 是目录不是文件），且段数含 `files` 本身不超限
  if (segments.length < 2) return 'path-prefix';
  if (segments.length > MARKET_MAX_PATH_DEPTH) return 'path-depth';
  return null;
}

/** 逐条核路径（前缀/穿越/深度/条目数）+ 总字节；返回首个问题（不做"收集全部"——首个即拒） */
export function packFilesProblem(
  files: readonly PackFileEntry[],
): { code: MarketRejectCode; detail: string } | null {
  if (files.length > MARKET_MAX_FILE_ENTRIES) {
    return { code: 'entries-limit', detail: String(files.length) };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    const p = packEntryPathProblem(f.path);
    if (p !== null) return { code: p, detail: f.path };
    if (seen.has(f.path)) return { code: 'entry-duplicate', detail: f.path };
    seen.add(f.path);
    if (!Number.isInteger(f.bytes) || f.bytes < 0) return { code: 'entry-bytes', detail: f.path };
    if (!SHA256_HEX_RE.test(f.sha256)) return { code: 'entry-sha256', detail: f.path };
    total += f.bytes;
    if (total > MARKET_MAX_UNPACKED_BYTES) {
      return { code: 'bytes-limit', detail: `${total} > ${MARKET_MAX_UNPACKED_BYTES}` };
    }
  }
  return null;
}

/** 三段数字版本逐段比较：`a<b → -1`，`a>b → 1`，等 ⇒ 0；段形非法返回 `null` */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = a.split('.');
  const y = b.split('.');
  if (x.length !== 3 || y.length !== 3) return null;
  const nx: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (!VERSION_SEG_RE.test(x[i]!) || !VERSION_SEG_RE.test(y[i]!)) return null;
    nx.push(Number(x[i]));
    ny.push(Number(y[i]));
  }
  for (let i = 0; i < 3; i++) {
    if (nx[i]! < ny[i]!) return -1;
    if (nx[i]! > ny[i]!) return 1;
  }
  return 0;
}

/** 剥掉预发布段：`0.4.0-beta.1` → `0.4.0`（合法应用版本口径允许带后缀） */
export function coreVersion(v: string): string {
  const dash = v.indexOf('-');
  return dash === -1 ? v : v.slice(0, dash);
}

/**
 * 端点**形态**闸（纯函数，零网络）：必须是 https、必须有主机名、不许带 userinfo。
 *
 * 这不是白名单——**可信主机的唯一真源在平台侧**（Rust `market.rs` 的
 * `host_in_allowlist`，逐跳重核）。TS 侧再写一份主机名单就是第二份真相，
 * 而且它会漂（本仓为两份 `isIdentPart` 付过两次代价）。本闸只拦"一看就打不开"的输入，
 * 让作者在自己的镜像地址还没联网时就拿到一句人话。
 */
export function endpointProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '不是一个合法 URL';
  }
  if (parsed.protocol !== 'https:') return `协议必须是 https（收到 ${parsed.protocol}）`;
  if (parsed.hostname.length === 0) return 'URL 没有主机名';
  if (parsed.username.length > 0 || parsed.password.length > 0) return 'URL 不许带账号信息';
  return null;
}

/**
 * 一条"包身份"的最小投影（`MarketIndexEntry`、`InstalledPack`、`PackManifest` 都天然满足）。
 */
export interface PackRef {
  readonly kind: PackKind;
  readonly id: string;
}

/**
 * 注册表不变量（KM-1 契约收口 A4）：**一个 `id` 只能属于一个 `kind`**。
 *
 * 为什么是硬不变量而不是"建议"：注册表给每个包打的 tag 是 `<id>-v<version>`，
 * **不含 kind** —— 同 id 异 kind 必然在 tag 上相撞（一个 tag 指向两种内容），
 * 而后到的那个会安静地把前一个覆盖掉。实测：`demo.dict` 若同时以 `kojo-pack`
 * 存在，索引里两条都"形状合法"，谁也发现不了，只有装完的内容不对。
 *
 * 因此冲突**必须拒并出声**（`log.warn` + `id-kind-conflict`），
 * 不许"按 kind 取第一条"这类静默择一——那正是本函数要防的事。
 *
 * @returns 冲突涉及的 id（去重、字典序）；无冲突 ⇒ 空数组
 */
export function packIdKindConflicts(refs: readonly PackRef[]): string[] {
  const kinds = new Map<string, Set<string>>();
  for (const r of refs) {
    const set = kinds.get(r.id) ?? new Set<string>();
    set.add(r.kind);
    kinds.set(r.id, set);
  }
  return [...kinds]
    .filter(([, set]) => set.size > 1)
    .map(([id]) => id)
    .sort();
}

/**
 * `minAppVersion` 闸：当前应用版本是否够装这个包。
 *
 * 口径 = **拿当前版本的核心三段比**（`0.4.0-beta.1` 按 `0.4.0` 算）。
 * 为什么不算预发布：注册表 CI 只会写 `x.y.z` 的 `minAppVersion`，而当前发布口径是
 * `0.4.0-beta.1` 这类 prerelease——严格 semver 的 `prerelease < release` 会让**整个 beta
 * 站装不进任何标 `>=0.4.0` 的包**（自己挡自己）。包级 `version` 仍走 `PACK_VERSION_RE`
 * 严格三段，不受本口径影响。
 */
export function minAppVersionSatisfied(currentAppVersion: string, minAppVersion: string): boolean {
  if (!PACK_VERSION_RE.test(minAppVersion)) return false;
  const core = coreVersion(currentAppVersion);
  if (!PACK_VERSION_RE.test(core)) return false;
  const c = compareVersions(core, minAppVersion);
  return c !== null && c >= 0;
}

/* ------------------------- 更新检测（KM-10） ------------------------- */

/** 三态：注册表那条比本机那份新 / 就是同一版 / 本机反而更高（`null` = 本机没装过这个包） */
export type PackUpdateState = 'updatable' | 'latest' | 'ahead';

export interface PackUpdateCheck {
  readonly state: PackUpdateState;
  /** 本机同 `(kind,id)` 里**版本最高**的那条（三态一律拿它比，不与低版本比） */
  readonly local: InstalledPack;
  /**
   * 同版本时"是不是同一份东西"：本机那份有容器摘要 ⇒ 与索引的 `zip.sha256` 逐字比。
   *
   * 本机那份从目录源装的（`containerSha256` 缺省）⇒ `null`，**不拿 `contentDigest` 顶替**：
   * 索引条目里没有逐文件锚（`MarketIndexEntry` 只有 `zip` + `fileCount` + `unpackedBytes`），
   * 一个是内容锚的折叠摘要、一个是容器整包摘要，比出来的"相等"没有意义（实测契约字段面）。
   * 真正的逐文件对平发生在装的那一刻（`installFromIndex` 走 `installLocalDir` 同一条路径）。
   */
  readonly sameContainer: boolean | null;
}

/**
 * 索引条目 vs 已装集的更新检测（纯函数、零 IO、**不改任何东西**）。
 *
 * 版本事实只从索引条目读（契约 A5：GitHub 的 `latest` 徽章实测去不掉，不可作为依据）；
 * 比较只用 `compareVersions`（全仓唯一定义，见 `single-source.test.ts` 的守卫）。
 * 本机一条都没有 ⇒ `null`（"没装过"不是一个态，是另一个动作：面板给「安装」而不是「更新」）。
 */
export function packUpdateCheck(
  entry: MarketIndexEntry,
  installed: readonly InstalledPack[],
): PackUpdateCheck | null {
  const local = installed.filter((r) => r.kind === entry.kind && r.id === entry.id);
  let best: InstalledPack | null = null;
  for (const r of local) {
    if (best === null) {
      best = r;
      continue;
    }
    const c = compareVersions(r.version, best.version);
    if (c !== null && c > 0) best = r;
  }
  if (best === null) return null;
  const cmp = compareVersions(entry.version, best.version);
  if (cmp === null) return null;
  const state: PackUpdateState = cmp > 0 ? 'updatable' : cmp < 0 ? 'ahead' : 'latest';
  return {
    state,
    local: best,
    sameContainer: state === 'latest' && best.containerSha256 !== undefined
      ? best.containerSha256 === entry.zip.sha256
      : null,
  };
}
