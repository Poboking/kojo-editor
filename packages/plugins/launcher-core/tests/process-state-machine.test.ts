/**
 * 进程状态机全表（契约 §8.1）+ core 侧每实例单飞锁（第二道闸）。
 *
 * 断言的都是**可数的事实**：状态序列、宿主被调了几次、退出记录写了什么。
 * 宿主的校验链本身不在这里测（那是 Rust 侧用例的活）。
 */

import { describe, expect, it } from 'vitest';
import { ProcessSupervisorImpl } from '../src/process-supervisor';
import { FakeHost, makeStatus } from './helpers/fake-host';

const T0 = Date.parse('2026-10-26T00:00:00.000Z');

function supervisorWith(host: FakeHost, clock = { now: T0 }) {
  const seen: string[] = [];
  const supervisor = new ProcessSupervisorImpl({ host, now: () => clock.now });
  supervisor.subscribe((status) => seen.push(status.state));
  return { supervisor, seen };
}

describe('ProcessSupervisor · 状态机全表', () => {
  it('idle → starting → running → stopping → exited：每次迁移恰好广播一次', async () => {
    const host = new FakeHost();
    const { supervisor, seen } = supervisorWith(host);

    expect(supervisor.status('i1').state).toBe('idle');
    expect(host.calls).toEqual([]); // 读本地读数不打宿主

    await supervisor.start('i1');
    expect(supervisor.status('i1')).toMatchObject({ state: 'running', pid: 4242, sessionId: 's-i1' });
    await supervisor.stop('i1');

    const final = supervisor.status('i1');
    expect(final).toMatchObject({ state: 'exited', exitCode: 0, exitReason: 'user', pid: null });
    expect(seen).toEqual(['starting', 'running', 'stopping', 'exited']);
    expect(host.calls).toEqual(['start', 'stop']);
    expect(supervisor.lastExit('i1')).toMatchObject({
      sessionId: 's-i1',
      exitCode: 0,
      reason: 'user',
    });
  });

  it('start 校验失败 ⇒ 回 idle，且不产生假 exited、不写退出记录', async () => {
    const host = new FakeHost();
    host.startImpl = async () => {
      throw { code: 'LAUNCHER_TRUST_REQUIRED', message: '需要确认目标程序', detail: '校验链第 6 步' };
    };
    const { supervisor, seen } = supervisorWith(host);

    await expect(supervisor.start('i1')).rejects.toMatchObject({
      code: 'LAUNCHER_TRUST_REQUIRED',
      detail: '校验链第 6 步',
    });

    const status = supervisor.status('i1');
    expect(status.state).toBe('idle');
    expect(status).toMatchObject({ pid: null, sessionId: null, startedAt: null, exitCode: null });
    expect(status.lastError?.code).toBe('LAUNCHER_TRUST_REQUIRED');
    expect(seen).toEqual(['starting', 'idle']); // 没有 'exited'
    expect(supervisor.lastExit('i1')).toBeNull();
  });

  it('crashed 带 sessionId 与退出码；乱序事件被丢弃', async () => {
    const host = new FakeHost();
    const { supervisor, seen } = supervisorWith(host);

    supervisor.applyEvent({
      instanceId: 'i1',
      seq: 1,
      status: makeStatus('i1', {
        state: 'running',
        pid: 99,
        sessionId: 's-crash',
        startedAt: '2026-10-26T00:00:00.000Z',
      }),
    });
    supervisor.applyEvent({
      instanceId: 'i1',
      seq: 2,
      status: makeStatus('i1', {
        state: 'crashed',
        sessionId: 's-crash',
        startedAt: '2026-10-26T00:00:00.000Z',
        exitCode: 1,
        exitReason: 'crash',
      }),
    });

    expect(supervisor.status('i1')).toMatchObject({
      state: 'crashed',
      sessionId: 's-crash',
      exitCode: 1,
      exitReason: 'crash',
    });
    expect(supervisor.lastExit('i1')).toMatchObject({
      sessionId: 's-crash',
      exitCode: 1,
      reason: 'crash',
    });

    // 迟到事件（seq 更小）不得把 crashed 拉回 running
    supervisor.applyEvent({
      instanceId: 'i1',
      seq: 1,
      status: makeStatus('i1', { state: 'running', pid: 99, sessionId: 's-crash' }),
    });
    expect(supervisor.status('i1').state).toBe('crashed');
    expect(seen).toEqual(['running', 'crashed']);
  });

  it('exited / crashed 允许再次启动（§8.1 最后一行）', async () => {
    const host = new FakeHost();
    const { supervisor } = supervisorWith(host);

    supervisor.applyEvent({
      instanceId: 'i1',
      seq: 1,
      status: makeStatus('i1', { state: 'crashed', sessionId: 's1', exitCode: 2, exitReason: 'crash' }),
    });
    await supervisor.start('i1');
    expect(supervisor.status('i1').state).toBe('running');
    expect(host.calls.filter((call) => call === 'start')).toHaveLength(1);
  });

  it('未在跑的实例 stop 是幂等空操作（不打宿主）', async () => {
    const host = new FakeHost();
    const { supervisor } = supervisorWith(host);
    const status = await supervisor.stop('i1');
    expect(status.state).toBe('idle');
    expect(host.calls).toEqual([]);
  });

  it('terminal 回调每个会话恰好一次（日志服务据此冲刷半行）', () => {
    const host = new FakeHost();
    const terminals: string[] = [];
    const supervisor = new ProcessSupervisorImpl({
      host,
      now: () => T0,
      onTerminal: (status) => terminals.push(`${status.sessionId}:${status.state}`),
    });
    const crashed = makeStatus('i1', {
      state: 'crashed',
      sessionId: 's1',
      startedAt: '2026-10-26T00:00:00.000Z',
      exitCode: 1,
      exitReason: 'crash',
    });
    supervisor.applyEvent({ instanceId: 'i1', seq: 1, status: crashed });
    // 同一会话再推一条非终态（seq 递增）不得重复触发
    supervisor.applyEvent({
      instanceId: 'i1',
      seq: 2,
      status: makeStatus('i1', { state: 'running', sessionId: 's1', pid: 7 }),
    });
    expect(terminals).toEqual(['s1:crashed']);
  });
});

describe('ProcessSupervisor · 每实例单飞（core 侧第二道闸）', () => {
  it('第二个 start 在宿主之前就被拒（LAUNCHER_INSTANCE_BUSY），宿主只被调一次', async () => {
    const host = new FakeHost();
    let release!: (status: ReturnType<typeof makeStatus>) => void;
    host.startImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { supervisor } = supervisorWith(host);

    const first = supervisor.start('i1');
    await expect(supervisor.start('i1')).rejects.toMatchObject({ code: 'LAUNCHER_INSTANCE_BUSY' });
    expect(host.calls.filter((call) => call === 'start')).toHaveLength(1);

    release(makeStatus('i1', { state: 'running', pid: 4242, sessionId: 's-i1' }));
    await first;

    // 已在 running：再 start 也被本层拒（宿主同样会拒，但这里连命令都不发）
    await expect(supervisor.start('i1')).rejects.toMatchObject({ code: 'LAUNCHER_INSTANCE_BUSY' });
    expect(host.calls.filter((call) => call === 'start')).toHaveLength(1);
  });

  it('start 进行中的 stop 同样被拒（不能对半启动的实例发停止）', async () => {
    const host = new FakeHost();
    let release!: (status: ReturnType<typeof makeStatus>) => void;
    host.startImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { supervisor } = supervisorWith(host);

    const starting = supervisor.start('i1');
    await expect(supervisor.stop('i1')).rejects.toMatchObject({ code: 'LAUNCHER_INSTANCE_BUSY' });
    release(makeStatus('i1', { state: 'running', pid: 4242, sessionId: 's-i1' }));
    await starting;

    await supervisor.stop('i1', { force: true });
    expect(host.calls.filter((call) => call === 'stop')).toHaveLength(1);
    expect(supervisor.status('i1').exitReason).toBe('killed');
  });
});
