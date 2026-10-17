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

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_DIRECTIVES, mergeDirectiveWords, setErbDirectiveWords } from '../src/monaco/erb-language';
import { ERB_COMMANDS, ERB_FAMILY_HEADS } from '../src/monaco/kojo-language';

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
