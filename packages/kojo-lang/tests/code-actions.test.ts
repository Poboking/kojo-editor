/**
 * `@kojo/kojo-lang/code-actions` 的闸（B3j，2026-10-30：一键迁移判据从宿主搬进包）。
 *
 * 覆盖：
 * 1. **每类动作正例**：裸旁白 / 裸引号 / 心形（行 + 块）/ 着色 / 随机 / 分支→`# 池` /
 *    当→`# 对照表` / 初回→`@原生` / 补 `否`（表）/ 补 `? 否`（池）/ 补 `[插槽]` / 修缩进 /
 *    语义三条（补 `# 设` / 改声明类型 / 补占位实参）；
 * 2. **应用后 parse 零 error**（表 / 池 / 模板三条另判"目标码在全链编译里消失"）；
 * 3. **不可解析就不产**：真案例 + 注入假 parse / 假 compile；
 * 4. **光标行精确**：请求行不沾诊断行 ⇒ 零动作；沾上 ⇒ 编辑区间逐字对得上；
 * 5. **与搬家前逐字相同**：`GOLDEN` 表是判据还住宿主时（B3j 改动前）跑出来的同一批
 *    输入/输出，逐条 `JSON.stringify` 对拍（见文件尾）。
 *
 * 本文件**零 Monaco**：判据只认源码 / 光标行 / 诊断。
 */
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  parseSource,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import {
  KOJO2_CODE_ACTION_CODES,
  KOJO2_CODE_ACTION_KIND_LABELS,
  kojo2CodeActionFacts,
  kojo2EditedSource,
  type Kojo2CodeActionFact,
  type Kojo2CodeActionVerifier,
} from '../src/code-actions';

const UNKNOWN = 'core/expr/unknown-symbol';
const TYPE_MISMATCH = 'core/expr/type-mismatch';
const ARG_COUNT = 'core/func/arg-count';

/* ============================== 夹具小工具 ============================== */

function diagnosticsOf(source: string): readonly KojoDiagnostic[] {
  return compileKojoSource({
    source,
    filePath: 'x.kojo2',
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }).diagnostics;
}

/** 诊断（core 真编译）+ 光标行 → 动作事实 */
function factsOf(
  source: string,
  line: number,
  extra: { readonly speaker?: string; readonly verifier?: Kojo2CodeActionVerifier } = {},
): readonly Kojo2CodeActionFact[] {
  return kojo2CodeActionFacts({ source, diagnostics: diagnosticsOf(source), line, ...extra });
}

/** 按诊断码取第一处诊断的行作为请求行（真实 `Ctrl+.` 落在波浪线上） */
function factsForCode(
  source: string,
  code: string,
  extra: { readonly verifier?: Kojo2CodeActionVerifier } = {},
): readonly Kojo2CodeActionFact[] {
  const diagnostics = diagnosticsOf(source);
  const target = diagnostics.find((diagnostic) => diagnostic.code === code);
  if (target === undefined || target.span === null) {
    throw new Error(`夹具里没有 ${code}：实际 = ${JSON.stringify(diagnostics.map((d) => d.code))}`);
  }
  return kojo2CodeActionFacts({
    source,
    diagnostics,
    line: target.span.start.line,
    ...extra,
  });
}

function parseErrors(source: string): readonly KojoDiagnostic[] {
  return parseSource(source).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

/** 断言"这条动作应用后 core parse 零 error"（并回交产物文本） */
function expectParseCleanAfter(fact: Kojo2CodeActionFact, source: string): string {
  const after = kojo2EditedSource(source, fact.edits);
  expect(parseErrors(after), `应用后仍有解析错误：${JSON.stringify(after)}`).toEqual([]);
  return after;
}

/** 应用一条动作：parse 零 error + 全链编译里目标码消失（"真的修好了"的机器判据） */
function expectCleanApply(fact: Kojo2CodeActionFact, source: string): string {
  const after = expectParseCleanAfter(fact, source);
  expect(
    diagnosticsOf(after).filter((diagnostic) => diagnostic.code === fact.code),
    `应用后目标码没有消失：${JSON.stringify(after)}`,
  ).toEqual([]);
  return after;
}

/* ============================== 1. 每类动作正例 ============================== */

describe('①裸旁白：补 `>`', () => {
  const SOURCE = '# 机 开场\n\n她点了点头。\n';

  it('产出一条 migrate 动作，编辑逐字等于 `> 她点了点头。`，应用后 parse 干净', () => {
    const facts = factsOf(SOURCE, 3);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('migrate');
    expect(KOJO2_CODE_ACTION_KIND_LABELS[fact.kind]).toBe('迁移');
    expect(fact.code).toBe('core/narrative/bare-narration');
    expect(fact.edits).toHaveLength(1);
    expect(fact.edit.range).toEqual({ startLine: 3, startColumn: 1, endLine: 3, endColumn: 7 });
    expect(fact.edit.newText).toBe('> 她点了点头。');
    expect(expectParseCleanAfter(fact, SOURCE)).toBe('# 机 开场\n\n> 她点了点头。\n');
  });

  it('缩进体里的裸旁白保持原缩进（不把旁白搬到顶层）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n    她点了点头。\n? 否\n    > b\n';
    const facts = factsOf(source, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('    > 她点了点头。');
    expect(expectParseCleanAfter(facts[0]!, source)).toContain('\n    > 她点了点头。\n');
  });

  it('光标行不沾诊断行 ⇒ 零动作（`Ctrl+.` 落在别处不该冒出一条改写）', () => {
    expect(factsOf(SOURCE, 1)).toEqual([]);
  });
});

describe('②裸引号：补说话人', () => {
  it('文件有 `# 视角` ⇒ 说话人用 `我`（§7.1 的默认说话人）', () => {
    const source = '# 机 开场\n# 视角 我\n\n「……早。」\n';
    const facts = factsOf(source, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/narrative/bare-quote');
    expect(facts[0]!.edit.newText).toBe('我：「「……早。」」');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe('# 机 开场\n# 视角 我\n\n我：「「……早。」」\n');
  });

  it('没有 `# 视角` 也没有兜底说话人 ⇒ 不产（不编一个作者没说过的名字）', () => {
    expect(factsOf('# 机 开场\n\n「……早。」\n', 3)).toEqual([]);
  });

  it('`speaker` 兜底给定时照用（宿主可从工程配置拿角色名）', () => {
    const source = '# 机 开场\n\n「……早。」\n';
    const facts = factsOf(source, 3, { speaker: '你' });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('你：「「……早。」」');
  });
});

describe('③心形：行尾 `(心形)`', () => {
  it('单行 `心形 微笑` ⇒ `> 微笑(心形)`', () => {
    const source = '# 机 开场\n\n心形 微笑\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/heart');
    expect(facts[0]!.edit.newText).toBe('> 微笑(心形)');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe('# 机 开场\n\n> 微笑(心形)\n');
  });

  it('`心形：` 块 ⇒ 摘块头 + 逐行补提示（体上提一级）', () => {
    const source = '# 机 开场\n\n心形：\n    我：「早。」\n    > 她笑了。\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.span).toEqual({ startLine: 3, endLine: 5 });
    expect(facts[0]!.edit.newText).toBe('我：「早。」(心形)\n> 她笑了。(心形)');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n我：「早。」(心形)\n> 她笑了。(心形)\n',
    );
  });

  it('块体里混入控制流 ⇒ 整块不产（说不清就不动）', () => {
    const source = '# 机 开场\n\n心形：\n    ? 数值 == 1\n        > a\n';
    expect(factsOf(source, 3)).toEqual([]);
  });
});

describe('④着色 / 随机 / 初回：整块搬 core 产物', () => {
  it('`着色 0xFF8080：` ⇒ `@着色 0xFF8080`（体原样）', () => {
    const source = '# 机 开场\n\n着色 0xFF8080：\n    我：「早。」\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/color');
    expect(facts[0]!.edit.newText).toBe('@着色 0xFF8080\n    我：「早。」');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe('# 机 开场\n\n@着色 0xFF8080\n    我：「早。」\n');
  });

  it('`随机：` ⇒ `@随机`（多行候选自动包 `@组`）', () => {
    const source = '# 机 开场\n\n随机：\n    我：「早。」\n    我：「嗨。」\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/random');
    expect(facts[0]!.edit.newText).toBe(
      '@随机\n    @组\n        我：「早。」\n    @组\n        我：「嗨。」',
    );
    expect(expectParseCleanAfter(facts[0]!, source)).toContain('@随机\n');
  });

  it('`初回：` ⇒ `@原生` 围栏（块内逐行搬、深一级）', () => {
    const source = '# 机 开场\n\n初回：\n    我：「早。」\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/ask');
    expect(facts[0]!.edit.newText).toBe('@原生\n    初回：\n        我：「早。」');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n@原生\n    初回：\n        我：「早。」\n',
    );
  });
});

describe('⑤分支 → `# 池`（提升声明 + 原处引用）', () => {
  const SOURCE =
    '# 机 开场\n# 视角 我\n\n分支：\n    [数值 < 100]\n        「早。」\n    [其他]\n        「嗨。」\n';

  it('一段合成编辑：`# 池` 声明 + `? 否` 兜底 + `! 迁移池1` 引用', () => {
    const facts = factsOf(SOURCE, 4);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.code).toBe('core/migration/branch');
    expect(fact.edits).toHaveLength(1);
    expect(fact.edit.newText).toBe(
      '# 池 迁移池1\n    ? 数值 < 100\n        我：「「早。」」\n    ? 否\n        我：「「嗨。」」\n\n! 迁移池1',
    );
    const after = expectParseCleanAfter(fact, SOURCE);
    expect(after).toContain('! 迁移池1\n');
    expect(after).not.toContain('分支：');
  });

  it('声明区在别处（正文在块前）⇒ 两段编辑：声明插进声明区、原块换成引用行', () => {
    const source =
      '# 机 开场\n# 视角 我\n\n> 前言\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n';
    const facts = factsOf(source, 6);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edits).toHaveLength(2);
    expect(fact.edits[0]!.range.startLine).toBe(4);
    expect(fact.edits[0]!.newText).toBe(
      '# 对照表 迁移表1 依据 数值\n    1 -> 早。\n    否 -> 嗨。\n\n> 前言',
    );
    expect(fact.edits[1]!.range).toEqual({ startLine: 6, startColumn: 1, endLine: 10, endColumn: 11 });
    expect(fact.edits[1]!.newText).toBe('> {迁移表1}');
    const after = expectParseCleanAfter(fact, source);
    expect(after).toBe(
      '# 机 开场\n# 视角 我\n\n# 对照表 迁移表1 依据 数值\n    1 -> 早。\n    否 -> 嗨。\n\n> 前言\n\n> {迁移表1}\n',
    );
  });

  it('声明区含 `# 方言`（单行声明）⇒ 提升的 `# 对照表` 插在它**之后**，不拆散单行声明组', () => {
    const source =
      '# 机 开场\n# 视角 我\n# 方言 erafl\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n';
    const facts = factsOf(source, 5);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edits).toHaveLength(1);
    const after = expectParseCleanAfter(fact, source);
    expect(after).toBe(
      '# 机 开场\n# 视角 我\n# 方言 erafl\n\n# 对照表 迁移表1 依据 数值\n    1 -> 早。\n    否 -> 嗨。\n\n> {迁移表1}\n',
    );
    // `# 方言` 仍在单行声明组里（不被新声明隔到后面）
    expect(after.indexOf('# 方言 erafl')).toBeLessThan(after.indexOf('# 对照表 迁移表1'));
  });

  it('`分支：` 缺兜底标签 ⇒ core 语义升级层 decline ⇒ 零动作', () => {
    const source = '# 机 开场\n# 视角 我\n\n分支：\n    [数值 < 100]\n        「早。」\n';
    expect(factsOf(source, 4)).toEqual([]);
  });
});

describe('⑥当 → `# 对照表`', () => {
  it('数值分档改写：值列 = 原分支正文，引用点写 `{表名}`', () => {
    const source = '# 机 开场\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.code).toBe('core/migration/switch');
    expect(fact.edit.newText).toBe(
      '# 对照表 迁移表1 依据 数值\n    1 -> 早。\n    否 -> 嗨。\n\n> {迁移表1}',
    );
    expect(expectParseCleanAfter(fact, source)).toContain('> {迁移表1}\n');
  });

  it('臂正文是旁白（`> …`）⇒ 表值列装不下 ⇒ 零动作', () => {
    const source = '# 机 开场\n\n当 数值：\n    是 1：\n        > 早。\n    否则：\n        > 嗨。\n';
    expect(factsOf(source, 3)).toEqual([]);
  });

  it('块嵌在 `?` 分支里 ⇒ 声明仍提升到顶层声明区、引用行留在原缩进', () => {
    const source =
      '# 机 开场\n# 视角 我\n\n? 数值 == 1\n    当 数值：\n        是 1：\n            早。\n        否则：\n            嗨。\n? 否\n    > 别的\n';
    const facts = factsOf(source, 5);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edits).toHaveLength(2);
    expect(fact.edits[0]!.range.startLine).toBe(4); // 第一条正文行 = `? 数值 == 1`
    expect(fact.edits[1]!.newText).toBe('    > {迁移表1}');
    const after = expectParseCleanAfter(fact, source);
    expect(after).toContain('\n# 对照表 迁移表1 依据 数值\n');
    expect(after).toContain('\n    > {迁移表1}\n');
  });
});

describe('⑦补 `否`：表与池', () => {
  it('`# 对照表` 缺兜底 ⇒ 追加 `否 <末行值>`（类型与原值一致）', () => {
    const source = '# 机 开场\n\n# 对照表 心情 依据 数值\n    0..99 -> 疏远\n';
    const facts = factsOf(source, 3);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(fact.code).toBe('core/table/missing-default');
    expect(fact.edit.newText).toBe('    0..99 -> 疏远\n    否 -> 疏远');
    expect(expectParseCleanAfter(fact, source)).toContain('    否 -> 疏远\n');
    expect(diagnosticsOf(kojo2EditedSource(source, fact.edits)).map((d) => d.code)).not.toContain(
      'core/table/missing-default',
    );
  });

  it('`# 池` 缺 `? 否` ⇒ 追加兜底分支（正文沿用末条分支）', () => {
    const source = '# 机 开场\n# 视角 我\n\n# 池 问候\n    ? 数值 < 100\n        「早。」\n';
    const facts = factsOf(source, 4);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(fact.code).toBe('core/pool/no-default');
    expect(fact.edit.newText).toBe('        「早。」\n    ? 否\n        「早。」');
    const after = expectParseCleanAfter(fact, source);
    expect(diagnosticsOf(after).map((d) => d.code)).not.toContain('core/pool/no-default');
  });
});

describe('⑧补 `[插槽]`（模板）', () => {
  it('调用处有缩进块、模板没声明 `[插槽]` ⇒ 在模板体末尾补一行', () => {
    const source =
      '# 机 开场\n\n# 模 娇羞()\n    > （她红着脸）\n\n! 娇羞()\n    我：「才没有！」\n';
    const facts = factsOf(source, 6);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(fact.code).toBe('core/template/unexpected-slot');
    expect(fact.edit.newText).toBe('    > （她红着脸）\n    [插槽]');
    const after = expectParseCleanAfter(fact, source);
    expect(after).toContain('    [插槽]\n');
    expect(diagnosticsOf(after).map((d) => d.code)).not.toContain('core/template/unexpected-slot');
  });
});

describe('⑨修缩进：按层级归到 4 空格倍数', () => {
  it('链头 `? 否` 缩了 2 格 ⇒ 回到链头层级（0）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n    > a\n  ? 否\n    > b\n';
    const facts = factsOf(source, 5);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('indent');
    expect(fact.code).toBe('core/lex/indent');
    expect(fact.edit.newText).toBe('? 否');
    expect(expectParseCleanAfter(fact, source)).toBe(
      '# 机 开场\n\n? 数值 == 1\n    > a\n? 否\n    > b\n',
    );
  });

  it('分支体缩了 2 格 ⇒ 补到一级（4）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n  > a\n? 否\n    > b\n';
    const facts = factsOf(source, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('    > a');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n? 数值 == 1\n    > a\n? 否\n    > b\n',
    );
  });

  it('缩了 6 格（一级半）⇒ 归到一级', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const facts = factsOf(source, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('    > a');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n? 数值 == 1\n    > a\n? 否\n    > b\n',
    );
  });

  it('同一行报两条同码诊断也只出一条动作（💡 里不出现两条一样的修复）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    expect(diagnosticsOf(source).filter((d) => d.code === 'core/lex/indent')).toHaveLength(2);
    expect(factsOf(source, 4)).toHaveLength(1);
  });
});

/* ============================== 2. 不可解析就不产 ============================== */

describe('⑩不可解析就不产', () => {
  it('注入假 parse：改后冒出改前没有的错误码 ⇒ 否决（不产）', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const verifier: Kojo2CodeActionVerifier = {
      parse: (text) =>
        text.includes('> 她点了点头。')
          ? [
              {
                code: 'core/lex/anchor',
                severity: 'error',
                message: '桩：改完也解析不了',
                span: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } },
              },
            ]
          : [],
      compile: () => [],
    };
    expect(factsOf(source, 3, { verifier })).toEqual([]);
  });

  it('注入假 parse：解析器直接抛 ⇒ 否决（错误不外抛给 Monaco）', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const verifier: Kojo2CodeActionVerifier = {
      parse: () => {
        throw new Error('桩：解析器炸了');
      },
      compile: () => [],
    };
    expect(factsOf(source, 3, { verifier })).toEqual([]);
  });

  it('目标码在改动区间里没消失（假 compile 仍报 missing-default）⇒ 否决', () => {
    const source = '# 机 开场\n\n# 对照表 心情 依据 数值\n    0..99 -> 疏远\n';
    const verifier: Kojo2CodeActionVerifier = {
      parse: () => [],
      compile: () => [
        {
          code: 'core/table/missing-default',
          severity: 'error',
          message: '桩：还是缺兜底',
          span: { start: { line: 3, column: 1 }, end: { line: 4, column: 12 } },
        },
      ],
    };
    expect(factsOf(source, 3, { verifier })).toEqual([]);
  });

  it('光标行缺省 / 越界 ⇒ 一条都不产（位置未知就不猜）', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const diagnostics = diagnosticsOf(source);
    expect(kojo2CodeActionFacts({ source, diagnostics })).toEqual([]);
    expect(kojo2CodeActionFacts({ source, diagnostics, line: 0 })).toEqual([]);
    expect(kojo2CodeActionFacts({ source, diagnostics, line: Number.NaN })).toEqual([]);
  });
});

/* ============================== 3. 诊断关联与筛选 ============================== */

describe('⑪诊断关联 / 码筛选 / 空 span', () => {
  const SOURCE = '# 机 开场\n\n她点了点头。\n';

  it('`fact.diagnostics` 是**同一批对象引用**（宿主据此画关联高亮）', () => {
    const diagnostics = diagnosticsOf(SOURCE);
    const facts = kojo2CodeActionFacts({ source: SOURCE, diagnostics, line: 3 });
    expect(facts[0]!.diagnostics).toHaveLength(1);
    expect(facts[0]!.diagnostics[0]).toBe(diagnostics[0]);
  });

  it('不在认领清单里的诊断码 ⇒ 零动作', () => {
    const diagnostics: KojoDiagnostic[] = [
      {
        code: 'core/decl/missing-machine',
        severity: 'error',
        message: '桩',
        span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
    ];
    expect(kojo2CodeActionFacts({ source: SOURCE, diagnostics, line: 1 })).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/decl/missing-machine')).toBe(false);
  });

  it('缺 span 的诊断 ⇒ 零动作（没有落点就没法定位构造）', () => {
    const diagnostics: KojoDiagnostic[] = [
      { code: 'core/narrative/bare-narration', severity: 'error', message: '桩', span: null },
    ];
    expect(kojo2CodeActionFacts({ source: SOURCE, diagnostics, line: 3 })).toEqual([]);
  });

  it('同一条诊断传两遍 ⇒ 只出一条动作（去重键 = 类别 + 编辑内容）', () => {
    const diagnostics = diagnosticsOf(SOURCE);
    const facts = kojo2CodeActionFacts({
      source: SOURCE,
      diagnostics: [diagnostics[0]!, diagnostics[0]!],
      line: 3,
    });
    expect(facts).toHaveLength(1);
  });
});

/* ============================== 4. 语义诊断三条 ============================== */

describe('⑫unknown-symbol：声明区补 `# 设`', () => {
  const SOURCE = '# 机 开场\n\n@算\n    临时 = 1\n';

  it('整数字面量右侧 ⇒ 声明 `整数`，插在 `# 机` 之后的声明区，应用后 parse 零 error 且码消失', () => {
    const facts = factsForCode(SOURCE, UNKNOWN);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(KOJO2_CODE_ACTION_KIND_LABELS[fact.kind]).toBe('补全');
    expect(fact.code).toBe(UNKNOWN);
    expect(fact.edits).toHaveLength(1);
    expect(fact.edit.range).toEqual({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 });
    expect(fact.edit.newText).toBe('# 设 临时 整数\n');
    expect(fact.title).toContain('# 设 临时 整数');
    expect(expectCleanApply(fact, SOURCE)).toBe(
      '# 机 开场\n# 设 临时 整数\n\n@算\n    临时 = 1\n',
    );
  });

  it('字符串字面量右侧 ⇒ 声明 `字符串`（不把已知类型硬写成整数）', () => {
    const source = '# 机 开场\n\n@算\n    名字 = "甲"\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 设 名字 字符串\n');
    expectCleanApply(facts[0]!, source);
  });

  it('类型不可知（右侧不是字面量）⇒ 默认整数，标题写明"按整数声明，请按需改类型"', () => {
    const source = '# 机 开场\n\n@算\n    临时 = 数量\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 设 临时 整数\n');
    expect(facts[0]!.title).toContain('按整数声明，请按需改类型');
    expectCleanApply(facts[0]!, source);
  });

  it('`# 幕` / `# 视角` / `# 设` 混排 ⇒ 插到最后一条单行声明之后、`# 幕`（正文块）之前', () => {
    const source =
      '# 机 开场\n# 视角 我\n# 设 甲 整数 = 1\n# 幕 一\n\n@算\n    临时 = 1\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edit.range).toEqual({ startLine: 4, startColumn: 1, endLine: 4, endColumn: 6 });
    expect(fact.edit.newText).toBe('# 设 临时 整数\n\n# 幕 一');
    const after = expectCleanApply(fact, source);
    expect(after).toContain('# 设 甲 整数 = 1\n# 设 临时 整数\n\n# 幕 一\n');
    expect(after.indexOf('# 设 临时 整数')).toBeLessThan(after.indexOf('# 幕 一'));
  });

  it('`@织` 块声明在声明区之后 ⇒ 插在 `@织` 之前并保留块声明前的空行', () => {
    const source = '# 机 开场\n# 视角 我\n\n@织 收场\n    @算\n        临时 = 1\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edit.range).toEqual({ startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 });
    expect(fact.edit.newText).toBe('# 设 临时 整数\n');
    const after = expectCleanApply(fact, source);
    expect(after).toContain('# 视角 我\n# 设 临时 整数\n\n@织 收场\n');
  });

  it('同一名字已在文件里声明 ⇒ 不产（改名 / 拼写机器不猜）', () => {
    const source = '# 设 临时 整数\n# 机 开场\n\n@算\n    临时 = 1\n';
    const diagnostics: KojoDiagnostic[] = [
      {
        code: UNKNOWN,
        severity: 'error',
        message: '桩：已声明却仍报 unknown（手工构造）',
        span: { start: { line: 5, column: 5 }, end: { line: 5, column: 7 } },
      },
    ];
    expect(kojo2CodeActionFacts({ source, diagnostics, line: 5 })).toEqual([]);
  });

  it('目标不是单个名字（`{角色}的<属性>`）⇒ 不产（补 `# 设` 修不了）', () => {
    const source = '# 机 开场\n\n@算\n    {我}的幻想 = 1\n';
    expect(factsForCode(source, UNKNOWN)).toEqual([]);
  });

  it('目标不是单个名字（未声明数组的 `名[下标]`）⇒ 不产', () => {
    const source = '# 机 开场\n\n@算\n    队伍[0] = 1\n';
    expect(factsForCode(source, UNKNOWN)).toEqual([]);
  });

  it('同一条诊断传两遍 ⇒ 只出一条动作', () => {
    const diagnostics = diagnosticsOf(SOURCE);
    const facts = kojo2CodeActionFacts({
      source: SOURCE,
      diagnostics: [diagnostics[0]!, diagnostics[0]!],
      line: 4,
    });
    expect(facts).toHaveLength(1);
  });

  it('假 compile 改后仍报目标码 ⇒ 否决（不产）', () => {
    const verifier: Kojo2CodeActionVerifier = {
      parse: () => [],
      compile: () => [
        {
          code: UNKNOWN,
          severity: 'error',
          message: '桩：补了声明还是未知',
          span: { start: { line: 1, column: 1 }, end: { line: 20, column: 1 } },
        },
      ],
    };
    expect(factsForCode(SOURCE, UNKNOWN, { verifier })).toEqual([]);
  });
});

describe('⑬type-mismatch：`# 设` 声明类型二选一', () => {
  it('字符串声明 + 整数字面量右侧 ⇒ 只留"改成整数"，应用后码消失', () => {
    const source = '# 设 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('fix');
    expect(KOJO2_CODE_ACTION_KIND_LABELS.fix).toBe('修复');
    expect(fact.title).toContain('把 `名` 的声明类型改成整数');
    expect(fact.edit.newText).toBe('# 设 名 整数');
    expect(expectCleanApply(fact, source)).toBe(
      '# 设 名 整数\n# 机 开场\n\n@算\n    名 = 1\n',
    );
  });

  it('声明行尾还有存储期 ⇒ 只换类型 token，尾部原样保留', () => {
    const source = '# 设 名 字符串 场景\n# 机 开场\n\n@算\n    名 = 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 设 名 整数 场景');
    expectCleanApply(facts[0]!, source);
  });

  it('增量运算 `+=` 打在字符串变量上 + 整数字面量 ⇒ 同样把声明改成整数', () => {
    const source = '# 设 数 字符串\n# 机 开场\n\n@算\n    数 += 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 设 数 整数');
    expectCleanApply(facts[0]!, source);
  });

  it('改类型会破坏声明初值（`= "甲"`）⇒ 两条候选都被收口否决，零动作', () => {
    const source = '# 设 名 字符串 = "甲" 场景\n# 机 开场\n\n@算\n    名 = 1\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('右侧不是整数字面量（字符串字面量）⇒ 按任务口径不产', () => {
    const source = '# 设 数 整数\n# 机 开场\n\n@算\n    数 = "甲"\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('右侧不是字面量（变量）⇒ 不产', () => {
    const source = '# 设 数 整数\n# 设 名 字符串\n# 机 开场\n\n@算\n    名 = 数\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('改类型会把另一处旧赋值写成新的同类错误（`名 = "x"`）⇒ 计数闸否决，零动作', () => {
    const source = '# 设 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n    名 = "甲"\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('诊断落在函数实参上（不是 `# 设` 赋值左侧）⇒ 不产', () => {
    const source = '@函 称呼(名字 = "甲")\n    @返 名字\n\n# 机 开场\n\n! 称呼(1)\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });
});

describe('⑭arg-count：缺必填补占位实参', () => {
  const INT_DEFAULT = '@函 加(甲, 乙=2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加()\n';

  it('缺 1 个必填 + 形参默认值全是整数 ⇒ 补 `0`，应用后码消失', () => {
    const facts = factsForCode(INT_DEFAULT, ARG_COUNT);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(fact.title).toContain('补 1 个必填实参');
    expect(fact.edit.newText).toBe('! 加(0)');
    expect(expectCleanApply(fact, INT_DEFAULT)).toContain('\n! 加(0)\n');
  });

  it('形参默认值全是字符串 ⇒ 占位 `""`', () => {
    const source = '@函 问候(称呼, 尾巴 = "。")\n    @返 称呼\n\n# 机 开场\n\n! 问候()\n';
    const facts = factsForCode(source, ARG_COUNT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('! 问候("")');
    expectCleanApply(facts[0]!, source);
  });

  it('缺多个必填（中间/尾部有默认值）⇒ 按缺口个数补多个占位', () => {
    const source = '@函 混(甲 = 1, 丙)\n    @返 丙\n\n# 机 开场\n\n! 混()\n';
    const facts = factsForCode(source, ARG_COUNT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('! 混(0, 0)');
    expectCleanApply(facts[0]!, source);
  });

  it('调用没写括号 ⇒ 补成 `! 名(占位)`（仍是整行替换）', () => {
    const source = '@函 加(甲, 乙 = 2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加\n';
    const facts = factsForCode(source, ARG_COUNT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('! 加(0)');
    expectCleanApply(facts[0]!, source);
  });

  it('形参没有任何默认值 ⇒ 类型无法判定，不产', () => {
    const source = '@函 两(甲, 乙)\n    @返 甲\n\n# 机 开场\n\n! 两()\n';
    expect(factsForCode(source, ARG_COUNT)).toEqual([]);
  });

  it('形参默认值类型混杂（整数 + 字符串）⇒ 无法判定，不产', () => {
    const source = '@函 混(甲 = 1, 乙 = "x", 丙)\n    @返 丙\n\n# 机 开场\n\n! 混()\n';
    expect(factsForCode(source, ARG_COUNT)).toEqual([]);
  });

  it('实参多给 ⇒ 不产（删参危险）', () => {
    const source = '@函 加(甲, 乙 = 2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加(1, 2, 3)\n';
    expect(factsForCode(source, ARG_COUNT)).toEqual([]);
  });
});

describe('⑮显式不产：readonly-target / index-out-of-range / bad-index', () => {
  it('`readonly-target` 零动作且不在认领清单（需要作者决策）', () => {
    const source = '# 机 开场\n\n@算\n    外部上限 = 1\n';
    expect(factsForCode(source, 'core/expr/readonly-target')).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/expr/readonly-target')).toBe(false);
  });

  it('`index-out-of-range` 零动作且不在认领清单（可能想改下标本身）', () => {
    const source = '# 设 队列 整数[3]\n# 机 开场\n\n@算\n    队列[5] = 1\n';
    expect(factsForCode(source, 'core/expr/index-out-of-range')).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/expr/index-out-of-range')).toBe(false);
  });

  it('`bad-index` 零动作且不在认领清单（可能想改下标 / 补数组声明）', () => {
    const source = '# 设 数 整数\n# 机 开场\n\n@算\n    数[0] = 1\n';
    expect(factsForCode(source, 'core/expr/bad-index')).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/expr/bad-index')).toBe(false);
  });

  it('三条可产的语义码都在认领清单里', () => {
    for (const code of [UNKNOWN, TYPE_MISMATCH, ARG_COUNT]) {
      expect(KOJO2_CODE_ACTION_CODES.has(code), code).toBe(true);
    }
  });
});

/* ============================== 5. 应用后 parse 零 error（总闸） ============================== */

describe('⑯逐类动作：应用后 core parse 零 error', () => {
  const CASES: readonly { readonly name: string; readonly source: string; readonly line: number }[] = [
    { name: '裸旁白', source: '# 机 开场\n\n她点了点头。\n', line: 3 },
    { name: '裸引号', source: '# 机 开场\n# 视角 我\n\n「……早。」\n', line: 4 },
    { name: '心形行', source: '# 机 开场\n\n心形 微笑\n', line: 3 },
    { name: '心形块', source: '# 机 开场\n\n心形：\n    我：「早。」\n', line: 3 },
    { name: '着色块', source: '# 机 开场\n\n着色 0xFF8080：\n    我：「早。」\n', line: 3 },
    { name: '随机块', source: '# 机 开场\n\n随机：\n    我：「早。」\n    我：「嗨。」\n', line: 3 },
    {
      name: '分支池',
      source: '# 机 开场\n# 视角 我\n\n分支：\n    [数值 < 100]\n        「早。」\n    [其他]\n        「嗨。」\n',
      line: 4,
    },
    { name: '当表', source: '# 机 开场\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n', line: 3 },
    { name: '初回原生', source: '# 机 开场\n\n初回：\n    我：「早。」\n', line: 3 },
    { name: '补否（表）', source: '# 机 开场\n\n# 对照表 心情 依据 数值\n    0..99 -> 疏远\n', line: 3 },
    {
      name: '补否（池）',
      source: '# 机 开场\n# 视角 我\n\n# 池 问候\n    ? 数值 < 100\n        「早。」\n',
      line: 4,
    },
    {
      name: '补插槽',
      source: '# 机 开场\n\n# 模 娇羞()\n    > （她红着脸）\n\n! 娇羞()\n    我：「才没有！」\n',
      line: 6,
    },
    { name: '修缩进（链头）', source: '# 机 开场\n\n? 数值 == 1\n    > a\n  ? 否\n    > b\n', line: 5 },
    { name: '修缩进（体）', source: '# 机 开场\n\n? 数值 == 1\n  > a\n? 否\n    > b\n', line: 4 },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name}：产动作且应用后 parse 零 error`, () => {
      const facts = factsOf(testCase.source, testCase.line);
      expect(facts.length, `${testCase.name} 没有产出动作`).toBeGreaterThan(0);
      for (const fact of facts) expectParseCleanAfter(fact, testCase.source);
    });
  }

  it('修缩进后**整篇**零 error（含表 / 池 / 模板三条编译期判据）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const facts = factsOf(source, 4);
    const after = kojo2EditedSource(source, facts[0]!.edits);
    expect(parseErrors(after)).toEqual([]);
    expect(diagnosticsOf(after).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

/* ============================== 6. 与搬家前逐字对拍 ============================== */

/**
 * **A/B 金表**：这 18 条输入在 B3j 之前跑的是宿主 `kojo2-code-actions.ts`（判据还住那里），
 * 输出被逐条抄下来；判据搬进本包之后，同一批输入必须给出**逐字相同**的
 * `{kind,title,code,span,edits}`（`JSON.stringify` 对拍）。
 *
 * 为什么不拿"看起来对"当验收：搬家的危险不是写错逻辑，而是**悄悄改了某条规则的边界**
 * （例如插入点的空行、标题里的片段截断、`refactor` 与 `quickfix` 的分档）。
 * 覆盖全部 15 个认领码。
 */
const GOLDEN: readonly {
  readonly name: string;
  readonly source: string;
  readonly line: number;
  readonly facts: readonly unknown[];
}[] = [
  {
    name: "裸旁白",
    source: "# 机 开场\n\n她点了点头。\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "补旁白锚点 `>`：> 她点了点头。",
          "code": "core/narrative/bare-narration",
          "span": {
            "startLine": 3,
            "endLine": 3
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 3,
                "endColumn": 7
              },
              "newText": "> 她点了点头。"
            }
          ]
        }
      ],
  },
  {
    name: "裸引号",
    source: "# 机 开场\n# 视角 我\n\n「……早。」\n",
    line: 4,
    facts: [
        {
          "kind": "migrate",
          "title": "补说话人 `我`：我：「「……早。」」",
          "code": "core/narrative/bare-quote",
          "span": {
            "startLine": 4,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 4,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 7
              },
              "newText": "我：「「……早。」」"
            }
          ]
        }
      ],
  },
  {
    name: "心形行",
    source: "# 机 开场\n\n心形 微笑\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "心形 → 行尾 `(心形)`：> 微笑(心形)",
          "code": "core/migration/heart",
          "span": {
            "startLine": 3,
            "endLine": 3
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 3,
                "endColumn": 6
              },
              "newText": "> 微笑(心形)"
            }
          ]
        }
      ],
  },
  {
    name: "心形块",
    source: "# 机 开场\n\n心形：\n    我：「早。」\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "心形块 → 行尾 `(心形)`（第 3–4 行）",
          "code": "core/migration/heart",
          "span": {
            "startLine": 3,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 11
              },
              "newText": "我：「早。」(心形)"
            }
          ]
        }
      ],
  },
  {
    name: "着色块",
    source: "# 机 开场\n\n着色 0xFF8080：\n    我：「早。」\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "`着色` 块 → `@着色`（第 3–4 行）",
          "code": "core/migration/color",
          "span": {
            "startLine": 3,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 11
              },
              "newText": "@着色 0xFF8080\n    我：「早。」"
            }
          ]
        }
      ],
  },
  {
    name: "随机块",
    source: "# 机 开场\n\n随机：\n    我：「早。」\n    我：「嗨。」\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "`随机：` / `组：` → `@随机` / `@组`（第 3–5 行）",
          "code": "core/migration/random",
          "span": {
            "startLine": 3,
            "endLine": 5
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 5,
                "endColumn": 11
              },
              "newText": "@随机\n    @组\n        我：「早。」\n    @组\n        我：「嗨。」"
            }
          ]
        }
      ],
  },
  {
    name: "分支池",
    source: "# 机 开场\n# 视角 我\n\n分支：\n    [数值 < 100]\n        「早。」\n    [其他]\n        「嗨。」\n",
    line: 4,
    facts: [
        {
          "kind": "migrate",
          "title": "`分支：` → `# 池 迁移池1`（第 4–8 行）",
          "code": "core/migration/branch",
          "span": {
            "startLine": 4,
            "endLine": 8
          },
          "edits": [
            {
              "range": {
                "startLine": 4,
                "startColumn": 1,
                "endLine": 8,
                "endColumn": 13
              },
              "newText": "# 池 迁移池1\n    ? 数值 < 100\n        我：「「早。」」\n    ? 否\n        我：「「嗨。」」\n\n! 迁移池1"
            }
          ]
        }
      ],
  },
  {
    name: "当表",
    source: "# 机 开场\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "`当` → `# 对照表 迁移表1`（第 3–7 行）",
          "code": "core/migration/switch",
          "span": {
            "startLine": 3,
            "endLine": 7
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 7,
                "endColumn": 11
              },
              "newText": "# 对照表 迁移表1 依据 数值\n    1 -> 早。\n    否 -> 嗨。\n\n> {迁移表1}"
            }
          ]
        }
      ],
  },
  {
    name: "初回原生",
    source: "# 机 开场\n\n初回：\n    我：「早。」\n",
    line: 3,
    facts: [
        {
          "kind": "migrate",
          "title": "`初回 / 询问 / 确认` → `@原生`（第 3–4 行）",
          "code": "core/migration/ask",
          "span": {
            "startLine": 3,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 3,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 11
              },
              "newText": "@原生\n    初回：\n        我：「早。」"
            }
          ]
        }
      ],
  },
  {
    name: "补否（表）",
    source: "# 机 开场\n\n# 对照表 心情 依据 数值\n    0..99 -> 疏远\n",
    line: 3,
    facts: [
        {
          "kind": "complete",
          "title": "补兜底行 `否 疏远`（表「心情」）",
          "code": "core/table/missing-default",
          "span": {
            "startLine": 4,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 4,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 16
              },
              "newText": "    0..99 -> 疏远\n    否 -> 疏远"
            }
          ]
        }
      ],
  },
  {
    name: "补否（池）",
    source: "# 机 开场\n# 视角 我\n\n# 池 问候\n    ? 数值 < 100\n        「早。」\n",
    line: 4,
    facts: [
        {
          "kind": "complete",
          "title": "补兜底分支 `? 否`（池「问候」，正文沿用末条分支）",
          "code": "core/pool/no-default",
          "span": {
            "startLine": 6,
            "endLine": 6
          },
          "edits": [
            {
              "range": {
                "startLine": 6,
                "startColumn": 1,
                "endLine": 6,
                "endColumn": 13
              },
              "newText": "        「早。」\n    ? 否\n        「早。」"
            }
          ]
        }
      ],
  },
  {
    name: "补插槽",
    source: "# 机 开场\n\n# 模 娇羞()\n    > （她红着脸）\n\n! 娇羞()\n    我：「才没有！」\n",
    line: 6,
    facts: [
        {
          "kind": "complete",
          "title": "补 `[插槽]`（模板「娇羞」）",
          "code": "core/template/unexpected-slot",
          "span": {
            "startLine": 4,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 4,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 13
              },
              "newText": "    > （她红着脸）\n    [插槽]"
            }
          ]
        }
      ],
  },
  {
    name: "修缩进（链头）",
    source: "# 机 开场\n\n? 数值 == 1\n    > a\n  ? 否\n    > b\n",
    line: 5,
    facts: [
        {
          "kind": "indent",
          "title": "缩进改为 0 空格（第 5 行）",
          "code": "core/lex/indent",
          "span": {
            "startLine": 5,
            "endLine": 5
          },
          "edits": [
            {
              "range": {
                "startLine": 5,
                "startColumn": 1,
                "endLine": 5,
                "endColumn": 6
              },
              "newText": "? 否"
            }
          ]
        }
      ],
  },
  {
    name: "修缩进（体）",
    source: "# 机 开场\n\n? 数值 == 1\n  > a\n? 否\n    > b\n",
    line: 4,
    facts: [
        {
          "kind": "indent",
          "title": "缩进改为 4 空格（第 4 行）",
          "code": "core/lex/indent",
          "span": {
            "startLine": 4,
            "endLine": 4
          },
          "edits": [
            {
              "range": {
                "startLine": 4,
                "startColumn": 1,
                "endLine": 4,
                "endColumn": 6
              },
              "newText": "    > a"
            }
          ]
        }
      ],
  },
  {
    name: "unknown-symbol（整数）",
    source: "# 机 开场\n\n@算\n    临时 = 1\n",
    line: 4,
    facts: [
        {
          "kind": "complete",
          "title": "新增 `# 设 临时 整数`（按赋值右侧整数字面量推断，可再改）",
          "code": "core/expr/unknown-symbol",
          "span": {
            "startLine": 2,
            "endLine": 2
          },
          "edits": [
            {
              "range": {
                "startLine": 2,
                "startColumn": 1,
                "endLine": 2,
                "endColumn": 1
              },
              "newText": "# 设 临时 整数\n"
            }
          ]
        }
      ],
  },
  {
    name: "unknown-symbol（字符串）",
    source: "# 机 开场\n\n@算\n    名字 = \"甲\"\n",
    line: 4,
    facts: [
        {
          "kind": "complete",
          "title": "新增 `# 设 名字 字符串`（按赋值右侧字符串字面量推断，可再改）",
          "code": "core/expr/unknown-symbol",
          "span": {
            "startLine": 2,
            "endLine": 2
          },
          "edits": [
            {
              "range": {
                "startLine": 2,
                "startColumn": 1,
                "endLine": 2,
                "endColumn": 1
              },
              "newText": "# 设 名字 字符串\n"
            }
          ]
        }
      ],
  },
  {
    name: "type-mismatch",
    source: "# 机 开场\n# 设 名 字符串\n\n@算\n    名 = 1\n",
    line: 5,
    facts: [
        {
          "kind": "fix",
          "title": "把 `名` 的声明类型改成整数（第 2 行）",
          "code": "core/expr/type-mismatch",
          "span": {
            "startLine": 2,
            "endLine": 2
          },
          "edits": [
            {
              "range": {
                "startLine": 2,
                "startColumn": 1,
                "endLine": 2,
                "endColumn": 10
              },
              "newText": "# 设 名 整数"
            }
          ]
        }
      ],
  },
  {
    name: "arg-count",
    source: "# 机 开场\n\n@函 招呼(名, 次=3)\n    我：「早。」\n\n! 招呼()\n",
    line: 6,
    facts: [
        {
          "kind": "complete",
          "title": "补 1 个必填实参（占位 `0`，按形参默认值类型，第 6 行）",
          "code": "core/func/arg-count",
          "span": {
            "startLine": 6,
            "endLine": 6
          },
          "edits": [
            {
              "range": {
                "startLine": 6,
                "startColumn": 1,
                "endLine": 6,
                "endColumn": 7
              },
              "newText": "! 招呼(0)"
            }
          ]
        }
      ],
  },
];

describe('⑰与搬家前逐字相同（A/B 金表）', () => {
  for (const entry of GOLDEN) {
    it(entry.name + "：动作数组逐字相同", () => {
      const facts = factsOf(entry.source, entry.line);
      // 只比"动作描述"这五格：`diagnostics` 是输入对象的引用（宿主要它画关联高亮），
      // 不在 A/B 口径里（它由同一个输入直接穿透，没有可漂的中间层）。
      const actual = facts.map((fact) => ({
        kind: fact.kind,
        title: fact.title,
        code: fact.code,
        span: fact.span,
        edits: fact.edits.map((edit) => ({ range: edit.range, newText: edit.newText })),
      }));
      expect(actual, entry.name + " 与搬家前的输出不同（判据漂了）").toEqual(entry.facts);
    });
  }
});
