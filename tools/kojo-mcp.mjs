/**
 * kojo-mcp —— MCP stdio shim（P0 契约 · 路 A，ADR-0013 决策 2）。
 *
 * **零依赖**：只用 Node 内置模块（node:http / node:fs / node:path / node:readline / node:url）。
 * 本进程**只转发帧，不跑内核**：stdin 每行一条 JSON-RPC → 回环 `POST /mcp`
 * （`Authorization: Bearer <token>`）→ stdout 每行一条响应帧。它不装载 kernel、
 * 不读写项目文件、不新增外部 npm 依赖、**不自动拉起编辑器**、不打包 Node sidecar——
 * 因此不违反 ADR-0003「拒打包 Node sidecar」。
 *
 * 端点来自 `%APPDATA%/dev.kojo.editor/mcp-endpoint.json`（`{port, token}`，由 Rust `mcp_start` 写入）。
 * 发现文件缺失 / 编辑器未启用 / 连接失败 / token 失效，一律 **stderr 给可执行提示 + exit 非 0**，
 * **绝不静默兜底**（不猜默认端口、不回落空 token、不吞错误、不假装成功）。
 *
 * 可注入 seam（`runShim` 的 `post` / `lines` / `readFile` / `writeOut` / `writeErr` / `env`）
 * 供 `tools/tests/mcp-stdio.test.ts` 对拍；`KOJO_MCP_ENDPOINT_FILE` 是端点文件路径的
 * 环境变量覆盖（夹具用；生产仍以 %APPDATA% 为准）。
 *
 * 用法：外部 AI 按 stdio 拉起本脚本（`node tools/kojo-mcp.mjs`），换行分隔 JSON-RPC。
 * 退出码：0 = 正常（stdin 关闭）；2 = 端点文件/参数；3 = 连接失败；4 = HTTP 非 2xx / 鉴权失败。
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import * as path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const ENDPOINT_REL = path.join('dev.kojo.editor', 'mcp-endpoint.json');
const DEFAULT_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

/** 带可执行 `hint` 与 `exitCode` 的失败；`runShim` 只把它写到 stderr 并回码，绝不吞。 */
export class ShimError extends Error {
  constructor(hint, exitCode = 1) {
    super(hint);
    this.name = 'ShimError';
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** 端点文件路径：%APPDATA%/dev.kojo.editor/mcp-endpoint.json；KOJO_MCP_ENDPOINT_FILE 为夹具覆盖。 */
export function resolveEndpointFile(env = process.env) {
  const override = env.KOJO_MCP_ENDPOINT_FILE;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  const appData = env.APPDATA;
  if (typeof appData !== 'string' || appData.trim() === '') {
    throw new ShimError(
      '找不到 %APPDATA%：无法确定 MCP 端点文件位置。请在 Windows 桌面壳中运行，或用 KOJO_MCP_ENDPOINT_FILE 显式指定端点文件。',
      2,
    );
  }
  return path.join(appData, ENDPOINT_REL);
}

/** 解析 `{port, token}`；缺字段 / 非法值都判红（绝不回落默认端口或空 token）。 */
export function parseEndpoint(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ShimError(
      `端点文件 ${file} 不是合法 JSON（${String(err)}）。请重启编辑器的 MCP 服务以重写该文件。`,
      2,
    );
  }
  const port = data?.port;
  const token = data?.token;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ShimError(
      `端点文件 ${file} 缺少合法的 port。请在编辑器「设置 › AI 接入」开启 MCP 服务后重试。`,
      2,
    );
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new ShimError(
      `端点文件 ${file} 缺少 token。请在编辑器「设置 › AI 接入」轮换 token 后重试。`,
      2,
    );
  }
  return { port, token, host: DEFAULT_HOST, path: MCP_PATH };
}

/**
 * 构造请求 options：**仅回环**（127.0.0.1）+ `Authorization: Bearer` + `Origin` 白名单面
 * （回环 origin，Rust 侧白名单需放行 `http://127.0.0.1:<port>`）+ 单端点 `POST /mcp`。
 * `Accept` 同时收 `application/json` 单帧与 `text/event-stream` 多帧（Streamable HTTP）。
 */
export function buildRequestOptions(endpoint, body) {
  const buf = Buffer.from(body, 'utf8');
  const host = endpoint.host ?? DEFAULT_HOST;
  return {
    hostname: host,
    port: endpoint.port,
    path: endpoint.path ?? MCP_PATH,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${endpoint.token}`,
      origin: `http://${host}:${endpoint.port}`,
      accept: 'application/json, text/event-stream',
      'content-length': buf.length,
    },
  };
}

/** 真实 HTTP 发帧器（可注入 `httpImpl`，默认 node:http）。 */
export function createHttpPoster(httpImpl = http) {
  return function post(body, endpoint) {
    return new Promise((resolve, reject) => {
      const opts = buildRequestOptions(endpoint, body);
      const buf = Buffer.from(body, 'utf8');
      const req = httpImpl.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      req.on('error', reject);
      req.end(buf);
    });
  };
}

/** 连接层失败 → 可执行提示（ECONNREFUSED ⇒ 编辑器未启用 / 端点失效）。 */
export function classifyFailure(err, endpoint) {
  const code = err?.code;
  const netCodes = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'EAI_AGAIN',
  ]);
  if (code !== undefined && netCodes.has(code)) {
    return new ShimError(
      `无法连接 MCP 服务 ${DEFAULT_HOST}:${endpoint.port}（${code}）。编辑器可能未启用 MCP 服务，或端点已失效；请在「设置 › AI 接入」开启服务并确认状态后重试。`,
      3,
    );
  }
  return new ShimError(
    `MCP 请求失败（${code ?? String(err)}）。请检查「设置 › AI 接入」的服务状态与端点文件。`,
    3,
  );
}

/** HTTP 非 2xx → 可执行提示；2xx / 202 无正文（通知）返回 null。 */
export function classifyStatus(res) {
  const s = res.status;
  if (s === 401 || s === 403) {
    return new ShimError(
      `MCP 服务拒绝 Bearer token（HTTP ${s}）。请在编辑器「设置 › AI 接入」轮换 token，并更新端点文件后重试。`,
      4,
    );
  }
  if (s >= 500) {
    return new ShimError(`MCP 服务返回 HTTP ${s}。请查看编辑器日志，必要时重启 MCP 服务。`, 4);
  }
  if (s < 200 || s >= 300) {
    return new ShimError(
      `POST /mcp 返回 HTTP ${s}（非 2xx）。请确认编辑器已启用 MCP 且端点为单端点 POST /mcp。`,
      4,
    );
  }
  return null;
}

/** HTTP 响应体 → stdout 帧数组：单帧 JSON 归一成一行；SSE 逐 `data:` 行转发；空正文（通知）不回帧。 */
export function responseFrames(res) {
  const body = (res.body ?? '').trim();
  if (body === '') return [];
  if (/application\/json/i.test(res.contentType ?? '')) {
    try {
      return [JSON.stringify(JSON.parse(body))];
    } catch {
      /* 不是整段 JSON：落到逐行帧转发 */
    }
  }
  const frames = [];
  for (const raw of body.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === '') continue;
    const frame = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (frame === '' || frame === '[DONE]') continue;
    frames.push(frame);
  }
  return frames;
}

/**
 * 主循环。所有 IO 可注入，便于无网络、无 Tauri 的对拍测试。
 * 返回退出码（0 / 2 / 3 / 4）；失败只写 stderr + 回码，**不写任何 stdout 帧**（不静默兜底）。
 */
export async function runShim(io = {}) {
  const {
    env = process.env,
    readFile = (f) => fs.readFile(f, 'utf8'),
    post,
    lines,
    writeOut = (l) => process.stdout.write(`${l}\n`),
    writeErr = (m) => process.stderr.write(`${m}\n`),
  } = io;
  const poster = post ?? createHttpPoster();

  let endpoint;
  try {
    const file = resolveEndpointFile(env);
    let text;
    try {
      text = await readFile(file);
    } catch (err) {
      throw new ShimError(
        `读取 MCP 端点文件失败：${file}（${err?.code ?? String(err)}）。编辑器可能未启用 MCP 服务；请在「设置 › AI 接入」开启服务，开启后该文件由编辑器写入。`,
        2,
      );
    }
    endpoint = parseEndpoint(text, file);
  } catch (err) {
    const e = err instanceof ShimError ? err : new ShimError(String(err), 2);
    writeErr(`[kojo-mcp] ${e.hint}`);
    return e.exitCode;
  }

  const source = lines ?? readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const raw of source) {
      const line = String(raw).trim();
      if (line === '') continue;
      let res;
      try {
        res = await poster(line, endpoint);
      } catch (err) {
        const e = classifyFailure(err, endpoint);
        writeErr(`[kojo-mcp] ${e.hint}`);
        return e.exitCode;
      }
      const bad = classifyStatus(res);
      if (bad) {
        writeErr(`[kojo-mcp] ${bad.hint}`);
        return bad.exitCode;
      }
      for (const frame of responseFrames(res)) writeOut(frame);
    }
  } finally {
    if (typeof source.close === 'function') source.close();
  }
  return 0;
}

async function main() {
  const code = await runShim();
  process.exitCode = code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main().catch((err) => {
    process.stderr.write(`[kojo-mcp] 未预期失败：${String(err)}\n`);
    process.exitCode = 1;
  });
}
