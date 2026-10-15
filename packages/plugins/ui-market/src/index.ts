/**
 * @kojo/plugin-ui-market
 *
 * 口上市场面板（`ui.panel` 贡献；KM-3 + KM-8 索引面接线）。
 *
 * ## 本批能力面（刻意**很小**，别自己加）
 *
 * 安装面（从注册表装包）还没接线 ⇒ 面板不放安装按钮、不留空壳，只做五件完整的事：
 * 1. 索引浏览（按种类分组 + 名称/作者过滤 + 版本/体积/文件数/作者/许可/版本要求）；
 * 2. 已装列表（版本 + 来源；核对码前 8 位只住展开层）；
 * 3. 卸载（**一次确认**，走 `runUninstall`：不确认连服务都不叫）；
 * 4. 拉取列表（挂载走 TTL、按钮硬回源；**数据时间**常驻，失败态显式）；
 * 5. 显式态（没有列表 / 读不出 / 目录读不动 / 没有包 ⇒ 各一句人话；绝不空白屏、绝不"加载中"常驻）。
 *
 * 依赖只有一个：`requires: [MARKET_SERVICE_KEY]`。**面板不摸盘**——
 * "本机有没有列表"与"有但读不出"是 `MarketService.index()` 判别联的两个分支，
 * 面板自己 `io.exists()` 一次就是把它复制了一遍（会漂）。
 *
 * 装配语义照 `ui-sugar-lift`：**不 import `@kojo/plugin-kojo-market`**
 * （audit C：插件间禁交叉 import；服务面就是接缝）。
 *
 * 文案纪律（作者长期口径）：机器词（`kind`/`id`/`manifest`/`index.json`/`sha256`/`schema`）
 * 不上主行，只在展开层与日志里出现；卸载结果走**面板内联状态行**，不弹窗（HK-4）。
 */

import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  MARKET_SERVICE_KEY,
  PACK_VERSION_RE,
  coreVersion,
  type MarketService,
  type Plugin,
  type UIPanelProps,
} from '@kojo/plugin-api';
import {
  loadMarketSnapshot,
  pullMarketSnapshot,
  runUninstall,
  type MarketActionDeps,
  type MarketSnapshot,
} from './actions';
import {
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_HINT,
  dataTimeLine,
  droppedNotice,
  formatBytes,
  installedKey,
  pendingKey,
  statusText,
} from './market-view';

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
        log: ctx.log,
      };

      function MarketPanel(props: UIPanelProps): ReactNode {
        // 首帧 busy=true ⇒ 状态行还不画（别把"还没读"演成"列表缺失"）；读失败也不会常驻"加载中"
        const [snapshot, setSnapshot] = useState<MarketSnapshot>({
          status: 'list-missing',
          packs: [],
          installed: [],
          dropped: [],
          reason: '',
          fetchedAt: null,
          generatedAt: null,
          endpoint: '',
          pullNote: '',
        });
        const [busy, setBusy] = useState(true);
        const [note, setNote] = useState('');
        const [query, setQuery] = useState('');
        // 待确认的卸载（同一时刻只允许一条）+ 展开层（已装条目的机器面）
        const [pending, setPending] = useState<string | null>(null);
        const [open, setOpen] = useState<string | null>(null);

        /** 打开面板：走 TTL（新鲜期内不回源，但数据时间与拉取结果照样显示） */
        const reload = useCallback(async (): Promise<void> => {
          setBusy(true);
          const snap = await pullMarketSnapshot(deps, false);
          setSnapshot(snap);
          setNote(snap.pullNote);
          setBusy(false);
        }, []);

        /** 点「拉取列表」：无视 TTL 硬回源一次（作者刚改了注册表就是要立刻看到） */
        const pull = useCallback(async (): Promise<void> => {
          setBusy(true);
          const snap = await pullMarketSnapshot(deps, true);
          setSnapshot(snap);
          setNote(snap.pullNote);
          setBusy(false);
        }, []);

        // 挂载即拉一次（`defaultActive:false` ⇒ 作者点开侧栏才发数据，不开不占资源）
        useEffect(() => {
          void reload();
        }, [reload, props.refreshTick]);

        const doUninstall = async (key: string): Promise<void> => {
          const rec = snapshot.installed.find((r) => pendingKey(r) === key);
          if (rec === undefined) return;
          setNote(`正在卸掉「${rec.name}」…`);
          const out = await runUninstall(deps, rec, pending === key);
          setPending(null);
          setNote(out.note);
          if (out.kind === 'done') {
            setOpen(null);
            setSnapshot(await loadMarketSnapshot(deps));
          }
        };

        // 已装清单**原样**交给视图层：三态与"这一行该给什么动作"由契约的 `packUpdateCheck`
        // 从这份清单算；面板自己再拼一份已装键集就是第二份真相（`buildGroups` 的签名拦的就是这个）
        const groups = buildGroups(snapshot.packs, av, query, snapshot.installed);
        const rows = buildInstalledRows(snapshot.installed);
        const line = statusText(snapshot.status, snapshot.reason);
        const time = dataTimeLine(snapshot);
        const droppedLine = droppedNotice(snapshot.dropped);

        const indexSection = (g: ReturnType<typeof buildGroups>[number]): ReactNode =>
          createElement(
            'section',
            { className: 'mk-group', key: g.kind },
            createElement('h4', { className: 'mk-grouptitle' }, g.label),
            ...g.rows.map((row) => {
              const e = row.entry;
              return createElement(
                'div',
                { className: 'mk-row', key: installedKey(e.kind, e.id, e.version) },
                createElement(
                  'div',
                  { className: 'mk-main' },
                  createElement('span', { className: 'mk-name' }, e.name),
                  createElement('span', { className: 'mk-meta' }, `版本 ${e.version}`),
                  createElement(
                    'span',
                    { className: 'mk-meta' },
                    `${formatBytes(e.unpackedBytes)} · ${e.fileCount} 个文件`,
                  ),
                  createElement('span', { className: 'mk-meta' }, `作者 ${e.author}`),
                  createElement('span', { className: 'mk-meta' }, `许可 ${e.license}`),
                  row.installed ? createElement('span', { className: 'mk-badge' }, '已安装') : null,
                ),
                row.appOk
                  ? null
                  : createElement('div', { className: 'mk-warn' }, appVersionRequirement(e.minAppVersion)),
                e.summary === undefined ? null : createElement('div', { className: 'mk-sub' }, e.summary),
              );
            }),
          );

        return createElement(
          'div',
          { className: 'panel-market' },
          createElement(
            'div',
            { className: 'mk-toolbar' },
            createElement('input', {
              className: 'mk-search',
              type: 'search',
              placeholder: '按包名或作者过滤',
              value: query,
              onInput: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value),
            }),
            createElement(
              'button',
              { className: 'ghost small', disabled: busy, onClick: () => void pull() },
              busy ? '拉取中…' : '拉取列表',
            ),
          ),
          line === '' || busy ? null : createElement('div', { className: 'mk-status' }, line),
          // 数据时间与拉取结果**不受 busy 遮掩**：失败态必须一直在屏上（不许"加载中"常驻顶掉它）
          time === '' ? null : createElement('div', { className: 'mk-time' }, time),
          note === '' ? null : createElement('div', { className: 'mk-note' }, note),
          droppedLine === '' ? null : createElement('div', { className: 'mk-warn' }, droppedLine),
          createElement('div', { className: 'mk-hint' }, CAPABILITY_HINT),
          createElement('h4', { className: 'mk-grouptitle' }, '已安装'),
          rows.length === 0
            ? createElement('div', { className: 'mk-empty' }, '本机还没有装好的包')
            : createElement(
                'div',
                { className: 'mk-list' },
                ...rows.map((r) => {
                  const key = pendingKey(r.rec);
                  const expanded = open === key;
                  const confirming = pending === key;
                  return createElement(
                    'div',
                    { className: expanded ? 'mk-row open' : 'mk-row', key },
                    createElement(
                      'div',
                      { className: 'mk-main' },
                      createElement(
                        'button',
                        { className: 'ghost small', onClick: () => setOpen(expanded ? null : key) },
                        expanded ? '收起' : '详情',
                      ),
                      createElement('span', { className: 'mk-name' }, r.rec.name),
                      createElement('span', { className: 'mk-meta' }, `版本 ${r.rec.version}`),
                      createElement('span', { className: 'mk-meta' }, r.kindLabel),
                      createElement('span', { className: 'mk-meta' }, `来源 ${r.sourceLabel}`),
                      createElement('span', { className: 'mk-meta' }, `作者 ${r.rec.author}`),
                      createElement('span', { className: 'mk-meta' }, `许可 ${r.rec.license}`),
                      confirming
                        ? createElement(
                            'span',
                            { className: 'mk-confirm' },
                            '确认卸载？',
                            createElement('button', { className: 'ghost small', onClick: () => void doUninstall(key) }, '确认'),
                            createElement(
                              'button',
                              { className: 'ghost small', onClick: () => setPending(null) },
                              '取消',
                            ),
                          )
                        : createElement(
                            'button',
                            { className: 'ghost small', onClick: () => setPending(key) },
                            '卸载',
                          ),
                    ),
                    // 展开层 = 机器面：核对码 / 种类 / id 照旧给全（主行不放机器词）
                    expanded
                      ? createElement(
                          'div',
                          { className: 'mk-detail' },
                          createElement('div', null, `核对码 ${r.digestPrefix}`),
                          createElement('div', null, `文件 ${r.rec.files.length} 个`),
                          createElement('div', null, `id ${r.rec.id} · kind ${r.rec.kind}`),
                        )
                      : null,
                  );
                }),
              ),
          snapshot.status === 'ready' && groups.length === 0
            ? createElement('div', { className: 'mk-empty' }, `没有名字或作者里含「${query}」的包`)
            : null,
          ...groups.map((g) => indexSection(g)),
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'market',
        title: '口上市场',
        icon: 'book',
        order: 85,
        location: 'aux',
        // 新功能默认不开：入口在侧栏，作者点开才拉数据（也不另设总闸）
        defaultActive: false,
        component: MarketPanel,
      });
    },
  };
}

export {
  loadMarketSnapshot,
  pullMarketSnapshot,
  runUninstall,
  type MarketActionDeps,
  type MarketSnapshot,
  type UninstallOutcome,
} from './actions';
export {
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_HINT,
  dataTimeLine,
  droppedNotice,
  formatBytes,
  formatClock,
  formatGeneratedAt,
  KIND_LABEL,
  matchesQuery,
  refreshNote,
  resolveStatus,
  STATUS_TEXT,
  statusText,
  type MarketViewStatus,
} from './market-view';
