/**
 * `@kojo/kojo-lang/diagnostics` 与 `diagnostic-result` 的判据闸（B3 收口最后一格）。
 *
 * 四组断言，各自防一种真实退化：
 * 1. **编译口径**：真 core（fixture 两面）跑出错误 / 警告两档，行 / 列 / 严重级 / 码逐条对得上；
 * 2. **落点安全**：零宽扩一格、跨行保留、缺 span 退文件头、越界夹回、代理对不劈开、CRLF 不撑宽；
 * 3. **失败可见**：编译入口抛错 ⇒ `error` 非空、行清空、产物作废（不当"这份文件干净"）；
 * 4. **交接面**：两面登记表的后登记者优先 / 注销只撤自己；成品交接有界、路径归一、能撤下。
 *
 * 与宿主那枚旧 `kojo2-diagnostics.test.ts` 的分工：那边测的是"判据搬走后宿主翻译仍逐字相同"，
 * 这边测判据本体。两处都跑真 core，不造第二套诊断形状。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameAdapter, KojoDiagnostic, KojoEmitBackend, KojoSpan } from '@kojo/kojo-core';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '@kojo/kojo-core';
import {
  KOJO2_DIAGNOSTIC_SOURCE,
  kojo2DocumentDiagnostics,
  kojo2RowsOfDiagnostics,
  kojo2SurfaceNow,
  kojo2SurfaceSourceCount,
  registerKojo2SurfaceSource,
} from '../src/diagnostics';
import {
  KOJO2_DIAGNOSTIC_RESULTS_LIMIT,
  clearKojo2DiagnosticResults,
  forgetKojo2DiagnosticResult,
  kojo2DiagnosticResultCount,
  kojo2DiagnosticResultFor,
  rememberKojo2DiagnosticResult,
} from '../src/diagnostic-result';

function diagnostic(
  code: string,
  severity: KojoDiagnostic['severity'],
  message: string,
  span: KojoDiagnostic['span'],
): KojoDiagnostic {
  return { code, severity, message, span } as KojoDiagnostic;
}

afterEach(() => {
  clearKojo2DiagnosticResults();
});

/* ============================== 真 core：错误 / 警告分档 ============================== */

describe('文档级诊断 · 真 core（fixture 两面）', () => {
  it('错误诊断：行 / 列 / 严重级 / 码全部落到行上，且产物成对', () => {
    const source = ['# 机 开场', '# 视角 我', '@算', '    1 + 2', ''].join('\n');
    const result = kojo2DocumentDiagnostics({
      source,
      filePath: 'ERB/错误.kojo2',
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.filePath).toBe('ERB/错误.kojo2');
    expect(result.error).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(result.diagnostics.length);
    expect(result.artifacts).not.toBeNull();
    expect(typeof result.artifacts?.erb).toBe('string');
    expect(result.artifacts?.sourceMap).toBeDefined();
    const errorIndex = result.diagnostics.findIndex((item) => item.severity === 'error');
    const row = result.rows[errorIndex]!;
    const error = result.diagnostics[errorIndex]!;
    expect(row.code).toBe(error.code);
    expect(row.severity).toBe('error');
    expect(row.line).toBeGreaterThanOrEqual(1);
    expect(row.endColumn).toBeGreaterThan(row.startColumn);
  });

  it('警告诊断：`选项` 待定 UI 走 warning 档，且不阻断（ok 仍为 true）', () => {
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      presentation: {
        ...FIXTURE_ADAPTER.presentation,
        options: {
          status: 'pending',
          button: 'BUTTON',
          input: 'INPUTS',
          result: 'RESULTS',
          maxPerScene: 1,
        },
      },
    };
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      profile: {
        ...FIXTURE_BACKEND.profile,
        presentations: { ...FIXTURE_BACKEND.profile.presentations, options: true },
      },
    };
    const source = ['# 机 开场', '# 视角 我', '选项：', '    「标签」：', '        > 选项正文。', ''].join('\n');
    const result = kojo2DocumentDiagnostics({
      source,
      filePath: 'ERB/警告.kojo2',
      adapter,
      backend,
    });
    expect(result.error).toBeNull();
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(result.rows.some((row) => row.code === 'core/options/pending' && row.severity === 'warning')).toBe(
      true,
    );
  });

  it('编译入口抛错：`error` 非空、行清空、产物作废（不伪造诊断）', () => {
    // 真 core 里会**必然被调用**的钩子是 `# 机` 的 `wrapMachine`（文件有 `# 机` 时必须实现，
    // 见 core `KojoEmitBackend.wrapMachine`）——让它在编译中抛，验的是本层的失败口径，
    // 不是 core 的错误处理。
    const exploding: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      wrapMachine: () => {
        throw new Error('事实面炸了');
      },
    };
    const result = kojo2DocumentDiagnostics({
      source: '# 机 开场\n> 正文\n',
      filePath: 'ERB/炸.kojo2',
      adapter: FIXTURE_ADAPTER,
      backend: exploding,
    });
    expect(result.error).toContain('事实面炸了');
    expect(result.rows).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toBeNull();
    expect(result.ok).toBe(false);
  });
});

/* ============================== 落点安全 ============================== */

describe('文档级诊断 · 落点归一', () => {
  it('零宽扩成一格；跨行保留；缺 span 退到文件头', () => {
    const source = 'abc\ndefg';
    const rows = kojo2RowsOfDiagnostics(
      [
        diagnostic('core/lex/anchor', 'error', '零宽', {
          start: { line: 2, column: 3 },
          end: { line: 2, column: 3 },
        } as KojoSpan),
        diagnostic('core/table/overlap', 'error', '跨行', {
          start: { line: 1, column: 2 },
          end: { line: 2, column: 3 },
        } as KojoSpan),
        diagnostic('core/expr/unknown-symbol', 'warning', '无落点', null),
      ],
      source,
    );

    expect(rows[0]).toMatchObject({ line: 2, startColumn: 3, endLine: 2, endColumn: 4 });
    expect(rows[1]).toMatchObject({ line: 1, startColumn: 2, endLine: 2, endColumn: 3 });
    expect(rows[2]).toMatchObject({ line: 1, startColumn: 1, endLine: 1, endColumn: 2 });
  });

  it('越界 / 逆序：夹回最后一行与行宽，终点不早于起点', () => {
    const source = 'abc\ndefg';
    const rows = kojo2RowsOfDiagnostics(
      [
        diagnostic('core/lex/indent', 'error', '越界', {
          start: { line: 99, column: 99 },
          end: { line: 99, column: 99 },
        } as KojoSpan),
        diagnostic('core/lex/indent', 'error', '逆序', {
          start: { line: 2, column: 4 },
          end: { line: 1, column: 1 },
        } as KojoSpan),
      ],
      source,
    );
    // 第 2 行 "defg" 行宽 5（列 5 = 行尾光标位）；零宽在行尾向左扩一格
    expect(rows[0]).toMatchObject({ line: 2, startColumn: 4, endLine: 2, endColumn: 5 });
    expect(rows[1]).toMatchObject({ line: 2, startColumn: 4, endLine: 2, endColumn: 5 });
  });

  it('代理对：零宽落在 emoji 上不切断 UTF-16 码元', () => {
    const span = (column: number): KojoSpan => ({
      start: { line: 1, column },
      end: { line: 1, column },
    });
    const rows = kojo2RowsOfDiagnostics(
      [
        diagnostic('core/lex/anchor', 'error', '起点', span(1)),
        diagnostic('core/lex/anchor', 'error', '低代理', span(2)),
        diagnostic('core/lex/anchor', 'error', '行尾', span(3)),
      ],
      '😀',
    );
    for (const row of rows) expect(row).toMatchObject({ startColumn: 1, endColumn: 3 });
  });

  it('CRLF：列号按行内码元算，行尾 `\\r` 不撑宽行宽', () => {
    const rows = kojo2RowsOfDiagnostics(
      [
        diagnostic('core/lex/anchor', 'error', '第二行', {
          start: { line: 2, column: 1 },
          end: { line: 2, column: 2 },
        } as KojoSpan),
      ],
      'a\r\nb',
    );
    expect(rows[0]).toMatchObject({ line: 2, startColumn: 1, endLine: 2, endColumn: 2 });
  });

  it('来源标签是包内唯一真源（宿主与插件都读它）', () => {
    expect(KOJO2_DIAGNOSTIC_SOURCE).toBe('Kojo 2.0');
  });
});

/* ============================== 两面登记表 ============================== */

describe('两面来源登记表', () => {
  const surface = { adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND };

  it('零登记 ⇒ null；注销只撤自己；后登记者优先', () => {
    const before = kojo2SurfaceSourceCount();
    expect(kojo2SurfaceNow('D:/p/a.kojo2')).toBeNull();
    const first = registerKojo2SurfaceSource(() => surface);
    const second = registerKojo2SurfaceSource(() => null);
    expect(kojo2SurfaceSourceCount()).toBe(before + 2);
    // 后登记者返回 null ⇒ 问下一枚（不是"有登记就赢"）
    expect(kojo2SurfaceNow('D:/p/a.kojo2')).toBe(surface);
    second();
    expect(kojo2SurfaceNow('D:/p/a.kojo2')).toBe(surface);
    first();
    first(); // 重复注销幂等
    expect(kojo2SurfaceNow('D:/p/a.kojo2')).toBeNull();
    expect(kojo2SurfaceSourceCount()).toBe(before);
  });

  it('getter 抛错 / 形状不对 ⇒ 当作没有这一枚（不把异常带出去）', () => {
    const unregisterThrow = registerKojo2SurfaceSource(() => {
      throw new Error('组合根正在重建');
    });
    const unregisterBad = registerKojo2SurfaceSource(
      () => ({ adapter: null } as unknown as { adapter: GameAdapter; backend: KojoEmitBackend }),
    );
    try {
      expect(kojo2SurfaceNow('D:/p/a.kojo2')).toBeNull();
    } finally {
      unregisterBad();
      unregisterThrow();
    }
  });
});

/* ============================== 一次编译两处消费的交接面 ============================== */

describe('诊断成品交接（diagnostic-result）', () => {
  const snapshot = {
    source: '> 正文',
    diagnostics: [] as const,
    artifacts: null,
    error: null,
  };

  it('Windows 盘符路径大小写与分隔符归一：同一份文件只有一条', () => {
    rememberKojo2DiagnosticResult('D:\\p\\口上\\A.kojo2', snapshot);
    expect(kojo2DiagnosticResultFor('d:/p/口上/a.kojo2')).toBe(snapshot);
    rememberKojo2DiagnosticResult('D:/p/口上/a.kojo2', { ...snapshot, source: '> 新正文' });
    expect(kojo2DiagnosticResultCount()).toBe(1);
    expect(kojo2DiagnosticResultFor('D:/p/口上/A.kojo2')?.source).toBe('> 新正文');
  });

  it('有界：超过上限从最久未记的那份开始丢', () => {
    for (let index = 0; index < KOJO2_DIAGNOSTIC_RESULTS_LIMIT + 2; index += 1) {
      rememberKojo2DiagnosticResult(`D:/p/${index}.kojo2`, { ...snapshot, source: String(index) });
    }
    expect(kojo2DiagnosticResultCount()).toBe(KOJO2_DIAGNOSTIC_RESULTS_LIMIT);
    expect(kojo2DiagnosticResultFor('D:/p/0.kojo2')).toBeNull();
    expect(kojo2DiagnosticResultFor('D:/p/1.kojo2')).toBeNull();
    expect(kojo2DiagnosticResultFor(`D:/p/${KOJO2_DIAGNOSTIC_RESULTS_LIMIT + 1}.kojo2`)).not.toBeNull();
  });

  it('撤下 / 全清：不存在时是 no-op', () => {
    rememberKojo2DiagnosticResult('D:/p/a.kojo2', snapshot);
    forgetKojo2DiagnosticResult('D:/p/a.kojo2');
    forgetKojo2DiagnosticResult('D:/p/没有.kojo2');
    expect(kojo2DiagnosticResultFor('D:/p/a.kojo2')).toBeNull();
    rememberKojo2DiagnosticResult('D:/p/b.kojo2', snapshot);
    clearKojo2DiagnosticResults();
    expect(kojo2DiagnosticResultCount()).toBe(0);
  });
});