import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameAdapter } from '@kojo/plugin-api';
import { activeGameAdapter } from '@kojo/plugin-api';

/**
 * `GameAdapter` 契约的**两道结构闸**（2026-10-22 契约瘦身批）。
 *
 * 背景：契约上曾有两枚只有实现、没有消费方的可选成员——`stateModel`（活了五个批次，
 * 三个 adapter 都没实现、全仓零消费方）与 `scaffold`（三个 adapter 都实现了，全仓零
 * 调用方，且与「工作区为权威」的落点口径冲突）。它们的代价不是那几行代码，而是
 * **每个新 adapter 都要为它们写一份没人读的白工**，并且让「这个能力其实没人做」
 * 这个事实被掩盖——契约看起来什么都支持。
 *
 * 所以本文件把两条判据做成闸：
 *
 * ① **要么有消费方，要么别加。** 接口体里每个可选成员，必须在 adapter 插件之外
 *    （`plugin-api` 自身与 `*-adapter` 都不算）至少有一处 `.成员名` 的读取。
 * ② **「谁是当前那枚」只有一处实现。** `contribution.adapter.gameId === project.adapterId`
 *    这条判据原先被 14 个消费方各手写一遍，现在只剩契约的 `activeGameAdapter`；
 *    任何一处再手写即红（判据分叉的症状是「A 面板认得出这个游戏、B 面板认不出」，
 *    而且没有任何别的东西拦得住）。
 *
 * 手法照 `packages/app/tests/kojo-extension-single-source.test.ts`：查**源码形态**，
 * 不查行为（行为面由下面的 `activeGameAdapter` 那组用例钉）。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CONTRACT_FILE = 'packages/plugin-api/src/game.ts';

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/* ───────────────────────── ① 契约成员必须有消费方 ───────────────────────── */

/** `GameAdapter` 接口体（从 `export interface GameAdapter {` 到行首 `}`） */
function adapterInterfaceBody(): string {
  const text = read(CONTRACT_FILE);
  const start = text.indexOf('export interface GameAdapter {');
  expect(start, '`GameAdapter` 接口还在').toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n}', start);
  expect(end, '`GameAdapter` 接口有闭合').toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * 接口体里的**可选成员**名（本契约的可选成员一律写成 `readonly x?:`）。
 * 必填的 `gameId` / `displayName` 与两个方法不在本闸范围内——内核直接调它们
 * （`kernel/src/project.ts` 的 detect 轮询 + loadProject），那是内核的契约面。
 */
function optionalMembers(): string[] {
  return [...adapterInterfaceBody().matchAll(/^ {2}readonly (\w+)\?:/gm)].map((m) => m[1]!);
}

/** 实现方（adapter 插件）：有实现不算有消费方 */
const ADAPTER_IMPL_DIR = /^packages\/plugins\/[^/]*-adapter\//;

/**
 * 消费方候选：各包与各插件的 `src`（测试不算消费方）。
 *
 * **全仓只走一遍**：本文件有十几个用例要按成员名扫同一批文件，逐个用例重读整棵树
 * 会让这条闸从"顺手一跑"变成"三十秒起步"（实测：不缓存 32 s，缓存后 <1 s）。
 * 判据是只读的，缓存不会让闸变钝——它只是在同一次运行里别重复做同一件事。
 */
let cachedSources: Map<string, string> | null = null;

function consumerSources(): Map<string, string> {
  if (cachedSources !== null) return cachedSources;
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name)) files.push(child);
    }
  };
  for (const group of ['packages', 'packages/plugins']) {
    for (const entry of readdirSync(path.join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = `${group}/${entry.name}/src`;
      try {
        walk(src);
      } catch {
        // 没有 src 的包（纯文档 / 纯资源）跳过
      }
    }
  }
  const sources = new Map<string, string>();
  for (const rel of files) {
    if (
      // 契约层自身：成员在这里**声明**，不算消费
      rel.startsWith('packages/plugin-api/') ||
      // 实现方：有实现不算有消费方（本闸要的正是"别人在用它"）
      ADAPTER_IMPL_DIR.test(rel)
    ) {
      continue;
    }
    sources.set(rel, read(rel));
  }
  cachedSources = sources;
  return sources;
}

describe('① 契约上的每个可选成员都有消费方（要么有消费方，要么别加）', () => {
  it('接口体解析得到全部可选成员（成员增删时这条先红，提醒更新本闸的预期）', () => {
    expect(optionalMembers().sort()).toEqual(
      [
        'conventions',
        'functionFamilyIndex',
        'kojoCallProtocol',
        'kojoCounterTable',
        'kojoFaceTemplates',
        'kojoInstructionTable',
        'kojoLibraryTable',
        'kojoMutatorTable',
        'nameGlossary',
        'stateLinePresets',
        'variableSchema',
      ].sort(),
    );
  });

  it.each(optionalMembers())('`%s` 在 adapter 之外至少有一处读取', (member) => {
    const re = new RegExp(`\\.${member}\\b`);
    const hits = [...consumerSources()].filter(([, text]) => re.test(text)).map(([rel]) => rel);
    expect(hits, `成员 \`${member}\` 零消费方 ⇒ 从契约里删掉，别让每个 adapter 都写一份白工`).not.toEqual([]);
  });

  it('已删的两枚死槽位不许复活（`stateModel` / `GameAdapter.scaffold`）', () => {
    const body = adapterInterfaceBody();
    expect(body).not.toMatch(/readonly stateModel\?/);
    expect(body).not.toMatch(/^\s*scaffold\?\(/m);
    // 删干净了：连注释里的旧名都不该再当"现存成员"提
    expect(read(CONTRACT_FILE)).not.toMatch(/StateModel\b/);
  });
});

/* ───────────────────── ② 「谁是当前那枚」只有一处实现 ───────────────────── */

/**
 * 手写的 active-adapter 判据形态：`x.adapter.gameId ===/!== ...`。
 * 契约的 `activeGameAdapter` 内部是唯一合法的一处；其余一律经它。
 */
const HAND_ROLLED_LOOKUP = /\.adapter\.gameId\s*[!=]==/;

/** 合法持有该判据的文件（只有契约自己） */
const LOOKUP_HOME = 'packages/plugin-api/src/game.ts';

describe('② 全仓只有契约一处手写 active-adapter 判据', () => {
  it('`activeGameAdapter` 的判据确实住在契约里（反向对照：不是"哪儿都不许有"）', () => {
    const text = read(LOOKUP_HOME);
    expect(text).toMatch(/export function activeGameAdapter</);
    expect(text).toMatch(HAND_ROLLED_LOOKUP);
  });

  it('消费方源码里手写的 `adapter.gameId ===` 处数 = 0', () => {
    const offenders = [...consumerSources()]
      .filter(([, text]) => HAND_ROLLED_LOOKUP.test(text))
      .map(([rel]) => rel)
      .sort();
    expect(
      offenders,
      '这条判据只准住在 `activeGameAdapter`：手写第二份就会与别处悄悄分叉',
    ).toEqual([]);
  });

  it('消费方都从契约取那一枚（不再各自 `find` / `for` 一遍槽位）', () => {
    // 本批收口的代表性消费方：任一退回去自己找，这条就红
    const consumers = [
      'packages/plugins/condition-extractor/src/index.ts',
      'packages/plugins/convention-linter/src/index.ts',
      'packages/plugins/kojo-sugar/src/index.ts',
      'packages/plugins/state-replay/src/index.ts',
      'packages/plugins/ui-condition-matrix/src/adapter-services.ts',
      'packages/plugins/ui-convention-report/src/index.ts',
      'packages/plugins/ui-kojo-navigator/src/index.ts',
      'packages/plugins/ui-snapshot-injector/src/injector-panel.ts',
      'packages/plugins/ui-state-replay/src/activation.ts',
      'packages/plugins/ui-sugar-editor/src/new-file-wizard.ts',
      'packages/app/src/ui/dictionary-notice-ledger.ts',
      'packages/app/src/ui/editor-global-providers.ts',
      'packages/app/src/ui/ProjectView.tsx',
    ];
    for (const rel of consumers) {
      expect(read(rel), `${rel} 应经契约的 activeGameAdapter 取当前适配器`).toMatch(
        /\bactiveGameAdapter\b/,
      );
    }
  });
});

/* ───────────────────────── ③ 行为面：判据本身对 ───────────────────────── */

const adapterOf = (gameId: string): GameAdapter =>
  ({ gameId, displayName: gameId, detect: async () => false, loadProject: async () => ({}) }) as unknown as GameAdapter;

describe('③ `activeGameAdapter` 的判据形态', () => {
  const a = adapterOf('game-a');
  const b = adapterOf('game-b');
  const contributions = [
    { id: 'a', pluginId: 'pa', adapter: a },
    { id: 'b', pluginId: 'pb', adapter: b },
  ];

  it('按 gameId 精确匹配，返回整枚 adapter（不是贡献对象）', () => {
    expect(activeGameAdapter(contributions, 'game-b')).toBe(b);
    expect(activeGameAdapter(contributions, 'game-a')).toBe(a);
  });

  it('没开项目（null / undefined / 空串）⇒ undefined，不猜"第一枚"', () => {
    expect(activeGameAdapter(contributions, null)).toBeUndefined();
    expect(activeGameAdapter(contributions, undefined)).toBeUndefined();
    expect(activeGameAdapter(contributions, '')).toBeUndefined();
  });

  it('槽位里没有同 id 的贡献 ⇒ undefined（不跨适配器借表）', () => {
    expect(activeGameAdapter(contributions, 'game-c')).toBeUndefined();
    expect(activeGameAdapter([], 'game-a')).toBeUndefined();
  });

  it('多枚同 gameId 时取第一枚（与 `query` 的 `order` 排序一致，不另立优先级）', () => {
    const first = adapterOf('game-a');
    const second = adapterOf('game-a');
    expect(
      activeGameAdapter(
        [
          { id: '1', pluginId: 'p1', adapter: first },
          { id: '2', pluginId: 'p2', adapter: second },
        ],
        'game-a',
      ),
    ).toBe(first);
  });
});
