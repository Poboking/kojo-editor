import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { ERB_DIRECTIVES } from '../src/monaco/erb-directives';
import {
  ERB_ENGINE_EXTRA_STATEMENTS,
  ERB_HIGHLIGHT_EXTRA_WORDS,
  ERB_HIGHLIGHT_WORDS,
} from '../src/monaco/erb-highlight-words';
import { ERB_COMMANDS, ERB_FAMILY_HEADS, ERB_HIGHLIGHT_COMMANDS, registerKojoLanguage } from '../src/monaco/kojo-language';
import { registerErbLanguage, setErbDirectiveWords } from '../src/monaco/erb-language';
import { ERB_CONTROL_STATEMENTS, classifyControlFlow } from '@kojo/plugin-erb-parser';
import { CJK_WORD_SEPARATORS } from '../src/monaco/word-separators';
import { compileMonarch, driveLexer, driveLine, stubMonaco, type CompiledLexer, type Emit } from './monarch-harness';

/**
 * `.ERB` 关键字高亮验收（SUGGEST-2C）——**真 Monarch 编译 + 逐词发射**，不手搓解析器。
 *
 * 用户报告：部分 ERB 关键字是白字。根因两条，本文件各钉一组判据：
 * ① **大小写**：Emuera 关键字大小写不敏感，而词表只存大写；`ignoreCase: false` 时
 *    `call` / `If` / `setcolor` 全落 `identifier`（默认前景 ≈ 白字）。三形态逐词发射。
 * ② **漏词**：`ERB_DIRECTIVES` 是"口上高频子集"（补全口径），控制流闭合词
 *    （`ENDCATCH` / `NOSKIP` / `TRYC*` 族）与引擎内建单行语句（`SETVAR` / `HTML_PRINT` …）
 *    不在表内。高亮补集 `ERB_HIGHLIGHT_EXTRA_WORDS` 从 erb-parser 语句表 + 叶子模块派生。
 *
 * 另有三条**不回退**判据：变量多段引用（含同时是指令的族头）、字符串/注释、预处理
 * `#DIM` 三主题有色；以及 `.kojo` 原生行吃到补集但小写判定不变。
 */

const ERB_ID = 'kojo-erb';
const KOJO_ID = 'kojo-sugar';

const { monaco, captured } = stubMonaco();
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

function defOf(id: string): Monaco.languages.IMonarchLanguage {
  const def = captured.monarchs.get(id);
  if (!def) throw new Error(`monaco 桩没捕获到 ${id} 的 Monarch def（装配面漂 = 本文件整个红）`);
  return def;
}

const erbDef = defOf(ERB_ID);
const kojoDef = defOf(KOJO_ID);

/** def 每次被重设（`setErbDirectiveWords`）都重新编译——缓存键按 def 对象同一性，不缓存旧词表 */
let erbCache: { def: unknown; lexer: Promise<CompiledLexer> } | null = null;
function erbLexer(): Promise<CompiledLexer> {
  const def = defOf(ERB_ID);
  if (erbCache === null || erbCache.def !== def) {
    erbCache = { def, lexer: compileMonarch(ERB_ID, def) };
  }
  return erbCache.lexer;
}

async function emitErb(line: string): Promise<{ emitted: Emit[]; postfix: string }> {
  const lexer = await erbLexer();
  return { emitted: driveLexer(lexer, line), postfix: lexer.tokenPostfix };
}

/** 一个词的三形态：词表原样（大写）/ 全小写 / 首字母大写 */
function caseForms(word: string): string[] {
  return [word, word.toLowerCase(), word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()];
}

/** 行首与行中两种位置（行中用 `CALL ` 前缀——它本身是指令，不污染被测词） */
function positions(form: string): { where: string; line: string }[] {
  return [
    { where: '行首', line: form },
    { where: '行中', line: `CALL ${form}` },
  ];
}

const keywordToken = (postfix: string): string => `keyword${postfix}`;

/** 该词在发射结果里的 token；没有发射点 → `<none>` */
function tokenOfWord(emitted: readonly Emit[], word: string): string {
  return emitted.find((e) => e.text === word)?.token ?? '<none>';
}

/* ============================== ① 大小写：词表每词三形态 × 两位置 ============================== */

describe('ERB 大小写不敏感（Emuera 关键字口径）', () => {
  it('Monarch def 显式 ignoreCase: true（大小写归一不是碰巧）', () => {
    expect((erbDef as unknown as { ignoreCase?: boolean }).ignoreCase).toBe(true);
  });

  it('ERB_DIRECTIVES 每词三形态 × 行首/行中全出 keyword（714 格全覆盖，不点名）', async () => {
    expect(ERB_DIRECTIVES.length).toBeGreaterThan(100); // 基线 119 词；只钉"非空跑"的规模线
    let checked = 0;
    for (const word of ERB_DIRECTIVES) {
      for (const form of caseForms(word)) {
        for (const { where, line } of positions(form)) {
          const { emitted, postfix } = await emitErb(line);
          const token = tokenOfWord(emitted, form);
          expect(
            token,
            `「${word}」的 ${where} 形态「${form}」应为 keyword，实发 ${token}（${emitted
              .map((e) => `${e.text}=${e.token}`)
              .join(' / ')}）`,
          ).toBe(keywordToken(postfix));
          checked++;
        }
      }
    }
    expect(checked).toBe(ERB_DIRECTIVES.length * 3 * 2);
  });

  it('同时是变量族头的指令（CFLAG / EQUIP / RAND / DOWNBASE）整词仍是 keyword——变量规则不许截胡', async () => {
    for (const word of ['CFLAG', 'EQUIP', 'RAND', 'DOWNBASE', 'cflag', 'equip', 'rand', 'downbase']) {
      const { emitted, postfix } = await emitErb(word);
      expect(tokenOfWord(emitted, word), `「${word}」被变量规则截胡`).toBe(keywordToken(postfix));
    }
  });
});

/* ============================== ② 漏词：高亮补集逐词 ============================== */

/**
 * 用户报告里点名的漏词（eraTW 口上真在写的语句）。它们必须全部落在补集里——
 * 谁把补集瘦回 `ERB_DIRECTIVES`，这里先红。
 */
const REPORTED_GAPS: readonly string[] = [
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
  'TRYCALLLIST',
  'TRYJUMPLIST',
  'TRYGOTOLIST',
  'CATCH',
  'ENDCATCH',
  'NOSKIP',
  'ENDNOSKIP',
  'ENDDATA',
  'ENDFUNC',
  'SETVAR',
  'GETVAR',
  'FORCEWAIT',
  'HTML_PRINT',
  'PRINTCPERLINE',
  'SAVETEXT',
  'LOADTEXT',
];

describe('ERB 高亮补集（控制流 + 引擎内建单行语句）', () => {
  it('报告点名的语句全部有 keyword 来源，且两路各归其位（22 词逐个钉）', () => {
    const highlighted = new Set(ERB_HIGHLIGHT_WORDS);
    const extra = new Set(ERB_HIGHLIGHT_EXTRA_WORDS);
    const directives = new Set(ERB_DIRECTIVES);
    const control = new Set(ERB_CONTROL_STATEMENTS);
    for (const word of REPORTED_GAPS) {
      expect(highlighted.has(word), `报告词 ${word} 没有任何 keyword 来源`).toBe(true);
      // 控制流词由结构真源派生进指令表（2026-10-25 P0-2 起）；引擎内建单行语句仍在补集
      if (control.has(word)) expect(directives.has(word), `控制流词 ${word} 未进派生指令表`).toBe(true);
      else expect(extra.has(word), `引擎语句 ${word} 不在补集`).toBe(true);
    }
  });

  it('补集 = 引擎内建单行语句 − 指令表（控制流词已由结构真源派生，不再占补集）', () => {
    const directives = new Set(ERB_DIRECTIVES.map((w) => w.toUpperCase()));
    const expected = [...new Set(ERB_ENGINE_EXTRA_STATEMENTS.map((w) => w.toUpperCase()))]
      .filter((w) => !directives.has(w))
      .sort();
    expect([...ERB_HIGHLIGHT_EXTRA_WORDS].map((w) => w.toUpperCase()).sort()).toEqual(expected);
  });

  it('补集每词三形态 × 行首/行中全出 keyword（不点名，补集自扩自动覆盖）', async () => {
    expect(ERB_HIGHLIGHT_EXTRA_WORDS.length).toBeGreaterThan(0);
    for (const word of ERB_HIGHLIGHT_EXTRA_WORDS) {
      for (const form of caseForms(word)) {
        for (const { where, line } of positions(form)) {
          const { emitted, postfix } = await emitErb(line);
          const token = tokenOfWord(emitted, form);
          expect(token, `补集词「${form}」（${where}）应为 keyword，实发 ${token}`).toBe(keywordToken(postfix));
        }
      }
    }
  });

  it('补集每词可追到导出表：控制流语句表 或 引擎内建单行语句表；且严格不在 ERB_DIRECTIVES', () => {
    const control = new Set(ERB_CONTROL_STATEMENTS);
    const extra = new Set(ERB_ENGINE_EXTRA_STATEMENTS);
    const directives = new Set(ERB_DIRECTIVES);
    for (const word of ERB_HIGHLIGHT_EXTRA_WORDS) {
      expect(
        control.has(word) || extra.has(word),
        `补集词「${word}」追不到出处（既不在 ERB_CONTROL_STATEMENTS 也不在 ERB_ENGINE_EXTRA_STATEMENTS）`,
      ).toBe(true);
      expect(directives.has(word), `补集词「${word}」其实已在 ERB_DIRECTIVES（补集不"补"）`).toBe(false);
    }
    // 全表 = 指令子集 ∪ 补集，且无重复
    expect([...ERB_HIGHLIGHT_WORDS].sort()).toEqual([...new Set([...ERB_DIRECTIVES, ...ERB_HIGHLIGHT_EXTRA_WORDS])].sort());
  });

  it('控制流语句表与 erb-parser 单一真源同源：每词 classifyControlFlow 都认（不是另抄的表）', () => {
    expect(ERB_CONTROL_STATEMENTS.length).toBeGreaterThan(40);
    expect(new Set(ERB_CONTROL_STATEMENTS).size).toBe(ERB_CONTROL_STATEMENTS.length);
    expect([...ERB_CONTROL_STATEMENTS]).toEqual([...ERB_CONTROL_STATEMENTS].sort());
    for (const word of ERB_CONTROL_STATEMENTS) {
      expect(classifyControlFlow(word), `控制流表词「${word}」在 scanner 配对表里不存在（第二份表）`).not.toBeNull();
    }
  });
});

/* ============================== ③ 不回退：变量 / 字符串 / 注释 / 预处理 ============================== */

describe('高亮不回退（词法分层仍然成立）', () => {
  it('变量多段引用整段 variable：CFLAG:ARG:口上セレクタ / 小写 cflag:arg / rand:2（指令同名词的索引形态）', async () => {
    for (const line of ['CFLAG:ARG:口上セレクタ = 1', 'cflag:arg = 1', 'rand:2']) {
      const { emitted } = await emitErb(line);
      const variable = emitted.find((e) => e.token.startsWith('variable.') && e.text.startsWith(line.split(' ')[0]!));
      expect(variable, `「${line}」没有整段 variable（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`).toBeDefined();
    }
  });

  it('字符串里的指令词不染 keyword（FORM 串内仍是 string）', async () => {
    const { emitted } = await emitErb('PRINTFORMW "CALL IF ENDCATCH"');
    const stringText = emitted.filter((e) => e.token.startsWith('string.') || e.token.startsWith('string'));
    expect(stringText.map((e) => e.text).join('')).toContain('CALL IF ENDCATCH');
    expect(emitted.find((e) => (e.text === 'CALL' || e.text === 'IF' || e.text === 'ENDCATCH') && e.token.startsWith('keyword.'))).toBeUndefined();
  });

  it('行首注释整行 comment，其中的指令词不发射 keyword', async () => {
    const { emitted } = await emitErb('; CALL IF ENDCATCH 都是注释');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.token.startsWith('comment')).toBe(true);
    expect(emitted[0]!.text).toContain('CALL IF ENDCATCH');
  });

  it('@ 函数定义与 $ 标签仍走专用档位', async () => {
    const fn = await emitErb('@EVENTFIRST');
    expect(fn.emitted.find((e) => e.text === '@')?.token.startsWith('keyword.')).toBe(true);
    expect(fn.emitted.find((e) => e.text === 'EVENTFIRST')?.token.startsWith('entity.name.function.')).toBe(true);
    const label = await emitErb('$LOOP_TOP');
    expect(label.emitted.find((e) => e.text === 'LOOP_TOP')?.token.startsWith('label.')).toBe(true);
  });

  it('#DIM / #DEFINE / #FUNCTION 与 [SKIPSTART] 仍为 keyword.preprocessor（大小写两形态）', async () => {
    for (const line of ['#DIM 口上セレクタ', '#DEFINE FOO', '#FUNCTION', '#dim x', '[SKIPSTART]']) {
      const { emitted } = await emitErb(line);
      expect(
        emitted.find((e) => e.token.startsWith('keyword.preprocessor.')),
        `「${line}」没发 keyword.preprocessor（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`,
      ).toBeDefined();
    }
  });
});

/* ============================== ④ 主题：三套同源、预处理有色 ============================== */

describe('三套主题的 keyword / keyword.preprocessor 都有色（白色 = 没命中主题规则）', () => {
  for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark']) {
    it(`${id}：keyword 与 keyword.preprocessor 规则存在且前景是 6 位 hex、与 identifier 不同`, () => {
      const theme = captured.themes.get(id);
      if (!theme) throw new Error(`主题 ${id} 没被装配`);
      const rule = (token: string) => theme.rules.find((r) => r.token === token);
      const keyword = rule('keyword');
      const preprocessor = rule('keyword.preprocessor');
      const identifier = rule('identifier');
      expect(keyword?.foreground, `${id} 缺 keyword 前景`).toMatch(/^[0-9a-f]{6}$/i);
      expect(preprocessor?.foreground, `${id} 缺 keyword.preprocessor 前景`).toMatch(/^[0-9a-f]{6}$/i);
      expect(identifier?.foreground, `${id} 缺 identifier 前景`).toMatch(/^[0-9a-f]{6}$/i);
      expect(keyword!.foreground).not.toBe(identifier!.foreground);
      expect(preprocessor!.foreground).not.toBe(identifier!.foreground);
    });
  }

  /**
   * **本工包第一件的根因**：`operator` 一直是"词法发得出、调色板没配色"的裸默认前景。
   * 单点断言挡不住下一枚新 token，所以这里做**静态对账**：从 Monarch def 收集每一枚可能发出的
   * token 名，逐套主题验它有落点（Monaco 按点分段前缀匹配规则，`string.quote` 吃 `string` 那格
   * 也算有着落）。发得出却没人配色 = 屏上一块白，这条线一红就是"配色漏格"而不是"观感不对"。
   */
  it('ERB 每一枚发射 token 在三套主题里都有落点（调色板漏格当场红）', () => {
    const tokens = [...erbEmittedTokens()].sort();
    expect(tokens.length).toBeGreaterThanOrEqual(11);
    expect(tokens).toContain('operator'); // 上一批留下的那枚空档，钉住它别再漂回去
    for (const [id, theme] of captured.themes) {
      for (const token of tokens) {
        const hit = theme.rules.some((r) => token === r.token || token.startsWith(`${r.token}.`));
        expect(hit, `${id} 没有 ${token} 的配色落点（发得出、没颜色 = 裸默认前景）`).toBe(true);
      }
    }
  });
});

/** 静态收集 Monarch def 里每一枚会发出的 token 名（含 cases 卫兵各档与群组子段） */
function erbEmittedTokens(
  tokenizer: Record<string, readonly [unknown, unknown][]> = (erbDef as unknown as {
    tokenizer: Record<string, readonly [unknown, unknown][]>;
  }).tokenizer,
): Set<string> {
  const out = new Set<string>();
  const visit = (action: unknown): void => {
    if (typeof action === 'string') {
      if (action.length > 0) out.add(action);
      return;
    }
    if (Array.isArray(action)) {
      for (const sub of action) visit(sub);
      return;
    }
    const o = action as { token?: string; cases?: Record<string, unknown> };
    if (typeof o.token === 'string' && o.token.length > 0) out.add(o.token);
    if (o.cases) for (const value of Object.values(o.cases)) visit(value);
  };
  for (const rules of Object.values(tokenizer)) for (const rule of rules) visit(rule[1]);
  return out;
}

/* ============================== ⑤ `.kojo` 原生行：吃补集、小写判定不变 ============================== */

describe('.kojo 原生直通行同步吃补集（大写才是原生指令）', () => {
  const kojoLexerP = compileMonarch(KOJO_ID, kojoDef);

  it('ERB_HIGHLIGHT_COMMANDS = ERB_COMMANDS + 补集（去族头），补集词进 def.erbCommands', () => {
    const def = defOf(KOJO_ID) as unknown as { erbCommands?: readonly string[] };
    expect(def.erbCommands).toEqual(ERB_HIGHLIGHT_COMMANDS);
    for (const word of ['ENDCATCH', 'NOSKIP', 'SETVAR', 'HTML_PRINT']) {
      expect(ERB_HIGHLIGHT_COMMANDS, `.kojo 指令档缺补集词 ${word}`).toContain(word);
    }
    // 族头仍归 `keyword.erb.family`，不许被指令档吸走；既有指令档逐项保留
    const family = new Set(ERB_FAMILY_HEADS);
    for (const word of ERB_COMMANDS) expect(ERB_HIGHLIGHT_COMMANDS).toContain(word);
    for (const word of ERB_HIGHLIGHT_COMMANDS) expect(family.has(word), `族头 ${word} 混进指令档`).toBe(false);
  });

  it('大写补集词在行首发 keyword.erb；小写仍不吃原生档（糖英文别名/普通标识符口径不变）', async () => {
    const lexer = await kojoLexerP;
    for (const word of ['ENDCATCH', 'NOSKIP', 'SETVAR', 'HTML_PRINT']) {
      const upper = driveLexer(lexer, word);
      expect(upper.find((e) => e.text === word)?.token.startsWith('keyword.erb.'), `${word} 行首没进指令档`).toBe(true);
      const lower = driveLexer(lexer, word.toLowerCase());
      const lowerToken = lower.find((e) => e.text === word.toLowerCase())?.token ?? '<none>';
      expect(lowerToken.startsWith('keyword.erb.'), `${word.toLowerCase()} 不该吃原生指令档（实发 ${lowerToken}）`).toBe(false);
    }
  });
});

/* ============================== ⑥ 项目切换：重设词表不丢补集 ============================== */

describe('setErbDirectiveWords 的公开语义不变，补集不随项目词表丢失', () => {
  it('传入 adapter 词表：def.directives 仍是传入原样；补集词与传入词都出 keyword', async () => {
    setErbDirectiveWords(monaco, ['亲吻']);
    const def = defOf(ERB_ID) as unknown as { directives?: readonly string[]; ignoreCase?: boolean };
    expect(def.directives).toEqual(['亲吻']);
    expect(def.ignoreCase).toBe(true);

    const { emitted: extra } = await emitErb('ENDCATCH');
    expect(tokenOfWord(extra, 'ENDCATCH').startsWith('keyword.')).toBe(true);
    const { emitted: adapter } = await emitErb('亲吻');
    expect(tokenOfWord(adapter, '亲吻').startsWith('keyword.')).toBe(true);

    setErbDirectiveWords(monaco, null); // 收尾：回基底（不把测试词表留给同进程后续用例）
    const { emitted: restored } = await emitErb('ENDCATCH');
    expect(tokenOfWord(restored, 'ENDCATCH').startsWith('keyword.')).toBe(true);
  });
});

/* ============================== ⑦ 工包 C：着色层与语义层同口径（尾注释 / 串态 / 全角标点） ============================== */

describe('着色层与语义层同口径（erb-parser/references.ts codeViewOf 是唯一真相，正反面各钉）', () => {
  it('① 行尾 `;` 之后整段 comment：PRINTL 台词 ;说明 的「说明」不再是 identifier', async () => {
    const { emitted } = await emitErb('PRINTL 台词 ;说明');
    expect(emitted.find((e) => e.text === '台词')?.token.startsWith('identifier.')).toBe(true);
    expect(emitted.filter((e) => e.token.startsWith('comment.')).map((e) => e.text).join('')).toBe(';说明');
    expect(emitted.find((e) => e.text === '说明'), '注释尾巴不许有第二处发射').toBeUndefined();
  });

  it('①b 反面：串里的 `;` 不当注释；串闭合后的行尾 `;` 恢复注释', async () => {
    const inside = await emitErb('PRINTL "台词;说明"');
    expect(inside.emitted.some((e) => e.token.startsWith('comment.'))).toBe(false);
    expect(inside.emitted.filter((e) => e.token.startsWith('string')).map((e) => e.text).join('')).toContain('台词;说明');
    const after = await emitErb('PRINTL "台词" ;说明');
    expect(after.emitted.filter((e) => e.token.startsWith('comment.')).map((e) => e.text).join('')).toBe(';说明');
  });

  it('①c 变量段不许吞尾注释：CFLAG:ARG;说明 ⇒ variable 止于 `;`、其后 comment', async () => {
    const { emitted } = await emitErb('CFLAG:ARG;说明');
    expect(emitted.find((e) => e.text === 'CFLAG:ARG')?.token.startsWith('variable.')).toBe(true);
    expect(emitted.filter((e) => e.token.startsWith('comment.')).map((e) => e.text).join('')).toBe(';说明');
  });

  it('② 未闭合引号只染到本行行尾、下一行恢复正常；闭合串回根态（codeViewOf 逐行刷白的口径）', async () => {
    const lexer = await erbLexer();
    const closed = driveLine(lexer, 'PRINTL "闭合"');
    expect(closed.stack).toEqual(['root']);
    const open = driveLine(lexer, 'PRINTL "尾未闭合');
    expect(open.emitted.find((e) => e.text === '尾未闭合')?.token.startsWith('string.')).toBe(true);
    expect(open.stack, '串态绝不带过行界').toEqual(['root']);
    const next = driveLine(lexer, 'PRINTL 正常', open.stack);
    expect(next.emitted.some((e) => e.token.startsWith('string.'))).toBe(false);
    expect(next.emitted.find((e) => e.text === 'PRINTL')?.token.startsWith('keyword.')).toBe(true);
  });

  it('②b 串内 % FORM 层同样行尾出栈（嵌套态不留到下一行）', async () => {
    const lexer = await erbLexer();
    const open = driveLine(lexer, 'PRINTL "前段%ＦＯＲＭ');
    expect(open.stack).toEqual(['root']);
    const next = driveLine(lexer, 'PRINTL 正常', open.stack);
    expect(next.emitted.some((e) => e.token.startsWith('string.'))).toBe(false);
  });

  it('③ 全角标点有确定归属（operator，非空 token）；全角 `；` 不当行尾注释（语义层只认半角 0x3B）', async () => {
    for (const ch of ['：', '，', '。', '（', '）', '、', '；', '！', '？', '「', '」', '『', '』', '《', '》', '【', '】', '｛', '｝', '＿', '＄']) {
      const { emitted } = await emitErb(`PRINTL 台词${ch}说明`);
      const hit = emitted.find((e) => e.text.includes(ch));
      expect(hit, `「${ch}」坠进空 defaultToken`).toBeDefined();
      expect(hit!.token.startsWith('operator.'), `「${ch}」应归 operator，实发 ${hit!.token}`).toBe(true);
      expect(emitted.some((e) => e.token.startsWith('comment.')), `全角「${ch}」不许触发注释`).toBe(false);
    }
  });

  /**
   * ③′ **标点表反查**（`word-separators.ts` 的 CJK 段是唯一真源，着色层不许只认两段码位区间）：
   * 分词侧认得每一枚标点，着色侧漏一枚就是"同一枚字符两边口径分叉"——双击能选中、颜色却裸着。
   * 表里这些字符按 Unicode 块分四种去处，两段码位区间只覆盖前两种：
   * - U+FF01-U+FF65（Halfwidth and Fullwidth Forms）= ASCII 全角**镜像段**，段内每枚都有半角同族
   *   （`！↔!`、`～↔~`、`＿↔_`）⇒ 区间天然收 `，。：；！？（）《》【】` 的全角形；
   * - U+3001-U+303F（CJK Symbols and Punctuation）= 汉字文化圈**固有**记号段 ⇒ `。、「」『』《》【】`；
   * - U+2018-U+201D `“ ” ‘ ’` 与 U+2026 `…` 住 General Punctuation（西文排版族）、U+00B7 `·`
   *   住 Latin-1 Supplement：ASCII 里没有同族镜像、也不属汉字固有记号，只是中文输入法按**排版
   *   习惯**当全角用 ⇒ 块区间天然不收，只能单列；
   * - U+30FB `・`（中黒）最尴尬：它住**假名段**，被标识符类的块区间 `\u3040-\u30ff` 顺手收成
   *   词字符，而语义层的记号判据 `MODEL_TOKEN_CLASS = [\p{L}\p{N}_]` 根本不认它（Po）——
   *   于是"颜色是标识符、双击却分段"，同一枚字符两套事实。
   * 这条测试的作用面：将来往标点表里添一枚而不添归属，这里当场红。
   */
  it('③′ word-separators 标点表的每一枚非 ASCII 标点都落到 operator（表反查，不点名）', async () => {
    const punct = Array.from(CJK_WORD_SEPARATORS).filter((ch) => ch.charCodeAt(0) >= 0x80);
    expect(punct.length).toBeGreaterThan(20);
    // 上一批点名的三族必须先在表里（不在表里就说明反查面被写小了）
    for (const ch of ['…', '“', '”', '‘', '’', '·']) expect(punct, `标点表里没有「${ch}」`).toContain(ch);
    for (const ch of punct) {
      const { emitted } = await emitErb(`PRINTL 台词${ch}说明`);
      const hit = emitted.find((e) => e.text.includes(ch));
      expect(hit, `「${ch}」U+${ch.codePointAt(0)!.toString(16).toUpperCase()} 坠进空 defaultToken（着色层没跟上标点表）`).toBeDefined();
      expect(hit!.token.startsWith('operator.'), `「${ch}」U+${ch.codePointAt(0)!.toString(16).toUpperCase()} 应归 operator，实发 ${hit!.token}`).toBe(true);
      expect(emitted.some((e) => e.token.startsWith('comment.')), `全角「${ch}」不许触发注释`).toBe(false);
    }
  });

  it('③b 全角字母数字进标识符族（反向索引 ａ-ｚ 与 MODEL_TOKEN_CLASS 的记号口径同向），不落空 token', async () => {
    const { emitted } = await emitErb('ＲＡＮＤ １２３');
    expect(emitted.find((e) => e.text === 'ＲＡＮＤ')?.token.startsWith('identifier.')).toBe(true);
    expect(emitted.find((e) => e.text === '１２３')?.token.startsWith('identifier.')).toBe(true);
  });

  it('④ 行首注释口径不回退：整行仍一段 comment（首个规则吃下，不产生二次发射）', async () => {
    const { emitted } = await emitErb('; PRINTL 台词 ; 说明');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.token.startsWith('comment.')).toBe(true);
  });
});

/* ============================== ⑧ FORM 串内第二层（`{表达式}` 层接通） ============================== */

/**
 * 上一批点名的第三件遗留：`str` 态的 catch-all `[^"%\\]+` 吞掉 `{`，入层规则排在它后面
 * 就**永远轮不上** ⇒ `strExpr` 历史不可达，串内 `{表达式}` 二级解析从不发生。
 *
 * 动它之前先取证（"引号内的 `{…}` 算不算表达式位"这条语言事实不许着色层自己发明）：
 * - `erb-completion-context.ts` 的 `'form'` 槽（ERB 补全的单一真源判据）明写
 *   "名字位是**表达式**（FORM 串，可含 `%…%` / `{…}` 插值）"，`insideInterp` 对未闭合 `{`
 *   判"停在插值内 ⇒ 不猜"——**认 `{` 会开一层**；
 * - 真语料形态：`erb-parser/src/structure.ts` 头注那条
 *   `@"给%CALLNAME:TARGET%使用避孕套（剩余{ITEM:45}枚）"`，一枚串里两层同时出现；
 * - `kojo-sugar/src/codegen.ts` 的 `classifyInterpolation` 把数值插值**降糖成 `{表达式}`**
 *   落进 ERB 产物（`规范 §5.2 c）`），即 ERB 侧读到的就是这一形；
 * - 反面口径同样有据：`condition-extractor/src/expr.ts` 的串词法用 `\` **转义一枚字符**
 *   （`splitTopLevelCommas` 同款），所以 `\{` 是字面括号、不开层；`@"…"` 那条例外只对
 *   表达式解析器成立（逐字串整枚成一个 token），与 FORM 输出层的展开不冲突。
 *
 * 四条判据各钉一条：两层都出 `string.escape` + `variable`；转义括号留在 `string` 层；
 * 未闭合的 `{` 与行尾落单反斜杠都不许把串态带过行界（⑦②同一条纪律）。
 */
describe('FORM 串内 `{表达式}` / `%字符串%` 两层都真解析（规则序接通，不再历史不可达）', () => {
  it('① `{…}` 开层：花括号出 string.escape、层内出 variable，闭合后回根态', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "台词{LOCAL:1}尾巴"');
    const of = (text: string) => line.emitted.find((e) => e.text === text)?.token ?? '<none>';
    expect(of('{').startsWith('string.escape.'), `{ 实发 ${of('{')}`).toBe(true);
    expect(of('}').startsWith('string.escape.'), `} 实发 ${of('}')}`).toBe(true);
    expect(of('LOCAL:1').startsWith('variable.'), `层内实发 ${of('LOCAL:1')}`).toBe(true);
    expect(of('台词').startsWith('string.'), '串内字面段仍是 string').toBe(true);
    expect(of('尾巴').startsWith('string.'), '层后字面段仍是 string').toBe(true);
    expect(line.stack, '闭合串回根态').toEqual(['root']);
  });

  it('② `%…%` 层不因规则序调整而回退（与 `{}` 同一档形态：escape + variable）', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "台词%CALLNAME:MASTER%尾巴"');
    const percents = line.emitted.filter((e) => e.text === '%');
    expect(percents).toHaveLength(2);
    expect(percents.every((e) => e.token.startsWith('string.escape.'))).toBe(true);
    expect(line.emitted.find((e) => e.text === 'CALLNAME:MASTER')?.token.startsWith('variable.')).toBe(true);
    expect(line.stack).toEqual(['root']);
  });

  it('③ 反面：`\\{` 是转义出来的字面括号，留在 string 层、不开插值层（expr.ts 的 `\\` 吞一字符口径）', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "字面\\{LOCAL:1\\}尾巴"');
    expect(line.emitted.some((e) => e.token.startsWith('variable.')), `转义括号不许开层：${line.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toBe(false);
    expect(line.emitted.some((e) => e.token.startsWith('string.escape.'))).toBe(false);
    expect(line.emitted.filter((e) => e.token.startsWith('string.')).map((e) => e.text).join('')).toBe('"字面\\{LOCAL:1\\}尾巴"');
    expect(line.stack).toEqual(['root']);
  });

  it('④ 本行等不到闭合符就不开层：未闭合的 `{` / `%` 与行尾落单 `\\` 都不把串态带过行界（⑦② 那条纪律）', async () => {
    const lexer = await erbLexer();
    for (const open of [
      'PRINTL "台词{未闭合',
      'PRINTL "台词{', // 插值记号正好压在行尾：旧字符类顺手把它收了，换了字符类必须由规则明写
      'PRINTL "前段%',
      'PRINTL "台词\\',
    ]) {
      const line = driveLine(lexer, open);
      expect(line.stack, `「${open}」的串态被带过了行界`).toEqual(['root']);
      // 保守方向与 codeViewOf 一致：等不到闭合的那一段留在 string 层，不冒充 variable 表达式
      expect(
        line.emitted.some((e) => e.token.startsWith('variable.')),
        `「${open}」把未闭合的残段染成了表达式：${line.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`,
      ).toBe(false);
      const next = driveLine(lexer, 'PRINTL 正常', line.stack);
      expect(next.emitted.some((e) => e.token.startsWith('string.')), `「${open}」把下一行也染成串了`).toBe(false);
      expect(next.emitted.find((e) => e.text === 'PRINTL')?.token.startsWith('keyword.')).toBe(true);
    }
  });

  it('⑤ 落单记号（`"…{"` / `"…50%"`）不冒充开层记号，也不吞掉闭合引号（bracket 配对计数守恒）', async () => {
    const lexer = await erbLexer();
    for (const line of ['PRINTL "台词{"', 'PRINTL "完成率50%"']) {
      const drive = driveLine(lexer, line);
      expect(drive.stack, `「${line}」应正常闭合`).toEqual(['root']);
      const quote = drive.emitted.filter((e) => e.text === '"' && e.token.startsWith('string.quote.'));
      expect(quote, `「${line}」丢了闭合引号：${drive.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toHaveLength(2);
      expect(drive.emitted.some((e) => e.token.startsWith('variable.'))).toBe(false);
      expect(drive.emitted.some((e) => e.token.startsWith('string.escape.'))).toBe(false);
    }
  });

  it('⑥ Emuera 的 `""` 字面引号：着色层"闭合+立刻重开"两次翻转落回同一侧，可见颜色与语义层同口径', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "含""转义"的文字');
    // 语义层（erb-completion-context.ts 的 erbCodeViewBlocked）认 `""` 是一枚字面引号、仍在串内；
    // 着色层按"闭合 + 立刻重开"处理——两次翻转后 `转义` 仍归 string、`的文字` 仍归代码，
    // 与"什么是串"的可见结果同口径（差异只在 bracket 配对计数，不在本工包三件里，故只钉不改）。
    expect(line.emitted.find((e) => e.text === '转义')?.token.startsWith('string.'), '转义 应仍是串内 string').toBe(true);
    expect(line.emitted.find((e) => e.text === '的文字')?.token.startsWith('identifier.'), '的文字 应在串外').toBe(true);
    expect(line.stack).toEqual(['root']);
  });
});

/* ============================== P2 边角：代码前缀与 `'=` 运算符 ============================== */

describe('P2 边角着色（`;!;` / `;#;` 代码前缀、`\'=` 赋值运算符）', () => {
  it('`;!;` / `;#;` 行不是注释：前缀单独成档、其后整行按代码着色', async () => {
    for (const prefix of [';!;', ';#;']) {
      const line = driveLine(await erbLexer(), `${prefix}PRINTL あ`);
      const head = line.emitted[0];
      expect(head?.text, `${prefix} 的首个发射点应是前缀本身`).toBe(prefix);
      expect(head?.token, `${prefix} 应落预处理档（与 #DIM 同色），不是 comment`).toMatch(/^keyword\.preprocessor/);
      expect(
        line.emitted.find((e) => e.text === 'PRINTL')?.token.startsWith('keyword.'),
        `${prefix} 之后的语句应仍是关键字色`,
      ).toBe(true);
      expect(line.emitted.some((e) => e.token.startsWith('comment')), `${prefix} 行不许整行染成注释`).toBe(false);
    }
  });

  it('普通 `;` 行仍是整行注释（前缀规则不得放宽）', async () => {
    const line = driveLine(await erbLexer(), ';PRINTL あ');
    expect(line.emitted.some((e) => e.token.startsWith('comment'))).toBe(true);
    // 整行一枚注释 token：不许漏出任何 keyword（`PRINTL` 在注释里不是指令）
    expect(line.emitted.some((e) => e.token.startsWith('keyword')), '注释行漏出关键字色').toBe(false);
  });

  it('`\'=` 是运算符：`STR \'= TSTR:0 + "ABC"` 里 `\'=` 单独一枚 operator，`+` 口径不变', async () => {
    const line = driveLine(await erbLexer(), 'STR \'= TSTR:0 + "ABC"');
    expect(line.emitted.find((e) => e.text === "'=")?.token.startsWith('operator'), "'= 应是 operator").toBe(true);
    expect(line.emitted.find((e) => e.text === '+')?.token.startsWith('operator')).toBe(true);
    // 回归：`STR` 之后的串照旧进 string，`'=` 没把引号吃掉
    expect(line.emitted.find((e) => e.text === 'ABC')?.token.startsWith('string.')).toBe(true);
  });
});
