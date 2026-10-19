/**
 * 词表**单一真源**守卫（TSIT2-B）——grammar 的词形只能是 `kojo-sugar` 活词表的构建期投影。
 *
 * 背景：`grammar.js` 曾手抄 34 枚中文词形字面量，而词形的活真源是
 * `packages/plugins/kojo-sugar/src/keywords.ts`（+ `statement-functions.ts`）——并行批次随时
 * 登记新中文主形/别名，抄本必发散（新词在 Monarch 高亮生效、CST 却落回 text_line）。
 * 照宿主 Monaco 层同一纪律（`packages/app/tests/kojo-lexicon-single-source.test.ts`）堵死：
 * 词只从投影来，投影只从真源来，忘了重生成即红。
 *
 * 三道闸（与任务书 1:1）：
 * - (a) **字节闸**：committed `src/word-forms.json` 与重新生成的投影逐字节一致
 *   （先走生成器自身的 `--check` 码路，再用导出的纯函数复核——不在测试里 reimplement 第二份生成逻辑）；
 * - (b) **包含闸**：已生成 parser 的 `src/grammar.json` 里每个 token 正则能匹配的**汉字串**
 *   都必须是真源词表的词形（或收束词恒等式 `blockEndWord(开块 id)` 的派生形）——
 *   grammar 若还能匹配一个表外词，红；
 * - (c) **变异闸**：往真源词表注入一枚假词形 `假如新词`（id `block.if`）后重新投影，产物必须
 *   立刻带上它（证明投影真的吃词表、不是另抄），且 committed 产物此刻不含它（证明上游一旦
 *   登记真词、忘了重生成，(a) 必红）。
 *
 * 另附：(c2) 逐 id 完备性（committed 词形集必须与真源**集合相等**，缺一枚新别名也红）、
 * (c3) 记号界标完备（TRY 系写形允许的引擎记号名单同样逐 id 相等，加一枚记号未重生成即红）、
 * (d) 零抄本（grammar.js 去注释后的代码区不得出现"恰为一个词表词形"的字符串字面量，
 * 也不得出现投影里的**整行等值标记 / 引擎记号**——ASCII 名单躲得过 CJK 判据，得单独量）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATEMENT_FUNCTIONS, sugarEditorLexicon } from '@kojo/plugin-kojo-sugar';
import { buildWordForms, loadTruth, serializeWordForms } from '../tools/gen-word-forms.mjs';

const PKG = path.resolve(import.meta.dirname, '..'); // packages/kojo-syntax-tree
const WF_PATH = path.join(PKG, 'src', 'word-forms.json');

/** 真源聚合（经插件公开面 `sugarEditorLexicon()`——守卫吃的是**契约面**，不是私表）。 */
const LEX = sugarEditorLexicon();

/** 收束词形（三族；= blockEndWord(开块 id)，与表内登记的收束主形同一枚）。 */
const END_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['block.loop', 'block.loopEnd'],
  ['block.catch', 'block.catchEnd'],
  ['block.dataTable', 'block.dataTableEnd'],
];

/** grammar 允许匹配的**唯一**词形全集：关键字中英形 ∪ 运算符 ∪ `不在` ∪ 代词 ∪ 续标记 ∪ 收束派生形 ∪ 语句白名单键形。 */
const LEX_WORDS: ReadonlySet<string> = new Set([
  ...LEX.words.map((w) => w.word),
  ...LEX.operators,
  ...LEX.notin,
  ...LEX.reservedPronouns,
  ...LEX.contMarks,
  ...END_PAIRS.map(([, endId]) => {
    const w = LEX.words.find((x) => x.id === endId && x.primary)?.word;
    if (!w) throw new Error(`真源缺收束词形：${endId}`);
    return w;
  }),
  ...STATEMENT_FUNCTIONS.keys(),
]);

/** 汉字（词形用）连续段——全角标点（`：`「」）与 `\\uXXXX` 转义不在 ideograph 段内，不误计。 */
const CJK_IDEO = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const HAS_CJK_IDEO = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** 生成器吃的两份零依赖真源（与 build 时同一加载码路）。 */
const truth = await loadTruth();

describe('词表单源守卫（TSIT2-B）', () => {
  it('(a) 字节闸：committed word-forms.json 与重新生成的投影逐字节一致', () => {
    // ① 走生成器 CLI 的 --check 码路（不一致它自己退非 0，execFileSync 即抛）
    execFileSync(process.execPath, [path.join(PKG, 'tools', 'gen-word-forms.mjs'), '--check'], {
      stdio: 'pipe',
    });
    // ② 再用导出的纯函数复核一遍序列化（防 --check 与写盘码路分叉）
    expect(readFileSync(WF_PATH, 'utf8')).toBe(serializeWordForms(buildWordForms(truth)));
  });

  it('(a2) 确定性：同输入两次投影逐字节相同（排序不依赖 locale）', () => {
    expect(serializeWordForms(buildWordForms(truth))).toBe(serializeWordForms(buildWordForms(truth)));
  });

  it('(b) 包含闸：grammar.json 每个 token 正则里的汉字串都是真源词形', () => {
    const grammar = JSON.parse(readFileSync(path.join(PKG, 'src', 'grammar.json'), 'utf8'));
    // 深度遍历收集**全部字符串值**（PATTERN 的 `value` / STRING 的 `value` 等键形随 CLI 版本变，
    // 不逐键名对表——规则名都是 ASCII，收全量不误计）
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        strings.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const x of node) walk(x);
        return;
      }
      if (node !== null && typeof node === 'object') {
        for (const v of Object.values(node as Record<string, unknown>)) walk(v);
      }
    };
    walk(grammar.rules);
    const patterns = strings.filter((s) => HAS_CJK_IDEO.test(s));
    expect(patterns.length).toBeGreaterThan(40); // token 面非空，守卫别在空集上自欺

    const runs = new Set<string>();
    for (const p of patterns) for (const m of p.match(CJK_IDEO) ?? []) runs.add(m);
    const offenders = [...runs].filter((r) => !LEX_WORDS.has(r));
    expect(
      offenders,
      `grammar 能匹配表外词形（词只能从 kojo-sugar 真源投影来）：${offenders.join(' ')}`,
    ).toEqual([]);
    // 覆盖面自证：投影里的常用词确实出现在 grammar.json（闸不是空转）
    for (const w of ['如果', '时机', '循环结束', '出错处理结束', '数据表结束', '设置标记', '隐藏情景']) {
      expect(runs.has(w), `grammar.json 应能匹配 ${w}`).toBe(true);
    }
  });

  it('(c) 变异闸：注入假词形 ⇒ 投影立刻带上它、committed 产物此刻不含它', () => {
    const fake = '假如新词';
    expect(LEX_WORDS.has(fake)).toBe(false);
    const mutated = {
      ...truth,
      words: [...truth.words, { word: fake, id: 'block.if', role: 'block', primary: true }],
    };
    const out = buildWordForms(mutated as unknown as typeof truth);
    // ① 投影真吃词表：新词形进入 block.if 的择一分支
    expect(out.wordsById['block.if']).toContain(fake);
    // ② committed 产物没有它 ⇒ 上游登记真词后忘重生成为 (a) 红；此刻 (a) 绿 = 无漂移
    const committed = JSON.parse(readFileSync(WF_PATH, 'utf8'));
    expect(committed.wordsById['block.if']).not.toContain(fake);
  });

  it('(c2) 完备性：committed 投影对每个 id 的词形集与真源集合相等（不只"表内词都在真源"）', () => {
    const committed = JSON.parse(readFileSync(WF_PATH, 'utf8')) as {
      wordsById: Record<string, string[]>;
      primaryById: Record<string, string>;
      headDeclIds: string[];
      statementWords: string[];
      endWordOfId: Record<string, string>;
    };
    // 逐 id 集合相等 ⇒ 上游给既有 id 登记新别名后，未重生成的 committed 文件在这一格红
    for (const [id, forms] of Object.entries(committed.wordsById)) {
      const live = truth.words.filter((w) => w.id === id).map((w) => w.word);
      expect([...forms].sort(), `id ${id} 词形集与真源不一致`).toEqual([...live].sort());
    }
    // 真源里有、投影里没的 id 也不许存在（投影面 = 全表，不留"登记了但没投影"的死角）
    const liveIds = [...new Set(truth.words.map((w) => w.id))].sort();
    expect(Object.keys(committed.wordsById).sort()).toEqual(liveIds);
    expect(committed.headDeclIds).toEqual([...truth.headDeclIds]);
    expect(committed.statementWords).toEqual([...STATEMENT_FUNCTIONS.keys()].sort());
    for (const [openId, endId] of END_PAIRS) {
      expect(committed.endWordOfId[openId]).toBe(truth.blockEndWord(openId));
      expect(committed.primaryById[endId]).toBe(committed.endWordOfId[openId]);
    }
  });

  it('(c3) 记号界标完备：committed engineTokenSets 与真源派生集合逐 id 相等', () => {
    // 与 (c2) 同一条理由，只换个对象：TRY 系写形的界标不是词、是识别核那张名单
    // （`lexer.ts::TRY_ECHO_TOKENS` ⇄ `sugar-ident.ts` 的成员集合）。上游加一枚记号或加一张成员
    // 集合而忘了重生成 ⇒ grammar 就少认一枚，写形行静默落回 text_line——正是本批要堵的那类死角。
    const committed = JSON.parse(readFileSync(WF_PATH, 'utf8')) as {
      engineTokenSets: Record<string, string[]>;
    };
    const fresh = buildWordForms(truth).engineTokenSets as Record<string, string[]>;
    expect(Object.keys(committed.engineTokenSets).sort(), '界标族目录与真源指针表不等').toEqual(
      Object.keys(fresh).sort(),
    );
    for (const id of Object.keys(fresh)) {
      expect([...committed.engineTokenSets[id]].sort(), `记号名单与真源不等：${id}`).toEqual([...fresh[id]].sort());
      // 覆盖面自证：本族确实派生出了记号（空名单 = 抽取判据漂了，与"没这项"同样坏）
      expect(fresh[id].length, `真源派生出的记号名单为空：${id}`).toBeGreaterThan(0);
    }
  });

  it('(d) 零抄本：grammar.js 代码区除诊断语外不含任何汉字词形', () => {
    const src = readFileSync(path.join(PKG, 'grammar.js'), 'utf8');
    let stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // 唯一允许的汉字位：`throw new Error(...)` 诊断语（人类可读文本，禁的是**词形**抄本）
    stripped = stripped.replace(/^.*\bthrow new Error\b.*$/gm, '');
    const leaks = stripped.match(CJK_IDEO) ?? [];
    expect(leaks, `grammar.js 代码区残留汉字词形字面量（词只能经 word-forms.json 投影进来）：${[...new Set(leaks)].join(' ')}`).toEqual([]);
    // 双保险（与宿主守卫同判据）：字符串字面量不得"整条恰为一个词表词形"
    const literals = stripped.match(/'[^'\n]*'|"[^"\n]*"/g) ?? [];
    const hits = literals.map((l) => l.slice(1, -1).trim()).filter((c) => LEX_WORDS.has(c));
    expect(hits, `grammar.js 出现词表词形手抄字面量：${hits.join(' ')}`).toEqual([]);
    // 同一把尺量**记号**（汉字词形之外的那两类判据）：整行等值标记与引擎记号名单只准从投影来。
    // ASCII 名单逃得过上面的 CJK 判据，不设这一格就等于给"手添字面量"留了一条明路。
    const projected = JSON.parse(readFileSync(WF_PATH, 'utf8')) as {
      rawLineRules: { exactMarkers: { marker: string }[] };
      engineTokenSets: Record<string, string[]>;
    };
    const markAndTokenNames = [
      ...projected.rawLineRules.exactMarkers.map((m) => m.marker),
      ...Object.values(projected.engineTokenSets).flat(),
    ];
    const copied = markAndTokenNames.filter((name) => stripped.includes(name));
    expect(
      copied,
      `grammar.js 手抄了投影里的记号（整行等值标记 / 引擎记号名单只准经 rawLineRules·engineTokenSets 取）：${copied.join(' ')}`,
    ).toEqual([]);
  });

  it('(d2) 词形只从投影来：committed 投影用到的每个 id 都经真源派生（无表外 id）', () => {
    const committed = JSON.parse(readFileSync(WF_PATH, 'utf8')) as {
      wordsById: Record<string, string[]>;
    };
    const liveIds = new Set(truth.words.map((w) => w.id));
    const offenders = Object.keys(committed.wordsById).filter((id) => !liveIds.has(id));
    expect(offenders, `投影含真源没有的 id：${offenders.join(',')}`).toEqual([]);
  });
});
