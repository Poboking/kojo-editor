/**
 * eratohoReverse 约定规则（`GameAdapter.conventions`）——判据钉合成盘、命中钉真盘。
 *
 * 组织与 `eraav-adapter/tests/conventions.test.ts` 同一条路：合成用例证明判据会分黑白，
 * 真盘用例把 `src/conventions.ts` 头注里的读数逐条钉住；`conventionPolicy` 的
 * **前 / 后读数**跑成一轮真实校验（`convention-linter/src/engine.ts`，策略经
 * `getAdapterPolicy` 进去，与插件装配 `convention-linter/src/index.ts:78` 同一通道）。
 *
 * 真盘读数一律 **2026-10-26 从盘上现扫**（上一批有几处是从早先的散文报告转抄的，行号与站点
 * 都对不上盘——本批逐条重扫后钉死，见各 `it` 里的清单）。
 *
 * ## 解析器依赖怎么来（两条规则共用，别照抄成第二条语法）
 *
 * `[SKIPSTART]…[SKIPEND]` 区间里的 `@` 定义**压根不在** `ErbFile.functions` 里（解析器不解析死区），
 * 所以"遮蔽段里有多少条口上"只能由**同一语法的两次解析之差**得到（口径见 `src/conventions.ts` 头注）。
 * 生产路径由 `plugin.ts` 经服务键 `erb.parser` 注入（本包源码禁 import `@kojo/plugin-erb-parser`，
 * 审计 C 项）；测试文件有豁免 ⇒ 这里直接拿 `parseErbText` 当注入物，与索引同一个 scanner。
 * 缺席时的**出声**也有用例（最后一条 `it`），不许让规则用空数组冒充"判过了、没问题"（铁律 4）。
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
import { ERB_SKIP_MARKERS, erbCodeBodyOf } from '@kojo/plugin-api';
import { aggregateIndex, parseErbText } from '@kojo/plugin-erb-parser';
import { ConventionEngine } from '@kojo/plugin-convention-linter';
import {
  RULE_GHOST_CHARACTER_NO,
  RULE_KX_PLACEHOLDER,
  RULE_SKIPSTART_SHIELDED,
  RULE_UNTAGGED_FACE,
  createEratohoreverseConventions,
} from '../src/conventions';
import { GAME_ROOT, adapterOf, listFilesRecursive, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
/** 真盘那几条要现建 907 份 ERB 的索引 + 对含标记的 319 份做二次解析 ⇒ 放宽超时（vitest4 只认 `it(name, fn, ms)` 这一形） */
const REAL_TIMEOUT = 600_000;
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ROOT = 'C:/mem/eratohoReverse';
const ERB = nodeJoin(GAME_ROOT, 'ERB');

/** 装配注入物的测试替身（生产侧是 `erb.parser` 服务的 `parseText`，同一个 `parseErbText`） */
const withParser = createEratohoreverseConventions({
  parseText: (text, path) => parseErbText(text, path),
});
const RULE_GHOST = withParser[0]!;
const RULE_KX = withParser[1]!;
const RULE_SKIP = withParser[2]!;
const RULE_FACE = withParser[3]!;

function indexFrom(files: Record<string, string>): ErbIndex {
  return aggregateIndex(Object.entries(files).map(([path, text]) => parseErbText(text, path)));
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
        adapterId: 'eratohoreverse',
        kojoPaths: [nodeJoin(ROOT, 'ERB')],
        writablePaths: [],
        charaIndex: new Map<number, never>(),
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

/** 只填「哪些角色号存在」这一件事（本条规则的判据就是 `charaIndex.has(no)`） */
function projectWithNos(nos: readonly number[]): GameProject {
  return {
    rootDir: ROOT,
    adapterId: 'eratohoreverse',
    kojoPaths: [nodeJoin(ROOT, 'ERB')],
    writablePaths: [],
    charaIndex: new Map(nos.map((no) => [no, { no, name: `角色${no}` }])),
  };
}

function readReal(path: string): Promise<string> {
  // 真盘 907/907 带 BOM（本盘 39 份文件首行就是 `@` 定义）⇒ 与内核同口径先剥 BOM
  return Promise.resolve(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function realCtx(project: GameProject, index: ErbIndex): ConventionCheckContext {
  return { project, index, readFile: readReal, log: silentLog };
}

async function runRule(rule: ConventionRule, ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
  return rule.check ? await rule.check(ctx) : [];
}

async function runFileRule(
  rule: ConventionRule,
  ctx: ConventionCheckContext,
  index: ErbIndex,
): Promise<ConventionIssue[]> {
  const issues: ConventionIssue[] = [];
  for (const file of index.files.values()) issues.push(...((await rule.checkFile!(ctx, file)) ?? []));
  return issues;
}

function relOfReal(path: string): string {
  return path.replace(/\\/g, '/').replace(GAME_ROOT.replace(/\\/g, '/') + '/', '');
}

/**
 * **测试侧的取证尺子**（与 `src/conventions.ts` 的差集通道同一套判据，独立实现一遍）：
 * 只用来把盘上事实钉进断言（例如 `POSE.ERB` 那棵整文件存档里到底有哪些定义），
 * 不作为任何规则的判定入口——生产判定一律走被注入的 `erb.parser`。
 */
function shieldedNamesOfReal(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const body = erbCodeBodyOf(lines[i]!.trim());
    if (body === ERB_SKIP_MARKERS.start || body === ERB_SKIP_MARKERS.end) lines[i] = `;${body}`;
  }
  const seen = new Set(parseErbText(text, filePath).functions.map((f) => `${f.normalizedName}@${f.startLine}`));
  return parseErbText(lines.join('\n'), filePath)
    .functions.filter((f) => !seen.has(`${f.normalizedName}@${f.startLine}`))
    .map((f) => `${f.name}@${f.startLine}`);
}

/* ------------------------------ 真盘一次性索引 ------------------------------ */

let realIndexCache: ErbIndex | null = null;
function realIndex(): ErbIndex {
  if (realIndexCache) return realIndexCache;
  const paths = listFilesRecursive(ERB, /\.(erb|erh)$/i);
  realIndexCache = aggregateIndex(
    paths.map((p) => parseErbText(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''), p)),
  );
  return realIndexCache;
}
let realProjectCache: GameProject | null = null;
async function loadRealProject(): Promise<GameProject> {
  if (realProjectCache) return realProjectCache;
  realProjectCache = await adapterOf(nodeIo()).loadProject(GAME_ROOT);
  return realProjectCache;
}

/* ------------------------------ 规则 1：幽灵角色号 ------------------------------ */

describe('evrse.kojo.ghost-character-no', () => {
  const F = `${ROOT}/ERB/口上/0001_甲/KOJO_TRAIN_MESSAGE_K1.ERB`;

  it('号不在角色表里 → 1 条 warning，行号指向定义行', async () => {
    const text = '@KOJO_TRAIN_MESSAGE_K112_312\nPRINTL A\n';
    const files = { [F]: text };
    const ctx = ctxOf({ project: projectWithNos([0, 1, 2]), index: indexFrom(files), files });
    const issues = await runRule(RULE_GHOST, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: RULE_GHOST_CHARACTER_NO, severity: 'warning', line: 1 });
    expect(issues[0]!.message).toContain('112');
  });

  it('号在表里 / 解析不出号（路由终端、私有函数）/ 占位符 → 都不报', async () => {
    for (const name of ['KOJO_TRAIN_MESSAGE_K11_312', 'KOJO_ACT', 'WARD_A_K14', 'KOJO_REACT_KXX_44']) {
      const text = `@${name}\nPRINTL A\n`;
      const files = { [F]: text };
      const ctx = ctxOf({ project: projectWithNos([11, 14]), index: indexFrom(files), files });
      expect(await runRule(RULE_GHOST, ctx), name).toEqual([]);
    }
  });

  it('性别/立场前缀不是解析缺口：MALE 前缀照样锚得住号（真盘 39 号那条的形态）', async () => {
    const text = '@KOJO_MALE_TRAIN_MESSAGE_K392_312\nRETURN 0\n';
    const files = { [F]: text };
    const ctx = ctxOf({ project: projectWithNos([39]), index: indexFrom(files), files });
    const issues = await runRule(RULE_GHOST, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('392');
    expect(issues[0]!.family).toBe('TRAIN_MESSAGE'); // 立场层进 family 段、面仍是 TRAIN_MESSAGE
  });

  it('遮蔽段里的幽灵号也报（真盘第四条命中就在段内）；解析器缺席则整条抛错', async () => {
    const text = '[SKIPSTART]\n@KOJO_TRAIN_MESSAGE_K642_312\nRETURN 0\n[SKIPEND]\n';
    const files = { [F]: text };
    const ctx = ctxOf({ project: projectWithNos([64]), index: indexFrom(files), files });
    // 索引里一条定义都没有（解析器不解析死区）⇒ 只可能靠差集补集拿到
    expect([...ctx.index.files.values()][0]!.functions).toHaveLength(0);
    const issues = await runRule(RULE_GHOST, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(2);
    expect(issues[0]!.message).toContain('642');
    // 解析器缺席 ⇒ 抛错进 failedRules（铁律 4），不许返回空数组冒充"判过了、没问题"
    await expect(createEratohoreverseConventions()[0]!.check!(ctx)).rejects.toThrow(/erb\.parser/);
  });

  it.skipIf(!hasCorpus)(
    '真盘：4 条（112/142/392/642），全部位在不同深度的目录里（最深那条在第 4 层）',
    async () => {
      const project = await loadRealProject();
      const issues = await runRule(RULE_GHOST, realCtx(project, realIndex()));
      expect(issues).toHaveLength(4);
      const sites = issues.map((i) => `${relOfReal(i.filePath!)}:${i.line}`).sort();
      expect(sites).toEqual(
        [
          // 索引里的三条
          'ERB/口上/0011_フランドール/KOJO_TRAIN_MESSAGE_K11.ERB:1501',
          'ERB/口上/0014_アリス/KOJO_MESSAGE_K14/KOJO_TRAIN_MESSAGE_K14.ERB:2229',
          'ERB/口上/0039_雛/オトコ用/KOJO_MESSAGE_K39/KOJO_TRAIN_MESSAGE_K39.ERB:1064',
          // 遮蔽段里的一条（该文件 :21 开段、:956 收段 ⇒ 函数树/矩阵同样看不见它）
          'ERB/口上/0064_こいし/KOJO_TRAIN_MESSAGE_K64.ERB:954',
        ].sort(),
      );
      // 号口径覆盖目录口径：39 号那条在深度 4，eratohoK 的目录规则（≤3 层）会漏
      expect(issues.every((i) => i.severity === 'warning')).toBe(true);
      expect(new Set(issues.map((i) => i.ruleId))).toEqual(new Set([RULE_GHOST_CHARACTER_NO]));
    },
    REAL_TIMEOUT,
  );
});

/* ------------------------------ 规则 2：_KXX 占位符 ------------------------------ */

describe('evrse.kx-placeholder', () => {
  it('占位符形态由本包解析器裁决：_KXX 报、_K14 不报；同名多处聚合成一条', async () => {
    const A = `${ROOT}/ERB/口上/0014_アリス/限定無し_K14/REACT_04_羞恥_K14.ERB`;
    const B = `${ROOT}/ERB/口上/0014_アリス/KOJO_K14.ERB`;
    const files = {
      [A]: '@KOJO_REACT_KXX_44\nPRINTL A\n',
      [B]: '@KOJO_REACT_KXX_44\nPRINTL B\n@KOJO_REACT_K14_44\nPRINTL C\n',
    };
    const ctx = ctxOf({ index: indexFrom(files), files });
    const issues = await runRule(RULE_KX, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ruleId).toBe(RULE_KX_PLACEHOLDER);
    expect(issues[0]!.message).toContain('共 2 处');
    expect(issues[0]!.characterNo).toBe(14); // 路径段 `…_K14` 把号补回（family-index 口径 5）
  });

  it.skipIf(!hasCorpus)('真盘：整棵 ERB 只有 1 处，定义 @KOJO_REACT_KXX_44 在 14 号文件里', async () => {
    const project = await loadRealProject();
    const issues = await runRule(RULE_KX, realCtx(project, realIndex()));
    expect(issues).toHaveLength(1);
    expect(relOfReal(issues[0]!.filePath!)).toBe(
      'ERB/口上/0014_アリス/限定無し_K14/KOJO_REACT_K14/REACT_04_羞恥_K14.ERB',
    );
    expect(issues[0]!.line).toBe(1210);
    expect(issues[0]!.characterNo).toBe(14);
    expect(issues[0]!.message).toContain('KOJO_REACT_KXX_44');
  }, REAL_TIMEOUT);
});

/* ------------------------------ 规则 3：[SKIPSTART] 遮蔽段里的口上定义 ------------------------------ */

describe('evrse.skipstart-shielded-kojo', () => {
  const F = `${ROOT}/ERB/口上/0001_甲/KOJO_K1.ERB`;
  const OUTSIDE = `${ROOT}/ERB/TRAIN/POSE.ERB`;

  it('段内定义 → 每文件一条 info，正文带处数与首末行号；段外定义不算', async () => {
    const text = [
      '@KOJO_K1',
      'PRINTL A',
      '[SKIPSTART]',
      '@KOJO_ACT_K1_0',
      'PRINTL B',
      '@KOJO_REACT_K1_0',
      'PRINTL C',
      '[SKIPEND]',
      '@KOJO_COM_K1_0',
      'PRINTL D',
      '',
    ].join('\n');
    const files = { [F]: text };
    const ctx = ctxOf({ index: indexFrom(files), files });
    const file = [...ctx.index.files.values()][0]!;
    // 前提本身要成立：遮蔽段里的两条**不在**函数表里（所以判据只能是两次解析之差）
    expect(file.functions.map((f) => f.name)).toEqual(['KOJO_K1', 'KOJO_COM_K1_0']);
    const issues = await RULE_SKIP.checkFile!(ctx, file);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.message).toContain('2 个 @ 定义');
    expect(issues[0]!.line).toBe(4);
    expect(issues[0]!.message).toContain('存档'); // 措辞：作者有意下线，不许写成错误
  });

  it('口上域外的文件不判 / 无遮蔽标记不判 / 标记未闭合则算到文件末尾', async () => {
    const outside = { [OUTSIDE]: '[SKIPSTART]\n@KOJO_K1\n' };
    const outsideCtx = ctxOf({ index: indexFrom(outside), files: outside });
    expect(await RULE_SKIP.checkFile!(outsideCtx, [...outsideCtx.index.files.values()][0]!)).toEqual([]);

    const plain = { [F]: '@KOJO_K1\nPRINTL A\n' };
    const plainCtx = ctxOf({ index: indexFrom(plain), files: plain });
    expect(await RULE_SKIP.checkFile!(plainCtx, [...plainCtx.index.files.values()][0]!)).toEqual([]);

    const unclosed = { [F]: '[SKIPSTART]\n@KOJO_K1\n' };
    const unclosedCtx = ctxOf({ index: indexFrom(unclosed), files: unclosed });
    const issues = await RULE_SKIP.checkFile!(unclosedCtx, [...unclosedCtx.index.files.values()][0]!);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('1 个 @ 定义');
  });

  it('; 注释里的标记不算标记（与 scanner 的严格等值判据同一条），未闭合的标记才算到文件末尾', async () => {
    const commented = { [F]: ';[SKIPSTART]\n@KOJO_ACT_K1_0\nRETURN 0\n' };
    const commentedCtx = ctxOf({ index: indexFrom(commented), files: commented });
    expect(
      await RULE_SKIP.checkFile!(commentedCtx, [...commentedCtx.index.files.values()][0]!),
    ).toEqual([]);
  });

  it('正文读不到 → 抛错（不把 IO 故障编造成"这棵判过了、没问题"）', async () => {
    const files = { [F]: '[SKIPSTART]\n@KOJO_K1\n' };
    const ctx = ctxOf({ index: indexFrom(files), files: {} });
    await expect(RULE_SKIP.checkFile!(ctx, [...ctx.index.files.values()][0]!)).rejects.toThrow(/读取失败/);
  });

  it('解析器缺席 → 抛错（同一条铁律：差集拿不到就是没有结论）', async () => {
    const files = { [F]: '[SKIPSTART]\n@KOJO_K1\n' };
    const ctx = ctxOf({ index: indexFrom(files), files });
    const noParser = createEratohoreverseConventions()[2]!;
    await expect(noParser.checkFile!(ctx, [...ctx.index.files.values()][0]!)).rejects.toThrow(/erb\.parser/);
  });

  /**
   * 2026-10-26 现扫（不是转抄）：`ERB/口上` 636 份里 285 份含严格标记，命中 39 份 / 339 处。
   * 每格 = `相对路径=处数@首处行号`，按路径升序（规则侧也按行号升序取首处）。
   */
  const REAL_SKIP = [
    'ERB/口上/0010_レミリア/オトコ用/KOJO_COM_K10/COM_K10.ERB=17@924',
    'ERB/口上/0011_フランドール/KOJO_ACT_K11.ERB=13@5501',
    'ERB/口上/0011_フランドール/KOJO_REACT_K11.ERB=1@2474',
    'ERB/口上/0011_フランドール/関数_K11.ERB=2@67',
    'ERB/口上/0014_アリス/FUNCTION_K14/EV20用関数類_K14.ERB=1@465',
    'ERB/口上/0014_アリス/KOJO_MESSAGE_K14/KOJO_REACTION_MESSAGE_K14.ERB=64@22',
    'ERB/口上/0014_アリス/咲アリ_K14/KOJO_NO9_ACT_K14/NO9_ACT_05_奉仕_K14.ERB=1@3615',
    'ERB/口上/0014_アリス/咲アリ_K14/KOJO_NO9_EVENT_K14/NO9_EV7_8_首輪_妊娠イベント_K14.ERB=2@29',
    'ERB/口上/0014_アリス/咲アリ_K14/KOJO_NO9_REACT_K14/NO9_REACT_04_羞恥_K14.ERB=2@406',
    'ERB/口上/0014_アリス/咲アリ_K14/NO9_SHOP_K14.ERB=2@693',
    'ERB/口上/0014_アリス/限定無し_K14/KOJO_ACT_K14/ACT_01_愛撫_K14.ERB=1@1530',
    'ERB/口上/0014_アリス/限定無し_K14/KOJO_ACT_K14/ACT_コンビネーション_K14.ERB=6@205',
    'ERB/口上/0039_雛/KOJO_K39.ERB=2@129',
    'ERB/口上/0039_雛/オトコ用/KOJO_ACT_K39/ACT_01_愛撫_K39.ERB=1@34',
    'ERB/口上/0039_雛/オトコ用/KOJO_MESSAGE_K39/KOJO_TRAIN_MESSAGE_K39.ERB=4@458',
    'ERB/口上/0039_雛/オトコ用/KOJO_REACT_K39/REACT_K39.ERB=1@182',
    'ERB/口上/0044_諏訪子/KOJO_K44.ERB=1@109',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_ACT_K44/ACT_00_会話_K44.ERB=1@485',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_ACT_K44/ACT_06_加虐_K44.ERB=1@257',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_ACT_K44/ACT_07_異常_K44.ERB=2@141',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_ACT_K44/ACT_09_休憩_K44.ERB=1@94',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_ACT_K44/ACT_10_性奉_K44.ERB=1@804',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_ACT_K44/ACT_コンビネーション_K44.ERB=13@32',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_COM_K44/COM_K44.ERB=1@1416',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_REACT_K44/REACT_00_会話_K44.ERB=1@814',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_REACT_K44/REACT_06_加虐_K44.ERB=1@291',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_REACT_K44/REACT_07_異常_K44.ERB=2@159',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_REACT_K44/REACT_09_休憩_K44.ERB=1@132',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_REACT_K44/REACT_10_性奉_K44.ERB=1@282',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_REACT_K44/REACT_コンビネーション_K44.ERB=13@24',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_SUBACT_K44.ERB=5@226',
    'ERB/口上/0044_諏訪子/オトコ用/KOJO_TRAIN_K44/TRAIN_OTHERS_K44.ERB=2@167',
    'ERB/口上/0064_こいし/KOJO_ASSI_K64/ASSI_ACT_K64.ERB=1@359',
    'ERB/口上/0064_こいし/KOJO_COMMON_K64/COMMON_ACT_K64.ERB=1@23',
    'ERB/口上/0064_こいし/KOJO_COMMON_K64/COMMON_REACT_K64.ERB=1@20',
    'ERB/口上/0064_こいし/KOJO_K64.ERB=1@59',
    'ERB/口上/0064_こいし/KOJO_POSE_K64.ERB=1@9',
    'ERB/口上/0064_こいし/KOJO_TRAIN_MESSAGE_K64.ERB=166@26',
    'ERB/口上/0079_神子/KOJO_TRAIN_K79/TRAIN_OTHERS_K79.ERB=1@328',
  ];

  it.skipIf(!hasCorpus)(
    '真盘：339 处定义落在遮蔽段里、聚合成 39 条（每文件一条），全部在 ERB/口上 域内',
    async () => {
      const project = await loadRealProject();
      const index = realIndex();
      const issues = await runFileRule(RULE_SKIP, realCtx(project, index), index);
      const total = issues.reduce((n, i) => n + Number(/(\d+) 个 @ 定义/.exec(i.message)?.[1] ?? 0), 0);
      expect(issues).toHaveLength(39);
      expect(total).toBe(339);
      expect(issues.every((i) => i.severity === 'info')).toBe(true);
      expect(
        issues
          .map((i) => `${relOfReal(i.filePath!)}=${/(\d+) 个 @ 定义/.exec(i.message)![1]}@${i.line}`)
          .sort(),
      ).toEqual([...REAL_SKIP].sort());
      // 最大两棵：166 处（こいし）与 64 处（アリス）
      const biggest = [...issues]
        .sort((a, b) => Number(/(\d+) 个/.exec(b.message)![1]) - Number(/(\d+) 个/.exec(a.message)![1]))
        .slice(0, 2)
        .map((i) => `${relOfReal(i.filePath!)}=${/(\d+) 个 @ 定义/.exec(i.message)![1]}`);
      expect(biggest).toEqual([
        'ERB/口上/0064_こいし/KOJO_TRAIN_MESSAGE_K64.ERB=166',
        'ERB/口上/0014_アリス/KOJO_MESSAGE_K14/KOJO_REACTION_MESSAGE_K14.ERB=64',
      ]);
    },
    REAL_TIMEOUT,
  );
});

/* ------------------------------ 规则 4：本包未收录的面名 ------------------------------ */

describe('evrse.untagged-face', () => {
  const F = `${ROOT}/ERB/口上/0014_乙/EVENT_OTHERS_K14.ERB`;

  it('词表里的面不报；不在的按面名各报一条（措辞只说"暂未收录"，不说"未使用"）', async () => {
    const files = {
      [F]: '@KOJO_EV16_K14\nPRINTL A\n@KOJO_ACT_K14_0\nPRINTL B\n@KOJO_REACT_LUST_K14\nPRINTL C\n',
    };
    const ctx = ctxOf({ index: indexFrom(files), files });
    const issues = await runRule(RULE_FACE, ctx);
    expect(issues.map((i) => i.family).sort()).toEqual(['EV16', 'REACT_LUST']);
    for (const i of issues) {
      expect(i.severity).toBe('info');
      expect(i.message).toContain('本适配器暂未收录该面名');
      expect(i.message).not.toContain('未使用');
    }
  });

  it('同面多处定义 → 定位与清单都按（路径→行号）升序，跨轮可复现', async () => {
    const B = `${ROOT}/ERB/口上/0014_乙/B_EVENT_OTHERS_K14.ERB`;
    const files = {
      [B]: '@KOJO_EV16_K14\nPRINTL A\n',
      [F]: '@KOJO_EV16_K14\nPRINTL B\n',
    };
    const ctx = ctxOf({ index: indexFrom(files), files });
    const [one] = await runRule(RULE_FACE, ctx);
    const tail = (p: string): string => p.replace(/\\/g, '/').replace(`${ROOT}/ERB/口上/`, '');
    expect(one!.message).toContain('共 2 处定义');
    expect(`${tail(one!.filePath!)}:${one!.line}`).toBe('0014_乙/B_EVENT_OTHERS_K14.ERB:1');
    expect(/处定义：(.*?)）/.exec(one!.message)![1]!.split(' | ').map(tail)).toEqual([
      '0014_乙/B_EVENT_OTHERS_K14.ERB:1',
      '0014_乙/EVENT_OTHERS_K14.ERB:1',
    ]);
  });

  /**
   * 2026-10-26 现扫（上一批这里转抄了散文报告的站点，行号与站点都不是盘上的）：
   * 4 个面名 / 5 处定义；`EV16` 两处、报告点按路径升序落在**咲アリ**那棵（不是限定無し）。
   */
  const REAL_FACES: Record<string, { first: string; sites: string[] }> = {
    EV16: {
      first: 'ERB/口上/0014_アリス/咲アリ_K14/KOJO_NO9_EVENT_K14/NO9_EVENT_OTHERS_K14.ERB:592',
      sites: [
        'ERB/口上/0014_アリス/咲アリ_K14/KOJO_NO9_EVENT_K14/NO9_EVENT_OTHERS_K14.ERB:592',
        'ERB/口上/0014_アリス/限定無し_K14/KOJO_EVENT_K14/EVENT_OTHERS_K14.ERB:658',
      ],
    },
    EV16_1: {
      first: 'ERB/口上/0014_アリス/限定無し_K14/KOJO_EVENT_K14/EVENT_OTHERS_K14.ERB:663',
      sites: ['ERB/口上/0014_アリス/限定無し_K14/KOJO_EVENT_K14/EVENT_OTHERS_K14.ERB:663'],
    },
    REACT_LUST: {
      first: 'ERB/口上/0039_雛/オトコ用/KOJO_REACT_K39/REACT_10_性奉_K39.ERB:1913',
      sites: ['ERB/口上/0039_雛/オトコ用/KOJO_REACT_K39/REACT_10_性奉_K39.ERB:1913'],
    },
    TRAIN_MESSAGE_SKIP: {
      first: 'ERB/口上/0004_大妖精/KOJO_K4.ERB:52',
      sites: ['ERB/口上/0004_大妖精/KOJO_K4.ERB:52'],
    },
  };

  it.skipIf(!hasCorpus)(
    '真盘：4 个未收录面名 / 5 处定义（EV16 2 处 / EV16_1 / REACT_LUST / TRAIN_MESSAGE_SKIP 各 1 处），逐处钉站点',
    async () => {
      const project = await loadRealProject();
      const issues = await runRule(RULE_FACE, realCtx(project, realIndex()));
      expect(issues.map((i) => i.family).sort()).toEqual(['EV16', 'EV16_1', 'REACT_LUST', 'TRAIN_MESSAGE_SKIP']);
      for (const issue of issues) {
        const pin = REAL_FACES[issue.family!];
        expect(pin, String(issue.family)).toBeDefined();
        expect(`${relOfReal(issue.filePath!)}:${issue.line}`).toBe(pin!.first);
        expect(issue.severity).toBe('info');
        expect(/处定义：(.*?)），/.exec(issue.message)![1]!.split(' | ').map((s) => relOfReal(s)).sort()).toEqual(
          [...pin!.sites].sort(),
        );
      }
    },
    REAL_TIMEOUT,
  );
});

/* ------------------------------ conventionPolicy：真实一轮校验的前 / 后 ------------------------------ */

function engineFor(project: GameProject, index: ErbIndex, rules: readonly ConventionRule[], withPolicy: boolean) {
  const adapter = adapterOf(nodeIo());
  return new ConventionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => index,
    readFile: readReal,
    getAdapterRules: () => rules,
    getAdapterPolicy: () => (withPolicy ? adapter.conventionPolicy : undefined),
  });
}

describe('conventionPolicy 在真盘上的收敛效果（真实一轮校验）', () => {
  it.skipIf(!hasCorpus)(
    '一轮 = 整棵受管 ERB/（编辑器开项目时的同一覆盖面）；只收敛 EVENTFIRST / EVENTLOAD 两枚 #PRI',
    async () => {
      const project = await loadRealProject();
      const index = realIndex();
      const adapter = adapterOf(nodeIo());
      await adapter.loadProject(GAME_ROOT);
      const rules = adapter.conventions ?? [];
      const before = await engineFor(project, index, rules, false).run({ force: true });
      const after = await engineFor(project, index, rules, true).run({ force: true });
      const dup = (rep: typeof before) => rep.issues.filter((i) => i.ruleId === 'erb.duplicate-function');
      const suppressed = (rep: typeof before) =>
        dup(rep).filter((i) => i.message.startsWith('已按适配器策略收敛'));
      const visible = (rep: typeof before) => dup(rep).filter((i) => !i.message.startsWith('已按适配器策略收敛'));
      const visibleNames = (rep: typeof before) =>
        visible(rep).map((i) => /「(.+?)」/.exec(i.message)?.[1] ?? '').sort();

      // 读数（写进 `src/conventions.ts` 头注与交付回执）
      console.info(
        `[eratohoReverse lint] 整轮 before=${before.issues.length} after=${after.issues.length}；` +
          `erb.duplicate-function before=${dup(before).length} after=${dup(after).length}` +
          `（留痕 ${suppressed(after).length} 条）；规则命中：ghost=${
            after.issues.filter((i) => i.ruleId === RULE_GHOST_CHARACTER_NO).length
          } kx=${after.issues.filter((i) => i.ruleId === RULE_KX_PLACEHOLDER).length} skip=${
            after.issues.filter((i) => i.ruleId === RULE_SKIPSTART_SHIELDED).length
          } face=${after.issues.filter((i) => i.ruleId === RULE_UNTAGGED_FACE).length}`,
      );

      expect(before.failedRules).toEqual([]);
      expect(after.failedRules).toEqual([]);
      // 一轮真实校验在索引上只看得见 3 组同名（其余 84 组的第二份整棵在 [SKIPSTART] 里，见头注）
      expect(visibleNames(before)).toEqual(['EVENTFIRST', 'EVENTLOAD', 'EVENTTRAIN']);
      expect(dup(after).length).toBe(dup(before).length - 1);
      // (a) 两枚 #PRI 存在性钩子确实被收敛，并换回一条留痕
      expect(suppressed(after)).toHaveLength(1);
      expect(suppressed(after)[0]!.message).toContain('收敛 2 处预期重复');
      expect(visibleNames(after)).toEqual(['EVENTTRAIN']);
      // (b) `EVENTTRAIN` 式真重复（两处都不带 #PRI）照旧逐条可见
      expect(visible(after).some((i) => i.message.includes('COMMON_USEFUL.ERB'))).toBe(true);
      // (c) `MASTER_POSE` / `MASTER_POSE_ACT10`：**盘上确实各有两份，但内置重复规则看不见第二份**
      //（`POSE.ERB:1` 开段整棵存档 ⇒ 索引里这一族只剩 `MASTER_POSE.ERB` 那一份）。
      // 上一批把这条断言写成"重复照旧可见"，前提就不成立（不是收敛掉了，是压根没进过面）。
      // 这里把两侧事实同时钉住：索引只 1 处 + 差集补集里第 2 处逐行可见。
      expect(index.byName.defsOf('MASTER_POSE')?.map((r) => `${relOfReal(r.filePath)}:${r.startLine}`)).toEqual([
        'ERB/TRAIN/TRAINSYS/MASTER_POSE.ERB:2',
      ]);
      expect(index.byName.defsOf('MASTER_POSE_ACT10')?.map((r) => `${relOfReal(r.filePath)}:${r.startLine}`)).toEqual([
        'ERB/TRAIN/TRAINSYS/MASTER_POSE.ERB:873',
      ]);
      expect(visibleNames(after)).not.toContain('MASTER_POSE');
      const poseArchive = shieldedNamesOfReal(nodeJoin(ERB, 'TRAIN', 'TRAINSYS', 'POSE.ERB'));
      expect(poseArchive).toContain('MASTER_POSE@4');
      expect(poseArchive).toContain('MASTER_POSE_ACT10@848');
      // 策略清单**没有**为这一族开口（不许顺手抹看不见的重复）
      expect(JSON.stringify(adapter.conventionPolicy)).not.toContain('MASTER_POSE');
      expect(after.counts.warning).toBe(5); // 幽灵号 4 + 占位符 1
      expect(after.counts.error).toBe(0);
      expect(after.counts.info).toBe(45); // 重复 2（含 1 条留痕）+ 面名 4 + 遮蔽段 39
    },
    REAL_TIMEOUT,
  );
});
