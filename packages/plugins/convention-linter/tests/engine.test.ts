import { describe, expect, it } from 'vitest';
import type {
  CacheExpect,
  ConventionIssue,
  ConventionPolicy,
  ConventionRule,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { ConventionEngine } from '../src/engine';
import type { LintCache } from '../src/snapshot';
import {
  CONT_INSIDE_QUOTES_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
  SUGAR_LINT_RULE_IDS,
  SUGAR_STATIC_CONVENTIONS_RULE_ID,
  setSugarTranspileProvider,
  sugarLintIssuesFrom,
  sugarLintRuleIdOf,
} from '../src/rules/sugar-conventions';

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

type SnapshotPort = NonNullable<ConstructorParameters<typeof ConventionEngine>[0]['snapshot']>;

function harness(opts: {
  index: ErbIndex | null;
  project?: GameProject | null;
  adapterRules?: ConventionRule[];
  files?: Record<string, string>;
  /** 结果快照端口替身（缺省 = 不启用快照，与改造前行为一致） */
  snapshot?: Partial<Pick<SnapshotPort, 'load' | 'save'>> & { expectFor?: () => CacheExpect | null };
  /** 批量读通道（2026-10-16 批量 IO 批）；缺省 = 不提供（走逐文件 readFile） */
  readFiles?: (paths: readonly string[]) => Promise<Array<string | null>>;
  /** 适配器静默策略；缺省 = 不收敛 */
  policy?: ConventionPolicy;
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
    ...(opts.readFiles ? { readFiles: opts.readFiles } : {}),
    getAdapterRules: () => rules,
    getAdapterPolicy: () => opts.policy,
    snapshot: opts.snapshot
      ? {
          expectFor: opts.snapshot.expectFor ?? (() => ({ projectRoot: '/p', adapterId: 'test', fingerprint: 'fp' })),
          load: opts.snapshot.load ?? (async () => null),
          save: opts.snapshot.save ?? (() => undefined),
        }
      : undefined,
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

  it('批量预取（readFiles）：逐文件规则 stale 并集一次批取，规则内零单文件读', async () => {
    const calls: string[][] = [];
    const fileCalls: string[] = [];
    const index = makeIndex({ '/p/a.ERB': '@A\n', '/p/b.ERB': '@B\n' });
    const { engine, readCalls } = harness({
      index,
      adapterRules: [
        {
          id: 'g.file',
          description: 'x',
          severity: 'info',
          scope: 'file',
          async checkFile(ctx, file) {
            fileCalls.push(file.path);
            const t = await ctx.readFile(file.path);
            return [{ ruleId: 'g.file', severity: 'info' as const, message: t, filePath: file.path, key: `g.file|${file.path}` }];
          },
        },
      ],
      files: { '/p/a.ERB': '@A\n', '/p/b.ERB': '@B\n' },
      readFiles: async (paths) => {
        calls.push([...paths]);
        return paths.map((p) => ({ '/p/a.ERB': '@A\n', '/p/b.ERB': '@B\n' })[p] ?? null);
      },
    });
    const rep = await engine.run();
    expect(calls).toHaveLength(1); // 一次批取
    expect(calls[0]!.sort()).toEqual(['/p/a.ERB', '/p/b.ERB'].sort());
    expect(readCalls).toEqual([]); // 预取覆盖全部 stale ⇒ 兜底单读零次
    expect(fileCalls.sort()).toEqual(['/p/a.ERB', '/p/b.ERB'].sort());
    expect(rep.issues.filter((i) => i.ruleId === 'g.file')).toHaveLength(2);
  });

  it('批量失败位 null 不吞：落单文件兜底（再失败即抛错、不留桶，与旧语义一致）', async () => {
    const index = makeIndex({ '/p/a.ERB': '@A\n', '/p/b.ERB': '@B\n' });
    const { engine, readCalls } = harness({
      index,
      adapterRules: [
        {
          id: 'g.file',
          description: 'x',
          severity: 'info',
          scope: 'file',
          async checkFile(ctx, file) {
            return [{ ruleId: 'g.file', severity: 'info' as const, message: await ctx.readFile(file.path), filePath: file.path, key: `g.file|${file.path}` }];
          },
        },
      ],
      files: { '/p/a.ERB': '@A\n' }, // b 的内容缺失 ⇒ 兜底读也会失败
      readFiles: async (paths) => paths.map((p) => ({ '/p/a.ERB': '@A\n' })[p] ?? null),
    });
    const rep = await engine.run();
    expect(readCalls).toContain('/p/b.ERB'); // 失败位没被吞：兜底确实尝试过
    expect(rep.failedRules.map((f) => f.ruleId)).toContain('g.file');
    const keys = rep.issues.filter((i) => i.ruleId === 'g.file').map((i) => i.key);
    expect(keys).toEqual(['g.file|/p/a.ERB']); // a 照常出结论，b 不留痕（不伪造）
  });

  it('批量通道整体抛错 ⇒ 回退逐文件 readFile，结果不变', async () => {
    const index = makeIndex({ '/p/a.ERB': '@A\n' });
    const { engine, readCalls } = harness({
      index,
      adapterRules: [
        {
          id: 'g.file',
          description: 'x',
          severity: 'info',
          scope: 'file',
          async checkFile(ctx, file) {
            await ctx.readFile(file.path);
            return [];
          },
        },
      ],
      files: { '/p/a.ERB': '@A\n' },
      readFiles: async () => {
        throw new Error('ipc down');
      },
    });
    const rep = await engine.run();
    expect(readCalls).toEqual(['/p/a.ERB']); // 回退路径真的单读
    expect(rep.failedRules).toEqual([]);
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

  it('内置规则：适配器策略命中的重复不逐条报，汇总成一条 info（不静默）', async () => {
    const index = makeIndex({
      '/p/a.ERB': '@EVENTTRAIN\nPRINTL 1\n@OTHER\nPRINTL 1\n',
      '/p/b.ERB': '@eventtrain\nPRINTL 2\n@OTHER\nPRINTL 2\n',
      '/p/c.ERB': '@EVENTTRAIN\nPRINTL 3\n',
    });
    const { engine } = harness({
      index,
      policy: [
        {
          ruleId: 'erb.duplicate-function',
          names: ['EVENTTRAIN'],
          reason: '逐角色各写一份分发器',
        },
      ],
    });
    const rep = await engine.run();
    const dups = rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function');
    // OTHER 的一条逐条报 + EVENTTRAIN 的一条汇总（2 处被收敛）
    expect(dups).toHaveLength(2);
    expect(dups.some((i) => i.message.includes('已按适配器策略收敛 2 处预期重复'))).toBe(true);
    expect(dups.some((i) => i.message.includes('逐角色各写一份分发器'))).toBe(true);
    expect(dups.some((i) => i.message.includes('「OTHER」'))).toBe(true);
  });

  it('策略只收敛声明的规则 id / 名字：未命中项照旧逐条报', async () => {
    const index = makeIndex({
      '/p/a.ERB': '@EVENTTRAIN\n@KEEP\n',
      '/p/b.ERB': '@EVENTTRAIN\n@KEEP\n',
    });
    const { engine } = harness({
      index,
      policy: [{ ruleId: 'other.rule', names: ['EVENTTRAIN'], reason: '别的规则' }],
    });
    const rep = await engine.run();
    const dups = rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function');
    expect(dups).toHaveLength(2); // EVENTTRAIN 1 + KEEP 1
    expect(dups.every((i) => !i.message.includes('收敛'))).toBe(true);
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

/* ========================= 作者范围 vs 只读基座库 ========================= */

describe('约定校验只覆盖作者范围（只读基座库不进报告）', () => {
  const project: GameProject = {
    rootDir: '/p',
    adapterId: 'test',
    kojoPaths: ['/p/kojo'],
    libraryPaths: ['/p'],
    writablePaths: ['/p/kojo'],
    charaIndex: new Map(),
  };

  it('基座库文件被逐文件规则跳过，口上文件照常出报告', async () => {
    const files = { '/p/base.ERB': '@BASE\n', '/p/kojo/a.ERB': '@A\n' };
    const index = makeIndex(files);
    const fileRule: ConventionRule = {
      id: 'g.file',
      description: 'demo',
      severity: 'info',
      scope: 'file',
      checkFile: (_ctx, file) => [{ ruleId: 'g.file', severity: 'info', message: 'hit', filePath: file.path }],
    };
    const { engine } = harness({ index, project, adapterRules: [fileRule], files });
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'g.file').map((i) => i.filePath)).toEqual(['/p/kojo/a.ERB']);
  });

  it('基座库内部的重复定义不算作者问题（只在作者范围内判重）', async () => {
    const files = { '/p/base.ERB': '@DUP\n@DUP2\n@DUP2\n', '/p/kojo/a.ERB': '@A\n' };
    const index = makeIndex(files);
    const { engine } = harness({ index, project, files });
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function')).toEqual([]);
  });

  it('作者口上域内的重复定义照旧报（过滤没有吞掉作者自己的问题）', async () => {
    const files = { '/p/kojo/a.ERB': '@A\n', '/p/kojo/b.ERB': '@A\n' };
    const index = makeIndex(files);
    const { engine } = harness({ index, project, files });
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function')).toHaveLength(1);
  });
});

/* ========================= 语法糖侧约定（判据 = 转译器，W2 去重批） ========================= */

/** 造一个只含一个 `.kojo1` 文件的索引 + 文本表 */
function kojoHarness(text: string): Harness {
  const path = '/p/kojo/test.kojo1';
  return harness({
    // 索引只需登记该文件（糖规则按 `index.files` 遍历，再 `readFile` 取文本）
    index: { files: new Map([[path, parseErbText('', path)]]), byName: new Map() },
    files: { [path]: text },
  });
}

/**
 * 糖规则的判据本体（转译器）。`sugar.static-conventions` 只做诊断投影 ⇒
 * 这里的期望值一律**当场由转译器算**，断言的是"面板拿到的就是转译器说的那一条"，
 * 不再对着本文件里抄一份中文文案（那正是 RULE-DEDUP 要拆掉的第二套判据）。
 * 分野表取 eraTW 真实模板：没有它整块时机 fail-closed，代码生成期的
 * `readonly-alias-assignment` 根本走不到（测试文件豁免插件交叉 import 纪律）。
 */
const sugar = createSugarTranspileService({ faceTable: createEratwFaceTable() });
const sugarPath = '/p/kojo/test.kojo1';

/** 转译器对这棵源文件的认领码诊断（期望侧独立算一遍） */
function transpilerIssues(src: string): ConventionIssue[] {
  return sugarLintIssuesFrom(sugar.transpile(src, { filePath: sugarPath }).diagnostics, sugarPath);
}

/** 面板侧的糖约定条目（按码过滤后与期望对拍） */
function panelSugarIssues(rep: Awaited<ReturnType<ConventionEngine['run']>>, code: string): ConventionIssue[] {
  return rep.issues.filter((i) => i.ruleId === sugarLintRuleIdOf(code));
}

describe('内置规则：语法糖侧约定（sugar.static-conventions = 转译器诊断投影）', () => {
  it('规则已注册，且只对 .kojo1 生效（.ERB 不参与）', async () => {
    const erb = harness({
      index: makeIndex({ '/p/a.ERB': '@A\nPRINTFORMW 「……」 续\n' }),
    });
    const rep = await erb.engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toHaveLength(0);
    expect(rep.failedRules).toEqual([]); // 没有糖源文件 ⇒ 服务通道没接线也不算失败（无事可做）
  });

  it('§3.3：`续` 写在引号内 → 面板条目逐条等于转译器诊断', async () => {
    const src = '角色: 12\n时机 指令 310：\n    「…… 续」\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = panelSugarIssues(rep, 'cont-inside-quotes');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.map((i) => `${i.severity}|${i.line}|${i.message}`)).toEqual(
      transpilerIssues(src)
        .filter((i) => i.ruleId === CONT_INSIDE_QUOTES_RULE_ID)
        .map((i) => `${i.severity}|${i.line}|${i.message}`),
    );
  });

  it('§3.3：`续` 写在引号外（正确写法）→ 与转译器同为无告警', async () => {
    const src = '角色: 12\n时机 指令 310：\n    「……」 续\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(panelSugarIssues(rep, 'cont-inside-quotes')).toEqual([]);
    expect(transpilerIssues(src)).toEqual([]); // 期望侧也确实是空（防空对空之外的口径漂移）
  });

  it('§3.7：同一时机两个「选项」块 → 一条 choice-multiple 投影', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    选项：\n' +
      '        「甲」：\n' +
      '            「……」\n' +
      '    选项：\n' +
      '        「乙」：\n' +
      '            「……」\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = panelSugarIssues(rep, 'choice-multiple');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.ruleId).toBe(MULTIPLE_CHOICE_BLOCKS_RULE_ID);
    expect(hit[0]!.message).toBe(transpilerIssues(src).find((i) => i.ruleId === MULTIPLE_CHOICE_BLOCKS_RULE_ID)!.message);
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
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(panelSugarIssues(rep, 'choice-multiple')).toHaveLength(0);
  });

  it('§3.5：表达式 `如果` 缺「否则」→ 投影一致', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    她的心情 = 如果 她的好感度 >= 500：\n' +
      '        "热情"\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = panelSugarIssues(rep, 'expr-missing-else');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toBe(transpilerIssues(src)[0]!.message);
    expect(hit[0]!.line).toBe(transpilerIssues(src)[0]!.line);
  });

  it('§3.6：表达式 `当` 缺「否则」→ 投影一致', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    她的心情 = 当 她的好感度：\n' +
      '        是 0 到 99 -> 0\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(panelSugarIssues(rep, 'expr-missing-else')).toHaveLength(1);
  });

  it('§3.5：表达式 `如果` 带「否则」→ 无告警', async () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    她的心情 = 如果 她的好感度 >= 500：\n' +
      '        "热情"\n' +
      '    否则：\n' +
      '        "冷淡"\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(panelSugarIssues(rep, 'expr-missing-else')).toHaveLength(0);
  });

  it('§5.0：只读别名（字面量）作赋值左值 → 投影一致', async () => {
    const src = '角色: 12\n别名 基准 = 500\n时机 指令 310：\n    基准 = 600\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    const hit = panelSugarIssues(rep, 'readonly-alias-assignment');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.ruleId).toBe(READONLY_ALIAS_ASSIGN_RULE_ID);
    expect(hit[0]!.message).toBe(
      transpilerIssues(src).find((i) => i.ruleId === READONLY_ALIAS_ASSIGN_RULE_ID)!.message,
    );
  });

  it('§5.0：只读别名作右值 → 无告警', async () => {
    const src = '角色: 12\n别名 基准 = 500\n时机 指令 310：\n    她的好感度 = 基准\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(panelSugarIssues(rep, 'readonly-alias-assignment')).toHaveLength(0);
  });

  it('原生直通块（`@`）里的同名文本不参与判定（分区口径跟随转译器）', async () => {
    const src = '角色: 12\n@M_FUNC\nPRINTFORMW 「……」续」\nGETVAR 续\n';
    setSugarTranspileProvider(() => sugar);
    const { engine } = kojoHarness(src);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => SUGAR_LINT_RULE_IDS.includes(i.ruleId))).toEqual([]);
  });

  it('服务缺席 ⇒ 本轮没有结论（failedRules 带原因），不伪造"没问题"', async () => {
    setSugarTranspileProvider(() => null);
    const { engine } = kojoHarness('角色: 12\n时机 指令 310：\n    「……续」\n');
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toEqual([]);
    const failed = rep.failedRules.find((f) => f.ruleId === SUGAR_STATIC_CONVENTIONS_RULE_ID);
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('sugar.transpile 服务缺席');
    setSugarTranspileProvider(null);
  });
});

describe('ConventionEngine 的分层复用（2026-10-12 按文件增量批）', () => {
  const A = '/p/kojo/a.ERB';
  const B = '/p/kojo/b.ERB';
  const files: Record<string, string> = { [A]: '@M_KOJO_K1_A\nA\nEND\n', [B]: '@M_KOJO_K1_B\nB\nEND\n' };
  /** 逐文件规则对某文件的结论（测试里造"上次留下的桶"必须与规则真算的**逐字一致**） */
  const fileIssue = (path: string) => ({
    ruleId: 'g.file',
    severity: 'warning' as const,
    message: `${path} len=${files[path]!.length}`,
    filePath: path,
    key: `g.file|${path}`,
  });
  /** 本次索引：带整项目指纹 + 逐文件 mtime（生产里由 erb-parser 顺手给出） */
  const idx = (over: Partial<ErbIndex> = {}): ErbIndex => ({
    ...makeIndex(files),
    fingerprint: 'erbfp-1',
    fileMtimes: new Map([
      [A, 100],
      [B, 200],
    ]),
    ...over,
  });

  /** 逐文件规则：记录被调用过哪些文件，用来证明"改一个只算那一个" */
  const fileRule = (id: string, calls: string[]): ConventionRule => ({
    id,
    description: 'per-file rule',
    severity: 'warning',
    scope: 'file',
    async checkFile(ctx, file) {
      calls.push(`${id}|${file.path}`);
      const text = await ctx.readFile(file.path);
      return [
        {
          ruleId: id,
          severity: 'warning' as const,
          message: `${file.path} len=${text.length}`,
          filePath: file.path,
          key: `${id}|${file.path}`,
        },
      ];
    },
  });

  /** 跨文件规则：记录运行次数 */
  const projectRule = (id: string, runs: number[]): ConventionRule => ({
    id,
    description: 'whole-project rule',
    severity: 'info',
    check() {
      runs.push(1);
      return [{ ruleId: id, severity: 'info' as const, message: 'cross-file', key: id }];
    },
  });

  /** 造"上次留下的缓存"（默认覆盖**全部**跨文件规则，否则缺项的规则本次仍要重算） */
  const cacheOf = (
    args: {
      erbFingerprint?: string;
      mtimes?: Record<string, number | null>;
      /** 跨文件规则的结论（ruleId → issues）；缺省 = 空表 ⇒ 所有跨文件规则本次重算 */
      projectResults?: Record<string, ConventionIssue[]>;
    } = {},
  ): LintCache => {
    const mt = args.mtimes ?? { [A]: 100, [B]: 200 };
    const byPath: Record<string, { mtimeMs: number | null; issues: ReturnType<typeof fileIssue>[] }> = {};
    for (const [path, mtimeMs] of Object.entries(mt)) byPath[path] = { mtimeMs, issues: [fileIssue(path)] };
    return {
      erbFingerprint: args.erbFingerprint ?? 'erbfp-1',
      projectResults: args.projectResults ?? {},
      buckets: { 'g.file': byPath },
    };
  };

  it('三层全命中 ⇒ 零读盘、零规则调用、**不回存**', async () => {
    const calls: string[] = [];
    const runs: number[] = [];
    // 上次留下的缓存必须覆盖**全部**跨文件规则（含引擎内置那两条），否则缺项的规则本次仍要重算
    const probe = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', runs)],
      files,
    });
    const projectResults: Record<string, ConventionIssue[]> = {};
    for (const r of probe.engine.rules()) {
      if (r.scope === 'file') continue;
      projectResults[r.id] = r.id === 'g.proj' ? [{ ruleId: 'g.proj', severity: 'info', message: 'cross-file', key: 'g.proj' }] : [];
    }
    const cache: LintCache = { ...cacheOf(), projectResults };

    let saves = 0;
    const { engine, readCalls } = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', runs)],
      files,
      snapshot: {
        async load() {
          return cache;
        },
        save() {
          saves++;
        },
      },
    });
    const out = await engine.run();
    expect(readCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
    expect(saves).toBe(0);
    expect(out.issues.map((i) => i.key).sort()).toEqual([`g.file|${A}`, `g.file|${B}`, 'g.proj']);
  });

  it('改一个文件的 mtime ⇒ 逐文件规则只算那一个，另一个照用（本批靶心）', async () => {
    const calls: string[] = [];
    const runs: number[] = [];
    const saved: LintCache[] = [];
    const { engine, readCalls } = harness({
      index: idx({
        fingerprint: 'erbfp-2', // B 变了 ⇒ 整项目指纹跟着变
        fileMtimes: new Map([
          [A, 100],
          [B, 201],
        ]),
      }),
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', runs)],
      files,
      snapshot: {
        async load() {
          return cacheOf();
        },
        save(cache) {
          saved.push(cache);
        },
      },
    });
    const out = await engine.run();
    expect(calls).toEqual(['g.file|' + B]); // 只有变过的文件被调用
    expect(readCalls).toEqual([B]);
    expect(runs).toHaveLength(1); // 跨文件规则整项目重算（它看得到所有文件）
    expect(out.issues).toHaveLength(3);
    // 落盘的桶含**两个**文件（复用的 A + 新算的 B），且 B 带新 mtime 与新指纹
    expect(Object.keys(saved[0]!.buckets['g.file']!).sort()).toEqual([A, B].sort());
    expect(saved[0]!.buckets['g.file']![B]!.mtimeMs).toBe(201);
    expect(saved[0]!.erbFingerprint).toBe('erbfp-2');
  });

  it('两层判据**互不牵连**：整项目指纹变了但文件 mtime 没变 ⇒ 桶仍命中，只重算跨文件规则', async () => {
    const calls: string[] = [];
    const runs: number[] = [];
    const { engine, readCalls } = harness({
      index: idx({ fingerprint: 'erbfp-CHANGED' }), // 例如增删了别的文件，而这两个文件本身没动
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', runs)],
      files,
      snapshot: {
        async load() {
          return cacheOf({ erbFingerprint: 'erbfp-OLD' });
        },
      },
    });
    await engine.run();
    expect(calls).toEqual([]); // 逐文件层命中
    expect(readCalls).toEqual([]);
    expect(runs).toHaveLength(1); // 整项目层重算
  });

  it('索引不带 fingerprint ⇒ 整项目层永不复用（保守），逐文件层照旧命中', async () => {
    const calls: string[] = [];
    const runs: number[] = [];
    const { engine } = harness({
      index: idx({ fingerprint: undefined }),
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', runs)],
      files,
      snapshot: {
        async load() {
          return cacheOf();
        },
      },
    });
    await engine.run();
    expect(runs).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('索引不带 fileMtimes ⇒ 每个文件都重算（判据不可得就不复用）', async () => {
    const calls: string[] = [];
    const { engine } = harness({
      index: idx({ fileMtimes: undefined }),
      adapterRules: [fileRule('g.file', calls)],
      files,
      snapshot: {
        async load() {
          return cacheOf();
        },
      },
    });
    await engine.run();
    expect(calls.sort()).toEqual(['g.file|' + A, 'g.file|' + B]);
  });

  it('桶里的 mtime 为 null ⇒ 该文件判过期（不能拿 null==null 当命中）', async () => {
    const calls: string[] = [];
    const { engine } = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls)],
      files,
      snapshot: {
        async load() {
          return cacheOf({ mtimes: { [A]: null, [B]: 200 } });
        },
      },
    });
    await engine.run();
    expect(calls).toEqual(['g.file|' + A]);
  });

  it('磁盘上消失的文件不在本次索引里 ⇒ 不进桶（快照不会越攒越大）', async () => {
    const saved: LintCache[] = [];
    const calls: string[] = [];
    const onlyA: Record<string, string> = { [A]: files[A]! };
    const { engine } = harness({
      index: {
        ...makeIndex(onlyA),
        fingerprint: 'erbfp-3',
        fileMtimes: new Map([[A, 100]]),
      },
      adapterRules: [fileRule('g.file', calls)],
      files: onlyA,
      snapshot: {
        async load() {
          return cacheOf();
        },
        save(cache) {
          saved.push(cache);
        },
      },
    });
    const out = await engine.run();
    expect(calls).toEqual([]); // A 命中，B 已消失
    expect(out.issues.map((i) => i.key)).toEqual([`g.file|${A}`]);
    expect(Object.keys(saved[0]!.buckets['g.file']!)).toEqual([A]);
  });

  it('checkFile 抛错的文件**不进桶**，其余照常；规则失败显式入 failedRules', async () => {
    const saved: LintCache[] = [];
    const broken: ConventionRule = {
      id: 'g.broken',
      description: 'fails on A',
      severity: 'warning',
      scope: 'file',
      async checkFile(_ctx, file) {
        if (file.path === A) throw new Error('disk offline');
        return [
          {
            ruleId: 'g.broken',
            severity: 'warning',
            message: 'ok',
            filePath: file.path,
            key: `g.broken|${file.path}`,
          },
        ];
      },
    };
    const { engine } = harness({
      index: idx(),
      adapterRules: [broken],
      files,
      snapshot: {
        async load() {
          return null;
        },
        save(cache) {
          saved.push(cache);
        },
      },
    });
    const out = await engine.run();
    expect(out.failedRules.map((f) => f.ruleId)).toContain('g.broken');
    expect(out.issues.some((i) => i.key === `g.broken|${B}`)).toBe(true);
    expect(out.issues.some((i) => i.key === `g.broken|${A}`)).toBe(false);
    expect(saved[0]!.buckets['g.broken']![A]).toBeUndefined(); // 坏结果不缓存
    expect(saved[0]!.buckets['g.broken']![B]).toBeDefined();
  });

  it('抛错的跨文件规则不写 projectResults ⇒ 下次必然重算它', async () => {
    const saved: LintCache[] = [];
    const boom: ConventionRule = {
      id: 'g.boom',
      description: 'throws',
      severity: 'error',
      check() {
        throw new Error('rule crashed');
      },
    };
    const { engine } = harness({
      index: idx(),
      adapterRules: [boom],
      files,
      snapshot: {
        async load() {
          return null;
        },
        save(cache) {
          saved.push(cache);
        },
      },
    });
    const out = await engine.run();
    expect(out.failedRules.map((f) => f.ruleId)).toEqual(['g.boom']);
    expect(saved[0]!.projectResults['g.boom']).toBeUndefined();
  });

  it('声明 scope:file 却没实现 checkFile ⇒ 显式记失败，不是静默产出 0 条', async () => {
    const halfWritten: ConventionRule = {
      id: 'g.half',
      description: 'scope declared but no checkFile',
      severity: 'warning',
      scope: 'file',
    };
    const { engine } = harness({ index: idx(), adapterRules: [halfWritten], files });
    const out = await engine.run();
    expect(out.issues).toHaveLength(0);
    expect(out.failedRules).toHaveLength(1);
    expect(out.failedRules[0]!.error).toMatch(/checkFile/);
  });

  it('增量装配与全量重算**同值同序**（等价性守门）', async () => {
    const calls: string[] = [];
    const full = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', [])],
      files,
    });
    const fullOut = await full.engine.run();

    // 同一份语料，但 A 上次没算成（桶里只有 B） ⇒ 走"复用 B + 重算 A"的增量路径
    const cache: LintCache = {
      erbFingerprint: 'erbfp-1',
      projectResults: {},
      buckets: { 'g.file': { [B]: { mtimeMs: 200, issues: [fileIssue(B)] } } },
    };
    const inc = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls), projectRule('g.proj', [])],
      files,
      snapshot: {
        async load() {
          return cache;
        },
      },
    });
    const incOut = await inc.engine.run();
    expect(incOut.issues.map((i) => i.key)).toEqual(fullOut.issues.map((i) => i.key));
    expect(incOut.issues.map((i) => i.message)).toEqual(fullOut.issues.map((i) => i.message));
    expect(incOut.counts).toEqual(fullOut.counts);
  });

  it('force ⇒ 压根不问缓存（「重新校验」不许被缓存糊住），但仍回存', async () => {
    let loads = 0;
    let saves = 0;
    const calls: string[] = [];
    const { engine } = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls)],
      files,
      snapshot: {
        async load() {
          loads++;
          return cacheOf();
        },
        save() {
          saves++;
        },
      },
    });
    await engine.run({ force: true });
    expect(loads).toBe(0);
    expect(calls.sort()).toEqual(['g.file|' + A, 'g.file|' + B]); // 全部真算
    expect(saves).toBe(1);
  });

  it('判据不全（expectFor null）⇒ 不 load 不 save，但仍真算', async () => {
    let touched = 0;
    const calls: string[] = [];
    const { engine, readCalls } = harness({
      index: idx(),
      adapterRules: [fileRule('g.file', calls)],
      files,
      snapshot: {
        expectFor: () => null,
        async load() {
          touched++;
          return null;
        },
        save() {
          touched++;
        },
      },
    });
    const out = await engine.run();
    expect(touched).toBe(0);
    expect(readCalls).toHaveLength(2);
    expect(out.issues).toHaveLength(2);
  });

  it('inFlight 去重：自动触发与面板显式调用共享同一次运行', async () => {
    const calls: string[] = [];
    const { engine } = harness({ index: idx(), adapterRules: [fileRule('g.file', calls)], files });
    const [x, y] = await Promise.all([engine.run(), engine.run()]);
    expect(x).toBe(y);
    expect(calls).toHaveLength(2); // 一轮，两个文件各一次
  });
});

/**
 * 投机预取的收窄（PERF-12c）。
 *
 * 12b 的写法在 `lastRun` 取不到时把候选退化成"全部文件"，而真壳每一轮都是**新载入的页面**
 * （⇒ lastRun 必空）⇒ 每轮白读全库正文（真语料 2,325 棵实测 4.1 s），而同轮 `lint reuse`
 * 显示整条复用 7/7（本轮压根不需要任何正文）。这几条用例钉死两件事：
 * ①零重算轮**一次批量读都不发**；②真要重算的文件**一个都不能少**（覆盖面由装载后的
 * stale 并集兜底，投机只是提前量热）。12b 之所以能把回退漏过去，就是因为这批形状零覆盖。
 */
describe('投机预取只在同引擎连续轮生效（PERF-12c）', () => {
  const A = '/p/kojo/a.ERB';
  const B = '/p/kojo/b.ERB';
  const pf: Record<string, string> = { [A]: '@M_KOJO_K1_A\nA\nEND\n', [B]: '@M_KOJO_K1_B\nB\nEND\n' };
  const EXPECT: CacheExpect = { projectRoot: '/p', adapterId: 'test', fingerprint: 'global-1' };

  const mkIndex = (over: { bMtime?: number; fingerprint?: string } = {}): ErbIndex => {
    const map = new Map<string, ErbFile>();
    const byName = new Map<string, ErbFunctionRef[]>();
    for (const [path, text] of Object.entries(pf)) {
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
    return {
      files: map,
      byName,
      fingerprint: over.fingerprint ?? 'erbfp-1',
      fileMtimes: new Map<string, number | null>([[A, 100], [B, over.bMtime ?? 200]]),
    };
  };

  /** 只看正文长度的逐文件规则 ⇒ 预取没覆盖到就会走单文件兜底读（batches/singles 都看得见） */
  const textRule: ConventionRule = {
    id: 'g.text',
    description: 'reads own text',
    severity: 'info',
    scope: 'file',
    async checkFile(ctx, file) {
      const t = await ctx.readFile(file.path);
      return [
        {
          ruleId: 'g.text',
          severity: 'info',
          message: `${file.path}:${t.length}`,
          filePath: file.path,
          line: 1,
          key: `g.text|${file.path}`,
        },
      ];
    },
  };

  interface Disk {
    cache: LintCache | null;
    loads: number;
    saves: number;
    singles: string[];
    batches: string[][];
  }

  function wired(getIndex: () => ErbIndex, disk: Disk): ConventionEngine {
    return new ConventionEngine({
      log: silentLog,
      getProject: () => fakeProject(),
      getIndex,
      readFile: async (path: string) => {
        disk.singles.push(path);
        const t = pf[path];
        if (t === undefined) throw new Error(`not found: ${path}`);
        return t;
      },
      readFiles: async (paths) => {
        disk.batches.push([...paths]);
        return paths.map((p) => pf[p] ?? null);
      },
      getAdapterRules: () => [textRule],
    getAdapterPolicy: () => undefined,
      snapshot: {
        expectFor: () => EXPECT,
        load: async () => {
          disk.loads++;
          return disk.cache;
        },
        save: (cache) => {
          disk.saves++;
          disk.cache = cache;
        },
      },
    });
  }

  it('冷轮（盘上无缓存）⇒ 装载后一次批取全部 stale，不重复批取', async () => {
    const disk: Disk = { cache: null, loads: 0, saves: 0, singles: [], batches: [] };
    const rep = await wired(() => mkIndex(), disk).run();
    expect(rep.failedRules).toEqual([]);
    expect(disk.batches).toHaveLength(1);
    expect([...disk.batches[0]!].sort()).toEqual([A, B].sort());
    expect(disk.singles).toEqual([]); // 批取覆盖齐 ⇒ 零单读
  });

  it('新引擎 + 盘上缓存齐 + 一个字节没改 ⇒ 本轮零批量读（真壳热轮的形状）', async () => {
    const disk: Disk = { cache: null, loads: 0, saves: 0, singles: [], batches: [] };
    await wired(() => mkIndex(), disk).run(); // 第一轮建桶
    expect(disk.saves).toBe(1);
    const batchesAfterCold = disk.batches.length;
    // 模拟"页面重新载入"：全新引擎实例（lastRun 为空），盘上还是那份缓存
    const rep = await wired(() => mkIndex(), disk).run();
    expect(rep.failedRules).toEqual([]);
    expect(rep.issues.filter((i) => i.ruleId === 'g.text')).toHaveLength(2); // 结论照旧复用
    expect(disk.batches).toHaveLength(batchesAfterCold); // **本轮没有发任何批量读**
    expect(disk.singles).toEqual([]);
  });

  it('同引擎改一棵 ⇒ 只读那一棵；未变的那一棵零 IO', async () => {
    let index = mkIndex();
    const disk: Disk = { cache: null, loads: 0, saves: 0, singles: [], batches: [] };
    const engine = wired(() => index, disk);
    await engine.run();
    disk.batches.length = 0;
    index = mkIndex({ bMtime: 201, fingerprint: 'erbfp-2' });
    const rep = await engine.run();
    expect(rep.failedRules).toEqual([]);
    expect([...new Set(disk.batches.flat())].sort()).toEqual([B]); // 变过的必读、没变的绝不读
    expect(disk.singles).toEqual([]);
  });

  it('force（面板重新校验）⇒ 全部文件都在批取覆盖面里，一个都不能少', async () => {
    const disk: Disk = { cache: null, loads: 0, saves: 0, singles: [], batches: [] };
    const engine = wired(() => mkIndex(), disk);
    await engine.run();
    disk.batches.length = 0;
    await engine.run({ force: true });
    expect([...new Set(disk.batches.flat())].sort()).toEqual([A, B].sort());
    expect(disk.singles).toEqual([]);
  });
});

