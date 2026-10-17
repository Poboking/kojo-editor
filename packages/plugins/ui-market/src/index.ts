/**
 * @kojo/plugin-ui-market
 *
 * 口上市场面板（`ui.panel` 贡献；KM-3 + KM-8 索引面 + KM-10..12 安装面接线）。
 *
 * ## 本批能力面（刻意**很小**，别自己加）
 *
 * 只做这八件完整的事，不留空壳：
 * 1. 索引浏览（按种类分组 + 名称/作者过滤 + 版本/体积/文件数/作者/许可/版本要求）；
 * 2. 安装面动作：没装过的行给「安装」，`packUpdateCheck` 判为 `updatable` 的行给「更新」，
 *    `latest` / `ahead` / 版本要求不够的行**不给按钮**，只在行上说清本机是哪一版；
 * 3. 已装列表（版本 + 来源；核对码前 8 位、id/kind 只住展开层）；
 * 4. 卸载（**一次确认**，走 `runUninstall`：不确认连服务都不叫）；
 * 5. 拉取列表（挂载走 **stale-while-revalidate**：本地事实零网络上屏、TTL 到期才后台回源，
 *    cached 静默、refreshed/failed 出声；按钮硬回源；**数据时间**常驻，失败态显式）；
 * 6. 显式态（没有列表 / 读不出 / 目录读不动 / 没有包 ⇒ 各一句人话；绝不空白屏、绝不"加载中"常驻）；
 * 7. 已装的口上包行给「导入为我的口上项目」：面板只发意图
 *    （`workspace.importRequested`，载荷 `source: 'market'` 逐字冻结），
 *    向导与落地都住工作区消费方——面板不弹自己的窗、不摸盘（目录取 `contentDir()`）。
 * 8. 「发布口上…」（用户反馈 4 改名批）：工具条入口只发一条意图
 *    （`market.publishRequested`，载荷 `source: 'ui-market'`）。项目选择 / 许可 / 打包 / 上传
 *    全在拥有口上项目模型的适配器的发布向导里——面板不选文件、不摸盘、不持发布状态机。
 *
 * 装与卸的结果、以及被拒的原因，一律只有**一处内联状态行**（`mk-status` / `mk-note`），不弹窗。
 * "该给哪个动作"不在本面板判定：三态出自契约的 `packUpdateCheck`，装得上去不去出自服务；
 * 面板只做"把已装清单原样交给 `buildGroups`"，自己不再算一份已装键集（两份真相必然漂）。
 *
 * 依赖只有一个：`requires: [MARKET_SERVICE_KEY]`。**面板不摸盘**——
 * "本机有没有列表"与"有但读不出"是 `MarketService.index()` 判别联的两个分支，
 * 面板自己 `io.exists()` 一次就是把它复制了一遍（会漂）。
 *
 * 装配语义照 `ui-sugar-lift`：**不 import `@kojo/plugin-kojo-market`**
 * （audit C：插件间禁交叉 import；服务面就是接缝）。
 *
 * 文案纪律（作者长期口径）：机器词（`kind`/`id`/`manifest`/`index.json`/`sha256`/`schema`）
 * 不上主行，只在展开层与日志里出现；拒因只出自 `market-view.REJECT_TEXT` 那一张表。
 *
 * 包根导出面（刻意**很窄**）：`createUiMarketPlugin`（宿主装配，唯一消费方
 * `packages/app/src/bootstrap.ts`）；`MarketPanelView`（+ 其 `MarketPanelViewProps`）
 * 住 `market-panel-view.ts`，SSR 判据测试从那个模块拿。这里曾挂过两份"顺手全量转发"的
 * barrel（`./actions` 与 `./market-view` 各一整列名字），全仓零消费方——已删
 * （面板去重后续批）。要新增对外暴露，先找到真实消费方再加，别回来复制这张表。
 *
 * 模块布局（本文件只做装配：校验 appVersion + 注入服务 + 注册贡献，不含状态机与渲染）：
 * `market-panel.ts` 带状态面板 · `market-panel-view.ts` 渲染树 · `market-view.ts` 行判据与文案
 * · `actions.ts` 取数 / 装 / 卸 / 导入 / 发布意图 · `reconcile.ts` 已装清单的单飞重取。
 */

import {
  MARKET_SERVICE_KEY,
  PACK_VERSION_RE,
  coreVersion,
  type MarketService,
  type Plugin,
} from '@kojo/plugin-api';
import { type MarketActionDeps } from './actions';
import { createMarketPanel } from './market-panel';

export interface UiMarketPluginOptions {
  /**
   * 当前应用版本（判"这个包要求编辑器不低于 x.y.z"是否满足本机）。
   * 与 `kojo-market` 同一条口径：**真源在 app 包清单**，由装配层注入，插件源码不写版本号；
   * 形状不对即拒绝装配（宁可面板起不来，也不要"猜一个版本"让版本提示变成装饰）。
   */
  appVersion: string;
}

export function createUiMarketPlugin(opts: UiMarketPluginOptions): Plugin {
  const av = opts?.appVersion;
  if (typeof av !== 'string' || !PACK_VERSION_RE.test(coreVersion(av))) {
    throw new Error(`ui-market 需要装配层注入合法 appVersion（x.y.z[-预发布]），收到：${String(av)}`);
  }

  return {
    id: 'ui-market',
    version: '0.1.0',
    // 只有服务一个依赖：三态与"拉不拉得动远程"都在服务里，面板不再摸盘（收口 A）
    requires: [MARKET_SERVICE_KEY],
    activate(ctx): void {
      const deps: MarketActionDeps = {
        market: ctx.inject<MarketService>(MARKET_SERVICE_KEY),
        // 导入 / 发布都经总线发意图（面板不弹自己的窗：向导与落地都住消费方）
        bus: ctx.bus,
        log: ctx.log,
      };

      // 带状态的面板已迁出到 `market-panel.ts`；这里只做装配（贡献对象那条 `component: MarketPanel` 不动）。
      const MarketPanel = createMarketPanel(deps, av);

      ctx.slots.register('ui.panel', {
        id: 'market',
        title: '口上市场',
        // 店面图标（用户反馈 3）：市场不是一本书——教程入口的 book 不动
        icon: 'store',
        order: 85,
        // 主侧栏独占视图（对标 VSCode 扩展视图：入口住活动栏，点开落在左栏）。
        // 刻意**不写** `defaultActive:false`：那个字段还会把视图贬到活动栏底部低频组
        // （`ShellLayout.isLowFreqView`，ProjectView 同一条先例注释）。
        // "点开才拉数据"不靠它——侧栏面板只在视图被激活时才挂载（`reload` 挂在 effect 上）。
        location: 'sidebar',
        component: MarketPanel,
      });
    },
  };
}
