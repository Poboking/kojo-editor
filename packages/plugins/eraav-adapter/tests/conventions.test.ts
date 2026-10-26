/**
 * eraAV 约定规则（`GameAdapter.conventions`）——判据钉在合成盘，**每条命中钉在真盘**。
 *
 * 组织方式照 `erasqc-adapter/tests/conventions.test.ts` 与 `eratw-adapter/tests/conventions.test.ts`：
 * 合成用例证明"判据本身会分黑白"，真盘用例证明"这盘上量的数与文件头写的一致"。
 * 真盘那批同时把 `erb.duplicate-function` 的**前 / 后读数**跑成一轮真实校验
 * （引擎 = `convention-linter/src/engine.ts`，策略经 `getAdapterPolicy` 进去，
 * 与插件装配 `convention-linter/src/index.ts:78` 同一条通道，不另造判据）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFile,
  ErbIndex,
  GameProject,
} from '@kojo/plugin-api';
import { aggregateIndex, parseErbText } from '@kojo/plugin-erb-parser';
import { ConventionEngine } from '@kojo/plugin-convention-linter';
import {
  RULE_ANNOTATION_NO_CONFLICT,
  RULE_CHARA_DUPLICATE_SHADOW,
  RULE_NON_ERB_IN_KOJO_DOMAIN,
  RULE_ROUTER_FACE_MISSING,
  createEraavConventions,
} from '../src/conventions';
import type { EraavKojoScan } from '../src/kojo-scan';
import { GAME_ROOT, adapterOf, listFilesRecursive, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
/** 真盘那几条要现建 471 份 ERB 的索引（首轮 17–20 s）⇒ 放宽超时（vitest4 只认 `it(name, fn, ms)` 这一形） */
const REAL_TIMEOUT = 240_000;
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ROOT = 'C:/mem/eraAV';
const ERB = nodeJoin(GAME_ROOT, 'ERB');

/* ------------------------------ 合成盘脚手架 ------------------------------ */

function indexFrom(files: Record<string, string>): ErbIndex {
  const parsed = Object.entries(files).map(([path, text]) => parseErbText(text, path));
  return aggregateIndex(parsed);
}

function ctxOf(
  partial: {
    project?: GameProject;
    index?: ErbIndex;
    files?: Record<string, string>;
    policy?: ConventionCheckContext['policy'];
  } = {},
): ConventionCheckContext {
  const files = partial.files ?? {};
  return {
    project:
      partial.project ??
      ({
        rootDir: ROOT,
        adapterId: 'eraav',
        kojoPaths: [nodeJoin(ROOT, 'ERB')],
        writablePaths: [],
        charaIndex: new Map(),
      }) satisfies GameProject,
    index: partial.index ?? indexFrom(files),
    readFile: async (path: string) => {
      const text = files[path.replace(/\\/g, '/')];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return text;
    },
    log: silentLog,
    ...(partial.policy ? { policy: partial.policy } : {}),
  };
}

/** 真盘读文本（剥 BOM 与内核同口径——本盘的 33 份文件首行就是 `@` 定义，见 `src/conventions.ts` 头注） */
function readReal(path: string): Promise<string> {
  return Promise.resolve(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function realCtx(project: GameProject, index: ErbIndex): ConventionCheckContext {
  return { project, index, readFile: readReal, log: silentLog };
}

async function runRule(
  rule: ConventionRule,
  ctx: ConventionCheckContext,
): Promise<ConventionIssue[]> {
  if (rule.check) return await rule.check(ctx);
  return [];
}

/** 相对真盘根的路径（断言里用正斜杠，跨主机可读） */
function relOfReal(path: string): string {
  return path.replace(/\\/g, '/').replace(GAME_ROOT.replace(/\\/g, '/') + '/', '');
}

/* ------------------------------ 真盘一次性索引 ------------------------------ */

let realIndexCache: ErbIndex | null = null;
/** 真盘 ERB 全量索引（与生产同一入口：`parseErbText` → `aggregateIndex`，471 份只解析一次） */
function realIndex(): ErbIndex {
  if (realIndexCache) return realIndexCache;
  const paths = listFilesRecursive(ERB, /\.(erb|erh)$/i);
  realIndexCache = aggregateIndex(
    paths.map((p) => parseErbText(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''), p)),
  );
  return realIndexCache;
}

/* ------------------------------ 规则 1：同名遮蔽 ------------------------------ */

describe('eraav.kojo.chara-duplicate-shadow', () => {
  const rule = createEraavConventions()[0]!;
  const A = `${ROOT}/ERB/Lines/A.ERB`;
  const B = `${ROOT}/ERB/Lines/B.ERB`;

  it('两处同名、都无 #PRI/#LATER → 1 条 warning，正文列出两处地址', async () => {
    const ctx = ctxOf({
      index: indexFrom({
        [A]: '@MISSION_RECEIVE_150\nCALL FOO(1)\n',
        [B]: '@MISSION_RECEIVE_150\nCALL FOO(1)\n',
      }),
      files: { [A]: '@MISSION_RECEIVE_150\nCALL FOO(1)\n', [B]: '@MISSION_RECEIVE_150\nCALL FOO(1)\n' },
    });
    const issues = await runRule(rule, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: RULE_CHARA_DUPLICATE_SHADOW, severity: 'warning', line: 1 });
    expect(issues[0]!.message).toContain('2 处定义');
    expect(issues[0]!.message).toContain(`${B}:1`);
  });

  it('组内任一处带 #PRI 或 #LATER → 判成本作的成对写法，整组不报', async () => {
    for (const directive of ['#PRI', '#LATER', '#pri FLAG:7 = 0']) {
      const files = {
        [A]: `@EVENTTRAIN\n${directive}\nSIF FLAG:7 == 0\n`,
        [B]: '@EVENTTRAIN\nSIF NO:TARGET != 1\nRETURN 0\n',
      };
      const withIndex = ctxOf({ index: indexFrom(files), files });
      expect(await runRule(rule, withIndex), directive).toEqual([]);
    }
  });

  it('单处定义 → 无结论可出；两处同名而正文读不到 → 抛错进 failedRules（不把 IO 故障编造成"没问题"）', async () => {
    const single = ctxOf({ files: { [A]: '@FOO\nBAR\n' } });
    expect(await runRule(rule, single)).toEqual([]);
    const files = { [A]: '@FOO\nBAR\n', [B]: '@FOO\nBAR\n' };
    const broken = ctxOf({ index: indexFrom(files), files: {} });
    await expect(rule.check!(broken)).rejects.toThrow(/读取失败/);
  });

  it.skipIf(!hasCorpus)('真盘：同名 4 组 / 71 处多余定义里，无判定的只有 1 组 2 处（MISSION_RECEIVE_150）', async () => {
    const issues = await runRule(rule, realCtx(await loadRealProject(), realIndex()));
    expect(issues).toHaveLength(1);
    const hit = issues[0]!;
    expect(hit.severity).toBe('warning');
    expect(hit.message).toContain('2 处定义');
    const mission = nodeJoin(ERB, 'MISSION', 'EXMISSIONC');
    expect(relOfReal(hit.filePath!)).toBe('ERB/MISSION/EXMISSIONC/MISSION_150_MINAMIEND.ERB');
    expect(hit.line).toBe(140);
    expect(hit.message).toContain(nodeJoin(mission, 'MISSION_150_MINAMIEND.ERB') + ':140');
    expect(hit.message).toContain(nodeJoin(mission, 'MISSION_203_埃利亞與克莉絲.erb') + ':149');
  }, REAL_TIMEOUT);
});

/* ------------------------------ 规则 2：主路由必配面缺席 ------------------------------ */

describe('eraav.router-face-missing', () => {
  const routerPath = `${ROOT}/ERB/EVENT/EVENT_K.ERB`;
  const kojoPath = `${ROOT}/ERB/Lines/EVENT_K01_甲.ERB`;
  const kojoPath2 = `${ROOT}/ERB/Lines/EVENT_K05_乙.ERB`;
  const ROUTER = [
    '@KOJO_MESSAGE_COM',
    'TRYCALLFORM KOJO_MESSAGE_COM_{NO:TARGET}',
    '@KOJO_MESSAGE_PALAMCNG',
    'TRYCALLFORM KOJO_MESSAGE_PALAMCNG_{NO:TARGET}',
    '@SINGLE_ENDING',
    'TRYCALLFORM SINGLE_ENDING_K{NO:TARGET}',
    '@KOJO_LESPLAY,ARG,ARG:1',
    'TRYCCALLFORM KOJO_LESPLAY_{NO:ARG},ARG:1',
    'CATCH',
    'CALL MAEKOJO_LESPLAY,ARG,ARG:1',
    'ENDCATCH',
    '',
  ].join('\n');

  function scanOf(entries: EraavKojoScan['kojoFiles'], nonErb: string[] = []): () => EraavKojoScan | undefined {
    return () => ({ kojoFiles: entries, nonErbFiles: nonErb });
  }

  it('必配面集从路由正文现读：TRYCALLFORM 算、TRYCCALLFORM/CATCH 不算、全盘无正体定义的死路由不算', async () => {
    const files: Record<string, string> = {
      [routerPath]: ROUTER,
      [kojoPath]: '@KOJO_MESSAGE_COM_1\nBAR\n', // 只有 COM 有定义 ⇒ PALAMCNG 是"活面"、SINGLE_ENDING 是死路由
      [kojoPath2]: '@KOJO_MESSAGE_PALAMCNG_5\nBAR\n',
    };
    const ctx = ctxOf({ index: indexFrom(files), files });
    const scan = scanOf([
      { no: 1, path: kojoPath, label: '甲' },
      { no: 5, path: kojoPath2, label: '乙' },
    ]);
    const rule = createEraavConventions(scan)[1]!;
    const issues = await runRule(rule, ctx);
    const byNo = issues.map((i) => `${i.characterNo}:${i.family}`);
    // 1 号缺 PALAMCNG（5 号有 ⇒ 活面）；SINGLE_ENDING 全盘 0 正体 ⇒ 不配当必配；LESPLAY 走 CATCH ⇒ 不计
    expect(byNo.sort()).toEqual(['1:MESSAGE_PALAMCNG', '5:MESSAGE_COM']);
    expect(issues.every((i) => i.severity === 'info')).toBe(true);
  });

  it('清单没备好（未加载工程）→ 本轮无结论，不拿空数组冒充"查过"', async () => {
    const rule = createEraavConventions(() => undefined)[1]!;
    const files = { [routerPath]: ROUTER, [kojoPath]: '@KOJO_MESSAGE_COM_1\n' };
    expect(await runRule(rule, ctxOf({ index: indexFrom(files), files }))).toEqual([]);
  });

  it.skipIf(!hasCorpus)(
    '真盘：主路由五条 TRYCALLFORM 面里 4 条是活面，缺的全在 30 号（PALAMCNG / MARKCNG / SELF_KOJO 各一条）',
    async () => {
      const project = await loadRealProject();
      const adapter = adapterOf(nodeIo());
      await adapter.loadProject(GAME_ROOT);
      const rules = adapter.conventions ?? [];
      const rule = rules.find((r) => r.id === RULE_ROUTER_FACE_MISSING);
      expect(rule, '适配器没挂上必配面规则').toBeDefined();
      const issues = await runRule(rule!, realCtx(project, realIndex()));
      expect(issues.map((i) => `${i.characterNo}:${i.family}`).sort()).toEqual([
        '30:MESSAGE_MARKCNG',
        '30:MESSAGE_PALAMCNG',
        '30:SELF_KOJO',
      ]);
      for (const i of issues) {
        expect(i.severity).toBe('info');
        expect(relOfReal(i.filePath!)).toBe('ERB/Lines/EVENT_K30_文野柚香.ERB');
        expect(i.line).toBeGreaterThan(0);
      }
    },
    REAL_TIMEOUT,
  );
});

/* ------------------------------ 规则 3：行尾注释号矛盾 ------------------------------ */

describe('eraav.annotation-no-conflict', () => {
  const rule = createEraavConventions()[2]!;
  const F = `${ROOT}/ERB/Lines/EVENT_K30_丙.ERB`;

  it('注释声称的号 ≠ 函数名锚定的号 → 1 条 info，行号指向定义行', async () => {
    const text = '@KOJO_MESSAGE_COM_30 ;因为是由加子的番号是45，所以这里改成了45\nBAR\n';
    const file = parseErbText(text, F);
    const issues = await rule.checkFile!(ctxOf({ files: { [F]: text } }), file);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: RULE_ANNOTATION_NO_CONFLICT,
      severity: 'info',
      filePath: F,
      line: 1,
      characterNo: 30,
    });
    expect(issues[0]!.message).toContain('45');
  });

  it('一致 / 无注释 / 任务号句式 / 非家族函数 → 都不报', async () => {
    const cases: string[] = [
      '@KOJO_MESSAGE_COM_10 ;因为是歌音的番号是10，所以这里改成了10\n',
      '@KOJO_MESSAGE_COM_10\n',
      '@MISSION_TITLE_150 ;这里的150是任务在内的番号，不要与已经存在的番号重复即可。下同\n',
      '@KOJO_MESSAGE_COM ;裸路由无号\n',
    ];
    for (const text of cases) {
      const file = parseErbText(text, F);
      expect(await rule.checkFile!(ctxOf({ files: { [F]: text } }), file), text).toEqual([]);
    }
  });

  it.skipIf(!hasCorpus)('真盘：带 ; 尾注的定义行 12 处（口上域 6 处），矛盾只有 EVENT_K30_文野柚香.ERB:341', async () => {
    const project = await loadRealProject();
    const index = realIndex();
    const issues: ConventionIssue[] = [];
    for (const file of index.files.values()) {
      issues.push(...(await rule.checkFile!(realCtx(project, index), file)));
    }
    expect(issues).toHaveLength(1);
    expect(relOfReal(issues[0]!.filePath!)).toBe('ERB/Lines/EVENT_K30_文野柚香.ERB');
    expect(issues[0]!.line).toBe(341);
    expect(issues[0]!.message).toContain('番号是45');
  }, REAL_TIMEOUT);
});

/* ------------------------------ 规则 4：口上域里的非 ERB 文件 ------------------------------ */

describe('eraav.non-erb-in-kojo-domain', () => {
  const linesRoot = nodeJoin(ROOT, 'ERB', 'Lines');
  const txt = nodeJoin(linesRoot, '说明.txt');
  const erh = nodeJoin(linesRoot, 'COMMON.ERH');

  it('非 ERB/ERH 文件 → 1 条 info；.ERH / .ERM 是域内合法文件不报', async () => {
    const rule = createEraavConventions(() => ({
      kojoFiles: [],
      nonErbFiles: [txt, erh],
    }))[3]!;
    const issues = await runRule(rule, ctxOf());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: RULE_NON_ERB_IN_KOJO_DOMAIN, severity: 'info', filePath: txt });
  });

  it.skipIf(!hasCorpus)('真盘：ERB/Lines 的 18 条目里非 ERB 只有 1 份 .txt', async () => {
    const adapter = adapterOf(nodeIo());
    const project = await adapter.loadProject(GAME_ROOT);
    const rule = (adapter.conventions ?? []).find((r) => r.id === RULE_NON_ERB_IN_KOJO_DOMAIN)!;
    const issues = await runRule(rule, realCtx(project, realIndex()));
    expect(issues).toHaveLength(1);
    expect(relOfReal(issues[0]!.filePath!)).toBe('ERB/Lines/想达成调教结束后表白效果.txt');
  }, REAL_TIMEOUT);
});

/* ------------------------------ 真实一轮校验：策略前 / 后 ------------------------------ */

let realProjectCache: GameProject | null = null;
async function loadRealProject(): Promise<GameProject> {
  if (realProjectCache) return realProjectCache;
  realProjectCache = await adapterOf(nodeIo()).loadProject(GAME_ROOT);
  return realProjectCache;
}

function engineFor(project: GameProject, index: ErbIndex, rules: readonly ConventionRule[], policyFlag: boolean) {
  const adapter = adapterOf(nodeIo());
  return new ConventionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => index,
    readFile: readReal,
    getAdapterRules: () => rules,
    // 与插件装配同一条通道：`convention-linter/src/index.ts:78` 读的就是适配器这个字段
    getAdapterPolicy: () => (policyFlag ? adapter.conventionPolicy : undefined),
  });
}

describe('conventionPolicy 在真盘上的收敛效果（真实一轮校验）', () => {
  it.skipIf(!hasCorpus)(
    'erb.duplicate-function 前 71 条 → 后 1 条真重复 + 2 条收敛留痕；整轮读数一并记下',
    async () => {
      const project = await loadRealProject();
      const index = realIndex();
      const adapter = adapterOf(nodeIo());
      await adapter.loadProject(GAME_ROOT);
      const rules = adapter.conventions ?? [];
      const before = await engineFor(project, index, rules, false).run({ force: true });
      const after = await engineFor(project, index, rules, true).run({ force: true });

      const dup = (rep: typeof before) => rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function');
      expect(dup(before)).toHaveLength(71);
      expect(dup(after)).toHaveLength(3);
      const summaries = dup(after).filter((i) => i.message.startsWith('已按适配器策略收敛'));
      expect(summaries).toHaveLength(2);
      expect(summaries.map((s) => s.filePath)).toEqual([undefined, undefined]);
      const stillReal = dup(after).filter((i) => !i.message.startsWith('已按适配器策略收敛'));
      expect(stillReal).toHaveLength(1);
      expect(relOfReal(stillReal[0]!.filePath!)).toBe('ERB/MISSION/EXMISSIONC/MISSION_203_埃利亞與克莉絲.erb');

      // 整轮（内置 2 条 + 本包 4 条）
      expect(before.failedRules).toEqual([]);
      expect(after.failedRules).toEqual([]);
      expect(after.issues.length).toBeLessThan(before.issues.length);
      expect(after.counts.warning).toBe(1); // 只有 chara-duplicate-shadow 一条 warning
      expect(after.counts.error).toBe(0);
    },
    REAL_TIMEOUT,
  );
});
