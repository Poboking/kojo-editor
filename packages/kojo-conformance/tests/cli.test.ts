/**
 * conformance CLI 单测：**零真盘**——所有目录/文件读取都经内存 IO 端口，
 * 因此可以精确断言"读了几次、列了几次、顺序是否稳定"。
 *
 * 覆盖：用法错误（exit 2）/ 全绿（0）/ golden·differential·encoding 失败（1）/
 * `--json` 字段序与结构 / 目录遍历顺序稳定 / 空目录 / 坏 fixture / 内建套件。
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '@kojo/kojo-core';
import type { ConformanceCliDeps, ConformanceCliResult, ConformanceIoPort } from '../src/cli.js';
import { formatConformanceReport, runConformanceCli, splitGoldenPair } from '../src/cli.js';
import { builtinConformanceCases } from '../src/suite.js';

/* ============================== 内存 IO ============================== */

class MemoryIo implements ConformanceIoPort {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];
  readonly lists: string[] = [];
  /** 只出现在目录清单里、实际读不到的文件（模拟坏 fixture） */
  readonly listOnly: string[] = [];
  readonly missingDirs = new Set<string>();
  listOrder: 'sorted' | 'reversed' = 'sorted';

  add(path: string, text: string): this {
    this.files.set(path, text);
    return this;
  }

  readText(path: string): string {
    this.reads.push(path);
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  }

  listFiles(dir: string): readonly string[] {
    this.lists.push(dir);
    if (this.missingDirs.has(dir)) throw new Error(`ENOTDIR: ${dir}`);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const out = [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .concat(this.listOnly);
    return this.listOrder === 'reversed' ? out.reverse() : out.sort();
  }
}

/* ============================== 固定夹具 ============================== */

const BASIC_SOURCE =
  '# 机 开场\n# 视角 灵梦\n\n> 晨光透过鸟居。\n我：「今天来得挺早嘛。」\n空行\n我：「……好。」 续\n空行 续\n';
const BASIC_GOLDEN =
  'MACHINE 开场\nTELL: 晨光透过鸟居。 /WAIT\nSAY 我: 今天来得挺早嘛。 /WAIT\nBLANK /WAIT\nSAY 我: ……好。 /CONT\nBLANK /CONT\nMACHINE.END\n';

const SIMPLE_SOURCE = '# 机 开场\n> 你好\n';
const SIMPLE_GOLDEN = 'MACHINE 开场\nTELL: 你好 /WAIT\nMACHINE.END\n';
/** 旧产物：CRLF + 整行注释，differential 归一化后应与 2.0 产物一致 */
const SIMPLE_BASELINE = '; 旧产物\r\nMACHINE 开场\r\nTELL: 你好 /WAIT\r\nMACHINE.END\r\n';

const ADAPTERS = { fixture: { adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND } } as const;

function run(argv: readonly string[], io: MemoryIo, extra: Partial<ConformanceCliDeps> = {}): ConformanceCliResult {
  return runConformanceCli(argv, { io, adapters: ADAPTERS, ...extra } as ConformanceCliDeps);
}

function dirIo(): MemoryIo {
  return new MemoryIo()
    .add('/suite/basic.kojo2', BASIC_SOURCE)
    .add('/suite/basic.golden.erb', BASIC_GOLDEN)
    .add('/suite/legacy.kojo2', SIMPLE_SOURCE)
    .add('/suite/legacy.erb', SIMPLE_BASELINE);
}

function goldenIo(): MemoryIo {
  return new MemoryIo()
    .add('fixtures/basic.kojo2', BASIC_SOURCE)
    .add('fixtures/basic.golden.erb', BASIC_GOLDEN);
}

/* ============================== 用法 ============================== */

describe('用法错误 · exit 2', () => {
  it('无参数 → 用法 + exit 2', () => {
    const result = run([], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('用法:');
    expect(result.report.usage).toContain('错误：缺少命令');
    expect(result.report.failures).toEqual([]);
    expect(result.report.cases).toEqual([]);
  });

  it('未知命令 → 用法 + exit 2', () => {
    const result = run(['frobnicate'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('未知命令：frobnicate');
  });

  it('check 缺目标 → exit 2', () => {
    const result = run(['check'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('需要一个目标');
  });

  it('--dir 缺值 → exit 2', () => {
    const result = run(['check', '--adapter', 'fixture', '--dir'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('缺少 --dir 的值');
  });

  it('--dir 没给 --adapter → exit 2（目录模式不设默认 adapter）', () => {
    const result = run(['check', '--dir', '/suite'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('check --dir 需要 --adapter');
  });

  it('未知 adapter → exit 2，并列已注册名称', () => {
    const result = run(['check', '--adapter', 'nope', '--dir', '/suite'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('未知 adapter：nope');
    expect(result.report.usage).toContain('fixture');
  });

  it('未知参数 → exit 2', () => {
    const result = run(['check', '--wat', '--suite', '--adapter', 'fixture'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('未知参数：--wat');
  });

  it('--dir 与 --golden 互斥 → exit 2', () => {
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite', '--golden', 'a:b'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('互斥');
  });

  it('重复 --dir → exit 2', () => {
    const result = run(['check', '--adapter', 'fixture', '--dir', '/a', '--dir', '/b'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('重复参数：--dir');
  });

  it('--golden 缺少冒号分隔 → exit 2', () => {
    const result = run(['check', '--golden', 'fixtures/basic.kojo2'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('--golden 需要');
  });

  it('--golden 产物侧为空 → exit 2', () => {
    const result = run(['check', '--golden', 'fixtures/basic.kojo2:'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('--golden 需要');
  });

  it('list-cases 多余位置参数 → exit 2', () => {
    const result = run(['list-cases', 'extra'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('多余的位置参数');
  });

  it('help → exit 0 + 用法，且不碰 IO', () => {
    const io = new MemoryIo();
    const result = run(['help'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.usage).toContain('list-cases');
    expect(io.reads).toEqual([]);
    expect(io.lists).toEqual([]);
  });

  it('runConformanceCli 不设置 process.exitCode（零 process.exit）', () => {
    const before = process.exitCode;
    run(['frobnicate'], new MemoryIo());
    run(['list-cases'], new MemoryIo());
    expect(process.exitCode).toBe(before);
  });
});

/* ============================== list-cases ============================== */

describe('list-cases', () => {
  it('列出内建套件（名称/kind/未执行标记/说明），exit 0', () => {
    const io = new MemoryIo();
    const result = run(['list-cases'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.adapter).toBe('fixture');
    expect(result.report.cases.map((item) => item.name)).toEqual(builtinConformanceCases().map((item) => item.name));
    expect(result.report.cases.map((item) => item.kind)).toEqual(['golden', 'readings', 'encoding']);
    expect(result.report.cases.every((item) => item.ok === null)).toBe(true);
    expect(result.report.cases.every((item) => item.failures === 0)).toBe(true);
    expect(result.report.cases.every((item) => (item.description ?? '').length > 0)).toBe(true);
    expect(result.report.files).toEqual([]);
    expect(io.reads).toEqual([]);
    expect(io.lists).toEqual([]);
  });

  it('list-cases --adapter 未知 → exit 2', () => {
    const result = run(['list-cases', '--adapter', 'nope'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    expect(result.report.usage).toContain('未知 adapter：nope');
  });
});

/* ============================== check --golden ============================== */

describe('check --golden', () => {
  it('逐字节一致 → exit 0，带产物读数', () => {
    const result = run(['check', '--golden', 'fixtures/basic.kojo2:fixtures/basic.golden.erb'], goldenIo());
    expect(result.exitCode).toBe(0);
    expect(result.report.failures).toEqual([]);
    expect(result.report.files.map((file) => file.path)).toEqual(['fixtures/basic.kojo2']);
    expect(result.report.cases.map((item) => [item.name, item.kind, item.ok])).toEqual([
      ['fixtures/basic.kojo2:golden', 'golden', true],
    ]);
    expect(result.report.files[0]?.artifact?.lines).toBe(7);
    expect(result.report.files[0]?.source?.eol).toBe('lf');
    expect(result.report.readings.artifact.lines).toBe(7);
  });

  it('单字节漂移 → exit 1，失败带 code/case/file/sourceLine + diff', () => {
    const io = new MemoryIo()
      .add('fix/basic.kojo2', BASIC_SOURCE)
      .add('fix/basic.golden.erb', BASIC_GOLDEN.replace('/WAIT', '/CONT'));
    const result = run(['check', '--golden', 'fix/basic.kojo2:fix/basic.golden.erb'], io);
    expect(result.exitCode).toBe(1);
    const failure = result.report.failures[0];
    expect(failure?.code).toBe('conformance/golden');
    expect(failure?.case).toBe('fix/basic.kojo2:golden');
    expect(failure?.file).toBe('fix/basic.kojo2');
    expect(failure?.sourceLine).toBe(4);
    expect(failure?.artifactLine).toBe(2);
    expect(failure?.diff.some((item) => item.kind === 'removed')).toBe(true);
    expect(failure?.diff.some((item) => item.kind === 'added')).toBe(true);
    expect(failure?.expected).toContain('/CONT');
    expect(failure?.actual).toContain('/WAIT');
    expect(result.report.cases[0]?.ok).toBe(false);
  });

  it('基线带 UTF-8 BOM → 先剥 BOM 再对拍（BOM 不参与 golden 字节）', () => {
    const io = new MemoryIo()
      .add('fix/basic.kojo2', BASIC_SOURCE)
      .add('fix/basic.golden.erb', `\uFEFF${BASIC_GOLDEN}`);
    const result = run(['check', '--golden', 'fix/basic.kojo2:fix/basic.golden.erb'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.failures).toEqual([]);
  });

  it('产物文件读不到 → exit 1（conformance/input，定位到基线）', () => {
    const io = new MemoryIo().add('fix/basic.kojo2', BASIC_SOURCE);
    const result = run(['check', '--golden', 'fix/basic.kojo2:fix/missing.erb'], io);
    expect(result.exitCode).toBe(1);
    const failure = result.report.failures[0];
    expect(failure?.code).toBe('conformance/input');
    expect(failure?.file).toBe('fix/basic.kojo2');
    expect(failure?.field).toBe('expectedErb');
    expect(failure?.message).toContain('无法读取 golden 基线');
    expect(result.report.cases).toEqual([]);
  });

  it('源文件读不到 → exit 1（conformance/input）', () => {
    const io = new MemoryIo().add('fix/basic.golden.erb', BASIC_GOLDEN);
    const result = run(['check', '--golden', 'fix/missing.kojo2:fix/basic.golden.erb'], io);
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.code).toBe('conformance/input');
    expect(result.report.failures[0]?.field).toBe('source');
    expect(result.report.files[0]?.source).toBeNull();
  });

  it('坏 fixture（未知事件）→ exit 1，conformance/diagnostics 带源行', () => {
    const io = new MemoryIo()
      .add('fix/bad.kojo2', '# 机 不存在\n> 甲\n')
      .add('fix/bad.golden.erb', '');
    const result = run(['check', '--golden', 'fix/bad.kojo2:fix/bad.golden.erb'], io);
    expect(result.exitCode).toBe(1);
    const failure = result.report.failures.find((item) => item.code === 'conformance/diagnostics');
    expect(failure).toBeDefined();
    expect(failure?.file).toBe('fix/bad.kojo2');
    expect(failure?.sourceLine).toBe(1);
    expect(failure?.check).toBe('golden');
  });

  it('--golden 不列目录（listFiles 一次也不调）', () => {
    const io = goldenIo();
    run(['check', '--golden', 'fixtures/basic.kojo2:fixtures/basic.golden.erb'], io);
    expect(io.lists).toEqual([]);
    expect(io.reads).toEqual(['fixtures/basic.kojo2', 'fixtures/basic.golden.erb']);
  });
});

describe('splitGoldenPair · Windows 盘符', () => {
  it('相对路径按第一个冒号切分', () => {
    expect(splitGoldenPair('a/b.kojo2:c/d.erb')).toEqual({ source: 'a/b.kojo2', artifact: 'c/d.erb' });
  });

  it('两侧盘符冒号不算分隔符', () => {
    expect(splitGoldenPair('C:\\x\\a.kojo2:D:\\y\\b.erb')).toEqual({
      source: 'C:\\x\\a.kojo2',
      artifact: 'D:\\y\\b.erb',
    });
  });

  it('单字母目录名不误判为盘符', () => {
    expect(splitGoldenPair('a:b.erb')).toEqual({ source: 'a', artifact: 'b.erb' });
  });
});

/* ============================== check --dir ============================== */

describe('check --dir', () => {
  it('全绿 → exit 0；文件序稳定、每文件 golden/differential + encoding', () => {
    const io = dirIo();
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.failures).toEqual([]);
    expect(result.report.files.map((file) => file.path)).toEqual(['basic.kojo2', 'legacy.kojo2']);
    expect(result.report.files.map((file) => file.cases)).toEqual([
      ['basic.kojo2:golden', 'basic.kojo2:encoding'],
      ['legacy.kojo2:differential', 'legacy.kojo2:encoding'],
    ]);
    expect(result.report.cases.map((item) => item.kind)).toEqual(['golden', 'encoding', 'differential', 'encoding']);
    expect(result.report.cases.every((item) => item.ok === true)).toBe(true);
    // 源 2 读 + 两个基线各 1 读；目录只列一次
    expect(io.reads).toEqual([
      '/suite/basic.kojo2',
      '/suite/basic.golden.erb',
      '/suite/legacy.kojo2',
      '/suite/legacy.erb',
    ]);
    expect(io.lists).toEqual(['/suite']);
    expect(result.report.readings.source.files).toBe(2);
    expect(result.report.readings.artifact.lines).toBe(10);
    const byCheck = new Map(result.report.readings.byCheck.map((item) => [item.check, item]));
    expect(byCheck.get('golden')).toMatchObject({ passed: 1, failed: 0 });
    expect(byCheck.get('differential')).toMatchObject({ passed: 1, failed: 0 });
    expect(byCheck.get('encoding')).toMatchObject({ passed: 2, failed: 0 });
    expect(byCheck.get('smoke')?.skipped).toBe(1);
  });

  it('golden 失败 → exit 1，failures.file 映射到目录内相对路径', () => {
    const io = dirIo();
    io.add('/suite/basic.golden.erb', BASIC_GOLDEN.replace('/WAIT', '/CONT'));
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite'], io);
    expect(result.exitCode).toBe(1);
    expect(result.report.failures).toHaveLength(1);
    const failure = result.report.failures[0];
    expect(failure?.code).toBe('conformance/golden');
    expect(failure?.file).toBe('basic.kojo2');
    expect(failure?.case).toBe('basic.kojo2:golden');
    expect(failure?.sourceLine).toBe(4);
    expect(result.report.files.find((file) => file.path === 'basic.kojo2')?.ok).toBe(false);
    expect(result.report.files.find((file) => file.path === 'legacy.kojo2')?.ok).toBe(true);
  });

  it('differential 不一致 → exit 1，code=conformance/differential', () => {
    const io = dirIo();
    io.add('/suite/legacy.erb', 'MACHINE 开场\nTELL: 旧文本 /WAIT\nMACHINE.END\n');
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite'], io);
    expect(result.exitCode).toBe(1);
    const failure = result.report.failures.find((item) => item.code === 'conformance/differential');
    expect(failure?.file).toBe('legacy.kojo2');
    expect(failure?.case).toBe('legacy.kojo2:differential');
    expect(failure?.check).toBe('differential');
    expect(failure?.expected).toContain('旧文本');
  });

  it('空目录 → exit 0（无文件即无失败），只列一次目录', () => {
    const io = new MemoryIo();
    const result = run(['check', '--adapter', 'fixture', '--dir', '/empty'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.files).toEqual([]);
    expect(result.report.cases).toEqual([]);
    expect(result.report.failures).toEqual([]);
    expect(result.report.readings.source.files).toBe(0);
    expect(result.report.readings.source.utf8Bytes).toBe(0);
    expect(io.reads).toEqual([]);
    expect(io.lists).toEqual(['/empty']);
  });

  it('目录读不到 → exit 1（conformance/input，file=目录）', () => {
    const io = new MemoryIo();
    io.missingDirs.add('/nope');
    const result = run(['check', '--adapter', 'fixture', '--dir', '/nope'], io);
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.code).toBe('conformance/input');
    expect(result.report.failures[0]?.file).toBe('/nope');
    expect(result.report.failures[0]?.message).toContain('无法列出目录');
  });

  it('源文件读不到（清单里有、盘上没有）→ exit 1，file 报告 source=null', () => {
    const io = new MemoryIo();
    io.listOnly.push('ghost.kojo2');
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite'], io);
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.code).toBe('conformance/input');
    expect(result.report.failures[0]?.file).toBe('ghost.kojo2');
    expect(result.report.files[0]).toMatchObject({ path: 'ghost.kojo2', ok: false, source: null, artifact: null });
  });

  it('遍历顺序不受 listFiles 返回序影响（逆序输入 → 报告逐字相同）', () => {
    const forward = dirIo();
    const reversed = dirIo();
    reversed.listOrder = 'reversed';
    const args = ['check', '--adapter', 'fixture', '--dir', '/suite'];
    const first = JSON.stringify(run(args, forward).report);
    const second = JSON.stringify(run(args, reversed).report);
    expect(second).toBe(first);
    expect(JSON.parse(first).files.map((file: { path: string }) => file.path)).toEqual([
      'basic.kojo2',
      'legacy.kojo2',
    ]);
  });

  it('非 .kojo2 文件不参与检查，也不被读取', () => {
    const io = new MemoryIo().add('/suite/notes.txt', 'x').add('/suite/a.kojo2', SIMPLE_SOURCE);
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.files.map((file) => file.path)).toEqual(['a.kojo2']);
    expect(io.reads).toEqual(['/suite/a.kojo2']);
  });

  it('目录参数带尾部分隔符与反斜杠 → 规范到同一路径', () => {
    const io = dirIo();
    const result = run(['check', '--adapter', 'fixture', '--dir', '/suite/'], io);
    expect(result.exitCode).toBe(0);
    expect(io.lists).toEqual(['/suite']);
    expect(io.reads[0]).toBe('/suite/basic.kojo2');
  });
});

/* ============================== check --suite ============================== */

describe('check --suite', () => {
  it('内建三条用例全绿 → exit 0，零 IO', () => {
    const io = new MemoryIo();
    const result = run(['check', '--suite', '--adapter', 'fixture'], io);
    expect(result.exitCode).toBe(0);
    expect(result.report.failures).toEqual([]);
    expect(result.report.cases.map((item) => [item.name, item.ok])).toEqual(
      builtinConformanceCases().map((item) => [item.name, true]),
    );
    expect(result.report.files).toEqual([]);
    expect(io.reads).toEqual([]);
    expect(io.lists).toEqual([]);
    expect(result.report.readings.contract).toMatchObject({ ok: true, adapterId: 'fixture', backendId: 'fixture' });
  });
});

/* ============================== 报告形状 ============================== */

describe('报告形状 · 稳定字段序', () => {
  it('--json 顶层 / readings / failure 字段序固定', () => {
    const io = new MemoryIo()
      .add('fix/basic.kojo2', BASIC_SOURCE)
      .add('fix/basic.golden.erb', BASIC_GOLDEN.replace('/WAIT', '/CONT'));
    const result = run(['check', '--json', '--golden', 'fix/basic.kojo2:fix/basic.golden.erb'], io);
    const parsed = JSON.parse(formatConformanceReport(result.report, { json: true })) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['adapter', 'files', 'cases', 'failures', 'readings', 'usage']);
    expect(Object.keys(parsed.readings as object)).toEqual(['contract', 'byCheck', 'source', 'artifact']);
    expect(Object.keys((parsed.failures as Record<string, unknown>[])[0] ?? {})).toEqual([
      'code',
      'case',
      'file',
      'sourceLine',
      'check',
      'field',
      'artifactLine',
      'message',
      'expected',
      'actual',
      'diff',
      'diagnostics',
    ]);
    expect((parsed.failures as Record<string, unknown>[])[0]?.code).toBe('conformance/golden');
  });

  it('人话报告：失败不进 warning；含 FAILURES / RESULT: FAIL / 读数行', () => {
    const io = new MemoryIo()
      .add('fix/basic.kojo2', BASIC_SOURCE)
      .add('fix/basic.golden.erb', BASIC_GOLDEN.replace('/WAIT', '/CONT'));
    const result = run(['check', '--golden', 'fix/basic.kojo2:fix/basic.golden.erb'], io);
    const text = formatConformanceReport(result.report);
    expect(text).toContain('kojo-conformance · adapter=fixture');
    expect(text).toContain('FAILURES (1)');
    expect(text).toContain('[conformance/golden] fix/basic.kojo2:4');
    expect(text).toContain('RESULT: FAIL (1 failures, exit 1)');
    expect(text).toContain('readings: contract ok');
    expect(text).not.toMatch(/\bwarning\b/i);
  });

  it('全绿报告含 PASS / RESULT: PASS；JSON 可解析且与 report 等价', () => {
    const result = run(['check', '--golden', 'fixtures/basic.kojo2:fixtures/basic.golden.erb'], goldenIo());
    const human = formatConformanceReport(result.report);
    expect(human).toContain('PASS  fixtures/basic.kojo2');
    expect(human).toContain('RESULT: PASS');
    const json = formatConformanceReport(result.report, { json: true });
    expect(JSON.parse(json)).toEqual(result.report);
  });

  it('用法错误即使带 --json 也输出 usage 文本（不伪装成 JSON）', () => {
    const result = run(['check', '--json'], new MemoryIo());
    expect(result.exitCode).toBe(2);
    const text = formatConformanceReport(result.report, { json: true });
    expect(text).toContain('用法:');
    expect(() => JSON.parse(text)).toThrow();
  });

  it('list-cases 人话报告列出三条内建用例并以 kind 标注', () => {
    const result = run(['list-cases'], new MemoryIo());
    const text = formatConformanceReport(result.report);
    expect(text).toContain('3 个内建用例');
    expect(text).toContain('[golden]');
    expect(text).toContain('[readings]');
    expect(text).toContain('[encoding]');
  });
});
