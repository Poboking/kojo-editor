/**
 * 语言服务接线单测（`ui.editor.languageService` 槽 + `erb.parser.functionAt`）。
 *
 * 与 `symbols.test.ts` 的分工：那里测**纯逻辑**，这里测**装配**——槽确实注册了、
 * `functionAt` 确实能经服务拿到索引、三态返回（不认 / 认但无定义 / 有目标）确实成立。
 * 用本文件自带的极小上下文体（不动 `plugin.test.ts` 的共享夹具，避免与别人并行改同一文件）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, ErbParserService, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';

const A = '/t/A.ERB';
const B = '/t/B.ERB';
const FILES: Record<string, string> = {
  [A]: '; 目标文件\n@ALPHA(ARG)\n\tRETURN 1\n',
  [B]: '@CALLER\n\tCALL ALPHA(1)\n\tCALL NOPE\n',
};

function fakeIO(): FileIO {
  return {
    async readText(path: string) {
      const text = FILES[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = FILES[path];
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      });
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: null, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(FILES)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
}

interface SlotRecord {
  kind: string;
  contribution: Record<string, unknown>;
}

function activate(): {
  services: Map<string, unknown>;
  slots: SlotRecord[];
  dispose: () => void;
} {
  const services = new Map<string, unknown>();
  const slots: SlotRecord[] = [];
  const disposers: Array<() => void> = [];
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: {
      on: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      once: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      emit: noop,
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return fakeIO() as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      keys: async () => [],
    },
    slots: {
      register: (kind: string, contribution: Record<string, unknown>) => {
        slots.push({ kind, contribution });
        return noop;
      },
      query: () => [],
    },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return { services, slots, dispose: () => disposers.reverse().forEach((d) => d()) };
}

type LanguageServiceContribution = {
  id: string;
  provide(request: unknown): { kind: string; locations: { filePath: string; line: number }[] } | undefined;
};

/** 按 id 取语言服务贡献（B3 起两枚：`erb-definition` / `erb-symbols`；D2 加 `erb-workspace-symbols`；B6 加 `erb-semantic-tokens`） */
function languageServiceOf(slots: SlotRecord[], id = 'erb-definition'): LanguageServiceContribution {
  const hit = slots.find((s) => s.kind === 'ui.editor.languageService' && s.contribution.id === id);
  if (!hit) throw new Error(`ui.editor.languageService '${id}' 未注册`);
  return hit.contribution as unknown as LanguageServiceContribution;
}

describe('erb-parser · ui.editor.languageService 装配', () => {
  it('注册了语言服务贡献（id 稳定，便于宿主/诊断指认）', () => {
    const { slots } = activate();
    expect(
      slots
        .filter((s) => s.kind === 'ui.editor.languageService')
        .map((s) => s.contribution.id)
        .sort(),
    ).toEqual([
      'erb-definition',
      'erb-folding',
      'erb-references',
      'erb-inlay-hints',
      'erb-semantic-tokens',
      'erb-symbols',
      'erb-usage-lens',
      'erb-workspace-symbols',
    ]);
    expect(languageServiceOf(slots).id).toBe('erb-definition');
  });

  it('不认 `.kojo`（返回 undefined）；认 ERB 但记号未收录 → 空数组', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const c = languageServiceOf(slots);

    expect(c.provide({ kind: 'definition', path: '/t/X.kojo', text: 'CALL ALPHA', line: 1, column: 8 })).toBe(
      undefined,
    );

    const none = c.provide({
      kind: 'definition',
      path: B,
      text: FILES[B]!,
      line: 3, // `CALL NOPE`
      column: 8,
      project: null,
    });
    expect(none).toEqual({ kind: 'definition', locations: [] });
  });

  it('认 ERB：跨文件命中定义行（`.kojo` 那条线没有产出 / 非该项目文件）', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const c = languageServiceOf(slots);
    const res = c.provide({
      kind: 'definition',
      path: B,
      text: FILES[B]!,
      line: 2, // `CALL ALPHA(1)`
      column: 8,
      project: null,
    });
    expect(res).toEqual({ kind: 'definition', locations: [{ filePath: A, line: 2 }] });
  });

  it('索引未建（未打开项目）→ undefined（不是本包的活，别谎报"没有定义"）', () => {
    const { slots } = activate();
    const c = languageServiceOf(slots);
    expect(c.provide({ kind: 'definition', path: B, text: FILES[B]!, line: 2, column: 8, project: null })).toBe(
      undefined,
    );
  });

  it('`erb.parser.functionAt` 只读当前索引：未建 → undefined；建好 → 包围反查', async () => {
    const { services } = activate();
    const parser = services.get('erb.parser') as ErbParserService;
    expect(parser.functionAt!(B, 2)).toBeUndefined();
    await parser.buildIndex(['/t']);
    // A 的第 1 行是注释（不在任何函数体内）→ undefined；2..3 才是 @ALPHA 的区间
    expect(parser.functionAt!(A, 1)).toBeUndefined();
    expect(parser.functionAt!(A, 2)?.name).toBe('ALPHA');
    expect(parser.functionAt!(A, 3)?.name).toBe('ALPHA');
    expect(parser.functionAt!(A, 99)).toBeUndefined();
  });
});

/* ============================== B3 文档大纲 ============================== */

describe('erb-parser · documentSymbol（B3 大纲）', () => {
  /** 大纲贡献的返回形状与 definition 不同（`symbols` 树），故单独收窄一层 */
  const symbolsOf = (slots: SlotRecord[]) =>
    languageServiceOf(slots, 'erb-symbols') as unknown as {
      provide(request: unknown): { kind: string; symbols: Record<string, unknown>[] } | undefined;
    };

  it('不认 `.kojo`（undefined）；认但空文本 → `{ symbols: [] }`（认但不给，不装不认）', () => {
    const { slots } = activate();
    const c = symbolsOf(slots);
    expect(c.provide({ kind: 'documentSymbol', path: '/t/X.kojo', text: '@A\n', project: null })).toBeUndefined();
    expect(c.provide({ kind: 'documentSymbol', path: A, text: '', project: null })).toEqual({
      kind: 'documentSymbol',
      symbols: [],
    });
  });

  it('definition 请求不打扰大纲贡献（判别式各管各的）', () => {
    const { slots } = activate();
    expect(
      symbolsOf(slots).provide({ kind: 'definition', path: A, text: FILES[A]!, line: 2, column: 2, project: null }),
    ).toBeUndefined();
  });

  it('大纲来自**缓冲区文本**而非索引：未打开项目也给出，行号跟着未保存的编辑走', () => {
    const { slots } = activate();
    // 无注释、无形参 ⇒ 不给 detail（空串副标题是噪声）
    const text = '\n\n@BETA\n\tRETURN 1\n';
    const res = symbolsOf(slots).provide({ kind: 'documentSymbol', path: A, text, project: null });
    expect(res?.kind).toBe('documentSymbol');
    expect(res!.symbols).toEqual([{ name: 'BETA', kind: 'function', startLine: 3, endLine: 5 }]);
  });

  it('带注释块时用注释首行当副标题，无注释时用形参；`#DIM` 也进大纲（声明文件不空）', () => {
    const { slots } = activate();
    const c = symbolsOf(slots);
    const text = '#DIM FOO\n;====\n;告白用\n@GAMMA(ARGS, ARG:1)\n\tRETURN 1\n';
    const symbols = c.provide({ kind: 'documentSymbol', path: A, text, project: null })!.symbols;
    expect(symbols.map((s) => s.name)).toEqual(['FOO', 'GAMMA']);
    expect(symbols[0]).toMatchObject({ kind: 'declaration', startLine: 1, endLine: 1, detail: 'DIM' });
    expect(symbols[1]).toMatchObject({ kind: 'function', startLine: 4, detail: '告白用' });
    // 注释优先于形参；只有形参时给形参
    const paramsOnly = c.provide({
      kind: 'documentSymbol',
      path: A,
      text: '@GAMMA(ARGS, ARG:1)\n\tRETURN 1\n',
      project: null,
    })!.symbols;
    expect(paramsOnly[0]).toMatchObject({ detail: '(ARGS, ARG:1)' });
  });

  it('超长注释截断（大纲一行放不下；截断带省略号）', () => {
    const { slots } = activate();
    const long = `;${'字'.repeat(120)}\n@DELTA\n\tRETURN 1\n`;
    const detail = String(symbolsOf(slots).provide({ kind: 'documentSymbol', path: A, text: long, project: null })!
      .symbols[0]!.detail);
    expect(detail.length).toBeLessThanOrEqual(80);
    expect(detail.endsWith('…')).toBe(true);
  });
});

/* ============================== D3 折叠范围 ============================== */

describe('erb-parser · foldingRange（D3 折叠）装配', () => {
  const foldingOf = (slots: SlotRecord[]) =>
    languageServiceOf(slots, 'erb-folding') as unknown as {
      provide(request: unknown): { kind: string; ranges: { startLine: number; endLine: number }[] } | undefined;
    };

  it('只认 ERB 方言；`.kojo` / 其它判别成员一律 undefined（判别式各管各的）', () => {
    const { slots } = activate();
    const c = foldingOf(slots);
    expect(c.provide({ kind: 'foldingRange', path: '/t/X.kojo', text: '@A\n', project: null })).toBeUndefined();
    expect(
      c.provide({ kind: 'documentSymbol', path: A, text: FILES[A]!, project: null, lineCount: 3 }),
    ).toBeUndefined();
  });

  it('函数块与 IF…ENDIF 各成区间（装配面走通纯函数 folding.ts）', () => {
    const { slots } = activate();
    const res = foldingOf(slots).provide({
      kind: 'foldingRange',
      path: A,
      text: '@ALPHA\nIF A == 1\n\tPRINTL 甲\nENDIF\nRETURN\n',
      project: null,
      lineCount: 5,
    });
    expect(res?.kind).toBe('foldingRange');
    // 尾随换行也计一线（与 B3 大纲同口径）：函数区间到文件尾
    expect(res!.ranges).toContainEqual({ startLine: 1, endLine: 6 });
    expect(res!.ranges).toContainEqual({ startLine: 2, endLine: 4 });
  });

  it('空文本 → 认这个文件但无可折块（`{ ranges: [] }`，不装不认）', () => {
    const { slots } = activate();
    expect(foldingOf(slots).provide({ kind: 'foldingRange', path: A, text: '', project: null })).toEqual({
      kind: 'foldingRange',
      ranges: [],
    });
  });
});

/* ============================== B8 行上内联注解 ============================== */

describe('erb-parser · codeLens（B8 行上「被 N 处用到」）', () => {
  const lensOf = (slots: SlotRecord[]) =>
    languageServiceOf(slots, 'erb-usage-lens') as unknown as {
      provide(request: unknown): { kind: string; lenses: { line: number; label: string; target?: unknown }[] } | undefined;
    };

  it('未建索引 → undefined（本包不答，而不是答「没有引用」）；非方言 → undefined', () => {
    const { slots } = activate();
    const c = lensOf(slots);
    expect(c.provide({ kind: 'codeLens', path: A, text: FILES[A]!, project: null, lineCount: 3 })).toBeUndefined();
  });

  it('认 ERB 但整篇无话可说 → `{ lenses: [] }`（空文本同理，不装不认）', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const c = lensOf(slots);
    // B 里的 @CALLER 没有任何可证明的使用处 ⇒ 闭嘴；B 里也没有 ALPHA 的定义
    expect(c.provide({ kind: 'codeLens', path: B, text: FILES[B]!, project: null, lineCount: 3 })).toEqual({
      kind: 'codeLens',
      lenses: [],
    });
    expect(c.provide({ kind: 'codeLens', path: A, text: '', project: null, lineCount: 0 })).toEqual({
      kind: 'codeLens',
      lenses: [],
    });
    expect(c.provide({ kind: 'codeLens', path: '/t/X.kojo', text: 'CALL ALPHA', project: null, lineCount: 1 })).toBeUndefined();
  });

  it('A 的 @ALPHA 被 B 用了一次 ⇒ 钉在定义行、给出可点的落点', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const res = lensOf(slots).provide({ kind: 'codeLens', path: A, text: FILES[A]!, project: null, lineCount: 3 });
    expect(res?.lenses).toHaveLength(1);
    expect(res!.lenses[0]!.line).toBe(2); // @ALPHA 在 A 的第 2 行
    expect(res!.lenses[0]!.label).toBe('被 1 处用到');
    expect(res!.lenses[0]!.target).toMatchObject({ filePath: B, line: 2 });
  });

  it('缓冲区改了名字、索引还不认识 ⇒ 这一行不开口（不拿旧行号说话）', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const res = lensOf(slots).provide({
      kind: 'codeLens',
      path: A,
      text: '; 目标文件\n@BETA(ARG)\n\tRETURN 1\n', // ALPHA 已被改名
      project: null,
      lineCount: 3,
    });
    expect(res?.lenses).toEqual([]);
  });
});

/* ============================== B6 结构化着色 ============================== */

describe('erb-parser · semanticToken（B6 着色）装配', () => {
  const tokensOf = (slots: SlotRecord[]) =>
    languageServiceOf(slots, 'erb-semantic-tokens') as unknown as {
      provide(request: unknown): { kind: string; spans: unknown[] } | undefined;
    };

  it('只认 ERB 方言；`.kojo` / 其它判别成员一律 undefined（判别式各管各的）', () => {
    const { slots } = activate();
    const c = tokensOf(slots);
    expect(c.provide({ kind: 'semanticToken', path: '/t/X.kojo', text: '@A\n', project: null })).toBeUndefined();
    expect(
      c.provide({ kind: 'foldingRange', path: A, text: FILES[A]!, project: null, lineCount: 3 }),
    ).toBeUndefined();
  });

  it('索引未建时**仍应答**声明（`@` 与 `#DIM` 是缓冲区事实，与项目开闭无关）', () => {
    const { slots } = activate();
    const res = tokensOf(slots).provide({
      kind: 'semanticToken',
      path: A,
      text: '#DIM FLAG_X\n@ALPHA(ARG)\n\tRETURN 1\n',
      project: null,
      lineCount: 3,
    });
    expect(res?.kind).toBe('semanticToken');
    expect(res!.spans.map((s) => (s as { tokenType: string }).tokenType).sort()).toEqual([
      'function',
      'parameter',
      'variable',
    ]);
  });

  it('索引建好后引用点补上（判据 = 反向索引那把尺子；CALL 的名字带 `function`）', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const res = tokensOf(slots).provide({
      kind: 'semanticToken',
      path: B,
      text: '@CALLER\n\tCALL ALPHA(1)\n\tCALL NOPE\n',
      project: null,
      lineCount: 3,
    });
    expect(res!.spans).toEqual([
      { line: 1, startColumn: 2, endColumn: 8, tokenType: 'function', modifiers: ['declaration'] },
      { line: 2, startColumn: 7, endColumn: 12, tokenType: 'function' },
    ]);
  });

  it('空文本 → 认这个文件但无可着色 span（不装不认）', () => {
    const { slots } = activate();
    expect(tokensOf(slots).provide({ kind: 'semanticToken', path: A, text: '', project: null })).toEqual({
      kind: 'semanticToken',
      spans: [],
    });
  });
});
