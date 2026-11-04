/**
 * 外部客户端接入产物（P5 / 路 B 第三波）的对拍用例。
 *
 * 校验四件事：
 *  ① `examples/mcp/*` 三份配置可解析（TOML 子集 / JSON）且都指向 shim；
 *  ② 任何示例都不内嵌真实 token / 密钥，也不写死端口；
 *  ③ shim 路径 `tools/kojo-mcp.mjs` 真实存在；
 *  ④ JSON-RPC notification 转发后不等待、不伪造响应、不挂住后续请求。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isNotificationFrame, runShim } from '../kojo-mcp.mjs';

const EXAMPLES = fileURLToPath(new URL('../../examples/mcp', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHIM = path.join(REPO_ROOT, 'tools', 'kojo-mcp.mjs');
const TOML_FILE = path.join(EXAMPLES, 'codex.toml');
const JSON_FILES = ['deepseek-harness.json', 'generic-mcp.json'].map((n) => path.join(EXAMPLES, n));

/**
 * 零依赖 mini TOML 子集解析：够校验 codex.toml 用到的
 * 整行注释 / `[section]` / `key = "string"` / `key = ["a", "b"]`。
 * 不新增外部 npm 依赖；解析不了的形状直接抛错（不静默）。
 */
function parseTomlSubset(src: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let section = '';
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1]!.trim();
      out[section] ??= {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`无法解析 TOML 行：${raw}`);
    const key = kv[1]!.trim();
    const val = kv[2]!.trim();
    let parsed: unknown;
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      parsed =
        inner === ''
          ? []
          : inner.split(',').map((chunk) => {
              const t = chunk.trim();
              const str = /^"([^"]*)"$/.exec(t) ?? /^'([^']*)'$/.exec(t);
              if (!str) throw new Error(`TOML 数组元素非字符串：${t}`);
              return str[1]!;
            });
    } else {
      const str = /^"([^"]*)"$/.exec(val) ?? /^'([^']*)'$/.exec(val);
      if (str) parsed = str[1]!;
      else if (val === 'true' || val === 'false') parsed = val === 'true';
      else if (/^\d+$/.test(val)) parsed = Number(val);
      else throw new Error(`不支持的 TOML 值：${val}`);
    }
    (out[section] ??= {})[key] = parsed;
  }
  return out;
}

/** 检测内嵌密钥：Bearer 实值 / token 类键带非占位实值 / 长随机串。`<...>` 占位允许。 */
function assertNoEmbeddedSecret(name: string, src: string): void {
  expect(src, `${name}: 不得出现 Bearer 实值`).not.toMatch(/Bearer\s+[A-Za-z0-9+/=_-]{8,}/);
  const secretKey = /["']?(?:token|secret|api[_-]?key|password|authorization)["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const m of src.matchAll(secretKey)) {
    expect(m[1], `${name}: 键 ${m[0]} 疑似内嵌密钥`).toMatch(/^</);
  }
  expect(src, `${name}: 不得出现长随机串（疑似密钥）`).not.toMatch(/[A-Za-z0-9+/=_-]{40,}/);
}

describe('P5 示例配置：可解析、指向 shim、无内嵌密钥', () => {
  it('shim 路径 tools/kojo-mcp.mjs 真实存在', async () => {
    const st = await fs.stat(SHIM);
    expect(st.isFile()).toBe(true);
  });

  it('codex.toml 可解析：[mcp_servers.kojo-editor] 指向 node + tools/kojo-mcp.mjs', async () => {
    const src = await fs.readFile(TOML_FILE, 'utf8');
    const doc = parseTomlSubset(src);
    const srv = doc['mcp_servers.kojo-editor'];
    expect(srv).toBeDefined();
    expect(srv!.command).toBe('node');
    expect(srv!.args).toContain('tools/kojo-mcp.mjs');
    assertNoEmbeddedSecret('codex.toml', src);
  });

  it.each(JSON_FILES)('%s 可 JSON.parse、mcpServers 指向 shim、cwd 非绝对机器路径', async (file) => {
    const src = await fs.readFile(file, 'utf8');
    const doc = JSON.parse(src) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    const srv = doc.mcpServers['kojo-editor'];
    expect(srv).toBeDefined();
    expect(srv!.command).toBe('node');
    expect(srv!.args).toContain('tools/kojo-mcp.mjs');
    if (srv!.cwd !== undefined) expect(path.isAbsolute(srv!.cwd)).toBe(false);
    assertNoEmbeddedSecret(path.basename(file), src);
  });

  it('examples/mcp 下每个文件都无内嵌密钥、且不含写死端口赋值', async () => {
    for (const name of await fs.readdir(EXAMPLES)) {
      const src = await fs.readFile(path.join(EXAMPLES, name), 'utf8');
      assertNoEmbeddedSecret(name, src);
      expect(src, `${name}: 不得写死 port`).not.toMatch(/["']port["']\s*[:=]\s*\d{4,5}/);
    }
  });
});

describe('P5 shim：notification 转发后不等待、不伪造响应、不挂住 stdio', () => {
  it('isNotificationFrame：无 id / id:null / notifications/* 为真，带 id 为假', () => {
    expect(isNotificationFrame('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBe(true);
    expect(isNotificationFrame('{"jsonrpc":"2.0","id":null,"method":"x"}')).toBe(true);
    expect(isNotificationFrame('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toBe(false);
    expect(isNotificationFrame('not json')).toBe(false);
  });

  it('notification 的 POST 永不 settle 时，runShim 仍返回 0、不写合成帧、后续请求正常', async () => {
    let release!: (v: { status: number; contentType?: string; body?: string }) => void;
    const held = new Promise<{ status: number; contentType?: string; body?: string }>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const post = async (body: string) => {
      calls.push(body);
      const msg = JSON.parse(body) as { id?: number };
      if (msg.id === undefined) return held; // notification：先不 settle，证明 shim 不等它
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }),
      };
    };
    const io = {
      // 两变量齐备 ⇒ resolveEndpoint 完全跳过发现文件（顺带验证环境变量覆盖不读盘）
      env: { KOJO_MCP_ENDPOINT: '127.0.0.1:54321', KOJO_MCP_TOKEN: 'tok-from-env' },
      readFile: async () => {
        throw new Error('不应读发现文件');
      },
      post,
      lines: [
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
      ],
      writeOut: (l: string) => out.push(l),
      writeErr: (m: string) => err.push(m),
    };
    const code = await runShim(io);
    release({ status: 202, body: '' }); // 清掉悬挂 promise
    expect(code).toBe(0);
    expect(calls).toHaveLength(2); // notification 确实被转发
    expect(out).toEqual(['{"jsonrpc":"2.0","id":7,"result":{"ok":true}}']); // 没有合成响应帧
    expect(err).toEqual([]);
  });
});
