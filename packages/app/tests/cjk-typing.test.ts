import { describe, expect, it, vi } from 'vitest';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from '../src/monaco/kojo-language';
import { CJK_AMBIGUOUS_WHITELIST, CJK_WORD_PATTERN, CJK_WORD_SEPARATORS } from '../src/monaco/word-separators';
import { CJK_TYPING_BASELINE, editorOptionsForLineCount, quickSuggestionsFor } from '../src/ui/editor-options';
import type * as Monaco from '../src/monaco/entry';

/**
 * A2+A3 · 中文编辑噪声整治 + CJK 选词。
 *
 * 行为断言不靠桩：直接 import vendored monaco（同 app 依赖同版本）的 common 层内部模块——
 * `WordCharacterClassifier`（编辑器选项 wordSeparators 的双击/Ctrl+方向键分词真身）、
 * `getWordAtText`（语言 wordPattern → `LineContext.shouldAutoTrigger` 的判词真身）、
 * `UnicodeTextModelHighlighter`（unicodeHighlight 标红判定的真身）。桩 monaco 只能验"传了什么"，
 * 验不了"全角字符在这些表里真实生效"，而后者才是本批的全部风险所在。
 */

/** monaco 深层 common 模块无 subpath 类型 ⇒ 变量路径动态 import（node 原生解析 exports 映射） */
async function monacoInternal(sub: string): Promise<Record<string, any>> {
  return import(/* @vite-ignore */ `monaco-editor/editor/common/${sub}`);
}

/** 全角标点（本批口径）：双击应把两个标点之间的短语整段选中 */
const FULLWIDTH_PUNCT = ['，', '。', '、', '；', '：', '！', '？', '「', '」', '『', '』', '（', '）', '《', '》'];

function mockMonaco() {
  const configs: Array<{ id: string; config: Monaco.languages.LanguageConfiguration }> = [];
  const monaco = {
    languages: {
      // ZH-D4 回车层合流后 kojo 配置会引用 IndentAction（与 kojo-enter.test.ts 的 mock 同款）
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      getLanguages: () => configs.map((c) => ({ id: c.id })),
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: (id: string, config: Monaco.languages.LanguageConfiguration) => {
        configs.push({ id, config });
      },
    },
    editor: { defineTheme: vi.fn() },
  };
  return { configs, monaco: monaco as unknown as Parameters<typeof registerErbLanguage>[0] };
}

describe('语言配置 wordPattern（model 层分词 + `：` 触发字通道）', () => {
  it('ERB 与 kojo 两套语言都被以含全角标点的 wordPattern 调用 setLanguageConfiguration', () => {
    const { configs, monaco } = mockMonaco();
    registerErbLanguage(monaco);
    registerKojoLanguage(monaco);
    expect(configs.map((c) => c.id)).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]);
    for (const { config } of configs) {
      expect(config.wordPattern).toBe(CJK_WORD_PATTERN);
      for (const ch of FULLWIDTH_PUNCT) expect(config.wordPattern!.source).toContain(ch);
      // monaco 默认 ASCII 分隔集不许丢
      for (const ch of ['~', '!', '@', ';', '"', '<', '/', '?']) {
        expect(config.wordPattern!.source).toContain(ch);
      }
    }
  });

  it('行为（真 getWordAtText）：全角标点之间的短语各自成词', async () => {
    const { getWordAtText } = await monacoInternal('core/wordHelper.js');
    const re = () => new RegExp(CJK_WORD_PATTERN.source, 'g');
    const line = '你好，世界。台词';
    expect(getWordAtText(1, re(), line, 0)).toMatchObject({ word: '你好', startColumn: 1, endColumn: 3 });
    expect(getWordAtText(4, re(), line, 0)).toMatchObject({ word: '世界', startColumn: 4, endColumn: 6 });
    expect(getWordAtText(7, re(), line, 0)).toMatchObject({ word: '台词', startColumn: 7, endColumn: 9 });
  });

  it('行为（真 getWordAtText）：打完 `：` 光标处无词 ⇒ shouldAutoTrigger 为 false ⇒ 触发字通道放行', async () => {
    const { getWordAtText, DEFAULT_WORD_REGEXP } = await monacoInternal('core/wordHelper.js');
    // 新 wordPattern：`：` 是分隔符，`你好：` 光标 (col 4) 处不再有"以光标结尾的词"
    expect(getWordAtText(4, new RegExp(CJK_WORD_PATTERN.source, 'g'), '你好：', 0)).toBeNull();
    // 基线对照：默认分词把 `：` 并入词（endColumn === 光标列 ⇒ 本该走 quick suggest；
    // quickSuggestions 关后若不换 wordPattern，`：` 显式触发会被 suggestModel 吞掉）
    expect(getWordAtText(4, DEFAULT_WORD_REGEXP, '你好：', 0)).toMatchObject({ word: '你好：', endColumn: 4 });
  });
});

describe('编辑器选项 wordSeparators（双击 / Ctrl+方向键的分词真身）', () => {
  it('行为（真 WordCharacterClassifier）：全角标点判为分隔符，汉字/字母判为词字符', async () => {
    const { WordCharacterClassifier } = await monacoInternal('core/wordCharacterClassifier.js');
    const cl = new WordCharacterClassifier(CJK_WORD_SEPARATORS, []);
    const cls = (ch: string) => cl.get(ch.charCodeAt(0));
    for (const ch of FULLWIDTH_PUNCT) expect(cls(ch), ch + ' 应为分隔符').toBe(2); // WordCharacterClass.WordSeparator
    expect(cls('世'), '汉字应为词字符').toBe(0); // Regular
    expect(cls('a')).toBe(0);
    expect(cls(',')).toBe(2); // 半角默认集仍在
  });

  it('monaco 默认 ASCII 集零删减（编辑器选项串以默认集为前缀）', async () => {
    const { USUAL_WORD_SEPARATORS } = await monacoInternal('core/wordHelper.js');
    expect(CJK_WORD_SEPARATORS.startsWith(USUAL_WORD_SEPARATORS)).toBe(true);
  });
});

describe('unicodeHighlight（中文标点零标红 + 同形异义告警保留）', () => {
  /** 复刻 contrib 的公开→内部换算（unicodeHighlighter.js：allowedCharacters 键→码点，allowedLocales 键→locale 数组） */
  const internalOptions = (locales: string[], whitelist: boolean) => ({
    nonBasicASCII: false,
    invisibleCharacters: true,
    ambiguousCharacters: true,
    allowedCodePoints: whitelist ? Object.keys(CJK_AMBIGUOUS_WHITELIST).map((c) => c.codePointAt(0)) : [],
    allowedLocales: locales,
  });

  it('配置面：两档编辑器选项都带同一 unicodeHighlight 基线', () => {
    const u = CJK_TYPING_BASELINE.unicodeHighlight!;
    expect(u.nonBasicASCII).toBe(false); // monaco 公开面无 'neverVisible'（VS Code 词汇）；false 即等价
    expect(u.ambiguousCharacters).toBe(true); // 不许整项关——真同形异义告警要留
    expect(u.allowedLocales).toEqual({ 'zh-hans': true, 'zh-hant': true });
    for (const ch of FULLWIDTH_PUNCT) expect(u.allowedCharacters![ch]).toBe(true);
    for (const n of [10, 100_000]) expect(editorOptionsForLineCount(n).unicodeHighlight).toEqual(u);
  });

  it('行为（真 UnicodeTextModelHighlighter）：本批配置下全角标点 / 汉字均不标红', async () => {
    const { UnicodeTextModelHighlighter } = await monacoInternal('services/unicodeTextModelHighlighter.js');
    const opts = internalOptions(['zh-hans', 'zh-hant'], true);
    for (const ch of [...FULLWIDTH_PUNCT, '“', '”', '～', '你', '説']) {
      expect(UnicodeTextModelHighlighter.computeUnicodeHighlightReason(ch, opts), ch).toBeNull();
    }
  });

  it('行为：白名单不许过宽——西里尔 а 照旧按歧义字符告警', async () => {
    const { UnicodeTextModelHighlighter } = await monacoInternal('services/unicodeTextModelHighlighter.js');
    const r = UnicodeTextModelHighlighter.computeUnicodeHighlightReason('а', internalOptions(['zh-hans', 'zh-hant'], true));
    expect(r).not.toBeNull();
    expect(r.kind).toBe(0); // UnicodeHighlighterReasonKind.Ambiguous
  });

  it('基线对照：不加 zh locale/白名单时 ，：（） 会被标红——这就是本批灭掉的噪声源', async () => {
    const { UnicodeTextModelHighlighter } = await monacoInternal('services/unicodeTextModelHighlighter.js');
    const legacy = internalOptions([], false);
    for (const ch of ['，', '：', '（', '）', '！', '？', '；']) {
      expect(UnicodeTextModelHighlighter.computeUnicodeHighlightReason(ch, legacy), ch).not.toBeNull();
    }
  });
});

describe('quickSuggestions 形态（纯函数配置面）', () => {
  it('所有档位都是代码位快建议、注释/字符串关；只读或设置页关 ⇒ 整条关', () => {
    const codeSuggestions = { other: true, comments: false, strings: false };
    expect(CJK_TYPING_BASELINE.quickSuggestions).toEqual(codeSuggestions);
    for (const n of [10, 500, 100_000]) {
      expect(editorOptionsForLineCount(n).quickSuggestions).toEqual(codeSuggestions);
      expect(editorOptionsForLineCount(n).wordSeparators).toBe(CJK_WORD_SEPARATORS);
    }
    expect(quickSuggestionsFor(false)).toEqual(codeSuggestions);
    expect(quickSuggestionsFor(true)).toBe(false);
    // QSUG-2：设置页总开关（第二参）关掉时，可写编辑器也整条关
    expect(quickSuggestionsFor(false, false)).toBe(false);
    expect(quickSuggestionsFor(true, false)).toBe(false);
    expect(quickSuggestionsFor(false, true)).toEqual(codeSuggestions);
  });
});
