/**
 * MCP 会话授权：写前 diff 预览 + 一次批量审批（路 C）。
 *
 * 面板只产出 `ApprovalBatch`（交给 `mcp_approve` 命令写第四张表），**不碰任何落点**：
 * 越界根 / `market_*` 工具在纯函数里就地剔除，UI 不持有写盘权限。
 * 「回滚语义」说明：本面板复用 `TrashManager` / `OpsJournal` 的既有回滚语义是跨包接线，
 * 由主 agent 集成时决定（见交付报告偏差项）；此处不假装已接。
 *
 * 已批准状态可见化（additive，2026-11-06）：可选 `approvedTools` 注入第四张表里当前
 * 会话已批准的工具名，面板逐项挂「已批准」徽标 + 一行清单——批准 / 撤销后 UI 状态
 * 翻转可观测（铁律 4：批准落没落地不许靠猜）。未注入时零渲染，旧消费方形状不变。
 *
 * 逐工具可见性（additive，2026-11-06 Wave4）：每个待批准项 `<li>` 与「已批准」徽标带
 * `data-tool`（= 工具面名字），宿主 / 回归测试可据此**逐项**核对 `fileTree.remove` /
 * `fileTree.rename` 各自的勾选、批准落地与 denied 审计，不再只能靠全文包含猜。旧消费方
 * 查 `input[type=checkbox]` / `data-approved` / `.mcp-approve-badge` 的形状零变化。
 *
 * 审批面可读性（additive，2026-11-06 UI-17/15/16/07）：
 *   · 工具清单按族分组（`toolFamily`：文件树 / 启动器只读 / 启动器写 / 其他），每条给
 *     `TOOL_DESCRIPTIONS` 的真实功能一句话——分组只动 DOM 结构，`li[data-tool]` 的
 *     DOM 顺序与 `APPROVABLE_PRIVILEGED_TOOLS` 逐字同序（mcp-approval-ui 回归钉死）；
 *   · `clientId` 为空（尚无会话）时锁定审批区，只留引导文案，待批准清单 / 全选 / CTA
 *     一律不渲染（UI-15：未接入时看不到可批不动的东西）；
 *   · 「全选（N）」全局按钮与「批准所选（N）」收进粘性操作条 `.mcp-approve-sticky`
 *     （UI-16：29 行之后按钮不再被顶出视野；样式由 settings-ai.css 侧负责）；
 *   · `before` / `after` 都为空时不再渲染空 `<pre>`（UI-07：黑框换一行空态说明）。
 *
 * 屏面去黑话与按钮档位（additive，2026-11-06 UI-20/23）：
 *   · 条目屏面只留「工具名 — 真实功能一句话 + 只读/可写盘小字标」；`（privileged）` 档位
 *     括注与 `item.reason` 机制长句撤出屏面，收进条目 `title`（形状不变，reason 原值保留）；
 *   · 「已批准工具（第四张表）」改「已批准工具」，「写进授权记录」说明进 `title`；
 *   · 常驻可写根 hint 人话化，rootId / relPath / 双闸等技术细节进 `title`；
 *   · 粘性条里的「批准所选（N）」挂 `mcp-btn-primary` 主档（样式在 settings-ai.css）。
 */
import { useMemo, useState } from 'react';

import { KitCheck } from '../ui-kit/kit-check';
import { isRootIdShape } from './workspace-root-id';

export type McpTier = 'read' | 'edit' | 'privileged';

/**
 * 与 Rust `mcp/protocol.rs` 的危险工具判据镜像（双保险的展示侧）。
 *
 * **工具面名字 vs 命令名**：第四张表按 `tools/list` 里的工具名精确授权
 * （registry `tierAllowed` 只认 `tool.name`，Rust `approved_privileged_tool` 也只认
 * 精确同名），所以可批准项必须是工具面名字。`open_url_external` / `export_file` /
 * `rename_path` 是 Rust 命令名口径的同类危险动作（旧判据也在用），一并保留在分级里；
 * `fileTree.remove` / `fileTree.rename` 是当前工具面**真实存在**的两个 privileged 工具。
 */
export const PRIVILEGED_TOOL_PREFIXES: readonly string[] = ['launcher_', 'market_', 'remove_'];
export const PRIVILEGED_TOOL_NAMES: readonly string[] = [
  'open_url_external',
  'export_file',
  'rename_path',
  'fileTree.remove',
  'fileTree.rename',
];

/**
 * 审批面板列出的可批准项：只列工具面真实存在的 privileged 工具。
 * 漂移闸：`mcp-security.test.ts` 会拿 `@kojo/mcp-host` 的工具目录逐项比对，
 * 工具面新增/删除 privileged 工具而这里没跟上时测试直接红。
 *
 * B4 批（LaneS，2026-11-06）追加启动器族 27 枚具名工具（`launcher_*` 只读 13 + 生命周期/写 14）。
 * 三点纪律随这批一起钉住：
 * 1. **登记即须可批**：档位真源在 Rust `mcp/protocol.rs`（`is_launcher_tool()` 按 `launcher_`
 *    前缀判 privileged），而第四张表对 privileged 只认**精确名**——名字不进这张表就是
 *    「登记了也批不动」的静默失效（`fileTree.remove` / `fileTree.rename` 当年踩过同一坑）；
 * 2. **通配不构成批准**：`launcher_*` 这类前缀通配对 privileged 一律无效（端点与面板同源，
 *    判定语义零改动）；
 * 3. **不并入 edit 档**：这 27 枚绝不进 `EDIT_TOOLS_EXACT`，它们的门禁是危险档而非编辑档；
 *    宿主侧的第三张表复验（实例 × rootId 逐根授权）与确认闸 / 信任闸也不因本表存在而放松。
 */
export const APPROVABLE_PRIVILEGED_TOOLS: readonly string[] = [
  'fileTree.remove',
  'fileTree.rename',
  // ---- B4 批：启动器族只读面（13 枚，零副作用）----
  'launcher_instance_list',
  'launcher_instance_get',
  'launcher_content_list',
  'launcher_content_diagnose',
  'launcher_process_list',
  'launcher_process_status',
  'launcher_task_list',
  'launcher_save_list',
  'launcher_save_backups',
  'launcher_log_sessions',
  'launcher_log_tail',
  'launcher_log_read',
  'launcher_project_hash',
  // ---- B4 批：启动器族生命周期 / 写面（14 枚，宿主授权闸一律留在宿主）----
  'launcher_instance_update',
  'launcher_instance_duplicate',
  'launcher_instance_remove',
  'launcher_content_apply',
  'launcher_content_set_enabled',
  'launcher_content_set_order',
  'launcher_content_uninstall',
  'launcher_start',
  'launcher_stop',
  'launcher_task_cancel',
  'launcher_save_backup',
  'launcher_save_restore',
  'launcher_save_delete_backup',
  'launcher_save_apply_import',
];

/** 启动器族只读面 13 枚（与 `APPROVABLE_PRIVILEGED_TOOLS` 注释里的枚举表同源，供 `toolFamily` 分组）。 */
const LAUNCHER_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  'launcher_instance_list',
  'launcher_instance_get',
  'launcher_content_list',
  'launcher_content_diagnose',
  'launcher_process_list',
  'launcher_process_status',
  'launcher_task_list',
  'launcher_save_list',
  'launcher_save_backups',
  'launcher_log_sessions',
  'launcher_log_tail',
  'launcher_log_read',
  'launcher_project_hash',
]);

/** 工具族：文件树 / 启动器只读 / 启动器写 / 其他（命令面板动作等运行时候选落 other）。 */
export type ToolFamily = 'fileTree' | 'launcherRead' | 'launcherWrite' | 'other';

/** 按工具面名字归族：只认精确名与前缀，`launcher.` 点号形态（如 launcher.openInstances）不算启动器族。 */
export function toolFamily(name: string): ToolFamily {
  if (name.startsWith('fileTree.')) return 'fileTree';
  if (name.startsWith('launcher_')) {
    return LAUNCHER_READ_TOOLS.has(name) ? 'launcherRead' : 'launcherWrite';
  }
  return 'other';
}

/** 族显示名（组头用；数量另拼，不放进这张表）。 */
export const TOOL_FAMILY_LABELS: Readonly<Record<ToolFamily, string>> = {
  fileTree: '文件树',
  launcherRead: '启动器 · 只读',
  launcherWrite: '启动器 · 写入',
  other: '其他',
};

/**
 * 可批准工具的真实功能一句话（≤20 字，UI-17：扫一眼能判断这条工具会不会写盘）。
 * 描述逐条对着 `@kojo/mcp-host` 工具规格的 description 真源写，**禁止编造**；
 * 键集与 `APPROVABLE_PRIVILEGED_TOOLS` 一一对应（mcp-write-domain 判据钉住漂移）。
 */
export const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'fileTree.remove': '删除文件树中的文件或目录',
  'fileTree.rename': '重命名或移动文件树条目',
  launcher_instance_list: '列出已注册的启动器实例',
  launcher_instance_get: '查看单个实例的详细信息',
  launcher_content_list: '列出实例已安装的内容包',
  launcher_content_diagnose: '诊断内容包与磁盘的差异',
  launcher_process_list: '列出宿主监管的游戏进程',
  launcher_process_status: '查看单个实例的进程状态',
  launcher_task_list: '列出启动器任务中心的任务',
  launcher_save_list: '列出实例可见的存档文件',
  launcher_save_backups: '列出实例的存档备份',
  launcher_log_sessions: '列出实例的日志会话',
  launcher_log_tail: '读取最新日志会话的尾部',
  launcher_log_read: '按会话 id 读取日志内容',
  launcher_project_hash: '对插件源项目流式哈希',
  launcher_instance_update: '更新实例的描述性字段',
  launcher_instance_duplicate: '复制实例为新实例',
  launcher_instance_remove: '移除实例注册，可删文件',
  launcher_content_apply: '执行内容包安装计划',
  launcher_content_set_enabled: '启用或停用内容包',
  launcher_content_set_order: '设置内容包加载顺序',
  launcher_content_uninstall: '卸载一个内容包',
  launcher_start: '启动实例的游戏进程',
  launcher_stop: '停止实例的游戏进程',
  launcher_task_cancel: '请求取消一个启动器任务',
  launcher_save_backup: '备份实例的存档文件',
  launcher_save_restore: '从备份恢复存档文件',
  launcher_save_delete_backup: '删除一个存档备份',
  launcher_save_apply_import: '执行存档导入计划',
};

export function classifyToolTier(name: string): McpTier {
  if (
    PRIVILEGED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    PRIVILEGED_TOOL_NAMES.includes(name)
  ) {
    return 'privileged';
  }
  if (/^(write_|save_|apply_|update_|set_|create_|delete_|patch_)/.test(name)) return 'edit';
  return 'read';
}

/** 项目内相对路径判据（与 Rust `validate_relative_path` 镜像，UI 先挡一道）。 */
export function isSafeRelativePath(raw: string): boolean {
  if (!raw || raw.length > 512) return false;
  if (/[\x00-\x1f]/.test(raw)) return false;
  if (/^[/\\~]/.test(raw)) return false;
  if (raw.includes(':')) return false;
  for (const comp of raw.replace(/\\/g, '/').split('/')) {
    if (!comp || comp === '.' || comp === '..' || comp.endsWith('.') || comp.endsWith(' ')) {
      return false;
    }
  }
  return true;
}

export interface ApprovalItem {
  name: string;
  tier: McpTier;
  reason: string;
}

export interface ApprovalBatch {
  clientId: string;
  tier: McpTier;
  approvedRoots: string[];
  approvedTools: string[];
  /**
   * additive（写域多根）：人类逐项显式批准的常驻可写根**枚举标识**。
   * 只在非空时出现 ⇒ 旧批次形状（四个键）一字不变，默认拒绝面零变化。
   */
  approvedRootIds?: string[];
}

/** 候选常驻根：id 是稳定枚举标识，label 是给用户看的绝对路径（只展示，绝不作为落点入参）。 */
export interface ApprovalRootCandidate {
  readonly id: string;
  readonly label: string;
}

/** 一次批量审批：`market_*` 保持 fail-closed；越界根与畸形工具名一律剔除。 */
export function buildApprovalBatch(
  clientId: string,
  tier: McpTier,
  items: readonly ApprovalItem[],
  roots: readonly string[],
  rootIds: readonly string[] = [],
): ApprovalBatch {
  const approvedTools = items
    .map((item) => item.name)
    .filter((name) => !name.startsWith('market_'))
    .filter((name) => name.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(name));
  // rootId 只认 `ws:` + 8 位小写十六进制；畸形 / 绝对路径一律剔除（形状闸与 Rust 端点同尺），
  // 去重后为空就不写进批次 ⇒ 旧消费方拿到的形状一字不变。
  const approvedRootIds = [...new Set(rootIds)].filter(isRootIdShape);
  return {
    clientId,
    tier,
    approvedRoots: roots.filter(isSafeRelativePath),
    approvedTools,
    ...(approvedRootIds.length > 0 ? { approvedRootIds } : {}),
  };
}

/** 参数摘要：不落全文、去控制字符、限长（提示注入 defense）。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args).slice(0, 32)) {
    const safeKey = key.replace(/[\x00-\x1f]/g, '_').slice(0, 64);
    if (typeof value === 'string') parts.push(`${safeKey}:str(${value.length})`);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      parts.push(`${safeKey}:${typeof value}`);
    } else parts.push(`${safeKey}:complex`);
  }
  return parts.join(',').slice(0, 1024);
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

/** 写前 diff 预览（按行位对比，不执行写、不产生落点）。 */
export function renderDiff(before: string, after: string, maxLines = 200): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const lines: DiffLine[] = [];
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count && lines.length < maxLines; i += 1) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x === y) lines.push({ kind: 'context', text: x });
    else {
      if (i < a.length) lines.push({ kind: 'remove', text: x });
      if (i < b.length) lines.push({ kind: 'add', text: y });
    }
  }
  return lines;
}

export interface ApprovalUiProps {
  clientId: string;
  pending: readonly ApprovalItem[];
  roots: readonly string[];
  before: string;
  after: string;
  onApprove: (batch: ApprovalBatch) => void;
  /**
   * 第四张表里当前会话已批准的工具名（additive）：给了就渲染「已批准」徽标与清单行，
   * 批准 / 撤销后随 scope 刷新翻转；不给（undefined）则完全不渲染，旧形状零变化。
   */
  readonly approvedTools?: readonly string[];
  /** 候选常驻可写根（additive）：不传 / 空 ⇒ 整块零渲染，旧消费方形状一字不变。 */
  readonly candidateRootIds?: readonly ApprovalRootCandidate[];
  /** 第四张表里已批准的 rootId（additive）：逐项挂徽标，批准 / 撤销后可见翻转。 */
  readonly approvedRootIds?: readonly string[];
  /** 只读枚举失败的原因（additive，铁律 4：不静默）：给了才渲染一行显式提示。 */
  readonly rootEnumerationNote?: string;
}

export function ApprovalUi({
  clientId,
  pending,
  roots,
  before,
  after,
  onApprove,
  approvedTools,
  candidateRootIds,
  approvedRootIds,
  rootEnumerationNote,
}: ApprovalUiProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  const [selectedRootIds, setSelectedRootIds] = useState<ReadonlySet<string>>(new Set<string>());
  const diff = useMemo(() => renderDiff(before, after), [before, after]);
  const approvedSet = useMemo(() => new Set(approvedTools ?? []), [approvedTools]);
  const approvedRootSet = useMemo(() => new Set(approvedRootIds ?? []), [approvedRootIds]);
  const rootCandidates = useMemo(
    () => (candidateRootIds ?? []).filter((c) => isRootIdShape(c.id)),
    [candidateRootIds],
  );
  // UI-17 分组：按 pending 出现顺序归族（静态名单 ⇒ fileTree → launcherRead → launcherWrite，
  // 与 APPROVABLE_PRIVILEGED_TOOLS 逐字同序；组内保持 pending 顺序）。
  const groups = useMemo(() => {
    const order: ToolFamily[] = [];
    const byFamily = new Map<ToolFamily, ApprovalItem[]>();
    for (const item of pending) {
      const family = toolFamily(item.name);
      let bucket = byFamily.get(family);
      if (bucket === undefined) {
        bucket = [];
        byFamily.set(family, bucket);
        order.push(family);
      }
      bucket.push(item);
    }
    return order.map((family) => ({ family, items: byFamily.get(family)! }));
  }, [pending]);
  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(name);
    else next.delete(name);
    setSelected(next);
  };
  const toggleRoot = (id: string, checked: boolean) => {
    const next = new Set(selectedRootIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelectedRootIds(next);
  };
  const selectGroup = (items: readonly ApprovalItem[]) => {
    const next = new Set(selected);
    for (const item of items) next.add(item.name);
    setSelected(next);
  };
  const clearGroup = (items: readonly ApprovalItem[]) => {
    const next = new Set(selected);
    for (const item of items) next.delete(item.name);
    setSelected(next);
  };
  const chosen = pending.filter((item) => selected.has(item.name));
  // 「一次批量审批」的档位刻意固定为 edit：privileged 工具靠 approvedTools **精确列名**
  // 放行（WebView tierAllowed 与 Rust check_tool_call_permission 同口径），不靠抬高会话
  // tier。抬档会让同 tier 的其它特权工具顺带可见，等于给危险面开后门。
  // 常驻根同理：只写 approvedRootIds 精确列名，不放宽任何默认写域。
  const batch = buildApprovalBatch(clientId, 'edit', chosen, roots, [...selectedRootIds]);
  const selectionCount = chosen.length + selectedRootIds.size;
  const selectAll = () => setSelected(new Set(pending.map((item) => item.name)));
  const clearAll = () => setSelected(new Set<string>());
  // UI-15：还没有会话（clientId 为空）时审批区整体锁定——清单 / 全选 / CTA 都批不动，
  // 渲染出来只会教用户点一个无效按钮。引导一行说清「接入之后这里会有什么」。
  const locked = clientId === '';
  const diffEmpty = before === '' && after === '';
  return (
    <section aria-label="MCP 会话授权">
      <h3>写前 diff 预览</h3>
      {diffEmpty ? (
        <p className="mcp-diff-empty">
          当前没有挂起的写请求；Agent 发起写操作时会在这里先给出 diff。
        </p>
      ) : (
        <pre data-testid="mcp-diff">
          {diff.map((line, i) => (
            <div key={i} data-kind={line.kind}>
              {line.kind === 'context' ? '  ' : line.kind === 'add' ? '+ ' : '- '}
              {line.text}
            </div>
          ))}
        </pre>
      )}
      <h3>一次批量审批</h3>
      {locked ? (
        <div className="mcp-approve-locked">
          <p className="mcp-approve-locked-hint">
            完成接入并出现会话后，这里会出现逐项批准清单。
          </p>
          {rootEnumerationNote !== undefined && (
            <p className="mcp-approve-roots-note" aria-live="polite" data-testid="mcp-root-enumeration-note">
              {rootEnumerationNote}
            </p>
          )}
        </div>
      ) : (
        <>
          {groups.map((group) => {
            const write = group.family !== 'launcherRead';
            return (
              <section key={group.family} className="mcp-tool-group" data-family={group.family}>
                <div className="mcp-tool-group-head">
                  <h4>
                    {TOOL_FAMILY_LABELS[group.family]}（{group.items.length}）
                  </h4>
                  <div className="mcp-tool-group-actions">
                    {/* 组级勾选只是本族内的一次批量勾选动作：仍逐项精确列名写 approvedTools，
                        不放宽任何默认权限、不抬会话 tier。措辞刻意避开「全选」字样——
                        全局「全选」按钮是回归判据的锚（首个含「全选」的按钮必须全量勾选）。 */}
                    <button type="button" onClick={() => selectGroup(group.items)}>
                      勾选本组
                    </button>
                    <button
                      type="button"
                      disabled={group.items.every((item) => !selected.has(item.name))}
                      onClick={() => clearGroup(group.items)}
                    >
                      清空本组
                    </button>
                  </div>
                </div>
                <ul>
                  {group.items.map((item) => {
                    // UI-20：屏面只留「名字 — 一句话功能」；档位（privileged 等）与
                    // reason 机制长句收进条目 title（形状不变：reason 原值保留在数据里）。
                    const description = TOOL_DESCRIPTIONS[item.name];
                    return (
                      <li
                        key={item.name}
                        data-tool={item.name}
                        title={[item.tier, item.reason].filter(Boolean).join(' · ')}
                      >
                        <KitCheck
                          checked={selected.has(item.name)}
                          onChange={(checked) => toggle(item.name, checked)}
                          label={`批准 ${item.name}`}
                        >
                          {description !== undefined ? `${item.name} — ${description}` : item.name}
                        </KitCheck>
                        {/* 只读/可写盘小字标：launcher 只读族标「只读」，其余一律按
                            可写盘标（fail-closed：判不准写不写时按会写报）。 */}
                        <span className="mcp-tool-tag" data-write={write ? 'true' : undefined}>
                          {write ? '可写盘' : '只读'}
                        </span>
                        {approvedTools !== undefined && approvedSet.has(item.name) && (
                          <span className="mcp-approve-badge" data-approved="true" data-tool={item.name}>
                            已批准
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {/* 常驻可写根（additive，写域多根）：整块放在工具清单**之后**，保证旧消费方
              「第一个 checkbox = 工具项」的形状不变；候选为空 / 未注入 ⇒ 零渲染。 */}
          {(rootCandidates.length > 0 || rootEnumerationNote !== undefined) && (
            <section className="mcp-approve-roots" aria-label="MCP 常驻可写根批准">
              <h4>常驻可写根（逐项显式批准）</h4>
              {/* UI-20：屏面一句话，rootId 形状闸 / 相对前缀 / 内核允许域等机制进 title。 */}
              <p
                className="mcp-approve-roots-hint"
                title="这里的标识（rootId）经形状闸后写入授权记录的 approvedRootIds 精确列名；实际落盘仍要过 approvedRoots 相对前缀与内核写允许域两道闸。"
              >
                勾选后 Agent 才能写入该根；这里的标识是稳定代号、不是路径。实际落盘仍要过多重权限闸。
              </p>
              {rootEnumerationNote !== undefined && (
                <p className="mcp-approve-roots-note" aria-live="polite" data-testid="mcp-root-enumeration-note">
                  {rootEnumerationNote}
                </p>
              )}
              <ul>
                {rootCandidates.map((c) => (
                  <li key={c.id} data-root-id={c.id}>
                    <KitCheck
                      checked={selectedRootIds.has(c.id)}
                      onChange={(checked) => toggleRoot(c.id, checked)}
                      label={`批准常驻根 ${c.label}`}
                    >
                      <code>{c.id}</code> — {c.label}
                    </KitCheck>
                    {approvedRootIds !== undefined && approvedRootSet.has(c.id) && (
                      <span className="mcp-approve-badge" data-root-approved="true" data-root-id={c.id}>
                        已批准
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p>待批准根：{batch.approvedRoots.join(', ') || '（无）'}</p>
          {approvedTools !== undefined && (
            <p
              data-testid="mcp-approved-tools"
              title="已批准的工具名写进本会话的授权记录；撤销会话后随之移除。"
            >
              已批准工具：{approvedTools.length > 0 ? approvedTools.join('、') : '（无）'}
            </p>
          )}
          {/* UI-16 粘性操作条：全选 / 清空与批准 CTA 收进一条，置底跟随滚动（样式在
              settings-ai.css 的 .mcp-approve-sticky，结构先占位）。 */}
          <div className="mcp-approve-sticky">
            {/* 全选只是一次勾选动作：逐项精确列名写进 approvedTools，不放宽任何默认权限、
                不抬高会话 tier、不新增隐式授权。几十条命令面板动作因此具备可操作性。 */}
            <div className="mcp-approve-actions">
              <button type="button" disabled={pending.length === 0} onClick={selectAll}>
                全选（{pending.length}）
              </button>
              <button type="button" disabled={selected.size === 0} onClick={clearAll}>
                清空
              </button>
            </div>
            {/* UI-23：主操作挂主档按钮（实底 accent），与「全选 / 清空」次档拉开层级。 */}
            <button
              type="button"
              className="mcp-btn-primary"
              disabled={selectionCount === 0}
              onClick={() => onApprove(batch)}
            >
              批准所选（{selectionCount}）
            </button>
          </div>
        </>
      )}
    </section>
  );
}
