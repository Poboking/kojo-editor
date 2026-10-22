/**
 * LANG-PARITY-GATE：一等语言能力矩阵的闸（批次八 2026-10-22）。
 *
 * ## 钉的是什么
 *
 * ERB 与 Kojo 2.0 **同级**：`monaco/language-capabilities.ts` 的矩阵逐项写清"这面谁供的"
 * （`builtin` / `shared` / `self` / `{ exempt }`），本文件把那份声明与**注册点源码**对拍。
 * 缺一面只有两种下场：写进矩阵的 `{ exempt }` 并给出下一步接什么的理由，或者在这里红。
 *
 * ## 为什么不跑真 Monaco
 *
 * 真 Monaco 在 node 池里起不来（`monaco/entry` 是浏览器包），而且就算起来了，"某枚 provider
 * 到底挂到哪个语言 id 上"也不在它的公开读数里。所以取证方式与 `kojo2-wire.test.ts` /
 * `ps10-eager-graph.test.ts` 同一路：**读源码**。
 *
 * 三类证据：
 * 1. **注册行**：`registerXxxProvider(… <本语言 id> …)`（`self`）或
 *    `registerForLanguageServices(monaco, (m, id) => m.languages.registerXxxProvider(id, …))`
 *    （`shared`，收口在 `register-dialects.ts`）；
 * 2. **装配行**：注册模块被宿主装配点 `ui/editor-global-providers.ts` import（模块写了却没人
 *    调 = 死代码，与"没写"等价）；
 * 3. **descriptor 声明**：`languages.ts` 两门一等语言各填一份 `capabilities`，必须与矩阵里
 *    非豁免的那一撮逐项相等（矩阵行就是由这份声明对拍生成的）。
 *
 * ## 两个"防忘"机制（本闸的主要价值）
 *
 * - **豁免不过期**：标了 `{ exempt }` 的能力，其注册模块**不许**已经被宿主装配点
 *   （`ui/editor-global-providers.ts`）接上——一旦批次八的模块接线，忘了把矩阵改回 `self`
 *   就在这里红（错误信息直接点名该动哪一格）。模块自己写了 `registerXxxProvider(KOJO2_…)`
 *   但还没进装配段 = 仍是"未接线"（批次八的常态：并行 agent 交模块，组长统一接线）；
 * - **档位清单锁死**：`self` / `shared` / `builtin` / 豁免 四档的成员逐项用 `toEqual` 锁住。
 *   接线是把豁免项搬进 `self` 的**有意的**改动，改矩阵时必须同时改这里的清单——闸门要的是
 *   "看得见的变更"，不是"矩阵悄悄变了"。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  ALL_LANGUAGE_CAPABILITIES,
  ERB_CAPABILITIES,
  KOJO2_CAPABILITIES,
  LANGUAGE_CAPABILITY_MATRIX,
  PARITY_LANGUAGE_IDS,
  deliveredCapabilities,
  exemptedCapabilities,
  isLanguageCapabilityExemption,
  LanguageCapability,
  type LanguageCapabilityTier,
  type ParityLanguageId,
} from '../src/monaco/language-capabilities';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from '../src/monaco/kojo2-constants';
import { descriptorForLanguageId } from '../src/monaco/language-registry';
import { languageForPath } from '../src/monaco/languages';

/* ============================== 取证基建 ============================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'app', 'src');

interface SourceFile {
  /** 相对 `packages/app/src` 的 posix 路径（错误信息里直接可读） */
  readonly rel: string;
  readonly text: string;
}

/** 源码快照：一次走盘，后面的取证全在内存里做（本文件被读几十次，不许每轮重走） */
const SOURCE_FILES: readonly SourceFile[] = (() => {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({
        rel: path.relative(SRC_ROOT, abs).split(path.sep).join('/'),
        text: readFileSync(abs, 'utf8'),
      });
    }
  };
  walk(SRC_ROOT);
  return out;
})();

/** 取一份源码（不存在 = 拼错路径，直接抛：取证表不许静默空匹配） */
function sourceOf(rel: string): SourceFile {
  const file = SOURCE_FILES.find((entry) => entry.rel === rel);
  if (file === undefined) throw new Error(`[language-parity] 取证表里的路径不存在：${rel}`);
  return file;
}

/** 宿主装配点（全局 provider 只在这里注册一次） */
const GLOBAL_PROVIDERS = 'ui/editor-global-providers.ts';

/**
 * 每项能力对应的 **Monaco 注册 API**（`diagnostics` / `brackets` / `preview` 没有注册 API，
 * 逐一在下面的专用用例里取证：见"诊断两条腿"与"builtin 面的来源"）。
 */
const CAPABILITY_PROVIDER_API: Readonly<Partial<Record<LanguageCapability, string>>> = {
  [LanguageCapability.Folding]: 'registerFoldingRangeProvider',
  [LanguageCapability.Outline]: 'registerDocumentSymbolProvider',
  [LanguageCapability.Format]: 'registerDocumentFormattingEditProvider',
  [LanguageCapability.Semantic]: 'registerDocumentSemanticTokensProvider',
  [LanguageCapability.Indent]: 'registerOnTypeFormattingEditProvider',
  [LanguageCapability.References]: 'registerReferenceProvider',
  [LanguageCapability.Rename]: 'registerRenameProvider',
  [LanguageCapability.Signature]: 'registerSignatureHelpProvider',
  [LanguageCapability.Inlay]: 'registerInlayHintsProvider',
  [LanguageCapability.CodeLens]: 'registerCodeLensProvider',
  [LanguageCapability.Implementation]: 'registerImplementationProvider',
  [LanguageCapability.Highlight]: 'registerDocumentHighlightProvider',
  [LanguageCapability.Selection]: 'registerSelectionRangeProvider',
  [LanguageCapability.CallHierarchy]: 'registerCallHierarchyProvider',
  [LanguageCapability.Completion]: 'registerCompletionItemProvider',
  [LanguageCapability.Hover]: 'registerHoverProvider',
  [LanguageCapability.Definition]: 'registerDefinitionProvider',
};

/** 语言 selector 的两种写法（常量引用 / 字面量；两条都认，免得接线人换一种写法就"查无此行"） */
const LANGUAGE_SELECTOR: Readonly<Record<ParityLanguageId, RegExp>> = {
  [ERB_LANGUAGE_ID]: /(?:ERB_LANGUAGE_ID|'kojo-erb')/,
  [KOJO2_LANGUAGE_ID]: /(?:KOJO2_LANGUAGE_ID|'kojo2')/,
};

/** `api(... <selector> ...)`：注册调用里直接写本语言 id = `self` 档的形状 */
function selfCallPattern(api: string, languageId: ParityLanguageId): RegExp {
  return new RegExp(`${api}\\s*\\([^;]{0,400}?(?:${LANGUAGE_SELECTOR[languageId].source})`, 'im');
}

/** `registerForLanguageServices(monaco, (m, id) => m.languages.api(id, …))`：`shared` 档的形状 */
function sharedCallPattern(api: string): RegExp {
  return new RegExp(`registerForLanguageServices\\([^;]{0,400}?${api}\\s*\\(`, 'im');
}

/** 源码里按 `self` 形状注册某能力、且指向某门语言的文件 */
function selfRegistrationFiles(
  capability: LanguageCapability,
  languageId: ParityLanguageId,
): readonly SourceFile[] {
  const api = CAPABILITY_PROVIDER_API[capability];
  if (api === undefined) return [];
  const pattern = selfCallPattern(api, languageId);
  return SOURCE_FILES.filter((file) => pattern.test(file.text));
}

/** 源码里按 `shared` 收口形状注册某能力的文件 */
function sharedRegistrationFiles(capability: LanguageCapability): readonly SourceFile[] {
  const api = CAPABILITY_PROVIDER_API[capability];
  if (api === undefined) return [];
  const pattern = sharedCallPattern(api);
  return SOURCE_FILES.filter((file) => pattern.test(file.text));
}

/** 这份注册模块是否被宿主装配点 import（写了没人调 = 死代码） */
function importedByGlobal(rel: string): boolean {
  // 直接写在装配点里的注册也算"被装配"（仓库惯例是模块 + install 函数，但不把另一条路判死）
  if (rel === GLOBAL_PROVIDERS) return true;
  const spec = `'../monaco/${rel.replace(/^monaco\//, '').replace(/\.tsx?$/, '')}'`;
  return sourceOf(GLOBAL_PROVIDERS).text.includes(spec);
}

/** 某门语言在某一档里的能力（排序后对拍，清单锁死用） */
function capabilitiesInTier(
  languageId: ParityLanguageId,
  tier: LanguageCapabilityTier,
): LanguageCapability[] {
  const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
  return ALL_LANGUAGE_CAPABILITIES.filter((capability) => row[capability] === tier).sort();
}

/** 某门语言的豁免项（能力 + 理由） */
function exemptionsOf(
  languageId: ParityLanguageId,
): { readonly capability: LanguageCapability; readonly reason: string }[] {
  const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
  const out: { capability: LanguageCapability; reason: string }[] = [];
  for (const capability of ALL_LANGUAGE_CAPABILITIES) {
    const status = row[capability];
    if (isLanguageCapabilityExemption(status)) out.push({ capability, reason: status.exempt });
  }
  return out;
}

/* ============================== 矩阵形状 ============================== */

/** 任务清单里逐字写死的 20 项（枚举加/删/改值都从这里红） */
const REQUIRED_CAPABILITIES: readonly string[] = [
  'folding',
  'outline',
  'format',
  'semantic',
  'indent',
  'brackets',
  'refs',
  'rename',
  'signature',
  'inlay',
  'codelens',
  'implementation',
  'highlight',
  'selection',
  'callhierarchy',
  'completion',
  'hover',
  'definition',
  'diagnostics',
  'preview',
];

describe('能力矩阵：覆盖面与形状', () => {
  it('能力枚举恰是任务清单那 20 项，一个不多一个不少', () => {
    expect([...ALL_LANGUAGE_CAPABILITIES].sort()).toEqual([...REQUIRED_CAPABILITIES].sort());
  });

  it('矩阵恰覆盖两门一等语言（ERB / kojo2），v1 的 `.kojo` 不在表里', () => {
    expect(PARITY_LANGUAGE_IDS).toEqual([ERB_LANGUAGE_ID, KOJO2_LANGUAGE_ID]);
    expect(Object.keys(LANGUAGE_CAPABILITY_MATRIX).sort()).toEqual(
      [ERB_LANGUAGE_ID, KOJO2_LANGUAGE_ID].sort(),
    );
    // 三个语言 id 互不相等：矩阵只收一等语言，v1 `.kojo` 只作为共享 provider 的供方
    expect(new Set([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]).size).toBe(3);
    expect(Object.keys(LANGUAGE_CAPABILITY_MATRIX)).not.toContain(KOJO_LANGUAGE_ID);
  });

  it('每门语言 × 每项都有状态（枚举新增一枚而矩阵不补，这里就红）', () => {
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
      expect(Object.keys(row).sort(), languageId).toEqual([...ALL_LANGUAGE_CAPABILITIES].sort());
    }
  });

  it('状态只有三档字面量或 { exempt }；矩阵与每一行都冻结（运行时改不动）', () => {
    const tiers: readonly string[] = ['builtin', 'shared', 'self'];
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
      for (const capability of ALL_LANGUAGE_CAPABILITIES) {
        const status = row[capability];
        if (isLanguageCapabilityExemption(status)) {
          expect(Object.keys(status), `${languageId}/${capability}`).toEqual(['exempt']);
          expect(status.exempt.trim(), `${languageId}/${capability}`).not.toBe('');
        } else {
          expect(tiers, `${languageId}/${capability}`).toContain(status);
        }
      }
      expect(Object.isFrozen(row), languageId).toBe(true);
    }
    expect(Object.isFrozen(LANGUAGE_CAPABILITY_MATRIX)).toBe(true);
  });
});

/* ============================== 豁免契约 ============================== */

describe('豁免契约：有理由、指得出下一步、不过期', () => {
  it('豁免理由非空、不是占位符（"TODO" / "待补" 这类不算理由）', () => {
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const exemptions = exemptionsOf(languageId);
      expect(exemptions.length, `${languageId} 至少要有一项豁免才说明这表在记账`).toBeGreaterThan(0);
      for (const { capability, reason } of exemptions) {
        expect(reason.trim().length, `${languageId}/${capability}：理由太短`).toBeGreaterThanOrEqual(8);
        expect(reason, `${languageId}/${capability}：占位符不算理由`).not.toMatch(
          /^\s*(todo|tbd|fixme|待定|待补|未填|-+)\s*$/i,
        );
      }
    }
  });

  it('kojo2 的豁免点名下一步接什么（模块文件名，或明说"无对应模块"）', () => {
    for (const { capability, reason } of exemptionsOf(KOJO2_LANGUAGE_ID)) {
      expect(reason, `kojo2/${capability}：理由里要点名待接线的模块`).toMatch(
        /kojo2-[a-z-]+\.ts|无对应模块/,
      );
    }
  });

  it('ERB 的豁免说明 provider 侧缺什么（"未注册 / 纯模型"这类具体说法）', () => {
    for (const { capability, reason } of exemptionsOf(ERB_LANGUAGE_ID)) {
      expect(reason, `ERB/${capability}`).toMatch(/provider|未注册|纯模型/);
    }
  });

  it('豁免项不在 descriptor 声明表里（声明 = 已交付，不是"想要"）', () => {
    for (const { capability } of exemptionsOf(ERB_LANGUAGE_ID)) {
      expect(ERB_CAPABILITIES, `ERB/${capability} 标了豁免却写进了声明表`).not.toContain(capability);
    }
    for (const { capability } of exemptionsOf(KOJO2_LANGUAGE_ID)) {
      expect(KOJO2_CAPABILITIES, `kojo2/${capability} 标了豁免却写进了声明表`).not.toContain(capability);
    }
    // 派生面与声明面同源：已交付 = 非豁免
    expect([...deliveredCapabilities(ERB_LANGUAGE_ID)].sort()).toEqual([...ERB_CAPABILITIES].sort());
    expect([...deliveredCapabilities(KOJO2_LANGUAGE_ID)].sort()).toEqual(
      [...KOJO2_CAPABILITIES].sort(),
    );
    expect([...exemptedCapabilities(ERB_LANGUAGE_ID)].sort()).toEqual(
      exemptionsOf(ERB_LANGUAGE_ID).map((entry) => entry.capability).sort(),
    );
  });

  it('kojo2 的豁免不过期：模块还没被宿主装配点接上（接线后忘改矩阵 = 这里红）', () => {
    for (const { capability } of exemptionsOf(KOJO2_LANGUAGE_ID)) {
      const api = CAPABILITY_PROVIDER_API[capability];
      if (api === undefined) continue; // diagnostics / brackets / preview 走专用用例
      // "接线" = 注册模块进了 `ui/editor-global-providers.ts` 的装配段。模块自己写了
      // `registerXxxProvider(KOJO2_LANGUAGE_ID, …)` 但没人调它 = 还没接线（批次八的常态：
      // 并行 agent 交模块，组长统一接线），不算豁免过期。
      const hits = selfRegistrationFiles(capability, KOJO2_LANGUAGE_ID)
        .filter((file) => importedByGlobal(file.rel))
        .map((file) => file.rel);
      expect(
        hits,
        `kojo2/${capability} 的模块已被宿主装配（${hits.join(', ') || '—'}）：` +
          '这面已接线，把矩阵改回 self、加进 KOJO2_CAPABILITIES，并改掉本文件的档位清单',
      ).toEqual([]);
    }
  });

  it('ERB 的豁免不过期：模块同样还没被宿主装配点接上', () => {
    for (const { capability } of exemptionsOf(ERB_LANGUAGE_ID)) {
      const api = CAPABILITY_PROVIDER_API[capability];
      if (api === undefined) continue;
      const hits = [
        ...sharedRegistrationFiles(capability),
        ...selfRegistrationFiles(capability, ERB_LANGUAGE_ID),
      ]
        .filter((file) => importedByGlobal(file.rel))
        .map((file) => file.rel);
      expect(
        hits,
        `ERB/${capability} 的模块已被宿主装配（${hits.join(', ') || '—'}）：` +
          '这面已接线，把矩阵改回 self/shared 并改掉本文件的档位清单',
      ).toEqual([]);
    }
  });
});

/* ============================== descriptor 声明 ============================== */

describe('descriptor 声明：矩阵项 ↔ capabilities 是同一份事实', () => {
  it('ERB descriptor 声明的面 = 矩阵里已交付的面（非空、无重复、全是枚举成员）', () => {
    const descriptor = descriptorForLanguageId(ERB_LANGUAGE_ID);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.capabilities).toEqual(ERB_CAPABILITIES);
    expect(ERB_CAPABILITIES.length).toBeGreaterThan(0);
    expect(new Set(ERB_CAPABILITIES).size, 'ERB_CAPABILITIES 有重复项').toBe(
      ERB_CAPABILITIES.length,
    );
    for (const capability of ERB_CAPABILITIES) {
      expect(ALL_LANGUAGE_CAPABILITIES, `ERB_CAPABILITIES 里的 "${capability}" 不在枚举里`).toContain(
        capability,
      );
    }
    const deliveredByTier = [
      ...capabilitiesInTier(ERB_LANGUAGE_ID, 'self'),
      ...capabilitiesInTier(ERB_LANGUAGE_ID, 'shared'),
      ...capabilitiesInTier(ERB_LANGUAGE_ID, 'builtin'),
    ].sort();
    expect([...ERB_CAPABILITIES].sort()).toEqual(deliveredByTier);
  });

  it('kojo2 descriptor（开关开、重载模块）声明的面 = KOJO2_CAPABILITIES = 矩阵非豁免项', async () => {
    const wire = await bootKojo2On();
    const descriptor = wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.capabilities).toEqual(KOJO2_CAPABILITIES);
    expect(KOJO2_CAPABILITIES.length).toBeGreaterThan(0);
    expect(new Set(KOJO2_CAPABILITIES).size, 'KOJO2_CAPABILITIES 有重复项').toBe(
      KOJO2_CAPABILITIES.length,
    );
    for (const capability of KOJO2_CAPABILITIES) {
      expect(ALL_LANGUAGE_CAPABILITIES, `KOJO2_CAPABILITIES 里的 "${capability}" 不在枚举里`).toContain(
        capability,
      );
    }
    expect([...KOJO2_CAPABILITIES].sort()).toEqual(
      [...deliveredCapabilities(KOJO2_LANGUAGE_ID)].sort(),
    );
  });

  it('`LanguageDescriptor.capabilities` 是可选 readonly 数组（additive：旧 descriptor 零改动）', () => {
    const registry = sourceOf('monaco/language-registry.ts').text;
    expect(registry).toMatch(/readonly capabilities\?: readonly LanguageCapability\[\]/);
    // 只读保留面（JSON）不参与能力矩阵：它的 descriptor 里不许出现 capabilities
    const languages = sourceOf('monaco/languages.ts').text;
    const jsonDescriptor = /const JSON_DESCRIPTOR: LanguageDescriptor = \{[\s\S]*?\n\};/.exec(
      languages,
    );
    expect(jsonDescriptor, 'languages.ts 里找不到 JSON_DESCRIPTOR 的字面量').not.toBeNull();
    expect(jsonDescriptor?.[0]).not.toContain('capabilities');
  });
});

/* ============================== 注册点取证 ============================== */

describe('注册点取证：`self` / `shared` 项都真的注册了、而且被装配', () => {
  it('ERB 的 shared 面：每一枚都走 registerForLanguageServices 收口，注册模块被宿主装配', () => {
    const shared = capabilitiesInTier(ERB_LANGUAGE_ID, 'shared').filter(
      (capability) => capability !== LanguageCapability.Diagnostics, // 诊断是上屏腿，专用用例
    );
    // 收口就是 11 枚（register-dialects.ts 头注的"11 枚 provider"）——数字写死，少一枚就红
    expect(shared).toHaveLength(11);
    for (const capability of shared) {
      const files = sharedRegistrationFiles(capability);
      const api = CAPABILITY_PROVIDER_API[capability];
      expect(
        files.map((file) => file.rel),
        `ERB/${capability} 没有 registerForLanguageServices(monaco, (m, id) => m.languages.${api}(id, …))`,
      ).not.toEqual([]);
      for (const file of files) {
        expect(
          importedByGlobal(file.rel),
          `${file.rel} 注册了 ${capability}，但 ${GLOBAL_PROVIDERS} 没 import 它（注册模块没人调 = 死代码）`,
        ).toBe(true);
      }
    }
  });

  it('ERB 的 self 面：补全走装配核（languageId = ERB），改名直挂 ERB id；两枚都被装配', () => {
    const completionModule = sourceOf('monaco/erb-completion.ts').text;
    expect(completionModule).toContain('installCompletion(monaco, ERB_COMPLETION_ASSEMBLY');
    expect(completionModule).toContain('languageId: ERB_LANGUAGE_ID');
    expect(importedByGlobal('monaco/erb-completion.ts')).toBe(true);

    const renameFiles = selfRegistrationFiles(LanguageCapability.Rename, ERB_LANGUAGE_ID);
    expect(renameFiles.map((file) => file.rel)).toContain('monaco/erb-rename.ts');
    expect(importedByGlobal('monaco/erb-rename.ts')).toBe(true);
  });

  it('kojo2 的 self 面：逐项有注册行，且注册模块被宿主装配点 import', () => {
    // 档位清单本身在下面"档位清单锁死"里对拍（这里只逐项取证，别在两处各存一份名单）
    for (const capability of capabilitiesInTier(KOJO2_LANGUAGE_ID, 'self')) {
      const api = CAPABILITY_PROVIDER_API[capability];
      if (api === undefined) continue; // diagnostics：专用用例
      const files = selfRegistrationFiles(capability, KOJO2_LANGUAGE_ID);
      expect(
        files.map((file) => file.rel),
        `kojo2/${capability} 没有 ${api}(… KOJO2_LANGUAGE_ID …) 这样的注册行`,
      ).not.toEqual([]);
      for (const file of files) {
        expect(
          importedByGlobal(file.rel),
          `${file.rel} 注册了 kojo2 的 ${capability}，但 ${GLOBAL_PROVIDERS} 没 import 它`,
        ).toBe(true);
      }
    }
  });

  it('注册单源：register-dialects.ts 只按 descriptor.languageServices 挑语言，不写死语言 id', () => {
    const dialects = sourceOf('monaco/register-dialects.ts').text;
    expect(dialects).toContain('descriptor.languageServices === true');
    for (const constant of ['ERB_LANGUAGE_ID', 'KOJO_LANGUAGE_ID', 'KOJO2_LANGUAGE_ID']) {
      expect(dialects, `register-dialects.ts 不该出现 ${constant}（那就是第二份语言名单）`).not.toContain(
        constant,
      );
    }
  });

  it('languages.ts：两门一等语言各填一份 capabilities（矩阵的行就是它们对拍出来的）', () => {
    const languages = sourceOf('monaco/languages.ts').text;
    expect(languages).toContain('capabilities: ERB_CAPABILITIES');
    expect(languages).toContain('capabilities: KOJO2_CAPABILITIES');
    expect(languages).toContain('languageServices: true');
  });
});

/* ============================== 诊断 / builtin 专项 ============================== */

describe('上游腿的专项取证（没有 Monaco 注册 API 的那几项）', () => {
  it('诊断两条腿各就各位：ERB 走共享上屏腿，kojo2 走自己的 marker owner + 接线点', () => {
    const erbPipeline = sourceOf('ui/EditorPane.tsx').text;
    expect(erbPipeline).toContain("query('ui.editor.decorator')");
    expect(erbPipeline).toContain('setModelMarkers(model, MARKER_OWNER');
    expect(LANGUAGE_CAPABILITY_MATRIX[ERB_LANGUAGE_ID][LanguageCapability.Diagnostics]).toBe(
      'shared',
    );

    const kojo2Pipeline = sourceOf('ui/kojo2-problem-sync.ts').text;
    expect(kojo2Pipeline).toContain('KOJO2_PROBLEM_MARKER_OWNER');
    expect(kojo2Pipeline).toContain('setModelMarkers(');
    expect(sourceOf('ui/editor-pane/use-monaco-instance.ts').text).toContain(
      'installKojo2ProblemWiring({',
    );
    expect(LANGUAGE_CAPABILITY_MATRIX[KOJO2_LANGUAGE_ID][LanguageCapability.Diagnostics]).toBe(
      'self',
    );
  });

  it('brackets 是语言配置自带的面（两门语言都填了 brackets / autoClosingPairs）', () => {
    // 只钉**配置键**与成对表本身（值怎么派生是各语言自己的事：ERB 走 ERB_BRACKET_PAIRS、
    // 2.0 走 KOJO2_PAIRS；形状会演进，配置键是 Monaco 的契约，不会变）
    const erb = sourceOf('monaco/erb-language.ts').text;
    expect(erb).toContain('setLanguageConfiguration(ERB_LANGUAGE_ID');
    expect(erb).toMatch(/\bbrackets\s*:/);
    expect(erb).toMatch(/\bautoClosingPairs\s*:/);
    expect(erb).toMatch(/\bERB_BRACKET_PAIRS\b/);
    const kojo2 = sourceOf('monaco/kojo2-language.ts').text;
    expect(kojo2).toMatch(/\bbrackets\s*:/);
    expect(kojo2).toMatch(/\bautoClosingPairs\s*:/);
    expect(kojo2).toMatch(/\bKOJO2_PAIRS\b/);
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'builtin')).toContain('brackets');
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'builtin')).toContain('brackets');
  });

  it('ERB 的 indent 也是语言配置自带的面（onEnterRules + indentationRules）', () => {
    const erb = sourceOf('monaco/erb-language.ts').text;
    expect(erb).toMatch(/\bonEnterRules\s*:/);
    expect(erb).toMatch(/\bindentationRules\s*:/);
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'builtin')).toContain('indent');
  });

  it('preview 是 Monaco 内建窗：两门语言都不注册"预览 provider"（不许造第二套）', () => {
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'builtin')).toContain('preview');
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'builtin')).toContain('preview');
    const fake = SOURCE_FILES.filter((file) =>
      /register(?:Preview|Peek)\w*Provider/.test(file.text),
    ).map((file) => file.rel);
    expect(fake).toEqual([]);
  });
});

/* ============================== 语言 id 与扩展名 ============================== */

describe('语言 id / 扩展名关系：两门语言互不蚕食', () => {
  it('ERB：三个方言后缀（.erb / .erm / .erh）大小写都归 ERB_LANGUAGE_ID', () => {
    const cases: readonly string[] = [
      'D:\\作品\\事件.erb',
      'D:/x/a.ERB',
      'D:/x/K36.erm',
      'D:/x/K36.ErM',
      'D:/x/M_KOJO_K11_TR.erh',
      'D:/x/M_KOJO_K11_TR.ERH',
    ];
    for (const filePath of cases) {
      expect(languageForPath(filePath), filePath).toBe(ERB_LANGUAGE_ID);
    }
  });

  it('kojo2：开关开时 .kojo2 归 KOJO2_LANGUAGE_ID（大小写 / 只认最后一段），v1 认路不动', async () => {
    const wire = await bootKojo2On();
    expect(KOJO2_SOURCE_EXTENSION).toBe('.kojo2');
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['D:/p/M.kojo2', KOJO2_LANGUAGE_ID],
      ['D:/p/M.KOJO2', KOJO2_LANGUAGE_ID],
      ['D:/p/M.kojo2.bak', 'plaintext'],
      ['D:/p/M.kojo', KOJO_LANGUAGE_ID],
      ['D:/p/M.erb', ERB_LANGUAGE_ID],
      ['D:/p/M.erm', ERB_LANGUAGE_ID],
      ['D:/p/M.erh', ERB_LANGUAGE_ID],
    ];
    for (const [filePath, expected] of cases) {
      expect(wire.languages.languageForPath(filePath), filePath).toBe(expected);
    }
  });

  it('认路判据不重叠：kojo2 不认 .erb/.erm/.erh，ERB 不认 .kojo2', async () => {
    const wire = await bootKojo2On();
    const erb = wire.registry.descriptorForLanguageId(ERB_LANGUAGE_ID);
    const kojo2 = wire.registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID);
    expect(erb).not.toBeNull();
    expect(kojo2).not.toBeNull();
    expect(erb?.matchesPath('D:/p/M.kojo2'), 'ERB 抢了 .kojo2').toBe(false);
    for (const filePath of ['D:/p/M.erb', 'D:/p/M.erm', 'D:/p/M.erh']) {
      expect(kojo2?.matchesPath(filePath), `kojo2 抢了 ${filePath}`).toBe(false);
    }
    expect(erb?.matchesPath('D:/p/M.erb')).toBe(true);
    expect(kojo2?.matchesPath('D:/p/M.kojo2')).toBe(true);
  });
});

/* ============================== 档位清单（锁死） ============================== */

describe('档位清单锁死：接线是"有意改动"，不是"矩阵悄悄变了"', () => {
  it('ERB：11 枚共享 provider + 共享诊断上屏腿；self 有补全/改名/高亮/扩选；1 项豁免（callhierarchy，0.57 无 API）', () => {
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'shared')).toEqual([
      'codelens',
      'definition',
      'diagnostics',
      'folding',
      'format',
      'hover',
      'implementation',
      'inlay',
      'outline',
      'refs',
      'semantic',
      'signature',
    ]);
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'self')).toEqual([
      'completion',
      'highlight',
      'rename',
      'selection',
    ]);
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'builtin')).toEqual([
      'brackets',
      'indent',
      'preview',
    ]);
    expect(exemptionsOf(ERB_LANGUAGE_ID).map((entry) => entry.capability).sort()).toEqual([
      'callhierarchy',
    ]);
  });

  it('kojo2：16 枚 self（已接线的 2.0 面）、2 枚 builtin、2 项豁免（implementation / callhierarchy）', () => {
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'self')).toEqual([
      'codelens',
      'completion',
      'definition',
      'diagnostics',
      'folding',
      'format',
      'highlight',
      'hover',
      'indent',
      'inlay',
      'outline',
      'refs',
      'rename',
      'selection',
      'semantic',
      'signature',
    ]);
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'shared')).toEqual([]);
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'builtin')).toEqual(['brackets', 'preview']);
    expect(exemptionsOf(KOJO2_LANGUAGE_ID).map((entry) => entry.capability).sort()).toEqual([
      'callhierarchy',
      'implementation',
    ]);
  });
});

/* ============================== 开关开的重载（只给 kojo2 用） ============================== */

type LanguagesModule = typeof import('../src/monaco/languages');
type RegistryModule = typeof import('../src/monaco/language-registry');

interface Kojo2Wire {
  readonly languages: LanguagesModule;
  readonly registry: RegistryModule;
}

const KOJO2_LEGACY_FLAG_KEY = 'kojo.ui.kojo2Cutover.v1';

/**
 * 开关开 + 重载模块：`languages.ts` 在**模块求值**时读开关（见那里头注），
 * 不重载就只能看到"开关关"的那张表。与 `kojo2-wire.test.ts` 同一手法（假 localStorage）。
 */
async function bootKojo2On(): Promise<Kojo2Wire> {
  const store = new Map<string, string>([[KOJO2_LEGACY_FLAG_KEY, 'on']]);
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
  const registry = await import('../src/monaco/language-registry');
  const languages = await import('../src/monaco/languages');
  return { languages, registry };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

