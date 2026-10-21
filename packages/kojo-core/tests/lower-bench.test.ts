/**
 * 降糖热路径微基准（**数字进测试输出 + 宽松上界防退化**）。
 *
 * 判据：50k 行叙事文本 lowering 的墙钟读数 + source map 10 万行追加 / 2 万次查询。
 * 上界刻意给得宽（并行池抖动不该让它随机红）；真正的棘轮在 CI 读数对比里，
 * 这里只保证"没退化成 O(n²) / 没有重复 toString 的灾难"。
 */
import { describe, expect, it } from 'vitest';
import type { KojoNarrativeNode, KojoSpan, KojoTextLine } from '../src/ast.js';
import { createSourceMapBuilder } from '../src/source-map.js';
import { lowerNarrative } from '../src/lower/index.js';
import { createFakeBackend } from './lower-fake-backend.js';

const LINES = 50_000;

const span = (line: number): KojoSpan => ({
  start: { line, column: 1 },
  end: { line, column: 16 },
});

function buildTextNodes(count: number): KojoTextLine[] {
  const nodes = new Array<KojoTextLine>(count);
  for (let i = 0; i < count; i++) {
    nodes[i] = {
      kind: 'textLine',
      speech: i % 3 === 0 ? { kind: 'dialogue', speaker: '灵梦' } : { kind: 'narration' },
      parts: [
        { kind: 'text', text: '她轻轻点了点头，' },
        { kind: 'interp', expr: { text: '心情', span: span(i + 1) } },
        { kind: 'text', text: '。' },
      ],
      wait: i % 5 === 0 ? 'continue' : 'default',
      span: span(i + 1),
    };
  }
  return nodes;
}

describe('lowering 热路径微基准', () => {
  it('50k 行文本：墙钟上界 + 行数/映射完整性', () => {
    const backend = createFakeBackend();
    const nodes: KojoNarrativeNode[] = buildTextNodes(LINES);
    // 预热（JIT + 数组扩容路径）
    lowerNarrative(nodes.slice(0, 5_000), { backend: createFakeBackend(), estimatedLines: 5_000 });

    const started = Date.now();
    const result = lowerNarrative(nodes, { backend, estimatedLines: LINES });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(result.lines).toHaveLength(LINES);
    expect(result.sourceMap.lineCount).toBe(LINES);
    // 映射抽检：第 1 行与最后一行都回到对应源行
    expect(result.sourceMap.lineAt(1)?.source?.start.line).toBe(1);
    expect(result.sourceMap.lineAt(LINES)?.source?.start.line).toBe(LINES);

    // eslint-disable-next-line no-console
    console.log(
      `[bench] lower ${LINES} lines: ${elapsed}ms (${Math.round((LINES / Math.max(1, elapsed)) * 1000)} lines/s), ` +
        `map ${result.sourceMap.lineCount} rows`,
    );
    expect(elapsed).toBeLessThan(3_000);
  });

  it('source map：10 万行追加 + 2 万次查询', () => {
    const ROWS = 100_000;
    const lookups = 20_000;
    const builder = createSourceMapBuilder();

    const appendStarted = Date.now();
    for (let line = 1; line <= ROWS; line++) {
      builder.appendLine({ generatedLine: line, kind: 'source', source: span(line) });
    }
    const appendElapsed = Date.now() - appendStarted;

    const map = builder.build();
    const lookupStarted = Date.now();
    let hits = 0;
    for (let i = 0; i < lookups; i++) {
      const at = ((i * 7919) % ROWS) + 1;
      if (map.lookup({ line: at, column: 3 }).source !== null) hits++;
    }
    const lookupElapsed = Date.now() - lookupStarted;

    expect(map.lineCount).toBe(ROWS);
    expect(hits).toBe(lookups);
    // eslint-disable-next-line no-console
    console.log(`[bench] source map append ${ROWS} rows: ${appendElapsed}ms; lookup ${lookups}: ${lookupElapsed}ms`);
    expect(appendElapsed).toBeLessThan(2_000);
    expect(lookupElapsed).toBeLessThan(2_000);
  });
});
