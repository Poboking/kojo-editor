/**
 * `ui.editor.decorator` 槽的 **2.0 文档级诊断**供方（B3 收口最后一格）。
 *
 * ## 契约位置
 *
 * 诊断在本仓**没有**独立的能力判别成员：契约 `plugin-api/src/slots.ts` 写死了
 * "诊断 = 槽 `ui.editor.decorator`（`LineDecoration` 就是 LSP 诊断的形状）"。
 * 本文件就是那一家供方——宿主拿它画波浪线 / 写问题面板，`Ctrl+.` 反过来从 markers
 * 认领同一条（`diagnosticKey` 的尺子 = 严重级 + 行 + 消息 + 码）。
 *
 * ## 判据在哪
 *
 * 全部在 `@kojo/kojo-lang/diagnostics`：编译（core）、落点归一（越界 / 零宽 / 代理对 /
 * 跨行）、失败口径（抛错 = 没有诊断且错误可见）。本文件只做四件事：
 *
 * 1. **归属**：`.kojo` / `.kojo2` 才答；`.kojo1` 与其它语言弃权（空数组——装饰槽没有
 *    `undefined` 这一态，与 `src/code-actions.ts` 同一条口径）；
 * 2. **取两面**：`kojo2SurfaceNow(path)` 从宿主组合根登记表现取 adapter + backend，并核对
 *    `adapter.id === project.adapterId`（对不上 ⇒ `[]`，绝不拿 A 游戏的事件目录解释 B 游戏）；
 * 3. **交接编译成品**：把这一轮的原始诊断 / 产物 / source map 记进 `@kojo/kojo-lang/diagnostic-result`
 *    ——预览面板与展开视图读的是**同一次编译**，不是第二份；
 * 4. **翻槽形状**：行 → `LineDecoration`（含跨行 `endLine`）。
 *
 * ## 项目级扫描为什么弃权（`bulk === true`）
 *
 * `project-diagnostics` 的扫描轮会对盘上每个文件问一遍全部装饰贡献。本贡献若在那轮作答，
 * `.kojo` 文件会同时吃两条结论——v1 糖线（`ui-sugar-editor`，它只认扩展名）与 2.0 编译，
 * 问题面板按路径整档替换 ⇒ 两条腿互相覆盖、计数翻倍。项目级 2.0 结论本来就有**唯一供方**
 * （`kojo2-project-analysis`，跨文件重名 / Layer / 接管 / 存储期），本贡献不参与那一轮。
 *
 * ## 插件缺席 / 没面时的形状
 *
 * 没面（该项目没登记 2.0 adapter + backend、或本插件未被装载时宿主找不到供方）⇒ **抛错**，
 * 由宿主诊断接线折成可见的 `kojo2/diagnostics-unavailable`（问题面板 + 通知中心），
 * 绝不交空数组——空数组的语义是"这份文件干净"。
 */
import type { EditorDecoratorContribution, GameProject, LineDecoration } from '@kojo/plugin-api';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang/constants';
import {
  KOJO2_DIAGNOSTIC_SOURCE,
  KOJO2_DIAGNOSTICS_CONTRIBUTION_ID,
  kojo2DocumentDiagnostics,
  kojo2SurfaceNow,
  type Kojo2DiagnosticRow,
} from '@kojo/kojo-lang/diagnostics';
import { rememberKojo2DiagnosticResult } from '@kojo/kojo-lang/diagnostic-result';

/** 装饰贡献的载荷（与槽契约同形；`bulk` 见 `EditorDecoratorContribution.decorate`） */
export interface Kojo2DiagnosticsFile {
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly bulk?: boolean;
}

/** 这份路径是不是 2.0 文档（`.kojo` / `.kojo2`；`.kojo1` 归 v1，不认） */
export function isKojo2DiagnosticsPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(KOJO_SOURCE_EXTENSION) || lower.endsWith(KOJO2_SOURCE_EXTENSION);
}

/** 一行诊断 → 契约的行装饰（列区间半开；跨行保留 `endLine`） */
export function toLineDecoration(row: Kojo2DiagnosticRow): LineDecoration {
  return {
    line: row.line,
    startColumn: row.startColumn,
    endColumn: row.endColumn,
    ...(row.endLine === row.line ? {} : { endLine: row.endLine }),
    severity: row.severity,
    message: row.message,
    code: row.code,
    source: KOJO2_DIAGNOSTIC_SOURCE,
  };
}

/**
 * 一份 2.0 正文的文档级诊断 → 行装饰（槽 `ui.editor.decorator` 的 `decorate` 实现体）。
 *
 * 纯呈现语义：不读盘、不写盘、不碰 Monaco；唯一的副作用是把这一轮编译成品交给
 * `diagnostic-result` 的交接面（预览 / 展开视图按同一份读，不二次编译）。
 */
export function provideKojo2Diagnostics(file: Kojo2DiagnosticsFile): LineDecoration[] {
  if (!isKojo2DiagnosticsPath(file.path)) return [];
  // 整项目扫描轮：项目级结论有唯一供方（`kojo2-project-analysis`），本贡献不参与（见文件头）。
  if (file.bulk === true) return [];
  const project = file.project;
  if (project === null) {
    throw new Error('没有当前项目：2.0 诊断要按项目的 adapter / backend 两面作答，本文件不做 2.0 诊断。');
  }
  const surface = kojo2SurfaceNow(file.path);
  if (surface === null) {
    throw new Error(
      `当前项目没有 2.0 诊断面（adapterId = ${project.adapterId}）：` +
        '该游戏未登记 2.0 adapter / backend，或宿主没有登记两面来源；本文件不做 2.0 诊断' +
        '（不回退到其它游戏的事实）。',
    );
  }
  // 只认 id 对得上的那一枚：组合根按项目现取，但对不上就不借（不猜）。
  if (surface.adapter.id !== project.adapterId) return [];
  const result = kojo2DocumentDiagnostics({
    source: file.text,
    filePath: file.path,
    adapter: surface.adapter,
    backend: surface.backend,
  });
  rememberKojo2DiagnosticResult(file.path, {
    source: file.text,
    diagnostics: result.diagnostics,
    artifacts: result.artifacts,
    error: result.error,
  });
  return result.rows.map(toLineDecoration);
}

/** 注册用的一枚贡献（`plugin.ts` 只做 `ctx.slots.register('ui.editor.decorator', ...)`） */
export function createKojo2DiagnosticsContribution(order: number): EditorDecoratorContribution {
  return {
    id: KOJO2_DIAGNOSTICS_CONTRIBUTION_ID,
    order,
    title: 'Kojo 2.0 文档诊断',
    decorate: (file) => provideKojo2Diagnostics(file),
  };
}