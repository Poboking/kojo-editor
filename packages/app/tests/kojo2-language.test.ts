/**
 * `kojo2` Monaco 语言面（U6）的行为闸：**真编译器 + 根状态驱动**逐档断言。
 *
 * 驱动基座用仓里既有的 `tests/monarch-harness.ts`（与 `kojo-token-tiers` / `erb-highlight`
 * 同一条路）：语言定义交给 monaco-editor 同版本的 `compile()`，再把编译产物喂给复刻
 * `monarchLexer._myTokenize` 语义的驱动器 ⇒ 这里断言的 token 名就是屏上真发的 token。
 *
 * 覆盖面（对应 U6 验收）：
 * - 五锚点 / 声明词 / 保留词 / 台词（说话人 + 全角冒号 + 「」）/ 旁白 / 插值 / 提示 / 注释；
 * - `@原生` 缩进围栏：体内 `#`/`?`/`>` 一律 `kojo2.raw`，去缩进回根；
 * - 未闭合台词只到行尾（下一行不再进台词态）；
 * - CRLF 与代理对列的坐标；`# 表` 两列行；
 * - 语言配置（comments / wordPattern / 成对记号 / 回车层级）、档位与配色。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { compileMonarch, driveLine, driveLines, stubMonaco, type CompiledLexer } from './monarch-harness';
import { CJK_WORD_PATTERN } from '../src/monaco/word-separators';
import { KOJO_DARK_COLORS } from '../src/monaco/theme';
import { KOJO_TOKEN_TIERS } from '../src/monaco/kojo-language';
import {
  KOJO2_LANGUAGE_ID,
  KOJO2_SOURCE_EXTENSION,
  KOJO2_THEME_RULES,
  KOJO2_TOKEN,
  KOJO2_TOKEN_TIERS,
  registerKojo2Language,
} from '../src/monaco/kojo2-language';

/* ============================== 装配（真注册 + 真编译） ============================== */

interface CapturedConfig {
  readonly id: string;
  readonly config: {
    comments?: { lineComment?: string; blockComment?: string };
    wordPattern?: RegExp;
    brackets?: [string, string][];
    autoClosingPairs?: { open: string; close: string }[];
    surroundingPairs?: { open: string; close: string }[];
    onEnterRules?: { beforeText: RegExp; action: { indentAction: number } }[];
    indentationRules?: { increaseIndentPattern?: RegExp; decreaseIndentPattern?: RegExp };
  };
}

const { monaco, captured } = stubMonaco();
registerKojo2Language(monaco);
const configCaptured = captured.configs.find(
  (c) => (c as CapturedConfig).id === KOJO2_LANGUAGE_ID,
) as CapturedConfig | undefined;

let lexer!: CompiledLexer;

beforeAll(async () => {
  const def = captured.monarchs.get(KOJO2_LANGUAGE_ID);
  expect(def, '注册语言面时没有交 Monarch 定义').toBeTruthy();
  lexer = await compileMonarch(KOJO2_LANGUAGE_ID, def!);
}, 120_000);

/* ============================== 驱动器小工具 ============================== */

function bare(token: string): string {
  const postfix = lexer.tokenPostfix;
  return postfix !== '' && token.endsWith(postfix) ? token.slice(0, -postfix.length) : token;
}

interface Emit {
  readonly text: string;
  readonly token: string;
}

function lexLine(line: string): { emitted: Emit[]; stack: readonly string[] } {
  const driven = driveLine(lexer, line);
  return {
    // 零宽 token（围栏回根的占位）没有屏上效果，断言里一律丢掉
    emitted: driven.emitted
      .filter((e) => e.text.length > 0)
      .map((e) => ({ text: e.text, token: bare(e.token) })),
    stack: driven.stack,
  };
}

function tokensOf(line: string): Emit[] {
  return lexLine(line).emitted;
}

function tokensOfLines(lines: readonly string[]): Emit[][] {
  return driveLines(lexer, lines).map((emits) =>
    emits.filter((e) => e.text.length > 0).map((e) => ({ text: e.text, token: bare(e.token) })),
  );
}

function ofToken(emits: readonly Emit[], token: string): string[] {
  return emits.filter((e) => e.token === token).map((e) => e.text);
}

/** 一行跑完必须回到根状态（防"跨行状态泄漏"——未闭合台词/围栏最容易在这一层出假绿）。 */
function expectRootAfter(line: string): Emit[] {
  const { emitted, stack } = lexLine(line);
  expect(stack, `行跑完没有回根状态：${line}`).toHaveLength(1);
  return emitted;
}

/* ============================== 五锚点与声明词 ============================== */

describe('五锚点：每行的第一眼是锚点', () => {
  it.each([
    ['# 变量 临时 整数', '#'],
    ['@算', '@'],
    ['> 晨光透过鸟居。', '>'],
    ['? 恋慕 >= 500', '?'],
    ['! 早安问候', '!'],
  ])('%s → 首 token 是 kojo2.anchor', (line) => {
    const emitted = expectRootAfter(line);
    expect(emitted[0]?.token).toBe(KOJO2_TOKEN.anchor);
    expect(emitted[0]?.text.trimStart().startsWith(line.trimStart()[0]!)).toBe(true);
  });

  it('声明词 / 调度词各自一档，未知词不上声明色', () => {
    expect(ofToken(tokensOf('# 变量 临时 整数'), KOJO2_TOKEN.declaration)).toEqual(['变量']);
    expect(ofToken(tokensOf('# 表 心情 由 恋慕'), KOJO2_TOKEN.declaration)).toEqual(['表']);
    expect(ofToken(tokensOf('@算'), KOJO2_TOKEN.declaration)).toEqual(['算']);
    expect(ofToken(tokensOf('@着色 0xFF8080'), KOJO2_TOKEN.declaration)).toEqual(['着色']);
    expect(ofToken(tokensOf('! 早安问候'), KOJO2_TOKEN.declaration)).toEqual(['早安问候']);
    // 未知声明词/调度词不冒充已知词（保持未着色，交给 core 诊断）
    expect(ofToken(tokensOf('# 未知声明 x'), KOJO2_TOKEN.declaration)).toEqual([]);
    expect(ofToken(tokensOf('@未知调度'), KOJO2_TOKEN.declaration)).toEqual([]);
  });

  it('行首 `\\` 是字面文本行，不是旁白', () => {
    const emitted = tokensOf('\\> 这不是旁白。');
    expect(emitted[0]?.token).toBe(KOJO2_TOKEN.anchor);
    expect(emitted.some((e) => e.token === KOJO2_TOKEN.narration)).toBe(true);
  });
});

/* ============================== 保留词 / 数字 / 运算符 ============================== */

describe('保留词、数字与中文运算符', () => {
  it('`? 否` / `由` / 类型词 / 存储期词 / 织入修饰词各归各档（类型词自 2026-10-27 第三色批起独立一档）', () => {
    expect(ofToken(tokensOf('? 否'), KOJO2_TOKEN.keyword)).toEqual(['否']);
    expect(ofToken(tokensOf('# 表 心情 由 恋慕'), KOJO2_TOKEN.keyword)).toEqual(['由']);
    const decl = tokensOf('# 变量 今天已触发 整数 = 0 存档');
    // 类型词从"保留词"里拆出来：`整数` 说的是**这一列存什么**，`存档` 说的是**它活多久**，
    // 两件事挤一枚色就是把第三色档白白省掉了。判据两侧都留：type 里恰是类型词，
    // keyword 里仍是存储期词（少一格 = 拆档拆丢了，多一格 = 卫兵序错了）。
    expect(ofToken(decl, KOJO2_TOKEN.type)).toEqual(['整数']);
    expect(ofToken(decl, KOJO2_TOKEN.keyword)).toEqual(['存档']);
    expect(ofToken(tokensOf('# 变量 心情快照 字符串'), KOJO2_TOKEN.type)).toEqual(['字符串']);
    expect(ofToken(tokensOf('@织 回合末 之后'), KOJO2_TOKEN.keyword)).toEqual(['之后']);
    expect(ofToken(tokensOf('空行 等待'), KOJO2_TOKEN.keyword)).toEqual(['空行', '等待']);
  });

  it('数字 / 十六进制 / 运算符各发应得档位（中文运算符词与符号同档）', () => {
    expect(ofToken(tokensOf('? 恋慕 >= 500'), KOJO2_TOKEN.number)).toEqual(['500']);
    expect(ofToken(tokensOf('@着色 0xFF8080'), KOJO2_TOKEN.hex)).toEqual(['0xFF8080']);
    expect(ofToken(tokensOf('? 恋慕 >= 500'), KOJO2_TOKEN.operator)).toContain('>=');
    // 中文运算符词（来自糖聚合的运算符表，不是本文件手抄）
    expect(ofToken(tokensOf('? 恋慕 不等于 0'), KOJO2_TOKEN.operator)).toContain('不等于');
    expect(ofToken(tokensOf('? 恋慕 不在 0 到 100'), KOJO2_TOKEN.operator)).toContain('不在');
  });
});

/* ============================== 台词 / 旁白 / 插值 / 提示 ============================== */

describe('台词：说话人 + 全角冒号 + 「」 + 插值 + 行尾提示', () => {
  it('中文说话人、引号、台词正文、行内插值、行尾提示各归各档', () => {
    const line = '小鳥：「{你}今天来得挺早嘛。」(微笑)';
    const emitted = expectRootAfter(line);
    expect(ofToken(emitted, KOJO2_TOKEN.speaker)).toEqual(['小鳥：']);
    expect(ofToken(emitted, KOJO2_TOKEN.interp)).toEqual(['{你}']);
    expect(ofToken(emitted, KOJO2_TOKEN.speech)).toEqual(['今天来得挺早嘛。']);
    expect(ofToken(emitted, KOJO2_TOKEN.hint)).toEqual(['(微笑)']);
    // 引号是结构性标点档
    expect(ofToken(emitted, KOJO2_TOKEN.delimiter)).toEqual(['「', '」']);
    // 整行字符一个不丢（token 首尾相接，坐标可回推）
    expect(emitted.map((e) => e.text).join('')).toBe(line);
  });

  it('条件插值 `{条件 ? A : B}` 整格一档（只扫描不拆表达式）', () => {
    const line = '灵梦：「{恋慕 >= 亲近线 ? "A" : "B"}」';
    const emitted = tokensOf(line);
    expect(ofToken(emitted, KOJO2_TOKEN.interp)).toEqual(['{恋慕 >= 亲近线 ? "A" : "B"}']);
    expect(emitted.map((e) => e.text).join('')).toBe(line);
  });

  it('行尾 `续` 是保留词档（台词与旁白都认；正文里的 `续` 仍是正文）', () => {
    const speech = tokensOf('灵梦：「……我一直在等你。」 续');
    expect(speech.some((e) => e.token === KOJO2_TOKEN.keyword && e.text.trim() === '续')).toBe(true);
    const narration = tokensOf('> 她别过头。 续');
    expect(narration.some((e) => e.token === KOJO2_TOKEN.keyword && e.text.trim() === '续')).toBe(true);
    // `「续` 是未闭合台词的正文，不是行尾等待标记
    expect(ofToken(tokensOf('灵梦：「续'), KOJO2_TOKEN.keyword)).toEqual([]);
  });

  it('未闭合台词只到行尾：下一行从根状态重新分派', () => {
    const rows = tokensOfLines(['灵梦：「没有右引号', '> 正常旁白']);
    const first = rows[0]!;
    const second = rows[1]!;
    expect(first.some((e) => e.token === KOJO2_TOKEN.speech)).toBe(true);
    expect(second[0]?.token).toBe(KOJO2_TOKEN.anchor);
    expect(ofToken(second, KOJO2_TOKEN.narration)).toEqual(['正常旁白']);
    expect(ofToken(second, KOJO2_TOKEN.speech), '残句把下一行拖进台词脸').toEqual([]);
  });
});

describe('旁白 / 注释', () => {
  it('`> ` 之后整段是旁白；半角 `(…)` 是提示，全角 `（……）` 是正文', () => {
    const line = '> 她别过头，耳尖红了。（叹气）(别过头)';
    const emitted = expectRootAfter(line);
    expect(ofToken(emitted, KOJO2_TOKEN.anchor)).toEqual(['> ']);
    expect(ofToken(emitted, KOJO2_TOKEN.narration)).toEqual(['她别过头，耳尖红了。（叹气）']);
    expect(ofToken(emitted, KOJO2_TOKEN.hint)).toEqual(['(别过头)']);
  });

  it('整行 `//` 注释：缩进一并入注释档；行内 `//` 不是注释（2.0 无行尾注释）', () => {
    expect(tokensOf('  // 说明')).toEqual([{ text: '  // 说明', token: KOJO2_TOKEN.comment }]);
    // `? a // b` 里的 `//` 是运算符（2.0 只有整行注释）
    expect(ofToken(tokensOf('? a // b'), KOJO2_TOKEN.comment)).toEqual([]);
  });
});

/* ============================== @原生 围栏 ============================== */

describe('`@原生` 缩进围栏：整块 raw，体内锚点不解析', () => {
  it('体内 `#` / `?` / `>` / `!` 全不过锚点，整行只发 kojo2.raw', () => {
    const rows = tokensOfLines([
      '@原生',
      '    #DIM X, 1',
      '    ? 条件',
      '    > 正文',
      '    ! 触发',
      '> 旁白',
    ]);
    expect(rows[0]?.map((e) => e.token)).toEqual([KOJO2_TOKEN.anchor]);
    for (const row of rows.slice(1, 5)) {
      expect(row, `围栏体内应整行 raw：${JSON.stringify(row)}`).toEqual([
        { text: row[0]?.text ?? '', token: KOJO2_TOKEN.raw },
      ]);
      expect(row[0]?.text.trimStart().startsWith('#') || row[0]?.text.trimStart().startsWith('?') ||
        row[0]?.text.trimStart().startsWith('>') || row[0]?.text.trimStart().startsWith('!')).toBe(true);
    }
    // 去缩进（列 0）⇒ 围栏结束，回根状态按旁白分派
    expect(rows[5]?.[0]?.token).toBe(KOJO2_TOKEN.anchor);
    expect(ofToken(rows[5]!, KOJO2_TOKEN.narration)).toEqual(['旁白']);
  });

  it('块内围栏按栏头缩进收口：栏头 4 空格 ⇒ 8 空格是体、4 空格回根', () => {
    const rows = tokensOfLines(['# 池 早安问候', '    @原生', '        CALL HPH_PRINT "w"', '    「台词」']);
    expect(rows[1]?.[0]?.token).toBe(KOJO2_TOKEN.anchor);
    expect(rows[2]).toEqual([{ text: '        CALL HPH_PRINT "w"', token: KOJO2_TOKEN.raw }]);
    // 回根后是台词行（不是 raw）
    expect(rows[3]?.some((e) => e.token === KOJO2_TOKEN.raw), '围栏没有按缩进收口').toBe(false);
    expect(ofToken(rows[3]!, KOJO2_TOKEN.speech)).toEqual(['台词']);
  });
});

/* ============================== # 表 两列行 ============================== */

describe('`# 表` 两列行：范围列 / 值列分档', () => {
  it('数值范围与默认分支各发范围档，值列发文本档', () => {
    const rows = tokensOfLines(['# 表 心情 由 恋慕', '    0..99     疏远', '    100..499  平常', '    否        未知']);
    expect(ofToken(rows[1]!, KOJO2_TOKEN.number)).toEqual(['0..99']);
    expect(ofToken(rows[1]!, KOJO2_TOKEN.speech)).toEqual(['疏远']);
    expect(ofToken(rows[2]!, KOJO2_TOKEN.number)).toEqual(['100..499']);
    expect(ofToken(rows[3]!, KOJO2_TOKEN.keyword)).toEqual(['否']);
    expect(ofToken(rows[3]!, KOJO2_TOKEN.speech)).toEqual(['未知']);
  });
});

/* ============================== CRLF / 代理对 ============================== */

describe('CRLF 与代理对列', () => {
  it('CRLF 逐行与 LF 逐 token 相同（Monaco 行内容不含 CR）', () => {
    const lf = ['灵梦：「早」', '> 旁白', '// 注', '? 否'];
    const crlf = lf.map((line) => `${line}\r`).join('\n').split('\n').map((line) => line.replace(/\r$/, ''));
    expect(crlf).toEqual(lf);
    expect(tokensOfLines(crlf)).toEqual(tokensOfLines(lf));
    for (const row of tokensOfLines(crlf)) for (const e of row) expect(e.text).not.toContain('\r');
  });

  it('代理对（emoji）按 UTF-16 码元计列：token 首尾相接、后续 token 起点可回推', () => {
    const line = '> 她😀笑了(心形)';
    const emitted = expectRootAfter(line);
    expect(emitted.map((e) => e.text).join('')).toBe(line);
    const hint = emitted.find((e) => e.token === KOJO2_TOKEN.hint)!;
    const hintStart = emitted.slice(0, emitted.indexOf(hint)).reduce((n, e) => n + e.text.length, 0);
    // 代理对占 2 个 UTF-16 码元：'> '=2 + '她'=1 + '😀'=2 + '笑了'=2
    expect(hintStart).toBe(2 + 1 + 2 + 2);
    expect(hint.text).toBe('(心形)');
    // Monaco 的 column 就是码元轴：把 token 长度累加即得列，无需按码点折算
    expect(line.slice(hintStart, hintStart + hint.text.length)).toBe('(心形)');
    expect(line.indexOf('(')).toBe(hintStart);
  });
});

/* ============================== 语言配置 ============================== */

describe('语言配置：comments / wordPattern / 成对记号 / 回车层级', () => {
  it('注册面只挂 kojo2 + `.kojo2`，不抢 v1 的 `.kojo`', () => {
    expect(captured.registered).toContain(KOJO2_LANGUAGE_ID);
    expect(KOJO2_SOURCE_EXTENSION).toBe('.kojo2');
    expect(captured.monarchs.has(KOJO2_LANGUAGE_ID)).toBe(true);
  });

  it('comments 只认整行 `//`；中文整词复用既有 CJK 判据（同引用）', () => {
    expect(configCaptured, '注册时没有交语言配置').toBeTruthy();
    expect(configCaptured!.config.comments).toEqual({ lineComment: '//' });
    expect(configCaptured!.config.comments?.blockComment).toBeUndefined();
    expect(configCaptured!.config.wordPattern).toBe(CJK_WORD_PATTERN);
  });

  it('成对记号：`「」` / `{}` / `（）` / `()` / `""`；`：` 不是括号', () => {
    const config = configCaptured!.config;
    const pairs = config.autoClosingPairs ?? [];
    const contains = (open: string, close: string): boolean =>
      pairs.some((pair) => pair.open === open && pair.close === close);
    for (const [open, close] of [['「', '」'], ['{', '}'], ['（', '）'], ['(', ')'], ['"', '"']] as const) {
      expect(contains(open, close), `缺成对记号 ${open}${close}`).toBe(true);
    }
    expect(pairs.some((pair) => pair.open === '：'), '全角冒号不是括号对').toBe(false);
    expect(config.surroundingPairs).toEqual(config.autoClosingPairs);
    // 括号格 = 闭合表去掉 open===close 的 `""`
    expect((config.brackets ?? []).map((pair) => pair.join(''))).not.toContain('""');
  });

  it('回车层级：块头 `：` 与 `@原生` 栏头都 +1，且 Enter 上不许 Outdent', () => {
    const rules = configCaptured!.config.onEnterRules ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) {
      expect(rule.action.indentAction).toBe(monaco.languages.IndentAction.Indent);
    }
    const colon = rules.find((rule) => rule.beforeText.test('选项：'));
    expect(colon, '块头冒号没有缩进规则').toBeTruthy();
    expect(colon!.beforeText.test('> 旁白')).toBe(false);
    expect(colon!.beforeText.test('灵梦：「…」')).toBe(false);
    const native = rules.find((rule) => rule.beforeText.test('@原生'));
    expect(native, '`@原生` 栏头没有缩进规则').toBeTruthy();
    expect(native!.beforeText.test('@算')).toBe(false);
    // 两格不许分叉：每一格 beforeText 的 source 都含于 increaseIndentPattern
    const increase = configCaptured!.config.indentationRules?.increaseIndentPattern;
    expect(increase).toBeTruthy();
    for (const rule of rules) expect(increase!.test(rule.beforeText.source) || increase!.source.includes(rule.beforeText.source)).toBe(true);
  });

  it('幂等注册：同一 Monaco 再调一次不会登记第二枚', () => {
    const again = stubMonaco();
    registerKojo2Language(again.monaco);
    registerKojo2Language(again.monaco);
    expect(again.captured.registered).toEqual([KOJO2_LANGUAGE_ID]);
  });
});

/* ============================== 档位 / 配色 ============================== */

describe('档位与配色：一档一色、与 v1 不撞名', () => {
  const tierTokens = KOJO2_TOKEN_TIERS.flatMap((t) => [...t.tokens]);
  const ruleColor = new Map(KOJO2_THEME_RULES.map((rule) => [rule.token, rule.foreground ?? '']));

  function contrast(hex: string): number {
    const lum = (h: string): number => {
      const channels = [0, 2, 4].map((i) => {
        const v = parseInt(h.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const fg = lum(hex);
    // 底色从主题取（`inherit: false`，真底是 kojo-dark 的 editor.background `#1e2227`）；
    // 旧口径写死 vs-dark 基底的 1e1e1e，量出的读数系统性虚高（同 kojo-token-tiers 的旧 bug）
    const bg = lum(KOJO_DARK_COLORS['editor.background']!.replace('#', ''));
    const [light, dark] = fg > bg ? [fg, bg] : [bg, fg];
    return (light + 0.05) / (dark + 0.05);
  }

  it('U6 点名的十档都在：anchor/declaration/keyword/speaker/speech/narration/interp/hint/raw/comment', () => {
    for (const token of [
      'kojo2.anchor',
      'kojo2.declaration',
      'kojo2.keyword',
      'kojo2.speaker',
      'kojo2.speech',
      'kojo2.narration',
      'kojo2.interp',
      'kojo2.hint',
      'kojo2.raw',
      'kojo2.comment',
    ]) {
      expect(tierTokens, `档位表缺 ${token}`).toContain(token);
    }
  });

  it('档位表恰盖住配色全集（一 token 不双重登记，也不漏档）', () => {
    expect(new Set(KOJO2_TOKEN_TIERS.map((t) => t.tier)).size).toBe(KOJO2_TOKEN_TIERS.length);
    expect([...ruleColor.keys()].sort()).toEqual([...new Set(tierTokens)].sort());
    for (const tier of KOJO2_TOKEN_TIERS) {
      expect(tier.tokens.length).toBeGreaterThan(0);
      expect(tier.why.length).toBeGreaterThan(0);
    }
  });

  it('一档一色 + 深底对比度 ≥ 4.5（任何两档前景互不相同）', () => {
    const tierColor = (tokens: readonly string[]): string => ruleColor.get(tokens[0]!) ?? '';
    for (const tier of KOJO2_TOKEN_TIERS) {
      const colors = tier.tokens.map((token) => ruleColor.get(token));
      expect(new Set(colors).size, `档「${tier.tier}」内部不同色`).toBe(1);
      expect(contrast(colors[0]!), `档「${tier.tier}」对比度不足`).toBeGreaterThanOrEqual(4.5);
    }
    for (let i = 0; i < KOJO2_TOKEN_TIERS.length; i++) {
      for (let j = i + 1; j < KOJO2_TOKEN_TIERS.length; j++) {
        expect(
          tierColor(KOJO2_TOKEN_TIERS[i]!.tokens) !== tierColor(KOJO2_TOKEN_TIERS[j]!.tokens),
          `档「${KOJO2_TOKEN_TIERS[i]!.tier}」与「${KOJO2_TOKEN_TIERS[j]!.tier}」撞色`,
        ).toBe(true);
      }
    }
  });

  it('与 v1 不撞名（v1 `sugar.*` / `keyword.erb*` / `keyword.raw` 与 kojo2 档位无交集）', () => {
    const v1Tokens = new Set(KOJO_TOKEN_TIERS.flatMap((tier) => [...tier.tokens]));
    for (const token of tierTokens) {
      expect(token.startsWith('kojo2.'), `${token} 不在 kojo2 命名空间`).toBe(true);
      expect(v1Tokens.has(token), `${token} 与 v1 档位撞名`).toBe(false);
    }
  });

  it('每档都被词法真发出来（配了色却没有发射点 = 假档）', () => {
    // 每档至少一行样本（同一行可覆盖多档）；`raw` 必须在围栏态里发，单独走多行驱动
    const sampleLines = [
      '@算', // anchor + declaration
      '# 表 心情 由 恋慕', // declaration + keyword
      // 类型档的发射点（2026-10-27 第三色批）：类型词 + 存储期词同屏，两档必须各发各的
      '# 变量 人数 整数 存档',
      '? 否', // anchor + keyword
      '灵梦：「早」', // speaker + delimiter + speech
      '灵梦：「{你}」', // interp
      '> 旁白(心形)', // narration + hint
      '// 注', // comment
      'x = "神社的清晨"', // string
      '@着色 0xFF8080', // hex
      '? a >= 1', // number + operator
    ];
    const nativeRows = tokensOfLines(['@原生', '    CALL X']);
    const emittedTokens = new Set<string>([
      ...sampleLines.flatMap((line) => tokensOf(line).map((e) => e.token)),
      ...nativeRows.flat().map((e) => e.token),
    ]);
    for (const tier of KOJO2_TOKEN_TIERS) {
      for (const token of tier.tokens) expect(emittedTokens, `${token} 从未被发射`).toContain(token);
    }
  });
});
