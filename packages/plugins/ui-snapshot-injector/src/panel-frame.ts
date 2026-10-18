/**
 * 注入面板的**外框**：顶部工具条（档位下拉）与四个非就绪阶段的整屏提示
 * （从 `index.ts` 的面板组件里原样迁出，DOM 结构、className 与文案逐字不变）。
 *
 * 阶段判定仍用 `panel-logic` 的纯函数 `panelPhase`（顺序即优先级）；
 * ready 时回 null，由面板继续渲染主体。
 */

import { createElement, type ReactNode } from 'react';
import type { SnapshotArchiveEntry } from '@kojo/plugin-api';
import { panelPhase, type EmptySlotsReason } from './panel-logic';

export interface ToolbarProps {
  /** 当前选中的档位路径；未选 = null */
  readonly path: string | null;
  /** 可解析档位（浅解析结果里 meta 有效且无 error 的条目；过滤语义在面板层） */
  readonly rows: readonly SnapshotArchiveEntry[];
  readonly setPath: (path: string | null) => void;
  /** 扫描是否在飞（按钮置灰 + 文案切换；引擎 inFlight 去重，连点不会并发） */
  readonly scanning?: boolean;
  /** 重新扫描（存档目录换了 / 新存了档 / 面板早于项目挂载时的兜底） */
  readonly onRescan?: () => void;
}

/** 顶部工具条（说明行 + 档位下拉 + 重新扫描） */
export function renderToolbar(props: ToolbarProps): ReactNode {
  const { path, rows, setPath, scanning = false, onRescan } = props;
  const sel = createElement('select', {
    className: 'inj-select',
    value: path ?? '',
    onChange: (e: { target: { value: string } }) => {
      setPath(e.target.value || null);
    },
  },
    createElement('option', { key: '', value: '' }, '选择档位…'),
    ...rows.map((e) =>
      createElement('option', { key: e.path, value: e.path },
        `${e.fileName} — ${e.meta?.saveMes || `${e.meta?.charCount ?? '?'} 角色`}`),
    ),
  );

  /**
   * 「重新扫描」是**可用性缺口**不是锦上添花：扫描只发生在 `project.opened`，
   * 换存档目录、新存一档、或面板早于扫描挂载时，此前**没有任何手动入口**
   * （只有切走面板再切回来才重挂载）。缺省不传回调时不渲染（测试与旧宿主零改动）。
   */
  const rescan = onRescan
    ? createElement('button', {
        className: 'inj-rescan',
        type: 'button',
        disabled: scanning,
        title: '重新扫描当前项目的存档目录',
        onClick: () => onRescan(),
      }, scanning ? '扫描中…' : '重新扫描')
    : null;

  return createElement('div', { className: 'inj-toolbar' },
    createElement('span', { className: 'dim' }, '改写存档变量（写前自动备份 · 写后校验）'),
    sel,
    rescan,
  );
}

export interface PhaseBoxProps {
  /** 已渲染的工具条（四个阶段都带它，便于换档） */
  readonly head: ReactNode;
  readonly hasSlots: boolean;
  readonly path: string | null;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly hasArchive: boolean;
  /** 'no-slots' 的真实成因（细分文案；缺省按旧口径） */
  readonly emptyReason?: EmptySlotsReason;
  /** 重新扫描回调（挂在空态提示里，让用户不必去找工具条） */
  readonly onRescan?: () => void;
}

/** 空态文案：每种成因给出**下一步动作**，不写"请检查配置"这种空话 */
const EMPTY_TEXT: Readonly<Record<EmptySlotsReason, string>> = {
  'no-project': '还没有打开项目。存档目录来自当前项目——先打开一个游戏项目。',
  'no-dir': '当前项目没有配置存档目录。在项目设置里指定游戏存档目录后点「重新扫描」。',
  scanning: '正在扫描存档目录…',
  'no-archives': '已扫描存档目录，没有找到可解析的存档文件。新存一档后点「重新扫描」。',
  'all-unreadable': '找到了存档文件，但没有一个能解析——原因见日志（可能是别的游戏的存档，或文件损坏）。',
};

/** 非就绪阶段（无档位 / 未选档 / 读取中 / 读取失败）的整屏提示；ready ⇒ null */
export function renderPhaseBox(props: PhaseBoxProps): ReactNode {
  const { head, path, loading, loadError, onRescan } = props;
  const reason = props.emptyReason ?? 'no-archives';
  switch (panelPhase({
    hasSlots: props.hasSlots,
    path,
    loading,
    loadError,
    hasArchive: props.hasArchive,
  })) {
    case 'no-slots':
      return createElement('div', { className: 'panel-snapshot-injector' }, head,
        createElement('div', { className: 'inj-empty dim' }, EMPTY_TEXT[reason]),
        onRescan && (reason === 'no-dir' || reason === 'no-archives' || reason === 'all-unreadable')
          ? createElement('button', {
              className: 'inj-rescan',
              type: 'button',
              onClick: () => onRescan(),
            }, '重新扫描')
          : null);
    case 'no-selection':
      return createElement('div', { className: 'panel-snapshot-injector' }, head,
        createElement('div', { className: 'inj-empty dim' }, '请从上方选择要改写的存档'));
    case 'loading':
      return createElement('div', { className: 'panel-snapshot-injector' }, head,
        createElement('div', { className: 'inj-empty dim' }, '正在读取存档…'));
    case 'error':
      return createElement('div', { className: 'panel-snapshot-injector' }, head,
        createElement('div', { className: 'inj-error' }, `读取存档失败：${loadError ?? '未知原因'}`));
    case 'ready':
      return null;
  }
}
