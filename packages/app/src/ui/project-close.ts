import type { Kernel } from '@kojo/kernel';
import type { RecentProject } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';

/**
 * 关项目的**拆除序**（REF-FRONT-PERF，2026-10-20）。
 *
 * 原实现直接 `await kernel.project.close()` 再逐条收尾：close 一旦抛错，
 * `fileWatch.stop` / `clear_write_domain` / 全部状态复位都会被跳过——用户看到的是
 * 「点了关闭没反应」，而且下一次开项目还踩着上一份监视句柄与写允许域。
 *
 * 这里把「关闭」与「拆除」拆成两段：close 的异常只记一笔，拆除序一律走 finally。
 * 判据：
 * - 拆除序与成功路径**逐字同序**：stop → clear_write_domain → 状态复位 → recent；
 * - 每一步的失败都不阻断后一步（每一步都有机会把话说出来，最后合成一条错误）；
 * - 写允许域清除失败这句上屏为「关闭项目时可写范围没能清空：…」，新增的关闭失败一句另起一行；
 * - 不判断 Tauri：`clearWriteDomain` 为 null（浏览器壳）时整步跳过。
 *
 * 纯函数、零 React：`packages/app/tests/project-close.test.ts` 用最小 fake kernel 钉住
 * 「close 抛错仍清理」这条行为，不需要起壳。
 */

/**
 * 崩溃退出的决策（REF-FRONT-PERF 复核对抗审阅）。
 *
 * 项目子树崩溃时 EditorPane 已卸载，`saveAll()` 此时是空操作；若直接走
 * `closeProject()`，随后 dirtyPaths 清空会触发 autosave journal 的 clear，
 * 未落盘的恢复件被静默抹掉。有脏文件 ⇒ 必须先让用户明确「丢弃」，
 * 不允许把崩溃退出当成一次普通关项目。
 */
export function crashExitDecision(dirtyCount: number): 'close' | 'confirm-discard' {
  return dirtyCount > 0 ? 'confirm-discard' : 'close';
}

export interface CloseProjectSessionDeps {
  readonly kernel: Kernel;
  /**
   * Rust 侧写允许域回到「仅应用数据目录」。浏览器壳没有这条 IPC ⇒ 传 null。
   * 由调用方绑定 `invoke('clear_write_domain')`，这里不 import 桥，测试可注入假实现。
   */
  readonly clearWriteDomain: (() => Promise<void>) | null;
  /** 显式报错通道（App 侧是 raiseError；同文案不重复刷屏） */
  readonly reportError: (message: string) => void;
  /** 项目态整体复位（project/index/UI/检索/phase）：必须同步执行完毕 */
  readonly reset: () => void;
  /** 最近项目列表刷新（真源在内核；失败只记一笔，不再抛穿关闭路径） */
  readonly setRecent: (recent: RecentProject[]) => void;
}

export async function closeProjectSession(deps: CloseProjectSessionDeps): Promise<void> {
  const errors: string[] = [];

  try {
    await deps.kernel.project.close();
  } catch (e: unknown) {
    // 关闭失败也要把后面的拆除走完：宁可让 UI 先回到可操作状态，也不能把句柄留在盘上
    errors.push(`关闭项目失败：${errorText(e)}`);
  } finally {
    try {
      deps.kernel.fileWatch.stop();
    } catch (e: unknown) {
      errors.push(`停止文件监视失败：${errorText(e)}`);
    }

    if (deps.clearWriteDomain) {
      try {
        await deps.clearWriteDomain();
      } catch (e: unknown) {
        // 写允许域清除失败这句上屏时说成人话（机制名只留在注释里）；新的错误条不另造一套口径
        errors.push(`关闭项目时可写范围没能清空：${errorText(e)}`);
      }
    }

    try {
      deps.reset();
    } catch (e: unknown) {
      errors.push(`项目状态复位失败：${errorText(e)}`);
    }

    try {
      deps.setRecent(await deps.kernel.project.recent());
    } catch (e: unknown) {
      errors.push(`读取最近项目失败：${errorText(e)}`);
    }
  }

  // 合成一条（通知条与错误卡都按 pre-wrap 显示，多行不会糊成一行）
  if (errors.length > 0) deps.reportError(errors.join('\n'));
}
