/**
 * K2-EDITOR-PROVIDERS · **B3c 之后的两枚 `kojo2` provider = 槽翻译层**的闸。
 *
 * ## 这一格在 B3c 改了什么（读断言前先看这三句）
 *
 * 补全与悬停的**判据**已整块搬进 `@kojo/kojo-lang`，作答的是插件
 * `@kojo/plugin-kojo-lang` 在 `ui.editor.languageService` 槽里的 `kojo2-completion` /
 * `kojo2-hover` 两枚贡献。宿主只剩三件事：
 * ① model → 请求（宿主事实：path / languageId / version / 全文 / 当前项目）；
 * ② 契约响应 → Monaco 协议（range / documentation / insertTextFormat / 悬停 contents）；
 * ③ 注册（`registerForLanguageServices(monaco, register, kind)` 共享收口）。
 *
 * **SDK-B5b 车 1（2026-10-31）**：这三件事从 kojo2 专属的 `monaco/kojo2-providers.ts` 搬进
 * **语言无关**的 `monaco/slot-service-providers.ts`——`kind` →（注册 API、请求构造、
 * 契约 → Monaco 形状）的一张表 + 一枚安装器，本车只开 `completion` / `hover` 两格。
 * 下面「注册顺序」那一组是搬家时新增的：表格序 = 实际注册序 = 装配点位置，三者任一变了都红。
 *
 * 因此本文件的判据分六层，**每一层都只钉这一层的事**（越界就是给搬家后的位置留下第二份答案）：
 * 1. **注册**：语言 selector 来自 descriptor（`languageServices` ∪ 点名 `completion` / `hover`
 *    的 `slotServices`），不是当年那个"注册调用第一个实参写死 `KOJO2_LANGUAGE_ID`"；
 * 1b. **注册顺序**：表格数组序 = 实际注册序（补全先、悬停后）＋ 装配点相对序不变；
 * 2. **图标**：契约十三档 → Monaco 枚举逐格对表（含 B3c 新增的 operator / event / constant /
 *    struct / enum / module 六档与 LAU-4 的 reference）；
 * 3. **插入语义**：`insertTextFormat === 'snippet'` 才开 `InsertAsSnippet`；`kind: 'snippet'`
 *    只挑图标；桩缺枚举时**丢弃带模板的那一档**（不把 undefined 写进 kind）；
 * 4. **协议翻译**：range → `IRange`、documentation 按 `documentationFormat` 分形态、
 *    filterText / sortText / detail / insertText 透传；悬停 `undefined` 与 `''` 分家；
 * 5. **装配纪律**（读源码）：共享收口 + 插件供方是**唯一**落点，宿主不留自建注册。
 *
 * 旧文件里的"判据级"断言（候选集 / 顺序 / detail / documentation 正文 / 事件目录 / 锚点与
 * 骨架 / 声明索引的时机）已随判据搬进 `packages/kojo-lang/tests/completion.test.ts` 与
 * `packages/plugins/kojo-lang/tests/completion-hover.test.ts`——本文件不再重测一遍语法，
 * 只验"插件交上来的账，宿主有没有原样翻成 Monaco 的账"。
 *
 * 假 Monaco 只实现被真正用到的那几格（两枚注册函数 + 三个枚举 + `Uri.file`），
 * 其余一律由真纯模型给出。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorCompletionRequest,
  EditorHoverRequest,
  EditorLanguageServiceContribution,
  PluginContext,
} from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_ANCHOR_CHARS, KOJO2_COMPLETION_TRIGGER_CHARS } from '@kojo/kojo-lang/completion';
import { createKojoLangPlugin } from '@kojo/plugin-kojo-lang';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { declaredSlotKinds, languageDescriptors } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import {
  SLOT_SERVICE_LEGS,
  SLOT_SERVICE_WRITE_LEGS,
  completionKindOf,
  installSlotServiceLegs,
  installSlotServiceProviders,
  toMonacoCompletionItem,
  toMonacoCompletionItems,
  toMonacoHover,
} from '../src/monaco/slot-service-providers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/* ============================== 共享收口的期望 selector ============================== */

/**
 * 期望 selector **从 descriptor 表现算**，不手抄语言 id 清单：手抄一份就变成"第二张真源"，
 * 哪天新语言声明了 `languageServices`，这里会跟着自动覆盖（而实现若漏挂，比较就会红）。
 */
const COMPLETION_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('completion') === true,
  )
  .map((descriptor) => descriptor.id);

const HOVER_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true || descriptor.slotServices?.includes('hover') === true,
  )
  .map((descriptor) => descriptor.id);

/**
 * 写面腿（`SLOT_SERVICE_WRITE_LEGS`）的期望 selector：**点名了这条腿的语言才有**
 * （`namedOnly` ⇒ 旧桥全腿不铺写面）。同样**从 descriptor 表现算**，判据走
 * `language-registry` 的 `declaredSlotKinds`（与挂载收口同一枚声明面），不手抄语言 id。
 */
const WRITE_LEGS_SELECTORS = languageDescriptors()
  .filter((descriptor) =>
    SLOT_SERVICE_WRITE_LEGS.some((kind) => declaredSlotKinds(descriptor).includes(kind)),
  )
  .map((descriptor) => descriptor.id);

/* ============================== 假 Monaco / 假 model / 假内核 ============================== */

/**
 * Monaco `CompletionItemKind` 的真实数值（0.57 枚举顺序；宿主只用这几格，测试按同一张表比）。
 * 单独列在这里而不是从 `monaco/entry` 取：node 池里 Monaco 运行时不进模块图。
 */
const KINDS = {
  Function: 1,
  Variable: 4,
  Struct: 6,
  Module: 8,
  Event: 10,
  Operator: 11,
  Value: 13,
  Constant: 14,
  Enum: 15,
  Keyword: 17,
  Text: 18,
  Snippet: 27,
  // LAU-4 补全腿（2026-10-31）：`reference` 档挑 `CompletionItemKind.Reference` 图标
  Reference: 21,
} as const;

type ProviderKind = 'completion' | 'hover';

interface Registration {
  readonly kind: ProviderKind;
  readonly selector: unknown;
  readonly provider: unknown;
}

interface FakeMonacoOptions {
  /** 让某一枚注册抛错（模拟"半途失败"，验回滚 + 外抛） */
  readonly failOn?: ProviderKind;
  /** 让某一枚注册的 dispose 抛错（验逐枚隔离） */
  readonly failDisposeOn?: ProviderKind;
  /** 桩缺 `CompletionItemKind.Snippet`（老宿主 / 剪裁过的 Monaco 运行时） */
  readonly omitSnippetKind?: boolean;
  /** 桩缺 `CompletionItemInsertTextRule`（同上） */
  readonly omitInsertTextRule?: boolean;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  /** 每一次 `registration.dispose()` 都记在这里（幂等 / 隔离的判据） */
  readonly disposeCalls: ProviderKind[];
}

function fakeMonaco(options: FakeMonacoOptions = {}): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: ProviderKind[] = [];
  const register = (kind: ProviderKind) => (selector: unknown, provider: unknown) => {
    if (options.failOn === kind) throw new Error(`桩：注册 ${kind} 抛错`);
    registrations.push({ kind, selector, provider });
    return {
      dispose: () => {
        if (options.failDisposeOn === kind) throw new Error(`桩：撤 ${kind} 抛错`);
        disposeCalls.push(kind);
      },
    };
  };
  const completionKinds: Record<string, number> = { ...KINDS };
  if (options.omitSnippetKind === true) delete completionKinds.Snippet;
  const fake = {
    languages: {
      CompletionItemKind: completionKinds,
      ...(options.omitInsertTextRule === true
        ? {}
        : { CompletionItemInsertTextRule: { InsertAsSnippet: 4 } }),
      registerCompletionItemProvider: register('completion'),
      registerHoverProvider: register('hover'),
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

/**
 * 只装本文件关心的两条腿（车 2–4 之后表里还有七条，桩 Monaco 没桩它们的注册函数）。
 * 顺序 = 表格序的前两格，与生产装配点的相对序一致。
 */
function installForTest(options: FakeMonacoOptions = {}): FakeMonaco {
  const fake = fakeMonaco(options);
  installSlotServiceLegs(fake.monaco, ['completion', 'hover']);
  return fake;
}

function selectorsOf(fake: FakeMonaco, kind: ProviderKind): unknown[] {
  return fake.registrations.filter((entry) => entry.kind === kind).map((entry) => entry.selector);
}

/**
 * 写面腿专用的最小桩 Monaco：`legOf('codeAction', …)` 的注册路径只摸两格——
 * `editor.registerCommand`（动作落地命令，全局一枚）与 `languages.registerCodeActionProvider`
 * （逐门挂上）。其余注册函数一概不桩：装错腿当场 TypeError，不会被静默吞掉。
 */
function fakeMonacoForWriteLegs(): {
  readonly monaco: typeof Monaco;
  readonly codeActionSelectors: string[];
  readonly commandIds: string[];
} {
  const codeActionSelectors: string[] = [];
  const commandIds: string[] = [];
  const fake = {
    languages: {
      registerCodeActionProvider: (id: string) => {
        codeActionSelectors.push(id);
        return { dispose: () => undefined };
      },
    },
    editor: {
      registerCommand: (id: string) => {
        commandIds.push(id);
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, codeActionSelectors, commandIds };
}

function registrationOf(fake: FakeMonaco, kind: ProviderKind, selector: string): Registration {
  const found = fake.registrations.find(
    (entry) => entry.kind === kind && entry.selector === selector,
  );
  if (found === undefined) throw new Error(`没有在 ${selector} 上注册 ${kind}`);
  return found;
}

function completionProviderOf(fake: FakeMonaco): Monaco.languages.CompletionItemProvider {
  return registrationOf(fake, 'completion', KOJO2_LANGUAGE_ID).provider as
    Monaco.languages.CompletionItemProvider;
}

function hoverProviderOf(fake: FakeMonaco): Monaco.languages.HoverProvider {
  return registrationOf(fake, 'hover', KOJO2_LANGUAGE_ID).provider as Monaco.languages.HoverProvider;
}

/** Monaco provider 的第三/四参（本层不用它们，但签名要求传） */
const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const COMPLETION_CONTEXT = {
  triggerKind: 0,
} as unknown as Monaco.languages.CompletionContext;

interface FakeModelOptions {
  /** `getWordAtPosition` 的答案（宿主缺省区间用；缺省 = 词外） */
  readonly word?: { readonly startColumn: number; readonly endColumn: number };
  /** 省略 `uri`（"没有文件身份"的桩） */
  readonly noUri?: boolean;
  /** 省略 `getLanguageId` / `getVersionId`（旧宿主 / 桩 model） */
  readonly bare?: boolean;
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  /** 只给"取文抛错"用例用：让 `getValue()` 抛 */
  readonly failGetValue: () => void;
}

const MODEL_PATH = 'D:/proj/口上/12/场景.kojo2';

function fakeModel(text: string, options: FakeModelOptions = {}): FakeModel {
  let broken = false;
  const rows = text.split(/\r\n|\r|\n/);
  const base: Record<string, unknown> = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineContent: (line: number) => rows[line - 1] ?? '',
    getLineCount: () => rows.length,
    getWordAtPosition: () => options.word ?? null,
    isDisposed: () => broken,
  };
  if (options.noUri !== true) {
    base.uri = {
      scheme: 'file',
      path: MODEL_PATH,
      fsPath: MODEL_PATH,
      toString: () => 'file:///D:/proj/口上/12/场景.kojo2',
    };
  }
  if (options.bare !== true) {
    base.getLanguageId = () => KOJO2_LANGUAGE_ID;
    base.getVersionId = () => 7;
  }
  return {
    model: base as unknown as Monaco.editor.ITextModel,
    failGetValue: () => {
      broken = true;
    },
  };
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

interface KernelRecord {
  readonly queried: string[];
}

/** 装一枚假内核：`slots.query` 交回给定的贡献（与 `kernel.slots.query` 同形状） */
function installKernel(
  contributions: readonly EditorLanguageServiceContribution[],
  project: unknown = null,
): KernelRecord {
  const queried: string[] = [];
  setGlobalKernel({
    slots: {
      query: (slot: string) => {
        queried.push(slot);
        return slot === 'ui.editor.languageService' ? contributions : [];
      },
    },
    project: { current: () => project },
  } as unknown as KernelLike);
  return { queried };
}

/** 一枚只答固定结果的贡献（本层测的是翻译，不测判据） */
function contributionOf(
  provide: EditorLanguageServiceContribution['provide'],
  id = 'stub-contribution',
): EditorLanguageServiceContribution {
  return { id, provide };
}

function suggestionsAt(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  line: number,
  column: number,
  triggerCharacter?: string,
): Monaco.languages.CompletionItem[] {
  return (
    completionProviderOf(fake).provideCompletionItems(
      model,
      { lineNumber: line, column } as Monaco.Position,
      triggerCharacter === undefined
        ? COMPLETION_CONTEXT
        : ({ triggerKind: 1, triggerCharacter } as unknown as Monaco.languages.CompletionContext),
      TOKEN,
    ) as Monaco.languages.CompletionList
  ).suggestions;
}

function hoverAt(fake: FakeMonaco, model: Monaco.editor.ITextModel, line: number, column: number) {
  return hoverProviderOf(fake).provideHover(
    model,
    { lineNumber: line, column } as Monaco.Position,
    TOKEN,
  ) as Monaco.languages.Hover | undefined;
}

/** 造一份契约候选（缺省 = 最小合法条目） */
function item(overrides: Partial<EditorCompletionItem> = {}): EditorCompletionItem {
  return { label: '示例', ...overrides };
}

const FALLBACK_RANGE: Monaco.IRange = {
  startLineNumber: 3,
  startColumn: 1,
  endLineNumber: 3,
  endColumn: 1,
};

/* ============================== ① 注册：共享收口 ============================== */

describe('注册：selector 来自共享收口（descriptor 的 languageServices ∪ slotServices）', () => {
  it('补全的 selector 逐门等于 descriptor 现算的那张清单（不是写死的 kojo2 常量）', () => {
    const fake = installForTest();
    expect(selectorsOf(fake, 'completion')).toEqual(COMPLETION_SELECTORS);
    expect(COMPLETION_SELECTORS.length).toBeGreaterThan(1);
    expect(COMPLETION_SELECTORS).toContain(ERB_LANGUAGE_ID);
    expect(COMPLETION_SELECTORS).toContain(KOJO_LANGUAGE_ID);
    expect(COMPLETION_SELECTORS).toContain(KOJO2_LANGUAGE_ID);
  });

  it('悬停的 selector 同样来自收口（两张清单在 kojo2 上重合，但来源仍是 descriptor）', () => {
    const fake = installForTest();
    expect(selectorsOf(fake, 'hover')).toEqual(HOVER_SELECTORS);
    expect(selectorsOf(fake, 'hover')).toContain(KOJO2_LANGUAGE_ID);
    expect(selectorsOf(fake, 'hover')).toEqual(selectorsOf(fake, 'completion'));
  });

  it('kojo2 那两格确实来自 `slotServices`（它不声明 languageServices）', () => {
    const kojo2 = languageDescriptors().find((descriptor) => descriptor.id === KOJO2_LANGUAGE_ID);
    expect(kojo2).toBeDefined();
    expect(kojo2!.languageServices).not.toBe(true);
    expect(kojo2!.slotServices).toContain('completion');
    expect(kojo2!.slotServices).toContain('hover');
    // 保留面（JSON / XML）不住在任何一张清单里：空 provider 会顶掉 Monaco 内建行为
    expect(COMPLETION_SELECTORS).not.toContain('json');
  });

  it('两枚各挂一遍 × 覆盖的语言数；触发字符来自包（宿主不留第二份）', () => {
    const fake = installForTest();
    expect(fake.registrations.filter((entry) => entry.kind === 'completion')).toHaveLength(
      COMPLETION_SELECTORS.length,
    );
    expect(fake.registrations.filter((entry) => entry.kind === 'hover')).toHaveLength(
      HOVER_SELECTORS.length,
    );
    expect(completionProviderOf(fake).triggerCharacters).toEqual([
      ...KOJO2_COMPLETION_TRIGGER_CHARS,
    ]);
  });
});

/* ============================== ①b 注册顺序（B5b 车 1 新增） ============================== */

/**
 * **为什么顺序也要钉成判据**：Monaco 对**单答型** provider（悬停）是"第一家说了算"，
 * 对补全是并集；而对悬挂在同一个 `kind` 上的多份供方，谁是"第一家"只由注册顺序决定
 * （`register-dialects.ts` 头注有这条取证）。表格化之后顺序从"两行 `push` 的书写次序"变成
 * "数组元素的次序"——迁移时最容易悄悄改掉的就是它，所以这里钉三层：
 * ① 表格序 = 搬家前的两枚 push 序（completion → hover）；
 * ② 实际注册序 = 表格序（每条腿逐门挂完再挂下一条）；
 * ③ 装配点那道调用的相对位置（语义捕获之后、切流块之前）也照旧。
 */
describe('注册顺序：补全先于悬停（单答型第一家说了算）', () => {
  it('表格数组序 = 车 1 的两格在前、车 2–5 的八格按批准顺序追加', () => {
    // 车 1：completion → hover（搬家前的两行 push 序）
    // 车 2：formatting → signatureHelp；车 3：references → rename；车 4：documentHighlight →
    // selectionRange → codeLens。**新腿一律追加**，插进中间等于改掉"谁排在前"的既有事实。
    expect(SLOT_SERVICE_LEGS.map((leg) => leg.kind)).toEqual([
      'completion',
      'hover',
      'formatting',
      'signatureHelp',
      'references',
      'rename',
      'documentHighlight',
      'selectionRange',
      'codeLens',
      // 车 5（2026-10-31）：快速修复 / 一键迁移（写面，宿主按切流策略单独装）
      'codeAction',
    ]);
  });

  it('与 v1 的同种 provider：本表整体仍**先**于它们注册（搬家前的先后一格不动）', () => {
    // 同一种 provider 只有本表一枚，Monaco 的"第一家说了算"只在同种之间裁决；真正的契约是
    // "v1 那条同种 provider 仍在后面注册"——ERB / kojo1 的排版、改名、引用、注解各自有自己
    // 的通道，它们靠"后注册"排到第一位（`kojo-format.ts` / `erb-rename.ts` 头注同一条口径）。
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages', 'app', 'src', 'ui', 'editor-global-providers.ts'),
      'utf8',
    );
    const slotLegs = source.indexOf('installSlotServiceProviders(monaco, slotServiceHost');
    expect(slotLegs).toBeGreaterThan(-1);
    for (const later of [
      'installDocumentFormatter(',
      'installKojoRangeFormatter(',
      'installErbOnTypeFormatter(',
      'installErbRename(',
      'installKojoRename(',
      'installReferenceProvider(',
      'installCodeLensProvider(',
    ]) {
      expect(source.indexOf(later), `${later} 必须在槽腿工厂之后注册`).toBeGreaterThan(slotLegs);
    }
    // v1 的签名帮助在装配段前半（槽腿工厂之前）——那条先后同样逐字未变
    expect(source.indexOf('installSignatureHelp(')).toBeLessThan(slotLegs);
  });

  it('实际注册序 = 表格序：补全整组在前、悬停整组在后', () => {
    const fake = installForTest();
    expect(fake.registrations.map((entry) => entry.kind)).toEqual([
      ...COMPLETION_SELECTORS.map(() => 'completion'),
      ...HOVER_SELECTORS.map(() => 'hover'),
    ]);
  });

  it('装配点相对序不变：语义捕获预取 → 槽腿工厂 → 切流块', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages', 'app', 'src', 'ui', 'editor-global-providers.ts'),
      'utf8',
    );
    const captures = source.indexOf('globalDisposers.push(installKojo2SemanticCaptures(monaco))');
    const legs = source.indexOf('installSlotServiceProviders(monaco, slotServiceHost');
    const cutover = source.indexOf('if (isKojo2CutoverEnabled()) {');
    expect(captures).toBeGreaterThan(-1);
    expect(legs).toBeGreaterThan(captures);
    expect(cutover).toBeGreaterThan(legs);
  });

  it('写面腿真装：SLOT_SERVICE_WRITE_LEGS 非空、经 installSlotServiceLegs 只挂点名语言（namedOnly）', () => {
    // 钉什么：今天只验了写面腿"不随只读面装配"（不挂的一侧）——这里钉**挂的那一侧**：
    // 名单是真数据、安装走同一条收口、namedOnly 让旧桥全腿语言（ERB / kojo1）不摊上永远
    // 弃权的 💡 provider，点名者（kojo2）挂上且全局命令只注册一次。
    // 不钉会怎样：namedOnly 传错（或 SLOT_SERVICE_WRITE_LEGS 被掏空 / 摘掉），要么 v1 语言
    // 被铺第二枚 CodeActionProvider（动作两份），要么写面从此一枚都不挂——两头都是静默。
    expect(SLOT_SERVICE_WRITE_LEGS.length).toBeGreaterThan(0);
    expect(SLOT_SERVICE_LEGS.some((leg) => SLOT_SERVICE_WRITE_LEGS.includes(leg.kind))).toBe(true);
    const fake = fakeMonacoForWriteLegs();
    const installed = installSlotServiceLegs(fake.monaco, SLOT_SERVICE_WRITE_LEGS);
    expect(fake.codeActionSelectors, '写面腿挂的语言 ≠ descriptor 点名清单').toEqual(WRITE_LEGS_SELECTORS);
    expect(WRITE_LEGS_SELECTORS).toContain(KOJO2_LANGUAGE_ID);
    expect(WRITE_LEGS_SELECTORS, 'namedOnly 失效：旧桥语言被铺了写面 provider').not.toContain(
      ERB_LANGUAGE_ID,
    );
    expect(WRITE_LEGS_SELECTORS, 'namedOnly 失效：旧桥语言被铺了写面 provider').not.toContain(
      KOJO_LANGUAGE_ID,
    );
    expect(fake.commandIds, '落地命令是全局的：铺几门语言都只注册一次').toHaveLength(1);
    installed.dispose();
  });

  it('宿主策略块**真调用**写面安装器：切流开关块里逐字存在那一行', () => {
    // 钉什么：`editor-global-providers.ts` 的 `if (isKojo2CutoverEnabled())` 块内确实调了
    // `installSlotServiceLegs(monaco, SLOT_SERVICE_WRITE_LEGS, slotServiceHost)`——工厂侧只是
    // 把它从无条件装配里**排除**，装回来的是宿主策略块这一行。
    // 不钉会怎样：有人删掉那一行（或把名单传成空数组），生产里写面永远不装；"不挂"侧的
    // 既有断言照样全绿，功能静默消失。
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages', 'app', 'src', 'ui', 'editor-global-providers.ts'),
      'utf8',
    );
    const cutover = source.indexOf('if (isKojo2CutoverEnabled()) {');
    expect(cutover).toBeGreaterThan(-1);
    const block = source.slice(cutover, source.indexOf('\n    }', cutover));
    expect(block).toContain('installSlotServiceLegs(monaco, SLOT_SERVICE_WRITE_LEGS');
  });
});

/* ============================== ② dispose / 回滚 ============================== */

describe('dispose 与半途失败：聚合句柄幂等、逐枚隔离', () => {
  it('dispose 幂等：两次只撤一轮，两条腿逐门各撤一次', () => {
    const fake = installForTest();
    const installed = installSlotServiceLegs(fake.monaco, ['completion', 'hover']);
    installed.dispose();
    installed.dispose();
    expect(fake.disposeCalls.filter((kind) => kind === 'completion')).toHaveLength(
      COMPLETION_SELECTORS.length,
    );
    expect(fake.disposeCalls.filter((kind) => kind === 'hover')).toHaveLength(
      HOVER_SELECTORS.length,
    );
    expect(fake.disposeCalls).toHaveLength(COMPLETION_SELECTORS.length + HOVER_SELECTORS.length);
  });

  it('一枚 dispose 抛错不带走其余，也不把错误抛给调用方', () => {
    const fake = fakeMonaco({ failDisposeOn: 'hover' });
    const installed = installSlotServiceLegs(fake.monaco, ['completion', 'hover']);
    expect(() => installed.dispose()).not.toThrow();
    // 补全那一组全撤了；悬停组第一枚就抛，被"逐枚 try-catch"吞掉（不许带走别的注册组）
    expect(fake.disposeCalls.filter((kind) => kind === 'completion')).toHaveLength(
      COMPLETION_SELECTORS.length,
    );
    expect(fake.disposeCalls).not.toContain('hover');
  });

  it('注册半途抛错 ⇒ 错误外抛，且已挂上的那组被撤回（全有或全无）', () => {
    // 这一格钉的是**旧安装器承诺过的语义**：注册半途抛错 ⇒ 撤回已挂上的那几枚再外抛。
    // 搬家后两枚能力都由 `registerForLanguageServices` 一次铺完所有语言；如果写成
    // `registrations.push(a, b)`，第二枚抛错时第一枚的句柄还没进数组 ⇒ 撤不回来（静默残留）。
    // 实现改成逐条腿 push（见 `slot-service-providers.ts` 的注），这里的回滚就必须真的发生。
    const fake = fakeMonaco({ failOn: 'hover' });
    expect(() => installSlotServiceLegs(fake.monaco, ['completion', 'hover'])).toThrow(/注册 hover/);
    // 挂上过（可见事实）
    expect(fake.registrations.map((entry) => entry.kind)).toEqual(
      COMPLETION_SELECTORS.map(() => 'completion'),
    );
    // 但已全部撤回：撤的是 completion 那一组，逐门各一枚，hover 一枚都没挂上过
    expect(fake.disposeCalls.filter((kind) => kind === 'completion')).toHaveLength(
      COMPLETION_SELECTORS.length,
    );
    expect(fake.disposeCalls).not.toContain('hover');
    // 回滚代码仍在（实现若退回 `push(a, b)`，上面那条 dispose 断言会先红，这条是二道保险）
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'slot-service-providers.ts'),
      'utf8',
    );
    expect(source).toContain('for (const registration of registrations)');
  });

  it('安装器不读切流开关（K2-SURFACE-DEFAULT：只读语言面装配即注册）', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'slot-service-providers.ts'),
      'utf8',
    );
    expect(source).not.toContain('isKojo2CutoverEnabled');
  });
});

/* ============================== ③ 图标：契约十二档 ============================== */

describe('图标：契约十三档 → Monaco 枚举逐格对表', () => {
  const TABLE: readonly (readonly [EditorCompletionItemKind, number])[] = [
    ['operator', KINDS.Operator],
    ['keyword', KINDS.Keyword],
    ['function', KINDS.Function],
    ['variable', KINDS.Variable],
    ['value', KINDS.Value],
    ['snippet', KINDS.Snippet],
    ['text', KINDS.Text],
    ['event', KINDS.Event],
    ['constant', KINDS.Constant],
    ['struct', KINDS.Struct],
    ['enum', KINDS.Enum],
    ['module', KINDS.Module],
    // LAU-4 补全腿 additive 的第十三档
    ['reference', KINDS.Reference],
  ];

  for (const [kind, expected] of TABLE) {
    it(`${kind} ⇒ ${expected}`, () => {
      expect(completionKindOf(fakeMonaco().monaco, kind)).toBe(expected);
    });
  }

  it('未知档 / 缺省 ⇒ Text（不借邻居的色）', () => {
    expect(
      completionKindOf(fakeMonaco().monaco, '未来新增的档' as EditorCompletionItemKind),
    ).toBe(KINDS.Text);
    expect(completionKindOf(fakeMonaco().monaco, undefined)).toBe(KINDS.Text);
  });

  it('桩缺 Snippet 枚举：`snippet` 档退 Text（纯图标那一路；带模板的那一路整枚丢弃，见下一组）', () => {
    const fake = fakeMonaco({ omitSnippetKind: true });
    expect(completionKindOf(fake.monaco, 'snippet')).toBe(KINDS.Text);
  });
});

/* ============================== ④ 逐字段翻译 ============================== */

describe('补全逐字段：range / filterText / documentation / sortText / detail / insertText', () => {
  it('契约区间 → IRange（1 基、尾列半开、单行）', () => {
    const entry = toMonacoCompletionItem(
      fakeMonaco().monaco,
      item({ range: { line: 4, startColumn: 3, endColumn: 6 } }),
      FALLBACK_RANGE,
    );
    expect(entry!.range).toEqual({
      startLineNumber: 4,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 6,
    });
  });

  it('供方没给 range ⇒ 落宿主现行词区间（fallback）', () => {
    const entry = toMonacoCompletionItem(fakeMonaco().monaco, item(), FALLBACK_RANGE);
    expect(entry!.range).toEqual(FALLBACK_RANGE);
  });

  it('尾列早于首列 ⇒ 兜成零宽（违约的那一枚不许交给 Monaco）', () => {
    const entry = toMonacoCompletionItem(
      fakeMonaco().monaco,
      item({ range: { line: 2, startColumn: 5, endColumn: 1 } }),
      FALLBACK_RANGE,
    );
    expect(entry!.range).toEqual({
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 2,
      endColumn: 5,
    });
  });

  it('非法坐标 ⇒ 不给区间（落 fallback）并 warn 出候选名', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const entry = toMonacoCompletionItem(
        fakeMonaco().monaco,
        item({ label: '坏区间', range: { line: Number.NaN, startColumn: 1, endColumn: 2 } }),
        FALLBACK_RANGE,
      );
      expect(entry!.range).toEqual(FALLBACK_RANGE);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('documentationFormat=markdown ⇒ IMarkdownString；缺省（纯文本）⇒ 原样字符串', () => {
    const fake = fakeMonaco();
    const markdown = toMonacoCompletionItem(
      fake.monaco,
      item({ documentation: '**名**（变量声明）', documentationFormat: 'markdown' }),
      FALLBACK_RANGE,
    );
    expect(markdown!.documentation).toEqual({ value: '**名**（变量声明）' });
    const text = toMonacoCompletionItem(
      fake.monaco,
      item({ documentation: '来源行：第 7 行' }),
      FALLBACK_RANGE,
    );
    expect(text!.documentation).toBe('来源行：第 7 行');
  });

  it('没有 documentation ⇒ 一格都不写（不编说明）', () => {
    const entry = toMonacoCompletionItem(fakeMonaco().monaco, item(), FALLBACK_RANGE);
    expect(entry!.documentation).toBeUndefined();
  });

  it('filterText / sortText / detail 原样透传，insertText 缺省 = label', () => {
    const fake = fakeMonaco();
    const entry = toMonacoCompletionItem(
      fake.monaco,
      item({ label: '好感度', filterText: 'hao', sortText: '1_x', detail: '变量' }),
      FALLBACK_RANGE,
    );
    expect(entry!.filterText).toBe('hao');
    expect(entry!.sortText).toBe('1_x');
    expect(entry!.detail).toBe('变量');
    expect(entry!.insertText).toBe('好感度');
  });

  it('显式 insertText 优先于 label（同名不同插法是两条）', () => {
    const entry = toMonacoCompletionItem(
      fakeMonaco().monaco,
      item({ label: '变量', insertText: '# 设 ' }),
      FALLBACK_RANGE,
    );
    expect(entry!.insertText).toBe('# 设 ');
  });

  it('kind 缺省 ⇒ Text；label 原样上屏', () => {
    const entry = toMonacoCompletionItem(fakeMonaco().monaco, item({ label: '甲' }), FALLBACK_RANGE);
    expect(entry!.kind).toBe(KINDS.Text);
    expect(entry!.label).toBe('甲');
  });
});

/* ============================== ⑤ 插入语义 ============================== */

describe('插入语义：`kind: snippet` 与 `insertTextFormat: snippet` 是两件事', () => {
  it("显式 `insertTextFormat: 'snippet'` ⇒ 打开 InsertAsSnippet", () => {
    const entry = toMonacoCompletionItem(
      fakeMonaco().monaco,
      item({ label: '? 链', kind: 'snippet', insertText: '? ${1:条件}', insertTextFormat: 'snippet' }),
      FALLBACK_RANGE,
    );
    expect(entry!.insertTextRules).toBe(4);
    expect(entry!.kind).toBe(KINDS.Snippet);
  });

  it("`# 模` 声明名：kind=snippet 但**不**带 insertTextFormat ⇒ 只有图标，不开模板", () => {
    const entry = toMonacoCompletionItem(
      fakeMonaco().monaco,
      item({ label: '问候', kind: 'snippet', insertText: '问候' }),
      FALLBACK_RANGE,
    );
    expect(entry!.kind).toBe(KINDS.Snippet);
    expect('insertTextRules' in entry!).toBe(false);
  });

  it("显式 `insertTextFormat: 'plainText'` 与缺省同义（都不开模板）", () => {
    const entry = toMonacoCompletionItem(
      fakeMonaco().monaco,
      item({ label: '问候', kind: 'snippet', insertTextFormat: 'plainText' }),
      FALLBACK_RANGE,
    );
    expect('insertTextRules' in entry!).toBe(false);
  });

  it('桩缺 `CompletionItemInsertTextRule` ⇒ 带模板的那一枚整枚丢弃（不写 undefined）', () => {
    const fake = fakeMonaco({ omitInsertTextRule: true });
    const dropped = toMonacoCompletionItem(
      fake.monaco,
      item({ label: '? 链', insertTextFormat: 'snippet' }),
      FALLBACK_RANGE,
    );
    expect(dropped).toBeUndefined();
  });

  it('桩缺 `CompletionItemKind.Snippet` ⇒ 带模板的那一枚同样整枚丢弃', () => {
    const fake = fakeMonaco({ omitSnippetKind: true });
    const dropped = toMonacoCompletionItem(
      fake.monaco,
      item({ label: '? 链', insertTextFormat: 'snippet' }),
      FALLBACK_RANGE,
    );
    expect(dropped).toBeUndefined();
  });

  it('桩缺 Snippet 枚举但条目只是"借图标" ⇒ 退 Text 且**不**丢（撤候选比少一色更贵）', () => {
    const fake = fakeMonaco({ omitSnippetKind: true });
    const entry = toMonacoCompletionItem(
      fake.monaco,
      item({ label: '问候', kind: 'snippet' }),
      FALLBACK_RANGE,
    );
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe(KINDS.Text);
    expect('insertTextRules' in entry!).toBe(false);
  });

  it('数组翻译只丢被枚举闸拦下的那几枚，顺序与其余字段不变', () => {
    const fake = fakeMonaco({ omitInsertTextRule: true });
    const entries = toMonacoCompletionItems(
      fake.monaco,
      [
        item({ label: '甲', kind: 'operator' }),
        item({ label: '乙', insertTextFormat: 'snippet' }),
        item({ label: '丙', kind: 'text' }),
      ],
      FALLBACK_RANGE,
    );
    expect(entries.map((entry) => entry.label)).toEqual(['甲', '丙']);
  });
});

/* ============================== ⑥ 悬停翻译 ============================== */

describe('悬停翻译：markdown / undefined / range 三条处置', () => {
  it('markdown 正文 ⇒ 一段 IMarkdownString', () => {
    const hover = toMonacoHover({ kind: 'hover', contents: '**好感**（变量声明）', format: 'markdown' });
    expect(hover!.contents).toEqual([{ value: '**好感**（变量声明）' }]);
  });

  it("缺省 'text' 在浮层这一格同形（Monaco 0.57 只收 IMarkdownString）", () => {
    const hover = toMonacoHover({ kind: 'hover', contents: '纯文本' });
    expect(hover!.contents).toEqual([{ value: '纯文本' }]);
  });

  it('无人应答（undefined）⇒ undefined（把下一路浮层让出来）', () => {
    expect(toMonacoHover(undefined)).toBeUndefined();
  });

  it('有人答"没话说"（空串）⇒ 同样不弹，但这是作答（单答裁决已在 legs 收口）', () => {
    expect(toMonacoHover({ kind: 'hover', contents: '' })).toBeUndefined();
  });

  it('range 落成 IRange（1 基、尾列半开）', () => {
    const hover = toMonacoHover({
      kind: 'hover',
      contents: '正文',
      range: { line: 6, startColumn: 3, endColumn: 6 },
    });
    expect(hover!.range).toEqual({
      startLineNumber: 6,
      startColumn: 3,
      endLineNumber: 6,
      endColumn: 6,
    });
  });

  it('没有 range ⇒ 键不出现（不发明零宽区间）', () => {
    const hover = toMonacoHover({ kind: 'hover', contents: '正文', format: 'markdown' });
    expect('range' in hover!).toBe(false);
  });

  it('非坐标 range ⇒ 正文照给、区间缺席（不因一格坐标丢掉整层浮层）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const hover = toMonacoHover({
        kind: 'hover',
        contents: '正文',
        range: { line: Number.NaN, startColumn: 1, endColumn: 2 },
      });
      expect(hover!.contents).toEqual([{ value: '正文' }]);
      expect('range' in hover!).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/* ============================== ⑦ provider：请求形状与三态 ============================== */

describe('provider：宿主事实进请求、契约响应出 Monaco、三态各归各', () => {
  const SOURCE = ['# 设 好感 整数 = 0', '', '> 正文。', ''].join('\n');

  it('补全请求带 model 身份 / 全文 / 光标 / 项目 / 触发字符（path 取自 uri.fsPath）', () => {
    let seen: EditorCompletionRequest | EditorHoverRequest | undefined;
    const kernel = installKernel(
      [
        contributionOf((request) => {
          seen = request as EditorCompletionRequest | EditorHoverRequest;
          return { kind: 'completion', items: [] };
        }),
      ],
      { adapterId: 'proj-a' },
    );
    const fake = installForTest();
    const { model } = fakeModel(SOURCE);
    suggestionsAt(fake, model, 1, 4, '#');
    expect(kernel.queried).toContain('ui.editor.languageService');
    expect(seen!.kind).toBe('completion');
    expect(seen!.path).toBe(MODEL_PATH);
    expect((seen as { languageId?: string }).languageId).toBe(KOJO2_LANGUAGE_ID);
    expect((seen as { version?: number }).version).toBe(7);
    expect(seen!.text).toBe(SOURCE);
    expect((seen as { line: number }).line).toBe(1);
    expect((seen as { column: number }).column).toBe(4);
    expect((seen as { triggerCharacter?: string }).triggerCharacter).toBe('#');
    expect((seen as { project: unknown }).project).toEqual({ adapterId: 'proj-a' });
  });

  it('补全：契约候选逐枚翻成 Monaco，顺序不变', () => {
    installKernel([
      contributionOf(() => ({
        kind: 'completion',
        items: [
          item({ label: '#', kind: 'operator', range: { line: 1, startColumn: 1, endColumn: 1 } }),
          item({ label: '好感', kind: 'variable', range: { line: 1, startColumn: 4, endColumn: 6 } }),
        ],
      })),
    ]);
    const fake = installForTest();
    const suggestions = suggestionsAt(fake, fakeModel(SOURCE).model, 1, 4);
    expect(suggestions.map((entry) => entry.label)).toEqual(['#', '好感']);
    expect(suggestions.map((entry) => entry.kind)).toEqual([KINDS.Operator, KINDS.Variable]);
  });

  it('没有贡献方应答 ⇒ 空列表（不抛进 Monaco）', () => {
    installKernel([]);
    const fake = installForTest();
    expect(suggestionsAt(fake, fakeModel(SOURCE).model, 1, 1)).toEqual([]);
  });

  it('贡献方弃权（undefined）⇒ 空列表；答错 kind 也不被采纳', () => {
    installKernel([
      contributionOf(() => undefined),
      contributionOf(() => ({ kind: 'hover', contents: '不是补全' }) as never, 'wrong-kind'),
    ]);
    const fake = installForTest();
    expect(suggestionsAt(fake, fakeModel(SOURCE).model, 1, 1)).toEqual([]);
  });

  it('单枚贡献抛错 ⇒ 这一轮空结果、不抛，且 warn 带上贡献 id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      installKernel([
        contributionOf(() => {
          throw new Error('桩：供方炸了');
        }, 'kojo2-completion'),
      ]);
      const fake = installForTest();
      expect(suggestionsAt(fake, fakeModel(SOURCE).model, 1, 1)).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('kojo2-completion');
    } finally {
      warn.mockRestore();
    }
  });

  it('取文抛错 ⇒ `{ suggestions: [] }`（Monaco 能读的唯一空形状）', () => {
    installKernel([contributionOf(() => ({ kind: 'completion', items: [item()] }))]);
    const fake = installForTest();
    const broken = fakeModel(SOURCE);
    broken.failGetValue();
    const list = completionProviderOf(fake).provideCompletionItems(
      broken.model,
      { lineNumber: 1, column: 1 } as Monaco.Position,
      COMPLETION_CONTEXT,
      TOKEN,
    ) as Monaco.languages.CompletionList;
    expect(list).toEqual({ suggestions: [] });
  });

  it('桩 model 没有 uri ⇒ path 是空串（没有文件身份，不猜）', () => {
    let seen: EditorCompletionRequest | EditorHoverRequest | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as EditorCompletionRequest | EditorHoverRequest;
        return { kind: 'completion', items: [] };
      }),
    ]);
    const fake = installForTest();
    suggestionsAt(fake, fakeModel(SOURCE, { noUri: true }).model, 1, 1);
    expect(seen!.path).toBe('');
  });

  it('桩 model 缺 languageId / version ⇒ 两格键不出现（不补假值）', () => {
    let seen: EditorCompletionRequest | EditorHoverRequest | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as EditorCompletionRequest | EditorHoverRequest;
        return { kind: 'completion', items: [] };
      }),
    ]);
    const fake = installForTest();
    suggestionsAt(fake, fakeModel(SOURCE, { bare: true }).model, 1, 1);
    expect('languageId' in seen!).toBe(false);
    expect('version' in seen!).toBe(false);
  });

  it('候选缺 range ⇒ 用模型词区间兜底（Monaco 的 range 必填）', () => {
    installKernel([contributionOf(() => ({ kind: 'completion', items: [item()] }))]);
    const fake = installForTest();
    const suggestions = suggestionsAt(
      fake,
      fakeModel(SOURCE, { word: { startColumn: 4, endColumn: 6 } }).model,
      1,
      5,
    );
    expect(suggestions[0]!.range).toEqual({
      startLineNumber: 1,
      startColumn: 4,
      endLineNumber: 1,
      endColumn: 6,
    });
  });

  it('悬停请求同样带身份与项目（path / line / column / text / project）', () => {
    let seen: EditorCompletionRequest | EditorHoverRequest | undefined;
    installKernel(
      [
        contributionOf((request) => {
          seen = request as EditorCompletionRequest | EditorHoverRequest;
          return undefined;
        }),
      ],
      null,
    );
    const fake = installForTest();
    hoverAt(fake, fakeModel(SOURCE).model, 1, 5);
    expect(seen!.kind).toBe('hover');
    expect(seen!.path).toBe(MODEL_PATH);
    expect((seen as { line: number }).line).toBe(1);
    expect((seen as { column: number }).column).toBe(5);
    expect(seen!.text).toBe(SOURCE);
    expect((seen as { project: unknown }).project).toBeNull();
  });

  it('悬停：契约应答翻成浮层（正文 + range）', () => {
    installKernel([
      contributionOf(() => ({
        kind: 'hover',
        contents: '**好感**（变量声明）',
        format: 'markdown',
        range: { line: 1, startColumn: 4, endColumn: 6 },
      })),
    ]);
    const fake = installForTest();
    const hover = hoverAt(fake, fakeModel(SOURCE).model, 1, 5);
    expect(hover).toBeDefined();
    expect((hover!.contents[0] as { value: string }).value).toBe('**好感**（变量声明）');
    expect(hover!.range).toEqual({
      startLineNumber: 1,
      startColumn: 4,
      endLineNumber: 1,
      endColumn: 6,
    });
  });

  it('悬停：无人应答 ⇒ undefined（下一路 v1 词义悬浮还在）', () => {
    installKernel([]);
    const fake = installForTest();
    expect(hoverAt(fake, fakeModel(SOURCE).model, 1, 1)).toBeUndefined();
  });

  it('悬停：作答空串 ⇒ undefined，但不再问下一家', () => {
    let calls = 0;
    installKernel([
      contributionOf(() => {
        calls += 1;
        return { kind: 'hover', contents: '' };
      }, 'kojo2-hover'),
      contributionOf(() => {
        calls += 1;
        return { kind: 'hover', contents: '下一家的话' };
      }, 'second'),
    ]);
    const fake = installForTest();
    expect(hoverAt(fake, fakeModel(SOURCE).model, 1, 1)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('悬停：单枚贡献抛错 ⇒ undefined、不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      installKernel([
        contributionOf(() => {
          throw new Error('桩：悬停供方炸了');
        }, 'kojo2-hover'),
      ]);
      const fake = installForTest();
      expect(hoverAt(fake, fakeModel(SOURCE).model, 1, 1)).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('悬停：取文抛错 ⇒ undefined', () => {
    installKernel([contributionOf(() => ({ kind: 'hover', contents: '正文' }))]);
    const fake = installForTest();
    const broken = fakeModel(SOURCE);
    broken.failGetValue();
    expect(hoverAt(fake, broken.model, 1, 1)).toBeUndefined();
  });

  it('越界行号不崩（按空行处理：贡献方给空数组，provider 交空列表）', () => {
    installKernel([contributionOf(() => ({ kind: 'completion', items: [] }))]);
    const fake = installForTest();
    expect(suggestionsAt(fake, fakeModel(SOURCE).model, 9_999, 1)).toEqual([]);
  });
});

/* ============================== ⑧ 真插件端到端（接线形状） ============================== */

describe('真插件端到端：槽里放 `@kojo/plugin-kojo-lang` 的两枚贡献，宿主原样翻译', () => {
  const SOURCE = ['# 设 好感 整数 = 0', '# 模 问候(原因)', '    [插槽]', '! 问', '> 正文。', ''].join('\n');

  /** 起真插件、抓它注册的 languageService 贡献（与内核装配同一形状） */
  function activateKojoLang(): EditorLanguageServiceContribution[] {
    const contributions: EditorLanguageServiceContribution[] = [];
    const ctx = {
      pluginId: 'kojo-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, entry: EditorLanguageServiceContribution) => {
          if (slot === 'ui.editor.languageService') contributions.push(entry);
          return () => undefined;
        },
      },
    } as unknown as PluginContext;
    createKojoLangPlugin().activate(ctx);
    return contributions;
  }

  it('行首空行 ⇒ 五锚点（Operator）+ 块骨架（Snippet），只有骨架带 InsertAsSnippet', () => {
    installKernel(activateKojoLang());
    const fake = installForTest();
    const suggestions = suggestionsAt(fake, fakeModel(SOURCE).model, 6, 1);
    expect(suggestions.slice(0, KOJO2_ANCHOR_CHARS.length).map((entry) => entry.label)).toEqual([
      ...KOJO2_ANCHOR_CHARS,
    ]);
    expect(
      suggestions
        .slice(0, KOJO2_ANCHOR_CHARS.length)
        .every((entry) => entry.kind === KINDS.Operator),
    ).toBe(true);
    const snippets = suggestions.slice(KOJO2_ANCHOR_CHARS.length);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.every((entry) => entry.kind === KINDS.Snippet)).toBe(true);
    expect(snippets.every((entry) => entry.insertTextRules === 4)).toBe(true);
  });

  it('声明名悬停 ⇒ Markdown 浮层 + 名字段 range（措辞来自包，宿主不改写）', () => {
    installKernel(activateKojoLang());
    const fake = installForTest();
    const hover = hoverAt(fake, fakeModel(SOURCE).model, 1, 6);
    expect(hover).toBeDefined();
    const text = (hover!.contents[0] as { value: string }).value;
    expect(text).toContain('**好感**');
    expect(text).toContain('来源行：第 1 行');
    expect(hover!.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 7,
    });
  });

  it('非声明位置（台词正文）⇒ 悬停无人应答、补全空列表（插件弃权/空答各归其形）', () => {
    installKernel(activateKojoLang());
    const fake = installForTest();
    expect(hoverAt(fake, fakeModel(SOURCE).model, 5, 3)).toBeUndefined();
    expect(suggestionsAt(fake, fakeModel(SOURCE).model, 5, 3)).toEqual([]);
  });
});

/* ============================== ⑨ 装配纪律（读源码） ============================== */

describe('装配纪律：共享收口 + 插件供方是唯一落点（读源码断言）', () => {
  const read = (...segments: string[]): string =>
    readFileSync(resolve(REPO_ROOT, ...segments), 'utf8');

  it('`editor-global-providers` 在 flag 守卫块之外装配捕获预取器与通用槽腿工厂', () => {
    const source = read('packages', 'app', 'src', 'ui', 'editor-global-providers.ts');
    expect(source).toContain("from '../monaco/slot-service-providers'");
    // B3 语义收口（`ceedc0c8`）之后纪律**反向**了：着色 provider 的注册搬进共享收口
    // （kojo2 由 descriptor 的 `slotServices: ['semanticToken']` 点名），宿主这一侧只剩
    // 「把捕获快照预热好」。所以这里断的是"只装预取器、且不再自己注册 provider"——
    // 若哪天有人把 `installKojo2SemanticTokensProvider` 加回来，同一门语言就会有第二枚
    // provider 报名，收口的"恰好一份"立刻破功。
    expect(source).toContain('installKojo2SemanticCaptures(monaco)');
    expect(source).not.toMatch(/installKojo2SemanticTokensProvider\s*\(/);
    expect(source).toContain('installSlotServiceProviders(monaco, slotServiceHost');
    // 旧安装器名**归零**：搬家后谁再写回 kojo2 专属的那一枚，就等于同一格两份答案
    expect(source).not.toContain('installKojo2SlotProviders');
    const start = source.indexOf('if (isKojo2CutoverEnabled()) {');
    const blockEnd = source.indexOf('\n    }', start);
    const block = source.slice(start, blockEnd);
    expect(block).not.toContain('installKojo2SemanticCaptures');
    expect(block).not.toContain('installSlotServiceProviders');
  });

  it('安装调用只交**三格宿主事实**（adapter / 编译成品 / 候选投影都已归插件与包）', () => {
    const source = read('packages', 'app', 'src', 'ui', 'editor-global-providers.ts');
    // 车 5 起宿主事实收在一个 `slotServiceHost` 常量里（槽腿工厂与切流块两处共用同一份）
    const start = source.indexOf('const slotServiceHost: SlotServiceHost = {');
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf('};', start));
    // 三格：这份 model 是哪个文件 / 当前项目有哪些文件 / 跨文件 URI 怎么造
    expect(call).toContain('filePathOf:');
    expect(call).toContain('projectIndex:');
    expect(call).toContain('uriForPath:');
    // 行上注解**不取**项目快照（代价模型不同，见工厂头注）：装配点不许给它这一格
    expect(call).not.toContain('codeLensProjectIndex');
    // 也不是 adapter / 编译成品 / 候选投影的入口
    expect(call).not.toMatch(/adapter\s*:/);
    expect(call).not.toMatch(/captures\s*:/);
    expect(call).not.toMatch(/faces\s*:/);
  });

  it('两枚 provider 都经共享收口挂上，能力名由表格的 `kind` 给（不点名语言 id）', () => {
    const source = read('packages', 'app', 'src', 'monaco', 'slot-service-providers.ts');
    // 只数**调用形状**（`registerForLanguageServices(\n  monaco,`）：头注里那几处提及不算。
    // 搬家前是两枚各调一次收口；搬家后收口只剩**一处**（循环里的 `leg.register`），
    // 能力名改由表项的 `kind` 递进去——"哪条腿点了哪个名"仍逐条写在表里（下面两行）。
    expect(source.match(/registerForLanguageServices\(\s+monaco,/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/legOf\('completion',[\s\S]{0,200}registerCompletionItemProvider\(/);
    expect(source).toMatch(/legOf\('hover',[\s\S]{0,200}registerHoverProvider\(/);
    // 红线形状：注册调用的首个实参不许写死 kojo2 常量（今天写的是收口给的 `id`）
    expect(source).not.toMatch(
      new RegExp(`registerCompletionItemProvider\\(\\s*${KOJO2_LANGUAGE_ID}`),
    );
    expect(source).not.toMatch(new RegExp(`registerHoverProvider\\(\\s*${KOJO2_LANGUAGE_ID}`));
  });

  it('语言层不 import 任何插件包、不出现游戏名词，Monaco 只 type-only 引入', () => {
    const source = read('packages', 'app', 'src', 'monaco', 'slot-service-providers.ts');
    // `@kojo/plugin-api` 是宿主唯一允许的契约依赖；"插件包"指 `@kojo/plugin-<具体插件>`
    expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-(?!api)/);
    expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
    expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
    expect(source).not.toMatch(/import \* as Monaco from/);
  });

  it('adapter 与两面都由组合根按项目解析（宿主不写死某游戏）', () => {
    const source = read('packages', 'app', 'src', 'ui', 'editor-pane', 'use-monaco-instance.ts');
    // B3 收口最后一格：`ensureGlobalProviders` 的调用改成多行（`kojo2Adapter` + `kojo2Surface`），
    // 判据不变——两格仍然是"按当前项目从组合根登记簿现取"，且不出现某部游戏的具体 adapter。
    expect(source).toMatch(/ensureGlobalProviders\(\{\s*kojo2Adapter: \(\) =>/);
    expect(source).toContain('kojo2AdapterForProject(kernel.project.current())');
    expect(source).toContain('kojo2SurfaceForProject(project, {');
    expect(source).not.toMatch(/import\s*\{[^}]*ERATW_GAME_ADAPTER/);
    expect(source).not.toMatch(/kojo2Adapter:\s*\(\)\s*=>\s*ERATW_GAME_ADAPTER/);
  });
});
