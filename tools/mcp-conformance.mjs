#!/usr/bin/env node
/**
 * kojo MCP 端到端协议一致性 harness（路 B3 · POOL-HANDOFF §3.2 · ADR-0013）。
 *
 * 定位：回环「协议对拍靶」。`http.createServer` 只 bind 127.0.0.1 + 动态端口，按
 * Streamable HTTP（单端点 `POST /mcp`）实现 MCP 协议面，然后 `spawn('node', ['tools/kojo-mcp.mjs'])`
 * 驱动**真实 stdio shim** 逐条对拍，输出 PASS/FAIL 表。
 *
 * 两条对拍通道：
 *  - `direct-http`（H01..H31）：node:http 直打 mock endpoint，钉协议语义（initialize 形状 /
 *    tier 过滤 / batch / 错误帧 / Bearer / Origin / SSE / Accept 协商 / 单端点 POST）。
 *  - `stdio-shim`（S01..S15）：真 shim 进程逐行喂 JSON-RPC，钉端到端转发语义（privileged 默认
 *    不可见 / notification 与 batch 不挂住 stdio / SSE 逐帧转发 / 坏帧显式终结 exit 4）。
 *
 * 三道闸在本 mock 上同样示范，缺一不可：①仅回环 127.0.0.1 ②Bearer token ③Origin 白名单。
 * 闸序：路径 404 → method 405 → Origin 403 → Bearer 401 → body 400(-32700) → 分派。
 *
 * **mock 只是协议对拍靶，不伪装能力真源、不写任何项目文件**：所有工具名带 `mock.` 前缀、
 * 资源 URI 用 `mock://` scheme、serverInfo 自报 mock、无执行体的工具显式 MOCK_NO_EXECUTOR
 * 拒绝（绝不空串冒充成功）。本文件零外部 npm 依赖、零 fs import（结构上不可能写盘）。
 *
 * token 纪律：token 由运行时生成（--self-test）或调用方注入，**不进 stdout / stderr /
 * 对拍表 / 任何日志**；mock 的请求记录只记 `hasAuth/authOk` 布尔，不记 token 值；每行输出
 * 渲染前过 scrub，命中 token 字面量即判 FAIL 并遮蔽。
 *
 * 用法：
 *   node tools/mcp-conformance.mjs --self-test   # 全量对拍，全过 exit 0，任一失败 exit 1 + stderr 可执行提示
 *   node tools/mcp-conformance.mjs --json        # 结果 JSON（供工具消费）
 *   node tools/mcp-conformance.mjs               # 打印用法
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import * as path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIM_PATH = path.join(REPO_ROOT, 'tools', 'kojo-mcp.mjs');
const HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

/** MCP 2026-07-28（ADR-0013）：无状态、按请求协商能力、兼容旧握手。 */
export const PROTOCOL_VERSION = '2026-07-28';

/** mock 资源文本上限（字符）；超限截断并显式 truncated。 */
export const RES_TEXT_LIMIT = 1000;

/* ------------------------------------------------------------------ *
 * mock 靶面：工具 / 资源 / prompt 清单（全部带 mock 前缀，协议靶，非能力真源）
 * ------------------------------------------------------------------ */

export const MOCK_TOOLS = Object.freeze([
  {
    name: 'mock.read.tool',
    description: 'mock read probe (conformance target only; executes a canned reply, touches nothing)',
    inputSchema: { type: 'object', properties: {} },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mock.echo.tool',
    description: 'mock echo probe (conformance target only; echoes arguments back)',
    inputSchema: { type: 'object', properties: { payload: { type: 'string' } } },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mock.fail.tool',
    description: 'mock failing probe (conformance target only; always returns a structured error)',
    inputSchema: { type: 'object', properties: {} },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mock.edit.tool',
    description: 'mock edit probe (conformance target only; writes nothing)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    tier: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'mock.priv.tool',
    description: 'mock privileged probe (conformance target only; dangerous by tier, approved via 4th table)',
    inputSchema: { type: 'object', properties: {} },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]);

export const MOCK_RESOURCES = Object.freeze([
  { uri: 'mock://res/small', name: 'small', description: 'mock small resource', mimeType: 'application/json' },
  { uri: 'mock://res/big', name: 'big', description: 'mock resource exceeding the truncation cap', mimeType: 'text/plain' },
]);

export const MOCK_PROMPTS = Object.freeze([
  {
    name: 'mock.prompt',
    description: 'mock prompt (conformance target only)',
    arguments: [{ name: 'topic', description: 'echoed into the message body', required: true }],
  },
]);

const BIG_TEXT = 'MOCKBIG.'.repeat(250); // 2000 chars > RES_TEXT_LIMIT

const TIER_RANK = { read: 0, edit: 1, privileged: 2 };

/* ------------------------------------------------------------------ *
 * JSON-RPC 帧构造
 * ------------------------------------------------------------------ */

function okFrame(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorFrame(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/* ------------------------------------------------------------------ *
 * mock endpoint
 * ------------------------------------------------------------------ */

/**
 * 起 mock MCP endpoint。
 * @param {{ sessions?: Map<string, {tier: string, approvedTools: string[]}> | object, resTextLimit?: number }} opts
 *   sessions：token → 会话 scope（tier + approvedTools），语义同 McpSessionScope（冻结契约 v1）。
 * @returns mock 实例：port / url / origin / requests / notifCount / batchCount / listen() / close()。
 *   requests：请求摘要（method/url/origin/accept/hasAuth/authOk/batch/…），**绝不含 token 值**。
 */
export function createMockEndpoint(opts = {}) {
  const sessions = opts.sessions instanceof Map ? opts.sessions : new Map(Object.entries(opts.sessions ?? {}));
  const resTextLimit = opts.resTextLimit ?? RES_TEXT_LIMIT;
  const requests = [];
  let notifCount = 0;
  let batchCount = 0;

  const server = http.createServer((req, res) => {
    const record = {
      method: req.method,
      url: req.url,
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
      accept: typeof req.headers.accept === 'string' ? req.headers.accept : null,
      hasAuth: typeof req.headers.authorization === 'string',
      authOk: false,
      batch: false,
      notificationOnly: false,
      status: 0,
      at: Date.now(),
    };
    requests.push(record);

    const replyJson = (status, obj, extraHeaders = {}) => {
      record.status = status;
      const body = obj === undefined ? '' : JSON.stringify(obj);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        ...(body === '' ? {} : { 'content-length': Buffer.byteLength(body) }),
        ...extraHeaders,
      });
      res.end(body);
    };

    // ① 路径闸：单端点 POST /mcp
    if (req.url !== MCP_PATH) {
      return replyJson(404, { error: { code: 'NOT_FOUND', message: `unknown path ${String(req.url)}; single endpoint POST /mcp only` } });
    }
    // ② method 闸：无状态 Streamable HTTP，不提供 GET 服务器流
    if (req.method !== 'POST') {
      return replyJson(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'single-endpoint POST /mcp only (stateless); GET server-stream not supported' } }, { allow: 'POST' });
    }
    // ③ Origin 白名单（防 DNS rebinding / 浏览器冒用）——三道闸之一
    const allowedOrigin = `http://${HOST}:${server.address().port}`;
    if (req.headers.origin !== allowedOrigin) {
      return replyJson(403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'origin not in allowlist' } });
    }
    // ④ Bearer token（三道闸之二）：按 token 查会话 scope
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    const session = m ? sessions.get(m[1]) : undefined;
    if (!session) {
      return replyJson(
        401,
        { error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } },
        { 'www-authenticate': 'Bearer realm="kojo-mcp-mock", error="invalid_token"' },
      );
    }
    record.authOk = true;

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let msgs;
      try {
        msgs = JSON.parse(body);
      } catch (err) {
        return replyJson(400, errorFrame(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`));
      }

      const wantsSSE = /text\/event-stream/i.test(String(req.headers.accept ?? ''));
      if (Array.isArray(msgs)) {
        record.batch = true;
        batchCount++;
        const responses = [];
        for (const item of msgs) {
          const r = handleOne(item, session);
          if (r) responses.push(r);
        }
        // batch 语义：notification 不回帧；全 notification ⇒ 202 空体
        if (responses.length === 0) {
          record.notificationOnly = true;
          record.status = 202;
          res.writeHead(202, { 'content-length': 0 });
          return res.end();
        }
        return respondFrames(res, record, wantsSSE, responses);
      }

      const single = handleOne(msgs, session);
      if (!single) {
        // 纯 notification（无 id）：202 无正文，绝不伪造响应帧
        notifCount++;
        record.notificationOnly = true;
        record.status = 202;
        res.writeHead(202, { 'content-length': 0 });
        return res.end();
      }
      return respondFrames(res, record, wantsSSE, [single]);
    });
  });

  /** 单条 JSON-RPC 消息分派；notification 返回 null（不回包）。 */
  function handleOne(msg, session) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return errorFrame(null, -32600, 'Invalid Request: 期望单个 JSON-RPC 2.0 对象');
    }
    const id = msg.id;
    const isNotif = id === undefined || id === null;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};

    switch (method) {
      case 'initialize':
        return okFrame(id, initializeResult(params));
      case 'notifications/initialized':
        return null;
      case 'ping':
        return okFrame(id, {});
      case 'tools/list':
        return okFrame(id, { tools: listTools(session) });
      case 'tools/call':
        return isNotif ? null : callTool(id, params, session);
      case 'resources/list':
        return okFrame(id, { resources: MOCK_RESOURCES });
      case 'resources/read':
        return isNotif ? null : readResource(id, params);
      case 'prompts/list':
        return okFrame(id, { prompts: MOCK_PROMPTS });
      case 'prompts/get':
        return isNotif ? null : getPrompt(id, params);
      default:
        // 未知通知不回帧；未知请求 -32601
        return isNotif ? null : errorFrame(id, -32601, `Method not found: ${method || '(missing method)'}`, { code: 'METHOD_NOT_FOUND' });
    }
  }

  /** tier 过滤：read 会话只见 read；edit 会话加 edit；privileged 才见全部。危险工具默认缺席。 */
  function listTools(session) {
    return MOCK_TOOLS.filter((t) => TIER_RANK[t.tier] <= TIER_RANK[session.tier]).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
  }

  function callTool(id, params, session) {
    const name = typeof params?.name === 'string' ? params.name : '';
    if (name === '') {
      return errorFrame(id, -32602, 'tools/call 缺 params.name（string）', { code: 'INVALID_ARGS' });
    }
    const spec = MOCK_TOOLS.find((t) => t.name === name);
    if (!spec) {
      return errorFrame(id, -32602, `Unknown tool: ${name}`, { code: 'UNKNOWN_TOOL' });
    }
    // tier 闸：拒绝要可见，不静默过滤
    if (TIER_RANK[spec.tier] > TIER_RANK[session.tier]) {
      return errorFrame(id, -32000, `工具 ${name} 需 tier >= ${spec.tier}，会话 tier=${session.tier}；显式拒绝（不静默）`, {
        code: 'TIER_DENIED',
        tool: name,
        requiredTier: spec.tier,
        sessionTier: session.tier,
      });
    }
    // 第四张表闸：privileged 工具须 approvedTools 命中（annotations 不可信，宿主显式授权）
    if (spec.tier === 'privileged' && !session.approvedTools.includes(name)) {
      return errorFrame(id, -32000, `危险工具 ${name} 未获第四张表批准（approvedTools 未命中）`, {
        code: 'TOOL_NOT_APPROVED',
        tool: name,
      });
    }
    if (name === 'mock.fail.tool') {
      return errorFrame(id, -32000, 'mock.fail.tool 按靶设计必失败（结构化错误面）', {
        code: 'MOCK_FAILURE',
        retryable: false,
        detail: 'structured error payload for conformance',
      });
    }
    if (name === 'mock.echo.tool') {
      const echo = params?.arguments ?? {};
      return okFrame(id, { content: [{ type: 'text', text: JSON.stringify(echo) }], structuredContent: { echo } });
    }
    if (name === 'mock.read.tool') {
      return okFrame(id, { content: [{ type: 'text', text: 'read probe executed (mock canned reply; touches nothing)' }] });
    }
    if (name === 'mock.edit.tool') {
      return okFrame(id, { content: [{ type: 'text', text: 'edit probe executed (mock canned reply; writes nothing)' }] });
    }
    if (name === 'mock.priv.tool') {
      return okFrame(id, { content: [{ type: 'text', text: 'privileged probe executed (approved via 4th table; mock writes nothing)' }] });
    }
    return errorFrame(id, -32000, `工具 ${name} 在 mock 靶上无执行体（mock 不伪装能力真源）`, { code: 'MOCK_NO_EXECUTOR', tool: name });
  }

  function readResource(id, params) {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    if (uri === '') {
      return errorFrame(id, -32602, 'resources/read 缺 params.uri', { code: 'INVALID_ARGS' });
    }
    const spec = MOCK_RESOURCES.find((r) => r.uri === uri);
    if (!spec) {
      return errorFrame(id, -32002, `Unknown resource: ${uri}`, { code: 'UNKNOWN_RESOURCE', uri });
    }
    if (uri === 'mock://res/big') {
      return okFrame(id, {
        contents: [{ uri, mimeType: spec.mimeType, text: BIG_TEXT.slice(0, resTextLimit), truncated: true }],
      });
    }
    return okFrame(id, {
      contents: [{ uri, mimeType: spec.mimeType, text: JSON.stringify({ size: 'small' }), truncated: false }],
    });
  }

  function getPrompt(id, params) {
    const name = typeof params?.name === 'string' ? params.name : '';
    if (name === '') {
      return errorFrame(id, -32602, 'prompts/get 缺 params.name', { code: 'INVALID_ARGS' });
    }
    const spec = MOCK_PROMPTS.find((p) => p.name === name);
    if (!spec) {
      return errorFrame(id, -32602, `Unknown prompt: ${name}`, { code: 'UNKNOWN_PROMPT' });
    }
    const topic = params?.arguments?.topic;
    if (typeof topic !== 'string' || topic === '') {
      return errorFrame(id, -32602, 'prompts/get 缺必填参数 topic', { code: 'INVALID_ARGS', prompt: name });
    }
    return okFrame(id, {
      description: spec.description,
      messages: [{ role: 'user', content: { type: 'text', text: `mock prompt for ${topic}` } }],
    });
  }

  function initializeResult(_params) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: 'kojo-mcp-mock-endpoint', version: '0.1.0' },
      instructions:
        '协议对拍靶（mock）：mock.* 工具与 mock:// 资源仅用于一致性对拍，不承载真实能力，不读写项目文件。',
    };
  }

  /** 响应形态按 Accept 协商：JSON 单帧对象 / SSE 逐 data 事件。 */
  function respondFrames(res, record, wantsSSE, frames) {
    if (wantsSSE) {
      const body = frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join('');
      record.status = 200;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    const payload = frames.length === 1 ? frames[0] : frames;
    record.status = 200;
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }

  return {
    server,
    get port() {
      return server.address().port;
    },
    get url() {
      return `http://${HOST}:${server.address().port}${MCP_PATH}`;
    },
    get origin() {
      return `http://${HOST}:${server.address().port}`;
    },
    requests,
    get notifCount() {
      return notifCount;
    },
    get batchCount() {
      return batchCount;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, HOST, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** 造会话表：语义同 McpSessionScope（tier + approvedTools）。 */
export function buildSessions(tokens) {
  return new Map([
    [tokens.read, { tier: 'read', approvedTools: [] }],
    [tokens.edit, { tier: 'edit', approvedTools: [] }],
    [tokens.priv, { tier: 'privileged', approvedTools: [] }],
    [tokens.approved, { tier: 'privileged', approvedTools: ['mock.priv.tool'] }],
  ]);
}

/** 运行时生成 4 个 token（self-test 用；绝不落盘、不进日志）。 */
export function generateTokens() {
  const gen = () => `mck_${randomBytes(12).toString('hex')}`;
  return { read: gen(), edit: gen(), priv: gen(), approved: gen() };
}

/* ------------------------------------------------------------------ *
 * direct 通道 client / SSE 解析
 * ------------------------------------------------------------------ */

/**
 * 直打 mock endpoint 的 HTTP 客户端（direct 通道）。
 * 默认回环 Origin + `Accept: application/json`；`token` 非 undefined 时自动加 Bearer 头；
 * 显式传 `headers` 可覆盖 origin / accept（空字符串值视为「不发该头」，用于缺 Origin 用例）。
 */
export function httpRequest({ port, host = HOST, method = 'POST', urlPath = MCP_PATH, token, accept = 'application/json', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const payload = body === '' ? null : Buffer.from(body, 'utf8');
    const h = { origin: `http://${HOST}:${port}`, accept, ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    for (const k of Object.keys(h)) {
      if (h[k] === '') delete h[k];
    }
    if (payload) h['content-length'] = payload.length;
    const req = http.request({ host, port, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

/** SSE 正文 → data 帧文本数组（跳过空行与 [DONE]）。 */
export function parseSseFrames(body) {
  const out = [];
  for (const raw of String(body).split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith('data:')) continue;
    const frame = t.slice(5).trim();
    if (frame === '' || frame === '[DONE]') continue;
    out.push(frame);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * stdio shim 会话（spawn 真实 tools/kojo-mcp.mjs）
 * ------------------------------------------------------------------ */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createShimSession({ port, token }) {
  const env = { ...process.env };
  delete env.KOJO_MCP_ENDPOINT_FILE;
  delete env.KOJO_MCP_ENDPOINT;
  delete env.KOJO_MCP_TOKEN;
  env.KOJO_MCP_ENDPOINT = `http://${HOST}:${port}${MCP_PATH}`;
  env.KOJO_MCP_TOKEN = token;

  const child = spawn(process.execPath, [SHIM_PATH], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutAll = [];
  const stderrAll = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => stdoutAll.push(String(d)));
  child.stderr.on('data', (d) => stderrAll.push(String(d)));

  const lineQueue = [];
  let pendingRes = null;
  let closed = false;
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (l) => {
    if (pendingRes) {
      const r = pendingRes;
      pendingRes = null;
      r(l);
    } else {
      lineQueue.push(l);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (pendingRes) {
      const r = pendingRes;
      pendingRes = null;
      r(null);
    }
  });

  const exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  return {
    child,
    exitPromise,
    stdoutAll,
    stderrAll,
    send(line) {
      child.stdin.write(`${line}\n`);
    },
    endInput() {
      child.stdin.end();
    },
    async readFrame(timeoutMs = 8000) {
      if (lineQueue.length > 0) return { line: lineQueue.shift(), timedOut: false, closed };
      if (closed) return { line: null, timedOut: false, closed: true };
      const got = await Promise.race([
        new Promise((res) => {
          pendingRes = res;
        }),
        delay(timeoutMs).then(() => '__timeout__'),
      ]);
      if (got === '__timeout__') {
        pendingRes = null;
        return { line: null, timedOut: true, closed };
      }
      if (got === null) return { line: null, timedOut: false, closed: true };
      return { line: got, timedOut: false, closed };
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exitPromise;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 断言 helper（throw ⇒ 该 case FAIL）
 * ------------------------------------------------------------------ */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function parseFrame(res, id) {
  assertEq(res.status, 200, 'HTTP status');
  let frame;
  try {
    frame = JSON.parse(res.body);
  } catch {
    throw new Error(`响应体不是合法 JSON：${String(res.body).slice(0, 200)}`);
  }
  assertEq(frame.jsonrpc, '2.0', 'jsonrpc 版本');
  if (id !== undefined) assertEq(frame.id, id, '响应帧 id');
  return frame;
}

/** 读 shim 的下一帧并校验 id；超时即「挂住」证据，closed 即 shim 提前死亡。 */
async function expectShimFrame(shim, id, timeoutMs = 8000) {
  const r = await shim.readFrame(timeoutMs);
  if (r.timedOut) throw new Error(`等待 id=${id} 响应超时（${timeoutMs}ms）——notification/batch 挂住了 stdio？`);
  if (r.closed) throw new Error(`shim 已提前退出（exit=${shim.child.exitCode}），未给 id=${id} 响应帧`);
  let msg;
  try {
    msg = JSON.parse(r.line);
  } catch {
    throw new Error(`stdout 帧不是合法 JSON：${String(r.line).slice(0, 200)}`);
  }
  assertEq(msg.id, id, '响应帧 id');
  return msg;
}

/* ------------------------------------------------------------------ *
 * 对拍用例：direct-http（H01..H31）
 * ------------------------------------------------------------------ */

const DIRECT_CASES = [
  {
    id: 'H01',
    group: 'direct-http',
    title: 'initialize 应答形状（旧握手兼容 · 协议版本/能力/serverInfo）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', clientInfo: { name: 'conformance', version: '0' } },
        }),
      });
      const f = parseFrame(res, 1);
      assertEq(f.result.protocolVersion, PROTOCOL_VERSION, 'protocolVersion');
      assert(f.result.capabilities && typeof f.result.capabilities === 'object', '缺 capabilities 对象');
      assert(f.result.capabilities.tools && typeof f.result.capabilities.tools === 'object', '缺 capabilities.tools');
      assertEq(f.result.capabilities.resources.subscribe, false, 'capabilities.resources.subscribe（P5 边界：不订阅）');
      assert(typeof f.result.serverInfo?.name === 'string' && f.result.serverInfo.name.includes('mock'), 'serverInfo.name 应自报 mock 靶面');
      return `旧握手 protocolVersion=2025-06-18 仍按 ${PROTOCOL_VERSION} 无状态应答；serverInfo=${f.result.serverInfo.name}`;
    },
  },
  {
    id: 'H02',
    group: 'direct-http',
    title: '旧握手三连：initialize → notifications/initialized(202 空体) → tools/list',
    async run(ctx) {
      const init = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      parseFrame(init, 2);
      const notif = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assertEq(notif.status, 202, 'notifications/initialized 的 HTTP status');
      assertEq(notif.body, '', 'notification 响应体（应为空）');
      const list = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      const f = parseFrame(list, 3);
      assert(Array.isArray(f.result.tools), 'tools/list 应返回数组');
      return 'notification 202 空体、握手后 tools/list 正常';
    },
  },
  {
    id: 'H03',
    group: 'direct-http',
    title: 'ping → result {}',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) });
      const f = parseFrame(res, 4);
      assert(f.result && typeof f.result === 'object' && Object.keys(f.result).length === 0, 'ping result 应为空对象');
      return 'ok';
    },
  },
  {
    id: 'H04',
    group: 'direct-http',
    title: 'tools/list tier=read：edit/privileged 工具一律不可见',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) });
      const f = parseFrame(res, 5);
      const names = f.result.tools.map((t) => t.name).sort();
      assertEq(JSON.stringify(names), JSON.stringify(['mock.echo.tool', 'mock.fail.tool', 'mock.read.tool']), 'read 会话可见工具');
      for (const t of f.result.tools) {
        assert(typeof t.description === 'string' && t.description.length > 0, `工具 ${t.name} 缺 description`);
        assert(t.inputSchema && typeof t.inputSchema === 'object', `工具 ${t.name} 缺 inputSchema`);
      }
      return `可见 ${names.length} 个；mock.edit.tool / mock.priv.tool 默认缺席`;
    },
  },
  {
    id: 'H05',
    group: 'direct-http',
    title: 'tools/list tier=edit：加 edit 工具，privileged 仍不可见',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.edit, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }) });
      const f = parseFrame(res, 6);
      const names = f.result.tools.map((t) => t.name);
      assert(names.includes('mock.edit.tool'), 'edit 会话应见 mock.edit.tool');
      assert(!names.includes('mock.priv.tool'), 'privileged 工具不得进 tools/list（annotations 不可信，须第四张表）');
      return `可见 ${names.length} 个，privileged 缺席`;
    },
  },
  {
    id: 'H06',
    group: 'direct-http',
    title: 'tools/list tier=privileged：全量可见（仍需 approvedTools 才可调用）',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.priv, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
      const f = parseFrame(res, 7);
      const names = f.result.tools.map((t) => t.name);
      assertEq(names.length, MOCK_TOOLS.length, 'privileged 会话可见工具数');
      return `可见全部 ${names.length} 个`;
    },
  },
  {
    id: 'H07',
    group: 'direct-http',
    title: 'tools/call mock.echo.tool：arguments 原样回显',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'mock.echo.tool', arguments: { payload: 'hello' } } }),
      });
      const f = parseFrame(res, 8);
      assertEq(f.result.content[0].text, JSON.stringify({ payload: 'hello' }), 'echo content');
      assertEq(f.result.structuredContent.echo.payload, 'hello', 'structuredContent.echo');
      return 'ok';
    },
  },
  {
    id: 'H08',
    group: 'direct-http',
    title: 'tools/call 未知工具 → -32602 UNKNOWN_TOOL',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'mock.nope.tool' } }),
      });
      const f = parseFrame(res, 9);
      assertEq(f.error.code, -32602, 'error.code');
      assertEq(f.error.data.code, 'UNKNOWN_TOOL', 'error.data.code');
      return 'ok';
    },
  },
  {
    id: 'H09',
    group: 'direct-http',
    title: 'tools/call 缺 params.name → -32602 INVALID_ARGS',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {} }) });
      const f = parseFrame(res, 10);
      assertEq(f.error.code, -32602, 'error.code');
      assertEq(f.error.data.code, 'INVALID_ARGS', 'error.data.code');
      return 'ok';
    },
  },
  {
    id: 'H10',
    group: 'direct-http',
    title: 'tools/call mock.fail.tool → -32000 结构化错误（data.code=MOCK_FAILURE）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'mock.fail.tool' } }),
      });
      const f = parseFrame(res, 11);
      assertEq(f.error.code, -32000, 'error.code');
      assertEq(f.error.data.code, 'MOCK_FAILURE', 'error.data.code');
      assertEq(f.error.data.retryable, false, 'error.data.retryable');
      assert(typeof f.error.message === 'string' && f.error.message.length > 0, 'error.message 应非空');
      return '结构化错误帧 {code,message,data} 完整';
    },
  },
  {
    id: 'H11',
    group: 'direct-http',
    title: 'read 会话调 edit 工具 → -32000 TIER_DENIED（拒绝可见，不静默过滤）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'mock.edit.tool', arguments: { path: 'x' } } }),
      });
      const f = parseFrame(res, 12);
      assertEq(f.error.code, -32000, 'error.code');
      assertEq(f.error.data.code, 'TIER_DENIED', 'error.data.code');
      assertEq(f.error.data.requiredTier, 'edit', 'error.data.requiredTier');
      return 'ok';
    },
  },
  {
    id: 'H12',
    group: 'direct-http',
    title: 'privileged 会话调未批准危险工具 → -32000 TOOL_NOT_APPROVED',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.priv,
        body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'mock.priv.tool' } }),
      });
      const f = parseFrame(res, 13);
      assertEq(f.error.code, -32000, 'error.code');
      assertEq(f.error.data.code, 'TOOL_NOT_APPROVED', 'error.data.code');
      return 'tier 匹配但 approvedTools 未命中 → 显式拒绝';
    },
  },
  {
    id: 'H13',
    group: 'direct-http',
    title: 'approvedTools 命中后 call 危险工具 → 成功（mock 只回罐头文本）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.approved,
        body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'mock.priv.tool' } }),
      });
      const f = parseFrame(res, 14);
      assert(f.result.content[0].text.includes('approved'), '批准后应可执行');
      return 'ok';
    },
  },
  {
    id: 'H14',
    group: 'direct-http',
    title: 'resources/list → mock:// 资源 2 条',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'resources/list' }) });
      const f = parseFrame(res, 15);
      assertEq(f.result.resources.length, MOCK_RESOURCES.length, 'resources 数');
      for (const r of f.result.resources) assert(r.uri.startsWith('mock://'), `资源 URI 应为 mock:// 前缀，实际 ${r.uri}`);
      return f.result.resources.map((r) => r.uri).join(', ');
    },
  },
  {
    id: 'H15',
    group: 'direct-http',
    title: 'resources/read 大资源：text 截到上限且显式 truncated:true',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'resources/read', params: { uri: 'mock://res/big' } }),
      });
      const f = parseFrame(res, 16);
      const c = f.result.contents[0];
      assertEq(c.text.length, RES_TEXT_LIMIT, '截断后 text 长度');
      assertEq(c.truncated, true, 'truncated 标记');
      return `text ${c.text.length}/${BIG_TEXT.length} 字符 + truncated=true`;
    },
  },
  {
    id: 'H16',
    group: 'direct-http',
    title: 'resources/read 未知 URI → -32002 UNKNOWN_RESOURCE',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'resources/read', params: { uri: 'mock://res/nope' } }),
      });
      const f = parseFrame(res, 17);
      assertEq(f.error.code, -32002, 'error.code');
      assertEq(f.error.data.code, 'UNKNOWN_RESOURCE', 'error.data.code');
      return 'ok';
    },
  },
  {
    id: 'H17',
    group: 'direct-http',
    title: 'prompts/list → mock prompt 1 条（带 arguments schema）',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 18, method: 'prompts/list' }) });
      const f = parseFrame(res, 18);
      assertEq(f.result.prompts.length, MOCK_PROMPTS.length, 'prompts 数');
      assertEq(f.result.prompts[0].arguments[0].name, 'topic', 'argument 名');
      return 'ok';
    },
  },
  {
    id: 'H18',
    group: 'direct-http',
    title: 'prompts/get（Accept 含 event-stream）→ SSE 应答，data 帧合法 JSON',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'prompts/get', params: { name: 'mock.prompt', arguments: { topic: 'conformance' } } }),
      });
      assert(res.contentType.includes('text/event-stream'), `应答 content-type 应为 SSE，实际 ${res.contentType}`);
      const frames = parseSseFrames(res.body);
      assert(frames.length >= 1, 'SSE 正文至少 1 个 data 帧');
      const f = JSON.parse(frames[0]);
      assertEq(f.id, 19, 'SSE 帧 id');
      assert(f.result.messages[0].content.text.includes('conformance'), 'SSE 帧内容应含 topic');
      return `${frames.length} 个 data 帧，content-type=text/event-stream`;
    },
  },
  {
    id: 'H19',
    group: 'direct-http',
    title: 'batch 混合帧 → 只回非 notification 项（数组 2 帧，无 notification 响应）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 101, method: 'tools/list' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 102, method: 'ping' },
        ]),
      });
      assertEq(res.status, 200, 'HTTP status');
      const arr = JSON.parse(res.body);
      assert(Array.isArray(arr), 'batch 响应应为数组');
      assertEq(arr.length, 2, 'batch 响应帧数（notification 不回）');
      const ids = new Set(arr.map((f) => f.id));
      assert(ids.has(101) && ids.has(102) && !ids.has(null) && !ids.has(undefined), 'batch 响应 id 集合应为 {101,102}');
      return 'notification 无响应帧';
    },
  },
  {
    id: 'H20',
    group: 'direct-http',
    title: 'batch 纯 notification → 202 空体',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        body: JSON.stringify([
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
        ]),
      });
      assertEq(res.status, 202, 'HTTP status');
      assertEq(res.body, '', '响应体应为空');
      return 'ok';
    },
  },
  {
    id: 'H21',
    group: 'direct-http',
    title: 'batch + Accept event-stream → SSE 多 data 帧（逐帧合法 JSON）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 201, method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 202, method: 'ping' },
        ]),
      });
      assert(res.contentType.includes('text/event-stream'), `content-type 应为 SSE，实际 ${res.contentType}`);
      const frames = parseSseFrames(res.body).map((s) => JSON.parse(s));
      assertEq(frames.length, 2, 'SSE data 帧数（notification 不回）');
      const ids = new Set(frames.map((f) => f.id));
      assert(ids.has(201) && ids.has(202), 'SSE 帧 id 集合应为 {201,202}');
      return '2 个 data 事件，逐帧 JSON 合法';
    },
  },
  {
    id: 'H22',
    group: 'direct-http',
    title: '未知 method → -32601 METHOD_NOT_FOUND',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'mock/nope.method' }) });
      const f = parseFrame(res, 22);
      assertEq(f.error.code, -32601, 'error.code');
      assertEq(f.error.data.code, 'METHOD_NOT_FOUND', 'error.data.code');
      return 'ok';
    },
  },
  {
    id: 'H23',
    group: 'direct-http',
    title: '缺 Bearer → 401 UNAUTHORIZED（三道闸之二）',
    async run(ctx) {
      const res = await ctx.direct({ body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'ping' }) });
      assertEq(res.status, 401, 'HTTP status');
      assertEq(JSON.parse(res.body).error.code, 'UNAUTHORIZED', 'error.code');
      return 'ok';
    },
  },
  {
    id: 'H24',
    group: 'direct-http',
    title: '错 Bearer → 401 + WWW-Authenticate',
    async run(ctx) {
      const res = await ctx.direct({
        token: 'definitely-wrong-token',
        body: JSON.stringify({ jsonrpc: '2.0', id: 24, method: 'ping' }),
      });
      assertEq(res.status, 401, 'HTTP status');
      assert(typeof res.headers['www-authenticate'] === 'string' && res.headers['www-authenticate'].includes('Bearer'), '应带 WWW-Authenticate: Bearer');
      return 'ok';
    },
  },
  {
    id: 'H25',
    group: 'direct-http',
    title: '缺 Origin → 403 ORIGIN_NOT_ALLOWED（三道闸之三）',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, headers: { origin: '' }, body: JSON.stringify({ jsonrpc: '2.0', id: 25, method: 'ping' }) });
      assertEq(res.status, 403, 'HTTP status');
      assertEq(JSON.parse(res.body).error.code, 'ORIGIN_NOT_ALLOWED', 'error.code');
      return 'ok';
    },
  },
  {
    id: 'H26',
    group: 'direct-http',
    title: '伪造 Origin → 403（防 DNS rebinding / 浏览器冒用）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        headers: { origin: 'http://evil.example:9999' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 26, method: 'ping' }),
      });
      assertEq(res.status, 403, 'HTTP status');
      assertEq(JSON.parse(res.body).error.code, 'ORIGIN_NOT_ALLOWED', 'error.code');
      return 'ok';
    },
  },
  {
    id: 'H27',
    group: 'direct-http',
    title: 'GET /mcp → 405（无状态单端点，不提供 GET 服务器流）',
    async run(ctx) {
      const res = await ctx.direct({ method: 'GET', token: ctx.tokens.read, body: '' });
      assertEq(res.status, 405, 'HTTP status');
      assertEq(JSON.parse(res.body).error.code, 'METHOD_NOT_ALLOWED', 'error.code');
      return 'ok';
    },
  },
  {
    id: 'H28',
    group: 'direct-http',
    title: 'POST /other → 404（单端点 POST /mcp）',
    async run(ctx) {
      const res = await ctx.direct({ urlPath: '/invoke', token: ctx.tokens.read, body: JSON.stringify({ jsonrpc: '2.0', id: 28, method: 'ping' }) });
      assertEq(res.status, 404, 'HTTP status');
      assertEq(JSON.parse(res.body).error.code, 'NOT_FOUND', 'error.code');
      return 'ok';
    },
  },
  {
    id: 'H29',
    group: 'direct-http',
    title: '非法 JSON → 400 + -32700 Parse error',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, body: 'not json at all' });
      assertEq(res.status, 400, 'HTTP status');
      assertEq(JSON.parse(res.body).error.code, -32700, 'error.code');
      return 'ok';
    },
  },
  {
    id: 'H30',
    group: 'direct-http',
    title: 'Accept: application/json → JSON 单帧应答（协商不选 SSE）',
    async run(ctx) {
      const res = await ctx.direct({ token: ctx.tokens.read, accept: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 29, method: 'ping' }) });
      assert(res.contentType.includes('application/json'), `content-type 应为 JSON，实际 ${res.contentType}`);
      assertEq(JSON.parse(res.body).id, 29, '帧 id');
      return 'ok';
    },
  },
  {
    id: 'H31',
    group: 'direct-http',
    title: 'Accept 含 event-stream → SSE 应答（协商选 SSE）',
    async run(ctx) {
      const res = await ctx.direct({
        token: ctx.tokens.read,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'ping' }),
      });
      assert(res.contentType.includes('text/event-stream'), `content-type 应为 SSE，实际 ${res.contentType}`);
      const frames = parseSseFrames(res.body);
      assertEq(frames.length, 1, 'SSE data 帧数');
      assertEq(JSON.parse(frames[0]).id, 30, 'SSE 帧 id');
      return 'ok';
    },
  },
];

/* ------------------------------------------------------------------ *
 * 对拍用例：stdio-shim（S01..S15，真 shim 进程）
 * ------------------------------------------------------------------ */

const SHIM_CASES = [
  {
    id: 'S01',
    group: 'stdio-shim',
    title: 'initialize 形状经真 shim 透传（协议版本/能力/serverInfo）',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1001, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'conformance-stdio', version: '0' } } }));
      const f = await expectShimFrame(ctx.shim, 1001);
      assertEq(f.result.protocolVersion, PROTOCOL_VERSION, 'protocolVersion');
      assertEq(f.result.capabilities.resources.subscribe, false, 'capabilities.resources.subscribe');
      assert(f.result.serverInfo?.name.includes('mock'), 'serverInfo 应自报 mock 靶面');
      return `端到端 ${PROTOCOL_VERSION} 应答`;
    },
  },
  {
    id: 'S02',
    group: 'stdio-shim',
    title: 'notifications/initialized 转发后不回帧（下一帧即 ping 的应答）',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1002, method: 'ping' }));
      const f = await expectShimFrame(ctx.shim, 1002);
      assert(f.result && Object.keys(f.result).length === 0, 'ping result 应为空对象');
      assert(ctx.mock.notifCount >= 1, 'mock 应已收到 notification POST');
      return '无合成响应帧，顺序严格';
    },
  },
  {
    id: 'S03',
    group: 'stdio-shim',
    title: 'tools/list 端到端：tier=read 默认面，privileged/edit 不可见',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1003, method: 'tools/list' }));
      const f = await expectShimFrame(ctx.shim, 1003);
      const names = f.result.tools.map((t) => t.name);
      assert(!names.includes('mock.priv.tool'), 'privileged 工具不得出现在端到端 tools/list');
      assert(!names.includes('mock.edit.tool'), 'edit 工具不得出现在 read 会话 tools/list');
      assert(names.includes('mock.read.tool'), 'read 工具应可见');
      return `可见 ${names.length} 个，privileged 默认缺席`;
    },
  },
  {
    id: 'S04',
    group: 'stdio-shim',
    title: 'tools/call 端到端：echo 回显',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1004, method: 'tools/call', params: { name: 'mock.echo.tool', arguments: { payload: 'via-stdio' } } }));
      const f = await expectShimFrame(ctx.shim, 1004);
      assertEq(f.result.content[0].text, JSON.stringify({ payload: 'via-stdio' }), 'echo content');
      return 'ok';
    },
  },
  {
    id: 'S05',
    group: 'stdio-shim',
    title: 'notification 不挂住 stdio：notifications/foo 后 ping 立即应答',
    async run(ctx) {
      const before = ctx.mock.notifCount;
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/foo' }));
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1005, method: 'ping' }));
      await expectShimFrame(ctx.shim, 1005);
      assertEq(ctx.mock.notifCount, before + 1, 'mock 收到的 notification 转发数');
      return '转发计数 +1 且 ping 未被挂住';
    },
  },
  {
    id: 'S06',
    group: 'stdio-shim',
    title: 'batch 数组行不挂住 stdio：shim 按 notification 转发，无响应帧回 stdout',
    async run(ctx) {
      const before = ctx.mock.batchCount;
      ctx.shim.send(JSON.stringify([{ jsonrpc: '2.0', id: 1006, method: 'ping' }]));
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1007, method: 'ping' }));
      await expectShimFrame(ctx.shim, 1007);
      assertEq(ctx.mock.batchCount, before + 1, 'mock 收到的 batch POST 数');
      return 'batch 转发不等待、不回帧（shim 对数组帧按 notification 语义转发）';
    },
  },
  {
    id: 'S07',
    group: 'stdio-shim',
    title: 'resources/list 端到端：mock:// 2 条',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1008, method: 'resources/list' }));
      const f = await expectShimFrame(ctx.shim, 1008);
      assertEq(f.result.resources.length, MOCK_RESOURCES.length, 'resources 数');
      return 'ok';
    },
  },
  {
    id: 'S08',
    group: 'stdio-shim',
    title: 'resources/read 大资源端到端：截断 + truncated 显式',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1009, method: 'resources/read', params: { uri: 'mock://res/big' } }));
      const f = await expectShimFrame(ctx.shim, 1009);
      assertEq(f.result.contents[0].text.length, RES_TEXT_LIMIT, '截断后 text 长度');
      assertEq(f.result.contents[0].truncated, true, 'truncated 标记');
      return `text ${RES_TEXT_LIMIT} 字符 + truncated=true`;
    },
  },
  {
    id: 'S09',
    group: 'stdio-shim',
    title: 'resources/read 未知 URI 端到端：-32002 UNKNOWN_RESOURCE 透传',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1010, method: 'resources/read', params: { uri: 'mock://res/nope' } }));
      const f = await expectShimFrame(ctx.shim, 1010);
      assertEq(f.error.code, -32002, 'error.code');
      assertEq(f.error.data.code, 'UNKNOWN_RESOURCE', 'error.data.code');
      return 'ok';
    },
  },
  {
    id: 'S10',
    group: 'stdio-shim',
    title: 'prompts/list 端到端',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1011, method: 'prompts/list' }));
      const f = await expectShimFrame(ctx.shim, 1011);
      assertEq(f.result.prompts.length, MOCK_PROMPTS.length, 'prompts 数');
      return 'ok';
    },
  },
  {
    id: 'S11',
    group: 'stdio-shim',
    title: 'prompts/get 端到端：mock 以 SSE 应答，shim 逐 data 帧转发',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1012, method: 'prompts/get', params: { name: 'mock.prompt', arguments: { topic: 'stdio-sse' } } }));
      const f = await expectShimFrame(ctx.shim, 1012);
      assert(f.result.messages[0].content.text.includes('stdio-sse'), 'SSE 应答内容应经 shim 逐帧转发');
      return 'SSE 应答经 shim 转发为单条 stdout 帧';
    },
  },
  {
    id: 'S12',
    group: 'stdio-shim',
    title: 'tools/call mock.fail.tool 端到端：结构化错误透传（shim 不吞 error 帧）',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1013, method: 'tools/call', params: { name: 'mock.fail.tool' } }));
      const f = await expectShimFrame(ctx.shim, 1013);
      assertEq(f.error.code, -32000, 'error.code');
      assertEq(f.error.data.code, 'MOCK_FAILURE', 'error.data.code');
      return 'ok';
    },
  },
  {
    id: 'S13',
    group: 'stdio-shim',
    title: '未知 method 端到端：-32601 透传',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1014, method: 'mock/nope.method' }));
      const f = await expectShimFrame(ctx.shim, 1014);
      assertEq(f.error.code, -32601, 'error.code');
      return 'ok';
    },
  },
  {
    id: 'S14',
    group: 'stdio-shim',
    title: '错误帧后 shim 仍存活：错误帧是 200 应答，不杀主循环',
    async run(ctx) {
      ctx.shim.send(JSON.stringify({ jsonrpc: '2.0', id: 1015, method: 'ping' }));
      const f = await expectShimFrame(ctx.shim, 1015);
      assert(f.result && Object.keys(f.result).length === 0, 'ping result 应为空对象');
      return 'S12/S13 的 error 帧后主循环正常';
    },
  },
  {
    id: 'S15',
    group: 'stdio-shim',
    title: '坏 JSON 行 → mock 400 → shim 显式终结（exit 4 + stderr 提示，stdout 无帧）',
    async run(ctx) {
      ctx.shim.send('not json at all');
      ctx.shim.endInput();
      const code = await Promise.race([ctx.shim.exitPromise, delay(10000).then(() => '__timeout__')]);
      if (code === '__timeout__') throw new Error('shim 10s 内未退出——坏帧未按「非 2xx 显式失败」终结（不静默红线）');
      assertEq(code, 4, 'shim 退出码（HTTP 400 → exit 4）');
      const errText = ctx.shim.stderrAll.join('');
      assert(errText.includes('HTTP 400'), `stderr 缺可执行提示（HTTP 400），实际 ${JSON.stringify(errText.slice(0, 200))}`);
      const r = await ctx.shim.readFrame(500);
      if (r.line !== null) throw new Error(`shim 终结前不该再出帧，实际 ${String(r.line).slice(0, 120)}`);
      return 'exit=4，stderr 含「HTTP 400」可执行提示，stdout 无额外帧';
    },
  },
];

/* ------------------------------------------------------------------ *
 * 运行器
 * ------------------------------------------------------------------ */

function renderRow(row) {
  const mark = row.pass ? 'PASS' : 'FAIL';
  return `[${row.id}] ${row.title.padEnd(64, '　')} ${mark}${row.detail ? ` :: ${row.detail}` : ''}`;
}

/** 输出纪律：任何一行在离开 harness 前过 token 扫描，命中即判 FAIL 并遮蔽。 */
function scrubRow(row, tokenValues) {
  for (const t of tokenValues) {
    if (t && (row.title.includes(t) || row.detail.includes(t))) {
      row.pass = false;
      row.title = row.title.split(t).join('<redacted>');
      row.detail = `${row.detail.split(t).join('<redacted>')}（该行输出含 token 字面量 → 判 FAIL）`;
    }
  }
  return row;
}

/**
 * 跑全量对拍。
 * @param {{ tokens?: {read,edit,priv,approved}, onLine?: (line: string) => void }} opts
 * @returns {{ rows, passed, failed, tokenLeak, tokens, shimStdout, shimStderr, requests, logs }}
 */
export async function runConformance(opts = {}) {
  const tokens = opts.tokens ?? generateTokens();
  const tokenValues = Object.values(tokens).filter((t) => typeof t === 'string' && t.length > 0);
  const logs = [];
  const onLine = (line) => {
    logs.push(line);
    opts.onLine?.(line);
  };

  const mock = createMockEndpoint({ sessions: buildSessions(tokens) });
  await mock.listen();
  onLine('== kojo MCP 协议一致性对拍（B3 · ADR-0013）==');
  onLine(`mock endpoint: ${mock.url}（Bearer 已注入、不回显；仅 127.0.0.1）`);

  const rows = [];
  const runCase = async (c, ctx) => {
    const row = { id: c.id, group: c.group, title: c.title, pass: true, detail: '' };
    try {
      const detail = await c.run(ctx);
      row.detail = typeof detail === 'string' ? detail : '';
    } catch (err) {
      row.pass = false;
      row.detail = err instanceof Error ? err.message : String(err);
    }
    rows.push(scrubRow(row, tokenValues));
    onLine(renderRow(row));
    return row;
  };

  // direct 通道（H01..H31）：mock 协议面
  const ctxDirect = { tokens, mock, direct: (o) => httpRequest({ port: mock.port, ...o }), shim: null };
  for (const c of DIRECT_CASES) await runCase(c, ctxDirect);

  // stdio 通道（S01..S15）：真 shim 进程
  const shim = createShimSession({ port: mock.port, token: tokens.read });
  const ctxShim = { ...ctxDirect, shim };
  try {
    for (const c of SHIM_CASES) await runCase(c, ctxShim);
  } finally {
    if (shim.child.exitCode === null && shim.child.signalCode === null) shim.child.kill();
  }

  // token 泄漏终检：全部日志 + shim stdout/stderr + mock 请求摘要
  const shimStdout = shim.stdoutAll.join('');
  const shimStderr = shim.stderrAll.join('');
  const leakSurface = [...logs, shimStdout, shimStderr, JSON.stringify(mock.requests)].join('\n');
  const tokenLeak = tokenValues.some((t) => t && leakSurface.includes(t));
  const hygieneRow = scrubRow(
    {
      id: 'X01',
      group: 'hygiene',
      title: 'token 不泄漏（stdout/stderr/日志/请求摘要）',
      pass: !tokenLeak,
      detail: tokenLeak ? '泄漏面命中 token 字面量' : '全部泄漏面无 token 字面量',
    },
    tokenValues,
  );
  rows.push(hygieneRow);
  onLine(renderRow(hygieneRow));

  await mock.close();

  const passed = rows.filter((r) => r.pass).length;
  const failed = rows.length - passed;
  onLine('----------------------------------------------------------------');
  onLine(`共 ${rows.length} 条：PASS ${passed} / FAIL ${failed}${failed === 0 && !tokenLeak ? ' —— 协议一致性 ✅' : ' —— 存在失败 ⛔'}`);

  return { rows, passed, failed, tokenLeak, tokens, shimStdout, shimStderr, requests: mock.requests, logs };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--self-test') && !argv.includes('--json')) {
    process.stderr.write('用法：node tools/mcp-conformance.mjs --self-test | --json\n');
    process.exitCode = 2;
    return;
  }
  const r = await runConformance({ onLine: (l) => process.stdout.write(`${l}\n`) });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ passed: r.passed, failed: r.failed, tokenLeak: r.tokenLeak, rows: r.rows }, null, 2)}\n`);
  }
  if (r.failed > 0) {
    process.stderr.write(`[kojo-mcp-conformance] ${r.failed} 条对拍失败：\n`);
    for (const row of r.rows.filter((x) => !x.pass)) {
      process.stderr.write(`  [${row.id}] ${row.title} :: ${row.detail}\n`);
    }
    process.stderr.write(
      '可执行提示：复跑 `node tools/mcp-conformance.mjs --self-test` 定位；先确认 mock endpoint 能起（127.0.0.1 端口占用？）、' +
        '`node tools/kojo-mcp.mjs` 能被 spawn（node 在 PATH？仓库根可访问？）、再看失败行的期望 vs 实际。\n',
    );
    process.exitCode = 1;
    return;
  }
  if (r.tokenLeak) {
    process.stderr.write('[kojo-mcp-conformance] 对拍表全过但泄漏面命中 token 字面量——检查 mock 请求记录与 shim stderr。\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[kojo-mcp-conformance] 未预期失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}