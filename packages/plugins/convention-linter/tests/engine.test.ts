import { describe, expect, it } from 'vitest';
import type {
  ConventionRule,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { ConventionEngine } from '../src/engine';

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeIndex(files: Record<string, string>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [path, text] of Object.entries(files)) {
    const f = parseErbText(text, path);
    map.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: map, byName };
}

function fakeProject(): GameProject {
  return { rootDir: '/p', adapterId: 'test', kojoPaths: ['/p/kojo'], writablePaths: [], charaIndex: new Map() };
}

interface Harness {
  engine: ConventionEngine;
  readCalls: string[];
  rules: ConventionRule[];
}

function harness(opts: {
  index: ErbIndex | null;
  project?: GameProject | null;
  adapterRules?: ConventionRule[];
  files?: Record<string, string>;
}): Harness {
  const readCalls: string[] = [];
  const rules: ConventionRule[] = opts.adapterRules ?? [];
  const files = opts.files ?? {};
  const engine = new ConventionEngine({
    log: silentLog,
    getProject: () => (opts.project === undefined ? fakeProject() : opts.project),
    getIndex: () => opts.index,
    readFile: async (path: string) => {
      readCalls.push(path);
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return text;
    },
    getAdapterRules: () => rules,
  });
  return { engine, readCalls, rules };
}

describe('ConventionEngine', () => {
  it('rules() = 内置通用规则 + 适配器规则', () => {
    const adapterRule: ConventionRule = { id: 'g.x', description: 'x', severity: 'info' };
    const { engine } = harness({ index: null, adapterRules: [adapterRule] });
    const ids = engine.rules().map((r) => r.id);
    expect(ids).toContain('erb.duplicate-function');
    expect(ids).toContain('g.x');
  });

  it('无项目 / 无索引 → 空报告（形状稳定，不抛错）', async () => {
    const { engine } = harness({ index: null, project: null });
    const rep = await engine.run();
    expect(rep.issues).toEqual([]);
    expect(rep.ruleCount).toBe(0);
    expect(rep.adapterId).toBe('');
    expect(engine.report()).toBe(rep);
  });

  it('汇总问题、按严重度排序、按 key 去重', async () => {
    const index = makeIndex({ '/p/a.ERB': '@A\n' });
    const adapterRule: ConventionRule = {
      id: 'g.rule',
      description: 'demo',
      severity: 'info',
      check: () => [
        { ruleId: 'g.rule', severity: 'info', message: 'i1', filePath: '/p/a.ERB', line: 1 },
        { ruleId: 'g.rule', severity: 'error', message: 'e1', filePath: '/p/a.ERB', line: 2 },
        { ruleId: 'g.rule', severity: 'info', message: 'i1', filePath: '/p/a.ERB', line: 1 }, // 重复（同 key）
      ],
    };
    const { engine } = harness({ index, adapterRules: [adapterRule] });
    const rep = await engine.run();
    expect(rep.issues).toHaveLength(2);
    expect(rep.issues[0]!.severity).toBe('error');
    expect(rep.counts).toEqual({ error: 1, warning: 0, info: 1 });
    expect(rep.ruleCount).toBe(2); // 内置 + adapter
  });

  it('规则抛错 → 记入 failedRules，其余规则照常产出', async () => {
    const index = makeIndex({ '/p/a.ERB': '@A\n' });
    const bad: ConventionRule = {
      id: 'g.bad',
      description: 'boom',
      severity: 'error',
      check: () => {
        throw new Error('kaboom');
      },
    };
    const good: ConventionRule = {
      id: 'g.good',
      description: 'ok',
      severity: 'warning',
      check: () => [{ ruleId: 'g.good', severity: 'warning', message: 'fine' }],
    };
    const { engine } = harness({ index, adapterRules: [bad, good] });
    const rep = await engine.run();
    expect(rep.failedRules).toEqual([{ ruleId: 'g.bad', error: 'kaboom' }]);
    expect(rep.issues.some((i) => i.ruleId === 'g.good')).toBe(true);
  });

  it('同一运行内 readFile 记忆化：两条规则读同一文件只落盘一次', async () => {
    const index = makeIndex({ '/p/a.ERB': '@A\n' });
    const mk = (id: string): ConventionRule => ({
      id,
      description: id,
      severity: 'info',
      check: async (ctx) => {
        await ctx.readFile('/p/a.ERB');
        await ctx.readFile('/p/a.ERB');
        return [];
      },
    });
    const { engine, readCalls } = harness({
      index,
      adapterRules: [mk('g.a'), mk('g.b')],
      files: { '/p/a.ERB': '@A\n' },
    });
    await engine.run();
    expect(readCalls.filter((p) => p === '/p/a.ERB')).toHaveLength(1);
  });

  it('内置规则：同名函数多处定义产出 info', async () => {
    const index = makeIndex({
      '/p/a.ERB': '@DUP\nPRINTL 1\n',
      '/p/b.ERB': '@dup\nPRINTL 2\n',
    });
    const { engine } = harness({ index });
    const rep = await engine.run();
    const dups = rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function');
    expect(dups).toHaveLength(1);
    expect(dups[0]!.severity).toBe('info');
  });

  it('subscribe 立即回调当前值，并在运行后推送新报告', async () => {
    const index = makeIndex({ '/p/a.ERB': '@A\n' });
    const { engine } = harness({ index });
    const seen: unknown[] = [];
    const un = engine.subscribe((r) => seen.push(r));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeNull();
    await engine.run();
    expect(seen).toHaveLength(2);
    un();
    await engine.run();
    expect(seen).toHaveLength(2); // 退订后不再收到
  });
});
