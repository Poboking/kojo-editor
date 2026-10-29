/**
 * `kojo-sugar` 2.0 转译服务（`src/kojo2/service.ts`）单测。
 *
 * 覆盖（任务契约）：
 * 1) canonical 2.0 fixture（`.kojo2`）→ ERB **逐字节** golden（`FIXTURE_BACKEND` 伪引擎）；
 *    设 `KOJO2_GOLDEN_WRITE=1` 可重生成 golden（与 v1 golden 同一套人工复核纪律）。
 * 2) 服务编排：adapter/backend 由 deps 注入，编译入口可注入替身（core `compileKojoFile`
 *    未就绪时的替换点）；同输入两次输出逐字节相同。
 * 3) **error ⇒ 0 字节**：语法/迁移错误 fixture 与 backend `EmitFailure` 两条路径都验证
 *    `ok=false`、`erb=''`、`sourceMap.lineCount=0`；上游违约（error 还给字节）**抛错**。
 * 4) 插件入口 additive：新工厂与 v1 原有导出同时存在，v1 注册面零改动。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createSourceMapBuilder,
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  type KojoDiagnostic,
  type KojoEmitBackend,
  type KojoFile,
  type SourceMap,
} from '@kojo/kojo-core';

import {
  createKojo2TranspileService,
  type Kojo2CompileFn,
  type Kojo2CompileRequest,
  type Kojo2CompileResult,
} from '../../src/kojo2/index';
import * as plugin from '../../src/index';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const GOLDEN_NAME = 'canonical.golden.erb';
const EMPTY_MAP: SourceMap = createSourceMapBuilder().build();

const service = () => createKojo2TranspileService({ adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });

/* ============================== 1. canonical golden ============================== */

describe('2.0 服务 · canonical golden（fixture backend）', () => {
  it('canonical.kojo2 → ERB 逐字节 golden；source map 行数与产物行数一致', () => {
    const result = service().transpile({
      source: readFixture('canonical.kojo2'),
      filePath: 'canonical.kojo2',
    });

    // 重生成开关：只在显式设置时写盘（CI/常规跑只读）
    if (process.env.KOJO2_GOLDEN_WRITE === '1') {
      writeFileSync(new URL(GOLDEN_NAME, FIXTURES), result.erb, 'utf8');
    }
    const golden = readFixture(GOLDEN_NAME);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.erb).toBe(golden);
    expect(golden.endsWith('\n')).toBe(true);
    // 成功产物 = `lines.join('\n') + '\n'` ⇒ 行数 = 换行数
    expect(result.sourceMap.lineCount).toBe(golden.split('\n').length - 1);
    expect(result.sourceMap.lineCount).toBeGreaterThan(0);
  });

  it('同一输入两次 ⇒ 产物 / 诊断 / source map 读数完全相同（纯函数）', () => {
    const run = () =>
      service().transpile({ source: readFixture('canonical.kojo2'), filePath: 'canonical.kojo2' });
    const first = run();
    const second = run();
    expect(second.erb).toBe(first.erb);
    expect(second.ok).toBe(first.ok);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.sourceMap.lineCount).toBe(first.sourceMap.lineCount);
  });

  it('只有声明、没有正文 ⇒ 合法空产物（ok=true、erb=""、sourceMap 空）', () => {
    const result = service().transpile({
      source: '# 设 上限 整数 = 10\n# 设 心情 字符串 场景\n',
      filePath: 'decls-only.kojo2',
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
  });
});

/* ============================== 2. error ⇒ 0 字节 ============================== */

describe('2.0 服务 · fail-closed（error 不产字节）', () => {
  it('旧写法 / 裸引号 fixture ⇒ ok=false、0 字节、空 source map、诊断带 core 码', () => {
    const result = service().transpile({
      source: readFixture('invalid.kojo2'),
      filePath: 'invalid.kojo2',
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('core/narrative/bare-quote');
    expect(codes).toContain('core/migration/if');
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });

  it('backend 返回 EmitFailure（表达不了）⇒ 整份 0 字节、诊断原样上浮', () => {
    const failureDiagnostic: KojoDiagnostic = {
      code: 'core/narrative/bare-quote',
      severity: 'error',
      message: 'fixture backend：这一行表达不了',
      span: null,
    };
    const failingBackend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      text: {
        line: () => ({ diagnostics: [failureDiagnostic] }),
      },
    };
    const result = createKojo2TranspileService({ adapter: FIXTURE_ADAPTER, backend: failingBackend }).transpile({
      source: '# 机 开场\n> 会被 backend 拒绝的一行。\n',
      filePath: 'backend-failure.kojo2',
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(result.diagnostics).toContainEqual(failureDiagnostic);
  });
});

/* ============================== 3. 编排 / 注入 / 违约 ============================== */

describe('2.0 服务 · 编排与注入', () => {
  const fakeResult = (overrides: Partial<Kojo2CompileResult> = {}): Kojo2CompileResult => ({
    ok: true,
    erb: 'FAKE\n',
    sourceMap: EMPTY_MAP,
    diagnostics: [],
    ...overrides,
  });

  it('编译入口可注入：服务把 source/filePath 与注入的 adapter/backend 原样交上去', () => {
    const calls: Kojo2CompileRequest[] = [];
    const compile: Kojo2CompileFn = (request) => {
      calls.push(request);
      return fakeResult();
    };
    const customBackend: KojoEmitBackend = { ...FIXTURE_BACKEND, id: 'custom-backend' };
    const result = createKojo2TranspileService({
      adapter: FIXTURE_ADAPTER,
      backend: customBackend,
      compile,
    }).transpile({ source: '# 机 指令 310\n', filePath: 'injected.kojo2' });

    expect(result).toEqual(fakeResult());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe('# 机 指令 310\n');
    expect(calls[0]!.filePath).toBe('injected.kojo2');
    expect(calls[0]!.adapter).toBe(FIXTURE_ADAPTER);
    expect(calls[0]!.backend).toBe(customBackend);
  });

  it('上游违约：诊断含 error 却给了字节 ⇒ 抛错（半成品不许离开服务层）', () => {
    const compile: Kojo2CompileFn = () =>
      fakeResult({
        ok: true,
        erb: 'HALF\n',
        diagnostics: [{ code: 'core/migration/if', severity: 'error', message: 'x', span: null }],
      });
    expect(() =>
      createKojo2TranspileService({ adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND, compile }).transpile({
        source: '> x\n',
        filePath: 'x.kojo2',
      }),
    ).toThrow(/自相矛盾/);
  });

  it('上游违约：ok=false 却有字节 ⇒ 抛错；ok 与诊断不一致 ⇒ 抛错', () => {
    const errorDiag: KojoDiagnostic = { code: 'core/migration/if', severity: 'error', message: 'x', span: null };
    const withBytes: Kojo2CompileFn = () =>
      fakeResult({ ok: false, erb: 'BYTES\n', diagnostics: [errorDiag] });
    expect(() =>
      createKojo2TranspileService({ adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND, compile: withBytes }).transpile({
        source: '> x\n',
        filePath: 'x.kojo2',
      }),
    ).toThrow(/违约/);

    const inconsistent: Kojo2CompileFn = () => fakeResult({ ok: false, erb: '', diagnostics: [] });
    expect(() =>
      createKojo2TranspileService({ adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND, compile: inconsistent }).transpile({
        source: '> x\n',
        filePath: 'x.kojo2',
      }),
    ).toThrow(/自相矛盾/);
  });

  it('输入守卫：source 非字符串 / filePath 为空 ⇒ TypeError（不静默编译）', () => {
    const svc = service();
    expect(() =>
      svc.transpile({ source: 42 as unknown as string, filePath: 'x.kojo2' }),
    ).toThrow(TypeError);
    expect(() => svc.transpile({ source: '> x\n', filePath: '' })).toThrow(TypeError);
    expect(() => svc.transpile({ source: '> x\n', filePath: '   ' })).toThrow(TypeError);
  });
});

/* ============================== 4. 插件入口 additive ============================== */

describe('插件入口 · additive 导出', () => {
  it('新工厂从插件公共入口可导出，且与 kojo2 子入口是同一函数', () => {
    expect(typeof plugin.createKojo2TranspileService).toBe('function');
    expect(plugin.createKojo2TranspileService).toBe(createKojo2TranspileService);
  });

  it('v1 原有导出仍在（注册面零改动）', () => {
    expect(typeof plugin.createKojoSugarPlugin).toBe('function');
    expect(typeof plugin.createSugarTranspileService).toBe('function');
    const created = plugin.createKojoSugarPlugin();
    expect(created.id).toBe('kojo-sugar');
    expect(created.provides).toEqual([
      'sugar.transpile',
      'sugar.preview',
      'sugar.lift',
      'sugar.liftApply',
    ]);
  });

  it('2.0 服务工厂是纯装配：不注册任何插件能力（不抢 v1 键）', () => {
    const svc = plugin.createKojo2TranspileService({ adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });
    expect(Object.keys(svc)).toEqual(['transpile']);
    expect(typeof svc.transpile).toBe('function');
  });
});

/* ============================== 5. 类型锚（编译期契约） ============================== */

/** 这些断言只用于把公共类型钉在测试里（`pnpm typecheck` 会检查；运行时零成本） */
const _typeAnchors = (): void => {
  const compile: Kojo2CompileFn = (request: Kojo2CompileRequest): Kojo2CompileResult => ({
    ok: true,
    erb: '',
    sourceMap: EMPTY_MAP,
    diagnostics: request.adapter === FIXTURE_ADAPTER ? [] : [],
  });
  const file: KojoFile | null = null;
  void compile;
  void file;
};
void _typeAnchors;
