/**
 * 目录缓存淘汰判据（WS-12）的单测。
 *
 * 钉的是那句改前的账：**正在显示的层一个都不许被挤掉**。
 * 改前只护 `subOpen`，于是
 * ① 点开过「真实文件夹内容」的作者包目录（它的键是包键，不在 `subOpen` 里）会被淘汰，
 * ② 焦点行 / 多选行所在的那一层也会被淘汰，
 * 两者都让正显示着的目录在缓存超 400 条时变成空白。
 */
import { describe, expect, it } from 'vitest';
import { planDirCacheEviction, protectedDirKeysOf } from '../src/ui/file-tree-cache';

describe('planDirCacheEviction · 淘汰顺序可预测', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];

  it('没超上界 ⇒ 一枚都不动', () => {
    expect(planDirCacheEviction(keys, keys.length, 5, new Set())).toEqual([]);
    expect(planDirCacheEviction(keys, keys.length, 99, new Set())).toEqual([]);
  });

  it('超了就先丢**最早那份没在用的**（插入序 = 首次列举先后）', () => {
    expect(planDirCacheEviction(keys, 5, 3, new Set())).toEqual(['a', 'b']);
    expect(planDirCacheEviction(keys, 5, 1, new Set(['b']))).toEqual(['a', 'c', 'd', 'e']);
  });

  it('保护集里的条目一枚不碰，全部被保护时宁可不淘汰（展开态是作者的现场）', () => {
    expect(planDirCacheEviction(keys, 5, 1, new Set(['a', 'c', 'e']))).toEqual(['b', 'd']);
    expect(planDirCacheEviction(keys, 5, 1, new Set(keys))).toEqual([]);
  });
});

describe('protectedDirCache · 保护集 = 正在显示的层', () => {
  const subOpen = new Set(['C:/game/kojo/001/包A/sub']);

  it('展开的子目录 + 点开的包目录一起进保护集', () => {
    const got = protectedDirKeysOf({
      subOpen,
      openPackageDirs: ['C:/game/kojo/001/包A', 'C:/game/kojo/002/包B'],
      focusPath: null,
      selectedPaths: [],
    });
    expect([...got].sort()).toEqual(['C:/game/kojo/001/包A', 'C:/game/kojo/001/包A/sub', 'C:/game/kojo/002/包B']);
  });

  it('焦点行与多选集合所在层连**祖先层**一起保（祖先的列表没了，子树根本挂不出来）', () => {
    const got = protectedDirKeysOf({
      subOpen: new Set(),
      openPackageDirs: [],
      focusPath: 'C:/game/kojo/001/包A/a.ERB',
      selectedPaths: ['C:/game/kojo/001/包A/b.ERB', 'C:/work/c.ERB'],
    });
    expect(got.has('C:/game/kojo/001/包A')).toBe(true);
    expect(got.has('C:/game/kojo/001')).toBe(true);
    expect(got.has('C:/game/kojo')).toBe(true);
    expect(got.has('C:/work')).toBe(true);
    // 文件本身不是目录缓存的键（收进来只是白占一档，不影响正确性但会掩盖判据）
    expect(got.has('C:/game/kojo/001/包A/a.ERB')).toBe(false);
  });

  it('正在编辑的那一层也保（新建输入行插在它上面，淘汰它就等于把作者正在写的地方抹掉）', () => {
    const got = protectedDirKeysOf({
      subOpen: new Set(),
      openPackageDirs: [],
      focusPath: null,
      selectedPaths: [],
      editingDir: 'C:/game/kojo/001/包A',
    });
    expect(got.has('C:/game/kojo/001/包A')).toBe(true);
  });

  it('焦点为空 ⇒ 只剩现场集合（不因为 null 就多保或不炸）', () => {
    const got = protectedDirKeysOf({ subOpen, openPackageDirs: [], focusPath: null, selectedPaths: [] });
    expect([...got]).toEqual(['C:/game/kojo/001/包A/sub']);
  });
});
