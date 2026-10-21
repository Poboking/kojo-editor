/**
 * ERB-ENTER-RULES · `.erb` 回车层级（行首空白断言）。
 *
 * ## 判的是行为，不是快照
 *
 * 三条形态（`@` 续行 / `SELECTCASE`·`CASE` 块内换行 / 注释行）一律断言**按键后新行的行首
 * 空白**，且算式走 monaco-editor 同版本的三件真家伙：
 * - `languages/supports/onEnter.js::OnEnterSupport` —— `onEnterRules` 与括号档的真实消费者；
 * - `languages/supports/indentRules.js::IndentRulesSupport` —— `indentationRules` 四格的真实消费者；
 * - `commands/shiftCommand.js::ShiftCommand.shiftIndent/unshiftIndent` —— 抬/退一级的真实算法
 *   （`tabSize:4` + `insertSpaces:false` ⇒ 一个单位一枚 TAB，与 `editor-options.ts` 的档位表同源）。
 *
 * 装配口径抄 `cursorTypeEditOperations.js::EnterOperation._enter`（autoIndent 缺省 `full`）：
 * ① 先问 `onEnterRules`（命中即 `indentation + appendText`）；② 没命中且没有括号可判 ⇒ 走
 * `autoIndent.js::getIndentForEnter` 的**继承**通道（跳过空行与 `unIndentedLinePattern`
 * 命中的行，找最近一条算数的代码行，按其 increase / indentNextLine / decrease 折一级）。
 * 唯一的简化：不重放 `IndentationLineProcessor` 的"串与注释里摘掉语言括号"那一步——本文件
 * 四条判据**全部锚在行首**（`^\s*词形` / `^\s*;`），摘不摘行中间的括号都不改变行首匹配结果。
 *
 * ## 反向自证（这批的"钉的是行为"证据）
 *
 * {@link emptyConfig} 把 `.erb` 的两件套撤掉（= 本批之前的语言配置）后跑同一批断言：
 * 至少三条必须红（下面 `撤规则必红` 那一组逐条点名）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { classifyControlFlow, ERB_CONTROL_STATEMENTS } from '@kojo/plugin-erb-parser';
import { sugarEnterRulePatterns } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../src/monaco/erb-language';
import { ERB_LINE_COMMENT, erbEnterRulePatterns, erbEnterVocabulary } from '../src/monaco/erb-enter';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from '../src/monaco/kojo-language';
import { languageDescriptors } from '../src/monaco/language-registry';
import '../src/monaco/languages'; // descriptor 表在模块顶层登记（宿主真实装配同一入口）
import { stubMonaco } from './monarch-harness';

type Config = Monaco.languages.LanguageConfiguration;

/** monaco 深层 common 模块无 subpath 类型 ⇒ 变量路径动态 import（`kojo-language-config` 同款手法） */
async function monacoInternal(sub: string): Promise<Record<string, any>> {
  return import(/* @vite-ignore */ `monaco-editor/editor/common/${sub}`);
}

/** Monaco 的行首空白口径：只有空格与 TAB 算缩进字符（`base/common/strings::getLeadingWhitespace` 同式） */
const leadingWhitespace = (line: string): string => /^[ \t]*/.exec(line)![0]!;

const INDENT_OPTS = { tabSize: 4, indentSize: 4, insertSpaces: false } as const;

/**
 * 一次回车的行为仿真（`cursorTypeEditOperations::EnterOperation._enter` 的等价复刻）。
 * 入参 = 文档各行 + 光标所在行（0 基，光标压行尾），返回**新行的行首空白**。
 */
async function pressEnter(config: Config, lines: readonly string[], at: number): Promise<string> {
  const { OnEnterSupport } = await monacoInternal('languages/supports/onEnter.js');
  const { IndentRulesSupport } = await monacoInternal('languages/supports/indentRules.js');
  const { ShiftCommand } = await monacoInternal('commands/shiftCommand.js');
  const shift = (indent: string): string =>
    ShiftCommand.shiftIndent(indent, indent.length + 1, INDENT_OPTS.tabSize, INDENT_OPTS.indentSize, INDENT_OPTS.insertSpaces);
  const unshift = (indent: string): string =>
    ShiftCommand.unshiftIndent(indent, indent.length + 1, INDENT_OPTS.tabSize, INDENT_OPTS.indentSize, INDENT_OPTS.insertSpaces);

  const current = lines[at] ?? '';
  // ① onEnterRules（+ 括号档）——autoIndent=full(4)，previousLineText 给到 ①②（本批没有用它的规则）
  const enter = new OnEnterSupport(config).onEnter(4, lines[at - 1] ?? '', current, '');
  if (enter) {
    const ind = leadingWhitespace(current);
    if (enter.indentAction === 1 /* Indent */ || enter.indentAction === 2 /* IndentOutdent */) return `${ind}\t`;
    if (enter.indentAction === 3 /* Outdent */) return unshift(ind);
    return ind;
  }
  // ② 没有规则可判 ⇒ indentationRules 的继承通道
  const rules = config.indentationRules;
  if (!rules) return leadingWhitespace(current); // 今天 `.erb` 的状态：两件套都不存在 ⇒ Monaco 原样 keep
  const ind = new IndentRulesSupport(rules);
  const newLineNo = at + 2; // 1 基的新行号
  if (newLineNo <= 1) return '';
  // getInheritIndentForLine 的前置闸：上面全是**空串**行且一路数到第 1 行 ⇒ 新行顶格
  for (let p = newLineNo - 1; p > 0; p--) {
    if ((lines[p - 1] ?? '') !== '') break;
    if (p === 1) return '';
  }
  // getPrecedingValidLine：跳过空行与 unIndentedLinePattern 命中的行；一条都不剩 ⇒ -1（不动缩进）
  let preceding = -1;
  for (let n = newLineNo - 1; n >= 1; n--) {
    const text = lines[n - 1] ?? '';
    if (ind.shouldIgnore(text) || /^\s+$/.test(text) || text === '') continue;
    preceding = n;
    break;
  }
  if (preceding < 1) return leadingWhitespace(current);
  const src = lines[preceding - 1] ?? '';
  const srcIndent = leadingWhitespace(src);
  // 只有"抬下一行"那一支会加一级；收束形与其它形都停在来源行自己的缩进上
  // （`honorIntentialIndent` 缺省为真，与 monaco 同判）
  const indentation =
    ind.shouldIncrease(src) || ind.shouldIndentNextLine(src) ? shift(srcIndent) : srcIndent;
  if (ind.shouldDecrease('')) return unshift(indentation); // 新行此刻是空行 ⇒ 恒不成立（与 monaco 同判）
  return indentation;
}

/** 真装配出来的 `.erb` 语言配置（注册函数只吃桩，桩把那份配置原样交回） */
function erbConfig(): Config {
  const { monaco, captured } = stubMonaco();
  registerErbLanguage(monaco);
  const entry = captured.configs.find((c) => (c as { id: string }).id === ERB_LANGUAGE_ID) as { config: Config };
  if (!entry) throw new Error('没捕获到 `.erb` 的语言配置（装配面漂了）');
  return entry.config;
}

function kojoConfig(): Config {
  const { monaco, captured } = stubMonaco();
  registerKojoLanguage(monaco);
  const entry = captured.configs.find((c) => (c as { id: string }).id === KOJO_LANGUAGE_ID) as { config: Config };
  if (!entry) throw new Error('没捕获到 `.kojo` 的语言配置');
  return entry.config;
}

/** 撤规则形态：两件套清零 = 本批之前的 `.erb` 配置（反向自证用，不改生产代码） */
const stripEnterRules = (config: Config): Config => ({ ...config, onEnterRules: undefined, indentationRules: undefined });

const CONFIG = erbConfig();
const PATTERNS = erbEnterRulePatterns();

/* ============================ 一、装配面 ============================ */

describe('`.erb` 语言配置：两件套已装配（与 `.kojo` 同格）', () => {
  it('onEnterRules 齐备且全为 Indent；indentationRules 四格里 ERB 用满四格', () => {
    const rules = CONFIG.onEnterRules ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(2); // 开块 / 分支两族各一条（单行形只走 indentNextLinePattern）
    for (const r of rules) {
      expect(r.beforeText).toBeInstanceOf(RegExp);
      expect(r.action.indentAction).toBe(1 /* Indent */);
      // 两格不分叉：每条 beforeText 的源码都含于 increaseIndentPattern（与 `.kojo` 同一条守卫）
      expect(CONFIG.indentationRules!.increaseIndentPattern.source).toContain(r.beforeText.source);
    }
    expect(CONFIG.indentationRules!.increaseIndentPattern).toBeInstanceOf(RegExp);
    expect(CONFIG.indentationRules!.decreaseIndentPattern).toBeInstanceOf(RegExp);
    expect(CONFIG.indentationRules!.indentNextLinePattern).toBeInstanceOf(RegExp);
    expect(CONFIG.indentationRules!.unIndentedLinePattern).toBeInstanceOf(RegExp);
  });

  it('既有配置格零回退：注释符 / 括号 / wordPattern / 自动闭合与包裹三格原样在', () => {
    expect(CONFIG.comments).toEqual({ lineComment: ERB_LINE_COMMENT });
    expect(CONFIG.brackets).toEqual([
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]);
    expect(CONFIG.wordPattern).toBeTruthy();
    expect((CONFIG.autoClosingPairs ?? []).length).toBe(4);
    expect((CONFIG.surroundingPairs ?? []).length).toBe(4);
  });

  it('每条 `onEnterRules` 都是大小写不敏感（Emuera 引擎事实，与 Monarch 的 ignoreCase 同调）', () => {
    for (const r of CONFIG.onEnterRules ?? []) expect(r.beforeText.flags).toContain('i');
    expect(CONFIG.indentationRules!.increaseIndentPattern.flags).toContain('i');
  });
});

/* ============================ 二、词表单源（零抄本） ============================ */

describe('`.erb` 回车词表 = 引擎配对表的角色投影（零手抄词形）', () => {
  it('配对表逐词有档，档位与 `classifyControlFlow` 逐字一致', () => {
    const vocab = erbEnterVocabulary();
    const open = vocab.open;
    const branch = vocab.branch;
    const close = vocab.close;
    const leaf = vocab.indentNextLine ?? [];
    const buckets: readonly (readonly [string, readonly string[]])[] = [
      ['open', open],
      ['branch', branch],
      ['close', close],
      ['leaf', leaf],
    ];
    for (const [role, words] of buckets) {
      for (const w of words) expect(classifyControlFlow(w)?.role, `${w} 的档位漂了`).toBe(role);
    }
    // 恒等式：四桶并集 = `ERB_CONTROL_STATEMENTS` 全集，一枚不多一枚不少（配对表增词自动跟随）
    const union = [...open, ...branch, ...close, ...leaf].map((w) => w.toUpperCase()).sort();
    expect(union).toEqual([...ERB_CONTROL_STATEMENTS].map((w) => w.toUpperCase()).sort());
    expect(new Set(union).size).toBe(union.length); // 一词一档
    expect(open.length).toBeGreaterThanOrEqual(15);
    expect(close.length).toBeGreaterThanOrEqual(10);
  });

  it('宿主 ERB 回车模块零指令抄本（词形只能从配对表来，与 erb-directive-words 同一口径）', () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'monaco', 'erb-enter.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const quoted = [...src.matchAll(/(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2]!);
    const words = new Set(ERB_CONTROL_STATEMENTS.map((w) => w.toUpperCase()));
    expect(quoted.filter((w) => words.has(w.toUpperCase()))).toEqual([]);
  });

  it('词表分档 → 正则族的去向：开块∪分支抬行、闭合∪分支收束、单行只抬下一行、注释不参与继承', () => {
    const vocab = erbEnterVocabulary();
    for (const w of [...vocab.open, ...vocab.branch]) {
      expect(PATTERNS.increaseIndentPattern.test(`${w} ARG`), w).toBe(true);
    }
    for (const w of [...vocab.close, ...vocab.branch]) {
      expect(PATTERNS.decreaseIndentPattern.test(`\t${w}`), w).toBe(true);
    }
    for (const w of vocab.indentNextLine ?? []) {
      expect(PATTERNS.indentNextLinePattern!.test(`\t${w} A = 1`), w).toBe(true);
      expect(PATTERNS.increaseIndentPattern.test(`\t${w} A = 1`), `${w} 不该进 increase（它是单行形）`).toBe(false);
      expect(PATTERNS.decreaseIndentPattern.test(`\t${w} A = 1`), w).toBe(false);
    }
    expect(PATTERNS.unIndentedLinePattern!.test(';说明')).toBe(true);
    expect(PATTERNS.unIndentedLinePattern!.test('\t\t; 缩进后的说明')).toBe(true);
    expect(PATTERNS.unIndentedLinePattern!.test('PRINTL "a;b"')).toBe(false);
  });

  it('取词口径与配对扫描器逐行一致：词有档 ⇒ 对应规则必命中，无档 ⇒ 四格全不命中', () => {
    // `erb-parser/scanner.ts::controlFlowToken` 取的是行首第一段 `[A-Za-z_]+`（数字不进词），
    // 回车层的四条判据必须按同一把尺子判——否则"结构体检认它是 ENDIF、回车层不认"就是两处真相。
    const fixtures = [
      'SELECTCASE ARG',
      '\tCASE 0',
      '\t\tCASEELSE',
      'ENDIF',
      'ENDSELECT',
      'SIF A = 1',
      '\t\tIF MONEY < ARG',
      'REPEAT',
      'PRINTL "IF 说明"',
      'CALL KOJO_SETTING',
      '@IN_ROOM_MEMBER, ARGS',
      '#DIM LOCAL, 10',
      '$LABEL_A',
      ';说明顶到列 0',
      'IF2 A = 1',
    ];
    const next = PATTERNS.indentNextLinePattern!;
    const unind = PATTERNS.unIndentedLinePattern!;
    for (const line of fixtures) {
      const word = /^[ \t\u3000]*([A-Za-z_]+)/.exec(line)?.[1]?.toUpperCase();
      const role = word === undefined ? undefined : classifyControlFlow(word)?.role;
      expect(PATTERNS.increaseIndentPattern.test(line), `${line} increase`).toBe(
        role === 'open' || role === 'branch',
      );
      expect(PATTERNS.decreaseIndentPattern.test(line), `${line} decrease`).toBe(
        role === 'close' || role === 'branch',
      );
      expect(next.test(line), `${line} indentNextLine`).toBe(role === 'leaf');
      expect(unind.test(line), `${line} unIndented`).toBe(line.trimStart().startsWith(ERB_LINE_COMMENT));
    }
  });

  it(`行注释记号只有一份：\`comments\` 格与 unIndentedLinePattern 同源`, () => {
    expect(CONFIG.comments!.lineComment).toBe(ERB_LINE_COMMENT);
    expect(CONFIG.indentationRules!.unIndentedLinePattern!.source).toContain(ERB_LINE_COMMENT);
  });

  it('`@` / `#` / `$` 开头的行不进任何一档（函数边界与续行不是块语句）', () => {
    for (const line of [
      '@IN_ROOM_MEMBER, ARGS, ARG',
      '@CALL_FUNC(ARG:1)',
      '        @"给%CALLNAME:TARGET%使用避孕套（剩余{ITEM:45}枚）",ITEM:45,',
      '#DIM LOCAL, 10',
      '$LABEL_A',
    ]) {
      for (const [格, re] of [
        ['increase', PATTERNS.increaseIndentPattern],
        ['decrease', PATTERNS.decreaseIndentPattern],
        ['indentNextLine', PATTERNS.indentNextLinePattern!],
        ['unIndented', PATTERNS.unIndentedLinePattern!],
      ] as const) {
        expect(re.test(line), `${line} 命中了 ${格}`).toBe(false);
      }
    }
  });
});

/* ============================ 三、行为：按键后的行首空白 ============================ */

describe('行为断言 · SELECTCASE / CASE 块内换行', () => {
  it('块头行回车 ⇒ 新行比块头深一级（CASE 落进 SELECTCASE 那一格）', async () => {
    expect(await pressEnter(CONFIG, ['SELECTCASE RESULT'], 0)).toBe('\t');
    expect(await pressEnter(CONFIG, ['\tCASE 0'], 0)).toBe('\t\t');
    expect(await pressEnter(CONFIG, ['\t\tIF MONEY < ARG'], 0)).toBe('\t\t\t');
    expect(await pressEnter(CONFIG, ['REPEAT'], 0)).toBe('\t');
  });

  it('块头行尾带行内 `;` 说明照常抬一级（判据锚在行首，注释挡不住）', async () => {
    expect(await pressEnter(CONFIG, ['SELECTCASE ARG ;选择器'], 0)).toBe('\t');
  });

  it('语料块体逐行回车 ⇒ 每过一条块语句深一级，普通语句行停在原位（与 `COMMON.ERB` 105-112 同形）', async () => {
    const doc = ['SELECTCASE RESULT', '\tCASE 1', '\t\tIF MONEY < ARG', '\t\t\tPRINTFORMW 金钱不足'];
    // 三条块语句各抬一级；第四条是普通语句行 ⇒ 继承回自己的层级（keep），不叠加
    const want = ['\t', '\t\t', '\t\t\t', '\t\t\t'];
    for (let i = 0; i < doc.length; i++) {
      expect(await pressEnter(CONFIG, doc.slice(0, i + 1), i), doc[i]).toBe(want[i]);
    }
    // `ENDIF` 之后的一行与 `ENDIF` 平级（块体还在同一层继续写）
    expect(await pressEnter(CONFIG, ['\t\tIF A', '\t\t\tPRINTL x', '\t\tENDIF'], 2)).toBe('\t\t');
    // 分支兄弟行不叠加：CASE 之后回车抬一级，正文写完再回车仍停在原位
    expect(await pressEnter(CONFIG, ['SELECTCASE ARG', '\tCASE 495', '\t\tRETURNF 1'], 2)).toBe('\t\t');
  });

  it('单行条件 `SIF` 只抬下一行（配对表的 leaf 档，没有闭合语句）', async () => {
    const doc = ['\t\tFOR LOCAL, 1, CHARANUM', '\t\t\tSIF CFLAG:LOCAL:現在位置 != ARG'];
    expect(await pressEnter(CONFIG, doc, 1)).toBe('\t\t\t\t');
    // 第二行起不再叠加（`indentNextLinePattern` 的语义就是"只抬下一行"）
    expect(await pressEnter(CONFIG, [...doc, '\t\t\t\tCONTINUE'], 2)).toBe('\t\t\t\t');
  });
});

describe('行为断言 · 注释行内换行', () => {
  it('列 0 的分隔注释不把后续行拖到列 0：继承回到最近一条代码行的层级', async () => {
    const doc = ['SELECTCASE ARG', '\tCASE 0', ';---- 分隔注释顶到列 0'];
    expect(await pressEnter(CONFIG, doc, 2)).toBe('\t\t');
  });

  it('缩进正常的注释行回车 ⇒ 停在原位（注释既不抬也不退）', async () => {
    expect(await pressEnter(CONFIG, ['\t\tIF A', '\t\t\t;说明'], 1)).toBe('\t\t\t');
    expect(await pressEnter(CONFIG, ['\t\tENDIF', '\t\t;说明'], 1)).toBe('\t\t');
  });
});

describe('行为断言 · `@` 续行与函数边界', () => {
  it('跨行 CALL 的 `@"…"` 续行：兄弟续行与它对齐，不塌到列 0、也不叠加', async () => {
    const doc = ['\tCALL KOJO_SETTING(', '\t\tARG, nSlotTake, "性经历",', '\t\t@"开启剧透模式", 1,'];
    expect(await pressEnter(CONFIG, doc, 2)).toBe('\t\t');
  });

  it('`@` 函数定义行 = 块状态归零：函数体顶格书写（上一函数残留的块级不渗进来）', async () => {
    const doc = ['SELECTCASE ARG', '\tCASE 0', '@NEXT_FUNC'];
    expect(await pressEnter(CONFIG, doc, 2)).toBe('');
    expect(await pressEnter(CONFIG, ['@AEGI_口上(ARG:1)'], 0)).toBe('');
  });
});

/* ============================ 四、反向自证：撤掉两件套必红 ============================ */

describe('撤规则必红（钉的是行为，不是快照）', () => {
  it('撤掉 `.erb` 两件套 ⇒ 这四形全部退回列 0 / 原位（= 本批之前作者看到的手感）', async () => {
    const bare = stripEnterRules(CONFIG);
    const reds: string[] = [];
    const checks: readonly (readonly [string, readonly string[], number, string])[] = [
      ['SELECTCASE 块头回车 +1', ['SELECTCASE RESULT'], 0, '\t'],
      ['CASE 分支回车 +1', ['\tCASE 0'], 0, '\t\t'],
      ['列 0 注释仍回到块内层级', ['SELECTCASE ARG', '\tCASE 0', ';分隔注释'], 2, '\t\t'],
      ['SIF 单行形只抬下一行', ['\t\tFOR LOCAL, 1, CHARANUM', '\t\t\tSIF CFLAG:LOCAL:現在位置 != ARG'], 1, '\t\t\t\t'],
    ];
    for (const [名, doc, at, want] of checks) {
      const got = await pressEnter(bare, doc, at);
      if (got !== want) reds.push(名);
    }
    expect(reds.length).toBeGreaterThanOrEqual(3);
    expect(reds).toEqual(checks.map(([名]) => 名)); // 四条全撤才叫"这条线真在管行为"
  });

  it('撤掉之后守卫形仍成立（`@` 续行与闭合行之后本来就靠 keep，两件套不该改它们）', async () => {
    const bare = stripEnterRules(CONFIG);
    expect(await pressEnter(bare, ['\tCALL KOJO_SETTING(', '\t\t@"文本", 1,'], 1)).toBe('\t\t');
    expect(await pressEnter(bare, ['\t\tIF A', '\t\t\tPRINTL x', '\t\tENDIF'], 2)).toBe('\t\t');
  });
});

/* ============================ 五、descriptor 口径与 `.kojo` 零改动 ============================ */

describe('ERB-PARITY：回车能力按 descriptor 选，两门一等语言同格', () => {
  it('每一门声明 `languageServices` 的语言都拿到两件套；未声明的（JSON）一格都不多', () => {
    const firstClass = languageDescriptors().filter((d) => d.languageServices === true);
    expect(firstClass.map((d) => d.id).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    for (const descriptor of firstClass) {
      const { monaco, captured } = stubMonaco();
      descriptor.register(monaco);
      const entry = captured.configs.find((c) => (c as { id: string }).id === descriptor.id) as
        | { config: Config }
        | undefined;
      expect(entry, `${descriptor.label} 没注册语言配置`).toBeTruthy();
      const config = entry!.config;
      expect((config.onEnterRules ?? []).length, `${descriptor.label} 的 onEnterRules 空`).toBeGreaterThan(0);
      expect(config.indentationRules!.increaseIndentPattern).toBeInstanceOf(RegExp);
      expect(config.indentationRules!.decreaseIndentPattern).toBeInstanceOf(RegExp);
    }
    const json = languageDescriptors().find((d) => d.languageServices !== true)!;
    const { monaco, captured } = stubMonaco();
    json.register(monaco);
    const entry = captured.configs.find((c) => (c as { id: string }).id === json.id) as
      | { config: Config }
      | undefined;
    expect(entry === undefined || entry.config.onEnterRules === undefined).toBe(true);
  });

  it('`.kojo` 的产物逐字不变：两格之外不多写、六条全 Indent、无 Outdent', () => {
    const config = kojoConfig();
    expect(Object.keys(config.indentationRules!).sort()).toEqual(['decreaseIndentPattern', 'increaseIndentPattern']);
    expect(config.indentationRules!.unIndentedLinePattern).toBeUndefined();
    expect(config.indentationRules!.indentNextLinePattern).toBeUndefined();
    const rules = config.onEnterRules ?? [];
    expect(rules.length).toBe(sugarEnterRulePatterns().indentOnEnter.length);
    expect(rules.map((r) => r.beforeText.source)).toEqual(sugarEnterRulePatterns().indentOnEnter.map((r) => r.source));
    for (const r of rules) expect(r.action.indentAction).toBe(1 /* Indent */);
    expect(rules.some((r) => r.action.indentAction === 3 /* Outdent */)).toBe(false);
  });

  it('两门语言过同一道翻译层：`.erb` 与 `.kojo` 的 onEnterRules 动作口径一致（不各写一份装配）', () => {
    const kojo = kojoConfig().onEnterRules ?? [];
    const erb = CONFIG.onEnterRules ?? [];
    expect(new Set(erb.map((r) => r.action.indentAction))).toEqual(new Set([1]));
    expect(new Set(kojo.map((r) => r.action.indentAction))).toEqual(new Set([1]));
    expect(erb.length).toBeGreaterThanOrEqual(2);
  });
});
