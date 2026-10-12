/**
 * @kojo/plugin-ui-sugar-lift
 *
 * 语法糖**就地动作**插件（`ui.editor.liftPreview` + `ui.editor.codeAction` 两槽贡献）。
 *
 * ## 两条路径，别混（2026-10-12 用户口径修正）
 *
 * | 文件 | 交互 | 落点 | 服务 |
 * |---|---|---|---|
 * | **`.kojo`** | 光标停在原生 ERB 直通行上 → 💡「改为语法糖写法」 | **改源文件**（可 `Ctrl+Z` 撤回） | `sugar.lift`（round-trip 自证口径） |
 * | **`.erb`** | 编辑器内**直接**把原文折叠、上方显示糖写法（整文件） | 纯前端显示，**零写盘** | `sugar.lift`.liftProject（逐行降级口径） |
 *
 * `.erb` 那条**不是一个面板**：读者不该"点开面板再一一对应"——那是把理解成本
 * 又推回给用户。糖视图由宿主在编辑器里落地（`provideLiftProject` 供给段），
 * 面板已按用户要求**删除并停止后续开发**。
 *
 * ## 本插件的职责边界
 *
 * - 生产：💡 动作（`ui.editor.codeAction`，只对 `.kojo` 供）＋ 整文件投影段
 *   （`ui.editor.liftPreview`.provideLiftProject，只对 `.erb` 供）；
 * - 消费：`sugar.lift` 服务（纯函数）＋ 只读 `kernel.io`（读文件文本）；
 * - **不写盘**：💡 只改**编辑器里的 model**（用户自己 Ctrl+S 才落盘，走既有保存链路）。
 *   所以本插件既不注入 `sugar.liftApply`，也不持有任何写逻辑。
 */

import type {
  EditorCodeAction,
  EditorLiftPreviewItem,
  FileIO,
  Plugin,
  SugarLiftResult,
  SugarLiftService,
  SugarProjectResult,
  SugarProjectStats,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { actionTitle, pickCandidate, toSugarEdit } from './lift-action';

/** 投影降级时的空统计（扫描抛错 → 无段无统计，**不静默**：宿主会收到零段） */
const EMPTY_PROJECT_STATS: SugarProjectStats = {
  totalLines: 0,
  projectedLines: 0,
  passthroughLines: 0,
  nativeLines: 0,
  nativeByReason: [],
};

export function createUiSugarLiftPlugin(): Plugin {
  return {
    id: 'ui-sugar-lift',
    version: '0.4.0',
    // 只注入识别服务 + 只读 io；**不注入 sugar.liftApply**——本插件不写盘
    requires: [WellKnownServices.SugarLift, KernelServices.IO],
    activate(ctx) {
      const lift = ctx.inject<SugarLiftService>(WellKnownServices.SugarLift);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      /* ------------------------ 扫描 + memo（各槽共用） ------------------------ */

      // 两个服务都是纯函数但开销不小，而 provider 会被 Monaco 反复调用——按
      // (path, text) 各做一层 memo（分开两个：触发面不同，"只要投影"的文件不该白跑
      // 一遍最贵的 round-trip 自证）。
      let memo: { path: string; text: string; result: SugarLiftResult } | null = null;
      let projMemo: { path: string; text: string; result: SugarProjectResult } | null = null;

      const scan = (path: string, text: string): SugarLiftResult => {
        if (memo && memo.path === path && memo.text === text) return memo.result;
        let result: SugarLiftResult;
        try {
          result = lift.liftSuggest({ source: text, filePath: path });
        } catch (err: unknown) {
          ctx.log.warn(`升糖扫描失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
          result = { candidates: [], skipped: [], degraded: false };
        }
        memo = { path, text, result };
        return result;
      };

      const scanProject = (path: string, text: string): SugarProjectResult => {
        if (projMemo && projMemo.path === path && projMemo.text === text) return projMemo.result;
        let result: SugarProjectResult;
        try {
          result = lift.liftProject({ source: text, filePath: path });
        } catch (err: unknown) {
          ctx.log.warn(`糖投影失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
          result = { segments: [], stats: EMPTY_PROJECT_STATS };
        }
        projMemo = { path, text, result };
        return result;
      };

      /**
       * 整文件投影 → 就地视图项（宿主糖视图的供给）。
       *
       * 只对**原生 ERB** 供给：`.kojo` 本身就是糖，再投影一遍毫无意义
       * （契约明确"不适用该文件的贡献返回空数组"）。
       */
      const toProjectItems = (path: string, text: string): EditorLiftPreviewItem[] => {
        if (!isErbFile(path)) return [];
        return scanProject(path, text).segments.map((s) => ({
          fromLine: s.fromLine,
          toLine: s.toLine,
          sugarText: s.sugarText,
          title: s.fromLine === s.toLine ? `第 ${s.fromLine} 行` : `第 ${s.fromLine}–${s.toLine} 行`,
          reason: '语法糖投影：只读显示，不改动原文件',
        }));
      };

      /* ------------------------- 槽一：整文件投影供给 ------------------------- */

      ctx.slots.register('ui.editor.liftPreview', {
        id: 'sugar-lift.preview',
        provideLiftProject: ({ path, text }) => toProjectItems(path, text),
      });

      /* --------------------------- 槽二：💡 改为语法糖 --------------------------- */

      // 只对 **`.kojo`** 供动作：那是一份"作者在写"的糖文件，把里面的原生 ERB
      // 直通行换成糖写法是**编辑**（可撤销）。`.erb` 不给这个动作——它恒只读
      // （或解锁后糖视图关闭），改它没有意义。
      ctx.slots.register('ui.editor.codeAction', {
        id: 'sugar-lift.rewrite-action',
        provideActions: ({ path, text, line }) => {
          if (!isKojoFile(path) || line === undefined) return [];
          const hit = pickCandidate(scan(path, text).candidates, line);
          if (!hit) return [];
          const sourceLines = text.split('\n');
          const action: EditorCodeAction = {
            title: actionTitle(hit),
            kind: 'refactor',
            // 就地改写（宿主 executeEdits 落地，一次撤销步）——**改的是 model**，
            // 落盘仍由用户 Ctrl+S 走既有保存链路（本插件不碰磁盘）。
            edits: [toSugarEdit(hit, sourceLines)],
            // 有 `edits` 时宿主不会调 `run`；仍提供它以满足契约（且作为无宿主支持时的兜底）。
            run: () => undefined,
          };
          return [action];
        },
      });
    },
  };
}

/* ============================== 内部工具 ============================== */

/**
 * 是否原生 ERB（`.erb` / `.erm`）。
 *
 * 与 app 壳的 `isErbLike` 同口径（那边定"是否只读预览对象"，这边定"是否该投影"）。
 * 刻意不跨包共享：两处都是单行判定，而插件**不允许** import 宿主代码
 * （"一切皆插件"纪律），为一行正则新增契约导出不划算。
 */
function isErbFile(path: string): boolean {
  return /\.er[bm]$/i.test(path);
}

/** 是否语法糖源文件（`.kojo`）——💡 改写动作的对象 */
function isKojoFile(path: string): boolean {
  return /\.kojo$/i.test(path);
}
