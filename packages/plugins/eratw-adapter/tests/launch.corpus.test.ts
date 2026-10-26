/**
 * eraTW 启动面 · **真盘守卫**（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门；语料不在位整组跳过）。
 *
 * 单元测试（`launch.test.ts`）用假 io 钉的是"形状"；这里钉的是**只有真盘才成立的四条**：
 * 1. `probe` 在真语料根上**至少命中一个候选**（家族判据不是空转）；
 * 2. 每个候选的路径都在根内（相对、无 `..`、无盘符，且 `resolve(root, rel)` 落回根下、
 *    盘上真的是个文件）——这条一旦破了，宿主的前缀校验会拒、或者更糟，指向根外的程序；
 * 3. `buildProfile` 的存档根 / 内容根与**盘上目录**逐条一致（在位就声明、不在位就省略）；
 * 4. `logRules.parseLocation` 在真 `emuera.log` 的行上不吃绝对路径（认出即必须是相对路径）。
 *
 * 口径与其它 `.corpus.test.ts` 一致：**不钉文件名 / 不钉数量**（语料会换版、目录名会变），
 * 只钉"函数与盘的关系"。本机取证时的根（eraTW 4.980 画蛇添足版）见 `src/launch.ts` 文件头。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { createEratwLaunchAdapter } from '../src/launch';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 语料不在位 ⇒ 整组跳过（不设 `KOJO_*` 时就是这条） */
const guard = SMOKE ? describe : describe.skip;
const ROOT = SMOKE ?? '';

function adapterOnRealDisk() {
  return createEratwLaunchAdapter({
    io: new FileIOServiceImpl(new NodeBridge(ROOT), silentLog),
    log: silentLog,
  });
}

guard('eraTW 启动面 · 真盘', () => {
  it('probe 至少命中一个候选，且候选路径落在根内、盘上真是文件', async () => {
    const candidates = await adapterOnRealDisk().probe(ROOT);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const rootResolved = path.resolve(ROOT);
    for (const candidate of candidates) {
      const rel = candidate.executableRelativePath;
      expect(path.isAbsolute(rel)).toBe(false);
      expect(/^[a-zA-Z]:/.test(rel)).toBe(false);
      expect(rel.split(/[\\/]/)).not.toContain('..');

      const resolved = path.resolve(rootResolved, rel);
      // 前缀守卫：落点必须在根下（不是"长得像相对路径"就算数）
      expect(resolved.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
    }
  });

  it('已知名表与真盘对齐（盘上真有那份 exe 时，id 必须命中）', async () => {
    const candidates = await adapterOnRealDisk().probe(ROOT);
    const ids = candidates.map((candidate) => candidate.id);
    // 动态判据：语料换版没这份文件时不算红（那时靠家族判据覆盖），在位时必须认得出来
    if (existsSync(path.join(ROOT, 'Emuera_LazyLoadingV3.0_x64.exe'))) {
      expect(ids).toContain('eratw-lazyloading-x64');
    }
    if (existsSync(path.join(ROOT, 'Emuera_LazyLoadingV3.0_x86.exe'))) {
      expect(ids).toContain('eratw-lazyloading-x86');
    }
  });

  it('buildProfile 的存档根 / 内容根与盘上目录逐条一致', async () => {
    const adapter = adapterOnRealDisk();
    const candidates = await adapter.probe(ROOT);
    const profile = await adapter.buildProfile(ROOT, candidates[0]!.id);

    expect(profile.candidateId).toBe(candidates[0]!.id);
    expect(profile.cwdRelative).toBe('.');

    // 存档根：盘上有没有 sav/ 就是唯一判据（声明了就必须真在，没声明就不能真在）
    const hasSav = existsSync(path.join(ROOT, profile.saveRoots[0]?.relativePath ?? 'sav'));
    expect(profile.saveRoots.length).toBe(hasSav ? 1 : 0);

    // 内容根：每一条都必须在盘上在位；且不得凭空多给
    for (const root of profile.contentRoots) {
      expect(existsSync(path.join(ROOT, root.relativePath))).toBe(true);
    }
    const declaredIds = (adapter.contentRoots ?? []).map((root) => root.id);
    for (const root of profile.contentRoots) expect(declaredIds).toContain(root.id);
  });

  it('真 emuera.log：parseLocation 认出的路径一律是相对路径，不吞绝对路径', async () => {
    const logPath = path.join(ROOT, 'emuera.log');
    if (!existsSync(logPath)) return; // 语料里没有日志文件（引擎没跑过）⇒ 本用例无事可做
    const rules = adapterOnRealDisk().logRules!;
    const text = new TextDecoder('utf-8').decode(readFileSync(logPath));
    const parsed = text
      .split(/\r?\n/)
      .map((line) => rules.parseLocation(line))
      .filter((location) => location !== null);

    for (const location of parsed) {
      expect(path.isAbsolute(location.relativePath)).toBe(false);
      expect(/^[a-zA-Z]:/.test(location.relativePath)).toBe(false);
      expect(location.relativePath.split('/')).not.toContain('..');
      expect(location.relativePath).toMatch(/\.ERB$/i);
      expect(location.line).toBeGreaterThan(0);
    }
    // 反恒真护栏：真盘日志里确实有可解析的行（否则上面那圈 for 是空转）
    expect(parsed.length).toBeGreaterThan(0);
  });
});
