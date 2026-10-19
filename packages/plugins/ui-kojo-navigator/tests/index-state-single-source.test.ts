/**
 * 单源守卫（IDX-STATE，2026-10-19）：**三态判据与降级判据只许住在提供方那一枚函数**，
 * 消费方只许"查表 + 转述"。
 *
 * 手法照 `packages/app/tests/kojo-extension-single-source.test.ts`：按行扫**源码形态**、
 * 连注释行一起查、处数钉死（多一处即红，少一处也红——豁免表本身就是账）。
 * 为什么不能只靠行为单测：形状判据在消费方再写一遍，行为可以碰巧对得上，
 * 而"碰巧"会在下一次改判据时分裂成两棵不同的树（本仓已为此付过三轮 DRIFT 批）。
 *
 * 反向对照同样钉住（第 ④ 组）：判据不是"哪里都不许有"，而是**只准住在提供方**。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string): string[] => readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
const textOf = (rel: string): string => read(rel).join('\n');
const hits = (rel: string, re: RegExp): string[] =>
  read(rel)
    .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
    .filter(({ line }) => re.test(line))
    .map(({ at, line }) => `${at} ${line.trim().slice(0, 100)}`);

/** 消费方三个文件：三态与降级的那一格住这里，一字判据都不该自己写 */
const COPY_FILE = 'packages/plugins/ui-kojo-navigator/src/panel-copy.ts';
const CONSUMERS = [
  COPY_FILE,
  'packages/plugins/ui-kojo-navigator/src/navigator-panel.ts',
  'packages/plugins/ui-kojo-navigator/src/navigator-store.ts',
];

/* ─────────── ① 消费方零形状判据（比较运算 = 自己重算了一遍提供方的事） ─────────── */

/** 对提供方字段做**比较**的四把尺子（转述数字不算，比较才判红） */
const SHAPE_TESTS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'rootsWalked 的比较', re: /rootsWalked\s*(?:===|!==|<=|>=|<|>)/ },
  { name: 'offered 的比较', re: /offered\s*(?:===|!==|<=|>=|<|>)/ },
  { name: 'filesScanned 的比较', re: /filesScanned\s*(?:===|!==|<=|>=|<|>)/ },
  { name: 'functions 的比较', re: /functions\s*(?:===|!==|<=|>=|<|>)/ },
  { name: 'sources 的条数判据', re: /\.sources\b[^\n]*\.length/ },
  { name: 'coverage 的比较（只许按 tag 查表）', re: /coverage\s*(?:===|!==)/ },
  { name: 'available 的比较（可用性归提供方）', re: /!s\.available|available\s*(?:===|!==)/ },
];

describe('① 消费方一字不判形状（三个文件、七把尺子，多一处即红）', () => {
  it.each(SHAPE_TESTS)('$name：三个消费方文件里 0 处', ({ re }) => {
    const offenders = CONSUMERS.flatMap((rel) => hits(rel, re));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('`.available` 只许出现在"转录原始读数"那一处（钉到行 + 处数，多一处少一处都红）', () => {
    const all = CONSUMERS.flatMap((rel) => hits(rel, /\.available\b/));
    expect(all).toHaveLength(1);
    expect(all[0]).toContain(COPY_FILE);
    expect(hits(COPY_FILE, /s\.available \? '' :/)).toHaveLength(1);
  });

  it('三态的两枚 phase 只许作为**表键**出现在 panel-copy，面板与状态源一个字都不写', () => {
    // 表键形态（行首缩进 + 键名 + 冒号）：panel-copy 各恰好 1 处，多一处就是第二张表
    expect(hits(COPY_FILE, /^\s+'nothing-to-scan':/)).toHaveLength(1);
    expect(hits(COPY_FILE, /^\s+empty:/)).toHaveLength(1);
    // 任何其它形态（比较 / 字面量判据）都不许在三个消费方文件里出现
    for (const rel of CONSUMERS) {
      expect(hits(rel, /phase\s*(?:===|!==)\s*'nothing-to-scan'/), `${rel} 不许比较 nothing-to-scan`).toEqual([]);
      expect(hits(rel, /phase\s*(?:===|!==)\s*'empty'/), `${rel} 不许比较 empty`).toEqual([]);
    }
    for (const rel of CONSUMERS.filter((r) => r !== COPY_FILE)) {
      expect(hits(rel, /'nothing-to-scan'|'empty'/), `${rel} 不许出现两枚 phase 的字面量`).toEqual([]);
    }
  });

  it('phase 的比较全仓消费方只有一处，而且是失败态（三态一律走表）', () => {
    const offenders = CONSUMERS.flatMap((rel) =>
      hits(rel, /phase\s*(?:===|!==)/).filter((h) => !/failed/.test(h)),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
    expect(CONSUMERS.flatMap((rel) => hits(rel, /phase\s*===/))).toHaveLength(1);
  });

  it('事实面的入口只有一处：store 转述 provider.indexState，面板只读 store（每帧一次 + 五处消费）', () => {
    expect(hits('packages/plugins/ui-kojo-navigator/src/navigator-store.ts', /parser\.indexState\?\.\(\)/)).toHaveLength(1);
    expect(hits('packages/plugins/ui-kojo-navigator/src/navigator-panel.ts', /parser\.indexState|\.indexState\?\.\(\)/)).toEqual([]);
    // 面板那一侧：解构 1 行 + 消费 5 行 = 6 行；多一行意味着有人在面板里**又去读了一次**外部源
    expect(hits('packages/plugins/ui-kojo-navigator/src/navigator-panel.ts', /\bindexState\b/)).toHaveLength(6);
    expect(hits('packages/plugins/ui-kojo-navigator/src/navigator-panel.ts', /indexState.*= store;/)).toHaveLength(1);
  });
});

/* ─────────── ② 恒显占位不许复活 ─────────── */

describe('② 那句"永远不变的占位"只许住在一处常量里', () => {
  it('等待句字面量：panel-copy 恰好 1 处、面板 0 处（改回硬编码即红）', () => {
    const BUILDING = '正在构建函数索引…（首次打开项目需要数秒）';
    expect(textOf(COPY_FILE).split(BUILDING).length - 1, '等待句在 panel-copy 的处数').toBe(1);
    expect(hits('packages/plugins/ui-kojo-navigator/src/navigator-panel.ts', /正在构建函数索引/)).toEqual([]);
  });

  it('面板那一格调的是三态文案函数，并把原始读数交给悬停', () => {
    const panel = textOf('packages/plugins/ui-kojo-navigator/src/navigator-panel.ts');
    expect(panel).toMatch(/const copy = navIndexPendingCopy\(indexState\);/);
    expect(panel).toMatch(/title: copy\.title/);
    expect(panel).toMatch(/navigatorScopeTitle\(treeNow, indexState\)/);
    expect(panel).toMatch(/navCoverageCopy\(indexState\)/);
    expect(panel).toMatch(/navigatorScopeSuffix\(treeNow\) \+\s*\n?\s*coverage\.mark/);
  });
});

/* ─────────── ③ 提供方一侧：判据不许长第二处 ─────────── */

describe('③ 提供方的形状判据只有一枚函数', () => {
  const PROVIDER = 'packages/plugins/erb-parser/src/index-state.ts';

  function providerSources(): string[] {
    const walk = (rel: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) out.push(...walk(child));
        else if (/\.ts$/.test(e.name)) out.push(child);
      }
      return out;
    };
    return walk('packages/plugins/erb-parser/src');
  }

  it('coverageOf / phaseOf 各只有一枚定义，且都住在 index-state.ts', () => {
    expect(hits(PROVIDER, /export function coverageOf\(/)).toHaveLength(1);
    expect(hits(PROVIDER, /export function phaseOf\(/)).toHaveLength(1);
    expect(hits(PROVIDER, /!s\.available/)).toHaveLength(1);
  });

  it('erb-parser 其余源码不重算可用性/覆盖形状（接线只交读数）', () => {
    const offenders = providerSources()
      .filter((rel) => !rel.endsWith('index-state.ts'))
      .flatMap((rel) => [
        ...hits(rel, /\.available\b/),
        ...hits(rel, /coverage\s*(?:===|!==)/),
        ...hits(rel, /'nothing-to-scan'|'empty'/),
      ]);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('plugin.ts 只经 indexStateOf 构造事实，不自己拼 ErbIndexState 字面量', () => {
    const plugin = textOf('packages/plugins/erb-parser/src/plugin.ts');
    expect(plugin).toMatch(/import \{[^}]*indexStateOf[^}]*\} from '\.\/index-state'/);
    expect(plugin).toMatch(/lastIndexState = indexStateOf\(\{/);
    expect(plugin).not.toMatch(/:\s*ErbIndexState\s*=\s*\{/);
  });
});

/* ─────────── ④ 反向对照：判据确实住在提供方 ─────────── */

describe('④ 反向对照：三态与降级的判据确实住在提供方那一枚函数', () => {
  it('index-state.ts 里三枚裁决全在（不是"哪里都不许有"）', () => {
    const s = textOf('packages/plugins/erb-parser/src/index-state.ts');
    expect(s).toMatch(/if \(!\(rootsWalked > 0\)\) return 'none';/);
    expect(s).toMatch(/sources\.some\(\(s\) => !s\.available\) \? 'partial' : 'full'/);
    expect(s).toMatch(/if \(coverage === 'none'\) return 'nothing-to-scan';/);
    expect(s).toMatch(/return functions > 0 \? 'ready' : 'empty';/);
  });

  it('契约把这枚 tag 的归属写死在类型面上（消费方拿到的是 tag，不是原始形状）', () => {
    const erb = textOf('packages/plugin-api/src/erb.ts');
    expect(erb).toMatch(/export type ErbIndexCoverage = 'full' \| 'partial' \| 'none';/);
    expect(erb).toMatch(/indexState\?\(\): ErbIndexState;/);
    expect(erb).toMatch(/export type ErbIndexPhase = 'idle' \| 'scanning' \| 'ready' \| 'nothing-to-scan' \| 'empty' \| 'failed';/);
  });
});
