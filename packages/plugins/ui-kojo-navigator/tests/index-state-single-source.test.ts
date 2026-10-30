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

/* ─────────── ⑤ 宿主三条通道（ST-CONSUMERS 2026-10-20）：同一张表，一字判据都不写 ─────────── */

/**
 * 覆盖面**收紧**的一寸（简报明令允许）：上一批只守函数树那条通道，本批把同一条事实接给
 * `Ctrl+T` / 改名台账 / 调用层级三条宿主通道 ⇒ 这三条也进扫描面。
 * 手法与 ① 逐字相同（按行扫源码形态、连注释一起查、处数钉死）。
 *
 * ST-TAIL（2026-10-20）把清单再扩两格：补全那条软腿的**装配侧** `editor-global-providers.ts`
 * 与面包屑那条的**宿主侧** `EditorPane.tsx`（F2 起主逻辑在 `editor-pane/use-breadcrumb.ts`，
 * 两处同扫）——这两格本批实测**没有作者可见的文案出口** ⇒
 * 不接（判据见第 ⑦ 组），但它们从此也在扫描面里：**任何一处形状比较、任何一次查表、
 * 任何第二张表都算红**（扩面只增不减，把文件从清单里划掉就是放宽）。
 */
describe('⑤ 宿主通道只查表（九文件 × 八把尺子，多一处即红）', () => {
  const APP_TABLE = 'packages/app/src/ui/index-state-copy.ts';
  const APP_CONSUMERS = [
    APP_TABLE,
    'packages/app/src/ui/workspace-symbols.ts',
    'packages/app/src/ui/name-ledger.ts',
    'packages/app/src/ui/CallHierarchyOverlay.tsx',
    'packages/app/src/ui/shell-overlays.ts',
    'packages/app/src/ui/ShellLayout.tsx',
    // ST-TAIL 扩面（补全的装配侧 + 面包屑的宿主侧；这两格只许搬运，不许自己判形状）
    'packages/app/src/ui/editor-global-providers.ts',
    'packages/app/src/ui/EditorPane.tsx',
    // F2 搬运（2026-10-20）：面包屑主逻辑从 EditorPane 抽进 hook，扫描面跟着搬、不缩回
    'packages/app/src/ui/editor-pane/use-breadcrumb.ts',
  ];

  it.each([...SHAPE_TESTS, { name: 'phase 的比较（三态一律走表）', re: /phase\s*(?:===|!==)/ }])(
    // 文件数由清单本身报出（写死"六"的那句已经与本批扩面漂了一次 ⇒ 从此不许再手抄这个数）
    `$name：宿主 ${APP_CONSUMERS.length} 枚文件里 0 处`,
    ({ re }) => {
      const offenders = APP_CONSUMERS.flatMap((rel) => hits(rel, re));
      expect(offenders, offenders.join('\n')).toEqual([]);
    },
  );

  it('原始读数与来源清单只许在表那一枚文件里被转录（别处出现 = 有人在重算）', () => {
    const offenders = APP_CONSUMERS.filter((rel) => rel !== APP_TABLE).flatMap((rel) =>
      hits(rel, /\b(?:rootsWalked|filesScanned|offered|coverage|available)\b/),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('两枚"空"态只许作为**表键**出现在宿主那一张表里（各 1 处，别处 0 处）', () => {
    expect(hits(APP_TABLE, /^\s+'nothing-to-scan':/)).toHaveLength(1);
    expect(hits(APP_TABLE, /^\s+empty:/)).toHaveLength(1);
    for (const rel of APP_CONSUMERS.filter((r) => r !== APP_TABLE)) {
      expect(hits(rel, /'nothing-to-scan'|'empty'/), `${rel} 不许出现 phase 字面量`).toEqual([]);
    }
  });

  it('宿主只有一张表（第二张 phase→文案表 = 第二份真相）', () => {
    // 表那一枚文件的列名（`ws` / `ledger` / `blocked`）在别的宿主文件里出现 = 有人又起了一张表
    const owners = APP_CONSUMERS.filter((rel) => hits(rel, /readonly (?:ws|ledger|blocked):/).length > 0);
    expect(owners).toEqual([APP_TABLE]);
    expect(hits(APP_TABLE, /^\s+idle:/)).toHaveLength(1);
    expect(hits(APP_TABLE, /^\s+scanning:/)).toHaveLength(1);
    expect(hits(APP_TABLE, /^\s+failed:/)).toHaveLength(1);
    expect(hits(APP_TABLE, /^\s+ready:/)).toHaveLength(1);
  });

  it('事实面的入口按处数钉死：四个接线点各读一次 provider.indexState()，文案层一次都不读', () => {
    for (const rel of ['packages/app/src/ui/ShellLayout.tsx', 'packages/app/src/ui/shell-overlays.ts', 'packages/app/src/ui/name-ledger.ts', 'packages/app/src/ui/CallHierarchyOverlay.tsx']) {
      expect(hits(rel, /indexState\?\.\(\)/), rel).toHaveLength(1);
    }
    expect(hits(APP_TABLE, /indexState\?\.\(\)/)).toEqual([]);
    expect(hits('packages/app/src/ui/workspace-symbols.ts', /indexState\?\.\(\)/)).toEqual([]);
  });

  it('三条通道都真的调那张表（改回各自判形状 ⇒ 这几行消失就红）', () => {
    expect(textOf('packages/app/src/ui/workspace-symbols.ts')).toMatch(/workspaceSymbolIndexCopy\(a\.indexState \?\? null\)/);
    expect(textOf('packages/app/src/ui/name-ledger.ts')).toMatch(/nameLedgerIndexCopy\(indexState\)/);
    expect(textOf('packages/app/src/ui/CallHierarchyOverlay.tsx')).toMatch(/callHierarchyIndexCopy\(indexState\)/);
    expect(textOf('packages/app/src/ui/CallHierarchyOverlay.tsx')).toMatch(/callHierarchyIndexTitle\(indexState\)/);
  });

  it('恒显占位那句「当前项目还没有可用的函数索引」不许再当唯一答案（表没接上就复活）', () => {
    const ws = textOf('packages/app/src/ui/workspace-symbols.ts');
    expect(ws.split('当前项目还没有可用的函数索引').length - 1).toBe(1);
    expect(ws).toMatch(/const why = workspaceSymbolIndexCopy\(a\.indexState \?\? null\);\n\s*if \(why !== null\) return why;/);
  });

  it('反向对照：宿主那张表确实给三态各写了一句不同的话，而且这些话只住在那一枚文件里', () => {
    for (const phrase of [/没有可扫描的位置/, /确实一条都没有/, /这一轮构建失败/]) {
      expect(hits(APP_TABLE, phrase).length, `表里要有 ${String(phrase)} 那一句`).toBeGreaterThanOrEqual(1);
      const elsewhere = APP_CONSUMERS.filter((rel) => rel !== APP_TABLE).flatMap((rel) => hits(rel, phrase));
      expect(elsewhere, elsewhere.join('\n')).toEqual([]);
    }
  });
});

/* ─────────── ⑥ 悬停通道：实测**没有**"为什么没有"这一格（记档，不新开显示面） ─────────── */

describe('⑥ 悬停那条通道没地方说（判据钉住"不许为它新开显示面"）', () => {
  const HOVER = 'packages/app/src/monaco/kojo-hover.ts';
  /** ERB 悬停判据（LAU-4 悬停腿，2026-10-31）已搬进常驻插件：那条腿的"缺席 ⇒ 不产结果"在它里面 */
  const ERB_HOVER = 'packages/plugins/erb-parser/src/completion.ts';

  it('索引缺席时悬停**只许不产结果**（`return undefined`），不许 pop 一句解释（那是新显示面）', () => {
    // 两处取索引的腿各有一枚"缺席 ⇒ 不产结果"，多一处说明有人在这里加了文案
    expect(hits(ERB_HOVER, /if \(index === null\) return undefined;/)).toHaveLength(2);
    expect(hits(ERB_HOVER, /return undefined/).length).toBeGreaterThan(2);
    // 宿主那台安装器里不许再有这类判据（判据全在插件）
    expect(hits(HOVER, /if \(index === null\) return undefined;/)).toEqual([]);
  });

  it('悬停这一格不查宿主那张表（它没有可查的文案面；接上 = 新开面 ⇒ 红）', () => {
    expect(hits(HOVER, /index-state-copy|indexState/)).toEqual([]);
  });
});

/* ─────────── ⑦ 补全 / 面包屑两格：实测**没有**作者可见的文案出口（ST-TAIL 2026-10-20，记档） ─────────── */

/**
 * 手法照第 ⑥ 组：这一组**不接任何东西**，它把"为什么这两格不该出声"钉成可复跑的判据，
 * 于是"交回"不是一个口头结论，而是一改动就红的闸。实测出处（本批写死在下面各行里）：
 *
 * - **补全**：索引派生那条腿 `erbFunctionNames`（装配点 `editor-global-providers.ts:239`，
 *   提供者 `:257` 返回类型是 `() => readonly string[]`——**没有 `undefined` 这一支**），
 *   而装配核报降级的唯一入口 `missingRequirement`（`completion-core.ts:405`）只认
 *   `undefined` / `null` ⇒ 索引未建时**一条降级都不产生**；`erb-completion.ts:468`
 *   更是直接 `if (!index) return []`。这条 seam 的"为什么没有候选"唯一的既有出口是
 *   `CompletionDegrade`（`onDegrade` 回调 + 一行 `console.warn`），而宿主两枚补全安装点
 *   （`editor-global-providers.ts:1153 / :1155`）**都不接**它——本仓已写明接它的代价
 *   （`erb-completion.ts:394`「挂上会让每轮补全都报一次降级信号」），且 `console.warn`
 *   在桌面壳里看不见（`editor-global-providers.ts:443` 那条折痕取证）。⇒ 没有作者读得到的
 *   那一格 ⇒ 交回，且**不许为它新造一格**。
 * - **面包屑**：`editor-pane/use-breadcrumb.ts` 的 `currentErbIndex()`（本批归一：它就是那一枚
 *   `erbParserIndex()`）只服务**快路**（②）与缓存戳；索引缺席
 *   时走④**现解析**那条腿（同文件 `collectDocumentSymbols`），而供方的 documentSymbol 判的是
 *   `request.text` 现文本（`erb-parser/src/plugin.ts:1004`）⇒ **"链空了"与索引无关**，
 *   把 phase 文案接在这里等于把"没面包屑"污蔑成"索引的锅"。空链那一格今天整条不渲染
 *   （`breadcrumb-bar.tsx:52`），渲染点也没有空态元素（`EditorPane.tsx:2554`）。⇒ 交回。
 */
describe('⑦ 补全与面包屑没地方说（实测记档；为它们新开一格 ⇒ 红）', () => {
  const PROVIDERS = 'packages/app/src/ui/editor-global-providers.ts';
  const PANE = 'packages/app/src/ui/EditorPane.tsx';
  const BREADCRUMB_HOOK = 'packages/app/src/ui/editor-pane/use-breadcrumb.ts';
  const CRUMB = 'packages/app/src/ui/breadcrumb-bar.tsx';
  const CORE = 'packages/app/src/monaco/completion-core.ts';
  const ERB_COMPLETION = 'packages/app/src/monaco/erb-completion.ts';
  const PARSER_PLUGIN = 'packages/plugins/erb-parser/src/plugin.ts';
  const TABLE = 'packages/app/src/ui/index-state-copy.ts';
  const GUARD_SELF = 'packages/plugins/ui-kojo-navigator/tests/index-state-single-source.test.ts';

  function appSources(): string[] {
    const walk = (rel: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) out.push(...walk(child));
        else if (/\.(?:ts|tsx)$/.test(e.name)) out.push(child);
      }
      return out;
    };
    return walk('packages/app/src');
  }

  it('查那张表的文件是一张**闭集**（三枚通道各一处 import；补全 / 面包屑挤进来就红）', () => {
    const importers = appSources().filter((rel) => hits(rel, /from '\.\/index-state-copy'/).length > 0);
    expect(importers.sort()).toEqual(
      [
        'packages/app/src/ui/CallHierarchyOverlay.tsx',
        'packages/app/src/ui/name-ledger.ts',
        'packages/app/src/ui/workspace-symbols.ts',
      ].sort(),
    );
    // 一枚文件一处 import；两处 = 有人在同一个文件里又起了一路查表
    for (const rel of importers) expect(hits(rel, /from '\.\/index-state-copy'/), rel).toHaveLength(1);
    expect(hits(TABLE, /from '\.\/index-state-copy'/), '表自己不许引自己').toEqual([]);
  });

  it('两格里没有任何查表 / 事实面入口的痕迹（没有文案面却接表 = 造一句没人读的话）', () => {
    for (const rel of [PROVIDERS, PANE, CRUMB, BREADCRUMB_HOOK]) {
      expect(hits(rel, /indexState|index-state-copy|INDEX_PHASE_COPY/), rel).toEqual([]);
    }
  });

  it('补全只留 kojo1 一枚旧桥安装点；`onDegrade…:` 只出现在两条格式化腿上（补全 / 面包屑不许加）', () => {
    // LAU-4 补全腿第三批（2026-10-31）：ERB 补全改走槽供方，宿主不再有它自己的安装点。
    expect(hits(PROVIDERS, /installKojoCompletion\(monaco, \(\) => editorTables\(requireKernel\(\)\)\)/)).toHaveLength(1);
    expect(hits(PROVIDERS, /installErbCompletion/)).toEqual([]);
    const wired = hits(PROVIDERS, /onDegrade\w*:/);
    // 批次十三：`.kojo` 区间格式化从装配点的无参注册搬到宿主带闸版 ⇒ 格式化腿由一条变两条
    // （整篇那条不在此正则里）。判据不变：两处都必须落在格式化腿上，补全 / 面包屑一处都不许有。
    expect(wired, wired.join('\n')).toHaveLength(2);
    expect(hits(PROVIDERS, /installKojoRangeFormatter\(monaco, \{ \.\.\.formatResolve, onDegraded: reportFormat/)).toHaveLength(1);
    expect(hits(PROVIDERS, /installRangeFormatter\(monaco, \{ \.\.\.formatResolve, onDegraded: reportFormat/)).toHaveLength(1);
  });

  it('索引未建时补全**连一条降级都不产生**（提供者永不缺席 + 装配核只认 undefined/null ⇒ 这一格确实无话可改）', () => {
    expect(hits(PROVIDERS, /function erbFunctionNamesFor\(kernel: Kernel\): \(\) => readonly string\[\] \{/)).toHaveLength(1);
    // 取索引那条腿随补全判据搬进 `erb-completion-facts.ts`（LAU-4 补全腿第三批）
    expect(hits('packages/app/src/monaco/erb-completion-facts.ts', /if \(!index\) return \[\];/)).toHaveLength(1);
    expect(hits(CORE, /return value === undefined \|\| value === null \? key : undefined;/)).toHaveLength(1);
  });

  it('「每轮都报一次降级」这条代价仓库里已经写死拒绝过 ⇒ 补全那格的沉默是**决定**不是漏做', () => {
    expect(hits(ERB_COMPLETION, /不挂 `requires`/)).toHaveLength(1);
    expect(hits(ERB_COMPLETION, /挂上会让每轮补全都报一次降级信号/)).toHaveLength(1);
  });

  it('面包屑：无索引 ≠ 无链——现解析那条腿还在，所以"链空了"不许由索引来解释', () => {
    expect(hits(BREADCRUMB_HOOK, /const symbols = collectDocumentSymbols\(kernel\.slots\.query\('ui\.editor\.languageService'\), \{/)).toHaveLength(1);
    expect(hits(PARSER_PLUGIN, /erbDocumentSymbols\(parseErbText\(request\.text, request\.path\)\)/)).toHaveLength(1);
  });

  it('面包屑空链那一格仍是**整条不渲染**（在这儿写一句"为什么没有"= 新开显示面 ⇒ 红）', () => {
    expect(hits(CRUMB, /if \(levels\.length === 0\) return null;/)).toHaveLength(1);
    expect(hits(CRUMB, /索引|indexState|currentIndex/)).toEqual([]);
    expect(hits(PANE, /<CrumbBar/)).toHaveLength(1);
  });

  it('反向对照：表对象在宿主源码里只有**一枚读者**（别处再引一次 = 第二份查表真相）', () => {
    const elsewhere = appSources()
      .filter((rel) => rel !== TABLE)
      .flatMap((rel) => hits(rel, /INDEX_PHASE_COPY/));
    expect(elsewhere, elsewhere.join('\n')).toEqual([]);
    expect(hits(TABLE, /INDEX_PHASE_COPY/)).toHaveLength(2); // 定义 1 + 查表 1
  });

  it('这两格里"问索引"只有一枚软取（本批归一的手抄：`currentIndex()` 在这两文件合计 1 处，就在 `erbParserIndex` 体内；再抄一遍 try/tryGet ⇒ 红）', () => {
    const takes = [PROVIDERS, BREADCRUMB_HOOK].flatMap((rel) => hits(rel, /\.currentIndex\(\)/));
    expect(takes, takes.join('\n')).toHaveLength(1);
    expect(hits(PROVIDERS, /export function erbParserIndex\(kernel: Kernel\): ErbIndex \| null \{/)).toHaveLength(1);
    expect(hits(PROVIDERS, /erbIndex: \(\) => erbParserIndex\(kernel\),/)).toHaveLength(1);
    expect(hits(BREADCRUMB_HOOK, /const currentErbIndex = useCallback\(\(\): ErbIndex \| null => erbParserIndex\(kernel\), \[kernel\]\);/)).toHaveLength(1);
  });

  it('那张表的**列是闭集**（既有三通道那一列宽；给补全 / 面包屑添一列 = 先把不存在的那一格写进表）', () => {
    const cols = [
      ...new Set(
        hits(TABLE, /readonly [a-zA-Z]+:/)
          .flatMap((h) => [...h.matchAll(/readonly ([a-zA-Z]+):/g)])
          .map((m) => m[1] as string),
      ),
    ];
    expect(cols.sort()).toEqual(['blocked', 'ledger', 'withError', 'ws']);
  });

  it('扫描面**只增不减**（把本批这两格从 ⑤ 的清单里划掉 ⇒ 这条红；标题那句文件数也得对得上）', () => {
    const guard = textOf(GUARD_SELF);
    const from = guard.indexOf('const APP_CONSUMERS = [');
    const region = guard.slice(from, guard.indexOf('  ];', from));
    for (const rel of [PROVIDERS, PANE, BREADCRUMB_HOOK]) expect(region, `${rel} 必须留在 ⑤ 的扫描面清单里`).toContain(`'${rel}'`);
    expect(region).toContain('APP_TABLE,'); // 表本身也在扫描面上（由 ⑤ 内那枚常量引入）
    expect(guard).toContain("const APP_TABLE = 'packages/app/src/ui/index-state-copy.ts';");
    // 清单里的字面量条目 8 条（第 9 枚是 `APP_TABLE` 那枚常量）⇒ 与 ⑤ 标题那句文件数逐字对得上
    expect(region.match(/^\s+'packages\/app\/src/gm)).toHaveLength(8);
    // 标题那一行自己（拿整份文件 toMatch 会被本断言的字面量骗过去）
    const titleLine = read(GUARD_SELF).find((l) => /^describe\('⑤ /.test(l)) ?? '';
    expect(titleLine).toContain('（九文件 × 八把尺子，多一处即红）');
  });
});
