/**
 * 「同版本免打扰」偏好单测（批次十一 L05）。存法与回落口径照 `code-lens-pref.test.ts`：
 * ①默认没存过（null）；②读不到 / 抛错 / 脏 JSON 一律当没存过，绝不抛；
 * ③免打扰只对**同版本 + 时效内**生效——这三条钉死实测缺陷③（「稍后」跨会话失效）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UPDATE_DISMISS_KEY,
  UPDATE_NOTICE_QUIET_DAYS,
  UPDATE_NOTICE_QUIET_MS,
  dismissUpdateVersion,
  isUpdateDismissalActive,
  isUpdateNoticeQuiet,
  loadUpdateDismissal,
  parseUpdateDismissal,
  subscribeUpdateDismissal,
  clearUpdateDismissal,
} from '../src/ui/update-dismiss-pref';

const HOUR = 60 * 60 * 1000;

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

function stubWindow(storage: Storage | undefined): void {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseUpdateDismissal · 只认干净记录', () => {
  it('合法 JSON ⇒ 读出 {version, dismissedAt}', () => {
    expect(parseUpdateDismissal('{"version":"0.5.0","dismissedAt":1000}')).toEqual({
      version: '0.5.0',
      dismissedAt: 1000,
    });
  });

  it('脏值全算「没存过」：null / 空串 / 半截 JSON / 类型不对 / version 空', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{"version":0.5}',
      '{"version":"","dismissedAt":1}',
      '{"version":"0.5.0","dismissedAt":"soon"}',
      '{"version":"0.5.0","dismissedAt":null}',
      '[1,2]',
      '"a string"',
    ] as const) {
      expect(parseUpdateDismissal(raw)).toBeNull();
    }
  });
});

describe('isUpdateDismissalActive · 同版本 N 天内不再打扰（纯判龄）', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  /** 「稍后」是一小时前点的：窗口从 `dismissedAt` 起算，不从查询时刻起算 */
  const record = { version: '0.5.0', dismissedAt: now - HOUR };
  /**
   * 到期时刻 = 点稍后 + 7 天。边界照它取（差 1 毫秒就翻面）。
   * 旧写法把边界挂在 `now` 上，而记录挂在 `now - HOUR`：三条断言合起来等价于要求
   * 窗口 `608399999 < W ≤ 608400000`（= 7 天 + 1 小时），与同文件那条「窗口就是 7 天」
   * 的常量钉死直接互斥——钉错的是时钟基准，不是判据。
   */
  const deadline = record.dismissedAt + UPDATE_NOTICE_QUIET_MS;

  it('同版本且在窗口内 ⇒ 免打扰；跨出窗口 ⇒ 恢复提醒', () => {
    expect(isUpdateDismissalActive(record, '0.5.0', now)).toBe(true);
    expect(isUpdateDismissalActive(record, '0.5.0', deadline - 1)).toBe(true);
    expect(isUpdateDismissalActive(record, '0.5.0', deadline)).toBe(false);
  });

  it('免打扰天数是 7 天（常量口径钉住，别被顺手改成"永久"）', () => {
    expect(UPDATE_NOTICE_QUIET_DAYS).toBe(7);
    expect(UPDATE_NOTICE_QUIET_MS).toBe(7 * 24 * HOUR);
  });

  it('别的版本不受影响；没记录不打扰判断；null 记录 ⇒ false', () => {
    expect(isUpdateDismissalActive(record, '0.6.0', now)).toBe(false);
    expect(isUpdateDismissalActive(null, '0.5.0', now)).toBe(false);
  });

  it('dismissedAt 在未来（改表/时区）仍算免打扰；now 非有限 ⇒ false（绝不演成永久静默）', () => {
    expect(isUpdateDismissalActive({ version: '0.5.0', dismissedAt: now + HOUR }, '0.5.0', now)).toBe(true);
    expect(isUpdateDismissalActive(record, '0.5.0', Number.NaN)).toBe(false);
  });
});

describe('读写盘 · localStorage 真源', () => {
  it('没 window / 没 localStorage ⇒ 读到 null、写入静默不抛', () => {
    stubWindow(undefined);
    expect(loadUpdateDismissal()).toBeNull();
    expect(() => dismissUpdateVersion('0.5.0')).not.toThrow();
    expect(isUpdateNoticeQuiet('0.5.0')).toBe(false);
  });

  it('点稍后 = 落盘一条记录；再点别的版本 = 整条覆盖（只记最近一版）', () => {
    const s = fakeStorage();
    stubWindow(s);
    dismissUpdateVersion('0.5.0', 1000);
    expect(JSON.parse(s.getItem(UPDATE_DISMISS_KEY) as string)).toEqual({ version: '0.5.0', dismissedAt: 1000 });
    // 判龄与落盘必须同一把钟：这里给注入时刻 1000 的一小时后。原先不传 `now` 用本机墙钟，
    // 而 `dismissedAt: 1000`（1970 年）对墙钟已经过了 7 天窗口的 ~2964 倍 ⇒ 任何按窗口判龄的
    // 判据都只能给 false。钉错的是这把钟，不是「点完稍后要立刻安静」那条语义。
    expect(isUpdateNoticeQuiet('0.5.0', 1000 + HOUR)).toBe(true);
    // 同一份记录跨出 7 天 ⇒ 恢复提醒：存储版判据也吃窗口，不是「存过就永远安静」
    expect(isUpdateNoticeQuiet('0.5.0', 1000 + UPDATE_NOTICE_QUIET_MS)).toBe(false);
    dismissUpdateVersion('0.6.0', 2000);
    expect(loadUpdateDismissal()).toEqual({ version: '0.6.0', dismissedAt: 2000 });
    // 2000 这一刻 0.5.0 那条记录本来还在窗口内 ⇒ 它的 false 只能来自「整条覆盖」，不是过期
    expect(isUpdateNoticeQuiet('0.5.0', 2000)).toBe(false);
    expect(isUpdateNoticeQuiet('0.6.0', 2000)).toBe(true);
  });

  it('clearUpdateDismissal 删键（不留 {version:""} 第三种形态）', () => {
    const s = fakeStorage({ [UPDATE_DISMISS_KEY]: '{"version":"0.5.0","dismissedAt":1}' });
    stubWindow(s);
    clearUpdateDismissal();
    expect(s.getItem(UPDATE_DISMISS_KEY)).toBeNull();
    expect(loadUpdateDismissal()).toBeNull();
  });

  it('getItem / setItem 抛错（隐私模式 / 配额满）⇒ 全部静默回落，不冒到 UI', () => {
    const s = fakeStorage({ [UPDATE_DISMISS_KEY]: '{"version":"0.5.0","dismissedAt":1}' });
    s.getItem = () => {
      throw new Error('SecurityError');
    };
    stubWindow(s);
    expect(loadUpdateDismissal()).toBeNull();
    const s2 = fakeStorage();
    s2.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    stubWindow(s2);
    expect(() => dismissUpdateVersion('0.5.0')).not.toThrow();
  });

  it('空版本号拒绝落盘（免打扰记录不该有 ""这一版）', () => {
    const s = fakeStorage();
    stubWindow(s);
    dismissUpdateVersion('  ');
    expect(s.getItem(UPDATE_DISMISS_KEY)).toBeNull();
  });
});

describe('订阅表 · 写完就通知', () => {
  it('dismiss / clear 都通知订阅者；取消后不再收到', () => {
    stubWindow(fakeStorage());
    const seen: number[] = [];
    const listener = (): void => void seen.push(seen.length + 1);
    const unsubscribe = subscribeUpdateDismissal(listener);
    dismissUpdateVersion('0.5.0', 1);
    clearUpdateDismissal();
    expect(seen).toHaveLength(2);
    unsubscribe();
    dismissUpdateVersion('0.6.0', 2);
    expect(seen).toHaveLength(2);
  });
});
