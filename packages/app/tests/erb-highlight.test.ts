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
import { compileMonarch, driveLexer, stubMonaco, type CompiledLexer, type Emit } from './monarch-harness';

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
  it('报告点名的语句全部有 keyword 来源（指令表或补集，22 词逐个钉）', () => {
    const highlighted = new Set(ERB_HIGHLIGHT_WORDS);
    const extra = new Set(ERB_HIGHLIGHT_EXTRA_WORDS);
    for (const word of REPORTED_GAPS) {
      expect(highlighted.has(word), `报告词 ${word} 没有任何 keyword 来源`).toBe(true);
    }
    // TRYCALLFORM 原本就在口上高频子集里，其余 21 词是本次新增的高亮补集
    expect(REPORTED_GAPS.filter((w) => extra.has(w)).length).toBeGreaterThanOrEqual(REPORTED_GAPS.length - 1);
  });

  it('补集每词三形态 × 行首/行中全出 keyword（不点名，补集自扩自动覆盖）', async () => {
    expect(ERB_HIGHLIGHT_EXTRA_WORDS.length).toBeGreaterThan(REPORTED_GAPS.length);
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
});

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
