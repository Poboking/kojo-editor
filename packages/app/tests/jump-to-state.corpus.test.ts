/**
 * G1「看这一行的状态」· **真语料 + 真存档**端到端（2026-10-16 批）。
 *
 * 守门口径与 `packages/kernel/tests/integration-plugins.test.ts` 同款：
 * `KOJO_SMOKE_PROJECT`（首选）或 `KOJO_CORPUS_DIR`；两者都没给 ⇒ **整组 skip**
 * （不是 fail：语料目录名会变、也可能整目录暂离，挂空串会把 setup 全崩）。
 *
 * 这条链验的是"位置 ⇄ 记录"的**往返闭合**，两端各走自己的生产入口：
 *
 *   真存档 → 真状态视图 → 真函数回放（`state.replay`）
 *     → 取一条真谓词的行号 L
 *     → 宿主把 (文件, L) 经 `ui.editor.languageService` 槽的 documentSymbol
 *       折成函数名（`planJumpToState`，与 EditorPane 探针同一棵树、同一条判据）
 *     → 折回来的名字必须等于那条记录的 `normalizedName`（**同一个函数**）
 *     → 面板 `locateNoticeFor` 在这一行落到**真实存在的那一条**记录上
 *
 * 另加一条**代价**读数：语料里最大的那份文件上做一次位点折叠要多久
 * （这条键按下才取，不挂常驻监听；上限是回归护栏，不是性能宣称）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConditionExtractorService,
  EditorDocumentSymbol,
  EditorLanguageServiceContribution,
  ErbParserService,
  GameProject,
  SnapshotSourceService,
  StateReplayService,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '@kojo/kernel';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin, erbParserTasks, scanControlFlow } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { conditionExtractorTasks, createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createSavParserPlugin } from '@kojo/plugin-sav-parser';
import { createStateReplayPlugin } from '@kojo/plugin-state-replay';
import { planJumpToState } from '../src/ui/jump-to-state';
import { locateNoticeFor, readLineAt } from '../../plugins/ui-state-replay/src/panel-logic';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

describe.skipIf(!SMOKE)('G1 跳到命中状态 · 真语料端到端', () => {
  let kernel: Kernel;
  let project: GameProject;
  let appData: string;

  beforeAll(async () => {
    appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-g1-corpus-'));
    kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [
        createErbParserPlugin(),
        createEratwAdapterPlugin(),
        createConditionExtractorPlugin(),
        createSavParserPlugin(),
        createStateReplayPlugin(),
      ],
      storageBackend: new MemoryStorageBackend(),
    });
    // 并行计算任务表：**与生产装配同源**（`app/src/compute-tasks.ts` 逐项并入同一批插件导出的表；
    // 判据同 `packages/kernel/tests/integration-plugins.test.ts`）。PS-11 起单文件条件抽取整链
    // 走 `condition.extractFile`，而该任务是跨插件合成（扫描器住 erb-parser、抽取住
    // condition-extractor，审计 C 项不许 cross-import）⇒ 只有装配层能填这张表，插件自己注册不了。
    // 本测试自建裸内核，不注册就是逐文件 "No local implementation registered"、条件索引整片归零
    // ——下方那条 `predicatedNos` 前提会以最误导的方式红（"真语料里没有可判定函数"）。
    for (const [kind, impl] of Object.entries({
      ...erbParserTasks,
      ...conditionExtractorTasks(scanControlFlow),
    })) {
      kernel.compute.registerTask(kind, impl as never);
    }
    await kernel.start();
    project = await kernel.project.open(SMOKE!);
    await kernel.services.get<ErbParserService>('erb.parser').ensureIndex();
  }, 300_000);

  afterAll(async () => {
    if (kernel) await kernel.stop();
  }, 120_000);

  /** 与宿主 EditorPane 同一条取树入口：问 `ui.editor.languageService` 槽，按 name + 区间去重合并 */
  const collectSymbols = (path: string, text: string): EditorDocumentSymbol[] => {
    const request = {
      kind: 'documentSymbol' as const,
      path,
      text,
      project: kernel.project.current(),
      lineCount: text.split('\n').length,
    };
    const out: EditorDocumentSymbol[] = [];
    const seen = new Set<string>();
    const contributions = kernel.slots.query('ui.editor.languageService') as readonly EditorLanguageServiceContribution[];
    for (const contribution of contributions) {
      const result = contribution.provide(request);
      if (!result || result.kind !== 'documentSymbol') continue;
      for (const symbol of result.symbols) {
        const key = `${symbol.name}|${symbol.kind}|${symbol.startLine}|${symbol.endLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(symbol);
      }
    }
    return out;
  };

  it('往返闭合：真存档 → 真记录 → 真行号 → 宿主折回同一个函数名 → 面板落到那一条', async () => {
    const snapshots = kernel.services.get<SnapshotSourceService>(WellKnownServices.SnapshotSource);
    const replay = kernel.services.get<StateReplayService>(WellKnownServices.StateReplay);
    const extractor = kernel.services.get<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
    const condIndex = await extractor.ensureIndex();
    // 前提事实（不是放宽、是写明依赖）：条件索引**整片非空**。
    // 它只依赖上面那张任务表——归零时该报在这里，而不是让下面的 `predicatedNos`
    // 冒充"真语料里没有可判定函数"这条与事实相反的结论。
    expect(condIndex.byFunction.size, '条件索引整片为空 ⇒ condition.extractFile 的本地实现没注册').toBeGreaterThan(0);

    const scan = await snapshots.scan();
    const archives = scan.entries.filter((e) => !e.error);
    expect(archives.length).toBeGreaterThan(0);

    // (档 × 角色 × 函数) 三者互相约束：角色不在这份档里 → createView 明确拒绝；
    // 档里没登记条件的角色 → 无从回放。所以这里**成对找**第一组真能用的三元组，
    // 而不是照本机某一档写死（语料目录会换、档也会换）。
    const predicatedNos = [...project.charaIndex.keys()]
      .filter((no) => {
        const marker = `_K${no}_`;
        for (const name of condIndex.byFunction.keys()) if (name.includes(marker)) return true;
        return false;
      })
      .sort((a, b) => b - a);
    expect(predicatedNos.length).toBeGreaterThan(0);

    let stateView: Awaited<ReturnType<StateReplayService['createView']>> | null = null;
    let archivePath = '';
    let result: Awaited<ReturnType<StateReplayService['replayFunctions']>>[number] = null;
    outer: for (const no of predicatedNos.slice(0, 8)) {
      const marker = `_K${no}_`;
      const names = [...condIndex.byFunction.keys()].filter((n) => n.includes(marker));
      for (const archive of archives.slice(0, 4)) {
        let view: Awaited<ReturnType<StateReplayService['createView']>>;
        try {
          view = await replay.createView(archive.path, no);
        } catch {
          continue; // 这份档里没有这个角色（引擎语义，不是本批的判据）
        }
        const replays = await replay.replayFunctions(view, names.slice(0, 30));
        const hit = replays.find((r) => r !== null && r.predicates.length > 0);
        if (!hit) continue;
        stateView = view;
        archivePath = archive.path;
        result = hit;
        break outer;
      }
    }
    if (!stateView || !result) throw new Error('真语料里凑不出（档 × 角色 × 含谓词函数）三元组');

    // 取一条真谓词的行号当作"作者正看着的那一行"
    const line = result.predicates[0]!.line;
    const text = (await kernel.io.readText(result.filePath)).text;
    const t0 = performance.now();
    const symbols = collectSymbols(result.filePath, text);
    const parseMs = performance.now() - t0;
    const t1 = performance.now();
    const plan = planJumpToState({ path: result.filePath, line, symbols, derivedView: false });
    const planMs = performance.now() - t1;

    if (plan.kind !== 'replay') {
      throw new Error(`真语料上位点没折成函数：${result.filePath}:${line} → ${plan.message}`);
    }
    // 往返：折回来的名字必须就是那条记录所属的函数（大小写口径归消费方，这里按它的口径比）
    expect(plan.intent.functionName.toUpperCase()).toBe(result.normalizedName);
    expect(plan.intent.locate).toEqual({ filePath: result.filePath, line });

    const notice = locateNoticeFor(result, plan.intent.locate);
    expect(notice.hasRows).toBe(true); // 这一行在记录里真的有条目（不是硬凑出来的高亮）
    expect(notice.sentence).toContain(String(line));
    const reading = readLineAt(result, line);
    expect(['runs', 'skipped', 'undecided']).toContain(reading.verdict); // 条件行只会落在这三态
    expect(reading.matchedRows).toBeGreaterThanOrEqual(1);

    // eslint-disable-next-line no-console
    console.log(
      `[g1-corpus] 档 ${archivePath.split(/[\\/]/).pop()} × K${stateView.characterNo}` +
        ` | 函数 ${result.normalizedName} | 谓词 ${result.stats.total}（命中 ${result.stats.hit}）` +
        ` | 行 :${line} → ${reading.verdict} → 「${notice.sentence}」` +
        ` | 文件 ${result.filePath.split(/[\\/]/).pop()} 共 ${text.split('\n').length} 行，` +
        `documentSymbol ${parseMs.toFixed(1)}ms，位点折叠 ${planMs.toFixed(2)}ms`,
    );
  }, 240_000);

  it('代价上限：语料里最大的那份文件上做一次位点折叠', async () => {
    const index = kernel.services.get<ErbParserService>('erb.parser').currentIndex();
    expect(index).not.toBeNull();
    let biggest = { path: '', lineCount: 0 };
    for (const [path, file] of index!.files) {
      if (file.lineCount > biggest.lineCount) biggest = { path, lineCount: file.lineCount };
    }
    expect(biggest.lineCount).toBeGreaterThan(1000);

    const text = (await kernel.io.readText(biggest.path)).text;
    const t0 = performance.now();
    const symbols = collectSymbols(biggest.path, text);
    const parseMs = performance.now() - t0;
    // 落在**这一份里真实存在的某个函数体内**的一行（不假设行号分布）
    const target = symbols.find((s) => s.kind === 'function' && s.endLine > s.startLine);
    expect(target).toBeDefined();
    const line = target!.startLine + 1;
    const t1 = performance.now();
    const plan = planJumpToState({ path: biggest.path, line, symbols, derivedView: false });
    const planMs = performance.now() - t1;

    expect(plan.kind).toBe('replay');
    // 回归护栏（不是宣称）：一次按键的取树 + 折叠不该走上秒级——真读数打在下一行日志里
    expect(parseMs + planMs).toBeLessThan(4000);

    // eslint-disable-next-line no-console
    console.log(
      `[g1-corpus] 最大文件 ${biggest.path.split(/[\\/]/).pop()}：${biggest.lineCount} 行 / ` +
        `${symbols.length} 枚符号；documentSymbol ${parseMs.toFixed(1)}ms，` +
        `位点折叠 ${planMs.toFixed(2)}ms → ${(plan.kind === 'replay' ? plan.intent.functionName : '')}`,
    );
  }, 240_000);
});
