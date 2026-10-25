/**
 * 适配器清单 ⇄ 审计词表的桥。
 *
 * 审计脚本要拦的是「游戏名泄漏到通用层」；游戏名的清单在
 * `packages/app/src/adapter-manifest.ts`（接新游戏只改那一个文件）。
 * 这里从清单里读出 `auditWord`，让**新增 adapter 不必再改审计脚本**。
 *
 * fail-closed：清单读不到 / 读不到 auditWord ⇒ 直接抛错（审计判红），
 * 绝不「读不到就当没有游戏名」——那等于把新游戏名放行。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 清单文件（相对仓库根） */
export const MANIFEST_REL = 'packages/app/src/adapter-manifest.ts';

/** 从清单源码里取 `auditWord: '…'` 列表 */
export function extractAuditWords(source) {
  const out = [];
  const re = /auditWord:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

/** 读清单 → 审计词（读不到就抛） */
export function manifestAuditWords(root) {
  const file = path.join(root, MANIFEST_REL);
  const source = readFileSync(file, 'utf8');
  const words = extractAuditWords(source);
  if (words.length === 0) {
    throw new Error(`${MANIFEST_REL} 里没读到 auditWord —— 审计词表会漏掉新游戏名`);
  }
  return words;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把清单里的游戏名并进既有黑名单正则（`baseSource` 是正则源码字符串）。
 *
 * 纯 ASCII 词套 `\b`（与既有黑名单同口径）：`ERATW_GAME_ADAPTER` 这类标识符
 * 里 `_` 属词字符，加边界后不误伤；含非 ASCII 的词（中文名）不套边界——
 * JS 正则的词边界对 CJK 不可靠，套了反而漏。
 */
export function withManifestWords(baseSource, words) {
  const extra = words
    .map((w) => (/^[\x20-\x7e]+$/.test(w) ? `\\b${escapeRegExp(w)}\\b` : escapeRegExp(w)))
    .join('|');
  return new RegExp(`${baseSource}|${extra}`, 'i');
}
