import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatVersionSize,
  formatVersionTime,
  getFileHistoryTarget,
  setFileHistoryTarget,
  subscribeFileHistory,
  FILE_HISTORY_OVERLAY_ID,
  SHOW_FILE_HISTORY_COMMAND_ID,
} from '../src/ui/file-history';

/**
 * 本地时间线（F2）宿主纯逻辑。
 * 版本数据源与恢复写链路在 kernel/tests/io-backups.test.ts 钉死；
 * 这里钉展示口径（时间优先取文件名时刻）与状态单源（命令 → overlay 的接力棒）。
 */

describe('formatVersionTime', () => {
  it('文件名时刻优先（mtime 会被复制/同步改写，文件名不会说谎）', () => {
    const text = formatVersionTime({ takenAtMs: new Date(2026, 9, 15, 9, 30, 1).getTime(), mtimeMs: 0 });
    expect(text).toBe('2026-10-15 09:30:01');
  });

  it('takenAtMs 为 null 回落 mtime（如实降级，不猜）', () => {
    const ms = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(formatVersionTime({ takenAtMs: null, mtimeMs: ms })).toBe('2026-01-02 03:04:05');
  });
});

describe('formatVersionSize', () => {
  it('三档单位各钉一条边界', () => {
    expect(formatVersionSize(512)).toBe('512 B');
    expect(formatVersionSize(1024)).toBe('1.0 KB');
    expect(formatVersionSize(1536)).toBe('1.5 KB');
    expect(formatVersionSize(2.35 * 1024 * 1024)).toBe('2.35 MB');
  });
});

describe('历史目标状态单源', () => {
  afterEach(() => setFileHistoryTarget(null));

  it('命令写入活动文件 → 订阅者感知；关窗清空（下次开窗读不到旧文件）', () => {
    const cb = vi.fn();
    const un = subscribeFileHistory(cb);
    setFileHistoryTarget('C:/ws/包/事件.kojo');
    expect(getFileHistoryTarget()).toBe('C:/ws/包/事件.kojo');
    expect(cb).toHaveBeenCalledTimes(1);
    setFileHistoryTarget(null);
    expect(getFileHistoryTarget()).toBeNull();
    un();
    setFileHistoryTarget('C:/x');
    expect(cb).toHaveBeenCalledTimes(2);
    setFileHistoryTarget(null);
  });

  it('overlay/命令 id 是宿主接线的两处字面量之单一真源', () => {
    expect(FILE_HISTORY_OVERLAY_ID).toBe('kojo.fileHistory');
    expect(SHOW_FILE_HISTORY_COMMAND_ID).toBe('kojo.showFileHistory');
  });
});
