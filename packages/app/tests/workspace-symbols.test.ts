import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorWorkspaceSymbol,
  EditorWorkspaceSymbolResult,
  ErbIndexState,
} from '@kojo/plugin-api';
import { WorkspaceSymbols } from '../src/ui/Palette';
import {
  collectWorkspaceSymbols,
  pickWorkspaceSymbols,
  symbolPickerItems,
  workspaceSymbolNotice,
  workspaceSymbolOverflowText,
  WORKSPACE_SYMBOL_RENDER_LIMIT,
} from '../src/ui/workspace-symbols';

/**
 * D2 · 工作区符号的**宿主侧纯逻辑**单测（口径照 `commands.test.ts` 的
 * `filterFileCandidates`：查询与排序是数据判据，脱离渲染钉死）。
 *
 * 覆盖任务书点名的判据：大小写不敏感 / 名字命中优先于路径命中 / 中文名与原生大写名
 * 都搜得到 / 上限 + 溢出提示 / 同名多定义并列 / 无项目·无索引的**可见原因** /
 * 单个应答方抛错不吞掉整条能力。
 */

function contribution(
  id: string,
  result: EditorWorkspaceSymbolResult | undefined,
  opts: { throws?: boolean } = {},
): EditorLanguageServiceContribution {
  return {
    id,
    provide: (request: EditorLanguageServiceRequest) => {
      if (request.kind !== 'workspaceSymbol') return undefined;
      if (opts.throws) throw new Error(`${id} 坏了`);
      return result;
    },
  } as unknown as EditorLanguageServiceContribution;
}

function symbol(name: string, filePath: string, line = 1): EditorWorkspaceSymbol {
  return { kind: 'function', name, filePath, line };
}

const F1 = 'C:\\game\\個人口上\\chara10\\MESSAGE.ERB';
const F2 = 'C:\\game\\個人口上\\chara20\\MESSAGE.ERB';

describe('collectWorkspaceSymbols · 问齐与合并', () => {
  it('空查询不发问（十万条名字不该被整份造出来）', () => {
    const spy = vi.fn();
    const c = { id: 'x', provide: spy } as unknown as EditorLanguageServiceContribution;
    expect(collectWorkspaceSymbols([c], { query: '  ', project: null })).toEqual({
      symbols: [],
      totalMatched: 0,
      scope: null,
      droppedOutOfScope: 0,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('多家合并 + 去重（同一处定义被两个应答方给出只留一条），总数相加', () => {
    const a = contribution('a', {
      kind: 'workspaceSymbol',
      symbols: [symbol('ALPHA', F1, 3), symbol('BETA', F1, 9)],
      totalMatched: 12,
    });
    const b = contribution('b', {
      kind: 'workspaceSymbol',
      symbols: [symbol('ALPHA', F1, 3), symbol('GAMMA', F2, 1)],
      totalMatched: 2,
    });
    const got = collectWorkspaceSymbols([a, b], { query: 'alpha', project: null });
    expect(got.symbols.map((s) => s.name)).toEqual(['ALPHA', 'BETA', 'GAMMA']);
    expect(got.totalMatched).toBe(14);
  });

  it('`undefined` = 不答（跳过）；抛错 = 隔离，其余照常出结果', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const got = collectWorkspaceSymbols(
      [
        contribution('silent', undefined),
        contribution('broken', undefined, { throws: true }),
        contribution('ok', { kind: 'workspaceSymbol', symbols: [symbol('训练度检查', F2, 4)] }),
      ],
      { query: '训练', project: null },
    );
    expect(got.symbols.map((s) => s.name)).toEqual(['训练度检查']);
    expect(got.totalMatched).toBe(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('broken'))).toBe(true);
    warn.mockRestore();
  });

  it('请求体带 kind/query/project/limit（应答方拿到的就是这些，宿主不多给文件文本）', () => {
    const seen: unknown[] = [];
    const c = {
      id: 'probe',
      provide: (request: { kind: string }) => {
        seen.push(request);
        return undefined;
      },
    } as unknown as EditorLanguageServiceContribution;
    collectWorkspaceSymbols([c], { query: 'A', project: null, limit: 7 });
    expect(seen[0]).toEqual({ kind: 'workspaceSymbol', query: 'A', project: null, limit: 7 });
  });
});

describe('collectWorkspaceSymbols · 糖线合并（同一个函数绝不出两行）', () => {
  const DIR = 'C:\\game\\個人口上\\chara10';
  const KOJO = `${DIR}\\M.kojo`;
  const ERB = `${DIR}\\M.ERB`;
  const NAME = 'M_KOJO_MESSAGE_COM_K10_挨拶';
  const erbSays = (symbols: EditorWorkspaceSymbol[], totalMatched = symbols.length) =>
    contribution('erb', { kind: 'workspaceSymbol', symbols, totalMatched });
  const sugarSays = (symbols: EditorWorkspaceSymbol[], totalMatched = symbols.length) =>
    contribution('sugar', { kind: 'workspaceSymbol', symbols, totalMatched });

  it('同一函数：ERB 报产物（.ERB）、糖线报源（.kojo）⇒ 只剩源那一条，先后顺序无关', () => {
    const erb = erbSays([symbol(NAME, ERB, 12)]);
    const sugar = sugarSays([symbol(NAME, KOJO, 9)]);
    for (const order of [
      [erb, sugar],
      [sugar, erb],
    ]) {
      const got = collectWorkspaceSymbols(order, { query: NAME, project: null });
      // 只剩一条，且是**作者能改**的那份源（行号也是源行，不是产物行）
      expect(got.symbols).toEqual([symbol(NAME, KOJO, 9)]);
    }
  });

  it('并掉的那条从 totalMatched 扣回：3 家报数 − 1 条并掉 ⇒ 可见 2 条、hidden 0', () => {
    const erb = erbSays([symbol(NAME, ERB, 12), symbol('M_KOJO_MESSAGE_COM_K10_別', ERB, 40)], 2);
    const sugar = sugarSays([symbol(NAME, KOJO, 9)], 1);
    const got = collectWorkspaceSymbols([erb, sugar], { query: 'M_KOJO', project: null });
    expect(got.symbols.map((s) => s.filePath)).toEqual([KOJO, ERB]);
    expect(got.totalMatched).toBe(2); // 2 + 1 − 1（被并掉的那条不再入账）
    const picked = pickWorkspaceSymbols(got, 'M_KOJO');
    expect(picked.items).toHaveLength(2);
    expect(picked.hidden).toBe(0); // 不许报"另有 1 条"——那条根本列不出来（假读数）
  });

  it('同名不同归属 ⇒ 不误并（本批只有这一份产物才算同一个符号）', () => {
    const other = 'C:\\game\\個人口上\\chara20\\M.ERB';
    const got = collectWorkspaceSymbols(
      [
        erbSays([symbol(NAME, ERB, 12), symbol(NAME, other, 4)], 2),
        sugarSays([symbol(NAME, KOJO, 9)], 1),
      ],
      { query: NAME, project: null },
    );
    // chara20 那份没有被任何源指向 ⇒ 照旧自成一行
    expect(got.symbols.map((s) => s.filePath)).toEqual([KOJO, other]);
    expect(got.totalMatched).toBe(2); // 3 − 1
  });

  it('不同目录的两个同名函数（各自都有源）⇒ 两行，各自扣各自的那条', () => {
    const kojo2 = 'C:\\game\\個人口上\\chara20\\M.kojo';
    const erb2 = 'C:\\game\\個人口上\\chara20\\M.ERB';
    const got = collectWorkspaceSymbols(
      [
        erbSays([symbol(NAME, ERB, 12), symbol(NAME, erb2, 40)], 2),
        sugarSays([symbol(NAME, KOJO, 9), symbol(NAME, kojo2, 5)], 2),
      ],
      { query: NAME, project: null },
    );
    expect(got.symbols.map((s) => s.filePath)).toEqual([KOJO, kojo2]);
    expect(got.totalMatched).toBe(2); // 4 − 2
  });

  it('推不出目标的路径（`M.kojo.bak`）退化旧键：不崩、也不与同名产物误并', () => {
    const bak = `${DIR}\\M.kojo.bak`;
    const got = collectWorkspaceSymbols(
      [
        erbSays([symbol(NAME, ERB, 1)], 1),
        contribution('bak', { kind: 'workspaceSymbol', symbols: [symbol(NAME, bak, 1)], totalMatched: 1 }),
      ],
      { query: NAME, project: null },
    );
    expect(got.symbols.map((s) => s.filePath)).toEqual([ERB, bak]);
    expect(got.totalMatched).toBe(2);
  });

  it('糖线缺席（整批没有 .kojo 源）⇒ 键仍是旧口径：输出与改前逐字相同', () => {
    const a = contribution('a', {
      kind: 'workspaceSymbol',
      symbols: [symbol('ALPHA', F1, 1), symbol('ALPHA', F1, 9)],
      totalMatched: 2,
    });
    const b = contribution('b', { kind: 'workspaceSymbol', symbols: [symbol('ALPHA', F1, 1)], totalMatched: 1 });
    const got = collectWorkspaceSymbols([a, b], { query: 'alpha', project: null });
    // 同文件同名的两条定义照旧并列；跨家重复只留一条、总数照旧 2+1（W6 之前的读数）
    expect(got.symbols.map((s) => `${s.filePath}#${s.line}`)).toEqual([`${F1}#1`, `${F1}#9`]);
    expect(got.totalMatched).toBe(3);
  });
});

describe('pickWorkspaceSymbols · 排序与预算', () => {
  const pool = {
    symbols: [
      symbol('M_KOJO_MESSAGE_COM_K1_30', F2, 11),
      symbol('ALPHA', F1, 1),
      symbol('XALPHAY', F1, 5),
      symbol('UNRELATED', F1, 7),
      symbol('训练度检查', F2, 3),
    ],
    totalMatched: 5,
  };

  it('大小写不敏感：小写查询命中原生大写名；宿主只**排名**、不再过滤一次', () => {
    const got = pickWorkspaceSymbols(pool, 'alpha');
    // 名字档恒在前；其余候选（应答方按它自己的口径给的）留在后面，不被宿主按
    // "我以为的子串判据"偷偷扔掉——口径归提供方，宿主不抄第二份。
    expect(got.items.map((s) => s.name).slice(0, 2)).toEqual(['ALPHA', 'XALPHAY']);
    expect(got.items).toHaveLength(5);
    expect(got.hidden).toBe(0);
  });

  it('名字命中优先于路径命中（同一条查询里两档并存）', () => {
    // `MESSAGE` 命中名字；`ZULU` 的名字不含它，只住在那个文件里 → 排在后面
    const both = pickWorkspaceSymbols(
      { symbols: [symbol('ZULU', F1, 1), symbol('MESSAGE', F1, 2)], totalMatched: 2 },
      'message',
    );
    expect(both.items.map((s) => s.name)).toEqual(['MESSAGE', 'ZULU']);
    expect(both.hidden).toBe(0);

    // 只有路径命中的那条照样给（不因为"名字没中"就藏起来），但它排在名字命中之后
    const pathOnly = pickWorkspaceSymbols(
      { symbols: [symbol('ZULU', F1, 1), symbol('MESSAGE_CHECK', F2, 2)], totalMatched: 2 },
      'message',
    );
    expect(pathOnly.items.map((s) => s.name)).toEqual(['MESSAGE_CHECK', 'ZULU']);
    expect(pathOnly.hidden).toBe(0);
  });

  it('精确 > 前缀 > 含子串 > 仅路径，且同档保持入参顺序（确定序）', () => {
    const ranked = {
      symbols: [
        symbol('XABY', F1, 1), // 名字含子串
        symbol('ABOVE', F1, 2), // 名字前缀
        symbol('ZULU', 'C:\\game\\abc\\X.ERB', 3), // 只有路径含 `ab`
        symbol('AB', F2, 4), // 精确
      ],
      totalMatched: 4,
    };
    const got = pickWorkspaceSymbols(ranked, 'ab');
    expect(got.items.map((s) => s.name)).toEqual(['AB', 'ABOVE', 'XABY', 'ZULU']);
  });

  it('中文函数名直接搜得到（排名档与其他候选同规则：命中的在前）', () => {
    const got = pickWorkspaceSymbols(pool, '训练');
    expect(got.items[0]?.name).toBe('训练度检查');
    expect(got.items).toHaveLength(5);
  });

  it(`渲染预算 ${WORKSPACE_SYMBOL_RENDER_LIMIT} 条 + 溢出计数（上限不是丢弃）`, () => {
    const many = {
      symbols: Array.from({ length: 500 }, (_, i) => symbol(`ALPHA_${i}`, F1, i + 1)),
      totalMatched: 99_104,
    };
    const got = pickWorkspaceSymbols(many, 'ALPHA');
    expect(got.items).toHaveLength(WORKSPACE_SYMBOL_RENDER_LIMIT);
    expect(got.hidden).toBe(99_104 - WORKSPACE_SYMBOL_RENDER_LIMIT);
    expect(workspaceSymbolOverflowText(got.hidden)).toBe(
      `另有 ${99_104 - WORKSPACE_SYMBOL_RENDER_LIMIT} 条未列出——继续输入可缩小范围`,
    );
  });

  it('空查询不排（返回空，配提示文案用）', () => {
    expect(pickWorkspaceSymbols(pool, '   ')).toEqual({ items: [], hidden: 0 });
  });

  it('非法预算退回缺省，不是"一条都不给"', () => {
    const got = pickWorkspaceSymbols(pool, 'ALPHA', 0);
    expect(got.items.length).toBeGreaterThan(0);
  });

  it('溢出提示：没溢出就不编句子；hidden=0 → null', () => {
    expect(workspaceSymbolOverflowText(0)).toBeNull();
    expect(workspaceSymbolOverflowText(-3)).toBeNull();
  });
});

describe('workspaceSymbolNotice · 为什么没有结果（不静默）', () => {  const base = { hasProject: true, indexing: false, indexError: null, fileCount: 2316, query: 'alpha' };

  it('未打开项目 → 说的是项目，不是"你名字起错了"', () => {
    expect(workspaceSymbolNotice({ ...base, hasProject: false })).toBe(
      '未打开项目，没有可搜索的工作区符号',
    );
  });

  it('索引失败 → 带出失败原因（与状态栏同一读数）', () => {
    expect(workspaceSymbolNotice({ ...base, indexError: '读取目录被拒绝' })).toBe(
      '索引不可用：读取目录被拒绝',
    );
  });

  it('索引构建中 → 说"稍候"，不说"无匹配"', () => {
    expect(workspaceSymbolNotice({ ...base, indexing: true })).toBe('索引构建中，稍候即可搜索函数名');
  });

  it('一个文件都没索引到 → 说名录是空的', () => {
    expect(workspaceSymbolNotice({ ...base, fileCount: 0 })).toBe('当前项目还没有可用的函数索引');
  });

  it('还没打字 → 教怎么用；打了字仍无命中 → 才是"无匹配符号"', () => {
    expect(workspaceSymbolNotice({ ...base, query: '' })).toBe(
      '输入函数名以搜索（中文名与原生大写名都可）',
    );
    expect(workspaceSymbolNotice(base)).toBe('无匹配符号');
  });

  it('判据次序：环境事实优先于查询事实', () => {
    expect(workspaceSymbolNotice({ ...base, hasProject: false, query: '', indexing: true })).toBe(
      '未打开项目，没有可搜索的工作区符号',
    );
    expect(workspaceSymbolNotice({ ...base, indexing: true, query: '' })).toBe(
      '索引构建中，稍候即可搜索函数名',
    );
  });

  /* ── ST-CONSUMERS：同一格改成按 phase 查表（`fileCount === 0` 那一句假话的主靶） ── */

  /** 提供方交出的事实（phase 由 provider 判；本文件只喂给它，宿主不再算形状） */
  const idx = (over: Partial<ErbIndexState>): ErbIndexState => ({
    phase: 'ready',
    sources: [
      { source: 'project', offered: 2, available: true },
      { source: 'workspace', offered: 1, available: true },
    ],
    rootsWalked: 3,
    filesScanned: 2316,
    functions: 99104,
    coverage: 'full',
    ...over,
  });

  it('没地方可扫 ⇒ 说的是"没有可扫描的位置"，不再是"还没有可用的函数索引"', () => {
    const text = workspaceSymbolNotice({
      ...base,
      fileCount: 0,
      indexState: idx({ phase: 'nothing-to-scan', sources: [], rootsWalked: 0, filesScanned: 0, functions: 0, coverage: 'none' }),
    });
    expect(text).toContain('没有可扫描的位置');
    expect(text).not.toBe('当前项目还没有可用的函数索引');
  });

  it('扫了什么都没有 ⇒ 与上一句**不同句**（旧形态把两者糊成同一句假话）', () => {
    const nowhere = workspaceSymbolNotice({ ...base, fileCount: 0, indexState: idx({ phase: 'nothing-to-scan', rootsWalked: 0, filesScanned: 0, functions: 0, coverage: 'none' }) });
    const empty = workspaceSymbolNotice({ ...base, fileCount: 0, indexState: idx({ phase: 'empty', rootsWalked: 1, filesScanned: 0, functions: 0, coverage: 'full' }) });
    expect(nowhere).not.toBe(empty);
    expect(empty).toContain('确实一条都没有');
  });

  it('原始读数可查：两句都带得出"走了几个位置 · 扫了几个文件"', () => {
    expect(
      workspaceSymbolNotice({ ...base, fileCount: 0, indexState: idx({ phase: 'empty', rootsWalked: 4, filesScanned: 512, functions: 0 }) }),
    ).toContain('走了 4 个位置 · 扫了 512 个文件 · 名录 0 名');
    expect(
      workspaceSymbolNotice({ ...base, fileCount: 0, indexState: idx({ phase: 'nothing-to-scan', rootsWalked: 0, filesScanned: 0, functions: 0, coverage: 'none' }) }),
    ).toContain('走了 0 个位置 · 扫了 0 个文件 · 名录 0 名');
  });

  it('还没开扫 / 正在扫 ⇒ 仍说"稍候"，但把本轮读数一并给出', () => {
    for (const phase of ['idle', 'scanning'] as const) {
      expect(
        workspaceSymbolNotice({ ...base, indexState: idx({ phase }) }).startsWith('索引构建中，稍候即可搜索函数名（'),
      ).toBe(true);
    }
  });

  it('失败态 ⇒ 说"构建失败"并带原始错误（与状态栏同一读数不冲突：状态栏那条优先）', () => {
    const text = workspaceSymbolNotice({ ...base, indexState: idx({ phase: 'failed', error: 'EPERM' }) });
    expect(text).toContain('构建失败');
    expect(text).toContain('原始错误：EPERM');
    expect(workspaceSymbolNotice({ ...base, indexError: '读取目录被拒绝', indexState: idx({ phase: 'failed', error: 'EPERM' }) })).toBe(
      '索引不可用：读取目录被拒绝',
    );
  });

  it('就绪 ⇒ 交回查询层（"无匹配符号" / "先打字"两句零改动）；提供方没交事实 ⇒ 旧读数逐字保留', () => {
    expect(workspaceSymbolNotice(base)).toBe('无匹配符号');
    expect(workspaceSymbolNotice({ ...base, query: '', indexState: idx({}) })).toBe(
      '输入函数名以搜索（中文名与原生大写名都可）',
    );
    expect(workspaceSymbolNotice({ ...base, fileCount: 0 })).toBe('当前项目还没有可用的函数索引');
  });
});

describe('symbolPickerItems · 副行三段（同名多定义靠 filePath 区分）', () => {
  it('主行=名字、副行=所在**目录**（交给 Picker 现成的两段渲染）、hint=行号、title=完整路径:行', () => {
    const [one] = symbolPickerItems([symbol('ALPHA', F1, 42)]);
    expect(one?.primary).toBe('ALPHA');
    expect(one?.secondaryDir).toBe('C:\\game\\個人口上\\chara10');
    expect(one?.hint).toBe(':42');
    expect(one?.title).toBe(`${F1}:42`);
  });

  it('同名同文件、只有行号不同 ⇒ key 仍互异（React 不撞 key，回查不串位）', () => {
    const items = symbolPickerItems([symbol('ALPHA', F1, 1), symbol('ALPHA', F1, 9)]);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it('裸文件名（无目录段）⇒ 不给 secondaryDir，不画一条空副行', () => {
    const [one] = symbolPickerItems([symbol('ALPHA', 'ALPHA.ERB', 3)]);
    expect(one?.secondaryDir).toBeUndefined();
  });
});

describe('WorkspaceSymbols 静态渲染（"按了没反应"的那一厘米）', () => {
  it('空面板给的是**原因**文案，而不是空列表', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSymbols, {
        fetchSymbols: () => ({ symbols: [], totalMatched: 0 }),
        notice: () => '未打开项目，没有可搜索的工作区符号',
        onPickSymbol: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('按名称搜索工作区符号');
    expect(html).toContain('未打开项目，没有可搜索的工作区符号');
    expect(html).toContain('picker-empty');
  });
});

/**
 * 接线守卫（照 `readonly-pill.test.ts` 的做法：读源码钉住"这条能力确实在注册表里"）。
 * 纯逻辑与渲染都测到了，还剩最容易悄悄丢的一处——**壳层有没有把它接上去**：
 * 快捷键、Esc 分层、面板渲染三件少任一件，作者看到的就是"按了没反应"。
 */
describe('ShellLayout 接线（Ctrl+T 的三条腿）', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '../src/ui/ShellLayout.tsx'), 'utf8');

  it('命令注册表里有 `workbench.workspaceSymbols` 且默认绑 `ctrl+t`（真源 = keybindings.ts，ShellLayout 动态取生效键位——rebindable 后不再字面量硬编码）', () => {
    expect(src).toContain("id: 'workbench.workspaceSymbols'");
    // d13db29 起键位走集中注册表：ShellLayout 只保留 `effectiveKeybindingOf` 间接引用，
    // 默认键字面量（`keys: 'ctrl+t'`）单源住在 keybindings.ts——两处一起钉住。
    expect(src).toContain("keybinding: effectiveKeybindingOf('workbench.workspaceSymbols')");
    const kb = readFileSync(path.resolve(import.meta.dirname, '../src/ui/keybindings.ts'), 'utf8');
    expect(kb).toContain("id: 'workbench.workspaceSymbols'");
    expect(kb).toContain("keys: 'ctrl+t'");
  });

  it('符号面板打开时算进 `picker` 层（Esc 优先级 picker > overlay > zen 不许漏它）', () => {
    expect(src).toMatch(/pickerRef\.current = paletteOpen \|\| quickOpen \|\| symbolsOpen/);
  });

  it('渲染挂在浮层区，且跳转只发既有 `editor.revealLocation`（不新造机制）', () => {
    expect(src).toContain('<WorkspaceSymbols');
    expect(src).toContain("source: '工作区符号'");
    expect(src).toContain("kernel.slots.query('ui.editor.languageService')");
  });

  it('`Picker` 的键盘闸门走 `isComposingEvent` 单源（合成期不吞键；三个面板共用这一处）', () => {
    const palette = readFileSync(path.resolve(import.meta.dirname, '../src/ui/Palette.tsx'), 'utf8');
    expect(palette).toContain("from './shell-keys'");
    expect(palette).toContain('isComposingEvent(e.nativeEvent, composingRef.current)');
    // 闸门必须在任何消费动作**之前**（放在 if 阶梯中间等于已经吞了一次键）
    expect(palette.indexOf('isComposingEvent(e.nativeEvent')).toBeLessThan(
      palette.indexOf("e.key === 'Escape'"),
    );
  });
});

describe('十万条规模下宿主侧那一趟的真实读数', () => {
  const all: EditorWorkspaceSymbol[] = Array.from({ length: 99_104 }, (_, i) =>
    // 约两成中文名，其余长前缀大写名（照真实语料形态）
    i % 5 === 0 ? symbol(`训练度${i}`, F2, i) : symbol(`M_KOJO_MESSAGE_COM_K${i % 300}_${i}`, F1, i),
  );

  /** 跑 3 次取中位（首跑含 JIT，不当数；跑数刻意压到 3——同批并行的 perf 护栏经不起更多 CPU 抢） */
  function medianOf(query: string, contributed: number): number {
    const big = contribution('big', {
      kind: 'workspaceSymbol',
      symbols: all.slice(0, contributed),
      totalMatched: all.length,
    });
    collectWorkspaceSymbols([big], { query, project: null, limit: WORKSPACE_SYMBOL_RENDER_LIMIT });
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const picked = pickWorkspaceSymbols(
        collectWorkspaceSymbols([big], { query, project: null, limit: WORKSPACE_SYMBOL_RENDER_LIMIT }),
        query,
        WORKSPACE_SYMBOL_RENDER_LIMIT,
      );
      runs.push(performance.now() - t0);
      expect(picked.items.length).toBeLessThanOrEqual(WORKSPACE_SYMBOL_RENDER_LIMIT);
      expect(picked.hidden).toBe(all.length - picked.items.length);
    }
    return runs.sort((a, b) => a - b)[1]!;
  }

  it('守预算的应答方（生产形态，候选 ≤ 渲染预算）：合并 + 排序亚毫秒', () => {
    const median = medianOf('K12_1', WORKSPACE_SYMBOL_RENDER_LIMIT);
    console.info(
      `[D2 宿主侧实测] 生产形态（应答方给 ${WORKSPACE_SYMBOL_RENDER_LIMIT} 条 / 名录 99,104 条）：中位 ${median.toFixed(2)}ms`,
    );
    expect(median).toBeLessThan(30);
  });

  it('不守预算的应答方（最坏形态，一次递回 99,104 条）：仍在几百毫秒内，且溢出计数照实', () => {
    /**
     * 这一档刻意**违反**契约的 `limit`（老提供方 / 未来别的应答方可能这样）：
     * 量的是"宿主自己截断最多付多少"，不是"预算被对方替我挡住了"。
     * 阈值放到 400ms 是慢机余量——真实读数进日志，不写形容词。
     */
    const median = medianOf('K12_1', all.length);
    console.info(
      `[D2 宿主侧实测] 最坏形态（候选 ${all.length} 条全量递回）：中位 ${median.toFixed(2)}ms`,
    );
    expect(median).toBeLessThan(400);
  });
});
