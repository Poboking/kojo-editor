/**
 * 注入面板的**外框**：顶部工具条（档位下拉）与四个非就绪阶段的整屏提示
 * （从 `index.ts` 的面板组件里原样迁出，DOM 结构、className 与文案逐字不变）。
 *
 * 阶段判定仍用 `panel-logic` 的纯函数 `panelPhase`（顺序即优先级）；
 * ready 时回 null，由面板继续渲染主体。
 */

import { createElement, type ReactNode } from 'react';
import type { SnapshotArchiveEntry } from '@kojo/plugin-api';
import { panelPhase } from './panel-logic';

export interface ToolbarProps {
  /** 当前选中的档位路径；未选 = null */
  readonly path: string | null;
  /** 可解析档位（浅解析结果里 meta 有效且无 error 的条目；过滤语义在面板层） */
  readonly rows: readonly SnapshotArchiveEntry[];
  readonly setPath: (path: string | null) => void;
}

/** 顶部工具条（说明行 + 档位下拉） */
export function renderToolbar(props: ToolbarProps): ReactNode {
  const { path, rows, setPath } = props;
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

  return createElement('div', { className: 'inj-toolbar' },
    createElement('span', { className: 'dim' }, '改写存档变量（写前自动备份 · 写后校验）'),
    sel,
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
}

/** 非就绪阶段（无档位 / 未选档 / 读取中 / 读取失败）的整屏提示；ready ⇒ null */
export function renderPhaseBox(props: PhaseBoxProps): ReactNode {
  const { head, path, loading, loadError } = props;
  switch (panelPhase({
    hasSlots: props.hasSlots,
    path,
    loading,
    loadError,
    hasArchive: props.hasArchive,
  })) {
    case 'no-slots':
      return createElement('div', { className: 'panel-snapshot-injector' }, head,
        createElement('div', { className: 'inj-empty dim' }, '打开项目并扫描到存档后可用（存档列表来自「归档浏览器」面板）'));
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
