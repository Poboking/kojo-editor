/**
 * 外部写盘后的「model 重载决策」纯逻辑（2026-10-12 审阅补丁，修 B1）。
 *
 * 背景：💡 升糖等**经服务写盘**的操作会在成功路径上发内核事件 `file.changed`
 * （谁改盘谁发，见 events.ts / kojo-sugar 事件纪律）。此时编辑器里对应的 model
 * 仍是旧内容——若不重载，用户随后 `Ctrl+S` 会用旧文本**覆盖**磁盘上的新内容
 * （真实数据丢失）。宿主据此事件重载 model。
 *
 * 决策必须**区分「model 有无未保存修改」**，否则会引入反向数据丢失：
 * - `noop`：磁盘内容与 model 相同（多为自身保存的「回声」）→ 不做任何事，
 *   避免无谓重置撤销栈与光标；
 * - `reload`：磁盘变了、model **干净** → 静默重载（可安全用磁盘内容替换）；
 * - `conflict`：磁盘变了、model **脏** → **绝不静默覆盖**：重载会丢用户的
 *   未保存修改，不重载则用户保存会覆盖磁盘——两条路都有损，只能交给用户选。
 *
 * ZH-F3 起多了**三方**这一层（`base` = 最后一次与磁盘对齐的文本快照，由 model 池保管）：
 * - `merge`：盘上与内存各改各的地方 → 自动合，两份改动都留下（不再逼作者二选一）；
 * - `merge-conflict`：两侧改了同一片区域 → 逐块给出 base/盘/内存三份片段，仍然交给用户，
 *   但不再是"整篇二选一"；
 * - base 缺失（恢复件首开、老会话、超大文件）→ 逐字退回上面的两方 `conflict`，**不假装能合**。
 *
 * 抽成纯函数以便单测（React 组件内的分支不便在无 DOM 环境覆盖）。
 */
import { isPathUnder, pathKey } from '@kojo/plugin-api';

/**
 * 三方合并判不动的规模上限（行数）：ERB 单文件的正常量级远低于此，
 * 超过它说明这份内容不该逐行走（宁可退回两方让用户选）。
 */
const MAX_THREE_WAY_LINES = 4000;
/** 中段 LCS 表的单元上限；再大整段视为一次改写——只会多判冲突，不会漏判冲突 */
const MAX_LCS_CELLS = 1_000_000;

export type ExternalChangeDecision =
  | 'noop'
  | 'reload'
  | 'conflict'
  | { readonly kind: 'merge'; readonly text: string }
  | { readonly kind: 'merge-conflict'; readonly conflicts: readonly MergeConflictChunk[] };

/** 冲突块：三份片段的**下标区间**都在，谁都别想被静默丢掉 */
export interface MergeConflictChunk {
  /** base 上的区间，0 基、含首不含末（纯插入时 start === end） */
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly base: string;
  readonly disk: string;
  readonly memory: string;
}

/** 三方合并的结果：合得动就给整篇文本，合不动就给逐块清单（两者互斥，不并存） */
export type MergeOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly conflicts: readonly MergeConflictChunk[] };

/**
 * @param modelText 当前编辑器 model 的文本
 * @param diskText  重新从磁盘读到的文本
 * @param dirty     model 是否有未保存修改（相对已保存基线）
 * @param baseText  最后一次与磁盘对齐的文本快照；**缺省即退回两方语义**
 */
export function decideExternalChange(
  modelText: string,
  diskText: string,
  dirty: boolean,
  baseText?: string,
): ExternalChangeDecision {
  if (modelText === diskText) return 'noop';
  if (!dirty) return 'reload';
  if (baseText === undefined) return 'conflict';
  const merged = mergeExternalChange(baseText, diskText, modelText);
  if (merged === null) return 'conflict';
  if (!merged.ok) return { kind: 'merge-conflict', conflicts: merged.conflicts };
  // 合并结果 == 内存 ⇒ 盘上那份早已包含在 model 里，无事可做
  if (merged.text === modelText) return 'noop';
  return { kind: 'merge', text: merged.text };
}

/* ------------------------------ 三方合并（行级，纯函数） ------------------------------ */

/**
 * 单侧改动自动合、双侧同区改动逐块判冲突；判不动（超规模）返回 `null` = 调用方退回两方。
 *
 * 算法一份、零依赖：两侧各对 base 做行级 LCS ⇒ "改写区"清单（base 区间 + 替换行），
 * 再按 base 坐标走一遍——只有一侧动过的区间直接采用那侧，两侧都动过且不相容的区间
 * 收成一块冲突（区间会连续吸收，直到两侧都不再相碰）。
 */
export function mergeExternalChange(
  base: string,
  disk: string,
  memory: string,
): MergeOutcome | null {
  // 换行以 model 为准：合并是往 model 里写，不该把整篇的行尾约定翻一遍
  const eol = memory.includes('\r\n') ? '\r\n' : '\n';
  const b = splitLines(base);
  const d = splitLines(disk);
  const m = splitLines(memory);
  if (b.length > MAX_THREE_WAY_LINES || d.length > MAX_THREE_WAY_LINES || m.length > MAX_THREE_WAY_LINES) {
    return null;
  }
  const dRegions = changedRegions(b, d);
  const mRegions = changedRegions(b, m);

  const out: string[] = [];
  const conflicts: MergeConflictChunk[] = [];
  let i = 0;
  let j = 0;
  let cursor = 0;
  while (i < dRegions.length || j < mRegions.length) {
    const dr = dRegions[i];
    const mr = mRegions[j];
    const start = Math.min(dr?.start ?? Number.POSITIVE_INFINITY, mr?.start ?? Number.POSITIVE_INFINITY);
    out.push(...b.slice(cursor, start));
    cursor = start;

    if (dr && mr && clashes(dr, mr)) {
      // 两侧改得一模一样 ⇒ 不是冲突，是同一件事被做了两遍
      if (dr.start === mr.start && dr.end === mr.end && sameLines(dr.repl, mr.repl)) {
        out.push(...dr.repl);
        cursor = dr.end;
        i += 1;
        j += 1;
        continue;
      }
      let L = Math.min(dr.start, mr.start);
      let R = Math.max(dr.end, mr.end);
      const dIsland: Region[] = [dr];
      const mIsland: Region[] = [mr];
      let di = i + 1;
      let mi = j + 1;
      for (;;) {
        const span: Region = { start: L, end: R, repl: [] };
        const nd = dRegions[di];
        const nm = mRegions[mi];
        if (nd && clashes(nd, span)) {
          dIsland.push(nd);
          L = Math.min(L, nd.start);
          R = Math.max(R, nd.end);
          di += 1;
        } else if (nm && clashes(nm, span)) {
          mIsland.push(nm);
          L = Math.min(L, nm.start);
          R = Math.max(R, nm.end);
          mi += 1;
        } else {
          break;
        }
      }
      conflicts.push({
        baseStart: L,
        baseEnd: R,
        base: b.slice(L, R).join(eol),
        disk: renderSpan(b, dIsland, L, R).join(eol),
        memory: renderSpan(b, mIsland, L, R).join(eol),
      });
      i = di;
      j = mi;
      cursor = R;
      continue;
    }

    // 单侧改动（或同起点但互不相碰）：纯插入排在改写区前面——它落在改写区之前，不是之内
    if (dr && (!mr || dr.start < mr.start || (dr.start === mr.start && dr.start === dr.end))) {
      out.push(...dr.repl);
      cursor = dr.end;
      i += 1;
      continue;
    }
    if (mr) {
      out.push(...mr.repl);
      cursor = mr.end;
      j += 1;
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  out.push(...b.slice(cursor));
  return { ok: true, text: out.join(eol) };
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

interface Region {
  /** base 行区间，0 基、含首不含末；start === end 表示"在这一行之前插入" */
  readonly start: number;
  readonly end: number;
  readonly repl: readonly string[];
}

/**
 * 两块是否算"同一区域"。
 * 插入点只在**严格落在**对方区间内部时才算相碰——紧挨着改写的行插入是两件事，
 * 不是冲突（作者最常见的"在上加一行 + 改下一行"不该被打断）。
 */
function clashes(x: Region, y: Region): boolean {
  const xIns = x.start === x.end;
  const yIns = y.start === y.end;
  if (xIns && yIns) return x.start === y.start;
  if (xIns) return y.start < x.start && x.start < y.end;
  if (yIns) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

/** 把若干改写区套进 base 的 [L,R) 区间，得出那一侧在这个区间上的实际内容 */
function renderSpan(baseLines: readonly string[], regions: readonly Region[], L: number, R: number): string[] {
  const out: string[] = [];
  let cur = L;
  for (const rg of regions) {
    out.push(...baseLines.slice(cur, rg.start));
    out.push(...rg.repl);
    cur = rg.end;
  }
  out.push(...baseLines.slice(cur, R));
  return out;
}

/**
 * a → b 的行级改写区清单（升序、互不相交）。公共头尾先削掉，中段才做 LCS；
 * 中段过大就整段算一次改写（宁可后续判成冲突，也绝不在巨型文件上跑全量动态表）。
 */
function changedRegions(a: readonly string[], b: readonly string[]): Region[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length === 0 && bm.length === 0) return [];
  if (am.length === 0 || bm.length === 0 || am.length * bm.length > MAX_LCS_CELLS) {
    return [{ start: head, end: head + am.length, repl: bm }];
  }

  const w = bm.length + 1;
  const dp = new Int32Array((am.length + 1) * w);
  const cell = (row: number, col: number): number => dp[row * w + col] ?? 0;
  for (let x = 1; x <= am.length; x += 1) {
    for (let y = 1; y <= bm.length; y += 1) {
      dp[x * w + y] = am[x - 1] === bm[y - 1]
        ? cell(x - 1, y - 1) + 1
        : Math.max(cell(x - 1, y), cell(x, y - 1));
    }
  }
  const steps: Array<{ t: 'e'; a: number } | { t: 'd'; a: number } | { t: 'i'; b: number }> = [];
  let x = am.length;
  let y = bm.length;
  while (x > 0 || y > 0) {
    if (x > 0 && y > 0 && am[x - 1] === bm[y - 1]) {
      steps.push({ t: 'e', a: x - 1 });
      x -= 1;
      y -= 1;
    } else if (x > 0 && (y === 0 || cell(x - 1, y) >= cell(x, y - 1))) {
      steps.push({ t: 'd', a: x - 1 });
      x -= 1;
    } else {
      steps.push({ t: 'i', b: y - 1 });
      y -= 1;
    }
  }
  steps.reverse();

  const regions: Region[] = [];
  let k = 0;
  while (k < steps.length) {
    const first = steps[k]!;
    if (first.t === 'e') {
      k += 1;
      continue;
    }
    const del: number[] = [];
    const repl: string[] = [];
    while (k < steps.length) {
      const step = steps[k]!;
      if (step.t === 'e') break;
      if (step.t === 'd') del.push(step.a);
      else repl.push(bm[step.b]!);
      k += 1;
    }
    const next = steps[k];
    const start = del.length > 0 ? del[0]! : next && next.t === 'e' ? next.a : am.length;
    regions.push({
      start: head + start,
      end: head + (del.length > 0 ? del[del.length - 1]! + 1 : start),
      repl,
    });
  }
  return regions;
}

/**
 * 外部改动是否影响**口上文件树**的目录列举（HK-5，2026-10-13；接 §5.87 留下的欠账）。
 *
 * 监视根是「项目根 ∪ 口上域」（见 `App.tsx` 的 `fileWatch.start`），也就是游戏运行时
 * 写存档、写图片缓存同样会投递 `file.changed`。而文件树只列举口上域里的目录，
 * 所以这里必须先做一条**零 IO 的路径分野**——否则每一次外部写入都要重列一遍树，
 * 而绝大多数写入跟树上显示的东西根本无关（§5.87 立的"首动作零 IO"纪律，这次由我自己执行）。
 */
export function affectsKojoTree(path: string, kojoPaths: readonly string[]): boolean {
  return kojoPaths.some((root) => isPathUnder(root, path));
}

/**
 * 事件合批（HK-5）：一次外部写入常常炸出多条事件（原子写的临时文件 + rename、
 * 游戏连写几份档、备份落一份）。树不需要逐条响应——**尾缘一个窗口内重列一次**即可。
 *
 * 窗口从**首条**事件起算、且**不随后续事件重置**：这是 §5.84 在内核去抖器上实测过的坑
 * （重置版在持续写入流里永远等不到落地）。这里同理：一直写 ≠ 一直不刷新。
 */
export interface EventCoalescer {
  push(): void;
  dispose(): void;
}

export function createEventCoalescer(fire: () => void, windowMs: number): EventCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(): void {
      if (timer !== null) return; // 已在窗口内排上了：不重复排、也不重置
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, windowMs);
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * 在"宿主自己打开的文件键"里找出与事件路径同指一个文件的那个（HK-7，2026-10-13）。
 *
 * 为什么需要：`file.changed` 里的路径是**平台原样透传**（见 `FileChangedEvent.path`
 * 的契约注释），而 `EditorPane` 的 entriesRef 键来自宿主自己的 `filePath`。
 * 两者在 Windows 上分隔符与大小写都不保证一致，裸字符串 `has()` 一旦判不上，
 * **外部改动跟随就静默失效**——那正是 §5.36 B1 要防的数据丢失（旧 model 随后一次
 * Ctrl+S 就覆盖掉盘上的新内容），而且**没有任何可见症状**。
 *
 * 找不到返回 null，语义就是"这个文件没在编辑器里打开，与编辑器无关"。
 */
export function matchOpenedPath<K extends string>(keys: Iterable<K>, eventPath: string): K | null {
  const want = pathKey(eventPath);
  for (const k of keys) {
    if (pathKey(k) === want) return k;
  }
  return null;
}