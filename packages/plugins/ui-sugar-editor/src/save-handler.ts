/**
 * 语法糖保存接管 —— **纯逻辑**（零 React、零内核依赖，可单测）。
 *
 * 语义（对应规范 §5.3「阻止编译，不生成半成品 ERB」+ §8「保存时告警」）：
 *
 *   Ctrl+S（`.kojo`）→ **保存源文件** + **编译产物**，二者分工明确——
 *   1. `.kojo` **源文件始终保存**（作者成果；`blocked` 只拦产物，不拦源，
 *      否则"有编译错误就不让存"会让作者丢工作，与"不静默失败/不丢数据"背离）；
 *   2. 产物 `.ERB` 走 `planSave` 前置 → `compileToFile`：转译含 `error` 诊断时
 *      **fail-closed 不产半成品**（源已保存，状态栏提示"产物未生成"）；
 *   3. 全角空格属**保存期告警**（规范 §8；语料证据见 `FULLWIDTH_SPACE`）——
 *      未确认时返回 `needs-choice`，宿主弹确认后带 `acknowledgeFullwidthSpace`
 *      重新调用（"仍然保存"）或改文本后重调（"一键修复"）。
 *
 * 分层（"一切皆插件"）：本模块只做**编排**；转译/编译在 `kojo-sugar`
 * （`sugar.transpile`），落盘闸门在内核 io——依赖从入参注入，可被单测以替身
 * 精确驱动（与 `kojo-sugar` 的 `compile.ts` 同一可测范式）。
 */

import type {
  EditorSaveOutcome,
  EditorSaveRequest,
  FileEncoding,
  FileIO,
  EolStyle,
  OpJournal,
  SugarSavePlan,
  SugarTranspileService,
} from '@kojo/plugin-api';

/** 注入依赖（只取所需方法：转译服务的保存前置/编译 + io 的写文本 + 可选 journal） */
export interface SugarSaveDeps {
  readonly sugar: Pick<SugarTranspileService, 'planSave' | 'compileToFile'>;
  readonly io: Pick<FileIO, 'writeText' | 'readText' | 'exists' | 'removeFile'>;
  /** 批操作 journal（2026-10-16 undo 批，additive 可选）：在场时保存整体进一次批操作 */
  readonly journal?: Pick<OpJournal, 'begin' | 'record' | 'commit' | 'abort'>;
}

/** 路径基名（不依赖 path 模块——WebView/Node 双环境一致） */
function baseName(p: string): string {
  const m = /[^\\/]+$/.exec(p);
  return m ? m[0] : p;
}

/* -------------------- 半批回滚（2026-10-16 undo 批） -------------------- */

/** 保存前的单文件盘上状态（源 / 产物共用同一快照口径） */
interface BeforeState {
  existed: boolean;
  text: string | null;
  encoding: FileEncoding | null;
  eol: EolStyle | null;
}

/**
 * 抓保存前状态。**存在但读不动 = 真错上抛**（绝不把"盘上读不出"降级成
 * "新建"——那会让回滚把用户的既有文件删掉）。
 */
async function snapshotBefore(
  io: Pick<FileIO, 'readText' | 'exists'>,
  path: string,
): Promise<BeforeState> {
  try {
    const tf = await io.readText(path);
    return { existed: true, text: tf.text, encoding: tf.encoding, eol: tf.eol };
  } catch (err) {
    if (await io.exists(path)) throw err;
    return { existed: false, text: null, encoding: null, eol: null };
  }
}

/** 回滚单文件到保存前（源写回保编码保换行；新建文件删除——io 层进回收站兜底） */
async function restoreBefore(
  io: Pick<FileIO, 'writeText' | 'removeFile' | 'exists'>,
  path: string,
  before: BeforeState,
): Promise<void> {
  if (before.existed && before.text !== null) {
    await io.writeText(path, before.text, {
      // backup:false：回滚不再产备份——保存失败的新内容仍在编辑器 buffer 里，不丢
      encoding: before.encoding ?? 'preserve',
      eol: before.eol ?? 'preserve',
      backup: false,
    });
  } else if (!before.existed && (await io.exists(path))) {
    await io.removeFile(path);
  }
}

/** `blocked` 原因 → 面向作者的说明 */
function blockNote(plan: SugarSavePlan): string {
  if (plan.blockedReason === 'source-not-kojo') {
    return '产物未生成：源路径不是 .kojo1（无可推导的产物目标）';
  }
  if (plan.blockedReason === 'transpile-error') {
    const n = plan.transpile.diagnostics.filter((d) => d.severity === 'error').length;
    return `产物未生成：转译含 ${n} 项错误（见「.kojo1 校验」）`;
  }
  return plan.erbPath ? '' : '产物未生成：无可推导的产物目标';
}

/**
 * 执行一次 `.kojo` 保存（源 + 产物）。
 *
 * 返回 `EditorSaveOutcome`——**不抛**：失败一律转成 `error` 结果（宿主据此统一
 * 呈现），需要用户决策时返回 `needs-choice`（不改动磁盘）。
 *
 * 半批语义（2026-10-16 undo 批）：源与产物是一**次保存的两文件批**——
 * - 源失败：产物不写（自然顺序保证）；
 * - 产物失败：**源回滚到保存前**（旧形态源已存、产物失败只报错 = 半批态；
 *   新形态编辑器 buffer 里仍有新内容不丢工作，磁盘回到保存前的一致点）。
 * journal 在场时整个保存是一次批操作（abort 即回滚 + 进操作历史可撤销）；
 * 缺席时用本层的显式快照兜底（旧内核零改动）。
 */
export async function performSugarSave(deps: SugarSaveDeps, request: EditorSaveRequest): Promise<EditorSaveOutcome> {
  const { sugar, io } = deps;

  // ---- 源文件写盘参数（EOL-OVERRIDE-SAVE 批，additive）：宿主随请求递上行尾覆盖档
  // （作者显式切过换行）时透传给 `io.writeText` 的 `{ eol }`（内核语义 = 整段统一）；
  // 缺席 = 旧形状逐字不变（保编码保换行）。只约束**源文件**；产物 `.ERB` 的行尾
  // 归 compileToFile 自己的策略管，不经此覆盖。
  const sourceWriteOpts = request.eol ? { eol: request.eol } : undefined;

  // ---- 前置（纯函数；无副作用）：目标推导 + 转译 + 全角空格告警 ----
  const plan = sugar.planSave({ source: request.text, sourcePath: request.path });

  // ---- 全角空格：保存期告警，未确认 → 交宿主决策（此时**尚未落盘**）----
  if (plan.fullwidthSpaceLines.length > 0 && !request.choices?.acknowledgeFullwidthSpace) {
    const n = plan.fullwidthSpaceLines.length;
    return {
      status: 'needs-choice',
      warning: {
        kind: 'fullwidth-space',
        message: `检测到 ${n} 行含全角空格（U+3000，易与半角空格混看）`,
        lines: plan.fullwidthSpaceLines,
      },
    };
  }

  // ---- journal 在场：保存 = 一次批操作（record 先于写；失败 abort 即回滚）----
  if (deps.journal) {
    const journal = deps.journal;
    const opId = await journal.begin('sugar-save', `保存 ${baseName(request.path)}（源+产物）`);
    try {
      await journal.record(opId, request.path);
      await io.writeText(request.path, request.text, sourceWriteOpts);
      if (plan.blocked || !plan.erbPath) {
        await journal.commit(opId);
        return { status: 'saved', message: '已保存源文件', note: blockNote(plan) };
      }
      await journal.record(opId, plan.erbPath);
      const r = await sugar.compileToFile(request.text, plan.erbPath, { filePath: request.path });
      await journal.commit(opId);
      return { status: 'saved', message: `已保存并编译 → ${baseName(r.erbPath)}（${r.byteSize}B）` };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await journal.abort(opId); // 逆序回滚已写文件（产物失败 = 源一并恢复）
      } catch (rollbackErr) {
        return {
          status: 'error',
          message: `保存失败：${reason}；且回滚失败，请从「操作历史」或本地历史手动恢复：${String(rollbackErr)}`,
        };
      }
      return { status: 'error', message: `保存失败（磁盘已回滚到保存前）：${reason}` };
    }
  }

  // ---- journal 缺席：显式快照兜底（语义与 journal 路径一致，只是不进操作历史）----
  const srcBefore = await snapshotBefore(io, request.path);

  // ---- 1. 保存源文件（始终；作者成果不可因编译失败而丢）----
  try {
    await io.writeText(request.path, request.text, sourceWriteOpts);
  } catch (err) {
    // 原子写失败 = 盘上没动，无需回滚
    return { status: 'error', message: `保存源文件失败：${err instanceof Error ? err.message : String(err)}` };
  }

  // ---- 2. 产物被阻止（无目标 / 转译错误）→ 源已存、产物不产 ----
  if (plan.blocked || !plan.erbPath) {
    return { status: 'saved', message: '已保存源文件', note: blockNote(plan) };
  }

  // ---- 3. 编译落盘（写链路见 kojo-sugar compile.ts；越权/回读失败在此抛出）----
  // 传 `filePath` 与上面的 `planSave` **同键**：kojo-sugar 的共享结果缓存按
  // (源文本, filePath) 命中（转译是纯函数）——"保存一次"只做一次真实转译，
  // 重编译不再重转译（读数：misses 1 而不是 2）。产物字节与不传时逐字节相同。
  try {
    const r = await sugar.compileToFile(request.text, plan.erbPath, { filePath: request.path });
    return { status: 'saved', message: `已保存并编译 → ${baseName(r.erbPath)}（${r.byteSize}B）` };
  } catch (err) {
    // 产物失败（原子写失败 = 产物未动）：回滚源到保存前，消掉半批态
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await restoreBefore(io, request.path, srcBefore);
    } catch (rollbackErr) {
      return {
        status: 'error',
        message: `产物编译落盘失败：${reason}；源文件回滚也失败，新内容仍在编辑器中，请勿关闭后从本地历史恢复：${String(rollbackErr)}`,
      };
    }
    return {
      status: 'error',
      message: `产物编译落盘失败：${reason}；源文件已回滚到保存前（新内容仍在编辑器中，重新保存即可重试）`,
    };
  }
}