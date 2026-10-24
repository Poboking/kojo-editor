/**
 * 口上 XML 面板组件（`ui.panel` 槽贡献的渲染面）。
 *
 * 分层：本文件只做「摆 DOM + 发跳转意图」，一条判据都不重算——
 *   - 索引 → 树节点的投影全在 `panel-tree.ts`（纯函数，可单测）；
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

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { KojoXmlService, PluginContext, UIPanelProps } from '@kojo/plugin-api';
import { shortPath } from '@kojo/plugin-api';
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

const h = createElement;

/** 本面板发起的跳转在宿主里的来源标记（诊断 / 导航历史用） */
const REVEAL_SOURCE = 'ui-kojo-xml';

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

    const rows: ReactNode[] = [];
    for (const chara of filtered.charas) {
      // 搜索时全展开：命中项散在各组里，让作者再点开一层才知道有没有命中，等于白筛
      const charaOpen = searching || openCharas.has(chara.id);
      rows.push(
        h(
          'button',
          {
            key: chara.id,
            className: 'nav-hit-btn',
            title: chara.label,
            onClick: () => setOpenCharas(toggleId(openCharas, chara.id)),
          },
          h('span', { className: 'nav-hit-name' }, `${charaOpen ? '▾' : '▸'} ${chara.label}`),
          h('span', { className: 'nav-badge dim' }, `${chara.fileCount} 份 / ${chara.commandCount} 条`),
        ),
      );
      if (!charaOpen) continue;

      for (const file of chara.files) {
        const fileOpen = searching || openFiles.has(file.id);
        rows.push(
          h(
            'button',
            {
              key: file.id,
              className: 'nav-hit-btn',
              style: { paddingLeft: 14 },
              title: file.path,
              onClick: () => setOpenFiles(toggleId(openFiles, file.id)),
            },
            h('span', { className: 'nav-hit-name' }, `${fileOpen ? '▾' : '▸'} ${file.fileName}`),
            h('span', { className: 'nav-badge dim' }, `${file.commands.length}`),
          ),
        );
        if (!fileOpen) continue;

        for (const command of file.commands) {
          const previewing = previewId === command.id;
          rows.push(
            h(
              'div',
              { key: command.id, className: 'nav-hit-row' },
              h(
                'button',
                {
                  className: 'nav-hit-btn',
                  style: { paddingLeft: 28 },
                  // 悬停给台词首段：面板窄，正文只在 title 里露出（不截断数据，只截断显示）
                  title: command.text.slice(0, 200),
                  onClick: () => reveal(command.filePath, command.line, command.column),
                },
                h('span', { className: 'nav-hit-name' }, command.label),
                command.subtitle === ''
                  ? null
                  : h('span', { className: 'nav-hit-loc dim' }, command.subtitle),
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
                  onClick: () => setPreviewId(previewing ? null : command.id),
                },
                previewing ? '收起' : '预览',
              ),
            ),
          );
          if (previewing) {
            rows.push(
              h('div', { key: `${command.id}:preview` }, previewBlock(command, chara.charaNo)),
            );
          }
        }
      }
    }

    const body: ReactNode =
      rows.length > 0
        ? h('div', { className: 'nav-hits' }, ...rows)
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
