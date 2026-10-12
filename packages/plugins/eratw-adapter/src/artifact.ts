/**
 * 制品计划（2026-10-12 导出批；纯函数，零 IO，可单测）。
 *
 * ## 它解决的问题
 *
 * 作者工作区里的包以 `.kojo` 为源（用户反馈 1：新建项目默认 `.kojo`，糖与原生 ERB
 * 可混写），而**引擎只认 `.ERB`**。所以「导出」和「部署」都不能再把目录原样复制出去——
 * 原样复制的包放进游戏目录是**静默不生效**的，比报错更糟。
 *
 * 本模块把"工作区文件集 → 制品文件集"这一步做成一个纯函数，于是：
 * - 导出 ZIP 与部署落盘**共用同一份计划**，不会出现"导出的能跑、部署的不能跑"；
 * - 转译规则、冲突判定、fail-closed 全部可在不启动内核、不碰磁盘的情况下被单测钉住。
 *
 * ## 四条规矩
 *
 * 1. **`.kojo` → `.ERB`**，同目录同基名，规则来自 `resolveSugarTarget`（单一真源，
 *    与"保存 `.kojo` 时产物落在哪"完全同源，不在此另立一套命名）。
 * 2. **非 `.kojo` 一律字节级原样携带**（`.txt` 说明、`.md`、图片、作者手写的 `.ERB`）。
 *    口上库的既有编码经一次转码就可能毁半库——这里刻意不解码不重编码。
 * 3. **制品里绝不出现 `.kojo`**。游戏读不到它，留着只会让作者以为"已经装好了"。
 * 4. **fail-closed**：任何一个 `.kojo` 转译失败 → 整个计划抛错，**不产半成品包**。
 *    半成品包比没有包更危险：作者会以为发布成功了。
 *
 * ## 命名冲突必须拒绝
 *
 * 同目录下同时有 `事件.kojo` 与 `事件.ERB` 时，两者都会落到 `事件.ERB` —— 而它们内容
 * 不同，谁说了算？工具不替作者决定，直接报错让他改名。静默挑一个就是丢东西。
 */

import {
  resolveSugarTarget,
  type FileIO,
  type SugarCompiledBytes,
} from '@kojo/plugin-api';

/** 工作区里的一个源文件（`relPath` 用 `/` 分隔，相对包目录） */
export interface ArtifactSource {
  relPath: string;
  bytes: Uint8Array;
}

/** 制品里的一个文件（`relPath` 已是最终名，`/` 分隔） */
export interface ArtifactEntry {
  relPath: string;
  bytes: Uint8Array;
}

/** 计划结果与统计（反馈文案要能说清"转译了几个、原样带了几个"） */
export interface ArtifactPlan {
  entries: ArtifactEntry[];
  /** 由 `.kojo` 转译而来的文件数 */
  transpiled: number;
  /** 字节级原样携带的文件数 */
  passthrough: number;
}

/** 把 `.kojo` 源文本编成产物字节 —— 由 `SugarTranspileService.compileToBytes` 提供 */
export type KojoCompiler = (source: string, label: string) => SugarCompiledBytes;

/** 相对路径归一：反斜杠 → 正斜杠，去掉首部斜杠（walkDir 各家形态不一） */
export function toRelPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

/** 是否 `.kojo` 源文件（大小写不敏感） */
export function isKojoSource(relPath: string): boolean {
  return /\.kojo$/i.test(relPath);
}

/** 文本解码（`.kojo` 源按 UTF-8 读；带 BOM 时剥掉，避免把 BOM 当正文喂给转译器） */
function decodeSource(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 生成制品计划。
 *
 * @param sources 包目录下的全部源文件（相对路径 + 字节）
 * @param compile `.kojo` → 产物字节（注入，便于单测用替身驱动 fail-closed）
 * @throws Error 命名冲突 / 转译失败（消息为中文，直接呈现给作者）
 */
export function planArtifacts(
  sources: readonly ArtifactSource[],
  compile: KojoCompiler,
): ArtifactPlan {
  const entries: ArtifactEntry[] = [];
  const taken = new Map<string, string>(); // 归一化名 → 来源路径（报冲突时指认另一方）
  let transpiled = 0;
  let passthrough = 0;

  const claim = (relPath: string, from: string): void => {
    // 大小写不敏感去重：Windows 文件系统上 `事件.ERB` 与 `事件.erb` 本就是同一个文件
    const key = relPath.toLowerCase();
    const prev = taken.get(key);
    if (prev !== undefined) {
      throw new Error(`产物名冲突（大小写不敏感）：「${prev}」与「${from}」都会落成 ${relPath}，请改名后再导出。`);
    }
    taken.set(key, from);
  };

  for (const src of sources) {
    const rel = toRelPath(src.relPath);
    if (rel.length === 0) continue;
    if (rel.split('/').includes('..')) {
      throw new Error(`路径逃逸包目录：${rel}`);
    }

    if (!isKojoSource(rel)) {
      claim(rel, rel);
      entries.push({ relPath: rel, bytes: src.bytes });
      passthrough += 1;
      continue;
    }

    // 目标名由单一真源推导；非 .kojo 走到这里不可能，但仍兜一层不静默
    const target = resolveSugarTarget(rel);
    if (target === null) throw new Error(`无法从「${rel}」推导产物文件名。`);
    const relTarget = toRelPath(target);
    // 同目录已有 `事件.ERB` 时，它先占了这个名字 → 这里直接报冲突，不静默二选一
    claim(relTarget, rel);

    let compiled: SugarCompiledBytes;
    try {
      compiled = compile(decodeSource(src.bytes), rel);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`「${rel}」转译失败，未生成制品：${reason}`);
    }
    entries.push({ relPath: relTarget, bytes: compiled.bytes });
    transpiled += 1;
  }

  return { entries, transpiled, passthrough };
}

/**
 * 读取包目录下的全部源文件（本模块**唯一**碰磁盘的函数）。
 *
 * 走 `readBytes` 而不是 `readText`：非 `.kojo` 的文件要**原样字节**进制品，
 * 一旦按文本读就可能被重编码（口上库里既有 UTF-8 也有 Shift-JIS 的辅助文件）。
 */
export async function readPackageSources(io: FileIO, srcDir: string): Promise<ArtifactSource[]> {
  const entries = await io.walkDir(srcDir, { includeFiles: true });
  const sources: ArtifactSource[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const rel = e.path.slice(srcDir.length).replace(/^[\\/]+/, '');
    if (rel.length === 0) continue;
    sources.push({ relPath: toRelPath(rel), bytes: await io.readBytes(e.path) });
  }
  return sources;
}
