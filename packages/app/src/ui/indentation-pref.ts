/**
 * 状态栏「缩进」格的偏好与判据（批次十 S1）：零 React 纯逻辑，可单测。
 *
 * 存法照 `language-mode-pref.ts` 同批先例——localStorage 真源 + JSON 一张
 * 「路径 → 档位」表。**按文件**存：同一项目里 `.json` 习惯 2 空格、ERB 习惯 Tab，
 * 一份文件的取舍不该拖累另一份。
 *
 * ## 档位
 *
 * `Tab`（`insertSpaces: false`，制表宽 4）与 `Spaces:2/4/8`（`insertSpaces: true`）。
 * 点击缩进格按这个顺序循环。键缺席 = `Tab`（ERB 语料的多数派，也是 Monaco 缺省面）。
 *
 * 生效路径只有一条：`model.updateOptions({ insertSpaces, tabSize })`——本模块只给
 * 结构化最小接口，node 里用假 model 即可钉死，不引 Monaco。
 */
import { pathKey } from '@kojo/plugin-api';

/** 偏好键（壳层私事，localStorage） */
export const INDENT_PREF_KEY = 'kojo.indentation.v1';

/** 四档（顺序 = 点击循环顺序） */
export const INDENT_CHOICES = ['tab', 2, 4, 8] as const;

export type IndentChoice = (typeof INDENT_CHOICES)[number];

/** 缺省 = Tab（见模块头） */
export const INDENT_DEFAULT: IndentChoice = 'tab';

/** Monaco 的缩进选项（`updateOptions` 吃这两格；本模块只给结构化最小面） */
export interface IndentOptions {
  insertSpaces: boolean;
  tabSize: number;
}

/** 缩进生效目标的最小接口（真身 = `ITextModel`，结构上满足它） */
export interface IndentTarget {
  getOptions(): IndentOptions;
  updateOptions(options: IndentOptions): void;
}

/** 档位 → Monaco 选项（Tab 的制表宽固定 4，与编辑器缺省一致） */
export function indentOptions(choice: IndentChoice): IndentOptions {
  return choice === 'tab' ? { insertSpaces: false, tabSize: 4 } : { insertSpaces: true, tabSize: choice };
}

/** 状态栏文案：`Tab` / `Spaces:2` … */
export function indentLabel(choice: IndentChoice): string {
  return choice === 'tab' ? 'Tab' : `Spaces:${choice}`;
}

/** 点击循环：Tab → 2 → 4 → 8 → Tab */
export function nextIndentChoice(choice: IndentChoice): IndentChoice {
  const index = INDENT_CHOICES.indexOf(choice);
  return INDENT_CHOICES[(index + 1) % INDENT_CHOICES.length] ?? INDENT_DEFAULT;
}

/**
 * 从 model 的现取选项反推档位；认不出的（如 `tabSize: 3`、外部插件改过）⇒ 返回 `null`，
 * 由调用方按**原始读数**显示（`Spaces:3`），不冒充成一档。
 */
export function indentChoiceFromOptions(options: IndentOptions): IndentChoice | null {
  if (!options.insertSpaces) return 'tab';
  const match = INDENT_CHOICES.find((choice) => choice === options.tabSize);
  return match ?? null;
}

/** 读数文案（认不出的档位如实显示 `Spaces:N`） */
export function indentLabelFromOptions(options: IndentOptions): string {
  const choice = indentChoiceFromOptions(options);
  return choice !== null ? indentLabel(choice) : `Spaces:${options.tabSize}`;
}

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 档位存储值：数字档存字符串形式，读回时严格校验 */
function parseChoice(raw: unknown): IndentChoice | null {
  if (raw === 'tab') return 'tab';
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return n === 2 || n === 4 || n === 8 ? (n as IndentChoice) : null;
}

/** 读整张表（键缺席 / JSON 脏 ⇒ 空表，绝不抛） */
function readTable(): Record<string, IndentChoice> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(INDENT_PREF_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const table: Record<string, IndentChoice> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const choice = parseChoice(value);
      if (choice !== null) table[key] = choice;
    }
    return table;
  } catch {
    return {};
  }
}

/** 写整张表；空表 = 清键 */
function writeTable(table: Record<string, IndentChoice>): void {
  const s = storage();
  if (!s) return;
  try {
    if (Object.keys(table).length === 0) s.removeItem(INDENT_PREF_KEY);
    else s.setItem(INDENT_PREF_KEY, JSON.stringify(table));
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话按默认走" */
  }
}

/** 这份文件明确存过的档位；没存过 ⇒ `null`（重开恢复判据：只有存过才覆盖 model 缺省） */
export function storedIndentChoiceFor(filePath: string): IndentChoice | null {
  if (filePath === '') return null;
  return readTable()[pathKey(filePath)] ?? null;
}

/** 这份文件该用的档位（没存过 ⇒ Tab 缺省） */
export function indentPrefFor(filePath: string): IndentChoice {
  return storedIndentChoiceFor(filePath) ?? INDENT_DEFAULT;
}

/** 记下这份文件的档位（空路径不写） */
export function setIndentPref(filePath: string, choice: IndentChoice): void {
  if (filePath === '') return;
  const table = readTable();
  table[pathKey(filePath)] = choice;
  writeTable(table);
}

/** 生效的唯一入口：`model.updateOptions`（model 缺席 = 只写偏好，等文件真打开再套） */
export function applyIndentPref(target: IndentTarget | null | undefined, choice: IndentChoice): void {
  if (!target) return;
  target.updateOptions(indentOptions(choice));
}
