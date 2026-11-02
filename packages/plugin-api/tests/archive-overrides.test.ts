/**
 * 覆盖预演纯函数单测（v0.3 口上调试统一批）。
 *
 * `applyArchiveOverrides` 是"注入前预演"的读模型半边：注入面板/回放面板都靠它
 * 回答"这些值改掉之后回放会变成什么"，**不写盘**。判据：
 * ① 不改入参（视图缓存按对象身份判失效）；② vars 与 chars 可同时给、叠加生效；
 * ③ 类型不匹配跳过（不伪造写侧会拒绝的改动）；④ 数组按单元补丁（同下标替换、
 * 新下标插入、其余原样）；⑤ 无命中 → 原对象原样返回。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveArrayVariable, ArchiveVariable, SnapshotArchive } from '@kojo/plugin-api';
import { applyArchiveOverrides } from '@kojo/plugin-api';

function archive(parts: {
  vars?: ArchiveVariable[];
  globalVars?: ArchiveVariable[];
  emVars?: ArchiveVariable[];
  chars?: { index: number; vars: ArchiveVariable[] }[];
}): SnapshotArchive {
  return {
    path: 'save01.sav',
    fileName: 'save01.sav',
    size: 1,
    format: 'raw',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '1',
    gameVersion: '1',
    saveMes: '',
    charCount: parts.chars?.length ?? 0,
    decompressedSize: 1,
    ...(parts.chars ? { chars: parts.chars.map((c) => ({ ...c, dimSepIndex: null })) } : {}),
    ...(parts.vars ? { vars: parts.vars } : {}),
    ...(parts.globalVars ? { globalVars: parts.globalVars } : {}),
    ...(parts.emVars ? { emVars: parts.emVars } : {}),
    bodySize: 1,
    consumed: 1,
    remaining: 0,
  };
}

const intVar = (key: string, value: number): ArchiveVariable => ({ type: 'int', key, value, offset: 0 });
const strVar = (key: string, value: string): ArchiveVariable => ({ type: 'str', key, value, offset: 0 });
const arrVar = (key: string, cells: { index: number[]; value: number | string }[]): ArchiveArrayVariable => ({
  type: 'int-array-1d',
  key,
  saveLen: [100],
  cursor: [0],
  nonEmpty: cells.filter((c) => c.value !== 0 && c.value !== '').length,
  cells,
  offset: 0,
});

describe('applyArchiveOverrides：vars', () => {
  it('标量替换生效', () => {
    const a = archive({ vars: [intVar('FLAG', 1), strVar('SAVESTR', 'x')] });
    const got = applyArchiveOverrides(a, { vars: new Map([['FLAG', 7]]) });
    expect((got.vars![0] as { value: number }).value).toBe(7);
    expect((got.vars![1] as { value: string }).value).toBe('x');
  });

  it('主变量区 → 全局区 → EM 区，每 key 只命中首个', () => {
    const a = archive({
      vars: [intVar('DAY', 3)],
      globalVars: [intVar('GLOBALFLAG', 0)],
      emVars: [intVar('EMFLAG', 0)],
    });
    const got = applyArchiveOverrides(a, {
      vars: new Map([
        ['GLOBALFLAG', 9],
        ['EMFLAG', 5],
      ]),
    });
    expect((got.globalVars![0] as { value: number }).value).toBe(9);
    expect((got.emVars![0] as { value: number }).value).toBe(5);
  });

  it('类型不匹配跳过（int 给字符串）——不伪造写侧会拒绝的改动', () => {
    const a = archive({ vars: [intVar('FLAG', 1)] });
    const got = applyArchiveOverrides(a, { vars: new Map([['FLAG', '不是数字']]) });
    expect(got).toBe(a); // 一条没命中 → 原对象原样返回
  });

  it('找不到该变量 → 原对象原样返回（身份不变，视图缓存不受影响）', () => {
    const a = archive({ vars: [intVar('FLAG', 1)] });
    expect(applyArchiveOverrides(a, { vars: new Map([['NOPE', 1]]) })).toBe(a);
  });

  it('map / xml / datatable 不在覆盖射程（跳过）', () => {
    const a = archive({
      emVars: [{ type: 'map', key: 'M', count: 0, pairs: [], offset: 0 }],
    });
    expect(applyArchiveOverrides(a, { vars: new Map([['M', 1]]) })).toBe(a);
  });
});

describe('applyArchiveOverrides：chars', () => {
  it('按块 index 命中，只改目标块', () => {
    const a = archive({
      chars: [
        { index: 0, vars: [intVar('CFLAG', 1)] },
        { index: 5, vars: [intVar('CFLAG', 1)] },
      ],
    });
    const got = applyArchiveOverrides(a, { chars: new Map([[5, new Map([['CFLAG', 800]])]]) });
    expect((got.chars![0]!.vars[0] as { value: number }).value).toBe(1);
    expect((got.chars![1]!.vars[0] as { value: number }).value).toBe(800);
  });

  it('不存在的块 index → 原对象原样返回', () => {
    const a = archive({ chars: [{ index: 0, vars: [intVar('CFLAG', 1)] }] });
    expect(applyArchiveOverrides(a, { chars: new Map([[9, new Map([['CFLAG', 1]])]]) })).toBe(a);
  });
});

describe('applyArchiveOverrides：vars 与 chars 叠加', () => {
  it('同时给 vars 与 chars 时两处都生效（旧实现会在 vars 处提前返回）', () => {
    const a = archive({
      vars: [intVar('DAY', 3)],
      chars: [{ index: 0, vars: [intVar('CFLAG', 1)] }],
    });
    const got = applyArchiveOverrides(a, {
      vars: new Map([['DAY', 4]]),
      chars: new Map([[0, new Map([['CFLAG', 2]])]]),
    });
    expect((got.vars![0] as { value: number }).value).toBe(4);
    expect((got.chars![0]!.vars[0] as { value: number }).value).toBe(2);
  });
});

describe('applyArchiveOverrides：数组单元补丁', () => {
  it('同下标替换 / 新下标插入 / 其余原样，并重算 nonEmpty', () => {
    const a = archive({ chars: [{ index: 0, vars: [arrVar('CFLAG', [{ index: [3], value: 10 }])] }] });
    const got = applyArchiveOverrides(a, {
      chars: new Map([[0, new Map([['CFLAG', [{ index: [3], value: 800 }, { index: [7], value: 1 }]]])]]),
    });
    const v = got.chars![0]!.vars[0] as ArchiveArrayVariable;
    expect(v.cells).toEqual([
      { index: [3], value: 800 },
      { index: [7], value: 1 },
    ]);
    expect(v.nonEmpty).toBe(2);
  });

  it('把单元改成 0 → nonEmpty 减一（清空语义）', () => {
    const a = archive({ chars: [{ index: 0, vars: [arrVar('CFLAG', [{ index: [3], value: 10 }])] }] });
    const got = applyArchiveOverrides(a, {
      chars: new Map([[0, new Map([['CFLAG', [{ index: [3], value: 0 }]]])]]),
    });
    expect((got.chars![0]!.vars[0] as ArchiveArrayVariable).nonEmpty).toBe(0);
  });
});

describe('不可变性', () => {
  it('不改入参（视图缓存按对象身份判失效，改了会污染缓存）', () => {
    const original = [intVar('FLAG', 1)];
    const a = archive({ vars: original, chars: [{ index: 0, vars: [intVar('CFLAG', 1)] }] });
    applyArchiveOverrides(a, {
      vars: new Map([['FLAG', 2]]),
      chars: new Map([[0, new Map([['CFLAG', 3]])]]),
    });
    expect((original[0] as { value: number }).value).toBe(1);
    expect((a.chars![0]!.vars[0] as { value: number }).value).toBe(1);
    expect(a.chars![0]!.vars).toHaveLength(1);
  });

  it('空覆盖集 → 原对象原样返回', () => {
    const a = archive({ vars: [intVar('FLAG', 1)] });
    expect(applyArchiveOverrides(a, {})).toBe(a);
    expect(applyArchiveOverrides(a, { vars: new Map() })).toBe(a);
  });
});
