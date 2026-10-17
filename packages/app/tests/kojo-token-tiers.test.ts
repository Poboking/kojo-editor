import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  ERB_COMMANDS,
  ERB_FAMILY_HEADS,
  KOJO_SUGAR_THEME_RULES,
  KOJO_TOKEN_TIERS,
  registerKojoLanguage,
} from '../src/monaco/kojo-language';
import { registerErbLanguage } from '../src/monaco/erb-language';
import { SYSTEM_FUNCTION_ALIASES, sugarEditorLexicon } from '@kojo/plugin-kojo-sugar';

/**
 * ZH-L 档位验收——**功能级判据**，不是体积读数：
 *
 * ① Monarch 真编译：`kojo-language.ts` 的语言定义交给 monaco-editor **同版本**的真编译器
 *    `compile()`（`monarchCompile.js` 的导出物，不是测试自造第二份解析器）。编译期就会走
 *    `createGuard`——任何 `@attr` 引用缺属性 / 非字符串数组都当场抛 ⇒ 编译通过本身即
 *    "词表接线成立"的第一真判据。
 * ② 逐词发射：编译产物喂给复刻 `monarchLexer.js::_myTokenize` 语义的**根状态驱动器**
 *    （逐条规则在剩余行上匹配、`@attr` 卫兵逐档判词、群组逐子段发射、空组免发射、
 *    next 进栈 / `@pop` 退栈），**逐词**断言聚合词表的每个词形确实发出该档 token。
 *    词形一律从聚合读、**不点名**：ZH-E 后续登记新中文主形时本测试零改动自动覆盖。
 * ③ 档位表闭合：`KOJO_TOKEN_TIERS` 恰好盖住糖主题 token 全集，且每档 token 能被
 *    Monarch 真发出来（"配了色却永远不出的 token"= 假档）。
 * ④ 主题接线：不走"测试里 import 色值自己再抄一份"的旁路，而是真装配
 *    `registerErbLanguage`——`kojo-dark` 主题 rules 里糖档规则每个对象**原样在场**。
 * ⑤ 深底可读：对 vs-dark 基底 `#1e1e1e` 算 WCAG 对比度（全部档位 ≥ 4.46:1；本词表
 *    最低档 `sugar.keyword.alias` 读数 4.47），任意两档前景按 CIE76 Lab 色差矩阵算
 *    （全部 ≥ 12；当前读数最小值 12.6 —— `sugar.system-function` #61afce ↔
 *    `sugar.operator` #56b6c2，这两档先于本批存在，即本线继承的基线）。分层的意义
 *    是"屏上一眼分层"，撞色 = 假分层，故按色差判，不按"手数对了"判。
 */

const LEX = sugarEditorLexicon();

/* ============================== 假 Monaco（捕获 Monarch def 与主题） ============================== */

interface Captured {
  readonly registered: string[];
  readonly monarchs: Map<string, Monaco.languages.IMonarchLanguage>;
  readonly themes: Map<
    string,
    { base: string; inherit: boolean; rules: Monaco.editor.ITokenThemeRule[]; colors: Record<string, string> }
  >;
  readonly configs: unknown[];
}

function stubMonaco(): { monaco: typeof Monaco; captured: Captured } {
  const captured: Captured = { registered: [], monarchs: new Map(), themes: new Map(), configs: [] };
  const monaco = {
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      getLanguages: () => captured.registered.map((id) => ({ id })),
      register: (data: { id: string }) => {
        captured.registered.push(data.id);
      },
      setMonarchTokensProvider: (id: string, def: Monaco.languages.IMonarchLanguage) => {
        captured.monarchs.set(id, def);
        return { dispose: () => undefined };
      },
      setLanguageConfiguration: (id: string, config: unknown) => {
        captured.configs.push({ id, config });
      },
    },
    editor: {
      defineTheme: (name: string, theme: unknown) => {
        captured.themes.set(
          name,
          theme as {
            base: string;
            inherit: boolean;
            rules: Monaco.editor.ITokenThemeRule[];
            colors: Record<string, string>;
          },
        );
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, captured };
}

const { monaco, captured } = stubMonaco();
registerKojoLanguage(monaco);
registerErbLanguage(monaco);
const def = captured.monarchs.get('kojo-sugar');
if (!def) throw new Error('monaco 桩没捕获到 kojo-sugar 的 Monarch def（装配面漂 = 本文件整个红）');
const kojoDark = captured.themes.get('kojo-dark');
if (!kojoDark) throw new Error('monaco 桩没捕获到 kojo-dark 主题（erb-language 装配面漂 = 本文件整个红）');

/* ============================== Monarch 真编译 + 驱动器 ============================== */

interface Rule {
  regex: RegExp | ((state: string) => RegExp);
  action: Action;
  matchOnlyAtLineStart: boolean;
}
type Action =
  | string
  | { token: string; next?: string }
  | { test: (id: string, matches: string[], state: string, eos: boolean) => unknown }
  | Action[];
interface Lexer {
  start: string | null;
  defaultToken: string;
  tokenPostfix: string;
  tokenizer: Record<string, Rule[]>;
}
interface Emit {
  readonly text: string;
  readonly token: string;
}

async function monarchLexer(): Promise<Lexer> {
  // 深层模块无 subpath 类型 ⇒ 变量路径动态 import（cjk-typing 的 monacoInternal 同款；TS 记 any）
  const sub = 'standalone/common/monarch/monarchCompile.js';
  const m = (await import(/* @vite-ignore */ `monaco-editor/editor/${sub}`)) as unknown as {
    compile: (id: string, json: unknown) => Lexer;
  };
  return m.compile('kojo-sugar', def);
}
const lexerP: Promise<Lexer> = monarchLexer();

/** 聚合词形 → 应得档位（分类次序 = Monarch `cases` 卫兵的判词次序，同名多档者以先判为准） */
function expectedTokenFor(word: string): string {
  if (LEX.contMarks.includes(word)) return 'sugar.cont';
  if (LEX.operators.includes(word) || LEX.notin.includes(word)) return 'sugar.operator';
  if (LEX.reservedPronouns.includes(word)) return 'sugar.pronoun';
  const entry = LEX.words.find((w) => w.word === word);
  if (entry) return entry.primary ? 'sugar.keyword' : 'sugar.keyword.alias';
  if (SYSTEM_FUNCTION_ALIASES.has(word)) return 'sugar.system-function';
  throw new Error(`判据词形「${word}」不在聚合词表任何一层（判据集合本身错了）`);
}

/** 聚合字词形全集（含英文别名——别名属输入面，也走真驱动；连字符别名见 it() 内说明） */
const WORD_FORMS: { word: string; expect: string }[] = [
  ...LEX.words.map((w) => ({ word: w.word, expect: expectedTokenFor(w.word) })),
  ...[...LEX.operators, ...LEX.notin].map((w) => ({ word: w, expect: 'sugar.operator' })),
  ...LEX.reservedPronouns.map((w) => ({ word: w, expect: 'sugar.pronoun' })),
  ...[...SYSTEM_FUNCTION_ALIASES.keys()].map((w) => ({ word: w, expect: expectedTokenFor(w) })),
].filter((f, i, all) => all.findIndex((g) => g.word === f.word) === i); // 同词多登记（别名 ∩ 系统函数）只驱动一次

/** ERB 指令档 / 族头档：行首规则才命中 ⇒ 判据行必须以该词开头 */
const ERB_FORMS: { word: string; expect: string }[] = [
  ...[...ERB_FAMILY_HEADS].map((w) => ({ word: w, expect: 'keyword.erb.family' })),
  ...[...ERB_COMMANDS].map((w) => ({ word: w, expect: 'keyword.erb' })),
];

/* ------------------------------ 驱动器（复刻 _myTokenize） ------------------------------ */

interface Piece {
  readonly action: Action;
  readonly matched: string;
}
interface Resolved {
  readonly tokens: Emit[];
  readonly next?: string;
  /** 群组：逐段受理（monarchLexer 的 groupMatching 迭代语义） */
  readonly pieces?: readonly Piece[];
}

/**
 * action 解析链（monarchLexer 536-545 + monarchCompile cases test 链的等价复刻）：
 * 向下解 test（cases 卫兵）直到字符串 / {token} / 群组数组。
 * `exec` = 该规则的完整正则匹配数组（群组展开要用子匹配；非群组可 null）。
 */
function resolveAction(action: Action, matched: string, exec: RegExpExecArray | null): Resolved {
  let a: unknown = action;
  for (let hop = 0; hop < 32; hop++) {
    if (typeof a === 'string') {
      return a === '' ? { tokens: [] } : { tokens: [{ text: matched, token: a }] };
    }
    // 编译产物里群组是 `{ group: [...] }` 对象（monarchCompile L305-308）；数组是原始 def 形态
    if (Array.isArray(a)) {
      if (!exec) throw new Error('群组动作需要完整 exec');
      return { tokens: [], pieces: a.map((sub, i) => ({ action: sub as Action, matched: exec[i + 1] ?? '' })) };
    }
    const actionObj = a as {
      token?: string;
      next?: string;
      group?: unknown[];
      test?: (id: string, matches: string[], state: string, eos: boolean) => unknown;
    } | null | undefined;
    if (actionObj === null || actionObj === undefined) return { tokens: [] };
    if (actionObj.test !== undefined) {
      a = actionObj.test(matched, exec ?? [matched, matched], '', false);
      continue;
    }
    if (actionObj.group !== undefined) {
      if (!exec) throw new Error('群组动作需要完整 exec（判据行形态不支持）');
      const pieces: Piece[] = [];
      for (let i = 0; i < actionObj.group.length; i++) {
        pieces.push({ action: actionObj.group[i] as Action, matched: exec[i + 1] ?? '' });
      }
      if (exec.length !== pieces.length + 1) {
        throw new Error(`群组数目与子段不齐：exec.length=${exec.length} pieces=${pieces.length}`);
      }
      return { tokens: [], pieces };
    }
    const token = actionObj.token ?? '';
    return token === '' ? { tokens: [] } : { tokens: [{ text: matched, token }], next: actionObj.next };
  }
  return { tokens: [] };
}

/**
 * 根状态驱动器：把一行交给编译产物逐条规则匹配并发射 token。
 * 语义锚点：`String.match`/`exec` 在 `^(?:…)` 锚定正则上等价于"从当前 pos 起步匹配"；
 * 规则列表序 = 匹配优先序；群组逐子段、空子段免发射（monarchLexer 691-694）；逐次推进。
 * 判据行不依赖跨状态深度（未进台词 / 插值 / 围栏态的任务留给真机壳冒烟）。
 */
async function driveRoot(line: string): Promise<Emit[]> {
  const lexer = await lexerP;
  const rules = lexer.tokenizer[lexer.start ?? 'root'];
  if (!rules) throw new Error(`Monarch def 没有根状态 ${lexer.start ?? 'root'}`);
  const out: Emit[] = [];
  // Monaco 屏上真发的是 token 名 + tokenPostfix（编译器按语言 id 默认补 `.kojo-sugar`），
  // 主题规则按点分段前缀匹配 —— 驱动器同样补上，断言走完整的 `startsWith('sugar.cont.')` 前缀口径
  const lexerPostfix = lexer.tokenPostfix as unknown as string;
  const emitInto = (tokens: readonly Emit[]): void => {
    for (const t of tokens) out.push({ text: t.text, token: t.token === '' ? '' : `${t.token}${lexerPostfix}` });
  };
  let pos = 0;
  let stack: string[] = [lexer.start ?? 'root'];
  let pending: readonly Piece[] = [];
  let steps = 0;

  while (pos < line.length) {
    if (++steps > line.length * 3 + 64) throw new Error(`驱动器无进展：line=${line}`);
    // 1) 挂起的群组子段优先受理（monarchLexer：groupEntry 先于重新匹配）
    if (pending.length > 0) {
      const pieces = pending;
      pending = [];
      for (const piece of pieces) {
        if (piece.matched.length === 0) continue; // 空子段免发射（monarchLexer 691-694 的组数变化判）
        pos += piece.matched.length;
        const r = resolveAction(piece.action, piece.matched, null);
        emitInto(r.tokens);
        if (r.next) throw new Error('群组子段带 next：判据行形态不支持');
      }
      continue;
    }
    // 2) 状态内逐条规则试匹配（monarchLexer 504-513：列表序首个命中者生效）
    const state = stack[stack.length - 1]!;
    const stateRules: readonly Rule[] = (lexer.tokenizer[state] ?? executeMissing(state)) as readonly Rule[];
    let matched: string | null = null;
    let exec: RegExpExecArray | null = null;
    let action: Action | null = null;
    for (const rule of stateRules) {
      if (pos !== 0 && rule.matchOnlyAtLineStart) continue;
      const re = typeof rule.regex === 'function' ? rule.regex(state) : rule.regex;
      const m = re.exec(line.slice(pos));
      if (m) {
        exec = m;
        matched = m[0]!;
        action = rule.action;
        break;
      }
    }
    // 3) 全无命中 ⇒ 吃一字符、零 token（monarchLexer 516-528 的 defaultToken 分支）
    if (matched === null || exec === null || action === null) {
      pos += 1;
      continue;
    }
    pos += matched.length;
    const r = resolveAction(action, matched, exec);
    if (r.pieces) {
      pending = r.pieces;
      pos -= matched.length; // 群组受理从子段重计（monarchLexer 672 同调）
      continue;
    }
    emitInto(r.tokens);
    // 4) 状态转移（monarchLexer 589-622 的 next 分支）
    if (r.next !== undefined) {
      if (r.next === '@pop') stack.pop();
      else if (r.next === '@push') stack.push(state);
      else stack.push(r.next.startsWith('@') ? r.next.slice(1) : r.next);
    }
  }
  return out;

  function executeMissing(state: string): never {
    throw new Error(`状态 ${state} 在 Monarch def 里没有规则表`);
  }
}

/* ============================== 发射覆盖（聚合词表全覆盖·不点名） ============================== */

describe('Monarch 词法逐词发射（聚合词表全覆盖·不点名）', () => {
  it('真编译器在位（monaco 同版本 compile 导出）——编译期 @attr 卫兵/词表数组成形一次过', async () => {
    const lexer = await lexerP;
    expect(typeof lexer).toBe('object');
    expect(Object.keys(lexer.tokenizer)).toContain('root');
  });

  it('聚合词表逐词：中文主形 / 运算符 / `不在` / 代词 / 系统函数名 / 英文别名各发应得档位 token', async () => {
    expect(WORD_FORMS.filter((f) => !f.word.includes('-')).length).toBeGreaterThan(60); // 聚合非空跑（不点名，只钉规模线：f014efd 基线 ≈ 90 形）
    for (const form of WORD_FORMS) {
      if (form.word.includes('-')) {
        // 连字符别名（player-color / function-prefix / skip-scene…）：Monarch 的 ASCII 词规则
        // 按 wordPattern 分段扫描（A3 口径），连字符整词着色属"最佳努力"（规范 §7 定调 v1）。
        // 词形归属已在编译期钉住（@@englishAliases attr 已进 def；无论切在哪个词段）。
        continue;
      }
      const emitted = await driveRoot(`${form.word} 备注`);
      const hit = emitted.filter((e) => e.token.startsWith(`${form.expect}.`));
      expect(hit.length, `「${form.word}」期望 ${form.expect} 档，实发 [${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}]`).toBeGreaterThan(0);
      expect(hit[0]!.text, `「${form.word}」应整段（CJK 词形不分半切）发出`).toBe(form.word);
    }
  });

  it('符号形不等待标记（聚合派生的 `~` / `⏎`）发出 sugar.cont——"单开规则"缺陷修复的功能面', async () => {
    const symbols = new Set(
      LEX.contMarks.filter(
        (m) => m.length === 1 && !/[A-Za-z0-9_]/.test(m) && !/[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/.test(m),
      ),
    );
    expect(symbols.size).toBeGreaterThan(0);
    for (const sym of symbols) {
      const emitted = await driveRoot(`行 ${sym} 尾`);
      const hit = emitted.find((e) => e.token.startsWith('sugar.cont.'));
      expect(hit, `符号 ${sym} 没进 cont 档（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`).toBeDefined();
      expect(hit!.text).toBe(sym);
    }
  });

  it('组合行：族头 + 代词 + cont 三档同屏各自发色（CFLAG:她 = 5 ~）', async () => {
    const emitted = await driveRoot(`CFLAG:她 = 5 ~`);
    const joined = emitted.map((e) => `${e.text}=${e.token}`).join(' ');
    expect(emitted.find((e) => e.token.startsWith('keyword.erb.family.')), joined).toBeDefined();
    expect(emitted.find((e) => e.token.startsWith('sugar.pronoun.')), joined).toBeDefined();
    expect(emitted.find((e) => e.token.startsWith('sugar.cont.') && e.text === '~'), joined).toBeDefined();
  });

  it('词表外的中文串 = 名字层 sugar.slot（不再掉回 identifier——名字层一档的成立面）', async () => {
    // 判据词形刻意挑聚合词表外的生僻字；若聚合将来扩到这些字，本测试会红——换生僻样即可
    // （设计好的变红方式，比静默漂移好）。
    for (const w of ['彗', '攫', '熵']) {
      const emitted = await driveRoot(`${w}的风风语首要语段`);
      const hit = emitted.find((e) => e.token.startsWith('sugar.slot.'));
      expect(hit, `「${w}…」应为名字层（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`).toBeDefined();
      expect(hit!.text).toBe(`${w}的风风语首要语段`);
    }
  });

  it('ERB 指令档 / 族头档：行首全大写一词各发对应档位 token，且族头不押去 keyword.erb（真驱动逐词）', async () => {
    expect(ERB_FORMS.length).toBe([...ERB_FAMILY_HEADS].length + [...ERB_COMMANDS].length);
    for (const form of ERB_FORMS) {
      const emitted = await driveRoot(form.word);
      const hit = emitted.find((e) => e.token.startsWith(`${form.expect}.`));
      expect(hit, `「${form.word}」期望 ${form.expect} 档，实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`).toBeDefined();
      expect(hit!.text).toBe(form.word);
      if (form.expect === 'keyword.erb.family') {
        // 族头分档死角哨：走 plain keyword.erb（不带 family 后缀）的发射必须为零
        expect(
          emitted.find((e) => e.token.startsWith('keyword.erb.') && !e.token.startsWith('keyword.erb.family.')),
          `「${form.word}」押去了指令档 keyword.erb（族头/指令拆分死角）`,
        ).toBeUndefined();
      }
    }
  });

  it('行中 ERB 指令走 ASCII 兜底 cases（接线面静态判据，行内细节交真机壳冒烟）', async () => {
    const names = collectDefAttrNames();
    for (const w of [...ERB_FAMILY_HEADS, ...ERB_COMMANDS]) {
      expect(names.has(w), `「${w}」没有进归一化的 @attr 档位集合（编译期会全场盲）`).toBe(true);
    }
    /** 驱动器+编译器的双保险之外，这里把 def 里两条行内词规则（CJK + ASCII cases）的
     *  兜底属性键收归一化，让"哪些词应被行内兜底认出"有静态看真源口 */
    function collectDefAttrNames(): Set<string> {
      const flat = new Set<string>();
      for (const key of ['contMarks', 'pronouns', 'primaryWords', 'englishAliases', 'erbCommands', 'erbFamilyHeads']) {
        const v = (def as unknown as Record<string, unknown>)[key];
        if (Array.isArray(v)) for (const s of v as string[]) flat.add(s);
      }
      return flat;
    }
  });
});

/* ============================== 档位表闭合 + 主题接线 ============================== */

/** 从 Monarch def 静态收集全部能发出的 token 名（验收"档位 token 有发射点"） */
function tokenizerTokenNames(): Set<string> {
  const out = new Set<string>();
  const tokenizer = (def as unknown as { tokenizer: Record<string, readonly [unknown, Action][]> }).tokenizer;
  const visitAction = (a: Action): void => {
    if (typeof a === 'string') {
      if (a.length > 0) out.add(a);
      return;
    }
    if (Array.isArray(a)) {
      for (const sub of a) visitAction(sub);
      return;
    }
    const o = a as { token?: string; cases?: Record<string, Action> };
    if (o.token !== undefined && o.token.length > 0) out.add(o.token);
    if (o.cases) for (const v of Object.values(o.cases)) visitAction(v);
  };
  for (const rules of Object.values(tokenizer)) {
    for (const rule of rules) visitAction(rule[1]);
  }
  return out;
}

describe('KOJO_TOKEN_TIERS 档位表（作者可见的分层口径）', () => {
  const emittedTokens = tokenizerTokenNames();
  const tierTokens = KOJO_TOKEN_TIERS.flatMap((t) => [...t.tokens]);
  const ruleTokens = KOJO_SUGAR_THEME_RULES.map((r) => r.token);

  it('档位名唯一，每档 token 非空，每档都写得出"为什么值得一档"', () => {
    expect(new Set(KOJO_TOKEN_TIERS.map((t) => t.tier)).size).toBe(KOJO_TOKEN_TIERS.length);
    for (const t of KOJO_TOKEN_TIERS) {
      expect(t.tokens.length).toBeGreaterThan(0);
      expect(t.why.trim().length).toBeGreaterThan(0);
    }
  });

  it('档位表恰好盖住糖主题 token 全集（一档不落，一 token 不双重登记）', () => {
    expect(new Set(tierTokens).size).toBe(tierTokens.length);
    expect(new Set(tierTokens).size).toBe(new Set(ruleTokens).size);
    for (const tok of new Set(ruleTokens)) {
      expect(new Set(tierTokens).has(tok), `主题规则 token ${tok} 没进档位表`).toBe(true);
    }
  });

  it('每档 token 都被 Monarch 真发出来（配了色却没发射点 = 假档）', () => {
    for (const tok of new Set(tierTokens)) {
      expect(
        [...emittedTokens].some((e) => e === tok || e.startsWith(`${tok}.`)),
        `档位 token ${tok} 在 Monarch def 里没有发射点`,
      ).toBe(true);
    }
  });

  it('kojo-dark 主题接线真成立：糖档规则每个对象原样在场（同引用，主题侧不得抄第二份）', () => {
    for (const rule of KOJO_SUGAR_THEME_RULES) {
      expect(
        kojoDark.rules.includes(rule as unknown as Monaco.editor.ITokenThemeRule),
        `主题 rules 里没有 ${rule.token}（被复制了？）`,
      ).toBe(true);
    }
  });
});

/* ============================== 深底可读：对比度 + 两两色差 ============================== */

const BG = '1e1e1e'; // vs-dark 基底背景（theme inherit: true）

const srgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const [r, g, b] = srgb(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 2.x 对比度（前景 vs 深底） */
function contrast(fg: string): number {
  const l1 = luminance(BG);
  const l2 = luminance(fg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** sRGB → CIE Lab（D65） */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = srgb(hex).map((c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92) * 100) as [number, number, number];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 95.047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 100.0;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 108.883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIE76 ΔE（Lab 空间欧氏距离）——两档肉眼可分性的数值判据 */
function deltaE(a: string, b: string): number {
  const [l1, c1, h1] = lab(a);
  const [l2, c2, h2] = lab(b);
  return Math.hypot(l1 - l2, c1 - c2, h1 - h2);
}

describe('档位配色：一档一色 + 深底可读', () => {
  const foregroundOf = new Map<string, string>();
  for (const rule of KOJO_SUGAR_THEME_RULES) {
    expect(typeof rule.foreground).toBe('string');
    expect((rule.foreground ?? '').length, `rule ${rule.token}.foreground 不是 6 位 hex）`).toBe(6);
    foregroundOf.set(rule.token, rule.foreground ?? '');
  }

  /** 首档代表色：档位承诺"同档共享前景"，取第一 token 的前景即可代表档位色（另行同档校验） */
  const tierColor = (t: (typeof KOJO_TOKEN_TIERS)[number]): string => foregroundOf.get(t.tokens[0]!)!;

  it('每档内部同档同色（档位表承诺被事实背书）', () => {
    for (const t of KOJO_TOKEN_TIERS) {
      const fgs = t.tokens.map((tok) => (foregroundOf.has(tok) ? foregroundOf.get(tok) : undefined));
      expect(fgs.every((fg) => fg !== undefined), `档「${t.tier}」的 token ${t.tokens.join(' ')} 有未配色者（${fgs}）`).toBe(true);
      expect(new Set(fgs.map(String)).size, `档「${t.tier}」内部前景不止一色`).toBe(1);
    }
  });

  it('任意两档前景 hex 互不相同（一档一色的第一硬线）', () => {
    expect(foregroundOf.size).toBeGreaterThan(KOJO_TOKEN_TIERS.length - 1);
    for (let i = 0; i < KOJO_TOKEN_TIERS.length; i++) {
      for (let j = i + 1; j < KOJO_TOKEN_TIERS.length; j++) {
        const fi = tierColor(KOJO_TOKEN_TIERS[i]!);
        const fj = tierColor(KOJO_TOKEN_TIERS[j]!);
        expect(fi !== fj, `档「${KOJO_TOKEN_TIERS[i]!.tier}」与「${KOJO_TOKEN_TIERS[j]!.tier}」前景撞色：#${fi}`).toBe(true);
      }
    }
  });

  it('深底对比度 ≥ 4.46:1（既有档位最弱档 keyword.alias，基线读数 4.47）', () => {
    for (const t of KOJO_TOKEN_TIERS) {
      const fg = tierColor(t);
      expect(contrast(fg), `档「${t.tier}」#${fg} 对比度 ${contrast(fg).toFixed(2)}:1 < 4.46：不可读`).toBeGreaterThanOrEqual(4.46);
    }
  });

  it('任意两档前景 Lab 色差 ≥ 12（两档若肉眼不可分，分层就是假的；现读数 min = 12.6）', () => {
    for (let i = 0; i < KOJO_TOKEN_TIERS.length; i++) {
      for (let j = i + 1; j < KOJO_TOKEN_TIERS.length; j++) {
        const fi = tierColor(KOJO_TOKEN_TIERS[i]!);
        const fj = tierColor(KOJO_TOKEN_TIERS[j]!);
        const dE = deltaE(fi, fj);
        expect(
          dE,
          `档「${KOJO_TOKEN_TIERS[i]!.tier}」↔「${KOJO_TOKEN_TIERS[j]!.tier}」 #${fi} vs #${fj} ΔE=${dE.toFixed(1)} < 12`,
        ).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
