import type * as Monaco from './entry';
import type {
  EditorProjectFile,
  EditorRenameEdit,
  EditorRenameRelated,
  EditorRenameRequest,
  EditorRenameResult,
  EditorRenameTargetRequest,
  EditorRenameTargetResult,
  EditorSymbolLocation,
  ErbReferenceKind,
  GameProject,
} from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import { createPositionIndex } from '@kojo/kojo-core';
import { ERB_LANGUAGE_ID } from './erb-language';
import { reject } from './rename-rejection';
import { erbFactsPathOf } from './erb-completion-declared';
import type { RenameLandedInput, RenamePreviewInput } from '../ui/rename-preview';
import { renamePlanFilesOf } from '../ui/rename-preview';
import {
  findNameTokenPositions,
  isCallShapedMention,
  isSugarSourcePath,
  languageOfPath,
  mergeOccurrences,
  planReferenceWrites,
  readOnlyFilesReason,
  rewriteClosedFile,
  type ClosedFileIo,
  type ReferenceLanguage,
  type ReferenceOccurrence,
} from '../ui/reference-utils';

/**
 * ERB 函数重命名（F2 / `editor.action.rename`）——**宿主翻译层**
 * （LAU-4 导航腿，2026-10-30：判据已搬进插件 `@kojo/plugin-erb-parser`）。
 *
 * ## 这一格里只剩"宿主才知道的事"
 *
 * 判据（什么词可改名 / `$` 标签作用域 / 引用全集 / 跨语言全或无）整块搬进了解析器插件的
 * `src/symbols.ts`，由槽 `ui.editor.languageService` 的 `renameTarget` / `rename` 两个成员
 * 应答。本文件留下三件宿主事实：
 *
 * 1. **model / 位置 → 请求**：活动标签的真 model 判据（`canAnswer`，派生预览面不参与）、
 *    身份三格与全文；
 * 2. **契约 → Monaco 形状**：`EditorRenameTarget` → `RenameLocation`；`EditorRenameEdit`
 *    → `WorkspaceEdit`；`rejectReason` → Monaco 拒绝；
 * 3. **落盘通道**：已打开文件进 `WorkspaceEdit`（Monaco 原生落地——脏标记、撤销步、
 *    marker 全套现成）；未打开文件经内核 io 读改写（保编码保换行 + 原子写 + 备份，
 *    写允许域由内核 io 强制）。**只读闸门是写域策略，不是语言判据**：它问的是内核
 *    `io.isWritable`，与保存按钮同源。
 *
 * ## 跨语言腿（W8 XLANG-RENAME）：宿主编排，判据不搬
 *
 * `.kojo1` 是源、`.erb` 是产物：只改 `.erb` 时下一次保存会把按旧名重新生成的产物盖回。
 * "哪些 `.kojo1` 记号属于这个函数"的判据在糖线供方（转译器当判官），而**供方之间不能
 * 互问**——所以宿主做两件事：枚举候选源（已开标签 + `kojoSources`）并逐个问 references 槽，
 * 把结果当**数据**塞进 `EditorRenameRequest.related`；"判据缺席 ⇒ 整次拒绝"的裁决在插件里
 * （`related.unprovable`）。宿主只搬运，不解释。
 *
 * 候选口径 = **转译产物的来源**（ERB-PARITY G7）：只有 v1 糖源（`.kojo1`）会把 `.erb`
 * 生成回来；2.0 的 `.kojo` / `.kojo2` 不产出 `.erb`，它们的同名记号属于 2.0 自己的命名空间，
 * 列进候选就是"列得出、判不了"。判据单源 `ui/reference-utils` 的 `isSugarSourcePath`。
 *
 * ## 双通道送达的取证（monaco 0.57 standalone 源码，两种通道各管一半）
 *
 * `StandaloneBulkEditService.apply` 对**没有 live model 的 resource 直接抛**
 * `bad edit - model not found`（`standaloneServices.js:527`），而改名落点遍布全项目
 * （真语料 2,325 份文件，绝大多数没开标签）⇒ WorkspaceEdit 通道只可能送达**已打开的标签**。
 * 未打开文件走 `createApplyToClosedFile`（与搜索面板「全部替换」共用 `rewriteClosedFile`，
 * 两边不可能再分叉）。
 *
 * ## 全或无的最后一道（写盘纪律，住宿主）
 *
 * monaco 0.57 的 rename 控制器见到返回值带 `rejectReason` 会**丢弃全部编辑只弹 info**
 * （`rename.js:241`），没有"部分应用 + 提示"的通道——所以 rejectReason 与"已经落到盘上的
 * 改动"**永不同时返回**：一处盘上改动都没发生 ⇒ 拒绝（真全或无）；已有落点后再失败 ⇒
 * 不再拒绝，把算好的 WorkspaceEdit 交付并 warn 失败文件（此时拒绝 = 标签回退而盘上半套，
 * 更糟）。
 *
 * ## 陈旧索引防误写（同一条纪律，住宿主）
 *
 * 索引与现场文本之间没有锁。每一处编辑落地前都做**文本验证**（该列区间上现在是不是原名，
 * 大小写不敏感）；不匹配（作者已改写 / 行号漂移 / 行越界）⇒ 跳过该处并计数上报——
 * **绝不按陈旧坐标硬写**。闭文件侧由 `rewriteClosedFile` 在读出文本上做同一件事。
 *
 * ## 散文跳过（"改名不重写散文"）
 *
 * 供方交回的编辑带 `occurrenceKind`；`mention` 且名字后不是 `(` 的 ERB 词法出现点是台词
 * 散文 ⇒ 跳过（判据 `isCallShapedMention` 单源，与搜索替换共用）。`.kojo` 腿的 mention 是
 * 探针证明的真引用，不受此闸影响。
 *
 * ## 改动清单上屏（KW-12，2026-11-03）：改之前看得见改哪里
 *
 * standalone 的 rename 控制器没有预览面：provider 一返回就把编辑糊进已开标签，未打开文件
 * 更是在这一格里就直接写盘 ⇒ 多文件改名在按下回车**之前**用户看不到清单。本腿因此在两个
 * 拍点把数据交给呈现层（`handlers.onRenamePreview` / `onRenameLanded`，文案与订阅都在
 * `ui/rename-preview.ts`，本文件只递读数）：
 *
 * 1. **求值那一拍**（`resolveRenameLocation` 命中之后、输入框弹出之前）：问**同一枚** `rename`
 *    成员拿方言面的编辑集（`newName` 用原词自问自答——插件对"改回自己"是合法判定，落的还是
 *    同一批坐标），过**同一个** `planReferenceWrites` 闸门 ⇒ 逐文件「几处 / 可不可写 /
 *    开没开标签」的清单。糖源腿**不**在这一拍跑（`collectKojoLeg` 要枚举并读回全项目
 *    `.kojo1`，会把输入框卡住），所以这条清单如实标 `deferred`，落地那条再交全表。
 * 2. **落地之后**：闭文件实写数 / 编辑器内待应用处数 / 陈旧跳过 / 散文跳过 / io 写失败逐条
 *    ——过去只有 `console.warn` 的四样，屏上从此有读数。
 *
 * 只读落点另有一条**硬回执**：`readOnlyFilesReason` 现在把「哪几个文件、各几处」点名进
 * Monaco 的拒绝信息条（文案真源仍在 `ui/reference-utils.ts`，旧断言的
 * 「n 个文件只读未纳入」前缀逐字保留），不再只报一个数。
 */

/* ============================== 纯逻辑：编辑分组与只读剔除 ============================== */

/** 一处落点的最小区间（`ErbReference` 与 `.kojo` 台账项的共同形状——两种语言共用同一个改写器） */
export interface RenameSpan {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  /** 出现点分类（可选；散文跳过判据只认 **ERB 词法 mention**——`.kojo` 腿的 mention 是探针证明的真引用） */
  readonly kind?: ErbReferenceKind;
  /** 语言轴（可选；散文跳过判据只拦 erb 侧——kojo 侧的 mention 全数可写） */
  readonly language?: ReferenceLanguage;
}

/**
 * 每行的 0 基起始偏移（`text` 按 `\r\n` / `\n` 分行，行偏移含换行长度）。
 *
 * 行首表实现是 core `positions.ts::createPositionIndex`（POS-UTIL 收口）——本函数只把
 * 「第 n 行 + 1 基列 → 绝对偏移」这条路交给它，不再自建第二张行首表。
 */
function lineStartOffsets(text: string): number[] {
  return [...createPositionIndex(text).lineStarts];
}

export interface AppliedReferenceEdits {
  readonly text: string;
  readonly applied: number;
  /** 文本验证不过（名字已改写 / 行漂移 / 行越界）而跳过的引用点数 */
  readonly stale: number;
  /** **ERB 词法** mention 且现文本非调用形（名字后无 `(`）而跳过的处数——「改名不重写散文」 */
  readonly skippedProse: number;
}

/**
 * 把引用点列区间改写进整篇文本（**纯函数**；闭文件 io 通道与单测共用，
 * `.erb` 与 `.kojo` 两种落点同走这里——入参只要求区间，不要求语言）。
 *
 * 每处引用先验证：该区间上的现文本 == 原名（大小写不敏感，与索引归一口径一致）；
 * 不匹配 ⇒ 跳过并计 `stale`（陈旧索引绝不做哑替换）。文件整体只读/写失败由调用方
 * （内核 io）兜住，本函数不碰磁盘。
 */
export function applyReferenceEdits(
  text: string,
  refs: readonly RenameSpan[],
  newName: string,
  normalizedName: string,
): AppliedReferenceEdits {
  const starts = lineStartOffsets(text);
  const lineCount = starts.length;
  // 绝对偏移降序替换：前面的偏移才不会因替换而位移
  const ops: Array<{ at: number; end: number }> = [];
  let stale = 0;
  let skippedProse = 0;
  for (const ref of refs) {
    if (ref.line < 1 || ref.line > lineCount) {
      stale++;
      continue;
    }
    const at = starts[ref.line - 1]! + ref.column - 1;
    const end = starts[ref.line - 1]! + ref.endColumn - 1;
    if (at < 0 || end > text.length || at > end) {
      stale++;
      continue;
    }
    if (text.slice(at, end).toUpperCase() !== normalizedName) {
      stale++;
      continue;
    }
    // ERB 词法 mention 的落盘判据（isCallShapedMention 单源，**只拦 erb 侧**）：条件表达式位的
    // 真调用（`SIF FOO() == 0`——CALL 直系族表只认 CALL 系，条件位在索引里退化为 mention）
    // 照改；未加引号输出行里的同名词（`PRINTFORML キスする。`）是台词散文 ⇒ 跳过。
    // `.kojo` 腿的 mention 是探针证明的真引用（语义不同源），不受此闸影响。
    if (ref.kind === 'mention' && ref.language === 'erb' && text[end] !== '(') {
      skippedProse++;
      continue;
    }
    ops.push({ at, end });
  }
  ops.sort((a, b) => b.at - a.at);
  let next = text;
  for (const op of ops) {
    next = next.slice(0, op.at) + newName + next.slice(op.end);
  }
  return { text: next, applied: ops.length, stale, skippedProse };
}

/**
 * 供方的编辑集 → 出现点台账（**纯函数**；`resourcePath` 缺省 = 请求文件本身）。
 *
 * 为什么绕这一圈而不是直接按 `EditorRenameEdit` 分组：分组 / 去重 / 只读闸门必须与搜索面板
 * 「全部替换」**同一份实现**（`ui/reference-utils` 的 `planReferenceWrites`）——两边各写一套
 * 就只会在"哪些点算同一个位置""只读怎么算"上漂。`occurrenceKind` 原样带成台账的 `kind`
 * （散文跳过判据只认它；跨语言腿的编辑不标 kind，见插件的 `relatedEdits`）。
 */
function occurrencesOf(
  edits: readonly EditorRenameEdit[],
  requestPath: string,
): ReferenceOccurrence[] {
  return edits.map((edit) => {
    const filePath = edit.resourcePath ?? requestPath;
    return {
      filePath,
      line: edit.line,
      column: edit.startColumn,
      endColumn: edit.endColumn,
      ...(edit.occurrenceKind === undefined ? {} : { kind: edit.occurrenceKind }),
      language: languageOfPath(filePath),
    };
  });
}

/* ============================== 跨语言腿：宿主编排（零语言判据） ============================== */

/** `kojoSources` 的产出：一份 `.kojo1` 糖源文件的路径与全文 */
export interface KojoSourceFile {
  readonly filePath: string;
  readonly text: string;
}

/** 交给糖线判读的一处候选（文件 + 该文件内某个同名记号的起点） */
export interface KojoReferenceProbe {
  readonly filePath: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

/** 跨语言腿的读数：可证明的 `.kojo` 出现点 + 判据缺席、无法证明的项（每项一句给作者看的label） */
interface KojoLeg {
  readonly occurrences: EditorSymbolLocation[];
  readonly unprovable: string[];
  /** 候选源文（标签改名的逐行守卫要用；函数腿忽略） */
  readonly sources: EditorProjectFile[];
}

/** 一份候选源判据缺席时的label（文件 + 该文件内同名记号处数） */
const unprovableFileLabel = (filePath: string, positions: number, note?: string): string =>
  `'${filePath}'（${positions} 处${note === undefined ? '' : `，${note}`}）`;

/**
 * 枚举 `.kojo1` 候选源（**已开标签 + 宿主枚举**，路径归一后去重）。
 *
 * 只做"找到候选文件"，不判"哪些记号算引用"——后者在糖线供方（转译器当判官），
 * 本函数零糖语法知识。
 *
 * **候选口径 = 转译产物的来源**（ERB-PARITY G7）：只认 v1 糖源（`isSugarSourcePath`，
 * 即 `.kojo1`）。2.0 的 `.kojo` / `.kojo2` 不生成 `.erb`，它们的同名记号属于 2.0 自己的
 * 命名空间（有各自的引用 / 改名腿）——列进候选只会让糖线答不上来（整批拒绝）或按 2.0
 * 引用面改错文件。两条取数腿共用同一枚判据：已开标签按**路径**判（不再按语言 id，
 * 因为 `.kojo` 与 `.kojo1` 是两门语言、同一扩展名族），宿主枚举回来的也按它过滤。
 */
async function collectKojoCandidates(
  monaco: typeof Monaco,
  handlers: ErbRenameHandlers,
  normalizedName: string,
): Promise<{ readonly candidates: Map<string, string>; readonly error?: string }> {
  const candidates = new Map<string, string>();
  const getModels = monaco.editor?.getModels;
  if (typeof getModels === 'function') {
    for (const model of getModels.call(monaco.editor)) {
      try {
        // 派生预览 model（`inmemory://sugar/`）的行列属于派生物，不是盘上的源
        if (model.uri.scheme !== 'file') continue;
        const filePath = model.uri.fsPath || model.uri.path;
        if (!filePath || !isSugarSourcePath(filePath)) continue;
        candidates.set(filePath, model.getValue());
      } catch (e: unknown) {
        console.warn(`[erb-rename] 已开 .kojo1 标签枚举失败：${errorText(e)}`);
      }
    }
  }
  if (handlers.kojoSources) {
    try {
      for (const file of await handlers.kojoSources(normalizedName)) {
        if (isSugarSourcePath(file.filePath)) candidates.set(file.filePath, file.text);
      }
    } catch (e: unknown) {
      // 枚举抛错 = **看不见**未打开的 .kojo1 源（判据不是"这份源没有这个记号"，是"我没看见它"）。
      return { candidates, error: `宿主 .kojo1 源枚举抛错（${errorText(e)}）——未打开的 .kojo1 源无从查证` };
    }
  }
  return { candidates };
}

/**
 * `.erb` 函数改名时把生成它的 `.kojo1` 糖源一起收进台账（**同一条全或无判定**）。
 *
 * 判读全在糖线：本函数只负责"找到候选文件"与"问一次槽"，把回来的位置原样交回——
 * "这些记号是不是这个函数的引用"由供方答，"判据缺席怎么办"由 ERB 改名供方裁决。
 */
async function collectKojoLeg(
  monaco: typeof Monaco,
  handlers: ErbRenameHandlers,
  normalizedName: string,
): Promise<KojoLeg> {
  const { candidates, error } = await collectKojoCandidates(monaco, handlers, normalizedName);
  if (error !== undefined) return { occurrences: [], unprovable: [error], sources: [] };
  const occurrences: EditorSymbolLocation[] = [];
  const unprovable: string[] = [];
  const sources: EditorProjectFile[] = [];
  for (const [filePath, text] of candidates) {
    const positions = findNameTokenPositions(text, normalizedName);
    if (positions.length === 0) continue; // 这份源里没有同名记号 ⇒ 与本动作无关
    sources.push({ path: filePath, text });
    if (!handlers.kojoReferences) {
      // 判据缺席 ⇒ 无从知道这些记号是不是函数引用。改了 .erb 却漏了生成它的 .kojo 源
      // = 下次保存把改名冲掉（数据损坏），不改只是这一批不走 —— 只能拒绝（插件裁决）。
      unprovable.push(unprovableFileLabel(filePath, positions.length, '引用判读未接入'));
      continue;
    }
    const first = positions[0]!;
    let locations: readonly EditorSymbolLocation[];
    try {
      locations = await handlers.kojoReferences({ filePath, text, line: first.line, column: first.column });
    } catch (e: unknown) {
      // 判读抛错 ≠ 判官答"这些记号不是函数引用"（那必须是**正常返回空集**）。
      unprovable.push(unprovableFileLabel(filePath, positions.length, `判读抛错：${errorText(e)}`));
      continue;
    }
    // 只收本文件的判读结果（糖线引用面是文件局部的，规范 §7.2；越界一律不收，不猜）
    for (const location of locations) {
      if (location.filePath !== filePath) continue;
      occurrences.push(location);
    }
  }
  return { occurrences, unprovable, sources };
}

/* ============================== Monaco 协议翻译 ============================== */

/** 宿主注入：怎么应答（活动标签判据）、问哪枚槽、写权限与落盘通道 */
export interface ErbRenameHandlers {
  /**
   * 该不该应答这次请求：只认**当前活动标签的真 model**。派生预览 model 的行列属于
   * 派生物，重命名它改的不是真文件（与 codeAction / 转到定义同一判据）。
   */
  canAnswer(model: Monaco.editor.ITextModel): boolean;
  /** 问槽：改名求值（`renameTarget`；`undefined` = 无人应答 / 弃权） */
  resolveTarget(request: EditorRenameTargetRequest): EditorRenameTargetResult | undefined;
  /** 问槽：改名（`rename`；单答型） */
  resolveRename(request: EditorRenameRequest): EditorRenameResult | undefined;
  /** 写权限判定（内核 io `isWritable`，与保存同源口径） */
  isWritable(path: string): boolean;
  /** 当前项目（契约请求的 `project` 位；软取，缺席 = `null`——判据不读它） */
  currentProject?(): GameProject | null;
  /** 文件路径 → 已打开标签的 live model（查不到 = 未打开，走 io 通道） */
  openModelFor(path: string): Monaco.editor.ITextModel | undefined;
  /**
   * 未打开文件的落盘通道（内核 io 读改写：保编码保换行 + 原子写 + 备份）。
   * 返回实改 / 跳过计数；抛错 = 这次写被内核拒绝（写允许域 / io 故障）。
   * 现成实现见 `createApplyToClosedFile`（与搜索面板「全部替换」同一条通道）。
   */
  applyToClosedFile(
    path: string,
    spans: readonly RenameSpan[],
    newName: string,
    normalizedName: string,
  ): Promise<{ applied: number; stale: number; skippedProse?: number }>;
  /**
   * **跨语言腿 ①**：归一化名可能出现在哪些 `.kojo1` 糖源里（宿主枚举 + 读文，
   * 内核 io 的读权限由宿主兜）。缺席 = 只能看到**已打开标签**里的 `.kojo1` 源。
   */
  kojoSources?(normalizedName: string): Promise<readonly KojoSourceFile[]> | readonly KojoSourceFile[];
  /**
   * **跨语言腿 ②**：`.kojo1` 糖源里这一处记号**是不是**这个函数的引用
   * （宿主查 `ui.editor.languageService` 槽的 `references` 成员）。缺席 ⇒ 该文件的同名记号
   * 判为"不可证明" ⇒ 插件整次拒绝（绝不静默改一半）。
   */
  kojoReferences?(
    probe: KojoReferenceProbe,
  ): Promise<readonly EditorSymbolLocation[]> | readonly EditorSymbolLocation[];
  /**
   * **改动清单（KW-12）· 预览拍**：求值命中之后、输入框弹出之前递出逐文件清单。
   *
   * 缺席 = 不上屏（本腿的落地行为一字不变——预览是**只读的一问**，不写盘、不改编辑集）。
   * 抛错被吞（清单炸了不许把 F2 一起带走）。
   */
  onRenamePreview?(summary: RenamePreviewInput): void;
  /**
   * **改动清单（KW-12）· 落地拍**：编辑算完、交回 Monaco 之前递出"真的落到了哪里 + 哪些没落"。
   *
   * 陈旧跳过 / 散文跳过 / 闭文件写失败过去只有 `console.warn`，这一枚把它们抬到屏上（铁律 4）。
   */
  onRenameLanded?(report: RenameLandedInput): void;
  /**
   * 一句"为什么这一份写不进去"（{@link renamePlanFilesOf} 的呈现用）。
   *
   * **不是第二把可写性尺子**：能不能写只由 `isWritable` 判过，这里只在判完不可写之后
   * 拿区域分野（`ui/file-area.ts`）补一句人话。缺席 = 只点名文件不解释原因。
   */
  describeUnwritable?(path: string): string;
}

/** live model 上的现文本验证：该列区间现在是不是这个名字（大小写不敏感；越界 = 不匹配） */
function liveEditMatches(
  model: Monaco.editor.ITextModel,
  occurrence: { readonly line: number; readonly column: number; readonly endColumn: number },
  oldName: string,
): boolean {
  if (occurrence.line < 1 || occurrence.line > model.getLineCount()) return false;
  const line = model.getLineContent(occurrence.line);
  const at = occurrence.column - 1;
  const end = occurrence.endColumn - 1;
  if (at < 0 || end > line.length || at > end) return false;
  // 索引归一口径：名字大小写不敏感（`call m_kojo_a()` 与 `M_KOJO_A` 是同一个函数）
  return line.slice(at, end).toUpperCase() === oldName.toUpperCase();
}

/**
 * 未打开文件的落盘通道**唯一实现**（内核 io 读改写：保编码保换行 + 原子写 + 备份）。
 *
 * 与搜索面板「全部替换」共用 `rewriteClosedFile` 的同一条纪律（先闸写权限、在现文本上
 * 验证、有实改才写回），所以 rename 与替换不可能在"怎么落盘"上分叉——
 * 宿主接线只需 `applyToClosedFile: createApplyToClosedFile(kernel.io)`。
 */
export function createApplyToClosedFile(io: ClosedFileIo): ErbRenameHandlers['applyToClosedFile'] {
  return (path, spans, newName, normalizedName) =>
    rewriteClosedFile(io, path, (text) => applyReferenceEdits(text, spans, newName, normalizedName));
}

/** 模型全文（取不到 ⇒ 空串；重命名拿不到全文就没什么可判的） */
function modelText(model: Monaco.editor.ITextModel): string {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * 对 `ERB_LANGUAGE_ID` 注册 RenameProvider。判定全在槽供方与 handlers，
 * 本函数只做 Monaco 类型翻译、跨语言取数编排与落盘（任何抛错都退成 reject 理由，
 * 不让 F2 崩编辑器）。
 */
export function installErbRename(monaco: typeof Monaco, handlers: ErbRenameHandlers): Monaco.IDisposable {
  /** 当前请求文件路径（真 model 才有；取不到 = 空串，宿主拒答） */
  const pathOf = (model: Monaco.editor.ITextModel): string => erbFactsPathOf(model);

  /**
   * 这门 model 是不是 ERB 方言族（`languageId` 由 Monaco 按 descriptor 给出）。
   *
   * 本 provider 直挂 `ERB_LANGUAGE_ID`（能力矩阵里仍是 `self`：注册面 = `.erb` 专属的一枚
   * provider），`.kojo1` 的改名由它自己的 `installKojoRename` 应答。这枚判据留着是为了
   * 装配形态若改成共享收口（`registerForLanguageServices`，能力名 `rename`）时，
   * 本包不会替 `.kojo1` 抢答同一格。
   */
  const speaksErb = (model: Monaco.editor.ITextModel): boolean => {
    try {
      return model.getLanguageId() === ERB_LANGUAGE_ID;
    } catch {
      return false;
    }
  };

  /** 组一个改名求值请求（宿主只搬身份三格与位置） */
  const targetRequestOf = (
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): EditorRenameTargetRequest => ({
    kind: 'renameTarget',
    path: pathOf(model),
    text: modelText(model),
    line: position.lineNumber,
    column: position.column,
    project: projectOf(handlers),
    ...(safeLanguageId(model) === undefined ? {} : { languageId: safeLanguageId(model)! }),
    ...(safeVersionId(model) === undefined ? {} : { version: safeVersionId(model)! }),
  });

  const provider: Monaco.languages.RenameProvider = {
    // 词区间给 Monaco 做输入框初值；"可不可以改"在求值那一步由槽给（不猜、不拦）
    resolveRenameLocation(model, position) {
      if (!speaksErb(model) || !handlers.canAnswer(model)) return undefined;
      let result: EditorRenameTargetResult | undefined;
      try {
        result = handlers.resolveTarget(targetRequestOf(model, position));
      } catch (e: unknown) {
        console.warn(`[erb-rename] 改名求值抛错：${errorText(e)}`);
        return undefined;
      }
      if (!result) return undefined; // 无人应答 ⇒ Monaco 走缺省词回退，不弹错
      if (result.target === undefined) {
        return {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          text: '',
          rejectReason: result.rejectReason ?? '这里没有可重命名的名字',
        };
      }
      const target = result.target;
      publishPreview(model, position, target);
      return {
        range: {
          startLineNumber: target.line,
          startColumn: target.startColumn,
          endLineNumber: target.line,
          endColumn: target.endColumn,
        },
        text: target.text,
      };
    },

    async provideRenameEdits(model, position, newName) {
      try {
        return await provideEdits(model, position, newName);
      } catch (e: unknown) {
        console.warn(`[erb-rename] 落地失败：${errorText(e)}`);
        return reject(`重命名落地失败：${errorText(e)}`);
      }
    },
  };

  /**
   * 预览拍（KW-12）：把"这次改名会动哪些文件 × 各几处 / 哪些写不进去"在输入框弹出**之前**交出去。
   *
   * 三条纪律：
   * - 问的是**同一枚** `rename` 成员、过的是**同一个** `planReferenceWrites` 闸门
   *   （预览与落地之间不许有第二套判据，否则清单会说谎）；
   * - `newName` 用原词自问自答（插件对"改回自己"合法，symbols.ts 的 `labelRenameRejection`
   *   对同名直接放行），拿的是**同一批坐标**，与用户随后输入的名字无关；
   * - **不带 `related`** ⇒ 不跑糖源腿（`collectKojoLeg` 要枚举读回全项目 `.kojo1`，
   *   这一拍在按键手感上）⇒ 清单如实标 `deferred`，落地那条交全表。
   *
   * 任何异常（含呈现面抛错）都吞成一条 `console.warn`：预览炸了不许把 F2 一起带走。
   */
  function publishPreview(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    target: NonNullable<EditorRenameTargetResult['target']>,
  ): void {
    if (handlers.onRenamePreview === undefined) return;
    try {
      const requestPath = pathOf(model);
      if (requestPath.length === 0) return;
      const result = handlers.resolveRename({
        kind: 'rename',
        path: requestPath,
        text: modelText(model),
        line: position.lineNumber,
        column: position.column,
        newName: target.text,
        project: projectOf(handlers),
        ...(safeLanguageId(model) === undefined ? {} : { languageId: safeLanguageId(model)! }),
        ...(safeVersionId(model) === undefined ? {} : { version: safeVersionId(model)! }),
        related: undefined,
      });
      if (!result || result.rejectReason !== undefined) return; // 拒绝由 Monaco 的信息条说，不重复
      const plan = planReferenceWrites(
        mergeOccurrences([occurrencesOf(result.edits, requestPath)]),
        handlers.isWritable,
      );
      if (plan.writable.length + plan.readOnlyDetail.length === 0) return;
      handlers.onRenamePreview({
        oldName: target.text,
        files: renamePlanFilesOf(
          plan,
          (path) => handlers.openModelFor(path) !== undefined,
          handlers.describeUnwritable,
        ),
        // 这一拍没读糖源面（函数名少的是会一起改的糖源落点、标签名少的是"可能整次取消"的同名写法）
        // ⇒ 预览不许自称全表，恒标 deferred，全表交给落地那条
        deferred: true,
      });
    } catch (e: unknown) {
      console.warn(`[erb-rename] 改动清单预览失败（不影响改名本身）：${errorText(e)}`);
    }
  }

  async function provideEdits(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    newName: string,
  ): Promise<Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection> {
    if (!handlers.canAnswer(model)) {
      return reject('当前视图不参与重命名（请在原文视图内按 F2）');
    }
    const requestPath = pathOf(model);
    if (requestPath.length === 0) return reject('当前视图没有文件路径，无法判断这份文件是否可写');

    // ---- 求值：拿原词与 scope（宿主据此决定跨语言腿要不要取源文） ----
    const targetResult = handlers.resolveTarget(targetRequestOf(model, position));
    if (!targetResult) return reject('重命名判据缺席（语言服务未应答这处请求）');
    if (targetResult.target === undefined) {
      return reject(targetResult.rejectReason ?? '这里没有可重命名的名字');
    }
    const target = targetResult.target;
    const normalizedName = target.text.toUpperCase();

    // ---- 跨语言腿：宿主取数（判据在糖线供方），全或无的裁决在插件 ----
    let related: EditorRenameRelated | undefined;
    if (target.scope === 'label') {
      const { candidates, error } = await collectKojoCandidates(monaco, handlers, normalizedName);
      const sources: EditorProjectFile[] = [];
      for (const [path, text] of candidates) sources.push({ path, text });
      related = {
        sources,
        ...(error === undefined ? {} : { unprovable: [error] }),
      };
    } else {
      const leg = await collectKojoLeg(monaco, handlers, normalizedName);
      related = {
        occurrences: leg.occurrences,
        unprovable: leg.unprovable,
      };
    }

    const request: EditorRenameRequest = {
      kind: 'rename',
      path: requestPath,
      text: modelText(model),
      line: position.lineNumber,
      column: position.column,
      newName,
      project: projectOf(handlers),
      ...(safeLanguageId(model) === undefined ? {} : { languageId: safeLanguageId(model)! }),
      ...(safeVersionId(model) === undefined ? {} : { version: safeVersionId(model)! }),
      related,
    };
    const result = handlers.resolveRename(request);
    if (!result) return reject('重命名判据缺席（语言服务未应答这处请求）');
    if (result.rejectReason !== undefined) return reject(result.rejectReason);

    // ---- 写权限闸（写域策略；分组 / 去重 / 只读计数与「全部替换」同一份实现） ----
    const plan = planReferenceWrites(
      mergeOccurrences([occurrencesOf(result.edits, requestPath)]),
      handlers.isWritable,
    );
    if (plan.readOnlyFiles.length > 0) {
      // 逐条点名（KW-12）：光报数不报名，作者面对一句计数只能猜目录；闸门与文案真源都未动
      return reject(readOnlyFilesReason(plan.readOnlyFiles.length, '重命名', plan.readOnlyDetail));
    }

    const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
    /** io 写入失败的落点（逐文件可见，同「全部替换」执行器的口径） */
    const writeFailures: string[] = [];
    /** 已经落到盘上的闭文件数（>0 ⇒ 绝不能再返回 rejectReason，见模块头注） */
    let landedFiles = 0;
    /** 经内核 io 真的写回磁盘的闭文件落点数（`applied` 合计） */
    let landedOccurrences = 0;
    /** 陈旧跳过合计：闭文件通道 + 标签通道（两腿各自数，汇总出声一次） */
    let staleTotal = 0;
    /** 非调用形 mention（散文）跳过计数——两通道各自计数，汇总出声一次 */
    let proseSkipped = 0;
    /** 标签腿的陈旧处数：标签作用域是"整段一起改"的事实，一处对不上就整次取消（旧行为） */
    let labelStale = 0;
    /** 是不是 `$` 标签改名（单文件、函数局部；落地纪律与函数腿不同，见下） */
    const isLabel = target.scope === 'label';
    for (const group of plan.writable) {
      const open = handlers.openModelFor(group.path);
      if (!open) {
        try {
          const { applied, stale, skippedProse } = await handlers.applyToClosedFile(
            group.path,
            group.occurrences,
            newName,
            normalizedName,
          );
          if (applied > 0) {
            landedFiles++;
            landedOccurrences += applied;
          }
          proseSkipped += skippedProse ?? 0;
          staleTotal += stale;
          if (stale > 0) {
            console.warn(`[erb-rename] '${group.path}' 有 ${stale} 处引用因索引陈旧跳过（实改 ${applied} 处）`);
          }
        } catch (e: unknown) {
          // 写允许域 / io 故障：这一份没落（rewriteClosedFile 只在有实改时写），其余继续
          writeFailures.push(`'${group.path}'：${errorText(e)}`);
        }
        continue;
      }
      // 已打开：按 live model 的现文本逐处验证（索引与现场无锁，陈旧坐标绝不硬写）
      for (const occurrence of group.occurrences) {
        if (result.oldName !== undefined && !liveEditMatches(open, occurrence, result.oldName)) {
          // 标签腿：整段一起改的事实缺了一处 ⇒ 计数后整次取消（不静默少改一个跳转点）
          staleTotal++;
          if (isLabel) labelStale++;
          continue;
        }
        // ERB 词法 mention 的落盘判据（isCallShapedMention 单源，**只拦 erb 侧**）：调用形照改，
        // 散文形跳过——与闭文件通道同一条判据；kojo 腿的 mention 是探针证明的真引用，不拦
        if (
          occurrence.kind === 'mention' &&
          occurrence.language === 'erb' &&
          !isCallShapedMention(open.getLineContent(occurrence.line) ?? '', occurrence.endColumn)
        ) {
          proseSkipped++;
          continue;
        }
        edits.push({
          // resource 必须取自**解析到的那份 live model**（先例：`find-references.ts` 用
          // `live.uri`、`kojo-rename.ts` 用 `model.uri`）。`Uri.file(group.path)` 用的是索引
          // 拼写：盘符大小写/分隔符与标签建立时那份不一致时，`Uri.file` 只归一分隔符、
          // 保留大小写，URI 字符串就与注册表里的 model 对不上 ⇒ WorkspaceEdit 落到一个
          // 没有 model 的 resource（standalone 直接抛 `model not found`）——已开标签静默漏改。
          resource: open.uri,
          versionId: undefined,
          textEdit: {
            range: {
              startLineNumber: occurrence.line,
              startColumn: occurrence.column,
              endLineNumber: occurrence.line,
              endColumn: occurrence.endColumn,
            },
            text: newName,
          },
        });
      }
    }
    // 标签腿的陈旧闸：盘上还没写过任何东西才拒绝（写过就不再拒绝，见下一条纪律）
    if (labelStale > 0 && landedFiles === 0) {
      return reject(
        `标签「${result.oldName ?? normalizedName}」有 ${labelStale} 处位置与当前文本不符（编辑期间文本已变），整次重命名取消`,
      );
    }
    // ---- 全或无的**最后一道**：rejectReason 与已落盘的编辑永不同时出现 ----
    if (writeFailures.length > 0 && landedFiles === 0) {
      return reject(
        `未打开文件写入失败（${writeFailures.length} 个）：${writeFailures.join('；')}。` +
          '整次重命名取消——没有任何落点被改动（不静默改一半）',
      );
    }
    if (writeFailures.length > 0) {
      console.warn(
        `[erb-rename] 已有 ${landedFiles} 个闭文件落盘，剩余 ${writeFailures.length} 个写入失败（不再整批取消，避免半成品分叉）：` +
          writeFailures.join('；'),
      );
    }
    if (proseSkipped > 0) {
      console.warn(
        `[erb-rename] '${normalizedName}'：${proseSkipped} 处 ERB 词法 mention 非调用形（名字后无 "("），按「改名不重写散文」跳过`,
      );
    }
    landed({
      oldName: result.oldName ?? normalizedName,
      newName,
      files: renamePlanFilesOf(
        plan,
        (path) => handlers.openModelFor(path) !== undefined,
        handlers.describeUnwritable,
      ),
      landedClosedFiles: landedFiles,
      tabEdits: edits.length,
      stale: staleTotal,
      proseSkipped,
      failures: writeFailures,
      deferred: false,
    });
    return { edits };
  }

  /**
   * 落地拍的清单（KW-12）：**只报已经发生的事实**，不参与任何判定。
   *
   * 三个读数各自指回一条既有通道，不另数一遍：`landedClosedFiles` = 内核 io 真写回的闭文件数
   * （`applied > 0` 才计，零改动不写盘 ⇒ 不虚报）、`tabEdits` = 交回 Monaco 的 `WorkspaceEdit`
   * 条数（编辑器内待应用，**未保存** ⇒ 句子必须写"未保存"，不许报成已落盘）、
   * `stale` / `proseSkipped` / `failures` = 过去只进 `console.warn` 的三样降级。
   * `deferred` 在这一拍恒为假：糖源腿真的跑过了，落点与只读闸门都并进同一张表。
   */
  function landed(report: RenameLandedInput): void {
    if (handlers.onRenameLanded === undefined) return;
    try {
      handlers.onRenameLanded(report);
    } catch (e: unknown) {
      console.warn(`[erb-rename] 落地清单上屏失败（改动本身已送达）：${errorText(e)}`);
    }
  }

  const sub = monaco.languages.registerRenameProvider(ERB_LANGUAGE_ID, provider);
  return { dispose: () => sub.dispose() };
}

/** 当前项目（软取；缺席 = null。改名判据不读它，只是契约必填位的如实搬运） */
function projectOf(handlers: ErbRenameHandlers): GameProject | null {
  try {
    return handlers.currentProject?.() ?? null;
  } catch {
    return null;
  }
}

/** model 的语言 id（取不到 = undefined；不补假值） */
function safeLanguageId(model: Monaco.editor.ITextModel): string | undefined {
  try {
    const id = model.getLanguageId();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** model 的版本号（取不到 = undefined；供方的过期复核靠它，绝不补假数字） */
function safeVersionId(model: Monaco.editor.ITextModel): number | undefined {
  try {
    const id = model.getVersionId();
    return Number.isFinite(id) ? id : undefined;
  } catch {
    return undefined;
  }
}