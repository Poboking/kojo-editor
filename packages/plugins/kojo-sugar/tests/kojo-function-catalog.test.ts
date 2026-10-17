/**
 * `.kojo` 函数名录单测（W6，2026-10-17）——纯逻辑 + 假 io，不碰真盘。
 *
 * 钉的是"这份名录能不能被当成事实用"的四条：
 * ① 收进来的每一条都能按**产物路径**查回源坐标（工作区符号重定基全靠它）；
 * ② 半成品（转译产 error）一条不收——收了就是把不存在的函数报给作者；
 * ③ `size`+`mtime` 未变 ⇒ 整份复用（一次 `readTexts` 都不发）；变了 / 被 `invalidate`
 *    ⇒ 立刻失效并在新内容上下一次刷新里跟上；
 * ④ 失败面如实计数（根遍历失败 / 读失败 / 盘上已消失的文件从名录里带走）。
 */

import { describe, expect, it } from 'vitest';
import type { DirEntry, ErbFile, FileIO, SugarTranspileResult } from '@kojo/plugin-api';
import { pathKey, resolveSugarTarget } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { createKojoFunctionCatalog } from '../src/kojo-function-catalog';
import { foldGeneratedLine } from '../src/langsvc';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { stubDict, stubFaceTable } from './support';

const GOOD = '角色: 12\n函数 问候(次数)：\n    「你好。」\n    返回\n';
const BROKEN = '角色: 12\n时机 初见：\n    返回\n'; // 非函数体里的裸 `返回` ⇒ indent-mismatch（error）
const GOOD_PATH = '/t/KOJO/A.kojo';
const BROKEN_PATH = '/t/KOJO/B.kojo';

const transpiler = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 真折回口径（与 `langsvc` / 转到定义同一条规则），名录就用它把产物行换成源行 */
const fold = (result: SugarTranspileResult, generatedLine: number): number | null =>
  foldGeneratedLine(result, generatedLine);

interface FakeOptions {
  files?: Record<string, string>;
  mtimes?: Record<string, number>;
  failRoots?: string[];
}

function fakeCatalog(opts: FakeOptions = {}) {
  const files = opts.files ?? { [GOOD_PATH]: GOOD, [BROKEN_PATH]: BROKEN };
  const mtimes = opts.mtimes ?? {};
  let reads = 0;
  const io = {
    async walkDir(root: string): Promise<DirEntry[]> {
      if (opts.failRoots?.includes(root)) throw new Error(`EACCES: ${root}`);
      return Object.entries(files)
        .filter(([path]) => path.startsWith(root))
        .map(([path, text]) => ({
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          isDirectory: false,
          size: text.length,
          mtimeMs: mtimes[path] ?? 1,
        }));
    },
    async readTexts(paths: readonly string[]) {
      reads += 1;
      return paths.map((p) => {
        const text = files[p];
        return text === undefined ? null : { path: p, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1 };
      });
    },
  } as unknown as Pick<FileIO, 'walkDir' | 'readTexts'>;

  const catalog = createKojoFunctionCatalog({
    io,
    transpile: (source, options) => transpiler.transpile(source, options),
    parseProduct: (text: string, path: string): ErbFile => parseErbText(text, path),
  });
  /** 产物路径（名录是按 `resolveSugarTarget` 记的） */
  const product = (sourcePath: string): string => resolveSugarTarget(sourcePath)!;
  return { catalog, product, readCalls: () => reads };
}

describe('kojo-function-catalog · 收录与查询', () => {
  it('产物路径 + 函数名查得到源坐标；行号是折回后的**源行**，名字大小写不敏感', async () => {
    const { catalog, product } = fakeCatalog({ files: { [GOOD_PATH]: GOOD } });
    await catalog.refresh(['/t/KOJO']);
    expect(catalog.stats().ready).toBe(true);
    expect(catalog.stats().sources).toBe(1);

    const expected = fold(transpiler.transpile(GOOD, { filePath: GOOD_PATH }), 1);
    const hit = catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')!;
    expect(hit).not.toBeNull();
    expect(hit.sourcePath).toBe(GOOD_PATH);
    expect(hit.line).toBe(expected);
    // 名字归一 = 契约 `ErbFunction.normalizedName` 那一档（大写）；作者敲的名字小写也要查得到
    expect(catalog.locate(product(GOOD_PATH), 'm_kojo_k12_问候')?.line).toBe(expected);
    // 不是产物路径（例如源路径自己）⇒ 查不到，不猜
    expect(catalog.locate(GOOD_PATH, 'M_KOJO_K12_问候')).toBeNull();
  });

  it('半成品（转译产 error）一条不收：那份文件根本进不了名录', async () => {
    const { catalog, product } = fakeCatalog({ files: { [BROKEN_PATH]: BROKEN } });
    await catalog.refresh(['/t/KOJO']);
    expect(catalog.stats().sources).toBe(0);
    expect(catalog.locate(product(BROKEN_PATH), 'ANY')).toBeNull();
  });

  it('只有 `.kojo` 源会被收（方言与杂文件一条不进）', async () => {
    const { catalog } = fakeCatalog({ files: { '/t/KOJO/C.erb': '@C\n', '/t/KOJO/D.txt': 'x' } });
    await catalog.refresh(['/t/KOJO']);
    expect(catalog.stats().sources).toBe(0);
    expect(resolveSugarTarget('/t/KOJO/C.erb')).toBeNull(); // 方言文件不是源，也不是产物名
  });

  it('未刷新的名录查不出东西（不猜），也不抛', () => {
    const { catalog, product } = fakeCatalog();
    expect(catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')).toBeNull();
    expect(catalog.stats().ready).toBe(false);
  });
});

describe('kojo-function-catalog · 复用 / 失效 / 带走', () => {
  it('`size`+`mtime` 未变 ⇒ 第二轮整份复用，一次 `readTexts` 都不发', async () => {
    const { catalog, readCalls } = fakeCatalog({ files: { [GOOD_PATH]: GOOD } });
    await catalog.refresh(['/t/KOJO']);
    expect(readCalls()).toBe(1);
    await catalog.refresh(['/t/KOJO']);
    expect(readCalls()).toBe(1);
    expect(catalog.stats().reused).toBe(1);
    expect(catalog.stats().sources).toBe(1);
  });

  it('mtime 变了 ⇒ 重算那一份；`invalidate` ⇒ 当场失效（新内容下一轮跟上）', async () => {
    const files: Record<string, string> = { [GOOD_PATH]: GOOD };
    const mtimes: Record<string, number> = { [GOOD_PATH]: 1 };
    const { catalog, product, readCalls } = fakeCatalog({ files, mtimes });
    await catalog.refresh(['/t/KOJO']);
    const before = catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')!.line;

    // 作者改了源文件（函数体行数变了）⇒ 只重算这一份
    files[GOOD_PATH] = '角色: 12\n\n函数 问候(次数)：\n    「你好。」\n    返回\n';
    mtimes[GOOD_PATH] = 2;
    await catalog.refresh(['/t/KOJO']);
    expect(readCalls()).toBe(2);
    expect(catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')!.line).toBe(before + 1);

    // 外部改动信号：不等刷新就先摘掉（陈旧坐标比没有坐标更危险）
    catalog.invalidate(GOOD_PATH);
    expect(catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')).toBeNull();
    await catalog.refresh(['/t/KOJO']);
    expect(catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')).not.toBeNull();
  });

  it('盘上已消失的源文件整条带走（删除 / 移走不许继续当候选）', async () => {
    const files: Record<string, string> = { [GOOD_PATH]: GOOD };
    const { catalog, product } = fakeCatalog({ files });
    await catalog.refresh(['/t/KOJO']);
    expect(catalog.stats().sources).toBe(1);
    delete files[GOOD_PATH];
    await catalog.refresh(['/t/KOJO']);
    expect(catalog.stats().sources).toBe(0);
    expect(catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')).toBeNull();
  });

  it('根遍历失败 ⇒ 该根整条跳过并计数（其余根照常），失败在 stats 里可见', async () => {
    const { catalog } = fakeCatalog({ files: { [GOOD_PATH]: GOOD }, failRoots: ['/t/其他'] });
    await catalog.refresh(['/t/其他', '/t/KOJO']);
    expect(catalog.stats().failedRoots).toBe(1);
    expect(catalog.stats().sources).toBe(1);
  });

  it('读失败 ⇒ 那条不写进名录并计数（不拿旧条目冒充现行）', async () => {
    // 替身故意做成"列得到、读不到"：walk 仍返回路径，readTexts 给 null
    const hostile = createKojoFunctionCatalog({
      io: {
        async walkDir() {
          return [{ name: 'A.kojo', path: GOOD_PATH, isDirectory: false, size: GOOD.length, mtimeMs: 1 }];
        },
        async readTexts() {
          return [null];
        },
      } as unknown as Pick<FileIO, 'walkDir' | 'readTexts'>,
      transpile: (source, options) => transpiler.transpile(source, options),
      parseProduct: (text, path) => parseErbText(text, path),
    });
    await hostile.refresh(['/t/KOJO']);
    expect(hostile.stats().failedFiles).toBe(1);
    expect(hostile.stats().sources).toBe(0);
    expect(hostile.locate(resolveSugarTarget(GOOD_PATH)!, 'M_KOJO_K12_问候')).toBeNull();
  });

  it('reset ⇒ 整表清空并回到未就绪（项目切换不带旧坐标）', async () => {
    const { catalog, product } = fakeCatalog({ files: { [GOOD_PATH]: GOOD } });
    await catalog.refresh(['/t/KOJO']);
    catalog.reset();
    expect(catalog.stats().ready).toBe(false);
    expect(catalog.stats().sources).toBe(0);
    expect(catalog.locate(product(GOOD_PATH), 'M_KOJO_K12_问候')).toBeNull();
  });
});
