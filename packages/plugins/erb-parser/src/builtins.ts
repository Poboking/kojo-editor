import type { LineDecoration } from '@kojo/plugin-api';
import { formatEngineErrorText, isErbDialectPath } from '@kojo/plugin-api';
import { erbCallSitesOf, type ArgSpan, type ErbCallSite } from './arity';
import { normalizedUpper, visibleCodeLines, type VisibleCodeLine } from './references';

/**
 * ERB **内建式中函数**（Emuera `exmeth`）签名表 + 实参诊断。
 *
 * ## 数据来源与口径（2026-11-28 换代）
 *
 * - 真源：**eratw core-vm 运行时 `Builtins.registry` 的反射 dump**
 *   （`tools/data/builtin-signatures.tsv`，由 `tools/gen-erb-builtin-signatures.mjs`
 *   内联成下面的生成区间）。eratw 是数千玩家实际游玩校验过的线上项目，
 *   每条 `minArgs` / `maxArgs` / `variadicGroup` 都是 `BuiltinMethod.checkArity`
 *   真正在用的那份元数据，比 Era Wiki 手抄页可靠。
 * - 旧表是 Wiki 手抄 170 名，其中 **16 个名字在 1.824 与 4.981 两棵反编译树里零命中**
 *   （`SETBIT` / `CHK_HININ_LOVE` / `FIRSTTIME` 等其实是 eraTW 的 `@FUNC` 用户函数，
 *   或根本不存在）——把它们当内建会让补全推荐不存在的函数、并让这些名字的
 *   形参诊断走错腿。换代后一律以注册表为准。
 * - 条数 331（含 fork 扩展 `SQL_*` / `MAP_*` / `DT_*` / `XML_*` / `ENTITY_*` 整族）。
 * - 本表是**静态数据**：不进索引契约、不进快照（否则 `SNAPSHOT_VERSION` 要无谓抬版），
 *   `ErbIndex` / `ArityCatalog` 一个字未动。
 *
 * ## 判据（可证明边界，错标比不标危险）
 *
 * - **个数（双向）**：与 eratw `BuiltinMethod.checkArity` 同口径 —— 4.981 的内建函数
 *   **少了报 `NotEnoughArgs` / `ArgsCountNotMatches`、多了报 `TooManyFuncArgs`**
 *   （spec: `FunctionMethod.cs:182-283` 的 omitStart 分支、`:289-318` 的定长分支；
 *   文案 `ArgsNotNeeded` 是「形参表长度为 0」的独立键）。旧口径「少给静默」是错的：
 *   内建不是用户函数，引擎不会给它补默认值。
 * - **成对变参组**：`DT_ROW_ADD` / `DT_ROW_SET` 声明了 eratw 的 `VariadicGroup`，
 *   合法个数 = `fixedPrefix + groupSize*n` 或整组形态 `exactFormArgs`，
 *   违例文案 `ArgsNotFitExpr`（spec: `FunctionMethod.cs:186-193`）。
 * - **类型**：只判**可证**的实参形态——串字面量 `"…"` / `@"…"` / `%…%`（文字列）、
 *   数值字面量与 `{…}` 数值插值（数式）、已知内建调用的返回值类型。变量、成员访问、
 *   带运算符的复合表达式一律 `unknown` ⇒ 不判。dump 不含参数类型 ⇒ 新补的名字
 *   类型位是 `a`（any），旧表人工核过的 152 名保留原类型。
 * - **影子函数让位**：项目里存在同名用户函数（`@STRLENS`）时整个名字不判
 *   （调用方传 `isUserFunction`；Emuera 侧用户定义优先，猜错边就是满屏假红）。
 * - 未打开项目也判（静态表，不依赖索引）。
 *
 * ## 与用户函数个数诊断的关系
 *
 * 用户函数走 `arity.ts`（目录查询形参表；4.981 的 `ConvertArg` 对**多余实参静默丢弃**
 * —— `reference/emuera-skia-4.981/.../Process.CalledFunction.cs:212-357` 只循环
 * `fixedArgCount` 次，所以那一档不报）；内建走本模块独立一路、独立诊断码
 * （`ERB_BUILTIN_ARGS` / `ERB_BUILTIN_ARG_TYPE`），问题面板可按码过滤。
 * 扫描尺子共用 `arity.ts` 的 `erbCallSitesOf`（单一真源）。
 */

/** 形参类型：`i` 数式 / `s` 文字列 / `v` 变量占槽（不判类型）/ `a` 任意 */
export type BuiltinParamType = 'int' | 'str' | 'var' | 'any';

/** 单个形参（`optional` = wiki 签名里带默认值，可省略） */
export interface BuiltinParam {
  readonly type: BuiltinParamType;
  readonly optional: boolean;
}

/** 一个内建函数的签名（`ret` / `params` 为 null = wiki 未载明，只认名字） */
export interface BuiltinSignature {
  readonly ret: 'int' | 'str' | null;
  readonly params: readonly BuiltinParam[] | null;
  /** 尾部可变实参（`MAX(n, m…)`）：不设个数上限 */
  readonly variadic: boolean;
  /**
   * 成对变参组（eratw `VariadicGroup`，`DT_ROW_ADD` / `DT_ROW_SET` 两族用）。
   *
   * 合法实参数 = `fixedPrefix + groupSize * n`（n ≥ 1），**或**整组形态 `exactFormArgs`。
   * 声明了它的函数按这条判、不再走 `params.length` 的定长比较
   * （spec: `FunctionMethod.cs:186-193`，违例文案 `Lang.Error.ArgsNotFitExpr`）。
   */
  readonly variadicGroup?: BuiltinVariadicGroup;
}

/** 成对变参组的三元读数（与 eratw `BuiltinMethod.variadicGroup` 同名同义） */
export interface BuiltinVariadicGroup {
  readonly fixedPrefix: number;
  readonly groupSize: number;
  readonly exactFormArgs: number;
  /** 该形态的个数下界：低于它归个数闸（`ArgsCountNotMatches` / `NotEnoughArgs`），不在成对判据里 */
  readonly minGroupArgs: number;
}

/** 实参个数诊断码（问题面板可定位；稳定标识） */
export const BUILTIN_ARGS_CODE = 'ERB_BUILTIN_ARGS';

/** 实参类型诊断码（稳定标识） */
export const BUILTIN_ARG_TYPE_CODE = 'ERB_BUILTIN_ARG_TYPE';

/* ---------------- 静态签名表 ---------------- */

/**
 * 原始签名串记法（一行一个函数）：
 *
 * - 第 2 列返回类型：`i` 数式 / `s` 文字列 / `~` 未载明；
 * - 第 3 列形参串：空格分隔的形参项，每项 = 类型符 + 可选 `?` 后缀（可省略）；
 *   类型符 `i` 数式 / `s` 文字列 / `v` 变量 / `a` 任意（**不判类型**）；
 *   形参串以 ` *` 结尾 = 尾部可变实参；
 * - 第 4 列（可选）成对变参组 `fixed,size,exact`。
 *
 * 例：`['SUBSTRING', 's', 's i? i?']` = `str SUBSTRING(str s, int start = 0, int length = -1)`。
 *
 * 表体由 `tools/gen-erb-builtin-signatures.mjs` 生成（区间标记见下方），
 * 内容来自 eratw core-vm 运行时注册表的反射 dump —— 见该生成器头注。
 */
/* @builtin-signatures:begin — 由 tools/gen-erb-builtin-signatures.mjs 生成，勿手改 ——
 *
 * 真源：eratw core-vm 运行时 `Builtins.registry` 的反射 dump
 * （`tools/data/builtin-signatures.tsv`，sha256 = `82d41fc1fdad92af206ce0055f25e3087fce6ef1824b96be5c397ea62de062e3`）。
 * 共 331 条（含 fork 扩展 SQL_/MAP_/DT_/XML_/ENTITY_ 整族）。
 *
 * 每条 = `[名字, 返回('i'|'s'), 形参串, 成对变参组?]`；形参串语法见文件头 KDoc。
 * 第 4 列 `fixed,size,exact` = eratw 的 `VariadicGroup`（DT_ROW_ADD / DT_ROW_SET）：
 * 合法实参数 = `fixed + size*n`，或整组形态 `exact`（spec: FunctionMethod.cs:186-193）。
 *
 * 类型位如实为 `a`（any）= 该位不判类型（dump 不含类型，旧表没核过就不猜）。
 */
const RAW: readonly (readonly [name: string, ret: 'i' | 's' | '~', params: string, variadicGroup?: string])[] = [
  // —— 角色 CSV / 角色查询（21）——
  ['CHARA_TO_ENTITY', 'i', 'a'],
  ['CSVABL', 'i', 'i i i?'],
  ['CSVBASE', 'i', 'i i i?'],
  ['CSVCALLNAME', 's', 'i i?'],
  ['CSVCFLAG', 'i', 'i i i?'],
  ['CSVCSTR', 's', 'i i i?'],
  ['CSVEQUIP', 'i', 'i i i?'],
  ['CSVEXP', 'i', 'i i i?'],
  ['CSVJUEL', 'i', 'i i i?'],
  ['CSVMARK', 'i', 'i i i?'],
  ['CSVMASTERNAME', 's', 'i i?'],
  ['CSVNAME', 's', 'i i?'],
  ['CSVNICKNAME', 's', 'i i?'],
  ['CSVRELATION', 'i', 'i i i?'],
  ['CSVTALENT', 'i', 'i i i?'],
  ['EXISTCSV', 'i', 'i i?'],
  ['FINDCHARA', 'i', 'v a i? i?'],
  ['FINDLASTCHARA', 'i', 'v a i? i?'],
  ['GETCHARA', 'i', 'i i?'],
  ['GETSPCHARA', 'i', 'i'],
  ['ROSTER_GENERATION', 'i', ''],

  // —— 数式 / 位运算（34）——
  ['ABS', 'i', 'i'],
  ['ALLSAMES', 'i', 'a a *'],
  ['ARRAYMSORT', 'i', 'a *'],
  ['ARRAYMSORTEX', 'i', 'a a a? a?'],
  ['CBRT', 'i', 'i'],
  ['CMATCH', 'i', 'v a i? i?'],
  ['EXPONENT', 'i', 'i'],
  ['FINDELEMENT', 'i', 'v a i? i? i?'],
  ['FINDLASTELEMENT', 'i', 'v a i? i? i?'],
  ['GETBIT', 'i', 'i i'],
  ['GROUPMATCH', 'i', 'a a *'],
  ['INRANGE', 'i', 'i i i'],
  ['INRANGEARRAY', 'i', 'a a a a? a?'],
  ['INRANGECARRAY', 'i', 'a a a a? a?'],
  ['LIMIT', 'i', 'i i i'],
  ['LOG', 'i', 'i'],
  ['LOG10', 'i', 'i'],
  ['MATCH', 'i', 'v a i? i?'],
  ['MAX', 'i', 'i *'],
  ['MAXARRAY', 'i', 'v i? i?'],
  ['MAXCARRAY', 'i', 'v i? i?'],
  ['MIN', 'i', 'i *'],
  ['MINARRAY', 'i', 'v i? i?'],
  ['MINCARRAY', 'i', 'v i? i?'],
  ['NOSAMES', 'i', 'a a *'],
  ['POWER', 'i', 'i i'],
  ['RAND', 'i', 'i i?'],
  ['ROUND', 'i', 'a'],
  ['SIGN', 'i', 'i'],
  ['SQRT', 'i', 'i'],
  ['SUMARRAY', 'i', 'v i? i?'],
  ['SUMCARRAY', 'i', 'v i? i?'],
  ['UNCHECKED_ADD', 'i', 'a a'],
  ['UNCHECKED_MUL', 'i', 'a a'],

  // —— 字符串（21）——
  ['BARSTR', 's', 'i i i'],
  ['ESCAPE', 's', 's'],
  ['ISNUMERIC', 'i', 's'],
  ['REPLACE', 's', 's s s a?'],
  ['STRCOUNT', 'i', 's s'],
  ['STRFIND', 'i', 's s i?'],
  ['STRFINDU', 'i', 's s i?'],
  ['STRFORM', 's', 's'],
  ['STRJOIN', 's', 'a a? a? a?'],
  ['STRLENS', 'i', 's'],
  ['STRLENSU', 'i', 's'],
  ['SUBSTRING', 's', 's i? i?'],
  ['SUBSTRINGU', 's', 's i? i?'],
  ['TOFULL', 's', 's'],
  ['TOHALF', 's', 's'],
  ['TOINT', 'i', 's'],
  ['TOLOWER', 's', 's'],
  ['TOSTR', 's', 'i s?'],
  ['TOUPPER', 's', 's'],
  ['UNICODE', 's', 'i'],
  ['UNICODEBYTE', 'i', 'a'],

  // —— 变量与符号查询（25）——
  ['ENUMFUNCBEGINSWITH', 'i', 'a a?'],
  ['ENUMFUNCENDSWITH', 'i', 'a a?'],
  ['ENUMFUNCWITH', 'i', 'a a?'],
  ['ENUMMACROBEGINSWITH', 'i', 'a a?'],
  ['ENUMMACROENDSWITH', 'i', 'a a?'],
  ['ENUMMACROWITH', 'i', 'a a?'],
  ['ENUMVARBEGINSWITH', 'i', 'a a?'],
  ['ENUMVARENDSWITH', 'i', 'a a?'],
  ['ENUMVARWITH', 'i', 'a a?'],
  ['ERDNAME', 's', 'a a a?'],
  ['EXISTFUNCTION', 'i', 'a a?'],
  ['EXISTMETH', 'i', 'a'],
  ['EXISTVAR', 'i', 'a a?'],
  ['GETEXPLV', 'i', 'i i'],
  ['GETMETH', 'i', 'a *'],
  ['GETMETHS', 's', 'a *'],
  ['GETNUM', 'i', 'v s a?'],
  ['GETNUMB', 'i', 'a a'],
  ['GETPALAMLV', 'i', 'i i'],
  ['GETVAR', 'i', 'a'],
  ['GETVARS', 's', 'a'],
  ['ISDEFINED', 'i', 'a'],
  ['SETVAR', 'i', 'a a'],
  ['VARSETEX', 'i', 'a a a? a? a?'],
  ['VARSIZE', 'i', 's i?'],

  // —— 表示 / 视图（88）——
  ['BITMAP_CACHE_ENABLE', 'i', 'a'],
  ['CBGCLEAR', 'i', ''],
  ['CBGCLEARBUTTON', 'i', ''],
  ['CBGREMOVEBMAP', 'i', ''],
  ['CBGREMOVERANGE', 'i', 'i i'],
  ['CBGSETBMAPG', 'i', 'i'],
  ['CBGSETBUTTONSPRITE', 'i', 'i s s i i i s?'],
  ['CBGSETG', 'i', 'i i i i'],
  ['CBGSETSPRITE', 'i', 's i i i'],
  ['COLOR_FROMNAME', 'i', 's'],
  ['COLOR_FROMRGB', 'i', 'i i i'],
  ['CURRENTALIGN', 's', ''],
  ['CURRENTREDRAW', 'i', ''],
  ['FLOWINPUT', 'i', 'a a? a? a?'],
  ['FLOWINPUTS', 'i', 'a a?'],
  ['GCLEAR', 'i', 'i i a? a? a? a?'],
  ['GCREATE', 'i', 'i i i'],
  ['GCREATED', 'i', 'i'],
  ['GCREATEFROMFILE', 'i', 'i s a?'],
  ['GDASHSTYLE', 'i', 'a a a'],
  ['GDISPOSE', 'i', 'i'],
  ['GDRAWG', 'i', 'i i i i i i i i i i a?'],
  ['GDRAWGWITHMASK', 'i', 'i i i i i'],
  ['GDRAWGWITHROTATE', 'i', 'a a a a? a?'],
  ['GDRAWLINE', 'i', 'a a a a a'],
  ['GDRAWSPRITE', 'i', 'i s i? i? i? i? a?'],
  ['GDRAWTEXT', 'i', 'a a a? a?'],
  ['GETANIMETIMER', 'i', ''],
  ['GETBGCOLOR', 'i', ''],
  ['GETCOLOR', 'i', ''],
  ['GETDISPLAYLINE', 's', 'a'],
  ['GETFONT', 's', ''],
  ['GETMILLISECOND', 'i', ''],
  ['GETSECOND', 'i', ''],
  ['GETSTYLE', 'i', ''],
  ['GETTEXTBOX', 's', ''],
  ['GETTIME', 'i', ''],
  ['GETTIMES', 's', ''],
  ['GFILLRECTANGLE', 'i', 'i i i i i'],
  ['GGETBRUSH', 'i', 'a'],
  ['GGETCOLOR', 'i', 'i i i'],
  ['GGETFONT', 's', 'a'],
  ['GGETFONTSIZE', 'i', 'a'],
  ['GGETFONTSTYLE', 'i', 'a'],
  ['GGETPEN', 'i', 'a'],
  ['GGETPENWIDTH', 'i', 'a'],
  ['GGETTEXTSIZE', 'i', 'a a a a?'],
  ['GSETBRUSH', 'i', 'i i'],
  ['GSETCOLOR', 'i', 'i i i i'],
  ['GSETFONT', 'i', 'i s i? a?'],
  ['GSETPEN', 'i', 'i i i'],
  ['HOTKEY_STATE', 'i', 'a a?'],
  ['HOTKEY_STATE_INIT', 'i', 'a'],
  ['HTML_ESCAPE', 's', 's'],
  ['HTML_GETPRINTEDSTR', 's', 'i?'],
  ['HTML_POPPRINTINGSTR', 's', ''],
  ['HTML_STRINGLEN', 'i', 'a a?'],
  ['HTML_STRINGLINES', 'i', 'a a'],
  ['HTML_SUBSTRING', 's', 'a a'],
  ['HTML_TOPLAINTEXT', 's', 's'],
  ['ISACTIVE', 'i', ''],
  ['LINEISEMPTY', 'i', ''],
  ['MONEYSTR', 's', 'i s?'],
  ['MOUSEB', 's', ''],
  ['MOUSESKIP', 'i', ''],
  ['MOUSEX', 'i', ''],
  ['MOUSEY', 'i', ''],
  ['MOVETEXTBOX', 'i', 'a a a'],
  ['OUTPUTLOG', 'i', 'a? a?'],
  ['PRINTCLENGTH', 'i', ''],
  ['PRINTCPERLINE', 'i', ''],
  ['RESUMETEXTBOX', 'i', 'a a a'],
  ['SETANIMETIMER', 'i', 'a'],
  ['SETTEXTBOX', 'i', 'a'],
  ['SPRITEANIMEADDFRAME', 'i', 's i i i i i i i i'],
  ['SPRITEANIMECREATE', 'i', 's i i'],
  ['SPRITEANIMEFRAME', 'i', 'a'],
  ['SPRITECREATE', 'i', 's i i? i? i? i? a? a? a? a?'],
  ['SPRITECREATED', 'i', 's'],
  ['SPRITEDISPOSE', 'i', 's'],
  ['SPRITEDISPOSEALL', 'i', 'a'],
  ['SPRITEGETCOLOR', 'i', 's i i'],
  ['SPRITEHEIGHT', 'i', 's'],
  ['SPRITEMOVE', 'i', 's i i'],
  ['SPRITEPOSX', 'i', 's'],
  ['SPRITEPOSY', 'i', 's'],
  ['SPRITESETPOS', 'i', 's i i'],
  ['SPRITEWIDTH', 'i', 's'],

  // —— 存档 / 文件 / 调试（16）——
  ['CHKCHARADATA', 'i', 's'],
  ['CHKDATA', 'i', 'i'],
  ['CLEARMEMORY', 'i', ''],
  ['ENUMFILES', 'i', 'a a? a? a?'],
  ['EXISTFILE', 'i', 'a'],
  ['GETCONFIG', 'i', 's'],
  ['GETCONFIGS', 's', 's'],
  ['GETDOINGFUNCTION', 's', ''],
  ['GETMEMORYUSAGE', 'i', ''],
  ['GETPLATFORM', 'i', ''],
  ['GLOAD', 'i', 'i i'],
  ['GSAVE', 'i', 'i i'],
  ['ISSKIP', 'i', ''],
  ['MESSKIP', 'i', ''],
  ['SAVENOS', 'i', ''],
  ['SAVETEXT', 'i', 's i i? i?'],

  // —— SQL / MAP / DT / XML / ENTITY（fork 扩展整族）（102）——
  ['DT_CELL_GET', 'i', 'a a a a?'],
  ['DT_CELL_GETS', 's', 'a a a a?'],
  ['DT_CELL_ISNULL', 'i', 'a a a a?'],
  ['DT_CELL_SET', 'i', 'a a a a? a?'],
  ['DT_CLEAR', 'i', 'a'],
  ['DT_COLUMN_ADD', 'i', 'a a a? a?'],
  ['DT_COLUMN_EXIST', 'i', 'a a'],
  ['DT_COLUMN_LENGTH', 'i', 'a'],
  ['DT_COLUMN_NAMES', 'i', 'a a?'],
  ['DT_COLUMN_REMOVE', 'i', 'a a'],
  ['DT_CREATE', 'i', 'a'],
  ['DT_EXIST', 'i', 'a'],
  ['DT_FROMXML', 'i', 'a a a'],
  ['DT_NOCASE', 'i', 'a a'],
  ['DT_RELEASE', 'i', 'a'],
  ['DT_ROW_ADD', 'i', 'a', '1,2,4,1'],
  ['DT_ROW_LENGTH', 'i', 'a'],
  ['DT_ROW_REMOVE', 'i', 'a a a?'],
  ['DT_ROW_SET', 'i', 'a a', '2,2,5,4'],
  ['DT_SELECT', 'i', 'a a? a? a?'],
  ['DT_TOXML', 's', 'a a?'],
  ['ENTITY_ADD_REL', 'i', 'a a a'],
  ['ENTITY_CREATE', 'i', 'a'],
  ['ENTITY_DEL_REL', 'i', 'a a a'],
  ['ENTITY_DESTROY', 'i', 'a'],
  ['ENTITY_EXISTS', 'i', 'a'],
  ['ENTITY_GET_INT', 'i', 'a a'],
  ['ENTITY_GET_STATE', 'i', 'a'],
  ['ENTITY_GET_STR', 's', 'a a'],
  ['ENTITY_HAS_REL', 'i', 'a a a'],
  ['ENTITY_PROJECT_CHARA', 'i', 'a'],
  ['ENTITY_QUERY_COUNT', 'i', 'a a'],
  ['ENTITY_QUERY_FILL', 'i', 'a a a'],
  ['ENTITY_QUERY_REL_COUNT', 'i', 'a a a'],
  ['ENTITY_QUERY_REL_FILL', 'i', 'a a a a'],
  ['ENTITY_RAND', 'i', 'a a'],
  ['ENTITY_SET_INT', 'i', 'a a a'],
  ['ENTITY_SET_STATE', 'i', 'a a'],
  ['ENTITY_SET_STR', 'i', 'a a a'],
  ['ENTITY_TO_CHARA', 'i', 'a a?'],
  ['ENTITY_UNPROJECT_CHARA', 'i', 'a'],
  ['HAS_SUPER', 'i', ''],
  ['MAP_CLEAR', 'i', 'a'],
  ['MAP_CREATE', 'i', 'a'],
  ['MAP_EXIST', 'i', 'a'],
  ['MAP_FINDKEY', 's', 'a a a'],
  ['MAP_FROMXML', 'i', 'a a'],
  ['MAP_GET', 's', 'a a'],
  ['MAP_GETKEYS', 's', 'a a? a?'],
  ['MAP_HAS', 'i', 'a a'],
  ['MAP_MERGE', 'i', 'a a'],
  ['MAP_RELEASE', 'i', 'a'],
  ['MAP_REMOVE', 'i', 'a a'],
  ['MAP_REMOVEIF', 'i', 'a a a'],
  ['MAP_SET', 'i', 'a a a'],
  ['MAP_SIZE', 'i', 'a'],
  ['MAP_TOSTRING', 's', 'a a? a?'],
  ['MAP_TOXML', 's', 'a'],
  ['MOD_IS_ACTIVE', 'i', 'a'],
  ['SQL_CONNECT', 'i', 'a a?'],
  ['SQL_CONNECTION_OPEN', 'i', 'a'],
  ['SQL_DISCONNECT', 'i', 'a'],
  ['SQL_ESCAPE', 's', 'a'],
  ['SQL_EXECUTE_NONQUERY', 'i', 'a a'],
  ['SQL_EXECUTE_READER', 'i', 'a a'],
  ['SQL_EXECUTE_SCALAR_FLOAT', 'i', 'a a'],
  ['SQL_EXECUTE_SCALAR_LONG', 'i', 'a a'],
  ['SQL_EXECUTE_SCALAR_STRING', 's', 'a a'],
  ['SQL_EXPORT_DT_XML', 'i', 'a a a a'],
  ['SQL_EXPORT_MAP_XML', 'i', 'a a a'],
  ['SQL_IMPORT_DT_XML', 'i', 'a a a a'],
  ['SQL_IMPORT_MAP_XML', 'i', 'a a a'],
  ['SQL_IMPORT_XML_CUSTOM', 'i', 'a a a a a'],
  ['SQL_P_EXECUTE_NONQUERY', 'i', 'a a *'],
  ['SQL_P_EXECUTE_READER', 'i', 'a a *'],
  ['SQL_P_EXECUTE_SCALAR_FLOAT', 'i', 'a a *'],
  ['SQL_P_EXECUTE_SCALAR_LONG', 'i', 'a a *'],
  ['SQL_P_EXECUTE_SCALAR_STRING', 's', 'a a *'],
  ['SQL_READER_CLOSE', 'i', 'a'],
  ['SQL_READER_GET_FLOAT', 'i', 'a a'],
  ['SQL_READER_GET_LONG', 'i', 'a a'],
  ['SQL_READER_GET_STRING', 's', 'a a'],
  ['SQL_READER_ISNULL', 'i', 'a a'],
  ['SQL_READER_READ', 'i', 'a'],
  ['XML_ADDATTRIBUTE', 'i', 'a a a a? a? a?'],
  ['XML_ADDATTRIBUTE_BYNAME', 'i', 'a a a a? a? a?'],
  ['XML_ADDNODE', 'i', 'a a a a? a?'],
  ['XML_ADDNODE_BYNAME', 'i', 'a a a a? a?'],
  ['XML_DOCUMENT', 'i', 'a a'],
  ['XML_EXIST', 'i', 'a'],
  ['XML_GET', 'i', 'a a a? a?'],
  ['XML_GET_BYNAME', 'i', 'a a a? a?'],
  ['XML_RELEASE', 'i', 'a'],
  ['XML_REMOVEATTRIBUTE', 'i', 'a a a?'],
  ['XML_REMOVEATTRIBUTE_BYNAME', 'i', 'a a a?'],
  ['XML_REMOVENODE', 'i', 'a a a?'],
  ['XML_REMOVENODE_BYNAME', 'i', 'a a a?'],
  ['XML_REPLACE', 'i', 'a a a? a?'],
  ['XML_REPLACE_BYNAME', 'i', 'a a a a?'],
  ['XML_SET', 'i', 'a a a a? a?'],
  ['XML_SET_BYNAME', 'i', 'a a a a? a?'],
  ['XML_TOSTR', 's', 'a'],

  // —— 其他（24）——
  ['BGMCONTROL', 'i', 'a a? a?'],
  ['CHARATU', 's', 's i'],
  ['CHKFONT', 'i', 's'],
  ['CLIENTHEIGHT', 'i', ''],
  ['CLIENTWIDTH', 'i', ''],
  ['CONVERT', 's', 'i a'],
  ['ENCODETOUNI', 'i', 's i?'],
  ['EXISTSOUND', 'i', 'a'],
  ['FIND_CHARADATA', 'i', 's?'],
  ['GETDEFBGCOLOR', 'i', ''],
  ['GETDEFCOLOR', 'i', ''],
  ['GETFOCUSCOLOR', 'i', ''],
  ['GETKEY', 'i', 'i'],
  ['GETKEYTRIGGERED', 'i', 'i'],
  ['GETLINESTR', 's', 's'],
  ['GETSOUNDORBGMINFO', 'i', 'a a?'],
  ['GHEIGHT', 'i', 'i'],
  ['GWIDTH', 'i', 'i'],
  ['ISPLAYINGBGM', 'i', ''],
  ['ISPLAYINGSOUND', 'i', 'a?'],
  ['LOADTEXT', 's', 'a i? i?'],
  ['REGEXPMATCH', 'i', 'a a a? a?'],
  ['SOUNDCONTROL', 'i', 'a a a? a?'],
  ['TOFLOAT', 'i', 'a'],
];
/* @builtin-signatures:end */

function decodeParams(spec: string): readonly BuiltinParam[] | null {
  if (spec === '~') return null;
  const out: BuiltinParam[] = [];
  for (const tok of spec.split(' ')) {
    if (tok.length === 0) continue;
    const optional = tok.endsWith('?');
    const t = optional ? tok.slice(0, -1) : tok;
    const type: BuiltinParamType = t === 'i' ? 'int' : t === 's' ? 'str' : t === 'v' ? 'var' : 'any';
    out.push({ type, optional });
  }
  return out;
}

/** 归一化名 → 签名（`params: null` = 未载明，只认名字） */
export const BUILTIN_SIGNATURES: ReadonlyMap<string, BuiltinSignature> = new Map(
  RAW.map(([name, ret, spec, vg]) => {
    const variadic = spec.endsWith(' *');
    const body = variadic ? spec.slice(0, -2) : spec;
    const group = decodeVariadicGroup(vg);
    const sig: BuiltinSignature = {
      ret: ret === 'i' ? 'int' : ret === 's' ? 'str' : null,
      params: decodeParams(body),
      variadic,
      ...(group === null ? {} : { variadicGroup: group }),
    };
    return [name, sig];
  }),
);

/** `fixed,size,exact,minGroup` → 四元读数；缺列 / 形态不对 ⇒ `null`（不声明成对判据） */
function decodeVariadicGroup(spec: string | undefined): BuiltinVariadicGroup | null {
  if (spec === undefined || spec.length === 0) return null;
  const parts = spec.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return {
    fixedPrefix: parts[0]!,
    groupSize: parts[1]!,
    exactFormArgs: parts[2]!,
    minGroupArgs: parts[3]!,
  };
}

/**
 * 成对变参组的违例判据（与 eratw `VariadicGroup.violates` **逐字同式**）。
 *
 * `n != exactFormArgs && n >= minGroupArgs && (n - fixedPrefix) % groupSize != 0`
 * （`Builtins.kt` 的 `VariadicGroup.violates`；原版 `FunctionMethod.cs:186-193`
 * 的 `MatchVariadicGroup` 分支，违例文案 `Lang.Error.ArgsNotFitExpr`）。
 * 低于 `minGroupArgs` 的个数不在此判 —— 归个数闸。
 */
function violatesVariadicGroup(g: BuiltinVariadicGroup, n: number): boolean {
  return n !== g.exactFormArgs && n >= g.minGroupArgs && (n - g.fixedPrefix) % g.groupSize !== 0;
}

/** 全部内建函数名（升序；补全与成员位的唯一候选源） */
export const BUILTIN_FUNCTION_NAMES: readonly string[] = [...BUILTIN_SIGNATURES.keys()].sort();

/** 查签名（大小写不敏感；没有这个名字 ⇒ `null`） */
export function builtinSignatureOf(name: string): BuiltinSignature | null {
  return BUILTIN_SIGNATURES.get(normalizedUpper(name)) ?? null;
}

const TYPE_WORD: Record<BuiltinParamType, string> = { int: 'int', str: 'str', var: 'var', any: 'any' };

/**
 * 人类可读签名（补全详情 / 工具提示用）：`STRLENS(str) → int`。
 * wiki 未载明签名的只给名字；没有这个名字 ⇒ `null`。
 */
export function builtinSignatureLabel(name: string): string | null {
  const sig = builtinSignatureOf(name);
  if (sig === null) return null;
  if (sig.params === null) return name;
  const ps = sig.params.map((p) => `${TYPE_WORD[p.type]}${p.optional ? '?' : ''}`);
  // 尾部可变实参 / 成对变参组都画省略号（两族的合法个数都超过固定槽位）
  if (sig.variadic || sig.variadicGroup !== undefined) ps.push('…');
  const ret = sig.ret === null ? '?' : sig.ret;
  return `${name}(${ps.join(', ')}) → ${ret}`;
}

/* ---------------- 实参诊断 ---------------- */

/** 诊断输入（`path` 用于方言门；`text` 是当前缓冲区原文） */
export interface BuiltinArgDiagnosticsInput {
  readonly path: string;
  readonly text: string;
  /**
   * 项目里的用户函数名判据（归一化大写进）；命中 = 同名用户函数存在，
   * 该名字整体不判（影子函数让位，见文件头注）。
   */
  readonly isUserFunction?: (normalizedName: string) => boolean;
  /** 已摊平的可见行（`visibleCodeLineList` 产物）：与 `collectArityDiagnostics` 同一个共用口 */
  readonly visible?: readonly VisibleCodeLine[];
}

/** 可证的实参表达式类型（判不出的 ⇒ `null`，一律不报） */
type ExprType = 'int' | 'str';

/** 空白字符（与 `arity.ts` 的 `isBlankChar` 同集：空格 / 制表 / U+3000） */
const isBlankChar = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\u3000';

/**
 * 整个实参槽是否就是一个 `NAME(…)` 调用（引号/嵌套括号感知，尾部不许有运算符）。
 * 是 ⇒ 该调用的返回类型可证；否 ⇒ `null`（复合表达式不猜）。
 */
function wholeCallType(text: string): ExprType | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text);
  if (m === null) return null;
  let depth = 0;
  let inStr = false;
  for (let i = m[0]!.length - 1; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        if (i !== text.length - 1) return null;
        const sig = builtinSignatureOf(m[1]!);
        return sig !== null && sig.ret !== null ? sig.ret : null;
      }
    }
  }
  return null;
}

/** 实参槽的可证类型（判不出 ⇒ `null`）；列区间为行内 0 基半开 */
function inferExprType(raw: string, span: ArgSpan): ExprType | null {
  let s = span.start;
  let e = span.end;
  while (s < e && isBlankChar(raw[s])) s++;
  while (e > s && isBlankChar(raw[e - 1])) e--;
  if (s >= e) return null;
  const text = raw.slice(s, e);
  const first = text[0]!;
  // 串字面量 / `@"…"` 格式化串 / `%…%` FORM 串 ⇒ 文字列
  if (first === '"' || first === '@' || first === '%') return 'str';
  // `{…}` 数值插值 ⇒ 数式
  if (first === '{') return 'int';
  if (/^[+-]?\d+$/.test(text)) return 'int';
  const up = text.toUpperCase();
  if (up === 'TRUE' || up === 'FALSE') return 'int';
  return wholeCallType(text);
}

/** 单个实参槽的去空白区间（诊断落点用；全空 ⇒ null） */
function trimmedSpan(raw: string, span: ArgSpan): ArgSpan | null {
  let s = span.start;
  let e = span.end;
  while (s < e && isBlankChar(raw[s])) s++;
  while (e > s && isBlankChar(raw[e - 1])) e--;
  return s >= e ? null : { start: s, end: e };
}

/**
 * 最后一个**不可省略**形参的位号 + 1（省略必须从尾部连续，所以下界就是它）。
 *
 * 与 `arity.ts` 的 `requiredCount` 同义（那边还把"带下标且非 ARG 家族"算必需，
 * 内建函数没有那种槽：签名表里的 `?` 就是唯一可省标记）。
 */
function requiredCount(params: readonly BuiltinParam[]): number {
  let required = 0;
  for (let i = 0; i < params.length; i++) {
    if (!params[i]!.optional) required = i + 1;
  }
  return required;
}

/**
 * 本行的实参读数是否**可证完整**——只给「少给」这一档用的防护。
 *
 * 为什么需要：`erbCallSitesOf` 按「名字后紧跟 `(` ⇒ 括号内即实参列表」切分，
 * 但真实语料里两种写法会让 `given` **低估**：
 *
 * 1. `LIMIT (X)+Y, -1, 1` —— 第一个 `(…)` 只是**第一个实参的括号分组**，实参延续到逗号；
 *    扫描器把它当成完整列表，只数到 1 个（实测 `DLC/魔法DLC/魔法相关函数.ERB:3259`、
 *    `M_KOJO_K17_口上固有追加イベント.ERB:196/208`）。
 * 2. `乘数 += LIMIT(` —— 实参折到下一行，本行 0 个。
 *
 * 这两形下「少给」是扫描器估不准，不是引擎会报错 ⇒ 一律不判（fail-open）。
 * 判据 = 括号在本行配平 **且** 实参区之后到行尾（去注释）没有残留代码。
 */
function argsProvablyComplete(line: RawLineView, site: ErbCallSite): boolean {
  // 括号未配平 ⇒ 实参跨行，本行不可证
  let depth = 0;
  let inStr = false;
  for (const ch of line.raw) {
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  if (depth !== 0) return false;
  if (site.argFirst < 0) return true; // 无实参（`STRLENS()`）：列表就是空的
  // 实参区之后还有代码（`)+ARG:2,-1,1`）⇒ 括号内的不是完整列表
  const rest = line.raw.slice(site.argLast);
  const semi = rest.indexOf(';');
  const tail = (semi >= 0 ? rest.slice(0, semi) : rest).trim();
  return tail.length === 0;
}

/** 行视图（只用到 `raw`；单独取个名字是为了让判据的入参语义自解释） */
interface RawLineView {
  readonly raw: string;
}

/**
 * 取一条**引擎报错原话**（`@kojo/plugin-api` 的 `ERB_ENGINE_ERROR_TEXTS`，真源
 * eratw `specs/error-texts.yaml`）。
 *
 * 为什么用抛错而不是回落自造文案：id 是本文件写死的常量，取不到只可能是生成区间漏了条目
 * ——那是实现缺陷，编一句像样的中文把它盖过去正是本仓反复判红的"掩盖表象"。
 * 抛出的异常由调用方的规则失败账（`ERB_DIAGNOSTICS_RULE_FAILED`）兜住并上屏，
 * 缺陷可见、不静默。
 */
function engineText(id: string, values: readonly (string | number)[]): string {
  const text = formatEngineErrorText(id, values);
  if (text === undefined) throw new Error(`error-texts 数据契约缺条目 ${id}`);
  return text;
}

/**
 * 收集整篇缓冲区的内建实参诊断（**纯函数**：文本进、波浪线数据出）。
 *
 * 个数判据 = eratw `BuiltinMethod.checkArity` 的**双向**口径（4.981 内建函数
 * 少给报 `NotEnoughArgs` / `ArgsCountNotMatches`，多给报 `TooManyFuncArgs`，
 * 成对变参组违例报 `ArgsNotFitExpr`；spec: `FunctionMethod.cs:182-283` /
 * `:289-318`）。文案取 `specs/error-texts.yaml` 的 zhs 原文，再补一句定位说明。
 * 类型只判可证形态。
 * 非 ERB 方言路径 / 空文本 ⇒ 空数组；产出按行、列升序。
 */
export function collectBuiltinArgDiagnostics(input: BuiltinArgDiagnosticsInput): LineDecoration[] {
  if (!isErbDialectPath(input.path) || input.text.length === 0) return [];
  const out: LineDecoration[] = [];
  const lines = input.visible ?? visibleCodeLines(input.text);
  for (const line of lines) {
    if (line.isDefinition) continue;
    // 与 `collectArityDiagnostics` 同一道预筛（两家共用 `erbCallSitesOf`，预筛必须同形）
    if (!line.isCallLine && line.raw.indexOf('(') < 0) continue;
    const code = line.codeView();
    for (const site of erbCallSitesOf(line, code)) {
      const sig = builtinSignatureOf(site.name);
      // 未载明签名（INRANGEARRAY 等）/ 同名用户函数（影子让位）⇒ 不判
      if (sig === null || sig.params === null) continue;
      if (input.isUserFunction?.(normalizedUpper(site.name)) === true) continue;

      const n = site.given;
      const argRange =
        site.argFirst >= 0
          ? { startColumn: site.argFirst + 1, endColumn: site.argLast + 1 }
          : { startColumn: site.nameStart + 1, endColumn: site.nameEnd + 1 };

      // 个数：eratw `checkArity` 同口径（双向 + 成对变参组）。
      // 文案主体一律取引擎原话（`ERB_ENGINE_ERROR_TEXTS`），本文件只在其后**追加**
      // 定位说明——作者拿引擎原话去搜社区/提问时能对得上号，这条纪律同 `error-texts.yaml` 头注。
      const g = sig.variadicGroup;
      if (g !== undefined) {
        if (violatesVariadicGroup(g, n)) {
          out.push({
            line: site.line,
            severity: 'error',
            message:
              engineText('ArgsNotFitExpr', [site.name, n, g.fixedPrefix, g.groupSize]) +
              `——这条函数要么给 ${g.fixedPrefix} + ${g.groupSize}n 个（成组传入），要么给整组形态 ${g.exactFormArgs} 个。`,
            ...argRange,
            code: BUILTIN_ARGS_CODE,
          });
        }
      } else {
        const max = sig.variadic ? -1 : sig.params.length;
        const required = requiredCount(sig.params);
        if (max >= 0 && n > max) {
          out.push({
            line: site.line,
            severity: 'error',
            message:
              (max === 0
                ? engineText('ArgsNotNeeded', [site.name]) +
                  `——实际给了 ${n} 个，多出的实参引擎会直接报错。`
                : engineText('TooManyFuncArgs', [site.name]) +
                  `——最多 ${max} 个，实际给了 ${n} 个，多出的实参引擎会直接报错。`),
            ...argRange,
            code: BUILTIN_ARGS_CODE,
          });
        } else if (n < required && argsProvablyComplete(line, site)) {
          out.push({
            line: site.line,
            severity: 'error',
            message:
              engineText('NotEnoughArgs', [site.name, required]) +
              `——实际给了 ${n} 个，第 ${required} 个参数不能省略，运行时会直接报错。`,
            ...argRange,
            code: BUILTIN_ARGS_CODE,
          });
        }
      }

      // 类型：逐槽对签名（只判 int/str 两档；var/any 与判不出的实参不报）。
      // 区间下标在 codeView 与原文之间等价（codeView 保长度：串体刷白、`;` 后补空格），
      // 但类型判据必须读**原文**——codeView 里串字面量已是空格，读它就永远判不出 str。
      for (let i = 0; i < site.spans.length && i < sig.params.length; i++) {
        const want = sig.params[i]!.type;
        if (want !== 'int' && want !== 'str') continue;
        const got = inferExprType(line.raw, site.spans[i]!);
        if (got === null || got === want) continue;
        const span = trimmedSpan(line.raw, site.spans[i]!);
        if (span === null) continue;
        out.push({
          line: site.line,
          severity: 'error',
          message:
            `内建函数「${site.name}」的第 ${i + 1} 个实参应是${want === 'str' ? '文字列' : '数式'}，` +
            `实际写的是${got === 'str' ? '文字列' : '数式'}——Emuera 1.808 起不再静默转换，运行时会直接报错。`,
          startColumn: span.start + 1,
          endColumn: span.end + 1,
          code: BUILTIN_ARG_TYPE_CODE,
        });
      }
    }
  }
  out.sort((a, b) => a.line - b.line || (a.startColumn ?? 0) - (b.startColumn ?? 0));
  return out;
}
