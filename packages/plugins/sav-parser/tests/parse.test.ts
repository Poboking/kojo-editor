import { describe, expect, it } from 'vitest';
import type { ArchiveArrayVariable, ArchiveDataTableVariable, ArchiveMapVariable, ArchiveScalarVariable } from '@kojo/plugin-api';
import { parseArchive, FORMAT_VERSION, MAGIC_GZIP, MAGIC_RAW } from '../src/parse';
import { makeArchiveFile, simpleCharBlock, W, type ArchiveSpec } from './helpers/synth';

/** 标准 normal 档规格：2 角色 + 全类型变量区 + EM 区 */
function normalSpec(over: Partial<ArchiveSpec> = {}): ArchiveSpec {
  return {
    fileType: 0,
    uniqueCode: 7153n,
    saveMes: '2026/09/21 22:05:03 第 47日(夏之月16日) 命莲寺 昴',
    charCount: 2,
    charBlock: simpleCharBlock,
    vars: (w) => {
      w.u8(0x00).str('DAY').int(47);
      w.u8(0x01).str('MONEY').u32(3).u8(106).u8(0xd2).i64(5_174_634_124n).u8(0xff);
      w.u8(0x20).str('MAP1').u32(2).str('a').str('1').str('b').str('2');
      w.u8(0x21).str('XML1').str('<doc/>');
      w.u8(0x22).str('DT1').str('<schema/>').str('<data/>');
    },
    em: (w) => {
      w.u8(0x22).str('DT_UFUFU_LOG').str('<s/>').str('<d/>');
    },
    withEm: true,
    ...over,
  };
}

const PATH = 'C:/games/tw/sav/save03.sav';

describe('parseArchive：完整档 round-trip（gzip 容器）', () => {
  it('顶层元数据', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH);
    expect(arch.format).toBe('gzip');
    expect(arch.version).toBe(FORMAT_VERSION);
    expect(arch.fileType).toBe('normal');
    expect(arch.uniqueCode).toBe('7153');
    expect(arch.gameVersion).toBe('0');
    expect(arch.saveMes).toContain('第 47日');
    expect(arch.fileName).toBe('save03.sav');
    expect(arch.charCount).toBe(2);
    expect(arch.size).toBeGreaterThan(0);
    expect(arch.decompressedSize).toBe(arch.bodySize);
  });

  it('角色块：变量流 + Separator 分界 + EOC', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH);
    expect(arch.chars).toHaveLength(2);
    const c0 = arch.chars![0]!;
    expect(c0.index).toBe(0);
    expect(c0.dimSepIndex).toBe(3); // NO / NAME / CFLAG 之后是 Separator
    expect(c0.vars).toHaveLength(4);
    const no = c0.vars[0] as ArchiveScalarVariable;
    expect(no).toMatchObject({ type: 'int', key: 'NO', value: 0 });
    const name = c0.vars[1] as ArchiveScalarVariable;
    expect(name).toMatchObject({ type: 'str', key: 'NAME', value: '角色0' });
    const cflag = c0.vars[2] as ArchiveArrayVariable;
    expect(cflag.type).toBe('int-array-1d');
    expect(cflag.saveLen).toEqual([4]);
    expect(cflag.cells).toEqual([
      { index: [0], value: 1 },
      { index: [3], value: 3 },
    ]);
    expect(cflag.nonEmpty).toBe(2);
    const dim = c0.vars[3] as ArchiveScalarVariable;
    expect(dim).toMatchObject({ key: 'TEST_DIM', value: -1 });
    // 第二个角色独立解码
    expect((arch.chars![1]!.vars[0] as ArchiveScalarVariable).value).toBe(1);
  });

  it('主变量区：标量 / 数组 / Map / Xml / DataTable', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH);
    expect(arch.vars).toHaveLength(5);
    const vars = arch.vars!;
    expect((vars[0] as ArchiveScalarVariable)).toMatchObject({ type: 'int', key: 'DAY', value: 47 });
    const money = vars[1] as ArchiveArrayVariable;
    expect(money.cells).toEqual([
      { index: [0], value: 106 },
      { index: [1], value: 5_174_634_124 },
    ]);
    const map = vars[2] as ArchiveMapVariable;
    expect(map).toMatchObject({ type: 'map', key: 'MAP1', count: 2 });
    expect(map.pairs).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect((vars[3] as { type: string }).type).toBe('xml');
    const dt = vars[4] as ArchiveDataTableVariable;
    expect(dt).toMatchObject({ type: 'datatable', key: 'DT1', schema: '<schema/>', data: '<data/>' });
  });

  it('EM 扩展区（第二段）', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH);
    expect(arch.emVars).toHaveLength(1);
    expect((arch.emVars![0] as ArchiveDataTableVariable).key).toBe('DT_UFUFU_LOG');
  });

  it('全字节消费（remaining = 0）——协议完整性硬断言', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH);
    expect(arch.consumed).toBe(arch.bodySize);
    expect(arch.remaining).toBe(0);
  });

  it('raw 容器（未压缩正文档）同构解析', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec({ compress: false })), PATH);
    expect(arch.format).toBe('raw');
    expect(arch.chars).toHaveLength(2);
    expect(arch.remaining).toBe(0);
  });
});

describe('parseArchive：其它档型', () => {
  it('global：全局变量区、无角色区、可无 EM 区', async () => {
    const bytes = makeArchiveFile({
      fileType: 1,
      saveMes: '',
      vars: (w) => {
        w.u8(0x00).str('GLOBAL_FLAG').int(1);
      },
    });
    const arch = await parseArchive(bytes, 'C:/games/tw/sav/global.sav');
    expect(arch.fileType).toBe('global');
    expect(arch.chars).toBeUndefined();
    expect(arch.charCount).toBe(0);
    expect(arch.globalVars).toHaveLength(1);
    expect(arch.vars).toBeUndefined();
    expect(arch.remaining).toBe(0);
  });

  it('charvar：角色区 only', async () => {
    const arch = await parseArchive(
      makeArchiveFile({ fileType: 3, charCount: 1, charBlock: simpleCharBlock }),
      'C:/games/tw/sav/chars.sav',
    );
    expect(arch.fileType).toBe('charvar');
    expect(arch.chars).toHaveLength(1);
    expect(arch.vars).toBeUndefined();
    expect(arch.remaining).toBe(0);
  });
});

describe('parseArchive：解析策略', () => {
  it('headerOnly：只读顶层头（扫描场景）', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH, { headerOnly: true });
    expect(arch.charCount).toBe(2);
    expect(arch.chars).toBeUndefined();
    expect(arch.vars).toBeUndefined();
    expect(arch.emVars).toBeUndefined();
    // 头读取进度远小于全量
    expect(arch.consumed).toBeLessThan(arch.bodySize);
  });

  it('keepArrayCells:false：cells 省略、nonEmpty 准确、标记 truncated', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH, { keepArrayCells: false });
    const cflag = arch.chars![0]!.vars[2] as ArchiveArrayVariable;
    expect(cflag.cells).toEqual([]);
    expect(cflag.nonEmpty).toBe(2);
    expect(cflag.cellsTruncated).toBe(true);
  });

  it('maxCellsPerArray：截断并标记', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH, { maxCellsPerArray: 1 });
    const cflag = arch.chars![0]!.vars[2] as ArchiveArrayVariable;
    expect(cflag.cells).toEqual([{ index: [0], value: 1 }]);
    expect(cflag.nonEmpty).toBe(2);
    expect(cflag.cellsTruncated).toBe(true);
  });

  it('完整保留时不带 truncated 标记', async () => {
    const arch = await parseArchive(makeArchiveFile(normalSpec()), PATH);
    const cflag = arch.chars![0]!.vars[2] as ArchiveArrayVariable;
    expect(cflag.cellsTruncated).toBeUndefined();
  });

  it('Int64 超安全范围 → warnings 显式呈现', async () => {
    const arch = await parseArchive(
      makeArchiveFile(
        normalSpec({
          vars: (w) => {
            w.u8(0x00).str('HUGE').u8(0xd2).i64(1n << 60n);
          },
        }),
      ),
      PATH,
    );
    expect(arch.warnings).toHaveLength(1);
    expect(arch.warnings![0]).toContain('安全整数');
  });
});

describe('parseArchive：错误路径（明确失败，不静默）', () => {
  it('文件过短', async () => {
    await expect(parseArchive(new Uint8Array([1, 2, 3]), PATH)).rejects.toThrow(/过短/);
  });

  it('未知魔数', async () => {
    await expect(parseArchive(makeArchiveFile(normalSpec({ magicOverride: 0x1234n })), PATH)).rejects.toThrow(/魔数/);
  });

  it('不支持的格式版本', async () => {
    await expect(parseArchive(makeArchiveFile(normalSpec({ versionOverride: 999 })), PATH)).rejects.toThrow(/版本 999/);
  });

  it('gzip 损坏', async () => {
    const bytes = makeArchiveFile(normalSpec()).slice(0, 40);
    await expect(parseArchive(bytes, PATH)).rejects.toThrow();
  });

  it('未知变量类型编码', async () => {
    const bytes = makeArchiveFile(
      normalSpec({
        vars: (w) => {
          w.u8(0x99).str('X').int(1);
        },
      }),
    );
    await expect(parseArchive(bytes, PATH)).rejects.toThrow(/未知变量类型 0x99/);
  });

  it('角色块未以 EOC 结束（先遇到 EOF）', async () => {
    const bytes = makeArchiveFile({
      fileType: 0,
      charCount: 1,
      // 写了变量但不写 EOC（0xFE）：读侧应明确报错而不是继续
      charBlock: (w) => {
        w.u8(0x00).str('NO').int(1);
      },
    });
    await expect(parseArchive(bytes, PATH)).rejects.toThrow(/未以 EOC 结束/);
  });
});

describe('常量与魔数', () => {
  it('魔数与版本常量稳定（协议兼容性锚点）', () => {
    expect(MAGIC_GZIP).toBe(0x0a50495a41524589n);
    expect(MAGIC_RAW).toBe(0x0a1a0a0d41524589n);
    expect(FORMAT_VERSION).toBe(1808);
  });
});
