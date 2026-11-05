/**
 * 内联解释器 × 缓冲区文本（2026-11-05 状态回放边界批 · 车道 S1）。
 *
 * 钉住四条口径（全部纯 fake deps，不碰真语料）：
 * 1. **同文件被调函数吃缓冲版**：`CALL` 展开的那段正文在缓冲区里改过（未保存），
 *    带 `textOverride` 回放取缓冲结果；**随后不带 override 回放必须取磁盘结果**
 *    （磁盘桶零污染）。
 * 2. **override 只对同文件生效**：跨文件被调函数仍走磁盘（且根本不发 `functionPredicates(key, text)`）。
 * 3. **缓存不重复解析**：同一份正文第二次回放不再解析被调函数（只做顶层分派）；
 *    换正文 ⇒ +1 次；文本/路径不变 ⇒ `beginReplay` 复用同一个作用域（文本身份只比一次）。
 * 4. **两桶分开、各自有界**：`reset()` 清两桶；文本变化 ⇒ 新作用域（代数 +1）且
 *    override 条目数不随代数累积；两个并发回放（不同正文）各持各的桶，互不串味。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConditionExpr,
  FunctionAssignment,
  FunctionPredicates,
  FunctionReturn,
  Logger,
  ReplayValue,
  SnapshotArchive,
  VariableRef,
} from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { InlineManager } from '../src/inline';
import type { EvalContext, ValueReader } from '../src/evaluate';
import { StateReplayEngine } from '../src/engine';

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// 测试基建：从合成函数体行构造 FunctionPredicates（与 extractor 产物同构）
// ---------------------------------------------------------------------------

const ASSIGN_LINE_RE = /^(LOCAL|LOCALS|RESULT|RESULTS|ARG|ARGS)(?::(\d+))?\s*=(?!=)\s*(.*)$/i;

/** parseExpression 失败的行按"无解析记录"跳过（真实语料里语法怪的行不该让测试崩） */
function safeParse(text: string): ConditionExpr | null {
  try {
    return parseExpression(text);
  } catch {
    return null;
  }
}

/**
 * 在一份正文里按行首 `@NAME` 定位函数并建明细（**坐标就是这份正文的**）：
 * 与抽取器 override 分支同一口径（缓冲区自己的行号空间）。
 */
function buildDetail(name: string, filePath: string, text: string): FunctionPredicates | null {
  const lines = splitEolLines(text);
  const upper = name.toUpperCase();
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@([^(\s（]+)/.exec((lines[i] ?? '').trim());
    if (m && m[1]!.toUpperCase() === upper) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length; // 1 基闭区间末行 = 下一个函数头之前的行号
  for (let i = startIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('@')) {
      endIdx = i; // 0 基下标 i 的前一行是函数末行 ⇒ 1 基行号 = i
      break;
    }
  }
  const startLine = startIdx + 1;
  const endLine = endIdx;
  const predicates: FunctionPredicates['predicates'] = [];
  const assignments: FunctionAssignment[] = [];
  const returns: FunctionReturn[] = [];
  for (let line = startLine + 1; line <= endLine; line++) {
    const t = (lines[line - 1] ?? '').trim();
    if (t.length === 0 || t.startsWith(';') || t.startsWith('#')) continue;
    const cond = /^(IF|ELSEIF|SIF)\b\s*(.*)$/i.exec(t);
    if (cond) {
      const expr = safeParse(cond[2]!);
      if (!expr) continue;
      const kind = cond[1]!.toUpperCase() as 'IF' | 'ELSEIF' | 'SIF';
      predicates.push({ kind, text: cond[2]!, expr, line, depth: 0 });
      continue;
    }
    const assign = ASSIGN_LINE_RE.exec(t);
    if (assign) {
      const expr = safeParse(assign[3]!);
      if (!expr) continue;
      assignments.push({
        name: assign[1]!.toUpperCase() as FunctionAssignment['name'],
        index: assign[2] ? Number(assign[2]) : 0,
        expr,
        text: assign[3]!,
        line,
        context: [],
      });
      continue;
    }
    const ret = /^RETURNF\b\s*(.*)$/i.exec(t);
    if (ret) {
      const expr = safeParse(ret[1]!);
      if (!expr) continue;
      returns.push({ expr, text: ret[1]!, line });
    }
  }
  return {
    normalizedName: name,
    filePath,
    startLine,
    endLine,
    statements: [],
    assignments,
    predicates,
    returns,
  };
}

/** 合成视图读取器（`CFLAG:1` → 键 `CFLAG:1`） */
function viewReader(values: Record<string, number | string>): ValueReader {
  return (ref: VariableRef): ReplayValue => {
    const key = ref.indices.length > 0 ? `${ref.name}:${ref.indices.join(':')}` : ref.name;
    if (key in values) return { kind: 'value', value: values[key]! };
    return { kind: 'unknown', unknown: { code: 'missing-var', message: `no ${key}` } };
  };
}

function num(v: ReplayValue | null): number {
  if (!v || v.kind !== 'value' || typeof v.value !== 'number') {
    throw new Error(`expected numeric value, got ${JSON.stringify(v)}`);
  }
  return v.value;
}

// ---------------------------------------------------------------------------
// 测试数据：同文件 MAIN → HELPER；跨文件 MAIN → CROSS
// ---------------------------------------------------------------------------

const MAIN_FILE = 'D:/fake/kojo/fn-main.erb';
const CROSS_FILE = 'D:/fake/kojo/fn-cross.erb';

/** 盘上正文：HELPER 在 `CFLAG:1 == 1` 时返回 7 ⇒ MAIN 的谓词真 */
const DISK_MAIN = [
  '@MAIN()',
  '#FUNCTION',
  'IF HELPER() == 7',
  'RETURNF 1',
  'ENDIF',
  'RETURNF 0',
  '@HELPER()',
  '#FUNCTION',
  'IF CFLAG:1 == 1',
  'RETURNF 7',
  'ENDIF',
  'RETURNF 0',
].join('\n');

/** 缓冲区正文（未保存）：把被调函数 HELPER 的条件改成 == 2 ⇒ 返回 0 ⇒ MAIN 的谓词假 */
const BUFFER_MAIN_FALSE = DISK_MAIN.replace('IF CFLAG:1 == 1', 'IF CFLAG:1 == 2');

/** 另一份缓冲区（并发 / 正文变化用）：HELPER 条件改成 == 3 ⇒ 同样返回 0，但正文不同 */
const BUFFER_MAIN_OTHER = `${DISK_MAIN}\n; 另一份未保存正文（多一行注释，长度不同）`;

const DISK_CROSS_MAIN = [
  '@MAIN()',
  '#FUNCTION',
  'IF CROSS() == 7',
  'RETURNF 1',
  'ENDIF',
  'RETURNF 0',
].join('\n');
const DISK_CROSS = ['@CROSS()', '#FUNCTION', 'IF CFLAG:1 == 1', 'RETURNF 7', 'ENDIF', 'RETURNF 0'].join('\n');

// ---------------------------------------------------------------------------
// InlineManager 级：fake deps（函数名 → 文件；文件 → 正文）
// ---------------------------------------------------------------------------

interface ManagerWorld {
  /** 盘上正文：路径 → 文本 */
  readonly disk: Map<string, string>;
  /** 口上索引域：函数名大写 → 文件路径 */
  readonly index: Map<string, string>;
  /** `functionPredicates(name, text)` 的调用记录（只在第二形参出现时记） */
  readonly bufferCalls: Array<{ name: string; text: string }>;
  /** `functionPredicates(name)`（磁盘明细）调用记录 */
  readonly diskCalls: string[];
  /** `readFileLines(path)` 调用记录 */
  readonly reads: string[];
}

function makeWorld(
  disk: Record<string, string>,
  index: Record<string, string>,
): ManagerWorld {
  return {
    disk: new Map(Object.entries(disk)),
    index: new Map(Object.entries(index).map(([name, path]) => [name.toUpperCase(), path])),
    bufferCalls: [],
    diskCalls: [],
    reads: [],
  };
}

/** fake deps：override 分支按"这份文本里按 @NAME 定位"（与真抽取器同口径，不读盘） */
function makeManager(world: ManagerWorld): InlineManager {
  return new InlineManager({
    functionPredicates: async (name, textOverride) => {
      const key = name.toUpperCase();
      const path = world.index.get(key);
      if (textOverride !== undefined) {
        world.bufferCalls.push({ name: key, text: textOverride });
        return path === undefined ? null : buildDetail(key, path, textOverride);
      }
      world.diskCalls.push(key);
      if (path === undefined) return null;
      return buildDetail(key, path, world.disk.get(path) ?? '');
    },
    readFileLines: async (path) => {
      world.reads.push(path);
      const text = world.disk.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return splitEolLines(text);
    },
    log: { warn: () => {} },
  });
}

function bufferCallCount(world: ManagerWorld, name: string): number {
  return world.bufferCalls.filter((c) => c.name === name.toUpperCase()).length;
}

const VIEW_CFLAG1_IS_1 = viewReader({ 'CFLAG:1': 1 });

describe('InlineManager × override：按来源分桶', () => {
  it('同文件被调函数：override 回放取缓冲结果；随后不带 override 回放取磁盘结果（不污染）', async () => {
    const world = makeWorld({ [MAIN_FILE]: DISK_MAIN }, { MAIN: MAIN_FILE, HELPER: MAIN_FILE });
    const mgr = makeManager(world);
    const ctx: EvalContext = { read: VIEW_CFLAG1_IS_1 };

    // ---- 缓冲回放：HELPER 缓冲版 `CFLAG:1 == 2` ⇒ 0 ----
    const scope = mgr.beginReplay({ filePath: MAIN_FILE, text: BUFFER_MAIN_FALSE });
    expect(scope).not.toBeNull();
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, BUFFER_MAIN_FALSE)!, scope);
    expect(num(mgr.resolveCall('HELPER', [], ctx, 0, scope))).toBe(0);
    // 取证：override 回放一条都没写进磁盘桶
    expect(mgr.cacheStats().disk).toBe(0);
    expect(mgr.cacheStats().override).toBe(2); // MAIN（自身种入）+ HELPER

    // ---- 磁盘回放（无 override）：HELPER 盘上版 `CFLAG:1 == 1` ⇒ 7 ----
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, DISK_MAIN)!);
    expect(num(mgr.resolveCall('HELPER', [], ctx, 0))).toBe(7);
    expect(mgr.cacheStats().disk).toBe(2);
    // 磁盘桶此前是空的 ⇒ 这次必须重新取过 HELPER 的磁盘明细（不是拿缓冲结果凑数）
    expect(world.diskCalls.filter((n) => n === 'HELPER')).toHaveLength(2);
    expect(world.reads).toContain(MAIN_FILE);
    // 缓冲回放仍然只有一次 HELPER 的"文本模式明细"
    expect(bufferCallCount(world, 'HELPER')).toBe(1);
  });

  it('跨文件被调函数：override 只对同文件生效，跨文件仍磁盘（且不发文本模式调用）', async () => {
    const world = makeWorld(
      { [MAIN_FILE]: DISK_CROSS_MAIN, [CROSS_FILE]: DISK_CROSS },
      { MAIN: MAIN_FILE, CROSS: CROSS_FILE },
    );
    const mgr = makeManager(world);
    const ctx: EvalContext = { read: VIEW_CFLAG1_IS_1 };

    const buffer = `${DISK_CROSS_MAIN}\n; 缓冲区里只改了本文件（CROSS 在别的文件里）`;
    const scope = mgr.beginReplay({ filePath: MAIN_FILE, text: buffer });
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, buffer)!, scope);

    expect(num(mgr.resolveCall('CROSS', [], ctx, 0, scope))).toBe(7); // 磁盘版：CFLAG:1==1 → 7
    expect(bufferCallCount(world, 'CROSS')).toBe(0); // 跨文件根本不进 override 分支
    expect(world.reads).toContain(CROSS_FILE); // 而是读了磁盘
    expect(mgr.cacheStats().override).toBe(2); // 磁盘结果留在本次 replay 的桶里，不进磁盘桶
    expect(mgr.cacheStats().disk).toBe(0);
  });

  it('缓存不重复解析：同一文本第二次回放不再解析被调函数；换文本 +1', async () => {
    const world = makeWorld({ [MAIN_FILE]: DISK_MAIN }, { MAIN: MAIN_FILE, HELPER: MAIN_FILE });
    const mgr = makeManager(world);

    const first = mgr.beginReplay({ filePath: MAIN_FILE, text: BUFFER_MAIN_FALSE })!;
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, BUFFER_MAIN_FALSE)!, first);
    expect(bufferCallCount(world, 'HELPER')).toBe(1);

    // 同一份正文（同一个字符串对象）：复用同一个作用域，文本身份只比一次
    const again = mgr.beginReplay({ filePath: MAIN_FILE, text: BUFFER_MAIN_FALSE })!;
    expect(again).toBe(first);
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, BUFFER_MAIN_FALSE)!, again);
    expect(bufferCallCount(world, 'HELPER')).toBe(1); // 没重复解析
    expect(mgr.cacheStats().generation).toBe(1); // 代数没动

    // 正文变了（内容不同）：新作用域，被调函数重新解析一次
    const changed = mgr.beginReplay({ filePath: MAIN_FILE, text: BUFFER_MAIN_OTHER })!;
    expect(changed).not.toBe(first);
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, BUFFER_MAIN_OTHER)!, changed);
    expect(bufferCallCount(world, 'HELPER')).toBe(2);
    expect(mgr.cacheStats().generation).toBe(2);
  });

  it('reset() 清空两桶（磁盘 + override）', async () => {
    const world = makeWorld({ [MAIN_FILE]: DISK_MAIN }, { MAIN: MAIN_FILE, HELPER: MAIN_FILE });
    const mgr = makeManager(world);
    const scope = mgr.beginReplay({ filePath: MAIN_FILE, text: BUFFER_MAIN_FALSE })!;
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, BUFFER_MAIN_FALSE)!, scope);
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, DISK_MAIN)!);
    const before = mgr.cacheStats();
    expect(before.disk).toBeGreaterThan(0);
    expect(before.override).toBeGreaterThan(0);

    mgr.reset();
    expect(mgr.cacheStats()).toEqual({
      disk: 0,
      override: 0,
      overridePath: null,
      generation: before.generation,
    });
    // 清空后未预热 ⇒ resolveCall miss（回落 unknown('call')）
    expect(mgr.resolveCall('HELPER', [], { read: VIEW_CFLAG1_IS_1 }, 0)).toBeNull();
    // 再回放同一份正文：**新作用域**（不是 reset 前那个），被调函数重新解析（计数 +1）
    const fresh = mgr.beginReplay({ filePath: MAIN_FILE, text: BUFFER_MAIN_FALSE })!;
    expect(fresh).not.toBe(scope);
    await mgr.preanalyze(buildDetail('MAIN', MAIN_FILE, BUFFER_MAIN_FALSE)!, fresh);
    expect(bufferCallCount(world, 'HELPER')).toBe(2);
    expect(mgr.cacheStats().override).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// engine 级：replayFunction → resolveCall 闭包（本次 replay 私有作用域）
// ---------------------------------------------------------------------------

/** 一个角色 NO=49、CFLAG:1=1 的合成档 */
function archive(): SnapshotArchive {
  return {
    path: 'D:/fake/save.sav',
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
          {
            type: 'int-array-1d',
            key: 'CFLAG',
            saveLen: [100],
            cursor: [100],
            nonEmpty: 1,
            cells: [{ index: [1], value: 1 }],
            offset: 0,
          },
        ],
      },
    ],
    vars: [],
  };
}

const SAV = 'D:/fake/save.sav';

interface EngineWorld {
  readonly disk: Map<string, string>;
  readonly index: Map<string, string>;
  /** functionPredicates 调用记录（第二个字段只在 override 分派时出现） */
  readonly calls: Array<{ name: string; textOverride?: string }>;
  /** readFileText（磁盘正文）调用记录 */
  readonly reads: string[];
  /** 人为延迟（并发用例强制交错） */
  readonly delayMs: number;
}

function makeEngineWorld(
  disk: Record<string, string>,
  index: Record<string, string>,
  delayMs = 0,
): EngineWorld {
  return {
    disk: new Map(Object.entries(disk)),
    index: new Map(Object.entries(index).map(([name, path]) => [name.toUpperCase(), path])),
    calls: [],
    reads: [],
    delayMs,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fake engine deps（模拟抽取器口径）：
 * - `functionPredicates(name, text)`：按**给的这份正文**重定位（不读盘，缓冲区坐标）；
 * - `functionPredicates(name)`：按盘上正文；
 * - `memo`（可选，仅性能用例用）：按正文（字符串键）+ 函数名记忆明细，把假抽取器的
 *   全文行扫描成本从计时里摘出去。
 */
function makeEngine(
  world: EngineWorld,
  memo?: Map<string, Map<string, FunctionPredicates | null>>,
): StateReplayEngine {
  const detailFor = (key: string, path: string, text: string): FunctionPredicates | null => {
    if (!memo) return buildDetail(key, path, text);
    let byName = memo.get(text);
    if (!byName) {
      byName = new Map();
      memo.set(text, byName);
    }
    if (byName.has(key)) return byName.get(key) ?? null;
    const detail = buildDetail(key, path, text);
    byName.set(key, detail);
    return detail;
  };
  return new StateReplayEngine({
    log: silent,
    parseArchive: async () => archive(),
    functionPredicates: async (name, textOverride) => {
      if (world.delayMs > 0) await sleep(world.delayMs);
      world.calls.push({ name, ...(textOverride === undefined ? {} : { textOverride }) });
      const key = name.toUpperCase();
      const path = world.index.get(key);
      if (path === undefined) return null;
      if (textOverride !== undefined) return detailFor(key, path, textOverride);
      const text = world.disk.get(path);
      return text === undefined ? null : detailFor(key, path, text);
    },
    getSchemaLookup: () => undefined,
    readFileText: async (path) => {
      if (world.delayMs > 0) await sleep(world.delayMs);
      world.reads.push(path);
      const text = world.disk.get(path);
      if (text === undefined) throw new Error(`not found: ${path}`);
      return text;
    },
  });
}

describe('engine × override：内联求值吃缓冲区，磁盘回放零污染', () => {
  it('带 override 回放取缓冲结论；随后不带 override 必须取磁盘结论（三重取证）', async () => {
    const world = makeEngineWorld({ [MAIN_FILE]: DISK_MAIN }, { MAIN: MAIN_FILE, HELPER: MAIN_FILE });
    const engine = makeEngine(world);
    const view = await engine.createView(SAV, 49);

    // ---- 缓冲回放：HELPER 缓冲版 ⇒ 0 ≠ 7 ⇒ 谓词假 ----
    const fromBuffer = (await engine.replayFunction(view, 'MAIN', { textOverride: BUFFER_MAIN_FALSE }))!;
    expect(fromBuffer.predicates[0]!.outcome).toEqual({ kind: 'false' });
    // 取证 1：override 回放一条都没写进磁盘桶
    expect(engine.inlineCacheStats().disk).toBe(0);
    // 取证 2：这次回放**没碰磁盘**（lineCache 里没有这份文件；同文件被调函数也只吃缓冲版）
    expect(engine.cacheStats().chars).toBe(0);
    expect(world.reads).toHaveLength(0);
    // 取证 3（主判据）：随后不带 override ⇒ 磁盘结论（HELPER 磁盘版 ⇒ 7 ⇒ 谓词真）
    const fromDisk = (await engine.replayFunction(view, 'MAIN'))!;
    expect(fromDisk.predicates[0]!.outcome).toEqual({ kind: 'true' });
    expect(engine.inlineCacheStats().disk).toBeGreaterThan(0);
    expect(world.reads).toContain(MAIN_FILE); // 磁盘正文被重新取过
    // 文本模式分派只发生在缓冲回放：MAIN 顶层一次 + HELPER 一次；磁盘回放一次都没加
    const textCalls = world.calls.filter((c) => c.textOverride !== undefined).map((c) => c.name.toUpperCase());
    expect(textCalls.filter((n) => n === 'MAIN')).toHaveLength(1);
    expect(textCalls.filter((n) => n === 'HELPER')).toHaveLength(1);
  });

  it('同一份缓冲正文回放两次：被调函数只解析一次（顶层分派每次一次，契约使然）', async () => {
    const world = makeEngineWorld({ [MAIN_FILE]: DISK_MAIN }, { MAIN: MAIN_FILE, HELPER: MAIN_FILE });
    const engine = makeEngine(world);
    const view = await engine.createView(SAV, 49);

    await engine.replayFunction(view, 'MAIN', { textOverride: BUFFER_MAIN_FALSE });
    await engine.replayFunction(view, 'MAIN', { textOverride: BUFFER_MAIN_FALSE });
    const textCalls = world.calls.filter((c) => c.textOverride !== undefined).map((c) => c.name.toUpperCase());
    expect(textCalls.filter((n) => n === 'HELPER')).toHaveLength(1); // 被调函数没重复解析
    expect(textCalls.filter((n) => n === 'MAIN')).toHaveLength(2); // 顶层每个 replay 分派一次
    expect(engine.inlineCacheStats().generation).toBe(1); // 同一文本 ⇒ 同一作用域
  });

  it('并发两个 override 回放（不同正文）互不串味：各取各的结论', async () => {
    const world = makeEngineWorld(
      { [MAIN_FILE]: DISK_MAIN },
      { MAIN: MAIN_FILE, HELPER: MAIN_FILE },
      2, // 每步 await 都让出：强制两个回放交错
    );
    const engine = makeEngine(world);
    const view = await engine.createView(SAV, 49);

    // 缓冲 A = 盘上正文（HELPER ⇒ 7 ⇒ 真）；缓冲 B = 改过条件（HELPER ⇒ 0 ⇒ 假）
    const [a, b] = await Promise.all([
      engine.replayFunction(view, 'MAIN', { textOverride: DISK_MAIN }),
      engine.replayFunction(view, 'MAIN', { textOverride: BUFFER_MAIN_FALSE }),
    ]);
    expect(a!.predicates[0]!.outcome).toEqual({ kind: 'true' });
    expect(b!.predicates[0]!.outcome).toEqual({ kind: 'false' });
    // 两个不同正文 ⇒ 两个作用域；管理器只留最后一个，但两边的桶各自独立
    expect(engine.inlineCacheStats().generation).toBe(2);
    expect(engine.inlineCacheStats().override).toBeLessThanOrEqual(2); // 每个桶里 MAIN + HELPER
    expect(engine.inlineCacheStats().disk).toBe(0); // 并发也没写磁盘桶
  });

  it('文本变化 ⇒ 新作用域、旧桶丢弃：override 条目数不随代数累积（常驻有界）', async () => {
    const world = makeEngineWorld({ [MAIN_FILE]: DISK_MAIN }, { MAIN: MAIN_FILE, HELPER: MAIN_FILE });
    const engine = makeEngine(world);
    const view = await engine.createView(SAV, 49);

    const texts = [BUFFER_MAIN_FALSE, BUFFER_MAIN_OTHER, `${BUFFER_MAIN_OTHER}; v3`];
    for (let i = 0; i < texts.length; i++) {
      await engine.replayFunction(view, 'MAIN', { textOverride: texts[i]! });
      const stats = engine.inlineCacheStats();
      expect(stats.generation).toBe(i + 1); // 每次换正文 = 新作用域
      expect(stats.override).toBe(2); // MAIN + HELPER，**不是** 2*(i+1)
      expect(stats.disk).toBe(0);
    }
    expect(engine.cacheStats().chars).toBe(0); // 缓冲正文从未进 lineCache
  });
});

