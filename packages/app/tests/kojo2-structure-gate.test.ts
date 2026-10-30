/**
 * K2-SURFACE-DEFAULT（本批，接续 K2-STRUCTURE-GATE 的批次十一）：`.kojo2` 的**语言面**
 * （折叠 / 大纲 / 着色 / 补全 / 悬停 / 引用 / 改名 / 签名 / codelens / 高亮 / 扩选 / 诊断 /
 * 缩进落字 / 格式化）全部从 cutover 开关解耦——开关关（缺省 `v1-only`）时照样可用；
 * 只剩**有副作用**的迁移 code action（以及存储 / 迁移入口 / `.kojo` 解析器切换）仍受门控。
 *
 * 本文件逐层钉住现行形状：
 * 1. **宿主装配段**（`ui/editor-global-providers.ts`）：语言面安装器全挂在
 *    `if (isKojo2CutoverEnabled())` 块**之外**，块内只剩迁移 code action（源码判据见 ④）；
 * 2. **安装器**（`monaco/kojo2-folding.ts` / 共享收口的大纲腿）：自身不再读开关；
 * 3. **解析链**（worker / core AST）：保持懒装载——注册不拉 worker，首次请求才动态 import。
 *
 * monaco 运行时不进 node（本池 environment = node），故 `../src/monaco/entry` 用 `vi.mock`
 * 桩掉：万能 Proxy 记录每一次调用的「路径 + 实参」，够本文件判定"哪一门语言挂上了什么"。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';

interface StubCall {
  readonly path: string;
  readonly args: readonly unknown[];
}

const stub = vi.hoisted(() => {
  const state = { calls: [] as StubCall[], recording: true };
  const invoke = (path: string, args: readonly unknown[]): unknown => {
    // B4：组合根挂载时会问"哪些语言已认领"（`applyAllMonacoLanguageSurfaces` 只给认领过的
    // 语言落语言面）。这是**读数**不是注册：答空表（这台替身没认领过任何语言）且不进账本，
    // 否则下面"注册 API 数量不多不少"的断言会把一次读取算成一枚挂载。
    if (path === 'monaco.languages.getLanguages') return [];
    if (state.recording) state.calls.push({ path, args });
    return { dispose: () => undefined };
  };
  const universal = (path: string): unknown =>
    new Proxy(function kojoMonacoStub() {}, {
      get: (_target, key) =>
        typeof key === 'symbol' || key === 'then' ? undefined : universal(`${path}.${String(key)}`),
      apply: (_target, _thisArg, args) => invoke(path, (args ?? []) as readonly unknown[]),
      construct: () => ({ stubConstructed: path }),
    });
  return { state, universal };
});

vi.mock('../src/monaco/entry', () => ({
  editor: stub.universal('monaco.editor'),
  languages: stub.universal('monaco.languages'),
  Uri: stub.universal('monaco.Uri'),
  Range: stub.universal('monaco.Range'),
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
}));

// 动态 import：保证上面的桩先就位（模块 import 期就会碰 monaco 运行时）
const { ensureGlobalProviders, disposeGlobalProviders } = await import(
  '../src/ui/editor-global-providers'
);
const flag = await import('../src/ui/kojo2-flag');
const { KOJO2_LANGUAGE_ID } = await import('@kojo/kojo-lang');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
/** 真 2.0 夹具：大纲 provider 要真出符号（不是空壳 provider） */
const FIXTURE = readFileSync(resolve(HERE, 'fixtures', 'kojo2', 'symbols.kojo2'), 'utf8');

const FOLDING = 'monaco.languages.registerFoldingRangeProvider';
const SYMBOLS = 'monaco.languages.registerDocumentSymbolProvider';
const CODE_ACTION = 'monaco.languages.registerCodeActionProvider';
const ON_TYPE = 'monaco.languages.registerOnTypeFormattingEditProvider';
const DOC_FORMAT = 'monaco.languages.registerDocumentFormattingEditProvider';
const RANGE_FORMAT = 'monaco.languages.registerDocumentRangeFormattingEditProvider';
const SEMANTIC = 'monaco.languages.registerDocumentSemanticTokensProvider';
const COMPLETION = 'monaco.languages.registerCompletionItemProvider';
const HOVER = 'monaco.languages.registerHoverProvider';
const REFERENCE = 'monaco.languages.registerReferenceProvider';
const RENAME = 'monaco.languages.registerRenameProvider';
const SIGNATURE = 'monaco.languages.registerSignatureHelpProvider';
const CODELENS = 'monaco.languages.registerCodeLensProvider';
const HIGHLIGHT = 'monaco.languages.registerDocumentHighlightProvider';
const SELECTION = 'monaco.languages.registerSelectionRangeProvider';
const INLAY = 'monaco.languages.registerInlayHintsProvider';

/** 语言面：默认档下必须各挂一枚（只认 `kojo2`）的注册 API */
const SURFACE_APIS: readonly string[] = [
  FOLDING,
  SEMANTIC,
  COMPLETION,
  HOVER,
  REFERENCE,
  RENAME,
  SIGNATURE,
  CODELENS,
  HIGHLIGHT,
  SELECTION,
  ON_TYPE,
  DOC_FORMAT,
  RANGE_FORMAT,
  INLAY,
];

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function callsOf(path: string): StubCall[] {
  return stub.state.calls.filter((call) => call.path === path);
}

/** 只留 selector = `kojo2` 的那几枚（v1 的同名注册不混进来） */
function kojo2CallsOf(path: string): StubCall[] {
  return callsOf(path).filter((call) => call.args[0] === KOJO2_LANGUAGE_ID);
}

function mount(): void {
  stub.state.calls.length = 0;
  stub.state.recording = true;
  ensureGlobalProviders();
}

// LAU-3：缺省档翻到了 `2.0-default`（开关**开着**）⇒ 需要"关"的用例由本钩子显式落档，
// 不能靠"没设置过"。
beforeEach(() => {
  flag.setKojo2CutoverEnabled(false);
});

afterEach(() => {
  disposeGlobalProviders();
  flag.setKojo2CutoverEnabled(false);
});

/* ==================== ① 开关关：只读面照常可用 ==================== */

describe('① 开关关（缺省 v1-only）：折叠与大纲仍可用', () => {
  it('两枚只读 provider 各注册一枚（只认 kojo2），大纲真出符号树', () => {
    expect(flag.isKojo2CutoverEnabled()).toBe(false);
    mount();

    expect(kojo2CallsOf(FOLDING)).toHaveLength(1);
    const symbols = kojo2CallsOf(SYMBOLS);
    // B2（2026-10-24）：大纲 provider 现在来自**共享收口**（`installDocumentSymbolProvider`
    // 那一枚，按 kojo2 descriptor 的 `slotServices: ['documentSymbol']` 挂上），不再是
    // `kojo2-symbols.ts` 自建的那一枚。本文件能钉的只有"挂上了、且开关关也挂"——
    // 它有没有真出符号取决于**槽里有没有供方**，而供方是插件（`@kojo/plugin-kojo-lang`），
    // 那件事由 `packages/plugins/kojo-lang/tests/plugin.test.ts` 用真夹具钉住。
    // 在这里硬塞一份假槽贡献只会把"宿主装配"与"插件判据"两件事搅成一件。
    expect(symbols).toHaveLength(1);
    expect(typeof (symbols[0]!.args[1] as Monaco.languages.DocumentSymbolProvider).provideDocumentSymbols)
      .toBe('function');
  });

  it('折叠 provider 的注册与"是否装了解析链"无关：缺省客户端仍是懒的', () => {
    mount();
    // 注册只发生一次，且注册那一刻没有取 worker（取客户端是 provider 内部第一次被问才做）
    expect(kojo2CallsOf(FOLDING)).toHaveLength(1);
    expect(stub.state.calls.some((call) => call.path.includes('getKojo2WorkerClient'))).toBe(false);
  });
});

/* ==================== ② 开关开：行为不变 ==================== */

describe('② 开关开：两枚只读面照旧各注册一枚', () => {
  it('不多不少，selector 仍是 kojo2', () => {
    flag.setKojo2CutoverEnabled(true);
    expect(flag.isKojo2CutoverEnabled()).toBe(true);
    mount();

    expect(kojo2CallsOf(FOLDING)).toHaveLength(1);
    expect(kojo2CallsOf(SYMBOLS)).toHaveLength(1);
    expect(kojo2CallsOf(FOLDING)[0]!.args[0]).toBe(KOJO2_LANGUAGE_ID);
    expect(kojo2CallsOf(SYMBOLS)[0]!.args[0]).toBe(KOJO2_LANGUAGE_ID);
  });
});

/* ==================== ③ 写面只剩迁移 code action 受门控 ==================== */

describe('③ 默认档：语言面全挂，只剩迁移 code action 不挂', () => {
  it('开关关 ⇒ 14 枚语言面注册 API 全都挂着（缩进 / 格式化也算语言面），code action 零挂', () => {
    expect(flag.isKojo2CutoverEnabled()).toBe(false);
    mount();
    for (const api of SURFACE_APIS) {
      // `>= 1`：同一语言允许多枚 provider 并存（补全另有用户片段那一枚）
      expect(
        kojo2CallsOf(api).length,
        `${api} 在默认档下没挂（语言面被门控了）`,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(kojo2CallsOf(CODE_ACTION), '一键迁移 code action 属迁移入口，默认档不该挂').toHaveLength(
      0,
    );
  });

  it('开关开 ⇒ 语言面数量不变，code action 恰好挂一枚（门控本身没被拆掉）', () => {
    flag.setKojo2CutoverEnabled(true);
    mount();
    for (const api of SURFACE_APIS) {
      expect(kojo2CallsOf(api).length, api).toBeGreaterThanOrEqual(1);
    }
    expect(kojo2CallsOf(CODE_ACTION)).toHaveLength(1);
  });
});

/* ==================== ④ 三层门控的源码形状 ==================== */

describe('④ 源码：语言面全在 cutover 块之外，安装器自身不再读开关', () => {
  const hostSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'ui', 'editor-global-providers.ts'),
    'utf8',
  );
  const foldingSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'kojo2-folding.ts'),
    'utf8',
  );
  const symbolsSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'kojo2-symbols.ts'),
    'utf8',
  );

  /** `if (isKojo2CutoverEnabled()) { … }` 的整段（按块尾那行 4 空格 `}` 收口） */
  function cutoverBlock(source: string): string {
    const start = source.indexOf('if (isKojo2CutoverEnabled()) {');
    expect(start).toBeGreaterThan(-1);
    const offset = source.slice(start).search(/^    \}$/m);
    expect(offset).toBeGreaterThan(-1);
    return source.slice(start, start + offset + 5);
  }

  it('宿主：切流块里只剩 code action；折叠 / 大纲 / 缩进 / 格式化全在块外', () => {
    const block = cutoverBlock(hostSource);
    expect(block).toContain('installKojo2CodeActionProvider(monaco');
    expect(block).not.toContain('installKojo2FoldingProvider');
    expect(block).not.toContain('installKojo2DocumentSymbolProvider');
    expect(block).not.toContain('installKojo2IndentProvider');
    expect(block).not.toContain('installKojo2DocumentFormatter');
    expect(block).not.toContain('installKojo2SemanticTokensProvider');

    expect(hostSource).toContain('globalDisposers.push(installKojo2FoldsCache());');
    // B3h（2026-10-30）：折叠的**原生注册**也清零了 —— 注册改走 `kojo-folding.ts` 的共享收口
    // （kojo2 由 descriptor 的 `slotServices: ['foldingRange']` 点名），宿主这一段只装预取器。
    expect(hostSource).not.toContain('installKojo2FoldingProvider');
    // B2（2026-10-24）：大纲的原生装配行**已删除** —— 它改由 `installDocumentSymbolProvider`
    // 那一枚槽腿挂上（kojo2 descriptor 的 `slotServices: ['documentSymbol']`），供方是插件
    // `@kojo/plugin-kojo-lang`。这里反过来钉住"宿主不再自建 2.0 大纲 provider"。
    expect(hostSource).not.toContain('installKojo2DocumentSymbolProvider');
  });

  it('安装器：语言面都不再读 cutover 开关（不再自挡第二道）', () => {
    expect(foldingSource).not.toMatch(/isKojo2CutoverEnabled/);
    expect(symbolsSource).not.toMatch(/isKojo2CutoverEnabled/);
    for (const rel of [
      'kojo2-semantic.ts',
      'kojo2-highlight.ts',
      'kojo2-format.ts',
      'kojo2-codelens.ts',
      'kojo2-indent.ts',
      'kojo2-providers.ts',
      'kojo2-references.ts',
      'kojo2-rename.ts',
      'kojo2-signature.ts',
      'kojo2-selection-range.ts',
      'kojo2-callhierarchy.ts',
    ]) {
      const source = readFileSync(
        resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', rel),
        'utf8',
      );
      expect(source, `${rel} 仍读切流开关`).not.toMatch(/isKojo2CutoverEnabled/);
    }
  });

  it('解析链保持懒载：折叠的缺省客户端仍是动态 import', () => {
    expect(foldingSource).toMatch(/await import\('\.\/tree-sitter\/kojo2-worker-runtime'\)/);
    // B3h：本文件**不注册任何 Monaco provider**（原生注册形状清零，注册在共享收口那一枚）
    expect(foldingSource).not.toMatch(/registerFoldingRangeProvider/);
  });
});
