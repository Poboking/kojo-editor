/**
 * 面板的**取数 / 装 / 卸**三条通道（零 React，可直接对着真服务判据跑）。
 *
 * 为什么要独立成文件：面板组件里写 `onClick` 的闭包在 node 测试环境点不动，
 * 而"确认门"、"拒因只出自一张表"和"显式态"这三件恰恰是要钉死的行为。把意图落成函数、
 * 组件只负责把点击接到它们上面，判据才跑得起来。
 *
 * **本文件不摸盘**：面板过去靠 `io.exists(index.json)` 分辨"没有列表"与"读不出列表"，
 * 那份判定是服务判定的复制品。现在三态由 `MarketService.index()` 的判别联给，
 * 拉不拉得动远程由 `refreshIndex()` 给，装不装得上去由 `installFromIndex()` 给——面板只需要一个服务。
 */

import {
  MarketError,
  type EventBus,
  type InstalledPack,
  type Logger,
  type MarketDownloadProgress,
  type MarketIndexEntry,
  type MarketIndexRefresh,
  type MarketIndexState,
  type MarketService,
} from '@kojo/plugin-api';
import {
  importFailNote,
  importNote,
  installNote,
  refreshNote,
  rejectNote,
  resolveStatus,
  type InstallAction,
  type MarketViewStatus,
} from './market-view';

export interface MarketActionDeps {
  market: MarketService;
  /**
   * 发起方总线：导入是**发意图**（`workspace.importRequested`）而不是面板自己开门——
   * "导入成什么形态、问哪些字段"由工作区消费方（adapter）解释，面板只把
   * "这个已装包的内容目录 + 建议名"交出去（跨层零游戏知识，照壳层文件树那条入口）。
   */
  bus: EventBus;
  log: Logger;
}

export interface MarketSnapshot {
  readonly status: MarketViewStatus;
  readonly packs: MarketIndexEntry[];
  readonly installed: InstalledPack[];
  /**
   * 已装包占用字节（KM-11 的"占用"读数，口径 = 服务 `installedBytes()`）。
   * 面板**不**自己把 `installed[].files` 加一遍——那是把服务的口径复制到展示层（第二份真相）。
   * 唯一例外是下方两个乐观更新函数：服务求和就是 `files[].bytes` 之和（同一把尺的复算），
   * 且乐观结果只是显示先行，权威数字仍由后台重读的那一遍说了算。
   */
  readonly installedBytes: number;
  /** 被剔除条目（形状坏 / 同 id 异 kind 冲突）；`absent`/`invalid` 时为空 */
  readonly dropped: readonly string[];
  /** 封面链接不合规、去掉 `cover` 后照常列出的条目（包没丢，只是没图） */
  readonly coverIgnored: readonly string[];
  /** `invalid` 的可诊断原因（其余态空串） */
  readonly reason: string;
  /** 本机这份列表的拉取时刻（没拉过 / 手工放的 ⇒ null） */
  readonly fetchedAt: number | null;
  /** 注册表侧的生成时刻（ISO 串；同上可为 null） */
  readonly generatedAt: string | null;
  /** 生效端点（面板只读它、不改它：改住设置页） */
  readonly endpoint: string;
  /** 拉取状态的人话（null = 这次没拉或一切正常） */
  readonly pullNote: string;
}

function snapOf(
  state: MarketIndexState,
  installed: InstalledPack[],
  installedBytes: number,
  endpoint: string,
  pullNote = '',
): MarketSnapshot {
  return {
    status: resolveStatus(state),
    packs: state.state === 'ok' ? state.index.packs : [],
    installed,
    installedBytes,
    dropped: state.state === 'ok' ? state.dropped : [],
    coverIgnored: state.state === 'ok' ? (state.coverIgnored ?? []) : [],
    reason: state.state === 'invalid' ? state.reason : '',
    fetchedAt: state.state === 'ok' ? state.fetchedAt : null,
    generatedAt: state.state === 'ok' ? state.index.generatedAt : null,
    endpoint,
    pullNote,
  };
}

/**
 * 连"读"这件事本身都失败（服务抛异常）⇒ 一句人话 + 空列表。
 * 状态给 `list-unreadable`：**不许**把它演成"本机还没有列表"（那是另一句实话、另一个下一步动作）。
 */
function failedSnapshot(pullNote: string): MarketSnapshot {
  return {
    status: 'list-unreadable',
    packs: [],
    installed: [],
    installedBytes: 0,
    dropped: [],
    coverIgnored: [],
    reason: pullNote,
    fetchedAt: null,
    generatedAt: null,
    endpoint: '',
    pullNote,
  };
}

/* --------------------- 乐观更新（纯函数、不可变、零 IO） --------------------- */

/** 一条已装记录的声明字节之和——与服务 `installedBytes()` 同一条求和口径的复算 */
function recBytes(rec: InstalledPack): number {
  let total = 0;
  for (const f of rec.files) total += f.bytes;
  return total;
}

/**
 * 卸载成功后的乐观快照：只删精确 `(kind,id,version)` 那条，字节按其 `files[]` 声明之和扣减。
 *
 * 乐观只是**显示先行**，机器说了算的纪律不破——后台重读仍是唯一权威，若有漂移由它纠正
 * （看板 MK-1 判据：行消失 ≤ 目录消失 + 300ms，四路 IPC 全量重读撑不住这个数字）。
 */
export function snapshotWithoutInstalled(snap: MarketSnapshot, rec: InstalledPack): MarketSnapshot {
  const installed = snap.installed.filter(
    (r) => !(r.kind === rec.kind && r.id === rec.id && r.version === rec.version),
  );
  return { ...snap, installed, installedBytes: snap.installedBytes - recBytes(rec) };
}

/**
 * 安装成功后的乐观快照：同 `(kind,id,version)` 键**替换**（重装/更新同版本）、否则**追加**；
 * 字节按替换差值/追加量累加（与 `packUpdateCheck` 的"本机可能同键多条"互不影响：这里只动精确同键那条）。
 */
export function snapshotWithInstalled(snap: MarketSnapshot, rec: InstalledPack): MarketSnapshot {
  let replaced = 0;
  let found = false;
  const installed: InstalledPack[] = snap.installed.map((r) => {
    if (r.kind === rec.kind && r.id === rec.id && r.version === rec.version) {
      found = true;
      replaced += recBytes(r);
      return rec;
    }
    return r;
  });
  if (!found) installed.push(rec);
  return { ...snap, installed, installedBytes: snap.installedBytes - replaced + recBytes(rec) };
}

/** 读一遍面板要的全部事实（零网络；任何一条读不动都成一句人话，不静默、不空白屏） */
export async function loadMarketSnapshot(deps: MarketActionDeps): Promise<MarketSnapshot> {
  const { market, log } = deps;
  try {
    const [state, installed, endpoint, bytes] = await Promise.all([
      market.index(),
      market.installed(),
      market.endpoint(),
      market.installedBytes(),
    ]);
    return snapOf(state, installed, bytes, endpoint);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`市场面板读列表失败：${message}`);
    return failedSnapshot(`读取列表失败：${message}`);
  }
}

/**
 * 一次回源的完整结果：快照之外还带回 `refreshIndex` 的三态。
 * 面板的 stale-while-revalidate 后台段要拿它分"出声（refreshed / failed）还是静默（cached）"——
 * 一切正常的面板不该有废话，cached 不能靠猜 pullNote 的文案来判。
 */
export interface MarketPullOutcome {
  readonly snap: MarketSnapshot;
  /** 服务判定的三态；服务整体抛了（连失败态都拿不回来）也归入 `failed` */
  readonly state: MarketIndexRefresh['state'];
}

/**
 * 回源（force=false 走 TTL、force=true 硬回源）并带回快照 + 三态。
 *
 * **失败也是一条人话**，且绝不清掉本机已有列表——`refreshIndex()` 的 `failed` 分支
 * 带着盘上那份的原样状态回来（校验不过就不写盘，见 service）。
 */
export async function pullMarketOutcome(
  deps: MarketActionDeps,
  force: boolean,
): Promise<MarketPullOutcome> {
  const { market, log } = deps;
  try {
    const refresh = await market.refreshIndex({ force });
    // 三态的人话只有一份（`market-view.refreshNote`）——这里不再自己拼第二套文案
    const note = refreshNote(refresh);
    if (refresh.state === 'failed') {
      log.warn(`市场索引拉取失败：${refresh.reason}（${refresh.detail ?? ''}）`);
    }
    // 刷新结果**自带**盘上那份状态：成功是新列表，失败是原样旧列表（失败绝不清空）
    const [installed, endpoint, bytes] = await Promise.all([
      market.installed(),
      market.endpoint(),
      market.installedBytes(),
    ]);
    return { snap: snapOf(refresh.index, installed, bytes, endpoint, note), state: refresh.state };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`市场面板刷新失败：${message}`);
    return { snap: failedSnapshot(`刷新失败：${message}`), state: 'failed' };
  }
}

/** 只要快照不要三态的旧口径（「拉取列表」按钮：点了就等，结果照旧出声） */
export async function pullMarketSnapshot(
  deps: MarketActionDeps,
  force: boolean,
): Promise<MarketSnapshot> {
  return (await pullMarketOutcome(deps, force)).snap;
}

export type UninstallOutcome =
  | { readonly kind: 'needs-confirm'; readonly note: string }
  | { readonly kind: 'done'; readonly note: string }
  | { readonly kind: 'failed'; readonly note: string };

export type InstallOutcome =
  | { readonly kind: 'done'; readonly rec: InstalledPack; readonly note: string }
  | { readonly kind: 'failed'; readonly note: string };
/**
 * 卸载（**一次确认**：`confirmed` 为假时一个字节都不动、连服务都不叫）。
 * 结果一律是内联状态行的文案，不弹窗（HK-4）。
 */
export async function runUninstall(
  deps: MarketActionDeps,
  rec: InstalledPack,
  confirmed: boolean,
): Promise<UninstallOutcome> {
  if (!confirmed) {
    return { kind: 'needs-confirm', note: `还没确认，「${rec.name}」没有被动过` };
  }
  try {
    await deps.market.uninstall(rec.kind, rec.id, rec.version);
    return { kind: 'done', note: `已卸掉「${rec.name}」（已装列表与市场目录都已清除）` };
  } catch (err: unknown) {
    const code = err instanceof MarketError ? err.code : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn(`市场卸载没有成功（${code}）：${message}`);
    return { kind: 'failed', note: `卸载没有成功：${message}` };
  }
}

/**
 * 从注册表装 / 更新（**一次点击一个包**，不设确认门：装是往本机添东西，
 * 覆盖与被覆盖的判定、清场与原子搬运全在服务侧那条唯一路径里，面板一个字节都不碰）。
 *
 * 结果与拒因都只回**一句内联状态行**的文案，不弹窗（HK-4）；
 * 拒因一律出自 `REJECT_TEXT` 那一张表（`MarketError` 有码 ⇒ 查表；没码的异常 ⇒ 原话给出，不静默），
 * 机器面（拒码 + 原消息）另走 `log.warn`，作者面因此永远不需要认识 `sha256` 这类词。
 */
export async function runInstall(
  deps: MarketActionDeps,
  entry: MarketIndexEntry,
  action: InstallAction,
  onProgress?: (p: MarketDownloadProgress) => void,
): Promise<InstallOutcome> {
  try {
    // 记账回来的那条才是落点上真正装着的东西：文案的版本一律取它，不取索引那一行
    const rec = await deps.market.installFromIndex(entry, onProgress);
    return { kind: 'done', rec, note: installNote(action, rec.name, rec.version) };
  } catch (err: unknown) {
    const code = err instanceof MarketError ? err.code : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn(`市场装包没有成功（${code}）：${message}`);
    return { kind: 'failed', note: rejectNote(entry.name, err) };
  }
}

export type ImportOutcome =
  | { readonly kind: 'done'; readonly note: string }
  | { readonly kind: 'failed'; readonly note: string };

/**
 * 「导入为我的口上项目」：把已装包的内容目录经 `workspace.importRequested` 交给
 * 工作区消费方（adapter 弹导入向导 → 作者选目标项目 → 内核字节级复制）。
 *
 * 载荷**逐字冻结**（两侧接缝）：`source: 'market'` 一个字都不许改——消费方按它
 * 认发起方并做署名映射；`sourceDir` 一律由服务 `contentDir()` 派生（面板不摸盘、
 * 不自己拼 `packs/...` 路径），`suggestedName` 取记账里的包名。
 *
 * 结果/失败都只回一句内联状态行的文案（HK-4），不弹窗；失败不出声才怪。
 */
export async function runImport(deps: MarketActionDeps, rec: InstalledPack): Promise<ImportOutcome> {
  try {
    const sourceDir = await deps.market.contentDir(rec.kind, rec.id, rec.version);
    deps.bus.emit('workspace.importRequested', {
      sourceDir,
      suggestedName: rec.name,
      source: 'market',
    });
    return { kind: 'done', note: importNote(rec.name) };
  } catch (err: unknown) {
    const code = err instanceof MarketError ? err.code : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn(`市场导入请求没有发出（${code}）：${message}`);
    return { kind: 'failed', note: importFailNote(rec.name, err) };
  }
}

/**
 * 「发布口上…」：面板只表达**一个意图**（`market.publishRequested`）。
 *
 * 为什么不再在这里选 zip / 预校验 / 上传：发布要回答的是"发布哪一个口上项目、以什么许可、
 * 打包成什么"——这些问题的答案只在**拥有口上项目模型的那一方**手里（adapter 的发布向导）。
 * 面板若先弹一个选文件的框，等于逼作者把项目手工打成 zip，顺序也反了（先问项目再打包）。
 * 因此市场面板到此为止：发意图、不持状态、不摸盘。向导的打开与结果由消费方负责，
 * 载荷 `source: 'ui-market'` 只用于让消费方认得发起方。
 */
export function requestPublish(deps: MarketActionDeps): void {
  deps.bus.emit('market.publishRequested', { source: 'ui-market' });
}
