import { describe, expect, it } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type { EditorLanguageServiceContribution } from '@kojo/plugin-api';
import { kojoReferencesViaSlot, listKojoSourceTexts } from '../src/ui/kojo-source-scan';

/**
 * F2 改名跨语言腿的**宿主取数侧**（W8 XLANG-RENAME 接线批）。
 *
 * 钉的全是"看不见就必须出声"这一族：`.kojo` 是源、`.erb` 是产物，只改 `.erb` 半边
 * ⇒ 下一次保存把改名结果冲掉（数据损坏级）。所以枚举失败 / 读文失败 / 判读无人应答
 * 三种现场**一律抛**，交 `monaco/erb-rename.ts` 整批拒绝；
 * 反过来，"供方答了、但答的是空集"是**真话**（这些记号不是引用）⇒ 正常返回空数组。
 */

const PROJECT_ROOT = 'C:/Game';
const WS_ROOT = 'D:/作品';

type IoStub = {
  walkDir?: (path: string, opts?: unknown) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>;
  readTexts?: (paths: readonly string[]) => Promise<Array<{ text: string } | null>>;
};

function fakeKernel(opts: {
  project?: { rootDir: string } | null;
  roots?: string[];
  io?: IoStub;
}): Kernel {
  return {
    project: { current: () => (opts.project === undefined ? null : opts.project) },
    workspaces: { roots: () => opts.roots ?? [] },
    io: {
      walkDir: async (path: string) =>
        opts.io?.walkDir ? opts.io.walkDir(path, undefined) : [{ name: 'x.ERB', path: `${path}/x.ERB`, isDirectory: false }],
      readTexts: async (paths: readonly string[]) =>
        opts.io?.readTexts ? opts.io.readTexts(paths) : paths.map(() => ({ text: '调用 M_KOJO_A()\n' })),
    },
  } as unknown as Kernel;
}

describe('listKojoSourceTexts（糖源枚举 + 读文）', () => {
  it('无项目 ⇒ 空清单（没有可判读的现场，不是失败）', async () => {
    expect(await listKojoSourceTexts(fakeKernel({ project: null }))).toEqual([]);
  });

  it('只收 `.kojo`（大小写不敏感），根 = 项目根 ∪ 工作区全部根且去重', async () => {
    const walked: string[] = [];
    const kernel = fakeKernel({
      project: { rootDir: PROJECT_ROOT },
      roots: [WS_ROOT, PROJECT_ROOT], // 与项目根重复一枚 ⇒ 只该走一趟
      io: {
        walkDir: async (path) => {
          walked.push(path);
          return [
            { name: 'A.KOJO', path: `${path}/A.KOJO`, isDirectory: false },
            { name: 'b.erb', path: `${path}/b.erb`, isDirectory: false },
            { name: '子目录', path: `${path}/子目录`, isDirectory: true },
            { name: 'C.kojo', path: `${path}/C.kojo`, isDirectory: false },
          ];
        },
      },
    });
    const files = await listKojoSourceTexts(kernel);
    expect(walked).toEqual([PROJECT_ROOT, WS_ROOT]);
    expect(files.map((f) => f.filePath)).toEqual([
      `${PROJECT_ROOT}/A.KOJO`,
      `${PROJECT_ROOT}/C.kojo`,
      `${WS_ROOT}/A.KOJO`,
      `${WS_ROOT}/C.kojo`,
    ]);
    expect(files.every((f) => f.text.length > 0)).toBe(true);
  });

  it('某个根 walkDir 抛 ⇒ **上抛**（吞掉坏根 = 少一份清单 = 只改 .erb 半边的假全或无）', async () => {
    const kernel = fakeKernel({
      project: { rootDir: PROJECT_ROOT },
      roots: [WS_ROOT],
      io: {
        walkDir: async (path) => {
          if (path === WS_ROOT) throw new Error('盘没了');
          return [{ name: 'A.kojo', path: `${path}/A.kojo`, isDirectory: false }];
        },
      },
    });
    await expect(listKojoSourceTexts(kernel)).rejects.toThrow('.kojo 源枚举失败（D:/作品）：盘没了');
  });

  it('批量读里有一份读不到 ⇒ 上抛并计数（读不到 ≠ 没有同名记号）', async () => {
    const kernel = fakeKernel({
      project: { rootDir: PROJECT_ROOT },
      io: {
        walkDir: async (path) => [
          { name: 'A.kojo', path: `${path}/A.kojo`, isDirectory: false },
          { name: 'B.kojo', path: `${path}/B.kojo`, isDirectory: false },
        ],
        readTexts: async () => [{ text: '调用 X()\n' }, null],
      },
    });
    await expect(listKojoSourceTexts(kernel)).rejects.toThrow('1 份 .kojo 源读不到');
  });

  it('批量读整趟失败 ⇒ 上抛（不交部分清单）', async () => {
    const kernel = fakeKernel({
      project: { rootDir: PROJECT_ROOT },
      io: {
        walkDir: async (path) => [{ name: 'A.kojo', path: `${path}/A.kojo`, isDirectory: false }],
        readTexts: async () => {
          throw new Error('IPC 断了');
        },
      },
    });
    await expect(listKojoSourceTexts(kernel)).rejects.toThrow('.kojo 源批量读失败');
  });
});

/* ============================== 判读腿（问槽） ============================== */

const PROBE = { filePath: `${WS_ROOT}/A.kojo`, text: '调用 M_KOJO_A()\n', line: 1, column: 3 };

function contribution(
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution {
  return { id, order: 20, provide } as EditorLanguageServiceContribution;
}

describe('kojoReferencesViaSlot（引用判读只问槽，宿主零语法知识）', () => {
  it('无人应答这份请求 ⇒ 抛（空数组的语义是"判官认了但不是引用"，不许冒充"没有判据"）', () => {
    expect(() => kojoReferencesViaSlot([contribution('a', () => undefined)], fakeKernel({}), PROBE)).toThrow(
      /没有任何语言服务供方应答/,
    );
  });

  it('供方抛错 ⇒ 原样上抛并带上 id（抛错 ≠ 判官答"不是引用"）', () => {
    expect(() =>
      kojoReferencesViaSlot(
        [
          contribution(
            '糖线判读',
            () => {
              throw new Error('转译器炸了');
            },
          ),
        ],
        fakeKernel({}),
        PROBE,
      ),
    ).toThrow("引用判读抛错（'糖线判读'）：转译器炸了");
  });

  it('认了这份文件但答空集 ⇒ 返回空数组（真话，不是缺席）', () => {
    const got = kojoReferencesViaSlot(
      [contribution('kojo-references', () => ({ kind: 'references', locations: [] }))],
      fakeKernel({}),
      PROBE,
    );
    expect(got).toEqual([]);
  });

  it('只收**本文件**的判读结果（糖的引用面是文件局部的，越界不收，不猜）', () => {
    const got = kojoReferencesViaSlot(
      [
        contribution('kojo-references', () => ({
          kind: 'references',
          locations: [
            { filePath: PROBE.filePath, line: 1, column: 3, kind: 'call' },
            { filePath: `${WS_ROOT}/别的.kojo`, line: 9, column: 2, kind: 'call' },
          ],
        })),
      ],
      fakeKernel({ project: { rootDir: PROJECT_ROOT } }),
      PROBE,
    );
    expect(got).toEqual([{ filePath: PROBE.filePath, line: 1, column: 3, kind: 'call' }]);
  });

  it('请求带的是探针那份**闭文件全文**（不是活动标签的文本）', () => {
    let seenText = '';
    kojoReferencesViaSlot(
      [
        contribution('kojo-references', (request) => {
          if (request.kind !== 'references') return undefined;
          seenText = request.text;
          return { kind: 'references', locations: [] };
        }),
      ],
      fakeKernel({ project: { rootDir: PROJECT_ROOT } }),
      PROBE,
    );
    expect(seenText).toBe(PROBE.text);
  });
});
