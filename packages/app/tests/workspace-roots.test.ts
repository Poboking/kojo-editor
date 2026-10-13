import { describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import { isUnderAnyRoot, workspaceRootsOf } from '../src/ui/workspace-roots';

/**
 * 工作区**全部**根的读取与判定（2026-10-14 新建项目自选位置批）。
 *
 * 这里是 ERB 只读分野（`EditorPane.inWorkspace`）与监视根（`App` 的 `fileWatch.start`）
 * 的共同底座，判错的两个方向都不轻：
 * - 认漏一个根 ⇒ 自选根里的 `.ERB` 被当"游戏目录借阅件"锁成只读、且不被监视（外部改动
 *   会在 Ctrl+S 时被静默覆盖）；
 * - 认宽 ⇒ 邻居目录（同前缀的 `-备份`）里的文件被当成创作权威区，绕过借阅只读规则。
 *
 * 零游戏知识：只看路径形状。
 */

const DEFAULT_ROOT = 'C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces';
const EXTRA_ROOT = 'D:/作品';

/** 只填 workspaces.roots() 的最小 kernel 替身（本模块只用到那一个方法） */
function kernelWithRoots(roots: () => string[]): Pick<Kernel, 'workspaces'> {
  return { workspaces: { roots } as unknown as Kernel['workspaces'] };
}

describe('workspaceRootsOf', () => {
  it('服务可用 → 原样返回全部根（顺序由服务给定：默认根恒在首位）', () => {
    const kernel = kernelWithRoots(() => [DEFAULT_ROOT, EXTRA_ROOT]);
    expect(workspaceRootsOf(kernel)).toEqual([DEFAULT_ROOT, EXTRA_ROOT]);
  });

  it('服务不可用（浏览器开发壳，roots() 抛）→ 吞成空数组，绝不抛穿渲染路径', () => {
    const kernel = kernelWithRoots(() => {
      throw new Error('Workspace service is unavailable (no platform data directory)');
    });
    expect(workspaceRootsOf(kernel)).toEqual([]);
  });

  it('每次调用现取，不缓存（本会话刚自选的新根必须立刻被承认）', () => {
    const roots = vi
      .fn<() => string[]>()
      .mockReturnValueOnce([DEFAULT_ROOT])
      .mockReturnValue([DEFAULT_ROOT, EXTRA_ROOT]);
    const kernel = kernelWithRoots(roots);
    expect(workspaceRootsOf(kernel)).toEqual([DEFAULT_ROOT]);
    expect(isUnderAnyRoot(workspaceRootsOf(kernel), `${EXTRA_ROOT}/p1/a.ERB`)).toBe(true);
    expect(roots).toHaveBeenCalledTimes(2);
  });
});

describe('isUnderAnyRoot', () => {
  it('任一根命中即算工作区内', () => {
    expect(isUnderAnyRoot([DEFAULT_ROOT, EXTRA_ROOT], `${DEFAULT_ROOT}/p1/a.ERB`)).toBe(true);
    expect(isUnderAnyRoot([DEFAULT_ROOT, EXTRA_ROOT], `${EXTRA_ROOT}/p1/子目录/a.ERB`)).toBe(true);
    // 根本身也算命中（isPathUnder 含相等）
    expect(isUnderAnyRoot([DEFAULT_ROOT, EXTRA_ROOT], EXTRA_ROOT)).toBe(true);
  });

  it('都不命中 → false（游戏目录那半边是借阅区）', () => {
    expect(isUnderAnyRoot([DEFAULT_ROOT, EXTRA_ROOT], 'C:/Game/eratw/ERB/口上・メッセージ関連/a.ERB')).toBe(false);
  });

  it('同前缀的邻居目录不误判（`<根>-备份` 不是 `<根>` 的子目录）', () => {
    expect(isUnderAnyRoot([DEFAULT_ROOT, EXTRA_ROOT], `${EXTRA_ROOT}-备份/p1/a.ERB`)).toBe(false);
    expect(isUnderAnyRoot([EXTRA_ROOT], 'D:/作品集/p1/a.ERB')).toBe(false);
  });

  it('空根列表 ⇒ false（服务不可用 = 没有工作区，不是"任何地方都是工作区"）', () => {
    expect(isUnderAnyRoot([], `${DEFAULT_ROOT}/p1/a.ERB`)).toBe(false);
  });

  it('Windows 语义：大小写不敏感、`/` 与 `\\` 混写仍认得同一个根', () => {
    const winRoot = 'C:\\Users\\dev\\AppData\\Roaming\\dev.kojo.editor\\workspaces';
    expect(isUnderAnyRoot([winRoot], `${DEFAULT_ROOT}/p1/a.ERB`)).toBe(true);
    expect(isUnderAnyRoot([DEFAULT_ROOT], 'c:\\users\\dev\\appdata\\roaming\\dev.kojo.editor\\workspaces\\p1\\a.ERB')).toBe(
      true,
    );
    // 折叠大小写不等于放宽边界：邻居目录仍然不算
    expect(isUnderAnyRoot([winRoot], `${DEFAULT_ROOT}-备份/p1/a.ERB`)).toBe(false);
  });

  it('POSIX 根不折叠大小写（判定风格以根为准，别把 Linux 路径当 Windows 比）', () => {
    expect(isUnderAnyRoot(['/home/dev/workspaces'], '/home/dev/WorkSpaces/p1/a.ERB')).toBe(false);
    expect(isUnderAnyRoot(['/home/dev/workspaces'], '/home/dev/workspaces/p1/a.ERB')).toBe(true);
  });
});
