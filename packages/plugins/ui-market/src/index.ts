/**
 * @kojo/plugin-ui-market
 *
 * 口上市场面板（`ui.panel` 贡献；KM-3 + KM-8 索引面 + KM-10..12 安装面接线）。
 *
 * ## 本批能力面（刻意**很小**，别自己加）
 *
 * 只做这七件完整的事，不留空壳：
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
 * 8. 「发布包…」（MK-PUB 发布通道批）：工具条入口 → 选 zip（`chooseFile` 对话框即授权）
 *    → 服务编排（本地预校验零出网 → 原样字节上传）→ 进度与结果只住状态行一处。
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
 * `packages/app/src/bootstrap.ts`）与 `MarketPanelView`（+ 其 `MarketPanelViewProps`，
 * SSR 判据测试走相对路径 `../src/index` 拿）。这里曾挂过两份"顺手全量转发"的
 * barrel（`./actions` 与 `./market-view` 各一整列名字），全仓零消费方——已删
 * （面板去重后续批）。要新增对外暴露，先找到真实消费方再加，别回来复制这张表。
 */

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KernelServices,
  MARKET_SERVICE_KEY,
  PACK_VERSION_RE,
  coreVersion,
  type FileIO,
  type InstalledPack,
  type MarketDownloadProgress,
  type MarketPublishProgress,
  type MarketService,
  type Plugin,
  type UIPanelProps,
} from '@kojo/plugin-api';
import {
  loadMarketSnapshot,
  pullMarketOutcome,
  pullMarketSnapshot,
  runImport,
  runInstall,
  runPublish,
  runUninstall,
  snapshotWithInstalled,
  snapshotWithoutInstalled,
  type MarketActionDeps,
  type MarketSnapshot,
} from './actions';
import {
  acceptReread,
  attachMarketInvalidation,
  type MarketInvalidationHandle,
} from './reconcile';
import {
  ACTION_LABEL,
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_HINT,
  CLEAR_LABEL,
  dataTimeLine,
  droppedNotice,
  filterEmptyPhrase,
  formatBytes,
  groupCountPhrase,
  IMPORT_LABEL,
  indexRowKey,
  installedCountPhrase,
  installBusyNote,
  installProgressNote,
  pendingKey,
  PUBLISH_LABEL,
  publishProgressNote,
  statusText,
  updatePhrase,
  type PackRow,
} from './market-view';

export interface UiMarketPluginOptions {
  /**
   * 当前应用版本（判"这个包要求编辑器不低于 x.y.z"是否满足本机）。
   * 与 `kojo-market` 同一条口径：**真源在 app 包清单**，由装配层注入，插件源码不写版本号；
   * 形状不对即拒绝装配（宁可面板起不来，也不要"猜一个版本"让版本提示变成装饰）。
   */
  appVersion: string;
}

/**
 * 面板的**渲染树**（零状态、零 IO：给一份事实与几个回调就画得出来）。
 *
 * 与带状态的 `MarketPanel` 分家的理由与本包的既有纪律同源（"把意图落成函数，
 * 组件只负责把点击接到它们上面"）：**"这一行到底给不给按钮"是安装面的判据**，
 * 而带状态的组件在 node 环境里跑不了 effect（拿不到数据），也就点不动。
 * 分家之后这一层可以被静态渲染直接检：`updatable` 行真有「更新」、`ahead` 行真没有按钮。
 *
 * 文案纪律在这一层同样成立：机器词只出现在已装条目的展开层（`mk-detail`）。
 */
export interface MarketPanelViewProps {
  readonly snapshot: MarketSnapshot;
  /** 装配层注入的当前应用版本（面板源码不写版本号） */
  readonly appVersion: string;
  readonly query: string;
  /** 读列表进行中（首帧即 true ⇒ 状态行还不画，但数据时间行照旧常驻） */
  readonly busy: boolean;
  /** 内联状态行那一句：装 / 卸的进行中、结果与拒因全写在这一处，不弹窗 */
  readonly note: string;
  /** 待确认卸载的那一条（同一时刻只允许一条） */
  readonly pending: string | null;
  /** 展开的已装条目（机器面） */
  readonly open: string | null;
  /**
   * 正在进行装/更新的那一行；非空 ⇒ 所有动作按钮禁用（同一时刻只搬一次）。
   * 禁用**只改 `disabled`，不改按钮文字**：进度那一句只住 `.mk-note` 一处。
   */
  readonly installing: string | null;
  /** 发布进行中（选 zip → 预校验 → 上传的全程；与装/更新互斥，同一时刻只做一件事） */
  readonly publishing: boolean;
  onQuery(q: string): void;
  /** 清空过滤（工具条上那枚「清除」；过滤态下它是空态那句话的唯一出路，不另设弹窗） */
  onClearQuery(): void;
  onPull(): void;
  /** 工具条「发布包…」：选 zip（对话框即授权）→ 服务编排（预校验 + 上传） */
  onPublish(): void;
  onInstall(row: PackRow): void;
  /** 已装的口上包行：把这一条经 `workspace.importRequested` 交给工作区消费方 */
  onImport(rec: InstalledPack): void;
  /** 索引行来源网址：把 URL 经 `ui.openExternal` 交给壳层（闸在 Rust，本层只发意图） */
  onOpenSource(url: string): void;
  onRequestUninstall(key: string): void;
  onConfirmUninstall(key: string): void;
  onCancelUninstall(): void;
  onToggleDetail(key: string): void;
}

/**
 * 一版面的 DOM 契约（样式由 app 侧 `mk-*` 区块实现，本层只负责产出这些类名与层级）：
 *
 * ```text
 * .panel-market                 根：列布局，外层不滚
 * ├─ .mk-toolbar                flex:none —— 搜索框 / 清除 / 拉取（永不随列表滚走）
 * ├─ .mk-flash                  状态簇（role=status）：.mk-status .mk-time .mk-note(aria-live) .mk-warn .mk-hint
 * └─ .mk-body                   flex:1 自滚 —— 只有列表随滚动移动
 *     ├─ .mk-grouptitle + span.mk-count → .mk-list → .mk-row × n（已装）
 *     └─ section.mk-group → h4.mk-grouptitle + span.mk-count → .mk-row × n（索引）
 *         .mk-row > .mk-main > .mk-head[ span.mk-name | span.mk-badge? | div.mk-actions ]
 *                            + .mk-facts[ span.mk-meta × n ]
 *                  ＋ 行级附属：.mk-warn（版本要求）/ .mk-sub（摘要）/ button.mk-sub.mk-link（来源，可点）/ .mk-detail（展开层）
 * ```
 *
 * 四条结构性口径：
 * 1. **两排，不是一排挤到底**——第一排只有名字、徽章与动作（动作钉右端），第二排才是次要事实；
 *    把动作丢进同一个 wrap 容器末尾会让名字吃掉剩余宽度、把动作挤到第三排（窄侧栏密度事故）；
 * 2. **状态与列表分家**——工具条、状态、数据时间、说明住在滚动区之外，
 *    列表长到几十条时作者仍然看得见"这是哪一刻的数据"；
 * 3. **按钮 children 永远是纯字符串**（图标一律不上按钮）：动作判据按标签找按钮、并把 `onClick` 真的调一次；
 * 4. **类名是跨包契约**——本层只产出这些类名与层级，一切视觉（颜色 / 圆角 / 滚动 / 焦点环）住 app 侧 `mk-*` 区块。
 */
export function MarketPanelView(p: MarketPanelViewProps): ReactNode {
  const { snapshot } = p;
  // 已装清单**原样**交给视图层：三态由契约的 `packUpdateCheck` 从这份清单算。
  // 这一层再拼一份"已装键集"就是第二份真相（`buildGroups` 的签名拦的就是这个）。
  const groups = buildGroups(snapshot.packs, p.appVersion, p.query, snapshot.installed);
  const rows = buildInstalledRows(snapshot.installed);
  const line = statusText(snapshot.status, snapshot.reason);
  const time = dataTimeLine(snapshot);
  const droppedLine = droppedNotice(snapshot.dropped);
  // 过滤态：能力面说明讲的是"这面板能干什么"，与作者此刻正在找的这几条无关 ⇒ 让位不占行；
  // 空态 / 错误态那几句照给——它们说的正是这一屏此刻的事实。
  const filtering = p.query !== '';
  // 占用读数取服务 `installedBytes()`（契约里那条唯一口径），面板不自己把 files 加一遍
  const installedCount = installedCountPhrase(rows.length, snapshot.installedBytes);
  // 同一屏动作纪律：装/更新/发布任一进行中 ⇒ 全部动作按钮禁用（同一时刻只做一件事）；
  // 进度仍只写 `.mk-note` 一处，按钮文字不变
  const acting = p.installing !== null || p.publishing;

  /** 次要事实（版本 / 体积 / 作者 / 许可…）一律退到第二排 */
  const meta = (text: string): ReactNode => createElement('span', { className: 'mk-meta' }, text);
  /** 动作按钮的统一形状：`ghost small` + 进行中禁用；**文字永远不变**（进度只住 `.mk-note` 一处） */
  const btn = (label: string, onClick: () => void, disabled: boolean): ReactNode =>
    createElement('button', { className: 'ghost small', disabled, onClick }, label);
  /** 这一行的全部动作都住这里（名字那一排的右端；`.mk-main` 里不再有裸按钮） */
  const actions = (...buttons: ReactNode[]): ReactNode =>
    createElement('div', { className: 'mk-actions' }, ...buttons);
  /**
   * 第一排 = 名字 + 徽章 + 动作（动作钉右端）；第二排 = 次要事实。
   * 分两排而不是把动作丢在同一个 wrap 容器末尾：后者会让"名字吃掉剩余宽度"把动作簇
   * 挤到第三排，一张卡从两行变四行——窄侧栏里这就是密度事故。
   */
  const main = (name: string, badge: ReactNode, acts: ReactNode, facts: ReactNode[]): ReactNode =>
    createElement(
      'div',
      { className: 'mk-main' },
      createElement(
        'div',
        { className: 'mk-head' },
        createElement('span', { className: 'mk-name', title: name }, name),
        badge,
        acts,
      ),
      createElement('div', { className: 'mk-facts' }, ...facts),
    );

  const indexSection = (g: ReturnType<typeof buildGroups>[number]): ReactNode =>
    createElement(
      'section',
      { className: 'mk-group', key: g.kind },
      createElement(
        'h4',
        { className: 'mk-grouptitle' },
        g.label,
        createElement('span', { className: 'mk-count' }, groupCountPhrase(g.rows.length)),
      ),
      ...g.rows.map((row) => {
        const e = row.entry;
        const phrase = updatePhrase(row);
        const sourceUrl = e.sourceUrl;
        return createElement(
          'div',
          { className: 'mk-row', key: indexRowKey(e) },
          main(
            e.name,
            phrase === '' ? null : createElement('span', { className: 'mk-badge' }, phrase),
            // `action === 'none'` ⇒ 这一行没有可点动作（已装最新 / 本机更高 / 版本要求不够），
            // 行上那句 `mk-badge` 或 `mk-warn` 就是它的说明（动作簇仍占右端位，行与行不错位）
            actions(
              row.action === 'none'
                ? null
                : btn(ACTION_LABEL[row.action], () => p.onInstall(row), acting),
            ),
            [
              meta(`版本 ${e.version}`),
              meta(`${formatBytes(e.unpackedBytes)} · ${e.fileCount} 个文件`),
              meta(`作者 ${e.author}`),
              meta(`许可 ${e.license}`),
            ],
          ),
          row.appOk
            ? null
            : createElement('div', { className: 'mk-warn' }, appVersionRequirement(e.minAppVersion)),
          e.summary === undefined ? null : createElement('div', { className: 'mk-sub' }, e.summary),
          // 来源网址住**子层**（灰色小行），主行纪律不动；已接 `ui.openExternal` 外链原语
          // ——button 语义、`mk-sub` 观感不变，只发意图：闸（https + 主机白名单）在 Rust，
          // 本层不复制白名单、不摸平台（插件够不着）
          sourceUrl === undefined
            ? null
            : createElement(
                'button',
                {
                  className: 'mk-sub mk-link',
                  type: 'button',
                  title: `在浏览器打开 ${sourceUrl}`,
                  onClick: () => p.onOpenSource(sourceUrl),
                },
                `来源 ${sourceUrl}`,
              ),
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
        'aria-label': '按包名或作者过滤',
        value: p.query,
        onInput: (event: { currentTarget: { value: string } }) => p.onQuery(event.currentTarget.value),
      }),
      // 只在过滤态出现：这一枚就是空态那句话唯一的出路（点了清空查询，不弹窗）
      filtering
        ? createElement(
            'button',
            { className: 'ghost small mk-clear', onClick: () => p.onClearQuery() },
            CLEAR_LABEL,
          )
        : null,
      createElement(
        'button',
        { className: 'ghost small', disabled: p.busy || acting, onClick: () => p.onPull() },
        p.busy ? '拉取中…' : '拉取列表',
      ),
      // 发布包…：选 zip（对话框即授权）→ 服务编排（本地预校验 → 原样上传），
      // 结果与进度照旧只住状态行一处（`onPublish` 的实现在带状态的 MarketPanel 里）
      createElement(
        'button',
        { className: 'ghost small', disabled: p.busy || acting, onClick: () => p.onPublish() },
        PUBLISH_LABEL,
      ),
    ),
    // 状态簇在滚动区之外：列表再长，"这一次到底拉没拉成"也不会被滚出视野
    createElement(
      'div',
      { className: 'mk-flash', role: 'status' },
      line === '' || p.busy ? null : createElement('div', { className: 'mk-status' }, line),
      // 数据时间与拉取结果**不受 busy 遮掩**：失败态必须一直在屏上（不许"加载中"常驻顶掉它）
      time === '' ? null : createElement('div', { className: 'mk-time' }, time),
      // 装 / 卸的进行中与结果全写在这一处（`aria-live` 让读屏跟得上；不弹窗）
      p.note === '' ? null : createElement('div', { className: 'mk-note', 'aria-live': 'polite' }, p.note),
      droppedLine === '' ? null : createElement('div', { className: 'mk-warn' }, droppedLine),
      filtering ? null : createElement('div', { className: 'mk-hint' }, CAPABILITY_HINT),
    ),
    createElement(
      'div',
      { className: 'mk-body' },
      createElement(
        'h4',
        { className: 'mk-grouptitle' },
        '已安装',
        installedCount === '' ? null : createElement('span', { className: 'mk-count' }, installedCount),
      ),
      rows.length === 0
        ? createElement('div', { className: 'mk-empty' }, '本机还没有装好的包')
        : createElement(
            'div',
            { className: 'mk-list' },
            ...rows.map((r) => {
              const key = pendingKey(r.rec);
              const expanded = p.open === key;
              const confirming = p.pending === key;
              return createElement(
                'div',
                { className: expanded ? 'mk-row open' : 'mk-row', key },
                main(
                  r.rec.name,
                  null,
                  actions(
                    // 展开切换是这一行的第一个动作：`aria-expanded` 给读屏（行本身是 div，不是按钮语义）
                    createElement(
                      'button',
                      {
                        className: 'ghost small',
                        'aria-expanded': expanded,
                        onClick: () => p.onToggleDetail(key),
                      },
                      expanded ? '收起' : '详情',
                    ),
                    // 只有口上包能导入成口上项目（判定在 `buildInstalledRows` 的行标记上）；
                    // 同一屏动作纪律：装/更新进行中一律禁用，进度仍只写状态行一处
                    r.canImport
                      ? btn(IMPORT_LABEL, () => p.onImport(r.rec), acting)
                      : null,
                    confirming
                      ? createElement(
                          'span',
                          {
                            className: 'mk-confirm',
                            // 簇内按 Esc 就取消（焦点在簇里的按钮上，事件冒泡到这一层）；
                            // 刻意不注册全局键，也不碰 shell-keys——离开这一簇键盘照常走
                            onKeyDown: (event: { key: string }) => {
                              if (event.key === 'Escape') p.onCancelUninstall();
                            },
                          },
                          '确认卸载？',
                          btn('确认', () => p.onConfirmUninstall(key), acting),
                          // 取消永远可点：正在装别的包也不该把作者锁在确认态里
                          btn('取消', () => p.onCancelUninstall(), false),
                        )
                      : btn('卸载', () => p.onRequestUninstall(key), acting),
                  ),
                  [
                    meta(`版本 ${r.rec.version}`),
                    meta(r.kindLabel),
                    meta(`来源 ${r.sourceLabel}`),
                    meta(`作者 ${r.rec.author}`),
                    meta(`许可 ${r.rec.license}`),
                  ],
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
        ? createElement('div', { className: 'mk-empty' }, filterEmptyPhrase(p.query))
        : null,
      ...groups.map((g) => indexSection(g)),
    ),
  );
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
        // 导入请求经总线发意图（面板不弹自己的窗：向导与落地都住工作区消费方）
        bus: ctx.bus,
        log: ctx.log,
      };
      // 文件选择原语（发布用）：kernel.io 是内核预定义服务恒在位；chooseFile 本身
      // 是 additive 可选——缺席（Node 壳）由 runPublish 给一句人话，这里不判
      const io = ctx.inject<FileIO>(KernelServices.IO);

      function MarketPanel(props: UIPanelProps): ReactNode {
        // 首帧 busy=true ⇒ 状态行还不画（别把"还没读"演成"列表缺失"）；读失败也不会常驻"加载中"
        const [snapshot, setSnapshot] = useState<MarketSnapshot>({
          status: 'list-missing',
          packs: [],
          installed: [],
          installedBytes: 0,
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
        // 正在进行的那一次装/更新（同一时刻只允许一条：按钮全禁用，进度只写在状态行一处）
        const [installing, setInstalling] = useState<string | null>(null);
        // 发布进行中（选 zip → 预校验 → 上传的全程；与装/更新互斥，同一时刻只做一件事）
        const [publishing, setPublishing] = useState(false);
        // 后台校对的单调序号：只认最新一次发起的读数——装/卸快速连击时，前一次的校对
        // 可能比后一次晚落，没有这道闸旧事实会倒灌（卸掉的行被"复活"且无后续纠正）
        const readSeq = useRef(0);

        /**
         * 装卸成功后的**即时重取**（MK-1 的"重取"那一半，触发点在服务的清单变更通知上）。
         *
         * 乐观只是显示先行，机器说了算的纪律不破——重读仍是唯一权威，若有漂移由它纠正
         * （判据：卸载确认后行消失 ≤ 目录消失 + 300ms；四路 IPC 全量重读同步等撑不住这个数字，
         * 所以才有"乐观立刻 + 通知驱动单飞重取兜底"这一对）。
         *
         * 单飞由 `attachMarketInvalidation` 保证：连点装卸 ⇒ 串行若干趟、任意时刻至多一趟在跑，
         * 每一次请求都由"它之后开始的那一趟"兑现（旧读数既不会并发插队，也不会倒灌）。
         * 订阅挂在 effect 上，退订挂在卸载上：关掉的面板不该继续替它重取。
         */
        const invalidationRef = useRef<MarketInvalidationHandle | null>(null);
        // 最近一次**开始**的重取令牌：`read` 负责抬它，`onSnapshot` 负责用它判落不落屏
        // （抬令牌与落屏分成两处，是 `attachMarketInvalidation` 的口径——落屏点只许有一个）
        const revalidateSeqRef = useRef(0);
        if (invalidationRef.current === null) {
          invalidationRef.current = attachMarketInvalidation({
            market: deps.market,
            read: (): Promise<MarketSnapshot> => {
              revalidateSeqRef.current = ++readSeq.current; // 这一趟比任何在途读数新 ⇒ 旧的一手一律作废
              return loadMarketSnapshot(deps);
            },
            onSnapshot: (snap: MarketSnapshot): void => {
              // 落不落屏只看这一条判据（`acceptReread`）：读失败不清屏上那份事实
              if (
                acceptReread({ stale: readSeq.current !== revalidateSeqRef.current, status: snap.status })
              ) {
                setSnapshot(snap);
              }
            },
            onError: (err: unknown): void => {
              deps.log.warn(`市场已装清单的重取没有成功：${err instanceof Error ? err.message : String(err)}`);
            },
          });
        }
        const revalidateInstalled = useCallback((): Promise<MarketSnapshot> => {
          return invalidationRef.current!.revalidate();
        }, []);
        useEffect(() => () => invalidationRef.current!.dispose(), []);

        /**
         * 打开面板：**stale-while-revalidate** 两段式——
         * 先零网络读本地立刻上屏（有列表秒出列表，没有就诚实说没有），再后台按 TTL 回源
         * （TTL 判定在服务里，`cached` = 无事发生）。busy 只罩本地读那一下：
         * 远程慢（超时最长 15s）不许把"打开面板"卡成"屏幕上像没有包"。
         */
        const reload = useCallback(async (): Promise<void> => {
          const local = ++readSeq.current; // 在途的后台读数（上一次回源/校对）一律作废
          setBusy(true);
          const localSnap = await loadMarketSnapshot(deps);
          // 本地读到手的这一刻 busy 就交还（背景段再慢也不占用它）；
          // 快照落不落地看序号：被更新的一手（pull / 下一次挂载）顶掉就整包丢弃
          setBusy(false);
          if (readSeq.current === local) setSnapshot(localSnap);
          const remote = ++readSeq.current;
          void pullMarketOutcome(deps, false).then((out) => {
            if (readSeq.current !== remote) return; // 序号被抬走 ⇒ 旧读数不倒灌
            // 服务整体炸了（list-unreadable）不清掉刚上屏的本地事实（与 `acceptReread` 同一条纪律），但要出声
            if (out.snap.status !== 'list-unreadable') setSnapshot(out.snap);
            // cached = 一切正常 ⇒ 静默（正常面板不该有废话）；refreshed / failed 才出声
            if (out.state !== 'cached') setNote(out.snap.pullNote);
          });
        }, []);

        /** 点「拉取列表」：无视 TTL 硬回源一次（作者刚改了注册表就是要立刻看到） */
        const pull = useCallback(async (): Promise<void> => {
          readSeq.current += 1; // 同上：硬回源的结果比任何在途校对新
          setBusy(true);
          const snap = await pullMarketSnapshot(deps, true);
          setSnapshot(snap);
          setNote(snap.pullNote);
          setBusy(false);
        }, []);

        // 挂载即两段式刷新（`defaultActive:false` ⇒ 作者点开侧栏才发数据，不开不占资源）
        useEffect(() => {
          void reload();
        }, [reload, props.refreshTick]);

        /**
         * 装 / 更新这一行。**按钮该不该存在不由这里判**（`row.action` 已由 `packUpdateCheck` 决定），
         * 这里只负责：把这一行交给服务 → 结果写成状态行那一句 → 成了就重读一遍本机事实（不回源）。
         */
        const doInstall = async (row: PackRow): Promise<void> => {
          // 先把动作提出局部常量：进度闭包捕获**属性**会丢缩窄（TS 对回调内的 `row.action` 不保留判别）
          const action = row.action;
          if (action === 'none' || installing !== null) return;
          const key = indexRowKey(row.entry);
          setInstalling(key);
          setNote(installBusyNote(action, row.entry.name));
          // 进度接进同一条状态行（Rust 侧已节流，这里不重复闸）。回调只在下载段发：
          // 解压/搬运阶段停在最后一条读数是**如实**的（那两段快，不发假进度）。
          const onProgress = (p: MarketDownloadProgress): void => {
            setNote(installProgressNote(action, row.entry.name, p));
          };
          const out = await runInstall(deps, row.entry, action, onProgress);
          setInstalling(null);
          setNote(out.note);
          if (out.kind === 'done') {
            // 乐观只是显示先行：行立刻出现（MK-1 判据），权威数字由通知驱动的那一趟重取修正。
            // **函数式**更新：拿闭包里那份 `snapshot` 拼会盖掉同窗口内已经落地的重读结果
            // （服务在 Promise 落回之前就已经广播了，那一趟可能比这里先落地）。
            setSnapshot((prev) => snapshotWithInstalled(prev, out.rec));
          } else {
            // 失败**不发通知**（服务只在清单真的变过时出声）⇒ 这里主动核一趟：
            // 搬进落点成功而记账失败那一类，屏上"没装"与盘上"有目录"就是两份真相，必须当场对齐。
            void revalidateInstalled();
          }
        };

        /**
         * 卸载这一条。与 `doInstall` 同一条单飞纪律，漏了它会把成功演成失败：
         * 「确认」按钮的 disabled 只看 `installing`，没有互斥时双击会并发调两次
         * `uninstall`，第二把抛 `installed-missing`，作者看到的却是"卸载没有成功"——实际早已卸干净。
         * 「取消」永远可点不动（正在装别的包也不该把作者锁在确认态里）。
         */
        const doUninstall = async (key: string): Promise<void> => {
          if (installing !== null) return;
          const rec = snapshot.installed.find((r) => pendingKey(r) === key);
          if (rec === undefined) return;
          setInstalling(pendingKey(rec));
          try {
            setNote(`正在卸掉「${rec.name}」…`);
            const out = await runUninstall(deps, rec, pending === key);
            setPending(null);
            setNote(out.note);
            if (out.kind === 'done') {
              setOpen(null);
              // 乐观只是显示先行：行立刻消失（MK-1 判据），权威数字由通知驱动的那一趟重取修正；
              // 函数式更新的理由同 `doInstall`——别拿闭包里那份旧快照去盖已经落地的新读数。
              setSnapshot((prev) => snapshotWithoutInstalled(prev, rec));
            } else {
              // 同 `doInstall`：失败不出声于服务（清单没变过），但"目录已删 / 记账还在"这类
              // 半趟只有重读能判 ⇒ 主动核一趟，屏上不留着一条作者点不动的僵尸行。
              void revalidateInstalled();
            }
          } finally {
            setInstalling(null);
          }
        };

        /**
         * 已装的口上包行「导入为我的口上项目」：只发意图（事件），不自己弹窗。
         * 不另设 busy 态——这一步只是取一个目录路径 + 发一条事件，没有可展示的进度；
         * 结果与失败照旧写内联状态行一处。装/更新进行中与其它按钮同样不响应（按钮已禁用）。
         */
        const doImport = async (rec: InstalledPack): Promise<void> => {
          if (installing !== null) return;
          const out = await runImport(deps, rec);
          setNote(out.note);
        };

        /**
         * 「发布包…」（MK-PUB）：runPublish 全程接管选 zip → 预校验 → 上传，
         * 本层只负责互斥（与装/更新同一时刻只做一件事）与把进度接进状态行
         * （Rust 侧已节流，这里不重复闸）。取消不是失败，note 照实说「本机没动」。
         */
        const doPublish = async (): Promise<void> => {
          if (publishing || installing !== null) return;
          setPublishing(true);
          try {
            const onProgress = (p: MarketPublishProgress): void => {
              setNote(publishProgressNote(p));
            };
            const out = await runPublish(deps, io, onProgress);
            setNote(out.note);
          } finally {
            setPublishing(false);
          }
        };

        // 状态与回调住这一层；怎么画、哪一行给不给按钮全在 `MarketPanelView`（可静态渲染判据）
        return createElement(MarketPanelView, {
          snapshot,
          appVersion: av,
          query,
          busy,
          note,
          pending,
          open,
          installing,
          publishing,
          onQuery: setQuery,
          onClearQuery: () => setQuery(''),
          onPull: () => void pull(),
          onPublish: () => void doPublish(),
          onInstall: (row: PackRow) => void doInstall(row),
          onImport: (rec: InstalledPack) => void doImport(rec),
          // 来源网址可点：只发意图（`ui.openExternal`），壳层调 Rust 原语落地——
          // 面板不持有任何"能不能开"的判定（闸在 Rust，第二份白名单必然漂）
          onOpenSource: (url: string) => deps.bus.emit('ui.openExternal', { url }),
          onRequestUninstall: setPending,
          onConfirmUninstall: (key: string) => void doUninstall(key),
          onCancelUninstall: () => setPending(null),
          onToggleDetail: (key: string) => setOpen(open === key ? null : key),
        });
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
