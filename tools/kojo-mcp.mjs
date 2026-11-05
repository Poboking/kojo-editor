/**
 * kojo-mcp —— MCP stdio shim（P0 契约 · 路 A，ADR-0013 决策 2；路 B 第三波：生产可用性）。
 *
 * **零依赖**：只用 Node 内置模块（node:http / node:fs / node:path / node:readline / node:url）。
 * 本进程**只转发帧，不跑内核**：stdin 每行一条 JSON-RPC → 回环 `POST /mcp`
 * （`Authorization: Bearer <token>`）→ stdout 每行一条响应帧。它不装载 kernel、
 * 不读写项目文件、不新增外部 npm 依赖、**不自动拉起编辑器**、不打包 Node sidecar——
 * 因此不违反 ADR-0003「拒打包 Node sidecar」。
 *
 * 端点默认来自 Tauri `app_data_dir()` 下的 `dev.kojo.editor/mcp-endpoint.json`
 * （`{port, token}`，由 Rust `mcp_start` 写入）：Windows 走 `%APPDATA%`，macOS 走
 * `~/Library/Application Support`，Linux 走 `$XDG_DATA_HOME`（缺省 `~/.local/share`）。
 * **环境变量覆盖（CI / 本地端口转发场景）**：`KOJO_MCP_ENDPOINT`（`host:port` 或 URL）覆盖地址、
 * `KOJO_MCP_TOKEN` 覆盖 token；两者齐备时**完全跳过发现文件**。默认（无这些变量）仍只读发现文件，
 * 绝不猜默认端口、不回落空 token。`KOJO_MCP_ENDPOINT_FILE` 是端点文件路径覆盖（夹具用）。
 *
 * 发现文件缺失 / 编辑器未启用 / 连接失败 / token 失效，一律 **stderr 给可执行提示 + exit 非 0**，
 * **绝不静默兜底**（不猜默认端口、不回落空 token、不吞错误、不假装成功）。
 * **绝不把 token 打到 stdout / stderr / 任何日志**：所有提示只描述失败类型与处置，不含 token 值。
 *
 * JSON-RPC notification（无 id / `notifications/*`）：**转发后不等待、不伪造响应、不挂住 stdio**——
 * 发起 POST 即继续主循环，绝不 await 其响应、绝不往 stdout 写合成响应帧；其连接失败只在 stderr
 * 提示且不终止后续帧。普通请求仍逐帧等待响应并一一转发。
 *
 * 可注入 seam（`runShim` 的 `post` / `lines` / `readFile` / `writeOut` / `writeErr` / `env`）
 * 供 `tools/tests/mcp-stdio.test.ts` 对拍。
 *
 * 用法：外部 AI 按 stdio 拉起本脚本（`node tools/kojo-mcp.mjs`），换行分隔 JSON-RPC。
 * 退出码：0 = 正常（stdin 关闭）；2 = 端点文件/参数/发现；3 = 连接失败；4 = HTTP 非 2xx / 鉴权失败。
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
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

/**
 * 端点文件路径：按 Tauri `app_data_dir()` 的三平台口径自动定位，与 Rust `mcp_start`
 * 写入的位置一致；`KOJO_MCP_ENDPOINT_FILE` 仍是最高优先级的夹具 / 定制覆盖。
 *
 * - win32：`%APPDATA%`（缺 ⇒ 显式失败，不猜路径、不回落）
 * - darwin：`~/Library/Application Support`
 * - linux：`$XDG_DATA_HOME`（须为绝对路径；相对值按 XDG 规范忽略）→ 缺省 `~/.local/share`
 * - 其它平台：无已知落点 ⇒ 显式失败，要求用 `KOJO_MCP_ENDPOINT_FILE` 指定
 *
 * `platform` / `homeDir` 可注入，便于在 Windows 上单测 macOS / Linux 分支（零外部依赖）。
 */
export function resolveEndpointFile(
  env = process.env,
  platform = process.platform,
  homeDir = () => os.homedir(),
) {
  const override = env.KOJO_MCP_ENDPOINT_FILE;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);

  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (typeof appData !== 'string' || appData.trim() === '') {
      throw new ShimError(
        '找不到 %APPDATA%：无法确定 MCP 端点文件位置。请在 Windows 桌面壳中运行，或用 KOJO_MCP_ENDPOINT_FILE 显式指定端点文件。',
        2,
      );
    }
    return path.join(appData, ENDPOINT_REL);
  }

  let base;
  if (platform === 'darwin') {
    base = path.join('Library', 'Application Support');
  } else if (platform === 'linux') {
    const xdg = env.XDG_DATA_HOME;
    if (typeof xdg === 'string' && xdg.trim() !== '' && path.isAbsolute(xdg)) {
      return path.join(xdg, ENDPOINT_REL);
    }
    base = path.join('.local', 'share');
  } else {
    throw new ShimError(
      `平台 ${platform} 没有已知的 app_data_dir() 落点：请用 KOJO_MCP_ENDPOINT_FILE 显式指定端点文件，或用 KOJO_MCP_ENDPOINT + KOJO_MCP_TOKEN 成对覆盖。`,
      2,
    );
  }

  const home = typeof homeDir === 'function' ? homeDir() : homeDir;
  if (typeof home !== 'string' || home.trim() === '') {
    throw new ShimError(
      '无法确定用户主目录：请用 KOJO_MCP_ENDPOINT_FILE 显式指定端点文件，或用 KOJO_MCP_ENDPOINT + KOJO_MCP_TOKEN 成对覆盖。',
      2,
    );
  }
  return path.join(home, base, ENDPOINT_REL);
}

/**
 * 解析 `KOJO_MCP_ENDPOINT`：`host:port` / `host:port/path` / `http://host:port[/path]`。
 * 只取 host / port / path，忽略其它 URL 组成（query / userinfo 一律丢弃，绝不回显输入值——
 * 防止误把嵌在地址里的密钥打到日志）。默认 host 为 127.0.0.1（仅回环基线）；跨机接入
 * 须自行保证链路可信（ADR-0013「后续演进」）。任何非法值都抛 ShimError(2)，绝不猜端口。
 */
export function parseEndpointOverride(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') {
    throw new ShimError('KOJO_MCP_ENDPOINT 为空。请给出 host:port（如 127.0.0.1:54321）或 http://127.0.0.1:54321/mcp。', 2);
  }
  let host = DEFAULT_HOST;
  let port;
  let urlPath = MCP_PATH;
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new ShimError('KOJO_MCP_ENDPOINT 不是合法 URL。请给出 host:port 或 http://host:port/mcp；含密钥的地址不会被回显。', 2);
    }
    host = u.hostname || DEFAULT_HOST;
    port = u.port === '' ? undefined : Number(u.port);
    urlPath = u.pathname && u.pathname !== '/' ? u.pathname : MCP_PATH;
  } else {
    const slash = s.indexOf('/');
    const authority = slash >= 0 ? s.slice(0, slash) : s;
    if (slash >= 0) urlPath = s.slice(slash) || MCP_PATH;
    const m = /^([^:]+):(\d+)$/.exec(authority);
    if (!m) {
      throw new ShimError('KOJO_MCP_ENDPOINT 需带端口。请给出 host:port（如 127.0.0.1:54321）或完整 URL；含密钥的地址不会被回显。', 2);
    }
    host = m[1] || DEFAULT_HOST;
    port = Number(m[2]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ShimError(`KOJO_MCP_ENDPOINT 端口非法，须为 1..65535。`, 2);
  }
  if (/\s/.test(host)) {
    throw new ShimError('KOJO_MCP_ENDPOINT 的 host 含空白字符，已拒绝。', 2);
  }
  return { host, port, path: urlPath || MCP_PATH };
}

/**
 * 是否 JSON-RPC notification：无 id / id 为 null / method 以 `notifications/` 开头。
 * 解析失败（坏帧）按普通帧处理（转发给服务端去判 parse error，shim 不伪造响应）。
 */
export function isNotificationFrame(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return false;
  }
  if (msg === null || typeof msg !== 'object') return false;
  if (msg.id === undefined || msg.id === null) return true;
  return typeof msg.method === 'string' && msg.method.startsWith('notifications/');
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
 * 端点解析（环境变量覆盖 + 发现文件兜底）。
 * - `KOJO_MCP_ENDPOINT` + `KOJO_MCP_TOKEN` 齐备 ⇒ 完全跳过发现文件（CI / 端口转发场景）。
 * - 否则以发现文件为基；单给其一则覆盖对应字段（地址 / token）。
 * - 缺省（无任何 KOJO_MCP_* 覆盖）⇒ 只读发现文件，与第一波行为逐字一致。
 * 缺 token / 缺文件 / 非法覆盖一律 ShimError(2)；提示只描述失败类型，绝不含 token 值。
 */
export async function resolveEndpoint(env = process.env, readFile = (f) => fs.readFile(f, 'utf8')) {
  const endpointEnv = typeof env.KOJO_MCP_ENDPOINT === 'string' ? env.KOJO_MCP_ENDPOINT.trim() : '';
  const tokenEnv = typeof env.KOJO_MCP_TOKEN === 'string' ? env.KOJO_MCP_TOKEN.trim() : '';
  const override = endpointEnv !== '' ? parseEndpointOverride(endpointEnv) : null;
  const tokenOverride = tokenEnv !== '' ? tokenEnv : null;

  if (override && tokenOverride) {
    return { ...override, token: tokenOverride };
  }

  const file = resolveEndpointFile(env);
  let text;
  try {
    text = await readFile(file);
  } catch (err) {
    throw new ShimError(
      `读取 MCP 端点文件失败：${file}（${err?.code ?? String(err)}）。编辑器可能未启用 MCP 服务；请在「设置 › AI 接入」开启服务，开启后该文件由编辑器写入；CI/转发场景可用 KOJO_MCP_ENDPOINT + KOJO_MCP_TOKEN 覆盖。`,
      2,
    );
  }
  const base = parseEndpoint(text, file);
  return {
    ...base,
    ...(override ? { host: override.host, port: override.port, path: override.path } : {}),
    ...(tokenOverride ? { token: tokenOverride } : {}),
  };
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
  // SSE 的 `event:` / `id:` / `retry:` / `:` 注释行是**传输元数据，不是 JSON-RPC 帧**。
  // 真 Rust 端点发的是 `event: message\ndata: {...}\n\n`：旧实现把 `event: message`
  // 原样写进 stdout，每个请求污染一行非 JSON 文本（真壳端到端取证才暴露出来，
  // 早期 mock 只发 data: 行所以协议对拍抓不到）。SSE 通道只认 data: 行。
  const isSse = /text\/event-stream/i.test(res.contentType ?? '');
  for (const raw of body.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === '') continue;
    if (isSse) {
      if (!t.startsWith('data:')) continue;
      const frame = t.slice(5).trim();
      if (frame === '' || frame === '[DONE]') continue;
      frames.push(frame);
      continue;
    }
    // 非 SSE（含 NDJSON 逐行帧）保持原有转发口径，不回退。
    const frame = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (frame === '' || frame === '[DONE]') continue;
    frames.push(frame);
  }
  return frames;
}

/**
 * 主循环。所有 IO 可注入，便于无网络、无 Tauri 的对拍测试。
 * 返回退出码（0 / 2 / 3 / 4）；发现/连接/鉴权失败只写 stderr + 回码，
 * **不写任何 stdout 帧、不伪造响应**（不静默兜底）。
 * notification 只转发、不等待响应、不回帧、不挂住后续请求。
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
    // 端点解析统一走 resolveEndpoint：环境变量覆盖优先、缺省只读发现文件（CI / 转发场景可跳过文件）。
    endpoint = await resolveEndpoint(env, readFile);
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

      // JSON-RPC notification（无 id / notifications/*）：转发后**不等待、不伪造响应、不挂住 stdio**。
      // 只发起 POST；绝不 await 其响应、绝不往 stdout 写合成响应帧；失败仅 stderr 提示且不终止后续帧。
      if (isNotificationFrame(line)) {
        try {
          const pending = poster(line, endpoint);
          void Promise.resolve(pending).catch((err) => {
            const e = classifyFailure(err, endpoint);
            writeErr(`[kojo-mcp] 通知帧转发失败（已转发、不等待响应、不影响后续帧）：${e.hint}`);
          });
        } catch (err) {
          const e = classifyFailure(err, endpoint);
          writeErr(`[kojo-mcp] 通知帧转发失败（已转发、不等待响应、不影响后续帧）：${e.hint}`);
        }
        continue;
      }

      // 普通请求：等待响应、逐帧转发；失败显式 stderr + exit 非 0（不静默兜底）。
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
