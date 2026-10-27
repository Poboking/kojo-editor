/**
 * **导出面清单**闸（SDK B5a）：多一个 / 少一个导出都必须显式改这里。
 *
 * ## 为什么单独立一条（而不是"能 import 到就算数"）
 *
 * SDK 的导出面就是**作者契约**。多一个内部类型 = 有人开始依赖它 = 以后删它要破人；
 * 少一个 = 作者被迫 `import` 实现包（那正是本包要消除的事）。两者都不是"顺手"能接受的
 * 变化，所以钉成清单：改导出面 ⇒ 改这份清单 ⇒ 在 diff 里被看见。
 *
 * ## 两条腿（缺一条就是假绿）
 *
 * 1. **类型面**（`contracts` / `structure-protocol` 的类型块）：运行时不可见，故按源码
 *    解析 `export type { … } from` 的标识符（先剥块注释——本仓的契约文件里满行是理由，
 *    不剥会把注释里的词当成导出）；
 * 2. **值面**（`semantic-roles` / `structure-protocol` 的常量）：真 `import` 后取
 *    `Object.keys`——型面清单可能漂、值面不会。
 *
 * 桶（`src/index.ts`）再自证一遍：它的运行时键必须**恰好**等于两个值叶子之并集
 * （`contracts` 是纯类型叶子，运行时零键）。这条防"桶里多 re-export 了一枚没人知道的模块"。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as barrel from '../src/index.js';
import * as roles from '../src/semantic-roles.js';

const src = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');

/** 剥掉块注释后，抽出所有 `export [type] { … } from` 的标识符（顺序保持，便于分组阅读） */
function exportedNames(file: string, kind: 'type' | 'value'): string[] {
  const text = src(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = kind === 'type' ? /export\s+type\s*\{([^}]*)\}/g : /export\s*\{([^}]*)\}/g;
  const names: string[] = [];
  for (const match of text.matchAll(pattern)) {
    for (const piece of (match[1] ?? '').split(',')) {
      const name = piece.trim();
      if (name !== '') names.push(name);
    }
  }
  return names.sort();
}

/* ============================== 1. 类型面 ============================== */

/** `contracts.ts` 的导出面（游戏侧 core + 编辑器侧 plugin-api；**只有类型**） */
const CONTRACT_TYPES = [
  'AdapterPresentation',
  'AdapterProfile',
  'AttributeSymbol',
  'Capability',
  'CarrierBinding',
  'ColorMode',
  'ColorPresentation',
  'ConformanceCase',
  'ConformanceKind',
  'ConformanceSuite',
  'DiagnosticNamespacePolicy',
  'DialectBinding',
  'DialectCarrier',
  'DialectFactKind',
  'DialectId',
  'DialogueColorPolicy',
  'DomainSymbols',
  'DomainVariableSymbol',
  'EditorCompletionItem',
  'EditorCompletionItemKind',
  'EditorCompletionRequest',
  'EditorCompletionResult',
  'EditorFormattingRequest',
  'EditorFormattingResult',
  'EditorHoverRequest',
  'EditorHoverResult',
  'EditorInlayHint',
  'EditorInlayHintKind',
  'EditorInlayHintRequest',
  'EditorInlayHintResult',
  'EditorLanguageServiceRequest',
  'EditorLanguageServiceResult',
  'EditorRangeEdit',
  'EditorSemanticTokenModifier',
  'EditorSemanticTokenRequest',
  'EditorSemanticTokenResult',
  'EditorSemanticTokenSpan',
  'EditorSemanticTokenType',
  'EditorSignatureHelpRequest',
  'EditorSignatureHelpResult',
  'EditorSymbolLocation',
  'EditorTextEdit',
  'EncodingPolicy',
  'EolPolicy',
  'EventArgumentSpec',
  'EventCatalog',
  'EventDispatchModel',
  'EventGuard',
  'EventPriorityModel',
  'EventSpec',
  'ExtensionFeature',
  'FaceCall',
  'FaceObject',
  'FacePresentation',
  'FaceTemplateNames',
  'FileAccessScope',
  'FingerprintEntry',
  'FingerprintKind',
  'GameAdapter',
  'GameFingerprint',
  'HeartMode',
  'HeartPresentation',
  'KojoDiagnostic',
  'KojoEmitBackend',
  'KojoLoweringProfile',
  'LayerMode',
  'LayerPolicy',
  'LayerRule',
  'LayerTarget',
  'MonacoAutoClosingPair',
  'MonacoComponentPaletteSide',
  'MonacoIndentAction',
  'MonacoIndentationRules',
  'MonacoLanguageConfigurationData',
  'MonacoLanguageContribution',
  'MonacoLanguageSurface',
  'MonacoMonarchAction',
  'MonacoMonarchData',
  'MonacoMonarchPattern',
  'MonacoMonarchRule',
  'MonacoMonarchWordLists',
  'MonacoOnEnterAction',
  'MonacoOnEnterRule',
  'MonacoSurroundingPair',
  'MonacoThemeBase',
  'MonacoThemeContributionData',
  'MonacoTokenThemeRuleData',
  'NameFunctionSymbol',
  'NarrationColorPolicy',
  'OptionsPresentation',
  'PersonRole',
  'PoolStyle',
  'PresentationFeature',
  'ProgramFeatureKey',
  'ProgramFeatures',
  'PronounSymbol',
  'RandStyle',
  'SourceMapPolicy',
  'SpeakerSource',
  'StorageClassSpec',
  'StorageClasses',
  'StorageInit',
  'StoragePeriod',
  'TextEncoding',
  'WaitDefault',
] as const;

/** `structure-protocol.ts` 的类型面（协议 v4 的形状） */
const STRUCTURE_TYPES = [
  'StructureCaptureTable',
  'StructureContent',
  'StructureEdit',
  'StructureFacet',
  'StructureFailureReason',
  'StructureFailureReply',
  'StructureFoldTable',
  'StructureIndentRules',
  'StructureOpenRequest',
  'StructureParseReply',
  'StructureParseRequest',
  'StructurePoint',
  'StructureRange',
  'StructureReadyReply',
  'StructureReply',
  'StructureRequest',
  'StructureSyntaxFault',
  'StructureSyntaxKind',
] as const;

/** `structure-protocol.ts` 的值面（版本号与随之钉死的常量） */
const STRUCTURE_VALUES = [
  'STRUCTURE_BOOTSTRAP_TIMEOUT_MS',
  'STRUCTURE_DEAD_AFTER_FAILURES',
  'STRUCTURE_FACETS',
  'STRUCTURE_FAILURE_REASONS',
  'STRUCTURE_MAX_CAPTURES',
  'STRUCTURE_PROTOCOL_VERSION',
  'STRUCTURE_TIMEOUT_MS',
] as const;

describe('@kojo/kojo-sdk 导出面', () => {
  it('contracts.ts 的类型面 = 清单（105 枚；多/少一枚都红）', () => {
    expect(exportedNames('contracts.ts', 'type')).toEqual([...CONTRACT_TYPES]);
  });

  it('structure-protocol.ts 的类型面 = 清单（18 枚）', () => {
    expect(exportedNames('structure-protocol.ts', 'type')).toEqual([...STRUCTURE_TYPES]);
  });

  it('structure-protocol.ts 的值面 = 清单（7 枚；含协议版本号）', () => {
    expect(exportedNames('structure-protocol.ts', 'value')).toEqual([...STRUCTURE_VALUES]);
    for (const name of STRUCTURE_VALUES) expect(barrel).toHaveProperty(name);
  });

  it('semantic-roles 的运行时导出 = 清单（12 枚；角色表 + 三张构造器 + 两枚断言）', () => {
    expect(Object.keys(roles).sort()).toEqual([
      'KOJO2_TOKEN',
      'LEGACY_ROLE_ALIASES',
      'NAME_LAYER_RULES',
      'ROLE',
      'ROLE_FONT_STYLES',
      'SEMANTIC_ROLES',
      'assertRolePalette',
      'isSemanticRole',
      'nameLayerRules',
      'roleForLegacyToken',
      'roleRule',
      'rulesFromRolePalette',
    ]);
  });

  it('桶的运行时键 = 两个值叶子之并集（contracts 是纯类型叶子，运行时零键）', () => {
    const expected = new Set<string>([...STRUCTURE_VALUES, ...Object.keys(roles)]);
    expect(Object.keys(barrel).sort()).toEqual([...expected].sort());
  });

  it('角色表就是 LAU-2 的那 34 档（搬动不改形状）', () => {
    expect(roles.SEMANTIC_ROLES).toHaveLength(34);
    expect(roles.ROLE.anchor).toBe('role.anchor');
    // 旧 token 名 → 角色的别名表：M3 的法定落点，键数不许无声变化
    expect(Object.keys(roles.LEGACY_ROLE_ALIASES)).toHaveLength(47);
  });
});
