import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { DECODE_LABEL, type FileEncoding } from '@kojo/plugin-api';
import { applyEol, decodeWithProbe, detectEol, isValidUtf8, joinPreserveEol, normalizeEol, probeEncoding, reconstructEol, splitPreserveEol, withUtf16Bom } from '../src/encoding';

const enc = new TextEncoder();

describe('编码探测', () => {
  it('UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('口上')]);
    expect(probeEncoding(bytes)).toBe('utf-8-bom');
  });

  it('UTF-16 LE / BE BOM', () => {
    expect(probeEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
    expect(probeEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toBe('utf-16be');
  });

  it('无 BOM 的 UTF-8（含多字节）', () => {
    expect(probeEncoding(enc.encode('こんにちは、世界'))).toBe('utf-8');
  });

  it('纯 ASCII → utf-8（等价安全）', () => {
    expect(probeEncoding(enc.encode('@M_KOJO_K1_EVENT\nPRINTL foo'))).toBe('utf-8');
  });

  it('Shift-JIS 字节（非法 UTF-8 序列）', () => {
    // あいう in Shift-JIS
    const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]);
    expect(probeEncoding(sjis)).toBe('shift_jis');
  });

  it('isValidUtf8 对残缺多字节序列判 false', () => {
    expect(isValidUtf8(new Uint8Array([0xe3, 0x81]))).toBe(false);
    expect(isValidUtf8(enc.encode('正常'))).toBe(true);
    expect(isValidUtf8(new Uint8Array([]))).toBe(true);
  });
});

/**
 * `decodeWithProbe`（2026-10-16 批量 IO 批；W12 ENC-SRC 起为 `DECODE_PROBE_POLICY` 的 TS 解释者）：
 * 一次解码同时得到 {text, encoding}，替代旧的"probeEncoding（全文 fatal 校验一遍）+
 * decode（全文再解一遍）"双重全量解码。
 *
 * 判据 = **对拍**：同一份字节下，新旧两条路径产出的 `{text, encoding}` 必须全等。
 * 旧路径按现行内核/桥口径复刻：`probeEncoding` → `TextDecoder(DECODE_LABEL[…])`——
 * 标签表自 W12 起只有 `@kojo/plugin-api` 一份（node 桥与 tauri 桥 import 同一常量，
 * utf-8-bom 与 utf-8 同走 'utf-8'）。
 */
describe('decodeWithProbe 与旧路径对拍（编码+文本全等）', () => {
  /** 旧读路径的解码标签（单源表，两桥同源 import——见 encoding-decode-policy.test.ts） */
  const decodeLabel = (e: FileEncoding): string => DECODE_LABEL[e];
  const oldPath = (bytes: Uint8Array): { text: string; encoding: FileEncoding } => {
    const encoding = probeEncoding(bytes);
    return { text: new TextDecoder(decodeLabel(encoding)).decode(bytes), encoding };
  };

  const utf8Body = '@M_KOJO_K1\nPRINTL 你好，世界\nCFLAG:2 = 10\n';
  const cases: Array<{ name: string; bytes: Uint8Array }> = [
    { name: 'UTF-8 无 BOM（多字节）', bytes: enc.encode(utf8Body) },
    {
      name: 'UTF-8-BOM（剥 BOM 语义在两条路径上一致）',
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(utf8Body)]),
    },
    { name: '纯 ASCII', bytes: enc.encode('@FOO\nRETURN 1\n') },
    { name: '空文件', bytes: new Uint8Array([]) },
    { name: '仅 UTF-8 BOM（裸 3 字节）', bytes: new Uint8Array([0xef, 0xbb, 0xbf]) },
    { name: '混合换行（\r\n 与 \n 混排，探测与解码语义不掺和）', bytes: enc.encode('a\r\nb\nc\r\n') },
    { name: 'Shift-JIS（非法 UTF-8 序列 ⇒ 兜底分支）', bytes: new Uint8Array(iconv.encode('@K\nPRINTFORML 「こんにちは」\r\n', 'shift_jis')) },
    {
      name: 'Shift-JIS 含半角片假名',
      bytes: new Uint8Array(iconv.encode('ﾌｫﾙﾑ ﾃｽﾄ\n', 'shift_jis')),
    },
    {
      name: 'UTF-16LE（带 BOM）',
      bytes: new Uint8Array(iconv.encode('\uFEFF@U\nPRINTL 世界\n', 'utf-16le')),
    },
    {
      name: 'UTF-16BE（带 BOM）',
      bytes: new Uint8Array(iconv.encode('\uFEFF@U\nPRINTL 世界\n', 'utf-16be')),
    },
    { name: '残缺多字节序列（fatal 校验必须判失败 ⇒ 兜底）', bytes: new Uint8Array([0xe3, 0x81]) },
    { name: '高位字节孤例（0xFF，两条路径都走兜底）', bytes: new Uint8Array([0x41, 0xff, 0x42]) },
    { name: 'GBK 中文（三族评分判 gbk）', bytes: new Uint8Array(iconv.encode('口上测试，简体中文\n', 'gbk')) },
    { name: 'GBK 中文 CRLF 混少数派 LF（评分同上，文本一致）', bytes: new Uint8Array(iconv.encode('口上测试，简体中文\r\n第二行\n', 'gbk')) },
    { name: 'Big5 中文（三族评分判 big5）', bytes: new Uint8Array(iconv.encode('口上測試\n', 'big5')) },
    { name: 'GB18030 扩展字节（四字节区：gbk 族解不干净 ⇒ 评分裁决，两路径仍全等）', bytes: new Uint8Array(iconv.encode('𠀀𠀁\n', 'gb18030')) },
  ];

  for (const c of cases) {
    it(`${c.name}：{text, encoding} 与 probeEncoding+decode 全等`, () => {
      const old = oldPath(c.bytes);
      const got = decodeWithProbe(c.bytes);
      expect(got.encoding).toBe(old.encoding);
      expect(got.text).toBe(old.text);
    });
  }

  it('utf-8-bom 分支：BOM 不进入文本（与 sort 后的现有读路径行为一致）', () => {
    const got = decodeWithProbe(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    expect(got.encoding).toBe('utf-8-bom');
    expect(got.text).toBe('A');
    expect(got.text).not.toContain('\uFEFF');
  });

  it('utf-16 分支：BOM 由解码器剥掉（读侧不在文本里看见 \\uFEFF）', () => {
    expect(decodeWithProbe(new Uint8Array(iconv.encode('\uFEFFAB', 'utf-16le')))).toEqual({
      text: 'AB',
      encoding: 'utf-16le',
    });
    expect(decodeWithProbe(new Uint8Array(iconv.encode('\uFEFFAB', 'utf-16be')))).toEqual({
      text: 'AB',
      encoding: 'utf-16be',
    });
  });
});

describe('换行处理', () => {
  it('探测 crlf / lf（多数派）', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('crlf');
    expect(detectEol('a\nb\nc\n')).toBe('lf');
    expect(detectEol('a\r\nb\nc\r\n')).toBe('crlf'); // 2 crlf vs 1 lf
    expect(detectEol('no newline')).toBe('lf');
  });

  it('归一化与还原', () => {
    expect(normalizeEol('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(applyEol('a\nb', 'crlf')).toBe('a\r\nb');
    expect(applyEol('a\nb', 'lf')).toBe('a\nb');
  });

  it('往返：混合换行归一化后再按 crlf 还原是纯 crlf', () => {
    const mixed = 'x\r\ny\nz\r\n';
    expect(applyEol(normalizeEol(mixed), 'crlf')).toBe('x\r\ny\r\nz\r\n');
  });
});

describe('逐行换行保真原语（splitPreserveEol / joinPreserveEol / reconstructEol）', () => {
  it('splitPreserveEol：\\r\\n 当一个分隔符、孤立 \\r 与 \\n 各一个；join 逐字节还原', () => {
    for (const raw of ['a\r\nb\nc', 'a\rb\rc', 'a\n', '', 'a', 'x\r\ny\nz\r\n', '尾无换行\r\n末']) {
      const map = splitPreserveEol(raw);
      expect(map.parts.length).toBe(map.terms.length + 1);
      expect(joinPreserveEol(map)).toBe(raw); // 逐字节不变式
      expect(normalizeEol(raw).split('\n')).toEqual(map.parts); // 内部表示一致性
    }
  });

  it('reconstructEol：零改动 ⇒ 逐字节还原原文（含混合 CRLF/LF/CR）', () => {
    const raw = 'a\r\nb\r\nc\n'; // 多数派 crlf + 一个少数派 lf
    const map = splitPreserveEol(raw);
    expect(reconstructEol(map, normalizeEol(raw), detectEol(raw))).toBe(raw);
    const crOnly = 'a\rb\rc';
    const m2 = splitPreserveEol(crOnly);
    expect(reconstructEol(m2, normalizeEol(crOnly), 'lf')).toBe(crOnly);
  });

  it('reconstructEol：改一行 ⇒ 未改动行保留原换行，改动行邻接处用默认（3 个 LF 不被翻成 CRLF）', () => {
    // 多数派 CRLF，第 3 行（下标 3）是手写 LF
    const raw = 'l1\r\nl2\r\nl3\nl4\r\nl5';
    const map = splitPreserveEol(raw);
    // 用户只改了第 0 行内容，其余原样
    const edited = normalizeEol(raw).replace('l1', 'L1');
    const out = reconstructEol(map, edited, 'crlf');
    // 未改动的第 3 行分隔符仍是 \n（不被静默翻成 \r\n）
    expect(out).toBe('L1\r\nl2\r\nl3\nl4\r\nl5');
    // 第 0 行被改：其邻接分隔符用默认 crlf（原也是 crlf，无差）
  });

  it('reconstructEol：中间插入一行 ⇒ 前缀/后缀原换行都保留，仅新增行用默认', () => {
    const raw = 'a\rb\nc\rd'; // CR/LF 混合
    const map = splitPreserveEol(raw);
    const edited = 'a\nNEW\nb\nc\rd'; // 在第 0、1 行间插入 NEW（模型内部表示 \n）
    const out = reconstructEol(map, edited, 'crlf');
    // a→NEW 之间是新边界（默认 crlf），NEW→b 是新边界（默认 crlf），
    // b→c（原 \n）、c→d（原 \r）未改动 ⇒ 保留
    expect(out).toBe('a\r\nNEW\r\nb\nc\rd');
  });

  it('reconstructEol：emoji / 代理对不影响按 \\n 的行对齐（UTF-16 偏移陷阱回归）', () => {
    // 😀 = 代理对（2 个 code unit）；旧实现若按 code unit 计偏移会错位
    const raw = '😀\r\n你好\r\n🎉\n尾';
    const map = splitPreserveEol(raw);
    expect(reconstructEol(map, normalizeEol(raw), 'crlf')).toBe(raw);
    const edited = normalizeEol(raw).replace('你好', '你呀');
    expect(reconstructEol(map, edited, 'crlf')).toBe('😀\r\n你呀\r\n🎉\n尾');
  });
});

describe('withUtf16Bom：写回补 BOM（编码探针只对带 BOM 的 UTF-16 判为 utf-16le/be）', () => {
  it('utf-16le / utf-16be：剥 BOM 的正文补回前导 U+FEFF', () => {
    expect(withUtf16Bom('AB', 'utf-16le')).toBe('\uFEFFAB');
    expect(withUtf16Bom('AB', 'utf-16be')).toBe('\uFEFFAB');
  });
  it('已含 BOM 不重复加', () => {
    expect(withUtf16Bom('\uFEFFAB', 'utf-16le')).toBe('\uFEFFAB');
  });
  it('其它编码原样返回（BOM 交由 utf-8-bom 的 encode 分支处理）', () => {
    expect(withUtf16Bom('AB', 'utf-8')).toBe('AB');
    expect(withUtf16Bom('AB', 'utf-8-bom')).toBe('AB');
    expect(withUtf16Bom('AB', 'shift_jis')).toBe('AB');
  });
});

describe('GBK/Big5 探测（2026-10-17 编码标签批：契约缺口已补，不再误标 shift_jis）', () => {
  // eraTW 生态常见 GBK/GB18030/Big5 非 BOM 中文文件。此前 FileEncoding 不含这些标签，
  // probeEncoding 只能兜底判 shift_jis，一次"编辑+保存"就把中文字节重编码毁掉。
  // 现在三族评分（GBK/Big5 严格无损 + 字符类别分数严格胜出才上位）把它们判对；
  // 日文 Shift-JIS 由假名独有证据（+2/字）守住，纯高位垃圾字节仍落旧兜底 shift_jis。
  const gbkBytes = new Uint8Array(iconv.encode('口上测试，简体中文\n', 'gbk'));
  const big5Bytes = new Uint8Array(iconv.encode('口上測試\n', 'big5'));
  it('无 BOM GBK 中文判为 gbk，解码文本正确', () => {
    expect(probeEncoding(gbkBytes)).toBe('gbk');
    const d = decodeWithProbe(gbkBytes);
    expect(d.encoding).toBe('gbk');
    expect(d.text).toBe('口上测试，简体中文\n');
  });
  it('无 BOM Big5 中文判为 big5，解码文本正确', () => {
    expect(probeEncoding(big5Bytes)).toBe('big5');
    const d = decodeWithProbe(big5Bytes);
    expect(d.encoding).toBe('big5');
    expect(d.text).toBe('口上測試\n');
  });
  it('日文 Shift-JIS 不被 gbk 抢走（假名是独有证据）', () => {
    const sjis = new Uint8Array(iconv.encode('@K\nPRINTFORML 「こんにちは、世界。」\r\n', 'shift_jis'));
    expect(probeEncoding(sjis)).toBe('shift_jis');
  });
  it('三族零分的垃圾字节仍兜底 shift_jis（维持旧行为）', () => {
    expect(probeEncoding(new Uint8Array([0x41, 0xff, 0x42]))).toBe('shift_jis');
  });
});

/** PS-2③：分段一次切的新 splitPreserveEol 必须与旧的逐字符实现**逐字等价**（含全部边界形状） */
describe('splitPreserveEol · 参考实现等价（PS-2 重写守卫）', () => {
  function referenceSplit(raw: string): { parts: string[]; terms: string[] } {
    const parts: string[] = [];
    const terms: string[] = [];
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\r') {
        if (raw[i + 1] === '\n') {
          terms.push('\r\n');
          i++;
        } else {
          terms.push('\r');
        }
        parts.push(cur);
        cur = '';
      } else if (c === '\n') {
        terms.push('\n');
        parts.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    parts.push(cur);
    return { parts, terms };
  }

  it('对抗形状全覆盖：空串/纯分隔符/首尾分隔符/连续分隔符/混合三族/代理对', () => {
    const cases = [
      '',
      '\n',
      '\r',
      '\r\n',
      '\n\n\r\r\n\r\n',
      'a\n',
      'a\r\nb\rc',
      '\r\n尾',
      '😀\r\n你\r呀\n🎉\n',
      'x'.repeat(5000) + '\r\n' + 'y'.repeat(5000),
    ];
    for (const raw of cases) {
      const got = splitPreserveEol(raw);
      expect(got).toEqual(referenceSplit(raw));
      // 不变式：逐字节还原
      expect(joinPreserveEol(got)).toBe(raw);
      // 结构不变式：parts = terms + 1，且 parts 内不含任何裸换行字符
      expect(got.parts.length).toBe(got.terms.length + 1);
      for (const p of got.parts) expect(p).not.toMatch(/[\r\n]/);
    }
  });
});
