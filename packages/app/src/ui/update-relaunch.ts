/**
 * 「立即重启」按钮的 JS 包装（UPD-B）。
 *
 * 背景与分工：UpdateDialog 的 done 态留了可选 `onRestart` prop 一直没接线（宿主没有
 * 重启命令），本批 Rust 侧补了 `updater_relaunch` 命令（见 `src-tauri/src/updater_relaunch.rs`），
 * 这里给出**唯一**的 JS 包装，由 `ShellLayout` 接进弹窗渲染。
 *
 * 契约一句话：**按钮必须真能重启，包装层只做环境闸与静默**——
 * - 非 Tauri（浏览器调试壳 / 纯 vite dev）：直接 return，连 invoke 都不发起；
 * - Tauri 环境但命令缺失（旧版桌面壳没编进这条命令）或重启途中报错：静默吞掉，
 *   绝不弹错——重启是动作的最后一步，失败时进程多半也要退出了，弹一个没人看得见的错没意义；
 * - 命令返回 `!`（进程被替换，永不返回）⇒ invoke 不必 resolve，fire-and-forget 即可。
 */

import { invoke, isTauri } from '../bridge/invoke';

/** 请求宿主立即重启应用（进程被替换，本调用不等待结果）。 */
export function appRelaunch(): void {
  if (!isTauri()) return;
  void invoke<void>('updater_relaunch').catch(() => {
    /* 静默：命令缺失（旧壳）/ 重启失败都不弹错，失败路径见 updater_relaunch.rs 文件头 */
  });
}
