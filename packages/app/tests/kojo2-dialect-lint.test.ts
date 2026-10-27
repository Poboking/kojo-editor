/**
 * `dialect lint`（LAU-D2，§5.5 七项）的闸。
 *
 * 钉六件事：
 * 1. **七项各一条正例 + 一条反例**：事件名 / 事件落点 / 符号 / 只读别名 / 演出 / 载体归属 / 等待；
 * 2. **未绑定不猜**（§9-9）：没有 2.0 事实 ⇒ 体检交 `null`，零"未知事件"告警；
 * 3. **错配必红**（§9-8）：把 eraTW 的事实当 eraFL 的事实交进去 ⇒ 解析器报
 *    `core/dialect/response-mismatch` 并按未绑定返回 ⇒ 体检一个事实都拿不到（不静默通过）；
 * 4. **聚合去重**：同类 400 条 ⇒ 1 条汇总（`count = 400`，行号去重升序）；
 * 5. **不产波浪线**：体检结论走 `lint` 那一格，`markers` / `errorCount` 一个字不动；
 * 6. **位置指到事件名那一段**：`core/event/unknown` 的 span 就是事件名的列区间。
 */
import { describe, expect, it } from 'vitest';
import {
  compileKojoSource,
  resolveDialectBinding,
  severityOf,
  type GameAdapter,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import { ERATW_GAME_ADAPTER, createEratwEmitBackend } from '@kojo/plugin-eratw-adapter';
import { ERAFL_GAME_ADAPTER, createEraflEmitBackend } from '@kojo/plugin-erafl-adapter';
import {
  KOJO2_LINT_CODES,
  aggregateKojo2DialectLint,
  kojo2DialectLintProblems,
  lintKojo2Dialect,
} from '../src/monaco/kojo2-dialect-lint';
import { kojo2EventSitesOf } from '../src/monaco/kojo2-event-sites';
import { kojo2DocumentOf } from '@kojo/kojo-lang';

/* ============================== 基座 ============================== */

const ERAFL_BACKEND = createEraflEmitBackend({ compileExpression: (expr) => expr.text });
const ERATW_BACKEND = createEratwEmitBackend({ compileExpression: (expr) => expr.text });

/** 用真实 adapter + 真实 backend 走一次编译，取出"同一次编译的诊断"（体检的第 3–5 项来源） */
function compileDiagnosticsOf(source: string, adapter: GameAdapter): readonly KojoDiagnostic[] {
  const backend = adapter.id === 'erafl' ? ERAFL_BACKEND : ERATW_BACKEND;
  return compileKojoSource({ source, adapter, backend }).diagnostics;
}

const codesOf = (diagnostics: readonly KojoDiagnostic[]): string[] =>
  diagnostics.map((item) => item.code);

/** 体检一口价：编译诊断 + 方言事实（未绑定 = 第三参给 null） */
function lintOf(
  source: string,
  facts: GameAdapter | null,
  binding: Parameters<typeof lintKojo2Dialect>[0]['binding'] = null,
  resolutionDiagnostics?: readonly KojoDiagnostic[],
) {
  return lintKojo2Dialect({
    source,
    facts,
    binding,
    ...(facts === null ? {} : { diagnostics: compileDiagnosticsOf(source, facts) }),
    ...(resolutionDiagnostics !== undefined ? { resolutionDiagnostics } : {}),
  });
}

/* ============================== 1. 事件名 ============================== */

describe('第 1 项 · 事件名对着 eventCatalog（`# 机` / `@织` 两条落点）', () => {
  it('正例：eraFL 没有 `训练` ⇒ `core/event/unknown`（error、指到事件名那一段）', () => {
    const report = lintOf('# 机 训练\n\n> 正文。\n', ERAFL_GAME_ADAPTER);
    expect(report).not.toBeNull();
    const unknown = report!.diagnostics.filter((item) => item.code === 'core/event/unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe('error');
    // `# 机 训练`：`#`=1 ` `=2 `机`=3 ` `=4 ⇒ 事件名从第 5 列起、半开尾 7
    expect(unknown[0]!.span).toEqual({ start: { line: 1, column: 5 }, end: { line: 1, column: 7 } });
    expect(unknown[0]!.message).toContain('初见');
  });

  it('正例：`@织` 同样吃目录（`@织 训练 之后` 在 eraFL 下是未知事件）', () => {
    const report = lintOf('@织 训练 之后\n\n> 监听体。\n', ERAFL_GAME_ADAPTER);
    const unknown = report!.diagnostics.filter((item) => item.code === 'core/event/unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.message).toContain('@织');
    // `@`=1 `织`=2 ` `=3 ⇒ 事件名从第 4 列起、半开尾 6
    expect(unknown[0]!.span).toEqual({ start: { line: 1, column: 4 }, end: { line: 1, column: 6 } });
  });

  it('反例：eraFL 自己的 `初见` / eraTW 的 `训练` 在各自方言下都不是未知事件', () => {
    expect(codesOf(lintOf('# 机 初见\n', ERAFL_GAME_ADAPTER)!.diagnostics)).not.toContain(
      'core/event/unknown',
    );
    expect(codesOf(lintOf('# 机 训练\n', ERATW_GAME_ADAPTER)!.diagnostics)).not.toContain(
      'core/event/unknown',
    );
  });

  it('未绑定不猜（§9-9）：没有 2.0 事实 ⇒ 体检交 null，零诊断', () => {
    expect(lintOf('# 机 训练\n', null)).toBeNull();
  });

  it('事件挂点只认词法行：台词正文 / 注释里的 `# 机` 不进表', () => {
    const sites = kojo2EventSitesOf(
      kojo2DocumentOf('# 机 初见\n\n> 正文里的 # 机 训练 不算。\n\n# 注释里也不算\n'),
    );
    expect(sites).toEqual([
      { name: '初见', line: 1, startColumn: 5, endColumn: 7, machine: true },
    ]);
  });
});

/* ============================== 2. 事件落点（载体） ============================== */

/** 方言 A：ERB 是这个方言的"口上"载体，但事件只在 XML 载体上校验（eraFL 的真实形状） */
const XML_EVENTS_DIALECT: GameAdapter = {
  ...ERAFL_GAME_ADAPTER,
  carriers: [
    { carrier: 'erb', glob: 'kojo/**/*.erb', validates: ['symbol', 'presentation', 'storage'] },
    { carrier: 'xml', glob: '口上/**/*.xml' },
  ],
};

/** 载体已绑定（用真解析器算，不由测试手造 binding） */
function bindingFor(dialect: GameAdapter, filePath: string) {
  return resolveDialectBinding({
    detectedDialect: dialect.id,
    factsFor: () => dialect,
    filePath,
  });
}

describe('第 2 项 · 事件落点（载体不符）', () => {
  it('正例：事件属于 xml 载体，写进 erb 文件 ⇒ `core/event/wrong-carrier`（error）', () => {
    const resolution = bindingFor(XML_EVENTS_DIALECT, 'kojo/场景.erb');
    expect(resolution.binding?.carrier).toBe('erb');
    const report = lintOf('# 机 初见\n', XML_EVENTS_DIALECT, resolution.binding);
    const wrong = report!.diagnostics.filter((item) => item.code === 'core/event/wrong-carrier');
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.severity).toBe('error');
    expect(wrong[0]!.message).toContain('xml');
    expect(wrong[0]!.message).toContain('口上/**/*.xml');
  });

  it('反例：同一个事件写进 xml 文件（该载体校验事件）⇒ 一条都不报', () => {
    const resolution = bindingFor(XML_EVENTS_DIALECT, '口上/12/会話.xml');
    expect(resolution.binding?.carrier).toBe('xml');
    const report = lintOf('# 机 初见\n', XML_EVENTS_DIALECT, resolution.binding);
    expect(report!.diagnostics).toEqual([]);
  });
});

/* ============================== 3 / 4 / 5. 复用同一次编译的诊断 ============================== */

describe('第 3–5 项 · 符号 / 只读别名 / 演出（吃同一次编译的诊断，不重算）', () => {
  it('正例：未声明的符号出现在赋值左值 ⇒ `core/expr/unknown-symbol` 进清单', () => {
    const source = '# 机 指令 310\n\n@算\n    不存在的符号 = 1\n';
    const report = lintOf(source, ERATW_GAME_ADAPTER);
    expect(codesOf(report!.diagnostics)).toContain('core/expr/unknown-symbol');
  });

  it('反例：本文件声明的变量 ⇒ 不进清单；`{她}` 这类代词由编译照常解析', () => {
    const source = '# 机 指令 310\n# 变量 结果 整数\n\n@算\n    结果 = 1\n\n> {她}。\n';
    expect(codesOf(lintOf(source, ERATW_GAME_ADAPTER)!.diagnostics)).not.toContain(
      'core/expr/unknown-symbol',
    );
  });

  it('正例：常量出现在赋值左值 ⇒ `core/expr/assign-to-constant` 进清单', () => {
    const source = '# 机 指令 310\n# 常量 亲近线 整数 = 1\n\n@算\n    亲近线 = 2\n';
    const codes = codesOf(lintOf(source, ERATW_GAME_ADAPTER)!.diagnostics);
    expect(codes.includes('core/expr/assign-to-constant') || codes.includes('core/expr/readonly-target')).toBe(true);
  });

  it('反例：常量只被读（没被写）⇒ 两条只读码都不进清单', () => {
    const source =
      '# 机 指令 310\n# 常量 亲近线 整数 = 1\n# 变量 结果 整数\n\n@算\n    结果 = 亲近线\n';
    const codes = codesOf(lintOf(source, ERATW_GAME_ADAPTER)!.diagnostics);
    expect(codes).not.toContain('core/expr/assign-to-constant');
    expect(codes).not.toContain('core/expr/readonly-target');
  });

  it('正例：eraFL 没有 `@颜绘` 演出 ⇒ `core/face/unsupported` 进清单；反例：eraTW 有 ⇒ 不进', () => {
    const source = '# 机 初见\n\n@颜绘 微笑\n';
    expect(codesOf(lintOf(source, ERAFL_GAME_ADAPTER)!.diagnostics)).toContain('core/face/unsupported');
    expect(
      codesOf(lintOf('# 机 指令 310\n\n@颜绘 微笑\n', ERATW_GAME_ADAPTER)!.diagnostics),
    ).not.toContain('core/face/unsupported');
  });

  it('清单只收七项的码：编译里的其它码（文法 / 结构 / backend 未注入）一条都不抓', () => {
    const report = lintOf('# 未知声明词 x\n', ERATW_GAME_ADAPTER);
    for (const code of codesOf(report!.diagnostics)) {
      expect(KOJO2_LINT_CODES, `${code} 不属于体检清单`).toContain(code);
    }
    expect(codesOf(report!.diagnostics)).not.toContain('core/decl/unknown');
  });
});

/* ============================== 6. 载体归属 ============================== */

describe('第 6 项 · 载体归属（文件不在任何 glob 里）', () => {
  it('正例：解析器报 `core/carrier/unowned` ⇒ 接进同一张清单，且事件面整面跳过（不猜）', () => {
    const resolution = bindingFor(XML_EVENTS_DIALECT, '别处/场景.erb');
    expect(resolution.binding?.carrier).toBeNull();
    const unowned = resolution.diagnostics.filter((item) => item.code === 'core/carrier/unowned');
    expect(unowned).toHaveLength(1);
    const report = lintOf('# 机 训练\n', XML_EVENTS_DIALECT, resolution.binding, resolution.diagnostics);
    const codes = codesOf(report!.diagnostics);
    expect(codes).toContain('core/carrier/unowned');
    // 归属不明 ⇒ 事件名不校验（既不报未知、也不报错载体）
    expect(codes).not.toContain('core/event/unknown');
    expect(codes).not.toContain('core/event/wrong-carrier');
  });

  it('反例：方言没声明 carriers ⇒ 一条归属问题都不问（也不许自己发明规则）', () => {
    const resolution = bindingFor(ERAFL_GAME_ADAPTER, '任意/路径.erb');
    const report = lintOf('# 机 初见\n', ERAFL_GAME_ADAPTER, resolution.binding, resolution.diagnostics);
    expect(codesOf(report!.diagnostics)).not.toContain('core/carrier/unowned');
  });
});

/* ============================== 7. 等待面 ============================== */

describe('第 7 项 · 等待面（缺 waitDefault 却有无「续」台词）', () => {
  const NO_WAIT_DIALECT: GameAdapter = {
    ...ERATW_GAME_ADAPTER,
    profile: { ...ERATW_GAME_ADAPTER.profile, waitDefault: undefined as never },
  };

  it('正例：`profile.waitDefault` 缺席 + 一行无「续」台词 ⇒ `core/wait/no-profile`（error，一行一条）', () => {
    const source = '# 机 指令 310\n\n> 第一行。\n> 第二行。\n';
    const report = lintOf(source, NO_WAIT_DIALECT);
    const wait = report!.diagnostics.filter((item) => item.code === 'core/wait/no-profile');
    expect(wait).toHaveLength(1); // 同一病根只报第一处，其余由聚合条数体现
    expect(wait[0]!.severity).toBe('error');
    expect(wait[0]!.span?.start.line).toBe(3);
  });

  it('反例：有 waitDefault ⇒ 一行都不报', () => {
    const source = '# 机 指令 310\n\n> 第一行。\n> 第二行。\n';
    expect(codesOf(lintOf(source, ERATW_GAME_ADAPTER)!.diagnostics)).not.toContain('core/wait/no-profile');
  });
});

/* ============================== 错配必红（§9-8） ============================== */

describe('错配必红：eraTW 的事实喂给 eraFL（§9-8）', () => {
  it('解析器先红（`core/dialect/response-mismatch`），体检拿不到任何事实', () => {
    const resolution = resolveDialectBinding({
      detectedDialect: 'erafl',
      // 登记表把 erafl 映到 eraTW 的事实上——正是"错事实不报错"的病根
      factsFor: () => ERATW_GAME_ADAPTER,
    });
    expect(resolution.kind).toBe('unbound');
    expect(resolution.binding).toBeNull();
    expect(codesOf(resolution.diagnostics)).toContain('core/dialect/response-mismatch');
    expect(severityOf('core/dialect/response-mismatch')).toBe('error');
    // 半个事实都不给 ⇒ 体检交 null（不静默通过）
    expect(
      lintKojo2Dialect({
        source: '# 机 训练\n',
        facts: resolution.binding?.facts ?? null,
        binding: resolution.binding,
        diagnostics: [],
        resolutionDiagnostics: resolution.diagnostics,
      }),
    ).toBeNull();
  });

  it('同一份文本在两个方言下的事实不同：`# 机 训练` 在 eraFL 是未知事件、在 eraTW 不是', () => {
    const source = '# 机 训练\n';
    const erafl = codesOf(lintOf(source, ERAFL_GAME_ADAPTER)!.diagnostics);
    const eratw = codesOf(lintOf(source, ERATW_GAME_ADAPTER)!.diagnostics);
    expect(erafl).toContain('core/event/unknown');
    expect(eratw).not.toContain('core/event/unknown');
  });
});

/* ============================== 聚合与呈现 ============================== */

describe('聚合去重（§5.5 呈现纪律）', () => {
  const many = (count: number): KojoDiagnostic[] =>
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        code: 'core/event/unknown' as const,
        severity: 'error' as const,
        message: '事件不在目录里。',
        span: { start: { line: index + 1, column: 5 }, end: { line: index + 1, column: 7 } },
      }),
    );

  it('同类 400 条 ⇒ 1 条汇总（count = 400、行号去重升序、消息带明细）', () => {
    const groups = aggregateKojo2DialectLint({ dialect: 'eratw', diagnostics: many(400) });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.code).toBe('core/event/unknown');
    expect(groups[0]!.dialect).toBe('eratw');
    expect(groups[0]!.severity).toBe('error');
    expect(groups[0]!.count).toBe(400);
    expect(groups[0]!.lines[0]).toBe(1);
    expect(groups[0]!.lines.at(-1)).toBe(400);
    expect(groups[0]!.message).toContain('共 400 处');
  });

  it('不同码各成一条（按 `(码, 方言)` 分桶），顺序 = 首次出现序', () => {
    const groups = aggregateKojo2DialectLint({
      dialect: 'erafl',
      diagnostics: [
        ...many(2),
        Object.freeze({
          code: 'core/carrier/unowned' as const,
          severity: 'warning' as const,
          message: '不在任何载体归属里。',
          span: null,
        }),
      ],
    });
    expect(groups.map((group) => group.code)).toEqual(['core/event/unknown', 'core/carrier/unowned']);
    expect(groups[1]!.severity).toBe('warning');
    expect(groups[1]!.lines).toEqual([]);
  });

  it('聚合行 → 问题面板的行：一条汇总一行，`code` 原样、来源可辨识、点行跳到第一处', () => {
    const groups = aggregateKojo2DialectLint({ dialect: 'erafl', diagnostics: many(3) });
    const problems = kojo2DialectLintProblems('D:/game/x.kojo2', groups);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe('D:/game/x.kojo2');
    expect(problems[0]!.line).toBe(1);
    expect(problems[0]!.code).toBe('core/event/unknown');
    expect(problems[0]!.source).toBe('Kojo 2.0 方言体检');
  });
});
