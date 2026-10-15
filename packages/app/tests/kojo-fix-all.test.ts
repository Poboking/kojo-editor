/**
 * E3「全部修复」批量层的单测——**只打纯函数这一层**（不 React、不 Monaco、不读盘）。
 *
 * 钉的是五条会伤到作者的因果：
 * (a) 批量与 💡 的 `isPreferred` 用**同一条**唯一解判据 ⇒ 多解一律不碰（不替作者选）；
 * (b) 行区间相撞**不静默丢**：本轮挑互不相交的一批，其余进下一轮，绝不后写覆盖先写；
 * (c) 每一条诊断恰好落在一个计数桶里（作者听到的数字对得上他眼前的红线条数）；
 * (d) 轮次有上界（供方永不收敛时也不挂主线程）；
 * (e) 作者面那句话不含黑话、且说得出"为什么没动"。
 */

import { describe, expect, it } from 'vitest';
import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorDecoratorContribution,
  LineDecoration,
} from '@kojo/plugin-api';
import {
  MAX_FIX_ALL_ROUNDS,
  documentDiagnostics,
  documentQuickFixes,
  fixAllSummary,
  planFixAllRound,
  runFixAll,
  type BulkFixCandidate,
  type FixAllDeps,
} from '../src/monaco/kojo-fix-all';

/* ------------------------------- 造素材 ------------------------------- */

/** 诊断（键口径与 `diagnosticKey` 一致：severity + 行 + 消息 + 码，**不含列**） */
const diag = (line: number, code: string): LineDecoration => ({
  line,
  severity: 'error',
  message: `少了闭合词（${code}）`,
  code,
});

/** 一条 quickfix 候选：改写 `from..to` 那一行、认领 `diag(claimLine, code)` */
function fix(claimLine: number, code: string, from = claimLine, to = from, text = `patch@${from}`): BulkFixCandidate {
  return { kind: 'quickfix', diagnostics: [diag(claimLine, code)], edits: [{ fromLine: from, toLine: to, newText: text }] };
}

/* ---------------------------- planFixAllRound ---------------------------- */

describe('planFixAllRound · 唯一解才动（与 isPreferred 同一条判据）', () => {
  it('两条各自唯一解、区间不相交 ⇒ 一次全收', () => {
    const diagnostics = [diag(2, 'erb.unclosed-open'), diag(7, 'erb.unclosed-open')];
    const plan = planFixAllRound([fix(2, 'erb.unclosed-open'), fix(7, 'erb.unclosed-open')], diagnostics);
    expect(plan.fixed).toBe(2);
    expect(plan.edits).toHaveLength(2);
    expect(plan.conflicted).toBe(0);
    expect(plan.ambiguous).toBe(0);
  });

  it('同一条诊断有两个改法 ⇒ 一条都不动，并如实报"需要你逐处选"', () => {
    const plan = planFixAllRound(
      [fix(2, 'erb.unclosed-open', 2, 2, '补在块尾'), fix(2, 'erb.unclosed-open', 5, 5, '补在函数末尾')],
      [diag(2, 'erb.unclosed-open')],
    );
    expect(plan.edits).toEqual([]);
    expect(plan.fixed).toBe(0);
    expect(plan.ambiguous).toBe(1);
  });

  it('refactor 类动作不是"某条红线的解"：独一份也不进批量（批量只改错了的地方，不改"能更好"的地方）', () => {
    const rewrite: BulkFixCandidate = { kind: 'refactor', diagnostics: [diag(2, 'erb.unclosed-open')], edits: [{ fromLine: 2, toLine: 2, newText: '糖写法' }] };
    const plan = planFixAllRound([rewrite], [diag(2, 'erb.unclosed-open')]);
    expect(plan.edits).toEqual([]);
    expect(plan.ambiguous).toBe(0);
    expect(plan.unclaimed).toBe(1); // 没有 quickfix 认领 ⇒ 归到"没有可自动补的改法"
  });

  it('一条动作同时认领两条、其中一条另有第二个解 ⇒ 整条不动，另一条记成"跟着一起定"（不静默）', () => {
    const d2 = diag(2, 'a');
    const d3 = diag(3, 'b');
    const wide: BulkFixCandidate = { kind: 'quickfix', diagnostics: [d2, d3], edits: [{ fromLine: 9, toLine: 9, newText: 'w' }] };
    const plan = planFixAllRound([wide, fix(3, 'b', 4, 4, 'alt')], [d2, d3]);
    expect(plan.edits).toEqual([]);
    expect(plan.ambiguous).toBe(1); // d3 有两个解
    expect(plan.bundled).toBe(1); // d2 只有那一个"绑在一起"的解
  });

  it('动作关联了请求之外的诊断 ⇒ 对这次批量不算认领（不猜）', () => {
    const plan = planFixAllRound([fix(99, 'erb.unclosed-open')], [diag(2, 'erb.unclosed-open')]);
    expect(plan.edits).toEqual([]);
    expect(plan.unclaimed).toBe(1);
  });

  it('唯一解但没有行级改写（只有 run 的动作）⇒ 不代跑，计成"要逐处确认"', () => {
    const noEdits: BulkFixCandidate = { kind: 'quickfix', diagnostics: [diag(2, 'x')], edits: [] };
    const plan = planFixAllRound([noEdits], [diag(2, 'x')]);
    expect(plan.edits).toEqual([]);
    expect(plan.manual).toBe(1);
  });
});

describe('planFixAllRound · 行区间相撞', () => {
  it('同一锚行被两条修法重写 ⇒ 只落一条，另一条记为"留给下一轮"（绝不后写盖先写）', () => {
    const plan = planFixAllRound(
      [fix(2, 'outer', 5, 5, 'ENDIF#outer'), fix(3, 'inner', 5, 5, 'ENDIF#inner')],
      [diag(2, 'outer'), diag(3, 'inner')],
    );
    expect(plan.edits).toHaveLength(1);
    expect(plan.fixed).toBe(1);
    expect(plan.conflicted).toBe(1);
  });

  it('相邻行（3 与 4）不算相撞：降序应用时下方替换不动上方行号', () => {
    const plan = planFixAllRound([fix(2, 'a', 3), fix(3, 'b', 4)], [diag(2, 'a'), diag(3, 'b')]);
    expect(plan.edits).toHaveLength(2);
    expect(plan.conflicted).toBe(0);
  });

  it('跨行区间与单行相交也算相撞', () => {
    const plan = planFixAllRound([fix(2, 'a', 3, 6), fix(5, 'b', 5)], [diag(2, 'a'), diag(5, 'b')]);
    expect(plan.edits).toHaveLength(1);
    expect(plan.conflicted).toBe(1);
  });

  it('选择顺序按锚行升序（同输入必得同输出：Ctrl+Z 后重按拿到同一批）', () => {
    const plan = planFixAllRound([fix(7, 'c', 7), fix(2, 'a', 2), fix(4, 'b', 4)], [diag(2, 'a'), diag(4, 'b'), diag(7, 'c')]);
    expect(plan.edits.map((e) => e.fromLine)).toEqual([2, 4, 7]);
  });

  it('计数不翻倍：同一条诊断画成两条重叠波浪线只算一处', () => {
    const d = diag(2, 'a');
    expect(planFixAllRound([fix(2, 'a')], [d, { ...d }]).fixed).toBe(1);
  });
});

describe('planFixAllRound · 每条诊断恰好落进一个桶', () => {
  const d1 = diag(2, 'solo');
  const d2 = diag(3, 'pair');
  const d3 = diag(4, 'none');
  const d4 = diag(5, 'wide');
  const d5 = diag(6, 'no-edits');
  const wide: BulkFixCandidate = { kind: 'quickfix', diagnostics: [d4, d2], edits: [{ fromLine: 9, toLine: 9, newText: 'w' }] };
  const noEdits: BulkFixCandidate = { kind: 'quickfix', diagnostics: [d5], edits: [] };
  const plan = planFixAllRound(
    [fix(2, 'solo'), fix(3, 'pair'), fix(3, 'pair', 8, 8, '第二个解'), wide, noEdits],
    [d1, d2, d3, d4, d5],
  );

  it('六条诊断 = 1 补成 + 1 多解 + 1 没改法 + 1 跟着一起定 + 1 逐处确认（相撞 0）', () => {
    expect(plan).toMatchObject({ fixed: 1, ambiguous: 1, unclaimed: 1, bundled: 1, manual: 1, conflicted: 0 });
    expect(plan.fixed + plan.ambiguous + plan.unclaimed + plan.bundled + plan.manual + plan.conflicted).toBe(5);
  });
});

/* -------------------------------- runFixAll -------------------------------- */

/** 一份可行的小 model：行数组 + 降序整行替换（与宿主 `applyTextEdits` 同一口径） */
function fakeDoc(lines: string[]): Pick<FixAllDeps, 'readText' | 'lineCount' | 'apply'> {
  return {
    readText: () => lines.join('\n'),
    lineCount: () => lines.length,
    apply: (edits) => {
      for (const e of [...edits].sort((a, b) => b.fromLine - a.fromLine)) {
        lines.splice(e.fromLine - 1, e.toLine - e.fromLine + 1, ...e.newText.split('\n'));
      }
      return true;
    },
  };
}

const decoratorOf = (fn: (text: string) => LineDecoration[]): EditorDecoratorContribution =>
  ({ id: 'fake-deco', title: 't', order: 1, decorate: ({ text }) => fn(text) }) as EditorDecoratorContribution;

const providerOf = (
  fn: (file: { text: string; diagnostics: readonly LineDecoration[] }) => BulkFixCandidate[],
): EditorCodeActionContribution =>
  ({
    id: 'fake-fix',
    order: 1,
    provideActions: (file: { text: string; diagnostics?: readonly LineDecoration[] }) =>
      fn({ text: file.text, diagnostics: file.diagnostics ?? [] }) as unknown as EditorCodeAction[],
  }) as unknown as EditorCodeActionContribution;

describe('runFixAll · 分轮', () => {
  /**
   * 两层未闭合（`IF OUTER` / `IF INNER`）都把闭合词补在 `ANCHOR` 之前 ⇒ 区间必然相撞。
   * 装饰器是**文本纯函数**：补上的 `ENDIF#<块名>` 让那条波浪线消失，行号跟着实际位置走；
   * 供方同样按当前文本给锚点（= 真实 `structure-fix` 的形状）。
   */
  function nestedScene() {
    const lines = ['@AEGI', 'IF OUTER', 'IF INNER', 'PRINTL 甲', 'ANCHOR'];
    const diagnosticsOf = (text: string): LineDecoration[] => {
      const rows = text.split('\n');
      const out: LineDecoration[] = [];
      for (const block of ['OUTER', 'INNER']) {
        const at = rows.findIndex((l) => l.includes(`IF ${block}`));
        if (at >= 0 && !rows.some((l) => l === `ENDIF#${block}`)) out.push(diag(at + 1, `erb.unclosed-open#${block}`));
      }
      return out;
    };
    const deps: FixAllDeps = {
      ...fakeDoc(lines),
      decorators: [decoratorOf(diagnosticsOf)],
      codeActions: [
        providerOf(({ text, diagnostics }) => {
          const rows = text.split('\n');
          const anchor = rows.findIndex((l) => l === 'ANCHOR');
          return diagnostics.map((d) => {
            const block = (d.code ?? '').split('#')[1]!;
            return {
              kind: 'quickfix',
              diagnostics: [d],
              // 整行重写语义（与 `structure-fix.ts` 同款）：补词排在锚行原文之前
              edits: [{ fromLine: anchor + 1, toLine: anchor + 1, newText: `ENDIF#${block}\n${rows[anchor]!}` }],
            };
          });
        }),
      ],
      path: 'C:/game/包/事件.ERB',
      project: null,
    };
    return { lines, deps };
  }

  it('相撞的两条 ⇒ 第二轮各自落地，一处不丢（每轮 = 一次可撤销编辑）', () => {
    const { lines, deps } = nestedScene();
    const report = runFixAll(deps);
    expect(report.fixed).toBe(2);
    expect(report.rounds).toBe(2);
    expect(report.conflicted).toBe(0); // 末轮重新采集已无残留
    expect(report.capped).toBe(false);
    expect(lines.filter((l) => l.startsWith('ENDIF#'))).toEqual(['ENDIF#OUTER', 'ENDIF#INNER']);
  });

  it('供方永不收敛（不看文本、改完仍报同两条、锚点永远相撞）⇒ 上界兜住并如实报 capped', () => {
    const doc = fakeDoc(['@AEGI', 'IF A', 'PRINTL 甲', 'ANCHOR']);
    const deps: FixAllDeps = {
      ...doc,
      // 故意病态：两条**不同**诊断各有唯一解，但都重写第 4 行 ⇒ 每轮只能落一条、也永远落不完
      decorators: [decoratorOf(() => [diag(2, 'a'), diag(2, 'b')])],
      codeActions: [providerOf(({ diagnostics }) => diagnostics.map((d) => ({ ...fix(d.line, d.code ?? '', 4, 4, 'p'), diagnostics: [d] })))],
      path: 'C:/game/包/事件.ERB',
      project: null,
    };
    const report = runFixAll(deps);
    expect(report.rounds).toBe(MAX_FIX_ALL_ROUNDS);
    expect(report.capped).toBe(true);
    expect(report.conflicted).toBe(1); // 停下时还剩一条没动，且这句话要说得出
  });

  it('宿主拒绝落地（apply 返回 false）⇒ 立即停，一条不计', () => {
    const deps: FixAllDeps = {
      readText: () => '@A\nIF X\nPRINT Y',
      lineCount: () => 3,
      apply: () => false,
      decorators: [decoratorOf(() => [diag(2, 'a')])],
      codeActions: [providerOf(({ diagnostics }) => diagnostics.map((d) => fix(d.line, 'a')))],
      path: 'C:/game/包/事件.ERB',
      project: null,
    };
    const report = runFixAll(deps);
    expect(report.fixed).toBe(0);
    expect(report.rounds).toBe(0);
  });

  it('整篇采集：递出去的 `scope` = document、`diagnostics` = 全篇波浪线、不给 `line`', () => {
    const seen: Array<Record<string, unknown>> = [];
    const spy = {
      id: 'x',
      order: 1,
      provideActions: (file: Record<string, unknown>) => {
        seen.push(file);
        return [] as EditorCodeAction[];
      },
    } as unknown as EditorCodeActionContribution;
    documentQuickFixes([spy], {
      path: 'p.ERB',
      text: 'a\nb',
      project: null,
      lineCount: 2,
      diagnostics: [diag(2, 'a')],
    });
    const arg = seen[0]! as { scope?: string; line?: number; diagnostics?: LineDecoration[] };
    expect(arg.scope).toBe('document');
    expect(arg.line).toBeUndefined();
    expect(arg.diagnostics).toHaveLength(1);
  });

  it('单个装饰器 / 单个供方抛错只丢它自己，批量整轮不崩（与波浪线同款隔离）', () => {
    const boom = { id: 'boom', title: 't', order: 1, decorate: () => { throw new Error('x'); } } as unknown as EditorDecoratorContribution;
    expect(documentDiagnostics([boom, decoratorOf(() => [diag(2, 'a')])], { path: 'p', text: 't', project: null })).toHaveLength(1);
    const bad = { id: 'bad', order: 1, provideActions: () => { throw new Error('x'); } } as unknown as EditorCodeActionContribution;
    const good = providerOf(({ diagnostics }) => diagnostics.map((d) => fix(d.line, 'a')));
    expect(documentQuickFixes([bad, good], { path: 'p', text: 't', project: null, lineCount: 2, diagnostics: [diag(2, 'a')] })).toHaveLength(1);
  });
});

/* ------------------------------ 作者面那句话 ------------------------------ */

describe('fixAllSummary · 人话、说清为什么没动', () => {
  const base = { fixed: 0, rounds: 0, capped: false, ambiguous: 0, conflicted: 0, manual: 0, bundled: 0, unclaimed: 0 };
  it('全补好：报数量，并说清没写盘、能撤销', () => {
    expect(fixAllSummary({ ...base, fixed: 3, rounds: 1 })).toBe('已补好 3 处（只改了编辑器里的内容，可按 Ctrl+Z 撤销）');
  });
  it('多解 / 绑在一起的要逐处选 ⇒ 必须出现在那句话里', () => {
    const s = fixAllSummary({ ...base, fixed: 1, rounds: 1, ambiguous: 2, bundled: 1 });
    expect(s).toContain('已补好 1 处');
    expect(s).toContain('2 处有多种改法');
    expect(s).toContain('1 处要跟那些待选的改法一起定');
  });
  it('什么都没补成 ⇒ 说清原因，不许"按了没反应"', () => {
    expect(fixAllSummary({ ...base, unclaimed: 4 })).toContain('4 处目前没有可自动补的改法');
    expect(fixAllSummary({ ...base })).toBe('这一份没有要补的问题');
  });
  it('禁黑话：作者面不出现 CodeAction / quickfix / marker / provider', () => {
    const s = fixAllSummary({ ...base, fixed: 2, rounds: 2, ambiguous: 1, manual: 1, conflicted: 1, bundled: 1, unclaimed: 1, capped: true });
    for (const word of ['CodeAction', 'quickfix', 'marker', 'provider']) expect(s).not.toContain(word);
  });
});
