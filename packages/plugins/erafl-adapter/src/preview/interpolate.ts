/**
 * 口上台词的**替换记号预览**（纯函数）。
 *
 * 目标不是"把台词渲染成最终文本"，而是让作者在编辑器里看到"这句话大概长什么样，
 * 哪些记号我认不出来"。因此有两条硬规则：
 * 1. **不猜**：随机取项（`%S_R(...)%`）只取第一项并把原记号报出来，不掷骰子；
 *    认不出来的记号（`%ANAME(...)%`、`[$SE:...]` …）**原样留在文本里**。
 * 2. **不静默吞**：凡是没能替换成确定值的记号都进 `unresolved`——作者要靠这份
 *    清单发现自己写错的记号；悄悄删掉等于把 bug 藏起来。
 *
 * 记号族（eraFL 语料实测）：
 * - `%CALLNAME:MASTER%` / `%CALLNAME:<角色号>%`：对主人公 / 角色的称呼；
 * - `%CNAME%` / `%NAME%`：角色名 / 主人公名（旧写法，现盘已少见但引擎仍认）；
 * - `[$MNAME]` / `[$KNAME]` / `[$NAME]` / `[$PNAME]`：方括号变量族，
 *   `M`=MASTER、`K`=口上角色、`P`=PLAYER；`[$NAME]` 是它们的泛化写法；
 * - `%S_R("a/b/c")%`（以及 `%S_R(@"…")%`）：斜杠分隔的随机取项；
 * - 其余 `%…%` / `[$…]`：本层不认识，原样保留并上报。
 *
 * 为什么用**一次正则扫描**而不是反复 `replace`：替换结果里可能含有新的 `%…%`
 * （`%S_R(@"%NAME%/人家")%` 的首项就是），多趟替换会二次解释作者的数据；
 * 单趟扫描 + 对随机首项**显式递归**，才能把"哪些是原文、哪些是替换产物"分清楚。
 */

/** 预览上下文（全部可选：缺哪个就报哪个未解析，不编造名字） */
export interface KojoInterpolateContext {
  /** 主人公名（`%NAME%` / `[$MNAME]` / `[$PNAME]`） */
  readonly playerName?: string;
  /** 口上角色名（`%CNAME%` / `%CALLNAME:<角色号>%` / `[$KNAME]` / `[$NAME]`） */
  readonly charaName?: string;
  /** 角色对主人公的称呼（`%CALLNAME:MASTER%`）——与 `playerName` 是两件事 */
  readonly callName?: string;
  /** 额外方括号变量（键 = 不含 `[$ ]` 的名字，如 `{ W: '墙壁' }`）；优先于内置别名 */
  readonly vars?: Readonly<Record<string, string>>;
}

/** 预览结果：替换后的文本 + 没能确定下来的记号（去重，保留首次出现顺序） */
export interface KojoInterpolateResult {
  readonly text: string;
  readonly unresolved: string[];
}

/**
 * 记号扫描顺序 = 优先级，不能调换：
 * 1. `%S_R(...)%` 必须最先——它的参数里可能嵌着别的 `%…%`，晚了就会被当成两个记号切开；
 * 2. `%CALLNAME:…%` 比泛化 `%…%` 具体；
 * 3. `%CNAME%` / `%NAME%` 是固定名；
 * 4. `[$…]` 与 `%…%` 互不重叠。
 *
 * 泛化分支限制单行、最长 400 字符：跨行的 `%` 通常是正文里的普通百分号，
 * 不该把两行之间的内容整段吞成一个"记号"。
 */
const TOKEN_RE =
  /%S_R\(\s*@?(["'])([\s\S]*?)\1\s*\)%|%CALLNAME:([^%\r\n]*)%|%(CNAME|NAME)%|%[^%\r\n]{1,400}%|\[\$([^\]\r\n]{1,80})\]/g;

/** 随机首项里还可能嵌记号；层数上限只防作者写出病态嵌套，正常语料 1 层就到底 */
const MAX_DEPTH = 4;

/** 方括号变量的内置别名（键 = 去掉 `[$` `]` 后的名字） */
const BRACKET_ALIASES: Readonly<Record<string, 'player' | 'chara'>> = {
  MNAME: 'player',
  PNAME: 'player',
  KNAME: 'chara',
  NAME: 'chara',
};

/** 取名字；空串按"没有"处理（把记号换成空串会让台词静默缺一块） */
function resolveName(value: string | undefined, token: string, note: (t: string) => void): string {
  if (value === undefined || value.length === 0) {
    note(token);
    return token;
  }
  return value;
}

function interpolateInternal(
  text: string,
  ctx: KojoInterpolateContext,
  depth: number,
  note: (token: string) => void,
): string {
  return text.replace(
    TOKEN_RE,
    (whole: string, _quote: string, srBody: string, callArg: string, simple: string, bracket: string) => {
      // ---- 1. %S_R("a/b/c")% / %S_R(@"a/b/c")% ----
      if (srBody !== undefined) {
        const options = srBody.split('/');
        const first = (options[0] ?? '').trim();
        if (first.length === 0) {
          note(whole);
          return whole;
        }
        // 首项自身可能带记号（语料里 `%S_R(@"%_K36_…%/…")%` 就是这样）：
        // 只解释首项，别的候选不碰——它们这次不会被显示。
        const rendered =
          depth < MAX_DEPTH ? interpolateInternal(first, ctx, depth + 1, note) : first;
        // 多个候选 = 随机：把原记号报给预览面标注"随机"，但不猜结果（取首项只是示意）
        if (options.length > 1) note(whole);
        return rendered;
      }

      // ---- 2. %CALLNAME:MASTER% / %CALLNAME:<角色号>% ----
      if (callArg !== undefined) {
        const arg = callArg.trim();
        if (arg.toUpperCase() === 'MASTER') {
          return resolveName(ctx.callName, whole, note);
        }
        // 角色号是数字；`[$KC]` / 函数调用这类动态实参本层算不出来，原样上报
        if (/^\d+$/.test(arg)) {
          return resolveName(ctx.charaName, whole, note);
        }
        note(whole);
        return whole;
      }

      // ---- 3. %CNAME% / %NAME% ----
      if (simple !== undefined) {
        return simple === 'CNAME'
          ? resolveName(ctx.charaName, whole, note)
          : resolveName(ctx.playerName, whole, note);
      }

      // ---- 4. [$MNAME] 等方括号变量 ----
      if (bracket !== undefined) {
        const vars = ctx.vars;
        // 显式变量优先：作者可以用 vars 覆盖内置别名（如把 [$W] 填成具体场所）
        if (vars && Object.prototype.hasOwnProperty.call(vars, bracket)) {
          return vars[bracket] ?? '';
        }
        const alias = BRACKET_ALIASES[bracket];
        if (alias === 'player') return resolveName(ctx.playerName, whole, note);
        if (alias === 'chara') return resolveName(ctx.charaName, whole, note);
        note(whole);
        return whole;
      }

      // ---- 5. 其余 %…%：本层不认识，原样保留并上报 ----
      note(whole);
      return whole;
    },
  );
}

/**
 * 解释一段口上台词。
 *
 * 不抛异常：非字符串输入返回空结果。`unresolved` 按首次出现去重——同一句话里
 * 重复写错同一个记号，报 10 遍不会让作者更快改对。
 */
export function interpolateKojoText(
  text: string,
  ctx: KojoInterpolateContext = {},
): KojoInterpolateResult {
  if (typeof text !== 'string') return { text: '', unresolved: [] };
  if (text.length === 0) return { text: '', unresolved: [] };

  const unresolved: string[] = [];
  const seen = new Set<string>();
  const note = (token: string): void => {
    if (seen.has(token)) return;
    seen.add(token);
    unresolved.push(token);
  };

  const rendered = interpolateInternal(text, ctx ?? {}, 0, note);
  return { text: rendered, unresolved };
}
