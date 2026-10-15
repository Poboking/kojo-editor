/**
 * `read_files_raw` 二进制帧解帧器（2026-10-16 批量 IO 批）单测。
 *
 * 帧格式的 Rust 侧编码在 `packages/app/src-tauri/src/lib.rs` 的 `read_files_frame`
 * （那边的单测自带一份独立解帧器做往返对拍）；这里测 **JS 侧解帧器**：
 * 用测试内独立构造的帧（DataView 逐字节写）验证字段映射、三态归类与 fail-loud
 * 纪律——解不出来就抛，绝不允许"解出一半还返回"。
 */
import { describe, expect, it } from 'vitest';
import { decodeReadFilesFrame } from '../src/bridge/read-files-frame';

interface FrameEntry {
  path: string;
  status: number;
  mtimeMs: bigint;
  size: bigint;
  data: Uint8Array;
}

/** 测试用的帧构造器（与 Rust `read_files_frame` 同格式的独立实现） */
function encodeFrame(entries: FrameEntry[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const u32 = (n: number): Uint8Array => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const i64 = (n: bigint): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, n, true);
    return b;
  };
  const u64 = (n: bigint): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  chunks.push(u32(entries.length));
  for (const e of entries) {
    const pathBytes = new TextEncoder().encode(e.path);
    chunks.push(u32(pathBytes.length), pathBytes, u32(e.status), i64(e.mtimeMs), u64(e.size), u64(BigInt(e.data.length)), e.data);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('decodeReadFilesFrame', () => {
  it('空帧（count=0）⇒ 空数组', () => {
    expect(decodeReadFilesFrame(encodeFrame([]))).toEqual([]);
  });

  it('多文件按序解出：路径（含 CJK）/ 字节 / mtime / size 逐位一致', () => {
    const a = enc('@A\nPRINTL 甲\n');
    const b = enc('');
    const frame = encodeFrame([
      { path: 'C:\\game\\ERB\\事件.ERB', status: 0, mtimeMs: 1700000000123n, size: BigInt(a.length), data: a },
      { path: 'C:\\game\\ERB\\empty.ERB', status: 0, mtimeMs: 2n, size: 0n, data: b },
    ]);
    const out = decodeReadFilesFrame(frame);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ path: 'C:\\game\\ERB\\事件.ERB', status: 'ok', mtimeMs: 1700000000123, size: a.length, data: a });
    expect(out[1]).toEqual({ path: 'C:\\game\\ERB\\empty.ERB', status: 'ok', mtimeMs: 2, size: 0, data: b });
    // 内容确实可解码（不是索引错位的断面）
    expect(new TextDecoder().decode(out[0]!.data)).toBe('@A\nPRINTL 甲\n');
  });

  it('i64 mtime 超出 32 位范围仍精确（Number 转换不走位运算）', () => {
    const big = 3_000_000_000_000n; // 远大于 2^32
    const out = decodeReadFilesFrame(
      encodeFrame([{ path: 'x', status: 0, mtimeMs: big, size: 0n, data: new Uint8Array(0) }]),
    );
    expect(out[0]!.mtimeMs).toBe(3_000_000_000_000);
    // 负值（1970 前的畸形 mtime）也如实回（不静默取绝对值）
    const neg = decodeReadFilesFrame(
      encodeFrame([{ path: 'x', status: 0, mtimeMs: -5n, size: 0n, data: new Uint8Array(0) }]),
    );
    expect(neg[0]!.mtimeMs).toBe(-5);
  });

  it('status=1（不存在）/ status=2（读错）：数值归 null、data 为空——与原帧占位 0 区分', () => {
    const frame = encodeFrame([
      { path: 'gone.ERB', status: 1, mtimeMs: 0n, size: 0n, data: new Uint8Array(0) },
      { path: 'broken.ERB', status: 2, mtimeMs: 7n, size: 99n, data: new Uint8Array(0) },
    ]);
    const out = decodeReadFilesFrame(frame);
    expect(out[0]).toEqual({ path: 'gone.ERB', status: 'not-found', mtimeMs: null, size: null, data: new Uint8Array(0) });
    // 读错项即便帧里带了占位数值，也一律归 null（判据不猜）
    expect(out[1]).toEqual({ path: 'broken.ERB', status: 'read-error', mtimeMs: null, size: null, data: new Uint8Array(0) });
  });

  it('未知 status ⇒ 抛错（不许把没见过的码猜成某种状态）', () => {
    expect(() =>
      decodeReadFilesFrame(encodeFrame([{ path: 'x', status: 3, mtimeMs: 0n, size: 0n, data: new Uint8Array(0) }])),
    ).toThrow(/未知 status/);
  });

  it('截断帧 ⇒ 抛错（含数据段被切、头部被切两种断法）', () => {
    const full = encodeFrame([{ path: 'hello.ERB', status: 0, mtimeMs: 1n, size: 5n, data: enc('hello') }]);
    expect(() => decodeReadFilesFrame(full.slice(0, full.byteLength - 3))).toThrow(/帧截断/);
    expect(() => decodeReadFilesFrame(full.slice(0, 6))).toThrow(/帧截断/);
    expect(() => decodeReadFilesFrame(new ArrayBuffer(2))).toThrow(/帧截断/);
  });

  it('尾部多余字节 ⇒ 抛错（帧长与内容不符 = 两份实现已经漂了）', () => {
    const full = encodeFrame([{ path: 'a', status: 0, mtimeMs: 1n, size: 0n, data: new Uint8Array(0) }]);
    const padded = new Uint8Array(full.byteLength + 4);
    padded.set(new Uint8Array(full), 0);
    expect(() => decodeReadFilesFrame(padded.buffer)).toThrow(/多余字节/);
  });

  it('重复路径逐位对应（批量契约：与入参一一对应，不做去重/合并）', () => {
    const frame = encodeFrame([
      { path: 'same.ERB', status: 0, mtimeMs: 1n, size: 1n, data: enc('x') },
      { path: 'same.ERB', status: 0, mtimeMs: 2n, size: 2n, data: enc('yy') },
    ]);
    const out = decodeReadFilesFrame(frame);
    expect(out.map((e) => e.mtimeMs)).toEqual([1, 2]);
    expect(out.map((e) => e.size)).toEqual([1, 2]);
  });
});
