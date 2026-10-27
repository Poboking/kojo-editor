import { describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import {
  isUnderAnyRoot,
  planAddExtraRoot,
  planRemoveExtraRoot,
  workspaceProjectDirsOf,
  workspaceRootsOf,
} from '../src/ui/workspace-roots';

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

describe('workspaceProjectDirsOf（2026-10-27 收窄批：可写判定只认作品目录）', () => {
  it('原样转发 projectDirs()：默认根 + 作品目录（自选根根身不在其中）', () => {
    const kernel = {
      workspaces: {
        roots: () => [DEFAULT_ROOT, EXTRA_ROOT],
        projectDirs: () => [DEFAULT_ROOT, `${EXTRA_ROOT}/p1`],
      } as unknown as Kernel['workspaces'],
    };
    expect(workspaceProjectDirsOf(kernel)).toEqual([DEFAULT_ROOT, `${EXTRA_ROOT}/p1`]);
    // 反向自证：同一替身的 roots() 里明明有自选根根身，可写判定必须不认它
    expect(isUnderAnyRoot(workspaceProjectDirsOf(kernel), `${EXTRA_ROOT}/散件.ERB`)).toBe(false);
  });

  it('服务不可用（projectDirs() 抛）→ 吞成空数组，绝不抛穿渲染路径', () => {
    const kernel = {
      workspaces: {
        projectDirs: () => {
          throw new Error('Workspace service is unavailable (no platform data directory)');
        },
      } as unknown as Kernel['workspaces'],
    };
    expect(workspaceProjectDirsOf(kernel)).toEqual([]);
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

/* ------------------------------ D1：会话级附加根的去重计划 ------------------------------ */

describe('planAddExtraRoot · 添加文件夹到工作区的计划', () => {
  it('新文件夹：追加到列表尾部，无需出声', () => {
    const plan = planAddExtraRoot(['D:/作品'], 'E:/借阅');
    expect(plan.roots).toEqual(['D:/作品', 'E:/借阅']);
    expect(plan.note).toBeNull();
  });

  it('重复加（pathKey 归一判等：分隔符/大小写写法差异不算新根）：原样返回 + 一句人话', () => {
    const plan = planAddExtraRoot(['D:/作品'], 'd:\\作品\\');
    expect(plan.roots).toEqual(['D:/作品']);
    expect(plan.note).toContain('已经在工作区里');
  });

  it('选了项目根本身：拒绝 + 说清为什么（它本来就在树里、也在检索里）', () => {
    const plan = planAddExtraRoot([], 'C:/GAME', 'C:/game');
    expect(plan.roots).toEqual([]);
    expect(plan.note).toContain('当前项目所在的位置');
  });

  it('空列表加第一个根：直接成', () => {
    const plan = planAddExtraRoot([], 'E:/借阅');
    expect(plan.roots).toEqual(['E:/借阅']);
    expect(plan.note).toBeNull();
  });
});

/* ------------------------------ WS-08：附加根的移除计划 ------------------------------ */

describe('planRemoveExtraRoot · 从工作区移除文件夹', () => {
  it('命中：从清单里摘掉，其余原样（且给一句"已移除"的人话）', () => {
    const plan = planRemoveExtraRoot(['D:/作品', 'E:/借阅'], 'E:/借阅');
    expect(plan.roots).toEqual(['D:/作品']);
    expect(plan.removed).toBe(true);
    expect(plan.note).toContain('已从工作区移除');
  });

  it('pathKey 判等：写法差异（分隔符 / 大小写 / 尾分隔符）也算同一个根', () => {
    const plan = planRemoveExtraRoot(['D:/作品'], 'd:\\作品\\');
    expect(plan.roots).toEqual([]);
    expect(plan.removed).toBe(true);
  });

  it('没命中：清单原样返回 + 说清"不在工作区里"（按下去必须有响）', () => {
    const plan = planRemoveExtraRoot(['D:/作品'], 'F:/别处');
    expect(plan.roots).toEqual(['D:/作品']);
    expect(plan.removed).toBe(false);
    expect(plan.note).toContain('不在工作区里');
  });
});
