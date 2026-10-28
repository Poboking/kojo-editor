/**
 * 宿主语言面落点（SDK B4）的判据闸：契约数据 → Monaco 的三枚调用，以及
 * **没有供方时的那一种退化**。
 *
 * ## 为什么这一族判据必须存在
 *
 * B4 把"2.0 的词法长什么样"交给了插件，于是屏上有没有颜色取决于一条**装配链**：
 * 槽里有没有贡献 → 贡献的形状合不合契约 → 落点认不认那些档位名。这三段每一段都可能
 * 悄悄断掉，而断掉的表象是"编辑器看起来正常，只是不上色"。所以本文件钉的是链，不是数据：
 *
 * 1. **退化只有一种形状**（契约头注写死）：语言仍认领、id 仍正确、面不存在、**说出来**；
 *    不许有"插件没装就用宿主内置那份"的第二判据——本文件反着钉一次（宿主里没有那一副）。
 * 2. **一语言一供方**：第二枚贡献 ⇒ 第一家胜 + `console.error`（铁律 4：冲突必须 error）。
 * 3. **坏数据不静默**：不认识的缩进档位 / 非两元组规则 ⇒ 丢那一条并 warn，其余照落。
 * 4. **档位闭集在真 Monaco 上成立**：四档名与 vendored `monaco.d.ts` 的 `IndentAction`
 *    成员逐一对得上（契约包不引 Monaco，这条只能住在宿主侧）。
 * 5. **主题装配的分工**：规则沿用供方对象（不重造），部件色由宿主按侧名补，
 *    供方自带 `colors` 时以它为准。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonacoLanguageContribution, MonacoLanguageSurface } from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { KOJO2_MONARCH } from '@kojo/kojo-lang/monarch';
import { KOJO2_ON_ENTER_RULES } from '@kojo/kojo-lang/language-config';
import {
  KOJO2_DARK_THEME_ID,
  KOJO2_LIGHT_THEME_ID,
  KOJO2_THEME_SURFACES,
  KOJO2_THEMES,
} from '@kojo/kojo-lang/monaco-theme';
import { ROLE_THEME_RULES } from '@kojo/kojo-lang/theme-rules';
import { KOJO2_MONACO_LANGUAGE_SURFACE } from '@kojo/plugin-kojo-lang';
import { registerKojo2Language } from '../src/monaco/kojo2-language';
import { CJK_WORD_PATTERN } from '../src/monaco/word-separators';
import { stubMonaco, type Captured } from './monarch-harness';
import {
  applyAllMonacoLanguageSurfaces,
  applyAllMonacoLanguageThemes,
  applyMonacoLanguageSurface,
  componentColorKeysFor,
  materializeMonacoTheme,
  monacoLanguageSurfaceInventory,
  registerMonacoLanguageSurfaceSource,
  toMonacoLanguageConfiguration,
  toMonacoMonarch,
  toMonacoOnEnterRules,
  unregisterMonacoLanguageSurfaceSource,
} from '../src/monaco/monaco-language-surface';

/* ============================== 测试用的登记表开关 ============================== */

let activeGetter: (() => readonly MonacoLanguageContribution[]) | null = null;

function supply(surfaces: readonly MonacoLanguageSurface[]): void {
  const getter = (): readonly MonacoLanguageContribution[] =>
    surfaces.map((surface, index) => ({ id: `test:supplier-${index}`, surface }));
  activeGetter = getter;
  registerMonacoLanguageSurfaceSource(getter);
}

function supplyContributions(...items: readonly MonacoLanguageContribution[]): void {
  const getter = (): readonly MonacoLanguageContribution[] => items;
  activeGetter = getter;
  registerMonacoLanguageSurfaceSource(getter);
}

function contributionOf(surface: MonacoLanguageSurface, id: string): MonacoLanguageContribution {
  return { id, surface };
}

afterEach(() => {
  if (activeGetter !== null) unregisterMonacoLanguageSurfaceSource(activeGetter);
  activeGetter = null;
  vi.restoreAllMocks();
});

/** 落点交给 `setLanguageConfiguration` 的那一副（只取本文件要读的几格） */
interface AppliedConfig {
  readonly comments?: { lineComment?: string };
  readonly wordPattern?: RegExp;
  readonly brackets?: readonly [string, string][];
  readonly autoClosingPairs?: readonly { open: string; close: string }[];
  readonly surroundingPairs?: readonly { open: string; close: string }[];
  readonly onEnterRules?: readonly { beforeText: RegExp; action: { indentAction: number } }[];
  readonly indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp };
}

function configFor(captured: Captured, id: string): AppliedConfig | undefined {
  return captured.configs
    .map((entry) => entry as { id: string; config: AppliedConfig })
    .find((entry) => entry.id === id)?.config;
}

function warned(warn: { mock: { calls: readonly unknown[][] } }): string {
  return warn.mock.calls.map((call) => call.join(' ')).join('\n');
}

/* ============================== ① 退化：没有供方 ============================== */

describe('没有供方时的退化（契约头注写死的那一种）', () => {
  it('语言仍认领、面不存在、且只说一条 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, captured } = stubMonaco();
    registerKojo2Language(monaco);
    expect(captured.registered, '文件要能打开：语言必须仍被认领').toContain(KOJO2_LANGUAGE_ID);
    expect(captured.monarchs.has(KOJO2_LANGUAGE_ID), '没有供方就没有词法，宿主不许兜一份').toBe(false);
    expect(captured.configs).toHaveLength(0);
    expect(warned(warn)).toMatch(/没有语言面供方（插件未激活）/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('同一实例重复认领不重复喊（台账按 (实例, 语言) 记）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco } = stubMonaco();
    registerKojo2Language(monaco);
    applyMonacoLanguageSurface(monaco, KOJO2_LANGUAGE_ID, { absentIsVisible: true });
    applyMonacoLanguageSurface(monaco, KOJO2_LANGUAGE_ID, { absentIsVisible: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('组合根那一遍（applyAll）不再重复说：晚激活是常态，不是事故', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco } = stubMonaco();
    registerKojo2Language(monaco);
    applyAllMonacoLanguageSurfaces(monaco);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('来源抛错按"没有供方"处理并说出来（不猜、不半落）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getter = (): readonly MonacoLanguageContribution[] => {
      throw new Error('kernel 还没起来');
    };
    activeGetter = getter;
    registerMonacoLanguageSurfaceSource(getter);
    const { monaco, captured } = stubMonaco();
    applyMonacoLanguageSurface(monaco, KOJO2_LANGUAGE_ID, { absentIsVisible: true });
    expect(captured.monarchs.size).toBe(0);
    expect(warned(warn)).toMatch(/语言面来源抛错/);
    // 抛错不是"冲突"，不该按 error 报（那是给两枚供方抢同一门语言留的档）
    expect(error).not.toHaveBeenCalled();
  });

  it('宿主侧不存在第二份 kojo2 词法（"兜底"就是回归成两份判据）', () => {
    // 反证扫宿主 src：落点与指针之外，不许再出现 `export const KOJO2_MONARCH =`。
    const files = [
      '../src/monaco/kojo2-language.ts',
      '../src/monaco/kojo2-enter.ts',
      '../src/monaco/monaco-language-surface.ts',
    ].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
    const owners = files.filter((file) => /export const KOJO2_MONARCH\s*=/.test(readFileSync(file, 'utf8')));
    expect(owners, `宿主里出现了第二份 Monarch 正文：${owners.join(', ')}`).toEqual([]);
  });
});

/* ============================== ② 供方在位：落到 Monaco 的那一副 ============================== */

describe('供方在位：词法与配置落到 Monaco', () => {
  it('认领即上色：monarch 与 configuration 各一副，词表铺回根部', () => {
    supply([KOJO2_MONACO_LANGUAGE_SURFACE]);
    const { monaco, captured } = stubMonaco();
    registerKojo2Language(monaco);
    expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
    const monarch = captured.monarchs.get(KOJO2_LANGUAGE_ID) as unknown as Record<string, unknown>;
    // `@declWords` 这类 cases 卫兵从 monarch 对象**根部**取词表 ⇒ 落点必须把 wordLists 铺开
    expect(Array.isArray(monarch['declWords'])).toBe(true);
    expect(monarch['tokenizer']).toBeTruthy();
    const config = configFor(captured, KOJO2_LANGUAGE_ID);
    expect(config?.comments?.lineComment).toBe('//');
    // 词边界是编辑器 chrome：供方没写 wordPattern ⇒ 落点补宿主那份，且是**同一枚对象**
    expect(config?.wordPattern).toBe(CJK_WORD_PATTERN);
    expect(config?.onEnterRules?.map((rule) => rule.action.indentAction)).toEqual([
      monaco.languages.IndentAction.Indent,
      monaco.languages.IndentAction.Indent,
    ]);
    expect(config?.indentationRules?.increaseIndentPattern).toBeTruthy();
  });

  it('配置一副的三格仍由同一张成对记号表派生（落点不新增第二份）', () => {
    supply([KOJO2_MONACO_LANGUAGE_SURFACE]);
    const { monaco } = stubMonaco();
    const applied = toMonacoLanguageConfiguration(
      monaco,
      KOJO2_MONACO_LANGUAGE_SURFACE.configuration!,
      'test:kojo2',
    ) as AppliedConfig;
    const keys = (pairs?: readonly { open: string; close: string }[]) =>
      (pairs ?? []).map((pair) => `${pair.open}${pair.close}`);
    expect(keys(applied.autoClosingPairs)).toEqual(keys(applied.surroundingPairs));
    expect(applied.brackets?.length).toBe(5);
    expect(applied.autoClosingPairs?.length).toBe(6);
  });

  it('晚激活的供方由组合根补上（认领时没有、挂载后有）', () => {
    const { monaco, captured } = stubMonaco();
    registerKojo2Language(monaco);
    expect(captured.monarchs.size).toBe(0);
    supply([KOJO2_MONACO_LANGUAGE_SURFACE]);
    applyAllMonacoLanguageSurfaces(monaco);
    expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
    expect(captured.configs.filter((entry) => (entry as { id: string }).id === KOJO2_LANGUAGE_ID)).toHaveLength(1);
  });

  it('没有认领的语言不在补落范围里（认领由 descriptor 决定，不靠槽）', () => {
    supply([{ ...KOJO2_MONACO_LANGUAGE_SURFACE, languageId: 'no-such-language' }]);
    const { monaco, captured } = stubMonaco();
    applyAllMonacoLanguageSurfaces(monaco);
    expect(captured.monarchs.size).toBe(0);
  });

  it('同一门语言两枚供方：第一家胜 + error（冲突不许静默）', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    supplyContributions(
      contributionOf(KOJO2_MONACO_LANGUAGE_SURFACE, 'first'),
      contributionOf(
        { languageId: KOJO2_LANGUAGE_ID, monarch: { tokenizer: { root: [[/^/, 'role.anchor']] } } },
        'second',
      ),
    );
    const { monaco, captured } = stubMonaco();
    registerKojo2Language(monaco);
    expect(error.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(/第二枚语言面贡献/);
    // 落地的必须是第一家那副真词法，不是第二家的残本
    expect(captured.monarchs.get(KOJO2_LANGUAGE_ID)).toEqual(toMonacoMonarch(KOJO2_MONARCH, 'first'));
  });

  it('三副全空的贡献 = 接线忘了填：error 并跳过，不占住这门语言', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    supplyContributions(
      contributionOf({ languageId: KOJO2_LANGUAGE_ID }, 'empty'),
      contributionOf(KOJO2_MONACO_LANGUAGE_SURFACE, 'real'),
    );
    const { monaco, captured } = stubMonaco();
    registerKojo2Language(monaco);
    expect(error.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(/三副面全空/);
    expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
    expect(monacoLanguageSurfaceInventory()).toEqual([KOJO2_LANGUAGE_ID]);
  });

  it('没有 languageId 的贡献被跳过并点名是谁', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    supplyContributions({ id: 'no-id', surface: {} as MonacoLanguageSurface });
    const { monaco } = stubMonaco();
    expect(applyMonacoLanguageSurface(monaco, KOJO2_LANGUAGE_ID)).toBe(false);
    expect(error.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(/'no-id'/);
  });

  it('注销只撤自己那一枚（别人的 getter 还在）', () => {
    const mine = (): readonly MonacoLanguageContribution[] => [];
    const theirs = (): readonly MonacoLanguageContribution[] => [
      contributionOf(KOJO2_MONACO_LANGUAGE_SURFACE, 'theirs'),
    ];
    registerMonacoLanguageSurfaceSource(mine);
    registerMonacoLanguageSurfaceSource(theirs);
    unregisterMonacoLanguageSurfaceSource(mine);
    const { monaco, captured } = stubMonaco();
    applyMonacoLanguageSurface(monaco, KOJO2_LANGUAGE_ID);
    expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
    activeGetter = theirs;
  });
});

/* ============================== ③ 形状不合：丢那一条并说出来 ============================== */

describe('形状校验：坏数据不静默（丢一条 ≠ 丢一副）', () => {
  it('不认识的缩进档位 ⇒ 丢那一条 onEnterRule 并 warn，其余照落', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco } = stubMonaco();
    const rules = toMonacoOnEnterRules(
      monaco,
      [...KOJO2_ON_ENTER_RULES, { beforeText: /ok$/, action: { indentAction: 'appendTab' as never } }],
      'test:shape',
    );
    expect(rules).toHaveLength(KOJO2_ON_ENTER_RULES.length);
    expect(warned(warn)).toMatch(/不认识的缩进档位/);
  });

  it('缺 `beforeText` 的那一条被丢弃（Monaco 无从命中）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco } = stubMonaco();
    const rules = toMonacoOnEnterRules(
      monaco,
      [{ action: { indentAction: 'indent' } } as never],
      'test:shape',
    );
    expect(rules).toEqual([]);
    expect(warned(warn)).toMatch(/缺 `beforeText`/);
  });

  it('非两元组的规则 / 根部陌生键 ⇒ warn，但整副词法仍然落地', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const monarch = toMonacoMonarch(
      {
        tokenizer: { root: [[/^a/, 'role.anchor'], ['坏的一条']] },
        unicode: true,
      } as never,
      'test:shape',
    ) as unknown as { tokenizer: Record<string, unknown[]> };
    const text = warned(warn);
    expect(text).toMatch(/不是 \[模式, 动作\]/);
    expect(text).toMatch(/根部不认识的键「unicode」/);
    expect(monarch.tokenizer['root']).toHaveLength(1);
  });

  it('四档档位名都在真 Monaco 的 `IndentAction` 上在册（闭集不是口头承诺）', () => {
    const dts = readFileSync(
      fileURLToPath(new URL('../node_modules/monaco-editor/monaco.d.ts', import.meta.url)),
      'utf8',
    );
    const start = dts.indexOf('export enum IndentAction');
    expect(start, 'monaco.d.ts 里找不到 IndentAction（升级改了形状：本闸要红，不许静默）').toBeGreaterThan(-1);
    const body = dts.slice(start, start + 420);
    const { monaco } = stubMonaco();
    for (const tier of ['none', 'indent', 'indentOutdent', 'outdent'] as const) {
      const member = `${tier[0]!.toUpperCase()}${tier.slice(1)}`;
      expect(body, `Monaco 的 IndentAction 没有 ${member}`).toContain(`${member} =`);
      expect(
        toMonacoOnEnterRules(monaco, [{ beforeText: /x/, action: { indentAction: tier } }], 't'),
        tier,
      ).toHaveLength(1);
    }
  });
});

/* ============================== ④ 主题：规则同源 + 部件色由宿主补 ============================== */

describe('主题落点：规则沿用供方对象、部件色按侧名补齐', () => {
  it('三套的 colors 键集 = 宿主同侧部件色；规则元素不重造', () => {
    for (const declared of KOJO2_THEME_SURFACES) {
      const theme = materializeMonacoTheme(declared);
      const side = declared.componentPalette ?? 'dark';
      expect(Object.keys(theme.colors).sort()).toEqual([...componentColorKeysFor(side)].sort());
      expect(theme.rules).toHaveLength(declared.rules.length);
      for (let i = 0; i < theme.rules.length; i += 1) {
        expect(theme.rules[i]).toBe(declared.rules[i]);
      }
    }
    // 暗色侧与叶子规则表同一批对象（"v1 六套与 2.0 三套铺同一份规则"的落点侧见证）
    const dark = materializeMonacoTheme(KOJO2_THEMES[KOJO2_DARK_THEME_ID]);
    for (let i = 0; i < ROLE_THEME_RULES.length; i += 1) {
      expect(dark.rules[i]).toBe(ROLE_THEME_RULES[i]);
    }
  });

  it('亮色与暗色的底色确实不同（不是复制粘贴的假亮色）', () => {
    const dark = materializeMonacoTheme(KOJO2_THEMES[KOJO2_DARK_THEME_ID]);
    const light = materializeMonacoTheme(KOJO2_THEMES[KOJO2_LIGHT_THEME_ID]);
    expect(dark.colors['editor.background']).not.toBe(light.colors['editor.background']);
  });

  it('供方自带 colors 时以它为准（第三方语言包可以自定义浮层色）', () => {
    const theme = materializeMonacoTheme({
      id: 'custom',
      base: 'vs-dark',
      inherit: false,
      rules: [{ token: 'role.anchor', foreground: 'ff0000' }],
      colors: { 'editor.background': '#123456' },
    });
    expect(theme.colors).toEqual({ 'editor.background': '#123456' });
  });

  it('非法前景色 / 未登记的部件色侧 ⇒ 装配期抛，不静默掉色', () => {
    expect(() =>
      materializeMonacoTheme({
        id: 'bad-foreground',
        base: 'vs-dark',
        inherit: false,
        rules: [{ token: 'role.anchor', foreground: '#ff0000' } as never],
      }),
    ).toThrow(/没有合法前景色/);
    expect(() =>
      materializeMonacoTheme({
        id: 'bad-side',
        base: 'vs-dark',
        inherit: false,
        rules: [{ token: 'role.anchor', foreground: 'ff0000' }],
        componentPalette: 'sepia' as never,
      }),
    ).toThrow(/在宿主没有登记/);
    expect(() => componentColorKeysFor('sepia' as never)).toThrow(/没有登记/);
  });

  it('主题注册幂等：同一实例一轮、第二个实例各铺一份；无供方时 absentIsVisible 只说一条', () => {
    expect(applyAllMonacoLanguageThemes(stubMonaco().monaco)).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bare = stubMonaco().monaco;
    expect(applyAllMonacoLanguageThemes(bare, { absentIsVisible: true })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(applyAllMonacoLanguageThemes(bare, { absentIsVisible: true })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    supply([KOJO2_MONACO_LANGUAGE_SURFACE]);
    const { monaco, captured } = stubMonaco();
    expect(applyAllMonacoLanguageThemes(monaco)).toBe(true);
    expect([...captured.themes.keys()]).toEqual(KOJO2_THEME_SURFACES.map((theme) => theme.id));
    expect(applyAllMonacoLanguageThemes(monaco)).toBe(false);
    expect(applyAllMonacoLanguageThemes(stubMonaco().monaco)).toBe(true);
  });

  it('同实例晚到供方：空供方那一轮不算"铺过"，下一轮照样补上三套', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, captured } = stubMonaco();
    // 第一次 apply：插件还没激活 ⇒ 只落一条 warn、零主题（与改前逐字相同）。
    expect(applyAllMonacoLanguageThemes(monaco, { absentIsVisible: true })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect([...captured.themes.keys()]).toEqual([]);

    // 供方晚到：同一实例再来一轮必须补上——改前 WeakSet 已把它当"落过"，这里恒 false。
    supply([KOJO2_MONACO_LANGUAGE_SURFACE]);
    expect(applyAllMonacoLanguageThemes(monaco)).toBe(true);
    const ids = [...captured.themes.keys()];
    expect(ids).toEqual(KOJO2_THEME_SURFACES.map((theme) => theme.id));
    expect(ids.filter((id) => id.startsWith('kojo2-'))).toHaveLength(3);

    // 第三次 apply：真铺过之后才幂等（不重复 defineTheme）。
    expect(applyAllMonacoLanguageThemes(monaco)).toBe(false);
    expect([...captured.themes.keys()]).toHaveLength(KOJO2_THEME_SURFACES.length);
  });
});
