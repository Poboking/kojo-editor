/**
 * K2-SURFACE-DEFAULT：Kojo 2.0 语言面**默认可见**（批次十 S5）。
 *
 * 钉四件事：
 * ① **两态都登记**：切流关（缺省）/ 开（旧键 `'on'` ⇒ `dual`）时，`.kojo2` 都有 descriptor、
 *    都挂 Monaco 面（扩展名 / Monarch / 语言配置），认路不再落到 `plaintext`；
 * ② **能力矩阵两态可读且逐项相同**：descriptor 的 `capabilities` = 矩阵里非豁免的那一份，
 *    开关只门控写回 / 迁移 / 切换，不门控语言面；
 * ③ **运行期开 ↔ 关不丢能力**：进程级注册表在模块求值后不再随开关增减；
 * ④ **v1 逐字不动**：`.kojo` / `.erb` / `.json` / 未知扩展名的认路与表内次序不变；
 *    2.0 不声明 `structure` / `languageServices`（原因见 `monaco/languages.ts` 的注释，不硬编）。
 *
 * 单测环境是 `node`（无 window / 无 Monaco）：开关用假 localStorage，语言面用最小桩；
 * `languages.ts` 在模块求值那一刻登记 descriptor ⇒ 每个用例 `resetModules` 后重新 import。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

type LanguagesModule = typeof import('../src/monaco/languages');
type RegistryModule = typeof import('../src/monaco/language-registry');
type FlagModule = typeof import('../src/ui/kojo2-flag');

/** 语言面向 `registerBuiltinLanguageSurfaces` 要的那个 Monaco 形状（只用它的参数类型） */
type SurfaceMonaco = Parameters<LanguagesModule['registerBuiltinLanguageSurfaces']>[0];

/** 旧布尔兼容键：`'on'` ⇒ `dual`（见 `ui/kojo2-cutover.ts::stageFromLegacyKojo2Flag`） */
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

interface Wire {
  readonly languages: LanguagesModule;
  readonly registry: RegistryModule;
  readonly flag: FlagModule;
}

/** 装假 window.localStorage（seedOn = 预置 `'on'`），重装模块并取回本用例的实例 */
async function boot(seedOn: boolean): Promise<Wire> {
  const store = new Map<string, string>();
  if (seedOn) store.set(KOJO2_KEY, 'on');
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
    },
    editor: { defineTheme: (): void => undefined },
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
  ]);

  const descriptor = wire.registry.descriptorForPath('D:/p/M.kojo2');
  expect(descriptor?.id).toBe(KOJO2_LANGUAGE_ID);
  expect(descriptor?.label).toBe('kojo2');
  expect(wire.languages.languageForPath('D:/p/M.kojo2')).toBe(KOJO2_LANGUAGE_ID);
  expect(wire.languages.languageForPath('D:/p/M.KOJO2')).toBe(KOJO2_LANGUAGE_ID);

  const { monaco, captured } = fakeMonaco();
  wire.languages.registerBuiltinLanguageSurfaces(monaco);
  expect(captured.registered.map((entry) => entry.id)).toEqual([
    ERB_LANGUAGE_ID,
    KOJO_LANGUAGE_ID,
    JSON_LANGUAGE_ID,
    KOJO2_LANGUAGE_ID,
  ]);
  const kojo2 = captured.registered.find((entry) => entry.id === KOJO2_LANGUAGE_ID);
  expect(kojo2?.extensions).toEqual([KOJO2_SOURCE_EXTENSION]);
  expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
  const config = captured.configs.get(KOJO2_LANGUAGE_ID) as
    | { readonly comments?: { readonly lineComment?: string } }
    | undefined;
  expect(config?.comments?.lineComment).toBe('//');
}

/* ============================== ① 切流关 ============================== */

describe('切流关（缺省 v1-only）：`.kojo2` 语言面照样可见', () => {
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

  it('v1 认路逐字不动（`.kojo` / `.erb` / `.json` / plaintext 兜底）', async () => {
    const off = await boot(false);
    const on = await boot(true);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['D:/p/M.kojo', KOJO_LANGUAGE_ID],
      ['D:/p/M.KOJO', KOJO_LANGUAGE_ID],
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
    ]);
  });

  it('注册函数与 descriptor 用的是同一枚（`registerKojo2Language` 导出仍在）', () => {
    expect(typeof registerKojo2Language).toBe('function');
  });
});
