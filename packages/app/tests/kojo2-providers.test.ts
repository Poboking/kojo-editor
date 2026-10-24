/**
 * K2-EDITOR-PROVIDERS · `kojo2` 三枚 Monaco provider 的闸（K2 batch-4）。
 *
 * 覆盖五件事：
 * 1. **注册纪律**：flag 关 ⇒ 零注册；flag 开 ⇒ 恰好三枚、语言 selector 只有 `kojo2`；
 *    dispose 幂等、逐枚隔离；半途注册抛错 ⇒ 已挂上的撤回 + 错误外抛；
 * 2. **CompletionItemKind 映射**：五类候选 → Monaco 档位、声明按种类细分、未知种类回 `Text`；
 * 3. **补全字段**：`range`（名字段替换区间）/ `insertText` / `sortText` / `filterText` /
 *    `documentation`（悬停正文，不另写措辞）；
 * 4. **悬停 / 转定义**：Markdown + range、`LocationLink` 的 `targetUri` / `targetRange` /
 *    `targetSelectionRange` / `originSelectionRange`；文件身份注入与 `model.uri` 兜底；
 * 5. **失败面**：无 adapter / adapter getter 抛错 / 取文抛错 ⇒ 空结果、不抛；
 *    外加**源码断言**：宿主注册点存在且受 flag 守卫，语言层不 import 任何插件包。
 *
 * 假 Monaco 只实现被真正用到的那几格（三枚注册函数 + `CompletionItemKind` + `Uri.file`），
 * 其余一律由真纯模型给出——本闸测的是"翻译层"，不是再测一遍语法。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventNames, FIXTURE_ADAPTER } from '@kojo/kojo-core';
import { ERATW_GAME_ADAPTER, ERATW_HEART_HINT, ERATW_PRESENTATION } from '@kojo/plugin-eratw-adapter';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { KOJO2_ANCHOR_CHARS } from '../src/monaco/kojo2-completion';
import { kojo2CompletionSnippets } from '../src/monaco/kojo2-completion-snippets';
import type { Kojo2CompletionCandidate } from '../src/monaco/kojo2-completion';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DocumentOf,
  type Kojo2Declaration,
  type Kojo2DeclarationKind,
} from '../src/monaco/kojo2-declarations';
import {
  KOJO2_COMPLETION_TRIGGER_CHARS,
  installKojo2LanguageProviders,
  kojo2CompletionItems,
  kojo2CompletionKindOf,
  kojo2DefinitionLinksOf,
  kojo2HoverMarkdown,
  kojo2HoverOf,
} from '../src/monaco/kojo2-providers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

const COMPLETION_FIXTURE = readFileSync(
  join(HERE, 'fixtures', 'kojo2', 'completion.kojo2'),
  'utf8',
);
const HOVER_FIXTURE = readFileSync(
  join(HERE, 'fixtures', 'kojo2', 'hover-definition.kojo2'),
  'utf8',
);
/** 末尾补一个换行：下面"追加一行"的查询都从新行开始。 */
const COMPLETION_BASE = COMPLETION_FIXTURE.endsWith('\n')
  ? COMPLETION_FIXTURE
  : `${COMPLETION_FIXTURE}\n`;

const HOVER_DOCUMENT = kojo2DocumentOf(HOVER_FIXTURE);

/* ============================== 假 Monaco / 假 model ============================== */

/**
 * Monaco `CompletionItemKind` 的真实数值（0.57 枚举顺序；宿主只用这几格，测试按同一张表比）。
 * 单独列在这里而不是从 `monaco/entry` 取：node 池里 Monaco 运行时不进模块图。
 */
const KINDS = {
  Method: 0,
  Function: 1,
  Constructor: 2,
  Field: 3,
  Variable: 4,
  Class: 5,
  Struct: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Event: 10,
  Operator: 11,
  Unit: 12,
  Value: 13,
  Constant: 14,
  Enum: 15,
  EnumMember: 16,
  Keyword: 17,
  Text: 18,
  Color: 19,
  File: 20,
  Reference: 21,
  Customcolor: 22,
  Folder: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
  Snippet: 27,
} as const;

type ProviderKind = 'completion' | 'hover' | 'definition';

/** Monaco provider 的第三/四参（本层的 provider 不用它们，但签名要求传） */
const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const COMPLETION_CONTEXT = {
  triggerKind: 0,
} as unknown as Monaco.languages.CompletionContext;

interface Registration {
  readonly kind: ProviderKind;
  readonly selector: unknown;
  readonly provider: unknown;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  /** 每一次 `registration.dispose()` 都记在这里（幂等 / 隔离的判据） */
  readonly disposeCalls: ProviderKind[];
}

interface FakeMonacoOptions {
  /** 让某枚注册抛错（模拟"半途失败"，验回滚 + 外抛） */
  readonly failOn?: ProviderKind;
  /** 让某一枚注册的 dispose 抛错（验逐枚隔离） */
  readonly failDisposeOn?: ProviderKind;
}

function fakeMonaco(options: FakeMonacoOptions = {}): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: ProviderKind[] = [];
  const register = (kind: ProviderKind) => (selector: unknown, provider: unknown) => {
    if (options.failOn === kind) throw new Error(`桩：注册 ${kind} 抛错`);
    const record: Registration = { kind, selector, provider };
    registrations.push(record);
    return {
      dispose: () => {
        if (options.failDisposeOn === kind) throw new Error(`桩：撤 ${kind} 抛错`);
        disposeCalls.push(kind);
      },
    };
  };
  const fake = {
    languages: {
      CompletionItemKind: KINDS,
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: register('completion'),
      registerHoverProvider: register('hover'),
      registerDefinitionProvider: register('definition'),
    },
    Uri: {
      file: (path: string) => ({
        scheme: 'file',
        path,
        fsPath: path,
        toString: () => `file:///${path.replace(/\\/g, '/')}`,
      }),
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, disposeCalls };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  /** 只给"取文抛错"用例用：让 `getValue()` 抛 */
  readonly failGetValue: () => void;
}

function fakeModel(text: string): FakeModel {
  let broken = false;
  const rows = text.split(/\r\n|\r|\n/);
  const uri = {
    scheme: 'file',
    path: 'D:/proj/chara/灵梦/开场.kojo2',
    fsPath: 'D:/proj/chara/灵梦/开场.kojo2',
    toString: () => 'file:///D:/proj/chara/灵梦/开场.kojo2',
  };
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineContent: (line: number) => rows[line - 1] ?? '',
    getLineCount: () => rows.length,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    isDisposed: () => broken,
    uri,
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    failGetValue: () => {
      broken = true;
    },
  };
}

/** `|` 当光标标记：摘掉标记、换成 1 基行列 + 那份文本建出来的 model。 */
function atMarker(textWithMarker: string, marker = '|'): {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly model: Monaco.editor.ITextModel;
  readonly position: Monaco.Position;
} {
  const at = textWithMarker.indexOf(marker);
  if (at < 0) throw new Error(`夹具里没有光标标记 ${marker}`);
  const source = textWithMarker.slice(0, at) + textWithMarker.slice(at + marker.length);
  const before = source.slice(0, at);
  const lastBreak = before.lastIndexOf('\n');
  const line = before.split('\n').length;
  const column = at - lastBreak;
  const { model } = fakeModel(source);
  return { source, line, column, model, position: { lineNumber: line, column } as Monaco.Position };
}

/** 1 基行列（同一份源码）→ model + position。 */
function atPoint(source: string, line: number, column: number) {
  return {
    model: fakeModel(source).model,
    position: { lineNumber: line, column } as Monaco.Position,
  };
}

/* ============================== 夹具小工具 ============================== */

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function registrationOf(fake: FakeMonaco, kind: ProviderKind): Registration {
  const found = fake.registrations.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`没有注册 ${kind}`);
  return found;
}

function installForTest(options: Parameters<typeof installKojo2LanguageProviders>[1] = {}): FakeMonaco {
  stubFlag(true);
  const fake = fakeMonaco();
  installKojo2LanguageProviders(fake.monaco, options);
  return fake;
}

function completionProviderOf(fake: FakeMonaco): Monaco.languages.CompletionItemProvider {
  return registrationOf(fake, 'completion').provider as Monaco.languages.CompletionItemProvider;
}

function hoverProviderOf(fake: FakeMonaco): Monaco.languages.HoverProvider {
  return registrationOf(fake, 'hover').provider as Monaco.languages.HoverProvider;
}

function definitionProviderOf(fake: FakeMonaco): Monaco.languages.DefinitionProvider {
  return registrationOf(fake, 'definition').provider as Monaco.languages.DefinitionProvider;
}

function suggestionsAt(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  return (
    completionProviderOf(fake).provideCompletionItems(
      model,
      position,
      COMPLETION_CONTEXT,
      TOKEN,
    ) as Monaco.languages.CompletionList
  ).suggestions;
}

function hoverAt(fake: FakeMonaco, model: Monaco.editor.ITextModel, position: Monaco.Position) {
  return hoverProviderOf(fake).provideHover(
    model,
    position,
    TOKEN,
  ) as Monaco.languages.Hover | undefined;
}

function definitionAt(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.LocationLink[] {
  return definitionProviderOf(fake).provideDefinition(
    model,
    position,
    TOKEN,
  ) as Monaco.languages.LocationLink[];
}

/** 夹具里某一种声明的唯一一条（缺了就当场红，与 `kojo2-hover-definition.test.ts` 同手法）。 */
function declarationOf(kind: Kojo2DeclarationKind): Kojo2Declaration {
  const found = HOVER_DOCUMENT.declarations.find((declaration) => declaration.kind === kind);
  if (found === undefined) throw new Error(`夹具缺少 ${kind} 声明`);
  return found;
}

function pointAtDeclaration(declaration: Kojo2Declaration, source = HOVER_FIXTURE) {
  return atPoint(source, declaration.line, declaration.nameStart);
}

function lineTextOfFixture(source: string, line: number): string {
  return source.split(/\r\n|\r|\n/)[line - 1] ?? '';
}

/** `documentation` 是 string | IMarkdownString（本层固定给后者）；统一取成字符串比。 */
function documentationText(item: Monaco.languages.CompletionItem): string {
  const doc = item.documentation;
  if (doc === undefined || doc === null) return '';
  return typeof doc === 'string' ? doc : doc.value;
}

/** 造一枚候选（只为单测 `kojo2CompletionKindOf` 的边界值）。 */
function candidate(overrides: Partial<Kojo2CompletionCandidate>): Kojo2CompletionCandidate {
  return {
    label: '示例',
    insertText: '示例',
    kind: 'anchor',
    detail: '示例',
    sortText: '0_示例',
    ...overrides,
  } as Kojo2CompletionCandidate;
}

/* ============================== ① 开关与注册 ============================== */

describe('开关与注册：flag 关零注册，flag 开只挂 kojo2 三枚', () => {
  it('flag 关 ⇒ 三枚注册函数一次都没被调用（零注册）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2LanguageProviders(fake.monaco, {
      adapter: ERATW_GAME_ADAPTER,
    });
    expect(fake.registrations).toEqual([]);
    expect(fake.disposeCalls).toEqual([]);
    handle.dispose();
    expect(fake.disposeCalls).toEqual([]);
  });

  it('flag 关的句柄是可重复 dispose 的空操作（不抛）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2LanguageProviders(fake.monaco);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });

  it('flag 开 ⇒ 恰好三枚（补全 / 悬停 / 转定义），selector 逐枚等于 kojo2', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    expect(fake.registrations.map((entry) => entry.kind)).toEqual([
      'completion',
      'hover',
      'definition',
    ]);
    for (const entry of fake.registrations) expect(entry.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(completionProviderOf(fake).triggerCharacters).toEqual([
      ...KOJO2_COMPLETION_TRIGGER_CHARS,
    ]);
  });

  it('dispose 幂等：两次只撤一轮，三枚各撤一次', () => {
    const fake = installForTest();
    const handle = installKojo2LanguageProviders(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toEqual(['completion', 'hover', 'definition']);
  });

  it('一枚 dispose 抛错不带走其余，也不把错误抛给调用方', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failDisposeOn: 'hover' });
    const handle = installKojo2LanguageProviders(fake.monaco);
    expect(() => handle.dispose()).not.toThrow();
    expect(fake.disposeCalls).toEqual(['completion', 'definition']);
  });

  it('注册半途抛错 ⇒ 撤回已挂上的那几枚，再把错误外抛（全有或全无）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failOn: 'hover' });
    expect(() => installKojo2LanguageProviders(fake.monaco)).toThrow(/注册 hover/);
    // 补全先挂上、随即被撤回；悬停与转定义根本没挂上
    expect(fake.disposeCalls).toEqual(['completion']);
    expect(fake.registrations.map((entry) => entry.kind)).toEqual(['completion']);
  });
});

/* ============================== ② CompletionItemKind 映射 ============================== */

describe('CompletionItemKind 映射：按候选类别分档，声明按种类细分', () => {
  it('锚点 ⇒ Operator（五枚都走这一档）', () => {
    const fake = installForTest();
    const at = atMarker(`${COMPLETION_BASE}|`);
    const suggestions = suggestionsAt(fake, at.model, at.position);
    // 行首同时给块骨架（K2-COMPLETE-SNIPPET，翻译层追加）：锚点仍是前五枚
    expect(suggestions.slice(0, KOJO2_ANCHOR_CHARS.length).map((item) => item.label)).toEqual([
      ...KOJO2_ANCHOR_CHARS,
    ]);
    for (const item of suggestions.slice(0, KOJO2_ANCHOR_CHARS.length)) expect(item.kind).toBe(KINDS.Operator);
    for (const item of suggestions.slice(KOJO2_ANCHOR_CHARS.length)) expect(item.kind).toBe(KINDS.Snippet);
  });

  it('声明词 ⇒ Keyword', () => {
    const fake = installForTest();
    const at = atMarker(`${COMPLETION_BASE}# |`);
    const suggestions = suggestionsAt(fake, at.model, at.position);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const item of suggestions) expect(item.kind).toBe(KINDS.Keyword);
  });

  it('事件目录 ⇒ Event（名单来自 adapter 的 core `eventNames`，零手抄）', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    const at = atMarker(`${COMPLETION_BASE}# 机 |`);
    const suggestions = suggestionsAt(fake, at.model, at.position);
    expect(suggestions.map((item) => item.label)).toEqual([...eventNames(ERATW_GAME_ADAPTER)]);
    for (const item of suggestions) expect(item.kind).toBe(KINDS.Event);
  });

  it('事件目录也接受 getter 形态（宿主请求时现取）', () => {
    const getter = vi.fn(() => ERATW_GAME_ADAPTER);
    const fake = installForTest({ adapter: getter });
    const at = atMarker(`${COMPLETION_BASE}# 机 |`);
    expect(suggestionsAt(fake, at.model, at.position).length).toBe(
      eventNames(ERATW_GAME_ADAPTER).length,
    );
    expect(getter).toHaveBeenCalled();
  });

  it('域符号 ⇒ Variable（`{…}` 插值内，排在候选最前）', () => {
    const fake = installForTest();
    const at = atMarker(COMPLETION_FIXTURE.replace('{我}', '{|我}'));
    const suggestions = suggestionsAt(fake, at.model, at.position);
    const symbols = suggestions.filter((item) => item.kind === KINDS.Variable);
    expect(symbols.length).toBeGreaterThan(0);
    expect(suggestions.slice(0, symbols.length).map((item) => item.kind)).toEqual(
      symbols.map(() => KINDS.Variable),
    );
  });

  it('声明 ⇒ 按种类细分（变量 / 表 / 池 / 模 / 函）', () => {
    const fake = installForTest();
    // `!` 调用位：池 / 模 / 函；`?` 条件位：再补上表
    const trigger = atMarker(`${COMPLETION_BASE}! |`);
    const triggerKinds = new Map(
      suggestionsAt(fake, trigger.model, trigger.position).map((item) => [item.label, item.kind]),
    );
    const condition = atMarker(`${COMPLETION_BASE}? |`);
    const conditionKinds = new Map(
      suggestionsAt(fake, condition.model, condition.position).map((item) => [item.label, item.kind]),
    );
    for (const declaration of kojo2DocumentOf(COMPLETION_FIXTURE).declarations) {
      const kind = conditionKinds.get(declaration.name) ?? triggerKinds.get(declaration.name);
      if (kind === undefined) continue;
      const expected =
        declaration.kind === 'table'
          ? KINDS.Struct
          : declaration.kind === 'pool'
            ? KINDS.Enum
            : declaration.kind === 'template'
              ? KINDS.Snippet
              : declaration.kind === 'function'
                ? KINDS.Function
                : KINDS.Text;
      expect(kind, declaration.name).toBe(expected);
    }
    expect(
      kojo2CompletionKindOf(
        fake.monaco,
        candidate({ kind: 'declaration', declarationKind: 'variable' }),
      ),
    ).toBe(KINDS.Variable);
    expect(
      kojo2CompletionKindOf(
        fake.monaco,
        candidate({ kind: 'declaration', declarationKind: 'constant' }),
      ),
    ).toBe(KINDS.Constant);
    expect(
      kojo2CompletionKindOf(
        fake.monaco,
        candidate({ kind: 'declaration', declarationKind: 'scene' }),
      ),
    ).toBe(KINDS.Module);
  });

  it('未知候选类别 / 没给声明种类 ⇒ 缺省 Text（不借邻居的档）', () => {
    const fake = installForTest();
    expect(
      kojo2CompletionKindOf(
        fake.monaco,
        candidate({ kind: '未知类别' as Kojo2CompletionCandidate['kind'] }),
      ),
    ).toBe(KINDS.Text);
    expect(kojo2CompletionKindOf(fake.monaco, candidate({ kind: 'declaration' }))).toBe(
      KINDS.Text,
    );
  });
});

/* ============================== ③ 补全字段 ============================== */

describe('补全字段：range / insertText / sortText / filterText / documentation', () => {
  it('行首空行：锚点的 range 是零宽（插在光标处）', () => {
    const fake = installForTest();
    const at = atMarker(`${COMPLETION_BASE}|`);
    for (const item of suggestionsAt(fake, at.model, at.position)) {
      expect(item.range).toEqual({
        startLineNumber: at.line,
        startColumn: at.column,
        endLineNumber: at.line,
        endColumn: at.column,
      });
    }
  });

  it('名字段内：range 覆盖整个名字（`# 机 指|` ⇒ 指 的起止列）', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    const at = atMarker(`${COMPLETION_BASE}# 机 指|`);
    const lineText = lineTextOfFixture(at.source, at.line);
    const start = lineText.lastIndexOf('指');
    expect(start).toBeGreaterThanOrEqual(0);
    const suggestions = suggestionsAt(fake, at.model, at.position);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const item of suggestions) {
      expect(item.range).toEqual({
        startLineNumber: at.line,
        startColumn: start + 1,
        endLineNumber: at.line,
        endColumn: start + 2,
      });
    }
  });

  it('insertText / filterText / sortText / detail 逐字来自纯模型', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    const at = atMarker(`${COMPLETION_BASE}# 机 |`);
    const item = suggestionsAt(fake, at.model, at.position)[0]!;
    expect(item.insertText).toBe(item.label);
    expect(item.filterText).toBe(item.label);
    expect(item.sortText).toBe(`2_${item.label}`);
    expect(item.detail).toBe('事件');
  });

  it('声明类候选的 documentation = 悬停正文（来源行 / 原文 / 种类声明）', () => {
    const fake = installForTest();
    const at = atMarker(`${COMPLETION_BASE}! |`);
    const declaration = kojo2DocumentOf(COMPLETION_FIXTURE).declarations.find(
      (entry) => entry.kind === 'pool',
    );
    expect(declaration).toBeDefined();
    const item = suggestionsAt(fake, at.model, at.position).find(
      (entry) => entry.label === declaration!.name,
    );
    expect(item).toBeDefined();
    const text = documentationText(item!);
    expect(text).toContain(`**${declaration!.name}**`);
    expect(text).toContain(`（${KOJO2_DECL_WORD_BY_KIND.pool}声明）`);
    expect(text).toContain(`来源行：第 ${declaration!.line} 行`);
    expect(text).toContain('原文：');
  });

  it('非声明候选没有 documentation（不编一段说明）', () => {
    const fake = installForTest();
    const at = atMarker(`${COMPLETION_BASE}|`);
    for (const item of suggestionsAt(fake, at.model, at.position)) {
      expect(item.documentation).toBeUndefined();
    }
  });

  it('`kojo2CompletionItems` 可单独调用（不注册也能算；无 adapter 只丢事件那一路）', () => {
    const fake = fakeMonaco();
    const at = atMarker(`${COMPLETION_BASE}# 机 |`);
    expect(kojo2CompletionItems(fake.monaco, at.model, at.position, undefined)).toEqual([]);
    const anchors = atMarker(`${COMPLETION_BASE}|`);
    expect(
      kojo2CompletionItems(fake.monaco, anchors.model, anchors.position, undefined).length,
    ).toBe(KOJO2_ANCHOR_CHARS.length + kojo2CompletionSnippets.length);
  });
});

/* ============================== ③b 补全数据接线（K2-COMPLETE-DATA） ============================== */

describe('补全数据接线：adapter 契约字段现取，显式注入优先，旧 adapter 零候选', () => {
  it('`@颜绘 我 ` 的表情格 = adapter `presentation.faceTemplates.expressions`（逐项相等）', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    const at = atMarker(`${COMPLETION_BASE}@颜绘 我 |`);
    const expected = [...(ERATW_PRESENTATION.faceTemplates?.expressions ?? [])];
    expect(expected.length).toBeGreaterThan(0);
    expect(suggestionsAt(fake, at.model, at.position).map((item) => item.label)).toEqual(expected);
  });

  it('行尾 `(心` 的提示名 = adapter `presentation.hintNames`（与 hintSupport 同一枚）', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    const at = atMarker(`${COMPLETION_BASE}灵梦：「早安」(心|`);
    const expected = [...(ERATW_PRESENTATION.hintNames ?? [])];
    expect(expected).toEqual([ERATW_HEART_HINT]);
    expect(suggestionsAt(fake, at.model, at.position).map((item) => item.label)).toEqual(expected);
  });

  it('显式 `completion` 注入优先于 adapter 字段（宿主可换投影）', () => {
    const fake = installForTest({
      adapter: ERATW_GAME_ADAPTER,
      completion: { faceTemplates: { expressions: ['合成表情'] }, hintNames: ['合成提示'] },
    });
    const face = atMarker(`${COMPLETION_BASE}@颜绘 我 |`);
    expect(suggestionsAt(fake, face.model, face.position).map((item) => item.label)).toEqual([
      '合成表情',
    ]);
    const hint = atMarker(`${COMPLETION_BASE}灵梦：「早安」(合|`);
    expect(suggestionsAt(fake, hint.model, hint.position).map((item) => item.label)).toEqual([
      '合成提示',
    ]);
  });

  it('旧 adapter（契约字段缺省）⇒ 表情格 / 提示名格零候选，不猜', () => {
    expect(FIXTURE_ADAPTER.presentation.faceTemplates).toBeUndefined();
    expect(FIXTURE_ADAPTER.presentation.hintNames).toBeUndefined();
    const fake = installForTest({ adapter: FIXTURE_ADAPTER });
    const face = atMarker(`${COMPLETION_BASE}@颜绘 我 |`);
    expect(suggestionsAt(fake, face.model, face.position)).toEqual([]);
    const hint = atMarker(`${COMPLETION_BASE}灵梦：「早安」(心|`);
    expect(suggestionsAt(fake, hint.model, hint.position)).toEqual([]);
  });

  it('没有 adapter 也没有显式注入 ⇒ 两格零候选（不借内置词兜底）', () => {
    const fake = installForTest();
    const face = atMarker(`${COMPLETION_BASE}@颜绘 我 |`);
    expect(suggestionsAt(fake, face.model, face.position)).toEqual([]);
    const hint = atMarker(`${COMPLETION_BASE}灵梦：「早安」(心|`);
    expect(suggestionsAt(fake, hint.model, hint.position)).toEqual([]);
  });
});

/* ============================== ④ 悬停 ============================== */

describe('悬停：Markdown 正文 + 屏上 range', () => {
  it('声明名字段上：正文带种类声明 / 来源行，range = 名字段', () => {
    const fake = installForTest();
    const declaration = declarationOf('variable');
    const at = pointAtDeclaration(declaration);
    const hover = hoverAt(fake, at.model, at.position);
    expect(hover).toBeDefined();
    const value = (hover!.contents[0] as { value: string }).value;
    expect(value).toContain(`**${declaration.name}**（${KOJO2_DECL_WORD_BY_KIND.variable}声明）`);
    expect(value).toContain(`来源行：第 ${declaration.line} 行`);
    expect(hover!.range).toEqual({
      startLineNumber: declaration.line,
      startColumn: declaration.nameStart,
      endLineNumber: declaration.line,
      endColumn: declaration.nameEnd,
    });
  });

  it('引用处（`{…}` 插值）：range 落在引用词本身，正文指向声明行', () => {
    const fake = installForTest();
    const declaration = declarationOf('table');
    const source = HOVER_FIXTURE;
    const at = atMarker(source.replace(`{${declaration.name}}`, `{${declaration.name}|}`));
    const hover = hoverAt(fake, at.model, at.position);
    expect(hover).toBeDefined();
    const lineText = lineTextOfFixture(at.source, at.line);
    const refStart = lineText.indexOf(declaration.name);
    expect(hover!.range).toEqual({
      startLineNumber: at.line,
      startColumn: refStart + 1,
      endLineNumber: at.line,
      endColumn: refStart + 1 + declaration.name.length,
    });
    expect((hover!.contents[0] as { value: string }).value).toContain(
      `来源行：第 ${declaration.line} 行`,
    );
  });

  it('台词正文不悬停（同一个名字出现在正文里也不认）', () => {
    const fake = installForTest();
    const narration = HOVER_FIXTURE.split(/\r\n|\r|\n/).findIndex((line) => line.startsWith('> 晨光'));
    expect(narration).toBeGreaterThanOrEqual(0);
    const at = atPoint(HOVER_FIXTURE, narration + 1, 4);
    expect(hoverAt(fake, at.model, at.position)).toBeUndefined();
  });

  it('取文抛错 ⇒ undefined（不抛进 Monaco）', () => {
    const fake = installForTest();
    const broken = fakeModel(HOVER_FIXTURE);
    broken.failGetValue();
    const declaration = declarationOf('variable');
    expect(
      hoverAt(fake, broken.model, {
        lineNumber: declaration.line,
        column: declaration.nameStart,
      } as Monaco.Position),
    ).toBeUndefined();
  });

  it('`kojo2HoverMarkdown` 是悬停与补全文档的同一条渲染口径', () => {
    const text = kojo2HoverMarkdown({
      name: '示例名',
      kind: '变量声明',
      startColumn: 1,
      endColumn: 4,
      lines: ['来源行：第 7 行', '原文：`# 变量 示例名`'],
      declaration: { line: 7, column: 5, endColumn: 8 },
    });
    expect(text).toBe('**示例名**（变量声明）\n\n来源行：第 7 行\n\n原文：`# 变量 示例名`');
  });
});

/* ============================== ⑤ 转定义 ============================== */

describe('转定义：LocationLink 形状与 URI 来源', () => {
  it('引用 → 声明：uri 来自注入的文件身份，range / targetSelectionRange = 名字段', () => {
    const path = 'D:/proj/chara/灵梦/开场.kojo2';
    const fake = installForTest({ getFilePath: () => path });
    const declaration = declarationOf('pool');
    const at = atMarker(HOVER_FIXTURE.replace(`! ${declaration.name}`, `! ${declaration.name}|`));
    const links = definitionAt(fake, at.model, at.position);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.uri.fsPath).toBe(path);
    expect(link.range).toEqual({
      startLineNumber: declaration.line,
      startColumn: declaration.nameStart,
      endLineNumber: declaration.line,
      endColumn: declaration.nameEnd,
    });
    expect(link.targetSelectionRange).toEqual(link.range);
    const lineText = lineTextOfFixture(at.source, at.line);
    const start = lineText.indexOf(declaration.name);
    expect(link.originSelectionRange).toEqual({
      startLineNumber: at.line,
      startColumn: start + 1,
      endLineNumber: at.line,
      endColumn: start + 1 + declaration.name.length,
    });
  });

  it('没有注入文件身份 ⇒ uri 沿用 model.uri', () => {
    const fake = installForTest();
    const declaration = declarationOf('function');
    const at = pointAtDeclaration(declaration);
    const links = definitionAt(fake, at.model, at.position);
    expect(links).toHaveLength(1);
    expect(links[0]!.uri).toBe(at.model.uri);
  });

  it('注入腿抛错 ⇒ 退回 model.uri（不抛）', () => {
    const fake = installForTest({
      getFilePath: () => {
        throw new Error('桩：取路径失败');
      },
    });
    const declaration = declarationOf('table');
    const at = pointAtDeclaration(declaration);
    const links = definitionAt(fake, at.model, at.position);
    expect(links).toHaveLength(1);
    expect(links[0]!.uri).toBe(at.model.uri);
  });

  it('声明处 F12 落在自己（落点 = 同一条声明的名字段）', () => {
    const fake = installForTest();
    for (const kind of ['scene', 'variable', 'constant', 'table', 'pool', 'template', 'function'] as const) {
      const declaration = declarationOf(kind);
      const at = pointAtDeclaration(declaration);
      const links = definitionAt(fake, at.model, at.position);
      expect(links, kind).toHaveLength(1);
      expect(links[0]!.range.startLineNumber).toBe(declaration.line);
      expect(links[0]!.range.startColumn).toBe(declaration.nameStart);
      expect(links[0]!.range.endColumn).toBe(declaration.nameEnd);
    }
  });

  it('没有同名声明 ⇒ 空数组（Monaco 自己提示"未找到定义"）', () => {
    const fake = installForTest();
    const narration = HOVER_FIXTURE.split(/\r\n|\r|\n/).findIndex((line) =>
      line.startsWith('> 晨光'),
    );
    const at = atPoint(HOVER_FIXTURE, narration + 1, 4);
    expect(definitionAt(fake, at.model, at.position)).toEqual([]);
  });

  it('取文抛错 ⇒ 空数组（不抛进 Monaco）', () => {
    const fake = installForTest();
    const broken = fakeModel(HOVER_FIXTURE);
    broken.failGetValue();
    expect(
      definitionAt(fake, broken.model, { lineNumber: 1, column: 1 } as Monaco.Position),
    ).toEqual([]);
  });
});

/* ============================== ⑥ 失败面与无 adapter ============================== */

describe('失败面：无 adapter / getter 抛错 / 取文抛错 ⇒ 空结果', () => {
  it('没有 adapter ⇒ `# 机` 零候选（不猜内置事件）', () => {
    const fake = installForTest();
    const at = atMarker(`${COMPLETION_BASE}# 机 |`);
    expect(suggestionsAt(fake, at.model, at.position)).toEqual([]);
  });

  it('没有 adapter 不影响同文件语义（锚点 / 声明名单照常）', () => {
    const fake = installForTest();
    const anchors = atMarker(`${COMPLETION_BASE}|`);
    expect(suggestionsAt(fake, anchors.model, anchors.position).length).toBe(
      KOJO2_ANCHOR_CHARS.length + kojo2CompletionSnippets.length,
    );
    const at = atMarker(`${COMPLETION_BASE}! |`);
    expect(suggestionsAt(fake, at.model, at.position).length).toBeGreaterThan(0);
  });

  it('adapter getter 抛错 ⇒ 只有事件那一路空，本轮不抛', () => {
    const fake = installForTest({
      adapter: () => {
        throw new Error('桩：adapter 取失败');
      },
    });
    const event = atMarker(`${COMPLETION_BASE}# 机 |`);
    expect(suggestionsAt(fake, event.model, event.position)).toEqual([]);
    const anchors = atMarker(`${COMPLETION_BASE}|`);
    expect(suggestionsAt(fake, anchors.model, anchors.position).length).toBe(
      KOJO2_ANCHOR_CHARS.length + kojo2CompletionSnippets.length,
    );
  });

  it('补全取文抛错 ⇒ `{ suggestions: [] }`（Monaco 能读的唯一空形状）', () => {
    const fake = installForTest();
    const broken = fakeModel(`${COMPLETION_BASE}`);
    broken.failGetValue();
    const list = completionProviderOf(fake).provideCompletionItems(
      broken.model,
      { lineNumber: 1, column: 1 } as Monaco.Position,
      COMPLETION_CONTEXT,
      TOKEN,
    ) as Monaco.languages.CompletionList;
    expect(list).toEqual({ suggestions: [] });
  });

  it('越界行号不崩（越界行按空行处理，给锚点而不是抛错）', () => {
    const fake = installForTest({ adapter: ERATW_GAME_ADAPTER });
    const at = atPoint(COMPLETION_FIXTURE, 9_999, 1);
    const suggestions = suggestionsAt(fake, at.model, at.position);
    expect(suggestions.slice(0, KOJO2_ANCHOR_CHARS.length).map((item) => item.label)).toEqual([
      ...KOJO2_ANCHOR_CHARS,
    ]);
  });
});

/* ============================== ⑦ 宿主注册点（读源码） ============================== */

describe('宿主注册点与解耦面（读源码断言）', () => {
  const read = (...segments: string[]): string =>
    readFileSync(resolve(REPO_ROOT, ...segments), 'utf8');

  it('`editor-global-providers` 在 flag 守卫块里注册三枚 provider（与语义着色同一块）', () => {
    const source = read('packages', 'app', 'src', 'ui', 'editor-global-providers.ts');
    expect(source).toContain("from '../monaco/kojo2-providers'");
    // 同一个 `if (isKojo2CutoverEnabled()) { … }` 块里既有语义着色、也有三枚语言服务
    expect(source).toMatch(
      /if \(isKojo2CutoverEnabled\(\)\) \{[\s\S]{0,1500}?installKojo2SemanticTokensProvider\(monaco\)[\s\S]{0,800}?installKojo2LanguageProviders\(/,
    );
  });

  it('adapter 由组合根注入（`ui/editor-pane/use-monaco-instance.ts` 传 getter）', () => {
    const source = read('packages', 'app', 'src', 'ui', 'editor-pane', 'use-monaco-instance.ts');
    // 入口 A：getter 不再写死 eraTW——改问组合根登记表按**当前项目**现取（eraFL 在
    // 入口 B 之前 ⇒ null ⇒ 六条腿零候选，而不是拿 eraTW 的事实顶）。判据不变：
    // 本文件仍只传 getter、仍不认任何游戏名词。
    expect(source).toContain('kojo2Adapter: () => kojo2AdapterForProject(kernel.project.current())');
    expect(source).toMatch(/ensureGlobalProviders\(\{ kojo2Adapter:/);
  });

  it('语言层（`monaco/kojo2-providers.ts`）不 import 任何插件包、不出现游戏名词', () => {
    const source = read('packages', 'app', 'src', 'monaco', 'kojo2-providers.ts');
    expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-/);
    expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
    // Monaco 运行时只许 **type-only** 引入（node 池里不能把 monaco 拉进模块图）
    expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
    expect(source).not.toMatch(/import \* as Monaco from/);
  });
});




