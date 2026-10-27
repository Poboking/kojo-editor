/**
 * PS-11 抽取 offload 批 · `condition.extractFile` 任务的**逐字节等价**对拍。
 *
 * 本批把 engine.run 主循环的抽取段（骨架扫描 → 两指针切片 → 逐函数
 * `extractFunctionConditions` → 桶成形）合成纯函数任务搬进 compute worker。
 * 这里把**改前的主循环语义原样封存**（ce707bb 版 engine.ts :456-484）作对照，
 * 在对抗性随机骨架 + 随机函数区间上与新任务 `extractFileBucket` 逐字节对拍。
 *
 * 覆盖面：SELECTCASE/CASE 展开与深度栈、SIF/ELSEIF、语句与函数区间任意交错、
 * 空 stmts / 空 functions / 函数区间不覆盖任何语句、opaque 残句、LOCAL 排除、
 * 比较式翻转、schema 补查口径（任务侧不查、主线程 `applySchemaLookup` 补）、
 * 载荷与结果的结构化克隆面（`structuredClone` 真 API，node 侧与 worker 同一语义）。
 * 固定种子 LCG，可复跑。`extract.test.ts` 的语义用例与 `engine-snapshot.test.ts`
 * 的引擎级行为（空桶 / 读失败不留桶 / 统计口径）是本文件之外的另两把尺子。
 */
import { describe, expect, it } from 'vitest';
import type { ComputeTaskTable, ControlFlowStatement, StateDependency, VariableInfo } from '@kojo/plugin-api';
import { handleComputeRequest } from '@kojo/plugin-api';
import { applySchemaLookup, extractFunctionConditions } from '../src/extract';
import { CONDITION_EXTRACT_FILE_TASK, conditionExtractorTasks, decodeBucket, extractFileBucket } from '../src/offload';
import type { ExtractFilePayload, ExtractFileWire } from '../src/offload';
import type { FileBucket, FileStats } from '../src/snapshot';

/* ---------------- 旧实现（改前 engine.run 主循环的抽取段，逐行封存作对照） ---------------- */

/**
 * ce707bb 版 engine.ts:456-484：stmts 已由调用方扫描好（旧主循环是
 * `await scanControlFlow(text)`，切片与聚合同段）。fn 形状用抽取真正吃到的
 * `FunctionIdentity`（normalizedName / filePath / startLine）。
 */
function oldExtractFile(
  text: string,
  path: string,
  functions: readonly { normalizedName: string; startLine: number; endLine: number }[],
  stmts: readonly ControlFlowStatement[],
  lookup?: (name: string, index?: number | string) => VariableInfo | undefined,
): FileBucket {
  const st: FileStats = { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 };
  const conds: NonNullable<ReturnType<typeof extractFunctionConditions>>[] = [];
  let cursor = 0;
  for (const fn of functions) {
    while (cursor < stmts.length && stmts[cursor]!.line < fn.startLine) cursor++;
    const slice: ControlFlowStatement[] = [];
    for (let j = cursor; j < stmts.length && stmts[j]!.line <= fn.endLine; j++) {
      slice.push(stmts[j]!);
    }
    st.functions++;
    const cond = extractFunctionConditions(
      { normalizedName: fn.normalizedName, filePath: path, startLine: fn.startLine },
      slice,
      lookup ? { lookup } : {},
    );
    if (cond) {
      conds.push(cond);
      st.predicates += cond.predicateCount;
      st.unparsed += cond.unparsedCount;
      st.dependencies += cond.dependencies.length;
      if (cond.dependencies.length > 0) st.functionsWithDeps++;
    }
  }
  return { mtimeMs: null, size: null, stats: st, conds };
}

/* ---------------- 对抗性随机骨架 + 函数区间（固定种子） ---------------- */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x4294967296;
  };
}

const STMT_KINDS = ['IF', 'ELSEIF', 'SIF', 'SELECTCASE', 'CASE', 'CASEELSE', 'ELSE', 'ENDIF', 'ENDSELECT', 'FOR', 'NEXT', 'WHILE'] as const;

const EXPR_PIECES = [
  'CFLAG:2 >= 500', 'CFLAG:2 != 800', 'TALENT:恋慕', 'LOCAL >= 3', 'ARG == 1',
  '500 <= CFLAG:2', '"A" == LOCALS:1', 'CFLAG:ARG:口上セレクタ', 'RESULT >= COUNT',
  'CFLAG:2 &&', '1 TO 5', 'IS >= 3', 'PALAM:10 < A:B', 'EXP:0 == 0 && MASTER == 0',
  'CFLAG:2 INRANGE 1, 5', '&&', '(', 'str = "x;TO y"', '', '𝐀 >= 😀',
] as const;

function randomStmts(r: () => number): ControlFlowStatement[] {
  const n = Math.floor(r() * 24);
  const out: ControlFlowStatement[] = [];
  let line = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    out.push({
      kind: STMT_KINDS[Math.floor(r() * STMT_KINDS.length)]!,
      expression: EXPR_PIECES[Math.floor(r() * EXPR_PIECES.length)]!,
      depth: Math.floor(r() * 4),
      line,
    });
    line += 1 + Math.floor(r() * 3); // 行号严格递增（scanner 语义），步长随机
  }
  return out;
}

function randomFunctions(r: () => number, maxLine: number) {
  const n = Math.floor(r() * 6);
  const out: { normalizedName: string; startLine: number; endLine: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = 1 + Math.floor(r() * (maxLine + 2));
    const b = a + Math.floor(r() * 6); // 可跨零宽、可越过最后一条语句
    out.push({ normalizedName: `M_KOJO_K${Math.floor(r() * 3)}_${i}`, startLine: a, endLine: b });
  }
  return out;
}

/** 造表器要吃的扫描器：本差分用**注入式骨架**（与文本解耦，才能随机化切片边界） */
const injectedScan = (stmts: readonly ControlFlowStatement[]) => (): readonly ControlFlowStatement[] => stmts;

const makePayload = (
  path: string,
  functions: readonly { normalizedName: string; startLine: number; endLine: number }[],
  stmts: readonly ControlFlowStatement[],
): ExtractFilePayload => ({
  path,
  text: stmts.map((s) => `${s.kind} ${s.expression}`).join('\n'),
  mtimeMs: null,
  size: null,
  functions: functions.map((fn) => ({ normalizedName: fn.normalizedName, startLine: fn.startLine, endLine: fn.endLine })),
});

/* ---------------- schema lookup（补查口径差分用） ---------------- */

const LOOKUP = (name: string, index?: number | string): VariableInfo | undefined =>
  name === 'CFLAG' ? { name, index, description: `好感度${String(index ?? '')}` } : undefined;

describe('PS-11 · condition.extractFile 任务 ≡ 改前主循环（封存对照）', () => {
  it('600 份对抗性随机骨架 + 随机函数区间：桶产出逐字节相同', () => {
    const r = rng(20261018);
    for (let i = 0; i < 600; i++) {
      const stmts = randomStmts(r);
      const maxLine = stmts.length === 0 ? 4 : stmts[stmts.length - 1]!.line + 3;
      const fns = randomFunctions(r, maxLine);
      const payload = makePayload(`C:/game/ERB/k${i}.ERB`, fns, stmts);
      const got = extractFileBucket(payload, injectedScan(stmts));
      const want = oldExtractFile(payload.text, payload.path, fns, stmts);
      expect(
        JSON.stringify(got.bucket),
        `第 ${i} 轮对拍不符（fns=${JSON.stringify(fns)} stmts=${JSON.stringify(stmts)}）`,
      ).toBe(JSON.stringify(want));
    }
  });

  it('schema 补查口径：任务侧不查 + 主线程 applySchemaLookup ≡ 旧路径 lookup 注入', () => {
    const r = rng(20261019);
    for (let i = 0; i < 300; i++) {
      const stmts = randomStmts(r);
      const maxLine = stmts.length === 0 ? 4 : stmts[stmts.length - 1]!.line + 3;
      const fns = randomFunctions(r, maxLine);
      const payload = makePayload(`C:/game/ERB/s${i}.ERB`, fns, stmts);

      // 新路径：任务无 lookup，回主线程补标（engine.run 的原样形态）
      const taskResult = extractFileBucket(payload, injectedScan(stmts));
      for (const cond of taskResult.bucket.conds) applySchemaLookup(cond.dependencies, LOOKUP);

      const want = oldExtractFile(payload.text, payload.path, fns, stmts, LOOKUP);
      expect(
        JSON.stringify(taskResult.bucket),
        `第 ${i} 轮 schema 对拍不符（stmts=${JSON.stringify(stmts)}）`,
      ).toBe(JSON.stringify(want));
    }
  });

  it('schema 真的补上了（不是两条路都空）：抽查一条 CFLAG 依赖带 description', () => {
    const stmts: ControlFlowStatement[] = [
      { kind: 'IF', expression: 'CFLAG:2 >= 500', depth: 0, line: 2 },
      { kind: 'ENDIF', expression: '', depth: 0, line: 3 },
    ];
    const payload = makePayload('C:/game/ERB/a.ERB', [{ normalizedName: 'M_KOJO_K1_A', startLine: 1, endLine: 4 }], stmts);
    const { bucket } = extractFileBucket(payload, injectedScan(stmts));
    const dep = bucket.conds[0]!.dependencies.find((d: StateDependency) => d.name === 'CFLAG');
    expect(dep).toBeDefined();
    expect(dep!.schema).toBeUndefined(); // 任务侧不查
    applySchemaLookup(bucket.conds[0]!.dependencies, LOOKUP);
    // applySchemaLookup 口径：全数字下标转 Number（'2' → 2），与旧内联循环一致
    expect(dep!.schema).toEqual({ name: 'CFLAG', index: 2, description: '好感度2' });
  });

  it('边界：空函数清单 / 空骨架 / stmts 为空仍留空桶（不判"没缓存"）', () => {
    const payload = makePayload('C:/game/ERB/empty.ERB', [], []);
    const { bucket } = extractFileBucket(payload, injectedScan([]));
    expect(bucket.stats).toEqual({ functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 });
    expect(bucket.conds).toEqual([]);
    // 函数在、骨架空：桶仍留（stats.functions 计"扫过的函数"）
    const p2 = makePayload('C:/game/ERB/nostmt.ERB', [{ normalizedName: 'F', startLine: 1, endLine: 3 }], []);
    const b2 = extractFileBucket(p2, injectedScan([])).bucket;
    expect(b2.stats.functions).toBe(1);
    expect(b2.conds).toEqual([]);
  });

  it('载荷与结果过 `structuredClone`（= worker 结构化克隆同一语义，带函数必炸）', () => {
    const stmts: ControlFlowStatement[] = [
      { kind: 'SELECTCASE', expression: 'CFLAG:2', depth: 0, line: 2 },
      { kind: 'CASE', expression: '1 TO 5', depth: 1, line: 3 },
      { kind: 'ENDSELECT', expression: '', depth: 0, line: 4 },
    ];
    const payload = makePayload(
      'C:/game/ERB/clone.ERB',
      [{ normalizedName: 'M_KOJO', startLine: 1, endLine: 5 }],
      stmts,
    );
    const clonedPayload = structuredClone(payload);
    expect(clonedPayload).toEqual(payload);
    const { bucket, scanMs, extractMs } = extractFileBucket(clonedPayload, injectedScan(stmts));
    const clonedBucket = structuredClone(bucket);
    expect(clonedBucket).toEqual(bucket);
    expect(Number.isFinite(scanMs)).toBe(true);
    expect(Number.isFinite(extractMs)).toBe(true);
  });

  it('worker 侧执行路径：handleComputeRequest(任务表, 请求) 与直调任务同产出', async () => {
    const stmts: ControlFlowStatement[] = [
      { kind: 'IF', expression: 'CFLAG:2 >= 500', depth: 0, line: 2 },
      { kind: 'ENDIF', expression: '', depth: 0, line: 3 },
    ];
    const payload = makePayload(
      'C:/game/ERB/req.ERB',
      [{ normalizedName: 'M_KOJO_K1_A', startLine: 1, endLine: 4 }],
      stmts,
    );
    const tasks: ComputeTaskTable = conditionExtractorTasks(injectedScan(stmts));
    const res = await handleComputeRequest(tasks, { id: 42, kind: CONDITION_EXTRACT_FILE_TASK, payload });
    expect(res).toMatchObject({ id: 42 });
    if (!('result' in res)) throw new Error(`unexpected error response: ${JSON.stringify(res)}`);
    // 计时字段（scanMs/extractMs）随每次运行抖动，对拍只比桶本体；计时是有限数即可。
    // 通道回传的是**文本形态**（`ExtractFileWire`）⇒ 过一遍 decodeBucket 才与直调可比。
    const viaWorker = (res as { result: ExtractFileWire }).result;
    const direct = extractFileBucket(payload, injectedScan(stmts));
    expect(JSON.stringify(decodeBucket(viaWorker))).toBe(JSON.stringify(direct.bucket));
    expect(Number.isFinite(viaWorker.scanMs)).toBe(true);
    expect(Number.isFinite(viaWorker.extractMs)).toBe(true);
  });

  it('engine 全链路（compute stub offload = 内联任务表）：桶进 computed、语义与改前一致', async () => {
    // 最小引擎对拍：新主循环（offload 走任务表）与封存旧段在同一输入上桶产出相同。
    // 引擎级行为（批量读 / 失败不留桶 / 快照复用）由 engine-snapshot.test.ts 全量钉住。
    const stmts: ControlFlowStatement[] = [
      { kind: 'IF', expression: 'CFLAG:2 >= 500', depth: 0, line: 2 },
      { kind: 'ENDIF', expression: '', depth: 0, line: 3 },
    ];
    const fns = [{ normalizedName: 'M_KOJO_K1_A', startLine: 1, endLine: 4 }];
    const payload = makePayload('D:/game/a.ERB', fns, stmts);
    const tasks = conditionExtractorTasks(injectedScan(stmts));
    const impl = tasks[CONDITION_EXTRACT_FILE_TASK] as never as (p: ExtractFilePayload) => ExtractFileWire;
    const viaStub = await impl(structuredClone(payload));
    const want = oldExtractFile(payload.text, payload.path, fns, stmts);
    expect(JSON.stringify(decodeBucket(viaStub))).toBe(JSON.stringify(want));
    expect(Number.isFinite(viaStub.scanMs)).toBe(true);
  });
});