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
  ArchiveArrayCell,
  ArchiveArrayVariable,
  ArchiveCellPatch,
  ArchiveCharacterBlock,
  ArchiveOverrides,
  ArchiveVariable,
  QuickEditField,
  RenderWindow,
  SnapshotArchive,
  SnapshotInjectionResult,
  VariableSchema,
} from '@kojo/plugin-api';
import { nextWindow, windowSize } from '@kojo/plugin-api';

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

/**
 * 「没有可选档位」的**真实成因**（'no-slots' 阶段的细分）。
 *
 * 为什么细分：旧文案只有一句「打开项目并扫描到存档后可用（存档列表来自「归档浏览器」面板）」，
 * 而真实成因至少五种，动作完全不同（开项目 / 配存档目录 / 等扫描 / 换目录 / 看解析错误）。
 * 更糟的是它把用户指向**已封存**的「归档浏览器」面板——照做只会更困惑。
 * 判据顺序即优先级：没有项目 ⇒ 谈不上扫描；扫描在飞 ⇒ 说「正在扫描」而不是「没有」。
 */
export type EmptySlotsReason = 'no-project' | 'no-dir' | 'scanning' | 'no-archives' | 'all-unreadable';

export interface EmptySlotsInput {
  /** 是否有打开的项目 */
  hasProject: boolean;
  /** 最近一次扫描的目录；从未扫描过 = null（项目无存档目录时为空串） */
  scanDir: string | null;
  /** 扫描条目总数（含浅解析失败的） */
  total: number;
  /** 可解析条目数（meta 非空且无 error） */
  valid: number;
  /** 扫描是否在飞（面板自愈 / 用户点「重新扫描」） */
  scanning: boolean;
}

export function emptySlotsReason(s: EmptySlotsInput): EmptySlotsReason {
  if (!s.hasProject) return 'no-project';
  if (s.scanning) return 'scanning';
  // 还没扫过（面板刚挂载，自愈 scan 在飞）：报「正在扫描」而不是「没有存档」
  if (s.scanDir === null) return 'scanning';
  if (s.scanDir === '') return 'no-dir';
  if (s.total === 0) return 'no-archives';
  if (s.valid === 0) return 'all-unreadable';
  return 'no-archives';
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
  /**
   * array 时：非空单元（编辑器数据源；可能被 maxCells 截断的档不可注入）。
   *
   * **引用深解析结果、不是拷贝**（PS-7）：这一列只被读（渲染、按下标找旧值），
   * 而写侧要的补丁数组在 `applyEdit` 里另建。老实现每行 `cells.map(c => ({index:[...c.index]}))`
   * 是把「几千个单元 × 每次渲染」的拷贝算在交互路径上——一个 `CHARA:40:100` 就是 4,000 次数组展开。
   */
  cells?: readonly ArchiveArrayCell[];
  /** array 时：声明维度长度（新单元下标校验用；同为引用，零拷贝） */
  saveLen?: readonly number[];
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
    // 引用而非拷贝：目录行与单元编辑器都只读这两列（写侧补丁在 applyEdit 另建数组）
    cells: arr.cells,
    saveLen: arr.saveLen,
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

/** 作用域下拉的一项（`value` = `<option>` 的值，`label` = 作者看到的那句） */
export interface ScopeOption {
  value: string;
  label: string;
}

/**
 * 作用域下拉的数据：**一趟线性扫描**出全部选项与标签（PS-7）。
 *
 * 旧实现在每次渲染里对每个选项调**两次** `scopeLabel`，每次调用都
 * `archive.chars.find(...)` 再让 `charaLabel` 扫一遍该块的变量表
 * ⇒ 每帧 O(块数² × 每块变量数)（角色多的档一次渲染几万次变量名比较，逐键打字都陪着）。
 * `value` 与顺序与 `listScopes` + 面板那条拼接**逐字同构**（判据不另立一套）。
 */
export function scopeOptions(archive: SnapshotArchive): ScopeOption[] {
  const out: ScopeOption[] = [];
  if (archive.fileType === 'normal' || archive.fileType === 'charvar') {
    for (const b of archive.chars ?? []) out.push({ value: `char:${b.index}`, label: charaLabel(b) });
  }
  out.push({ value: 'top', label: archive.fileType === 'global' ? '全局变量区' : '主变量区' });
  if (archive.fileType === 'normal' || archive.fileType === 'global') {
    out.push({ value: 'em', label: 'EM 扩展区' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 变量目录过滤（中文名可搜）
// ---------------------------------------------------------------------------

/**
 * 变量目录过滤：变量名（`CFLAG`）**与中文标签**（「角色标志」）都参与匹配。
 *
 * 为什么必须带标签：旧过滤只对 `key` 做子串匹配——零基础作者搜「好感」，搜的是
 * 适配器词典里的中文名（`CFLAG:2 好感度`），可 `CFLAG` 这个键名里根本没有这个词，
 * 搜出来永远是空。本函数大小写不敏感；needle 为空白 ⇒ 原样返回**同一引用**（不触发重渲）。
 */
export function filterVarRows(
  rows: readonly VarRow[],
  rawNeedle: string,
  schema: VariableSchema | undefined,
): readonly VarRow[] {
  const needle = rawNeedle.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((r) => {
    if (r.key.toLowerCase().includes(needle)) return true;
    const label = varLabel(schema, r.key);
    return label !== null && label.toLowerCase().includes(needle);
  });
}

// ---------------------------------------------------------------------------
// 「常用状态」快捷编辑（GameAdapter.quickEditFields 的投影；零 React 可单测）
// ---------------------------------------------------------------------------

/** 「常用」卡的一行：策展项 + 当下这份存档里的当前值 */
export interface QuickEditRow {
  /** 策展项原样（提交 PendingEdit 时按它换算族 / 下标 / 作用域） */
  readonly field: QuickEditField;
  /** 显示名：词典命中（variableSchema.lookup(family, index).description）优先，否则策展 label */
  readonly label: string;
  /** 当前值（数组缺格按 0 计——int 数组空槽的引擎语义就是 0） */
  readonly current: number | string;
  /** 值域是否整数（输入校验与提示文案的判据；来自该变量的元素类型） */
  readonly intLike: boolean;
  /** 落点形态：标量整体替换 / 数组单元补丁（提交 PendingEdit 时用） */
  readonly target: 'scalar' | 'cell';
}

/**
 * 把策展项解析成「常用」卡的行（纯函数；面板按当前作用域调）。
 *
 * 取舍口径：
 * - **作用域路由**：`scope: 'chara'` 的项只在角色块作用域出现，`'global'` 的只在
 *   主 / 全局变量区出现——钱不在角色身上，好感不在全局区里；
 * - **族不在档内 ⇒ 整行隐藏**：策展项对应的变量族在这份存档里压根没有（别的游戏
 *   的档 / 精简魔改盘）时，显示一个永远写不进去的输入框是纯误导；
 * - **cells 截断 ⇒ 隐藏**：截断数组的补丁会被引擎拒绝（既有口径），卡上留一行
 *   「改了也白改」更糟；
 * - **缺格 = 0**：int 数组里没出现的单元语义就是 0，显示 0 而不是「未知」；
 * - map / datatable 等不可注入形态 ⇒ 隐藏（与目录行 `kind: 'other'` 同判）。
 */
export function quickEditRows(
  fields: readonly QuickEditField[],
  archive: SnapshotArchive,
  scope: ScopeKind,
  schema: VariableSchema | undefined,
): QuickEditRow[] {
  const vars = new Map(listVars(archive, scope).map((r) => [r.key, r]));
  // 作用域路由：角色项只进角色块、全局项只进主变量区；EM 扩展区没有策展项（写进
  // emVars 的「金钱」不是金钱——宁可不显示这张卡，也不给一个写错地方的输入框）。
  const wantScope = scope.kind === 'char' ? 'chara' : scope.kind === 'top' ? 'global' : null;
  if (wantScope === null) return [];
  const out: QuickEditRow[] = [];
  for (const field of fields) {
    if ((field.scope ?? 'chara') !== wantScope) continue;
    const row = vars.get(field.family);
    if (row === undefined) continue; // 族不在档内：隐藏，不猜
    let current: number | string;
    let intLike: boolean;
    if (row.kind === 'array') {
      if (row.cellsTruncated) continue; // 截断数组不可注入（既有口径）：隐藏
      intLike = row.type.startsWith('int-array');
      const cell = (row.cells ?? []).find((c) => c.index.length === 1 && c.index[0] === field.index);
      if (cell !== undefined) current = cell.value;
      else current = intLike ? 0 : ''; // int 数组缺格语义 = 0；str 数组缺格 = 空串
    } else if (row.kind === 'scalar') {
      intLike = row.type === 'int';
      current = row.scalarValue ?? (intLike ? 0 : '');
    } else {
      continue; // map / datatable 不可注入
    }
    const dictLabel = cellLabel(schema, field.family, [field.index]);
    out.push({
      field,
      label: dictLabel ?? field.label,
      current,
      intLike,
      target: row.kind === 'scalar' ? 'scalar' : 'cell',
    });
  }
  return out;
}

/**
 * 「常用」卡提交：草稿解析（int 校验同标量口径）→ 待注入编辑。
 *
 * 作用域按**策展项的路由**落（不随面板当前下拉漂）：角色项 → 当前角色块
 * （卡只在角色作用域渲染角色项，此处 `scope` 必为 char 形），全局项 → 主变量区。
 * 解析失败回 `{ ok: false, error }`（与标量 / 单元录入同一套文案）。
 */
export function quickEditToPending(
  row: QuickEditRow,
  scope: ScopeKind,
  raw: string,
): { ok: true; edit: PendingEdit } | { ok: false; error: string } {
  const parsed = parseScalarInput(row.intLike ? 'int' : 'str', raw);
  if (!parsed.ok) return parsed;
  const charaField = (row.field.scope ?? 'chara') === 'chara';
  const target: ScopeKind = charaField
    ? { kind: 'char', blockIndex: scope.kind === 'char' ? scope.blockIndex : 0 }
    : { kind: 'top' };
  return {
    ok: true,
    edit: {
      scope: target,
      key: row.field.family,
      kind: row.target === 'scalar' ? 'scalar' : 'cell',
      ...(row.target === 'cell' ? { index: [row.field.index] } : {}),
      oldValue: row.current,
      newValue: parsed.value,
    },
  };
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

/**
 * 标量 int 的域校验（Int64 守卫的面板侧前置；引擎 serializePayload 仍有最终守卫）。
 *
 * 入参只可能是 `int` / `str` 两档：面板侧 `submitScalar` 把**非 int 的标量一律按 str
 * 走原样回写**（存档里 `type === 'xml'` 的标量变量也在那条归一里，本函数不认得 xml）。
 */
export function parseScalarInput(type: 'int' | 'str', raw: string): { ok: true; value: number | string } | { ok: false; error: string } {
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
    // 2026-10-16 守卫：留空 ≠ 下标 0——trim（String.trim 覆盖全角空白 U+3000）后
    // 的空串经 Number('')===0 会静默变成下标 0（写错单元）。空/非法一律走失败路径。
    if ((parts[i] ?? '') === '') {
      return { ok: false, error: `第 ${i + 1} 维下标不能留空（留空不按 0 处理）` };
    }
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

/** 位置描述（diff 行与成功提示共用；机器面口径） */
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

/**
 * 待注入清单 → diff 行（改前 / 改后）。
 *
 * `scopeLabelOf`（可选）把 `chars[0]` 这类机器位置换成作者看得懂的「#0 阿蕾」——
 * 待写入清单是**确认写盘前的最后一眼**，这一眼理应是白话；不传 = 沿用机器位置
 * （旧调用方与测试零改动）。
 */
export function diffRows(
  pending: readonly PendingEdit[],
  scopeLabelOf?: (scope: ScopeKind) => string,
): DiffRow[] {
  return pending.map((e) => ({
    where: scopeLabelOf ? scopeLabelOf(e.scope) : editWhere(e.scope),
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

// ---------------------------------------------------------------------------
// 注入编排（零 React，可单测）：注入 → 重解析，全程带「选档归属」守卫
// ---------------------------------------------------------------------------

/** 注入编排依赖：注入写侧 + 深解析（签名与 SnapshotWriteService.inject / SnapshotSourceService.parse 对齐） */
export interface InjectFlowDeps {
  inject(path: string, overrides: ArchiveOverrides): Promise<SnapshotInjectionResult>;
  parse(path: string, options: { keepArrayCells: boolean; keepRaw: boolean }): Promise<SnapshotArchive>;
}

/** 编排落地钩子（组件侧接 setState；仅在回包仍归属当前选档时触发） */
export interface InjectFlowHooks {
  /** 注入成功且归属未变：落结果（组件同时清空待注入清单） */
  onInjected(result: SnapshotInjectionResult): void;
  /** 重解析成功且归属未变：落落盘后的新变量树 */
  onReloaded(archive: SnapshotArchive): void;
  /** 注入 / 重解析失败且归属未变：落错误 */
  onFailed(message: string): void;
  /** 归属不符（注入在途时用户已换档）：整条回包链丢弃（可记日志） */
  onDropped(): void;
}

export interface InjectFlowArgs {
  /** 发起注入时选中的档位路径 */
  path: string;
  overrides: ArchiveOverrides;
  /**
   * 归属校验：回包落地时「发起时的选档」是否仍是当前选档。
   * 组件实现为 `pathRef.current === 发起时 path`（ref 在 render 期镜像最新选档）。
   */
  stillSelected(): boolean;
}

/**
 * 注入 → 成功后重解析同一档位（展示落盘后的新值）。
 *
 * 2026-10-16 恶性缺陷守卫：注入在途时，档位下拉与 `kojo.snapshotSelected`
 * 事件都可以换档——旧档 A 的回包若无校验，会把 A 的变量树盖到已选 B 档的
 * 界面下，后续编辑经两击确认注入进 B 档（跨档写混淆）。
 * 守卫同构（与 navigator / archive-browser / state-replay 同一套写法）：
 * 发起记选档 → 每个回包落地前 `stillSelected()` 校验，不符整链丢弃。
 */
export async function runInjectFlow(deps: InjectFlowDeps, args: InjectFlowArgs, hooks: InjectFlowHooks): Promise<void> {
  try {
    const result = await deps.inject(args.path, args.overrides);
    if (!args.stillSelected()) {
      hooks.onDropped();
      return;
    }
    hooks.onInjected(result);
    const archive = await deps.parse(args.path, { keepArrayCells: true, keepRaw: true });
    if (!args.stillSelected()) {
      hooks.onDropped();
      return;
    }
    hooks.onReloaded(archive);
  } catch (err) {
    if (!args.stillSelected()) {
      hooks.onDropped();
      return;
    }
    hooks.onFailed(err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------ 渲染窗口 ------------------------------ */

/**
 * 窗口**数学**（`windowSize` / `nextWindow`）住在契约层 `sugar-panels`，与两块糖面板
 * 同一把尺；本文件只声明本面板两处列表的**窗口参数**（取值一字未动）。
 */

/**
 * 变量目录的渲染窗口（触底增窗）。
 *
 * 旧实现硬截 200 行 + 一句「其余 N 个变量未显示」——第 201 个起不可达。窗口化后
 * INITIAL 是首帧 DOM 上界，滚动触底或点击「显示更多」按 STEP 增长，全量可达。
 * 取值：变量行单行 ~18px、列表容器可视 ~14 行 ⇒ INITIAL=80 已是数屏余量；
 * 步长 160 按 1:2 节奏（与函数树的面窗口同比例）。
 */
export const VAR_WINDOW: RenderWindow = { initial: 80, step: 160 };
/** 变量目录初始窗口行数（旧导出名，测试与面板都按它钉首帧行数） */
export const VAR_WINDOW_INITIAL = VAR_WINDOW.initial;
/** 变量目录每次追加的行数（旧导出名） */
export const VAR_WINDOW_STEP = VAR_WINDOW.step;

/** 变量目录窗口当前应渲染的行数（纯函数）：[0, min(total, limit ?? INITIAL)] */
export function varWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, VAR_WINDOW);
}

/** 变量目录窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))——单调不减、终值 = total */
export function nextVarWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, VAR_WINDOW);
}

/**
 * 数组单元编辑列表的渲染窗口（触底增窗）。
 *
 * 旧实现硬截 120 行（表头写「显示前 120」）——第 121 个非空单元起不可达。取值：
 * 单元行单行 ~22px、编辑区容器可视 ~9 行 ⇒ INITIAL=60 已盖住常见小数组；
 * 大数组（数百上千非空单元）按 STEP=120 快进。
 */
export const CELL_WINDOW: RenderWindow = { initial: 60, step: 120 };
/** 单元列表初始窗口行数（旧导出名） */
export const CELL_WINDOW_INITIAL = CELL_WINDOW.initial;
/** 单元列表每次追加的行数（旧导出名） */
export const CELL_WINDOW_STEP = CELL_WINDOW.step;

/** 单元列表窗口当前应渲染的行数（纯函数）：[0, min(total, limit ?? INITIAL)] */
export function cellWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, CELL_WINDOW);
}

/** 单元列表窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))——单调不减、终值 = total */
export function nextCellWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, CELL_WINDOW);
}
