/**
 * 由 `tools/data/isa.yaml`（eratw `specs/isa.yaml` 快照）生成
 * `plugin-api/src/erb.ts` 的 `@erb-instruction-specs` 区间。
 *
 * 真源锚在 1.824 `FunctionIdentifier.cs` / `Process.cs`：177 条指令 × 69 种 arg_form、
 * 266 个注册别名、64 条带 errors。这些 prose 形态不做二次猜测——原样带 source 行号进契约，
 * 消费方（ERB 语句悬停）只做“有则追加”的展示，不拿它猜实参个数。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = `${ROOT}tools/data/isa.yaml`;
const TARGET = `${ROOT}packages/plugin-api/src/erb.ts`;
const DIRECTIVES = `${ROOT}packages/plugins/erb-parser/src/instructions.ts`;
const BEGIN = '// @erb-instruction-specs:begin';
const END = '// @erb-instruction-specs:end';
const FIELDS = ['kind', 'arg_form', 'semantics', 'errors', 'display_effect', 'source', 'aliases', 'register', 'confidence', 'flag', 'flag_source'];

/** 单行 YAML 标量：`''` 表示空串；外层单引号解包，`''` 转义还原为 `'`；其余原样。 */
function scalar(v) {
  const s = v.trim();
  if (s === "''" || s === '""') return '';
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * 只把**语句悬停真能到达的**那一份 ISA 条目搬进生产表。
 * `resolveErbMarkHover` 的行首分支只认 `ERB_STATEMENT_DIRECTIVES`（165 词），
 * 其余 105 条 ISA 规约留在快照里供审计——插件-api 在 PS-10 开机图内，
 * 整表 65 KB 会撞 ≤3,430 KB 闸；这里按可达面取 72 条（≈25 KB）。
 */
const directivesSrc = readFileSync(DIRECTIVES, 'utf8');
const dFrom = directivesSrc.indexOf('export const ERB_STATEMENT_DIRECTIVES');
const dBody = directivesSrc.slice(dFrom, directivesSrc.indexOf('];', dFrom));
const directiveSet = new Set((dBody.match(/'[A-Z_0-9]+'/g) ?? []).map((s) => s.slice(1, -1)));

const text = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n?/g, '\n');
const allEntries = [];
let cur = null;
for (const line of text.split('\n')) {
  const start = /^- name: (.+)$/.exec(line);
  if (start) {
    if (cur) allEntries.push(cur);
    cur = { name: scalar(start[1]) };
    continue;
  }
  if (cur === null) continue;
  const kv = /^  ([a-z_]+): (.*)$/.exec(line);
  if (kv && FIELDS.includes(kv[1])) cur[kv[1]] = scalar(kv[2]);
}
if (cur) allEntries.push(cur);

if (allEntries.length !== 177) {
  throw new Error(`ISA 指令应为 177 条，实取 ${allEntries.length}——快照换代了，先复核再生成`);
}
const aliasTotal = allEntries.reduce((n, e) => n + (e.aliases ? e.aliases.split(',').length : 0), 0);
if (aliasTotal !== 266) {
  throw new Error(`ISA 注册别名应为 266 枚，实取 ${aliasTotal}——快照换代了，先复核再生成`);
}

const entries = allEntries.filter((e) =>
  [e.name, ...(e.aliases ? e.aliases.split(',') : [])].some((n) => directiveSet.has(n.trim().toUpperCase())),
);
if (entries.length !== 72) {
  throw new Error(`ISA 悬停可达面应为 72 条，实取 ${entries.length}——语句词表或 ISA 换代了，先复核再生成`);
}

const q = (s) => JSON.stringify(s);
const rows = entries.map((e) => {
  const aliases = e.aliases ? e.aliases.split(',').map((a) => q(a.trim())).join(', ') : '';
  return [
    `  { name: ${q(e.name)}, kind: ${q(e.kind)}, argForm: ${q(e.arg_form ?? '')},`,
    `    semantics: ${q(e.semantics ?? '')}, errors: ${q(e.errors ?? '')},`,
    `    source: ${q(e.source ?? '')}, aliases: [${aliases}], confidence: ${q(e.confidence ?? '')} },`,
  ].join('\n');
}).join('\n');

const body = `${BEGIN}
/**
 * ERB 语句 ISA 规约 —— **生成区间，勿手改**；由 \`node tools/gen-erb-instruction-specs.mjs\` 重生成。
 *
 * 真源：eratw \`specs/isa.yaml\`（快照 \`tools/data/isa.yaml\`，EOL 归一化 sha256
 * \`71817091…\`），逐条锚 1.824 \`FunctionIdentifier.cs\` / \`Process.cs\`：
 * 全量 177 指令 / 69 种 arg_form / 266 个注册别名 / 64 条带 errors。
 *
 * **本区间只带悬停可达的那 72 条**（条目名或别名命中 \`ERB_STATEMENT_DIRECTIVES\`）。
 * 全量留在快照里供审计；plugin-api 在 PS-10 开机图内，整表 65 KB 会撞 ≤3,430 KB 闸。
 * 生成时按可达面取子集，判据双向对拍：可达面不漏、不可达面不收。
 *
 * \`argForm\` / \`semantics\` / \`errors\` 是**引擎原话**（中文 prose，带行锚），
 * 消费方只做“有则追加”的展示，不拿它猜实参个数——形态到可判定判据的转换必须有 C# 锚。
 */
export interface ErbInstructionSpec {
  readonly name: string;
  readonly kind: string;
  readonly argForm: string;
  readonly semantics: string;
  readonly errors: string;
  readonly source: string;
  readonly aliases: readonly string[];
  readonly confidence: string;
}

export const ERB_INSTRUCTION_SPECS: readonly ErbInstructionSpec[] = [
${rows}
];

const ERB_INSTRUCTION_SPEC_BY_NAME: ReadonlyMap<string, ErbInstructionSpec> = new Map(
  ERB_INSTRUCTION_SPECS.flatMap((spec) => [spec.name, ...spec.aliases].map((n) => [n.toUpperCase(), spec] as const)),
);

/** 按条目名或任一注册别名查（大小写不敏感）；查不到 = 不猜。 */
export function erbInstructionSpecOf(name: string): ErbInstructionSpec | undefined {
  return ERB_INSTRUCTION_SPEC_BY_NAME.get(name.trim().toUpperCase());
}
${END}`;

const src = readFileSync(TARGET, 'utf8');
const a = src.indexOf(BEGIN);
const b = src.indexOf(END);
if (a < 0 || b < 0 || b < a) throw new Error('erb.ts 里找不到 ISA 生成区间的两个标记');
writeFileSync(TARGET, `${src.slice(0, a)}${body}${src.slice(b + END.length)}`, 'utf8');
console.log(`ERB_INSTRUCTION_SPECS: ${entries.length} 条（悬停可达面；全量 ${allEntries.length} 条 / ${aliasTotal} 别名留在快照）`);
