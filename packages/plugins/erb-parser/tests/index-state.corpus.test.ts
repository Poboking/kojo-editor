/**
 * 索引状态事实的**真实语料自证**（IDX-STATE，2026-10-19；`KOJO_SMOKE_PROJECT` 守门，没盘自动跳过）。
 *
 * 这一条闸存在的唯一理由：三态里最容易被糊过去的两条——"**没找到可扫描的位置**"与
 * "**扫了确实一个函数都没有**"——在合成夹具上都能各自编出来，但只有真盘能证明它们
 * 在**同一副盘**上确实分得开（两者的 `functions` 都是 0，`filesScanned` 一个 0 一个 26）。
 * 顺带把真语料上的本轮读数（几个根 / 几个文件 / 名录几条）留成可见数字。
 *
 * 纪律：本文件对语料盘**只读**（`readdirSync`/`statSync` + 索引自己的 walk/read），
 * 不写一个字节、不建临时文件（写允许域归内核，测试也不越）。
 */

import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErbIndexState, ErbParserService, GameProject } from '@kojo/plugin-api';
import { createKernel } from '../../../kernel/src/kernel';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin } from '../src/plugin';
import { createEratwAdapterPlugin } from '../../eratw-adapter/src/index';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 盘上真实存在的"只有声明文件"的目录（26 份 `.ERH`、0 个 `@` 定义 ⇒ 天然的 empty 点位） */
const QUIET_ROOT_REL = ['ERB', 'Headers'];

const readState = (parser: ErbParserService): ErbIndexState => {
  if (!parser.indexState) throw new Error('erb.parser 未提供 indexState()（IDX-STATE 事实面缺席）');
  return parser.indexState();
};

describe.skipIf(!SMOKE)('索引状态事实 · 真实语料自证', () => {
  let kernel: Awaited<ReturnType<typeof createKernel>>;
  let parser: ErbParserService;
  let project: GameProject;

  beforeAll(async () => {
    kernel = await createKernel({
      platform: new NodeBridge(mkdtempSync(join(tmpdir(), 'kojo-idxstate-'))),
      plugins: [createErbParserPlugin(), createEratwAdapterPlugin()],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    project = await kernel.project.open(SMOKE!);
    parser = kernel.services.get<ErbParserService>('erb.parser');
    await parser.ensureIndex();
  }, 300_000);

  afterAll(async () => {
    if (kernel) await kernel.stop();
  }, 180_000);

  it('本轮读数（根 / 文件 / 名录）+ 三态在真盘上分得开', async () => {
    // ---- 盘面前提：目录在位、那一寸"只有声明"的盘确实存在（不符预期就显式失败，不静默跳过） ----
    statSync(SMOKE!);
    const quietRoot = join(SMOKE!, ...QUIET_ROOT_REL);
    const onDisk = readdirSync(quietRoot, { withFileTypes: true });
    expect(onDisk.filter((e) => /\.erh$/i.test(e.name)).length, 'Headers 里该有声明文件').toBeGreaterThan(10);

    // ---- 1. 项目那一轮：ready，读数与索引本体逐位对得上 ----
    const idx = parser.currentIndex()!;
    const s = readState(parser);
    console.log(
      `[idx-state] 项目根=${project.rootDir} 口上根 ${project.kojoPaths.length} 条；` +
        `本轮实走 ${s.rootsWalked} 个根 / 扫到 ${s.filesScanned} 个方言文件 / 名录 ${s.functions} 名` +
        `（索引侧 byName ${idx.byName.size}、files ${idx.files.size}）；` +
        `phase=${s.phase} coverage=${s.coverage}；来源：` +
        s.sources.map((f) => `${f.source}=${f.offered}${f.available ? '' : '(读不到)'}`).join(' + '),
    );
    expect(s.phase).toBe('ready');
    expect(s.rootsWalked, '真语料至少走得到一个口上根').toBeGreaterThanOrEqual(1);
    expect(s.filesScanned).toBe(idx.files.size);
    expect(s.functions).toBe(idx.byName.size);
    expect(s.functions, '名录条数（历史读数 99,028，本批一个字节没动解析面）').toBeGreaterThanOrEqual(90_000);
    // 逐来源事实是**两条**（提供方陈述 project + workspace 两类位置），顺序固定
    expect(s.sources.map((f) => f.source)).toEqual(['project', 'workspace']);
    expect(s.sources[0]!.offered).toBe(project.kojoPaths.length);

    // ---- 2. empty 点位：真盘上"扫到了文件、一个函数都没有"（26 份 .ERH ⇒ 0 个 @ 定义） ----
    const quiet = await parser.buildIndex([quietRoot]);
    const qs = readState(parser);
    console.log(
      `[idx-state] empty 点位：${QUIET_ROOT_REL.join('/')} 实走 ${qs.rootsWalked} 个根 / ` +
        `文件 ${qs.filesScanned}（盘上索引侧 ${quiet.files.size}）/ 名录 ${qs.functions} 名；phase=${qs.phase}`,
    );
    expect(qs.phase).toBe('empty');
    expect(qs.rootsWalked).toBe(1);
    expect(qs.filesScanned, '扫到的文件数 = 索引侧文件数（两笔账同一个戳）').toBe(quiet.files.size);
    expect(qs.filesScanned).toBeGreaterThan(0);
    expect(qs.functions).toBe(0);
    expect(qs.coverage).toBe('full'); // 位置走到了、也读到了 ⇒ 不是降级，是"确实没有"

    // ---- 3. nothing-to-scan 点位：同一副盘上"没有任何可扫描的位置" ----
    const nowhere = await parser.buildIndex([]);
    const ns = readState(parser);
    console.log(
      `[idx-state] 空态点位：实走 ${ns.rootsWalked} 个根 / 文件 ${ns.filesScanned} / 名录 ${ns.functions} 名；` +
        `phase=${ns.phase} coverage=${ns.coverage}`,
    );
    expect(ns.phase).toBe('nothing-to-scan');
    expect(ns.rootsWalked).toBe(0);
    expect(ns.filesScanned).toBe(0);
    expect(ns.functions).toBe(0);
    expect(ns.coverage).toBe('none');
    expect(nowhere.byName.size).toBe(0);

    // ---- 4. 本刀的存在理由：两条"什么都没有"在真盘上是两条不同的事实 ----
    // 合成夹具里编得出、真盘上更要成立：`functions` 同为 0，旧形态只会有一句假话。
    expect(ns.functions).toBe(qs.functions);
    expect(ns.filesScanned).not.toBe(qs.filesScanned);
    expect(ns.phase).not.toBe(qs.phase);
  }, 300_000);
});
