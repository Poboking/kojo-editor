import { errorText, pathKey } from '@kojo/plugin-api';
import type * as MonacoRuntime from '../monaco/entry';
import {
  applyLineEdits,
  compileReplaceMatcher,
  planLineEdit,
  planSingleReplacement,
  type FileLineEdit,
  type ReplaceMatcher,
} from './search-replace';
import {
  readOnlyFilesNotice,
  residualOutsideScopeNotice,
  rewriteClosedFile,
  type ReferenceOccurrence,
} from './reference-utils';
import type { MatchTarget, ReplaceOutcome, ReplaceRequest, SearchOptionsState } from './search-store';

/**
 * 替换执行器（宿主层装配）：把替换计划落成**两种通道**——与 `erb-rename.ts` 先例同形，
 * 且自 W8 XLANG-RENAME 起**共用同一条落盘通道**（`reference-utils.rewriteClosedFile`）：
 *
 * - **已打开**：Monaco live model 逐行现匹配 + `applyEdits`（原生脏标记 / 撤销步全套现成）；
 *   model 从 Monaco 全局注册表取，**判等口径用全仓统一的 `pathKey`**（见 `pickModelByPathKey`：
 *   裸 `Uri.file` 精确匹配会让"另一种盘符写法"把开着且脏的标签判成关闭文件，替换就会读盘、
 *   写盘，绕过 live buffer）——EditorPane 只用 `Uri.file(path)` 建真文件 model，糖视图 model
 *   是 `inmemory://sugar/` scheme（见 EditorPane），非 `file:` scheme 一律不当命中。
 *   注册表惰性取（本模块要能在 node 侧被单测直接 import，而 monaco 一加载就要 `window`）：
 *   取不到又没注入 `modelFor` 时**一律不写**并说明理由（`registryUnsure`），绝不退化成
 *   "当作没开着直接 io 写盘"（那会盖掉编辑器里的脏内容）。
 * - **未打开**：内核 io 读改写（保编码保换行 + 原子写 + 备份，写允许域由内核 io 强制
 *   ——绕开写允许域没有第二条路，铁律 6）。**闸门、"现文本上改写"、"有实改才写回"
 *   三步全在 `rewriteClosedFile`**，与 F2 逐字同一条代码路径 ⇒ 两个写通道不可能
 *   在"怎么落盘"上分叉。只读文件逐文件跳过并计数，汇总明示
 *   「n 个文件只读未纳入」（文案真源 `readOnlyFilesNotice`，与 rename 的
 *   `readOnlyFilesReason` 同一段前缀，读数可对拍），不静默丢。
 *
 * ## 与 F2 的判据互通（W8）
 *
 * F2 改的是**全项目引用集**，「全部替换」改的是**检索结果集**——过去两边互不知情，
 * 于是"改完名再搜，残留命中仍在"却没人解释。注入 `nameLedger`（宿主给同一份出现点
 * 台账）后，替换结束会把**检索范围外**的同名记号说出来（不静默扩权、也不假装改干净）。
 *
 * 每一处替换都在**现文本**上重新匹配（全部替换 = 现场重扫；单条替换 = sticky 定列验证
 * + 与检索原文比对），陈旧坐标绝不硬写。全部替换走文件的**每一行**——检索结果只是
 * 预览，替换以现状为准（与 VSCode「全部替换」同语义）。编辑计划与降序应用全在
 * `search-replace.ts` 纯逻辑（node 单测钉死），本模块只做 Monaco 协议翻译与 io 编排。
 */

/** 降序应用交给纯逻辑；这里只把行号数组与 io 往返接起来 */
function rewriteClosedText(
  text: string,
  m: ReplaceMatcher,
  template: string,
): { edits: readonly FileLineEdit[]; next: string } {
  const lines = text.split('\n');
  const edits: FileLineEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const e of planLineEdit(lines[i]!, m, template)) {
      edits.push({ lineNumber: i + 1, start: e.start, end: e.end, text: e.text });
    }
  }
  return { edits, next: edits.length > 0 ? applyLineEdits(lines, edits) : text };
}

function outcome(patch: Partial<ReplaceOutcome>): ReplaceOutcome {
  return { applied: 0, filesChanged: 0, stale: 0, readOnlyFiles: 0, errors: [], ...patch };
}

/**
 * 闭文件替换的**并发窗口**（PS-13）。闭文件那条腿全是异步 IPC（`readText` / `writeText`），
 * 串行 `for + await` 把每一次读改写的往返都排成队——200 个闭文件就是 200 趟排队。
 * 窗口语义与 `kernel.compute.runSliced` 的异步分支同款：整窗的 Promise 在**同一个
 * 同步 tick** 内发起（`Promise.all` 一把挂上订阅，不产生 unhandled rejection）、
 * 窗口之间不重叠；闭文件项全是异步项，让路/时间片那套（为同步扫描项设计的）不掺进来。
 *
 * 真慢的只是这条腿——in-model 的 `replaceInModel` 是同步 Monaco 编辑，天然串行。
 */
export const CLOSED_REPLACE_CONCURRENCY = 8;

/** 窗口化 map（保序；`fn` 一律不 reject——失败也按位填回，错误在折叠时按原序说出） */
async function mapWindow<T, R>(
  items: readonly T[],
  window: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length) as R[];
  for (let i = 0; i < items.length; i += window) {
    const end = Math.min(i + window, items.length);
    const started: Array<Promise<R>> = new Array(end - i);
    for (let k = i; k < end; k++) started[k - i] = fn(items[k]!);
    const done = await Promise.all(started);
    for (let k = 0; k < done.length; k++) out[i + k] = done[k]!;
  }
  return out;
}

/** 单个文件的落账（第一/二趟都写进这张按序账，最后统一折叠 ⇒ 与串行版逐项同值同序） */
interface FileOutcome {
  applied: number;
  changed: boolean;
  readOnly: boolean;
  error?: string;
}

/**
 * Monaco 运行时（**惰性**）：本模块要能在 node 侧被单测直接 import（替换是写盘操作，
 * 落盘纪律必须可测），而 `../monaco/entry` 一加载就要 `window`。故改成动态取——
 * 装配即发起加载，用户点「全部替换」时早已就绪；**没就绪就一律不写**（见下面的闸门），
 * 绝不退化成"当作没打开直接 io 写盘"（那会绕过 live model，把编辑器里的脏内容盖掉）。
 */
let monacoRuntime: typeof MonacoRuntime | null = null;
let monacoLoading: Promise<void> | null = null;

/** 发起（或复用在途的）Monaco 运行时加载；**替换动作开始前 await 它**，不留竞态 */
function ensureMonacoRuntime(): Promise<void> {
  if (monacoRuntime !== null) return Promise.resolve();
  monacoLoading ??= import('../monaco/entry')
    .then((mod) => {
      monacoRuntime = mod;
    })
    .catch(() => {
      monacoLoading = null; // 下一次动作再试（浏览器里不该失败；失败了也只是不写，绝不硬写）
    });
  return monacoLoading;
}

/**
 * 从 Monaco 全局注册表取 live model；注册表未就绪 ⇒ `undefined`（由闸门拦下）。
 * 先按精确 URI 取（同写法时行为不变，也避开全量遍历），再按 `pathKey` 找回另一种写法
 * 的那份 live model——见 `pickModelByPathKey` 的判等理由。
 */
function modelFromRegistry(path: string): MonacoRuntime.editor.ITextModel | undefined {
  if (monacoRuntime === null) return undefined;
  const exact = monacoRuntime.editor.getModel(monacoRuntime.Uri.file(path)) ?? undefined;
  if (exact) return exact;
  return pickModelByPathKey(monacoRuntime.editor.getModels(), path);
}

export interface FileReplaceDeps {
  io: {
    isWritable(path: string): boolean;
    readText(path: string): Promise<{ text: string }>;
    writeText(path: string, text: string): Promise<void>;
  };
  /** 已打开文件的 live model 查找（缺省 = Monaco 注册表：精确 URI → `pathKey` 回落，见 `pickModelByPathKey`） */
  modelFor?: (path: string) => MonacoRuntime.editor.ITextModel | undefined;
  /**
   * 名字 → 全部出现点（**可选**，宿主注入 `erb-rename` 用的同一份台账判据）。
   * 给出后，「全部替换」在收尾时明示"检索范围外还有多少处同名记号没被本次覆盖"；
   * 缺席 = 不判（旧行为，零改动）。
   */
  nameLedger?(query: string): readonly ReferenceOccurrence[] | Promise<readonly ReferenceOccurrence[]>;
  /**
   * 闭文件替换的并发窗口（**可选**，PS-13 等价性测试的对照旋钮：注入 1 = 串行封存版；
   * 缺省 = `CLOSED_REPLACE_CONCURRENCY`）。只影响**怎么排队**，不影响任何产出。
   */
  closedConcurrency?: number;
}

/** model 查找只用到 uri 的这两个读数——抽出来才能在没有 Monaco 运行时的 node 里测 */
export interface UriBearingModel {
  readonly uri: { readonly scheme: string; readonly fsPath: string };
}

/**
 * 全仓路径判等口径（`pathKey`）下的 model 挑选（HK-7 那条纪律的替换执行器侧）。
 *
 * 为什么不能只按 `Uri.file(path)` 精确取：`Uri.file` 把 `\` 归一成 `/`，但**保留盘符大小写**，
 * 而 Monaco 的注册表按 URI 字符串精确匹配。检索索引里的路径写法与标签建立时那份写法
 * 盘符大小写不同（内核扫盘给的 `D:\...`、会话恢复给的 `d:\...`）时，精确取会判"没开"——
 * **开着且脏的标签被当成关闭文件**：替换读的是磁盘副本、写盘后与 live buffer 相撞。
 * 派生 model（糖视图等非 `file:` scheme）不是真文件正文，一律不当命中。
 */
export function pickModelByPathKey<T extends UriBearingModel>(
  models: readonly T[],
  path: string,
): T | undefined {
  const want = pathKey(path);
  for (const m of models) {
    // 派生 model（糖视图等）scheme 不是 `file:`，不是真文件正文 ⇒ 不当命中
    if (m.uri.scheme === 'file' && pathKey(m.uri.fsPath) === want) return m;
  }
  return undefined;
}

/**
 * 组装替换执行器（browser 侧装配；单测打 `modelFor` + 假 io，绕开 Monaco 注册表）。
 */
export function createFileReplaceRunner(
  deps: FileReplaceDeps,
): (request: ReplaceRequest) => Promise<ReplaceOutcome> {
  const injected = deps.modelFor;
  const modelFor = injected ?? ((path: string) => modelFromRegistry(path));
  if (injected === undefined) void ensureMonacoRuntime(); // 装配即发起（宿主注入 `modelFor` 时压根不需要注册表）

  /**
   * 无法确认"这个文件开没开着"（缺省通道 + 注册表未就绪）⇒ 一律不写：
   * 当成未打开直接 io 写盘会绕过 live model，把编辑器里的脏内容盖掉（数据损坏），
   * 宁可少改一处并把它说出来（铁律 4）。
   */
  const registryUnsure = (): boolean => injected === undefined && monacoRuntime === null;

  /** 已打开 model：逐行现匹配 → applyEdits（一次调用 = 一步撤销） */
  const replaceInModel = (
    model: MonacoRuntime.editor.ITextModel,
    m: ReplaceMatcher,
    template: string,
  ): number => {
    const count = model.getLineCount();
    const ops: Array<{
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
      text: string;
    }> = [];
    for (let ln = 1; ln <= count; ln++) {
      const line = model.getLineContent(ln);
      for (const e of planLineEdit(line, m, template)) {
        ops.push({
          range: {
            startLineNumber: ln,
            startColumn: e.start + 1,
            endLineNumber: ln,
            endColumn: e.end + 1,
          },
          text: e.text,
        });
      }
    }
    if (ops.length > 0) model.applyEdits(ops);
    return ops.length;
  };

  /** 未打开：内核 io 读改写（与 F2 同一条 `rewriteClosedFile` 通道）——现匹配 → 有实改才写回 */
  const replaceInClosedFile = (path: string, m: ReplaceMatcher, template: string): Promise<{ applied: number }> =>
    rewriteClosedFile(deps.io, path, (text) => {
      const { edits, next } = rewriteClosedText(text, m, template);
      return { text: next, applied: edits.length, stale: 0 };
    });

  return async (request: ReplaceRequest): Promise<ReplaceOutcome> => {
    // 只有真要自己查注册表时才等 Monaco 加载完（注入了 `modelFor` 的调用方不欠这个等待）
    if (injected === undefined) await ensureMonacoRuntime();
    const opts: Pick<SearchOptionsState, 'isRegex' | 'caseSensitive' | 'wholeWord'> = {
      isRegex: request.options.isRegex,
      caseSensitive: request.options.caseSensitive,
      wholeWord: request.options.wholeWord,
    };
    let m: ReplaceMatcher | null = null;
    try {
      m = compileReplaceMatcher(request.query, opts);
    } catch (e: unknown) {
      return outcome({ errors: [`检索词不是有效正则：${errorText(e)}`] });
    }
    if (m === null) return outcome({ errors: ['检索词为空，未替换'] });

    if (request.mode.kind === 'one') return replaceOne(request.mode.target, m, request.replaceText);

    // ---- 全部替换：结果里的文件逐个落（截断/取消的结果不允许走到这里，store 已挡）----
    // PS-13 两趟制：第一趟串行做**派发前**必须完成的事（pathKey 去重、活面判定、
    // in-model 同步替换、只读剔除），闭文件收集成清单；第二趟按并发窗口执行。
    // 落账按文件在去重序列里的原序折叠 ⇒ errors / 计数与串行版逐项同值同序。
    const seen = new Set<string>();
    const ledger: FileOutcome[] = [];
    /** 第二趟要走的闭文件：`index` 是它在 ledger 里的账位（结果按位填回） */
    const closedFiles: Array<{ path: string; slot: number }> = [];
    for (const f of request.files) {
      // 去重按 `pathKey`：索引里同一文件的两种写法（盘符大小写/分隔符）是一份正文，不是两个
      const key = pathKey(f.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const open = modelFor(f.path);
      if (open !== undefined) {
        try {
          const n = replaceInModel(open, m, request.replaceText);
          ledger.push({ applied: n, changed: n > 0, readOnly: false });
        } catch (e: unknown) {
          ledger.push({ applied: 0, changed: false, readOnly: false, error: `${f.path}：${errorText(e)}` });
        }
        continue;
      }
      if (registryUnsure()) {
        ledger.push({
          applied: 0,
          changed: false,
          readOnly: false,
          error: `无法确认「${f.path}」是否已打开（Monaco 注册表未就绪），未替换`,
        });
        continue;
      }
      if (!deps.io.isWritable(f.path)) {
        ledger.push({ applied: 0, changed: false, readOnly: true });
        continue;
      }
      closedFiles.push({ path: f.path, slot: ledger.length });
      ledger.push({ applied: 0, changed: false, readOnly: false }); // 占位：第二趟按位填回
    }
    // 第二趟：闭文件读改写并发化（失败不 reject，按位落账——窗口语义见 CLOSED_REPLACE_CONCURRENCY）
    const closedDone = await mapWindow(
      closedFiles,
      Math.max(1, Math.floor(deps.closedConcurrency ?? CLOSED_REPLACE_CONCURRENCY)),
      (cf) =>
        replaceInClosedFile(cf.path, m, request.replaceText).then(
          (r): FileOutcome => ({ applied: r.applied, changed: r.applied > 0, readOnly: false }),
          (e: unknown): FileOutcome => ({
            // 写允许域 / io 故障：逐文件可见，不中断其余文件（铁律 4：不静默）
            applied: 0,
            changed: false,
            readOnly: false,
            error: `${cf.path}：${errorText(e)}`,
          }),
        ),
    );
    for (let i = 0; i < closedFiles.length; i++) {
      ledger[closedFiles[i]!.slot] = closedDone[i]!;
    }
    let applied = 0;
    let filesChanged = 0;
    let readOnlyFiles = 0;
    const errors: string[] = [];
    for (const o of ledger) {
      if (o.error !== undefined) errors.push(o.error);
      else if (o.readOnly) readOnlyFiles++;
      else if (o.applied > 0) {
        applied += o.applied;
        filesChanged++;
      }
    }
    if (readOnlyFiles > 0) errors.push(readOnlyFilesNotice(readOnlyFiles, '替换'));
    // 与 F2 判据互通：检索范围外的同名记号说出来（不静默扩权，也不假装改干净）
    if (deps.nameLedger) {
      try {
        const ledger = await deps.nameLedger(request.query);
        let residual = 0;
        const residualFiles = new Set<string>();
        for (const occ of ledger) {
          // 与检索面同一判等口径（`pathKey`）：台账拼写与结果清单不同时，不能
          // 把已经替换过的文件又算成"范围外残留"
          const key = pathKey(occ.filePath);
          if (seen.has(key)) continue;
          residual++;
          residualFiles.add(key);
        }
        if (residual > 0) {
          errors.push(residualOutsideScopeNotice(residual, residualFiles.size, request.query));
        }
      } catch (e: unknown) {
        errors.push(`引用判据核对失败（不影响本次替换结果）：${errorText(e)}`);
      }
    }
    return outcome({ applied, filesChanged, readOnlyFiles, errors });

    // ---- 单条替换：检索行列定起点，sticky 验证后单点落 ----
    async function replaceOne(
      target: MatchTarget,
      matcher: ReplaceMatcher,
      template: string,
    ): Promise<ReplaceOutcome> {
      const file = request.files.find((f) => f.path === target.path);
      const match = file?.matches.find((mm) => mm.line === target.line && mm.column === target.column);
      // 检索结果里找不回这条命中 = 行列已陈旧，按验证失败处理（不猜）
      const expected = match !== undefined ? match.preview.slice(match.start, match.end) : null;
      const open = modelFor(target.path);
      if (open !== undefined) {
        if (target.line < 1 || target.line > open.getLineCount()) {
          return outcome({ stale: 1, errors: ['该行已不存在（文本已变化），未替换'] });
        }
        const line = open.getLineContent(target.line);
        const v = planSingleReplacement(line, target.column - 1, matcher, template, expected);
        if (v.kind === 'skip') return outcome({ stale: 1, errors: [v.reason] });
        open.applyEdits([
          {
            range: {
              startLineNumber: target.line,
              startColumn: v.start + 1,
              endLineNumber: target.line,
              endColumn: v.end + 1,
            },
            text: v.text,
          },
        ]);
        return outcome({ applied: 1, filesChanged: 1 });
      }
      if (!deps.io.isWritable(target.path)) {
        return outcome({ readOnlyFiles: 1, errors: ['该文件只读（写权限未批准），未替换'] });
      }
      try {
        const { text } = await deps.io.readText(target.path);
        const lines = text.split('\n');
        if (target.line < 1 || target.line > lines.length) {
          return outcome({ stale: 1, errors: ['该行已不存在（文本已变化），未替换'] });
        }
        const v = planSingleReplacement(lines[target.line - 1]!, target.column - 1, matcher, template, expected);
        if (v.kind === 'skip') return outcome({ stale: 1, errors: [v.reason] });
        const line = lines[target.line - 1]!;
        lines[target.line - 1] = line.slice(0, v.start) + v.text + line.slice(v.end);
        await deps.io.writeText(target.path, lines.join('\n'));
        return outcome({ applied: 1, filesChanged: 1 });
      } catch (e: unknown) {
        return outcome({ errors: [`${target.path}：${errorText(e)}`] });
      }
    }
  };
}
