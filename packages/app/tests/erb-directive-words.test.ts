/**
 * T5 · Monarch directive 词表同源化（`mergeDirectiveWords` / `setErbDirectiveWords`）单测。
 *
 * 纯函数（两表进、合并词表出）+ 假 Monaco（只记录 `setMonarchTokensProvider` 与句柄
 * dispose，无运行时依赖）。覆盖：并集、大小写不敏感去重、排序确定、`extra` 缺席回基底；
 * 重设句柄纪律：重设时 dispose 旧 provider、`null` 回基底（项目切换不残留上一项目词表）。
 *
 * 本批追加（口上高频子集补齐，缺陷①）：
 * ① 语料高频缺失名钉在 `ERB_DIRECTIVES`（简报例名 13 个 + 实测 ≥1000 的 GETNUM；
 *   真源 = 包叶 `@kojo/erb-vocab/directives` 的派生判据 + 插件两张词表，全表在
 *   `erb-highlight-words.ts` 物化）；
 * ② `.kojo` 侧 `ERB_COMMANDS` ≡ `ERB_DIRECTIVES` 去族头（派生恒等式，无第二份清单）；
 * ③ 宿主源码零手抄扫描守卫：kojo-language / erb-language 的字面量里不许出现指令词抄本。
 *
 * K5 批追加（2026-10-25，eraTW 4.980 语料档）：证据表按频次插位 +11 行（≥10 档全收）、
 * 3~9 档 32 词拒收名单钉墙、逐词原样语句样例经同一判据回扫、`.kojo` 派生面逐词点名。
 *
 * 活语料闸分母升级（同批，lead 裁决）：「每词 ≥1 命中」从**单盘**改成**跨证据三层**
 * （主盘 → 其余在盘语料 → 引擎二进制串面，三层全无照旧红），并钉死四枚 eraNAS 口径词
 * 各走第几层。判据是**加层不是放宽**：层 2/3 用与主盘同一把真语句判据，层 1 逐字保留。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_DIRECTIVES, ERB_STATEMENT_DIRECTIVES, mergeDirectiveWords, setErbDirectiveWords } from '../src/monaco/erb-language';
import { ERB_COMMANDS, ERB_FAMILY_HEADS } from '../src/monaco/kojo-language';
import { ERB_HIGHLIGHT_WORDS } from '../src/monaco/erb-highlight-words';
import { ERB_CONTROL_STATEMENTS } from '@kojo/plugin-erb-parser';
import { decodeWithProbe } from '../../kernel/src/encoding';

describe('mergeDirectiveWords（纯函数：两表进、合并词表出）', () => {
  it('并集：基底 + adapter 词表全量在列', () => {
    const merged = mergeDirectiveWords(['PRINTL', 'CALL'], ['亲吻', '摸屁股']);
    expect(merged).toContain('PRINTL');
    expect(merged).toContain('CALL');
    expect(merged).toContain('亲吻');
    expect(merged).toContain('摸屁股');
    expect(merged).toHaveLength(4);
  });

  it('大小写不敏感去重（先出现者保留原样——基底在前，英文指令保持基底写法）', () => {
    expect(mergeDirectiveWords(['CALL', 'PRINT'], ['call', 'PRINTL', 'CallForm'])).toEqual([
      'CALL',
      'CallForm',
      'PRINT',
      'PRINTL',
    ]);
    // 大小写兄弟词（同归一化键）不产生重复项
    expect(mergeDirectiveWords(['CALL'], ['CALL', 'call'])).toEqual(['CALL']);
  });

  it('排序确定：同一输入恒得同一顺序（按码元比较，不依赖 locale）', () => {
    const a = mergeDirectiveWords(['IF', 'PRINT', 'CALL'], ['亲吻', '摸屁股']);
    const b = mergeDirectiveWords(['IF', 'PRINT', 'CALL'], ['亲吻', '摸屁股']);
    expect(a).toEqual(b);
    const sorted = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(a).toEqual(sorted);
  });

  it('extra 缺席（adapter 表缺席 / 未提供枚举能力）⇒ 基底的确定性排序拷贝（不动原数组）', () => {
    const base = ['B', 'A'];
    const out = mergeDirectiveWords(base, undefined);
    expect(out).toEqual(['A', 'B']);
    expect(base).toEqual(['B', 'A']);
    expect(mergeDirectiveWords(base, null)).toEqual(['A', 'B']);
    expect(mergeDirectiveWords(base, [])).toEqual(['A', 'B']);
  });

  it('空串丢弃；基底与 adapter 侧各自的重复项一并去重', () => {
    expect(mergeDirectiveWords(['CALL', '', 'CALL'], ['', '亲吻', '亲吻'])).toEqual(['CALL', '亲吻']);
  });
});

/** 假 Monaco：记录 `setMonarchTokensProvider` 的调用序与句柄 dispose */
function fakeMonaco() {
  const sets: { languageId: string; def: { directives?: readonly string[] }; disposed: boolean }[] = [];
  const monaco = {
    languages: {
      setMonarchTokensProvider: (languageId: string, def: { directives?: readonly string[] }) => {
        const rec = { languageId, def, disposed: false };
        sets.push(rec);
        return {
          dispose: () => {
            rec.disposed = true;
          },
        };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, sets };
}

describe('setErbDirectiveWords（Monarch 重设纪律）', () => {
  it('重设词表：新 provider 带合并词表、落在 ERB 语言上', () => {
    const { monaco, sets } = fakeMonaco();
    setErbDirectiveWords(monaco, mergeDirectiveWords(ERB_DIRECTIVES, ['亲吻']));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.languageId).toBe('kojo-erb');
    expect(sets[0]!.def.directives).toContain('亲吻');
    expect(sets[0]!.def.directives).toContain('PRINTL');
  });

  it('重设时 dispose 旧的：第二次 set 之前，第一次的句柄已被 dispose', () => {
    const { monaco, sets } = fakeMonaco();
    setErbDirectiveWords(monaco, ['A']);
    setErbDirectiveWords(monaco, ['B']);
    expect(sets).toHaveLength(2);
    expect(sets[0]!.disposed).toBe(true);
    expect(sets[1]!.disposed).toBe(false);
    expect(sets[1]!.def.directives).toEqual(['B']);
  });

  it('null = 回基底：词表逐项等于 ERB_DIRECTIVES（项目切换不残留上一项目的词表）', () => {
    const { monaco, sets } = fakeMonaco();
    setErbDirectiveWords(monaco, ['亲吻']);
    setErbDirectiveWords(monaco, null);
    expect(sets).toHaveLength(2);
    expect(sets[1]!.def.directives).toEqual(ERB_DIRECTIVES);
    expect(sets[0]!.disposed).toBe(true);
  });
});

/* ============================== 口上高频子集：eraTW 语料缺口补齐 ============================== */

/**
 * eraTW 4.980 真实语料词频实测出的缺失名（缺陷①的钉墙清单，逐个钉——不许再瘦身）。
 * 实测词频（次；ERB 全树 3,980 文件，2026-10 读盘）：PRINTFORMDW 162769 / PRINTFORMDL 147086 /
 * DATAFORM 20298 / RETURNF 19646 / PRINTDW 14552 / PRINTDL 7292 / GOTO 3232 / VARSET 2393 /
 * DATALIST 2385 / ENDLIST 2385 / PRINTFORMD 1898 / DOWNBASE 1365 / PRINTBUTTON 879。
 */
const CORPUS_HOT_GAPS: readonly string[] = [
  'PRINTFORMDW', 'PRINTFORMDL', 'RETURNF', 'DATAFORM', 'PRINTDW', 'PRINTDL',
  'GOTO', 'VARSET', 'DATALIST', 'ENDLIST', 'PRINTFORMD', 'DOWNBASE', 'PRINTBUTTON',
];

describe('ERB_DIRECTIVES 口上高频子集（真源 = 包叶派生判据 + 插件词表，物化在 erb-highlight-words）', () => {
  it('13 个语料高频缺失名逐一在列', () => {
    for (const w of CORPUS_HOT_GAPS) expect(ERB_DIRECTIVES, `缺语料高频名 ${w}`).toContain(w);
  });

  it('下一档唯一 ≥1000 的漏网 GETNUM 在列（实测 1037 次）', () => {
    expect(ERB_DIRECTIVES).toContain('GETNUM');
    expect(ERB_COMMANDS).toContain('GETNUM'); // 非族头 ⇒ .kojo 指令档派生面同样吃到
  });

  it('词表自洽：无重复项、全为行首全大写词形（Monarch 词法能命中的形）', () => {
    expect(new Set(ERB_DIRECTIVES).size).toBe(ERB_DIRECTIVES.length);
    for (const w of ERB_DIRECTIVES) expect(w).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('合并面不丢词：mergeDirectiveWords(ERB_DIRECTIVES, adapter 补词) 后 13 名全在', () => {
    const merged = mergeDirectiveWords(ERB_DIRECTIVES, ['亲吻']);
    for (const w of CORPUS_HOT_GAPS) expect(merged, `合并面丢词 ${w}`).toContain(w);
  });
});

/* ============================== .kojo 侧派生（单一真源恒等式） ============================== */

describe('ERB_COMMANDS 派生自 ERB_DIRECTIVES 真源（无第二份清单）', () => {
  it('恒等式：ERB_COMMANDS ≡ ERB_DIRECTIVES 去族头（逐项同位）', () => {
    const family = new Set(ERB_FAMILY_HEADS);
    expect(ERB_COMMANDS).toEqual(ERB_DIRECTIVES.filter((d) => !family.has(d)));
  });

  it('指令档 ⊆ 真源，且与族头档零交集（守住"族头另立一档"）', () => {
    const family = new Set(ERB_FAMILY_HEADS);
    const source = new Set(ERB_DIRECTIVES);
    for (const d of ERB_COMMANDS) {
      expect(source.has(d), `指令档出现真源外词 ${d}（手抄回填？）`).toBe(true);
      expect(family.has(d), `指令档混入族头 ${d}`).toBe(false);
    }
    // DOWNBASE 类角色（语料高频名 ∩ 引擎变量族头）：真源收；`.kojo` 侧由族头档接管 ⇔ 不进指令档
    expect(ERB_DIRECTIVES).toContain('DOWNBASE');
    expect(ERB_COMMANDS.includes('DOWNBASE')).toBe(!family.has('DOWNBASE'));
  });

  it('语料高频名（非族头者）经派生也进 .kojo 指令档', () => {
    const family = new Set(ERB_FAMILY_HEADS);
    const inCommands = CORPUS_HOT_GAPS.filter((w) => !family.has(w));
    expect(inCommands.length).toBeGreaterThan(10);
    for (const w of inCommands) expect(ERB_COMMANDS, `指令档缺 ${w}`).toContain(w);
  });
});

/* ============================== P1-1 第二批：行首语句口径的频次闸 ============================== */

/**
 * 词表扩容的**证据表**（两批测量共用一张表，判据同一把尺）：
 * - P1-1 批 59 行：eraNAS 4,398,019 行实测；
 * - K5 批 11 行：eraTW 画蛇添足版 4.980（ERB 全树 3,971 份 / 4,126,929 行，实测全 UTF-8、
 *   3,920 份带 BOM；有效语句行 2,571,686、行首标识词 257 枚；显示词表已认 206 枚 ⇒
 *   剩余缺口 107 词 / 426 次，其中 ≥10 次恰为这 11 词 / 188 次）。
 * 两份都只读；K5 行按频次**插位**进本表（表全局单调不增），跨语料的数值不互比高下——
 * "按频次收 Top N" 的纪律在每份测量内部成立即可，行尾 `K5` 注释标出处。
 *
 * 口径（P1-1 批新立的判据，写在这里当文档）：行首词之后**不得**是赋值 / 自增
 * （`=` `'=` `+=` `-=` `*=` … `++` `--`），也不得紧跟 `(`；否则那行是**变量语句**
 * 而不是语句词——上一批用粗口径把 `LOCAL = …` / `PAGE ++` 也算了进去，才得出
 * "缺 2,389 个 / 109,279 次"的虚高读数；按真语句口径收敛到 143 个 / 7,454 次。
 *
 * 表的用途是**闸**（三条断言见下），不是运行期数据：
 * 1. 表里每个词都必须在 `ERB_STATEMENT_DIRECTIVES` 里——防止有人删词却不删证据；
 * 2. 频次必须**单调不增**——保证"按频次收的 Top N"这个纪律真被遵守；
 * 3. 最小频次 ≥ 10（阈值本身写进断言）——防止塞冷门货。
 */
const CORPUS_STATEMENT_GAPS: readonly (readonly [string, number])[] = [
  ['DEBUGPRINTFORML', 654], ['SKIPDISP', 574], ['RESTART', 561], ['SETFONT', 442],
  ['DT_ROW_ADD', 416], ['THROW', 409], ['REUSELASTLINE', 303], ['PRINTFORMC', 294],
  ['PRINTS', 254], ['PRINTLC', 237], ['SPLIT', 236], ['PLAYSOUND', 213],
  ['DT_COLUMN_ADD', 190], ['PRINTC', 184], ['PRINTFORMLC', 176], ['DT_CELL_SET', 161],
  ['DATA', 122], ['PRINTD', 115], ['CUSTOMDRAWLINE', 113], ['CVARSET', 105],
  ['PRINTPLAINFORM', 102], ['TRYCALLF', 81], ['PRINTFORMSL', 76], ['ARRAYCOPY', 75],
  ['SETBGCOLOR', 73], ['SPRITECREATE', 65], ['PRINTPLAIN', 64], ['DT_SELECT', 62],
  ['RESETBGCOLOR', 59], ['ARRAYREMOVE', 53], ['GDRAWSPRITE', 45], ['ARRAYSHIFT', 43],
  ['PRINTBUTTONLC', 41], ['DT_ROW_REMOVE', 40], ['GDISPOSE', 39],
  ['TONEINPUTS', 39], // K5·eraTW
  ['REPLACE', 34], ['DRAWLINEFORM', 31], ['SPRITEDISPOSE', 31], ['DT_CREATE', 31],
  ['GCREATE', 31], ['PRINTSL', 30], ['DT_RELEASE', 29], ['CBGCLEAR', 27],
  ['GCREATEFROMFILE', 26], ['XML_GET', 26], // K5·eraTW
  ['GDRAWTEXT', 25], ['GSETFONT', 24], ['GSETPEN', 24],
  ['MAP_SET', 20], ['GDRAWG', 19], ['TOOLTIP_SETDELAY', 16], ['MAP_CREATE', 16], // K5·eraTW
  ['ARRAYSORT', 15], ['CHKDATA', 14], ['RESET_STAIN', 14], ['STOPSOUND', 13],
  ['FINDELEMENT', 12], ['GCLEAR', 12], ['SETANIMETIMER', 12], ['DOTRAIN', 11],
  ['XML_ADDNODE', 11], ['AWAIT', 11], // K5·eraTW
  ['PRINTSINGLEFORMS', 10], ['SUBSTRING', 10], ['CBGSETG', 10], ['GETDEFCOLOR', 10],
  ['PRINT_RECT', 10], ['GETCOLOR', 10], ['BINPUT', 10], // K5·eraTW
];

/** 收录阈值（次）：两批测量共用一把尺，低于它的一律不收（eraTW 3~9 档 32 词的拒收名单钉在下方 K5 闸） */
const STATEMENT_GAP_THRESHOLD = 10;

describe('P1-1 词表扩容闸（证据表 ↔ 词表，双向对账）', () => {
  it('证据表里的每个词都在手写清单里（删词必须同批删证据）', () => {
    const list = new Set(ERB_STATEMENT_DIRECTIVES.map((w) => w.toUpperCase()));
    const missing = CORPUS_STATEMENT_GAPS.filter(([w]) => !list.has(w.toUpperCase())).map(([w]) => w);
    expect(missing, `证据表有、词表没有：${missing.join(', ')}`).toEqual([]);
  });

  it('证据表的频次单调不增（"按频次收 Top N"这条纪律可验）', () => {
    const bad: string[] = [];
    for (let i = 1; i < CORPUS_STATEMENT_GAPS.length; i++) {
      const prev = CORPUS_STATEMENT_GAPS[i - 1]!;
      const cur = CORPUS_STATEMENT_GAPS[i]!;
      if (cur[1] > prev[1]) bad.push(`${cur[0]}:${cur[1]} > ${prev[0]}:${prev[1]}`);
    }
    expect(bad, `频次表未按降序排：${bad.join(', ')}`).toEqual([]);
  });

  it('阈值纪律：最小频次 ≥ 10，且表内无重复词', () => {
    const counts = CORPUS_STATEMENT_GAPS.map(([, n]) => n);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(STATEMENT_GAP_THRESHOLD);
    const words = CORPUS_STATEMENT_GAPS.map(([w]) => w.toUpperCase());
    expect(new Set(words).size).toBe(words.length);
  });

  it('这批词逐项进 `ERB_DIRECTIVES`（含 .kojo 侧派生面，族头除外）', () => {
    const shown = new Set(ERB_DIRECTIVES.map((w) => w.toUpperCase()));
    for (const [w] of CORPUS_STATEMENT_GAPS) expect(shown, `显示词表缺 ${w}`).toContain(w.toUpperCase());
  });

  it('这批词里没有控制流词（控制词只许派生，不许回填）', () => {
    const control = new Set(ERB_CONTROL_STATEMENTS.map((w) => w.toUpperCase()));
    const backfilled = CORPUS_STATEMENT_GAPS.filter(([w]) => control.has(w.toUpperCase())).map(([w]) => w);
    expect(backfilled, `本批混入控制流词：${backfilled.join(', ')}`).toEqual([]);
  });
});

/* ============================== K5 批（eraTW 4.980）：样例回扫 / .kojo 派生 / 拒收档 ============================== */

/**
 * K5 批 11 枚：词 / 频次（须与上方证据表逐词相等）/ **一条原样语句**（真语料行首语句行，
 * 已去行首缩进与行尾空白，`"` 原样保留）/ 出处文件（相对 `ERB/` 根）。
 * 样例不是装饰：下面的断言用与语料闸**同一把**真语句判据回扫每条样例，
 * 挡「贴注释行 / 函数调用形 / 赋值形冒充证据」的收词姿势——证明「作者真在写」写到可执行。
 *
 * 引擎侧佐证（本机无引擎沙盒，`KOJO_CLIDBG_DIR` 未设，PITFALLS §103 双证的"跑起来"一腿缺；
 * 11 枚全部有 Emuera.EM+EE 参考手册语句表点名 + 基线盘 `Emuera_LazyLoadingV3.0` 二进制串面命中
 * 或同族在仓佐证），把握不足的记号本批一个没收。`GDRAWG` 是按判据单文件货（19 次全在
 * `ステータス表示関連\縁取り.ERB` 且 skip 区外；`SHOP関連\TEST.ERB` 的另外 9 行整块住在
 * `[SKIPSTART]…[SKIPEND]` 演示区、且写作 `GDRAWG ++i, …` 形，被双重判据正确排除在计数外）——
 * 收，取舍与掉线删除纪律见 git 提交（K5 批）与包叶 `@kojo/erb-vocab/directives` 头注。
 */
const K5_BATCH: readonly (readonly [word: string, count: number, sample: string, source: string])[] = [
  ['TONEINPUTS', 39, 'TONEINPUTS 制限時間, "p", 1', 'BATTLE.ERB'],
  ['XML_GET', 26, 'XML_GET L_ENKAI_XML , @"/ROOT/ENKAI[{CNT}]/ENKAI_WEIGHT/text()" , RESULTS', 'イベント関連\\宴会.ERB'],
  ['MAP_SET', 20, 'MAP_SET O_MAP, LOCALS, TOSTR(LOCAL)', '魔改内容\\qol\\qol_OBJ.ERB'],
  ['GDRAWG', 19, 'GDRAWG L_G_RESULT , TOINT(ARG_SPR) , 0 , 0 , L_WIDTH , L_HEIGHT , 0 , 0 , L_WIDTH , L_HEIGHT', 'ステータス表示関連\\縁取り.ERB'],
  ['TOOLTIP_SETDELAY', 16, 'TOOLTIP_SETDELAY 400', '魔改内容\\示例函数\\PLAY_GOMOKU.ERB'],
  ['MAP_CREATE', 16, 'MAP_CREATE CSV_MAP', 'SYSTEM.ERB'],
  ['XML_ADDNODE', 11, 'XML_ADDNODE L_ENKAI_XML , @"/ROOT" , @"<ENKAI />"', 'イベント関連\\宴会.ERB'],
  ['AWAIT', 11, 'AWAIT 40', '魔改内容\\PRINT系\\PRINT_SAMPLE.ERB'],
  ['PRINT_RECT', 10, 'PRINT_RECT 0, 30, L_W, 20', '魔改内容\\PRINT系\\UI_Components_&_Tables.ERB'],
  ['GETCOLOR', 10, 'GETCOLOR', 'コマンド関連\\COMF\\日常系\\COMF483 ムシバトル.ERB'],
  ['BINPUT', 10, 'BINPUT 1,1,0', '口上・メッセージ関連\\個人口上\\059 Koakuma [小悪魔]\\魅影之花\\M_KOJO_K59_2_事件系.ERB'],
];

/**
 * eraTW 实测 3~9 次的 32 词（合计 159 次）——本批口径（≥10）下**一律不收**，钉成拒收闸。
 * 抬档收词的前提是重新取证并同批把它们移进证据表，不是把这里删空了再塞。
 * （1~2 档 64 词同为噪声带不收，名单未存档，纪律同 git 提交的 K5 批归因与包叶头注。）
 */
const CORPUS_UNCOLLECTED_TIER_3TO9: readonly string[] = [
  'STRLENFORM', 'DEBUGPRINTFORM', 'QUIT', 'TOOLTIP_SETDURATION', 'MAP_GETKEYS', 'ISNUMERIC',
  'TOINT', 'BITMAP_CACHE_ENABLE', 'LIMIT', 'DEBUGPRINTL', 'MAP_CLEAR', 'DUMPRAND', 'INITRAND',
  'SUBSTRINGU', 'SETTEXTBOX', 'XML_ADDATTRIBUTE', 'ARG_LEN', 'STOPBGM', 'PRINTSDL', 'ARG',
  'ARRAYMSORT', 'SPRITEANIMEADDFRAME', 'SAVECHARA', 'MAP_RELEASE', 'LOADCHARA',
  'HTML_POPPRINTINGSTR', 'PRINT_SPACE', 'DEBUGCLEAR', 'SETSOUNDVOLUME', 'ARRAYMSORTEX',
  'SPRITEANIMECREATE', 'PRINTSW',
];

describe('K5 批（eraTW 4.980，11 枚）证据 ↔ 词表 ↔ 派生面', () => {
  it('K5 频次与证据表逐词对账（两处数字不许漂移）', () => {
    const table = new Map(CORPUS_STATEMENT_GAPS);
    for (const [w, n] of K5_BATCH) expect(table.get(w), `证据表 ${w} 频次 ≠ K5 名单 ${n}`).toBe(n);
    expect(CORPUS_STATEMENT_GAPS.length).toBe(59 + K5_BATCH.length);
  });

  it('逐词一条原样语句，经同一真语句判据回扫成立（行首语句形，非注释 / 赋值 / 函数调用）', () => {
    for (const [w, , line] of K5_BATCH) {
      const m = /^([A-Z][A-Z0-9_]*)(?=[\s(=]|$)/.exec(line);
      expect(m, `样例不是行首语句词形：${line}`).not.toBeNull();
      expect(m![1], `样例起手词应为 ${w}`).toBe(w);
      const rest = line.slice(m![1]!.length);
      expect(isVariableStatement(rest), `样例落进变量语句判据：${line}`).toBe(false);
      expect(rest.startsWith('('), `样例是函数调用形：${line}`).toBe(false);
    }
  });

  it('K5 11 枚进手写清单，且非族头者经派生进 `.kojo` 指令档（派生面跟变）', () => {
    const family = new Set(ERB_FAMILY_HEADS);
    for (const [w] of K5_BATCH) {
      expect(ERB_STATEMENT_DIRECTIVES, `手写清单缺 ${w}`).toContain(w);
      expect(family.has(w), `${w} 若是族头须走族头档（本批预期非族头）`).toBe(false);
      expect(ERB_COMMANDS, `.kojo 指令档缺 ${w}（派生断裂）`).toContain(w);
    }
  });

  it('3~9 档 32 词一枚未收（拒收名单钉墙；收词必须先重新取证）', () => {
    const shown = new Set(ERB_DIRECTIVES.map((w) => w.toUpperCase()));
    const leaked = CORPUS_UNCOLLECTED_TIER_3TO9.filter((w) => shown.has(w));
    expect(leaked, `低于阈值的词混进显示词表：${leaked.join(', ')}`).toEqual([]);
    expect(CORPUS_UNCOLLECTED_TIER_3TO9.length).toBe(32);
  });
});


/* ============================== 结构 ↔ 显示 同源（P0-2 对拍） ============================== */

describe('显示词表与结构真源同源（2026-10-25 P0-2）', () => {
  it('结构词 ⊆ 显示词：`ERB_CONTROL_STATEMENTS` 每词都在 `ERB_DIRECTIVES`（结构认 ⇒ 着色/补全也认）', () => {
    const shown = new Set(ERB_DIRECTIVES.map((w) => w.toUpperCase()));
    const missing = ERB_CONTROL_STATEMENTS.filter((w) => !shown.has(w.toUpperCase()));
    expect(missing, `结构认、显示不认的控制词（双源漂移）：${missing.join(', ')}`).toEqual([]);
  });

  it('手写清单与控制流真源零交集（控制词只许派生，不许回填）', () => {
    const control = new Set(ERB_CONTROL_STATEMENTS.map((w) => w.toUpperCase()));
    const handWritten = ERB_STATEMENT_DIRECTIVES.filter((w) => control.has(w.toUpperCase()));
    expect(handWritten, `手写清单回填了控制流词（第二份清单）：${handWritten.join(', ')}`).toEqual([]);
  });

  it('并集口径：`ERB_DIRECTIVES` = 手写清单 ∪ 结构词，且无重复（逐项核对，不靠长度）', () => {
    const union = new Set([...ERB_STATEMENT_DIRECTIVES, ...ERB_CONTROL_STATEMENTS].map((w) => w.toUpperCase()));
    expect(new Set(ERB_DIRECTIVES.map((w) => w.toUpperCase()))).toEqual(union);
    expect(new Set(ERB_DIRECTIVES).size).toBe(ERB_DIRECTIVES.length);
  });
});

/* ============================== 宿主源码零手抄（扫描守卫） ============================== */

const MONACO_SRC_DIR = path.resolve(import.meta.dirname, '..', 'src', 'monaco');

/** 抹注释（块 + 行）后提取 `'Word'` / `"Word"` 整条字面量；`'./x'` / `'sugar.keyword'` 这类形不匹配 */
function quotedWordForms(src: string): string[] {
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...bare.matchAll(/(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2]!);
}

describe('宿主源码零手抄指令串（kojo-language / erb-language 一律不抄词表）', () => {
  it('两文件的字符串字面量里没有"整条等于 ERB_DIRECTIVES 词"的抄本', () => {
    const words = new Set(ERB_DIRECTIVES);
    for (const file of ['kojo-language.ts', 'erb-language.ts']) {
      const src = readFileSync(path.join(MONACO_SRC_DIR, file), 'utf8');
      const hits = quotedWordForms(src).filter((w) => words.has(w));
      expect(hits, `${file} 出现指令词手抄字面量（真源 = 包叶判据 + 插件词表，宿主不许另抄）：${hits.join(', ')}`).toEqual([]);
    }
  });

  it('负空间自检：扫描器抓得到人造抄本，注释里的引用不算（与守卫口径一致）', () => {
    const synthetic = "const X = ['PRINTFORMDW', 'GOTO'];\n// 'VARSET' 是注释引用\n/* \"PRINTDW\" */\nconst y = './erb-directives';";
    const words = new Set(ERB_DIRECTIVES);
    expect(quotedWordForms(synthetic).filter((w) => words.has(w))).toEqual(['PRINTFORMDW', 'GOTO']);
  });

  it('指令词表的家恰一份（c292353c 车道判废钉闸：`@kojo/erb-vocab/highlight-words` 第二叶不许长回来）', () => {
    // 判废依据（2026-10-31 裁决批）：该车道把词表+`unionSorted` 搬进 `@kojo/erb-vocab/highlight-words`
    // 新叶、物化收编宿主 `erb-directives.ts`——而第七波已把**派生判据**落 `@kojo/erb-vocab/directives`
    // （`appendUnseen`，"派生判据只有这一份、宿主只接料"）并**退役**了宿主 `erb-directives.ts`，
    // 物化现家 = 宿主 `erb-highlight-words.ts`。同一条去重并集判据（appendUnseen vs unionSorted）
    // 在两枚包叶各立一家 = 正面冲突 ⇒ 判废。本条按既有"零手抄/无第二份清单"口径钉**定义面**：
    // 五枚名字各恰一处定义、家逐字点名；第二家（宿主副本或包内新叶）一出现即红。
    // 包内文件数白名单（`erb-vocab/tests/control-flow-boundary.test.ts` 钉三枚叶）是它的对侧证据，
    // 两条判据都不许放宽。
    const roots: string[] = [];
    const hasSrc = (dir: string): string | null =>
      existsSync(path.join(REPO_ROOT, dir, 'src')) ? `${dir}/src` : null;
    for (const entry of readdirSync(path.join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'plugins') {
        for (const plug of readdirSync(path.join(REPO_ROOT, 'packages', 'plugins'), { withFileTypes: true })) {
          if (!plug.isDirectory()) continue;
          const rel = hasSrc(`packages/plugins/${plug.name}`);
          if (rel) roots.push(rel);
        }
        continue;
      }
      const rel = hasSrc(`packages/${entry.name}`);
      if (rel) roots.push(rel);
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(`${dir}/${entry.name}`);
        } else if (/\.tsx?$/.test(entry.name)) files.push(`${dir}/${entry.name}`);
      }
    };
    for (const root of roots) walk(root);
    const posix = (p: string): string => p.split(path.sep).join('/');
    const DEFINITION_HOME: readonly (readonly [RegExp, string])[] = [
      [/export const ERB_ENGINE_EXTRA_STATEMENTS\b/, 'packages/app/src/monaco/erb-highlight-words.ts'],
      [/export const ERB_HIGHLIGHT_EXTRA_WORDS\b/, 'packages/app/src/monaco/erb-highlight-words.ts'],
      [/export const ERB_HIGHLIGHT_WORDS\b/, 'packages/app/src/monaco/erb-highlight-words.ts'],
      [/function unionSorted\b/, 'packages/app/src/monaco/erb-highlight-words.ts'],
      [/export function appendUnseen\b/, 'packages/erb-vocab/src/directives.ts'],
    ];
    for (const [pattern, home] of DEFINITION_HOME) {
      const hits = files
        .filter((rel) => pattern.test(readFileSync(path.join(REPO_ROOT, rel), 'utf8')))
        .map(posix)
        .sort();
      expect(hits, `${pattern.source} 的定义面不是恰一处（第二份词表家出现了）`).toEqual([home]);
    }
  });
});

/* ============================== 语料闸：收进来的词必须"真在写" ============================== */

/**
 * 上一节的证据表是**静态**的（读数写死）；这一节是**活的**闸——真语料重扫一遍，
 * 断言每个收进来的词仍能命中至少一次。
 *
 * 它挡的是这一类退化：为了"族完整"塞进 `PRINTLW` / `DEBUGPRINTL` 这种作者根本不写的词。
 * 语料不在位（`KOJO_SMOKE_PROJECT` 未设）⇒ 整组跳过，与其余 `*.corpus.test.ts` 同纪律。
 *
 * 分母口径（本批升级，2026-10-25）：**"每词 ≥1 命中"不再等于"主盘 ≥1 命中"**。
 * 证据表 70 词来自两批测量——P1-1 批 59 词是 **eraNAS**（4,398,019 行）口径，K5 批 11 词是
 * eraTW 4.980 基线口径；eraNAS 不在盘时，单盘判据会把 `TRYCALLF` / `DT_SELECT` / `CBGCLEAR` /
 * `CBGSETG` 四枚**有跨盘证据**的词误判成死词（`pnpm test` 全量不设 `KOJO_SMOKE_PROJECT`，
 * 这枚闸一直没进分母，所以这条红从 P1-1 落地起就潜伏着）。改法是把判据**加层**而不是放宽：
 * 主盘 → 其余在盘语料 → 引擎二进制串面，三层全无照旧红。
 */
const CORPUS_ROOT = process.env.KOJO_SMOKE_PROJECT;

/** 仓库根：`tools/corpus.mjs` 从这里拼，语料目录名一概不落进本文件 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * 一个词的三层取证结果。`layer` 取到哪一层就是它过闸的**唯一**理由：
 * 1 主盘命中 / 2 他盘命中（读数记出处盘）/ 3 仅引擎串面（语料未用）/ 0 三层全无（红）。
 */
interface WordEvidence {
  word: string;
  layer: 0 | 1 | 2 | 3;
  primary: number;
  others: { dir: string; count: number }[];
  engines: string[];
}

/** 递归收集 `.erb` / `.erh`（跳符号链接，结果排序保证确定性） */
function collectErbFiles(root: string): string[] {
  const stack = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && /\.(erb|erh)$/i.test(ent.name)) out.push(p);
    }
  }
  out.sort();
  return out;
}

/** 行首词之后是赋值 / 自增 ⇒ 该行是变量语句，不是语句词（判据与证据表口径逐字相同） */
function isVariableStatement(rest: string): boolean {
  return /^(?::[^=]*)?\s*(?:'=|\+=|-=|\*=|%=|&=|\|=|\^=|\/=|<<=|>>=|\+\+|--|=)/.test(rest);
}

/** 语料里以**语句形态**出现的行首词频次（两次断言共用一次扫描：4.4M 行不值得跑两遍） */
let cachedCounts: Map<string, number> | undefined;
function statementWordCounts(root: string): Map<string, number> {
  if (cachedCounts) return cachedCounts;
  const counts = new Map<string, number>();
  let inSkip = false;
  for (const file of collectErbFiles(root)) {
    const text = decodeWithProbe(readFileSync(file)).text;
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim();
      if (inSkip) {
        if (t === '[SKIPEND]') inSkip = false;
        continue;
      }
      if (t === '[SKIPSTART]') {
        inSkip = true;
        continue;
      }
      if (t.length === 0) continue;
      if (t.startsWith(';') || t.startsWith('@') || t.startsWith('#') || t.startsWith('$') || t.startsWith('[')) continue;
      const m = /^([A-Z][A-Z0-9_]*)(?=[\s(=]|$)/.exec(t);
      if (!m) continue;
      const rest = t.slice(m[1]!.length);
      if (isVariableStatement(rest) || rest.startsWith('(')) continue;
      counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
    }
  }
  cachedCounts = counts;
  return counts;
}

/** 盘上语料（认内容不认名）与引擎串面的缓存：同一轮内绝不重复扫盘 / 重复读 exe */
let cachedCorporaOnDisk: string[] | undefined;
const engineBufCache = new Map<string, Buffer>();
const cachedScans = new Map<string, Map<string, number>>();
let cachedEvidence: Map<string, WordEvidence> | undefined;

/**
 * 盘上**全部**符合内容判据的语料目录（不止被 `KOJO_SMOKE_PROJECT` 选中的那枚）。
 * 判据不在本文件重抄：直接调 `node tools/corpus.mjs --print-all`
 * （= ERB/ 与 CSV/ 都在位、`KOJO_CORPUS_SCAN_DIRS` 优先、默认扫 `C:/game`；目录名一概不看）。
 * 解析链 rc≠0（盘上一枚都没有）⇒ 空数组：层 2 直接不可用，逐词读数会写清"未扫到他盘"。
 */
function corporaOnDisk(): string[] {
  if (cachedCorporaOnDisk) return cachedCorporaOnDisk;
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'corpus.mjs'), '--print-all'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  cachedCorporaOnDisk = r.status === 0
    ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  return cachedCorporaOnDisk;
}

const dirKey = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');

/** 除主盘之外的在盘语料（大小写/尾斜杠归一后去重，排序保证确定性） */
function otherCorpora(primary: string): string[] {
  const key = dirKey(primary);
  return corporaOnDisk().filter((d) => dirKey(d) !== key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 以**与主盘同一把**真语句判据扫一枚盘，只对 `pending` 里的词计数。
 * 成本闸：`pending` 全部拿到 ≥1 命中就立刻收摊不再读盘（`TRYCALLF` 这类六盘全 0 的词
 * 才会让这一枚盘走完，这是判据本身要求的代价）。结果按盘缓存。
 */
function scanCorpusFor(root: string, pending: readonly string[]): Map<string, number> {
  const key = dirKey(root);
  const cacheKey = `${key}::${[...pending].sort().join(',')}`;
  const hit = cachedScans.get(cacheKey);
  if (hit) return hit;
  const wanted = new Set(pending);
  const counts = new Map<string, number>();
  let missing = wanted.size;
  let inSkip = false;
  for (const file of collectErbFiles(root)) {
    if (missing === 0) break;
    const text = decodeWithProbe(readFileSync(file)).text;
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim();
      if (inSkip) {
        if (t === '[SKIPEND]') inSkip = false;
        continue;
      }
      if (t === '[SKIPSTART]') {
        inSkip = true;
        continue;
      }
      if (t.length === 0) continue;
      if (t.startsWith(';') || t.startsWith('@') || t.startsWith('#') || t.startsWith('$') || t.startsWith('[')) continue;
      const m = /^([A-Z][A-Z0-9_]*)(?=[\s(=]|$)/.exec(t);
      if (!m || !wanted.has(m[1]!)) continue;
      const rest = t.slice(m[1]!.length);
      if (isVariableStatement(rest) || rest.startsWith('(')) continue;
      if ((counts.get(m[1]!) ?? 0) === 0) missing--;
      counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
    }
  }
  cachedScans.set(cacheKey, counts);
  return counts;
}

/**
 * 层 3：引擎二进制串面证据（各语料根目录下的一级 `*.exe`，一次读入内存做 `includes`）。
 * **latin1 与 utf16le 各扫一遍**——.NET 的字符串堆是 UTF-16，只扫 ASCII 会把"有"判成"没有"。
 * 惰性：没有任何词落到层 3 时一枚 exe 都不必读。
 */
function engineStringHits(words: readonly string[], roots: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(words.map((w) => [w, [] as string[]]));
  if (words.length === 0) return out;
  const probes = new Map<string, readonly [Buffer, Buffer]>(
    words.map((w) => [w, [Buffer.from(w, 'latin1'), Buffer.from(w, 'utf16le')] as const]),
  );
  for (const dir of roots) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !/\.exe$/i.test(ent.name)) continue;
      const p = path.join(dir, ent.name);
      let buf = engineBufCache.get(p);
      if (!buf) {
        try {
          buf = readFileSync(p);
        } catch {
          continue;
        }
        engineBufCache.set(p, buf);
      }
      for (const w of words) {
        const [l1, u16] = probes.get(w)!;
        if (buf.includes(l1) || buf.includes(u16)) out.get(w)!.push(`${path.basename(dir)}/${ent.name}`);
      }
    }
  }
  return out;
}

/** 层 2 本轮**真的扫过**了几枚他盘（早退时可能少于在位数；读数要说实话） */
let layer2DisksScanned = 0;

/**
 * 三层取证（一次跑完、两处断言共用；这就是"判据升级不是放宽"的实现）：
 *  1. 主盘（`KOJO_SMOKE_PROJECT`）命中 ≥1 ⇒ 过（**既有行为逐字保留**）；
 *  2. 主盘 0 ⇒ 只把**这批 0 命中词**送去扫其余在盘语料，任一盘 ≥1 ⇒ 过（读数点名出处盘）；
 *  3. 全部在盘语料都 0 ⇒ 引擎二进制串面 ⇒ 过（读数记「仅引擎背书·语料未用」）；
 *  4. 三层全无 ⇒ 记 `layer: 0`，照旧红（挡"为族完整塞冷门货"）。
 */
function collectEvidence(primary: string, words: readonly string[]): Map<string, WordEvidence> {
  if (cachedEvidence) return cachedEvidence;
  const primaryCounts = statementWordCounts(primary);
  const others = otherCorpora(primary);
  const ev = new Map<string, WordEvidence>(
    words.map((w) => [w, { word: w, layer: (primaryCounts.get(w) ?? 0) > 0 ? 1 : 0, primary: primaryCounts.get(w) ?? 0, others: [], engines: [] } as WordEvidence]),
  );
  let pending = words.filter((w) => ev.get(w)!.primary === 0);
  layer2DisksScanned = 0;
  for (const dir of others) {
    if (pending.length === 0) break;
    layer2DisksScanned++;
    const counts = scanCorpusFor(dir, pending);
    const still: string[] = [];
    for (const w of pending) {
      const n = counts.get(w) ?? 0;
      if (n > 0) {
        const e = ev.get(w)!;
        e.others.push({ dir, count: n });
        e.layer = 2;
      } else still.push(w);
    }
    pending = still;
  }
  if (pending.length > 0) {
    const hits = engineStringHits(pending, [primary, ...others]);
    for (const w of pending) {
      const e = ev.get(w)!;
      e.engines = hits.get(w) ?? [];
      if (e.engines.length > 0) e.layer = 3;
    }
  }
  cachedEvidence = ev;
  return ev;
}

/** 失败读数：逐词把三层的**各自读数**写全，绝不只甩一个空数组 */
function describeEvidence(e: WordEvidence): string {
  const l2 = e.others.length > 0
    ? e.others.map((o) => `${path.basename(o.dir)} ${o.count} 行`).join(' + ')
    : `0（本轮已扫 ${layer2DisksScanned} 枚他盘）`;
  const l3 = e.engines.length > 0 ? e.engines.join(', ') : '无';
  return `${e.word}｜主盘 ${e.primary}｜他盘 ${l2}｜引擎串面 ${l3}`;
}

/**
 * 钉档（2026-10-25 本机实测）：证据表 70 词里**唯一**四枚主盘 0 命中的词，逐枚点名它靠第几层过闸。
 * 这四枚是 P1-1 批按 **eraNAS**（4,398,019 行）口径取的，eraNAS 不在盘 ⇒ 主盘（eraTW 4.980 基线）
 * 必然 0 命中；判据若仍写死单盘，这枚活闸在 `KOJO_SMOKE_PROJECT` 跑法下就是红的。
 * 钉这一条是为了**防层 3 被写成万能通行证**：①越过层 1 的词集合只能是钉档这四枚的子集
 * （新增词若不先在主盘 0 命中就别想走层 2/3）；②逐词层号对账；③层 3 只许落在"主盘 0 且
 * 全部在盘语料 0"的词上且必须确有串面；④人造词必须三层皆空（层 3 读的是真盘字节）。
 * 他盘整枚不在盘时这几行会因证据降级而红——那是如实读数：把盘放回扫描根或重新取证，
 * **不许改这几行凑绿**（红消息里会列出在位/实扫盘数）。
 * 成本：层 2 只扫"主盘 0 命中"这一小批词、每盘拿到证据即早退、结果按盘缓存；
 * 人造词与真词同扫一遍盘（不多花一遍）；exe 只在确有词落到层 3 时才读（本机实测整组 ~89s）。
 */
const EXPECTED_EVIDENCE_LAYER: readonly (readonly [word: string, layer: 2 | 3, note: string])[] = [
  ['DT_SELECT', 2, 'eraFL 105 行（`DT_SELECT "GMAPDATA",,, nodeDID`），其余在盘语料 0'],
  ['CBGSETG', 2, 'eraAkumaMaid 75 行（eraFL 1 / eratw魔王改版 1 同证）'],
  ['CBGCLEAR', 2, 'eraAkumaMaid·eraFL·eratw魔王改版 各 1 行——lead 的 cross-corpus 探针记 0，是它要求词后必跟 [\\s(=]，裸形 `CBGCLEAR`（整行只有词）被漏；本闸用主盘那把判据（`(?=[\\s(=]|$)`），认得到'],
  ['TRYCALLF', 3, '六枚在盘语料全 0，仅引擎串面（latin1）背书——真·"仅引擎背书·语料未用"'],
];

/** 人造冷门词：三层都该是零。用来证明层 3 有牙（不是"扫不到也算引擎背书"） */
const FABRICATED_WORD = 'QZZZNOSUCHDIRECTIVE';

const GAP_WORDS = CORPUS_STATEMENT_GAPS.map(([w]) => w);

describe.skipIf(!CORPUS_ROOT)('语料闸：词表里的新增词在真语料里仍能命中（`KOJO_SMOKE_PROJECT` 守门）', () => {
  it('闸表 70 词（P1-1 批 59 + K5 批 11）逐个 ≥1 次命中（挡"为族完整塞冷门货"）——跨证据三层：主盘 → 他盘 → 引擎串面', () => {
    const others = otherCorpora(CORPUS_ROOT!);
    const ev = collectEvidence(CORPUS_ROOT!, [...GAP_WORDS, FABRICATED_WORD]);
    const escalated = GAP_WORDS.filter((w) => ev.get(w)!.layer !== 1);
    // 升级判据的可见性：凡不靠主盘过闸的词，读数里点名它走的是哪一层、出处是哪枚盘
    if (escalated.length > 0) {
      console.info(`[语料闸·跨证据] 主盘 ${path.basename(CORPUS_ROOT!)} 0 命中 ${escalated.length} 词（他盘在位 ${others.length} 枚 / 本轮实扫 ${layer2DisksScanned} 枚）：\n`
        + escalated.map((w) => `  · ${describeEvidence(ev.get(w)!)}`).join('\n'));
    }
    const dead = GAP_WORDS.filter((w) => ev.get(w)!.layer === 0);
    expect(dead.length, `三层全无（不该收）：\n${dead.map((w) => `  · ${describeEvidence(ev.get(w)!)}`).join('\n') || '（无）'}`).toBe(0);
  }, 900_000);

  it('钉档：四枚 eraNAS 口径词逐枚点名走第几层；超出这四枚的任何词不许走出主盘证据（层 3 不是通行证）', () => {
    const others = otherCorpora(CORPUS_ROOT!);
    const ev = collectEvidence(CORPUS_ROOT!, [...GAP_WORDS, FABRICATED_WORD]);
    const pinned = new Set(EXPECTED_EVIDENCE_LAYER.map(([w]) => w));
    // ① 越界即红：证据表里需要"主盘以外证据"的词，必须恰好是钉档这四枚的子集
    const escalated = GAP_WORDS.filter((w) => ev.get(w)!.layer !== 1).filter((w) => !pinned.has(w));
    expect(escalated, `主盘 0 命中却不在钉档里的词（新增词必须同批钉层号；他盘在位 ${others.length} 枚 / 实扫 ${layer2DisksScanned} 枚）：${escalated.join(', ')}`).toEqual([]);
    // ② 逐词层号对账
    for (const [w, layer, note] of EXPECTED_EVIDENCE_LAYER) {
      const e = ev.get(w);
      expect(e, `钉档词 ${w} 不在证据表里`).toBeDefined();
      if (!e) continue;
      if (e.primary > 0) {
        expect(e.layer, `${w}：钉档前提是主盘 0 命中（主盘换成含它的盘请重新取证），实际主盘 ${e.primary}`).toBe(1);
        continue;
      }
      expect(e.layer, `${w} 走的层号与钉档不符（钉 ${layer}）——${note}\n  本轮读数：${describeEvidence(e)}`).toBe(layer);
    }
    // ③ 层 3 的准入条件必须真的成立：只有"主盘 0 且全部在盘语料 0"的词才许用它，且必须确有串面
    for (const e of [...ev.values()].filter((x) => x.layer === 3)) {
      expect(e.primary, `${e.word} 层 3 但主盘有命中（判据顺序写坏了）`).toBe(0);
      expect(e.others, `${e.word} 层 3 但他盘有命中（判据顺序写坏了）`).toEqual([]);
      expect(e.engines.length, `${e.word} 层 3 却零串面证据（层 3 被写成免检）`).toBeGreaterThan(0);
    }
    // ④ 负空间：人造词三层皆空 ⇒ 红（层 3 读的是真盘字节，不是"默认放行"）
    const fake = ev.get(FABRICATED_WORD)!;
    expect(describeEvidence(fake), `人造词竟然过闸了（层 ${fake.layer}）——层 3 已被写成万能通行证`).toContain('引擎串面 无');
    expect(fake.layer, `人造词竟然过闸了：${describeEvidence(fake)}`).toBe(0);
  }, 900_000);

  it('剩余缺口收敛：未收词的总命中次数 < 1,000（P1-1 批读数 7,454 → 594；K5 批再吃 11 词 / 活语料实测 188 次，只降不升）【主盘口径，未随三层改动】', () => {
    const counts = statementWordCounts(CORPUS_ROOT!);
    const known = new Set(ERB_HIGHLIGHT_WORDS.map((w) => w.toUpperCase()));
    let restHits = 0;
    for (const [w, n] of counts) if (!known.has(w)) restHits += n;
    expect(restHits).toBeLessThan(1_000);
  }, 900_000);
});

