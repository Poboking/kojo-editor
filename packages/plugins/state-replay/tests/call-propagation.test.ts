/**
 * 跨函数写传播（2026-11-05 边界批 3：一层 → 两层）——引擎级单测。
 *
 * 判据（`ReplayWrite.calleeWrites`）：
 * - 静态 `CALL TARGET(...)` 且 TARGET 在口上索引域里 → 数 TARGET 段里**可证明的写点**
 *   （assign / instruction；`call` / `jump` 不计），再叠**它自己的静态调用**（第二层）；
 * - 动态目标（`CALLFORM` / 不可解析）→ 不填字段 = 不可知（**不许当 0**）；
 * - 环（A→B→A）→ 该支不明知，不假装 0；预算 30 个被调函数/次；
 * - 缓存按"目标名 + 磁盘/缓冲正文模式"存；正文一变（override 身份变化）整表清。
 */
import { describe, expect, it } from 'vitest';
import type { FunctionPredicates, SnapshotArchive } from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { StateReplayEngine } from '../src/engine';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

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

/** 合成文件：每个函数块 = `@NAME()` 起，到下一个 `@` 前 */
function detailOf(files: Map<string, string>, name: string): FunctionPredicates | null {
  for (const [filePath, text] of files) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^@${name}\\s*\\(`, 'i').test(l.trim()));
    if (start < 0) continue;
    const nextAt = lines.findIndex((l, i) => i > start && /^@/.test(l.trim()));
    const end = nextAt < 0 ? lines.length - 1 : nextAt - 1;
    const predicates: FunctionPredicates['predicates'] = [];
    for (let i = start + 1; i <= end; i += 1) {
      const m = /^IF\s+(.+)$/i.exec(lines[i]!.trim());
      if (m) predicates.push({ kind: 'IF', text: m[1]!, expr: parseExpression(m[1]!), line: i + 1, depth: 0 });
    }
    return {
      normalizedName: name.toUpperCase(),
      filePath,
      startLine: start + 1,
      endLine: end + 1,
      statements: [],
      predicates,
      assignments: [],
      returns: [],
    };
  }
  return null;
}

function makeEngine(files: Map<string, string>, opts: { failFor?: Set<string> } = {}) {
  const calls: string[] = [];
  const engine = new StateReplayEngine({
    log: silent,
    parseArchive: async () => archive(),
    functionPredicates: async (name, textOverride) => {
      calls.push(name.toUpperCase());
      if (opts.failFor?.has(name.toUpperCase()) === true) throw new Error(`boom ${name}`);
      const map = new Map<string, string>();
      for (const [path, text] of files) map.set(path, textOverride ?? text);
      return detailOf(map, name);
    },
    getSchemaLookup: () => undefined,
    readFileText: async (path) => {
      const t = files.get(path);
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
  });
  return { engine, calls };
}

const MAIN = 'D:/fake/kojo/main.erb';
const WRAP = 'D:/fake/kojo/wrap.erb';
const LEAF = 'D:/fake/kojo/leaf.erb';

/** 三段：MAIN 调 WRAP（无写）；WRAP 调 LEAF（无写）；LEAF 有 2 处写 */
function threeLayer() {
  return new Map<string, string>([
    [MAIN, ['@MAIN()', 'CALL WRAP(1)', 'PRINTL x', ''].join('\n')],
    [WRAP, ['@WRAP(ARG)', 'CALL LEAF(ARG)', ''].join('\n')],
    [LEAF, ['@LEAF(ARG)', 'CFLAG:2 += 3', 'CFLAG:2 += 4', ''].join('\n')],
  ]);
}

async function writesOf(engine: StateReplayEngine, view: unknown, name: string, opts?: never) {
  const r = await engine.replayFunction(view as never, name, opts);
  return r?.unmodeledWrites ?? [];
}

describe('跨函数写传播（两层）', () => {
  it('直接调用：被调段 2 处写 → calleeWrites=2', async () => {
    const files = new Map<string, string>([
      [MAIN, ['@MAIN()', 'CALL LEAF(1)', ''].join('\n')],
      [LEAF, ['@LEAF(ARG)', 'CFLAG:2 += 3', 'CFLAG:2 += 4', ''].join('\n')],
    ]);
    const { engine } = makeEngine(files);
    const view = await engine.createView('D:/fake/save.sav', 49);
    const writes = await writesOf(engine, view, 'MAIN');
    const call = writes.find((w) => w.kind === 'call');
    expect(call?.target).toBe('LEAF');
    expect(call?.calleeWrites).toBe(2);
  });

  it('两层：MAIN→WRAP（无写）→LEAF（2 处写）⇒ calleeWrites=2（第二层也数）', async () => {
    const { engine } = makeEngine(threeLayer());
    const view = await engine.createView('D:/fake/save.sav', 49);
    const writes = await writesOf(engine, view, 'MAIN');
    expect(writes.find((w) => w.kind === 'call')?.calleeWrites).toBe(2);
  });

  it('被调段只有调用、目标段也没写 ⇒ calleeWrites=0（查过没写，不是缺省）', async () => {
    const files = new Map<string, string>([
      [MAIN, ['@MAIN()', 'CALL WRAP(1)', ''].join('\n')],
      [WRAP, ['@WRAP(ARG)', 'CALL LEAF(ARG)', ''].join('\n')],
      [LEAF, ['@LEAF(ARG)', 'PRINTL 只读', ''].join('\n')],
    ]);
    const { engine } = makeEngine(files);
    const view = await engine.createView('D:/fake/save.sav', 49);
    expect((await writesOf(engine, view, 'MAIN')).find((w) => w.kind === 'call')?.calleeWrites).toBe(0);
  });

  it('环（A→B→A）不挂死，且不把环当 0', async () => {
    const files = new Map<string, string>([
      [MAIN, ['@MAIN()', 'CALL WRAP(1)', ''].join('\n')],
      [WRAP, ['@WRAP(ARG)', 'CALL MAIN(ARG)', 'CFLAG:2 += 1', ''].join('\n')],
    ]);
    const { engine } = makeEngine(files);
    const view = await engine.createView('D:/fake/save.sav', 49);
    const writes = await writesOf(engine, view, 'MAIN');
    // WRAP 自己有一处写 ⇒ 仍应数出 1（环只影响更深那一支，不能整支丢弃）
    expect(writes.find((w) => w.kind === 'call')?.calleeWrites).toBe(1);
  });

  it('动态目标（无 target）⇒ 不填 calleeWrites（不可知，不是 0）', async () => {
    const files = new Map<string, string>([
      [MAIN, ['@MAIN()', 'CALLFORM 1, 2', ''].join('\n')],
    ]);
    const { engine } = makeEngine(files);
    const view = await engine.createView('D:/fake/save.sav', 49);
    const call = (await writesOf(engine, view, 'MAIN')).find((w) => w.kind === 'call');
    expect(call).toBeDefined();
    expect(call?.target).toBeUndefined();
    expect(call?.calleeWrites).toBeUndefined();
  });

  it('被调段明细查失败 ⇒ 不填（不可知），回放照常返回', async () => {
    const files = new Map<string, string>([
      [MAIN, ['@MAIN()', 'CALL LEAF(1)', 'PRINTL ok', ''].join('\n')],
      [LEAF, ['@LEAF(ARG)', 'CFLAG:2 += 1', ''].join('\n')],
    ]);
    const { engine } = makeEngine(files, { failFor: new Set(['LEAF']) });
    const view = await engine.createView('D:/fake/save.sav', 49);
    const r = await engine.replayFunction(view, 'MAIN');
    expect(r).not.toBeNull();
    const call = (r?.unmodeledWrites ?? []).find((w) => w.kind === 'call');
    expect(call?.calleeWrites).toBeUndefined();
  });

  it('同一目标第二次不回表重算（缓存命中：明细只取一次磁盘定位）', async () => {
    const { engine, calls } = makeEngine(threeLayer());
    const view = await engine.createView('D:/fake/save.sav', 49);
    await writesOf(engine, view, 'MAIN');
    const first = calls.filter((n) => n === 'LEAF').length;
    await writesOf(engine, view, 'MAIN');
    const second = calls.filter((n) => n === 'LEAF').length;
    expect(first).toBeGreaterThan(0);
    expect(second - first).toBeLessThan(first); // 第二轮不再对 LEAF 做磁盘定位那一次
  });
});
