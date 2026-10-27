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
import { scanTextTernaries } from '@kojo/plugin-condition-extractor';
import { CJK_WORD_SEPARATORS } from '../src/monaco/word-separators';
import { ROLE } from '../src/monaco/semantic-roles';
import { compileMonarch, driveLexer, driveLine, driveLines, stubMonaco, type CompiledLexer, type Emit } from './monarch-harness';

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
const KOJO_ID = 'kojo-legacy';

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

const keywordToken = (postfix: string): string => `${ROLE.keyword}${postfix}`;

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
    for (const line of ['CFLAG:ARG:口上セレクタ = 1', 'cflag:arg = 1', 'rand:2', 'mastername:arg = 1']) {
      const { emitted } = await emitErb(line);
      const variable = emitted.find((e) => e.token.startsWith(`${ROLE.variable}.`) && e.text.startsWith(line.split(' ')[0]!));
      expect(variable, `「${line}」没有整段 variable（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`).toBeDefined();
    }
  });

  // K6 批（2026-10-25）：语料实测「有词无档」的两枚引擎词进名单后的回归位。
  // 证据与取舍口径写在 `erb-language.ts` 的 `ERB_VARIABLE_FAMILY_HEADS` 头注
  // （`MASTERNAME` 两处都收 / `PLAYER` 只收显示层 / `CHILDNAME` 不收），
  // 名单 ⇄ 补全表的双向对拍在 `tests/erb-family-single-source.test.ts`。
  it('K6：`MASTERNAME:1 = 亲爱的` 与 `%MASTERNAME%` 裸形整段 variable（三形态大小写不敏感）', async () => {
    for (const line of ['MASTERNAME:1 = 亲爱的', 'mastername:1 = 达令', 'MasterNAME:ARG =']) {
      const { emitted } = await emitErb(line);
      const head = line.split(' ')[0]!;
      const variable = emitted.find((e) => e.token.startsWith(`${ROLE.variable}.`) && e.text === head);
      expect(variable, `「${line}」的「${head}」没进 variable（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`).toBeDefined();
    }
  });

  it('K6：`PLAYER` 作裸标量与作中段作用域都归 variable，且中段不许另起一枚（`TALENT:PLAYER:2` 一整枚）', async () => {
    const bare = await emitErb('IF TFLAG:103 == PLAYER');
    expect(bare.emitted.find((e) => e.text === 'PLAYER')?.token.startsWith(`${ROLE.variable}.`), '裸 PLAYER 没进 variable').toBe(true);
    const mid = await emitErb('TALENT:PLAYER:2 & 2');
    const texts = mid.emitted.map((e) => e.text);
    expect(texts, `中段被切碎：${texts.join(' / ')}`).not.toContain('PLAYER');
    expect(mid.emitted.find((e) => e.text === 'TALENT:PLAYER:2')?.token.startsWith(`${ROLE.variable}.`)).toBe(true);
  });

  it('字符串里的指令词不染 keyword（FORM 串内仍是 string）', async () => {
    const { emitted } = await emitErb('PRINTFORMW "CALL IF ENDCATCH"');
    const stringText = emitted.filter((e) => e.token.startsWith(`${ROLE.string}.`) || e.token.startsWith(ROLE.string));
    expect(stringText.map((e) => e.text).join('')).toContain('CALL IF ENDCATCH');
    expect(emitted.find((e) => (e.text === 'CALL' || e.text === 'IF' || e.text === 'ENDCATCH') && e.token.startsWith(`${ROLE.keyword}.`))).toBeUndefined();
  });

  it('行首注释整行 comment，其中的指令词不发射 keyword', async () => {
    const { emitted } = await emitErb('; CALL IF ENDCATCH 都是注释');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.token.startsWith(ROLE.comment)).toBe(true);
    expect(emitted[0]!.text).toContain('CALL IF ENDCATCH');
  });

  it('@ 函数定义与 $ 标签仍走专用档位', async () => {
    const fn = await emitErb('@EVENTFIRST');
    expect(fn.emitted.find((e) => e.text === '@')?.token.startsWith(`${ROLE.keyword}.`)).toBe(true);
    expect(fn.emitted.find((e) => e.text === 'EVENTFIRST')?.token.startsWith(`${ROLE.decl}.`)).toBe(true);
    const label = await emitErb('$LOOP_TOP');
    expect(label.emitted.find((e) => e.text === 'LOOP_TOP')?.token.startsWith(`${ROLE.label}.`)).toBe(true);
  });

  /**
   * ERB-PAINT-21 顺手收掉的一格：root 行首函数规则的禁集此前不含 `"`，于是「实参折行到行首」的
   * `@"…"`（真语料取样 22 行，全形如 `@"\@ STRLENS(x) ? %x% #…\@",60,LEFT…`）被整行吞成
   * `entity.name.function`——串层进不去，插值与三元一枚色都没有。现在 `"` 起串，两侧各钉一枚。
   */
  it('行首 `@"…"` 不是函数名：进 `str` 态，串内插值与内联三元照旧成档（禁集加 `"` 的那一格）', async () => {
    const lexer = await erbLexer();
    const post = lexer.tokenPostfix;
    const head = driveLine(lexer, '@"台\\@A?有#无\\@尾"');
    const joined = head.emitted.map((e) => `${e.text}=${e.token}`).join(' | ');
    expect(
      head.emitted.some((e) => e.token.startsWith(`${ROLE.decl}.`)),
      `行首 @" 仍被函数规则吞掉：${joined}`,
    ).toBe(false);
    expect(head.emitted.find((e) => e.text === '"')?.token, joined).toBe(`${ROLE.string}${post}`);
    expect(head.emitted.some((e) => e.text === '?' && e.token.startsWith(`${ROLE.escape}.`)), joined).toBe(true);
    expect(head.stack).toEqual(['root']);
    // 反方向不许松动：真函数名（不含引号）照旧走 entity 档
    const def = await emitErb('@PRINT_STATE');
    expect(def.emitted.find((e) => e.text === 'PRINT_STATE')?.token.startsWith(`${ROLE.decl}.`)).toBe(true);
  });

  it('#DIM / #DEFINE / #FUNCTION 与 [SKIPSTART] 仍为 keyword.preprocessor（大小写两形态）', async () => {
    for (const line of ['#DIM 口上セレクタ', '#DEFINE FOO', '#FUNCTION', '#dim x', '[SKIPSTART]']) {
      const { emitted } = await emitErb(line);
      expect(
        emitted.find((e) => e.token.startsWith(`${ROLE.directive}.`)),
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
      const keyword = rule(ROLE.keyword);
      const preprocessor = rule(ROLE.directive);
      const identifier = rule(ROLE.text);
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
    expect(tokens).toContain(ROLE.operator); // 上一批留下的那枚空档，钉住它别再漂回去
    // 只量 v1 三套：LAU-3 起缺省档就把 `kojo2-*` 三套也装配了（flag 守卫 + 动态 import），
    // 但那三套是**另一门语言**的调色板（规则表只有 15 枚 `kojo2.*`，见 `kojo2-theme.ts`），
    // ERB / kojo1 的 token 从来不在它们的判据面里。
    for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark'] as const) {
      const theme = captured.themes.get(id);
      if (!theme) throw new Error(`主题 ${id} 没被装配`);
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
      expect(upper.find((e) => e.text === word)?.token.startsWith(`${ROLE.engine}.`), `${word} 行首没进指令档`).toBe(true);
      const lower = driveLexer(lexer, word.toLowerCase());
      const lowerToken = lower.find((e) => e.text === word.toLowerCase())?.token ?? '<none>';
      expect(lowerToken.startsWith(`${ROLE.engine}.`), `${word.toLowerCase()} 不该吃原生指令档（实发 ${lowerToken}）`).toBe(false);
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
    expect(tokenOfWord(extra, 'ENDCATCH').startsWith(`${ROLE.keyword}.`)).toBe(true);
    const { emitted: adapter } = await emitErb('亲吻');
    expect(tokenOfWord(adapter, '亲吻').startsWith(`${ROLE.keyword}.`)).toBe(true);

    setErbDirectiveWords(monaco, null); // 收尾：回基底（不把测试词表留给同进程后续用例）
    const { emitted: restored } = await emitErb('ENDCATCH');
    expect(tokenOfWord(restored, 'ENDCATCH').startsWith(`${ROLE.keyword}.`)).toBe(true);
  });
});

/* ============================== ⑦ 工包 C：着色层与语义层同口径（尾注释 / 串态 / 全角标点） ============================== */

describe('着色层与语义层同口径（erb-parser/references.ts codeViewOf 是唯一真相，正反面各钉）', () => {
  it('① 行尾 `;` 之后整段 comment：PRINTL 台词 ;说明 的「说明」不再是 identifier', async () => {
    const { emitted } = await emitErb('PRINTL 台词 ;说明');
    expect(emitted.find((e) => e.text === '台词')?.token.startsWith(`${ROLE.text}.`)).toBe(true);
    expect(emitted.filter((e) => e.token.startsWith(`${ROLE.comment}.`)).map((e) => e.text).join('')).toBe(';说明');
    expect(emitted.find((e) => e.text === '说明'), '注释尾巴不许有第二处发射').toBeUndefined();
  });

  it('①b 反面：串里的 `;` 不当注释；串闭合后的行尾 `;` 恢复注释', async () => {
    const inside = await emitErb('PRINTL "台词;说明"');
    expect(inside.emitted.some((e) => e.token.startsWith(`${ROLE.comment}.`))).toBe(false);
    expect(inside.emitted.filter((e) => e.token.startsWith(ROLE.string)).map((e) => e.text).join('')).toContain('台词;说明');
    const after = await emitErb('PRINTL "台词" ;说明');
    expect(after.emitted.filter((e) => e.token.startsWith(`${ROLE.comment}.`)).map((e) => e.text).join('')).toBe(';说明');
  });

  it('①c 变量段不许吞尾注释：CFLAG:ARG;说明 ⇒ variable 止于 `;`、其后 comment', async () => {
    const { emitted } = await emitErb('CFLAG:ARG;说明');
    expect(emitted.find((e) => e.text === 'CFLAG:ARG')?.token.startsWith(`${ROLE.variable}.`)).toBe(true);
    expect(emitted.filter((e) => e.token.startsWith(`${ROLE.comment}.`)).map((e) => e.text).join('')).toBe(';说明');
  });

  it('② 未闭合引号只染到本行行尾、下一行恢复正常；闭合串回根态（codeViewOf 逐行刷白的口径）', async () => {
    const lexer = await erbLexer();
    const closed = driveLine(lexer, 'PRINTL "闭合"');
    expect(closed.stack).toEqual(['root']);
    const open = driveLine(lexer, 'PRINTL "尾未闭合');
    expect(open.emitted.find((e) => e.text === '尾未闭合')?.token.startsWith(`${ROLE.string}.`)).toBe(true);
    expect(open.stack, '串态绝不带过行界').toEqual(['root']);
    const next = driveLine(lexer, 'PRINTL 正常', open.stack);
    expect(next.emitted.some((e) => e.token.startsWith(`${ROLE.string}.`))).toBe(false);
    expect(next.emitted.find((e) => e.text === 'PRINTL')?.token.startsWith(`${ROLE.keyword}.`)).toBe(true);
  });

  it('②b 串内 % FORM 层同样行尾出栈（嵌套态不留到下一行）', async () => {
    const lexer = await erbLexer();
    const open = driveLine(lexer, 'PRINTL "前段%ＦＯＲＭ');
    expect(open.stack).toEqual(['root']);
    const next = driveLine(lexer, 'PRINTL 正常', open.stack);
    expect(next.emitted.some((e) => e.token.startsWith(`${ROLE.string}.`))).toBe(false);
  });

  it('③ 全角标点有确定归属（operator，非空 token）；全角 `；` 不当行尾注释（语义层只认半角 0x3B）', async () => {
    for (const ch of ['：', '，', '。', '（', '）', '、', '；', '！', '？', '「', '」', '『', '』', '《', '》', '【', '】', '｛', '｝', '＿', '＄']) {
      const { emitted } = await emitErb(`PRINTL 台词${ch}说明`);
      const hit = emitted.find((e) => e.text.includes(ch));
      expect(hit, `「${ch}」坠进空 defaultToken`).toBeDefined();
      expect(hit!.token.startsWith(`${ROLE.operator}.`), `「${ch}」应归 operator，实发 ${hit!.token}`).toBe(true);
      expect(emitted.some((e) => e.token.startsWith(`${ROLE.comment}.`)), `全角「${ch}」不许触发注释`).toBe(false);
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
      expect(hit!.token.startsWith(`${ROLE.operator}.`), `「${ch}」U+${ch.codePointAt(0)!.toString(16).toUpperCase()} 应归 operator，实发 ${hit!.token}`).toBe(true);
      expect(emitted.some((e) => e.token.startsWith(`${ROLE.comment}.`)), `全角「${ch}」不许触发注释`).toBe(false);
    }
  });

  it('③b 全角字母数字进标识符族（反向索引 ａ-ｚ 与 MODEL_TOKEN_CLASS 的记号口径同向），不落空 token', async () => {
    const { emitted } = await emitErb('ＲＡＮＤ １２３');
    expect(emitted.find((e) => e.text === 'ＲＡＮＤ')?.token.startsWith(`${ROLE.text}.`)).toBe(true);
    expect(emitted.find((e) => e.text === '１２３')?.token.startsWith(`${ROLE.text}.`)).toBe(true);
  });

  it('④ 行首注释口径不回退：整行仍一段 comment（首个规则吃下，不产生二次发射）', async () => {
    const { emitted } = await emitErb('; PRINTL 台词 ; 说明');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.token.startsWith(`${ROLE.comment}.`)).toBe(true);
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
    expect(of('{').startsWith(`${ROLE.escape}.`), `{ 实发 ${of('{')}`).toBe(true);
    expect(of('}').startsWith(`${ROLE.escape}.`), `} 实发 ${of('}')}`).toBe(true);
    expect(of('LOCAL:1').startsWith(`${ROLE.variable}.`), `层内实发 ${of('LOCAL:1')}`).toBe(true);
    expect(of('台词').startsWith(`${ROLE.string}.`), '串内字面段仍是 string').toBe(true);
    expect(of('尾巴').startsWith(`${ROLE.string}.`), '层后字面段仍是 string').toBe(true);
    expect(line.stack, '闭合串回根态').toEqual(['root']);
  });

  it('② `%…%` 层不因规则序调整而回退（与 `{}` 同一档形态：escape + variable）', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "台词%CALLNAME:MASTER%尾巴"');
    const percents = line.emitted.filter((e) => e.text === '%');
    expect(percents).toHaveLength(2);
    expect(percents.every((e) => e.token.startsWith(`${ROLE.escape}.`))).toBe(true);
    expect(line.emitted.find((e) => e.text === 'CALLNAME:MASTER')?.token.startsWith(`${ROLE.variable}.`)).toBe(true);
    expect(line.stack).toEqual(['root']);
  });

  it('③ 反面：`\\{` 是转义出来的字面括号，留在 string 层、不开插值层（expr.ts 的 `\\` 吞一字符口径）', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "字面\\{LOCAL:1\\}尾巴"');
    expect(line.emitted.some((e) => e.token.startsWith(`${ROLE.variable}.`)), `转义括号不许开层：${line.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toBe(false);
    expect(line.emitted.some((e) => e.token.startsWith(`${ROLE.escape}.`))).toBe(false);
    expect(line.emitted.filter((e) => e.token.startsWith(`${ROLE.string}.`)).map((e) => e.text).join('')).toBe('"字面\\{LOCAL:1\\}尾巴"');
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
        line.emitted.some((e) => e.token.startsWith(`${ROLE.variable}.`)),
        `「${open}」把未闭合的残段染成了表达式：${line.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`,
      ).toBe(false);
      const next = driveLine(lexer, 'PRINTL 正常', line.stack);
      expect(next.emitted.some((e) => e.token.startsWith(`${ROLE.string}.`)), `「${open}」把下一行也染成串了`).toBe(false);
      expect(next.emitted.find((e) => e.text === 'PRINTL')?.token.startsWith(`${ROLE.keyword}.`)).toBe(true);
    }
  });

  it('⑤ 落单记号（`"…{"` / `"…50%"`）不冒充开层记号，也不吞掉闭合引号（bracket 配对计数守恒）', async () => {
    const lexer = await erbLexer();
    for (const line of ['PRINTL "台词{"', 'PRINTL "完成率50%"']) {
      const drive = driveLine(lexer, line);
      expect(drive.stack, `「${line}」应正常闭合`).toEqual(['root']);
      const quote = drive.emitted.filter((e) => e.text === '"' && e.token.startsWith(`${ROLE.string}.`));
      expect(quote, `「${line}」丢了闭合引号：${drive.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toHaveLength(2);
      expect(drive.emitted.some((e) => e.token.startsWith(`${ROLE.variable}.`))).toBe(false);
      expect(drive.emitted.some((e) => e.token.startsWith(`${ROLE.escape}.`))).toBe(false);
    }
  });

  it('⑥ Emuera 的 `""` 字面引号：着色层"闭合+立刻重开"两次翻转落回同一侧，可见颜色与语义层同口径', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "含""转义"的文字');
    // 语义层（erb-completion-context.ts 的 erbCodeViewBlocked）认 `""` 是一枚字面引号、仍在串内；
    // 着色层按"闭合 + 立刻重开"处理——两次翻转后 `转义` 仍归 string、`的文字` 仍归代码，
    // 与"什么是串"的可见结果同口径（差异只在 bracket 配对计数，不在本工包三件里，故只钉不改）。
    expect(line.emitted.find((e) => e.text === '转义')?.token.startsWith(`${ROLE.string}.`), '转义 应仍是串内 string').toBe(true);
    expect(line.emitted.find((e) => e.text === '的文字')?.token.startsWith(`${ROLE.text}.`), '的文字 应在串外').toBe(true);
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
      expect(head?.token, `${prefix} 应落预处理档（与 #DIM 同色），不是 comment`).toMatch(/^role\.directive/);
      expect(
        line.emitted.find((e) => e.text === 'PRINTL')?.token.startsWith(`${ROLE.keyword}.`),
        `${prefix} 之后的语句应仍是关键字色`,
      ).toBe(true);
      expect(line.emitted.some((e) => e.token.startsWith(ROLE.comment)), `${prefix} 行不许整行染成注释`).toBe(false);
    }
  });

  it('普通 `;` 行仍是整行注释（前缀规则不得放宽）', async () => {
    const line = driveLine(await erbLexer(), ';PRINTL あ');
    expect(line.emitted.some((e) => e.token.startsWith(ROLE.comment))).toBe(true);
    // 整行一枚注释 token：不许漏出任何 keyword（`PRINTL` 在注释里不是指令）
    expect(line.emitted.some((e) => e.token.startsWith(ROLE.keyword)), '注释行漏出关键字色').toBe(false);
  });

  it('`\'=` 是运算符：`STR \'= TSTR:0 + "ABC"` 里 `\'=` 单独一枚 operator，`+` 口径不变', async () => {
    const line = driveLine(await erbLexer(), 'STR \'= TSTR:0 + "ABC"');
    expect(line.emitted.find((e) => e.text === "'=")?.token.startsWith(ROLE.operator), "'= 应是 operator").toBe(true);
    expect(line.emitted.find((e) => e.text === '+')?.token.startsWith(ROLE.operator)).toBe(true);
    // 回归：`STR` 之后的串照旧进 string，`'=` 没把引号吃掉
    expect(line.emitted.find((e) => e.text === 'ABC')?.token.startsWith(`${ROLE.string}.`)).toBe(true);
  });
});

/* ============================== ⑨ 预处理器条件块 `[IF…]`/`[ELSE]`/`[ENDIF]` 着色 ==============================

/**
 * ERB 体感批 K1：`[...]` 预处理条件块此前显示层完全没跟上——`[IF_DEBUG]` 整行白字、
 * `[IF x]` 里的 `IF` 反被 `standaloneKeyword` 当 ERB 控制词着色。判据从契约真源
 * （`plugin-api/erb.ts` 的 `ERB_PREPROC_PATTERNS`）派生，档位复用既有 `keyword.preprocessor`。
 * 三条规则排在 SKIP 两条之后、`standaloneKeyword` 之前；整行严格等值才认（ASCII 画里的
 * 方括号行、裸 `[IF]` 不误伤）。走真 Monarch 编译逐词发射（⑦⑧ 同一基座）。
 */
describe('ERB 预处理器条件块着色（整行 → keyword.preprocessor；判据取契约真源）', () => {
  /** 正例：大写 / 小写 / 混合 + 前导缩进 / 行尾空白，各应整行出一枚 keyword.preprocessor */
  const recognized: readonly string[] = [
    '[IF x]',
    '[IF_DEBUG]',
    '[IF_NDEBUG]',
    '[ELSE]',
    '[ELSEIF y]',
    '[ENDIF]',
    '[if x]',
    '[If_Debug]',
    '[endif]',
    '[elseif z]',
    '  [IF a]  ', // 前导缩进 + 行尾空白（真源 trim 后等值 → Monarch 靠 `^\s*…\s*$` 放行）
    '\t[ENDIF]\t',
  ];
  for (const line of recognized) {
    it(`「${JSON.stringify(line)}」整行出 keyword.preprocessor（一条规则吃下，无二次发射）`, async () => {
      const { emitted } = await emitErb(line);
      expect(
        emitted.every((e) => e.token.startsWith(`${ROLE.directive}.`)),
        `「${line}」实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`,
      ).toBe(true);
      expect(emitted, `「${line}」应恰一枚发射（整行一条规则）`).toHaveLength(1);
      expect(emitted[0]!.text, `「${line}」匹配体应是整行原样`).toBe(line);
    });
  }

  it('`[IF x]` 里的 `IF` 不被控制词档截胡：整行一枚、不单独成词', async () => {
    const { emitted } = await emitErb('[IF CALL]');
    // 内层 `IF` / `CALL` 不再作为独立发射点出现（整行被预处理器规则吃掉）
    expect(emitted.some((e) => e.text === 'IF' || e.text === 'CALL'), `漏出发射：${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.token.startsWith(`${ROLE.directive}.`)).toBe(true);
    // 反向兜底：确认裸 `IF`（不带方括号）仍走控制词档——本规则只吃 `[` 起手整行等值形
    const bareIf = await emitErb('IF 1');
    expect(bareIf.emitted.find((e) => e.text === 'IF')?.token.startsWith(`${ROLE.keyword}.`)).toBe(true);
    expect(bareIf.emitted.find((e) => e.text === 'IF')?.token.startsWith(`${ROLE.directive}.`)).toBe(false);
  });

  /** 反面：非整行等值形一律不算块（ASCII 方括号画 / 裸形 / 缺参数 / 粘连词），绝不出 preprocessor 档 */
  const rejected: readonly string[] = [
    '[ 1 2 3 ]', // ASCII 画里的方括号行
    '[IF]', // 裸形：open 要 `IF\s+…\S`，无空格无参数 ⇒ 不成块
    '[IF ]', // 只有空格、无条件参数
    '[ENDIF ]', // `]` 前有杂质
    '[ELSEIFFY]', // 粘连词，非 ELSEIF/ELSE
  ];
  for (const line of rejected) {
    it(`「${JSON.stringify(line)}」不是预处理器块标记（不误伤 ASCII / 裸形）`, async () => {
      const { emitted } = await emitErb(line);
      expect(
        emitted.some((e) => e.token.startsWith(`${ROLE.directive}.`)),
        `「${line}」被误判为块：${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`,
      ).toBe(false);
    });
  }

  it('预处理器标记落在 [SKIPSTART] 块内仍走 raw 不透明档（块内是死代码，着色层不认块边界）', async () => {
    const lexer = await erbLexer();
    const per = driveLines(lexer, ['[SKIPSTART]', '[IF x]', '[ENDIF]', '[SKIPEND]']);
    // 块内两行整体 raw（skip 态的 `.*$` 吃掉整行，root 的预处理器规则进不来）
    expect(per[1]!.every((e) => e.token.startsWith(ROLE.raw)), `块内 [IF x] 实发 ${per[1]!.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toBe(true);
    expect(per[2]!.every((e) => e.token.startsWith(ROLE.raw))).toBe(true);
    // [SKIPEND] 退回 root：块外 [ENDIF] 恢复 keyword.preprocessor
    const after = driveLines(lexer, ['[SKIPSTART]', '[ENDIF]', '[SKIPEND]', '[ENDIF]']);
    expect(after[3]![0]?.token.startsWith(`${ROLE.directive}.`)).toBe(true);
  });
});

/* ============================== ⑩ 内联文本形三元 `\@条件?真#假\@` 边界着色 ==============================

/**
 * ERB 体感批（接 K1 显示层）：`\@…\@` 此前整段落在 `string` 里**没有任何结构感**。本节钉四件事：
 * ① 整形状才涂——开闭 `\@`/`?`/`#` 落既有 `string.escape`（`{}`/`%%` 插值边界同档），
 *    `<条件>` 落 `variable`（`strExpr` 层内同档），真/假文落 `string`（inline.ts："真 / 假两段
 *    只是**输出文本**"），三档全部现成、零新造、theme/CSS 未动；
 * ② 残形不涂——缺 `?` / 缺 `#` / 未闭合 `\@` / 空条件，一枚边界档都不产（落 ① 普通转义回退）；
 * ③ 顶层判据不越——段内撞 `"` `\` `%` `{` `}` 或未配平括号 ⇒ 整体弃涂；**既有 `{…}`/`%…%`
 *    插值着色零回退**（弃涂后走 ④⑤ 老路），`PRINTFORM "#text"` 的 `#` 不受影响；
 * ④ 保守对拍方向——着色层涂出的每一枚开记号，语义真源 `scanTextTernaries` 必在同一列认得
 *    （涂 ⊆ 认；反方向"认全"由 K2 插值门 + lead 跨面对拍兜，本层宁窄）。
 * 走真 Monarch 编译逐词发射（⑦⑧⑨ 同一基座）。
 */
describe('内联文本形三元着色（串内 ⓪ + 裸文本行；只复用 string.escape / variable / string 三档）', () => {
  /** 逐词表：`text → token`（同名多次出现按序取） */
  function tokenMap(emitted: readonly Emit[]): (text: string, nth?: number) => string {
    return (text, nth = 0) => {
      const hits = emitted.filter((e) => e.text === text);
      return hits[nth]?.token ?? '<none>';
    };
  }

  it('① 串内整形状：七段各归其档，条件段一整枚 variable（不被变量族/运算符切碎），闭合回根态', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "台词\\@CFLAG:0>0?是#否\\@尾巴"');
    const post = lexer.tokenPostfix;
    const of = tokenMap(line.emitted);
    expect(of('\\@'), `开记号实发 ${of('\\@')}`).toBe(`${ROLE.escape}${post}`);
    expect(of('\\@', 1), '收记号应与开记号同档').toBe(`${ROLE.escape}${post}`);
    expect(of('CFLAG:0>0'), '条件段必须一整枚 variable').toBe(`${ROLE.variable}${post}`);
    expect(of('?')).toBe(`${ROLE.escape}${post}`);
    expect(of('#')).toBe(`${ROLE.escape}${post}`);
    expect(of('是')).toBe(`${ROLE.string}${post}`);
    expect(of('否')).toBe(`${ROLE.string}${post}`);
    expect(of('台词')).toBe(`${ROLE.string}${post}`);
    expect(of('尾巴')).toBe(`${ROLE.string}${post}`);
    expect(line.stack).toEqual(['root']);
  });

  it('①b 配平 `(…)`/`[…]` 段块与一枚串里多形并存：真假段里的 `?` 是正文、不吃边界档', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "a\\@(A||B)&&C?是(真)?#否\\@b\\@CFLAG[1]==2?y#n\\@c"');
    const post = lexer.tokenPostfix;
    const of = tokenMap(line.emitted);
    // ERB-PAINT-21 起 `str` 态走相位机：条件段按"正文跑动 / 括号整块"分段发射，**同归 variable 一档**
    // （上一批的整形状群组一次吐一整枚 `(A||B)&&C`；分段只是把同一颜色切成几块，不是降级）
    expect(of('(A||B)'), `括号条件块实发 ${of('(A||B)')}`).toBe(`${ROLE.variable}${post}`);
    expect(of('&&C'), `括号后的条件跑动实发 ${of('&&C')}`).toBe(`${ROLE.variable}${post}`);
    expect(of('是'), '真段归 string').toBe(`${ROLE.string}${post}`);
    expect(of('(真)'), '真段里的括号整块仍是 string').toBe(`${ROLE.string}${post}`);
    expect(of('CFLAG'), `方括号条件段首块实发 ${of('CFLAG')}`).toBe(`${ROLE.variable}${post}`);
    expect(of('[1]'), `方括号整块实发 ${of('[1]')}`).toBe(`${ROLE.variable}${post}`);
    // 真段正文问号：`是(真)?` 的那枚 `?` 不是分隔符 ⇒ 出 string、绝不出 escape
    const plainQuestion = line.emitted.filter((e) => e.text === '?' && !e.token.startsWith(`${ROLE.escape}.`));
    expect(plainQuestion, '真段正文里的 `?` 必须存在且不占边界档').toHaveLength(1);
    // 两枚三元共 8 枚边界（4×`\@` + 2×`?` + 2×`#`）全部 string.escape，别无 escape 发射
    const bounds = line.emitted.filter((e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(`${ROLE.escape}.`));
    expect(bounds.map((e) => e.text).join(''), '\\@?#\\@\\@?#\\@');
    expect(line.emitted.filter((e) => e.token === `${ROLE.escape}${post}`)).toHaveLength(8);
    expect(line.stack).toEqual(['root']);
  });

  /** 残形名册：缺 `?` / 缺 `#`（inline.ts 认、着色层取窄）/ 未闭合 / 空条件——一枚边界档都不许产 */
  const malformed: readonly string[] = [
    'PRINTL "a\\@b\\@c"', // 缺 ?
    'PRINTL "a\\@?b#c\\@d"', // 空条件
    'PRINTL "a\\@b?c\\@d"', // 缺 #（无 else 形）
    'PRINTL "a\\@b?c#d"', // 未闭合 \@（本行没有收记号）
    'PRINTL "a\\@b?c#d\\@e', // 未闭合引号 + 已闭合三元 ⇒ 形状认，但残引号闸照常
  ];
  it('② 残形不产结构档：`?`/`#`/`\\@` 零枚 escape、条件不冒充 variable（未闭合引号吸收不破坏）', async () => {
    const lexer = await erbLexer();
    for (const src of malformed.slice(0, 4)) {
      const line = driveLine(lexer, src);
      const boundary = line.emitted.filter(
        (e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(`${ROLE.escape}.`),
      );
      expect(boundary, `「${src}」残形产了边界档：${boundary.map((e) => e.text).join('')}`).toHaveLength(0);
      expect(line.stack, `「${src}」状态栈必须出干净`).toEqual(['root']);
    }
    // 第 5 条形本身完整 ⇒ 边界照涂，但行尾未闭合引号仍被 ⑨ 吸收、栈出干净（纪律②③ 的闸不松）
    const tail = driveLine(lexer, malformed[4]!);
    expect(tail.emitted.some((e) => e.text === '?' && e.token.startsWith(`${ROLE.escape}.`))).toBe(true);
    expect(tail.stack).toEqual(['root']);
    const next = driveLine(lexer, 'PRINTL 正常', tail.stack);
    expect(next.emitted.some((e) => e.token.startsWith(`${ROLE.string}.`)), '残引号不许把下一行染成串').toBe(false);
  });

  it('③a `PRINTFORM "#text"` 的 `#` 与串内孤立 `#`/`?` 不受影响（`#` 只在整形状认过 `?` 之后才算分隔）', async () => {
    const lexer = await erbLexer();
    for (const src of ['PRINTFORM "#text"', 'PRINTL "#没有三元"', 'PRINTL "a?b#c"']) {
      const line = driveLine(lexer, src);
      expect(
        line.emitted.filter((e) => e.token.startsWith(`${ROLE.escape}.`)),
        `「${src}」不该产任何结构边界档`,
      ).toHaveLength(0);
      expect(line.emitted.filter((e) => e.token.startsWith(`${ROLE.variable}.`))).toHaveLength(0);
      expect(line.stack).toEqual(['root']);
    }
  });

  /**
   * **ERB-PAINT-21 翻面档**（2026-10-26）：这几形上一批是"整枚弃涂"，本批起相位机吃下——
   * 段内 `%…%` / `{…}` 交给 `strStr` / `strExpr` 既有两层（边界 escape + 内容 variable，
   * 一条着色都不回退），括号内的 `?` / `#` 是真源 `findTopLevel` 追深度管到的内容。
   */
  const nowPainted: readonly { line: string; brace: boolean }[] = [
    { line: 'PRINTL "台\\@{LOCAL:1}>1?a#b\\@尾"', brace: true }, // 条件段带 {} 插值
    { line: 'PRINTL "x\\@A?{N}#b\\@y"', brace: true }, // 真段带 {} 插值
    { line: 'PRINTL "x\\@f(A?B)?c#d\\@y"', brace: false }, // 括号内含 ?：真源追深度 ⇒ 界在括号后那枚
    { line: 'PRINTL "x\\@A?b(c#d)#e\\@y"', brace: false }, // 真段括号内含 #：同理，分隔符是括号后那枚
    { line: 'PRINTL "x\\@((A))?b#c\\@y"', brace: false }, // 两层嵌套括号
    { line: 'PRINTL "x\\@(((A)))?b#c\\@y"', brace: false }, // 三层
    { line: 'PRINTL "x\\@((((A))))?b#c\\@y"', brace: false }, // 四层＝本层上限（`pair` 外壳 + `nestLeaf` 内两层再夹一枚）
  ];
  it('③b 段内插值 / 括号内含界记号 ⇒ **现在成色**（相位机），且插值层 escape+variable 一条不少', async () => {
    const lexer = await erbLexer();
    const post = lexer.tokenPostfix;
    for (const { line: src, brace } of nowPainted) {
      const line = driveLine(lexer, src);
      const bounds = line.emitted.filter(
        (e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(`${ROLE.escape}.`),
      );
      expect(bounds.length, `「${src}」应涂出边界档（实发 ${line.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`).toBeGreaterThan(0);
      // 每枚三元三枚边界：开 `\@` + `?` + `#` + 收 `\@` = 4
      expect(bounds.map((e) => e.text).join(''), `「${src}」边界序列`).toBe('\\@?#\\@');
      if (brace) {
        // 插值层照旧出 `{`/`}` escape + 层内 variable ⇒ 既有着色一层不少（本批判据的硬约束）
        expect(line.emitted.some((e) => ['{', '}'].includes(e.text) && e.token === `${ROLE.escape}${post}`), `「${src}」花括号插值层被波及`).toBe(true);
      }
      expect(line.emitted.some((e) => e.token === `${ROLE.variable}${post}`), `「${src}」没有 variable 发射`).toBe(true);
      expect(line.stack, `「${src}」栈必须出干净`).toEqual(['root']);
    }
  });

  /**
   * 拒收名册（相位机**照样不涂**的形状，一枚边界档都不许产）：这几形真源要么不认、
   * 要么本层刻意取窄。`%`/`{` 未配对 / 括号深过四层 / 段内反斜杠 / 界前全空白。
   */
  const stillRefused: readonly string[] = [
    'PRINTL "x\\@A%B?c#d\\@y"', // `%` 没配对：guard 吃不下，落 ① 普通转义
    'PRINTL "x\\@(((((A)))))?b#c\\@y"', // 五层括号：本层给到四层（真源认，方向=窄）
    'PRINTL "x\\@A{B?c#d\\@y"', // 未配平的 `{`：guard 吃不下 ⇒ ② 那条"本行等不到闭合就出栈"照旧兜住
    'PRINTL "x\\@A\\\\B?c#d\\@y"', // 段内撞反斜杠
    'PRINTL "a\\@ ?b#c\\@d"', // 界前全空白 ⇒ `inline.ts` 的 cond trim 后为空，**真源也不认**
  ];
  it('③c 拒收名册照样零枚 escape（含"段内全空白"——上一批这格反而比真源宽，本批按 `cond` 含非空白堵掉）', async () => {
    const lexer = await erbLexer();
    for (const src of stillRefused) {
      const line = driveLine(lexer, src);
      const boundary = line.emitted.filter(
        (e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(`${ROLE.escape}.`),
      );
      expect(boundary, `「${src}」拒收形产了边界档：${boundary.map((e) => e.text).join('')}`).toHaveLength(0);
      expect(line.stack, `「${src}」栈必须出干净`).toEqual(['root']);
    }
    // 反证真源同向不认：`\@ ?b#c\@` 的 cond trim 后为空 ⇒ `scanTextTernaries` 也不产这一枚
    expect(scanTextTernaries('a\\@ ?b#c\\@d')).toHaveLength(0);
    // 而真源认得 `\@(((((A)))))?b#c\@`（括号深度它一路追）⇒ 本层弃涂是**单向取窄**，不是漏涂口径错
    expect(scanTextTernaries('x\\@(((((A)))))?b#c\\@y').map((c) => c.column)).toEqual([1]);
  });

  it('④ 裸文本行（PRINTDATA 体位）同形状同档位；行尾 `;` 注释与未闭合残形都不被形状吞', async () => {
    const lexer = await erbLexer();
    const bare = driveLine(lexer, '\\@CFLAG:0>0?是#否\\@');
    const post = lexer.tokenPostfix;
    const of = tokenMap(bare.emitted);
    expect(of('CFLAG:0>0')).toBe(`${ROLE.variable}${post}`);
    expect(of('是')).toBe(`${ROLE.string}${post}`);
    expect(of('#')).toBe(`${ROLE.escape}${post}`);
    expect(of('\\@', 1)).toBe(`${ROLE.escape}${post}`);
    // 整口吃掉 = 条件段一整枚（无规则时变量族会在 `>` 处把 `CFLAG:0` 切碎先行发射——碎片不许出现）
    expect(bare.emitted.some((e) => e.text === 'CFLAG:0'), `条件被变量族切碎：${bare.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toBe(false);
    expect(bare.stack).toEqual(['root']);

    const withComment = driveLine(lexer, '\\@A?a#b\\@ ;注');
    expect(withComment.emitted.filter((e) => e.token.startsWith(`${ROLE.comment}.`)).map((e) => e.text).join('')).toBe(';注');
    expect(withComment.emitted.some((e) => e.text === '?' && e.token.startsWith(`${ROLE.escape}.`))).toBe(true);

    const acrossSemi = driveLine(lexer, '\\@A;B?a#b\\@'); // root 段禁 `;`：形状不许跨注释界
    expect(acrossSemi.emitted.filter((e) => e.token.startsWith(`${ROLE.escape}.`)), `实发 ${acrossSemi.emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toHaveLength(0);

    const unclosed = driveLine(lexer, '\\@CFLAG:0?a#b'); // 未闭合裸形：零枚 escape
    expect(unclosed.emitted.filter((e) => e.token.startsWith(`${ROLE.escape}.`))).toHaveLength(0);

    const inSkip = driveLines(lexer, ['[SKIPSTART]', '\\@A?a#b\\@', '[SKIPEND]']);
    expect(inSkip[1]!.every((e) => e.token.startsWith(ROLE.raw)), '停用块内的同形文本仍是死代码 raw').toBe(true);
  });

  it('⑤ 一枚串两层混排：`{插值}` 与 `\\@三元\\@` 各自成档互不干扰', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "前{ITEM:45}中\\@A>1?有#无\\@后"');
    const of = tokenMap(line.emitted);
    expect(of('ITEM:45')).toBe(ROLE.variable + lexer.tokenPostfix); // strExpr 老档
    expect(of('{')).toBe(`${ROLE.escape}${lexer.tokenPostfix}`);
    expect(of('A>1')).toBe(ROLE.variable + lexer.tokenPostfix); // 三元条件新档
    expect(of('?')).toBe(`${ROLE.escape}${lexer.tokenPostfix}`);
    expect(of('后')).toBe(ROLE.string + lexer.tokenPostfix);
    expect(line.stack).toEqual(['root']);
  });

  it('⑥ 保守对拍（语义真源）：每一枚涂出的三元（`\@`+条件+`?` 相邻三发射），真源 `scanTextTernaries` 必认得同文条件（涂 ⊆ 认）', async () => {
    const lexer = await erbLexer();
    const post = lexer.tokenPostfix;
    const samples = [
      'PRINTL "台词\\@CFLAG:0>0?是#否\\@尾巴"',
      'PRINTL "a\\@(A||B)&&C?是(真)?#否\\@b\\@CFLAG[1]==2?y#n\\@c"',
      'PRINTL "前{ITEM:45}中\\@A>1?有#无\\@后"',
      '\\@CFLAG:0>0?是#否\\@',
      '\\@A?a#b\\@ ;注',
      ...malformed,
      ...nowPainted.map((n) => n.line),
      ...stillRefused,
      'PRINTFORM "#text"',
    ];
    for (const src of samples) {
      const { emitted } = driveLine(lexer, src);
      // 开记号/条件/界记号是整形状的相邻三发射；孤立 variable（如 `{ITEM:45}` 层内）不满足邻居条件
      const paintedConds = emitted
        .filter(
          (e, i) =>
            e.token === `${ROLE.variable}${post}` &&
            emitted[i - 1]?.text === '\\@' && emitted[i - 1]?.token === `${ROLE.escape}${post}` &&
            emitted[i + 1]?.text === '?' && emitted[i + 1]?.token === `${ROLE.escape}${post}`,
        )
        .map((e) => e.text.trim());
      const recognized = scanTextTernaries(src).map((c) => c.text);
      for (const cond of paintedConds) {
        expect(
          recognized.includes(cond),
          `「${src}」着色层把条件「${cond}」认成三元，真源 scanTextTernaries 却不认（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`,
        ).toBe(true);
      }
    }
  });
});

