/**
 * @kojo/plugin-kojo-market
 *
 * 口上市场 v1 插件（服务 `market`）——**无服务器**：注册表是公开 GitHub 仓里的
 * `index.json`，容器是 ZIP，权威校验锚是 `pack.json` 里的**逐文件 sha256**。
 *
 * 本批（KM-2）范围：离线闭环 = **本地目录源**装卸 + 校验 + 落点 + 记账。
 * remote / index-entry 源**不在本批**（等 Rust 解压命令落地后按契约扩，不留空壳）。
 *
 * 落点纪律（铁律 5/6）：
 * - 一切写入住 `<appData>/market`——activate 里**一次性**登记这**一个**常驻可写根
 *   （应用自有目录，不受项目开闭清空），因此装卸永不触碰游戏目录；
 * - 顺序不可颠倒：先 `addAppWritableRoot` 再 `ensureDir`，因为 `ensureDir` 与
 *   `writeBytes` 同受第一道闸约束（内核 `io.ts` 的目录创建闸），反了就是
 *   `WriteNotAllowedError`；
 * - 登记根 ≠ 拿到写权限之外的任何绕闸能力：`exportFile` 仍是唯一的域外写通道。
 *
 * 零游戏知识：本包只认"包"（`PackKind` 三值 + 逐文件锚），包内容是什么游戏口径
 * 由消费者解释；游戏目录只读假设由内核 io 强制。
 */

import {
  MARKET_DIR_NAME,
  MARKET_SERVICE_KEY,
  PACK_VERSION_RE,
  KernelServices,
  coreVersion,
  join,
  type FileIO,
  type MarketService,
  type Plugin,
} from '@kojo/plugin-api';
import { createMarketService } from './service';

export interface KojoMarketPluginOptions {
  /**
   * 当前应用版本（口径 = `packages/app/package.json` 的 `version`，如 `0.4.0-beta.1`；
   * 允许带预发布后缀）。**版本号不许硬写进插件源码**——由装配层注入，
   * 单一真源在 app 包清单里；缺省即拒绝装配（宁可起不来，也不要"猜一个版本"把
   * `minAppVersion` 闸变成摆设）。
   */
  appVersion: string;
  /** 时间源（测试注入固定值以钉死 `installedAt`） */
  now?: () => number;
}

export function createKojoMarketPlugin(opts: KojoMarketPluginOptions): Plugin {
  const av = opts?.appVersion;
  // 形状复用契约的三段尺（预发布后缀先剥掉再核），本包不立第二份版本口径
  if (typeof av !== 'string' || !PACK_VERSION_RE.test(coreVersion(av))) {
    throw new Error(
      `kojo-market 需要装配层注入合法 appVersion（x.y.z[-预发布]），收到：${String(av)}`,
    );
  }
  return {
    id: 'kojo-market',
    version: '0.1.0',
    requires: [KernelServices.IO],
    provides: [MARKET_SERVICE_KEY],
    async activate(ctx): Promise<void> {
      const io = ctx.inject<FileIO>(KernelServices.IO);
      const appData = await io.appDataDir();
      const root = join(appData, MARKET_DIR_NAME);

      // 只此一次、只此一个根（市场的全部写入都在它下面；派生目录不另立根）
      io.addAppWritableRoot(root);
      await io.ensureDir(root);

      const service: MarketService = createMarketService({
        io,
        storage: ctx.storage,
        log: ctx.log,
        root,
        appVersion: av,
        ...(opts.now ? { now: opts.now } : {}),
      });
      ctx.provide(MARKET_SERVICE_KEY, service);
      ctx.log.info(`市场落点：${root}`);
    },
  };
}

export { sha256Hex, contentDigestOf, utf8Bytes } from './digest';
export { parseManifest, parseIndex, indexEntryProblem } from './manifest';
export { createMarketService, type MarketServiceDeps } from './service';
