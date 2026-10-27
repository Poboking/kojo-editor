/**
 * 「我的口上项目」（工作区 artifact）→ 条件矩阵可消费的函数索引。
 *
 * 与游戏项目索引的差异只有两条，且都在本模块收口：
 *   1. `.kojo` 是语法糖源，**不是** ERB 方言文件（`erb-parser.buildIndex` 明确不索引它），
 *      必须先经 `sugar.transpile` 生成 ERB 再解析；
 *   2. 产物 ERB **从不落盘**，条件抽取不能按路径读盘 ⇒ 抽取索引用生成行号，
 *      同时把生成文本装进 `texts` 覆盖表交给 `extractIndex(index, texts)`。
 *
 * 因此这里产出两份索引：`extractIndex`（生成坐标 + 文本覆盖表）与 `displayIndex`
 * （函数 `startLine` 已折回 `.kojo` 源行）。矩阵只消费 `displayIndex` 的行号，
 * 抽取只消费 `extractIndex` 的区间——两套坐标各归各用，不允许互相混。
 */

import type {
  DirEntry,
  ErbFile,
  ErbFunction,
  ErbIndex,
  ErbParserService,
  FileIO,
  SugarTranspileResult,
  SugarTranspileService,
  TextFile,
} from '@kojo/plugin-api';
import { isErbDialectPath, KOJO_LEGACY_SOURCE_EXTENSION } from '@kojo/plugin-api';

/** 工作区矩阵可读的源文件：kojo1 源 `.kojo1` + ERB 方言（.erb/.erm/.erh） */
export function isWorkspaceMatrixSourceName(name: string): boolean {
  return name.toLowerCase().endsWith(KOJO_LEGACY_SOURCE_EXTENSION) || isErbDialectPath(name);
}

export function isKojoSourceName(name: string): boolean {
  return name.toLowerCase().endsWith(KOJO_LEGACY_SOURCE_EXTENSION);
}

/** 一份待索引的源文件（路径 = 工作区里的绝对路径） */
export interface WorkspaceSourceFile {
  readonly path: string;
  readonly text: string;
}

/** 工作区索引产物（两份坐标系 + 抽取文本覆盖表） */
export interface WorkspaceIndexBundle {
  /** 矩阵/导航用：函数行号已折回源文件；`texts` 之外的内容不承诺 */
  readonly displayIndex: ErbIndex;
  /** 条件抽取用：函数行号是生成 ERB 坐标；正文由 `texts` 提供 */
  readonly extractIndex: ErbIndex;
  /** 路径 → 抽取正文（`.kojo` = 生成 ERB；ERB 方言 = 原文） */
  readonly texts: Map<string, string>;
  readonly kojoFiles: number;
  readonly erbFiles: number;
  /** 未纳入矩阵的文件（.kojo 编译 error / 解析抛错）——面板显式显示，不静默 */
  readonly problems: readonly string[];
}

/**
 * 生成行 → 源行解析器（一个文件建一次索引，供全部函数折回）。
 *
 * 口径：精确命中优先；纯生成行（`@` 头）**向下**取最近有源行，但越过下一个函数头
 * 即放弃（那已经是另一个函数的本体）。`.kojo` 函数数量大时逐函数 `find` + split
 * 是 O(n²)，这里一次建表 + 二分。
 */
export function createSourceLineResolver(
  result: Pick<SugarTranspileResult, 'erb' | 'sourceMap'>,
): (generatedLine: number) => number | null {
  const exact = new Map<number, number | null>();
  for (const entry of result.sourceMap) {
    if (!exact.has(entry.generatedLine)) exact.set(entry.generatedLine, entry.sourceLine);
  }
  const ordered = [...result.sourceMap].sort((a, b) => a.generatedLine - b.generatedLine);
  const lines = result.erb.split('\n');
  return (generatedLine: number): number | null => {
    const hit = exact.get(generatedLine);
    if (hit != null) return hit;
    let lo = 0;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ordered[mid]!.generatedLine <= generatedLine) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < ordered.length; i++) {
      const entry = ordered[i]!;
      if (/^@/.test(lines[entry.generatedLine - 1] ?? '')) return null;
      if (entry.sourceLine !== null) return entry.sourceLine;
    }
    return null;
  };
}

/** 生成行 → 源行（便捷单次版；批量折回请用 `createSourceLineResolver`） */
export function sourceLineOfGenerated(
  result: Pick<SugarTranspileResult, 'erb' | 'sourceMap'>,
  generatedLine: number,
): number | null {
  return createSourceLineResolver(result)(generatedLine);
}

function byNameOf(files: Map<string, ErbFile>): ErbIndex['byName'] {
  const byName = new Map<string, ErbFunction[]>();
  for (const file of files.values()) {
    for (const fn of file.functions) {
      let list = byName.get(fn.normalizedName);
      if (!list) {
        list = [];
        byName.set(fn.normalizedName, list);
      }
      list.push(fn);
    }
  }
  return byName;
}

function emptyBundle(): WorkspaceIndexBundle {
  return {
    displayIndex: { files: new Map(), byName: new Map() },
    extractIndex: { files: new Map(), byName: new Map() },
    texts: new Map(),
    kojoFiles: 0,
    erbFiles: 0,
    problems: [],
  };
}

/**
 * 纯构建（零 IO）：`.kojo` 转译 + 行号折回 + 两份索引。
 *
 * `.kojo` 带 `error` 诊断 ⇒ 整个文件跳过并记入 `problems`（不编译半成品；
 * 与 `sugar.compileToFile` 的 fail-closed 同口径）。
 */
export function buildWorkspaceIndex(
  sources: readonly WorkspaceSourceFile[],
  deps: {
    parseText(text: string, path?: string): ErbFile;
    sugar?: Pick<SugarTranspileService, 'transpile'>;
  },
): WorkspaceIndexBundle {
  const out = emptyBundle();
  const problems: string[] = [];
  let kojoFiles = 0;
  let erbFiles = 0;

  for (const source of sources) {
    if (isKojoSourceName(source.path)) {
      if (!deps.sugar) {
        problems.push(`${source.path}：语法糖服务不可用，未纳入矩阵。`);
        continue;
      }
      let result: SugarTranspileResult;
      try {
        result = deps.sugar.transpile(source.text, { filePath: source.path });
      } catch (err) {
        problems.push(`${source.path}：转译失败——${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) {
        problems.push(`${source.path}：${errors[0]!.message}（共 ${errors.length} 条编译错误，未纳入矩阵）`);
        continue;
      }
      let generated: ErbFile;
      try {
        generated = deps.parseText(result.erb, source.path);
      } catch (err) {
        problems.push(`${source.path}：生成 ERB 解析失败——${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      kojoFiles++;
      out.texts.set(source.path, result.erb);
      out.extractIndex.files.set(source.path, generated);

      const sourceLineOf = createSourceLineResolver(result);
      const displayFunctions: ErbFunction[] = generated.functions.map((fn) => {
        const start = sourceLineOf(fn.startLine) ?? 1;
        const end = sourceLineOf(fn.endLine) ?? start;
        return { ...fn, startLine: start, endLine: Math.max(start, end) };
      });
      out.displayIndex.files.set(source.path, {
        ...generated,
        functions: displayFunctions,
        lineCount: source.text.split('\n').length,
      });
      continue;
    }

    let parsed: ErbFile;
    try {
      parsed = deps.parseText(source.text, source.path);
    } catch (err) {
      problems.push(`${source.path}：解析失败——${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    erbFiles++;
    out.texts.set(source.path, source.text);
    out.extractIndex.files.set(source.path, parsed);
    out.displayIndex.files.set(source.path, parsed);
  }

  out.extractIndex.byName = byNameOf(out.extractIndex.files);
  out.displayIndex.byName = byNameOf(out.displayIndex.files);
  return { ...out, kojoFiles, erbFiles, problems };
}

/** 列目录 + 批量读（真实链路；测试可只测上面的纯构建） */
export async function loadWorkspaceSources(
  io: Pick<FileIO, 'walkDir' | 'readTexts'>,
  rootPath: string,
): Promise<WorkspaceSourceFile[]> {
  const entries = await io.walkDir(rootPath, {
    includeFiles: true,
    includeDirs: false,
    filter: (entry: DirEntry) => !entry.isDirectory && isWorkspaceMatrixSourceName(entry.name),
  });
  const paths = entries.map((e) => e.path);
  if (paths.length === 0) return [];
  const read = await io.readTexts(paths);
  const out: WorkspaceSourceFile[] = [];
  for (let i = 0; i < paths.length; i++) {
    const file: TextFile | null | undefined = read[i];
    if (!file) continue;
    out.push({ path: paths[i]!, text: file.text });
  }
  return out;
}

/** 便捷封装：真实 IO + 解析器 + 糖转译服务 → 两份索引 */
export async function loadWorkspaceIndex(
  deps: {
    io: Pick<FileIO, 'walkDir' | 'readTexts'>;
    parser: Pick<ErbParserService, 'parseText'>;
    sugar?: Pick<SugarTranspileService, 'transpile'>;
  },
  rootPath: string,
): Promise<WorkspaceIndexBundle> {
  const sources = await loadWorkspaceSources(deps.io, rootPath);
  return buildWorkspaceIndex(sources, {
    parseText: (text, path) => deps.parser.parseText(text, path),
    ...(deps.sugar ? { sugar: deps.sugar } : {}),
  });
}
