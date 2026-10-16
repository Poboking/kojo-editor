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
