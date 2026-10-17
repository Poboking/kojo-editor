/**
 * 注入面板的**编辑区**（标量编辑 / 数组单元编辑 + 新单元行；从 `index.ts` 的面板
 * 组件里原样迁出，DOM 结构、className 与文案逐字不变）。
 *
 * 「选了哪个变量、草稿是什么」仍归面板持有（它是交互状态）；本模块只把状态摆成 DOM，
 * 解析校验 / 入清单 / 清草稿的语义由传入回调（面板里的同名函数）承担。
 */

import { createElement } from 'react';
import type { VariableSchema } from '@kojo/plugin-api';
import { varLabel, type VarRow } from './panel-logic';
import { CellRows } from './cell-rows';

export interface EditorBoxProps {
  /** 当前选中变量行（null / 非 scalar|array 形态 ⇒ 编辑区为空） */
  readonly selected: VarRow | null;
  readonly varSchema: VariableSchema | undefined;
  readonly scalarDraft: string;
  readonly setScalarDraft: (value: string) => void;
  readonly submitScalar: () => void;
  readonly cellDrafts: Record<string, string>;
  readonly setCellDrafts: (drafts: Record<string, string>) => void;
  readonly cellWindow: number | undefined;
  readonly growCells: (total: number) => void;
  readonly submitCellFromRow: (index: number[], draft: string, oldValue: number | string) => void;
  readonly newIndexDraft: string;
  readonly setNewIndexDraft: (value: string) => void;
  readonly newValueDraft: string;
  readonly setNewValueDraft: (value: string) => void;
  readonly submitNewCell: () => void;
}

/** 编辑区（标量 / 数组两形态；无可编辑选中时为 null） */
export function renderEditor(props: EditorBoxProps): ReturnType<typeof createElement> | null {
  const { selected, varSchema, scalarDraft, setScalarDraft, submitScalar } = props;
  const { cellDrafts, setCellDrafts, cellWindow, growCells, submitCellFromRow } = props;
  const { newIndexDraft, setNewIndexDraft, newValueDraft, setNewValueDraft, submitNewCell } = props;
  let editor: ReturnType<typeof createElement> | null = null;
  if (selected && selected.kind === 'scalar') {
    const intLike = selected.type === 'int';
    const scalarLabel = varLabel(varSchema, selected.key);
    editor = createElement('div', { className: 'inj-editor' },
      createElement('div', { className: 'inj-editor-head' },
        createElement('span', { className: 'inj-var-key' }, selected.key),
        scalarLabel ? createElement('span', { className: 'inj-var-label' }, scalarLabel) : null,
        createElement('span', { className: 'dim' }, ` 当前：${String(selected.scalarValue ?? '')}`)),
      createElement('div', { className: 'inj-editor-row' },
        createElement('input', {
          className: 'inj-input',
          value: scalarDraft,
          placeholder: intLike ? '新整数值' : '新字符串值',
          onChange: (e: { target: { value: string } }) => setScalarDraft(e.target.value),
        }),
        createElement('button', { className: 'ghost small', onClick: () => submitScalar() }, '加入清单')),
      createElement('div', { className: 'dim inj-hint' },
        intLike ? '只能填整数；数值过大会被拒绝' : '字符串按存档原编码写回'),
    );
  } else if (selected && selected.kind === 'array' && selected.cells) {
    const isInt = selected.type.startsWith('int-array');
    const arrLabel = varLabel(varSchema, selected.key);
    editor = createElement('div', { className: 'inj-editor' },
      createElement('div', { className: 'inj-editor-head' },
        createElement('span', { className: 'inj-var-key' }, selected.key),
        arrLabel ? createElement('span', { className: 'inj-var-label' }, arrLabel) : null,
        createElement('span', { className: 'dim' }, ` ${selected.cells.length} 个非空单元`)),
      createElement(CellRows, {
        cells: selected.cells,
        varKey: selected.key,
        schema: varSchema,
        drafts: cellDrafts,
        limit: cellWindow,
        onGrow: growCells,
        onDraft: (ik: string, v: string) => setCellDrafts({ ...cellDrafts, [ik]: v }),
        onSubmit: submitCellFromRow,
      }),
      createElement('div', { className: 'inj-editor-row inj-new-cell' },
        createElement('input', {
          className: 'inj-input inj-cell-index-input',
          value: newIndexDraft,
          placeholder: `新单元下标（${selected.saveLen!.map((n) => `0..${n - 1}`).join(',')}）`,
          onChange: (e: { target: { value: string } }) => setNewIndexDraft(e.target.value),
        }),
        createElement('input', {
          className: 'inj-input',
          value: newValueDraft,
          placeholder: isInt ? '整数值' : '字符串值',
          onChange: (e: { target: { value: string } }) => setNewValueDraft(e.target.value),
        }),
        createElement('button', { className: 'ghost small', onClick: () => submitNewCell() }, '加入清单')),
      createElement('div', { className: 'dim inj-hint' },
        isInt ? '只能填整数；数值过大会被拒绝' : '字符串按存档原编码写回'),
    );
  }
  return editor;
}
