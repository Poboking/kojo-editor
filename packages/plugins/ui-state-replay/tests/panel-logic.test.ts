/**
 * 回放面板纯逻辑单测（v0.2 第八批；零 React）。
 *
 * 覆盖：调用上下文文本解析（数值槽 / 字符串槽 / 重复 / 非法语法 / 空输入），
 * ReplayCallContext 组装（空槽位表 → undefined），未知原因分组，函数名提示，
 * 假设值链路（v1.0 收口 C9：槽位来源三态 / 假设计数 / AST 槽位引用扫描），
 * 以及场景预设（v1.0 收口线一：序列化容错 / 采集 / 应用与合并冲突 / 建议名 / 槽位↔文本）。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionReplay } from '@kojo/plugin-api';
import {
  DEFAULT_SCENE_ID,
  MAX_SCENES,
  applyScene,
  captureSceneSlots,
  classifySlotValue,
  collectAssumedSlots,
  contextTextToSceneSlots,
  defaultScene,
  defaultSlotText,
  exprArgSlots,
  groupUnknowns,
  newSceneId,
  parseCallContextText,
  removeScene,
  sanitizeScenes,
  sceneSlotsToContextText,
  sceneSuggestionName,
  slotKey,
  suggestFunctions,
  summarizeAssumptions,
  toCallContext,
  upsertSceneByName,
} from '../src/panel-logic';
import type { ReplayScene, SceneSlotValue } from '../src/panel-logic';

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

  it('默认场景预填值：int=0；str=空（未提供，非假设）', () => {
    expect(defaultSlotText('int')).toBe('0');
    expect(defaultSlotText('str')).toBe('');
  });

  it('来源三态：未手改的预填 0 = 假设；手输 = 确定；空 = 未提供', () => {
    expect(classifySlotValue('int', '0', false)).toBe('assumption');
    expect(classifySlotValue('int', ' 0 ', false)).toBe('assumption'); // 容忍空白
    expect(classifySlotValue('int', '0', true)).toBe('manual'); // 把预填 0 显式改写 → 确定值
    expect(classifySlotValue('int', '36', false)).toBe('manual');
    expect(classifySlotValue('int', '', false)).toBe('unset');
    expect(classifySlotValue('int', '   ', true)).toBe('unset'); // 清空 = 未提供（unknown 语义不变）
    expect(classifySlotValue('str', '', false)).toBe('unset'); // str 预填空不是假设
    expect(classifySlotValue('str', '约会', false)).toBe('manual');
  });
});

describe('collectAssumedSlots（全默认 / 全手输 / 混合）', () => {
  const slots = [
    { kind: 'int' as const, index: 0 },
    { kind: 'int' as const, index: 1 },
    { kind: 'str' as const, index: 0 },
  ];

  it('全默认（全部未手改）→ 全部 int 槽计入假设；str 预填空不算', () => {
    const texts = { 'int:0': '0', 'int:1': '0', 'str:0': '' };
    expect(collectAssumedSlots(slots, texts, {})).toEqual([
      { kind: 'int', index: 0 },
      { kind: 'int', index: 1 },
    ]);
  });

  it('全手输 → 无假设', () => {
    const texts = { 'int:0': '36', 'int:1': '15', 'str:0': '约会' };
    const edited = { 'int:0': true, 'int:1': true, 'str:0': true };
    expect(collectAssumedSlots(slots, texts, edited)).toEqual([]);
  });

  it('混合 → 只计未手改的预填 0', () => {
    const texts = { 'int:0': '36', 'int:1': '0', 'str:0': '' };
    const edited = { 'int:0': true };
    expect(collectAssumedSlots(slots, texts, edited)).toEqual([{ kind: 'int', index: 1 }]);
  });

  it('清空槽 = 未提供（不计假设）', () => {
    const texts = { 'int:0': '', 'int:1': '0', 'str:0': '' };
    expect(collectAssumedSlots(slots, texts, {})).toEqual([{ kind: 'int', index: 1 }]);
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

  it('场景覆盖的槽 → manual（edited=true）；未覆盖 → 默认（assumption / unset）', () => {
    const app = applyScene(scene, slots);
    expect(app.texts).toEqual({ 'int:0': '36', 'int:1': '0', 'str:0': '觉' });
    expect(app.edited).toEqual({ 'int:0': true, 'int:1': false, 'str:0': true });
    expect(app.applied).toEqual(['int:0', 'str:0']);
    expect(app.dropped).toEqual([]);
    expect(app.reset).toEqual([]);
  });

  it('场景里签名没有的槽 → dropped；已填却未覆盖 → reset', () => {
    const narrow = [{ kind: 'int' as const, index: 0 }];
    const app = applyScene(scene, narrow, { 'int:0': '1' });
    expect(app.dropped).toEqual(['str:0']); // 场景的 str:0 不在签名内（协议/家族不同）
    expect(app.texts).toEqual({ 'int:0': '36' });
    const app2 = applyScene({ id: 'x', name: 'x', slots: {} }, slots, { 'int:1': '7', 'str:0': '' });
    expect(app2.reset).toEqual(['int:1']);
    expect(app2.texts).toEqual({ 'int:0': '0', 'int:1': '0', 'str:0': '' });
  });

  it('内置默认场景（无槽）→ 全部回到默认', () => {
    const app = applyScene(defaultScene(), slots, { 'int:0': '9' });
    expect(app.texts).toEqual({ 'int:0': '0', 'int:1': '0', 'str:0': '' });
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
    expect(app.texts).toEqual({ 'str:0': '约会', 'int:0': '0' });
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
