import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KOJO_LEGACY_SOURCE_EXTENSION,
  KOJO_SOURCE_EXTENSION,
  kojoMonacoExtensions,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from '../src/monaco/kojo-language';
import { installAvailabilityGate } from '../src/monaco/language-registry';
import { languageFor } from '../src/ui/editor-model-pool';

/**
 * 分层守卫（DRIFT-APP 3，2026-10-19）：**扩展名清单与取词字符集只许住在契约层**，
 * app 侧只许"取"，不许再"抄"。
 *
 * 三条判据漂移的成因一模一样——契约层早就有一份真源，app 里各抄了一份小的：
 * ① 差异视图自己写方言尾正则（少一整个正文扩展名）；② 悬停自己写 ASCII 标识符字符集
 * （中文函数名整路静默）；③ `.kojo` 注册只写小写形态（ERB 侧却是"原样 + 全大写"派生）。
 * 前两处修完如果只留单测，下一次照样能再抄一份——所以这个文件守的是**边界本身**，
 * 手法照 `search-scope.layering.test.ts`：**连注释行一起查**（本仓 `audit:decoupling`
 * 的 A 项只查代码行，而"注释里先写一句判据思路"正是抄判据进宿主的第一站）。
 *
 * 反向对照同样钉住（第 ④ 组）：判据不是"哪里都不许有"，而是**只准住在提供方**。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 本批收口的三个文件：判据的消费方，一字都不该自己写 */
const CONSUMER_FILES = [
  'packages/app/src/ui/diff-view.ts',
  'packages/app/src/monaco/kojo-hover.ts',
  'packages/app/src/monaco/kojo-language.ts',
];

const read = (rel: string): string[] => readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);

/**
 * 本文件守的是**扩展名清单的单一真源**，不是语言可用性门（LAU-3 的另一条轴）。
 * 缺省档 `2.0-default` 把封存层挡在门外 ⇒ `languageFor('.kojo')` 答 `plaintext`，
 * 与"注册表认不认得这个形态"无关。装一枚恒真假门，把门那一轴摘出去。
 */
beforeEach(() => installAvailabilityGate(() => true));
afterEach(() => installAvailabilityGate(null));

/* ─────────────────────────── 禁止形态（连注释一起查） ─────────────────────────── */

/**
 * 手抄的扩展名**字面量**：引号包住的裸点扩展（`'.erb'` 这类形态）。
 * 只认半角引号——反引号里的散文（`` `.erb` `` 是行文中提到某个文件形态）不算抄判据，
 * 真源清单一旦进代码必然带引号。
 */
const QUOTED_EXT_LITERAL = /["']\.[A-Za-z]{2,5}["']/;

/**
 * 手抄的**扩展名尾正则**：正则字面量里出现 `\.` + 方言/糖扩展名（`\.(erb|erh)$`、
 * `\.kojo$` 这类"整条路径尾巴"判据）。Monarch 词法里 `/^\s*```\s*erb\b/` 那种量的是
 * **围栏关键字**、体内没有 `\.`，不会被算进来。
 */
const EXT_TAIL_REGEX = /\/[^/\n]*\\\.[^/\n]*\b(?:erb|erh|erm|kojo)\b[^/\n]*\/[a-z]*/i;

/** 手抄的 **ASCII 标识符字符集**（悬停那一路的旧尺子）；唯一豁免见下 */
const ASCII_IDENT_CLASS = /\[A-Za-z0-9_\]/;

/**
 * ASCII 标识符字符集的**唯一合法残存处**（钉死到行、钉死处数，一处不多一处不少）：
 * - `kojo-hover.ts` 的 `REF_RE`：变量引用 `族名:段` 那条路判的是**引擎原生族名**的形状
 *   （与契约 `symbolTokenAt` 的缺省集同口径），简报明令不跟着放宽；
 * - `kojo-language.ts` 的 Monarch 产生式：词法的 ASCII 标识符支路（给 `notin` / 全大写
 *   指令分档用），中文名字另有 `@default` 名字档——那是**语法产生式**不是取词判据，
 *   放宽它等于改配色分层，不属本批。
 * 两处都必须"就地写明形状"才通过，把字符集搬到别处（哪怕是注释）都算新增。
 */
const ASCII_IDENT_CLASS_EXEMPTIONS: ReadonlyArray<{ readonly file: string; readonly line: RegExp; readonly count: number; readonly why: string }> = [
  { file: 'packages/app/src/monaco/kojo-hover.ts', line: /^const REF_RE\b/, count: 1, why: '变量引用族名形状（本批明令不一起换）' },
  { file: 'packages/app/src/monaco/kojo-language.ts', line: /^\s*\/\[A-Za-z_\]\[A-Za-z0-9_\]\*\/,/u, count: 1, why: 'Monarch ASCII 产生式，非取词判据' },
];

describe('① 消费方一字不抄（连注释行一起查）', () => {
  it.each(CONSUMER_FILES)('无手抄的扩展名字面量：%s', (rel) => {
    const hits = read(rel)
      .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
      .filter(({ line }) => QUOTED_EXT_LITERAL.test(line))
      .map(({ at, line }) => `${at} ${line.trim().slice(0, 90)}`);
    expect(hits).toEqual([]);
  });

  it.each(CONSUMER_FILES)('无手抄的扩展名尾正则：%s', (rel) => {
    const hits = read(rel)
      .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
      .filter(({ line }) => EXT_TAIL_REGEX.test(line))
      .map(({ at, line }) => `${at} ${line.trim().slice(0, 90)}`);
    expect(hits).toEqual([]);
  });

  it('无手抄的 ASCII 标识符字符集（豁免表钉到行 + 处数；多一处少一处都红）', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMER_FILES) {
      read(rel).forEach((line, i) => {
        if (!ASCII_IDENT_CLASS.test(line)) return;
        const ok = ASCII_IDENT_CLASS_EXEMPTIONS.some((e) => e.file === rel && e.line.test(line));
        if (!ok) offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 90)}`);
      });
    }
    expect(offenders).toEqual([]);
    for (const e of ASCII_IDENT_CLASS_EXEMPTIONS) {
      const n = read(e.file).filter((line) => ASCII_IDENT_CLASS.test(line) && e.line.test(line)).length;
      expect(n, `${e.file} 的豁免处数（${e.why}）`).toBe(e.count);
    }
  });

  it('取词的两把尺子都指回契约（import 面 + 调用面一起钉）', () => {
    const text = read('packages/app/src/monaco/kojo-hover.ts').join('\n');
    expect(text).toMatch(/import \{[^}]*\bsymbolTokenAt\b[^}]*\bunicodeTokenAt\b[^}]*\} from '@kojo\/plugin-api'/);
    // 旧的那把自写尺子不许以任何形态复活
    expect(text).not.toMatch(/isIdentChar/);
    expect(text).toMatch(/unicodeTokenAt\(lineText, column\)/);
    expect(text).toMatch(/symbolTokenAt\(lineText, col0 \+ 1\)/);
  });

  it('差异视图不另立语言判据（复用编辑器那份单源，且不再自己 import 语言 id 常量）', () => {
    const text = read('packages/app/src/ui/diff-view.ts').join('\n');
    expect(text).toMatch(/import \{ languageFor \} from '\.\/editor-model-pool'/);
    expect(text).toMatch(/languageIdForSide[\s\S]{0,120}languageFor\(/);
    expect(text).not.toMatch(/ERB_LANGUAGE_ID|KOJO_LANGUAGE_ID/);
  });

  it('`.kojo` 注册处调的是契约派生函数（不是任何形态的手抄清单）', () => {
    const text = read('packages/app/src/monaco/kojo-language.ts').join('\n');
    expect(text).toMatch(/import \{ kojoMonacoExtensions \} from '@kojo\/plugin-api'/);
    expect(text).toMatch(/extensions: kojoMonacoExtensions\(\)/);
  });
});

/* ─────────────────────────── ② 全仓守门：大小写清单只有一份 ─────────────────────────── */

/** app 源码全量（守卫自己住在 `tests/`，扫 `src/` 天然不含它） */
function appSourceFiles(dir = 'packages/app/src'): string[] {
  const walk = (rel: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(child));
      else if (/\.tsx?$/.test(e.name)) out.push(child);
    }
    return out;
  };
  return walk(dir);
}

/** 手写的**全大写形态**扩展名字面量——大小写清单被抄进 app 的唯一可疑形状 */
const UPPERCASE_EXT_LITERAL = /["']\.[A-Z]{2,5}["']/;
/** 小写形态的扩展名字面量（用来钉住"既有抄本不许增长"；LAU-3b 起 `.kojo1` 同一口径） */
const KOJO_EXT_LITERAL = /["']\.kojo1?["']/;

describe('② 全仓守门：`.kojo` 的大小写清单只由契约那一份派生函数产生', () => {
  it('packages/app/src 里出现全大写扩展名字面量的文件数 = 0', () => {
    const hits = appSourceFiles().filter((rel) => UPPERCASE_EXT_LITERAL.test(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('app 侧手写的 `.kojo` 字面量 = 0 处（DRIFT-APP 立闸时先钉三处既有抄本，本批收干净后压到零；新增一处即红）', () => {
    const withLiteral = appSourceFiles()
      .filter((rel) => KOJO_EXT_LITERAL.test(readFileSync(path.join(ROOT, rel), 'utf8')))
      .sort();
    expect(withLiteral).toEqual([]);
  });

  it('两处注册面同形态：ERB 与 kojo 都调契约派生函数，没有一处自己列大小写', () => {
    const erb = read('packages/app/src/monaco/erb-language.ts').join('\n');
    const kojo = read('packages/app/src/monaco/kojo-language.ts').join('\n');
    expect(erb).toMatch(/extensions: erbMonacoExtensions\(\)/);
    expect(kojo).toMatch(/extensions: kojoMonacoExtensions\(\)/);
    expect(erb).not.toMatch(/extensions: \[/);
    expect(kojo).not.toMatch(/extensions: \[/);
  });
});

/* ─────────────────── ②b `.kojo2` 单源：字面量只准住零依赖叶子（K2-CUTOVER-THEME） ─────────────────── */

/**
 * `.kojo2` 是 2.0 的暂挂扩展名。K2-CUTOVER-THEME 之前它有两份：`kojo2-language.ts` 的定义处
 * 与 `ui/kojo2-cutover.ts` 的抄本（后者刻意不 import monaco 语言面，因为那条链拖着糖词表）。
 * 那时字面源下沉到零 import 叶子 `monaco/kojo2-constants.ts`：语言面只 re-export，
 * 路由层直接 import——全仓只此一处可改，抄本归零。
 *
 * **B1（2026-10-24）起这个叶子搬进语言面库**（`@kojo/kojo-lang` 的 `constants.ts`）：
 * 判据与"语言 id 归语言面所有"同源，且它必须与 `kojo2-declarations` 在同一个包里，
 * 否则语言面库要反过来 import 宿主。不变量一个字没变，只是**地址变了**：
 * 现在 app/src 里一处都不许有，唯一那处在包内。
 */
const KOJO2_EXT_LITERAL = /["']\.kojo2["']/;
const KOJO2_CONSTANTS_FILE = 'packages/kojo-lang/src/constants.ts';

describe('②b `.kojo2` 字面量单源：路由层与语言面都从语言面库取', () => {
  it('app/src 里带引号的 `.kojo2` 字面量一处都没有（B1 后整枚下沉到 @kojo/kojo-lang）', () => {
    const hits = appSourceFiles()
      .filter((rel) => KOJO2_EXT_LITERAL.test(readFileSync(path.join(ROOT, rel), 'utf8')))
      .sort();
    expect(hits).toEqual([]);
  });

  it('全仓唯一那处就在语言面库的零依赖叶子里（地址换了，独一性没换）', () => {
    const text = readFileSync(path.join(ROOT, KOJO2_CONSTANTS_FILE), 'utf8');
    expect(text).toMatch(KOJO2_EXT_LITERAL);
    // 叶子必须真的零 import：它被路由层（零 Monaco）与语言面同时引用，
    // 一旦它开始 import 东西，那条链就会重新长回开机图里。
    expect(text).not.toMatch(/^\s*import\s/m);
  });

  it('路由层不再自持字面量，派生自语言面库的常量', () => {
    const text = read('packages/app/src/ui/kojo2-cutover.ts').join('\n');
    expect(text).toMatch(/import \{ KOJO2_SOURCE_EXTENSION \} from '@kojo\/kojo-lang\/constants'/);
    expect(text).toMatch(/export const KOJO2_FILE_EXTENSION: string = KOJO2_SOURCE_EXTENSION;/);
    expect(text).not.toMatch(KOJO2_EXT_LITERAL);
  });

  it('语言面把 id / 扩展名从语言面库 re-export（不复制第二份）', () => {
    const text = read('packages/app/src/monaco/kojo2-language.ts').join('\n');
    expect(text).toMatch(
      /import \{ KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION \} from '@kojo\/kojo-lang\/constants'/,
    );
    expect(text).toMatch(/export \{ KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION \};/);
    expect(text).not.toMatch(KOJO2_EXT_LITERAL);
    expect(text).not.toMatch(/export const KOJO2_SOURCE_EXTENSION/);
  });
});

/* ─────────────────────────── ③ 行为面：登记的就是契约那份派生物 ─────────────────────────── */

interface Register {
  readonly id: string;
  readonly extensions: string[];
  readonly aliases: string[];
}

/** 只留注册表要用的方法；断言"登记了什么"，不碰真 Monaco（形态照 `erh-open-surface.test.ts`） */
function mockMonaco() {
  const registered: Register[] = [];
  const monaco = {
    languages: {
      getLanguages: () => registered.map((r) => ({ id: r.id })),
      register: (d: Register) => registered.push(d),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      IndentAction: { Indent: 1, None: 0 },
    },
    editor: { defineTheme: vi.fn() },
  };
  return { registered, monaco: monaco as unknown as Parameters<typeof registerKojoLanguage>[0] };
}

describe('③ 行为面：`.kojo` 注册覆盖大小写两形态，且与选语言判据对拍', () => {
  it('登记的 extensions == 契约派生物 == 原样 + 全大写', () => {
    const { registered, monaco } = mockMonaco();
    registerKojoLanguage(monaco);
    expect(registered).toHaveLength(1);
    const { extensions } = registered[0]!;
    expect(extensions).toEqual(kojoMonacoExtensions());
    expect(extensions).toContain(KOJO_SOURCE_EXTENSION);
    expect(extensions).toContain(KOJO_SOURCE_EXTENSION.toUpperCase());
  });

  it('派生物形态：清单进、成对大小写出——契约清单加一项，注册处零改动就跟上新形态', () => {
    expect(kojoMonacoExtensions()).toEqual([
      KOJO_SOURCE_EXTENSION,
      KOJO_SOURCE_EXTENSION.toUpperCase(),
      KOJO_LEGACY_SOURCE_EXTENSION,
      KOJO_LEGACY_SOURCE_EXTENSION.toUpperCase(),
    ]);
    // 同形态函数的通用性（与 `erbMonacoExtensions` 一样收清单入参）：派生规则只此一份
    expect(kojoMonacoExtensions(['.aaa', '.bbbb'])).toEqual(['.aaa', '.AAA', '.bbbb', '.BBBB']);
    const { registered, monaco } = mockMonaco();
    registerKojoLanguage(monaco);
    expect(registered[0]!.extensions).toEqual(kojoMonacoExtensions());
  });

  it('对拍：注册表认得的每个形态，编辑器选语言也认得（两不许各说各话）', () => {
    const { registered, monaco } = mockMonaco();
    registerKojoLanguage(monaco);
    for (const ext of registered[0]!.extensions) {
      expect(languageFor(`D:\\作者工作区\\事件${ext}`), `注册表形态 ${ext}`).toBe(KOJO_LANGUAGE_ID);
    }
    // 反向：方言的大小写两形态在两侧也都是 ERB（ERB 侧与 kojo 侧同一套派生）
    const erb = mockMonaco();
    registerErbLanguage(erb.monaco as unknown as Parameters<typeof registerErbLanguage>[0]);
    for (const ext of erb.registered[0]!.extensions) {
      expect(languageFor(`C:\\game\\ERB\\口上\\文件${ext}`), `方言形态 ${ext}`).toBe(ERB_LANGUAGE_ID);
    }
  });

  it('重复注册幂等（守卫没把早退那行改掉）', () => {
    const { registered, monaco } = mockMonaco();
    registerKojoLanguage(monaco);
    registerKojoLanguage(monaco);
    expect(registered).toHaveLength(1);
  });
});

/* ─────────────────────────── ④ 反向对照：判据确实住在提供方 ─────────────────────────── */

describe('④ 反向对照：清单与字符集确实住在契约层', () => {
  it('提供方两份清单都在（不是"哪儿都不许有"）', () => {
    const sugar = read('packages/plugin-api/src/sugar.ts').join('\n');
    expect(sugar).toMatch(/export const KOJO_SOURCE_EXTENSION = '\.kojo'/);
    expect(sugar).toMatch(/export function kojoMonacoExtensions/);
    const erbExt = read('packages/plugin-api/src/erb-ext.ts').join('\n');
    expect(erbExt).toContain("'.erb'");
    expect(erbExt).toContain("'.erm'");
    expect(erbExt).toContain("'.erh'");
    expect(erbExt).toMatch(/export function erbMonacoExtensions/);
    const locate = read('packages/plugin-api/src/semantic-locate.ts').join('\n');
    expect(locate).toMatch(/export const MODEL_TOKEN_CLASS = String\.raw`\[\\p\{L\}\\p\{N\}_\]`/);
  });

  it('契约导出面把派生函数放出去了（app 侧才取得到）', () => {
    const idx = read('packages/plugin-api/src/index.ts').join('\n');
    expect(idx).toMatch(/kojoMonacoExtensions,/);
    expect(idx).toMatch(/KOJO_SOURCE_EXTENSION,/);
    expect(typeof kojoMonacoExtensions()).toBe('object');
  });
});

/* ─────────────────────────── ⑤ F12 两条腿共用同一枚取词函数（F12-TOKEN 2026-10-19） ─────────────────────────── */

/**
 * 本批收的是"悬停查得到、F12 跳不动"那个口的**防回潮**：判据只准住在
 * `erb-parser/references.ts::functionNameTokenAt` 一处，两条腿（转到定义 / 查找引用）
 * 各自 import 它——任何一方退回契约 ASCII 尺、或自己再写一次取词，都是第二份真相。
 * 手法与本文件其余各项一致：查**源码形态**，不只查行为（行为面在
 * `erb-parser/tests/f12-cjk-token.test.ts` 与 `f12-cjk.corpus.test.ts`）。
 */
describe('⑤ F12 取词判据只有一处（两条腿不许各写各的）', () => {
  it('erb-parser 那枚唯一取词函数在，且尺子指回契约（不自己写字符集）', () => {
    const refs = read('packages/plugins/erb-parser/src/references.ts').join('\n');
    expect(refs).toMatch(/export function functionNameTokenAt\(\s*lineText: string,\s*column: number,?\s*\)/);
    expect(refs).toMatch(/unicodeTokenAt\(lineText, Math\.trunc\(column\)\)/);
    expect(refs).toMatch(/if \(colonAdjacent\(lineText, token\.startColumn - 1, token\.endColumn - 1\)\) return undefined;/);
    // 冒号判据也只此一枚（三处消费：反向索引 / 未定义 CALL / 光标取词）
    expect(refs.match(/colonAdjacent\(/g)?.length).toBeGreaterThanOrEqual(4);
    // 第二份字符集不许在本模块出现：`MODEL_TOKEN_CLASS` 是唯一字面源 ⇒ 本模块不该再写 `\p{L}`
    expect(refs).not.toContain('\\p{L}');
  });

  it('两条腿都调那一枚函数，且都不再碰 ASCII 尺', () => {
    for (const rel of ['packages/plugins/erb-parser/src/symbols.ts', 'packages/plugins/erb-parser/src/references.ts']) {
      const text = read(rel).join('\n');
      expect(text, rel).toMatch(/functionNameTokenAt\(lineText, (Math\.trunc\(column\)|column)\)/);
      expect(text, rel).not.toMatch(/\bsymbolTokenAt\(/);
    }
  });

  it('契约的 ASCII 缺省照旧窄（它服务原生名反查表，本批没跟着放宽）', () => {
    const token = read('packages/plugin-api/src/symbol-token.ts').join('\n');
    expect(token).toMatch(/const DEFAULT_IS_CHAR = \(ch: string\): boolean => \/\[A-Za-z0-9_\]\/\.test\(ch\);/);
    // 宿主反查那一路仍旧用这把 ASCII 尺（放宽它就会让库表回显抢掉函数索引的正文），
    // 而且**不许**长成 Unicode 尺——把 172 行换成 `unicodeTokenAt` 时下面两条一起红。
    const hover = read('packages/app/src/monaco/kojo-hover.ts').join('\n');
    expect(hover).toMatch(/const fnToken = symbolTokenAt\(lineText, col0 \+ 1\);/);
    expect(hover).not.toMatch(/const fnToken = unicodeTokenAt/);
    expect(hover).toMatch(/!echoYieldsToIndex\(cn, fnToken\.text, tables\)/);
  });
});
