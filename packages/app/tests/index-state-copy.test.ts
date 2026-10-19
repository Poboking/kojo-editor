import type { ErbIndexState } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  INDEX_PHASE_COPY,
  appIndexReadoutInline,
  appIndexReadoutTitle,
  callHierarchyIndexCopy,
  callHierarchyIndexTitle,
  nameLedgerIndexCopy,
  workspaceSymbolIndexCopy,
} from '../src/ui/index-state-copy';

/**
 * ST-CONSUMERS（2026-10-20）：宿主三条通道的"为什么没有索引"那一格**按 phase 查表**。
 *
 * 钉两件事：
 * 1. `nothing-to-scan`（没地方可扫）与 `empty`（扫了什么都没有）**必须不同句**，
 *    且两句都带得出原始读数——旧形态那一句「当前项目还没有可用的函数索引」把两者糊成假话；
 * 2. 文案层**只认 phase**：同一 phase、不同 `rootsWalked` / `coverage` / `sources`
 *    ⇒ 首句逐字相同（形状判据住 `erb-parser/index-state.ts`，这里再算一遍就是第二份真相）。
 */

const LEGACY_LEDGER = 'ERB 函数索引未建（打开项目后仍在构建）';
const LEGACY_WS_INDEXING = '索引构建中，稍候即可搜索函数名';

/** 一枚事实（phase 由调用方给定——本测试刻意**不**经过提供方，测的是文案层的查表） */
function state(over: Partial<ErbIndexState> = {}): ErbIndexState {
  return {
    phase: 'ready',
    sources: [
      { source: 'project', offered: 2, available: true },
      { source: 'workspace', offered: 1, available: true },
    ],
    rootsWalked: 3,
    filesScanned: 120,
    functions: 4500,
    coverage: 'full',
    ...over,
  };
}

describe('workspaceSymbolIndexCopy · Ctrl+T 那一格（phase 分开说）', () => {
  it('提供方没交事实 ⇒ 交回 null（查询层继续用旧读数，旧行为零改动）', () => {
    expect(workspaceSymbolIndexCopy(null)).toBeNull();
  });

  it('就绪 ⇒ null（索引不背这个锅，"无匹配符号"照常由查询层说）', () => {
    expect(workspaceSymbolIndexCopy(state())).toBeNull();
  });

  it('没地方可扫 ≠ 扫了什么都没有：两句不同、各带原始读数', () => {
    const nowhere = workspaceSymbolIndexCopy(state({ phase: 'nothing-to-scan', rootsWalked: 0, filesScanned: 0, functions: 0 }))!;
    const nothing = workspaceSymbolIndexCopy(state({ phase: 'empty', rootsWalked: 1, filesScanned: 0, functions: 0 }))!;
    expect(nowhere).not.toEqual(nothing);
    expect(nowhere).toContain('没有可扫描的位置');
    expect(nowhere).toContain('走了 0 个位置 · 扫了 0 个文件 · 名录 0 名');
    expect(nothing).toContain('确实一条都没有');
    expect(nothing).toContain('走了 1 个位置 · 扫了 0 个文件 · 名录 0 名');
  });

  it('还没开扫 / 正在扫 ⇒ 仍是"稍候"那一句，但读数照给', () => {
    for (const phase of ['idle', 'scanning'] as const) {
      const text = workspaceSymbolIndexCopy(state({ phase }))!;
      expect(text.startsWith(`${LEGACY_WS_INDEXING}（`)).toBe(true);
    }
  });

  it('失败 ⇒ 说"构建失败"并逐字带上原始错误与本轮读数', () => {
    const text = workspaceSymbolIndexCopy(state({ phase: 'failed', error: 'EACCES: permission denied /erb' }))!;
    expect(text).toContain('构建失败');
    expect(text).toContain('原始错误：EACCES: permission denied /erb');
    expect(text).toContain('走了 3 个位置');
  });

  it('文案层只认 phase：同 phase、形状各异 ⇒ 首句逐字相同（不重新判形状）', () => {
    const head = (s: ErbIndexState): string => workspaceSymbolIndexCopy(s)!.split('（')[0]!;
    const a = state({ phase: 'empty', rootsWalked: 9, filesScanned: 999, functions: 0, coverage: 'full' });
    const b = state({ phase: 'empty', rootsWalked: 1, filesScanned: 0, functions: 0, coverage: 'partial' });
    expect(head(a)).toBe(head(b));
  });

  it('提供方将来加新态 ⇒ 交回 null 落回旧读数，绝不静默空白也不替它编裁决', () => {
    expect(workspaceSymbolIndexCopy(state({ phase: 'settled' as unknown as ErbIndexState['phase'] }))).toBeNull();
  });
});

describe('nameLedgerIndexCopy · 改名台账那一句', () => {
  it('没交事实 ⇒ 逐字退回原句（既有抛错文本零改动）', () => {
    expect(nameLedgerIndexCopy(null)).toBe(LEGACY_LEDGER);
  });

  it('三态各一句，且都不再说"稍后再试"以外的假承诺', () => {
    expect(nameLedgerIndexCopy(state({ phase: 'nothing-to-scan', rootsWalked: 0, functions: 0 }))).toContain(
      '没有可扫描的位置',
    );
    expect(nameLedgerIndexCopy(state({ phase: 'empty', functions: 0 }))).toContain('名录里一个函数都没有');
    expect(nameLedgerIndexCopy(state({ phase: 'failed', error: 'boom' }))).toContain('原始错误：boom');
    expect(nameLedgerIndexCopy(state({ phase: 'scanning' }))).toContain('正在构建');
  });

  it('就绪（自相矛盾的输入）⇒ 退回原句，不编新判据', () => {
    expect(nameLedgerIndexCopy(state())).toBe(LEGACY_LEDGER);
  });
});

describe('callHierarchyIndexCopy · 调用层级那一格', () => {
  it('idle / scanning / ready ⇒ null（那一格逐字用回改前的句子）', () => {
    expect(callHierarchyIndexCopy(null)).toBeNull();
    expect(callHierarchyIndexCopy(state({ phase: 'idle' }))).toBeNull();
    expect(callHierarchyIndexCopy(state({ phase: 'scanning' }))).toBeNull();
    expect(callHierarchyIndexCopy(state())).toBeNull();
  });

  it('没地方可扫 / 空名录 / 失败 ⇒ 说得出是哪一件，并给悬停完整逐来源读数', () => {
    const nowhere = state({ phase: 'nothing-to-scan', rootsWalked: 0, filesScanned: 0, functions: 0, coverage: 'none' });
    expect(callHierarchyIndexCopy(nowhere)).toContain('没有可扫描的位置');
    expect(callHierarchyIndexCopy(nowhere)).toContain('走了 0 个位置');
    expect(callHierarchyIndexTitle(nowhere)).toContain('project 交出 2 个根');
    expect(callHierarchyIndexCopy(state({ phase: 'empty', functions: 0 }))).toContain('确实一条都没有');
    expect(callHierarchyIndexCopy(state({ phase: 'failed', error: 'boom' }))).toContain('原始错误：boom');
  });

  it('降级那一轮：来源读不到的原文逐字进悬停（第一眼不甩技术串）', () => {
    const degraded = state({
      phase: 'nothing-to-scan',
      rootsWalked: 0,
      functions: 0,
      coverage: 'none',
      sources: [
        { source: 'project', offered: 0, available: false, reason: 'roots() 抛错：EPERM' },
        { source: 'workspace', offered: 0, available: true },
      ],
    });
    const title = callHierarchyIndexTitle(degraded);
    expect(title).toContain('project 交出 0 个根（读不到：roots() 抛错：EPERM）');
    expect(title).toContain('workspace 交出 0 个根');
    expect(title).toContain('阶段：nothing-to-scan · 覆盖：none');
  });
});

describe('读数是转录不是重算', () => {
  it('appIndexReadoutInline 逐字转录提供方交出的三个数', () => {
    expect(appIndexReadoutInline(state({ rootsWalked: 7, filesScanned: 8, functions: 9 }))).toBe(
      '走了 7 个位置 · 扫了 8 个文件 · 名录 9 名',
    );
  });

  it('本轮没有任何来源陈述 ⇒ 明说"没有陈述"，不编一条空清单', () => {
    expect(appIndexReadoutTitle(state({ sources: [] }))).toContain('本轮还没有过任何来源陈述');
  });

  it('表里每一行都是查表取句（形状判据一枚都不在文案层）', () => {
    // 三通道共用**这一张**表：加一态只改一行，写第二张表就守不住（守卫组 ⑤ 按处数钉）
    expect(Object.keys(INDEX_PHASE_COPY).sort()).toEqual([
      'empty',
      'failed',
      'idle',
      'nothing-to-scan',
      'ready',
      'scanning',
    ]);
  });
});
