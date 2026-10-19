/**
 * @kojo/plugin-ui-sugar-lift
 *
 * 语法糖**只读投影**插件（`ui.editor.liftPreview` 槽贡献）。
 *
 * 对**原生 ERB**：编辑器内直接把原文折叠、上方显示糖写法（整文件），纯前端显示、
 * 零写盘。`.kojo` 的 💡「转为语法糖写法」写回建议已于 2026-10-19（LIFT-2）删除：
 * 它要整段 round-trip 逐字节自证，实测行覆盖仅 6.5%，用户侧表现为"几乎不出现"；
 * 底层 `sugar.lift` 识别引擎保留，作为未来声明式导入器的内部能力，不再挂 UI 动作。
 *
 * 职责边界：
 * - 生产：`ui.editor.liftPreview`.provideLiftProject（只对 `.erb` 供）；
 * - 消费：`sugar.lift` 服务（纯函数）；
 * - **不读盘、不写盘**：投影只吃宿主已给的 `text`。
 */

import type {
  EditorLiftPreviewItem,
  Plugin,
  SugarLiftService,
  SugarProjectResult,
  SugarProjectStats,
} from '@kojo/plugin-api';
import { WellKnownServices, isErbDialectPath } from '@kojo/plugin-api';

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
    version: '0.6.0',
    requires: [WellKnownServices.SugarLift],
    activate(ctx) {
      const lift = ctx.inject<SugarLiftService>(WellKnownServices.SugarLift);

      // 投影是纯函数但开销不小，而 provider 会被 Monaco 反复调用——按 (path, text)
      // 做一层 memo。只留投影这一份：写回建议已删，不再有第二份扫描缓存。
      let projMemo: { path: string; text: string; result: SugarProjectResult } | null = null;

      const scanProject = (path: string, text: string): SugarProjectResult => {
        if (projMemo && projMemo.path === path && projMemo.text === text) return projMemo.result;
        let result: SugarProjectResult;
        try {
          result = lift.liftProject({ source: text, filePath: path });
        } catch (err: unknown) {
          ctx.log.warn(`.kojo 投影失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
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
        if (!isErbDialectPath(path)) return [];
        return scanProject(path, text).segments.map((s) => ({
          fromLine: s.fromLine,
          toLine: s.toLine,
          sugarText: s.sugarText,
          title: s.fromLine === s.toLine ? `第 ${s.fromLine} 行` : `第 ${s.fromLine}–${s.toLine} 行`,
          reason: '.kojo 投影：只读显示，不改动原文件',
          nativeOnly: s.nativeOnly, // 兜底段标记原样透传（additive；真糖段 = undefined）
          // 段内糖行 ↔ 源行号的映射**逐字透传**，不在这里重算也不在这里补默认值：
          // 投影侧（`kojo-sugar/project.ts` 的 `toSegment`）是唯一尺子，宿主按 `sugarText` 剪
          // 首尾空行时要用同一张表剪映射（`sugar-view.ts` 的 `trimSegmentBlanksWithMap`）；
          // 这里一旦"替它算一个"，两处就会各自分叉且错得静默。
          sourceLines: s.sourceLines,
        }));
      };

      ctx.slots.register('ui.editor.liftPreview', {
        id: 'sugar-lift.preview',
        provideLiftProject: ({ path, text }) => toProjectItems(path, text),
      });
    },
  };
}
