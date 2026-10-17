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
 *   `manual`——它是**作者的场景假设**，不是引擎事实；
 * - **跳到命中状态**（G1，2026-10-16）：`readLineAt` 把"作者正看着的那一行"
 *   折成一句走/不走的结论（八态穷尽，判不出绝不并入不走），`describeReading`
 *   出作者面的那句话。判定权仍在引擎（只投影 `FunctionReplay`，不重算条件）。
 *
 * 全部函数为纯函数：输入 → 输出，无副作用、无 React、无服务依赖。
 */

import type {
  BranchChainOutcome,
  ConditionExpr,
  FunctionReplay,
  PredicateReplay,
  ReplayCallContext,
  ReplayUnknownCode,
} from '@kojo/plugin-api';
import { nextWindow, pathKey, type RenderWindow } from '@kojo/plugin-api';

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
  return suggestFunctionNames(names, query, limit);
}

/**
 * 同上，但收 **Iterable**（PS-7：逐键打字路径上不再摊平数组）。
 *
 * 条件索引有 9.9 万个函数、其中 3.1 万个含状态依赖。旧写法每次渲染先
 * `[...condIndex.byFunction.keys()]` 摊一个 3 万串的数组，再对它做子串扫——
 * 摊平那一步与查询毫无关系（每敲一个字符付一次三万次 push + 一次大数组分配）。
 * 走迭代器还顺带让"命中 `limit` 就收手"提前结束读取（命中的名字靠前时只读几百个）。
 */
export function suggestFunctionNames(names: Iterable<string>, query: string, limit = 50): string[] {
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

/**
 * 一趟回放的**只读统计**（未知原因分组 + 假设影响）。
 *
 * 这两个函数原本是预览层每次渲染各算一遍（3,732 条谓词的 `groupUnknowns` +
 * 每条一次递归 `exprArgSlots` 的 `summarizeAssumptions`）——而它们只依赖
 * 「回放结果 × 假设槽」两样，逐键打字时压根没变。抽成一个函数就是为了给面板
 * 一个能记忆的键（`useMemo([result, assumed])`），呈现层拿现成的算式渲染。
 */
export interface ReplayAnalysis {
  readonly unknowns: UnknownGroup[];
  readonly impact: AssumptionImpact;
}

export function analyzeReplay(replay: FunctionReplay, assumed: readonly AssumedSlot[]): ReplayAnalysis {
  return { unknowns: groupUnknowns(replay), impact: summarizeAssumptions(replay, assumed) };
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

/* ======================== G1 跳到命中状态（2026-10-16） ========================
 *
 * 作者站在原代码的某一行上按下列键，宿主交出的是**中性位点**（文件 + 行），
 * 本模块负责把它折成"这一行在当前这份存档下走不走"。分层要点：
 *
 * - **判定权不外放**：走向结论一律采信回放引擎已算好的 `FunctionReplay`
 *   （谓词三值 + 分支链可达性传播），本模块只做**行 → 记录**的对照，
 *   绝不重算条件、绝不新建第二套可达性口径。
 * - **管辖链判据与 `kojo-sugar/preview` 的 `foldReachability` 同形**（覆盖 =
 *   链头在本行之前且不越过闭合行；归属 = 本行之前最近的成员）。为什么是"同形"
 *   而非复用：跨插件 import 是审计 C 项禁止的，而两侧的输入本就不同（那边吃糖
 *   源映射的块区间，这边吃单个行号）。漂移护栏：本模块的行号断言全部钉在
 *   `tests/locate-reading.test.ts`，分歧会在那里现形，而不是在作者眼前。
 * - **由外向内逐层折**，命中即停：外层没进来 / 外层走了别支都是决定性结论，
 *   不该再往下看；遇到"判不出"的层先记下原因继续下钻，因为内层的失配同样是
 *   决定性结论（引擎的 `unreachable` 已把可达性传播算过一遍，本层只做投影）。
 */

/** 一次跳转请求携带的位点（= 契约 `kojo.replayFunction.locate`） */
export interface LocateRequest {
  readonly filePath: string;
  readonly line: number;
}

/**
 * 一行的走法结论（面向作者的口径，八态穷尽；判不出不并入"不走"）。
 * - `runs`：会执行；
 * - `skipped`：不会执行（同一处条件走的是另一支）；
 * - `outer-blocked`：外层分支没进来；
 * - `no-entry`：这段条件全不成立、也没有兜底；
 * - `undecided`：判不出（附带原因，不假装知道）；
 * - `straight`：不在任何条件里，函数被调用就会执行；
 * - `outside`：这一行不在这段记录的起点之后；
 * - `no-record`：这一段没有登记到任何可判定的条件。
 */
export type LocateVerdict =
  | 'runs'
  | 'skipped'
  | 'outer-blocked'
  | 'no-entry'
  | 'undecided'
  | 'straight'
  | 'outside'
  | 'no-record';

/** 本行条件的成色（仅当这一行自己就是某个条件时给出） */
export interface LocateCondition {
  readonly kind: 'IF' | 'ELSEIF' | 'SIF' | 'CASE';
  readonly outcome: 'true' | 'false' | 'unknown';
  readonly text: string;
  readonly reason?: string;
}

/** 一行的读数（结论 + 支撑事实；文案统一由 `describeReading` 生成） */
export interface LineReading {
  readonly verdict: LocateVerdict;
  readonly line: number;
  /** 走到的那一支在哪行（`skipped` 时给作者"那到底走了哪"） */
  readonly wentTo?: number;
  /** 拦在外层的那条链的头行（`outer-blocked` 时有值） */
  readonly blockedBy?: number;
  /** 判不出的原因（`undecided` 时有值；已是人话，来自引擎的未知标注） */
  readonly reason?: string;
  /** 这一行自己就是一个条件 */
  readonly condition?: LocateCondition;
  /** 本段记录的起始行（仅 `outside` 时给出，让作者知道记录从哪开始） */
  readonly fromLine?: number;
  /** 本行在记录里对应几条条件（结果区据此决定高亮几行；0 = 没有可高亮的条目） */
  readonly matchedRows: number;
}

/** 来源文件是否是同一份文本（宿主与索引各拿各的路径字符串，分隔符/大小写不保证一致） */
export function sameSourcePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * 链 C 是否管辖第 L 行（本行落在 C 的体内，不是在 C 的链头上）。
 *
 * 收口判据优先用引擎给的 `endLine`（ENDIF / ENDSELECT 真行号）：**没有它就退回
 * 深度判据**（期间开起过同深度或更浅的链 ⇒ 本链已闭合）。为什么必须优先真收口：
 * 兄弟链只要深度比本链深，深度判据就看不出它已经结束，会把"已经翻篇的那条链"
 * 当作还在管辖本行——于是把**会执行**误报成**不会执行**（假阴性比不回答更坏）。
 */
function coversInner(chain: BranchChainOutcome, line: number, all: readonly BranchChainOutcome[]): boolean {
  if (chain.headLine >= line) return false;
  if (chain.endLine !== undefined) return line <= chain.endLine;
  for (const other of all) {
    if (other === chain) continue;
    if (other.headLine > chain.headLine && other.headLine < line && other.depth <= chain.depth) return false;
  }
  return true;
}

/** 管辖第 L 行的成员行（L 之前最近的一个）；无 → null（说明 L 就是链头那一行） */
function owningMember(chain: BranchChainOutcome, line: number): number | null {
  let owner: number | null = null;
  for (const m of chain.members) {
    if (m.line <= line) owner = m.line;
    else break;
  }
  return owner;
}

/** 第 L 行是否是这条链的成员行（IF / ELSEIF / ELSE / CASE / CASEELSE 本身） */
function isMemberLine(chain: BranchChainOutcome, line: number): boolean {
  return chain.members.some((m) => m.line === line);
}

/**
 * 同一行多条谓词的归约（与回放引擎 `branches.ts` 的折叠口径同款）：
 * 相邻的 `and` 半边成对消费为一个 AND 组（`CASE a TO b` 的 `>=a` / `<=b`），
 * 其余各自成组；组间取 OR。Kleene：含假即假，否则含未知即未知。
 */
function rollUpLine(preds: readonly PredicateReplay[]): LocateCondition | null {
  if (preds.length === 0) return null;
  const groups: ('true' | 'false' | 'unknown')[] = [];
  const reasons: string[] = [];
  let i = 0;
  while (i < preds.length) {
    if (preds[i]!.conjunction === 'and') {
      let group: 'true' | 'false' | 'unknown' = 'true';
      for (let k = 0; k < 2 && i < preds.length && preds[i]!.conjunction === 'and'; k++, i++) {
        const o = preds[i]!.outcome;
        if (o.kind === 'false') group = 'false';
        else if (o.kind === 'unknown' && group !== 'false') {
          group = 'unknown';
          reasons.push(o.unknown.message);
        }
      }
      groups.push(group);
    } else {
      const o = preds[i]!.outcome;
      groups.push(o.kind);
      if (o.kind === 'unknown') reasons.push(o.unknown.message);
      i += 1;
    }
  }
  const outcome: 'true' | 'false' | 'unknown' = groups.includes('true')
    ? 'true'
    : groups.includes('unknown')
      ? 'unknown'
      : 'false';
  const head = preds[0]!;
  return {
    kind: head.kind,
    outcome,
    // 同多条时逐条列出原文（作者要认得出自己写的那一句）
    text: preds.map((p) => p.text).join(' / '),
    ...(reasons.length > 0 ? { reason: reasons[0]! } : {}),
  };
}

/**
 * 一行的读数（纯函数）。顺序即优先级，逐条可测：
 * 1. 行号早于本段起点 → `outside`（越界不夹取：把过期行号折到附近等于给假答案）；
 * 2. **管辖本行的链**优先（本行是某条链的成员行，或落在某条链的体内）：
 *    链的 `outcome` 是引擎算好的三值结论，本模块只做投影；
 * 3. 无链管辖 → 看这一行自己有没有条件记录（SIF、未闭合的 IF 等）；
 * 4. 都没有 → `straight`；本段一条可判定记录都没有时给 `no-record`。
 */
export function readLineAt(replay: FunctionReplay, line: number): LineReading {
  const predsAtLine = replay.predicates.filter((p) => p.line === line);
  // 本行自己是个条件时，条件原文与成色**一律随读数带出**（每一态都可能要引用它，
  // 尤其"走了别支"那一句：作者得看见被判成假的就是自己站的这一行）
  const condition = rollUpLine(predsAtLine);
  const base: Omit<LineReading, 'verdict'> = {
    line,
    matchedRows: predsAtLine.length,
    ...(condition ? { condition } : {}),
  };

  if (!Number.isInteger(line) || line < replay.startLine) {
    return { ...base, verdict: 'outside', fromLine: replay.startLine };
  }

  const chains = replay.branches;
  // 本行自己是不是某条链的成员行或链头行（IF / ELSEIF / ELSE / CASE / CASEELSE / SELECTCASE）
  const own = chains
    .filter((c) => isMemberLine(c, line) || c.headLine === line)
    .sort((a, b) => b.headLine - a.headLine)[0];
  const covering = chains.filter((c) => coversInner(c, line, chains));
  // 由外向内逐层折（同一条链可能既"覆盖"又是"本行所属"，去重后按链头升序）
  const governing = [...new Set(own ? [own, ...covering] : covering)].sort((a, b) => a.headLine - b.headLine);

  if (governing.length > 0) {
    let softUnknown: BranchChainOutcome | null = null;
    for (const c of governing) {
      // 本行就是这条链的链头（IF / SELECTCASE）：链头**一定会执行**（它是"被判"的那一句），
      // 链的走向对它没有意义——只有"外层没进来"这一种结论对它成立。
      if (c.headLine === line) {
        if (c.outcome === 'unreachable') return { ...base, verdict: 'outer-blocked', blockedBy: c.headLine };
        continue;
      }
      // 决定性结论命中即停：外层没进来 / 全不成立没兜底 / 走了别支
      if (c.outcome === 'unreachable') return { ...base, verdict: 'outer-blocked', blockedBy: c.headLine };
      if (c.outcome === 'no-match') return { ...base, verdict: 'no-entry' };
      if (c.outcome === 'unknown') {
        if (!softUnknown) softUnknown = c;
        continue; // 这一层判不出，但内层仍可能决定性失配 → 继续下钻
      }
      const owner = owningMember(c, line);
      if (owner === null) continue; // 链头行本身（SELECTCASE）：进了这段就执行，不阻断
      if (owner !== c.takenLine) return { ...base, verdict: 'skipped', wentTo: c.takenLine ?? undefined };
    }
    if (softUnknown) {
      return {
        ...base,
        verdict: 'undecided',
        reason: softUnknown.unknown?.message ?? '条件里有这份存档读不到的东西',
      };
    }
    return { ...base, verdict: 'runs' };
  }

  if (condition) {
    if (condition.outcome === 'true') return { ...base, verdict: 'runs' };
    if (condition.outcome === 'false') return { ...base, verdict: 'skipped' };
    return { ...base, verdict: 'undecided', reason: condition.reason ?? '读不到' };
  }

  if (replay.stats.total === 0 && chains.length === 0) return { ...base, verdict: 'no-record' };
  return { ...base, verdict: 'straight' };
}

/** 结论的中文短标（与面板既有徽章同形，不新造第三套呈现） */
export const VERDICT_LABEL: Record<LocateVerdict, { label: string; className: string }> = {
  runs: { label: '会走', className: 'rp-badge ok' },
  straight: { label: '会走', className: 'rp-badge ok' },
  skipped: { label: '不会走', className: 'rp-badge bad' },
  'outer-blocked': { label: '不会走', className: 'rp-badge bad' },
  'no-entry': { label: '不会走', className: 'rp-badge bad' },
  undecided: { label: '判不出', className: 'rp-badge unk' },
  outside: { label: '对不上', className: 'rp-badge unk' },
  'no-record': { label: '没记录', className: 'rp-badge unk' },
};

/**
 * 一句人话（作者面）。去黑话是硬要求：这里不出现"回放 / 谓词 / 链 / 矩阵"这类词，
 * 只说这一行走不走、为什么、那到底走了哪一行。
 */
export function describeReading(reading: LineReading): string {
  const at = `第 ${reading.line} 行`;
  switch (reading.verdict) {
    case 'runs':
      return reading.condition
        ? `${at} 的条件「${reading.condition.text}」成立——这一行走得到。`
        : `${at} 会执行：这一处的条件走的就是这一支。`;
    case 'skipped':
      return reading.wentTo
        ? `${at} 不会执行：同一处的条件走的是第 ${reading.wentTo} 行那一支。`
        : `${at} 不会执行：这一处的条件不成立。`;
    case 'outer-blocked':
      return `${at} 不会执行：外层第 ${reading.blockedBy} 行的条件就没让它进来。`;
    case 'no-entry':
      return `${at} 不会执行：这一整段的条件全都不成立，也没有兜底分支。`;
    case 'undecided':
      return `${at} 判不出：条件里用到了这份存档读不到的东西（${reading.reason ?? '未给出原因'}）。`;
    case 'straight':
      return `${at} 不在任何条件里——这一段只要被调用，它就会执行。`;
    case 'outside':
      return `${at} 不在这段程序的记录里——这段的记录从第 ${reading.fromLine ?? 1} 行才开始（大概是被改过、行号错位了）。`;
    case 'no-record':
      return '这一段没有登记到可判定的条件，给不出走不走的结论。';
  }
}

/** 一条"这一行"的告示（横幅用；措辞全部在册，组件侧不再拼句子） */
export interface LocateNotice {
  readonly line: number;
  readonly badge: string;
  readonly className: string;
  readonly sentence: string;
  /** 结果区里有可对上的条目（false = 只有这句话，没有可高亮/可滚动的行） */
  readonly hasRows: boolean;
}

/**
 * 位点 → 横幅（纯函数）。
 *
 * 两条不静默的分支都要有句子：
 * - 来源文本对不上（例如从另一份文件、或从行号会错位的派生视图发来）：
 *   **不硬套**——明说对不上，整段结果照常呈现；
 * - 对得上：把 `readLineAt` 的结论翻成那句人话。
 */
export function locateNoticeFor(result: FunctionReplay, locate: LocateRequest): LocateNotice {
  if (!sameSourcePath(result.filePath, locate.filePath)) {
    return {
      line: locate.line,
      badge: VERDICT_LABEL.outside.label,
      className: VERDICT_LABEL.outside.className,
      sentence: `第 ${locate.line} 行来自另一份文本，和这段记录的来源不是同一份——下面按整段呈现，没把它硬套到这一行上。`,
      hasRows: false,
    };
  }
  const reading = readLineAt(result, locate.line);
  return {
    line: locate.line,
    badge: VERDICT_LABEL[reading.verdict].label,
    className: VERDICT_LABEL[reading.verdict].className,
    sentence: describeReading(reading),
    hasRows: reading.matchedRows > 0,
  };
}

/* ------------------------------ 谓词渲染窗口 ------------------------------ */

/**
 * 谓词列表的渲染窗口（触底增窗）。
 *
 * 旧实现硬截 300 条 + 一句「其余 N 条未显示」——第 301 条起不可达。窗口化后
 * INITIAL 是首帧 DOM 上界，滚动触底或点击「显示更多」按 STEP 增长，全量可达。
 * 取值：单函数谓词通常 <100（面板头注口径）⇒ INITIAL=120 常见函数零哨兵、
 * 一窗看完；步长 240 按 1:2 节奏，大可判定函数两三步入底。
 *
 * 窗口**数学**住在契约层 `sugar-panels`（`nextWindow`，与两块糖面板同一把尺）；
 * 本面板只声明**自己的窗口参数**（取值未动：120/240）。
 */
export const PRED_WINDOW: RenderWindow = { initial: 120, step: 240 };
/** 初始窗口行数（旧导出名，测试与面板都按它钉首帧行数） */
export const PRED_WINDOW_INITIAL = PRED_WINDOW.initial;
/** 每次追加的行数（旧导出名） */
export const PRED_WINDOW_STEP = PRED_WINDOW.step;

/**
 * 当前窗口应渲染的行数（纯函数）：[0, min(total, max(limit ?? INITIAL, mustInclude))]。
 *
 * `mustInclude` 是「跳转来的那一条必须看得见」的覆盖口径（G1「跳到命中状态」）：
 * 位点落在初始窗口之外时，窗口撑大到盖住它那一条——旧实现第 300 条之后本就
 * 不在屏上，窗口化不许把这条既有承诺弄丢。0 = 无需覆盖。
 *
 * **这里刻意不走契约的 `windowSize`**：它没有 `mustInclude` 这一维（本面板独有），
 * 少一个参数就少一处会被将来"顺手统一"掉的行为。
 */
export function predWindowSize(total: number, limit: number | undefined, mustInclude = 0): number {
  return Math.min(total, Math.max(limit ?? PRED_WINDOW_INITIAL, mustInclude));
}

/**
 * 窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))。
 * 单调不减、单步增量 ≤ STEP、终值 = total——「显示更多」与触底自动加载共用。
 */
export function nextPredWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, PRED_WINDOW);
}
