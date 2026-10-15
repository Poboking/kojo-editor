import type { RawFileRead } from '@kojo/plugin-api';

/**
 * `read_files_raw` 二进制帧的**纯函数**解帧器（2026-10-16 批量 IO 批）。
 *
 * 帧格式（全小端；Rust 侧编码在 `packages/app/src-tauri/src/lib.rs` 的
 * `read_files_frame`，两份实现以帧格式为唯一真源、成对演进）：
 *   [u32 文件数]
 *   每文件：[u32 pathLen][path(utf-8 字节)][u32 status][i64 mtimeMs][u64 size][u64 dataLen][data]
 *
 * 纪律：
 * - **fail loud**：帧截断 / 未知 status / 尾部多余字节一律抛错——静默错位解出来的
 *   "内容"会挂到错的路径上，比读失败更坏；
 * - 不复制字节：`data` 是原帧 ArrayBuffer 上的 subarray 视图（帧是本进程独享的 IPC 产物，
 *   调用方立即解码消费，不做长期留存）。
 */

/** 帧内单文件状态码（与 Rust 侧 FRAME_STATUS_* 逐字对应） */
const STATUS_BY_CODE: Record<number, RawFileRead['status']> = {
  0: 'ok',
  1: 'not-found',
  2: 'read-error',
};

export function decodeReadFilesFrame(buf: ArrayBuffer): RawFileRead[] {
  const view = new DataView(buf);
  const need = (offset: number, bytes: number, what: string): void => {
    if (offset + bytes > buf.byteLength) {
      throw new Error(`read_files_raw 帧截断：解 ${what} 需要到 ${offset + bytes} 字节，帧长 ${buf.byteLength}`);
    }
  };
  need(0, 4, '文件数');
  let offset = 0;
  const count = view.getUint32(offset, true);
  offset += 4;

  const pathDecoder = new TextDecoder('utf-8');
  const out: RawFileRead[] = [];
  for (let i = 0; i < count; i++) {
    need(offset, 4, `第 ${i} 个文件的 pathLen`);
    const pathLen = view.getUint32(offset, true);
    offset += 4;
    need(offset, pathLen, `第 ${i} 个文件的 path`);
    const path = pathDecoder.decode(new Uint8Array(buf, offset, pathLen));
    offset += pathLen;

    need(offset, 4, `第 ${i} 个文件的 status`);
    const statusCode = view.getUint32(offset, true);
    offset += 4;
    const status = STATUS_BY_CODE[statusCode];
    if (status === undefined) {
      throw new Error(`read_files_raw 帧含未知 status：${statusCode}（第 ${i} 个文件 ${path}）`);
    }

    need(offset, 24, `第 ${i} 个文件的元数据头`);
    const mtimeMsRaw = view.getBigInt64(offset, true);
    offset += 8;
    const sizeRaw = view.getBigUint64(offset, true);
    offset += 8;
    const dataLen = Number(view.getBigUint64(offset, true));
    offset += 8;
    need(offset, dataLen, `第 ${i} 个文件的数据`);
    const data = new Uint8Array(buf, offset, dataLen);
    offset += dataLen;

    // 非 ok 的项：数值字段是帧里的占位（Rust 侧填 0），显式归 null——判据不猜
    out.push({
      path,
      status,
      mtimeMs: status === 'ok' ? Number(mtimeMsRaw) : null,
      size: status === 'ok' ? Number(sizeRaw) : null,
      data: status === 'ok' ? data : new Uint8Array(0),
    });
  }
  if (offset !== buf.byteLength) {
    throw new Error(`read_files_raw 帧尾部有多余字节：解到 ${offset}，帧长 ${buf.byteLength}`);
  }
  return out;
}
