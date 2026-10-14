/**
 * Emuera 引擎级变量模型（游戏无关；本插件私有）。
 *
 * 这些清单是**引擎语言层知识**（跨游戏一致，依据 `VariableCode.cs`
 * 与真实存档实测），不是游戏知识：
 * - 角色系：引用形式 `X` / `X:i` 补位 TARGET；`X:c:i` 显式角色——与
 *   `VariableParser.ReduceVariable`（引擎源码 :92-133）逐条对应；
 * - 全局系：`X` 等价 `X:0`（:157-163）；
 * - 伪变量（CALC）：运行期计算值，不在存档中，近似回放不可求值。
 *
 * 数据驱动的兜底：#DIM 用户变量（角色域 / 广域）不在本清单内——
 * 其存在性与维度由存档数据本身（ArchiveVariable.type）判定。
 */

/** 角色 1D 整数数组（内置 22 个；引用 `X:i` → `X[TARGET,i]`） */
const CHARA_INT_1D = new Set([
  'BASE',
  'MAXBASE',
  'ABL',
  'TALENT',
  'EXP',
  'MARK',
  'PALAM',
  'SOURCE',
  'EX',
  'CFLAG',
  'JUEL',
  'RELATION',
  'EQUIP',
  'TEQUIP',
  'STAIN',
  'GOTJUEL',
  'NOWEX',
  'DOWNBASE',
  'CUP',
  'CDOWN',
  'TCVAR',
]);

/** 角色整型标量（`X` → `X[TARGET]`） */
const CHARA_INT_SCALAR = new Set(['ISASSI', 'NO']);

/** 角色字符串标量（`X` → `X[TARGET]`） */
const CHARA_STR_SCALAR = new Set(['NAME', 'CALLNAME', 'NICKNAME', 'MASTERNAME']);

/** 角色 1D 字符串数组 */
const CHARA_STR_1D = new Set(['CSTR']);

/** 角色 2D 整数数组（三参必须：`X:c:i:j`） */
const CHARA_INT_2D = new Set(['CDFLAG']);

/**
 * 内置全局 1D 整数数组（`X` 等价 `X:0`）。
 * 含 eramaker 传统段 DAY..TB 与引擎核心状态（TARGET/ASSI/MASTER/PLAYER）。
 */
const GLOBAL_INT_1D = new Set([
  'DAY',
  'MONEY',
  'ITEM',
  'FLAG',
  'TFLAG',
  'UP',
  'DOWN',
  'PALAMLV',
  'EXPLV',
  'EJAC',
  'RESULT',
  'COUNT',
  'TARGET',
  'ASSI',
  'MASTER',
  'NOITEM',
  'LOSEBASE',
  'SELECTCOM',
  'ASSIPLAY',
  'PREVCOM',
  'TIME',
  'ITEMSALES',
  'PLAYER',
  'NEXTCOM',
  'PBAND',
  'BOUGHT',
  'RANDDATA',
  // 单字母通用数组 A-Z
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
]);

/** 内置全局 2D 整数数组（两参：`X:i:j`） */
const GLOBAL_INT_2D = new Set(['DITEMTYPE', 'DA', 'DB', 'DC', 'DD', 'DE']);

/** 内置全局 3D 整数数组（三参） */
const GLOBAL_INT_3D = new Set(['TA', 'TB']);

/** 内置全局字符串（标量 / 1D 数组） */
const GLOBAL_STR_SCALAR = new Set(['SAVEDATA_TEXT']);
const GLOBAL_STR_1D = new Set(['SAVESTR', 'TSTR']);

/**
 * CALC 伪变量（`VariableCode.cs` 的 `__CALC__` 家族）。其中**回放可求值子集**
 * （`__INT_MAX__` / `__INT_MIN__` / `CHARANUM`）由 `state-view.read()` 前置拦截；
 * 其余（运行期随机 / 版本 / 行数 / 窗口系 / 行号系）不在快照中 → unknown。
 * 行号系（`__FILE__` / `__FUNCTION__` / `__LINE__`）依赖当前谓词上下文，
 * 逐谓词注入点在 `engine.replayPredicates()`。
 * RAND 由 Config.CompatiRAND 决定实现。
 */
const CALC_PSEUDO = new Set([
  'RAND',
  'CHARANUM',
  'EMUERA_VERSION',
  'LINECOUNT',
  'ISTIMEOUT',
  'MONEYLABEL',
  'WINDOW_TITLE',
  'DRAWLINESTR',
  'LASTLOAD_VERSION',
  'LASTLOAD_TEXT',
  'LASTLOAD_NO',
  '__FILE__',
  '__FUNCTION__',
  '__LINE__',
  '__INT_MAX__',
  '__INT_MIN__',
]);

/** ERB 语言级局部量（Emuera 内置；不构成快照状态） */
const LANGUAGE_LOCAL = new Set([
  'LOCAL',
  'LOCALS',
  'LOCALSS',
  'ARG',
  'ARGS',
  'RESULT',
  'RESULTS',
  'COUNT',
]);

/** 内置角色变量清单（用于"存档缺变量 → 引擎默认 0/''"判定） */
export function isKnownCharaVariable(name: string): boolean {
  return (
    CHARA_INT_1D.has(name) ||
    CHARA_INT_SCALAR.has(name) ||
    CHARA_STR_SCALAR.has(name) ||
    CHARA_STR_1D.has(name) ||
    CHARA_INT_2D.has(name)
  );
}

/** 内置全局变量清单（同上语义） */
export function isKnownGlobalVariable(name: string): boolean {
  return (
    GLOBAL_INT_1D.has(name) ||
    GLOBAL_INT_2D.has(name) ||
    GLOBAL_INT_3D.has(name) ||
    GLOBAL_STR_SCALAR.has(name) ||
    GLOBAL_STR_1D.has(name)
  );
}

export function isCalcPseudo(name: string): boolean {
  return CALC_PSEUDO.has(name);
}

export function isLanguageLocal(name: string): boolean {
  return LANGUAGE_LOCAL.has(name);
}

/**
 * 引擎常量伪变量（Int64 边界）——`VariableToken.cs` 的
 * `__INT_MAX__Token.GetIntValue()` 返回 `Int64.MaxValue` /
 * `__INT_MIN__Token` 返回 `Int64.MinValue`（`VariableCode.cs` 标 `__CALC__ | __UNCHANGEABLE__`）。
 * ⚠ 本层数值域为 double：`Int64.MaxValue`（2^63-1）落为 **2^63**（最近可表示值）；
 * 快照标量经 sav-parser 安全整数守卫 ⇒ 与边界比较不受该舍入影响，等值比较只对
 * 恰好等于 Int64.MaxValue 的值失真（快照内不会出现）。
 */
export const INT64_MAX = Number('9223372036854775807'); // Int64.MaxValue → double 落为 2^63
export const INT64_MIN = -Number('9223372036854775808'); // Int64.MinValue = -2^63（double 精确）

/** 引擎常量求值：`__INT_MAX__` / `__INT_MIN__` → 数值；否则 null（非本类） */
export function resolveEngineConstant(name: string): number | null {
  if (name === '__INT_MAX__') return INT64_MAX;
  if (name === '__INT_MIN__') return INT64_MIN;
  return null;
}

/** 快照可得伪变量：`CHARANUM` = 角色登记数（`varData.CharacterList.Count`）= 快照角色块数 */
export function isCharaCountPseudo(name: string): boolean {
  return name === 'CHARANUM';
}

/**
 * 变量寻址类别：声明"参数如何映射到存储单元"。
 * `valueKind` 供求值器判定类型（数值 / 字符串）。
 */
export type VarModel =
  | { domain: 'chara'; dims: 1; valueKind: 'int'; form: 'array1d' } // [c, i]
  | { domain: 'chara'; dims: 2; valueKind: 'int'; form: 'array2d' } // [c, i, j]
  | { domain: 'chara'; dims: 0; valueKind: 'int'; form: 'scalar' } // [c]
  | { domain: 'chara'; dims: 0; valueKind: 'str'; form: 'scalar' } // [c]
  | { domain: 'chara'; dims: 1; valueKind: 'str'; form: 'array1d' } // [c, i]
  | { domain: 'global'; dims: 1; valueKind: 'int'; form: 'array1d' } // [i]
  | { domain: 'global'; dims: 2; valueKind: 'int'; form: 'array2d' } // [i, j]
  | { domain: 'global'; dims: 3; valueKind: 'int'; form: 'array3d' } // [i, j, k]
  | { domain: 'global'; dims: 0; valueKind: 'str'; form: 'scalar' }
  | { domain: 'global'; dims: 1; valueKind: 'str'; form: 'array1d' };

/** 按内置清单识别变量模型（未识别 → null；由数据驱动兜底） */
export function builtinVarModel(name: string): VarModel | null {
  if (CHARA_INT_1D.has(name)) return { domain: 'chara', dims: 1, valueKind: 'int', form: 'array1d' };
  if (CHARA_INT_2D.has(name)) return { domain: 'chara', dims: 2, valueKind: 'int', form: 'array2d' };
  if (CHARA_INT_SCALAR.has(name)) return { domain: 'chara', dims: 0, valueKind: 'int', form: 'scalar' };
  if (CHARA_STR_SCALAR.has(name)) return { domain: 'chara', dims: 0, valueKind: 'str', form: 'scalar' };
  if (CHARA_STR_1D.has(name)) return { domain: 'chara', dims: 1, valueKind: 'str', form: 'array1d' };
  if (GLOBAL_INT_1D.has(name)) return { domain: 'global', dims: 1, valueKind: 'int', form: 'array1d' };
  if (GLOBAL_INT_2D.has(name)) return { domain: 'global', dims: 2, valueKind: 'int', form: 'array2d' };
  if (GLOBAL_INT_3D.has(name)) return { domain: 'global', dims: 3, valueKind: 'int', form: 'array3d' };
  if (GLOBAL_STR_SCALAR.has(name)) return { domain: 'global', dims: 0, valueKind: 'str', form: 'scalar' };
  if (GLOBAL_STR_1D.has(name)) return { domain: 'global', dims: 1, valueKind: 'str', form: 'array1d' };
  return null;
}

/** 由存档变量类型串推断形状（#DIM 用户变量数据驱动兜底；domain 由调用方决定） */
export function varShapeFromArchiveType(type: string): { dims: 0 | 1 | 2 | 3; valueKind: 'int' | 'str' } | null {
  const valueKind: 'int' | 'str' = type.startsWith('int') ? 'int' : 'str';
  if (type.endsWith('-array-1d')) return { dims: 1, valueKind };
  if (type.endsWith('-array-2d')) return { dims: 2, valueKind };
  if (type.endsWith('-array-3d')) return { dims: 3, valueKind };
  if (type === 'int' || type === 'str') return { dims: 0, valueKind };
  return null; // map / xml / datatable 等非数值形态
}
