/**
 * 注入面板纯逻辑单测（panel-logic，零 React）：
 * 变量目录 / 作用域 / 覆盖集构建 / diff / 输入解析 / 清单去重。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveCharacterBlock, ArchiveVariable, SnapshotArchive } from '@kojo/plugin-api';
import {
  buildOverrides,
  charaLabel,
  dedupePending,
  diffRows,
  editKey,
  listScopes,
  listVars,
  parseCellIndex,
  parseCellInput,
  parseScalarInput,
  scopeLabel,
  supersededCount,
  type PendingEdit,
} from '../src/panel-logic';

/* ---------------- 合成档案（手工构造，形状即契约） ---------------- */

function vInt(key: string, value: number): ArchiveVariable {
  return { type: 'int', key, value, offset: 0 };
}
function vStr(key: string, value: string): ArchiveVariable {
  return { type: 'str', key, value, offset: 0 };
}
function vArr1d(key: string, cells: { index: number[]; value: number }[], saveLen = [10]): ArchiveVariable {
  return {
    type: 'int-array-1d',
    key,
    saveLen,
    cursor: [saveLen[0]!],
    nonEmpty: cells.length,
    cells,
    offset: 0,
  };
}
function block(index: number, vars: ArchiveVariable[]): ArchiveCharacterBlock {
  return { index, vars, dimSepIndex: null };
}

function makeArchive(): SnapshotArchive {
  return {
    path: '/g/sav/save00.sav',
    fileName: 'save00.sav',
    size: 1,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '1',
    gameVersion: '0',
    saveMes: '第 1 日',
    charCount: 2,
    decompressedSize: 1,
    bodySize: 1,
    consumed: 1,
    remaining: 0,
    chars: [
      block(0, [vInt('NO', 0), vStr('CALLNAME', '灵梦'), vArr1d('CFLAG', [{ index: [1], value: 3 }])]),
      block(1, [vInt('NO', 1), vStr('NAME', '紫')]),
    ],
    vars: [vArr1d('DAY', [{ index: [0], value: 47 }]), vStr('TITLE', '标题')],
    emVars: [vStr('DT_UFUFU_LOG', 'x')],
  };
}

/* ---------------- 作用域与变量目录 ---------------- */

describe('listVars / listScopes / scopeLabel / charaLabel', () => {
  const a = makeArchive();

  it('作用域清单：normal 档 = 角色块 ×N + 主变量区 + EM 扩展区', () => {
    const scopes = listScopes(a);
    expect(scopes).toHaveLength(4);
    expect(scopes[0]).toEqual({ kind: 'char', blockIndex: 0 });
    expect(scopes[scopes.length - 1]).toEqual({ kind: 'em' });
  });

  it('listVars(char) 取角色块流序；listVars(top) 取主变量区；listVars(em) 取 EM 区', () => {
    expect(listVars(a, { kind: 'char', blockIndex: 1 }).map((r) => r.key)).toEqual(['NO', 'NAME']);
    expect(listVars(a, { kind: 'top' }).map((r) => r.key)).toEqual(['DAY', 'TITLE']);
    expect(listVars(a, { kind: 'em' }).map((r) => r.key)).toEqual(['DT_UFUFU_LOG']);
  });

  it('charaLabel：CALLNAME 优先，NAME 兜底，无名兜底编号', () => {
    const blocks = a.chars!;
    expect(charaLabel(blocks[0]!)).toBe('#0 灵梦');
    expect(charaLabel(blocks[1]!)).toBe('#1 紫');
    expect(charaLabel(block(2, [vInt('NO', 2)]))).toBe('角色 #2');
  });

  it('scopeLabel 与 listScopes 互证（全局档）', () => {
    const g: SnapshotArchive = { ...a, fileType: 'global', chars: undefined };
    const labels = listScopes(g).map((s) => scopeLabel(g, s));
    expect(labels).toContain('全局变量区');
    expect(labels).toContain('EM 扩展区');
  });

  it('目录行：标量 / 数组 / 不可注入三形态', () => {
    const rows = listVars(a, { kind: 'char', blockIndex: 0 });
    expect(rows.find((r) => r.key === 'NO')).toMatchObject({ kind: 'scalar', scalarValue: 0 });
    expect(rows.find((r) => r.key === 'CFLAG')).toMatchObject({ kind: 'array', saveLen: [10] });
  });
});

/* ---------------- 输入解析 ---------------- */

describe('parseScalarInput / parseCellInput / parseCellIndex', () => {
  it('int：整数收下、非整数与超安全域拒绝', () => {
    expect(parseScalarInput('int', '42')).toEqual({ ok: true, value: 42 });
    expect(parseScalarInput('int', '-7')).toEqual({ ok: true, value: -7 });
    expect(parseScalarInput('int', '1.5').ok).toBe(false);
    expect(parseScalarInput('int', '').ok).toBe(false);
    expect((parseScalarInput('int', String(2 ** 60)) as { error: string }).error).toContain('Int64');
  });

  it('str：原文透传；数组单元按元素类型分流', () => {
    expect(parseScalarInput('str', 'hello')).toEqual({ ok: true, value: 'hello' });
    expect(parseCellInput(true, '3')).toEqual({ ok: true, value: 3 });
    expect(parseCellInput(false, '3')).toEqual({ ok: true, value: '3' });
    expect(parseCellInput(true, 'x').ok).toBe(false);
  });

  it('parseCellIndex：维度数与逐维范围校验', () => {
    expect(parseCellIndex([10], '7')).toEqual({ ok: true, index: [7] });
    expect(parseCellIndex([10, 20], '1,2')).toEqual({ ok: true, index: [1, 2] });
    expect(parseCellIndex([10], '1,2').ok).toBe(false);
    expect(parseCellIndex([10], '10').ok).toBe(false); // 越界
    expect(parseCellIndex([10], '-1').ok).toBe(false);
  });
});

/* ---------------- 覆盖集构建 / diff / 去重 ---------------- */

const TOP = { kind: 'top' } as const;
const C0 = { kind: 'char', blockIndex: 0 } as const;

describe('buildOverrides / diffRows / dedupePending', () => {
  it('标量 + 单元补丁 → vars / chars 双层 Map（与 serializePayload 覆盖模型同构）', () => {
    const pending: PendingEdit[] = [
      { scope: C0, key: 'NO', kind: 'scalar', oldValue: 0, newValue: 9 },
      { scope: C0, key: 'CFLAG', kind: 'cell', index: [1], oldValue: 3, newValue: 30 },
      { scope: C0, key: 'CFLAG', kind: 'cell', index: [2], oldValue: null, newValue: 99 },
      { scope: TOP, key: 'TITLE', kind: 'scalar', oldValue: '标题', newValue: '新标题' },
    ];
    const ov = buildOverrides(pending);
    const charMap = ov.chars!.get(0)!;
    expect(charMap.get('NO')).toBe(9);
    expect(charMap.get('CFLAG')).toEqual([
      { index: [1], value: 30 },
      { index: [2], value: 99 },
    ]);
    expect(ov.vars!.get('TITLE')).toBe('新标题');
  });

  it('dedupePending：同目标 last-write-wins；不同目标互不影响', () => {
    const e1: PendingEdit = { scope: C0, key: 'NO', kind: 'scalar', oldValue: 0, newValue: 1 };
    const e2: PendingEdit = { scope: C0, key: 'NO', kind: 'scalar', oldValue: 0, newValue: 2 };
    const e3: PendingEdit = { scope: TOP, key: 'TITLE', kind: 'scalar', oldValue: '', newValue: 'x' };
    expect(dedupePending([e1, e2, e3])).toEqual([e2, e3]);
    expect(editKey(e1)).toBe(editKey(e2));
    expect(editKey(e1)).not.toBe(editKey(e3));
  });

  it('supersededCount：新编辑命中的既有条数', () => {
    const e1: PendingEdit = { scope: C0, key: 'NO', kind: 'scalar', oldValue: 0, newValue: 1 };
    const e2: PendingEdit = { scope: C0, key: 'NO', kind: 'cell', index: [1], oldValue: 3, newValue: 4 };
    const e3: PendingEdit = { scope: C0, key: 'NO', kind: 'cell', index: [1], oldValue: 3, newValue: 5 };
    expect(supersededCount([e1, e2], e3)).toBe(1);
    expect(supersededCount([e1, e2], e1)).toBe(1);
  });

  it('diffRows：改前/改后/新增三态', () => {
    const rows = diffRows([
      { scope: TOP, key: 'DAY', kind: 'scalar', oldValue: 47, newValue: 48 },
      { scope: C0, key: 'CFLAG', kind: 'cell', index: [2], oldValue: null, newValue: 1 },
    ]);
    expect(rows[0]).toMatchObject({ where: 'vars', key: 'DAY', before: '47', after: '48', isNew: false });
    expect(rows[1]).toMatchObject({
      where: 'chars[0]',
      key: 'CFLAG',
      cell: '2',
      before: '（新增）',
      isNew: true,
    });
  });
});
