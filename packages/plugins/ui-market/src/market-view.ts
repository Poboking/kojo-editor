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
  MarketError,
  minAppVersionSatisfied,
  packUpdateCheck,
  type InstalledPack,
  type MarketIndexEntry,
  type MarketIndexRefresh,
  type MarketIndexState,
  type MarketRejectCode,
  type PackKind,
  type PackUpdateCheck,
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

/**
 * 本批能力面说明（索引能拉能看，**装**已经接上了：容器下载 → 校验 → 解压 → 落盘全在面板里）。
 * 这句话仍在的位置是"作者不该以为装不上是自己的包有问题"——真出网要桌面壳，
 * Node/浏览器壳下那两条容器原语没有实现，会明明白白报一句"容器没能取回来"。
 */
export const CAPABILITY_HINT =
  '这里能拉取并浏览注册表列表，也能直接把注册表上的包装进本机（装完就在下面的已装列表里）。装不上时看上面那行话，多数是网络或注册表那边的问题，不是你的包。';

/**
 * 拒码 → 作者面那一句人话（**全仓唯一一张表**：面板只叫 `rejectNote`，别处不再自己拼）。
 *
 * 形状是 `Record<MarketRejectCode, string>`（**穷尽映射**）⇒ 契约加一个拒码而这张表没跟上，
 * 编译期就红，不留"未知错误"那种哑巴态（铁律 4）。
 * 口径：只说"怎么了 + 本机有没有被动过"，机器词（`kind` / `sha256` / `manifest` / `index.json`）
 * 一个都不上主行——它们在 `log.warn` 与展开层里照旧给全。
 */
export const REJECT_TEXT: Record<MarketRejectCode, string> = {
  'manifest-missing': '这个包里少了说明文件，装不了',
  'manifest-json': '这个包的说明文件读不出内容',
  'manifest-shape': '这个包的说明文件缺字段或字段写错了',
  'schema-version': '这个包用的说明格式比本机新，先升级编辑器',
  'kind-unknown': '这个包的类型本机不认识',
  'id-invalid': '这个包的编号写法不合规',
  'id-kind-conflict': '同一个编号在本机已被另一种包占用，装下去会互相盖掉',
  'version-invalid': '这个包的版本号写法不合规',
  'min-app-version-invalid': '这个包对编辑器版本的要求写得不对',
  'redistribute-denied': '作者没有许可二次分发，这个包不给装',
  'app-version-too-low': '这个包要求更新版本的编辑器',
  'path-prefix': '这个包里有条内容的存放位置不合规范',
  'path-absolute': '这个包里有条内容写了完整路径，会被引到包外面去',
  'path-drive': '这个包里有条内容带了盘符',
  'path-backslash': '这个包里有条内容用了反斜杠路径',
  'path-dotdot': '这个包里有条内容想往上跳目录',
  'path-empty-segment': '这个包里有条内容的路径写法有空段',
  'path-depth': '这个包里的目录套得太深',
  'entry-duplicate': '这个包里同一个文件出现了两次',
  'entries-limit': '这个包里的文件数量超过上限',
  'bytes-limit': '这个包解开的总体积超过上限',
  'entry-bytes': '这个包里有文件的实际大小和说明对不上',
  'entry-sha256': '这个包里有文件的内容和说明的核对码对不上（可能被改过）',
  'content-missing': '这个包里没有装内容的目录',
  'source-unreadable': '说明点名的文件在源目录里读不到',
  'install-move-failed': '最后一步搬进目录没成功，本机没留半成品',
  'installed-missing': '本机没有这个包，不用卸',
  'endpoint-invalid': '注册表地址写法不对',
  'download-failed': '这个包没能从注册表取回来（网络或地址的问题），本机没动',
  'container-identity': '取回来的包和注册表那一行说的不是同一个包，本机没动',
  'container-bytes': '取回来的包大小和注册表说的不一样，本机没动',
  'container-sha256': '取回来的包和注册表钉的不是同一份，本机没动',
  'extract-failed': '这个包打不开（里面的路径或体积不合格），本机没动',
  'entry-missing': '说明里写的文件，包里没有，本机没动',
  'entry-extra': '包里多出了说明没写的文件，本机没动',
};

/**
 * 拒因 → 内联状态行那一句（**一处**、不弹窗）。`name` = 包名（作者认得的东西）。
 * 未知异常（不是 `MarketError`）也走这一句，不静默——它没有码，就把原话给出来。
 */
export function rejectNote(name: string, err: unknown): string {
  if (err instanceof MarketError) return `「${name}」没装成：${REJECT_TEXT[err.code]}`;
  return `「${name}」没装成：${err instanceof Error ? err.message : String(err)}`;
}

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
  /** 同一 (kind,id,version) 是否已在本机装着（= `update.local.version` 与条目版本相同） */
  readonly installed: boolean;
  /** KM-10 三态；`null` = 本机没装过这个包（"没装"不是一个态，是另一个动作） */
  readonly update: PackUpdateCheck | null;
  /** 这一行该给哪个动作（`'none'` = 不给按钮：已装最新、本机更高、或版本要求不满足） */
  readonly action: PackRowAction;
}

/** 索引行上的动作（`update` = 覆盖装成新内容；`install` = 本机还没这个包） */
export type PackRowAction = 'install' | 'update' | 'none';

/** 动作按钮的人话标签（空串 = 不放按钮） */
export const ACTION_LABEL: Record<PackRowAction, string> = {
  install: '安装',
  update: '更新',
  none: '',
};

/** 真能点的两种动作（`none` 行不放按钮 ⇒ 永远走不到装包那一步） */
export type InstallAction = Extract<PackRowAction, 'install' | 'update'>;

/**
 * 进行中那一句（走 `mk-note` 内联状态行，**不弹窗**）。
 * 进度只在这一处显示：按钮这时只是被禁用，不再各写一份"安装中"。
 */
export function installBusyNote(action: InstallAction, name: string): string {
  return `正在${action === 'update' ? '更新' : '安装'}「${name}」…`;
}

/**
 * 装成那一句。版本取**服务记账回来的那条**（`InstalledPack.version`）而不是索引那行：
 * 两者正常时相同，面板不自己比版本（那是第二份口径），落点上到底装着哪一版由服务说。
 */
export function installNote(action: InstallAction, name: string, version: string): string {
  return action === 'update' ? `已把「${name}」更新到版本 ${version}` : `已装上「${name}」（版本 ${version}）`;
}

/**
 * 已装条目旁边的状态短语（**只说事实，不催动作**：更新永远要作者亲手点，面板不自动覆盖）。
 * 同版本但容器核对码不同 ⇒ 明说"重装会以注册表那份覆盖"，因为那是作者下一步会问的事。
 */
export function updatePhrase(row: PackRow): string {
  const u = row.update;
  if (u === null) return '';
  switch (u.state) {
    case 'updatable':
      return `可更新到 ${row.entry.version}`;
    case 'ahead':
      return `本机已是 ${u.local.version}（比注册表那条新）`;
    case 'latest':
      if (u.sameContainer === false) return '已安装（注册表那份与本机这份内容不同，重装会覆盖）';
      return '已安装';
  }
}

/** 这一行该不该给按钮（版本要求不满足 ⇒ 不给，行上另有那句提示） */
export function rowAction(appOk: boolean, update: PackUpdateCheck | null): PackRowAction {
  if (!appOk) return 'none';
  if (update === null) return 'install';
  return update.state === 'updatable' ? 'update' : 'none';
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
 * 索引行的稳定键（React key 与"哪一行正在装"都用它）。
 *
 * 它与 `pendingKey` 同形但**不承担判定**：已装/可更新一律由 `packUpdateCheck` 说，
 * 这里只是"这一行是谁"。索引里同一三元组只可能有一条（`packIdKindConflicts` 在服务侧筛掉其余）。
 */
export function indexRowKey(e: MarketIndexEntry): string {
  return installedKey(e.kind, e.id, e.version);
}

/**
 * 索引 → 按种类分组（种类顺序 = 契约的 `MARKET_PACK_KINDS`，组内按包名）。
 * 空组不出现（不占位、不写"暂无"，显式态由 `resolveStatus` 一处负责）。
 *
 * 第 4 个参数是**已装清单本身**而不是键集合：KM-10 的三态要拿条目与本机最高版本比，
 * 只给一个 `Set<string>` 就得在别处再算一遍版本（那是第二份口径，而且它会漂）。
 */
export function buildGroups(
  packs: readonly MarketIndexEntry[],
  appVersion: string,
  query: string,
  installed: readonly InstalledPack[],
): PackGroup[] {
  const out: PackGroup[] = [];
  for (const kind of MARKET_PACK_KINDS) {
    const rows = packs
      .filter((e) => e.kind === kind && matchesQuery(e, query))
      .map((entry) => {
        const appOk = minAppVersionSatisfied(appVersion, entry.minAppVersion);
        const update = packUpdateCheck(entry, installed);
        return {
          entry,
          appOk,
          installed: update !== null && update.local.version === entry.version,
          update,
          action: rowAction(appOk, update),
        };
      })
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
