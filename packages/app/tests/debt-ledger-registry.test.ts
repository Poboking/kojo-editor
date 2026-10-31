/**
 * `@debt-ledger` 标记 ↔ 看板一致性。
 *
 * 起因（2026-10-31 实拍）：收口 `AE-SCROLLFADE` 时，`aesthetic-ladder.test.ts` 里那条
 * 「两处口子必须仍在册」的判据**必然红**——它断言的正是"这笔账还没还"。当时得靠人记得
 * "哦，这条要跟着改"。同一天还撞到反例：`CMD-NUL-BYTE` 判据早已全绿、行还挂在看板上。
 *
 * 本测试把这两个方向里**可机械化的那一个**钉住：
 *   判据标了 `@debt-ledger BOARD:<ID>`，而看板上**已经没有这张卡** ⇒ 红。
 * 于是"删行"与"改判据"变成同一次提交里的两件事：只做前一半，测试就红给你看。
 *
 * 抓不到的那一半（诚实边界）：卡还在、判据其实早已满足（僵尸卡）。那需要**执行判据**，
 * 语义上没法从一张中文表里推出来——靠 `tools/board-audit.mjs` 的结构体检 + 认领前人工核实。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanDebtMarkers, type DebtMarker } from './helpers/debt-ledger';

const PKG_ROOT = fileURLToPath(new URL('../../../packages', import.meta.url));
const BOARD = fileURLToPath(new URL('../../../docs/BOARD.md', import.meta.url));

/** 扫所有 `packages/<pkg>/tests`（不是只有 app：标记属于判据，判据在哪都得对账） */
function collect(): DebtMarker[] {
  const out: DebtMarker[] = [];
  for (const pkg of readdirSync(PKG_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const dir = path.join(PKG_ROOT, pkg.name, 'tests');
    if (existsSync(dir)) scanDebtMarkers(dir, out);
  }
  return out;
}

describe('欠账账本标记与看板一致', () => {
  it('扫到了标记（防"零标记假绿"：路径写错时这条先红）', () => {
    const markers = collect();
    expect(markers.length, '一个 @debt-ledger 都没扫到，先确认扫描路径').toBeGreaterThan(0);
    for (const m of markers) console.log(`[debt-ledger] ${m.key}  ← ${m.file}:${m.line}`);
  });

  it('BOARD:<ID> 指向的卡仍在看板上；卡删了而标记还在 ⇒ 红（该把判据改成"收口证据"）', () => {
    const markers = collect().filter((m) => m.key.startsWith('BOARD:'));
    if (markers.length === 0 || !existsSync(BOARD)) return;

    const board = readFileSync(BOARD, 'utf8');
    const ids = new Set(
      [...board.matchAll(/^\|([A-Z][A-Za-z0-9-]*)\|/gm)].map((m) => m[1]),
    );

    const stale = markers
      .filter((m) => !ids.has(m.key.slice('BOARD:'.length)))
      .map((m) => `${m.key} @ ${m.file}:${m.line}`);
    expect(
      stale,
      '这些判据标着看板卡，但那张卡已经不在看板上了：\n' +
        '  若你刚交付/删行了 —— 请把对应判据从「欠着」改成「收口证据」（参照 aesthetic-ladder 里 AE-SCROLLFADE 的写法）；\n' +
        '  若是误删 —— 把行加回去。\n' +
        `    失配：${stale.join(' / ')}`,
    ).toEqual([]);
  });

  it('LOCAL:<name> 只校验形状（自持账本不跟看板，但必须可 grep）', () => {
    const local = collect().filter((m) => m.key.startsWith('LOCAL:'));
    for (const m of local) {
      expect(m.key, `${m.file}:${m.line} 的 KEY 形状不对`).toMatch(/^LOCAL:[a-z0-9][a-z0-9-]*$/);
    }
  });
});
