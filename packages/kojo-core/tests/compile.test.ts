/**
 * C2 端到端 golden：`compileKojoSource` / `compileKojoFile` 的产物逐字节断言。
 *
 * 用 `FIXTURE_ADAPTER` + `FIXTURE_BACKEND`（伪引擎 token）跑真前端：lex → parse → 展开 → lower。
 * `# 机` 包装由 `FIXTURE_BACKEND.wrapMachine` 注入（`MACHINE <event>` / `;SLOT …` / `MACHINE.END`）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileKojoFile, compileKojoSource } from '../src/compile.js';
import { createDiagnosticSink } from '../src/diagnostics.js';
import type { KojoEmitBackend } from '../src/lower/backend.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import { parseSource } from '../src/parser.js';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/e2e/${name}`, import.meta.url)), 'utf8');

/** 验收口径：golden 直接用 fixture adapter + fixture backend（钩子已由 adapter-sdk 落地） */
const E2E_BACKEND: KojoEmitBackend = FIXTURE_BACKEND;

function compileFixture(name: string) {
  return compileKojoSource({ source: read(name), adapter: FIXTURE_ADAPTER, backend: E2E_BACKEND });
}

const lines = (erb: string): string[] => (erb.length === 0 ? [] : erb.slice(0, -1).split('\n'));

const CANONICAL_ERB = `MACHINE 开场
;SLOT __kojo_table_心情 table int
;SLOT __kojo_table_心情__value table string
TELL: 晨光透过鸟居。 /WAIT
SAY 灵梦: 今天来得挺早嘛。 /WAIT ;(微笑)
BLANK /WAIT
IF {恋慕 >= 亲近线}
SAY 灵梦: ……等你很久了。 /WAIT ;(心形)
ELSE
SET __kojo_table_心情 = {恋慕}
IF {__kojo_table_心情 >= 0 && __kojo_table_心情 <= 99}
SET __kojo_table_心情__value = {"疏远"}
ELSEIF {__kojo_table_心情 >= 100 && __kojo_table_心情 <= 499}
SET __kojo_table_心情__value = {"平常"}
ELSEIF {__kojo_table_心情 >= 500}
SET __kojo_table_心情__value = {"亲近"}
ELSE
SET __kojo_table_心情__value = {"未知"}
ENDIF
TELL: 她没说话，只是看着{__kojo_table_心情__value}。 /CONT
ENDIF
IF {恋慕 < 100}
TELL: 她抬了下眼。 /WAIT
ELSEIF {恋慕 < 500}
SAY 灵梦: 早上好。 /WAIT
ELSE
SAY 灵梦: 亲爱的，早安。 /WAIT ;(微笑)
ENDIF
SET 今天已触发 = {1}
TELL: （她红着脸，因为被夸奖而不知所措） /WAIT
SAY 灵梦: 才、才没有很开心呢！ /WAIT
TELL: （随后匆匆跑开了） /WAIT
; raw line
CALL HPH_PRINT "w"
MACHINE.END
WEAVE 开场
TELL: 监听体。 /WAIT
WEAVE.END
`;

describe('`# 机` 包装钩子与事件参数', () => {
  it('每文件调用一次；machine/args/view/body/slots 原样传入，返回值即完整产物', () => {
    const seen: {
      event: string;
      args: readonly string[];
      view: string | null;
      body: readonly string[];
      slots: readonly { name: string; kind: string }[];
    }[] = [];
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      wrapMachine: (request) => {
        seen.push({
          event: request.machine.event,
          args: request.machine.args,
          view: request.view,
          body: request.body,
          slots: request.slots,
        });
        return [...request.body];
      },
    };
    const result = compileKojoSource({ source: ['# 机 开场', '# 视 灵梦', '> 甲', ''].join('\n'), adapter: FIXTURE_ADAPTER, backend });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe('开场');
    expect(seen[0]?.view).toBe('灵梦');
    expect(seen[0]?.body).toEqual(['TELL: 甲 /WAIT']);
    expect(seen[0]?.slots).toEqual([]);
    expect(result.erb).toBe('TELL: 甲 /WAIT\n');
    expect(result.sourceMap.lineCount).toBe(1);
  });

  it('wrapMachine 拿到的隐藏槽清单 = 编译结果 slots（表/随机，去重稳定序）', () => {
    type Req = { slots: readonly { name: string; kind: string }[] };
    const seen: Req[] = [];
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      wrapMachine: (request) => {
        seen.push(request);
        return [...request.body];
      },
    };
    const source = [
      '# 机 开场',
      '# 表 心情 由 恋慕',
      '    0..9 疏远',
      '    否 未知',
      '> {心情}',
      '@随机',
      '    > 甲',
      '    > 乙',
      '',
    ].join('\n');
    const result = compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slots).toEqual(result.slots);
    expect(result.slots).toEqual([
      { name: '__kojo_table_心情', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string', role: 'table-value' },
      { name: '__kojo_rand_6', kind: 'random', valueType: 'int', role: 'random-slot' },
    ]);
  });

  it('`# 机 收场 1`：adapter 事件参数形状校验通过', () => {
    const result = compileKojoSource({
      source: ['# 机 收场 1', '> 甲', ''].join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
    });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('事件参数过多 → adapter 的 event/* error，0 字节', () => {
    const result = compileKojoSource({
      source: ['# 机 收场 1 2', '> 甲', ''].join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.some((d) => d.code.startsWith('event/'))).toBe(true);
  });
});

describe('compileKojoSource · canonical golden（逐字节）', () => {
  it('表/池/模展开 + 三正交 + ? 链 + @原生 + @织 + # 机 包装', () => {
    const result = compileFixture('canonical.kojo2');
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.erb).toBe(CANONICAL_ERB);
    // 隐藏槽清单（稳定序）：canonical 只引用 `心情` 一张表（判别值 + 值槽）
    expect(result.slots).toEqual([
      { name: '__kojo_table_心情', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string', role: 'table-value' },
    ]);
  });

  it('成功口径：erb 末尾恰好一个换行；sourceMap.lineCount === 产物行数', () => {
    const result = compileFixture('canonical.kojo2');
    expect(result.erb.endsWith('\n')).toBe(true);
    expect(result.erb.endsWith('\n\n')).toBe(false);
    expect(result.sourceMap.lineCount).toBe(lines(result.erb).length);
  });
});

describe('source map 抽检：每类节点都可回源', () => {
  const result = compileFixture('canonical.kojo2');
  const rows = lines(result.erb);
  const indexOf = (needle: string): number => rows.findIndex((line) => line.includes(needle));

  it('wrapper 行 → `# 机` 声明（事件头 origin）；`@织` 监听在主事件体之后', () => {
    const header = result.sourceMap.lineAt(1)!;
    expect(header.kind).toBe('source');
    expect(header.source?.start.line).toBe(2); // `# 机 开场` 是 fixture 第 2 行
    expect(result.sourceMap.lineAt(indexOf('MACHINE.END') + 1)?.source).toEqual(header.source);
    // 监听单元在主事件体之外（否则 = 函数套函数）
    expect(indexOf('WEAVE 开场')).toBeGreaterThan(indexOf('MACHINE.END'));
    expect(result.sourceMap.lineAt(rows.length)?.source?.start.line).toBe(43); // `@织 开场`
  });

  it('文本行 → 源行（1 基）', () => {
    const hit = result.sourceMap.lineAt(indexOf('TELL: 晨光透过鸟居。') + 1)!;
    expect(hit.kind).toBe('source');
    expect(hit.source?.start.line).toBe(27); // fixture 里 `> 晨光透过鸟居。`
  });

  it('`@原生` 逐行 → native，行号折回物理行', () => {
    const at = indexOf('; raw line') + 1;
    const hit = result.sourceMap.lineAt(at)!;
    expect(hit.kind).toBe('native');
    expect(result.sourceMap.lineAt(at + 1)?.source?.start.line).toBe((hit.source?.start.line ?? 0) + 1);
  });

  it('池展开行 → pool + 双向 origins（调用处 + 池定义处）', () => {
    const hit = result.sourceMap.lineAt(indexOf('TELL: 她抬了下眼。') + 1)!;
    expect(hit.kind).toBe('pool');
    expect(hit.origins.map((o) => o.kind)).toEqual(['call-site', 'pool-definition']);
    // 调用处 span = `! 早安问候` 那一行
    expect(hit.origins[0]?.span.start.line).toBe(35);
    expect(hit.origins[1]?.span.start.line).toBe(14); // `# 池 早安问候`
  });

  it('模板展开行 → template + 双向 origins（调用处 + 模板定义处）', () => {
    const hit = result.sourceMap.lineAt(indexOf('TELL: （她红着脸') + 1)!;
    expect(hit.kind).toBe('template');
    expect(hit.origins.map((o) => o.kind)).toEqual(['call-site', 'template-definition']);
    expect(hit.origins[0]?.span.start.line).toBe(38); // `! 娇羞退场(...)`
    expect(hit.origins[1]?.span.start.line).toBe(22); // `# 模 娇羞退场(原因)`
  });

  it('插槽内容来自调用处：template 帧 + 调用处节点的精确源 span', () => {
    const hit = result.sourceMap.lineAt(indexOf('SAY 灵梦: 才、才没有很开心呢！') + 1)!;
    expect(hit.kind).toBe('template');
    expect(hit.source?.start.line).toBe(39); // 插槽块里的台词行
  });

  it('`@织` 头/体/尾：head 映射监听声明，体映射监听体行', () => {
    expect(result.sourceMap.lineAt(indexOf('WEAVE 开场') + 1)?.source?.start.line).toBe(43);
    expect(result.sourceMap.lineAt(indexOf('TELL: 监听体。') + 1)?.source?.start.line).toBe(44);
    expect(result.sourceMap.lineAt(indexOf('WEAVE.END') + 1)?.source?.start.line).toBe(43);
  });
});

describe('compileKojoFile 直接入口（预解析树）', () => {
  it('与源码入口同字节；file 字段就是解析树', () => {
    const source = read('canonical.kojo2');
    const viaSource = compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend: E2E_BACKEND });
    const viaFile = compileKojoFile(parseSource(source), {
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
      sourceText: source,
    });
    expect(viaFile.erb).toBe(viaSource.erb);
    expect(viaFile.sourceMap.lineCount).toBe(viaSource.sourceMap.lineCount);
    expect(viaSource.file.scenes.length).toBeGreaterThan(0);
  });

  it('没有正文/`# 机` 的纯声明文件：成功、空产物、0 行映射', () => {
    const result = compileKojoSource({
      source: ['# 常量 亲近线 整数 = 500', '# 变量 心情快照 字符串 场景', ''].join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
  });
});

describe('@随机 纯度落点（fixture randStyle=rand-selectcase）', () => {
  it('单行纯文本 → single-line-text；含 @组/空行 → control-or-side-effect', () => {
    const result = compileFixture('random.kojo2');
    expect(result.ok).toBe(true);
    const out = lines(result.erb);
    expect(out.filter((line) => line.startsWith('RANDOM '))).toEqual([
      'RANDOM single-line-text 2',
      'RANDOM control-or-side-effect 2',
    ]);
    expect(out).toContain('RANDOM.END');
    // 两个 @随机 块各一个隐藏槽（按块头源行编号；fixture 第 5/9 行）
    expect(result.slots).toEqual([
      { name: '__kojo_rand_5', kind: 'random', valueType: 'int', role: 'random-slot' },
      { name: '__kojo_rand_9', kind: 'random', valueType: 'int', role: 'random-slot' },
    ]);
  });
});

describe('error 时 0 字节（fail-closed）', () => {
  const cases: readonly { readonly fixture: string; readonly code: string }[] = [
    { fixture: 'errors/table-overlap.kojo2', code: 'core/table/overlap' },
    { fixture: 'errors/table-cycle.kojo2', code: 'core/table/cycle' },
    { fixture: 'errors/pool-missing-default.kojo2', code: 'core/pool/no-default' },
    { fixture: 'errors/pool-cycle.kojo2', code: 'core/pool/cycle' },
    { fixture: 'errors/template-missing-slot.kojo2', code: 'core/template/missing-slot' },
    { fixture: 'errors/template-arg-count.kojo2', code: 'core/template/arg-count' },
    { fixture: 'errors/weave-unknown-event.kojo2', code: 'event/unknown' },
  ];

  for (const { fixture, code } of cases) {
    it(`${fixture} → ${code}，erb 与 sourceMap 都是空`, () => {
      const result = compileFixture(fixture);
      expect(result.ok).toBe(false);
      expect(result.erb).toBe('');
      expect(result.sourceMap.lineCount).toBe(0);
      expect(result.diagnostics.map((d) => d.code)).toContain(code);
      expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    });
  }

  it('解析期 error 直接并入（旧写法不产字节）', () => {
    const result = compileKojoSource({
      source: read('machine.kojo2').replace('# 视 灵梦', '# 视 灵梦\n如果 恋慕 >= 1\n    > 甲'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(result.diagnostics.some((d) => d.code.startsWith('core/migration/') || d.code.startsWith('core/narrative/'))).toBe(true);
  });

  it('未知 `# 机` 事件 → adapter 的 event/unknown，0 字节', () => {
    const result = compileKojoSource({
      source: ['# 机 不存在', '> 正文。', ''].join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((d) => d.code)).toContain('event/unknown');
  });

  it('`@织` 修饰词在 fixture（priorityModel=none）下 → core/weave/unsupported', () => {
    const result = compileKojoSource({
      source: ['# 机 开场', '> 正文。', '@织 开场 之后', '    > 监听。', ''].join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((d) => d.code)).toContain('core/weave/unsupported');
  });

  it('共享 sink（多文件服务）：别的文件的 error 不让本文件变成 0 字节，诊断只回本文件', () => {
    const sink = createDiagnosticSink();
    const bad = compileKojoSource({
      source: read('errors/table-overlap.kojo2'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
      sink,
    });
    expect(bad.ok).toBe(false);
    const good = compileKojoSource({
      source: read('machine.kojo2'),
      adapter: FIXTURE_ADAPTER,
      backend: E2E_BACKEND,
      sink,
    });
    expect(good.ok).toBe(true);
    expect(good.erb).not.toBe('');
    expect(good.diagnostics).toEqual([]); // 不把上一文件的诊断带回来
  });

  it('有 `# 机` 但 backend 没实现 wrapMachine → core/feature/unsupported，0 字节', () => {
    // fixture backend 现在实现了钩子：显式剥掉它来测"缺能力"路径
    const { wrapMachine: _omitted, ...noWrapBackend } = FIXTURE_BACKEND;
    const result = compileKojoSource({
      source: read('machine.kojo2'),
      adapter: FIXTURE_ADAPTER,
      backend: noWrapBackend,
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((d) => d.code)).toContain('core/feature/unsupported');
  });

  it('wrapMachine 违约（body 被改写/丢行）→ event/wrap-contract，0 字节', () => {
    const dropping: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      wrapMachine: () => [], // 丢掉整个 body：子序列对不上 = 违约
    };
    const result = compileKojoSource({ source: read('machine.kojo2'), adapter: FIXTURE_ADAPTER, backend: dropping });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((d) => d.code)).toContain('event/wrap-contract');
  });
});
