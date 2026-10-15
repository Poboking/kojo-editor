/**
 * 面板的两条**动作/取数**通道（零 React，可直接对着真服务判据跑）。
 *
 * 为什么要独立成文件：面板组件里写 `onClick` 的闭包在 node 测试环境点不动，
 * 而"确认门"和"显式态"这两件恰恰是要钉死的行为。把意图落成函数、
 * 组件只负责把点击接到它们上面，判据才跑得起来。
 */

import {
  MARKET_INDEX_FILE,
  MarketError,
  join,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketIndexEntry,
  type MarketService,
} from '@kojo/plugin-api';
import { resolveStatus, type ListProbe, type MarketViewStatus } from './market-view';

export interface MarketActionDeps {
  market: MarketService;
  /** 只用 `exists` 区分"列表文件没有"与"有但读不出" */
  io: FileIO;
  log: Logger;
}

export interface MarketSnapshot {
  readonly status: MarketViewStatus;
  readonly packs: MarketIndexEntry[];
  readonly installed: InstalledPack[];
}

/** 读一遍面板要的全部事实（任何一条读不动都成一句人话，不静默、不留空白屏） */
export async function loadMarketSnapshot(deps: MarketActionDeps): Promise<MarketSnapshot> {
  const { market, io, log } = deps;
  let probe: ListProbe = 'present';
  let index = null as Awaited<ReturnType<MarketService['index']>>;
  let installed: InstalledPack[] = [];
  try {
    const listPath = join(await market.rootDir(), MARKET_INDEX_FILE);
    probe = (await io.exists(listPath)) ? 'present' : 'absent';
    if (probe === 'present') index = await market.index();
    installed = await market.installed();
  } catch (err: unknown) {
    probe = 'unreadable';
    index = null;
    installed = [];
    log.warn(`市场面板读列表失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return { status: resolveStatus({ probe, index }), packs: index?.packs ?? [], installed };
}

export type UninstallOutcome =
  | { readonly kind: 'needs-confirm'; readonly note: string }
  | { readonly kind: 'done'; readonly note: string }
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
