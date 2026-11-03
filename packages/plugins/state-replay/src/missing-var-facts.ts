/**
 * `missing-var` 的**分档文案 + 当场拿得到的事实**（KW-38 1103 判性批；判定零改动）。
 *
 * 为什么要有这个模块：`missing-var` 一枚码底下其实是一堆不同的事实（KW-34 真语料 81 枚逐枚归族），
 * 而屏上那句「存档里没有这个变量」对其中最大的一族是**假话**——不是"这张档没这个变量"，
 * 是"这种量根本不落盘"；对形参别名那一族是**误导**——把人推向一个并不存在的"补存档"入口。
 * 形状照 KW-15E（一种码拆多族因果、判定口径一字未动、逐码改前＝改后）：
 * 机器码沿用 `missing-var`，只把「为什么判不出 + 该怎么办」写实。
 *
 * 三档的判据来源（**每一档只说自己当场拿得到的事实**，拿不到就照实说拿不到）：
 * - **A 调用参数别名**：本函数声明行 `@名字(参数表)` 里列着它（行文本实测，`headerArgAliasNames`）。
 *   真语料 34 枚（`对方残机` 18 / `相手残機` 12 / `前戯１` 3 / `本番はどっちか` 1）。
 * - **B 本函数正文里的 `#DIM` 声明**：`[startLine, endLine]` 内有一条 `#DIM/#DIMS/#DIMF 这个名字`
 *   （`dimDeclarationLine`）。真语料 6 枚。**只说"声明在这儿"，不说它是私有还是全局**——
 *   Emuera 的作用域口径本编辑器没有实证，编出来就是假话。
 * - **C 底座（其余 41 枚）**：存档的两本帐（全局变量区 / 这个角色块）逐字都没有它、内置清单没有它、
 *   名字表也没答出它是写死的常量。**分不出"从不落盘"与"这张档缺它"**，因为那要读声明它的那一行，
 *   而声明在别的文件里（`.ERH` 头文件族），本编辑器回放时不读那张表 ⇒ 照实说。
 *
 * A/B 两档由**上妆 pass** 在回放产物成型后替换 `unknown.message`（`annotateMissingVar`）：
 * 只换文案、不改 `kind` / `code` / 计数，且**只有本函数确有 C 档点位时**才去取行文本
 * （真语料 81/11,685 谓词 ⇒ 热路径零额外读盘）。
 */

import type {
  BranchChainOutcome,
  FunctionReplay,
  PredicateReplay,
  ReplayUnknown,
} from '@kojo/plugin-api';

/**
 * C 档（未知名发点）的**固定起手**。
 *
 * 上妆 pass 靠它认"这条 unknown 出自未知名发点"（另外三处发点说的是别的帐，不许被覆盖）——
 * 改了这句起手 = 上妆静默失效，`tests/missing-var-message-families.test.ts` 会红。
 */
export const UNKNOWN_NAME_LEAD = '存档里查不到这一格';

/** 从 C 档文案里取回变量名（格式与解析同在本模块，单一真源） */
const MISSING_NAME_RE = new RegExp(`^${UNKNOWN_NAME_LEAD}\\uFF1a([^\\s\\uFF08(]+)`);

/** `#DIM` 声明行里可跳过的关键字（与 `.ERH` 声明表同一份词；零游戏名词） */
const DIM_KEYWORDS = new Set([
  'CONST',
  'LOCAL',
  'STATIC',
  'DYNAMIC',
  'GLOBAL',
  'SAVEDATA',
  'REF',
  'OUT',
  'CHARADATA',
]);

/** 参数表里的"这格是槽位本身"而非别名（`ARG:1` / 纯数字都带冒号或数字，另判） */
const SLOT_TOKENS = new Set(['ARG', 'ARGS', 'LOCAL', 'LOCALS', 'RESULT', 'RESULTS']);

/** 标识符 token（含日文名；`ARG:1`、`0`、`"文字列"` 都不合形状） */
const IDENT_TOKEN_RE = /^[\p{L}\p{N}_]+$/u;

/**
 * C 档底座句（未知名发点；`state-view.resolveModel` 用）。
 * 只报**这个发点确实查过的东西**：两本帐、内置清单、名字表（在位与否两种说法分开）。
 */
export function unknownNameMessage(args: {
  readonly name: string;
  readonly topCount: number;
  readonly charaCount: number;
  readonly dictionary: 'consulted' | 'absent';
}): string {
  const dictClause =
    args.dictionary === 'consulted'
      ? '名字表也没答出它是写死的常量'
      : '这一轮没有变量名字表可问，连它是不是写死的常量都判不了';
  return (
    `${UNKNOWN_NAME_LEAD}：${args.name}（这份存档的两本帐都翻过——全局变量区 ${args.topCount} 格、` +
    `这个角色块 ${args.charaCount} 格，逐字没有同名的一格，引擎的内置变量清单里也没有它，${dictClause}）。` +
    '口上里用 `#DIM` 开出来的量，只有带 SAVEDATA 旗标的才会进存档，没带旗标的每局现算、根本不落盘；' +
    '这一格属于哪一种，要看声明它的那一行，而本编辑器回放时只翻存档这两本帐、不读别的文件里的声明表 ' +
    '⇒ 说不出"是这种量不落盘"还是"这张档缺它这一格"，只报判不出，不拿 0 或别的档的值凑。'
  );
}

/** A 档：这个名字是本函数声明行列出的调用参数（`headerLine` = 那个 `@` 行的行号） */
export function headerArgAliasMessage(name: string, headerLine: number): string {
  return (
    `这一格是这次调用带进来的参数：${name} 列在本函数声明行（第 ${headerLine} 行）的参数表里，` +
    '它的值取决于"谁在哪里调用它、带了什么进来"。存档里只有状态、没有调用栈，静态无从知道是哪一处调用 ' +
    '⇒ 判不出（与「调用参数」那一族同一回事）。' +
    '注意：面板的「场景参数」只认 ARG / ARGS 的原名，本编辑器不把这个别名对回槽位（对回就得猜调用处）' +
    '⇒ 这一格没有能填的入口，要知道某一处会怎样，只能在口上里顺着调用它的那几行自己判。'
  );
}

/** B 档：这个名字由本函数正文里的 `#DIM` 声明开出来（`declLine` = 那条声明的行号） */
export function dimDeclaredMessage(name: string, declLine: number): string {
  return (
    `这一格是本函数自己用 #DIM 开出来的：第 ${declLine} 行的声明写了 ${name}，` +
    '而存档的两本帐（全局变量区与这个角色块）逐字都没有它 ⇒ 它只活在函数运行期间的读写里。' +
    '本编辑器对函数内数据的跟踪只认 LOCAL / RESULT / ARG 这几类槽，跟不到 #DIM 开的量 ' +
    `⇒ 这一处判不出；它在第 ${declLine} 行之后被写过什么，也不拿 0 或旧值凑。`
  );
}

/** 函数头参数表里的别名（含声明行号）；没有 `@名(参数表)` 形态 → null */
export function headerArgAliasNames(
  lines: readonly string[],
  startLine: number,
): { readonly line: number; readonly names: ReadonlySet<string> } | null {
  const raw = lines[startLine - 1];
  if (raw === undefined) return null;
  const header = raw.trim();
  if (!header.startsWith('@')) return null;
  const open = header.indexOf('(');
  const close = header.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const names = new Set<string>();
  for (const part of header.slice(open + 1, close).split(',')) {
    const token = part.trim();
    if (!IDENT_TOKEN_RE.test(token)) continue; // `ARG:1` / `0` / `"文字列"` 一律不收
    const upper = token.toUpperCase();
    if (SLOT_TOKENS.has(upper)) continue; // 槽位本身走 call-context，不是别名
    names.add(upper);
  }
  return names.size > 0 ? { line: startLine, names } : null;
}

/**
 * 本函数正文 `[from, to]` 里第一条声明了这个名字的 `#DIM` 族行（行号；没有 → null）。
 * 行首 `;` 的注释形态不算（`#` 不是这行的第一个字符）。
 */
export function dimDeclarationLine(
  lines: readonly string[],
  name: string,
  from: number,
  to: number,
): number | null {
  const want = name.toUpperCase();
  if (want.length === 0) return null;
  const last = Math.min(to, lines.length);
  for (let i = Math.max(1, from); i <= last; i++) {
    const text = (lines[i - 1] ?? '').trim();
    const m = /^#(DIMS|DIMF|DIM)([\s\S]*)$/i.exec(text);
    if (!m) continue;
    for (const part of (m[2] ?? '').split(/[\s,=]+/)) {
      if (part.length === 0) continue;
      if (DIM_KEYWORDS.has(part.toUpperCase())) continue;
      if (part.toUpperCase() === want) return i;
      break; // 第一个非关键字 token 就是被声明的名字，不是它就看下一条声明行
    }
  }
  return null;
}

/** 上妆所需的函数形状（行文本 + 本函数的行区间；读不到行文本就不上妆） */
export interface FunctionShape {
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
}

/** 从 C 档文案里取回变量名（格式与解析同在本模块，单一真源；文案改了这里就红，不会静默失妆） */
export function unknownNameFromMessage(message: string): string | null {
  return MISSING_NAME_RE.exec(message)?.[1] ?? null;
}

/** 这条 unknown 是不是 C 档（未知名发点）——只有它允许被 A/B 档替换 */
function isUnknownNameSite(u: ReplayUnknown): boolean {
  return u.code === 'missing-var' && u.message.startsWith(UNKNOWN_NAME_LEAD);
}

/**
 * 本函数有没有 C 档点位（引擎侧的**取行文本闸门**）：一枚都没有就不为文案多读一次盘
 * （真语料 81/11,685 谓词 ⇒ 热路径零额外 IO）。
 */
export function hasUnknownNameSite(replay: FunctionReplay): boolean {
  return replay.predicates.some((p) => p.outcome.kind === 'unknown' && isUnknownNameSite(p.outcome.unknown));
}

/**
 * 把 C 档按函数形状上妆成 A / B 档（**纯函数，只动 `message`**）。
 *
 * `kind` / `code` / 谓词条数 / 分支可达性一概不碰；同一条 unknown 被分支链或台词区引用时
 * 按对象身份一起换（否则屏上两处会读到两种说法）。无需上妆时返回**同一个对象**（零复制）。
 */
export function annotateMissingVar(replay: FunctionReplay, shape: FunctionShape): FunctionReplay {
  const aliases = headerArgAliasNames(shape.lines, shape.startLine);
  const replaced = new Map<ReplayUnknown, ReplayUnknown>();
  const collect = (u: ReplayUnknown | undefined): void => {
    if (!u || !isUnknownNameSite(u) || replaced.has(u)) return;
    const name = unknownNameFromMessage(u.message);
    if (name === null) return;
    const upper = name.toUpperCase();
    if (aliases && aliases.names.has(upper)) {
      replaced.set(u, { code: u.code, message: headerArgAliasMessage(name, aliases.line) });
      return;
    }
    const decl = dimDeclarationLine(shape.lines, upper, shape.startLine, shape.endLine);
    if (decl !== null) replaced.set(u, { code: u.code, message: dimDeclaredMessage(name, decl) });
  };
  // 先扫一遍收表（谓词与分支链引用的是同一批对象），再决定要不要复制
  for (const p of replay.predicates) if (p.outcome.kind === 'unknown') collect(p.outcome.unknown);
  for (const b of replay.branches) collect(b.unknown);
  if (replaced.size === 0) return replay; // 一枚都上不了妆 ⇒ 原对象返回（零复制、零改动）
  const predicates: PredicateReplay[] = replay.predicates.map((p) =>
    p.outcome.kind === 'unknown' && replaced.has(p.outcome.unknown)
      ? { ...p, outcome: { kind: 'unknown', unknown: replaced.get(p.outcome.unknown)! } }
      : p,
  );
  const branches: BranchChainOutcome[] = replay.branches.map((b) =>
    b.unknown && replaced.has(b.unknown) ? { ...b, unknown: replaced.get(b.unknown)! } : b,
  );
  return { ...replay, predicates, branches };
}
