/**
 * PS-5 · 广播去重台账改存**指纹**（document-broadcast.ts）。
 *
 * 改前每条台账背着"上次发出的整份正文"，32 条就是最多 32 份正文常驻（真实语料最大
 * 单文件 2.35 MB ⇒ 满载是几十 MB 级）。现在每条 ≈ 200 字节。
 *
 * 要钉的是**判据没有变松**：台账判等一次都不能出错，因为
 * "把不同文本判成相同" = 该发的一条不发的 = 面板停在旧真相上且没人说话（铁律 4）。
 * 所以四条都要有：同文本仍去重 / 任何一处改动必发（含"同长度、首尾不动、只改中间"）/
 * flush 照旧不去重 / 淘汰只是多广播一条。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentBroadcastPayload, TextStamp } from '../src/ui/document-broadcast';
import {
  LAST_SENT_MAX_ENTRIES,
  TEXT_STAMP_SAMPLE,
  createDocumentBroadcaster,
  sameStamp,
  stampOf,
} from '../src/ui/document-broadcast';

afterEach(() => {
  vi.useRealTimers();
});

function collect() {
  const sent: DocumentBroadcastPayload[] = [];
  return { sent, emit: (p: DocumentBroadcastPayload) => sent.push(p) };
}

/** 台账判等的**反证素材**：同长度、首尾 64 码元一字未动、只有中间变了 */
function middleEdit(base: string, at: number, ch: string): string {
  return base.slice(0, at) + ch + base.slice(at + 1);
}

describe('stampOf / sameStamp（指纹判据）', () => {
  it('同一份文本两次取样必判等（去重这条腿成立）', () => {
    const t = '角色: 1\n「今天天气不错。」\n'.repeat(50);
    expect(sameStamp(stampOf(t), stampOf(t))).toBe(true);
  });

  it('空串也是真相：与"没有条目"判不等，且空串之间判等', () => {
    const empty = stampOf('');
    expect(sameStamp(undefined, empty)).toBe(false);
    expect(sameStamp(empty, stampOf(''))).toBe(true);
    expect(sameStamp(empty, stampOf('a'))).toBe(false);
  });

  it('中间同长度替换（首尾未动）必须判不等——这条是最容易静默漏广播的形态', () => {
    const base = 'x'.repeat(4096);
    const a: TextStamp = stampOf(base);
    const b: TextStamp = stampOf(middleEdit(base, 2_000, 'y'));
    expect(b.length).toBe(a.length);
    expect(b.head).toBe(a.head);
    expect(b.tail).toBe(a.tail);
    expect(sameStamp(a, b)).toBe(false);
  });

  it('末尾一字 / 开头一字 / 只加长 一字，三种都判不等', () => {
    const a = stampOf('口上一段');
    for (const other of ['口上一段。', '。口上一段', '口上一段x']) expect(sameStamp(a, stampOf(other))).toBe(false);
  });

  it('指纹的常驻尺寸与文本长度无关（首尾各取样一次，中间只留两个 32 位数）', () => {
    const s = stampOf('字'.repeat(1_000_000));
    expect(s.head.length).toBe(TEXT_STAMP_SAMPLE);
    expect(s.tail.length).toBe(TEXT_STAMP_SAMPLE);
    expect(s.length).toBe(1_000_000);
  });
});

describe('广播器：判等语义逐条不许变松', () => {
  it('同 path 同文本仍去重（空转不广播）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.flush('p.kojo', () => ({ text: 'same', dirty: false }));
    b.schedule('p.kojo', () => ({ text: 'same', dirty: true }));
    vi.advanceTimersByTime(301);
    expect(sent).toHaveLength(1);
  });

  it('中间同长度替换 ⇒ 防抖那一拍必须发（台账是指纹不是全文，判等不能因此变松）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 100 });
    const base = 'x'.repeat(5_000);
    b.flush('a.erb', () => ({ text: base, dirty: false }));
    b.schedule('a.erb', () => ({ text: middleEdit(base, 3_000, 'y'), dirty: true }));
    vi.advanceTimersByTime(101);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('y');
  });

  it('flush 照旧**不走去重**（同文本也要补发一次：面板可能刚挂载）', () => {
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit });
    b.flush('p.kojo', () => ({ text: 'same', dirty: false }));
    b.flush('p.kojo', () => ({ text: 'same', dirty: false }));
    expect(sent).toHaveLength(2);
  });

  it('LRU 淘汰的代价方向安全：被淘汰的那条下一次同文本会白广播一条（不丢真相）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10, maxEntries: 2 });
    b.flush('p1', () => ({ text: 't1', dirty: false }));
    b.flush('p2', () => ({ text: 't2', dirty: false }));
    b.flush('p3', () => ({ text: 't3', dirty: false })); // 顶掉 p1
    b.schedule('p1', () => ({ text: 't1', dirty: true })); // 同文本，但台账已没 ⇒ 该发
    vi.advanceTimersByTime(11);
    expect(sent.map((p) => p.filePath)).toEqual(['p1', 'p2', 'p3', 'p1']);
    expect(LAST_SENT_MAX_ENTRIES).toBe(32);
  });

  it('forget 之后重开同一文件必重新广播一次（旧台账不许把首拍去重掉）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.flush('C:\\game\\ERB\\a.ERB', () => ({ text: 'same', dirty: false }));
    b.forget('c:\\game\\erb\\a.erb'); // pathKey 归一（HK-7 口径：大小写/分隔符不同也要认）
    b.schedule('C:\\game\\ERB\\a.ERB', () => ({ text: 'same', dirty: false }));
    vi.advanceTimersByTime(11);
    expect(sent).toHaveLength(2);
  });
});
