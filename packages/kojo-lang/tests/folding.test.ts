/**
 * 折叠判据（`packages/kojo-lang/src/folding.ts`，B3h）的闸。
 *
 * 这两枚函数是 2.0 折叠的**唯一坐标换算**：`kojo2FoldingRangesFromWorkerFolds` 给宿主建快照
 * （worker 行对 0 基 → 契约区间 1 基），`kojo2FoldingSnapshotRanges` 给插件供方当最后一道闸
 * （同一份实现，按当下行数再裁）。四道过滤逐条钉住（B3f 之前它们是宿主 provider 里的 5 条用例，
 * 随判据整块搬进来，一条不减）：
 *
 * 1. **0 基 → 1 基**且按起点升序、同起点终点降序（外层块在前）；
 * 2. **倒置 / 零高**丢掉（没有可隐藏的行，留着只会出一个折不动的假箭头）；
 * 3. **越界不夹取**（陈旧回复不许折错行；`endRow = 行数 - 1` 是最后一行，照给）；
 * 4. **非整数 / 非有限 / 非对象**丢掉；空输入与非法行数给空结果；
 * 5. **重复**只留第一枚。
 *
 * 另钉：快照入口与行对入口**同一份判据**（把 1 基快照折回 0 基再走一遍，结果逐字相同），
 * 且快照入口对"行数变小"的情形会丢越界行（供方不拿宿主的"同版"承诺当事实）。
 */
import { describe, expect, it } from 'vitest';
import {
  kojo2FoldingRangesFromWorkerFolds,
  kojo2FoldingSnapshotRanges,
  type Kojo2FoldingRange,
  type Kojo2FoldingRow,
} from '@kojo/kojo-lang/folding';

const row = (startRow: number, endRow: number): Kojo2FoldingRow => ({ startRow, endRow });
const at = (startLine: number, endLine: number): Kojo2FoldingRange => ({ startLine, endLine });

describe('kojo2FoldingRangesFromWorkerFolds · 0 基行对 → 1 基契约区间', () => {
  it('区间 +1 且按起点升序、同起点终点降序（外层块在前）', () => {
    expect(
      kojo2FoldingRangesFromWorkerFolds([row(3, 5), row(1, 2), row(3, 9)], 20),
    ).toEqual([at(2, 3), at(4, 10), at(4, 6)]);
  });

  it('倒置 / 零高区间丢掉（没有可隐藏的行）', () => {
    expect(kojo2FoldingRangesFromWorkerFolds([row(4, 4), row(6, 3)], 20)).toEqual([]);
  });

  it('越界不夹取：startRow < 0 或 endRow >= 行数 ⇒ 丢', () => {
    expect(kojo2FoldingRangesFromWorkerFolds([row(-1, 3)], 20)).toEqual([]);
    expect(kojo2FoldingRangesFromWorkerFolds([row(0, 20)], 20)).toEqual([]);
    // 边界内侧照常给：endRow = 行数 - 1 是最后一行
    expect(kojo2FoldingRangesFromWorkerFolds([row(0, 19)], 20)).toEqual([at(1, 20)]);
  });

  it('非整数 / 非有限 / 非对象条目丢掉；空输入与非法行数给空结果', () => {
    expect(
      kojo2FoldingRangesFromWorkerFolds(
        [
          { startRow: 1.5, endRow: 4 },
          { startRow: Number.NaN, endRow: 3 },
          { startRow: 2, endRow: Number.POSITIVE_INFINITY },
          null as unknown as Kojo2FoldingRow,
        ],
        20,
      ),
    ).toEqual([]);
    expect(kojo2FoldingRangesFromWorkerFolds([], 20)).toEqual([]);
    expect(kojo2FoldingRangesFromWorkerFolds(null, 20)).toEqual([]);
    expect(kojo2FoldingRangesFromWorkerFolds(undefined, 20)).toEqual([]);
    expect(kojo2FoldingRangesFromWorkerFolds([row(0, 2)], 0)).toEqual([]);
    expect(kojo2FoldingRangesFromWorkerFolds([row(0, 2)], Number.NaN)).toEqual([]);
  });

  it('重复区间只留第一枚（worker 已去重；这里是防直接调用方）', () => {
    expect(kojo2FoldingRangesFromWorkerFolds([row(2, 6), row(2, 6)], 20)).toEqual([at(3, 7)]);
  });
});

describe('kojo2FoldingSnapshotRanges · 供方的最后一道闸（同一份判据）', () => {
  it('合法快照原样穿过（顺序、区间逐字不变）', () => {
    const snapshot = [at(1, 2), at(3, 9), at(3, 5)];
    expect(kojo2FoldingSnapshotRanges(snapshot, 20)).toEqual([at(1, 2), at(3, 9), at(3, 5)]);
  });

  it('与行对入口同一份实现：把快照折回 0 基再走一遍，结果逐字相同', () => {
    const rows = [row(3, 5), row(1, 2), row(3, 9), row(4, 4)];
    const viaRows = kojo2FoldingRangesFromWorkerFolds(rows, 20);
    expect(kojo2FoldingSnapshotRanges(viaRows, 20)).toEqual(viaRows);
  });

  it('行数变小 ⇒ 越界的快照行丢掉（不拿宿主的"同版"承诺当事实）', () => {
    expect(kojo2FoldingSnapshotRanges([at(1, 2), at(3, 30)], 10)).toEqual([at(1, 2)]);
  });

  it('倒置 / 零高 / 重复 / 非对象条目丢掉；空与非法行数给空结果', () => {
    expect(kojo2FoldingSnapshotRanges([at(4, 4), at(6, 3)], 20)).toEqual([]);
    expect(kojo2FoldingSnapshotRanges([at(2, 6), at(2, 6)], 20)).toEqual([at(2, 6)]);
    expect(
      kojo2FoldingSnapshotRanges(
        [null as unknown as Kojo2FoldingRange, 42 as unknown as Kojo2FoldingRange],
        20,
      ),
    ).toEqual([]);
    expect(kojo2FoldingSnapshotRanges([], 20)).toEqual([]);
    expect(kojo2FoldingSnapshotRanges(null, 20)).toEqual([]);
    expect(kojo2FoldingSnapshotRanges([at(1, 2)], 0)).toEqual([]);
  });

  it('幂等：同一输入问两次答案逐字相同（纯函数、无内部状态）', () => {
    const snapshot = [at(1, 2), at(3, 9)];
    expect(kojo2FoldingSnapshotRanges(snapshot, 20)).toEqual(kojo2FoldingSnapshotRanges(snapshot, 20));
  });
});
