import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { erbIndentPattern } from '../../src/monaco/tree-sitter/erb-indent-patterns';
import { erbCaptureTier } from '../../src/monaco/tree-sitter/erb-tiers';
import { resetStructureDegradationLedger } from '../../src/monaco/tree-sitter/fallback';
import { StructureEngine, type StructureEngineAssets } from '../../src/monaco/tree-sitter/engine';
import type { KojoStructureReply, KojoStructureToken } from '../../src/monaco/tree-sitter/types';

/**
 * ERB-TS-FULL 分面测试的共享夹具（2026-10-28 欠账批：原单文件 `erb-ts-facets.test.ts`
 * 在同一进程里连解太多趟 tree-sitter wasm，跑到第②节就 `Fatal process out of memory: Zone`，
 * 缺口用例既不算红也不算跳——按 facet 拆成多份文件后，每枚 worker 只解自己那一档）。
 *
 * 本文件只放**跨面复用**的路径 / 查询读取 / 引擎装配 / 夹具，判据本体都在各面文件里，
 * 断言与用例数与拆分前一字不差。
 */

const helpersDir = dirname(fileURLToPath(import.meta.url));
const testsDir = resolve(helpersDir, '..');
export const repoRoot = resolve(testsDir, '..', '..', '..');
export const ERB_PKG = join(repoRoot, 'packages', 'erb-syntax-tree');
export const RUNTIME_WASM = join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');

export const readQuery = (name: string): string => readFileSync(join(ERB_PKG, 'queries', `${name}.scm`), 'utf8');
export const grammarWasm = (): Buffer => readFileSync(join(ERB_PKG, 'tree-sitter-erb.wasm'));

/* -------------------------------- 引擎工具 -------------------------------- */

const liveEngines: StructureEngine[] = [];

export function makeEngine(overrides: Partial<StructureEngineAssets> = {}): {
  engine: StructureEngine;
  replies: KojoStructureReply[];
} {
  const replies: KojoStructureReply[] = [];
  const engine = new StructureEngine({
    assets: {
      runtimeWasm: RUNTIME_WASM,
      grammarWasm: grammarWasm(),
      foldsQuery: readQuery('folds'),
      highlightsQuery: readQuery('highlights'),
      indentsQuery: readQuery('indents'),
      captureTier: erbCaptureTier,
      indentPattern: erbIndentPattern,
      ...overrides,
    },
    emit: (reply) => replies.push(reply),
  });
  liveEngines.push(engine);
  return { engine, replies };
}

export async function runEngine(text: string, overrides: Partial<StructureEngineAssets> = {}) {
  const { engine, replies } = makeEngine(overrides);
  const ok = await engine.init();
  expect(ok).toBe(true);
  engine.parse(7, 1, text);
  return { engine, replies };
}

export function lastReply<T extends KojoStructureReply['type']>(
  replies: readonly KojoStructureReply[],
  type: T,
): Extract<KojoStructureReply, { type: T }> | undefined {
  return replies.filter((reply): reply is Extract<KojoStructureReply, { type: T }> => reply.type === type).at(-1);
}

export const errorReplies = (replies: readonly KojoStructureReply[]) =>
  replies.filter((reply) => reply.type === 'error') as Extract<KojoStructureReply, { type: 'error' }>[];

/** 每枚分面文件都要注册 `afterEach(disposeAllEngines)`——引擎的真 teardown 不许留在模块级过夜 */
export function disposeAllEngines(): void {
  while (liveEngines.length > 0) liveEngines.pop()!.dispose();
}

/** 与原文件同一条收尾：台账重置（各面文件在 `afterAll` 里调用） */
export function resetFacetLedgers(): void {
  resetStructureDegradationLedger();
}

/* --------------------------------- 夹具 --------------------------------- */

export const FIXTURE = [
  '; 顶部注释',
  '#DIM NAME, 10',
  '@FUNC(A, B)',
  '    $LOOP',
  '    [IF_DEBUG]',
  '    IF A AND B',
  '        SELECTCASE A',
  '        CASE 1',
  '            PRINTL "台词{NAME}与%CALLNAME%"',
  '        CASEELSE',
  '            PRINTL other',
  '        ENDSELECT',
  '    ELSE',
  '        SIF A > 1',
  '        PRINTLX',
  '    ENDIF',
  '[SKIPSTART]',
  'IF 坏掉的未闭合 "',
  '[SKIPEND]',
].join('\n') + '\n';

export const token = (over: Partial<KojoStructureToken>): KojoStructureToken => ({
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 3,
  tier: 'role.comment',
  ...over,
});
