/**
 * 评审 P0 的**端到端**回归（2026-11-05）：真实 `ConditionEngine` + 真实 `StateReplayEngine`。
 *
 * 旧实现的两处错误叠在一起才致命：
 * 1. 抽取器 override 分支拿**磁盘索引**的 `startLine/endLine` 切**缓冲区**文本；
 * 2. 回放引擎按 `detail.startLine/endLine` 扫写点 / 台词 / 循环窗口。
 *
 * 作者在函数前插 5 行（未保存）后，磁盘区间 1..12 与缓冲区坐标 6..17 错位 ⇒ 谓词被切到
 * 区间外，结果长成 `predicates: [] + confidence: 'exact'` + 零写点——面板会显示"完全判定"，
 * 比报错更坏。修法：抽取器在缓冲区里按 `@NAME` 重定位（`erb.parser.parseText`，与索引
 * scanner 同源），`startLine/endLine` 跟缓冲区走；引擎三种用途都吃这份区间。
 *
 * 本文件不手写假区间：解析、骨架扫描、谓词抽取全走真实现（假解析器恰好会盖住 P0）。
 */
import { parseErbText, scanControlFlow } from '@kojo/plugin-erb-parser';
import { ConditionEngine, conditionExtractorTasks } from '@kojo/plugin-condition-extractor';
import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
  SnapshotArchive,
} from '@kojo/plugin-api';
import { StateReplayEngine } from '../src/engine';

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'd1' } as unknown as GameProject;

const FILE = 'D:/fake/kojo/fn.erb';
const SAV = 'D:/fake/save.sav';

/** 盘上正文：函数 1..12、谓词 9、写点 11 */
const DISK = [
  '@FN()', // 1
  'LOCAL = 0', // 2
  '; pad 3', // 3
  '; pad 4', // 4
  '; pad 5', // 5
  '; pad 6', // 6
  '; pad 7', // 7
  '; pad 8', // 8
  'IF CFLAG:2 >= 900', // 9
  'ENDIF', // 10
  'CFLAG:2 += 10', // 11
  '; tail', // 12
].join('\n');

/** 缓冲区：顶部插 5 行（未保存）⇒ 函数 6..17、谓词 14、写点 16 */
const INSERTED = ['; 插入 1', '; 插入 2', '; 插入 3', '; 插入 4', '; 插入 5'].join('\n');
const BUFFER = `${INSERTED}\n${[
  '@FN()', // 6
  'LOCAL = 0', // 7
  '; pad 3', // 8
  '; pad 4', // 9
  '; pad 5', // 10
  '; pad 6', // 11
  '; pad 7', // 12
  '; pad 8', // 13
  'IF CFLAG:2 >= 500', // 14
  'ENDIF', // 15
  'CFLAG:2 += 20', // 16
  '; tail', // 17
].join('\n')}`;

/** 一个角色 NO=49、CFLAG:2=800 的合成档 */
function archive(): SnapshotArchive {
  return {
    path: SAV,
    fileName: 'save.sav',
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

/** 计算池替身（按需明细路径不触发全量抽取；任务表用真工厂） */
function makeComputeStub(tasks: ReturnType<typeof conditionExtractorTasks>): ComputePool {
  return {
    async runSliced<T, R>(items: readonly T[], _o: unknown, fn: (t: T, i: number) => R | Promise<R>): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
    async offload<R>(kind: string, payload: unknown): Promise<R> {
      const impl = tasks[kind];
      if (!impl) throw new Error(`No local implementation registered for compute task '${kind}'`);
      return (await impl(payload as never)) as R;
    },
    stats: () => ({
      tasks: [],
      yields: 0,
      interactiveActive: false,
      offload: { parallel: false, dispatched: 0, fellBack: 0, inline: 0 },
    }),
  } as unknown as ComputePool;
}

function byNameOf(files: Map<string, ErbFile>): Map<string, ErbFunctionRef[]> {
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const f of files.values()) {
    for (const fn of f.functions) {
      const list = byName.get(fn.normalizedName) ?? [];
      list.push(fn);
      byName.set(fn.normalizedName, list);
    }
  }
  return byName;
}

/** 盘上索引：函数区间来自真 scanner 对 DISK 的判定（1..12） */
function erbIndex(): ErbIndex {
  const parsed = parseErbText(DISK, FILE);
  const fn = parsed.functions[0]!;
  const files = new Map<string, ErbFile>([
    [
      FILE,
      {
        path: FILE,
        functions: [
          {
            name: 'FN',
            normalizedName: fn.normalizedName,
            params: [],
            startLine: fn.startLine,
            endLine: fn.endLine,
            filePath: FILE,
            isExpressionFunction: false,
          },
        ],
        dims: [],
        hasFunctionDirective: false,
        lineCount: parsed.lineCount,
      } as ErbFile,
    ],
  ]);
  return { files, byName: functionLookupOf(byNameOf(files)) } as unknown as ErbIndex;
}

function makeReplay(): StateReplayEngine {
  const index = erbIndex();
  const extractor = new ConditionEngine({
    log: silent,
    getProject: () => project,
    getIndex: () => index,
    readFile: async () => DISK,
    scanControlFlow: async (text) => scanControlFlow(text),
    parseText: (text: string) => parseErbText(text, FILE),
    getSchemaLookup: () => undefined,
    compute: makeComputeStub(conditionExtractorTasks(scanControlFlow)),
  });
  return new StateReplayEngine({
    log: silent,
    parseArchive: async () => archive(),
    functionPredicates: (name, textOverride) => extractor.functionPredicates(name, textOverride),
    getSchemaLookup: () => undefined,
    readFileText: async () => DISK,
  });
}

describe('P0 端到端：缓冲区插行后回放行号跟缓冲区走（真实两引擎）', () => {
  it('插 5 行：startLine 6 / 谓词 14 / 写点 16，confidence 不是被空谓词骗出来的 exact', async () => {
    const replay = makeReplay();
    const view = await replay.createView(SAV, 49);

    const fromBuffer = (await replay.replayFunction(view, 'FN', { textOverride: BUFFER }))!;
    expect(fromBuffer.startLine).toBe(6); // 缓冲区坐标，不是盘上索引的 1
    expect(fromBuffer.stats.total).toBe(1); // 旧实现这里是 0（谓词被切到区间外）
    expect(fromBuffer.predicates[0]!.line).toBe(14);
    expect(fromBuffer.predicates[0]!.outcome).toEqual({ kind: 'true' }); // 800 >= 500
    expect(fromBuffer.confidence).toBe('exact');
    expect(fromBuffer.unmodeledWrites).toEqual([{ line: 16, text: 'CFLAG:2 += 20', kind: 'assign' }]);
  });

  it('同一函数无 override：仍是盘上坐标（1 / 9 / 11），缓冲区没污染磁盘语义', async () => {
    const replay = makeReplay();
    const view = await replay.createView(SAV, 49);

    // 先跑缓冲区，再跑盘上（顺序反过来也验一遍"不污染"）
    await replay.replayFunction(view, 'FN', { textOverride: BUFFER });
    const fromDisk = (await replay.replayFunction(view, 'FN'))!;
    expect(fromDisk.startLine).toBe(1);
    expect(fromDisk.predicates[0]!.line).toBe(9);
    expect(fromDisk.predicates[0]!.outcome).toEqual({ kind: 'false' }); // 800 >= 900
    expect(fromDisk.unmodeledWrites).toEqual([{ line: 11, text: 'CFLAG:2 += 10', kind: 'assign' }]);
  });
});
