/**
 * 语言面 **格子 × 语言全覆盖矩阵**（LAU-COVERAGE，第十一波，2026-10-31）。
 *
 * ## 这一张表回答的问题（LAU 系列唯一没被系统数过的面）
 *
 * 此前的台账（`language-parity` 的 DOUBLE-LEG 三组、`kojo-signature` 的 `-SIG`、
 * `rename-dualleg`）都在**逐格**收敛双挂；本文件是它们的**上层**：把三张表——
 * ① 契约 `ui.editor.languageService` 判别成员全集（`packages/plugin-api/src/slots.ts`，
 *   从源码解析，不抄文档）、② Monaco 侧真实存在的 `register*Provider` 注册面
 *   （`packages/app/src/**` 全量扫描）、③ 槽腿工厂表 `SLOT_SERVICE_LEGS` /
 *   `SLOT_SERVICE_WRITE_LEGS`（`monaco/slot-service-providers.ts`）——互相比对成
 *   **每一枚 kind × 每一门语言恰一格**的矩阵，每格四态之一：
 *
 * - `slot`：共享槽腿答（工厂表有这枚腿 + 该语言实际被挂上 + 包里有供方）；
 * - `host`：宿主腿答（旧桥/专用 provider，文件与标记逐格在册）；
 * - `gap`：**两边都没人**（本波逐格数出来的真缺口，全部挂看板欠账卡，判据钉前置条件）；
 * - `na`：该格对这门语言不适用（理由非空，且不许拿"不适用"当遮羞布：不许点名、
 *   不许有声称的应答渠道，豁免必须与能力矩阵 `{ exempt }` 或代码里的弃权闸成对）。
 *
 * ## 红判据（这张表如何"红"）
 *
 * 1. 契约联合新增一枚而矩阵没进 ⇒ 红（逐枚对拍，非 `>=` 包含）。
 * 2. `SLOT_SERVICE_LEGS` 新增腿 / 宿主新增 `register*Provider` 注册面而表不认 ⇒ 红。
 * 3. 某格从"有人答"掉成"没人答"（腿删了、供方没了、宿主腿注册点消失、装配点不再调）⇒ 红。
 * 4. **没有供方却点名**（descriptor 点名一条包里没有供方的腿）⇒ 红——这是本系列铁律
 *    （点名＝静默没有）在矩阵层的钉子。
 * 5. `gap` 格脱离看板卡 ⇒ 红（`@debt-ledger BOARD:LAU-COVERAGE` 与卡同批增删，
 *    由 `debt-ledger-registry.test.ts` 兜另一半）。
 *
 * ## 行为面（不是只验源码形状）
 *
 * 挂载判据全部经**真实收口** `registerForLanguageServices` 的运行期模拟（recorder 计语言名单），
 * 供方应答走插件真函数（`provideErbDefinition` / `provideErbCallHierarchy`）拿读数。
 * 逐格"恰一枚"的双挂收敛判据住在 `language-parity.test.ts`（DOUBLE-LEG 三组），本文件不重抄。
 *
 * ## 三张表的实际枚数（2026-10-31 逐枚数，别信注释）
 *
 * 契约判别成员 18；`SlotServiceKind` 16（= 契约里除 `workspaceSymbol` / `renameTarget` /
 * `callHierarchy` 之外全部 + 专用槽腿 `codeAction`）；`SLOT_SERVICE_LEGS` 工厂腿 10（含写面
 * `codeAction`）。矩阵行 = 18 契约 kind + `codeAction` = 19 行；列 = 三门语言
 * （`kojo-erb` / `kojo2` / `kojo`〔kojo1 封存层〕）= **57 格**。
 * 口上 XML / JSON 是数据格式面：不声明旧桥也不点名，收口对它们零挂载（另有一格断言钉住）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceRequest } from '@kojo/plugin-api';
import { provideErbCallHierarchy, provideErbDefinition } from '@kojo/plugin-erb-parser';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import {
  LANGUAGE_CAPABILITY_MATRIX,
  isLanguageCapabilityExemption,
} from '../src/monaco/language-capabilities';
import { declaredSlotKinds, descriptorForLanguageId, type LanguageDescriptor } from '../src/monaco/language-registry';
import '../src/monaco/languages';
import { registerForLanguageServices } from '../src/monaco/register-dialects';
import type { SlotServiceKind } from '../src/monaco/language-registry';
import { JSON_LANGUAGE_ID } from '../src/monaco/json-language';
import { KOJO_XML_LANGUAGE_ID } from '../src/monaco/xml-language';

/* ============================== 取证基建 ============================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const APP_SRC = path.join(REPO_ROOT, 'packages', 'app', 'src');
const PLUGINS_ROOT = path.join(REPO_ROOT, 'packages', 'plugins');
const BOARD_FILE = path.join(REPO_ROOT, 'docs', 'BOARD.md');

const read = (abs: string): string => {
  if (!existsSync(abs)) throw new Error(`[kind-coverage] 取证路径不存在：${abs}`);
  return readFileSync(abs, 'utf8');
};
const appRel = (rel: string): string => read(path.join(APP_SRC, rel));
const readAppRel = (rel: string): string => appRel(rel);

function collectSources(root: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry.name)) out.push(abs);
    }
  };
  walk(root);
  return out;
}

const APP_ALL = collectSources(APP_SRC).map((abs) => ({
  rel: path.relative(APP_SRC, abs).split(path.sep).join('/'),
  text: readFileSync(abs, 'utf8'),
}));
const GLOBAL_PROVIDERS_TEXT = appRel('ui/editor-global-providers.ts');

/** 包级供方取证（与 `language-slot-conformance` 同尺：包内既有槽注册、又认得这个贡献 id） */
function pluginSuppliesContribution(pkg: string, contributionId: string): boolean {
  const dir = path.join(PLUGINS_ROOT, pkg, 'src');
  if (!existsSync(dir)) return false;
  const all = collectSources(dir)
    .map((abs) => readFileSync(abs, 'utf8'))
    .join('\n');
  return (
    (all.includes("'ui.editor.languageService'") || all.includes("'ui.editor.codeAction'")) &&
    all.includes(`'${contributionId}'`)
  );
}

/* ============================== 表一：契约判别成员全集（从源码解析） ============================== */

const SLOTS_TS = read(path.join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'slots.ts'));

function contractKinds(): string[] {
  const union = /export type EditorLanguageServiceRequest =([\s\S]*?);/.exec(SLOTS_TS);
  if (union === null) throw new Error('[kind-coverage] slots.ts 里找不到 EditorLanguageServiceRequest 联合');
  const memberNames = [...(union[1] ?? '').matchAll(/\|\s*(Editor[A-Za-z0-9]+Request)/g)].map((m) => m[1] as string);
  const kinds = memberNames.map((name) => {
    const body = new RegExp(`export interface ${name}[\\s\\S]*?\\n}`).exec(SLOTS_TS);
    const iface = new RegExp(`export interface ${name}[\\s\\S]*?readonly kind: '([a-zA-Z]+)'`).exec(SLOTS_TS);
    if (body === null || iface === null) {
      throw new Error(`[kind-coverage] 成员 ${name} 解析不出 kind 字面量（新增成员请同批进矩阵）`);
    }
    return iface[1] as string;
  });
  return [...new Set(kinds)];
}

/** `SlotServiceKind` 联合（同一把尺子照 conformance 的解析：只剥行注释） */
function slotServiceKinds(): string[] {
  const text = appRel('monaco/language-registry.ts');
  const union = /export type SlotServiceKind =([\s\S]*?);/.exec(text);
  if (union === null) throw new Error('[kind-coverage] 找不到 SlotServiceKind 联合');
  const body = (union[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1] as string);
}

/** 工厂表：`legOf('<kind>'` 与写面腿清单 */
const FACTORY_TEXT = appRel('monaco/slot-service-providers.ts');
function factoryLegKinds(): string[] {
  return [...FACTORY_TEXT.matchAll(/legOf\('([A-Za-z]+)'/g)].map((m) => m[1] as string);
}
function writeLegKinds(): string[] {
  const decl = /SLOT_SERVICE_WRITE_LEGS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(FACTORY_TEXT);
  if (decl === null) throw new Error('[kind-coverage] 找不到 SLOT_SERVICE_WRITE_LEGS');
  return [...(decl[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1] as string);
}

/* ============================== 表二：Monaco 注册 API 全集（全树扫描） ============================== */

/** 注册 API 名 → 矩阵行；engine 面（非 `ui.editor.languageService` 的语言服务格）单独白名单并给理由 */
const REGISTRY_API_TO_ROW: Readonly<Record<string, string>> = {
  registerDefinitionProvider: 'definition',
  registerImplementationProvider: 'implementation',
  registerDocumentSymbolProvider: 'documentSymbol',
  registerFoldingRangeProvider: 'foldingRange',
  registerInlayHintsProvider: 'inlayHint',
  registerDocumentSemanticTokensProvider: 'semanticToken',
  registerSemanticTokensProvider: 'semanticToken',
  registerReferenceProvider: 'references',
  registerRenameProvider: 'rename',
  registerCodeLensProvider: 'codeLens',
  registerCodeActionProvider: 'codeAction',
  registerDocumentHighlightProvider: 'documentHighlight',
  registerSelectionRangeProvider: 'selectionRange',
  registerCompletionItemProvider: 'completion',
  registerHoverProvider: 'hover',
  registerDocumentFormattingEditProvider: 'formatting',
  registerDocumentRangeFormattingEditProvider: 'formatting',
  registerSignatureHelpProvider: 'signatureHelp',
  registerCallHierarchyProvider: 'callHierarchy',
};
/** 不是 languageService 格子的注册面：必须给"为什么不进矩阵"的理由（非空即在册） */
const ENGINE_API_EXEMPTIONS: Readonly<Record<string, string>> = {
  registerOnTypeFormattingEditProvider:
    'Monaco 引擎面（回车/键入即时缩进），SDK-B5b 车 6 定案 (a)：不进 SlotServiceKind、不造空供方',
  registerLinkProvider: '注释内文档链接面（ERB-PARITY G9），不是 ui.editor.languageService 的判别成员',
  registerInlineCompletionsProvider: '幽灵文本续写走专用槽 completion.source（契约头注：为什么两事不算一格）',
};

function scanRegisterApis(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of APP_ALL) {
    for (const m of file.text.matchAll(/\.register([A-Z][A-Za-z]*?Provider)\(/g)) {
      const api = `register${m[1]}`;
      found.set(api, [...(found.get(api) ?? []), file.rel]);
    }
  }
  return found;
}

/* ============================== 运行时：真实收口的挂载模拟 ============================== */

type FakeMonaco = typeof import('../src/monaco/entry');
interface MountRecorder {
  readonly calls: string[];
}
function mountFor(
  kind?: SlotServiceKind,
  options: { namedOnly?: boolean; excludeNamed?: SlotServiceKind } = {},
): readonly string[] {
  const rec: MountRecorder = { calls: [] };
  registerForLanguageServices(
    {} as unknown as FakeMonaco,
    (_m, languageId) => {
      rec.calls.push(languageId);
      return { dispose: () => undefined };
    },
    kind,
    options,
  );
  return rec.calls;
}

const LANGS = [ERB_LANGUAGE_ID, KOJO2_LANGUAGE_ID, KOJO_LANGUAGE_ID] as const;
type LangId = (typeof LANGS)[number];
const descriptorOf = (lang: LangId): LanguageDescriptor => {
  const d = descriptorForLanguageId(lang);
  if (d === null) throw new Error(`[kind-coverage] ${lang} 没有 descriptor`);
  return d;
};

/* ============================== 矩阵本体（数据；19 行 × 三门） ============================== */

type CellState = 'slot' | 'host' | 'gap' | 'na';
interface Cell {
  readonly state: CellState;
  /** 证据渠道：'monaco/xxx.ts' 里必须存在的标记串（`file::marker`）；装配调用写 `installer:<函数名>` */
  readonly channels?: readonly string[];
  /** 供方：包目录名 + 贡献 id（`slot` 与经槽应答的 `host` 格都要填） */
  readonly supply?: readonly (readonly [string, string])[];
  /** 非 `host`/`slot` 的理由，或刻意双挂/不收敛的留账注 */
  readonly note?: string;
  /** `gap` 格：欠账卡 id（`@debt-ledger BOARD:<id>`）与前置条件 */
  readonly debt?: { readonly card: string; readonly precondition: string };
}

const MATRIX: Readonly<Record<string, Readonly<Record<LangId, Cell>>>> = {
  definition: {
    [ERB_LANGUAGE_ID]: {
      state: 'host',
      channels: ['monaco/kojo-definition.ts::.registerDefinitionProvider(', "monaco/kojo-definition.ts::'definition'", 'installer:installDefinitionProvider'],
      supply: [['erb-parser', 'erb-definition']],
      note: 'DOUBLE-LEG-1032B：槽腿表无此腿 ⇒ 宿主腿不许让位（四类宿主事实留账）',
    },
    [KOJO2_LANGUAGE_ID]: {
      state: 'host',
      channels: ['monaco/kojo-definition.ts::.registerDefinitionProvider(', "monaco/kojo-definition.ts::'definition'", 'installer:installDefinitionProvider'],
      supply: [['kojo-lang', 'kojo2-definition']],
      note: 'kojo2 经 descriptor 点名挂上同一枚收口腿',
    },
    [KOJO_LANGUAGE_ID]: {
      state: 'host',
      channels: ['monaco/kojo-definition.ts::.registerDefinitionProvider(', 'installer:installDefinitionProvider'],
      supply: [['kojo-sugar', 'kojo-definition']],
    },
  },
  documentSymbol: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-symbols.ts::.registerDocumentSymbolProvider(', "monaco/kojo-symbols.ts::'documentSymbol'", 'installer:installDocumentSymbolProvider'], supply: [['erb-parser', 'erb-symbols']] },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-symbols.ts::.registerDocumentSymbolProvider(', "monaco/kojo-symbols.ts::'documentSymbol'"], supply: [['kojo-lang', 'kojo2-symbols']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-symbols.ts::.registerDocumentSymbolProvider(', 'installer:installDocumentSymbolProvider'], supply: [['kojo-sugar', 'kojo-symbols']] },
  },
  foldingRange: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-folding.ts::.registerFoldingRangeProvider(', "monaco/kojo-folding.ts::'foldingRange'"], supply: [['erb-parser', 'erb-folding']], note: '结构层对 ERB folds:false（折叠单源 R5）' },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-folding.ts::.registerFoldingRangeProvider(', "monaco/kojo-folding.ts::'foldingRange'"], supply: [['kojo-lang', 'kojo2-foldingRange']], note: 'B3h：宿主预取快照随请求下传，槽内同步裁答' },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-folding.ts::.registerFoldingRangeProvider('], supply: [['kojo-sugar', 'kojo-folding']] },
  },
  inlayHint: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-inlay-hints.ts::.registerInlayHintsProvider(', "monaco/kojo-inlay-hints.ts::'inlayHint'"], supply: [['erb-parser', 'erb-inlay-hints']] },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-inlay-hints.ts::.registerInlayHintsProvider(', "monaco/kojo-inlay-hints.ts::'inlayHint'"], supply: [['kojo-lang', 'kojo2-inlay']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-inlay-hints.ts::.registerInlayHintsProvider('], supply: [['kojo-sugar', 'kojo-inlay-hints']] },
  },
  semanticToken: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-semantic-tokens.ts::.registerDocumentSemanticTokensProvider(', "monaco/kojo-semantic-tokens.ts::'semanticToken'"], supply: [['erb-parser', 'erb-semantic-tokens']] },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-semantic-tokens.ts::.registerDocumentSemanticTokensProvider(', "monaco/kojo-semantic-tokens.ts::'semanticToken'"], supply: [['kojo-lang', 'kojo2-semanticTokens']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-semantic-tokens.ts::.registerDocumentSemanticTokensProvider('], supply: [['kojo-sugar', 'kojo-semantic-tokens']] },
  },
  implementation: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/erb-implementation.ts::.registerImplementationProvider(', "monaco/erb-implementation.ts::'implementation'", 'installer:installImplementationProvider'], supply: [['erb-parser', 'erb-definition']], note: 'ERB 的实现 = 定义位，同一条 provideErbDefinition 答两个 kind（G3）' },
    [KOJO2_LANGUAGE_ID]: { state: 'na', note: '能力矩阵明写 { exempt }：2.0 里跳实现与转定义同义（F12 已覆盖）；descriptor 不点名，不造空供方' },
    [KOJO_LANGUAGE_ID]: {
      state: 'gap',
      debt: {
        card: 'LAU-COVERAGE',
        precondition:
          '收口这一格的唯一合法路径＝kojo-sugar 补答 implementation 判别成员（产出同 definition，G3 口径"实现=定义位"归供方说），宿主不得替语言把 definition 腿借给实现（G3 删的正是那条捷径）；封存档若要整体退役，则随退役一并划账',
      },
      note: 'ERB-PARITY G3 把"实现复用定义腿"从宿主删掉后，.kojo1 的 Ctrl+F12 两腿皆无人答（槽腿表本无此腿、旧桥腿挂载但供方只认 .erb 族）——本波数出来的唯一真缺口',
    },
  },
  completion: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-parser', 'erb-completion']], note: 'ERB 刻意不点名（无消费者，languages.ts 头注）；经 languageServices 旧桥全腿挂载，宿主自装配那枚调用点已删 ⇒ 恰一枚' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-completion']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/completion-core.ts::.registerCompletionItemProvider(', 'installer:installKojoCompletion', 'monaco/kojo-completion.ts::installCompletion('], note: '装配核（ERB 册被子目借用）；槽腿同时挂上但零供方应答（集合型不顶单答）' },
  },
  hover: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-parser', 'erb-hover']], note: 'G1 点名 + 旧桥 excludeNamed 让位' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-hover']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ["monaco/kojo-hover.ts::.registerHoverProvider(", "monaco/kojo-hover.ts::excludeNamed: 'hover'", 'installer:installHover'], note: '六路中文名在旧桥腿内（editorTables 注入）' },
  },
  formatting: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-lang', 'erb-formatting']], note: 'G2 点名 + 旧桥整篇腿 excludeNamed；on-type 属引擎面（矩阵白名单）' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-formatting']], note: '一条能力两枚 provider（整篇+区间）同在 legOf(formatting)' },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-format.ts::.registerDocumentFormattingEditProvider(', "monaco/kojo-format.ts::excludeNamed: 'formatting'", 'monaco/kojo-format.ts::.registerDocumentRangeFormattingEditProvider(', 'installer:installDocumentFormatter'], note: '规则尺子 @kojo/kojo-vocab/formatter，宿主腿应答' },
  },
  signatureHelp: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-signature.ts::.registerSignatureHelpProvider(', 'installer:installSignatureHelp'], note: '槽腿表有 signatureHelp 腿并挂在旧桥上，但 ERB 供方缺席（-SIG 组留账：让位＝静默没有）' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-signatureHelp']], note: 'B3d 起走共享槽腿（descriptor 点名），判据住 @kojo/kojo-lang/signature' },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-signature.ts::.registerSignatureHelpProvider(', 'installer:installSignatureHelp'] },
  },
  references: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-parser', 'erb-references']], channels: ['monaco/find-references.ts::.registerReferenceProvider(', 'installer:installReferenceProvider'], note: 'LAU-DUALLEG 余格：闭文件点击通道在宿主腿上 ⇒ 刻意双挂在册' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-references']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/find-references.ts::.registerReferenceProvider(', 'installer:installReferenceProvider'], supply: [['kojo-sugar', 'kojo-references']] },
  },
  rename: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['monaco/erb-rename.ts::.registerRenameProvider(', 'installer:installErbRename'], supply: [['erb-parser', 'erb-rename']], note: 'DOUBLE-LEG-1032C：注册面两枚、应答面一枚（槽腿 prepare 只有 kojo2 尺子 + 闭文件回写通道在宿主腿）' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-rename']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-rename.ts::.registerRenameProvider(', 'installer:installKojoRename'], supply: [['kojo-sugar', 'kojo-rename']] },
  },
  documentHighlight: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-lang', 'erb-documentHighlight']], note: '1032 三格让位之一：宿主腿 undefined + excludeNamed' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-documentHighlight']] },
    [KOJO_LANGUAGE_ID]: { state: 'na', channels: ['monaco/erb-highlight.ts::excludeNamed: \'documentHighlight\'', 'monaco/erb-highlight.ts::id === ERB_LANGUAGE_ID'], note: '挂载面≠应答面（erb-highlight.ts 头注定案：糖投影行号属派生文本；封存层从未有过该应答面，能力矩阵不覆盖 kojo1）' },
  },
  selectionRange: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-lang', 'erb-selectionRange']] },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-selectionRange']] },
    [KOJO_LANGUAGE_ID]: { state: 'na', channels: ['monaco/erb-selection-range.ts::excludeNamed: \'selectionRange\'', 'monaco/erb-selection-range.ts::id === ERB_LANGUAGE_ID'], note: '同 documentHighlight：servesErb 闸明写"挂载面≠应答面"' },
  },
  codeLens: {
    [ERB_LANGUAGE_ID]: { state: 'slot', supply: [['erb-parser', 'erb-usage-lens']], note: '1032 三格让位之一' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-codeLens']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-code-lens.ts::.registerCodeLensProvider(', "monaco/kojo-code-lens.ts::excludeNamed: 'codeLens'", 'installer:installCodeLensProvider'], supply: [['kojo-sugar', 'kojo-code-lens']] },
  },
  workspaceSymbol: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['ui/workspace-symbols.ts::kind: \'workspaceSymbol\''], supply: [['erb-parser', 'erb-workspace-symbols']], note: '无 Monaco 注册面：检索面板直问槽（不是遗漏，工作区查询不钉缓冲区）' },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['ui/workspace-symbols.ts::kind: \'workspaceSymbol\''], supply: [['kojo-lang', 'kojo2-workspaceSymbols']] },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['ui/workspace-symbols.ts::kind: \'workspaceSymbol\''], supply: [['kojo-sugar', 'kojo-workspace-symbols']] },
  },
  renameTarget: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ["monaco/erb-rename.ts::kind: 'renameTarget'", 'installer:installErbRename'], supply: [['erb-parser', 'erb-renameTarget']], note: 'F2 第一步经宿主改名腿直问槽（无独立 Monaco 注册面）' },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['monaco/slot-service-providers.ts::kojo2PrepareRename(', 'monaco/slot-service-providers.ts::resolveRenameLocation('], note: '尺子在包叶 @kojo/kojo-lang/rename，槽腿直接调它——不经槽的 renameTarget 成员（kojo2 无该供方，点名=假装有）' },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['monaco/kojo-rename.ts::resolveRenameLocation(', 'monaco/kojo-rename.ts::unicodeTokenAt('], note: '宿主通用取词（词区间供输入框；能不能改在 rename 应答里给理由）' },
  },
  callHierarchy: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ["ui/CallHierarchyOverlay.tsx::collectCallHierarchy(", "ui/editor-global-providers.ts::'editor.revealLocation'"], supply: [['erb-parser', 'erb-call-hierarchy']], note: 'Monaco 0.57 无注册 API（PITFALLS §83）：消费面=宿主面板直问槽；erb-callhierarchy-provider 的注册 shim 在 0.57 上零注册' },
    [KOJO2_LANGUAGE_ID]: { state: 'host', channels: ['ui/CallHierarchyOverlay.tsx::KOJO2_LANGUAGE_ID'], note: 'kojo2 分支消费包模型 @kojo/kojo-lang/call-hierarchy（批次十），无注册位 ⇒ 矩阵留 exempt 是按**注册面**记账，应答面在此在册' },
    [KOJO_LANGUAGE_ID]: { state: 'na', channels: ['ui/CallHierarchyOverlay.tsx::没有供方应答'], note: '面板对 .kojo1 明说「调用层级这一轮没有供方应答」（可见不静默）；封存层未承诺该面，供方只认 .erb 族（行为面有钉）' },
  },
  // 专用槽腿（`ui.editor.codeAction`，不是 ui.editor.languageService 判别成员；随工厂表进矩阵）
  codeAction: {
    [ERB_LANGUAGE_ID]: { state: 'host', channels: ['ui/editor-global-providers.ts::registerCodeActionProvider(', 'ui/editor-global-providers.ts::provideCodeActionsFor('], note: 'v1 合并 provider 按 languageServices 铺（ERB/kojo1）' },
    [KOJO2_LANGUAGE_ID]: { state: 'slot', supply: [['kojo-lang', 'kojo2-codeActions']], note: '写面腿 namedOnly：只挂点名它的 kojo2（B5b 车 5）' },
    [KOJO_LANGUAGE_ID]: { state: 'host', channels: ['ui/editor-global-providers.ts::registerCodeActionProvider('] },
  },
};

/* ============================== 一、三张表钉全集 ============================== */

describe('LAU-COVERAGE 表一：全集从实树钉死（新增不进表 ⇒ 红）', () => {
  it('契约判别成员恰 18 枚、无重复，且矩阵逐枚有行', () => {
    const kinds = contractKinds();
    expect(kinds.length).toBe(18);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) {
      expect(MATRIX[kind], `契约成员 ${kind} 没进矩阵`).toBeDefined();
    }
    // 反向：矩阵里的行（除 codeAction）必须都是契约成员——退役成员不许留在表上
    for (const row of Object.keys(MATRIX)) {
      if (row === 'codeAction') continue;
      expect(kinds, `矩阵行 ${row} 不在契约联合里`).toContain(row);
    }
  });

  it('SlotServiceKind = 契约成员去掉三枚无注册面的 + codeAction；工厂表 10 枚、写面恰 codeAction', () => {
    const kinds = contractKinds();
    const slotKinds = slotServiceKinds();
    for (const k of slotKinds) {
      expect(k === 'codeAction' || kinds.includes(k), `SlotServiceKind 的 ${k} 既非契约成员也不是 codeAction`).toBe(true);
    }
    // 无 Monaco 注册面的三枚契约成员不许混进 SlotServiceKind（那不驱动挂载）
    for (const k of ['workspaceSymbol', 'renameTarget', 'callHierarchy']) {
      expect(slotKinds, `${k} 没有注册面，不该进 SlotServiceKind`).not.toContain(k);
    }
    const legs = factoryLegKinds();
    expect([...new Set(legs)].sort()).toEqual(
      ['codeAction', 'codeLens', 'completion', 'documentHighlight', 'formatting', 'hover', 'references', 'rename', 'selectionRange', 'signatureHelp'].sort(),
    );
    for (const leg of legs) expect(slotKinds, `腿 ${leg} 不在 SlotServiceKind`).toContain(leg);
    expect(writeLegKinds()).toEqual(['codeAction']);
  });

  it('Monaco 注册面全树扫描：每枚 register*Provider 要么进矩阵行、要么在引擎面白名单里（新注册面没进表 ⇒ 红）', () => {
    const apis = scanRegisterApis();
    for (const [api, files] of apis) {
      expect(
        REGISTRY_API_TO_ROW[api] ?? ENGINE_API_EXEMPTIONS[api],
        `注册面 ${api}（${files.join(', ')}）既没映射到矩阵行、也没有引擎面豁免与理由`,
      ).toBeTruthy();
    }
    // 在册的引擎面豁免必须真在树上（豁免表不许记账已消失的注册面）
    for (const api of Object.keys(ENGINE_API_EXEMPTIONS)) {
      expect(apis.has(api), `引擎面白名单里的 ${api} 已不在实树——豁免与理由该随批删除`).toBe(true);
    }
  });
});

/* ============================== 二、矩阵逐格判态 ============================== */

const LEG_KINDS = new Set(factoryLegKinds());
const langMounted = (lang: LangId, kind: string, namedOnly = false): boolean =>
  mountFor(kind as SlotServiceKind, { namedOnly }).includes(lang);

/** 渠道证据核验（所有带 channels 的格一律核——`slot` 格可空，`host`/`na` 必须交得出） */
function verifyChannels(where: string, channels: readonly string[] | undefined): void {
  for (const channel of channels ?? []) {
    if (channel.startsWith('installer:')) {
      const name = channel.slice('installer:'.length);
      const calls = GLOBAL_PROVIDERS_TEXT.split(`${name}(`).length - 1;
      expect(calls, `${where}：装配点没调 ${name}（写了没人挂=死代码）`).toBeGreaterThanOrEqual(1);
      continue;
    }
    const sep = channel.indexOf('::');
    expect(sep, `${where}：渠道串形状应为 file::marker → ${channel}`).toBeGreaterThan(0);
    const file = channel.slice(0, sep);
    const marker = channel.slice(sep + 2);
    expect(appRel(file), `${where}：渠道 ${file} 里没有「${marker}」`).toContain(marker);
  }
}

describe('LAU-COVERAGE 矩阵：每格每语言至少有人答 + 状态不许说谎', () => {
  it('形状：恰 3 列 × 19 行 = 57 格，每格状态合法（行新增列缺格 ⇒ 红）', () => {
    for (const [row, cells] of Object.entries(MATRIX)) {
      expect(Object.keys(cells).sort(), `行 ${row} 的列不齐`).toEqual([...LANGS].sort());
      for (const [lang, cell] of Object.entries(cells)) {
        expect(['slot', 'host', 'gap', 'na'], `${row}×${lang} 状态非法`).toContain(cell.state);
        if (cell.state === 'na' || cell.state === 'gap') {
          expect(((cell.note ?? '') + (cell.debt?.precondition ?? '')).length, `${row}×${lang} 的理由不许空`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('`slot` 格：工厂表有腿 + 真实收口**运行时**挂得上这门语言 + 包里有供方', () => {
    for (const [row, cells] of Object.entries(MATRIX)) {
      for (const [lang, cell] of Object.entries(cells)) {
        if (cell.state !== 'slot') continue;
        expect(LEG_KINDS.has(row), `slot 格 ${row}×${lang}：工厂表里没有这枚腿（表说谎）`).toBe(true);
        expect(
          langMounted(lang as LangId, row, row === 'codeAction'),
          `slot 格 ${row}×${lang}：descriptor 挂载名单里没有这门语言（点名/旧桥都不成立）`,
        ).toBe(true);
        expect(cell.supply?.length, `slot 格 ${row}×${lang} 没有供方`).toBeTruthy();
        for (const [pkg, id] of cell.supply ?? []) {
          expect(pluginSuppliesContribution(pkg, id), `供方 ${pkg}/${id} 不在册（${row}×${lang}）`).toBe(true);
        }
      }
    }
  });

  it('`host` 格：文件在树上、标记逐枚对得上、装配点真调了安装器（掉了 ⇒ 红）', () => {
    for (const [row, cells] of Object.entries(MATRIX)) {
      for (const [lang, cell] of Object.entries(cells)) {
        if (cell.state !== 'host') continue;
        expect(cell.channels?.length ?? 0, `${row}×${lang}：host 格必须交得出渠道证据`).toBeGreaterThan(0);
        verifyChannels(`${row}×${lang}`, cell.channels);
        for (const [pkg, id] of cell.supply ?? []) {
          expect(pluginSuppliesContribution(pkg, id), `${row}×${lang} 经槽应答的供方 ${pkg}/${id} 不在册`).toBe(true);
        }
      }
    }
  });

  it('`na` 格：不许点名、渠道闸仍要在册；能力矩阵豁免与台账成对（kojo2×implementation）', () => {
    for (const [row, cells] of Object.entries(MATRIX)) {
      for (const [lang, cell] of Object.entries(cells)) {
        if (cell.state !== 'na') continue;
        const descriptor = descriptorOf(lang as LangId);
        if (LEG_KINDS.has(row)) {
          expect(declaredSlotKinds(descriptor), `${row}×${lang}：记了不适用却在 descriptor 点名这条腿`).not.toContain(row);
        }
        verifyChannels(`${row}×${lang}`, cell.channels);
        if (row === 'implementation') {
          // kojo2 的这格必须与 LANGUAGE_CAPABILITY_MATRIX 的 { exempt } 成对（两处打架 ⇒ 红）
          const status = (LANGUAGE_CAPABILITY_MATRIX as Record<string, Record<string, unknown>>)[KOJO2_LANGUAGE_ID]?.[
            'implementation'
          ];
          expect(isLanguageCapabilityExemption(status as never), '矩阵不再是 { exempt }：na 判定过期').toBe(true);
        }
        if (row === 'callHierarchy') {
          expect(
            readAppRel('ui/CallHierarchyOverlay.tsx'),
            `callHierarchy×${lang}：面板那句"没有供方应答"的可见说明消失了（不适用不许变静默）`,
          ).toContain('没有供方应答');
        }
      }
    }
  });

  it('gap 格恰一格（implementation×kojo1）：不点名、无供方、挂卡在册——收口了就把格改成 host/slot 并划账', () => {
    // @debt-ledger BOARD:LAU-COVERAGE
    const gaps = Object.entries(MATRIX).flatMap(([row, cells]) =>
      Object.entries(cells)
        .filter(([, cell]) => cell.state === 'gap')
        .map(([lang]) => `${row}×${lang}`),
    );
    expect(gaps).toEqual([`implementation×${KOJO_LANGUAGE_ID}`]);
    const cell = (MATRIX.implementation as Record<LangId, Cell>)[KOJO_LANGUAGE_ID];
    expect(cell.debt).toBeDefined();
    const board = readFileSync(BOARD_FILE, 'utf8');
    expect(board, `看板欠账卡 ${cell.debt?.card} 不在——gap 不许脱离看板`).toContain(`|${cell.debt?.card}|`);
    // 不许用点名遮羞：kojo1 的 descriptor 一枚腿都不点名
    expect(declaredSlotKinds(descriptorOf(KOJO_LANGUAGE_ID))).toEqual([]);
    // 供方确实不存在：kojo-sugar 包里没有 implementation 判别成员
    const sugarSrc = collectSources(path.join(PLUGINS_ROOT, 'kojo-sugar', 'src'))
      .map((abs) => readFileSync(abs, 'utf8'))
      .join('\n');
    expect(sugarSrc.includes("'implementation'"), 'kojo-sugar 里冒出了 implementation 供方：本格该改判').toBe(false);
  });

  it('铁律·没有供方不许点名：每一门 descriptor 点名的腿，矩阵里那格必须是 slot 或有供方', () => {
    for (const lang of LANGS) {
      for (const kind of declaredSlotKinds(descriptorOf(lang))) {
        const cell = MATRIX[kind]?.[lang];
        expect(cell, `${kind}×${lang}：点名了但矩阵没有这格`).toBeDefined();
        if (cell === undefined) continue;
        expect(
          cell.state === 'slot' || (cell.supply?.length ?? 0) > 0,
          `${kind}×${lang}：点名了却没有供方应答（点名＝静默没有——本系列铁律）`,
        ).toBe(true);
      }
    }
  });

  it('零挂载：JSON / 口上 XML 这类数据格式面收口对它们一枚都不挂', () => {
    for (const kind of LEG_KINDS) {
      const mounted = mountFor(kind as SlotServiceKind);
      expect(mounted, `${kind} 的槽腿挂到了保留面上`).not.toContain(JSON_LANGUAGE_ID);
      expect(mounted).not.toContain(KOJO_XML_LANGUAGE_ID);
    }
  });
});

/* ============================== 三、挂载名单逐枚读数（行为面·真实收口） ============================== */

describe('LAU-COVERAGE 挂载模拟：谁被挂上是 descriptor 写下来的事实', () => {
  const erb = ERB_LANGUAGE_ID;
  const kojo1 = KOJO_LANGUAGE_ID;
  const kojo2 = KOJO2_LANGUAGE_ID;
  const ordered = (ids: readonly string[]): string[] => [...ids].sort();

  it('旧桥 kind 腿（definition/documentSymbol/foldingRange/inlayHint/semanticToken）三门全挂', () => {
    for (const kind of ['definition', 'documentSymbol', 'foldingRange', 'inlayHint', 'semanticToken'] as const) {
      expect(ordered(mountFor(kind)), `${kind} 挂载名单变了`).toEqual(ordered([erb, kojo1, kojo2]));
    }
  });

  it('implementation 只挂旧桥两门（kojo2 不点名 ⇒ 不挂）；无 kind 的桥只挂旧桥', () => {
    expect(ordered(mountFor('implementation'))).toEqual(ordered([erb, kojo1]));
    expect(ordered(mountFor(undefined))).toEqual(ordered([erb, kojo1]));
  });

  it('让位后的旧桥腿（excludeNamed）只剩 kojo1 一门；写面腿 namedOnly 只挂 kojo2', () => {
    for (const kind of ['hover', 'formatting', 'documentHighlight', 'selectionRange', 'codeLens'] as const) {
      expect(ordered(mountFor(undefined, { excludeNamed: kind })), `excludeNamed ${kind}`)
        .toEqual(ordered([kojo1]));
    }
    expect(ordered(mountFor('codeAction', { namedOnly: true }))).toEqual([kojo2]);
  });
});

/* ============================== 四、供方应答读数（行为面·真函数） ============================== */

describe('LAU-COVERAGE 行为面：供方对每门语言的应答/弃权拿到读数', () => {
  const erbText = ['@MAIN', '  #DIM 好感度', '  好感度 = 1', '  IF 好感度 >= 50', 'END'].join('\n');

  it('ERB：provideErbDefinition 对 .erb 的 implementation 请求作答（跳实现=定义位有真读数）', () => {
    const request = {
      kind: 'implementation',
      path: 'c:\\proj\\erb\\coverage.erb',
      text: erbText,
      line: 3,
      column: 3,
      project: null,
    } as unknown as EditorLanguageServiceRequest;
    const result = provideErbDefinition(request, null);
    expect(result, 'ERB 的 implementation 无人应答：矩阵该格掉成 gap').toBeDefined();
    expect(result?.kind).toBe('implementation');
    if (result?.kind === 'implementation') {
      expect(result.locations.some((l) => l.line === 2), `#DIM 声明腿没答上：${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('gap 的证据侧：同一条 implementation 请求打到 .kojo1 路径，ERB 供方弃权（undefined）', () => {
    const request = {
      kind: 'implementation',
      path: 'D:/p/legacy.kojo1',
      text: erbText,
      line: 3,
      column: 3,
      project: null,
    } as unknown as EditorLanguageServiceRequest;
    expect(provideErbDefinition(request, null)).toBeUndefined();
  });

  it('callHierarchy×kojo1 的不适用有据：erb 供方对 .kojo1 路径弃权（面板那句"没有供方应答"不是摆设）', () => {
    const request = {
      kind: 'callHierarchy',
      path: 'D:/p/legacy.kojo1',
      line: 3,
      project: null,
    } as unknown as EditorLanguageServiceRequest;
    expect(provideErbCallHierarchy(request, null)).toBeUndefined();
  });
});

/* ============================== 五、负例自证（表不是纸糊的） ============================== */

describe('LAU-COVERAGE 负例自证：新格子进不了静默', () => {
  it('凭空多一枚契约成员 ⇒ 与矩阵逐枚对拍当场抛（新格子没进表 = 红，不是静默）', () => {
    const fake = 'acmeCoverageKind';
    expect(MATRIX[fake], '假 kind 居然有矩阵行（判据坏了）').toBeUndefined();
    const matrixRows = Object.keys(MATRIX).filter((k) => k !== 'codeAction').sort();
    expect(() => {
      // 矩阵第一格的原文判据：成员逐枚有行 + 长度对拍——加一枚假 kind 后两条都会红
      expect(matrixRows).toEqual(expect.arrayContaining([...contractKinds(), fake].sort()));
      expect(contractKinds().length + 1).toBe(matrixRows.length);
    }).toThrowError();
    expect(slotServiceKinds(), 'SlotServiceKind 冒出新成员而本表不认').not.toContain(fake);
  });

  it('注册面扫描尺子对假 API 真会漏 ⇒ 尺子本身用真树自证非空且每枚有归属', () => {
    const apis = scanRegisterApis();
    expect(apis.size).toBeGreaterThan(10);
    const unmapped = [...apis.keys()].filter(
      (api) => REGISTRY_API_TO_ROW[api] === undefined && ENGINE_API_EXEMPTIONS[api] === undefined,
    );
    expect(unmapped, '这些注册面没进表').toEqual([]);
  });
});
