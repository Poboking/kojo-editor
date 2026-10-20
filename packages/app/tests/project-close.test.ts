import { describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
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
    expect(message).toContain('写允许域清除失败: IPC 拒绝');
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
    expect(String(reportError.mock.calls[0]?.[0])).toBe('写允许域清除失败: IPC 拒绝');
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
