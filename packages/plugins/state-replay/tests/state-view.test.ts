/**
 * 状态视图单测（合成 SnapshotArchive 注入）。
 *
 * 覆盖：角色定位（CSV NO → 注册号）/ TARGET 补位 / 显式角色 / MASTER 指针 /
 * 稀疏缺省 0 / 越界 / 具名索引（有 / 无字典）/ 全局变量 0 参等价 `[0]` /
 * 伪变量与局部量降级 / 截断显式 / #DIM 数据驱动 / 字符串变量 / 角色缺失抛错。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveCharacterBlock, ArchiveVariable, SnapshotArchive, VariableRef } from '@kojo/plugin-api';
import { createStateView, ReplayViewError } from '../src/state-view';

function scalarInt(key: string, value: number): ArchiveVariable {
  return { type: 'int', key, value, offset: 0 };
}
function scalarStr(key: string, value: string): ArchiveVariable {
  return { type: 'str', key, value, offset: 0 };
}
function int1d(key: string, saveLen: number, cells: [number, number][], extra: Partial<{ cellsTruncated: boolean; nonEmpty: number }> = {}): ArchiveVariable {
  return {
    type: 'int-array-1d',
    key,
    saveLen: [saveLen],
    cursor: [saveLen],
    nonEmpty: extra.nonEmpty ?? cells.length,
    cells: cells.map(([i, v]) => ({ index: [i], value: v })),
    ...(extra.cellsTruncated ? { cellsTruncated: true } : {}),
    offset: 0,
  };
}
function block(index: number, vars: ArchiveVariable[]): ArchiveCharacterBlock {
  return { index, dimSepIndex: null, vars };
}

function makeArchive(): SnapshotArchive {
  return {
    path: 'D:/fake/sav/save01.sav',
    fileName: 'save01.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 2,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [
      block(0, [
        scalarInt('NO', 0),
        scalarStr('NAME', '昴'),
        scalarStr('CALLNAME', '主人'),
        int1d('CFLAG', 100, [[2, 1], [4, 50]]),
      ]),
      block(1, [
        scalarInt('NO', 49),
        scalarStr('NAME', '古明地 觉'),
        scalarStr('CALLNAME', '觉'),
        int1d('CFLAG', 100, [[2, 800], [4, 300]]),
        int1d('TALENT', 1000, [[3, 1]]),
        int1d('PANTS_TEMP', 10, [[0, 7]]), // #DIM CHARA（数据驱动）
        {
          type: 'str-array-1d',
          key: 'CSTR',
          saveLen: [100],
          cursor: [10],
          nonEmpty: 1,
          cells: [{ index: [0], value: '第一人称' }],
          offset: 0,
        },
      ]),
    ],
    vars: [
      int1d('DAY', 1000, [[0, 47]]),
      int1d('MONEY', 1000, [[0, 5177463124]]),
      int1d('MASTER', 10, [[0, 0]]),
      int1d('TARGET', 10, [[0, 0]]),
      int1d('YOGORE', 1000, [[1, 5]]), // 魔改全局变量（数据驱动识别）
    ],
  };
}

const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length > 0 ? `${name}:${indices.join(':')}` : name,
});

const fakeLookup = (name: string, index?: number | string) => {
  if (name === 'TALENT' && index === '恋慕') return { name: 'TALENT', index, description: '恋慕', resolvedIndex: 3 };
  if (name === 'TALENT' && index === 3) return { name: 'TALENT', index, description: '恋慕', resolvedIndex: 3 };
  return undefined;
};

const view = () => createStateView({ archive: makeArchive(), characterNo: 49, lookup: fakeLookup });
const viewNoSchema = () => createStateView({ archive: makeArchive(), characterNo: 49 });

const value = (v: ReturnType<ReturnType<typeof view>['read']>): number | string => {
  if (v.kind !== 'value') throw new Error(`expected value, got: ${JSON.stringify(v)}`);
  return v.value;
};
const unknownCode = (v: ReturnType<ReturnType<typeof view>['read']>): string => {
  if (v.kind !== 'unknown') throw new Error(`expected unknown, got: ${JSON.stringify(v)}`);
  return v.unknown.code;
};

describe('createStateView：定位与元数据', () => {
  it('按 CSV NO 定位角色块（与块序无关的语义）', () => {
    const v = view();
    expect(v.characterNo).toBe(49);
    expect(v.characterName).toBe('古明地 觉');
    expect(v.archivePath).toBe('D:/fake/sav/save01.sav');
  });

  it('角色不在快照 → 抛 ReplayViewError', () => {
    expect(() => createStateView({ archive: makeArchive(), characterNo: 999 })).toThrow(ReplayViewError);
  });
});

describe('read：角色变量寻址（TARGET 补位 / 显式角色 / 稀疏缺省）', () => {
  it('CFLAG:2 → TARGET（回放角色）的 CFLAG[2]', () => {
    expect(value(view().read(ref('CFLAG', ['2'])))).toBe(800);
  });

  it('单参补位：CFLAG:4 等价 CFLAG:回放角色:4', () => {
    expect(value(view().read(ref('CFLAG', ['4'])))).toBe(300);
  });

  it('显式角色：CFLAG:0:2 → 昴的 CFLAG[2]', () => {
    expect(value(view().read(ref('CFLAG', ['0', '2'])))).toBe(1);
  });

  it('MASTER 指针：CFLAG:MASTER:2 → MASTER[0]=0 → 昴', () => {
    expect(value(view().read(ref('CFLAG', ['MASTER', '2'])))).toBe(1);
  });

  it('TARGET 指针：CFLAG:TARGET:2 → 回放角色', () => {
    expect(value(view().read(ref('CFLAG', ['TARGET', '2'])))).toBe(800);
  });

  it('稀疏缺省：CFLAG:9（无 cell）→ 0', () => {
    expect(value(view().read(ref('CFLAG', ['9'])))).toBe(0);
  });

  it('0 参等价 [TARGET,0]：CFLAG → CFLAG:回放角色:0', () => {
    expect(value(view().read(ref('CFLAG')))).toBe(0); // 觉的 CFLAG[0] 无记录
  });

  it('越界 → unknown(index-oob)', () => {
    expect(unknownCode(view().read(ref('CFLAG', ['99999'])))).toBe('index-oob');
  });

  it('参数过多 → unknown(too-many-args)', () => {
    expect(unknownCode(view().read(ref('CFLAG', ['1', '2', '3'])))).toBe('too-many-args');
  });

  it('角色字符串标量：NAME / NAME:0', () => {
    const v = view();
    expect(value(v.read(ref('NAME')))).toBe('古明地 觉');
    expect(value(v.read(ref('NAME', ['0'])))).toBe('昴');
  });

  it('角色字符串数组：CSTR:0', () => {
    expect(value(view().read(ref('CSTR', ['0'])))).toBe('第一人称');
  });

  it('#DIM 用户角色变量（数据驱动）：PANTS_TEMP:0', () => {
    expect(value(view().read(ref('PANTS_TEMP', ['0'])))).toBe(7);
  });
});

describe('read：具名索引与 schema', () => {
  it('有字典：TALENT:恋慕 → 编号 3 → 值 1', () => {
    expect(value(view().read(ref('TALENT', ['恋慕'])))).toBe(1);
  });

  it('无字典：TALENT:恋慕 → unknown(named-index)', () => {
    expect(unknownCode(viewNoSchema().read(ref('TALENT', ['恋慕'])))).toBe('named-index');
  });

  it('动态索引段 → unknown(dynamic-index)', () => {
    expect(unknownCode(view().read(ref('YOGORE', ['(GET_CHARAHOME(TARGET))'])))).toBe('dynamic-index');
  });

  it('rename 词 → unknown(rename)', () => {
    expect(unknownCode(view().read(ref('CFLAG', ['[[詞]]'])))).toBe('rename');
  });
});

describe('read：全局变量与指针', () => {
  it('DAY 等价 DAY:0', () => {
    const v = view();
    expect(value(v.read(ref('DAY')))).toBe(47);
    expect(value(v.read(ref('DAY', ['0'])))).toBe(47);
  });

  it('MONEY 大数', () => {
    expect(value(view().read(ref('MONEY', ['0'])))).toBe(5177463124);
  });

  it('全局 1D 参数过多 → unknown', () => {
    expect(unknownCode(view().read(ref('DAY', ['1', '2'])))).toBe('too-many-args');
  });

  it('已知内置全局变量但快照无数据 → 引擎默认 0', () => {
    expect(value(view().read(ref('TFLAG', ['5'])))).toBe(0);
  });
});

describe('read：能力边界与显式降级', () => {
  it('CALC 伪变量 · 引擎常量（回放可求值）', () => {
    const v = view();
    // Emuera Int64.MaxValue / MinValue（double：Max 落为 2^63）
    expect(value(v.read(ref('__INT_MAX__')))).toBe(2 ** 63);
    expect(value(v.read(ref('__INT_MIN__')))).toBe(-(2 ** 63));
    // 负自证：标量不吃索引
    expect(unknownCode(v.read(ref('__INT_MAX__', ['0'])))).toBe('too-many-args');
  });

  it('CALC 伪变量 · CHARANUM = 快照角色块数', () => {
    const v = view();
    expect(value(v.read(ref('CHARANUM')))).toBe(2); // makeArchive 2 个角色块
    expect(unknownCode(v.read(ref('CHARANUM', ['0'])))).toBe('too-many-args'); // 负自证
  });

  it('运行期量 / 行号系伪变量 → unknown(pseudo)（视图层无谓词上下文）', () => {
    const v = view();
    expect(unknownCode(v.read(ref('RAND', ['2'])))).toBe('pseudo');
    expect(unknownCode(v.read(ref('__LINE__')))).toBe('pseudo'); // 逐谓词上下文在 engine 注入
    expect(unknownCode(v.read(ref('__FILE__')))).toBe('pseudo'); // Emuera 相对路径不可复现 → 保持 unknown
    expect(unknownCode(v.read(ref('__FUNCTION__')))).toBe('pseudo'); // Emuera 原始大小写函数名不可得 → 保持 unknown
  });

  it('语言局部量 → unknown(pseudo)', () => {
    expect(unknownCode(view().read(ref('LOCAL', ['0'])))).toBe('pseudo');
    expect(unknownCode(view().read(ref('ARG', ['1'])))).toBe('pseudo');
  });

  it('未知变量（不在快照也不在内置清单）→ unknown(missing-var)', () => {
    expect(unknownCode(view().read(ref('NOT_A_VAR', ['0'])))).toBe('missing-var');
  });

  it('角色注册号不在快照 → unknown(missing-var)', () => {
    expect(unknownCode(view().read(ref('CFLAG', ['99', '2'])))).toBe('missing-var');
  });

  it('截断数组未命中 → unknown(truncated)', () => {
    const base = makeArchive();
    const chars = base.chars!.map((b) =>
      b.index === 1
        ? { ...b, vars: b.vars.map((v) => (v.key === 'CFLAG' ? int1d('CFLAG', 100, [[2, 800]], { cellsTruncated: true, nonEmpty: 5 }) : v)) }
        : b,
    );
    const v = createStateView({ archive: { ...base, chars }, characterNo: 49 });
    expect(unknownCode(v.read(ref('CFLAG', ['9'])))).toBe('truncated');
    // 已保留的单元仍可读
    expect(value(v.read(ref('CFLAG', ['2'])))).toBe(800);
  });
});
