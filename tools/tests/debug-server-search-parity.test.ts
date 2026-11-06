/**
 * MCP-PERF-S1 · Rust ↔ Node 调试宿镜像**同查询同结果对拍**。
 *
 * 共享对拍矩阵 = `packages/app/tests/fixtures/search-parity-matrix.json`（一份合同，
 * 两侧消费）：本测试与 Rust 引擎测试（`packages/app/src-tauri/src/search_tests.rs` 的
 * `parity_matrix_same_query_same_results_as_the_node_mirror`）各按矩阵建**同一棵**夹具树、
 * 跑**同一批**查询、断言**同一份**解析式手工真值（列号 = UTF-16 码元 +1，与 Monaco 同轴）。
 * 期望值不出自任何一侧引擎 ⇒ 哪一侧漂了哪一侧红；两侧同时绿 = 同查询同结果。
 *
 * 账面口径：path（文件名）→ line+column 命中账 + totalMatches + binary 跳过数 +
 * filesScanned。预览 / start / end 不进账：镜像预览窗是 200 字符 ±80、Rust 是 240 单元
 * 居中——已知的表现层分叉（呈现口径，非命中口径）。遗留族编码（shift_jis/gbk/big5）
 * 不进账：镜像 decoderFor 只认 BOM 与 utf-8，遗留族解码是镜像的已知缺口。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDebugServer } from '../debug-server.mjs';

interface ParityFile {
  name: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'bytes';
  text?: string;
  bytes?: number[];
}

interface ParityCase {
  name: string;
  query: string;
  options: { isRegex: boolean; caseSensitive: boolean; wholeWord: boolean; extensions: string[] };
  expect: {
    files: { path: string; hits: [number, number][] }[];
    totalMatches: number;
    binary: number;
    filesScanned: number;
  };
}

interface ParityMatrix {
  files: ParityFile[];
  cases: ParityCase[];
}

/** 与 Rust 侧 `parity_bytes` 逐字同形的编码档 writer（BOM 前缀、UTF-16LE 单元）。 */
function parityBytes(f: ParityFile): Buffer {
  switch (f.encoding) {
    case 'utf-8':
      return Buffer.from(f.text ?? '', 'utf-8');
    case 'utf-8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(f.text ?? '', 'utf-8')]);
    case 'utf-16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.text ?? '', 'utf16le')]);
    case 'bytes':
      return Buffer.from(f.bytes ?? []);
    default:
      throw new Error(`对拍矩阵出现未知编码档 ${String((f as { encoding: unknown }).encoding)}`);
  }
}

const matrixPath = path.resolve(__dirname, '../../packages/app/tests/fixtures/search-parity-matrix.json');
const matrix = JSON.parse(await fs.readFile(matrixPath, 'utf-8')) as ParityMatrix;

const tmpRoot = path.join(os.tmpdir(), `kojo-search-parity-${process.pid}`);
let base = '';
let server: Awaited<ReturnType<typeof createDebugServer>>;
let tree = '';

async function invoke(cmd: string, args?: Record<string, unknown>) {
  const res = await fetch(`${base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'invoke failed');
  return body.value as Record<string, unknown>;
}

beforeAll(async () => {
  tree = path.join(tmpRoot, 'tree');
  await fs.mkdir(tree, { recursive: true });
  for (const f of matrix.files) await fs.writeFile(path.join(tree, f.name), parityBytes(f));
  server = await createDebugServer({ port: 0, sandbox: tmpRoot, appdata: tmpRoot, log: () => {} });
  base = `http://127.0.0.1:${server.port}`;
}, 30000);

afterAll(async () => {
  await server.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('MCP-PERF-S1 · Rust ↔ Node 镜像检索对拍', () => {
  for (const c of matrix.cases) {
    it(`[${c.name}] 同查询同结果（矩阵期望 = 解析式真值）`, async () => {
      const res = (await invoke('search_text', {
        request: {
          searchId: 1,
          roots: [tree],
          query: c.query,
          options: c.options,
        },
      })) as {
        files: { path: string; matches: { line: number; column: number }[] }[];
        totalMatches: number;
        filesScanned: number;
        skipped: { binary: number };
        truncated: boolean;
        cancelled: boolean;
      };
      expect(res.truncated, '对拍夹具不许触墙').toBe(false);
      expect(res.cancelled, '对拍夹具不许取消').toBe(false);
      expect(res.skipped.binary, `[${c.name}] binary 跳过数与合同不同`).toBe(c.expect.binary);
      expect(res.filesScanned, `[${c.name}] filesScanned 与合同不同`).toBe(c.expect.filesScanned);
      expect(res.totalMatches, `[${c.name}] totalMatches 与合同不同`).toBe(c.expect.totalMatches);
      const got = res.files.map((f) => ({
        path: path.basename(f.path),
        hits: f.matches.map((m) => [m.line, m.column] as [number, number]),
      }));
      const want = c.expect.files.map((f) => ({ path: f.path, hits: f.hits }));
      expect(got, `[${c.name}] 命中账与合同不同`).toEqual(want);
    });
  }
});
