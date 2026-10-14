/**
 * 「当前打开的文件落在哪一区」单测（2026-10-14 只读面去重批）。
 *
 * 这颗判定同时被两处消费：编辑器决定 Monaco 的 readOnly（`EditorPane.inWorkspace`）、
 * 底部状态栏决定胶囊染哪一档色。两处问的是同一个问题，判错的代价也不同：
 * - 把工作区文件认成口上区 ⇒ 作者自己的作品在屏上被标成只读（还多一颗可点的授权入口）；
 * - 把口上区 ERB 认成工作区 ⇒ 借阅件显示「可写」，而它其实一个字都写不进去——
 *   这正是"状态与事实打脸"的形状。
 * 所以每一态都配一条**反向自证**（翻输入必翻结果），防"恒真"式通过。
 */

import { describe, expect, it } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import {
  fileWritableArea,
  fileWritableAreaOf,
  isInWorkspaceFile,
  writablePillTone,
} from '../src/ui/file-area';

const DEFAULT_ROOT = 'C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces';
const EXTRA_ROOT = 'D:/作品';
const ROOTS = [DEFAULT_ROOT, EXTRA_ROOT];

/** 只填 workspaces.roots() 的最小 kernel 替身（口径同 workspace-roots.test.ts） */
function kernelWithRoots(roots: () => string[]): Pick<Kernel, 'workspaces'> {
  return { workspaces: { roots } as unknown as Kernel['workspaces'] };
}
const kernel = kernelWithRoots(() => ROOTS);

describe('fileWritableAreaOf · 三区判定', () => {
  it('工作项目区：默认根与作者自选根都算（两个根各自的反向自证=游戏目录那条）', () => {
    expect(fileWritableAreaOf(`${DEFAULT_ROOT}/p1/我的口上.kojo`, ROOTS)).toBe('workspace');
    expect(fileWritableAreaOf(`${EXTRA_ROOT}/p1/子目录/a.ERB`, ROOTS)).toBe('workspace');
    // 反向自证：同一份文件名、换成游戏目录前缀 ⇒ 立刻不是工作区
    expect(fileWritableAreaOf('C:/Game/demo/ERB/口上関連/a.ERB', ROOTS)).not.toBe('workspace');
  });

  it('口上区：工作区外的原生 ERB（.erb / .erm 都算）', () => {
    const erb = 'C:/Game/demo/ERB/a.ERB';
    expect(fileWritableAreaOf(erb, ROOTS)).toBe('game-erb');
    expect(fileWritableAreaOf('C:/Game/demo/ERB/b.erm', ROOTS)).toBe('game-erb');
    // 反向自证：同一目录里换个扩展名就不替区域作保
    expect(fileWritableAreaOf('C:/Game/demo/ERB/c.kojo', ROOTS)).toBe('other');
  });

  it('other：没有打开的文件（空态不许替任何文件作保）', () => {
    expect(fileWritableAreaOf(null, ROOTS)).toBe('other');
    // 反向自证：一有路径就落进某区，不再是 other
    expect(fileWritableAreaOf(`${DEFAULT_ROOT}/p1/a.kojo`, ROOTS)).toBe('workspace');
  });

  it('没有工作区根（服务不可用 / 浏览器开发壳）⇒ 游戏目录 ERB 仍判成口上区', () => {
    expect(fileWritableAreaOf('C:/Game/demo/ERB/a.erb', [])).toBe('game-erb');
  });

  it('Windows 语义：大小写与 `/`、`\\` 混写仍认得同一个根（判错=作品被锁只读）', () => {
    const winRoots = ['C:\\Users\\dev\\AppData\\Roaming\\dev.kojo.editor\\workspaces'];
    expect(fileWritableAreaOf(`${DEFAULT_ROOT}/p1/a.ERB`, winRoots)).toBe('workspace');
    expect(fileWritableAreaOf('c:\\users\\dev\\appdata\\roaming\\dev.kojo.editor\\workspaces\\p1\\a.ERB', winRoots)).toBe(
      'workspace',
    );
    // 反向自证：同前缀的邻居目录不是工作区
    expect(fileWritableAreaOf(`${DEFAULT_ROOT}-备份/p1/a.ERB`, winRoots)).toBe('game-erb');
  });
});

describe('fileWritableArea / isInWorkspaceFile · 与 kernel 接线', () => {
  it('两处消费同一把尺子：inWorkspace 真值 ⟺ 区域为 workspace（双向都验）', () => {
    const ws = `${EXTRA_ROOT}/p1/a.ERB`;
    expect(isInWorkspaceFile(kernel, ws)).toBe(true);
    expect(fileWritableArea(kernel, ws)).toBe('workspace');
    const game = 'C:/Game/demo/ERB/a.ERB';
    expect(isInWorkspaceFile(kernel, game)).toBe(false);
    expect(fileWritableArea(kernel, game)).not.toBe('workspace');
  });

  it('roots() 抛错（无平台数据目录）→ 不抛穿渲染路径，判成 other/game-erb', () => {
    const broken = kernelWithRoots(() => {
      throw new Error('Workspace service is unavailable');
    });
    expect(() => fileWritableArea(broken, 'C:/Game/demo/ERB/a.ERB')).not.toThrow();
    expect(fileWritableArea(broken, 'C:/Game/demo/ERB/a.ERB')).toBe('game-erb');
    expect(isInWorkspaceFile(broken, 'C:/Game/demo/ERB/a.ERB')).toBe(false);
  });
});

describe('writablePillTone · 状态栏胶囊三态', () => {
  it('工作项目区 → 绿胶囊「可写」，且**不被项目级授权状态误伤**（反向自证：项目未批准也照绿）', () => {
    expect(writablePillTone('workspace', false)).toBe('ok');
    expect(writablePillTone('workspace', true)).toBe('ok');
    // 反向自证：翻区域就翻档
    expect(writablePillTone('game-erb', true)).toBe('ro');
  });

  it('口上区（游戏目录 ERB）→ 黄胶囊「只读」，且项目级已批准也不改口（反向自证：区域翻了就变绿）', () => {
    expect(writablePillTone('game-erb', true)).toBe('ro');
    expect(writablePillTone('game-erb', false)).toBe('ro');
    expect(writablePillTone('workspace', true)).toBe('ok');
  });

  it('区域答不出（没有打开文件）→ 回落到既有的项目级口径，两向都跟', () => {
    expect(writablePillTone('other', true)).toBe('ok');
    expect(writablePillTone('other', false)).toBe('ro');
    // 反向自证：一旦有区域，项目级这一档就说了不算
    expect(writablePillTone('workspace', false)).toBe('ok');
  });

  it('端到端三态：路径决定区域、区域决定胶囊（各态都带一次翻输入的自证）', () => {
    const pillFor = (p: string | null, projectWritable: boolean): string =>
      writablePillTone(fileWritableArea(kernel, p), projectWritable);
    expect(pillFor(`${DEFAULT_ROOT}/p1/a.kojo`, false)).toBe('ok');
    expect(pillFor('C:/Game/demo/ERB/a.ERB', true)).toBe('ro');
    expect(pillFor(null, true)).toBe('ok');
    expect(pillFor(null, false)).toBe('ro');
  });
});
