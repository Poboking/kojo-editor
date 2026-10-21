/**
 * Kojo 语义层的**值类型格**（设计稿 §16.6 S5.2 的第一块基石）。
 *
 * ## 格（lattice）
 *
 * ```
 *            unknown          （动态：函数返回值 / adapter 外部符号 / 证不出的表达式）
 *           /       \
 *        int        string   （叶子：显式声明类型）
 *          |
 *      character             （角色号：引擎里是整数，语义上不是普通 int）
 * ```
 *
 * - `unknown` 是格顶，也是"未知来源"：任一侧是 `unknown` 时静态判定**一律放行**——
 *   core 不做跨函数类型推断（§7.3），证不出就保留 `unknown`，绝不猜一个类型去报错；
 * - `character <: int`：角色号在引擎里就是整数（`@巡` 角色集合的绑定），赋给整数变量是
 *   有定义的收窄；反向 `int → character` 不做隐式提升（普通整数不是角色号）；
 * - `int` 与 `string` **互不隐式转换**（§3.4.2）；需要转换走 adapter 内建函数或 `@原生`。
 *
 * ## 为什么单独一枚
 *
 * 类型判定与"理由字符串"是诊断文案的一部分：同一对类型必须永远给出同一句话，测试才能
 * 逐字节钉住确定性。判定散在 `check.ts` 的各个分支里，迟早出现两份互相矛盾的文案。
 *
 * 纯数据、纯函数：无 IO、无 Monaco、无 adapter 依赖（adapter 事实由 `check.ts` 转成这里的格）。
 */
import type { KojoLiteral, KojoValueType } from '../ast.js';

/** 语义层的值类型（闭集；与 AST 的 `KojoValueType` 是超集关系） */
export type KojoSemaType = 'int' | 'string' | 'character' | 'unknown';

/** 可赋值判定结果：`ok === false` 时 `reason` 是可直接拼进诊断的作者可读理由 */
export interface KojoTypeAssignability {
  readonly ok: boolean;
  readonly reason: string;
}

/** 类型的中文标签（诊断文案唯一来源；不要在各检查分支里另写一份） */
const TYPE_LABELS: Readonly<Record<KojoSemaType, string>> = Object.freeze({
  int: '整数',
  string: '字符串',
  character: '角色号',
  unknown: '未知类型',
});

/** 类型标签（诊断/符号事实用；`int` → `整数`） */
export function semaTypeLabel(type: KojoSemaType): string {
  return TYPE_LABELS[type];
}

/**
 * 可赋值判定：`from` 类型的值能否写进 `to` 类型的槽。
 *
 * 判定顺序写死（诊断文案随之稳定）：
 * 1. 同类 → 放行；
 * 2. 任一侧 `unknown` → 放行（动态类型不参与静态判定）；
 * 3. `character → int` → 放行（角色号以整数落地）；
 * 4. 其余 → 拒绝，并说明"不做隐式转换"。
 *
 * 注意：放行不等于"类型相等"。调用方若需要精确相等（例如表值列同类型），
 * 用 `semaTypeOfLiteral` 比较即可，不要拿 `assignable` 冒充相等。
 */
export function assignable(from: KojoSemaType, to: KojoSemaType): KojoTypeAssignability {
  if (from === to) {
    return { ok: true, reason: `两侧都是${TYPE_LABELS[from]}，类型一致` };
  }
  if (from === 'unknown' || to === 'unknown') {
    const side = from === 'unknown' && to === 'unknown' ? '两侧' : from === 'unknown' ? '来源' : '目标';
    return { ok: true, reason: `${side}是动态类型，不参与静态类型判定` };
  }
  if (from === 'character' && to === 'int') {
    return { ok: true, reason: '角色号在引擎里以整数表示，可安全落入整数（语义上仍是角色号）' };
  }
  return {
    ok: false,
    reason: `不做隐式类型转换：${TYPE_LABELS[from]} 不能赋给 ${TYPE_LABELS[to]}`,
  };
}

/** AST 声明类型 → 语义类型（`int` / `string`；`character` 只从 adapter 事实来） */
export function semaTypeOfValueType(valueType: KojoValueType): KojoSemaType {
  return valueType;
}

/** 字面量 → 语义类型（`# 变量` 初值 / `# 常量` 值 / 参数默认值 / 表值列） */
export function semaTypeOfLiteral(value: KojoLiteral): KojoSemaType {
  return typeof value === 'number' ? 'int' : 'string';
}
