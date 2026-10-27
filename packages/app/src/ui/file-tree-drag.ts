/**
 * 树内拖拽的**判据层**（WS-13 2b 车；零 React、零 IO、零 DOM）。
 *
 * ## 为什么要有这么一层
 *
 * 「把选中的这几份拖到那个文件夹里」读起来是一个手势，实际是三次判决：
 * 拖的是**哪几份**（选择集还是刚按下的那一行）、落到**哪一格**（目录行 / 包行 / 分组行 /
 * 文件行所在的那一层）、这次是**移动还是复制**（Ctrl 决定）。判据若长在组件里，
 * 就只能靠"把浏览器开起来点一遍"来证明；而这里每一条边界都是会被点错的
 * （拖进自己的子树、拖回自己那一格、跨根、拖在说明行上）。
 *
 * ## 一条都不自造：全部复用既有真源
 *
 * - **拖哪些** = `file-tree-multi-selection` 的那一份多选集（本层只读它，不维护"拖拽选择集"）；
 *   按下行不在集合里时按 `planRowClick` 的既有口径收到那一行；
 * - **行种类能不能当源** = `file-tree-keyboard.rowIsClipSource`（与复制 / 剪切 / F2 / Delete 同一套）；
 * - **落到哪一格** = `file-tree-keyboard.clipTargetDirOf`（与 `explorer.pasteEntry` 同一条口径：
 *   目录行 = 它自己，文件行 = 它所在的那一层）；
 * - **非法落点** = `buildFileOpsPlan` 的 `rejected`（子树 / 跨根 / 粘回父目录 / 目录对文件同名），
 *   本层只是**提前**在悬停阶段把它的原话说出来，权威判定仍在计划层（落地时带着真实现清单重算一次）；
 * - **脏闸 / 冲突问句 / 回执** = 粘贴那条腿（`file-ops-exec` + `dirtyGateText` + `conflictQuestion`），
 *   所以这里刻意不出现第二套文案。
 *
 * ## 与既有拖拽腿的关系（不是第二条 DnD 协议）
 *
 * `ui/drag-drop.ts` 那条线走的是 **OS → Rust `kojo:drag-drop` 事件**（外部文件拖入，`data-drop-dir`
 * 坐标命中），本层走的是 **DOM 原生 HTML5 DnD**（树内行到行）。两条各认自家的载荷：
 * 外部拖入没有本层的 MIME ⇒ 本层的落点一律不接；内部拖拽没有 OS 路径 ⇒ Rust 那条不会触发。
 * MIME 的形态照 `panel-drop.PANEL_DRAG_MIME`（只在壳内流转、解码宽容、坏载荷不炸）。
 */
import { buildFileOpsPlan, type FileOpEntry, type FileOpMode, type FileOpsPlan } from './file-ops-plan';
import type { FlatRow, FlatTree } from './file-tree-flat';
import { rangePaths } from './file-tree-flat';
import { clipTargetDirOf, rowIsClipSource } from './file-tree-keyboard';
import { pkey } from './file-tree-ops';

/** 树内拖拽的自定义 MIME（只在编辑器内部流转：外部文件拖入没有这一格 ⇒ 不误触发本层） */
export const TREE_DRAG_MIME = 'application/x-kojo-tree-move';

/* ------------------------------ 载荷（编解码都是纯函数） ------------------------------ */

/**
 * 写进 `dataTransfer` 的载荷：条目清单的 JSON。
 *
 * 为什么要序列化一份进 dataTransfer：拖拽的**源集合**必须在拖起那一刻定下来（松手时
 * 多选集可能已经被别的事件改过），而落地那一步也可能已经跨了一次异步。本层的 ref 是
 * 同一个 tick 的快路径，这一格是"浏览器把事件交给别人处理时"仍能自证的慢路径。
 */
export function encodeTreeDragPayload(sources: readonly FileOpEntry[]): string {
  return JSON.stringify(sources.map((s) => [s.path, s.isDir ? 1 : 0] as [string, number]));
}

/**
 * 解载荷（**宽容解码**，形态照 `panel-drop.decodeDroppedPanelIds`）：
 * 坏 JSON / 非数组 / 元素形状不对 ⇒ 逐项剔除，绝不抛、绝不让"幽灵路径"进搬运计划。
 */
export function decodeTreeDragPayload(raw: string | null | undefined): FileOpEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FileOpEntry[] = [];
  for (const item of parsed) {
    if (!Array.isArray(item)) continue;
    const path = item[0];
    const isDir = item[1];
    if (typeof path !== 'string' || path === '') continue;
    if (isDir !== 0 && isDir !== 1) continue;
    out.push({ path, isDir: isDir === 1 });
  }
  return out;
}

/** 这次拖拽是不是本层自家的（只认 MIME，不认 text/plain——那是别的表面共用的） */
export function acceptsTreeDrop(dataTransferTypes: readonly string[]): boolean {
  return dataTransferTypes.includes(TREE_DRAG_MIME);
}

/* ------------------------------ 拖起：作用于哪几份 ------------------------------ */

export interface TreeDragSourcePlan {
  /** 这一批要搬的源（空数组 ⇒ 拖不起来，`reason` 给原因） */
  readonly sources: readonly FileOpEntry[];
  /**
   * 需要把**多选集真源**收到的那一行（null = 集合原样不动）。
   *
   * 只在"按下的那一行本来不在集合里"时给——口径与点行一致（`planRowClick` 的纯单击支：
   * 焦点与选择都收到被点的那一行）。集合真源仍是 `file-tree-multi-selection`，
   * 本层只**说该收成什么**，不自建第二份选择。
   */
  readonly collapseTo: string | null;
  /** 拖不起来的原话（`sources` 为空时必有；非空恒为 null） */
  readonly reason: string | null;
  /** 按下那一行的行号（接线侧据此把焦点带过去；行不存在 = null） */
  readonly rowId: string | null;
}

/** 空集合的两种"为什么"要说得开口的行（说明行 / 分组头），措辞与既有右键菜单一致 */
function notASourceReason(row: FlatRow): string {
  if (row.kind === 'group') {
    return `「${row.label}」是角色分组，不是一个可以搬动的条目——要搬它底下的文件，从文件行上按住拖。`;
  }
  return '这一格是说明文字，不是盘上的条目，拖不动。';
}

/**
 * 拖起判据（纯函数）。
 *
 * - 按下的那一行**已在多选集里** ⇒ 拖的是**整批**（集合里的每一项，顺序就是勾选顺序）；
 * - 按下的那一行**不在集合里** ⇒ 先把选择收到那一行（`collapseTo`），拖的就是那一行；
 * - Shift + 按下（既有连选口径，锚点 = `anchorIdx`）⇒ 先按 `rangePaths` 连选再拖整段；
 * - 集合里那些**已经不在树上**的路径一律剔除（种类必须从当场还在的行上取——把目录当文件搬
 *   就是数据事故），全空则拖不起来并说清为什么。
 */
export function planTreeDragSources(args: {
  tree: FlatTree;
  pressedIndex: number;
  selectedPaths: readonly string[];
  /** Shift 连选的锚点行（-1 = 没有锚点，退化收那一行） */
  anchorIndex?: number;
  shift?: boolean;
}): TreeDragSourcePlan {
  const { tree, pressedIndex, selectedPaths } = args;
  const row = pressedIndex >= 0 ? tree.rows[pressedIndex] : undefined;
  if (row === undefined) {
    return { sources: [], collapseTo: null, reason: '这一格眼下不在树里（可能刚被移动或删掉）——先刷新再看一眼。', rowId: null };
  }
  if (!rowIsClipSource(row)) {
    return { sources: [], collapseTo: null, reason: notASourceReason(row), rowId: row.id };
  }
  const entryOf = (r: FlatRow): FileOpEntry => ({ path: r.path, isDir: r.kind === 'dir' || r.kind === 'package' });
  const byKey = new Map<string, FlatRow>();
  for (const r of tree.rows) if (r.path !== '') byKey.set(pkey(r.path), r);
  const entriesOf = (paths: readonly string[]): FileOpEntry[] => {
    const out: FileOpEntry[] = [];
    for (const p of paths) {
      const r = byKey.get(pkey(p));
      if (r === undefined || !rowIsClipSource(r)) continue;
      out.push(entryOf(r));
    }
    return out;
  };

  // Shift：与鼠标连选同一条判据（rangePaths 只收 selectable 的行，说明行天然不在内）
  if (args.shift === true && (args.anchorIndex ?? -1) >= 0) {
    const range = rangePaths(tree, args.anchorIndex as number, pressedIndex);
    const sources = entriesOf(range);
    if (sources.length === 0) {
      return { sources: [], collapseTo: null, reason: '这一段里没有可以搬动的条目。', rowId: row.id };
    }
    return { sources, collapseTo: null, reason: null, rowId: row.id };
  }

  const inSelection = selectedPaths.some((p) => pkey(p) === pkey(row.path));
  if (inSelection) {
    // 按下的那一行自己就在集合里、又是可搬动的行 ⇒ entriesOf 至少收得出这一条，不会出现"整批空拖"
    return { sources: entriesOf(selectedPaths), collapseTo: null, reason: null, rowId: row.id };
  }
  return { sources: [entryOf(row)], collapseTo: row.path, reason: null, rowId: row.id };
}

/* ------------------------------ 移动还是复制 ------------------------------ */

/**
 * 修饰键 → 效果（VS Code 口径）：**纯拖 = 移动，Ctrl / Cmd + 拖 = 复制**。
 *
 * 只认 Ctrl / Meta 两枚：Shift 在本树里已经是连选（`planRowClick`），Alt 是"链接"的语义、
 * 本车不做——把它们也算进效果判定会让一次按键同时改选择和改模式，读起来像 bug。
 */
export function treeDragModeOf(ev: { ctrl: boolean; meta: boolean }): FileOpMode {
  return ev.ctrl || ev.meta ? 'copy' : 'move';
}

/* ------------------------------ 落点 ------------------------------ */

export interface TreeDropPlan {
  /** 能不能落（false 时 `reason` 是要说出口的那句，绝不静默） */
  readonly ok: boolean;
  /** 落点目录（拿不到 = null：说明行 / 已经不在了） */
  readonly targetDir: string | null;
  /** 这次的效果（Ctrl 决定） */
  readonly mode: FileOpMode;
  /** 悬停阶段就能说出的原因（来自计划层的 `rejected`，不另抄一份判据） */
  readonly reason: string | null;
  /** 落点行的行号（接线侧据此加高亮类；没有落点行 = null） */
  readonly rowId: string | null;
}

/**
 * 落点判据（纯函数，dragover 与 drop 共用同一条）。
 *
 * 悬停时**拿不到目标目录的真实现清单**（那是异步 IO），所以这里的计划用空现状算：
 * 名字撞不撞要等落地那一刻权威判定（`FileTree` 的 `executeFileOps` 会带着现读清单重算），
 * 本层只负责把**结构性非法**说出口——目标是源的子树、跨根、拖回自己那一格、
 * 目录与文件同名不同种（最后这条要现状才判得出，故不在悬停阶段说）。
 */
export function planTreeDropTarget(args: {
  tree: FlatTree;
  overIndex: number;
  sources: readonly FileOpEntry[];
  /** 修饰键现场（Ctrl / Meta = 复制） */
  ctrl: boolean;
  meta: boolean;
  /** 跨根判定的根清单（与剪贴板家族同一份：项目根 + 附加根 + 工作区各根） */
  roots: readonly string[];
}): TreeDropPlan {
  const mode = treeDragModeOf({ ctrl: args.ctrl, meta: args.meta });
  const row = args.overIndex >= 0 ? args.tree.rows[args.overIndex] : undefined;
  const base = { mode, rowId: row?.id ?? null, targetDir: null as string | null };
  if (row === undefined) {
    return { ...base, ok: false, reason: '这一格眼下不在树里（可能刚被移动或删掉）——先刷新再拖。' };
  }
  if (row.kind === 'note' || row.path === '') {
    return { ...base, ok: false, reason: '这一格是说明文字，不是文件夹——把东西拖到目录行、作者包行或角色分组行上。' };
  }
  const targetDir = clipTargetDirOf(row);
  if (targetDir === null || targetDir === '') {
    return { ...base, ok: false, reason: '这一格读不出它所在的文件夹——先刷新再看一眼。' };
  }
  if (args.sources.length === 0) {
    return { ...base, targetDir, ok: false, reason: '手上没有可以搬动的条目——先在树里按住要拖的文件或文件夹。' };
  }
  // 权威判据仍住计划层：这里用**空现状**跑一遍，只为把结构性非法的原话提前说出口
  const plan: FileOpsPlan = buildFileOpsPlan({
    sources: args.sources,
    targetDir,
    targetEntries: [],
    mode,
    intent: 'paste',
    roots: args.roots,
  });
  const rejected = plan.items.filter((i) => i.status === 'rejected');
  if (rejected.length === plan.items.length) {
    return { ...base, targetDir, ok: false, reason: rejected.map((i) => i.reason ?? '这一条不能搬到那里。').join('\n') };
  }
  const partial = rejected.length > 0 ? `${rejected.map((i) => i.reason ?? '').join('\n')}` : null;
  return { ...base, targetDir, ok: true, reason: partial };
}

/* ------------------------------ 悬停高亮（类名也是判据的一格） ------------------------------ */

/** 可落的落点样式类（与 B6 外部拖入**同一个类**：同一件事就该长一个样，见 styles-project.css） */
export const TREE_DROP_OK_CLASS = 'kojo-drop-hover';
/** 非法落点的样式类（如实说"这里落不下去"，不许松手没反应） */
export const TREE_DROP_NO_CLASS = 'kojo-drop-nocopy';

/** 落点该挂哪种类（纯函数：高亮的形状由判决决定，不由组件即兴） */
export function treeDropClasses(ok: boolean): readonly string[] {
  return ok ? [TREE_DROP_OK_CLASS] : [TREE_DROP_OK_CLASS, TREE_DROP_NO_CLASS];
}

/** 这一行能不能当拖拽源（接线侧据此在 DOM 上挂 `draggable`；判据与复制 / 剪切同源） */
export function rowIsDragSource(row: FlatRow | undefined): boolean {
  return rowIsClipSource(row);
}

/* ------------------------------ 拖起后的回执（措辞单源） ------------------------------ */

/**
 * 拖拽落地前那句"落不下去"的话（上屏用）。
 *
 * 为什么不直接复用 `opsResultSentence`：那一句是**落盘之后**的账（成功几项 / 跳过几项），
 * 而这里一个字节都没动、也压根没进执行层——把两种话混成一句，读者就会以为盘上变了。
 */
export function treeDropRejectSentence(reason: string): string {
  return `没有落下任何东西：${reason}`;
}
