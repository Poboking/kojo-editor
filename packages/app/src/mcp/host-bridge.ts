/**
 * MCP WebView 桥（P0 契约 · 路 A，ADR-0013）。
 *
 * 职责：监听 Rust 投递的 `mcp://request` 事件 → 用契约 v1 的 `createMcpCapabilityRegistry`
 * 分派六种 method → 经 `mcp_respond` 回帧。Rust 侧只做线协议与授权闸门，能力语义全在
 * `@kojo/mcp-host`（路 B，零游戏名词）；本桥是**纯分派器**，不认游戏/能力知识、不改产品路径语义。
 *
 * 开机图纪律（ps10 闸 196 文件 / 3,553 KB）：`createMcpCapabilityRegistry` **必须动态 import**，
 * 且只在**首条 `mcp://request` 到达时**才装载——产品未启用 MCP 时该包零字节进图。
 * bootstrap.ts 只加一处 `void import('./mcp/host-bridge')` 登记（同 debug-registry 形态），
 * 本模块自身不静态 import 任何运行时依赖（Tauri API 也走动态 import）。
 *
 * 三件套：取消（AbortSignal / 关闭流语义）、超时（默认 30s，可配）、返回体积上限。
 * 超时 / 超限 / 参数错 / 内部错一律回**显式 error 帧**（铁律 4：不静默）；主动取消不回帧
 * （客户端已断流）。`mcp_respond` 回帧失败也要出声，不假装送达。
 *
 * 集成接线（主 agent）：路 B 的 `@kojo/mcp-host` 到位后，需在 app 的 tsconfig.paths 与
 * vite.config.ts 的 resolve.alias 补该包别名，并通过 `registerMcpHostBridge({ deps })` 注入
 * `createMcpCapabilityRegistry` 所需的 deps（本路不可改 tsconfig / vite.config / package.json）。
 */

/* ------------------------------------------------------------------ *
 * 契约 v1 的**本地结构投影**（不静态 import @kojo/mcp-host：
 * 该包由路 B 提供、本工作树尚未到位；静态/类型 import 会触发 TS2307 且把包拖进开机图）。
 * 字段名与冻结契约逐字一致；集成到位后可换成 `import type` 而不改任何调用点。
 * ------------------------------------------------------------------ */
export type McpTier = 'read' | 'edit' | 'privileged';

export interface McpSessionScope {
  readonly sessionId: string;
  readonly clientId: string;
  readonly tier: McpTier;
  readonly approvedRoots: readonly string[];
  readonly approvedTools: readonly string[];
}

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

/** `McpCapabilityRegistry` 的最小投影：六种 method 恰好一一对应。 */
export interface McpCapabilityRegistry {
  listTools(scope: McpSessionScope): readonly unknown[];
  listResources(): readonly unknown[];
  listPrompts(): readonly unknown[];
  callTool(name: string, args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
  readResource(uri: string, scope: McpSessionScope): Promise<unknown>;
  getPrompt(name: string, args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
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
  deps: unknown,
) => McpCapabilityRegistry | Promise<McpCapabilityRegistry>;

export interface McpHostBridgeOptions {
  transport?: McpBridgeTransport;
  /** 注入时用假注册表，绕开 `@kojo/mcp-host` 动态 import（测试 / 未到位前）。 */
  registryFactory?: McpRegistryFactory;
  /** `createMcpCapabilityRegistry(deps)` 的 deps；形状由路 B 定，集成时注入。 */
  deps?: unknown;
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

/** 默认 registry 工厂：`createMcpCapabilityRegistry` 在此**动态 import**，绝不在模块顶层拉起。 */
async function defaultRegistryFactory(deps: unknown): Promise<McpCapabilityRegistry> {
  // @ts-ignore —— @kojo/mcp-host 由路 B 提供；集成时主 agent 补 tsconfig / vite alias（本路不可改）。
  const mod = (await import('@kojo/mcp-host')) as {
    createMcpCapabilityRegistry(deps: unknown): McpCapabilityRegistry;
  };
  return mod.createMcpCapabilityRegistry(deps);
}

let transport: McpBridgeTransport = defaultTransport;
let registryFactory: McpRegistryFactory | null = null;
let registryDeps: unknown = {};
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
    const e = err instanceof BridgeError ? err : new BridgeError('mcp/internal', String(err));
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
