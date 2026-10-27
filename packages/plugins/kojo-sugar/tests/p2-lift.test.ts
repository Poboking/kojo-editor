/**
 * v1.9 P2 · 回读收口（原生 → 糖）：预处理条件块 / 行连接块。
 *
 * P0 只做了写层（糖 → 原生），回读面留到 P2。本文件钉三路：
 * 1. **正例**：`[IF X] … [ENDIF]` → `预处理 如果 X： … 预处理结束`；`{ … }` → 两枚中文词，
 *    候选 `roundTrip.verified === true`；
 * 2. **漏报口径**：未收束 / 嵌套 / 穿越 `@` / 块体含 `#` `@` ⇒ 不产出候选（宁可漏报）；
 * 3. **缩进口径**：预处理自证按去缩进比对（`indentRelaxed` 显式标注），不做假逐字节。
 */

import { describe, expect, it } from 'vitest';
import type { ConditionExpr, ControlFlowStatement, SugarLiftResult } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createSugarTranspileService } from '../src/service';
import { liftSuggest } from '../src/lift';
import type { LiftDeps } from '../src/lift';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '恋慕' || name === '嫉妒') return 'TALENT';
    if (name === '好感度') return 'CFLAG';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (['CFLAG', 'TALENT', 'MARK', 'FLAG'].includes(head)) return ident;
    return undefined;
  },
};

const deps = (): LiftDeps => ({
  transpile: (source, options) =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(source, options),
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
  parseCondition: (text: string): ConditionExpr => parseExpression(text),
});

const lift = (source: string): SugarLiftResult => liftSuggest(deps(), { source });

/* ============================== 预处理条件块 ============================== */

describe('P2 回读 · 预处理条件块', () => {
  it('正例：IF / ELSE / ENDIF → `预处理 如果 …：` / `预处理 否则：` / `预处理结束`', () => {
    const r = lift(
      [
        '[IF 恋慕开关]',
        'PRINTFORMW 「好」',
        '[ELSE]',
        'PRINTFORMW 「不」',
        '[ENDIF]',
      ].join('\n'),
    );
    const c = r.candidates.find((x) => x.kind === 'preproc-block');
    expect(c, `应产出预处理块候选；实际 ${r.candidates.map((x) => x.kind).join(',')}`).toBeTruthy();
    expect(c!.fromLine).toBe(1);
    expect(c!.toLine).toBe(5);
    expect(c!.sugarSource.split('\n')).toEqual([
      '预处理 如果 恋慕开关：',
      '\t「好」',
      '预处理 否则：',
      '\t「不」',
      '预处理结束',
    ]);
    expect(c!.roundTrip.verified).toBe(true);
    expect(c!.roundTrip.indentRelaxed).toBe(true);
  });

  it('正例：调试二形共用 `预处理结束`', () => {
    const r = lift(['[IF_DEBUG]', 'PRINTFORMW 「仅调试」', '[ENDIF]'].join('\n'));
    const c = r.candidates.find((x) => x.kind === 'preproc-block');
    expect(c?.sugarSource.split('\n')[0]).toBe('预处理 调试：');
  });

  it('漏报：未收束 ⇒ 不猜', () => {
    const r = lift(['[IF 恋慕开关]', 'PRINTFORMW 「好」'].join('\n'));
    expect(r.candidates.some((x) => x.kind === 'preproc-block')).toBe(false);
  });

  it('漏报：块体含 `#` / `@` ⇒ skipped（macro-or-directive）', () => {
    const r = lift(['[IF 恋慕开关]', '#DIM 好感度, 10', '[ENDIF]'].join('\n'));
    expect(r.candidates.some((x) => x.kind === 'preproc-block')).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toContain('macro-or-directive');
  });

  it('停用区内不读', () => {
    const r = lift(['[SKIPSTART]', '[IF 恋慕开关]', '[ENDIF]', '[SKIPEND]'].join('\n'));
    expect(r.candidates.some((x) => x.kind === 'preproc-block')).toBe(false);
  });
});

/* ============================== 行连接块 ============================== */

describe('P2 回读 · 行连接块', () => {
  it('正例：`{` … `}` → `多行语句开始` / `多行语句结束`（块体逐字节）', () => {
    const r = lift(['{', 'PRINTFORM 这是一条很长的', '\t需要拆成多行写的语句', '}'].join('\n'));
    const c = r.candidates.find((x) => x.kind === 'line-join');
    expect(c, `应产出行连接候选；实际 ${r.candidates.map((x) => x.kind).join(',')}`).toBeTruthy();
    expect(c!.fromLine).toBe(1);
    expect(c!.toLine).toBe(4);
    expect(c!.sugarSource.split('\n')).toEqual([
      '多行语句开始',
      'PRINTFORM 这是一条很长的',
      '\t需要拆成多行写的语句',
      '多行语句结束',
    ]);
    expect(c!.roundTrip.verified).toBe(true);
  });

  it('漏报：嵌套 `{`（引擎无嵌套语义）', () => {
    const r = lift(['{', 'PRINTFORM x', '{', 'PRINTFORM y', '}', '}', ''].join('\n'));
    expect(r.candidates.some((x) => x.kind === 'line-join')).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toContain('not-covered');
  });

  it('漏报：`}` 落空 / 穿越函数头', () => {
    const r = lift(['{', 'PRINTFORM x', '@NEXT', '}'].join('\n'));
    expect(r.candidates.some((x) => x.kind === 'line-join')).toBe(false);
  });
});
