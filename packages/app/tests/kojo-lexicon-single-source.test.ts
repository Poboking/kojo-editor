/**
 * 词表**单一真源**守卫（ZH-L）——宿主层（`packages/app/src/monaco/`）零手抄词形。
 *
 * 真源 = `@kojo/plugin-kojo-sugar` 的 `sugarEditorLexicon()`（聚合：关键字中文主形 /
 * 英文别名 / 运算符 / 不等待标记 / 保留代词 / `不在`）与 `SYSTEM_FUNCTION_ALIASES`。
 * 宿主与转译器若各抄一份词表，转译器登记新词（并行批次随时扩表，如随机形 / 直出 /
 * 等待 / 选择器一类）后宿主高亮就悄悄落后——抄本必发散，故用测试堵死。
 *
 * 扫描口径对照 `no-sugar-jargon.test.ts`：
 * - 查**字符串字面量**（单 / 双 / 反引号），先抹注释与正则字面量（同一状态机打法）；
 * - 红条件 = 字面量内容（去两端空白）**恰为**一个词表词形（含 `：`/`:` 收尾的块头形）——
 *   只抄「整个字面量就是这个词形」才算词表抄本；散文里顺笔提到某词（`函数 · XX`、
 *   「不在 ERB 函数索引内」这类普通中文叙述）不算抄本，不红；
 * - 正则字面量**不在本守卫范围内**：行首判定正则里嵌的 `时机` / `是` 是**上下文判定**
 *   （"什么位置算块头"），不是词形登记面，各文件自己的测试已钉行为。这与
 *   `no-sugar-jargon` 抹正则的口径同源——把判定逻辑错判成抄本会让守卫不可维护。
 *
 * 另断言真人真脏场景：`kojo-language.ts` 早先手抄 `['续','cont','continue']`（丢了
 * `~` / `⏎`，害作者写 `~` 不高亮，D7 缺陷的成因）——本测试保证**宿主固定集合为零**，
 * 量与形都只能从聚合来。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_FUNCTION_ALIASES, sugarEditorLexicon } from '@kojo/plugin-kojo-sugar';
import {
  CONT_MARKS,
  CONT_SYMBOLS,
  ERB_COMMANDS,
  ERB_FAMILY_HEADS,
  KOJO_LEXICON,
  NOTIN_MARKS,
  OPERATOR_WORDS,
  PRONOUN_WORDS,
  SYSTEM_FUNCTION_WORDS,
} from '../src/monaco/kojo-language';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MONACO_DIR = path.join(ROOT, 'packages', 'app', 'src', 'monaco');

/* ============================== 词表（真源聚合原样读） ============================== */

const LEX = sugarEditorLexicon();

/** 真源里的**中文词形**全集（守卫对象 = 中文词形；英文别名是 ASCII 输入面，不算手抄对象） */
const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/;
const LEXICON_CJK_WORDS: readonly string[] = [
  ...LEX.words.filter((w) => CJK_RE.test(w.word)).map((w) => w.word),
  ...LEX.operators,
  ...LEX.notin,
  ...LEX.reservedPronouns,
  ...LEX.contMarks.filter((m) => CJK_RE.test(m)),
  ...[...SYSTEM_FUNCTION_ALIASES.keys()].filter((k) => CJK_RE.test(k)),
];
/** 非字词形判定：与宿主 `kojo-language.ts` 的 WORD_CHAR 同口径（有任一字词字符即字词形） */
const WORD_CHAR_RE = /[A-Za-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/;
/** 非字词形（`~` / `⏎` 符号形）也按抄本计——当年抄本恰恰缺了它们（红名单会泄底的红） */
const CONT_SYMBOL_SET: readonly string[] = [...new Set(LEX.contMarks.filter((m) => !WORD_CHAR_RE.test(m)))];

/* ============================== 字面量抽取 ============================== */

/** 正则出现在"可以开正则"的位置吗（与 no-sugar-jargon 同表） */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new', 'delete',
  'void', 'yield', 'await', 'instanceof', 'throw',
]);

function atRegexStart(before: string): boolean {
  const t = before.replace(/\s+$/, '');
  if (t.length === 0) return true;
  const last = t[t.length - 1]!;
  if (!/[\w$)\]]/.test(last)) return true;
  const word = /[\w$]+$/.exec(t.slice(-16))?.[0] ?? '';
  return REGEX_KEYWORDS.has(word);
}

interface StringLiteral {
  /** 引号内原文（未反转义；词形不加反斜杠 ⇒ 逐字比对安全） */
  readonly content: string;
  /** 1 基行号 */
  readonly line: number;
}

/**
 * 按序扫描源码，摘出全部字符串字面量（跳过注释与正则——抹非字符串的同一纪律，
 * 注释里的词形是说明、正则里的词形是判定，都不算抄本）。
 */
function stringLiterals(src: string): StringLiteral[] {
  const out: StringLiteral[] = [];
  let i = 0;
  const n = src.length;
  const lineStarts: number[] = [0];
  for (let k = 0; k < n; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (idx: number): number => {
    // idx 恰在 "\n" 前（CRLF 分隔处）时 slice 落在下一行开头，行号 = 已过换行数
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      i = Math.min(n, j + 2);
      continue;
    }
    if (c === '/' && atRegexStart(src.slice(0, i))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (inClass) {
          if (ch === ']') inClass = false;
          j++;
          continue;
        }
        if (ch === '[') {
          inClass = true;
          j++;
          continue;
        }
        if (ch === '/') {
          j++;
          while (j < n && /[gimsuyvd]/.test(src[j] ?? '')) j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        i = j;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = src[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if ((c === "'" || c === '"') && ch === '\n') break;
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        const content = src.slice(i + 1, j - 1);
        out.push({ content, line: lineOf(i) });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

function monacoSourceFiles(): { abs: string; rel: string; src: string }[] {
  const out: { abs: string; rel: string; src: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?)$/.test(e.name)) {
        const abs = p;
        out.push({ abs, rel: path.relative(ROOT, abs).replaceAll('\\', '/'), src: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(MONACO_DIR);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/* ============================== 真源派生面（宿主侧） ============================== */

let files: ReturnType<typeof monacoSourceFiles>;

beforeAll(() => {
  files = monacoSourceFiles();
});

describe('宿主词表 = 聚合真源（零加工、零抄本）', () => {
  it('聚合词表非空且含全形（守卫别在空表上自欺）', () => {
    expect(LEXICON_CJK_WORDS.length).toBeGreaterThan(40);
    expect(CONT_SYMBOL_SET.length).toBeGreaterThan(0);
    // words（关键字层 KüŞ含中英双形）之外，聚合还挂运算符 / `不在` / 代词 / 系统函数名四路中文形
    expect(LEXICON_CJK_WORDS.length).toBeGreaterThan(LEX.words.filter((w) => CJK_RE.test(w.word)).length);
  });

  it('kojo-language.ts 转发聚合时零加工（同引用级转发，不是第二份拷贝）', () => {
    const fresh = sugarEditorLexicon();
    // `sugarEditorLexicon()` 每次返回新壳但**共享**同一批内表——宿主若做过 filter/map/排序等
    // 加工，产物就是宿主自己的新数组，引用级比较立刻红。
    expect(KOJO_LEXICON.words.length).toBe(fresh.words.length);
    expect(KOJO_LEXICON.words.every((w, i) => w === fresh.words[i])).toBe(true);
    expect(KOJO_LEXICON.notin).toBe(fresh.notin);
    expect(KOJO_LEXICON.contMarks).toBe(fresh.contMarks);
    expect(KOJO_LEXICON.reservedPronouns).toBe(fresh.reservedPronouns);
    expect(KOJO_LEXICON.operators).toBe(fresh.operators);

    // 宿主导出面逐项等于聚合对应形（readonly 转发，不重排、不增删）
    expect(CONT_MARKS).toBe(KOJO_LEXICON.contMarks);
    expect(NOTIN_MARKS).toBe(KOJO_LEXICON.notin);
    expect(PRONOUN_WORDS).toBe(KOJO_LEXICON.reservedPronouns);
    // 运算符组 = 聚合运算符 + `不在`（同一档补全/着色；只能来自聚合，不许宿主另写一个名字）
    expect(OPERATOR_WORDS.length).toBe(fresh.operators.length + fresh.notin.length);
    expect(OPERATOR_WORDS.slice(0, fresh.operators.length).toString()).toBe([...fresh.operators].toString());
    expect(OPERATOR_WORDS.slice(fresh.operators.length).toString()).toBe([...fresh.notin].toString());
    // 系统函数中文名 = SYSTEM_FUNCTION_ALIASES 键集全等（宿主零抄本）
    expect(SYSTEM_FUNCTION_WORDS.length).toBe(SYSTEM_FUNCTION_ALIASES.size);
    for (const k of SYSTEM_FUNCTION_ALIASES.keys()) expect(SYSTEM_FUNCTION_WORDS.includes(k)).toBe(true);
  });

  it('不等待标记的符号形（`~`/`⏎`）真正派生于聚合（宿主零固定集合——D7 缺陷成因的负空间）', () => {
    // 宿主侧除 CONT_SYMBOLS 外不允许再出现任何"标志集合"手写词形（下面紧随的抄本守卫管）；
    // 这里钉的是派生式：符号形 = 聚合 contMarks 抹掉**字词形**（有任一字词字符者，含 `cont`/
    // `continue` 这类 ASCII 别名——与 kojo-layer 的 WORD_CHAR 完全同口径），且非空。
    const derived = [...CONT_MARKS].filter((m) => !WORD_CHAR_RE.test(m));
    expect(CONT_SYMBOLS.length).toBe(derived.length);
    expect(CONT_SYMBOLS.every((s) => derived.includes(s))).toBe(true);
    expect(CONT_SYMBOL_SET.every((s) => CONT_SYMBOLS.includes(s))).toBe(true);
    expect(CONT_SYMBOLS.every((s) => s.length === 1 && !WORD_CHAR_RE.test(s))).toBe(true);
  });

  it('族头档 = ENGINE_VARIABLE_FAMILIES 全集（宿主零增删），指令档滤族头后无死角', () => {
    expect(ERB_FAMILY_HEADS.length).toBeGreaterThan(10);
    expect(new Set([...ERB_FAMILY_HEADS]).size).toBe(ERB_FAMILY_HEADS.length); // 无重复
    // 指令档（ERB_COMMANDS）不许混进任何族头——混进 = 词表两档同词、着色口径打架
    const family = new Set([...ERB_FAMILY_HEADS]);
    for (const d of [...ERB_COMMANDS]) expect(family.has(d), `指令档混入族头 ${d}`).toBe(false);
    expect(ERB_COMMANDS.length).toBeGreaterThan(20);
    // 族头 / 指令都是行首全大写规则（[A-Z][A-Z0-9_]*）能命中的形——小写/空格名进不了该规则
    for (const w of [...ERB_FAMILY_HEADS, ...ERB_COMMANDS]) {
      expect(w).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('宿主 monaco 层零手抄词形（字母级守卫）', () => {
  it('扫描面非空（kojo-language.ts 在册）', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.rel.endsWith('src/monaco/kojo-language.ts'))).toBe(true);
  });

  it('字符串字面量里没有"整条等于词表中文名"的抄本', () => {
    const words = new Set([...LEXICON_CJK_WORDS, ...CONT_SYMBOL_SET]);
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f.abs, 'utf8');
      for (const lit of stringLiterals(src)) {
        // 红条件：字面量（去首尾空白）恰为词形，或词形 + 块头冒号收尾（`角色:` 这一声明的标准形）
        const bare = lit.content.trim();
        const colonStripped = bare.endsWith('：') || bare.endsWith(':') ? bare.slice(0, -1).trim() : bare;
        if (words.has(colonStripped)) {
          hits.push(`${f.rel}:${lit.line} 「${lit.content}」`);
        }
      }
    }
    expect(hits, `monaco 层出现词表词形手抄字面量（词形只能从 @kojo/plugin-kojo-sugar 聚合来）：\n${hits.join('\n')}`).toEqual([]);
  });
});
