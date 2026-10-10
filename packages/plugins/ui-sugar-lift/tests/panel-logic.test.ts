/**
 * S5-UI 批验收：升糖面板纯逻辑（`panel-logic.ts`）。
 *
 * 覆盖用户验收项里的三件事：
 * - **候选列表按行区间排序**（含"同起点短区间在前"）；
 * - **单选 / 全选 / 忽略**（含"忽略免疫全选"、"忽略优先于选中"）；
 * - **diff 行生成**（`-` 改前 / `+` 改后；行数不等时不强行对齐）。
 *
 * 另加：跳过项标签（闭集覆盖）、降级文案（闭集覆盖）。
 *
 * 本文件是**测试**，按解耦审计规则 C 豁免可直接 import 其它插件包
 * （这里用 kojo-sugar 的真实 lift 结果当输入，而不是手搓假对象——
 * 免得"测试通过了但真实候选的形状不对"）。
 */

import { describe, expect, it } from 'vitest';
import type { SugarLiftCandidate, SugarLiftResult, SugarLiftSkip, SugarLiftSkipReason } from '@kojo/plugin-api';
import { createSugarTranspileService, liftSuggest } from '@kojo/plugin-kojo-sugar';
// 测试可跨包 import（审计 C 项豁免 `tests/`）——分野模板表来自 eraTW adapter，
// 与生产装配同源（转译器不再内建任何模板）。
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import {
  DIFF_PREFIX,
  EMPTY_SELECTION,
  buildDiffLines,
  buildRows,
  buildSkipRows,
  clearSelection,
  degradeText,
  diffToText,
  isSelected,
  selectAll,
  selectedRows,
  summarizeSelection,
  toggleIgnore,
  toggleRow,
  type CandidateRow,
  type PanelDegrade,
} from '../src/panel-logic';

/* ============================== 输入构造 ============================== */

/** 用真实转译器 + 真实升糖器产候选（不手搓假对象） */
const lift = (source: string): SugarLiftResult => {
  const service = createSugarTranspileService({ faceTable: createEratwFaceTable() });
  return liftSuggest(
    { transpile: (s, o) => service.transpile(s, o) },
    { source },
  );
};

/** 手搓候选（用于构造边界形状：乱序 / 同起点） */
function stubCandidate(over: Partial<SugarLiftCandidate> & { fromLine: number; toLine: number }): SugarLiftCandidate {
  return {
    kind: 'print-message',
    sugarSource: `糖@${over.fromLine}`,
    confidence: 'verified',
    narrationColor: '默认',
    roundTrip: { verified: true, originalText: `原@${over.fromLine}`, generatedText: `糖@${over.fromLine}` },
    reason: '测试用',
    ...over,
  };
}

const resultOf = (list: SugarLiftCandidate[], skipped: SugarLiftSkip[] = []): SugarLiftResult => ({
  candidates: list,
  skipped,
  degraded: false,
});

/* ============================== 一、候选列表 ============================== */

describe('S5-UI / 候选列表（buildRows）', () => {
  it('按行区间升序排列（输入乱序也会被规整）', () => {
    const r = resultOf([
      stubCandidate({ fromLine: 30, toLine: 30 }),
      stubCandidate({ fromLine: 5, toLine: 5 }),
      stubCandidate({ fromLine: 17, toLine: 17 }),
    ]);
    expect(buildRows(r).map((x) => x.fromLine)).toEqual([5, 17, 30]);
  });

  it('同起点：短区间在前（父块之后的子块排后）', () => {
    const r = resultOf([
      stubCandidate({ fromLine: 10, toLine: 20 }),
      stubCandidate({ fromLine: 10, toLine: 12 }),
    ]);
    expect(buildRows(r).map((x) => `${x.fromLine}-${x.toLine}`)).toEqual(['10-12', '10-20']);
  });

  it('行区间标签：单行 `L5` / 多行 `L5–L9`', () => {
    const rows = buildRows(resultOf([stubCandidate({ fromLine: 5, toLine: 5 }), stubCandidate({ fromLine: 5, toLine: 9 })]));
    expect(rows[0]!.rangeLabel).toBe('L5');
    expect(rows[1]!.rangeLabel).toBe('L5–L9');
    expect(rows[0]!.singleLine).toBe(true);
    expect(rows[1]!.singleLine).toBe(false);
  });

  it('糖类型显示名覆盖四类（中文、零游戏名词）', () => {
    const rows = buildRows(resultOf([
      stubCandidate({ fromLine: 1, toLine: 1, kind: 'print-message' }),
      stubCandidate({ fromLine: 2, toLine: 2, kind: 'if-block' }),
      stubCandidate({ fromLine: 3, toLine: 3, kind: 'selectcase' }),
      stubCandidate({ fromLine: 4, toLine: 4, kind: 'alias' }),
    ]));
    expect(rows.map((x) => x.kindLabel)).toEqual(['文本行', '条件块', '分派块', '别名声明']);
  });

  it('`作者色` 口径标记：应用时需写文件头 → 行上显式标出', () => {
    const rows = buildRows(resultOf([
      stubCandidate({ fromLine: 1, toLine: 1, narrationColor: '作者色' }),
      stubCandidate({ fromLine: 2, toLine: 2, narrationColor: '默认' }),
    ]));
    expect(rows[0]!.needsAuthorColor).toBe(true);
    expect(rows[1]!.needsAuthorColor).toBe(false);
  });

  it('null 结果 → 空列表（面板未扫描时的初态）', () => {
    expect(buildRows(null)).toEqual([]);
  });

  it('真实升糖结果可直接建行（形状对得上，不是只对假对象成立）', () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n\tPRINTFORMDW 乙。\n';
    const rows = buildRows(lift(source));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.rangeLabel)).toEqual(['L3', 'L4']);
    expect(rows[0]!.sugarSource).toBe('甲。');
  });

  it('序号 1 基且随排序递增（列表展示用）', () => {
    const rows = buildRows(resultOf([stubCandidate({ fromLine: 9, toLine: 9 }), stubCandidate({ fromLine: 2, toLine: 2 })]));
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2]);
  });
});

/* ============================== 二、勾选三态 ============================== */

describe('S5-UI / 勾选三态（选中 / 全选 / 忽略）', () => {
  const rows: CandidateRow[] = buildRows(resultOf([
    stubCandidate({ fromLine: 1, toLine: 1 }),
    stubCandidate({ fromLine: 2, toLine: 2 }),
    stubCandidate({ fromLine: 3, toLine: 3 }),
  ]));
  const [a, b, c] = [rows[0]!.key, rows[1]!.key, rows[2]!.key];

  it('单选切换：点一次选中，再点一次取消', () => {
    let s = EMPTY_SELECTION;
    s = toggleRow(s, a);
    expect(isSelected(s, a)).toBe(true);
    s = toggleRow(s, a);
    expect(isSelected(s, a)).toBe(false);
  });

  it('全选：所有未忽略的行都进选中；全不选清空', () => {
    let s = selectAll(EMPTY_SELECTION, rows);
    expect(selectedRows(s, rows).map((r) => r.fromLine)).toEqual([1, 2, 3]);
    s = clearSelection(s);
    expect(selectedRows(s, rows)).toEqual([]);
  });

  it('忽略**免疫全选**（忽略是持续意图，不该被全选覆盖）', () => {
    let s = toggleIgnore(EMPTY_SELECTION, b);
    expect(s.ignored.has(b)).toBe(true);
    s = selectAll(s, rows);
    expect(s.selected.has(b)).toBe(false); // 全选跳过了忽略项
    expect(selectedRows(s, rows).map((r) => r.fromLine)).toEqual([1, 3]);
  });

  it('忽略优先于选中：已选中的行被忽略 → 立即移出选中', () => {
    let s = selectAll(EMPTY_SELECTION, rows);
    expect(s.selected.has(c)).toBe(true);
    s = toggleIgnore(s, c);
    expect(s.selected.has(c)).toBe(false);
    expect(isSelected(s, c)).toBe(false);
  });

  it('忽略态下点选 = 取消忽略并选中（一键恢复）', () => {
    let s = toggleIgnore(EMPTY_SELECTION, a);
    expect(isSelected(s, a)).toBe(false);
    s = toggleRow(s, a);
    expect(s.ignored.has(a)).toBe(false);
    expect(isSelected(s, a)).toBe(true);
  });

  it('取消忽略（再点一次）→ 回到未选中且未忽略', () => {
    let s = toggleIgnore(EMPTY_SELECTION, a);
    s = toggleIgnore(s, a);
    expect(s.ignored.has(a)).toBe(false);
    expect(isSelected(s, a)).toBe(false);
  });

  it('全不选**不清除忽略**（忽略是持续意图）', () => {
    let s = toggleIgnore(selectAll(EMPTY_SELECTION, rows), b);
    s = clearSelection(s);
    expect(s.ignored.has(b)).toBe(true);
    expect(selectedRows(s, rows)).toEqual([]);
  });

  it('摘要：总数 / 已选 / 忽略 / 是否含作者色', () => {
    const rs = buildRows(resultOf([
      stubCandidate({ fromLine: 1, toLine: 1, narrationColor: '作者色' }),
      stubCandidate({ fromLine: 2, toLine: 2 }),
      stubCandidate({ fromLine: 3, toLine: 3 }),
    ]));
    let s = toggleIgnore(EMPTY_SELECTION, rs[2]!.key);
    s = toggleRow(s, rs[0]!.key);
    const sum = summarizeSelection(s, rs);
    expect(sum.total).toBe(3);
    expect(sum.selected).toBe(1);
    expect(sum.ignored).toBe(1);
    expect(sum.needsAuthorColor).toBe(true);
  });

  it('摘要：未选中任何项时 needsAuthorColor 为 false（不误报）', () => {
    const rs = buildRows(resultOf([stubCandidate({ fromLine: 1, toLine: 1, narrationColor: '作者色' })]));
    expect(summarizeSelection(EMPTY_SELECTION, rs).needsAuthorColor).toBe(false);
  });
});

/* ============================== 三、diff 视图 ============================== */

describe('S5-UI / diff 视图（buildDiffLines / diffToText）', () => {
  it('逐 hunk 先 `-` 后 `+`；行数不等时不强行对齐', () => {
    const lines = buildDiffLines([
      { fromLine: 3, toLine: 3, removed: ['\tPRINTFORMDW 甲。'], added: ['\t如果 CFLAG:2 >= 30：', '\t\t甲。'] },
    ]);
    expect(lines.map((l) => l.prefix)).toEqual([DIFF_PREFIX.removed, DIFF_PREFIX.added, DIFF_PREFIX.added]);
    expect(lines.map((l) => l.text)).toEqual(['\tPRINTFORMDW 甲。', '\t如果 CFLAG:2 >= 30：', '\t\t甲。']);
  });

  it('多 hunk 顺序展开（与候选升序一致）', () => {
    const lines = buildDiffLines([
      { fromLine: 1, toLine: 1, removed: ['a'], added: ['A'] },
      { fromLine: 5, toLine: 5, removed: ['b'], added: ['B'] },
    ]);
    expect(lines.map((l) => `${l.prefix}${l.text}`)).toEqual(['-a', '+A', '-b', '+B']);
  });

  it('空 hunk 列表 → 空行列表（未选中时的预览态）', () => {
    expect(buildDiffLines([])).toEqual([]);
  });

  it('`diffToText`：`-`/`+` 前缀保留，可复制（纯文本形态）', () => {
    const text = diffToText([{ fromLine: 1, toLine: 1, removed: ['旧'], added: ['新一', '新二'] }]);
    expect(text).toBe('-旧\n+新一\n+新二');
  });
});

/* ============================== 四、跳过项与降级文案 ============================== */

describe('S5-UI / 跳过项与降级文案', () => {
  const ALL_REASONS: SugarLiftSkipReason[] = [
    'unsupported-print-variant',
    'unparsable-condition',
    'unsupported-control-flow',
    'label-or-goto',
    'macro-or-directive',
    'mixed-domain-line',
    'comment-interference',
    'roundtrip-mismatch',
    'transpile-error',
    'not-covered',
  ];

  it('每个跳过原因都有中文标签（闭集覆盖，不留裸键）', () => {
    const rows = buildSkipRows(ALL_REASONS.map((reason, i) => ({ fromLine: i + 1, toLine: i + 1, reason, message: 'x' })));
    expect(rows).toHaveLength(ALL_REASONS.length);
    for (const r of rows) {
      expect(r.reasonLabel.length).toBeGreaterThan(0);
      // 不是裸键名（键名形态：全小写 + 连字符；标签含中文）
      expect(ALL_REASONS as readonly string[]).not.toContain(r.reasonLabel);
      expect(r.reasonLabel).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('跳过项行区标签与消息原样带出（不静默——内核铁律）', () => {
    const rows = buildSkipRows([{ fromLine: 7, toLine: 9, reason: 'roundtrip-mismatch', message: '有引号却强制 D' }]);
    expect(rows[0]!.rangeLabel).toBe('L7–L9');
    expect(rows[0]!.message).toBe('有引号却强制 D');
  });

  it('缺省 / 空数组 → 空列表', () => {
    expect(buildSkipRows([])).toEqual([]);
    expect(buildSkipRows(undefined)).toEqual([]);
  });

  it('降级文案：每个状态都有非空中文提示', () => {
    const all: PanelDegrade[] = ['no-project', 'no-file', 'empty', 'scan-error', 'scanning'];
    for (const d of all) {
      expect(degradeText(d).length).toBeGreaterThan(0);
    }
  });
});
