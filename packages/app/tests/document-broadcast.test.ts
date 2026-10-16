/**
 * C2 批单测：`editor.documentChanged` 的宿主侧调度纯逻辑（零 React、零 kernel）。
 *
 * 钉死四个最容易悄悄坏的行为：
 *   1. 防抖合并——击键流只落地一条，且文本是**落地时刻**现取的（不是排程时刻的）；
 *   2. 去重——同一 path 与上次已发出的文本逐字相同即跳过（path 判等走 pathKey 归一）；
 *   3. 抑制 derived——糖视图激活时丢弃在途排程、不发；恢复后补发；
 *   4. flush 语义——立即广播并作废在途排程；read 为 null 时整次作废。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentBroadcastPayload } from '../src/ui/document-broadcast';
import { createDocumentBroadcaster } from '../src/ui/document-broadcast';

afterEach(() => {
  vi.useRealTimers();
});

/** 采集 emit 的载荷 + 记录调用次序 */
function collect() {
  const sent: DocumentBroadcastPayload[] = [];
  return { sent, emit: (p: DocumentBroadcastPayload) => sent.push(p) };
}

describe('C2 / document-broadcast 防抖', () => {
  it('击键流合并成一条；read 在落地时刻现取（拿到最新文本而非排程时刻的）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    let text = 'a';
    b.schedule('C:\\p\\x.kojo', () => ({ text, dirty: true }));
    vi.advanceTimersByTime(200);
    text = 'ab'; // 排程之后又敲了一键——落地必须看到它
    b.schedule('C:\\p\\x.kojo', () => ({ text, dirty: true }));
    vi.advanceTimersByTime(299);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ filePath: 'C:\\p\\x.kojo', text: 'ab', dirty: true });
  });

  it('dispose 清掉在途排程（不再发）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.schedule('p.kojo', () => ({ text: 'x', dirty: true }));
    b.dispose();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });
});

describe('C2 / document-broadcast 去重（只管防抖通道）', () => {
  it('同 path 同文本跳过；文本变化才发', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.flush('p.kojo', () => ({ text: 'same', dirty: false }));
    expect(sent).toHaveLength(1);
    b.schedule('p.kojo', () => ({ text: 'same', dirty: true })); // 空转（文本没变）
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
    b.schedule('p.kojo', () => ({ text: 'changed', dirty: true }));
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toBe('changed');
  });

  it('flush 是显式断言、不走去重：面板晚于上次广播挂载时靠它补真相', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.flush('p.kojo', () => ({ text: 't', dirty: true }));
    b.flush('p.kojo', () => ({ text: 't', dirty: true })); // 切回同一文件：必须再发一条
    expect(sent).toHaveLength(2);
  });

  it('path 判等走 pathKey 归一：分隔符/大小写不同的同一文件不重复发', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.flush('C:\\Proj\\X.kojo', () => ({ text: 't', dirty: false }));
    b.schedule('c:/proj/x.kojo', () => ({ text: 't', dirty: false })); // 防抖通道：命中归一后的台账
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
  });

  it('read 返回 null（model 已关）时不发，且不污染去重台账', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.schedule('p.kojo', () => null);
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(0);
    b.schedule('p.kojo', () => ({ text: 't', dirty: true }));
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
  });
});

describe('C2 / document-broadcast 抑制 derived 视图', () => {
  it('抑制中：在途排程被丢弃、不发；恢复后 flush 补发一条', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    let suppressed = false;
    const b = createDocumentBroadcaster({ emit, suppressed: () => suppressed, delayMs: 300 });
    b.schedule('p.kojo', () => ({ text: 'typed', dirty: true }));
    suppressed = true; // 排程后、落地前切进了糖视图
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(0); // 落地时刻抑制 → 丢弃，绝不发派生文本
    b.flush('p.kojo', () => ({ text: 'typed', dirty: true }));
    expect(sent).toHaveLength(0); // 抑制中补发同样不发
    suppressed = false; // 切回原码
    b.flush('p.kojo', () => ({ text: 'typed', dirty: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('typed');
  });
});

describe('C2 / document-broadcast flush', () => {
  it('flush 立即广播，并作废在途排程（不产生第二条）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.schedule('p.kojo', () => ({ text: 'old', dirty: true }));
    b.flush('p.kojo', () => ({ text: 'new', dirty: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('new');
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });
});

/* ---------------- S2-3：去重台账存的是整份文本 ⇒ 必须有界 ---------------- */

describe('S2-3 / 去重台账有界（LRU + forget）', () => {
  it('超过容量的最旧条目被淘汰：台账不随"开过的标签数 × 全文体积"无限长', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10, maxEntries: 2 });
    b.schedule('a.kojo', () => ({ text: 'ta', dirty: true }));
    vi.advanceTimersByTime(10);
    b.schedule('b.kojo', () => ({ text: 'tb', dirty: true }));
    vi.advanceTimersByTime(10);
    b.schedule('c.kojo', () => ({ text: 'tc', dirty: true })); // 挤掉最旧的 a.kojo
    vi.advanceTimersByTime(10);
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)!.filePath).toBe('c.kojo');

    sent.length = 0;
    b.schedule('a.kojo', () => ({ text: 'ta', dirty: true })); // 同文本，但台账里已经没有它了
    vi.advanceTimersByTime(10);
    expect(sent).toHaveLength(1); // 淘汰的代价 = 多广播一条（方向安全），绝不是无限驻留
  });

  it('LRU 读写都 touch：反复用的那条不会先被淘汰', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10, maxEntries: 2 });
    b.flush('a.kojo', () => ({ text: 'ta', dirty: false }));
    b.flush('b.kojo', () => ({ text: 'tb', dirty: false }));
    b.schedule('a.kojo', () => ({ text: 'ta', dirty: false })); // 命中台账被去重，同时把 a 顶到最新
    vi.advanceTimersByTime(10);
    expect(sent).toHaveLength(2);
    b.flush('c.kojo', () => ({ text: 'tc', dirty: false })); // 这次淘汰的是 b
    b.schedule('a.kojo', () => ({ text: 'ta', dirty: false }));
    vi.advanceTimersByTime(10);
    expect(sent).toHaveLength(3); // a 仍在台账 ⇒ 不重发；只发了 c 那条
    expect(sent.at(-1)!.filePath).toBe('c.kojo');
  });

  it('forget（关标签）摘掉这条台账：重开同一文件的第一拍必须重新广播真相', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.flush('C:\\p\\x.kojo', () => ({ text: 't', dirty: false }));
    b.forget('c:/p/x.kojo'); // 平台写法不同也要摘得掉（pathKey 归一，与去重同一把尺子）
    b.schedule('C:\\p\\x.kojo', () => ({ text: 't', dirty: false })); // 同文本：没 forget 会被去重掉
    vi.advanceTimersByTime(10);
    expect(sent).toHaveLength(2);
  });

  it('forget 掉的这条若有在途排程，一并作废（不给已关闭的标签发真相）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.schedule('p.kojo', () => ({ text: 't', dirty: true }));
    b.forget('p.kojo');
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(0);
  });

  it('dispose 释出去重台账（面板寿命结束时不留整份文本）', () => {
    vi.useFakeTimers();
    const { emit: _emit, sent } = collect();
    const b = createDocumentBroadcaster({ emit: _emit, delayMs: 10 });
    b.flush('p.kojo', () => ({ text: 't', dirty: false }));
    b.dispose();
    expect(sent).toHaveLength(1);
    // dispose 后台账已空：同一文本再走防抖通道不会被"已经发过"吞掉
    b.schedule('p.kojo', () => ({ text: 't', dirty: false }));
    vi.advanceTimersByTime(10);
    expect(sent).toHaveLength(2);
  });
});
