/**
 * 「全部替换」的名字台账供数腿（`ui/name-ledger.ts`，W8 XLANG-RENAME 接线批）。
 *
 * `search-replace-exec` 的 `nameLedger` 入口是 W8 交付好的，**供数的人此前不在**：
 * 于是跨语言腿只看得到已开标签，检索范围外的同名记号没人说出来。这批钉三件事：
 * ① `.erb` 侧走 `erb.parser` 的 `referencesTo`（与 F2 同一个出口，`kind` 不抹平）；
 * ② `.kojo` 侧走 `listKojoSourceTexts`（**未打开的糖源也进台账**）+ 槽判读，
 *    判读回来的位置经 `occurrencesFromLocations` 补区间；
 * ③ 判据缺席（服务未注册 / 索引未建）⇒ **抛**，且这条抛错在替换链上只落成
 *    可见回执：闭文件已经落盘的改动**绝不因此回退、绝不撤销**（W8b 那条不变式）。
 */

import { describe, expect, it } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorLanguageServiceContribution,
  EditorSymbolLocation,
  ErbIndex,
  ErbIndexState,
  ErbParserService,
  ErbReference,
} from '@kojo/plugin-api';
import { createProjectNameLedger } from '../src/ui/name-ledger';
import { createFileReplaceRunner, type FileReplaceDeps } from '../src/ui/search-replace-exec';

const ERB_A = 'C:/p/ERB/a.ERB';
const KOJO_1 = 'C:/p/kojo/one.kojo';
const NAME = 'FOO_BAR';

const refsOf = (path: string): ErbReference[] => [
  { filePath: path, line: 2, column: 6, endColumn: 12, kind: 'call' },
];

interface Stub {
  parser?: Pick<ErbParserService, 'referencesTo' | 'currentIndex' | 'indexState'> | null;
  sources?: Array<{ path: string; text: string }>;
  locations?: EditorSymbolLocation[] | 'throw';
  walked?: string[];
}

function fakeKernel(stub: Stub): Kernel {
  const contributions: EditorLanguageServiceContribution[] = [
    {
      id: 'sugar-fake',
      order: 10,
      provide: (request) => {
        if (request.kind !== 'references') return undefined;
        if (stub.locations === 'throw') throw new Error('判读器炸了');
        return { kind: 'references', locations: stub.locations ?? [] };
      },
    },
  ];
  return {
    project: { current: () => ({ rootDir: 'C:/p', adapterId: 'x', kojoPaths: [] }) },
    workspaces: { roots: () => [] },
    services: {
      tryGet: (id: string) =>
        id === 'erb.parser'
          ? stub.parser === null
            ? undefined
            : {
                ...stub.parser,
                referencesTo: (name: string) => (name === NAME && stub.parser ? refsOf(ERB_A) : []),
              }
          : undefined,
    },
    slots: { query: () => contributions },
    io: {
      walkDir: async (path: string) => {
        (stub.walked ??= []).push(path);
        return (stub.sources ?? []).map((f) => ({
          name: f.path.slice(f.path.lastIndexOf('/') + 1),
          path: f.path,
          isDirectory: false,
        }));
      },
      readTexts: async (paths: readonly string[]) => {
        const byPath = new Map((stub.sources ?? []).map((f) => [f.path, f.text]));
        return paths.map((p) => {
          const text = byPath.get(p);
          return text === undefined ? null : { text };
        });
      },
    },
  } as unknown as Kernel;
}

const builtIndex = { byName: new Map(), files: new Map() } as unknown as ErbIndex;

describe('createProjectNameLedger（与 F2 同一份判据）', () => {
  it('检索词不是一个记号 ⇒ 空台账，一次索引都不碰', async () => {
    let touched = 0;
    const kernel = fakeKernel({
      parser: {
        currentIndex: () => {
          touched++;
          return builtIndex;
        },
        referencesTo: () => {
          touched++;
          return refsOf(ERB_A);
        },
      },
    });
    const ledger = createProjectNameLedger(kernel);
    expect(await ledger('CALL FOO')).toEqual([]);
    expect(await ledger('^FOO.*$')).toEqual([]);
    expect(await ledger('')).toEqual([]);
    expect(touched).toBe(0);
  });

  it('.erb 侧台账保住 kind 与语言轴；名字不在索引里 ⇒ 空台账且不翻糖源', async () => {
    const walked: string[] = [];
    const kernel = fakeKernel({
      walked,
      parser: { currentIndex: () => builtIndex, referencesTo: () => refsOf(ERB_A) },
      sources: [{ path: KOJO_1, text: '呼び出し FOO_BAR()\n' }],
    });
    const ledger = createProjectNameLedger(kernel);
    const hit = await ledger('foo_bar'); // 归一化大小写与 F2 同口径
    expect(hit).toEqual([{ filePath: ERB_A, line: 2, column: 6, endColumn: 12, kind: 'call', language: 'erb' }]);
    // 只有"索引里真有这个名字"才付一次全项目列举（没名字可核对时不去翻糖源）
    expect(walked).toEqual(['C:/p']);
    walked.length = 0;
    expect(await ledger('NO_SUCH_NAME')).toEqual([]); // 索引里没有 ⇒ 判据答"没有出现点"
    expect(walked).toEqual([]);
  });

  it('跨语言腿看得见**未打开**的糖源（这就是此前缺的那一条腿）', async () => {
    const kernel = fakeKernel({
      parser: { currentIndex: () => builtIndex, referencesTo: () => refsOf(ERB_A) },
      sources: [{ path: KOJO_1, text: `  呼び出し ${NAME}()\n` }],
      locations: [{ filePath: KOJO_1, line: 1, column: 8, kind: 'call' }],
    });
    const hit = await createProjectNameLedger(kernel)(NAME);
    const kojo = hit.find((occ) => occ.language === 'kojo');
    expect(kojo).toBeDefined();
    expect(kojo).toMatchObject({ filePath: KOJO_1, line: 1, column: 8, kind: 'call' });
    // `endColumn` 由名字长度派生（与反向索引同一条纪律），不是第二份区间判据
    expect(kojo!.endColumn).toBe(8 + NAME.length);
    expect(hit).toHaveLength(2); // .erb 那处 + .kojo 这一处，同一份台账
  });

  it('糖侧越界判读不收（糖的引用面是文件局部的）', async () => {
    const kernel = fakeKernel({
      parser: { currentIndex: () => builtIndex, referencesTo: () => refsOf(ERB_A) },
      sources: [{ path: KOJO_1, text: `${NAME}\n` }],
      locations: [{ filePath: 'C:/p/kojo/other.kojo', line: 1, column: 1 }],
    });
    expect(await createProjectNameLedger(kernel)(NAME)).toHaveLength(1); // 只有 .erb 那处
  });

  it('判据缺席 ⇒ 抛（不装成"没有出现点"）：服务未注册 / 索引未建 / 判读抛错', async () => {
    await expect(createProjectNameLedger(fakeKernel({ parser: null }))(NAME)).rejects.toThrow(/判据缺席/);
    await expect(
      createProjectNameLedger(fakeKernel({ parser: { currentIndex: () => null, referencesTo: () => refsOf(ERB_A) } }))(NAME),
    ).rejects.toThrow(/索引未建/);
    const kernel = fakeKernel({
      parser: { currentIndex: () => builtIndex, referencesTo: () => refsOf(ERB_A) },
      sources: [{ path: KOJO_1, text: `${NAME}\n` }],
      locations: 'throw',
    });
    await expect(createProjectNameLedger(kernel)(NAME)).rejects.toThrow(/判读器炸了/);
  });

  /* ── ST-CONSUMERS：同一格改成按 phase 查表（不再对"没地方可扫"承诺"稍后再试"） ── */

  /** 抛错消息（台账这一腿是**只读回执**，说清"为什么核对不了"就是它的文案面） */
  async function ledgerErrorWith(indexState: ErbParserService['indexState']): Promise<string> {
    const kernel = fakeKernel({ parser: { currentIndex: () => null, referencesTo: () => [], indexState } });
    try {
      await createProjectNameLedger(kernel)(NAME);
    } catch (e: unknown) {
      return (e as Error).message;
    }
    throw new Error('测试前提：索引缺席时台账必须抛（不装成"没有出现点"）');
  }

  const fact = (over: Partial<ErbIndexState>): ErbIndexState => ({
    phase: 'ready',
    sources: [{ source: 'project', offered: 1, available: true }],
    rootsWalked: 1,
    filesScanned: 10,
    functions: 20,
    coverage: 'full',
    ...over,
  });

  it('没地方可扫 ⇒ 说的是"没有可扫描的位置"，不再让作者干等', async () => {
    const msg = await ledgerErrorWith(() => fact({ phase: 'nothing-to-scan', rootsWalked: 0, functions: 0, coverage: 'none' }));
    expect(msg).toContain('没有可扫描的位置');
    expect(msg).toContain('无法核对同名记号');
    expect(msg).not.toContain('仍在构建');
  });

  it('扫了什么都没有 ⇒ 另一句；两者不同句（旧形态一句糊两态）', async () => {
    const empty = await ledgerErrorWith(() => fact({ phase: 'empty', functions: 0 }));
    expect(empty).toContain('名录里一个函数都没有');
    expect(empty).not.toBe(await ledgerErrorWith(() => fact({ phase: 'nothing-to-scan', rootsWalked: 0, functions: 0, coverage: 'none' })));
  });

  it('失败 ⇒ 逐字带上原始错误；正在构建 ⇒ 说"正在构建"', async () => {
    expect(await ledgerErrorWith(() => fact({ phase: 'failed', error: 'EPERM: /erb' }))).toContain('原始错误：EPERM: /erb');
    expect(await ledgerErrorWith(() => fact({ phase: 'scanning' }))).toContain('正在构建');
  });

  it('提供方没交事实 / 事实面自己抛错 ⇒ 逐字退回原句（旧行为零改动）', async () => {
    expect(await ledgerErrorWith(undefined)).toBe('ERB 函数索引未建（打开项目后仍在构建），无法核对同名记号');
    expect(await ledgerErrorWith(() => fact({ phase: 'ready' }))).toContain('索引未建');
    expect(await ledgerErrorWith(() => { throw new Error('事实面炸了'); })).toContain('索引未建（打开项目后仍在构建）');
  });
});

/* ============================== 不变式：核对失败不许动已经落盘的改动 ============================== */

describe('替换链上的台账抛错 = 可见回执，已落盘的改动不回退', () => {
  const text = `@${NAME}(1)\nCALL ${NAME}\n`;

  function harness(files: Record<string, string>, writable: readonly string[]) {
    const map = new Map(Object.entries(files));
    const writes: string[] = [];
    const io: FileReplaceDeps['io'] = {
      isWritable: (p) => writable.includes(p),
      readText: async (p) => {
        const t = map.get(p);
        if (t === undefined) throw new Error(`没有这个文件：${p}`);
        return { text: t };
      },
      writeText: async (p, t) => {
        writes.push(p);
        map.set(p, t);
      },
    };
    return { map, writes, io };
  }

  it('闭文件已落盘 + 判据抛错 ⇒ 改动仍在盘上，回执只多一条可见说明', async () => {
    const h = harness({ [ERB_A]: text }, [ERB_A]);
    const runner = createFileReplaceRunner({
      io: h.io,
      modelFor: () => undefined,
      nameLedger: () => {
        throw new Error('ERB 函数索引未建（打开项目后仍在构建），无法核对同名记号');
      },
    });
    const out = await runner({
      query: NAME,
      replaceText: 'BAZ_QUX',
      options: { isRegex: false, wholeWord: true, caseSensitive: false },
      mode: { kind: 'all' },
      files: [{ path: ERB_A, matches: [] }],
    } as unknown as Parameters<ReturnType<typeof createFileReplaceRunner>>[0]);
    expect(out.applied).toBeGreaterThan(0);
    expect(h.writes).toEqual([ERB_A]);
    expect(h.map.get(ERB_A)).toBe('@BAZ_QUX(1)\nCALL BAZ_QUX\n'); // 一次撤销都没有
    expect(out.errors.join('\n')).toContain('引用判据核对失败');
    expect(out.errors.join('\n')).toContain('索引未建');
  });

  it('台账说得出范围外残留 ⇒ 逐字用 `residualOutsideScopeNotice`（不新写文案）', async () => {
    const h = harness({ [ERB_A]: text }, [ERB_A]);
    const runner = createFileReplaceRunner({
      io: h.io,
      modelFor: () => undefined,
      nameLedger: async (query) => {
        expect(query).toBe(NAME);
        return [{ filePath: 'C:/p/ERB/z.ERB', line: 1, column: 1, endColumn: 8, kind: 'call', language: 'erb' }];
      },
    });
    const out = await runner({
      query: NAME,
      replaceText: 'BAZ_QUX',
      options: { isRegex: false, wholeWord: true, caseSensitive: false },
      mode: { kind: 'all' },
      files: [{ path: ERB_A, matches: [] }],
    } as unknown as Parameters<ReturnType<typeof createFileReplaceRunner>>[0]);
    expect(out.errors.join('\n')).toContain(`引用判据显示「${NAME}」在检索范围外还有 1 处出现（1 个文件）`);
  });
});
