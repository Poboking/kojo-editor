/**
 * 由 `tools/data/IdentifierDictionary.4.981.cs` 生成 `plugin-api/src/erb.ts` 的
 * `@erb-event-labels` 区间。
 *
 * 真源 = 4.981 `IdentifierDictionary.cs::IsEventLabelName(string)` 的 switch 全体 `case`。
 * 这是**引擎语言层**事实（不是某个适配器的约定）：这些标签允许多处定义、
 * 全部注册、按 #ONLY/#PRI/普通/#LATER 四桶依次执行，故 duplicate-function 规则
 * 不能把它们当"重复定义缺陷"。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = `${ROOT}tools/data/IdentifierDictionary.4.981.cs`;
const TARGET = `${ROOT}packages/plugin-api/src/erb.ts`;
const BEGIN = '// @erb-event-labels:begin';
const END = '// @erb-event-labels:end';

const text = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n?/g, '\n');
const from = text.indexOf('bool IsEventLabelName(string labelName)');
if (from < 0) throw new Error('快照里找不到 IsEventLabelName——真源换代了，先复核再生成');
const to = text.indexOf('public static bool', from);
if (to < 0) throw new Error('找不到 IsEventLabelName 方法结尾——生成器失效，不许盲写');
const names = [...new Set(
  [...text.slice(from, to).matchAll(/case\s+"([A-Z_0-9]+)"\s*:/g)].map((m) => m[1]),
)].sort();
if (names.length !== 11) {
  throw new Error(`4.981 事件标签应为 11 枚，实取 ${names.length}——快照换代了，先复核再生成`);
}

const body = `${BEGIN}
/**
 * 引擎事件标签名 —— **生成区间，勿手改**；由 \`node tools/gen-erb-event-labels.mjs\` 重生成。
 *
 * 真源：4.981 \`IdentifierDictionary.cs::IsEventLabelName\` 的 switch 全体 case
 * （快照 \`tools/data/IdentifierDictionary.4.981.cs\`，EOL 归一化 sha256 \`ab05d95d…\`）。
 * 引擎对这批标签**允许多处定义且全部执行**（#ONLY → #PRI → 普通 → #LATER 四桶），
 * 非事件函数才是后装载者生效（\`SortLabel\` 直接赋值；\`SortLabels\` 是死代码）。
 * 故 \`erb.duplicate-function\` 按本集合豁免事件族，逐条提示只会制造假问题。
 */
export const ERB_EVENT_LABEL_NAMES: readonly string[] = [
${names.map((n) => `  "${n}",`).join('\n')}
];

const ERB_EVENT_LABEL_NAME_SET: ReadonlySet<string> = new Set(ERB_EVENT_LABEL_NAMES);

/** 大小写不敏感（eraTW \`emuera.config\` 首行 \`IGNORE CASE:YES\`）。 */
export function isErbEventLabelName(name: string): boolean {
  return ERB_EVENT_LABEL_NAME_SET.has(name.trim().toUpperCase());
}
${END}`;

const src = readFileSync(TARGET, 'utf8');
const a = src.indexOf(BEGIN);
const b = src.indexOf(END);
if (a < 0 || b < 0 || b < a) throw new Error('erb.ts 里找不到事件标签生成区间的两个标记');
writeFileSync(TARGET, `${src.slice(0, a)}${body}${src.slice(b + END.length)}`, 'utf8');
console.log(`ERB_EVENT_LABEL_NAMES: ${names.length} 枚（4.981 IsEventLabelName）`);
