/**
 * ZIP 写出器的**往返自证**：自己写的包，用一个独立写的最小读器读回来逐字段核对。
 *
 * 为什么不只测"字节长度像不像"：ZIP 的坑全在**字段之间的互指关系**上
 * （中央目录记的 localOffset / crc / 压缩尺寸必须与本地头逐字一致，
 * 否则工具解出来是空文件或错名）。这些只有真按 ZIP 结构读回来才能证伪。
 *
 * 读器是**故意重写的**（不复用写代码里的任何常量偏移）——自己写自己读会一起错。
 * 另有一次性交叉验证（真 `unzip -t`）记录在 IMPLEMENTATION-LOG，不进测试：
 * 那依赖宿主机装了 unzip。
 */

import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, crc32, deflateRaw, dosDateTime, normalizeEntryName, type ZipEntry } from '../src/zip';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string): Uint8Array => enc.encode(s);

/* --------------------------- 最小 ZIP 读器 --------------------------- */

interface ReadEntry {
  name: string;
  method: number;
  crc: number;
  flags: number;
  uncompressedSize: number;
  compressedSize: number;
  data: Uint8Array;
  /** 从**本地头**读到的字段（用来核对中央目录与本地头是否互指一致） */
  local: { crc: number; compressedSize: number; uncompressedSize: number; method: number; flags: number; name: string };
}

function readZip(buf: Uint8Array): ReadEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 从尾部找 EOCD（PK\x05\x06）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD');
  const count = view.getUint16(eocd + 8, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  expect(view.getUint16(eocd + 20, true)).toBe(0); // 无注释
  expect(eocd + 22).toBe(buf.length); // EOCD 必须在最末尾
  expect(cdOffset + cdSize).toBe(eocd); // 中央目录紧接 EOCD

  const entries: ReadEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    expect(view.getUint32(p, true), `第 ${n} 条中央目录签名`).toBe(0x02014b50);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 回到本地头核对互指字段
    expect(view.getUint32(localOffset, true), `${name} 本地头签名`).toBe(0x04034b50);
    const local = {
      flags: view.getUint16(localOffset + 6, true),
      method: view.getUint16(localOffset + 8, true),
      crc: view.getUint32(localOffset + 14, true),
      compressedSize: view.getUint32(localOffset + 18, true),
      uncompressedSize: view.getUint32(localOffset + 22, true),
    };
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const localName = dec.decode(buf.subarray(localOffset + 30, localOffset + 30 + localNameLen));
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.slice(dataStart, dataStart + local.compressedSize);

    entries.push({
      name, method, crc, flags, uncompressedSize, compressedSize, data,
      local: { ...local, name: localName },
    });
  }
  expect(p).toBe(eocd); // 中央目录刚好走完
  return entries;
}

/** 解出条目的原始字节（deflate 走 zlib 的 raw inflate，与本模块的压缩器互不相关） */
function extract(entry: ReadEntry): Uint8Array {
  if (entry.method === 0) return entry.data;
  expect(entry.method).toBe(8);
  return new Uint8Array(inflateRawSync(Buffer.from(entry.data)));
}

/* ------------------------------ 用例 ------------------------------ */

describe('crc32', () => {
  it('标准检验向量', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('normalizeEntryName（坏包与 zip-slip 的前置闸）', () => {
  it('反斜杠归一为正斜杠（ZIP 规范只认 /）', () => {
    expect(normalizeEntryName('ERB\\口上\\事件.kojo')).toBe('ERB/口上/事件.kojo');
  });
  it('拒绝绝对路径 / 盘符 / 上跳 / 空段', () => {
    expect(() => normalizeEntryName('/etc/passwd')).toThrow(/绝对路径/);
    expect(() => normalizeEntryName('C:/x/y')).toThrow(/盘符/);
    expect(() => normalizeEntryName('a/../../evil')).toThrow(/上跳/);
    expect(() => normalizeEntryName('a//b')).toThrow(/空路径段/);
    expect(() => normalizeEntryName('./a')).toThrow(/空路径段/);
    expect(() => normalizeEntryName('')).toThrow(/不能为空/);
  });
  it('目录条目（尾斜杠）放行', () => {
    expect(normalizeEntryName('子目录/')).toBe('子目录/');
  });
});

describe('dosDateTime', () => {
  /**
   * ZIP 的 DOS 时间戳按**本地时间**写（各家压缩工具都这么做，资源管理器也按本地解），
   * 所以这里必须用本地时间构造器——用 `Date.UTC` 会在非 UTC 时区上差出一个时区偏移。
   */
  it('1980-01-01（本地）= 年字段 0、月 1、日 1', () => {
    // DOS date 布局：bit 9-15 年-1980 / bit 5-8 月 / bit 0-4 日 ⇒ 1980-01-01 = 0b100001 = 33
    expect(dosDateTime(new Date(1980, 0, 1, 0, 0, 0).getTime())).toEqual({ date: 33, time: 0 });
  });

  it('时分秒按 DOS 编码（秒只到 2 秒精度）', () => {
    const { time } = dosDateTime(new Date(2026, 9, 12, 13, 45, 30).getTime());
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it('早于 1980 的 mtime 夹到 1980（DOS 日期域外，不静默产出负数）', () => {
    const { date } = dosDateTime(new Date(1970, 0, 1).getTime());
    expect(date & 0xfe00).toBe(0); // 年字段 = 0 → 1980
  });
});

describe('buildZip 往返自证', () => {
  const 中文 = '《テスト》口上・イベント\n; 中文与日文混排\n';

  it('单文件：字段互指一致，内容逐字节回得来', async () => {
    const src = bytes(中文);
    const zip = await buildZip([{ name: '事件.kojo', data: src }], { date: Date.UTC(2026, 9, 12, 8, 30, 0) });
    const [e] = readZip(zip);
    expect(e!.name).toBe('事件.kojo');
    expect(e!.local.name).toBe('事件.kojo');
    expect(e!.crc).toBe(crc32(src));
    expect(e!.local.crc).toBe(e!.crc);
    expect(e!.uncompressedSize).toBe(src.length);
    expect(e!.local.uncompressedSize).toBe(src.length);
    expect(e!.local.compressedSize).toBe(e!.compressedSize);
    expect(e!.local.method).toBe(e!.method);
    expect(dec.decode(extract(e!))).toBe(中文);
  });

  it('UTF-8 名字标志位（bit 11）必置——不置就是中文乱码目录名', async () => {
    const zip = await buildZip([{ name: '子目录/奉仕指令.kojo', data: bytes('x') }]);
    for (const e of readZip(zip)) {
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(e.local.flags & 0x0800).toBe(0x0800);
    }
  });

  it('名字里的分隔符在包里是 /，不是 \\', async () => {
    const zip = await buildZip([{ name: 'ERB\\口上\\事件.kojo', data: bytes('x') }]);
    expect(readZip(zip)[0]!.name).toBe('ERB/口上/事件.kojo');
  });

  it('可压缩的内容走 deflate 且能 inflate 回来', async () => {
    const src = bytes('あ'.repeat(4000)); // 高度可压缩
    const zip = await buildZip([{ name: '大文件.kojo', data: src }]);
    const [e] = readZip(zip);
    expect(e!.method).toBe(8);
    expect(e!.compressedSize).toBeLessThan(e!.uncompressedSize);
    expect(extract(e!)).toEqual(src);
  });

  it('短文件 deflate 会膨胀 → 退回 store（规矩 3）', async () => {
    const zip = await buildZip([{ name: 'a.kojo', data: bytes('@A\n') }]);
    expect(readZip(zip)[0]!.method).toBe(0);
  });

  it('compress:false 时全部 store', async () => {
    const src = bytes('x'.repeat(5000));
    const zip = await buildZip([{ name: 'a.kojo', data: src }], { compress: false });
    const [e] = readZip(zip);
    expect(e!.method).toBe(0);
    expect(e!.compressedSize).toBe(src.length);
  });

  it('目录条目：零长度、method 0、CRC 0，名字保留尾斜杠', async () => {
    const zip = await buildZip([
      { name: '空目录/', data: new Uint8Array(0) },
      { name: '空目录/占位.txt', data: bytes('hi') },
    ]);
    const [dir, file] = readZip(zip);
    expect(dir!.name).toBe('空目录/');
    expect(dir!.method).toBe(0);
    expect(dir!.crc).toBe(0);
    expect(dir!.uncompressedSize).toBe(0);
    expect(extract(file!)).toEqual(bytes('hi'));
  });

  it('多条目顺序与名字全保真（含中日文、空格、括号）', async () => {
    const items: ZipEntry[] = [
      { name: 'README.md', data: bytes('# 说明') },
      { name: 'ERB/口上・メッセージ関連/個人口上/001 博丽 灵梦/事件.kojo', data: bytes('@A\n') },
      { name: 'LICENSE', data: bytes('MIT') },
    ];
    const zip = await buildZip(items);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(items.map((e) => e.name));
    for (let i = 0; i < items.length; i++) {
      expect(extract(back[i]!)).toEqual(items[i]!.data);
    }
  });

  it('同内容 + 同 date ⇒ 逐字节相同（导出包要可复现）', async () => {
    const items: ZipEntry[] = [{ name: 'a.kojo', data: bytes('x'.repeat(2000)) }];
    const o = { date: 1_700_000_000_000 };
    expect(await buildZip(items, o)).toEqual(await buildZip(items, o));
  });

  it('空包也合法（只有 EOCD）', async () => {
    const zip = await buildZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('拒绝超过 65,535 条目（明确不支 ZIP64，而不是静默产坏包）', async () => {
    const many: ZipEntry[] = Array.from({ length: 65_536 }, (_, i) => ({
      name: `f${i}.txt`,
      data: new Uint8Array(0),
    }));
    await expect(buildZip(many)).rejects.toThrow(/ZIP64/);
  });
});

describe('deflateRaw 降级', () => {
  it('空输入不压缩（返回 null → 调用方 store）', async () => {
    expect(await deflateRaw(new Uint8Array(0))).toBeNull();
  });

  it('平台无 CompressionStream 时返回 null，而不是抛', async () => {
    const original = (globalThis as { CompressionStream?: unknown }).CompressionStream;
    Object.defineProperty(globalThis, 'CompressionStream', { value: undefined, configurable: true });
    try {
      expect(await deflateRaw(bytes('abc'))).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'CompressionStream', { value: original, configurable: true });
    }
  });

  it('产出的是 raw deflate（zlib 的 inflateRawSync 能直接吃）', async () => {
    const src = bytes('重复重复重复'.repeat(500));
    const zipped = await deflateRaw(src);
    expect(zipped).not.toBeNull();
    expect(new Uint8Array(inflateRawSync(Buffer.from(zipped!)))).toEqual(src);
  });
});
