/**
 * 端到端编译微基准（50k 行）：lex → parse → 展开 → lower 全链路墙钟读数。
 *
 * 上界给得宽（并行池抖动不该随机红）；读数进测试输出，供 STATE/报告引用。
 */
import { describe, expect, it } from 'vitest';
import type { EmitResult, KojoEmitBackend } from '../src/lower/backend.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';

const LINES = 50_000;

const BACKEND: KojoEmitBackend = {
  ...FIXTURE_BACKEND,
  wrapMachine: (request): EmitResult => [`@EVENT_${request.machine.event}`, ...request.body, '@EVENT_END'],
};

function buildSource(count: number): string {
  const out: string[] = ['# 机 开场', '# 视 灵梦', ''];
  for (let i = 0; i < count; i++) {
    if (i % 7 === 0) out.push('空行');
    else if (i % 5 === 0) out.push(`灵梦：「第${i}行。」`);
    else out.push(`> 第${i}行的叙事文本，带一个插值{恋慕}。`);
  }
  return `${out.join('\n')}\n`;
}

describe('compile 全链路微基准', () => {
  it('50k 行：墙钟上界 + 产物行数/映射完整性', () => {
    const source = buildSource(LINES);
    // 预热
    compileKojoSource({ source: buildSource(2_000), adapter: FIXTURE_ADAPTER, backend: BACKEND });

    const started = Date.now();
    const result = compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    const rows = result.erb.slice(0, -1).split('\n');
    expect(rows.length).toBe(LINES + 2); // body + 前后 wrapper
    expect(result.sourceMap.lineCount).toBe(rows.length);
    expect(result.sourceMap.lineAt(1)?.kind).toBe('source');
    expect(result.sourceMap.lineAt(rows.length)?.kind).toBe('source');

    // eslint-disable-next-line no-console
    console.log(
      `[bench] compile ${LINES} lines: ${elapsed}ms (${Math.round((LINES / Math.max(1, elapsed)) * 1000)} lines/s), ` +
        `erb ${rows.length} rows`,
    );
    expect(elapsed).toBeLessThan(5_000);
  });
});
