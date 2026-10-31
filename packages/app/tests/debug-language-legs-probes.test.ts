/**
 * 调试面 · 让位三腿取证读数（1031 批）的判据。
 *
 * LAU-DUALLEG 把 ERB 的 `documentHighlight` / `selectionRange` / `codeLens` 三格按 descriptor
 * 点名让位给共享槽腿——三格今天没有探针，组长只能拿源码形状间接判断腿活没活。本批补上
 * `highlightsAt` / `selectionRangesAt` / `lensesAt` 三枚读数（走**同一个** `collectFromProviders`
 * 直问 `ILanguageFeaturesService`，PITFALLS 304：不许拿键盘快捷键驱动 Monaco），判据分两块：
 *
 * 1. **纯函数裁剪**（node 里就能钉死）：`slimHighlights` / `slimSelectionChains` /
 *    `unpackCodeLenses` / `resolveLensEntryCommands` / `lensItemOf`——脏值不抛、缺 range 丢弃、
 *    上限截断、三态计数、lens 解析预算与"回包形态不认识不算解析成功"。
 * 2. **源形状守门**（照 `debug-semantic-surface.test.ts` 的先例）：三枚探针都在 `KojoDebugApi`
 *    公开面上、都经 `collectFromProviders` 走注册表、没走 UI 事件（getAction / trigger / DOM），
 *    lens 腿真的追问 `resolveLensEntryCommands`，且**既有六条腿一个字节都没被带上 stats**
 *    （只加不改的取证）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  lensItemOf,
  resolveLensEntryCommands,
  slimHighlights,
  slimSelectionChains,
  unpackCodeLenses,
  type DebugLensEntry,
} from '../src/debug/install-debug';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const range = (
  line: number,
  column: number,
  endLine?: number,
  endColumn?: number,
): Record<string, unknown> => ({
  startLineNumber: line,
  startColumn: column,
  ...(endLine === undefined ? {} : { endLineNumber: endLine }),
  ...(endColumn === undefined ? {} : { endColumn: endColumn }),
});

/* ----------------------------- 纯函数裁剪 ----------------------------- */

describe('让位三腿 · slimHighlights（同符号高亮区间）', () => {
  it('空 / null / 非数组 ⇒ 空数组（绝不抛）', () => {
    expect(slimHighlights([])).toEqual([]);
    expect(slimHighlights(null)).toEqual([]);
    expect(slimHighlights(undefined)).toEqual([]);
    expect(slimHighlights({ range: range(1, 1) })).toEqual([]);
    expect(slimHighlights([null, 42, 'x'])).toEqual([]);
  });

  it('契约形态照原样出：四角 1 基 + kind 数字', () => {
    expect(slimHighlights([{ range: range(2, 3, 2, 7), kind: 1 }])).toEqual([
      { line: 2, column: 3, endLine: 2, endColumn: 7, kind: 1 },
    ]);
  });

  it('kind 缺失 / 非数字 ⇒ 0（0 就是协议的默认档 text，不是猜出来的）', () => {
    expect(slimHighlights([{ range: range(1, 1, 1, 2) }])[0]?.kind).toBe(0);
    expect(slimHighlights([{ range: range(1, 1, 1, 2), kind: 'write' }])[0]?.kind).toBe(0);
    expect(slimHighlights([{ range: range(1, 1, 1, 2), kind: NaN }])[0]?.kind).toBe(0);
    expect(slimHighlights([{ range: range(1, 1, 1, 2), kind: 2.9 }])[0]?.kind).toBe(2);
    expect(slimHighlights([{ range: range(1, 1, 1, 2), kind: -1 }])[0]?.kind).toBe(0);
  });

  it('缺 range / 起点读不出 ⇒ 整条丢弃；尾缺失 ⇒ 同起点（退化区间，不编造跨行）', () => {
    expect(slimHighlights([{ kind: 1 }])).toEqual([]);
    expect(slimHighlights([{ range: { startColumn: 3 } }])).toEqual([]);
    expect(slimHighlights([{ range: range(0, 1, 2, 5) }])).toEqual([]);
    expect(slimHighlights([{ range: range(4, 2) }])).toEqual([
      { line: 4, column: 2, endLine: 4, endColumn: 2, kind: 0 },
    ]);
  });

  it('嵌套 {start,end} 形态也认（LSP 味道的回包不丢）', () => {
    expect(
      slimHighlights([
        { range: { start: { lineNumber: 3, column: 1 }, end: { lineNumber: 5, column: 4 } }, kind: 2 },
      ]),
    ).toEqual([{ line: 3, column: 1, endLine: 5, endColumn: 4, kind: 2 }]);
  });

  it('默认上限 50 条（脏条目不占位）', () => {
    const many = Array.from({ length: 60 }, (_v, i) => ({ range: range(i + 1, 1, i + 1, 9), kind: 0 }));
    const out = slimHighlights(many);
    expect(out).toHaveLength(50);
    expect(out[49]?.line).toBe(50);
    const mixed = [{ kind: 1 }, ...many];
    expect(slimHighlights(mixed)).toHaveLength(50);
    expect(slimHighlights(mixed)[0]?.line).toBe(1);
  });
});

describe('让位三腿 · slimSelectionChains（扩选链，原序）', () => {
  it('空 / 非数组 ⇒ 空数组；非数组元素整条丢（形态不认识的答不硬凑成链）', () => {
    expect(slimSelectionChains([])).toEqual([]);
    expect(slimSelectionChains(null)).toEqual([]);
    expect(slimSelectionChains([{ range: range(1, 1) }])).toEqual([]);
  });

  it('一个供方一条链，链内**按交回原序**——不重排、不去重', () => {
    const raw = [
      [{ range: range(2, 3, 2, 7) }, { range: range(2, 1, 2, 20) }, { range: range(2, 3, 2, 7) }],
      [{ range: range(1, 1, 9, 1) }],
    ];
    const chains = slimSelectionChains(raw);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toEqual([
      { line: 2, column: 3, endLine: 2, endColumn: 7 },
      { line: 2, column: 1, endLine: 2, endColumn: 20 },
      { line: 2, column: 3, endLine: 2, endColumn: 7 },
    ]);
    expect(chains[1]?.[0]).toEqual({ line: 1, column: 1, endLine: 9, endColumn: 1 });
  });

  it('链内脏档丢弃；全脏的链不留（空链由 answered 计数说，不占链位）', () => {
    const chains = slimSelectionChains([[null, 42, { noRange: true }, { range: range(1, 1, 1, 3) }]]);
    expect(chains).toEqual([[{ line: 1, column: 1, endLine: 1, endColumn: 3 }]]);
    expect(slimSelectionChains([[{ kind: 'nope' }]])).toEqual([]);
  });

  it('单链 ≤ 10 档、总共 ≤ 8 条链', () => {
    const long = Array.from({ length: 15 }, (_v, i) => ({ range: range(1, i + 1, 1, i + 2) }));
    expect(slimSelectionChains([long])[0]).toHaveLength(10);
    const many = Array.from({ length: 12 }, () => [long[0]]);
    expect(slimSelectionChains(many)).toHaveLength(8);
  });
});

describe('让位三腿 · unpackCodeLenses（整篇答卷按行过滤）', () => {
  const provider = { name: 'p' };

  it('CodeLensList {lenses} / 裸数组 / {value} 包装 / 单条 {range} 都认；其余形态不认', () => {
    const lens = { range: range(3, 1, 3, 8), command: { id: 'a', title: '引用 2' } };
    const entries = (result: unknown) => [{ provider, result }];
    expect(unpackCodeLenses(entries({ lenses: [lens] }), 3)).toHaveLength(1);
    expect(unpackCodeLenses(entries([lens]), 3)).toHaveLength(1);
    expect(unpackCodeLenses(entries({ value: { lenses: [lens] } }), 3)).toHaveLength(1);
    expect(unpackCodeLenses(entries(lens), 3)).toHaveLength(1);
    expect(unpackCodeLenses(entries({ nothing: true }), 3)).toHaveLength(0);
    expect(unpackCodeLenses(entries(null), 3)).toHaveLength(0);
  });

  it('只留覆盖该行的条目：startLine ≤ line ≤ endLine；缺 range 的丢弃', () => {
    const entries = [
      { provider, result: [
        { range: range(2, 1, 2, 9) },
        { range: range(4, 1, 6, 9) }, // 跨 4–6 行的块，落在第 5 行也算
        { range: range(7, 1, 7, 4) },
        { command: { id: 'x', title: '没坐标' } },
      ] },
    ];
    const out = unpackCodeLenses(entries, 5);
    expect(out).toHaveLength(1);
    expect(out[0]?.range).toEqual({ line: 4, column: 1, endLine: 6, endColumn: 9 });
    expect(unpackCodeLenses(entries, 2)[0]?.range.line).toBe(2);
    expect(unpackCodeLenses(entries, 99)).toHaveLength(0);
  });

  it('provider 归属**必须**留在条目上——resolveCodeLens 只能问产出它的那家', () => {
    const out = unpackCodeLenses([{ provider, result: [{ range: range(1, 1, 1, 4) }] }], 1);
    expect(out[0]?.provider).toBe(provider);
    // 入参里 provider 缺席 ⇒ null（后面解析腿会如实跳过它，不拿别家硬解）
    const noProvider = unpackCodeLenses([{ result: [{ range: range(1, 1, 1, 4) }] } as never], 1);
    expect(noProvider[0]?.provider).toBeNull();
  });

  it('非数组入参 / 脏 entry ⇒ 空；上限 30 条', () => {
    expect(unpackCodeLenses(null as never, 1)).toEqual([]);
    expect(unpackCodeLenses([null, 42] as never, 1)).toEqual([]);
    const many = Array.from({ length: 40 }, (_v, i) => ({
      provider,
      result: { lenses: Array.from({ length: 40 }, (_x, j) => ({ range: range(i + 1, j + 1, i + 1, j + 2) })) },
    }));
    expect(unpackCodeLenses(many, 7)).toHaveLength(30);
  });
});

describe('让位三腿 · resolveLensEntryCommands（逐枚问原 provider 解析）', () => {
  const entry = (lens: Record<string, unknown>, provider: unknown): DebugLensEntry => ({
    range: { line: 1, column: 1, endLine: 1, endColumn: 4 },
    lens,
    provider,
  });

  it('已带 command 的不动、不吃预算；没有 resolveCodeLens 的供方如实跳过', async () => {
    const withCommand = entry({ range: range(1, 1, 1, 4), command: { id: 'a', title: '已有' } }, {
      resolveCodeLens: () => {
        throw new Error('不该被调用');
      },
    });
    const noResolver = entry({ range: range(1, 1, 1, 4) }, {});
    expect(await resolveLensEntryCommands([withCommand, noResolver], {}, {}, { timeoutMs: 50 })).toBe(0);
    expect(withCommand.lens.command).toEqual({ id: 'a', title: '已有' });
    expect(noResolver.lens.command).toBeUndefined();
  });

  it('回包是带 range 的对象 ⇒ 替换原 lens，计数 +1', async () => {
    const resolvedLens = { range: range(1, 1, 1, 4), command: { id: 'kojo.x', title: '引用 3 处' } };
    const e = entry({ range: range(1, 1, 1, 4) }, { resolveCodeLens: () => resolvedLens });
    expect(await resolveLensEntryCommands([e], 'MODEL', 'TOKEN', { timeoutMs: 50 })).toBe(1);
    expect(e.lens).toBe(resolvedLens);
    expect(lensItemOf(e).title).toBe('引用 3 处');
  });

  it('回包形态不认识（缺 range / 数组 / null）⇒ 保留原 lens，不算解析成功', async () => {
    const bad1 = entry({ range: range(1, 1, 1, 4), mine: true }, { resolveCodeLens: () => ({ command: { title: '半截' } }) });
    const bad2 = entry({ range: range(1, 1, 1, 4), mine: true }, { resolveCodeLens: () => [1, 2] });
    const bad3 = entry({ range: range(1, 1, 1, 4), mine: true }, { resolveCodeLens: () => null });
    expect(await resolveLensEntryCommands([bad1, bad2, bad3], {}, {}, { timeoutMs: 50 })).toBe(0);
    expect(bad1.lens.mine).toBe(true);
    expect(bad2.lens.mine).toBe(true);
    expect(bad3.lens.mine).toBe(true);
  });

  it('抛错 / reject / 挂死都被吞（callWithin 超时），原 lens 不动', async () => {
    const thrower = entry({ range: range(1, 1, 1, 4), mine: true }, {
      resolveCodeLens: () => {
        throw new Error('provider 炸了');
      },
    });
    const rejecter = entry({ range: range(1, 1, 1, 4), mine: true }, {
      resolveCodeLens: () => Promise.reject(new Error('nope')),
    });
    const hanger = entry({ range: range(1, 1, 1, 4), mine: true }, {
      resolveCodeLens: () => new Promise(() => undefined),
    });
    const started = Date.now();
    expect(await resolveLensEntryCommands([thrower, rejecter, hanger], {}, {}, { timeoutMs: 40 })).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(thrower.lens.mine).toBe(true);
    expect(rejecter.lens.mine).toBe(true);
    expect(hanger.lens.mine).toBe(true);
  });

  it('预算：单轮最多解 budget 枚，没 command 的按序消耗', async () => {
    let calls = 0;
    const mk = (): DebugLensEntry =>
      entry({ range: range(1, 1, 1, 4) }, {
        resolveCodeLens: () => {
          calls += 1;
          return { range: range(1, 1, 1, 4), command: { id: 'x', title: `解 ${calls}` } };
        },
      });
    const entries = [mk(), mk(), mk()];
    expect(await resolveLensEntryCommands(entries, {}, {}, { timeoutMs: 50, budget: 2 })).toBe(2);
    expect(calls).toBe(2);
    expect(entries[2]?.lens.command).toBeUndefined();
    // budget=0 ⇒ 一枚都不问
    calls = 0;
    expect(await resolveLensEntryCommands([mk()], {}, {}, { timeoutMs: 50, budget: 0 })).toBe(0);
    expect(calls).toBe(0);
  });

  it('resolveCodeLens 同步返回 Promise（异步供方）也解得到', async () => {
    const e = entry({ range: range(1, 1, 1, 4) }, {
      resolveCodeLens: () => Promise.resolve({ range: range(1, 1, 1, 4), command: { id: 'p', title: '异步' } }),
    });
    expect(await resolveLensEntryCommands([e], {}, {}, { timeoutMs: 50 })).toBe(1);
    expect(lensItemOf(e)).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 4, title: '异步', commandId: 'p', resolved: true });
  });
});

describe('让位三腿 · lensItemOf（未解析/已解析如实分标）', () => {
  const entry = (lens: Record<string, unknown>): DebugLensEntry => ({
    range: { line: 6, column: 1, endLine: 6, endColumn: 12 },
    lens,
    provider: null,
  });

  it('有 command ⇒ resolved:true + title/commandId；command 非对象 ⇒ 视同没有', () => {
    expect(lensItemOf(entry({ range: range(6, 1, 6, 12), command: { id: 'erb.usage', title: '被引用 2 次' } }))).toEqual({
      line: 6, column: 1, endLine: 6, endColumn: 12, title: '被引用 2 次', commandId: 'erb.usage', resolved: true,
    });
    expect(lensItemOf(entry({ range: range(6, 1, 6, 12), command: 'x' })).resolved).toBe(false);
  });

  it('没 command ⇒ resolved:false、title/commandId 空串（不是 null——调用方不必判两种空值）', () => {
    expect(lensItemOf(entry({ range: range(6, 1, 6, 12) }))).toEqual({
      line: 6, column: 1, endLine: 6, endColumn: 12, title: '', commandId: '', resolved: false,
    });
  });

  it('超长 title 按 300 字符截断 + 省略号（与其余读数同口径）；换行归一', () => {
    const long = lensItemOf(entry({ command: { title: 'x'.repeat(400) } }));
    expect(long.title.length).toBe(301);
    expect(long.title.endsWith('…')).toBe(true);
    expect(lensItemOf(entry({ command: { title: ' 多行\n标题 ' } })).title).toBe('多行 标题');
  });
});

/* ----------------------------- 源形状守门 ----------------------------- */

describe('让位三腿 · 源形状守门（同一收集器 + 只读 + 不走 UI 事件）', () => {
  const source = read('packages/app/src/debug/install-debug.ts');

  const sliceFrom = (anchor: string, length: number): string => {
    const at = source.indexOf(anchor);
    expect(at, `install-debug.ts 里找不到锚点：${anchor}`).toBeGreaterThanOrEqual(0);
    return source.slice(at, at + length);
  };

  it('三枚读数都在 KojoDebugApi 公开接口上', () => {
    const apiSlice = sliceFrom('export interface KojoDebugApi {', 6800);
    for (const member of [
      'highlightsAt(line: number, column: number, opts?: SemanticQueryOptions): Promise<DebugHighlightsReading>',
      'selectionRangesAt(line: number, column: number, opts?: SemanticQueryOptions): Promise<DebugSelectionRangesReading>',
      'lensesAt(line: number, opts?: LensQueryOptions): Promise<DebugLensesReading>',
    ]) {
      expect(apiSlice, `KojoDebugApi.editor 缺 ${member}`).toContain(member);
    }
  });

  it('走的是注册表三枚新字段（0.57 实际名：documentHighlightProvider / selectionRangeProvider / codeLensProvider）', () => {
    for (const name of ['documentHighlightProvider', 'selectionRangeProvider', 'codeLensProvider']) {
      expect(source, `取数腿缺注册表 ${name}`).toContain(name);
    }
    // 方法名逐字取自 0.57 的 provider 契约
    for (const method of ['provideDocumentHighlights', 'provideSelectionRanges', 'provideCodeLenses']) {
      expect(source, `缺 provider 方法 ${method}`).toContain(method);
    }
  });

  it('三条探针都经同一个 collectFromProviders（没新建第二套收集器），各自吞错', () => {
    const probes: readonly (readonly [string, string])[] = [
      ['async highlightsAt(line, column, opts)', "'documentHighlightProvider'"],
      ['async selectionRangesAt(line, column, opts)', "'selectionRangeProvider'"],
      ['async lensesAt(line, opts)', "'codeLensProvider'"],
    ];
    for (const [anchor, registry] of probes) {
      const body = sliceFrom(anchor, 1800);
      expect(body, `${anchor} 没走 collectFromProviders`).toContain('collectFromProviders(');
      expect(body, `${anchor} 缺注册表参数 ${registry}`).toContain(registry);
      expect(body, `${anchor} 缺 catch（探针绝不抛）`).toContain('catch {');
      expect(body, `${anchor} 带三态 stats`).toContain('createProviderStats()');
    }
    // lens 的解析追问走 resolveLensEntryCommands（交回尽力解析后的读数）
    expect(sliceFrom('async lensesAt(line, opts)', 1800)).toContain('resolveLensEntryCommands(');
    expect(source).toContain('resolveCodeLens');
  });

  it('三枚探针不走 UI 事件：不 getAction、不 trigger、不碰私有 DOM 类名', () => {
    for (const anchor of [
      'async highlightsAt(line, column, opts)',
      'async selectionRangesAt(line, column, opts)',
      'async lensesAt(line, opts)',
    ]) {
      const body = sliceFrom(anchor, 1800);
      expect(body, `${anchor} 不许碰 getAction`).not.toContain('getAction');
      expect(body, `${anchor} 不许碰 trigger`).not.toContain('.trigger(');
      expect(body, `${anchor} 不许碰 querySelector`).not.toContain('querySelector');
      expect(body, `${anchor} 不许动光标/选区`).not.toContain('setPosition');
      expect(body, `${anchor} 不许读私有 DOM`).not.toContain('.monaco-');
    }
  });

  it('只加不改：既有六条腿的取数一个字节没被带上 stats（collectFromProviders 的老调用仍是五参）', () => {
    for (const anchor of [
      'async definitionAt(line, column, opts)',
      'async referencesAt(line, column, opts)',
      'async codeActionsAt(line, column, opts)',
      'async signatureAt(line, column, opts)',
      'async documentSymbols()',
    ]) {
      const body = sliceFrom(anchor, 1400);
      expect(body, `${anchor} 不该被改动（出现了 createProviderStats）`).not.toContain('createProviderStats');
    }
    // selfCheck().semantic 的六键形状没动：provider 三态仍只报那五枚 + diagnostics 恒 null
    expect(sliceFrom('export function probeProviderPresence', 900)).toContain('diagnostics: null');
  });
});
