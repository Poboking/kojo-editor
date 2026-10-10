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
    expect(rep.ruleCount).toBe(3); // 内置 ×2 + adapter
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

/* ========================= 语法糖侧静态约定（规范 §8 子集） ========================= */

/** 造一个只含一个 `.kojo` 文件的索引 + 文本表 */
function kojoHarness(text: string): Harness {
  const path = '/p/kojo/test.kojo';
  return harness({
    // 索引只需登记该文件（糖规则按 `index.files` 遍历，再 `readFile` 取文本）
    index: { files: new Map([[path, parseErbText('', path)]]), byName: new Map() },
    files: { [path]: text },
  });
}

describe('内置规则：语法糖侧静态约定（sugar.static-conventions）', () => {
  it('规则已注册，且只对 .kojo 生效（.ERB 不参与）', async () => {
    const erb = harness({
      index: makeIndex({ '/p/a.ERB': '@A\nPRINTFORMW 「……」 续\n' }),
    });
    const rep = await erb.engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toHaveLength(0);
  });

  it('§3.3：`续` 写在引号内 → error', async () => {
    const { engine } = kojoHarness('角色: 12\n时机 指令 310：\n    「……续」\n');
    const rep = await engine.run();
    const hit = rep.issues.filter((i) => i.ruleId === 'sugar.cont-inside-quotes');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.severity).toBe('error');
    expect(hit[0]!.message).toContain('引号内');
  });

  it('§3.3：`续` 写在引号外（正确写法）→ 无告警', async () => {
    const { engine } = kojoHarness('角色: 12\n时机 指令 310：\n    「……」 续\n');
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'sugar.cont-inside-quotes')).toHaveLength(0);
  });

  it('§3.7：同一时机两个「选项」块 → error', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    选项：\n' +
      '        「甲」：\n' +
      '            「……」\n' +
      '    选项：\n' +
      '        「乙」：\n' +
      '            「……」\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = rep.issues.filter((i) => i.ruleId === 'sugar.multiple-choice-blocks');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain('每个时机只允许一个');
  });

  it('§3.7：两个时机各一个「选项」块 → 无告警（跨时机不算）', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    选项：\n' +
      '        「甲」：\n' +
      '            「……」\n' +
      '时机 指令 311：\n' +
      '    选项：\n' +
      '        「乙」：\n' +
      '            「……」\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'sugar.multiple-choice-blocks')).toHaveLength(0);
  });

  it('§3.5：表达式 `如果` 缺「否则」→ error', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    她的心情 = 如果 她的好感度 >= 500：\n' +
      '        "热情"\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = rep.issues.filter((i) => i.ruleId === 'sugar.expr-missing-else');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain('如果');
  });

  it('§3.6：表达式 `当` 缺「否则」→ error', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    她的心情 = 当 她的好感度：\n' +
      '        是 0 到 99 -> 0\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'sugar.expr-missing-else')).toHaveLength(1);
  });

  it('§3.5：表达式 `如果` 带「否则」→ 无告警', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    她的心情 = 如果 她的好感度 >= 500：\n' +
      '        "热情"\n' +
      '    否则：\n' +
      '        "冷淡"\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'sugar.expr-missing-else')).toHaveLength(0);
  });

  it('§5.0：只读别名（字面量）作赋值左值 → error', async () => {
    const src =
      '角色: 12\n' +
      '别名 基准 = 500\n' +
      '时机 指令 310：\n' +
      '    基准 = 600\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = rep.issues.filter((i) => i.ruleId === 'sugar.readonly-alias-assign');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain('只读别名');
  });

  it('§5.0：只读别名作右值 → 无告警', async () => {
    const src =
      '角色: 12\n' +
      '别名 基准 = 500\n' +
      '时机 指令 310：\n' +
      '    她的好感度 = 基准\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'sugar.readonly-alias-assign')).toHaveLength(0);
  });

  it('原生直通行 / @ 块内的同名文本不参与判定', async () => {
    const src =
      '角色: 12\n' +
      '@M_FUNC\n' +
      'PRINTFORMW 「……」续」\n' +
      'GETVAR 续\n';
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toHaveLength(0);
  });
});
