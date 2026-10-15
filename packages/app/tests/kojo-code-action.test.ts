/**
 * 快速修复 · 宿主接线（B9）单测。
 *
 * 覆盖三条铁判据，都是"波浪线上按 `Ctrl+.` 到底捞不捞得到东西"的因果链：
 * (a) provider **声明**了类别（Monaco 的 `getCodeActionProviders` 按 `providedCodeActionKinds`
 *     与请求 kind 求交集，不声明就没资格被 `only=quickfix` 调用）；
 * (b) 递给贡献方的诊断取自**面上正画着的 marker**（`context.markers`，Monaco 的
 *     standalone 包装层已按请求区间求交）——`Ctrl+.` 是针对某一条诊断的请求，
 *     "光标在哪一行"不足以回答它，而宿主自己再存一份就要和渲染结果赛跑；
 * (c) 动作的 `diagnostics` 挂的是**翻译后的 marker**，贡献方没给关联时该字段**整个省略**
 *     （不编一个空数组假装"这条动作关联了零条诊断"）。
 *
 * Monaco 绑定刻意薄：桩 monaco / 桩 model 只提供行列夹取所需的两个方法，
 * 不引入真实 monaco-editor 运行时。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorCodeAction, EditorCodeActionContribution, LineDecoration } from '@kojo/plugin-api';
import {
  PROVIDED_CODE_ACTION_KINDS,
  QUICK_FIX_KIND,
  REFACTOR_KIND,
  actionDiagnostics,
  collectCodeActions,
  diagnosticKey,
  markersToDecorations,
  monacoActionKind,
  pickPreferred,
} from '../src/monaco/kojo-code-action';

/* -------------------------- 桩：monaco 与 model -------------------------- */

/** 只给 `decorationsToMarkers` 用到的那几个量（行数 + 行末列），越界夹取全靠它们 */
function stubModel(lines: readonly string[]): Monaco.editor.ITextModel {
  return {
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1] ?? '').length + 1,
  } as unknown as Monaco.editor.ITextModel;
}

const stubMonaco = {
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
} as unknown as typeof Monaco;

const COMMAND = 'kojo.codeAction.run';

/** 一个动作贡献（只填测试关心的那一个出口） */
function contribution(
  id: string,
  provideActions: EditorCodeActionContribution['provideActions'],
): EditorCodeActionContribution {
  return { id, provideActions };
}

const action = (over: Partial<EditorCodeAction> = {}): EditorCodeAction => ({
  title: '补上缺失的 ENDIF',
  kind: 'quickfix',
  run: () => undefined,
  ...over,
});

/** 收集用 sink：id 由贡献 id + 序号拼，markerData 走真实 `actionDiagnostics` */
function sinkFor(model: Monaco.editor.ITextModel) {
  let seq = 0;
  const registered: Array<[string, EditorCodeAction]> = [];
  return {
    registered,
    sink: {
      register: (contributionId: string, a: EditorCodeAction) => {
        registered.push([contributionId, a]);
        return `${contributionId}#${++seq}`;
      },
      markerDataFor: (a: EditorCodeAction) => actionDiagnostics(stubMonaco, model, a),
    },
  };
}

const REQUEST = {
  path: 'C:\\p\\事件.ERB',
  text: '@AEGI\nIF LOCAL\n\tPRINTL 甲',
  project: null,
  line: 2,
  lineCount: 3,
  diagnostics: [],
} as const;

/* ------------------------------- (a) 类别 ------------------------------- */

describe('PROVIDED_CODE_ACTION_KINDS · provider 的自我声明', () => {
  it('声明含 quickfix（`Ctrl+.` 是 only=quickfix 的显式请求，不声明就不调用本 provider）', () => {
    expect(PROVIDED_CODE_ACTION_KINDS).toContain(QUICK_FIX_KIND);
  });

  it('两类都声明：只报 quickfix 会让 💡 里的重构动作在"重构"请求下一起消失（回退）', () => {
    expect(PROVIDED_CODE_ACTION_KINDS).toEqual([QUICK_FIX_KIND, REFACTOR_KIND]);
  });

  it('契约窄联合 → Monaco kind 字符串：refactor 照译、quickfix 与缺省都落 quickfix', () => {
    expect(monacoActionKind('refactor')).toBe(REFACTOR_KIND);
    expect(monacoActionKind('quickfix')).toBe(QUICK_FIX_KIND);
    expect(monacoActionKind(undefined)).toBe(QUICK_FIX_KIND);
  });
});

/* ------------------------ (b) marker → 契约诊断 ------------------------ */

/** 一条已发布的 marker（`decorationsToMarkers` 的正向形状，这里手抄一份当输入） */
const marker = (over: Partial<Monaco.editor.IMarkerData> = {}): Monaco.editor.IMarkerData => ({
  severity: 8,
  message: '少一个 ENDIF',
  startLineNumber: 2,
  startColumn: 1,
  endLineNumber: 2,
  endColumn: 9,
  ...over,
});

describe('markersToDecorations · 递给贡献方的就是面上画着的那些', () => {
  it('severity 数字 → 契约的字面量档（error / warning / 其余按 info）', () => {
    const sev = markersToDecorations(stubMonaco, [
      marker({ severity: 8 }),
      marker({ severity: 4 }),
      marker({ severity: 2 }),
    ]).map((d) => d.severity);
    expect(sev).toEqual(['error', 'warning', 'info']);
  });

  it('`code` 原路取回（B9 之后诊断码住在 marker 的 `code` 字段，这是两处唯一对得上的键）', () => {
    const [withCode] = markersToDecorations(stubMonaco, [marker({ code: 'erb.unclosed-open' })]);
    expect(withCode).toMatchObject({ line: 2, code: 'erb.unclosed-open' });
    // `{ value, target }` 形态取 value（公开 API 允许链接码，不赌它永远是字符串）
    const [linked] = markersToDecorations(stubMonaco, [
      marker({ code: { value: 'sugar.expr-missing-else', target: {} as never } }),
    ]);
    expect(linked!.code).toBe('sugar.expr-missing-else');
    // 没码 ⇒ 省略该字段，而不是给 `code: undefined` 让贡献方误判"有码但对不上"
    const [noCode] = markersToDecorations(stubMonaco, [marker()]);
    expect('code' in noCode!).toBe(false);
  });

  it('列区间原样带上（诊断精确到列时贡献方看得见同一区间）', () => {
    const [d] = markersToDecorations(stubMonaco, [marker({ startColumn: 3, endColumn: 7 })]);
    expect(d).toMatchObject({ line: 2, startColumn: 3, endColumn: 7 });
  });

  it('跨行 marker 取起始行（`LineDecoration` 是行级契约，不假装它有两行）', () => {
    const [d] = markersToDecorations(stubMonaco, [marker({ startLineNumber: 4, endLineNumber: 8 })]);
    expect(d!.line).toBe(4);
  });

  it('空 markers ⇒ 空数组（这个区间没有红线，也就没有 quickfix 可给）', () => {
    expect(markersToDecorations(stubMonaco, [])).toEqual([]);
  });
});

/* ---------------------------- (c) 组装动作 ---------------------------- */

describe('collectCodeActions · 递给贡献方的请求', () => {
  it('诊断与位置/体量事实一并传入（贡献方按 code 应答，不必自己重算诊断）', () => {
    const seen: Parameters<EditorCodeActionContribution['provideActions']>[0][] = [];
    const model = stubModel(['@AEGI', 'IF LOCAL', '\tPRINTL 甲']);
    const { sink } = sinkFor(model);
    const diagnostics: LineDecoration[] = [
      { line: 2, severity: 'error', message: '少一个 ENDIF', code: 'erb.unclosed-open' },
    ];
    collectCodeActions(
      [
        contribution('probe', (file) => {
          seen.push(file);
          return [];
        }),
      ],
      { ...REQUEST, diagnostics },
      sink,
      COMMAND,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: REQUEST.path,
      text: REQUEST.text,
      line: 2,
      lineCount: 3,
      project: null,
      diagnostics: [{ line: 2, code: 'erb.unclosed-open', severity: 'error' }],
    });
  });

  it('宿主没给光标行时不硬塞 `line`（旧宿主口径零改动）', () => {
    const seen: Array<Record<string, unknown>> = [];
    const model = stubModel(['@A']);
    const { sink } = sinkFor(model);
    const { line: _line, ...withoutLine } = REQUEST;
    collectCodeActions(
      [
        contribution('probe', (file) => {
          seen.push(file as unknown as Record<string, unknown>);
          return [];
        }),
      ],
      withoutLine,
      sink,
      COMMAND,
    );
    expect('line' in seen[0]!).toBe(false);
  });

  it('单个贡献抛错不影响其余（隔离：不让 💡 整体消失），且抛错可见', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = stubModel(['@A', 'IF X']);
    const { sink } = sinkFor(model);
    const actions = collectCodeActions(
      [
        contribution('bad', () => {
          throw new Error('boom');
        }),
        contribution('good', () => [action({ title: '来自 good' })]),
      ],
      REQUEST,
      sink,
      COMMAND,
    );
    expect(actions.map((a) => a.title)).toEqual(['来自 good']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'bad' provideActions 抛错"));
    warn.mockRestore();
  });
});

describe('collectCodeActions · 翻成 Monaco 形状', () => {
  it('动作带关联诊断 ⇒ `diagnostics` 是翻译后的 marker（行列夹取与波浪线同一口径）', () => {
    const model = stubModel(['@AEGI', 'IF LOCAL', '\tPRINTL 甲']);
    const { sink, registered } = sinkFor(model);
    const diagnostic = { line: 2, severity: 'error' as const, message: '少一个 ENDIF', code: 'erb.unclosed-open' };
    const actions = collectCodeActions(
      [contribution('erb-structure-fix', () => [action({ diagnostics: [diagnostic] })])],
      { ...REQUEST, diagnostics: [diagnostic] },
      sink,
      COMMAND,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: '补上缺失的 ENDIF',
      kind: QUICK_FIX_KIND,
      command: { id: COMMAND, arguments: ['erb-structure-fix#1'] },
    });
    expect(actions[0]!.diagnostics).toEqual([
      {
        severity: 8,
        message: '少一个 ENDIF',
        code: 'erb.unclosed-open',
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 9,
      },
    ]);
    // 反查表里存的必须是**动作本体**（宿主执行时按 id 取回，不能只存标题）
    expect(registered).toEqual([['erb-structure-fix', expect.objectContaining({ title: '补上缺失的 ENDIF' })]]);
  });

  it('贡献方没给关联 ⇒ `diagnostics` 整个省略（不编空数组假装"关联了零条诊断"）', () => {
    const model = stubModel(['@A', 'IF X']);
    const { sink } = sinkFor(model);
    const [first] = collectCodeActions(
      [contribution('bare', () => [action(), action({ title: '带关联', diagnostics: [] })])],
      REQUEST,
      sink,
      COMMAND,
    );
    expect('diagnostics' in first!).toBe(false);
    expect(first!.kind).toBe(QUICK_FIX_KIND);
  });

  it('陈旧行号越界 ⇒ 夹到行内而不是丢掉动作（诊断是外部数据，不能让 💡 少一项）', () => {
    const model = stubModel(['@A', 'IF X']);
    const { sink } = sinkFor(model);
    const stale = { line: 99, severity: 'error' as const, message: '旧行号', code: 'erb.unclosed-open' };
    const [only] = collectCodeActions(
      [contribution('stale', () => [action({ diagnostics: [stale] })])],
      { ...REQUEST, diagnostics: [stale] },
      sink,
      COMMAND,
    );
    expect(only!.diagnostics![0]!.startLineNumber).toBe(2);
  });
});

describe('actionDiagnostics · 翻译器本体', () => {
  it('无关联 / 空关联一律 undefined', () => {
    const model = stubModel(['@A']);
    expect(actionDiagnostics(stubMonaco, model, action())).toBeUndefined();
    expect(actionDiagnostics(stubMonaco, model, action({ diagnostics: [] }))).toBeUndefined();
  });

  it('列区间原样带上（半开区间端点交给 decorationsToMarkers 夹取）', () => {
    const model = stubModel(['PRINTL 甲乙']);
    const out = actionDiagnostics(stubMonaco, model, action({
      diagnostics: [{ line: 1, severity: 'warning', message: '表达式', code: 'sugar.expr', startColumn: 2, endColumn: 4 }],
    }));
    expect(out).toEqual([
      {
        severity: 4,
        message: '表达式',
        code: 'sugar.expr',
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 4,
      },
    ]);
  });
});

/* -------------------------- (d) isPreferred -------------------------- */

describe('diagnosticKey · 一条诊断的身份', () => {
  it('列不参与判定（marker 往返补的默认列不许把同一条红线判成两条诊断）', () => {
    const bare: LineDecoration = { line: 2, severity: 'error', message: '少一个 ENDIF', code: 'erb.unclosed-open' };
    const withColumns: LineDecoration = { ...bare, startColumn: 1, endColumn: 9 };
    expect(diagnosticKey(bare)).toBe(diagnosticKey(withColumns));
  });

  it('码 / 消息 / 行 / 严重级任一不同就是不同诊断（不许宽到把两个问题并成一个唯一解）', () => {
    const base: LineDecoration = { line: 2, severity: 'error', message: '甲', code: 'a' };
    expect(diagnosticKey({ ...base, code: 'b' })).not.toBe(diagnosticKey(base));
    expect(diagnosticKey({ ...base, message: '乙' })).not.toBe(diagnosticKey(base));
    expect(diagnosticKey({ ...base, line: 3 })).not.toBe(diagnosticKey(base));
    expect(diagnosticKey({ ...base, severity: 'warning' })).not.toBe(diagnosticKey(base));
    expect(diagnosticKey({ line: 2, severity: 'error', message: '甲' })).not.toBe(diagnosticKey(base));
  });
});

describe('pickPreferred · 唯一解判据', () => {
  const d = (message: string): LineDecoration => ({ line: 2, severity: 'error', message });
  const fix = (diagnostics: LineDecoration[]) => ({ kind: QUICK_FIX_KIND, diagnostics });

  it('某条诊断只有一条快速修复认领 ⇒ 它的下标入选', () => {
    const one = d('甲');
    expect(pickPreferred([fix([one])], [one])).toEqual(new Set([0]));
  });

  it('同一诊断两条认领 ⇒ 谁都不入选（多解时不替作者选）', () => {
    const one = d('甲');
    expect(pickPreferred([fix([one]), fix([one])], [one])).toEqual(new Set());
  });

  it('认领的诊断不在本次请求里 ⇒ 不算这次请求的唯一解（不猜）', () => {
    expect(pickPreferred([fix([d('别处的红线')])], [d('甲')])).toEqual(new Set());
  });

  it('一条动作认领多条时要求每条都唯一：另有一条红线存在第二个解 ⇒ 整条不入选', () => {
    const first = d('甲');
    const second = d('乙');
    expect(pickPreferred([fix([first, second]), fix([second])], [first, second])).toEqual(new Set());
  });

  it('两条动作各修各的红线 ⇒ 各自都是自己那条的唯一解', () => {
    const first = d('甲');
    const second = d('乙');
    expect(pickPreferred([fix([first]), fix([second])], [first, second])).toEqual(new Set([0, 1]));
  });

  it('同一动作把同一条诊断列两遍 ⇒ 仍算一次认领（不自相冲突）', () => {
    const one = d('甲');
    expect(pickPreferred([fix([one, one])], [one])).toEqual(new Set([0]));
  });

  it('面上同一条诊断画成两条重叠 marker ⇒ 仍只有一个解', () => {
    const one = d('甲');
    expect(pickPreferred([fix([one])], [one, { ...one, line: 2 }])).toEqual(new Set([0]));
  });

  it('refactor 类即便唯一也不是"这条红线的解" ⇒ 一律不入选', () => {
    const one = d('甲');
    expect(pickPreferred([{ kind: REFACTOR_KIND, diagnostics: [one] }], [one])).toEqual(new Set());
  });

  it('没声明关联的动作不参与（无关联 = 不是冲着诊断来的）', () => {
    expect(pickPreferred([fix([])], [d('甲')])).toEqual(new Set());
  });
});

describe('collectCodeActions · isPreferred 落地（R2）', () => {
  const model = stubModel(['@AEGI', 'IF LOCAL', '\tPRINTL 甲']);
  const unclosed: LineDecoration = { line: 2, severity: 'error', message: '少一个 ENDIF', code: 'erb.unclosed-open' };
  const missingElse: LineDecoration = {
    line: 2,
    severity: 'warning',
    message: '表达式缺 ELSE 分支',
    code: 'sugar.expr-missing-else',
  };

  /** 一次收集：`requested` = 面上画着的诊断，`providers[i]` 产一条动作并声明它修哪些 */
  function collect(
    requested: LineDecoration[],
    providers: readonly (readonly LineDecoration[])[],
  ): Monaco.languages.CodeAction[] {
    const { sink } = sinkFor(model);
    return collectCodeActions(
      providers.map((diagnostics, i) =>
        contribution(`p${i}`, () => [action({ title: `修复 ${i}`, diagnostics: [...diagnostics] })]),
      ),
      { ...REQUEST, diagnostics: requested },
      sink,
      COMMAND,
    );
  }

  it('钉死：同一条诊断两条候选 ⇒ 两条都不带 isPreferred（不写 false，只省略）', () => {
    const actions = collect([unclosed], [[unclosed], [unclosed]]);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => !('isPreferred' in a))).toBe(true);
  });

  it('钉死：同一条诊断恰好一条候选 ⇒ 该条 isPreferred: true（Ctrl+. 直接命中）', () => {
    const actions = collect([unclosed], [[unclosed]]);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.isPreferred).toBe(true);
  });

  it('两条候选各修一条不同红线 ⇒ 两条都 preferred（各自都是唯一解）', () => {
    const actions = collect([unclosed, missingElse], [[unclosed], [missingElse]]);
    expect(actions.map((a) => a.isPreferred)).toEqual([true, true]);
  });

  it('缺省 kind（契约省略）按 quickfix 参与判定 —— 与 monacoActionKind 同一口径', () => {
    const { sink } = sinkFor(model);
    const [only] = collectCodeActions(
      [contribution('bare-kind', () => [action({ diagnostics: [unclosed] })])],
      { ...REQUEST, diagnostics: [unclosed] },
      sink,
      COMMAND,
    );
    expect(only!.kind).toBe(QUICK_FIX_KIND);
    expect(only!.isPreferred).toBe(true);
  });

  it('动作修的是别处诊断（本次请求没画它）⇒ 不 preferred', () => {
    const actions = collect([unclosed], [[missingElse]]);
    expect('isPreferred' in actions[0]!).toBe(false);
  });

  it('无关联动作与 preferred 判定互不干扰（不给关联就是没有）', () => {
    const { sink } = sinkFor(model);
    const actions = collectCodeActions(
      [contribution('mix', () => [action(), action({ title: '带关联', diagnostics: [unclosed] })])],
      { ...REQUEST, diagnostics: [unclosed] },
      sink,
      COMMAND,
    );
    expect('isPreferred' in actions[0]!).toBe(false);
    expect(actions[1]!.isPreferred).toBe(true);
  });
});
