/**
 * `tools/kojo-mcp.mjs`（stdio shim）的对拍用例（P0 契约 · 路 A）。
 *
 * 三层覆盖：
 *  ① 纯函数：端点解析 / 请求头（Bearer + 回环 Origin + 单端点 POST /mcp）/ 失败分类 / 帧转发；
 *  ② `runShim` 注入式 transport seam：不联网跑通「成功 / 端点文件缺失 / 连接失败 / 401 / SSE」；
 *  ③ 进程级契约：`spawnSync('node', [shim])` 验真实退出码、stderr 可执行提示、stdout 一个字符都不留；
 *     以及 `createHttpPoster()` 打真本机 HTTP server，验请求真的带 Bearer 且落在 /mcp。
 *
 * 纪律对拍：缺文件 / 未启用 / 401 一律 exit 非 0 且**不写任何 stdout 帧**（不静默兜底、不猜端口、
 * 不自动拉起编辑器）。
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ShimError,
  buildRequestOptions,
  classifyFailure,
  classifyStatus,
  createHttpPoster,
  isNotificationFrame,
  parseEndpoint,
  parseEndpointOverride,
  resolveEndpoint,
  resolveEndpointFile,
  responseFrames,
  runShim,
} from '../kojo-mcp.mjs';

const CLI = fileURLToPath(new URL('../kojo-mcp.mjs', import.meta.url));
const HOST = '127.0.0.1';
const GOOD_ENDPOINT = { port: 54321, token: 'tok-abc' };

const envWith = (file) => ({ APPDATA: '/some/appdata', KOJO_MCP_ENDPOINT_FILE: file });
const readOk = () => JSON.stringify(GOOD_ENDPOINT);

/* ------------------------------------------------------------------ *
 * ① 纯函数
 * ------------------------------------------------------------------ */
describe('kojo-mcp · 纯函数', () => {
  it('resolveEndpointFile 走 %APPDATA%/dev.kojo.editor/mcp-endpoint.json，夹具覆盖生效', () => {
    const p = resolveEndpointFile({ APPDATA: 'C:/Users/x/AppData/Roaming' });
    expect(p).toBe(path.join('C:/Users/x/AppData/Roaming', 'dev.kojo.editor', 'mcp-endpoint.json'));
    expect(resolveEndpointFile({ KOJO_MCP_ENDPOINT_FILE: 'D:/tmp/e.json' })).toBe(path.resolve('D:/tmp/e.json'));
    expect(() => resolveEndpointFile({})).toThrow(ShimError);
  });

  it('resolveEndpointFile 按平台自动定位 Tauri app_data_dir（macOS / Linux / 未知平台）', () => {
    const rel = path.join('dev.kojo.editor', 'mcp-endpoint.json');
    const mac = resolveEndpointFile({}, 'darwin', '/Users/x');
    expect(mac).toBe(path.join('/Users/x', 'Library', 'Application Support', rel));
    expect(resolveEndpointFile({}, 'linux', '/home/x')).toBe(path.join('/home/x', '.local', 'share', rel));
    expect(resolveEndpointFile({ XDG_DATA_HOME: '/xdg/data' }, 'linux', '/home/x')).toBe(
      path.join('/xdg/data', rel),
    );
    expect(resolveEndpointFile({ XDG_DATA_HOME: 'relative/data' }, 'linux', '/home/x')).toBe(
      path.join('/home/x', '.local', 'share', rel),
    );
    // 覆盖优先级最高：即便在别的平台也不读默认落点。
    expect(resolveEndpointFile({ KOJO_MCP_ENDPOINT_FILE: 'D:/tmp/e.json' }, 'darwin', '/Users/x')).toBe(
      path.resolve('D:/tmp/e.json'),
    );
    // 未知平台 / 主目录缺失 / Windows 缺 APPDATA：一律显式失败，绝不猜路径。
    expect(() => resolveEndpointFile({}, 'freebsd', '/home/x')).toThrow(ShimError);
    expect(() => resolveEndpointFile({}, 'darwin', '')).toThrow(ShimError);
    expect(() => resolveEndpointFile({}, 'win32', '/unused')).toThrow(ShimError);
    expect(resolveEndpointFile({ APPDATA: 'C:/Users/x/AppData/Roaming' }, 'win32', '/unused')).toBe(
      path.join('C:/Users/x/AppData/Roaming', rel),
    );
  });

  it('parseEndpoint 只认合法 {port,token}，缺项/非法值判红（不回落默认值）', () => {
    expect(parseEndpoint(readOk(), 'e.json')).toEqual({
      port: 54321,
      token: 'tok-abc',
      host: HOST,
      path: '/mcp',
    });
    expect(() => parseEndpoint('{oops', 'e.json')).toThrow(ShimError);
    expect(() => parseEndpoint('{"token":"t"}', 'e.json')).toThrow(/port/);
    expect(() => parseEndpoint('{"port":54321}', 'e.json')).toThrow(/token/);
    expect(() => parseEndpoint('{"port":70000,"token":"t"}', 'e.json')).toThrow(/port/);
    expect(() => parseEndpoint('{"port":54321,"token":""}', 'e.json')).toThrow(/token/);
  });

  it('buildRequestOptions：仅回环 + Bearer + 回环 Origin + 单端点 POST /mcp', () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const o = buildRequestOptions(parseEndpoint(readOk(), 'e.json'), body);
    expect(o.hostname).toBe(HOST);
    expect(o.port).toBe(54321);
    expect(o.path).toBe('/mcp');
    expect(o.method).toBe('POST');
    expect(o.headers.authorization).toBe('Bearer tok-abc');
    expect(o.headers.origin).toBe(`http://${HOST}:54321`);
    expect(o.headers['content-type']).toBe('application/json');
    expect(o.headers['content-length']).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('失败分类给可执行提示；2xx 与通知空正文不算失败', () => {
    const refused = classifyFailure({ code: 'ECONNREFUSED' }, parseEndpoint(readOk(), 'e.json'));
    expect(refused).toBeInstanceOf(ShimError);
    expect(refused.hint).toContain('未启用 MCP 服务');
    expect(refused.exitCode).toBe(3);
    expect(classifyFailure(new Error('boom'), parseEndpoint(readOk(), 'e.json')).exitCode).toBe(3);
    expect(classifyStatus({ status: 200 })).toBeNull();
    expect(classifyStatus({ status: 202 })).toBeNull();
    expect(classifyStatus({ status: 401 }).hint).toContain('轮换 token');
    expect(classifyStatus({ status: 401 }).exitCode).toBe(4);
    expect(classifyStatus({ status: 503 }).exitCode).toBe(4);
  });

  it('responseFrames：单帧 JSON 归一一行、SSE 逐 data 转发、空正文不回帧', () => {
    expect(
      responseFrames({ status: 200, contentType: 'application/json', body: '{ "id": 1, "result": {} }' }),
    ).toEqual(['{"id":1,"result":{}}']);
    expect(
      responseFrames({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"id":1}\n\ndata: {"id":2}\n\ndata: [DONE]\n',
      }),
    ).toEqual(['{"id":1}', '{"id":2}']);
    expect(responseFrames({ status: 202, contentType: '', body: '' })).toEqual([]);
  });

  it('responseFrames：SSE 元数据行不进 stdout（真端点 event: message 回归护栏）', () => {
    // 真 Rust 端点形态：event: message\ndata: {...}\n\n；旧实现会把 event: 行当帧转发，
    // 每个请求污染一行非 JSON 文本，严格 stdio 客户端解析失败。
    expect(
      responseFrames({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: 'event: message\nid: 7\nretry: 1000\n: keepalive\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\ndata: [DONE]\n',
      }),
    ).toEqual(['{"jsonrpc":"2.0","id":7,"result":{}}']);
    // 非 SSE 的 NDJSON 逐行转发口径不回退。
    expect(
      responseFrames({ status: 200, contentType: 'application/x-ndjson', body: '{"id":1}\n{"id":2}\n' }),
    ).toEqual(['{"id":1}', '{"id":2}']);
  });
});

/* ------------------------------------------------------------------ *
 * ② runShim 注入式 transport seam
 * ------------------------------------------------------------------ */
interface Res {
  status: number;
  contentType?: string;
  body?: string;
}

function harness(over: {
  readFile?: () => Promise<string>;
  post?: (body: string, endpoint: any) => Promise<Res>;
  lines?: string[];
}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ body: string; endpoint: any }> = [];
  const io = {
    env: envWith('D:/tmp/mcp-endpoint.json'),
    readFile: over.readFile ?? (async () => readOk()),
    post:
      over.post ??
      (async (body: string, endpoint: any) => {
        calls.push({ body, endpoint });
        return { status: 200, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":{}}' };
      }),
    lines: over.lines ?? ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
    writeOut: (l: string) => out.push(l),
    writeErr: (m: string) => err.push(m),
  };
  return { io, out, err, calls };
}

describe('kojo-mcp · runShim 注入 seam', () => {
  it('成功：每行一帧进、每行一帧出，token 原样传给 transport', async () => {
    const h = harness({
      lines: [
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        '{"jsonrpc":"2.0","id":2,"method":"resources/list"}',
      ],
    });
    const code = await runShim(h.io);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.endpoint.token).toBe('tok-abc');
    expect(h.out).toHaveLength(2);
    expect(h.err).toEqual([]);
  });

  it('端点文件缺失：stderr 给可执行提示、exit 非 0、stdout 一字不留', async () => {
    const h = harness({ readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
    const code = await runShim(h.io);
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('编辑器可能未启用 MCP 服务');
    expect(h.out).toEqual([]);
  });

  it('连接失败（ECONNREFUSED）：exit 3 + 未启用提示，不静默重试', async () => {
    const h = harness({
      post: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); },
    });
    const code = await runShim(h.io);
    expect(code).toBe(3);
    expect(h.err.join('\n')).toContain('未启用 MCP 服务');
    expect(h.out).toEqual([]);
  });

  it('401：exit 4 + 轮换 token 提示；2xx 的 SSE 多帧逐行转发', async () => {
    const h401 = harness({ post: async () => ({ status: 401, body: '' }) });
    expect(await runShim(h401.io)).toBe(4);
    expect(h401.err.join('\n')).toContain('轮换 token');
    expect(h401.out).toEqual([]);

    const hSse = harness({
      post: async () => ({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"id":1}\n\ndata: {"id":2}\n',
      }),
    });
    expect(await runShim(hSse.io)).toBe(0);
    expect(hSse.out).toEqual(['{"id":1}', '{"id":2}']);
  });
});

/* ------------------------------------------------------------------ *
 * ③ 真实 HTTP 与进程级契约
 * ------------------------------------------------------------------ */
describe('kojo-mcp · 真实传输与进程契约', () => {
  it('createHttpPoster 打真本机 server：Bearer / Origin / POST /mcp 一个不少', async () => {
    let seen: { method?: string; url?: string; headers: any; body: string } | null = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
      const res = await createHttpPoster()(line, { port, token: 'tok-real', host: HOST, path: '/mcp' });
      expect(res.status).toBe(200);
      expect(responseFrames(res)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}']);
      expect(seen!.method).toBe('POST');
      expect(seen!.url).toBe('/mcp');
      expect(seen!.headers.authorization).toBe('Bearer tok-real');
      expect(seen!.body).toBe(line);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('真 CLI：端点文件缺失 ⇒ 非 0 + 可读提示 + stdout 空；端点在但无服务 ⇒ 连接失败也非 0', async () => {
    const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-mcp-miss-')), 'nope.json');
    const a = spawnSync(process.execPath, [CLI], {
      env: { ...process.env, KOJO_MCP_ENDPOINT_FILE: missing },
      input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(a.status).not.toBe(0);
    expect(a.stdout).toBe('');
    expect(a.stderr).toContain('端点文件');

    // 取一个确实没人监听的端口：连过去必 ECONNREFUSED / 超时族
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-mcp-refused-'));
    const epFile = path.join(dir, 'mcp-endpoint.json');
    await fs.writeFile(epFile, JSON.stringify({ port: freePort, token: 'tok-x' }), 'utf8');
    try {
      const b = spawnSync(process.execPath, [CLI], {
        env: { ...process.env, KOJO_MCP_ENDPOINT_FILE: epFile },
        input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(b.status).not.toBe(0);
      expect(b.stdout).toBe('');
      expect(b.stderr).toContain('未启用 MCP 服务');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * ④ 第三波：生产可用性（环境变量覆盖 / notification / 不泄漏 token）
 * ------------------------------------------------------------------ */
describe('kojo-mcp · 生产可用性（第三波）', () => {
  it('parseEndpointOverride：host:port / URL / 非法值判红，userinfo 丢弃', () => {
    expect(parseEndpointOverride('127.0.0.1:54321')).toEqual({ host: '127.0.0.1', port: 54321, path: '/mcp' });
    expect(parseEndpointOverride('localhost:9000/custom')).toEqual({ host: 'localhost', port: 9000, path: '/custom' });
    expect(parseEndpointOverride('http://127.0.0.1:7777/mcp')).toEqual({ host: '127.0.0.1', port: 7777, path: '/mcp' });
    expect(parseEndpointOverride('http://user:p@127.0.0.1:7001/mcp')).toEqual({ host: '127.0.0.1', port: 7001, path: '/mcp' });
    expect(() => parseEndpointOverride('')).toThrow(ShimError);
    expect(() => parseEndpointOverride('127.0.0.1')).toThrow(/端口/);
    expect(() => parseEndpointOverride('127.0.0.1:70000')).toThrow(/端口/);
  });

  it('resolveEndpoint：两变量齐备跳过发现文件、单变量覆盖、缺省只读文件', async () => {
    const base = JSON.stringify({ port: 54321, token: 'tok-file' });
    let readCalled = false;
    const both = await resolveEndpoint(
      { KOJO_MCP_ENDPOINT: '127.0.0.1:6001', KOJO_MCP_TOKEN: 'tok-env' },
      async () => {
        readCalled = true;
        throw new Error('不应读发现文件');
      },
    );
    expect(both).toEqual({ host: '127.0.0.1', port: 6001, path: '/mcp', token: 'tok-env' });
    expect(readCalled).toBe(false);

    const onlyEndpoint = await resolveEndpoint(
      { APPDATA: '/some/appdata', KOJO_MCP_ENDPOINT: '127.0.0.1:6002' },
      async () => base,
    );
    expect(onlyEndpoint).toMatchObject({ port: 6002, token: 'tok-file' });
    const onlyToken = await resolveEndpoint({ APPDATA: '/some/appdata', KOJO_MCP_TOKEN: 'tok-new' }, async () => base);
    expect(onlyToken).toMatchObject({ port: 54321, token: 'tok-new' });
    const fallback = await resolveEndpoint({ APPDATA: '/some/appdata' }, async () => base);
    expect(fallback).toEqual({ port: 54321, token: 'tok-file', host: HOST, path: '/mcp' });
  });

  it('token 绝不出现在 stdout / stderr / 失败提示里', async () => {
    const h = harness({
      readFile: async () => JSON.stringify({ port: 54321, token: 'SUPERSECRET-do-not-leak' }),
      post: async () => ({ status: 401, body: '' }),
    });
    expect(await runShim(h.io)).toBe(4);
    expect(h.out).toEqual([]);
    expect([...h.out, ...h.err].join('\n')).not.toContain('SUPERSECRET-do-not-leak');
    expect(h.err.join('\n')).toContain('轮换 token');
  });

  it('三类失败：发现(2) / 连接(3) / 鉴权(4) 都 stderr 可执行提示 + stdout 空', async () => {
    const miss = harness({ readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
    expect(await runShim(miss.io)).toBe(2);
    expect(miss.err.join('\n')).toContain('端点文件');
    expect(miss.out).toEqual([]);

    const conn = harness({ post: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
    expect(await runShim(conn.io)).toBe(3);
    expect(conn.err.join('\n')).toContain('未启用 MCP 服务');
    expect(conn.out).toEqual([]);

    const auth = harness({ post: async () => ({ status: 401, body: '' }) });
    expect(await runShim(auth.io)).toBe(4);
    expect(auth.err.join('\n')).toContain('轮换 token');
    expect(auth.out).toEqual([]);
  });
});
