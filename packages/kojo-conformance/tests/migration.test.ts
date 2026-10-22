/**
 * 迁移 differential harness 单测（K2-MIGRATION-DIFFERENTIAL）。
 *
 * 钉四件事，缺一条这套 harness 就没有意义：
 * 1. **状态判定**：identical / normalized-equal / differs / blocked 各自可达，blocked 带原因；
 * 2. **不洗白**：真实行为差异（`PRINTFORMDW`→`PRINTFORMW`、引号有无、`SETCOLOR`、ARG 真被读）
 *    **必须**落 `differs`——白名单只允许注释/空行/包装头/排版空白；
 * 3. **迁移率口径**：v1 写法按行计、unsupported 按块缩进体折算、按 construct 分类；
 * 4. **报告稳定**：JSON 字段序 / case 序 / 失败序稳定；空语料不是全绿；CLI 退出码 0/1/2 各就各位。
 *
 * 全部用注入的假编译器 + 内存 IO：本文件不碰真盘、不碰真 core（真链路在
 * `packages/kojo-core/tests/migration-corpus.test.ts`）。
 */
import { describe, expect, it } from 'vitest';
import type {
  MigrationCase,
  MigrationCompilerOutput,
  MigrationCorpusIo,
  MigrationDifferentialResult,
} from '../src/migration.js';
import {
  MIGRATION_CLI_USAGE,
  MIGRATION_NORMALIZATIONS,
  applyMigrationCompletion,
  attemptMigration,
  collectV1Sites,
  countMigrationRate,
  formatMigrationReport,
  generateMigrationManifest,
  loadMigrationCorpus,
  normalizeMigrationProduct,
  runMigrationCli,
  runMigrationDifferential,
  verifyMigrationGoldens,
} from '../src/migration.js';

/* ============================== 夹具 ============================== */

const out = (text: string, ok = true): MigrationCompilerOutput => ({ ok, text });

/** 跑一条 case：给两侧产物与迁移结果 */
function runOne(input: {
  readonly v1: string | MigrationCompilerOutput;
  readonly v2: string | MigrationCompilerOutput;
  readonly source?: string;
  readonly migrated?: string;
  readonly migrateOk?: boolean;
  readonly unsupported?: readonly { line: number; construct: string; code?: string }[];
  readonly expect?: MigrationCase['expect'];
  readonly v1Throws?: boolean;
  readonly migrationThrows?: boolean;
  readonly id?: string;
}): MigrationDifferentialResult {
  const id = input.id ?? 'case-1';
  return runMigrationDifferential({
    cases: [{ id, source: input.source ?? '角色: 1\n\n时机 指令 310：\n    你好。\n', ...(input.expect === undefined ? {} : { expect: input.expect }) }],
    compileV1: () => {
      if (input.v1Throws === true) throw new Error('v1 boom');
      return typeof input.v1 === 'string' ? out(input.v1) : input.v1;
    },
    compile2: () => (typeof input.v2 === 'string' ? out(input.v2) : input.v2),
    migrate: () => {
      if (input.migrationThrows === true) throw new Error('migrate boom');
      return {
        ok: input.migrateOk ?? true,
        code: input.migrated ?? '# 机 指令 310\n> 你好。\n',
        unsupported: input.unsupported ?? [],
      };
    },
  });
}

const BASE_V1 = ['@M_KOJO_MESSAGE_COM_K1_310', 'CALL M_KOJO_MESSAGE_COM_K1_310_1', 'RETURN RESULT', '', '@M_KOJO_MESSAGE_COM_K1_310_1', 'LOCAL = 1', 'IF LOCAL', '\tPRINTFORMW 你好。', 'ENDIF', 'RETURN 1', ''].join('\n');

/* ============================== 1. 四种状态 ============================== */

describe('状态判定：identical / normalized-equal / differs / blocked', () => {
  it('两侧产物逐字节相同 → identical，diff 全 zero', () => {
    const result = runOne({ v1: BASE_V1, v2: BASE_V1 });
    const report = result.cases[0]!;
    expect(report.status).toBe('identical');
    expect(report.blockedReason).toBeNull();
    expect(report.diff.removed).toBe(0);
    expect(report.diff.added).toBe(0);
    expect(report.diff.firstDifference).toBeNull();
    expect(report.readings.normalization).toEqual([]);
    expect(result.summary.identical).toBe(1);
  });

  it('只差注释 / 空行 / `;kojo2:` 包装头 → normalized-equal，且命中项可见', () => {
    const v2 = BASE_V1.replace('@M_KOJO_MESSAGE_COM_K1_310\n', ';kojo2: # 机 指令 310\n@M_KOJO_MESSAGE_COM_K1_310\n').replace(
      'LOCAL = 1\n',
      'LOCAL = 1\n\n;额外的整行注释\n',
    );
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('normalized-equal');
    expect(report.diff.removed).toBe(0);
    expect(report.diff.added).toBe(0);
    const ids = report.readings.normalization.map((hit) => hit.id);
    expect(ids).toContain('machine-header');
    expect(ids).toContain('comment-lines');
    expect(ids).toContain('blank-lines');
  });

  it('只差包装头形参 `(ARG)` → normalized-equal（wrapper-arg-list 命中）', () => {
    const v2 = BASE_V1.replace('@M_KOJO_MESSAGE_COM_K1_310\n', '@M_KOJO_MESSAGE_COM_K1_310(ARG)\n').replace(
      'CALL M_KOJO_MESSAGE_COM_K1_310_1\n',
      'CALL M_KOJO_MESSAGE_COM_K1_310_1(ARG)\n',
    );
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('normalized-equal');
    expect(report.readings.normalization.map((hit) => hit.id)).toContain('wrapper-arg-list');
  });

  it('只差排版缩进（v1 TAB / 2.0 4 空格）→ normalized-equal（indent 命中）', () => {
    const v2 = BASE_V1.replace('\tPRINTFORMW 你好。', '    PRINTFORMW 你好。');
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('normalized-equal');
    expect(report.readings.normalization.map((hit) => hit.id)).toContain('indent');
  });

  it('只差编码面（BOM + CRLF）→ normalized-equal（bom / eol 命中）', () => {
    const v2 = `\uFEFF${BASE_V1.replace(/\n/g, '\r\n')}`;
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('normalized-equal');
    const ids = report.readings.normalization.map((hit) => hit.id);
    expect(ids).toContain('bom');
    expect(ids).toContain('eol');
  });

  it('真产物差异（PRINTFORMDW → PRINTFORMW）→ differs，**不许**洗成 equal', () => {
    const v2 = BASE_V1.replace('PRINTFORMW 你好。', 'PRINTFORMDW 你好。');
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('differs');
    expect(report.diff.removed + report.diff.added).toBe(2);
    expect(report.diff.firstDifference?.kind).toBe('removed');
    expect(report.diff.firstDifference?.baseline).toContain('PRINTFORMW');
    expect(report.diff.excerpt.some((item) => item.candidate?.includes('PRINTFORMDW'))).toBe(true);
  });

  it('真产物差异（引号有无）→ differs（迁移把 `「」` 当语法剥掉，行为变了）', () => {
    const v1 = BASE_V1.replace('PRINTFORMW 你好。', 'PRINTFORMW 「你好。」');
    const report = runOne({ v1, v2: BASE_V1 }).cases[0]!;
    expect(report.status).toBe('differs');
    expect(report.diff.excerpt[0]?.baseline).toBe('PRINTFORMW 「你好。」');
  });

  it('真产物差异（多一条 SETCOLOR）→ differs（演出差异不是排版）', () => {
    const v2 = BASE_V1.replace('IF LOCAL\n', 'IF LOCAL\nSETCOLOR 0xFF0000\n');
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('differs');
    expect(report.diff.added).toBe(1);
  });

  it('ARG 在包装头之外真被读 → wrapper-arg-list 放弃归一，落 differs 并写明原因', () => {
    const v1 = BASE_V1.replace('PRINTFORMW 你好。', 'PRINTFORMW %ARG%');
    const v2 = BASE_V1.replace('PRINTFORMW 你好。', 'PRINTFORMW %ARG%')
      .replace('@M_KOJO_MESSAGE_COM_K1_310\n', '@M_KOJO_MESSAGE_COM_K1_310(ARG)\n');
    const report = runOne({ v1, v2 }).cases[0]!;
    expect(report.status).toBe('differs');
    const hit = report.readings.normalization.find((item) => item.id === 'wrapper-arg-list');
    expect(hit?.lines).toBe(0);
    expect(hit?.why).toContain('ARG');
  });

  it('diff 摘要：removed / added 计数与 excerpt 上限 8', () => {
    const v2 = BASE_V1.split('\n')
      .slice(0, 5)
      .concat(Array.from({ length: 12 }, (_, i) => `EXTRA ${i}`))
      .join('\n');
    const report = runOne({ v1: BASE_V1, v2 }).cases[0]!;
    expect(report.status).toBe('differs');
    expect(report.diff.added).toBeGreaterThan(8);
    expect(report.diff.excerpt.length).toBeLessThanOrEqual(8);
    expect(report.diff.excerpt.some((item) => item.candidate === 'EXTRA 0')).toBe(true);
  });
});

/* ============================== 2. blocked 归类 ============================== */

describe('blocked：四种原因各归各位（不混进 differs）', () => {
  it('v1 侧有 error → blocked / v1-compile-failed，读数带首个错误码', () => {
    const report = runOne({
      v1: { ok: false, text: '', diagnostics: [{ code: 'indent-mismatch', severity: 'error', message: 'x' }] },
      v2: BASE_V1,
    }).cases[0]!;
    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toBe('v1-compile-failed');
    expect(report.readings.v1.firstErrorCode).toBe('indent-mismatch');
    expect(report.products.v2).toBeNull();
  });

  it('v1 编译器抛错 → blocked / v1-compile-failed（不把异常当差异）', () => {
    const report = runOne({ v1: BASE_V1, v2: BASE_V1, v1Throws: true }).cases[0]!;
    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toBe('v1-compile-failed');
    expect(report.readings.v1.errors).toBe(1);
  });

  it('迁移台账非空 → blocked / migration-unsupported，construct 清单上屏', () => {
    const report = runOne({
      v1: BASE_V1,
      v2: BASE_V1,
      migrateOk: false,
      unsupported: [
        { line: 4, construct: '`循环 …：` 块', code: 'core/migration/loop' },
        { line: 8, construct: '`数据表：` 随机数据表块', code: 'core/migration/data' },
      ],
    }).cases[0]!;
    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toBe('migration-unsupported');
    expect(report.readings.migration.unsupported).toBe(2);
    expect(report.readings.migration.unsupportedConstructs).toEqual([
      '`循环 …：` 块',
      '`数据表：` 随机数据表块',
    ]);
  });

  it('迁移器抛错 → blocked / migration-error（区分"报 unsupported"与"坏了"）', () => {
    const report = runOne({ v1: BASE_V1, v2: BASE_V1, migrationThrows: true }).cases[0]!;
    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toBe('migration-error');
  });

  it('迁移产物编不过 → blocked / v2-compile-failed（红灯，不是正常缺口）', () => {
    const report = runOne({
      v1: BASE_V1,
      v2: { ok: false, text: '', diagnostics: [{ code: 'event/unknown', severity: 'error', message: 'x' }] },
    }).cases[0]!;
    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toBe('v2-compile-failed');
    expect(report.readings.v2.firstErrorCode).toBe('event/unknown');
  });

  it('attemptMigration 把抛错收成结果（导出口径与对拍一致）', () => {
    const attempt = attemptMigration(() => {
      throw new Error('boom');
    }, '角色: 1\n');
    expect(attempt.threw).toBe(true);
    expect(attempt.output).toBeNull();
  });
});

/* ============================== 3. 期望 ≠ 通过 ============================== */

describe('期望门：与期望一致才 ok（不是"全部 equal"才 ok）', () => {
  it('无期望时 ok = true（只报告）', () => {
    const result = runOne({ v1: BASE_V1, v2: BASE_V1.replace('PRINTFORMW', 'PRINTFORMDW') });
    expect(result.cases[0]?.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('状态与期望不符 → ok=false，failures 带 kind=expectation + 人话', () => {
    const result = runOne({
      v1: BASE_V1,
      v2: BASE_V1,
      expect: { status: 'differs' },
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.mismatch).toContain('期望状态 differs');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe('expectation');
  });

  it('blocked 的**原因**也要与期望相符（同为 blocked 但原因不同 = 红）', () => {
    const result = runOne({
      v1: BASE_V1,
      v2: BASE_V1,
      migrateOk: false,
      unsupported: [{ line: 1, construct: '`循环 …：` 块' }],
      expect: { status: 'blocked', blockedReason: 'v2-compile-failed' },
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.mismatch).toContain('blocked 原因');
  });

  it('期望与实测一致 → ok=true（differs 也可以是绿的：如实读到的现状）', () => {
    const result = runOne({
      v1: BASE_V1,
      v2: BASE_V1.replace('PRINTFORMW', 'PRINTFORMDW'),
      expect: { status: 'differs' },
    });
    expect(result.cases[0]?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});

/* ============================== 4. 迁移率 ============================== */

describe('迁移率：按行计写法、unsupported 按块折算、按 construct 分类', () => {
  const SOURCE = ['角色: 1', '', '时机 指令 310：', '    普通旁白。', '    如果 恋慕 >= 5：', '        也被迁移。', '    循环 3 次：', '        循环结束', ''].join('\n');

  it('collectV1Sites：注释与空行不算写法，条件块与循环块各算一处', () => {
    const sites = collectV1Sites(SOURCE);
    expect(sites.map((site) => site.construct)).toEqual([
      '文件头声明',
      '时机块',
      '叙事行',
      '如果 / 否则如果',
      '叙事行',
      '循环族',
      '循环族',
    ]);
  });

  it('unsupported 块覆盖整段缩进体 ⇒ 这些行不算"已迁移"', () => {
    const report = countMigrationRate([{ id: 'c', source: SOURCE, unsupported: [{ line: 7, construct: '`循环 …：` 块' }] }]);
    expect(report.v1Sites).toBe(7);
    expect(report.unsupported).toBe(2);
    expect(report.autoMigrated).toBe(5);
    expect(report.migrationRate).toBeCloseTo(5 / 7, 6);
    const loop = report.byConstruct.find((row) => row.construct === '`循环 …：` 块');
    expect(loop).toEqual({ construct: '`循环 …：` 块', sites: 2, migrated: 0, unsupported: 2 });
  });

  it('空语料 → 全 zero、migrationRate 0（不抛、不 NaN）', () => {
    const report = countMigrationRate([]);
    expect(report).toEqual({ cases: 0, v1Sites: 0, autoMigrated: 0, unsupported: 0, migrationRate: 0, byConstruct: [] });
  });

  it('runMigrationDifferential 把每 case 台账喂进迁移率（不是只看 ok）', () => {
    const result = runMigrationDifferential({
      cases: [{ id: 'a', source: SOURCE, expect: null }],
      compileV1: () => out(BASE_V1),
      compile2: () => out(BASE_V1),
      migrate: () => ({ ok: false, code: SOURCE, unsupported: [{ line: 7, construct: '`循环 …：` 块' }] }),
    });
    expect(result.migrationReport.cases).toBe(1);
    expect(result.migrationReport.v1Sites).toBe(7);
    expect(result.migrationReport.unsupported).toBe(2);
    expect(result.summary.blocked).toBe(1);
    expect(result.ok).toBe(true);
  });
});

/* ============================== 5. 白名单本体 ============================== */

describe('归一化白名单：显式、写死、逐条给依据', () => {
  it('恰好七项，每项都有 why（白名单本身就是审阅对象）', () => {
    expect(MIGRATION_NORMALIZATIONS.map((item) => item.id)).toEqual([
      'bom',
      'eol',
      'machine-header',
      'comment-lines',
      'blank-lines',
      'wrapper-arg-list',
      'indent',
    ]);
    for (const item of MIGRATION_NORMALIZATIONS) expect(item.why.length).toBeGreaterThan(20);
  });

  it('白名单不碰引擎记号：行内 `;` 注释 / 行尾差异原样留下', () => {
    const normalized = normalizeMigrationProduct('PRINTFORMW 甲 ;作者批注\nPRINTFORMW 乙');
    expect(normalized.lines).toEqual(['PRINTFORMW 甲 ;作者批注', 'PRINTFORMW 乙']);
    expect(normalized.hits).toEqual([]);
  });

  it('`;kojo2:` 头只在整行时剥（行内出现不动）', () => {
    const normalized = normalizeMigrationProduct(';kojo2: # 机 指令 310\nPRINTFORMW ;kojo2: 甲');
    expect(normalized.lines).toEqual(['PRINTFORMW ;kojo2: 甲']);
    expect(normalized.hits.map((hit) => hit.id)).toEqual(['machine-header']);
  });
});

/* ============================== 6. 语料载入 + golden 复核 ============================== */

/** 内存 IO：`files` 是相对路径 → 文本 */
function memoryIo(files: Record<string, string>): MigrationCorpusIo {
  return {
    readText: (target: string) => {
      const key = target.replaceAll('\\', '/').replace(/^\.\//, '');
      const text = files[key];
      if (text === undefined) throw new Error(`ENOENT ${key}`);
      return text;
    },
    listFiles: (dir: string) => {
      const prefix = `${dir.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
    },
  };
}

const MANIFEST = (cases: readonly unknown[]): string =>
  JSON.stringify({ schema: 'kojo-migration-corpus/1', notes: 'fixture', cases }, null, 2);

const RECORD = {
  id: 'case-a',
  source: 'fixtures/案例.kojo',
  sourceSha256: 'x',
  headerLines: 2,
  eol: 'lf',
  tier: 'dual-golden',
  constructs: ['时机块'],
  completion: { stripBanner: false, prependChara: null },
  notes: '测试用',
  expected: { status: 'identical', blockedReason: null },
};

const V1_SOURCE = '; 头注一\n; 头注二\n角色: 1\n\n时机 指令 310：\n    你好。\n';

describe('语料目录：manifest 是真源、头注精确剥离、golden 复核', () => {
  it('头注按 headerLines 剥掉、completion 施加在正文上', () => {
    const corpus = loadMigrationCorpus(memoryIo({ 'corpus/manifest.json': MANIFEST([RECORD]), 'corpus/case-a.v1.kojo.txt': V1_SOURCE }), 'corpus');
    expect(corpus.problems).toEqual([]);
    expect(corpus.cases[0]?.source).toBe('角色: 1\n\n时机 指令 310：\n    你好。\n');
    expect(corpus.records[0]?.source).toBe('fixtures/案例.kojo');
  });

  it('completion.prependChara 只在缺 `角色:` 时补（已有则不重复）', () => {
    const strip = applyMigrationCompletion('// 横幅\n时机 指令 1：\n  你好\n', { stripBanner: true, prependChara: '12' });
    expect(strip).toBe('角色: 12\n时机 指令 1：\n  你好\n');
    const keep = applyMigrationCompletion('角色: 7\n时机 指令 1：\n  你好\n', { stripBanner: true, prependChara: '12' });
    expect(keep.startsWith('角色: 7')).toBe(true);
  });

  it('缺清单 / 清单坏 / 头注越界 都进 problems（不静默）', () => {
    const missing = loadMigrationCorpus(memoryIo({ 'corpus/a.v1.kojo.txt': 'x' }), 'corpus');
    expect(missing.problems[0]?.id).toBe('manifest.json');
    const bad = loadMigrationCorpus(memoryIo({ 'corpus/manifest.json': '{oops', 'corpus/a.v1.kojo.txt': 'x' }), 'corpus');
    expect(bad.problems[0]?.message).toContain('无法读取清单');
    const overflow = loadMigrationCorpus(
      memoryIo({ 'corpus/manifest.json': MANIFEST([{ ...RECORD, headerLines: 99 }]), 'corpus/case-a.v1.kojo.txt': V1_SOURCE }),
      'corpus',
    );
    expect(overflow.problems[0]?.message).toContain('头注行数 99 越界');
  });

  it('空语料（清单 0 case）不是全绿：problems 记 "没有任何 case"', () => {
    const corpus = loadMigrationCorpus(memoryIo({ 'corpus/manifest.json': MANIFEST([]) }), 'corpus');
    expect(corpus.problems).toHaveLength(1);
    expect(corpus.problems[0]?.message).toContain('空语料');
  });

  it('golden 复核：产物与 golden 不一致 → kind=golden 失败（哪怕产物"变好了"）', () => {
    const files = {
      'corpus/manifest.json': MANIFEST([{ ...RECORD, expected: { status: 'differs', blockedReason: null } }]),
      'corpus/case-a.v1.kojo.txt': V1_SOURCE,
      'corpus/case-a.v1.erb': 'OLD V1 PRODUCT\n',
      'corpus/case-a.2.erb': 'OLD V2 PRODUCT\n',
    };
    const corpus = loadMigrationCorpus(memoryIo(files), 'corpus');
    const result = runOne({ id: 'case-a', v1: BASE_V1, v2: BASE_V1.replace('PRINTFORMW', 'PRINTFORMDW'), source: corpus.cases[0]?.source });
    const failures = verifyMigrationGoldens(corpus, result);
    expect(failures.map((item) => item.kind)).toEqual(['golden', 'golden']);
    expect(failures[0]?.message).toContain('首差第 1 行');
  });

  it('golden 复核：台账 golden 逐字段比（constructed 计数变了就红）', () => {
    const ledger = JSON.stringify({
      id: 'case-a',
      status: 'blocked',
      blockedReason: 'migration-unsupported',
      v1: { ok: true, lines: 3, errors: 0, firstErrorCode: null },
      migration: { ok: false, unsupported: 1, unsupportedConstructs: ['`循环 …：` 块'], outputLines: 3 },
    });
    const files = {
      'corpus/manifest.json': MANIFEST([
        { ...RECORD, expected: { status: 'blocked', blockedReason: 'migration-unsupported' } },
      ]),
      'corpus/case-a.v1.kojo.txt': V1_SOURCE,
      'corpus/case-a.ledger.json': ledger,
    };
    const corpus = loadMigrationCorpus(memoryIo(files), 'corpus');
    const result = runOne({
      id: 'case-a',
      v1: 'A\nB\nC\n',
      v2: 'A\nB\nC\n',
      migrateOk: false,
      unsupported: [{ line: 1, construct: '`循环 …：` 块' }, { line: 2, construct: '`循环 …：` 块' }],
    });
    const failures = verifyMigrationGoldens(corpus, result);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('迁移台账');
  });
});

/* ============================== 6.5 编码面：CRLF / BOM 的载入 ============================== */

describe('编码面：EOL / BOM 按实物字节复核，剥编码不污染正文', () => {
  it('CRLF 语料：按声明切头注后正文仍是 CRLF（不被 completion 洗成 LF）', () => {
    const files = {
      'corpus/manifest.json': MANIFEST([
        { ...RECORD, headerLines: 1, eol: 'crlf', completion: { stripBanner: false, prependChara: null } },
      ]),
      'corpus/case-a.v1.kojo.txt': '; 头注\r\n角色: 1\r\n\r\n时机 指令 310：\r\n    你好。\r\n',
    };
    const corpus = loadMigrationCorpus(memoryIo(files), 'corpus');
    expect(corpus.problems).toEqual([]);
    expect(corpus.cases[0]?.source).toBe('角色: 1\r\n\r\n时机 指令 310：\r\n    你好。\r\n');
    expect(corpus.cases[0]?.source.includes('\r\n')).toBe(true);
    expect(corpus.cases[0]?.source.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('CRLF + prependChara：补的 `角色:` 行也用 CRLF（不混档）', () => {
    const files = {
      'corpus/manifest.json': MANIFEST([
        { ...RECORD, headerLines: 1, eol: 'crlf', completion: { stripBanner: false, prependChara: '12' } },
      ]),
      'corpus/case-a.v1.kojo.txt': '; 头注\r\n时机 指令 310：\r\n    你好。\r\n',
    };
    const corpus = loadMigrationCorpus(memoryIo(files), 'corpus');
    expect(corpus.problems).toEqual([]);
    expect(corpus.cases[0]?.source.startsWith('角色: 12\r\n')).toBe(true);
  });

  it('BOM 语料：声明 utf-8 时剥掉 U+FEFF 再进编译（不混进首行）', () => {
    const files = {
      'corpus/manifest.json': MANIFEST([{ ...RECORD, headerLines: 0, bom: 'utf-8' }]),
      'corpus/case-a.v1.kojo.txt': '\uFEFF角色: 1\n\n时机 指令 310：\n    你好。\n',
    };
    const corpus = loadMigrationCorpus(memoryIo(files), 'corpus');
    expect(corpus.problems).toEqual([]);
    expect(corpus.cases[0]?.source.startsWith('角色: 1')).toBe(true);
    expect(corpus.cases[0]?.source.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('声明与实物不符 → problems（EOL / BOM 各一条，不猜）', () => {
    const eolMismatch = loadMigrationCorpus(
      memoryIo({
        'corpus/manifest.json': MANIFEST([{ ...RECORD, headerLines: 0, eol: 'crlf' }]),
        'corpus/case-a.v1.kojo.txt': '角色: 1\n时机 指令 310：\n',
      }),
      'corpus',
    );
    expect(eolMismatch.problems[0]?.message).toContain('EOL 声明是 crlf');
    expect(eolMismatch.cases).toEqual([]);

    const bomMismatch = loadMigrationCorpus(
      memoryIo({
        'corpus/manifest.json': MANIFEST([{ ...RECORD, headerLines: 0, bom: 'none' }]),
        'corpus/case-a.v1.kojo.txt': '\uFEFF角色: 1\n',
      }),
      'corpus',
    );
    expect(bomMismatch.problems[0]?.message).toContain('BOM 声明是 none');
  });
});

/* ============================== 6.6 真实目录 manifest 骨架 ============================== */

/** 带写盘的内存 IO（`writeText` 落进 files 并记录调用） */
function writableIo(files: Record<string, string>): {
  readonly io: MigrationCorpusIo;
  readonly writes: { readonly path: string; readonly text: string }[];
} {
  const writes: { path: string; text: string }[] = [];
  const io: MigrationCorpusIo = {
    readText: (target: string) => {
      const key = target.replaceAll('\\', '/').replace(/^\.\//, '');
      const text = files[key];
      if (text === undefined) throw new Error(`ENOENT ${key}`);
      return text;
    },
    listFiles: (dir: string) => {
      const prefix = `${dir.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
    },
    writeText: (target: string, text: string) => {
      writes.push({ path: target, text });
      files[target.replaceAll('\\', '/')] = text;
    },
  };
  return { io, writes };
}

/** 生成骨架用的最小 CLI 依赖（本组只测 argv/IO，编译替身恒定） */
const plainDeps = (files: Record<string, string>) => ({
  io: memoryIo(files),
  compileV1: () => out(BASE_V1),
  compile2: () => out(BASE_V1),
  migrate: () => ({ ok: true, code: '# 机 指令 310\n', unsupported: [] }),
});

const GENERATED_FILES = (): Record<string, string> => ({
  'real/alpha.v1.kojo.txt': '角色: 12\n时机 指令 310：\n    她点了点头。\n',
  'real/alpha.v1.erb': 'OLD\n',
  'real/alpha.2.erb': 'OLD2\n',
  'real/beta.v1.kojo.txt': '\uFEFF角色: 12\r\n时机 指令 310：\r\n    她叹了口气。\r\n',
  'real/nested/gamma.v1.kojo.txt': '角色: 12\n',
});

describe('--generate-manifest：真实目录 → 初版骨架（不猜状态、编码面按字节）', () => {
  it('列出候选、探测 EOL/BOM/tier/constructs，expected 留 null（首跑后再填）', () => {
    const skeleton = generateMigrationManifest(memoryIo(GENERATED_FILES()), 'real');
    expect(skeleton.problems).toEqual([]);
    expect(skeleton.caseIds).toEqual(['alpha', 'beta']);
    expect(skeleton.manifest.schema).toBe('kojo-migration-corpus/1');
    const alpha = skeleton.manifest.cases.find((entry) => entry.id === 'alpha')!;
    expect(alpha.eol).toBe('lf');
    expect(alpha.bom).toBe('none');
    expect(alpha.tier).toBe('dual-golden');
    expect(alpha.expected).toBeNull();
    expect(alpha.headerLines).toBe(0);
    expect(alpha.constructs).toEqual(['叙事行', '文件头声明', '时机块']);
    const beta = skeleton.manifest.cases.find((entry) => entry.id === 'beta')!;
    expect(beta.eol).toBe('crlf');
    expect(beta.bom).toBe('utf-8');
    expect(beta.tier).toBe('baseline+ledger');
    // 子目录候选不猜成 case（loader 只认扁平目录），但要如实记账
    expect(skeleton.manifest.notes).toContain('跳过 1 份子目录候选');
  });

  it('stdout 就是可落盘的 manifest.json；JSON.parse 形状合法（expected null 也收）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'real', '--generate-manifest'], {
      io: memoryIo(GENERATED_FILES()),
      compileV1: () => out(BASE_V1),
      compile2: () => out(BASE_V1),
      migrate: () => ({ ok: true, code: '# 机 指令 310\n', unsupported: [] }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.manifest?.cases).toBe(2);
    expect(result.text.trimStart().startsWith('{')).toBe(true);
    const parsed = JSON.parse(result.text) as { cases: { id: string }[] };
    expect(parsed.cases.map((entry) => entry.id)).toEqual(['alpha', 'beta']);
    // 默认不写盘
    const after = memoryIo(GENERATED_FILES());
    expect(() => after.readText('real/manifest.json')).toThrow('ENOENT');
  });

  it('生成的骨架能被 loader 直接载入（expected=null → 只报告不判定）', () => {
    const files = GENERATED_FILES();
    const skeleton = generateMigrationManifest(memoryIo(files), 'real');
    files['real/manifest.json'] = skeleton.text;
    const corpus = loadMigrationCorpus(memoryIo(files), 'real');
    expect(corpus.problems).toEqual([]);
    expect(corpus.records.map((record) => record.id)).toEqual(['alpha', 'beta']);
    const result = runMigrationDifferential({
      cases: corpus.cases,
      compileV1: () => out(BASE_V1),
      compile2: () => out(BASE_V1),
      migrate: () => ({ ok: true, code: '# 机 指令 310\n', unsupported: [] }),
    });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('--out 走注入写盘，stdout 改成人话回执（内容与文件逐字节同文）', () => {
    const { io, writes } = writableIo(GENERATED_FILES());
    const result = runMigrationCli(['migrate-diff', '--dir', 'real', '--generate-manifest', '--out', 'real/manifest.json'], {
      io,
      compileV1: () => out(BASE_V1),
      compile2: () => out(BASE_V1),
      migrate: () => ({ ok: true, code: '# 机 指令 310\n', unsupported: [] }),
    });
    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('real/manifest.json');
    expect(writes[0]?.text).toBe(result.report.manifest?.text);
    expect(result.text).toContain('已写入清单骨架 real/manifest.json');
    expect(result.text).not.toContain('"cases"');
  });

  it('--out 不带 --generate-manifest → exit 2（子命令边界不混）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'real', '--out', 'x.json'], plainDeps({}));
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('--out 只能与 --generate-manifest');
  });

  it('--generate-manifest 缺 --dir → exit 2，用法里给出完整命令', () => {
    const result = runMigrationCli(['migrate-diff', '--generate-manifest'], plainDeps({}));
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('--generate-manifest 需要 --dir');
    expect(result.report.usage).toContain('node tools/kojo-conformance.mjs migrate-diff --generate-manifest');
  });

  it('目录里没有候选 → exit 1（空骨架不是"全绿"）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'real', '--generate-manifest'], {
      io: memoryIo({ 'real/readme.txt': 'x' }),
      compileV1: () => out(BASE_V1),
      compile2: () => out(BASE_V1),
      migrate: () => ({ ok: true, code: '# 机 指令 310\n', unsupported: [] }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.message).toContain('没有 <id>.v1.kojo.txt');
    // 失败时不能只打一份空骨架：原因与下一步命令都要上屏
    expect(result.text).toContain('清单骨架生成失败');
    expect(result.text).toContain('--generate-manifest --dir');
  });
});

/* ============================== 7. CLI：用法 / 退出码 / 报告 ============================== */

describe('migrate-diff CLI：用法、退出码、JSON 稳定', () => {
  const deps = (files: Record<string, string>) => ({
    io: memoryIo(files),
    compileV1: () => out(BASE_V1),
    compile2: () => out(BASE_V1),
    migrate: () => ({ ok: true, code: '# 机 指令 310\n', unsupported: [] }),
  });

  const corpusFiles = (expected: MigrationCase['expect']): Record<string, string> => ({
    'corpus/manifest.json': MANIFEST([{ ...RECORD, expected }]),
    'corpus/case-a.v1.kojo.txt': V1_SOURCE,
    'corpus/case-a.v1.erb': BASE_V1,
    'corpus/case-a.2.erb': BASE_V1,
  });

  it('help → exit 0 + usage 文本（--json 不生效）', () => {
    const result = runMigrationCli(['help'], deps({}));
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('migrate-diff');
    expect(result.report.usage).toContain('退出码');
    expect(formatMigrationReport(result.report, { json: true })).toBe(`${MIGRATION_CLI_USAGE}\n`);
  });

  it('缺 --dir → exit 2 + usage（把人话写在 usage 尾部）', () => {
    const result = runMigrationCli(['migrate-diff'], deps({}));
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('需要 --dir');
  });

  it('缺 manifest.json → exit 1，失败清单直接给 --generate-manifest 的下一步命令', () => {
    const result = runMigrationCli(
      ['migrate-diff', '--dir', 'corpus'],
      plainDeps({ 'corpus/case-a.v1.kojo.txt': V1_SOURCE }),
    );
    expect(result.exitCode).toBe(1);
    const hint = result.report.failures.find((item) => item.message.includes('--generate-manifest'));
    expect(hint).toBeDefined();
    expect(hint?.message).toContain('migrate-diff --generate-manifest --dir corpus');
  });

  it('未知参数 → exit 2（不猜）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'corpus', '--wat'], deps(corpusFiles({ status: 'identical', blockedReason: null })));
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('未知参数：--wat');
  });

  it('全部与期望一致 + golden 命中 → exit 0，人话给状态分布与迁移率', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'corpus'], deps(corpusFiles({ status: 'identical', blockedReason: null })));
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('RESULT: PASS');
    expect(result.text).toContain('迁移率');
    expect(result.report.summary.identical).toBe(1);
    expect(result.report.cases[0]?.expected?.status).toBe('identical');
  });

  it('状态不符 → exit 1，失败清单带 kind=expectation', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'corpus'], deps(corpusFiles({ status: 'differs', blockedReason: null })));
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.kind).toBe('expectation');
    expect(result.text).toContain('RESULT: FAIL');
  });

  it('--no-golden 跳过 golden 复核，但状态门仍生效', () => {
    const files = { ...corpusFiles({ status: 'identical', blockedReason: null }), 'corpus/case-a.2.erb': 'STALE\n' };
    const withGolden = runMigrationCli(['migrate-diff', '--dir', 'corpus'], deps(files));
    expect(withGolden.exitCode).toBe(1);
    const withoutGolden = runMigrationCli(['migrate-diff', '--dir', 'corpus', '--no-golden'], deps(files));
    expect(withoutGolden.exitCode).toBe(0);
  });

  it('JSON：字段序固定、两次输出逐字节相同、可被 JSON.parse', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', 'corpus', '--json'], deps(corpusFiles({ status: 'identical', blockedReason: null })));
    const first = formatMigrationReport(result.report, { json: true });
    const second = formatMigrationReport(result.report, { json: true });
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['dir', 'summary', 'migrationReport', 'cases', 'failures', 'usage', 'manifest']);
    const cases = parsed['cases'] as unknown[];
    expect((cases[0] as Record<string, unknown>)['id']).toBe('case-a');
    expect(first.endsWith('\n')).toBe(true);
  });
});

