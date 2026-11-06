/**
 * 语义读数服务化单测（冻结契约 v1）。
 *
 * 8 条读数清单 / 注入式服务 / 纯读裁剪（含截断账目）/ 调试面薄适配器，全部零 Monaco
 * 运行时依赖（`@kojo/mcp-host` 仅用于钉「宿主结构化失败原样透传」的形状契约）。
 */
import { describe, expect, it } from 'vitest';
import { McpFailure } from '@kojo/mcp-host';
import {
  SEMANTIC_READING_SPECS,
  createSemanticService,
  createDebugEditorAdapter,
  slimLocations,
  slimDiagnostics,
  slimSymbols,
  slimLocationsPage,
  slimDiagnosticsPage,
  slimSymbolsPage,
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
    expect(calls[1]).toEqual({ name: 'referencesAt', args: { line: 5, column: 6 } });
    expect(calls[3]).toEqual({ name: 'hoverAt', args: { line: 7, column: 8 } });
    expect(calls[4]).toEqual({ name: 'suggestAt', args: { line: 9, column: 10 } });
    expect(calls[6]).toEqual({ name: 'tokens', args: { lineFrom: 1, lineTo: 20 } });
    expect(calls[7]).toEqual({ name: 'codeActionsAt', args: { line: 2, column: 3 } });
  });
});

describe('行列单位与边界（1 基契约、服务不越权）', () => {
  it('首行首列 (1,1) 合法且原样到 reader；0 / 负数 / 非整数显式 INVALID_ARGS（0 基被拒＝1 基钉死）', async () => {
    const seen: Record<string, unknown>[] = [];
    const service = createSemanticService({
      readers: { definitionAt: (a) => { seen.push(a); return 'ok'; } },
    });
    expect(await service.read('definitionAt', { line: 1, column: 1 })).toBe('ok');
    expect(seen[0]).toEqual({ line: 1, column: 1 });
    for (const bad of [
      { line: 0, column: 1 },
      { line: 1, column: 0 },
      { line: -1, column: 1 },
      { line: 1.5, column: 1 },
      { line: Number.NaN, column: 1 },
      {},
    ]) {
      await expect(service.read('definitionAt', bad)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
  });

  it('schema 带 required 的腿（恰 5 条 POS 腿）一律被入参校验钉成正整数', async () => {
    const requiredLegs = SEMANTIC_READING_SPECS.filter((s) => Array.isArray(s.inputSchema['required']));
    expect(requiredLegs.map((s) => s.name)).toEqual([
      'definitionAt', 'referencesAt', 'hoverAt', 'suggestAt', 'codeActionsAt',
    ]);
    for (const leg of requiredLegs) {
      const service = createSemanticService({ readers: { [leg.name]: () => 'ok' } });
      await expect(service.read(leg.name, { line: 0, column: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      await expect(service.read(leg.name, { line: 1, column: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
  });

  it('tokens 无硬约束：lineFrom/lineTo 原样转发（含 0 / 缺省 / 越界大值——夹取是取数腿职责，服务不编造边界）', async () => {
    const seen: Record<string, unknown>[] = [];
    const service = createSemanticService({ readers: { tokens: (a) => { seen.push(a); return 'ok'; } } });
    await service.read('tokens', { lineFrom: 0, lineTo: 999999 });
    expect(seen[0]).toEqual({ lineFrom: 0, lineTo: 999999 });
    await service.read('tokens', {});
    expect(seen[1]).toEqual({});
  });

  it('位置越界大值原样转发（服务层无行数知识，不越权夹取）；校验顺序：UNKNOWN_READING 先于参数、INVALID_ARGS 先于装配检查', async () => {
    const seen: Record<string, unknown>[] = [];
    const service = createSemanticService({ readers: { hoverAt: (a) => { seen.push(a); return 'ok'; } } });
    await service.read('hoverAt', { line: 1e9, column: 1e9 });
    expect(seen[0]).toEqual({ line: 1e9, column: 1e9 });
    await expect(service.read('nope', { line: 0 })).rejects.toMatchObject({ code: 'UNKNOWN_READING' });
    // suggestAt 腿缺席，但参数坏仍先报 INVALID_ARGS（参数错误是调用方 bug，先于缺线报告）
    const bare = createSemanticService({ readers: {} });
    await expect(bare.read('suggestAt', { line: 0, column: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('截断账目（SlimPage：截断不静默）', () => {
  it('slimLocationsPage：上限截断 ⇒ truncated=true + total=原始条数；恰等于上限 ⇒ false', () => {
    const raw = [
      { filePath: 'A', line: 1 }, { filePath: 'B', line: 2 }, { filePath: 'C', line: 3 },
      { filePath: 'D', line: 4 }, { filePath: 'E', line: 5 },
    ];
    expect(slimLocationsPage(raw, 3)).toEqual({
      items: [
        { filePath: 'A', line: 1, column: 1 },
        { filePath: 'B', line: 2, column: 1 },
        { filePath: 'C', line: 3, column: 1 },
      ],
      total: 5,
      truncated: true,
    });
    expect(slimLocationsPage(raw, 5).truncated).toBe(false);
  });

  it('脏行丢弃也算「没全呈现」：total 计脏行、truncated=true（少给了就说少给了）', () => {
    const raw = [
      { filePath: 'A', line: 1 }, { filePath: '', line: 2 }, { filePath: 'B', line: 0 }, null,
      { filePath: 'C', line: 3, column: 4 },
    ];
    expect(slimLocationsPage(raw, 20)).toEqual({
      items: [
        { filePath: 'A', line: 1, column: 1 },
        { filePath: 'C', line: 3, column: 4 },
      ],
      total: 5,
      truncated: true,
    });
  });

  it('非数组 ⇒ 空页（total 0、truncated false），不炸不编造', () => {
    expect(slimLocationsPage(null)).toEqual({ items: [], total: 0, truncated: false });
    expect(slimDiagnosticsPage('nope')).toEqual({ items: [], total: 0, truncated: false });
    expect(slimSymbolsPage(undefined)).toEqual({ items: [], total: 0, truncated: false });
  });

  it('slimDiagnosticsPage / slimSymbolsPage：大文档上限截断带账（200 上限）', () => {
    const many = Array.from({ length: 261 }, () => ({ message: 'm', line: 1 }));
    const page = slimDiagnosticsPage(many);
    expect(page.items).toHaveLength(200);
    expect(page.total).toBe(261);
    expect(page.truncated).toBe(true);
    const syms = Array.from({ length: 205 }, (_, i) => ({ name: `s${i}`, kind: 'fn', depth: 0 }));
    const symPage = slimSymbolsPage(syms);
    expect(symPage.items).toHaveLength(200);
    expect(symPage.total).toBe(205);
    expect(symPage.truncated).toBe(true);
  });

  it('旧 slim* 与 *Page 同源（items 全等，兼容冻结形状零漂移）', () => {
    const raw = [{ filePath: 'A', line: 1 }, { filePath: '', line: 2 }, { filePath: 'B', line: 3 }];
    expect(slimLocations(raw, 1)).toEqual(slimLocationsPage(raw, 1).items);
    expect(slimDiagnostics(raw, 1)).toEqual(slimDiagnosticsPage(raw, 1).items);
    expect(slimSymbols(raw, 1)).toEqual(slimSymbolsPage(raw, 1).items);
  });
});

describe('空结果 vs 服务缺席（两态不混）', () => {
  it('reader 返回空数组 / null 都是合法读数，原样 resolve，不误报 NOT_WIRED', async () => {
    const service = createSemanticService({ readers: { diagnostics: () => [], documentSymbols: () => null } });
    expect(await service.read('diagnostics', {})).toEqual([]);
    expect(await service.read('documentSymbols', {})).toBeNull();
  });

  it('8 腿逐腿缺席 ⇒ NOT_WIRED，message 点名缺哪条腿（可见不静默）', async () => {
    const service = createSemanticService({ readers: {} });
    for (const n of names) {
      const args = n === 'tokens' ? {} : { line: 1, column: 1 };
      await expect(service.read(n, args)).rejects.toMatchObject({
        code: 'NOT_WIRED',
        message: expect.stringContaining(n),
      });
    }
  });
});

describe('错误透传（结构化不洗码、非结构化包 READ_FAILED）', () => {
  it('reader 抛 SemanticFailure ⇒ code / message 原样透传', async () => {
    const service = createSemanticService({
      readers: { hoverAt: () => { throw new SemanticFailure('RESOURCE_UNAVAILABLE', '语言特性服务未到场'); } },
    });
    await expect(service.read('hoverAt', { line: 1, column: 1 })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      message: expect.stringContaining('语言特性服务未到场'),
    });
  });

  it('reader 抛宿主 McpFailure（NOT_WIRED＝无活动编辑器）⇒ 原样透传，不洗成 READ_FAILED', async () => {
    const service = createSemanticService({
      readers: { definitionAt: () => { throw new McpFailure('NOT_WIRED', '语义读数未接线：当前没有活动编辑器'); } },
    });
    await expect(service.read('definitionAt', { line: 1, column: 1 })).rejects.toMatchObject({
      code: 'NOT_WIRED',
      name: 'McpFailure',
      message: expect.stringContaining('没有活动编辑器'),
    });
  });

  it('code + toJSON({code,message}) 形状的匿名结构化失败也透传（形状契约，不绑定具体类）', async () => {
    const duck: { code: string; message: string; toJSON: () => { code: string; message: string } } = {
      code: 'RESOURCE_UNAVAILABLE',
      message: '宿主侧结构化失败',
      toJSON() {
        return { code: duck.code, message: duck.message };
      },
    };
    const service = createSemanticService({ readers: { referencesAt: () => { throw duck; } } });
    await expect(service.read('referencesAt', { line: 1, column: 1 })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });

  it('普通 Error / 非 Error ⇒ READ_FAILED 且原文在内；仅带 code 无 toJSON 的 Error（fs ENOENT 形）不认定为结构化', async () => {
    const enoent = new Error('file missing');
    (enoent as { code?: unknown }).code = 'ENOENT';
    const service = createSemanticService({
      readers: {
        diagnostics: () => { throw new Error('boom'); },
        tokens: () => { throw 'oops'; },
        documentSymbols: () => { throw enoent; },
      },
    });
    const failed = (await service.read('diagnostics', {}).catch((e: SemanticFailure) => e)) as SemanticFailure;
    expect(failed.code).toBe('READ_FAILED');
    expect(failed.message).toContain('boom');
    await expect(service.read('tokens', {})).rejects.toMatchObject({
      code: 'READ_FAILED',
      message: expect.stringContaining('oops'),
    });
    const wrapped = (await service.read('documentSymbols', {}).catch((e: SemanticFailure) => e)) as SemanticFailure;
    expect(wrapped.code).toBe('READ_FAILED');
    expect(wrapped.message).toContain('file missing');
  });
});

describe('codeActionsAt 严格只读（绝不 apply）', () => {
  it('服务面恰 {specs, read}：无 apply / execute / run 任何执行出口', () => {
    const service = createSemanticService({ readers: {} }) as unknown as Record<string, unknown>;
    expect(Object.keys(service).sort()).toEqual(['read', 'specs']);
    expect(service['apply']).toBeUndefined();
    expect(service['execute']).toBeUndefined();
    expect(service['run']).toBeUndefined();
    expect(service['accept']).toBeUndefined();
  });

  it('codeActionsAt 只收 {line,column}，动作对象原引用透传、内容零改动', async () => {
    const received: Record<string, unknown>[] = [];
    const action = Object.freeze({
      title: '补 import',
      kind: 'quickfix',
      isPreferred: true,
      edit: Object.freeze({ edits: Object.freeze([]) }),
      command: Object.freeze({ id: 'never.run' }),
    });
    const service = createSemanticService({
      readers: { codeActionsAt: (a) => { received.push(a); return [action]; } },
    });
    const out = (await service.read('codeActionsAt', { line: 4, column: 2 })) as unknown[];
    expect(received).toHaveLength(1);
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(['column', 'line']);
    expect(received[0]).toEqual({ line: 4, column: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(action); // 原引用透传
    expect(out[0]).toEqual({
      title: '补 import', kind: 'quickfix', isPreferred: true, edit: { edits: [] }, command: { id: 'never.run' },
    });
  });
});
