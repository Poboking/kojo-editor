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
  type MarketIndex,
  type MarketIndexEntry,
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
  'list-missing': '本机还没有包列表：把注册表的列表文件放进编辑器的市场目录，再点「刷新」',
  'list-broken': '包列表文件读不出内容（可能被外部改坏了）',
  'list-unreadable': '市场目录读不出来（本机磁盘或权限问题）',
  'no-packs': '包列表里暂时没有可展示的包',
};

/** 本批能力面说明（远程装包要等解压原语落地 ⇒ 不留按钮、只说清楚） */
export const CAPABILITY_HINT =
  '这里只列本机市场目录里的包列表；从网络直接装包本批还没有开放（不是你的包有问题）。';

/** 列表文件探测结果（区分"没有"与"读不动"，两者的人话不一样） */
export type ListProbe = 'present' | 'absent' | 'unreadable';

/**
 * 显式态判定。
 * `index === null` 而列表文件在位 ⇒ "读不出"（损坏/形状不认识）；
 * 文件不在位 ⇒ "还没有"。**服务缺席不在这里**：装配用 `requires` 硬声明，
 * 缺席时面板根本不会注册，不留一条永远不会走到的兜底。
 */
export function resolveStatus(o: {
  probe: ListProbe;
  index: MarketIndex | null;
}): MarketViewStatus {
  if (o.probe === 'unreadable') return 'list-unreadable';
  if (o.probe === 'absent') return 'list-missing';
  if (o.index === null) return 'list-broken';
  return o.index.packs.length === 0 ? 'no-packs' : 'ready';
}

export function statusText(status: MarketViewStatus): string {
  return status === 'ready' ? '' : STATUS_TEXT[status];
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
