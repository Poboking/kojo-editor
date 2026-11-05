/**
 * 回放面板纯逻辑单测（v0.2 第八批；零 React）。
 *
 * 覆盖：调用上下文文本解析（数值槽 / 字符串槽 / 重复 / 非法语法 / 空输入），
 * ReplayCallContext 组装（空槽位表 → undefined），未知原因分组，函数名提示，
 * 假设值链路（v1.0 收口 C9：槽位来源三态 / 假设计数 / AST 槽位引用扫描），
 * 以及场景预设（v1.0 收口线一：序列化容错 / 采集 / 应用与合并冲突 / 建议名 / 槽位↔文本）。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionPredicate, FunctionReplay, KojoCallSlot, ReplayValue, VariableRef } from '@kojo/plugin-api';
import {
  DEFAULT_SCENE_ID,
  MAX_SCENES,
  MAX_SLOT_CANDIDATES,
  PRED_WINDOW_INITIAL,
  PRED_WINDOW_STEP,
  REF_SLOT_LABEL,
  TR_WINDOW,
  argSlotCandidates,
  assembleCallContext,
  nextTrWindow,
  trWindowSize,
  applyScene,
  captureSceneSlots,
  classifySlotValue,
  collectAssumedSlots,
  contextTextToSceneSlots,
  defaultScene,
  defaultSlotText,
  exprArgSlots,
  groupUnknowns,
  mergeSlotInputs,
  newSceneId,
  nextPredWindow,
  parseCallContextText,
  predWindowSize,
  removeScene,
  sanitizeScenes,
  sceneSlotsToContextText,
  sceneSuggestionName,
  slotKey,
  slotPlaceholder,
  suggestFunctions,
  summarizeAssumptions,
  toCallContext,
  upsertSceneByName,
} from '../src/panel-logic';
import type { ReplayScene, SceneSlotValue } from '../src/panel-logic';
import {
  UNMODELED_WRITE_LIMIT,
  chooseReplayText,
  mergeSlotCandidates,
  summarizeUnmodeledWrites,
  textSourceLabel,
} from '../src/preview';

describe('parseCallContextText', () => {
  it('数值槽（逗号/空格分隔；缺省槽位保持 undefined）', () => {
    const r = parseCallContextText('0=36, 1=15');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ints).toEqual([36, 15]);
      expect(r.strs).toEqual([]);
    }
  });

  it('乱序槽位 + 中间空洞补 undefined', () => {
    const r = parseCallContextText('2=7, 0=1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ints).toEqual([1, undefined, 7]);
  });

  it('带引号值 → ARGS 字符串槽', () => {
    const r = parseCallContextText('1="约会", 0=36');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ints).toEqual([36]);
      expect(r.strs).toEqual([undefined, '约会']);
    }
  });

  it('负数与中文逗号', () => {
    const r = parseCallContextText('0=-5，1=3');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ints).toEqual([-5, 3]);
  });

  it('空输入 → 空槽位表（= 未提供上下文）', () => {
    const r = parseCallContextText('  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ints).toEqual([]);
      expect(r.strs).toEqual([]);
      expect(toCallContext(r)).toBeUndefined();
    }
  });

  it('非法语法 / 非法槽位 / 非法值 / 重复槽位', () => {
    expect(parseCallContextText('36')).toMatchObject({ ok: false, error: 'bad-syntax' });
    expect(parseCallContextText('x=36')).toMatchObject({ ok: false, error: 'bad-syntax' });
    expect(parseCallContextText('1000=36')).toMatchObject({ ok: false, error: 'bad-slot' });
    expect(parseCallContextText('0=abc')).toMatchObject({ ok: false, error: 'bad-value' });
    expect(parseCallContextText('0=36, 0=15')).toMatchObject({ ok: false, error: 'dup-slot' });
    expect(parseCallContextText('1="a", 1="b"')).toMatchObject({ ok: false, error: 'dup-slot' });
  });
});

describe('toCallContext', () => {
  it('有值 → 对象；全 undefined → undefined', () => {
    expect(toCallContext({ ok: true, ints: [36], strs: [] })).toEqual({ ints: [36] });
    expect(toCallContext({ ok: true, ints: [], strs: ['x'] })).toEqual({ strs: ['x'] });
    expect(toCallContext({ ok: true, ints: [], strs: [] })).toBeUndefined();
    expect(toCallContext({ ok: true, ints: [undefined], strs: [] })).toBeUndefined();
  });
});

describe('groupUnknowns', () => {
  it('按数量降序分组；无未知 → 空数组', () => {
    const mk = (outcomes: ('true' | 'false' | 'unknown')[], codes: string[] = []): FunctionReplay =>
      ({
        normalizedName: 'F',
        filePath: 'a.erb',
        startLine: 1,
        stats: { total: outcomes.length, hit: 0, miss: 0, unknown: 0 },
        confidence: 'partial',
        predicates: outcomes.map((o, i) => ({
          kind: 'IF' as const,
          text: `p${i}`,
          line: i + 2,
          expr: { kind: 'opaque', text: 'x' },
          outcome:
            o === 'unknown'
              ? { kind: 'unknown', unknown: { code: codes[i] as never, message: '' } }
              : o === 'true'
                ? ({ kind: 'true' } as const)
                : ({ kind: 'false' } as const),
        })),
      }) as FunctionReplay;

    const g = groupUnknowns(mk(['unknown', 'true', 'unknown', 'unknown'], ['pseudo', '', 'call', 'pseudo']));
    expect(g).toEqual([
      { code: 'pseudo', count: 2 },
      { code: 'call', count: 1 },
    ]);
    expect(groupUnknowns(mk(['true', 'false']))).toEqual([]);
  });
});

describe('suggestFunctions', () => {
  const names = ['M_KOJO_ORTHODOX_EVENT_K49_1', 'M_KOJO_K49_事件', 'M_KOJO_K50_X', 'LOCAL_CHECK'];
  it('子串过滤（大小写不敏感）+ 上限', () => {
    expect(suggestFunctions(names, 'K49')).toEqual(['M_KOJO_ORTHODOX_EVENT_K49_1', 'M_KOJO_K49_事件']);
    expect(suggestFunctions(names, 'k49')).toEqual(['M_KOJO_ORTHODOX_EVENT_K49_1', 'M_KOJO_K49_事件']);
  });
  it('短查询 / 无匹配 → 空', () => {
    expect(suggestFunctions(names, 'K')).toEqual([]);
    expect(suggestFunctions(names, '')).toEqual([]);
    expect(suggestFunctions(names, 'ZZZZ')).toEqual([]);
  });
  it('limit 截断', () => {
    const many = Array.from({ length: 80 }, (_, i) => `FN_A_${i}`);
    expect(suggestFunctions(many, 'FN_A', 50)).toHaveLength(50);
  });
});

/* ------------------------- 假设值链路（v1.0 收口 C9） ------------------------- */

describe('slotKey / defaultSlotText / classifySlotValue', () => {
  it('slotKey 区分 int 与 str 同号槽（签名可同时含 ARG:0 与 ARGS:0）', () => {
    expect(slotKey('int', 0)).toBe('int:0');
    expect(slotKey('str', 0)).toBe('str:0');
    expect(slotKey('int', 0)).not.toBe(slotKey('str', 0));
  });

  it('P1 口径：默认值一律空（面板不再替作者预填注入 0）', () => {
    // 口径变化（2026-11-05）：旧断言是 int='0'。那个 0 会被 `assembleCallContext`
    // 真的注给引擎 ⇒ 引擎按 0 判出"确定的假"，而 API 路径同谓词是 unknown。
    expect(defaultSlotText('int')).toBe('');
    expect(defaultSlotText('str')).toBe('');
  });

  it('slotPlaceholder：值恒空，只在 assumeDefaults 时提示「0（假设）」', () => {
    expect(slotPlaceholder('int', false)).toBe('');
    expect(slotPlaceholder('int', true)).toBe('0（假设）');
    expect(slotPlaceholder('str', true)).toBe('');
  });

  it('来源三态（P1）：填了 = manual；空 + 显式按 0 试算 + 未手改 = assumption；空 = unset', () => {
    expect(classifySlotValue('int', '36', false)).toBe('manual');
    expect(classifySlotValue('int', '0', true)).toBe('manual'); // 作者显式写 0 是确定值
    expect(classifySlotValue('int', '', false)).toBe('unset'); // 默认关闭试算 → 不猜
    // 只有"空 + 开关 + 未手改"才是假设
    expect(classifySlotValue('int', '', false, true)).toBe('assumption');
    expect(classifySlotValue('int', '   ', false, true)).toBe('assumption'); // 容忍空白
    expect(classifySlotValue('int', '', true, true)).toBe('unset'); // 手改后又清空 = 作者说"不知道"
    expect(classifySlotValue('str', '', false, true)).toBe('unset'); // 字符串槽永不按 0 补
    expect(classifySlotValue('str', '约会', false)).toBe('manual');
  });
});

describe('collectAssumedSlots（P1：只有显式开「按 0 试算」才可能有假设）', () => {
  const slots = [
    { kind: 'int' as const, index: 0 },
    { kind: 'int' as const, index: 1 },
    { kind: 'str' as const, index: 0 },
  ];

  it('全留空 + 开关打开 → 全部数值槽计入假设；str 槽不算', () => {
    const texts = { 'int:0': '', 'int:1': '', 'str:0': '' };
    expect(collectAssumedSlots(slots, texts, {}, true)).toEqual([
      { kind: 'int', index: 0 },
      { kind: 'int', index: 1 },
    ]);
  });

  it('全留空 + 开关关闭 → 无假设（旧口径下这里会报两个假设）', () => {
    expect(collectAssumedSlots(slots, { 'int:0': '', 'int:1': '', 'str:0': '' }, {})).toEqual([]);
  });

  it('全手输 → 无假设（开关开着也不算：作者给了确定值）', () => {
    const texts = { 'int:0': '36', 'int:1': '15', 'str:0': '约会' };
    const edited = { 'int:0': true, 'int:1': true, 'str:0': true };
    expect(collectAssumedSlots(slots, texts, edited, true)).toEqual([]);
  });

  it('混合 → 只计留空且未手改的数值槽', () => {
    const texts = { 'int:0': '36', 'int:1': '', 'str:0': '' };
    const edited = { 'int:0': true };
    expect(collectAssumedSlots(slots, texts, edited, true)).toEqual([{ kind: 'int', index: 1 }]);
  });

  it('手改后又清空 → 作者明确说"不知道"，不算假设', () => {
    const texts = { 'int:0': '', 'int:1': '', 'str:0': '' };
    expect(collectAssumedSlots(slots, texts, { 'int:0': true }, true)).toEqual([{ kind: 'int', index: 1 }]);
  });
});

/* ------------------ 槽位输入并集（P2） / 调用上下文组装（P1） ------------------ */

describe('mergeSlotInputs（路由模板槽 ∪ 函数体引用槽）', () => {
  const template: KojoCallSlot[] = [
    { kind: 'str', index: 0, label: '对话对象' },
    { kind: 'int', index: 0, label: '事件子参数' },
  ];

  it('模板槽在前（label 用模板的），引用独有的槽补在后面', () => {
    const merged = mergeSlotInputs(template, { ints: [3], strs: [1] });
    expect(merged).toEqual([
      { kind: 'str', index: 0, label: '对话对象', fromTemplate: true },
      { kind: 'int', index: 0, label: '事件子参数', fromTemplate: true },
      { kind: 'int', index: 3, label: REF_SLOT_LABEL, fromTemplate: false },
      { kind: 'str', index: 1, label: REF_SLOT_LABEL, fromTemplate: false },
    ]);
  });

  it('同 kind+index 去重：模板已转发的槽不重复出现（模板 label 保留）', () => {
    const merged = mergeSlotInputs(template, { ints: [0, 0, 3], strs: [0] });
    expect(merged.map((s) => `${s.kind}:${s.index}`)).toEqual(['str:0', 'int:0', 'int:3']);
    expect(merged.find((s) => s.kind === 'int' && s.index === 0)?.label).toBe('事件子参数');
  });

  it('引用独有槽按 kind 分组、槽号升序（int 先，str 后）——渲染顺序稳定，不随 AST 扫描序漂', () => {
    const merged = mergeSlotInputs([], { ints: [5, 1, 3], strs: [2, 0] });
    expect(merged.map((s) => `${s.kind}:${s.index}`)).toEqual(['int:1', 'int:3', 'int:5', 'str:0', 'str:2']);
  });

  it('并集为空（模板空 + 无引用）→ 空数组（面板据此渲染裸上下文文本框）', () => {
    expect(mergeSlotInputs([], { ints: [], strs: [] })).toEqual([]);
    expect(mergeSlotInputs([], { ints: [], strs: [] })).toHaveLength(0);
  });

  it('int / str 同号槽互不吞（ARG:1 与 ARGS:1 是两格）', () => {
    const merged = mergeSlotInputs([], { ints: [1], strs: [1] });
    expect(merged).toHaveLength(2);
    expect(merged.every((s) => s.index === 1)).toBe(true);
  });
});

describe('assembleCallContext（P1：不再偷注 0）', () => {
  const inputs = [
    { kind: 'int' as const, index: 0, label: '事件子参数', fromTemplate: true },
    { kind: 'int' as const, index: 1, label: '日期偏移', fromTemplate: true },
    { kind: 'str' as const, index: 0, label: '对话对象', fromTemplate: true },
  ];
  const base = { slotInputs: inputs, slotEdited: {}, contextText: '' };

  it('全留空 + assumeDefaults 关闭 → callContext: undefined（让引擎走推导器 / 判 unknown）', () => {
    const r = assembleCallContext({ ...base, slotTexts: {}, assumeDefaults: false });
    expect(r.error).toBeNull();
    expect(r.callContext).toBeUndefined();
  });

  it('全留空 + assumeDefaults 打开 → 数值槽按 0 写入，str 槽不进 strs', () => {
    const r = assembleCallContext({ ...base, slotTexts: {}, assumeDefaults: true });
    expect(r.error).toBeNull();
    expect(r.callContext).toEqual({ ints: [0, 0] });
    expect(r.callContext?.strs).toBeUndefined();
  });

  it('手填值 → manual 写进 callContext（假设开关不再影响已填槽）', () => {
    const r = assembleCallContext({
      ...base,
      slotTexts: { 'int:0': '36', 'str:0': '觉' },
      slotEdited: { 'int:0': true, 'str:0': true },
      assumeDefaults: true,
    });
    expect(r.error).toBeNull();
    expect(r.callContext).toEqual({ ints: [36, 0], strs: ['觉'] }); // int:1 留空 → 假设 0
  });

  it('手改后又清空 + assumeDefaults 打开 → 不补 0（作者明确说不知道）', () => {
    const r = assembleCallContext({
      ...base,
      slotTexts: { 'int:0': '', 'int:1': '' },
      slotEdited: { 'int:0': true },
      assumeDefaults: true,
    });
    expect(r.error).toBeNull();
    expect(r.callContext).toEqual({ ints: [undefined, 0] });
  });

  it('str 槽空 → 不进 strs（只有 int 槽有值时就只给 ints）', () => {
    const r = assembleCallContext({
      ...base,
      slotTexts: { 'int:0': '7' },
      slotEdited: { 'int:0': true },
      assumeDefaults: false,
    });
    expect(r.callContext).toEqual({ ints: [7] });
  });

  it('E1 对接口径：assumeDefaults 关时只填部分槽 → 没填的位置是空洞（undefined），不当成 0', () => {
    // 引擎 `mergeCallContext`（state-replay locals.ts）逐槽合并：显式非 undefined 胜、
    // 洞由推导器补。所以这里绝不能把没填的格子填成 0 —— 那会盖掉"发言者槽 = 角色号"
    // 这类推导确定值。空洞是"未提供"，不是"值 0"。
    const r = assembleCallContext({
      ...base,
      slotTexts: { 'int:1': '7' },
      slotEdited: { 'int:1': true },
      assumeDefaults: false,
    });
    expect(r.callContext).toEqual({ ints: [undefined, 7] });
    expect(r.callContext?.ints?.[0]).toBeUndefined(); // 0 不等于 undefined（0 是真实实参）
    expect(r.callContext?.strs).toBeUndefined(); // 一个 str 槽都没填 → 整个 strs 省略
  });

  it('非整数数值槽 → 显式错误（不发起回放，不静默）', () => {
    const r = assembleCallContext({
      ...base,
      slotTexts: { 'int:0': 'abc' },
      slotEdited: { 'int:0': true },
      assumeDefaults: false,
    });
    expect(r.callContext).toBeUndefined();
    expect(r.error).toContain('必须是整数');
    expect(r.error).toContain('事件子参数');
  });

  it('并集为空 → 退回裸上下文文本（解析结果原样转 callContext）', () => {
    const r = assembleCallContext({
      slotInputs: [],
      slotTexts: {},
      slotEdited: {},
      assumeDefaults: false,
      contextText: '0=36, 1="觉"',
    });
    expect(r.error).toBeNull();
    expect(r.callContext).toEqual({ ints: [36], strs: [undefined, '觉'] });
  });

  it('并集为空 + 空文本 → undefined；非法文本 → 显式错误', () => {
    const empty = assembleCallContext({
      slotInputs: [],
      slotTexts: {},
      slotEdited: {},
      assumeDefaults: false,
      contextText: '',
    });
    expect(empty).toEqual({ callContext: undefined, error: null });
    const bad = assembleCallContext({
      slotInputs: [],
      slotTexts: {},
      slotEdited: {},
      assumeDefaults: false,
      contextText: 'nonsense',
    });
    expect(bad.callContext).toBeUndefined();
    expect(bad.error).toContain('无法解析');
  });
});

/* ------------------------- 槽位候选值（P3） ------------------------- */

/** 造一条谓词明细（只关心 expr / kind，其余字段给最小值） */
function pred(expr: ConditionExpr, kind: FunctionPredicate['kind'] = 'IF'): FunctionPredicate {
  return { kind, text: '(test)', expr, line: 1, depth: 0 };
}

describe('argSlotCandidates（从谓词 AST 里捡候选值）', () => {
  it('数值比较：ARG == 字面量 收集数字；两侧都认（字面量在左也行）', () => {
    const preds = [
      pred({
        kind: 'binary',
        op: '==',
        left: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' },
        right: { kind: 'literal', value: 36, text: '36' },
      }),
      pred({
        kind: 'binary',
        op: '>=',
        left: { kind: 'literal', value: 12, text: '12' },
        right: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' },
      }),
    ];
    const cands = argSlotCandidates(preds);
    expect(cands.get('int:0')).toEqual(['36', '12']);
  });

  it('字符串比较：字面量取解码后的值（去引号）', () => {
    const preds = [
      pred({
        kind: 'binary',
        op: '!=',
        left: { kind: 'ref', name: 'ARGS', indices: ['1'], text: 'ARGS:1' },
        right: { kind: 'literal', value: '约会', text: '"约会"' },
      }),
    ];
    expect(argSlotCandidates(preds).get('str:1')).toEqual(['约会']);
  });

  it('CASE 展开形（subject == 值）天然是 binary → 逐个收集', () => {
    const preds = [
      pred({
        kind: 'binary',
        op: '==',
        left: { kind: 'ref', name: 'ARG', indices: [], text: 'ARG' }, // 裸 ARG ≡ ARG:0
        right: { kind: 'literal', value: 1, text: '1' },
      }, 'CASE'),
      pred({
        kind: 'binary',
        op: '==',
        left: { kind: 'ref', name: 'ARG', indices: [], text: 'ARG' },
        right: { kind: 'literal', value: 2, text: '2' },
      }, 'CASE'),
    ];
    expect(argSlotCandidates(preds).get('int:0')).toEqual(['1', '2']);
  });

  it('递归进 ternary / call 参数 / unary（&& 连接的两条都算）', () => {
    const preds = [
      pred({
        kind: 'binary',
        op: '&&',
        left: {
          kind: 'ternary',
          cond: {
            kind: 'binary',
            op: '<',
            left: { kind: 'ref', name: 'ARG', indices: ['2'], text: 'ARG:2' },
            right: { kind: 'literal', value: 5, text: '5' },
          },
          then: { kind: 'literal', value: 1, text: '1' },
          else: { kind: 'literal', value: 0, text: '0' },
        },
        right: {
          kind: 'unary',
          op: '!',
          operand: {
            kind: 'call',
            name: 'GETBIT',
            args: [
              {
                kind: 'binary',
                op: '==',
                left: { kind: 'ref', name: 'ARGS', indices: ['0'], text: 'ARGS:0' },
                right: { kind: 'literal', value: '觉', text: '"觉"' },
              },
            ],
          },
        },
      }),
    ];
    const cands = argSlotCandidates(preds);
    expect(cands.get('int:2')).toEqual(['5']);
    expect(cands.get('str:0')).toEqual(['觉']);
  });

  it('去重按首次出现序；每槽上限 MAX_SLOT_CANDIDATES', () => {
    const dup = [
      pred({ kind: 'binary', op: '==', left: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' }, right: { kind: 'literal', value: 3, text: '3' } }),
      pred({ kind: 'binary', op: '==', left: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' }, right: { kind: 'literal', value: 3, text: '3' } }),
      pred({ kind: 'binary', op: '==', left: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' }, right: { kind: 'literal', value: 4, text: '4' } }),
    ];
    expect(argSlotCandidates(dup).get('int:0')).toEqual(['3', '4']);

    const many = Array.from({ length: MAX_SLOT_CANDIDATES + 5 }, (_, i) =>
      pred({ kind: 'binary', op: '==', left: { kind: 'ref', name: 'ARG', indices: ['1'], text: 'ARG:1' }, right: { kind: 'literal', value: i, text: String(i) } }),
    );
    expect(argSlotCandidates(many).get('int:1')).toHaveLength(MAX_SLOT_CANDIDATES);
  });

  it('无候选：非比较运算 / 槽对槽 / 动态下标 / opaque 都不猜', () => {
    const preds = [
      pred({ kind: 'binary', op: '+', left: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' }, right: { kind: 'literal', value: 1, text: '1' } }),
      // 槽 vs 槽：都不是字面量
      pred({
        kind: 'binary',
        op: '==',
        left: { kind: 'ref', name: 'ARG', indices: ['0'], text: 'ARG:0' },
        right: { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' },
      }),
      // 动态下标：无法静态归因
      pred({
        kind: 'binary',
        op: '==',
        left: { kind: 'ref', name: 'ARG', indices: ['ARG:0'], text: 'ARG:ARG:0' },
        right: { kind: 'literal', value: 9, text: '9' },
      }),
      pred({ kind: 'opaque', text: '???' }),
    ];
    const cands = argSlotCandidates(preds);
    expect(cands.size).toBe(0);
    expect(argSlotCandidates([]).size).toBe(0);
  });
});

describe('exprArgSlots（AST 槽位引用扫描）', () => {
  const ref = (name: string, indices: string[] = []): ConditionExpr => ({ kind: 'ref', name, indices, text: name });

  it('裸 ARG ≡ ARG:0；ARG:n / ARGS:n 归类', () => {
    const e: ConditionExpr = { kind: 'binary', op: '&&', left: ref('ARG'), right: ref('ARGS', ['2']) };
    expect(exprArgSlots(e)).toEqual({ ints: [0], strs: [2] });
  });

  it('递归进 call 参数 / 一元 / 三元', () => {
    const e: ConditionExpr = {
      kind: 'call',
      name: 'GETBIT',
      args: [
        { kind: 'binary', op: '+', left: ref('ARG', ['1']), right: { kind: 'literal', value: 1, text: '1' } },
        { kind: 'ternary', cond: ref('ARG', ['2']), then: ref('ARGS', ['0']), else: { kind: 'opaque', text: 'x' } },
      ],
    };
    expect(exprArgSlots(e)).toEqual({ ints: [1, 2], strs: [0] });
  });

  it('非 ARG 引用 / 动态索引 / opaque 不计（不猜）', () => {
    expect(exprArgSlots(ref('CFLAG', ['2']))).toEqual({ ints: [], strs: [] });
    expect(exprArgSlots(ref('ARG', ['ARG']))).toEqual({ ints: [], strs: [] });
    expect(exprArgSlots({ kind: 'opaque', text: 'ARG == 1' })).toEqual({ ints: [], strs: [] });
  });
});

describe('summarizeAssumptions（基于假设标注 + 假设计数）', () => {
  const mkReplay = (exprs: ConditionExpr[]): FunctionReplay =>
    ({
      normalizedName: 'F',
      filePath: 'a.erb',
      startLine: 1,
      branches: [],
      stats: { total: exprs.length, hit: 0, miss: 0, unknown: 0 },
      confidence: 'exact',
      predicates: exprs.map((expr, i) => ({
        kind: 'IF' as const,
        text: `p${i}`,
        line: i + 2,
        expr,
        outcome: { kind: 'true' } as const,
      })),
    }) as FunctionReplay;

  const arg0: ConditionExpr = { kind: 'ref', name: 'ARG', indices: [], text: 'ARG' };
  const cflag: ConditionExpr = { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' };

  it('无假设槽 → 全 false / 空 consumed', () => {
    const r = summarizeAssumptions(mkReplay([arg0]), []);
    expect(r.affected).toEqual([false]);
    expect(r.consumed).toEqual([]);
  });

  it('命中假设槽的谓词被标注 + 消费计数去重', () => {
    const r = summarizeAssumptions(mkReplay([arg0, cflag, arg0]), [{ kind: 'int', index: 0 }]);
    expect(r.affected).toEqual([true, false, true]);
    expect(r.consumed).toEqual([{ kind: 'int', index: 0 }]);
  });

  it('假设槽未被任何谓词读取 → consumed 为空（不影响可信度）', () => {
    const r = summarizeAssumptions(mkReplay([cflag]), [{ kind: 'int', index: 0 }]);
    expect(r.affected).toEqual([false]);
    expect(r.consumed).toEqual([]);
  });

  it('int / str 槽不串味（ARG:1 假设不命中 ARGS:1 引用）', () => {
    const args1: ConditionExpr = { kind: 'ref', name: 'ARGS', indices: ['1'], text: 'ARGS:1' };
    const r = summarizeAssumptions(mkReplay([args1]), [{ kind: 'int', index: 1 }]);
    expect(r.affected).toEqual([false]);
    expect(r.consumed).toEqual([]);
  });
});

/* ------------------- 场景预设（v1.0 收口线一：调用上下文可保存复用） ------------------- */

const man = (value: string): SceneSlotValue => ({ value, kind: 'manual' });

describe('sanitizeScenes（存储反序列化容错）', () => {
  it('非数组 / null → 空；合法项原样保留（JSON round-trip）', () => {
    expect(sanitizeScenes(undefined)).toEqual([]);
    expect(sanitizeScenes(null)).toEqual([]);
    expect(sanitizeScenes({ foo: 1 })).toEqual([]);
    const scene: ReplayScene = { id: 'scene-a', name: '约会', slots: { 'int:0': man('36'), 'str:1': man('觉') } };
    const raw = JSON.parse(JSON.stringify([scene])) as unknown;
    expect(sanitizeScenes(raw)).toEqual([scene]);
  });

  it('丢弃非法项：缺 id / 缺 name / 内置 id / 重复 id / 非法槽位键 / 非 manual / 空值', () => {
    const raw = [
      { id: '', name: 'n', slots: {} },
      { id: 'a', name: '   ', slots: {} },
      { id: DEFAULT_SCENE_ID, name: '默认', slots: {} },
      { id: 'a', name: 'A', slots: { 'int:0': man('1') } },
      { id: 'a', name: 'A2', slots: { 'int:0': man('2') } }, // 重复 id → 丢
      { id: 'b', name: 'B', slots: { 'int:x': man('1'), 'ARG:0': man('1'), 'int:0': { value: '1', kind: 'auto' } } },
      { id: 'c', name: 'C', slots: { 'int:0': man('   '), 'str:0': man('ok') } },
      'not-an-object',
    ];
    const out = sanitizeScenes(raw);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]!.slots).toEqual({ 'int:0': man('1') }); // 首个同 id 胜出
    expect(out[1]!.slots).toEqual({}); // 非法键 / 非 manual 全丢
    expect(out[2]!.slots).toEqual({ 'str:0': man('ok') }); // 空白值丢
  });

  it('名字去空白 + 截断；数量上限截断', () => {
    expect(sanitizeScenes([{ id: 'a', name: '  约会  ', slots: {} }])[0]!.name).toBe('约会');
    const many = Array.from({ length: MAX_SCENES + 5 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, slots: {} }));
    expect(sanitizeScenes(many)).toHaveLength(MAX_SCENES);
  });
});

describe('captureSceneSlots（采集当前输入）', () => {
  const slots = [
    { kind: 'int' as const, index: 0 },
    { kind: 'int' as const, index: 1 },
    { kind: 'str' as const, index: 0 },
  ];
  it('仅收非空值；来源恒 manual', () => {
    expect(captureSceneSlots(slots, { 'int:0': '36', 'int:1': '0', 'str:0': '' })).toEqual({
      'int:0': man('36'),
      'int:1': man('0'),
    });
    expect(captureSceneSlots(slots, { 'int:0': '  ', 'str:0': '觉' })).toEqual({ 'str:0': man('觉') });
    expect(captureSceneSlots(slots, {})).toEqual({});
  });
});

describe('applyScene（应用与合并冲突）', () => {
  const slots = [
    { kind: 'int' as const, index: 0 },
    { kind: 'int' as const, index: 1 },
    { kind: 'str' as const, index: 0 },
  ];
  const scene: ReplayScene = { id: 'scene-a', name: '约会', slots: { 'int:0': man('36'), 'str:0': man('觉') } };

  it('场景覆盖的槽 → manual（edited=true）；未覆盖 → 空（unset，P1 不再预填 0）', () => {
    const app = applyScene(scene, slots);
    expect(app.texts).toEqual({ 'int:0': '36', 'int:1': '', 'str:0': '觉' });
    expect(app.edited).toEqual({ 'int:0': true, 'int:1': false, 'str:0': true });
    expect(app.applied).toEqual(['int:0', 'str:0']);
    expect(app.dropped).toEqual([]);
    expect(app.reset).toEqual([]);
  });

  it('场景里签名没有的槽 → dropped；已填却未覆盖 → reset（清回空）', () => {
    const narrow = [{ kind: 'int' as const, index: 0 }];
    const app = applyScene(scene, narrow, { 'int:0': '1' });
    expect(app.dropped).toEqual(['str:0']); // 场景的 str:0 不在签名内（协议/家族不同）
    expect(app.texts).toEqual({ 'int:0': '36' });
    const app2 = applyScene({ id: 'x', name: 'x', slots: {} }, slots, { 'int:1': '7', 'str:0': '' });
    expect(app2.reset).toEqual(['int:1']);
    expect(app2.texts).toEqual({ 'int:0': '', 'int:1': '', 'str:0': '' });
  });

  it('内置默认场景（无槽）→ 全部清回空', () => {
    const app = applyScene(defaultScene(), slots, { 'int:0': '9' });
    expect(app.texts).toEqual({ 'int:0': '', 'int:1': '', 'str:0': '' });
    expect(app.edited).toEqual({ 'int:0': false, 'int:1': false, 'str:0': false });
    expect(app.applied).toEqual([]);
    expect(app.reset).toEqual(['int:0']);
  });

  it('int / str 同号槽不串味', () => {
    const sameIdx = [
      { kind: 'str' as const, index: 0 },
      { kind: 'int' as const, index: 0 },
    ];
    const s: ReplayScene = { id: 'x', name: 'x', slots: { 'str:0': man('约会') } };
    const app = applyScene(s, sameIdx);
    expect(app.texts).toEqual({ 'str:0': '约会', 'int:0': '' });
    expect(app.applied).toEqual(['str:0']);
  });
});

describe('sceneSuggestionName（协议槽 label 拼接；不可用降级）', () => {
  const slots = [
    { kind: 'int' as const, index: 0, label: '对话对象' },
    { kind: 'int' as const, index: 1, label: '时机' },
    { kind: 'str' as const, index: 0, label: '' },
  ];
  it('按 label=值 拼接，跳过空槽；label 空回退 ARG:n', () => {
    expect(sceneSuggestionName(slots, { 'int:0': '觉', 'int:1': 'SP_EVENT' })).toBe('对话对象=觉/时机=SP_EVENT');
    expect(sceneSuggestionName(slots, { 'str:0': '备注' })).toBe('ARGS:0=备注');
  });
  it('无槽（协议不可用）→ 空串（纯手填）', () => {
    expect(sceneSuggestionName([], { 'int:0': '1' })).toBe('');
  });
});

describe('场景槽位 ↔ 裸上下文文本（无协议降级）', () => {
  it('槽位 → 文本：按槽号排序；str 带引号', () => {
    expect(sceneSlotsToContextText({ 'str:1': man('约会'), 'int:0': man('36'), 'int:1': man('15') })).toBe(
      '0=36, 1=15, 1="约会"',
    );
  });
  it('文本 → 槽位：round-trip 一致；非法文本 → null（不抛错）', () => {
    const text = '0=36, 1="约会"';
    const slots = contextTextToSceneSlots(text);
    expect(slots).toEqual({ 'int:0': man('36'), 'str:1': man('约会') });
    expect(sceneSlotsToContextText(slots!)).toBe(text);
    expect(contextTextToSceneSlots('abc')).toBeNull();
    expect(contextTextToSceneSlots('  ')).toEqual({});
  });
});

describe('upsertSceneByName / removeScene / newSceneId', () => {
  const existing: ReplayScene[] = [{ id: 'scene-1', name: '约会', slots: { 'int:0': man('1') } }];

  it('同名 → 覆盖（保留原 id）；新名 → 用 makeId 新建', () => {
    const over = upsertSceneByName(existing, ' 约会 ', { 'int:0': man('2') }, () => 'scene-2');
    expect(over.overwritten).toBe(true);
    expect(over.scenes).toHaveLength(1);
    expect(over.scene.id).toBe('scene-1');
    expect(over.scene.slots).toEqual({ 'int:0': man('2') });
    const added = upsertSceneByName(existing, '夜', { 'int:0': man('9') }, () => 'scene-2');
    expect(added.overwritten).toBe(false);
    expect(added.scenes.map((s) => s.id)).toEqual(['scene-1', 'scene-2']);
  });

  it('removeScene：内置默认场景不可删；其余按 id 移除', () => {
    expect(removeScene(existing, DEFAULT_SCENE_ID)).toEqual(existing);
    expect(removeScene(existing, 'scene-1')).toEqual([]);
    expect(removeScene(existing, 'nope')).toEqual(existing);
  });

  it('newSceneId：碰撞重试直到唯一', () => {
    const seq = ['dup', 'dup', 'u3'];
    let i = 0;
    const id = newSceneId(['scene-dup'], () => seq[i++]!);
    expect(id).toBe('scene-u3');
    expect(newSceneId([], () => 'x')).toBe('scene-x');
  });
});

describe('谓词渲染窗口（触底增窗）', () => {
  it('初窗 ≤ INITIAL；常见函数（<INITIAL 谓词）零哨兵', () => {
    expect(predWindowSize(10_000, undefined)).toBe(PRED_WINDOW_INITIAL);
    expect(predWindowSize(90, undefined)).toBe(90);
  });

  it('每步 +STEP、单调不减、终值钉在 total（全量可达）', () => {
    expect(nextPredWindow(undefined, 10_000)).toBe(PRED_WINDOW_INITIAL + PRED_WINDOW_STEP);
    let cur: number | undefined = undefined;
    let prev: number | undefined = undefined;
    for (let i = 0; i < 500 && cur !== 10_000; i++) {
      cur = nextPredWindow(cur, 10_000);
      // 步长上界只从第二个窗口起算（首窗 = INITIAL + STEP，上方已单独钉住）
      if (prev !== undefined) {
        expect(cur).toBeGreaterThanOrEqual(prev);
        expect(cur - prev).toBeLessThanOrEqual(PRED_WINDOW_STEP);
      }
      prev = cur;
    }
    expect(cur).toBe(10_000);
    expect(nextPredWindow(cur, 10_000)).toBe(10_000); // 到顶后不再增长
  });

  it('mustInclude：位点行在窗口外时把窗口撑到盖住它（"就是这一行"必须看得见）', () => {
    expect(predWindowSize(5_000, undefined, 250)).toBe(250); // 初始窗口之外 → 撑大
    expect(predWindowSize(5_000, PRED_WINDOW_INITIAL + PRED_WINDOW_STEP, 0)).toBe(PRED_WINDOW_INITIAL + PRED_WINDOW_STEP);
    expect(predWindowSize(200, undefined, 250)).toBe(200); // 覆盖也被 total 钉住
    expect(predWindowSize(5_000, 300, 100)).toBe(300); // 覆盖行在窗口内 → 不动
  });
});

/* ==================== 白话批（2026-11-02）：可发现性 + 中文标注 ==================== */

import type { ConditionIndex, VariableSchema } from '@kojo/plugin-api';
import { browseCharaFunctions, predicateGloss, predicateValues, replaySummarySentence, suggestFunctionsSmart } from '../src/panel-logic';

/** 构造最小 ConditionIndex（只填 suggestFunctionsSmart 读的字段；第二项 = 依赖数组） */
function mkIndex(entries: [string, { key: string; labels?: string[] }[]][]): ConditionIndex {
  return {
    projectRoot: '.',
    finishedAt: 0,
    durationMs: 0,
    byFunction: new Map(
      entries.map(([name, deps]) => [
        name,
        {
          normalizedName: name,
          filePath: `${name}.erb`,
          startLine: 1,
          predicateCount: deps.length,
          unparsedCount: 0,
          dependencies: deps.map((d) => ({
            key: d.key,
            name: d.key.split(':')[0]!,
            indices: d.key.includes(':') ? d.key.split(':').slice(1) : [],
            count: 1,
            comparisons: [],
            firstLine: 2,
            ...(d.labels && d.labels.length > 0
              ? { schema: { name: d.key.split(':')[0]!, index: Number(d.key.split(':')[1] ?? 0), description: d.labels[0] } }
              : {}),
          })),
        },
      ]),
    ),
    stats: { functions: entries.length, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 },
  } as unknown as ConditionIndex;
}

describe('suggestFunctionsSmart（函数名 + 中文标签两路）', () => {
  const index = mkIndex([
    ['MESSAGE_COM_K12_310_1', [{ key: 'CFLAG:2', labels: ['好感度'] }]],
    ['MESSAGE_COM_K12_310_2', [{ key: 'CFLAG:3', labels: ['好感度'] }, { key: 'MONEY' }]],
    ['LOCAL_CHECK', [{ key: 'BASE:0', labels: ['体力'] }]],
  ]);

  it('函数名命中：hint 为空（老路行为不回退）', () => {
    expect(suggestFunctionsSmart(index, 'K12_310', 50)).toEqual([
      { name: 'MESSAGE_COM_K12_310_1', hint: '' },
      { name: 'MESSAGE_COM_K12_310_2', hint: '' },
    ]);
  });

  it('中文标签命中：hint 给出命中的中文名（搜「好感」找到判好感的段）', () => {
    expect(suggestFunctionsSmart(index, '好感', 50)).toEqual([
      { name: 'MESSAGE_COM_K12_310_1', hint: '好感度' },
      { name: 'MESSAGE_COM_K12_310_2', hint: '好感度' },
    ]);
  });

  it('整名已存在 → 只回它自己（与旧判据同源）', () => {
    expect(suggestFunctionsSmart(index, 'local_check', 50)).toEqual([{ name: 'LOCAL_CHECK', hint: '' }]);
  });

  it('短查询 / 空索引 → 空', () => {
    expect(suggestFunctionsSmart(index, '好', 50)).toEqual([]);
    expect(suggestFunctionsSmart(null, '好感', 50)).toEqual([]);
  });

  it('两路合并后按 limit 截断（函数名命中优先；两路同中只出一条）', () => {
    const rich = mkIndex([
      ['AAA_XX', []], // 名字命中
      ['BBB_YY', [{ key: 'CFLAG:2', labels: ['XX度'] }]], // 仅标签命中
      ['CCC_XX', [{ key: 'CFLAG:2', labels: ['XX度'] }]], // 两路都命中 → 只出名字路一条
      ['DDD_YY', [{ key: 'CFLAG:2', labels: ['XX度'] }]], // 仅标签命中
    ]);
    expect(suggestFunctionsSmart(rich, 'xx', 3)).toEqual([
      { name: 'AAA_XX', hint: '' },
      { name: 'CCC_XX', hint: '' },
      { name: 'BBB_YY', hint: 'XX度' },
    ]);
  });
});

describe('browseCharaFunctions（角色浏览启发）', () => {
  const names = ['MESSAGE_COM_K12_310_1', 'MESSAGE_COM_K12_310_2', 'M_KOJO_EVENT_K49_1', 'LOCAL_CHECK'];

  it('按 K{no} 段过滤（eraTW 口上模板命名法）', () => {
    expect(browseCharaFunctions(names, 12, 50)).toEqual(['MESSAGE_COM_K12_310_1', 'MESSAGE_COM_K12_310_2']);
    expect(browseCharaFunctions(names, 49, 50)).toEqual(['M_KOJO_EVENT_K49_1']);
  });

  it('K 号是别的角色号的子串时不串（K1 ≠ K12）', () => {
    expect(browseCharaFunctions(names, 1, 50)).toEqual([]);
  });

  it('非法角色号 / 无命中 → 空（不渲染、不猜）', () => {
    expect(browseCharaFunctions(names, -1, 50)).toEqual([]);
    expect(browseCharaFunctions(names, 99, 50)).toEqual([]);
  });
});

describe('replaySummarySentence（结果白话摘要）', () => {
  const mk = (stats: { total: number; hit: number; miss: number; unknown: number }): FunctionReplay =>
    ({
      normalizedName: 'F',
      filePath: 'a.erb',
      startLine: 1,
      stats,
      confidence: 'partial',
      predicates: [],
      branches: [],
    }) as unknown as FunctionReplay;

  it('零条件：直说没有可判定的条件', () => {
    const s = replaySummarySentence(mk({ total: 0, hit: 0, miss: 0, unknown: 0 }));
    expect(s).toContain('没有登记到可判定的条件');
  });

  it('有判不出：三段并列；全判定：两段并列', () => {
    expect(replaySummarySentence(mk({ total: 10, hit: 4, miss: 3, unknown: 3 }))).toBe(
      '对照这份存档：这一段共 10 处条件——4 处成立、3 处不成立、3 处判不出。',
    );
    expect(replaySummarySentence(mk({ total: 10, hit: 4, miss: 6, unknown: 0 }))).toBe(
      '对照这份存档：这一段共 10 处条件——4 处成立、6 处不成立。',
    );
  });
});

describe('predicateGloss（谓词行中文标注）', () => {
  const schema = {
    version: 't',
    lookup: (name: string, index?: number | string) => {
      if (name === 'CFLAG' && index === 2) return { name: 'CFLAG', index: 2, description: '好感度' };
      if (name === 'TALENT' && index === '恋慕') return { name: 'TALENT', index: '恋慕', description: '恋慕' };
      return undefined;
    },
  } as unknown as VariableSchema;

  it('数字下标查词典：CFLAG:2 → 好感度', () => {
    const expr: ConditionExpr = { kind: 'binary', op: '>=', left: { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' }, right: { kind: 'literal', value: 500, text: '500' } };
    expect(predicateGloss(expr, schema)).toBe('好感度');
  });

  it('具名下标查词典：TALENT:恋慕 → 恋慕', () => {
    const expr: ConditionExpr = { kind: 'ref', name: 'TALENT', indices: ['恋慕'], text: 'TALENT:恋慕' };
    expect(predicateGloss(expr, schema)).toBe('恋慕');
  });

  it('嵌套变量引用（全大写 ASCII 下标）不猜；无词典 / 无命中 → null', () => {
    const nested: ConditionExpr = { kind: 'ref', name: 'CFLAG', indices: ['ARG'], text: 'CFLAG:ARG' };
    expect(predicateGloss(nested, schema)).toBeNull();
    const noDict: ConditionExpr = { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' };
    expect(predicateGloss(noDict, undefined)).toBeNull();
    const unknownVar: ConditionExpr = { kind: 'ref', name: 'TARGET', indices: [], text: 'TARGET' };
    expect(predicateGloss(unknownVar, schema)).toBeNull();
  });

  it('同标签去重；递归进二元两侧', () => {
    const expr: ConditionExpr = {
      kind: 'binary',
      op: '&&',
      left: { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' },
      right: { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' },
    };
    expect(predicateGloss(expr, schema)).toBe('好感度');
  });
});

describe('台词推演区的渲染窗口（2026-11-02 美化批）', () => {
  it('首屏 = TR_WINDOW.initial；limit 给值就按值；上限是 total', () => {
    expect(trWindowSize(500, undefined)).toBe(TR_WINDOW.initial);
    expect(trWindowSize(500, 80)).toBe(80);
    expect(trWindowSize(10, 80)).toBe(10);
  });

  it('跳转位点在窗口之外时撑到盖住它（与谓词区同口径）', () => {
    expect(trWindowSize(500, undefined, 130)).toBe(130);
    expect(trWindowSize(500, 80, 130)).toBe(130);
    // 位点在窗口内不动（不许因跳转把窗口缩小）
    expect(trWindowSize(500, 200, 130)).toBe(200);
  });

  it('追加一窗：单调不减、步长有界、终值 = total', () => {
    const a = nextTrWindow(undefined, 500);
    expect(a).toBe(TR_WINDOW.initial + TR_WINDOW.step);
    expect(nextTrWindow(a, 500)).toBeGreaterThan(a);
    expect(nextTrWindow(499, 500)).toBe(500);
    expect(nextTrWindow(500, 500)).toBe(500);
  });
});

describe('predicateValues（B3：谓词行显示变量实际取值）', () => {
  const ref = (name: string, indices: string[] = []): ConditionExpr => ({
    kind: 'ref',
    name,
    indices,
    text: indices.length ? `${name}:${indices.join(':')}` : name,
  });
  const value = (v: number | string): ReplayValue => ({ kind: 'value', value: v });
  const unknown = (): ReplayValue => ({
    kind: 'unknown',
    unknown: { code: 'missing-var', message: 'no' },
  });
  /** 视图读取器桩：CFLAG:2 = 480、CFLAG:3 = 120、TALENT:恋慕 = 1，其余 unknown */
  const read = (r: VariableRef): ReplayValue => {
    const key = r.indices.length === 0 ? r.name.toUpperCase() : `${r.name.toUpperCase()}:${r.indices.join(':')}`;
    if (key === 'CFLAG:2') return value(480);
    if (key === 'CFLAG:3') return value(120);
    if (key === 'TALENT:恋慕') return value(1);
    return unknown();
  };

  it('二元两侧的存档变量都列出来（`为什么是假`的答案就在行上）', () => {
    const expr: ConditionExpr = {
      kind: 'binary',
      op: '&&',
      left: { kind: 'binary', op: '>=', left: ref('CFLAG', ['2']), right: { kind: 'literal', value: 500, text: '500' } },
      right: { kind: 'binary', op: '<', left: ref('CFLAG', ['3']), right: { kind: 'literal', value: 200, text: '200' } },
    };
    expect(predicateValues(expr, read)).toBe('CFLAG:2=480 · CFLAG:3=120');
  });

  it('读不出值的引用不列（未知原因由引擎行自己说，不在这里重复噪音）', () => {
    const expr: ConditionExpr = {
      kind: 'binary',
      op: '&&',
      left: ref('CFLAG', ['2']),
      right: ref('CFLAG', ['9']),
    };
    expect(predicateValues(expr, read)).toBe('CFLAG:2=480');
    const allUnknown: ConditionExpr = { kind: 'binary', op: '&&', left: ref('MONEY'), right: ref('DAY') };
    expect(predicateValues(allUnknown, read)).toBeNull();
  });

  it('语言级局部量族跳过（本地量/结果寄存器不是存档值）', () => {
    const expr: ConditionExpr = {
      kind: 'binary',
      op: '&&',
      left: ref('LOCAL', ['0']),
      right: ref('RESULT'),
    };
    expect(predicateValues(expr, read)).toBeNull();
    const mixed: ConditionExpr = {
      kind: 'binary',
      op: '&&',
      left: ref('LOCAL', ['0']),
      right: ref('CFLAG', ['2']),
    };
    expect(predicateValues(mixed, read)).toBe('CFLAG:2=480');
  });

  it('同名同下标去重（递归进 ternary / call 参数），取值字符串原样', () => {
    const expr: ConditionExpr = {
      kind: 'ternary',
      cond: ref('CFLAG', ['2']),
      then: ref('CFLAG', ['2']),
      else: { kind: 'call', name: 'MAX', args: [ref('TALENT', ['恋慕']), ref('CFLAG', ['2'])] },
    };
    expect(predicateValues(expr, read)).toBe('CFLAG:2=480 · TALENT:恋慕=1');
  });

  it('最多列 MAX_VALUE_HINTS 格（顺序 = 出现序）', () => {
    const expr: ConditionExpr = {
      kind: 'call',
      name: 'MAX',
      args: [ref('CFLAG', ['2']), ref('CFLAG', ['3']), ref('TALENT', ['恋慕']), ref('MONEY'), ref('DAY')],
    };
    const out = predicateValues(expr, read);
    expect(out).toBe('CFLAG:2=480 · CFLAG:3=120 · TALENT:恋慕=1');
    expect(out!.split(' · ')).toHaveLength(3);
  });
});

/* ================================================================== *
 * 缓冲文本口径 + 未建模写摘要 + 候选两路合并（2026-11-05 面板集成批）
 *
 * 纯函数住在 `../src/preview`（面板的呈现层，写域内）：
 * - `chooseReplayText`：这次判定用编辑器缓冲还是磁盘文本；
 * - `textSourceLabel`：结果区那句口径标记（措辞在这里钉死）；
 * - `summarizeUnmodeledWrites`：未建模写「前 5 + 省略」（行号可点回源）；
 * - `mergeSlotCandidates`：字面量候选 ∪ 具名常量候选。
 * ================================================================== */

describe('chooseReplayText · 同文件才传 override', () => {
  const buffered = { filePath: 'D:\\game\\kojo\\a.erb', text: '#DIM CONST X = 1\nIF CFLAG:2 >= 10', dirty: true };

  it('同一个文件 + 有未保存编辑 → 传缓冲文本', () => {
    const r = chooseReplayText('D:\\game\\kojo\\a.erb', buffered);
    expect(r.source).toBe('buffer');
    expect(r.reason).toBe('buffer-dirty');
    expect(r.textOverride).toBe(buffered.text);
  });

  it('路径口径归一到同一份（分隔符 / 大小写不同也算同文件）', () => {
    expect(chooseReplayText('d:/game/kojo/A.ERB', buffered).textOverride).toBe(buffered.text);
  });

  it('异文件 → 不传（拿别的文件的文本判这一段 = 静默错答案）', () => {
    const r = chooseReplayText('D:\\game\\kojo\\b.erb', buffered);
    expect(r.source).toBe('disk');
    expect(r.reason).toBe('other-file');
    expect(r.textOverride).toBeUndefined();
  });

  it('同文件即使 `dirty=false` 也照样传缓冲文本（脏标记会滞后：保存不重播 / 防抖窗口）', () => {
    const r = chooseReplayText('D:\\game\\kojo\\a.erb', { ...buffered, dirty: false });
    expect(r).toMatchObject({ source: 'buffer', reason: 'buffer-clean' });
    expect(r.textOverride).toBe(buffered.text);
  });

  it('显式退回旧口径（`ignoreDirty: false`）才在 clean 时用磁盘——只给对拍 / 调试', () => {
    const r = chooseReplayText('D:\\game\\kojo\\a.erb', { ...buffered, dirty: false }, { ignoreDirty: false });
    expect(r).toMatchObject({ source: 'disk', reason: 'buffer-clean' });
    expect(r.textOverride).toBeUndefined();
  });

  it('没有缓冲广播 / 不知道目标文件 → 磁盘文本（不猜）', () => {
    expect(chooseReplayText('D:\\game\\kojo\\a.erb', null)).toMatchObject({ source: 'disk', reason: 'no-buffer' });
    expect(chooseReplayText(null, buffered)).toMatchObject({ source: 'disk', reason: 'no-buffer' });
    expect(chooseReplayText('', buffered)).toMatchObject({ source: 'disk', reason: 'no-buffer' });
  });
});

describe('textSourceLabel · 结果区口径标记', () => {
  it('缓冲文本分两档措辞（未保存 / 与磁盘一致），磁盘文本给出降级原因', () => {
    expect(textSourceLabel({ source: 'buffer', reason: 'buffer-dirty' })).toContain('编辑器里的未保存文本');
    expect(textSourceLabel({ source: 'buffer', reason: 'buffer-clean' })).toContain('编辑器缓冲区文本');
    expect(textSourceLabel({ source: 'buffer', reason: 'buffer-clean' })).toContain('与磁盘当前一致');
    expect(textSourceLabel({ source: 'disk', reason: 'other-file' })).toContain('不是编辑器里正在编辑的这一份');
    expect(textSourceLabel({ source: 'disk', reason: 'no-buffer' })).toContain('磁盘文本');
  });
});

describe('summarizeUnmodeledWrites · 前 5 + 省略', () => {
  const w = (line: number, text = `CFLAG:${line} += 1`) => ({ line, text });

  it('缺省 / 空数组 → null（旧引擎整个区都不渲染）', () => {
    expect(summarizeUnmodeledWrites(undefined)).toBeNull();
    expect(summarizeUnmodeledWrites(null)).toBeNull();
    expect(summarizeUnmodeledWrites([])).toBeNull();
  });

  it('不超过 5 条全列，次数进提示语（行号顺序 = 引擎给的顺序）', () => {
    const s = summarizeUnmodeledWrites([w(12), w(18), w(24)]);
    expect(s).not.toBeNull();
    expect(s!.total).toBe(3);
    expect(s!.shown.map((x) => x.line)).toEqual([12, 18, 24]);
    expect(s!.more).toBe(0);
    expect(s!.head).toBe('本段有 3 处状态写未建模（回放按入口值判）：');
  });

  it('超过 5 条只列前 5 + 记下省略数（默认上限）', () => {
    const s = summarizeUnmodeledWrites([1, 2, 3, 4, 5, 6, 7, 8].map((n) => w(n)));
    expect(s!.total).toBe(8);
    expect(s!.shown).toHaveLength(UNMODELED_WRITE_LIMIT);
    expect(s!.shown.map((x) => x.line)).toEqual([1, 2, 3, 4, 5]);
    expect(s!.more).toBe(3);
    expect(s!.head).toContain('有 8 处');
  });

  it('自定义上限（0 = 一行不列，但仍报总数）', () => {
    const s = summarizeUnmodeledWrites([w(3), w(4)], 0);
    expect(s!.shown).toEqual([]);
    expect(s!.more).toBe(2);
    expect(summarizeUnmodeledWrites([w(3)], 99)!.more).toBe(0);
  });

  it('原文原样带出（点击回源时的悬停文本）', () => {
    const s = summarizeUnmodeledWrites([w(7, 'SETBIT CFLAG:2, 4')]);
    expect(s!.shown[0]).toEqual({ line: 7, text: 'SETBIT CFLAG:2, 4' });
  });
});

describe('mergeSlotCandidates · 字面量 ∪ 具名常量', () => {
  it('base 在前、extra 只补新值（槽内去重），不截断', () => {
    const base = new Map<string, string[]>([['str:0', ['战斗前', '战斗后']]]);
    const extra = new Map<string, string[]>([
      ['str:0', ['战斗后', '休息']],
      ['int:1', ['3']],
    ]);
    const merged = mergeSlotCandidates(base, extra);
    expect(merged.get('str:0')).toEqual(['战斗前', '战斗后', '休息']);
    expect(merged.get('int:1')).toEqual(['3']);
  });

  it('extra 为空 / null → 与 base 逐字同值（旧行为零变化）', () => {
    const base = new Map<string, string[]>([['int:0', ['36']]]);
    expect(mergeSlotCandidates(base, null).get('int:0')).toEqual(['36']);
    expect(mergeSlotCandidates(base, new Map()).get('int:0')).toEqual(['36']);
  });

  it('空串候选不产出、空槽不留壳', () => {
    const merged = mergeSlotCandidates(new Map([['str:2', []]]), new Map([['str:2', ['']]]));
    expect(merged.has('str:2')).toBe(false);
  });

  it('不改入参（两路 Map 原样）', () => {
    const base = new Map<string, string[]>([['int:0', ['1']]]);
    const extra = new Map<string, string[]>([['int:0', ['2']]]);
    mergeSlotCandidates(base, extra);
    expect(base.get('int:0')).toEqual(['1']);
    expect(extra.get('int:0')).toEqual(['2']);
  });
});
