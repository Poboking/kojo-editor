/**
 * 数值看板**纯逻辑层**（零 React、零 IO、零 DOM——可在任何环境单测）。
 *
 * 分层纪律与 `ui-state-replay/panel-logic.ts` 同款：本模块只做「数据形状 → 数据形状」
 * 的变换，宿主服务（adapter 字典 / ERB 索引 / 条件索引）由激活层的面板壳喂进来。
 * 本模块**不认识任何游戏名词**：全部标签 / 名字 / 位表都是运行时经
 * `VariableSchema` 契约流进来的数据，这里只有 era 引擎层的中性词汇（族头、来源层）。
 */

import type { ConditionIndex, VariableSchema, VariableSource } from '@kojo/plugin-api';
import { windowSize } from '@kojo/plugin-api';
import { CANDIDATE_FAMILIES, isCharaScopedFamily } from './var-families';

/* ------------------------------ 渲染窗口 ------------------------------ */
/* 纪律与 `plugin-api/sugar-panels.ts` 的 DIAG_WINDOW / ROW_WINDOW 同源：
   单行 ~22px，initial ≈ 一屏半，步长 1:2；「显示更多」与触底自动加载共用。 */

/** 看板行窗口（条目 / 符号 / 指令三张列表同一档，不另立口径） */
export const VL_WINDOW = { initial: 120, step: 240 } as const;

/** 反查引用窗口（使用点行更轻，initial 收窄） */
export const VL_USAGE_WINDOW = { initial: 40, step: 80 } as const;

/** 当前窗口应渲染的行数（透传契约纯函数；测试钉住「三表同档」） */
export function vlWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, VL_WINDOW);
}

/* ------------------------------ 变量字典 ------------------------------ */

/** 族行（左侧族列表的一行） */
export interface FamilyRow {
  /** 引擎族头（大写） */
  readonly id: string;
  /** 显示名（`schema.lookup(family)` 的家族级 description；缺省 = 族头原样） */
  readonly label: string;
  /** 该族有没有名称表条目（0 条的族不显示——不猜） */
  readonly count: number;
  readonly charaScoped: boolean;
}

/** 变量条目行（右侧列表的一行） */
export interface VarEntryRow {
  readonly family: string;
  /** 编号或具名索引（schema 原样） */
  readonly index: number | string;
  /** 索引名（名称表原文；可能与编号相同） */
  readonly name: string;
  /** 人类可读说明（经汉化词典的中文，缺省 = 无） */
  readonly desc?: string;
  /** 具名索引解析出的编号 */
  readonly resolvedIndex?: number;
  /** 来源层 */
  readonly source?: VariableSource;
}

/** 来源层的中文显示（era 引擎层概念，非游戏知识） */
export function sourceLabel(source: VariableSource | undefined): string {
  switch (source) {
    case 'append':
      return '追加表';
    case 'const':
      return '常量';
    default:
      return '主表';
  }
}

/**
 * 建族行清单：拿引擎候选词汇逐族问 `names(family)`，有≥1 条的族才出现。
 * 显示名走 `lookup(family)`（家族级查询，实现方给策展显示名；缺省回退族头）。
 * 排序保持候选表序（角色系在前）——**不按条目数排序**：族的位置要稳定，
 * 作者背得出「CFLAG 在第几行」，按计数抖动是纯伤害。
 */
export function buildFamilyRows(schema: VariableSchema): FamilyRow[] {
  if (typeof schema.names !== 'function') return [];
  const rows: FamilyRow[] = [];
  for (const meta of CANDIDATE_FAMILIES) {
    const entries = schema.names(meta.id);
    if (!entries || entries.length === 0) continue;
    const label = schema.lookup(meta.id)?.description ?? meta.id;
    rows.push({ id: meta.id, label, count: entries.length, charaScoped: meta.charaScoped });
  }
  return rows;
}

/**
 * 一族的条目行：`names(family)` 给「编号 + 名字 + 来源层」，说明补走
 * `lookup(family, index)`（那一路才有汉化词典的中文 description）。
 * 每行一次 Map 查询，千行级族群总开销毫秒级。
 */
export function entryRowsForFamily(schema: VariableSchema, family: string): VarEntryRow[] {
  if (typeof schema.names !== 'function') return [];
  const famUpper = family.toUpperCase();
  const entries = schema.names(famUpper);
  const out: VarEntryRow[] = [];
  for (const e of entries) {
    const desc = schema.lookup(famUpper, e.index)?.description;
    out.push({
      family: famUpper,
      index: e.index ?? '',
      name: e.name,
      ...(desc !== undefined ? { desc } : {}),
      ...(e.resolvedIndex !== undefined ? { resolvedIndex: e.resolvedIndex } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
    });
  }
  return out;
}

/** 查询串归一（大小写折叠；空格原样——CJK 不受影响） */
function norm(q: string): string {
  return q.trim().toLowerCase();
}

/** 通用子串匹配：任意字段命中即收；数字查询同时前缀匹配编号 */
export function queryMatches(q: string, fields: readonly (string | number | undefined)[]): boolean {
  const n = norm(q);
  if (n.length === 0) return true;
  let indexHit = false;
  for (const f of fields) {
    if (f === undefined) continue;
    const s = String(f);
    if (s.toLowerCase().includes(n)) return true;
    if (typeof f === 'number' && String(f).startsWith(n)) indexHit = true;
  }
  return indexHit;
}

export function filterVarEntries(rows: readonly VarEntryRow[], q: string): readonly VarEntryRow[] {
  if (norm(q).length === 0) return [...rows];
  return rows.filter((r) => queryMatches(q, [r.name, r.desc, r.index, r.resolvedIndex]));
}

export function filterFamilies(rows: readonly FamilyRow[], q: string): readonly FamilyRow[] {
  if (norm(q).length === 0) return rows;
  return rows.filter((r) => queryMatches(q, [r.id, r.label]));
}

/* ------------------------------ 复制片段 ------------------------------ */

/** 一条可复制的引用片段（label = 按钮上说什么） */
export interface SnippetItem {
  readonly label: string;
  readonly text: string;
}

/** 名字能不能当具名索引写（含空白 / 逗号 / 冒号的名字写进表达式会碎，不产出那种片段） */
function nameWritable(name: string): boolean {
  return name.length > 0 && !/^\d+$/.test(name) && !/[\s:,，：]/.test(name);
}

/**
 * 选中条目的可复制引用片段：
 * - 基础形 `族:编号`；具名形 `族:名字`（名字可写时）；
 * - 角色系族补 `族:TARGET:编号` / `族:MASTER:编号`（口上最高频的两条引用形）。
 * 角色系判定走**引擎族形表**（`var-families.ts`，跨游戏一致），不是游戏知识。
 */
export function snippetsFor(family: string, entry: VarEntryRow): SnippetItem[] {
  const fam = family.toUpperCase();
  const base = `${fam}:${entry.resolvedIndex ?? entry.index}`;
  const out: SnippetItem[] = [{ label: '编号引用', text: base }];
  if (nameWritable(entry.name)) {
    out.push({ label: '具名引用', text: `${fam}:${entry.name}` });
  }
  if (isCharaScopedFamily(fam)) {
    out.push({ label: 'TARGET', text: `${fam}:TARGET:${entry.resolvedIndex ?? entry.index}` });
    out.push({ label: 'MASTER', text: `${fam}:MASTER:${entry.resolvedIndex ?? entry.index}` });
    if (nameWritable(entry.name)) {
      out.push({ label: 'TARGET 具名', text: `${fam}:TARGET:${entry.name}` });
    }
  }
  return out;
}

/* ------------------------------ 反查引用（变量） ------------------------------ */

/** 变量的一处使用（来自条件抽取索引：哪个函数的第几行用了这个状态键） */
export interface VarUsageItem {
  /** 使用它的函数名 */
  readonly fn: string;
  /** 状态键原文（如 `CFLAG:2`；归一到展示层之前不解释） */
  readonly key: string;
  /** 首次出现的行（1 基；抽取索引只保证首个） */
  readonly line?: number;
  /** 该函数内出现次数 */
  readonly count: number;
}

/** 变量反查索引：族头（大写）→ 该族的全部使用 */
export interface VarUsageIndex {
  readonly byFamily: ReadonlyMap<string, readonly VarUsageItem[]>;
  /** 建索引时摸过的函数总数（诊断显示用） */
  readonly functions: number;
}

const EMPTY_USAGE: VarUsageIndex = { byFamily: new Map(), functions: 0 };

/**
 * 从条件抽取索引反建「谁在用这个变量」。
 *
 * 状态键不解释、只按**第一个 `:` 前的族头**（大写归一）分桶——键的其余部分
 * （数字 / 具名 / 带角色维）保留原文，查询时逐条比对。一次全量遍历（千函数级）
 * 建好后按索引对象身份缓存（见激活层），查询本身是 Map 命中 + 行内过滤。
 */
export function buildVarUsageIndex(condIndex: ConditionIndex): VarUsageIndex {
  const byFamily = new Map<string, VarUsageItem[]>();
  let functions = 0;
  for (const [fn, cond] of condIndex.byFunction) {
    const deps = cond.dependencies;
    if (!deps || deps.length === 0) continue;
    functions++;
    for (const dep of deps) {
      const key = dep.key;
      const i = key.indexOf(':');
      const fam = (i < 0 ? key : key.slice(0, i)).toUpperCase();
      if (fam.length === 0) continue;
      let list = byFamily.get(fam);
      if (!list) {
        list = [];
        byFamily.set(fam, list);
      }
      const last = list[list.length - 1];
      if (last && last.fn === fn && last.key === key) {
        // 同函数同键相邻重复 → 合并计数（deps 天然按函数内出现序，去抖不重排）
        (last as { count: number }).count = last.count + Math.max(1, dep.count);
      } else {
        list.push({
          fn,
          key,
          ...(dep.firstLine !== undefined ? { line: dep.firstLine } : {}),
          count: Math.max(1, dep.count),
        });
      }
    }
  }
  return { byFamily, functions };
}

/** 反查结果：精确键命中 + 该族整体有多少处（键写法不同时作者能看清全貌） */
export interface VarUsageAnswer {
  readonly exact: readonly VarUsageItem[];
  readonly familyTotal: number;
}

/**
 * 查「`族:编号` 被谁用」：精确键（大小写归一）优先；键写法对不上（作者写具名、
 * 表里是数字等）时族级总数兜底展示——**显示为「整个族 N 处」，不冒充精确命中**。
 */
export function usagesOf(
  index: VarUsageIndex,
  family: string,
  value: number | string,
): VarUsageAnswer {
  const fam = family.toUpperCase();
  const list = index.byFamily.get(fam) ?? [];
  if (list.length === 0) return { exact: [], familyTotal: 0 };
  const target = `${fam}:${String(value)}`.toUpperCase();
  const exact = list.filter((u) => u.key.toUpperCase() === target);
  return { exact, familyTotal: list.length };
}

export function emptyVarUsageIndex(): VarUsageIndex {
  return EMPTY_USAGE;
}

/* ------------------------------ 反查引用（函数） ------------------------------ */

/** 函数引用点行（来自 ERB 反向索引） */
export interface FnUsageItem {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
}

/** 引用种类的中文显示（引擎层概念） */
export function refKindLabel(kind: string): string {
  switch (kind) {
    case 'definition':
      return '定义';
    case 'call':
      return '调用';
    default:
      return '出现';
  }
}

/* ------------------------------ 项目符号 ------------------------------ */

/** 口上包键：'' = 口上根散文件；库基座 / 索引外见 packs.ts */
export interface PackSummary {
  readonly key: string;
  readonly label: string;
  readonly functionCount: number;
  readonly fileCount: number;
}

/** 符号行（函数或 #DIM 声明） */
export interface SymbolRow {
  /** 函数名 / 声明名 */
  readonly name: string;
  readonly kind: 'fn' | 'dim';
  /** #DIM 声明指令（DIM / DIMS / DEFINE…；函数行缺省） */
  readonly directive?: string;
  readonly filePath: string;
  readonly line: number;
  /** 形参数（函数行） */
  readonly params?: number;
  /** docComment 首行（函数行；缺省 = 无注释） */
  readonly doc?: string;
  readonly inLibrary: boolean;
}

/** 索引总量读数（空态文案用；缺省 = 索引未就绪） */
export interface IndexStats {
  readonly files: number;
  readonly functions: number;
  readonly dims: number;
}

/** 搜索查询 → 符号行过滤（名字 / 注释 / 文件名；大小写折叠） */
export function filterSymbols(rows: readonly SymbolRow[], q: string): readonly SymbolRow[] {
  const n = norm(q);
  if (n.length === 0) return [...rows];
  return rows.filter((r) => {
    if (r.name.toLowerCase().includes(n)) return true;
    if (r.doc && r.doc.toLowerCase().includes(n)) return true;
    return r.filePath.toLowerCase().includes(n);
  });
}

/* ------------------------------ 指令表 ------------------------------ */

/** 指令行：编号 ↔ 中文名（adapter 的 KojoInstructionTable 枚举而来） */
export interface InstrRow {
  readonly no: number;
  readonly name: string;
}

export function filterInstr(rows: readonly InstrRow[], q: string): readonly InstrRow[] {
  if (norm(q).length === 0) return rows;
  return rows.filter((r) => queryMatches(q, [r.name, r.no]));
}

/** 中文名按展示序；查询命中后按编号稳定排序的开关交给调用方（保持枚举原序即可） */
export function buildInstrRows(
  names: readonly string[] | undefined,
  lookupByName: (name: string) => number | undefined,
): InstrRow[] {
  if (!names) return [];
  const out: InstrRow[] = [];
  for (const name of names) {
    const no = lookupByName(name);
    if (no === undefined) continue;
    out.push({ no, name });
  }
  return out;
}
