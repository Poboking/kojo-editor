/**
 * ERB **引擎指令名全集**（Emuera `FunctionCode`）—— 本项目里这张表的唯一真源。
 *
 * ## 出处（可复现，不是抄来的清单）
 *
 * 引擎源码 gitlab `EvilMask/emuera.em`（`master`）：
 * 1. `Emuera/Runtime/Script/Statements/BuiltInFunctionCode.cs` 的 `enum FunctionCode` —— 305 个成员；
 * 2. `…/Statements/FunctionIdentifier.cs` 的 `addFunction()`：`string key = code.ToString();`
 *    → **字典键就是枚举成员名**，所以"指令名全集"等价于"枚举成员名全集"，不需要另抄一份；
 * 3. `…/Data/IdentifierDictionary.cs` 构造函数：
 *    `instructionDic = FunctionIdentifier.GetInstructionNameDic();`
 *    → `foreach (… in instructionDic) nameDic.TryAdd(pair.Key, DefinedNameType.SystemInstrument);`
 *
 * 等式（改动本表时照这个复核）：**305 个枚举成员 − 4 = 301**，与
 * `FunctionIdentifier.cs` 里所有**生效的** `addFunction(FunctionCode.X)` 实参集**双向差集为空**。
 * 剔掉的 4 个各有引擎侧硬理由：
 *
 * | 成员 | 为什么不算指令 |
 * | --- | --- |
 * | `__NULL__` | `= 0x0000` 的空值哨兵，从不注册 |
 * | `SET` | 不入 `funcDic`：`setFunc = new FunctionIdentifier("SET", …)`，代入文专用 |
 * | `VARS` / `VARI` | 被 `if (JSONConfig.Data.UseScopedVariableInstruction)` 包住，**默认配置下不注册** |
 *
 * `VARS`/`VARI` 这一条不是洁癖：eraSQC 与 eraSQN 的 `SYSTEM_DEBUG.ERB` 里都有
 * `#DIMS VARS`（当私有变量名用）且**游戏能正常加载**——把它们算进指令集就是一条假缺陷。
 * 同一处开关在 `IdentifierDictionary.ThrowException` 里也有旁证：
 * `!UseScopedVariableInstruction && (idStr == "VARS" || idStr == "VARI")` ⇒ `CanNotUseVAR`
 * （不开启时连用都不能用，更说明它不是常驻指令）。另注意 `OUTPUTLOG` 在枚举里被 `//` 注释掉，
 * 本就不在成员集内。
 *
 * ## 为什么不从 Era Wiki 的 excom 页抄
 *
 * 那页的标题是**交替式**（`PRINT(|V|S|FORM|FORMS)(|K|D)(|L|W)`、`PRINTBUTTON(|C|LC)` …），
 * 展开会造出引擎里并不存在的名字（如 `PRINTSW` 有、`PRINTKS` 无）。判据要的是
 * "这个名字会不会撞车"，过度近似的名字表只会换来假缺陷。
 *
 * ## 用途
 *
 * `declarations.ts` 的「`#DIM` 变量名不得与指令同名」——引擎侧是
 * `CheckUserVarName` / `CheckUserPrivateVarName` / `CheckUserMacroName` 三处的
 * `SystemInstrument` 分支（`warnLevel = 2` 后 `return`，即致命；`#DIM` 解析失败会让
 * 整个文件加载失败）。
 *
 * ## 不做
 *
 * 内建**式中函数**（exmeth）不在本表——那是 `builtins.ts` 的 `BUILTIN_SIGNATURES`
 * （引擎里是 `DefinedNameType.SystemMethod`，与本表同为致命档，但取数源不同）。
 * 两张表在规则处并集，各自维护自己的出处。
 */

/**
 * 303 个引擎指令名（全大写、字典序）。
 *
 * 逐个词都是 `enum FunctionCode` 的成员名，故大小写即引擎写法；
 * 判据侧一律按大写比较（Emuera 默认 `Config.IgnoreCase`）。
 */
export const ERB_INSTRUCTION_NAMES: readonly string[] = [
  'ADDCHARA', 'ADDCOPYCHARA', 'ADDDEFCHARA', 'ADDSPCHARA', 'ADDVOIDCHARA', 'ALIGNMENT',
  'ARRAYCOPY', 'ARRAYREMOVE', 'ARRAYSHIFT', 'ARRAYSORT', 'ASSERT', 'AWAIT',
  'BAR', 'BARL', 'BEGIN', 'BINPUT', 'BINPUTS', 'BREAK',
  'BREAKBUTTON', 'CALL', 'CALLEVENT', 'CALLF', 'CALLFORM', 'CALLFORMF',
  'CALLSHARP', 'CALLTRAIN', 'CASE', 'CASEELSE', 'CATCH', 'CLEARBGIMAGE',
  'CLEARBIT', 'CLEARLINE', 'CLEARTEXTBOX', 'CONTINUE', 'COPYCHARA', 'CUPCHECK',
  'CUSTOMDRAWLINE', 'CVARSET', 'DATA', 'DATAFORM', 'DATALIST', 'DEBUGCLEAR',
  'DEBUGPRINT', 'DEBUGPRINTFORM', 'DEBUGPRINTFORML', 'DEBUGPRINTL', 'DELALLCHARA', 'DELCHARA',
  'DELDATA', 'DO', 'DOTRAIN', 'DRAWLINE', 'DRAWLINEFORM', 'DT_COLUMN_OPTIONS',
  'DUMPRAND', 'ELSE', 'ELSEIF', 'ENCODETOUNI', 'ENDCATCH', 'ENDDATA',
  'ENDFUNC', 'ENDIF', 'ENDLIST', 'ENDNOSKIP', 'ENDSELECT', 'FONTBOLD',
  'FONTITALIC', 'FONTREGULAR', 'FONTSTYLE', 'FOR', 'FORCEKANA', 'FORCEWAIT',
  'FORCE_BEGIN', 'FORCE_QUIT', 'FORCE_QUIT_AND_RESTART', 'FUNC', 'GETTIME', 'GOTO',
  'GOTOFORM', 'HTML_PRINT', 'HTML_PRINT_ISLAND', 'HTML_PRINT_ISLAND_CLEAR', 'HTML_TAGSPLIT', 'IF',
  'INITRAND', 'INPUT', 'INPUTANY', 'INPUTMOUSEKEY', 'INPUTS', 'INVERTBIT',
  'JUMP', 'JUMPFORM', 'LOADCHARA', 'LOADDATA', 'LOADGAME', 'LOADGLOBAL',
  'LOADVAR', 'LOOP', 'NEXT', 'NOSKIP', 'ONEBINPUT', 'ONEBINPUTS',
  'ONEINPUT', 'ONEINPUTS', 'PICKUPCHARA', 'PLAYBGM', 'PLAYSOUND', 'POWER',
  'PRINT', 'PRINTBUTTON', 'PRINTBUTTONC', 'PRINTBUTTONLC', 'PRINTC', 'PRINTCD',
  'PRINTCK', 'PRINTCPERLINE', 'PRINTD', 'PRINTDATA', 'PRINTDATAD', 'PRINTDATADL',
  'PRINTDATADW', 'PRINTDATAK', 'PRINTDATAKL', 'PRINTDATAKW', 'PRINTDATAL', 'PRINTDATAW',
  'PRINTDL', 'PRINTDW', 'PRINTFORM', 'PRINTFORMC', 'PRINTFORMCD', 'PRINTFORMCK',
  'PRINTFORMD', 'PRINTFORMDL', 'PRINTFORMDW', 'PRINTFORMK', 'PRINTFORMKL', 'PRINTFORMKW',
  'PRINTFORML', 'PRINTFORMLC', 'PRINTFORMLCD', 'PRINTFORMLCK', 'PRINTFORMN', 'PRINTFORMS',
  'PRINTFORMSD', 'PRINTFORMSDL', 'PRINTFORMSDW', 'PRINTFORMSK', 'PRINTFORMSKL', 'PRINTFORMSKW',
  'PRINTFORMSL', 'PRINTFORMSN', 'PRINTFORMSW', 'PRINTFORMW', 'PRINTK', 'PRINTKL',
  'PRINTKW', 'PRINTL', 'PRINTLC', 'PRINTLCD', 'PRINTLCK', 'PRINTN',
  'PRINTPLAIN', 'PRINTPLAINFORM', 'PRINTS', 'PRINTSD', 'PRINTSDL', 'PRINTSDW',
  'PRINTSINGLE', 'PRINTSINGLED', 'PRINTSINGLEFORM', 'PRINTSINGLEFORMD', 'PRINTSINGLEFORMK', 'PRINTSINGLEFORMS',
  'PRINTSINGLEFORMSD', 'PRINTSINGLEFORMSK', 'PRINTSINGLEK', 'PRINTSINGLES', 'PRINTSINGLESD', 'PRINTSINGLESK',
  'PRINTSINGLEV', 'PRINTSINGLEVD', 'PRINTSINGLEVK', 'PRINTSK', 'PRINTSKL', 'PRINTSKW',
  'PRINTSL', 'PRINTSN', 'PRINTSW', 'PRINTV', 'PRINTVD', 'PRINTVDL',
  'PRINTVDW', 'PRINTVK', 'PRINTVKL', 'PRINTVKW', 'PRINTVL', 'PRINTVN',
  'PRINTVW', 'PRINTW', 'PRINT_ABL', 'PRINT_EXP', 'PRINT_IMG', 'PRINT_ITEM',
  'PRINT_MARK', 'PRINT_PALAM', 'PRINT_RECT', 'PRINT_SHOPITEM', 'PRINT_SPACE', 'PRINT_TALENT',
  'PUTFORM', 'QUIT', 'QUIT_AND_RESTART', 'RANDOMIZE', 'REDRAW', 'REF',
  'REFBYNAME', 'REMOVEBGIMAGE', 'REND', 'REPEAT', 'RESETBGCOLOR', 'RESETCOLOR',
  'RESETDATA', 'RESETGLOBAL', 'RESET_STAIN', 'RESTART', 'RETURN', 'RETURNF',
  'RETURNFORM', 'REUSELASTLINE', 'SAVECHARA', 'SAVEDATA', 'SAVEGAME', 'SAVEGLOBAL',
  'SAVENOS', 'SAVEVAR', 'SELECTCASE', 'SETBGCOLOR', 'SETBGCOLORBYNAME', 'SETBGIMAGE',
  'SETBGMVOLUME', 'SETBIT', 'SETCOLOR', 'SETCOLORBYNAME', 'SETFONT', 'SETSOUNDVOLUME',
  'SIF', 'SKIPDISP', 'SKIPLOG', 'SORTCHARA', 'SPLIT', 'STOPBGM',
  'STOPCALLTRAIN', 'STOPSOUND', 'STRDATA', 'STRLEN', 'STRLENFORM', 'STRLENFORMU',
  'STRLENU', 'SWAP', 'SWAPCHARA', 'THROW', 'TIMES', 'TINPUT',
  'TINPUTS', 'TONEINPUT', 'TONEINPUTS', 'TOOLTIP_CUSTOM', 'TOOLTIP_FORMAT', 'TOOLTIP_IMG',
  'TOOLTIP_SETCOLOR', 'TOOLTIP_SETDELAY', 'TOOLTIP_SETDURATION', 'TOOLTIP_SETFONT', 'TOOLTIP_SETFONTSIZE', 'TRYCALL',
  'TRYCALLF', 'TRYCALLFORM', 'TRYCALLFORMF', 'TRYCALLLIST', 'TRYCCALL', 'TRYCCALLFORM',
  'TRYCGOTO', 'TRYCGOTOFORM', 'TRYCJUMP', 'TRYCJUMPFORM', 'TRYGOTO', 'TRYGOTOFORM',
  'TRYGOTOLIST', 'TRYJUMP', 'TRYJUMPFORM', 'TRYJUMPLIST', 'TWAIT', 'UPCHECK',
  'UPDATECHECK', 'VARSET', 'VARSIZE', 'WAIT', 'WAITANYKEY', 'WEND',
  'WHILE',
];

/** 判据用集合（大写归一后比对；与 {@link ERB_INSTRUCTION_NAMES} 同源） */
const INSTRUCTION_NAME_SET: ReadonlySet<string> = new Set(ERB_INSTRUCTION_NAMES.map((n) => n.toUpperCase()));

/**
 * `name` 是否是引擎指令名（大小写不敏感；空白两端自动裁掉）。
 *
 * 纯函数、零依赖——宿主与插件两边都能直接调，不需要为了问一句"这是不是指令"
 * 把 monaco 或索引拖进来。
 */
export function isInstructionName(name: string): boolean {
  return INSTRUCTION_NAME_SET.has(name.trim().toUpperCase());
}

/* ============================== ERB 语句 / 声明词表（ERB-PARITY G1，2026-10-31） ============================== */

/**
 * 非控制流的手写常用语句（补全 / 悬停分类共用）。**控制流词不在这里**——一律从
 * `ERB_CONTROL_STATEMENTS`（scanner 配对表）派生，两份清单零交集由
 * `packages/app/tests/erb-directive-words.test.ts` 的闸钉住。
 *
 * 收录口径 = **口上高频子集**（非 Emuera 全集）：eraNAS / eraTW 4.980 真语料按"真语句判据"
 * （行首词后不得是赋值 / 自增 / `(`）实测频次 ≥10 的词；逐词频次与拒收档仍在宿主那张闸表里。
 * 2026-10-31 从宿主 `monaco/erb-directives.ts` 整表搬来（悬停分类的判据在插件侧，宿主只
 * re-export）——**搬的只是落点，词与闸一字未改**。
 */
export const ERB_STATEMENT_DIRECTIVES: readonly string[] = [
  'PRINT', 'PRINTL', 'PRINTW', 'PRINTV', 'PRINTVL',
  'PRINTFORM', 'PRINTFORML', 'PRINTFORMS', 'PRINTFORMW', 'PRINTFORMV',
  'PRINTDATAS',
  'PRINTDW', 'PRINTDL',
  'PRINTFORMD', 'PRINTFORMDL', 'PRINTFORMDW',
  'DATAFORM',
  'PRINTSINGLE', 'PRINTSINGLEL', 'PRINTSINGLEFORM', 'PRINTSINGLEFORML',
  'PRINTBUTTON',
  'BREAK', 'CONTINUE', 'RETURN', 'RETURNF',
  'GOTO',
  'CALL', 'CALLL', 'JUMP', 'CALLFORM', 'CALLFORML', 'TRYCALLFORM', 'TRYCALLFORMF',
  'TRYCALL', 'TRYJUMP', 'CALLF', 'CALLFORMF',
  'DIM', 'DIMS', 'SWAP', 'VARSET',
  'SETCOLOR', 'RESETCOLOR', 'FONTBOLD', 'FONTITALIC', 'FONTREGULAR', 'FONTSIZE', 'FONTSTYLE',
  'WAIT', 'WAITANYKEY', 'INPUT', 'INPUTS', 'ONEINPUT', 'TINPUT', 'TINPUTS', 'TWAIT',
  'SAVEDATA', 'LOADDATA', 'DELDATA', 'SAVEGLOBAL', 'LOADGLOBAL',
  'GETTIME', 'GETMILLISECOND', 'SETBIT', 'CLEARBIT', 'INVERTBIT', 'GETBIT', 'SETCOLORBYNAME',
  'RANDOMIZE', 'RAND', 'TIMES', 'EXISTCSV', 'GETNUM', 'BAR', 'BARL', 'DRAWLINE', 'CLEARLINE', 'ALIGNMENT',
  'ADDCHARA', 'ADDSPCHARA', 'DELCHARA', 'SWAPCHARA', 'PICKUPCHARA', 'GETCHARA', 'CHKCHARA',
  'EQUIP', 'UNEQUIP', 'EQUIPCHECK', 'CHANGE_CFLAG', 'CFLAG', 'DOWNBASE', 'RESETDATA', 'BEGIN', 'EVENTCOM',
  'DEBUGPRINTFORML', 'SKIPDISP', 'REUSELASTLINE', 'RESTART', 'SETFONT',
  'DATA',
  'DT_ROW_ADD', 'DT_COLUMN_ADD', 'DT_CELL_SET', 'DT_SELECT', 'DT_ROW_REMOVE', 'DT_CREATE', 'DT_RELEASE',
  'THROW',
  'PRINTFORMC', 'PRINTS', 'PRINTLC', 'PRINTC', 'PRINTFORMLC', 'PRINTD',
  'PRINTPLAINFORM', 'PRINTFORMSL', 'PRINTPLAIN', 'PRINTBUTTONLC', 'PRINTSL', 'PRINTSINGLEFORMS',
  'PLAYSOUND', 'STOPSOUND',
  'CUSTOMDRAWLINE', 'DRAWLINEFORM',
  'CVARSET', 'ARRAYCOPY', 'ARRAYREMOVE', 'ARRAYSHIFT', 'ARRAYSORT',
  'SETBGCOLOR', 'RESETBGCOLOR', 'SPRITECREATE', 'SPRITEDISPOSE',
  'GDRAWSPRITE', 'GDISPOSE', 'GCREATE', 'GCREATEFROMFILE', 'GDRAWTEXT',
  'GSETFONT', 'GSETPEN', 'GCLEAR', 'CBGCLEAR', 'CBGSETG',
  'SPLIT', 'REPLACE', 'SUBSTRING',
  'TRYCALLF', 'CHKDATA', 'RESET_STAIN', 'FINDELEMENT', 'SETANIMETIMER', 'DOTRAIN', 'GETDEFCOLOR',
  'TONEINPUTS', 'BINPUT',
  'XML_GET', 'XML_ADDNODE',
  'MAP_SET', 'MAP_CREATE',
  'GDRAWG', 'PRINT_RECT', 'GETCOLOR', 'TOOLTIP_SETDELAY', 'AWAIT',
];

/**
 * `#` 声明族（**不含 `#` 前缀**）：`#DIM` 族 6 枚 + 文件级 / 返回类型 8 枚。
 * 集合口径与转译器直通谓词同源（`kojo-vocab` 的 `DIM_DIRECTIVE_RE` 前 6 枚 +
 * `native-display/control.ts` 的 8 枚文件级声明）。
 */
export const ERB_DECLARATION_DIRECTIVES: readonly string[] = [
  'DIM',
  'DIMS',
  'DIMSTR',
  'DIMCHAR',
  'DIMF',
  'DEFINE',
  'FUNCTION',
  'FUNCTIONS',
  'GLOBAL',
  'LOCALSIZE',
  'LOCALSSIZE',
  'SFUNCTION',
  'XFUNCTION',
  'TESTMEMORY',
];

