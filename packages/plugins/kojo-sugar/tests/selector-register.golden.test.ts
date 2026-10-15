/**
 * A1 批 · 选择器（别人版）登记函数。
 *
 * 痛点是**写侧断链**：`口上:` 只产 `@M_KOJO_K{n}`，产不出 `_选择器` 段与形参。
 * 本文件钉两件事：
 * 1. **写侧**：`口上: <家族名> 选择器: <n>` → `@M_KOJO_K{n}_{n}(ARG)` + 预处理行 + RESULTS
 *    逐字节；缺省选择器时输出与旧行为逐字节一致；
 * 2. **读侧往返**：选择器记在选择器登记函数名上、家族名记在带 `{t}` 的时机函数名上，
 *    投影把两者合成文件头一行 `口上: <家族名> 选择器: <n>`。
 */
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '../src/service';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { stubDict, stubFaceTable } from './support';

const t = (src: string) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);

const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
  faceTable: () => stubFaceTable(),
});

const project = (source: string) => liftProject(deps(), { source });
const segText = (r: { segments: { sugarText: string }[] }) => r.segments.map((s) => s.sugarText).join('\n');

describe('A1 · 写侧：选择器登记函数逐字节', () => {
  it('口上: <家族名> 选择器: <n> → @M_KOJO_K{n}_{s}(ARG) + LOCALSIZE/LOCALSSIZE + RESULTS', () => {
    const { erb, diagnostics } = t(
      '角色: 58\n口上: MeiLingNewVision 选择器: 1\n显示名: 新制美铃\n简介: 新制作的美铃口上。\n',
    );
    expect(diagnostics).toEqual([]);
    expect(erb).toBe(
      [
        '@M_KOJO_K58_1(ARG)',
        '#LOCALSIZE 1',
        '#LOCALSSIZE 1',
        'RESULTS = "_MeiLingNewVision"',
        'RESULTS:1 = "新制美铃"',
        'RESULTS:2 = "新制作的美铃口上。"',
        '',
      ].join('\n'),
    );
  });

  it('缺省选择器（旧语法）→ 输出与旧行为逐字节一致（不带 _s 段与预处理行）', () => {
    const { erb, diagnostics } = t('角色: 58\n口上: MeiLingNewVision\n显示名: 新制美铃\n');
    expect(diagnostics).toEqual([]);
    expect(erb).toBe(
      ['@M_KOJO_K58', 'RESULTS = "_MeiLingNewVision"', 'RESULTS:1 = "新制美铃"', ''].join('\n'),
    );
  });
});

describe('A1 · 读侧往返：ERB→.kojo 文件头带出选择器', () => {
  it('登记函数带出选择器，家族来自带 {t} 的时机函数 → 合成一行 `口上: … 选择器: …`', () => {
    const erb = [
      '@M_KOJO_K58_1(ARG)',
      '#LOCALSIZE 1',
      '#LOCALSSIZE 1',
      'RESULTS = "_MeiLingNewVision"',
      '@M_KOJO_MeiLingNewVision_EVENT_K58_5',
      'PRINTFORMW 甲',
    ].join('\n');
    const r = project(erb);
    expect(segText(r)).toContain('口上: MeiLingNewVision 选择器: 1');
    expect(segText(r)).toContain('时机 事件 5：');
  });

  it('头行再转译回同一组函数名（写读闭环）', () => {
    const { erb } = t('角色: 58\n口上: MeiLingNewVision 选择器: 1\n时机 事件 5：\n    「甲。」\n');
    expect(erb).toContain('@M_KOJO_K58_1(ARG)');
    expect(erb).toContain('#LOCALSIZE 1');
    expect(erb).toContain('@M_KOJO_MeiLingNewVision_EVENT_K58_5');
  });
});
