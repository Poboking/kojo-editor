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
  type InstalledPack,
  type Logger,
  type MarketIndexEntry,
  type MarketIndexState,
  type MarketService,
} from '@kojo/plugin-api';
import {
  installNote,
  refreshNote,
  rejectNote,
  resolveStatus,
  type InstallAction,
  type MarketViewStatus,
} from './market-view';

export interface MarketActionDeps {
  market: MarketService;
  log: Logger;
}

export interface MarketSnapshot {
  readonly status: MarketViewStatus;
  readonly packs: MarketIndexEntry[];
  readonly installed: InstalledPack[];
  /**
   * 已装包占用字节（KM-11 的"占用"读数，口径 = 服务 `installedBytes()`）。
   * 面板**不**自己把 `installed[].files` 加一遍——那是把服务的口径复制到展示层（第二份真相）。
   */
  readonly installedBytes: number;
  /** 被剔除条目（形状坏 / 同 id 异 kind 冲突）；`absent`/`invalid` 时为空 */
  readonly dropped: readonly string[];
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
    reason: pullNote,
    fetchedAt: null,
    generatedAt: null,
    endpoint: '',
    pullNote,
  };
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
 * 打开面板 / 点「刷新」走的那条路：先问服务要不要回源（TTL 在 `kojo-market` 里判），
 * 再把拉取结果与列表一起返回。
 *
 * **失败也是一条人话**，且绝不清掉本机已有列表——`refreshIndex()` 的 `failed` 分支
 * 带着盘上那份的原样状态回来（校验不过就不写盘，见 service）。
 */
export async function pullMarketSnapshot(
  deps: MarketActionDeps,
  force: boolean,
): Promise<MarketSnapshot> {
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
    return snapOf(refresh.index, installed, bytes, endpoint, note);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`市场面板刷新失败：${message}`);
    return failedSnapshot(`刷新失败：${message}`);
  }
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
): Promise<InstallOutcome> {
  try {
    // 记账回来的那条才是落点上真正装着的东西：文案的版本一律取它，不取索引那一行
    const rec = await deps.market.installFromIndex(entry);
    return { kind: 'done', rec, note: installNote(action, rec.name, rec.version) };
  } catch (err: unknown) {
    const code = err instanceof MarketError ? err.code : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn(`市场装包没有成功（${code}）：${message}`);
    return { kind: 'failed', note: rejectNote(entry.name, err) };
  }
}
