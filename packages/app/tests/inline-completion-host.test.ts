// @vitest-environment happy-dom
/**
 * IC 批 A 车道（宿主接线）· 内联补全（幽灵文本）的**端到端自证**。
 *
 * ## 这一枚文件钉什么
 *
 * `monaco/inline-completion-host.ts` 把 Monaco 的 inline completions 通道接到槽
 * `completion.source`。本文件按**真通道**驱动它，不用桩替身：
 *
 * - **注册**走真实例：`installInlineCompletion(monaco, …)`（monaco = `src/monaco/entry`
 *   那一份真 vendor）→ 再从 vendor 自己的
 *   `ILanguageFeaturesService.inlineCompletionsProvider.all(model)` 把 provider 反查出来
 *   （公开面 `registerInlineCompletionsProvider` 的落点就在
 *   `standalone/browser/standaloneLanguages.js:512`）⇒"注册进去了"是**读出来**的，不是假设的；
 * - **出货**走真 vendor 的聚合器 `provideInlineCompletions(…)`（`contrib/inlineCompletions/
 *   browser/model/provideInlineCompletions.js`，`InlineCompletionsSource` 用的同一枚函数）
 *   ⇒ 拿到的是 vendor 的 `InlineSuggestionList` / `InlineSuggestData`，断言的是**接受键真正
 *   落下去的那一笔**（`action.kind === 'edit'` 的 `range` + `insertText`），并把那一笔
 *   `applyEdits` 到真 model 上验文本；
 * - **model / 位置 / 版本**都是真 `monaco.editor.createModel` 的（`getVersionId()` 真前进），
 *   "过期整批丢弃 + 就地重问"才有意义；
 * - 候选源一律是**本文件自造的假 contribution**，经真 `SlotRegistryImpl`（`@kojo/kernel`）
 *   注册进槽 `completion.source` 后由宿主现问——不依赖任何插件（B 车道的真候选源在另一条分支）。
 *
 * ## 先例口径
 *
 * 用真 vendor 内部模块而非桩，沿用 `kojo-variable-suggest-chain.test.ts`（真 `CompletionModel`
 * 的过滤数学）与 `code-action-undo-stack.test.ts`（真 monaco model 的撤销栈）。vendor 内部
 * 模块没有 .d.ts ⇒ 下面几处 `@ts-expect-error` 深 import。
 *
 * ## §H：`monaco/entry.ts` 那条 suggest→inline 桥
 *
 * 那条注释已经引用本文件，所以"quickSuggestions 是布尔 ⇒ 桥恒空转"必须是真跑出来的：
 * **机制**（vendor 自己的 `QuickSuggestionsOptions.valueFor` 对本仓三档一律给不出 `'inline'`）
 * 与**行为**（真桥 provider 在真 editor + 真 model 上交回 `undefined`）两条都钉；再加一条
 * **反证**（把值换成本仓从不给的字符串 `'inline'`，机制那一步立刻命中 ⇒ 两家会同投一格）。
 *
 * ## 键位归属（Tab / Esc / IME）在本文件里的部分
 *
 * 宿主**不注册键位**，于是可测的是三件事：①没有候选时交回的是**空批次**（vendor 那一侧
 * 得到"无幽灵文本"⇒ `inlineSuggestionVisible` 不成立）；②`context.selectedSuggestionInfo`
 * 有值时整条沉默 ⇒ Tab 仍归弹窗；③IME 合成期按键护栏是**共用**的那一副
 * （`installSuggestContextTrigger` 容器 capture 的 `stopPropagation`），本文件按真 DOM 事件验它
 * 挡得住 `editor.action.inlineSuggest.commit` 的整拍派发、且不 `preventDefault`。
 * 真按 Tab 的键位归属读数在调试宿（提交信息里带）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  InlineCompletionCandidate,
  InlineCompletionOutcome,
  InlineCompletionRequest,
  InlineCompletionSourceContribution,
} from '@kojo/plugin-api';
import { SlotRegistryImpl } from '@kojo/kernel';
import * as monaco from '../src/monaco/entry';
// vendor 内部模块没有类型面（`monaco.d.ts` 只覆盖公开面）⇒ 深 import 逐枚 @ts-expect-error
// @ts-expect-error TS7016 —— 真注册表（公开面 registerInlineCompletionsProvider 的落点）
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
// @ts-expect-error TS7016
import { ILanguageFeaturesService } from 'monaco-editor/editor/common/services/languageFeatures.js';
// @ts-expect-error TS7016 —— 真聚合器（InlineCompletionsSource 用的同一枚函数）
import { provideInlineCompletions } from 'monaco-editor/editor/contrib/inlineCompletions/browser/model/provideInlineCompletions.js';
// @ts-expect-error TS7016 —— 桥的早退判据用 vendor 自己那一枚
import { QuickSuggestionsOptions } from 'monaco-editor/editor/contrib/suggest/browser/suggest.js';
import {
  INLINE_MAX_CANDIDATES_FALLBACK,
  INLINE_REQUEST_TIMEOUT_MAX_MS,
  INLINE_REQUEST_TIMEOUT_MS,
  INLINE_STALE_REASK_LIMIT,
  askSources,
  clampCandidateRange,
  clampRequestTimeout,
  contextWindowOf,
  getInlineCompletionTally,
  installInlineCompletion,
  resetInlineCompletionTally,
  resetInlineCompletionWarningsForTests,
  toMonacoInlineCompletions,
  typedCharAt,
  type InlineCompletionFacts,
  type InlineCompletionHostDeps,
  type InlineCompletionReport,
} from '../src/monaco/inline-completion-host';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { registerBuiltinLanguageSurfaces } from '../src/monaco/languages';
import { QUICK_SUGGESTIONS, inlineSuggestPatch, quickSuggestionsFor } from '../src/ui/editor-options';
import { installSuggestContextTrigger } from '../src/monaco/suggest-context-trigger';

/* ============================== 底料 ============================== */

const HOST_DISPLAY = 'kojo-inline-completion-host';
const hostSourcePath = path.resolve(import.meta.dirname, '..', 'src', 'monaco', 'inline-completion-host.ts');
const ERB_PATH = 'C:/corpus/sample/0001.erb';
const KOJO_PATH = 'C:/corpus/sample/0001.kojo';

/** Monaco cancellation token 的最小面（宿主只读这两枚成员） */
const liveToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
const deadToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) };

/**
 * happy-dom 没有 canvas 2D（`getContext('2d')` 回 `null`）：Monaco 的渲染循环会在
 * `DecorationsOverviewRuler` 上抛"Cannot set properties of null"。本文件有三枚用例要真
 * editor（打字腿 / 合成期 / 桥），必须先给它一枚够用的 2D 上下文桩——**只桩 canvas**，
 * model / 版本 / 事件 / 注册表全是真的。
 */
function stubCanvasContext(): void {
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'measureText') return () => ({ width: 1 });
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as never);
}
stubCanvasContext();

registerBuiltinLanguageSurfaces(monaco);

const models: Monaco.editor.ITextModel[] = [];
const editors: Monaco.editor.IStandaloneCodeEditor[] = [];
const disposers: { dispose(): void }[] = [];
let uriSeq = 0;

/** 真 model（真版本号会随编辑前进——过期判据唯一依赖它） */
function makeModel(text = '\u7532\n', languageId = ERB_LANGUAGE_ID, path?: string): Monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, languageId, path !== undefined ? monaco.Uri.file(path) : monaco.Uri.parse(`inmemory://ic-host/${++uriSeq}`));
  models.push(model);
  return model;
}

function makeEditor(model: Monaco.editor.ITextModel): Monaco.editor.IStandaloneCodeEditor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ed = monaco.editor.create(host, { model });
  editors.push(ed);
  return ed;
}

/** 宿主事实默认一套（闸门全过），逐条覆盖即造出某一道路径 */
function factsOf(over: Partial<InlineCompletionFacts> = {}): InlineCompletionFacts {
  return {
    path: ERB_PATH,
    derivedView: false,
    readOnly: false,
    focused: true,
    multiCursor: false,
    selectionActive: false,
    project: null,
    ...over,
  };
}

interface FakeSource {
  readonly contribution: InlineCompletionSourceContribution;
  readonly calls: InlineCompletionRequest[];
}

/** 一家假候选源：记下每一次请求，回答由 answer 决定 */
function fakeSource(
  id: string,
  answer: (req: InlineCompletionRequest, round: number) => InlineCompletionOutcome | undefined | Promise<InlineCompletionOutcome | undefined>,
  order?: number,
): FakeSource {
  const calls: InlineCompletionRequest[] = [];
  const contribution: InlineCompletionSourceContribution = {
    id,
    title: `假源 ${id}`,
    ...(order === undefined ? {} : { order }),
    provideInline: async (req) => {
      calls.push(req);
      return answer(req, calls.length);
    },
  };
  return { contribution, calls };
}

/** 一条最普通的候选：空区间（幽灵文本的常见形状，插在光标处） */
function candidateOf(
  req: InlineCompletionRequest,
  text = '幽灵文本',
  over: Partial<InlineCompletionCandidate> = {},
): InlineCompletionCandidate {
  return {
    sourceId: `候选#${text}`,
    range: { startLine: req.line, startColumn: req.column, endLine: req.line, endColumn: req.column },
    insertText: text,
    ...over,
  };
}

const answersWith = (text?: string) => async (req: InlineCompletionRequest): Promise<InlineCompletionOutcome> => ({
  state: 'candidates',
  version: req.version,
  candidates: [candidateOf(req, text ?? '幽灵文本')],
});

/** 一次装配：真槽表 + 真注册表 + 观测口 */
interface Harness {
  readonly slots: SlotRegistryImpl;
  readonly reports: InlineCompletionReport[];
  readonly warns: string[];
  readonly infos: string[];
  register(source: InlineCompletionSourceContribution): () => void;
  install(model: Monaco.editor.ITextModel): Monaco.languages.InlineCompletionsProvider;
  ask(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    context?: Partial<Monaco.languages.InlineCompletionContext>,
    token?: unknown,
  ): Promise<Monaco.languages.InlineCompletions>;
  last(): InlineCompletionReport;
}

function harness(
  sources: readonly InlineCompletionSourceContribution[],
  options: {
    facts?: InlineCompletionFacts | null;
    enabled?: boolean;
    maxCandidates?: number;
    timeoutMs?: number;
    prefThrows?: boolean;
    /** `true` = 不装 observe 出口 ⇒ 走 console 那一条既有观测面（铁律 4 的读数） */
    viaConsole?: boolean;
  } = {},
): Harness {
  const slots = new SlotRegistryImpl();
  for (const s of sources) slots.register('completion.source', s, `plugin:${s.id}`);
  const reports: InlineCompletionReport[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '));
  });
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args.map((a) => String(a)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  disposers.push({
    dispose: () => {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    },
  });
  const deps: InlineCompletionHostDeps = {
    sources: () => slots.query('completion.source'),
    facts: () => ('facts' in options ? options.facts : factsOf()) ?? null,
    pref: {
      enabled: () => {
        if (options.prefThrows === true) throw new Error('偏好读取器坏了');
        return options.enabled !== false;
      },
      maxCandidates: () => options.maxCandidates ?? 5,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.viaConsole === true ? {} : { observe: (r) => reports.push(r) }),
  };
  const handle: { provider: Monaco.languages.InlineCompletionsProvider | null } = { provider: null };
  return {
    slots,
    reports,
    warns,
    infos,
    register: (source) => slots.register('completion.source', source, `plugin:${source.id}`),
    install: (model) => {
      const disp = installInlineCompletion(monaco, deps);
      disposers.push(disp);
      const provider = hostProviderOf(model);
      handle.provider = provider;
      return provider;
    },
    ask: async (model, position, context, token) => {
      const provider = handle.provider ?? hostProviderOf(model);
      const provide = provider.provideInlineCompletions as unknown as (
        m: Monaco.editor.ITextModel,
        p: Monaco.Position,
        c: Monaco.languages.InlineCompletionContext,
        t: unknown,
      ) => Promise<Monaco.languages.InlineCompletions>;
      return provide(model, position, {
        triggerKind: monaco.languages.InlineCompletionTriggerKind.Explicit,
        ...context,
      } as Monaco.languages.InlineCompletionContext, token ?? liveToken);
    },
    last: () => reports[reports.length - 1] as InlineCompletionReport,
  };
}

/** 真 vendor 注册表里把我们那一枚捞出来（注册没进去就直接红，不许靠内存假设） */
function registryProviders(model: Monaco.editor.ITextModel): Monaco.languages.InlineCompletionsProvider[] {
  const svc = StandaloneServices.get(ILanguageFeaturesService) as unknown as {
    inlineCompletionsProvider: { all: (m: Monaco.editor.ITextModel) => Monaco.languages.InlineCompletionsProvider[] };
  };
  return svc.inlineCompletionsProvider.all(model);
}

function hostProviderOf(model: Monaco.editor.ITextModel): Monaco.languages.InlineCompletionsProvider {
  const mine = registryProviders(model).filter(
    (p) => (p as unknown as { displayName?: string }).displayName === HOST_DISPLAY,
  );
  expect(
    mine.map((p) => (p as unknown as { provideInlineCompletions: unknown }).provideInlineCompletions),
    '宿主的 inline provider 在真注册表里应当恰好一枚（多出来 = 上一枚测试的 install 没拆干净）',
  ).toHaveLength(1);
  return mine[0] as Monaco.languages.InlineCompletionsProvider;
}

/** 真聚合器跑一次，交回 vendor 的 list（按 provider 归属过滤） */
async function vendorLists(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  context: Partial<Monaco.languages.InlineCompletionContext> = {},
): Promise<{ lists: any[]; items: any[]; dispose: (reason?: unknown) => void }> {
  const providers = registryProviders(model);
  const request = provideInlineCompletions(
    providers,
    position,
    model,
    { triggerKind: monaco.languages.InlineCompletionTriggerKind.Explicit, ...context },
    { editorType: 'textEditor', languageId: model.getLanguageId(), startTime: Date.now(), reason: 'explicit', typingInterval: 0, typingIntervalCharacterCount: 0, availableProviders: providers.length },
    undefined,
  );
  const lists: any[] = [];
  for await (const list of request.lists) lists.push(list);
  const items = lists.flatMap((l) => l.inlineSuggestionsData ?? []);
  return { lists, items, dispose: (reason?: unknown) => request.cancelAndDispose(reason) };
}

const explicitCtx = { triggerKind: monaco.languages.InlineCompletionTriggerKind.Explicit };
const autoCtx = { triggerKind: monaco.languages.InlineCompletionTriggerKind.Automatic };

/** 一次合成期按键护栏的真事件（KeyboardEvent 的最小面按 vendor 读的那几枚成员构造） */
function fireTab(container: HTMLElement, composing: boolean): { stopped: boolean; prevented: boolean } {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isComposing', { value: composing });
  Object.defineProperty(event, 'keyCode', { value: composing ? 229 : 9 });
  let reachedDocument = false;
  const probe = (): void => {
    reachedDocument = true;
  };
  document.addEventListener('keydown', probe);
  container.dispatchEvent(event);
  document.removeEventListener('keydown', probe);
  return { stopped: !reachedDocument, prevented: event.defaultPrevented };
}

beforeEach(() => {
  resetInlineCompletionTally();
  resetInlineCompletionWarningsForTests();
});

afterEach(() => {
  for (const d of disposers.splice(0)) d.dispose();
  for (const ed of editors.splice(0)) ed.dispose();
  for (const m of models.splice(0)) m.dispose();
});

/* ============================== A · 装配与真注册表 ============================== */

describe('A · 装配落在真 vendor 注册表上', () => {
  it('装好后 ERB / .kojo 两门一等语言各拿到一枚 provider；2.0 经 descriptor 声明位进门，plaintext 没有', () => {
    const erb = makeModel('CALL 甲\n');
    const kojo = makeModel('是 1\n', KOJO_LANGUAGE_ID);
    const kojo2 = makeModel('是 1\n', KOJO2_LANGUAGE_ID);
    const plain = makeModel('是 1\n', 'plaintext');
    const h = harness([]);
    h.install(erb);
    for (const model of [erb, kojo]) {
      expect(hostProviderOf(model)).toBeTruthy();
    }
    // LAU-KOJO2-INLINE（2026-10-31）：`.kojo2` 的 descriptor 点名了 `inlineCompletion: true` ⇒ 进门，
    // 与旧桥两门同挂一枚宿主 provider（此前是能力缺口，故断言 0；声明位到位后这里必须读到 1）。
    expect(registryProviders(kojo2).filter((p) => (p as any).displayName === HOST_DISPLAY)).toHaveLength(1);
    expect(registryProviders(plain).filter((p) => (p as any).displayName === HOST_DISPLAY)).toHaveLength(0);
  });

  it('宿主不注册任何键位 / 不加动作 / 不挂命令（Tab 归三家这一判据的结构保证）', () => {
    // 键位面不许被这一条腿碰：一碰就是一次"抢 Tab"。判据按源码文本钉（删掉注释不算，
    // 真加一行 addAction / addKeybindingRule 立刻红），运行时那一半在 §H 与调试宿的 Tab 读数里。
    const source = readFileSync(hostSourcePath, 'utf8');
    for (const forbidden of ['addAction(', 'addKeybindingRule(', 'addCommand(', 'registerCommand(', 'preventDefault(', 'stopPropagation(', 'KeyChord.', 'KeyCode.Tab']) {
      expect(source, `宿主接线层不许碰键位面：出现了 ${forbidden}`).not.toContain(forbidden);
    }
    // 真 editor 上 `editor.action.inlineSuggest.commit` 的缺省归属没被我们改动（vendor 那张表）
    const model = makeModel();
    const h = harness([]);
    h.install(model);
    const ed = makeEditor(model);
    expect(ed.getAction('editor.action.inlineSuggest.commit')?.id).toBe('editor.action.inlineSuggest.commit');
  });

  it('句柄 dispose 后注册表里不再留下宿主那一枚（装配点交回的是整批回收）', () => {
    const model = makeModel();
    const slots = new SlotRegistryImpl();
    const disp = installInlineCompletion(monaco, {
      sources: () => slots.query('completion.source'),
      facts: () => factsOf(),
      pref: { enabled: () => true, maxCandidates: () => 5 },
      observe: () => undefined,
    });
    expect(hostProviderOf(model)).toBeTruthy();
    disp.dispose();
    expect(registryProviders(model).filter((p) => (p as any).displayName === HOST_DISPLAY)).toHaveLength(0);
  });
});

/* ============================== B · 真 vendor 通道端到端 ============================== */

describe('B · 候选经真 provider 落到模型（vendor 聚合器亲测）', () => {
  it('真聚合器交回的 InlineSuggestData 就是接受键要落的那一笔，落到真 model 上文本正确', async () => {
    const model = makeModel('CALL 甲\n');
    const src = fakeSource('s1', answersWith('幽灵文本'));
    const h = harness([src.contribution]);
    h.install(model);
    const position = new monaco.Position(1, 7);
    const { lists, items } = await vendorLists(model, position);
    const mine = lists.filter((l) => (l.provider as any)?.displayName === HOST_DISPLAY);
    expect(mine).toHaveLength(1);
    expect(items).toHaveLength(1);
    const action = items[0].action;
    expect(action.kind).toBe('edit');
    expect(action.insertText).toBe('幽灵文本');
    expect([action.range.startLineNumber, action.range.startColumn, action.range.endLineNumber, action.range.endColumn]).toEqual([1, 7, 1, 7]);
    // 接受键落下去的就是这一笔（vendor 交回的 range + insertText，宿主不另造第二套表示）
    model.applyEdits([{ range: action.range, text: action.insertText }]);
    expect(model.getValue()).toBe('CALL 甲幽灵文本\n');
    expect(h.reports).toHaveLength(1);
    expect(h.last().answeredBy).toBe('候选#幽灵文本');
    expect(h.last().shown).toBe(1);
  });

  it('第 0 条 = 接受键拿到的那一条：宿主不重排（三家给的顺序原样穿过 vendor）', async () => {
    const model = makeModel('甲\n');
    const src = fakeSource('s1', async (req) => ({
      state: 'candidates',
      version: req.version,
      candidates: [candidateOf(req, '丙'), candidateOf(req, '乙'), candidateOf(req, '甲序')],
    }));
    const h = harness([src.contribution]);
    h.install(model);
    const { items } = await vendorLists(model, new monaco.Position(1, 2));
    expect(items.map((d: any) => d.action.insertText)).toEqual(['丙', '乙', '甲序']);
  });

  it('note 原文跟着候选走（vendor 的 hint.content 一字不改），C 车道只欠观感', async () => {
    const model = makeModel('甲\n');
    const note = '来自字典：好感度';
    const src = fakeSource('s1', async (req) => ({
      state: 'candidates',
      version: req.version,
      candidates: [candidateOf(req, '好感度', { note })],
    }));
    const h = harness([src.contribution]);
    h.install(model);
    const { items } = await vendorLists(model, new monaco.Position(1, 2));
    expect(items[0].hint.content).toBe(note);
    expect(items[0].hint.style).toBe(monaco.languages.InlineCompletionHintStyle.Label);
  });

  it('vendor 按 disposeInlineCompletions 回收批次：取消这一拍时我们的批次被叫到', async () => {
    const model = makeModel('甲\n');
    const src = fakeSource('s1', answersWith());
    let disposed = 0;
    const slots = new SlotRegistryImpl();
    slots.register('completion.source', src.contribution, 'p');
    const deps: InlineCompletionHostDeps = {
      sources: () => slots.query('completion.source'),
      facts: () => factsOf(),
      pref: { enabled: () => true, maxCandidates: () => 5 },
      observe: () => undefined,
    };
    const disp = installInlineCompletion(monaco, deps);
    disposers.push(disp);
    const provider = hostProviderOf(model);
    const spy = vi.spyOn(provider, 'disposeInlineCompletions');
    const { dispose } = await vendorLists(model, new monaco.Position(1, 2));
    dispose({ kind: 'other' });
    disposed = spy.mock.calls.length;
    expect(disposed).toBeGreaterThanOrEqual(1);
  });

  it('没有候选时交回空批次：vendor 手里一条可接受的候选都没有 ⇒ 键位面与接线前一致', async () => {
    const model = makeModel('甲\n');
    const src = fakeSource('s1', () => undefined);
    const h = harness([src.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result).toEqual({ items: [] });
    const { lists, items } = await vendorLists(model, new monaco.Position(1, 2));
    const mine = lists.filter((l) => (l.provider as any)?.displayName === HOST_DISPLAY);
    // 空批次照样成 list（vendor 只在 `!result` 时整条丢），但**一条候选都没有**
    // ⇒ 没有 InlineSuggestData ⇒ 没有可接受的幽灵文本 ⇒ `inlineSuggestionVisible` 不成立
    expect(mine).toHaveLength(1);
    expect(mine[0].inlineSuggestions.items).toHaveLength(0);
    expect(items).toHaveLength(0);
    expect(model.getValue()).toBe('甲\n'); // 一个字节都没写
  });
});

/* ============================== C · 三态与"第一家说了算" ============================== */

describe('C · 三态 / 逐家问 / 出声（宿主 provider 亲调）', () => {
  it('第一家给出 candidates ⇒ 第二家一次都不被问', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', answersWith('甲候选'));
    const b = fakeSource('b', answersWith('乙候选'));
    const h = harness([a.contribution, b.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result.items).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(h.last()).toMatchObject({ asked: 1, answeredBy: '候选#甲候选', gateSkipped: null });
  });

  it('order 决定问的顺序：order 小的先问（真槽表排序，不是数组顺序）', async () => {
    const model = makeModel('甲\n');
    const late = fakeSource('late', answersWith('后'), 50);
    const early = fakeSource('early', answersWith('先'), 1);
    const h = harness([late.contribution, early.contribution]);
    h.install(model);
    await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(early.calls).toHaveLength(1);
    expect(late.calls).toHaveLength(0);
  });

  it('undefined（弃权）：继续问下一家、记 abstained、不弹不报错', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', () => undefined);
    const b = fakeSource('b', answersWith('乙候选'));
    const h = harness([a.contribution, b.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result.items).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(h.last()).toMatchObject({ asked: 2, abstained: 1, noCompletion: 0, failed: 0, violations: 0 });
    expect(h.warns).toEqual([]);
  });

  it('no-completion（看过并确认没有）：记账、继续问下一家、不出声', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', () => ({ state: 'no-completion' }));
    const b = fakeSource('b', () => ({ state: 'no-completion' }));
    const h = harness([a.contribution, b.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result).toEqual({ items: [] });
    expect(h.last()).toMatchObject({ asked: 2, abstained: 0, noCompletion: 2, failed: 0, answeredBy: null });
    expect(h.warns).toEqual([]); // "看过没有"不是违规，不该 warn
    expect(h.reports).toHaveLength(1);
  });

  it('failed（这一家缺席）：note 原文出声一次、继续问下一家、仍不弹不报错', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', () => ({ state: 'failed', stage: 'transport', reason: 'timeout', note: '模型没接上' }));
    const b = fakeSource('b', () => ({ state: 'no-completion' }));
    const h = harness([a.contribution, b.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result).toEqual({ items: [] });
    expect(h.last()).toMatchObject({ asked: 2, failed: 1, answeredBy: null });
    expect(h.warns.join('\n')).toContain('模型没接上');
    expect(h.warns.join('\n')).toContain('transport');
  });

  it('不给 observe 出口 ⇒ 走 console 那一条既有观测面：看过没有 / 失败都不静默（铁律 4）', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', () => ({ state: 'no-completion' }));
    const b = fakeSource('b', () => ({ state: 'failed', stage: 'decode', reason: 'r', note: '解不开' }));
    const h = harness([a.contribution, b.contribution], { viaConsole: true });
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result).toEqual({ items: [] });
    expect(h.reports).toHaveLength(0);
    expect(h.infos.join('\n')).toContain('看过没有 1');
    expect(h.infos.join('\n')).toContain('失败 1');
    expect(h.warns.join('\n')).toContain('解不开'); // 失败的话要说出去
  });

  it('全弃权（一家都没看过）⇒ console 一条都不上（"没看过"不记账）', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', () => undefined);
    const h = harness([a.contribution], { viaConsole: true });
    h.install(model);
    await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(h.infos).toEqual([]);
    expect(h.warns).toEqual([]);
  });

  it('空 candidates 数组 = 契约违规：出声 + 丢弃 + 继续问下一家（绝不当成 no-completion）', async () => {
    const model = makeModel('甲\n');
    const bad = fakeSource('bad', (req) => ({ state: 'candidates', version: req.version, candidates: [] }));
    const good = fakeSource('good', answersWith('好候选'));
    const h = harness([bad.contribution, good.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result.items).toHaveLength(1);
    expect(h.last()).toMatchObject({ violations: 1, failed: 0, noCompletion: 0, asked: 2 });
    expect(h.warns.join('\n')).toContain('空的 candidates 数组');
  });

  it('provideInline 抛错 = 违约：计 failed + 出声 + 整条链不抛进 Monaco 的供给路径', async () => {
    const model = makeModel('甲\n');
    const boom = fakeSource('boom', () => {
      throw new Error('供方炸了');
    });
    const good = fakeSource('good', answersWith('好候选'));
    const h = harness([boom.contribution, good.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result.items).toHaveLength(1);
    expect(h.last()).toMatchObject({ failed: 1, asked: 2 });
    expect(h.warns.join('\n')).toContain('供方炸了');
  });

  it('超预算：宿主判超时并丢弃这一次（供方稍后落地也没观众），继续问下一家', async () => {
    const model = makeModel('甲\n');
    const slow = fakeSource('slow', async (req) => {
      await new Promise((r) => setTimeout(r, 60));
      return { state: 'candidates', version: req.version, candidates: [candidateOf(req, '迟到的')] };
    });
    const quick = fakeSource('quick', answersWith('备用的'));
    const h = harness([slow.contribution, quick.contribution], { timeoutMs: 15 });
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result.items.map((i) => i.insertText)).toEqual(['备用的']);
    expect(h.last()).toMatchObject({ failed: 1, asked: 2 });
    expect(h.warns.join('\n')).toContain('超出 15ms 预算');
  });

  it('计数对平：asked 恒等于真实被调用过的家数（三家混答）', async () => {
    const model = makeModel('甲\n');
    const a = fakeSource('a', () => undefined);
    const b = fakeSource('b', () => ({ state: 'no-completion' }));
    const c = fakeSource('c', () => ({ state: 'failed', stage: 'fetch', reason: 'r', note: 'n' }));
    const d = fakeSource('d', answersWith());
    const h = harness([a.contribution, b.contribution, c.contribution, d.contribution]);
    h.install(model);
    await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    const calls = [a, b, c, d].reduce((n, s) => n + s.calls.length, 0);
    const r = h.last();
    expect(r.asked).toBe(calls);
    expect(r.asked).toBe(r.abstained + r.noCompletion + r.failed + 1);
    expect(getInlineCompletionTally()).toMatchObject({ requests: 1, asked: 4, abstained: 1, noCompletion: 1, failed: 1, answered: 1 });
  });

  it('同一句违规只报第一次（不许逐键刷屏），但每次都记账', async () => {
    const model = makeModel('甲\n');
    const bad = fakeSource('bad', (req) => ({ state: 'candidates', version: req.version, candidates: [] }));
    const h = harness([bad.contribution]);
    h.install(model);
    await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(h.warns.filter((w) => w.includes('空的 candidates'))).toHaveLength(1);
    expect(getInlineCompletionTally().violations).toBe(2);
  });
});

/* ============================== D · 版本 / 过期 / 取消 ============================== */

describe('D · 过期只有一条判据（version）', () => {
  it('供方回带 version 不等 ⇒ 整批丢弃 + 出声带 sourceId + 计违规', async () => {
    const model = makeModel('甲\n');
    const liar = fakeSource('liar', (req) => ({
      state: 'candidates',
      version: req.version + 1,
      candidates: [candidateOf(req, '旧文本算的')],
    }));
    const h = harness([liar.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(result).toEqual({ items: [] });
    expect(h.last()).toMatchObject({ staleDrops: 1, violations: 1, answeredBy: null, shown: 0 });
    expect(h.warns.join('\n')).toContain('按契约违规丢弃');
  });

  it('model 版本在异步期间前进 ⇒ 整批丢弃并就地重问一次（第二次带的是当下版本）', async () => {
    const model = makeModel('甲\n');
    const lazy = fakeSource('lazy', async (req, round) => {
      if (round === 1) {
        // 供方算结果的这一拍，作者又敲了一个字（真 model 的真版本前进）
        model.applyEdits([{ range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, text: '乙' }]);
      }
      return { state: 'candidates', version: req.version, candidates: [candidateOf(req, `第${round}轮`)] };
    });
    const h = harness([lazy.contribution]);
    h.install(model);
    const before = model.getVersionId();
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(lazy.calls).toHaveLength(2);
    expect(lazy.calls[0]!.version).toBe(before);
    expect(lazy.calls[1]!.version).toBe(model.getVersionId());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.insertText).toBe('第2轮');
    expect(h.last()).toMatchObject({ staleDrops: 1, answeredBy: '候选#第2轮' });
  });

  it('重问后又过期 ⇒ 不再重问（上限写死），交回空批次', async () => {
    const model = makeModel('甲\n');
    const churn = fakeSource('churn', async (req, round) => {
      model.applyEdits([{ range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, text: `x${round}` }]);
      return { state: 'candidates', version: req.version, candidates: [candidateOf(req, '永不新鲜')] };
    });
    const h = harness([churn.contribution]);
    h.install(model);
    const result = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(INLINE_STALE_REASK_LIMIT).toBe(1);
    expect(churn.calls).toHaveLength(1 + INLINE_STALE_REASK_LIMIT);
    expect(result).toEqual({ items: [] });
    // 两次都不新鲜：第一批 + 重问那一批各丢弃一次，但**只重问一次**（上限写死）
    expect(h.last().staleDrops).toBe(1 + INLINE_STALE_REASK_LIMIT);
  });

  it('重问那一拍交回的是**当下**文本：旧字面配新 version 的谎不许出现', async () => {
    const model = makeModel('CALL 甲\n');
    const spy = fakeSource('spy', async (req, round) => {
      if (round === 1) {
        model.applyEdits([{ range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8 }, text: '乙' }]);
      }
      return { state: 'candidates', version: req.version, candidates: [candidateOf(req, '候选')] };
    });
    const h = harness([spy.contribution]);
    h.install(model);
    await h.ask(model, new monaco.Position(1, 8), explicitCtx);
    expect(spy.calls[0]!.lineText).toBe('CALL 甲');
    expect(spy.calls[1]!.lineText).toBe('CALL 乙');
    expect(spy.calls[1]!.suffix).toBe('');
  });

  it('token 已取消 ⇒ 一次都不问（already-cancelled）；问完才取消 ⇒ 记 cancelled 且不重复播报', async () => {
    const model = makeModel('甲\n');
    const slow = fakeSource('slow', async (req) => {
      await new Promise((r) => setTimeout(r, 30));
      return { state: 'candidates', version: req.version, candidates: [candidateOf(req, '迟到')] };
    });
    const h = harness([slow.contribution]);
    h.install(model);
    const r1 = await h.ask(model, new monaco.Position(1, 2), explicitCtx, deadToken);
    expect(r1).toEqual({ items: [] });
    expect(h.last().gateSkipped).toBe('already-cancelled');
    expect(slow.calls).toHaveLength(0);

    let abort: () => void = () => undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (fn: () => void) => {
        abort = fn;
        return { dispose: () => undefined };
      },
    };
    const pending = h.ask(model, new monaco.Position(1, 2), explicitCtx, token);
    abort();
    const r2 = await pending;
    expect(r2).toEqual({ items: [] });
    expect(h.last().gateSkipped).toBe('cancelled');
    expect(h.last().notes ?? []).toEqual([]); // 被叫停的一次不再播报
    expect(h.warns).toEqual([]);
  });

  it('请求组装的字段逐项对契约（宿主算全部事实、零切词、窗与预算住宿主）', async () => {
    const model = makeModel('上一行\nCALL 甲 尾\n下一行\n');
    const src = fakeSource('s', answersWith());
    const h = harness([src.contribution], { facts: factsOf({ project: { rootDir: 'C:/corpus/sample', adapterId: 'era' } as never }) });
    h.install(model);
    await h.ask(model, new monaco.Position(2, 7), explicitCtx);
    const req = src.calls[0]!;
    expect(req).toMatchObject({
      path: ERB_PATH,
      languageId: ERB_LANGUAGE_ID,
      line: 2,
      column: 7,
      lineText: 'CALL 甲 尾',
      prefix: 'CALL 甲',
      suffix: ' 尾',
      project: { rootDir: 'C:/corpus/sample' },
      lineCount: 4,
      triggerKind: 'explicit',
      timeoutMs: INLINE_REQUEST_TIMEOUT_MS,
    });
    expect(req.version).toBe(model.getVersionId());
    expect(req.triggerCharacter).toBeUndefined(); // 显式触发没有"刚敲下的那一枚"
    expect(req.contextBefore).toContain('上一行');
    expect(req.contextAfter).toContain('下一行');
    expect(typeof req.signal?.aborted).toBe('boolean');
  });

  it('auto 一拍由打字腿供 triggerCharacter（宿主原样递来、不判定）', async () => {
    const model = makeModel('');
    const ed = makeEditor(model);
    const src = fakeSource('s', answersWith());
    const h = harness([src.contribution]);
    h.install(model);
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.trigger('test', 'type', { text: '甲' });
    await new Promise((r) => setTimeout(r, 0));
    const result = await h.ask(model, ed.getPosition()!, autoCtx);
    expect(result.items).toHaveLength(1);
    expect(src.calls[0]!.triggerKind).toBe('auto');
    expect(src.calls[0]!.triggerCharacter).toBe('甲');
    expect(typedCharAt(model, model.getVersionId())).toBe('甲');
  });
});

/* ============================== E · 闸门逐条（宿主侧沉默 = 一次都不问） ============================== */

describe('E · 十二道闸的宿主对面：挡下时一家都不问', () => {
  /** 造一次"闸门挡下"的读数：断言 gate 名 + 零调用 + 空批次 */
  async function gateCase(
    gate: string,
    options: Parameters<typeof harness>[1],
    run: (h: Harness, model: Monaco.editor.ITextModel, position: Monaco.Position) => Promise<unknown>,
    languageId = ERB_LANGUAGE_ID,
    text = '甲\n',
  ): Promise<void> {
    resetInlineCompletionTally();
    resetInlineCompletionWarningsForTests();
    const model = makeModel(text, languageId);
    const src = fakeSource('never', answersWith());
    const h = harness([src.contribution], options);
    h.install(model);
    await run(h, model, new monaco.Position(1, 2));
    const r = h.last();
    expect(r.gateSkipped, `闸门名应当是 ${gate}`).toBe(gate);
    expect(r.asked).toBe(0);
    expect(src.calls).toHaveLength(0);
    expect(getInlineCompletionTally().gateSkips[gate]).toBe(1);
    expect(h.warns).toEqual([]);
  }

  it('总开关关（第二道闸）：provider 一次都不被调用——不是"问了再丢"', () =>
    gateCase('pref-disabled', { enabled: false }, async (h, model, position) => {
      await h.ask(model, position, explicitCtx);
    }));

  it('偏好读取器抛错 ⇒ 按"开"处理（脏偏好不许把整条链静默）', async () => {
    const model = makeModel('甲\n');
    const src = fakeSource('s', answersWith());
    const h = harness([src.contribution], { prefThrows: true });
    h.install(model);
    await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(src.calls).toHaveLength(1);
  });

  it('Monaco 这一拍只要内联改写 ⇒ 不白问（not-completions-requested）', () =>
    gateCase('not-completions-requested', {}, async (h, model, position) => {
      await h.ask(model, position, { ...explicitCtx, includeInlineCompletions: false });
    }));

  it('这份 model 宿主不认（隐藏池 / 别的应用面）⇒ unknown-model', () =>
    gateCase('unknown-model', { facts: null }, async (h, model, position) => {
      await h.ask(model, position, explicitCtx);
    }));

  it.each([
    ['①没打开文件', { path: null }],
    ['②只读', { readOnly: true }],
    ['③派生视图（糖预览 / 投影）', { derivedView: true }],
    ['④编辑器无焦点', { focused: false }],
    ['⑤多光标', { multiCursor: true }],
    ['⑤有选区', { selectionActive: true }],
  ])('共用闸（与弹窗同一份判据）%s ⇒ shared-gates', (_label, over) =>
    gateCase('shared-gates', { facts: factsOf(over as Partial<InlineCompletionFacts>) }, async (h, model, position) => {
      await h.ask(model, position, explicitCtx);
    }));

  it('⑥ 的对面：弹窗可见（selectedSuggestionInfo 有值）⇒ 这一条腿整条沉默，Tab 归弹窗', () =>
    gateCase('suggest-widget-visible', {}, async (h, model, position) => {
      await h.ask(model, position, {
        ...explicitCtx,
        // vendor 的公开类（`monaco.SelectedSuggestionInfo`，字段取 `editor.api.d.ts:7629`）
        selectedSuggestionInfo: new monaco.languages.SelectedSuggestionInfo(
          new monaco.Range(1, 1, 1, 3),
          '好感度',
          monaco.languages.CompletionItemKind.Variable,
          false,
        ),
      });
    }));

  it('⑦ 的对面：这一拍不是"刚敲下的一枚字符" ⇒ not-just-typed（显式触发是唯一例外）', () =>
    gateCase('not-just-typed', {}, async (h, model, position) => {
      await h.ask(model, position, autoCtx);
    }));

  it('.kojo 的台词 / 旁白 / 注释行一律不弹幽灵文本（语言侧代码位门）', async () => {
    const lines = ['你好吗', '「她在说话」', '; 这是注释', '♥心形台词♥'];
    const src = fakeSource('never', answersWith());
    const h = harness([src.contribution]);
    let installed = false;
    for (const line of lines) {
      const model = makeModel(`${line}\n`, KOJO_LANGUAGE_ID);
      if (!installed) {
        h.install(model);
        installed = true;
      }
      await h.ask(model, new monaco.Position(1, line.length + 1), explicitCtx);
      expect(h.last().gateSkipped, `台词 / 旁白 / 注释位不该弹：${line}`).toBe('non-code-position');
      expect(src.calls).toHaveLength(0);
    }
  });

  it('.kojo 的代码位照常放行（对照：门不是"整门语言都不弹"）', async () => {
    const model = makeModel('调用 ', KOJO_LANGUAGE_ID);
    const src = fakeSource('s', answersWith());
    const h = harness([src.contribution]);
    h.install(model);
    await h.ask(model, new monaco.Position(1, 4), explicitCtx);
    expect(h.last().gateSkipped).toBeNull();
    expect(src.calls).toHaveLength(1);
    expect(src.calls[0]!.languageId).toBe(KOJO_LANGUAGE_ID);
  });

  it('ERB 字符串内不弹幽灵文本（与弹窗那条腿同一枚判据）', async () => {
    const model = makeModel('@X = "字符串内"\n');
    const src = fakeSource('never', answersWith());
    const h = harness([src.contribution]);
    h.install(model);
    await h.ask(model, new monaco.Position(1, 9), explicitCtx);
    expect(h.last().gateSkipped).toBe('non-code-position');
    expect(src.calls).toHaveLength(0);
  });
});

/* ============================== F · 打字腿与合成期（真编辑器 + 真事件） ============================== */

describe('F · 打字腿 / IME 合成期（真 editor 的事件腿）', () => {
  it('删除 / 粘贴 / 整篇替换不是"刚敲下的一枚字符"：腿作废 ⇒ not-just-typed', async () => {
    const model = makeModel('甲\n');
    const ed = makeEditor(model);
    const src = fakeSource('never', answersWith());
    const h = harness([src.contribution]);
    h.install(model);
    ed.setPosition({ lineNumber: 1, column: 2 });
    ed.trigger('test', 'type', { text: '乙' });
    expect(typedCharAt(model, model.getVersionId())).toBe('乙');
    // 一次两字符的插入（粘贴的形状）
    ed.executeEdits('test-paste', [{ range: new monaco.Range(1, 2, 1, 2), text: '丙丁' }]);
    expect(typedCharAt(model, model.getVersionId())).toBeNull();
    await h.ask(model, ed.getPosition()!, autoCtx);
    expect(h.last().gateSkipped).toBe('not-just-typed');
    expect(src.calls).toHaveLength(0);
  });

  // 闸门 ⑫（输入法合成期）的**事实源**是 Monaco 公开的那对事件（onDidCompositionStart /
  // onDidCompositionEnd），宿主只把它折成 `composing` 递给 `sharedSuggestGates`——而 happy-dom
  // 里合成事件进不了 Monaco 的输入面（真 editor 实测：dispatch compositionstart 后
  // `onDidCompositionStart` 一次都不 fire）。所以这一条在本文件里钉"两半"：
  //   ① 判据本身（composing ⇒ false）在 `inline-completion-single-source.test.ts` 逐条钉；
  //   ② 按键护栏（合成期 Tab/Enter/Esc 整拍不进命令面）用真 DOM 事件在下面钉；
  //   ③ "合成期真的不弹幽灵文本"要真浏览器 ⇒ 调试宿读数（提交信息里带）。
  it('合成期之外：打字腿仍然只认单字符纯插入（成串上字 = 粘贴/IME 提交，一律作废）', async () => {
    const model = makeModel('甲\n');
    const ed = makeEditor(model);
    const src = fakeSource('never', answersWith());
    const h = harness([src.contribution]);
    h.install(model);
    ed.setPosition({ lineNumber: 1, column: 2 });
    ed.executeEdits('test-composition-commit', [{ range: new monaco.Range(1, 2, 1, 2), text: '拼音' }]);
    expect(typedCharAt(model, model.getVersionId())).toBeNull();
    await h.ask(model, ed.getPosition()!, autoCtx);
    expect(h.last().gateSkipped).toBe('not-just-typed');
    expect(src.calls).toHaveLength(0);
    ed.trigger('test', 'type', { text: '好' });
    expect(typedCharAt(model, model.getVersionId())).toBe('好');
    await h.ask(model, ed.getPosition()!, autoCtx);
    expect(h.last().gateSkipped).toBeNull();
    expect(src.calls[0]!.triggerCharacter).toBe('好');
  });

  it('IME 合成期按 Tab：容器 capture 的护栏把这一拍从命令面摘掉，且**不** preventDefault', async () => {
    const model = makeModel('甲\n');
    const ed = makeEditor(model);
    const host = ed.getDomNode()!.parentElement ?? ed.getDomNode()!;
    const trigger = installSuggestContextTrigger(ed, { getPath: () => ERB_PATH, isDerivedView: () => false });
    disposers.push(trigger);
    const ta = ed.getDomNode()!.querySelector('textarea')!;
    ta.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    const during = fireTab(host, true);
    expect(during.stopped).toBe(true); // 整拍不派发 ⇒ inlineSuggest.commit 与 acceptSelectedSuggestion 一起被挡
    expect(during.prevented).toBe(false); // 输入法的选词默认行为不许被吞
    ta.dispatchEvent(new Event('compositionend', { bubbles: true }));
    const after = fireTab(host, false);
    expect(after.stopped).toBe(false); // 非合成期原样放行 ⇒ 作者那一下仍是 Monaco 自己的键位
    expect(after.prevented).toBe(false);
  });
});

/* ============================== G · 纯函数（夹取 / 去重 / 截断 / 窗 / 预算） ============================== */

describe('G · 候选换算与请求组装的纯判据', () => {
  const req = (over: Partial<InlineCompletionRequest> = {}): InlineCompletionRequest => ({
    path: ERB_PATH,
    languageId: ERB_LANGUAGE_ID,
    version: 1,
    line: 1,
    column: 1,
    lineText: '',
    prefix: '',
    suffix: '',
    contextBefore: '',
    contextAfter: '',
    project: null,
    triggerKind: 'explicit',
    timeoutMs: INLINE_REQUEST_TIMEOUT_MS,
    ...over,
  });

  it('askSources：没有一家 ⇒ outcome null + asked 等于家数（纯函数口径与 provider 一致）', async () => {
    const a = fakeSource('a', () => undefined);
    const b = fakeSource('b', () => ({ state: 'no-completion' }));
    const r = await askSources([a.contribution, b.contribution], req());
    expect(r.outcome).toBeNull();
    expect(r).toMatchObject({ asked: 2, abstained: 1, noCompletion: 1, failed: 0, violations: 0 });
  });

  it('时间预算：未给 = 缺省；脏值不抛；夹到 1–上限', () => {
    expect(clampRequestTimeout(undefined)).toBe(INLINE_REQUEST_TIMEOUT_MS);
    expect(clampRequestTimeout(Number.NaN)).toBe(INLINE_REQUEST_TIMEOUT_MS);
    expect(clampRequestTimeout(0)).toBe(1);
    expect(clampRequestTimeout(-5)).toBe(1);
    expect(clampRequestTimeout(99_000)).toBe(INLINE_REQUEST_TIMEOUT_MAX_MS);
  });

  it('上下文窗：行数与字符数**都要夹**，且从靠光标那一头留', () => {
    const model = makeModel('1\n2\n3\n4\n5\n');
    // 光标所在行被拆成两半分别进两侧窗口（col 1 ⇒ 前半为空）
    expect(contextWindowOf(model, 3, 1, 2, 100)).toEqual({ before: '2\n', after: '3\n4' });
    expect(contextWindowOf(model, 3, 2, 2, 100).before).toBe('2\n3');
    const win = contextWindowOf(model, 3, 1, 99, 2);
    expect(win.before.length).toBeLessThanOrEqual(2);
    expect(win.after.length).toBeLessThanOrEqual(2);
    model.dispose();
    // 越界行 / 列不抛（夹到边界）：末行是那个尾空行，窗口照旧把**上一行**收进 before
    const m2 = makeModel('甲\n');
    const w2 = contextWindowOf(m2, 99, 99, 4, 40);
    expect(w2.before).toBe('甲\n');
    expect(w2.after).toBe('');
  });

  it('候选区间夹取：越界行列夹到边界、非跨行的终点折回起点行、跨行的终点夹到行尾', () => {
    const model = makeModel('一二三\n四五六');
    const base = { sourceId: 'x', insertText: '单行' };
    expect(clampCandidateRange({ ...base, range: { startLine: 99, startColumn: 99, endLine: 1, endColumn: 1 } }, model)).toEqual({
      startLineNumber: 2,
      startColumn: 4,
      endLineNumber: 2,
      endColumn: 4,
    });
    expect(clampCandidateRange({ ...base, range: { startLine: 1, startColumn: 2, endLine: 2, endColumn: 9 } }, model)).toEqual({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 4,
    });
    const multi = clampCandidateRange(
      { sourceId: 'x', insertText: '跨\n行', range: { startLine: 1, startColumn: 2, endLine: 2, endColumn: 99 } },
      model,
    );
    expect(multi.endLineNumber).toBe(2);
    expect(multi.endColumn).toBe(model.getLineMaxColumn(2));
  });

  it('夹取 + 去重 + 截断，**不重排**；截了多少要说得出', () => {
    const model = makeModel('甲乙\n');
    const cand = (text: string, col = 2): InlineCompletionCandidate => ({
      sourceId: `s/${text}`,
      range: { startLine: 1, startColumn: col, endLine: 1, endColumn: col },
      insertText: text,
    });
    const mapped = toMonacoInlineCompletions([cand('丙'), cand('乙'), cand('丙'), cand('丁')], model, 2, 2);
    expect(mapped.items.map((i) => i.insertText)).toEqual(['丙', '乙']);
    expect(mapped.shown).toBe(2);
    expect(toMonacoInlineCompletions([cand('')], model, 5, 2).items).toEqual([]);
    expect(toMonacoInlineCompletions([cand('戊')], model, Number.NaN, 2).items).toHaveLength(1); // 脏上限回落缺省
  });

  it('上限来自宿主偏好：候选被截时那一句话说得出', async () => {
    const model = makeModel('甲\n');
    const src = fakeSource('s', async (req) => ({
      state: 'candidates',
      version: req.version,
      candidates: [candidateOf(req, '一'), candidateOf(req, '二'), candidateOf(req, '三')],
    }));
    const h = harness([src.contribution], { maxCandidates: 2 });
    h.install(model);
    const r = await h.ask(model, new monaco.Position(1, 2), explicitCtx);
    expect(r.items).toHaveLength(2);
    expect(h.last().shown).toBe(2);
    expect(h.warns.join('\n')).toContain('按上限 2 截断');
  });

  it('宿主缺省上限与偏好模块同值（两处不许漂）', () => {
    expect(INLINE_MAX_CANDIDATES_FALLBACK).toBe(5);
  });
});

/* ============================== H · entry.ts:111 那条桥 ============================== */

describe('H · suggest→inline 的桥恒空转（quickSuggestions 是布尔）', () => {
  it('机制：vendor 的 valueFor 对本仓三档一律给不出 \'inline\'', () => {
    const config = quickSuggestionsFor(false, true) as Record<string, unknown>;
    expect(config).toEqual(QUICK_SUGGESTIONS);
    for (const tokenType of [0, 1, 2]) {
      expect(QuickSuggestionsOptions.valueFor(config, tokenType)).not.toBe('inline');
    }
    expect(QUICK_SUGGESTIONS).toEqual({ other: true, comments: false, strings: false });
  });

  it('反证：字符串 \'inline\' 是唯一会让桥出货的取值（本仓不给 ⇒ 桥不投候选）', () => {
    expect(QuickSuggestionsOptions.valueFor({ other: 'inline', comments: 'inline', strings: 'inline' } as never, 0)).toBe('inline');
    expect(QUICK_SUGGESTIONS.other).not.toBe('inline');
  });

  it('行为：真桥 provider 在真 editor + 真 model + 本仓选项值下交回 undefined', async () => {
    const model = makeModel('CALL 甲\n');
    const ed = makeEditor(model);
    ed.updateOptions({ quickSuggestions: quickSuggestionsFor(false, true) });
    const h = harness([]);
    h.install(model);
    const bridge = registryProviders(model).find(
      (p) => (p as unknown as { displayName?: string }).displayName !== HOST_DISPLAY,
    );
    expect(bridge, 'vendor 的桥应当也在这张真注册表里（本仓没删它）').toBeTruthy();
    const out = await (bridge as any).provideInlineCompletions(
      model,
      new monaco.Position(1, 7),
      explicitCtx,
      liveToken,
    );
    expect(out === undefined || (out.items?.length ?? 0) === 0).toBe(true);
  });

  it('关掉幽灵文本偏好时 Monaco 那一侧的选项补丁确实写 enabled:false（一次都不问的机制）', () => {
    expect(inlineSuggestPatch(false, 0)).toEqual({ inlineSuggest: { enabled: false, minShowDelay: 0 } });
    expect(inlineSuggestPatch(true, 300)).toEqual({ inlineSuggest: { enabled: true, minShowDelay: 300 } });
  });
});
