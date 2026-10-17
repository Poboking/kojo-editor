/**
 * W12 ENC-SRC：解码判据单源的跨语言对拍钉测（TS 半边）。
 *
 * 钉三件事：
 * 1. **表只有一份**：`DECODE_PROBE_POLICY`（`@kojo/plugin-api` 常量）与表体文件
 *    `plugin-api/src/decode-probe-policy.json` 逐字段全等——Rust 宿主编译期 `include_str!`
 *    内嵌的就是这个 JSON（`src-tauri/src/lib.rs::decode_policy`），表漂一个字节必有一边红；
 * 2. **同一字节样本，TS 三处逐字一致**：内核 `decodeWithProbe`（编辑器读路径）、
 *    "旧路径" `probeEncoding` + `NodeBridge.decode`（桥解码原语）、`NodeBridge.decode` 按表——
 *    期望文本与 `search_tests.rs::policy_table_decodes_golden_samples` **同一张表**（Rust 半边），
 *    `packages/app/tests/bridge-decode.test.ts` 用同一张表钉 Tauri 桥；
 * 3. **UTF-8 BOM + 非法尾随**这一旧分叉桶（旧 Rust 检索把含 BOM 的整份字节落 SJIS、
 *    且 encoding_rs 对非法字节连跑合并成一个 U+FFFD）现在与 TextDecoder 逐字相同。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DECODE_LABEL, DECODE_PROBE_POLICY, type FileEncoding } from '@kojo/plugin-api';
import { decodeWithProbe, probeEncoding } from '../src/encoding';
import { NodeBridge } from './helpers/node-bridge';

const hex = (s: string): Uint8Array =>
  Uint8Array.from((s.match(/\s*[0-9A-Fa-f]{2}/g) ?? []).map((x) => parseInt(x.trim(), 16)));

describe('解码判据共享常量表（跨语言唯一表体）', () => {
  it('plugin-api 的 DECODE_PROBE_POLICY 与 JSON 表体逐字段全等（Rust include_str! 读同一文件）', () => {
    const raw = readFileSync(
      new URL('../../plugin-api/src/decode-probe-policy.json', import.meta.url),
      'utf-8',
    );
    expect(JSON.parse(raw)).toEqual(DECODE_PROBE_POLICY);
  });

  it('表形状 = v1 判序契约：UTF-8 BOM → UTF-16 LE/BE（BOM 互斥，序不敏感）→ 严格 UTF-8 → shift_jis 兜底', () => {
    expect(DECODE_PROBE_POLICY.version).toBe(1);
    expect(DECODE_PROBE_POLICY.bomRules.map((r) => r.encoding)).toEqual([
      'utf-8-bom',
      'utf-16le',
      'utf-16be',
    ]);
    expect(DECODE_PROBE_POLICY.fallbackEncoding).toBe('shift_jis');
  });

  it('DECODE_LABEL 覆盖 FileEncoding 全部取值（两桥共用这张表，无手抄副本）', () => {
    const all: FileEncoding[] = ['utf-8', 'utf-8-bom', 'shift_jis', 'utf-16le', 'utf-16be'];
    expect(Object.keys(DECODE_LABEL).sort()).toEqual([...all].sort());
    for (const enc of all) expect(() => new TextDecoder(DECODE_LABEL[enc])).not.toThrow();
  });
});

/** 与 `search_tests.rs::policy_table_decodes_golden_samples` 逐字同源的样本表（Rust 半边同文） */
const GOLDEN: Array<{ name: string; bytes: Uint8Array; text: string; encoding: FileEncoding }> = [
  { name: 'UTF-8 BOM 合法正文', bytes: hex('EF BB BF 61 62'), text: 'ab', encoding: 'utf-8-bom' },
  { name: '裸 UTF-8 BOM', bytes: hex('EF BB BF'), text: '', encoding: 'utf-8-bom' },
  { name: 'UTF-8 BOM + 流尾截断序列', bytes: hex('EF BB BF E3 81'), text: '\uFFFD', encoding: 'utf-8-bom' },
  {
    name: 'UTF-8 BOM + 非法字节连跑（§5.90 唯一实测分叉，现已消除）',
    bytes: hex('EF BB BF FF FE 41'),
    text: '\uFFFD\uFFFDA',
    encoding: 'utf-8-bom',
  },
  {
    name: 'UTF-8 BOM + 序列中途非法（E0 后接 0x80，低于其 A0 下界）',
    bytes: hex('EF BB BF E0 80 80'),
    text: '\uFFFD\uFFFD\uFFFD',
    encoding: 'utf-8-bom',
  },
  { name: '无 BOM 合法 UTF-8', bytes: hex('E6 97 A5 E6 9C AC'), text: '日本', encoding: 'utf-8' },
  { name: 'UTF-16 LE（BOM）', bytes: hex('FF FE 61 00'), text: 'a', encoding: 'utf-16le' },
  { name: 'UTF-16 BE（BOM）', bytes: hex('FE FF 00 61'), text: 'a', encoding: 'utf-16be' },
  { name: 'UTF-16 BE 代理对', bytes: hex('FE FF D8 3D DE 00'), text: '\u{1F600}', encoding: 'utf-16be' },
  { name: 'UTF-16 LE 奇数尾字节', bytes: hex('FF FE 61'), text: '\uFFFD', encoding: 'utf-16le' },
  { name: 'Shift-JIS（非法 UTF-8 ⇒ 兜底）', bytes: hex('82 A0 82 A2 82 A4'), text: 'あいう', encoding: 'shift_jis' },
  { name: 'Shift-JIS 中孤立非法字节', bytes: hex('41 FF 42'), text: 'A\uFFFDB', encoding: 'shift_jis' },
  { name: 'Shift-JIS 引导字节截断在流尾', bytes: hex('82'), text: '\uFFFD', encoding: 'shift_jis' },
];

describe('同一字节样本：TS 侧三处解码逐字一致', () => {
  const bridge = new NodeBridge('');

  for (const g of GOLDEN) {
    it(`${g.name}：decodeWithProbe = probeEncoding+桥decode = 期望文本`, async () => {
      // ① 内核读路径单源入口（编辑器正文）
      const probed = decodeWithProbe(g.bytes);
      expect(probed.encoding).toBe(g.encoding);
      expect(probed.text).toBe(g.text);
      // ② 旧读路径形态：探测 + 桥解码（对照桶）
      const viaBridge = await bridge.decode(g.bytes, probeEncoding(g.bytes));
      expect(viaBridge).toBe(g.text);
      // ③ 按表逐条解码（与 ① 的 BOM 分支同一条码路）
      expect(await bridge.decode(g.bytes, g.encoding)).toBe(g.text);
    });
  }
});
