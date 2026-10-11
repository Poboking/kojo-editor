import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ArchiveArrayVariable,
  ConditionExtractorService,
  ConditionIndex,
  ConventionLinterService,
  ErbParserService,
  GameProject,
  SnapshotSourceService,
  SnapshotWriteService,
  StateReplayService,
  SugarLiftApplyService,
  SugarLiftService,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createSavParserPlugin } from '@kojo/plugin-sav-parser';
import { createStateReplayPlugin } from '@kojo/plugin-state-replay';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';

/**
 * 真实工程集成冒烟 —— 直接检验各阶段验收标准：
 * - v0.1：「选定有效 eraTW 目录后：CHARA CSV 映射解析成功，能列出 kojoPaths 下全部文件与函数清单」；
 * - v0.2：「按角色/家族浏览 99k 函数」的前提（家族识别覆盖）+ 约定校验器在真实数据上产出问题；
 * - v0.2 第三批：条件谓词抽取（控制流 → 谓词 → 状态依赖 + adapter 变量字典标注）；
 * - v0.2 第四批：存档解析（扫描 + 浅解析 + 深解析，真实六档字节级回归）；
 * - v0.2 第五批：状态回放（快照 → 状态视图 → 谓词三值求值，真实角色 × 真实函数）。
 *
 * 真实游戏数据不入库：通过环境变量 `KOJO_SMOKE_PROJECT` 指定本地游戏目录；
 * 未设置时整组跳过（CI 安全）。
 */
const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

// 真实语料可能不含存档（`sav/` 缺失或为空）：存档解析 / 回放 / 注入三段无从验证，
// 但索引 / 校验 / 抽取 / 语法糖落盘 / 升糖应用与存档无关，不该被一并拖死。
// 目录名沿用本文件既有口径（§9.2 同样直接拼 `sav`）。
const SAVE_COUNT = (() => {
  if (!SMOKE_DIR) return 0;
  try {
    return readdirSync(nodeJoin(SMOKE_DIR, 'sav')).filter((n) => n.toLowerCase().endsWith('.sav')).length;
  } catch {
    return 0;
  }
})();

describe.skipIf(!SMOKE_DIR)('真实 eraTW 工程集成冒烟', () => {
  let appData: string;
  let kernel: Kernel;
  let project: GameProject;
  let extractor: ConditionExtractorService;
  let condIndex: ConditionIndex;

  beforeAll(async () => {
    appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-smoke-'));
    kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [
        createErbParserPlugin(),
        createEratwAdapterPlugin(),
        createConventionLinterPlugin(),
        createConditionExtractorPlugin(),
        createSavParserPlugin(),
        createStateReplayPlugin(),
        createKojoSugarPlugin(),
      ],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    project = await kernel.project.open(SMOKE_DIR!);
  }, 180_000);

  afterAll(async () => {
    if (kernel) await kernel.stop();
  }, 180_000);

  it(
    '接线 → onboarding → CHARA 映射 → 口上域全量函数索引 → 约定校验 → 条件抽取',
    async () => {
      // 1. 插件接线
      const states = new Map(kernel.plugins.list().map((s) => [s.id, s]));
      expect(states.get('erb-parser')?.status).toBe('active');
      expect(states.get('eratw-adapter')?.status).toBe('active');
      expect(states.get('convention-linter')?.status).toBe('active');
      expect(states.get('condition-extractor')?.status).toBe('active');
      expect(states.get('sav-parser')?.status).toBe('active');
      expect(states.get('state-replay')?.status).toBe('active');
      expect(states.get('kojo-sugar')?.status).toBe('active');

      // 2. onboarding（内核对全部 adapter 候选轮询 detect；open 已在 beforeAll 完成）
      expect(project.adapterId).toBe('eratw');
      expect(project.charaIndex.size).toBeGreaterThan(100);
      expect(project.charaIndex.get(1)?.kojoDir).toBeTruthy();
      expect(project.savDir).toBeTruthy();

      // 2.5 口上调用协议（v0.2 第十批）：路由表 → 槽位语义表（真实 KOJO_MESSAGE.ERB）
      const adapterContribution = kernel.slots.query('game.adapter').find((c) => c.adapter.gameId === 'eratw');
      const protocol = adapterContribution?.adapter.kojoCallProtocol;
      expect(protocol).toBeTruthy();
      const spSlots = protocol!.slotsFor('M_KOJO_ORTHODOX_SPEVENT_K49_2');
      expect(spSlots).not.toBeNull();
      expect(spSlots).toHaveLength(2); // 路由转发 (ARG:3,ARG:4) → 2 个数值槽
      expect(protocol!.slotsFor('M_KOJO_K49_陷落状态')).toBeNull(); // 家族外函数协议不认识

      // 3. 口上域全量索引（解析器在 project.opened 已自动构建，此处取用）
      const parser = kernel.services.get<ErbParserService>('erb.parser');
      const index = await parser.ensureIndex();
      expect(parser.currentIndex()).toBe(index);

      let totalFunctions = 0;
      let expressionFuncs = 0;
      for (const f of index.files.values()) {
        totalFunctions += f.functions.length;
        expressionFuncs += f.functions.filter((x) => x.isExpressionFunction).length;
      }

      // 实测规模（2026-10-09 逆向普查）：155 角色目录 / 2,285 ERB / 99,028 函数
      expect(index.files.size).toBeGreaterThan(1000);
      expect(totalFunctions).toBeGreaterThan(50000);

      // 抽样：灵梦的初始剧本函数应存在（K1 家族）
      const k1 = [...index.byName.keys()].filter((n) => n.includes('M_KOJO') && n.includes('_K1'));
      expect(k1.length).toBeGreaterThan(50);

      // 4. 家族识别覆盖率（FamilyIndexRule 对全量函数名）
      const adapterRule = kernel.slots.query('game.adapter')[0]?.adapter.functionFamilyIndex;
      expect(adapterRule).toBeTruthy();
      let matched = 0;
      let unmatched = 0;
      let placeholders = 0;
      const families = new Set<string>();
      // 导航地基（v0.2 第二批）：角色 → 家族 → 面 三维在真实数据上非平凡
      const byChara = new Map<number, { families: Set<string>; faces: Set<string>; count: number }>();
      for (const refs of index.byName.values()) {
        for (const ref of refs) {
          const m = adapterRule!.match(ref.name);
          if (m) {
            matched++;
            if (m.isPlaceholder) placeholders++;
            if (m.family) families.add(m.family);
            if (m.characterNo !== null) {
              let entry = byChara.get(m.characterNo);
              if (!entry) {
                entry = { families: new Set(), faces: new Set(), count: 0 };
                byChara.set(m.characterNo, entry);
              }
              entry.count++;
              entry.families.add(m.family);
              if (m.face) entry.faces.add(m.face);
            }
          } else {
            unmatched++;
          }
        }
      }
      const familyRate = matched / (matched + unmatched);
      expect(familyRate).toBeGreaterThan(0.95);

      // 三维导航前提：多数角色可归属；家族聚合与面聚合都非退化为单点
      expect(byChara.size).toBeGreaterThan(100);
      const multiFamilyCharas = [...byChara.values()].filter((e) => e.families.size > 1).length;
      expect(multiFamilyCharas).toBeGreaterThan(0);
      const multiFaceCharas = [...byChara.values()].filter((e) => e.faces.size > 3).length;
      expect(multiFaceCharas).toBeGreaterThan(50);
      const busiest = [...byChara.entries()].sort((a, b) => b[1].count - a[1].count)[0];

      // 5. 约定校验（v0.2 验收：真实数据上产出可操作问题清单）
      const linter = kernel.services.get<ConventionLinterService>(WellKnownServices.ConventionLinter);
      const report = await linter.run();
      expect(report.failedRules).toEqual([]); // 规则不得静默失败
      expect(report.ruleCount).toBe(7); // 引擎内置 2（同名函数 + 糖侧静态约定）+ adapter 5（含协议覆盖校验）
      expect(report.issues.length).toBeGreaterThan(0);

      const byRule = new Map<string, number>();
      for (const issue of report.issues) byRule.set(issue.ruleId, (byRule.get(issue.ruleId) ?? 0) + 1);

      // KX 占位符：实测千级（按去重函数名计，2026-10-09 普查=603）
      expect(byRule.get('eratw.kx-placeholder') ?? 0).toBeGreaterThan(100);
      // FORM 三连符号：收窄后只留真实事故（排除 `+++` 的有意主人名占位），实测个位数
      const formHits = byRule.get('eratw.form-triple-symbol') ?? 0;
      expect(formHits).toBeGreaterThan(0);
      expect(formHits).toBeLessThan(100);
      // 协议覆盖校验（v1.0 收口）：声明槽 vs 路由转发——真实语料基线 36 条
      // （均为 MESSAGE_PALAMCNG_{D,F}/COLOR 等无参家族上多声明的 1 个数值槽）
      expect(byRule.get('eratw.kojo-call-slot-coverage') ?? 0).toBe(36);

      // 6. 条件抽取（v0.2 第四批：控制流 → 谓词 → 状态依赖；schema 标注来自 adapter 变量字典）
      //    extractor/condIndex 住 describe 作用域：存档链路（§8/§9）复用同一份索引，不重复抽取
      extractor = kernel.services.get<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      condIndex = await extractor.ensureIndex();
      expect(condIndex.projectRoot).toBe(project.rootDir);

      // 规模断言（真实数据：20 万 IF / 4.5 万 SELECTCASE）
      expect(condIndex.stats.functions).toBeGreaterThan(50000);
      expect(condIndex.stats.predicates).toBeGreaterThan(100000);
      expect(condIndex.stats.functionsWithDeps).toBeGreaterThan(1000);
      // 解析降级率（opaque）：应远低于半数（宽容解析的目标是绝大多数可解析）
      expect(condIndex.stats.unparsed / condIndex.stats.predicates).toBeLessThan(0.2);

      // schema 标注生效：CFLAG:2（好感度）应被大量标注（变量字典来自游戏 CSV）
      let favDeps = 0;
      let schemaTagged = 0;
      let talentLove = 0;
      for (const fc of condIndex.byFunction.values()) {
        for (const d of fc.dependencies) {
          if (d.schema?.description) schemaTagged++;
          if (d.key === 'CFLAG:2' && d.schema?.description === '好感度') favDeps++;
          if (d.key === 'TALENT:恋慕') talentLove++;
        }
      }
      expect(schemaTagged).toBeGreaterThan(1000);
      expect(favDeps).toBeGreaterThan(10);
      expect(talentLove).toBeGreaterThan(10);

      // 单函数查询路径可用（取一个有依赖的函数，验证服务读路径）
      const sample = [...condIndex.byFunction.values()].find((f) => f.dependencies.length > 0);
      expect(sample).toBeTruthy();
      expect(extractor.functionConditions(sample!.normalizedName)).toBe(sample);

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 角色 ${project.charaIndex.size} | ERB 文件 ${index.files.size} | ` +
          `函数 ${totalFunctions}（含表达式函数 ${expressionFuncs}）| 去重名 ${index.byName.size}\n` +
          `[smoke] 家族识别 ${matched}/${matched + unmatched} = ${(familyRate * 100).toFixed(2)}% | ` +
          `家族数 ${families.size} | KX 占位符残留（去重名）${placeholders}\n` +
          `[smoke] 导航地基：可归属角色 ${byChara.size} | 多家族角色 ${multiFamilyCharas} | ` +
          `多面（>3）角色 ${multiFaceCharas} | ` +
          `最重角色 K${busiest?.[0]}（${busiest?.[1].count} 函数 / ${busiest?.[1].families.size} 家族）\n` +
          `[smoke] 约定校验 ${report.issues.length} 项 ` +
          `(error ${report.counts.error} / warning ${report.counts.warning} / info ${report.counts.info}) ` +
          `in ${report.durationMs}ms\n` +
          `[smoke] 分规则：${[...byRule.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}\n` +
          `[smoke] 条件抽取：扫描函数 ${condIndex.stats.functions} | 谓词 ${condIndex.stats.predicates} ` +
          `(未解析 ${condIndex.stats.unparsed}) | 含依赖函数 ${condIndex.stats.functionsWithDeps} | ` +
          `依赖条目 ${condIndex.stats.dependencies} | schema 标注 ${schemaTagged}（好感度 ${favDeps} / 恋慕 ${talentLove}） ` +
          `in ${condIndex.durationMs}ms`,
      );
    },
    180_000,
  );

  it.skipIf(SAVE_COUNT === 0)(
    `存档解析 → 状态回放 → 注入写链路（需语料含 sav/ 存档；本机实测 ${SAVE_COUNT} 档）`,
    async () => {
      // 7. 存档解析（v0.2 第四批：扫描 + 浅解析 + 深解析，真实六档字节级回归）
      const snapshots = kernel.services.get<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const scan = await snapshots.scan();
      expect(scan.dir).toBe(project.savDir);
      expect(scan.entries.length).toBe(6); // global + save00-03 + save1000（本机实测基线）
      for (const e of scan.entries) expect(e.error).toBeUndefined();
      const byName = new Map(scan.entries.map((e) => [e.fileName, e]));

      // 浅解析元数据（saveMes 为引擎写入的时间戳 / 日期 / 地点串）
      const save03e = byName.get('save03.sav');
      expect(save03e?.meta?.fileType).toBe('normal');
      expect(save03e?.meta?.version).toBe(1808);
      expect(save03e?.meta?.charCount).toBe(168);
      expect(save03e?.meta?.saveMes).toContain('第 47日');
      const globalE = byName.get('global.sav');
      expect(globalE?.meta?.fileType).toBe('global');
      expect(globalE?.meta?.charCount).toBe(0);

      // 深解析 save03：零残余 + 角色区 + 主变量区（实测 540 = 484+36+17+2+1）
      const arch03 = await snapshots.parse(save03e!.path, { keepArrayCells: false });
      expect(arch03.remaining).toBe(0);
      expect(arch03.chars).toHaveLength(168);
      expect(arch03.vars).toHaveLength(540);

      // #DIM 分隔：内置 27/28 个 + #DIM 恒 65 个（魔改 CHARA 域全量序列化）
      const dimCounts = new Set(arch03.chars!.map((c) => c.vars.length - (c.dimSepIndex ?? 0)));
      expect([...dimCounts]).toEqual([65]);

      // MASTERNAME 条件保存（实测 7/168：角色有主人才写）
      const masterNameChars = arch03.chars!.filter((c) => c.vars.some((v) => v.key === 'MASTERNAME')).length;
      expect(masterNameChars).toBe(7);

      // RANDDATA = 随机数发生器快照（saveLen 625）；全零剪枝实证：save00 nonEmpty=0 / save03 全量
      const arch00 = await snapshots.parse(byName.get('save00.sav')!.path, { keepArrayCells: false });
      const rand00 = arch00.vars!.find((v) => v.type === 'int-array-1d' && v.key === 'RANDDATA') as
        | ArchiveArrayVariable
        | undefined;
      expect(rand00?.saveLen).toEqual([625]);
      expect(rand00?.nonEmpty).toBe(0);
      const rand03 = arch03.vars!.find((v) => v.type === 'int-array-1d' && v.key === 'RANDDATA') as
        | ArchiveArrayVariable
        | undefined;
      expect(rand03?.nonEmpty).toBe(625);

      // MONEY 十亿级（0xD2 Int64 路径在真实数据上工作）
      const arch03b = await snapshots.parse(save03e!.path, { maxCellsPerArray: 4 });
      const money = arch03b.vars!.find((v) => v.key === 'MONEY') as ArchiveArrayVariable | undefined;
      expect(money?.type).toBe('int-array-1d');
      expect(Number(money!.cells[0]!.value)).toBeGreaterThan(1_000_000_000);

      // EM 扩展区实测：save03 两张 DT 表
      expect(arch03.emVars?.map((v) => v.key).sort()).toEqual(['DT_UFUFU_LOG', 'DT_UFUFU_M_LOG']);

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 存档解析：扫描 ${scan.entries.length} 档（${scan.durationMs}ms）| ` +
          `save03 角色 ${arch03.chars!.length} | 主变量 ${arch03.vars!.length} | ` +
          `#DIM ${[...dimCounts][0]} | MASTERNAME ${masterNameChars} | ` +
          `RANDDATA save00=${rand00?.nonEmpty} save03=${rand03?.nonEmpty} | ` +
          `EM ${arch03.emVars?.length} 表 | 残余 ${arch03.remaining}B`,
      );

      // 8. 状态回放（v0.2 第五批：快照 → 状态视图 → 谓词三值求值）
      const replay = kernel.services.get<StateReplayService>(WellKnownServices.StateReplay);
      const view = await replay.createView(save03e!.path, 49); // save03 × 古明地觉（K49）
      expect(view.characterNo).toBe(49);
      expect(view.characterName).toContain('觉');

      // 变量读取原语：TARGET 补位 / 全局 [0] 等价 / 角色标量 / 稀疏缺省
      const read = (name: string, indices: string[] = []) => view.read({ name, indices, text: name });
      const day = read('DAY');
      expect(day.kind).toBe('value');
      if (day.kind === 'value') expect(day.value).toBe(47); // save03 = 第 47 日（与 saveMes 互证）
      const no = read('NO');
      if (no.kind === 'value') expect(no.value).toBe(49);
      const favor = read('CFLAG', ['2']); // 好感度（TARGET 补位 = 觉）
      expect(favor.kind).toBe('value');
      const master = read('CFLAG', ['MASTER', '2']); // MASTER 指针（昴 = 0 号）
      expect(master.kind).toBe('value');

      // 批量回放 K49（古明地觉）含状态依赖的函数（真实谓词明细 + 真实快照）
      const k49Fns = [...condIndex.byFunction.keys()].filter((n) => n.includes('_K49_'));
      expect(k49Fns.length).toBeGreaterThan(0);
      const replays = await replay.replayFunctions(view, k49Fns);
      const nonNull = replays.filter((r) => r !== null);
      expect(nonNull.length).toBeGreaterThanOrEqual(k49Fns.length - 2); // 明细解析允许极少数失败

      let exact = 0;
      let partial = 0;
      let allUnknown = 0;
      let predTotal = 0;
      let hit = 0;
      let miss = 0;
      let unknown = 0;
      const unknownByCode = new Map<string, number>();
      for (const r of nonNull) {
        if (r!.confidence === 'exact') exact++;
        else if (r!.confidence === 'partial') partial++;
        else allUnknown++;
        predTotal += r!.stats.total;
        hit += r!.stats.hit;
        miss += r!.stats.miss;
        unknown += r!.stats.unknown;
        for (const p of r!.predicates) {
          if (p.outcome.kind === 'unknown') {
            const c = p.outcome.unknown.code;
            unknownByCode.set(c, (unknownByCode.get(c) ?? 0) + 1);
          }
        }
      }
      expect(predTotal).toBeGreaterThan(0);
      expect(hit + miss).toBeGreaterThan(0); // 至少按快照作出确定判定
      // v0.2 第七批守门：内联求值（口上域 #FUNCTION 纯助手顺序解释）应显著压低未知率
      // （第五批 62.9% → 第六批 48.5% → 第七批实测 32.0%）
      expect(unknown / predTotal).toBeLessThan(0.4);

      // —— 本地量数据流（第六批）：`IF LOCAL`（直线赋值 LOCAL = 1）应为确定真
      const sp2 = await replay.replayFunction(view, 'M_KOJO_ORTHODOX_SPEVENT_K49_2');
      expect(sp2).not.toBeNull();
      const localPred = sp2!.predicates.find((p) => p.text === 'LOCAL');
      expect(localPred?.outcome.kind).toBe('true');

      // —— 分支走向（第九批）：`IF LOCAL / ELSEIF…` 链应折叠出确定走向
      expect(sp2!.branches.length).toBeGreaterThan(0);
      const localChain = sp2!.branches.find((b) => b.members.some((m) => m.text === 'LOCAL'));
      expect(localChain).toBeTruthy();
      expect(localChain!.outcome).toBe('taken');
      expect(localChain!.takenLine).not.toBeNull();

      // —— 调用上下文（第六批）：无上下文 → unknown('call-context')；
      //    注入 ints=[undefined, 36]（约会对象编号）→ `ARG:1 >= 36 && ARG:1 <= 38` 确定真
      const ev1 = await replay.replayFunction(view, 'M_KOJO_ORTHODOX_EVENT_K49_1');
      expect(ev1).not.toBeNull();
      const argPred = ev1!.predicates.find((p) => p.text.includes('ARG:1 >= 36'));
      expect(argPred).toBeTruthy();
      expect(argPred!.outcome.kind).toBe('unknown');
      if (argPred!.outcome.kind === 'unknown') {
        expect(argPred!.outcome.unknown.code).toBe('call-context');
      }
      const ev1c = await replay.replayFunction(view, 'M_KOJO_ORTHODOX_EVENT_K49_1', {
        callContext: { ints: [undefined, 36] },
      });
      const argPredC = ev1c!.predicates.find((p) => p.text.includes('ARG:1 >= 36'));
      expect(argPredC?.outcome.kind).toBe('true');

      // —— 内联求值（第七批）：口上域 #FUNCTION 纯助手（陷落状态等）调用应可判定。
      //    任取含「陷落状态」调用的 K49 谓词，其 call 不再 unknown（call 桶 2,297 → 368）。
      const calleeStats = new Map<string, { total: number; callUnknown: number }>();
      for (const fn of k49Fns.slice(0, 400)) {
        const d = await extractor.functionPredicates(fn);
        if (!d) continue;
        const r = await replay.replayFunction(view, fn);
        if (!r) continue;
        for (const p of r.predicates) {
          if (p.text.includes('陷落状态') || p.text.includes('陥落状態')) {
            const key = fn;
            const s = calleeStats.get(key) ?? { total: 0, callUnknown: 0 };
            s.total++;
            if (p.outcome.kind === 'unknown' && p.outcome.unknown.code === 'call') s.callUnknown++;
            calleeStats.set(key, s);
          }
        }
      }
      expect(calleeStats.size).toBeGreaterThan(0);
      const callUnknownTotal = [...calleeStats.values()].reduce((s, x) => s + x.callUnknown, 0);
      // 陷落状态在口上域内（内联可达）；残余 call unknown 只可能来自嵌套实参 unknown
      const sampled = [...calleeStats.values()].reduce((s, x) => s + x.total, 0);
      expect(callUnknownTotal / sampled).toBeLessThan(0.5);

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 状态回放：K49 函数 ${k49Fns.length} | 谓词 ${predTotal} ` +
          `(命中 ${hit} / 未命中 ${miss} / 未知 ${unknown}) | ` +
          `置信度 exact ${exact} / partial ${partial} / unknown ${allUnknown} | ` +
          `未知分类 ${[...unknownByCode.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')} | ` +
          `DAY=${day.kind === 'value' ? day.value : '?'} 好感(CFLAG:2)=${favor.kind === 'value' ? favor.value : '?'}`,
      );

      // 9. 注入写链路（v0.2 第十五批）：双闸 + 备份 + 回读验证（写目标 = 副本，绝不碰真实档）
      const writer = kernel.services.get<SnapshotWriteService>(WellKnownServices.SnapshotWriter);
      expect(writer).toBeTruthy();

      // 9.1 第一道闸：测试未批准任何 writablePaths → 真实档路径显式拒绝（不静默）
      await expect(writer.inject(save03e!.path, {})).rejects.toThrow(/not allowed/i);

      // 9.2 副本端到端：save00 字节复制到 appData 临时域并放行，标量注入 → 回读验证
      kernel.io.setWritableRoots([appData]);
      const copyPath = nodeJoin(appData, 'inject-copy.sav');
      writeFileSync(copyPath, readFileSync(nodeJoin(SMOKE_DIR!, 'sav', 'save00.sav')));
      const archCopy = await snapshots.parse(copyPath, { keepArrayCells: true, keepRaw: true });
      const block0 = archCopy.chars![0]!;
      const scalar0 = block0.vars.find((v) => v.type === 'int');
      expect(scalar0).toBeTruthy();
      const injectOverrides = {
        chars: new Map([[block0.index, new Map([[scalar0!.key, 424242]])]]),
      };
      const injected = await writer.inject(copyPath, injectOverrides);
      expect(injected.path).toBe(copyPath);
      expect(injected.verifiedCount).toBe(1);
      expect(injected.backupPath).toBeTruthy(); // 写前备份（{appData}/backup/）
      const archAfter = await snapshots.parse(copyPath, { keepArrayCells: true });
      const hitVar = archAfter.chars![0]!.vars.find((v) => v.key === scalar0!.key)!;
      expect((hitVar as { value: number }).value).toBe(424242);

      // 9.3 Int64 守卫：大数注入显式拒绝（副本字节零改动——守卫先于备份与写盘）
      const sizeBefore = injected.byteSize;
      await expect(
        writer.inject(copyPath, { chars: new Map([[block0.index, new Map([[scalar0!.key, 2 ** 60]])]]) }),
      ).rejects.toThrow(/安全整数/);
      const archGuard = await snapshots.parse(copyPath, { keepArrayCells: true });
      const guardVar = archGuard.chars![0]!.vars.find((v) => v.key === scalar0!.key)!;
      expect((guardVar as { value: number }).value).toBe(424242); // 仍是上一次注入值
      void sizeBefore;

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 注入写链路：副本标量注入 ${injected.verifiedCount} 项验证通过 ` +
          `（${injected.byteSize}B，备份 ${injected.backupPath ? '已建' : '无'}）；` +
          `越权拒绝与 Int64 守卫各 1 项 ✓`,
      );
    },
    180_000,
  );

  it(
    '语法糖编译落盘 → 升糖应用（与存档无关；无档语料同样必跑）',
    async () => {
      // 10. 语法糖编译落盘（v0.3 批 S3）：.kojo 源 → 合规 .erb 双闸写 + 备份 + 回读
      //     写目标 = appData 临时域副本，**绝不写真实游戏目录**。
      const sugar = kernel.services.get<SugarTranspileService>(WellKnownServices.SugarTranspile);
      expect(sugar).toBeTruthy();

      // 10.1 纯转译仍可用（契约的纯函数面未回退）：真实语料级别的糖源 → 产物含函数定义
      const kojoSource = [
        '; K49 集成冒烟合成源',
        '角色: 49',
        '',
        '时机 指令 310：',
        '    「呀……！」',
        '    她缩了一下。 续',
        '',
      ].join('\n');
      const tr = sugar.transpile(kojoSource, { fileName: 'M_KOJO_K49_指令.kojo' });
      expect(tr.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(tr.erb).toContain('@M_KOJO_MESSAGE_COM_K49_310');

      // 10.2 第一道闸：未批准 appData 之外 → 真实游戏目录内目标显式拒绝（不静默）
      const realTarget = nodeJoin(SMOKE_DIR!, 'ERB', '口上・メッセージ関連', '個人口上', 'M_KOJO_K49_指令.ERB');
      kernel.io.setWritableRoots([]);
      await expect(sugar.compileToFile(kojoSource, realTarget)).rejects.toThrow(/not allowed/i);

      // 10.3 副本端到端：appData 临时域编译落盘 → BOM/LF/末尾换行 + 回读一致 + 目录自动创建
      kernel.io.setWritableRoots([appData]);
      const sugarOut = nodeJoin(appData, '個人口上', '049 集成冒烟', 'M_KOJO_K49_指令.ERB');
      const compiled = await sugar.compileToFile(kojoSource, sugarOut);
      expect(compiled.erbPath).toBe(sugarOut);
      expect(compiled.backupPath).toBeNull(); // 首次：目标不存在
      const outBytes = readFileSync(sugarOut);
      expect([outBytes[0], outBytes[1], outBytes[2]]).toEqual([0xef, 0xbb, 0xbf]); // BOM
      expect(outBytes[outBytes.length - 1]).toBe(0x0a); // 末尾换行
      expect(outBytes.includes(0x0d)).toBe(false); // LF（无 CR，与真实语料一致）
      expect(outBytes.length).toBe(compiled.byteSize);

      // 10.4 回读一致（经内核 io 读回并比对字节）——已验证在 compileToFile 内，
      //      此处再从内核 io 独立读一次，证明是真实落盘而非内存假象
      const reread = await kernel.io.readBytes(sugarOut);
      expect(reread.length).toBe(compiled.byteSize);

      // 10.5 二次编译同一目标 → 触发备份（{appData}/backup/），产物仍合规
      const compiled2 = await sugar.compileToFile(kojoSource, sugarOut);
      expect(compiled2.backupPath).toBeTruthy();
      const backedUp = readFileSync(compiled2.backupPath!);
      expect(backedUp.length).toBe(compiled.byteSize);

      // 10.6 编译拒绝：error 诊断（表达式 `当` 缺 `否则`）→ 不产半成品、零副作用
      const badSource = [
        '角色: 49',
        '',
        '时机 指令 311：',
        '    变量 = 当 TFLAG:193：',
        '        是 1 -> 10',
        '',
      ].join('\n');
      const badTarget = nodeJoin(appData, '個人口上', '049 集成冒烟', 'M_KOJO_K49_坏源.ERB');
      await expect(sugar.compileToFile(badSource, badTarget)).rejects.toThrow(/编译被拒绝/);
      expect(existsSync(badTarget)).toBe(false); // 半成品绝不落盘

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 语法糖编译落盘：副本端到端 ${compiled.byteSize}B（BOM+LF+末尾换行）✓ ` +
          `回读一致 ✓ 备份${compiled2.backupPath ? '已建' : '无'} ✓ ` +
          `越权拒绝 1 项 ✓ 编译拒绝零副作用 1 项 ✓`,
      );

      // 11. 升糖应用（v0.3 批 S5-UI）：**真实语料文件**上跑 扫描 → 应用 → 落盘 → 回读
      //     用真实口上 ERB 的**副本**（appData 临时域），绝不碰游戏目录。
      const liftSvc = kernel.services.get<SugarLiftService>(WellKnownServices.SugarLift);
      const applySvc = kernel.services.get<SugarLiftApplyService>(WellKnownServices.SugarLiftApply);
      expect(liftSvc).toBeTruthy();
      expect(applySvc).toBeTruthy();

      // 11.1 取一份真实口上文件做种子（**只读**；应用写到 appData 副本）
      //      选 K49 的日常系口上：形态干净（大量 `PRINTFORM{D}W/L 文本` 单行，
      //      1,266 个 PRINTFORM），且**真实**——不是合成源，冒烟才有意义。
      const realKojoErb = nodeJoin(
        SMOKE_DIR!,
        'ERB', '口上・メッセージ関連', '個人口上',
        '049 Satori [さとり]', 'さとり', 'M_KOJO_K49_日常系コマンド.ERB',
      );
      // 若真实语料里没有该文件（不同版本），退化为上面的合成源——冒烟仍有效
      const seedSource = existsSync(realKojoErb)
        ? (await kernel.io.readText(realKojoErb)).text
        : kojoSource;
      const seedLines = seedSource.split('\n').length;

      const liftResult = liftSvc!.liftSuggest({ source: seedSource, filePath: 'smoke.ERB' });
      // 自证性质：每一个候选都必须 `verified`（round-trip or nothing 不变量）
      expect(liftResult.candidates.every((c) => c.roundTrip.verified && c.confidence === 'verified')).toBe(true);
      // 真实语料上必须真的扫出候选（否则这条冒烟没有证明力）
      expect(liftResult.candidates.length).toBeGreaterThan(0);

      // 11.2 先在内存里应用（纯函数；不落盘）——校验"预览 = 落盘结果"的同一性
      const preview = applySvc!.apply({ source: seedSource, candidates: liftResult.candidates });
      expect(preview.appliedCount).toBe(liftResult.candidates.length);
      expect(preview.hunks).toHaveLength(liftResult.candidates.length);

      // 11.3 落盘到副本（appData 域；二次写触发备份）
      const copyKojo = nodeJoin(appData, '個人口上', '049 集成冒烟', 'lift-smoke.kojo');
      await kernel.io.writeBytes(copyKojo, new TextEncoder().encode(seedSource));
      kernel.io.setWritableRoots([appData]);
      const applied = await applySvc!.applyToFile(copyKojo, {
        source: seedSource,
        candidates: liftResult.candidates,
      });
      expect(applied.appliedCount).toBe(liftResult.candidates.length);
      expect(applied.backupPath).toBeTruthy(); // 副本已存在 → 写前备份

      // 11.4 回读：落盘内容 = 预览结果（字节级去 BOM 后比对；归一化末尾换行）
      //      编码口径 = BOM + LF + **恰好一个**末尾换行（`encodeErbBytes` 会先剥
      //      已有的尾换行再补一个，故这里同样先归一化再比）。
      const readBack = await kernel.io.readBytes(copyKojo);
      expect(readBack.length).toBe(applied.byteSize);
      expect([readBack[0], readBack[1], readBack[2]]).toEqual([0xef, 0xbb, 0xbf]);
      const readBackText = new TextDecoder().decode(readBack.slice(3));
      const norm = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);
      expect(norm(readBackText)).toBe(norm(preview.text));
      expect(readBackText.endsWith('\n')).toBe(true); // 末尾换行（POSIX）
      expect(readBackText.includes('\r')).toBe(false); // LF（无 CR）

      // 11.5 第一道闸：越权目标 → WriteNotAllowedError 原样传播（不吞不包）
      kernel.io.setWritableRoots([]);
      await expect(
        applySvc!.applyToFile(copyKojo, { source: seedSource, candidates: liftResult.candidates }),
      ).rejects.toMatchObject({ name: 'WriteNotAllowedError' });

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 升糖应用：真实口上 ${seedLines} 行 → 候选 ${liftResult.candidates.length} 条 ` +
          `（全部 verified；未建议 ${liftResult.skipped.length} 条显式列出）→ 落盘 ${applied.byteSize}B，` +
          `回读 == 预览 ✓ 备份已建 ✓ 越权拒绝 1 项 ✓`,
      );
    },
    180_000,
  );
});
