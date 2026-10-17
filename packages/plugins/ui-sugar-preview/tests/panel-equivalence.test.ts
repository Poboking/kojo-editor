/**
 * W4 PANEL-DEDUP / 两面板**等价性自证**（测试文件，解耦审计 C 项豁免 ⇒ 可相对
 * 导入 editor 插件的 panel-logic——生产代码两侧仍只经 `@kojo/plugin-api` 相见）。
 *
 * 钉的是这次合并的**行为后果**，不是实现引用：
 * - 同一份诊断输入，判定面板（`buildVerdictRows`）与预览面板（`buildDiagnosticRows`）
 *   产出的行**集合、键、顺序**逐项相等——且该顺序**不等于原始输入顺序**
 *   （拿真实转译器的乱序诊断当样本，防"恒真比较"：两侧若哪天各自回退成
 *   一份拷贝，本用例立刻红）；
 * - 诊断窗口参数两模块同值（旧 80 vs 60 的隐性分叉就此钉死）；
 * - 降级文案 / `.kojo` 判定两模块逐字一致。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import * as editorLogic from '../../ui-sugar-editor/src/panel-logic';
import * as previewLogic from '../src/panel-logic';

/* ============================== 一、真实转译器乱序诊断 ============================== */

const SRC = [
  '角色: 1',
  '时机 指令 310：',
  '    如果 未定义变量甲：', // unknown-identifier（表外名，必出诊断）
  '        「呀。」',
  '    「你好。续」', // 续接写在引号内（判定面板同款病句）
  '',
].join('\n');

const transpile = createSugarTranspileService({ faceTable: createEratwFaceTable() });
const realDiagnostics: readonly SugarDiagnostic[] = transpile.transpile(SRC, {
  filePath: '/proj/口上/x.kojo',
}).diagnostics;

describe('W4 / 两面板诊断行：同集合、同键、同序（等价性自证）', () => {
  it('真实转译诊断 → 两侧产出逐字段 deep equal（含 key 与顺序）', () => {
    const verdict = editorLogic.buildVerdictRows(realDiagnostics);
    const preview = previewLogic.buildDiagnosticRows(realDiagnostics);
    expect(preview.length).toBeGreaterThan(0); // 输入必须真能出诊断，否则比较恒真
    expect(preview).toEqual(verdict);
  });

  it('规范化确已发生：输出顺序 ≠ 上游原样顺序（文件级诊断殿后、有位置的在前）', () => {
    const fileLevel = {
      code: 'alias-dup',
      severity: 'warning',
      message: '文件级样本诊断',
      loc: null,
    } as unknown as SugarDiagnostic;
    const mixed = [fileLevel, ...realDiagnostics];
    const rows = previewLogic.buildDiagnosticRows(mixed);
    expect(editorLogic.buildVerdictRows(mixed)).toEqual(rows);
    const lastNumbered = rows.reduce((acc, r, i) => (r.line !== null ? i : acc), -1);
    const firstNull = rows.findIndex((r) => r.line === null);
    expect(firstNull).toBeGreaterThan(lastNumbered); // 「殿后」分支被真正走到
    expect(rows[0]!.line).not.toBeNull(); // 与输入首条（文件级）不同位 ⇒ 非恒等映射
    expect(rows).toEqual([...rows].sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9)));
  });

  it('手写乱序样本：同位置保序 + 文件级殿后，两侧一致', () => {
    const d = (code: string, line: number | null): SugarDiagnostic =>
      ({ code, severity: 'warning', message: code, loc: line && { line, column: 1 } }) as SugarDiagnostic;
    const input = [d('file', null), d('L9', 9), d('L2x', 2), d('L2y', 2)];
    expect(editorLogic.buildVerdictRows(input).map((r) => r.code)).toEqual(['L2x', 'L2y', 'L9', 'file']);
    expect(previewLogic.buildDiagnosticRows(input)).toEqual(editorLogic.buildVerdictRows(input));
  });
});

/* ============================== 二、窗口参数同值（80/60 分叉钉死） ============================== */

describe('W4 / 两面板诊断窗口参数同值', () => {
  it('INITIAL / STEP 两模块数值相等，且 = 契约层统一档（80 / 160）', () => {
    expect(editorLogic.DIAG_WINDOW_INITIAL).toBe(previewLogic.DIAG_WINDOW_INITIAL);
    expect(editorLogic.DIAG_WINDOW_STEP).toBe(previewLogic.DIAG_WINDOW_STEP);
    expect(previewLogic.DIAG_WINDOW_INITIAL).toBe(80);
    expect(previewLogic.DIAG_WINDOW_STEP).toBe(160);
  });

  it('窗口纯函数同结果（diagWindowSize / nextDiagWindow 两侧逐步一致）', () => {
    expect(previewLogic.diagWindowSize(10_000, undefined)).toBe(editorLogic.diagWindowSize(10_000, undefined));
    let e: number | undefined = undefined;
    let p: number | undefined = undefined;
    for (let i = 0; i < 500 && e !== 3000; i++) {
      e = editorLogic.nextDiagWindow(e, 3000);
      p = previewLogic.nextDiagWindow(p, 3000);
      expect(p).toBe(e); // 两模块独立驱动同一序列，逐步对齐
    }
    expect(e).toBe(3000);
    expect(p).toBe(3000);
  });
});

/* ============================== 三、降级文案 / 文件判定同字 ============================== */

describe('W4 / 两面板降级文案与 .kojo 判定逐字一致', () => {
  it('degradeText 对判定面板闭集四键输出同字', () => {
    for (const d of ['no-project', 'not-kojo', 'reading', 'read-error'] as const) {
      expect(previewLogic.degradeText(d)).toBe(editorLogic.degradeText(d));
    }
  });

  it('isKojoFile 两侧同判（含大小写 / 空值 / 非糖源）', () => {
    for (const p of ['/p/a.kojo', '/p/A.KOJO', '/p/a.ERB', '', '.kojo', 'x.kojo.bak', null, undefined]) {
      expect(previewLogic.isKojoFile(p)).toBe(editorLogic.isKojoFile(p));
    }
  });

  it('createLiveTextPool 同实现行为：两侧池对同一路径序列给出同一答案', () => {
    const e = editorLogic.createLiveTextPool();
    const p = previewLogic.createLiveTextPool();
    for (const pool of [e, p]) pool.apply('C:\\Proj\\X.kojo', 'truth');
    expect(p.textFor('c:/proj/x.kojo')).toBe(e.textFor('C:/PROJ/X.KOJO'));
    expect(e.textFor('c:/proj/x.kojo')).toBe('truth');
  });
});
