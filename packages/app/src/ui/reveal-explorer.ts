/**
 * 「在系统资源管理器中显示」（B3，零 React）：对 Rust 命令 `show_in_folder` 的
 * invoke 封装。只读原语——打开一个资源管理器窗口并选中目标，不写盘、不碰写允许域
 * （Rust 侧 `src-tauri/src/shell.rs` 同名注释）。
 *
 * 错误口径：
 * - Rust 返回的中文错误（"路径不存在…" / "无法打开系统资源管理器…"）整理成
 *   一句可读的话再抛——**调用方负责 catch 并做人话通知**（toast / 状态行），
 *   本模块不弹任何 UI。
 * - Tauri 不可用（浏览器壳，invoke 自身抛）→ 原样抛出、不加包装：
 *   调用方应据此**隐藏**「在资源管理器中显示」菜单项，与 FileTree 的 listDir
 *   缺省同口径。
 */

import { invoke, isTauri } from '../bridge/invoke';

/** 在系统资源管理器中显示并选中 `path`（文件或目录都有效） */
export async function revealInExplorer(path: string): Promise<void> {
  try {
    await invoke('show_in_folder', { path });
  } catch (err) {
    if (!isTauri()) {
      // 浏览器壳：invoke 的"Tauri IPC 不可用"错误原样透出，调用方据此隐藏菜单项
      throw err;
    }
    throw new Error(revealFailureText(err));
  }
}

/** Rust 的中文错误串 → 一句可读的话（不吞原始原因，接在冒号后） */
export function revealFailureText(err: unknown): string {
  const reason =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : String(err);
  return `在系统资源管理器中显示失败：${reason}`;
}
