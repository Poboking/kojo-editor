/**
 * 状态栏「语言模式」格的偏好与判据（批次十 S1）：零 React 纯逻辑，可单测。
 *
 * 存法照 `format-pref.ts` / `motion-pref.ts` 先例——localStorage 真源 + JSON 一张
 * 「路径 → 语言 id」表，**不新造第二套偏好机制**。
 *
 * ## 语义
 *
 * - 语言模式是**按文件**的：同一个项目里 `.erb` 与 `.json` 各挂各的脸，作者手动改过
 *   某一份（比如把 `.txt` 口上临时当 ERB 看），只该影响那一份；
 * - 键缺席 = 没手动改过 ⇒ 由扩展名判据（`monaco/languages.ts` 的 descriptor 表）决定；
 *   本模块不猜扩展名，只回答"有没有人明确选过"；
 * - 路径按 `pathKey` 归一（大小写 / 分隔符），Windows 下同一份文件不会存成两条。
 */
import { pathKey } from '@kojo/plugin-api';

/** 偏好键（壳层私事，localStorage；与布局同款——不进内核存储域） */
export const LANGUAGE_MODE_PREF_KEY = 'kojo.languageMode.v1';

/**
 * 菜单的四档固定项（任务口径：erb / kojo2 / json / plaintext）。
 *
 * 真源仍是 `monaco/language-registry.ts` 的 descriptor 表——这里只是**保证这四档在
 * 菜单里恒可点**（注册面在单测里为空、或 kojo2 开关关着时也不至于只剩一项）；
 * 注册面多出来的语言（如 v1 的 `kojo-sugar`）由 {@link languageModeChoices} 追加在后面。
 */
export const LANGUAGE_MODE_BASE_CHOICES = ['kojo-erb', 'kojo2', 'json', 'plaintext'] as const;

/**
 * 菜单项 = 四档固定项 ∪ 注册面登记的全部 id（去重，注册面的追加项排在后面）。
 *
 * 顺序稳定：固定项在前（作者最常用的四档），其余按注册顺序追加；不做字母排序，
 * 免得插件化新增语言时菜单顺序每次启动都漂。
 */
export function languageModeChoices(registeredIds: readonly string[]): string[] {
  const choices: string[] = [...LANGUAGE_MODE_BASE_CHOICES];
  for (const id of registeredIds) {
    if (id !== '' && !choices.includes(id)) choices.push(id);
  }
  return choices;
}

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响读数） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读整张表（键缺席 / JSON 脏 / 不是对象 ⇒ 空表，绝不抛） */
function readTable(): Record<string, string> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(LANGUAGE_MODE_PREF_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const table: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 只信非空字符串：脏值当"没存过"，回落到扩展名判据
      if (typeof value === 'string' && value !== '') table[key] = value;
    }
    return table;
  } catch {
    return {};
  }
}

/** 写整张表；空表 = 清键（存储里不留"空对象"的第二种写法） */
function writeTable(table: Record<string, string>): void {
  const s = storage();
  if (!s) return;
  try {
    if (Object.keys(table).length === 0) s.removeItem(LANGUAGE_MODE_PREF_KEY);
    else s.setItem(LANGUAGE_MODE_PREF_KEY, JSON.stringify(table));
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话不恢复" */
  }
}

/** 这份文件被明确指定过的语言 id；没指定过 ⇒ `null`（调用方回落到扩展名判据） */
export function languageOverrideFor(filePath: string): string | null {
  if (filePath === '') return null;
  return readTable()[pathKey(filePath)] ?? null;
}

/** 记下这份文件的语言选择（空路径不写：没有可归属的键） */
export function setLanguageOverride(filePath: string, languageId: string): void {
  if (filePath === '' || languageId === '') return;
  const table = readTable();
  table[pathKey(filePath)] = languageId;
  writeTable(table);
  notifyOverride(filePath, languageId);
}

/** 撤销这份文件的语言选择（回到扩展名判据） */
export function clearLanguageOverride(filePath: string): void {
  if (filePath === '') return;
  const table = readTable();
  delete table[pathKey(filePath)];
  writeTable(table);
  notifyOverride(filePath, null);
}

/* ============================== 单一判据与变更广播（LANG-OVERRIDE-MODEL） ============================== */

/**
 * 建 model / 状态栏读数**共用**的语言判据：手工覆盖 > `descriptorLanguage`。
 *
 * `descriptorLanguage` 由调用方给（真源分别是 `languageIdForKojo2Model` 与 descriptor 表 +
 * `FALLBACK_LANGUAGE_ID`）——两处各自的"描述符那一格"本来就有自己的兜底，本函数只管
 * **优先级**：作者明确选过就听作者的，没选过原样交回。判据只有这一份：模型池建 model、
 * 2.0 重挂、状态栏读数与恢复 effect 都走它，调用点不许再写一套 `override ?? descriptor`。
 */
export function resolveModelLanguage(filePath: string, descriptorLanguage: string): string {
  return languageOverrideFor(filePath) ?? descriptorLanguage;
}

/** 覆盖变更的监听面（`languageId === null` = 撤销，回到 descriptor 判据） */
export type LanguageOverrideListener = (filePath: string, languageId: string | null) => void;

const overrideListeners = new Set<LanguageOverrideListener>();

/**
 * 订阅覆盖变更（返回退订）。
 *
 * 状态栏那一格只负责**写偏好**；已存在 model 的跟随由装配层（模型池）订阅这里完成——
 * 本模块是纯偏好层，只回答"谁被改成了什么"，不反向认识模型池。广播同步发出（写完后
 * 立即），状态栏不必等下一次 React 渲染。
 */
export function subscribeLanguageOverride(listener: LanguageOverrideListener): () => void {
  overrideListeners.add(listener);
  return () => {
    overrideListeners.delete(listener);
  };
}

function notifyOverride(filePath: string, languageId: string | null): void {
  for (const listener of [...overrideListeners]) listener(filePath, languageId);
}
