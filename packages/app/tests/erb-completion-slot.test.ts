/**
 * LAU-4 补全腿第三批 · **槽级断言**（2026-10-31 收口）。
 *
 * `.erb` 的补全在生产路径上只剩三层：①descriptor 声明（要不要事实袋 / 追加哪些触发字符）；
 * ②共享槽腿（`installSlotServiceProviders` 的 `completion` 格）问 `ui.editor.languageService`；
 * ③契约项 → Monaco 条目的翻译。本文件逐层钉住：
 *
 * - **ERB 供方在场**：ERB 模型的请求打到槽上、由 ERB 插件贡献作答，候选数与关键项钉值；
 * - **非 ERB 弃权**：同一份贡献对 `.kojo2` 模型答 `undefined`（整轮零候选，绝不把 ERB 候选
 *   塞进 2.0 的文件）；
 * - **事实袋只喂点名它的语言**（`descriptor.completionFacts`）：ERB 取、kojo2 不取；
 * - **触发字符**：descriptor 追加的三枚（`[` / `$` / `.`）并进共享那份（并集、去重、保序）；
 * - **翻译**：契约新档（`field` / `enumMember`）→ Monaco 枚举、模板通道只在
 *   `insertTextFormat === 'snippet'` 时开、中文候选补拼音可检索键。
 *
 * 假 Monaco / 假内核只实现被真正用到的那几格（与 `kojo2-providers.test.ts` 同一套桩口径）。
 */
import { describe, expect, it } from 'vitest';
import type { EditorCompletionItem, EditorLanguageServiceContribution } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { provideErbCompletion } from '@kojo/plugin-erb-parser';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { declaredSlotKinds, usesLegacyBridge } from '../src/monaco/language-registry';
import { descriptorForLanguageId } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import {
  completionKindOf,
  installSlotServiceLegs,
  toMonacoCompletionItem,
} from '../src/monaco/slot-service-providers';

/* ============================== 桩 ============================== */

/** Monaco 0.57 的 `CompletionItemKind` 数值（只列会被问到的档） */
const KINDS = {
  Function: 1,
  Field: 3,
  Variable: 4,
  Enum: 15,
  EnumMember: 16,
  Keyword: 17,
  Text: 18,
  Snippet: 27,
} as const;

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Array<{ readonly selector: string; readonly provider: unknown }>;
}

function fakeMonaco(): FakeMonaco {
  const registrations: Array<{ selector: string; provider: unknown }> = [];
  const fake = {
    languages: {
      CompletionItemKind: { ...KINDS },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (selector: string, provider: unknown) => {
        registrations.push({ selector, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations };
}

const ERB_PATH = 'D:/proj/erb/场景.erb';
const KOJO2_PATH = 'D:/proj/口上/12/场景.kojo';

/** 桩 model：只有取文 / 取行 / 文件身份（本层不看词法，区间判定在供方） */
function modelOf(text: string, path: string, languageId: string): Monaco.editor.ITextModel {
  const rows = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (line: number) => rows[line - 1] ?? '',
    getLineCount: () => rows.length,
    getWordAtPosition: () => null,
    uri: { scheme: 'file', path, fsPath: path, toString: () => `file:///${path}` },
    getLanguageId: () => languageId,
    getVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

function installKernel(contributions: readonly EditorLanguageServiceContribution[]): void {
  setGlobalKernel({
    slots: { query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []) },
    project: { current: () => null },
  } as unknown as KernelLike);
}

/** ERB 插件在生产里注册的那一枚贡献（逐字同形状：`provide` 直连供方） */
const ERB_CONTRIBUTION: EditorLanguageServiceContribution = {
  id: 'erb-completion',
  order: 20,
  provide: (request) =>
    request.kind === 'completion' ? provideErbCompletion(request) : undefined,
} as EditorLanguageServiceContribution;

const FACTS = {
  directiveWords: ['IF', 'ENDIF', 'PRINTFORM'],
  functionNames: ['M_KOJO_A', 'M_KOJO_B'],
  dimNames: ['好感度'],
  labelNames: ['LOOP'],
  wordBasedSuggestions: false,
} as const;

/** 装一条补全腿（生产里这一步在 `installSlotServiceProviders` 里，桩只桩那一枚注册函数） */
function installCompletions(factsSeen: string[] = []): {
  readonly fake: FakeMonaco;
  readonly provider: Monaco.languages.CompletionItemProvider;
} {
  const fake = fakeMonaco();
  installSlotServiceLegs(fake.monaco, ['completion'], {
    filePathOf: (model) => (model as unknown as { uri: { fsPath: string } }).uri.fsPath,
    completionFacts: (model) => {
      factsSeen.push(String((model as unknown as { getLanguageId(): string }).getLanguageId()));
      return FACTS as never;
    },
  });
  const erb = fake.registrations.find((entry) => entry.selector === ERB_LANGUAGE_ID);
  if (erb === undefined) throw new Error('共享槽腿没有把补全挂到 ERB 上');
  return { fake, provider: erb.provider as Monaco.languages.CompletionItemProvider };
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const CONTEXT = { triggerKind: 0 } as unknown as Monaco.languages.CompletionContext;

function suggestionsAt(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  column: number,
  column1 = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, ERB_PATH, ERB_LANGUAGE_ID),
    { lineNumber: 1, column } as Monaco.Position,
    CONTEXT,
    TOKEN,
  ) as unknown as Monaco.languages.CompletionList;
  expect(column1).toBe(1);
  return out.suggestions;
}

function labelOf(item: Monaco.languages.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

/* ============================== descriptor 声明面 ============================== */

describe('LAU-4 补全腿第三批 · descriptor 声明', () => {
  const erb = descriptorForLanguageId(ERB_LANGUAGE_ID)!;

  it('ERB 声明要事实袋（判据在包、事实留宿主）', () => {
    expect(erb.completionFacts).toBe(true);
  });

  it('ERB 追加三枚触发字符（其余靠共享那份；`#` / `@` 不在追加清单里）', () => {
    expect(erb.completionTriggerCharacters).toEqual(['[', '$', '.']);
  });

  it('补全腿不靠点名：ERB 走旧桥全腿（点名表里只有引用腿）', () => {
    expect(usesLegacyBridge(erb)).toBe(true);
    expect(declaredSlotKinds(erb)).toEqual(['references']);
  });
});

/* ============================== 共享槽腿：ERB 供方在场 ============================== */

describe('LAU-4 补全腿第三批 · 共享槽腿（ERB 供方在场）', () => {
  it('补全 provider 挂在每一门 `languageServices` 语言上（ERB 在列）', () => {
    const { fake } = installCompletions();
    const selectors = fake.registrations.map((entry) => entry.selector);
    expect(selectors).toContain(ERB_LANGUAGE_ID);
    expect(selectors).toContain(KOJO2_LANGUAGE_ID);
  });

  it('触发字符 = 共享那份 ∪ descriptor 追加（含 `#` `@` 与 ERB 的三枚）', () => {
    const { provider } = installCompletions();
    const chars = provider.triggerCharacters ?? [];
    for (const ch of ['#', '@', '[', '$', '.']) expect(chars).toContain(ch);
    expect(new Set(chars).size).toBe(chars.length);
  });

  it('`CALL M_` ⇒ 两条项目函数（钉值：候选数 + 关键项 + 图标 + 区间）', () => {
    installKernel([ERB_CONTRIBUTION]);
    const { provider } = installCompletions();
    const suggestions = suggestionsAt(provider, 'CALL M_', 8);
    expect(suggestions.map(labelOf)).toEqual(['M_KOJO_A', 'M_KOJO_B']);
    expect(suggestions[0]!.kind).toBe(KINDS.Function);
    expect(suggestions[0]!.range).toEqual({ startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8 });
  });

  it('`CFLAG:`（无变量表的事实）⇒ 零候选；`#D` ⇒ 预处理指令族在场', () => {
    installKernel([ERB_CONTRIBUTION]);
    const { provider } = installCompletions();
    expect(suggestionsAt(provider, 'CFLAG:', 7)).toEqual([]);
    expect(suggestionsAt(provider, '#D', 3).map(labelOf)).toContain('#DIM');
  });

  it('注释 / 字符串内 ⇒ 整轮零候选（上下文抑制经槽仍然成立）', () => {
    installKernel([ERB_CONTRIBUTION]);
    const { provider } = installCompletions();
    expect(suggestionsAt(provider, '; CALL M_', 10)).toEqual([]);
    expect(suggestionsAt(provider, 'A = "CALL M_', 13)).toEqual([]);
  });

  it('非 ERB 文件 ⇒ ERB 贡献弃权（`.kojo2` 模型上零候选，不越界作答）', () => {
    installKernel([ERB_CONTRIBUTION]);
    const { fake } = installCompletions();
    const provider = fake.registrations.find((entry) => entry.selector === KOJO2_LANGUAGE_ID)!
      .provider as Monaco.languages.CompletionItemProvider;
    const out = provider.provideCompletionItems(
      modelOf('CALL M_', KOJO2_PATH, KOJO2_LANGUAGE_ID),
      { lineNumber: 1, column: 8 } as Monaco.Position,
      CONTEXT,
      TOKEN,
    ) as unknown as Monaco.languages.CompletionList;
    expect(out.suggestions).toEqual([]);
  });
});

/* ============================== 事实袋只喂点名它的语言 ============================== */

describe('LAU-4 补全腿第三批 · 事实袋的现取范围', () => {
  it('ERB 模型 ⇒ 现取一次；`.kojo2` 模型（未点名 `completionFacts`）⇒ 一次都不取', () => {
    installKernel([ERB_CONTRIBUTION]);
    const seen: string[] = [];
    const { fake } = installCompletions(seen);

    const erb = fake.registrations.find((entry) => entry.selector === ERB_LANGUAGE_ID)!
      .provider as Monaco.languages.CompletionItemProvider;
    erb.provideCompletionItems(
      modelOf('CALL M_', ERB_PATH, ERB_LANGUAGE_ID),
      { lineNumber: 1, column: 8 } as Monaco.Position,
      CONTEXT,
      TOKEN,
    );
    expect(seen).toEqual([ERB_LANGUAGE_ID]);

    const kojo2 = fake.registrations.find((entry) => entry.selector === KOJO2_LANGUAGE_ID)!
      .provider as Monaco.languages.CompletionItemProvider;
    kojo2.provideCompletionItems(
      modelOf('CALL M_', KOJO2_PATH, KOJO2_LANGUAGE_ID),
      { lineNumber: 1, column: 8 } as Monaco.Position,
      CONTEXT,
      TOKEN,
    );
    expect(seen).toEqual([ERB_LANGUAGE_ID]);
  });
});

/* ============================== 契约项 → Monaco 条目 ============================== */

describe('LAU-4 补全腿第三批 · 翻译层（契约项 → Monaco 条目）', () => {
  const monaco = fakeMonaco().monaco;
  const fallback = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };

  const item = (patch: Partial<EditorCompletionItem>): EditorCompletionItem =>
    ({ label: '好感度', range: { line: 1, startColumn: 1, endColumn: 4 }, ...patch }) as EditorCompletionItem;

  it('新增两档：`field` → Field、`enumMember` → EnumMember（缺枚举才降级）', () => {
    expect(completionKindOf(monaco, 'field')).toBe(KINDS.Field);
    expect(completionKindOf(monaco, 'enumMember')).toBe(KINDS.EnumMember);
    expect(completionKindOf(monaco, 'variable')).toBe(KINDS.Variable);
  });

  it('模板通道只随 insertTextFormat=snippet 开（`kind: snippet` 只挑图标）', () => {
    const iconOnly = toMonacoCompletionItem(monaco, item({ kind: 'snippet' }), fallback)!;
    expect(iconOnly.kind).toBe(KINDS.Snippet);
    expect(iconOnly.insertTextRules).toBeUndefined();

    const template = toMonacoCompletionItem(
      monaco,
      item({ kind: 'snippet', insertText: 'IF ${1:条件}$0', insertTextFormat: 'snippet' }),
      fallback,
    )!;
    expect(template.insertTextRules).toBe(4);
  });

  it('中文候选补拼音可检索键（原文仍居首位；ASCII 候选不动；缺省不补 = 原样透传）', () => {
    const cn = toMonacoCompletionItem(monaco, item({}), fallback, { pinyinFilter: true })!;
    expect(cn.filterText).toBe('好感度 haogandu hgd');
    const ascii = toMonacoCompletionItem(monaco, item({ label: 'GETBIT' }), fallback, { pinyinFilter: true })!;
    expect(ascii.filterText).toBeUndefined();
    // 不点名这一格的语言：`filterText` 原样透传（kojo2 的 pinned 断言口径）
    const passthrough = toMonacoCompletionItem(monaco, item({ filterText: 'hao' }), fallback)!;
    expect(passthrough.filterText).toBe('hao');
  });

  it('供方给的区间优先；非法区间落回宿主缺省（不让整轮补全炸掉）', () => {
    const given = toMonacoCompletionItem(
      monaco,
      item({ range: { line: 2, startColumn: 3, endColumn: 7 } }),
      fallback,
    )!;
    expect(given.range).toEqual({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 7 });
    const bad = toMonacoCompletionItem(
      monaco,
      item({ range: { line: Number.NaN, startColumn: 1, endColumn: 1 } }),
      fallback,
    )!;
    expect(bad.range).toEqual(fallback);
  });
});