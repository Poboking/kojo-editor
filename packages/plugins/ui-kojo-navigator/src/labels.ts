/**
 * 函数树行级的**显示名/悬停文案**助手（从 `index.ts` 的模块级区块原样迁出，字符串逐字不变）。
 *
 * 三个都是纯函数，零 React、零服务：
 *   - `dependencyTitle`：依赖徽章的悬停（schema 描述 + 键 + 比较式）；
 *   - `familyLabel`：'' = 初始家族；
 *   - `faceLabel`：'' → 其它、`declare` → 家族声明，其余查适配器给的 `faceLabels`
 *     （未收录 ⇒ 原样显示面 token，fail-visible，不猜）。
 */

import type { StateDependency } from '@kojo/plugin-api';

/** 依赖的悬停提示（标签 + 阈值） */
export function dependencyTitle(d: StateDependency): string {
  const label = d.schema?.description ? `${d.schema.description}（${d.key}）` : d.key;
  const comps = d.comparisons.map((c) => `${c.op} ${c.text}`).join('、');
  return comps.length > 0 ? `${label} ${comps}` : label;
}

/** 家族显示名：'' = 初始家族 */
export function familyLabel(family: string): string {
  return family === '' ? '初始家族' : family;
}

/**
 * 面显示名：'' → '其它'；'declare' → '家族声明'；其余查 `labels`（适配器提供的
 * 面 → 中文），未收录 / 未注入则原样显示面 token（fail-visible，不猜）。
 */
export function faceLabel(face: string, labels?: Readonly<Record<string, string>>): string {
  switch (face) {
    case '':
      return '其它';
    case 'declare':
      return '家族声明';
    default:
      return labels?.[face] ?? face;
  }
}
