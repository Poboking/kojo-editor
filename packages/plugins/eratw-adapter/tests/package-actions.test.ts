import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { STATUS_OK_DISMISS_MS, createPackageActions } from '../src/package-actions';

/**
 * 包操作控制器（P-D 导出）单测。
 *
 * 关注点是**时序与交代**：异步动作期间面板必须有忙碌态；成功要报出落点并自动收起；
 * 失败必须常驻把原因留给用户读；用户在对话框里取消不是错误，不该留消息。
 */

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (m: string) => warnings.push(m),
    error: () => {},
  };
}

/** 只实现控制器用到的那一面（多要即抛，依赖面不含糊） */
function fakeIo(exportDirectory: FileIO['exportDirectory']): FileIO {
  return { exportDirectory } as unknown as FileIO;
}

function setup(exportDirectory: FileIO['exportDirectory']) {
  const log = fakeLogger();
  let notifies = 0;
  const actions = createPackageActions({
    io: fakeIo(exportDirectory),
    log,
    notify: () => {
      notifies += 1;
    },
  });
  return { actions, log, notifyCount: () => notifies };
}

/** 真实定时器下把微任务队列冲干净（导出是 fire-and-forget） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 假定时器下的等效冲刷（推进 1ms 顺带把 promise 回调跑完） */
const flushFake = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1);
};

const PKG = '/appdata/workspaces/p1/东方口上-灵梦 v1.0';
const NAME = '东方口上-灵梦 v1.0';

afterEach(() => {
  vi.useRealTimers();
});

describe('导出到目录（P-D）', () => {
  it('调用桥时带上源目录与中文对话框标题', async () => {
    const calls: Array<{ srcDir: string; title?: string }> = [];
    const { actions } = setup(async (srcDir, opts) => {
      calls.push({ srcDir, ...(opts?.title !== undefined ? { title: opts.title } : {}) });
      return null;
    });
    actions.exportArtifact(PKG, NAME);
    await flush();
    expect(calls).toEqual([{ srcDir: PKG, title: `导出「${NAME}」到…` }]);
  });

  it('进行中为忙碌态，成功后报出落点完整路径', async () => {
    const { actions } = setup(async () => `D:/发布/${NAME}`);
    actions.exportArtifact(PKG, NAME);
    // 尚未落定：忙碌态已经在面上（用户不会以为按钮没响应）
    expect(actions.status()).toEqual({ kind: 'busy', text: `正在导出「${NAME}」…` });
    await flush();
    expect(actions.status()).toEqual({ kind: 'ok', text: `已导出「${NAME}」到 D:/发布/${NAME}` });
  });

  it('成功态到点自动收起（保持面板清爽）', async () => {
    vi.useFakeTimers();
    const { actions } = setup(async () => 'D:/发布/out');
    actions.exportArtifact(PKG, NAME);
    await flushFake();
    expect(actions.status()?.kind).toBe('ok');
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS);
    expect(actions.status()).toBeNull();
  });

  it('用户在对话框里取消 → 不留消息（取消是正常路径，不是错误）', async () => {
    const { actions, log } = setup(async () => null);
    actions.exportArtifact(PKG, NAME);
    await flush();
    expect(actions.status()).toBeNull();
    expect(log.warnings).toEqual([]);
  });

  it('平台无对话框能力（Node 桥抛错）→ 失败态常驻并自解释呈现', async () => {
    vi.useFakeTimers();
    const { actions, log } = setup(async () => {
      throw new Error('exportDirectory is not supported by NodeBridge');
    });
    actions.exportArtifact(PKG, NAME);
    await flushFake();
    expect(actions.status()).toEqual({
      kind: 'err',
      text: '导出失败：exportDirectory is not supported by NodeBridge',
    });
    // 失败原因要留给用户读完：远超成功态的收起延时也不自动消失
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS * 10);
    expect(actions.status()?.kind).toBe('err');
    expect(log.warnings).toHaveLength(1);
  });

  it('非 Error 抛出也收敛成可读文案（不吐 [object Object]）', async () => {
    const { actions } = setup(async () => {
      throw '对话框崩了';
    });
    actions.exportArtifact(PKG, NAME);
    await flush();
    expect(actions.status()).toEqual({ kind: 'err', text: '导出失败：对话框崩了' });
  });

  it('手动关闭反馈条', async () => {
    const { actions } = setup(async () => 'D:/发布/out');
    actions.exportArtifact(PKG, NAME);
    await flush();
    actions.dismiss();
    expect(actions.status()).toBeNull();
  });

  it('新动作顶掉旧反馈，且旧定时器不会把新结果误清掉', async () => {
    vi.useFakeTimers();
    let resolveFirst: (v: string | null) => void = () => {};
    const first = new Promise<string | null>((r) => {
      resolveFirst = r;
    });
    let n = 0;
    const { actions } = setup(async () => {
      n += 1;
      return n === 1 ? first : 'D:/第二次';
    });

    actions.exportArtifact(PKG, NAME);
    resolveFirst('D:/第一次');
    await flushFake();
    // 第二次导出紧接着发起：第一次排定的自动收起必须被取消
    actions.exportArtifact(PKG, NAME);
    await flushFake();
    expect(actions.status()).toEqual({ kind: 'ok', text: `已导出「${NAME}」到 D:/第二次` });
    // 只剩第二次的定时器到期 → 此时才收起
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS);
    expect(actions.status()).toBeNull();
  });

  it('dispose 后待触发的自动收起不再打扰面板', async () => {
    vi.useFakeTimers();
    const { actions, notifyCount } = setup(async () => 'D:/发布/out');
    actions.exportArtifact(PKG, NAME);
    await flushFake();
    const before = notifyCount();
    actions.dispose();
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS);
    expect(notifyCount()).toBe(before);
  });
});
