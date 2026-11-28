/**
 * WP-3a：`project.reload` 的消费方**真正增量重建**（2026-11-28）。
 *
 * WP-3b 的钩子（`createS1SnapshotReloadHook`）只读一趟 `snapshot()` 拿 generation 算同源
 * stamp —— 它**什么都没重建**，`reusedSnapshot:true` 的实际含义是「我没干活，但我证明我看的是
 * 同一份快照」。账本因此只能证明「换代请求到了」，证明不了「消费方跟上了」。
 *
 * 本模块补后半句：把新根的文件清单与现有索引做差，**只把变过的那些喂回索引**
 * （未变的只比对文本、一次都不调 `updateFile`），消失的移除，然后回一份**可自证**的回执：
 *
 *   `generationAfter - generationBefore === added + updated + removed`
 *
 * 这条等式就是「重建真的发生了、且只做了它宣称的那些事」的机械证据——并发改动会让它对不上，
 * 于是回执被判 `unverified`（不乐观报完成）。判据见
 * `packages/app/tests/mcp-project-reload-rebuild.test.ts`。
 *
 * 接缝全部注入（`ReloadRebuildSeams`）：本模块**不认识** Monaco / 内核 / fs，
 * 生产侧把真索引的 `getFile` / `updateFile` / `removeFile` 与内核的列目录 / 读文件接进来，
 * 测试侧用真索引 + 假盘。动态 import 装载，不给 ps10 开机静态图加边。
 */
import type { ProjectReloadRequest, ProjectReloadResult, S1SnapshotLike } from './project-reload';
import { sourceStampOf } from './project-reload';

/** 一份文件在索引里的最小读数面（只用来比对文本，不暴露内部结构）。 */
export interface IndexedFileLike {
  readonly text: string;
}

/** 重建用的注入接缝。全部必需，**不提供默认实现**——缺一条就装不起来，而不是悄悄退化成全量重扫。 */
export interface ReloadRebuildSeams {
  /** 索引快照（同源 stamp 与自证都取自它）。 */
  snapshot(): S1SnapshotLike;
  /** 索引当前持有的路径。 */
  files(): readonly string[];
  /** 索引里某一份文件的读数（用于「内容没变就不喂」）。 */
  getFile(path: string): IndexedFileLike | undefined;
  /** 新根的文件清单（生产＝内核列目录 + 扩展名过滤；测试＝假盘）。 */
  listTargets(request: ProjectReloadRequest): Promise<readonly string[]>;
  /** 读一份文件正文；读不到 ⇒ `null`（计 `failed`，不静默跳过）。 */
  readText(path: string): Promise<string | null>;
  /**
   * 批量读（可选）。给了就**一次性取齐**（生产＝内核 `io.readTexts`，一个 IPC），
   * 逐份 `readText` 只在它缺席时兜底。数组与入参一一对应，读不到的位为 `null`。
   */
  readMany?(paths: readonly string[]): Promise<readonly (string | null)[]>;
  /** 喂索引；解析失败时真索引回 `undefined`（计 `failed`，不假装成功）。 */
  updateFile(input: { readonly path: string; readonly text: string }): unknown;
  /** 移除一份；真移掉了才 `true`。 */
  removeFile(path: string): boolean;
  /**
   * 自报「这一趟其实是整表重扫」（例如宿主走了另一条冷启路径）。
   * 缺省 `false`＝增量。自报 true 时回执的 `reusedSnapshot` 必须是 false——**不许把重扫说成增量**。
   */
  rescannedAll?(): boolean;
}

/**
 * 建一枚**增量重建**钩子。
 *
 * 与 WP-3b 那枚的区别只有一句：它真的动了索引，并且把「动了什么」写进回执。
 * 失败（列目录抛错 / 读盘抛错）一律回 `failure` + 零 `rebuilt`，由 `verifyReloadReceipt` 判红。
 *
 * **按 trigger 分两种动作**（这一条不能省，省了就做错事）：
 *  - `returned`（快切回旧档 ⇒ 该目录**正在成为当前项目**）：按新根做增量重建——
 *    读该根的文件清单、只喂变过的、把不属于该根的残留移掉。
 *  - `evicted`（驻留上限逐出档案 ⇒ 该目录**已经不在驻留集**）：**只清残留、不重建**。
 *    给它重建等于把一个已经离开的项目灌回索引，比不做更坏。
 *  - 其它 trigger 按 `returned` 处理（新根可用即重建）。
 */
export function createS1IncrementalReloadHook(seams: ReloadRebuildSeams) {
  return async (request: ProjectReloadRequest): Promise<ProjectReloadResult> => {
    const started = performance.now();
    const base = {
      rootId: request.rootId,
      rootDir: request.rootDir,
      sourceStamp: '',
      reusedSnapshot: false,
    };
    const generationBefore = seams.snapshot().generation;

    // 逐出档案：只清该根残留，一次盘 IO 都不做（不该为「离开」付「进入」的代价）。
    if (request.trigger === 'evicted') {
      const current = seams.files();
      let removed = 0;
      for (const path of current) {
        if (!isUnder(path, request.rootDir)) continue;
        if (seams.removeFile(path)) removed += 1;
      }
      const generation = seams.snapshot().generation;
      return {
        rootId: request.rootId,
        rootDir: request.rootDir,
        generation,
        generationBefore,
        sourceStamp: sourceStampOf(request.rootId, generation),
        reusedSnapshot: !(seams.rescannedAll?.() ?? false),
        rebuilt: { mode: 'prune', added: 0, updated: 0, removed, unchanged: 0, failed: 0 },
        elapsedMs: performance.now() - started,
      };
    }

    let targets: readonly string[];
    try {
      targets = await seams.listTargets(request);
    } catch (err) {
      return {
        ...base,
        generation: generationBefore,
        generationBefore,
        elapsedMs: performance.now() - started,
        failure: `列出目标文件失败：${errText(err)}`,
      };
    }

    const targetSet = new Set(targets);
    const current = new Set(seams.files());
    let added = 0;
    let updated = 0;
    let removed = 0;
    let unchanged = 0;
    let failed = 0;

    try {
      // 一次性把正文取齐（生产＝内核批量读，一个 IPC；缺席才逐份读）。
      const texts = seams.readMany ? await seams.readMany(targets) : null;
      for (let i = 0; i < targets.length; i += 1) {
        const path = targets[i]!;
        const text = texts ? texts[i] ?? null : await seams.readText(path);
        if (text === null) {
          failed += 1;
          continue;
        }
        const existing = current.has(path) ? seams.getFile(path) : undefined;
        if (existing && existing.text === text) {
          unchanged += 1;
          continue;
        }
        const written = seams.updateFile({ path, text });
        if (written === undefined) {
          failed += 1;
          continue;
        }
        if (existing) updated += 1;
        else added += 1;
      }
      // 不属于新根的残留（上一个项目留下的）在这里一次性清掉——没人别的地方会清。
      for (const path of current) {
        if (targetSet.has(path)) continue;
        if (seams.removeFile(path)) removed += 1;
      }
    } catch (err) {
      return {
        ...base,
        generation: generationBefore,
        generationBefore,
        elapsedMs: performance.now() - started,
        failure: `重建中断：${errText(err)}`,
      };
    }

    const generation = seams.snapshot().generation;
    return {
      rootId: request.rootId,
      rootDir: request.rootDir,
      generation,
      generationBefore,
      sourceStamp: sourceStampOf(request.rootId, generation),
      // 自报整表重扫时不许声称「复用」；这是唯一一处允许它变 false 的地方。
      reusedSnapshot: !(seams.rescannedAll?.() ?? false),
      rebuilt: { mode: 'rebuild', added, updated, removed, unchanged, failed },
      elapsedMs: performance.now() - started,
    };
  };
}

/**
 * `path` 是否在 `root` 之下。只做**字面前缀 + 分隔符边界**判断（两个值都来自同一台宿主，
 * 分隔符一致）；不做 `..` 归一——索引里的路径来自内核扫描，不是外部输入。
 */
function isUnder(path: string, root: string): boolean {
  if (root === '') return false;
  if (path === root) return false;
  return path.startsWith(root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`) ||
    path.startsWith(`${root}\\`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
