/**
 * 升糖重定位批验收：升糖**预览**面板纯逻辑（`panel-logic.ts`）。
 *
 * 定位（2026-10-12）：升糖只用于"看"——面板把 `sugar.lift` 结果规约成可点击预览
 * 的列表行。本模块只保留**排序 / 标签 / 跳过项 / 降级文案**，勾选三态与 diff
 * 视图（写回路径的产物）已随本插件摘除写盘能力一并删除。
 *
 * 覆盖用户验收项里的两件事：
 * - **候选列表按行区间排序**（含"同起点短区间在前"）；
 * - **未建议区间显式呈现**（跳过原因闭集覆盖）+ 降级文案闭集覆盖。
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
  buildRows,
  buildSkipRows,
  degradeText,
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

describe('升糖预览 / 候选列表（buildRows）', () => {
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

  it('`作者色` 口径标记：预览时需提示作者（依赖文件头「旁白色: 作者色」）', () => {
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

  it('稳定键 `kind|from|to`（React key 用；同行区间不重复）', () => {
    const rows = buildRows(resultOf([stubCandidate({ fromLine: 9, toLine: 9 }), stubCandidate({ fromLine: 2, toLine: 2 })]));
    expect(rows.map((r) => r.key)).toEqual(['print-message|2|2', 'print-message|9|9']);
  });
});

/* ============================== 二、跳过项与降级文案 ============================== */

describe('升糖预览 / 跳过项与降级文案', () => {
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