/**
 * 口上 XML 面板组件（`ui.panel` 槽贡献的渲染面）。
 *
 * 分层：本文件只做「摆 DOM + 发跳转意图」，一条判据都不重算——
 *   - 索引 → 树节点的投影全在 `panel-tree.ts`（纯函数，可单测）；
 *   - 树 + 视图态 → 摊平行与渲染窗口全在 `panel-rows.ts`（纯函数；eraFL 真盘
 *     61,562 条口上、单文件最大 2,445 条，一次挂载的行数由 `NAV_WINDOW` 收口，
 *     搜索时「全展开」的命中语义不动——收口的是 DOM 挂载量，不是命中）；
 *   - 索引本身来自 `kojo.xml` 服务（**可能缺席**：没有该适配器的工程里这个键根本没人注册），
 *     所以服务用 `tryInject` 取、缺席时走**显式降级**文案（铁律：不许抛错、不许静默空白）；
 *   - 角色名来自 `project.charaIndex`，由 `plugin.ts` 折成 Map 注入（本文件不 inject）。
 *
 * 预览（`preview()`）同样只消费服务：条件怎么算、记号怎么替换、哪些记号认不出来，
 * 全是**游戏侧知识**，住在 adapter；本文件只把三份结果摆成 DOM，不认识任何属性名或记号。
 *
 * 状态全部住在组件内：搜索词、展开集合、诊断是否展开、是否正在重扫、预览语境。
 * 面板没有跨面板共享态，因此不需要外部 store（与函数树面板不同：那边要跨宿主通道复用树）。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { KojoXmlService, PluginContext, UIPanelProps } from '@kojo/plugin-api';
import {
  attachGrowSentinel,
  growWindow,
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  moreRowLabel,
  shortPath,
} from '@kojo/plugin-api';
import {
  buildPanelTree,
  conditionLabel,
  diagnosticRows,
  diagnosticSummary,
  filterPanelTree,
  panelStatsLine,
  type PanelCommandNode,
  type PanelTree,
} from './panel-tree';
import {
  flattenPanelRows,
  navWindowSize,
  NAV_WINDOW,
  type PanelRow,
} from './panel-rows';

const h = createElement;

/** 本面板发起的跳转在宿主里的来源标记（诊断 / 导航历史用） */
const REVEAL_SOURCE = 'ui-kojo-xml';

/**
 * 「显示更多」哨兵（触底增窗）。
 *
 * 逐字照 `ui-convention-report` 的同名件：观察器行为核住在契约层
 * `attachGrowSentinel`（进入滚动视口即追加下一窗；观察器不可用时返回空退订
 * ⇒ 退化为纯点击按钮，功能不丢）；外观三件套与其余面板同源同值，
 * className 仍是本面板自己的 `nav-more-btn`。回调只在**触发时**经 `onMoreRef`
 * 取最新值（observer 只挂一次，捕获旧闭包 = 窗口行为静默改变）。
 */
function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactNode {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return h(
    'button',
    {
      ref: setAnchor,
      className: 'ghost small dim nav-more-btn',
      style: MORE_ROW_STYLE,
      title: MORE_ROW_TITLE,
      onClick: () => onMore(),
    },
    moreRowLabel(remaining),
  );
}

/**
 * 命中列表（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界，
 * 判据文件：`packages/app/tests/panel-window-kojo-xml.test.ts`）。
 *
 * 本组件只做「窗口内那几行摆成 DOM」：摊平顺序、折叠语义、窗口数学全在
 * `panel-rows.ts` 的纯函数里；一行的 className / key / 悬停文案与窗口化之前逐字相同。
 */
export interface NavHitsListProps {
  /** 摊平后的全量行（未开窗） */
  readonly rows: readonly PanelRow[];
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 「点名跳转的那一行必须落在窗口内」的覆盖位点（1 基行号；0 / 缺省 = 无） */
  readonly mustInclude?: number;
  readonly onToggleChara: (id: string) => void;
  readonly onToggleFile: (id: string) => void;
  /** 点击条目 = 跳转意图（宿主消费） */
  readonly onReveal: (filePath: string, line: number, column: number) => void;
  /** 当前展开预览的条目 id（null = 没有）——决定命令行右侧按钮写「预览」还是「收起」 */
  readonly previewId: string | null;
  readonly onPreviewToggle: (commandId: string) => void;
  /** 预览行的内容（台词 / 条件 / 语境输入框住在渲染闭包里，这里只收一个节点） */
  readonly renderPreview: (row: Extract<PanelRow, { kind: 'preview' }>) => ReactNode;
  /** 触底 / 点击「显示更多」→ 扩窗（新值由 nextNavWindow 计算） */
  readonly onGrow: (total: number) => void;
}

export function NavHitsList(props: NavHitsListProps): ReactNode {
  const { rows } = props;
  const win = navWindowSize(rows.length, props.limit, props.mustInclude ?? 0);
  const visible: ReactNode[] = [];
  for (const row of rows.slice(0, win)) {
    if (row.kind === 'chara') {
      visible.push(
        h(
          'button',
          {
            key: row.key,
            className: 'nav-hit-btn',
            title: row.chara.label,
            onClick: () => props.onToggleChara(row.chara.id),
          },
          h('span', { className: 'nav-hit-name' }, `${row.open ? '▾' : '▸'} ${row.chara.label}`),
          h('span', { className: 'nav-badge dim' }, `${row.chara.fileCount} 份 / ${row.chara.commandCount} 条`),
        ),
      );
      continue;
    }
    if (row.kind === 'file') {
      visible.push(
        h(
          'button',
          {
            key: row.key,
            className: 'nav-hit-btn',
            style: { paddingLeft: 14 },
            title: row.file.path,
            onClick: () => props.onToggleFile(row.file.id),
          },
          h('span', { className: 'nav-hit-name' }, `${row.open ? '▾' : '▸'} ${row.file.fileName}`),
          h('span', { className: 'nav-badge dim' }, `${row.file.commands.length}`),
        ),
      );
      continue;
    }
    if (row.kind === 'command') {
      const previewing = props.previewId === row.command.id;
      visible.push(
        h(
          'div',
          { key: row.key, className: 'nav-hit-row' },
          h(
            'button',
            {
              className: 'nav-hit-btn',
              style: { paddingLeft: 28 },
              // 悬停给台词首段：面板窄，正文只在 title 里露出（不截断数据，只截断显示）
              title: row.command.text.slice(0, 200),
              onClick: () => props.onReveal(row.command.filePath, row.command.line, row.command.column),
            },
            h('span', { className: 'nav-hit-name' }, row.command.label),
            row.command.subtitle === ''
              ? null
              : h('span', { className: 'nav-hit-loc dim' }, row.command.subtitle),
          ),
          // 行内两个按钮而不是嵌套按钮：`<button>` 里塞 `<button>` 是非法结构，
          // 浏览器会把它拆成兄弟节点，点「预览」时反而触发跳转。
          // 不复用 `.nav-hit-btn`：那个类带 `width:100%` + 弹性伸缩，挂上来会把
          // 跳转按钮挤没（同一行两个 `flex:1` 谁也不让谁）。
          h(
            'button',
            {
              className: 'nav-preview-btn',
              title: previewing ? '收起预览' : '预览台词与命中条件',
              onClick: () => props.onPreviewToggle(row.command.id),
            },
            previewing ? '收起' : '预览',
          ),
        ),
      );
      continue;
    }
    visible.push(h('div', { key: row.key }, props.renderPreview(row)));
  }
  if (win < rows.length) {
    visible.push(
      h(MoreRow, { key: 'nav-more', remaining: rows.length - win, onMore: () => props.onGrow(rows.length) }),
    );
  }
  return h('div', { className: 'nav-hits' }, ...visible);
}

/** 面板依赖（全部由 `plugin.ts` 的 `activate()` 注入） */
export interface KojoXmlPanelDeps {
  readonly ctx: PluginContext;
  /** 口上 XML 服务；`undefined` = 本工程没有提供该服务的适配器 */
  readonly service: KojoXmlService | undefined;
  /** 角色号 → 显示名（来自 `project.charaIndex`；取不到时面板回退显示编号） */
  readonly charaNames: () => ReadonlyMap<number, string>;
}

function toggleId(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function createKojoXmlPanel(deps: KojoXmlPanelDeps): (props: UIPanelProps) => unknown {
  const { ctx, service, charaNames } = deps;

  function KojoXmlPanel(props: UIPanelProps): unknown {
    const [, force] = useState(0);
    const [query, setQuery] = useState('');
    const [openCharas, setOpenCharas] = useState<ReadonlySet<string>>(() => new Set());
    const [openFiles, setOpenFiles] = useState<ReadonlySet<string>>(() => new Set());
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    /** 当前展开预览的条目 id（同一时刻只开一条：面板窄，开两条就得来回滚） */
    const [previewId, setPreviewId] = useState<string | null>(null);
    /** 预览语境：运行期才确定、编辑器无从得知的两个名字（空 = 不填，记号进未解析） */
    const [playerName, setPlayerName] = useState('');
    const [callName, setCallName] = useState('');
    /**
     * 命中列表的渲染窗口行数（undefined = 初始窗口 `NAV_WINDOW.initial`）。
     * 只在「显示更多」/触底时按步长增长；树换小而残窗无碍——窗口对 total 取 min。
     */
    const [windowLimit, setWindowLimit] = useState<number | undefined>(undefined);

    // 扫完 / 刷新由服务通知：面板不轮询，也不自己猜"什么时候该重读"
    useEffect(() => {
      if (!service) return;
      return service.subscribe(() => force((n) => n + 1));
    }, []);

    /** 索引实例每帧取一次（服务在项目关闭后返回 null，这里不缓存旧项目残留） */
    const index = service ? service.index() : null;
    const tree = useMemo<PanelTree | null>(
      () => (index ? buildPanelTree(index, charaNames()) : null),
      // charaNames 每次调用都造新 Map，故只按索引实例记忆：角色表随工程变，索引随之重建
      [index],
    );
    const filtered = useMemo<PanelTree | null>(
      () => (tree ? filterPanelTree(tree, query) : null),
      [tree, query],
    );

    /**
     * 摊平行（纯投影，先于降级分支计算——hook 顺序不许挂在条件分支后面）。
     * 全量行只是轻描述符；被窗口收口的是**摆成 DOM 的那一截**（见 `NavHitsList`）。
     */
    const allRows = useMemo<PanelRow[]>(
      () =>
        flattenPanelRows(filtered, {
          searching: query.trim() !== '',
          openCharas,
          openFiles,
          previewId,
        }),
      [filtered, query, openCharas, openFiles, previewId],
    );

    const reveal = (filePath: string, line: number, column: number): void => {
      ctx.bus.emit('editor.revealLocation', { filePath, line, column, source: REVEAL_SOURCE });
    };

    const refresh = (): void => {
      if (!service || busy) return;
      setBusy(true);
      setNote('');
      void service.refresh().then(
        () => {
          setBusy(false);
          force((n) => n + 1);
        },
        (err: unknown) => {
          // 失败必须可见：按钮点完没反应，作者会以为索引是空的
          setBusy(false);
          setNote(`重新扫描失败：${String(err)}`);
          ctx.log.warn(`口上 XML 重新扫描失败：${String(err)}`);
        },
      );
    };

    const refreshButton = h(
      'button',
      { className: 'small', disabled: busy, onClick: refresh, title: '重新扫描口上 XML' },
      (props.renderIcon?.('refresh', 12) as ReactNode | undefined) ?? '⟳',
      busy ? ' 扫描中…' : ' 重新扫描',
    );

    // ---- 降级 1：本工程没有该服务（例：口上不是 XML 形态的工程） ----
    if (!service) {
      return h(
        'div',
        { className: 'panel-kojo-nav panel-kojo-xml' },
        h('div', { className: 'nav-empty dim' }, '当前工程没有口上 XML'),
        h(
          'div',
          { className: 'nav-status dim' },
          '本工程的适配器没有提供口上 XML 索引，因此没有可浏览的条目。',
        ),
      );
    }

    // ---- 降级 2：服务在、索引还没扫完（契约：未扫完返回 null，不给空索引） ----
    if (!index || !tree || !filtered) {
      return h(
        'div',
        { className: 'panel-kojo-nav panel-kojo-xml' },
        h('div', { className: 'nav-empty dim' }, '正在建立口上 XML 索引…'),
        h('div', { className: 'nav-status dim' }, '首次打开或刚重载项目时要扫描几秒；若长时间没有条目，点「重新扫描」。'),
        note === '' ? null : h('div', { className: 'nav-status dim' }, note),
        refreshButton,
      );
    }

    const searching = query.trim() !== '';
    const diagRows = diagnosticRows(index);

    /** 空串 → `undefined`：契约里"没填"和"填了个空名字"必须分得开（后者会把记号替成空） */
    const orUndefined = (value: string): string | undefined => {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    };

    /**
     * 一条条目的预览块：命中条件 / 台词（已替换）/ 未解析记号 + 两个语境输入框。
     *
     * 角色名**现取**（`charaNames()` 每次给新 Map）：换工程后索引与角色表一起换，缓存住
     * 就会把上一个工程的名字填进预览。主人公名与称呼编辑器无从得知，只能由作者填；
     * 不填就照契约进 `unresolved`——**绝不编造一个名字顶上**（编了比空着更难发现）。
     */
    const previewBlock = (command: PanelCommandNode, charaNo: number | null): ReactNode => {
      const result = service.preview(command.source, {
        playerName: orUndefined(playerName),
        callName: orUndefined(callName),
        charaName: charaNo === null ? undefined : charaNames().get(charaNo),
      });

      const lines: ReactNode[] = result.lines.map((line, i) =>
        // 空行用不换行空格占位：否则连续空行在 DOM 里塌成 0 高，作者会以为丢了一段
        h('div', { key: i, className: 'nav-preview-line' }, line === '' ? '\u00a0' : line),
      );

      return h(
        'div',
        { className: 'nav-preview' },
        h(
          'div',
          { className: 'nav-preview-ctx' },
          h('input', {
            className: 'nav-search',
            type: 'text',
            placeholder: '主人公名',
            title: '预览用：替换正文里的主人公名记号；留空则该记号原样保留并计入未解析',
            value: playerName,
            onChange: (e: { target: { value: string } }) => setPlayerName(e.target.value),
          }),
          h('input', {
            className: 'nav-search',
            type: 'text',
            placeholder: '称呼',
            title: '预览用：该角色对主人公的称呼；留空则该记号原样保留并计入未解析',
            value: callName,
            onChange: (e: { target: { value: string } }) => setCallName(e.target.value),
          }),
        ),
        h(
          'div',
          { className: 'nav-preview-conds' },
          h('span', { className: 'nav-status dim' }, '命中条件：'),
          result.conditions.length === 0
            ? h('span', { className: 'nav-status dim' }, '无（恒命中）')
            : result.conditions.map((condition, i) =>
                h(
                  'span',
                  {
                    key: `${condition.source}:${condition.kind}:${condition.expression}:${i}`,
                    className: 'nav-badge cond',
                    title: condition.kind === 'expr' ? '表达式条件（原样交给回放/解释器）' : '取值匹配',
                  },
                  conditionLabel(condition),
                ),
              ),
        ),
        lines.length === 0
          ? h('div', { className: 'nav-status dim' }, '（这条没有台词）')
          : h('div', { className: 'nav-preview-lines' }, ...lines),
        result.unresolved.length === 0
          ? null
          : h(
              'div',
              { className: 'nav-preview-miss' },
              h(
                'span',
                { className: 'nav-status dim' },
                `未解析 ${result.unresolved.length} 个记号（正文里原样保留）：`,
              ),
              ...result.unresolved.map((token) =>
                h('span', { key: token, className: 'nav-badge dim', title: token }, token),
              ),
            ),
      );
    };

    // 行内容交给模块级 `NavHitsList`：它按 `NAV_WINDOW` 只摆窗口内的行 + 哨兵，
    // 摊平顺序与折叠语义（含搜索时全展开）都在 `flattenPanelRows` 里逐字保持。
    const body: ReactNode =
      allRows.length > 0
        ? h(NavHitsList, {
            rows: allRows,
            limit: windowLimit,
            previewId,
            onToggleChara: (id: string) => setOpenCharas(toggleId(openCharas, id)),
            onToggleFile: (id: string) => setOpenFiles(toggleId(openFiles, id)),
            onReveal: reveal,
            onPreviewToggle: (id: string) => setPreviewId((prev) => (prev === id ? null : id)),
            renderPreview: (row) => previewBlock(row.command, row.chara.charaNo),
            onGrow: (total: number) => setWindowLimit((prev) => growWindow(prev, total, NAV_WINDOW)),
          })
        : h(
            'div',
            { className: 'nav-empty dim' },
            searching ? '没有匹配的口上条目' : '这份索引里还没有口上条目',
          );

    const diagnosticsBar = h(
      'div',
      null,
      h(
        'button',
        {
          className: 'nav-hit-btn',
          onClick: () => setShowDiagnostics((open) => !open),
          title: '展开诊断（前 50 条）',
        },
        h('span', { className: 'nav-status' }, `${showDiagnostics ? '▾' : '▸'} ${diagnosticSummary(tree)}`),
      ),
      showDiagnostics && diagRows.length > 0
        ? h(
            'ul',
            { className: 'nav-hit-list' },
            ...diagRows.map((row) =>
              h(
                'li',
                { key: row.id },
                h(
                  'button',
                  {
                    className: 'nav-hit-btn',
                    title: `${row.code}（点击跳转）`,
                    onClick: () => reveal(row.path, row.line, row.column),
                  },
                  h('span', { className: `nav-badge ${row.severity}` }, row.severity),
                  h('span', { className: 'nav-hit-name' }, `${shortPath(row.path)}:${row.line}`),
                  h('span', { className: 'nav-hit-loc dim' }, row.message),
                ),
              ),
            ),
          )
        : null,
    );

    return h(
      'div',
      { className: 'panel-kojo-nav panel-kojo-xml' },
      h('div', { className: 'nav-toolbar' }, h('span', { className: 'nav-status' }, panelStatsLine(tree)), refreshButton),
      h('input', {
        className: 'nav-search',
        type: 'search',
        placeholder: '搜索角色 / 命令 / 台词',
        value: query,
        onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
      }),
      note === '' ? null : h('div', { className: 'nav-status dim' }, note),
      body,
      diagnosticsBar,
    );
  }

  return KojoXmlPanel;
}
