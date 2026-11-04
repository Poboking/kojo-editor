/**
 * 语义读数服务化单测（冻结契约 v1）。
 *
 * 8 条读数清单 / 注入式服务 / 纯读裁剪 / 调试面薄适配器，全部零 Monaco 运行时依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_READING_SPECS,
  createSemanticService,
  createDebugEditorAdapter,
  slimLocations,
  slimDiagnostics,
  slimSymbols,
  SemanticFailure,
} from '../src/mcp/semantic-service';

const names = SEMANTIC_READING_SPECS.map((s) => s.name);

describe('8 条语义读数清单', () => {
  it('恰 8 条，名字与契约对齐，全部只读', () => {
    expect(names).toEqual([
      'definitionAt', 'referencesAt', 'diagnostics', 'hoverAt',
      'suggestAt', 'documentSymbols', 'tokens', 'codeActionsAt',
    ]);
    for (const s of SEMANTIC_READING_SPECS) {
      expect(s.tier).toBe('read');
      expect(s.annotations.readOnlyHint).toBe(true);
      expect(typeof s.inputSchema).toBe('object');
    }
  });
});

describe('纯读裁剪（判据同源、脏值不炸）', () => {
  it('slimLocations：路径空 / 行非正丢弃，列缺省补 1，上限截断', () => {
    expect(slimLocations([
      { filePath: 'A.ERB', line: 3 },
      { filePath: '', line: 5 },
      { filePath: 'B.ERB', line: 0 },
      { filePath: 'C.ERB', line: 2, column: 9 },
    ], 2)).toEqual([
      { filePath: 'A.ERB', line: 3, column: 1 },
      { filePath: 'C.ERB', line: 2, column: 9 },
    ]);
    expect(slimLocations(null)).toEqual([]);
  });

  it('slimDiagnostics：单行归一 + 300 截断 + 上限', () => {
    expect(slimDiagnostics([{ message: ' 第一行\n第二行 ', line: 2 }])).toEqual([{ message: '第一行 第二行', line: 2 }]);
    expect(slimDiagnostics([{ message: 'w'.repeat(400) }])[0]!.message.endsWith('…')).toBe(true);
    expect(slimDiagnostics(Array.from({ length: 260 }, () => ({ message: 'm', line: 1 })))).toHaveLength(200);
  });

  it('slimSymbols：无 name 跳过，depth/kind 缺省', () => {
    expect(slimSymbols([{ name: 'X', kind: 'fn', depth: 1 }, { kind: 'fn' }, null])).toEqual([{ name: 'X', kind: 'fn', depth: 1 }]);
  });
});

describe('注入式服务', () => {
  it('注入腿后 read 正常回传；未注入腿报 NOT_WIRED（不静默）', async () => {
    const service = createSemanticService({ readers: { definitionAt: (a) => slimLocations([{ filePath: 'A', line: a.line }]) } });
    expect(await service.read('definitionAt', { line: 7, column: 1 })).toEqual([{ filePath: 'A', line: 7, column: 1 }]);
    await expect(service.read('diagnostics', {})).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });

  it('位置读数要求正整数 line/column ⇒ INVALID_ARGS', async () => {
    const service = createSemanticService({ readers: { hoverAt: () => 'ok' } });
    expect(await service.read('hoverAt', { line: 1, column: 2 })).toBe('ok');
    await expect(service.read('hoverAt', { line: 0, column: 2 })).rejects.toBeInstanceOf(SemanticFailure);
    await expect(service.read('hoverAt', { line: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('未知读数 / 执行体抛错都结构化可见', async () => {
    const service = createSemanticService({ readers: { diagnostics: () => { throw new Error('boom'); } } });
    await expect(service.read('nope', {})).rejects.toMatchObject({ code: 'UNKNOWN_READING' });
    await expect(service.read('diagnostics', {})).rejects.toMatchObject({ code: 'READ_FAILED' });
  });

  it('specs 与 createSemanticService 同源', () => {
    expect(createSemanticService({ readers: {} }).specs).toBe(SEMANTIC_READING_SPECS);
  });
});

describe('调试面薄适配器', () => {
  it('8 个方法把位置参数转成 service.read(name, args)', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const service = createSemanticService({
      readers: Object.fromEntries(names.map((n) => [n, (a: Record<string, unknown>) => { calls.push({ name: n, args: a }); return null; }])),
    });
    const editor = createDebugEditorAdapter(service);
    await editor.definitionAt(3, 4);
    await editor.referencesAt(5, 6);
    await editor.diagnostics();
    await editor.hoverAt(7, 8);
    await editor.suggestAt(9, 10);
    await editor.documentSymbols();
    await editor.tokens(1, 20);
    await editor.codeActionsAt(2, 3);
    expect(calls).toHaveLength(8);
    expect(calls[0]).toEqual({ name: 'definitionAt', args: { line: 3, column: 4 } });
    expect(calls[6]).toEqual({ name: 'tokens', args: { lineFrom: 1, lineTo: 20 } });
  });
});
