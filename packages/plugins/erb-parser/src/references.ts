import type {
  EditorDecoratePayload,
  EditorSymbolLocation,
  ErbDimReference,
  ErbDimReferenceIndex,
  ErbFile,
  ErbIndex,
  ErbReference,
  ErbReferenceIndex,
  ErbReferenceKind,
  LineDecoration,
  SymbolToken,
} from '@kojo/plugin-api';
import { isErbDialectPath, MODEL_TOKEN_CLASS, unicodeTokenAt } from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';
import type { ErbDimEntry } from './dim-index';
import { CASE_FOLD_CLASS, CASE_FOLD_CODE, detachString, erbCodePrefixLength, forEachDimNameRun } from './scanner';

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

/**
 * `CALL_FAMILY` 里引擎**置了 `IS_TRY`** 的那几枚（`FunctionIdentifier.cs` 的注册行）：
 * - `TRYCALL` = `new CALL_Instruction(false, false, true, false)`（第三实参 `isTry` ⇒ `flag |= IS_TRY`）
 * - `TRYCCALL` = `new CALL_Instruction(false, false, true, true)`（`IS_TRY | IS_TRYC`）
 * - `TRYCALLLIST` = `addFunction(..., EXTENDED | FLOW_CONTROL | PARTIAL | IS_TRY)`
 * - `TRYCCALLLIST` **引擎根本没有这个词**（`BuiltInFunctionCode` 里没有），是 `CALL_FAMILY` 的
 *   历史遗留成员；名字是 TRY 形，按 TRY 档处理（fail-open 方向，见 `scanUndefinedCallTargets`）。
 *
 * 为什么要这张第二档表：引擎按名调用那一步的判据是
 * `Instraction.Child.cs` 的 `if ((call == null) && (!func.Function.IsTry())) FunctionoNotFoundName = …`
 * —— **TRY 系调用找不到函数是引擎允许的行为**（作者就是拿它当可选钩子用的：装了 MOD 才存在、
 * 没装就什么也不做），`GOTO`/`JUMP` 标签那两条（同文件 :3904 / :3936）同款。
 * 于是 TRY 系的目标缺失**不是缺陷**，静态层不许报（D03 批②：基线语料 23 条里 21 条正是这一档）。
 * 反过来，非 TRY 的 `CALL X` 目标缺失照旧是确凿缺陷 ⇒ 照报，warning 档不变、不稀释。
 */
const TRY_CALL_FAMILY: ReadonlySet<string> = new Set(['TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']);

/** 引用种类旗标（盘上/内存共用的三值；`KIND_BY_FLAG` 是它到契约字符串的映射） */
export const KIND_DEFINITION = 0;
export const KIND_CALL = 1;
export const KIND_MENTION = 2;
/** 旗标 → 契约种类（增量局部重建与全量聚合共用同一张映射——各写一遍就是第二判据） */
export const KIND_BY_FLAG: readonly ErbReferenceKind[] = ['definition', 'call', 'mention'];

/**
 * 单文件引用流水的**步长**：每 4 格一条引用，依次是 `归一化名, 行, 列, 种类旗标`。
 * `endColumn` 不落盘（= column + 名字长度，可派生——快照瘦身 v3 的同一条纪律）。
 * 名字统一存**归一化大写**：引用原文可以小写，但索引键只有大写形态。
 *
 * **为什么是扁平数组而不是每条一个四元组**（MEM-7 批，2026-10-30）：
 * 真语料 3,971 文件 / 341,779 条引用，一条一个 `[name, line, column, kind]` 要付
 * **一枚 JSArray 头（32 B）+ 一枚 FixedArray 底层（≈69 B）**，合计 29.1 MB（消融实测
 * `refs 引用流水 -29.1MB`，稳态 171.7 MB 里最大的一块单一数组）。扁平化之后只剩
 * **每文件一枚数组**（3,971 枚），341,779 × 4 格里 3 格是 Smi（V8 内联在 FixedArray 里、
 * 不装箱），名字格是已去重的指针 ⇒ 稳态约 6 MB。
 *
 * 形态代价说明白：`for (const [name, line, column, kind] of refs)` 这种写法没有了，
 * 步长这件事只许住在 {@link forEachRef} 里（两处各写一遍 `i += 4` 就是第二判据）。
 */
export const REF_STRIDE = 4;

/**
 * 单文件的引用流水（按行、列升序；构建序确定 ⇒ 聚合序确定）。
 * 扁平存放，布局见 {@link REF_STRIDE}——**别直接按下标遍历**，用 {@link forEachRef}。
 */
export type FileRefs = readonly (string | number)[];

/**
 * 按引用逐条遍历扁平流水（**步长布局的唯一出处**）。
 *
 * `kind` 交的是**盘上那个旗标**（{@link KIND_DEFINITION} / {@link KIND_CALL} /
 * {@link KIND_MENTION}），不是字符串——热路径上不额外查表，需要 `ErbReferenceKind` 的
 * 调用方自己 `KIND_BY_FLAG`（同在本模块）。
 *
 * 用回调而不是生成器：341,779 条引用在聚合与着色两条热路径上都要过，生成器每条要付
 * 一次 `{value,done}` 分配，白白造出 34 万个短命对象。
 */
export function forEachRef(
  refs: FileRefs,
  visit: (name: string, line: number, column: number, kind: number) => void,
): void {
  for (let i = 0; i < refs.length; i += REF_STRIDE) {
    visit(refs[i] as string, refs[i + 1] as number, refs[i + 2] as number, refs[i + 3] as number);
  }
}

/**
 * 归一化换行后**切一次行**（`visibleCodeLines` / `parseErbText` 共用）：24,197 行实测 2.6 ms，
 * 贵的是每多一家消费方就多一遍整篇遍历（16.8 ms/遍）。
 *
 * R7B（2026-10-31）：实现收口到 `@kojo/plugin-api/eol::splitEolLines`，且**不再先 join
 * 回整串再切**——旧写法 `replace(/\r\n?/g,'\n').split('\n')` 在真语料 1.17 亿码元上单遍
 * **2,415ms**，新写法在已归一化的正文上 `indexOf('\r')` 直接命中 ⇒ **< 1ms**，有 `\r`
 * 时也只切一遍（836ms）。产出逐元素相等（`plugin-api/tests/eol.test.ts` 钉死）。
 */
export function splitErbLines(text: string): readonly string[] {
  return splitEolLines(text);
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
export function codeViewOf(line: string): string {
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
 * 「这一段记号是不是**变量成员名**」的判据：只有**前置**冒号算成员（`CFLAG:ALPHA` 里的
 * `ALPHA`）；`CFLAG` 本身是变量，仍算一次变量提及。
 *
 * 为什么与 {@link colonAdjacent} 分开而不是复用它：两者回答的问题不同——函数那侧
 * **基名与成员名都不算函数**（`CFLAG` 是变量不是函数），变量这侧**基名算变量**。
 * 合并成一个函数就得给调用方加分支，那才是真的第二判据。口径与 `symbols.ts` 的
 * `erbDimReferencesAt` 逐字一致（那里只判 `prev`）。
 */
function colonPrefixed(code: string, start: number): boolean {
  if (start === 0) return false;
  const before = code.charCodeAt(start - 1);
  return before === COLON_HALF || before === COLON_FULL;
}

/**
 * 一行代码里的**变量提及**（`#DIM` 族名的出现点）——单行、单趟、码位备忘表直走。
 *
 * 为什么不能复用 {@link forEachToken} 的记号段：函数名的记号尺是契约的
 * `MODEL_TOKEN_CLASS`（只认字母、数字、下划线），而变量名的字符集是
 * `isErbDimNameChar`（排除集之外全算）。两者在真语料上**不等价**——
 * `楽譜最大数（シリーズ毎）`、`継続率_５０％` 这类名字含全角括号 / 百分号，
 * 记号尺会把它们从中间劈开，劈开之后永远匹配不上声明名（真语料全局声明 3.2%
 * 是这种，且它们**真的在代码里被使用**）。所以变量腿有自己的一趟切段，
 * 与声明侧切名（`parseDimDeclaration`）同一把尺子——**切段本身住在 `scanner.ts`**
 * （`forEachDimNameRun`），字符集与它的备忘表都在那一处。
 *
 * 代价与门：形状键（首码位 · 尾码位 · 长度）先查一次数值 Set，不过就不切 `slice`、
 * 不做 `toUpperCase`——真语料 913 万段实测：只看首码位放行 60.6%，
 * 加上尾码位与长度只剩 10.3%。
 *
 * 成员访问（`FLAG:名前`）不算变量引用：判据 {@link colonPrefixed}，与函数腿的
 * {@link colonAdjacent} 刻意分开（理由见那一枚的注）。
 */
function scanDimRuns(code: string, line: number, dims: DimNameScan): void {
  forEachDimNameRun(code, (start, end, exact, needsFold) => {
    // `exact === false`：这一段含"大写改长度"的码元，键的长度维与名录对不上 ⇒ 门不许用，
    // 直接耗一次 `toUpperCase` 让 `has` 裁决（宁可慢一趟，不许假阴）。
    if (exact && !dims.shapes.has(dimNameShapeKey(code, start, end))) return;
    if (colonPrefixed(code, start)) return;
    // 切段那一趟已经逐码元算过 `needsFold`，归一入口收下它就不再扫第二遍。
    const upper = normalizedUpper(code.slice(start, end), needsFold);
    if (!dims.has(upper)) return;
    dims.emit(upper, line, start + 1);
  });
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

/**
 * 逐记号遍历（`scanFileRefs` / `scanUndefinedCallTargets` 共用，单一真源）：
 * 对每段连续记号回调 `(start, end, needsFold)`（UTF-16 半开区间，与旧 `TOKEN_RE.exec` 的
 * `m.index` / `m.index + m[0].length` 同位）；回调返回 `false` 中止遍历
 * （对应旧循环的 `break`）。
 *
 * W7-G：`needsFold` 是遍历时**顺带**记下的"这段记号里有没有码元会被大写化改动"，
 * 判据与 `normalizedUpper` 是同一张表（`CASE_FOLD_CLASS`），于是调用方能省掉
 * "无需折叠就整段 toUpperCase"的那一遍全文扫描。判据仍只有 `normalizedUpper` 一条
 * （`needsFold === false` 时它的结果按定义就是原串；`true` 时仍交给它算）。
 *
 * 2026-11-05 收口：这里原来只认 `[a-zａ-ｚ]`，对 `α` / `я` / 增平面小写一律答 false，
 * 而名录键是裸 `toUpperCase()` ⇒ 那些名字的引用点静默消失。现在**判据不放宽、也不收紧，
 * 而是换成同一张折叠表**：名录与提及永远同判。高代理保守答 true（孤立码元问大小写
 * 没有意义，交整串 `toUpperCase()` 裁决）。
 */
function forEachToken(s: string, visit: (start: number, end: number, needsFold: boolean) => boolean | void): void {
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
    let needsFold = (startCode >= 0xd800 && startCode <= 0xdbff) || CASE_FOLD_CLASS[startCode] !== 1;
    i += len;
    while (i < n) {
      const code = s.charCodeAt(i);
      const next = tokenCharLen(s, i, code);
      if (next === 0) break;
      if (!needsFold && ((code >= 0xd800 && code <= 0xdbff) || CASE_FOLD_CLASS[code] !== 1)) needsFold = true;
      i += next;
    }
    if (visit(start, i, needsFold) === false) return;
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
 *
 * `window`（R1，2026-10-28）给了就只产出该区间内的行——**判据一字不动**，少的是窗口外的
 * 判读：52,601 行实测整篇 **33.6 ms** → 带 `fromOffset` 的 400 行窗口 **0.44–0.54 ms**
 * （其中 0.26 ms 是一趟 `[SKIP` 搜索；不带偏移的老路 1.53–2.54 ms）。不给 = 整篇，逐字不变。
 */
export function* visibleCodeLines(text: string, window?: VisibleLineWindow): Generator<VisibleCodeLine> {
  if (window === undefined) {
    yield* visibleCodeLinesOf(splitErbLines(text));
    return;
  }
  yield* visibleCodeLinesWindowed(text, window);
}

/** 行窗口（1 基闭区间）。`from > to` / 非有限值 = 没窗口（调用方按"整篇"处理） */
export interface VisibleLineWindow {
  readonly from: number;
  readonly to: number;
  /**
   * `from` 行**行首**在 `text` 里的字符偏移（可选；同契约 `EditorLineWindow.startOffset`）。
   *
   * 没有它就只数换行走过去：**42 ns/行**，52,601 行的文末窗口光走位 2.2 ms。校验不过
   * （不是行首 / 越界 / 与 `from` 不自洽）⇒ 静默退回走位，**结果逐条不变**。
   */
  readonly fromOffset?: number;
  /**
   * 窗口起点是否已在 `[SKIPSTART]` 块里（可选）。**只有本包内部会填**——语义着色那条路
   * 为了切声明腿已经算过一次（{@link skipBlockAt}），再让引用腿算一遍就是同一趟
   * `[SKIP` 子串搜索付两次（666 k 字符实测 **0.30 ms**，一行的窗口上它是主要成本）。
   *
   * 缺省 = 自己算（{@link skipStateBefore}），所以外部调用方与老调用方判据一字不变。
   */
  readonly skipState?: boolean;
}

/** 同一判据在**已切好的行数组**上跑（{@link splitErbLines} 的产物；判据一字未动） */
function* visibleCodeLinesOf(lines: readonly string[]): Generator<VisibleCodeLine> {
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const verdict = judgeRawLine(lines[i]!, i, inSkipBlock);
    if (typeof verdict === 'string') {
      if (verdict === 'enter-skip') inSkipBlock = true;
      else if (verdict === 'leave-skip') inSkipBlock = false;
      continue;
    }
    yield verdict;
  }
}

/**
 * 窗口版：**从第 1 行起算**（屏蔽状态跨行，不能从窗口中间起），但"起算"不等于"逐行判读"
 * ——两条路都只把**状态**带到窗口起点：有 `fromOffset` ⇒ {@link skipStateBefore}（跳着找
 * `[SKIP`，成本与前面有多少行无关）；没有 ⇒ {@link walkToLine}（逐行数换行，每行只过快筛）。
 *
 * `\n` 行边界 + 去掉行尾一个 `\r`，与 `normalizeEol(text).split('\n')` 逐字等价；孤立的
 * `\r` 不当换行（Monaco model 已按 EOL 归一，宿主路径不存在这一档）。
 */
function* visibleCodeLinesWindowed(text: string, window: VisibleLineWindow): Generator<VisibleCodeLine> {
  const from = Math.max(1, Math.trunc(window.from));
  const to = Math.trunc(window.to);
  // `to = Infinity` 合法（走到文末为止）：只挡 NaN 与空区间
  if (!Number.isFinite(from) || Number.isNaN(to) || to < from) return;

  const anchored = anchorOffsetOf(text, window.fromOffset, from);
  let inSkipBlock: boolean;
  let start: number;
  if (anchored !== undefined) {
    inSkipBlock = window.skipState ?? skipStateBefore(text, anchored);
    start = anchored;
  } else {
    const reached = walkToLine(text, from);
    if (reached === undefined) return; // 文本比窗口短：这一行不存在
    inSkipBlock = reached.inSkipBlock;
    start = reached.offset;
  }

  let line = from;
  while (line <= to) {
    const nl = text.indexOf('\n', start);
    const stop = nl === -1 ? text.length : nl;
    const end = stop > start && text.charCodeAt(stop - 1) === 13 ? stop - 1 : stop;
    const verdict = judgeRawLine(text.slice(start, end), line - 1, inSkipBlock);
    if (typeof verdict === 'string') {
      if (verdict === 'enter-skip') inSkipBlock = true;
      else if (verdict === 'leave-skip') inSkipBlock = false;
    } else {
      yield verdict;
    }
    if (nl === -1) return;
    start = nl + 1;
    line += 1;
  }
}

/**
 * 校验调用方给的 `fromOffset` 能不能当"第 `from` 行行首"用（不能就给 `undefined`，退回走位
 * ——**判据不因宿主给错而变**）：只收 `from === 1 && offset === 0`，或紧跟在 `\n` 之后。
 */
function anchorOffsetOf(text: string, fromOffset: number | undefined, from: number): number | undefined {
  if (fromOffset === undefined || !Number.isFinite(fromOffset)) return undefined;
  const at = Math.trunc(fromOffset);
  if (at < 0 || at > text.length) return undefined;
  if (at === 0) return from === 1 ? 0 : undefined;
  return text.charCodeAt(at - 1) === 10 ? at : undefined;
}

/**
 * 窗口之前那一小段的屏蔽状态（`offset` = 窗口第一行行首）。
 *
 * 只在 `[0, offset)` 里**跳着**找 `[SKIP`：能改状态的只有 `[SKIPSTART]` / `[SKIPEND]` 两枚
 * 严格等值的标记行，其余行内容再花也不影响状态。命中一枚就把整行交给 {@link judgeRawLine}
 * （唯一判据）；非标记命中（`CALL [SKIPX],1` 之类）的可见行结论这里不要。
 * 成本 = 一趟子串搜索（52,601 行实测 **0.26 ms**）+ 每枚标记一次判读。
 */
function skipStateBefore(text: string, offset: number): boolean {
  // 窗口就在文首（打开文件的第一屏，最常见的一档）：前面没有任何行，一趟搜索都不该跑
  if (offset <= 0) return false;
  let inSkipBlock = false;
  let at = text.indexOf(SKIP_MARKER_PROBE);
  while (at !== -1 && at < offset) {
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const nl = text.indexOf('\n', at);
    const stop = nl === -1 ? text.length : nl;
    const end = stop > lineStart && text.charCodeAt(stop - 1) === 13 ? stop - 1 : stop;
    // `index` 只给可见行编号，这里只取状态结论 ⇒ 恒传 0
    const verdict = judgeRawLine(text.slice(lineStart, end), 0, inSkipBlock);
    if (verdict === 'enter-skip') inSkipBlock = true;
    else if (verdict === 'leave-skip') inSkipBlock = false;
    at = text.indexOf(SKIP_MARKER_PROBE, at + 1);
  }
  return inSkipBlock;
}

/**
 * 第 `lineOffset` 行（行首偏移）**之前**是否处在 `[SKIPSTART]` 块里。
 *
 * 对外只有一个消费方：语义着色的窗口路径把窗口那几行**切片**重解析（`parseErbText` 判据
 * 单源），而切片丢掉的前缀里可能正开着 `[SKIPSTART]`——补一行合成标记即可，判据一字不动。
 * 别用"数标记个数 / 看首行"之类去猜：窗口起点正好落在块内那一档就会错，而那一档恰恰是
 * 大文件滚动时最常见的一档。
 */
export function skipBlockAt(text: string, lineOffset: number): boolean {
  return skipStateBefore(text, lineOffset);
}

/** 一段行窗口的原文 + 它在全文里的坐标（`firstLine` 是 `text` 第 1 行的 1 基行号） */
export interface WindowSlice {
  readonly text: string;
  readonly firstLine: number;
  /** `firstLine` 那行的行首在**原文**里的偏移（{@link skipBlockAt} 直接吃它） */
  readonly offset: number;
}

/**
 * 切出窗口那几行的原文（**O(窗口)**，与文件大小无关）。
 *
 * 为什么是"切片重解析"而不是"带窗口重解析"：`parseErbText` 只认整篇文本，给它一段切片
 * 得到的函数 / `#DIM` 声明与整篇跑出来按行过滤**逐条相同**（跨行状态只有 `[SKIPSTART]`，
 * 由调用方补合成标记）。24,197 行整篇 2.95 ms ⇒ 400 行切片 ~0.05 ms。
 *
 * 行尾口径与 {@link splitErbLines} 一致的地方由 `parseErbText` 自己的 `normalizeEol` 兜住
 * ——切片边界只在 `\n` 上切，`\r\n` 原样留给下游归一。
 */
export function windowSliceOf(text: string, window: VisibleLineWindow): WindowSlice | null {
  const from = Math.max(1, Math.trunc(window.from));
  const to = Math.trunc(window.to);
  if (!Number.isFinite(from) || Number.isNaN(to) || to < from) return null;
  const anchored = anchorOffsetOf(text, window.fromOffset, from);
  let start: number;
  if (anchored !== undefined) {
    start = anchored;
  } else {
    const reached = walkToLine(text, from);
    if (reached === undefined) return null;
    start = reached.offset;
  }
  let end = start;
  for (let line = from; line < to; line++) {
    const nl = text.indexOf('\n', end);
    if (nl === -1) {
      end = text.length;
      break;
    }
    end = nl + 1;
  }
  if (end < text.length) {
    const nl = text.indexOf('\n', end);
    end = nl === -1 ? text.length : nl;
  }
  return { text: text.slice(start, end), firstLine: from, offset: start };
}

/**
 * 没有 `fromOffset` 时：逐行数换行走到第 `from` 行，顺手把屏蔽状态带上（文本比 `from` 短
 * ⇒ `undefined`）。前缀每行**只过快筛**，命中的才真判读；游标由本循环持有——每行一次
 * `indexOf('[SKIP')` 在"文里没有标记"的语料上每次都要扫到文末，52,601 行实测 **6,056 ms**。
 */
function walkToLine(text: string, from: number): { offset: number; inSkipBlock: boolean } | undefined {
  let inSkipBlock = false;
  let line = 1;
  let start = 0;
  let nextMarkerAt = text.indexOf(SKIP_MARKER_PROBE);
  while (line < from) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return undefined;
    if (nextMarkerAt !== -1 && nextMarkerAt < nl) {
      // 不变量 `nextMarkerAt === -1 || nextMarkerAt >= start` 保证命中在本行内；行尾 `\r`
      // 不剥——`judgeRawLine` 第一步就是 `trim()`，结论逐字相同。
      const verdict = judgeRawLine(text.slice(start, nl), line - 1, inSkipBlock);
      if (verdict === 'enter-skip') inSkipBlock = true;
      else if (verdict === 'leave-skip') inSkipBlock = false;
    }
    start = nl + 1;
    line += 1;
    if (nextMarkerAt !== -1 && nextMarkerAt < start) nextMarkerAt = text.indexOf(SKIP_MARKER_PROBE, start);
  }
  return { offset: start, inSkipBlock };
}

/** 快筛子串（两枚标记的文字形都以它开头）。只决定"要不要跑判读"，判据仍在 `judgeRawLine` */
const SKIP_MARKER_PROBE = '[SKIP';

/** 判读结论：一条可见行，或"这一行只是状态变化 / 不可见" */
type LineVerdict = VisibleCodeLine | 'enter-skip' | 'leave-skip' | 'hidden';

/**
 * **单行的全部判据**（唯一一份；整篇遍历与窗口遍历都叫它）。
 *
 * `inSkipBlock` 进、状态结论出：调用方只管把 `enter-skip` / `leave-skip` 记进自己的状态，
 * 判据本身不外流。`index` 是 0 基行号（产出的 `line` 是 1 基）。
 *
 * 屏蔽区里**只认** `[SKIPEND]`（嵌套的 `[SKIPSTART]` 不算新的一层，与 `parseErbText` 同判）；
 * 不在屏蔽区时**只有**整行严格等于 `[SKIPSTART]` 才进；一个没有配对 START 的裸 `[SKIPEND]`
 * 不是标记（它落进下面的普通代码行判据）——这几条都是旧实现的逐字口径，别在这里"顺手改好"。
 */
function judgeRawLine(raw: string, index: number, inSkipBlock: boolean): LineVerdict {
  const outer = raw.trim();
  // 代码前缀（`;!;` / `;#;`）剥掉后再判可见性：这两种前缀之后是真代码（判据单源
  // `code-prefix.ts`）。`prefixLen` 只用来修列坐标，正文比原串短这么多。
  const prefixLen = erbCodePrefixLength(outer);
  const trimmed = prefixLen === 0 ? outer : outer.slice(prefixLen);
  if (inSkipBlock) {
    return trimmed === '[SKIPEND]' ? 'leave-skip' : 'hidden';
  }
  // 区间标记的严格等值判据与 `parseErbText` 逐字同源（取证读数与"为什么不放开大小写"见该处注释）
  if (trimmed === '[SKIPSTART]') return 'enter-skip';
  if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('$')) {
    return 'hidden';
  }

  if (trimmed.startsWith('@')) {
    // 定义行：名字提取按解析器口径（调用方自理）；调用判据一概不适用
    return { line: index + 1, raw, codeView: () => '', isDefinition: true, isCallLine: false, keywordEnd: -1 };
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
  // 名字槽起点（行内 0 基偏移）= 缩进 + 代码前缀宽 + 关键字长度；缩进只算行首空白
  // （trailing 会干扰差值）
  const keywordEnd = isCallLine ? raw.length - raw.trimStart().length + prefixLen + leadLen : -1;
  let codeCache: string | undefined;
  return {
    line: index + 1,
    raw,
    codeView: () => (codeCache ??= codeViewOf(raw)),
    isDefinition: false,
    isCallLine,
    keywordEnd,
  };
}

/** 摊平一份可见行给**多消费者共用**（同一份数组可反复迭代；只在该轮里活着，不跨轮缓存） */
export function visibleCodeLineList(lines: readonly string[]): VisibleCodeLine[] {
  return [...visibleCodeLinesOf(lines)];
}

/**
 * 归一化快路径：无需大写化就不分配 `toUpperCase` 副本（412 万行的热路径）。
 *
 * **语义严格等于 `run.toUpperCase()`**——判据读 `CASE_FOLD_CLASS`（表本身由
 * `toUpperCase` 填出），不是手写的 Unicode 区间。旧实现只折 `[a-zａ-ｚ]`：名录键用裸
 * `toUpperCase()`，提及侧却放过了 `α` / `я` / 增平面小写，于是这些名字的引用点
 * 静默消失（PITFALLS 334 的第三处假阴）。现在两条腿共用同一张表，函数腿与变量腿
 * 同时收口。
 *
 * `needsFold` 由**遍历那一趟**顺带算出（`forEachToken` / `forEachDimNameRun`，读同一张表）：
 * 传了就直接用，不再把这一段的码元重扫一遍。真语料 913 万段上，这一枚可选参数就是
 * "归一化保持单一入口"与"refs 段多付 10%"之间的分界。不传（arity / builtins / inlay-hints
 * 这类查询期调用）⇒ 自己扫表，结果逐字相同。
 */
export function normalizedUpper(run: string, needsFold?: boolean): string {
  if (needsFold === true) return run.toUpperCase();
  if (needsFold === false) return run;
  const n = run.length;
  for (let i = 0; i < n; i++) {
    const code = run.charCodeAt(i);
    if ((code >= 0xd800 && code <= 0xdbff) || CASE_FOLD_CLASS[code] !== 1) return run.toUpperCase();
  }
  return run;
}

/**
 * 扫描单文件文本的全部引用流水（**纯函数**：文本进、紧凑记录出，不读盘）。
 *
 * `hasName` 是"这个名字是不是项目里的某个函数"的唯一判据——由调用方拿
 * `ErbIndex.byName` 提供，本模块因此对"项目里有哪些函数"零知识、可独立单测。
 * 行可见性与 `parseErbText` 对齐：`[SKIPSTART]…[SKIPEND]` 屏蔽、整行 `;`、
 * `#` 指令、`$` 标签、`@` 定义行（只取名字记号，形参不扫）。
 *
 * `collect`（REFS-PROVENANCE，2026-10-22，**可选**）：**每一个被拿去问 `hasName` 的
 * 归一化记号**（命中与否都算，含 `@` 定义名）逐个交给它——这是"该文件的候选记号集"，
 * 溯源巡检拿它回答"名录里变掉的名字碰没碰到这个文件"。判据面**一字未动**：
 * 收集发生在 hasName 判定的**前**一步、对同一个 `upper` 串，命中与否不影响收集，
 * refs 产出与不传 `collect` 时逐字节相同（等价对拍见 `refs-offload-equiv.test.ts`）。
 * 成员访问（`colonAdjacent`）的记号**到不了 hasName** ⇒ 也不是候选——与"它们不算引用"
 * 同一条边界，两处各写一遍就是第二判据。
 *
 * `window`（R3，2026-10-28）：只交这一段里的引用（窗口外的行本来也不该出现）。判据一字
 * 未动，跨行的 `[SKIPSTART]` 状态由 {@link visibleCodeLines} 从第 1 行算到窗口起点。
 * 不传 = 整篇，与旧行为逐字节相同。
 */
/** 变量引用腿的扫描参数（2026-11-05 项目级变量引用批） */
export interface DimNameScan {
  /** 这个名字是不是项目里的**全局** `#DIM` 声明名（局部名不进项目索引，见 `dim-index.ts`） */
  readonly has: (normalizedName: string) => boolean;
  /**
   * 名录里所有名字的**形状键**（{@link dimNameShapeKey}，由 {@link dimNameShapesOf} 派生）。
   *
   * 不是可选的加速开关：切段是线性直走，没有它就得为每一段（真语料 913 万段）
   * `slice` + `toUpperCase` 再查表——那正是本批 A/B 读到的 **+3.7 s**（refs 段 5.2 s → 8.9 s）。
   * 要求调用方给，是因为它必须与 `has` **同一份名录**——分开构造就会出现
   * "形状放行、`has` 说不认识"的静默漏答。
   */
  readonly shapes: ReadonlySet<number>;
  /** 命中一处提及（1 基行列，列指向名字首字符） */
  readonly emit: (normalizedName: string, line: number, column: number) => void;
}

/**
 * 名字的**形状键**：首码位 · 尾码位 · 长度（三段互不重叠地拼进一个安全整数）。
 *
 * 为什么是三段而不是只取首码位：真语料 913 万段实测通过率 60.6% → **10.3%**
 * （只加长度是 40.4%，再加尾码位才够）。为什么允许拼成数：`first < 2^16`、
 * `last < 2^16`、`len < 2^16` ⇒ 键 < 2^48，全在 `Number.MAX_SAFE_INTEGER` 内，
 * **不会碰撞**——所以这一关是"放行/否掉"的精确判据，不是近似布隆。
 *
 * 对**码元**取键（`charCodeAt`）：代理对的名字两端各取到配对的那一半，与声明的名字
 * 用同一把尺子，故拼接结果一致。
 *
 * 两端折叠直接读 `CASE_FOLD_CODE`，即与 `normalizedUpper` / `needsFold` / `exact` **同一张
 * 折叠表**：名录里的名字是归一化大写，代码里的提及可能是 `kojo_name`、`α`、`straße`，
 * 门按原样比就会整段否掉——那是**假阴**，而这一关的契约是"只许放过、不许误杀"。
 * 表由 `toUpperCase` 本身填出，所以不存在"折叠区间写漏一段"这种可能（旧实现内联了
 * `[a-z]` / `[ａ-ｚ]` 两段区间，是 PITFALLS 334 的成因）。
 *
 * **长度维只在"大写不改长度"时成立**：`ß` → `SS`、连字 `ﬀ` → `FF` 会让名录里的大写名
 * 比原文长，键的长度就对不上。这一格不靠注释自律——切段那一趟已经知道段里有没有
 * 这种码元（`forEachDimNameRun` 的 `exact`，同样读那张表的 `3` 类），有就**整个绕过这道门**，
 * 交给 `has` 裁决。所以本键的契约是：**只对 `exact === true` 的段用**。
 */
export function dimNameShapeKey(code: string, from: number, to: number): number {
  const first = CASE_FOLD_CODE[code.charCodeAt(from)]!;
  const last = CASE_FOLD_CODE[code.charCodeAt(to - 1)]!;
  return first * 4294967296 + last * 65536 + (to - from);
}

/** 名录 → 形状键集（{@link DimNameScan.shapes} 的唯一构造点；空名跳过，与名录口径一致） */
export function dimNameShapesOf(names: Iterable<string>): ReadonlySet<number> {
  const out = new Set<number>();
  for (const name of names) {
    if (name.length > 0) out.add(dimNameShapeKey(name, 0, name.length));
  }
  return out;
}

/**
 * 单文件文本 → 变量提及流水（**缓冲区本地腿**的入口，`symbols.ts` 的
 * `erbDimReferencesAt` 用它；索引构建那条腿走 {@link scanFileNames} 的同一条
 * {@link scanDimRuns}，两条腿的切段判据只有一份）。
 *
 * `window` 语义与 {@link scanFileNames} 相同（不传 = 整篇）。
 */
export function scanDimRefs(
  text: string,
  has: (normalizedName: string) => boolean,
  shapes: ReadonlySet<number>,
  window?: VisibleLineWindow,
): FileDimRefs {
  const out: (string | number)[] = [];
  const sink: DimNameScan = {
    has,
    shapes,
    emit: (name, line, column) => void out.push(name, line, column),
  };
  for (const { line, codeView } of visibleCodeLines(text, window)) scanDimRuns(codeView(), line, sink);
  return out;
}

/**
 * 光标列（0 基）→ 所在**变量名字段**（`erbDimReferencesAt` 在**提及**位置的取词判据）。
 *
 * 与 `scanDimRefs` / `scanFileNames` 共用同一条 `visibleCodeLines`（整行屏蔽与
 * `[SKIPSTART]`）、同一份 `codeView()`（字符串与行内 `;` 刷白）、同一把
 * `forEachDimNameRun` 变量切段尺、同一条 `colonPrefixed` 成员访问退让、同一枚
 * `normalizedUpper`。所以"索引里记着的提及"与"光标取到的词"永远同形：
 * 注释里的同名散文、字符串内容、成员名一律取不到词。
 *
 * 这条正面解决了 2026-11-05 首版把提及位置**整条弃权**的顾虑——当时担心"任意变量
 * 位置上按键会把同名散文卷进来"，而可见代码视图本来就刷白了那些位置。少答不是判据，
 * 看得见才答才是。贴着段尾后一格也算落在词上（与声明行 `nameStart + len` 同款）。
 */
export function dimNameRunAt(
  text: string,
  line: number,
  col0: number,
): { name: string; start: number; length: number } | null {
  const at = Math.trunc(line);
  if (!Number.isFinite(col0) || col0 < 0 || at < 1) return null;
  let hit: { name: string; start: number; length: number } | null = null;
  for (const { line: atLine, isDefinition, codeView } of visibleCodeLines(text, { from: at, to: at })) {
    if (atLine !== at || isDefinition) continue;
    const code = codeView();
    forEachDimNameRun(code, (start, end, _exact, needsFold) => {
      if (col0 < start || col0 > end) return;
      if (colonPrefixed(code, start)) return;
      const raw = code.slice(start, end);
      hit = { name: normalizedUpper(raw, needsFold), start, length: end - start };
    });
  }
  return hit;
}

export interface FileNameScanOptions {
  readonly hasName: (normalizedName: string) => boolean;
  readonly collect?: (normalizedName: string) => void;
  readonly window?: VisibleLineWindow;
  /** 缺席 = 只扫函数引用（既有行为，逐字节不变） */
  readonly dims?: DimNameScan;
}

/**
 * 一趟记号遍历，两个名字表（2026-11-05）。
 *
 * 函数引用与变量提及回答的是同一个问题——"这一段可见代码里，哪些记号是某个名字的一次出现"，
 * 区别只在**名字表**与**归类规则**。分成两趟就是把 412 万行再走一遍（真语料实测 refs 段
 * 7.3 s，第二趟同阶），所以两条腿共用同一趟遍历、同一条 `visibleCodeLines` 可见性判据、
 * 同一枚 `forEachToken` 记号尺子。
 *
 * `dims` 缺席时产出与老 `scanFileRefs` **逐字节相同**（`refs-eq` 对拍钉死）。
 */
export function scanFileNames(text: string, options: FileNameScanOptions): FileRefs {
  const { hasName, collect, window } = options;
  /**
   * 空名录 ⇒ 干脆不切段（**不是**判据分叉，是同一判据的零开销特例）：`shapes` 与名录
   * 同一份（`DimNameScan.shapes` 的契约），空集就说明这一段代码里没有任何一个名字可能命中，
   * 切出来的每一段都会被那道门挡掉。没声明过全局 `#DIM` 的项目（纯 kojo2、或变量全是
   * 函数内局部）因此一个码元都不多走。
   */
  const dims = options.dims !== undefined && options.dims.shapes.size > 0 ? options.dims : undefined;
  const out: (string | number)[] = [];
  for (const { line, raw, isDefinition, isCallLine, keywordEnd, codeView } of visibleCodeLines(text, window)) {
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
        if (collect !== undefined) collect(upper);
        if (hasName(upper)) {
          out.push(detachString(upper), line, at + 2 + (slice.length - slice.trimStart().length), KIND_DEFINITION);
        }
      }
      continue;
    }

    let slotTaken = !isCallLine; // 非调用行没有槽位概念，全部走 mention

    const code = codeView();
    // 变量腿：**自己的切段**（`isErbDimNameChar`，见 `scanDimRuns` 的注——记号尺切不动
    // `楽譜最大数（シリーズ毎）` 这类真名字）。挂在同一趟行遍历上，省掉第二趟
    // `visibleCodeLines` 与又一次 `codeView()`。
    if (dims !== undefined) scanDimRuns(code, line, dims);
    forEachToken(code, (start, end, needsFold) => {
      const inSlot = !slotTaken && start >= keywordEnd;
      if (inSlot) slotTaken = true; // 槽位记号无论命不命中名字都被消耗
      const run = code.slice(start, end);
      // 归一入口只有一个：`needsFold` 是遍历时按同一张表顺带算出的，不在这里复述判据。
      const upper = normalizedUpper(run, needsFold);

      // 变量成员访问整体不算函数引用：`CFLAG:ALPHA` 两段都是变量世界（基名紧邻冒号，
      // 如 `ALPHA:CFLAG` 的 ALPHA，即便撞上函数名也不算提及）。判据单源 `colonAdjacent`。
      if (colonAdjacent(code, start, end)) return;
      if (collect !== undefined) collect(upper);
      if (!hasName(upper)) return;
      out.push(detachString(upper), line, start + 1, inSlot ? KIND_CALL : KIND_MENTION);
    });
  }
  // **收尾裁掉增长余量**（MEM-7 实测）：`push` 出来的数组按 V8 的 1.5×+16 增长，真语料
  // 1,367,116 格实测被撑到约 1.45 倍 ⇒ 白占约 2.4 MB。`slice()` 造一份**恰好长度**的副本，
  // 旧数组随即可回收；每文件一次、合计一次元素搬运，构建期代价在毫秒以下。
  // 注意别改成 `out.length = out.length`：那不会缩容量，一分钱都省不下。
  return out.length === 0 ? out : out.slice();
}

/**
 * 扫描单文件文本的全部**函数**引用流水（本函数是 {@link scanFileNames} 的薄壳：
 * 老签名逐字保留，`dims` 缺席 ⇒ 产出与 2026-11-04 之前完全一致）。
 */
export function scanFileRefs(
  text: string,
  hasName: (normalizedName: string) => boolean,
  collect?: (normalizedName: string) => void,
  window?: VisibleLineWindow,
): FileRefs {
  return scanFileNames(text, { hasName, collect, window });
}

/* ---------------- 未定义 CALL 目标（T3，2026-10-16 语言服务批） ---------------- */

/**
 * 名字槽扫出的**一处**未收录裸标识符（波浪线装饰的数据面）。
 * `isTry` 只在该行是 TRY 系直系调用时出现（additive；默认档下不会出现任何带 `isTry` 的条目——
 * TRY 档整条不报，见 {@link scanUndefinedCallTargets}）。
 */
export interface UndefinedCallTarget {
  /** 1 基行号 */
  readonly line: number;
  /** 名字首字符（1 基列） */
  readonly column: number;
  /** 原样记号 */
  readonly name: string;
  /** TRY 系目标缺失（引擎允许的行为；仅 `includeTry` 档下产出） */
  readonly isTry?: true;
}

/** TRY 档之外还要拿到 TRY 条目的调用方（信息层）显式开这个；默认关 ⇒ 现有 warning 面零膨胀 */
export interface CallTargetScanOptions {
  readonly includeTry?: boolean;
}

/**
 * 引擎读函数名那一步的**分隔符全集**——判据出处：`ArgumentBuilder.cs` 的
 * `SP_CALL_ArgumentBuilder.CreateArgument`：
 * `LexicalAnalyzer.ReadString(st, StrEndWith.LeftParenthesis_Bracket_Comma_Semicolon)`
 * 再 `str.Trim([' ', '\t'])`。⇒ 引擎眼里的名字只在 `(` / `[` / `,` / `;` / 行尾断开，
 * 其余任何字符（含全角 `＆` `％` `－`、含全角空白）都**还是名字的一部分**。
 */
function engineNameEndsHere(code: string, end: number): boolean {
  if (end >= code.length) return true; // EOL
  const c = code.charCodeAt(end);
  return c === 9 /* \t */ || c === 32 /*   */ || c === 40 /* ( */ || c === 44 /* , */ || c === 59 /* ; */;
}

/**
 * 名字槽**收尾处**能不能当"这就是引擎要查的那个名字"来判（三档，全 fail-open）：
 * 1. `[` 开头 = **子名（subNames）形态** ⇒ 不判。引擎读法：`ReadString` 停在 `[`，随后
 *    `if (cur == '[') subNames = …`，而 `ErbLoader.cs:644` 挂着 `//TODO:subNames 結局実装しないかも`、
 *    全仓 `SubNames` 的**唯一实消费**是 `ErbLoader.cs:1534` 的 TRYGOTOLIST 拒用检查
 *    ⇒ 名字后面的 `[[…]]` / `[…]` 既不是"这个名字不存在"的证据，也不是能静态展平的东西
 *    （语料实例：`TRYCALL M_KOJO_COLOR_K[[莉莉白]]`，括号里是作者当打印记号用的中文色名）。
 * 2. 收尾处不是引擎分隔符 ⇒ 我们的**记号尺比引擎窄**（`forEachToken` 只认字母/数字/下划线），
 *    拿切剩的前缀去查名录必然假报（语料实例：`CALL @MESSAGE_COM61背面立位＆時間停止＆抜かず`
 *    形态，`…＆…` 全名在盘上真实存在，尺子把 `＆` 切成界 ⇒ 假"未定义"）⇒ 不判。
 * 3. 其余（`(` / `,` / `;` / 行尾 / ASCII 空白）⇒ 引擎也会在此收尾，可以判。
 */
function slotIsJudgeable(code: string, end: number): boolean {
  if (end < code.length && code.charCodeAt(end) === 91 /* [ */) return false;
  return engineNameEndsHere(code, end);
}

/** 调用关键字原词（大写归一）；`keywordEnd` 是关键字**之后**的行内偏移，倒着走 ASCII 标识符段 */
function callKeywordOf(raw: string, keywordEnd: number): string {
  let s = keywordEnd;
  while (s > 0) {
    const c = raw.charCodeAt(s - 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) s--;
    else break;
  }
  return raw.slice(s, keywordEnd).toUpperCase();
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
 * - 名字在名录里的（那不是"未定义"）；
 * - **TRY 系直系调用的目标缺失**（引擎允许；`TRY_CALL_FAMILY` 的出处在那张表上）；
 * - 槽位收尾处不是引擎 `ReadString` 的分隔符（子名 `[…]` / 记号尺比引擎窄，
 *   `slotIsJudgeable` 逐条带引擎出处）。
 */
export function scanUndefinedCallTargets(
  text: string,
  hasName: (upper: string) => boolean,
  options?: CallTargetScanOptions,
): UndefinedCallTarget[] {
  const out: UndefinedCallTarget[] = [];
  const includeTry = options?.includeTry === true;
  for (const { line, raw, isCallLine, keywordEnd, codeView } of visibleCodeLines(text)) {
    if (!isCallLine) continue;
    // TRY 系目标缺失是**引擎允许的行为**（`Instraction.Child.cs` 的 `!func.Function.IsTry()` 那道门）
    // ⇒ 默认整条不报；`includeTry` 只给信息层（`erb.call-try-missing` / `info` 档）用，默认不上屏。
    const isTry = TRY_CALL_FAMILY.has(callKeywordOf(raw, keywordEnd));
    if (isTry && !includeTry) continue;
    const code = codeView();
    forEachToken(code, (start, end, needsFold) => {
      if (start < keywordEnd) return; // 关键字自身
      // 槽位 = 关键字后的第一个记号；与关键字之间只许空白 ⇒ 裸标识符
      if (!/^[\t \u3000]*$/.test(raw.slice(keywordEnd, start))) return false;
      // 成员访问占槽：整槽不算函数名，也不向后顺延（判据单源 `colonAdjacent`）
      if (colonAdjacent(code, start, end)) return false;
      // 子名形态 / 记号尺比引擎窄 ⇒ 这一槽**不是**引擎要查的那个名字 ⇒ 不判（见 `slotIsJudgeable`）
      if (!slotIsJudgeable(code, end)) return false;
      const upper = normalizedUpper(code.slice(start, end), needsFold);
      if (!hasName(upper)) out.push({ line, column: start + 1, name: code.slice(start, end), ...(isTry ? { isTry: true } : {}) });
      return false; // 一行至多一个名字槽
    });
  }
  return out;
}

/** TRY 系目标缺失的**信息档**诊断码（与 `erb.call-undefined` 分码：那一档才是确凿缺陷） */
export const UNDEFINED_TRY_CALL_CODE = 'erb.call-try-missing';

/**
 * TRY 系"可选钩子找不到函数"的信息层装饰（D03 批②的第二问：这层信息要不要留？）。
 *
 * 与 `erbReferenceDecorations` **不同码、不同档**：severity 恒为 `info`、消息说清"引擎允许"，
 * 且**默认不接进任何 UI**（`plugin.ts` 只挂 `erbReferenceDecorations`，本函数是给后续车道
 * 显式开的一扇门；开了也不会稀释 warning 面，因为它带的是另一枚码）。
 * 索引缺席 ⇒ 一条不报（同 fail-open 纪律）。
 */
export function tryCallTargetDecorations(
  { path, text }: EditorDecoratePayload,
  hasName: (upper: string) => boolean,
): LineDecoration[] {
  if (!isErbDialectPath(path) || text.length === 0) return [];
  return scanUndefinedCallTargets(text, hasName, { includeTry: true })
    .filter((t) => t.isTry === true)
    .map((t) => ({
      line: t.line,
      severity: 'info' as const,
      message: `可选钩子「${t.name}」没有对应的函数定义：TRY 系的调用找不到函数时引擎照常运行，这一条不算缺陷——需要这段逻辑就给这个名字写一条 #FUNCTION 函数。`,
      startColumn: t.column,
      endColumn: t.column + t.name.length,
      code: UNDEFINED_TRY_CALL_CODE,
      source: 'erb-reference',
    }));
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
    message: `未定义的调用目标「${t.name}」：当前项目里没有这个名字的函数——把函数补上，或改成已有的函数名；名字由几段拼出来时请改用 CALLFORM 调用。`,
    startColumn: t.column,
    endColumn: t.column + t.name.length,
    code: UNDEFINED_CALL_CODE,
    source: 'erb-reference',
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
    const filePath = file.path;
    // 步长布局只经 `forEachRef` 读（见 `REF_STRIDE` 的注）；`filePath` 复用同一枚实例
    forEachRef(runs, (name, line, column, kind) => {
      let list = bySymbol.get(name);
      if (list === undefined) {
        list = [];
        bySymbol.set(name, list);
      }
      list.push({ filePath, line, column, endColumn: column + name.length, kind: KIND_BY_FLAG[kind]! });
    });
  }
  return { bySymbol };
}

/** 查询：谁引用了 `name`（原样/大写均可；无索引 / 无名 ⇒ 空数组。**纯函数，不读盘**） */
export function referencesOf(index: ErbIndex, name: string): ErbReference[] {
  const hit = index.references?.bySymbol.get(name.toUpperCase());
  return hit === undefined ? [] : hit.slice();
}

/* ---------------- 变量（`#DIM` 族）的项目级引用（2026-11-05） ---------------- */

/** 单文件变量引用流水的步长：`[名字, 行, 列, 名字, …]` */
export const DIM_REF_STRIDE = 3;

/** 单文件变量提及流水（按行、列升序；构建序确定 ⇒ 聚合序确定） */
export type FileDimRefs = readonly (string | number)[];

/** 按变量提及逐条遍历扁平流水（**步长布局的唯一出处**） */
export function forEachDimRef(
  run: FileDimRefs,
  visit: (name: string, line: number, column: number) => void,
): void {
  for (let i = 0; i < run.length; i += DIM_REF_STRIDE) {
    visit(run[i] as string, run[i + 1] as number, run[i + 2] as number);
  }
}

/**
 * 把「每文件提及流水」拼成项目级索引（**纯函数**）。
 *
 * 声明点从 `entries` 里取（`dim-index.ts` 的全局声明条目）——它们不在可见代码行里
 * （`#` 行被可见性判据挡住），所以不能指望扫描流水带出来。两路按 `(行, 列)` 归并，
 * 保证同一份输入无论扫描顺序如何都是同一条排序（确定性纪律同 {@link buildReferenceIndex}）。
 *
 * 列口径：**声明点只有行**。索引里没有列事实（`ErbDim` 只有名字/指令/行），凭空算一个
 * "名字在第几列"要重新解析那一行——那是第二个真源；宁可导航落到行首，不伪造列。
 * 契约因此在声明分支上**没有** `endColumn`（见 `ErbDimDefinitionReference` 的注）：
 * 给 `1 + 名字长度` 会让照着画高亮的消费方把 `#DI` 三个字符涂上色。
 */
export function buildDimReferenceIndex(
  files: Iterable<ErbFile>,
  dimRefsByPath: ReadonlyMap<string, FileDimRefs>,
  entries: readonly ErbDimEntry[],
): ErbDimReferenceIndex {
  const defsByPath = new Map<string, ErbDimEntry[]>();
  for (const entry of entries) {
    if (entry.functionStartLine !== undefined || entry.name.length === 0) continue;
    let list = defsByPath.get(entry.filePath);
    if (list === undefined) {
      list = [];
      defsByPath.set(entry.filePath, list);
    }
    list.push(entry);
  }

  const byName = new Map<string, ErbDimReference[]>();
  const push = (name: string, ref: ErbDimReference): void => {
    let list = byName.get(name);
    if (list === undefined) {
      list = [];
      byName.set(name, list);
    }
    list.push(ref);
  };

  for (const file of files) {
    const filePath = file.path;
    const defs = defsByPath.get(filePath);
    const refs = dimRefsByPath.get(filePath);
    let di = 0;
    let ri = 0;
    // 两路都是升序（声明按行、提及按行列）⇒ 一次归并，不排序
    for (;;) {
      const def = defs !== undefined && di < defs.length ? defs[di] : undefined;
      let mention: { name: string; line: number; column: number } | undefined;
      if (refs !== undefined && ri < refs.length) {
        mention = {
          name: refs[ri] as string,
          line: refs[ri + 1] as number,
          column: refs[ri + 2] as number,
        };
      }
      if (def === undefined && mention === undefined) break;
      // 同行不必再比分列：声明行是 `#` 行，`visibleCodeLines` 本来就不产出它 ⇒ 同一个
      // `(文件, 行)` 上不可能既有声明又有提及。真出现（构造的索引）也按"声明在前"定序。
      const defFirst = mention === undefined || (def !== undefined && def.line <= mention.line);
      if (defFirst) {
        push(def!.name.toUpperCase(), {
          filePath,
          line: def!.line,
          column: 1,
          kind: 'definition',
        });
        di++;
      } else {
        push(mention!.name, {
          filePath,
          line: mention!.line,
          column: mention!.column,
          endColumn: mention!.column + mention!.name.length,
          kind: 'mention',
        });
        ri += DIM_REF_STRIDE;
      }
    }
  }

  return { byName };
}

/** 查询：项目里 `name` 的全局出现点（原样/大写均可；无索引 / 无名 ⇒ 空数组。纯函数，不读盘） */
export function dimReferencesOf(index: ErbIndex, name: string): ErbDimReference[] {
  const hit = index.dimReferences?.byName.get(name.toUpperCase());
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
  const lineText = splitEolLines(text)[n - 1];
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
