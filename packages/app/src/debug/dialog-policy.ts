/**
 * 调试面「目录对话框自动应答」policy（2026-10-26 era-pair 批，PITFALLS 230 的修法）。
 *
 * 事实：真桌面壳里目录选择是**原生对话框**，CDP 应答不了；web 模式早有 policy 应答腿
 * （`tools/debug-server.mjs` 的 `choose_directory` + `POST /policy`），缺的是真壳那条腿。
 * 旧退化形态「点最近项目第一行」不读传入路径，是假绿之源（PITFALLS 230 实测）。
 *
 * 裁决（为什么是 fetch 腿、为什么不选别的缝）：
 * - `window.__TAURI_INTERNALS__.invoke / ipc / postMessage` 全是 `Object.defineProperty(value)`
 *   （tauri 2.12.2 `scripts/core.js` / `ipc.js` / `ipc-protocol.js` 实拍，writable/configurable 皆
 *   false）——monkey-patch 不上（本仓 PITFALLS §二有同条实测）；
 * - Windows 桌面壳的 IPC 出口是 `fetch('http(s)://ipc.localhost/<cmd>')`（ipc-protocol.js 的
 *   custom-protocol 腿；`window.ipc.postMessage` 兜底腿是 defineProperty+freeze，同样不可包）。
 *   `window.fetch` 可写 ⇒ 只在调试面装载时包一层**定向**拦截：armed 且请求正是
 *   `choose_directory` 时不送达原生，以合成 Response 兑现既有回调链；其余请求逐字节透传；
 * - 只应答**目录选择（打开＝读）**。`export_file` / `choose_file` / `choose_workspace_root` 与
 *   Rust 写域准入门一个字节不碰：准入门（铁律 6/7）只认真实对话框交付，经本通道打开的项目
 *   天然只能只读浏览——写审批走不通是**如实行为**，CLI 在 shell 模式直接拒 `--writable`；
 * - 一次性（命中即清）、未 armed 零触扰；装载前提是 `?kojo-debug` 选入（main.tsx 动态 import），
 *   产品路径零语义变化（§五.1）。web 模式的宿腿（POST /policy）照旧；页面级 policy 在场时
 *   由 `webHostInvoke` 先一次性短路（§五.11 的冒烟断言即用这条腿）。
 */

export interface DialogPolicyArmed {
  readonly armed: boolean;
  readonly value: string | null;
}

export interface DialogPolicyHit {
  readonly hit: boolean;
  readonly value?: string | null;
}

let armed: { value: string | null } | null = null;

/** 置一次性应答（`null`＝模拟取消）；重复 arm 覆盖旧值——后 arm 者生效 */
export function armChooseDir(value: string | null): void {
  armed = { value };
}

export function armedChooseDir(): DialogPolicyArmed {
  return armed ? { armed: true, value: armed.value } : { armed: false, value: null };
}

export function clearChooseDir(): void {
  armed = null;
}

/** 命中即取走并清空（一次性）；未 armed 恒 miss（透传零触扰） */
export function consumeChooseDir(): DialogPolicyHit {
  if (!armed) return { hit: false };
  const value = armed.value;
  armed = null;
  return { hit: true, value };
}

/**
 * 桌面壳 custom-protocol IPC 腿的 URL 形态（ipc-protocol.js 用 convertFileSrc(cmd,'ipc') 造）：
 * `http(s)://ipc.localhost/<encodeURIComponent(cmd)>`。其余一切 URL（调试宿 /invoke、
 * 页面正常网络请求、非法串）⇒ null＝透传，绝不吃错请求。
 */
export function parseIpcCmd(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.hostname !== 'ipc.localhost' || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  try {
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return null; // 百分号编码畸形 ⇒ 不是我们造的 URL ⇒ 透传
  }
}

/**
 * 与 ipc-protocol.js 消费链逐字对齐的应答：`Tauri-Response: ok` 让请求方选 callback 而非 error，
 * `application/json` 体经 `response.json()` 后由既有链 `runCallback(callbackId, data)` 兑现
 * invoke 的 Promise——本模块不触 `__TAURI_INTERNALS__` 的任何私有面。
 */
export function buildChooseDirResponse(value: string | null): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' },
  });
}

let shellFetchWrapped = false;

export function shellDialogInterceptStatus(): { readonly wrapped: boolean } {
  return { wrapped: shellFetchWrapped };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 真壳拦截腿（幂等）：包 `window.fetch` 一次，只定向 `ipc.localhost/choose_directory` 的 POST
 * 请求（且 policy 已 armed）。拦截腿自身出任何异常 ⇒ **原样放行**（绝不吃请求）并留痕；
 * 若 custom-protocol 被平台拦、Tauri 回退 `window.ipc.postMessage` 腿，本拦截不生效——
 * 对话框会真的弹出来，CLI 侧等待超时如实红（不静默假绿）。
 */
export function installShellDialogIntercept(
  notice: (msg: string) => void,
): { wrapped: boolean; reason?: string } {
  if (shellFetchWrapped) return { wrapped: true };
  const w: Record<string, unknown> | undefined = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : undefined;
  if (!w || !('__TAURI_INTERNALS__' in w)) {
    return { wrapped: false, reason: 'window.__TAURI_INTERNALS__ 不在场（真壳 fetch 腿只装进桌面壳；web 模式的应答走调试宿 policy）' };
  }
  const original = w.fetch;
  if (typeof original !== 'function') return { wrapped: false, reason: 'window.fetch 不是函数（无包点）' };
  if ((original as { __kojoDebugDialog?: boolean }).__kojoDebugDialog === true) {
    shellFetchWrapped = true; // 调试面重装（导航后同页复用）时幂等
    return { wrapped: true };
  }
  const origFetch = original as FetchLike;
  const wrapper: FetchLike = (input, init) => {
    try {
      if (armed) {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        const method = String(init?.method ?? (input as Request | undefined)?.method ?? 'GET');
        const headers = init?.headers ?? (input as Request | undefined)?.headers;
        const cb =
          headers && typeof (headers as Headers).get === 'function'
            ? (headers as Headers).get('Tauri-Callback')
            : null;
        if (method.toUpperCase() === 'POST' && cb && parseIpcCmd(url) === 'choose_directory') {
          const hit = consumeChooseDir(); // 一次性：兑现即清
          if (hit.hit) {
            notice(`choose_directory 由调试面 policy 应答（一次性）：${JSON.stringify(hit.value ?? null)}`);
            return Promise.resolve(buildChooseDirResponse(hit.value ?? null));
          }
        }
      }
    } catch (err) {
      notice(`choose_directory 拦截异常（原样放行，不静默）：${String((err as Error)?.message ?? err)}`);
    }
    return origFetch.call(w as unknown as typeof globalThis, input, init);
  };
  (wrapper as unknown as { __kojoDebugDialog: boolean }).__kojoDebugDialog = true;
  try {
    w.fetch = wrapper;
  } catch (err) {
    return { wrapped: false, reason: `window.fetch 不可写（${String((err as Error)?.message ?? err)}）——拦截腿无法就位` };
  }
  shellFetchWrapped = true;
  return { wrapped: true };
}
