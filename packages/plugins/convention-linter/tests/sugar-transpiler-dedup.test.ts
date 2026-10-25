/**
 * RULE-DEDUP（W2）：糖侧约定判据只剩转译器一份。
 *
 * 三条钉法（对应判据①②③）：
 * ① **对拍**：同一份 `.kojo` 输入下，校验面板（`ConventionEngine.run` → `report.issues`）
 *   产出的码 / 严重级 / 行号 / 文案与**真转译器**（`@kojo/plugin-kojo-sugar` 的
 *   `sugar.transpile`）诊断逐条一致——期望值当场由转译器算出，不写死、不恒真
 *   （另加"四条码都要出现 / 非 error 也原样透出"的反恒真闸）。
 * ② **单实现**：规则源里不得残留任何本地糖扫描（逐个旧判据零件点名），
 *   且转译器的诊断文案不得出现在规则源里（文案单源 = 转译器 + `diagnostic-copy`）。
 * ③ **服务缺席**：零 issue + `failedRules` 带可读原因（区分"未接线"与"服务缺席"两种形态）；
 *   没有 `.kojo` 的项目不制造失败噪声。
 * 另：分区缓存口径（PERF-12b / PERF-13）——连续两轮校验，正文未变的那棵 `.kojo`
 *   **既不再读盘也不再转译**（调用计数为硬闸）；改一棵只重算那一棵。
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConventionCheckContext,
  ConventionIssue,
  ErbFile,
  ErbIndex,
  GameProject,
  Logger,
  SugarDiagnostic,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { ConventionEngine } from '../src/engine';
import {
  CONT_INSIDE_QUOTES_RULE_ID,
  EXPR_MISSING_ELSE_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
  SUGAR_LINT_DIAGNOSTIC_CODES,
  SUGAR_LINT_RULE_IDS,
  SUGAR_STATIC_CONVENTIONS_RULE_ID,
  createSugarStaticConventionsRule,
  setSugarTranspileProvider,
  sugarLintRuleIdOf,
  sugarTranspileProviderWired,
} from '../src/rules/sugar-conventions';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * 真转译服务：分野表取 eraTW adapter 的真实模板（否则时机认不出、整块 fail-closed，
 * `readonly-alias-assignment` 这类**代码生成期**诊断走不到）。
 * 测试文件豁免「插件间不得交叉 import」（`tools/audit-decoupling.mjs` C 项对 `tests/` 的例外）。
 */
function makeSugarService(): SugarTranspileService {
  return createSugarTranspileService({ faceTable: createEratwFaceTable() });
}

const KOJO_A = '/p/kojo/M_KOJO_K12_指令.kojo';
const KOJO_B = '/p/kojo/M_KOJO_K13_指令.kojo';
const PLAIN_ERB = '/p/kojo/M_KOJO_K14_事件.ERB';

/** `续` 写在引号内（同一行两处 ⇒ 两条诊断）+ 表达式 `如果` 缺 `否则` */
const SRC_A = [
  '角色: 12',
  '时机 指令 310：',
  '    「这是 续」「再来 续」 续',
  '    她的心情 = 如果 她的好感度 >= 500：',
  '        "热情"',
].join('\n');

/** 一个时机两个 `选项` 块 + 只读别名作赋值左值 */
const SRC_B = [
  '角色: 13',
  '别名 基准 = 500',
  '时机 指令 311：',
  '    选项：',
  '        「甲」：',
  '            「……」',
  '    选项：',
  '        「乙」：',
  '            「……」',
  '    基准 = 600',
].join('\n');

const SOURCES: Record<string, string> = { [KOJO_A]: SRC_A, [KOJO_B]: SRC_B, [PLAIN_ERB]: '@A\nPRINTL 1\n' };

function project(): GameProject {
  return { rootDir: '/p', adapterId: 'test', kojoPaths: ['/p/kojo'], writablePaths: [], charaIndex: new Map() };
}

function indexFor(paths: readonly string[], mtimes?: ReadonlyMap<string, number | null>): ErbIndex {
  const files = new Map<string, ErbFile>();
  for (const p of paths) files.set(p, parseErbText('', p));
  return { files, byName: new Map(), ...(mtimes ? { fileMtimes: mtimes } : {}) };
}

function ctxFor(paths: readonly string[], texts: Record<string, string> = SOURCES): ConventionCheckContext {
  return {
    project: project(),
    index: indexFor(paths),
    readFile: async (path: string) => {
      const t = texts[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    log: silentLog,
  };
}

interface Run {
  engine: ConventionEngine;
  readonly reads: string[];
}

/**
 * 起一个跑内置糖规则的引擎：内置规则经**模块级惰性通道**取服务
 * （`setSugarTranspileProvider`）——这正是装配点（`index.ts`）要做的那一行。
 */
function engineWith(opts: {
  index: ErbIndex;
  /** 传给内置规则的服务通道（null = 装配未接线） */
  provider: (() => SugarTranspileService | null | undefined) | null;
  files?: Record<string, string>;
  /** 装一个判据齐备的快照端口（分区复用必需：`gateFp` 为空时引擎不建内存态） */
  snapshot?: boolean;
}): Run {
  setSugarTranspileProvider(opts.provider);
  const reads: string[] = [];
  const texts = opts.files ?? SOURCES;
  const engine = new ConventionEngine({
    log: silentLog,
    getProject: () => project(),
    getIndex: () => opts.index,
    readFile: async (path: string) => {
      reads.push(path);
      const t = texts[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    getAdapterRules: () => [],
    getAdapterPolicy: () => undefined,
    ...(opts.snapshot
      ? {
          snapshot: {
            expectFor: () => ({ projectRoot: '/p', adapterId: 'test', fingerprint: 'fp-dedup' }),
            load: async () => null,
            save: () => undefined,
          },
        }
      : {}),
  });
  return { engine, reads };
}

const isAdopted = (code: string): boolean => (SUGAR_LINT_DIAGNOSTIC_CODES as readonly string[]).includes(code);

type Row = { ruleId: string; severity: string; message: string; filePath: string; line: number };

/** 转译器诊断 → 对拍用的期望投影（独立算出：只共用码表，不共用规则代码） */
function expectedRows(service: SugarTranspileService, paths: readonly string[]): Row[] {
  const out: Row[] = [];
  for (const path of paths) {
    const src = SOURCES[path];
    if (src === undefined) continue;
    for (const d of service.transpile(src, { filePath: path }).diagnostics) {
      if (!isAdopted(d.code)) continue;
      out.push({
        ruleId: sugarLintRuleIdOf(d.code),
        severity: d.severity,
        message: d.message,
        filePath: path,
        line: d.loc?.line ?? 0,
      });
    }
  }
  return out;
}

const rowOf = (i: ConventionIssue): Row => ({
  ruleId: i.ruleId,
  severity: i.severity,
  message: i.message,
  filePath: i.filePath ?? '',
  line: i.line ?? 0,
});

const tuple = (r: Row): string => `${r.filePath}|${r.line}|${r.ruleId}|${r.severity}|${r.message}`;
const sorted = (xs: readonly string[]) => [...xs].sort((a, b) => a.localeCompare(b));
/** 报告条目的稳定身份（引擎已按 key 去重；比对两轮结果用） */
const keys = (rep: { issues: readonly ConventionIssue[] }): string[] => sorted(rep.issues.map((i) => i.key ?? ''));

/* ============================== 夹具自证：转译器真的报这几条 ============================== */

describe('W2 夹具自证（真转译器）', () => {
  it('四条码各至少命中一条，`续` 那条同一行两次（否则对拍会退化成恒真）', () => {
    const service = makeSugarService();
    const rows = expectedRows(service, [KOJO_A, KOJO_B]);
    const codes = rows.map((r) => r.ruleId);
    for (const id of SUGAR_LINT_RULE_IDS) {
      expect(codes.filter((c) => c === id).length, `夹具必须命中 ${id}`).toBeGreaterThan(0);
    }
    expect(rows.filter((r) => r.ruleId === CONT_INSIDE_QUOTES_RULE_ID).length).toBeGreaterThanOrEqual(2);
  });
});

/* ============================== ① 面板 ↔ 转译器逐条对拍 ============================== */

describe('W2①：校验面板产出 = 转译器诊断（逐条一致）', () => {
  const service = makeSugarService();

  it('码 / 严重级 / 行号 / 文案四列逐条相同，条数不多不少', async () => {
    const { engine } = engineWith({ index: indexFor([KOJO_A, KOJO_B, PLAIN_ERB]), provider: () => service });
    const rep = await engine.run();
    const got = rep.issues.filter((i) => SUGAR_LINT_RULE_IDS.includes(i.ruleId));
    const expected = expectedRows(service, [KOJO_A, KOJO_B, PLAIN_ERB]);

    expect(got.length, '对拍不能对空数组').toBeGreaterThan(0);
    expect(got.length).toBe(expected.length);
    expect(sorted(got.map((i) => tuple(rowOf(i))))).toEqual(sorted(expected.map(tuple)));
    expect(new Set(SUGAR_LINT_RULE_IDS)).toEqual(new Set(got.map((i) => i.ruleId)));
    // 面板条目不再带旧扫描的固定 error 口径：等级由诊断决定（夹具里既有 error 也走同一条断言）
    expect(rep.failedRules).toEqual([]);
  });

  it('ruleId 一律是 `sugar.<转译器码>`；两个自造旧码彻底消失', async () => {
    const { engine } = engineWith({ index: indexFor([KOJO_A, KOJO_B]), provider: () => service });
    const rep = await engine.run();
    const ids = [...new Set(rep.issues.map((i) => i.ruleId))];
    for (const id of ids) {
      expect(id.startsWith('sugar.')).toBe(true);
      expect(SUGAR_LINT_RULE_IDS).toContain(id);
    }
    expect(ids).not.toContain('sugar.multiple-choice-blocks');
    expect(ids).not.toContain('sugar.readonly-alias-assign');
  });

  it('同一行多条诊断不被去重合并（key 带列位）', async () => {
    const { engine } = engineWith({ index: indexFor([KOJO_A]), provider: () => service });
    const rep = await engine.run();
    const hits = rep.issues.filter((i) => i.ruleId === CONT_INSIDE_QUOTES_RULE_ID);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hits.map((i) => i.key)).size).toBe(hits.length);
    expect(hits.every((i) => i.line === 3)).toBe(true);
  });

  it('显式注入（工厂 + provider）与装配通道（模块 provider）产出逐条相同', async () => {
    const { engine } = engineWith({ index: indexFor([KOJO_A, KOJO_B]), provider: () => service });
    const rep = await engine.run();
    const viaEngine = rep.issues.filter((i) => SUGAR_LINT_RULE_IDS.includes(i.ruleId));
    const viaFactory = await createSugarStaticConventionsRule(() => service).check!(
      ctxFor([KOJO_A, KOJO_B]),
    );
    expect(sorted(viaFactory.map((i) => tuple(rowOf(i))))).toEqual(sorted(viaEngine.map((i) => tuple(rowOf(i)))));
  });

  it('严重级按诊断透出（旧实现恒 error 的口径已死）', async () => {
    const stub = {
      transpile: () => ({
        erb: '',
        sourceMap: [],
        diagnostics: [
          { code: 'choice-multiple', severity: 'warning', message: 'W 案', loc: { line: 7, column: 3 } },
          { code: 'expr-missing-else', severity: 'info', message: 'I 案', loc: { line: 9, column: 1 } },
        ] satisfies SugarDiagnostic[],
      }),
    } as unknown as SugarTranspileService;
    const issues = await createSugarStaticConventionsRule(() => stub).check!(ctxFor([KOJO_A]));
    const byId = new Map(issues.map((i) => [i.ruleId, i]));
    expect(byId.get(MULTIPLE_CHOICE_BLOCKS_RULE_ID)?.severity).toBe('warning');
    expect(byId.get(EXPR_MISSING_ELSE_RULE_ID)?.severity).toBe('info');
    expect(byId.get(MULTIPLE_CHOICE_BLOCKS_RULE_ID)?.message).toBe('W 案');
    expect(byId.get(MULTIPLE_CHOICE_BLOCKS_RULE_ID)?.line).toBe(7);
    expect(byId.get(MULTIPLE_CHOICE_BLOCKS_RULE_ID)?.key).toContain('|7|3');
  });

  it('非 `.kojo` 文件不参与（连正文都不读）', async () => {
    const { engine, reads } = engineWith({
      index: indexFor([PLAIN_ERB]),
      provider: () => service,
      files: { [PLAIN_ERB]: SRC_A }, // 内容是坏糖源也不该被扫
    });
    const rep = await engine.run();
    expect(rep.issues.filter((i) => SUGAR_LINT_RULE_IDS.includes(i.ruleId))).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('读盘失败 ⇒ 该棵本轮无结论（只 warn 跳过，不伪造、不算规则失败）', async () => {
    const rule = createSugarStaticConventionsRule(() => service);
    const ctx = ctxFor([KOJO_A, KOJO_B], { [KOJO_A]: SRC_A }); // KOJO_B 不在表里 ⇒ readFile 抛
    const viaCheck = await rule.check!(ctx);
    const unitB = await rule.partition!.fileUnit(ctx, { path: KOJO_B } as ErbFile);
    const combined = await rule.partition!.combine(ctx, [
      { file: { path: KOJO_A } as ErbFile, unit: await rule.partition!.fileUnit(ctx, { path: KOJO_A } as ErbFile) },
      { file: { path: KOJO_B } as ErbFile, unit: unitB },
    ]);
    expect(unitB).toBeUndefined();
    expect(sorted(combined.map((i) => tuple(rowOf(i))))).toEqual(
      sorted(viaCheck.map((i) => tuple(rowOf(i)))),
    );
    expect(viaCheck.every((i) => i.filePath === KOJO_A)).toBe(true);
    expect(viaCheck.length).toBeGreaterThan(0);
  });
});

/* ============================== ② 判据只剩一份（源码自证） ============================== */

describe('W2②：本地糖扫描判据已整块删除', () => {
  /** 旧实现的判据零件（残留任何一个都意味着还有第二份判断） */
  const LEGACY_MARKERS = [
    'CONT_MARKS',
    'ScanLine',
    'AliasEntry',
    'TAB_WIDTH',
    'indentOf',
    'stripLineComment',
    'scanLines',
    'endsWithBlockColon',
    'isRawLine',
    'isRawBlockStart',
    'stripBlockColon',
    'checkContInsideQuotes',
    'checkMultipleChoiceBlocks',
    'checkExprMissingElse',
    'checkReadonlyAliasAssign',
    'isChoiceHead',
    'isTimingHead',
    'isExprIfHead',
    'isExprWhenHead',
    'isReadonlyAliasTarget',
    'parseAliasDecl',
    'assignTarget',
    'scanFileConventions',
  ];

  /** 只留代码行（注释里允许讲历史） */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  const ruleSource = codeOnly(readFileSync(new URL('../src/rules/sugar-conventions.ts', import.meta.url), 'utf8'));

  it('规则源里没有旧扫描零件 / 自造子 ruleId 字面量，判据入口只剩一次 `transpile`', () => {
    for (const marker of LEGACY_MARKERS) expect(ruleSource, `残留判据零件：${marker}`).not.toContain(marker);
    for (const legacy of ['sugar.multiple-choice-blocks', 'sugar.readonly-alias-assign']) {
      expect(ruleSource, `残留自造码：${legacy}`).not.toContain(legacy);
    }
    expect((ruleSource.match(/\.transpile\(/g) ?? []).length).toBe(1);
    expect(ruleSource).not.toMatch(/split\(\/r/);
    expect(ruleSource).not.toMatch(/\\r\\n\|\\n/);
  });

  it('转译器的诊断文案没有第二条副本（逐条拿真文案回查规则源）', () => {
    const service = makeSugarService();
    const messages = expectedRows(service, [KOJO_A, KOJO_B]).map((r) => r.message);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) expect(ruleSource, `文案被抄进规则源：${m}`).not.toContain(m);
    expect(ruleSource).toMatch(/message:\s*diag\.message/);
    expect(ruleSource).not.toMatch(/message:\s*['"`]/);
  });

  it('子 ruleId 常量由码表推导（面板登记面与产出面同源）', () => {
    expect(CONT_INSIDE_QUOTES_RULE_ID).toBe(sugarLintRuleIdOf('cont-inside-quotes'));
    expect(MULTIPLE_CHOICE_BLOCKS_RULE_ID).toBe(sugarLintRuleIdOf('choice-multiple'));
    expect(EXPR_MISSING_ELSE_RULE_ID).toBe(sugarLintRuleIdOf('expr-missing-else'));
    expect(READONLY_ALIAS_ASSIGN_RULE_ID).toBe(sugarLintRuleIdOf('readonly-alias-assignment'));
    expect([...SUGAR_LINT_RULE_IDS].sort()).toEqual(
      [
        CONT_INSIDE_QUOTES_RULE_ID,
        MULTIPLE_CHOICE_BLOCKS_RULE_ID,
        EXPR_MISSING_ELSE_RULE_ID,
        READONLY_ALIAS_ASSIGN_RULE_ID,
      ].sort(),
    );
  });

  it('盘上旧形态（文本扫描产物）被 isUnit 判死，不会当成结论复用', () => {
    const isUnit = createSugarStaticConventionsRule(() => null).partition!.isUnit!;
    expect(isUnit(null)).toBe(true);
    expect(isUnit([])).toBe(true);
    expect(isUnit([{ ruleId: CONT_INSIDE_QUOTES_RULE_ID, severity: 'error', message: 'x' }])).toBe(true);
    expect(isUnit([{ ruleId: 'sugar.multiple-choice-blocks', severity: 'error', message: '旧扫描码' }])).toBe(false);
    expect(isUnit([{ ruleId: 'sugar.readonly-alias-assign', severity: 'error', message: '旧扫描码' }])).toBe(false);
    expect(isUnit(['乱结构'])).toBe(false);
  });
});

/* ============================== ③ 服务缺席：fail-open 且不静默 ============================== */

describe('W2③：转译服务缺席时零 issue + 可读原因', () => {
  afterEach(() => setSugarTranspileProvider(null));

  it('装配未接线 ⇒ 糖侧零条目，failedRules 带"未接线"原因', async () => {
    const { engine } = engineWith({ index: indexFor([KOJO_A, KOJO_B]), provider: null });
    expect(sugarTranspileProviderWired()).toBe(false);
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toEqual([]);
    const failed = rep.failedRules.find((f) => f.ruleId === SUGAR_STATIC_CONVENTIONS_RULE_ID);
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('未接线');
    expect(failed!.error).toContain('未报问题不等于没有问题');
  });

  it('接线了但取不到服务实例 ⇒ 原因写成"服务缺席"（两种形态可分辨）', async () => {
    const { engine } = engineWith({ index: indexFor([KOJO_A]), provider: () => null });
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toEqual([]);
    const failed = rep.failedRules.find((f) => f.ruleId === SUGAR_STATIC_CONVENTIONS_RULE_ID)!;
    expect(failed.error).toContain('服务缺席');
  });

  it('转译服务抛错 ⇒ 整条规则本轮没有结论（分区路径 fail-closed，不伪造"没问题"）', async () => {
    const boom = {
      transpile: () => {
        throw new Error('转译器炸了');
      },
    } as unknown as SugarTranspileService;
    const { engine } = engineWith({ index: indexFor([KOJO_A]), provider: () => boom });
    const rep = await engine.run();
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toEqual([]);
    expect(rep.failedRules.map((f) => f.ruleId)).toContain(SUGAR_STATIC_CONVENTIONS_RULE_ID);
    // 非分区路径（`check` 对拍基准）原样把服务异常抛出去
    await expect(createSugarStaticConventionsRule(() => boom).check!(ctxFor([KOJO_A]))).rejects.toThrow(
      /转译器炸了/,
    );
  });

  it('没有 `.kojo` 的项目 ⇒ 不报失败也不报条目（无事可做 ≠ 服务缺席）', async () => {
    const { engine, reads } = engineWith({ index: indexFor([PLAIN_ERB]), provider: null });
    const rep = await engine.run();
    expect(rep.failedRules).toEqual([]);
    expect(rep.issues.filter((i) => i.ruleId.startsWith('sugar.'))).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('`check`（对拍基准路径）在服务缺席时同样抛可读原因（两种形态分别成文）', async () => {
    await expect(createSugarStaticConventionsRule(() => null).check!(ctxFor([KOJO_A]))).rejects.toThrow(/服务缺席/);
    await expect(createSugarStaticConventionsRule(null).check!(ctxFor([KOJO_A]))).rejects.toThrow(/未接线/);
  });

  it('转译器代际门：换了服务实例 ⇒ 分区判据变（绝不拿旧贡献配新转译器）', async () => {
    const s1 = makeSugarService();
    const s2 = makeSugarService();
    const ctx = ctxFor([KOJO_A]);
    const k1 = await createSugarStaticConventionsRule(() => s1).partition!.key!(ctx);
    const k2 = await createSugarStaticConventionsRule(() => s2).partition!.key!(ctx);
    expect(k1).not.toBe(k2);
    expect(k1).toContain('@test');
    // 同一枚服务 ⇒ 判据稳定（复用的前提）
    expect(await createSugarStaticConventionsRule(() => s1).partition!.key!(ctx)).toBe(k1);
    // 没有 `.kojo` ⇒ 判据不依赖服务，也不因服务缺席而抛
    expect(await createSugarStaticConventionsRule(null).partition!.key!(ctxFor([PLAIN_ERB]))).toContain('no-kojo');
  });
});

/* ============================== 缓存口径（PERF-12b / PERF-13 不许回退） ============================== */

describe('W2 缓存：连续两轮校验不重复读盘 / 不重复转译', () => {
  it('正文未变 ⇒ 第二轮对同一棵 `.kojo` 零 readFile、零 transpile；改一棵只补算那一棵', async () => {
    const real = makeSugarService();
    let calls = 0;
    const counting = {
      ...real,
      transpile: (source: string, options?: { filePath?: string }) => {
        calls++;
        return real.transpile(source, options);
      },
    } as unknown as SugarTranspileService;

    const mtimes = new Map<string, number | null>([
      [KOJO_A, 1000],
      [KOJO_B, 1000],
      [PLAIN_ERB, 1000],
    ]);
    const paths = [KOJO_A, KOJO_B, PLAIN_ERB];
    const { engine, reads } = engineWith({
      index: indexFor(paths, mtimes),
      provider: () => counting,
      snapshot: true,
    });

    const first = await engine.run();
    expect(calls).toBe(2); // 只有两棵 `.kojo` 被转译
    expect(reads.length).toBe(2);
    const expected = sorted(expectedRows(real, paths).map(tuple));
    expect(sorted(first.issues.filter((i) => SUGAR_LINT_RULE_IDS.includes(i.ruleId)).map((i) => tuple(rowOf(i))))).toEqual(
      expected,
    );

    const second = await engine.run();
    expect(calls, '正文没变就不该再转译一遍').toBe(2);
    expect(reads.length, '正文没变就不该再读一遍盘').toBe(2);
    expect(keys(second)).toEqual(keys(first));

    mtimes.set(KOJO_B, 2000);
    const third = await engine.run();
    expect(calls, '改一棵只该重算那一棵').toBe(3);
    expect(keys(third)).toEqual(keys(first));
  });
});
