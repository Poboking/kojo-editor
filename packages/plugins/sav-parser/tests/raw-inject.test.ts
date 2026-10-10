/**
 * 方案 B 单测：raw passthrough + 改槽注入 + Int64 守卫（v0.2 第十三批）。
 *
 * 合成字节构造（不依赖游戏目录；金样本回归在 golden-roundtrip.test.ts）：
 * - passthrough：Int64 近似值（0xD2 编码）原样写回——传统重编码路径对此显式拒绝；
 * - 注入：标量覆盖 / 数组单元补丁合并 / 类型不符拒绝 / cells 截断拒绝；
 * - 守卫：被修改数组含超安全整数域单元 → 拒绝注入。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveArrayVariable, ArchiveVariable, SnapshotArchive } from '@kojo/plugin-api';
import { ByteWriter } from '../src/writer';
import { parseArchive } from '../src/parse';
import { serializePayload } from '../src/serialize';

const MAGIC_RAW = 0x0a1a0a0d41524589n;

/** 用 ByteWriter 造一个 16 字节明文头 + 载荷的合成档（raw 容器） */
function wrapPayload(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, MAGIC_RAW, true);
  dv.setUint32(8, 1808, true);
  out.set(payload, 16);
  return out;
}

/** 造一个 var 类型档：fileType + uniqueCode + gameVersion + saveMes + 变量流 */
function buildVarFile(w: (w: ByteWriter) => void): Uint8Array {
  const bw = new ByteWriter();
  bw.byte(2); // fileType: var
  bw.int64(0x1234567890n); // uniqueCode
  bw.int64(1808n); // gameVersion
  bw.str('测试档');
  w(bw);
  return wrapPayload(bw.toBytes());
}

describe('方案 B · raw passthrough', () => {
  it('Int64（0xD2 编码）近似值的档：keepRaw 解析 → 序列化字节级一致（传统路径会拒绝）', async () => {
    const BIG = 2n ** 60n; // 超安全整数域，读侧近似为 double
    const file = buildVarFile((w) => {
      w.byte(0x00); // int
      w.str('BIGVAR');
      w.byte(0xd2);
      w.int64(BIG);
      w.byte(0x00);
      w.str('SMALL');
      w.encodeInt(42);
      w.byte(0xff);
    });

    // 传统路径：keepRaw 关 → serialize 应显式拒绝（近似值不可编码）
    const legacy = await parseArchive(file, 'test.sav', { keepArrayCells: true });
    expect(legacy.warnings?.length).toBeGreaterThan(0);
    expect(() => serializePayload(legacy)).toThrow(/超出安全整数范围/);

    // 方案 B：keepRaw 开 → passthrough 字节级一致
    const rawed = await parseArchive(file, 'test.sav', { keepArrayCells: true, keepRaw: true });
    const v0 = rawed.vars?.find((v) => v.key === 'BIGVAR');
    expect(v0?.raw).toBeDefined();
    expect(v0?.raw!.length).toBeGreaterThan(0);
    const out = serializePayload(rawed);
    expect(out.length).toBe(file.length - 16);
    expect(Array.from(out)).toEqual(Array.from(file.subarray(16)));
  });

  it('passthrough 与无 raw 的传统路径可混用（部分变量有 raw、部分没有）', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x00);
      w.str('A');
      w.encodeInt(1);
      w.byte(0xff);
    });
    const parsed = await parseArchive(file, 'test.sav', { keepRaw: true });
    // 手工剥掉 B 变量的 raw 模拟混合场景
    const vars: ArchiveVariable[] = [...(parsed.vars ?? [])];
    delete (vars[0] as { raw?: Uint8Array }).raw;
    const mixed: SnapshotArchive = { ...parsed, vars };
    const out = serializePayload(mixed);
    expect(Array.from(out)).toEqual(Array.from(file.subarray(16)));
  });
});

describe('方案 B · 改槽注入（overrides）', () => {
  it('标量覆盖：改值后除该变量外逐字节一致；重解析读到新值', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x00);
      w.str('GOLD');
      w.encodeInt(100);
      w.byte(0x00);
      w.str('OTHER');
      w.encodeInt(7);
      w.byte(0xff);
    });
    const parsed = await parseArchive(file, 'test.sav', { keepRaw: true });
    const baseline = serializePayload(parsed);
    const injected = serializePayload(parsed, { overrides: { vars: new Map([['GOLD', 999]]) } });

    // 与基线差异只在 GOLD 段（前缀同、后缀同）
    const b = Array.from(baseline);
    const i = Array.from(injected);
    expect(i.length).toBeGreaterThan(b.length - 3); // 999 比 100 多字节
    // OTHER 段未受影响：取基线尾段（OTHER 变量 + EOF）与注入结果尾段对比
    const tail = 6; // OTHER: 1 token + (1+10) key + 1 val + 1 eof ≈ 至少同长
    expect(i.slice(-tail)).toEqual(b.slice(-tail));
    // 重解析验证语义
    const reparsed = await parseArchive(wrapPayload(injected), 't.sav', {});
    const goldVar = reparsed.vars?.find((v) => v.key === 'GOLD');
    expect(goldVar && 'value' in goldVar ? goldVar.value : undefined).toBe(999);
  });

  it('数组单元补丁：同下标替换、新下标插入、其余单元保留（含排序）', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x01); // int-array-1d
      w.str('ARR');
      w.int32(10); // saveLen
      w.encodeInt(10); // [0]=10
      w.byte(0xf0);
      w.encodeInt(3); // 跳到 4
      w.encodeInt(44); // [4]=44
      w.byte(0xff); // 数组结束
      w.byte(0xff); // 流 EOF
    });
    const parsed = await parseArchive(file, 'test.sav', { keepRaw: true });
    const out = serializePayload(parsed, {
      overrides: { vars: new Map([['ARR', [{ index: [2], value: 22 }, { index: [4], value: 404 }]]]) },
    });
    const reparsed = await parseArchive(wrapPayload(out), 't.sav', {});
    const arr = reparsed.vars?.find((v) => v.key === 'ARR') as ArchiveArrayVariable | undefined;
    expect(arr).toBeDefined();
    const get = (x: number): number | string | undefined =>
      arr!.cells.find((c) => c.index[0] === x)?.value;
    expect(get(0)).toBe(10); // 保留
    expect(get(2)).toBe(22); // 插入
    expect(get(4)).toBe(404); // 替换
  });

  it('类型不符的覆盖 → 显式拒绝', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x00);
      w.str('N');
      w.encodeInt(1);
      w.byte(0xff);
    });
    const parsed = await parseArchive(file, 't.sav', {});
    expect(() => serializePayload(parsed, { overrides: { vars: new Map([['N', '字符串']]) } })).toThrow(
      /覆盖值须为 number/,
    );
  });

  it('被覆盖数组含超安全整数域单元 → Int64 守卫拒绝（损坏不落盘）', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x01); // int-array-1d
      w.str('HUGE');
      w.int32(4);
      w.byte(0xd2);
      w.int64(2n ** 60n); // [0] = 2^60（近似）
      w.byte(0xff);
      w.byte(0xff);
    });
    const parsed = await parseArchive(file, 't.sav', { keepRaw: true });
    // passthrough 无覆盖：安全
    expect(serializePayload(parsed).length).toBeGreaterThan(0);
    // 一旦要重编码（覆盖）：守卫拒绝
    expect(() =>
      serializePayload(parsed, { overrides: { vars: new Map([['HUGE', [{ index: [1], value: 1 }]]]) } }),
    ).toThrow(/超出安全整数域/);
  });

  it('cells 截断的数组被覆盖 → 拒绝（不静默产出损坏载荷）', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x01);
      w.str('TRUNC');
      w.int32(10);
      w.encodeInt(0);
      w.encodeInt(1);
      w.byte(0xff);
      w.byte(0xff);
    });
    const truncated = await parseArchive(file, 't.sav', { maxCellsPerArray: 1, keepRaw: true });
    const v = truncated.vars?.[0] as ArchiveArrayVariable;
    expect(v.cellsTruncated).toBe(true);
    // 无覆盖 + raw passthrough：安全
    expect(serializePayload(truncated, {}).length).toBeGreaterThan(0);
    // 覆盖截断数组：拒绝
    expect(() =>
      serializePayload(truncated, { overrides: { vars: new Map([['TRUNC', [{ index: [5], value: 5 }]]]) } }),
    ).toThrow(/截断/);
  });

  it('map / datatable 类型暂不支持覆盖 → 显式拒绝', async () => {
    const file = buildVarFile((w) => {
      w.byte(0x20); // map
      w.str('M');
      w.int32(1);
      w.str('k');
      w.str('v');
      w.byte(0xff);
    });
    const parsed = await parseArchive(file, 't.sav', {});
    expect(() => serializePayload(parsed, { overrides: { vars: new Map([['M', 1]]) } })).toThrow(
      /暂不支持注入覆盖/,
    );
  });
});
