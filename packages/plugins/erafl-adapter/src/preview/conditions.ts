/**
 * 口上 XML 的**条件抽取**（预览面，纯函数）。
 *
 * 为什么单独成层而不塞进解析器：解析器只负责"文件 → 结构"，它不判断哪个属性
 * 是条件。条件语义是**游戏知识**（`isFall` 管恋爱状态、`emotion` 管情绪），
 * 只能住在 adapter；预览 / 条件矩阵 / 校验共用同一份抽取结果，才不会各写一套
 * 互相对不上的判据。
 *
 * 判定边界（"哪些属性算条件"）——判据是**被调用后是否命中**，而不是"条目属于谁"：
 * - **算**：`eval`（表达式）、`isFall` / `emotion`（逗号多值）、以及状态/阈值族
 *   （`isInitiative` / `isMob` / `atRaped` / `isDateMode` / `initiative` /
 *   `lust` / `HO_Act` / `moduleAttributes` / `moduleUsage` / `talent` /
 *   `ability` / `speakerSex` / `val` / `rate` / `randRate`）。
 * - **不算**（它们不参与真假判定）：
 *   - 身份与位置：`com` / `name` / `kojoPlace` / `place` / `priority`；
 *   - 归属与主体口径：`forMaster` / `PLYorTGT` / `ACTorTGT` / `isPlayer` / `datePLYorTGT`；
 *   - 调用点（决定"何时被调用"，不是"调用后是否命中"）：`eventId` / `questId` /
 *     `questRoomId` / `questEventId` / `option` / `sequence`；
 *   - 战斗调用键：`skillDefName` / `actionName`；
 *   - 文本记号：`token`；
 *   - 行为开关（影响命中后的表现，不决定命中）：`isExclusive` / `isUfufu` / `cutDescription`。
 *
 * 用**白名单**而不是"除了几个之外都算"：语料里有拼错的属性（`ikojoPlace` /
 * `sExclusive` / `ust`），黑名单会把它们当成新条件，白名单则安静忽略——拼写问题
 * 归诊断面管，不该在这里变成一条假条件。
 *
 * 输入契约：`attrs` 的值**已经解过 XML 实体**（`KojoXmlCommand.attrs` 的约定），
 * 所以这里不再 `decode`——二次解码会把 `&amp;quot;` 这类原文错误地变成 `"`。
 * 本函数不读盘、不抛异常：畸形输入（null / 非对象 / 值不是字符串）一律返回空数组。
 */

import type { KojoXmlCondition } from '@kojo/plugin-api';

// 形状的真源在契约（`plugin-api/kojo-xml.ts`）：面板要直接渲染它，宿主不能 import
// adapter。这里只 re-export，不再维护第二份定义。
export type { KojoXmlCondition };

/** 逗号多值属性：语料里一个属性并列多个状态（`LOVER,SLAVED_BY`），逐项都是独立判据 */
const MULTI_VALUE_SOURCES: ReadonlySet<string> = new Set(['isFall', 'emotion']);

/**
 * 单值条件属性白名单。
 *
 * 只列"参与命中判定"的：状态布尔、数值阈值、名字匹配。`eval` 单独处理（它是表达式）。
 */
const SINGLE_VALUE_SOURCES: ReadonlySet<string> = new Set([
  'isInitiative',
  'isMob',
  'atRaped',
  'isDateMode',
  'initiative',
  'lust',
  'HO_Act',
  'moduleAttributes',
  'moduleUsage',
  'talent',
  'ability',
  'speakerSex',
  'val',
  'rate',
  'randRate',
]);

/**
 * 去掉 `eval` 的外层花括号。
 *
 * 真盘有 56 处没写全（只有一边花括号，甚至完全没写）——那些条目在引擎里是否
 * 命中取决于作者原意，但**条件本身存在**；丢掉等于静默隐藏一条判据，比原样
 * 展示更容易被作者发现并修正。所以左右花括号各剥各的，剩下的原文照出。
 */
function stripEvalBraces(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('{')) value = value.slice(1);
  if (value.endsWith('}')) value = value.slice(0, -1);
  return value.trim();
}

/** 解析单个取值：`!LOVER` → `{ expression: 'LOVER', negated: true }`；空串/孤立 `!` = null */
function parseValue(raw: string): { expression: string; negated: boolean } | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.startsWith('!')) {
    const rest = value.slice(1).trim();
    // 只有 `!` 没有取值：这是作者写坏了，不该产出一条"取反空值"的假条件
    return rest.length === 0 ? null : { expression: rest, negated: true };
  }
  return { expression: value, negated: false };
}

/**
 * 抽取一条口上的全部条件。
 *
 * 顺序 = 属性在原文里的书写顺序（`Object.entries` 保序），多值属性内部保逗号顺序。
 * 这样"条件矩阵"的行序与作者看到的 XML 一致，改一行不会让整张表跳位。
 */
export function extractKojoXmlConditions(
  cmd: { readonly attrs?: Readonly<Record<string, string>> | null } | null | undefined,
): KojoXmlCondition[] {
  const attrs = cmd?.attrs;
  // 畸形输入：null / 非对象 / 数组（数组也有 entries，但没有属性名语义）一律当没有
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return [];

  const conditions: KojoXmlCondition[] = [];
  for (const [source, raw] of Object.entries(attrs)) {
    if (typeof raw !== 'string') continue;

    if (source === 'eval') {
      const expression = stripEvalBraces(raw);
      // `{}` / 空白：没有判据可抽，不产出一条空条件
      if (expression.length > 0) {
        conditions.push({ source, kind: 'expr', expression, negated: false });
      }
      continue;
    }

    if (MULTI_VALUE_SOURCES.has(source)) {
      for (const item of raw.split(',')) {
        const parsed = parseValue(item);
        if (parsed) {
          conditions.push({ source, kind: 'value', expression: parsed.expression, negated: parsed.negated });
        }
      }
      continue;
    }

    if (SINGLE_VALUE_SOURCES.has(source)) {
      const parsed = parseValue(raw);
      if (parsed) {
        conditions.push({ source, kind: 'value', expression: parsed.expression, negated: parsed.negated });
      }
    }
  }
  return conditions;
}
