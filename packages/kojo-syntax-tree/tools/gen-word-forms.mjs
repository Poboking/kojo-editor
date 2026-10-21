#!/usr/bin/env node
/**
 * gen-word-forms.mjs —— 词表构建期投影：把 `kojo-sugar` 的活词表灌进 `src/word-forms.json`，
 * 供 `grammar.js` require（tree-sitter CLI 用裸 node 读 grammar，故产物必须是 JSON）。
 *
 * 真源（**只读，绝不回写**）：
 * - `packages/plugins/kojo-sugar/src/keywords.ts` 的 `SUGAR_LEXICON_WORDS` /
 *   `HEAD_DECL_KEYS` / `primaryWord()` / `blockEndWord()`（聚合入口 `sugarEditorLexicon()`
 *   同一批内表，此处按语义 id 需要直读导出表）与 `DIM_DIRECTIVE_RE`；
 * - `packages/plugins/kojo-sugar/src/statement-functions.ts` 的 `STATEMENT_FUNCTIONS` 键集；
 * - `packages/plugins/kojo-sugar/src/lexer.ts` 的**整行严格等值判据**（`if (content === 'X')
 *   return { kind: 'k' }` 支，当前 = `[SKIPSTART]` / `[SKIPEND]`）。这一支不是"词形"、是记号，
 *   词表投影覆盖不到它；不投影的代价就是本批实测的 18 行真冲突（上游加了判据、语法层没跟上），
 *   故连它也从真源取，不许 grammar.js 自留第二份。lexer.ts 有依赖、不能像两份叶子模块那样
 *   `import()`，所以走**源码文本抽取**：抽不到一支就抛（fail-closed），绝不静默产出缺判据的投影。
 * - 同一份 `lexer.ts` 里的**引擎记号名单常量**（`const <NAME>: ReadonlySet<string> = new Set([...])`）
 *   与 `packages/plugins/kojo-sugar/src/sugar-ident.ts`（名单成员的出处）。TRY 系写形
 *   `试探 原形 <记号> <原文>` 的界标既不是词也不是正则、是**一张九枚名单**（`inline.engineEcho`
 *   `原形` 之后只放行 TRY_CATCH_OPEN ∪ TRY_LIST_OPEN）——语法层只抄名单就等于把第一真源的
 *   判据换成第二份，故名单按"从 lexer.ts 抽成员集合名 → 到 sugar-ident.ts 取值"两段派生，
 *   上游加一枚记号 / 加一张成员集合 ⇒ 重跑本包 build 自动跟进。
 *
 * tree-sitter 记号正则没有 `/i` 与 `^`/`$` 锚（记号天生停在匹配处）⇒ 上游那枚带 `/i` 的正则
 * 必须**编译**成等价记号正则（逐字母 `[xX]`）才能进投影。编译只在此处做一次，grammar.js 只嵌入。
 *
 * 机制口径：真源是**零依赖叶子 TS 模块**，Node ≥23.6（本仓 24.x）原生类型擦除即可
 * `import()`——与 app 侧 `kojo-lexicon-single-source.test.ts` 同一「直读真源、零手抄」纪律，
 * 不另造第二份词表。上游随时登记新中文主形/别名 ⇒ 只需 `pnpm --filter @kojo/kojo-syntax-tree build`
 * （build 链第一步就是本脚本）；忘了重生成由 `tests/word-forms-single-source.test.ts` 判红。
 *
 * 产物**确定性**：id 键、词形列表、语句词表一律按 UTF-16 码元升序（`sort()` 默认序，
 * 不依赖 locale）；正则择一分支由 DFA 最长匹配裁决、分支书写序不影响行为。
 *
 * 用法（仓库根或本包目录均可）：node packages/kojo-syntax-tree/tools/gen-word-forms.mjs [--check]
 *   --check：只比对既有产物是否与重新生成的一致（不一致退 1，供 CI 用）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 裸 Node（类型擦除档）不做**无扩展名**的 TS 解析，而真源叶子之间允许互相 import
 * （如 `sugar-ident.ts` → `./blank-charset`，CHARSET-SS 之后不再是单文件根）。
 * 按 bundler 口径补一条相对路径 → `.ts` 的兜底；解析不到仍照常抛（fail-closed），
 * 绝不静默产出缺席判据的投影。
 *
 * vitest 下必须跳过：vmThreads 池把 `node:module` 的 `registerHooks` 换成抛错桩
 * （`"registerHooks" is not available when running in Vitest`），而测试进程里
 * vite 自带解析器本就能吃 `.ts`，这条兜底纯属多余。判据用「本脚本是否为 node 入口」
 * 而不是 `VITEST` 环境变量——测试里 `execFileSync` 起的裸 node 子进程会**继承** `VITEST`，
 * 但它作为入口跑本工具时同样需要 hooks。不跳过则 `word-forms-single-source.test.ts`
 * 在 import 期整文件红（本机 vmThreads 全量恒红一条的既有环境账）。
 */
const invokedAsMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsMain) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (
          !/\.[cm]?[jt]sx?$/.test(specifier) &&
          !specifier.endsWith('/') &&
          (specifier.startsWith('./') || specifier.startsWith('../'))
        ) {
          try {
            return nextResolve(`${specifier}.ts`, context);
          } catch {
            throw err;
          }
        }
        throw err;
      }
    },
  });
}

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tools
const pkgRoot = resolve(here, '..'); // packages/kojo-syntax-tree
const OUT = join(pkgRoot, 'src', 'word-forms.json');

/** 有收束词的三族（开块 id → 收束 id）；顺序即 stable 输出序。 */
const END_FAMILIES = [
  ['block.loop', 'block.loopEnd'],
  ['block.catch', 'block.catchEnd'],
  ['block.dataTable', 'block.dataTableEnd'],
];

/** `classifyLine` 的整行严格等值支：`if (content === 'X') return { kind: 'k' }`。 */
const EXACT_LINE_MARKER_RE =
  /if\s*\(content === '([^']+)'\)\s*return\s*\{\s*kind:\s*'([A-Za-z][A-Za-z0-9]*)'\s*\}/g;

/**
 * `lexer.ts` 里的引擎记号名单常量：`const <NAME>: ReadonlySet<string> = new Set([...A, ...B])`。
 * 只抽"成员由若干具名集合摊平而来"这一形（TRY 系九枚正是）；写成字面量数组的名单本投影不收
 * ——那等于允许一份手抄名单悄悄进投影。
 */
const ENGINE_TOKEN_SET_RE =
  /const\s+([A-Z0-9_]+)\s*:\s*ReadonlySet<string>\s*=\s*new Set\(\[\s*((?:\.\.\.[A-Za-z_][A-Za-z0-9_]*\s*,?\s*)+)\]\)/g;

/**
 * 词表之外、以**引擎记号名单**为界标的写形族（真源指针表：语义 id ⇄ `lexer.ts` 里的名单常量名）。
 * 这一格只登记"哪枚词形由哪张名单把关"，**不登记名单内容**——内容一律从真源派生。
 */
const MARKER_STATEMENT_TOKEN_SETS = [{ id: 'inline.tryStatement', constName: 'TRY_ECHO_TOKENS' }];

/**
 * 上游 `RegExp` → tree-sitter 记号正则（构建期编译，一次性）。
 * 只支持 `i` 标志（折成逐字母 `[xX]`）；`^` 由"记号天生锚在起点"承担、直接剥；
 * 出现 `$` 锚或字符类就**抛**——这两种写法本投影不承诺编译，静默产出一枚错正则比红一条构建更坏。
 */
export function toTokenPattern(re, ctx) {
  for (const flag of re.flags) {
    if (flag !== 'i') throw new Error(`${ctx}: tree-sitter 记号不支持标志 /${flag}`);
  }
  let src = re.source;
  if (src.startsWith('^')) src = src.slice(1); // 记号天生从当前位置起匹配 ⇒ 行首锚是冗余写法
  const fold = re.flags.includes('i');
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[++i];
      if (next === undefined) throw new Error(`${ctx}: 正则以裸反斜杠结尾`);
      out += `\\${next}`; // 转义序列（\s \S \d …）是字符类、不是字面量 ⇒ 原样带走
      continue;
    }
    // 行尾锚编译不了：记号只会停在匹配处、不会拒绝后续正文，留着 `$` 等于静默放宽判据。
    if (ch === '$') throw new Error(`${ctx}: 行尾锚 $ 无法编译成记号（要整行等值请走 exactMarkers 那一支）`);
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (inClass) throw new Error(`${ctx}: 字符类里的大小写折叠本投影不做，请在此补编译规则`);
    if (fold && /[A-Za-z]/.test(ch)) out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    else out += ch;
  }
  return out;
}

/** 从 `classifyLine` 源码抽**全部**整行等值判据；一支都没抽到 = 上游改写法了 ⇒ 抛，不放行。 */
export function extractExactLineMarkers(lexerSource) {
  const found = [...lexerSource.matchAll(EXACT_LINE_MARKER_RE)].map((m) => ({ kind: m[2], marker: m[1] }));
  if (found.length === 0) {
    throw new Error("lexer.ts 里抽不到任何 `if (content === '…') return { kind: '…' }` 支——判据改写了吗？");
  }
  const dup = found.filter((f, i) => found.findIndex((x) => x.kind === f.kind) !== i);
  if (dup.length > 0) throw new Error(`整行等值判据的 kind 重复：${dup.map((d) => d.kind).join(', ')}`);
  return found.sort((a, b) => cmpStr(a.kind, b.kind));
}

/**
 * 引擎记号名单派生：`lexer.ts` 里那张 `const <NAME>: ReadonlySet<string> = new Set([...A, ...B])`
 * 只给出**成员集合的名字**，名字的值一律到 `sugar-ident.ts`（识别核，名单的唯一出处）去取。
 * 三段任缺一段就抛：抽不到常量 ⇒ 上游改写法；成员表达式不是 `...NAME` ⇒ 换成了别的形式（不收）；
 * 名字在 sugar-ident.ts 里查不到或不是字符串集合 ⇒ 指针漂了。静默产出缺记号的投影 = 下一批
 * 语法层只能手添字面量，那才是本包设计要堵死的东西。
 */
export function extractEngineTokenSet(constName, lexerSource, identModule) {
  const hit = [...lexerSource.matchAll(ENGINE_TOKEN_SET_RE)].find((m) => m[1] === constName);
  if (!hit) {
    throw new Error(
      `lexer.ts 里抽不到 \`const ${constName}: ReadonlySet<string> = new Set([...A, ...B])\`——判据改写了吗？`,
    );
  }
  const memberNames = [...hit[2].matchAll(/\.\.\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  if (memberNames.length === 0) throw new Error(`${constName}: 成员表达式里没有任何 \`...NAME\` 摊平，本投影不收`);
  const tokens = new Set();
  for (const name of memberNames) {
    const member = identModule[name];
    if (!(member instanceof Set)) {
      throw new Error(`${constName} 的成员集合 ${name} 在 sugar-ident.ts 里不是 Set（指针漂了）`);
    }
    for (const token of member) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(`${name} 里出现空 / 非字符串记号，本投影不收`);
      }
      tokens.add(token);
    }
  }
  if (tokens.size === 0) throw new Error(`${constName} 派生出的记号名单为空`);
  return [...tokens].sort(cmpStr);
}

/** 读两份零依赖真源模块 + sugar-ident.ts（引擎记号名单成员）+ lexer.ts 源码文本（整行等值判据的唯一出处）。 */
export async function loadTruth() {
  const kwUrl = pathToFileURL(
    resolve(pkgRoot, '..', 'plugins', 'kojo-sugar', 'src', 'keywords.ts'),
  ).href;
  const sfUrl = pathToFileURL(
    resolve(pkgRoot, '..', 'plugins', 'kojo-sugar', 'src', 'statement-functions.ts'),
  ).href;
  const identUrl = pathToFileURL(
    resolve(pkgRoot, '..', 'plugins', 'kojo-sugar', 'src', 'sugar-ident.ts'),
  ).href;
  const lexerPath = resolve(pkgRoot, '..', 'plugins', 'kojo-sugar', 'src', 'lexer.ts');
  const kw = await import(kwUrl);
  const sf = await import(sfUrl);
  const ident = await import(identUrl);
  return {
    words: kw.SUGAR_LEXICON_WORDS,
    headDeclIds: kw.HEAD_DECL_KEYS,
    primaryWord: kw.primaryWord,
    blockEndWord: kw.blockEndWord,
    statementFunctions: sf.STATEMENT_FUNCTIONS,
    dimDirectiveRe: kw.DIM_DIRECTIVE_RE,
    lexerSource: readFileSync(lexerPath, 'utf8'),
    identModule: ident,
  };
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 纯投影：真源聚合 → word-forms 数据对象（测试可用**增广词表**做漂移/变异校验）。
 * @param {{words: readonly {word:string;id:string;primary:boolean}[], headDeclIds: readonly string[], primaryWord: (id:string)=>string, blockEndWord: (id:string)=>string, statementFunctions: Map<string,string>, dimDirectiveRe: RegExp, lexerSource: string, identModule: Record<string, unknown>}} truth
 */
export function buildWordForms(truth) {
  /** id → 全部词形（中文主形 + 英文别名），码元升序。 */
  const wordsById = {};
  /** id → 中文主形（`primary: true` 那枚；keywords.ts 的 PRIMARY_BY_ID 同一口径）。 */
  const primaryById = {};
  for (const w of truth.words) {
    (wordsById[w.id] ??= []).push(w.word);
    if (w.primary && !(w.id in primaryById)) primaryById[w.id] = w.word;
  }
  for (const id of Object.keys(wordsById)) wordsById[id].sort(cmpStr);

  // 收束词恒等式（keywords.ts 的 BLOCK_END_SUFFIX 派生 vs 表内登记的收束 id）——
  // 上游改后缀而忘登记收束词形 ⇒ 这里立刻抛错（fail-closed），绝不静默产半截词表。
  const endWordOfId = {};
  for (const [openId, endId] of END_FAMILIES) {
    const derived = truth.blockEndWord(openId);
    const registered = primaryById[endId];
    if (registered === undefined) {
      throw new Error(`真源缺收束词形登记：${endId}（应由 blockEndWord('${openId}') = '${derived}'）`);
    }
    if (derived !== registered) {
      throw new Error(`收束词形漂移：blockEndWord('${openId}')='${derived}' ≠ 表内 '${registered}'`);
    }
    endWordOfId[openId] = derived;
  }

  const rawLineRules = buildRawLineRules(truth);
  const engineTokenSets = buildEngineTokenSets(truth, primaryById);

  return {
    schema: 1,
    note: '生成文件，禁手改——由 packages/kojo-syntax-tree/tools/gen-word-forms.mjs 从 kojo-sugar 词表真源投影；重生成走本包 build 链。',
    sources: [
      'packages/plugins/kojo-sugar/src/keywords.ts',
      'packages/plugins/kojo-sugar/src/statement-functions.ts',
      'packages/plugins/kojo-sugar/src/lexer.ts',
      'packages/plugins/kojo-sugar/src/sugar-ident.ts',
    ],
    wordsById,
    primaryById,
    endWordOfId,
    headDeclIds: [...truth.headDeclIds],
    statementWords: [...truth.statementFunctions.keys()].sort(cmpStr),
    rawLineRules,
    engineTokenSets,
  };
}

/**
 * 写形的**引擎记号界标**（语义 id → 该写形只放行的那批记号，升序）。
 * 词表只覆盖"词"；`试探 原形 <记号>` 里 `原形` 之后那一段是名单不是词，名单住识别核，
 * 语法层要它就在这里取，取不到就抛——绝不让 grammar.js 自留第二份。
 */
export function buildEngineTokenSets(truth, primaryById) {
  const out = {};
  for (const { id, constName } of MARKER_STATEMENT_TOKEN_SETS) {
    if (!(id in primaryById)) {
      throw new Error(`写形界标登记了词表没有的 id：${id}（先回 kojo-sugar 登记词形，再来投影）`);
    }
    out[id] = extractEngineTokenSet(constName, truth.lexerSource, truth.identModule);
  }
  return out;
}

/**
 * `classifyLine` 里**不属于中文/英文词表**的那三支行首判据（`#DIM` 族预处理 + 整行严格等值标记）。
 * 词表投影只覆盖"词"，这三支是正则与记号；grammar.js 要的正是它们（本批 18 行真冲突的债主）。
 */
export function buildRawLineRules(truth) {
  const re = truth.dimDirectiveRe;
  if (!(re instanceof RegExp)) throw new Error('真源缺 DIM_DIRECTIVE_RE（keywords.ts 的 #DIM 族判据）');
  return {
    dimDirective: {
      source: re.source,
      ignoreCase: re.flags.includes('i'),
      pattern: toTokenPattern(re, 'DIM_DIRECTIVE_RE'),
    },
    exactMarkers: extractExactLineMarkers(truth.lexerSource),
  };
}

/** 稳定序列化（键序 = 构造序；列表已升序 ⇒ 字节可复现）。 */
export function serializeWordForms(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const truth = await loadTruth();
  const text = serializeWordForms(buildWordForms(truth));
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== text) {
      console.error('word-forms.json 与真源投影不一致——请重跑 gen-word-forms.mjs');
      process.exit(1);
    }
    console.log('word-forms.json 与真源一致（--check 通过）');
  } else {
    writeFileSync(OUT, text, 'utf8');
    const made = JSON.parse(text);
    console.log(
      `已生成 src/word-forms.json（语义 id ${Object.keys(made.wordsById).length} 个，` +
        `语句词 ${made.statementWords.length} 枚，整行等值标记 ${made.rawLineRules.exactMarkers.length} 枚，` +
        `记号界标 ${Object.keys(made.engineTokenSets).length} 族 ` +
        `${Object.entries(made.engineTokenSets).map(([id, v]) => `${id}=${v.length}`).join(' ')}` +
        `）`,
    );
  }
}
