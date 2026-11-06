/**
 * 契约面分页游标编解码单测（B1 分页游标批）。
 *
 * 这里钉的是**契约形状与账目口径**，不碰内核 / Monaco：
 * - `pageFingerprint` 稳定（同序同值同指纹）、对顺序 / 长度 / 内容敏感；
 * - `decodePageCursor` 对脏值一律返回 null（不猜、不 `as` 兜底成 0），与 schema 的
 *   `pattern` 逐字同尺；
 * - `assertCursorShape` 对非法形状显式 `INVALID_ARGS`（绝不静默退回第一页冒充连续）；
 * - `pageParamsFor` 游标优先于裸 offset，页大小逐个别名兼容并 clamp（闸不放宽）；
 * - `paginateByCursor` / `paginateText` 的完整性账：total / truncated / hasMore /
 *   nextCursor 自洽，快照变化显式 `changedDuringPaging` 并从 0 重来，越界显式报错。
 */
import { describe, expect, it } from 'vitest';
import {
  HOST_UNTRUSTED_STRING_GATE,
  McpFailure,
  PAGE_ACCOUNT_NOTE,
  PAGE_CURSOR_SCHEMA_PROPS,
  assertCursorShape,
  decodePageCursor,
  encodePageCursor,
  pageFingerprint,
  pageParamsFor,
  paginateByCursor,
  paginateText,
  slimActiveDocument,
  KERNEL_IO_TOOL_SPECS,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
} from '../src/index';

/* ------------------------------- 指纹 ------------------------------- */

describe('pageFingerprint：稳定且敏感', () => {
  it('同输入同指纹（跨调用稳定，翻页靠它定位）', () => {
    const parts = ['a.erb', 'b.erb', 'c.erb'];
    expect(pageFingerprint(parts)).toBe(pageFingerprint([...parts]));
    expect(pageFingerprint(parts)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('对顺序 / 内容 / 条数敏感（任何一项变了都得出声）', () => {
    const base = pageFingerprint(['a', 'b', 'c']);
    expect(pageFingerprint(['b', 'a', 'c'])).not.toBe(base);
    expect(pageFingerprint(['a', 'b', 'd'])).not.toBe(base);
    expect(pageFingerprint(['a', 'b', 'c', ''])).not.toBe(base);
    expect(pageFingerprint([])).not.toBe(base);
  });

  it('非 ASCII 与空串都有稳定指纹（不把空集当 0 指纹）', () => {
    expect(pageFingerprint(['口上', 'Ａ'])).toBe(pageFingerprint(['口上', 'Ａ']));
    expect(pageFingerprint([])).toMatch(/^[0-9a-f]{8}$/);
  });
});

/* ------------------------------- 游标编解码 ------------------------------- */

describe('encodePageCursor / decodePageCursor', () => {
  it('编解码回环：指纹与下标逐字取回', () => {
    const fp = pageFingerprint(['x']);
    for (const index of [0, 1, 4096, 65_535, 1_000_000]) {
      expect(decodePageCursor(encodePageCursor(fp, index))).toEqual({ fingerprint: fp, index });
    }
  });

  const DIRTY: readonly [string, unknown][] = [
    ['非串：数字', 1234],
    ['非串：null', null],
    ['非串：undefined', undefined],
    ['非串：对象', { fingerprint: 'abcd1234', index: 1 }],
    ['空串', ''],
    ['缺冒号', 'abcd1234'],
    ['缺下标', 'abcd1234:'],
    ['大写十六进制', 'ABCD1234:1'],
    ['指纹位数不足', 'abcd123:1'],
    ['指纹位数超', 'abcd12345:1'],
    ['负下标', 'abcd1234:-1'],
    ['下标带小数', 'abcd1234:1.5'],
    ['下标非数字', 'abcd1234:xx'],
    ['下标超 10 位', 'abcd1234:12345678901'],
    ['尾随空白', 'abcd1234:1 '],
    ['多段', 'abcd1234:1:2'],
    ['前导加号', 'abcd1234:+1'],
  ];
  it.each(DIRTY)('脏值 ⇒ null（%s）：不猜、不兜底成 0', (_label, raw) => {
    expect(decodePageCursor(raw)).toBeNull();
  });

  it('assertCursorShape：未给游标放行，给了脏值显式 INVALID_ARGS', () => {
    expect(() => assertCursorShape({})).not.toThrow();
    expect(() => assertCursorShape({ cursor: null })).not.toThrow();
    expect(() => assertCursorShape({ cursor: 'abcd1234:12' })).not.toThrow();
    expect(() => assertCursorShape({ cursor: 'zzzz' })).toThrow(McpFailure);
    try {
      assertCursorShape({ cursor: 'zzzz' });
      throw new Error('本应抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(McpFailure);
      expect((err as McpFailure).code).toBe('INVALID_ARGS');
      expect((err as McpFailure).message).toContain('上一页 nextCursor');
    }
  });

  it('schema pattern 与解码器逐字同尺（声明的合法形状＝真收的形状）', () => {
    const pattern = String((PAGE_CURSOR_SCHEMA_PROPS['cursor'] as Record<string, unknown>)['pattern']);
    const re = new RegExp(pattern);
    const good = encodePageCursor(pageFingerprint(['a']), 7);
    expect(re.test(good)).toBe(true);
    expect(decodePageCursor(good)).not.toBeNull();
    for (const bad of ['ABCD1234:1', 'abcd123:1', 'abcd1234:-1', 'abcd1234:1.5']) {
      expect(re.test(bad)).toBe(false);
      expect(decodePageCursor(bad)).toBeNull();
    }
  });
});

/* ------------------------------- 取页参数 ------------------------------- */

describe('pageParamsFor：游标优先、别名兼容、页大小 clamp', () => {
  const opts = { defaultLimit: 50, maxLimit: 200 };

  it('零参调用＝第一页 + 默认页大小（旧行为零改动）', () => {
    expect(pageParamsFor({}, opts)).toEqual({ limit: 50, offset: 0, hasCursor: false });
  });

  it('游标优先于裸 offset', () => {
    const cursor = encodePageCursor(pageFingerprint(['a']), 120);
    expect(pageParamsFor({ offset: 5, cursor }, opts)).toEqual({ limit: 50, offset: 120, hasCursor: true });
  });

  it('旧页大小别名逐个仍生效（limit/length/maxChars/maxResults/maxEntries/…）', () => {
    for (const alias of ['limit', 'length', 'maxChars', 'maxResults', 'maxEntries', 'maxRanges', 'maxEvents', 'maxLines']) {
      expect(pageParamsFor({ [alias]: 30 }, opts).limit).toBe(30);
    }
  });

  it('页大小 clamp：天大压回上限、0 与负数压回 1、非数字回默认（闸不放宽，也不死锁）', () => {
    expect(pageParamsFor({ limit: 5_000_000 }, opts).limit).toBe(200);
    expect(pageParamsFor({ limit: 0 }, opts).limit).toBe(1);
    expect(pageParamsFor({ limit: -7 }, opts).limit).toBe(1);
    expect(pageParamsFor({ limit: 'nonsense' }, opts).limit).toBe(50);
    expect(pageParamsFor({ limit: 12.9 }, opts).limit).toBe(12);
  });

  it('脏游标在取参数这一层就显式报错，不当第一页继续', () => {
    expect(() => pageParamsFor({ cursor: 'not-a-cursor' }, opts)).toThrow(/cursor 形状不合法/);
  });
});

/* ------------------------------- 列举面分页 ------------------------------- */

describe('paginateByCursor：完整性账', () => {
  const items = Array.from({ length: 95 }, (_, i) => `i${i}`);
  const keyOf = (s: string): string => s;
  const opts = { defaultLimit: 10, maxLimit: 50 };

  it('逐页取满：并集 == 全集，同序无重无漏，末页 hasMore=false 且 nextCursor=null', () => {
    const flat: string[] = [];
    let args: Record<string, unknown> = {};
    let pages = 0;
    for (;;) {
      const r = paginateByCursor(items, keyOf, args, opts);
      flat.push(...r.page);
      pages += 1;
      expect(r.total).toBe(items.length);
      expect(r.truncated).toBe(r.page.length < items.length);
      if (!r.hasMore) {
        expect(r.nextCursor).toBeNull();
        break;
      }
      expect(r.nextCursor).not.toBeNull();
      args = { cursor: r.nextCursor };
      if (pages > 200) throw new Error('未见底');
    }
    expect(flat).toEqual(items);
    expect(pages).toBe(10); // 9 页满 10 条 + 末页 5 条
  });

  it('空全集：total 0 / hasMore false / nextCursor null（不是空数组冒充有下一页）', () => {
    const r = paginateByCursor([], keyOf, {}, opts);
    expect(r.page).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it('快照变化 ⇒ changedDuringPaging + 回到第 0 页（绝不接着旧下标切）', () => {
    const first = paginateByCursor(items, keyOf, {}, opts);
    const mutated = [...items.slice(0, 40), 'INSERTED', ...items.slice(40)];
    const next = paginateByCursor(mutated, keyOf, { cursor: first.nextCursor }, opts);
    expect(next.changedDuringPaging).toBe(true);
    expect(next.offset).toBe(0);
    expect(next.total).toBe(mutated.length);
    // 未变的快照：同一游标续页，绝不出现 changedDuringPaging
    const same = paginateByCursor(items, keyOf, { cursor: first.nextCursor }, opts);
    expect(same.changedDuringPaging).toBeUndefined();
    expect(same.offset).toBe(10);
  });

  it('游标下标越界（快照未变）⇒ INVALID_ARGS，不回空页冒充到底', () => {
    const fp = pageFingerprint(items);
    expect(() => paginateByCursor(items, keyOf, { cursor: encodePageCursor(fp, items.length + 1) }, opts)).toThrow(/越界/);
    // 恰好等于全集长度是「零条下一页」的合法边界吗？——不是：nextCursor 只在 hasMore 时签发，
    // 等于长度的游标同样来自篡改或旧口径，越界口径统一（page >= total 一律出声）。
    expect(() => paginateByCursor(items, keyOf, { cursor: encodePageCursor(fp, items.length) }, opts)).not.toThrow();
  });

  it('limit 天大也 clamp 到本面上限：page 长度不超过 maxLimit', () => {
    const r = paginateByCursor(items, keyOf, { limit: 9_999_999 }, opts);
    expect(r.page.length).toBe(opts.maxLimit);
    expect(r.hasMore).toBe(true);
  });
});

/* ------------------------------- 文本面分页 ------------------------------- */

describe('paginateText：完整性账 + 快照保证', () => {
  const text = '口上\n'.repeat(300); // 1500 字符
  const opts = { defaultLimit: 200, maxLimit: 640 };

  it('逐页拼接 == 原文，逐字符等值', () => {
    const pages: string[] = [];
    let args: Record<string, unknown> = {};
    let seen = 0;
    for (;;) {
      const r = paginateText(text, args, opts);
      pages.push(r.page);
      seen += r.page.length;
      expect(r.total).toBe(text.length);
      expect(r.offset).toBe(seen - r.page.length);
      if (!r.hasMore) break;
      args = { cursor: r.nextCursor };
      if (pages.length > 500) throw new Error('未见底');
    }
    expect(pages.join('')).toBe(text);
    expect(seen).toBe(text.length);
    expect(text.length % opts.maxLimit).not.toBe(0); // 末页非满，才测得到见底口径
  });

  it('正文尾部变化也出声：前缀相同、快照不同 ⇒ changedDuringPaging 且 offset 归 0', () => {
    const first = paginateText(text, { limit: 640 }, opts);
    const changed = `${text}X`;
    const next = paginateText(changed, { limit: 640, cursor: first.nextCursor }, opts);
    expect(next.changedDuringPaging).toBe(true);
    expect(next.offset).toBe(0);
    expect(next.total).toBe(changed.length);
  });

  it('越界游标显式报错；单页长度永不超闸（且压在宿主不可信串闸之下）', () => {
    const fp = pageFingerprint([text]);
    expect(() => paginateText(text, { cursor: encodePageCursor(fp, text.length + 1) }, opts)).toThrow(/越界/);
    expect(paginateText(text, { limit: 9_999_999 }, opts).page.length).toBe(opts.maxLimit);
    expect(opts.maxLimit).toBeLessThan(HOST_UNTRUSTED_STRING_GATE);
  });

  it('裸 offset（无游标）＝调用方自定窗口：不做连续性保证，但账自洽', () => {
    const r = paginateText(text, { offset: 850, limit: 100 }, opts);
    expect(r.offset).toBe(850);
    expect(r.page).toBe(text.slice(850));
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
    expect(r.total).toBe(text.length);
    expect(r.truncated).toBe(true);
  });
});

/* ------------------------------- 工具形状：游标是入参，不是新工具 ------------------------------- */

describe('工具形状（B1 只加入参，不加新工具名；闸值未动）', () => {
  const all = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];

  it('具名分页面的 inputSchema 都声明 limit + cursor，且形状与契约面同源', () => {
    const paged = all.filter((t) => JSON.stringify(t.inputSchema).includes('"cursor"'));
    expect(paged.length).toBeGreaterThanOrEqual(12);
    for (const t of paged) {
      const props = (t.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>;
      expect(props).toHaveProperty('cursor');
      expect(props).toHaveProperty('limit');
      expect(props['cursor']).toEqual(PAGE_CURSOR_SCHEMA_PROPS['cursor']);
      expect(props['limit']).toEqual(PAGE_CURSOR_SCHEMA_PROPS['limit']);
    }
  });

  it('没有游标入参的面也仍在册（分页是加法，不删面）：面数读数不因本批改变', () => {
    expect(SEMANTIC_TOOL_SPECS.length).toBe(8);
    expect(KERNEL_IO_TOOL_SPECS.length).toBe(3);
    expect(SUPPLEMENTAL_TOOL_SPECS.length).toBe(29);
    expect(all.length).toBe(40);
  });

  it('resource 面截断即引路到带游标的工具面（不是死路）', () => {
    const slim = slimActiveDocument({ text: '字'.repeat(20_000), uri: 'file:///d:/a.erb', lineCount: 1 });
    expect(slim['hasMore']).toBe(true);
    expect(slim['pageableVia']).toBe('tool');
    expect(slim['pageTool']).toBe('document.active');
    expect(String(slim['pageHint'])).toContain('limit+cursor');
  });

  it('截断闸未放宽：resource 文本 24000、active 文档 8000、不可信串 64Ki', () => {
    const slim = slimActiveDocument({ text: '字'.repeat(20_000), uri: 'file:///d:/a.erb', lineCount: 1 });
    expect(String((slim as Record<string, unknown>)['text']).length).toBeLessThanOrEqual(8_000);
    expect(HOST_UNTRUSTED_STRING_GATE).toBe(64 * 1024);
    expect(PAGE_ACCOUNT_NOTE).toContain('changedDuringPaging');
  });
});
