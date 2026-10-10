/**
 * 存档容器组装（serializePayload 的容器层 complement；游戏无关）。
 *
 * 文件布局（与 parse.ts 逐字段对称）：
 *   16 字节明文头：魔数（8B）+ 格式版本 u32 + 保留 u32（恒 0）
 *   正文：gzip（CompressionStream，跨 Node/WebView，不 import node:zlib）
 *         或裸字节（与原档格式保持一致）
 *
 * 与 gunzip.ts 同款环境纪律：插件运行在 Tauri WebView（浏览器环境），
 * 统一走 Web 标准 CompressionStream（Node 18+ / Chromium 均可用）。
 */

import type { ArchiveContainerFormat } from '@kojo/plugin-api';
import { ArchiveParseError } from './binary';

export const FORMAT_VERSION = 1808;
export const MAGIC_GZIP = 0x0a50495a41524589n;
export const MAGIC_RAW = 0x0a1a0a0d41524589n;

/** 压缩一个完整 gzip 流为字节（对齐引擎容器格式） */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // 复制到独立的 ArrayBuffer 支撑数组：DOM 与 Node 两套 Blob 类型定义下均满足 BlobPart
  const copy = new Uint8Array(bytes);
  const src = new Blob([copy]).stream();
  const deflated = src.pipeThrough(new CompressionStream('gzip'));
  const ab = await new Response(deflated).arrayBuffer();
  return new Uint8Array(ab);
}

/** 魔数 → 容器格式（parse 侧同表） */
export function magicFor(format: ArchiveContainerFormat): bigint {
  return format === 'gzip' ? MAGIC_GZIP : MAGIC_RAW;
}

/**
 * 组装完整存档文件：16 字节明文头 + 正文（容器格式沿用原档——gzip 档写回
 * 仍是 gzip，raw 档写回仍是 raw；gzip 压缩流不要求逐字节还原，读侧解压即同）。
 */
export async function assembleArchiveFile(
  payload: Uint8Array,
  format: ArchiveContainerFormat,
): Promise<Uint8Array> {
  const body = format === 'gzip' ? await gzipBytes(payload) : payload;
  const out = new Uint8Array(16 + body.length);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, magicFor(format), true);
  dv.setUint32(8, FORMAT_VERSION, true);
  // out[12..16] 保留字段恒 0（Uint8Array 初始化即全零）
  out.set(body, 16);
  return out;
}

/** 仅供错误消息使用：payload 非法时提前抛（防御性，调用方一般不会触发） */
export function assertPayloadNonEmpty(payload: Uint8Array): void {
  if (payload.length === 0) {
    throw new ArchiveParseError('载荷为空，拒绝组装容器（会产出损坏存档）', 0);
  }
}
