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

  it('白名单 = 插件可 emit 的 21 个内核事件（快照守门）', () => {
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
        'editor.liftPreview.show',
        'editor.liftPreview.hide',
        'editor.sugarView.set',
        'ui.overlay.open',
        'ui.overlay.close',
        // 2026-10-15 比对/历史批：通用 diff 视图意图（工作区版 vs 游戏目录版 / 历史版 vs 当前）
        'ui.diffView.open',
        // 2026-10-14 UI 浮动批：请求宿主把某面板弹出为可移动浮窗
        'ui.panel.float',
        // 2026-10-16 市场外链批：外链打开意图（闸的唯一执法点在 Rust，载荷只冻结 { url }）
        'ui.openExternal',
        // 2026-10-12 工作区批：导入意图（宿主文件树右键 → 工作区消费方）
        'workspace.importRequested',
        // 2026-10-13 反馈 3 批：请开新建项目向导（意图）+ 项目已创建（兑现）
        'workspace.newProjectRequested',
        'workspace.projectCreated',
      ].sort(),
    );
  });

  it('内核专属事件不在白名单（插件可 on 不可 emit——P0 批安全语义定案）', () => {
    // 白名单已强类型化（ReadonlySet<KernelEventName>），编译层本身就拒绝该键
    // （防线一）；此处展开为数组做运行时镜像断言（防线二），免于强行 cast。
    expect([...KERNEL_EVENT_NAMES]).not.toContain('project.writableApprovalMismatch');
    // BUG-5：监视状态同属"安全保证"类事件——插件不得伪造"外部改动会自动重载"
    expect([...KERNEL_EVENT_NAMES]).not.toContain('file.watchState');
    // C2：文档真相的真源在编辑器缓冲——插件伪造 = 谎报文件内容（消费方拿它当权威转译/校验）
    expect([...KERNEL_EVENT_NAMES]).not.toContain('editor.documentChanged');
  });

  it('白名单无重复（Set 语义自证：长度 = 快照清单长度）', () => {
    // 2026-10-12 两线合流：工作区批 +workspace.importRequested（15）
    // ∪ 语法糖视图批 +editor.sugarView.set（16）——快照清单与计数必须同批动。
    // 2026-10-13 BUG-5 新增 file.watchState 走 **KERNEL_ONLY** 表 ⇒ 可 emit 白名单不动；
    // 2026-10-13 反馈 3 批新增 workspace.newProjectRequested + workspace.projectCreated
    // 两个语义事件（意图 / 兑现各一）⇒ 16 → 18。
    // 2026-10-14 UI 浮动批新增 ui.panel.float（面板浮动意图）⇒ 18 → 19。
    // 2026-10-15 比对/历史批新增 ui.diffView.open（通用 diff 视图意图）⇒ 19 → 20。
    // 2026-10-16 市场外链批新增 ui.openExternal（外链打开意图）⇒ 20 → 21。
    // 计数以本行结论为准（漏项的话编译期 guard 会红）。
    expect(KERNEL_EVENT_NAMES.size).toBe(21);
  });
});
