import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installFrontendErrorLog,
  recordFromErrorEvent,
  recordFromRejectionEvent,
  serializeReason,
  type FrontendErrorRecord,
} from '../src/frontend-log';

/**
 * 前端兜底错误落盘（P0-3 ③）的接线判据：
 * - error / unhandledrejection 事件 → 记录形态（消息 + 位置 + stack 详情）；
 * - 发送器可注入（mock IPC）；发送失败自吞（console.warn 留痕，不再触发 rejection）；
 * - 装配幂等（二次装不重复挂）、卸载干净（事件不再上报告）。
 * 事件用「裸 Event + 赋属性」构造：真实壳是 ErrorEvent / PromiseRejectionEvent，
 * 实现侧对字段做防御式读取——这里同时钉住"形状退化也不丢取证"。
 */

function fakeErrorEvent(fields: Record<string, unknown>): Event {
  const ev = new Event('error');
  Object.assign(ev, fields);
  return ev;
}

function fakeRejectionEvent(reason: unknown): Event {
  const ev = new Event('unhandledrejection');
  Object.assign(ev, { reason });
  return ev;
}

/** 记录收集器：断言用 */
function collector(): { sends: FrontendErrorRecord[]; send: (r: FrontendErrorRecord) => Promise<void> } {
  const sends: FrontendErrorRecord[] = [];
  return { sends, send: (r) => (sends.push(r), Promise.resolve()) };
}

describe('recordFromErrorEvent / recordFromRejectionEvent', () => {
  it('ErrorEvent 形态：消息 + 文件行列位置 + stack 进详情', () => {
    const err = new Error('底层炸了');
    err.stack = 'Error: 底层炸了\n    at foo (a.ts:3:7)';
    const rec = recordFromErrorEvent(
      fakeErrorEvent({ message: '未捕获的异常', filename: 'a.ts', lineno: 3, colno: 7, error: err }),
    );
    expect(rec).toEqual({
      level: 'error',
      message: '未捕获的异常 (a.ts:3:7)',
      detail: 'Error: 底层炸了\n    at foo (a.ts:3:7)',
    });
  });

  it('无 message 只有 error 对象：退化到 error 本身，不丢取证', () => {
    const rec = recordFromErrorEvent(fakeErrorEvent({ error: new TypeError('类型不对') }));
    expect(rec?.level).toBe('error');
    expect(rec?.message).toBe('TypeError: 类型不对');
  });

  it('完全无文本字段：返回 null（发送侧跳过）', () => {
    expect(recordFromErrorEvent(fakeErrorEvent({}))).toBeNull();
  });

  it('rejection：Error 取 name+message，stack 进详情', () => {
    const err = new RangeError('越界');
    err.stack = 'RangeError: 越界\n    at bar';
    expect(recordFromRejectionEvent(fakeRejectionEvent(err))).toEqual({
      level: 'unhandledrejection',
      message: 'RangeError: 越界',
      detail: 'RangeError: 越界\n    at bar',
    });
  });

  it('rejection：字符串与对象 reason 也可读', () => {
    expect(recordFromRejectionEvent(fakeRejectionEvent('就是一段话')).message).toBe('就是一段话');
    expect(recordFromRejectionEvent(fakeRejectionEvent({ code: 42 })).message).toBe('{"code":42}');
    expect(recordFromRejectionEvent(fakeRejectionEvent(undefined)).message).toBe('undefined');
  });
});

describe('serializeReason', () => {
  it('循环引用对象不抛（JSON.stringify 失败退 String）', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => serializeReason(o)).not.toThrow();
    expect(typeof serializeReason(o)).toBe('string');
  });
});

describe('installFrontendErrorLog 接线', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubWindow(): EventTarget {
    const w = new EventTarget();
    vi.stubGlobal('window', w);
    return w;
  }

  it('window error 事件 → 发送器收到记录', () => {
    const w = stubWindow();
    const { sends, send } = collector();
    cleanups.push(installFrontendErrorLog(send));
    w.dispatchEvent(
      fakeErrorEvent({ message: '运行时错误', filename: 'b.ts', lineno: 9, colno: 1, error: new Error('e') }),
    );
    expect(sends.map((r) => r.level)).toEqual(['error']);
    expect(sends[0].message).toBe('运行时错误 (b.ts:9:1)');
  });

  it('unhandledrejection 事件 → 发送器收到记录', () => {
    const w = stubWindow();
    const { sends, send } = collector();
    cleanups.push(installFrontendErrorLog(send));
    w.dispatchEvent(fakeRejectionEvent('未处理的拒绝'));
    expect(sends.map((r) => r.level)).toEqual(['unhandledrejection']);
    expect(sends[0].message).toBe('未处理的拒绝');
  });

  it('发送器拒绝：自吞不抛，console.warn 留痕（不再触发二次 rejection）', async () => {
    const w = stubWindow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = () => Promise.reject(new Error('IPC 不可用'));
    cleanups.push(installFrontendErrorLog(send));
    // 派发本身必须同步无异常
    expect(() => w.dispatchEvent(fakeRejectionEvent('会失败的记录'))).not.toThrow();
    // 微任务跑完后：warn 被调过一次
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('前端错误落盘');
  });

  it('卸载后事件不再上报告', () => {
    const w = stubWindow();
    const { sends, send } = collector();
    const uninstall = installFrontendErrorLog(send);
    uninstall();
    w.dispatchEvent(fakeErrorEvent({ message: '卸载后的错误' }));
    expect(sends).toHaveLength(0);
  });

  it('重复装配幂等：同一事件只发一份', () => {
    const w = stubWindow();
    const a = collector();
    const b = collector();
    cleanups.push(installFrontendErrorLog(a.send));
    cleanups.push(installFrontendErrorLog(b.send)); // 第二次应是 no-op
    w.dispatchEvent(fakeErrorEvent({ message: '只该有一份' }));
    expect(a.sends).toHaveLength(1);
    expect(b.sends).toHaveLength(0);
  });
});