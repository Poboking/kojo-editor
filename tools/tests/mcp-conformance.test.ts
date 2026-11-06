/**
 * `tools/mcp-conformance.mjs`（MCP 端到端协议一致性 harness，路 B3）的用例。
 *
 * 两组覆盖 + 一组写工具靶：
 *  ① direct 通道：起共享 mock endpoint，用 node:http 直打——initialize 形状 / tier 过滤
 *     （privileged 默认不在 tools/list）/ batch 中 notification 无响应 / 错误帧
 *     （-32601 / -32602 / 结构化）/ Bearer 拒绝 / Origin 拒绝 / SSE 可选 / Accept 协商 / 单端点。
 *  ①b 写工具靶：mock.write（tier edit + requiresApproval）/ mock.privilegedWrite（tier privileged）——
 *     写靶即使 edit 档也须逐工具批准（-32000 TOOL_NOT_APPROVED）；批准命中才执行且 payload
 *     只记内存 ep.writes（逐字对拍，绝不写盘）；privileged 写靶默认不进 tools/list、猜名直调
 *     显式拒绝（闸序与真端点同源：危险面 TOOL_NOT_APPROVED 先于 tier 码 E_TIER_DENIED，
 *     tier 码字面与 Rust codes::TIER_DENIED 一套口径）；大响应截到 TOOL_TEXT_LIMIT + truncated 显式标记（记录不裁）。
 *  ② 端到端通道：跑一次 `runConformance()`（spawn 真实 `tools/kojo-mcp.mjs`），断言
 *     notification 不挂住 stdio、SSE 逐帧转发、坏帧显式终结、token 不泄漏、全表 0 FAIL
 *     （31 direct + 7 write-target + 15 stdio + 1 hygiene = 54 条，W01..W07 全 PASS）。
 *
 * 红线对拍：mock 三道闸缺一不可（仅回环 + Bearer + Origin 白名单）；token 不进
 * stdout / stderr / 日志 / 请求摘要。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  buildSessions,
  createMockEndpoint,
  httpRequest,
  parseSseFrames,
  PROTOCOL_VERSION,
  runConformance,
  TOOL_TEXT_LIMIT,
} from '../mcp-conformance.mjs';

const TEST_TOKENS = {
  read: 'tok-conf-read-aaaa',
  edit: 'tok-conf-edit-bbbb',
  priv: 'tok-conf-priv-cccc',
  approved: 'tok-conf-approved-dddd',
  writeApproved: 'tok-conf-write-eeee',
  privWriteApproved: 'tok-conf-privw-ffff',
};

let ep: ReturnType<typeof createMockEndpoint>;

beforeAll(async () => {
  ep = createMockEndpoint({ sessions: buildSessions(TEST_TOKENS) });
  await ep.listen();
});

afterAll(async () => {
  await ep.close();
});

const direct = (o: Record<string, unknown>) => httpRequest({ port: ep.port, ...o } as never);
const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

/* ------------------------------------------------------------------ *
 * ① direct 通道：mock endpoint 协议面
 * ------------------------------------------------------------------ */
describe('mcp-conformance · direct 通道（mock endpoint 协议面）', () => {
  it('initialize 形状：旧握手兼容、协议版本、capabilities、自报 mock 的 serverInfo', async () => {
    const res = await direct({
      token: TEST_TOKENS.read,
      body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'conf', version: '0' } }),
    });
    expect(res.status).toBe(200);
    const f = JSON.parse(res.body);
    expect(f.jsonrpc).toBe('2.0');
    expect(f.id).toBe(1);
    expect(f.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(f.result.capabilities.tools).toEqual({ listChanged: false });
    expect(f.result.capabilities.resources.subscribe).toBe(false); // P5 边界：不订阅
    expect(f.result.capabilities.prompts).toEqual({ listChanged: false });
    expect(f.result.serverInfo.name).toContain('mock');
  });

  it('tier 过滤：read 会话不见 edit/privileged；edit 会话加 edit；privileged 才全量', async () => {
    const read = JSON.parse((await direct({ token: TEST_TOKENS.read, body: rpc(2, 'tools/list') })).body);
    const readNames = read.result.tools.map((t: { name: string }) => t.name);
    expect(readNames).toContain('mock.read.tool');
    expect(readNames).not.toContain('mock.edit.tool');
    expect(readNames).not.toContain('mock.priv.tool'); // privileged 默认不在 tools/list

    const edit = JSON.parse((await direct({ token: TEST_TOKENS.edit, body: rpc(3, 'tools/list') })).body);
    const editNames = edit.result.tools.map((t: { name: string }) => t.name);
    expect(editNames).toContain('mock.edit.tool');
    expect(editNames).not.toContain('mock.priv.tool');

    const priv = JSON.parse((await direct({ token: TEST_TOKENS.priv, body: rpc(4, 'tools/list') })).body);
    expect(priv.result.tools).toHaveLength(7); // 5 探针 + mock.write + mock.privilegedWrite
  });

  it('batch 中 notification 无响应：混合 batch 只回 2 帧；纯 notification batch → 202 空体', async () => {
    const mixed = await direct({
      token: TEST_TOKENS.read,
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 101, method: 'tools/list' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 102, method: 'ping' },
      ]),
    });
    expect(mixed.status).toBe(200);
    const arr = JSON.parse(mixed.body);
    expect(arr).toHaveLength(2);
    expect(arr.map((f: { id: number }) => f.id).sort()).toEqual([101, 102]);

    const pure = await direct({
      token: TEST_TOKENS.read,
      body: JSON.stringify([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]),
    });
    expect(pure.status).toBe(202);
    expect(pure.body).toBe('');
  });

  it('错误帧：未知 method -32601 / 参数错 -32602 / 结构化错误（data.code）', async () => {
    const unknownMethod = JSON.parse((await direct({ token: TEST_TOKENS.read, body: rpc(5, 'mock/nope.method') })).body);
    expect(unknownMethod.error.code).toBe(-32601);
    expect(unknownMethod.error.data.code).toBe('METHOD_NOT_FOUND');

    const unknownTool = JSON.parse(
      (await direct({ token: TEST_TOKENS.read, body: rpc(6, 'tools/call', { name: 'mock.nope.tool' }) })).body,
    );
    expect(unknownTool.error.code).toBe(-32602);
    expect(unknownTool.error.data.code).toBe('UNKNOWN_TOOL');

    const invalidArgs = JSON.parse((await direct({ token: TEST_TOKENS.read, body: rpc(7, 'tools/call', {}) })).body);
    expect(invalidArgs.error.code).toBe(-32602);
    expect(invalidArgs.error.data.code).toBe('INVALID_ARGS');

    const structured = JSON.parse(
      (await direct({ token: TEST_TOKENS.read, body: rpc(8, 'tools/call', { name: 'mock.fail.tool' }) })).body,
    );
    expect(structured.error.code).toBe(-32000);
    expect(structured.error.data.code).toBe('MOCK_FAILURE');
    expect(structured.error.data.retryable).toBe(false);

    const tierDenied = JSON.parse(
      (await direct({ token: TEST_TOKENS.read, body: rpc(9, 'tools/call', { name: 'mock.edit.tool', arguments: { path: 'x' } }) })).body,
    );
    expect(tierDenied.error.data.code).toBe('E_TIER_DENIED');

    const notApproved = JSON.parse(
      (await direct({ token: TEST_TOKENS.priv, body: rpc(10, 'tools/call', { name: 'mock.priv.tool' }) })).body,
    );
    expect(notApproved.error.data.code).toBe('TOOL_NOT_APPROVED');
  });

  it('Bearer 拒绝：缺 token / 错 token → 401 + WWW-Authenticate（且请求记录不含 token 值）', async () => {
    const missing = await direct({ body: rpc(11, 'ping') });
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body).error.code).toBe('UNAUTHORIZED');

    const wrong = await direct({ token: 'wrong-token-value', body: rpc(12, 'ping') });
    expect(wrong.status).toBe(401);
    expect(String(wrong.headers['www-authenticate'])).toContain('Bearer');

    ep.requests.forEach((r: { hasAuth: boolean }) => {
      expect(r.hasAuth).toBeTypeOf('boolean'); // 摘要只记布尔
    });
  });

  it('Origin 拒绝：缺 Origin / 伪造 Origin → 403（三道闸之三）', async () => {
    const noOrigin = await direct({ token: TEST_TOKENS.read, headers: { origin: '' }, body: rpc(13, 'ping') });
    expect(noOrigin.status).toBe(403);
    expect(JSON.parse(noOrigin.body).error.code).toBe('ORIGIN_NOT_ALLOWED');

    const evil = await direct({
      token: TEST_TOKENS.read,
      headers: { origin: 'http://evil.example:9999' },
      body: rpc(14, 'ping'),
    });
    expect(evil.status).toBe(403);
  });

  it('SSE 可选：Accept 含 event-stream → SSE；纯 JSON → JSON 单帧；batch SSE 多帧', async () => {
    const sse = await direct({
      token: TEST_TOKENS.read,
      accept: 'application/json, text/event-stream',
      body: rpc(15, 'prompts/get', { name: 'mock.prompt', arguments: { topic: 'vitest' } }),
    });
    expect(sse.contentType).toContain('text/event-stream');
    const frames = parseSseFrames(sse.body);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const f = JSON.parse(frames[0]);
    expect(f.id).toBe(15);
    expect(f.result.messages[0].content.text).toContain('vitest');

    const jsonOnly = await direct({ token: TEST_TOKENS.read, accept: 'application/json', body: rpc(16, 'ping') });
    expect(jsonOnly.contentType).toContain('application/json');
    expect(JSON.parse(jsonOnly.body).id).toBe(16);

    const batchSse = await direct({
      token: TEST_TOKENS.read,
      accept: 'application/json, text/event-stream',
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 201, method: 'ping' },
        { jsonrpc: '2.0', id: 202, method: 'ping' },
      ]),
    });
    expect(batchSse.contentType).toContain('text/event-stream');
    const multi = parseSseFrames(batchSse.body).map((s) => JSON.parse(s));
    expect(multi).toHaveLength(2);
    expect(multi.map((x: { id: number }) => x.id)).toEqual([201, 202]);
  });

  it('单端点闸：GET /mcp → 405、其它路径 → 404、非法 JSON → 400 + -32700', async () => {
    expect((await direct({ method: 'GET', token: TEST_TOKENS.read, body: '' })).status).toBe(405);
    expect((await direct({ urlPath: '/invoke', token: TEST_TOKENS.read, body: rpc(17, 'ping') })).status).toBe(404);
    const bad = await direct({ token: TEST_TOKENS.read, body: 'not json' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe(-32700);
  });

  it('resources/read 截断：大资源 text 截到上限 + 显式 truncated；未知 URI -32002', async () => {
    const big = JSON.parse(
      (await direct({ token: TEST_TOKENS.read, body: rpc(18, 'resources/read', { uri: 'mock://res/big' }) })).body,
    );
    expect(big.result.contents[0].text).toHaveLength(1000);
    expect(big.result.contents[0].truncated).toBe(true);

    const small = JSON.parse(
      (await direct({ token: TEST_TOKENS.read, body: rpc(19, 'resources/read', { uri: 'mock://res/small' }) })).body,
    );
    expect(small.result.contents[0].truncated).toBe(false);

    const unknown = JSON.parse(
      (await direct({ token: TEST_TOKENS.read, body: rpc(20, 'resources/read', { uri: 'mock://res/nope' }) })).body,
    );
    expect(unknown.error.code).toBe(-32002);
    expect(unknown.error.data.code).toBe('UNKNOWN_RESOURCE');
  });
});

/* ------------------------------------------------------------------ *
 * ①b 写工具靶：mock.write（tier edit + requiresApproval）/ mock.privilegedWrite（tier privileged）
 * ------------------------------------------------------------------ */
describe('mcp-conformance · 写工具靶（mock.write / mock.privilegedWrite）', () => {
  it('tools/list：edit 会话见 mock.write；privileged 写靶默认缺席；read 会话两者都不可见', async () => {
    const read = JSON.parse((await direct({ token: TEST_TOKENS.read, body: rpc(31, 'tools/list') })).body);
    const readNames = read.result.tools.map((t: { name: string }) => t.name);
    expect(readNames).not.toContain('mock.write');
    expect(readNames).not.toContain('mock.privilegedWrite');

    const edit = JSON.parse((await direct({ token: TEST_TOKENS.edit, body: rpc(32, 'tools/list') })).body);
    const editNames = edit.result.tools.map((t: { name: string }) => t.name);
    expect(editNames).toContain('mock.write');
    expect(editNames).not.toContain('mock.privilegedWrite'); // privileged 默认不进 tools/list

    const priv = JSON.parse((await direct({ token: TEST_TOKENS.priv, body: rpc(33, 'tools/list') })).body);
    const privNames = priv.result.tools.map((t: { name: string }) => t.name);
    expect(privNames).toContain('mock.privilegedWrite');
  });

  it('mock.write 未批准 → -32000 TOOL_NOT_APPROVED，且不记录 payload', async () => {
    const before = ep.writes.length;
    const res = JSON.parse(
      (
        await direct({
          token: TEST_TOKENS.edit,
          body: rpc(34, 'tools/call', { name: 'mock.write', arguments: { path: 'notes/a.txt', content: 'unapproved' } }),
        })
      ).body,
    );
    expect(res.error.code).toBe(-32000);
    expect(res.error.data.code).toBe('TOOL_NOT_APPROVED');
    expect(res.error.data.tool).toBe('mock.write');
    expect(ep.writes.length).toBe(before); // 未批准不执行
  });

  it('mock.write 批准后执行：payload 逐字记进 ep.writes；小响应 truncated=false', async () => {
    const res = JSON.parse(
      (
        await direct({
          token: TEST_TOKENS.writeApproved,
          body: rpc(35, 'tools/call', { name: 'mock.write', arguments: { path: 'notes/b.txt', content: 'hello-vitest' } }),
        })
      ).body,
    );
    expect(res.result.structuredContent.truncated).toBe(false);
    expect(res.result.structuredContent.contentLength).toBe('hello-vitest'.length);
    const rec = ep.writes.at(-1) as { tool: string; payload: { path: string; content: string }; truncated: boolean };
    expect(rec.tool).toBe('mock.write');
    expect(rec.payload.path).toBe('notes/b.txt');
    expect(rec.payload.content).toBe('hello-vitest');
    expect(rec.truncated).toBe(false);
  });

  it('mock.write 大 payload：响应 text 截到 TOOL_TEXT_LIMIT + truncated=true；记录仍完整', async () => {
    const big = 'MOCKVITEST.'.repeat(300); // 3300 字符 > TOOL_TEXT_LIMIT
    const res = JSON.parse(
      (
        await direct({
          token: TEST_TOKENS.writeApproved,
          body: rpc(36, 'tools/call', { name: 'mock.write', arguments: { path: 'notes/big.txt', content: big } }),
        })
      ).body,
    );
    expect(res.result.content[0].text).toHaveLength(TOOL_TEXT_LIMIT);
    expect(res.result.structuredContent.truncated).toBe(true);
    const rec = ep.writes.at(-1) as { tool: string; payload: { content: string }; truncated: boolean };
    expect(rec.payload.content).toBe(big); // 截断只裁响应，记录完整
    expect(rec.truncated).toBe(true);
  });

  it('mock.privilegedWrite：read/edit 猜名直调 TOOL_NOT_APPROVED（危险面先于 tier 码）；批准后执行 + 记录', async () => {
    const before = ep.writes.length;
    const tierRead = JSON.parse((await direct({ token: TEST_TOKENS.read, body: rpc(37, 'tools/call', { name: 'mock.privilegedWrite' }) })).body);
    expect(tierRead.error.data.code).toBe('TOOL_NOT_APPROVED');
    const tierEdit = JSON.parse((await direct({ token: TEST_TOKENS.edit, body: rpc(38, 'tools/call', { name: 'mock.privilegedWrite' }) })).body);
    expect(tierEdit.error.data.code).toBe('TOOL_NOT_APPROVED');
    expect(tierEdit.error.data.tool).toBe('mock.privilegedWrite');

    const notApproved = JSON.parse((await direct({ token: TEST_TOKENS.priv, body: rpc(39, 'tools/call', { name: 'mock.privilegedWrite' }) })).body);
    expect(notApproved.error.data.code).toBe('TOOL_NOT_APPROVED');
    expect(ep.writes.length).toBe(before);

    const ok = JSON.parse(
      (
        await direct({
          token: TEST_TOKENS.privWriteApproved,
          body: rpc(40, 'tools/call', { name: 'mock.privilegedWrite', arguments: { path: 'notes/c.txt', content: 'approved-write' } }),
        })
      ).body,
    );
    expect(ok.result.structuredContent.tool).toBe('mock.privilegedWrite');
    const rec = ep.writes.at(-1) as { tool: string; payload: { path: string; content: string } };
    expect(rec.tool).toBe('mock.privilegedWrite');
    expect(rec.payload.path).toBe('notes/c.txt');
    expect(rec.payload.content).toBe('approved-write');
  });

  it('卫生：写靶 payload 只进内存 ep.writes，请求摘要与泄漏面不含 payload 值', async () => {
    expect(ep.writes.length).toBeGreaterThan(0);
    // 请求摘要保持「只有布尔/元数据」形状：不含 authorization 键，也不含写靶 payload 字面量
    expect(JSON.stringify(ep.requests)).not.toContain('hello-vitest');
    for (const req of ep.requests) {
      expect(Object.keys(req).some((k) => k.toLowerCase().includes('authorization'))).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * ② 端到端通道：runConformance（spawn 真实 stdio shim，一次跑全表）
 * ------------------------------------------------------------------ */
describe('mcp-conformance · 端到端通道（真实 stdio shim）', () => {
  let r: Awaited<ReturnType<typeof runConformance>>;
  const rowOf = (id: string) => r.rows.find((x) => x.id === id);

  beforeAll(async () => {
    r = await runConformance({ tokens: TEST_TOKENS });
  }, 30_000);

  it('全表 0 FAIL（31 direct + 7 write-target + 15 stdio + 1 hygiene = 54 条）', () => {
    expect(r.rows).toHaveLength(54);
    expect(r.failed).toBe(0);
    expect(r.tokenLeak).toBe(false);
  });

  it('写工具靶 W01..W07 全 PASS（写面授权语义进入对拍表）', () => {
    for (let i = 1; i <= 7; i++) {
      const row = rowOf(`W0${i}`);
      expect(row, `W0${i} 应存在于对拍表`).toBeTruthy();
      expect(row?.pass, `W0${i} 应 PASS：${row?.detail ?? ''}`).toBe(true);
    }
  });

  it('notification 不挂住 stdio：S02/S05/S06 转发计数正确、ping 未被挂住', () => {
    expect(rowOf('S02')?.pass).toBe(true);
    expect(rowOf('S05')?.pass).toBe(true);
    expect(rowOf('S06')?.pass).toBe(true);
    expect(rowOf('S05')?.detail).toContain('未被挂住');
  });

  it('tier 过滤端到端：S03 中 privileged/edit 不在 shim 收到的 tools/list', () => {
    expect(rowOf('S03')?.pass).toBe(true);
    expect(rowOf('S03')?.detail).toContain('privileged 默认缺席');
  });

  it('SSE 与错误帧端到端：S11（SSE 逐帧转发）/ S12（结构化错误透传）/ S13（-32601 透传）', () => {
    expect(rowOf('S11')?.pass).toBe(true);
    expect(rowOf('S12')?.pass).toBe(true);
    expect(rowOf('S13')?.pass).toBe(true);
  });

  it('坏帧显式终结：S15 exit 4 + stderr 提示（不静默）', () => {
    expect(rowOf('S15')?.pass).toBe(true);
    expect(rowOf('S15')?.detail).toContain('exit=4');
  });

  it('token 不泄漏：全部输出 / shim stdout/stderr / 请求摘要均无 4 个 token 字面量', () => {
    const surfaces = [
      r.logs.join('\n'),
      r.shimStdout,
      r.shimStderr,
      JSON.stringify(r.requests),
      r.rows.map((x) => `${x.title} ${x.detail}`).join('\n'),
    ].join('\n');
    for (const t of Object.values(TEST_TOKENS)) {
      expect(surfaces, `token 泄漏于泄漏面`).not.toContain(t);
    }
    expect(r.tokenLeak).toBe(false);
  });

  it('mock 只记请求摘要，不记 token 值（serialize 后无 token 字面量）', () => {
    expect(JSON.stringify(r.requests)).not.toContain(TEST_TOKENS.read);
    for (const req of r.requests) {
      expect(Object.keys(req).some((k) => k.toLowerCase().includes('authorization'))).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * ③ 结构性红线：仅回环绑定
 * ------------------------------------------------------------------ */
describe('mcp-conformance · 结构性红线', () => {
  it('mock endpoint 只 bind 127.0.0.1（listen 地址断言）', async () => {
    const probe = createMockEndpoint({ sessions: buildSessions(TEST_TOKENS) });
    await probe.listen();
    try {
      expect((probe.server.address() as AddressInfo).address).toBe('127.0.0.1');
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: probe.port, path: '/mcp', method: 'POST', headers: { 'content-length': 2 } },
          (rs) => {
            rs.resume();
            rs.on('end', () => resolve({ status: rs.statusCode ?? 0 }));
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(res.status).toBe(403); // 闸序：无 Origin 先撞 Origin 闸（403），未到 Bearer 闸
      const res2 = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: probe.port,
            path: '/mcp',
            method: 'POST',
            headers: { 'content-length': 2, origin: `http://127.0.0.1:${probe.port}` },
          },
          (rs) => {
            rs.resume();
            rs.on('end', () => resolve({ status: rs.statusCode ?? 0 }));
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(res2.status).toBe(401); // Origin 放行后缺 Bearer → 401（三道闸之二）
    } finally {
      await probe.close();
    }
  });
});