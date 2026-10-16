import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import type { FileEncoding } from '@kojo/plugin-api';
import { applyEol, detectEol, normalizeEol, probeEncoding } from '../src/encoding';
import { createKernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';

/**
 * 编码往返回归 golden —— "改坏文件是常态"卖点的硬证据。
 *
 * 复现 **kernel io 现行读写管线**（FileIOServiceImpl.readText → writeText）的往返：
 *   读字节 → probeEncoding → bridge.decode → detectEol → normalizeEol（内部 \n）
 *   → applyEol（按探测到的多数派换行）→ bridge.encode → 与原始字节逐字节比对。
 *
 * 两种覆盖：
 * 1. 合成变体（始终运行）：UTF-8 BOM 有无 × CRLF/LF × Shift-JIS——真实语料缺 SJIS，
 *    必须用合成字节补齐变体覆盖；
 * 2. 真实语料（`KOJO_SMOKE_PROJECT` 未设则整组跳过）：遍历工程下全部 ERB。
 *    基线（eraTW 4.980 汉化整合版，2026-10-11 实测）：kojo 语料 2,285 文件 /
 *    工程全量 4,385 文件，**0 字节差异**；编码分布 utf-8-bom 4,341 + utf-8 44，无 SJIS。
 *
 * 本测试只读语料、绝不写入；探测/编解码全部复用 kernel io 现有实现（未改 src）。
 */

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

/** 走 kernel io 现行管线做一次往返，返回产物与判定出的编码/换行 */
async function roundtrip(
  bridge: NodeBridge,
  bytes: Uint8Array,
): Promise<{ encoding: FileEncoding; eol: 'crlf' | 'lf'; out: Uint8Array }> {
  const encoding = probeEncoding(bytes);
  const raw = await bridge.decode(bytes, encoding);
  const eol = detectEol(raw);
  const text = applyEol(normalizeEol(raw), eol);
  return { encoding, eol, out: await bridge.encode(text, encoding) };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 递归收集目录下的 ERB 文件（与 erb-parser 同扩展口径：.erb / .erm） */
function walkErb(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = nodeJoin(dir, e.name);
    if (e.isDirectory()) walkErb(p, out);
    else if (/\.er[bm]$/i.test(e.name)) out.push(p);
  }
  return out;
}

const utf8Bom = (text: string): Uint8Array => new TextEncoder().encode(`\uFEFF${text}`);
const sjis = (text: string): Uint8Array => new Uint8Array(iconv.encode(text, 'shift_jis'));

describe('编码往返：合成变体（BOM 有无 / CRLF / LF / Shift-JIS）', () => {
  const enc = new TextEncoder();
  const bridge = new NodeBridge(mkdtempSync(nodeJoin(tmpdir(), 'kojo-enc-')));
  const utf8Body = '@M_KOJO_K1\nPRINTL 你好，世界\nCFLAG:2 = 10\n';

  const cases: Array<{ name: string; bytes: Uint8Array; encoding: FileEncoding; eol: 'crlf' | 'lf' }> = [
    { name: 'UTF-8 无 BOM + LF', bytes: enc.encode(utf8Body), encoding: 'utf-8', eol: 'lf' },
    { name: 'UTF-8 BOM + LF', bytes: utf8Bom(utf8Body), encoding: 'utf-8-bom', eol: 'lf' },
    {
      name: 'UTF-8 BOM + CRLF',
      bytes: utf8Bom(utf8Body.replace(/\n/g, '\r\n')),
      encoding: 'utf-8-bom',
      eol: 'crlf',
    },
    {
      name: 'Shift-JIS + LF',
      bytes: sjis('@M_KOJO_K1\nPRINTL 「こんにちは、世界。」\n好感度：%CFLAG:2%\n'),
      encoding: 'shift_jis',
      eol: 'lf',
    },
    {
      name: 'Shift-JIS + CRLF',
      bytes: sjis('@M_KOJO_K1\r\nPRINTL 「おはよう。」\r\n'),
      encoding: 'shift_jis',
      eol: 'crlf',
    },
  ];

  for (const c of cases) {
    it(`${c.name}：探测正确 + 字节级往返一致`, async () => {
      expect(probeEncoding(c.bytes)).toBe(c.encoding);
      const r = await roundtrip(bridge, c.bytes);
      expect(r.encoding).toBe(c.encoding);
      expect(r.eol).toBe(c.eol);
      expect(bytesEqual(r.out, c.bytes)).toBe(true);
    });
  }

  it('混行归一化：多数派换行还原（少数派行被归一 —— kernel io 现行语义）', async () => {
    // crlf 2 : lf 1 → 多数派 crlf，孤立 lf 被归一为 crlf
    const mixed = enc.encode('a\r\nb\r\nc\n');
    const r = await roundtrip(bridge, mixed);
    expect(r.eol).toBe('crlf');
    expect(bytesEqual(r.out, enc.encode('a\r\nb\r\nc\r\n'))).toBe(true);
  });
});

const hasCorpus = Boolean(SMOKE_DIR) && existsSync(SMOKE_DIR!);

describe.skipIf(!hasCorpus)('编码往返：真实语料全量 golden（KOJO_SMOKE_PROJECT）', () => {
  it(
    '工程全部 ERB：decode → encode 字节级零差异',
    async () => {
      const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-enc-real-'));
      const bridge = new NodeBridge(appData);
      const kernel = await createKernel({
        platform: bridge,
        plugins: [createErbParserPlugin(), createEratwAdapterPlugin()],
        storageBackend: new MemoryStorageBackend(),
      });
      await kernel.start();
      const project = await kernel.project.open(SMOKE_DIR!);
      // 口上语料域（编辑器实际编辑的文件）= adapter 给出的 kojoPaths
      const kojoRoots = project.kojoPaths.map((r) => r.replaceAll('\\', '/').toLowerCase());

      const files = walkErb(SMOKE_DIR!);
      const encCount = new Map<string, number>();
      const eolCount = new Map<string, number>();
      const diffs: Array<{ file: string; encoding: FileEncoding; inLen: number; outLen: number }> = [];
      let kojoTotal = 0;
      let kojoDiffs = 0;

      for (const file of files) {
        const bytes = new Uint8Array(readFileSync(file));
        const r = await roundtrip(bridge, bytes);
        encCount.set(r.encoding, (encCount.get(r.encoding) ?? 0) + 1);
        eolCount.set(r.eol, (eolCount.get(r.eol) ?? 0) + 1);
        const isKojo = kojoRoots.some((root) => file.replaceAll('\\', '/').toLowerCase().startsWith(root));
        if (isKojo) kojoTotal++;
        if (!bytesEqual(r.out, bytes)) {
          diffs.push({ file, encoding: r.encoding, inLen: bytes.length, outLen: r.out.length });
          if (isKojo) kojoDiffs++;
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[enc-roundtrip] 工程 ERB ${files.length} 文件（口上语料 ${kojoTotal}）| ` +
          `编码 ${[...encCount.entries()].map(([k, v]) => `${k}=${v}`).join(' ')} | ` +
          `换行 ${[...eolCount.entries()].map(([k, v]) => `${k}=${v}`).join(' ')} | ` +
          `字节差异 ${diffs.length}（口上语料内 ${kojoDiffs}）`,
      );
      if (diffs.length > 0) {
        // 如实记录样本（不为了全绿改 kernel io 源码）
        for (const d of diffs.slice(0, 10)) {
          console.log(`[enc-roundtrip] 差异样本：${d.encoding} ${d.inLen}B → ${d.outLen}B ${d.file}`);
        }
      }

      expect(files.length).toBeGreaterThan(0);
      // 基线：口上域全过、0 字节差异。钉值随语料换版重校（2026-10-16：sub-modding 4.980-260326-SANYOUSEI 盘
      // = 口上 2,294 / 工程 4,394 文件，字节差异 0；旧盘「汉化整合版」为 2,285）。
      expect(kojoTotal).toBe(2294);
      expect(diffs).toEqual([]);

      await kernel.stop();
    },
    180_000,
  );
});