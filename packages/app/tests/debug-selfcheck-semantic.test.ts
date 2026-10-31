/**
 * 调试面 · 语义读数的可用性自检（1030 批次 3）的判据。
 *
 * 这件事要防的歧义：`definitionAt` / `referencesAt` / `codeActionsAt` / `signatureAt` /
 * `documentSymbols` / `diagnostics` 读不到时一律返回 `null` / `[]`，与"这里确实没有定义"
 * **同形**——所以 `selfCheck().semantic` 得先回答"这台构建上到底有没有货可读"。
 *
 * 口径上最容易做错的一步是**把近似当等价**：`getAction('editor.action.revealDefinition')`
 * 拿到对象只证明动作注册着（Monaco 的动作是静态注册的，没有 provider 也照样在），
 * 所以本文件的断言一律钉**具体布尔值**，并且专门钉住"动作在 + 不支持"这一格——
 * 那是 `present` 与 `supported` 必须分开的唯一理由。
 *
 * 这一层刻意不碰 DOM / Monaco 运行时（伪 editor / 伪 service 即可）：真实链路由
 * `tools/debug-web-smoke.mjs` 在浏览器里对拍。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  probeProviderPresence,
  probeSemanticActions,
  summarizeSemanticCheck,
  type ActionLookupLike,
  type DebugSelfCheckProviders,
} from '../src/debug/install-debug';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/* ------------------------------ 伪 editor / 伪 service ------------------------------ */

/** 记录探测了哪些 id：动作 id 本身就是口径的一部分（错了读数就永远是 false） */
function fakeEditor(table: Record<string, unknown>): { ed: ActionLookupLike; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ed: {
      getAction(id: string) {
        asked.push(id);
        return table[id];
      },
    },
  };
}

/** 一枚"活着"的动作：真实 `IEditorAction` 至少要能回答 isSupported() */
const supportedAction = (supported: boolean): { isSupported: () => boolean } => ({
  isSupported: () => supported,
});

const nullProviders: DebugSelfCheckProviders = {
  definition: null,
  references: null,
  codeAction: null,
  signatureHelp: null,
  documentSymbol: null,
  diagnostics: null,
};

/* ------------------------------ 动作：四枚 / 部分 / 全无 ------------------------------ */

describe('语义自检 · probeSemanticActions（动作面）', () => {
  it('四枚动作全在且都自认支持 ⇒ 四组 present=true / supported=true', () => {
    const { ed, asked } = fakeEditor({
      'editor.action.revealDefinition': supportedAction(true),
      'editor.action.refactor': supportedAction(true),
      'editor.action.triggerParameterHints': supportedAction(true),
      'editor.action.quickOutline': supportedAction(true),
    });
    expect(probeSemanticActions(ed)).toEqual({
      definition: { present: true, supported: true },
      codeAction: { present: true, supported: true },
      signatureHelp: { present: true, supported: true },
      documentSymbol: { present: true, supported: true },
    });
    // 动作 id 钉死：codeAction 用 refactor 而不是 quickFix（0.57 的 quickFix 是 Action2 注册，
    // 不进 editor._actions 表，拿它当探针恒为假阴性——见 SEMANTIC_ACTION_IDS 头注）
    expect(asked).toEqual([
      'editor.action.revealDefinition',
      'editor.action.refactor',
      'editor.action.triggerParameterHints',
      'editor.action.quickOutline',
    ]);
  });

  it('只有一枚在 ⇒ 其余 present=false 且 supported=null（不拿 false 冒充"不支持"）', () => {
    const { ed } = fakeEditor({ 'editor.action.revealDefinition': supportedAction(true) });
    expect(probeSemanticActions(ed)).toEqual({
      definition: { present: true, supported: true },
      codeAction: { present: false, supported: null },
      signatureHelp: { present: false, supported: null },
      documentSymbol: { present: false, supported: null },
    });
  });

  it('动作在但 isSupported() 说 false ⇒ present=true / supported=false（"在"与"能用"分开）', () => {
    const { ed } = fakeEditor({
      'editor.action.revealDefinition': supportedAction(false),
      'editor.action.refactor': supportedAction(true),
      'editor.action.triggerParameterHints': supportedAction(false),
      'editor.action.quickOutline': supportedAction(true),
    });
    expect(probeSemanticActions(ed)).toEqual({
      definition: { present: true, supported: false },
      codeAction: { present: true, supported: true },
      signatureHelp: { present: true, supported: false },
      documentSymbol: { present: true, supported: true },
    });
  });

  it('isSupported 缺席 / 抛错 / 返回非布尔 ⇒ present=true 而 supported=null（没问到就 null）', () => {
    const { ed } = fakeEditor({
      'editor.action.revealDefinition': {},
      'editor.action.refactor': {
        isSupported: () => {
          throw new Error('贡献点已销毁');
        },
      },
      'editor.action.triggerParameterHints': { isSupported: () => 'true' },
      'editor.action.quickOutline': { isSupported: 1 },
    });
    expect(probeSemanticActions(ed)).toEqual({
      definition: { present: true, supported: null },
      codeAction: { present: true, supported: null },
      signatureHelp: { present: true, supported: null },
      documentSymbol: { present: true, supported: null },
    });
    // 与 mapSupportedActions 的乐观默认（拿不到当 true）刻意不同：自检不许乐观
    expect(probeSemanticActions(ed).definition.supported).not.toBe(true);
  });

  it('getAction 直接抛 ⇒ 四组全 false / null，不炸读数器', () => {
    const ed: ActionLookupLike = {
      getAction() {
        throw new Error('editor 已销毁');
      },
    };
    expect(probeSemanticActions(ed)).toEqual({
      definition: { present: false, supported: null },
      codeAction: { present: false, supported: null },
      signatureHelp: { present: false, supported: null },
      documentSymbol: { present: false, supported: null },
    });
  });

  it('getAction 返回 undefined / null / false ⇒ present=false', () => {
    const { ed } = fakeEditor({
      'editor.action.revealDefinition': undefined,
      'editor.action.refactor': null,
      'editor.action.triggerParameterHints': false,
      'editor.action.quickOutline': 'editor.action.quickOutline',
    });
    expect(probeSemanticActions(ed)).toEqual({
      definition: { present: false, supported: null },
      codeAction: { present: false, supported: null },
      signatureHelp: { present: false, supported: null },
      // 字符串也不算"动作"：present 只认对象（拿不到 isSupported 的东西不是动作）
      documentSymbol: { present: false, supported: null },
    });
  });

  it('编辑器为 null / undefined / 没有 getAction ⇒ 四组全 false / null（无焦点编辑器照样给形状）', () => {
    const empty = {
      definition: { present: false, supported: null },
      codeAction: { present: false, supported: null },
      signatureHelp: { present: false, supported: null },
      documentSymbol: { present: false, supported: null },
    };
    expect(probeSemanticActions(null)).toEqual(empty);
    expect(probeSemanticActions(undefined)).toEqual(empty);
    expect(probeSemanticActions({} as ActionLookupLike)).toEqual(empty);
    expect(probeSemanticActions(42 as unknown as ActionLookupLike)).toEqual(empty);
  });
});

/* ------------------------------ provider：注册表直读 ------------------------------ */

describe('语义自检 · probeProviderPresence（provider 面）', () => {
  const model = { uri: 'inmemory://model/1' };
  const withProvider = (): { ordered: () => { provider: unknown }[] } => ({
    ordered: () => [{ provider: { provideDefinition() {} } }],
  });
  const empty = (): { ordered: () => { provider: unknown }[] } => ({ ordered: () => [] });

  it('五个注册表都有 provider ⇒ 五个 true；diagnostics 恒 null（它不走注册表）', () => {
    const providers = probeProviderPresence(
      {
        definitionProvider: withProvider(),
        referenceProvider: withProvider(),
        codeActionProvider: withProvider(),
        signatureHelpProvider: withProvider(),
        documentSymbolProvider: withProvider(),
      },
      model,
    );
    expect(providers).toEqual({
      definition: true,
      references: true,
      codeAction: true,
      signatureHelp: true,
      documentSymbol: true,
      diagnostics: null,
    });
  });

  it('注册表可查但为空 ⇒ false（读数必然空，与"这里确实没有定义"同形的那一格）', () => {
    expect(
      probeProviderPresence(
        {
          definitionProvider: empty(),
          referenceProvider: withProvider(),
          codeActionProvider: empty(),
          signatureHelpProvider: empty(),
          documentSymbolProvider: empty(),
        },
        model,
      ),
    ).toEqual({
      definition: false,
      references: true,
      codeAction: false,
      signatureHelp: false,
      documentSymbol: false,
      diagnostics: null,
    });
  });

  it('注册表缺席 / 没有 ordered / ordered 抛错 / 返回非数组 ⇒ null（问不到就 null，不猜）', () => {
    expect(
      probeProviderPresence(
        {
          referenceProvider: {},
          codeActionProvider: {
            ordered: () => {
              throw new Error('注册表已释放');
            },
          },
          signatureHelpProvider: { ordered: () => ({ not: 'an array' }) },
        },
        model,
      ),
    ).toEqual({
      definition: null,
      references: null,
      codeAction: null,
      signatureHelp: null,
      documentSymbol: null,
      diagnostics: null,
    });
  });

  it('条目里没有 provider ⇒ 不算 provider（与 providersOf 同一条判据）', () => {
    const providers = probeProviderPresence(
      { definitionProvider: { ordered: () => [{ provider: null }, {}] } },
      model,
    );
    expect(providers.definition).toBe(false);
  });

  it('service 为 null（深路径 import 不通）/ 没有 model ⇒ 六项全 null，绝不编造 false', () => {
    expect(probeProviderPresence(null, model)).toEqual(nullProviders);
    expect(probeProviderPresence(undefined, model)).toEqual(nullProviders);
    expect(probeProviderPresence({ definitionProvider: empty() }, null)).toEqual(nullProviders);
    expect(probeProviderPresence(42, model)).toEqual(nullProviders);
  });
});

/* ------------------------------ 归一（纯函数直测） ------------------------------ */

describe('语义自检 · summarizeSemanticCheck（归一）', () => {
  it('全缺（null）⇒ 键集固定、全 false / null、diagnostics 恒 null', () => {
    const reading = summarizeSemanticCheck(null);
    expect(reading).toEqual({
      actions: {
        definition: { present: false, supported: null },
        codeAction: { present: false, supported: null },
        signatureHelp: { present: false, supported: null },
        documentSymbol: { present: false, supported: null },
      },
      providers: {
        definition: null,
        references: null,
        codeAction: null,
        signatureHelp: null,
        documentSymbol: null,
        diagnostics: null,
      },
    });
    expect(Object.keys(reading.actions).sort()).toEqual([
      'codeAction',
      'definition',
      'documentSymbol',
      'signatureHelp',
    ]);
    expect(Object.keys(reading.providers).sort()).toEqual([
      'codeAction',
      'definition',
      'diagnostics',
      'documentSymbol',
      'references',
      'signatureHelp',
    ]);
  });

  it('present 只认字面量 true（"true" / 1 都算"没问到"）', () => {
    const reading = summarizeSemanticCheck({
      actions: { definition: { present: 'true', supported: true }, codeAction: { present: 1 } },
    });
    expect(reading.actions.definition).toEqual({ present: false, supported: true });
    expect(reading.actions.codeAction).toEqual({ present: false, supported: null });
  });

  it('supported 三态：true / false 原样，其余（"true" / 缺键）⇒ null', () => {
    const reading = summarizeSemanticCheck({
      actions: {
        definition: { present: true, supported: false },
        codeAction: { present: true, supported: 'true' },
        signatureHelp: { present: true },
        documentSymbol: { present: true, supported: null },
      },
    });
    expect(reading.actions).toEqual({
      definition: { present: true, supported: false },
      codeAction: { present: true, supported: null },
      signatureHelp: { present: true, supported: null },
      documentSymbol: { present: true, supported: null },
    });
  });

  it('providers 三态原样，但 diagnostics 连入参都不看（恒 null：它没有 provider 概念）', () => {
    const reading = summarizeSemanticCheck({
      providers: {
        definition: true,
        references: false,
        codeAction: 'true',
        signatureHelp: 1,
        documentSymbol: false,
        diagnostics: true,
      },
    });
    expect(reading.providers).toEqual({
      definition: true,
      references: false,
      codeAction: null,
      signatureHelp: null,
      documentSymbol: false,
      diagnostics: null,
    });
  });

  it('脏值 / 非对象 / 半截对象都不抛（自检自己炸掉就是第二个无法定位的静默失败）', () => {
    for (const raw of [undefined, 42, 'x', [], { actions: null }, { providers: 7 }, { actions: [] }]) {
      expect(() => summarizeSemanticCheck(raw)).not.toThrow();
    }
    expect(summarizeSemanticCheck(42).providers.definition).toBeNull();
  });
});

/* ------------------------------ 源形状守门（ok 判据不许动） ------------------------------ */

describe('语义自检 · 源形状（ok 判据一个字节都没改）', () => {
  const source = read('packages/app/src/debug/install-debug.ts');

  it('ok 的表达式原样保留：只由 version + hover + suggest + foldingContribution 决定', () => {
    expect(source).toContain(
      'ok: monacoVersion !== null && selectors.hover && selectors.suggest && selectors.foldingContribution,',
    );
    // semantic 一次都不许出现在 ok 的算式里（塞进去就是把近似当判据）
    const okLines = source.split('\n').filter((line) => line.includes('ok: monacoVersion !== null'));
    expect(okLines).toHaveLength(1);
    expect(okLines[0]).not.toContain('semantic');
  });

  it('semantic 挂在 selfCheck 外层（老形状 summarizeSelfCheck 不多一个键）', () => {
    expect(source).toContain('readonly semantic: DebugSelfCheckSemantic;');
    const body = source.slice(source.indexOf('function readSelfCheckRaw('), source.indexOf('function readSelfCheckRaw(') + 1600);
    expect(body).toContain('...core');
    expect(body).toContain('summarizeSemanticCheck({');
    expect(body).toContain('probeSemanticActions(ed)');
    expect(body).toContain('probeProvidersNow(ed)');
    // 兜底分支同样给完整形状（含 semantic）
    expect(source).toContain('...summarizeSelfCheck(null), semantic: summarizeSemanticCheck(null)');
  });

  it('provider 只从注册表读，不给 diagnostics 编造 provider 结论', () => {
    const body = source.slice(source.indexOf('export function probeProviderPresence('), source.indexOf('export function probeProviderPresence(') + 900);
    for (const key of ['definitionProvider', 'referenceProvider', 'codeActionProvider', 'signatureHelpProvider', 'documentSymbolProvider']) {
      expect(body).toContain(key);
    }
    expect(body).toContain('diagnostics: null');
  });
});

/* --------------------- 注册表条目的真实形态（0.57）回归 --------------------- */

/**
 * 这一组是给一个真机缺陷补的闸：`LanguageFeatureRegistry.ordered()` 在 0.57 上**直接返回
 * provider 数组**（上游 `_orderedForEach(model, …, entry => result.push(entry.provider))`），
 * 而我们早先按 `{ provider }` 包装去解 —— 于是每条都解出 `undefined`，`providersOf` 恒空、
 * `presenceOf` 恒 false，六个语义读数在真机上一直返回空。
 *
 * 为什么原来的 20 条没拦住：它们喂的全是 `{ provider: … }` 包装形状，正好是错的那一侧。
 * 所以这里把**上游真实形状**钉成第一类，包装形态降为兼容项。
 */
describe('语义自检 · 注册表条目的真实形态（上游 truth）', () => {
  const model = { uri: 'inmemory://model/1' };
  /** 0.57 的 `ordered()`：条目就是 provider 本身 */
  const direct = (method: string) => ({ ordered: () => [{ [method]() {} }] });
  /** 兼容项：上游若改回 `{ provider }` 包装 */
  const wrapped = (method: string) => ({ ordered: () => [{ provider: { [method]() {} } }] });

  const service = (make: (method: string) => { ordered: () => unknown[] }) => ({
    definitionProvider: make('provideDefinition'),
    referenceProvider: make('provideReferences'),
    codeActionProvider: make('provideCodeActions'),
    signatureHelpProvider: make('provideSignatureHelp'),
    documentSymbolProvider: make('provideDocumentSymbols'),
  });

  it('条目直接是 provider（0.57 真实形态）⇒ 五项全 true', () => {
    expect(probeProviderPresence(service(direct), model)).toEqual({
      definition: true,
      references: true,
      codeAction: true,
      signatureHelp: true,
      documentSymbol: true,
      diagnostics: null,
    });
  });

  it('条目是 { provider } 包装（兼容形态）⇒ 同样五项全 true', () => {
    expect(probeProviderPresence(service(wrapped), model)).toEqual({
      definition: true,
      references: true,
      codeAction: true,
      signatureHelp: true,
      documentSymbol: true,
      diagnostics: null,
    });
  });

  it('条目既不是 provider 也没有该特性的方法 ⇒ false（不是"有条目就算有 provider"）', () => {
    // 注册表里可能混进别的特性的条目：光看"非空"会把没有 provider 说成 true
    const wrongFeature = { ordered: () => [{ provideReferences() {} }] };
    const providers = probeProviderPresence(
      {
        definitionProvider: wrongFeature,
        referenceProvider: wrongFeature,
        codeActionProvider: wrongFeature,
        signatureHelpProvider: wrongFeature,
        documentSymbolProvider: wrongFeature,
      },
      model,
    );
    expect(providers.documentSymbol).toBe(false);
    expect(providers.definition).toBe(false);
    // 同一个假条目里确实有 provideReferences ⇒ references 那一格是 true
    expect(providers.references).toBe(true);
  });

  it('条目是 null / 原始值 ⇒ false，不抛', () => {
    const junk = { ordered: () => [null, 42, 'provider', undefined] };
    expect(probeProviderPresence({ documentSymbolProvider: junk }, model).documentSymbol).toBe(false);
  });
});
