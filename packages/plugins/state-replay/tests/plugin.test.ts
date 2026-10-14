/**
 * 回放引擎编排单测（mock 依赖注入）。
 *
 * 覆盖：createView（解析 + 定位 + 失败显式抛错）/ replayFunction（求值统计 +
 * 置信度三档）/ 函数不存在 → null / 批量复用视图 / replayPredicates 纯函数。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  FunctionPredicates,
  Logger,
  SnapshotArchive,
  VariableInfo,
} from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { replayPredicates, StateReplayEngine } from '../src/engine';

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
          {
            type: 'int-array-1d',
            key: 'CFLAG',
            saveLen: [100],
            cursor: [100],
            nonEmpty: 1,
            cells: [{ index: [2], value: 800 }],
            offset: 0,
          },
        ],
      },
    ],
    vars: [],
  };
}

function detail(name: string, exprs: string[], kinds: FunctionPredicates['predicates'][number]['kind'][] = []): FunctionPredicates {
  return {
    normalizedName: name,
    filePath: 'D:/fake/kojo/test.erb',
    startLine: 1,
    endLine: 20,
    statements: [],
    assignments: [],
    predicates: exprs.map((e, i) => ({
      kind: kinds[i] ?? 'IF',
      text: e,
      expr: parseExpression(e),
      line: i + 2,
      depth: 0,
    })),
    returns: [],
  };
}

const fakeLookup = (name: string, index?: number | string): VariableInfo | undefined => {
  if (name === 'TALENT' && index === '恋慕') return { name, index, description: '恋慕', resolvedIndex: 3 };
  return undefined;
};

function makeEngine() {
  const parseArchive = vi.fn(async (_path: string) => makeArchive());
  const functionPredicates = vi.fn(async (n: string): Promise<FunctionPredicates | null> => {
    if (n === 'M_KOJO_K49_MESSAGE_COM_1') return detail('M_KOJO_K49_MESSAGE_COM_1', ['CFLAG:2 >= 500', 'CFLAG:2 >= 900']);
    if (n === 'FN_UNKNOWN_PRED') return detail('FN_UNKNOWN_PRED', ['GET_FOO() == 1']);
    if (n === 'FN_NO_PRED') return detail('FN_NO_PRED', []);
    return null;
  });
  const engine = new StateReplayEngine({
    log: silentLog(),
    parseArchive,
    functionPredicates,
    getSchemaLookup: () => fakeLookup,
    readFileText: async () => '',
  });
  return { engine, parseArchive, functionPredicates };
}

describe('StateReplayEngine.createView', () => {
  it('解析档案并定位角色', async () => {
    const { engine, parseArchive } = makeEngine();
    const view = await engine.createView('D:/fake/save01.sav', 49);
    expect(parseArchive).toHaveBeenCalledWith('D:/fake/save01.sav');
    expect(view.characterNo).toBe(49);
    expect(view.characterName).toBe('古明地 觉');
  });

  it('角色不在快照 → 抛错（显式）', async () => {
    const { engine } = makeEngine();
    await expect(engine.createView('D:/fake/save01.sav', 999)).rejects.toThrow(/角色不在该快照中/);
  });

  it('档案解析失败 → 原错误上抛', async () => {
    const engine = new StateReplayEngine({
      log: silentLog(),
      parseArchive: async () => {
        throw new Error('bad magic');
      },
      functionPredicates: async () => null,
      getSchemaLookup: () => undefined,
      readFileText: async () => '',
    });
    await expect(engine.createView('D:/fake/bad.sav', 49)).rejects.toThrow('bad magic');
  });
});

describe('StateReplayEngine.replayFunction', () => {
  it('逐条求值 + 统计 + 置信度（exact）', async () => {
    const { engine } = makeEngine();
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const r = await engine.replayFunction(view, 'M_KOJO_K49_MESSAGE_COM_1');
    expect(r).not.toBeNull();
    expect(r!.predicates).toHaveLength(2);
    expect(r!.predicates[0]!.outcome.kind).toBe('true'); // CFLAG:2=800 >= 500
    expect(r!.predicates[1]!.outcome.kind).toBe('false'); // 800 >= 900 不成立
    expect(r!.stats).toEqual({ total: 2, hit: 1, miss: 1, unknown: 0 });
    expect(r!.confidence).toBe('exact');
    expect(r!.predicates[0]!.line).toBe(2);
  });

  it('全部 unknown → 置信度 unknown', async () => {
    const { engine } = makeEngine();
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const r = await engine.replayFunction(view, 'FN_UNKNOWN_PRED');
    expect(r!.stats).toEqual({ total: 1, hit: 0, miss: 0, unknown: 1 });
    expect(r!.confidence).toBe('unknown');
    expect(r!.predicates[0]!.outcome.kind).toBe('unknown');
  });

  it('函数不存在 → null', async () => {
    const { engine } = makeEngine();
    const view = await engine.createView('D:/fake/save01.sav', 49);
    expect(await engine.replayFunction(view, 'NO_SUCH_FN')).toBeNull();
  });

  it('无谓词函数 → total=0 / exact', async () => {
    const { engine } = makeEngine();
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const r = await engine.replayFunction(view, 'FN_NO_PRED');
    expect(r!.stats).toEqual({ total: 0, hit: 0, miss: 0, unknown: 0 });
    expect(r!.confidence).toBe('exact');
  });

  it('批量回放复用视图（顺序保留）', async () => {
    const { engine } = makeEngine();
    const view = await engine.createView('D:/fake/save01.sav', 49);
    const rs = await engine.replayFunctions(view, ['M_KOJO_K49_MESSAGE_COM_1', 'NO_SUCH_FN', 'FN_NO_PRED']);
    expect(rs).toHaveLength(3);
    expect(rs[0]!.normalizedName).toBe('M_KOJO_K49_MESSAGE_COM_1');
    expect(rs[1]).toBeNull();
    expect(rs[2]!.stats.total).toBe(0);
  });
});

describe('replayPredicates（纯函数）', () => {
  it('partial 置信度（部分 unknown）', () => {
    const d = detail('X', ['CFLAG:2 >= 500', 'GET_FOO() == 1', 'CFLAG:2 >= 900']);
    const r = replayPredicates(d, (ref) => {
      if (ref.name === 'CFLAG') return { kind: 'value', value: 800 };
      return { kind: 'value', value: 0 };
    });
    expect(r.stats).toEqual({ total: 3, hit: 1, miss: 1, unknown: 1 });
    expect(r.confidence).toBe('partial');
  });

  it('Kleene 组合让整体确定（false && unknown = false）', () => {
    const d = detail('Y', ['CFLAG:2 >= 900 && GET_FOO() == 1']);
    const r = replayPredicates(d, (ref) => {
      if (ref.name === 'CFLAG') return { kind: 'value', value: 800 };
      return { kind: 'unknown', unknown: { code: 'call', message: 'x' } };
    });
    expect(r.predicates[0]!.outcome.kind).toBe('false');
    expect(r.confidence).toBe('exact');
  });

  it('__LINE__ → 谓词来源行（1 基；引擎逐谓词注入）', () => {
    // detail() 的谓词行号 = 下标 + 2 ⇒ __LINE__ 分别为 2 / 3 / 4
    const d = detail('L', ['__LINE__ == 2', '__LINE__ == 9', '__LINE__ == 4 && __LINE__ >= 4']);
    const r = replayPredicates(d, () => ({ kind: 'unknown', unknown: { code: 'call', message: 'x' } }));
    expect(r.predicates[0]!.outcome.kind).toBe('true'); // 第 2 行 == 2
    expect(r.predicates[1]!.outcome.kind).toBe('false'); // 第 3 行 == 9 恒假
    expect(r.predicates[2]!.outcome.kind).toBe('true'); // 第 4 行：4==4 && 4>=4
  });

  it('__LINE__ 带索引 → unknown(too-many-args)（负自证：标量不吃索引）', () => {
    const d = detail('L2', ['__LINE__:0 == 2']);
    const r = replayPredicates(d, () => ({ kind: 'unknown', unknown: { code: 'call', message: 'x' } }));
    expect(r.predicates[0]!.outcome.kind).toBe('unknown');
    if (r.predicates[0]!.outcome.kind === 'unknown') {
      expect(r.predicates[0]!.outcome.unknown.code).toBe('too-many-args');
    }
  });
});
