/**
 * 注入面板纯逻辑（零 React，可单测）：
 * - 深解析结果 → 变量目录（作用域内可浏览 / 可编辑的变量行）；
 * - 待注入编辑 → ArchiveOverrides 构建（与 serializePayload 的覆盖模型同构）；
 * - 待注入编辑 → diff 行（改前 / 改后呈现）。
 *
 * 游戏知识边界：变量语义标签（可选）由当前 game adapter 的 variableSchema
 * 经槽位查询透传（调用方传入 lookup 函数），本模块不解释任何游戏常量。
 */

import type {
  ArchiveArrayVariable,
  ArchiveCellPatch,
  ArchiveCharacterBlock,
  ArchiveOverrides,
  ArchiveVariable,
  SnapshotArchive,
  VariableSchema,
} from '@kojo/plugin-api';

// ---------------------------------------------------------------------------
// 面板阶段与语义标签
// ---------------------------------------------------------------------------

/** 注入面板主区显示的阶段（顺序即优先级） */
export type PanelPhase = 'no-slots' | 'no-selection' | 'loading' | 'error' | 'ready';

export interface PanelPhaseInput {
  /** 有项目且扫描到至少一个可解析档位 */
  hasSlots: boolean;
  /** 当前选中的档位路径；未选 = null */
  path: string | null;
  loading: boolean;
  loadError: string | null;
  /** 是否已有解析结果 */
  hasArchive: boolean;
}

/**
 * 由面板状态判定应渲染的阶段。
 * 「未选档位」是中性等待态而非错误——必须落在 'no-selection'，永远不能因缺解析结果误判为 'error'。
 */
export function panelPhase(s: PanelPhaseInput): PanelPhase {
  if (!s.hasSlots) return 'no-slots';
  if (s.path === null) return 'no-selection';
  if (s.loading) return 'loading';
  if (s.loadError !== null || !s.hasArchive) return 'error';
  return 'ready';
}

/** 变量语义标签（家族/标量级）；无 schema 或无描述 → null */
export function varLabel(schema: VariableSchema | undefined, key: string): string | null {
  const d = schema?.lookup(key)?.description;
  return typeof d === 'string' && d.length > 0 ? d : null;
}

/**
 * 数组单元语义标签；一维下标按数字查（与 VariableSchema.lookup 签名一致），
 * 多维下标 join(',') 成键。index 缺省或为空 → null。
 */
export function cellLabel(
  schema: VariableSchema | undefined,
  key: string,
  index: readonly number[] | undefined,
): string | null {
  if (!schema || !index || index.length === 0) return null;
  const d = schema.lookup(key, index.length === 1 ? index[0] : index.join(','))?.description;
  return typeof d === 'string' && d.length > 0 ? d : null;
}

// ---------------------------------------------------------------------------
// 作用域与变量目录
// ---------------------------------------------------------------------------

/** 覆盖作用域：顶层/主变量区、EM 扩展区、某个角色块（index = ArchiveCharacterBlock.index） */
export type ScopeKind =
  | { kind: 'top' }
  | { kind: 'em' }
  | { kind: 'char'; blockIndex: number };

/** 作用域内单个变量的目录行 */
export interface VarRow {
  key: string;
  type: ArchiveVariable['type'];
  /** scalar = 标量（可整体替换）/ array = 数组（可单元补丁）/ other = 不支持注入 */
  kind: 'scalar' | 'array' | 'other';
  /** 一行摘要（标量值 / 非空单元数） */
  preview: string;
  /** scalar 时：当前值 */
  scalarValue?: number | string;
  /** array 时：非空单元（编辑器数据源；可能被 maxCells 截断的档不可注入） */
  cells?: ReadonlyArray<{ index: number[]; value: number | string }>;
  /** array 时：声明维度长度（新单元下标校验用） */
  saveLen?: number[];
  /** array 时：cells 不完整（引擎会拒绝该变量注入；目录行显式标记） */
  cellsTruncated?: boolean;
}

/** 角色块显示名（CALLNAME → NAME → 兜底「角色 #i」；零游戏知识——只读通用变量名） */
export function charaLabel(block: ArchiveCharacterBlock): string {
  const pick = (key: string): string | null => {
    for (const v of block.vars) {
      if (v.key === key && v.type === 'str') return String((v as { value: unknown }).value);
    }
    return null;
  };
  const name = pick('CALLNAME') ?? pick('NAME');
  return name && name.length > 0 ? `#${block.index} ${name}` : `角色 #${block.index}`;
}

function toRow(v: ArchiveVariable): VarRow {
  if (v.type === 'int' || v.type === 'str' || v.type === 'xml') {
    const value = (v as { value: number | string }).value;
    return { key: v.key, type: v.type, kind: 'scalar', preview: previewScalar(value), scalarValue: value };
  }
  if (v.type === 'map' || v.type === 'datatable') {
    return { key: v.key, type: v.type, kind: 'other', preview: `${(v as { count?: number }).count ?? ''}（不支持注入）` };
  }
  const arr = v as ArchiveArrayVariable;
  return {
    key: arr.key,
    type: arr.type,
    kind: 'array',
    preview: `${arr.nonEmpty} 个非空单元 / ${arr.saveLen.join('×')}`,
    cells: arr.cells.map((c) => ({ index: [...c.index], value: c.value })),
    saveLen: [...arr.saveLen],
    cellsTruncated: arr.cellsTruncated === true,
  };
}

function previewScalar(value: number | string): string {
  const s = String(value);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** 列出作用域内的变量目录（流序；与 serializePayload 的覆盖作用域同构） */
export function listVars(archive: SnapshotArchive, scope: ScopeKind): VarRow[] {
  if (scope.kind === 'char') {
    const block = (archive.chars ?? []).find((b) => b.index === scope.blockIndex);
    return block ? block.vars.map(toRow) : [];
  }
  const vars = scope.kind === 'em' ? archive.emVars : archive.vars ?? archive.globalVars;
  return (vars ?? []).map(toRow);
}

/** 作用域标签（下拉项） */
export function scopeLabel(archive: SnapshotArchive, scope: ScopeKind): string {
  if (scope.kind === 'top') {
    return archive.fileType === 'global' ? '全局变量区' : '主变量区';
  }
  if (scope.kind === 'em') return 'EM 扩展区';
  const block = (archive.chars ?? []).find((b) => b.index === scope.blockIndex);
  return block ? charaLabel(block) : `角色 #${scope.blockIndex}`;
}

/** 作用域清单（按档类型生成；下拉数据源） */
export function listScopes(archive: SnapshotArchive): ScopeKind[] {
  const out: ScopeKind[] = [];
  if (archive.fileType === 'normal' || archive.fileType === 'charvar') {
    for (const b of archive.chars ?? []) out.push({ kind: 'char', blockIndex: b.index });
  }
  if (archive.fileType === 'global') out.push({ kind: 'top' });
  else out.push({ kind: 'top' });
  if (archive.fileType === 'normal' || archive.fileType === 'global') out.push({ kind: 'em' });
  return out;
}

// ---------------------------------------------------------------------------
// 待注入编辑 → ArchiveOverrides / diff
// ---------------------------------------------------------------------------

/** 单条待注入编辑 */
export interface PendingEdit {
  scope: ScopeKind;
  key: string;
  /** scalar = 标量整体替换 / cell = 数组单元补丁 */
  kind: 'scalar' | 'cell';
  /** cell 时的全维度下标 */
  index?: number[];
  /** 改前值（新增单元为 null） */
  oldValue: number | string | null;
  /** 改后值 */
  newValue: number | string;
}

/** 标量 int 的域校验（Int64 守卫的面板侧前置；引擎 serializePayload 仍有最终守卫） */
export function parseScalarInput(type: 'int' | 'str' | 'xml', raw: string): { ok: true; value: number | string } | { ok: false; error: string } {
  if (type === 'int') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n)) return { ok: false, error: '整数变量需要整数（含负号）' };
    if (!Number.isSafeInteger(n)) return { ok: false, error: `数值 ${raw} 超出安全整数域（Int64 守卫拒绝注入）` };
    return { ok: true, value: n };
  }
  return { ok: true, value: raw };
}

/** 数组单元值输入解析（依数组元素类型 int/str） */
export function parseCellInput(isIntArray: boolean, raw: string): { ok: true; value: number | string } | { ok: false; error: string } {
  if (isIntArray) return parseScalarInput('int', raw);
  return { ok: true, value: raw };
}

/** 新单元下标解析（逗号分隔全维度；逐维校验为非负整数且落在 saveLen 内） */
export function parseCellIndex(saveLen: readonly number[], raw: string): { ok: true; index: number[] } | { ok: false; error: string } {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== saveLen.length) {
    return { ok: false, error: `下标需 ${saveLen.length} 维（${saveLen.map((n) => `0..${n - 1}`).join('，')}）` };
  }
  const index: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n >= (saveLen[i] ?? 0)) {
      return { ok: false, error: `第 ${i + 1} 维下标须为 0..${(saveLen[i] ?? 0) - 1} 的整数` };
    }
    index.push(n);
  }
  return { ok: true, index };
}

function scopeMapKey(scope: ScopeKind): string {
  return scope.kind === 'char' ? `char:${scope.blockIndex}` : scope.kind;
}

/**
 * 待注入编辑 → ArchiveOverrides（未列出的变量一律 passthrough；
 * 同 key 同下标重复编辑后写覆盖先写——last-write-wins，符合"清单顺序即意图"）。
 */
export function buildOverrides(pending: readonly PendingEdit[]): ArchiveOverrides {
  const vars = new Map<string, number | string | readonly ArchiveCellPatch[]>();
  const chars = new Map<number, Map<string, number | string | readonly ArchiveCellPatch[]>>();
  for (const e of pending) {
    if (e.scope.kind === 'char') {
      let m = chars.get(e.scope.blockIndex);
      if (!m) {
        m = new Map();
        chars.set(e.scope.blockIndex, m);
      }
      applyEdit(m, e);
    } else {
      applyEdit(vars, e);
    }
  }
  const out: ArchiveOverrides = {};
  if (vars.size > 0) out.vars = vars;
  if (chars.size > 0) out.chars = chars;
  return out;
}

function applyEdit(m: Map<string, number | string | readonly ArchiveCellPatch[]>, e: PendingEdit): void {
  if (e.kind === 'scalar') {
    m.set(e.key, e.newValue);
    return;
  }
  const patch: ArchiveCellPatch = { index: [...(e.index ?? [])], value: e.newValue };
  const prev = m.get(e.key);
  const prevPatches = Array.isArray(prev) ? (prev as readonly ArchiveCellPatch[]) : [];
  m.set(e.key, [...prevPatches, patch]);
}

/** 位置描述（diff 行与成功提示共用） */
export function editWhere(scope: ScopeKind): string {
  return scope.kind === 'char' ? `chars[${scope.blockIndex}]` : scope.kind === 'em' ? 'emVars' : 'vars';
}

export interface DiffRow {
  where: string;
  key: string;
  /** cell 时：下标串 */
  cell: string | null;
  before: string;
  after: string;
  isNew: boolean;
}

/** 待注入清单 → diff 行（改前 / 改后） */
export function diffRows(pending: readonly PendingEdit[]): DiffRow[] {
  return pending.map((e) => ({
    where: editWhere(e.scope),
    key: e.key,
    cell: e.kind === 'cell' ? (e.index ?? []).join(',') : null,
    before: e.oldValue === null ? '（新增）' : String(e.oldValue),
    after: String(e.newValue),
    isNew: e.oldValue === null,
  }));
}

/** 去重键（清单内防重复；同一目标后写覆盖先写） */
export function editKey(e: PendingEdit): string {
  return `${scopeMapKey(e.scope)}|${e.key}|${e.kind === 'cell' ? (e.index ?? []).join(',') : ''}`;
}

/** 清单去重（last-write-wins：保留每个目标最后一次编辑） */
export function dedupePending(pending: readonly PendingEdit[]): PendingEdit[] {
  const byKey = new Map<string, PendingEdit>();
  for (const e of pending) byKey.set(editKey(e), e);
  return [...byKey.values()];
}

/** 编辑冲突：既有清单里同目标编辑会被新编辑取代（返回被取代的条数；UI 提示用） */
export function supersededCount(pending: readonly PendingEdit[], incoming: PendingEdit): number {
  const key = editKey(incoming);
  return pending.filter((e) => editKey(e) === key).length;
}
