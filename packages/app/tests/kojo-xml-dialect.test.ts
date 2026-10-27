/**
 * LAU-D3 · 口上 XML 的方言事件面（`kojo-xml-dialect.ts`）判据。
 *
 * 钉五件事（与 §8 LAU-D3 的 DoD 逐条对应）：
 * 1. **`command` 有补全**：命令值候选来自 `KojoXmlSchema.commands`（adapter 交来的表）；
 * 2. **未登记 command ⇒ `core/event/unknown`**：位置指到属性值那一段；
 * 3. **错载体 ⇒ `core/event/wrong-carrier`**：XML 条目落在 ERB 载体上（`会話` 就是那一格）；
 * 4. **载体归属按当前方言的 `carriers`**：XML 路径归 xml、别的路径归不上就一条不问；
 * 5. **复用 D2a**：诊断码 / 严重级 / 聚合器 / 排序全走 `kojo2-dialect-lint.ts` 那一份，
 *    并且 D2a 的事件名判定在"没声明 carriers"的方言上原样成立（不回退）。
 *
 * 夹具只住测试目录（`tests/fixtures/kojo-xml-dialect/`），不往仓库其它地方放语料。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDialectBinding, type GameAdapter } from '@kojo/kojo-core';
import { ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter';
import { buildKojoXmlSchema } from '../../plugins/erafl-adapter/src/kojo-xml/schema';
import {
  aggregateKojo2DialectLint,
  kojo2DialectLintProblems,
  lintKojo2Dialect,
} from '../src/monaco/kojo2-dialect-lint';
import {
  knownXmlCommandTokens,
  lintKojoXmlDialect,
  kojoXmlDialectProblems,
} from '../src/monaco/kojo-xml-dialect';
import { kojoXmlEventSitesOf } from '../src/monaco/kojo-xml-event-sites';
import { xmlCommandValueCandidates } from '../src/monaco/kojo-xml-providers';

/* ============================== 夹具与基座 ============================== */

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'kojo-xml-dialect');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const KOJO_XML = fixture('kojo-command.xml');
const EVENT_IN_COMMAND = fixture('event-in-command.xml');
const EVENT_IN_ERB = fixture('event-in-erb.erb');

/** eraFL 的真实 XML 规格（5 条符号命令；数字部分由 `CSV/Train.csv` 装载时注入） */
const SCHEMA = buildKojoXmlSchema();

/** 载体归属走真解析器（不由测试手造 binding） */
function bindingFor(filePath: string, facts: GameAdapter = ERAFL_GAME_ADAPTER) {
  return resolveDialectBinding({ detectedDialect: facts.id, factsFor: () => facts, filePath });
}

const XML_PATH = 'ERB/口上/1099_うふふお姉さん/KOJO_K1099_COM.xml';
const ERB_PATH = 'ERB/口上/1099_うふふお姉さん/KOJO_DEFINE_K1099.ERB';

const codesOf = (diagnostics: readonly { code: string }[]): string[] =>
  diagnostics.map((item) => item.code);

/* ============================== 1. 命令值补全 ============================== */

describe('DoD 1 · `command` 有补全（命令表来自 adapter，宿主零内置）', () => {
  it('`com` 的值候选 = 命令表的 code + label（300 / 会話 都在）', () => {
    const candidates = xmlCommandValueCandidates(SCHEMA, 'com');
    const labels = candidates.map((item) => item.label);
    expect(labels).toContain('300');
    expect(labels).toContain('会話');
    expect(labels).toContain('ANY');
    // 值与插入文本逐字相同（值位置补的是引号里的原文）
    for (const candidate of candidates) expect(candidate.insertText).toBe(candidate.label);
  });

  it('表的来源就是 adapter 的 schema（同一枚 `commands`，不另造码表）', () => {
    const known = knownXmlCommandTokens(SCHEMA);
    expect(known.has('300')).toBe(true);
    expect(known.has('any')).toBe(true);
    // 没有表 ⇒ 零候选（不猜编号）
    expect(xmlCommandValueCandidates(null, 'com')).toEqual([]);
  });

  it('`eventId` 不出命令补全：它对应 `CSV/KojoEvent.CSV`，不是 `com` 那条轴', () => {
    expect(xmlCommandValueCandidates(SCHEMA, 'eventId')).toEqual([]);
  });
});

/* ============================== 2. 未登记 command ============================== */

describe('DoD 2 · 未登记 command ⇒ `core/event/unknown`（指到属性值）', () => {
  const resolution = bindingFor(XML_PATH);
  const report = lintKojoXmlDialect({
    source: KOJO_XML,
    facts: ERAFL_GAME_ADAPTER,
    binding: resolution.binding,
    schema: SCHEMA,
  });

  it('XML 路径归 xml 载体（真解析器），事件面在这里校验', () => {
    expect(resolution.binding?.carrier).toBe('xml');
    expect(report).not.toBeNull();
  });

  it('只有 `com="SEDUCE"` 一条 unknown；`300` / `ANY` 通过', () => {
    const unknown = report!.diagnostics.filter((item) => item.code === 'core/event/unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe('error');
    expect(unknown[0]!.message).toContain('SEDUCE');
    // 位置 = 属性值那一段（与投影器给的列区间逐字相等）
    const site = kojoXmlEventSitesOf(KOJO_XML.split(/\r\n|\n|\r/)).find(
      (item) => item.value === 'SEDUCE',
    );
    expect(site).toBeDefined();
    expect(unknown[0]!.span).toEqual({
      start: { line: site!.line, column: site!.startColumn },
      end: { line: site!.line, column: site!.endColumn },
    });
  });

  it('数字编号（含点分多值 `81.82,87`）与 CJK 命令名不判（开放域，见模块头三格表）', () => {
    expect(
      codesOf(
        lintKojoXmlDialect({
          source: '<command com="725" name="クラフト" kojoPlace="TOP">',
          facts: ERAFL_GAME_ADAPTER,
          binding: resolution.binding,
          schema: SCHEMA,
        })!.diagnostics,
      ),
    ).not.toContain('core/event/unknown');
    expect(
      codesOf(
        lintKojoXmlDialect({
          source: '<command com="81.82,87" name="★痛み系T" kojoPlace="TOP">',
          facts: ERAFL_GAME_ADAPTER,
          binding: resolution.binding,
          schema: SCHEMA,
        })!.diagnostics,
      ),
    ).not.toContain('core/event/unknown');
  });

  it('没有命令表 ⇒ 不判 unknown（不拿空表当封闭域）', () => {
    const noSchema = lintKojoXmlDialect({
      source: KOJO_XML,
      facts: ERAFL_GAME_ADAPTER,
      binding: resolution.binding,
      schema: null,
    });
    expect(codesOf(noSchema!.diagnostics)).not.toContain('core/event/unknown');
  });
});

/* ============================== 3. 跨载体错配 ============================== */

describe('DoD 3 · 错载体 ⇒ `core/event/wrong-carrier`', () => {
  it('`会話` 那一条 XML 条目落在 ERB 载体上 ⇒ 三个格各一条 wrong-carrier', () => {
    const erb = bindingFor(ERB_PATH);
    expect(erb.binding?.carrier).toBe('erb');
    const report = lintKojoXmlDialect({
      source: KOJO_XML,
      facts: ERAFL_GAME_ADAPTER,
      binding: erb.binding,
      schema: SCHEMA,
    });
    const wrong = report!.diagnostics.filter((item) => item.code === 'core/event/wrong-carrier');
    // 文件里 3 条 `<command>` × 3 格（com / name / kojoPlace）
    expect(wrong).toHaveLength(9);
    expect(wrong[0]!.message).toContain('xml');
    expect(wrong.some((item) => item.message.includes('会話'))).toBe(true);
    // 错载体比"未知命令"优先：这一面一条 unknown 都不该有
    expect(codesOf(report!.diagnostics)).not.toContain('core/event/unknown');
  });

  it('事件名写进命令口上的 `name` / `kojoPlace` 格 ⇒ wrong-carrier（在 xml 载体上判）', () => {
    const xml = bindingFor(XML_PATH);
    const report = lintKojoXmlDialect({
      source: EVENT_IN_COMMAND,
      facts: ERAFL_GAME_ADAPTER,
      binding: xml.binding,
      schema: SCHEMA,
    });
    const wrong = report!.diagnostics.filter((item) => item.code === 'core/event/wrong-carrier');
    expect(wrong).toHaveLength(2);
    for (const item of wrong) expect(item.message).toContain('初见');
  });

  it('D2a 那条真判据没回退：`# 机 初见` 写进 ERB ⇒ wrong-carrier（不是 unknown）', () => {
    const erb = bindingFor(ERB_PATH);
    expect(erb.binding?.carrier).toBe('erb');
    const report = lintKojo2Dialect({
      source: EVENT_IN_ERB,
      facts: ERAFL_GAME_ADAPTER,
      binding: erb.binding,
      diagnostics: [],
      resolutionDiagnostics: erb.diagnostics,
    });
    const codes = codesOf(report!.diagnostics);
    expect(codes).toContain('core/event/wrong-carrier');
    expect(codes).not.toContain('core/event/unknown');
  });
});

/* ============================== 4. 载体归属 ============================== */

describe('DoD 4 · 载体归属按当前方言的 `carriers`（没归属就不问、不猜）', () => {
  it('不在任何 glob 里的 XML ⇒ 解析器报 unowned，事件面一条诊断都不出', () => {
    const unowned = bindingFor('别处/1099.xml');
    expect(unowned.binding?.carrier).toBeNull();
    expect(codesOf(unowned.diagnostics)).toContain('core/carrier/unowned');
    const report = lintKojoXmlDialect({
      source: KOJO_XML,
      facts: ERAFL_GAME_ADAPTER,
      binding: unowned.binding,
      schema: SCHEMA,
    });
    expect(report!.diagnostics).toEqual([]);
  });

  it('方言没声明 `carriers` ⇒ 只做不依赖归属的判断（D2a 语义在 XML 面同口径）', () => {
    const NO_CARRIERS: GameAdapter = { ...ERAFL_GAME_ADAPTER, carriers: undefined };
    const report = lintKojoXmlDialect({
      source: KOJO_XML,
      facts: NO_CARRIERS,
      binding: null,
      schema: SCHEMA,
    });
    const codes = codesOf(report!.diagnostics);
    expect(codes).toContain('core/event/unknown'); // 命令表判据不依赖归属
    expect(codes).not.toContain('core/event/wrong-carrier');
  });

  it('没交绑定 ⇒ 不做错误载体判断（事件名格在 xml 面只按目录认）', () => {
    const report = lintKojoXmlDialect({
      source: EVENT_IN_COMMAND,
      facts: ERAFL_GAME_ADAPTER,
      binding: null,
      schema: SCHEMA,
    });
    expect(report!.diagnostics).toEqual([]);
  });
});

/* ============================== 5. 复用 D2a 的聚合 ============================== */

describe('DoD 5 · 与 D2a 同一张码表 / 同一枚聚合器（不造第三套）', () => {
  it('XML 报告直接喂 `aggregateKojo2DialectLint`：按 `(码, 方言)` 聚成一条', () => {
    const erb = bindingFor(ERB_PATH);
    const report = lintKojoXmlDialect({
      source: KOJO_XML,
      facts: ERAFL_GAME_ADAPTER,
      binding: erb.binding,
      schema: SCHEMA,
    });
    const groups = aggregateKojo2DialectLint(report!);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.code).toBe('core/event/wrong-carrier');
    expect(groups[0]!.dialect).toBe('erafl');
    expect(groups[0]!.count).toBe(9);
    const problems = kojo2DialectLintProblems(XML_PATH, groups);
    expect(problems[0]!.source).toBe('Kojo 2.0 方言体检');
    // 行级投影（marker 用）与聚合同一份诊断
    expect(kojoXmlDialectProblems(report).length).toBe(9);
  });
});

/* ============================== 6. 真盘误报率 ============================== */

describe('真盘误报率（守卫：D:/Game/erafl 存在才跑）', () => {
  const KOJO_ROOT = 'D:/Game/erafl/ERB/口上';
  const hasCorpus = existsSync(KOJO_ROOT);

  it.skipIf(!hasCorpus)('293 份跑完：只有 ASCII 符号命令会报 unknown，错载体零条', () => {
    const paths: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.xml$/i.test(ent.name)) paths.push(full);
      }
    };
    walk(KOJO_ROOT);

    let unknown = 0;
    let wrongCarrier = 0;
    const badTokens = new Set<string>();
    for (const full of paths) {
      const relative = path.relative('D:/Game/erafl', full).replaceAll('\\', '/');
      const resolution = bindingFor(relative);
      expect(resolution.binding?.carrier, relative).toBe('xml');
      const report = lintKojoXmlDialect({
        source: readFileSync(full, 'utf8'),
        facts: ERAFL_GAME_ADAPTER,
        binding: resolution.binding,
        schema: SCHEMA,
      });
      for (const diagnostic of report?.diagnostics ?? []) {
        if (diagnostic.code === 'core/event/unknown') {
          unknown += 1;
          const token = /命令“([^”]+)”/.exec(diagnostic.message)?.[1] ?? '';
          badTokens.add(token);
        } else if (diagnostic.code === 'core/event/wrong-carrier') {
          wrongCarrier += 1;
        }
      }
    }
    // 真盘 293 份的 `com` 记号里 ASCII 未知只有一族（`RAPE_INSERTED`，10 处）；
    // 数字编号（含点分多值）与 CJK 命令名一律不判 ⇒ 它们一个都不许出现在诊断里。
    expect(unknown).toBeLessThanOrEqual(15);
    expect(wrongCarrier).toBe(0);
    for (const token of badTokens) {
      expect(token).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
