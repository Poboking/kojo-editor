import type * as Monaco from '../src/monaco/entry';

/**
 * Monarch **真编译 + 根状态驱动**测试基座（`kojo-token-tiers` 与 `erb-highlight` 共用）。
 *
 * 不用测试自造的第二套解析器：语言定义交给 monaco-editor **同版本**的
 * `monarchCompile.js::compile()`（编译期就会走 `createGuard`——`@attr` 缺属性 /
 * 非字符串数组当场抛），再把编译产物喂给复刻 `monarchLexer.js::_myTokenize`
 * 语义的根状态驱动器（逐条规则在剩余行上匹配、cases 卫兵逐档判词、群组逐子段
 * 发射、空组免发射、next 进栈 / `@pop` 退栈）。词形一律从语言定义读，不点名。
 */

/* ============================== 假 Monaco（捕获 Monarch def 与主题） ============================== */

export interface CapturedTheme {
  base: string;
  inherit: boolean;
  rules: Monaco.editor.ITokenThemeRule[];
  colors: Record<string, string>;
}

export interface Captured {
  readonly registered: string[];
  readonly monarchs: Map<string, Monaco.languages.IMonarchLanguage>;
  readonly themes: Map<string, CapturedTheme>;
  readonly configs: unknown[];
}

export function stubMonaco(): { monaco: typeof Monaco; captured: Captured } {
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
        captured.themes.set(name, theme as CapturedTheme);
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, captured };
}

/* ============================== Monarch 真编译 + 驱动器 ============================== */

export interface MonarchRule {
  regex: RegExp | ((state: string) => RegExp);
  action: MonarchAction;
  matchOnlyAtLineStart: boolean;
}

export type MonarchAction =
  | string
  | { token: string; next?: string; switchTo?: string; goBack?: number }
  | { test: (id: string, matches: string[], state: string, eos: boolean) => unknown }
  | MonarchAction[];

export interface CompiledLexer {
  start: string | null;
  defaultToken: string;
  tokenPostfix: string;
  tokenizer: Record<string, MonarchRule[]>;
}

export interface Emit {
  readonly text: string;
  readonly token: string;
  /**
   * 该 token 在**整行**里的起始列（0 基）。ERB-PAINT-21 批加：列坐标判据（涂 ⊆ 认的对拍、
   * 插值边界落点）以前只能拿 `line.indexOf(token)` 反推，而 lexer 对"没规则命中的字符"
   * **不发射任何 token**——一旦有跳字，反推就整段漂移。驱动器本来就知道 `pos`，直接带出来。
   * 既有消费方按 `text`/`token` 断言，零改动。
   */
  readonly start?: number;
}

/** 编译一份 Monarch def（语言 id 决定缺省 `tokenPostfix`，与运行时一致） */
export async function compileMonarch(languageId: string, def: unknown): Promise<CompiledLexer> {
  // 深层模块无 subpath 类型 ⇒ 变量路径动态 import（cjk-typing 的 monacoInternal 同款；TS 记 any）
  const sub = 'standalone/common/monarch/monarchCompile.js';
  const m = (await import(/* @vite-ignore */ `monaco-editor/editor/${sub}`)) as unknown as {
    compile: (id: string, json: unknown) => CompiledLexer;
  };
  return m.compile(languageId, def);
}

interface Piece {
  readonly action: MonarchAction;
  readonly matched: string;
}
interface Resolved {
  readonly tokens: Emit[];
  readonly next?: string;
  /** `{ token, switchTo }`：换当前态**不压栈**（monarchLexer L574-586 的 `stack.switchTo`） */
  readonly switchTo?: string;
  /** `{ token, goBack }`：发射后把游标回退 n 个字符（monarchLexer L571-573） */
  readonly goBack?: number;
  /** 群组：逐段受理（monarchLexer 的 groupMatching 迭代语义） */
  readonly pieces?: readonly Piece[];
}

/**
 * action 解析链（monarchLexer 536-545 + monarchCompile cases test 链的等价复刻）：
 * 向下解 test（cases 卫兵）直到字符串 / {token} / 群组数组。
 * `exec` = 该规则的完整正则匹配数组（群组展开要用子匹配；非群组可 null）。
 */
function resolveAction(action: MonarchAction, matched: string, exec: RegExpExecArray | null): Resolved {
  let a: unknown = action;
  for (let hop = 0; hop < 32; hop++) {
    if (typeof a === 'string') {
      return a === '' ? { tokens: [] } : { tokens: [{ text: matched, token: a }] };
    }
    // 编译产物里群组是 `{ group: [...] }` 对象（monarchCompile L305-308）；数组是原始 def 形态
    if (Array.isArray(a)) {
      if (!exec) throw new Error('群组动作需要完整 exec');
      return { tokens: [], pieces: a.map((sub, i) => ({ action: sub as MonarchAction, matched: exec[i + 1] ?? '' })) };
    }
    const actionObj = a as {
      token?: string;
      next?: string;
      switchTo?: string;
      goBack?: number;
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
        pieces.push({ action: actionObj.group[i] as MonarchAction, matched: exec[i + 1] ?? '' });
      }
      if (exec.length !== pieces.length + 1) {
        throw new Error(`群组数目与子段不齐：exec.length=${exec.length} pieces=${pieces.length}`);
      }
      return { tokens: [], pieces };
    }
    const token = actionObj.token ?? '';
    // 空 token 在真实 lexer 里**只是不样式化**，状态转移照做（monarchLexer L571-620 的转移段
    // 不看 token 空不空）——旧写法在这里直接 `return { tokens: [] }` 会把 `next` / `switchTo` 一起吞掉。
    return {
      tokens: token === '' ? [] : [{ text: matched, token }],
      next: actionObj.next,
      switchTo: actionObj.switchTo,
      goBack: actionObj.goBack,
    };
  }
  return { tokens: [] };
}

/**
 * 驱动器**单行入口**（既有消费方逐字零改动）：从根状态起步吃一行，返回发射序列。
 * 跨行态判据（未闭合引号行尾出栈）走 `driveLine`——真实 monarchLexer 把栈带过行界，
 * 单进单出的 driveLexer 看不见那一层，缺口就只能永远留给"真机壳冒烟"。
 */
export function driveLexer(lexer: CompiledLexer, line: string): Emit[] {
  return driveLine(lexer, line).emitted;
}

/** 跨行态驱动的单行结果：发射序列 + 出栈态（回传给下一行的 `stackIn` 即续行） */
export interface LineDrive {
  readonly emitted: Emit[];
  readonly stack: readonly string[];
}

/**
 * 根状态驱动器（跨行态版）：把一行交给编译产物逐条规则匹配并发射 token，栈可从上一行
 * 带来、原样带出。语义锚点：`String.match`/`exec` 在 `^(?:…)` 锚定正则上等价于"从当前
 * pos 起步匹配"；规则列表序 = 匹配优先序；群组逐子段、空子段免发射（monarchLexer
 * 691-694）；逐次推进；`@popall` 退到栈底（monarchLexer 的 popall 分支）。
 */
export function driveLine(lexer: CompiledLexer, line: string, stackIn?: readonly string[]): LineDrive {
  const stack: string[] = stackIn && stackIn.length > 0 ? [...stackIn] : [lexer.start ?? 'root'];
  if (!lexer.tokenizer[stack[stack.length - 1]!]) {
    throw new Error(`Monarch def 没有根状态 ${stack[stack.length - 1]}`);
  }
  const out: Emit[] = [];
  // Monaco 屏上真发的是 token 名 + tokenPostfix（编译器按语言 id 默认补 `.kojo-sugar`），
  // 主题规则按点分段前缀匹配 —— 驱动器同样补上，断言走完整前缀口径
  const lexerPostfix = lexer.tokenPostfix;
  const emitInto = (tokens: readonly Emit[], start: number): void => {
    for (const t of tokens) out.push({ text: t.text, token: t.token === '' ? '' : `${t.token}${lexerPostfix}`, start });
  };
  let pos = 0;
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
        const pieceStart = pos;
        pos += piece.matched.length;
        const r = resolveAction(piece.action, piece.matched, null);
        emitInto(r.tokens, pieceStart);
        if (r.next) throw new Error('群组子段带 next：判据行形态不支持');
      }
      continue;
    }
    // 2) 状态内逐条规则试匹配（monarchLexer 504-513：列表序首个命中者生效）
    const state = stack[stack.length - 1]!;
    const stateRules: readonly MonarchRule[] = lexer.tokenizer[state] ?? executeMissing(state);
    let matched: string | null = null;
    let exec: RegExpExecArray | null = null;
    let action: MonarchAction | null = null;
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
    const matchStart = pos;
    pos += matched.length;
    const r = resolveAction(action, matched, exec);
    if (r.pieces) {
      pending = r.pieces;
      pos -= matched.length; // 群组受理从子段重计（monarchLexer 672 同调）
      continue;
    }
    emitInto(r.tokens, matchStart);
    // 4) 状态转移（monarchLexer 571-622：`goBack` 先调游标，`switchTo` 与 `next` 是 else-if 关系
    // ——同一条动作里两者都在时只有 switchTo 生效，基座照抄这个优先级，别自创第三套）
    if (r.goBack !== undefined) {
      pos = Math.max(0, pos - r.goBack);
    }
    if (r.switchTo !== undefined) {
      // `stack.switchTo(s) = create(this.parent, s)`：换掉栈顶一层，父栈原样保留
      const target = r.switchTo.startsWith('@') ? r.switchTo.slice(1) : r.switchTo;
      if (!lexer.tokenizer[target]) {
        throw new Error(`switchTo 指向没有规则表的状态 ${target}（真实 lexer 在此同样抛错）`);
      }
      stack[stack.length - 1] = target;
    } else if (r.next !== undefined) {
      if (r.next === '@pop') stack.pop();
      else if (r.next === '@push') stack.push(state);
      else if (r.next === '@popall') {
        // monarchLexer 的 popall：退到栈底（初始 root 态），行尾出栈类规则用它一次清干净嵌套态
        while (stack.length > 1) stack.pop();
      } else stack.push(r.next.startsWith('@') ? r.next.slice(1) : r.next);
    }
  }
  return { emitted: out, stack };

  function executeMissing(state: string): never {
    throw new Error(`状态 ${state} 在 Monarch def 里没有规则表`);
  }
}

/**
 * 多行驱动器：**状态栈跨行保留**（Monaco 的 line state 本来就会延续到下一行——
 * `@skip` / `@str` 这类跨行状态在单行驱动器里永远测不到）。空行不触发规则
 * （与 `driveLexer` 同口径；Monaco 对空行会强评一次，但空行没有可发射文本）。
 */
export function driveLines(lexer: CompiledLexer, lines: readonly string[]): Emit[][] {
  let stack: readonly string[] = [lexer.start ?? 'root'];
  return lines.map((line) => {
    const drive = driveLine(lexer, line, stack);
    stack = drive.stack;
    return drive.emitted;
  });
}
