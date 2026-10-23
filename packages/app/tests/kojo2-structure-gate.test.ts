/**
 * K2-STRUCTURE-GATE（批次十一）：`.kojo2` 的**折叠**与**大纲**是只读呈现面，已从
 * `ui/kojo2-flag.ts` 的 cutover 开关里解耦——开关关（缺省 `v1-only`）时照样可用；
 * 写面（迁移 / 写回 / 缩进落字 / 格式化 / code action）仍受开关门控。
 *
 * 本文件逐层钉住现行形状：
 * 1. **宿主装配段**（`ui/editor-global-providers.ts`）：两枚只读安装器挂在
 *    `if (isKojo2CutoverEnabled())` 块**之外**，写面安装器仍在块内（源码判据见 ④）；
 * 2. **安装器**（`monaco/kojo2-folding.ts` / `monaco/kojo2-symbols.ts`）：自身不再读开关；
 * 3. **解析链**（worker / core AST）：保持懒装载——注册不拉 worker，首次请求才动态 import。
 *
 * monaco 运行时不进 node（本池 environment = node），故 `../src/monaco/entry` 用 `vi.mock`
 * 桩掉：万能 Proxy 记录每一次调用的「路径 + 实参」，够本文件判定"哪一门语言挂上了什么"。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';

interface StubCall {
  readonly path: string;
  readonly args: readonly unknown[];
}

const stub = vi.hoisted(() => {
  const state = { calls: [] as StubCall[], recording: true };
  const invoke = (path: string, args: readonly unknown[]): { dispose: () => void } => {
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
const { KOJO2_LANGUAGE_ID } = await import('../src/monaco/kojo2-constants');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
/** 真 2.0 夹具：大纲 provider 要真出符号（不是空壳 provider） */
const FIXTURE = readFileSync(resolve(HERE, 'fixtures', 'kojo2', 'symbols.kojo2'), 'utf8');

const FOLDING = 'monaco.languages.registerFoldingRangeProvider';
const SYMBOLS = 'monaco.languages.registerDocumentSymbolProvider';
const CODE_ACTION = 'monaco.languages.registerCodeActionProvider';
const ON_TYPE = 'monaco.languages.registerOnTypeFormattingEditProvider';
const DOC_FORMAT = 'monaco.languages.registerDocumentFormattingEditProvider';

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
    expect(symbols).toHaveLength(1);

    // 大纲不是空壳：provider 吃 `.kojo2` 文本真的出符号（名来自 core AST 的声明）
    const provider = symbols[0]!.args[1] as Monaco.languages.DocumentSymbolProvider;
    const model = {
      isDisposed: () => false,
      getValue: () => FIXTURE,
    } as unknown as Monaco.editor.ITextModel;
    const tree = provider.provideDocumentSymbols(model, TOKEN) as Monaco.languages.DocumentSymbol[];
    expect(tree.map((node) => node.name)).toEqual(['神社清晨', '神社黄昏']);
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

/* ==================== ③ 写面仍受开关门控 ==================== */

describe('③ 写面（缩进 / 格式化 / code action）仍受开关门控', () => {
  it('开关关 ⇒ 三枚一枚都不挂', () => {
    expect(flag.isKojo2CutoverEnabled()).toBe(false);
    mount();
    expect(kojo2CallsOf(CODE_ACTION)).toHaveLength(0);
    expect(kojo2CallsOf(ON_TYPE)).toHaveLength(0);
    expect(kojo2CallsOf(DOC_FORMAT)).toHaveLength(0);
  });

  it('开关开 ⇒ 三枚各挂一枚（门控本身没被拆掉）', () => {
    flag.setKojo2CutoverEnabled(true);
    mount();
    expect(kojo2CallsOf(CODE_ACTION)).toHaveLength(1);
    expect(kojo2CallsOf(ON_TYPE)).toHaveLength(1);
    expect(kojo2CallsOf(DOC_FORMAT)).toHaveLength(1);
  });
});

/* ==================== ④ 三层门控的源码形状 ==================== */

describe('④ 源码：只读面在 cutover 块之外，安装器自身不再读开关', () => {
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

  it('宿主：折叠 / 大纲在块外，缩进 / 格式化 / code action 仍在块内', () => {
    const block = cutoverBlock(hostSource);
    expect(block).not.toContain('installKojo2FoldingProvider');
    expect(block).not.toContain('installKojo2DocumentSymbolProvider');
    expect(block).toContain('installKojo2IndentProvider(monaco)');
    expect(block).toContain('installKojo2DocumentFormatter(monaco)');
    expect(block).toContain('installKojo2CodeActionProvider(monaco');

    expect(hostSource).toContain('globalDisposers.push(installKojo2FoldingProvider(monaco));');
    expect(hostSource).toContain(
      'globalDisposers.push(installKojo2DocumentSymbolProvider(monaco));',
    );
  });

  it('安装器：两枚都不再读 cutover 开关（不再自挡第二道）', () => {
    expect(foldingSource).not.toMatch(/isKojo2CutoverEnabled/);
    expect(symbolsSource).not.toMatch(/isKojo2CutoverEnabled/);
  });

  it('解析链保持懒载：折叠的缺省客户端仍是动态 import', () => {
    expect(foldingSource).toMatch(/await import\('\.\/tree-sitter\/kojo2-worker-runtime'\)/);
  });
});
