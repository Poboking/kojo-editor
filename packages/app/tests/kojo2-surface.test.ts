/**
 * K2-SURFACE-DEFAULT：Kojo 2.0 语言面**默认可见**（批次十 S5）。
 *
 * 钉四件事：
 * ① **两态都登记**：切流关（显式 `v1-only`）/ 开（旧键 `'on'` ⇒ `dual`）时，`.kojo2` 都有 descriptor、
 *    都挂 Monaco 面（扩展名 / Monarch / 语言配置），认路不再落到 `plaintext`；
 * ② **能力矩阵两态可读且逐项相同**：descriptor 的 `capabilities` = 矩阵里非豁免的那一份，
 *    开关只门控写回 / 迁移 / 切换，不门控语言面；
 * ③ **运行期开 ↔ 关不丢能力**：进程级注册表在模块求值后不再随开关增减；
 * ④ **扩展名归属**：`.kojo` / `.kojo2` 归 2.0，`.kojo1` 归封存，`.erb` / `.json` /
 *    未知扩展名的认路与表内次序不变；
 *    2.0 不声明 `structure` / `languageServices`（原因见 `monaco/languages.ts` 的注释，不硬编）。
 *
 * 单测环境是 `node`（无 window / 无 Monaco）：开关用假 localStorage，语言面用最小桩；
 * `languages.ts` 在模块求值那一刻登记 descriptor ⇒ 每个用例 `resetModules` 后重新 import。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { JSON_LANGUAGE_ID } from '../src/monaco/json-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  ALL_LANGUAGE_CAPABILITIES,
  LANGUAGE_CAPABILITY_MATRIX,
  deliveredCapabilities,
  exemptedCapabilities,
  type LanguageCapabilityRow,
} from '../src/monaco/language-capabilities';
import {
  KOJO2_LANGUAGE_ID,
  KOJO2_SOURCE_EXTENSION,
  registerKojo2Language,
} from '../src/monaco/kojo2-language';
// 2026-10-24 eraFL 批：descriptor 表多了一枚「口上 XML」。它不是 Kojo 2.0 的面，
// 但 `registerBuiltinLanguageSurfaces` 按表全量注册 ⇒ 本文件的"表内次序"断言必须看见它。
import { KOJO_XML_LANGUAGE_ID } from '../src/monaco/xml-language';

type LanguagesModule = typeof import('../src/monaco/languages');
type RegistryModule = typeof import('../src/monaco/language-registry');
type FlagModule = typeof import('../src/ui/kojo2-flag');

/** 语言面向 `registerBuiltinLanguageSurfaces` 要的那个 Monaco 形状（只用它的参数类型） */
type SurfaceMonaco = Parameters<LanguagesModule['registerBuiltinLanguageSurfaces']>[0];

/** 旧布尔兼容键：`'on'` ⇒ `dual`（见 `ui/kojo2-cutover.ts::stageFromLegacyKojo2Flag`） */
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';
/**
 * LAU-3 起缺省档 = `2.0-default`（切流语义**开着**）⇒ "关"必须显式落在盘上：
 * 一份 `v1-only` 计划（阶段是唯一真源，旧布尔键只是兼容垫片）。
 */
const KOJO2_PLAN_KEY = 'kojo.ui.kojo2Cutover.plan.v1';
const KOJO2_OFF_PLAN = JSON.stringify({ version: 2, stage: 'v1-only', overrides: {} });

interface Wire {
  readonly languages: LanguagesModule;
  readonly registry: RegistryModule;
  readonly flag: FlagModule;
}

/** 装假 window.localStorage（seedOn = 预置 `'on'`；关 = 预置 `v1-only` 计划），重装模块并取回本用例的实例 */
async function boot(seedOn: boolean): Promise<Wire> {
  const store = new Map<string, string>();
  if (seedOn) store.set(KOJO2_KEY, 'on');
  else store.set(KOJO2_PLAN_KEY, KOJO2_OFF_PLAN);
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
  vi.resetModules();
  const flag = await import('../src/ui/kojo2-flag');
  const registry = await import('../src/monaco/language-registry');
  const languages = await import('../src/monaco/languages');
  return { languages, registry, flag };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ------------------------------ Monaco 最小桩 ------------------------------ */

interface CapturedRegistration {
  readonly id: string;
  readonly extensions?: readonly string[];
  readonly aliases?: readonly string[];
}

interface SurfaceCapture {
  readonly registered: CapturedRegistration[];
  readonly monarchs: Map<string, unknown>;
  readonly configs: Map<string, unknown>;
}

/**
 * 只实现各 descriptor 的 `register` 真正碰到的几格（getLanguages / register /
 * Monarch / 语言配置）。`IndentAction` 是 `enter-rules.ts` 翻译层要的枚举。
 */
function fakeMonaco(): { readonly monaco: SurfaceMonaco; readonly captured: SurfaceCapture } {
  const registered: CapturedRegistration[] = [];
  const monarchs = new Map<string, unknown>();
  const configs = new Map<string, unknown>();
  const disposable = { dispose: (): void => undefined };
  const fake = {
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      getLanguages: (): { id: string }[] => registered.map((entry) => ({ id: entry.id })),
      register: (entry: CapturedRegistration): typeof disposable => {
        registered.push(entry);
        return disposable;
      },
      setMonarchTokensProvider: (id: string, provider: unknown): typeof disposable => {
        monarchs.set(id, provider);
        return disposable;
      },
      setLanguageConfiguration: (id: string, config: unknown): typeof disposable => {
        configs.set(id, config);
        return disposable;
      },
      // 口上 XML 的 descriptor 在 `register` 里同时挂四枚 provider（它不声明
      // `languageServices`，那 11 枚 ERB/kojo 面的 provider 与它无关）。替身必须
      // 有这四格，否则真壳能跑、这里却抛 `not a function`（同 PITFALLS 169 口径：
      // 替身缺方法要补替身，不是让源码做防御性存在检查）。
      registerFoldingRangeProvider: (): typeof disposable => disposable,
      registerHoverProvider: (): typeof disposable => disposable,
      registerCompletionItemProvider: (): typeof disposable => disposable,
      registerDocumentSymbolProvider: (): typeof disposable => disposable,
    },
    editor: {
      defineTheme: (): void => undefined,
      // 诊断注册会遍历已有 model 并订"新 model"事件
      getModels: (): unknown[] => [],
      onDidCreateModel: (): typeof disposable => disposable,
      setModelMarkers: (): void => undefined,
    },
  };
  return { monaco: fake as unknown as SurfaceMonaco, captured: { registered, monarchs, configs } };
}

/** 清一色的"两态共同面"断言：descriptor 表 / 认路 / Monaco 面 */
function expectKojo2SurfaceVisible(wire: Wire): void {
  expect(wire.registry.languageDescriptors().map((descriptor) => descriptor.id)).toEqual([
    ERB_LANGUAGE_ID,
    KOJO_LANGUAGE_ID,
    JSON_LANGUAGE_ID,
    KOJO2_LANGUAGE_ID,
    KOJO_XML_LANGUAGE_ID,
  ]);

  const descriptor = wire.registry.descriptorForPath('D:/p/M.kojo2');
  expect(descriptor?.id).toBe(KOJO2_LANGUAGE_ID);
  // LAU-3 / §6（用户 2026-10-27 口径）：作者面**只有一个「kojo」**，它就是 2.0；
  // id 仍是 `kojo2`（全仓引用 + M2 棘轮按常量名计数，改 id 是另一场迁移）。
  expect(descriptor?.label).toBe('kojo');
  expect(wire.languages.languageForPath('D:/p/M.kojo2')).toBe(KOJO2_LANGUAGE_ID);
  expect(wire.languages.languageForPath('D:/p/M.KOJO2')).toBe(KOJO2_LANGUAGE_ID);

  const { monaco, captured } = fakeMonaco();
  wire.languages.registerBuiltinLanguageSurfaces(monaco);
  expect(captured.registered.map((entry) => entry.id)).toEqual([
    ERB_LANGUAGE_ID,
    KOJO_LANGUAGE_ID,
    JSON_LANGUAGE_ID,
    KOJO2_LANGUAGE_ID,
    KOJO_XML_LANGUAGE_ID,
  ]);
  const kojo2 = captured.registered.find((entry) => entry.id === KOJO2_LANGUAGE_ID);
  // LAU-3b-FLIP：2.0 的面收主场 `.kojo` + 旧名 `.kojo2`（大小写都收）。
  expect(kojo2?.extensions).toEqual([
    KOJO_SOURCE_EXTENSION,
    KOJO_SOURCE_EXTENSION.toUpperCase(),
    KOJO2_SOURCE_EXTENSION,
    KOJO2_SOURCE_EXTENSION.toUpperCase(),
  ]);
  expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
  const config = captured.configs.get(KOJO2_LANGUAGE_ID) as
    | { readonly comments?: { readonly lineComment?: string } }
    | undefined;
  expect(config?.comments?.lineComment).toBe('//');
}

/* ============================== ① 切流关 ============================== */

describe('切流关（显式 v1-only 档）：`.kojo2` 语言面照样可见', () => {
  it('开关读数是关，但 descriptor 已登记、认路不走 plaintext、Monaco 面照挂', async () => {
    const wire = await boot(false);
    expect(wire.flag.isKojo2CutoverEnabled()).toBe(false);
    expectKojo2SurfaceVisible(wire);
    // 只认最后一段扩展名：`.kojo2.bak` 仍是 plaintext
    expect(wire.languages.languageForPath('D:/p/M.kojo2.bak')).toBe('plaintext');
  });
});

/* ============================== ② 切流开 ============================== */

describe('切流开（旧键 on ⇒ dual）：语言面与关着时逐项一致', () => {
  it('开关读数是开，注册面 / 认路 / Monaco 面与关着时相同（不因开启而多一套）', async () => {
    const wire = await boot(true);
    expect(wire.flag.isKojo2CutoverEnabled()).toBe(true);
    expectKojo2SurfaceVisible(wire);
  });

  it('认路（`.kojo` 归 2.0 / `.kojo1` 归封存 / 其它不动）', async () => {
    const off = await boot(false);
    const on = await boot(true);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['D:/p/M.kojo', KOJO2_LANGUAGE_ID],
      ['D:/p/M.KOJO', KOJO2_LANGUAGE_ID],
      ['D:/p/M.kojo1', KOJO_LANGUAGE_ID],
      ['D:/p/M.ERB', ERB_LANGUAGE_ID],
      ['D:/p/M.erm', ERB_LANGUAGE_ID],
      ['D:/p/settings.json', JSON_LANGUAGE_ID],
      ['D:/p/note.txt', 'plaintext'],
    ];
    for (const [path, expected] of cases) {
      expect(off.languages.languageForPath(path), `off:${path}`).toBe(expected);
      expect(on.languages.languageForPath(path), `on:${path}`).toBe(expected);
    }
  });
});

/* ======================= ③ 能力矩阵两态可读 ======================= */

describe('能力矩阵：两态可读、descriptor 声明 = 非豁免项', () => {
  it('矩阵覆盖两门一等语言，每行逐项有状态', async () => {
    await boot(false);
    for (const languageId of [ERB_LANGUAGE_ID, KOJO2_LANGUAGE_ID] as const) {
      const row: LanguageCapabilityRow = LANGUAGE_CAPABILITY_MATRIX[languageId];
      expect(Object.keys(row).sort()).toEqual([...ALL_LANGUAGE_CAPABILITIES].sort());
    }
    // 2.0 的已知缺口仍以 `{ exempt }` 记账（不静默消失）
    expect(exemptedCapabilities(KOJO2_LANGUAGE_ID)).toEqual(['implementation', 'callhierarchy']);
  });

  it('descriptor.capabilities = 矩阵非豁免项；开关开 / 关取值逐项相同', async () => {
    const off = await boot(false);
    const offDescriptor = off.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID);
    const on = await boot(true);
    const onDescriptor = on.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID);

    const delivered = deliveredCapabilities(KOJO2_LANGUAGE_ID);
    expect(offDescriptor?.capabilities).toEqual(delivered);
    expect(onDescriptor?.capabilities).toEqual(delivered);
    expect(onDescriptor?.capabilities).toEqual(offDescriptor?.capabilities);
    // 声明只列已交付：每一项都不落在 `{ exempt }` 上
    expect(offDescriptor?.capabilities).not.toContain('implementation');
    expect(offDescriptor?.capabilities).not.toContain('callhierarchy');
  });
});

/* ==================== ④ 运行期开 ↔ 关不丢能力 ==================== */

describe('运行期翻转开关：注册表与认路不随开关增减', () => {
  it('关 → 开 → 关：descriptor 表、认路、能力声明全程不变', async () => {
    const wire = await boot(false);
    const before = wire.registry.languageDescriptors().map((descriptor) => descriptor.id);
    const capabilitiesBefore = wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID)?.capabilities;

    wire.flag.setKojo2CutoverEnabled(true);
    expect(wire.flag.isKojo2CutoverEnabled()).toBe(true);
    expect(wire.registry.languageDescriptors().map((descriptor) => descriptor.id)).toEqual(before);
    expect(wire.languages.languageForPath('D:/p/M.kojo2')).toBe(KOJO2_LANGUAGE_ID);
    expect(wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID)?.capabilities).toEqual(
      capabilitiesBefore,
    );

    wire.flag.setKojo2CutoverEnabled(false);
    expect(wire.flag.isKojo2CutoverEnabled()).toBe(false);
    expect(wire.registry.languageDescriptors().map((descriptor) => descriptor.id)).toEqual(before);
    expect(wire.languages.languageForPath('D:/p/M.kojo2')).toBe(KOJO2_LANGUAGE_ID);
    expect(wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID)?.capabilities).toEqual(
      capabilitiesBefore,
    );
  });
});

/* ==================== ⑤ descriptor 的诚实边界 ==================== */

describe('descriptor：不硬编未交付的层', () => {
  it('不声明 languageServices（v1 通用 provider 不套到 2.0）', async () => {
    const wire = await boot(false);
    expect(wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID)?.languageServices).toBeUndefined();
  });

  it('不声明 structure：kojo2-runtime.ts 没有 StructureLanguageRuntime 适配器（原因见 languages.ts）', async () => {
    const wire = await boot(false);
    // K2-STRUCTURE-GATE（批次十一）不改这条：折叠 / 大纲走 `.kojo2` 的专属链
    //（`monaco/kojo2-folding.ts` / `monaco/kojo2-symbols.ts`，由宿主直接装配），
    // 与"是否向通用结构叠层声明 structure"无关——通用叠层仍不该接管 2.0。
    expect(wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID)?.structure).toBeUndefined();
  });

  it('register 幂等：同一 Monaco 实例重复挂面只登记一次', async () => {
    const wire = await boot(false);
    const { monaco, captured } = fakeMonaco();
    wire.languages.registerBuiltinLanguageSurfaces(monaco);
    wire.languages.registerBuiltinLanguageSurfaces(monaco);
    expect(captured.registered.map((entry) => entry.id)).toEqual([
      ERB_LANGUAGE_ID,
      KOJO_LANGUAGE_ID,
      JSON_LANGUAGE_ID,
      KOJO2_LANGUAGE_ID,
      KOJO_XML_LANGUAGE_ID,
    ]);
  });

  it('注册函数与 descriptor 用的是同一枚（`registerKojo2Language` 导出仍在）', () => {
    expect(typeof registerKojo2Language).toBe('function');
  });
});
