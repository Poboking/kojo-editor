import type { ErbIndexState } from '@kojo/plugin-api';

/**
 * 索引"为什么没有"的**宿主侧查表面**（ST-CONSUMERS，2026-10-20）。
 *
 * 上一批（IDX-STATE）把三态与覆盖的**判据**做成了可查事实，但只接给函数树一条通道。
 * 本文件把同一条事实接给其余三条只问"有没有"的宿主通道（`Ctrl+T` / 改名台账 / 调用层级），
 * 形状照 `ui-kojo-navigator/src/panel-copy.ts`：
 *
 * - **判据一律住提供方**（`erb-parser/index-state.ts` 的 `coverageOf()` / `phaseOf()`）：
 *   本文件只做 `phase → 文案` 的**查表**与**原始读数的转录**，一个形状比较都不写；
 *   抄一次对 `rootsWalked` 的比较就红，守卫见
 *   `packages/plugins/ui-kojo-navigator/tests/index-state-single-source.test.ts` 第 ⑤ 组。
 * - **只在既有文案面上接**：三条通道原本各自的"索引没有"那一格现在改成查表，
 *   没有新增 toast / 徽章 / 状态栏，也没给任何一格新开显示面。
 * - **表值 `null` = 本通道这一格不发言**，交回它原来那句（旧消费方零改动）；
 *   表里没有的将来态同样落回原句 ⇒ 绝不静默空白、也绝不替提供方编新裁决。
 * - `state === null`（提供方是旧实现、`indexState()` 缺席）⇒ 一律退回旧句，additive 纪律。
 */

/** 三通道那一格的原句（`null` 分支与"提供方没交事实"共用同一组常量，两处各写必然漂移） */
const LEGACY_WS_INDEXING = '索引构建中，稍候即可搜索函数名';
const LEGACY_LEDGER = 'ERB 函数索引未建（打开项目后仍在构建）';
const LEGACY_CALL_HIERARCHY = 'ERB 函数索引未建（索引随项目打开自动构建，稍后再试）。';

/** 一个阶段在三条通道里各说什么（列 = 通道，行 = phase；全是查表，没有一行判据） */
interface PhaseCopy {
  /** `Ctrl+T` 空结果那一格（`null` = 索引这侧无话，交回查询层） */
  readonly ws: string | null;
  /** 改名台账抛错的前半句（`null` = 用 {@link LEGACY_LEDGER}） */
  readonly ledger: string | null;
  /** 调用层级那一格（`null` = 用 {@link LEGACY_CALL_HIERARCHY}） */
  readonly blocked: string | null;
  /** 那一格要不要把原始错误一起带上（只有失败态有错误可带） */
  readonly withError: boolean;
}

/** **唯一一张**宿主侧的 phase→文案表（三条通道共用；测试与守卫按它钉"表只有一张"） */
export const INDEX_PHASE_COPY: Readonly<Record<string, PhaseCopy>> = {
  idle: { ws: LEGACY_WS_INDEXING, ledger: LEGACY_LEDGER, blocked: null, withError: false },
  scanning: {
    ws: LEGACY_WS_INDEXING,
    ledger: 'ERB 函数索引正在构建',
    blocked: null,
    withError: false,
  },
  ready: { ws: null, ledger: null, blocked: null, withError: false },
  'nothing-to-scan': {
    ws: '没有可扫描的位置：项目目录与授权的工作区都没交出一个可扫的位置（"没地方可扫" ≠ "这个名字没有"）',
    ledger: 'ERB 函数索引没有可扫描的位置（一个可扫的位置都没走到）',
    blocked: '没有可扫描的位置：项目目录与授权的工作区都没交出一个可扫的位置，调用层级无从算起。',
    withError: false,
  },
  empty: {
    ws: '位置走到了、文件也扫了，函数名录里确实一条都没有（"扫了什么都没有" ≠ "没扫"）',
    ledger: 'ERB 函数索引扫过了，名录里一个函数都没有',
    blocked: '位置走到了、文件也扫了，函数名录里确实一条都没有，调用层级无从算起。',
    withError: false,
  },
  failed: {
    ws: '函数索引这一轮构建失败，名录不可用',
    ledger: 'ERB 函数索引这一轮构建失败',
    blocked: '函数索引这一轮构建失败，调用层级无从算起。',
    withError: true,
  },
};

/** 本轮的原始读数（**转录**提供方交出的三个数，本文件一律不重新判形状） */
export function appIndexReadoutInline(state: ErbIndexState): string {
  return `走了 ${state.rootsWalked} 个位置 · 扫了 ${state.filesScanned} 个文件 · 名录 ${state.functions} 名`;
}

/**
 * 逐来源读数（有 `title` 的通道交给悬停：哪一类位置交出几个根、哪一类本轮读不到）。
 * "读不到"这件事由 `reason` 那一句原文说出 ⇒ 本文件不碰 `available` 的形状。
 */
export function appIndexSourceReadout(state: ErbIndexState): string {
  const perSource = state.sources
    .map((s) => `${s.source} 交出 ${s.offered} 个根${s.reason ? `（读不到：${s.reason}）` : ''}`)
    .join(' / ');
  return perSource === '' ? '本轮还没有过任何来源陈述' : perSource;
}

/** 完整读数（多行；只进悬停，不当第一眼） */
export function appIndexReadoutTitle(state: ErbIndexState): string {
  const lines = [
    `来源：${appIndexSourceReadout(state)}`,
    `${appIndexReadoutInline(state)}`,
    `阶段：${state.phase} · 覆盖：${state.coverage}`,
  ];
  if (state.error) lines.push(`错误：${state.error}`);
  return lines.join('\n');
}

/** 查那一行（表里没有的将来态 ⇒ `undefined`，由各通道落回自己的原句） */
function copyOf(state: ErbIndexState): PhaseCopy | undefined {
  return INDEX_PHASE_COPY[state.phase];
}

/** 失败态把原始错误原文带上（其余阶段没有错误可带；这一寸不是判据，是拼句） */
function withError(entry: PhaseCopy, state: ErbIndexState, text: string): string {
  return entry.withError && state.error ? `${text}（原始错误：${state.error}）` : text;
}

/**
 * `Ctrl+T`：索引这一侧对"为什么搜不到"能说的话（`null` = 索引不背这个锅，交回查询层）。
 *
 * 旧形态是 `fileCount === 0` 一律「当前项目还没有可用的函数索引」——那一句把
 * **没地方可扫**与**扫了什么都没有**糊成了一句假话。现在读数照旧可查（括号里给）。
 */
export function workspaceSymbolIndexCopy(state: ErbIndexState | null): string | null {
  if (!state) return null;
  const entry = copyOf(state);
  if (!entry || entry.ws === null) return null;
  return `${withError(entry, state, entry.ws)}（${appIndexReadoutInline(state)}）`;
}

/** 改名台账：索引这一轮的事实（抛错消息的前半句，通道自己拼「，无法核对同名记号」） */
export function nameLedgerIndexCopy(state: ErbIndexState | null): string {
  const entry = state ? copyOf(state) : undefined;
  if (!state || !entry || entry.ledger === null) return LEGACY_LEDGER;
  return withError(entry, state, entry.ledger);
}

/**
 * 调用层级：索引这一轮说不出调用关系时的那一句。
 *
 * 两个面共用一张表：索引对象缺席（`!index` 那一格）与索引在场但本轮没东西可说
 * （旧形态会回答"第 N 行不在任何 ERB 函数体内"——对"根本没地方可扫"同样是假话）。
 * `null` = 交回该面原来的句子 ⇒ 旧行为零改动。
 */
export function callHierarchyIndexCopy(state: ErbIndexState | null): string | null {
  if (!state) return null;
  const entry = copyOf(state);
  if (!entry || entry.blocked === null) return null;
  return `${withError(entry, state, entry.blocked)}（${appIndexReadoutInline(state)}）`;
}

/** 调用层级那一格的悬停读数（`null` ⇒ 不给 title，与改前逐字一致） */
export function callHierarchyIndexTitle(state: ErbIndexState | null): string | undefined {
  if (!state) return undefined;
  const entry = copyOf(state);
  if (!entry || entry.blocked === null) return undefined;
  return appIndexReadoutTitle(state);
}
