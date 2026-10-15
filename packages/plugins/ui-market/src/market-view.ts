/**
 * 市场面板的**纯视图逻辑**（零 React、零 IO，可单测穷举）。
 *
 * 分层口径与兄弟 ui-* 插件一致：数据事实全在 `MarketService`（契约），
 * 本文件只做"怎么分组 / 怎么过滤 / 怎么给人话"。
 *
 * 作者面文案纪律：**机器词不上主行**。`kind` / `id` / `manifest` / `index.json` /
 * `sha256` / `schema` 一律只出现在日志、拒码与展开层。
 */

import {
  MARKET_PACK_KINDS,
  minAppVersionSatisfied,
  type InstalledPack,
  type MarketIndexEntry,
  type MarketIndexRefresh,
  type MarketIndexState,
  type PackKind,
} from '@kojo/plugin-api';

/** 种类的人读名（`kojo-pack` → 口上包） */
export const KIND_LABEL: Record<PackKind, string> = {
  'kojo-pack': '口上包',
  'dict-pack': '字典包',
  'template-pack': '模板包',
};

/** 面板显式态（铁律 4：任何一条都得是一句人话，不许空白屏、不许"加载中"常驻） */
export type MarketViewStatus =
  | 'list-missing'
  | 'list-broken'
  | 'list-unreadable'
  | 'no-packs'
  | 'ready';

export const STATUS_TEXT: Record<Exclude<MarketViewStatus, 'ready'>, string> = {
  'list-missing': '本机还没有包列表：点上面的「拉取列表」从注册表同步',
  'list-broken': '包列表文件读不出内容（可能被外部改坏了）：点「拉取列表」覆盖它',
  'list-unreadable': '市场目录读不出来（本机磁盘或权限问题）',
  'no-packs': '包列表里暂时没有可展示的包',
};

/** 本批能力面说明（索引能拉能看，**装**还得等安装面接线 ⇒ 不留按钮、只说清楚） */
export const CAPABILITY_HINT =
  '这里能拉取并浏览注册表列表；从网络直接装包还没有开放（不是你的包有问题）。装本机文件夹里的包一直在。';

/**
 * 显式态判定：**只吃服务的三态判别联**。
 *
 * 面板过去要先 `io.exists(index.json)` 摸一遍盘才能分辨"没有"与"读不出"——
 * 那份摸盘判定是服务判定的复制品（会漂）。现在 `absent` / `invalid` / `ok` 互斥，
 * 两句人话直接从判别联的分支来。
 * `list-unreadable` 不在这里：它是"读这件事本身抛了"，由取数层的 catch 给。
 * 服务缺席也不在这里：装配用 `requires` 硬声明，缺席时面板根本不会注册。
 */
export function resolveStatus(state: MarketIndexState): MarketViewStatus {
  switch (state.state) {
    case 'absent':
      return 'list-missing';
    case 'invalid':
      return 'list-broken';
    case 'ok':
      return state.index.packs.length === 0 ? 'no-packs' : 'ready';
  }
}

export function statusText(status: MarketViewStatus, reason = ''): string {
  if (status === 'ready') return '';
  return reason === '' ? STATUS_TEXT[status] : `${STATUS_TEXT[status]}（${reason}）`;
}

/**
 * 一次刷新的人话（`cached` 不是失败，但也不许演成"刚拉过"）。
 * 三态全覆盖、无 default 分支 ⇒ 契约加第四个态时编译期就红。
 */
export function refreshNote(r: MarketIndexRefresh): string {
  switch (r.state) {
    case 'refreshed':
      return r.index.state === 'ok'
        ? `已拉取注册表列表（${r.index.index.packs.length} 个包）`
        : '已拉取注册表列表，但本机这份读不出内容';
    case 'cached':
      return `列表还在新鲜期内（${formatClock(r.fetchedAt)} 拉取），这次没有回源`;
    case 'failed':
      return r.index.state === 'ok'
        ? `拉取注册表没有成功：${r.reason}——现在显示的还是本机已有的那份`
        : `拉取注册表没有成功：${r.reason}——本机还没有可用的列表`;
  }
}

/**
 * 被剔除条目必须可见（铁律 4）：形状坏的、同 id 异 kind 冲突的都算。
 * 一条没丢 ⇒ 空串（不占行，也不写"暂无"）。
 */
export function droppedNotice(dropped: readonly string[]): string {
  if (dropped.length === 0) return '';
  return (
    `包列表里有 ${dropped.length} 条形如破坏或互相冲突的条目，` +
    '没有列出、也不许安装（这是注册表那边的问题，不是你的包）：' +
    dropped.slice(0, 3).join('；') +
    (dropped.length > 3 ? '……' : '')
  );
}

/** epoch ms → 本地 `MM-DD HH:mm`（面板只给"数据时间"这种粗粒度，秒是噪声） */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 注册表自带的生成时刻（ISO 串）→ 人读；读不懂就原样给（**不许**拿"未知"盖住一个畸形值，
 * 那正是作者要去追注册表 CI 的线索）。
 */
export function formatGeneratedAt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatClock(ms) : iso;
}

/** 数据时间一行（面板主行；`fetchedAt` = 本机拉取时刻，`generatedAt` = 注册表生成时刻） */
export function dataTimeLine(o: {
  fetchedAt: number | null;
  generatedAt: string | null;
  endpoint: string;
}): string {
  const where = o.endpoint === '' ? '' : `（来源 ${o.endpoint}）`;
  if (o.fetchedAt === null && o.generatedAt === null) return `还没有数据时间${where}`;
  const pulled = o.fetchedAt === null ? '手工放置、本机没拉过' : `${formatClock(o.fetchedAt)} 拉取`;
  const made = o.generatedAt === null ? '' : ` · 注册表生成于 ${formatGeneratedAt(o.generatedAt)}`;
  return `数据时间：${pulled}${made}${where}`;
}


/** 字节数 → 人读体积（阈值固定，别让面板出现 `1048576`） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 装这个包对编辑器版本的要求（作者面口径，不许出现 `minAppVersion` 字样） */
export function appVersionRequirement(minAppVersion: string): string {
  return `这个包要求编辑器不低于 ${minAppVersion}`;
}

export interface PackRow {
  readonly entry: MarketIndexEntry;
  /** 本机版本是否够装（够 = true） */
  readonly appOk: boolean;
  /** 同一 (kind,id,version) 是否已在本机装着 */
  readonly installed: boolean;
}

export interface PackGroup {
  readonly kind: PackKind;
  readonly label: string;
  readonly rows: PackRow[];
}

/** 名称/作者过滤（大小写不敏感、子串匹配；空查询 = 全通过） */
export function matchesQuery(e: MarketIndexEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return e.name.toLowerCase().includes(q) || e.author.toLowerCase().includes(q);
}

export function installedKey(kind: PackKind, id: string, version: string): string {
  return `${kind}/${id}@${version}`;
}

/**
 * 索引 → 按种类分组（种类顺序 = 契约的 `MARKET_PACK_KINDS`，组内按包名）。
 * 空组不出现（不占位、不写"暂无"，显式态由 `resolveStatus` 一处负责）。
 */
export function buildGroups(
  packs: readonly MarketIndexEntry[],
  appVersion: string,
  query: string,
  installedKeys: ReadonlySet<string>,
): PackGroup[] {
  const out: PackGroup[] = [];
  for (const kind of MARKET_PACK_KINDS) {
    const rows = packs
      .filter((e) => e.kind === kind && matchesQuery(e, query))
      .map((entry) => ({
        entry,
        appOk: minAppVersionSatisfied(appVersion, entry.minAppVersion),
        installed: installedKeys.has(installedKey(entry.kind, entry.id, entry.version)),
      }))
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.entry.id.localeCompare(b.entry.id));
    if (rows.length > 0) out.push({ kind, label: KIND_LABEL[kind], rows });
  }
  return out;
}

export interface InstalledRow {
  readonly rec: InstalledPack;
  /** 逐文件锚折叠摘要的前 8 位（机器核对用，只在展开层出现） */
  readonly digestPrefix: string;
  readonly kindLabel: string;
  /** 来源的人话说法：有容器摘要 = 压缩包；没有 = 本机文件夹 */
  readonly sourceLabel: string;
}

/** 已安装列表（按种类顺序 + 包名；`containerSha256` 缺省即"本机文件夹装的"） */
export function buildInstalledRows(list: readonly InstalledPack[]): InstalledRow[] {
  const order = new Map<string, number>(MARKET_PACK_KINDS.map((k, i) => [k, i]));
  return [...list]
    .sort(
      (a, b) =>
        (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) ||
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version),
    )
    .map((rec) => ({
      rec,
      digestPrefix: rec.contentDigest.slice(0, 8),
      kindLabel: KIND_LABEL[rec.kind],
      sourceLabel: rec.containerSha256 === undefined ? '本机文件夹' : '压缩包',
    }));
}

/** 卸载确认键（同一时刻只允许一条处于待确认态） */
export function pendingKey(r: InstalledPack): string {
  return installedKey(r.kind, r.id, r.version);
}
