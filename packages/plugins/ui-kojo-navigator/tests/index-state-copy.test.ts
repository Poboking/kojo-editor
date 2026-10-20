/**
 * 函数树那一格的**三态文案**守卫（IDX-STATE，2026-10-19）。
 *
 * 钉口径而不是钉字符串运气（本文件既有范式）：
 * - 三态各自一句作者读得懂的中文短句，且**互不相同**——旧形态是"只要没就绪就永远说
 *   '正在构建函数索引'"，"没找到可扫描的位置"与"扫了什么都没有"都被它盖成一句假话；
 * - 每态都带一条**可查的悬停原始读数**：哪个来源给了几个根、降级少了什么、原始原因逐字在；
 * - 提供方没交事实（additive 方法缺席的老实现）⇒ 逐字退回旧等待句，旧行为零改动；
 * - 失败态**复用** `navLoadErrorCopy`，这里不许长出第二套失败文案；
 * - 面板那一侧只许"查表 + 转述"，形状判据一律在提供方（处数守门见
 *   `index-state-single-source.test.ts`）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbIndexCoverage, ErbIndexPhase, ErbIndexState } from '@kojo/plugin-api';
import {
  navCoverageCopy,
  navIndexPendingCopy,
  navLoadErrorCopy,
  navScanReadout,
  navTreeBodyCopy,
  navigatorScopeTitle,
} from '../src/panel-copy';

const PANEL = path.resolve(import.meta.dirname, '..', 'src', 'navigator-panel.ts');
const srcText = (): string => readFileSync(PANEL, 'utf8');

const state = (
  phase: ErbIndexPhase,
  over: Partial<ErbIndexState> = {},
): ErbIndexState => ({
  phase,
  sources: [
    { source: 'project', offered: 1, available: true },
    { source: 'workspace', offered: 0, available: false, reason: 'Error: no platform data dir' },
  ],
  rootsWalked: 1,
  filesScanned: 2317,
  functions: 0,
  coverage: (over.coverage ?? 'partial') as ErbIndexCoverage,
  ...over,
});

/** 三句短句必须两两不同（同一句盖三态就是本刀要修的那条假话） */
const NOTHING = state('nothing-to-scan', { coverage: 'none', rootsWalked: 0, filesScanned: 0 });
const EMPTY = state('empty', { filesScanned: 12 });
const SCANNING = state('scanning', { functions: 0 });

describe('函数树三态短句（IDX-STATE）', () => {
  it('三态各一句中文短句，且两两不同', () => {
    const texts = [SCANNING, NOTHING, EMPTY].map((s) => navIndexPendingCopy(s).text);
    for (const t of texts) expect(/[\u4e00-\u9fa5]/.test(t), t).toBe(true);
    expect(new Set(texts).size, '三态挤成同一句 = 回退成恒显占位').toBe(3);
  });

  it('还在建那一态保住原句（既有行为不许顺手改掉）', () => {
    expect(navIndexPendingCopy(SCANNING).text).toBe('正在构建函数索引…（首次打开项目需要数秒）');
    expect(navIndexPendingCopy(state('idle', { coverage: 'none', rootsWalked: 0 })).text).toBe(
      '正在构建函数索引…（首次打开项目需要数秒）',
    );
  });

  it('「没找到可扫描的位置」说得象人话，且不再让人干等', () => {
    const t = navIndexPendingCopy(NOTHING).text;
    expect(t).toContain('没有可扫描的位置');
    expect(t).not.toContain('正在构建');
  });

  it('「扫了确实一个函数都没有」与「没地方可扫」分得开', () => {
    const empty = navIndexPendingCopy(EMPTY).text;
    expect(empty).toContain('一个函数都没有');
    expect(empty).not.toBe(navIndexPendingCopy(NOTHING).text);
    expect(empty).not.toContain('没有可扫描的位置');
  });

  it('每态的悬停都是可查的原始读数：逐来源根数 + 降级原因 + 实走根数 + 已扫文件数', () => {
    for (const s of [SCANNING, NOTHING, EMPTY]) {
      const title = navIndexPendingCopy(s).title;
      expect(title, s.phase).toContain('project 交出 1 个根');
      expect(title, s.phase).toContain('workspace 交出 0 个根（读不到：Error: no platform data dir）');
      expect(title, s.phase).toContain(`实际走到的根：${s.rootsWalked} 个`);
      expect(title, s.phase).toContain(`已扫文件 ${s.filesScanned}`);
    }
  });

  it('提供方没交事实 ⇒ 逐字退回旧等待句（additive 方法缺席时零行为变化）', () => {
    expect(navIndexPendingCopy(null).text).toBe('正在构建函数索引…（首次打开项目需要数秒）');
    expect(navIndexPendingCopy(null).title).toContain('提供方未给出索引状态');
  });

  it('逐文件失败面（IDX-SILENT）：读数里有一行"未读入 N 个"与首批路径，且不靠差值推断', () => {
    const s = state('ready', {
      functions: 99,
      coverage: 'full',
      filesScanned: 2,
      filesFailed: 1,
      failures: [{ path: '/game/kojo/broken.ERB', reason: 'read' }],
    });
    const title = navScanReadout(s);
    expect(title).toContain('未读入：1 个文件');
    expect(title).toContain('/game/kojo/broken.ERB（读不到）');
    // 同一组读数在"全成功"那一轮也成立（filesScanned 与名录一字不差）⇒ 只有这一行分得开
    expect(navScanReadout({ ...s, filesFailed: 0, failures: undefined })).not.toContain('未读入');
  });

  it('失败面缺席（旧实现）或 0 个失败 ⇒ 读数逐字与改前一致（additive 纪律）', () => {
    const legacy = state('scanning');
    expect('filesFailed' in legacy).toBe(false);
    expect(navScanReadout(legacy)).not.toContain('未读入');
    expect(navScanReadout(state('scanning', { filesFailed: 0 }))).not.toContain('未读入');
    // 没有样本（只交了条数）时那句仍然成立——条数是事实，路径只是定位样本
    expect(navScanReadout(state('ready', { filesFailed: 3 }))).toContain('未读入：3 个文件');
  });

  it('失败态复用那一条既有失败文案（不另立第二套），原始原因仍逐字进悬停', () => {
    const failed = state('failed', { error: 'Error: EACCES denied', filesScanned: 40, functions: 0 });
    const copy = navIndexPendingCopy(failed);
    expect(copy.text).toBe(navLoadErrorCopy('anything').text);
    expect(copy.title).toContain('Error: EACCES denied');
    expect(copy.title).toContain('已扫文件 40'); // 进度读数不许被失败抹成 0
  });

  it('表里没有的阶段（提供方将来加态）退回等待句，绝不静默空白', () => {
    expect(navIndexPendingCopy(state('scanning' as ErbIndexPhase)).text).not.toBe('');
    const future = { ...SCANNING, phase: 'warming' as ErbIndexPhase };
    expect(navIndexPendingCopy(future).text).toBe('正在构建函数索引…（首次打开项目需要数秒）');
  });
});

describe('树已就绪但那一格该说"空"（0 根的那轮也产出空索引 ⇒ 面板会走到树模式）', () => {
  const FALLBACK = '从上方选择角色以浏览其口上函数树';

  it('empty / nothing-to-scan 两态各交回自己那句裁决', () => {
    expect(navTreeBodyCopy(EMPTY, FALLBACK)).toBe(navIndexPendingCopy(EMPTY).text);
    expect(navTreeBodyCopy(NOTHING, FALLBACK)).toBe(navIndexPendingCopy(NOTHING).text);
  });

  it('ready / scanning / 无事实 ⇒ 交回原句（既有行为零改动）', () => {
    expect(navTreeBodyCopy(state('ready', { functions: 99, coverage: 'full' }), FALLBACK)).toBe(FALLBACK);
    expect(navTreeBodyCopy(SCANNING, FALLBACK)).toBe(FALLBACK);
    expect(navTreeBodyCopy(null, FALLBACK)).toBe(FALLBACK);
  });
});

describe('状态行的降级标记（铁律 4：只扫了一类位置的树必须看得出来）', () => {
  it('partial 有标记、full 没有 ⇒ 降级与成功在状态行上**不同形**', () => {
    expect(navCoverageCopy(state('ready', { functions: 99, coverage: 'partial' })).mark).toContain('少扫了一类位置');
    expect(navCoverageCopy(state('ready', { functions: 99, coverage: 'full' })).mark).toBe('');
    expect(navCoverageCopy(state('ready', { functions: 99, coverage: 'none' })).mark).toContain('没扫到位置');
  });

  it('标记的悬停给出"少了哪一类"的原始读数（tag → 中文的翻译也不自己判形状）', () => {
    const c = navCoverageCopy(state('ready', { functions: 99 }));
    expect(c.title).toContain('至少一类位置本轮读不到');
    expect(c.title).toContain('悬停');
    expect(navCoverageCopy(null)).toEqual({ mark: '', title: '' });
  });

  it('navigatorScopeTitle：传了事实就带覆盖那两行，没传逐字保持旧输出（旧调用零改动）', () => {
    const tree = { scopeKey: '', filesScanned: 0, attribution: 'dir' } as never;
    const old = navigatorScopeTitle(tree);
    expect(old).toBe('范围：不限（全项目函数）\n角色归属：按角色目录（与检索范围同一条判据）');
    const withState = navigatorScopeTitle(tree, state('ready', { functions: 99 }));
    expect(withState.startsWith(old)).toBe(true);
    expect(withState).toContain('位置覆盖：至少一类位置本轮读不到');
    expect(withState).toContain('workspace 交出 0 个根');
  });

  it('ready 态的状态行悬停也带得上失败那一行（降级不许只在"没就绪"时看得见）', () => {
    const tree = { scopeKey: '', filesScanned: 0, attribution: 'dir' } as never;
    const title = navigatorScopeTitle(
      tree,
      state('ready', { functions: 9, coverage: 'full', filesFailed: 2, failures: [{ path: '/x.ERB', reason: 'parse' }] }),
    );
    expect(title).toContain('未读入：2 个文件');
    expect(title).toContain('/x.ERB（解析失败）');
  });
});

describe('面板那一侧只做查表与转述（源码形态）', () => {
  it('那一格走 navIndexPendingCopy，恒显占位的裸字面量已从面板消失', () => {
    const s = srcText();
    expect(s).toContain('navIndexPendingCopy(indexState)');
    expect(s).toContain('title: copy.title');
    expect(s, '等待句只许住 panel-copy（两处各写必然漂移）').not.toContain('正在构建函数索引…');
  });

  it('状态行拼上覆盖标记、悬停交状态给 navigatorScopeTitle；树模式正文走 navTreeBodyCopy', () => {
    const s = srcText();
    expect(s).toContain('navCoverageCopy(indexState)');
    expect(s).toContain('navigatorScopeTitle(treeNow, indexState)');
    expect(s).toContain('navTreeBodyCopy(indexState');
    expect(s).toContain('从上方选择角色以浏览其口上函数树');
  });

  it('原始读数只经 navScanReadout 转述，面板不自己拼数字', () => {
    const s = srcText();
    expect(s).toContain('navScanReadout(indexState)');
    expect(s).not.toContain('rootsWalked');
    expect(s).not.toContain('filesScanned');
  });
});
