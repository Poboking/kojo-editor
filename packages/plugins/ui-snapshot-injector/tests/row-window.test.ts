/**
 * 注入面板 PS-7 三条账（零 React，合成数据）：
 *
 * 1. **视口窗口数学**（回收路径）：只挂视口 ± 缓冲，占位把滚动条撑回全量高度，
 *    滚到哪一行就画哪一行（行高是量出来的，不是猜的）；
 * 2. **变量目录零拷贝**：目录行的 `cells` / `saveLen` 直接引用深解析结果
 *    （旧实现逐格 `[...c.index]` 展开，一个 `CHARA:40:100` 每帧白拷 4,000 个数组）；
 * 3. **作用域下拉一次算完**：`scopeOptions` 与旧的 `listScopes` + `scopeLabel` 逐字同值，
 *    但不再对每个选项做两次 `chars.find` + 变量表扫描。
 */

import { describe, expect, it } from 'vitest';
import type {
  ArchiveCharacterBlock,
  ArchiveVariable,
  SnapshotArchive,
} from '@kojo/plugin-api';
import {
  LIST_OVERSCAN,
  LIST_ROW_H_MAX,
  LIST_ROW_H_MIN,
  computeListWindow,
  firstVisibleRowIndex,
  resolveMeasuredRowHeight,
  rowHeightChanged,
  rowScrollTop,
  shouldRecycle,
} from '../src/list-window';
import { charaLabel, listScopes, listVars, scopeLabel, scopeOptions } from '../src/panel-logic';
import type { ScopeKind } from '../src/panel-logic';

/* ---------------- 合成档案（形状即契约；手工构造，零游戏知识） ---------------- */

function vInt(key: string, value: number): ArchiveVariable {
  return { type: 'int', key, value, offset: 0 };
}
function vStr(key: string, value: string): ArchiveVariable {
  return { type: 'str', key, value, offset: 0 };
}
function vArr1d(key: string, cells: { index: readonly number[]; value: number }[], saveLen = [10]): ArchiveVariable {
  return { type: 'int-array-1d', key, saveLen, cursor: [saveLen[0]!], nonEmpty: cells.length, cells, offset: 0 };
}
function block(index: number, vars: ArchiveVariable[]): ArchiveCharacterBlock {
  return { index, vars, dimSepIndex: null };
}

function makeArchive(charaCount = 3, cellCount = 4): SnapshotArchive {
  const chars: ArchiveCharacterBlock[] = Array.from({ length: charaCount }, (_, i) =>
    block(i, [
      vStr('CALLNAME', `角色${i}`),
      vInt('PLAM', i),
      vArr1d(
        'ARR',
        Array.from({ length: cellCount }, (_, k) => ({ index: [k], value: k * 10 })),
      ),
    ]),
  );
  return {
    path: '/g/sav/save00.sav',
    fileName: 'save00.sav',
    size: 1,
    format: 'gzip',
    version: 1800,
    fileType: 'normal',
    uniqueCode: '1',
    gameVersion: '0',
    saveMes: '',
    charCount: charaCount,
    decompressedSize: 1,
    consumed: 1,
    remaining: 0,
    globalVars: [vInt('ITEMDEFAULT', 1)],
    vars: [vInt('CFLAG', 7)],
    chars,
  } as unknown as SnapshotArchive;
}

/* ---------------- 1. 视口窗口数学 ---------------- */

describe('computeListWindow（回收路径的窗口）', () => {
  const ROW_H = 18;
  const VIEW_H = 260; // `.inj-vars` 的 max-height 量级
  const TOTAL = 3000;

  it('一屏只挂视口 + 上下缓冲（远小于全量行数）', () => {
    const w = computeListWindow(ROW_H * 500, VIEW_H, ROW_H, TOTAL);
    const bound = Math.ceil(VIEW_H / ROW_H) + 2 * LIST_OVERSCAN;
    expect(w.end - w.start).toBeLessThanOrEqual(bound);
    expect(w.end - w.start).toBeLessThan(60);
  });

  it('滚到哪一行就画哪一行：顶行必在窗口内，且落点 = 索引 × 实测行高', () => {
    for (const index of [0, 1, 37, 1500, TOTAL - 1]) {
      const scrollTop = ROW_H * index;
      const w = computeListWindow(scrollTop, VIEW_H, ROW_H, TOTAL);
      expect(firstVisibleRowIndex(scrollTop, ROW_H)).toBe(index);
      expect(index >= w.start && index < w.end).toBe(true);
      // 该行在 DOM 里的实际顶边（占位 + 窗内偏移）必须等于它的数据位置
      expect(w.topPad + (index - w.start) * ROW_H).toBe(index * ROW_H);
    }
  });

  it('占位高把滚动条撑回全量高度（顶到底的总高不变）', () => {
    const w = computeListWindow(ROW_H * 800, VIEW_H, ROW_H, TOTAL);
    const totalHeight = w.topPad + (w.end - w.start) * ROW_H + w.bottomPad;
    expect(totalHeight).toBe(TOTAL * ROW_H);
    expect(computeListWindow(0, VIEW_H, ROW_H, TOTAL).topPad).toBe(0);
    expect(computeListWindow((TOTAL - 1) * ROW_H, VIEW_H, ROW_H, TOTAL).bottomPad).toBe(0);
  });

  it('非默认行高照样对齐（量到 22 就按 22 算，不许拿初值凑）', () => {
    const fat = 22;
    const scrollTop = fat * 640;
    const w = computeListWindow(scrollTop, VIEW_H, fat, TOTAL);
    expect(firstVisibleRowIndex(scrollTop, fat)).toBe(640);
    expect(w.topPad).toBe(w.start * fat);
    expect(rowScrollTop(fat, 640)).toBe(14080);
    expect(rowScrollTop(fat, 640)).not.toBe(640 * ROW_H);
  });

  it('非法输入不炸：总数 / 行高 / 滚动量各打一遍', () => {
    expect(computeListWindow(0, VIEW_H, ROW_H, 0)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
    expect(computeListWindow(0, VIEW_H, 0, 10)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
    expect(computeListWindow(-50, VIEW_H, ROW_H, 10).start).toBe(0);
    expect(computeListWindow(Number.NaN, Number.NaN, ROW_H, 10)).toEqual(
      computeListWindow(0, 0, ROW_H, 10),
    );
    expect(computeListWindow(9_999_999, VIEW_H, ROW_H, 10).end).toBe(10);
  });

  it('overscan 大于总数也不会重复计数', () => {
    const w = computeListWindow(0, VIEW_H, ROW_H, 4, 20);
    expect(w).toEqual({ start: 0, end: 4, topPad: 0, bottomPad: 0 });
  });
});

describe('resolveMeasuredRowHeight / rowHeightChanged / shouldRecycle（重量判据）', () => {
  it('量不到 = null ⇒ 回落追加式路径（不猜一个行高）', () => {
    expect(resolveMeasuredRowHeight(null)).toBeNull();
    expect(resolveMeasuredRowHeight(undefined)).toBeNull();
    expect(resolveMeasuredRowHeight(0)).toBeNull();
    expect(resolveMeasuredRowHeight(Number.NaN)).toBeNull();
    expect(resolveMeasuredRowHeight(LIST_ROW_H_MIN - 1)).toBeNull();
  });
  it('量到整块 → 钳到上限；半像素照收', () => {
    expect(resolveMeasuredRowHeight(9999)).toBe(LIST_ROW_H_MAX);
    expect(resolveMeasuredRowHeight(18.5)).toBe(18.5);
  });
  it('0.5px 阈值：抖动不惊动整列重渲', () => {
    expect(rowHeightChanged(null, 18)).toBe(true);
    expect(rowHeightChanged(18, 18.2)).toBe(false);
    expect(rowHeightChanged(18, 22)).toBe(true);
  });
  it('不足一屏半就不回收（短列表不多一层占位）', () => {
    expect(shouldRecycle(5, 18, 260)).toBe(false);
    expect(shouldRecycle(3000, 18, 260)).toBe(true);
    expect(shouldRecycle(3000, null, 260)).toBe(false); // 还没量到
    expect(shouldRecycle(3000, 18, 0)).toBe(false); // 容器高度未知
    expect(shouldRecycle(0, 18, 260)).toBe(false);
  });
});

/* ---------------- 2. 变量目录零拷贝 ---------------- */

describe('listVars · 只读列不再深拷贝', () => {
  it('cells / saveLen 直接引用深解析结果（同一数组身份）', () => {
    const archive = makeArchive(1, 4);
    const chars = archive.chars ?? [];
    const src = chars[0]!.vars[2] as { cells: readonly unknown[]; saveLen: readonly number[] };
    const rows = listVars(archive, { kind: 'char', blockIndex: 0 });
    const arr = rows.find((r) => r.key === 'ARR');
    expect(arr?.kind).toBe('array');
    expect(arr?.cells).toBe(src.cells); // 引用相等 = 一次拷贝都没做
    expect(arr?.saveLen).toBe(src.saveLen);
    expect(arr?.preview).toBe('4 个非空单元 / 10');
  });

  it('顶层 / EM 区同样按流序出目录（判据没被顺手改）', () => {
    const archive = makeArchive(2, 1);
    expect(listVars(archive, { kind: 'top' }).map((r) => r.key)).toEqual(['CFLAG']);
    expect(listVars(archive, { kind: 'char', blockIndex: 1 }).map((r) => r.key)).toEqual([
      'CALLNAME',
      'PLAM',
      'ARR',
    ]);
    expect(listVars(archive, { kind: 'char', blockIndex: 99 })).toEqual([]);
  });

  it('同一次调用返回的目录行彼此独立（逐次读不回写档案）', () => {
    const archive = makeArchive(1, 2);
    const rows = listVars(archive, { kind: 'char', blockIndex: 0 });
    const arr = rows.find((r) => r.key === 'ARR')!;
    const before = JSON.stringify(archive.chars?.[0]?.vars[2]);
    // 目录行只被读：这里对行做"消费者会做的事"（读下标、比旧值），不许改动档案本体
    void arr.cells?.map((c) => c.index.join(','));
    void arr.cells?.find((c) => c.index.join(',') === '0');
    expect(JSON.stringify(archive.chars?.[0]?.vars[2])).toBe(before);
  });
});

/* ---------------- 3. 作用域下拉一次算完 ---------------- */

describe('scopeOptions（下拉数据一次线性扫描）', () => {
  const archive = makeArchive(3, 1);

  it('值与标签与旧口径逐字同值', () => {
    const legacy = listScopes(archive).map((s: ScopeKind) => ({
      value: s.kind === 'char' ? `char:${s.blockIndex}` : s.kind,
      label: scopeLabel(archive, s),
    }));
    expect(scopeOptions(archive)).toEqual(legacy);
  });

  it('顺序 = 角色块在前、主区、EM 在后（与 listScopes 同一条流序）', () => {
    const opts = scopeOptions(archive);
    expect(opts.map((o) => o.value)).toEqual(['char:0', 'char:1', 'char:2', 'top', 'em']);
    expect(opts[0]!.label).toBe(charaLabel((archive.chars ?? [])[0]!));
  });

  it('无角色块的档也不炸（只出主区）', () => {
    const bare = { ...(archive as { chars?: unknown }), chars: [], fileType: 'global' } as unknown as SnapshotArchive;
    expect(scopeOptions(bare).map((o) => o.value)).toEqual(['top', 'em']);
    expect(scopeOptions(bare).map((o) => o.label)).toEqual(['全局变量区', 'EM 扩展区']);
  });
});
