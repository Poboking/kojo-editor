import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_YIELD_THROTTLE_MS,
  keyYieldNoticeMessage,
  reportKeyYield,
  resetKeyYieldThrottle,
  shouldEmitKeyYieldNotice,
  type GlobalKeyGate,
  type KeyYieldCommand,
} from '../src/ui/shell-keys';

/**
 * KEY-YIELD-VISIBLE（铁律 4：内核不静默的壳层同口径）。
 *
 * 缺陷形态：焦点在输入框 / 弹出的选择器里、或输入法占用期间，组合键**主动让路**
 * （让路本身是对的），但屏上一句不说——作者按 Ctrl+B 什么也没发生，也不知道为什么。
 * 本批口径：每一次"因让位不执行且这次按键真绑着命令"必须经通知中心留下一行可判定
 * 读数（为什么没执行 + 先按 Esc 再按一次），并按 reason 键节流。
 *
 * 测试环境是 node（无 jsdom，照仓库既有做法构造按键替身）；组件接线另由静态守门钉。
 */

const REGISTRY: readonly KeyYieldCommand[] = [
  { id: 'layout.toggleSidebar', keybinding: 'ctrl+b' },
  { id: 'workbench.closeActiveTab', keybinding: 'ctrl+w' },
  { id: 'layout.toggleZen', keybinding: 'ctrl+k z' }, // 和弦：不参与让位读数（与分发特例同路径）
];

/** KeyboardEvent 的最小替身：`chordFromEvent` 只读 key + 四个修饰键 */
function fakeKey(init: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
  } as unknown as KeyboardEvent;
}

function runReport(gate: GlobalKeyGate, event: KeyboardEvent, now: number) {
  const emit = vi.fn();
  const shown = reportKeyYield({ gate, event, commands: REGISTRY, now, emit });
  return { emit, shown };
}

beforeEach(() => {
  resetKeyYieldThrottle();
});

describe('判据①：让路 ⇒ 必产一行读数（断言文案原文，不只是"没抛错"）', () => {
  it('输入面（editableTarget）让开 Ctrl+B ⇒ 上屏一句"为什么没执行 + 该怎么做"', () => {
    const { emit, shown } = runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 1000);
    expect(shown).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'Ctrl+B 没执行——这个键先给了正在输入的地方。先按 Esc 退出输入，再按一次。',
    );
  });

  it('输入法合成期（composing）让开 Ctrl+B ⇒ 同一句式、另一条出路文案', () => {
    const { emit, shown } = runReport('composing', fakeKey({ key: 'b', ctrlKey: true }), 1000);
    expect(shown).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'Ctrl+B 没执行——这个键先给了输入法。先按 Esc 收起候选，再按一次。',
    );
  });

  it('文案守卫：作者面零黑话，补救动作（Esc 后再按）必须在句里', () => {
    for (const gate of ['composing', 'editableTarget'] as const) {
      const msg = keyYieldNoticeMessage('Ctrl+B', gate);
      expect(msg).not.toMatch(/焦点|捕获|冒泡|binding|事件/i);
      expect(msg).toContain('先按 Esc');
      expect(msg).toContain('再按一次');
    }
  });
});

describe('判据②：正常执行 / 无主按键 ⇒ 不产读数（提示不许变成每次按键都响）', () => {
  it('门全过（gate=null，普通焦点按 Ctrl+B）⇒ 不响', () => {
    const { emit, shown } = runReport(null, fakeKey({ key: 'b', ctrlKey: true }), 1000);
    expect(shown).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('defaultPrevented（键已被内层消费，多半真的执行了动作）⇒ 不谎报"没执行"', () => {
    const { emit, shown } = runReport('defaultPrevented', fakeKey({ key: 'b', ctrlKey: true }), 1000);
    expect(shown).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('这次按键没绑任何命令（打字用的普通字母键）⇒ 不响', () => {
    const { emit } = runReport('editableTarget', fakeKey({ key: 'b' }), 1000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('裸修饰键（单独按 Ctrl）与和弦键位 ⇒ 不响', () => {
    expect(runReport('editableTarget', fakeKey({ key: 'Control', ctrlKey: true }), 1000).emit)
      .not.toHaveBeenCalled();
    resetKeyYieldThrottle();
    expect(runReport('editableTarget', fakeKey({ key: 'z', ctrlKey: true }), 1000).emit)
      .not.toHaveBeenCalled(); // ctrl+k z 是和弦，注册表单键路径不匹配
  });
});

describe('判据③：节流（滑动窗口，KEY_YIELD_THROTTLE_MS=1500ms，同一"早退层:命令"一个窗）', () => {
  it('同一 reason 连按：首响 ⇒ 窗内再按不叠条、只更时间戳 ⇒ 停手满窗后才再响', () => {
    const a = runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 0);
    expect(a.shown).toBe(true);
    const b = runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 1000); // 窗内
    expect(b.shown).toBe(false);
    // 滑动口径：1000 那次把时间戳推进到 1000 ⇒ 2000 距上次仅 1000ms，仍在窗内
    const c = runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 2000);
    expect(c.shown).toBe(false);
    // 距上一次让位（2000）满 1500ms ⇒ 停手后再按才会再响
    const d = runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 3500);
    expect(d.shown).toBe(true);
    expect(d.emit).toHaveBeenCalledTimes(1);
  });

  it('不同键（不同 reason）互不吞：Ctrl+B 在窗内不挡 Ctrl+W 的首条读数', () => {
    expect(runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 0).shown).toBe(true);
    expect(runReport('editableTarget', fakeKey({ key: 'w', ctrlKey: true }), 100).shown).toBe(true);
  });

  it('同一命令不同层（composing / editableTarget）各自计窗', () => {
    expect(runReport('composing', fakeKey({ key: 'b', ctrlKey: true }), 0).shown).toBe(true);
    expect(runReport('editableTarget', fakeKey({ key: 'b', ctrlKey: true }), 100).shown).toBe(true);
  });

  it('shouldEmitKeyYieldNotice 直接可判定：被吞的按压同样推进时间戳（滑动），恰好满窗算出窗', () => {
    expect(shouldEmitKeyYieldNotice('x', 0)).toBe(true);
    expect(shouldEmitKeyYieldNotice('x', KEY_YIELD_THROTTLE_MS - 1)).toBe(false); // 窗内，last→1499
    expect(shouldEmitKeyYieldNotice('x', 2 * KEY_YIELD_THROTTLE_MS - 2)).toBe(false); // 距 1499 仅 1499ms
    expect(shouldEmitKeyYieldNotice('x', 3 * KEY_YIELD_THROTTLE_MS - 2)).toBe(true); // 距 2998 整 1500ms
  });
});

describe('反向自证 + 接线静态守门（node 渲染不出 ShellLayout，照 shell-keys-guard 读源码钉）', () => {
  const src = readFileSync(new URL('../src/ui/ShellLayout.tsx', import.meta.url), 'utf8');

  it('撤掉读数发射必红：早退分支调用 reportKeyYield，emit 走通知中心 useNotify', () => {
    const gateAt = src.indexOf('const gate = resolveGlobalKeyGate(keyEvidence)');
    const yieldAt = src.indexOf('reportKeyYield({');
    expect(gateAt).toBeGreaterThan(-1);
    expect(yieldAt).toBeGreaterThan(gateAt); // 就挂在早退分支里，不是别处的孤调用
    expect(src).toContain("emit: (message) => notifyRef.current({ kind: 'info', message })");
    expect(src).toContain("import { useNotify } from './NotificationCenter'");
    expect(src).toContain('const notify = useNotify();');
  });

  it('让位读数不吞键：reportKeyYield 之后仍是原样 return，不 preventDefault、不 run', () => {
    const yieldAt = src.indexOf('reportKeyYield({');
    const emitAt = src.indexOf('notifyRef.current(', yieldAt);
    const returnAt = src.indexOf('return;', emitAt);
    const segment = src.slice(yieldAt, returnAt);
    expect(segment).not.toContain('preventDefault');
    expect(segment).not.toContain('cmd.run');
    expect(returnAt).toBeGreaterThan(-1);
  });

  it('旧守门不破：门判定仍单源、仍早于任何按键消费', () => {
    expect(src).toContain('resolveGlobalKeyGate(keyEvidence)');
    expect(src.indexOf('const gate = resolveGlobalKeyGate(keyEvidence)')).toBeLessThan(
      src.indexOf('const k = e.key.toLowerCase()'),
    );
  });
});
