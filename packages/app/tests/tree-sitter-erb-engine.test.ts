import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StructureEngine } from '../src/monaco/tree-sitter/engine';
import type { KojoStructureReply } from '../src/monaco/tree-sitter/types';

/**
 * ERB 接进通用引擎（ERB-TS-STRUCTURE 宿主侧）：
 * 同一枚 `StructureEngine`，只换语法 wasm 与 folds 查询；缺 semantic / indents 查询**不算装配失败**
 * （ERB 首版本来就不供这两面），折叠仍按 `@fold` 产出。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const ERB_PKG = join(repoRoot, 'packages', 'erb-syntax-tree');

const TEXT = '@F\nIF X\nPRINTL hi\nENDIF\nSELECTCASE X\nCASE 1\nRETURN\nENDSELECT\n';

function erbEngine(): { engine: StructureEngine; replies: KojoStructureReply[] } {
  const replies: KojoStructureReply[] = [];
  const engine = new StructureEngine({
    assets: {
      runtimeWasm: join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
      grammarWasm: readFileSync(join(ERB_PKG, 'tree-sitter-erb.wasm')),
      foldsQuery: readFileSync(join(ERB_PKG, 'queries', 'folds.scm'), 'utf8'),
    },
    emit: (reply) => replies.push(reply),
  });
  return { engine, replies };
}

describe('ERB：通用引擎只凭 folds 查询就能供折叠', () => {
  it('装配不发假回落；IF / SELECTCASE / 函数块都出区间', async () => {
    const { engine, replies } = erbEngine();
    expect(await engine.init()).toBe(true);
    expect(replies.filter((r) => r.type === 'error')).toEqual([]);

    engine.parse(7, 1, TEXT);
    const folds = replies.filter((r) => r.type === 'folds').pop();
    if (folds?.type !== 'folds') throw new Error('没有 folds 回话');
    expect(folds.doc).toBe(7);
    const pairs = folds.folds.map((f) => [f.startRow, f.endRow]);
    expect(pairs).toContainEqual([1, 3]); // IF X … ENDIF
    expect(pairs).toContainEqual([4, 7]); // SELECTCASE … ENDSELECT
    expect(pairs).toContainEqual([5, 6]); // CASE 1 … RETURN
    expect(pairs).toContainEqual([0, 7]); // @F 函数块（到文末）
    engine.dispose();
  });

  it('无 semantic / indents 查询时，这两面安静为空而不是报错（ERB 首版口径）', async () => {
    const { engine, replies } = erbEngine();
    await engine.init();
    engine.parse(1, 1, TEXT);
    // 引擎只回 folds / syntax；两条腿缺席不回 error（否则每次起线程都会假报一次回落）
    expect(replies.some((r) => r.type === 'error')).toBe(false);
    expect(replies.some((r) => r.type === 'semantic')).toBe(false);
    expect(replies.some((r) => r.type === 'indent')).toBe(false);
    engine.dispose();
  });
});
