import { describe, expect, it, vi } from 'vitest';
import type { Kernel, StorageFlushReport } from '@kojo/kernel';
import type { RecentProject } from '@kojo/plugin-api';
import {
  closeProjectSession,
  crashExitDecision,
  type CloseProjectSessionDeps,
} from '../src/ui/project-close';

/**
 * 关项目拆除序的行为判据（REF-FRONT-PERF，2026-10-20）。
 *
 * 这条线修的是「close 一抛错，后面全跳过」：最小 fake kernel 只给 close / recent /
 * fileWatch.stop 三个面，钉住——close 失败时 stop、清写允许域、状态复位、recent
 * 仍按原顺序执行，并合成一条显式错误。不起 React、不起壳。
 */

interface MakeKernelOptions {
  close?: () => Promise<void>;
  recent?: () => Promise<RecentProject[]>;
  stop?: () => void;
  /** E·R6：落盘屏障（不传 = 替身 kernel 不实现这条 optional） */
  flushStorage?: (timeoutMs?: number) => Promise<StorageFlushReport>;
}

function makeKernel(opts: MakeKernelOptions = {}): { kernel: Kernel; calls: string[] } {
  const calls: string[] = [];
  const kernel = {
    project: {
      close: async () => {
        calls.push('close');
        if (opts.close) await opts.close();
      },
      recent: async () => {
        calls.push('recent');
        return opts.recent ? opts.recent() : [];
      },
    },
    fileWatch: {
      stop: () => {
        calls.push('stop');
        opts.stop?.();
      },
    },
    ...(opts.flushStorage
      ? {
          flushStorage: async (timeoutMs?: number) => {
            calls.push(`flush:${timeoutMs ?? 'default'}`);
            return opts.flushStorage!(timeoutMs);
          },
        }
      : {}),
  } as unknown as Kernel;
  return { kernel, calls };
}

function makeDeps(
  kernel: Kernel,
  calls: string[],
  overrides: Partial<CloseProjectSessionDeps> = {},
): { deps: CloseProjectSessionDeps; reset: ReturnType<typeof vi.fn>; reportError: ReturnType<typeof vi.fn>; setRecent: ReturnType<typeof vi.fn> } {
  const reset = vi.fn(() => {
    calls.push('reset');
  });
  const reportError = vi.fn();
  const setRecent = vi.fn((recent: RecentProject[]) => {
    calls.push(`set-recent:${recent.length}`);
  });
  const clearWriteDomain = vi.fn(async () => {
    calls.push('clear');
  });
  const deps: CloseProjectSessionDeps = {
    kernel,
    clearWriteDomain,
    reportError,
    reset,
    setRecent,
    ...overrides,
  };
  return { deps, reset, reportError, setRecent };
}

describe('closeProjectSession：成功路径（默认行为不变）', () => {
  it('顺序 = close → stop → clear_write_domain → 状态复位 → recent 刷新', async () => {
    const { kernel, calls } = makeKernel({ recent: async () => [{ rootDir: 'D:/p', adapterId: 'a', lastOpenedAt: 1 }] });
    const { deps, reportError } = makeDeps(kernel, calls);

    await closeProjectSession(deps);

    expect(calls).toEqual(['close', 'stop', 'clear', 'reset', 'recent', 'set-recent:1']);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('浏览器壳（clearWriteDomain = null）不发明知会失败的 IPC：整步跳过', async () => {
    const { kernel, calls } = makeKernel();
    const { deps, reportError } = makeDeps(kernel, calls, { clearWriteDomain: null });

    await closeProjectSession(deps);

    expect(calls).toEqual(['close', 'stop', 'reset', 'recent', 'set-recent:0']);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('closeProjectSession：close 抛错仍清理（本批核心判据）', () => {
  it('kernel.project.close() 拒绝：stop / clear / 复位 / recent 全部照做，并显式报错', async () => {
    const { kernel, calls } = makeKernel({ close: async () => Promise.reject(new Error('内核拒绝关闭')) });
    const { deps, reset, reportError } = makeDeps(kernel, calls);

    await expect(closeProjectSession(deps)).resolves.toBeUndefined();

    expect(calls).toEqual(['close', 'stop', 'clear', 'reset', 'recent', 'set-recent:0']);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toContain('关闭项目失败：');
    expect(String(reportError.mock.calls[0]?.[0])).toContain('内核拒绝关闭');
  });

  it('close 与清写允许域同时失败：一条消息里两行都在（文案原样、pre-wrap 显示）', async () => {
    const { kernel, calls } = makeKernel({ close: async () => Promise.reject(new Error('关不掉')) });
    const { deps, reset, reportError } = makeDeps(kernel, calls, {
      clearWriteDomain: async () => {
        calls.push('clear');
        throw new Error('IPC 拒绝');
      },
    });

    await closeProjectSession(deps);

    expect(reset).toHaveBeenCalledTimes(1);
    const message = String(reportError.mock.calls[0]?.[0]);
    expect(message).toContain('关闭项目失败：关不掉');
    expect(message).toContain('关闭项目时可写范围没能清空：IPC 拒绝');
    expect(message.split('\n')).toHaveLength(2);
  });
});

describe('closeProjectSession：拆除序的每一步互不阻断', () => {
  it('fileWatch.stop 抛错：清写允许域与状态复位照做，错误显式上报', async () => {
    const { kernel, calls } = makeKernel({
      stop: () => {
        throw new Error('停止失败');
      },
    });
    const { deps, reset, reportError } = makeDeps(kernel, calls);

    await closeProjectSession(deps);

    expect(calls).toEqual(['close', 'stop', 'clear', 'reset', 'recent', 'set-recent:0']);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toContain('停止文件监视失败：停止失败');
  });

  it('clear_write_domain 失败：状态复位与 recent 照做，既有文案逐字保留', async () => {
    const { kernel, calls } = makeKernel();
    const { deps, reset, reportError } = makeDeps(kernel, calls, {
      clearWriteDomain: async () => {
        calls.push('clear');
        throw new Error('IPC 拒绝');
      },
    });

    await closeProjectSession(deps);

    expect(calls).toEqual(['close', 'stop', 'clear', 'reset', 'recent', 'set-recent:0']);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toBe('关闭项目时可写范围没能清空：IPC 拒绝');
  });

  it('recent() 抛错：状态复位已完成，只多一条显式错误（关关闭路径不 reject）', async () => {
    const { kernel, calls } = makeKernel({ recent: async () => Promise.reject(new Error('列表坏了')) });
    const { deps, reset, reportError } = makeDeps(kernel, calls);

    await expect(closeProjectSession(deps)).resolves.toBeUndefined();

    expect(calls).toEqual(['close', 'stop', 'clear', 'reset', 'recent']);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toContain('读取最近项目失败：列表坏了');
  });

  it('reset 自己抛错也不吞后续 recent：错误照报、setRecent 仍被调用', async () => {
    const { kernel, calls } = makeKernel();
    const { deps, reportError, setRecent } = makeDeps(kernel, calls, {
      reset: () => {
        calls.push('reset');
        throw new Error('复位坏了');
      },
    });

    await closeProjectSession(deps);

    expect(calls).toEqual(['close', 'stop', 'clear', 'reset', 'recent', 'set-recent:0']);
    expect(setRecent).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toContain('项目状态复位失败：复位坏了');
  });
});

describe('crashExitDecision：崩溃退出不许绕过未保存确认', () => {
  it('没有脏文件才允许直接关项目', () => {
    expect(crashExitDecision(0)).toBe('close');
  });

  it('有脏文件 ⇒ 必须走「明确丢弃」确认（EditorPane 已卸载，saveAll 是空操作）', () => {
    expect(crashExitDecision(1)).toBe('confirm-discard');
    expect(crashExitDecision(12)).toBe('confirm-discard');
  });
});

/**
 * E·R6：关项目时的落盘屏障（2026-10-31）。
 *
 * 插件的写是 fire-and-forget（索引快照 42.7M 码元 / 写窗口 0.7s 起）。关项目这一拍不等它，
 * 整轮索引就白算了——下一次开项目还得从头扫。判据三条：
 * ① 屏障排在拆除序**最前面**（先等写，再关项目）；
 * ② 没等到也不许把关闭卡住（照走拆除序），但必须**说出来**；
 * ③ 屏障自己抛错同样不阻断（关不掉的窗口比丢一次缓存严重）。
 */
describe('closeProjectSession：落盘屏障（E·R6）', () => {
  it('先等写、再关项目：顺序 = flush → close → …', async () => {
    const { kernel, calls } = makeKernel({
      flushStorage: async () => ({ pending: 1, drained: true, ms: 12 }),
    });
    const { deps, reportError } = makeDeps(kernel, calls);

    await closeProjectSession(deps);

    expect(calls[0]).toBe('flush:1200'); // 预算 1.2s（写窗口 0.7s 起，留一倍余量）
    expect(calls[1]).toBe('close');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('没等到（drained:false）⇒ 拆除序照走，但把"还有几笔没写完"说出来', async () => {
    const { kernel, calls } = makeKernel({
      flushStorage: async () => ({ pending: 2, drained: false, ms: 1200 }),
    });
    const { deps, reset, reportError } = makeDeps(kernel, calls);

    await closeProjectSession(deps);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    const message = String(reportError.mock.calls[0]?.[0]);
    expect(message).toContain('还有 2 笔缓存没写完');
    expect(message).toContain('下次打开会重新算一遍');
    expect(message).toContain('1200ms');
  });

  it('屏障自己抛错：不阻断关闭，另起一行说清楚（与既有错误可同框）', async () => {
    const { kernel, calls } = makeKernel({
      flushStorage: async () => Promise.reject(new Error('存储域炸了')),
    });
    const { deps, reset, reportError } = makeDeps(kernel, calls);

    await expect(closeProjectSession(deps)).resolves.toBeUndefined();

    expect(calls).toEqual(['flush:1200', 'close', 'stop', 'clear', 'reset', 'recent', 'set-recent:0']);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toContain('等待缓存落盘失败：存储域炸了');
  });
});
