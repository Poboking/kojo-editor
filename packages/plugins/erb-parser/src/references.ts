import type {
  EditorDecoratePayload,
  EditorSymbolLocation,
  ErbFile,
  ErbIndex,
  ErbReference,
  ErbReferenceIndex,
  ErbReferenceKind,
  LineDecoration,
  SymbolToken,
} from '@kojo/plugin-api';
import { isErbDialectPath, MODEL_TOKEN_CLASS, unicodeTokenAt } from '@kojo/plugin-api';

/**
 * 反向引用索引（H2 批，2026-10-15）：**谁提到了这个名字**。
 *
 * find-references / rename 的共同前置——`byName` 只回答"名字→定义"，
 * "引用→名字"此前全仓不存在。本模块补齐反向边，纪律两条：
 * - **构建只读索引期已流过的文本**（stale 文件重读一次，412 万行文本绝不整份留驻）；
 * - **查询是纯函数**：`referencesOf` 只读 `index.references`，不读盘、不改状态。
 *
 * 引用面（取舍，详见契约 `ErbReference.kind`）：
 * 可证明的只有"函数名作为**可见代码记号整串**出现"这一条——
 * 注释（整行与行内尾巴）、字符串内容、`[SKIPSTART…SKIPEND]`、`#DIM`/``$`` 标签行
 * 一律**不算**引用；`JUMP`/`GOTO` 目标是行号/标签、`*CALLFORM` 参数是表达式，
 * 解析它们要数据流，超出可证明边界，宁可少报不误报。
 * 可见性规则与 `parseErbText` 逐条对齐（两套屏蔽规则分叉 = 漂移源）。
 *
 * 2026-10-16 语言服务批起，本模块同时是**未定义 CALL 目标波浪线**（T3）的判据真源：
 * `scanUndefinedCallTargets` / `erbReferenceDecorations` 与 `scanFileRefs` 共用
 * 同一条可见行遍历（`visibleCodeLines`）、同一张 `CALL_FAMILY` 表、同一个记号字符集
 * ——"哪些字符算引用"只有一把尺子。
 * 2026-10-19 F12-TOKEN 批起，本模块还是**光标处函数名**的唯一取词判据（`functionNameTokenAt`）：
 * 反向索引记进表的记号与光标查表用的记号必须是同一枚尺量出来的，否则会出现
 * "引用面板查得到、F12 跳不动"（反之亦然）这类没人能解释的差值。
 */

/** 行首直系调用关键字（参数位就是**函数名**的那些；FORM / GOTO / JUMP 系不在内，理由见头注） */
const CALL_FAMILY: ReadonlySet<string> = new Set(['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']);

const KIND_DEFINITION = 0;
const KIND_CALL = 1;
const KIND_MENTION = 2;
const KIND_BY_FLAG: readonly ErbReferenceKind[] = ['definition', 'call', 'mention'];

/**
 * 盘上/内存共用的紧凑格式：`[归一化名, 行, 列, 种类旗标]`。
 * `endColumn` 不落盘（= column + 名字长度，可派生——快照瘦身 v3 的同一条纪律）。
 * 名字统一存**归一化大写**：引用原文可以小写，但索引键只有大写形态。
 */
export type RefRun = readonly [name: string, line: number, column: number, kind: 0 | 1 | 2];

/** 单文件的引用流水（按行、列升序；构建序确定 ⇒ 聚合序确定） */
export type FileRefs = readonly RefRun[];

/** 行内换行归一（与 scanner 同规则；插件内自带，不依赖 kernel） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 一行的"代码视野"：字符串内容与引号外的 `;` 注释尾巴**等长刷白**。
 * 等长是为了保住列坐标（引用点要能回指原文位置）；PRINT 字符串里的 `;` 不当注释
 * （与 `sliceExpression` 同一口径）。未闭合引号按"到行尾都是字符串"处理——
 * 那种文本引擎本来就编译不过，刷白是安全方向。
 *
 * PS-3 提速批：①无 `"` 且无 `;` 的行逐字符刷白是恒等变换——快路径原样返回，
 * 不分配（真实语料多数行既无串也无行内注释）；②慢路径按段 `slice` 拼接 +
 * 整段空格 `repeat`，替代旧实现的逐字符 `+=`（412 万行的热路径）。
 * **产出的字符串逐字符不变**——`references.test.ts` 的引号/注释/落单引号用例
 * 与语料朴素对拍共同钉死。
 */
function codeViewOf(line: string): string {
  if (line.indexOf('"') === -1 && line.indexOf(';') === -1) return line;
  let out = '';
  let seg = 0; // 下一段"原文"的起点（此前各段已并入 out）
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (inStr) {
      if (c === 34 /* " */) {
        out += ' '.repeat(i - seg + 1); // 串体 + 闭引号整体刷白
        seg = i + 1;
        inStr = false;
      }
      continue;
    }
    if (c === 34 /* " */) {
      out += line.slice(seg, i) + ' ';
      seg = i + 1;
      inStr = true;
    } else if (c === 59 /* ; */) {
      return out + line.slice(seg, i) + ' '.repeat(line.length - i);
    }
  }
  return inStr ? out + ' '.repeat(line.length - seg) : out + line.slice(seg);
}

/**
 * 可见代码记号：Unicode 字母/数字/下划线。
 * **刻意不锁 ASCII**——真实语料 99,118 条 `@` 定义里 20,805 条（21%）名字含 CJK
 * （`M_KOJO_無個性_…` 一族，eraTW 作者手写），ASCII 字符集会静默漏掉两成定义的反向边。
 * 与 `plugin-api/symbol-token` 的 ASCII 集**不同**是有意分歧：那张表服务"**原生**名字查表"
 * （引擎/库表的键就是 ASCII 原生名，宁可窄），这张表服务"作者自己起的名字"
 * （全库反向索引 + 光标查表两条腿，漏了就是错）。F12-TOKEN（2026-10-19）把**光标查表**
 * 那两条腿（`definitionTargetsAt` / `erbReferenceLocationsAt`）也接到这一把尺上：
 * 语料 25,003 条 CJK 定义名的名字点位上，ASCII 尺给得出记号的只有 45,035/50,006 个点位、
 * 其中查得到定义的只有 61 个（0.12%），换成本尺是 49,848/50,006（99.68%）。
 *
 * 字符集**字面量只住在 `plugin-api/semantic-locate` 的 `MODEL_TOKEN_CLASS`**：着色落点
 * （`locateIdentifier`）、本条反向索引、以及下面的 `functionNameTokenAt` 回答的是同一个
 * 事实——"什么字符算一个记号"。两处各写一遍就是第二判据，漂移表现是
 * "引用面板说有引用、着色却不亮"（反之亦然）。
 *
 * PS-3 提速批：遍历从"每行一次 `RegExp.exec` 循环"换成 `forEachToken` 的
 * `charCodeAt` 走位（ASCII 判据内联、其余码点仍回退到**同一个** `MODEL_TOKEN_CLASS`
 * 组装的单字符谓词——尺子没换，只是不再为每个记号分配 match 数组）。
 * 与旧 exec 的等价性由 `references.test.ts`（含 CJK / 全角 / 成员冒号 / 大小写用例）
 * 与语料朴素对拍（朴素版是第三种独立实现）共同钉死。
 */
const IDENT_ONE = new RegExp(MODEL_TOKEN_CLASS, 'u');

/** 半/全角冒号的码元（成员访问判据：`FLAG:NAME` 里 NAME 引用的是 FLAG 的成员，不是函数） */
const COLON_HALF = 0x3a;
const COLON_FULL = 0xff1a;

/**
 * 「这一段记号是不是**变量成员访问**」的**唯一**判据（0 基半开区间）：整串紧邻半/全角
 * 冒号 ⇒ 它属于变量世界，既不是反向索引里的引用点（`scanFileRefs`）、也不是 CALL 的
 * 名字槽（`scanUndefinedCallTargets`）、也不是光标处的函数名（`functionNameTokenAt`）。
 * 三处各自内联一遍就是第四份判据，漂移的表现是"引用面板里查不到、F12 却跳得过去"。
 */
function colonAdjacent(code: string, start: number, end: number): boolean {
  const before = start > 0 ? code.charCodeAt(start - 1) : -1;
  const after = end < code.length ? code.charCodeAt(end) : -1;
  return before === COLON_HALF || before === COLON_FULL || after === COLON_HALF || after === COLON_FULL;
}

/**
 * 光标处**函数名**记号（`byName` 查表两条腿的唯一取词判据，F12-TOKEN 2026-10-19）。
 *
 * = 契约 Unicode 尺（`MODEL_TOKEN_CLASS` 那一把，与 F2 改名 / 引用面板 / 结构化着色同源）
 * 再套本模块的成员访问退让（`colonAdjacent`）。两条腿（转到定义 / 查找引用）**必须**用
 * 同一枚函数取词：`erbReferenceLocationsAt` 查的键正是 `scanFileRefs` 记进表的那些记号，
 * 取词尺不一致就会出现"光标处查得到定义、查引用却说没有"。
 *
 * 列口径与 `symbolTokenAt` 逐字一致（1 基、越界不猜、停在词尾后一格也算命中）。
 */
export function functionNameTokenAt(lineText: string, column: number): SymbolToken | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  // 列越界（超过行宽 + 1）视为行外：光标不可能在那儿（与 `symbolTokenAt` 同一条不猜口径）
  if (column > lineText.length + 1) return undefined;
  const token = unicodeTokenAt(lineText, Math.trunc(column));
  if (!token) return undefined;
  if (colonAdjacent(lineText, token.startColumn - 1, token.endColumn - 1)) return undefined;
  return token;
}

/**
 * 码元/码点的记号分类缓存（W7-G，2026-10-20 着色腿归因）。
 *
 * **为什么要有**：5,000 行合成 ERB 的单次 `scanFileRefs` 读数 median 31.6 ms，
 * 其中 25.7 ms 花在 `IDENT_ONE.test` 上——Unicode 字母/数字属性类的 `/u` 正则对
 * 每个**非 ASCII 码元**各跑一次，而语料里 CJK 正文有 13.7 万个字符（真语料口上台词同理）。
 * 分类只取决于码点本身，与上下文无关，所以按码元（BMP，含落单代理项）与码点
 * （代理对合成的增平面字符）各缓存一次：同一进程里同一字符只问正则一遍。
 *
 * **判据没换**：命中的那个 `2 / 1 / 0` 仍是 `IDENT_ONE` 现算出来的值，缓存只是
 * 记住它（字符集字面量仍只有 `MODEL_TOKEN_CLASS` 一处）。逐条等价由
 * `refs-charclass-cache-equiv.test.ts` 与 `refs-fastpath-equiv.test.ts` 对拍钉死。
 */
const BMP_TOKEN_CLASS = new Uint8Array(0x10000); // 0 = 未算，1 = 记号，2 = 非记号
const ASTRAL_TOKEN_CLASS = new Map<number, boolean>();

/** BMP 码元的记号分类（惰性填表；含落单代理项——`/u` 下它们本就不落进记号类） */
function bmpTokenChar(s: string, i: number, code: number): 0 | 1 {
  const cached = BMP_TOKEN_CLASS[code]!;
  if (cached !== 0) return cached === 1 ? 1 : 0;
  const isToken = IDENT_ONE.test(s[i]!);
  BMP_TOKEN_CLASS[code] = isToken ? 1 : 2;
  return isToken ? 1 : 0;
}

/**
 * `i` 处码元是否为记号字符；返回**占用的码元数**（0 = 非记号）。
 * ASCII（`[A-Za-z0-9_]`）走内联快路径；**代理对**（增平面字母/数字）以两个码元
 * 为一个整体问 `IDENT_ONE`——与 `TOKEN_RE` 在 `/u` 模式下的走位逐字符一致；
 * 落单代理项在 `/u` 下永不落进记号类，这里同样判非记号。
 * W7-G：非 ASCII 的分类结果进缓存（见 `BMP_TOKEN_CLASS`），判据仍是同一个正则。
 */
function tokenCharLen(s: string, i: number, code: number): 0 | 1 | 2 {
  if (code < 0x80) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 ? 1 : 0;
  }
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      const cp = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
      const cached = ASTRAL_TOKEN_CLASS.get(cp);
      if (cached !== undefined) return cached ? 2 : 0;
      const isToken = IDENT_ONE.test(s.slice(i, i + 2));
      ASTRAL_TOKEN_CLASS.set(cp, isToken);
      return isToken ? 2 : 0;
    }
  }
  return bmpTokenChar(s, i, code);
}

/** `normalizedUpper` 的判据范围（ASCII 小写 + 全角小写；与它的正则逐字符同区间） */
function hasLowerCodeUnit(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0xff41 && code <= 0xff5a);
}

/**
 * 逐记号遍历（`scanFileRefs` / `scanUndefinedCallTargets` 共用，单一真源）：
 * 对每段连续记号回调 `(start, end, hasLower)`（UTF-16 半开区间，与旧 `TOKEN_RE.exec` 的
 * `m.index` / `m.index + m[0].length` 同位）；回调返回 `false` 中止遍历
 * （对应旧循环的 `break`）。
 *
 * W7-G：`hasLower` 是遍历时**顺带**记下的"这段记号含不含 `[a-zａ-ｚ]`"——它正好是
 * `normalizedUpper` 里那条正则的同一判据（区间见 `hasLowerCodeUnit`），于是调用方
 * 能省掉"无小写就整段 toUpperCase"的那一遍全文扫描。判据仍只有 `normalizedUpper`
 * 一条（`hasLower === false` 时它的结果按定义就是原串；`true` 时仍交给它算），
 * 等长/逐条等价由差分用例钉死。
 */
function forEachToken(s: string, visit: (start: number, end: number, hasLower: boolean) => boolean | void): void {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const startCode = s.charCodeAt(i);
    const len = tokenCharLen(s, i, startCode);
    if (len === 0) {
      i++;
      continue;
    }
    const start = i;
    let hasLower = hasLowerCodeUnit(startCode);
    i += len;
    while (i < n) {
      const code = s.charCodeAt(i);
      const next = tokenCharLen(s, i, code);
      if (next === 0) break;
      if (!hasLower && hasLowerCodeUnit(code)) hasLower = true;
      i += next;
    }
    if (visit(start, i, hasLower) === false) return;
  }
}

/** 定义名截断（与 `parseFunctionDefinition` 同一组终止符，**含逗号形的 `,`**；名字在这里只按解析器口径取） */
const DEF_STOP = new Set(['(', ',', ' ', '\t', ';']);

/**
 * 一条**可见代码行**的形状（`visibleCodeLines` 的产出；列坐标与原文逐位对齐）。
 */
export interface VisibleCodeLine {
  /** 1 基行号 */
  readonly line: number;
  /** 行原文（未 trim；列对齐的基准） */
  readonly raw: string;
  /**
   * 代码视野（字符串内容与行内注释尾巴等长刷白；与 `raw` 等长同位）。
   *
   * **惰性**（2026-10-16 LS-R6 批改为方法）：行内提示供方高频调用，而它只对
   * CALL 行要代码视野——早先"每行都算"的实现实测在 52,602 行的真实语料上
   * 一次整篇扫描 114ms（52k 行 × 全行逐字符刷白），改成"谁要谁付"后同一读数
   * 降到个位数毫秒。消费方只在**确定要看这行**时才调，别无条件调。
   */
  codeView(): string;
  /** `@` 定义行（定义名按解析器口径截，调用方自理） */
  readonly isDefinition: boolean;
  /** 行首是 CALL 直系族（名字槽判据，同一张 `CALL_FAMILY` 表） */
  readonly isCallLine: boolean;
  /** CALL 关键字之后的行内 0 基偏移（非调用行 = -1） */
  readonly keywordEnd: number;
}

/**
 * 可见代码行的**唯一**遍历（2026-10-16 语言服务批）：
 * `scanFileRefs`（反向索引）/ `scanUndefinedCallTargets`（未定义 CALL 波浪线）/
 * `callArgumentHints`（LS-R6 实参位提示）共用——屏蔽规则（`[SKIPSTART]` 区、空行、
 * 整行 `;`、`#` 指令、`$` 标签、`@` 定义行）与"哪行有名字槽"只写在这里。
 * 三处各写一遍就是第二判据，漂移的表现是"引用面板说没有、波浪线却红"（反之亦然）。
 */
export function* visibleCodeLines(text: string): Generator<VisibleCodeLine> {
  const lines = normalizeEol(text).split('\n');
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    // 区间标记的严格等值判据与 `parseErbText` 逐字同源（取证读数与"为什么不放开大小写"见该处注释）
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('$')) {
      continue;
    }

    if (trimmed.startsWith('@')) {
      // 定义行：名字提取按解析器口径（调用方自理）；调用判据一概不适用
      yield { line: i + 1, raw, codeView: () => '', isDefinition: true, isCallLine: false, keywordEnd: -1 };
      continue;
    }

    // 行首是 CALL 直系族 ⇒ 关键字之后的**第一个记号**是引擎"按名调用"的名字槽位。
    // PS-3：行首 `[A-Za-z_]+` 走位改 charCodeAt（旧版每行一次 `/^[A-Za-z_]+/.exec`，
    // 412 万行累计是最大单项正则开销；匹配范围与判据逐字符不变）。
    let leadLen = 0;
    while (leadLen < trimmed.length) {
      const c = trimmed.charCodeAt(leadLen);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) leadLen++;
      else break;
    }
    const isCallLine = leadLen > 0 && CALL_FAMILY.has(trimmed.slice(0, leadLen).toUpperCase());
    // 名字槽起点（行内 0 基偏移）= 缩进 + 关键字长度；缩进只算行首空白（trailing 会干扰差值）
    const keywordEnd = isCallLine ? raw.length - raw.trimStart().length + leadLen : -1;
    let codeCache: string | undefined;
    yield {
      line: i + 1,
      raw,
      codeView: () => (codeCache ??= codeViewOf(raw)),
      isDefinition: false,
      isCallLine,
      keywordEnd,
    };
  }
}

/** 归一化快路径：无小写拉丁（半/全角）就不分配 toUpperCase 副本（412 万行的热路径）。 */
export function normalizedUpper(run: string): string {
  return /[a-zａ-ｚ]/.test(run) ? run.toUpperCase() : run;
}

/**
 * 扫描单文件文本的全部引用流水（**纯函数**：文本进、紧凑记录出，不读盘）。
 *
 * `hasName` 是"这个名字是不是项目里的某个函数"的唯一判据——由调用方拿
 * `ErbIndex.byName` 提供，本模块因此对"项目里有哪些函数"零知识、可独立单测。
 * 行可见性与 `parseErbText` 对齐：`[SKIPSTART]…[SKIPEND]` 屏蔽、整行 `;`、
 * `#` 指令、`$` 标签、`@` 定义行（只取名字记号，形参不扫）。
 */
export function scanFileRefs(text: string, hasName: (normalizedName: string) => boolean): FileRefs {
  const out: RefRun[] = [];
  for (const { line, raw, isDefinition, isCallLine, keywordEnd, codeView } of visibleCodeLines(text)) {
    if (isDefinition) {
      // 定义行：名字按**解析器的口径**截（终止符 `(`/空白/`;` + 截后 trim，与
      // `parseFunctionDefinition` 逐字符对齐——真语料实测 4 条定义名带全角空白，
      // 不对齐这条口径 `defSites === 函数总数` 就差 4，反向边静默漏定义）。
      // 形参表与行内注释都不扫。
      const at = raw.indexOf('@');
      let j = at + 1;
      while (j < raw.length && !DEF_STOP.has(raw[j]!)) j++;
      const slice = raw.slice(at + 1, j);
      const name = slice.trim();
      if (name.length > 0) {
        const upper = name.toUpperCase();
        if (hasName(upper)) out.push([upper, line, at + 2 + (slice.length - slice.trimStart().length), KIND_DEFINITION]);
      }
      continue;
    }

    let slotTaken = !isCallLine; // 非调用行没有槽位概念，全部走 mention

    const code = codeView();
    forEachToken(code, (start, end, hasLower) => {
      const inSlot = !slotTaken && start >= keywordEnd;
      if (inSlot) slotTaken = true; // 槽位记号无论命不命中名字都被消耗
      // 变量成员访问整体不算函数引用：`CFLAG:ALPHA` 两段都是变量世界（基名紧邻冒号，
      // 如 `ALPHA:CFLAG` 的 ALPHA，即便撞上函数名也不算提及）。判据单源 `colonAdjacent`。
      if (colonAdjacent(code, start, end)) return;
      const run = code.slice(start, end);
      // 无小写 ⇒ `normalizedUpper` 按定义返回原串（省掉一次 toUpperCase 全文扫描）；
      // 有小写仍交给 `normalizedUpper` 算，归一判据不在本函数里复述。
      const upper = hasLower ? normalizedUpper(run) : run;
      if (!hasName(upper)) return;
      out.push([upper, line, start + 1, (inSlot ? KIND_CALL : KIND_MENTION) as 0 | 1 | 2]);
    });
  }
  return out;
}

/* ---------------- 未定义 CALL 目标（T3，2026-10-16 语言服务批） ---------------- */

/** CALL 名字槽里一处**未收录**的裸标识符（波浪线装饰的数据面） */
export interface UndefinedCallTarget {
  /** 1 基行号 */
  readonly line: number;
  /** 名字首字符（1 基列） */
  readonly column: number;
  /** 原样记号 */
  readonly name: string;
}

/**
 * 扫出全部"CALL 直系族 + 裸标识符 + 名字不在名录"的槽位（**纯函数**：文本 + 名字集进、
 * 数据出；单遍线性扫描，不做二次全文件解析）。
 *
 * `hasName` 与 `scanFileRefs` 同一判据（调用方拿 `ErbIndex.byName` 提供）；
 * 行可见性与记号字符集与它**逐字共用**（`visibleCodeLines` / `forEachToken`，单一真源）。
 * fail-open 全在判据里，一条都不报（**不猜**；错标比不标危险）：
 * - FORM 动态拼接：关键字与记号之间出现 `(`、`"`、`{`、`%` 等任何非空白字符；
 * - 成员访问占槽（`CALL FLAG:X`——变量世界，与 `scanFileRefs` 同判据不向后顺延）；
 * - `CALLFORM` 全族（不在 `CALL_FAMILY` 表里）、字符串 / 注释 / `[SKIPSTART]` 区、
 *   `$` 标签行（`visibleCodeLines` 屏蔽面）；
 * - 名字在名录里的（那不是"未定义"）。
 */
export function scanUndefinedCallTargets(text: string, hasName: (upper: string) => boolean): UndefinedCallTarget[] {
  const out: UndefinedCallTarget[] = [];
  for (const { line, raw, isCallLine, keywordEnd, codeView } of visibleCodeLines(text)) {
    if (!isCallLine) continue;
    const code = codeView();
    forEachToken(code, (start, end, hasLower) => {
      if (start < keywordEnd) return; // 关键字自身
      // 槽位 = 关键字后的第一个记号；与关键字之间只许空白 ⇒ 裸标识符
      if (!/^[\t \u3000]*$/.test(raw.slice(keywordEnd, start))) return false;
      const run = code.slice(start, end);
      // 成员访问占槽：整槽不算函数名，也不向后顺延（判据单源 `colonAdjacent`）
      if (colonAdjacent(code, start, end)) return false;
      const upper = hasLower ? normalizedUpper(run) : run;
      if (!hasName(upper)) out.push({ line, column: start + 1, name: run });
      return false; // 一行至多一个名字槽
    });
  }
  return out;
}

/** 诊断码（问题面板 / 工具提示分组；与糖线 `sugar.*`、表达式线 `erb.expr-*` 同族命名） */
export const UNDEFINED_CALL_CODE = 'erb.call-undefined';

/**
 * 未定义 CALL 目标的波浪线（`ui.editor.decorator` 贡献的**单一真源**，插件接线共用它）。
 *
 * **同步主线程执行、不搬 worker**：判据要读 `ErbIndex.byName`（项目态），搬进 worker
 * 就得复制索引——取舍与 `.kojo` 转译同款（字典/时机表是项目态，硬搬造假错）。
 * 索引缺席（未开项目 / 还没建好）⇒ 调用方（插件）**一条不报**：fail-open 是纪律，
 * "全红"比"没有提示"糟得多；索引几秒后建好，波浪线随之而来。
 * 非方言文件（`.kojo` 的诊断另有糖线管）与空文本 ⇒ 空数组。
 */
export function erbReferenceDecorations(
  { path, text }: EditorDecoratePayload,
  hasName: (upper: string) => boolean,
): LineDecoration[] {
  if (!isErbDialectPath(path) || text.length === 0) return [];
  return scanUndefinedCallTargets(text, hasName).map((t) => ({
    line: t.line,
    severity: 'warning' as const,
    message: `未定义的调用目标「${t.name}」：项目索引里没有这个函数名（动态拼接请改用 CALLFORM 系）`,
    startColumn: t.column,
    endColumn: t.column + t.name.length,
    code: UNDEFINED_CALL_CODE,
  }));
}

/**
 * 聚合为反向索引（与 `aggregateIndex` 同一条**顺序确定**纪律：
 * 入参 `files` 的迭代序 = 本次 walkDir 序 ⇒ 每个名字的引用表按 文件→行→列 确定排序）。
 * `filePath` 复用 `ErbFile.path` 的同一字符串实例——几百万引用点不各拷一份路径。
 */
export function buildReferenceIndex(
  files: Iterable<ErbFile>,
  refsByPath: ReadonlyMap<string, FileRefs>,
): ErbReferenceIndex {
  const bySymbol = new Map<string, ErbReference[]>();
  for (const file of files) {
    const runs = refsByPath.get(file.path);
    if (runs === undefined) continue;
    for (const [name, line, column, kind] of runs) {
      let list = bySymbol.get(name);
      if (list === undefined) {
        list = [];
        bySymbol.set(name, list);
      }
      list.push({ filePath: file.path, line, column, endColumn: column + name.length, kind: KIND_BY_FLAG[kind]! });
    }
  }
  return { bySymbol };
}

/** 查询：谁引用了 `name`（原样/大写均可；无索引 / 无名 ⇒ 空数组。**纯函数，不读盘**） */
export function referencesOf(index: ErbIndex, name: string): ErbReference[] {
  const hit = index.references?.bySymbol.get(name.toUpperCase());
  return hit === undefined ? [] : hit.slice();
}

/**
 * 光标处的记号 → 它的引用点全集（find-references 的数据面，**纯函数**）。
 *
 * 判据与 rename 完全同源：光标词整串在 `bySymbol` 里有记录才给（未收录 = 空数组，
 * **不猜**）；查询单一真源是 `referencesOf`，本函数只补"光标 → 名字"这一步
 * （`functionNameTokenAt`，与 `definitionTargetsAt` **同一个函数**，不是"同一把尺子"
 * 的两种写法——中文函数名上两条腿要么一起跳、要么一起不跳，各用各的尺必然漂）。
 *
 * **分类随位置走**（W8 XLANG-RENAME，2026-10-17）：`kind` 原样带进契约位置
 * （`EditorSymbolLocation.kind` 是 additive 可选成员，旧消费方看不见它照常工作）。
 * 这是"F12 的 N 处 / 「被调用」M 处 / code-lens 的 K 处"三套计数唯一的分类真源——
 * 分类死在本模块、面板各数各的，差值就永远没人能解释。
 */
export function erbReferenceLocationsAt(
  index: ErbIndex,
  text: string,
  line: number,
  column: number,
): EditorSymbolLocation[] {
  if (!Number.isFinite(line) || !Number.isFinite(column)) return [];
  const n = Math.trunc(line);
  if (n < 1) return [];
  const lineText = text.replace(/\r\n?/g, '\n').split('\n')[n - 1];
  if (lineText === undefined) return [];
  const token = functionNameTokenAt(lineText, Math.trunc(column));
  if (!token) return [];
  return referencesOf(index, token.text).map((ref) => ({
    filePath: ref.filePath,
    line: ref.line,
    column: ref.column,
    kind: ref.kind,
  }));
}

/**
 * 光标处记号的**分类计数**（面板 / 状态栏读数，**纯函数**）。
 *
 * 与 `erbReferenceLocationsAt` 同一个 `referencesOf` 真源、同一次遍历——
 * 消费方（宿主台账 `ui/reference-utils.ts` 的 tally）要的"定义 a / 调用 b / 提及 c"
 * 在这里算，不在任何面板里再扫一遍 `bySymbol`（那正是 W8 要收口的第二判据）。
 */
export function erbReferenceKindCounts(
  index: ErbIndex,
  normalizedName: string,
): { definition: number; call: number; mention: number; total: number } {
  let definition = 0;
  let call = 0;
  let mention = 0;
  for (const ref of referencesOf(index, normalizedName)) {
    if (ref.kind === 'definition') definition++;
    else if (ref.kind === 'call') call++;
    else mention++;
  }
  return { definition, call, mention, total: definition + call + mention };
}
