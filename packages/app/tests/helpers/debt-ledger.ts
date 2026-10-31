/**
 * 欠账账本型判据的共用口径（`@debt-ledger`）。
 *
 * ## 什么叫「欠账账本型判据」
 *
 * 它断言的不是「实现正确」，而是**「这笔账还没还」**：
 *   `expect(裸字号处).toEqual(['styles-project.css font-size: 10px;' × 10, '…9px;'])`
 * 收口一枚，就必须从账上划掉一行，否则红。
 *
 * ## 为什么需要本模块
 *
 * 这类判据在**收口那一刻必然红**——那是设计使然，不是"把什么改坏了"。但默认的
 * `expect(a).toEqual(b)` 只打印一份 diff，人得回去读注释才知道该往哪个方向动。
 * 2026-10-31 收口 `AE-SCROLLFADE` 时实拍：两条判据同时红，第一反应是"我改坏了"，
 * 读完注释才确认是"该划账"。这个模块把那句话搬到失败信息里：红的那一刻自带动作。
 *
 * ## 标记与一致性
 *
 * 在判据的 `it(...)` 上方写一行注释：
 *   `// @debt-ledger BOARD:AE-SPLIT4`     这笔账挂在看板某张卡上（卡删了就该改判据）
 *   `// @debt-ledger LOCAL:sub-rung-11px` 账本自持，不跟看板
 *
 * `packages/app/tests/debt-ledger-registry.test.ts` 会扫全仓标记，并与看板对账：
 * **卡已删、标记还在** ⇒ 红，提示"这条判据该从'欠着'改成'收口证据'"。
 * 这就是把"收口时必须同步改判据"从『记得』变成『删行即红』。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

export interface LedgerOpts {
  /** 账本常量名，如 `SUB_RUNG_LEDGER`——失败信息里点名，方便直接跳过去 */
  readonly ledgerName: string;
  /** `@debt-ledger` 的 KEY，必须与判据上方那行标记一致 */
  readonly marker: string;
  /** 划账协议：一句话说清"多了怎么办、少了怎么办" */
  readonly how: string;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/**
 * 账本比对：等价于 `expect(actual).toEqual(ledger)`，但**失败信息自带划账协议**。
 *
 * 两侧都会先排序（账本是集合语义，顺序不该成为判据）；若调用方已经排过序，再排一次也安全。
 */
export function expectLedger(
  actual: readonly string[],
  ledger: readonly string[],
  opts: LedgerOpts,
): void {
  const a = sorted(actual);
  const l = sorted(ledger);
  if (a.length === l.length && a.every((v, i) => v === l[i])) return;

  const added = a.filter((x) => !l.includes(x));
  const gone = l.filter((x) => !a.includes(x));
  const lines = [`【欠账账本不一致】${opts.ledgerName}（@debt-ledger ${opts.marker}）`];
  if (added.length > 0) {
    lines.push(
      `  + ${added.length} 处**新欠账**（现状有、账上没有）——必须补账，并在提交信息里说清为什么新增：`,
      ...added.map((x) => `      + ${x}`),
    );
  }
  if (gone.length > 0) {
    lines.push(
      `  - ${gone.length} 处**已收口**（账上有、现状没了）——必须从账上划掉这几行，并把理由写进提交信息：`,
      ...gone.map((x) => `      - ${x}`),
    );
  }
  lines.push(`  划账协议：${opts.how}`);
  expect(a, lines.join('\n')).toEqual(l);
}

export interface DebtMarker {
  readonly file: string;
  readonly line: number;
  readonly key: string;
}

const MARKER_RE = /@debt-ledger\s+(BOARD:[A-Za-z][A-Za-z0-9-]*|LOCAL:[a-z0-9][a-z0-9-]*)/g;

/** 扫一棵目录树里的 `@debt-ledger` 标记（只扫 `.ts`；`helpers/` 自身不算判据） */
export function scanDebtMarkers(root: string, acc: DebtMarker[] = []): DebtMarker[] {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'helpers') continue;
      scanDebtMarkers(abs, acc);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith('.ts')) continue;
    const text = readFileSync(abs, 'utf8');
    if (!text.includes('@debt-ledger')) continue;
    text.split('\n').forEach((l, i) => {
      for (const m of l.matchAll(MARKER_RE)) {
        // 分组必命中（正则里只有一枚捕获组），但 `noUncheckedIndexedAccess` 下类型仍是
        // `string | undefined`；显式收窄，别用 `!` 把这条纪律绕过去。
        const key = m[1];
        if (!key) continue;
        acc.push({ file: path.relative(root, abs).split(path.sep).join('/'), line: i + 1, key });
      }
    });
  }
  return acc;
}
