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
 *
 * MCP-PERF-S21（分诊账维度）：expect 全 case 增补 tooLarge/unreadable/filtered/excluded 四键，
 * 与 binary 合成 SearchSkippedDto 五键**逐位**对拍（Rust harness serde 忽略新键，只读消费不动）。
 * 分诊因里 ACL 权限与符号链接在 JSON 矩阵里表达不了 ⇒ 本文件专设 describe 用本地夹具收口
 * （Rust 判据 = lib.rs 的 count_walk_error / Unreadable / `!ft.is_file()` 只读引文；
 *  icacls deny 与 fs.symlink 在非 Windows / 无开发者模式的机器上造不出 ⇒ skip 并如实记录）。
 * MCP-PERF-S20（B18 引擎腿的镜像侧收口）：`options.resumeAfterMatches` 逐段续取凭据 +
 * `resumeAppliedMatches` 对账回显，镜像与 B18 引擎同尺（每文件先丢 N 条、每次调用每文件
 * 仍 ≤ SEARCH_PER_FILE_CAP(500)、回显 = 实际丢弃之和）。dense-file case 不进共享矩阵——
 * Rust 侧 harness 只吃四枚固定 options（新键被 serde 忽略）⇒ 复用矩阵会造出「两侧必然
 * 分叉」的假案；照 B18 判据形态（`resume_pages_under_the_leg_page_math_*`）用**腿的取页
 * 算术 × 镜像引擎**逐页走到穷尽，与解析式手工真值逐条同序比对。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
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
    /** MCP-PERF-S21 分诊账五键的其余四键（缺席 = 0；Rust harness serde 忽略，只读消费） */
    tooLarge?: number;
    unreadable?: number;
    filtered?: number;
    excluded?: number;
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
        skipped: {
          binary: number;
          tooLarge?: number;
          unreadable?: number;
          filtered?: number;
          excluded?: number;
        };
        truncated: boolean;
        cancelled: boolean;
        partial?: boolean;
        partialReason?: string | null;
      };
      expect(res.truncated, '对拍夹具不许触墙').toBe(false);
      expect(res.cancelled, '对拍夹具不许取消').toBe(false);
      // MCP-PERF-S21：分诊账五键逐位（缺键按 0 记账——镜像没发这键 = 旧宿漂移，当场红）
      const ledger: [string, number][] = [
        ['binary', c.expect.binary],
        ['tooLarge', c.expect.tooLarge ?? 0],
        ['unreadable', c.expect.unreadable ?? 0],
        ['filtered', c.expect.filtered ?? 0],
        ['excluded', c.expect.excluded ?? 0],
      ];
      for (const [key, want] of ledger) {
        expect(
          res.skipped[key as keyof typeof res.skipped] ?? 0,
          `[${c.name}] skipped.${key} 与合同不同`,
        ).toBe(want);
      }
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

/* ---------------- MCP-PERF-S21 · 分诊账本机可造因（ACL 权限 / 符号链接） ----------------
 *
 * 这些因进不了共享矩阵（JSON 表达不了 ACL / symlink），在此用本地夹具与 **Rust 判据引文**
 * 对拍（lib.rs 只读消费，本批不改 Rust）：
 * - 目录读不了（权限 / 句柄）：`read_dir` Err → `count_walk_error` → `skipped.unreadable` +1
 *   ——镜像侧同账 = walkFiles 的 readdir 失败**必须计数**，不许静默吞成空名单；
 * - 文件读不了（ACL 收紧）：`fs::read` Err → `FileOutcome::Unreadable` → `skipped.unreadable` +1
 *   ——镜像 scanFile 的 open 失败同账（本就一致，钉住防漂）；
 * - 非普通文件（符号链接）：`!ft.is_file()` 一律跳过（不入候选、不计数）；符号链接目录不深入
 *   （follow_links(false) 同口径）——镜像 walkFiles 的 dirent.isFile()/isDirectory() 判据同账。
 * 夹具：ACL 靠 icacls deny（Windows 自带；teardown 必须 /reset，否则目录删不掉）；symlink 靠
 * fs.symlink（Windows 需开发者模式，造不出 ⇒ skip 并如实记录；非 Windows 同理本机不可造）。
 */
const S21_PERM_QUERY = 'S21PERM';
const S21_SYM_QUERY = 'S21SYM';
const WIN_ICACLS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
const s21IcaclsUsable =
  process.platform === 'win32' && existsSync(WIN_ICACLS);

describe('MCP-PERF-S21 · 分诊账本机可造因（Rust 判据引文对拍）', () => {
  it(
    'ACL 权限因：目录拒读 ⇒ unreadable+1（不许静默吞）；文件拒读 ⇒ unreadable+1；健康文件照扫',
    { skip: s21IcaclsUsable ? false : 'S21 记录：非 Windows（或无 icacls）本机不可造 ACL 因，此 case 跳过' },
    async (ctx) => {
      const root = path.join(tmpRoot, 'triage-perm');
      const deniedDir = path.join(root, 'denied-dir');
      const deniedFile = path.join(root, 'denied-file.erb');
      const deny = (p: string) => execFileSync(WIN_ICACLS, [p, '/deny', '*S-1-1-0:(RD)'], { stdio: 'pipe' });
      try {
        await fs.mkdir(deniedDir, { recursive: true });
        await fs.writeFile(path.join(deniedDir, 'inner.erb'), `${S21_PERM_QUERY} inside denied dir\n`, 'utf-8');
        await fs.writeFile(deniedFile, `${S21_PERM_QUERY} locked file\n`, 'utf-8');
        await fs.writeFile(path.join(root, 'open.erb'), `${S21_PERM_QUERY} visible\n`, 'utf-8');
        try {
          deny(deniedDir);
          deny(deniedFile);
        } catch {
          await fs.rm(root, { recursive: true, force: true }).catch(() => {});
          // S21 记录：deny 在本机未生效（策略/权限环境差异）⇒ ACL 因无法构造，跳过不算过
          ctx.skip();
          return;
        }
        const res = (await invoke('search_text', {
          request: {
            searchId: 21,
            roots: [root],
            query: S21_PERM_QUERY,
            options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] },
          },
        })) as {
          files: { path: string; matches: { line: number; column: number }[] }[];
          totalMatches: number;
          filesScanned: number;
          skipped: { binary: number; tooLarge: number; unreadable: number };
        };
        // Rust 判据引文：read_dir(denied-dir) Err → unreadable+1；fs::read(denied-file) Err → unreadable+1；
        // inner.erb 不入候选（遍历就没到它）、denied-file 与 open 都算「扫过」（scan_file 都被调用了）。
        expect(res.skipped.unreadable, 'ACL 目录 + ACL 文件各记一笔 unreadable（镜像吞掉 walk 错 = 漏账）').toBe(2);
        expect(res.filesScanned, '被拒文件与健康文件都算扫过').toBe(2);
        expect(res.totalMatches).toBe(1);
        const got = res.files.map((f) => ({
          path: path.basename(f.path),
          hits: f.matches.map((m) => [m.line, m.column] as [number, number]),
        }));
        expect(got, '只有健康文件出命中').toEqual([{ path: 'open.erb', hits: [[1, 1]] }]);
        expect(res.skipped.binary).toBe(0);
        expect(res.skipped.tooLarge).toBe(0);
      } finally {
        // teardown 必须 /reset：deny 不 reset 的话 rm -rf 也删不掉（EPERM，探针实测）
        for (const p of [deniedDir, deniedFile]) {
          try {
            execFileSync(WIN_ICACLS, [p, '/reset'], { stdio: 'pipe' });
          } catch {
            /* reset 失败只留下一个临时目录，不影响断言 */
          }
        }
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      }
    },
    30000,
  );

  it('符号链接因：文件 symlink 与 junction 都不入候选（静默跳过，不污染 unreadable）', async (ctx) => {
    const root = path.join(tmpRoot, 'triage-sym');
    // junction 的落点必须是**树外**真目录：写穿 junction 会把内容写进树里变成真文件（假命中）
    const junctionTarget = path.join(tmpRoot, 'triage-sym-jtarget');
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(junctionTarget, { recursive: true });
      await fs.writeFile(path.join(root, 'target.erb'), `${S21_SYM_QUERY}T target body\n`, 'utf-8');
      await fs.writeFile(path.join(junctionTarget, 'inside.erb'), `${S21_SYM_QUERY}J inside junction\n`, 'utf-8');
      await fs.symlink(path.join(root, 'target.erb'), path.join(root, 'link.erb'), 'file');
      await fs.symlink(junctionTarget, path.join(root, 'jdir'), 'junction');
    } catch {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      await fs.rm(junctionTarget, { recursive: true, force: true }).catch(() => {});
      // S21 记录：Windows 需开发者模式才能造文件符号链接；造不出 ⇒ 跳过并如实标注
      ctx.skip();
      return;
    }
    try {
      const res = (await invoke('search_text', {
        request: {
          searchId: 21,
          roots: [root],
          query: S21_SYM_QUERY,
          options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] },
        },
      })) as {
        files: { path: string; matches: { line: number; column: number }[] }[];
        totalMatches: number;
        filesScanned: number;
        skipped: { binary: number; tooLarge: number; unreadable: number };
      };
      // Rust 判据引文：`!ft.is_file()` 跳过符号链接文件；符号链接目录不深入（follow_links(false) 同口径）。
      // link.erb 与 target.erb 正文相同 ⇒ 若镜像跟随了 symlink，S21SYMT 会多一笔；
      // jdir 若被深入，S21SYMJ 会冒出来——两个都不许发生。
      expect(res.skipped.unreadable, '符号链接是静默跳过，不许记成 unreadable').toBe(0);
      expect(res.filesScanned, '只有 target.erb 一个候选').toBe(1);
      expect(res.totalMatches).toBe(1);
      const got = res.files.map((f) => path.basename(f.path));
      expect(got, '符号链接文件不重复出命中、junction 内容不出命中').toEqual(['target.erb']);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      await fs.rm(junctionTarget, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);
/* ------------------------------- MCP-PERF-S20 · 镜像逐段续取 ------------------------------- */

/** 与 Rust 引擎同尺的三把尺（B18 判据形态逐字照搬，别在这里另立数目） */
const PER_FILE_CAP = 500; // Rust SEARCH_PER_FILE_CAP
const HARD_CAP = 5000; // Rust SEARCH_HARD_CAP
const PAGE_LIMIT = 200; // MCP 腿的取页 limit（把段界压在 500 整倍数上）

interface ResumeMatch {
  line: number;
  column: number;
}
interface ResumeResult {
  files: { path: string; matches: ResumeMatch[] }[];
  totalMatches: number;
  truncated: boolean;
  /** B18 对账位：Rust SearchResultDto 恒在（不带凭据恒 0）⇒ 镜像也必须恒在，缺席 = 旧宿主形态 */
  resumeAppliedMatches?: number;
}

describe('MCP-PERF-S20 · 镜像逐段续取（B18 引擎腿的镜像侧收口）', () => {
  /**
   * 自建树、自起一台宿：与共享矩阵隔离。矩阵的 Rust harness 不认 `resumeAfterMatches`
   * （serde 忽略新键）⇒ 依赖凭据的真值进了矩阵就是「两侧必然分叉」的假案。
   * 夹具形状照 Rust `resume_fixture`：每行 `HIT L{k}`，命中 = 行号全序，手工真值零歧义。
   */
  const tmp20 = path.join(os.tmpdir(), `kojo-resume-parity-${process.pid}`);
  let tree20 = '';
  let base20 = '';
  let server20: Awaited<ReturnType<typeof createDebugServer>>;

  const invoke20 = async (cmd: string, args?: Record<string, unknown>) => {
    const res = await fetch(`${base20}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
    const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!body.ok) throw new Error(body.error ?? 'invoke failed');
    return body.value as Record<string, unknown>;
  };

  const hitLines = async (dir: string, name: string, hits: number) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), `${Array.from({ length: hits }, (_, k) => `HIT L${k + 1}`).join('\n')}\n`);
  };

  /** 腿的取页算术（逐字照搬 B18 判据 resume_pages_under_the_leg_page_math_*）：段界压 500 整倍数 */
  const legWalk = async (root: string, limit = PAGE_LIMIT) => {
    const keys: string[] = [];
    const skips: number[] = [];
    let offset = 0;
    for (let calls = 0; calls < 64; calls += 1) {
      const segment = Math.floor(offset / PER_FILE_CAP);
      const skip = segment * PER_FILE_CAP;
      const inSegment = offset - skip;
      const window = Math.min(HARD_CAP, inSegment + limit);
      const res = (await invoke20('search_text', {
        request: {
          searchId: 1,
          roots: [root],
          query: 'HIT',
          options: {
            isRegex: false,
            caseSensitive: false,
            wholeWord: false,
            extensions: [],
            maxResults: window,
            ...(skip > 0 ? { resumeAfterMatches: skip } : {}),
          },
        },
      })) as unknown as ResumeResult;
      expect(
        res.files.every((f) => f.matches.length <= PER_FILE_CAP),
        `第 ${calls + 1} 次调用：每文件返回仍 ≤ 单文件上限（闸一格没放宽）`,
      ).toBe(true);
      // 对账位必须恒在且等于凭据（腿靠这一位判「续上了没有」；缺席 = 旧宿主形态，镜像侧退役）
      expect(res.resumeAppliedMatches, `第 ${calls + 1} 次调用回显（skip=${skip}）`).toBe(skip);
      if (skip > 0) skips.push(skip);
      const seq = res.files.flatMap((f) => f.matches.map((m) => `${path.basename(f.path)}|${m.line}`));
      const page = seq.slice(inSegment, inSegment + limit);
      expect(
        !(page.length === 0 && res.truncated),
        `第 ${calls + 1} 次调用：空页不许带 truncated（腿会翻出「空页 + hasMore:true」）`,
      ).toBe(true);
      offset += page.length;
      keys.push(...page);
      if (!res.truncated) break;
    }
    return { keys, skips, offset };
  };

  beforeAll(async () => {
    tree20 = path.join(tmp20, 'tree');
    await hitLines(path.join(tree20, 'dense'), 'dense.erb', 2600); // 5 段 + 余 100，跨段界那一格
    await hitLines(path.join(tree20, 'multi'), 'a.erb', 5);
    await hitLines(path.join(tree20, 'multi'), 'b.erb', 5);
    await hitLines(path.join(tree20, 'past'), 'p.erb', 300);
    await hitLines(path.join(tree20, 'window'), 'w.erb', 1200);
    await hitLines(path.join(tree20, 'zero'), 'z.erb', 900);
    server20 = await createDebugServer({ port: 0, sandbox: tmp20, appdata: tmp20, log: () => {} });
    base20 = `http://127.0.0.1:${server20.port}`;
  }, 30000);

  afterAll(async () => {
    await server20.close();
    await fs.rm(tmp20, { recursive: true, force: true });
  });

  it('dense-file：腿取页算术 × 镜像引擎——2,600 条 / limit=200 逐页拼接 == 手工真值（无重无漏，段界逐位）', async () => {
    const truth = Array.from({ length: 2600 }, (_, k) => `dense.erb|${k + 1}`);
    const { keys, skips, offset } = await legWalk(path.join(tree20, 'dense'));
    expect(skips.length, '确实试过凭据（不是假装能续）').toBeGreaterThan(0);
    expect(skips[0]).toBe(500); // 第一段凭据恰是 500（段界整倍数）
    expect(offset).toBe(2600);
    expect(keys.length).toBe(2600);
    expect(new Set(keys).size).toBe(keys.length); // 无重
    expect(keys, '逐页拼接与手工真值逐条同序（无重、无漏、无错位）').toEqual(truth);
  });

  it('凭据逐文件生效，回显 = 各文件实际丢弃之和（a/b 各 5 条、skip 3 ⇒ 各回第 4、5 条、回显 6）', async () => {
    const res = (await invoke20('search_text', {
      request: {
        searchId: 1,
        roots: [path.join(tree20, 'multi')],
        query: 'HIT',
        options: {
          isRegex: false,
          caseSensitive: false,
          wholeWord: false,
          extensions: [],
          maxResults: 5000,
          resumeAfterMatches: 3,
        },
      },
    })) as unknown as ResumeResult;
    const files = res.files
      .map((f) => ({ name: path.basename(f.path), lines: f.matches.map((m) => m.line) }))
      .sort((x, y) => x.name.localeCompare(y.name));
    expect(files).toEqual([
      { name: 'a.erb', lines: [4, 5] },
      { name: 'b.erb', lines: [4, 5] },
    ]);
    expect(res.totalMatches).toBe(4);
    expect(res.truncated).toBe(false);
    expect(res.resumeAppliedMatches, '回显 = 每个文件各丢 3 条的和（6），不是请求值 3').toBe(6);
  });

  it('凭据越过文件命中总数 ⇒ 空页 + 不触墙 + 回显实际条数（300 条 / skip 500 ⇒ 回显 300）', async () => {
    const res = (await invoke20('search_text', {
      request: {
        searchId: 1,
        roots: [path.join(tree20, 'past')],
        query: 'HIT',
        options: {
          isRegex: false,
          caseSensitive: false,
          wholeWord: false,
          extensions: [],
          maxResults: 5000,
          resumeAfterMatches: 500,
        },
      },
    })) as unknown as ResumeResult;
    expect(res.files, '文件只有 300 条 ⇒ 第 500 条之后是空页（绝不回吐前 N 条冒充新一页）').toEqual([]);
    expect(res.truncated, '空页且文件已穷尽 ⇒ 不许报 truncated（那是墙的标志）').toBe(false);
    expect(res.totalMatches).toBe(0);
    expect(res.resumeAppliedMatches).toBe(300);
  });

  it('凭据仍受窗口闸管（1,200 条 / skip 500 / maxResults 100 ⇒ 恰回 501..600、truncated、回显 500）', async () => {
    const res = (await invoke20('search_text', {
      request: {
        searchId: 1,
        roots: [path.join(tree20, 'window')],
        query: 'HIT',
        options: {
          isRegex: false,
          caseSensitive: false,
          wholeWord: false,
          extensions: [],
          maxResults: 100,
          resumeAfterMatches: 500,
        },
      },
    })) as unknown as ResumeResult;
    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.matches.map((m) => m.line), '凭据 + 窗口的合成落点必须精确').toEqual(
      Array.from({ length: 100 }, (_, k) => k + 501),
    );
    expect(res.truncated, '窗口用尽而文件还有命中 ⇒ 仍报 truncated（不假称穷尽）').toBe(true);
    expect(res.resumeAppliedMatches).toBe(500);
  });

  it('缺省 / 0 ⇒ 旧面逐字同产出、回显 0 恒在；每文件闸与 Rust 同尺（900 条只回 500）', async () => {
    const options = { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [], maxResults: 5000 };
    const absent = (await invoke20('search_text', {
      request: { searchId: 1, roots: [path.join(tree20, 'zero')], query: 'HIT', options },
    })) as unknown as ResumeResult;
    const zero = (await invoke20('search_text', {
      request: {
        searchId: 1,
        roots: [path.join(tree20, 'zero')],
        query: 'HIT',
        options: { ...options, resumeAfterMatches: 0 },
      },
    })) as unknown as ResumeResult;
    expect(absent.resumeAppliedMatches, '回显位恒在（Rust DTO 同形）：不带凭据也必须是数字 0，不是缺席').toBe(0);
    expect(zero.resumeAppliedMatches).toBe(0);
    expect(
      absent.files.map((f) => f.matches.map((m) => m.line)),
      '缺省不带键 == 传 0（additive 的形状，旧调用方零改动）',
    ).toEqual(zero.files.map((f) => f.matches.map((m) => m.line)));
    expect(absent.files[0]!.matches, '每文件闸 = Rust SEARCH_PER_FILE_CAP 500：900 条只回前 500').toHaveLength(500);
    expect(absent.truncated).toBe(true);
  });
});
