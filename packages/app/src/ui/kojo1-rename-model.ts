/**
 * `.kojo` → `.kojo1` 改名（LAU-3b，2026-10-27）——**纯模型**，零 React / 零内核 import。
 *
 * ## 这件事为什么存在
 *
 * 用户 2026-10-27 口径：只有一个「kojo」＝ 2.0 语法；kojo1（命令式旧语法）是**封存层**，
 * 地位是「即将删除」。但作者盘上的旧文件仍叫 `.kojo`，而 `.kojo` 迟早要让给 2.0。
 * 交接的第一步不是删文件，而是让作者**主动**把旧文件标成 `.kojo1`：
 *
 * - `.kojo1` 是显式声明（`ui/kojo2-cutover.ts` 的 `extension-kojo1` 分支）：见到它就不再嗅
 *   正文，恒按 v1 解析；
 * - 工具**只改名、不改内容**，写前备份、逐文件走内核写允许域（`writablePaths` 第一道闸）；
 * - 清单先过目：哪些文件被认成旧写法、哪些被排除、为什么排除，全部上屏。
 *
 * ## 谁能被改名（判据只有一条）
 *
 * **内容指纹**（`kojo2-cutover.ts::fingerprintKojo2Source`）判 `v1` 的才进候选。
 * 判 `kojo2` 的不动（它已经是 2.0 写法，改名前缀反而把它扔回封存层）；`ambiguous` /
 * `empty` 也不动——"拿不准"不拿作者的文件去赌，作者可以先看 / 先迁移。
 *
 * ## 写盘纪律（逐条可测）
 *
 * 1. **不猜路径**：目标 = 同目录同基名、最后一段扩展名换成 `.kojo1`；
 * 2. **两端都过闸**：`isWritable(from)` 与 `isWritable(to)` 任一为假 ⇒ 这个文件不写
 *    （只读域整条拒绝，绝不"先改一半"）；
 * 3. **写前备份**：`io.backup(from)` 成功才 `io.rename`；备份失败 = 不改名（宁可没动作，
 *    也不留一份无法回滚的盘面）；
 * 4. **落点已存在 = 冲突**：不覆盖，逐条报出来；
 * 5. **一个失败不拖垮其余**：每个文件独立结算，结果逐条回执。
 *
 * 本模块不 import 内核类型（与 `kojo2-migrate-model.ts` 同款），真实 IO 由宿主以
 * 结构子集注入；node 测试给假体即可。
 */
import { KOJO_LEGACY_SOURCE_EXTENSION, KOJO_SOURCE_EXTENSION, pathKey } from '@kojo/plugin-api';
import { fingerprintKojo2Source, type Kojo2SourceFlavor } from './kojo2-cutover';

/* ============================== IO 端口 ============================== */

/** 本模块需要的最小 IO 面（真身 = `kernel.io`；方法签名与契约逐字对齐） */
export interface Kojo1RenameIoPort {
  /** 读文本（只读操作，不受写允许域约束） */
  readText(path: string): Promise<{ readonly text: string }>;
  /** 写允许域判定（第一道闸；`to` 可以还不存在） */
  isWritable(path: string): boolean;
  /** 目标是否已存在（冲突判据） */
  exists(path: string): Promise<boolean>;
  /** 写前备份（落点在应用数据目录；返回备份路径，失败抛错） */
  backup(path: string): Promise<string | null>;
  /** 改名（两端都断言写允许域；原子搬运） */
  rename(from: string, to: string): Promise<void>;
}

/* ============================== 判据 ============================== */

/** 是不是 `.kojo` 源（本工具只处理这一枚；`.kojo1` 已是完成态，`.kojo2` 不是 v1） */
export function isKojo1RenameSource(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  const dot = path.lastIndexOf('.');
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= sep) return false;
  return path.slice(dot).toLowerCase() === KOJO_SOURCE_EXTENSION;
}

/**
 * 目标路径：同目录同基名，`.kojo` → `.kojo1`（大小写不敏感，原路径其余部分逐字保留）。
 *
 * 已经是 `.kojo1` / 不是 `.kojo` ⇒ `null`（调用方不该把它塞进候选）。
 */
export function kojo1RenameTargetOf(path: string): string | null {
  if (!isKojo1RenameSource(path)) return null;
  return `${path.slice(0, path.length - KOJO_SOURCE_EXTENSION.length)}${KOJO_LEGACY_SOURCE_EXTENSION}`;
}

/** 一个文件的指纹结论怎么处置（`v1` 才是候选；其余全部排除并给出原因） */
export type Kojo1RenameSkipReason =
  | 'kojo2' // 已是 2.0 写法，不该被标成封存
  | 'ambiguous' // 两套都说得通（纯台词 / 刚迁到一半），不替作者赌
  | 'empty' // 空文件（没有可判定的写法）
  | 'read-failed' // 读不出来（编码 / 权限 / 竞态）：本轮跳过，原因可见
  | 'destination-exists' // `.kojo1` 已在盘上，不覆盖
  | 'not-writable'; // 源或落点不在写允许域内（只读域整条拒绝）

/** 一份候选（只含**内容判据通过**的文件；写得进去与否在 apply 时再验一次） */
export interface Kojo1RenameCandidate {
  readonly from: string;
  readonly to: string;
  readonly lineCount: number;
}

/** 一条被排除的记录（作者面可见；不静默丢） */
export interface Kojo1RenameSkipped {
  readonly path: string;
  readonly reason: Kojo1RenameSkipReason;
  /** 人话细节（读失败原文 / 冲突落点）；没有额外信息时为 null */
  readonly detail: string | null;
}

export interface Kojo1RenamePlan {
  readonly candidates: readonly Kojo1RenameCandidate[];
  readonly skipped: readonly Kojo1RenameSkipped[];
  /** 实际读了正文的数量（读数用；跳过 read-failed 的不算） */
  readonly scanned: number;
}

/* ============================== 计划 ============================== */

function lineCountOf(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  // 末尾换行不额外算一行（"三行文本 + 一个行尾换行"在作者眼里仍是三行）
  return text.endsWith('\n') ? n - 1 : n;
}

/** 指纹档 → 跳过原因（`v1` 返回 null = 候选） */
function skipReasonOf(flavor: Kojo2SourceFlavor): Kojo1RenameSkipReason | null {
  switch (flavor) {
    case 'v1':
      return null;
    case 'kojo2':
      return 'kojo2';
    case 'ambiguous':
      return 'ambiguous';
    case 'empty':
      return 'empty';
  }
}

/**
 * 列清单（**只读**；一条都不写盘）。
 *
 * 入参是已经按扩展名收过的路径（宿主用 `listSourceFiles`）；本层再做一次
 * `.kojo` 判据与去重（同一文件从两个根回来只算一次）。顺序 = 入参顺序，便于作者
 * 对上文件树的排布。
 */
export async function planKojo1Renames(
  paths: readonly string[],
  io: Pick<Kojo1RenameIoPort, 'readText' | 'exists' | 'isWritable'>,
): Promise<Kojo1RenamePlan> {
  const candidates: Kojo1RenameCandidate[] = [];
  const skipped: Kojo1RenameSkipped[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const path of paths) {
    const to = kojo1RenameTargetOf(path);
    if (to === null) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);

    let text: string;
    try {
      text = (await io.readText(path)).text;
      scanned++;
    } catch (e: unknown) {
      skipped.push({ path, reason: 'read-failed', detail: e instanceof Error ? e.message : String(e) });
      continue;
    }

    const flavor = fingerprintKojo2Source(text).flavor;
    const reason = skipReasonOf(flavor);
    if (reason !== null) {
      skipped.push({ path, reason, detail: null });
      continue;
    }

    if (!io.isWritable(path) || !io.isWritable(to)) {
      skipped.push({ path, reason: 'not-writable', detail: null });
      continue;
    }
    if (await io.exists(to)) {
      skipped.push({ path, reason: 'destination-exists', detail: to });
      continue;
    }

    candidates.push({ from: path, to, lineCount: lineCountOf(text) });
  }

  return { candidates, skipped, scanned };
}

/* ============================== 应用 ============================== */

export type Kojo1RenameResultKind =
  | 'renamed'
  | 'not-writable'
  | 'destination-exists'
  | 'content-changed'
  | 'backup-failed'
  | 'rename-failed';

export interface Kojo1RenameResult {
  readonly from: string;
  readonly to: string;
  readonly kind: Kojo1RenameResultKind;
  /** 失败人话（成功为 null） */
  readonly message: string | null;
}

export interface Kojo1RenameApplyReport {
  readonly results: readonly Kojo1RenameResult[];
  /** 真正改成的对（宿主用它们重挂标签路径 + 刷新文件树） */
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/**
 * 落地（**逐文件独立结算**）。
 *
 * 缺省动作顺序：再验两端写权限 → 目标存在则冲突 → `backup` → `rename`。
 * 任何一步失败都只记这一条，继续下一个——"一个文件冲突让整批不落地"会把作者
 * 按几十份清单逐条试错，比部分落地更糟。
 */
export async function applyKojo1Renames(
  candidates: readonly Kojo1RenameCandidate[],
  io: Kojo1RenameIoPort,
): Promise<Kojo1RenameApplyReport> {
  const results: Kojo1RenameResult[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  for (const c of candidates) {
    const fail = (kind: Kojo1RenameResultKind, message: string): void => {
      results.push({ from: c.from, to: c.to, kind, message });
    };

    if (!io.isWritable(c.from) || !io.isWritable(c.to)) {
      fail('not-writable', '这个位置在只读范围内：先在「只读」徽章那里批准写权限，再重跑。');
      continue;
    }
    if (await io.exists(c.to)) {
      fail('destination-exists', '目标文件已存在，不覆盖。');
      continue;
    }
    // 清单与落地之间作者可能改了正文（对话框开着时也能编辑）⇒ 写前再判一次内容。
    // 只读一次长文件的代价远小于"把一份刚改成 2.0 的文件封存回 kojo1"的错。
    try {
      const fresh = (await io.readText(c.from)).text;
      const flavor = fingerprintKojo2Source(fresh).flavor;
      if (flavor !== 'v1') {
        fail('content-changed', `内容已不是确认的旧写法（现在判为 ${flavor}），未改名。`);
        continue;
      }
    } catch (e: unknown) {
      fail('content-changed', `读不出当前内容，未改名：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    try {
      await io.backup(c.from);
    } catch (e: unknown) {
      fail('backup-failed', `写前备份失败，未改名：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    try {
      await io.rename(c.from, c.to);
    } catch (e: unknown) {
      fail('rename-failed', `改名失败：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    results.push({ from: c.from, to: c.to, kind: 'renamed', message: null });
    renamed.push({ from: c.from, to: c.to });
  }

  return { results, renamed };
}
