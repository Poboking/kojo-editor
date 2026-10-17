import type { ErbFile, FileIO, Logger, SugarTranspileOptions, SugarTranspileResult } from '@kojo/plugin-api';
import { pathKey, resolveSugarTarget } from '@kojo/plugin-api';
import { foldGeneratedLine } from './langsvc';

/**
 * `.kojo` 源文件的**函数名录**（W6，2026-10-17）——"这个产物函数住在哪份 `.kojo` 的第几行"。
 *
 * ## 为什么要有它（而不是直接问项目索引）
 *
 * 项目索引（`ErbIndex`）看得到编译产物 `.ERB`，看不到 `.kojo` 源：产物里的行号是
 * **派生文本**的行号，而作者要的落点是他能改的那一份。把产物位置换成源位置只有糖线
 * 做得来——它手里同时有源文本、转译结果与源映射。
 *
 * ## 判据零第二份
 *
 * - 「什么是一个函数定义」⇒ `erb.parser`.`parseText`（解析器服务，经 DI 取，不 import 它）；
 * - 「产物行怎么折回源行」⇒ {@link foldGeneratedLine}（与行上注解 / 转到定义同一条规则）；
 * - 「函数名怎么归一」⇒ `ErbFunction.normalizedName`（契约：大写，Emuera 名大小写不敏感）；
 * - 「这份文件是不是 `.kojo` 源」⇒ `resolveSugarTarget`（唯一判据，不另写扩展名正则）。
 *
 * 本模块只新增两件事：**发现**哪些文件是 `.kojo`（列目录），以及按 `size`+`mtime`
 * 决定某份要不要重算。
 *
 * ## 读盘只在名录构建里，不在 `provide` 里
 *
 * 契约的纯函数纪律（`EditorLanguageServiceContribution`）不许语言服务应答读盘，所以名录
 * 由 `project.opened` / `file.changed` 在事件里异步建好，`provide` 只查这张内存表——
 * 与 `erb-parser` 的索引同款（它的 `buildIndex` 也只在事件里读盘）。
 * 一次构建 = 每根一次 `walkDir` + 一批 `readTexts`（会话级 mtime+size 缓存命中即零往返）
 * + 每份待重算的 `.kojo` 一次转译（转译器自带共享缓存）。`.kojo` 是作者手写的量级，
 * 与方言全集（数千份）不同阶；未变过的文件靠 `size`+`mtime` 整份跳过。
 *
 * ## 失败面（铁律 4：退化可见，不静默、不猜）
 *
 * - 根目录遍历失败 ⇒ 该根整条跳过并 `warn`（计入 `stats().failedRoots`）；
 * - 单文件读失败 ⇒ 跳过并计数；
 * - 转译产 `error` ⇒ 那份**一条都不收**（半成品当名录 = 把不存在的函数报给作者）；
 * - 函数头折不回源行 ⇒ 只丢那一个函数；
 * - 未就绪 ⇒ 消费方答 `undefined`（不答 ≠ 没有）。
 */

/** 一个 `.kojo` 产出的一处的定义（源坐标） */
export interface KojoFunctionSite {
  /** 源文件绝对路径（`.kojo`） */
  readonly sourcePath: string;
  /** 定义在源文件里的行（1 基；作者正在编辑的那份缓冲区的坐标系） */
  readonly line: number;
}

/** 名录依赖（全部由装配层注入；本模块零内核知识、零游戏知识） */
export interface KojoFunctionCatalogDeps {
  /** 内核 io（只用读侧两法；游戏目录只读 ⇒ 本名录永不写盘） */
  io: Pick<FileIO, 'walkDir' | 'readTexts'>;
  /** 本包 `sugar.transpile`（当前 adapter 代际，含共享结果缓存） */
  transpile(source: string, options?: SugarTranspileOptions): SugarTranspileResult;
  /** `erb.parser`.`parseText`（「什么是函数定义」的单一真源；缺席时装配层根本不建名录） */
  parseProduct(text: string, path: string): ErbFile;
  /** 可选日志（根失败 / 转译失败都是 `warn` 级） */
  log?: Logger;
}

/** 名录读数（诊断与面板用它说清"候选为什么少"，不在结果里编数） */
export interface KojoFunctionCatalogStats {
  /** 至少完成过一轮刷新 */
  readonly ready: boolean;
  readonly sources: number;
  readonly functions: number;
  readonly failedRoots: number;
  readonly failedFiles: number;
  /** 本轮靠 `size`+`mtime` 整份复用（没有重转译）的文件数 */
  readonly reused: number;
}

interface SourceEntry {
  /** 构建时看到的字节数（`walkDir({withMetadata})`；取不到 = null ⇒ 下轮必重算） */
  size: number | null;
  /** 同上 mtime（epoch ms；null = 未知，保守重算） */
  mtimeMs: number | null;
  /** 归一化函数名 → 源坐标 */
  readonly sites: Map<string, KojoFunctionSite>;
}

interface FoundFile {
  readonly path: string;
  readonly size: number | null;
  readonly mtimeMs: number | null;
}

export interface KojoFunctionCatalog {
  /** 全量刷新：按根发现 `.kojo`，逐份算函数源坐标（`size`+`mtime` 未变即整份复用） */
  refresh(roots: readonly string[]): Promise<void>;
  /** 某份文件变脏（`file.changed`）⇒ 立刻摘掉它的条目，下一轮重算这一份 */
  invalidate(path: string): void;
  /** 项目关闭 ⇒ 整表清空并回到未就绪（旧项目的坐标一条不许留给新项目） */
  reset(): void;
  /** 产物路径 + 函数名（原样，内部按契约归一）→ 源坐标；证不了 → `null`（**不猜**） */
  locate(productPath: string, name: string): KojoFunctionSite | null;
  stats(): KojoFunctionCatalogStats;
}

/** 复用判据：两处 `size`/`mtime` 都取得到且逐字相等才算没变（任一为 null ⇒ 重算） */
function unchanged(seen: SourceEntry | undefined, found: FoundFile): boolean {
  if (seen === undefined) return false;
  return seen.size === found.size && seen.size !== null && seen.mtimeMs === found.mtimeMs;
}

export function createKojoFunctionCatalog(deps: KojoFunctionCatalogDeps): KojoFunctionCatalog {
  const { io, transpile, parseProduct, log } = deps;

  /** 源路径（`pathKey` 归一）→ 条目 */
  const sources = new Map<string, SourceEntry>();
  /** 产物路径（`pathKey` 归一）→ 所属源条目（`locate` 查的就是这张） */
  const byProduct = new Map<string, SourceEntry>();

  let ready = false;
  let generation = 0;
  let failedRoots = 0;
  let failedFiles = 0;
  let reused = 0;
  const dirty = new Set<string>();

  /** 源条目整条摘掉，并带走它名下的产物键（`byProduct` 存的是同一个对象引用） */
  const forget = (sourceKey: string): void => {
    const entry = sources.get(sourceKey);
    sources.delete(sourceKey);
    if (entry === undefined) return;
    for (const [productKey, owner] of [...byProduct]) {
      if (owner === entry) byProduct.delete(productKey);
    }
  };

  /** 一份 `.kojo` 源文本 → 函数源坐标表；证不了的部分一律不收（返回 null = 整份不收） */
  const sitesOf = (sourcePath: string, text: string): Map<string, KojoFunctionSite> | null => {
    const productPath = resolveSugarTarget(sourcePath);
    if (productPath === null) return null; // 调用方已筛过；这里只是类型收窄
    let result: SugarTranspileResult;
    try {
      result = transpile(text, { filePath: sourcePath });
    } catch (e: unknown) {
      log?.warn(`[kojo-function-catalog] 转译失败，整份不收：${sourcePath}（${e instanceof Error ? e.message : String(e)}）`);
      return null;
    }
    if (result.diagnostics.some((d) => d.severity === 'error')) return null; // 半成品不当名录
    let product: ErbFile;
    try {
      product = parseProduct(result.erb, productPath);
    } catch (e: unknown) {
      log?.warn(`[kojo-function-catalog] 产物解析失败，整份不收：${productPath}（${e instanceof Error ? e.message : String(e)}）`);
      return null;
    }
    const sites = new Map<string, KojoFunctionSite>();
    for (const fn of product.functions) {
      const line = foldGeneratedLine(result, fn.startLine);
      if (line === null) continue; // 折不回源行 = 证不了它在哪 ⇒ 不收（收了就是把作者领错地方）
      sites.set(fn.normalizedName, { sourcePath, line });
    }
    return sites;
  };

  return {
    async refresh(roots: readonly string[]): Promise<void> {
      const myGeneration = ++generation;
      let localFailedRoots = 0;
      let localFailedFiles = 0;
      let localReused = 0;

      const found = new Map<string, FoundFile>();
      for (const root of roots) {
        try {
          const entries = await io.walkDir(root, {
            includeFiles: true,
            includeDirs: false,
            withMetadata: true,
            // 判据只用 `resolveSugarTarget`（「这份文件是不是 `.kojo` 源」的唯一真源）；
            // 另写一条扩展名正则就是第二份谓词——"保存认得、名录不认得"那类鬼故事的成因。
            filter: (entry) => entry.isDirectory || resolveSugarTarget(entry.name) !== null,
          });
          for (const entry of entries) {
            if (entry.isDirectory) continue;
            if (resolveSugarTarget(entry.name) === null) continue; // 桥未兑现 filter 时的兜底筛
            found.set(pathKey(entry.path), { path: entry.path, size: entry.size ?? null, mtimeMs: entry.mtimeMs ?? null });
          }
        } catch (e: unknown) {
          localFailedRoots++;
          log?.warn(`[kojo-function-catalog] 根目录遍历失败，本根整条跳过：${root}（${e instanceof Error ? e.message : String(e)}）`);
        }
        if (myGeneration !== generation) return; // 项目换代：本轮作废，旧路径一条不许写进新表
      }

      // 盘上已不在的名录整条带走（删除 / 移走的文件不许继续当候选）
      for (const key of [...sources.keys()]) {
        if (!found.has(key)) forget(key);
      }

      const todo: Array<[string, FoundFile]> = [];
      for (const [key, info] of found) {
        if (!dirty.has(key) && unchanged(sources.get(key), info)) {
          localReused++;
          continue;
        }
        todo.push([key, info]);
      }
      if (todo.length > 0) {
        const texts = await io.readTexts(todo.map(([, info]) => info.path));
        if (myGeneration !== generation) return;
        for (let i = 0; i < todo.length; i++) {
          const [key, info] = todo[i]!;
          const file = texts[i];
          dirty.delete(key);
          if (!file) {
            localFailedFiles++;
            forget(key); // 读不到 ⇒ 上一轮条目也已过期，整条摘掉（不把旧坐标当现行）
            continue;
          }
          const sites = sitesOf(info.path, file.text);
          if (sites === null) {
            forget(key);
            continue;
          }
          const entry: SourceEntry = { size: info.size, mtimeMs: info.mtimeMs, sites };
          sources.set(key, entry);
          const productPath = resolveSugarTarget(info.path);
          if (productPath !== null) byProduct.set(pathKey(productPath), entry);
        }
      }

      failedRoots = localFailedRoots;
      failedFiles = localFailedFiles;
      reused = localReused;
      ready = myGeneration === generation;
    },

    invalidate(path: string): void {
      const key = pathKey(path);
      dirty.add(key);
      forget(key);
    },

    reset(): void {
      generation++;
      ready = false;
      sources.clear();
      byProduct.clear();
      dirty.clear();
      failedRoots = 0;
      failedFiles = 0;
      reused = 0;
    },

    locate(productPath: string, name: string): KojoFunctionSite | null {
      const entry = byProduct.get(pathKey(productPath));
      if (!entry) return null;
      return entry.sites.get(name.toUpperCase()) ?? null; // 归一 = 契约 `normalizedName` 口径（大写）
    },

    stats(): KojoFunctionCatalogStats {
      let functions = 0;
      for (const entry of sources.values()) functions += entry.sites.size;
      return { ready, sources: sources.size, functions, failedRoots, failedFiles, reused };
    },
  };
}
