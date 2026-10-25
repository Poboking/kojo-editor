/**
 * T5 · Monarch directive 词表同源化（`mergeDirectiveWords` / `setErbDirectiveWords`）单测。
 *
 * 纯函数（两表进、合并词表出）+ 假 Monaco（只记录 `setMonarchTokensProvider` 与句柄
 * dispose，无运行时依赖）。覆盖：并集、大小写不敏感去重、排序确定、`extra` 缺席回基底；
 * 重设句柄纪律：重设时 dispose 旧 provider、`null` 回基底（项目切换不残留上一项目词表）。
 *
 * 本批追加（口上高频子集补齐，缺陷①）：
 * ① 语料高频缺失名钉在 `ERB_DIRECTIVES`（简报例名 13 个 + 实测 ≥1000 的 GETNUM；
 *   真源 = 叶子模块 `erb-directives.ts`）；
 * ② `.kojo` 侧 `ERB_COMMANDS` ≡ `ERB_DIRECTIVES` 去族头（派生恒等式，无第二份清单）；
 * ③ 宿主源码零手抄扫描守卫：kojo-language / erb-language 的字面量里不许出现指令词抄本。
 */

import { readdirSync, readFileSync } from 'node:fs';
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

describe('ERB_DIRECTIVES 口上高频子集（真源 = 叶子模块 erb-directives.ts）', () => {
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

describe('ERB_COMMANDS 派生自 erb-directives 真源（无第二份清单）', () => {
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
 * 2026-10-25 词表扩容的**证据表**（eraNAS 4,398,019 行实测，只读）。
 *
 * 口径（本批新立的判据，写在这里当文档）：行首词之后**不得**是赋值 / 自增
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
  ['PRINTBUTTONLC', 41], ['DT_ROW_REMOVE', 40], ['GDISPOSE', 39], ['REPLACE', 34],
  ['DRAWLINEFORM', 31], ['SPRITEDISPOSE', 31], ['DT_CREATE', 31], ['GCREATE', 31],
  ['PRINTSL', 30], ['DT_RELEASE', 29], ['CBGCLEAR', 27], ['GCREATEFROMFILE', 26],
  ['GDRAWTEXT', 25], ['GSETFONT', 24], ['GSETPEN', 24], ['ARRAYSORT', 15],
  ['CHKDATA', 14], ['RESET_STAIN', 14], ['STOPSOUND', 13], ['FINDELEMENT', 12],
  ['GCLEAR', 12], ['SETANIMETIMER', 12], ['DOTRAIN', 11], ['PRINTSINGLEFORMS', 10],
  ['SUBSTRING', 10], ['CBGSETG', 10], ['GETDEFCOLOR', 10],
];

/** 本批的收录阈值（次）：低于它的词不收（下一档 SUBSTRINGU 9 / QUIT 8 / PRINT_RECT 8 …） */
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
      expect(hits, `${file} 出现指令词手抄字面量（真源只有 erb-directives.ts）：${hits.join(', ')}`).toEqual([]);
    }
  });

  it('负空间自检：扫描器抓得到人造抄本，注释里的引用不算（与守卫口径一致）', () => {
    const synthetic = "const X = ['PRINTFORMDW', 'GOTO'];\n// 'VARSET' 是注释引用\n/* \"PRINTDW\" */\nconst y = './erb-directives';";
    const words = new Set(ERB_DIRECTIVES);
    expect(quotedWordForms(synthetic).filter((w) => words.has(w))).toEqual(['PRINTFORMDW', 'GOTO']);
  });
});

/* ============================== 语料闸：收进来的词必须"真在写" ============================== */

/**
 * 上一节的证据表是**静态**的（读数写死）；这一节是**活的**闸——真语料重扫一遍，
 * 断言每个收进来的词仍能命中至少一次。
 *
 * 它挡的是这一类退化：为了"族完整"塞进 `PRINTLW` / `DEBUGPRINTL` 这种作者根本不写的词。
 * 语料不在位（`KOJO_SMOKE_PROJECT` 未设）⇒ 整组跳过，与其余 `*.corpus.test.ts` 同纪律。
 */
const CORPUS_ROOT = process.env.KOJO_SMOKE_PROJECT;

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

describe.skipIf(!CORPUS_ROOT)('语料闸：词表里的新增词在真语料里仍能命中（`KOJO_SMOKE_PROJECT` 守门）', () => {
  it('本批 59 个词逐个 ≥1 次命中（挡"为族完整塞冷门货"）', () => {
    const counts = statementWordCounts(CORPUS_ROOT!);
    const dead = CORPUS_STATEMENT_GAPS.filter(([w]) => (counts.get(w) ?? 0) === 0).map(([w]) => w);
    expect(dead, `语料零命中（不该收）：${dead.join(', ')}`).toEqual([]);
  }, 900_000);

  it('剩余缺口收敛：未收词的总命中次数 < 1,000（本批 7,454 → 594）', () => {
    const counts = statementWordCounts(CORPUS_ROOT!);
    const known = new Set(ERB_HIGHLIGHT_WORDS.map((w) => w.toUpperCase()));
    let restHits = 0;
    for (const [w, n] of counts) if (!known.has(w)) restHits += n;
    expect(restHits).toBeLessThan(1_000);
  }, 900_000);
});
