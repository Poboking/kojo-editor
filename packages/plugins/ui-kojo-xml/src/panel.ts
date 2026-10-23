/**
 * 口上 XML 面板组件（`ui.panel` 槽贡献的渲染面）。
 *
 * 分层：本文件只做「摆 DOM + 发跳转意图」，一条判据都不重算——
 *   - 索引 → 树节点的投影全在 `panel-tree.ts`（纯函数，可单测）；
 *   - 索引本身来自 `kojo.xml` 服务（**可能缺席**：没有该适配器的工程里这个键根本没人注册），
 *     所以服务用 `tryInject` 取、缺席时走**显式降级**文案（铁律：不许抛错、不许静默空白）；
 *   - 角色名来自 `project.charaIndex`，由 `plugin.ts` 折成 Map 注入（本文件不 inject）。
 *
 * 状态全部住在组件内：搜索词、展开集合、诊断是否展开、是否正在重扫。面板没有跨面板
 * 共享态，因此不需要外部 store（与函数树面板不同：那边要跨宿主通道复用树）。
 */

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { KojoXmlService, PluginContext, UIPanelProps } from '@kojo/plugin-api';
import { shortPath } from '@kojo/plugin-api';
import {
  buildPanelTree,
  diagnosticRows,
  diagnosticSummary,
  filterPanelTree,
  panelStatsLine,
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
        h('div', { className: 'nav-empty dim' }, '口上 XML 索引尚未就绪'),
        h('div', { className: 'nav-status dim' }, '正在扫描，或工程还没加载完成；可点「重新扫描」再试。'),
        note === '' ? null : h('div', { className: 'nav-status dim' }, note),
        refreshButton,
      );
    }

    const searching = query.trim() !== '';
    const diagRows = diagnosticRows(index);

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
          rows.push(
            h(
              'button',
              {
                key: command.id,
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
          );
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
