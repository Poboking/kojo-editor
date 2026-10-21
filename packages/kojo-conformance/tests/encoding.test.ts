/**
 * encoding / EOL 取证：三种编码的字节换算可逆、BOM 与换行不改变产物语义；
 * adapter 的 `encodingPolicy` 必须接受用例的真实源形状。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND, type GameAdapter } from '@kojo/kojo-core';
import {
  decodeConformanceText,
  detectEol,
  detectTextEncoding,
  encodeConformanceText,
  encodeConformanceTextPreservingEol,
  eolPolicyAccepts,
  hasTrailingEol,
  runAdapterConformance,
} from '../src/index.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const BASIC = read('basic.kojo2');

function bytesOf(...values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('字节换算 · UTF-8 / UTF-8 BOM / UTF-16LE BOM', () => {
  const TEXT = '第一行\r\n第二行 🙂\r\n';

  it('utf-8：CRLF 原样往返，无 BOM', () => {
    const bytes = encodeConformanceText(TEXT, { encoding: 'utf-8', eol: 'crlf', trailingNewline: true });
    const decoded = decodeConformanceText(bytes);

    expect(decoded).toEqual({ text: TEXT, encoding: 'utf-8', eol: 'crlf', bom: false });
    expect(bytesOf(...bytes.slice(0, 2))).not.toEqual(bytesOf(0xef, 0xbb));
    expect(detectTextEncoding(bytes)).toBe('utf-8');
    expect(encodeConformanceTextPreservingEol(decoded.text, decoded.encoding)).toEqual(bytes);
  });

  it('utf-8-bom：首 3 字节 EF BB BF；解码剥 BOM 且可逆', () => {
    const bytes = encodeConformanceText(TEXT, { encoding: 'utf-8-bom', eol: 'crlf', trailingNewline: true });
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const decoded = decodeConformanceText(bytes);
    expect(decoded.text).toBe(TEXT);
    expect(decoded.encoding).toBe('utf-8-bom');
    expect(decoded.bom).toBe(true);
    expect(encodeConformanceTextPreservingEol(decoded.text, decoded.encoding)).toEqual(bytes);
  });

  it('utf-16le-bom：FF FE 开头，代理对（🙂）按 UTF-16 码元往返', () => {
    const bytes = encodeConformanceText(TEXT, { encoding: 'utf-16le-bom', eol: 'crlf', trailingNewline: true });
    expect(Array.from(bytes.slice(0, 2))).toEqual([0xff, 0xfe]);

    const decoded = decodeConformanceText(bytes);
    expect(decoded.text).toBe(TEXT);
    expect(decoded.encoding).toBe('utf-16le-bom');
    expect(decoded.bom).toBe(true);
    expect(decoded.eol).toBe('crlf');
    expect(encodeConformanceTextPreservingEol(decoded.text, decoded.encoding)).toEqual(bytes);
    expect(detectTextEncoding(bytes)).toBe('utf-16le-bom');
  });

  it('trailingNewline 只补缺：已有换行不重复，LF 目标不混入 CR', () => {
    const withNewline = encodeConformanceText('A\n', { encoding: 'utf-8', eol: 'lf', trailingNewline: true });
    const withoutNewline = encodeConformanceText('A', { encoding: 'utf-8', eol: 'lf', trailingNewline: true });
    const crlf = encodeConformanceText('A\n', { encoding: 'utf-8', eol: 'crlf', trailingNewline: true });

    expect(new TextDecoder().decode(withNewline)).toBe('A\n');
    expect(new TextDecoder().decode(withoutNewline)).toBe('A\n');
    expect(new TextDecoder().decode(crlf)).toBe('A\r\n');
  });

  it('非法字节不静默替换：坏 UTF-8 / 奇数字节 UTF-16 都抛 TypeError', () => {
    expect(detectTextEncoding(bytesOf(0xc3, 0x28))).toBeNull();
    expect(() => decodeConformanceText(bytesOf(0xc3, 0x28))).toThrow(TypeError);
    expect(() => decodeConformanceText(bytesOf(0xff, 0xfe, 0x41))).toThrow(TypeError);
  });
});

describe('EOL 读数与策略', () => {
  it('crlf / lf / mixed / none 四档', () => {
    expect(detectEol('a\r\nb')).toBe('crlf');
    expect(detectEol('a\nb')).toBe('lf');
    expect(detectEol('a\r\nb\nc\r')).toBe('mixed');
    expect(detectEol('abc')).toBe('none');
  });

  it('adapter 策略：mixed 接受一切；lf 拒绝 crlf；none 不违反任何策略', () => {
    expect(eolPolicyAccepts('mixed', 'crlf')).toBe(true);
    expect(eolPolicyAccepts('lf', 'crlf')).toBe(false);
    expect(eolPolicyAccepts('crlf', 'lf')).toBe(false);
    expect(eolPolicyAccepts('lf', 'none')).toBe(true);
  });

  it('hasTrailingEol 只认末尾换行', () => {
    expect(hasTrailingEol('A\n')).toBe(true);
    expect(hasTrailingEol('A')).toBe(false);
    expect(hasTrailingEol('')).toBe(false);
  });
});

describe('kit encoding 用例 · 保留与策略', () => {
  const crlfSource = BASIC.replace(/\n/g, '\r\n');

  function runEncoding(
    bytes: Uint8Array,
    encoding: {
      readonly sourceEncoding: 'utf-8' | 'utf-8-bom' | 'utf-16le-bom';
      readonly sourceEol: 'crlf' | 'lf' | 'mixed' | 'none';
      readonly outputEncoding?: 'utf-8' | 'utf-8-bom' | 'utf-16le-bom';
      readonly outputEol?: 'lf' | 'crlf';
      readonly preserveBom?: boolean;
      readonly preserveEol?: boolean;
    },
    adapter: GameAdapter = FIXTURE_ADAPTER,
  ) {
    return runAdapterConformance({
      adapter,
      backend: FIXTURE_BACKEND,
      cases: [{ kind: 'encoding', name: 'encoding case', bytes, encoding }],
    });
  }

  it('UTF-8 BOM + CRLF 源 → 产物保留 BOM/EOL；EOL/BOM 都不改变产物语义', () => {
    const bytes = encodeConformanceText(crlfSource, {
      encoding: 'utf-8-bom',
      eol: 'crlf',
      trailingNewline: true,
    });

    const report = runEncoding(bytes, { sourceEncoding: 'utf-8-bom', sourceEol: 'crlf' });

    expect(report.ok).toBe(true);
    const reading = report.cases[0]?.observations.encoding;
    expect(reading).toMatchObject({
      roundTrip: true,
      eolInvariant: true,
      bomInvariant: true,
      preservedBom: true,
      preservedEol: true,
    });
    expect(reading?.source).toMatchObject({ encoding: 'utf-8-bom', eol: 'crlf', bom: true });
    expect(reading?.output).toMatchObject({ encoding: 'utf-8-bom', eol: 'crlf', bom: true });
  });

  it('UTF-16LE BOM + LF 源 → 产物同样 UTF-16LE BOM + LF', () => {
    const bytes = encodeConformanceText(BASIC, {
      encoding: 'utf-16le-bom',
      eol: 'lf',
      trailingNewline: true,
    });

    const report = runEncoding(bytes, { sourceEncoding: 'utf-16le-bom', sourceEol: 'lf' });

    expect(report.ok).toBe(true);
    expect(report.cases[0]?.observations.encoding?.output).toMatchObject({
      encoding: 'utf-16le-bom',
      eol: 'lf',
      bom: true,
    });
  });

  it('mixed EOL 源（仅浅混一行）可被识别、可逆，产物按 adapter 策略落 LF', () => {
    const mixed = BASIC.replace('\n', '\r\n');
    const bytes = encodeConformanceTextPreservingEol(mixed, 'utf-8');

    const report = runEncoding(bytes, { sourceEncoding: 'utf-8', sourceEol: 'mixed' });

    expect(report.ok).toBe(true);
    expect(report.cases[0]?.observations.encoding).toMatchObject({
      roundTrip: true,
      eolInvariant: true,
      preservedEol: true,
      source: { eol: 'mixed' },
      output: { eol: 'lf' },
    });
  });

  it('声明编码与实际字节不符 → conformance/encoding（sourceEncoding 定位）', () => {
    const bytes = encodeConformanceText(crlfSource, {
      encoding: 'utf-8-bom',
      eol: 'crlf',
      trailingNewline: true,
    });

    const report = runEncoding(bytes, { sourceEncoding: 'utf-8', sourceEol: 'crlf' });

    expect(report.ok).toBe(false);
    const failure = report.failures.find((item) => item.location.field === 'encoding.sourceEncoding');
    expect(failure?.code).toBe('conformance/encoding');
    expect(failure?.expected).toBe('utf-8');
    expect(failure?.actual).toBe('utf-8-bom');
    expect(failure?.location.sourceLine).toBe(1);
  });

  it('adapter.allowedEncodings 不含源编码 → 策略失败', () => {
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      encodingPolicy: { ...FIXTURE_ADAPTER.encodingPolicy, allowedEncodings: ['utf-8'] },
    };
    const bytes = encodeConformanceText(BASIC, {
      encoding: 'utf-8-bom',
      eol: 'lf',
      trailingNewline: true,
    });

    const report = runEncoding(bytes, { sourceEncoding: 'utf-8-bom', sourceEol: 'lf' }, adapter);

    expect(report.ok).toBe(false);
    const failure = report.failures.find(
      (item) => item.location.field === 'adapter.encodingPolicy.allowedEncodings',
    );
    expect(failure?.code).toBe('conformance/encoding');
    expect(failure?.expected).toBe('utf-8');
  });

  it('adapter.eol 不接受 CRLF → 策略失败', () => {
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      encodingPolicy: { ...FIXTURE_ADAPTER.encodingPolicy, eol: 'lf' },
    };
    const bytes = encodeConformanceText(crlfSource, {
      encoding: 'utf-8',
      eol: 'crlf',
      trailingNewline: true,
    });

    const report = runEncoding(bytes, { sourceEncoding: 'utf-8', sourceEol: 'crlf' }, adapter);

    expect(report.ok).toBe(false);
    expect(
      report.failures.some((item) => item.location.field === 'adapter.encodingPolicy.eol'),
    ).toBe(true);
  });

  it('源带 BOM 但 adapter.preserveBom=false → 策略冲突', () => {
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      encodingPolicy: { ...FIXTURE_ADAPTER.encodingPolicy, preserveBom: false },
    };
    const bytes = encodeConformanceText(BASIC, {
      encoding: 'utf-8-bom',
      eol: 'lf',
      trailingNewline: true,
    });

    const report = runEncoding(bytes, { sourceEncoding: 'utf-8-bom', sourceEol: 'lf' }, adapter);

    expect(report.ok).toBe(false);
    expect(
      report.failures.some((item) => item.location.field === 'adapter.encodingPolicy.preserveBom'),
    ).toBe(true);
  });

  it('显式换 EOL：preserveEol=false 时通过，默认 preserveEol=true 时失败', () => {
    const bytes = encodeConformanceText(BASIC, {
      encoding: 'utf-8',
      eol: 'lf',
      trailingNewline: true,
    });

    const converted = runEncoding(bytes, {
      sourceEncoding: 'utf-8',
      sourceEol: 'lf',
      outputEol: 'crlf',
      preserveEol: false,
    });
    expect(converted.ok).toBe(true);
    expect(converted.cases[0]?.observations.encoding?.preservedEol).toBe(false);

    const preserved = runEncoding(bytes, {
      sourceEncoding: 'utf-8',
      sourceEol: 'lf',
      outputEol: 'crlf',
    });
    expect(preserved.ok).toBe(false);
    expect(
      preserved.failures.some((item) => item.location.field === 'encoding.preservedEol'),
    ).toBe(true);
  });
});
