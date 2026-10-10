/**
 * 回放面板纯逻辑（零 React；可单测）。
 *
 * - `parseCallContextText`：把用户输入的槽位赋值文本（`0=36, 1=15`）解析为
 *   `ReplayCallContext`——ARG/ARGS 是场景输入，编辑器不猜测；
 * - `groupUnknowns`：未知原因分组统计（面板分组渲染用）；
 * - `suggestFunctions`：函数名提示（按前缀/子串过滤条件索引中的函数名）；
 * - **假设值链路**（v1.0 收口 C9）：协议槽的"默认场景预填 0"是**假设值**而非
 *   确定值——`classifySlotValue`/`collectAssumedSlots` 判定来源，
 *   `summarizeAssumptions` 统计其对谓词结果的影响（"基于假设"标注 + 假设计数）；
 * - **场景预设**（v1.0 收口线一）：`ReplayScene` 把手填的调用上下文槽位命名保存 /
 *   复用——`sanitizeScenes` 容错反序列化，`captureSceneSlots` 采集当前输入，
 *   `applyScene` 应用到函数签名（冲突显式上报），`sceneSuggestionName` 由协议槽
 *   label 生成建议名（协议不可用 → 空串，降级纯手填）；场景值一律记为
 *   `manual`——它是**作者的场景假设**，不是引擎事实。
 *
 * 全部函数为纯函数：输入 → 输出，无副作用、无 React、无服务依赖。
 */

import type { ConditionExpr, FunctionReplay, ReplayCallContext, ReplayUnknownCode } from '@kojo/plugin-api';

/** 解析失败的原因（呈现给用户） */
export type CallContextParseError = 'bad-syntax' | 'bad-slot' | 'bad-value' | 'dup-slot';

export type CallContextParseResult =
  | { ok: true; ints: (number | undefined)[]; strs: (string | undefined)[] }
  | { ok: false; error: CallContextParseError; detail: string };

/**
 * 解析调用上下文文本。
 *
 * 语法：逗号/空格分隔的 `槽位=值` 项；`n=v`（数字）→ ARG 槽；`s"..."` 或
 * `n="文本"` 形态中带引号的值 → ARGS 槽。示例：
 *   - `0=36, 1=15`          → ARG:0=36, ARG:1=15
 *   - `1="约会"`            → ARGS:1='约会'
 *   - 空 / 仅空白           → undefined（未提供上下文）
 *
 * 槽位必须是非负整数；未提供的槽位保持 undefined（unknown('call-context')）。
 */
export function parseCallContextText(text: string): CallContextParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, ints: [], strs: [] };

  const items = trimmed.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
  const ints: (number | undefined)[] = [];
  const strs: (string | undefined)[] = [];
  const seenInt = new Set<number>();
  const seenStr = new Set<number>();

  for (const item of items) {
    const m = /^(\d+)\s*=\s*(.*)$/.exec(item);
    if (!m) {
      return { ok: false, error: 'bad-syntax', detail: `无法解析「${item}」（应为 槽位=值，如 0=36）` };
    }
    const slot = Number(m[1]);
    const raw = m[2]!.trim();
    if (!Number.isInteger(slot) || slot < 0 || slot > 999) {
      return { ok: false, error: 'bad-slot', detail: `槽位号非法：${m[1]}（0-999）` };
    }

    // 字符串值：带引号 → ARGS 槽
    const strM = /^"(.*)"$/.exec(raw);
    if (strM) {
      while (strs.length <= slot) strs.push(undefined);
      if (seenStr.has(slot)) return { ok: false, error: 'dup-slot', detail: `ARGS:${slot} 重复赋值` };
      seenStr.add(slot);
      strs[slot] = strM[1]!;
      continue;
    }

    // 数值槽
    if (!/^-?\d+$/.test(raw)) {
      return { ok: false, error: 'bad-value', detail: `值必须是整数或带引号字符串：「${raw}」` };
    }
    const v = Number(raw);
    if (!Number.isSafeInteger(v)) {
      return { ok: false, error: 'bad-value', detail: `数值超出安全整数范围：${raw}` };
    }
    while (ints.length <= slot) ints.push(undefined);
    if (seenInt.has(slot)) return { ok: false, error: 'dup-slot', detail: `ARG:${slot} 重复赋值` };
    seenInt.add(slot);
    ints[slot] = v;
  }

  return { ok: true, ints, strs };
}

/** 组装 `ReplayCallContext`（空槽位表 → undefined = 不注入，走 call-context unknown） */
export function toCallContext(result: Extract<CallContextParseResult, { ok: true }>): ReplayCallContext | undefined {
  const hasInts = result.ints.some((v) => v !== undefined);
  const hasStrs = result.strs.some((v) => v !== undefined);
  if (!hasInts && !hasStrs) return undefined;
  return {
    ...(hasInts ? { ints: result.ints } : {}),
    ...(hasStrs ? { strs: result.strs } : {}),
  };
}

export interface UnknownGroup {
  code: ReplayUnknownCode;
  count: number;
}

/** 未知原因分组（按数量降序；面板分组渲染用） */
export function groupUnknowns(replay: FunctionReplay): UnknownGroup[] {
  const counts = new Map<ReplayUnknownCode, number>();
  for (const p of replay.predicates) {
    if (p.outcome.kind === 'unknown') {
      const c = p.outcome.unknown.code;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

/**
 * 函数名提示：条件索引中的名字按子串过滤（大小写不敏感），最多 `limit` 条。
 * 空查询 → 空数组（不刷全量列表——9.5 万名字一次性渲染会拖垮 DOM）。
 */
export function suggestFunctions(names: readonly string[], query: string, limit = 50): string[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const hits: string[] = [];
  for (const n of names) {
    if (n.toUpperCase().includes(q)) {
      hits.push(n);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/* ------------------------- 假设值链路（v1.0 收口 C9） ------------------------- */

/**
 * 协议槽位键——`int` 与 `str` 同号互不冲突（签名可同时含 `ARG:0` 与 `ARGS:0`，
 * 如路由模板 `(ARGS:2, ARG:3, ARG:4)` → str:0 + int:0 + int:1）。
 */
export function slotKey(kind: 'int' | 'str', index: number): string {
  return `${kind}:${index}`;
}

/** 协议槽位的"默认场景"预填值（int → '0'；str → '' = 未提供） */
export function defaultSlotText(kind: 'int' | 'str'): string {
  return kind === 'int' ? '0' : '';
}

/** 协议槽位赋值的来源三态 */
export type SlotOrigin = 'manual' | 'assumption' | 'unset';

/**
 * 判定单个协议槽位赋值的来源（审阅 C9）：
 * - `unset`：空值——未提供该槽，求值走 `unknown('call-context')`，语义不变；
 * - `assumption`：**未手改且等于预填默认**（int 的 `'0'`）——"默认场景假设值"：
 *   未改动的 0 并不必然等于引擎真实默认，UI 必须标注，不得伪装成确定命中；
 * - `manual`：作者手输（含把预填 0 显式改写、以及 str 槽填写）。
 */
export function classifySlotValue(kind: 'int' | 'str', raw: string, edited: boolean): SlotOrigin {
  const t = raw.trim();
  if (t.length === 0) return 'unset';
  if (!edited && t === defaultSlotText(kind)) return 'assumption';
  return 'manual';
}

/** 假设值槽位（kind + index） */
export interface AssumedSlot {
  kind: 'int' | 'str';
  index: number;
}

/** 收集本次回放的"假设值"槽位（未手改的预填默认；str 预填空 = unset，不算假设） */
export function collectAssumedSlots(
  slots: readonly { index: number; kind: 'int' | 'str' }[],
  texts: Readonly<Record<string, string>>,
  edited: Readonly<Record<string, boolean>>,
): AssumedSlot[] {
  const out: AssumedSlot[] = [];
  for (const s of slots) {
    const k = slotKey(s.kind, s.index);
    if (classifySlotValue(s.kind, texts[k] ?? '', edited[k] === true) === 'assumption') {
      out.push({ kind: s.kind, index: s.index });
    }
  }
  return out;
}

/** 表达式引用的 ARG / ARGS 槽号（裸名 ≡ `:0`，与引擎寻址一致；动态索引段不可归因，跳过） */
export function exprArgSlots(expr: ConditionExpr): { ints: number[]; strs: number[] } {
  const ints = new Set<number>();
  const strs = new Set<number>();
  const walk = (e: ConditionExpr): void => {
    switch (e.kind) {
      case 'ref': {
        const name = e.name.toUpperCase();
        if (name !== 'ARG' && name !== 'ARGS') return;
        const rawIdx = e.indices[0];
        const idx = rawIdx === undefined ? 0 : /^\d+$/.test(rawIdx) ? Number(rawIdx) : null;
        if (idx === null) return; // 动态索引段（如 ARG:ARG:0）无法静态归因
        (name === 'ARG' ? ints : strs).add(idx);
        return;
      }
      case 'call':
        for (const a of e.args) walk(a);
        return;
      case 'unary':
        walk(e.operand);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'ternary':
        walk(e.cond);
        walk(e.then);
        walk(e.else);
        return;
      default:
        return; // literal / nameValue / opaque 不含槽位引用（opaque 原文本不可归因）
    }
  };
  walk(expr);
  return { ints: [...ints], strs: [...strs] };
}

/** 假设值对回放结果的影响 */
export interface AssumptionImpact {
  /** 与 `replay.predicates` 逐位对齐：该谓词是否读取了任一假设值槽位 */
  affected: boolean[];
  /** 被谓词实际消费的假设槽位（去重；= "本结果含 N 个假设参数"的 N） */
  consumed: AssumedSlot[];
}

/**
 * 汇总"假设值"对回放结果的影响：
 * - `affected[i]` = 该谓词是否读到了假设槽（面板"基于假设"标注依据）；
 * - `consumed` = 至少被一条谓词读取的假设槽位（汇总计数，未被读取的槽不影响可信度）。
 */
export function summarizeAssumptions(replay: FunctionReplay, assumed: readonly AssumedSlot[]): AssumptionImpact {
  const affected = replay.predicates.map(() => false);
  if (assumed.length === 0) return { affected, consumed: [] };
  const consumed = new Map<string, AssumedSlot>();
  replay.predicates.forEach((p, i) => {
    const { ints, strs } = exprArgSlots(p.expr);
    for (const a of assumed) {
      const used = a.kind === 'int' ? ints.includes(a.index) : strs.includes(a.index);
      if (!used) continue;
      affected[i] = true;
      consumed.set(slotKey(a.kind, a.index), a);
    }
  });
  return { affected, consumed: [...consumed.values()] };
}

/* ------------------- 场景预设（v1.0 收口线一：调用上下文可保存复用） ------------------- */

/** 场景槽位值——`kind` 恒为 `manual`：场景值是作者显式提供的场景输入，非引擎事实 */
export interface SceneSlotValue {
  value: string;
  kind: 'manual';
}

/** 回放场景预设：命名保存的调用上下文槽位集合（`slots` 键 = `slotKey(kind,index)`） */
export interface ReplayScene {
  id: string;
  name: string;
  slots: Record<string, SceneSlotValue>;
}

/** 内置默认场景 id（不可删除、不持久化；应用 = 全部槽位回到默认：int `0` 假设 / str 空 未提供） */
export const DEFAULT_SCENE_ID = '__default__';
/** 场景数量上限（防御损坏 / 膨胀的存储数据） */
export const MAX_SCENES = 50;
/** 场景名长度上限 */
export const MAX_SCENE_NAME = 60;

const SLOT_KEY_RE = /^(int|str):(\d{1,3})$/;

/** 内置默认场景（全 0 / 全部 assumption）——不作为用户场景持久化 */
export function defaultScene(): ReplayScene {
  return { id: DEFAULT_SCENE_ID, name: '默认场景（全 0，全部假设）', slots: {} };
}

/**
 * 反序列化容错：存储脏数据不致命（与内核 L1 存储容错同向）——
 * 非数组 → 空；逐条丢弃非法项（缺 id/name、非法槽位键、非 `manual`、空值、重复 id），
 * 名字与 id 去空白，超出上限即截断。绝不抛错。
 */
export function sanitizeScenes(raw: unknown): ReplayScene[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplayScene[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_SCENES) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, MAX_SCENE_NAME) : '';
    if (id.length === 0 || name.length === 0 || id === DEFAULT_SCENE_ID || ids.has(id)) continue;
    const slots: Record<string, SceneSlotValue> = {};
    const rawSlots = rec.slots;
    if (rawSlots && typeof rawSlots === 'object' && !Array.isArray(rawSlots)) {
      for (const [k, v] of Object.entries(rawSlots as Record<string, unknown>)) {
        if (!SLOT_KEY_RE.test(k)) continue;
        if (!v || typeof v !== 'object') continue;
        const sv = v as Record<string, unknown>;
        if (sv.kind !== 'manual' || typeof sv.value !== 'string' || sv.value.trim().length === 0) continue;
        slots[k] = { value: sv.value, kind: 'manual' };
      }
    }
    ids.add(id);
    out.push({ id, name, slots });
  }
  return out;
}

/**
 * 采集当前槽位输入为场景槽位：仅收非空值（空 = 未提供，不入场景）；
 * 来源恒标 `manual`——保存即"作者确认过这组场景参数"，它不是引擎事实。
 */
export function captureSceneSlots(
  slots: readonly { index: number; kind: 'int' | 'str' }[],
  texts: Readonly<Record<string, string>>,
): Record<string, SceneSlotValue> {
  const out: Record<string, SceneSlotValue> = {};
  for (const s of slots) {
    const k = slotKey(s.kind, s.index);
    const raw = texts[k] ?? '';
    if (raw.trim().length === 0) continue;
    out[k] = { value: raw, kind: 'manual' };
  }
  return out;
}

/** 场景应用结果（含冲突上报，不静默） */
export interface SceneApplication {
  /** 新槽位文本（键 = `slotKey`） */
  texts: Record<string, string>;
  /** 新的手改标记（场景覆盖的槽 → true = 来源 manual；其余 false = 回到假设 / 未提供） */
  edited: Record<string, boolean>;
  /** 场景命中当前函数签名的槽位键 */
  applied: string[];
  /** 场景提供但当前签名没有的槽位键（协议不同 → 忽略，显式上报） */
  dropped: string[];
  /** 签名单内有、场景未覆盖、且此前已填 → 被重置为默认的槽位键 */
  reset: string[];
}

/**
 * 把场景应用到某个函数签名（协议槽位表）：
 * - 场景覆盖的槽 → 取场景值 + `edited=true`（来源 **manual**：作者假设，非引擎事实）；
 * - 签名内未被场景覆盖的槽 → 回到默认（int `0` = 假设 / str 空 = 未提供），此前已填的记入 `reset`；
 * - 场景里签名没有的槽（如换到别的家族函数）→ 丢弃并记入 `dropped`。
 */
export function applyScene(
  scene: ReplayScene,
  slots: readonly { index: number; kind: 'int' | 'str' }[],
  currentTexts: Readonly<Record<string, string>> = {},
): SceneApplication {
  const texts: Record<string, string> = {};
  const edited: Record<string, boolean> = {};
  const applied: string[] = [];
  const reset: string[] = [];
  const signature = new Set<string>();
  for (const s of slots) {
    const k = slotKey(s.kind, s.index);
    signature.add(k);
    const sv = scene.slots[k];
    if (sv && sv.value.trim().length > 0) {
      texts[k] = sv.value;
      edited[k] = true;
      applied.push(k);
      continue;
    }
    texts[k] = defaultSlotText(s.kind);
    edited[k] = false;
    if ((currentTexts[k] ?? '').trim().length > 0) reset.push(k);
  }
  const dropped = Object.keys(scene.slots).filter((k) => !signature.has(k));
  return { texts, edited, applied, dropped, reset };
}

/**
 * 场景建议名（协议可用时由槽位 label 拼接，如「对话对象=觉/时机=SP_EVENT」）。
 * 未填 / 未覆盖的槽位不参与；label 为空的槽回退 `ARG:n` / `ARGS:n`。
 * 协议不可用（slots 为空）→ 空串（降级纯手填，不猜）。
 */
export function sceneSuggestionName(
  slots: readonly { index: number; kind: 'int' | 'str'; label: string }[],
  texts: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  for (const s of slots) {
    const v = (texts[slotKey(s.kind, s.index)] ?? '').trim();
    if (v.length === 0) continue;
    const label = s.label.trim() || `${s.kind === 'str' ? 'ARGS' : 'ARG'}:${s.index}`;
    parts.push(`${label}=${v}`);
  }
  return parts.join('/').slice(0, MAX_SCENE_NAME);
}

/** 场景槽位 → 裸调用上下文文本（无协议降级；int `n=v` / str `n="v"`；按 槽号+kind 排序） */
export function sceneSlotsToContextText(slots: Readonly<Record<string, SceneSlotValue>>): string {
  const items: { kind: 'int' | 'str'; index: number; value: string }[] = [];
  for (const [k, sv] of Object.entries(slots)) {
    const m = SLOT_KEY_RE.exec(k);
    if (!m) continue;
    items.push({ kind: m[1] as 'int' | 'str', index: Number(m[2]), value: sv.value });
  }
  items.sort((a, b) => a.index - b.index || (a.kind === b.kind ? 0 : a.kind === 'int' ? -1 : 1));
  return items
    .map((it) => (it.kind === 'str' ? `${it.index}="${it.value}"` : `${it.index}=${it.value.trim()}`))
    .join(', ');
}

/**
 * 裸调用上下文文本 → 场景槽位（复用 `parseCallContextText`）。
 * 解析失败 → `null`（调用方显式提示，**绝不抛错**）；空文本 → 空槽位表。
 */
export function contextTextToSceneSlots(text: string): Record<string, SceneSlotValue> | null {
  const parsed = parseCallContextText(text);
  if (!parsed.ok) return null;
  const out: Record<string, SceneSlotValue> = {};
  parsed.ints.forEach((v, i) => {
    if (v !== undefined) out[slotKey('int', i)] = { value: String(v), kind: 'manual' };
  });
  parsed.strs.forEach((v, i) => {
    if (v !== undefined) out[slotKey('str', i)] = { value: v, kind: 'manual' };
  });
  return out;
}

/**
 * 保存场景：同名视为**覆盖**（保留原 id，槽位整体替换），否则新建。
 * `makeId` 由调用方提供（可测；生产用 `newSceneId`）。
 */
export function upsertSceneByName(
  scenes: readonly ReplayScene[],
  name: string,
  slots: Record<string, SceneSlotValue>,
  makeId: () => string,
): { scenes: ReplayScene[]; scene: ReplayScene; overwritten: boolean } {
  const trimmed = name.trim().slice(0, MAX_SCENE_NAME);
  const existing = scenes.find((s) => s.name === trimmed);
  if (existing) {
    const scene: ReplayScene = { id: existing.id, name: trimmed, slots };
    return { scenes: scenes.map((s) => (s.id === existing.id ? scene : s)), scene, overwritten: true };
  }
  const scene: ReplayScene = { id: makeId(), name: trimmed, slots };
  return { scenes: [...scenes, scene], scene, overwritten: false };
}

/** 删除场景（内置默认场景不可删——原样返回） */
export function removeScene(scenes: readonly ReplayScene[], id: string): ReplayScene[] {
  if (id === DEFAULT_SCENE_ID) return [...scenes];
  return scenes.filter((s) => s.id !== id);
}

/** 生成唯一场景 id（碰撞重试；`gen` 可注入以便单测） */
export function newSceneId(existing: readonly string[], gen: () => string = defaultSceneIdSeed): string {
  for (let i = 0; i < 100; i += 1) {
    const id = `scene-${gen()}`;
    if (id !== DEFAULT_SCENE_ID && !existing.includes(id)) return id;
  }
  return `scene-${Date.now().toString(36)}-${existing.length}`;
}

function defaultSceneIdSeed(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
