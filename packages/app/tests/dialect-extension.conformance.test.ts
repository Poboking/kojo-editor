/**
 * **方言扩展路径**的端到端夹具（SDK-DIALECT 的可执行钉子）。
 *
 * ## 这份文件回答什么问题
 *
 * `docs/DIALECT-AUTHORING.md` 的承诺是「新增一个方言 = 新增一个包 + 清单一行，宿主 / 内核 /
 * conformance 都不改」。`tools/tests/dialect-e2e.test.ts` 钉的是**游戏侧**那条链（脚手架 →
 * 清单自证 → conformance golden）；本文件钉的是**编辑器侧**那条链——一枚第三方语言插件
 * **只登记 descriptor**，就能被语言槽收下并挂上真实 provider。两条链合起来才是"照着指南做
 * 就能用"。
 *
 * ## 夹具为什么是内存 descriptor（而不是再落一个新包）
 *
 * 扩展作者真正写的是一枚 `LanguageDescriptor`（`ui.monaco.language` 槽的宿主形态）加一枚
 * 插件贡献。包里那层只是分发外形；判据全在 descriptor 上。所以夹具在这里直接把 descriptor
 * 登记进真实注册表（进程级只增表），再喂给**真实安装器**（`installDocumentSymbolProvider` /
 * `installSlotServiceLegs` / `installFoldingRangeProvider`）——桩只桩 Monaco 的 `languages.*`
 * 注册函数与内核查询，判据一行都不抄。零 IO、零网络、零真实游戏盘。
 *
 * ## 四组断言（与简报一一对应）
 *
 * 0. **零宿主改动**：探针 id 在 `packages/app/src` 整树里一个字都没有；
 * 1. **挂载面 = 声明面**：`slotServices` / `services.slot` 点名的腿挂上、没点名的不挂——
 *    两种写法（LAU-3 additive 的 `services.slot` 与旧的 `slotServices`）必须同效；
 *    `services.legacyBridge` 与 `languageServices: true` 同效（旧桥全腿）；
 * 2. **供方三态**：`undefined`（弃权）/ 空结果（作答）/ 有值，经宿主的取数腿原样区分；
 * 3. **按 languageId 弃权**：旧桥语言没点名 `documentHighlight` ⇒ provider 挂上但请求时弃权
 *    （不去问槽、也就不会把别门的答案当自己的再交一遍）；
 * 4. **fail-safe**：descriptor 缺 `slotServices`（或空表）⇒ 零腿挂载。
 *
 * 本文件**不进开机静态图**（`ps10-eager-graph.test.ts` 只量 app 的入口图）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EditorDocumentSymbol,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { LanguageCapability } from '../src/monaco/language-capabilities';
// 真实 descriptor 表在模块求值时登记（探针按注册序排在它们之后；断言只按 id 取，不写死整表）
import '../src/monaco/languages';
import {
  descriptorForLanguageId,
  registerLanguage,
  type LanguageDescriptor,
  type SlotServiceKind,
} from '../src/monaco/language-registry';
import { registerForLanguageServices } from '../src/monaco/register-dialects';
import { collectDocumentSymbols, installDocumentSymbolProvider } from '../src/monaco/kojo-symbols';
import { installFoldingRangeProvider } from '../src/monaco/kojo-folding';
import { installSlotServiceLegs } from '../src/monaco/slot-service-providers';
import { collectHoverContents } from '../src/monaco/kojo-language-service-legs';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';

/* ============================== 探针方言（一枚最小第三方 descriptor） ============================== */

/**
 * 扩展作者会写的最小形态：一个 id、一条认路判据、一次幂等的 Monaco 面注册、
 * 以及**只点名自己交付了的那两条腿**（大纲 + 悬停）+ 对应的能力声明。
 */
const DIALECT_ID = 'acmedialect';

/** LAU-3 additive 的新写法（`services.slot`；descriptor 头注明写"两者都给了以它为凭"） */
const MODERN_ID = 'acmedialectmodern';

/** 旧桥的显式写法（`services.legacyBridge`；= `languageServices: true` 的新名） */
const BRIDGE_ID = 'acmedialectbridge';

/** 什么都不声明：用来钉 fail-safe（零腿挂载） */
const BARE_ID = 'acmedialectbare';

/** 声明一张**空表**：空 ≠ "全都声明" */
const EMPTY_ID = 'acmedialectempty';

/** 点名 `documentHighlight`：用来钉"点名了才去问槽"的正向 */
const HIGHLIGHT_ID = 'acmedialecthl';

const PROBE_IDS = [DIALECT_ID, MODERN_ID, BRIDGE_ID, BARE_ID, EMPTY_ID, HIGHLIGHT_ID] as const;

const PROBE_EXTENSION = '.acmeprobe';

function dialectDescriptor(id: string, over: Partial<LanguageDescriptor> = {}): LanguageDescriptor {
  return {
    id,
    label: id,
    matchesPath: (filePath) => filePath.toLowerCase().endsWith(PROBE_EXTENSION),
    register: () => undefined,
    ...over,
  };
}

/** 指南照做的那一枚：两条腿 + 两条能力（capabilities 只写已交付的面） */
const DIALECT: LanguageDescriptor = dialectDescriptor(DIALECT_ID, {
  slotServices: ['documentSymbol', 'hover'],
  capabilities: [LanguageCapability.Outline, LanguageCapability.Hover],
});

const MODERN: LanguageDescriptor = dialectDescriptor(MODERN_ID, {
  services: { slot: ['documentSymbol', 'hover'] },
  capabilities: [LanguageCapability.Outline, LanguageCapability.Hover],
});

const BRIDGE: LanguageDescriptor = dialectDescriptor(BRIDGE_ID, {
  services: { legacyBridge: true },
});

const BARE: LanguageDescriptor = dialectDescriptor(BARE_ID);

const EMPTY: LanguageDescriptor = dialectDescriptor(EMPTY_ID, { slotServices: [] });

const HIGHLIGHT: LanguageDescriptor = dialectDescriptor(HIGHLIGHT_ID, {
  slotServices: ['documentHighlight'],
  capabilities: [LanguageCapability.Highlight],
});

for (const descriptor of [DIALECT, MODERN, BRIDGE, BARE, EMPTY, HIGHLIGHT]) {
  registerLanguage(descriptor);
}

/* ============================== 取证基建 ============================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = path.resolve(HERE, '..', 'src');

/** `packages/app/src` 整树（"宿主里一个字都没有"是可断言的，不是一句口号） */
function appSourceTexts(): readonly { readonly rel: string; readonly text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({ rel: path.relative(APP_SRC, abs).split(path.sep).join('/'), text: readFileSync(abs, 'utf8') });
    }
  };
  walk(APP_SRC);
  return out;
}

/** 一门语言**实际会挂上**的腿（与两处消费方的口径对拍：`slotServices` / `services.slot`） */
function declaredKinds(descriptor: LanguageDescriptor): readonly string[] {
  return descriptor.services?.slot ?? descriptor.slotServices ?? [];
}

type RegisterName = 'hover' | 'documentSymbol' | 'foldingRange' | 'documentHighlight' | 'completion';

interface Registration {
  readonly kind: RegisterName;
  readonly selector: string;
  readonly provider: unknown;
}

/** 桩 Monaco：只桩 `languages.*` 的注册函数（判据全在宿主侧，桩不替宿主做决定） */
function fakeMonaco(): { readonly monaco: typeof Monaco; readonly registrations: Registration[] } {
  const registrations: Registration[] = [];
  const register =
    (kind: RegisterName) =>
    (selector: string, provider: unknown): Monaco.IDisposable => {
      registrations.push({ kind, selector, provider });
      return { dispose: () => undefined };
    };
  const fake = {
    languages: {
      DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
      SymbolKind: { Function: 11, Namespace: 3, Object: 19, Variable: 5 },
      registerHoverProvider: register('hover'),
      registerDocumentSymbolProvider: register('documentSymbol'),
      registerFoldingRangeProvider: register('foldingRange'),
      registerDocumentHighlightProvider: register('documentHighlight'),
      registerCompletionItemProvider: register('completion'),
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations };
}

function selectorsOf(fake: { readonly registrations: Registration[] }, kind: RegisterName): string[] {
  return fake.registrations.filter((entry) => entry.kind === kind).map((entry) => entry.selector);
}

function providerOf(fake: { readonly registrations: Registration[] }, kind: RegisterName, id: string): unknown {
  const entry = fake.registrations.find((item) => item.kind === kind && item.selector === id);
  if (entry === undefined) throw new Error(`[dialect-extension] ${id} 上没有挂 ${kind} provider`);
  return entry.provider;
}

/** 假 model：三条腿只读这三格（取文 / 语言 id / 版本） */
function modelOf(languageId: string, source = 'A\nB\n'): Monaco.editor.ITextModel {
  return {
    getValue: () => source,
    getLanguageId: () => languageId,
    getVersionId: () => 3,
    getLineCount: () => source.split('\n').length,
    getLineContent: (line: number) => source.split('\n')[line - 1] ?? '',
    uri: { scheme: 'file', path: '/proj/a' + PROBE_EXTENSION, fsPath: '/proj/a' + PROBE_EXTENSION },
  } as unknown as Monaco.editor.ITextModel;
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function position(lineNumber: number, column: number): Monaco.Position {
  return { lineNumber, column } as unknown as Monaco.Position;
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

/** 装一枚只答语言服务槽的假内核（`query` 是 spy：弃权腿**不该**问它） */
function installKernel(
  contributions: readonly EditorLanguageServiceContribution[],
): ReturnType<typeof vi.fn> {
  const query = vi.fn((slot: string) =>
    slot === 'ui.editor.languageService' ? contributions : [],
  );
  setGlobalKernel({
    slots: { query },
    project: { current: () => null },
  } as unknown as KernelLike);
  return query;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================== 0. 指南照做 ⇒ 零宿主改动 ============================== */

describe('0 指南照做：只登记 descriptor，宿主源码零改动', () => {
  it('探针 id 在 `packages/app/src` 整树里一个字都没有', () => {
    const mentions = appSourceTexts()
      .filter((file) => PROBE_IDS.some((id) => file.text.includes(id)))
      .map((file) => file.rel);
    expect(mentions, '加一门方言要改宿主了').toEqual([]);
  });

  it('注册表收下 descriptor：按 id 取回的就是同一枚，认路只认自己的扩展名', () => {
    expect(descriptorForLanguageId(DIALECT_ID)).toBe(DIALECT);
    expect(DIALECT.matchesPath('/p/a' + PROBE_EXTENSION)).toBe(true);
    expect(DIALECT.matchesPath('/p/a.kojo')).toBe(false);
  });

  it('capabilities 只声明与点名槽腿对得上的面（大纲 ↔ documentSymbol、悬停 ↔ hover）', () => {
    const legOf: Partial<Record<LanguageCapability, SlotServiceKind>> = {
      [LanguageCapability.Outline]: 'documentSymbol',
      [LanguageCapability.Hover]: 'hover',
      [LanguageCapability.Highlight]: 'documentHighlight',
    };
    for (const capability of DIALECT.capabilities ?? []) {
      const leg = legOf[capability];
      expect(leg, `${capability} 没有对应的槽腿映射`).toBeDefined();
      expect(declaredKinds(DIALECT), `${capability} 声明了却没有点名对应的槽腿`).toContain(leg);
    }
  });
});

/* ============================== 1. 挂载面 = 声明面 ============================== */

describe('① 声明了的那几条腿挂上、没声明的不挂', () => {
  it('`slotServices` 点名的 documentSymbol / hover 都经真实安装器挂上（各一枚）', () => {
    const fake = fakeMonaco();
    const symbols = installDocumentSymbolProvider(fake.monaco, { resolve: () => [] });
    const hover = installSlotServiceLegs(fake.monaco, ['hover']);
    expect(selectorsOf(fake, 'documentSymbol')).toContain(DIALECT_ID);
    expect(selectorsOf(fake, 'hover')).toContain(DIALECT_ID);
    for (const kind of ['documentSymbol', 'hover'] as const) {
      expect(selectorsOf(fake, kind).filter((id) => id === DIALECT_ID), kind).toHaveLength(1);
    }
    symbols.dispose();
    hover.dispose();
  });

  it('没点名的腿一枚都不挂（foldingRange / completion）', () => {
    const fake = fakeMonaco();
    const folding = installFoldingRangeProvider(fake.monaco, { resolve: () => [] });
    const completion = installSlotServiceLegs(fake.monaco, ['completion']);
    expect(selectorsOf(fake, 'foldingRange')).not.toContain(DIALECT_ID);
    expect(selectorsOf(fake, 'completion')).not.toContain(DIALECT_ID);
    folding.dispose();
    completion.dispose();
  });

  it('LAU-3 新写法 `services.slot` 与 `slotServices` 同效（点名的挂上、没点名的不挂）', () => {
    const fake = fakeMonaco();
    const symbols = installDocumentSymbolProvider(fake.monaco, { resolve: () => [] });
    const hover = installSlotServiceLegs(fake.monaco, ['hover']);
    const completion = installSlotServiceLegs(fake.monaco, ['completion']);
    expect(selectorsOf(fake, 'documentSymbol'), 'services.slot 点名的 documentSymbol 没挂上').toContain(
      MODERN_ID,
    );
    expect(selectorsOf(fake, 'hover'), 'services.slot 点名的 hover 没挂上').toContain(MODERN_ID);
    expect(selectorsOf(fake, 'completion'), 'services.slot 没点名的 completion 被挂上了').not.toContain(
      MODERN_ID,
    );
    symbols.dispose();
    hover.dispose();
    completion.dispose();
  });

  it('`services.legacyBridge` 与 `languageServices: true` 同效（旧桥 = 全腿）', () => {
    const fake = fakeMonaco();
    const folding = installFoldingRangeProvider(fake.monaco, { resolve: () => [] });
    const completion = installSlotServiceLegs(fake.monaco, ['completion']);
    expect(selectorsOf(fake, 'foldingRange'), 'legacyBridge 的旧桥语言没铺全腿').toContain(BRIDGE_ID);
    expect(selectorsOf(fake, 'completion'), 'legacyBridge 的旧桥语言没铺全腿').toContain(BRIDGE_ID);
    folding.dispose();
    completion.dispose();
  });

  it('收口本身：同一枚 descriptor 传不同的 kind，只在自己点名的那条上出现', () => {
    const mountedFor = (kind: SlotServiceKind): string[] => {
      const calls: string[] = [];
      const handle = registerForLanguageServices(
        {} as unknown as typeof Monaco,
        (_monaco, languageId) => {
          calls.push(languageId);
          return { dispose: () => undefined };
        },
        kind,
      );
      handle.dispose();
      return calls;
    };
    expect(mountedFor('hover')).toContain(DIALECT_ID);
    expect(mountedFor('documentSymbol')).toContain(DIALECT_ID);
    expect(mountedFor('foldingRange')).not.toContain(DIALECT_ID);
    expect(mountedFor('hover')).toContain(MODERN_ID);
    expect(mountedFor('foldingRange')).toContain(BRIDGE_ID);
  });
});

/* ============================== 2. 供方三态 ============================== */

const HOVER_REQUEST = {
  kind: 'hover',
  languageId: DIALECT_ID,
  path: '/proj/a' + PROBE_EXTENSION,
  text: 'A\nB\n',
  line: 1,
  column: 1,
  version: 3,
} as unknown as EditorLanguageServiceRequest;

/** 第三方供方：只认自己的语言（真实插件的常规写法——按请求的 languageId 自认） */
function dialectContribution(
  answer: 'abstain' | 'empty' | 'value',
): EditorLanguageServiceContribution {
  return {
    id: 'acme-hover',
    provide: (request) => {
      if (request.kind !== 'hover') return undefined;
      if ((request as { languageId?: string }).languageId !== DIALECT_ID) return undefined;
      if (answer === 'abstain') return undefined;
      return { kind: 'hover', contents: answer === 'empty' ? '' : 'ACME HOVER' };
    },
  };
}

describe('② 供方三态：undefined（弃权）/ 空结果（作答）/ 有值', () => {
  it('悬停（单答型）：弃权 ⇒ undefined；答空 ⇒ ""；有值 ⇒ 原样交回', () => {
    expect(collectHoverContents([dialectContribution('abstain')], HOVER_REQUEST)).toBeUndefined();
    expect(collectHoverContents([dialectContribution('empty')], HOVER_REQUEST)).toBe('');
    expect(collectHoverContents([dialectContribution('value')], HOVER_REQUEST)).toBe('ACME HOVER');
  });

  it('供方按请求的 languageId 自认：别门语言的请求它有权弃权，宿主如实转交', () => {
    const other = { ...HOVER_REQUEST, languageId: 'some-other-language' } as unknown as EditorLanguageServiceRequest;
    expect(collectHoverContents([dialectContribution('value')], other)).toBeUndefined();
  });

  it('宿主把身份三格（path / languageId / version）原样递给供方（不猜、不改写）', () => {
    let seen: Record<string, unknown> | undefined;
    const contribution: EditorLanguageServiceContribution = {
      id: 'acme-hover',
      provide: (request) => {
        seen = request as unknown as Record<string, unknown>;
        return { kind: 'hover', contents: 'X' };
      },
    };
    collectHoverContents([contribution], HOVER_REQUEST);
    expect(seen).toBeDefined();
    expect(seen!.languageId).toBe(DIALECT_ID);
    expect(seen!.path).toBe('/proj/a' + PROBE_EXTENSION);
    expect(seen!.version).toBe(3);
  });

  it('大纲（并集腿）：弃权与空作答都不加项，有值才进树', () => {
    const request = { kind: 'documentSymbol', languageId: DIALECT_ID } as unknown as EditorLanguageServiceRequest;
    const symbol: EditorDocumentSymbol = { name: 'ACME', kind: 'section', startLine: 1, endLine: 2 };
    const answer = (symbols: EditorDocumentSymbol[] | undefined): EditorLanguageServiceContribution => ({
      id: 'acme-symbols',
      provide: (req) =>
        req.kind === 'documentSymbol'
          ? symbols === undefined
            ? undefined
            : { kind: 'documentSymbol', symbols }
          : undefined,
    });
    expect(collectDocumentSymbols([answer(undefined)], request)).toEqual([]);
    expect(collectDocumentSymbols([answer([])], request)).toEqual([]);
    expect(collectDocumentSymbols([answer([symbol])], request).map((item) => item.name)).toEqual(['ACME']);
  });
});

/* ============================== 3. 按 languageId 弃权 ============================== */

describe('③ 按 languageId 弃权：没点名的语言不替它去问槽（不被别门抢答）', () => {
  it('旧桥语言（legacyBridge）没点名 documentHighlight ⇒ provider 挂上但请求时弃权', () => {
    const fake = fakeMonaco();
    const handle = installSlotServiceLegs(fake.monaco, ['documentHighlight']);
    const provider = providerOf(fake, 'documentHighlight', BRIDGE_ID) as Monaco.languages.DocumentHighlightProvider;
    const query = installKernel([
      {
        id: 'other-language-provider',
        provide: () => ({ kind: 'documentHighlight', highlights: [{ line: 1, startColumn: 1, endColumn: 2, kind: 'write' }] }),
      },
    ]);
    const result = provider.provideDocumentHighlights(modelOf(BRIDGE_ID), position(1, 1), TOKEN);
    expect(result, '没点名这一腿的语言被替它作答了（会叠上别门的答案）').toBeUndefined();
    expect(query, '弃权腿不该去问语言服务槽').not.toHaveBeenCalled();
    handle.dispose();
  });

  it('点名了 documentHighlight 的方言才去问槽，请求带的是**这门语言**的 id', () => {
    const fake = fakeMonaco();
    const handle = installSlotServiceLegs(fake.monaco, ['documentHighlight']);
    const provider = providerOf(fake, 'documentHighlight', HIGHLIGHT_ID) as Monaco.languages.DocumentHighlightProvider;
    const seen: string[] = [];
    const query = installKernel([
      {
        id: 'acme-highlight',
        provide: (request) => {
          seen.push((request as { languageId?: string }).languageId ?? '<none>');
          return { kind: 'documentHighlight', highlights: [{ line: 1, startColumn: 1, endColumn: 2, kind: 'write' }] };
        },
      },
    ]);
    const result = provider.provideDocumentHighlights(modelOf(HIGHLIGHT_ID), position(1, 1), TOKEN);
    expect(result).toHaveLength(1);
    expect(query).toHaveBeenCalled();
    expect(seen).toEqual([HIGHLIGHT_ID]);
    handle.dispose();
  });

  it('未登记的语言 id ⇒ 同一枚 provider 也弃权（没有 descriptor 就不替它说话）', () => {
    const fake = fakeMonaco();
    const handle = installSlotServiceLegs(fake.monaco, ['documentHighlight']);
    const provider = providerOf(fake, 'documentHighlight', HIGHLIGHT_ID) as Monaco.languages.DocumentHighlightProvider;
    const query = installKernel([
      { id: 'x', provide: () => ({ kind: 'documentHighlight', highlights: [] }) },
    ]);
    expect(provider.provideDocumentHighlights(modelOf('ghost-language'), position(1, 1), TOKEN)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    handle.dispose();
  });
});

/* ============================== 4. fail-safe ============================== */

describe('④ 缺 slotServices ⇒ 零腿挂载（fail-safe）', () => {
  const ALL_KINDS: readonly SlotServiceKind[] = [
    'definition',
    'documentSymbol',
    'references',
    'foldingRange',
    'inlayHint',
    'completion',
    'hover',
    'signatureHelp',
    'formatting',
    'rename',
    'documentHighlight',
    'selectionRange',
    'codeLens',
    'semanticToken',
    'implementation',
    'codeAction',
  ];

  it('什么都没声明的 descriptor：收口传任何 kind 都不挂它', () => {
    for (const kind of ALL_KINDS) {
      const calls: string[] = [];
      const handle = registerForLanguageServices(
        {} as unknown as typeof Monaco,
        (_monaco, languageId) => {
          calls.push(languageId);
          return { dispose: () => undefined };
        },
        kind,
      );
      handle.dispose();
      expect(calls, `缺 slotServices 的 descriptor 被挂上了 ${kind}`).not.toContain(BARE_ID);
    }
  });

  it('什么都没声明 ⇒ 真实安装器也一枚都不挂（不传 kind 的旧行为同理）', () => {
    const fake = fakeMonaco();
    const symbols = installDocumentSymbolProvider(fake.monaco, { resolve: () => [] });
    const hover = installSlotServiceLegs(fake.monaco, ['hover']);
    const completion = installSlotServiceLegs(fake.monaco, ['completion']);
    const folding = installFoldingRangeProvider(fake.monaco, { resolve: () => [] });
    for (const kind of ['documentSymbol', 'hover', 'completion', 'foldingRange'] as const) {
      expect(selectorsOf(fake, kind)).not.toContain(BARE_ID);
    }
    // 旧行为（不传 kind）同样不挂它：没有 languageServices 就不是旧桥语言
    const bridgeCalls: string[] = [];
    const bridge = registerForLanguageServices(
      {} as unknown as typeof Monaco,
      (_monaco, languageId) => {
        bridgeCalls.push(languageId);
        return { dispose: () => undefined };
      },
    );
    bridge.dispose();
    expect(bridgeCalls).not.toContain(BARE_ID);
    symbols.dispose();
    hover.dispose();
    completion.dispose();
    folding.dispose();
  });

  it('`slotServices: []` 也是零腿（空表不是"全都声明"）', () => {
    const fake = fakeMonaco();
    const hover = installSlotServiceLegs(fake.monaco, ['hover']);
    expect(selectorsOf(fake, 'hover')).not.toContain(EMPTY_ID);
    hover.dispose();
    const calls: string[] = [];
    const handle = registerForLanguageServices(
      {} as unknown as typeof Monaco,
      (_monaco, languageId) => {
        calls.push(languageId);
        return { dispose: () => undefined };
      },
      'hover',
    );
    handle.dispose();
    expect(calls).not.toContain(EMPTY_ID);
  });
});