import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { classifyLine, computeFormatEdits, splitLogicalLines, sugarEnterIndentAfter } from '@kojo/plugin-kojo-sugar';
import { MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from '../src/monaco/kojo-language';
import { CJK_WORD_PATTERN, CJK_WORD_SEPARATORS } from '../src/monaco/word-separators';
import { editorOptionsForLineCount } from '../src/ui/editor-options';
import { stubMonaco } from './monarch-harness';

/**
 * `.kojo` **语言配置层**（`ILanguageConfiguration`）钉测 —— 打字手感那一层，与语义面
 * （补全 / 诊断 / 悬停 / 转到定义）正交：那批测试管"编辑器知道什么"，这里管"敲键盘时发生什么"。
 *
 * 口径与 `cjk-typing.test.ts` 同一条：桩只用来**取回注册时那份配置对象**，凡判据一律走
 * vendored monaco 0.57 的 common 层内部模块（`CharacterPairSupport` / `AutoClosingPairs` /
 * `LanguageBracketsConfiguration` / `StandardAutoClosingPairConditional` / `toStandardTokenType` /
 * `getWordAtText` / `WordCharacterClassifier`）——它们才是 `brackets` / `autoClosingPairs` /
 * `surroundingPairs` / `autoCloseBefore` / `wordPattern` 这几格的真实消费者。桩测只能证明"传了什么"，
 * 证不了"全角 `「」` 真的成对、`：` 真的没被当括号"，而后者才是本层的全部风险所在。
 *
 * 语法事实真源在 `kojo-sugar`：`lexer.ts` 的 `RULE_TAG_RE` / `inlineCommentIndex`、`codegen.ts` 的
 * 台词引号表、`formatter.ts` 的缩进单位。本文件因此**不写任何缩进字面量** —— 空格单位是从
 * `computeFormatEdits` 的产物里量出来的，再与回车层、编辑器选项绑成同一档（这条坑踩过：
 * 「回车自动缩进」与「`Shift+Alt+F`」各用一套单位 ⇒ 每敲一次都互相打脸）。
 */

type Pair = { open: string; close: string };
type Triple = readonly [string, string];

function kojoConfig(): Monaco.languages.LanguageConfiguration {
  const { monaco, captured } = stubMonaco();
  registerKojoLanguage(monaco);
  const entry = captured.configs.find((c) => (c as { id: string }).id === KOJO_LANGUAGE_ID) as {
    config: Monaco.languages.LanguageConfiguration;
  };
  return entry.config;
}

/** monaco 深层 common 模块无 subpath 类型 ⇒ 变量路径动态 import（cjk-typing 同款手法） */
async function monacoInternal(sub: string): Promise<Record<string, any>> {
  return import(/* @vite-ignore */ `monaco-editor/editor/common/${sub}`);
}

const SPEECH: Triple = ['「', '」'];
const RULE_TAG: Triple = ['[', ']'];
const STRING: Triple = ['"', '"'];
/** 全角冒号与逗号、不等待标记：块头终止符 / 分隔符，从来不是括号对 */
const NOT_BRACKETS = ['：', ',', '，', '。', '；', '~', '⏎'];

const pairKey = (p: { open: string; close: string }): string => `${p.open}\u0000${p.close}`;
const closingPairs = (config: Monaco.languages.LanguageConfiguration): Pair[] =>
  (config.autoClosingPairs ?? []).map((p) => ({ open: p.open, close: p.close }));
const bracketTriples = (config: Monaco.languages.LanguageConfiguration): Triple[] =>
  (config.brackets ?? []) as unknown as Triple[];

/* ============================ 一、成对记号三格 ============================ */

describe('成对记号：brackets / autoClosingPairs / surroundingPairs 同源一张表', () => {
  it('包裹格与闭合格逐项相同；括号格 = 二者去掉 open===close 的那对', () => {
    const config = kojoConfig();
    const closing = closingPairs(config);
    const surrounding = (config.surroundingPairs ?? []).map((p) => ({ open: p.open, close: p.close }));
    expect(surrounding).toEqual(closing);
    expect(bracketTriples(config)).toEqual(closing.filter((p) => p.open !== p.close).map((p) => [p.open, p.close]));
    // 反恒真：三格都不空、`"` 确实只在闭合与包裹两格（引号不是括号）
    expect(closing.length).toBeGreaterThanOrEqual(6);
    expect(closing.map(pairKey)).toContain(pairKey({ open: STRING[0], close: STRING[1] }));
    expect(bracketTriples(config).map((p) => p.join(''))).not.toContain(STRING.join(''));
  });

  it('台词 `「」`、规则池标签 `[]`、字符串 `""` 都成对（本批收的三格缺口）', () => {
    const keys = closingPairs(kojoConfig()).map(pairKey);
    expect(keys).toContain(pairKey({ open: SPEECH[0], close: SPEECH[1] }));
    expect(keys).toContain(pairKey({ open: RULE_TAG[0], close: RULE_TAG[1] }));
    expect(keys).toContain(pairKey({ open: STRING[0], close: STRING[1] }));
    // 同一条对不许出现两次：分桶后它变两候选，判据就模糊了
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('全角 `：` / `，` 与不等待标记不进任何括号格', () => {
    const config = kojoConfig();
    const chars = [...closingPairs(config).flatMap((p) => [p.open, p.close]), ...bracketTriples(config).flat()];
    for (const ch of NOT_BRACKETS) expect(chars, `${ch} 不该是括号`).not.toContain(ch);
  });

  it('真 monaco：`「」` / `[]` 是配对括号且进对着色；`：` 与 `"` 根本不是括号', async () => {
    const { LanguageBracketsConfiguration } = await monacoInternal(
      'languages/supports/languageBracketsConfiguration.js',
    );
    const config = kojoConfig();
    // 0.57 没有 `colorizeConfiguration` 这一格；能对括号着色的那格是 `colorizedBracketPairs`，
    // 未配 ⇒ monaco 回落整份 `brackets`（只剔 `<` `>`）⇒ 台词嵌套的层色不用另配一格就生效
    expect(config.colorizedBracketPairs).toBeUndefined();
    const brackets = new LanguageBracketsConfiguration(KOJO_LANGUAGE_ID, config);
    for (const [open, close] of [SPEECH, RULE_TAG, ['{', '}'], ['（', '）'], ['(', ')']]) {
      const opening = brackets.getOpeningBracketInfo(open);
      const closing = brackets.getClosingBracketInfo(close);
      expect(opening, `${open} 应是开括号`).toBeTruthy();
      expect(closing, `${close} 应是闭括号`).toBeTruthy();
      expect(closing.closes(opening), `${open}${close} 应互为配对`).toBe(true);
      expect(closing.closesColorized(opening), `${open}${close} 应进对着色`).toBe(true);
    }
    for (const ch of ['：', ',', '，']) expect(brackets.getBracketInfo(ch), `${ch} 不该是括号`).toBeUndefined();
    expect(brackets.getOpeningBracketInfo(STRING[0])).toBeUndefined();
  });

  it('`」` 只当闭括号、绝不当开括号 ⇒ 台词里继续输入既不吞也不叠一枚', async () => {
    const { CharacterPairSupport } = await monacoInternal('languages/supports/characterPair.js');
    const { AutoClosingPairs } = await monacoInternal('languages/languageConfiguration.js');
    const support = new CharacterPairSupport(kojoConfig());
    const pairs = new AutoClosingPairs(support.getAutoClosingPairs());
    // 这四张桶就是 `cursorTypeEditOperations` 的 `_findAutoClosingPairOpen` /
    // `_isBeforeClosingBrace` / `isAutoClosingOvertype` 直接读的表
    expect(pairs.autoClosingPairsOpenByStart.get(SPEECH[1])).toBeUndefined();
    expect(pairs.autoClosingPairsOpenByEnd.get(SPEECH[1])).toBeUndefined();
    expect((pairs.autoClosingPairsCloseByStart.get(SPEECH[1]) ?? []).map(pairKey)).toContain(
      pairKey({ open: SPEECH[0], close: SPEECH[1] }),
    );
    // 单字符闭括号必须可"打过去"（type-over），否则作者补敲 `」` 会叠成 `」」`
    expect(pairs.autoClosingPairsCloseSingleChar.has(SPEECH[1])).toBe(true);
    // 反过来：`「` 只当开括号 ⇒ 光标右侧既有 `」` 时 `_isBeforeClosingBrace` 为真，
    // 打 `「` 照常成对（不是"右侧有字符就不闭合"）
    expect(pairs.autoClosingPairsCloseByStart.get(SPEECH[0])).toBeUndefined();
    expect(pairs.autoClosingPairsOpenByEnd.get(SPEECH[0])?.length).toBe(1);
    // 包裹格的真实消费者：`surroundingPairs || autoClosingPairs` —— 本语言显式配了，
    // 配得与闭合格逐项相同（上面那条等式）才不会出现"能自动闭合、选中却包不住"
    expect(support.getSurroundingPairs().map(pairKey)).toEqual(support.getAutoClosingPairs().map(pairKey));
  });

  it('台词 token 不是 monaco 的 string 档 ⇒ `「」` 在台词内照常自动闭合', async () => {
    const { toStandardTokenType } = await monacoInternal('languages/supports/tokenization.js');
    const { StandardAutoClosingPairConditional } = await monacoInternal('languages/languageConfiguration.js');
    expect(toStandardTokenType('sugar.speech')).toBe(0); // Other（既非 String 也非 Comment）
    const raw = (kojoConfig().autoClosingPairs ?? []).find(
      (p) => p.open === SPEECH[0] && p.close === SPEECH[1],
    ) as Pair & { notIn?: string[] };
    expect(raw.notIn, '本语言台词不叫 string ⇒ 写 notIn 一行都不生效，别照 JS 抄').toBeUndefined();
    const conditional = new StandardAutoClosingPairConditional(raw);
    expect(conditional.isOK(toStandardTokenType('sugar.speech'))).toBe(true);
    // `shouldAutoClose` 就是打字当拍问的那一句（scoped line tokens → standard token type）
    const context = { getTokenCount: () => 1, findTokenIndexAtOffset: () => 0, getStandardTokenType: () => 0 };
    expect(conditional.shouldAutoClose(context, 1)).toBe(true);
  });

  it('`autoCloseBefore` 不配：引号与括号各用 monaco 默认集，且默认集表达不了 CJK', async () => {
    const { CharacterPairSupport } = await monacoInternal('languages/supports/characterPair.js');
    const config = kojoConfig();
    expect(config.autoCloseBefore).toBeUndefined();
    const support = new CharacterPairSupport(config);
    const forQuotes = support.getAutoCloseBeforeSet(true);
    const forBrackets = support.getAutoCloseBeforeSet(false);
    // 两档默认集本就不同（括号档多收引号）⇒ 自造一串 `autoCloseBefore` 必然把另一档改坏
    expect(forBrackets).not.toBe(forQuotes);
    expect(forBrackets.includes('"')).toBe(true);
    expect(forQuotes.includes('"')).toBe(false);
    // 它是**字符集合**（`indexOf` 判成员）不是正则 ⇒ `「」` 与任何汉字都进不去：
    // "光标后是中文也要闭合"这一格在配置面上无处表达（要收只能动 monaco，不在本层）
    for (const ch of ['「', '」', '她', '：']) {
      expect(forBrackets.includes(ch), `${ch} 不在括号默认集（本格无法表达 CJK）`).toBe(false);
      expect(forQuotes.includes(ch)).toBe(false);
    }
  });

  it('中文台词里打 `"` 不成对、`=` 与空白后打 `"` 成对（monaco 引号判据 + 同源分隔表）', async () => {
    const { WordCharacterClassifier } = await monacoInternal('core/wordCharacterClassifier.js');
    const classifier = new WordCharacterClassifier(CJK_WORD_SEPARATORS, []);
    // `cursorTypeEditOperations` 在引号位问的就是这张表：光标前一字符判 Regular ⇒ 不闭合
    // （中文句里那枚 `"` 是标点，不该被配成串）
    expect(classifier.get('说'.charCodeAt(0))).toBe(0);
    // 而 `初回 "key"：` / `别名 X = "值"` 那两形前面是空白或运算符 ⇒ 照常成对
    expect(classifier.get('='.charCodeAt(0))).toBe(2);
    expect(classifier.get(' '.charCodeAt(0))).toBe(1);
  });
});

/* ============================ 二、注释格 ============================ */

describe('comments 格 = 词法真源', () => {
  it('只认 `;` 一行注释，糖词法也真认它；`//` 在转译器里不是注释 ⇒ 本格不许长第二形', () => {
    const config = kojoConfig();
    expect(config.comments).toEqual({ lineComment: ';' });
    expect(config.comments!.blockComment).toBeUndefined();
    expect(classifyLine(splitLogicalLines('; 说明')[0]!)).toEqual({ kind: 'comment' });
    expect(classifyLine(splitLogicalLines('// 说明')[0]!).kind).not.toBe('comment');
    // 同一枚 `;` 在两格里口径一致：既是注释符也是词分隔符
    expect(CJK_WORD_PATTERN.source).toContain(';');
  });
});

/* ============================ 三、wordPattern ============================ */

describe('wordPattern：中文整词与契约取词尺同档', () => {
  async function wordAt(column: number, text: string): Promise<Record<string, any> | null> {
    const { getWordAtText } = await monacoInternal('core/wordHelper.js');
    return getWordAtText(column, new RegExp(CJK_WORD_PATTERN.source, 'g'), text, 0);
  }

  it('双击落在中文段任意位置都取到整词（不是半截 ASCII 段）', async () => {
    expect(await wordAt(2, '她的眼泪')).toMatchObject({ word: '她的眼泪', startColumn: 1, endColumn: 5 });
    expect(await wordAt(4, '她的眼泪')).toMatchObject({ word: '她的眼泪' });
    expect(await wordAt(3, '「她的眼泪」')).toMatchObject({ word: '她的眼泪', startColumn: 2, endColumn: 6 });
    // 光标刚跟完整行 `她的眼泪：` 的块头冒号 ⇒ 该处无词 ⇒ `：` 显式触发通道照旧放行
    // （A3 的老判据，与 `cjk-typing.test.ts` 的 `你好：` 同形；列口径 = 行尾后一格）
    expect(await wordAt(4, '你好：')).toBeNull();
    expect(await wordAt(6, '她的眼泪：')).toBeNull();
  });

  it('与契约 `MODEL_TOKEN_CLASS` 的记号边界在同批串上一致', () => {
    const byWordPattern = (s: string) => s.match(new RegExp(CJK_WORD_PATTERN.source, 'g')) ?? [];
    const byContract = (s: string) => s.match(new RegExp(`${MODEL_TOKEN_CLASS}+`, 'gu')) ?? [];
    for (const s of ['她的眼泪', '如果她的眼泪', '好感度50', '她,眼泪', '她「眼」泪', 'A_B_1', 'CFLAG:ARG']) {
      expect(byWordPattern(s), s).toEqual(byContract(s));
    }
    // 已知边界（本批不收口、只锁现状）：全角 ASCII 镜像标点（＄ 等）在 `MODEL_TOKEN_CLASS` 里是
    // Po（非记号），而 `wordPattern` 是**排除式**字符类、标点表没列它 ⇒ 双击把 `＄名字` 连成一段。
    // 该让步的是 word-separators 那张标点表（补齐 U+FF01–FF65 全段），不是中文整词这条判据。
    expect(byWordPattern('＄名字')).toEqual(['＄名字']);
    expect(byContract('＄名字')).toEqual(['名字']);
  });
});

/* ============================ 四、缩进单位（Enter ⇄ formatter ⇄ 编辑器选项） ============================ */

describe('缩进单位与格式化器同一口径', () => {
  const leading = (s: string): string => /^[ \t\u3000]*/.exec(s)![0];

  it('空格档：格式化器归一出的一个单位 === 回车兜底层追加的单位 === 编辑器 tabSize', () => {
    const doc = ['角色: 12', '时机 X：', '    如果 A：', '        「一」', '  「二」'].join('\n');
    const edits = computeFormatEdits(doc, 'kojo');
    // 反恒真：唯一那条非规范缩进（2 空格，层级仍是 1）确实被重排了
    expect(edits.map((e) => e.line)).toEqual([5]);
    const formatterUnit = leading(edits[0]!.text);
    expect(formatterUnit).toBe(' '.repeat(formatterUnit.length));
    // 三处绑成一档：糖包格式化器 / 糖包回车层 / 宿主编辑器选项（谁都不许自养一个数字）
    expect(sugarEnterIndentAfter('时机 X：')).toBe(formatterUnit);
    const options = editorOptionsForLineCount(10);
    expect(options.tabSize).toBe(formatterUnit.length);
    // Monaco 的 Indent 动作按 `insertSpaces` 决定补空格还是补 TAB ⇒ 这一位关着 ⇒ 补 TAB，
    // TAB 档必须同样被格式化器当规范单位（下一条钉它）
    expect(options.insertSpaces).toBe(false);
  });

  it('TAB 档：制表符是格式化器认得的规范单位 ⇒ `insertSpaces:false` 的回车产物零改动', () => {
    const tabDoc = ['角色: 12', '时机 X：', '\t如果 A：', '\t\t「一」'].join('\n');
    expect(computeFormatEdits(tabDoc, 'kojo')).toEqual([]);
    expect(sugarEnterIndentAfter('\t时机 X：')).toBe('\t\t');
    // 2 空格不是规范单位（探测不出 ⇒ 整条归一规则关掉）⇒ 上面两条都不是空断言
    const looseDoc = ['角色: 12', '时机 X：', '  如果 A：', '    「一」', '  「二」'].join('\n');
    expect(computeFormatEdits(looseDoc, 'kojo').some((e) => leading(e.text).length === 2)).toBe(false);
  });

  it('onEnterRules 全为 Indent 动作，且每条 beforeText 都在 increaseIndentPattern 内（两格不许分叉）', () => {
    const config = kojoConfig();
    const rules = config.onEnterRules ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(6);
    const increase = config.indentationRules!.increaseIndentPattern;
    for (const rule of rules) {
      expect(rule.action.indentAction).toBe(1 /* Indent */);
      expect(increase.source, rule.beforeText.source).toContain(rule.beforeText.source);
    }
    // 收束靠 decreaseIndentPattern（段头与前一同级块头平级），不靠 Enter 上的 Outdent
    expect(rules.some((r) => r.action.indentAction === 3 /* Outdent */)).toBe(false);
    expect(increase.test('时机 指令 310：')).toBe(true);
    expect(config.indentationRules!.decreaseIndentPattern.test('        否则：')).toBe(true);
    // 本批新收的 `[条件]` 标签行不该被回车层多缩一级
    expect(increase.test('    [她的好感度 >= 500]')).toBe(false);
  });
});
