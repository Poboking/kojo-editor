import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 「在系统资源管理器中显示」的 invoke 封装判据（B3）。
 *
 * 钉三件事：命令名与参数名**逐字**对上 Rust 命令（`show_in_folder(path)`）、
 * Rust 中文错误整理成一句可读的话、浏览器壳错误原样透传（调用方据此隐藏菜单项）。
 */

const invokeMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
const isTauriMock = vi.hoisted(() => vi.fn<() => boolean>());

vi.mock('../src/bridge/invoke', () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

import { revealFailureText, revealInExplorer } from '../src/ui/reveal-explorer';

afterEach(() => {
  invokeMock.mockReset();
  isTauriMock.mockReset();
  isTauriMock.mockReturnValue(true);
});

describe('revealInExplorer', () => {
  it('命令名与参数名逐字正确：invoke("show_in_folder", { path })', async () => {
    invokeMock.mockResolvedValue(undefined);
    await revealInExplorer('C:/proj/scenario/a.ERB');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('show_in_folder', {
      path: 'C:/proj/scenario/a.ERB',
    });
  });

  it('成功 → resolve 为 void（不造返回值）', async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(revealInExplorer('D:/eratw/ERB')).resolves.toBeUndefined();
  });

  it('Rust 中文错误 → 整理成一句可读的话，原始原因不丢', async () => {
    invokeMock.mockRejectedValue('路径不存在，无法在资源管理器中显示：C:/gone/a.ERB');
    await expect(revealInExplorer('C:/gone/a.ERB')).rejects.toThrow(
      '在系统资源管理器中显示失败：路径不存在，无法在资源管理器中显示：C:/gone/a.ERB',
    );
  });

  it('Rust Error 形态的拒绝 → 同样接上可读前缀', async () => {
    invokeMock.mockRejectedValue(new Error('无法打开系统资源管理器（explorer）：spawn 失败'));
    await expect(revealInExplorer('C:/x/a.ERB')).rejects.toThrow(
      '在系统资源管理器中显示失败：无法打开系统资源管理器（explorer）：spawn 失败',
    );
  });

  it('浏览器壳（isTauri=false）→ invoke 错误原样透传，不加包装', async () => {
    isTauriMock.mockReturnValue(false);
    const native = new Error('Tauri IPC 不可用（当前为浏览器环境，命令：show_in_folder）。请通过桌面壳运行。');
    invokeMock.mockRejectedValue(native);
    await expect(revealInExplorer('C:/x/a.ERB')).rejects.toBe(native);
  });
});

describe('revealFailureText', () => {
  it('字符串 / Error / 未知形态都能落成一句话', () => {
    expect(revealFailureText('路径不存在：X')).toBe('在系统资源管理器中显示失败：路径不存在：X');
    expect(revealFailureText(new Error('boom'))).toBe('在系统资源管理器中显示失败：boom');
    expect(revealFailureText(42)).toBe('在系统资源管理器中显示失败：42');
  });
});
