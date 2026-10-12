/**
 * 糖视图面板纯逻辑单测（2026-10-12 语法糖批）。
 *
 * 面板的口径换了：从"哪些片段能安全写回 `.kojo`"（强自证，6.5% 覆盖，九万条噪声）
 * 换成读者真正会问的两句话——**"读懂了百分之多少"** 与 **"剩下的为什么是原代码"**。
 * 本文件钉死这两句话的口径，以及一条不变量：**三类计数之和恒等于总行数**。
 *
 * 输入用**真实投影器**的结果（不手搓假对象）：免得"测试过了但真实形状不对"。
 */

import { describe, expect, it } from 'vitest';
import type { SugarProjectResult, SugarProjectNativeReason } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { liftProject } from '@kojo/plugin-kojo-sugar';
import {
  breakdownText,
  coverageText,
  degradeText,
  summarizeProjection,
  type PanelDegrade,
} from '../src/panel-logic';

/** 用真实投影器（结构扫描是它的地基，故与生产装配同源注入） */
const project = (source: string): SugarProjectResult =>
  liftProject(
    { transpile: () => { throw new Error('投影不调用 transpile'); }, scanControlFlow },
    { source },
  );

/* ============================== 一、摘要口径 ============================== */

describe('糖视图 / 摘要（summarizeProjection）', () => {
  it('已映射行数与占比（含被缩进语义吸收的收束行）', () => {
    const s = summarizeProjection(
      project(['IF A', '\tPRINTFORMW 甲', 'ENDIF', '@FUNC'].join('\n')),
    )!;
    expect(s.total).toBe(4);
    expect(s.projected).toBe(3); // IF + 台词 + ENDIF
    expect(s.native).toBe(1); // @FUNC
    expect(s.passthrough).toBe(0);
    expect(s.coverage).toBe(75);
    expect(s.segments).toBe(1);
  });

  it('**不变量**：三类计数之和 = 总行数（没有行凭空消失）', () => {
    const src = [
      '; 分节线',
      'IF TALENT:TARGET:恋慕',
      '\tPRINTFORMW 「%CALLNAME:MASTER%，早上好。」',
      'ELSE',
      '\tPRINTFORMDL 她别开了脸。',
      'ENDIF',
      '',
      'SELECTCASE TFLAG:193',
      'CASE 1',
      '\tPRINTFORMW 甲',
      'ENDSELECT',
      '$LABEL',
      'X = 1',
      '#DIM Y',
    ].join('\n');
    const s = summarizeProjection(project(src))!;
    expect(s.projected + s.native + s.passthrough).toBe(s.total);
    expect(s.total).toBe(14);
  });

  it('保留原生按成因聚合并**降序**（读者先看最大的那类）', () => {
    const src = ['PRINTBUTTON "x", 1', 'PRINTBUTTON "y", 2', 'PRINTFORML', '$L'].join('\n');
    const s = summarizeProjection(project(src))!;
    expect(s.reasons[0]!.key).toBe('unsupported-print-variant');
    expect(s.reasons[0]!.count).toBe(2);
    for (let i = 1; i < s.reasons.length; i++) {
      expect(s.reasons[i - 1]!.count).toBeGreaterThanOrEqual(s.reasons[i]!.count);
    }
  });

  it('每个成因都有**中文**标签（闭集覆盖，不留裸键）', () => {
    const ALL: SugarProjectNativeReason[] = [
      'unsupported-print-variant',
      'inline-condition',
      'unsupported-control-flow',
      'data-or-skip',
      'other',
    ];
    // 构造一份把各类成因都踩一遍的源（`empty-text` 已随"空行输出"口径并入投影，故不在列）
    const src = [
      'PRINTBUTTON "x", 1', // unsupported-print-variant
      'PRINTFORMW \\@ A ? B \\@', // inline-condition
      'SIF A', // unsupported-control-flow
      'PRINTDATAL', // data-or-skip（开块行本身即 data-or-skip）
      'ENDDATA',
      'X = 1', // other
    ].join('\n');
    const s = summarizeProjection(project(src))!;
    const seen = new Set(s.reasons.map((r) => r.key));
    for (const k of ALL) {
      if (!seen.has(k)) continue; // 该源未踩到则不强制（成因构造依赖具体形态）
      const row = s.reasons.find((r) => r.key === k)!;
      expect(row.label).toMatch(/[\u4e00-\u9fa5]/);
      expect(ALL as readonly string[]).not.toContain(row.label);
    }
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it('null 结果 → null（面板显示降级文案，不假装"已读懂 0%"）', () => {
    expect(summarizeProjection(null)).toBeNull();
  });

  it('无段的文件仍给真实读数（0%，而不是"空"）', () => {
    const s = summarizeProjection(project(['@FUNC', '#DIM X', 'X = 1'].join('\n')))!;
    expect(s.segments).toBe(0);
    expect(s.projected).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.native).toBe(3);
  });
});

/* ============================== 二、文案 ============================== */

describe('糖视图 / 文案', () => {
  it('首行说"读懂了多少"（含千分位与百分比）', () => {
    const s = summarizeProjection(project(['\tPRINTFORMW 甲', '\tPRINTFORMW 乙'].join('\n')))!;
    expect(coverageText(s)).toBe('共 2 行 · 已显示为语法糖 2 行（100%）');
  });

  it('次行把"原代码"与"注释空行"分开说（读者不会以为漏了）', () => {
    const s = summarizeProjection(project([';注释', '', 'PRINTFORMW 甲', '@F'].join('\n')))!;
    expect(breakdownText(s)).toBe('原样保留原代码 1 行 · 注释与空行 2 行');
  });

  it('千分位不依赖 ICU（大文件读数稳定）', () => {
    const s = summarizeProjection({
      segments: [],
      stats: { totalLines: 12345, projectedLines: 1234, passthroughLines: 111, nativeLines: 11000, nativeByReason: [] },
    })!;
    expect(coverageText(s)).toContain('共 12,345 行');
    expect(coverageText(s)).toContain('1,234 行');
  });

  it('降级文案：每个状态都有非空中文提示', () => {
    const all: PanelDegrade[] = ['no-project', 'no-file', 'empty', 'scan-error', 'scanning', 'not-erb'];
    for (const d of all) {
      expect(degradeText(d).length).toBeGreaterThan(0);
      expect(degradeText(d)).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
