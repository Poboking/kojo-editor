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
 *
 * MCP-PERF-S18（S8 三腿的镜像侧收口）：
 * - `deadlineMs`（S8 腿1）：宽时限 case 进矩阵（不许动命中账）+ 软时限账 partial/partialReason
 *   的 wire 形态在此单测收口（到点形状时变 ⇒ 不进手工真值）。Rust 侧 harness 只吃四枚固定
 *   options ⇒ 矩阵新键被 serde 忽略、按旧口径跑同真值；镜像侧 S18 起真认这个键。
 * - `preview:"none"`（S8 腿2）：镜像收口投影剥每条命中 preview 字段（与 MCP 腿
 *   stripPreviewFields 同尺：浅剥一格，line/column/start/end 原样保留）；行列真值照旧进矩阵，
 *   键缺席断言在本文件。
 * - `semantic.projectSymbols`（S8 腿3）：镜像命令面**没有**语义/符号投影命令（该脸读的是
 *   WebView 侧 erb.parser 内核服务，宿命令面不承载）⇒ query 过滤在镜像侧无从发生——
 *   如实标注的边界由专例钉死（将来镜像真投影了该脸，那条会红并逼出「同尺过滤」的补齐）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDebugServer, SUPPORTED_COMMANDS } from '../debug-server.mjs';

interface ParityFile {
  name: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'bytes';
  text?: string;
  bytes?: number[];
}

interface ParityCase {
  name: string;
  query: string;
  options: {
    isRegex: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    extensions: string[];
    /** S8 腿1（MCP-PERF-S18 镜像侧收口）：毫秒软时限；Rust harness 忽略此键。 */
    deadlineMs?: number;
    /** S8 腿2：命中载荷模式；"none" ⇒ 镜像收口投影剥 preview 字段。Rust harness 忽略此键。 */
    preview?: 'full' | 'none';
  };
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
        files: { path: string; matches: { line: number; column: number; preview?: string; start?: number; end?: number }[] }[];
        totalMatches: number;
        filesScanned: number;
        skipped: { binary: number };
        truncated: boolean;
        cancelled: boolean;
        partial?: boolean;
        partialReason?: string | null;
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
      // MCP-PERF-S18 腿1：宽时限不许动命中账（上面已断），软时限账还必须如实到场——
      // wire 形态与 Rust SearchResultDto 同形（partial 恒在；未到点 partialReason 恒 null）。
      // 镜像没实现 deadlineMs 时此键缺席 ⇒ 当场红（先红判据）。
      if (typeof c.options.deadlineMs === 'number') {
        expect(res.partial, `[${c.name}] 宽时限内软时限账 partial 应为 false（镜像 S18 起认 deadlineMs）`).toBe(false);
        expect(res.partialReason, `[${c.name}] 未到点 partialReason 应为 null`).toBeNull();
      }
      // MCP-PERF-S18 腿2：preview:"none" ⇒ 收口投影剥 preview 字段（与 MCP 腿 stripPreviewFields
      // 同尺：浅剥一格，line/column/start/end 原样保留）。镜像不认这个键时命中仍带 preview ⇒ 当场红。
      if (c.options.preview === 'none') {
        for (const f of res.files) {
          for (const m of f.matches) {
            expect('preview' in m, `[${c.name}] none 模式命中仍带 preview 键`).toBe(false);
            expect(typeof m.start, `[${c.name}] none 模式不许连 start 一起剥`).toBe('number');
            expect(typeof m.end, `[${c.name}] none 模式不许连 end 一起剥`).toBe('number');
          }
        }
      }
    });
  }
});

describe('MCP-PERF-S18 · 镜像软时限到点账（到点形状时变 ⇒ 不进矩阵手工真值，在此收口）', () => {
  it('deadlineMs:0 ⇒ 一批都不领：files [] / filesScanned 0 / partial:true + partialReason:"deadline"', async () => {
    // Rust 同尺（lib.rs）：到点**且**还有没扫到的文件才算 partial——0ms 恒在第一批领取前到点，
    // 夹具树 5 文件全没扫 ⇒ partial 必真。命中集时变不假，但「零领取」是确定性的。
    const res = (await invoke('search_text', {
      request: {
        searchId: 1,
        roots: [tree],
        query: 'needl',
        options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [], deadlineMs: 0 },
      },
    })) as { files: unknown[]; totalMatches: number; filesScanned: number; partial?: boolean; partialReason?: string | null };
    expect(res.partial, '0ms 软时限必须判到点（镜像没实现 ⇒ 此键缺席当场红）').toBe(true);
    expect(res.partialReason).toBe('deadline');
    expect(res.files).toEqual([]);
    expect(res.filesScanned).toBe(0);
    expect(res.totalMatches).toBe(0);
  });

  it('deadlineMs 缺省 ⇒ partial:false / partialReason:null 恒在（wire 形态与 Rust DTO 同形；旧行为零漂移锚）', async () => {
    const res = (await invoke('search_text', {
      request: {
        searchId: 1,
        roots: [tree],
        query: 'needl',
        options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] },
      },
    })) as { totalMatches: number; partial?: boolean; partialReason?: string | null };
    expect(res.totalMatches).toBe(4); // 旧行为没被本批改动碰歪
    expect(res.partial, '无时限应答的 partial 恒 false').toBe(false);
    expect(res.partialReason).toBeNull();
  });
});

describe('MCP-PERF-S18 · semantic.projectSymbols 的镜像边界（如实标注，非缺陷）', () => {
  it('镜像命令面没有语义/符号投影命令 ⇒ S8 腿3 的 query 过滤在镜像侧无从发生', () => {
    // 该脸读的是 WebView 侧 erb.parser 内核服务（real-sources-io 的 services.tryGet），
    // 宿命令面（generate_handler! ↔ 镜像命令表）不承载任何符号/语义命令 ⇒ 没有「镜像投影」
    // 可言，query 过滤天然不适用于镜像。这条钉死边界：将来镜像若真投影了符号脸，
    // 此处当场红，逼出「与 MCP 腿同尺过滤」的补齐——不许静默长出一张没过滤的符号脸。
    const symbolish = SUPPORTED_COMMANDS.filter((n) => /symbol|semantic|outline|projectSymbols/i.test(n));
    expect(symbolish, '镜像命令面不该有符号/语义命令（有了就必须同批补 query 过滤）').toEqual([]);
  });
});
