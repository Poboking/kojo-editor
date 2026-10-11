import { describe, expect, it } from 'vitest';
import { KERNEL_EVENT_CLASSIFICATION_GUARD, KERNEL_EVENT_NAMES } from '../src/index';

/**
 * 内核事件 emit 权限单一真源的运行时守门（2026-10-11 解耦修复批，M1）。
 *
 * 编译期防线在 src/events.ts（KERNEL_EVENT_CLASSIFICATION_GUARD 类型断言）；
 * 本文件是其运行时镜像：防止绕过类型层的拼错/漏项（如直接改字面量数组却
 * 拼错事件名——satisfies 只保证「键存在」，不保证集合内容符合预期口径）。
 */
describe('KERNEL_EVENT_NAMES（插件可 emit 的内核事件白名单）', () => {
  it('分类完整性守卫为 true（编译期断言的运行时镜像）', () => {
    expect(KERNEL_EVENT_CLASSIFICATION_GUARD).toBe(true);
  });

  it('白名单 = 插件可 emit 的 12 个内核事件（快照守门）', () => {
    expect([...KERNEL_EVENT_NAMES].sort()).toEqual(
      [
        'file.changed',
        'project.opened',
        'project.closed',
        'kojo.functionChanged',
        'plugin.statusChanged',
        'state.snapshotLoaded',
        'editor.revealLocation',
        'kojo.replayFunction',
        'kojo.snapshotSelected',
        'editor.activeFileChanged',
        'ui.overlay.open',
        'ui.overlay.close',
      ].sort(),
    );
  });

  it('内核专属事件不在白名单（插件可 on 不可 emit——P0 批安全语义定案）', () => {
    // 白名单已强类型化（ReadonlySet<KernelEventName>），编译层本身就拒绝该键
    // （防线一）；此处展开为数组做运行时镜像断言（防线二），免于强行 cast。
    expect([...KERNEL_EVENT_NAMES]).not.toContain('project.writableApprovalMismatch');
  });

  it('白名单无重复（Set 语义自证：长度 = 快照清单长度）', () => {
    expect(KERNEL_EVENT_NAMES.size).toBe(12);
  });
});
