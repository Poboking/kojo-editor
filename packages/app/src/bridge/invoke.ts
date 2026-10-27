/**
 * Tauri IPC 封装。
 * - 在 Tauri WebView 中走真实 IPC；
 * - 纯浏览器（vite dev 无壳）中默认调用即抛错——UI 会展示"需要桌面壳"提示；
 *   **例外**：页面选入了 web 调试模式（`?kojo-debug=1`，见 `debug/web-host-transport.ts`）
 *   时改走本机调试宿（`tools/debug-server.mjs`）——调试模式批（2026-10-24），
 *   动态 import 保证调试传输层不进开机图。
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    const { webHostInvokeIfActive } = await import('../debug/web-host-transport');
    const route = await webHostInvokeIfActive(cmd, args);
    if (route.active) return route.value as T;
    throw new Error(`Tauri IPC 不可用（当前为浏览器环境，命令：${cmd}）。请通过桌面壳运行。`);
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

/* ------------------------- 二进制 <-> base64 ------------------------- */

/** base64 字母表（标准带 padding，与 `btoa` 同口径） */
const B64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 纯 JS 的 base64 编码（**回退路径**）：查表 + 分块。旧写法 `btoa(String.fromCharCode(...))`
 * 36MB 实测 1,893ms，本实现同口径 **825ms**。导出是为了让单测钉住回退路径。
 */
export function encodeBase64Table(bytes: Uint8Array): string {
  const len = bytes.length;
  const parts: string[] = [];
  /** 每片 24KB 输入 → 32K 字符输出（片越小 GC 压力越小，越大拼接次数越少） */
  const CHUNK = 3 * 8192;
  for (let start = 0; start < len; start += CHUNK) {
    const end = Math.min(start + CHUNK, len);
    const out = new Array<string>(Math.ceil((end - start) / 3) * 4);
    let o = 0;
    let i = start;
    for (; i + 2 < end; i += 3) {
      const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      out[o++] = B64_TABLE[(v >> 18) & 63]!;
      out[o++] = B64_TABLE[(v >> 12) & 63]!;
      out[o++] = B64_TABLE[(v >> 6) & 63]!;
      out[o++] = B64_TABLE[v & 63]!;
    }
    const rest = end - i;
    if (rest === 1) {
      const v = bytes[i]! << 16;
      out[o++] = B64_TABLE[(v >> 18) & 63]!;
      out[o++] = B64_TABLE[(v >> 12) & 63]!;
      out[o++] = '=';
      out[o++] = '=';
    } else if (rest === 2) {
      const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
      out[o++] = B64_TABLE[(v >> 18) & 63]!;
      out[o++] = B64_TABLE[(v >> 12) & 63]!;
      out[o++] = B64_TABLE[(v >> 6) & 63]!;
      out[o++] = '=';
    }
    parts.push(out.join(''));
  }
  return parts.join('');
}

/**
 * 二进制 → base64。快照落盘全走这条路（索引 37MB + 条件 7.3MB + 其余 ~4MB），而
 * `write_file_bytes` 只收 base64 串 ⇒ 编码落在主线程。P0-2 冷开实测自报 **2,473ms**。
 * 36MB 实测：原生 `toBase64()`（Chromium 133+，现行 WebView2 有）**22ms**；否则退回
 * `encodeBase64Table` **825ms**。输出与旧实现逐字节相同 ⇒ 其余零改动。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  return encodeBase64Table(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (typeof native === 'function') return native.call(Uint8Array, b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
