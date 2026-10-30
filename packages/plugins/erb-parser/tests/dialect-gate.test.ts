/**
 * 方言守门单测（W6 PARITY-EXT 批复核，2026-10-17）。
 *
 * 钉三件事，都是"两份谓词迟早分叉"这一类坑的正面自证：
 * 1. **族内全收**：应答面按 `plugin-api` 的 `ERB_DIALECT_EXTENSIONS` **派生**逐个验
 *    （不在测试里另抄一张扩展名清单——抄的那刻起本条就只钉得住抄的那份）；
 *    将来 `.erd` 接线（`ERB_ENGINE_RESERVED_EXTENSIONS` 那条留位）时本条自动跟上；
 * 2. **族外才拒**：`.kojo` 归糖线（行号属派生文本，本包答它等于把产物行号贴到源文件脸上）、
 *    杂文件不归任何线；
 * 3. **拒 ≠ 空**：`undefined`（不认这个请求）与"认得但这篇无话可说"（空数组）两态分开，
 *    且都不抛。
 */

import { describe, expect, it } from 'vitest';
import type {
  EditorLanguageServiceContribution,
  ErbParserService,
  FileIO,
  PluginContext,
  Unsubscribe,
} from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS, KernelServices } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';

const FILES: Record<string, string> = {
  '/t/A.ERB': '@ALPHA(ARG)\n\tRETURN 1\n',
  '/t/B.ERB': '@CALLER\n\tCALL ALPHA(1)\n',
};

function fakeIO(): FileIO {
  const read = (path: string) => {
    const text = FILES[path];
    return text === undefined ? null : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
  };
  return {
    async walkDir(root: string) {
      return Object.keys(FILES)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((p) => read(p));
    },
    async readText(path: string) {
      const file = read(path);
      if (!file) throw new Error(`not found: ${path}`);
      return file;
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: 0, isDirectory: false };
    },
  } as unknown as FileIO;
}

async function activate(): Promise<{ service: ErbParserService; of: (id: string) => EditorLanguageServiceContribution }> {
  const registered: Array<{ kind: string; contribution: EditorLanguageServiceContribution }> = [];
  const services = new Map<string, unknown>();
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: { on: () => noop, once: () => noop, emit: noop } as unknown as PluginContext['bus'],
    inject: <T,>(key: string): T => {
      if (key === KernelServices.IO) return fakeIO() as unknown as T;
      if (key === KernelServices.Compute) return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => {
      services.set(key, value);
    },
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    slots: {
      register: (kind: string, contribution: EditorLanguageServiceContribution) => {
        registered.push({ kind, contribution });
        return noop;
      },
      query: () => [],
    },
    onDispose: (_fn: () => void) => undefined as unknown as Unsubscribe,
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  const service = services.get('erb.parser') as ErbParserService;
  await service.buildIndex(['/t']);
  return {
    service,
    of: (id: string) => {
      const hit = registered.find((entry) => entry.contribution.id === id);
      if (!hit) throw new Error(`${id} 未注册`);
      return hit.contribution;
    },
  };
}

/** 带守门的应答方（各自认识的判别成员；文本取一份最小的"有定义 + 有调用"样本） */
const GATED: ReadonlyArray<{ id: string; kind: 'definition' | 'documentSymbol' | 'foldingRange' | 'codeLens' | 'semanticToken' | 'inlayHint' | 'references' }> = [
  { id: 'erb-definition', kind: 'definition' },
  { id: 'erb-symbols', kind: 'documentSymbol' },
  { id: 'erb-folding', kind: 'foldingRange' },
  { id: 'erb-usage-lens', kind: 'codeLens' },
  { id: 'erb-semantic-tokens', kind: 'semanticToken' },
  { id: 'erb-inlay-hints', kind: 'inlayHint' },
  { id: 'erb-references', kind: 'references' },
];

describe('erb-parser · 方言守门（判据收成一处）', () => {
  it('方言族内每一种扩展名（含大写形态）都被应答——族清单只认契约那一份', async () => {
    const { of } = await activate();
    for (const contribution of ERB_DIALECT_EXTENSIONS) {
      const path = `/t/目录/名${contribution.toUpperCase()}`; // 盘上真形态是大写：守门必须大小写不敏感
      for (const gate of GATED) {
        const responder = of(gate.id);
        const result = responder.provide({
          kind: gate.kind,
          path,
          text: '@ALPHA(ARG)\n\tCALL ALPHA(1)\n',
          line: 1,
          column: 2,
          project: null,
        } as never);
        expect(result, `${gate.id} 该认方言族成员 ${contribution}（大小写不敏感）`).toBeDefined();
        expect((result as { kind: string }).kind).toBe(gate.kind);
      }
    }
  });

  it('`.kojo` 与杂文件一律 `undefined`（归糖线 / 谁都不归）；方言族之外一条不答', async () => {
    const { of } = await activate();
    for (const path of ['/t/A.kojo', '/t/a.txt', '/t/a.csv', '/t/a.als', '/t/a']) {
      for (const gate of GATED) {
        expect(
          of(gate.id).provide({ kind: gate.kind, path, text: '@ALPHA(ARG)\n', line: 1, column: 2, project: null } as never),
          `${gate.id} 不该答 ${path}`,
        ).toBeUndefined();
      }
    }
  });

  it('工作区符号没有文件可守门：它按查询答，与当前文件是什么扩展名无关', async () => {
    const { of } = await activate();
    const responder = of('erb-workspace-symbols');
    // 请求形状里就没有 `path`（契约 `EditorWorkspaceSymbolRequest`），守门无从谈起
    const hit = responder.provide({ kind: 'workspaceSymbol', query: 'ALPHA', project: null });
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('workspaceSymbol');
    if (hit!.kind === 'workspaceSymbol') expect(hit!.symbols.length).toBeGreaterThan(0);
  });

  it('认得但无话可说 = 空数组，不抛（守门拒与名录空是两态）', async () => {
    const { of } = await activate();
    expect(of('erb-usage-lens').provide({ kind: 'codeLens', path: '/t/C.ERB', text: '', project: null })).toEqual({
      kind: 'codeLens',
      lenses: [],
    });
    expect(of('erb-inlay-hints').provide({ kind: 'inlayHint', path: '/t/C.ERB', text: '', project: null })).toEqual({
      kind: 'inlayHint',
      hints: [],
    });
    expect(() => of('erb-semantic-tokens').provide({ kind: 'semanticToken', path: '/t/C.ERB', text: '', project: null })).not.toThrow();
    // 空查询：名录在场也只给空（"先打字再出项"），不整份倒出来
    const empty = of('erb-workspace-symbols').provide({ kind: 'workspaceSymbol', query: '   ', project: null });
    expect(empty).toEqual({ kind: 'workspaceSymbol', symbols: [], totalMatched: 0 });
  });

  it('索引缺席时**依赖索引的那几枚**不答（未打开项目 ≠ 没有引用）', async () => {
    // 不复用上面建好索引的夹具：本条要的就是"一枚都没建过索引的解析器"。
    // 只点**读索引**的四枚 + 工作区符号——大纲/折叠/着色本来就是缓冲区事实，
    // 与项目开闭无关（它们继续答是对的，见各自注册注）。
    const registered: Array<EditorLanguageServiceContribution> = [];
    const noop = (): void => undefined;
    const ctx = {
      pluginId: 'erb-parser',
      log: { debug: noop, info: noop, warn: noop, error: noop },
      bus: { on: () => noop, once: () => noop, emit: noop },
      inject: <T,>(key: string): T => {
        if (key === KernelServices.IO) return fakeIO() as unknown as T;
        if (key === KernelServices.Compute) return makeComputeStub() as unknown as T;
        throw new Error(`unexpected inject: ${key}`);
      },
      provide: noop,
      storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
      slots: { register: (_kind: string, c: EditorLanguageServiceContribution) => registered.push(c), query: () => [] },
      onDispose: noop,
    } as unknown as PluginContext;
    createErbParserPlugin().activate(ctx);
    const indexDependent = [
      { id: 'erb-references', kind: 'references' },
      { id: 'erb-usage-lens', kind: 'codeLens' },
      { id: 'erb-inlay-hints', kind: 'inlayHint' },
    ] as const;
    for (const gate of indexDependent) {
      const responder = registered.find((c) => c.id === gate.id)!;
      expect(
        responder.provide({
          kind: gate.kind,
          path: '/t/B.ERB',
          text: FILES['/t/B.ERB']!,
          line: 2,
          column: 7,
          project: null,
        } as never),
        `${gate.id} 在没有索引时该闭嘴（不答）`,
      ).toBeUndefined();
    }
    expect(
      registered.find((c) => c.id === 'erb-workspace-symbols')!.provide({ kind: 'workspaceSymbol', query: 'ALPHA', project: null }),
    ).toBeUndefined();
    // 定义腿：本地名字照答（缓冲区事实），函数索引腿零贡献（`locations: []`，不是弃权）
    const define = registered.find((c) => c.id === 'erb-definition')!.provide as (request: unknown) => unknown;
    expect(
      define({
        kind: 'definition',
        path: '/t/B.ERB',
        text: ['#DIM 好感度', '  好感度 = 1', ''].join('\n'),
        line: 2,
        column: 3,
        project: null,
      }),
    ).toEqual({
      kind: 'definition',
      locations: [{ filePath: '/t/B.ERB', line: 1, column: 6, span: { columnStart: 6, columnEnd: 9 } }],
    });
    expect(
      define({ kind: 'definition', path: '/t/B.ERB', text: FILES['/t/B.ERB']!, line: 2, column: 7, project: null }),
    ).toEqual({ kind: 'definition', locations: [] });
    // 缓冲区事实那三枚不受项目开闭影响（缺席也要能说"这篇没有定义 / 这篇的结构是这样"）
    expect(
      registered.find((c) => c.id === 'erb-symbols')!.provide({ kind: 'documentSymbol', path: '/t/B.ERB', text: FILES['/t/B.ERB']!, project: null }),
    ).toBeDefined();
  });
});
