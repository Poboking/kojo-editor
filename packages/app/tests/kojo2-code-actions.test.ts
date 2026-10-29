// @vitest-environment happy-dom
/**
 * K2-CODE-ACTIONS · Kojo 2.0 一键迁移 code action 的闸（K2 batch-5，设计稿 §16.7 U6.4）。
 *
 * 覆盖六件事：
 * 1. **每类动作正例**：裸旁白 / 裸引号 / 心形（行 + 块）/ 着色 / 随机 / 分支→`# 池` /
 *    当→`# 对照表` / 初回→`@原生` / 补 `否`（表）/ 补 `? 否`（池）/ 补 `[插槽]` / 修缩进；
 * 2. **应用后 parse 零 error**：逐条把编辑应用到源码上，core `parseSource` 必须干净
 *    （这是"动作真的把这条诊断修好了"的机器判据）；
 * 3. **不可解析就不产**：真案例（`分支：` 缺兜底 / `当` 臂是旁白 / 心形块混入控制流）+
 *    注入假 parse（改后报新错 / 直接抛）两条；
 * 4. **区间精确**：请求区间不沾诊断行 ⇒ 零动作；沾上 ⇒ 动作的 `edit.range` / `span` 逐字对得上；
 * 5. **注册纪律**：flag 关 ⇒ 零注册；flag 开 ⇒ 恰好一枚 provider + 一条命令、selector 只有
 *    `kojo2`；半途抛错回滚；v1 语言面零动作；dispose 幂等；
 * 6. **停点复用**：命令落地走宿主注入的 `applyEdits`；宿主把它接到**同一枚** `applyTextEdits`
 *    ——真 model 上断言调用序 `pushUndoStop → executeEdits → pushUndoStop`（假 editor 转发桩，
 *    与 `code-action-undo-stack.test.ts` 同一手法），外加源码钉子（宿主接线在 flag 块里、
 *    本层不出现 `executeEdits`）。
 *
 * 假 Monaco 只实现被真正用到的那几格（`registerCodeActionProvider` / `registerCommand` /
 * `getModel` / `Uri.parse` / `MarkerSeverity`）；诊断一律由 core 真编译产出，不在测试里手写
 * 一份"假波浪线"。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  parseSource,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import type { EditorTextEdit } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import { kojo2DiagnosticsToMarkers } from '../src/monaco/kojo2-diagnostics';
import {
  KOJO2_CODE_ACTION_CODES,
  KOJO2_CODE_ACTION_COMMAND,
  KOJO2_CODE_ACTION_KIND_LABELS,
  KOJO2_PROVIDED_CODE_ACTION_KINDS,
  installKojo2CodeActionProvider,
  kojo2CodeActionFacts,
  kojo2CodeActionKindOf,
  kojo2CodeActionsOf,
  kojo2DiagnosticsFromMarkers,
  kojo2EditedSource,
  kojo2EditorEditsOf,
  type Kojo2CodeActionFact,
  type Kojo2CodeActionRange,
  type Kojo2CodeActionVerifier,
} from '../src/monaco/kojo2-code-actions';
import { applyTextEdits } from '../src/ui/editor-global-providers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';
/**
 * LAU-3 起缺省档是 `2.0-default`（切流语义**开着**）⇒ "flag 关"不再等于"没存过"。
 * 关 = 盘上显式一份 `v1-only` 计划（真源是阶段，不是旧布尔键）。
 */
const KOJO2_PLAN_KEY = 'kojo.ui.kojo2Cutover.plan.v1';
const KOJO2_OFF_PLAN = JSON.stringify({ version: 2, stage: 'v1-only', overrides: {} });

/* ============================== 夹具小工具 ============================== */

/** 诊断（core 真编译）+ 请求区间 → 动作事实 */
function factsOf(
  source: string,
  from: number,
  to: number,
  extra: { readonly speaker?: string; readonly verifier?: Kojo2CodeActionVerifier } = {},
): readonly Kojo2CodeActionFact[] {
  const diagnostics = diagnosticsOf(source);
  return kojo2CodeActionFacts({
    source,
    diagnostics,
    range: rangeOf(from, to),
    ...extra,
  });
}

function diagnosticsOf(source: string): readonly KojoDiagnostic[] {
  return compileKojoSource({
    source,
    filePath: 'x.kojo2',
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }).diagnostics;
}

function rangeOf(from: number, to: number): Kojo2CodeActionRange {
  return { startLine: from, startColumn: 1, endLine: to, endColumn: 1 };
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

/* ============================== 1. 每类动作正例 ============================== */

describe('①裸旁白：补 `>`', () => {
  const SOURCE = '# 机 开场\n\n她点了点头。\n';

  it('产出一条 migrate 动作，编辑逐字等于 `> 她点了点头。`，应用后 parse 干净', () => {
    const facts = factsOf(SOURCE, 3, 3);
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
    const facts = factsOf(source, 4, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('    > 她点了点头。');
    expect(expectParseCleanAfter(facts[0]!, source)).toContain('\n    > 她点了点头。\n');
  });

  it('区间不沾诊断行 ⇒ 零动作（`Ctrl+.` 落在别处不该冒出一条改写）', () => {
    expect(factsOf(SOURCE, 1, 1)).toEqual([]);
  });
});

describe('②裸引号：补说话人', () => {
  it('文件有 `# 视角` ⇒ 说话人用 `我`（§7.1 的默认说话人）', () => {
    const source = '# 机 开场\n# 视角 我\n\n「……早。」\n';
    const facts = factsOf(source, 4, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/narrative/bare-quote');
    expect(facts[0]!.edit.newText).toBe('我：「「……早。」」');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe('# 机 开场\n# 视角 我\n\n我：「「……早。」」\n');
  });

  it('没有 `# 视角` 也没有兜底说话人 ⇒ 不产（不编一个作者没说过的名字）', () => {
    expect(factsOf('# 机 开场\n\n「……早。」\n', 3, 3)).toEqual([]);
  });

  it('`speaker` 兜底给定时照用（宿主可从工程配置拿角色名）', () => {
    const source = '# 机 开场\n\n「……早。」\n';
    const facts = factsOf(source, 3, 3, { speaker: '你' });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('你：「「……早。」」');
  });
});

describe('③心形：行尾 `(心形)`', () => {
  it('单行 `心形 微笑` ⇒ `> 微笑(心形)`', () => {
    const source = '# 机 开场\n\n心形 微笑\n';
    const facts = factsOf(source, 3, 3);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/heart');
    expect(facts[0]!.edit.newText).toBe('> 微笑(心形)');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe('# 机 开场\n\n> 微笑(心形)\n');
  });

  it('`心形：` 块 ⇒ 摘块头 + 逐行补提示（体上提一级）', () => {
    const source = '# 机 开场\n\n心形：\n    我：「早。」\n    > 她笑了。\n';
    const facts = factsOf(source, 3, 5);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.span).toEqual({ startLine: 3, endLine: 5 });
    expect(facts[0]!.edit.newText).toBe('我：「早。」(心形)\n> 她笑了。(心形)');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n我：「早。」(心形)\n> 她笑了。(心形)\n',
    );
  });

  it('块体里混入控制流 ⇒ 整块不产（说不清就不动）', () => {
    const source = '# 机 开场\n\n心形：\n    ? 数值 == 1\n        > a\n';
    expect(factsOf(source, 3, 5)).toEqual([]);
  });
});

describe('④着色 / 随机 / 初回：整块搬 core 产物', () => {
  it('`着色 0xFF8080：` ⇒ `@着色 0xFF8080`（体原样）', () => {
    const source = '# 机 开场\n\n着色 0xFF8080：\n    我：「早。」\n';
    const facts = factsOf(source, 3, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/color');
    expect(facts[0]!.edit.newText).toBe('@着色 0xFF8080\n    我：「早。」');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe('# 机 开场\n\n@着色 0xFF8080\n    我：「早。」\n');
  });

  it('`随机：` ⇒ `@随机`（多行候选自动包 `@组`）', () => {
    const source = '# 机 开场\n\n随机：\n    我：「早。」\n    我：「嗨。」\n';
    const facts = factsOf(source, 3, 5);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.code).toBe('core/migration/random');
    expect(facts[0]!.edit.newText).toBe(
      '@随机\n    @组\n        我：「早。」\n    @组\n        我：「嗨。」',
    );
    expect(expectParseCleanAfter(facts[0]!, source)).toContain('@随机\n');
  });

  it('`初回：` ⇒ `@原生` 围栏（块内逐行搬、深一级）', () => {
    const source = '# 机 开场\n\n初回：\n    我：「早。」\n';
    const facts = factsOf(source, 3, 4);
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
    const facts = factsOf(SOURCE, 4, 8);
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
    const facts = factsOf(source, 6, 10);
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
    // 改前读数：INSERT 点在 `# 方言` 那一行（= 3），落在块头之前 ⇒ 两段编辑，
    // 结果 `# 方言` 被挤到「空行 + # 对照表 块 + 空行」之后，单行声明组被拆散。
    // 改后：插入点跳过 `# 方言`（与 `# 机` / `# 视角` 同为单行声明）⇒ 与块头同行 ⇒ 一段合成编辑。
    const source =
      '# 机 开场\n# 视角 我\n# 方言 erafl\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n';
    const facts = factsOf(source, 5, 9);
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
    expect(factsOf(source, 4, 6)).toEqual([]);
  });
});

describe('⑥当 → `# 对照表`', () => {
  it('数值分档改写：值列 = 原分支正文，引用点写 `{表名}`', () => {
    const source =
      '# 机 开场\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n';
    const facts = factsOf(source, 3, 7);
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
    expect(factsOf(source, 3, 7)).toEqual([]);
  });

  it('块嵌在 `?` 分支里 ⇒ 声明仍提升到顶层声明区、引用行留在原缩进', () => {
    const source =
      '# 机 开场\n# 视角 我\n\n? 数值 == 1\n    当 数值：\n        是 1：\n            早。\n        否则：\n            嗨。\n? 否\n    > 别的\n';
    const facts = factsOf(source, 5, 9);
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
    const facts = factsOf(source, 3, 4);
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
    const facts = factsOf(source, 4, 6);
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
    const facts = factsOf(source, 6, 6);
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
    const facts = factsOf(source, 5, 5);
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
    const facts = factsOf(source, 4, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('    > a');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n? 数值 == 1\n    > a\n? 否\n    > b\n',
    );
  });

  it('缩了 6 格（一级半）⇒ 归到一级', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const facts = factsOf(source, 4, 4);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('    > a');
    expect(expectParseCleanAfter(facts[0]!, source)).toBe(
      '# 机 开场\n\n? 数值 == 1\n    > a\n? 否\n    > b\n',
    );
  });

  it('同一行报两条同码诊断也只出一条动作（💡 里不出现两条一样的修复）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    expect(diagnosticsOf(source).filter((d) => d.code === 'core/lex/indent')).toHaveLength(2);
    expect(factsOf(source, 4, 4)).toHaveLength(1);
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
    expect(factsOf(source, 3, 3, { verifier })).toEqual([]);
  });

  it('注入假 parse：解析器直接抛 ⇒ 否决（错误不外抛给 Monaco）', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const verifier: Kojo2CodeActionVerifier = {
      parse: () => {
        throw new Error('桩：解析器炸了');
      },
      compile: () => [],
    };
    expect(factsOf(source, 3, 3, { verifier })).toEqual([]);
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
    expect(factsOf(source, 3, 4, { verifier })).toEqual([]);
  });

  it('`enabled: false` ⇒ 一条都不产（宿主显式关闸）', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const diagnostics = diagnosticsOf(source);
    expect(
      kojo2CodeActionFacts({ source, diagnostics, range: rangeOf(3, 3), enabled: false }),
    ).toEqual([]);
  });
});

/* ============================== 3. 诊断关联与筛选 ============================== */

describe('⑪诊断关联 / 码筛选 / 空 span', () => {
  const SOURCE = '# 机 开场\n\n她点了点头。\n';

  it('`fact.diagnostics` 是**同一批对象引用**（宿主据此画关联高亮）', () => {
    const diagnostics = diagnosticsOf(SOURCE);
    const facts = kojo2CodeActionFacts({ source: SOURCE, diagnostics, range: rangeOf(3, 3) });
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
    expect(kojo2CodeActionFacts({ source: SOURCE, diagnostics, range: rangeOf(1, 1) })).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/decl/missing-machine')).toBe(false);
  });

  it('缺 span 的诊断 ⇒ 零动作（没有落点就没法定位构造）', () => {
    const diagnostics: KojoDiagnostic[] = [
      { code: 'core/narrative/bare-narration', severity: 'error', message: '桩', span: null },
    ];
    expect(kojo2CodeActionFacts({ source: SOURCE, diagnostics, range: rangeOf(3, 3) })).toEqual([]);
  });

  it('同一条诊断传两遍 ⇒ 只出一条动作（去重键 = 类别 + 编辑内容）', () => {
    const diagnostics = diagnosticsOf(SOURCE);
    const facts = kojo2CodeActionFacts({
      source: SOURCE,
      diagnostics: [diagnostics[0]!, diagnostics[0]!],
      range: rangeOf(3, 3),
    });
    expect(facts).toHaveLength(1);
  });
});

/* ============================== 4. 假 Monaco：注册纪律与翻译层 ============================== */

const MARKER_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly providers: {
    readonly selector: unknown;
    readonly provider: Monaco.languages.CodeActionProvider;
    readonly metadata: unknown;
  }[];
  readonly commands: Map<string, (accessor: unknown, ...args: unknown[]) => void>;
  readonly disposed: string[];
  readonly models: Map<string, Monaco.editor.ITextModel>;
  registerModel(model: Monaco.editor.ITextModel): void;
  runCommand(id: string, ...args: unknown[]): void;
}

function fakeMonaco(options: { failOn?: 'command' | 'provider'; failDisposeOn?: 'command' | 'provider' } = {}): FakeMonaco {
  const providers: FakeMonaco['providers'] = [];
  const commands = new Map<string, (accessor: unknown, ...args: unknown[]) => void>();
  const disposed: string[] = [];
  const models = new Map<string, Monaco.editor.ITextModel>();
  const fake = {
    MarkerSeverity: MARKER_SEVERITY,
    editor: {
      registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void) {
        if (options.failOn === 'command') throw new Error('桩：注册命令抛错');
        commands.set(id, handler);
        return {
          dispose: () => {
            if (options.failDisposeOn === 'command') throw new Error('桩：撤命令抛错');
            disposed.push('command');
          },
        };
      },
      getModel(uri: { toString(): string }) {
        return models.get(uri.toString()) ?? null;
      },
    },
    Uri: {
      parse: (text: string) => ({ toString: () => text, fsPath: text, path: text }),
    },
    languages: {
      registerCodeActionProvider(selector: unknown, provider: unknown, metadata: unknown) {
        if (options.failOn === 'provider') throw new Error('桩：注册 provider 抛错');
        providers.push({
          selector,
          provider: provider as Monaco.languages.CodeActionProvider,
          metadata,
        });
        return {
          dispose: () => {
            if (options.failDisposeOn === 'provider') throw new Error('桩：撤 provider 抛错');
            disposed.push('provider');
          },
        };
      },
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    providers,
    commands,
    disposed,
    models,
    registerModel(model) {
      models.set(uriOf(model), model);
    },
    runCommand(id, ...args) {
      const handler = commands.get(id);
      if (handler === undefined) throw new Error(`桩：没有命令 ${id}`);
      handler(null, ...args);
    },
  };
}

function uriOf(model: Monaco.editor.ITextModel): string {
  return (model as unknown as { uri: { toString(): string } }).uri.toString();
}

interface FakeModelOptions {
  readonly languageId?: string;
  readonly failGetValue?: boolean;
}

function fakeModel(text: string, options: FakeModelOptions = {}): Monaco.editor.ITextModel {
  const languageId = options.languageId ?? KOJO2_LANGUAGE_ID;
  const uri = { toString: () => `file:///D:/proj/chara/开场.kojo2`, fsPath: 'D:/proj/chara/开场.kojo2' };
  return {
    getValue: () => {
      if (options.failGetValue === true) throw new Error('桩：模型已释放');
      return text;
    },
    getLanguageId: () => languageId,
    isDisposed: () => false,
    uri,
  } as unknown as Monaco.editor.ITextModel;
}

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
  else store.set(KOJO2_PLAN_KEY, KOJO2_OFF_PLAN);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 一次 provider 请求：源码 → core 诊断 → markers（与宿主那条路同源） */
function requestActions(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  source: string,
  range: Kojo2CodeActionRange,
): Monaco.languages.CodeAction[] {
  const diagnostics = diagnosticsOf(source);
  const markers = kojo2DiagnosticsToMarkers(fake.monaco, diagnostics, source);
  fake.registerModel(model);
  const list = fake.providers[0]!.provider.provideCodeActions!(
    model,
    new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn),
    { markers, triggerKind: 1 } as unknown as Monaco.languages.CodeActionContext,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as Monaco.CancellationToken,
  ) as Monaco.languages.CodeActionList;
  return [...list.actions];
}

describe('⑫注册纪律：flag 关零注册 / flag 开只挂 kojo2 一枚', () => {
  it('flag 关 ⇒ 注册函数一次都没被调用（零注册），句柄是空操作且可重复 dispose', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    expect(fake.providers).toHaveLength(0);
    expect(fake.commands.size).toBe(0);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(fake.disposed).toEqual([]);
  });

  it('flag 开 ⇒ 恰好一枚 provider + 一条命令，selector 只有 `kojo2`，类别声明齐两档', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    expect(fake.providers).toHaveLength(1);
    expect(fake.providers[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(fake.commands.has(KOJO2_CODE_ACTION_COMMAND)).toBe(true);
    expect(fake.providers[0]!.metadata).toEqual({
      providedCodeActionKinds: KOJO2_PROVIDED_CODE_ACTION_KINDS,
    });
    expect(KOJO2_PROVIDED_CODE_ACTION_KINDS).toEqual(['quickfix', 'refactor']);
    handle.dispose();
    expect(fake.disposed).toEqual(['command', 'provider']);
  });

  it('provider 注册抛错 ⇒ 已挂上的命令撤回 + 错误外抛（全有或全无）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failOn: 'provider' });
    expect(() => installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false })).toThrow(
      '桩：注册 provider 抛错',
    );
    expect(fake.disposed).toEqual(['command']);
    expect(fake.providers).toHaveLength(0);
  });

  it('撤一枚抛错不许带走其余（dispose 逐枚隔离）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failDisposeOn: 'command' });
    const handle = installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    expect(() => handle.dispose()).not.toThrow();
    expect(fake.disposed).toEqual(['provider']);
  });

  it('v1 语言面（`.kojo`）零动作：provider 只答 `kojo2`', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    const source = '# 机 开场\n\n她点了点头。\n';
    const model = fakeModel(source, { languageId: 'kojo' });
    expect(requestActions(fake, model, source, rangeOf(3, 3))).toEqual([]);
  });

  it('取文抛错 / provider 体内抛错 ⇒ 空动作、不外抛', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    const model = fakeModel('# 机 开场\n\n她点了点头。\n', { failGetValue: true });
    expect(requestActions(fake, model, '# 机 开场\n\n她点了点头。\n', rangeOf(3, 3))).toEqual([]);
  });
});

describe('⑬Monaco 翻译层：command 而非 edit、诊断关联、唯一解 preferred', () => {
  it('marker → core 诊断往返：码 / 严重级 / span 逐字对上', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const markers = kojo2DiagnosticsToMarkers(fakeMonaco().monaco, diagnosticsOf(source), source);
    const back = kojo2DiagnosticsFromMarkers(fakeMonaco().monaco, markers);
    expect(back).toHaveLength(1);
    expect(back[0]!.code).toBe('core/narrative/bare-narration');
    expect(back[0]!.severity).toBe('error');
    expect(back[0]!.span).toEqual({
      start: { line: 3, column: 1 },
      end: { line: 3, column: 7 },
    });
  });

  it('没码的 marker 不收（不猜"这是不是我认领的构造"）', () => {
    const markers: Monaco.editor.IMarkerData[] = [
      { severity: MARKER_SEVERITY.Error, message: '无码', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
    ];
    expect(kojo2DiagnosticsFromMarkers(fakeMonaco().monaco, markers)).toEqual([]);
  });

  it('动作带 `command`（不是 `edit`）、关联诊断翻成 markers、唯一解置 isPreferred', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    const source = '# 机 开场\n\n她点了点头。\n';
    const actions = requestActions(fake, fakeModel(source), source, rangeOf(3, 3));
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('quickfix');
    expect(action.command?.id).toBe(KOJO2_CODE_ACTION_COMMAND);
    expect(action.edit).toBeUndefined(); // 落地必须走宿主那条带停点的通道
    expect(action.isPreferred).toBe(true);
    expect(action.diagnostics).toHaveLength(1);
    expect(action.diagnostics![0]!.code).toBe('core/narrative/bare-narration');
  });

  it('多解不置 preferred；改缩进走 refactor 档', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const facts = factsOf(source, 4, 4);
    expect(facts).toHaveLength(1);
    const actions = kojo2CodeActionsOf(fakeMonaco().monaco, source, facts, () => 'k');
    expect(kojo2CodeActionKindOf('indent')).toBe('refactor');
    expect(actions[0]!.kind).toBe('refactor');
    expect(actions[0]!.isPreferred).toBeUndefined();
  });
});

/* ============================== 5. 停点复用（undo 纪律） ============================== */

describe('⑭落地走同一条 `applyTextEdits`（前后各一颗停点）', () => {
  it('命令回调把**同一批** EditorTextEdit 交给注入的 applyEdits 端口', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const applied: { readonly edits: readonly EditorTextEdit[] }[] = [];
    installKojo2CodeActionProvider(fake.monaco, {
      applyEdits: (_model, edits) => {
        applied.push({ edits });
        return true;
      },
    });
    const source = '# 机 开场\n\n她点了点头。\n';
    const model = fakeModel(source);
    const actions = requestActions(fake, model, source, rangeOf(3, 3));
    fake.runCommand(actions[0]!.command!.id, actions[0]!.command!.arguments![0]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.edits).toEqual([{ fromLine: 3, toLine: 3, newText: '> 她点了点头。' }]);
  });

  it('命令 key 不认识 / 模型已不在 ⇒ 静默不落（不崩）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    let calls = 0;
    installKojo2CodeActionProvider(fake.monaco, {
      applyEdits: () => {
        calls += 1;
        return true;
      },
    });
    expect(() => fake.runCommand(KOJO2_CODE_ACTION_COMMAND, 'no-such-key')).not.toThrow();
    expect(calls).toBe(0);
  });

  it('真 model + 假 editor 转发桩：调用序 `停点 → executeEdits → 停点`，文本落到真 model', () => {
    const source = '# 机 开场\n\n她点了点头。\n';
    const facts = factsOf(source, 3, 3);
    const model = monaco.editor.createModel(
      source,
      KOJO2_LANGUAGE_ID,
      monaco.Uri.parse('inmemory://kojo2-code-actions/1'),
    );
    const calls: string[] = [];
    const editor = {
      getModel: () => model,
      executeEdits: (_source: string, operations: monaco.editor.IIdentifiedSingleEditOperation[]) => {
        calls.push('edit');
        return model.pushEditOperations(null, operations, () => null) !== null;
      },
      pushUndoStop: () => {
        calls.push('stop');
        model.pushStackElement();
      },
    } as unknown as Parameters<typeof applyTextEdits>[0];
    expect(applyTextEdits(editor, kojo2EditorEditsOf(facts[0]!))).toBe(true);
    expect(calls).toEqual(['stop', 'edit', 'stop']);
    expect(model.getValue()).toBe('# 机 开场\n\n> 她点了点头。\n');
    model.dispose();
  });

  it('源码钉子：宿主接线在 flag 块里、且把落地接到 `applyTextEdits`；本层不出现 executeEdits', () => {
    const providers = codeOf(
      readFileSync(path.resolve(HERE, '..', 'src', 'ui', 'editor-global-providers.ts'), 'utf8'),
    );
    expect(providers).toMatch(
      /if \(isKojo2CutoverEnabled\(\)\) \{[\s\S]{0,2500}?installKojo2CodeActionProvider\(monaco, \{[\s\S]{0,400}?return applyTextEdits\(ed, edits\);/,
    );
    // 开口只有一个：宿主里 `ed.executeEdits(` 仍然只有 applyTextEdits 那一处
    expect(providers.match(/ed\.executeEdits\(/g)?.length).toBe(1);
    const layer = codeOf(
      readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-code-actions.ts'), 'utf8'),
    );
    expect(layer).not.toContain('executeEdits');
    expect(layer).not.toContain('pushUndoStop');
  });
});

/* ============================== 6. 应用后 parse 零 error（总闸） ============================== */

describe('⑮逐类动作：应用后 core parse 零 error', () => {
  const CASES: readonly { readonly name: string; readonly source: string; readonly from: number; readonly to: number }[] = [
    { name: '裸旁白', source: '# 机 开场\n\n她点了点头。\n', from: 3, to: 3 },
    { name: '裸引号', source: '# 机 开场\n# 视角 我\n\n「……早。」\n', from: 4, to: 4 },
    { name: '心形行', source: '# 机 开场\n\n心形 微笑\n', from: 3, to: 3 },
    { name: '心形块', source: '# 机 开场\n\n心形：\n    我：「早。」\n', from: 3, to: 4 },
    { name: '着色块', source: '# 机 开场\n\n着色 0xFF8080：\n    我：「早。」\n', from: 3, to: 4 },
    { name: '随机块', source: '# 机 开场\n\n随机：\n    我：「早。」\n    我：「嗨。」\n', from: 3, to: 5 },
    { name: '分支池', source: '# 机 开场\n# 视角 我\n\n分支：\n    [数值 < 100]\n        「早。」\n    [其他]\n        「嗨。」\n', from: 4, to: 8 },
    { name: '当表', source: '# 机 开场\n\n当 数值：\n    是 1：\n        早。\n    否则：\n        嗨。\n', from: 3, to: 7 },
    { name: '初回原生', source: '# 机 开场\n\n初回：\n    我：「早。」\n', from: 3, to: 4 },
    { name: '补否（表）', source: '# 机 开场\n\n# 对照表 心情 依据 数值\n    0..99 -> 疏远\n', from: 3, to: 4 },
    { name: '补否（池）', source: '# 机 开场\n# 视角 我\n\n# 池 问候\n    ? 数值 < 100\n        「早。」\n', from: 4, to: 6 },
    { name: '补插槽', source: '# 机 开场\n\n# 模 娇羞()\n    > （她红着脸）\n\n! 娇羞()\n    我：「才没有！」\n', from: 6, to: 6 },
    { name: '修缩进（链头）', source: '# 机 开场\n\n? 数值 == 1\n    > a\n  ? 否\n    > b\n', from: 5, to: 5 },
    { name: '修缩进（体）', source: '# 机 开场\n\n? 数值 == 1\n  > a\n? 否\n    > b\n', from: 4, to: 4 },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name}：产动作且应用后 parse 零 error`, () => {
      const facts = factsOf(testCase.source, testCase.from, testCase.to);
      expect(facts.length, `${testCase.name} 没有产出动作`).toBeGreaterThan(0);
      for (const fact of facts) expectParseCleanAfter(fact, testCase.source);
    });
  }

  it('修缩进后**整篇**零 error（含表 / 池 / 模板三条编译期判据）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const facts = factsOf(source, 4, 4);
    const after = kojo2EditedSource(source, facts[0]!.edits);
    expect(parseErrors(after)).toEqual([]);
    expect(diagnosticsOf(after).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

/** 纯代码面（剥整行注释与块注释）：源码针只钉代码 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}



