import { describe, expect, it } from 'vitest';
import {
  compareContent,
  linesEqualOf,
  splitContentLines,
  type ContentSide,
} from '../src/content-equality';

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const side = (over: Partial<ContentSide>): ContentSide => ({ ...over });

describe('splitContentLines', () => {
  it('三种换行风格切出同一组行内容', () => {
    expect(splitContentLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('末尾换行是结构差异（"a\\n" 两行、"a" 一行）', () => {
    expect(splitContentLines('a\n')).toEqual(['a', '']);
    expect(splitContentLines('a')).toEqual(['a']);
  });
});

describe('compareContent · 字节态与行态同源派生', () => {
  it('两侧字节与文本全同 ⇒ 两态皆真、无差异偏移', () => {
    const e = compareContent(side({ bytes: bytesOf('a\nb'), text: 'a\nb' }), side({ bytes: bytesOf('a\nb'), text: 'a\nb' }));
    expect(e).toEqual({ bytesEqual: true, linesEqual: true, firstByteDiff: null, firstLineDiff: null });
  });

  it('负自证①：字节相同而文本不同（缓冲区文本配盘上字节）⇒ 字节真、行假', () => {
    const e = compareContent(
      side({ bytes: bytesOf('a\nb'), text: '编辑中的另一版' }),
      side({ bytes: bytesOf('a\nb'), text: 'a\nb' }),
    );
    expect(e.bytesEqual).toBe(true);
    expect(e.linesEqual).toBe(false);
    expect(e.firstByteDiff).toBeNull();
    expect(e.firstLineDiff).toBe(1);
  });

  it('负自证②：行相同而编码不同（Shift-JIS 字节 vs UTF-8 字节，同一段文本）⇒ 行真、字节假', () => {
    // "あ" 的 Shift-JIS 是 82 A0；UTF-8 是 E3 81 82
    const shiftJis = new Uint8Array([0x82, 0xa0]);
    const utf8 = new Uint8Array([0xe3, 0x81, 0x82]);
    const e = compareContent(side({ bytes: shiftJis, text: 'あ' }), side({ bytes: utf8, text: 'あ' }));
    expect(e.linesEqual).toBe(true);
    expect(e.bytesEqual).toBe(false);
    expect(e.firstByteDiff).toBe(0);
    expect(e.firstLineDiff).toBeNull();
  });

  it('负自证②b：换行风格不同（LF vs CRLF）⇒ 行真、字节假', () => {
    const e = compareContent(
      side({ bytes: bytesOf('a\r\nb'), text: 'a\r\nb' }),
      side({ bytes: bytesOf('a\nb'), text: 'a\nb' }),
    );
    expect(e.linesEqual).toBe(true);
    expect(e.bytesEqual).toBe(false);
  });

  it('行内容不同 ⇒ 首个差异行号（1 基）', () => {
    const e = compareContent(side({ text: 'a\nb\nc' }), side({ text: 'a\nX\nc' }));
    expect(e.linesEqual).toBe(false);
    expect(e.firstLineDiff).toBe(2);
  });

  it('长度不同 ⇒ 首个差异在较短一侧之后', () => {
    const e = compareContent(side({ bytes: new Uint8Array([1, 2]) }), side({ bytes: new Uint8Array([1, 2, 3]) }));
    expect(e.bytesEqual).toBe(false);
    expect(e.firstByteDiff).toBe(2);
    expect(compareContent(side({ text: 'a' }), side({ text: 'a\nb' })).firstLineDiff).toBe(2);
  });

  it('任一侧缺证据 ⇒ 对应态为 null（不猜），另一态照判', () => {
    const inline = compareContent(side({ text: 'x' }), side({ bytes: bytesOf('x'), text: 'x' }));
    expect(inline.bytesEqual).toBeNull();
    expect(inline.linesEqual).toBe(true);
    expect(inline.firstByteDiff).toBeNull();
  });
});

describe('linesEqualOf', () => {
  it('只拿文本也能判行态；缺一侧 = null', () => {
    expect(linesEqualOf('a\r\nb', 'a\nb')).toBe(true);
    expect(linesEqualOf('a', 'b')).toBe(false);
    expect(linesEqualOf(undefined, 'a')).toBeNull();
  });
});
