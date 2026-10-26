/**
 * 日志解码：跨块多字节不截断（本批最关键的一条）。
 *
 * 语料事实：era 系日志/文本以 Shift-JIS 为主，宿主按 ≥64 KiB / ≥100 ms 合并推块——
 * 块边界与字符边界毫无关系。这里把同一份字节在**多字节中间**切开喂两次，要求结果与
 * 整块解码**逐字相同**，且不出现任何 `U+FFFD`。
 */

import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import type { LogSession } from '@kojo/plugin-api';
import type { HostLogPage } from '../src/host';
import {
  LogServiceImpl,
  StreamingLogDecoder,
  decodeBase64,
  incompleteTailLength,
  type DecodeBytes,
} from '../src/log-service';
import { FakeHost, logChunk, makeInstance, toBase64 } from './helpers/fake-host';

const sjis = (text: string): Uint8Array => iconv.encode(text, 'shift_jis');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeSession(patch: Partial<LogSession> = {}): LogSession {
  return {
    id: 's1',
    instanceId: 'i1',
    startedAt: '2026-10-26T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    ...patch,
  };
}

function makePage(chunks: HostLogPage['chunks'], session = makeSession(), truncated = false): HostLogPage {
  return { session, chunks, truncated };
}

/** 迷你探测替身（判据与内核同形：UTF-8 fatal 成功即 utf-8，否则 shift_jis） */
const probe: DecodeBytes = (bytes) => {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  }
};

describe('LogService · 跨块解码（Shift-JIS）', () => {
  it('在多字节字符中间切开：结果与整块解码逐字相同，无替换符', async () => {
    const text = 'こんにちは、世界。\n二行目です。\n';
    const bytes = sjis(text);
    const host = new FakeHost();
    const service = new LogServiceImpl({
      host,
      getEncoding: () => ({ mode: 'fixed', fallback: 'shift_jis' }),
    });

    host.logPages.set('i1', makePage([logChunk(1, bytes)]));
    const whole = await service.tail('i1');

    // 第 1 个字节是「こ」的首字节（0x82），单独成块 ⇒ 必须被留到下一块
    host.logPages.set(
      'i1',
      makePage([logChunk(1, bytes.subarray(0, 1)), logChunk(2, bytes.subarray(1))]),
    );
    const split = await service.tail('i1');

    expect(split.lines.map((line) => line.text)).toEqual(whole.lines.map((line) => line.text));
    expect(split.lines.map((line) => line.text)).toEqual(['こんにちは、世界。', '二行目です。']);
    expect(split.lines.map((line) => line.text).join('')).not.toContain('\uFFFD');
    expect(whole.probed).toBe(false);
    expect(whole.encoding).toBe('shift_jis');
  });

  it('一行被切成 1 字节一块、切点全落在多字节中间：仍然逐字连续', () => {
    const line = 'あいうえお';
    const bytes = sjis(line);
    const decoder = new StreamingLogDecoder({ mode: 'fixed', fallback: 'shift_jis' });

    // 每块 1 字节：首字节永远落单 ⇒ 先被回退，下一块拼齐才吐字
    const pieces: string[] = [];
    for (let i = 0; i < bytes.length; i++) pieces.push(decoder.push(bytes.subarray(i, i + 1)));
    pieces.push(decoder.flush());

    expect(pieces[0]).toBe('');
    expect(pieces.join('')).toBe(line);
    expect(pieces.join('')).not.toContain('\uFFFD');
  });
});

describe('LogService · 跨块解码（UTF-8 emoji）', () => {
  it('4 字节 emoji 被切成 2 + 2：不产生替换符', async () => {
    const text = 'a😀b\n';
    const bytes = utf8(text);
    const host = new FakeHost();
    const service = new LogServiceImpl({ host, getEncoding: () => null }); // 缺省 auto/utf-8

    host.logPages.set('i1', makePage([logChunk(1, bytes)]));
    const whole = await service.tail('i1');

    host.logPages.set(
      'i1',
      makePage([logChunk(1, bytes.subarray(0, 3)), logChunk(2, bytes.subarray(3))]),
    );
    const split = await service.tail('i1');

    expect(split.lines[0]?.text).toBe('a😀b');
    expect(split.lines.map((l) => l.text)).toEqual(whole.lines.map((l) => l.text));
    expect(split.lines[0]?.text).not.toContain('\uFFFD');
  });

  it('CRLF 横跨两块时不会多出一行', async () => {
    const host = new FakeHost();
    const service = new LogServiceImpl({ host, getEncoding: () => null });
    host.logPages.set(
      'i1',
      makePage([logChunk(1, utf8('第一行\r')), logChunk(2, utf8('\n第二行\n'))]),
    );
    const page = await service.tail('i1');
    expect(page.lines.map((line) => line.text)).toEqual(['第一行', '第二行']);
  });
});

describe('LogService · 编码判据与 probed 标记', () => {
  it('探测函数缺席 ⇒ 固定标签解码，probed:false（不探测、不猜）', async () => {
    const host = new FakeHost();
    const service = new LogServiceImpl({
      host,
      getEncoding: () => ({ mode: 'auto', fallback: 'shift_jis' }),
    });
    host.logPages.set('i1', makePage([logChunk(1, sjis('テスト'))]));
    const page = await service.tail('i1');
    expect(page.lines[0]?.text).toBe('テスト');
    expect(page.probed).toBe(false);
    expect(page.encoding).toBe('shift_jis');
  });

  it('注入探测函数 ⇒ 非 UTF-8 是强证据，立即定编码，probed:true', () => {
    const decoder = new StreamingLogDecoder({ mode: 'auto', fallback: 'utf-8' }, probe);
    expect(decoder.settled).toBe(false);
    expect(decoder.push(sjis('あ'))).toBe('あ');
    expect(decoder.settled).toBe(true);
    expect(decoder.probed).toBe(true);
    expect(decoder.encoding).toBe('shift_jis');
  });

  it('纯 ASCII 前缀是弱证据：攒够 4 KiB 才定（否则可能把 SJIS 流误判成 UTF-8）', () => {
    const decoder = new StreamingLogDecoder({ mode: 'auto', fallback: 'utf-8' }, probe);
    expect(decoder.push(utf8('hello log line\n'))).toBe('');
    expect(decoder.settled).toBe(false);

    // 攒到阈值后立即定编码（ASCII 仍是合法 UTF-8 ⇒ utf-8）
    const filler = new Uint8Array(4096).fill(0x41);
    decoder.push(filler);
    expect(decoder.settled).toBe(true);
    expect(decoder.encoding).toBe('utf-8');
    expect(decoder.probed).toBe(true);
  });

  it('flush 时仍无强证据：用现有字节探测一次，不丢文本', () => {
    const decoder = new StreamingLogDecoder({ mode: 'auto', fallback: 'utf-8' }, probe);
    expect(decoder.push(utf8('短'))).toBe('');
    expect(decoder.flush()).toBe('短');
    expect(decoder.probed).toBe(true);
  });
});

describe('incompleteTailLength · 尾字节回退判据', () => {
  it('逐编码给出正确的回退长度', () => {
    // UTF-8：「あ」= E3 81 82
    expect(incompleteTailLength(utf8('あ'), 'utf-8')).toBe(0);
    expect(incompleteTailLength(utf8('あ').subarray(0, 1), 'utf-8')).toBe(1);
    expect(incompleteTailLength(utf8('あ').subarray(0, 2), 'utf-8')).toBe(2);
    // emoji F0 9F 98 80
    expect(incompleteTailLength(utf8('😀').subarray(0, 3), 'utf-8')).toBe(3);
    expect(incompleteTailLength(utf8('😀'), 'utf-8')).toBe(0);
    // Shift-JIS：首字节 0x82 单独出现 ⇒ 回退 1；半角片假名（0xB1）是完整单字节
    expect(incompleteTailLength(sjis('こ').subarray(0, 1), 'shift_jis')).toBe(1);
    expect(incompleteTailLength(sjis('こ'), 'shift_jis')).toBe(0);
    expect(incompleteTailLength(new Uint8Array([0xb1]), 'shift_jis')).toBe(0);
    // UTF-16LE：奇数字节回退 1；高位代理单独出现回退 2
    expect(incompleteTailLength(new Uint8Array([0x42]), 'utf-16le')).toBe(1);
    expect(incompleteTailLength(new Uint8Array([0x3d, 0xd8]), 'utf-16le')).toBe(2);
    expect(incompleteTailLength(new Uint8Array([0x3d, 0xd8, 0x00, 0xde]), 'utf-16le')).toBe(0);
  });
});

describe('LogService · 实时流与环形缓冲', () => {
  it('订阅后逐行推送、跨块半行不丢，recent() 给出环形快照', () => {
    const host = new FakeHost();
    const service = new LogServiceImpl({ host, getEncoding: () => null, ringSize: 3 });
    // 与组合根同一条接线：宿主事件 → 日志服务的实时面
    host.onLog((event) => service.handleHostEvent(event));
    const lines: string[] = [];
    const unsubscribe = service.subscribe('i1', (line) => lines.push(line.text));

    host.emitLog({ instanceId: 'i1', sessionId: 's1', stream: 'stdout', seq: 1, bytesBase64: toBase64(utf8('第一')) });
    host.emitLog({ instanceId: 'i1', sessionId: 's1', stream: 'stdout', seq: 2, bytesBase64: toBase64(utf8('行\n第二行')) });
    expect(lines).toEqual(['第一行']);

    // 会话结束：未闭合的半行被冲出来
    service.finishSession('i1', 's1');
    expect(lines).toEqual(['第一行', '第二行']);

    host.emitLog({ instanceId: 'i1', sessionId: 's2', stream: 'stdout', seq: 3, bytesBase64: toBase64(utf8('x2\n')) });
    host.emitLog({ instanceId: 'i1', sessionId: 's2', stream: 'stdout', seq: 4, bytesBase64: toBase64(utf8('x3')) });
    host.emitLog({ instanceId: 'i1', sessionId: 's2', stream: 'stdout', seq: 5, bytesBase64: toBase64(utf8('\n')) });
    host.emitLog({ instanceId: 'i1', sessionId: 's2', stream: 'stdout', seq: 6, bytesBase64: toBase64(utf8('x4\n')) });
    expect(lines).toEqual(['第一行', '第二行', 'x2', 'x3', 'x4']);
    // 环形缓冲：只留最近 ringSize 行
    expect(service.recent('i1').map((line) => line.text)).toEqual(['x2', 'x3', 'x4']);

    unsubscribe();
    host.emitLog({ instanceId: 'i1', sessionId: 's2', stream: 'stdout', seq: 7, bytesBase64: toBase64(utf8('x5\n')) });
    expect(lines).toEqual(['第一行', '第二行', 'x2', 'x3', 'x4']);
  });

  it('没人订阅就不解码（完整日志在盘上，tail() 随时可取）', () => {
    const host = new FakeHost();
    const service = new LogServiceImpl({ host, getEncoding: () => null });
    host.emitLog({ instanceId: 'i1', sessionId: 's1', stream: 'stdout', seq: 1, bytesBase64: toBase64(utf8('x\n')) });
    expect(service.recent('i1')).toEqual([]);
  });
});

describe('LogService · 会话与诊断包', () => {
  it('read 用会话所属实例的编码策略；sessions 原样透传', async () => {
    const host = new FakeHost();
    const instance = makeInstance({ id: 'i1', encoding: { mode: 'fixed', fallback: 'shift_jis' } });
    host.instances = [instance];
    const service = new LogServiceImpl({
      host,
      getEncoding: (id) => host.instances.find((item) => item.id === id)?.encoding ?? null,
    });
    host.logPages.set('s1', makePage([logChunk(7, sjis('一行'))]));
    host.sessionLists.set('i1', [makeSession()]);

    const page = await service.read('s1');
    expect(page.lines[0]?.text).toBe('一行');
    expect(page.encoding).toBe('shift_jis');
    expect(await service.sessions('i1')).toHaveLength(1);
  });

  it('exportBundle 省略 sessionId ⇒ 取最近会话，写盘归宿主', async () => {
    const host = new FakeHost();
    const service = new LogServiceImpl({ host, getEncoding: () => null });
    host.sessionLists.set('i1', [
      makeSession({ id: 'old', startedAt: '2026-10-25T00:00:00.000Z' }),
      makeSession({ id: 'new', startedAt: '2026-10-26T00:00:00.000Z' }),
    ]);
    const target = await service.exportBundle('i1');
    expect(target).toBe('C:/tmp/diagnostics.zip');
    expect(host.calls).toContain('logExport:i1:new');
  });
});

describe('decodeBase64 · 纯 JS（不依赖 Buffer/atob）', () => {
  it('与 Node 的 base64 逐字节一致（含尾部补位）', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 10, 255]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37) % 256);
      expect(Array.from(decodeBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });
});
