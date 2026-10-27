import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { defineMonacoThemes } from '../src/monaco/theme';
// B4：三套 `kojo2-*` 的声明在语言面库，**定义**走宿主落点（供方 = `@kojo/plugin-kojo-lang`）。
// 本文件因此按"供方交出的东西落到 Monaco 之后长什么样"来量，而不是量宿主内部的一张表。
import {
  KOJO2_THEMES,
  KOJO2_THEME_IDS,
  KOJO2_THEME_TOKEN_MAP,
} from '@kojo/kojo-lang/monaco-theme';
import { KOJO2_MONACO_LANGUAGE_SURFACE } from '@kojo/plugin-kojo-lang';
import {
  applyAllMonacoLanguageThemes,
  registerMonacoLanguageSurfaceSource,
} from '../src/monaco/monaco-language-surface';
import { KOJO2_TOKEN } from '../src/monaco/kojo2-language';
import {
  KOJO_SEMANTIC_THEME_RULES,
  ROLE_LIGHT_THEME_RULES,
  ROLE_MINT_THEME_RULES,
  ROLE_THEME_RULES,
  SEMANTIC_ROLE_PALETTE_DARK,
  SEMANTIC_ROLE_PALETTE_LIGHT,
  SEMANTIC_ROLE_PALETTE_MINT,
} from '@kojo/kojo-lang/theme-rules';
import {
  LEGACY_ROLE_ALIASES,
  NAME_LAYER_RULES,
  ROLE,
  SEMANTIC_ROLES,
  assertRolePalette,
  isSemanticRole,
  roleForLegacyToken,
  type SemanticRole,
} from '@kojo/kojo-lang/semantic-roles';
import snapshot from './fixtures/legacy-token-colors.json';

/**
 * LAU-2 **角色表验收闸**。钉四件事：
 *
 * ① **覆盖度**：三侧现役 token 名（ERB / kojo1 / kojo2 各自的词法档，见下两张清单）
 *    一个不漏地进别名表；别名表的值全部是 `SEMANTIC_ROLES` 成员，且每个角色都真有人用
 *    （没有"登记了永远不发的角色"= 假档）。
 * ② **零改色**（本批硬约束的可执行形态）：拿改前那份**色值快照**
 *    （`fixtures/legacy-token-colors.json`，LAU-2 之前从真装配里 dump 出来的六套主题 × 48 条
 *    规则 + 三套 `kojo2-*`）逐套主题、逐档旧 token 名还原：`旧名 → 角色 → 主题色`，
 *    前景值与字重都必须**逐字相等**。这条是"只做命名重构"的唯一硬证据——别名表在，
 *    旧名就还能取回它原来那枚色。
 * ③ **角色表的形状**：每套主题每个角色**有且只有一条**规则（重复 = Monaco 后者覆盖前者，
 *    静默漂色）；三张角色调色板的键集恰好等于 `SEMANTIC_ROLES`；角色名唯一且带 `role.` 前缀。
 * ④ **名字层不混进来**（D6）：那五条 legend 规则仍在，且键不与任何角色撞名。
 *
 * 为什么 34 档而不是设计稿 §4.2 的 18 档：见 `semantic-roles.ts` 头注（18 档定稿色卡要人工
 * 评审；本批不许改色，故取"六套主题上色值与字重全同"的等价类下界）。
 */

/* ============================== 装配：六套 v1 + 三套 kojo2 ============================== */

interface CapturedTheme {
  readonly rules: Monaco.editor.ITokenThemeRule[];
  readonly colors: Record<string, string>;
}

/**
 * 供方登记表：把插件交出的那一枚语言面接给宿主落点（同 `ensureGlobalProviders` 的接线，
 * 只是这里的数据源是**测试内联**的同一枚对象，不经 kernel 槽）。
 */
registerMonacoLanguageSurfaceSource(() => [
  { id: 'test:kojo2-monaco-language', surface: KOJO2_MONACO_LANGUAGE_SURFACE },
]);

function captureThemes(): Map<string, CapturedTheme> {
  const store = new Map<string, string>([['kojo.ui.kojo2Cutover.v1', 'on']]);
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
  const themes = new Map<string, CapturedTheme>();
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: CapturedTheme): void => {
        themes.set(id, theme);
      },
    },
    languages: {},
  } as unknown as typeof Monaco;
  defineMonacoThemes(monaco);
  // `kojo2-*` 三套由宿主落点定义（`defineMonacoThemes` 尾段那一条是动态 import，
  // 等不到 ⇒ 这里同步补同一件事：把供方声明落成 `defineTheme` 调用）。
  applyAllMonacoLanguageThemes(monaco);
  vi.unstubAllGlobals();
  return themes;
}

const THEMES = captureThemes();

function themeOf(id: string): CapturedTheme {
  const theme = THEMES.get(id);
  if (!theme) throw new Error(`没捕获到 ${id}（装配面漂 = 本文件整个红）`);
  return theme;
}

function rulesByToken(theme: CapturedTheme): Map<string, Monaco.editor.ITokenThemeRule> {
  const map = new Map<string, Monaco.editor.ITokenThemeRule>();
  for (const rule of theme.rules) {
    if (map.has(rule.token)) throw new Error(`主题里 token「${rule.token}」出现了两次`);
    map.set(rule.token, rule);
  }
  return map;
}

/** 快照里出现过的主题（六套 v1 + 三套 kojo2） */
const SNAPSHOT_THEMES = Object.keys(snapshot) as (keyof typeof snapshot)[];

/* ============================== ① 覆盖度 ============================== */

/**
 * 三侧现役词法档（**改前**的名字；本文件就是"旧名清单"的验收处，故允许出现旧名）。
 * ERB 15 = `erb-language.ts` 的 6 个对象式 + 9 个简写式；v1 15 = `KOJO_TOKEN_TIERS`
 * 的 13 档 / 15 名；kojo2 16 = `KOJO2_TOKEN` 的十六格。
 */
const ERB_TOKEN_NAMES: readonly string[] = [
  'comment',
  'keyword',
  'keyword.preprocessor',
  'keyword.preprocessor.skip.start',
  'keyword.preprocessor.skip.end',
  'keyword.preprocessor.comment-code',
  'entity.name.function',
  'label',
  'string',
  'string.quote',
  'string.escape',
  'variable',
  'number',
  'operator',
  'identifier',
  'keyword.raw',
];

const V1_TOKEN_NAMES: readonly string[] = [
  'sugar.keyword',
  'sugar.keyword.alias',
  'sugar.system-function',
  'sugar.operator',
  'sugar.cont',
  'sugar.pronoun',
  'sugar.speech',
  'sugar.speech.delimiter',
  'sugar.interp',
  'sugar.interp.delimiter',
  'sugar.colon',
  'sugar.slot',
  'keyword.erb',
  'keyword.erb.family',
  'keyword.raw',
];

const KOJO2_TOKEN_NAMES: readonly string[] = [
  'kojo2.anchor',
  'kojo2.declaration',
  'kojo2.keyword',
  'kojo2.keyword.delimiter',
  'kojo2.speaker',
  'kojo2.speech',
  'kojo2.speech.string',
  'kojo2.narration',
  'kojo2.interp',
  'kojo2.hint',
  'kojo2.raw',
  'kojo2.comment',
  'kojo2.number',
  'kojo2.number.hex',
  'kojo2.operator',
  'kojo2.type',
];

describe('角色表覆盖三侧全部现役 token 名', () => {
  it('ERB / kojo1 / kojo2 三张清单的每一个旧名都在别名表里（漏一个即红）', () => {
    for (const token of [...ERB_TOKEN_NAMES, ...V1_TOKEN_NAMES, ...KOJO2_TOKEN_NAMES]) {
      expect(roleForLegacyToken(token), `别名表漏了「${token}」`).toBeDefined();
    }
  });

  it('别名的值全部是 SEMANTIC_ROLES 成员，且角色名唯一、带 role. 前缀', () => {
    for (const [legacy, role] of Object.entries(LEGACY_ROLE_ALIASES)) {
      expect(isSemanticRole(role), `${legacy} → ${role} 不是角色`).toBe(true);
      expect(role.startsWith('role.')).toBe(true);
    }
    expect(new Set(SEMANTIC_ROLES).size).toBe(SEMANTIC_ROLES.length);
  });

  it('每个角色都至少被一个现役 token 名用到（没有"登记了永远不发"的假档）', () => {
    const used = new Set<SemanticRole>(Object.values(LEGACY_ROLE_ALIASES));
    const unused = SEMANTIC_ROLES.filter((role) => !used.has(role));
    expect(unused, `未使用的角色：${unused.join(' / ')}`).toEqual([]);
  });

  it('kojo2 的十六个档位名都落在角色表里（词法档位 → 角色是同一张表）', () => {
    for (const token of Object.values(KOJO2_TOKEN)) {
      expect(isSemanticRole(token), `${token} 不是角色`).toBe(true);
    }
    // 十六个档位、少于十六个角色：多对一是设计（keyword 族四支同档、number/hex 同档）
    expect(new Set(Object.values(KOJO2_TOKEN)).size).toBeLessThan(KOJO2_TOKEN_NAMES.length);
  });
});

/* ============================== ② 零改色 ============================== */

describe('零改色：旧名 → 角色 → 主题色，与改前快照逐档逐字相等', () => {
  it.each(SNAPSHOT_THEMES)('%s：每一条旧规则都能按角色取回原色', (id) => {
    const rules = rulesByToken(themeOf(id));
    const expected = snapshot[id] as Record<string, { fg: string; fs: string | null }>;
    const mismatches: string[] = [];
    for (const [legacy, want] of Object.entries(expected)) {
      const role = roleForLegacyToken(legacy);
      // 名字层五条不经过别名表（D6）：它的键本身就是主题规则键
      const key = role ?? legacy;
      const rule = rules.get(key);
      if (!rule) {
        mismatches.push(`${legacy} → ${key}：主题里没有这条规则`);
        continue;
      }
      if (rule.foreground !== want.fg) {
        mismatches.push(`${legacy} → ${key}：前景 ${rule.foreground} ≠ 改前 ${want.fg}`);
      }
      if ((rule.fontStyle ?? null) !== want.fs) {
        mismatches.push(`${legacy} → ${key}：字重 ${String(rule.fontStyle)} ≠ 改前 ${String(want.fs)}`);
      }
    }
    expect(mismatches.join('\n'), `${id} 有 ${mismatches.length} 档改色了：\n${mismatches.join('\n')}`).toBe('');
  });

  it('快照本身够厚（反假绿地板：六套 v1 各 48 档、三套 kojo2 各 16 档）', () => {
    expect(SNAPSHOT_THEMES).toHaveLength(9);
    for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark', 'kojo-one-dark', 'kojo-rose-pine', 'kojo-synthwave84']) {
      expect(Object.keys(snapshot[id as keyof typeof snapshot]).length, id).toBe(48);
    }
    for (const id of KOJO2_THEME_IDS) {
      expect(Object.keys(snapshot[id as keyof typeof snapshot]).length, id).toBe(KOJO2_TOKEN_NAMES.length);
    }
  });
});

/* ============================== ③ 角色表的形状 ============================== */

describe('每套主题：每个角色有且只有一条规则', () => {
  const ROLE_THEME_IDS = [
    'kojo-dark',
    'kojo-light',
    'kojo-mint-dark',
    'kojo-one-dark',
    'kojo-rose-pine',
    'kojo-synthwave84',
    ...KOJO2_THEME_IDS,
  ] as const;

  it.each(ROLE_THEME_IDS)('%s：34 档角色一条不缺、一条不多', (id) => {
    const tokens = themeOf(id).rules.map((rule) => rule.token);
    const roleRules = tokens.filter((token) => token.startsWith('role.'));
    expect(new Set(roleRules).size, `${id} 有重复角色规则`).toBe(roleRules.length);
    expect([...roleRules].sort()).toEqual([...SEMANTIC_ROLES].sort());
    // v1 六套另带名字层五条；kojo2 三套只铺角色（2.0 没有名字层，§1）
    const nameLayer = tokens.filter((token) => !token.startsWith('role.'));
    const expectedNameLayer = (KOJO2_THEME_IDS as readonly string[]).includes(id) ? [] : NAME_LAYER_RULES.map((r) => r.token);
    expect([...nameLayer].sort()).toEqual([...expectedNameLayer].sort());
  });

  it('角色调色板的键集恰好 = SEMANTIC_ROLES（漏一档 / 多一档在装配期就抛）', () => {
    for (const [label, palette] of [
      ['dark', SEMANTIC_ROLE_PALETTE_DARK],
      ['light', SEMANTIC_ROLE_PALETTE_LIGHT],
      ['mint', SEMANTIC_ROLE_PALETTE_MINT],
    ] as const) {
      expect(() => assertRolePalette(palette, label)).not.toThrow();
      expect(Object.keys(palette).sort()).toEqual([...SEMANTIC_ROLES].sort());
    }
  });

  it('三张叶子规则表都与角色表同序同长（规则序 = 角色序，测试与文档都按此读）', () => {
    for (const [label, rules] of [
      ['dark', ROLE_THEME_RULES],
      ['light', ROLE_LIGHT_THEME_RULES],
      ['mint', ROLE_MINT_THEME_RULES],
    ] as const) {
      expect(rules.map((rule) => rule.token), label).toEqual([...SEMANTIC_ROLES]);
    }
  });

  it('角色 → 三侧样式映射的键集 = 角色表（kojo2-theme 的加载期自检是同一份断言）', () => {
    expect(Object.keys(KOJO2_THEME_TOKEN_MAP).sort()).toEqual([...SEMANTIC_ROLES].sort());
    expect(Object.keys(KOJO2_THEMES).sort()).toEqual([...KOJO2_THEME_IDS].sort());
  });
});

/* ============================== ④ 名字层正交（D6） ============================== */

describe('名字层五条不混进角色表（D6：语法角色与"这枚标识符是函数/变量/参数"正交）', () => {
  it('名字层五条都在 kojo-dark 里，且不与任何角色撞名', () => {
    const tokens = new Set(themeOf('kojo-dark').rules.map((rule) => rule.token));
    for (const spec of NAME_LAYER_RULES) {
      expect(tokens.has(spec.token), `缺名字层规则 ${spec.token}`).toBe(true);
      expect(isSemanticRole(spec.token), `${spec.token} 不该是角色名`).toBe(false);
    }
    expect(KOJO_SEMANTIC_THEME_RULES).toHaveLength(NAME_LAYER_RULES.length);
  });

  it('名字层五种分类一件不少（函数 / 定义点 / 参数 / 变量声明 / 常量声明）', () => {
    expect(NAME_LAYER_RULES.map((spec) => spec.token)).toEqual([
      'function',
      'function.declaration',
      'parameter',
      'variable.declaration',
      'variable.declaration.readonly',
    ]);
  });

  it('类型 / 结构名两门语言落同一角色（`role.type`），不再"各有各的绿"', () => {
    expect(roleForLegacyToken('support.type')).toBe(ROLE.type);
    expect(roleForLegacyToken('kojo2.type')).toBe(ROLE.type);
  });
});
