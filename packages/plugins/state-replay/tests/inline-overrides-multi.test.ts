/**
 * 内联解释器 × 多文件缓冲文本（2026-11-06 状态回放边界批 2 · 车道 I）。
 *
 * 钉住的口径（纯 fake deps，不碰真语料）：
 * 1. **两文件 override 各自生效**：`beginReplay({ overrides: [...] })` 里列出的文件，
 *    其被调函数按**自己的缓冲正文** analyze；磁盘基线不同值证明"确实吃了缓冲"。
 * 2. **只列一个文件 ⇒ 另一个文件读盘**（且根本不发文本模式 `functionPredicates(key, text)`）；
 *    集合里没列出的第三个文件也照旧读盘（桶在本次 replay 内按需建，`overridden=false`）。
 * 3. **集合身份**（`pathKey + text` 逐项 `===`，换顺序不算变）：内容不变 ⇒ 复用同一作用域，
 *    被调函数 0 复算；`pathKey` 折叠大小写 / 分隔符同样不算变。
 * 4. **单文件文本变只重建该文件的桶**：另一文件的桶对象按引用沿用（直接比桶身份）。
 * 5. **跨文件同名函数不串味**：同名函数按索引里的 `filePath` 选桶；两个世界（同名函数分别
 *    属于 A / B）用**同一份 override 集合**各取各的正文。
 * 6. **旧单文件 API 兼容**：`{ filePath, text }` 与"只有一条的 overrides"是同一身份。
 * 7. **磁盘零污染 / reset**：override 结果只进作用域桶（`inlineCacheStats().disk === 0`），
 *    随后无 override 回放取磁盘结论；`reset()` 清两桶。
 * 8. **性能**：同一集合下 N 个被调函数（跨 2 文件）的文本模式调用 = 顶层分派 1 次 +
 *    每个被调函数 1 次；第二轮 0 复算；只有改文本的那份文件重解析；带 override 与纯磁盘
 *    耗时同量级（ms 随跑随打）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConditionExpr,
  FunctionAssignment,
  FunctionPredicates,
  FunctionReturn,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { InlineManager, type InlineManagerDeps } from '../src/inline';
import type { EvalContext, ValueReader } from '../src/evaluate';

// ---------------------------------------------------------------------------
// 测试基建：从合成函数体行构造 FunctionPredicates（与 extractor 产物同构）
// ---------------------------------------------------------------------------

const ASSIGN_LINE_RE = /^(LOCAL|LOCALS|RESULT|RESULTS|ARG|ARGS)(?::(\d+))?\s*=(?!=)\s*(.*)$/i;

function safeParse(text: string): ConditionExpr | null {
  try {
    return parseExpression(text);
  } catch {
    return null;
  }
}

/** 在一份正文里按行首 `@NAME` 定位函数并建明细（坐标就是这份正文的） */
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
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('@')) {
      endIdx = i;
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

const CTX: EvalContext = { read: viewReader({ 'CFLAG:1': 1 }) };

// ---------------------------------------------------------------------------
// 测试数据：A / B 两份可编辑文件 + C 一份只在盘上的文件
// ---------------------------------------------------------------------------

const A_FILE = 'D:/fake/kojo/multi-a.erb';
const B_FILE = 'D:/fake/kojo/multi-b.erb';
const C_FILE = 'D:/fake/kojo/multi-c.erb';

/**
 * A_TOP 的调用面横跨三处：A 自己的 A_HELPER / A_SECOND、B 的 B_HELPER、以及同名函数 TWIN
 * （TWIN 在 A / B 里各有一份，按索引决定属于哪个文件 —— 不串味用例的核心）。
 */
const DISK_A = [
  '@A_TOP()',
  '#FUNCTION',
  'IF A_HELPER() == 7',
  'RETURNF 1',
  'ENDIF',
  'IF A_SECOND() == 7',
  'RETURNF 4',
  'ENDIF',
  'IF B_HELPER() == 7',
  'RETURNF 2',
  'ENDIF',
  'IF TWIN() == 100',
  'RETURNF 3',
  'ENDIF',
  'RETURNF 0',
  '@A_HELPER()',
  '#FUNCTION',
  'IF CFLAG:1 == 1',
  'RETURNF 7',
  'ENDIF',
  'RETURNF 0',
  '@A_SECOND()',
  '#FUNCTION',
  'IF CFLAG:1 == 1',
  'RETURNF 7',
  'ENDIF',
  'RETURNF 0',
  '@TWIN()',
  '#FUNCTION',
  'RETURNF 100',
].join('\n');

const DISK_B = [
  '@B_TOP()',
  '#FUNCTION',
  'IF B_HELPER() == 7',
  'RETURNF 1',
  'ENDIF',
  'RETURNF 0',
  '@B_HELPER()',
  '#FUNCTION',
  'IF CFLAG:1 == 1',
  'RETURNF 7',
  'ENDIF',
  'RETURNF 0',
  '@TWIN()',
  '#FUNCTION',
  'RETURNF 200',
].join('\n');

const DISK_C = [
  '@C_TOP()',
  '#FUNCTION',
  'IF C_HELPER() == 7',
  'RETURNF 1',
  'ENDIF',
  'RETURNF 0',
  '@C_HELPER()',
  '#FUNCTION',
  'IF CFLAG:1 == 1',
  'RETURNF 7',
  'ENDIF',
  'RETURNF 0',
].join('\n');

/** A 的缓冲正文：A_HELPER 的 RETURNF 7 → 5（A_SECOND / TWIN 不动） */
const BUF_A = DISK_A.replace('RETURNF 7', 'RETURNF 5');
/** B 的缓冲正文：B_HELPER 的 RETURNF 7 → 9（TWIN 仍是 200） */
const BUF_B = DISK_B.replace('RETURNF 7', 'RETURNF 9');

// ---------------------------------------------------------------------------
// fake deps（函数名 → 文件；文件 → 正文）+ 调用记录
// ---------------------------------------------------------------------------

interface World {
  readonly disk: Map<string, string>;
  /** 口上索引域：函数名大写 → 文件路径 */
  readonly index: Map<string, string>;
  /** `functionPredicates(name, text)` 调用记录（只在第二形参出现时记） */
  readonly textCalls: Array<{ name: string; text: string }>;
  /** `functionPredicates(name)`（磁盘明细）调用记录 */
  readonly diskCalls: string[];
  /** `readFileLines(path)` 调用记录 */
  readonly reads: string[];
  /** 模拟 engine 的 lineCache（同一份磁盘正文只切一次；让耗时对照公平） */
  readonly lineMemo: Map<string, string[]>;
}

function makeWorld(disk: Record<string, string>, index: Record<string, string>): World {
  return {
    disk: new Map(Object.entries(disk)),
    index: new Map(Object.entries(index).map(([name, path]) => [name.toUpperCase(), path])),
    textCalls: [],
    diskCalls: [],
    reads: [],
    lineMemo: new Map(),
  };
}

function multiWorld(): World {
  return makeWorld(
    { [A_FILE]: DISK_A, [B_FILE]: DISK_B, [C_FILE]: DISK_C },
    {
      A_TOP: A_FILE,
      A_HELPER: A_FILE,
      A_SECOND: A_FILE,
      B_TOP: B_FILE,
      B_HELPER: B_FILE,
      TWIN: A_FILE,
      C_TOP: C_FILE,
      C_HELPER: C_FILE,
    },
  );
}

function makeDeps(world: World): InlineManagerDeps {
  return {
    functionPredicates: async (name, textOverride) => {
      const key = name.toUpperCase();
      const filePath = world.index.get(key);
      if (textOverride !== undefined) {
        world.textCalls.push({ name: key, text: textOverride });
        return filePath === undefined ? null : buildDetail(key, filePath, textOverride);
      }
      world.diskCalls.push(key);
      if (filePath === undefined) return null;
      return buildDetail(key, filePath, world.disk.get(filePath) ?? '');
    },
    readFileLines: async (filePath) => {
      world.reads.push(filePath);
      const text = world.disk.get(filePath);
      if (text === undefined) throw new Error(`no such file: ${filePath}`);
      const memo = world.lineMemo.get(filePath);
      if (memo !== undefined) return memo;
      const lines = splitEolLines(text);
      world.lineMemo.set(filePath, lines);
      return lines;
    },
    log: { warn: () => {} },
  };
}

interface Rig {
  readonly mgr: InlineManager;
  readonly deps: InlineManagerDeps;
}

function makeRig(world: World): Rig {
  const deps = makeDeps(world);
  return { mgr: new InlineManager(deps), deps };
}

function textCallsOf(world: World, name: string): Array<{ name: string; text: string }> {
  const upper = name.toUpperCase();
  return world.textCalls.filter((c) => c.name === upper);
}

function textCallCount(world: World, name: string): number {
  return textCallsOf(world, name).length;
}

/** 一份正文的「行提示」（engine 已经切好的那份） */
function hintOf(filePath: string, text: string): { pathKey: string; lines: readonly string[] } {
  return { pathKey: pathKey(filePath), lines: splitEolLines(text) };
}

const TOP_A_BUFFER = buildDetail('A_TOP', A_FILE, BUF_A)!;

// ---------------------------------------------------------------------------
// 1. 两文件 override 各自生效 / 2. 未列出的文件读盘
// ---------------------------------------------------------------------------

describe('InlineManager × 多文件 override：按文件分桶', () => {
  it('两文件 override 各自生效（磁盘基线同函数不同值作对照）', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const scope = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B },
      ],
    })!;
    expect(scope).not.toBeNull();
    await mgr.preanalyze(TOP_A_BUFFER, scope, hintOf(A_FILE, BUF_A));

    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope))).toBe(5); // A 缓冲
    expect(num(mgr.resolveCall('A_SECOND', [], CTX, 0, scope))).toBe(7); // A 缓冲里没改
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, scope))).toBe(9); // B 缓冲（跨文件）
    expect(num(mgr.resolveCall('TWIN', [], CTX, 0, scope))).toBe(100); // 索引说 TWIN 在 A
    expect(world.reads).toHaveLength(0); // 全程没读盘
    expect(mgr.cacheStats().disk).toBe(0);
    expect(textCallCount(world, 'A_HELPER')).toBe(1);
    expect(textCallCount(world, 'B_HELPER')).toBe(1);
    const stats = mgr.overrideFileStats();
    expect(stats).toHaveLength(2);
    expect(stats.every((s) => s.overridden)).toBe(true);

    // 磁盘基线：同一批函数 → 7 / 7 / 7 / 100（A_HELPER 与 B_HELPER 确实不同）
    const diskWorld = multiWorld();
    const diskRig = makeRig(diskWorld);
    await diskRig.mgr.preanalyze(buildDetail('A_TOP', A_FILE, DISK_A)!);
    expect(num(diskRig.mgr.resolveCall('A_HELPER', [], CTX, 0))).toBe(7);
    expect(num(diskRig.mgr.resolveCall('B_HELPER', [], CTX, 0))).toBe(7);
  });

  it('只列一个文件 ⇒ 该文件吃缓冲、另一文件读盘；未列出的第三份文件也读盘', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const scope = mgr.beginReplay({ overrides: [{ filePath: A_FILE, text: BUF_A }] })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope, hintOf(A_FILE, BUF_A));

    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope))).toBe(5); // A 缓冲
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, scope))).toBe(7); // B 走磁盘
    expect(textCallCount(world, 'B_HELPER')).toBe(0); // B 根本不进文本模式分派
    expect(world.reads).toContain(B_FILE);
    expect(mgr.cacheStats().disk).toBe(0); // 磁盘结果也在本次 replay 的桶里

    const stats = mgr.overrideFileStats();
    const byPath = new Map(stats.map((s) => [s.pathKey, s]));
    expect(byPath.get(pathKey(A_FILE))!.overridden).toBe(true);
    expect(byPath.get(pathKey(B_FILE))!.overridden).toBe(false);

    // 集合里根本没列 C：C 的函数照旧读盘，进本 replay 的 C 桶（不是磁盘桶）
    await mgr.preanalyze(buildDetail('C_TOP', C_FILE, DISK_C)!, scope);
    expect(num(mgr.resolveCall('C_HELPER', [], CTX, 0, scope))).toBe(7);
    expect(world.reads).toContain(C_FILE);
    expect(mgr.cacheStats().disk).toBe(0);
    expect(mgr.overrideFileStats().some((s) => s.pathKey === pathKey(C_FILE) && !s.overridden)).toBe(true);
  });

  it('同文件 N 个被调函数各解析一次；集合不变的第二轮 0 复算', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const overrides = [
      { filePath: A_FILE, text: BUF_A },
      { filePath: B_FILE, text: BUF_B },
    ];
    const first = mgr.beginReplay({ overrides })!;
    await mgr.preanalyze(TOP_A_BUFFER, first, hintOf(A_FILE, BUF_A));
    // A 文件内两个被调函数各一次；跨文件 B 一次
    expect(textCallCount(world, 'A_HELPER')).toBe(1);
    expect(textCallCount(world, 'A_SECOND')).toBe(1);
    expect(textCallCount(world, 'B_HELPER')).toBe(1);
    const entriesAfterFirst = mgr.cacheStats().override;

    const again = mgr.beginReplay({ overrides });
    expect(again).toBe(first); // 同一作用域（桶不重建）
    await mgr.preanalyze(TOP_A_BUFFER, again, hintOf(A_FILE, BUF_A));
    expect(textCallCount(world, 'A_HELPER')).toBe(1); // 0 复算
    expect(textCallCount(world, 'A_SECOND')).toBe(1);
    expect(textCallCount(world, 'B_HELPER')).toBe(1);
    expect(mgr.cacheStats().override).toBe(entriesAfterFirst);
    expect(mgr.cacheStats().generation).toBe(1);
  });

  it('集合身份：换顺序 / 换 path 写法（大小写+分隔符）都不算变；换文本才算', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const scope = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B },
      ],
    })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope, hintOf(A_FILE, BUF_A));

    // 换顺序：集合内容没变 ⇒ 复用同一作用域（顺序不参与身份）
    const reordered = mgr.beginReplay({
      overrides: [
        { filePath: B_FILE, text: BUF_B },
        { filePath: A_FILE, text: BUF_A },
      ],
    });
    expect(reordered).toBe(scope);
    expect(mgr.cacheStats().generation).toBe(1);

    // 换 path 写法（大小写 / 反斜杠）：pathKey 折叠后同一文件 ⇒ 也不算变
    const variant = 'd:\\FAKE\\kojo\\MULTI-A.ERB';
    expect(pathKey(variant)).toBe(pathKey(A_FILE));
    const respelled = mgr.beginReplay({
      overrides: [
        { filePath: variant, text: BUF_A },
        { filePath: B_FILE, text: BUF_B },
      ],
    });
    expect(respelled).toBe(scope);
    expect(mgr.cacheStats().generation).toBe(1);

    // 文本变了才算变
    const changed = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: `${BUF_B}\n; v2` },
      ],
    });
    expect(changed).not.toBe(scope);
    expect(mgr.cacheStats().generation).toBe(2);
  });

  it('单文件文本变：只重建该文件的桶，另一文件的桶按引用沿用（不重解析）', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const scope1 = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B },
      ],
    })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope1, hintOf(A_FILE, BUF_A));
    expect(textCallCount(world, 'A_HELPER')).toBe(1);
    expect(textCallCount(world, 'B_HELPER')).toBe(1);

    const BUF_B_V2 = `${BUF_B}\n; 另一份未保存正文（B 文件多一行注释）`;
    const scope2 = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B_V2 },
      ],
    })!;
    expect(scope2).not.toBe(scope1);
    // 桶身份：A 的桶是同一个对象（引用沿用），B 的桶是新对象
    expect(scope2.buckets.get(pathKey(A_FILE))).toBe(scope1.buckets.get(pathKey(A_FILE)));
    expect(scope2.buckets.get(pathKey(B_FILE))).not.toBe(scope1.buckets.get(pathKey(B_FILE)));

    await mgr.preanalyze(TOP_A_BUFFER, scope2, hintOf(A_FILE, BUF_A));
    expect(textCallCount(world, 'A_HELPER')).toBe(1); // A 没重解析
    expect(textCallCount(world, 'A_SECOND')).toBe(1);
    expect(textCallCount(world, 'B_HELPER')).toBe(2); // 只有 B 重解析
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope2))).toBe(5);
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, scope2))).toBe(9);
  });

  it('跨文件同名函数不串味：同名 TWIN 按索引里的 filePath 选桶（两世界同一 override 集合）', async () => {
    // 世界一：TWIN 属于 A（A 里 TWIN → 100，B 里 TWIN → 200）
    const worldA = multiWorld();
    const rigA = makeRig(worldA);
    const overrides = [
      { filePath: A_FILE, text: BUF_A },
      { filePath: B_FILE, text: BUF_B },
    ];
    const scopeA = rigA.mgr.beginReplay({ overrides })!;
    await rigA.mgr.preanalyze(TOP_A_BUFFER, scopeA, hintOf(A_FILE, BUF_A));
    expect(num(rigA.mgr.resolveCall('TWIN', [], CTX, 0, scopeA))).toBe(100);
    expect(textCallsOf(worldA, 'TWIN').map((c) => c.text)).toEqual([BUF_A]); // 只吃 A 的正文

    // 世界二：同一份 override 集合，索引改指 B ⇒ TWIN 取 B 的正文（200），不串 A
    const worldB = multiWorld();
    worldB.index.set('TWIN', B_FILE);
    const rigB = makeRig(worldB);
    const scopeB = rigB.mgr.beginReplay({ overrides })!;
    await rigB.mgr.preanalyze(TOP_A_BUFFER, scopeB, hintOf(A_FILE, BUF_A));
    expect(num(rigB.mgr.resolveCall('TWIN', [], CTX, 0, scopeB))).toBe(200);
    expect(textCallsOf(worldB, 'TWIN').map((c) => c.text)).toEqual([BUF_B]);
    expect(textCallCount(worldB, 'A_HELPER')).toBe(1); // A 的其它被调函数仍吃 A 缓冲
  });

  it('旧句柄独立：集合变化后旧作用域仍按它自己的桶给结论（互不覆盖）', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const scope1 = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B },
      ],
    })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope1, hintOf(A_FILE, BUF_A));
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, scope1))).toBe(9);

    // 新 replay：A 不变（桶沿用），B 改成另一个值（新桶）
    const BUF_B_11 = BUF_B.replace('RETURNF 9', 'RETURNF 11');
    const scope2 = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B_11 },
      ],
    })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope2, hintOf(A_FILE, BUF_A));
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, scope2))).toBe(11);
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope2))).toBe(5); // A 桶是同对象
    // 旧句柄不受新 replay 影响（各持各的桶）
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, scope1))).toBe(9);
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope1))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 3. 旧 API 兼容 / 空集合 / 磁盘零污染 / reset
// ---------------------------------------------------------------------------

describe('InlineManager × 多文件 override：兼容与边界', () => {
  it('旧单文件 API 兼容：{ filePath, text } 与单条 overrides 是同一身份', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const legacy = mgr.beginReplay({ filePath: A_FILE, text: BUF_A })!;
    expect(legacy).not.toBeNull();
    const multiOne = mgr.beginReplay({ overrides: [{ filePath: A_FILE, text: BUF_A }] });
    expect(multiOne).toBe(legacy); // 归一后同一集合 ⇒ 同一作用域

    await mgr.preanalyze(TOP_A_BUFFER, legacy, hintOf(A_FILE, BUF_A));
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, legacy))).toBe(5);
    expect(num(mgr.resolveCall('B_HELPER', [], CTX, 0, legacy))).toBe(7); // 没列出 B ⇒ 磁盘
    expect(mgr.cacheStats().overridePath).toBe(A_FILE);
    expect(mgr.cacheStats().generation).toBe(1);
  });

  it('同一文件两种写法列两次 ⇒ 归一成一条（pathKey 折叠 + 后见文本胜出）', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const variant = 'd:\\FAKE\\kojo\\MULTI-A.ERB';
    const scope = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: variant, text: DISK_A }, // 同一 pathKey：后见胜出
      ],
    })!;
    await mgr.preanalyze(buildDetail('A_TOP', A_FILE, DISK_A)!, scope, hintOf(A_FILE, DISK_A));
    expect(mgr.overrideFileStats().filter((s) => s.overridden)).toHaveLength(1); // 归一成一条
    expect(mgr.cacheStats().generation).toBe(1);
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope))).toBe(7); // 用的是后见的那份
    // 归一后同一集合 ⇒ 单条写法复用同一作用域
    expect(mgr.beginReplay({ overrides: [{ filePath: variant, text: DISK_A }] })).toBe(scope);
  });

  it('override 文件里同名函数被删 / 改名 ⇒ 落 null，不回落到磁盘', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    // 缓冲正文里删掉 A_HELPER 整个函数（A_TOP 仍在、仍调用它）
    const bufA = DISK_A.replace(
      '@A_HELPER()\n#FUNCTION\nIF CFLAG:1 == 1\nRETURNF 7\nENDIF\nRETURNF 0\n',
      '',
    );
    expect(bufA).not.toContain('@A_HELPER()');
    const scope = mgr.beginReplay({ overrides: [{ filePath: A_FILE, text: bufA }] })!;
    await mgr.preanalyze(buildDetail('A_TOP', A_FILE, bufA)!, scope, hintOf(A_FILE, bufA));
    expect(mgr.resolveCall('A_HELPER', [], CTX, 0, scope)).toBeNull();
    const calls = textCallsOf(world, 'A_HELPER');
    expect(calls).toHaveLength(1); // 试过一次
    expect(calls[0]!.text).toBe(bufA); // 用的是缓冲正文（不回落磁盘）

    // 同一集合第二轮：命中"查过但不在"的 null 记录，不重试
    const again = mgr.beginReplay({ overrides: [{ filePath: A_FILE, text: bufA }] })!;
    await mgr.preanalyze(buildDetail('A_TOP', A_FILE, bufA)!, again, hintOf(A_FILE, bufA));
    expect(textCallsOf(world, 'A_HELPER')).toHaveLength(1);
  });

  it('无 override / 空集合 ⇒ null（走磁盘命名空间）', () => {
    const { mgr } = makeRig(multiWorld());
    expect(mgr.beginReplay()).toBeNull();
    expect(mgr.beginReplay(null)).toBeNull();
    expect(mgr.beginReplay({ overrides: [] })).toBeNull();
    expect(mgr.cacheStats().generation).toBe(0);
  });

  it('磁盘零污染：override 回放磁盘桶 0 条、正文不读盘；随后无 override 回放取磁盘结论', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const scope = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: BUF_A },
        { filePath: B_FILE, text: BUF_B },
      ],
    })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope, hintOf(A_FILE, BUF_A));
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, scope))).toBe(5);
    expect(mgr.cacheStats().disk).toBe(0);
    expect(world.reads).toHaveLength(0); // 缓冲正文从未进 readFileLines
    expect(world.lineMemo.size).toBe(0); // 也没被切行进 lineCache

    // 同一管理器、不带 override ⇒ 磁盘结论（A_HELPER 7），磁盘桶此时才有货
    await mgr.preanalyze(buildDetail('A_TOP', A_FILE, DISK_A)!);
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0))).toBe(7);
    expect(mgr.cacheStats().disk).toBeGreaterThan(0);
    expect(world.reads).toContain(A_FILE);
    expect(textCallCount(world, 'A_HELPER')).toBe(1); // override 分支没被重复调用
  });

  it('reset() 清两桶：磁盘 + override 全 0、代数不动、旧作用域不复活', async () => {
    const world = multiWorld();
    const { mgr } = makeRig(world);
    const overrides = [
      { filePath: A_FILE, text: BUF_A },
      { filePath: B_FILE, text: BUF_B },
    ];
    const scope = mgr.beginReplay({ overrides })!;
    await mgr.preanalyze(TOP_A_BUFFER, scope, hintOf(A_FILE, BUF_A));
    await mgr.preanalyze(buildDetail('A_TOP', A_FILE, DISK_A)!);
    const before = mgr.cacheStats();
    expect(before.disk).toBeGreaterThan(0);
    expect(before.override).toBeGreaterThan(0);
    expect(mgr.overrideFileStats().length).toBeGreaterThan(0);

    mgr.reset();
    expect(mgr.cacheStats()).toEqual({
      disk: 0,
      override: 0,
      overridePath: null,
      generation: before.generation,
    });
    expect(mgr.overrideFileStats()).toEqual([]);
    expect(mgr.resolveCall('A_HELPER', [], CTX, 0, scope)).toBeNull(); // 旧作用域桶已清
    expect(mgr.resolveCall('A_HELPER', [], CTX, 0)).toBeNull();

    // 同一集合再领作用域 ⇒ 新对象，被调函数重新解析一次
    const fresh = mgr.beginReplay({ overrides })!;
    expect(fresh).not.toBe(scope);
    await mgr.preanalyze(TOP_A_BUFFER, fresh, hintOf(A_FILE, BUF_A));
    expect(textCallCount(world, 'A_HELPER')).toBe(2);
    expect(num(mgr.resolveCall('A_HELPER', [], CTX, 0, fresh))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4. 性能：文本模式调用计数 + ms（跨 2 文件 N 个被调函数）
// ---------------------------------------------------------------------------

/** 造一份"大函数体"文件：TOP 调 N 个跨文件被调函数，另 N 个同文件被调函数 */
function bigText(prefix: string, siblingNames: readonly string[], ownCount: number): { text: string; names: string[] } {
  const lines: string[] = [`@${prefix}_TOP()`, '#FUNCTION'];
  const names: string[] = [];
  for (let i = 0; i < ownCount; i++) names.push(`${prefix}_H${i}`);
  for (const n of [...names, ...siblingNames]) {
    lines.push(`IF ${n}() == 7`, 'RETURNF 1', 'ENDIF');
  }
  lines.push('RETURNF 0');
  for (const n of names) {
    lines.push(`@${n}()`, '#FUNCTION', 'IF CFLAG:1 == 1', 'RETURNF 7', 'ENDIF', 'RETURNF 0');
  }
  return { text: lines.join('\n'), names };
}

describe('InlineManager × 多文件 override：性能读数', () => {
  it('N 个被调函数（跨 2 文件）文本模式调用 = 顶层 1 + 每函数 1；第二轮 0 复算；单文件改只重解析该文件；耗时同量级', async () => {
    const PER_FILE = 60;
    const BIG_A = bigText('AA', [], PER_FILE); // 先占位，B 的名字后面补
    const BIG_B = bigText('BB', [], PER_FILE);
    // A_TOP 同时调用 AA_H* 与 BB_H*（跨文件）
    const bigA = bigText('AA', BIG_B.names, PER_FILE);
    const bigB = BIG_B;
    const totalCallees = PER_FILE * 2;

    const diskMap: Record<string, string> = { [A_FILE]: bigA.text, [B_FILE]: bigB.text };
    const indexMap: Record<string, string> = { AA_TOP: A_FILE };
    for (const n of bigA.names) indexMap[n] = A_FILE;
    for (const n of bigB.names) indexMap[n] = B_FILE;

    const world = makeWorld(diskMap, indexMap);
    const { mgr, deps } = makeRig(world);
    const overrides = [
      { filePath: A_FILE, text: bigA.text },
      { filePath: B_FILE, text: bigB.text },
    ];
    const scope = mgr.beginReplay({ overrides })!;
    const hint = hintOf(A_FILE, bigA.text);

    // 顶层分派（engine 每 replay 一次；这里显式模拟）→ 计入 1 次文本模式调用
    await deps.functionPredicates('AA_TOP', bigA.text);
    const t0 = performance.now();
    await mgr.preanalyze(buildDetail('AA_TOP', A_FILE, bigA.text)!, scope, hint);
    const overrideMs = performance.now() - t0;

    const calleeCalls = (): number => world.textCalls.filter((c) => c.name !== 'AA_TOP').length;
    expect(calleeCalls()).toBe(totalCallees); // 每个被调函数恰 1 次
    expect(textCallCount(world, 'AA_TOP')).toBe(1); // 顶层 1 次
    const aaCalls = BIG_A.names.reduce((n, name) => n + textCallCount(world, name), 0);
    const bbCalls = bigB.names.reduce((n, name) => n + textCallCount(world, name), 0);
    expect(aaCalls).toBe(PER_FILE);
    expect(bbCalls).toBe(PER_FILE);

    // ---- 第二轮：集合不变（同一批字符串）⇒ 同一作用域，被调函数 0 复算 ----
    const scope2 = mgr.beginReplay({ overrides })!;
    expect(scope2).toBe(scope);
    await deps.functionPredicates('AA_TOP', bigA.text); // 顶层仍分派一次
    const t2 = performance.now();
    await mgr.preanalyze(buildDetail('AA_TOP', A_FILE, bigA.text)!, scope2, hint);
    const warmMs = performance.now() - t2;
    expect(calleeCalls()).toBe(totalCallees); // 没涨 ⇒ 0 复算
    expect(textCallCount(world, 'AA_TOP')).toBe(2);

    // ---- 只有 B 的文本变 ⇒ 只有 B 的桶重解析，A 一个都没动 ----
    const bigB2Text = `${bigB.text}\n; 另一份未保存正文（B）`;
    const scope3 = mgr.beginReplay({
      overrides: [
        { filePath: A_FILE, text: bigA.text },
        { filePath: B_FILE, text: bigB2Text },
      ],
    })!;
    await mgr.preanalyze(buildDetail('AA_TOP', A_FILE, bigA.text)!, scope3, hint);
    const aaCallsAfter = bigA.names.reduce((n, name) => n + textCallCount(world, name), 0);
    const bbCallsAfter = bigB.names.reduce((n, name) => n + textCallCount(world, name), 0);
    expect(aaCallsAfter).toBe(PER_FILE); // A 没重解析
    expect(bbCallsAfter).toBe(PER_FILE * 2); // B 每个 +1

    // ---- 对照：同一棵树纯磁盘回放（engine lineCache 已模拟：整份正文只切一次）----
    const diskWorld = makeWorld(diskMap, indexMap);
    const diskRig = makeRig(diskWorld);
    const t1 = performance.now();
    await diskRig.mgr.preanalyze(buildDetail('AA_TOP', A_FILE, bigA.text)!, null, hint);
    const diskMs = performance.now() - t1;

    // 耗时只随跑随打（墙钟断言会把本文件推进串行计时池，见 tools/perf-suite.mjs：
    //  这里**不断言**墙钟量，硬判据是上面的调用计数；ms 读数进交付回执）。
    console.log(
      `[inline-overrides-multi] N=${totalCallees}（2 文件 × ${PER_FILE}）` +
        ` override冷=${overrideMs.toFixed(2)} ms / override同集合第二轮=${warmMs.toFixed(2)} ms` +
        ` / disk=${diskMs.toFixed(2)} ms` +
        ` · 文本模式调用 首轮=${totalCallees} 二轮=${totalCallees} 改B后(A/B)=${aaCallsAfter}/${bbCallsAfter}`,
    );
  });
});
