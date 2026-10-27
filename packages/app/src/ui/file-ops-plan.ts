/**
 * 文件操作的**计划层**（WS-13 2a 车 · 剪贴板家族的判据；零 IO、零 React、零 DOM）。
 *
 * ## 为什么先要这么一层
 *
 * 「把这几份东西搬到那个文件夹里」听起来是一句话，实际上是一次**判决**：哪几份能动、
 * 动到哪一格叫什么名、撞名的怎么办。判据若长在组件里，就只能靠"把浏览器开起来点一遍"
 * 来证明，而这一层里全是会被点错的边界（目录拖进自己里面、同名目标是个目录、
 * 源与目标分属两个根）。所以照 `file-tree-ops` / `file-tree-reveal` 的既有形态：
 * **判据住纯函数、组件只接线、全部边界靠单证**。
 *
 * ## 输入 = 现场三件 + 一条决定
 *
 * 源集合（树的多选集，或焦点行那一格）、目标目录、**目标目录的现状清单**。
 * 现状清单故意由调用侧给（树里已经有 `dirCache`，不必再打一次盘）；给不全也不致命——
 * 落地那一步走独占创建（`create_file_exclusive` / `create_dir_exclusive`），
 * "检查不存在→再写"的竞态在 OS 层就被关掉了，本层的判据只负责**提前把话说清楚**。
 *
 * ## 非法源（一律 `rejected`，逐条带人话原因）
 *
 * 1. 目标目录就是源自己，或目标落在源的子树里（把文件夹放进它自己的里面）；
 * 2. 粘贴意图下，源就在目标目录里（把它搬给它自己——要同层副本请走「创建副本」）；
 * 3. 源与目标不在同一个根里（跨根搬运这一版不做；出项目的通道只有导出）；
 * 4. 同名目标的**种类**与源不符（文件不能盖在目录上，目录也不能盖在文件上）。
 *
 * ## 冲突的四种应对
 *
 * `skip`（跳过这一条）/ `overwrite`（覆盖，只给文件）/ `keepBoth`（保留两者，
 * 自动改名成「名字 2.扩展名」）/ `cancel`（全部取消，一条都不落）。
 * 目录**不给覆盖**：整目录覆盖等于吃掉对面那一整棵子树，风险面与逐文件覆盖不是一件事，
 * 本车不做——它在覆盖决定下进 `refused` 并点名，绝不静默降级成别的语义。
 */
import { baseName } from './file-tree-model';
import { isUnderPath, joinPath, parentDir, pkey } from './file-tree-ops';

/* ------------------------------ 形态 ------------------------------ */

/** 复制 = 源留在原地；剪切 = 落定后源要走（落地腿走 rename，见 `file-ops-exec`） */
export type FileOpMode = 'copy' | 'move';

/**
 * 意图：`paste` = 剪贴板落地（同层粘贴算非法）；`duplicate` = 原地创建副本
 * （同层是它的**本义**：放开"不许粘进父目录"那条，反过来要求源必须就在这一格里——
 * 跨格的"副本"落点含义不清，与其猜不如判掉并说清）。
 */
export type FileOpIntent = 'paste' | 'duplicate';

/** 一条盘上条目（路径 + 是不是目录） */
export interface FileOpEntry {
  readonly path: string;
  readonly isDir: boolean;
}

/** 撞名时的单项应对（`cancel` 是全局决定，不在这里） */
export type ConflictAction = 'skip' | 'overwrite' | 'keepBoth';

/** 一次粘贴/副本冲突的整体决定 */
export type ConflictDecision = ConflictAction | 'cancel';

export type PlanItemStatus = 'ready' | 'conflict' | 'rejected';

export interface FileOpsPlanInput {
  /** 源条目集合（树的真源：多选集非空时是它，否则是焦点行那一格） */
  readonly sources: readonly FileOpEntry[];
  /** 目标目录（绝对路径；空串 = 没有落点） */
  readonly targetDir: string;
  /** 目标目录现状清单（名字与种类都来自这里；取不到 ⇒ 传空数组） */
  readonly targetEntries: readonly FileOpEntry[];
  readonly mode: FileOpMode;
  readonly intent?: FileOpIntent;
  /**
   * 参与跨根判定的根清单（项目根 + 工作区各根 + 附加根）。
   *
   * **缺省 = 空 = 不做跨根判定**（宿主没给根信息时不瞎判，additive 纪律）；
   * 给了就逐条按"源与目标是否落在同一个根里"判（嵌套根取最长前缀）。
   */
  readonly roots?: readonly string[];
}

export interface PlanItem {
  readonly from: string;
  /** 显示与点名用的条目名（源自己的名字；自动改名时不改这一格） */
  readonly name: string;
  readonly isDir: boolean;
  /** 建议落点（`rejected` 时只是"本来要落的地方"，不参与执行） */
  readonly to: string;
  readonly status: PlanItemStatus;
  /** 冲突项**可选**的应对（不含 `cancel`，那是全局的）；非冲突项恒为空数组 */
  readonly actions: readonly ConflictAction[];
  /** 冲突项的自动改名落点（`keepBoth` 用；一个空位都找不到时没有这一格） */
  readonly renameTo?: string;
  /** 人话原因：`rejected` 必填；冲突项在自动改名也没位置时给 */
  readonly reason?: string;
}

export interface FileOpsPlan {
  readonly targetDir: string;
  readonly mode: FileOpMode;
  readonly intent: FileOpIntent;
  readonly items: readonly PlanItem[];
}

/** 一条要落地的操作（`overwrite` = 落点当前有同名条目，按决定要盖掉它） */
export interface RunOp {
  readonly from: string;
  readonly to: string;
  readonly isDir: boolean;
  readonly mode: FileOpMode;
  readonly overwrite: boolean;
}

export interface DecidedOps {
  /** `cancel` 决定：一条都不落，调用侧不必再问第二次 */
  readonly abort: boolean;
  readonly runs: readonly RunOp[];
  /** 被"跳过"决定吞掉的条目名（仍要上屏计数，不许悄悄消失） */
  readonly skipped: readonly string[];
  /** 逐条点名拒绝（非法源 + 目录撞名却选了覆盖 + 自动改名没位置） */
  readonly refused: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/* ------------------------------ 取名小工具 ------------------------------ */

/** 拆「名字 + 扩展名」：最后一个点开头的部分算扩展名；目录与无扩展名 ⇒ 扩展名为空 */
export function splitBaseExt(name: string, isDir: boolean): { base: string; ext: string } {
  if (isDir) return { base: name, ext: '' };
  const i = name.lastIndexOf('.');
  // 开头的点（`.gitignore`）不算扩展名分隔位：整个名字就是"名字"那一段
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

/** 「保留两者」的自动改名上界（1..上限；上限内全被占就如实说没有位置） */
export const KEEP_BOTH_LIMIT = 99;

/**
 * 「保留两者」的新条目名（纯函数）：`名字 2.扩展名`，被占就依次 3、4……
 * `taken` 是**目标目录里已占用的名字**（按 `pkey` 归一判等）。找不到空位返回 `undefined`。
 */
export function keepBothName(
  name: string,
  isDir: boolean,
  taken: ReadonlySet<string>,
): string | undefined {
  const { base, ext } = splitBaseExt(name, isDir);
  for (let n = 2; n <= KEEP_BOTH_LIMIT; n++) {
    const candidate = `${base} ${n}${ext}`;
    if (!taken.has(pkey(candidate))) return candidate;
  }
  return undefined;
}

/* ------------------------------ 归属（跨根判定） ------------------------------ */

/**
 * 这条路径落不落进某个根里（分隔符 / 大小写归一后按 `isUnderPath` 判，含根本身）。
 *
 * 跨根判据用的是「**存在一个根同时装得下源与落点**」而不是"两边各自归谁"：
 * 附加根常常就嵌在项目根之下（`C:/game/作者作品`），按最长前缀各归各的会把
 * 同一片盘上的合法搬运误判成跨根。
 */
function inRoot(roots: readonly string[], path: string): boolean {
  return roots.some((r) => isUnderPath(r, path));
}

/* ------------------------------ 计划 ------------------------------ */

/**
 * 逐条判决（纯函数，全部边界靠单证）。
 *
 * 顺序即优先级：**先判非法（rejected），再判撞名（conflict），最后才是可执行（ready）**——
 * 非法源不该拿到"覆盖还是跳过"这种选项，撞了名也不该被画成可直接执行。
 */
export function buildFileOpsPlan(input: FileOpsPlanInput): FileOpsPlan {
  const intent: FileOpIntent = input.intent ?? 'paste';
  // 副本的本义就是"在原地再落一份"，故模式恒为复制
  const mode: FileOpMode = intent === 'duplicate' ? 'copy' : input.mode;
  const targetDir = input.targetDir.replace(/\s+/g, ' ').trim();
  const roots = input.roots ?? [];

  /** 目标目录现状：按**名字**归一键索引（同名条目在同一个目录里不可能有两个） */
  const taken = new Map<string, FileOpEntry>();
  for (const e of input.targetEntries) {
    const name = baseName(e.path);
    if (name !== '') taken.set(pkey(name), e);
  }

  const items: PlanItem[] = [];
  const seen = new Set<string>();
  for (const src of input.sources) {
    const name = baseName(src.path);
    if (name === '' || name === '.' || name === '..') {
      items.push({
        from: src.path,
        name: src.path,
        isDir: src.isDir,
        to: src.path,
        status: 'rejected',
        actions: [],
        reason: '这一条读不出条目名称，不能搬运。',
      });
      continue;
    }
    const key = pkey(src.path);
    if (seen.has(key)) continue; // 同一份东西被两种写法交了两次：只处理一次
    seen.add(key);

    const target = joinPath(targetDir, name);
    const illegal = rejectReason({ src, name, targetDir, intent, roots });
    if (illegal !== null) {
      items.push({ from: src.path, name, isDir: src.isDir, to: target, status: 'rejected', actions: [], reason: illegal });
      continue;
    }

    const hit = taken.get(pkey(name));
    if (hit !== undefined && hit.isDir !== src.isDir) {
      const kindWord = hit.isDir ? '文件夹' : '文件';
      items.push({
        from: src.path,
        name,
        isDir: src.isDir,
        to: target,
        status: 'rejected',
        actions: [],
        reason: `同名的「${name}」在那里是一个${kindWord}，${src.isDir ? '文件夹' : '文件'}盖不到它上面。`,
      });
      continue;
    }

    if (hit !== undefined) {
      // 撞名（副本意图下这个同名条目通常就是源自己，同样算撞名）
      const occupied = new Set<string>([...taken.keys()]);
      const alt = keepBothName(name, src.isDir, occupied);
      const item: PlanItem = {
        from: src.path,
        name,
        isDir: src.isDir,
        to: target,
        status: 'conflict',
        // 目录**不给覆盖**（整目录覆盖 = 吃掉对面那一整棵子树），见模块头
        actions: alt === undefined
          ? (src.isDir ? ['skip'] : ['skip', 'overwrite'])
          : src.isDir
            ? ['skip', 'keepBoth']
            : ['skip', 'overwrite', 'keepBoth'],
        ...(alt === undefined
          ? { reason: `自动改名的名字（${name} 2 … ${name} ${KEEP_BOTH_LIMIT}）也全被占着，先腾出一个位置再粘贴。` }
          : {}),
        ...(alt === undefined ? {} : { renameTo: joinPath(targetDir, alt) }),
      };
      items.push(item);
      // 本批里前面已排定的落点也占位：同一目录粘两份同名文件不该给出同一个自动改名名
      taken.set(pkey(name), { path: target, isDir: src.isDir });
      if (item.renameTo !== undefined) {
        taken.set(pkey(baseName(item.renameTo)), { path: item.renameTo, isDir: src.isDir });
      }
      continue;
    }

    items.push({ from: src.path, name, isDir: src.isDir, to: target, status: 'ready', actions: [] });
    taken.set(pkey(name), { path: target, isDir: src.isDir });
  }

  return { targetDir, mode, intent, items };
}

/** 非法源判据（返回人话原因；合法 ⇒ null）。顺序即优先级。 */
function rejectReason(args: {
  src: FileOpEntry;
  name: string;
  targetDir: string;
  intent: FileOpIntent;
  roots: readonly string[];
}): string | null {
  const { src, name, targetDir, intent, roots } = args;
  if (targetDir === '') return '没有明确的落点目录——先把焦点落到一个文件夹（或作者包）上，再粘贴。';
  if (pkey(src.path) === pkey(targetDir)) {
    return `「${name}」不能粘贴进它自己里面——目标目录就是它本身。`;
  }
  if (src.isDir && isUnderPath(src.path, targetDir)) {
    return `「${name}」不能放进它自己的子目录里——绕不开这个圈。`;
  }
  if (intent === 'paste' && pkey(parentDir(src.path)) === pkey(targetDir)) {
    return `「${name}」本来就在这一格里，粘贴进来等于把它搬给它自己——要同层副本请用「创建副本」。`;
  }
  if (intent === 'duplicate' && pkey(parentDir(src.path)) !== pkey(targetDir)) {
    return `副本就在条目自己那一格里：「${name}」不在这一格，请只选中同一个文件夹里的条目再创建副本。`;
  }
  if (roots.length > 0) {
    if (!inRoot(roots, targetDir)) return '落点不在项目或工作区的任何一个文件夹里，不能往那里写。';
    if (!inRoot(roots, src.path)) {
      return `「${name}」不在项目或工作区的任何一个文件夹里，不能拿它当搬运的源。`;
    }
    if (!roots.some((r) => isUnderPath(r, src.path) && isUnderPath(r, targetDir))) {
      return `「${name}」与落点不在同一个文件夹根里——跨根的搬运这一版不做（要搬到项目外面走导出）。`;
    }
  }
  return null;
}

/* ------------------------------ 决定 ------------------------------ */

/**
 * 把一次冲突决定落到计划上（纯函数）。
 *
 * 三条硬口径：
 * - `rejected` 的条目**任何决定下都进 `refused`**（铁律 4：不许因为"选了跳过"就让它不出现在回执里）；
 * - `cancel` = 一条都不落（`abort:true`，调用侧不必再问第二次）；
 * - 目录撞名选了 `overwrite` ⇒ 进 `refused` 并说清为什么，**不静默降级**成跳过或保留两者。
 */
export function decideFileOps(plan: FileOpsPlan, decision: ConflictDecision): DecidedOps {
  if (decision === 'cancel') return { abort: true, runs: [], skipped: [], refused: [] };
  const runs: RunOp[] = [];
  const skipped: string[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const item of plan.items) {
    if (item.status === 'rejected') {
      refused.push({ name: item.name, reason: item.reason ?? '这一条不能搬运。' });
      continue;
    }
    if (item.status === 'ready') {
      runs.push({ from: item.from, to: item.to, isDir: item.isDir, mode: plan.mode, overwrite: false });
      continue;
    }
    if (decision === 'skip') {
      skipped.push(item.name);
      continue;
    }
    if (decision === 'overwrite') {
      if (!item.actions.includes('overwrite')) {
        refused.push({
          name: item.name,
          reason: item.isDir
            ? '文件夹不做整目录覆盖（会吃掉对面那一整层内容）——请改选「跳过」或「保留两者」。'
            : '这一条不给覆盖——请改选「跳过」或「保留两者」。',
        });
        continue;
      }
      runs.push({ from: item.from, to: item.to, isDir: item.isDir, mode: plan.mode, overwrite: true });
      continue;
    }
    // keepBoth
    if (item.renameTo === undefined) {
      refused.push({ name: item.name, reason: item.reason ?? '自动改名找不到空位。' });
      continue;
    }
    runs.push({ from: item.from, to: item.renameTo, isDir: item.isDir, mode: plan.mode, overwrite: false });
  }
  return { abort: false, runs, skipped, refused };
}

/* ------------------------------ 人话（上屏文案的单源） ------------------------------ */

/** 冲突问句的四个选项（顺序即按钮顺序；`cancel` 由调用侧作"取消"钮） */
export const CONFLICT_CHOICES: ReadonlyArray<{ readonly action: ConflictDecision; readonly label: string }> = [
  { action: 'keepBoth', label: '保留两者（自动改名）' },
  { action: 'overwrite', label: '覆盖同名条目' },
  { action: 'skip', label: '跳过同名条目' },
  { action: 'cancel', label: '全部取消' },
];

/** 撞名的那一份清单（问句与回执共用；名字按 `pkey` 去重后原序） */
export function conflictNames(plan: FileOpsPlan): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of plan.items) {
    if (item.status !== 'conflict') continue;
    const k = pkey(item.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item.name);
  }
  return out;
}

/**
 * 冲突问句（一句人话，不出现内部术语）。
 *
 * `mode` 只影响动词：复制说"复制"、剪切说"移过来"——作者在这一格读到的必须是他刚做的那件事。
 */
export function conflictQuestion(plan: FileOpsPlan): string {
  const names = conflictNames(plan);
  const where = baseName(plan.targetDir);
  const verb = plan.mode === 'move' ? '移过来' : '放进来';
  const list = names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等 ${names.length} 项`;
  const dirHint = names.some((n) => plan.items.some((i) => i.status === 'conflict' && i.name === n && i.isDir))
    ? '（其中有文件夹：文件夹不做整目录覆盖，选「覆盖」时那几条会如实报失败）'
    : '';
  return `「${where}」里已经有同名的东西：${list}。这次是${verb}，要怎么处理？${dirHint}`;
}

/**
 * 一次操作的一句话回执（成功 N / 跳过 M / 失败 K，失败与拒绝**逐条点名**）。
 *
 * 全零时说"没有落下任何东西"而不是"成功 0 项"——后者读起来像 bug，前者是事实。
 */
export function opsResultSentence(args: {
  mode: FileOpMode;
  intent?: FileOpIntent;
  targetDir: string;
  done: number;
  skipped: readonly string[];
  failed: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const { mode, intent = 'paste', targetDir, done, skipped, failed } = args;
  const where = baseName(targetDir);
  const head =
    intent === 'duplicate'
      ? `已在「${where}」里做出 ${done} 份副本`
      : mode === 'move'
        ? `已把 ${done} 项移到「${where}」`
        : `已把 ${done} 项复制到「${where}」`;
  const parts: string[] = [];
  if (done > 0 || (skipped.length === 0 && failed.length === 0)) parts.push(head);
  if (skipped.length > 0) {
    parts.push(`跳过 ${skipped.length} 项（${skipped.join('、')}）`);
  }
  if (failed.length > 0) {
    parts.push(`没成的 ${failed.length} 项：${failed.map((f) => `${f.name}（${f.reason}）`).join('；')}`);
  }
  return parts.join('，');
}
