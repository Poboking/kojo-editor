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

/* --------------------------- 硬限额（DoS 面） --------------------------- */

/** 清单条目数上限 */
export const MARKET_MAX_FILE_ENTRIES = 5000;

/** 单个内容路径的段数上限（深目录嵌套 = 解压端路径处理风险） */
export const MARKET_MAX_PATH_DEPTH = 12;

/** 解压后总字节上限（128 MiB） */
export const MARKET_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

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

/** 本机已装记录（`ctx.storage` 持久化的形状；卸载即删这条） */
export interface InstalledPack {
  kind: PackKind;
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  /** 安装源容器的整包摘要；本地目录源 = 逐文件摘要折叠（插件侧算，见 service） */
  zipSha256: string;
  installedAt: number;
  /** 安装落点目录（绝对路径，= `installDir(kind,id,version)`） */
  dir: string;
  files: PackFileEntry[];
}

/* ------------------------------- 服务键 ------------------------------- */

/** `MarketService` 的服务键（装配形态照 `WellKnownServices`：插件 provide、消费方 inject） */
export const MARKET_SERVICE_KEY = 'market.index';

/**
 * 市场装卸服务（由 `kojo-market` 插件 provide）。
 *
 * 落点全部住在 `<appData>/market` 下——这是本插件 activate 时**一次性**登记的
 * 常驻可写根（应用自有目录，铁律 5），因此装卸不触碰游戏目录。
 *
 * 本批只有 `installLocalDir` 一条源：remote / index-entry 源要等 Rust 解压命令落地
 * 后再扩契约（契约未定之前不留空壳）。
 */
export interface MarketService {
  /** `<appData>/market` */
  rootDir(): Promise<string>;
  /** 读 `<appData>/market/index.json`；缺失/坏 ⇒ `null` **且 log.warn**（铁律 4：内核不静默） */
  index(): Promise<MarketIndex | null>;
  /** 本机已装包（读 `ctx.storage`；目录被外部删掉的条目会被剔除并出声） */
  installed(): Promise<InstalledPack[]>;
  /** 从本地目录装（目录内须有 `pack.json` + `files/`） */
  installLocalDir(sourceDir: string): Promise<InstalledPack>;
  uninstall(kind: PackKind, id: string, version: string): Promise<void>;
  isInstalled(kind: PackKind, id: string, version: string): Promise<boolean>;
  /** `<appData>/market/packs/<kind>/<id>/<version>` */
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
  | 'io-unsupported';

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
 */
export function packEntryPathProblem(path: string): MarketRejectCode | null {
  if (typeof path !== 'string' || path.length === 0) return 'path-empty-segment';
  if (/^[A-Za-z]:/.test(path)) return 'path-drive';
  if (path.includes('\\')) return 'path-backslash';
  if (path.startsWith('/')) return 'path-absolute';
  const segments = path.split('/');
  // 空段与 `.` 段都算"路径里掺了非成分"——两种写法都会让解压端对同一份清单给出两种树
  if (segments.some((s) => s.length === 0 || s === '.')) return 'path-empty-segment';
  if (segments.some((s) => s === '..')) return 'path-dotdot';
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
