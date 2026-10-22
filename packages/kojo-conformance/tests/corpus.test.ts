/**
 * 真实语料机单测（K2-CORPUS-REAL）。
 *
 * 钉五件事：
 * 1. **发现**：递归 `.kojo`（排除 `.kojo2`）、码点序稳定、`--limit` 先排序后截断；
 * 2. **状态与原因**：四态聚合、blocked 原因映射（`migration-unsupported` / `v1-compile-failed` /
 *    `2.0-compile-failed` / `migration-error`）、可迁移率口径；
 * 3. **SKIP 语义**：语料不在位 = rc=2 + 「语料不在位」，**不许**变成 0 cases 通过；
 *    目录在位但 0 份 `.kojo` = rc=1（也不是绿）；
 * 4. **抽样 manifest**：≤60、等距稳定、sha256/bytes 真值、`.v1.kojo.txt` 字节保真、meta 字段克制、
 *    落点不越界（注入 IO 端口逐条看写入路径），合成语料 manifest 一字不动；
 * 5. **真语料**：`node tools/corpus.mjs --print` rc=0 才真跑并读现状；rc≠0 ⇒ SKIP 并写明。
 *
 * 假编译器 + 内存 IO：本文件的主体不碰真盘、不碰真 core（真链路那一段只在语料在位时走）。
 * 真 sha256（`node:crypto`）注入，抽样凭据按真字节算。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CorpusCliDeps, CorpusIo, CorpusRootResolution } from '../src/corpus.js';
import {
  CORPUS_CLI_USAGE,
  DEFAULT_SAMPLE_SIZE,
  REAL_CORPUS_DIR,
  REAL_META_SUFFIX,
  REAL_V1_SUFFIX,
  SYNTHETIC_CORPUS_DIR,
  discoverCorpus,
  formatCorpusReport,
  generateCorpusManifest,
  runCorpusCli,
  runCorpusMigration,
  sampleEvenly,
} from '../src/corpus.js';
import type { MigrationCompilerOutput } from '../src/migration.js';

/* ============================== 内存 IO ============================== */

function norm(target: string): string {
  let value = target.replaceAll('\\', '/');
  while (value.startsWith('./')) value = value.slice(2);
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value;
}

class MemoryIo implements CorpusIo {
  private readonly files = new Map<string, string>();
  private readonly roots = new Set<string>();
  readonly writes: { readonly path: string; readonly text: string }[] = [];
  readonly dirs: string[] = [];

  add(target: string, text: string): this {
    const file = norm(target);
    this.files.set(file, text);
    this.roots.add(file.slice(0, file.lastIndexOf('/')) || '/');
    return this;
  }

  addDir(target: string): this {
    this.roots.add(norm(target));
    return this;
  }

  listFiles(dir: string): readonly string[] {
    const root = norm(dir);
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const out: string[] = [];
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) out.push(file.slice(prefix.length));
    }
    if (out.length === 0 && !this.roots.has(root)) throw new Error(`ENOENT: ${dir}`);
    return out;
  }

  readText(target: string): string {
    const text = this.files.get(norm(target));
    if (text === undefined) throw new Error(`ENOENT: ${target}`);
    return text;
  }

  writeText(target: string, text: string): void {
    this.writes.push({ path: norm(target), text });
    this.files.set(norm(target), text);
  }

  mkdir(dir: string): void {
    this.dirs.push(norm(dir));
  }
}

/** 指定路径读失败（模拟权限/坏文件） */
class FlakyIo extends MemoryIo {
  override readText(target: string): string {
    if (norm(target).includes('bad')) throw new Error('EACCES: permission denied');
    return super.readText(target);
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 语料根 `/corpus` + 给定的相对路径文件 */
function corpusIo(files: Record<string, string>): MemoryIo {
  const io = new MemoryIo().addDir('/corpus');
  for (const [rel, text] of Object.entries(files)) io.add(`/corpus/${rel}`, text);
  return io;
}

/* ============================== 假编译链路 ============================== */

const okOut = (text: string): MigrationCompilerOutput => ({ ok: true, text, diagnostics: [] });
const errOut = (code: string): MigrationCompilerOutput => ({
  ok: false,
  text: '',
  diagnostics: [{ code, severity: 'error', message: `${code} boom` }],
});

/** 标记写在**整行注释**里：不影响迁移率口径，也不制造额外行为差异 */
const sourceOf = (marker: string): string => `角色: 1\n${marker.length === 0 ? '' : `; ${marker}\n`}> 你好。\n`;

const compileV1 = (source: string): MigrationCompilerOutput =>
  source.includes('V1FAIL') ? errOut('v1/boom') : okOut(`P:${source}`);

const migrate = (source: string) => {
  if (source.includes('MIGTHROW')) throw new Error('migrate boom');
  if (source.includes('MIGFAIL')) return { ok: false, code: source, unsupported: [{ line: 1, construct: '时机块' }] };
  return { ok: true, code: source, unsupported: [] };
};

const compile2 = (source: string): MigrationCompilerOutput => {
  if (source.includes('V2FAIL')) return errOut('core/boom');
  if (source.includes('DIFF')) return okOut(`P:${source}EXTRA\n`);
  if (source.includes('NORM')) return okOut(`P:${source}; extra comment\n`);
  return okOut(`P:${source}`);
};

function deps(io: CorpusIo, overrides: Partial<CorpusCliDeps> = {}): CorpusCliDeps {
  return {
    io,
    compileV1,
    compile2,
    migrate,
    sha256,
    resolveRoot: (): CorpusRootResolution => ({ ok: true, dir: '/corpus' }),
    realCorpusDir: `/repo/${REAL_CORPUS_DIR}`,
    ...overrides,
  };
}

const run = (argv: readonly string[], io: CorpusIo, overrides: Partial<CorpusCliDeps> = {}) =>
  runCorpusCli(argv, deps(io, overrides));

/* ============================== 1. 发现 ============================== */

describe('发现：递归 .kojo / 稳定排序 / --limit', () => {
  it('递归找 `.kojo`，排除 `.kojo2` 与其他后缀（后缀大小写不敏感）', () => {
    const io = corpusIo({
      'a.kojo': 'x',
      'sub/b.KOJO': 'y',
      'sub/c.kojo2': 'z',
      'd.kojo.txt': 'w',
      'e.erb': 'v',
      'sub/deep/f.kojo': 'u',
    });
    const discovery = discoverCorpus('/corpus', { io });
    expect(discovery.total).toBe(3);
    expect(discovery.selected).toEqual(['a.kojo', 'sub/b.KOJO', 'sub/deep/f.kojo']);
  });

  it('排序与列举顺序无关（路径码点序）', () => {
    const io = corpusIo({ 'z.kojo': '', 'a/b.kojo': '', 'a/a.kojo': '', 'm.kojo': '' });
    expect(discoverCorpus('/corpus', { io }).selected).toEqual(['a/a.kojo', 'a/b.kojo', 'm.kojo', 'z.kojo']);
  });

  it('--limit 先排序后截断：total 保留、truncated 可见', () => {
    const io = corpusIo(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, '0')}.kojo`, 'x'])));
    const discovery = discoverCorpus('/corpus', { io, limit: 5 });
    expect(discovery.total).toBe(12);
    expect(discovery.selected).toEqual(['f00.kojo', 'f01.kojo', 'f02.kojo', 'f03.kojo', 'f04.kojo']);
    expect(discovery.limit).toBe(5);
    expect(discovery.truncated).toBe(true);
  });

  it('limit 大于总数：不截断、truncated=false', () => {
    const io = corpusIo({ 'a.kojo': '', 'b.kojo': '' });
    const discovery = discoverCorpus('/corpus', { io, limit: 20 });
    expect(discovery.selected).toHaveLength(2);
    expect(discovery.truncated).toBe(false);
  });

  it('非法 limit（0 / 负数 / 小数 / NaN）→ RangeError（不静默当不限）', () => {
    const io = corpusIo({ 'a.kojo': '' });
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => discoverCorpus('/corpus', { io, limit }), String(limit)).toThrow(RangeError);
    }
  });

  it('空目录 = 0 份（不抛错；由调用方判"不是绿"）', () => {
    const io = new MemoryIo().addDir('/empty');
    const discovery = discoverCorpus('/empty', { io });
    expect(discovery.total).toBe(0);
    expect(discovery.selected).toEqual([]);
  });

  it('listFiles 抛错 = 语料不在位（向上抛，不吞成空清单）', () => {
    expect(() => discoverCorpus('/absent', { io: new MemoryIo() })).toThrow(/ENOENT/);
  });

  it('重复路径去重（同一文件多条列举只算一份）', () => {
    const io = corpusIo({ 'a.kojo': '' });
    io.add('a.kojo', '');
    expect(discoverCorpus('/corpus', { io }).total).toBe(1);
  });
});

/* ============================== 2. 状态与聚合 ============================== */

describe('状态聚合：四态 + 原因分类 + 可迁移率', () => {
  it('identical / normalized-equal / differs / blocked 各就各位', () => {
    const io = corpusIo({
      'diff.kojo': sourceOf('DIFF'),
      'identical.kojo': sourceOf(''),
      'norm.kojo': sourceOf('NORM'),
      'v1fail.kojo': sourceOf('V1FAIL'),
    });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.summary).toMatchObject({ cases: 4, identical: 1, normalizedEqual: 1, differs: 1, blocked: 1 });
    expect(result.cases.map((item) => item.status)).toEqual(['differs', 'identical', 'normalized-equal', 'blocked']);
    expect(result.cases.find((item) => item.status === 'differs')?.diff.added ?? 0).toBeGreaterThan(0);
  });

  it('blocked 原因映射：迁移 unsupported / v1 编不出 / 2.0 编不出 / 迁移器抛错', () => {
    const io = corpusIo({
      'a-v1.kojo': sourceOf('V1FAIL'),
      'b-mig.kojo': sourceOf('MIGFAIL'),
      'c-v2.kojo': sourceOf('V2FAIL'),
      'd-throw.kojo': sourceOf('MIGTHROW'),
    });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    const reasons = new Map(result.cases.map((item) => [item.id, item.reason]));
    expect(reasons.get('a-v1.kojo')).toBe('v1-compile-failed');
    expect(reasons.get('b-mig.kojo')).toBe('migration-unsupported');
    expect(reasons.get('c-v2.kojo')).toBe('2.0-compile-failed');
    expect(reasons.get('d-throw.kojo')).toBe('migration-error');
    expect(result.summary.blocked).toBe(4);
  });

  it('blockedByReason 按份数降序、同数按原因名升序', () => {
    const io = corpusIo({
      'a.kojo': sourceOf('MIGFAIL'),
      'b.kojo': sourceOf('MIGFAIL'),
      'c.kojo': sourceOf('V1FAIL'),
    });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.summary.blockedByReason).toEqual([
      { reason: 'migration-unsupported', cases: 2 },
      { reason: 'v1-compile-failed', cases: 1 },
    ]);
  });

  it('可迁移率 = migration.ok 份数 / 总数（v1 编不出不影响迁移；2.0 编不出仍算迁移成功）', () => {
    const io = corpusIo({
      'a-ok.kojo': sourceOf(''),
      'b-ok.kojo': sourceOf('DIFF'),
      'c-unsupported.kojo': sourceOf('MIGFAIL'),
      'd-v2fail.kojo': sourceOf('V2FAIL'),
      'e-v1fail.kojo': sourceOf('V1FAIL'),
    });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.rate.total).toBe(5);
    expect(result.rate.migratable).toBe(4);
    expect(result.rate.unmigratable).toBe(1);
    expect(result.rate.rate).toBe(0.8);
    expect(result.rate.unsupportedCases).toBe(1);
    expect(result.rate.byReason).toEqual([
      { reason: '2.0-compile-failed', cases: 1 },
      { reason: 'migration-unsupported', cases: 1 },
      { reason: 'v1-compile-failed', cases: 1 },
    ]);
  });

  it('v1 编不出 + 迁移也失败：主因记 v1-compile-failed，可迁移率仍按迁移口径计 0（两个账本不混）', () => {
    const io = corpusIo({ 'both.kojo': '角色: 1\n; V1FAIL\n; MIGFAIL\n' });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.cases[0]?.reason).toBe('v1-compile-failed');
    expect(result.rate).toMatchObject({ total: 1, migratable: 0, unmigratable: 1, unsupportedCases: 0 });
    expect(result.rate.byReason).toEqual([{ reason: 'v1-compile-failed', cases: 1 }]);
  });

  it('目录在位但 0 份 = ok:false + empty 问题（不是全绿）', () => {
    const io = new MemoryIo().addDir('/corpus');
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.ok).toBe(false);
    expect(result.summary.cases).toBe(0);
    expect(result.rate.rate).toBe(0);
    expect(result.problems[0]?.kind).toBe('empty');
  });

  it('单份读失败：进问题清单、其余照跑、整体 ok:false', () => {
    const io = new FlakyIo().addDir('/corpus').add('/corpus/good.kojo', sourceOf('')).add('/corpus/bad.kojo', sourceOf(''));
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.cases.map((item) => item.id)).toEqual(['good.kojo']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('io');
    expect(result.ok).toBe(false);
  });

  it('逐份身份读数：bytes / sha256 / EOL / BOM 按真字节', () => {
    const text = '\uFEFF角色: 1\r\n> 你好。\r\n';
    const io = corpusIo({ 'bom-crlf.kojo': text });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    const item = result.cases[0];
    expect(item?.bytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(item?.sha256).toBe(sha256(new TextEncoder().encode(text)));
    expect(item?.eol).toBe('crlf');
    expect(item?.bom).toBe(true);
  });

  it('EOL 混用如实报 mixed', () => {
    const io = corpusIo({ 'mixed.kojo': '角色: 1\r\n> 甲\n' });
    const result = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(result.cases[0]?.eol).toBe('mixed');
  });

  it('json 口径不带产物全文；默认带（便于人复核）', () => {
    const io = corpusIo({ 'a.kojo': sourceOf('') });
    const withProducts = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate });
    expect(withProducts.cases[0]?.products).toBeDefined();
    const without = runCorpusMigration({ root: '/corpus', io, sha256, compileV1, compile2, migrate, json: true });
    expect(without.cases[0]?.products).toBeUndefined();
  });

  it('files 显式清单：按给定顺序跑、不再扫目录', () => {
    const io = corpusIo({ 'a.kojo': sourceOf(''), 'b.kojo': sourceOf(''), 'c.kojo': sourceOf('') });
    const result = runCorpusMigration({
      root: '/corpus',
      files: ['c.kojo', 'a.kojo'],
      io,
      sha256,
      compileV1,
      compile2,
      migrate,
      json: true,
    });
    expect(result.cases.map((item) => item.id)).toEqual(['c.kojo', 'a.kojo']);
    expect(result.summary.cases).toBe(2);
  });
});

/* ============================== 3. CLI 与 SKIP ============================== */

describe('CLI：SKIP / 用法 / 退出码', () => {
  it('语料不在位（解析链 rc≠0）→ rc=2 + 明确「语料不在位」+ verdict=skip', () => {
    const io = new MemoryIo();
    const result = run(['corpus'], io, {
      resolveRoot: () => ({ ok: false, dir: null, reason: 'node tools/corpus.mjs --print rc=1：盘上未发现语料' }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.report.verdict).toBe('skip');
    expect(result.text).toContain('语料不在位');
    expect(result.text).toContain('不是绿');
    expect(io.writes).toHaveLength(0);
  });

  it('SKIP 也可 JSON（机器消费），问题里带解析链原因', () => {
    const result = run(['corpus', '--json'], new MemoryIo(), {
      resolveRoot: () => ({ ok: false, dir: null, reason: 'rc=2：KOJO_CORPUS_DIR 指向坏路径' }),
    });
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.text) as { verdict: string; problems: { message: string }[] };
    expect(parsed.verdict).toBe('skip');
    expect(parsed.problems[0]?.message).toContain('KOJO_CORPUS_DIR');
  });

  it('显式 --dir 指了不存在的目录 → rc=2（语料不在位，不静默 0 份）', () => {
    const result = run(['corpus', '--dir', '/missing'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.verdict).toBe('skip');
    expect(result.text).toContain('语料不在位');
  });

  it('非法 --limit → rc=2 用法错误', () => {
    const result = run(['corpus', '--dir', '/corpus', '--limit', '0'], corpusIo({ 'a.kojo': '' }));
    expect(result.exitCode).toBe(2);
    expect(result.text).toContain('--limit 必须是正整数');
  });

  it('未知参数 → rc=2 用法错误（不猜）', () => {
    const result = run(['corpus', '--bogus'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.text).toContain('未知参数');
  });

  it('help → rc=0 且打印用法', () => {
    const result = run(['corpus', 'help'], new MemoryIo());
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe(`${CORPUS_CLI_USAGE}\n`);
  });

  it('正常跑：rc=0、人话报告含状态与可迁移率', () => {
    const io = corpusIo({ 'a.kojo': sourceOf(''), 'b.kojo': sourceOf('MIGFAIL') });
    const result = run(['corpus'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.verdict).toBe('ok');
    expect(result.text).toContain('RESULT: OK');
    expect(result.text).toContain('可迁移 1/2（50.0%）');
    expect(result.text).toContain('migration-unsupported 1');
  });

  it('--json：顶层字段序固定、case 序 = 路径序', () => {
    const io = corpusIo({ 'b.kojo': sourceOf(''), 'a.kojo': sourceOf('DIFF') });
    const result = run(['corpus', '--json'], io);
    const parsed = JSON.parse(result.text) as Record<string, unknown> & { cases: { id: string; products?: unknown }[] };
    expect(Object.keys(parsed)).toEqual(['verdict', 'dir', 'discovery', 'summary', 'rate', 'cases', 'problems', 'manifest', 'usage']);
    expect(parsed.cases.map((item) => item.id)).toEqual(['a.kojo', 'b.kojo']);
    expect(parsed.cases[0]?.products).toBeUndefined();
  });

  it('--limit 生效（发现截断 + 只跑截断后的份数）', () => {
    const io = corpusIo(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.kojo`, sourceOf('')])));
    const result = run(['corpus', '--limit', '2', '--json'], io);
    const parsed = JSON.parse(result.text) as { discovery: { total: number; selected: string[]; truncated: boolean }; summary: { cases: number } };
    expect(parsed.discovery.total).toBe(5);
    expect(parsed.discovery.selected).toHaveLength(2);
    expect(parsed.discovery.truncated).toBe(true);
    expect(parsed.summary.cases).toBe(2);
  });

  it('目录在位但 0 份 → rc=1（不把"没有可迁移对象"当绿）', () => {
    const result = run(['corpus'], new MemoryIo().addDir('/corpus'));
    expect(result.exitCode).toBe(1);
    expect(result.report.verdict).toBe('fail');
    expect(result.text).toContain('RESULT: FAIL');
  });
});

/* ============================== 4. 抽样 manifest ============================== */

describe('--generate-manifest：稳定抽样 / 字节保真 / 不越界', () => {
  const OUT = `/repo/${REAL_CORPUS_DIR}`;

  function generate(io: MemoryIo, extra: { limit?: number | null; outDir?: string } = {}) {
    return generateCorpusManifest('/corpus', {
      io,
      sha256,
      outDir: extra.outDir ?? OUT,
      ...(extra.limit === undefined ? {} : { limit: extra.limit }),
    });
  }

  function manyFiles(count: number): MemoryIo {
    const io = new MemoryIo().addDir('/corpus');
    for (let i = 0; i < count; i++) {
      io.add(`/corpus/dir${String(Math.floor(i / 10)).padStart(2, '0')}/f${String(i).padStart(3, '0')}.kojo`, `角色: 1\n> 第 ${i} 份。\n`);
    }
    return io;
  }

  it('抽样 ≤60：120 份 → 60 份，按路径序等距（可复现）', () => {
    const io = manyFiles(120);
    const discovery = discoverCorpus('/corpus', { io });
    const sampled = sampleEvenly(discovery.selected);
    expect(sampled).toHaveLength(DEFAULT_SAMPLE_SIZE);
    expect(sampled).toEqual(discovery.selected.filter((_, index) => index % 2 === 0));
    expect(new Set(sampled).size).toBe(sampled.length);
  });

  it('sampleEvenly：不足上限原样返回；非法上限抛错', () => {
    expect(sampleEvenly(['a', 'b'], 60)).toEqual(['a', 'b']);
    expect(() => sampleEvenly(['a'], 0)).toThrow(RangeError);
    expect(() => sampleEvenly(['a'], 1.5)).toThrow(RangeError);
  });

  it('每份落 `.v1.kojo.txt`（源文本逐字节）+ `.meta.json`（id/source/bytes/sha256）', () => {
    const io = corpusIo({ '作者/口上/a.kojo': '\uFEFF角色: 1\r\n> 你好。\r\n' });
    const generation = generate(io);
    expect(generation.problems).toHaveLength(0);
    expect(generation.sampled).toHaveLength(1);
    const entry = generation.sampled[0]!;
    expect(entry.source).toBe('作者/口上/a.kojo');
    expect(entry.bytes).toBe(new TextEncoder().encode(entry.v1Text).byteLength);
    expect(entry.sha256).toBe(sha256(new TextEncoder().encode(entry.v1Text)));
    expect(entry.v1Text).toBe('\uFEFF角色: 1\r\n> 你好。\r\n');

    const writes = new Map(io.writes.map((item) => [item.path, item.text]));
    expect(writes.get(`${OUT}/${entry.file}`)).toBe(entry.v1Text);
    const meta = JSON.parse(writes.get(`${OUT}/${entry.meta}`) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual(['id', 'source', 'bytes', 'sha256']);
    expect(meta['id']).toBe(entry.id);
    expect(meta['source']).toBe('作者/口上/a.kojo');
    expect(meta['bytes']).toBe(entry.bytes);
    expect(meta['sha256']).toBe(entry.sha256);
  });

  it('sha256 是**真值**（与 node:crypto 对同一字节算的一致）', () => {
    const text = '角色: 1\n> 校验。\n';
    const io = corpusIo({ 'sha.kojo': text });
    const generation = generate(io);
    const expected = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(generation.sampled[0]?.sha256).toBe(expected);
  });

  it('manifest.json：schema / 条数 / 每份 file+meta 与抽样一致', () => {
    const io = manyFiles(75);
    const generation = generate(io);
    const manifest = JSON.parse(generation.manifestText) as {
      schema: string;
      cases: { id: string; source: string; bytes: number; sha256: string; file: string; meta: string }[];
    };
    expect(manifest.schema).toBe('kojo-migration-corpus-real/1');
    expect(manifest.cases).toHaveLength(DEFAULT_SAMPLE_SIZE);
    expect(manifest.cases.map((item) => item.id)).toEqual(generation.sampled.map((item) => item.id));
    for (const item of manifest.cases) {
      expect(item.file).toBe(`${item.id}${REAL_V1_SUFFIX}`);
      expect(item.meta).toBe(`${item.id}${REAL_META_SUFFIX}`);
    }
    expect(generation.files.at(-1)).toBe(`${OUT}/manifest.json`);
    expect(generation.files).toHaveLength(DEFAULT_SAMPLE_SIZE * 2 + 1);
  });

  it('同一语料重跑：写出内容逐字节相同（稳定抽样，不是随机）', () => {
    const first = generate(manyFiles(80));
    const second = generate(manyFiles(80));
    expect(second.manifestText).toBe(first.manifestText);
    expect(second.sampled.map((item) => [item.id, item.sha256])).toEqual(first.sampled.map((item) => [item.id, item.sha256]));
  });

  it('所有写入都在声明落点之下（不越界写盘）', () => {
    const io = manyFiles(3);
    const generation = generate(io);
    expect(generation.files.length).toBeGreaterThan(0);
    for (const write of io.writes) {
      expect(write.path.startsWith(`${OUT}/`), write.path).toBe(true);
      expect(write.path.includes('/../')).toBe(false);
    }
    expect(io.dirs).toEqual([OUT]);
  });

  it('拒绝写合成语料目录 / 含 `..` 的落点（前缀陷阱不算）', () => {
    const io = manyFiles(1);
    expect(() => generate(io, { outDir: `/repo/${SYNTHETIC_CORPUS_DIR}` })).toThrow(/合成语料目录/);
    expect(() => generate(io, { outDir: `/repo/${SYNTHETIC_CORPUS_DIR}/nested` })).toThrow(/合成语料目录/);
    expect(() => generate(io, { outDir: '/tmp/../evil' })).toThrow(/'\.\.'/);
  });

  it('合成语料 manifest 一字不动（生成器只认真实抽样落点）', () => {
    const io = manyFiles(2);
    const syntheticPath = `/repo/${SYNTHETIC_CORPUS_DIR}/manifest.json`;
    io.add(syntheticPath, '{"synthetic":true}\n');
    generate(io);
    expect(io.writes.some((item) => item.path === syntheticPath)).toBe(false);
    expect(io.readText(syntheticPath)).toBe('{"synthetic":true}\n');
  });

  it('--limit 与抽样交互：limit 5 → 抽样 ≤5（不是 60）', () => {
    const io = manyFiles(120);
    const generation = generate(io, { limit: 5 });
    expect(generation.discovery.total).toBe(120);
    expect(generation.sampled).toHaveLength(5);
  });

  it('目录在位但 0 份：不落盘、rc=1', () => {
    const io = new MemoryIo().addDir('/corpus');
    const generation = generate(io);
    expect(generation.problems[0]?.kind).toBe('empty');
    expect(generation.files).toHaveLength(0);
    const result = run(['corpus', '--generate-manifest'], io, { resolveRoot: () => ({ ok: true, dir: '/corpus' }) });
    expect(result.exitCode).toBe(1);
    expect(result.report.verdict).toBe('fail');
    expect(io.writes).toHaveLength(0);
  });

  it('CLI --generate-manifest：rc=0、落点固定、报告列出写入清单', () => {
    const io = manyFiles(3);
    const result = run(['corpus', '--generate-manifest'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.manifest?.outDir).toBe(OUT);
    expect(result.report.manifest?.sampled).toBe(3);
    expect(result.report.manifest?.files).toHaveLength(7);
    expect(result.text).toContain('抽样 manifest 已生成');
    expect(result.text).toContain(`${OUT}/manifest.json`);
  });

  it('语料不在位时 --generate-manifest：rc=2 且零写入', () => {
    const io = new MemoryIo();
    const result = run(['corpus', '--generate-manifest'], io, {
      resolveRoot: () => ({ ok: false, dir: null, reason: 'rc=1 无语料' }),
    });
    expect(result.exitCode).toBe(2);
    expect(io.writes).toHaveLength(0);
    expect(result.text).toContain('语料不在位');
  });

  it('报告渲染稳定（人话 + JSON 都能消费）', () => {
    const io = manyFiles(2);
    const result = run(['corpus', '--generate-manifest', '--json'], io);
    const parsed = JSON.parse(result.text) as { verdict: string; manifest: { sampled: number; text: string } };
    expect(parsed.verdict).toBe('ok');
    expect(parsed.manifest.sampled).toBe(2);
    expect(JSON.parse(parsed.manifest.text)).toMatchObject({ schema: 'kojo-migration-corpus-real/1' });
    expect(formatCorpusReport(result.report)).toContain('RESULT: PASS');
  });
});

/* ============================== 5. 真实语料（在位才跑） ============================== */

const REPO = path.resolve(import.meta.dirname, '../../..');
const PROBE = spawnSync(process.execPath, [path.join(REPO, 'tools', 'corpus.mjs'), '--print'], {
  encoding: 'utf8',
  timeout: 30000,
});
const PROBE_ROOT = PROBE.status === 0 ? PROBE.stdout.trim() : '';
const CORPUS_PRESENT = PROBE_ROOT.length > 0;

/** 真 IO：递归列文件（与 `tools/corpus.mjs` 的只读纪律一致；本文件不写语料盘） */
const realIo: CorpusIo = {
  readText: (target) => readFileSync(target, 'utf8'),
  readBytes: (target) => new Uint8Array(readFileSync(target)),
  listFiles: (dir) => {
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.isFile()) {
          out.push(`${prefix}${entry.name}`);
        }
      }
    };
    walk(dir, '');
    return out;
  },
};

describe('真实语料：`node tools/corpus.mjs --print` rc=0 才真跑', () => {
  it.skipIf(!CORPUS_PRESENT)('语料在位：真跑发现 + 迁移读数（0 份 `.kojo` 如实记缺口，不当绿）', async () => {
    // 真链路按需加载：语料缺席时整段不进这个用例（跳过分支零成本）
    const [core, sugar, support, eratw] = await Promise.all([
      import('../../kojo-core/src/index.js'),
      import('../../plugins/kojo-sugar/src/service.js'),
      import('../../plugins/kojo-sugar/tests/support.js'),
      import('../../plugins/eratw-adapter/src/kojo2/index.js'),
    ]);
    const sugarService = sugar.createSugarTranspileService({ dictionary: support.stubDict, faceTable: support.stubFaceTable() });
    const backend = eratw.createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
    const adapter = {
      ...eratw.ERATW_GAME_ADAPTER,
      profile: { ...eratw.ERATW_GAME_ADAPTER.profile, narrationColor: 'default' as const },
    };
    const compileV1Real = (text: string): MigrationCompilerOutput => {
      const result = sugarService.transpile(text);
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
    const compile2Real = (text: string): MigrationCompilerOutput => {
      const result = core.compileKojoSource({ source: text, adapter, backend });
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
    const migrateReal = (text: string) => {
      const result = core.migrateKojoSourceSemantic(text, {
        eventNames: eratw.ERATW_EVENT_NAMES,
        eventArgs: core.projectEventArgs(eratw.ERATW_EVENT_CATALOG),
      });
      return {
        ok: result.ok,
        code: result.code,
        unsupported: result.unsupported.map((entry) => ({ line: entry.line, construct: entry.construct, code: entry.code })),
      };
    };

    const discovery = discoverCorpus(PROBE_ROOT, { io: realIo, limit: 3 });
    if (discovery.total === 0) {
      const empty = runCorpusMigration({
        root: PROBE_ROOT,
        discovery,
        io: realIo,
        sha256,
        compileV1: compileV1Real,
        compile2: compile2Real,
        migrate: migrateReal,
        json: true,
      });
      expect(empty.ok).toBe(false);
      expect(empty.summary.cases).toBe(0);
      expect(empty.problems[0]?.kind).toBe('empty');
      return;
    }
    const result = runCorpusMigration({
      root: PROBE_ROOT,
      discovery,
      io: realIo,
      sha256,
      compileV1: compileV1Real,
      compile2: compile2Real,
      migrate: migrateReal,
      json: true,
    });
    expect(result.ok).toBe(true);
    expect(result.summary.cases).toBe(discovery.selected.length);
    expect(result.rate.total).toBe(discovery.selected.length);
    expect(result.rate.migratable + result.rate.unsupportedCases).toBeLessThanOrEqual(result.rate.total);
    for (const item of result.cases) {
      expect(['identical', 'normalized-equal', 'differs', 'blocked']).toContain(item.status);
    }
  });

  it.skipIf(CORPUS_PRESENT)('语料不在位：`corpus` CLI rc=2 + 「语料不在位」（SKIP 不是绿）', () => {
    const env = { ...process.env };
    delete env['KOJO_CORPUS_DIR'];
    delete env['KOJO_CORPUS_SCAN_DIRS'];
    const spawned = spawnSync(process.execPath, [path.join(REPO, 'tools', 'kojo-conformance.mjs'), 'corpus', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 90000,
    });
    expect(spawned.status).toBe(2);
    expect(spawned.stderr).toContain('语料不在位');
    const parsed = JSON.parse(spawned.stderr) as { verdict: string };
    expect(parsed.verdict).toBe('skip');
  }, 90000);
});
