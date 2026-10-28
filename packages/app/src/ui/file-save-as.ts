/**
 * 真「另存为」（2026-10-28 批）——**计划 + 判定 + 执行**全在这一枚纯模块里。
 *
 * ## 语义（对标 VS Code 的转档式另存为）
 *
 * 成功后**当前 buffer 变成在新路径上继续编辑**：标签头换新路径、dirty 归零、
 * 撤销栈与视图状态跟着走（同一份 Monaco model 原地换键）；**原盘文件一个字节不动**
 * ——另存为 ≠ 改名，也 ≠ 移动，账目因此按「盘上新增一个文件」通知索引，
 * 绝不复用 rename 的成对迁移语义。
 *
 * ## 通道不换（裁决的核心理由，写进提交信息）
 *
 * 落点由系统保存对话框选，但**对话框命令只交回路径、不写盘**（形态照 `pick_directory`
 * 的"只选不写"）。落盘继续走带闸的 `kernel.io`（`assertWritable` + Rust 第二道闸原路），
 * 所以另存为**只许写在写允许域 + 常驻可写根内**：目标在域外 ⇒ 诚实拒绝，文案指向『导出』。
 * 本批**没有新增第四条域外写通道**（铁律 6 只约束"写到域外"），同时保住铁律 5 的
 * 「游戏目录整体只读」——用户就算在对话框里把落点选进游戏根，这里也写不进去。
 *
 * ## 可测性（硬要求）
 *
 * 「判定」是纯函数 `judgeSaveAs`（同路径 / 域外 / 已有活 buffer / 覆盖确认 / 正常 proceed
 * 逐条可打）；「执行」拿**可注入 io**（照 `file-ops-exec.ts` 的 `FileOpsIo` 形态）；
 * 整条 `runSaveAsFlow` 在没有原生对话框时也能被单测跑通（`pick` 本身就是注入缝）。
 *
 * ## 覆盖确认只弹一次
 *
 * 桌面壳的原生保存对话框（rfd `save_file`）选中已存在文件时**自己就弹覆盖确认** ⇒
 * `dialogConfirmsOverwrite = true`，本模块不再二次弹（裁决：别弹两次）；覆盖前照样
 * `backup(to)` 留退路（与 `file-ops-exec` 的覆盖纪律同条：备份没成就不盖）。
 * 落点经**注入缝**交回且宿主没让对话框确认覆盖时（`dialogConfirmsOverwrite = false`），
 * 判出 `confirm-overwrite`，由调用方的应用内确认兑现——两条分支都许单测钉住。
 */
import { errorText, pathKey, type FileEncoding } from '@kojo/plugin-api';
import { writeDomainSaveBlockedMessage } from './write-domain';

/** 域外拒绝的那句人话（铁律 5/6：另存为没有域外通道，出路只有『导出』或加根） */
export const SAVE_AS_OUT_OF_DOMAIN_MESSAGE =
  '另存为只能写进已批准的写允许域（含常驻可写根）：这个位置写不进去，一个字节都没落。' +
  '要落到域外请走『导出』（法定通道 exportFile——对话框即授权，如项目面板的导出制品），或先把目标文件夹加进可写范围。';

/** 目标已有活 buffer 的那句人话（绝不出现两格同路径） */
export const SAVE_AS_OPEN_BUFFER_MESSAGE =
  '目标位置已经有一格打开的文件——同一路径不许挂两格 buffer。先关掉那一格，再另存为。';

/** 判定入参（对话框**之后**、落盘**之前**取齐；全部是当下事实，不缓存） */
export interface SaveAsJudgeFacts {
  readonly currentPath: string;
  /** 对话框交回的候选落点；`null` = 用户取消 */
  readonly candidate: string | null;
  /** 内核 `io.isWritable`（TS 第一道闸） */
  readonly targetWritable: boolean;
  /** 宿主准入门拒过的目录（与保存按钮置灰同一个判定，`saveBlockedByHostWriteDomain`） */
  readonly hostBlocked: boolean;
  /** 候选落点上已站着**别的**活 buffer（不含当前路径——同路径先判走普通保存） */
  readonly targetHasLiveBuffer: boolean;
  /** 盘上已有同名文件（覆盖分支的判据） */
  readonly targetExistsOnDisk: boolean;
  /** 原生保存对话框自己会弹覆盖确认（桌面壳 = true；注入缝 = false 走应用内确认） */
  readonly dialogConfirmsOverwrite: boolean;
}

/** 判定结果（判别联合：执行层对每格各说各的话，不静默） */
export type SaveAsDecision =
  | { kind: 'cancelled' }
  /** 目标 === 当前路径 ⇒ 不另存，走普通保存链（VS Code 同款收口） */
  | { kind: 'save-current' }
  | { kind: 'reject'; reason: string }
  | { kind: 'confirm-overwrite'; target: string }
  | { kind: 'proceed'; target: string; overwrite: boolean };

/**
 * 纯判定：**拒绝全部写在落盘之前**（裁决 3），逐条给人话。
 * 次序 = 取消 → 同路径 → 写域 → 宿主准入 → 活 buffer → 覆盖 → proceed。
 */
export function judgeSaveAs(f: SaveAsJudgeFacts): SaveAsDecision {
  if (f.candidate === null) return { kind: 'cancelled' };
  if (pathKey(f.candidate) === pathKey(f.currentPath)) return { kind: 'save-current' };
  if (!f.targetWritable) return { kind: 'reject', reason: SAVE_AS_OUT_OF_DOMAIN_MESSAGE };
  if (f.hostBlocked) return { kind: 'reject', reason: writeDomainSaveBlockedMessage };
  if (f.targetHasLiveBuffer) return { kind: 'reject', reason: SAVE_AS_OPEN_BUFFER_MESSAGE };
  if (f.targetExistsOnDisk) {
    return f.dialogConfirmsOverwrite
      ? { kind: 'proceed', target: f.candidate, overwrite: true }
      : { kind: 'confirm-overwrite', target: f.candidate };
  }
  return { kind: 'proceed', target: f.candidate, overwrite: false };
}

/* ------------------------------ 执行层（可注入 io） ------------------------------ */

/**
 * 写盘需要的**最小 IO 面**（`kernel.io` 的结构子集；测试拿假 io 跑整条链）。
 * `encodeForSave` / `adoptEncoding` 缺席 ⇒ 明说缺能力，绝不退回裸 `writeText`
 * （编码保真是本批的硬口径，见裁决 4）。
 */
export interface SaveAsExecIo {
  exists(path: string): Promise<boolean>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  encodeForSave?(path: string, text: string, encoding: FileEncoding): Promise<Uint8Array>;
  adoptEncoding?(path: string, encoding: FileEncoding, bytes: Uint8Array): void;
  backup?(path: string): Promise<string | null>;
  forgetPathCaches?(path: string): void;
}

export interface SaveAsWriteInput {
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly encoding: string;
  readonly overwrite: boolean;
}

/**
 * 字节编排（与 `encoding-actions.saveWithEncoding` 同源的那半）：
 * 现 buffer 文本 → 按**源路径**的编码判据编字节（`encodeForSave(from, …)` 吃旧键的
 * 换行指纹，落点拿到的是逐字节同源的真相）→（覆盖时）先 `backup(to)` 留退路 →
 * `writeBytes(to)`（写域双闸照旧）→ `adoptEncoding(to)` 用刚写的字节立新键判据 →
 * `forgetPathCaches(from)` 让旧键的全部判据退役。
 */
export async function writeSaveAsBytes(io: SaveAsExecIo, input: SaveAsWriteInput): Promise<void> {
  const encode = io.encodeForSave;
  const adopt = io.adoptEncoding;
  if (encode === undefined || adopt === undefined) {
    throw new Error('当前 IO 实现不支持显式编码另存（缺 encodeForSave / adoptEncoding；需要桌面壳或新版内核）');
  }
  const bytes = await encode.call(io, input.from, input.text, input.encoding as FileEncoding);
  if (input.overwrite) {
    if (io.backup === undefined) {
      throw new Error('这个环境没有「覆盖前先把原内容写进本地历史」的通道，已停止覆盖。');
    }
    await io.backup(input.to); // 备份没成会抛 ⇒ 不盖（file-ops-exec 同一条覆盖纪律）
  }
  await io.writeBytes(input.to, bytes);
  adopt.call(io, input.to, input.encoding as FileEncoding, bytes);
  io.forgetPathCaches?.(input.from);
}

/* ------------------------------ 整条流（对话框缝 + 判定 + 落盘 + 转档回调） ------------------------------ */

/** 落盘前读到的缓冲区真相（`version` 是竞态守卫的尺子，与保存链同口径） */
export interface SaveAsSource {
  readonly text: string;
  readonly encoding: string;
  readonly version: number;
}

export interface SaveAsFlowDeps {
  readonly currentPath: string;
  readonly io: SaveAsExecIo;
  /** 对话框注入缝：交回候选落点，`null` = 取消；抛错 = 平台没这能力（如实上屏） */
  pick(opts: { title?: string; defaultFileName?: string }): Promise<string | null>;
  isWritable(path: string): boolean;
  hostBlocked(path: string): boolean;
  /** 别的标签正站在这一路径上（判等走 `pathKey`，由宿主用全组 tabs 现算） */
  hasLiveBuffer(path: string): boolean;
  /** 当前 buffer 的真相；undefined = 这一格已不在编辑器里（对话框途中被关掉等） */
  readSource(path: string): SaveAsSource | undefined;
  /** 同路径分支：走普通保存链（通知与回执由既有保存自己发） */
  saveCurrent(): Promise<boolean>;
  /** 应用内覆盖确认（仅 `dialogConfirmsOverwrite=false` 的形态会走到） */
  confirmOverwrite?(target: string): boolean | Promise<boolean>;
  /**
   * 落盘成功后的**转档收尾**：池记录换键 + 编辑器侧登记随迁 + 壳层标签/脏态/固定态/
   * 视图状态/索引增量/最近文件/journal。`clean` = 写窗口内 model 版本未变（竞态守卫：
   * 变了就保持脏，与保存链 `kept-dirty` 同一口径）。
   */
  onTransferred(from: string, to: string, clean: boolean): void | Promise<void>;
  notify(kind: 'info' | 'error', message: string): void;
  readonly dialogConfirmsOverwrite: boolean;
}

export type SaveAsFlowResult =
  | { kind: 'saved-as'; target: string }
  | { kind: 'saved-current' }
  | { kind: 'cancelled' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; message: string };

/** 一句人话把对话框标题与预填名造好（预填 = 当前文件名，与 VS Code 同形） */
export function saveAsFileName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 整条另存为流（顺序即承诺）：读源 → 弹框 → **对话框之后**取齐当下事实再判 →
 * 落盘（写域闸内）→ 竞态复核 → 转档收尾 → 一句成功上屏。
 * 判定拒了/取消了 ⇒ 一个 IO 写动作都不发。
 */
export async function runSaveAsFlow(deps: SaveAsFlowDeps): Promise<SaveAsFlowResult> {
  const prelude = deps.readSource(deps.currentPath);
  if (prelude === undefined) {
    return { kind: 'failed', message: '标签已不在编辑器中' };
  }
  let candidate: string | null;
  try {
    candidate = await deps.pick({ title: '另存为', defaultFileName: saveAsFileName(deps.currentPath) });
  } catch (e: unknown) {
    const msg = errorText(e);
    deps.notify('error', `另存为的落点对话框没有打开：${msg}`);
    return { kind: 'failed', message: msg };
  }
  // 判定要的四份事实全部现读（对话框开着的那段时间里盘与标签都可能变）。
  // **任何一枚读不出来 ⇒ 一律当"不许落盘"处理并出声**：这四枚里任何一枚抛错都发生在
  // 落盘之前，静默让路（把异常抛回调用方）会被 `ProjectView` 那侧的 `void onSaveAs()`
  // 吞成一枚未处理 rejection ⇒ 作者按下「另存为…」、选了一个写不进去的位置，屏上
  // 一个字都不出现（2026-10-28 真壳实拍：web 宿里 `io.exists` 对域外落点抛错就是这一形）。
  // 铁律 4「内核不静默」在这条流里的落点就是这里：宁可拒得保守，不可无声。
  let facts: {
    targetWritable: boolean;
    hostBlocked: boolean;
    targetHasLiveBuffer: boolean;
    targetExistsOnDisk: boolean;
  };
  try {
    facts = {
      targetWritable: candidate !== null && deps.isWritable(candidate),
      hostBlocked: candidate !== null && deps.hostBlocked(candidate),
      targetHasLiveBuffer: candidate !== null && deps.hasLiveBuffer(candidate),
      targetExistsOnDisk: candidate !== null && (await deps.io.exists(candidate)),
    };
  } catch (e: unknown) {
    const msg = errorText(e);
    deps.notify(
      'error',
      `另存为没有落盘：读落点的事实时出了错，一个字节都没写。（${msg}）` +
        '域外的位置只有两条出路——走『导出』（法定通道 exportFile），或先把目标文件夹加进可写范围。',
    );
    return { kind: 'failed', message: msg };
  }
  const decision = judgeSaveAs({
    currentPath: deps.currentPath,
    candidate,
    ...facts,
    dialogConfirmsOverwrite: deps.dialogConfirmsOverwrite,
  });

  switch (decision.kind) {
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'save-current': {
      const ok = await deps.saveCurrent();
      return ok ? { kind: 'saved-current' } : { kind: 'failed', message: '普通保存没有落成功' };
    }
    case 'reject':
      deps.notify('error', decision.reason);
      return { kind: 'rejected', reason: decision.reason };
    case 'confirm-overwrite': {
      const yes = deps.confirmOverwrite === undefined ? false : await deps.confirmOverwrite(decision.target);
      if (!yes) {
        deps.notify('info', '已取消覆盖——目标文件原样没动，另存为一格字节都没写。');
        return { kind: 'cancelled' };
      }
      return finishWrite(deps, decision.target, true);
    }
    case 'proceed':
      return finishWrite(deps, decision.target, decision.overwrite);
  }
}

/** 落盘 + 竞态复核 + 转档（proceed 与确认后的 overwrite-confirm 共用同一条腿） */
async function finishWrite(
  deps: SaveAsFlowDeps,
  to: string,
  overwrite: boolean,
): Promise<SaveAsFlowResult> {
  const from = deps.currentPath;
  // 文本在**落盘时刻**现读（对话框开着的那段时间里作者可能又打了字）
  const source = deps.readSource(from);
  if (source === undefined) return { kind: 'failed', message: '标签已不在编辑器中' };
  try {
    await writeSaveAsBytes(deps.io, { from, to, text: source.text, encoding: source.encoding, overwrite });
  } catch (e: unknown) {
    const msg = errorText(e);
    deps.notify('error', `另存为失败：${msg}`);
    return { kind: 'failed', message: msg };
  }
  // 写窗口竞态守卫（与保存链 A1 同口径）：窗口内又来了新输入 ⇒ 转档照做、**不立基线**，
  // 标签保持脏，下一次 Ctrl+S 走既有保存把新字补落。
  const after = deps.readSource(from);
  const clean = after !== undefined && after.version === source.version;
  await deps.onTransferred(from, to, clean);
  deps.notify(
    'info',
    clean
      ? `已另存为 ${to}——编辑已转到新路径继续，原文件一个字节未动。`
      : `已另存为 ${to}，但落盘窗口内又有新输入——文件仍标记未保存。`,
  );
  return { kind: 'saved-as', target: to };
}
