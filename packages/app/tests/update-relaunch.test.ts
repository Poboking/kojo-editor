/**
 * 「立即重启」通道的闸（UPD-B）。
 *
 * 上一批把 done 态弹窗的 `onRestart` prop 留成可选、注释里登记了「宿主尚无重启命令」
 * 的待办—— prop 有没有消费方挂上、命令有没有真注册，都是「测试全绿但用户按不到」的
 * 静默失效高发面。本文件两段各钉一头：
 * 1. **包装层单测**（`appRelaunch`）：环境闸（非 Tauri 不发起 invoke）、命令名逐字
 *    （'updater_relaunch' 与 Rust 侧同源）、静默（invoke reject 绝不上抛）；
 * 2. **静态接线闸**：ShellLayout 真把 `onRestart={appRelaunch}` 挂上了、lib.rs 真把
 *    命令注册进 invoke_handler 了、Rust 命令文件真在——口径照 `update-wiring.test.ts`，
 *    静态读源码，不起壳。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, isTauriMock } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  const isTauriMock = vi.fn((): boolean => true);
  return { invokeMock, isTauriMock };
});

vi.mock('../src/bridge/invoke', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => isTauriMock(),
}));

// 包装层若真走到 IPC，最终会动态 import 这一个模块——mock 掉兜住，别让真 IPC 冒出来
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { appRelaunch } from '../src/ui/update-relaunch';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  isTauriMock.mockReset();
  isTauriMock.mockReturnValue(true);
});

describe('appRelaunch 包装层：环境闸 + 命令名 + 静默', () => {
  it('非 Tauri（浏览器调试壳）直接 return，连 invoke 都不发起', () => {
    isTauriMock.mockReturnValue(false);
    expect(appRelaunch()).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(isTauriMock).toHaveBeenCalledTimes(1);
  });

  it('Tauri 环境下调「updater_relaunch」，命令名与 Rust 侧逐字同源', () => {
    appRelaunch();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]![0]).toBe('updater_relaunch');
    // 无参数：重启不带任何载荷
    expect(invokeMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('invoke reject 静默吞掉：同步返回 void、不上抛、无 unhandled rejection', async () => {
    invokeMock.mockReturnValue(Promise.reject(new Error('Command updater_relaunch not found')));
    expect(() => appRelaunch()).not.toThrow();
    expect(appRelaunch()).toBeUndefined();
    // 吞错靠 .catch 接住：等一拍，若 rejection 没被接住这里会以 unhandled rejection 冒出
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe('静态接线闸：prop 真挂上、命令真注册（口径照 update-wiring.test.ts）', () => {
  it('ShellLayout 把 onRestart={appRelaunch} 挂进 UpdateDialog（不挂按钮就不画）', () => {
    const shellLayout = read('ui/ShellLayout.tsx');
    expect(shellLayout).toContain("import { appRelaunch } from './update-relaunch';");
    expect(shellLayout).toContain('onRestart={appRelaunch}');
    // 挂载点必须是 UpdateDialog 渲染处：onRestart 紧跟 UpdateDialog 的属性串里
    const dialogAt = shellLayout.indexOf('<UpdateDialog');
    expect(dialogAt).toBeGreaterThan(-1);
    const restartAt = shellLayout.indexOf('onRestart={appRelaunch}');
    expect(restartAt).toBeGreaterThan(dialogAt);
    expect(shellLayout.slice(dialogAt, restartAt)).not.toContain('/>');
  });

  it('lib.rs 注册了 updater_relaunch（mod 声明 + invoke_handler 各一处）', () => {
    const libRs = readFileSync(
      fileURLToPath(new URL('../src-tauri/src/lib.rs', import.meta.url)),
      'utf8',
    );
    expect(libRs).toContain('mod updater_relaunch;');
    expect(libRs).toContain('updater_relaunch::updater_relaunch,');
    // 注册落在 updater_proxy 旁边（读上下文对齐的那一处）
    const proxyAt = libRs.indexOf('updater_proxy::updater_env_proxy,');
    const relaunchAt = libRs.indexOf('updater_relaunch::updater_relaunch,');
    expect(proxyAt).toBeGreaterThan(-1);
    expect(relaunchAt).toBeGreaterThan(proxyAt);
  });

  it('Rust 命令文件在位且带 #[tauri::command] 与 app.restart()', () => {
    const path = fileURLToPath(
      new URL('../src-tauri/src/updater_relaunch.rs', import.meta.url),
    );
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('#[tauri::command]');
    expect(source).toContain('pub fn updater_relaunch(app: tauri::AppHandle)');
    expect(source).toContain('app.restart()');
  });
});
