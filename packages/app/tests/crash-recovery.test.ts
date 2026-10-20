/**
 * 崩溃恢复件的清理失败必须可见（SHELL-ERRPATHS，2026-10-20）。
 *
 * 原先欢迎页「丢弃」把 `discard()` 的失败吞成 `catch(() => undefined)`：作者点了丢弃，
 * 下次启动却又看到恢复横幅。这里钉住三条：无引擎不制造噪声、成功静默、失败给中文
 * 第一眼提示并把机器原文留在 detail。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discardRecoveryJournal } from '../src/ui/crash-recovery';

const APP = readFileSync(fileURLToPath(new URL('../src/ui/App.tsx', import.meta.url)), 'utf8');

describe('崩溃恢复件丢弃：失败不静默', () => {
  it('没有引擎（浏览器壳 / 装配失败）⇒ 无事可做也不出声', async () => {
    await expect(discardRecoveryJournal(null)).resolves.toBeNull();
  });

  it('成功 ⇒ null（不打扰作者）', async () => {
    let calls = 0;
    const notice = await discardRecoveryJournal({
      discard: async () => {
        calls += 1;
      },
    });
    expect(notice).toBeNull();
    expect(calls).toBe(1);
  });

  it('失败 ⇒ 中文错误通知；机器原文只在 detail，不当第一眼', async () => {
    const notice = await discardRecoveryJournal({
      discard: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(notice?.kind).toBe('error');
    expect(notice?.message).toContain('恢复件清理失败');
    expect(notice?.message).not.toContain('EACCES');
    expect(notice?.detail).toContain('EACCES');
  });

  it('宿主两处丢弃都走可见出口；启动时的崩溃探测失败也上屏', () => {
    expect(APP.match(/discardRecoveryJournal\(autosaveRef\.current\)/g) ?? []).toHaveLength(2);
    expect(APP).toContain('崩溃恢复检查失败');
    // 旧的静默吞法不许复活
    expect(APP).not.toContain('autosaveRef.current?.discard().catch(() => undefined)');
  });
});
