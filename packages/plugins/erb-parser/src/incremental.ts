/**
 * ERB 索引的**增量**更新（WS-05，2026-10-27；纯函数、零 IO、可单测）。
 *
 * 为什么要有这一层：整树重建（`buildWalkAndParse`）的正确性判据是"walk + stat + 逐文件
 * 读盘"，对"保存一份文件"这种每分钟都在发生的事来说太贵。而索引里真正变化的东西很小：
 * **几份文件的解析结果 + 由它们聚合出来的 byName / 逐文件 mtime,size / 项目指纹**。
 * 其余条目原样留用（对象别名，零拷贝）。
 *
 * 口径：
 * - `removed` 按**前缀**移除（目录删了 / 改了名，其下条目一起退场）——只删"精确那一格"
 *   就会留下指向已不存在文件的幽灵行；
 * - `updated` 逐条覆盖（新路径 = 新增，旧路径 = 替换）；
 * - `byName` 由剩下的 ErbFile **整体重新聚合**：聚合是纯 CPU、一次 O(函数数)，比"增量
 *   修补 byName 的增删"更不容易漂（修补要维护同名多定义的下标与顺序，一处错就是静默错）；
 * - `fingerprint` 按"当前全部条目的 path+mtime+size"重算——下游派生缓存（条件抽取 /
 *   约定校验）以它为失效判据，少算一次就会复用上一份结论；
 * - **`references` 刻意不带**：反向引用边是"当时名录下的可见记号扫描"结果，增量只重扫了
 *   变过的文件，旧边里既有过期的、也有因为新增定义而漏掉的。带着它 = 给"查找引用"答一份
 *   与当前正文不符的名单；不带 = 消费方读到的就是"不可用"（诚实），下一次整扫恢复。
 *   取舍与恢复路径写在 `plugin.ts` 的 `applyFileChanges` 上。
 */

import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { isPathUnder, projectFingerprintOf } from '@kojo/plugin-api';
import { aggregateIndex } from './snapshot';

/** 一份"盘上已读好、已解析好"的文件事实（读盘与解析归调用方：本模块零 IO） */
export interface IncrementalFileUpdate {
  readonly path: string;
  readonly file: ErbFile;
  /** 与快照同源（`readText` 带回）；平台答不出 ⇒ null ⇒ 该文件永远判过期（保守） */
  readonly mtimeMs: number | null;
  /** `stat` 的字节数；取不到 ⇒ null（判据同 `fileMtimes` 的保守方向） */
  readonly size: number | null;
}

export interface IndexDeltaInput {
  /** 当前索引（不修改它：返回的是一份新对象） */
  readonly index: ErbIndex;
  readonly updated: readonly IncrementalFileUpdate[];
  /** 移除的路径（目录按前缀整体移除） */
  readonly removed: readonly string[];
}

export interface IndexDeltaResult {
  readonly index: ErbIndex;
  readonly added: number;
  readonly replaced: number;
  readonly dropped: number;
}

/**
 * 应用一次增量（纯函数）：返回**新索引对象**，输入那份一个字段都不动。
 *
 * 不修改输入是刻意的：消费方（函数树 / 语言服务）可能正持着上一份索引渲染，
 * 原地改 Map 会让"这一帧读到一半、下一帧读到另一半"成为可能。
 */
export function applyIndexDelta(input: IndexDeltaInput): IndexDeltaResult {
  const files = new Map(input.index.files);
  const mtimes = new Map(input.index.fileMtimes ?? []);
  const sizes = new Map(input.index.fileSizes ?? []);
  let dropped = 0;
  for (const gone of input.removed) {
    for (const path of [...files.keys()]) {
      if (!isPathUnder(gone, path)) continue;
      files.delete(path);
      mtimes.delete(path);
      sizes.delete(path);
      dropped++;
    }
  }
  let added = 0;
  let replaced = 0;
  for (const update of input.updated) {
    if (files.has(update.path)) replaced++;
    else added++;
    files.set(update.path, update.file);
    mtimes.set(update.path, update.mtimeMs);
    sizes.set(update.path, update.size);
  }

  // 聚合：以"余下条目的插入序"为准（既有条目在前、新增的按增量顺序追加）——顺序稳定，
  // 同名多定义的次序因此不随增量次数抖动。
  const aggregated = aggregateIndex(files.values());
  const fingerprint = projectFingerprintOf(
    [...aggregated.files.keys()].map((path) => ({
      path,
      mtimeMs: mtimes.get(path) ?? null,
      size: sizes.get(path) ?? null,
    })),
  );
  return {
    index: {
      files: aggregated.files,
      byName: aggregated.byName,
      fingerprint,
      fileMtimes: mtimes,
      fileSizes: sizes,
    },
    added,
    replaced,
    dropped,
  };
}
