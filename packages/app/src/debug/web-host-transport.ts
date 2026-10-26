/**
 * Web 调试宿传输层（2026-10-24 调试模式批）。
 *
 * 目标：让编辑器在**纯浏览器**里跑完整功能——不用真桌面壳，也不用改任何产品代码的
 * 语义。`bridge/invoke.ts` 在非 Tauri 环境原先只有一条死路（抛「需要桌面壳」）；
 * 现在多一条**显式选入**的路：页面带 `?kojo-debug=1`（或 localStorage 种了
 * `kojoDebugHost`）时，全部宿主命令改走本机调试宿（`tools/debug-server.mjs`，
 * HTTP POST /invoke）。没有选入时行为与从前逐字一致。
 *
 * 选型记一笔：不走 WebSocket——invoke 是一问一答，SSE 足够承载宿主推送
 * （文件监视事件），两边都只用平台原生 API（fetch / EventSource），零依赖。
 *
 * 安全面：调试宿只绑 127.0.0.1、写路径有沙盒闸（见 tools/debug-server.mjs 头注）；
 * 页面侧不增任何权限——它只是把「原本要经 Tauri IPC 的调用」换个信封送到本机调试宿。
 */

/** 二进制命令的应答信封：宿主命令里唯二回二进制的（`read_file_bytes_raw` / `read_files_raw`） */
const BINARY_COMMANDS = new Set(['read_file_bytes_raw', 'read_files_raw']);

export interface WebHostConfig {
  /** 调试宿 origin（如 `http://127.0.0.1:17777`），尾不带斜杠 */
  readonly origin: string;
}

const DEFAULT_ORIGIN = 'http://127.0.0.1:17777';
const STORAGE_KEY = 'kojoDebugHost';

/**
 * 解析调试宿配置（纯函数，可单测）。
 *
 * 优先级：URL `kojo-debug` 参数（`1` / `true` = 默认 origin；`api` = **只装调试面、
 * 不切 web 宿路由**——真桌面壳里用，invoke 仍走真 Tauri IPC；否则按 origin 解析，
 * 支持 `17777` 端口号形态）> localStorage `kojoDebugHost`。都没有 ⇒ null（不选入）。
 */
export function resolveWebHostConfig(search: string, storage: string | null): WebHostConfig | null {
  const params = new URLSearchParams(search);
  if (!params.has('kojo-debug')) {
    if (storage && storage.trim() !== '') {
      return { origin: normalizeOrigin(storage) ?? DEFAULT_ORIGIN };
    }
    return null;
  }
  const raw = (params.get('kojo-debug') ?? '').trim();
  if (raw === '' || raw === '1' || raw === 'true') return { origin: DEFAULT_ORIGIN };
  if (raw === 'api') return null; // 调试面 only：`main.tsx` 见 kojo-debug 键即装载，宿路由不接
  return { origin: normalizeOrigin(raw) ?? DEFAULT_ORIGIN };
}

/** `17777` / `127.0.0.1:17777` / `http://127.0.0.1:17777` → 规范 origin；非法 ⇒ null */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '');
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.[\]-]+:\d+$/.test(s)) return `http://${s}`;
  return null;
}

let activeConfig: WebHostConfig | null | undefined;

/** 当前页面的调试宿配置（懒解析一次缓存；undefined = 还没解析过） */
function config(): WebHostConfig | null {
  if (activeConfig === undefined) {
    activeConfig =
      typeof window === 'undefined'
        ? null
        : resolveWebHostConfig(window.location.search, window.localStorage.getItem(STORAGE_KEY));
  }
  return activeConfig;
}

/** 是否选入了 web 调试宿（供调试面自报 mode；invoke 路由不经过它，直接问 config()） */
export function webHostActive(): boolean {
  return config() !== null;
}

/** 供调试面回显：选入的 origin（未选入 ⇒ null） */
export function webHostOrigin(): string | null {
  return config()?.origin ?? null;
}

/* ----------------------------- invoke 通道 ----------------------------- */

export type WebHostRoute =
  | { readonly active: false }
  | { readonly active: true; readonly value: unknown };

/**
 * 非桌面壳时的 invoke 路由（`bridge/invoke.ts` 调）。
 *
 * - 未选入 ⇒ `{active:false}`，调用方维持既有报错口径；
 * - 选入但调试宿连不上 ⇒ **抛错**（不静默回退成「需要桌面壳」——那会把「宿没起」
 *   这件事藏起来，铁律 4 的可见性同样适用于调试通道）；
 * - 命令本身失败 ⇒ 原样抛宿主侧错误文本（与 Tauri invoke 抛错同消费口径）。
 */
export async function webHostInvokeIfActive(cmd: string, args?: Record<string, unknown>): Promise<WebHostRoute> {
  const cfg = config();
  if (!cfg) return { active: false };
  return { active: true, value: await webHostInvoke(cmd, args) };
}

/**
 * 直连调试宿的一条 invoke（调试面 `__kojoDebug.invoke` 用；不做 active 判定）。
 *
 * 二进制命令（`read_file_bytes_raw` / `read_files_raw`）带 `?binary=1`：宿回
 * `application/octet-stream` 原始帧/字节，页面直接 `arrayBuffer()`——省掉 base64 的
 * 1.33× 膨胀与逐字节还原（2026-10-26 性能批）。旧宿不认这个参数、仍回 JSON 信封，
 * 这里按 content-type 回退到 `decodeValue`，两侧可独立升级。
 */
export async function webHostInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const cfg = config();
  if (!cfg) throw new Error('web 调试宿未选入（缺 ?kojo-debug=1）');
  const binary = BINARY_COMMANDS.has(cmd);
  let res: Response;
  try {
    res = await fetch(`${cfg.origin}/invoke${binary ? '?binary=1' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
  } catch (err) {
    throw new Error(
      `web 调试宿连接失败（${cfg.origin}，命令 ${cmd}）：${errText(err)}——先起宿：node tools/debug-cli.mjs serve`,
    );
  }
  if (binary && (res.headers.get('content-type') ?? '').includes('application/octet-stream')) {
    return res.arrayBuffer();
  }
  let body: { ok?: boolean; value?: unknown; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`web 调试宿应答不是 JSON（${cfg.origin}/invoke，HTTP ${res.status}）`);
  }
  if (!body.ok) {
    throw new Error(body.error ?? `web 调试宿命令失败（${cmd}，HTTP ${res.status}）`);
  }
  return decodeValue(cmd, body.value);
}

/**
 * 二进制信封解码：宿把 ArrayBuffer 类应答装成 `{ __b64 }` 过 JSON，
 * 这里还原成 ArrayBuffer——`tauri-bridge` 的两个批量读命令拿到的形态
 * 与 Tauri IPC 下逐字一致（后续 `decodeReadFilesFrame` 无需感知传输层）。
 */
export function decodeValue(cmd: string, value: unknown): unknown {
  if (!BINARY_COMMANDS.has(cmd)) return value;
  if (value === null || typeof value !== 'object' || !('__b64' in value) || typeof (value as { __b64?: unknown }).__b64 !== 'string') {
    throw new Error(`web 调试宿应答缺二进制信封（命令 ${cmd}）`);
  }
  return base64ToArrayBuffer((value as { __b64: string }).__b64);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/* ----------------------------- 事件通道（SSE） ----------------------------- */

type HostEventHandler = (payload: unknown) => void;
const eventHandlers = new Map<string, Set<HostEventHandler>>();
let eventSource: EventSource | null = null;
let eventSourceRef = 0;

/**
 * 订阅调试宿推送事件（当前只有文件监视的 `kojo:fs-changed` / `kojo:fs-watch-error`，
 * 事件名与 Tauri 桌面壳同字面——`tauri-bridge.watchDirs` 的浏览器腿用它对齐桌面行为）。
 *
 * 首个订阅者到达才建 EventSource（跨 origin：调试宿带 CORS 头）；连接中断时
 * EventSource 自动重连，期间事件丢失可见于宿侧日志（内核对 watch 事件本就有
 * 去抖与全量重列兜底）。返回退订函数。
 */
export function onWebHostEvent(name: string, handler: HostEventHandler): () => void {
  let set = eventHandlers.get(name);
  if (!set) {
    set = new Set();
    eventHandlers.set(name, set);
  }
  set.add(handler);
  ensureEventSource();
  return () => {
    set.delete(handler);
  };
}

function ensureEventSource(): void {
  if (eventSource || typeof EventSource === 'undefined') return;
  const cfg = config();
  if (!cfg) return;
  const src = new EventSource(`${cfg.origin}/events`);
  const myRef = ++eventSourceRef;
  eventSource = src;
  src.onmessage = () => {};
  // 调试宿按事件名分派（`event: kojo:fs-changed`），未具名事件忽略
  for (const name of ['kojo:fs-changed', 'kojo:fs-watch-error', 'kojo:debug-notice']) {
    src.addEventListener(name, (ev) => {
      if (eventSourceRef !== myRef) return;
      let payload: unknown = null;
      try {
        payload = JSON.parse((ev as MessageEvent).data as string);
      } catch {
        payload = (ev as MessageEvent).data;
      }
      for (const h of eventHandlers.get(name) ?? []) h(payload);
    });
  }
  src.onerror = () => {
    // EventSource 会自动重连；这里只做清理记账（onerror 在正常关闭时也会来一次）
    if (eventSourceRef !== myRef) return;
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
