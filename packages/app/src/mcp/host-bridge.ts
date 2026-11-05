/**
 * MCP WebView 桥（P0 契约 · 路 A，ADR-0013）。
 *
 * 职责：监听 Rust 投递的 `mcp://request` 事件 → 用契约 v1 的 `createMcpCapabilityRegistry`
 * 分派六种 method → 经 `mcp_respond` 回帧。Rust 侧只做线协议与授权闸门，能力语义全在
 * `@kojo/mcp-host`（路 B，零游戏名词）；本桥是**纯分派器**，不认游戏/能力知识、不改产品路径语义。
 *
 * 开机图纪律（ps10 闸 196 文件 / 3,553 KB）：`@kojo/mcp-host` 与 `./wiring` 都**只在首条
 * `mcp://request` 到达时动态 import**（由 `defaultRegistryFactory` 一并装载）——产品未启用
 * MCP 时两者零字节进图。bootstrap.ts 只保留一处 `void import('./mcp/host-bridge')` 登记
 * （同 debug-registry 形态），本模块顶层**只**用 `import type` 取冻结契约类型（纯类型、编译期
 * 擦除、零运行时边），不静态 import 任何运行时依赖（Tauri API 也走动态 import）。
 *
 * 三件套：取消（AbortSignal / 关闭流语义）、超时（默认 30s，可配）、返回体积上限。
 * 超时 / 超限 / 参数错 / 内部错一律回**显式 error 帧**（铁律 4：不静默）；主动取消不回帧
 * （客户端已断流）。`mcp_respond` 回帧失败也要出声，不假装送达。
 *
 * deps 装配：未注入 `options.deps`（生产默认）时，由 `defaultRegistryFactory` 在首条请求时
 * 动态 `import('./wiring')` 调 `createMcpHostDeps()` 组装真实 `McpHostDeps`；注入了 deps
 * （单测 seam / 显式装配）时直接用它，不碰 wiring。`./wiring` 不静态拉 Monaco / kernel 运行时。
 */

/* ------------------------------------------------------------------ *
 * 冻结契约 v1 的类型：全部走 `import type`（纯类型、编译期擦除、零运行时边）。
 * 真源是 `@kojo/mcp-host`；本桥不再维护本地结构投影（消灭 @ts-ignore 的那份临时物）。
 * ------------------------------------------------------------------ */
import type {
  McpHostDeps,
  McpCapabilityRegistry,
  McpSessionScope,
} from '@kojo/mcp-host';

// 从本桥再导出一份契约类型：既保住既有 `from './mcp/host-bridge'` 的调用点，
// 又让类型只有一处真源（`export type` 同样擦除，不进开机静态图）。
export type {
  McpHostDeps,
  McpCapabilityRegistry,
  McpSessionScope,
  McpTier,
} from '@kojo/mcp-host';

export type McpMethod =
  | 'tools/list'
  | 'tools/call'
  | 'resources/list'
  | 'resources/read'
  | 'prompts/list'
  | 'prompts/get';

export interface McpRequestEvent {
  readonly id: string;
  readonly method: McpMethod;
  readonly params: Record<string, unknown>;
  readonly scope: McpSessionScope;
}

/** `mcp_respond(args:{...})` 的单一 args 形参形状。 */
export interface McpRespondArgs {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/* ------------------------------------------------------------------ *
 * 注入 seam（无 Tauri / 无路 B 包也能对拍）
 * ------------------------------------------------------------------ */
export type Unlisten = () => void;

export interface McpBridgeTransport {
  listen(handler: (event: McpRequestEvent) => void): Promise<Unlisten>;
  respond(args: McpRespondArgs): Promise<void>;
}

export type McpRegistryFactory = (
  deps: McpHostDeps | undefined,
) => McpCapabilityRegistry | Promise<McpCapabilityRegistry>;

export interface McpHostBridgeOptions {
  transport?: McpBridgeTransport;
  /** 注入时用假注册表，绕开 `@kojo/mcp-host` 动态 import（测试 seam）。 */
  registryFactory?: McpRegistryFactory;
  /** `createMcpCapabilityRegistry(deps)` 的 deps；不注入时由 `./wiring` 在首条请求时组装。 */
  deps?: McpHostDeps;
  /** 请求超时（毫秒），默认 30_000。 */
  timeoutMs?: number;
  /** 返回体积上限（UTF-8 字节），默认 4 MiB。 */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 默认 transport：动态 import Tauri API，静态图零依赖。 */
const defaultTransport: McpBridgeTransport = {
  async listen(handler) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<McpRequestEvent>('mcp://request', (e) => handler(e.payload));
  },
  async respond(args) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('mcp_respond', { args });
  },
};

/**
 * 默认 registry 工厂（`createMcpCapabilityRegistry` 在此**动态 import**，绝不在模块顶层拉起）：
 * - 首条请求到达才把 `@kojo/mcp-host` 与 `./wiring` 一起动态装载 ⇒ 两者都不进 bootstrap
 *   开机静态图（ps10 闸）；`./wiring` 也不静态拖 Monaco / kernel 运行时。
 * - 注入了 deps（单测 seam / 显式装配）就直接用，不碰 wiring；未注入时用 wiring
 *   `createMcpHostDeps()` 组装真实 McpHostDeps（接不到真源的腿由 registry 显式报 NOT_WIRED /
 *   RESOURCE_UNAVAILABLE，不静默、不伪造读数）。
 */
async function defaultRegistryFactory(deps: McpHostDeps | undefined): Promise<McpCapabilityRegistry> {
  const hostPromise = import('@kojo/mcp-host');
  const wiringPromise = deps === undefined ? import('./wiring') : Promise.resolve(null);
  const [host, wiring] = await Promise.all([hostPromise, wiringPromise]);
  const realDeps: McpHostDeps = deps ?? wiring?.createMcpHostDeps() ?? {};
  return host.createMcpCapabilityRegistry(realDeps);
}

let transport: McpBridgeTransport = defaultTransport;
let registryFactory: McpRegistryFactory | null = null;
let registryDeps: McpHostDeps | undefined;
let timeoutMs = DEFAULT_TIMEOUT_MS;
let maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES;
let registryPromise: Promise<McpCapabilityRegistry> | null = null;
let unlisten: Unlisten | null = null;
const inFlight = new Map<string, AbortController>();

/** 懒装载注册表：首条请求到达才求值；失败清缓存以便下次重试（同 bootstrap 口径）。 */
function ensureRegistry(): Promise<McpCapabilityRegistry> {
  registryPromise ??= Promise.resolve()
    .then(() => (registryFactory ?? defaultRegistryFactory)(registryDeps))
    .catch((err: unknown) => {
      registryPromise = null;
      throw err;
    });
  return registryPromise;
}

/* ------------------------------------------------------------------ *
 * 错误与工具
 * ------------------------------------------------------------------ */
class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 结构化失败（`McpFailure` 及任何 `{code,message}` 形状）**原样保留 code**。
 *
 * registry 抛 `NOT_WIRED` / `PERMISSION_DENIED` / `INVALID_ARGS` / `RESOURCE_UNAVAILABLE`
 * 时，若一律包成 `mcp/internal`，客户端 `error.data.code` 只能看到 internal——
 * ADR-0013 §6 与铁律 4 要求的「失败显式 {code,message}」在桥这一层被抹掉了。
 * 这里按形状识别（不静态 import `@kojo/mcp-host`，保住开机图零运行时边），
 * `code` 过白名单正则才采信：WebView 回帧属不可信输入，脏码 / 控制字符 /
 * 超长串一律回落 `mcp/internal`，不让它进审计与 JSON-RPC 错误帧。
 */
const STRUCTURED_CODE_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,63}$/;

function bridgeErrorOf(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  if (err !== null && typeof err === 'object') {
    const { code, message } = err as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && STRUCTURED_CODE_RE.test(code) && typeof message === 'string') {
      return new BridgeError(code, message);
    }
  }
  return new BridgeError('mcp/internal', String(err));
}

/** 让「等待注册表结果」这一拍可被 AbortSignal 打断（契约方法本身不收 signal）。 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = () => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function respondError(id: string, code: string, message: string): Promise<void> {
  try {
    await transport.respond({ id, ok: false, error: { code, message } });
  } catch (err) {
    // 回帧失败也要出声（铁律 4），但不因二次失败把分派循环带崩
    console.warn('[mcp/host-bridge] mcp_respond 回 error 帧失败：', err);
  }
}

/* ------------------------------------------------------------------ *
 * 六种 method 分派
 * ------------------------------------------------------------------ */
async function dispatch(
  method: McpMethod,
  params: Record<string, unknown>,
  scope: McpSessionScope,
  registry: McpCapabilityRegistry,
): Promise<unknown> {
  switch (method) {
    case 'tools/list':
      return registry.listTools(scope);
    case 'resources/list':
      return registry.listResources();
    case 'prompts/list':
      return registry.listPrompts();
    case 'tools/call': {
      const name = asString(params.name ?? params.tool);
      if (name === null) throw new BridgeError('mcp/invalid-params', 'tools/call 缺少 name');
      return registry.callTool(name, asRecord(params.arguments ?? params.args), scope);
    }
    case 'resources/read': {
      const uri = asString(params.uri);
      if (uri === null) throw new BridgeError('mcp/invalid-params', 'resources/read 缺少 uri');
      return registry.readResource(uri, scope);
    }
    case 'prompts/get': {
      const name = asString(params.name);
      if (name === null) throw new BridgeError('mcp/invalid-params', 'prompts/get 缺少 name');
      return registry.getPrompt(name, asRecord(params.arguments ?? params.args), scope);
    }
    default:
      throw new BridgeError('mcp/method-not-found', `未知 method：${String(method)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 单条请求：取消 / 超时 / 体积上限
 * ------------------------------------------------------------------ */
async function handleRequest(event: McpRequestEvent): Promise<void> {
  const { id, method, params, scope } = event;
  const controller = new AbortController();
  inFlight.set(id, controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const registry = await ensureRegistry();
    const work = Promise.resolve().then(() => dispatch(method, params, scope, registry));
    const result = await raceAbort(work, controller.signal);
    if (controller.signal.aborted) {
      if (timedOut) await respondError(id, 'mcp/timeout', `MCP 请求超时（${timeoutMs}ms）`);
      return; // 主动取消：客户端已断流，不回帧
    }
    // 体积上限：以 UTF-8 JSON 序列化后的字节数为准（不可序列化也显式回错，不静默）
    let bytes: number;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(result) ?? 'null').length;
    } catch {
      await respondError(id, 'mcp/internal', '结果不可 JSON 序列化（BigInt / 循环引用）');
      return;
    }
    if (bytes > maxResponseBytes) {
      await respondError(
        id,
        'mcp/response-too-large',
        `返回体积 ${bytes} 字节超过上限 ${maxResponseBytes}`,
      );
      return;
    }
    await transport.respond({ id, ok: true, result });
  } catch (err) {
    if (controller.signal.aborted) {
      if (timedOut) await respondError(id, 'mcp/timeout', `MCP 请求超时（${timeoutMs}ms）`);
      return;
    }
    const e = bridgeErrorOf(err);
    await respondError(id, e.code, e.message);
  } finally {
    clearTimeout(timer);
    inFlight.delete(id);
  }
}

/* ------------------------------------------------------------------ *
 * 取消 / 关闭流语义（供 mcp_stop / 客户端断流时调用）
 * ------------------------------------------------------------------ */
/** 取消单条在途请求；返回是否命中。 */
export function cancelMcpRequest(id: string): boolean {
  const c = inFlight.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

/** 关闭流：abort 全部在途请求，返回被取消的条数。 */
export function cancelAllMcpRequests(): number {
  const n = inFlight.size;
  for (const c of inFlight.values()) c.abort();
  return n;
}

/* ------------------------------------------------------------------ *
 * 登记（bootstrap 只调这一处，照 debug-registry 的形态）
 * ------------------------------------------------------------------ */
/**
 * 登记 MCP 桥：订阅 `mcp://request`，返回立刻可用的取消句柄（与 launcher-bridge 的
 * subscribe 同形态——listen 是异步的，未订阅上就取消时等它落定立刻退订，不漏挂监听）。
 * 重复登记会先退订旧监听；`options` 里给到的项才覆盖（缺省保持既有值）。
 */
export function registerMcpHostBridge(options: McpHostBridgeOptions = {}): Unlisten {
  if (options.transport !== undefined) transport = options.transport;
  if (options.registryFactory !== undefined) registryFactory = options.registryFactory;
  if (options.deps !== undefined) registryDeps = options.deps;
  if (options.timeoutMs !== undefined) timeoutMs = options.timeoutMs;
  if (options.maxResponseBytes !== undefined) maxResponseBytes = options.maxResponseBytes;
  registryPromise = null; // 配置可能变了，注册表重算

  unlisten?.();
  unlisten = null;
  let cancelled = false;
  void Promise.resolve()
    .then(() => transport.listen((event) => void handleRequest(event)))
    .then((off) => {
      if (cancelled) off();
      else unlisten = off;
    })
    .catch((err: unknown) => {
      // 同步签名里没法把订阅失败抛回调用方；出声但不假装订阅成功
      console.warn('[mcp/host-bridge] 订阅 mcp://request 失败：', err);
    });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}
