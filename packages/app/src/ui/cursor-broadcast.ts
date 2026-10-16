/**
 * 编辑器光标位点的宿主广播（C1 反向下行批；纯逻辑，零 React、零 DOM，可单测）。
 *
 * EditorPane 的三处触发——①光标位置变化（含拖选后活动端移动）②切文件 setModel /
 * 恢复视图完成 ③糖视图开关翻转——全部汇到同一个广播器。载荷构造只读"此刻事实"
 * （当前文件 + model 坐标 + 糖视图标志）；**连续相同载荷不发**：切文件时
 * setModel → 恢复视图 → 定位 会连着发数次，面板不该被同一位置惊动第二回。
 *
 * 去重判据按整份载荷逐字段比（filePath 原样比——三处触发取的是同一个
 * `filePathRef`，字符串自会一致；跨来源判等是**消费方**的事，走 `pathKey`）。
 */

import type { KernelEventMap } from '@kojo/plugin-api';

/** `editor.cursorMoved` 的载荷（事件契约是单一真源，这里只取别名） */
export type CursorMovedPayload = KernelEventMap['editor.cursorMoved'];

/** 位点探针（宿主现取；`position: null` = 编辑器里此刻没有光标） */
export interface CursorSiteProbe {
  /** 当前活动文件；`null` = 无打开文件 */
  readonly filePath: string | null;
  /** 模型坐标（1 基）；`null` = 无光标（无 model / 未初始化） */
  readonly position: { readonly lineNumber: number; readonly column: number } | null;
  /** `true` = 屏幕上显示的是转出来的糖视图（行号不属于真文件） */
  readonly derivedView: boolean;
}

/**
 * 位点事实 → 事件载荷（纯函数）。
 *
 * 没文件 / 没光标 → `{ filePath: null, line: 1, column: 1, derivedView: false }`
 * ——"无位点"是明确事实，不是错误（消费方据此清高亮）。
 */
export function cursorMovedPayload(probe: CursorSiteProbe | null): CursorMovedPayload {
  if (!probe || probe.filePath === null || probe.position === null) {
    return { filePath: null, line: 1, column: 1, derivedView: false };
  }
  return {
    filePath: probe.filePath,
    line: probe.position.lineNumber,
    column: probe.position.column,
    derivedView: probe.derivedView,
  };
}

/** 两份载荷是否逐字段相同（去重判据的单一真源） */
export function sameCursorPayload(a: CursorMovedPayload, b: CursorMovedPayload): boolean {
  return (
    a.filePath === b.filePath && a.line === b.line && a.column === b.column && a.derivedView === b.derivedView
  );
}

export interface CursorBroadcaster {
  /** 广播一份位点；与上一份逐字段相同 → 丢弃。返回是否真的发出（供测试与记数） */
  publish(payload: CursorMovedPayload): boolean;
}

/** 去重广播器（每次编辑器挂载一个实例；去重状态跨三处触发存活） */
export function createCursorBroadcaster(emit: (payload: CursorMovedPayload) => void): CursorBroadcaster {
  let last: CursorMovedPayload | null = null;
  return {
    publish(payload) {
      if (last !== null && sameCursorPayload(last, payload)) return false;
      last = payload;
      emit(payload);
      return true;
    },
  };
}
