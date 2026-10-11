/**
 * S6 批单测：糖判定面板 / 波浪线的**纯逻辑**（零 React、零内核）。
 *
 * 钉死三类最容易悄悄坏的东西：
 *   1. 判定归类（error 压倒 warning 压倒 ok；`countBySeverity` 不丢分）；
 *   2. 装饰列区间翻译（同 span 画列区间；多行 span 省 `endColumn`；文件级诊断
 *      不产装饰——波浪线必须挂在某一行上）；
 *   3. 判定行排序稳定（有位置的在前、位置升序、文件级殿后）。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic, SugarSeverity } from '@kojo/plugin-api';
import {
  buildVerdictRows,
  countBySeverity,
  degradeText,
  diagnosticDecorations,
  isKojoFile,
  summarize,
  verdictLabel,
  verdictStatus,
} from '../src/panel-logic';

/** 夹具：纯逻辑只按 severity/loc/span 归类与翻译，`code` 原样透传——用示意串即可 */
const diag = (
  d: Omit<Partial<SugarDiagnostic>, 'code'> & { code: string; severity: SugarSeverity },
): SugarDiagnostic => ({
  message: d.message ?? 'm',
  loc: d.loc ?? null,
  ...(d.span ? { span: d.span } : {}),
  code: d.code as SugarDiagnostic['code'],
  severity: d.severity,
});

describe('S6 / isKojoFile', () => {
  it('只认 .kojo（大小写不敏感）；null/其它后缀为假', () => {
    expect(isKojoFile('/p/a.kojo')).toBe(true);
    expect(isKojoFile('/p/A.KOJO')).toBe(true);
    expect(isKojoFile('/p/a.ERB')).toBe(false);
    expect(isKojoFile(null)).toBe(false);
    expect(isKojoFile(undefined)).toBe(false);
  });
});

describe('S6 / 判定归类', () => {
  it('countBySeverity 分项计数', () => {
    const c = countBySeverity([
      diag({ code: 'a', severity: 'error' }),
      diag({ code: 'b', severity: 'warning' }),
      diag({ code: 'c', severity: 'warning' }),
      diag({ code: 'd', severity: 'info' }),
    ]);
    expect(c).toEqual({ error: 1, warning: 2, info: 1 });
  });

  it('verdictStatus：error 压倒 warning 压倒 ok', () => {
    expect(verdictStatus({ error: 0, warning: 0, info: 3 })).toBe('ok');
    expect(verdictStatus({ error: 0, warning: 1, info: 0 })).toBe('warning');
    expect(verdictStatus({ error: 1, warning: 5, info: 0 })).toBe('error');
  });

  it('verdictLabel 中文标签', () => {
    expect(verdictLabel('ok')).toBe('可编译');
    expect(verdictLabel('warning')).toBe('可编译（有警告）');
    expect(verdictLabel('error')).toBe('不可编译');
  });
});

describe('S6 / 判定行（排序稳定）', () => {
  it('有位置的在前按 (行, 列) 升序；文件级殿后；同位置保留原序', () => {
    const rows = buildVerdictRows([
      diag({ code: 'file-level', severity: 'info' }), // 无位置
      diag({ code: 'L5', severity: 'warning', loc: { line: 5, column: 3 } }),
      diag({ code: 'L2b', severity: 'info', loc: { line: 2, column: 9 } }),
      diag({ code: 'L2a', severity: 'error', loc: { line: 2, column: 1 } }),
      diag({ code: 'L2c', severity: 'info', loc: { line: 2, column: 9 } }),
    ]);
    expect(rows.map((r) => r.code)).toEqual(['L2a', 'L2b', 'L2c', 'L5', 'file-level']);
    expect(rows[4]!.line).toBeNull();
  });

  it('key 唯一（含序号，避免同码同行同列塌陷）', () => {
    const rows = buildVerdictRows([
      diag({ code: 'x', severity: 'info', loc: { line: 1, column: 1 } }),
      diag({ code: 'x', severity: 'info', loc: { line: 1, column: 1 } }),
    ]);
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  });
});

describe('S6 / 装饰翻译（波浪线列区间）', () => {
  it('同 span → 画列区间（startColumn/endColumn）', () => {
    const decos = diagnosticDecorations([
      diag({
        code: 'span',
        severity: 'error',
        loc: { line: 3, column: 5 },
        span: { start: { line: 3, column: 5 }, end: { line: 3, column: 12 } },
      }),
    ]);
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ line: 3, startColumn: 5, endColumn: 12, code: 'span' });
  });

  it('多行 span → 只留起始列、省 endColumn（画到行尾）', () => {
    const decos = diagnosticDecorations([
      diag({
        code: 'multi',
        severity: 'warning',
        loc: { line: 4, column: 7 },
        span: { start: { line: 4, column: 7 }, end: { line: 8, column: 2 } },
      }),
    ]);
    expect(decos[0]).toMatchObject({ line: 4, startColumn: 7 });
    expect(decos[0]!.endColumn).toBeUndefined();
  });

  it('无 span → 从 loc.column 起（不设 endColumn）', () => {
    const decos = diagnosticDecorations([diag({ code: 'loc', severity: 'info', loc: { line: 2, column: 4 } })]);
    expect(decos[0]).toMatchObject({ line: 2, startColumn: 4 });
    expect(decos[0]!.endColumn).toBeUndefined();
  });

  it('文件级诊断（loc=null）不产装饰；startColumn 最少为 1', () => {
    const decos = diagnosticDecorations([
      diag({ code: 'file', severity: 'error' }),
      diag({ code: 'zero-col', severity: 'error', loc: { line: 1, column: 0 } }),
    ]);
    expect(decos).toHaveLength(1);
    expect(decos[0]!.startColumn).toBe(1);
  });
});

describe('S6 / 概要', () => {
  it('行数按去尾换行计算；判定随诊断', () => {
    const s = summarize('a\nb\n', 'x\ny\nz\n', 2, [diag({ code: 'e', severity: 'error', loc: { line: 1, column: 1 } })]);
    expect(s.sourceLines).toBe(2);
    expect(s.generatedLines).toBe(3);
    expect(s.mappedLines).toBe(2);
    expect(s.status).toBe('error');
    expect(s.label).toBe('不可编译');
  });

  it('空源/空产物 → 0 行', () => {
    const s = summarize('', '', 0, []);
    expect(s.sourceLines).toBe(0);
    expect(s.generatedLines).toBe(0);
    expect(s.status).toBe('ok');
  });
});

describe('S6 / 降级文案', () => {
  it('四种降级态都有非空中文文案', () => {
    for (const d of ['no-project', 'not-kojo', 'reading', 'read-error'] as const) {
      expect(degradeText(d).length).toBeGreaterThan(0);
    }
  });
});