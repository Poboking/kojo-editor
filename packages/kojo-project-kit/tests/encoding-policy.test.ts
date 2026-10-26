import { promises as fs } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformBridge } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../kernel/src/io';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { encodeErbBytes } from '../../plugins/kojo-sugar/src/compile';
import { createSugarTranspileService } from '../../plugins/kojo-sugar/src/service';
import { scaffoldKojoProject } from '../../plugins/eratw-adapter/src/scaffold';
import { scaffoldErakumamaidProject } from '../../plugins/eraakumamaid-adapter/src/scaffold';
import { PRODUCT_ENCODING, WRITE_ENCODING_POLICY } from '../src/encoding-policy';
import { writeScaffoldFiles } from '../src/scaffold-writer';

/**
 * 落盘编码策略守卫（ENCODE-SS 2026-10-20）。
 *
 * 三件事，一条都不许是"改前改后都过"的空测试：
 *
 * ① **策略表 ⇔ 真实写手的字节**：`encoding-policy.ts` 的每一行都拿**真实现**跑出来
 *    的字节对拍——产物走 `SugarTranspileService.compileToBytes`（保存 / 部署 / 导出
 *    ZIP 同一条组装路），起手包走真 `scaffoldKojoProject` / `scaffoldErakumamaidProject`
 *    + 真 `writeScaffoldFiles` + 真内核 `FileIOServiceImpl`（临时目录），`exportFile`
 *    走真内核 io + 捕获桥。任一路的 BOM / 换行 / 末尾换行变了 ⇒ 红。
 * ② **源形状**：BOM 产出具点只有豁免表里那几处（**文件 + 处数**钉死，多一处少一处都红）；
 *    产物字节组装只有 `encodeErbBytes` 一枚函数；`scaffold-writer` 不许退回 `writeText`
 *    （那会把自带 BOM 的 CSV 写成双 BOM）；Rust `export_file` 只许 `std::fs::write` 原样写。
 * ③ **教程面 ⇔ 策略表**：作者看到的「产物格式」那句话（`tutorial-content.ts` ⑥ 保存段）
 *    必须与表逐项对上——实现先漂 ⇒ ① 红；文案先漂 ⇒ ③ 红。
 *
 * 语料 / 金样**只读**：本文件只写 `os.tmpdir()` 下的临时目录（与
 * `scaffold-writer.test.ts` 同一先例），不碰 `C:/game/**`，也不碰
 * `eratw-adapter/tests/fixtures/default-sugar/`（那份金样由 `scaffold-lang-doc.test.ts`
 * 逐字节钉住；本批不动起手包文本，故那边读数不变）。
 *
 * 派生判定对 BOM / 换行差异的容忍不在这里重复取证（已有
 * `eratw-adapter/tests/artifact.test.ts` 的「仅 BOM / CRLF 差异 → reason: 'encoding'」
 * 与「末尾换行不同算文本差异」两条）。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const startsWithBom = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
const crCount = (b: Uint8Array): number => b.reduce((n, x) => n + (x === 0x0d ? 1 : 0), 0);
const lfCount = (b: Uint8Array): number => b.reduce((n, x) => n + (x === 0x0a ? 1 : 0), 0);
const tailBytes = (b: Uint8Array, n: number): number[] => Array.from(b.slice(Math.max(0, b.length - n)));
const row = (id: keyof typeof WRITE_ENCODING_POLICY) => WRITE_ENCODING_POLICY[id];

/** 产物源：一个原生直通块（不需要分野表 / 角色号，转译零 error） */
const PRODUCT_SOURCE = '角色: 63\n@PROBE_FN\nPRINTL 你好\n';

/** eraTW 起手包输入（与 `scaffold-lang-doc.test.ts` 的 BASE 同形，独立声明以免耦合） */
const ERATW_BASE = {
  workName: '取证作品',
  authorName: '取证作者',
  version: '1.0',
  charaNo: 63,
  charaName: '影狼',
  scriptNo: 1,
  license: 'none',
} as const;

let root: string;
let io: FileIOServiceImpl;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-encoding-policy-'));
  io = new FileIOServiceImpl(new NodeBridge(root));
  io.setAppWritableRoots([root]);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/* ───────────────── ① 策略表 ⇔ 真实写手的字节 ───────────────── */

/** 只取策略行里那三格（writer / note 是给人看的，不参与对拍） */
function pick(r: { bom: string; eol: string; trailingNewline: string }) {
  return { bom: r.bom, eol: r.eol, trailingNewline: r.trailingNewline };
}

describe('① 策略表本身就是约定（改一格 = 改判据，必须在评审里看见）', () => {
  it('五行策略的六格口径逐字钉死', () => {
    expect({
      product: pick(row('compiled-product')),
      workspace: pick(row('workspace-source')),
      scaffoldText: pick(row('scaffold-text')),
      scaffoldCsv: pick(row('scaffold-csv')),
      exportFile: pick(row('export-file')),
    }).toEqual({
      product: { bom: 'always', eol: 'lf', trailingNewline: 'guaranteed' },
      workspace: { bom: 'always', eol: 'lf', trailingNewline: 'as-authored' },
      scaffoldText: { bom: 'never', eol: 'lf', trailingNewline: 'guaranteed' },
      scaffoldCsv: { bom: 'as-authored', eol: 'crlf', trailingNewline: 'guaranteed' },
      exportFile: { bom: 'as-authored', eol: 'as-authored', trailingNewline: 'as-authored' },
    });
    // 表与「产物期望值」常量不许各说各话
    expect(PRODUCT_ENCODING).toEqual({ bom: true, eol: 'lf', trailingNewline: true });
    expect(row('compiled-product').bom).toBe('always');
    expect(row('compiled-product').eol).toBe(PRODUCT_ENCODING.eol);
    expect(row('compiled-product').trailingNewline).toBe('guaranteed');
  });
});

describe('① compiled-product：BOM + LF + 末尾换行（真服务 → 真字节）', () => {
  const svc = createSugarTranspileService();

  it('产物字节：首 3 字节 EF BB BF、无 CR、末字节 \\n；去 BOM 回读 = 转译文本', () => {
    const out = svc.compileToBytes(PRODUCT_SOURCE, { filePath: 'C:/w/事件.kojo' });
    expect(startsWithBom(out.bytes)).toBe(true);
    expect(crCount(out.bytes)).toBe(0);
    expect(out.bytes.at(-1)).toBe(0x0a);

    // 读回链（`artifact.ts::decodeSource` / 编辑器同口径）：缺省解码器剥 BOM ⇒ 正文是纯文本；
    // 留 BOM 才看得见它（`ignoreBOM`），两者一起把"落盘有 BOM、读回没 BOM"钉死
    expect(new TextDecoder('utf-8').decode(out.bytes).charCodeAt(0)).not.toBe(0xfeff);
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(out.bytes);
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    const body = raw.slice(1).replace(/\r\n/g, '\n');
    const erb = out.transpile.erb.replace(/\r\n/g, '\n');
    expect(body.replace(/\n+$/, '')).toBe(erb.replace(/\n+$/, ''));
    expect(body.endsWith('\n')).toBe(true);
  });

  it('正文里的 CRLF / CR 一律归一为 LF（不出现 \\r\\r\\n 之类二次展开）', () => {
    const bytes = encodeErbBytes('A\r\nB\rC\n', { ...PRODUCT_ENCODING });
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('A\nB\nC\n');
    expect(crCount(bytes)).toBe(0);
  });

  it('末尾换行：不够就补一个、多了不吞（产物文本自带的空尾行原样保留）', () => {
    expect(tailBytes(encodeErbBytes('A\nB', { ...PRODUCT_ENCODING }), 2)).toEqual([0x42, 0x0a]);
    expect(tailBytes(encodeErbBytes('A\n\n\n', { ...PRODUCT_ENCODING }), 4)).toEqual([0x41, 0x0a, 0x0a, 0x0a]);
  });

  it('空正文（纯空白源合法）只落 3 字节 BOM——读回是空文本，不是坏字节', () => {
    const out = svc.compileToBytes('\n  \n', { filePath: 'C:/w/空.kojo' });
    expect(Array.from(out.bytes)).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8').decode(out.bytes)).toBe('');
  });
});

describe('① workspace-source：新文件 = UTF-8-BOM + LF（真内核 io 落临时盘）', () => {
  it('writeText 新建文件：BOM + LF，末尾换行按文本（不补不删）', async () => {
    const abs = path.join(root, 'workspace', '新建.kojo');
    const text = '角色: 63\n; 注释\n「台词」';
    await io.writeText(abs, text);
    const bytes = await io.readBytes(abs);

    expect(startsWithBom(bytes)).toBe(true);
    expect(crCount(bytes)).toBe(0);
    // 逐字节 = U+FEFF + 文本原样：既没偷偷补末尾换行，也没在别处加料
    expect(Array.from(bytes)).toEqual(Array.from(enc(`\uFEFF${text}`)));
  });

  it('「另存」那份手写 U+FEFF 与工作区新建落盘同字节（`new-file-flow` 的承诺可验）', async () => {
    const text = '角色: 63\n; 注释\n「台词」\n';
    const abs = path.join(root, 'workspace', '另存对照.kojo');
    await io.writeText(abs, text);
    const workspaceBytes = await io.readBytes(abs);
    // 另存路径的字节组装（`new-file-flow` 的 `new TextEncoder().encode(`\uFEFF${draft.text}`)`）
    const exportBytes = enc(`\uFEFF${text}`);
    expect(Array.from(exportBytes)).toEqual(Array.from(workspaceBytes));
  });
});

describe('① scaffold-text：起手包 BOM-less + LF + 末尾换行（真脚手架 → 真落盘）', () => {
  const set = scaffoldKojoProject(ERATW_BASE);

  it('eraTW 起手包 9 件：文本无 U+FEFF、无 CR、以 LF 收尾', () => {
    expect(Object.keys(set.files)).toHaveLength(9);
    for (const [rel, text] of Object.entries(set.files)) {
      expect(text.charCodeAt(0), rel).not.toBe(0xfeff);
      expect(text.includes('\r'), rel).toBe(false);
      expect(text.endsWith('\n'), rel).toBe(true);
    }
  });

  it('落盘字节 = 文本 UTF-8 原样（writer 不补 BOM、不碰换行）', async () => {
    const dir = path.join(root, 'eratw');
    await writeScaffoldFiles({ io, files: set.files, targetDir: dir });
    for (const rel of Object.keys(set.files)) {
      const disk = await io.readBytes(path.join(dir, rel));
      expect(Array.from(disk), rel).toEqual(Array.from(enc(set.files[rel]!)));
      expect(startsWithBom(disk), rel).toBe(false);
      expect(disk.at(-1), rel).toBe(0x0a);
    }
  });
});

describe('① scaffold-csv：文本自带 BOM 一次 + CRLF + 末尾 CRLF（writer 不补不剥）', () => {
  const set = scaffoldErakumamaidProject({
    workName: '取证作品',
    authorName: '取证作者',
    version: '1.0',
    charaNo: 67,
    charaName: 'フェリシエル',
  });
  const CSV_REL = 'CSV/CHARA/CHARA67.csv';

  it('CSV 文本：恰一个前导 U+FEFF、全 CRLF、以 \\r\\n 收尾', () => {
    const csv = set.files[CSV_REL]!;
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect((csv.match(/\uFEFF/g) ?? []).length).toBe(1);
    expect(csv.endsWith('\r\n')).toBe(true);
    const bytes = enc(csv);
    expect(lfCount(bytes)).toBeGreaterThan(0);
    expect(crCount(bytes)).toBe(lfCount(bytes)); // 每个 LF 前都有 CR（没有半 CRLF）
  });

  it('落盘字节：BOM 只一次（不双 BOM）、CRLF 原样，其余文件仍 BOM-less', async () => {
    const dir = path.join(root, 'am');
    await writeScaffoldFiles({ io, files: set.files, targetDir: dir });
    const disk = await io.readBytes(path.join(dir, CSV_REL));

    expect(startsWithBom(disk)).toBe(true);
    expect(disk[3], '紧跟 BOM 的字节若仍是 0xEF 就是双 BOM（writeText 的老坑）').not.toBe(0xef);
    expect(Array.from(disk)).toEqual(Array.from(enc(set.files[CSV_REL]!)));

    for (const rel of Object.keys(set.files)) {
      if (rel === CSV_REL) continue;
      const other = await io.readBytes(path.join(dir, rel));
      expect(startsWithBom(other), rel).toBe(false);
      expect(crCount(other), rel).toBe(0);
    }
  });
});

describe('① export-file：字节透明（真内核 io + 捕获桥）', () => {
  it('BOM-less CRLF / 自带 BOM 的 CRLF / ZIP 二进制 / 3 字节 BOM —— 进什么出什么', async () => {
    let captured: Uint8Array | null = null;
    const bridge = {
      exportFile: async (_fileName: string, bytes: Uint8Array) => {
        captured = bytes;
        return 'C:/picked/导出.bin';
      },
    } as unknown as PlatformBridge;
    const exporter = new FileIOServiceImpl(bridge);

    const shapes: ReadonlyArray<readonly [string, Uint8Array]> = [
      ['无 BOM + CRLF 文本', enc('a\r\nb')],
      ['自带 BOM + CRLF（CSV 形态）', enc('\uFEFF番号,1\r\n名前,甲\r\n')],
      ['ZIP 二进制（PK\\x03\\x04）', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xd8, 0x00, 0x00])],
      ['3 字节 BOM（空产物形态）', new Uint8Array([0xef, 0xbb, 0xbf])],
    ];
    for (const [label, bytes] of shapes) {
      captured = null;
      const landing = await exporter.exportFile('导出.bin', bytes, { title: '导出' });
      expect(landing).toBe('C:/picked/导出.bin');
      expect(Array.from(captured!), label).toEqual(Array.from(bytes));
    }
  });
});

/* ───────────────── ② 源形状：BOM 产出具只有豁免表里那几处 ───────────────── */

/**
 * 扫 `packages/**\/src` 的**代码行**（注释行跳过：散文里提 BOM 到处都是，不算产出点），
 * 找"真的会产生一个 BOM"的两种形态：
 * - `\uFEFF`（TS 里写进字符串的 BOM 码元；大小写敏感——`\ufeff` 那种是词法空白类，
 *   如 `kojo-sugar/src/formatter.ts` 的缩进类，不产生 BOM）；
 * - `0xef, 0xbb, 0xbf` / `0xEF, 0xBB, 0xBF`（字节三元组）。
 *
 * 豁免表按**文件 + 处数**钉死（house style：`kojo-extension-single-source.test.ts`）：
 * 新增一处 ⇒ 表里没有该文件（或处数不符）⇒ 红，必须回来交代它属于哪条路。
 */
const BOM_EMIT_SITES: ReadonlyArray<{ readonly file: string; readonly count: number; readonly why: string }> = [
  {
    file: 'packages/plugins/kojo-sugar/src/compile.ts',
    count: 1,
    why: 'compiled-product 的唯一编码器（BOM_BYTES）；产物 / 升糖回写共用 encodeErbBytes',
  },
  {
    file: 'packages/app/src-tauri/src/lib.rs',
    count: 1,
    why: 'encode_string_of 的 utf-8-bom 分支（workspace-source 那一行的字节产生处）',
  },
  {
    file: 'packages/kernel/src/encoding.ts',
    count: 1,
    why: 'withUtf16Bom：UTF-16 写回补 BOM（与三条 UTF-8 路无关，但同样是"会产生 BOM"的点）',
  },
  {
    file: 'packages/plugins/eraakumamaid-adapter/src/scaffold.ts',
    count: 1,
    why: 'scaffold-csv：CSV 文本自带 BOM（writer 不再补）',
  },
  {
    file: 'packages/plugins/erafl-adapter/src/chara-csv.ts',
    count: 1,
    why: '读侧剥 BOM（`^\\uFEFF`）：eraFL 的 Chara CSV 有带 BOM 的，剥掉才认首行表头；不产出字节',
  },
  {
    file: 'packages/plugins/erafl-adapter/src/kojo-xml/encoding.ts',
    count: 1,
    why: '口上 XML 的 BOM 字节表（读侧判据）：9 份 UTF-16LE 却声明 utf-8 的样本靠 BOM 优先才读得对；不产出字节',
  },
  {
    file: 'packages/plugins/erakoumakan-adapter/src/chara-csv.ts',
    count: 1,
    why: '读侧剥 BOM（`^\\uFEFF`）：真盘 18 份 `Chara{n}.csv` 全部 UTF-8-BOM，剥掉才认首行键；不产出字节',
  },
  {
    file: 'packages/plugins/erasqc-adapter/src/chara-csv.ts',
    count: 1,
    why: '读侧剥 BOM（`^\\uFEFF`）：真盘 63 份 `Chara{n}.csv` 全部 UTF-8-BOM，剥掉才认首行 `番号`；不产出字节',
  },
  {
    file: 'packages/plugins/eratohok-adapter/src/chara-csv.ts',
    count: 1,
    why: '读侧剥 BOM（`^\\uFEFF`）：真盘 174 份 `CSV/Chara/Chara{n} {名}.csv` 全部 UTF-8-BOM，剥掉才认首行 `番号`；不产出字节',
  },
  {
    file: 'packages/plugins/eraav-adapter/src/chara-csv.ts',
    count: 1,
    why: '读侧剥 BOM（首码元 U+FEFF）：eraAV 真盘 120 份 `CSV/Chara` 里 **7 份没有 BOM**（Chara70–75、78），受管 `ERB/` 的 471 份 `.ERB/.ERH` 里也有 1 份无 BOM ⇒ 既剥掉才认首行 `番号`，也不许反过来假定「必有 BOM」；不产出字节',
  },
  {
    file: 'packages/plugins/eratohoreverse-adapter/src/chara-csv.ts',
    count: 1,
    why: '读侧剥 BOM（首码元 U+FEFF）：eratohoReverse 真盘全树 1,083 份 `.ERB/.ERH/.CSV`（受管 `ERB/` 907 份）是 100% UTF-8-BOM（且 100% 纯 LF），剥掉才认首行 `番号`；不产出字节',
  },
  {
    file: 'packages/plugins/eraav-adapter/src/conventions.ts',
    count: 1,
    why: '读侧剥 BOM（`^\\uFEFF`）：`[SKIPSTART]` 遮蔽段判据要先看正文原始行，而本盘 470/471 份带 BOM、其中 **33 份首行就是 `@` 定义**（PITFALLS 231）——不剥就整条定义看不见；不产出字节',
  },
  {
    file: 'packages/plugins/eratohoreverse-adapter/src/conventions.ts',
    count: 1,
    why: '读侧剥 BOM（`^\\uFEFF`）：本盘 907/907 带 BOM 且 **39 份首行就是 `@` 定义**，`[SKIPSTART]` 遮蔽段的差集判据必须先剥 BOM 才数得到定义（PITFALLS 231）；不产出字节',
  },
  {
    file: 'packages/plugins/erafl-adapter/src/scaffold.ts',
    count: 2,
    why: '新角色脚手架两份产物（`KOJO_DEFINE_K{n}.ERB` + 口上 XML）各带一枚 BOM，与真盘既有文件同形',
  },
  {
    file: 'packages/plugins/ui-sugar-editor/src/new-file-flow.ts',
    count: 1,
    why: 'export-file 的唯一加 BOM 调用方：另存 `.kojo` 复刻 workspace-source 缺省',
  },
  {
    file: 'packages/plugin-api/src/platform.ts',
    count: 1,
    why: '编码探测的 BOM 字节表（读侧判据，不产出字节）',
  },
  {
    file: 'packages/kojo-core/src/migrate/index.ts',
    count: 2,
    why: 'v1→2.0 迁移保留输入 BOM：BOM 输入 ⇒ 迁移产物同 BOM（编码不归一化契约）',
  },
  {
    file: 'packages/kojo-core/src/migrate/source.ts',
    count: 1,
    why: '迁移源文本的 BOM 探测与剥离（事实保留，避免二次 BOM）',
  },
  {
    file: 'packages/kojo-core/src/migrate/indent.ts',
    count: 1,
    why: 'v1 缩进失配归因的机械修复：只在首行 BOM 这一唯一解上剥除（startsWith 判据，回写给迁移同一条编码契约；批次十二落地，BOM 属编码事实由 readSource 另行记账）',
  },
  {
    file: 'packages/kojo-conformance/src/encoding.ts',
    count: 1,
    why: '一致性套件的编码编解码器：BOM 字节表是读侧判据，再编码时按输入 BOM 事实原样补回（只比对、不写源文件）',
  },
  {
    file: 'packages/kojo-conformance/src/language.ts',
    count: 1,
    why: '一致性套件的 BOM 剥离判据：\BOM = \\uFEFF\ 常量只做 startsWith 判据 + 剥离（读侧，不产出字节）',
  },
  {
    file: 'packages/kojo-conformance/src/kit.ts',
    count: 1,
    why: 'BOM 不变式对拍：给源文本前缀补 `\\uFEFF` 再编译，断言产物与不带 BOM 时逐字节相同（不写盘）',
  },
];

const UPPER_BOM_ESCAPE = /\\uFEFF/;
const BOM_TRIPLE = /0xef,\s*0xbb,\s*0xbf/i;
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;
/** 测试代码住在 src 里的一支（Rust 分文件用例；不是写手） */
const TEST_ONLY_SOURCE = /(^|\/)[^/]*_tests\.rs$/;

function sourceFiles(dir = 'packages'): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(child);
        continue;
      }
      if (!/\.(ts|tsx|mts|rs|mjs)$/.test(e.name)) continue;
      if (!child.includes('/src/')) continue;
      if (TEST_ONLY_SOURCE.test(child)) continue;
      out.push(child);
    }
  };
  walk(dir);
  return out;
}

function bomEmitSites(): Map<string, number> {
  const hits = new Map<string, number>();
  for (const rel of sourceFiles()) {
    let n = 0;
    for (const line of read(rel).split(/\r?\n/)) {
      if (COMMENT_LINE.test(line)) continue;
      if (UPPER_BOM_ESCAPE.test(line) || BOM_TRIPLE.test(line)) n += 1;
    }
    if (n > 0) hits.set(rel, n);
  }
  return hits;
}

describe('② BOM 产出具：豁免表钉到文件 + 处数（多一处少一处都红）', () => {
  // 这一条扫**整个仓库**的源码（`bomEmitSites()` 递归读盘），单跑 ~2.2 s；满载并行池里
  // 被挤过默认 20 s 就报 `Test timed out in 20000ms`——看着像豁免表漂了，其实是没给 IO 预算。
  // 按本仓既有口径给显式预算（`docs/PITFALLS.md` §81）：判据与豁免表一条没动。
  it('全仓扫描结果 == 豁免表（一个文件一处不差）', () => {
    const hits = bomEmitSites();
    const actual = [...hits.entries()].map(([file, count]) => `${file} × ${count}`).sort();
    const expected = BOM_EMIT_SITES.map((e) => `${e.file} × ${e.count}`).sort();
    expect(actual).toEqual(expected);
  }, 120_000);

  it('豁免表每一条的「为什么」都写清楚了（杜绝"顺手加一行豁免"）', () => {
    for (const e of BOM_EMIT_SITES) expect(e.why.length, e.file).toBeGreaterThan(10);
  });
});

describe('② 写手处的判据形态（退回旧形态即红）', () => {
  it('产物字节组装只有 encodeErbBytes 一枚（调用点 = compileToBytes + lift-apply 两处）', () => {
    const compile = read('packages/plugins/kojo-sugar/src/compile.ts');
    expect(compile).toMatch(/const DEFAULT_ENCODING = \{ bom: true, eol: 'lf', trailingNewline: true \} as const;/);
    expect(compile).toMatch(/const BOM_BYTES = new Uint8Array\(\[0xef, 0xbb, 0xbf\]\);/);
    expect(compile).toMatch(/export function encodeErbBytes\(/);
    // 定义 1 + compileToBytes 里调用 1
    expect(compile.match(/encodeErbBytes\(/g)?.length).toBe(2);
    const lift = read('packages/plugins/kojo-sugar/src/lift-apply.ts');
    expect(lift).toMatch(/encodeErbBytes\(preview\.text, \{ bom: true, eol: 'lf', trailingNewline: true \}\)/);
    expect(lift.match(/encodeErbBytes\(/g)?.length).toBe(1);
  });

  it('scaffold-writer 只走 encodeScaffoldText（writeText = 0，Double BOM 的坑不许复活）', () => {
    const writer = read('packages/kojo-project-kit/src/scaffold-writer.ts');
    expect(writer).toMatch(/import \{ encodeScaffoldText \} from '\.\/encoding-policy';/);
    expect(writer.match(/encodeScaffoldText\(text\)/g)?.length).toBe(1);
    expect(writer).toMatch(/await io\.writeBytes\(abs, encodeScaffoldText\(text\)\);/);
    expect(writer.match(/writeText\(/g) ?? []).toHaveLength(0);
    expect(writer.match(/new TextEncoder\(\)/g) ?? []).toHaveLength(0);
  });

  it('Rust export_file 只有原样写盘（无 BOM / 无转码 / 无换行转换）', () => {
    const rust = read('packages/app/src-tauri/src/lib.rs');
    const fn = /async fn export_file\([\s\S]*?\n\}\n/.exec(rust)?.[0];
    expect(fn, 'export_file 函数体没找到').toBeTruthy();
    expect(fn).toMatch(/std::fs::write\(&picked, &bytes\)/);
    expect(fn).not.toMatch(/0xEF|0xef|\\u\{feff\}|encode_string_of|TextEncoder/);
    // 通道只有一个：全文件里 `fn export_file` 恰一处
    expect(rust.match(/fn export_file\(/g)?.length).toBe(1);
  });

  it('另存 `.kojo` 的 U+FEFF 仍在（`new-file-flow` 唯一一处）', () => {
    const flow = read('packages/plugins/ui-sugar-editor/src/new-file-flow.ts');
    expect(flow.match(/new TextEncoder\(\)\.encode\(`\\uFEFF\$\{draft\.text\}`\)/g)?.length).toBe(1);
    expect(flow).toMatch(/deps\.io\.exportFile\(draft\.fileName, bytes,/);
  });
});

/* ───────────────── ③ 教程面对作者说的那句话 ⇔ 策略表 ───────────────── */

describe('③ 教程文案与策略同源（实现先漂 ⇒ ①；文案先漂 ⇒ ③）', () => {
  it('「产物的文件格式」那句与 compiled-product 行逐项对上（**token 级**，防 CRLF 里含 LF 的假绿）', () => {
    const tutorial = read('packages/plugins/eratw-adapter/src/tutorial-content.ts');
    const claim = tutorial.split(/\r?\n/).find((l) => l.includes('产物的文件格式')) ?? '';
    expect(claim, '教程里的「产物格式」那句被删/改了').not.toBe('');

    // 英文记号按空白/标点切成**独立 token**（`CRLF` 与 `LF` 是两个 token）——子串匹配会假绿
    const tokens = new Set(claim.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []);
    const expected = [
      PRODUCT_ENCODING.bom ? 'UTF-8-BOM' : '无 BOM',
      PRODUCT_ENCODING.eol === 'lf' ? 'LF' : 'CRLF',
    ];
    for (const token of expected) expect(tokens.has(token), `教程文案缺独立记号「${token}」`).toBe(true);
    const trail = PRODUCT_ENCODING.trailingNewline ? '末尾换行' : '无末尾换行';
    expect(claim, `教程文案缺「${trail}」`).toContain(trail);
    // 反向：表若被改成别的口径，上一行的 token 会变 ⇒ 这句话必须跟着改，否则红
    expect(row('compiled-product').bom === 'always').toBe(PRODUCT_ENCODING.bom);
  });
});

