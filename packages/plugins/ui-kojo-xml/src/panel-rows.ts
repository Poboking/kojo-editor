/**
 * 命中列表的「摊平 + 渲染窗口」（纯函数面：零 React、零 DOM）。
 *
 * 为什么把行摊平从渲染里拆出来：面板原先在 `panel.ts` 里逐层 `rows.push(...)`
 * 把 角色→文件→条目 全量摆成 ReactNode——eraFL 真盘实测 293 份 XML / 61,562 条
 * 口上、单文件最大 2,445 条，搜索态「全展开」一次就能挂出六万行 DOM（2026-11-02
 * 规模批读数，见本车道提交信息）。行的**构建顺序与折叠语义**是可枚举的事实，必须
 * 能在没有 DOM 的单测里钉住；渲染层只剩"把窗口内那几行摆成 DOM"。
 *
 * 窗口形状逐字照同仓先例（`ui-state-replay` 的谓词窗 / `ui-convention-report` 的
 * 条目窗）：窗口**数学**（`windowSize` / `nextWindow` / `growWindow`）住在契约层
 * `sugar-panels`，本模块只声明**本面板的窗口参数**与 `mustInclude` 覆盖那一维。
 * 搜索时「全展开」的既有语义**不动**（命中项散在各组里，让作者再点开一层才知道
 * 有没有命中，等于白筛——注释原话）：本模块只收口**一次挂载的行数**，不收口命中。
 */

import { nextWindow, windowSize, type RenderWindow } from '@kojo/plugin-api';
import type { PanelCharaNode, PanelCommandNode, PanelFileNode, PanelTree } from './panel-tree';

/* ------------------------------ 行描述符 ------------------------------ */

/**
 * 摊平后的一行。
 *
 * `key` 沿用原渲染的 React key（`chara.id` / `file.id` / `command.id` /
 * `${command.id}:preview`），渲染层直接用它，折叠态换页不引发错位重挂。
 */
export type PanelRow =
  | { readonly kind: 'chara'; readonly key: string; readonly chara: PanelCharaNode; readonly open: boolean }
  | {
      readonly kind: 'file';
      readonly key: string;
      readonly chara: PanelCharaNode;
      readonly file: PanelFileNode;
      readonly open: boolean;
    }
  | {
      readonly kind: 'command';
      readonly key: string;
      readonly chara: PanelCharaNode;
      readonly file: PanelFileNode;
      readonly command: PanelCommandNode;
    }
  | {
      readonly kind: 'preview';
      readonly key: string;
      readonly chara: PanelCharaNode;
      readonly command: PanelCommandNode;
    };

/** 摊平入参：当前视图态（与渲染闭包里的同名状态一一对应） */
export interface PanelRowsView {
  /** 搜索中——角色与文件视为全部展开（既有语义，见文件头） */
  readonly searching: boolean;
  readonly openCharas: ReadonlySet<string>;
  readonly openFiles: ReadonlySet<string>;
  /** 当前展开预览的条目 id（null = 没有；同一时刻只开一条） */
  readonly previewId: string | null;
}

/**
 * 过滤后的树 + 视图态 → 有序行数组（顺序与原渲染逐层 push 完全一致）。
 * 空树给空数组——渲染层据此保留「没有匹配 / 还没有条目」两句既有文案。
 */
export function flattenPanelRows(
  tree: PanelTree | null,
  view: PanelRowsView,
): PanelRow[] {
  const rows: PanelRow[] = [];
  if (!tree) return rows;
  for (const chara of tree.charas) {
    const charaOpen = view.searching || view.openCharas.has(chara.id);
    rows.push({ kind: 'chara', key: chara.id, chara, open: charaOpen });
    if (!charaOpen) continue;

    for (const file of chara.files) {
      const fileOpen = view.searching || view.openFiles.has(file.id);
      rows.push({ kind: 'file', key: file.id, chara, file, open: fileOpen });
      if (!fileOpen) continue;

      for (const command of file.commands) {
        rows.push({ kind: 'command', key: command.id, chara, file, command });
        if (view.previewId === command.id) {
          rows.push({ kind: 'preview', key: `${command.id}:preview`, chara, command });
        }
      }
    }
  }
  return rows;
}

/* ------------------------------ 渲染窗口 ------------------------------ */

/**
 * 命中列表的渲染窗口（触底增窗）。
 *
 * 取值依据：三层行都是单行小钮（~20px），初值 120 ≈ 数屏余量——未搜索态一行 =
 * 一个角色，129 个角色目录（eraFL 真盘）基本一窗盖住；点开单文件最坏 2,445 条
 * （真盘最大 KOJO_K1180_COM.xml），按步长 240 十步内到底。1:2 节奏与谓词区
 * （`PRED_WINDOW` 120/240）同档，面板间互印不另立一把尺。
 */
export const NAV_WINDOW: RenderWindow = { initial: 120, step: 240 };
/** 初始窗口行数（导出常量名照 VAR_WINDOW_INITIAL / PRED_WINDOW_INITIAL 先例） */
export const NAV_WINDOW_INITIAL = NAV_WINDOW.initial;
/** 每次追加的行数 */
export const NAV_WINDOW_STEP = NAV_WINDOW.step;

/**
 * 当前窗口应渲染的行数（纯函数）：[0, min(total, max(limit ?? INITIAL, mustInclude))]。
 *
 * `mustInclude` 是「从编辑器点名跳转的那一行必须落在窗口内」的覆盖口径（照
 * `predWindowSize` 的 G1 语义）：目标行号在初始窗口之外时，窗口撑大到盖住它——
 * 窗口化不许把「点名必可见」这条承诺弄丢。0 = 无需覆盖。
 *
 * 与谓词窗同理**刻意不走契约的 `windowSize`**：它没有 `mustInclude` 这一维
 * （本面板独有），少一个参数就少一处会被将来"顺手统一"掉的行为。
 */
export function navWindowSize(total: number, limit: number | undefined, mustInclude = 0): number {
  return Math.min(total, Math.max(limit ?? NAV_WINDOW.initial, mustInclude));
}

/**
 * 窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))。
 * 单调不减、单步增量 ≤ STEP、终值 = total——「显示更多」与触底自动加载共用。
 */
export function nextNavWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, NAV_WINDOW);
}
