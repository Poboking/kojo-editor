/**
 * 盘上增删改名 → **ERB 索引增量更新**的宿主接线（WS-05，2026-10-27）。
 *
 * 改前的形状：`file.changed` 只让解析器 `refreshScanRoots()`（签名没变就什么都不做），
 * 文件树里的新建 / 删除 / 改名**从不**通知索引 ⇒ `index.files` 停在上一轮整扫的样子：
 * 平铺列表与函数树留幽灵行（点开一股"文件不见了"的错味），新建的文件要等下一次整扫
 * 才进 Ctrl+T / 函数树。
 *
 * 本模块补的就是"谁在什么时刻把增量交给解析器"这半条腿，判据两块：
 * 1. **{@link planIndexDelta}（纯函数）**：把宿主给的 `{changed, removed, renamed}` 折成
 *    增量两表。目录改名要按**前缀**把其下已索引的文件映射到新前缀——只交目录那一格，
 *    子路径会全部烂成幽灵行（WS-02 的标签收尾踩过同一条）。
 * 2. **{@link syncErbIndexAfterDiskChange}**：问 `erb.parser` 要 `applyFileChanges`
 *    （契约 additive；旧实现没有 ⇒ 静默跳过，下一次整扫自然跟上）。失败**出声**：
 *    索引是增强面，但它错了就是错的事实，不许静默。
 *
 * 为什么索引为 null 时整趟跳过：没有索引就没有"旧路径"可删、新路径也进不了任何表——
 * 这是"还没建好"，不是"更新失败"（下一次整扫本来就会把盘上现状读进来）。
 */

import type { ErbIndex, ErbParserService } from '@kojo/plugin-api';
import { errorText, isPathUnder, pathKey } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import type { Notify } from './NotificationCenter';

/** 盘上一次改动的三种事实（宿主从文件树 / 标签收尾那里拿到的原样路径） */
export interface DiskDelta {
  /** 新增或内容变了（**文件**路径） */
  readonly changed?: readonly string[] | undefined;
  /** 删掉了（文件**或目录**；目录按前缀整体移除） */
  readonly removed?: readonly string[] | undefined;
  /** 改名 / 移动（目录按前缀整体映射） */
  readonly renamed?: ReadonlyArray<{ from: string; to: string }> | undefined;
}

export interface PlannedIndexDelta {
  /** 需要重读重解析的路径 */
  readonly changed: string[];
  /** 需要移出索引的路径（目录按前缀展开到索引里的实际条目） */
  readonly removed: string[];
}

/** 去掉尾部分隔符（拼前缀映射时 base 只能是"目录本身"这一段） */
function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** `path` 落在 `from` 之下（含本身就是 `from`）时，换成 `to` 之下的同位置路径；否则 null */
function mapUnder(from: string, to: string, path: string): string | null {
  if (!isPathUnder(from, path)) return null;
  const base = stripTrailingSep(from);
  const tail = path.slice(base.length); // 子路径以分隔符开头（isPathUnder 的边界语义保证）；自身 = ''
  return `${stripTrailingSep(to)}${tail}`;
}

/**
 * `{changed, removed, renamed}` → 索引增量的两表（纯函数，可单测）。
 *
 * - `renamed` 的 `from` 整体进 `removed`（解析器按前缀移除，不需要把子路径逐条算出来）；
 * - `renamed` 里**已索引**的每个子路径按前缀映射进 `changed`（新目录下的同名文件要重读）；
 * - 原地改名（`from` 与 `to` 只是写法不同）不算改动——判等走 `pathKey`；
 * - 同一路径只出现一次（`pathKey` 去重），且 `changed` 胜过 `removed`（重读是更保守的动作）。
 */
export function planIndexDelta(indexedPaths: Iterable<string>, delta: DiskDelta): PlannedIndexDelta {
  const indexed = [...indexedPaths];
  const changed = new Map<string, string>();
  const removed = new Map<string, string>();

  for (const path of delta.changed ?? []) {
    if (typeof path === 'string' && path.length > 0 && !changed.has(pathKey(path))) changed.set(pathKey(path), path);
  }
  for (const path of delta.removed ?? []) {
    if (typeof path === 'string' && path.length > 0 && !removed.has(pathKey(path))) removed.set(pathKey(path), path);
  }
  for (const pair of delta.renamed ?? []) {
    const from = pair?.from;
    const to = pair?.to;
    if (typeof from !== 'string' || from.length === 0) continue;
    if (typeof to !== 'string' || to.length === 0) continue;
    if (pathKey(from) === pathKey(to)) continue; // 写法不同的同一条：零动作
    removed.set(pathKey(from), from);
    for (const path of indexed) {
      const mapped = mapUnder(from, to, path);
      if (mapped !== null) changed.set(pathKey(mapped), mapped);
    }
  }

  // 同一条路径两边都有 ⇒ 以"重读"为准（删除是乐观动作，重读读不到会走整扫回退）
  for (const key of changed.keys()) removed.delete(key);
  return { changed: [...changed.values()], removed: [...removed.values()] };
}

/** 增量结果的三种"没做"与一种"做了"（调用方全部静默处理；失败那条由本模块自己出声） */
export type IndexSyncOutcome = 'applied' | 'skipped' | 'unsupported' | 'failed';

export interface IndexSyncInput {
  readonly kernel: Pick<Kernel, 'services'>;
  /** 当前索引（宿主那份读数；null = 还没建好，整趟跳过） */
  readonly index: ErbIndex | null;
  readonly notify: Notify;
  readonly delta: DiskDelta;
}

/**
 * 把一次盘上改动交给解析器做增量（`applyFileChanges`，契约 additive）。
 *
 * 失败**必须出声**：索引错了要么留幽灵行、要么漏函数，作者看到的是"我改了但它不知道"。
 * 解析器内部对读/解析失败本来就会回退整扫（那是它自己的判据）；这里只剩"IPC 级别的
 * 失败 / 版本不匹配"这一层，一句人话把事实说清即可，不重试、不假装成功。
 */
export async function syncErbIndexAfterDiskChange(input: IndexSyncInput): Promise<IndexSyncOutcome> {
  const { kernel, index, notify } = input;
  if (index === null) return 'skipped';
  let service: ErbParserService | undefined;
  try {
    service = kernel.services.tryGet<ErbParserService>('erb.parser') ?? undefined;
  } catch {
    service = undefined; // 服务键缺席（浏览器壳 / 插件未装）：索引本就不存在，零动作
  }
  const apply = service?.applyFileChanges?.bind(service);
  if (apply === undefined) return 'unsupported';
  const plan = planIndexDelta(index.files.keys(), input.delta);
  if (plan.changed.length === 0 && plan.removed.length === 0) return 'skipped';
  try {
    await apply({ changed: plan.changed, removed: plan.removed });
    return 'applied';
  } catch (err: unknown) {
    notify({
      kind: 'error',
      message: `索引增量更新失败：${errorText(err)}（文件本身不受影响；下一次整项目扫描会重建索引）`,
    });
    return 'failed';
  }
}
