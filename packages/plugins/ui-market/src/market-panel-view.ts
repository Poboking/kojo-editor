/**
 * 面板的**渲染树**（`ui-market` 呈现层，从 `index.ts` 迁出）：零状态、零 IO——
 * 给一份事实与几个回调就画得出来。带状态的组件在 node 环境里跑不了 effect（拿不到数据），
 * 也就点不动；分家之后"这一行到底给不给按钮"可以被静态渲染直接检。
 *
 * DOM 契约（`.panel-market` / `.mk-*` 类名与层级）与文案纪律原样在这一层的文件头里。
 */

import { createElement, type ReactNode } from 'react';
import { type InstalledPack, type UIPanelProps } from '@kojo/plugin-api';
import type { MarketSnapshot } from './actions';
import {
  ACTION_LABEL,
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_DETAIL,
  CAPABILITY_HINT,
  CLEAR_LABEL,
  dataTimeLine,
  dataTimeSummary,
  droppedNotice,
  filterEmptyPhrase,
  formatBytes,
  groupCountPhrase,
  IMPORT_LABEL,
  indexRowKey,
  installedCountPhrase,
  pendingKey,
  PUBLISH_LABEL,
  statusText,
  updatePhrase,
  type PackRow,
} from './market-view';
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
  /**
   * 图标桥（宿主 PanelHost 注入，契约见 `UIPanelProps.renderIcon`）：折叠件那一枚
   * `chevron-right` 经它渲染成注册表 SVG——**字符不当图标用**（批次十一 L07）。
   * 可选：无渲染环境（纯函数单测）下不画记号，视觉由 `.mk-hint-toggle:empty` 的 CSS 画出件兜底。
   */
  readonly renderIcon?: UIPanelProps['renderIcon'];
  /** 装配层注入的当前应用版本（面板源码不写版本号） */
  readonly appVersion: string;
  readonly query: string;
  /** 读列表进行中（首帧即 true ⇒ 状态行还不画，但数据时间行照旧常驻） */
  readonly busy: boolean;
  /** 内联状态行那一句：装 / 卸的进行中、结果与拒因全写在这一处，不弹窗 */
  readonly note: string;
  /**
   * 当前进度读数（0–100 的整数；null/undefined = 此刻没有可画的进度）。
   * **带字的进度句仍只住 `.mk-note` 一处**（同一件事不在两处显示的纪律不动），
   * 这根 hairline 是无文字的视觉读数，`aria-valuenow` 给读屏。
   */
  readonly progress?: number | null;
  /** 待确认卸载的那一条（同一时刻只允许一条） */
  readonly pending: string | null;
  /** 展开的已装条目（机器面） */
  readonly open: string | null;
  /**
   * 正在进行装/更新的那一行；非空 ⇒ 所有动作按钮禁用（同一时刻只搬一次）。
   * 禁用**只改 `disabled`，不改按钮文字**：进度那一句只住 `.mk-note` 一处。
   */
  readonly installing: string | null;
  onQuery(q: string): void;
  /** 清空过滤（工具条上那枚「清除」；过滤态下它是空态那句话的唯一出路，不另设弹窗） */
  onClearQuery(): void;
  onPull(): void;
  /** 工具条「发布口上…」：只发意图，打开发布口上引导（向导住拥有口上项目模型的适配器） */
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
 * 一版面的 DOM 契约（样式由 app 侧 `market.css` 整域实现，本层只负责产出这些类名与层级）：
 *
 * ```text
 * .panel-market                 根：列布局，外层不滚
 * ├─ .mk-toolbar                flex:none —— 搜索组（.mk-search-wrap：输入 + 清除）/ 动作组（.mk-toolbar-actions：拉取 + 发布口上）
 * ├─ .mk-flash                  状态簇（role=status）：.mk-status .mk-time(短读数, title=全量) .mk-note(aria-live)
 * │                                        .mk-progress(无文字进度) .mk-warn details.mk-hint(> summary[ span.mk-hint-toggle + 一行 ] + .mk-hint-more)
 * └─ .mk-body                   flex:1 自滚 —— 只有列表随滚动移动
 *     ├─ .mk-grouptitle + span.mk-count → .mk-list → .mk-row × n（已装）
 *     └─ section.mk-group → h4.mk-grouptitle + span.mk-count → .mk-row(或 .mk-row.busy + aria-busy) × n（索引）
 *         .mk-row > .mk-main > .mk-head[ span.mk-name | span.mk-badge? | div.mk-actions ]
 *                            + .mk-sub（摘要，可缺省）
 *                            + .mk-facts[ span.mk-meta × n，title=整行全文 ]
 *                  ＋ 行级附属：.mk-warn（版本要求）/ button.mk-sub.mk-link（来源，可点）/ .mk-detail（展开层）
 * ```
 *
 * 四条结构性口径：
 * 1. **层级三档，不是一排挤到底**——第一排只有名字、徽章与动作（动作钉右端），
 *    第二排摘要（标题之下、元信息之上），第三排才是合并成一行的次要事实（`title` 给全文）；
 *    把动作丢进同一个 wrap 容器末尾会让名字吃掉剩余宽度、把动作挤到第三排（窄侧栏密度事故）；
 * 2. **状态与列表分家**——工具条、状态、数据时间、说明住在滚动区之外，
 *    列表长到几十条时作者仍然看得见"这是哪一刻的数据"；
 * 3. **按钮 children 永远是纯字符串**（图标一律不上按钮）：动作判据按标签找按钮、并把 `onClick` 真的调一次；
 *    非按钮位子上要放记号（如折叠件的尖角），走宿主图标桥 `renderIcon(名字, 档位)` 取注册表 SVG——
 *    **字符不当图标用**（批次十一 L07），本层源码里一个图标字符都不许出现；
 * 4. **类名是跨包契约**——本层只产出这些类名与层级，一切视觉（颜色 / 圆角 / 滚动 / 焦点环）住 app 侧 `market.css`。
 */
export function MarketPanelView(p: MarketPanelViewProps): ReactNode {
  const { snapshot } = p;
  // 已装清单**原样**交给视图层：三态由契约的 `packUpdateCheck` 从这份清单算。
  // 这一层再拼一份"已装键集"就是第二份真相（`buildGroups` 的签名拦的就是这个）。
  const groups = buildGroups(snapshot.packs, p.appVersion, p.query, snapshot.installed);
  const rows = buildInstalledRows(snapshot.installed);
  const line = statusText(snapshot.status, snapshot.reason);
  // 屏上只留一行短读数（上次同步到分）；全量数据时间 + 注册表生成时刻 + 来源 URL 进 title
  const time = dataTimeLine(snapshot);
  const timeShort = dataTimeSummary(snapshot);
  const droppedLine = droppedNotice(snapshot.dropped);
  // 过滤态：能力面说明讲的是"这面板能干什么"，与作者此刻正在找的这几条无关 ⇒ 让位不占行；
  // 空态 / 错误态那几句照给——它们说的正是这一屏此刻的事实。
  const filtering = p.query !== '';
  // 占用读数取服务 `installedBytes()`（契约里那条唯一口径），面板不自己把 files 加一遍
  const installedCount = installedCountPhrase(rows.length, snapshot.installedBytes);
  // 同一屏动作纪律：装/更新进行中 ⇒ 全部动作按钮禁用（同一时刻只做一件事）；
  // 进度仍只写 `.mk-note` 一处，按钮文字不变。发布入口只发意图、不占互斥的"忙"位：
  // 向导由消费方开门，本面板此刻没有进行中的发布状态可画。
  const acting = p.installing !== null;

  /**
   * 徽章的语义色档：`updatable` = 有新版可拿（amber，"有事可做"）；`latest` = 已装妥
   * （green，"无事"）；`ahead` / 比较失败 = 中性灰（不该催任何动作）。带字那句仍由
   * `updatePhrase` 单源给出——这里只决定同一句读起来是喜是警，不写第二份话术。
   */
  const badgeTone = (row: PackRow): string => {
    const s = row.update?.state;
    return s === 'updatable' ? ' mk-badge-warn' : s === 'latest' ? ' mk-badge-ok' : '';
  };

  /**
   * 动作按钮的统一形状：`ghost small` + 进行中禁用；**文字永远不变**（进度只住 `.mk-note` 一处）。
   * `cls` 多给一枚视觉档：索引行的装/更新带 `mk-install`——「可安装 / 已安装 / 进行中」
   * 三态由 app 侧 `market.css` 分档，本层不多写一个字。
   */
  const btn = (label: string, onClick: () => void, disabled: boolean, cls = 'ghost small'): ReactNode =>
    createElement('button', { className: cls, disabled, onClick }, label);
  /** 这一行的全部动作都住这里（名字那一排的右端；`.mk-main` 里不再有裸按钮） */
  const actions = (...buttons: ReactNode[]): ReactNode =>
    createElement('div', { className: 'mk-actions' }, ...buttons);
  /**
   * 卡片体的层级：第一排 = 名字 + 徽章 + 动作（动作钉右端）；第二排 = 摘要（可缺省）；
   * 第三排 = 次要事实合并成一行（`title` 给整行全文，窄侧栏溢出走省略号，不再逐条各占一行）。
   * 分排而不是把动作丢在同一个 wrap 容器末尾：后者会让"名字吃掉剩余宽度"把动作簇
   * 挤到第三排，一张卡从两行变四行——窄侧栏里这就是密度事故。
   */
  const main = (
    name: string,
    badge: ReactNode,
    acts: ReactNode,
    summary: string | null,
    facts: string[],
  ): ReactNode =>
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
      summary === null || summary === '' ? null : createElement('div', { className: 'mk-sub' }, summary),
      createElement(
        'div',
        { className: 'mk-facts', title: facts.join(' · ') },
        ...facts.map((text) => createElement('span', { className: 'mk-meta', key: text }, text)),
      ),
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
        const key = indexRowKey(e);
        // 正在进行的是这一行 ⇒ 行级 busy 记号。安装按钮的三态到这就齐了：
        // 可安装 = `mk-install`（可点）；已安装 = `mk-badge-ok` 那枚胶囊（不给按钮）；
        // 进行中/检查中 = `.mk-row.busy` + 禁用动作簇。按钮文字照旧一个字都不变。
        const busy = p.installing === key;
        return createElement(
          'div',
          {
            // 行视觉态（busy）与行数据面（右键）各管各的，同一 div 上共存：
            // 市场的右键由**宿主面路由**接管（`data-context-surface="market"`），
            // 面的 build 是纯 DOM 入口，靠下面两个属性回查「刚点的是哪一行」——
            // 与文件树 `data-tree-kind` / `data-tree-path` 同一套做法。
            className: busy ? 'mk-row busy' : 'mk-row',
            'aria-busy': busy ? true : undefined,
            key,
            'data-market-row': 'index',
            'data-market-key': key,
          },
          main(
            e.name,
            phrase === '' ? null : createElement('span', { className: `mk-badge${badgeTone(row)}` }, phrase),
            // `action === 'none'` ⇒ 这一行没有可点动作（已装最新 / 本机更高 / 版本要求不够），
            // 行上那句 `mk-badge` 或 `mk-warn` 就是它的说明（动作簇仍占右端位，行与行不错位）
            actions(
              row.action === 'none'
                ? null
                : btn(ACTION_LABEL[row.action], () => p.onInstall(row), acting, 'ghost small mk-install'),
            ),
            e.summary ?? null,
            [
              `版本 ${e.version}`,
              `${formatBytes(e.unpackedBytes)} · ${e.fileCount} 个文件`,
              `作者 ${e.author}`,
              `许可 ${e.license}`,
            ],
          ),
          row.appOk
            ? null
            : createElement('div', { className: 'mk-warn' }, appVersionRequirement(e.minAppVersion)),
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
    {
      className: 'panel-market',
      // 市场的右键面（`CONTEXT_SURFACE_MANIFEST` 的 'market'）：面的 build 由插件模块顶层声明，
      // 宿主路由按这个属性把右键交给它（行级靠 `data-market-row` / `data-market-key`）。
      'data-context-surface': 'market',
    },
    createElement(
      'div',
      { className: 'mk-toolbar' },
      // 搜索组：输入吃掉剩余宽度（窄侧栏里动作组整体折到下一行，而不是把搜索框压成一条缝）
      createElement(
        'div',
        { className: 'mk-search-wrap' },
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
      ),
      // 动作组：拉取 + 发布口上。窄宽度下整组换行仍靠右（不与搜索框抢宽度）
      createElement(
        'div',
        { className: 'mk-toolbar-actions' },
        createElement(
          'button',
          { className: 'ghost small', disabled: p.busy || acting, onClick: () => p.onPull() },
          p.busy ? '拉取中…' : '拉取列表',
        ),
        // 发布口上…：只发意图（`market.publishRequested`），向导住拥有口上项目模型的适配器；
        // 本面板不选文件、不持发布状态，结果也由向导呈现
        createElement(
          'button',
          { className: 'ghost small mk-publish', disabled: p.busy || acting, onClick: () => p.onPublish() },
          PUBLISH_LABEL,
        ),
      ),
    ),
    // 状态簇在滚动区之外：列表再长，"这一次到底拉没拉成"也不会被滚出视野
    createElement(
      'div',
      { className: 'mk-flash', role: 'status' },
      line === '' || p.busy ? null : createElement('div', { className: 'mk-status' }, line),
      // 数据时间与拉取结果**不受 busy 遮掩**：失败态必须一直在屏上（不许"加载中"常驻顶掉它）。
      // 屏上只给一行「上次同步」短读数，全量数据时间（含注册表生成时刻与来源 URL）退进 title——
      // URL 不是界面文案（批次十一 L07）
      time === '' ? null : createElement('div', { className: 'mk-time', title: time }, timeShort),
      // 装 / 卸的进行中与结果全写在这一处（`aria-live` 让读屏跟得上；不弹窗）
      p.note === '' ? null : createElement('div', { className: 'mk-note', 'aria-live': 'polite' }, p.note),
      // 无文字的 hairline 进度条：带字的进度句仍只住 `.mk-note` 一处，这里只给"还剩多少"的形
      p.progress == null
        ? null
        : createElement(
            'div',
            {
              className: 'mk-progress',
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(p.progress),
            },
            createElement('div', {
              className: 'mk-progress-fill',
              style: { width: `${Math.min(100, Math.max(0, p.progress))}%` },
            }),
          ),
      // 被剔除条目的说明：只在这里出声（红色留给"注册表那边的问题"）
      droppedLine === '' ? null : createElement('div', { className: 'mk-warn' }, droppedLine),
      // 能力面说明：常驻只有一行，长文折进 `<details>`（作者点开才看全；批次十一 L07 拆行长文墙）
      filtering
        ? null
        : createElement(
            'details',
            { className: 'mk-hint' },
            // 折叠记号 = 注册表 SVG（`chevron-right` 的 xs 档），不是字符（批次十一 L07）。
            // 图标桥缺省（无渲染环境）时这里画成空 span，由 `.mk-hint-toggle:empty` 的 CSS 记号兜底——
            // 既不留空白，也不把字符当图标用。
            createElement(
              'summary',
              null,
              createElement(
                'span',
                { className: 'mk-hint-toggle', 'aria-hidden': true },
                (p.renderIcon?.('chevron-right', 'xs') as ReactNode | undefined) ?? null,
              ),
              CAPABILITY_HINT,
            ),
            createElement('div', { className: 'mk-hint-more' }, CAPABILITY_DETAIL),
          ),
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
                {
                  className: expanded ? 'mk-row open' : 'mk-row',
                  key,
                  // 行数据面（同索引行）：右键盘路由从这里读回行身份
                  'data-market-row': 'installed',
                  'data-market-key': key,
                },
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
                  null,
                  [
                    `版本 ${r.rec.version}`,
                    r.kindLabel,
                    `来源 ${r.sourceLabel}`,
                    `作者 ${r.rec.author}`,
                    `许可 ${r.rec.license}`,
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
