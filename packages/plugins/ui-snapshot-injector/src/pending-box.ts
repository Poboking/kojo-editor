/**
 * 注入面板的**待写入清单**（diff 行 + 两击确认注入按钮 + 结果 / 错误行；
 * 从 `index.ts` 的面板组件里原样迁出，DOM 结构、className 与文案逐字不变）。
 *
 * 清单状态、注入编排仍归面板层；本模块只做呈现，回调由面板传入。
 */

import { createElement, type ReactNode } from 'react';
import type { SnapshotInjectionResult, VariableSchema } from '@kojo/plugin-api';
import { cellLabel, dedupePending, diffRows, varLabel, type PendingEdit, type ScopeKind } from './panel-logic';

export interface PendingBoxProps {
  /** 待注入清单原样（diff / 移除都按面板给出的同一数组口径） */
  readonly pending: PendingEdit[];
  readonly varSchema: VariableSchema | undefined;
  readonly injecting: boolean;
  readonly armed: boolean;
  readonly result: SnapshotInjectionResult | null;
  readonly injectError: string | null;
  /** 图标桥（宿主 renderIcon；面板内同名实现透传） */
  readonly ic: (name: string, size: number, fallback: string) => ReactNode;
  readonly runInject: () => void;
  readonly setPending: (pending: PendingEdit[]) => void;
  readonly setArmed: (armed: boolean) => void;
  /**
   * 位置白话化（可选）：把 `chars[0]` 折成「#0 阿蕾」——待写入清单是确认写盘前的
   * 最后一眼，理应是作者看得懂的话。缺省 = 沿用机器位置（旧调用方零改动）。
   */
  readonly scopeLabelOf?: (scope: ScopeKind) => string;
}

/** diff 清单 + 注入按钮 */
export function renderPendingBox(props: PendingBoxProps): ReturnType<typeof createElement> {
  const { pending, varSchema, injecting, armed, result, injectError, ic, runInject, setPending, setArmed, scopeLabelOf } = props;
  const diffs = diffRows(dedupePending(pending), scopeLabelOf);
  return createElement('div', { className: 'inj-pending' },
    createElement('div', { className: 'inj-pending-head' },
      createElement('span', null, `待写入（${diffs.length}）`),
      diffs.length > 0
        ? createElement('button', { className: 'ghost small', onClick: () => setPending([]) }, '清空')
        : null),
    ...diffs.map((d, i) => {
      const diffLbl = d.cell
        ? cellLabel(varSchema, d.key, d.cell.split(',').map(Number))
        : varLabel(varSchema, d.key);
      return createElement('div', { key: `${d.where}|${d.key}|${d.cell ?? ''}|${i}`, className: 'inj-diff-row' },
        createElement('span', { className: 'inj-diff-where' }, `${d.where}.${d.key}${d.cell ? `[${d.cell}]` : ''}`),
        diffLbl ? createElement('span', { className: 'inj-var-label' }, diffLbl) : null,
        createElement('span', { className: 'inj-diff-before dim' }, d.isNew ? '（新增）' : d.before),
        createElement('span', { className: 'inj-diff-arrow' }, '→'),
        createElement('span', { className: 'inj-diff-after' }, d.after),
        createElement('button', {
          className: 'ghost small',
          title: '移除此条',
          onClick: () => setPending(dedupePending(pending).filter((_, j) => j !== i)),
        }, '×'));
    }),
    diffs.length === 0 ? createElement('div', { className: 'dim inj-hint' }, '在上方「常用」卡直接填新值，或在左侧选变量编辑；改动先进入清单，确认后才写盘') : null,
    createElement('div', { className: 'inj-inject-row' },
      createElement('button', {
        className: 'primary',
        disabled: diffs.length === 0 || injecting,
        onClick: runInject,
      }, injecting ? '写入中…' : armed ? '确认写入存档？' : `写入存档（${diffs.length} 条）`),
      armed ? createElement('button', { className: 'ghost small', onClick: () => setArmed(false) }, '取消') : null),
    result
      ? createElement('div', { className: 'inj-result' },
          ic('check', 12, '✓'),
          ` 写入完成：已校验 ${result.verifiedCount} 项（${result.byteSize}B）` +
          (result.backupPath ? ` · 原档已备份至：${result.backupPath}` : ''))
      : null,
    injectError
      ? createElement('div', { className: 'inj-error' }, `写入失败：${injectError}`)
      : null,
  );
}
