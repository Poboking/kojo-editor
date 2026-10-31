/**
 * 批次十 S16 · LANG-UX-MATRIX：两门一等语言的**体感验收矩阵**（机器可读）。
 *
 * ## 钉的是什么
 *
 * `monaco/language-capabilities.ts` 的 20 项能力矩阵回答"这面谁供的"；本文件回答另一问：
 * **作者实际能感到的面是否逐项存在、两门语言是否同权**。两者互补：
 * - 能力矩阵按注册面记账（`self` / `shared` / `builtin` / `{ exempt }`）；
 * - 体感矩阵按**上手能碰到的东西**记账（折叠 / 跳转 / 引用 / 重命名 / 补全 / 格式化 /
 *   诊断 / 预览 / 大纲 / 面包屑 / 展开 / peek / 调用层级 / 文档链接 / 用户片段），
 *   其中面包屑、快速修复预览、调用层级面板、文档链接、用户片段**不在**能力枚举里。
 *
 * ## 为什么读源码而不是起真 Monaco
 *
 * 与 `language-parity.test.ts` 同一路：`monaco/entry` 是浏览器包，node 池里起不来；
 * "某枚 provider 挂到哪个语言 id"也不在 Monaco 公开读数里。取证方式 = 读注册行 + 读装配点
 * （`ui/editor-global-providers.ts` 没 import 的模块 = 没人调 = 死代码）。
 *
 * ## 四条断言（对应任务书 1–4）
 *
 * 1. 声明的每项能力：`self`/`shared` 有注册行且被装配；`builtin` 有语言配置 / 内建数据腿的
 *    证据；`{ exempt }` 的理由**非空**（空理由 / 占位符 = 失败）；
 * 2. 15 个体感面逐项存在（源码探针 + 宿主面板注册）；
 * 3. 禁止"某 provider 只挂一门语言"的回归：扫描 `.languages.registerXxxProvider(<单语言常量>)`，
 *    另一门若在矩阵里**非豁免**就必须也有注册面；
 * 4. 导出 {@link LANGUAGE_UX_MATRIX} / {@link LANGUAGE_UX_SUMMARY}（纯 JSON 可序列化），
 *    供后续进 `docs/STATE.md`。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  ALL_LANGUAGE_CAPABILITIES,
  LANGUAGE_CAPABILITY_MATRIX,
  PARITY_LANGUAGE_IDS,
  isLanguageCapabilityExemption,
  LanguageCapability,
  type ParityLanguageId,
} from '../src/monaco/language-capabilities';
// descriptor 在 languages.ts 模块求值时登记（本文件要读 languageServices 声明）
import '../src/monaco/languages';
import { declaredSlotKinds, languageDescriptors, usesLegacyBridge } from '../src/monaco/language-registry';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';

/* ============================== 取证基建 ============================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../src');

interface SourceFile {
  /** 相对 `packages/app/src` 的 posix 路径（错误信息里直接可读） */
  readonly rel: string;
  readonly text: string;
}

/** 源码快照：一次走盘，后面的取证全在内存里做（本文件读几十次，不许每轮重走） */
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
  if (file === undefined) throw new Error(`[language-ux-matrix] 取证表里的路径不存在：${rel}`);
  return file;
}

/** 宿主全局 provider 的**唯一装配点** */
const GLOBAL_PROVIDERS = 'ui/editor-global-providers.ts';

/** 这份注册模块是否被宿主装配点 import（写了没人调 = 死代码，与"没写"等价） */
function importedByGlobal(rel: string): boolean {
  if (rel === GLOBAL_PROVIDERS) return true;
  const spec = `'../monaco/${rel.replace(/^monaco\//, '').replace(/\.tsx?$/, '')}'`;
  return sourceOf(GLOBAL_PROVIDERS).text.includes(spec);
}

/** 每项能力对应的 Monaco 注册 API（`diagnostics` / `brackets` / `preview` 走专项探针） */
const PROVIDER_API: Readonly<Partial<Record<LanguageCapability, string>>> = {
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

/** 注册调用里"本语言 id"的两种写法（常量 / 字面量） */
const LANGUAGE_SELECTOR: Readonly<Record<ParityLanguageId, RegExp>> = {
  [ERB_LANGUAGE_ID]: /\bERB_LANGUAGE_ID\b/,
  [KOJO2_LANGUAGE_ID]: /\bKOJO2_LANGUAGE_ID\b/,
};

/** 注册调用的取证窗口：语言 id 必在首个实参位置，700 字符足够覆盖多行排版 */
const CALL_WINDOW = 700;

/** `monaco.languages.api(...)` / `m.languages.api(...)` 的调用切片（selector 在首参附近） */
function providerCallSnippets(text: string, api: string): string[] {
  const pattern = new RegExp(`(?:monaco|m)\\s*\\.languages\\s*\\.${api}\\s*\\(`, 'g');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out.push(text.slice(match.index, match.index + CALL_WINDOW));
  }
  return out;
}

/** 源码里按 `self` 形状注册某 API、且指向某门语言的模块 */
function selfRegistrationFiles(api: string, languageId: ParityLanguageId): readonly string[] {
  const selector = LANGUAGE_SELECTOR[languageId];
  return SOURCE_FILES.filter((file) =>
    providerCallSnippets(file.text, api).some((snippet) => selector.test(snippet)),
  ).map((file) => file.rel);
}

/**
 * 源码里走 `registerForLanguageServices(monaco, (m, id) => m.languages.api(id, …))` 收口的模块。
 * 这是**宿主共享面**的唯一形状：同一枚 provider 挂到每一门声明 `languageServices: true` 的语言。
 */
function sharedRegistrationFiles(api: string): readonly string[] {
  const inline = new RegExp(
    `registerForLanguageServices\\([\\s\\S]{0,500}?\\.languages\\.${api}\\s*\\(`,
  );
  // SDK-B5b 车 1（2026-10-31）：补全 / 悬停并进槽腿表（`monaco/slot-service-providers.ts`），
  // API 写在表项里、收口只在安装器里调一次。两条判据仍要**同时**成立：
  // 文件里有收口调用 + 文件里有这条 API 的表项。
  const table = new RegExp(`legOf\\s*\\([\\s\\S]{0,300}?\\.languages\\.${api}\\s*\\(`);
  const collector = /registerForLanguageServices\(\s+monaco,[\s\S]{0,200}?leg\.register/;
  return SOURCE_FILES.filter(
    (file) => inline.test(file.text) || (collector.test(file.text) && table.test(file.text)),
  ).map((file) => file.rel);
}

/** 声明 `languageServices: true` 的语言 id（registerForLanguageServices 实际会挂到的那些） */
/**
 * 能力 → 允许它走「点名槽腿」的那一格（B2 起）。
 *
 * 背景：`shared` 档位原本只有一条通路（descriptor 声明 `languageServices: true`，11 枚
 * provider 全铺）。B2 之后多了第二条：descriptor 用 `slotServices` **点名**某几条腿
 * （kojo2 的大纲就是这样挂上的——它的其余能力归自己的插件，不能被 v1 语义的 provider 铺满）。
 * 两条通路**同一个收口**（`registerForLanguageServices`），所以档位仍是 `shared`；
 * 只是"能不能挂到这门语言"的判据从"全铺"变成"全铺 或 点名了这一格"。
 */
const SLOT_SERVICE_OF: Readonly<Partial<Record<LanguageCapability, string>>> = {
  [LanguageCapability.Outline]: 'documentSymbol',
  [LanguageCapability.Definition]: 'definition',
  [LanguageCapability.References]: 'references',
  [LanguageCapability.Folding]: 'foldingRange',
  [LanguageCapability.Inlay]: 'inlayHint',
  // B3c（2026-10-28）：补全 / 悬停的供方是插件，kojo2 由 `slotServices` 点名挂上。
  [LanguageCapability.Completion]: 'completion',
  [LanguageCapability.Hover]: 'hover',
  // B3d（2026-10-28）：签名 / 格式化同批 —— 供方是插件，kojo2 由 `slotServices` 点名挂上。
  [LanguageCapability.Signature]: 'signatureHelp',
  [LanguageCapability.Format]: 'formatting',
  // B3e（2026-10-29）：改名同批（引用那格上方早已登记）。
  [LanguageCapability.Rename]: 'rename',
  // B3f（2026-10-29）：同符号高亮 / 结构化扩选同批 —— 供方是插件，kojo2 由 `slotServices` 点名。
  [LanguageCapability.Highlight]: 'documentHighlight',
  [LanguageCapability.Selection]: 'selectionRange',
  // B3g（2026-10-30）：行上注解同批 —— 供方是插件（`kojo2-codeLens`），kojo2 由 `slotServices` 点名。
  [LanguageCapability.CodeLens]: 'codeLens',
  // B3 语义收口（2026-10-30）：结构化着色同批 —— 供方是插件（`kojo2-semanticTokens`），
  // 捕获快照由宿主预取，kojo2 由 `slotServices` 点名 `semanticToken` 挂上。
  [LanguageCapability.Semantic]: 'semanticToken',
};

/** 这门语言对**这一项能力**是否走得到共享收口 */
function sharedReachable(languageId: string, capability: LanguageCapability): boolean {
  const descriptor = languageDescriptors().find((entry) => entry.id === languageId);
  if (descriptor === undefined) return false;
  if (usesLegacyBridge(descriptor)) return true;
  const kind = SLOT_SERVICE_OF[capability];
  return kind !== undefined && declaredSlotKinds(descriptor).includes(kind as never);
}

/* ============================== 专项探针（没有统一注册 API 的面） ============================== */

interface SourceProbe {
  readonly rel: string;
  readonly re: RegExp;
}

/** 能力专项：补全 / 诊断的取证形状（档位对不上通用形状，逐项点名取证点） */
const SPECIAL_CAPABILITY_PROBES: Readonly<
  Partial<Record<LanguageCapability, Partial<Record<ParityLanguageId, readonly SourceProbe[]>>>>
> = {
  [LanguageCapability.Completion]: {
    [ERB_LANGUAGE_ID]: [
      // LAU-4 补全腿第三批（2026-10-31）：`.erb` 的注册面是**共享槽腿**那一枚（旧桥按
      // `languageServices: true` 铺；ERB 不点名 `completion`，理由见 `languages.ts` 那段判据）。
      // 下面两格钉"腿真在表里 + 装配点真装了工厂"；第三、四格钉的是**另一件事**：宿主那本
      // ERB 册仍然存在，但只作为 `.kojo1` 原生区的 `route` 目标被借用（自装配 provider 的
      // 调用点已删，反向取证在 `language-parity.test.ts`）。
      {
        rel: 'monaco/slot-service-providers.ts',
        re: /legOf\('completion',[\s\S]{0,200}?registerCompletionItemProvider/,
      },
      {
        rel: 'ui/editor-global-providers.ts',
        re: /installSlotServiceProviders\(\s*monaco,\s*slotServiceHost/,
      },
      { rel: 'monaco/erb-completion.ts', re: /installCompletion\(monaco,\s*ERB_COMPLETION_ASSEMBLY/ },
      { rel: 'monaco/erb-completion.ts', re: /languageId:\s*ERB_LANGUAGE_ID/ },
    ],
  },
  [LanguageCapability.Diagnostics]: {
    [ERB_LANGUAGE_ID]: [
      // v1 的波浪线 = `ui.editor.decorator` 槽 → setModelMarkers（语言无关上屏腿）
      { rel: 'ui/EditorPane.tsx', re: /query\('ui\.editor\.decorator'\)/ },
      { rel: 'ui/EditorPane.tsx', re: /setModelMarkers\(model,\s*MARKER_OWNER/ },
    ],
    [KOJO2_LANGUAGE_ID]: [
      { rel: 'ui/kojo2-problem-sync.ts', re: /KOJO2_PROBLEM_MARKER_OWNER/ },
      { rel: 'ui/kojo2-problem-sync.ts', re: /setModelMarkers\(/ },
      { rel: 'ui/editor-pane/use-monaco-instance.ts', re: /installKojo2ProblemWiring\(\{/ },
    ],
  },
};

/** `builtin` 档的证据：语言配置自带（缩进 / 括对）或 Monaco 内建窗的数据腿（peek 预览） */
const BUILTIN_PROBES: Readonly<
  Partial<Record<LanguageCapability, Partial<Record<ParityLanguageId, readonly SourceProbe[]>>>>
> = {
  [LanguageCapability.Indent]: {
    [ERB_LANGUAGE_ID]: [
      { rel: 'monaco/erb-language.ts', re: /\bonEnterRules\s*:/ },
      { rel: 'monaco/erb-language.ts', re: /\bindentationRules\s*:/ },
    ],
  },
  [LanguageCapability.Brackets]: {
    [ERB_LANGUAGE_ID]: [
      { rel: 'monaco/erb-language.ts', re: /setLanguageConfiguration\(ERB_LANGUAGE_ID/ },
      { rel: 'monaco/erb-language.ts', re: /\bbrackets\s*:/ },
      { rel: 'monaco/erb-language.ts', re: /\bautoClosingPairs\s*:/ },
      { rel: 'monaco/erb-language.ts', re: /\bERB_BRACKET_PAIRS\b/ },
    ],
    [KOJO2_LANGUAGE_ID]: [
      // B4：2.0 的成对记号正文在语言面库（本文件的走图器只跟 `packages/app/src`，读不到包外），
      // 所以"这一门有注册面"的证据是宿主那两条腿：**落地腿**（唯一把供方数据接进
      // `setLanguageConfiguration` 的模块）+ **指针**（成对表在宿主只有这一个出口名）。
      { rel: 'monaco/monaco-language-surface.ts', re: /setLanguageConfiguration\(\s*languageId/ },
      { rel: 'monaco/monaco-language-surface.ts', re: /\bdata\.brackets\b/ },
      { rel: 'monaco/monaco-language-surface.ts', re: /\bdata\.autoClosingPairs\b/ },
      { rel: 'monaco/kojo2-language.ts', re: /\bKOJO2_PAIRS\b/ },
    ],
  },
  [LanguageCapability.Preview]: {
    // Alt+F12 的 Peek 是 Monaco 内建窗，数据腿 = definition / references 的返回
    [ERB_LANGUAGE_ID]: [
      { rel: 'monaco/kojo-definition.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerDefinitionProvider/ },
      { rel: 'monaco/find-references.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerReferenceProvider/ },
    ],
    [KOJO2_LANGUAGE_ID]: [
      // B3b：2.0 的转定义归插件，宿主侧零 `registerDefinitionProvider(… KOJO2_LANGUAGE_ID)`。
      // 取证点改成"共享收口带能力名 + descriptor 点名"这两处声明。
      { rel: 'monaco/kojo-definition.ts', re: /'definition',\s*\)/ },
      { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'definition'/ },
      // B3e：引用同样归插件（原探针指那枚原生 2.0 provider，现已不存在）。
      { rel: 'monaco/slot-service-providers.ts', re: /legOf\('references',[\s\S]{0,200}?registerReferenceProvider/ },
      { rel: 'monaco/slot-service-providers.ts', re: /legOf\('references',/ },
      { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'references'/ },
    ],
  },
};

/** 逐项校验一串探针；返回人话问题（空数组 = 全过） */
function probeProblems(probes: readonly SourceProbe[], owner: string): string[] {
  const problems: string[] = [];
  for (const probe of probes) {
    const file = SOURCE_FILES.find((entry) => entry.rel === probe.rel);
    if (file === undefined) {
      problems.push(`${owner}：取证文件不存在 ${probe.rel}`);
      continue;
    }
    if (!probe.re.test(file.text)) {
      problems.push(`${owner}：${probe.rel} 里没有找到 ${probe.re}`);
    }
  }
  return problems;
}

/* ============================== 断言 1：声明能力 ↔ 注册面 / 豁免 ============================== */

/**
 * 逐项核对能力矩阵：
 * - 豁免 ⇒ 理由非空且不是占位符；
 * - `self` ⇒ 有 `registerXxxProvider(… 本语言 id …)` 的注册行，且模块被装配点 import；
 * - `shared` ⇒ 本语言 descriptor 必须声明 `languageServices: true`，且收口函数真的挂了这枚 API；
 * - `builtin` ⇒ 语言配置 / 内建数据腿有证据。
 */
function capabilityProblems(): string[] {
  const problems: string[] = [];

  for (const languageId of PARITY_LANGUAGE_IDS) {
    const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
    for (const capability of ALL_LANGUAGE_CAPABILITIES) {
      const owner = `${languageId}/${capability}`;
      const status = row[capability];

      if (isLanguageCapabilityExemption(status)) {
        const reason = status.exempt.trim();
        if (reason.length === 0) {
          problems.push(`${owner}：豁免理由为空（空理由 = 失败）`);
        } else if (/^(todo|tbd|fixme|待定|待补|未填|-+)$/i.test(reason)) {
          problems.push(`${owner}：豁免理由只是占位符「${reason}」`);
        }
        continue;
      }

      const special = SPECIAL_CAPABILITY_PROBES[capability]?.[languageId];
      if (special !== undefined) {
        problems.push(...probeProblems(special, owner));
        continue;
      }

      const builtin = BUILTIN_PROBES[capability]?.[languageId];
      if (builtin !== undefined) {
        problems.push(...probeProblems(builtin, owner));
        continue;
      }

      const api = PROVIDER_API[capability];
      if (api === undefined) {
        problems.push(`${owner}：状态「${status}」既无注册 API 也无专项取证`);
        continue;
      }

      if (status === 'self') {
        const files = selfRegistrationFiles(api, languageId);
        if (files.length === 0) {
          problems.push(`${owner}：标 self，但源码里没有 ${api}(… 本语言 id …) 的注册行`);
        }
        for (const rel of files) {
          if (!importedByGlobal(rel)) {
            problems.push(`${owner}：${rel} 有注册行，但 ${GLOBAL_PROVIDERS} 没 import 它`);
          }
        }
      } else if (status === 'shared') {
        if (!sharedReachable(languageId, capability)) {
          problems.push(
            `${owner}：标 shared，但 descriptor 既没声明 languageServices: true、也没在 slotServices 里点名这一格（共享收口挂不到它）`,
          );
        }
        const files = sharedRegistrationFiles(api);
        if (files.length === 0) {
          problems.push(`${owner}：标 shared，但没有 registerForLanguageServices(… ${api}(…) 的收口行`);
        }
        for (const rel of files) {
          if (!importedByGlobal(rel)) {
            problems.push(`${owner}：${rel} 走共享收口，但 ${GLOBAL_PROVIDERS} 没 import 它`);
          }
        }
      } else {
        problems.push(`${owner}：未知能力档位「${String(status)}」`);
      }
    }
  }
  return problems;
}

describe('断言 1：声明的每项能力要么有注册面，要么有非空豁免理由', () => {
  it('能力矩阵逐项对得上注册行 / 语言配置 / 非空豁免理由', () => {
    expect(capabilityProblems()).toEqual([]);
  });

  it('descriptor 的 capabilities 声明 = 矩阵里非豁免的那一份（声明不是"想要"）', () => {
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const descriptor = languageDescriptors().find((entry) => entry.id === languageId);
      expect(descriptor, `${languageId} 没有 descriptor`).toBeDefined();
      const declared = descriptor?.capabilities;
      expect(declared, `${languageId} 没声明 capabilities`).toBeDefined();
      const delivered = ALL_LANGUAGE_CAPABILITIES.filter(
        (capability) =>
          !isLanguageCapabilityExemption(LANGUAGE_CAPABILITY_MATRIX[languageId][capability]),
      );
      expect([...(declared ?? [])].sort(), `${languageId} 的声明面与矩阵打架`).toEqual(
        [...delivered].sort(),
      );
    }
  });

  it('两门语言都有豁免项，且理由点名了下一步（不是空话）', () => {
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const exemptions = ALL_LANGUAGE_CAPABILITIES.filter((capability) =>
        isLanguageCapabilityExemption(LANGUAGE_CAPABILITY_MATRIX[languageId][capability]),
      );
      expect(exemptions.length, `${languageId} 没有记录任何已知缺口`).toBeGreaterThan(0);
      for (const capability of exemptions) {
        const status = LANGUAGE_CAPABILITY_MATRIX[languageId][capability];
        if (!isLanguageCapabilityExemption(status)) continue;
        const reason = status.exempt;
        expect(reason.trim().length, `${languageId}/${capability} 理由太短`).toBeGreaterThan(8);
        expect(reason, `${languageId}/${capability} 没点名接什么`).toMatch(
          /monaco\/[a-z0-9-]+\.ts|无对应模块|PITFALLS/i,
        );
      }
    }
  });
});

/* ============================== 体感矩阵（导出常量） ============================== */

/** 任务书逐字写死的 15 个体感面（顺序即报告顺序） */
export type UxSurface =
  | 'folding'
  | 'jump'
  | 'refs'
  | 'rename'
  | 'completion'
  | 'format'
  | 'diagnostics'
  | 'preview'
  | 'outline'
  | 'breadcrumb'
  | 'expand'
  | 'peek'
  | 'callhierarchy'
  | 'documentLinks'
  | 'userSnippets';

/** 一面在某门语言上的形态（`exempt` 必须带理由） */
export type UxSurfaceState = 'registered' | 'builtin' | 'host' | 'exempt';

/** 一行体感面（纯 JSON 可序列化：无函数 / 无 RegExp） */
export interface LanguageUxMatrixRow {
  readonly surface: UxSurface;
  readonly label: string;
  readonly erb: UxSurfaceState;
  readonly kojo2: UxSurfaceState;
  /** 注册面 / 宿主面板的人读来源 */
  readonly evidence: string;
  /** 是否已接进宿主装配点（false = 模块已交付但还没人调） */
  readonly assembled: boolean;
  /** 豁免理由，或"已交付未接线"的说明（空 = 失败） */
  readonly note?: string;
}

/**
 * 体感验收矩阵：**15 面 × 两门语言**。
 *
 * `callhierarchy` 两门都是 `exempt`：Monaco 0.57 无 `registerCallHierarchyProvider`，
 * 宿主面板 `ui/CallHierarchyOverlay.tsx` 已按 model 语言分派消费（面板就是这一面）。
 *
 * `documentLinks` / `userSnippets` 是**模块已交付、装配点尚未接线**（批次十另两条线）：
 * `assembled: false` + note 明说，不假装"作者已经能看到"。
 */
export const LANGUAGE_UX_MATRIX: readonly LanguageUxMatrixRow[] = Object.freeze(
  (
    [
      {
        surface: 'folding',
        label: '折叠',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/kojo-folding.ts（共享收口，含 kojo2）+ monaco/kojo2-folding.ts（预取缓存）',
        assembled: true,
      },
      {
        surface: 'jump',
        label: '跳转',
        erb: 'registered',
        kojo2: 'registered',
        evidence:
          'monaco/kojo-definition.ts（共享收口）+ monaco/slot-service-providers.ts（悬停槽腿）；ERB 另有 erb-implementation.ts',
        assembled: true,
      },
      {
        surface: 'refs',
        label: '引用',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/find-references.ts（共享收口）+ monaco/slot-service-providers.ts（槽腿表）',
        assembled: true,
      },
      {
        surface: 'rename',
        label: '重命名',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/erb-rename.ts + monaco/slot-service-providers.ts（槽腿表）',
        assembled: true,
      },
      {
        surface: 'completion',
        label: '补全',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/erb-completion.ts（装配核）+ monaco/slot-service-providers.ts（槽腿表 + 插件供方）',
        assembled: true,
      },
      {
        surface: 'format',
        label: '格式化',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/kojo-format.ts（共享收口）+ monaco/slot-service-providers.ts（formatting 槽腿）',
        assembled: true,
      },
      {
        surface: 'diagnostics',
        label: '诊断',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'ui/EditorPane.tsx（decorator 上屏腿）+ ui/kojo2-problem-sync.ts',
        assembled: true,
      },
      {
        surface: 'preview',
        label: '预览',
        erb: 'host',
        kojo2: 'host',
        evidence: 'ui/quick-fix-preview.ts + ui/QuickFixPreviewOverlay.tsx + ui/shell-overlays.ts',
        assembled: true,
      },
      {
        surface: 'outline',
        label: '大纲',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/kojo-symbols.ts（共享收口 + 插件供方；B5b 起宿主不再有 kojo2-symbols.ts）',
        assembled: true,
      },
      {
        surface: 'breadcrumb',
        label: '面包屑',
        erb: 'host',
        kojo2: 'host',
        evidence: 'ui/breadcrumb-path.ts + ui/editor-pane/use-breadcrumb.ts + ui/EditorPane.tsx',
        assembled: true,
      },
      {
        surface: 'expand',
        label: '展开',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/erb-selection-range.ts + monaco/slot-service-providers.ts（槽腿表）',
        assembled: true,
      },
      {
        surface: 'peek',
        label: 'peek',
        erb: 'builtin',
        kojo2: 'builtin',
        evidence:
          'Monaco 内建 Alt+F12；数据腿 = definition / references（ui/editor-global-providers.ts 的 openModelFor / pathForUri / peekTarget + ui/peek-leases.ts）',
        assembled: true,
      },
      {
        surface: 'callhierarchy',
        label: '调用层级',
        erb: 'exempt',
        kojo2: 'exempt',
        evidence: 'ui/CallHierarchyOverlay.tsx（按 model 语言分派）+ @kojo/plugin-erb-parser（槽 callHierarchy 供方）+ @kojo/kojo-lang/call-hierarchy（kojo2 判据，SDK-B5b 车 C 起住语言面库）',
        assembled: true,
        note:
          'Monaco 0.57 无 registerCallHierarchyProvider（PITFALLS §83）；两门语言都由宿主面板按 model 语言分派消费（批次十）；ERB 的判据自 LAU-4 调用层级腿起住插件供方',
      },
      {
        surface: 'documentLinks',
        label: '文档链接',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'monaco/document-links.ts（registerLinkProvider 按 descriptor 的 lineComment 派生注册面）',
        assembled: true,
        note:
          '装配点在 ui/editor-global-providers.ts：宿主只给只读存在性探测（kernel.io.exists）+ 项目根，点击复用 kojo.codeLens.execute（批次十 S18）',
      },
      {
        surface: 'userSnippets',
        label: '用户片段',
        erb: 'registered',
        kojo2: 'registered',
        evidence: 'ui/user-snippets.ts（两语言分组）+ monaco/user-snippet-completion.ts',
        assembled: true,
        note:
          '装配点在 ui/editor-global-providers.ts；分组键 erb → Monaco 语言 id kojo-erb 由 languageIdFor 映射（批次十 S18）',
      },
    ] as LanguageUxMatrixRow[]
  ).map((row) => Object.freeze(row)),
);

/** 机器可读摘要（后续进 `docs/STATE.md` 的数字口径） */
export interface LanguageUxMatrixSummary {
  readonly surfaces: number;
  readonly assembled: number;
  readonly perLanguage: Readonly<
    Record<ParityLanguageId, Readonly<Record<UxSurfaceState, number>>>
  >;
}

function countStates(side: 'erb' | 'kojo2'): Readonly<Record<UxSurfaceState, number>> {
  const counts: Record<UxSurfaceState, number> = {
    registered: 0,
    builtin: 0,
    host: 0,
    exempt: 0,
  };
  for (const row of LANGUAGE_UX_MATRIX) counts[row[side]] += 1;
  return Object.freeze(counts);
}

export const LANGUAGE_UX_SUMMARY: LanguageUxMatrixSummary = Object.freeze({
  surfaces: LANGUAGE_UX_MATRIX.length,
  assembled: LANGUAGE_UX_MATRIX.filter((row) => row.assembled).length,
  perLanguage: Object.freeze({
    [ERB_LANGUAGE_ID]: countStates('erb'),
    [KOJO2_LANGUAGE_ID]: countStates('kojo2'),
  }),
});

/* ============================== 断言 2：体感面逐项存在 ============================== */

/** 每面在源码里的**存在证据**（模块 + 关键注册行；不依赖测试运行期起 Monaco） */
const SURFACE_SOURCES: Readonly<Record<UxSurface, readonly SourceProbe[]>> = {
  folding: [
    { rel: 'monaco/kojo-folding.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerFoldingRangeProvider/ },
    { rel: 'monaco/kojo-folding.ts', re: /'foldingRange'\s*\)/ },
    // B3h（2026-10-30）：2.0 的折叠不再自建 provider —— 共享收口带能力名 `foldingRange`，
    // descriptor 用 `slotServices` 点名挂上，应答来自插件（worker 事实由宿主预取进缓存，
    // 随请求的 `folds` 递下去）。取证点随之变成三处：能力名、descriptor 点名、预取器装配。
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'foldingRange'/ },
    { rel: 'monaco/kojo2-folding.ts', re: /export function installKojo2FoldsCache\(/ },
  ],
  jump: [
    { rel: 'monaco/kojo-definition.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerDefinitionProvider/ },
    // B3b（2026-10-24）：2.0 的转定义不再由那枚补全 / 悬停安装器自建 provider —— 它改走
    // 同一枚槽腿（`kojo-definition.ts`），由 descriptor 的 `slotServices` 点名挂上，
    // 应答来自插件 `@kojo/plugin-kojo-lang`。取证点随之从"那枚原生 provider"变成
    // "两处声明"：能力名进 `registerForLanguageServices`、语言进 descriptor。
    { rel: 'monaco/kojo-definition.ts', re: /'definition',\s*\)/ },
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'definition'/ },
    { rel: 'monaco/erb-implementation.ts', re: /registerImplementationProvider/ },
  ],
  refs: [
    { rel: 'monaco/find-references.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerReferenceProvider/ },
    // B3e（2026-10-29）：2.0 的引用不再自建 provider——共享收口带能力名 `references`，
    // descriptor 用 `slotServices` 点名挂上，应答来自插件（形状同 B3b/B3c/B3d）。
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('references',[\s\S]{0,200}?registerReferenceProvider/ },
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('references',/ },
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'references'/ },
  ],
  rename: [
    { rel: 'monaco/erb-rename.ts', re: /registerRenameProvider\(\s*ERB_LANGUAGE_ID/ },
    // B3e（2026-10-29）：2.0 改名同批走共享收口（能力名 `rename`）。
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('rename',[\s\S]{0,200}?registerRenameProvider/ },
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('rename',/ },
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'rename'/ },
  ],
  completion: [
    { rel: 'monaco/erb-completion.ts', re: /installCompletion\(monaco,\s*ERB_COMPLETION_ASSEMBLY/ },
    { rel: 'monaco/erb-completion.ts', re: /languageId:\s*ERB_LANGUAGE_ID/ },
    // B3c（2026-10-28）：2.0 的补全不再由 `kojo2-providers.ts` 自建 provider —— 它改走共享
    // 收口（能力名 `completion`），由 descriptor 的 `slotServices` 点名挂上，应答来自插件
    // `@kojo/plugin-kojo-lang`。取证点随之从"那条原生注册行"变成"两处声明"。
    // SDK-B5b 车 1（2026-10-31）：两条腿并进语言无关的槽腿表 ⇒ 取证点换成
    // `slot-service-providers.ts` 的 `legOf('completion', …)` 表项。
    {
      rel: 'monaco/slot-service-providers.ts',
      re: /legOf\('completion',[\s\S]{0,200}?registerCompletionItemProvider/,
    },
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('completion',/ },
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'completion'/ },
  ],
  format: [
    { rel: 'monaco/kojo-format.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerDocumentFormattingEditProvider/ },
    // B3d（2026-10-28）：2.0 的格式化改走共享收口（能力名 `formatting`），由 descriptor 的
    // `slotServices` 点名挂上，应答来自插件 `@kojo/plugin-kojo-lang`。
    // SDK-B5b 车 2（2026-10-31）：整篇 + 区间两枚 provider **同属一条槽腿**，取证点落在
    // `slot-service-providers.ts` 的 `legOf('formatting', …)` 表项（登记闭包里两枚 API 各一次）。
    {
      rel: 'monaco/slot-service-providers.ts',
      re: /legOf\('formatting',[\s\S]{0,400}?registerDocumentFormattingEditProvider/,
    },
    { rel: 'monaco/slot-service-providers.ts', re: /'formatting',/ },
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'formatting'/ },
  ],
  diagnostics: [
    { rel: 'ui/EditorPane.tsx', re: /query\('ui\.editor\.decorator'\)/ },
    { rel: 'ui/EditorPane.tsx', re: /setModelMarkers\(model,\s*MARKER_OWNER/ },
    { rel: 'ui/kojo2-problem-sync.ts', re: /KOJO2_PROBLEM_MARKER_OWNER/ },
    { rel: 'ui/editor-pane/use-monaco-instance.ts', re: /installKojo2ProblemWiring\(\{/ },
  ],
  preview: [
    { rel: 'ui/quick-fix-preview.ts', re: /QUICK_FIX_PREVIEW_OVERLAY_ID/ },
    { rel: 'ui/quick-fix-preview.ts', re: /export function pushPreview\(/ },
    { rel: 'ui/QuickFixPreviewOverlay.tsx', re: /export function createQuickFixPreviewOverlay\(/ },
    { rel: 'ui/shell-overlays.ts', re: /QUICK_FIX_PREVIEW_OVERLAY_ID/ },
  ],
  outline: [
    { rel: 'monaco/kojo-symbols.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerDocumentSymbolProvider/ },
    // B2（2026-10-24）：2.0 的大纲不再由 `kojo2-symbols.ts` 自建 provider —— 它改走
    // 同一枚槽腿（`kojo-symbols.ts`），由 descriptor 的 `slotServices` 点名挂上，
    // 应答来自插件 `@kojo/plugin-kojo-lang`。取证点随之从"那枚原生 provider"变成
    // "两处声明"：能力名进 `registerForLanguageServices`、语言进 descriptor。
    { rel: 'monaco/kojo-symbols.ts', re: /'documentSymbol',\s*\)/ },
    // 判据是"这个数组里含 `documentSymbol`"，**不是**整条数组逐字相等：B2c 加了
    // `'inlayHint'` 之后，钉死整条只会让"多接管一条腿"这件事变成红——而多接管正是本方案
    // 的方向。真该红的是"把 documentSymbol 从这个数组里拿掉"。
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'documentSymbol'/ },
  ],
  breadcrumb: [
    { rel: 'ui/breadcrumb-path.ts', re: /export function crumbLevelsAt\(/ },
    { rel: 'ui/editor-pane/use-breadcrumb.ts', re: /export function useBreadcrumb\(/ },
    { rel: 'ui/EditorPane.tsx', re: /useBreadcrumb/ },
    { rel: 'ui/EditorPane.tsx', re: /<CrumbBar/ },
  ],
  expand: [
    // LAU-4（2026-10-30）：ERB 的扩选不再自建 provider —— 判据搬进
    // `@kojo/erb-lang/selection-range`，共享收口带能力名 `selectionRange`，
    // 应答来自插件 `@kojo/plugin-erb-lang`（ERB 由 `languageServices: true` 收进来）。
    { rel: 'monaco/erb-selection-range.ts', re: /registerForLanguageServices\([\s\S]{0,500}?registerSelectionRangeProvider/ },
    { rel: 'monaco/erb-selection-range.ts', re: /'selectionRange',\s*\)/ },
    // B3f（2026-10-29）：2.0 的扩选不再自建 provider——共享收口带能力名 `selectionRange`，
    // descriptor 用 `slotServices` 点名挂上，应答来自插件（形状同 B3b/B3c/B3d/B3e）。
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('selectionRange',[\s\S]{0,200}?registerSelectionRangeProvider/ },
    { rel: 'monaco/slot-service-providers.ts', re: /legOf\('selectionRange',/ },
    { rel: 'monaco/languages.ts', re: /slotServices:\s*\[[^\]]*'selectionRange'/ },
  ],
  peek: [
    { rel: 'ui/editor-global-providers.ts', re: /openModelFor:\s*modelForPeekPath/ },
    { rel: 'ui/editor-global-providers.ts', re: /pathForUri:\s*pathForPeekUri/ },
    { rel: 'ui/editor-global-providers.ts', re: /peekTarget:/ },
    { rel: 'ui/editor-global-providers.ts', re: /createPeekLeases/ },
  ],
  callhierarchy: [
    // LAU-4 调用层级腿：判据住插件供方（宿主只剩面板渲染与形状翻译）
    { rel: 'plugins/erb-parser/src/symbols.ts', re: /export function incomingCalls\(/ },
    // SDK-B5b 车 C（2026-10-31）：kojo2 调用层级的判据整块搬进语言面库，宿主
    // `monaco/kojo2-callhierarchy.ts` 已删 ⇒ 取证点改指包内落点（同一枚 `create…Provider`；
    // 路径相对 `packages/`，与上面 erb-parser 那条同口径）。
    { rel: 'kojo-lang/src/call-hierarchy.ts', re: /export function createKojo2CallHierarchyProvider\(/ },
    { rel: 'ui/CallHierarchyOverlay.tsx', re: /KOJO2_LANGUAGE_ID/ },
    { rel: 'ui/CallHierarchyOverlay.tsx', re: /loadKojo2CallHierarchyPanel/ },
    { rel: 'ui/shell-overlays.ts', re: /createCallHierarchyOverlay/ },
  ],
  documentLinks: [
    { rel: 'monaco/document-links.ts', re: /export function installDocumentLinks\(/ },
    // ERB-PARITY G9：注册面从 descriptor 派生（每一门声明了 `lineComment` 的语言都在册），
    // 不再是一枚手写语言 id 数组。
    {
      rel: 'monaco/document-links.ts',
      re: /registerLinkProvider\(lineCommentLanguageIds\(\), provider\)/,
    },
    { rel: 'monaco/language-registry.ts', re: /export function lineCommentLanguageIds\(/ },
  ],
  userSnippets: [
    { rel: 'ui/user-snippets.ts', re: /USER_SNIPPET_LANGUAGES\s*=\s*\['erb',\s*'kojo2'\]/ },
    { rel: 'ui/user-snippets.ts', re: /export function snippetsForLanguage\(/ },
    { rel: 'monaco/user-snippet-completion.ts', re: /export function createUserSnippetProvider\(/ },
    { rel: 'monaco/user-snippet-completion.ts', re: /registerCompletionItemProvider\(languageId/ },
  ],
};

/** 体感面 → 能力矩阵项（有映射的才能复用能力校验的注册面取证） */
const SURFACE_CAPABILITY: Readonly<Partial<Record<UxSurface, LanguageCapability>>> = {
  folding: LanguageCapability.Folding,
  jump: LanguageCapability.Definition,
  refs: LanguageCapability.References,
  rename: LanguageCapability.Rename,
  completion: LanguageCapability.Completion,
  format: LanguageCapability.Format,
  diagnostics: LanguageCapability.Diagnostics,
  outline: LanguageCapability.Outline,
  expand: LanguageCapability.Selection,
  peek: LanguageCapability.Definition,
  callhierarchy: LanguageCapability.CallHierarchy,
};

/** 装配点实测：该面是否真的接进了宿主（声明值必须与它逐项相等） */
const ASSEMBLY_PROBES: Readonly<Record<UxSurface, readonly SourceProbe[]>> = {
  folding: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/kojo-folding'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/kojo2-folding'/ },
  ],
  jump: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/kojo-definition'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/slot-service-providers'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/erb-implementation'/ },
  ],
  refs: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/find-references'/ },
    // SDK-B5b 车 3（2026-10-31）：2.0 引用归槽腿工厂（同一枚安装器里装配）
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/slot-service-providers'/ },
  ],
  rename: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/erb-rename'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/slot-service-providers'/ },
  ],
  completion: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/erb-completion'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/slot-service-providers'/ },
  ],
  format: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/kojo-format'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/slot-service-providers'/ },
  ],
  diagnostics: [
    { rel: 'ui/EditorPane.tsx', re: /query\('ui\.editor\.decorator'\)/ },
    { rel: 'ui/editor-pane/use-monaco-instance.ts', re: /installKojo2ProblemWiring\(\{/ },
  ],
  preview: [{ rel: 'ui/shell-overlays.ts', re: /QUICK_FIX_PREVIEW_OVERLAY_ID/ }],
  outline: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/kojo-symbols'/ },
    // B2：`kojo2-symbols` 不再被装配层 import —— 2.0 大纲改走上面那一枚槽腿。
    // 取证点取"装配层确实装了槽腿"（`installDocumentSymbolProvider`），
    // 而不是取"没 import 某文件"（负向断言在源码扫描里太脆，一改注释就假红）。
    { rel: GLOBAL_PROVIDERS, re: /installDocumentSymbolProvider\(monaco, \{/ },
  ],
  breadcrumb: [
    { rel: 'ui/EditorPane.tsx', re: /useBreadcrumb/ },
    { rel: 'ui/EditorPane.tsx', re: /<CrumbBar/ },
  ],
  expand: [
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/erb-selection-range'/ },
    { rel: GLOBAL_PROVIDERS, re: /'\.\.\/monaco\/slot-service-providers'/ },
  ],
  peek: [
    { rel: GLOBAL_PROVIDERS, re: /openModelFor:\s*modelForPeekPath/ },
    { rel: GLOBAL_PROVIDERS, re: /pathForUri:\s*pathForPeekUri/ },
    { rel: GLOBAL_PROVIDERS, re: /peekTarget:/ },
  ],
  callhierarchy: [
    { rel: 'ui/shell-overlays.ts', re: /createCallHierarchyOverlay/ },
    { rel: 'ui/CallHierarchyOverlay.tsx', re: /KOJO2_LANGUAGE_ID/ },
  ],
  documentLinks: [{ rel: GLOBAL_PROVIDERS, re: /installDocumentLinks/ }],
  userSnippets: [{ rel: GLOBAL_PROVIDERS, re: /user-snippet-completion|createUserSnippetProvider/ }],
};

/** 这面是否已接进宿主装配点（所有探针都命中 = 是） */
function assemblyMeasured(surface: UxSurface): boolean {
  return probeProblems(ASSEMBLY_PROBES[surface], surface).length === 0;
}

/** 逐行核对体感矩阵（存在性 + 同权 + 装配声明真实性） */
function surfaceProblems(): string[] {
  const problems: string[] = [];
  const allowed: readonly UxSurfaceState[] = ['registered', 'builtin', 'host', 'exempt'];

  for (const row of LANGUAGE_UX_MATRIX) {
    const owner = row.surface;

    if (!allowed.includes(row.erb) || !allowed.includes(row.kojo2)) {
      problems.push(`${owner}：状态不在 ${allowed.join(' / ')} 里`);
    }
    if (row.erb === 'exempt' || row.kojo2 === 'exempt') {
      if ((row.note ?? '').trim().length === 0) problems.push(`${owner}：豁免理由为空`);
    }
    if (!row.assembled && (row.note ?? '').trim().length === 0) {
      problems.push(`${owner}：未接线却没写说明（不许静默）`);
    }

    // 存在证据：除豁免面外，每面都要在源码里找到注册行 / 宿主面板
    if (row.erb !== 'exempt' || row.kojo2 !== 'exempt') {
      problems.push(...probeProblems(SURFACE_SOURCES[owner], owner));
    }

    // 同权：有映射的能力项复用能力校验（含 builtin 的数据腿）
    const capability = SURFACE_CAPABILITY[owner];
    if (capability !== undefined) {
      for (const languageId of PARITY_LANGUAGE_IDS) {
        const state = languageId === ERB_LANGUAGE_ID ? row.erb : row.kojo2;
        const status = LANGUAGE_CAPABILITY_MATRIX[languageId][capability];
        if (state === 'exempt') {
          if (!isLanguageCapabilityExemption(status)) {
            problems.push(
              `${owner}/${languageId}：体感矩阵标豁免，能力矩阵却是已交付（两表打架）`,
            );
          }
          continue;
        }
        if (isLanguageCapabilityExemption(status)) {
          problems.push(`${owner}/${languageId}：能力矩阵标豁免，体感矩阵却声称已交付（两表打架）`);
        }
      }
    }

    // 装配声明必须与源码实测一致（false 就是 false，不许把未接线写成已接线）
    if (row.assembled !== assemblyMeasured(owner)) {
      problems.push(
        `${owner}：矩阵声明 assembled=${row.assembled}，源码实测 ${assemblyMeasured(owner)}`,
      );
    }
  }
  return problems;
}

describe('断言 2：15 个体感面逐项存在，两门语言同权', () => {
  it('体感矩阵逐行通过存在性 / 同权 / 装配声明核对', () => {
    expect(surfaceProblems()).toEqual([]);
  });

  it('矩阵恰是任务书那 15 面，顺序一致，每行冻结', () => {
    const expected: readonly UxSurface[] = [
      'folding',
      'jump',
      'refs',
      'rename',
      'completion',
      'format',
      'diagnostics',
      'preview',
      'outline',
      'breadcrumb',
      'expand',
      'peek',
      'callhierarchy',
      'documentLinks',
      'userSnippets',
    ];
    expect(LANGUAGE_UX_MATRIX.map((row) => row.surface)).toEqual(expected);
    for (const row of LANGUAGE_UX_MATRIX) {
      expect(Object.isFrozen(row), row.surface).toBe(true);
      expect(row.label.trim().length, row.surface).toBeGreaterThan(0);
      expect(row.evidence.trim().length, row.surface).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(LANGUAGE_UX_MATRIX)).toBe(true);
  });

  it('"预览"是宿主快速修复预览，"peek"是 Monaco 内建窗：不许造第二套预览 provider', () => {
    const fake = SOURCE_FILES.filter((file) => /register(?:Preview|Peek)\w*Provider/.test(file.text));
    expect(fake.map((file) => file.rel)).toEqual([]);
    // 两门语言的 peek 数据腿（definition / references）都在
    expect(SURFACE_SOURCES.peek.length).toBeGreaterThan(0);
  });

  it('文档链接 / 用户片段：注册面覆盖**每一门**声明了该面的语言（不是只挂一门）', () => {
    const links = sourceOf('monaco/document-links.ts').text;
    // ERB-PARITY G9：注册面 = descriptor 的 `lineComment` 格派生（`.erb` / `.kojo1` / `.kojo`），
    // 判据不再按扩展名/语言 id 各写一份。
    expect(links).toMatch(/registerLinkProvider\(lineCommentLanguageIds\(\), provider\)/);
    expect(links).not.toMatch(/KOJO2_SOURCE_EXTENSION/);

    const snippets = sourceOf('ui/user-snippets.ts').text;
    expect(snippets).toMatch(/USER_SNIPPET_LANGUAGES\s*=\s*\['erb',\s*'kojo2'\]/);
    // provider 按**声明列表**逐语言注册（不是只挂一门）
    expect(sourceOf('monaco/user-snippet-completion.ts').text).toMatch(
      /for \(const languageId of languages\)/,
    );
  });
});

/* ============================== 断言 3：禁止"只挂一门语言" ============================== */

/** 从 API 名反查能力项（能力矩阵里没有的 API 不参与本条断言） */
const API_TO_CAPABILITY: Readonly<Record<string, LanguageCapability>> = (() => {
  const out: Record<string, LanguageCapability> = {};
  for (const capability of ALL_LANGUAGE_CAPABILITIES) {
    const api = PROVIDER_API[capability];
    if (api !== undefined) out[api] = capability;
  }
  return out;
})();

/** 扫描所有 `.languages.registerXxxProvider(<单语言常量>` 的调用，归成 api → 语言集合 */
function singleLanguageRegistrations(): ReadonlyMap<string, ReadonlySet<ParityLanguageId>> {
  const found = new Map<string, Set<ParityLanguageId>>();
  const pattern =
    /\.languages\.(register\w+Provider)\s*\(\s*(ERB_LANGUAGE_ID|KOJO2_LANGUAGE_ID)\b/g;
  for (const file of SOURCE_FILES) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.text)) !== null) {
      const api = match[1] as string;
      const languageId = match[2] as ParityLanguageId;
      const set = found.get(api) ?? new Set<ParityLanguageId>();
      set.add(languageId);
      found.set(api, set);
    }
  }
  return found;
}

/** 某门语言在某项能力上是否真的有注册面（self / shared / 专项 / builtin 都算） */
function hasRegistrationSurface(
  capability: LanguageCapability,
  languageId: ParityLanguageId,
): boolean {
  const special = SPECIAL_CAPABILITY_PROBES[capability]?.[languageId];
  if (special !== undefined) return probeProblems(special, 'probe').length === 0;
  const builtin = BUILTIN_PROBES[capability]?.[languageId];
  if (builtin !== undefined) return probeProblems(builtin, 'probe').length === 0;
  const api = PROVIDER_API[capability];
  if (api === undefined) return false;
  const status = LANGUAGE_CAPABILITY_MATRIX[languageId][capability];
  if (isLanguageCapabilityExemption(status)) return true; // 豁免项不要求注册面
  if (status === 'shared') {
    return sharedReachable(languageId, capability) && sharedRegistrationFiles(api).length > 0;
  }
  return selfRegistrationFiles(api, languageId).length > 0;
}

describe('断言 3：不许"某 provider 只挂一门语言"（两语言同权，豁免除外）', () => {
  it('扫描器确实命中了真实的单语言注册行（防空转）', () => {
    const apis = [...singleLanguageRegistrations().keys()];
    // 这几枚都有一侧是"单语言注册"的真实写法；一条都没扫到说明正则坏了，后面的断言就是空转
    for (const api of ['registerRenameProvider']) {
      expect(apis, `扫描器漏了 ${api} 的单语言注册行`).toContain(api);
    }
    // B5b（2026-10-30）：行内提示的单语言注册行**归零**——宿主那枚自建安装器
    // （`monaco/kojo2-inlay.ts`，B2c 之后已零生产调用）整块删除，两侧都只经共享收口挂上。
    // 反向钉住收口仍在，否则上面"另一门也有注册面"那一格会空转。
    expect(apis).not.toContain('registerInlayHintsProvider');
    expect(sharedRegistrationFiles('registerInlayHintsProvider')).toContain(
      'monaco/kojo-inlay-hints.ts',
    );
    // B3c（2026-10-28）：两门一等语言的补全都**不再**有单语言注册行——2.0 那条改走共享收口
    // （能力名 `completion` + descriptor 点名），ERB 那条经装配核注入语言 id。这里反向钉住
    // "扫描器确实看不见它"，同时正向钉住收口仍在（缺一条就会让下面"另一门也有注册面"空转）。
    expect(apis).not.toContain('registerCompletionItemProvider');
    expect(sharedRegistrationFiles('registerCompletionItemProvider')).toContain(
      'monaco/slot-service-providers.ts',
    );
    // LAU-4（2026-10-30）：同符号高亮 / 结构化扩选两侧**都**改走共享收口（ERB 由
    // `languageServices: true`、kojo2 由 `slotServices` 收进来）⇒ 单语言注册行两侧都归零。
    // 反向钉住两条收口仍在，否则上面"另一门也有注册面"那组会空转。
    expect(apis).not.toContain('registerDocumentHighlightProvider');
    expect(apis).not.toContain('registerSelectionRangeProvider');
    expect(sharedRegistrationFiles('registerDocumentHighlightProvider')).toEqual(
      expect.arrayContaining(['monaco/erb-highlight.ts', 'monaco/slot-service-providers.ts']),
    );
    expect(sharedRegistrationFiles('registerSelectionRangeProvider')).toEqual(
      expect.arrayContaining(['monaco/erb-selection-range.ts', 'monaco/slot-service-providers.ts']),
    );
    // B3g（2026-10-30）：行上注解同理——2.0 那条改走共享收口（能力名 `codeLens` + descriptor
    // 点名），v1 方言那条本来就在收口里（`kojo-code-lens.ts`）。两门都不再有单语言注册行，
    // 反向钉住"看不见它"，正向钉住两处收口都还在（kojo2 这枚是本批新写的）。
    expect(apis).not.toContain('registerCodeLensProvider');
    const codeLensShared = sharedRegistrationFiles('registerCodeLensProvider');
    expect(codeLensShared).toContain('monaco/slot-service-providers.ts');
    expect(codeLensShared).toContain('monaco/kojo-code-lens.ts');
  });

  it('单语言注册行的另一门：非豁免就必须也有注册面', () => {
    const problems: string[] = [];
    for (const [api, languages] of singleLanguageRegistrations()) {
      const capability = API_TO_CAPABILITY[api];
      if (capability === undefined) continue;
      for (const languageId of PARITY_LANGUAGE_IDS) {
        if (languages.has(languageId)) continue;
        const status = LANGUAGE_CAPABILITY_MATRIX[languageId][capability];
        if (isLanguageCapabilityExemption(status)) continue; // 已记账的豁免
        if (!hasRegistrationSurface(capability, languageId)) {
          problems.push(
            `${api} 只挂了 ${[...languages].join(' / ')}，${languageId}/${capability} 在矩阵里非豁免却没有注册面`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('矩阵里两门都非豁免的能力：两侧都有注册面（逐项对拍）', () => {
    const problems: string[] = [];
    for (const capability of ALL_LANGUAGE_CAPABILITIES) {
      const statuses = PARITY_LANGUAGE_IDS.map(
        (languageId) => LANGUAGE_CAPABILITY_MATRIX[languageId][capability],
      );
      if (statuses.some((status) => isLanguageCapabilityExemption(status))) continue;
      for (const languageId of PARITY_LANGUAGE_IDS) {
        if (!hasRegistrationSurface(capability, languageId)) {
          problems.push(
            `${languageId}/${capability}：两门都声明已交付，但这一门找不到注册面（只挂了一门）`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('共享收口只按 descriptor 声明挑语言，不写死语言 id', () => {
    const dialects = sourceOf('monaco/register-dialects.ts').text;
    // SDK-DIALECT（2026-10-31）：旧桥判据收进语言表的 `usesLegacyBridge`（两个名字同效），
    // 口径不变——挑语言仍只按 descriptor 字段，不认语言 id。
    expect(dialects).toMatch(/usesLegacyBridge\(descriptor\)|descriptor\.languageServices === true/);
    for (const constant of ['ERB_LANGUAGE_ID', 'KOJO_LANGUAGE_ID', 'KOJO2_LANGUAGE_ID']) {
      expect(dialects, `register-dialects.ts 不该出现 ${constant}`).not.toContain(constant);
    }
  });
});

/* ============================== 断言 4：机器可读矩阵 ============================== */

describe('断言 4：导出常量是纯 JSON（后续可直接进 STATE）', () => {
  it('JSON 往返不丢信息，摘要数字与矩阵一致', () => {
    const roundTrip = JSON.parse(JSON.stringify(LANGUAGE_UX_MATRIX)) as unknown;
    expect(roundTrip).toEqual(LANGUAGE_UX_MATRIX);

    expect(LANGUAGE_UX_SUMMARY.surfaces).toBe(15);
    expect(LANGUAGE_UX_SUMMARY.surfaces).toBe(LANGUAGE_UX_MATRIX.length);
    expect(LANGUAGE_UX_SUMMARY.assembled).toBe(
      LANGUAGE_UX_MATRIX.filter((row) => row.assembled).length,
    );
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const side = languageId === ERB_LANGUAGE_ID ? 'erb' : 'kojo2';
      const counts = LANGUAGE_UX_SUMMARY.perLanguage[languageId];
      const total = counts.registered + counts.builtin + counts.host + counts.exempt;
      expect(total, languageId).toBe(LANGUAGE_UX_MATRIX.length);
      expect(counts.registered, languageId).toBe(
        LANGUAGE_UX_MATRIX.filter((row) => row[side] === 'registered').length,
      );
      expect(counts.exempt, languageId).toBe(
        LANGUAGE_UX_MATRIX.filter((row) => row[side] === 'exempt').length,
      );
    }
    expect(Object.isFrozen(LANGUAGE_UX_SUMMARY)).toBe(true);
  });
});
