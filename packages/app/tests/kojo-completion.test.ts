/**
 * C-1 · `.kojo` 补全**装配 seam**（`installKojoCompletion` + `KOJO_COMPLETION_SOURCES`）单测。
 *
 * Monaco 绑定刻意薄：本文件用**桩 monaco**（只记录注册调用与 `CompletionItemKind`）喂
 * provider，不引入真实 monaco-editor 运行时；候选来自静态词表 source（纯数据）。
 * 覆盖：(a) provider 确为 kojo 语言注册、triggerCharacters 含 `{` / `：`；
 * (b) 静态 source 在固定位置产出预期成员（别名 / `如果` / 系统函数 `(` 插入形态 / 前缀精确置顶）；
 * (c) `tables` 为空时不崩、且不产生任何非 adapter 候选（空表与满表候选集一致）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO_COMPLETION_SOURCES, installKojoCompletion, type CompletionTables } from '../src/monaco/kojo-completion';

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

/** 桩 monaco：只实现补全注册链所需的最薄面 */
function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4 },
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

/** 桩 model：`getValue`（别名扫描）+ `getWordUntilPosition`（已输入词）+ `getLineContent`（KC-1/KC-2 上下文解析） */
function modelOf(text: string, word = ''): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: () => ({ word, startColumn: 1, endColumn: 1 + word.length }),
  } as unknown as Monaco.editor.ITextModel;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

/** 走 provider 取一轮候选（同步实现 → 桩里直接读建议数组） */
function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  word = '',
  column = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, word),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/** 桩 adapter 表（形状与 `CompletionTables` 同构；用于验证「空表也不崩」） */
const fullTables: CompletionTables = {
  dictionary: { resolveFamily: () => undefined, resolve: () => undefined },
  faceTable: { faces: { 初见: { template: 'M_KOJO_K{n}_HATSUMI' } } },
  libraryTable: { hasTable: true, lookupByName: () => undefined },
  instructionTable: { hasTable: true, lookupByName: () => undefined, lookupByNo: () => undefined },
};

const SAMPLE = '别名 心 = 角色 3\n如果\n';

describe('C-1 · .kojo 补全装配（provider 注册）', () => {
  it('只注册一个 provider，且落在 kojo 语言上（.erb 无本模块 provider）', () => {
    const { monaco, registered } = stubMonaco();
    const dispose = installKojoCompletion(monaco, () => ({}));
    expect(registered).toHaveLength(1);
    expect(registered[0]!.languageId).toBe(KOJO_LANGUAGE_ID);
    dispose.dispose();
  });

  it('triggerCharacters 保守且含 `{` 与 `：`', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({}));
    const tc = registered[0]!.provider.triggerCharacters ?? [];
    expect(tc).toContain('{');
    expect(tc).toContain('：');
  });

  it('扩展点稳定：KOJO_COMPLETION_SOURCES 是可追加数组，含静态词表 source', () => {
    expect(Array.isArray(KOJO_COMPLETION_SOURCES)).toBe(true);
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-lexicon')).toBe(true);
  });

  it('KC-1 / KC-2 已接入扩展点：变量与分野 source 在册', () => {
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-variable')).toBe(true);
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-face')).toBe(true);
  });
});

describe('C-1 · 静态词表 source 产出', () => {
  const { monaco, registered } = stubMonaco();
  installKojoCompletion(monaco, () => ({}));
  const provider = registered[0]!.provider;

  it('中文主形关键字在列：`如果`（块关键字），且英文隐藏别名不进列表', () => {
    const items = provide(provider, SAMPLE, '如');
    const ifItem = items.find((i) => labelText(i.label) === '如果');
    expect(ifItem).toBeDefined();
    expect(ifItem!.detail).toBe('块关键字');
    expect(items.some((i) => labelText(i.label) === 'if')).toBe(false);
  });

  it('系统函数名以调用形态插入：`获取标记` → insertText `获取标记(`', () => {
    const items = provide(provider, SAMPLE, '获');
    const fn = items.find((i) => labelText(i.label) === '获取标记');
    expect(fn).toBeDefined();
    expect(fn!.insertText).toBe('获取标记(');
    expect(fn!.detail).toBe('系统函数');
  });

  it('本文件 `别名` 名在列（`心`），保留代词 `她` 在列', () => {
    const items = provide(provider, SAMPLE, '');
    expect(items.find((i) => labelText(i.label) === '心')!.detail).toBe('别名（本文件）');
    expect(items.find((i) => labelText(i.label) === '她')!.detail).toBe('保留代词');
  });

  it('排序：前缀精确命中置顶（已输入 `如果` → `如果` 排第一）', () => {
    const items = provide(provider, SAMPLE, '如果');
    expect(labelText(items[0]!.label)).toBe('如果');
  });
});

describe('C-1 · tables 缺席（fail-visible，不崩不猜）', () => {
  const emptyTables = stubMonaco();
  installKojoCompletion(emptyTables.monaco, () => ({}));
  const withTables = stubMonaco();
  installKojoCompletion(withTables.monaco, () => fullTables);

  it('空 tables 不崩，且与满 tables 候选逐字一致（静态 source 不消费 adapter 表）', () => {
    const emptyProvider = emptyTables.registered[0]!.provider;
    const fullProvider = withTables.registered[0]!.provider;
    expect(() => provide(emptyProvider, SAMPLE, '')).not.toThrow();
    const emptyItems = provide(emptyProvider, SAMPLE, '').map((i) => labelText(i.label));
    const fullItems = provide(fullProvider, SAMPLE, '').map((i) => labelText(i.label));
    expect(emptyItems.length).toBeGreaterThan(0);
    expect(fullItems).toEqual(emptyItems);
    // 静态 source 仅产语言/文件层候选：detail 全在固定集合内，无 adapter 派生项
    const details = new Set(provide(emptyProvider, SAMPLE, '').map((i) => i.detail));
    for (const d of details) {
      expect(['别名（本文件）', '保留代词', '运算符', '系统函数', '头部声明', '块关键字', '行内关键字', '别名右值']).toContain(d);
    }
  });

  it('KC-2 分野 source 经 provider 出货：行首 `时机 初` → 命中 `初见`（表驱动，零硬编码）', () => {
    const provider = withTables.registered[0]!.provider;
    const items = provide(provider, '时机 初', '初', 5);
    const hit = items.find((i) => labelText(i.label) === '初见');
    expect(hit).toBeDefined();
    expect(hit!.detail).toBe('M_KOJO_K{n}_HATSUMI');
  });
});
