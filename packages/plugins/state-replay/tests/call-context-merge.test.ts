/**
 * 调用上下文**逐槽合并**（E1 2026-11-05）与两档 `call-context` 文案的可操作化（E5）。
 *
 * 背景（HK-20 缺陷）：`replayFunction` 过去"显式注入整体取代推导器"——面板只注入
 * 手填的那几格（含预填 0）时，推导器给出的「路由 ARG:2 = 发言者 = 回放角色号」
 * 一并被盖掉。合并语义：两者描述**同一份调用实参的不同槽位**，逐 kind 逐下标
 * 「显式非 undefined 胜、undefined/缺位由推导值补」。
 *
 * 覆盖：显式胜 / 推导补 / 稀疏洞 / 两 kind 都空 → undefined / 长度取 max /
 * 引擎编排真的用上合并结果（含 0 是真实实参，不许退化成"未提供"）/
 * 两档文案的关键片段（面板没给这一格填值；「场景参数」+「按默认场景 0 试算」）。
 */
import { describe, expect, it } from 'vitest';
import type {
  FunctionPredicates,
  Logger,
  ReplayCallContextResolver,
  ReplayValue,
  SnapshotArchive,
  VariableRef,
} from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createFunctionOverlay, mergeCallContext, type OverlayPosition } from '../src/locals';
import { StateReplayEngine } from '../src/engine';

const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length ? `${name}:${indices.join(':')}` : name,
});

const TOP: OverlayPosition = { line: 100, context: [] };

const missing = (r: VariableRef): ReplayValue => ({
  kind: 'unknown',
  unknown: { code: 'missing-var', message: `no ${r.text}` },
});

function makeDetail(overrides: Partial<FunctionPredicates> = {}): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'a.erb',
    startLine: 1,
    endLine: 100,
    statements: [],
    assignments: [],
    predicates: [],
    returns: [],
    ...overrides,
  };
}

describe('mergeCallContext · 逐槽合并规则', () => {
  it('显式非 undefined 胜：同下标显式 5 覆盖推导 0', () => {
    expect(mergeCallContext({ ints: [5] }, { ints: [0] })).toEqual({ ints: [5] });
  });

  it('推导补位：显式只填了稀疏洞，undefined 的位置由推导值补', () => {
    expect(mergeCallContext({ ints: [undefined, 7] }, { ints: [1, undefined] })).toEqual({
      ints: [1, 7],
    });
  });

  it('稀疏洞保留：两边都没有值的下标留 undefined（洞 = 该槽仍未知）', () => {
    expect(mergeCallContext({ ints: [undefined, 3] }, { ints: [undefined, undefined] })).toEqual({
      ints: [undefined, 3],
    });
  });

  it('两 kind 互补：显式只有 strs、推导只有 ints → 合并出两份', () => {
    expect(mergeCallContext({ strs: ['A'] }, { ints: [0] })).toEqual({ ints: [0], strs: ['A'] });
  });

  it('两 kind 都空 → undefined（全 undefined 的 kind 整体省略）', () => {
    expect(mergeCallContext(undefined, undefined)).toBeUndefined();
    expect(mergeCallContext({}, {})).toBeUndefined();
    expect(mergeCallContext({ ints: [undefined] }, { strs: [undefined] })).toBeUndefined();
  });

  it('长度取 max：推导更长 / 显式更长都保留较长者', () => {
    expect(mergeCallContext({ ints: [1] }, { ints: [undefined, 2, 3] })).toEqual({ ints: [1, 2, 3] });
    expect(mergeCallContext({ ints: [1, 2, 3] }, { ints: [9] })).toEqual({ ints: [1, 2, 3] });
  });

  it('显式的 0 / 空串是**真实实参**，不许当成"未提供"让推导值顶上来', () => {
    expect(mergeCallContext({ ints: [0], strs: [''] }, { ints: [49], strs: ['X'] })).toEqual({
      ints: [0],
      strs: [''],
    });
  });

  it('不修改入参（返回新数组）', () => {
    const explicitInts = [1, undefined];
    const derivedInts = [undefined, 2];
    const merged = mergeCallContext({ ints: explicitInts }, { ints: derivedInts })!;
    expect(merged.ints).toEqual([1, 2]);
    expect(explicitInts).toEqual([1, undefined]);
    expect(derivedInts).toEqual([undefined, 2]);
    expect(merged.ints).not.toBe(explicitInts);
  });
});

/* ------------------------------------------------------------------ */
/* E1 编排面：replayFunction 真的把合并结果交给叠加层                  */
/* ------------------------------------------------------------------ */

function silentLog(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeArchive(): SnapshotArchive {
  return {
    path: 'D:/fake/save01.sav',
    fileName: 'save01.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 1,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [
      {
        index: 0,
        dimSepIndex: null,
        vars: [
          { type: 'int', key: 'NO', value: 49, offset: 0 },
          { type: 'str', key: 'NAME', value: '古明地 觉', offset: 0 },
        ],
      },
    ],
    vars: [],
  };
}

/** 单谓词函数 + 可注入的推导器（编排层组装：显式注入走 options，推导走 deps） */
function engineFor(expr: string, resolver?: ReplayCallContextResolver) {
  const detail = makeDetail({
    predicates: [{ kind: 'IF', text: expr, expr: parseExpression(expr), line: 2, depth: 0 }],
  });
  return new StateReplayEngine({
    log: silentLog(),
    parseArchive: async () => makeArchive(),
    functionPredicates: async () => detail,
    getSchemaLookup: () => undefined,
    readFileText: async () => '',
    ...(resolver ? { getCallContextResolver: () => resolver } : {}),
  });
}

describe('E1 编排面 · 部分显式注入不再吞掉推导事实', () => {
  it('显式只填 ints[0]，推导补 ints[1]=49 ⇒ ARG:1 == 49 判真', async () => {
    const engine = engineFor('ARG:1 == 49', () => ({ ints: [0, 49] }));
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const replay = (await engine.replayFunction(view, 'FN', { callContext: { ints: [0] } }))!;
    expect(replay.predicates[0]!.outcome).toEqual({ kind: 'true' });
    expect(replay.stats).toEqual({ total: 1, hit: 1, miss: 0, unknown: 0 });
  });

  it('无推导器 / 推导器不填该槽 ⇒ 仍是 call-context unknown（不猜）', async () => {
    const engine = engineFor('ARG:1 == 49');
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const replay = (await engine.replayFunction(view, 'FN', { callContext: { ints: [0] } }))!;
    expect(replay.predicates[0]!.outcome.kind).toBe('unknown');
    if (replay.predicates[0]!.outcome.kind === 'unknown') {
      expect(replay.predicates[0]!.outcome.unknown.code).toBe('call-context');
    }
  });

  it('同槽位：显式值胜出（面板手填覆盖推导事实；0 也是真实实参）', async () => {
    const engine = engineFor('ARG == 0', () => ({ ints: [49] }));
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const replay = (await engine.replayFunction(view, 'FN', { callContext: { ints: [0] } }))!;
    expect(replay.predicates[0]!.outcome).toEqual({ kind: 'true' });
  });

  it('options.callContextResolver 覆写引擎内置推导器（口径不变）', async () => {
    const engine = engineFor('ARG:1 == 49', () => ({ ints: [0, 1] }));
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const replay = (
      await engine.replayFunction(view, 'FN', {
        callContext: { ints: [0] },
        callContextResolver: () => ({ ints: [undefined, 49] }),
      })
    )!;
    expect(replay.predicates[0]!.outcome).toEqual({ kind: 'true' });
  });
});

/* ------------------------------------------------------------------ */
/* E5 文案可操作化                                                     */
/* ------------------------------------------------------------------ */

describe('call-context 文案 · 可操作化（E5）', () => {
  const localAssignment = {
    name: 'LOCAL' as const,
    index: 0,
    expr: parseExpression('1'),
    text: '1',
    line: 10,
    context: [] as string[],
  };

  it('未提供档：点明"面板没给这一格填值"，并保留"由本次调用的实参决定 / 不猜"', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail({ assignments: [localAssignment] }),
      baseRead: missing,
    })!;
    const v = overlay(ref('ARG', ['2']), TOP)!;
    expect(v.kind).toBe('unknown');
    if (v.kind !== 'unknown') return;
    expect(v.unknown.code).toBe('call-context');
    expect(v.unknown.message).toContain('面板没给这一格填值');
    expect(v.unknown.message).toContain('本次调用的实参');
    expect(v.unknown.message).toContain('不猜');
  });

  it('未覆盖档：指到「场景参数」，说明数值槽可勾「按默认场景 0 试算」、字符串槽照实参填', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail(),
      callContext: { ints: [0] },
      baseRead: missing,
    })!;
    const v = overlay(ref('ARG', ['3']), TOP)!;
    expect(v.kind).toBe('unknown');
    if (v.kind !== 'unknown') return;
    expect(v.unknown.code).toBe('call-context'); // 机器码不变
    expect(v.unknown.message).toContain('场景参数');
    expect(v.unknown.message).toContain('按默认场景 0 试算');
    expect(v.unknown.message).toContain('字符串槽需照实参填');
    expect(v.unknown.message).toContain('不借用相邻槽位');

    const s = overlay(ref('ARGS', ['2']), TOP)!;
    expect(s.kind).toBe('unknown');
    if (s.kind !== 'unknown') return;
    expect(s.unknown.code).toBe('call-context');
    expect(s.unknown.message).toContain('场景参数');
  });

  it('未提供档 / 未覆盖档都不说"谁忘了提供"（作者面可操作）', () => {
    const none = createFunctionOverlay({
      detail: makeDetail({ assignments: [localAssignment] }),
      baseRead: missing,
    })!;
    const over = createFunctionOverlay({
      detail: makeDetail(),
      callContext: { ints: [0] },
      baseRead: missing,
    })!;
    for (const v of [none(ref('ARG', ['2']), TOP)!, over(ref('ARG', ['3']), TOP)!]) {
      if (v.kind !== 'unknown') continue;
      expect(v.unknown.message).not.toContain('忘了');
      expect(v.unknown.message).not.toContain('未提供调用上下文');
    }
  });
});
