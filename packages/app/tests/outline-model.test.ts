/**
 * 侧栏大纲纯逻辑（`outline-model.ts`，批次十 S9）单测。
 *
 * 只测三件事：树的先序扁平化与层级 / 兄弟排序、光标定位（与面包屑同一判据）、
 * 等值键。渲染与订阅不在本文件（组件侧无纯判据）。
 */

import { describe, expect, it } from 'vitest';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import {
  buildOutlineRows,
  locateOutlineRow,
  outlineHasChildren,
  outlineRowsKey,
  visibleOutlineRows,
} from '../src/ui/outline-model';

const sym = (
  name: string,
  startLine: number,
  endLine: number,
  children?: EditorDocumentSymbol[],
): EditorDocumentSymbol => ({
  name,
  kind: 'block',
  startLine,
  endLine,
  ...(children ? { children } : {}),
});

describe('buildOutlineRows · 先序扁平化与层级', () => {
  it('平铺树（ERB 形状）→ 全部 depth 0，保持文档序', () => {
    const rows = buildOutlineRows([sym('ALPHA', 2, 9), sym('BETA', 12, 30), sym('FOO', 31, 31)]);
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ['ALPHA', 0],
      ['BETA', 0],
      ['FOO', 0],
    ]);
  });

  it('嵌套树（`.kojo` 形状）→ 父在子前逐层下钻，depth 即层级', () => {
    const tree = [
      sym('时机 指令 310', 1, 20, [
        sym('如果 教養 > 30', 2, 6, [sym('否则', 4, 6)]),
        sym('当 TFLAG:193', 8, 15),
      ]),
      sym('函数 工具甲', 21, 40),
    ];
    const rows = buildOutlineRows(tree);
    expect(rows.map((r) => `${r.depth}:${r.name}`)).toEqual([
      '0:时机 指令 310',
      '1:如果 教養 > 30',
      '2:否则',
      '1:当 TFLAG:193',
      '0:函数 工具甲',
    ]);
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('兄弟按起始行稳定排序；同起始行保留 provider 的文档序', () => {
    const rows = buildOutlineRows([sym('后', 10, 12), sym('先', 2, 3), sym('同A', 5, 8), sym('同B', 5, 9)]);
    expect(rows.map((r) => r.name)).toEqual(['先', '同A', '同B', '后']);
  });

  it('detail 原样带出（无 detail ⇒ null）', () => {
    const rows = buildOutlineRows([
      { name: '有说明', kind: 'function', startLine: 1, endLine: 2, detail: '教養 > 30' },
      sym('无说明', 3, 4),
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['教養 > 30', null]);
  });

  it('空树 → 空行序（组件据此显示空态）', () => {
    expect(buildOutlineRows([])).toEqual([]);
  });
});

describe('locateOutlineRow · 光标行定位', () => {
  const tree = [
    sym('时机 指令 310', 1, 20, [
      sym('如果 教養 > 30', 2, 6, [sym('否则', 4, 6)]),
      sym('当 TFLAG:193', 8, 15),
    ]),
    sym('函数 工具甲', 21, 40),
  ];
  const rows = buildOutlineRows(tree);

  it('落在最深一层（外→内链尾）', () => {
    expect(rows[locateOutlineRow(rows, tree, 5)]?.name).toBe('否则');
    expect(rows[locateOutlineRow(rows, tree, 10)]?.name).toBe('当 TFLAG:193');
  });

  it('父层边界含端点；同一行上取更深的那层', () => {
    expect(rows[locateOutlineRow(rows, tree, 1)]?.name).toBe('时机 指令 310');
    expect(rows[locateOutlineRow(rows, tree, 2)]?.name).toBe('如果 教養 > 30');
    expect(rows[locateOutlineRow(rows, tree, 3)]?.name).toBe('如果 教養 > 30');
    expect(rows[locateOutlineRow(rows, tree, 6)]?.name).toBe('否则');
    expect(rows[locateOutlineRow(rows, tree, 7)]?.name).toBe('时机 指令 310');
  });

  it('块间空档 / 行号越界 / 空树 ⇒ -1（不猜）', () => {
    const flat = [sym('ALPHA', 2, 9), sym('BETA', 12, 30)];
    const flatRows = buildOutlineRows(flat);
    expect(locateOutlineRow(flatRows, flat, 10)).toBe(-1);
    expect(locateOutlineRow(rows, tree, 9999)).toBe(-1);
    expect(locateOutlineRow([], [], 3)).toBe(-1);
  });

  it('行序与符号树不是同一棵 ⇒ -1（不许按名字/行号硬配）', () => {
    const other = [sym('时机 指令 310', 1, 20)];
    expect(locateOutlineRow(rows, other, 5)).toBe(-1);
  });

  it('与面包屑同一判据：同层重叠取最小区间，双胞胎取文档序第一枚', () => {
    const overlapping = [sym('大框', 1, 10, [sym('小框', 4, 6)]), sym('平行', 1, 10)];
    const rows2 = buildOutlineRows(overlapping);
    expect(rows2[locateOutlineRow(rows2, overlapping, 5)]?.name).toBe('小框');

    const twins = [sym('先出现的', 1, 4), sym('同区间', 1, 4)];
    const rows3 = buildOutlineRows(twins);
    expect(rows3[locateOutlineRow(rows3, twins, 2)]?.name).toBe('先出现的');
  });
});

describe('outlineRowsKey · 等值键', () => {  it('同形树同键；名称 / 层级 / 行号 / 说明任一变化即不同键', () => {
    const base = buildOutlineRows([sym('A', 1, 3), sym('B', 4, 9, [sym('C', 5, 6)])]);
    const same = buildOutlineRows([sym('A', 1, 3), sym('B', 4, 9, [sym('C', 5, 6)])]);
    expect(outlineRowsKey(base)).toBe(outlineRowsKey(same));

    expect(outlineRowsKey(base)).not.toBe(outlineRowsKey(buildOutlineRows([sym('A2', 1, 3)])));
    expect(outlineRowsKey(base)).not.toBe(outlineRowsKey(buildOutlineRows([sym('A', 1, 3)])));
    expect(outlineRowsKey(base)).not.toBe(outlineRowsKey(buildOutlineRows([sym('A', 2, 3)])));
    expect(outlineRowsKey(base)).not.toBe(
      outlineRowsKey(
        buildOutlineRows([{ name: 'A', kind: 'block', startLine: 1, endLine: 3, detail: '说明' }]),
      ),
    );
  });
});

/**
 * 折叠投影（1023 缺口批）：面板的折叠是**纯视图状态**，判据全在这两个纯函数里——
 * "哪些行有子节点"（可折性）与"折了之后看得见哪些行"（投影）。
 * 组件侧只负责把 Set 递进来、把点击递出去。
 */
describe('outlineHasChildren · 可折性只看相邻层级', () => {
  const nested = buildOutlineRows([
    sym('父', 1, 20, [sym('子甲', 2, 5), sym('子乙', 6, 9, [sym('孙', 7, 8)])]),
    sym('兄弟叶', 21, 30),
  ]);

  it('紧随其后那一行更深 ⇒ 有子节点；叶子行 / 越界 ⇒ 没有', () => {
    expect(nested.map((_, i) => outlineHasChildren(nested, i))).toEqual([true, false, true, false, false]);
    expect(outlineHasChildren(nested, 99)).toBe(false);
    expect(outlineHasChildren([], 0)).toBe(false);
  });

  it('单层树（ERB 平铺）⇒ 一支都折不了', () => {
    const flat = buildOutlineRows([sym('ALPHA', 2, 9), sym('BETA', 12, 30)]);
    expect(flat.map((_, i) => outlineHasChildren(flat, i))).toEqual([false, false]);
  });
});

describe('visibleOutlineRows · 折叠投影', () => {
  const rows = buildOutlineRows([
    sym('父', 1, 20, [sym('子甲', 2, 5), sym('子乙', 6, 9, [sym('孙', 7, 8)])]),
    sym('兄弟叶', 21, 30),
  ]);
  const names = (collapsed: ReadonlySet<string>): string[] =>
    visibleOutlineRows(rows, collapsed).map((row) => row.name);

  it('空集 ⇒ 原样全出（连引用都还是那一份行序的拷贝）', () => {
    expect(names(new Set())).toEqual(['父', '子甲', '子乙', '孙', '兄弟叶']);
    expect(visibleOutlineRows(rows, new Set())).toEqual([...rows]);
  });

  it('折父 ⇒ 整支消失，兄弟仍在（先序相邻性 = 一支是连续的一段）', () => {
    expect(names(new Set([rows[0]!.id]))).toEqual(['父', '兄弟叶']);
  });

  it('折中间那层 ⇒ 只掉它名下的孙，父与兄弟不受影响', () => {
    expect(names(new Set([rows[2]!.id]))).toEqual(['父', '子甲', '子乙', '兄弟叶']);
  });

  it('两层同时折 ⇒ 父收起后孙本来就不在屏上，集合内容不影响结果', () => {
    expect(names(new Set([rows[0]!.id, rows[2]!.id]))).toEqual(['父', '兄弟叶']);
  });

  it('叶子行的 id 混进集合 ⇒ 不生效（不会出现"折了一行却什么都不变"）', () => {
    expect(names(new Set([rows[1]!.id]))).toEqual(['父', '子甲', '子乙', '孙', '兄弟叶']);
  });

  it('折叠不改行身份与层级（缩进 / 右键认人都不受折叠影响）', () => {
    const visible = visibleOutlineRows(rows, new Set([rows[2]!.id]));
    expect(visible.map((row) => `${row.id}:${row.depth}`)).toEqual(['r0:0', 'r1:1', 'r2:1', 'r4:0']);
  });
});
