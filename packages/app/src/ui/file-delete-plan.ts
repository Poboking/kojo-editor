/**
 * 批量删除的**判据层**（WS-13 2c 车；零 IO、零 React、零 DOM）。
 *
 * ## 为什么单独一层
 *
 * 「把选中的这些都删掉」听起来是一句话，实际上是一次**判决**：哪几条真的要发删除动作、
 * 哪几条已经被同批的某个文件夹带走了、哪几条压根删不了。判据若长在组件里，就只能靠
 * "把浏览器开起来点一遍"来证明，而这一层里全是会被点错的边界（父子同批、两种写法算两条、
 * 目录里的内容读不出来）。于是照 `file-ops-plan` / `file-tree-ops` 的既有形态：
 * **判据住纯函数、组件只接线、全部边界靠单证**。
 *
 * ## 三条硬判据
 *
 * 1. **归一去重**（`pkey`）：分隔符与大小写的两种写法是同一条盘上条目，一次删除动作都不许多发；
 * 2. **父子同批 ⇒ 子不单独删**（`status: 'carried'`）：删目录本身就是递归删除，再对子条目
 *    发一次 `removeFile` 会得到"目标不存在"那种假失败（内核 `removeFile` 刻意不做幂等兜底）。
 *    被带走的那几条**照样逐条点名**并写明"随谁走"——它们会随那个目录一起回来，不是消失了；
 * 3. **读不出名字的条目不进删除动作**（`status: 'rejected'`）：空路径与 `.` / `..` 这类
 *    "看着像条目其实不是"的东西一律拒绝并给原因（铁律 4：不许静默把它们从回执里抹掉）。
 *
 * ## 确认文案的纪律
 *
 * 递归删除是把大刀，所以确认框**不许只报一个数字**：文件与文件夹各几枚、每一枚文件夹会带走
 * 多少个子项（"这条会带走整个文件夹，里面有 12 个文件、3 个子文件夹"）、哪几条随目录一起走、
 * 哪几条删不了要原样留下——一件一条。规模读不出来时不猜数字，退化成"里面的全部内容都会一起走"，
 * 警示语保留。清单有上限（`DELETE_LIST_LIMIT`），超出部分如实说"另有 K 项没列出、这一批会一起删除"，
 * 而不是把一次勾选悄悄截断。
 *
 * ## 删除的去向（文案必须说对）
 *
 * 内核 `removeFile` / `removeDir` 从 2026-10-16 undo 批起就是**移入回收站**
 * （`{appData}/trash/`，条目保留 30 天），不是原地抹掉。所以回执回答的是"东西去哪了、
 * 怎么拿回来"：撤销这一批 / 「文件历史」逐条找回。旧版"此操作无法撤销"那种话与事实相反，
 * 一个字都不许再出现。
 */
import { baseName } from './file-tree-model';
import { isUnderPath, pkey } from './file-tree-ops';

/** 一条要删的盘上条目（路径 + 是不是目录；种类由调用侧在删除**之前**定下来） */
export interface DeleteEntry {
  readonly path: string;
  readonly isDir: boolean;
}

/** 计划项的三种判决 */
export type DeletePlanStatus =
  /** 真的要发一次删除动作 */
  | 'target'
  /** 站在同批另一枚被删目录里，随那一条一起走（不单独发动作） */
  | 'carried'
  /** 删不了（读不出名字），原样留下并点名 */
  | 'rejected';

export interface DeletePlanItem {
  readonly path: string;
  readonly name: string;
  readonly isDir: boolean;
  readonly status: DeletePlanStatus;
  /** 目录连带的内容数（`status='target'` 且是目录时才有；读不到 ⇒ 两格都缺，文案如实退化） */
  readonly carriedFiles?: number;
  readonly carriedDirs?: number;
  /** `status='carried'`：把它一起带走的那一枚目录的名字 */
  readonly carriedBy?: string;
  /** `status='rejected'`：人话原因 */
  readonly reason?: string;
}

export interface DeletePlan {
  readonly items: readonly DeletePlanItem[];
  /** 要真发删除动作的那几条（顺序随入参） */
  readonly targets: readonly DeletePlanItem[];
  /** 被同批目录带走的（仍逐条点名） */
  readonly carried: readonly DeletePlanItem[];
  /** 删不了的（仍逐条点名） */
  readonly rejected: readonly DeletePlanItem[];
  /** `targets` 里的文件枚数 */
  readonly fileCount: number;
  /** `targets` 里的文件夹枚数 */
  readonly dirCount: number;
  /**
   * 目录连带走的文件合计。**有一份目录读不出规模就是 null**——
   * 拿已知的几枚冒充总数，等于给作者一个偏小的刀口读数。
   */
  readonly carriedFileTotal: number | null;
}

/** 目录连带规模的上屏清单上限（超出如实说"另有 K 项没列出"，不静默截断） */
export const DELETE_LIST_LIMIT = 20;

/** `buildDeletePlan` 的两个现场输入（都不碰 IO：宿主算好了再交给判据层） */
export interface DeletePlanOptions {
  /**
   * 目录连带规模（`walkDir` 现算）。
   * 读不到 / 没给 ⇒ 确认文案退化成"里面的全部内容都会一起走"，**不猜数字**。
   */
  readonly sizeOf?: (path: string) => { files?: number; dirs?: number } | undefined;
  /**
   * 这一条删不掉的**人话原因**（宿主用内核 `io.isWritable` 现判，不可写就给这句话）。
   *
   * 给了原因的条目进 `rejected`：它照旧出现在确认框的点名列里（"这几条删不了，会原样留下"），
   * 但一条 IO 都不会发——"先让作者看清整批、再告诉他哪几条本来就不许动"，
   * 比悄悄把整批截断成一小批要好读得多。
   */
  readonly blockedOf?: (path: string) => string | null;
}

/** 同一条盘上条目？（分隔符 / 大小写 / 尾部斜杠三种写法都算同一个东西） */
function samePath(a: string, b: string): boolean {
  return pkey(a).replace(/\/+$/, '') === pkey(b).replace(/\/+$/, '');
}

/** 层深（分隔符个数；"最近的被删祖先"用它排，不拿字符长度猜） */
function depthOf(p: string): number {
  return (p.match(/[\\/]/g) ?? []).length;
}

/**
 * 逐条判决（纯函数，全部边界靠单测）。
 *
 * 判据顺序：先认名字（读不出名字的一律 `rejected`）→ 再问宿主这条删不删得掉（`blockedOf`）
 * → 再折叠父子同批（子进 `carried`）。剩下的才是 `targets`。
 */
export function buildDeletePlan(
  entries: readonly DeleteEntry[],
  options: DeletePlanOptions = {},
): DeletePlan {
  const items: DeletePlanItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = pkey(e.path).replace(/\/+$/, '');
    if (seen.has(key)) continue; // 同一条东西被两种写法交了两次（含尾斜杠）：只处理一次
    seen.add(key);
    const name = baseName(e.path);
    if (name === '' || name === '.' || name === '..') {
      items.push({
        path: e.path,
        name: e.path === '' ? '（空路径）' : e.path,
        isDir: e.isDir,
        status: 'rejected',
        reason: '这一条读不出条目名称，不能删除。',
      });
      continue;
    }
    const blocked = options.blockedOf?.(e.path) ?? null;
    if (blocked !== null) {
      items.push({ path: e.path, name, isDir: e.isDir, status: 'rejected', reason: blocked });
      continue;
    }
    const size = e.isDir ? options.sizeOf?.(e.path) : undefined;
    items.push({
      path: e.path,
      name,
      isDir: e.isDir,
      status: 'target',
      ...(e.isDir && typeof size?.files === 'number' ? { carriedFiles: size.files } : {}),
      ...(e.isDir && typeof size?.dirs === 'number' ? { carriedDirs: size.dirs } : {}),
    });
  }

  // 父子同批：子随**最近的**被删祖先走（祖先自己也随更上层走时，点名仍写它直接的那一层父目录，
  // 读的人顺着那条就能找到；两条删除动作则一条都不多发——对已被带走的子路径再发一次
  // `removeFile` 只会得到"目标不存在"那种假失败）。
  // "最近"用**层深**排（路径字符长度会被名字长短带偏：`/a/bbcd` 比 `/aa/b` 深却更短），同层再比长度。
  const dirs = items.filter((i) => i.isDir && i.status !== 'rejected');
  for (const item of [...items]) {
    if (item.status !== 'target') continue;
    const holders = dirs
      .filter((dd) => samePath(dd.path, item.path) === false && isUnderPath(dd.path, item.path))
      .sort((a, b) => depthOf(b.path) - depthOf(a.path) || b.path.length - a.path.length);
    const holder = holders[0];
    if (holder !== undefined) {
      const idx = items.indexOf(item);
      items[idx] = { ...item, status: 'carried', carriedBy: holder.name };
    }
  }

  const targets = items.filter((i) => i.status === 'target');
  const carried = items.filter((i) => i.status === 'carried');
  const rejected = items.filter((i) => i.status === 'rejected');
  const dirTargets = targets.filter((i) => i.isDir);
  let carriedFileTotal: number | null = 0;
  for (const d of dirTargets) {
    if (typeof d.carriedFiles === 'number') carriedFileTotal += d.carriedFiles;
    else {
      carriedFileTotal = null;
      break;
    }
  }

  return {
    items,
    targets,
    carried,
    rejected,
    fileCount: targets.filter((i) => !i.isDir).length,
    dirCount: dirTargets.length,
    carriedFileTotal,
  };
}

/* ------------------------------ 分档（单条旧腿 / 整批新腿） ------------------------------ */

/** 删除走哪条腿：`single` = 既有那条单条语义（守门一刀拒绝 + `window.confirm`），`batch` = 整批新腿 */
export type DeleteScope = 'single' | 'batch';

/**
 * 分档判据（纯函数）：**勾选集里有多于一项**才算"有多选集"。
 *
 * 为什么不是"非空"：树上一次普通单击就会把那一行写进勾选集（`setSelected([path])`），
 * 拿"非空"当判据等于把单条删除的老读感整条换掉——简报要的是"**无多选集时旧行为零改动**"。
 * 于是勾 1 项与没勾一样走单条腿，勾到第 2 项才谈"整批"。
 */
export function deleteScopeOf(selectionSize: number): DeleteScope {
  return selectionSize > 1 ? 'batch' : 'single';
}

/* ------------------------------ 人话（上屏文案的单源） ------------------------------ */

/** 「随谁走」的那半句（carried 条目与回执共用一条措辞） */
function carriedSuffix(item: DeletePlanItem): string {
  return `（在「${item.carriedBy ?? '?'}」里，随它一起走、也随它一起回来）`;
}

/** 一条目录的刀口描述 */
function dirScopeText(item: DeletePlanItem): string {
  if (typeof item.carriedFiles === 'number') {
    const dirsPart =
      typeof item.carriedDirs === 'number' && item.carriedDirs > 0 ? `、${item.carriedDirs} 个子文件夹` : '';
    return `这条会带走整个文件夹，里面有 ${item.carriedFiles} 个文件${dirsPart}`;
  }
  return '这条会带走整个文件夹，里面的全部内容（含子文件夹）都会一起走';
}

/** 回收站去向那句（确认与回执共用；措辞只有一份，两处不许各说各话） */
export const TRASH_WHERE = '回收站（在应用数据目录里，不在游戏目录里，保留 30 天）';

/**
 * 批量删除的确认文案（**逐条点名**；纯函数，可单测）。
 *
 * 顺序即读感：先说这批多大（文件几枚、文件夹几枚），再一条条点名，
 * 然后是被带走的、删不了的，最后才是"东西去哪了、怎么拿回来"。
 */
export function deleteBatchConfirmText(plan: DeletePlan): string {
  const lines: string[] = [];
  const total = plan.targets.length;
  if (total === 0) {
    return `这一批里没有可以直接删除的条目${
      plan.rejected.length > 0 ? `：${plan.rejected.map((r) => `${r.name}（${r.reason ?? ''}）`).join('；')}` : ''
    }。一个字节都没动。`;
  }
  const mix: string[] = [];
  if (plan.fileCount > 0) mix.push(`${plan.fileCount} 个文件`);
  if (plan.dirCount > 0) mix.push(`${plan.dirCount} 个文件夹`);
  lines.push(`确定删除这 ${total} 项吗？（${mix.join('、')}）`);

  const listed = plan.targets.slice(0, DELETE_LIST_LIMIT);
  listed.forEach((item, i) => {
    lines.push(
      `${i + 1}. ${item.isDir ? '文件夹' : '文件'}「${item.name}」${item.isDir ? `——${dirScopeText(item)}` : ''}`,
    );
  });
  if (plan.targets.length > listed.length) {
    lines.push(`…另有 ${plan.targets.length - listed.length} 项没有列出——这一批会一起删除。`);
  }
  if (plan.carried.length > 0) {
    const named = plan.carried.slice(0, DELETE_LIST_LIMIT).map((c) => `${c.name}${carriedSuffix(c)}`);
    lines.push(
      `这些不单独删除，会随上面的文件夹一起走：${named.join('；')}${
        plan.carried.length > named.length ? ` 等 ${plan.carried.length} 项` : ''
      }`,
    );
  }
  if (plan.rejected.length > 0) {
    lines.push(
      `这几条删不了，会原样留下：${plan.rejected.map((r) => `${r.name}（${r.reason ?? '读不出条目名称'}）`).join('；')}`,
    );
  }
  lines.push(
    `删除不是抹掉：这一批会移进${TRASH_WHERE}——删完那句回执旁边有「撤销这次删除」，也能在「文件历史」里逐条找回。`,
  );
  return lines.join('\n');
}

/** 一次批量删除的落定回执（"东西去哪了、怎么拿回来"必须在这句里回答掉） */
export function deleteBatchReceiptText(args: {
  /** 真删成的（点名用名字与种类） */
  readonly done: ReadonlyArray<{ name: string; isDir: boolean }>;
  /** 没删成的（逐条点名 + 原因） */
  readonly failed?: ReadonlyArray<{ name: string; reason: string }>;
  /** 删成了但没能在回收站里对上号的（撤销不包括它们） */
  readonly untracked?: readonly string[];
  /** 随目录一起走的条数 */
  readonly carriedCount?: number;
  /** 宿主有没有"列回收站"这条腿（没有 ⇒ 不许说"可以撤销"这种假话） */
  readonly trashReadable: boolean;
}): string {
  const parts: string[] = [];
  const files = args.done.filter((d) => !d.isDir).length;
  const dirs = args.done.filter((d) => d.isDir).length;
  if (args.done.length > 0) {
    const mix: string[] = [];
    if (files > 0) mix.push(`${files} 个文件`);
    if (dirs > 0) mix.push(`${dirs} 个文件夹`);
    const named = args.done
      .slice(0, DELETE_LIST_LIMIT)
      .map((d) => `「${d.name}」`)
      .join('、');
    const more = args.done.length > DELETE_LIST_LIMIT ? ` 等 ${args.done.length} 项` : '';
    parts.push(`已删除 ${args.done.length} 项（${mix.join('、')}）：${named}${more}`);
    if ((args.carriedCount ?? 0) > 0) {
      parts.push(`另有 ${args.carriedCount} 项本来就在被删的文件夹里，随它一起走、也随它一起回来`);
    }
    parts.push(
      !args.trashReadable
        ? // 宿主整条腿都没有 ⇒ 这才是主因：逐条报"对不上号"会把"环境没有这个通道"说成"这几份运气不好"
          `这个环境没有读回收站的通道——这一批能不能放回原位，请在「文件历史」里逐条看`
        : args.untracked !== undefined && args.untracked.length > 0
          ? `其中 ${args.untracked.length} 份没能在回收站里对上号（${args.untracked.join('、')}）——撤销不包括它们，只能去「文件历史」里找`
          : `都在${TRASH_WHERE}里——按「撤销这次删除」放回原位，或在「文件历史」里逐条找回`,
    );
  } else {
    parts.push('没有删成任何条目');
  }
  const failed = args.failed ?? [];
  if (failed.length > 0) {
    parts.push(`没删成的 ${failed.length} 项：${failed.map((f) => `${f.name}（${f.reason}）`).join('；')}`);
  }
  return parts.join('，');
}

/** 一次撤销（把这一批从回收站放回原位）的回执 */
export function undoDeleteReceiptText(args: {
  readonly restored: readonly string[];
  readonly failed?: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const parts: string[] = [];
  if (args.restored.length > 0) {
    parts.push(
      `已放回 ${args.restored.length} 项：${args.restored
        .slice(0, DELETE_LIST_LIMIT)
        .map((n) => `「${n}」`)
        .join('、')}${args.restored.length > DELETE_LIST_LIMIT ? ` 等 ${args.restored.length} 项` : ''}（回到原来的位置）`,
    );
  } else {
    parts.push('一项都没放回原位');
  }
  const failed = args.failed ?? [];
  if (failed.length > 0) {
    parts.push(
      `没放回的 ${failed.length} 项：${failed.map((f) => `${f.name}（${f.reason}）`).join('；')}——它们还在回收站里，去「文件历史」能逐条再试`,
    );
  }
  return parts.join('，');
}

/** 没有可撤销的批时说的那句（撤销不许点了没反应） */
export function undoUnavailableText(): string {
  return '没有可撤销的删除——撤销只管这一次会话里刚删掉的那一批；更早的删除请在「文件历史」里逐条找回。';
}
