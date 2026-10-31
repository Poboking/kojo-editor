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
  declaredSlotKinds,
  descriptorForLanguageId,
  registerLanguage,
  usesLegacyBridge,
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

/** 新写法的**空表**（`services.slot: []`）：空表判据走 `declaredSlotKinds`，与旧写法同一道闸 */
const SLOT_EMPTY_ID = 'acmedialectslotempty';

/** 两种写法**同给**（`slotServices` + `services.slot`）：判据源 `declaredSlotKinds` 以 `services.slot` 为准 */
const PREFER_ID = 'acmedialectprefer';

/** 旧桥的旧拼法（`languageServices: true`）：与 `services.legacyBridge` 成对走 `usesLegacyBridge` */
const BRIDGE_OLD_ID = 'acmedialectbridgeold';

const PROBE_IDS = [
  DIALECT_ID,
  MODERN_ID,
  BRIDGE_ID,
  BARE_ID,
  EMPTY_ID,
  HIGHLIGHT_ID,
  SLOT_EMPTY_ID,
  PREFER_ID,
  BRIDGE_OLD_ID,
] as const;

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

const SLOT_EMPTY: LanguageDescriptor = dialectDescriptor(SLOT_EMPTY_ID, {
  services: { slot: [] },
});

/** 同给两枚声明：`services.slot` 只点名 documentSymbol；旧拼法的 hover 应当**不**作数 */
const PREFER: LanguageDescriptor = dialectDescriptor(PREFER_ID, {
  slotServices: ['hover'],
  services: { slot: ['documentSymbol'] },
});

const BRIDGE_OLD: LanguageDescriptor = dialectDescriptor(BRIDGE_OLD_ID, {
  languageServices: true,
});

for (const descriptor of [DIALECT, MODERN, BRIDGE, BARE, EMPTY, HIGHLIGHT, SLOT_EMPTY, PREFER, BRIDGE_OLD]) {
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

/**
 * fail-safe 组的「kind 全集」：**从源码解析** `SlotServiceKind` 联合，口径与
 * `language-slot-conformance.test.ts` 的 `slotServiceKindsFromSource` 逐字相同
 * （只剥行注释、只留字面量）。
 *
 * 钉什么：联合里新增一条 kind 时，本文件的 fail-safe 循环**自动**把它跑进去。
 * 不钉会怎样：手抄清单漏跟新 kind ⇒ 新腿对"什么都没声明的方言"静默放行（fail-safe
 * 组恰好只测抄到的那几条），挂载漏网点从此不进任何闸。
 */
function slotServiceKindsFromSource(): readonly string[] {
  const text = readFileSync(path.resolve(APP_SRC, 'monaco', 'language-registry.ts'), 'utf8');
  const union = /export type SlotServiceKind =([\s\S]*?);/.exec(text);
  if (union === null) throw new Error('[dialect-extension] language-registry.ts 里找不到 SlotServiceKind 联合');
  const body = (union[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1] as string);
}

/** 现算全集（fail-safe 循环与映射覆盖对拍都读这一份） */
const ALL_SLOT_KINDS = slotServiceKindsFromSource() as readonly SlotServiceKind[];

/**
 * **能力面 ↔ 槽腿的全量映射**（16 条槽腿逐一对应一张已交付能力面；与
 * `language-slot-conformance.test.ts` 的 `SLOT_KIND_SUPPLY.capability` 同一份事实）。
 *
 * 钉什么：每条 `SlotServiceKind` 都有且只有一面对到的能力，能力↔腿的对表不再有"只写了
 * 三条样例"的空窗。不钉会怎样：新增 kind 时映射静默缺一格，方言 descriptor 照矩阵声明
 * 了能力却没点腿（或反之）——组 0 的一致性检查只会查它认识的那几面，缺口不被发现。
 */
const CAPABILITY_TO_SLOT_LEG: Readonly<Partial<Record<LanguageCapability, SlotServiceKind>>> = {
  [LanguageCapability.Definition]: 'definition',
  [LanguageCapability.Outline]: 'documentSymbol',
  [LanguageCapability.References]: 'references',
  [LanguageCapability.Folding]: 'foldingRange',
  [LanguageCapability.Inlay]: 'inlayHint',
  [LanguageCapability.Completion]: 'completion',
  [LanguageCapability.Hover]: 'hover',
  [LanguageCapability.Signature]: 'signatureHelp',
  [LanguageCapability.Format]: 'formatting',
  [LanguageCapability.Rename]: 'rename',
  [LanguageCapability.Highlight]: 'documentHighlight',
  [LanguageCapability.Selection]: 'selectionRange',
  [LanguageCapability.CodeLens]: 'codeLens',
  [LanguageCapability.Semantic]: 'semanticToken',
  [LanguageCapability.Implementation]: 'implementation',
  [LanguageCapability.Diagnostics]: 'codeAction',
};

/** 不驱动 Monaco 注册的能力面（缩进 / 括号走语言配置；调用层级无注册 API；预览是内建窗） */
const NON_SLOT_CAPABILITIES: readonly LanguageCapability[] = [
  LanguageCapability.Indent,
  LanguageCapability.Brackets,
  LanguageCapability.CallHierarchy,
  LanguageCapability.Preview,
];

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

  it('capabilities 只声明与点名槽腿对得上的面（对表 = 全量映射 CAPABILITY_TO_SLOT_LEG）', () => {
    for (const descriptor of [DIALECT, MODERN, HIGHLIGHT]) {
      for (const capability of descriptor.capabilities ?? []) {
        const leg = CAPABILITY_TO_SLOT_LEG[capability];
        expect(leg, `${capability} 没有对应的槽腿映射`).toBeDefined();
        expect(
          [...declaredSlotKinds(descriptor)],
          `${capability} 声明了却没有点名对应的槽腿`,
        ).toContain(leg);
      }
    }
  });

  it('能力面 ↔ 槽腿对表是**全量**：十六条腿各有面、每面要么在表里要么点名不驱动注册', () => {
    // 钉什么：映射的像 = 从源码解析的 kind 全集（一对一），且 20 枚能力面恰好被
    // 「映射键 ∪ 非槽腿面」覆盖、两块不相交。不钉会怎样：新增 kind / 新增能力时这里
    // 静默缺一格，组 0 上一条方言检查只会查它认识的那几面（对表从此是半张）。
    const mappedLegs = Object.values(CAPABILITY_TO_SLOT_LEG);
    expect(new Set(mappedLegs).size, '两条腿压到同一面能力（对表已散）').toBe(mappedLegs.length);
    expect([...mappedLegs].sort(), '映射腿与 SlotServiceKind 全集对不上（新增 kind 未补对表）').toEqual(
      [...ALL_SLOT_KINDS].sort(),
    );
    const mappedCapabilities = Object.keys(CAPABILITY_TO_SLOT_LEG) as LanguageCapability[];
    const union = new Set<LanguageCapability>([...mappedCapabilities, ...NON_SLOT_CAPABILITIES]);
    expect([...union].sort(), '有一面能力既不在对表里、也没点名"不驱动注册"').toEqual(
      [...Object.values(LanguageCapability)].sort(),
    );
    for (const capability of NON_SLOT_CAPABILITIES) {
      expect(CAPABILITY_TO_SLOT_LEG[capability], `${capability} 不该有槽腿映射`).toBeUndefined();
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

  it('两拼法**同判据**：`services.legacyBridge` 与 `languageServices: true` 都命中 usesLegacyBridge', () => {
    // 钉什么：旧桥的判别只有一处口径（`language-registry.ts` 的 usesLegacyBridge，OR 两拼法），
    // 新拼法语言与旧拼法语言铺同样的全腿。不钉会怎样：消费方各自再拼一份三元判据，
    // 漏掉一边就是"声明了旧桥却一枚都不挂"的静默方言。
    expect(usesLegacyBridge(BRIDGE)).toBe(true);
    expect(usesLegacyBridge(BRIDGE_OLD)).toBe(true);
    expect(usesLegacyBridge(DIALECT)).toBe(false);
    expect(usesLegacyBridge(PREFER)).toBe(false);
    const fake = fakeMonaco();
    const folding = installFoldingRangeProvider(fake.monaco, { resolve: () => [] });
    const completion = installSlotServiceLegs(fake.monaco, ['completion']);
    expect(selectorsOf(fake, 'foldingRange'), 'languageServices: true 的旧桥语言没铺全腿').toContain(
      BRIDGE_OLD_ID,
    );
    expect(selectorsOf(fake, 'completion'), 'languageServices: true 的旧桥语言没铺全腿').toContain(
      BRIDGE_OLD_ID,
    );
    folding.dispose();
    completion.dispose();
  });

  it('`services.slot` 与 `slotServices` **同给 ⇒ 以 services.slot 为准**（declaredSlotKinds 的优先序）', () => {
    // 钉什么：descriptor 头注写死"两者都给了以 `services.slot` 为准"，挂载面必须读同一枚
    // declaredSlotKinds（`services.slot ?? slotServices`）。不钉会怎样：挂载点若先读旧拼法，
    // 新拼法的改名会被旧表悄悄顶掉——声明面与挂载面分家，正是 SDK-DIALECT 头注点名的断口。
    expect([...declaredSlotKinds(PREFER)]).toEqual(['documentSymbol']);
    const fake = fakeMonaco();
    const symbols = installDocumentSymbolProvider(fake.monaco, { resolve: () => [] });
    const hover = installSlotServiceLegs(fake.monaco, ['hover']);
    expect(selectorsOf(fake, 'documentSymbol'), 'services.slot 点名的 documentSymbol 没挂上').toContain(
      PREFER_ID,
    );
    expect(
      selectorsOf(fake, 'hover'),
      'services.slot 为准：旧拼法 slotServices 里的 hover 不该再作数',
    ).not.toContain(PREFER_ID);
    symbols.dispose();
    hover.dispose();
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

  it('逐条点名的方言（非旧桥）：只挂点名的腿，未点名的腿挂载面与请求面都不问槽', () => {
    // 钉什么：弃权闸不只旧桥一侧有——`slotServices` 只点名部分腿的语言（DIALECT 点了
    // documentSymbol+hover、没点 documentHighlight），未点名的腿 (a) 挂载面根本不挂它、
    // (b) 被同一枚共享 provider 问到这篇 model 时弃权且不问槽。不钉会怎样：现只在旧桥
    // 一侧测了弃权，点名语言一旦被判据放行（如 servesSlotOf 抄漏 declaredSlotKinds），
    // 它的未点名腿会把别门供方的答案当自己的再交一遍。
    const fake = fakeMonaco();
    const handle = installSlotServiceLegs(fake.monaco, ['documentHighlight']);
    expect(selectorsOf(fake, 'documentHighlight'), '未点名 documentHighlight 的方言被挂上了这一腿').not.toContain(
      DIALECT_ID,
    );
    const provider = providerOf(fake, 'documentHighlight', HIGHLIGHT_ID) as Monaco.languages.DocumentHighlightProvider;
    const query = installKernel([
      {
        id: 'other-highlight-provider',
        provide: () => ({
          kind: 'documentHighlight',
          highlights: [{ line: 1, startColumn: 1, endColumn: 2, kind: 'write' }],
        }),
      },
    ]);
    expect(
      provider.provideDocumentHighlights(modelOf(DIALECT_ID), position(1, 1), TOKEN),
      '点名了别腿的语言在 documentHighlight 上被替它作答了',
    ).toBeUndefined();
    expect(query, '未点名的腿不该去问语言服务槽').not.toHaveBeenCalled();
    handle.dispose();
  });

  it('services.slot 点名的腿在请求时会问槽（新拼法语言的正向半格）', () => {
    // 钉什么：`services.slot` 与 `slotServices` 不仅同挂、也同答——请求带的是这门语言的
    // id，槽里的供方按它自认。不钉会怎样：只钉了"同挂"半格；若应答腿读错了声明面
    // （挂上但被弃权闸拦死），方言作者会看到"provider 在、功能永远空白"的静默失效。
    const fake = fakeMonaco();
    const handle = installSlotServiceLegs(fake.monaco, ['hover']);
    const provider = providerOf(fake, 'hover', MODERN_ID) as Monaco.languages.HoverProvider;
    const seen: string[] = [];
    installKernel([
      {
        id: 'acme-hover',
        provide: (request) => {
          seen.push((request as { languageId?: string }).languageId ?? '<none>');
          return { kind: 'hover', contents: 'MODERN HOVER' };
        },
      },
    ]);
    const hover = provider.provideHover(modelOf(MODERN_ID), position(1, 1), TOKEN);
    expect(hover).toBeDefined();
    expect(seen).toEqual([MODERN_ID]);
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
  it('kind 全集来自源码解析：非空、无重复、至少覆盖当前十六条（防解析口径本身失效）', () => {
    // 钉什么：fail-safe 循环的燃料（ALL_SLOT_KINDS）是**真表**而不是手抄清单——下界断言
    // 保证正则哪天解析空了也不会把整组变成空转的假绿。不钉会怎样：全集抄旧 = 新 kind
    // 永远不进 fail-safe 循环；解析坏 = 循环零轮，两种"静默通过"都在这一格红。
    expect(ALL_SLOT_KINDS.length).toBeGreaterThan(0);
    expect(new Set(ALL_SLOT_KINDS).size, `SlotServiceKind 解析出重复成员：${ALL_SLOT_KINDS.join(',')}`).toBe(
      ALL_SLOT_KINDS.length,
    );
    expect([...ALL_SLOT_KINDS]).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it('什么都没声明的 descriptor：收口传任何 kind 都不挂它', () => {
    for (const kind of ALL_SLOT_KINDS) {
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

  it('`services.slot: []`（新写法空表）同样零腿：逐 kind 全量跑 fail-safe', () => {
    // 钉什么：空表在**新拼法**里也等于"一枚都不挂"——声明面判据（declaredSlotKinds 返回 []）
    // 与挂载面（每条 kind 都不挂）成对钉住。不钉会怎样：只钉旧拼法的空表；新拼法若被某处
    // 当成"没写"回退成别的默认（或 ?? 链写歪），照指南用新写法清空的方言会被悄悄铺腿。
    expect([...declaredSlotKinds(SLOT_EMPTY)]).toEqual([]);
    for (const kind of ALL_SLOT_KINDS) {
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
      expect(calls, `services.slot: [] 的 descriptor 被挂上了 ${kind}`).not.toContain(SLOT_EMPTY_ID);
    }
    const fake = fakeMonaco();
    const hover = installSlotServiceLegs(fake.monaco, ['hover']);
    const symbols = installDocumentSymbolProvider(fake.monaco, { resolve: () => [] });
    expect(selectorsOf(fake, 'hover')).not.toContain(SLOT_EMPTY_ID);
    expect(selectorsOf(fake, 'documentSymbol')).not.toContain(SLOT_EMPTY_ID);
    hover.dispose();
    symbols.dispose();
  });
});