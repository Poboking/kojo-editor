/**
 * 文件操作的**执行层**（WS-13 2a 车 · 剪贴板家族的落地腿；零 React、零 DOM）。
 *
 * ## 这一层只干一件事：把计划层的决定逐条落到盘上，并聚合出一句真话
 *
 * 判据全在 `file-ops-plan.ts`（纯函数）；这里只负责"怎么落"。宿主（文件树）给三样东西：
 * io、计划、一次冲突决定，外加脏闸的两个回调。返回值是完整事实（成功几项 / 跳过几项 /
 * 哪些没成、为什么），上屏与收尾（重列目录、通知索引、清剪贴板）由宿主做——
 * 本层不弹任何 UI，也不持有"上次剪贴板"那种现场。
 *
 * ## 落地的四条硬口径
 *
 * 1. **竞态在 OS 层闭合**：新建同名条目一律走独占创建（`create_file_exclusive` /
 *    `create_dir_exclusive`），不做 `exists()` 预查——"查了不存在再写"之间被人插一份
 *    就是覆盖。独占创建回 `false` 就说"占位失败"，并顺着「保留两者」的改名序列往下找空位，
 *    于是计划层的冲突预检**只是提前把话说清楚**，不是安全边界。
 * 2. **覆盖必须留退路**（数据毁灭级动作，与 `restoreBackup` / 删除进回收站同一条纪律）：
 *    - 复制盖文件 ⇒ 先 `backup(落点)` 把现状写进本地历史，再 `copyFile`（备份没成就不盖）；
 *    - 剪切盖文件 ⇒ 先 `removeFile(落点)`（内核把它送进回收站，文件历史里找得回），
 *      再 `rename`。之所以不能只 `backup`：Windows 的 `rename` 撞到已存在的目标会失败。
 *    - 目录撞名不给覆盖（判据在计划层），这里也就没有"整目录覆盖"的实现。
 * 3. **写允许域一个字节都不绕**：落点不可写 ⇒ 一条都不碰盘，直接一句人话（铁律 5 / 6）。
 *    要写到项目外面只有一条法定通道（`exportFile`，对话框即授权），不在本层。
 * 4. **不静默**（铁律 4）：逐条失败都带名字与原因进回执；计划层的 `refused`
 *    并进同一份"没成的"清单一起上屏——选了"跳过"也不该让非法源从回执里消失。
 *
 * ## 复制目录怎么落
 *
 * 一次 `walkDir` 拿整棵子树（不逐层往返），先独占建出目标根，再按清单逐条
 * `createDirExclusive`（已存在算成功，语义上就是"这层已经有了"）+ `copyFile`。
 * 子树里的条目撞名不会回头问用户：整棵树是按**同一个决定**落的，
 * 中途每条再问一次等于把一次粘贴变成几十次对话框。
 */
import type { DirEntry, WalkOptions } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import { baseName } from './file-tree-model';
import { joinPath } from './file-tree-ops';
import { decideFileOps, opsResultSentence } from './file-ops-plan';
import type { ConflictDecision, FileOpsPlan, RunOp } from './file-ops-plan';

/**
 * 落地需要的**最小 IO 面**（结构类型：内核 `FileIO` 直接可传）。
 * 端口里没有 `writeText` / `exists` ⇒ "偷偷先查后写"在类型上无处落脚。
 */
export interface FileOpsIo {
  createFileExclusive(path: string): Promise<boolean>;
  createDirExclusive(path: string): Promise<boolean>;
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]>;
  /** 写前本地历史（覆盖退路）；没有这一格的宿主 ⇒ 覆盖一律不做（不静默吃掉现状） */
  backup?(path: string): Promise<string | null>;
}

/** 脏闸的两个回调（"脏"的真相源在宿主的会话/缓冲，本层不自造第二份定义） */
export interface DirtyGate {
  /** 给一批路径，返回其中**有未保存改动**的那几份的名字（顺序随入参） */
  dirtyOf?: (paths: readonly string[]) => string[];
  /**
   * 让用户选：`true` = 继续，`false` = 整个动作作废。
   * `kind` 决定措辞——`move` 问的是"源带着未保存改动要被移走"，
   * `overwrite` 问的是"落点那份未保存的改动还只在编辑器里"。
   */
  askDirty?: (kind: 'move' | 'overwrite', names: readonly string[]) => boolean;
}

export interface FileOpsExecInput {
  readonly io: FileOpsIo;
  readonly plan: FileOpsPlan;
  readonly decision: ConflictDecision;
  /** 落点目录的可写性（宿主用内核 `io.isWritable` 现判；false ⇒ 一条都不碰盘） */
  readonly targetWritable: boolean;
  readonly dirty?: DirtyGate;
}

export interface FileOpsOutcome {
  /** 决定=全部取消，或脏闸被用户否掉 ⇒ 一个字节都没动 */
  readonly aborted: boolean;
  /** 真落地的条目数（目录算一项，与作者眼里"搬了几个东西"对齐） */
  readonly done: number;
  readonly skipped: readonly string[];
  readonly failed: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** 复制/副本落地的新路径（宿主拿去做索引增量） */
  readonly created: readonly string[];
  /** 剪切落地的搬运对（宿主拿去收尾标签与视图状态） */
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** 被盖掉的落点（回执里要说清退路在哪） */
  readonly overwritten: readonly string[];
  /**
   * **没落地、仍在原地的源路径**（宿主据此决定剪贴板留不留）：
   * 剪切粘贴失败的那几项还在原地，剪贴板留着它们才能重试；成了的那些必须清掉，
   * 否则下一次粘贴会再搬一遍已经搬走的东西。
   */
  readonly failedSources: readonly string[];
  /** 一句人话回执（成功 N / 跳过 M / 没成 K，没成的逐条点名） */
  readonly resultText: string;
}

/** 「保留两者」在落地阶段继续往后找空位的上界（与计划层同一档，不另立口径） */
const CLAIM_LIMIT = 99;

/** 拆「名字 + 扩展名」用于找下一个候选名（与计划层同一算式：最后一个点起算扩展名） */
function splitForClaim(name: string, isDir: boolean): { base: string; ext: string } {
  if (isDir) return { base: name, ext: '' };
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

/** 落点所在目录（把 `to` 拆成"目录 + 名字"用；不引第二份 parentDir 口径） */
function dirOfTarget(to: string): string {
  const i = Math.max(to.lastIndexOf('/'), to.lastIndexOf('\\'));
  return i >= 0 ? to.slice(0, i) : '';
}

/** 条目名（上屏点名用） */
function nameOfTarget(to: string): string {
  return baseName(to);
}

/**
 * 候选落点序列：原名先试，占着就顺着「名字 2 / 名字 3 …」往下找。
 *
 * 计划层已经按它拿到的现状给过一次建议名；这里重算是因为**落地那一刻**才是真相——
 * 独占创建说"占了"才算占了。两条腿共用同一条改名算式（`splitForClaim`），
 * 不会出现"预检说 2、落地写成 3"这种读起来像 bug 的分裂。
 */
function candidateTos(op: RunOp): string[] {
  const dir = dirOfTarget(op.to);
  const name = nameOfTarget(op.to);
  const first = name;
  const { base, ext } = splitForClaim(name, op.isDir);
  const out: string[] = [joinPath(dir, first)];
  for (let n = 2; n <= CLAIM_LIMIT; n++) out.push(joinPath(dir, `${base} ${n}${ext}`));
  return out;
}

/** 源子树里的条目换成落点侧的路径（保持原分隔符风格：rel 自带开头分隔符） */
function remap(entryPath: string, from: string, to: string): string | null {
  if (entryPath.length <= from.length) return null; // 源根本身（walkDir 会把它列出来）
  const rel = entryPath.slice(from.length);
  if (rel === '' || rel.startsWith('/') || rel.startsWith('\\')) return `${to}${rel}`;
  return joinPath(to, rel);
}

async function copyOneFile(
  io: FileOpsIo,
  from: string,
  to: string,
  overwrite: boolean,
): Promise<{ ok: true; to: string } | { ok: false; reason: string }> {
  if (overwrite) {
    // 覆盖的唯一退路是写前本地历史；没有那条腿就不盖（宁可不动原文件）
    if (io.backup === undefined) {
      return { ok: false, reason: '这个环境没有"覆盖前先把原内容写进本地历史"的通道，已停止覆盖。' };
    }
    try {
      await io.backup(to);
    } catch (e: unknown) {
      return { ok: false, reason: `覆盖前的本地历史没写成功，原文件没动（${errorText(e)}）。` };
    }
    try {
      await io.copyFile(from, to);
      return { ok: true, to };
    } catch (e: unknown) {
      return { ok: false, reason: errorText(e) };
    }
  }
  // 不覆盖：独占创建抢名字，抢到再灌字节
  const candidates = candidateTos({ from, to, isDir: false, mode: 'copy', overwrite: false });
  let used: string | null = null;
  for (const candidate of candidates) {
    try {
      if (await io.createFileExclusive(candidate)) {
        used = candidate;
        break;
      }
    } catch (e: unknown) {
      return { ok: false, reason: errorText(e) };
    }
  }
  if (used === null) {
    return { ok: false, reason: `自动改名的名字（${nameOfTarget(to)} 2 …）都占着，先腾出一个位置。` };
  }
  try {
    await io.copyFile(from, used);
    return { ok: true, to: used };
  } catch (e: unknown) {
    // 抢到的空文件不能留在原地冒充副本：清掉它（清不掉也要把复制失败说在前面）
    try {
      await io.removeFile(used);
    } catch {
      /* 清理失败不改写"复制失败"这条主因 */
    }
    return { ok: false, reason: errorText(e) };
  }
}

async function copyOneDir(
  io: FileOpsIo,
  from: string,
  to: string,
): Promise<{ ok: true; to: string } | { ok: false; reason: string }> {
  const candidates = candidateTos({ from, to, isDir: true, mode: 'copy', overwrite: false });
  let root: string | null = null;
  for (const candidate of candidates) {
    try {
      if (await io.createDirExclusive(candidate)) {
        root = candidate;
        break;
      }
    } catch (e: unknown) {
      return { ok: false, reason: errorText(e) };
    }
  }
  if (root === null) {
    return { ok: false, reason: `自动改名的文件夹名（${nameOfTarget(to)} 2 …）都占着，先腾出一个位置。` };
  }
  let entries: DirEntry[];
  try {
    entries = await io.walkDir(from, { includeFiles: true, includeDirs: true });
  } catch (e: unknown) {
    return { ok: false, reason: `读不出这个文件夹的内容（${errorText(e)}）` };
  }
  const problems: string[] = [];
  for (const entry of entries) {
    const mapped = remap(entry.path, from, root);
    if (mapped === null) continue;
    try {
      if (entry.isDirectory) {
        await io.createDirExclusive(mapped); // 已存在 = 这层已经有了，不是错误
      } else {
        await io.copyFile(entry.path, mapped);
      }
    } catch (e: unknown) {
      problems.push(`${baseName(entry.path)}（${errorText(e)}）`);
    }
  }
  if (problems.length > 0) {
    return { ok: false, reason: `文件夹建出来了，但里面 ${problems.length} 项没成：${problems.join('；')}` };
  }
  return { ok: true, to: root };
}

async function moveOne(
  io: FileOpsIo,
  from: string,
  to: string,
  isDir: boolean,
  overwrite: boolean,
): Promise<{ ok: true; overwritten: boolean } | { ok: false; reason: string }> {
  if (overwrite && !isDir) {
    // Windows 的 rename 撞上已存在的目标会失败：先把被盖的那份送进回收站（可找回）
    try {
      await io.removeFile(to);
    } catch (e: unknown) {
      return { ok: false, reason: `要盖掉的那一份没能移进回收站，原样没动（${errorText(e)}）` };
    }
  }
  try {
    await io.rename(from, to);
    return { ok: true, overwritten: overwrite };
  } catch (e: unknown) {
    return { ok: false, reason: errorText(e) };
  }
}

/** 计划项的名字（脏闸点名用） */
function itemName(op: RunOp): string {
  return nameOfTarget(op.to === '' ? op.from : op.to);
}

/**
 * 执行一次粘贴 / 副本（唯一的落地入口）。
 *
 * 顺序：先算决定 → 可写闸 → 脏闸 → 逐条落盘 → 聚合回执。
 * 前四步任何一步拦下都是一个字节都不碰（不出现"搬了一半才发现不能写"）。
 */
export async function runFileOps(input: FileOpsExecInput): Promise<FileOpsOutcome> {
  const { io, plan, decision, targetWritable } = input;
  const decided = decideFileOps(plan, decision);
  const empty = {
    aborted: false,
    done: 0,
    skipped: decided.skipped,
    failed: decided.refused,
    created: [] as string[],
    moved: [] as Array<{ from: string; to: string }>,
    overwritten: [] as string[],
    failedSources: [] as string[],
  };
  if (decided.abort) {
    return { ...empty, aborted: true, resultText: '已全部取消——一个字节都没动。' };
  }
  if (decided.runs.length === 0) {
    return {
      ...empty,
      resultText: opsResultSentence({
        mode: plan.mode,
        intent: plan.intent,
        targetDir: plan.targetDir,
        done: 0,
        skipped: decided.skipped,
        failed: decided.refused,
      }),
    };
  }
  if (!targetWritable) {
    // 写允许域是第一道闸：不可写就**一个 IO 都不发**（不出现"写了一半才发现越界"）
    const reason = '这个位置在只读范围内，不能写入——要先在「只读」徽章那里批准写权限。';
    const failed = [...decided.refused, ...decided.runs.map((op) => ({ name: itemName(op), reason }))];
    return {
      ...empty,
      failed,
      // 一项都没落地 ⇒ 全部源都还在原地（剪切的那份剪贴板要留着它们才能重试）
      failedSources: decided.runs.map((op) => op.from),
      resultText: opsResultSentence({
        mode: plan.mode,
        intent: plan.intent,
        targetDir: plan.targetDir,
        done: 0,
        skipped: decided.skipped,
        failed,
      }),
    };
  }

  // 脏闸：剪切要动源、覆盖要动落点——两边都问，答"不"就整批作废（不许静默把脏缓冲区丢在原地）
  const gate = input.dirty ?? {};
  const dirtyOf = gate.dirtyOf;
  const askDirty = gate.askDirty;
  if (dirtyOf !== undefined && askDirty !== undefined) {
    const allSources = decided.runs.map((op) => op.from);
    const moveNames = dirtyOf(decided.runs.filter((op) => op.mode === 'move').map((op) => op.from));
    if (moveNames.length > 0 && !askDirty('move', moveNames)) {
      return {
        ...empty,
        aborted: true,
        failedSources: allSources,
        resultText: '已取消：那些文件还有未保存的修改，先存一下再搬。',
      };
    }
    const overNames = dirtyOf(decided.runs.filter((op) => op.overwrite).map((op) => op.to));
    if (overNames.length > 0 && !askDirty('overwrite', overNames)) {
      return {
        ...empty,
        aborted: true,
        failedSources: allSources,
        resultText: '已取消：落点那份文件还有未保存的修改，先处理一下再覆盖。',
      };
    }
  }

  const created: string[] = [];
  const moved: Array<{ from: string; to: string }> = [];
  const overwritten: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [...decided.refused];
  const failedSources: string[] = [];
  let done = 0;

  for (const op of decided.runs) {
    const name = itemName(op);
    if (op.mode === 'move') {
      const r = await moveOne(io, op.from, op.to, op.isDir, op.overwrite);
      if (r.ok) {
        done += 1;
        moved.push({ from: op.from, to: op.to });
        if (op.overwrite && !op.isDir) overwritten.push(op.to);
      } else {
        failed.push({ name, reason: r.reason });
        failedSources.push(op.from);
      }
      continue;
    }
    if (op.isDir) {
      const r = await copyOneDir(io, op.from, op.to);
      if (r.ok) {
        done += 1;
        created.push(r.to);
      } else {
        failed.push({ name, reason: r.reason });
        failedSources.push(op.from);
      }
      continue;
    }
    const r = await copyOneFile(io, op.from, op.to, op.overwrite);
    if (r.ok) {
      done += 1;
      created.push(r.to);
      if (op.overwrite) overwritten.push(op.to);
    } else {
      failed.push({ name, reason: r.reason });
      failedSources.push(op.from);
    }
  }

  const tail = overwritten.length > 0 ? '；被盖掉的旧内容已经进了本地历史或回收站，可以从「文件历史」找回' : '';
  return {
    aborted: false,
    done,
    skipped: decided.skipped,
    failed,
    created,
    moved,
    overwritten,
    failedSources,
    resultText:
      opsResultSentence({
        mode: plan.mode,
        intent: plan.intent,
        targetDir: plan.targetDir,
        done,
        skipped: decided.skipped,
        failed,
      }) + tail,
  };
}

/** 决定 + 计划层拒绝（合并成人话清单） */
function decideWithRefused(
  plan: FileOpsPlan,
  decision: ConflictDecision,
): {
  abort: boolean;
  runs: readonly RunOp[];
  skipped: readonly string[];
  refused: ReadonlyArray<{ name: string; reason: string }>;
} {
  const d = decideFileOps(plan, decision);
  return { abort: d.abort, runs: d.runs, skipped: d.skipped, refused: d.refused };
}
