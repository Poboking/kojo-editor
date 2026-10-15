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
  FileIO,
  SugarSavePlan,
  SugarTranspileService,
} from '@kojo/plugin-api';

/** 注入依赖（只取所需方法：转译服务的保存前置/编译 + io 的写文本） */
export interface SugarSaveDeps {
  readonly sugar: Pick<SugarTranspileService, 'planSave' | 'compileToFile'>;
  readonly io: Pick<FileIO, 'writeText'>;
}

/** 路径基名（不依赖 path 模块——WebView/Node 双环境一致） */
function baseName(p: string): string {
  const m = /[^\\/]+$/.exec(p);
  return m ? m[0] : p;
}

/** `blocked` 原因 → 面向作者的说明 */
function blockNote(plan: SugarSavePlan): string {
  if (plan.blockedReason === 'source-not-kojo') {
    return '产物未生成：源路径不是 .kojo（无可推导的产物目标）';
  }
  if (plan.blockedReason === 'transpile-error') {
    const n = plan.transpile.diagnostics.filter((d) => d.severity === 'error').length;
    return `产物未生成：转译含 ${n} 项错误（见「.kojo 校验」）`;
  }
  return plan.erbPath ? '' : '产物未生成：无可推导的产物目标';
}

/**
 * 执行一次 `.kojo` 保存（源 + 产物）。
 *
 * 返回 `EditorSaveOutcome`——**不抛**：失败一律转成 `error` 结果（宿主据此统一
 * 呈现），需要用户决策时返回 `needs-choice`（不改动磁盘）。
 */
export async function performSugarSave(deps: SugarSaveDeps, request: EditorSaveRequest): Promise<EditorSaveOutcome> {
  const { sugar, io } = deps;

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

  // ---- 1. 保存源文件（始终；作者成果不可因编译失败而丢）----
  try {
    await io.writeText(request.path, request.text);
  } catch (err) {
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
    return {
      status: 'error',
      message: `源已保存，但产物编译落盘失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}