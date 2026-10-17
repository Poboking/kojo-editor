import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin, sep as nodeSep } from 'node:path';
import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import type { FileEncoding } from '@kojo/plugin-api';
import { applyEol, detectEol, normalizeEol, probeEncoding } from '../src/encoding';
import { FileIOServiceImpl } from '../src/io';
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
    {
      name: 'GBK + CRLF（简中：三族评分判 gbk，decode→encode 字节级往返）',
      bytes: new Uint8Array(iconv.encode('@M_KOJO_K1\r\nPRINTL 你好，世界\r\n好感度：%CFLAG:2%\r\n', 'gbk')),
      encoding: 'gbk',
      eol: 'crlf',
    },
    {
      name: 'Big5 + LF（繁中：三族评分判 big5，decode→encode 字节级往返）',
      bytes: new Uint8Array(iconv.encode('@M_KOJO_K1\nPRINTL 口上測試\n繁體中文\n', 'big5')),
      encoding: 'big5',
      eol: 'lf',
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

  it('混行保真：io.writeText 保留少数派 LF 行（改一行不翻其换行）—— kernel io 现行语义', async () => {
    // 多数派 crlf + 一个手写 lf。旧的"归一到单一 eol 再全量重写"会把 lf 行静默翻成 crlf，
    // 违反"保存不动用户没碰的字节"。现行 io 走 readText→writeText 逐行还原：
    const appData = await bridge.appDataDir();
    const f = nodeJoin(appData, 'mixed.ERB');
    const svc = new FileIOServiceImpl(bridge);
    svc.setWritableRoots([appData]);
    await bridge.writeFileBytes(f, enc.encode('a\r\nb\r\nc\nd\r\n'));
    const tf = await svc.readText(f);
    expect(tf.eol).toBe('crlf'); // 多数派仍判 crlf（新增/改动行的默认）
    await svc.writeText(f, tf.text.replace('a', 'A')); // 只改第 0 行
    const out = await bridge.readFileBytes(f);
    expect(new TextDecoder('utf-8').decode(out)).toBe('A\r\nb\r\nc\nd\r\n'); // c 行的 lf 保住
    // 对照：低层 applyEol 原语（roundtrip helper 走的那条）仍会归一——它不代表 io.writeText
    expect(bytesEqual(await roundtripOf('a\r\nb\r\nc\nd\r\n'), enc.encode('a\r\nb\r\nc\r\nd\r\n'))).toBe(true);
  });

  /** 低层 applyEol 往返（编码+多数派换行），仅用于对照原语行为 */
  async function roundtripOf(text: string): Promise<Uint8Array> {
    const bytes = enc.encode(text);
    const r = await roundtrip(bridge, bytes);
    return r.out;
  }
});

const hasCorpus = Boolean(SMOKE_DIR) && existsSync(SMOKE_DIR!);

/**
 * 编辑后重编码（2026-10-17 编码标签批）：探测判对 gbk/big5 之后，
 * **改动一次再保存**也必须编码回原编码字节——旧管线（判成 shift_jis）会把简中/繁中
 * 按 SJIS 解码再重编码，一次保存当场毁文件。零改动快道（逐字节直写）同步钉住仍生效。
 */
describe('编码编辑后往返：GBK/Big5 改动一行 ⇒ 重编码回原编码字节', () => {
  const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-enc-edit-'));
  const bridge = new NodeBridge(appData);
  const svc = new FileIOServiceImpl(bridge);
  svc.setWritableRoots([appData]);

  async function afterEditRoundtrip(
    file: string,
    label: 'gbk' | 'big5',
    text: string,
    find: string,
    repl: string,
    expectedHex?: string,
  ): Promise<void> {
    const f = nodeJoin(appData, file);
    const original = Buffer.from(iconv.encode(text, label));
    await bridge.writeFileBytes(f, original);

    const tf = await svc.readText(f);
    expect(tf.encoding).toBe(label);

    // 零改动：逐字节直写快道仍优先（字节与原文全等）
    await svc.writeText(f, tf.text);
    expect(Buffer.compare(readFileSync(f), original)).toBe(0);

    // 改一行：preserve 走探测出的编码重编码，逐字节等于按同一编码编出的期望
    await svc.writeText(f, tf.text.replace(find, repl));
    const expected = Buffer.from(iconv.encode(text.replace(find, repl), label));
    const out = readFileSync(f);
    expect(out.equals(expected)).toBe(true);
    if (expectedHex) expect(out.toString('hex')).toBe(expectedHex);
  }

  it('GBK：编辑后落盘 = GBK 字节（第三行 = b5dac8fdd0d0）', async () => {
    await afterEditRoundtrip(
      'edit-gbk.ERB',
      'gbk',
      '口上测试，简体中文\r\n第二行\r\n',
      '第二行',
      '第三行',
      Buffer.concat([
        Buffer.from(iconv.encode('口上测试，简体中文', 'gbk')),
        Buffer.from('\r\n', 'latin1'),
        Buffer.from(iconv.encode('第三行', 'gbk')),
        Buffer.from('\r\n', 'latin1'),
      ]).toString('hex'),
    );
  });

  it('Big5：编辑后落盘 = Big5 字节（繁體中文→中文測試 = a4a4a4e5b4fab8d5）', async () => {
    await afterEditRoundtrip(
      'edit-big5.ERB',
      'big5',
      '口上測試\r\n繁體中文\r\n',
      '繁體中文',
      '中文測試',
      Buffer.concat([
        Buffer.from(iconv.encode('口上測試', 'big5')),
        Buffer.from('\r\n', 'latin1'),
        Buffer.from(iconv.encode('中文測試', 'big5')),
        Buffer.from('\r\n', 'latin1'),
      ]).toString('hex'),
    );
  });
});

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
      // 盘无关不变量（替代旧逐盘常数 2,285 → 2,294：那张校准盘会不在位 ⇒ 常数钉值必假红，见 `899a71b` 同族处置）。
      // 本测真正守的是「编码/换行往返逐字节等值」，份数只是"扫到的是一张真 eraTW 盘、且口上域归类没坏"的哨兵。
      expect(kojoTotal, `口上域命中 ${kojoTotal}，低于任何一张 eraTW 盘的口上域规模 ⇒ 归类或扫描根坏了`).toBeGreaterThanOrEqual(
        1000,
      );
      // 自洽：按 root 单独枚举求和 === 上面 startsWith 归类计数（守分隔符/大小写归一与「根不重叠」两条隐含假设）
      const perRoot = project.kojoPaths.map((root) => {
        const native = root.replaceAll('/', nodeSep);
        return existsSync(native) ? walkErb(native).length : 0;
      });
      expect(
        perRoot.reduce((a, b) => a + b, 0),
        `逐 root 枚举 ${perRoot.join('+')} ≠ 归类计数 ${kojoTotal}：口上根重叠或路径归一化不一致`,
      ).toBe(kojoTotal);
      expect(diffs).toEqual([]);

      await kernel.stop();
    },
    180_000,
  );
});