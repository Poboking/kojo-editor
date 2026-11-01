/**
 * 语言服务接线单测（kojo-sugar 侧的 `ui.editor.languageService` 贡献）。
 *
 * 与 `definition.test.ts` 的分工：那里测**纯逻辑**，这里测**装配**——贡献确实注册、
 * 文件门确实生效（只认 `.kojo1`，ERB 让给 erb-parser）、未打开项目时是"认但无目标"
 * 而不是崩或谎报。
 *
 * 用本文件自带的极小上下文体（kojo-sugar 现有测试都是服务级，没有插件级夹具）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, PluginContext } from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '../src/index';

interface SlotRecord {
  kind: string;
  contribution: Record<string, unknown>;
}

function activate(): { slots: SlotRecord[]; provided: string[] } {
  const slots: SlotRecord[] = [];
  const provided: string[] = [];
  const noop = (): void => undefined;
  const slotApi = {
    query: () => [],
    register: (kind: string, contribution: Record<string, unknown>) => {
      slots.push({ kind, contribution });
      return noop;
    },
  };
  const ctx = {
    pluginId: 'kojo-sugar',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: { on: () => noop, once: () => noop, emit: noop },
    inject: <T,>(key: string): T => {
      if (key === KernelServices.Project) return { current: () => null } as unknown as T;
      if (key === KernelServices.Slots) return slotApi as unknown as T;
      if (key === KernelServices.IO) return {} as unknown as T;
      // 其余（state.replay / erb.parser）走软取：抛错由装配层吞掉
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string) => {
      provided.push(key);
    },
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    slots: slotApi,
    onDispose: noop,
  } as unknown as PluginContext;
  createKojoSugarPlugin().activate(ctx);
  return { slots, provided };
}

type LanguageServiceContribution = {
  id: string;
  provide(request: unknown): { kind: string; locations: unknown[] } | undefined;
};

describe('kojo-sugar · ui.editor.languageService 装配', () => {
  it('注册了语言服务贡献（id 稳定）；`.kojo1` 之外的文件一律不认', () => {
    const { slots } = activate();
    const hit = slots.find((s) => s.kind === 'ui.editor.languageService');
    expect(hit).toBeDefined();
    const c = hit!.contribution as unknown as LanguageServiceContribution;
    expect(c.id).toBe('kojo-definition');

    // ERB 让给 erb-parser（两条线各管自己认得的文件）
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.ERB', text: 'CALL X', line: 1, column: 8 })).toBe(
      undefined,
    );
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.erb', text: 'CALL X', line: 1, column: 8 })).toBe(
      undefined,
    );
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.txt', text: 'CALL X', line: 1, column: 8 })).toBe(
      undefined,
    );
  });

  it('`.kojo1`：未打开项目（无索引）→ 认这个文件但给空目标（不崩、不猜）', () => {
    const { slots } = activate();
    const c = slots.find((s) => s.kind === 'ui.editor.languageService')!.contribution as unknown as LanguageServiceContribution;
    // 纯注释源：转译无 error，但产物里没有 `@` 头 → 自证腿放弃 → 索引缺席 → 空
    const res = c.provide({
      kind: 'definition',
      path: 'C:\\p\\a.kojo1',
      text: '; 空口上\n',
      line: 1,
      column: 1,
    });
    expect(res).toEqual({ kind: 'definition', locations: [] });
  });

  it('字体能力服务仍在（装配未被本次改动破坏）', () => {
    const { provided } = activate();
    expect(provided).toContain('sugar.transpile');
  });
});

/* ============================== 跳到实现（LAU-COVERAGE 收口，2026-11-01） ============================== */

/**
 * `.kojo1` 的 `Ctrl+F12`（`kind: 'implementation'`）。
 *
 * 这一格此前是 LAU-COVERAGE 57 格矩阵里**唯一**的真缺口：宿主那枚收口腿对 kojo1 是挂着的
 * （`languageServices: true` ⇒ 全腿），但槽里没人答这条腿——ERB 供方只认 `.erb` 族，
 * 本包当时只有 `kojo-definition`。收口的做法是**供方补一条判别成员**，而不是宿主把定义腿
 * 借给实现（ERB-PARITY G3 删的正是那条捷径）。
 */
describe('kojo-sugar · implementation（Ctrl+F12）装配', () => {
  type LocationsContribution = {
    id: string;
    provide(request: unknown): { kind: string; locations: unknown[] } | undefined;
  };

  const contributionOf = (slots: SlotRecord[], id: string): LocationsContribution => {
    const hit = slots.find((s) => s.kind === 'ui.editor.languageService' && s.contribution.id === id);
    expect(hit, `语言服务成员 ${id} 没注册`).toBeDefined();
    return hit!.contribution as unknown as LocationsContribution;
  };

  /**
   * 真转译能自证的极小源：**原生 `@` 直通行**。
   *
   * 为什么不用「函数 …」糖：糖生成的产物名走 adapter 的 `userFunction.template`
   * （`M_KOJO_K12_<名>`），与源里写的 `计算伤害` 不是同一串，自证腿按"光标取到的名字
   * 去找同名 `@` 头"必然落空；本夹具又无适配器分野表 / 无项目索引，所以只有**名字在
   * 源里逐字出现**的原生 `@` 头能拿到非空落点。这与作者在 `.kojo1` 里手写 `@` 块的
   * 真实情形同形（本包本来就允许原生块直通，源映射 1:1 带列）。
   */
  const SOURCE = '@M_KOJO_K12_X(ARG)\n\tRETURN 1\n';
  /** 声明位：第 1 行第 3 列落在 `M_KOJO_K12_X` 里（`@` 之后第一格） */
  const DECL_AT = { path: 'C:\\p\\a.kojo1', text: SOURCE, line: 1, column: 3 };

  it('id 稳定；`.kojo1` 之外的文件一律不认（ERB 让给 erb-parser）', () => {
    const { slots } = activate();
    const c = contributionOf(slots, 'kojo-implementation');
    expect(c.id).toBe('kojo-implementation');
    for (const p of ['C:\\p\\a.ERB', 'C:\\p\\a.erb', 'C:\\p\\a.txt']) {
      expect(c.provide({ kind: 'implementation', path: p, text: 'CALL X', line: 1, column: 8 })).toBeUndefined();
    }
  });

  it('只答 implementation：同一条请求换成 definition 不归它管（两腿各发各的 kind）', () => {
    const { slots } = activate();
    expect(
      contributionOf(slots, 'kojo-implementation').provide({ kind: 'definition', ...DECL_AT }),
    ).toBeUndefined();
  });

  it('与定义腿**同一批落点**：实现 = 定义位（口径归供方说，不是宿主借腿）', () => {
    const { slots } = activate();
    const def = contributionOf(slots, 'kojo-definition').provide({ kind: 'definition', ...DECL_AT });
    const impl = contributionOf(slots, 'kojo-implementation').provide({ kind: 'implementation', ...DECL_AT });
    expect(def, '定义腿在声明位没有落点——样例源或取词口径变了').toBeDefined();
    expect(def!.locations.length, '定义腿落点为空，本条的对比就失去意义').toBeGreaterThan(0);
    expect(impl).toEqual({ kind: 'implementation', locations: def!.locations });
  });

  it('未打开项目（无索引）⇒ 认这个文件但给空目标（不崩、不猜）', () => {
    const { slots } = activate();
    expect(
      contributionOf(slots, 'kojo-implementation').provide({
        kind: 'implementation',
        path: 'C:\\p\\a.kojo1',
        text: '; 空口上\n',
        line: 1,
        column: 1,
      }),
    ).toEqual({ kind: 'implementation', locations: [] });
  });
});

/* ============================== B3 文档大纲 ============================== */

describe('kojo-sugar · documentSymbol（B3 大纲）装配', () => {
  type SymbolsContribution = {
    id: string;
    provide(request: unknown): { kind: string; symbols: unknown[] } | undefined;
  };

  const symbolsOf = (slots: SlotRecord[]): SymbolsContribution => {
    const hit = slots.find(
      (s) => s.kind === 'ui.editor.languageService' && s.contribution.id === 'kojo-symbols',
    );
    if (!hit) throw new Error('ui.editor.languageService 未注册');
    return hit.contribution as unknown as SymbolsContribution;
  };

  it('十枚贡献各管一个判别成员（W6 补齐 `workspaceSymbol` / `codeLens` / `inlayHint` 三员，LAU-COVERAGE 补 `implementation` 一员）', () => {
    const { slots } = activate();
    expect(
      slots
        .filter((s) => s.kind === 'ui.editor.languageService')
        .map((s) => s.contribution.id)
        .sort(),
    ).toEqual([
      'kojo-code-lens',
      'kojo-definition',
      'kojo-folding',
      'kojo-implementation',
      'kojo-inlay-hints',
      'kojo-references',
      'kojo-rename',
      'kojo-semantic-tokens',
      'kojo-symbols',
      'kojo-workspace-symbols',
    ]);
  });

  it('只认 `.kojo1`；ERB / 其它扩展名一律 undefined（让给 erb-parser 那条线）', () => {
    const c = symbolsOf(activate().slots);
    expect(c.provide({ kind: 'documentSymbol', path: 'C:\\p\\a.ERB', text: '@A\n', project: null })).toBeUndefined();
    expect(c.provide({ kind: 'documentSymbol', path: 'C:\\p\\a.txt', text: '时机 指令 1：\n', project: null })).toBe(
      undefined,
    );
    // definition 请求不打扰大纲贡献
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.kojo1', text: '', line: 1, column: 1 })).toBeUndefined();
  });

  it('`.kojo1` → 大纲树；空文件 → 认但不给（`{ symbols: [] }`，不装不认）', () => {
    const c = symbolsOf(activate().slots);
    expect(c.provide({ kind: 'documentSymbol', path: 'C:\\p\\a.kojo1', text: '', project: null })).toEqual({
      kind: 'documentSymbol',
      symbols: [],
    });
    const res = c.provide({
      kind: 'documentSymbol',
      path: 'C:\\p\\a.kojo1',
      text: '角色: 12\n时机 指令 310：\n    「嗯。」\n',
      project: null,
      lineCount: 3,
    });
    expect(res?.kind).toBe('documentSymbol');
    expect(res!.symbols).toHaveLength(1);
    // 止行含末行换行后的那一线空行（模型也这么数行）——区间覆盖到文件尾，不留"截半个块"
    expect(res!.symbols[0]).toMatchObject({ name: '时机 指令 310', startLine: 2, endLine: 4 });
  });
});

/* ============================== D3 折叠范围 ============================== */

describe('kojo-sugar · foldingRange（D3 折叠）装配', () => {
  type FoldingContribution = {
    id: string;
    provide(request: unknown): { kind: string; ranges: { startLine: number; endLine: number }[] } | undefined;
  };

  const foldingOf = (slots: SlotRecord[]): FoldingContribution => {
    const hit = slots.find(
      (s) => s.kind === 'ui.editor.languageService' && s.contribution.id === 'kojo-folding',
    );
    if (!hit) throw new Error('kojo-folding 未注册');
    return hit.contribution as unknown as FoldingContribution;
  };

  it('只认 `.kojo1`；ERB / 其它判别成员一律 undefined（各管各的）', () => {
    const c = foldingOf(activate().slots);
    expect(c.provide({ kind: 'foldingRange', path: 'C:\\p\\a.ERB', text: '@A\n', project: null })).toBeUndefined();
    expect(c.provide({ kind: 'documentSymbol', path: 'C:\\p\\a.kojo1', text: '', project: null })).toBeUndefined();
  });

  it('`.kojo1` → 区间摊平自大纲树；空文件 → 认但不给（`{ ranges: [] }`）', () => {
    const c = foldingOf(activate().slots);
    expect(c.provide({ kind: 'foldingRange', path: 'C:\\p\\a.kojo1', text: '', project: null })).toEqual({
      kind: 'foldingRange',
      ranges: [],
    });
    const res = c.provide({
      kind: 'foldingRange',
      path: 'C:\\p\\a.kojo1',
      text: '角色: 12\n时机 指令 310：\n    「嗯。」\n',
      project: null,
      lineCount: 3,
    });
    expect(res?.kind).toBe('foldingRange');
    expect(res!.ranges).toContainEqual({ startLine: 2, endLine: 4 });
  });
});

/* ============================== B6 结构化着色 ============================== */

describe('kojo-sugar · semanticToken（B6 着色）装配', () => {
  const KOJO = 'C:\\p\\a.kojo1';
  const tokensOf = (slots: SlotRecord[]) => {
    const hit = slots.find(
      (s) => s.kind === 'ui.editor.languageService' && s.contribution.id === 'kojo-semantic-tokens',
    );
    if (!hit) throw new Error('kojo-semantic-tokens 未注册');
    return hit.contribution as unknown as { provide(request: unknown): { kind: string; spans: unknown[] } | undefined };
  };

  it('只认 `.kojo1`；ERB / 其它判别成员一律 undefined（让给 erb-parser 那条线）', () => {
    const { slots } = activate();
    const c = tokensOf(slots);
    expect(c.provide({ kind: 'semanticToken', path: 'C:\\p\\a.ERB', text: '@A\n', project: null })).toBeUndefined();
    expect(c.provide({ kind: 'semanticToken', path: 'C:\\p\\a.txt', text: '函数 甲：\n', project: null })).toBeUndefined();
    expect(c.provide({ kind: 'documentSymbol', path: KOJO, text: '函数 甲：\n', project: null })).toBeUndefined();
  });

  it('声明位与调用位各得其所（装配面走通纯函数 semantic-tokens.ts）', () => {
    const { slots } = activate();
    const res = tokensOf(slots).provide({
      kind: 'semanticToken',
      path: KOJO,
      text: '函数 计算伤害(次数)：\n  返回 次数\n',
      project: null,
      lineCount: 2,
    });
    expect(res?.kind).toBe('semanticToken');
    expect(res!.spans.map((s) => (s as { tokenType: string }).tokenType).sort()).toEqual([
      'function',
      'parameter',
    ]);
  });

  it('空文本 → 认这个文件但无可着色 span', () => {
    const { slots } = activate();
    expect(tokensOf(slots).provide({ kind: 'semanticToken', path: KOJO, text: '', project: null })).toEqual({
      kind: 'semanticToken',
      spans: [],
    });
  });
});
