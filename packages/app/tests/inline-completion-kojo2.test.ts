// @vitest-environment happy-dom
/**
 * LAU-KOJO2-INLINE（2026-10-31）· `.kojo2` 的**行内续写进门**自证（真 Monaco 那条腿）。
 *
 * 派工单要求"补全类改动必须经真 Monaco 自证"，本文件照 `inline-completion-host.test.ts`
 * 的先例用**真 vendor**：注册从 `ILanguageFeaturesService.inlineCompletionsProvider.all(model)`
 * **反读**出来（不是假设"传了 languageId 就挂上了"），出货走真 model + 真版本号，
 * 最后把交回的那一笔 `applyEdits` 到真 model 上验文本 —— 幽灵文本没有 `filterText`，
 * 它的"过滤数学"落在**替换区间**上：区间错一格，上屏就是「视视角」。
 *
 * 钉四件事：
 * 1. **挂载名单来自 descriptor 声明位**：点名了 `inlineCompletion` 的方言（今天 = `.kojo2`）
 *    挂得上；既不走旧桥、又没点名的语言（json / plaintext）一枚都不挂；ERB / `.kojo`
 *    今天的挂载逐字不变；
 * 2. **闸门 ⑨ 的口径**：点了名的语言不再被宿主的 `codeViewAt` 挡（它的代码位判据在语言包里，
 *    由供方自己判）——读数形态 = 台词行那一拍 `gateSkipped` 是 `null` 且 `asked` 是 1，
 *    而不是 `non-code-position`；
 * 3. **端到端**：`# 视` 后敲一枚字符 ⇒ 上屏一条「视角」，区间把已打的「视」整枚换掉；
 * 4. **不静默**：这一格没有可证明的唯一答案时，记账的是 `noCompletion`（供方看过），
 *    不是"一家都没问"。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  InlineCompletionSourceContribution,
} from '@kojo/plugin-api';
import { SlotRegistryImpl } from '@kojo/kernel';
import * as monaco from '../src/monaco/entry';
// @ts-expect-error TS7016 —— 真注册表（公开面 registerInlineCompletionsProvider 的落点）
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
// @ts-expect-error TS7016
import { ILanguageFeaturesService } from 'monaco-editor/editor/common/services/languageFeatures.js';
import {
  getInlineCompletionTally,
  installInlineCompletion,
  resetInlineCompletionTally,
  resetInlineCompletionWarningsForTests,
  type InlineCompletionFacts,
  type InlineCompletionHostDeps,
  type InlineCompletionReport,
} from '../src/monaco/inline-completion-host';
import { declaresInlineCompletionFor, languageDescriptors } from '../src/monaco/language-registry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
// 真供方（插件侧）：宿主侧的挂载与闸门用真候选源跑，才叫端到端
import { createKojo2InlineContribution } from '@kojo/plugin-kojo-lang';

const HOST_DISPLAY = 'kojo-inline-completion-host';
const KOJO2_PATH = 'C:/corpus/kojo2/0001.kojo';
/** 宿主接线层的源码文本（M2 那条断言读它；口径同 `tools/audit-language.mjs`，但只盯这一枚文件） */
const HOST_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'monaco', 'inline-completion-host.ts'),
  'utf8',
);

const models: Monaco.editor.ITextModel[] = [];
const editors: Monaco.editor.IStandaloneCodeEditor[] = [];
let uriSeq = 0;

/**
 * happy-dom 没有 canvas 2D：真 editor 的渲染循环会在 `DecorationsOverviewRuler` 上抛
 * "Cannot set properties of null"（同 `inline-completion-host.test.ts` 的坑）。只桩 canvas，
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

function makeModel(text: string, languageId: string): Monaco.editor.ITextModel {
  const model = monaco.editor.createModel(
    text,
    languageId,
    monaco.Uri.parse(`inmemory://ic-kojo2/${++uriSeq}`),
  );
  models.push(model);
  return model;
}

/** 真 editor（打字腿要挂在它上面：`not-just-typed` 那道闸判的是"这一版是不是刚敲下一枚字符"） */
function makeEditor(model: Monaco.editor.ITextModel): Monaco.editor.IStandaloneCodeEditor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ed = monaco.editor.create(host, { model });
  editors.push(ed);
  return ed;
}

function factsOf(over: Partial<InlineCompletionFacts> = {}): InlineCompletionFacts {
  return {
    path: KOJO2_PATH,
    derivedView: false,
    readOnly: false,
    focused: true,
    multiCursor: false,
    selectionActive: false,
    project: null,
    ...over,
  };
}

const liveToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

interface Harness {
  readonly reports: InlineCompletionReport[];
  /** 从 vendor 自己的注册表反查这份 model 挂上了哪几枚 provider（读出来，不是假设） */
  providersFor(model: Monaco.editor.ITextModel): readonly Monaco.languages.InlineCompletionsProvider[];
  ask(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): Promise<Monaco.languages.InlineCompletions>;
  last(): InlineCompletionReport;
}

/**
 * 一次装配：真槽表 + 真 monaco 注册表 + 观测口。
 * 候选源默认就是**真 2.0 供方**（`@kojo/plugin-kojo-lang` 那一枚贡献），adapter 缺席
 * ⇒ 方言四路零候选，其余从源文能证明的路照常答。
 */
function harness(
  sources: readonly InlineCompletionSourceContribution[] = [
    createKojo2InlineContribution({ adapterFor: () => null }),
  ],
  facts: InlineCompletionFacts | null = factsOf(),
): Harness {
  const slots = new SlotRegistryImpl();
  for (const source of sources) slots.register('completion.source', source, `plugin:${source.id}`);
  const reports: InlineCompletionReport[] = [];
  const deps: InlineCompletionHostDeps = {
    sources: () => slots.query('completion.source'),
    facts: () => facts,
    pref: { enabled: () => true, maxCandidates: () => 5 },
    observe: (report) => reports.push(report),
  };
  const handle = installInlineCompletion(monaco as typeof Monaco, deps);
  const languageFeatures = StandaloneServices.get(ILanguageFeaturesService);
  disposers.push(handle);
  return {
    reports,
    providersFor: (model) => languageFeatures.inlineCompletionsProvider.all(model) ?? [],
    ask: async (model, position) => {
      const provider = languageFeatures.inlineCompletionsProvider
        .all(model)
        .find((p: { displayName?: string }) => p.displayName === HOST_DISPLAY);
      if (provider === undefined) throw new Error('宿主那枚 provider 没挂上这份 model');
      return provider.provideInlineCompletions(
        model,
        position,
        { triggerKind: monaco.languages.InlineCompletionTriggerKind?.Automatic ?? 0 },
        liveToken,
      );
    },
    last: () => reports[reports.length - 1]!,
  };
}

const disposers: { dispose(): void }[] = [];
const spies: { restore(): void }[] = [];

function reset(): void {
  for (const d of disposers.splice(0)) d.dispose();
  for (const s of spies.splice(0)) s.restore();
  for (const m of models.splice(0)) m.dispose();
  for (const e of editors.splice(0)) e.dispose();
  resetInlineCompletionTally();
  resetInlineCompletionWarningsForTests();
}

/**
 * 「刚敲下一枚字符」那一拍：先在 model 上做**单字符纯插入**（真内容事件 ⇒ 真版本号前进），
 * 再按插入后的光标位问一次。
 */
async function typeAndAsk(
  h: Harness,
  model: Monaco.editor.ITextModel,
  line: number,
  insertColumn: number,
  text: string,
): Promise<{ readonly items: readonly Monaco.languages.InlineCompletion[]; readonly report: InlineCompletionReport }> {
  model.applyEdits([
    {
      range: { startLineNumber: line, startColumn: insertColumn, endLineNumber: line, endColumn: insertColumn },
      text,
    },
  ]);
  const items = await h.ask(model, new monaco.Position(line, insertColumn + text.length));
  return { items, report: h.last() };
}

describe('① 挂载名单：descriptor 声明位说了算', () => {
  it('点名了 inlineCompletion 的方言挂得上；旧桥两门照挂；没点名的保留面一枚不挂', () => {
    spies.push(vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    const h = harness();
    const kojo2 = makeModel('# 幕 开场\n', KOJO2_LANGUAGE_ID);
    const erb = makeModel('@函数\n', ERB_LANGUAGE_ID);
    const kojo1 = makeModel('甲\n', KOJO_LANGUAGE_ID);
    const json = makeModel('{}\n', 'json');
    const erb = makeModel('@函数\n', ERB_LANGUAGE_ID);
    expect(
      h.providersFor(kojo2).some((p) => p.displayName === HOST_DISPLAY),
      `kojo2 没挂上（表：${languageDescriptors()
        .map((d) => `${d.id}=${String(d.inlineCompletion === true)}`)
        .join(',')}；kojo2 模型语言=${kojo2.getLanguageId()} 挂到=${h.providersFor(kojo2).length} 枚 / erb=${erb.getLanguageId()} 挂到=${h.providersFor(erb).length} 枚）`,
    ).toBe(true);
    expect(h.providersFor(erb).some((p) => p.displayName === HOST_DISPLAY), 'ERB 掉了').toBe(true);
    expect(h.providersFor(kojo1).some((p) => p.displayName === HOST_DISPLAY), '.kojo 掉了').toBe(true);
    expect(h.providersFor(json).some((p) => p.displayName === HOST_DISPLAY), '保留面被铺了空 provider').toBe(false);
    // 声明位自己也得是数据：kojo2 真、json 假（宿主读表，不读语言名）
    expect(declaresInlineCompletionFor(KOJO2_LANGUAGE_ID)).toBe(true);
    expect(declaresInlineCompletionFor('json')).toBe(false);
    reset();
  });

  it('宿主接线层里一枚语言 id 都不写（M2：descriptor 是唯一台账）', () => {
    for (const literal of ['KOJO2_LANGUAGE_ID', 'ERB_LANGUAGE_ID', 'KOJO_LANGUAGE_ID', "'kojo2'"]) {
      expect(HOST_SOURCE, `宿主接线层按语言 id 分支：${literal}`).not.toContain(literal);
    }
  });
});

describe('②③④ 真通道端到端：唯一才给 / 抑制面记账 / 区间落字', () => {
  it('`# 视` 后再敲一枚 ⇒ 上屏一条「视角」，接受键落下去的那一笔把该行变成「# 视角」', async () => {
    spies.push(vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    const h = harness();
    const model = makeModel('# 幕 开场\n# ', KOJO2_LANGUAGE_ID);
    makeEditor(model); // 打字腿要有真 editor
    const typed = await typeAndAsk(h, model, 2, 3, '视');
    expect(typed.items).toHaveLength(1);
    const item = typed.items[0]!;
    expect(item.insertText).toBe('视角');
    expect(item.range?.startLineNumber).toBe(2);
    expect(item.range?.startColumn).toBe(3);
    expect(item.range?.endColumn).toBe(4);
    expect(typed.report.gateSkipped).toBeNull();
    expect(typed.report.answeredBy).toBe('kojo2-near-unique');
    expect(typed.report.shown).toBe(1);
    // 真落一笔：区间 + insertText 应用后必须是「# 视角」，不是「# 视视角」也不是「# 角」
    model.applyEdits([
      {
        range: {
          startLineNumber: item.range!.startLineNumber,
          startColumn: item.range!.startColumn,
          endLineNumber: item.range!.endLineNumber,
          endColumn: item.range!.endColumn,
        },
        text: item.insertText,
      },
    ]);
    expect(model.getLineContent(2)).toBe('# 视角');
    reset();
  });

  it('台词行不弹，但记账的是**供方看过**（noCompletion），不是宿主闸门挡下', async () => {
    spies.push(vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    const h = harness();
    const model = makeModel('# 幕 开场\n    你今天来得真早', KOJO2_LANGUAGE_ID);
    makeEditor(model);
    const typed = await typeAndAsk(h, model, 2, 11, '很');
    expect(typed.items).toHaveLength(0);
    expect(typed.report.gateSkipped).toBeNull(); // ← 关键：没走 non-code-position
    expect(typed.report.asked).toBe(1);
    expect(typed.report.noCompletion).toBe(1);
    expect(typed.report.answeredBy).toBeNull();
    reset();
  });

  it('名录多条（`# ` 后一枚空白）⇒ 不弹；同一拍问了一家、记一次 noCompletion', async () => {
    spies.push(vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    const h = harness();
    const model = makeModel('# 幕 开场\n#', KOJO2_LANGUAGE_ID);
    makeEditor(model);
    const typed = await typeAndAsk(h, model, 2, 3, ' ');
    expect(typed.items).toHaveLength(0);
    expect(typed.report.noCompletion).toBe(1);
    expect(typed.report.violations).toBe(0);
    reset();
  });

  it('没打字的一拍（只把光标放过去）⇒ 宿主一家都不问：闸门仍是 not-just-typed', async () => {
    spies.push(vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    const h = harness();
    const model = makeModel('# 幕 开场\n# ', KOJO2_LANGUAGE_ID);
    makeEditor(model);
    const items = await h.ask(model, new monaco.Position(2, 3));
    expect(items.items).toHaveLength(0);
    expect(h.last().gateSkipped).toBe('not-just-typed');
    reset();
  });
});
