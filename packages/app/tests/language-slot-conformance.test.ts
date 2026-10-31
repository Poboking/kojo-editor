
/**
 * 语言服务槽 **conformance**（LAU 验收线 `ARCH-language-unification.md` §4.5 / §9-2 的可执行钉子）。
 *
 * ## 这份文件回答五个问题（每个问题一组用例）
 *
 * 1. **供方覆盖**：两门一等语言 descriptor 声明的每一条槽腿（`slotServices`，ERB 走
 *    `languageServices: true` 的全腿），都能在**插件包**里找到供方；表外的写法只有一种——
 *    在 {@link SLOT_KIND_SUPPLY} 里显式声明「由宿主事实提供」并给非空理由。
 *    **新增一条 kind 时本文件必红**（联合从源码解析、与表逐项对拍），逼迫同批补供方与表。
 * 2. **三态契约**：`undefined`（弃权）/ 空结果（作答）/ 有结果，十条取数腿**同一套判别**；
 *    集合型（`completion`）另有一条：弃权与空都不阻断并集。
 * 3. **排序**：同 kind 多供方按 `order` 升序、同 order 按注册序（内核 `SlotRegistryImpl.query`
 *    的既有口径），取数腿**按 query 顺序问**，所以"第一家说了算"由 `order` 决定而不是注册先后。
 * 4. **可扩展性**：只登记一枚 descriptor（不碰任何宿主文件）就能把 provider 挂上一门新语言；
 *    `registerForLanguageServices` 的半途失败必须**逐枚回滚**且原错误外抛。
 * 5. **禁回归**：宿主里"按语言 id 分支"的口径交给既有的 `tools/audit-language.mjs` M2
 *    （`pnpm audit:language`），本文件只引用它的台账，**不重造一份 grep 规则**。
 *
 * ## 取证方式（与 `language-parity.test.ts` 同族）
 *
 * - **运行时**：真实 descriptor 表（`../src/monaco/languages` 在求值时登记）、真实内核
 *   `SlotRegistryImpl`、真实共享收口 `registerForLanguageServices`、真实取数腿
 *   `monaco/kojo-language-service-legs.ts`；
 * - **源码**：插件包扫一遍（供方覆盖）、宿主装配点 import 关系、`SlotServiceKind` 联合字面量；
 * - **台账**：`tools/audit-language-baseline.json`（M2 的唯一真源）。
 *
 * 零真实 IO（不碰用户工程 / 不启 worker）、零计时、零随机：夹具全是内存对象。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlotRegistryImpl } from '@kojo/kernel';
import type {
  EditorCompletionItem,
  EditorDocumentHighlight,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  EditorRangeEdit,
  EditorRenameEdit,
  EditorSignature,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import type * as MonacoRuntime from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  LanguageCapability,
  LANGUAGE_CAPABILITY_MATRIX,
  PARITY_LANGUAGE_IDS,
  isLanguageCapabilityExemption,
} from '../src/monaco/language-capabilities';
import {
  descriptorForLanguageId,
  registerLanguage,
  type LanguageDescriptor,
} from '../src/monaco/language-registry';
// descriptor 在 `languages.ts` 模块求值时登记（本文件后面按 id 取它们）
import '../src/monaco/languages';
import { registerForLanguageServices } from '../src/monaco/register-dialects';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import {
  collectCodeLensResult,
  collectCallHierarchy,
  collectCompletionItems,
  collectDocumentHighlights,
  collectFormattingEdits,
  collectHoverContents,
  collectHoverResult,
  collectReferences,
  collectRename,
  collectRenameTarget,
  collectSelectionRanges,
  collectSignatureHelp,
} from '../src/monaco/kojo-language-service-legs';

/* ============================== 取证基建 ============================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const APP_SRC = path.join(REPO_ROOT, 'packages', 'app', 'src');
const PLUGINS_ROOT = path.join(REPO_ROOT, 'packages', 'plugins');

interface SourceFile {
  /** 相对仓库根的 posix 路径（错误信息里直接可读） */
  readonly rel: string;
  readonly text: string;
}

/** 走一棵目录，收 `.ts` / `.tsx` 源文（一次走盘，后面全在内存里判） */
function collectSources(root: string): readonly SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({ rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'), text: readFileSync(abs, 'utf8') });
    }
  };
  walk(root);
  return out;
}

const APP_SOURCES = collectSources(APP_SRC);

/** 宿主装配点：全局 provider 只在这里注册一次（"模块写了没人调 = 死代码"的判据） */
const GLOBAL_PROVIDERS = 'packages/app/src/ui/editor-global-providers.ts';

function appSource(rel: string): SourceFile {
  const full = `packages/app/src/${rel}`;
  const file = APP_SOURCES.find((entry) => entry.rel === full);
  if (file === undefined) throw new Error(`[slot-conformance] 取证表里的路径不存在：${full}`);
  return file;
}

/** `import '../monaco/xxx'` —— 这份 monaco 模块是否被装配点接上 */
function importedByGlobal(rel: string): boolean {
  if (rel === GLOBAL_PROVIDERS) return true;
  const spec = rel.replace(/^packages\/app\/src\/monaco\//, '').replace(/\.tsx?$/, '');
  return appSource('ui/editor-global-providers.ts').text.includes(`'../monaco/${spec}'`);
}

/** `packages/plugins` 下的插件包目录名（`@kojo/plugin-kojo-lang` 在这里就是 `kojo-lang`） */
function pluginPackages(): readonly string[] {
  return readdirSync(PLUGINS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(PLUGINS_ROOT, entry.name, 'src')))
    .map((entry) => entry.name);
}

/** 包内全部源文（一次走盘，供方台账逐条要问同一批包，别每条重走） */
const PLUGIN_SOURCE_CACHE = new Map<string, string>();
function pluginSourceText(pkg: string): string {
  const cached = PLUGIN_SOURCE_CACHE.get(pkg);
  if (cached !== undefined) return cached;
  const text = collectSources(path.join(PLUGINS_ROOT, pkg, 'src'))
    .map((file) => file.text)
    .join('\n');
  PLUGIN_SOURCE_CACHE.set(pkg, text);
  return text;
}

/**
 * 一个插件包**认得哪些槽腿**（包级取证：同一个包内既有槽注册、又出现该 kind 字面量）。
 *
 * 粒度刻意停在"包"而不是"文件"：`kojo-lang` 的 `provideCompletion(...)` 住在
 * `src/completion.ts`、注册住在 `src/plugin.ts`，按文件找会把"判据分文件"这种**正常写法**
 * 判成缺供方。包级仍足以拦住"这条腿根本没人接"（真缺口是整包都没有）。
 */
function pluginSupplies(pkg: string, kind: string): boolean {
  const all = pluginSourceText(pkg);
  return all.includes("'ui.editor.languageService'") && all.includes(`'${kind}'`);
}

/** 从源码解析 `SlotServiceKind` 联合（类型在运行期被擦掉，表只能与源码字面量对拍） */
function slotServiceKindsFromSource(): readonly string[] {
  const text = appSource('monaco/language-registry.ts').text;
  const union = /export type SlotServiceKind =([\s\S]*?);/.exec(text);
  if (union === null) throw new Error('[slot-conformance] language-registry.ts 里找不到 SlotServiceKind 联合');
  // 去掉行注释，只留字面量成员（注释里的中文说明不该被当成成员）
  const body = (union[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1] as string);
}

/* ============================== 一、供方覆盖 ============================== */

/**
 * **供方台账**：每一条槽腿的主供方。
 *
 * 这张表就是"新增 kind 必须同批补供方"的抓手——联合里多一条而这里没有，第一组用例当场红。
 * `providerPlugin: null` 是**另一条合法出路**：声明"由宿主事实提供"（能力矩阵里那一档是
 * `builtin` / `self`），此时 `hostFact` 必须给非空理由。今天十四条全部由插件供，null 分支
 * 留作机制，负例自证在最后一组。
 */
interface SlotKindSupply {
  /** 这条腿在能力矩阵里对应哪一面（矩阵与 descriptor 的 `capabilities` 是同一份事实） */
  readonly capability: LanguageCapability;
  /** 主导供方（`packages/plugins` 下的目录名）；`null` = 宿主事实 */
  readonly providerPlugin: string | null;
  /** `providerPlugin === null` 时必填：宿主哪一面在供、为什么不需要插件 */
  readonly hostFact?: string;
  /**
   * **这条腿对哪些一等语言是"无人认领"**（ERB-PARITY G3 起，additive）。
   *
   * 语义只有一句：该语言的 descriptor **不点名**这条腿（`slotServices` 里没有它），
   * 也不假装有供方——它在能力矩阵里必须是 `{ exempt }`，理由写在那一格。
   * 台账因此可以如实写"这条腿只服务 ERB"，而**不必**为 kojo2 造一枚永远弃权的空贡献
   * （那会让"这门语言没有这一面"从数据变成障眼法）。
   *
   * 判据由本文件的用例双向钉住：列进来的语言 (a) 不许在豁免检查里被当成"有面"，
   * (b) 其能力矩阵那一格必须真是 `{ exempt }`，(c) 它的 `slotServices` 必须不含这条腿。
   */
  readonly unattendedFor?: readonly string[];
  /**
   * 供方判别字面量（additive，SDK-B5b 车 5）：缺省就是 `kind` 本身。
   *
   * 只有**专用槽**的腿需要它：`codeAction` 的供方不住 `ui.editor.languageService`（插件在
   * `ui.editor.codeAction` 上注册），包内自然没有 `'codeAction'` 这一枚判别字面量。给它一个
   * 显式的判别串，`pluginSupplies` 仍是同一把尺子（包内既有槽注册、又认得这条腿），
   * 不为这一格开"跳过检查"的口子。
   */
  readonly slotLiteral?: string;
}

const SLOT_KIND_SUPPLY: Readonly<Record<string, SlotKindSupply>> = {
  definition: { capability: LanguageCapability.Definition, providerPlugin: 'kojo-lang' },
  documentSymbol: { capability: LanguageCapability.Outline, providerPlugin: 'kojo-lang' },
  references: { capability: LanguageCapability.References, providerPlugin: 'kojo-lang' },
  foldingRange: { capability: LanguageCapability.Folding, providerPlugin: 'kojo-lang' },
  inlayHint: { capability: LanguageCapability.Inlay, providerPlugin: 'kojo-lang' },
  completion: { capability: LanguageCapability.Completion, providerPlugin: 'kojo-lang' },
  hover: { capability: LanguageCapability.Hover, providerPlugin: 'kojo-lang' },
  signatureHelp: { capability: LanguageCapability.Signature, providerPlugin: 'kojo-lang' },
  formatting: { capability: LanguageCapability.Format, providerPlugin: 'kojo-lang' },
  rename: { capability: LanguageCapability.Rename, providerPlugin: 'kojo-lang' },
  documentHighlight: { capability: LanguageCapability.Highlight, providerPlugin: 'kojo-lang' },
  selectionRange: { capability: LanguageCapability.Selection, providerPlugin: 'kojo-lang' },
  codeLens: { capability: LanguageCapability.CodeLens, providerPlugin: 'kojo-lang' },
  semanticToken: { capability: LanguageCapability.Semantic, providerPlugin: 'kojo-lang' },
  /**
   * ERB-PARITY G3（2026-10-31）：跳到实现（`Ctrl+F12`）。
   *
   * 供方 = `erb-parser` 的 `provideErbDefinition`——它同时答 `definition` / `implementation`
   * 两个判别式（同一份"标签 > `#DIM` > 函数索引"，产出 kind 跟随请求），所以两条腿的顺序
   * 不可能分叉。kojo2 **不点名**这条腿：能力矩阵里 `implementation` 那格是 `{ exempt }`
   * （2.0 里"跳实现"与"转定义"同义，F12 已覆盖）⇒ 在这里记成"无人认领"，**不造空供方**。
   */
  implementation: {
    capability: LanguageCapability.Implementation,
    providerPlugin: 'erb-parser',
    unattendedFor: [KOJO2_LANGUAGE_ID],
  },
  /**
   * SDK-B5b 车 5（2026-10-31）：快速修复 / 一键迁移（`Ctrl+.` 那枚 CodeActionProvider）。
   *
   * 供方仍在**专用槽** `ui.editor.codeAction`（`@kojo/plugin-kojo-lang` 的
   * `kojo2-codeActions` 贡献，判据在 `@kojo/kojo-lang/code-actions`）；`SlotServiceKind` 里这一格
   * 只驱动"谁挂这枚 provider / 谁翻形状"（宿主槽腿工厂的 `legOf('codeAction', …)`）。
   * 能力面对到 `diagnostics`：它是"诊断面的可行动部分"（快速修复的就是面上那几条波浪线），
   * 两门语言都已交付（ERB `shared` / kojo2 `self`），不是豁免项。
   * 口径差别只有一格：判别字面量是 `ui.editor.codeAction`（见 `slotLiteral`）。
   */
  codeAction: {
    capability: LanguageCapability.Diagnostics,
    providerPlugin: 'kojo-lang',
    slotLiteral: 'ui.editor.codeAction',
  },
};

/** 一条台账合格吗（`null` 分支的理由判据；纯函数，负例直接对它断言） */
function supplyProblem(entry: SlotKindSupply): string | null {
  if (entry.providerPlugin !== null) return null;
  const reason = (entry.hostFact ?? '').trim();
  return reason.length >= 8 ? null : '声明「由宿主事实提供」必须给非空理由（≥8 字），否则等于没写';
}

/** 一门语言**实际会挂上**的槽腿（与 `registerForLanguageServices` 的判据逐字同口径） */
function effectiveSlotKinds(descriptor: LanguageDescriptor): readonly string[] {
  const named = descriptor.services?.slot ?? descriptor.slotServices ?? [];
  if (descriptor.languageServices === true) {
    return [...new Set([...slotServiceKindsFromSource(), ...named])];
  }
  return [...named];
}

/**
 * 单枚 kind 的宿主腿取证：哪些文件里有"这条 kind 经共享收口挂上一枚 Monaco provider"的注册
 * （正组与「新 kind 三件套负例」共用同一把尺子，判据只此一份）。
 */
function legMountFilesFor(kind: string): readonly string[] {
  return APP_SOURCES.filter((file) => {
    const text = file.text;
    let at = text.indexOf('registerForLanguageServices(');
    while (at >= 0) {
      const window = text.slice(at, at + 700);
      if (window.includes(`'${kind}'`) && /\.register[A-Za-z]+(?:Provider|EditProvider|EditProvider)\(/.test(window)) {
        return true;
      }
      at = text.indexOf('registerForLanguageServices(', at + 1);
    }
    // SDK-B5b 车 1 起的**共享工厂**形状：一条腿在表里用 `legOf('<kind>', …)` 声明，
    // 注册 API 作为该腿自己的第三件事实（工厂统一走 `registerForLanguageServices`）。
    // 判据不变——仍要求"kind 与一枚 Monaco register*Provider 在同一个模块里且经收口"。
    if (!text.includes('registerForLanguageServices(')) return false;
    let legAt = text.indexOf(`legOf('${kind}'`);
    while (legAt >= 0) {
      const window = text.slice(legAt, legAt + 400);
      if (/\.register[A-Za-z]+Provider\(/.test(window)) return true;
      legAt = text.indexOf(`legOf('${kind}'`, legAt + 1);
    }
    return false;
  }).map((file) => file.rel);
}

describe('供方覆盖：descriptor 声明的每条槽腿都有供方', () => {
  const kinds = slotServiceKindsFromSource();

  it('`SlotServiceKind` 联合从源码解析：非空、无重复，且与供方表逐项相等（新增 kind ⇒ 本组红）', () => {
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds).size, `SlotServiceKind 有重复成员：${kinds.join(',')}`).toBe(kinds.length);
    // 双向：表里多一条 / 少一条都红。少一条 = "这条腿没人认领"；多一条 = 表在记账退役的腿。
    expect([...kinds].sort(), '供方表与 SlotServiceKind 联合对不上：新增槽腿必须同批补供方与本表').toEqual(
      Object.keys(SLOT_KIND_SUPPLY).sort(),
    );
  });

  it('每条腿映射到一张已交付的能力面（无人认领的语言除外，且必须在台账里点名），且映射一对一', () => {
    const capabilities = Object.entries(SLOT_KIND_SUPPLY).map(([kind, entry]) => {
      const unattended = entry.unattendedFor ?? [];
      for (const languageId of PARITY_LANGUAGE_IDS) {
        const status = LANGUAGE_CAPABILITY_MATRIX[languageId][entry.capability];
        if (unattended.includes(languageId)) {
          // "无人认领"必须与矩阵的豁免**成对**出现：台账说这条腿不服务它，矩阵就必须把这一格
          // 记成已知缺口（理由在那儿写）。两处任一单独放宽都是静默降级（铁律 4）。
          expect(
            isLanguageCapabilityExemption(status),
            `${kind} 在 ${languageId} 上记了"无人认领"，矩阵那一格却不是 { exempt }（台账与矩阵打架）`,
          ).toBe(true);
          continue;
        }
        expect(
          isLanguageCapabilityExemption(status),
          `${kind} → ${entry.capability} 在 ${languageId} 上是豁免项：槽腿必须对应一面已交付的能力`,
        ).toBe(false);
      }
      return entry.capability;
    });
    // 一对一：两条腿压到同一面能力上，说明"能力矩阵 ↔ 槽腿"的对应已经散了
    expect(new Set(capabilities).size).toBe(capabilities.length);

    // 反向只看 kojo2：它的共享面**逐条点名**（`slotServices`），所以"记了共享收口"与
    // "有一条同名槽腿"必须一一对上。ERB 不走这条：它走 `languageServices: true` 的旧桥。
    const kojo2Row = LANGUAGE_CAPABILITY_MATRIX[KOJO2_LANGUAGE_ID];
    const slotBacked = Object.values(SLOT_KIND_SUPPLY).map((entry) => entry.capability);
    for (const capability of Object.values(LanguageCapability)) {
      const status = kojo2Row[capability];
      if (isLanguageCapabilityExemption(status)) continue;
      if (status !== 'shared') continue;
      expect(
        slotBacked,
        `${KOJO2_LANGUAGE_ID}/${capability} 记的是共享收口，却没有对应的槽腿`,
      ).toContain(capability);
    }
  });

  it('「无人认领」只在台账里点名一次，且该语言真的没挂这条腿（G3：kojo2 × implementation）', () => {
    const unattended = Object.entries(SLOT_KIND_SUPPLY).filter(
      ([, entry]) => (entry.unattendedFor ?? []).length > 0,
    );
    expect(unattended.map(([kind]) => kind).sort()).toEqual(['implementation']);
    const kojo2Legs = effectiveSlotKinds(languageDescriptorOf(KOJO2_LANGUAGE_ID));
    expect(kojo2Legs, 'kojo2 的 descriptor 点名了 implementation：台账说它不服务这条腿').not.toContain(
      'implementation',
    );
    // ERB 侧仍全腿（旧桥 languageServices: true）：台账的 unattended 不许把 ERB 也带进去
    expect(effectiveSlotKinds(languageDescriptorOf(ERB_LANGUAGE_ID))).toContain('implementation');
  });

  it('每条腿的主导供方包真的在供：包内既有槽注册、又认得这个 kind', () => {
    const packages = pluginPackages();
    expect(packages.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const entry = SLOT_KIND_SUPPLY[kind];
      expect(entry, `${kind} 没有台账条目`).toBeDefined();
      if (entry === undefined) continue;
      expect(supplyProblem(entry), `${kind} 的台账不合格`).toBeNull();
      if (entry.providerPlugin === null) continue;
      expect(packages, `${kind} 的供方包 "plugin-${entry.providerPlugin}" 不存在`).toContain(
        entry.providerPlugin,
      );
      expect(
        pluginSupplies(entry.providerPlugin, entry.slotLiteral ?? kind),
        `${entry.providerPlugin} 包内找不到 ${kind} 的供方（要有槽注册与判别字面量 ${
          entry.slotLiteral ?? kind
        }）`,
      ).toBe(true);
    }
  });

  it('两门一等语言实际挂上的腿 = 供方表：ERB 全腿（languageServices），kojo2 逐条点名', () => {
    // ERB 声明的是 `languageServices: true`（旧桥），语义 = 全腿
    const erbLegs = effectiveSlotKinds(languageDescriptorOf(ERB_LANGUAGE_ID));
    expect([...erbLegs].sort()).toEqual([...kinds].sort());

    // kojo2 是逐条点名：既不许少（少 = 这条腿没人挂）也不许多（多 = 声明了没人认）。
    // 例外只有台账里点名的"无人认领"腿（G3：`implementation`——矩阵里它是 { exempt }，
    // kojo2 不点名、不造空供方；见 SLOT_KIND_SUPPLY 那一格的理由）。
    const unattended = Object.entries(SLOT_KIND_SUPPLY)
      .filter(([, entry]) => (entry.unattendedFor ?? []).includes(KOJO2_LANGUAGE_ID))
      .map(([kind]) => kind);
    const kojo2Expected = kinds.filter((kind) => !unattended.includes(kind));
    const kojo2Descriptor = languageDescriptorOf(KOJO2_LANGUAGE_ID);
    expect([...effectiveSlotKinds(kojo2Descriptor)].sort()).toEqual([...kojo2Expected].sort());
    // 逐条点名（不是走旧桥）：这条断言防"把 kojo2 也改成 languageServices: true"悄悄放宽口径
    expect(kojo2Descriptor.languageServices).toBeUndefined();
  });

  it('宿主腿：每条 kind 都有一枚经 registerForLanguageServices 挂的 Monaco provider，且模块被装配点 import', () => {
    for (const kind of kinds) {
      const files = legMountFilesFor(kind);
      expect(files, `${kind} 没有走共享收口的 Monaco 注册`).not.toEqual([]);
      // 至少有一枚落在 monaco/ 且被装配点接上（ui/ 里的直接注册也算装配，见 importedByGlobal）
      expect(
        files.some((rel) => importedByGlobal(rel)),
        `${kind} 的注册模块没有一个被 ${GLOBAL_PROVIDERS} 接上（写了没人调 = 死代码）`,
      ).toBe(true);
    }
  });

  it('「由宿主事实提供」是表里的一等写法：不给理由即判不合格（机制自证）', () => {
    expect(supplyProblem({ capability: LanguageCapability.Indent, providerPlugin: null })).not.toBeNull();
    expect(
      supplyProblem({ capability: LanguageCapability.Indent, providerPlugin: null, hostFact: '  ' }),
    ).not.toBeNull();
    expect(
      supplyProblem({
        capability: LanguageCapability.Indent,
        providerPlugin: null,
        hostFact: '缩进由语言配置自带（onEnterRules），不注册 provider',
      }),
    ).toBeNull();
    // 今天没有一条腿走宿主事实：十四条全是插件供方（走 null 分支必须同批改这里）
    expect(Object.values(SLOT_KIND_SUPPLY).filter((entry) => entry.providerPlugin === null)).toEqual([]);
  });
});

/* ============================== 一b、新 kind 三件套的负例自证 ============================== */

/**
 * 「新增一条 `SlotServiceKind` 而漏补 供方 / 腿 / 台账 ⇒ 至少一枚闸红」的**可执行证明**。
 *
 * 钉什么：上面「供方覆盖」那三把尺子（联合 ↔ 台账逐项相等、每条 kind 有台账条目、每条 kind
 * 有经共享收口的注册）对一枚**凭空多出来的 kind** 逐条真的会抛——不是口号，是把同一段断言
 * 喂给假 kind 跑一遍。不钉会怎样：三把尺子若哪天集体空转（filter 写歪、table 判据被
 * `?? 兜底` 吞掉），新 kind 就能带着"供方/腿/矩阵三件套全缺"静默过关——这正是本文件
 * 头注承诺要拦的"静默通过"。
 */
describe('新 kind 三件套负例自证：只加 SlotServiceKind、不补供方/腿/台账 ⇒ 每把尺子都抛', () => {
  const PROBE_KIND = 'acmeProbeLeg';

  it('假想 kind 喂进三把尺子：相等闸抛、台账闸抛、挂载腿闸空表（原断言形状即红）', () => {
    // 前置事实：这枚 kind 确实"三件套全缺"（今天源码里没人认识它）。
    expect(SLOT_KIND_SUPPLY[PROBE_KIND]).toBeUndefined();
    expect(legMountFilesFor(PROBE_KIND)).toEqual([]);
    const fakeKinds = [...slotServiceKindsFromSource(), PROBE_KIND];
    // 尺子 1：联合 ↔ 台账逐项相等（「供方覆盖」第一格的原文判据）。
    expect(() =>
      expect([...fakeKinds].sort()).toEqual(Object.keys(SLOT_KIND_SUPPLY).sort()),
    ).toThrowError();
    // 尺子 2：每条 kind 必须有台账条目（原文是 expect(entry).toBeDefined()）。
    expect(() => expect(SLOT_KIND_SUPPLY[PROBE_KIND], `${PROBE_KIND} 没有台账条目`).toBeDefined()).toThrowError();
    // 尺子 3：每条 kind 必须有经共享收口的 Monaco 腿（原文是 expect(files).not.toEqual([])）。
    expect(() =>
      expect(legMountFilesFor(PROBE_KIND), `${PROBE_KIND} 没有走共享收口的 Monaco 注册`).not.toEqual([]),
    ).toThrowError();
  });

  it('真实 kind 当前三把尺子全绿（负例的红来自"新 kind 缺件套"，不是尺子本身坏了）', () => {
    const kinds = slotServiceKindsFromSource();
    expect([...kinds].sort()).toEqual(Object.keys(SLOT_KIND_SUPPLY).sort());
    for (const kind of kinds) {
      expect(SLOT_KIND_SUPPLY[kind], `${kind} 没有台账条目`).toBeDefined();
      expect(legMountFilesFor(kind), `${kind} 没有走共享收口的 Monaco 注册`).not.toEqual([]);
    }
  });
});

/** 按 id 取已登记的 descriptor（登记发生在 `languages.ts` 求值期） */
function languageDescriptorOf(languageId: string): LanguageDescriptor {
  const descriptor = descriptorForLanguageId(languageId);
  if (descriptor === null) {
    throw new Error(`[slot-conformance] ${languageId} 没有登记 descriptor（languages.ts 未被求值？）`);
  }
  return descriptor;
}

/* ============================== 二、三态契约 ============================== */

/** 请求只需要 `kind`：各腿的字段形状由各自的构造器测试钉住，这里只判"这条腿怎么判三态" */
function requestOf(kind: string): EditorLanguageServiceRequest {
  return { kind } as unknown as EditorLanguageServiceRequest;
}

type Responder = (kind: string) => EditorLanguageServiceResult | undefined;

/** 一条只答一件事的贡献（`order` 缺省不写 = 契约缺省 0） */
function contribution(id: string, responder: Responder, order?: number): EditorLanguageServiceContribution {
  return {
    id,
    ...(order === undefined ? {} : { order }),
    provide: (request) => responder(request.kind),
  };
}

/** 一条腿在 conformance 里的形态 */
interface LegSpec {
  readonly kind: string;
  /** `'union'` = 集合型（取并集）；`'first-answer'` = 第一家作答说了算 */
  readonly shape: 'union' | 'first-answer';
  readonly collect: (
    contributions: readonly EditorLanguageServiceContribution[],
    request: EditorLanguageServiceRequest,
  ) => unknown;
  /** 认这门语言、但这里没有（**作答**） */
  readonly answeredEmpty: EditorLanguageServiceResult;
  /** 有结果 */
  readonly answeredValue: EditorLanguageServiceResult;
  /** 从返回值里读出一眼可辨的标记（断言"谁答的"） */
  readonly mark: (result: unknown) => string;
  /** 只交 `answeredValue` 时应当读到的标记（显式写死：别用 `mark(answeredValue)` 自证，两条腿的产出形状不同） */
  readonly valueMark: string;
  /** 只交 `answeredEmpty` 时应当读到的标记 */
  readonly emptyMark: string;
}

const symbolAt = (filePath: string, line: number): EditorSymbolLocation => ({ filePath, line });

const renameEdit: EditorRenameEdit = { line: 1, startColumn: 1, endColumn: 2, newText: 'VALUE' };
const highlight: EditorDocumentHighlight = { line: 1, startColumn: 1, endColumn: 2, kind: 'write' };
const signature: EditorSignature = { label: 'VALUE()', parameters: [], activeParameter: 0 };

const LEGS: readonly LegSpec[] = [
  {
    kind: 'completion',
    shape: 'union',
    collect: collectCompletionItems,
    answeredEmpty: { kind: 'completion', items: [] },
    answeredValue: { kind: 'completion', items: [{ label: 'VALUE' }] },
    mark: (result) =>
      Array.isArray(result) ? result.map((item: EditorCompletionItem) => item.label).join('|') : 'undefined',
    valueMark: 'VALUE',
    emptyMark: '',
  },
  {
    kind: 'hover',
    shape: 'first-answer',
    collect: collectHoverResult,
    answeredEmpty: { kind: 'hover', contents: '' },
    answeredValue: { kind: 'hover', contents: 'VALUE' },
    mark: (result) => (result as { contents?: string } | undefined)?.contents ?? 'undefined',
    valueMark: 'VALUE',
    emptyMark: '',
  },
  {
    kind: 'formatting',
    shape: 'first-answer',
    collect: collectFormattingEdits,
    answeredEmpty: { kind: 'formatting', edits: [] },
    answeredValue: { kind: 'formatting', edits: [{ startLine: 1, endLine: 1, newText: 'VALUE' }] },
    mark: (result) =>
      Array.isArray(result) ? result.map((edit: EditorRangeEdit) => edit.newText).join('|') : 'undefined',
    valueMark: 'VALUE',
    emptyMark: '',
  },
  {
    kind: 'signatureHelp',
    shape: 'first-answer',
    collect: collectSignatureHelp,
    answeredEmpty: { kind: 'signatureHelp', signatures: [] },
    answeredValue: { kind: 'signatureHelp', signatures: [signature] },
    mark: (result) => (Array.isArray(result) ? result.map((s: EditorSignature) => s.label).join('|') : 'undefined'),
    valueMark: 'VALUE()',
    emptyMark: '',
  },
  {
    kind: 'references',
    shape: 'first-answer',
    collect: collectReferences,
    answeredEmpty: { kind: 'references', locations: [] },
    answeredValue: { kind: 'references', locations: [symbolAt('D:/p/VALUE.erb', 2)] },
    mark: (result) =>
      (result as { locations?: readonly EditorSymbolLocation[] } | undefined)?.locations
        ?.map((location) => location.filePath)
        .join('|') ?? 'undefined',
    valueMark: 'D:/p/VALUE.erb',
    emptyMark: '',
  },
  {
    kind: 'rename',
    shape: 'first-answer',
    collect: collectRename,
    answeredEmpty: { kind: 'rename', edits: [] },
    answeredValue: { kind: 'rename', edits: [renameEdit] },
    mark: (result) =>
      (result as { edits?: readonly EditorRenameEdit[] } | undefined)?.edits
        ?.map((edit) => edit.newText)
        .join('|') ?? 'undefined',
    valueMark: 'VALUE',
    emptyMark: '',
  },
  {
    kind: 'renameTarget',
    shape: 'first-answer',
    collect: collectRenameTarget,
    answeredEmpty: { kind: 'renameTarget', rejectReason: '这里不能改名' },
    answeredValue: { kind: 'renameTarget', target: { line: 1, startColumn: 1, endColumn: 2, text: 'VALUE' } },
    mark: (result) => (result as { target?: { text: string } } | undefined)?.target?.text ?? 'answered-empty',
    valueMark: 'VALUE',
    emptyMark: 'answered-empty',
  },
  {
    // LAU-4 调用层级腿（2026-10-31）：与 `renameTarget` 同一种"契约成员但**没有** Monaco 腿"。
    // Monaco 0.57 没有 `registerCallHierarchyProvider`（PITFALLS §83），它不是
    // `SlotServiceKind`（那不驱动任何注册，只驱动 descriptor 的挂载名单），消费方是宿主
    // 面板 `ui/CallHierarchyOverlay.tsx`——但它仍必须与本模块同口径地走三态。
    kind: 'callHierarchy',
    shape: 'first-answer',
    collect: collectCallHierarchy,
    // "认这一格、但这一行不在任何可调用体内"是**作答**（`subject: null`），不是弃权；
    // 反向索引不可用时也是作答（`referencesAvailable: false`，两个方向都空）。
    answeredEmpty: { kind: 'callHierarchy', subject: null, incoming: [], outgoing: [], referencesAvailable: true },
    answeredValue: {
      kind: 'callHierarchy',
      subject: { name: 'VALUE', normalizedName: 'VALUE', filePath: 'D:/p/VALUE.erb', startLine: 1, endLine: 2 },
      incoming: [],
      outgoing: [],
      referencesAvailable: true,
    },
    mark: (result) => (result as { subject?: { name: string } | null } | undefined)?.subject?.name ?? 'answered-empty',
    valueMark: 'VALUE',
    emptyMark: 'answered-empty',
  },
  {
    kind: 'documentHighlight',
    shape: 'first-answer',
    collect: collectDocumentHighlights,
    answeredEmpty: { kind: 'documentHighlight', highlights: [] },
    answeredValue: { kind: 'documentHighlight', highlights: [highlight] },
    mark: (result) =>
      (result as { highlights?: readonly EditorDocumentHighlight[] } | undefined)?.highlights?.length.toString() ??
      'undefined',
    valueMark: '1',
    emptyMark: '0',
  },
  {
    kind: 'selectionRange',
    shape: 'first-answer',
    collect: collectSelectionRanges,
    answeredEmpty: { kind: 'selectionRange', selections: [] },
    answeredValue: {
      kind: 'selectionRange',
      selections: [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }],
    },
    mark: (result) =>
      (result as { selections?: readonly unknown[] } | undefined)?.selections?.length.toString() ?? 'undefined',
    valueMark: '1',
    emptyMark: '0',
  },
  {
    kind: 'codeLens',
    shape: 'first-answer',
    collect: collectCodeLensResult,
    answeredEmpty: { kind: 'codeLens', lenses: [] },
    answeredValue: { kind: 'codeLens', lenses: [{ line: 1, label: 'VALUE' }] },
    mark: (result) =>
      (result as { lenses?: readonly { label: string }[] } | undefined)?.lenses?.map((lens) => lens.label).join('|') ??
      'undefined',
    valueMark: 'VALUE',
    emptyMark: '',
  },
];

/** 一条只答某个 kind 的贡献（其余一律弃权） */
function legContribution(id: string, leg: LegSpec, answer: 'empty' | 'value' | 'abstain', order?: number) {
  return contribution(
    id,
    (kind) => {
      if (kind !== leg.kind) return undefined;
      if (answer === 'abstain') return undefined;
      return answer === 'empty' ? leg.answeredEmpty : leg.answeredValue;
    },
    order,
  );
}

describe('三态契约：undefined（弃权）/ 空结果（作答）/ 有结果', () => {
  it('取数腿台账：kind 不认得即红；共享取数模块没覆盖的那五条腿点名在案', () => {
    const legKinds = LEGS.map((leg) => leg.kind);
    expect(new Set(legKinds).size, 'LEGS 里有重复 kind').toBe(legKinds.length);
    // 拼写漂移（kind 改名而腿没跟）当场红。白名单里的两枚是"契约成员但**没有** Monaco
    // 注册面"的腿：`renameTarget`（只经改名两步协议消费）与 `callHierarchy`（Monaco 0.57
    // 无 `registerCallHierarchyProvider`，消费方是宿主面板）。它们不进 `SlotServiceKind`，
    // 因为那枚联合只决定 descriptor 挂哪些 Monaco provider——列进去会逼着造一枚挂不上的注册。
    const knownKinds = new Set<string>([...Object.keys(SLOT_KIND_SUPPLY), 'renameTarget', 'callHierarchy']);
    for (const kind of legKinds) {
      expect(
        knownKinds,
        `LEGS 里的 "${kind}" 既不在 SlotServiceKind 里，也不是 renameTarget / callHierarchy`,
      ).toContain(
        kind,
      );
    }
    // 两类形态都要有样本：只有单答型就漏了并集纪律，反之亦然
    expect(LEGS.filter((leg) => leg.shape === 'union').map((leg) => leg.kind)).toEqual(['completion']);
    expect(LEGS.filter((leg) => leg.shape === 'first-answer').length).toBeGreaterThan(1);

    // 共享取数模块（`kojo-language-service-legs.ts`）只收口这十一条（十条槽腿 +
    // `callHierarchy`）；其余槽腿由各自模块作答
    // （`kojo-definition.ts` 的 `collectDefinitionLocations` 收 `definition` /
    // `implementation` 两条同形腿；`kojo2-symbols…` / `kojo2-folding.ts` / `kojo2-indent.ts`
    // 等各答一条），它们的三态与注册由各自的单测钉住。这条台账防"某条腿悄悄搬走却没人接"。
    const withoutSharedCollector = Object.keys(SLOT_KIND_SUPPLY)
      .filter((kind) => !legKinds.includes(kind))
      .sort();
    expect(withoutSharedCollector).toEqual([
      // 车 5（2026-10-31）：`codeAction` 的三态不在这张表上——它不走
      // `ui.editor.languageService` 的判别（专用槽 + 同步返回数组，没有"弃权 = undefined"这一态），
      // 三态与落地由 `kojo2-code-actions.test.ts` 逐格钉住。
      'codeAction',
      'definition',
      'documentSymbol',
      'foldingRange',
      'implementation',
      'inlayHint',
      'semanticToken',
    ]);
    // `renameTarget` 是 LAU-4 的契约成员，**没有** Monaco 腿（`SlotServiceKind` 里不列它）：
    // 它只经改名两步协议被消费，三态（弃权 / 拒绝理由 / 目标）仍须与本模块同口径。
    expect(legKinds).toContain('renameTarget');
    // `callHierarchy` 同理（LAU-4 调用层级腿）：Monaco 0.57 无注册 API，消费方是宿主面板
    // `ui/CallHierarchyOverlay.tsx`，供方在 `@kojo/plugin-erb-parser`。**不进** `SlotServiceKind`
    // 是判据而不是遗漏：那枚联合只驱动 `registerForLanguageServices` 的挂载，列进去只能
    // 登记一枚挂不上的 provider。它的三态（弃权 / `subject: null` 作答 / 有边）由本台账钉住。
    expect(legKinds).toContain('callHierarchy');
    expect(
      slotServiceKindsFromSource(),
      'callHierarchy 没有 Monaco 注册面，不该进 SlotServiceKind',
    ).not.toContain('callHierarchy');
  });

  it('单家作答：空结果 ⇒ 交回空作答（不是 undefined）；有结果 ⇒ 原样交回', () => {
    for (const leg of LEGS) {
      const empty = leg.collect([legContribution('only', leg, 'empty')], requestOf(leg.kind));
      expect(empty, `${leg.kind}：空结果被当成了弃权（宿主会去问别家 / 走兜底）`).not.toBeUndefined();
      expect(leg.mark(empty), `${leg.kind}：空作答交回的形态不对`).not.toBe('undefined');

      const value = leg.collect([legContribution('only', leg, 'value')], requestOf(leg.kind));
      expect(value, `${leg.kind}：有结果却交回 undefined`).not.toBeUndefined();
      expect(leg.mark(value), `${leg.kind}：有结果的标记丢了`).toBe(leg.valueMark);
    }
  });

  it('单家弃权 ⇒ undefined（宿主走兜底）；两家全弃权同样 undefined（不是空结果）', () => {
    // 集合型不在此列：并集腿的"没人答"就是空集（见下面 completion 那条），不存在 undefined 这一态
    for (const leg of LEGS.filter((spec) => spec.shape === 'first-answer')) {
      expect(leg.collect([legContribution('only', leg, 'abstain')], requestOf(leg.kind)), leg.kind).toBeUndefined();
      expect(
        leg.collect(
          [legContribution('a', leg, 'abstain'), legContribution('b', leg, 'abstain')],
          requestOf(leg.kind),
        ),
        `${leg.kind}：全弃权必须交回 undefined（交回空结果会让宿主的兜底永不出现）`,
      ).toBeUndefined();
    }
  });

  it('空 ≠ 弃权：先弃权、再作答空 ⇒ 交回空作答，且第三家不再被问（单答型）', () => {
    for (const leg of LEGS.filter((spec) => spec.shape === 'first-answer')) {
      const asked: string[] = [];
      const spy = (id: string, answer: 'empty' | 'value' | 'abstain') =>
        contribution(id, (kind) => {
          asked.push(id);
          if (kind !== leg.kind) return undefined;
          return answer === 'abstain' ? undefined : answer === 'empty' ? leg.answeredEmpty : leg.answeredValue;
        });
      const out = leg.collect([spy('a', 'abstain'), spy('b', 'empty'), spy('c', 'value')], requestOf(leg.kind));
      expect(out, `${leg.kind}：第二家已作答空，不该交回 undefined`).not.toBeUndefined();
      expect(asked, `${leg.kind}：空作答之后不该再问第三家`).toEqual(['a', 'b']);
      expect(leg.mark(out), `${leg.kind}：交回的不该是第三家的值`).toBe(leg.emptyMark);
    }
  });

  it('第一家作答有值 ⇒ 后面的一家一律不问（单答型）', () => {
    for (const leg of LEGS.filter((spec) => spec.shape === 'first-answer')) {
      const asked: string[] = [];
      const spy = (id: string, answer: 'empty' | 'value' | 'abstain') =>
        contribution(id, (kind) => {
          asked.push(id);
          if (kind !== leg.kind) return undefined;
          return answer === 'abstain' ? undefined : answer === 'empty' ? leg.answeredEmpty : leg.answeredValue;
        });
      const out = leg.collect([spy('a', 'abstain'), spy('b', 'value'), spy('c', 'value')], requestOf(leg.kind));
      expect(asked, `${leg.kind}：第一家作答后仍继续问`).toEqual(['a', 'b']);
      expect(leg.mark(out), `${leg.kind}：没交回第一家的值`).toBe(leg.valueMark);
    }
  });

  it('completion（集合型）：弃权与空作答都不阻断并集，全空 ⇒ []，不返回 undefined', () => {
    const leg = LEGS.find((spec) => spec.kind === 'completion');
    expect(leg, 'completion 腿没登记').toBeDefined();
    if (leg === undefined) return;
    const merged = leg.collect(
      [
        legContribution('abstain', leg, 'abstain'),
        legContribution('empty', leg, 'empty'),
        legContribution('value', leg, 'value'),
      ],
      requestOf(leg.kind),
    );
    expect(leg.mark(merged)).toContain('VALUE');
    // 全空：交回 []（集合型的"没人答"就是空集，不存在 undefined 这一态）
    const allEmpty = leg.collect(
      [legContribution('e1', leg, 'empty'), legContribution('e2', leg, 'abstain')],
      requestOf(leg.kind),
    );
    expect(Array.isArray(allEmpty)).toBe(true);
    expect(allEmpty).toEqual([]);
  });

  it('一家抛错只让这家缺席（warn 带贡献 id）：单答型继续问下一家，集合型其余照收', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const leg of LEGS) {
      const exploding = contribution('boom', () => {
        throw new Error('供方炸了');
      });
      const out = leg.collect([exploding, legContribution('next', leg, 'value')], requestOf(leg.kind));
      expect(out, `${leg.kind}：抛错的一家把整条腿带走了`).not.toBeUndefined();
      expect(leg.mark(out), `${leg.kind}：抛错之后没有问下一家`).toBe(leg.valueMark);
    }
    const messages = warn.mock.calls.map((args) => String(args[0]));
    expect(
      messages.some((message) => message.includes("'boom'")),
      '抛错没有经过 console.warn 点名贡献 id（等于把一个坏插件伪装成好插件）',
    ).toBe(true);
    warn.mockRestore();
  });

  it('抛错也按弃权算：只有抛错的一家时，单答型交回 undefined（不静默编一个空答案）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const leg of LEGS.filter((spec) => spec.shape === 'first-answer')) {
      const exploding = contribution('boom', () => {
        throw new Error('供方炸了');
      });
      expect(leg.collect([exploding], requestOf(leg.kind)), leg.kind).toBeUndefined();
    }
    warn.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================== 三、排序 ============================== */

/** 一条悬停贡献（`order` 明确给出，答的是自己的 id） */
function hoverContribution(id: string, order?: number): EditorLanguageServiceContribution {
  return contribution(
    id,
    (kind) => (kind === 'hover' ? { kind: 'hover', contents: `answer-${id}` } : undefined),
    order,
  );
}

describe('排序：同 kind 多供方按 order 稳定', () => {
  it('内核 query：order 升序、同 order 按注册序、缺省 0 排最前', () => {
    const slots = new SlotRegistryImpl();
    slots.register('ui.editor.languageService', hoverContribution('c', 30), 'p1');
    slots.register('ui.editor.languageService', hoverContribution('a', 10), 'p2');
    slots.register('ui.editor.languageService', hoverContribution('b'), 'p3');
    slots.register('ui.editor.languageService', hoverContribution('d', 10), 'p4');
    expect(slots.query('ui.editor.languageService').map((item) => item.id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('取数腿按 query 顺序问：order 小的先作答（与注册先后无关）', () => {
    const slots = new SlotRegistryImpl();
    // 先注册 order 大的：若"第一家说了算"按注册序，这里会答 30
    slots.register('ui.editor.languageService', hoverContribution('late', 30), 'p1');
    slots.register('ui.editor.languageService', hoverContribution('early', 10), 'p2');
    const contributions = slots.query('ui.editor.languageService');
    expect(collectHoverContents(contributions, requestOf('hover'))).toBe('answer-early');
  });

  it('同 order 按注册序（稳定）：撤销中间一枚后其余次序逐字不变', () => {
    const slots = new SlotRegistryImpl();
    const unsubscribeFirst = slots.register('ui.editor.languageService', hoverContribution('first', 20), 'p1');
    slots.register('ui.editor.languageService', hoverContribution('second', 20), 'p2');
    slots.register('ui.editor.languageService', hoverContribution('zero'), 'p3');
    expect(slots.query('ui.editor.languageService').map((item) => item.id)).toEqual([
      'zero',
      'first',
      'second',
    ]);
    unsubscribeFirst();
    expect(slots.query('ui.editor.languageService').map((item) => item.id)).toEqual(['zero', 'second']);
  });
});

/* ============================== 四、扩展性 ============================== */

/** 假 monaco：只桩共享收口要用的那面（注册函数由用例决定，这里只当参数递） */
const FAKE_MONACO = {} as unknown as typeof MonacoRuntime;

/** 一枚可追踪的 disposable */
interface Tracked {
  readonly id: string;
  disposed: boolean;
  failOnDispose: boolean;
}

interface Recorder {
  readonly calls: string[];
  readonly created: Tracked[];
  /** 命中的语言 id 在这里抛错（模拟"第二门注册炸了"） */
  failOn: string | null;
}

function recorder(): Recorder {
  return { calls: [], created: [], failOn: null };
}

/** 共享收口的 `register` 实参：记账 + 可注入故障 */
function registerInto(rec: Recorder) {
  return (_monaco: typeof MonacoRuntime, languageId: string): MonacoRuntime.IDisposable => {
    rec.calls.push(languageId);
    if (rec.failOn === languageId) throw new Error(`桩：注册 '${languageId}' 抛错`);
    const entry: Tracked = { id: languageId, disposed: false, failOnDispose: false };
    rec.created.push(entry);
    return {
      dispose: () => {
        if (entry.failOnDispose) throw new Error(`桩：dispose '${languageId}' 抛错`);
        entry.disposed = true;
      },
    };
  };
}

/**
 * 一门假语言的 id：**宿主源码里一个字都没有**（"零宿主改动"的可验证形态）。
 * 名字与任何真实语言无关，也不带下划线大写后缀（免得撞上一门真语言）。
 */
const PROBE_LANGUAGE_ID = 'conformance-probe-lang';

const PROBE_DESCRIPTOR: LanguageDescriptor = {
  id: PROBE_LANGUAGE_ID,
  label: 'conformance probe',
  matchesPath: (filePath) => filePath.endsWith('.probe'),
  register: () => undefined,
  // 只声明一条槽腿：挂不挂得上完全由这条声明决定，与宿主代码无关
  slotServices: ['hover'],
};

describe('扩展性：加一门语言零宿主改动', () => {
  it('不传 kind ⇒ 只挂 legacyBridge 语言（JSON / XML 这类只读保留面一枚都不挂）', () => {
    const rec = recorder();
    registerForLanguageServices(FAKE_MONACO, registerInto(rec));
    expect(rec.calls).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]);
  });

  it('传 kind ⇒ legacyBridge 语言 + descriptor 点名这条腿的语言，顺序 = descriptor 注册序', () => {
    const rec = recorder();
    registerForLanguageServices(FAKE_MONACO, registerInto(rec), 'hover');
    expect(rec.calls).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]);
    // 只被点名一条腿的语言换一条腿就不该出现（"只声明了 hover"不是"全都声明了"）
    const rec2 = recorder();
    registerForLanguageServices(FAKE_MONACO, registerInto(rec2), 'definition');
    expect(rec2.calls).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]);
  });

  it('假语言只登记 descriptor 就挂上 provider：宿主源码里零改动（id 一个字都没出现过）', () => {
    registerLanguage(PROBE_DESCRIPTOR);
    // 相关源码一次都不认识这门语言（"零宿主改动"不是一句口号，是可断言的）
    const mentions = APP_SOURCES.filter((file) => file.text.includes(PROBE_LANGUAGE_ID)).map(
      (file) => file.rel,
    );
    expect(mentions, `${PROBE_LANGUAGE_ID} 出现在了宿主源码里（加语言要改宿主了）`).toEqual([]);

    const rec = recorder();
    registerForLanguageServices(FAKE_MONACO, registerInto(rec), 'hover');
    expect(rec.calls, '假语言没有挂上 provider（descriptor 的 slotServices 没被认）').toContain(
      PROBE_LANGUAGE_ID,
    );
    // 顺序在真语言之后（注册序），且它只出现一次
    expect(rec.calls.filter((id) => id === PROBE_LANGUAGE_ID)).toHaveLength(1);
    expect(rec.calls[rec.calls.length - 1]).toBe(PROBE_LANGUAGE_ID);

    // 反过来：点名一条它没声明的腿 ⇒ 不挂（声明是唯一的开关）
    const rec2 = recorder();
    registerForLanguageServices(FAKE_MONACO, registerInto(rec2), 'completion');
    expect(rec2.calls).not.toContain(PROBE_LANGUAGE_ID);
  });

  it('半途抛错：已挂上的那几枚当场回滚，错误原样外抛（不留只在错误路径出现的 provider）', () => {
    const rec = recorder();
    rec.failOn = KOJO_LANGUAGE_ID; // 第二门炸
    expect(() => registerForLanguageServices(FAKE_MONACO, registerInto(rec), 'hover')).toThrow(
      /桩：注册/,
    );
    expect(rec.calls).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]);
    // 第一门那枚必须已经被拆掉（旧写法把它丢在 map 的中间值里，泄漏一枚）
    expect(rec.created.map((entry) => entry.id)).toEqual([ERB_LANGUAGE_ID]);
    expect(rec.created[0]?.disposed).toBe(true);
  });

  it('成功句柄 dispose 拆掉每一枚；回滚期一枚 dispose 抛错不带走其余、也不吞原错误', () => {
    // ① 成功路径：句柄拆全部
    const ok = recorder();
    const handle = registerForLanguageServices(FAKE_MONACO, registerInto(ok), 'hover');
    expect(ok.created.every((entry) => !entry.disposed)).toBe(true);
    handle.dispose();
    expect(ok.created.every((entry) => entry.disposed)).toBe(true);

    // ② 回滚路径：第一枚 dispose 抛错，第二枚仍被拆；原错误（注册错误）原样外抛
    const broken = recorder();
    const register = registerInto(broken);
    const failSecondOnDispose = (monaco: typeof MonacoRuntime, languageId: string): MonacoRuntime.IDisposable => {
      const disposable = register(monaco, languageId);
      if (broken.created.length === 2) broken.created[1]!.failOnDispose = true;
      return disposable;
    };
    broken.failOn = KOJO2_LANGUAGE_ID; // 第三门炸 ⇒ 前两枚要回滚
    expect(() => registerForLanguageServices(FAKE_MONACO, failSecondOnDispose, 'hover')).toThrow(
      /桩：注册/,
    );
    expect(broken.created.map((entry) => entry.id)).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]);
    // 第一枚拆成功；第二枚 dispose 抛错被吞（隔离），但不许带走第一枚的拆除结果
    expect(broken.created[0]?.disposed).toBe(true);
    expect(broken.created[1]?.disposed).toBe(false);
  });
});

/* ============================== 五、禁回归（引用 M2 口径） ============================== */

/**
 * 「宿主目录里不许新增按语言 id 分支」这条判据**已有唯一实现**：`tools/audit-language.mjs`
 * 的 M2（`pnpm audit:language`，扫描面 = `packages/app/src` **整树**，逐文件棘轮、只拦增长）。
 * 本组**不重造 grep 规则**（再写一份必然与它漂移，且注释 / `audit-allow` 的豁免口径会分家），
 * 只引它的台账做两件事：
 *
 * 1. **台账自洽**：逐文件之和 = `total`（防止"总数没跟"这种假绿）；
 * 2. **口径未收窄**：M2 的扫描根仍是 `packages/app/src` 整树；共享收口那两枚文件零条目
 *    （槽位契约的装配面一旦长出语言 id 分支，"加语言零改动"当场作废）。
 *
 * 真正会变红的是那枚工具本身；这里钉的是"台账在这儿、口径没收窄"。
 */
describe('禁回归：语言 id 分支交给 audit-language 的 M2', () => {
  const baselinePath = path.join(REPO_ROOT, 'tools', 'audit-language-baseline.json');
  const toolPath = path.join(REPO_ROOT, 'tools', 'audit-language.mjs');

  it('M2 台账逐文件之和 = total，且这条检查在台账里有名字（口径可引用）', () => {
    expect(existsSync(baselinePath), `台账不在：${baselinePath}`).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      readonly checks: Record<string, { readonly total: number; readonly files: Record<string, number> }>;
    };
    const m2 = baseline.checks['M2(语言id分支)'];
    expect(m2, '台账里没有 M2(语言id分支)').toBeDefined();
    if (m2 === undefined) return;
    const sum = Object.values(m2.files).reduce((acc, count) => acc + count, 0);
    expect(sum, 'M2 台账逐文件之和与 total 对不上（总数没跟 = 假绿）').toBe(m2.total);
    expect(m2.total).toBeGreaterThan(0);
  });

  it('M2 口径仍扫 `packages/app/src` 整树（不收窄到 monaco），且槽收口两枚文件零条目', () => {
    expect(existsSync(toolPath), `审计工具不在：${toolPath}`).toBe(true);
    const tool = readFileSync(toolPath, 'utf8');
    const block = /id: 'M2\(语言id分支\)'[\s\S]{0,400}?dirs: \[([^\]]*)\]/.exec(tool);
    expect(block, 'tools/audit-language.mjs 里找不到 M2 的扫描目录声明').not.toBeNull();
    const dirs = block?.[1] ?? '';
    expect(dirs, 'M2 的扫描面被收窄了（只扫 monaco 等于给 ui/ 留一半没有闸的地方）').toContain(
      'packages/app/src',
    );
    expect(dirs).not.toContain('packages/app/src/monaco');

    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      readonly checks: Record<string, { readonly files: Record<string, number> }>;
    };
    const files = baseline.checks['M2(语言id分支)']?.files ?? {};
    // 槽位契约的装配面：多一张语言 id 分支，"新增一门语言零宿主改动"就当场作废
    for (const rel of [
      'packages/app/src/monaco/register-dialects.ts',
      'packages/app/src/monaco/kojo-language-service-legs.ts',
    ]) {
      expect(files[rel] ?? 0, `${rel} 里出现了按语言 id 分支（M2 台账已记账）`).toBe(0);
    }
  });
});