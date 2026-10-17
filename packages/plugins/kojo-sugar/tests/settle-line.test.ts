/**
 * B5 · 行级糖 `结算 <表达式>` → 一行原生 `EXP:<表达式>`。
 *
 * 判据（本批）：
 * - `结算 <引用> <op> <值>` 的表达式**逐字**接到 `EXP:` 前缀后，产一行原生 ERB——
 *   省略作用域（`Ｍ経験`）与显式作用域（`MASTER:絶頂経験`）两形态都由作者写在表达式里，
 *   转译器**不解释**作用域词、也不编任何经验名；
 * - 与既有赋值管线不冲突：`结算` 关键字以 CJK 起头，`+=` 不会被 `parseAssignment` 当左值误吞；
 * - 手写 `EXP:…` 行不受影响：转译侧由 `RAW_INSTR_RE` 更早截获、原样透传；投影侧仍走既有
 *   "状态赋值 / 原生直通"口径（不回退、不改字节）。
 *
 * 语料取证（`ERB\口上・メッセージ関連` 2317 份 `.ERB`）：行首 `EXP:` 结算形 3,274 处，
 * 其中带作用域 2,654 / 省略作用域 620；`Ｍ` 是**经验名** `Ｍ経験` 的一部分，不是 MASTER 作用域
 * （全角 `Ｍ`/`Ｃ`/`Ｖ`/`Ａ`/`Ｂ` 经验并列；真正的 MASTER 作用域写作全 ASCII `MASTER`）。
 */

import { describe, expect, it } from 'vitest';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '../src/service';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 正文落在 `时机 绝顶：` 体内（stub 表 = eraTW 真实模板） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/** 产物按行展开、去缩进 */
const outLines = (src: string): string[] => t(src).erb.split('\n').map((l) => l.trim());
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
const hasExp = (src: string): boolean => outLines(src).some((l) => l.startsWith('EXP:'));

/** 投影只依赖结构扫描（transpile 用抛错替身证明不被调用） */
const projDeps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (text: string) => scanControlFlow(text),
});

/* ================================ 正向 ================================ */

describe('B5 结算行 · 正向（→ 一行原生 EXP: ERB）', () => {
  it('省略作用域：`结算 Ｍ経験 += 1` → `EXP:Ｍ経験 += 1`（真语料形态）', () => {
    const src = doc('\t结算 Ｍ経験 += 1');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('EXP:Ｍ経験 += 1');
  });

  it('真语料实例：`结算 愛情経験 += 20` → `EXP:愛情経験 += 20`', () => {
    // 语料 `001 Reimu [霊夢]/灵梦-少女之梦/M_KOJO_K1_2_日常系コマンド.ERB:4397`
    expect(outLines(doc('\t结算 愛情経験 += 20'))).toContain('EXP:愛情経験 += 20');
  });

  it('显式作用域：`结算 MASTER:絶頂経験 += 1` → `EXP:MASTER:絶頂経験 += 1`（不解释作用域词）', () => {
    expect(outLines(doc('\t结算 MASTER:絶頂経験 += 1'))).toContain('EXP:MASTER:絶頂経験 += 1');
  });

  it('`++` 形：`结算 Ｍ経験 ++` → `EXP:Ｍ経験 ++`', () => {
    expect(outLines(doc('\t结算 Ｍ経験 ++'))).toContain('EXP:Ｍ経験 ++');
  });

  it('逐字节：表达式原文照接，**不补/不减空格**', () => {
    const src = doc('\t结算 Ｍ経験+=1');
    expect(outLines(src)).toContain('EXP:Ｍ経験+=1');
    expect(outLines(src)).not.toContain('EXP:Ｍ経験 += 1');
  });

  it('英文别名 `settle` 与中文 `结算` 等价（产物逐字节相同）', () => {
    expect(t(doc('\tsettle Ｍ経験 += 1')).erb).toEqual(t(doc('\t结算 Ｍ経験 += 1')).erb);
  });

  it('行内体（`如果 …：结算 …`）同样产 EXP 直通行', () => {
    const src = doc('\t如果 1 == 1： 结算 Ｍ経験 += 1');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('EXP:Ｍ経験 += 1');
  });
});

/* ==================== 回归：手写 EXP 行不受影响 ==================== */

describe('B5 结算行 · 手写 `EXP:` 行不受影响', () => {
  it('转译：手写 `EXP:…` 由 `RAW_INSTR_RE` 截获、原样透传（不被二次套 `EXP:`）', () => {
    const src = doc('\tEXP:Ｍ経験 += 1');
    expect(outLines(src)).toContain('EXP:Ｍ経験 += 1');
    expect(outLines(src).some((l) => l.startsWith('EXP:EXP:'))).toBe(false);
  });

  it('转译：带作用域的手写 `EXP:` 行仍逐字透传', () => {
    expect(outLines(doc('\tEXP:MASTER:射精経験 += 2'))).toContain('EXP:MASTER:射精経験 += 2');
  });

  it('投影：手写 `EXP:` 行仍按既有口径原样保留（不改字节、不产生糖段）', () => {
    const r = liftProject(projDeps(), { source: 'EXP:自慰経験 += 1' });
    // ZH-P 起机房里多出的兜底段（nativeOnly）不参与这一口径
    expect(r.segments.filter((s) => s.nativeOnly !== true)).toHaveLength(0);
    expect(r.stats.nativeByReason.find((x) => x.reason === 'other')?.count).toBe(1);
  });
});

/* ============ 解析失败：不开新诊断码；与 `空行`/`心形` 同口径落文本行 ============ */

describe('B5 结算行 · 无表达式 → 文本行（不静默吞、不产 EXP:）', () => {
  it('裸 `结算`（关键字后无空白+内容）不判为结算，按文本行打印', () => {
    const src = doc('\t结算');
    expect(errs(src)).toEqual([]);
    expect(hasExp(src)).toBe(false);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('结算'))).toBe(true);
  });

  it('`结算済み`（关键字后紧跟内容、无空白）同样不判为结算', () => {
    const src = doc('\t结算済み');
    expect(hasExp(src)).toBe(false);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('结算済み'))).toBe(true);
  });
});
