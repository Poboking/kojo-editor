/**
 * `.kojo` 源文本 → 面上波浪线 —— **翻译核**（从 `index.ts` 的 `activate()` 原样迁出：
 * 判据、注释、异常兜底逐字不变；本模块零 React、零 IO）。
 *
 * 之所以单独成文件：这张翻译表同时喂给 `ui.editor.decorator`（贡献 1）与
 * `ui.editor.codeAction`（贡献 1b 的快速修复自证），是"唯一一份翻译"的落点；
 * 留在 `index.ts` 会让装配层同时握着判据与注册两件事。
 */

import type { LineDecoration, SugarTranspileService } from '@kojo/plugin-api';
import { diagnosticDecorations, isKojoFile } from './panel-logic';

/**
 * 任务 kind（2026-10-16 装饰热路径批）：`.kojo` 全量转译 + 诊断成形。
 *
 * **它天生搬不进 worker**：转译器要吃当前项目适配器注入的字典 / 时机分野模板 /
 * 指令名表（游戏知识，`loadProject` 时才成形），worker 侧复现不了那份注入；
 * 少了注入，`unknown-identifier` / `timing-face-unknown` 会凭空多出一批假错。
 * 所以这张 kind **不进**装配层的 worker 表——宿主据此走"异步就地"那一档：
 * 照样请出同步装饰轮（主线程只装配）、照样吃 `runLatest` 背压与版本校验，
 * 只是 CPU 仍在宿主线程上。声明 `offloadKind` 而不是留空，是为了让
 * "切回未改动标签零重算"的缓存对这三路同样生效。
 */
export const SUGAR_DECORATIONS_TASK = 'sugar.diagnostics';

/**
 * `.kojo` 源文本 → 面上的波浪线（**唯一一份翻译**：decorator 贡献与下面 quickfix 的
 * 自证都走这里）。之所以提出来而不是各写一遍：自证的对照组必须与面上那份**逐字段同源**，
 * 两处各拼一遍 `transpile + diagnosticDecorations` 就是同一份判据的两个副本
 * （本仓同类事故口径，见 ui-sugar-lift 的 FT-2 收口注）。
 */
export function createSugarDecorations(
  sugar: SugarTranspileService,
): (path: string, source: string) => LineDecoration[] {
  return function kojoDecorations(path: string, source: string): LineDecoration[] {
    if (!isKojoFile(path)) return [];
    try {
      return diagnosticDecorations(sugar.transpile(source, { filePath: path }).diagnostics);
    } catch {
      // 转译器自身异常：绝不在编辑器里炸（宿主本就会隔离装饰器异常，这里
      // 显式兜底，让"这一文件无波浪线"而非"整个装饰链断掉"）。
      return [];
    }
  };
}
