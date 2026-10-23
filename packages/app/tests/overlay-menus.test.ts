// @vitest-environment happy-dom
/**
 * 四个浮窗面的右键菜单（1023 覆盖面批 · WP3.4 / 3.5 / 3.6）。
 *
 * 判据（只打纯函数与 DOM 读取，不建立在完整渲染上）：
 * - 每个面的菜单项集合（行级 / 面板级 / 能力差异）；
 * - 能力矩阵：能恢复 / 能彻底删除 / **不能接受也不能拒绝**（只读面不给写盘入口）、
 *   能跳差异；不可用时**禁用且说清原因**（铁律 4），能力根本不存在时**整项不显示**；
 * - label 全中文（含 CJK）；
 * - 恢复 / 删除类项必须带 `danger` 或独立分组（不靠颜色区分破坏性动作）。
 */
import { describe, expect, it } from 'vitest';
import { CONTEXT_SURFACE_MANIFEST, getContextSurface } from '../src/ui/context-surfaces';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import {
  CALL_HIERARCHY_MENU_IDS,
  buildCallHierarchyMenu,
  readCallHierarchyMenuInput,
  type CallHierarchyMenuInput,
  type CallHierarchyRowRef,
} from '../src/ui/call-hierarchy';
import {
  DIFF_VIEW_MENU_IDS,
  buildDiffViewMenu,
  diffSummaryText,
  type DiffViewMenuInput,
} from '../src/ui/diff-view';
import {
  FILE_HISTORY_MENU_IDS,
  buildFileHistoryMenu,
  readFileHistoryRow,
  type FileHistoryMenuInput,
} from '../src/ui/FileHistoryOverlay';
import {
  OPS_HISTORY_MENU_IDS,
  buildOpsHistoryMenu,
  readOpsHistoryRow,
  type OpsHistoryMenuInput,
} from '../src/ui/OpsHistoryOverlay';
// 只为触发模块顶层的 `declareContextSurface`（面的登记在模块加载时完成）
import '../src/ui/CallHierarchyOverlay';
import '../src/ui/DiffViewOverlay';

/* ------------------------------ 夹具与断言助手 ------------------------------ */

const idsOf = (items: readonly ContextMenuItem[]): string[] => items.map((item) => item.id);
const itemOf = (items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined =>
  items.find((item) => item.id === id);

/** 破坏性 / 恢复类动作的 id（必须带危险色或独立分组，不能与普通过复制混在一起） */
const RESTORE_LIKE_IDS: ReadonlySet<string> = new Set([
  FILE_HISTORY_MENU_IDS.restore,
  FILE_HISTORY_MENU_IDS.purge,
  OPS_HISTORY_MENU_IDS.undo,
  OPS_HISTORY_MENU_IDS.restore,
  OPS_HISTORY_MENU_IDS.purge,
]);

function expectAllChinese(items: readonly ContextMenuItem[]): void {
  for (const item of items) {
    expect(isChineseMenuLabel(item.label), `${item.id} → ${item.label}`).toBe(true);
    if (item.children !== undefined) expectAllChinese(item.children);
  }
}

/** 禁用项必须带原因（灰着不说话 = 按了没反应） */
function expectDisabledSpeaks(items: readonly ContextMenuItem[]): void {
  for (const item of items) {
    if (item.disabled === true) {
      expect(typeof item.disabledReason === 'string' && item.disabledReason.length > 0, item.id).toBe(true);
    }
  }
}

const groupRow = (over: Partial<CallHierarchyRowRef> = {}): CallHierarchyRowRef => ({
  kind: 'group',
  section: 'in',
  name: '@你好',
  path: 'C:/game/ERB/COMMON.ERB',
  line: 120,
  column: null,
  count: 2,
  sites: ['C:/game/ERB/A.ERB:10:3', 'C:/game/ERB/B.ERB:20:5'],
  ...over,
});

const callInput = (over: Partial<CallHierarchyMenuInput> = {}): CallHierarchyMenuInput => ({
  row: null,
  subject: { name: '@你好', path: 'C:/game/ERB/COMMON.ERB', line: 120 },
  clipboardAvailable: true,
  hidden: { in: 0, out: 0 },
  total: { in: 2, out: 0 },
  listText: '@有人（C:/game/ERB/X.ERB:5）\n  ↳ C:/game/ERB/COMMON.ERB:120:2',
  ...over,
});

const fileRow = (over: Partial<NonNullable<FileHistoryMenuInput['row']>> = {}): NonNullable<FileHistoryMenuInput['row']> => ({
  key: 'backup:v1',
  account: 'backup',
  title: '磁盘内容（保存前的自动备份）',
  timeText: '2026-10-20 10:00:00',
  keepText: '',
  path: 'C:/appData/backup/COMMON.ERB.v1.bak',
  hasAction: true,
  actionLabel: '恢复这一版',
  actionKind: 'restoreBackup',
  pendingAction: null,
  busy: false,
  ...over,
});

const fileInput = (over: Partial<FileHistoryMenuInput> = {}): FileHistoryMenuInput => ({
  row: fileRow(),
  targetPath: 'C:/game/ERB/COMMON.ERB',
  clipboardAvailable: true,
  ...over,
});

const opsRow = (over: Partial<NonNullable<OpsHistoryMenuInput['row']>> = {}): NonNullable<OpsHistoryMenuInput['row']> => ({
  key: 'ops:op-1',
  account: 'ops',
  title: '批操作「跨文件全部替换」',
  timeText: '2026-10-20 10:00:00',
  path: null,
  hasAction: true,
  actionLabel: '撤销这一批',
  actionKind: 'undoOp',
  status: 'committed',
  fileCount: 3,
  expandable: true,
  expanded: false,
  pendingAction: null,
  busy: false,
  ...over,
});

const opsInput = (over: Partial<OpsHistoryMenuInput> = {}): OpsHistoryMenuInput => ({
  row: opsRow(),
  clipboardAvailable: true,
  ...over,
});

const diffInput = (over: Partial<DiffViewMenuInput> = {}): DiffViewMenuInput => ({
  title: 'COMMON.ERB · 写前备份 2026-10-20 10:00:00',
  leftLabel: '写前备份 · 2026-10-20 10:00:00',
  rightLabel: '磁盘当前内容',
  leftPath: 'C:/appData/backup/COMMON.ERB.v1.bak',
  rightPath: 'C:/game/ERB/COMMON.ERB',
  editorReady: true,
  sideBySide: true,
  paneCount: 1,
  bannerMessage: null,
  clipboardAvailable: true,
  ...over,
});

/* ------------------------------ 面登记 ------------------------------ */

describe('四个浮窗面 · 登记', () => {
  it.each(['call-hierarchy', 'file-history', 'ops-history', 'diff-view'])(
    '%s 已声明 build，且在权威清单里',
    (id) => {
      const spec = getContextSurface(id);
      expect(spec, id).toBeDefined();
      expect(typeof spec?.build).toBe('function');
      expect(CONTEXT_SURFACE_MANIFEST.some((entry) => entry.id === id), id).toBe(true);
      expect(isChineseMenuLabel(spec!.ariaLabel), id).toBe(true);
    },
  );
});

/* ------------------------------ 调用层级（WP3.4） ------------------------------ */

describe('调用层级菜单', () => {
  it('组行：跳转 / 重定查询 / 复制调用链 / 复制位置（没有藏行就不给展开项）', () => {
    const menu = buildCallHierarchyMenu(callInput({ row: groupRow() }));
    expect(idsOf(menu!.items)).toEqual([
      CALL_HIERARCHY_MENU_IDS.jump,
      CALL_HIERARCHY_MENU_IDS.recenter,
      CALL_HIERARCHY_MENU_IDS.copyChain,
      CALL_HIERARCHY_MENU_IDS.copyLocation,
      CALL_HIERARCHY_MENU_IDS.copyList,
      CALL_HIERARCHY_MENU_IDS.refresh,
      CALL_HIERARCHY_MENU_IDS.close,
    ]);
    expect(itemOf(menu!.items, CALL_HIERARCHY_MENU_IDS.copyChain)?.label).toContain('2 处');
    expectAllChinese(menu!.items);
  });

  it('点位行：出调用侧不给「查看调用者」（点位就在当前函数体内，重定查询是原地绕圈）', () => {
    const siteRow: CallHierarchyRowRef = {
      kind: 'site',
      section: 'out',
      name: '@你好',
      path: 'C:/game/ERB/COMMON.ERB',
      line: 128,
      column: 5,
      count: 0,
      sites: [],
    };
    const menu = buildCallHierarchyMenu(callInput({ row: siteRow }));
    const ids = idsOf(menu!.items);
    expect(ids).toContain(CALL_HIERARCHY_MENU_IDS.jump);
    expect(ids).toContain(CALL_HIERARCHY_MENU_IDS.copyLocation);
    expect(ids).not.toContain(CALL_HIERARCHY_MENU_IDS.copyChain);
    expect(ids).not.toContain(CALL_HIERARCHY_MENU_IDS.recenter);
  });

  it('入调用侧的点位行可以「查看调用者的调用层级」', () => {
    const menu = buildCallHierarchyMenu(
      callInput({
        row: {
          kind: 'site',
          section: 'in',
          name: '@有人',
          path: 'C:/game/ERB/X.ERB',
          line: 5,
          column: 2,
          count: 0,
          sites: [],
        },
      }),
    );
    const recenter = menu!.items.filter((item) => item.id === CALL_HIERARCHY_MENU_IDS.recenter);
    expect(recenter).toHaveLength(1);
    expect(recenter[0]!.label).toContain('调用者');
  });

  it('藏了行 ⇒ 出「展开更多行」并按 section 分开说明', () => {
    const menu = buildCallHierarchyMenu(callInput({ hidden: { in: 7, out: 3 }, total: { in: 130, out: 12 } }));
    const ids = idsOf(menu!.items);
    expect(ids).toContain(CALL_HIERARCHY_MENU_IDS.expandIn);
    expect(ids).toContain(CALL_HIERARCHY_MENU_IDS.expandOut);
    expect(itemOf(menu!.items, CALL_HIERARCHY_MENU_IDS.expandIn)?.label).toContain('7');
    expect(itemOf(menu!.items, CALL_HIERARCHY_MENU_IDS.expandOut)?.label).toContain('3');
  });

  it('没有剪贴板 ⇒ 复制项禁用且带原因（不静默）', () => {
    const menu = buildCallHierarchyMenu(callInput({ row: groupRow(), clipboardAvailable: false }));
    expect(itemOf(menu!.items, CALL_HIERARCHY_MENU_IDS.copyChain)?.disabled).toBe(true);
    expect(itemOf(menu!.items, CALL_HIERARCHY_MENU_IDS.copyChain)?.disabledReason).toContain('剪贴板');
    expectDisabledSpeaks(menu!.items);
  });

  it('没有请求 ⇒ 刷新禁用并说明；清单为空 ⇒ 不给复制清单', () => {
    const menu = buildCallHierarchyMenu(callInput({ subject: null, listText: '' }));
    expect(idsOf(menu!.items)).toEqual([CALL_HIERARCHY_MENU_IDS.refresh, CALL_HIERARCHY_MENU_IDS.close]);
    expect(itemOf(menu!.items, CALL_HIERARCHY_MENU_IDS.refresh)?.disabled).toBe(true);
    expectDisabledSpeaks(menu!.items);
  });

  it('DOM 读取：面板级事实与组行身份都能从属性还原（含清单文本）', () => {
    document.body.innerHTML = `
      <div data-context-surface="call-hierarchy"
           data-ch-subject-name="@你好" data-ch-subject-path="C:/game/ERB/COMMON.ERB"
           data-ch-subject-line="120" data-ch-hidden-in="4" data-ch-hidden-out="0"
           data-ch-total-in="10" data-ch-total-out="2">
        <button data-ch-row="group" data-ch-section="in" data-ch-name="@有人"
                data-ch-path="C:/game/ERB/X.ERB" data-ch-line="5" data-ch-count="2"
                data-ch-chain="C:/game/ERB/COMMON.ERB:120:2&#10;C:/game/ERB/COMMON.ERB:130:4">
          <span id="probe">@有人</span>
        </button>
      </div>`;
    const probe = document.querySelector<HTMLElement>('#probe')!;
    const input = readCallHierarchyMenuInput(probe, { clipboardAvailable: true });
    expect(input.subject).toEqual({ name: '@你好', path: 'C:/game/ERB/COMMON.ERB', line: 120 });
    expect(input.hidden).toEqual({ in: 4, out: 0 });
    expect(input.total).toEqual({ in: 10, out: 2 });
    expect(input.row).toMatchObject({ kind: 'group', name: '@有人', count: 2, section: 'in' });
    expect(input.row?.sites).toHaveLength(2);
    expect(input.listText).toContain('@有人（C:/game/ERB/X.ERB:5）');
    expect(input.listText).toContain('↳ C:/game/ERB/COMMON.ERB:130:4');
  });
});

/* ------------------------------ 文件历史（WP3.5） ------------------------------ */

describe('文件历史菜单', () => {
  it('可恢复 + 可对比的行：复制 / 对比 / 恢复（恢复带独立分组）', () => {
    const menu = buildFileHistoryMenu(fileInput());
    expect(idsOf(menu!.items)).toEqual([
      FILE_HISTORY_MENU_IDS.copySummary,
      FILE_HISTORY_MENU_IDS.diffNow,
      FILE_HISTORY_MENU_IDS.copyPath,
      FILE_HISTORY_MENU_IDS.restore,
      FILE_HISTORY_MENU_IDS.refresh,
      FILE_HISTORY_MENU_IDS.copyTargetPath,
      FILE_HISTORY_MENU_IDS.close,
    ]);
    const restore = itemOf(menu!.items, FILE_HISTORY_MENU_IDS.restore)!;
    expect(restore.dividerBefore).toBe(true);
    expect(restore.group).toBe('恢复');
    expect(restore.label).toContain('需再点一次确认');
    expectAllChinese(menu!.items);
  });

  it('回收站条目：多出「彻底删除」（危险色 + 独立分组）', () => {
    const menu = buildFileHistoryMenu(
      fileInput({
        row: fileRow({ account: 'trash', actionKind: 'restoreTrash', actionLabel: '放回原位' }),
      }),
    );
    const purge = itemOf(menu!.items, FILE_HISTORY_MENU_IDS.purge)!;
    expect(purge).toBeDefined();
    expect(purge.danger).toBe(true);
    expect(purge.group).toBe('删除');
    expect(purge.label).toContain('彻底删除');
  });

  it('能力缺失 ⇒ 整项不显示：没有动作不给恢复，没有盘上文件不给对比 / 复制路径', () => {
    const menu = buildFileHistoryMenu(
      fileInput({ row: fileRow({ hasAction: false, actionKind: null, actionLabel: null, path: null }) }),
    );
    const ids = idsOf(menu!.items);
    expect(ids).not.toContain(FILE_HISTORY_MENU_IDS.restore);
    expect(ids).not.toContain(FILE_HISTORY_MENU_IDS.diffNow);
    expect(ids).not.toContain(FILE_HISTORY_MENU_IDS.copyPath);
    // 面板级的复制目标路径仍在（目标文件还在）
    expect(ids).toContain(FILE_HISTORY_MENU_IDS.copyTargetPath);
  });

  it('正在写入 ⇒ 恢复 / 彻底删除禁用且带原因', () => {
    const menu = buildFileHistoryMenu(
      fileInput({ row: fileRow({ account: 'trash', actionKind: 'restoreTrash', actionLabel: '放回原位', busy: true }) }),
    );
    expect(itemOf(menu!.items, FILE_HISTORY_MENU_IDS.restore)?.disabled).toBe(true);
    expect(itemOf(menu!.items, FILE_HISTORY_MENU_IDS.purge)?.disabled).toBe(true);
    expectDisabledSpeaks(menu!.items);
  });

  it('已点亮确认 ⇒ 菜单文案如实说明"回行上再点一次"（菜单不当第二道确认）', () => {
    const menu = buildFileHistoryMenu(fileInput({ row: fileRow({ pendingAction: 'restore' }) }));
    expect(itemOf(menu!.items, FILE_HISTORY_MENU_IDS.restore)?.label).toContain('已点亮确认');
  });

  it('面板级（没点在行上）：只有刷新 / 复制目标路径 / 关闭', () => {
    const menu = buildFileHistoryMenu(fileInput({ row: null }));
    expect(idsOf(menu!.items)).toEqual([
      FILE_HISTORY_MENU_IDS.refresh,
      FILE_HISTORY_MENU_IDS.copyTargetPath,
      FILE_HISTORY_MENU_IDS.close,
    ]);
  });

  it('连目标文件都没有（这一屏是空态）：只剩关闭，不摆无效的刷新', () => {
    const menu = buildFileHistoryMenu(fileInput({ row: null, targetPath: null }));
    expect(idsOf(menu!.items)).toEqual([FILE_HISTORY_MENU_IDS.close]);
  });

  it('DOM 读取：行身份从属性还原；认不出的账本 ⇒ null（回落面板级）', () => {
    document.body.innerHTML = `
      <table><tbody><tr data-fh-key="trash:t1" data-fh-account="trash" data-fh-title="删除文件 · A.ERB"
        data-fh-time="2026-10-20 10:00:00" data-fh-keep="剩 3 天"
        data-fh-path="C:/appData/trash/t1/A.ERB" data-fh-action="restoreTrash" data-fh-action-label="放回原位">
        <td><span id="probe">删除文件</span></td></tr></tbody></table>`;
    const probe = document.querySelector<HTMLElement>('#probe')!;
    expect(readFileHistoryRow(probe)).toMatchObject({
      key: 'trash:t1',
      account: 'trash',
      hasAction: true,
      actionKind: 'restoreTrash',
      actionLabel: '放回原位',
      path: 'C:/appData/trash/t1/A.ERB',
      keepText: '剩 3 天',
    });
    document.body.innerHTML = '<table><tbody><tr data-fh-key="x:1" data-fh-account="未知账本"><td><span id="p2">x</span></td></tr></tbody></table>';
    expect(readFileHistoryRow(document.querySelector<HTMLElement>('#p2')!)).toBeNull();
  });
});

/* ------------------------------ 操作历史（WP3.5） ------------------------------ */

describe('操作历史菜单', () => {
  it('批操作行：展开清单 + 撤销 + 复制（恢复带独立分组）', () => {
    const menu = buildOpsHistoryMenu(opsInput());
    expect(idsOf(menu!.items)).toEqual([
      OPS_HISTORY_MENU_IDS.toggleDetail,
      OPS_HISTORY_MENU_IDS.copySummary,
      OPS_HISTORY_MENU_IDS.undo,
      OPS_HISTORY_MENU_IDS.refresh,
      OPS_HISTORY_MENU_IDS.close,
    ]);
    const undo = itemOf(menu!.items, OPS_HISTORY_MENU_IDS.undo)!;
    expect(undo.label).toContain('撤销此操作');
    expect(undo.group).toBe('恢复');
    expectAllChinese(menu!.items);
  });

  it('已撤销的批 ⇒ 文案变「重做这一批」；已展开 ⇒ 变「收起文件清单」', () => {
    const menu = buildOpsHistoryMenu(opsInput({ row: opsRow({ status: 'undone', expanded: true }) }));
    expect(itemOf(menu!.items, OPS_HISTORY_MENU_IDS.undo)?.label).toContain('重做这一批');
    expect(itemOf(menu!.items, OPS_HISTORY_MENU_IDS.toggleDetail)?.label).toBe('收起文件清单');
  });

  it('回收站行：放回原位 + 彻底删除（危险色 + 独立分组），没有撤销', () => {
    const menu = buildOpsHistoryMenu(
      opsInput({
        row: opsRow({
          key: 'trash:t1',
          account: 'trash',
          actionKind: 'restoreTrash',
          actionLabel: '放回原位',
          status: null,
          expandable: false,
          path: 'C:/appData/trash/t1/A.ERB',
        }),
      }),
    );
    const ids = idsOf(menu!.items);
    expect(ids).not.toContain(OPS_HISTORY_MENU_IDS.undo);
    expect(ids).not.toContain(OPS_HISTORY_MENU_IDS.toggleDetail);
    expect(ids).toContain(OPS_HISTORY_MENU_IDS.restore);
    expect(ids).toContain(OPS_HISTORY_MENU_IDS.purge);
    expect(itemOf(menu!.items, OPS_HISTORY_MENU_IDS.purge)?.danger).toBe(true);
    expect(ids).toContain(OPS_HISTORY_MENU_IDS.copyPath);
  });

  it('没有动作（写允许域已收回）⇒ 不给恢复类项，只剩复制 / 刷新 / 关闭', () => {
    const menu = buildOpsHistoryMenu(
      opsInput({
        row: opsRow({ hasAction: false, actionKind: null, actionLabel: null, expandable: false }),
      }),
    );
    const ids = idsOf(menu!.items);
    expect(ids).toEqual([
      OPS_HISTORY_MENU_IDS.copySummary,
      OPS_HISTORY_MENU_IDS.refresh,
      OPS_HISTORY_MENU_IDS.close,
    ]);
  });

  it('正在写入 ⇒ 恢复类项禁用且带原因', () => {
    const menu = buildOpsHistoryMenu(opsInput({ row: opsRow({ busy: true }) }));
    expect(itemOf(menu!.items, OPS_HISTORY_MENU_IDS.undo)?.disabled).toBe(true);
    expectDisabledSpeaks(menu!.items);
  });

  it('DOM 读取：行身份从属性还原（账本 / 状态 / 文件数 / 可展开）', () => {
    document.body.innerHTML = `
      <table><tbody><tr data-oh-key="ops:op-9" data-oh-account="ops" data-oh-title="批操作「部署」"
        data-oh-time="2026-10-21 09:00:00" data-oh-path="" data-oh-action="undoOp"
        data-oh-action-label="撤销这一批" data-oh-status="committed" data-oh-file-count="7" data-oh-expandable="1">
        <td><span id="probe">批操作</span></td></tr></tbody></table>`;
    expect(readOpsHistoryRow(document.querySelector<HTMLElement>('#probe')!)).toMatchObject({
      key: 'ops:op-9',
      account: 'ops',
      status: 'committed',
      fileCount: 7,
      expandable: true,
      path: null,
      actionKind: 'undoOp',
    });
  });
});

/* ------------------------------ 差异视图（WP3.6） ------------------------------ */

describe('差异视图菜单', () => {
  it('编辑器已建：复制 / 上一处 / 下一处 / 切换布局 / 关闭', () => {
    const menu = buildDiffViewMenu(diffInput());
    expect(idsOf(menu!.items)).toEqual([
      DIFF_VIEW_MENU_IDS.copySummary,
      DIFF_VIEW_MENU_IDS.copyLeftPath,
      DIFF_VIEW_MENU_IDS.copyRightPath,
      DIFF_VIEW_MENU_IDS.prevDiff,
      DIFF_VIEW_MENU_IDS.nextDiff,
      DIFF_VIEW_MENU_IDS.toggleLayout,
      DIFF_VIEW_MENU_IDS.closePane,
    ]);
    expect(itemOf(menu!.items, DIFF_VIEW_MENU_IDS.toggleLayout)?.label).toBe('切换为上下内联视图');
    expectAllChinese(menu!.items);
  });

  it('只读面**没有**接受 / 拒绝：这两个 id 一个都不出现（不许新造写盘语义）', () => {
    for (const input of [diffInput(), diffInput({ editorReady: false }), diffInput({ bannerMessage: '两侧内容完全一致（无差异）。' })]) {
      const ids = idsOf(buildDiffViewMenu(input)!.items);
      expect(ids.some((id) => /accept|reject|apply/i.test(id)), ids.join(',')).toBe(false);
    }
  });

  it('没有画出差异 ⇒ 上一处 / 下一处 / 切换布局禁用且说清原因', () => {
    const menu = buildDiffViewMenu(diffInput({ editorReady: false }));
    for (const id of [DIFF_VIEW_MENU_IDS.prevDiff, DIFF_VIEW_MENU_IDS.nextDiff, DIFF_VIEW_MENU_IDS.toggleLayout]) {
      const item = itemOf(menu!.items, id)!;
      expect(item.disabled, id).toBe(true);
      expect(item.disabledReason, id).toContain('没有画出差异');
    }
    expectDisabledSpeaks(menu!.items);
  });

  it('内联时文案反过来；多开时关闭项写出还剩几组', () => {
    const menu = buildDiffViewMenu(diffInput({ sideBySide: false, paneCount: 3 }));
    expect(itemOf(menu!.items, DIFF_VIEW_MENU_IDS.toggleLayout)?.label).toBe('切换为左右并排视图');
    expect(itemOf(menu!.items, DIFF_VIEW_MENU_IDS.closePane)?.label).toContain('还剩 2 组');
  });

  it('内联文本侧没有路径 ⇒ 对应的「复制路径」整项不显示', () => {
    const menu = buildDiffViewMenu(diffInput({ leftPath: null }));
    const ids = idsOf(menu!.items);
    expect(ids).not.toContain(DIFF_VIEW_MENU_IDS.copyLeftPath);
    expect(ids).toContain(DIFF_VIEW_MENU_IDS.copyRightPath);
  });

  it('复制摘要文本：标题 + 左右标签与路径 + 判等横幅', () => {
    const text = diffSummaryText(diffInput({ bannerMessage: '两侧内容完全一致（无差异）。' }));
    expect(text).toContain('COMMON.ERB · 写前备份');
    expect(text).toContain('左：写前备份');
    expect(text).toContain('C:/appData/backup/COMMON.ERB.v1.bak');
    expect(text).toContain('右：磁盘当前内容');
    expect(text).toContain('判等：两侧内容完全一致（无差异）。');
  });

  it('没有剪贴板 ⇒ 复制项禁用且带原因', () => {
    const menu = buildDiffViewMenu(diffInput({ clipboardAvailable: false }));
    expect(itemOf(menu!.items, DIFF_VIEW_MENU_IDS.copySummary)?.disabled).toBe(true);
    expectDisabledSpeaks(menu!.items);
  });
});

/* ------------------------------ 跨面规约 ------------------------------ */

describe('跨面规约', () => {
  it('恢复 / 删除类项一律带危险色或独立分组（不靠颜色区分破坏性动作）', () => {
    const menus: readonly ContextMenuItem[][] = [
      buildFileHistoryMenu(
        fileInput({ row: fileRow({ account: 'trash', actionKind: 'restoreTrash', actionLabel: '放回原位' }) }),
      )!.items,
      buildOpsHistoryMenu(opsInput())!.items,
      buildOpsHistoryMenu(
        opsInput({
          row: opsRow({
            key: 'trash:t1',
            account: 'trash',
            actionKind: 'restoreTrash',
            actionLabel: '放回原位',
            status: null,
            expandable: false,
          }),
        }),
      )!.items,
    ];
    let seen = 0;
    for (const items of menus) {
      for (const item of items) {
        if (!RESTORE_LIKE_IDS.has(item.id)) continue;
        seen++;
        expect(
          item.danger === true || item.dividerBefore === true || item.group === '恢复' || item.group === '删除',
          item.id,
        ).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4); // 恢复 ×3 + 彻底删除 ×2 至少走到这几条
  });

  it('四个面的 label 全中文（含 CJK），禁用项必须带原因', () => {
    const menus: readonly ContextMenuItem[][] = [
      buildCallHierarchyMenu(callInput({ row: groupRow() }))!.items,
      buildCallHierarchyMenu(callInput({ row: groupRow(), clipboardAvailable: false }))!.items,
      buildFileHistoryMenu(fileInput())!.items,
      buildFileHistoryMenu(fileInput({ row: null }))!.items,
      buildOpsHistoryMenu(opsInput())!.items,
      buildOpsHistoryMenu(opsInput({ row: null }))!.items,
      buildDiffViewMenu(diffInput())!.items,
      buildDiffViewMenu(diffInput({ editorReady: false }))!.items,
    ];
    for (const items of menus) {
      expectAllChinese(items);
      expectDisabledSpeaks(items);
    }
  });

  it('菜单项 id 全局唯一（四面之间不许撞 id：分发全靠它）', () => {
    const menus: readonly ContextMenuItem[][] = [
      buildCallHierarchyMenu(callInput({ row: groupRow(), hidden: { in: 2, out: 2 } }))!.items,
      buildFileHistoryMenu(fileInput({ row: fileRow({ account: 'trash', actionKind: 'restoreTrash' }) }))!.items,
      buildOpsHistoryMenu(
        opsInput({
          row: opsRow({ key: 'trash:t1', account: 'trash', actionKind: 'restoreTrash', status: null }),
        }),
      )!.items,
      buildDiffViewMenu(diffInput())!.items,
    ];
    const all = menus.flat().map((item) => item.id);
    expect(new Set(all).size).toBe(all.length);
  });
});
