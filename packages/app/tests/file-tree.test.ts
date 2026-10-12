import { describe, expect, it } from 'vitest';
import type { DirEntry } from '@kojo/plugin-api';
import { visibleEntries } from '../src/ui/FileTree';

/**
 * 真实文件夹视图的条目筛选（反馈 6/7）。
 *
 * 这里锁的是**对文件系统诚实**这条不变量：作者包展开后，嵌套目录必须原样显示自己的
 * 内容。实现第一版把「包层已平铺的 ERB」去重应用到了整棵递归，结果
 * `灵梦-少女之梦/没写的`（实有 10 个 ERB）被渲染成空目录 —— 用户点进去看到空的，
 * 会以为这个包没写完，而事实恰恰相反。这条断言就是那次踩坑的固化。
 */

const entry = (name: string, isDirectory: boolean, base = 'C:/game/kojo/001/包'): DirEntry => ({
  name,
  path: `${base}/${name}`,
  isDirectory,
});

const ROOT_ERBS = [entry('M_KOJO_K1_2_イベント.ERB', false), entry('readme.txt', false)];
const NESTED = [entry('M_KOJO_K1_2_コマンド.ERB', false), entry('M_KOJO_K1_2_依頼.ERB', false)];

describe('visibleEntries · 真实文件夹条目筛选', () => {
  it('包根层（depth 0）：与平铺列表同级的 ERB 去重，非 ERB 保留', () => {
    const skip = new Set(['c:/game/kojo/001/包/m_kojo_k1_2_イベント.erb']);
    expect(visibleEntries(ROOT_ERBS, 0, skip).map((e) => e.name)).toEqual(['readme.txt']);
  });

  it('嵌套目录（depth ≥ 1）：**一律原样返回**，绝不因"包层已平铺"而被吃掉', () => {
    // 极端情形：嵌套目录里的每个文件都出现在包层平铺列表中——仍然必须全部显示
    const skip = new Set(NESTED.map((e) => e.path.toLowerCase()));
    expect(visibleEntries(NESTED, 1, skip).map((e) => e.name)).toEqual([
      'M_KOJO_K1_2_コマンド.ERB',
      'M_KOJO_K1_2_依頼.ERB',
    ]);
    expect(visibleEntries(NESTED, 3, skip)).toHaveLength(2);
  });

  it('skip 键按归一后的路径比对（反斜杠 / 大小写差异不影响命中）', () => {
    // 反斜杠写的 Windows 路径、大写盘符与扩展名，归一后应与正斜杠小写形式等价
    const skip = new Set(['c:/game/kojo/001/包/a.erb']);
    const entries = [entry('A.ERB', false), entry('B.txt', false)];
    expect(visibleEntries(entries, 0, skip).map((e) => e.name)).toEqual(['B.txt']);
  });

  it('skip 为空时全量返回（不吞任何条目）', () => {
    expect(visibleEntries(ROOT_ERBS, 0, new Set())).toHaveLength(2);
  });

  it('不修改入参数组', () => {
    const input = [...ROOT_ERBS];
    const out = visibleEntries(input, 0, new Set());
    expect(out).not.toBe(input);
    expect(input).toEqual(ROOT_ERBS);
  });
});
