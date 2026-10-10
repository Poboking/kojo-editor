/**
 * gzip 解压（跨运行环境）。
 *
 * 刻意**不**从 node:zlib 导入——插件运行在 Tauri WebView（浏览器环境），
 * 统一走 Web 标准 DecompressionStream（Node 18+ / Chromium 均可用）。
 */

/**
 * 解压一个完整 gzip 流为字节。
 * 对损坏数据会抛错（由调用方决定降级策略——扫描场景记入条目 error，不静默）。
 */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // 复制到独立的 ArrayBuffer 支撑数组：DOM 与 Node 两套 Blob 类型定义下均满足 BlobPart
  const copy = new Uint8Array(bytes);
  const compressed = new Blob([copy]).stream();
  const inflated = compressed.pipeThrough(new DecompressionStream('gzip'));
  const ab = await new Response(inflated).arrayBuffer();
  return new Uint8Array(ab);
}
