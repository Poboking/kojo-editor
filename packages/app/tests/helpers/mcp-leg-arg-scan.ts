/**
 * MCP 执行腿「入参取用」扫描器（B19 批 · 双向漂移闸的机械侧）。
 *
 * 为什么要它：B11 把三张契约表逐面 strict 成 `additionalProperties:false`，B16 给
 * `search.all` / `workspace.searchAll` 加了新入参 `resumeBySlice` **只写在腿里、没写进
 * schema** ⇒ 真客户端发那一枚会被校验层当场拒收，功能对模型不可达；而两边测试都绿，因为
 * 判据 2 的「腿实际取用什么」是**手抄表**（`mcp-arg-strictness.test.ts::CONSUMED`）。
 * 本模块把那张手抄表换成**从源码扫出来的取用集**，扫不到的形态一律红（不许静默兜底）。
 *
 * 认得的取用形态（每一支都落 `ScanSite`，kind 逐条可查）：
 *  1. `args['lit']` / `args?.['lit']` / `(args ?? {})['lit']` ⇒ 一枚键；
 *  2. `args.lit` ⇒ 一枚键；
 *  3. `args[dyn]`，`dyn` 能静态判成**字面量集合**时逐条展开：
 *     - `for (const dyn of ['a','b'] as const) { … }`（数组字面量）；
 *     - `for (const dyn of SOME_CONST) { … }`（SOME_CONST ＝ 某文件里 `… = ['lit', …] as const`）；
 *     - 形参：`requireId(args, 'instanceId', …)` / 循环变量再传给下一层
 *       `optionalString(args, key, …)` ⇒ 各调用点的字面量并集；
 *     判不出来 ⇒ `unresolved:dynamic-key`（红，除非逐条挂账）；
 *     其中 `PAGE_SIZE_ARG_ALIASES` 那一支额外带**短路语义**（`pageSizeOf` 拿到一个数就 return）：
 *     展开集只算到第一个「必然有值」的别名（由形态 7 的显式覆写给出），其后的别名记 note 不算取用；
 *  4. 别名：`const input = args` / `= args ?? {}` ⇒ 后续 `input['x']` 同计；
 *  5. 解构：`const { a, b: c } = args` ⇒ a / b 各一枚键；
 *  6. 整只对象交给**解析得到的函数**（宇宙＝下面 `LEG_CORPUS` 十个文件；解析顺序＝同文件具名定义
 *     → `const` 绑定（工厂 / 解构 / `F().prop` 链）→ `@kojo/mcp-host` 具名导入 → 单 return 箭头穿透）
 *     ⇒ 按**位置**把 flow 绑到被调形参继续走；共用页大小闸
 *     （`pageParamsFor` / `paginateText` / `paginateByCursor` → `pageSizeOf` / `assertCursorShape`）
 *     因此是从**宿主源码本身**展开，不抄清单；
 *  7. 展开 `{ ...args, maxResults }` ⇒ 仍按 6 递归，并把「显式覆写、必然有值」的键记进 `guaranteed`
 *     （只有喂给带短路语义的别名循环时才用它裁剪）；
 *  8. 整只对象装进对象字面量再传下（`runner({ args: args ?? {}, query, … })`）⇒ 被调形参记成 ctx，
 *     `ctx.args['cursor']` 同计（flow 过上下文对象仍可追）。
 *
 * **它怎么失败（本模块的立身之本）**：
 *  - 任何一次 `args`（或其别名）出现落进上面八支之外 ⇒ `unresolved` 站点 ⇒ 闸红；
 *  - 整只对象交给解析不到的目标（成员表达式 `requireTaskLegs(x).start(args)`）⇒
 *    `unresolved:opaque-handoff`，只有**逐条点名**（文件 + 锚文本 + 目标符号 + 理由）的挂账能放行，
 *    且挂账必须真被命中一次（腿改道 ⇒ 挂账陈旧 ⇒ 红）；挂账同时**校验目标符号确实存在**；
 *  - 面在派生腿表与挂账入口里都找不到执行体 ⇒ `no-entry`（红）；入口符号不存在 ⇒ 红；
 *  - 外部模块（非 `@kojo/mcp-host`）的函数吃掉整只 args ⇒ 红，不静默当「没取用」。
 *
 * 纪律：本模块只活在测试里，**绝不 import 进任何运行时面**（ps10 开机图不认测试 helper）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/app/tests/helpers` → 仓根（helpers → tests → app → packages → 仓根）。 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** 扫描宇宙：全部执行腿 + 共用分页闸的宿主实现（真源，不是抄来的清单）。 */
export const LEG_CORPUS: readonly string[] = [
  'packages/app/src/mcp/real-sources.ts',
  'packages/app/src/mcp/real-sources-io.ts',
  'packages/app/src/mcp/real-sources-tasks.ts',
  'packages/app/src/mcp/real-sources-launcher.ts',
  'packages/app/src/mcp/editor-write-legs.ts',
  'packages/app/src/mcp/editor-open-legs.ts',
  'packages/app/src/mcp/batch-read-leg.ts',
  'packages/app/src/mcp/search-slice-leg.ts',
  'packages/app/src/mcp/quick-fix.ts',
  'packages/mcp-host/src/index.ts',
];

/** 页大小别名常量名（唯一带短路语义的循环源；见形态 3）。 */
export const ALIAS_CONST = 'PAGE_SIZE_ARG_ALIASES';

/**
 * 腿本体第一形参的合法名（入参对象）。工厂 / seam 宿主的形参（`deps`、`opts`…）不在其列：
 * 解析到它们说明执行体根本没落到腿上，必须红（见 `scanCorpus` 的入参形状复核）。
 */
const ARGS_PARAM = /^(args|rawArgs|input|params)$/;

/* ------------------------------- 词法 ------------------------------- */

interface Tok {
  readonly t: 'id' | 'str' | 'num' | 'p';
  /** id 名 / 字符串内容 / punct 文本。 */
  readonly v: string;
  readonly s: number;
  readonly e: number;
  /** 模板插值闭括号（与普通 `}` 区分，供配对用）。 */
  readonly interpClose?: boolean;
}

const ID_START = /[A-Za-z_$]/;
const ID_BODY = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const P3 = ['...', '===', '!==', '**=', '??=', '||=', '&&='];
const P2 = ['=>', '??', '?.', '&&', '||', '==', '!=', '<=', '>=', '>>', '<<', '+=', '-=', '*=', '/=', '**'];
/** 这些 punct / 关键字之后出现的 `/` 视为正则字面量起点。 */
const REGEX_OK = new Set(['(', ',', ':', '=', '=>', '[', '!', '&', '|', '?', '{', '}', ';', 'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'case', '??', '||', '&&', '**', '/', '+', '-', '%']);

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  /** 模板字面量栈：`inExpr` ＝当前在 `${…}` 里（要按代码词法走），否则在静态段。 */
  const frames: { inExpr: boolean; depth: number }[] = [];
  const push = (t: Tok['t'], v: string, s: number, e: number, interpClose?: boolean): void => {
    out.push(interpClose ? { t, v, s, e, interpClose } : { t, v, s, e });
  };
  const regexAllowed = (): boolean => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === 'id') return REGEX_OK.has(p.v);
    if (p.t === 'p') return p.v !== ')' && p.v !== ']';
    return false;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n' || c === '\r' || c === '\t' || c === ' ') {
      i += 1;
      continue;
    }
    const top = frames[frames.length - 1];
    if (top && !top.inExpr) {
      // 模板静态段：直到下一个 `` ` `` 或 `${`
      if (c === '`') {
        push('p', '`', i, i + 1);
        frames.pop();
        i += 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        push('p', '${', i, i + 2);
        top.inExpr = true;
        top.depth = 0;
        i += 2;
        continue;
      }
      let j = i;
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += 1;
      push('str', src.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (top && top.inExpr && c === '}') {
      if (top.depth > 0) {
        top.depth -= 1;
        push('p', c, i, i + 1);
        i += 1;
        continue;
      }
      // 回到模板静态段：这一枚 `}` 与 `${` 配对
      push('p', '}', i, i + 1, true);
      top.inExpr = false;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let body = '';
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') {
          const nx = src[j + 1]!;
          body += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          j += 2;
        } else {
          body += src[j]!;
          j += 1;
        }
      }
      push('str', body, i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      push('p', '`', i, i + 1);
      frames.push({ inExpr: false, depth: 0 });
      i += 1;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      let ok = true;
      while (j < src.length) {
        const d = src[j]!;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') {
          ok = false;
          break;
        }
        j += 1;
      }
      if (ok) {
        push('p', src.slice(i, j + 1), i, j + 1);
        i = j + 1;
        continue;
      }
      // 判读失败 ⇒ 当成普通 punct（后续结构多半对不上，由闸的站点缺失侧响）
      push('p', c, i, i + 1);
      i += 1;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_BODY.test(src[j]!)) j += 1;
      push('id', src.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9a-fA-FxXoObB._]/.test(src[j]!)) j += 1;
      push('num', src.slice(i, j), i, j);
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const m3 = P3.find((op) => op === three);
    if (m3) {
      push('p', m3, i, i + 3);
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    const m2 = P2.find((op) => op === two);
    if (m2) {
      push('p', m2, i, i + 2);
      i += 2;
      continue;
    }
    if (c === '{') {
      const t = frames[frames.length - 1];
      if (t && t.inExpr) t.depth += 1;
    }
    push('p', c, i, i + 1);
    i += 1;
  }
  return out;
}

/* ------------------------------- 结构 ------------------------------- */

interface FuncDef {
  readonly name: string | null;
  readonly paramNames: string[];
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

interface FileScan {
  readonly rel: string;
  readonly src: string;
  readonly toks: Tok[];
  readonly close: Int32Array;
  readonly open: Int32Array;
  readonly enclosed: Int32Array;
  readonly lineStarts: number[];
  readonly defs: FuncDef[];
  readonly constBind: Map<string, ConstBind>;
  readonly imports: Map<string, string>;
  readonly legTables: { face: string; ident: string }[];
}

type ConstBind =
  | { readonly kind: 'fn' }
  | { readonly kind: 'factory'; readonly callee: string }
  | { readonly kind: 'destructure'; readonly source: string; readonly props: ReadonlyMap<string, string> }
  | { readonly kind: 'member'; readonly source: string; readonly prop: string }
  | { readonly kind: 'other' };

function lineIndexOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) if (src[i] === '\n') n += 1;
  return n;
}

/**
 * 配对表取值：`Int32Array` 在 `noUncheckedIndexedAccess` 下给 `number | undefined`，
 * 这里统一收成 **-1 哨兵**（越界 / 未配对都是 -1），各支判 `< 0` 走「解析不出来 ⇒ 红」那条路，
 * 绝不拿 undefined 去当下标（那会把静默兜底藏进类型系统）。
 */
function idxAt(arr: Int32Array, at: number): number {
  if (!Number.isInteger(at) || at < 0 || at >= arr.length) return -1;
  return arr[at] as number;
}

function buildFile(rel: string, root: string = REPO_ROOT): FileScan {
  const src = readFileSync(resolve(root, rel), 'utf8');
  const toks = lex(src);
  const n = toks.length;
  const close = new Int32Array(n).fill(-1);
  const open = new Int32Array(n).fill(-1);
  const enclosed = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < n; i += 1) {
    enclosed[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
    const t = toks[i]!;
    if (t.t !== 'p') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') {
      stack.push(i);
      continue;
    }
    if (t.v === ')' || t.v === ']' || t.v === '}') {
      const top = stack[stack.length - 1];
      if (top === undefined) continue;
      const ot = toks[top]!;
      const ok =
        (t.v === ')' && ot.v === '(') ||
        (t.v === ']' && ot.v === '[') ||
        (t.v === '}' && ot.v === '{') ||
        (t.v === '}' && ot.v === '${');
      if (ok) {
        close[top] = i;
        open[i] = top;
        stack.pop();
      }
    }
  }
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const imports = new Map<string, string>();
  const defs: FuncDef[] = [];
  const constBind = new Map<string, ConstBind>();
  collect(toks, close, open, defs, constBind, imports);
  return {
    rel,
    src,
    toks,
    close,
    open,
    enclosed,
    lineStarts,
    defs,
    constBind,
    imports,
    legTables: collectLegTables(toks, close),
  };
}

function collect(
  toks: Tok[],
  close: Int32Array,
  open: Int32Array,
  defs: FuncDef[],
  constBind: Map<string, ConstBind>,
  imports: Map<string, string>,
): void {
  // 类型区：`interface X {…}` / `type X = …;` 内的 `=>` 是函数类型标注，不是定义。
  const typeRanges: [number, number][] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.t !== 'id') continue;
    if (t.v === 'interface' || t.v === 'declare') {
      let j = i;
      while (j < toks.length && toks[j]!.v !== '{' && toks[j]!.v !== ';') j += 1;
      if (toks[j]!.v === '{') {
        typeRanges.push([j, close[j]!]);
        i = close[j]!;
      } else i = j;
      continue;
    }
    if (t.v === 'type' && toks[i + 1]?.t === 'id' && toks[i + 2]?.v === '=') {
      let j = i + 1;
      let depth = 0;
      while (j < toks.length) {
        const v = toks[j]!.v;
        if (v === '{' || v === '(' || v === '[' || v === '${') depth += 1;
        else if (v === '}' || v === ')' || v === ']') depth -= 1;
        else if (v === ';' && depth === 0) break;
        j += 1;
      }
      typeRanges.push([i, j]);
      i = j;
    }
  }
  const inType = (idx: number): boolean => typeRanges.some(([a, b]) => idx >= a && idx <= b);

  // 「最近一条还没结束的 const/let 声明」＋「最近一个语句终止符」：给箭头定义找回变量名用
  let lastDeclName: string | null = null;
  let lastDeclIdx = -1;
  let lastSemiIdx = -1;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.t === 'p' && t.v === ';') lastSemiIdx = i;
    if (t.t === 'id' && (t.v === 'const' || t.v === 'let' || t.v === 'var') && toks[i + 1]?.t === 'id') {
      lastDeclName = toks[i + 1]!.v;
      lastDeclIdx = i;
    }
    if (t.t === 'id' && t.v === 'import') {
      // `import { a, b as c } from 'mod'`
      let j = i + 1;
      if (toks[j]?.v === '{') {
        const bc = close[j]!;
        let k = j + 1;
        while (k < bc) {
          const id = toks[k]!;
          if (id.t === 'str') {
            k += 1;
            continue;
          }
          if (id.t === 'id') {
            let local = id.v;
            if (toks[k + 1]?.v === 'as' && toks[k + 2]?.t === 'id') {
              local = toks[k + 2]!.v;
              k += 2;
            }
            const from = findFromModule(toks, i);
            if (from) imports.set(local, from);
          }
          k += 1;
        }
        i = bc;
      }
      continue;
    }
    if (t.t === 'id' && t.v === 'function') {
      let j = i + 1;
      let name: string | null = null;
      if (toks[j]?.t === 'id') {
        name = toks[j]!.v;
        j += 1;
      }
      if (toks[j]?.v === '*') j += 1;
      if (toks[j]?.v === '<') {
        // 泛型形参 `<T, U>`：跳到配对的 `>`
        let angle = 0;
        while (j < toks.length) {
          const v = toks[j]!.v;
          if (v === '<') angle += 1;
          else if (v === '>') angle -= 1;
          else if (v === '>>') angle -= 2;
          if (angle === 0) break;
          j += 1;
        }
        j += 1;
      }
      if (toks[j]?.v !== '(') continue;
      const po = j;
      const pc = close[po]!;
      if (pc < 0) continue;
      const k = findBodyBrace(toks, close, pc + 1);
      if (toks[k]?.v !== '{') {
        i = k;
        continue;
      }
      const bc = close[k]!;
      if (bc < 0) continue;
      defs.push({ name, paramNames: paramNamesOf(toks, po, pc), bodyStart: k + 1, bodyEnd: bc - 1 });
      if (name) markFnBind(constBind, name);
      // 不进 body 内部继续扫 ⇒ 工厂里的那些腿（`createKernelIo` / `createLauncherLegs` 一族）会全部漏掉
      i = k;
      continue;
    }
    if (t.t === 'p' && t.v === '=>' && i > 0) {
      const prev = toks[i - 1]!;
      let paramOpen = -1;
      let singleParam: string | null = null;
      if (prev.v === ')') {
        paramOpen = open[i - 1]!;
        if (paramOpen < 0 || inType(paramOpen)) continue;
      } else if (prev.t === 'id' && !inType(i)) {
        if (inType(i)) continue;
        // `) => T` 之后的 `=>` 也可能是「带返回类型标注的箭头」；先按 id 记单形参，
        // 只有往前找不到参数表右括号时才真的当单形参用。
        singleParam = prev.v;
      } else singleParam = null;
      if (paramOpen < 0 && singleParam === null) {
        // `async (a, b): Promise<unknown> => {}`：`=>` 前是返回类型标注的尾 token ⇒ 回找参数表右括号
        let q = i - 1;
        let angle = 0;
        while (q >= 0) {
          const v = toks[q]!.v;
          if (v === ')' && angle === 0) break;
          if (v === '>') angle += 1;
          else if (v === '<') angle = Math.max(0, angle - 1);
          else if (v === '{' || v === '}' || v === ';' || v === '(' || v === ',') {
            q = -1;
            break;
          }
          q -= 1;
        }
        if (q > 0 && toks[q]!.v === ')') {
          const po = idxAt(open, q);
          if (po > 0 && !inType(po)) paramOpen = po;
        }
      }
      if (paramOpen < 0 && singleParam === null) continue;
      const body = i + 1;
      let bodyStart = body;
      let bodyEnd = -1;
      if (toks[body]?.v === '{') {
        bodyStart = body + 1;
        bodyEnd = close[body]! - 1;
      } else {
        // 类型标注里的 `=> 类型`（如 `new Map<string, (…) => Promise<unknown>>`）不是定义。
        if (looksLikeTypeBody(toks, body)) continue;
        bodyEnd = exprBodyEnd(toks, i, body);
      }
      if (bodyEnd < bodyStart) continue;
      // 名字：`const NAME [：类型标注] = (…) => …`。类型标注可能横贯多行（fs.readFile 那一族就是），
      // 所以判据是「参数括号往前跳过 async 就是 `=`」+「最近一条未结束的 const/let 声明」。
      let name: string | null = null;
      const anchor = paramOpen >= 0 ? paramOpen : i - 1;
      let k = anchor - 1;
      if (toks[k]?.v === 'async') k -= 1;
      if (toks[k]?.v === '=' && lastDeclIdx >= 0 && lastDeclIdx < k && lastSemiIdx < lastDeclIdx) {
        name = lastDeclName;
      }
      const paramNames = paramOpen >= 0 ? paramNamesOf(toks, paramOpen, close[paramOpen]!) : singleParam ? [singleParam] : [];
      defs.push({ name, paramNames, bodyStart, bodyEnd });
      if (name) markFnBind(constBind, name);
      i = bodyEnd;
      continue;
    }
  }
  collectConstBindings(toks, close, constBind);
}

function enclosedIsTopLevel(_toks: Tok[], _i: number): boolean {
  return true;
}

function markFnBind(map: Map<string, ConstBind>, name: string): void {
  if (!map.has(name)) map.set(name, { kind: 'fn' });
}

function findFromModule(toks: Tok[], importIdx: number): string | null {
  for (let j = importIdx; j < toks.length && j < importIdx + 400; j += 1) {
    const t = toks[j]!;
    if (t.t === 'id' && t.v === 'from') {
      const m = toks[j + 1];
      return m?.t === 'str' ? m.v : null;
    }
    if (t.t === 'p' && t.v === ';') return null;
  }
  return null;
}

/** 表达式体箭头的右界：走到本语句结束（顶层 `;` / `,` / 容器闭）。 */
function exprBodyEnd(toks: Tok[], from: number, start: number): number {
  let depth = 0;
  for (let i = start; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.t === 'p') {
      if (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') {
        depth += 1;
        continue;
      }
      if (t.v === ')' || t.v === ']' || t.v === '}') {
        if (depth === 0) return i - 1;
        depth -= 1;
        continue;
      }
      if (depth === 0 && (t.v === ';' || t.v === ',')) return i - 1;
    }
  }
  void from;
  return toks.length - 1;
}

function paramNamesOf(toks: Tok[], paramOpen: number, paramClose: number): string[] {
  const names: string[] = [];
  for (const [a, b] of splitParams(toks, paramOpen, paramClose)) {
    const f = toks[a]!;
    if (f.t !== 'id') {
      names.push(`_pattern@${a}`);
      continue;
    }
    if (f.v === 'readonly' || f.v === 'public' || f.v === 'private') {
      const nx = toks[a + 1];
      names.push(nx?.t === 'id' ? nx.v : `_pattern@${a}`);
      continue;
    }
    void b;
    names.push(f.v);
  }
  return names;
}

/**
 * 形参表切分：与 `splitTop` 同构，但**额外认泛型实参 `<…>`**——
 * `Record<string, unknown>` 里那枚逗号不是形参分隔符（数错一枚 ⇒ 整张形参表右移一位 ⇒
 * `requireId(args,'instanceId',…)` 的标签被绑成 `key`，取用名就变成工具名本身）。
 * 只在「本段已经出现过 `:`（＝进入类型标注位）且 `<` 紧跟标识符」时进入泛型区，
 * 避免把 `x = a < b` 这类默认值比较当成泛型尾巴。
 */
function splitParams(toks: Tok[], paramOpen: number, paramClose: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let angle = 0;
  let segStart = paramOpen + 1;
  let seen = false;
  let inType = false;
  for (let i = paramOpen + 1; i <= paramClose; i += 1) {
    const t = toks[i]!;
    const v = t.v;
    const isEnd = i === paramClose;
    if (angle > 0) {
      if (v === '<') angle += 1;
      else if (v === '>') angle -= 1;
      else if (v === '>>') angle -= 2;
      else if (v === '>>>') angle -= 3;
      seen = true;
      continue;
    }
    if (depth === 0 && !isEnd && v === ',') {
      if (seen || i > segStart) out.push([segStart, i - 1]);
      segStart = i + 1;
      seen = false;
      inType = false;
      continue;
    }
    if (v === '(' || v === '[' || v === '{' || v === '${') {
      depth += 1;
      seen = true;
      continue;
    }
    if (v === ')' || v === ']' || v === '}') {
      if (depth === 0 && isEnd) break;
      depth -= 1;
      seen = true;
      continue;
    }
    if (v === ':' && depth === 0) inType = true;
    if (inType && v === '<' && toks[i - 1]?.t === 'id') {
      angle += 1;
      seen = true;
      continue;
    }
    seen = true;
  }
  if (seen) out.push([segStart, paramClose - 1]);
  return out;
}

const STATEMENT_KEYWORDS = new Set([
  'const', 'let', 'var', 'return', 'if', 'for', 'while', 'do', 'switch', 'throw', 'try', 'catch',
  'await', 'function', 'class', 'break', 'continue', 'async', 'export', 'import', 'delete',
]);

/**
 * 参数表右括号之后找**函数体**那枚 `{`：TS 的返回类型标注自己就能带对象类型
 * （`paginateByCursor(…): { readonly page: readonly T[]; … } { … }` 正是这个形状）。
 * 按「第一枚 `{` 即函数体」判会把类型标注当成体 ⇒ 整条腿体内的取用点**静默消失**
 * （既不红也不真取用）——那正是本批要消灭的假绿形状，所以这里必须分辨。
 */
function findBodyBrace(toks: Tok[], close: Int32Array, from: number): number {
  let k = from;
  for (let skipped = 0; k < toks.length; k += 1) {
    const v = toks[k]!.v;
    if (v === ';') return k;
    if (v === '{') {
      const bc = close[k];
      if (bc === undefined || bc < 0) return k;
      if (!looksLikeObjectType(toks, k, bc)) return k;
      // 跳过的是一枚对象**类型**：继续往后找函数体（最多跳 8 层，防御死循环）
      skipped += 1;
      if (skipped > 8) return k;
      k = bc;
      continue;
    }
  }
  return k;
}

/** 这枚 `{…}` 是对象**类型**还是函数体：体内有语句痕迹（语句关键字 / `foo(` 调用）⇒ 体；空花括号 ⇒ 体。 */
function looksLikeObjectType(toks: Tok[], open: number, closeIdx: number): boolean {
  if (open + 1 >= closeIdx) return false;
  let depth = 0;
  let hasMemberColon = false;
  for (let i = open + 1; i < closeIdx; i += 1) {
    const t = toks[i]!;
    const v = t.v;
    if (v === '{' || v === '(' || v === '[' || v === '${') {
      depth += 1;
      continue;
    }
    if (v === '}' || v === ')' || v === ']' || t.interpClose === true) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (t.t === 'id') {
      if (STATEMENT_KEYWORDS.has(v)) return false;
      if (toks[i + 1]?.v === '(') return false;
      if (v === ':') hasMemberColon = true;
    } else if (v === ':') {
      hasMemberColon = true;
    }
  }
  // 没有任何 depth-0 成员分隔符的花括号不当类型（`{ x; }` 这种体内首句也不是没可能），
  // 宁可当成体走「扫不到就红」那条路，也不要悄悄把函数体跳过去。
  return hasMemberColon;
}

function splitTop(toks: Tok[], open: number, closeIdx: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let segStart = open + 1;
  let seen = false;
  for (let i = open + 1; i < closeIdx; i += 1) {
    const v = toks[i]!.v;
    if (v === '(' || v === '[' || v === '{' || v === '${') {
      depth += 1;
      seen = true;
      continue;
    }
    if (v === ')' || v === ']' || v === '}') {
      depth -= 1;
      seen = true;
      continue;
    }
    if (v === ',' && depth === 0) {
      if (seen || i > segStart) out.push([segStart, i - 1]);
      segStart = i + 1;
      seen = false;
      continue;
    }
    seen = true;
  }
  if (seen) out.push([segStart, closeIdx - 1]);
  return out;
}

function collectConstBindings(toks: Tok[], close: Int32Array, map: Map<string, ConstBind>): void {
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.t !== 'id' || (t.v !== 'const' && t.v !== 'let' && t.v !== 'var')) continue;
    const nx = toks[i + 1];
    if (!nx) continue;
    if (nx.t === 'id') {
      let j = i + 2;
      if (toks[j]?.v === ':') {
        let depth = 0;
        while (j < toks.length) {
          const v = toks[j]!.v;
          if (v === '<' || v === '(' || v === '[' || v === '{') depth += 1;
          else if (v === '>' || v === ')' || v === ']' || v === '}') depth -= 1;
          else if (v === '=' && depth === 0) break;
          else if (v === ';' && depth === 0) break;
          j += 1;
        }
      }
      if (toks[j]?.v !== '=') continue;
      const r = j + 1;
      const r1 = toks[r];
      if (!r1) continue;
      if (r1.t === 'id' && toks[r + 1]?.v === '(') {
        // `const leg = createLegs(deps).theLeg` ⇒ 这是「工厂结果的某个成员」，不是工厂本身。
        // 记成 factory 会把**工厂的 deps 形参**当入参对象扫，于是注入 seam
        // （emitIntent / observePanes / sleep / now / getRootDir / resolveWithinRoot）
        // 全部冒充成取用名，而腿真正读的那两枚反而一个不中。
        const callClose = close[r + 1];
        const dot = callClose !== undefined && callClose >= 0 ? toks[callClose + 1]?.v : undefined;
        const propTok = callClose !== undefined && callClose >= 0 ? toks[callClose + 2] : undefined;
        if ((dot === '.' || dot === '?.') && propTok?.t === 'id') {
          if (!map.has(nx.v)) map.set(nx.v, { kind: 'member', source: r1.v, prop: propTok.v });
        } else if (!map.has(nx.v)) {
          map.set(nx.v, { kind: 'factory', callee: r1.v });
        }
      } else if (r1.t === 'id' && toks[r + 1]?.v === '.') {
        const prop = toks[r + 2]?.v ?? '';
        if (!map.has(nx.v)) map.set(nx.v, { kind: 'member', source: r1.v, prop });
      } else if (r1.t === 'id' && toks[r + 1]?.v === '?.' && toks[r + 2]?.t === 'id') {
        if (!map.has(nx.v)) map.set(nx.v, { kind: 'member', source: r1.v, prop: toks[r + 2]!.v });
      }
      continue;
    }
    if (nx.v === '{') {
      const bc = close[i + 1];
      if (bc === undefined || bc < 0) continue;
      let j = bc + 1;
      let depth = 0;
      while (j < toks.length) {
        const v = toks[j]!.v;
        if (v === '(' || v === '[' || v === '{') depth += 1;
        else if (v === ')' || v === ']' || v === '}') depth -= 1;
        else if (v === '=' && depth === 0) break;
        else if (v === ';' && depth === 0) break;
        j += 1;
      }
      if (toks[j]?.v !== '=') continue;
      const r = j + 1;
      const src = bindSource(toks, r);
      const props = new Map<string, string>();
      for (const [a, b] of splitTop(toks, i + 1, bc)) {
        const f = toks[a]!;
        if (f.t !== 'id') continue;
        if (toks[a + 1]?.v === ':' && toks[a + 2]?.t === 'id') props.set(toks[a + 2]!.v, f.v);
        else props.set(f.v, f.v);
        void b;
      }
      for (const [alias, prop] of props) {
        if (!map.has(alias)) map.set(alias, { kind: 'destructure', source: src, props: new Map([[alias, prop]]) });
      }
      i = bc;
    }
  }
}

function bindSource(toks: Tok[], start: number): string {
  const t = toks[start];
  if (!t) return '?';
  if (t.t === 'id') return t.v;
  return '?';
}

function collectLegTables(toks: Tok[], close: Int32Array): { face: string; ident: string }[] {
  const out: { face: string; ident: string }[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.t !== 'id' || t.v !== 'Map') continue;
    let j = i + 1;
    if (process.env['B19_DEBUG'] === '1') {
      // eslint-disable-next-line no-console
      console.log('MAP CTX', toks.slice(i, i + 14).map((x) => x.v).join(' | '));
    }
    // 跳过泛型实参 `<…>`（里面有 `(...)=>…` 这类函数类型标注）
    if (toks[j]?.v === '<') {
      let angle = 0;
      while (j < toks.length) {
        const v = toks[j]!.v;
        if (v === '<') angle += 1;
        else if (v === '>') angle -= 1;
        else if (v === '>>') angle -= 2;
        else if (v === '>>>') angle -= 3;
        if (angle === 0) break;
        j += 1;
      }
      j += 1;
    }
    if (toks[j]?.v !== '(') continue;
    const jc = close[j];
    if (jc === undefined || jc < 0) continue;
    // `new Map([ ['face', ident], … ])`：构造实参的第一枚 token 是 entries 数组。
    // 只认这种内联字面量形状；`new Map(x.map(...))` 一类派生形式不猜，留给挂账。
    const arrOpen = j + 1;
    if (toks[arrOpen]?.v !== '[') continue;
    const arrClose = close[arrOpen];
    if (arrClose === undefined || arrClose < 0) continue;
    for (let k = arrOpen + 1; k < arrClose; k += 1) {
      if (toks[k]!.v !== '[') continue;
      const kc = close[k];
      if (kc === undefined || kc < 0) continue;
      const segs = splitTop(toks, k, kc);
      if (segs.length !== 2) {
        k = kc;
        continue;
      }
      const [fa, fb] = segs[0]!;
      const [ia] = segs[1]!;
      const faceTok = toks[fa]!;
      if (fa === fb && faceTok.t === 'str' && toks[ia]!.t === 'id') out.push({ face: faceTok.v, ident: toks[ia]!.v });
      k = kc;
    }
    i = jc;
  }
  if (process.env['B19_DEBUG'] === '1' && toks.some((t) => t.v === 'Map')) {
    // eslint-disable-next-line no-console
    console.log('collectLegTables', toks.filter((t) => t.v === 'Map').length, '=>', out.length);
  }
  return out;
}

/* ------------------------------- 取用遍历 ------------------------------- */

export type SiteKind =
  | 'key'
  | 'alias'
  | 'destructure'
  | 'handoff'
  | 'spread-handoff'
  | 'ctx-handoff'
  | 'ctx-member'
  | 'presence'
  | 'introspect'
  | 'unresolved';

export interface ScanSite {
  readonly face: string;
  readonly file: string;
  readonly line: number;
  readonly kind: SiteKind;
  readonly expr: string;
  readonly keys: readonly string[];
  readonly detail?: string;
}

export interface FaceScan {
  readonly face: string;
  readonly entry: string;
  readonly consumed: readonly string[];
  readonly sites: readonly ScanSite[];
  readonly unresolved: readonly ScanSite[];
  readonly notes: readonly string[];
}

interface KeySet {
  readonly keys: string[];
  readonly shortCircuit?: boolean;
}

interface Bind {
  readonly flow: Set<string>;
  readonly ctx: Set<string>;
  readonly keySets: Map<string, KeySet>;
  readonly guaranteed: Set<string>;
}

interface Run {
  readonly files: Map<string, FileScan>;
  readonly face: string;
  readonly sites: ScanSite[];
  readonly notes: string[];
  readonly visited: Set<string>;
  readonly problems: string[];
  readonly hitLedgers: Set<string>;
  readonly cfg: ScanConfig;
}

function newBind(name?: string): Bind {
  return { flow: new Set(name ? [name] : []), ctx: new Set(), keySets: new Map(), guaranteed: new Set() };
}

function childBind(parent: Bind, paramNames: string[], idx: number): Bind | null {
  const name = paramNames[idx];
  if (!name) return null;
  return { flow: new Set([name]), ctx: new Set(), keySets: new Map(), guaranteed: new Set(parent.guaranteed) };
}

function walk(r: Run, file: FileScan, from: number, to: number, bind: Bind, depth: number): void {
  if (depth > 20) {
    r.notes.push('递归深度超限（可能有环）');
    return;
  }
  const toks = file.toks;
  // 本区间的同名遮蔽：嵌套具名定义里形参重名 ⇒ 其体内不算外层 flow。
  const shadow: { start: number; end: number; names: Set<string> }[] = file.defs
    .filter((d) => d.bodyStart > from && d.bodyEnd <= to && d.paramNames.some((p) => bind.flow.has(p)))
    .map((d) => ({ start: d.bodyStart, end: d.bodyEnd, names: new Set(d.paramNames.filter((p) => bind.flow.has(p))) }));
  for (let i = from; i <= to; i += 1) {
    const t = toks[i]!;
    if (t.t !== 'id') continue;
    if (shadow.some((s) => i >= s.start && i <= s.end && s.names.has(t.v))) continue;
    if (bind.ctx.has(t.v)) {
      // ctx 只有 `.args` 这一条路能碰 args；其它成员读的是**调用点算好的派生值**，
      // 那些值自己是不是从 args 来的，已在调用点逐条分类过 ⇒ 记 ctx-member（不是取用、也不红）。
      if (toks[i + 1]?.v === '.' && toks[i + 2]?.v === 'args') {
        i = classify(r, file, i + 2, to, bind, depth) ?? i;
        continue;
      }
      if (toks[i + 1]?.v === '.' && toks[i + 2]?.t === 'id') {
        site(r, file, i, 'ctx-member', snippet(file, i, i + 2), [], `上下文对象成员 .${toks[i + 2]!.v}（值来自调用点，已在那一侧分类）`);
        continue;
      }
      site(r, file, i, 'unresolved', snippet(file, i), [], 'ctx 对象用在成员访问之外（形态需人工确认）');
      continue;
    }
    if (!bind.flow.has(t.v)) continue;
    classify(r, file, i, to, bind, depth);
  }
}

/** 分类一次 flow 出现；返回新的扫描位置（null＝不改变外层位置）。 */
function classify(r: Run, file: FileScan, i: number, regionEnd: number, bind: Bind, depth: number): number | null {
  const toks = file.toks;
  const close = file.close;
  const open = file.open;
  const name = toks[i]!.v;
  const next = toks[i + 1];
  const prev = toks[i - 1];

  // ① 下标取键：`args['k']` / `args?.['k']` / `(args ?? {})['k']`
  const bAt = next && next.v === '[' ? i + 1 : next && next.v === '?.' && toks[i + 2]?.v === '[' ? i + 2 : -1;
  if (bAt >= 0) return classifyBracket(r, file, i, bAt, bind);

  // ② 点取键：`args.k` / `args?.k`
  const dotAt = next && next.v === '.' ? i + 1 : next && next.v === '?.' && toks[i + 2]?.t === 'id' ? i + 1 : -1;
  if (dotAt >= 0) return classifyMember(r, file, i, dotAt, bind);

  // ③ spread（形态 7）：`{ ...args, maxResults }` 交给某个被调
  if (prev && prev.v === '...') {
    const container = file.enclosed[i] ?? -1;
    if (container >= 0 && toks[container]?.v === '{') {
      const cc = close[container]!;
      const guaranteed: string[] = [];
      for (const [a] of splitTop(toks, container, cc)) {
        const f = toks[a]!;
        if (a === i - 1) continue;
        if (f.t === 'id') guaranteed.push(f.v);
      }
      for (const g of guaranteed) bind.guaranteed.add(g);
      const ownerParen = idxAt(file.enclosed, container);
      const opClose = ownerParen >= 0 ? idxAt(close, ownerParen) : -1;
      const target = ownerParen >= 0 && opClose >= 0 && toks[ownerParen]?.v === '(' ? resolveCallee(r, file, ownerParen) : null;
      if (target) {
        site(r, file, i, 'spread-handoff', snippet(file, i - 1, cc), guaranteed, `${target.label}（显式覆写 ${guaranteed.join('/') || '无'} 必然有值）`);
        enterTarget(r, target, argIndexOf(toks, ownerParen, opClose, container), 'flow', bind, depth);
      } else {
        site(r, file, i, 'unresolved', snippet(file, i - 1, cc), guaranteed, 'spread 出的对象没有接到可解析的目标');
      }
      return cc;
    }
    site(r, file, i, 'unresolved', snippet(file, i), [], 'spread 的容器不是对象字面量');
    return i;
  }

  // ④ 解构（形态 5）：`const { a, b: c } = args`
  if (prev && prev.v === '=' && toks[i - 2]?.v === '}') {
    const ob = idxAt(open, i - 2);
    if (ob > 0 && toks[ob]?.v === '{') {
      const keys: string[] = [];
      for (const [a] of splitTop(toks, ob, i - 2)) {
        const f = toks[a]!;
        if (f.t === 'id') keys.push(f.v);
        else site(r, file, i, 'unresolved', snippet(file, i), [], '解构里出现非标识符形态');
      }
      site(r, file, i, 'destructure', snippet(file, ob, i), keys);
      return i;
    }
  }

  // ⑤ 别名（形态 4）：`const input = args [?? {}]`
  if (prev && prev.v === '=' && toks[i - 3] && ['const', 'let', 'var'].includes(toks[i - 3]!.v) && toks[i - 2]?.t === 'id') {
    const alias = toks[i - 2]!.v;
    bind.flow.add(alias);
    site(r, file, i, 'alias', snippet(file, i - 3, i), [], `别名 ${alias}`);
    return i;
  }

  // ⑥ 整只对象交接 / 对象字面量键位 / 分组括号
  const endTok = skipNullish(toks, i);
  const own = idxAt(file.enclosed, i);
  const parent = own >= 0 ? own : idxAt(file.enclosed, endTok);
  const parentClose = parent >= 0 ? idxAt(close, parent) : -1;
  if (parent >= 0 && parentClose >= 0 && toks[parent]?.v === '{' && prev?.v === ':' && toks[i - 2]?.v === 'args') {
    // ⑥b 整只对象装进上下文对象再交出去（形态 8）：`runner({ args: args ?? {}, … })`
    const cc = parentClose;
    const ownerParen = idxAt(file.enclosed, parent);
    const opClose = ownerParen >= 0 ? idxAt(close, ownerParen) : -1;
    const target = ownerParen >= 0 && opClose >= 0 && toks[ownerParen]?.v === '(' ? resolveCallee(r, file, ownerParen) : null;
    if (target) {
      site(r, file, i, 'ctx-handoff', snippet(file, parent, cc), [], target.label);
      enterTarget(r, target, argIndexOf(toks, ownerParen, opClose, parent), 'ctx', bind, depth);
    } else {
      site(r, file, i, 'unresolved', snippet(file, parent, cc), [], '装了 args 的对象字面量没交给可解析的目标');
    }
    return cc;
  }
  if (parent >= 0 && parentClose >= 0 && toks[parent]?.v === '{' && next?.v === ':' && startsSegment(toks, parent, parentClose, i)) {
    // ⑥c 对象字面量的**键位**（`{ args: … }` 左边那枚）：那是属性名，不是取用 ⇒ 无站点
    return i;
  }
  // ⑥d 分组括号：`(args ?? {})['maxDepth']` / `(args ?? {}).scope` ⇒ 仍是「取键」，不是整只交接；
  //     `(f(args ?? {}))` 一类纯冗余括号 ⇒ 剥掉后按外层容器继续判。
  const atom = peelGroups(r, file, i, endTok, bind);
  if (atom.bracketAt >= 0) return classifyBracket(r, file, i, atom.bracketAt, bind, atom.end);
  if (atom.dotAt >= 0) return classifyMember(r, file, i, atom.dotAt, bind, atom.end);
  if (atom.parenIdx >= 0) {
    const pc = close[atom.parenIdx]!;
    // B25 落地批：`Object.keys(x)` / `Object.hasOwn(x,'k')` / `Object.getOwnPropertyNames(x)`
    // 是**形状内省**——只碰键名、从不读值 ⇒ 既不构成取用、也不算整只交接。
    // （fs.readFileBytes 的防旁路守卫用 `Object.keys(input).includes('rootId')` 表达
    //   「守卫不取用」；此前这里被误报成 unresolved。values/entries 会遍历值 ⇒ 仍按未知处理。）
    const cname = toks[atom.parenIdx - 1]?.v;
    const objName = toks[atom.parenIdx - 3]?.v;
    if (cname && objName === 'Object' && OBJECT_INTROSPECTION_STATICS.has(cname)) {
      site(r, file, i, 'introspect', snippet(file, i, atom.end), [], `Object.${cname}（形状内省，不读值 ⇒ 非取用）`);
      return pc;
    }
    const seg = siblingOf(toks, atom.parenIdx, pc, atom.end);
    if (seg && seg[1] === atom.end) {
      const target = resolveCallee(r, file, atom.parenIdx);
      if (target) {
        const idx = argIndexOf(toks, atom.parenIdx, pc, i);
        site(r, file, i, 'handoff', snippet(file, i, atom.end), [], target.label);
        enterTarget(r, target, idx, 'flow', bind, depth);
      } else {
        site(r, file, i, 'unresolved', `${snippet(file, i, atom.end)} @${toks[atom.parenIdx - 1]?.v ?? '?'}`, [], '整只 args 交给解析不到的目标');
      }
      return pc;
    }
  }

  // ⑦ 存在性判断（不指认键名）
  if (isPresenceCheck(toks, i)) {
    site(r, file, i, 'presence', snippet(file, i - 1, i + 2), [], '整只对象的存在性判断');
    return i;
  }

  site(r, file, i, 'unresolved', snippet(file, i - 2, endTok + 1), [], '这一处 args 用法不在认得的形态里');
  return i;
  void regionEnd;
}

/** 中括号取键（形态 1）：`EXPR['lit']` / `EXPR[dyn]`（dyn 能静态展开才认，否则红）。 */
function classifyBracket(r: Run, file: FileScan, from: number, at: number, bind: Bind, to?: number): number {
  const toks = file.toks;
  const close = file.close;
  const bc = close[at];
  const expr = to === undefined ? snippet(file, from) : snippet(file, from, to);
  if (bc === undefined || bc < 0) {
    site(r, file, from, 'unresolved', expr, [], '中括号未配对（词法判读失败）');
    return at;
  }
  const inner = toks.slice(at + 1, bc);
  if (inner.length === 1 && inner[0]!.t === 'str') {
    site(r, file, from, 'key', expr, [inner[0]!.v]);
    return bc;
  }
  if (inner.length === 1 && inner[0]!.t === 'id') {
    const ks = bind.keySets.get(inner[0]!.v);
    if (ks && ks.keys.length > 0) {
      if (ks.shortCircuit) {
        // 共用页大小闸：第一个「必然有值」的别名之后取用不到
        const cut = ks.keys.findIndex((k) => bind.guaranteed.has(k));
        const taken = cut < 0 ? ks.keys : ks.keys.slice(0, cut + 1);
        const pruned = cut < 0 ? [] : ks.keys.slice(cut + 1);
        site(r, file, from, 'key', expr, taken, `短路展开（${inner[0]!.v}）` + (pruned.length ? `；取用不到：${pruned.join('/')}` : ''));
      } else {
        site(r, file, from, 'key', expr, ks.keys, `动态键经绑定展开：${inner[0]!.v}`);
      }
      return bc;
    }
    site(r, file, from, 'unresolved', expr, [], `动态键 '${inner[0]!.v}' 的绑定判不出来`);
    return bc;
  }
  site(r, file, from, 'unresolved', expr, [], '中括号内不是可静态判定的单键');
  return bc;
}

/** 成员取键（形态 2）：`EXPR.lit` / `EXPR?.lit`。方法调用与动态成员不认 ⇒ 红。 */
function classifyMember(r: Run, file: FileScan, from: number, dotAt: number, bind: Bind, to?: number): number {
  const toks = file.toks;
  const key = toks[dotAt + 1]!;
  const expr = to === undefined ? snippet(file, from) : snippet(file, from, to);
  if (key.t !== 'id') {
    site(r, file, from, 'unresolved', expr, [], `.${key.v} 之后不是成员名`);
    return dotAt + 1;
  }
  if (toks[dotAt + 2]?.v === '(') {
    site(r, file, from, 'unresolved', expr, [], `args 上的方法调用 '.${key.v}()' 不认`);
    return dotAt + 1;
  }
  if (toks[dotAt + 2]?.v === '[') {
    site(r, file, from, 'unresolved', expr, [], `args 上的动态成员 '.${key.v}[…]' 不认`);
    return dotAt + 1;
  }
  site(r, file, from, 'key', expr, [key.v]);
  return dotAt + 1;
}

const NON_CALLEE_BEFORE = new Set(['(', ',', ':', '=', '=>', '[', '!', '&', '|', '?', '{', '}', ';', '??', '||', '&&', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '...', '`']);
const NON_CALLEE_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'case', 'if', 'for', 'while', 'switch', 'do', 'else', 'throw', 'await', 'yield', 'void', 'delete', 'function', 'const', 'let', 'var', 'export', 'import', 'default', 'extends']);

/** 这枚 `(` 是**调用**括号还是**分组**括号：前面没有可担当被调的表达式 ⇒ 分组。 */
function isCallParen(file: FileScan, parenIdx: number): boolean {
  const toks = file.toks;
  const b = toks[parenIdx - 1];
  if (!b) return false;
  if (b.t === 'id') return !NON_CALLEE_KEYWORDS.has(b.v);
  if (b.t === 'str' || b.t === 'num') return true;
  if (b.v === ')' || b.v === ']' || b.v === '}' || b.v === '`' || b.v === '.') return true;
  if (b.v === '?.') {
    const c = toks[parenIdx - 2];
    return c?.t === 'id' && !NON_CALLEE_KEYWORDS.has(c.v);
  }
  return !NON_CALLEE_BEFORE.has(b.v);
}

function startsSegment(toks: Tok[], containerOpen: number, containerClose: number, idx: number): boolean {
  for (const [a] of splitTop(toks, containerOpen, containerClose)) if (a === idx) return true;
  return false;
}

/**
 * 从 `args`（或 `args ?? {}`）这一枚**原子**往外剥冗余分组括号：
 * 返回紧跟其后的 `[`（下标取键）/ `.`（成员取键）/ 或真正把整只对象吃下去的**调用**括号。
 * 分组括号（`(args ?? {})[…]`）原先一律被判成「整只交给解析不到的目标」，那是假红也是假绿：
 * 假红在闸面上，假绿在取用集里（那一枚键根本没登记）。
 */
function peelGroups(r: Run, file: FileScan, i: number, endTok: number, bind: Bind): { bracketAt: number; dotAt: number; parenIdx: number; end: number } {
  const toks = file.toks;
  const close = file.close;
  void r;
  void bind;
  let end = endTok;
  const own = idxAt(file.enclosed, i);
  let container = own >= 0 ? own : idxAt(file.enclosed, end);
  for (let guard = 0; guard < 6; guard += 1) {
    if (container < 0) break;
    if (toks[container]?.v !== '(') break;
    if (!isCallParen(file, container)) {
      // 分组括号：看它右界后面跟的是什么
      const pc = idxAt(close, container);
      if (pc < 0) break;
      const after = toks[pc + 1]?.v;
      if (after === '[') return { bracketAt: pc + 1, dotAt: -1, parenIdx: -1, end: pc };
      if (after === '.' || (after === '?.' && toks[pc + 2]?.t === 'id')) return { bracketAt: -1, dotAt: pc + 1, parenIdx: -1, end: pc };
      end = pc;
      container = idxAt(file.enclosed, container);
      continue;
    }
    // 调用括号 ⇒ 整只对象就在这枚调用的实参位上
    return { bracketAt: -1, dotAt: -1, parenIdx: container, end };
  }
  return { bracketAt: -1, dotAt: -1, parenIdx: -1, end };
}

const TYPE_PRIMITIVES = new Set(['void', 'string', 'number', 'boolean', 'unknown', 'any', 'never', 'object', 'symbol', 'null', 'undefined']);

/** `=> 类型` 的右端（类型标注，不是箭头定义体）。 */
function looksLikeTypeBody(toks: Tok[], i: number): boolean {
  const t = toks[i];
  if (!t || t.t !== 'id') return false;
  if (toks[i + 1]?.v === '<') return true; // `Promise<unknown>` 这类泛型引用
  if (TYPE_PRIMITIVES.has(t.v)) return true;
  return false;
}

function skipNullish(toks: Tok[], i: number): number {
  if (toks[i + 1]?.v === '??' && toks[i + 2]?.v === '{' && toks[i + 3]?.v === '}') return i + 3;
  if (toks[i + 1]?.v === '??' && toks[i + 2]?.t === 'id') return i + 2;
  return i;
}

function isPresenceCheck(toks: Tok[], i: number): boolean {
  const prev = toks[i - 1];
  const next = toks[i + 1];
  if (prev?.v === '!') return true;
  if (prev?.v === '!' && toks[i - 2]?.v === '(') return true;
  if (prev?.t === 'id' && prev.v === 'typeof') return true;
  if (next && (next.v === '===' || next.v === '==' || next.v === '!==')) {
    const rhs = toks[i + 2];
    return rhs?.t === 'id' && (rhs.v === 'undefined' || rhs.v === 'null');
  }
  return false;
}

function siblingOf(toks: Tok[], parentOpen: number, parentClose: number, idx: number): [number, number] | null {
  for (const [a, b] of splitTop(toks, parentOpen, parentClose)) if (idx >= a && idx <= b) return [a, b];
  return null;
}

function argIndexOf(toks: Tok[], parentOpen: number, parentClose: number, idx: number): number {
  const segs = splitTop(toks, parentOpen, parentClose);
  for (let n = 0; n < segs.length; n += 1) {
    const [a, b] = segs[n]!;
    if (idx >= a && idx <= b) return n;
  }
  return 0;
}

/** 一次交接的目标：被调定义 + 调用点（用来把字面量实参喂给被调形参的动态键位）。 */
interface CalleeTarget {
  readonly label: string;
  /** 被调定义所在文件。 */
  readonly file: FileScan;
  readonly def: FuncDef;
  /** 调用点所在文件 + 那枚 `(` 的 token 下标。 */
  readonly caller: FileScan;
  readonly parenOpen: number;
}

/**
 * 解析 `(` 之前的被调表达式：
 *  - `F(…)`：同文件具名定义 → const 绑定链 → `@kojo/mcp-host` 具名导入 → 其它文件同名定义；
 *  - `G(deps)(…)`：把 `G(deps)` 当工厂，取它「函数体只有一条 return 箭头」的那条箭头；
 *  - `EXPR.m(…)`：成员交接 ⇒ 只认挂账（`cfg.handoffs`），挂账给出目标文件 + 符号。
 */
/** `Object.*` 里只碰键名、不读值的形状内省静态（B25 落地批新增识别；values/entries 遍历值 ⇒ 刻意不收）。 */
const OBJECT_INTROSPECTION_STATICS: ReadonlySet<string> = new Set(['keys', 'hasOwn', 'getOwnPropertyNames']);

function resolveCallee(r: Run, file: FileScan, parenOpen: number): CalleeTarget | null {
  const toks = file.toks;
  const before = parenOpen - 1;
  const t = toks[before];
  if (!t) return null;
  if (t.t === 'id') {
    if (toks[before - 1]?.v === '.' || toks[before - 1]?.v === '?.') {
      const led = matchHandoffLedger(r, file, before);
      if (!led) return null;
      const hit = findDef(r.files, led.targetFile, led.targetSymbol);
      if (!hit) {
        r.problems.push(`挂账 ${led.id} 的目标 ${led.targetFile}#${led.targetSymbol} 解析不到（腿已改道 ⇒ 挂账要跟着改）`);
        return null;
      }
      r.hitLedgers.add(led.id);
      return { label: `挂账 ${led.id} → ${hit.file.rel.split('/').pop()}#${led.targetSymbol}`, file: hit.file, def: hit.def, caller: file, parenOpen };
    }
    const hit = findDef(r.files, file.rel, t.v);
    if (!hit) return null;
    return { label: `${file.rel.split('/').pop()}#${t.v}`, file: hit.file, def: hit.def, caller: file, parenOpen };
  }
  if (t.v === ')') {
    const inner = idxAt(file.open, before);
    if (inner < 0) return null;
    const calleeTok = toks[inner - 1];
    if (!calleeTok || calleeTok.t !== 'id') return null;
    const leg = singleReturnArrow(r.files, file.rel, calleeTok.v);
    if (!leg) return null;
    return { label: `${calleeTok.v}→单return箭头`, file: leg.file, def: leg.def, caller: file, parenOpen };
  }
  return null;
}

function matchHandoffLedger(r: Run, file: FileScan, nameIdx: number): HandoffLedgerEntry | null {
  const line = lineIndexOf(file.src, file.toks[nameIdx]!.s);
  const text = file.src.split('\n')[line - 1] ?? '';
  for (const led of r.cfg.handoffs) {
    if (led.file !== file.rel) continue;
    if (r.hitLedgers.has(led.id)) continue;
    if (!text.includes(led.anchor)) continue;
    return led;
  }
  return null;
}

/** 进入交接目标继续扫：按位置绑 flow / ctx，并把字面量实参绑成动态键集合。 */
function enterTarget(
  r: Run,
  target: CalleeTarget,
  argIdx: number,
  mode: 'flow' | 'ctx',
  bind: Bind,
  depth: number,
): void {
  const key = `${r.face}|${target.file.rel}|${target.def.name ?? '?'}|${target.def.bodyStart}|${argIdx}|${mode}`;
  if (r.visited.has(key)) return;
  const pname = target.def.paramNames[argIdx];
  if (!pname) {
    r.problems.push(`${r.face}: 交给 ${target.label} 的第 ${argIdx} 个位置在其形参表里不存在（${target.def.paramNames.join(', ') || '空'}）`);
    return;
  }
  r.visited.add(key);
  // Bind 是只读结构：交接后的新绑定一次性构造（flow / ctx 按 mode 二选一，guaranteed 继承调用点）
  const nb: Bind = mode === 'ctx'
    ? { flow: new Set<string>(), ctx: new Set([pname]), keySets: new Map(), guaranteed: new Set(bind.guaranteed) }
    : { flow: new Set([pname]), ctx: new Set(), keySets: new Map(), guaranteed: new Set(bind.guaranteed) };
  // 其它位置上的字面量实参 ⇒ 被调形参的动态键候选集（`requireId(args, 'instanceId', …)`）
  const callerToks = target.caller.toks;
  const callerClose = target.caller.close;
  const pc = callerClose[target.parenOpen]!;
  const callerSegs = splitTop(callerToks, target.parenOpen, pc);
  callerSegs.forEach(([a, b], n) => {
    if (n === argIdx) return;
    const ks = literalKeySet(callerToks, bind, a, b);
    const pn = target.def.paramNames[n];
    if (ks && pn) nb.keySets.set(pn, ks);
  });
  prebindKeySets(r, target.file, target.def.bodyStart, target.def.bodyEnd, nb);
  walk(r, target.file, target.def.bodyStart, target.def.bodyEnd, nb, depth + 1);
  r.visited.delete(key);
}

function bindHome(_r: Run, target: CalleeTarget): string {
  return target.file.rel;
}

/** 实参位置上的字面量键集合：单个字符串字面量 / 已绑定的循环变量 / 字符串数组字面量。 */
function literalKeySet(toks: Tok[], bind: Bind, a: number, b: number): KeySet | null {
  if (a === b) {
    const t = toks[a]!;
    if (t.t === 'str') return { keys: [t.v] };
    if (t.t === 'id') {
      const ks = bind.keySets.get(t.v);
      if (ks) return ks;
    }
    return null;
  }
  if (toks[a]?.v === '[') {
    const keys: string[] = [];
    for (const [x, y] of splitTop(toks, a, b)) {
      if (x === y && toks[x]!.t === 'str') keys.push(toks[x]!.v);
    }
    if (keys.length > 0) return { keys };
  }
  return null;
}

interface DefHit {
  readonly file: FileScan;
  readonly def: FuncDef;
}

function findDef(files: Map<string, FileScan>, homeRel: string, name: string): DefHit | null {
  const home = files.get(homeRel);
  if (home) {
    const d = home.defs.find((x) => x.name === name);
    if (d) return { file: home, def: d };
    const bind = home.constBind.get(name);
    if (bind) {
      if (bind.kind === 'fn') {
        const d = home.defs.find((x) => x.name === name);
        if (d) return { file: home, def: d };
      }
      if (bind.kind === 'factory') {
        const leg = singleReturnArrow(files, homeRel, bind.callee);
        if (leg) return leg;
        const f = findDefAcrossFiles(files, bind.callee);
        if (f) return f;
      }
      if (bind.kind === 'member') {
        const p = propOfFactoryReturn(files, homeRel, bind.source, bind.prop);
        if (p) return p;
      }
      if (bind.kind === 'destructure') {
        const prop = bind.props.get(name) ?? name;
        const p = propOfFactoryReturn(files, homeRel, bind.source, prop);
        if (p) return p;
      }
    }
    // 同文件找不到 ⇒ 具名导入：`@kojo/mcp-host` 在宇宙里 ⇒ 解析到宿主源码；别的外部模块 ⇒ 解析不到（红）
    const mod = home.imports.get(name);
    if (mod && mod !== '@kojo/mcp-host') return null;
    if (mod === '@kojo/mcp-host') {
      const inHost = files.get('packages/mcp-host/src/index.ts')?.defs.find((x) => x.name === name);
      if (inHost) return { file: files.get('packages/mcp-host/src/index.ts')!, def: inHost };
      return null;
    }
  }
  return null;
}

function findDefAcrossFiles(files: Map<string, FileScan>, name: string): DefHit | null {
  const hits: DefHit[] = [];
  for (const f of files.values()) {
    const d = f.defs.find((x) => x.name === name);
    if (d) hits.push({ file: f, def: d });
  }
  if (hits.length === 1) return hits[0]!;
  return null;
}

/** 函数体只有一条 `return <箭头>` 的工厂 ⇒ 那条箭头（结构判定，不靠 defs 收集顺序）。 */
function singleReturnArrow(files: Map<string, FileScan>, homeRel: string, factory: string, seen: number = 0): DefHit | null {
  if (seen > 6) return null;
  const f = findDefAcrossFiles(files, factory) ?? findDef(files, homeRel, factory);
  if (!f) return null;
  const ret = topReturnIndex(f.file, f.def);
  if (ret < 0) return null;
  const arrow = returnArrowAt(f.file, ret);
  if (arrow) return { file: f.file, def: arrow };
  // `return OTHER(deps)`：再穿一层工厂
  const callee = returnCalleeName(f.file, ret);
  if (callee) return singleReturnArrow(files, f.file.rel, callee, seen + 1);
  return null;
}

/** 函数体第一层恰好一条 `return` ⇒ 其 token 下标；多于一或没有 ⇒ -1。 */
function topReturnIndex(file: FileScan, def: FuncDef): number {
  const toks = file.toks;
  let depth = 0;
  let ret = -1;
  for (let i = def.bodyStart; i <= def.bodyEnd; i += 1) {
    const v = toks[i]!.v;
    if (v === '{' || v === '(' || v === '[' || v === '${') {
      depth += 1;
      continue;
    }
    if (v === '}' || v === ')' || v === ']') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && toks[i]!.t === 'id' && toks[i]!.v === 'return') {
      if (ret >= 0) return -1;
      ret = i;
    }
  }
  return ret;
}

/** `return` 之后那条箭头表达式（`async (…) => {}` / `(…) => {}`）。 */
function returnArrowAt(file: FileScan, ret: number): FuncDef | null {
  const toks = file.toks;
  let j = ret + 1;
  if (toks[j]?.v === 'async') j += 1;
  if (toks[j]?.v !== '(') return null;
  const paramOpen = j;
  const paramClose = file.close[paramOpen]!;
  if (paramClose < 0) return null;
  let k = paramClose + 1;
  while (k < toks.length && toks[k]!.v !== '=>' && toks[k]!.v !== '{' && toks[k]!.v !== ';') k += 1;
  if (toks[k]?.v !== '=>') return null;
  const body = k + 1;
  if (toks[body]?.v === '{') {
    const bc = file.close[body]!;
    if (bc < 0) return null;
    return { name: null, paramNames: paramNamesOf(toks, paramOpen, paramClose), bodyStart: body + 1, bodyEnd: bc - 1 };
  }
  return { name: null, paramNames: paramNamesOf(toks, paramOpen, paramClose), bodyStart: body, bodyEnd: exprBodyEnd(toks, k, body) };
}

/** `return OTHER(deps)` 的工厂名（没有则 null）。 */
function returnCalleeName(file: FileScan, ret: number): string | null {
  const toks = file.toks;
  let j = ret + 1;
  if (toks[j]?.v === 'await') j += 1;
  if (toks[j]?.t !== 'id') return null;
  return toks[j + 1]?.v === '(' ? toks[j]!.v : null;
}

function onlyFactoryCallReturn(file: FileScan, def: FuncDef): string | null {
  const ret = topReturnIndex(file, def);
  if (ret < 0) return null;
  return returnCalleeName(file, ret);
}

/** 工厂返回对象字面量里的某个属性 ⇒ 该属性背后的定义。 */
function propOfFactoryReturn(
  files: Map<string, FileScan>,
  homeRel: string,
  factory: string,
  prop: string,
  seen: number = 0,
): DefHit | null {
  if (seen > 5) return null;
  // `factory` 可能是「工厂结果的局部别名」：`const launcherLegs = createLauncherLegs(…)`
  const home = files.get(homeRel);
  let target = factory;
  for (let guard = 0; guard < 4; guard += 1) {
    const b = home?.constBind.get(target);
    if (b?.kind === 'factory') target = b.callee;
    else break;
  }
  const f = findDefAcrossFiles(files, target) ?? findDef(files, homeRel, target);
  if (!f) return null;
  const props = returnedObjectProps(f.file, f.def);
  if (props) {
    const ref = props.get(prop);
    if (!ref) return null;
    if (ref.kind === 'call') {
      const leg = singleReturnArrow(files, f.file.rel, ref.value);
      if (leg) return leg;
      return findDef(files, f.file.rel, ref.value);
    }
    const d = findDef(files, f.file.rel, ref.value);
    if (d) return d;
    return resolveLoose(files, f.file.rel, ref.value, seen);
  }
  // 工厂把接力交给另一个工厂：`return OTHER(deps)`
  const inner = onlyFactoryCallReturn(f.file, f.def);
  if (inner) return propOfFactoryReturn(files, f.file.rel, inner, prop, seen + 1);
  return null;
}

/** 兜底解析链：同文件 const 绑定（工厂 / 解构 / 成员）→ 定义表。 */
function resolveLoose(files: Map<string, FileScan>, homeRel: string, name: string, seen: number): DefHit | null {
  if (seen > 6) return null;
  const home = files.get(homeRel);
  const b = home?.constBind.get(name);
  if (!b) return null;
  if (b.kind === 'fn') return findDef(files, homeRel, name);
  if (b.kind === 'factory') return singleReturnArrow(files, homeRel, b.callee) ?? findDefAcrossFiles(files, b.callee);
  if (b.kind === 'member') return propOfFactoryReturn(files, homeRel, b.source, b.prop, seen + 1);
  if (b.kind === 'destructure') {
    const prop = b.props.get(name) ?? name;
    return propOfFactoryReturn(files, homeRel, b.source, prop, seen + 1);
  }
  return null;
}

type PropRef = { readonly kind: 'ident' | 'call'; readonly value: string };

function returnedObjectProps(file: FileScan, def: FuncDef): Map<string, PropRef> | null {
  const toks = file.toks;
  const close = file.close;
  const ret = topReturnIndex(file, def);
  if (ret < 0) return null;
  let j = ret + 1;
  if (toks[j]?.v === 'await') j += 1;
  if (toks[j]?.v !== '{') return null;
  const bc = close[j]!;
  if (bc < 0) return null;
  const out = new Map<string, PropRef>();
  for (const [a] of splitTop(toks, j, bc)) {
    const f = toks[a]!;
    if (f.t !== 'id') continue;
    if (toks[a + 1]?.v === ':') {
      const v = toks[a + 2];
      if (v?.t === 'id') out.set(f.v, { kind: toks[a + 3]?.v === '(' ? 'call' : 'ident', value: v.v });
    } else out.set(f.v, { kind: 'ident', value: f.v });
  }
  return out;
}

/* ------------------------------- 循环里的动态键绑定 ------------------------------- */

/**
 * 在进入区间之前，先把「区间内的 for-of 循环变量 → 字面量键集合」登记好：
 *  - `for (const key of ['a','b'] as const)`；
 *  - `for (const alias of PAGE_SIZE_ARG_ALIASES)`（跨文件解该常量的数组字面量，带短路语义）。
 * 这些循环体内 `args[key]` 才能展开；判不出来的动态键在分类支里红。
 */
function prebindKeySets(r: Run, file: FileScan, from: number, to: number, bind: Bind): void {
  const toks = file.toks;
  for (let i = from; i <= to; i += 1) {
    const t = toks[i]!;
    if (t.t !== 'id' || t.v !== 'for') continue;
    let j = i + 1;
    if (toks[j]?.v !== '(') continue;
    const pc = file.close[j]!;
    if (pc < 0) continue;
    const ofIdx = firstIdxOf(toks, j + 1, pc, 'of');
    // `for (const key of …)`：`for` 的下一颗是 `(`，关键字在 j+1、循环变量在 j+2
    const kw = toks[j + 1];
    const varTok = toks[j + 2];
    const varName = kw?.t === 'id' && ['const', 'let', 'var'].includes(kw.v) && varTok?.t === 'id' ? varTok.v : null;
    if (!varName || ofIdx < 0) continue;
    const listTok = toks[ofIdx + 1];
    if (!listTok) continue;
    if (listTok.v === '[') {
      const bc = file.close[ofIdx + 1];
      if (bc === undefined || bc < 0) continue;
      const keys = strLiterals(toks, ofIdx + 1, bc);
      if (keys.length > 0) addKeySet(bind, varName, keys, false);
      i = pc;
      continue;
    }
    if (listTok.t === 'id') {
      const keys = aliasConstKeys(r.files, listTok.v);
      if (keys) {
        addKeySet(bind, varName, keys, listTok.v === ALIAS_CONST);
        i = pc;
        continue;
      }
      // 判不出来的循环源 ⇒ 不静默：这个循环变量当键用时就红（形态 3 的 unresolved 支）
      r.notes.push(`for-of 的集合源 '${listTok.v}' 不是可静态展开的字面量清单（循环变量 ${varName} 的动态键会红）`);
    }
    i = pc;
  }
}

/** 登记「循环变量 ⇒ 字面量键集合」；同名多次出现取并集（读法只在这些键里发生，不会外溢）。 */
function addKeySet(bind: Bind, name: string, keys: readonly string[], shortCircuit: boolean): void {
  const prev = bind.keySets.get(name);
  const merged = [...new Set([...(prev?.keys ?? []), ...keys])];
  bind.keySets.set(name, { keys: merged, shortCircuit: shortCircuit || prev?.shortCircuit === true });
}

function firstIdxOf(toks: Tok[], from: number, to: number, v: string): number {
  for (let i = from; i <= to; i += 1) if (toks[i]!.v === v) return i;
  return -1;
}

function strLiterals(toks: Tok[], open: number, closeIdx: number): string[] {
  const out: string[] = [];
  for (const [a, b] of splitTop(toks, open, closeIdx)) {
    if (a === b && toks[a]!.t === 'str') out.push(toks[a]!.v);
  }
  return out;
}

function aliasConstKeys(files: Map<string, FileScan>, name: string): string[] | null {
  for (const f of files.values()) {
    const toks = f.toks;
    for (let i = 0; i < toks.length - 3; i += 1) {
      const t = toks[i]!;
      if (t.t === 'id' && t.v === 'const' && toks[i + 1]?.v === name && toks[i + 2]?.v === '=') {
        const arr = toks[i + 3];
        if (arr?.v === '[') {
          const bc = f.close[i + 3]!;
          const keys = strLiterals(toks, i + 3, bc);
          if (keys.length > 0) return keys;
        }
      }
    }
  }
  return null;
}

/* ------------------------------- 驱动 ------------------------------- */

export interface HandoffLedgerEntry {
  readonly id: string;
  readonly file: string;
  /** 匹配锚：那一行源码必须含这串（行号漂了 ⇒ 挂账失效 ⇒ 红）。 */
  readonly anchor: string;
  readonly targetFile: string;
  readonly targetSymbol: string;
  readonly reason: string;
}

export interface ScanConfig {
  /** 派生腿表覆盖不到的面 → 执行体（文件 + 符号），逐条点名。 */
  readonly entries: Readonly<Record<string, { file: string; symbol: string }>>;
  /** 没有执行腿的面（NOT_WIRED）：逐条理由。 */
  readonly notWired: Readonly<Record<string, string>>;
  readonly handoffs: readonly HandoffLedgerEntry[];
}
export interface CorpusScan {
  readonly faces: Map<string, FaceScan>;
  readonly derivedEntries: Map<string, { file: string; symbol: string }>;
  readonly hitLedgers: readonly string[];
  readonly problems: readonly string[];
  readonly fileStats: readonly { rel: string; toks: number; defs: number }[];
  readonly aliasConstFromSource: readonly string[];
}

/**
 * 扫全部在册面：`faces` ＝注册表里的工具名全集（由调用方从契约表现场取）。
 * 每一枚的执行体先走**派生腿表**（源码里的 `new Map([ ['工具名', 标识符] … ])`），
 * 派生不到才用挂账入口；两者都没有 ⇒ `no-entry`（红，不静默）。
 */
export function scanCorpus(faces: readonly string[], cfg: ScanConfig, root: string = REPO_ROOT): CorpusScan {
  const files = new Map<string, FileScan>();
  for (const rel of LEG_CORPUS) files.set(rel, buildFile(rel, root));
  const derivedHits = new Map<string, DefHit>();
  const derivedEntries = new Map<string, { file: string; symbol: string }>();
  for (const [rel, f] of files) {
    for (const e of f.legTables) {
      const hit = findDef(files, rel, e.ident);
      if (hit) {
        derivedHits.set(e.face, hit);
        derivedEntries.set(e.face, { file: hit.file.rel, symbol: hit.def.name ?? `${e.ident}(匿名箭头)` });
      } else {
        derivedEntries.set(e.face, { file: `${rel}#未解析`, symbol: e.ident });
      }
    }
  }
  const scanned = new Map<string, FaceScan>();
  const problems: string[] = [];
  const hitLedgers = new Set<string>();
  for (const face of faces) {
    if (cfg.notWired[face]) continue;
    const derived = derivedHits.get(face);
    const ledger = cfg.entries[face];
    if (!derived && !ledger) {
      problems.push(`${face}: 派生腿表与挂账入口里都没有执行体（新面不许静默游离于闸外）`);
      continue;
    }
    const hit = derived ?? (ledger ? findDef(files, ledger.file, ledger.symbol) : null);
    if (!hit) {
      problems.push(`${face}: 执行体解析失败（${ledger ? `${ledger.file}#${ledger.symbol}` : '派生腿表里的标识符解不到定义'}）`);
      continue;
    }
    const r: Run = { files, face, sites: [], notes: [], visited: new Set(), problems, hitLedgers, cfg };
    const bind = newBind(hit.def.paramNames[0]);
    if (!hit.def.paramNames[0]) {
      // 真零参腿（`async () => …`）：取用集就是空，由闸的「在册但腿不取用」侧去要挂账
      r.notes.push('执行体不接收入参对象（真零参腿）');
    } else if (!ARGS_PARAM.test(hit.def.paramNames[0])) {
      // 执行体第一形参不像入参对象 ⇒ 解析到的是**工厂 / seam 宿主**而不是腿本体。
      // 那一档绝不能当取用扫（`deps.emitIntent` 之类注入位会整批冒充成入参名），
      // 也不许静默放行：直接红，让「解析到工厂」这类错误以名字暴露。
      problems.push(
        `${face}: 执行体解析到 ${hit.file.rel.split('/').pop()}#${hit.def.name ?? '匿名箭头'}，` +
          `其第一形参 '${hit.def.paramNames[0]}' 不像入参对象（应为 args/rawArgs/input/params）——多半落到了工厂/seam 而非腿本体`,
      );
    } else {
      prebindKeySets(r, hit.file, hit.def.bodyStart, hit.def.bodyEnd, bind);
      walk(r, hit.file, hit.def.bodyStart, hit.def.bodyEnd, bind, 0);
    }
    const keys = new Set<string>();
    for (const s of r.sites) for (const k of s.keys) keys.add(k);
    scanned.set(face, {
      face,
      entry: `${hit.file.rel}:${hit.def.name ?? (ledger ? ledger.symbol : '匿名箭头')}`,
      consumed: [...keys].sort(),
      sites: r.sites,
      unresolved: r.sites.filter((s) => s.kind === 'unresolved'),
      notes: r.notes,
    });
  }
  for (const led of cfg.handoffs) if (!hitLedgers.has(led.id)) problems.push(`挂账 ${led.id} 没被命中（腿已改道 ⇒ 挂账陈旧）`);
  const alias = aliasConstKeys(files, ALIAS_CONST) ?? [];
  return {
    faces: scanned,
    derivedEntries,
    hitLedgers: [...hitLedgers],
    problems,
    fileStats: [...files.values()].map((f) => ({ rel: f.rel, toks: f.toks.length, defs: f.defs.length })),
    aliasConstFromSource: alias,
  };
}

function site(r: Run, file: FileScan, idx: number, kind: SiteKind, expr: string, keys: readonly string[], detail?: string): void {
  r.sites.push({
    face: r.face,
    file: file.rel,
    line: lineIndexOf(file.src, file.toks[idx]!.s),
    kind,
    expr: expr.replace(/\s+/g, ' ').slice(0, 76),
    keys,
    detail,
  });
}

function snippet(file: FileScan, a: number, b?: number): string {
  const end = b ?? a + 2;
  return file.toks
    .slice(Math.max(0, a), Math.min(file.toks.length, end + 1))
    .map((t) => (t.t === 'str' ? `'${t.v}'` : t.v))
    .join(' ')
    .slice(0, 90);
}

/** 调试 / 闸的「不是拿空表跑绿」自证：逐文件的 token 数、定义数、腿表条目数。 */
export interface CorpusFileView {
  readonly rel: string;
  readonly toks: number;
  readonly defs: readonly { name: string | null; params: readonly string[]; startLine: number; endLine: number }[];
  readonly legTables: readonly { face: string; ident: string }[];
}

export function inspectCorpus(root: string = REPO_ROOT): CorpusFileView[] {
  return LEG_CORPUS.map((rel) => {
    const f = buildFile(rel, root);
    return {
      rel,
      toks: f.toks.length,
      defs: f.defs.map((d) => ({
        name: d.name,
        params: d.paramNames,
        startLine: lineIndexOf(f.src, f.toks[Math.min(d.bodyStart, f.toks.length - 1)]!.s),
        endLine: lineIndexOf(f.src, f.toks[Math.min(Math.max(d.bodyEnd, d.bodyStart), f.toks.length - 1)]!.s),
      })),
      legTables: f.legTables,
    };
  });
}
