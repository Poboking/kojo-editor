/**
 * **共享列 + 方言差异表**（SDK B5a · 第三条交付物）。
 *
 * ## 这一份测的是什么
 *
 * 两份真 profile（eraTW / eraFL）＋ 一个第三列假 adapter（`--adapter demo`）跑**同一份**
 * fixture 清单（`fixtures/language-shared/`），断言三件事：
 *
 * 1. **共享面逐字相同**：`# 机` 之后的语义面（文本 / 空行 / 条件 / 表 / 池 / 模板 / 随机 /
 *    原生 / 程序层 / 取色）在三列里编出**同一份字节**，且等于提交的 `.body.erb`；
 * 2. **机壳各自给**（不是差异被抹平）：eraTW 落口上运行时 `@M_KOJO_ENCOUNTER_K12`、eraFL 落
 *    裸引擎 `@EVENTFIRST`、demo 落它自己的 `@DEMO_FIRST`——差异被**点名**，不是被忽略；
 * 3. **方言差异单列**（"各自事实 + 同一期望"），按观测面分三种形态：
 *    - **产物**：eraTW 独有的事件在 eraFL 侧 `event/unknown` + 0 字节；反过来 eraFL 的
 *      `读档` 在 eraTW 侧 `unit/backend-incomplete`——**目录收录 ≠ 落点面认得**
 *      （eraTW 九事件目录与它的口上模板表不是同一张表，实测只有「初见」能落点）；
 *    - **声明**：代词落点（eraTW `%CALLNAME:TARGET%` / eraFL `[$KNAME]`）。恒等表达式
 *      端口下产物里看不出差异，所以断 `domainSymbols`，并把"产物看不出"另钉一枚用例；
 *    - **同一格不是差异**：存储期三族在两侧同名同前缀（写出来，免得下次被当差异改）。
 *    不许拿 eraTW 的事实喂 eraFL，也不许反过来。
 *
 * 第三条同时是 SDK 的终态判据：`demo` 是一枚**只加数据**的最小 profile（新增一个包 = 新增一列），
 * 套件（`language.ts` 的判定逻辑）零改动；CLI 只在固定注册表 `LANGUAGE_ADAPTER_ENTRIES` +
 * `runLanguage` 各加一条。eraFL 列经 `@kojo/plugin-erafl-adapter/kojo2` 窄子路径进来（与 eraTW
 * 同走包面），不再相对路径直捅别人的 `src`。
 */
import { describe, expect, it } from 'vitest';
import type { GameAdapter, KojoEmitBackend } from '@kojo/kojo-core';
import { compileKojoSource } from '@kojo/kojo-core';
import { ERATW_GAME_ADAPTER, createEratwEmitBackend } from '@kojo/plugin-eratw-adapter';

import { ERAFL_GAME_ADAPTER, createEraflEmitBackend } from '@kojo/plugin-erafl-adapter/kojo2';
import { DEMO_GAME_ADAPTER, createDemoEmitBackend } from './fixtures/dialect-demo/index.js';
import type { LanguageAdapterRegistration, LanguageCliDeps, LanguageIoPort } from '../src/language.js';
import {
  LANGUAGE_SHARED_SUITE,
  runLanguageCli,
  runLanguageSharedSuite,
} from '../src/language.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ============================== 0. 三列 ============================== */

const compileText = (expr: { readonly text: string }): string => expr.text;

function registrations(): Record<string, LanguageAdapterRegistration> {
  return {
    eratw: {
      adapter: ERATW_GAME_ADAPTER,
      backend: createEratwEmitBackend({ compileExpression: compileText, charNo: '12' }),
      column: 'shared',
    },
    erafl: {
      adapter: ERAFL_GAME_ADAPTER,
      backend: createEraflEmitBackend({ compileExpression: compileText }),
      column: 'shared',
    },
    demo: {
      adapter: DEMO_GAME_ADAPTER,
      backend: createDemoEmitBackend({ compileExpression: compileText }),
      column: 'shared',
    },
  };
}

const io: LanguageIoPort = {
  readText: (target): string => readFileSync(target, 'utf8'),
};

/** 与 `tools/kojo-conformance.mjs` 同一条链：CLI 纯逻辑 + 注入注册表 */
function runCli(adapter: string) {
  const deps: LanguageCliDeps = { io, adapters: registrations() };
  return runLanguageCli(['language', '--adapter', adapter, '--json'], deps);
}

const TW = runCli('eratw');
const FL = runCli('erafl');
const DEMO = runCli('demo');

const SHARED_IDS = LANGUAGE_SHARED_SUITE.map((entry) => entry.id);

function caseOf(report: typeof TW.report, id: string) {
  const found = report.cases.find((item) => item.id === id);
  expect(found, `报告里缺 ${id}`).toBeDefined();
  return found!;
}

/* ============================== 1. 共享列：三列逐字相同 ============================== */

describe('共享列 · 三份 profile 对同一批用例编出同一份 body', () => {
  it('三列都 exit 0 且 11/11 全绿（共享面没有 blocked / differs）', () => {
    for (const [name, result] of [
      ['eratw', TW],
      ['erafl', FL],
      ['demo', DEMO],
    ] as const) {
      expect(result.exitCode, name).toBe(0);
      expect(result.report.ok, name).toBe(true);
      expect(result.report.summary.cases, name).toBe(LANGUAGE_SHARED_SUITE.length);
      expect(result.report.summary.pass, name).toBe(LANGUAGE_SHARED_SUITE.length);
      expect(result.report.failures, name).toEqual([]);
    }
    expect(LANGUAGE_SHARED_SUITE).toHaveLength(11);
  });

  it('逐条：三列的 artifact 与 golden 三字节相等（JSON 可直接 diff）', () => {
    for (const id of SHARED_IDS) {
      const tw = caseOf(TW.report, id);
      const fl = caseOf(FL.report, id);
      const demo = caseOf(DEMO.report, id);
      expect(tw.status, id).toBe('pass');
      expect(fl.artifact, `${id} · eraFL 与 eraTW 的 body 不同`).toBe(tw.artifact);
      expect(demo.artifact, `${id} · demo 与 eraTW 的 body 不同`).toBe(tw.artifact);
      expect(fl.golden, `${id} · golden 不同源`).toBe(tw.golden);
      expect(tw.artifact, `${id} · 产物不是期望字节`).toBe(tw.golden);
      // 空 body = 这条没测到东西（子集"全绿"最容易栽在这里）
      expect((tw.artifact ?? '').length, `${id} 的 body 是空的`).toBeGreaterThan(0);
      expect(tw.diagnostics, `${id} 不该有诊断`).toEqual([]);
    }
  });

  it('两列的报告只在 adapter / backend 标签上不同（其余逐字相同）', () => {
    const strip = (report: typeof TW.report) => ({ ...report, adapter: '', backend: '' });
    expect(strip(FL.report)).toEqual(strip(TW.report));
    expect(strip(DEMO.report)).toEqual(strip(TW.report));
  });

  it('共享列只跑共享套件：不混进抽象列的 47 例（分组只有 `shared`）', () => {
    expect(TW.report.groups.filter((group) => group.cases > 0).map((group) => group.group)).toEqual(['shared']);
    expect(TW.report.summary.constructs).toBeGreaterThanOrEqual(30);
  });
});

/* ============================== 2. 机壳：差异被点名，不是被抹平 ============================== */

function compile(adapter: GameAdapter, backend: KojoEmitBackend, source: string) {
  return compileKojoSource({ source, adapter, backend });
}

const FIXTURE_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/language-shared/narrative.kojo2', import.meta.url)),
  'utf8',
);

describe('机壳 · 同一份源、三种口上运行时', () => {
  it('eraTW 落 `@M_KOJO_ENCOUNTER_K12` + CALL/RETURN；eraFL 落 `@EVENTFIRST`+`#LATER`；demo 落 `@DEMO_FIRST`', () => {
    const regs = registrations();
    const tw = compile(regs.eratw!.adapter, regs.eratw!.backend, FIXTURE_SOURCE).erb;
    const fl = compile(regs.erafl!.adapter, regs.erafl!.backend, FIXTURE_SOURCE).erb;
    const demo = compile(regs.demo!.adapter, regs.demo!.backend, FIXTURE_SOURCE).erb;

    expect(tw).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(tw).toContain('CALL M_KOJO_ENCOUNTER_K12_1');
    expect(tw).toContain('RETURN RESULT');
    expect(fl).toContain('@EVENTFIRST\n#LATER');
    expect(demo).toContain('@DEMO_FIRST\n#LATER');

    // 三份完整产物互不相同（机壳是方言事实），但 body 相同（共享列已逐字钉过）
    expect(new Set([tw, fl, demo]).size).toBe(3);
  });

  it('共享 body 在三份完整产物里逐字出现（不是归一化后的"相似"）', () => {
    const regs = registrations();
    const body = caseOf(TW.report, 'shared/narrative').golden ?? '';
    for (const key of ['eratw', 'erafl', 'demo'] as const) {
      const erb = compile(regs[key]!.adapter, regs[key]!.backend, FIXTURE_SOURCE).erb;
      expect(erb, key).toContain(body);
    }
  });
});

/* ============================== 3. 方言差异表（各自事实 + 同一期望） ============================== */

/**
 * 差异有**三种形态**，"同一期望"按形态落在不同的观测面（混起来就会写成一句空话）：
 *
 * - `产物`：拥有者编得出自己的片段，不拥有者 **0 字节 + 一条码**；
 * - `声明`：两侧都能编，差异只在**声明面**（`domainSymbols` / `storageClasses`）——
 *   断数据不断产物；
 * - `目录 ≠ 可落点`：目录收录 ≠ 落点面认得（eraTW 的九事件目录与它的口上模板表不是
 *   同一张表）。这一形态必须分开断言，否则"eraFL 的读档在 eraTW 也能编"是假话。
 *
 * **代词为什么走声明面**：conformance 的表达式端口是**恒等端口**
 * （`(expr) => expr.text`，真管线住宿主，见 eraFL 夹具头注），所以 `{我}` 在三列里都落
 * `%我%`——产物层面没有差异可断。落点只住 `domainSymbols`，就断声明面，并把"产物里
 * 看不出差异"这一事实也钉成断言（免得下次有人拿产物去证"代词一样"）。
 */
interface EmitDifferenceRow {
  readonly face: '事件表';
  /** 这一行用的是**谁的事实**（跑在谁身上算"合法"） */
  readonly owner: 'eratw' | 'erafl';
  readonly source: string;
  /** 拥有者期望的产物片段（它自己的事实落成什么） */
  readonly ownerArtifact: string;
  /** 不拥有者期望的失败（同一期望：码 + 0 字节） */
  readonly otherDiagnostic: string;
}

const EMIT_DIFFERENCE_ROWS: readonly EmitDifferenceRow[] = [
  {
    face: '事件表',
    owner: 'eratw',
    // 目录与口上模板**两张表都有**这一面，才编得出：`{i}` = COM 编号（段取表首键 `COM`）
    source: '# 机 指令 310\n\n> 带 COM 编号的事件只有 eraTW 有。\n',
    ownerArtifact: '@M_KOJO_MESSAGE_COM_K12_310',
    otherDiagnostic: 'event/unknown',
  },
  {
    face: '事件表',
    owner: 'erafl',
    // 反向的一行：EVENTLOAD 在 eraFL 是裸引擎事件；eraTW 的目录收录它、
    // 口上模板表却没有"读档"面 ⇒ 它报的是 backend-incomplete，**不是** event/unknown
    source: '# 机 读档\n\n> 读档完成后触发。\n',
    ownerArtifact: '@EVENTLOAD',
    otherDiagnostic: 'unit/backend-incomplete',
  },
];

describe('方言差异 · 各自事实 + 同一期望（不许拿 eraTW 的事实喂 eraFL）', () => {
  it('eraTW 独有的五个引擎事件在 eraFL 侧一律 event/unknown 且 0 字节', () => {
    const regs = registrations();
    for (const event of ['训练', '指令', '训练结束', '回合末', '指令结束']) {
      const source = `# 机 ${event}\n\n> 这条事件不在 eraFL 的树里。\n`;
      const result = compile(regs.erafl!.adapter, regs.erafl!.backend, source);
      expect(result.ok, event).toBe(false);
      expect(result.erb, event).toBe('');
      expect(result.diagnostics.map((item) => item.code), event).toContain('event/unknown');
    }
  });

  it('eraTW 的目录收录 eraFL 的四个事件，但落点面只认得「初见」——目录 ≠ 可落点', () => {
    const regs = registrations();
    const catalogNames = ERATW_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    for (const event of ['初见', '读档', '商店', '购买']) {
      // 共同面在**目录**这一层成立（四个名字都在 eraTW 的表里）……
      expect(catalogNames, `eraTW 目录缺 ${event}`).toContain(event);
      const source = `# 机 ${event}\n\n> 共同面。\n`;
      // ……eraFL 四个都能落点……
      const fl = compile(regs.erafl!.adapter, regs.erafl!.backend, source);
      expect(fl.ok, `erafl/${event}`).toBe(true);
      expect(fl.diagnostics, `erafl/${event}`).toEqual([]);
      // ……demo 只有一枚目录事件（它是最小 profile，多一枚就不是"最小"了）
      const demo = compile(regs.demo!.adapter, regs.demo!.backend, source);
      if (event === '初见') {
        expect(demo.ok, `demo/${event}`).toBe(true);
      } else {
        expect(demo.ok, `demo/${event}`).toBe(false);
        expect(demo.diagnostics.map((item) => item.code), `demo/${event}`).toContain('event/unknown');
      }
      // eraTW 的落点面只有「初见」（口上模板表 = v1 糖面）：其余三个是
      // `unit/backend-incomplete`（**认得出、落不下**），不是 `event/unknown`（认不出）。
      const tw = compile(regs.eratw!.adapter, regs.eratw!.backend, source);
      const codes = tw.diagnostics.map((item) => item.code);
      if (event === '初见') {
        expect(tw.ok, `eratw/${event}`).toBe(true);
        expect(codes, `eratw/${event}`).toEqual([]);
      } else {
        expect(tw.ok, `eratw/${event}`).toBe(false);
        expect(tw.erb, `eratw/${event}`).toBe('');
        expect(codes, `eratw/${event}`).toContain('unit/backend-incomplete');
        expect(codes, `eratw/${event} 把目录内事件报成不认识了`).not.toContain('event/unknown');
      }
    }
  });

  it('差异表逐行：拥有者编得出自己的事实，不拥有者报同一条码（同一期望）', () => {
    const regs = registrations();
    for (const row of EMIT_DIFFERENCE_ROWS) {
      const other = row.owner === 'eratw' ? 'erafl' : 'eratw';
      const owned = compile(regs[row.owner]!.adapter, regs[row.owner]!.backend, row.source);
      const rejected = compile(regs[other]!.adapter, regs[other]!.backend, row.source);
      expect(owned.ok, row.face).toBe(true);
      expect(owned.erb, row.face).toContain(row.ownerArtifact);
      expect(rejected.ok, row.face).toBe(false);
      expect(rejected.erb, row.face).toBe('');
      expect(rejected.diagnostics.map((item) => item.code), row.face).toContain(row.otherDiagnostic);
    }
  });

  it('代词落点：同一组角色、同一套 view 语义，落点各是各家事实（断声明面，不断产物）', () => {
    const shape = (list: GameAdapter['domainSymbols']['pronouns']) =>
      list.map((item) => `${item.role}/${String(item.requiresView)}/${String(item.viewBound)}`);
    // 同一期望：三个角色、谁需要 `# 视角`、是否与视点绑定——两侧逐字相同
    expect(shape(ERAFL_GAME_ADAPTER.domainSymbols.pronouns)).toEqual(
      shape(ERATW_GAME_ADAPTER.domainSymbols.pronouns),
    );
    // 各自事实：落点族与落点形完全不同（eraTW = `%CALLNAME:%` 指令族；eraFL = XML 具名记号族）
    expect(ERATW_GAME_ADAPTER.domainSymbols.pronouns.map((item) => item.engineRef)).toEqual([
      '%CALLNAME:TARGET%',
      '%CALLNAME:MASTER%',
      '%CALLNAME:TARGET%',
    ]);
    expect(ERAFL_GAME_ADAPTER.domainSymbols.pronouns.map((item) => item.engineRef)).toEqual([
      '[$KNAME]',
      '[$MNAME]',
      '[$TNAME]',
    ]);
    expect(ERATW_GAME_ADAPTER.domainSymbols.pronouns.every((item) => item.family === 'CALLNAME')).toBe(true);
    expect(ERAFL_GAME_ADAPTER.domainSymbols.pronouns.every((item) => item.family === 'XML-NAME')).toBe(true);
  });

  it('恒等表达式端口下代词差异**不出现在产物里**（落点要等宿主注入真管线才可见）', () => {
    const regs = registrations();
    const source = '# 机 初见\n# 视角 灵梦\n\n> 我是{我}。\n';
    for (const key of ['eratw', 'erafl'] as const) {
      const result = compile(regs[key]!.adapter, regs[key]!.backend, source);
      expect(result.ok, key).toBe(true);
      // 产物里是原样透传的 `%我%`——三列一样，所以这一格**不能**拿来证落点差异
      expect(result.erb, key).toContain('%我%');
      expect(result.erb, key).not.toContain('%CALLNAME:TARGET%');
      expect(result.erb, key).not.toContain('[$KNAME]');
    }
  });

  it('存储期三族在两侧同名同前缀（这一格**不是**差异——记下来，免得下次有人当差异改）', () => {
    const periods = (adapter: GameAdapter) =>
      adapter.storageClasses.classes.map((spec) => `${spec.period}:${spec.engine}:${spec.slotPrefix}`);
    expect(periods(ERAFL_GAME_ADAPTER)).toEqual(periods(ERATW_GAME_ADAPTER));
    expect(periods(ERATW_GAME_ADAPTER)).toHaveLength(3);
  });
});

/* ============================== 4. 判据自查（别让空跑混过去） ============================== */

describe('共享列 · 判据自查', () => {
  it('fixture 形状：每条共享用例恰好一条 `# 机 初见`，且在第一个非空行', () => {
    for (const entry of LANGUAGE_SHARED_SUITE) {
      const source = readFileSync(
        fileURLToPath(new URL(`./fixtures/language-shared/${entry.file}.kojo2`, import.meta.url)),
        'utf8',
      );
      const lines = source.split(/\r?\n/);
      // `初见` 是三列**都**能落点的唯一一枚（eraTW 的落点面只有这一面，demo 的目录只有
      // 这一条）——共享列换成别的事件就会变成"共享面"的假象，故形状钉死事件名。
      expect(lines.filter((line) => /^\s*#\s*机/.test(line)), entry.id).toHaveLength(1);
      expect(lines[0], `${entry.id} 的 # 机 必须在第一行`).toMatch(/^# 机 初见$/);
    }
  });

  it('每一份 .body.erb 都非空（空 golden 等于这条没测到东西）', () => {
    for (const entry of LANGUAGE_SHARED_SUITE) {
      const body = readFileSync(
        fileURLToPath(new URL(`./fixtures/language-shared/${entry.file}.body.erb`, import.meta.url)),
        'utf8',
      );
      expect(body.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it('共享列的 runner 直接跑（不经 CLI）与 CLI 读数一致', () => {
    const regs = registrations();
    const direct = runLanguageSharedSuite({
      io,
      adapter: regs.erafl!.adapter,
      backend: regs.erafl!.backend,
      adapterLabel: 'erafl',
      backendLabel: 'erafl',
    });
    expect(direct.summary).toEqual(FL.report.summary);
    expect(direct.cases).toEqual(FL.report.cases);
  });
});
