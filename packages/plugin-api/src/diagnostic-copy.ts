/**
 * 诊断码的**中文显示名**（ZH-D2：契约层单一真源）。
 *
 * 为什么要这张表：诊断码是给机器看的稳定标识（`section-mixed`、`timing-counter-unknown`），
 * 作者既读不懂也搜不到帮助。此前两个上屏点（壳层「问题」面板、`.kojo 校验`面板的码芯片）
 * 都把原码当第一眼直接甩出去。本表把「码 → 中文短名（+ 可选一句话说明）」收在**码声明的
 * 同一层**（契约层），两个消费方读同一张表——不在 UI 里各抄一份映射：两处口径迟早分叉，
 * 是本项目反复栽过的坑（同类教训见 `kojo-sugar/src/project.ts` 的码表注释）。
 *
 * 显示形态（照 `ui-condition-matrix` / `ui-kojo-navigator` 已交付的范式）：
 * **第一眼给中文短名，原码逐字留在悬停 `title`**——技术信息零丢失，作者报障时还能贴码。
 *
 * 架构铁律：本文件零游戏名词（只有标识符与中文短名，游戏侧语义一律留在适配器）。
 */

import type { SugarDiagnosticCode } from './sugar';

/** 一条诊断码的显示信息（`detail` 可选：作者想知道"这是什么事"时给一句话） */
export interface DiagnosticLabel {
  /** 中文短名（上屏第一眼；控制在 12 字内，面板列宽有限） */
  readonly name: string;
  /** 可选一句话说明（进悬停 title，不占第一眼） */
  readonly detail?: string;
}

/**
 * `SugarDiagnosticCode` 闭集的**运行期枚举**（与 `sugar.ts` 的类型逐一对账）。
 *
 * 类型联合本身在运行期不存在，而全覆盖闸必须能遍历每一条码 ⇒ 这里补一份同集的数组。
 * 两者的同步由 `tests/diagnostic-copy.test.ts` 用双向赋值检查钉死（漏一条 ⇒ typecheck 红），
 * 不靠人自觉。
 */
export const SUGAR_DIAGNOSTIC_CODES = [
  /* --- 结构 / 缩进 --- */
  'indent-mismatch',
  'block-empty',
  'unclosed-block',
  /* --- 表达式 `如果` / `当` --- */
  'expr-missing-else',
  'expr-body-not-expression',
  'rand-case-incomplete',
  /* --- 插值 --- */
  'interpolation-block-expression',
  'interpolation-unclosed',
  'interpolation-nested',
  'stray-percent',
  /* --- 别名 --- */
  'alias-not-in-header',
  'alias-name-conflict',
  'alias-duplicate',
  'readonly-alias-assignment',
  'alias-unknown-target',
  /* --- 时机 --- */
  'timing-face-unknown',
  'face-table-missing',
  'timing-duplicate',
  'function-name-duplicate',
  'timing-empty-body',
  'missing-charno',
  'timing-instruction-unknown',
  'timing-counter-unknown',
  'custom-command-no-range',
  'custom-command-range-exhausted',
  /* --- 选项 --- */
  'choice-multiple',
  'choice-nested',
  /* --- 段块 --- */
  'section-nested',
  'section-mixed',
  /* --- 文本行 --- */
  'cont-inside-quotes',
  'unknown-identifier',
  'family-name-unknown',
  'bit-name-unknown',
  'function-name-unknown',
  'function-name-typo',
  'notin-complex-operand',
  /* --- 原生直通 --- */
  'raw-block-inline',
  /* --- 兜底 --- */
  'internal',
] as const satisfies readonly SugarDiagnosticCode[];

/**
 * 原生层（结构 / 表达式）上屏的诊断码。
 *
 * 字符串形态由生产方唯一决定：`erb-parser` 的 `structureIssueCode`（`erb.${kind}`）与
 * `condition-extractor` 的 `erb.expr-${kind}`。这里按同一拼法列闭集，与各自的 kind 联合
 * 逐一对账（同样钉在双向检查里），不许消费方自己拼字符串。
 */
export const NATIVE_STRUCTURE_CODES = [
  'erb.orphan-close',
  'erb.unclosed-open',
  'erb.orphan-branch',
] as const;

/** 表达式诊断码闭集（词法错 / 语法错两类） */
export const NATIVE_EXPR_CODES = ['erb.expr-lexical', 'erb.expr-syntax'] as const;

/** 本表全部键的闭集（全覆盖闸用它与"码的并集"对账：既不许漏名，也不许留孤儿条目） */
export type DiagnosticCodeKey = (typeof SUGAR_DIAGNOSTIC_CODES)[number] | (typeof NATIVE_STRUCTURE_CODES)[number] | (typeof NATIVE_EXPR_CODES)[number];

/**
 * 码 → 中文显示名（＋可选说明）。
 *
 * 用 `aliasTable` 风格的**无原型**对象：查表键来自作者字节（原码可以来自任意插件贡献），
 * 普通对象字面量会让 `constructor` / `toString` 这类未登记输入命中 `Object.prototype` 成员
 * ——正是"未登记 ⇒ 不猜"要根除的 fail-open。
 */
const table = <T>(entries: Record<string, T>): Readonly<Record<string, T>> =>
  Object.assign(Object.create(null) as Record<string, T>, entries);

/** 已知码的中文显示名（键 = 上屏原码，逐字） */
export const DIAGNOSTIC_LABELS: Readonly<Record<string, DiagnosticLabel>> = table({
  /* --- `.kojo` 转译检查码（`SugarDiagnosticCode` 全集） --- */
  'indent-mismatch': { name: '缩进不齐', detail: '该行的缩进与所在块的层级不一致。' },
  'block-empty': { name: '块内无内容', detail: '块头写了，但下面没有更深缩进的正文。' },
  'unclosed-block': { name: '块未闭合', detail: '写到文件结尾，这个块还没有收回去。' },
  'expr-missing-else': { name: '缺少否则分支', detail: '取值位置的条件下必须穷尽所有情况。' },
  'expr-body-not-expression': { name: '分支体不是表达式', detail: '取值位置的每个分支都只能写「-> 一个表达式」。' },
  'rand-case-incomplete': { name: '随机档位没覆盖全', detail: '掷到没写的那些档位时不会有任何输出。' },
  'interpolation-block-expression': { name: '插值里写了块条件', detail: '花括号内不支持再嵌套条件块。' },
  'interpolation-unclosed': { name: '插值未闭合', detail: '左花括号没有对应的右花括号。' },
  'interpolation-nested': { name: '插值嵌套', detail: '花括号里又写了花括号。' },
  'stray-percent': { name: '多余的百分号', detail: '半角 % 在输出串里是变量记号，落单会出错。' },
  'alias-not-in-header': { name: '别名位置不对', detail: '别名声明必须写在所有时机块之前。' },
  'alias-name-conflict': { name: '别名重名', detail: '与保留代词或其他别名撞了名字。' },
  'alias-duplicate': { name: '别名重复声明', detail: '同一个别名被声明了两次。' },
  'readonly-alias-assignment': { name: '给只读别名赋值', detail: '这个角色/字面量别名不能被改写。' },
  'alias-unknown-target': { name: '别名指向不明', detail: '别名右边的写法不属于任何可解析的形态。' },
  'timing-face-unknown': { name: '时机类别不认识', detail: '这个类别词不在当前适配器登记的类别表里。' },
  'face-table-missing': { name: '缺少类别表', detail: '当前适配器没有提供这类写法需要的对照表。' },
  'timing-duplicate': { name: '时机编号重复', detail: '同一类别下的同一编号在本文件里出现了多次。' },
  'function-name-duplicate': { name: '生成函数名撞车', detail: '两种不同写法产出了同一个函数名。' },
  'timing-empty-body': { name: '时机无正文', detail: '已按占位处理。' },
  'missing-charno': { name: '缺少角色号', detail: '文件头没有声明「角色: 编号」，生成的函数名会残缺。' },
  'timing-instruction-unknown': { name: '指令名未登记', detail: '这个中文名不在指令表里；请改用数字编号。' },
  'timing-counter-unknown': { name: '计数器名未登记', detail: '这个中文名不在计数器表里；请改用数字编号。' },
  'custom-command-no-range': { name: '无法自动分配编号', detail: '既没写编号，适配器也没声明可用号段。' },
  'custom-command-range-exhausted': { name: '可用编号已占满', detail: '请显式写编号，或先腾出空位。' },
  'choice-multiple': { name: '选项块过多', detail: '一个时机内只允许一个选项块。' },
  'choice-nested': { name: '选项块嵌套', detail: '选项块里不能再套选项块。' },
  'section-nested': { name: '段块嵌套', detail: '段体内不能再写段块。' },
  'section-mixed': { name: '段与普通语句混写', detail: '同一段顶层混了两种产物骨架，无法确定写回形状。' },
  'cont-inside-quotes': { name: '续行标记写在引号内', detail: '续行标记必须写在引号外面。' },
  'unknown-identifier': { name: '无法识别的名字', detail: '既不是别名，也不在变量字典里。' },
  'family-name-unknown': { name: '该族下查无此名', detail: '族头认得出，但后面的名字不在该族的名称表里。' },
  'bit-name-unknown': { name: '位名无法定位', detail: '该变量的位表里落不到唯一的位号。' },
  'function-name-unknown': { name: '函数名未收录', detail: '这个名字既不在系统函数表也不在本游戏函数表里。' },
  'function-name-typo': { name: '函数名疑似拼错', detail: '表外名字对应到唯一一个已收录的近名，请按提示改法。' },
  'notin-complex-operand': { name: '区间判断的操作数过于复杂', detail: '含加减或函数调用时会被整体求值两次。' },
  'raw-block-inline': { name: '原生直通块位置不对', detail: '原生块只能写在顶层。' },
  internal: { name: '内部异常', detail: '转译器自身出错，请带上原始码反馈。' },

  /* --- 原生结构 / 表达式诊断（问题面板） --- */
  'erb.orphan-close': { name: '多余的闭合语句', detail: '这个闭合语句找不到对应的开块。' },
  'erb.unclosed-open': { name: '开块未闭合', detail: '走到函数边界或文件结尾，这个块还没闭合。' },
  'erb.orphan-branch': { name: '分支无人归属', detail: '这条分支语句前面没有它要归属的开块。' },
  'erb.expr-lexical': { name: '表达式有无法识别的字符', detail: '条件表达式里存在词法层面读不懂的内容。' },
  'erb.expr-syntax': { name: '表达式结构不对', detail: '条件表达式的括号、操作数或冒号写法不成立。' },

  /* --- 约定校验规则 id（同一张表供约定面板复用，避免第二份口径） --- */
  'erb.duplicate-function': { name: '函数重名' },
  'sugar.cont-inside-quotes': { name: '续行标记写在引号内' },
  'sugar.choice-multiple': { name: '选项块过多' },
  'sugar.expr-missing-else': { name: '缺少否则分支' },
  'sugar.readonly-alias-assignment': { name: '给只读别名赋值' },
  'sugar.static-conventions': { name: '写法约定' },
});

/**
 * **排除台账**（码 → 一条一行理由）：确实该继续原样显示的码在此留名，不留白。
 *
 * 判据与 `eratw-adapter` 的族别名台账同一形态：全覆盖闸要求每条码**要么有中文名、要么
 * 在这张台账里且写明理由**，防"悄悄没登记"。当前**空集**——本仓所有上屏码都是机器标识符，
 * 没有任何一条是"作者要抄进 `.kojo` 的语法关键字"；将来若真出现，必须逐条答"为何必须给
 * 作者看原码"再加条目，不许整片豁免。
 */
export const DIAGNOSTIC_CODE_EXCLUSIONS: Readonly<Record<string, string>> = table<string>({});

/** 一条码的屏幕呈现：第一眼中文短名，原码逐字留在悬停 title。 */
export interface DiagnosticDisplay {
  /** 上屏文本（未登记的码回落原码——可见但不编造中文名） */
  readonly name: string;
  /** 原码（逐字；报障时贴的就是它） */
  readonly code: string;
  /** 悬停 title：原码（＋有说明时附说明）；已知码额外保留原码本身 */
  readonly title: string;
}

/**
 * 取一条码的呈现（纯函数，零 React / 零内核依赖，可单测）。
 *
 * 台账内的码 ⇒ 原样显示（`name` 就是 `code`）；表内没有的码 ⇒ 回落原码，
 * **绝不编造中文**——未登记的码是上游漏了表，该由全覆盖闸报错，而不是在这儿猜。
 */
export function diagnosticDisplay(code: string): DiagnosticDisplay {
  if (Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODE_EXCLUSIONS, code)) {
    return { name: code, code, title: code };
  }
  const label = DIAGNOSTIC_LABELS[code];
  if (!label) return { name: code, code, title: code };
  return {
    name: label.name,
    code,
    title: label.detail ? `${code}｜${label.detail}` : code,
  };
}
