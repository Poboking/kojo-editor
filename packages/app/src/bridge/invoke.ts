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

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
