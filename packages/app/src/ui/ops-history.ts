/**
 * 操作历史（2026-10-16 undo 批）的宿主纯逻辑——照 `file-history.ts` 同族形态：
 * 常量 + 人读口径住在小模块，组件在 `OpsHistoryOverlay.tsx`。
 *
 * 本 overlay 没有"目标文件"概念（列的是全局批操作），不需要状态单源；
 * undo 后的重载由组件内部重取。数据真源是内核 `kernel.ops`（OpJournal），
 * 本层零第二套记录约定。
 */

import type { OpRecord } from '@kojo/plugin-api';

/** ui.overlay 贡献 id（宿主注册；命令 run 里发 `ui.overlay.open`） */
export const OPS_HISTORY_OVERLAY_ID = 'kojo.opsHistory';

/** editor.command 贡献 id（命令面板条目：「操作历史（批回滚）」） */
export const SHOW_OPS_HISTORY_COMMAND_ID = 'kojo.showOpsHistory';

/** 操作类别人读（undo:<kind> 递归展开一层） */
const KIND_LABELS: Record<string, string> = {
  scaffold: '新建制品（脚手架）',
  'sugar-save': '保存 .kojo（源+产物）',
  'snapshot-inject': '注入存档变量',
  'search-replace': '全部替换（跨文件）',
  deploy: '部署包到游戏目录',
  'market-install': '安装市场包',
  'market-uninstall': '卸载市场包',
};

export function opKindLabel(kind: string): string {
  if (kind.startsWith('undo:')) return `撤销 · ${KIND_LABELS[kind.slice(5)] ?? kind.slice(5)}`;
  return KIND_LABELS[kind] ?? kind;
}

/** 操作时刻的人读文本（startedAt；与本地时间线 formatVersionTime 同口径） */
export function formatOpTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 状态徽标人读（committed=可撤销 / undone=已撤销，其 undo 可再撤销=重做） */
export function opStatusLabel(rec: Pick<OpRecord, 'status'>): string {
  return rec.status === 'undone' ? '已撤销（可重做）' : '可撤销';
}
