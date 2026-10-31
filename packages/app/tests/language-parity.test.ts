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
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang';
import { descriptorForLanguageId } from '../src/monaco/language-registry';
import { languageForPath } from '../src/monaco/languages';
import { kojo2SourceExtensions, planKojo2Open } from '../src/ui/kojo2-open';

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

/**
 * `shared` 档的**表格形状**（SDK-B5b 车 1，2026-10-31）：补全 / 悬停两条腿并进
 * `monaco/slot-service-providers.ts` 的 `SLOT_SERVICE_LEGS`，Monaco 注册 API 写在表项里、
 * 收口只在安装器里调一次（`registerForLanguageServices(monaco, leg.register, leg.kind)`）。
 *
 * 判据仍要**两条同时成立**，不是放宽：文件里既要有收口调用，也要有这条能力在表里的登记
 * （`legOf('<kind>', … registerXxxProvider(`）；少任一条 ⇒ 这门语言挂不上。
 */
const SLOT_COLLECTOR_CALL = /registerForLanguageServices\(\s+monaco,[\s\S]{0,200}?leg\.register/;

function tableEntryPattern(kind: string, api: string): RegExp {
  return new RegExp(`legOf\\('${kind}'[\\s\\S]{0,200}?${api}\\s*\\(`, 'im');
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

/** 源码里按 `shared` 收口形状注册某能力的文件（行内形状 ∪ 槽腿表形状） */
function sharedRegistrationFiles(capability: LanguageCapability): readonly SourceFile[] {
  const api = CAPABILITY_PROVIDER_API[capability];
  if (api === undefined) return [];
  const inline = sharedCallPattern(api);
  const kind = SLOT_SERVICE_OF[capability];
  const table =
    kind === undefined ? null : tableEntryPattern(kind, api);
  return SOURCE_FILES.filter(
    (file) =>
      inline.test(file.text) ||
      // 表格形状：收口调用 + 表项都在同一个文件里（两条判据缺一不可）
      (table !== null && SLOT_COLLECTOR_CALL.test(file.text) && table.test(file.text)),
  );
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

/** 一份源码里导出的安装器函数名（`export function installXxx(`） */
function installerNamesOf(file: SourceFile): readonly string[] {
  return [...file.text.matchAll(/export function (install[A-Za-z0-9_]+)\(/g)].map(
    (match) => match[1]!,
  );
}

/**
 * `if (isKojo2CutoverEnabled()) { … }` 的整段（按块尾那行 4 空格 `}` 收口）。
 *
 * 装配点只许**有副作用**的安装器留在这一段里；语言面必须在段外（无条件装配）。
 */
function cutoverBlock(source: string): string {
  const start = source.indexOf('if (isKojo2CutoverEnabled()) {');
  expect(start).toBeGreaterThan(-1);
  const offset = source.slice(start).search(/^    \}$/m);
  expect(offset).toBeGreaterThan(-1);
  return source.slice(start, start + offset + 5);
}

/** kojo2 的 `shared` 能力 → 共享收口要点的槽服务名（`registerForLanguageServices` 第三参） */
const SLOT_SERVICE_OF: Readonly<Partial<Record<LanguageCapability, string>>> = {
  [LanguageCapability.Outline]: 'documentSymbol',
  [LanguageCapability.Definition]: 'definition',
  [LanguageCapability.Inlay]: 'inlayHint',
  // B3c：补全 / 悬停的供方是插件，注册走带能力名的共享收口（kojo2 descriptor 由
  // `slotServices` 点名）。能力名与 `SlotServiceKind` 逐字相同。
  [LanguageCapability.Completion]: 'completion',
  [LanguageCapability.Hover]: 'hover',
  // B3d：签名帮助 / 格式化的供方也交插件，注册走带能力名的共享收口（kojo2 descriptor 由
  // `slotServices` 点名）。能力名与 `SlotServiceKind` 逐字相同。
  [LanguageCapability.Signature]: 'signatureHelp',
  [LanguageCapability.Format]: 'formatting',
  // B3e：引用 / 改名也交插件，注册走带能力名的共享收口（kojo2 descriptor 由 `slotServices`
  // 点名）。能力名与 `SlotServiceKind` 逐字相同。
  [LanguageCapability.References]: 'references',
  [LanguageCapability.Rename]: 'rename',
  // B3f：同符号高亮 / 结构化扩选也交插件，注册走带能力名的共享收口（kojo2 descriptor 由
  // `slotServices` 点名）。能力名与 `SlotServiceKind` 逐字相同。
  [LanguageCapability.Highlight]: 'documentHighlight',
  [LanguageCapability.Selection]: 'selectionRange',
  // B3g：行上注解也交插件（`kojo2-codeLens`），注册走带能力名的共享收口（kojo2 descriptor 由
  // `slotServices` 点名）。能力名与 `SlotServiceKind` 逐字相同。
  [LanguageCapability.CodeLens]: 'codeLens',
  // B3h（2026-10-30）：折叠走共享收口（能力名 `foldingRange`）——可折区间来自结构 worker，
  // 宿主预取进缓存、随请求递下去，供方（插件）同步裁与答。
  [LanguageCapability.Folding]: 'foldingRange',
  // B3 语义收口（2026-10-30）：着色走共享收口（能力名 `semanticToken`）——捕获快照来自结构
  // worker，宿主预取进缓存、随请求的 `captures` 递下去，供方（插件）同步翻译与裁剪。
  [LanguageCapability.Semantic]: 'semanticToken',
};

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
    // 收口就是 13 枚（register-dialects.ts 头注的"11 枚 provider" + LAU-4 的同符号高亮 /
    // 结构化扩选两枚）——数字写死，少一枚就红
    expect(shared).toHaveLength(13);
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

  it('kojo2 的 format 面两条腿齐：整篇 + 区间 provider 同属一条槽腿（能力名 `formatting`），装配点只调一枚工厂', () => {
    const factory = sourceOf('monaco/slot-service-providers.ts').text;
    // 一条能力（format）= 两枚 Monaco provider：document（Shift+Alt+F）+ range（Ctrl+K Ctrl+F）。
    // B3d 起两枚都经共享收口挂上（kojo2 由 descriptor 的 `slotServices: ['formatting']` 点名）；
    // SDK-B5b 车 2 起两枚**同属一条腿**——表项点名 `'formatting'`，登记闭包里两枚 API 各一次。
    expect(factory).toMatch(
      /legOf\('formatting',[\s\S]{0,400}?registerDocumentFormattingEditProvider\s*\(/,
    );
    expect(factory).toMatch(
      /legOf\('formatting',[\s\S]{0,400}?registerDocumentRangeFormattingEditProvider\s*\(/,
    );
    expect(factory).not.toMatch(
      /registerDocumentFormattingEditProvider\(\s*KOJO2_LANGUAGE_ID/,
    );
    expect(factory).not.toMatch(
      /registerDocumentRangeFormattingEditProvider\(\s*KOJO2_LANGUAGE_ID/,
    );
    const host = sourceOf(GLOBAL_PROVIDERS).text;
    // 车 1–5：装配点只调这一枚工厂（宿主事实收在一个 `slotServiceHost` 常量里，两处共用）
    expect(host).toContain('installSlotServiceProviders(monaco, slotServiceHost)');
  });

  it('注册单源：register-dialects.ts 只按 descriptor.languageServices 挑语言，不写死语言 id', () => {
    const dialects = sourceOf('monaco/register-dialects.ts').text;
    // SDK-DIALECT（2026-10-31）：旧桥判据收进语言表的 `usesLegacyBridge`（`languageServices`
    // ↔ `services.legacyBridge` 的两个名字），口径不变——挑语言仍只按 descriptor 字段。
    expect(dialects).toMatch(/usesLegacyBridge\(descriptor\)|descriptor\.languageServices === true/);
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

/* ============================== DOUBLE-LEG-1032C：改名一格（注册面两枚 / 应答面一枚 / 不收敛留账） ============================== */

/**
 * `rename`（F2）的「谁在答」台账（LAU-DUALLEG 第十波，2026-10-31）。形状照
 * `DOUBLE-LEG-1032` / `DOUBLE-LEG-1032B`（点名为唯一台账 / 注册面计数 / 装配面计数 /
 * 第三参口径 / 不许让位 / 未收敛的宿主事实逐字留账），**判据不另开一份尺子**；
 * 行为面（弃权、两把尺子的读数、槽腿不写盘）钉在同波的 `tests/rename-dualleg.test.ts`。
 *
 * **本格与 definition/implementation 那两格的差别要说清**（简报前提在这里不成立）：
 * `SLOT_SERVICE_LEGS` 里**有** `rename` 这枚腿，所以「槽腿表缺席 ⇒ 宿主腿禁 `excludeNamed`」
 * 那条尺子用不上。让位的理由换成了另外两条，都在下面的留账用例里：
 * ① 槽腿的 prepare 只有 **kojo2 那把尺子**（`kojo2PrepareRename`），ERB 一旦点名 `rename`
 *    就从"没枚 provider"变成"用 2.0 的尺子判 ERB 的符号"——不是少功能，是**答错**；
 * ② ERB 的**闭文件回写通道**（`applyToClosedFile` → `rewriteClosedFile` → 内核 io）只在宿主腿上，
 *    槽腿只交 `WorkspaceEdit`；让位＝未打开文件不落盘（或更糟：盘上改一半）。
 *
 * 因此今天的判定＝**不收敛留账**：注册面 ERB / kojo1 各两枚（宿主答 + 槽腿恒弃权），
 * kojo2 一枚；应答面每门恰一枚。真要收敛的前置条件写死在最后一条用例里。
 */
describe('DOUBLE-LEG-1032C：改名（rename）——注册面两枚 / 应答面一枚，不收敛留账', () => {
  /** 三枚宿主/槽腿注册点：文件 → Monaco 注册 API → 装配点安装器 */
  const RENAME_LEGS: readonly (readonly [string, string])[] = [
    ['monaco/erb-rename.ts', 'installErbRename'],
    ['monaco/kojo-rename.ts', 'installKojoRename'],
    ['monaco/slot-service-providers.ts', 'installSlotServiceProviders'],
  ];

  it('全仓 src 里 registerRenameProvider 恰三枚文件、每枚文件恰一次调用（第四枚同种 provider 一出现本组就红）', () => {
    const hits = SOURCE_FILES.filter((file) => file.text.includes('.registerRenameProvider('));
    expect(
      hits.map((file) => file.rel).sort(),
      'rename 的注册点文件清单变了：谁在答要重数',
    ).toEqual(
      ['monaco/erb-rename.ts', 'monaco/kojo-rename.ts', 'monaco/slot-service-providers.ts'].sort(),
    );
    for (const rel of ['monaco/erb-rename.ts', 'monaco/kojo-rename.ts', 'monaco/slot-service-providers.ts']) {
      const occurrences = sourceOf(rel).text.split('.registerRenameProvider(').length - 1;
      expect(occurrences, `${rel} 里 registerRenameProvider 调了 ${occurrences} 次：一条 kind 挂了两枚 provider`).toBe(1);
    }
  });

  it('装配点对三枚各只调一次安装器（第二次调用 = 同一枚 model 上的第二枚 provider）', () => {
    const host = sourceOf(GLOBAL_PROVIDERS).text;
    for (const [, installer] of RENAME_LEGS) {
      const calls = host.split(`${installer}(`).length - 1;
      expect(calls, `${GLOBAL_PROVIDERS} 里 ${installer} 被调了 ${calls} 次`).toBe(1);
    }
  });

  it('槽腿表里有 rename 这枚腿（所以本格不是"表缺席"那一族），且它是语言面不是写面腿', () => {
    const factory = sourceOf('monaco/slot-service-providers.ts').text;
    expect(factory).toMatch(tableEntryPattern('rename', 'registerRenameProvider'));
    // 写面腿表（`SLOT_SERVICE_WRITE_LEGS`）只登记 codeAction：改名是只读语言面，不受切流门控
    expect(factory).toMatch(/SLOT_SERVICE_WRITE_LEGS[^\n]*= Object\.freeze\(\['codeAction'\]\)/);
  });

  it('反向形状：槽腿安装的第三参必须是能力名（写成 undefined 就摘掉 kojo2——它不声明旧桥，点名是它唯一的挂载通道）', () => {
    const factory = sourceOf('monaco/slot-service-providers.ts').text;
    expect(
      factory,
      'installSlotServiceLegs 的第三参不再是 leg.kind：kojo2 的 rename 腿会静默挂不上',
    ).toMatch(/registerForLanguageServices\(\s*monaco,[\s\S]{0,200}?leg\.kind,/);
    const kojo2 = descriptorForLanguageId(KOJO2_LANGUAGE_ID);
    expect(kojo2).not.toBeNull();
    expect(kojo2?.slotServices ?? [], 'kojo2 的点名表读空了：下面那条 toContain 就成了假通过').toEqual(
      expect.arrayContaining(['rename']),
    );
    expect(kojo2?.languageServices, 'kojo2 一旦声明旧桥，本条"第三参必须能力名"的理由就换了').not.toBe(true);
  });

  it('ERB / kojo1 都不点名 rename，两枚宿主腿都不许 excludeNamed（让位＝换错尺子 + 闭文件不落盘）', () => {
    const erb = descriptorForLanguageId(ERB_LANGUAGE_ID);
    expect(erb).not.toBeNull();
    // 反空匹配自证：读到的确实是那份点名表（今天三条），不是 `undefined ?? []` 蒙过去的
    expect(erb?.slotServices ?? [], 'ERB 的点名表读空了：下面两条 not.toContain 就成了假通过').toEqual(
      expect.arrayContaining(['references', 'hover', 'formatting']),
    );
    expect(erb?.slotServices ?? [], 'ERB 点名 rename = 把 2.0 的 prepare 尺子按到 .erb 上').not.toContain('rename');
    const kojo1 = descriptorForLanguageId(KOJO_LANGUAGE_ID);
    expect(kojo1?.slotServices ?? [], 'kojo1（封存层）点名了 rename：它是待删除物，不进统一层').not.toContain('rename');
    for (const rel of ['monaco/erb-rename.ts', 'monaco/kojo-rename.ts']) {
      expect(sourceOf(rel).text, `${rel} 不该按 excludeNamed 让位`).not.toMatch(/excludeNamed/);
    }
    // 宿主腿仍是"直挂语言 id"那一枚（改成共享收口形状 = 本组的计数前提没了）
    expect(sourceOf('monaco/erb-rename.ts').text).toMatch(/registerRenameProvider\(\s*ERB_LANGUAGE_ID/);
    expect(sourceOf('monaco/kojo-rename.ts').text).toMatch(/registerRenameProvider\(\s*KOJO_LANGUAGE_ID/);
  });

  it('不收敛的宿主事实逐字留账：闭文件回写通道与跨语言改名判据都在宿主腿上（搬不动就不收，也不许因搬不动丢功能）', () => {
    const erb = sourceOf('monaco/erb-rename.ts').text;
    expect(erb).toMatch(/export function createApplyToClosedFile/); // 未打开文件唯一落盘通道
    expect(erb).toMatch(/landedFiles/); // 全或无最后一道：rejectReason 与已落盘永不同时
    expect(erb).toMatch(/kojoSources\?/); // 跨语言腿①：糖源枚举（宿主才看得见）
    expect(erb).toMatch(/kojoReferences\?/); // 跨语言腿②：逐处判读（供方之间不许互问）
    const host = sourceOf(GLOBAL_PROVIDERS).text;
    expect(host).toMatch(/applyToClosedFile: createApplyToClosedFile\(renameClosedFileIo\)/);
    // 真收敛的前置条件（两条都要齐，缺一律不收）：
    const factory = sourceOf('monaco/slot-service-providers.ts').text;
    expect(factory, '槽腿 rename 的 prepare 仍只有 kojo2 那把尺子 ⇒ 收敛要先按 descriptor 分派尺子').toContain(
      'kojo2PrepareRename',
    );
    expect(factory, '槽腿出现落盘通道 = 第二套写盘路径；不许用这条捷径去收敛 rename').not.toMatch(
      /applyToClosedFile|rewriteClosedFile/,
    );
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
    // B4：2.0 的成对记号**正文**在语言面库（`@kojo/kojo-lang/language-config`，本文件的走图器
    // 只跟 `packages/app/src`），宿主里剩下的两截是"指针 + 落地腿"。取证因此分两条：
    // ① 宿主确实有一条把供方数据接进 `setLanguageConfiguration` 的腿（`monaco-language-surface.ts`）；
    // ② 那一副配置的成对表在宿主有唯一出口名（`KOJO2_PAIRS` 的 re-export 指针）。
    // 缺 ① = 能力声明是假的；缺 ② = 有人在宿主另抄一张表。
    const surface = sourceOf('monaco/monaco-language-surface.ts').text;
    expect(surface).toMatch(/setLanguageConfiguration\(\s*languageId/);
    expect(surface).toMatch(/\bdata\.brackets\b/);
    expect(surface).toMatch(/\bdata\.autoClosingPairs\b/);
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
      ['D:/p/M.kojo', KOJO2_LANGUAGE_ID],
      ['D:/p/M.kojo1', KOJO_LANGUAGE_ID],
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
  it('ERB：13 枚共享 provider（含 LAU-4 的同符号高亮 / 结构化扩选）+ 共享诊断上屏腿；self 只剩补全/改名；1 项豁免（callhierarchy，0.57 无 API）', () => {
    // LAU-4（2026-10-30）：`highlight` / `selection` 从 self 挪到 shared —— 判据搬进
    // `@kojo/erb-lang/highlight` / `/selection-range`，供方是插件 `@kojo/plugin-erb-lang`，
    // 注册经 `registerForLanguageServices(..., 'documentHighlight'|'selectionRange')`
    // （ERB 由 `languageServices: true` 收进来）。**档位变了，能力没少**：13 + 2 + 3 = 18。
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'shared')).toEqual([
      'codelens',
      'definition',
      'diagnostics',
      'folding',
      'format',
      'highlight',
      'hover',
      'implementation',
      'inlay',
      'outline',
      'refs',
      'selection',
      'semantic',
      'signature',
    ]);
    expect(capabilitiesInTier(ERB_LANGUAGE_ID, 'self')).toEqual([
      'completion',
      'rename',
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

  it('kojo2：2 枚 self、15 枚 shared（大纲 / 行内提示 / 转定义 / 补全 / 悬停 / 签名 / 格式化 / 引用 / 改名 / 高亮 / 扩选 / 行上注解 / 折叠 / 语义着色走槽腿）、2 枚 builtin、2 项豁免', () => {
    // B2（2026-10-24）：`outline` 从 self 挪到 shared —— 2.0 的大纲不再由
    // `kojo2-symbols.ts` 自建 provider，改由共享收口按 `slotServices: ['documentSymbol']`
    // 挂上，供方是插件 `@kojo/plugin-kojo-lang`（那枚自建模块在 B5b 已整块删除）。
    // B3b（2026-10-24）：`definition` 同理挪到 shared —— 判据与展开体那两条落点都归插件，
    // 宿主那枚补全 / 悬停安装器不再注册任何 `DefinitionProvider`。
    // B2c（2026-10-24）：`inlay` 同批挪到 shared —— 原生安装器已不在装配路径上。
    // B3c（2026-10-28）：`completion` / `hover` 也挪到 shared —— 注册不再直挂 `kojo2`，
    // 两枚 provider 经 `registerForLanguageServices(..., 'completion'|'hover')` 挂上，
    // 供方是插件 `@kojo/plugin-kojo-lang`（判据在 `@kojo/kojo-lang`）。
    // SDK-B5b 车 1（2026-10-31）：这两条腿的安装器并进语言无关的槽腿工厂
    // `monaco/slot-service-providers.ts`（表格 + 一枚安装器），能力名仍是 `'completion'` /
    // `'hover'`，注册序与装配点位置照旧。
    // B3d（2026-10-28）：`signature` / `format` 同批挪到 shared —— 判据搬进
    // `@kojo/kojo-lang`，供方是插件的 `kojo2-signatureHelp` / `kojo2-formatting` 两枚贡献，
    // 注册经 `registerForLanguageServices(..., 'signatureHelp'|'formatting')`。
    // B3e（2026-10-29）：`refs` / `rename` 同批挪到 shared —— 判据搬进
    // `@kojo/kojo-lang/references` / `/rename`，供方是插件的 `kojo2-references` /
    // `kojo2-rename`，注册经 `registerForLanguageServices(..., 'references'|'rename')`。
    // B3f（2026-10-29）：`highlight` / `selection` 同批挪到 shared —— 判据搬进
    // `@kojo/kojo-lang/highlight` / `/selection-range`，供方是插件的
    // `kojo2-documentHighlight` / `kojo2-selectionRange`，注册经
    // `registerForLanguageServices(..., 'documentHighlight'|'selectionRange')`。
    // B3g（2026-10-30）：`codelens` 同批挪到 shared —— 判据搬进 `@kojo/kojo-lang/codelens`
    // （计数复用包内 references），供方是插件的 `kojo2-codeLens`，注册经
    // `registerForLanguageServices(..., 'codeLens')`。
    // B3h（2026-10-30）：`folding` 同批挪到 shared —— 判据搬进 `@kojo/kojo-lang/folding`，
    // 供方是插件的 `kojo2-foldingRange`，注册经 `registerForLanguageServices(..., 'foldingRange')`；
    // worker 事实由宿主**预取**（`installKojo2FoldsCache`）随请求的 `folds` 递下去。
    // **档位变了，能力没少**：两侧的合计仍是 4 + 13 = 17。
    // B3 语义收口（2026-10-30）：`semantic` 从 self 挪到 shared —— 判据搬进
    // `@kojo/kojo-lang/semantic`，供方是插件的 `kojo2-semanticTokens`，注册经
    // `registerForLanguageServices(..., 'semanticToken')`；worker 事实由宿主**预取**随请求的
    // `captures` 递下去。**档位变了，能力没少**：两侧的合计仍是 2 + 15 = 17。
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'self')).toEqual(['diagnostics', 'indent']);
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'shared')).toEqual([
      'codelens',
      'completion',
      'definition',
      'folding',
      'format',
      'highlight',
      'hover',
      'inlay',
      'outline',
      'refs',
      'rename',
      'selection',
      'semantic',
      'signature',
    ]);
    expect(capabilitiesInTier(KOJO2_LANGUAGE_ID, 'builtin')).toEqual(['brackets', 'preview']);
    expect(exemptionsOf(KOJO2_LANGUAGE_ID).map((entry) => entry.capability).sort()).toEqual([
      'callhierarchy',
      'implementation',
    ]);
  });
});

/* ============================== 注册面对账（声明有 ⇒ 真的注册了） ============================== */

/**
 * 这一组是 K2-SURFACE-DEFAULT 的对账：矩阵每一格必须落到**真实注册面**上。
 *
 * 旧闸只查"注册行 + import"，于是两种假话都能过关：① 模块被 import 但安装器从没被调用
 * （死代码——B5b 之前 `monaco/kojo2-inlay.ts` 就是这种，B2c 之后已零生产调用、B5b 已删）；
 * ② 安装器被调用、但自己又读切流开关，
 * 默认档下实际零注册。两条都在下面被拦住。
 */
describe('注册面对账：self 项无条件装配、shared 项真挂槽腿', () => {
  const host = sourceOf(GLOBAL_PROVIDERS).text;

  it('kojo2 的 self 面：装配点**真调了**安装器，且安装器自己不读切流开关', () => {
    for (const capability of capabilitiesInTier(KOJO2_LANGUAGE_ID, 'self')) {
      const api = CAPABILITY_PROVIDER_API[capability];
      if (api === undefined) continue; // diagnostics：上屏腿，专用用例
      const files = selfRegistrationFiles(capability, KOJO2_LANGUAGE_ID).filter((file) =>
        importedByGlobal(file.rel),
      );
      expect(files.map((file) => file.rel), `kojo2/${capability} 没有已装配的注册模块`).not.toEqual(
        [],
      );
      for (const file of files) {
        const called = installerNamesOf(file).filter((name) =>
          new RegExp(String.raw`${name}\s*\(\s*monaco`).test(host),
        );
        expect(
          called,
          `${file.rel} 导出的安装器没有一个在 ${GLOBAL_PROVIDERS} 里被调用（import 了没人调 = 死代码）`,
        ).not.toEqual([]);
        expect(
          file.text,
          `${file.rel} 是只读呈现面，不许再读 isKojo2CutoverEnabled（K2-SURFACE-DEFAULT）`,
        ).not.toContain('isKojo2CutoverEnabled');
      }
    }
  });

  it('kojo2 的 shared 面：注册模块被装配，且点名的那条槽服务（documentSymbol / inlayHint / definition / completion / hover / signatureHelp / formatting / foldingRange / semanticToken）真有一处收口点了名', () => {
    for (const capability of capabilitiesInTier(KOJO2_LANGUAGE_ID, 'shared')) {
      const files = sharedRegistrationFiles(capability).filter((file) => importedByGlobal(file.rel));
      expect(
        files.map((file) => file.rel),
        `kojo2/${capability} 没有 registerForLanguageServices 收口`,
      ).not.toEqual([]);
      const slot = SLOT_SERVICE_OF[capability];
      if (slot === undefined) continue;
      // B3c：这条判据从"**每个**收口文件都要写能力名"改成"**至少有一处**收口写了能力名
      // ＋ descriptor 点名了同一条腿"。为什么不是放宽：悬停的旧收口（`kojo-hover.ts`）
      // 是 B2 之前的无能力名形态，它只铺 `languageServices` 语言、并不服务 kojo2——
      // 要求它也写 `'hover'` 等于逼 v1 那一路改签名。真正让 kojo2 挂上的判据是下面两条：
      // ① 已装配的共享收口里有一处带这个名字；② kojo2 descriptor 的 `slotServices` 点名它。
      // 少任意一条，kojo2 都挂不上（这条比旧写法更紧：旧写法根本不看 descriptor）。
      expect(
        files.some((file) => file.text.includes(`'${slot}'`)),
        `kojo2/${capability} 的共享收口没有一处点名 '${slot}'（descriptor 声明了它，却没人认）`,
      ).toBe(true);
      expect(
        descriptorForLanguageId(KOJO2_LANGUAGE_ID)?.slotServices ?? [],
        `kojo2 descriptor 没点名 '${slot}'`,
      ).toContain(slot as never);
    }
  });

  it('切流开关块里只剩**写面**那一腿（一键迁移 code action），语言面全在块外', () => {
    const block = cutoverBlock(host);
    // SDK-B5b 车 5（2026-10-31）：注册/翻译并进槽腿工厂 ⇒ 块里只剩"按写面名单装这一腿"
    // 那一行宿主策略（`SLOT_SERVICE_WRITE_LEGS` 是数据，工厂与宿主读同一份）。
    expect(block).toContain('installSlotServiceLegs(monaco, SLOT_SERVICE_WRITE_LEGS, slotServiceHost)');
    // 迁移 code action 属迁移入口：块里只允许这一条写面装配行
    const installersInBlock = [...block.matchAll(/install(?:Kojo2|SlotService)[A-Za-z0-9_]*/g)].map(
      (match) => match[0],
    );
    expect(new Set(installersInBlock)).toEqual(new Set(['installSlotServiceLegs']));
    // 语言面逐项在块外（块外的装配行由上面两条用例按能力逐项取证，这里反向点名）
    for (const installer of [
      // B3 语义收口：原生 provider 安装器已清零，装配点只装**捕获预取器**（注册在共享收口）
      'installKojo2SemanticCaptures',
      // SDK-B5b 车 1（2026-10-31）：补全 / 悬停的安装器已改名并语言无关化
      // （`installSlotServiceProviders`，两条腿在表里）；名字不再带 kojo2，判据不变
      'installSlotServiceProviders',
      'installKojo2IndentOnTypeProvider',
      // SDK-B5b 车 2–4（2026-10-31）：格式化 / 签名 / 引用 / 改名 / 高亮 / 扩选 / 行上注解的
      // 安装器也已并进上面那枚语言无关的槽腿工厂（七枚 `kojo2-*` 文件随批删除）——
      // 名字逐个点在这儿，是为了让"谁把某一腿塞回切流块"当场红（名字已不存在 ⇒ 第二行断言
      // 会先红，等于钉住它们**没有**从别处复活）。
      // B3h：折叠的原生 provider 清零，装配点只装**预取器**（注册在共享收口那一枚）
      'installKojo2FoldsCache',
    ]) {
      expect(block, `${installer} 不该留在切流开关块里`).not.toContain(installer);
      expect(host, `${installer} 没有出现在装配点`).toContain(installer);
    }
  });

  it('诊断是语言面：`kojo2DiagnosticsEnabled()` 恒 true，归属逐文件按路由判', () => {
    const gate = sourceOf('ui/kojo2-diagnostics-gate.ts').text;
    expect(gate).not.toContain('isKojo2CutoverEnabled');
    expect(gate).toMatch(/export function kojo2DiagnosticsEnabled\(\): boolean \{\s*return true;/);
  });
});

/* ============================== 副作用面仍门控（守门） ============================== */

/**
 * 解门只许发生在一处：**只读呈现面**。写回 / 迁移入口 / `.kojo` 解析器切换 / 存储服务
 * 必须继续读 `isKojo2CutoverEnabled()`（默认档行为不变），否则"语言面可见"会顺手把
 * 写面也放出来。
 */
describe('副作用面：默认档仍关闭（源码守卫 + 行为断言）', () => {
  it('存储服务 / 迁移入口 / `.kojo` 打开与解析器切换的源码都仍读切流开关', () => {
    const guarded: readonly string[] = [
      'ui/kojo2-storage-service.ts',
      'ui/kojo2-migrate-entry.ts',
      'ui/kojo2-open.ts',
      'ui/kojo2-open-paths.ts',
      'ui/kojo2-model-language.ts',
      // SDK-B5b 车 5（2026-10-31）：迁移 code action 的安装器并进槽腿工厂后，**开关仍在宿主**
      // （装配点的切流块）——工厂与 `monaco/slot-service-providers.ts` 都不许读它，所以这一条
      // 改钉宿主装配点本文件（`GLOBAL_PROVIDERS`）。
      GLOBAL_PROVIDERS,
    ];
    for (const rel of guarded) {
      expect(sourceOf(rel).text, `${rel} 不再读 isKojo2CutoverEnabled（写面被放出来了）`).toContain(
        'isKojo2CutoverEnabled',
      );
    }
  });

  it('缺省档行为（LAU-3 翻面）：`.kojo` / `.kojo2` 可见，且 2.0 的开项目路由**放行**', () => {
    // LAU-3 起缺省阶段是 `2.0-default` ⇒ 切流语义默认开启，`.kojo2` 的"切项目再排队打开"
    // 这条腿跟着放行。`v1-only` 档仍返回 off（守卫本身没退化，那条断言在 kojo2-wire ① 组）。
    expect(kojo2SourceExtensions()).toEqual(['.kojo', '.kojo2']);
    const plan = planKojo2Open(
      { path: 'D:/p/M.kojo2' },
      { currentRoot: 'D:/p', projectOpen: true },
    );
    expect(plan).toEqual({ kind: 'open', path: 'D:/p/M.kojo2' });
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

