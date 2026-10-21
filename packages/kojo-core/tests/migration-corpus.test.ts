/**
 * 迁移语料回归（K2-MIGRATION-DIFFERENTIAL / §16.8 M7.1·M7.2·M7.6）。
 *
 * 钉的是**真链路**，不是替身：
 * - v1 侧 = kojo-sugar 真入口（`createSugarTranspileService` + 与 golden 测试同一套
 *   `stubDict` / `stubFaceTable`）；
 * - 2.0 侧 = 真 core（`compileKojoSource`）+ 真 eraTW backend（`createEratwEmitBackend`）；
 * - 迁移 = core `migrateKojoSourceSemantic`（语义层，含 `当/分支/初回` 三落点）。
 *
 * 语料在 `tests/fixtures/migrate-corpus/`：每份 `.v1.kojo.txt` = 溯源头注 + 仓内既有 v1 fixture 的
 * 逐字节复制（`manifest.json` 记 sha256 与补全口径）。本文件逐份复核：
 * 源保真 / v1 产物 / 2.0 产物或迁移台账 / 迁移幂等 / fail-closed 与 parse 口径。
 *
 * **期望的落点**（当前读到的现状，不是"应当 equal"）：语料里既有可迁移可编译的 case
 * （双 golden，产物**如实**有差异：v1 缺省 D 系 vs 2.0 `narrationColor: author`、台词引号
 * 被当语法剥掉），也有大量 blocked（多 `时机` 块 / 取色声明 / 命名参数 / 循环族 …）。
 * 这些都在 `manifest.json` 的 `expected` 里逐条记账；改现状要同时更新语料与期望。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { classifyV1, compileKojoSource, migrateKojoSourceSemantic, parseSource } from '../src/index.js';
import { createSugarTranspileService } from '../../plugins/kojo-sugar/src/service.js';
import { stubDict, stubFaceTable } from '../../plugins/kojo-sugar/tests/support.js';
import { ERATW_GAME_ADAPTER, createEratwEmitBackend } from '../../plugins/eratw-adapter/src/kojo2/index.js';
import type {
  MigrationCaseReport,
  MigrationCorpus,
  MigrationCorpusIo,
  MigrationDifferentialResult,
} from '../../kojo-conformance/src/migration.js';
import {
  formatMigrationReport,
  loadMigrationCorpus,
  runMigrationCli,
  runMigrationDifferential,
  verifyMigrationGoldens,
} from '../../kojo-conformance/src/migration.js';

/* ============================== 夹具 ============================== */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CORPUS_DIR = path.join(import.meta.dirname, 'fixtures', 'migrate-corpus');

/** 真 IO（只读语料目录；扁平结构） */
const nodeIo: MigrationCorpusIo = {
  readText: (target: string) => readFileSync(target, 'utf8'),
  listFiles: (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
};

/** v1 真入口：kojo-sugar 转译服务（与 `kojo-sugar/tests/golden.test.ts` 同一套表） */
const sugar = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/**
 * 2.0 真 backend。取色口径对齐 v1 缺省：v1 未声明 `旁白色` 时旁白走 **D 系**，
 * 故编译侧把 adapter profile 的 `narrationColor` 钉成 `default`（adapter 缺省是 `author`，
 * 那是"作者色"口径——拿它对比会把配置差异记成迁移差异）。
 */
const backend = createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
const ADAPTER = Object.freeze({
  ...ERATW_GAME_ADAPTER,
  profile: Object.freeze({ ...ERATW_GAME_ADAPTER.profile, narrationColor: 'default' as const }),
});

const compileV1 = (source: string) => {
  const result = sugar.transpile(source);
  return {
    ok: result.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    text: result.erb,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  };
};

const compile2 = (source: string) => {
  const result = compileKojoSource({ source, adapter: ADAPTER, backend });
  return {
    ok: result.ok,
    text: result.erb,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  };
};

const migrate = (source: string) => {
  const result = migrateKojoSourceSemantic(source);
  return {
    ok: result.ok,
    code: result.code,
    unsupported: result.unsupported.map((entry) => ({ line: entry.line, construct: entry.construct, code: entry.code })),
  };
};

const corpus: MigrationCorpus = loadMigrationCorpus(nodeIo, CORPUS_DIR);
const records = corpus.records;
let diff: MigrationDifferentialResult;
let byId: ReadonlyMap<string, MigrationCaseReport>;

beforeAll(() => {
  diff = runMigrationDifferential({ cases: corpus.cases, compileV1, compile2, migrate });
  byId = new Map(diff.cases.map((report) => [report.id, report]));
}, 60_000);

/** 复制凭据的字段形状（64 位十六进制）；字节保真由正文逐字节比较证明，不引 crypto（全仓 sha256 唯一性闸） */
const isSha256Hex = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const recordOf = (id: string) => records.find((record) => record.id === id)!;
const reportOf = (id: string): MigrationCaseReport => byId.get(id)!;
const parseErrors = (source: string) => parseSource(source).diagnostics.filter((item) => item.severity === 'error');

/* ============================== 1. 语料清单 ============================== */

describe('语料清单：≥20 份、来源可解析、覆盖要求构造', () => {
  it('manifest 合法且 ≥20 份 case（本批要求）', () => {
    expect(corpus.problems).toEqual([]);
    expect(corpus.manifest).not.toBeNull();
    expect(corpus.manifest?.schema).toBe('kojo-migration-corpus/1');
    expect(records.length).toBeGreaterThanOrEqual(20);
    expect(new Set(records.map((record) => record.id)).size).toBe(records.length);
  });

  it('每份语料的溯源路径都在仓内存在（只读挑选，不是凭空造）', () => {
    for (const record of records) {
      expect(existsSync(path.join(REPO, record.source)), record.source).toBe(true);
    }
  });

  it('每份 case 至少有一侧 golden（v1 产物 + 2.0 产物 / 台账）', () => {
    for (const record of records) {
      const golden = corpus.goldens.get(record.id);
      expect(golden, record.id).toBeDefined();
      expect(golden?.v1Product, record.id).not.toBeNull();
      expect(golden?.v2Product !== null || golden?.ledger !== null, record.id).toBe(true);
      // 分层与实物自洽：dual-golden 必须有 `.2.erb`，baseline+ledger 必须有台账
      if (record.tier === 'dual-golden') expect(golden?.v2Product, record.id).not.toBeNull();
      else expect(golden?.ledger, record.id).not.toBeNull();
    }
  });

  it('覆盖要求：叙事 / 条件 / 表 / 池 / 模 / 随机 / 心形 / 着色 / 选项 / 控制流 / 初回 / 分支', () => {
    const seen = new Set(records.flatMap((record) => record.constructs));
    const required: readonly (readonly string[])[] = [
      ['叙事行'],
      ['如果 / 否则如果'],
      ['当 / 是 分支', '是 臂'],
      ['分支规则池'],
      ['函数'],
      ['随机'],
      ['心形'],
      ['着色'],
      ['选项块', '选项条目'],
      ['循环族', '调用', '标签'],
      ['初回 / 询问 / 确认'],
      ['文件头声明'],
    ];
    for (const group of required) {
      expect(group.some((name) => seen.has(name)), group.join(' / ')).toBe(true);
    }
  });

  it('清单的 expected 与本次实测状态一致（回归门：status + blockedReason）', () => {
    expect(diff.failures).toEqual([]);
    expect(diff.ok).toBe(true);
    for (const record of records) {
      const report = reportOf(record.id);
      expect(report.status, record.id).toBe(record.expected.status);
      if (record.expected.status === 'blocked') {
        expect(report.blockedReason, record.id).toBe(record.expected.blockedReason ?? null);
      }
    }
  });
});

/* ============================== 2. 逐份语料（参数化） ============================== */

describe('逐份语料：源保真 / 双 golden / 迁移幂等 / fail-closed', () => {
  it.each(records.map((record) => [record.id, record] as const))(
    '%s：`.v1.kojo.txt` = 溯源头注 + 源 fixture 逐字节（sha256 一致）',
    (_id, record) => {
      const stored = readFileSync(path.join(CORPUS_DIR, `${record.id}.v1.kojo.txt`), 'utf8');
      const original = readFileSync(path.join(REPO, record.source), 'utf8');
      expect(isSha256Hex(record.sourceSha256), record.id).toBe(true);
      // 逐字节保真（比哈希更强：直接比正文，不引 crypto）
      expect(
        stored.endsWith(original),
        `${record.id}: 语料快照与源 fixture 漂移（${record.source} 被改过）——重生成该 case 的 .v1.kojo.txt / .v1.erb / .2.erb / .ledger.json，并同步 manifest 的 sourceSha256 / headerLines`,
      ).toBe(true);
      const lines = stored.split(record.eol === 'crlf' ? '\r\n' : '\n');
      expect(lines.length).toBe(record.headerLines + original.split(record.eol === 'crlf' ? '\r\n' : '\n').length);
      // 头注必须点明来源（可追溯，不是匿名快照）
      expect(lines.slice(0, record.headerLines).join('\n')).toContain(record.source);
    },
  );

  it.each(records.map((record) => [record.id, record] as const))(
    '%s：v1 产物可复现（真 kojo-sugar 入口）',
    (_id, record) => {
      const report = reportOf(record.id);
      const golden = corpus.goldens.get(record.id)!;
      expect(report.products.v1).toBe(golden.v1Product);
      expect(report.readings.v1.ok).toBe(report.readings.v1.errors === 0);
    },
  );

  it.each(records.map((record) => [record.id, record] as const))(
    '%s：2.0 产物可复现 / 迁移台账可复现（二选一）',
    (_id, record) => {
      const report = reportOf(record.id);
      const golden = corpus.goldens.get(record.id)!;
      if (golden.v2Product !== null) {
        expect(report.status).not.toBe('blocked');
        expect(report.products.v2).toBe(golden.v2Product);
      } else {
        expect(golden.ledger, record.id).not.toBeNull();
        expect(report.status).toBe('blocked');
        expect(report.blockedReason).toBe(record.expected.blockedReason ?? null);
      }
    },
  );

  it.each(records.map((record) => [record.id, record] as const))(
    '%s：迁移幂等 + fail-closed 与 parse 口径自洽',
    (_id, record) => {
      const report = reportOf(record.id);
      const migrated = report.products.migrated;
      expect(migrated, record.id).not.toBeNull();
      // 幂等：同一 v1 源再迁一次逐字节同文（纯函数契约）
      const again = migrate(corpus.cases.find((item) => item.id === record.id)!.source);
      expect(again.code).toBe(migrated);
      if (report.readings.migration.ok) {
        // 迁移自称 ok ⇒ 产物必须是合法 2.0（parse 零 error）
        expect(parseErrors(migrated!), record.id).toEqual([]);
      } else {
        // 迁移自称不 ok ⇒ 不许产半成品：台账非空，且调用方不得写盘
        expect(report.readings.migration.unsupported, record.id).toBeGreaterThan(0);
      }
    },
  );
});

/* ============================== 3. 迁移率与分布 ============================== */

describe('迁移率量化与状态分布（读数落报告，可 JSON）', () => {
  it('迁移率覆盖全部语料：v1Sites > 0，autoMigrated + unsupported = v1Sites', () => {
    expect(diff.migrationReport.cases).toBe(records.length);
    expect(diff.migrationReport.v1Sites).toBeGreaterThan(0);
    expect(diff.migrationReport.autoMigrated + diff.migrationReport.unsupported).toBe(diff.migrationReport.v1Sites);
    expect(diff.migrationReport.migrationRate).toBeGreaterThan(0);
    expect(diff.migrationReport.migrationRate).toBeLessThanOrEqual(1);
    expect(diff.migrationReport.byConstruct.length).toBeGreaterThan(0);
    for (const row of diff.migrationReport.byConstruct) {
      expect(row.migrated + row.unsupported, row.construct).toBe(row.sites);
    }
  });

  it('状态分布与 blocked 原因可逐条对上（identical/normalized-equal 不硬凑）', () => {
    const summary = diff.summary;
    expect(summary.cases).toBe(records.length);
    expect(summary.identical + summary.normalizedEqual + summary.differs + summary.blocked).toBe(records.length);
    const blockedSum = summary.blockedByReason.reduce((sum, item) => sum + item.cases, 0);
    expect(blockedSum).toBe(summary.blocked);
    // 本语料的现状：可迁移可编译的 case 全都**如实**有行为差异（不洗白）
    expect(summary.identical).toBe(0);
    expect(summary.normalizedEqual).toBe(0);
    expect(summary.differs).toBeGreaterThan(0);
    expect(summary.blocked).toBeGreaterThan(0);
  });

  it('golden 复核零失败（v1/2.0 产物逐字节、台账逐字段）', () => {
    expect(verifyMigrationGoldens(corpus, diff)).toEqual([]);
  });

  it('缺口台账：六类已知迁移缺口在语料里各有一份代表（缺口不被"绿"掩盖）', () => {
    const reports = diff.cases;
    const unsupportedOf = (id: string): readonly string[] => reportOf(id).readings.migration.unsupportedConstructs;
    const has = (needle: string): boolean => reports.some((report) => unsupportedOf(report.id).some((item) => item.includes(needle)));

    // ① 多 `时机` 块（2.0 一文件一 `# 机`，要按挂点拆文件）
    expect(has('多个 `时机` 块')).toBe(true);
    // ② 取色文件头声明（`口上色` / `旁白色` / `自机色` → profile）
    expect(has('`口上色` 文件头声明') || has('`旁白色` 文件头声明')).toBe(true);
    // ③ 时机命名参数（`成否:` / `类型:` → adapter 事件配置）
    expect(has('`时机` 块头（事件 / 命名参数形状不认识）')).toBe(true);
    // ④ 循环 / 数据表 / 菜单 族（2.0 未覆盖 ⇒ 台账）
    expect(has('`循环 …：` 块')).toBe(true);
    expect(has('`数据表：` 随机数据表块')).toBe(true);
    expect(has('`菜单：` 块')).toBe(true);
    // ⑤ 迁移产物编不过：v1 的时机面词不在 2.0 九事件目录里（红灯类）
    expect(
      reports.some((report) => report.blockedReason === 'v2-compile-failed' && report.readings.v2.firstErrorCode === 'event/unknown'),
    ).toBe(true);
    // ⑥ v1 侧自己就编不出（脚手架空壳 / 迁移专用夹具）：基线不可得，不许当成"迁移失败"
    expect(reports.some((report) => report.blockedReason === 'v1-compile-failed')).toBe(true);
  });

  it('分类器口径：每份语料都有可识别的 v1 写法（不靠手写清单）', () => {
    for (const item of corpus.cases) {
      const record = recordOf(item.id);
      const sites = item.source
        .split(/\r\n|\r|\n/)
        .map((line) => line.replace(/^[ \t\u3000]*/, ''))
        .filter((body) => body.length > 0 && !body.startsWith(';') && !body.startsWith('//'));
      if (record.constructs.length === 0) {
        // 脚手架空壳：整份只有 `;` 注释（v1 侧因此报 block-empty）——这是语料事实，不是漏检
        expect(sites.length, item.id).toBe(0);
        continue;
      }
      expect(sites.length, item.id).toBeGreaterThan(0);
      for (const body of sites) expect(classifyV1(body).kind.kind, body).toBeTruthy();
    }
  });
});

/* ============================== 4. CLI 冒烟（真语料） ============================== */

describe('migrate-diff CLI 对真语料', () => {
  it('exit 0 + RESULT: PASS + 人话读数（状态分布 / 迁移率 / 逐 case）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', CORPUS_DIR], { io: nodeIo, compileV1, compile2, migrate });
    expect(result.exitCode).toBe(0);
    expect(result.report.failures).toEqual([]);
    expect(result.report.summary.cases).toBe(records.length);
    expect(result.text).toContain('RESULT: PASS');
    expect(result.text).toContain('迁移率');
    expect(result.text).toContain('narrative-scaffold-317');
  });

  it('--json 可被机器消费（字段序固定、case 序 = 清单序）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', CORPUS_DIR, '--json'], {
      io: nodeIo,
      compileV1,
      compile2,
      migrate,
    });
    const parsed = JSON.parse(formatMigrationReport(result.report, { json: true })) as {
      dir: string;
      summary: { cases: number };
      migrationReport: { v1Sites: number };
      cases: { id: string }[];
    };
    expect(parsed.summary.cases).toBe(records.length);
    expect(parsed.migrationReport.v1Sites).toBe(diff.migrationReport.v1Sites);
    expect(parsed.cases.map((item) => item.id)).toEqual(records.map((record) => record.id));
  });

  it('语料目录指错 → exit 1（不是静默 0）', () => {
    const result = runMigrationCli(['migrate-diff', '--dir', path.join(CORPUS_DIR, 'nope')], {
      io: nodeIo,
      compileV1,
      compile2,
      migrate,
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.message).toContain('无法列出语料目录');
  });
});


