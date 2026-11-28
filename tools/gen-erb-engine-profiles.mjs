#!/usr/bin/env node
/**
 * 从 `tools/data/engine-profiles.yaml`（eratw specs/engine-profiles.yaml 快照）生成
 * `packages/plugin-api/src/erb-engine-profiles.ts`——四档引擎面 + 条件注册 + dialect 行为开关。
 *
 * 解析三段：profiles（functions/commands + honke_1824 注记）、registration
 * （无条件数 / 条件注册 / 语句面推导）、dialect（行为开关逐档取值 + C# 锚 + 差分凭据）。
 *
 * 自证闸（不匹配即拒产）：每档 commands 数 = 无条件 + 条件；语句面并集大小 =
 * registration.statements.count；恰 4 个数据档 + 1 个 honke 注记；恰 4 个 dialect 开关。
 * 产物不进 PS-10 开机图（plugin-api/index.ts 不转出，消费方走深路径 import）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = `${ROOT}tools/data/engine-profiles.yaml`;
const TARGET = `${ROOT}packages/plugin-api/src/erb-engine-profiles.ts`;

const raw = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n?/g, '\n');
const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
const lines = raw.split('\n');

function sectionRange(name) {
  const start = lines.findIndex((l) => l === `${name}:`);
  if (start < 0) throw new Error(`快照缺段 ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [start + 1, end];
}
const unq = (s) => {
  const t = s.trim();
  const m = /^'(.*)'$/.exec(t);
  return m ? m[1].replace(/''/g, "'") : t;
};
const scalar = (v) => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : unq(v));

/* ---- profiles ---- */
const [ps, pe] = sectionRange('profiles');
const profilesRaw = [];
let cur = null;
let key = null;
for (let i = ps; i < pe; i++) {
  const ln = lines[i];
  const pm = /^  ([a-z_0-9]+):$/.exec(ln);
  if (pm) {
    if (cur) profilesRaw.push(cur);
    cur = { id: pm[1], functions: [], commands: [], scalars: {} };
    key = null;
    continue;
  }
  if (!cur) continue;
  const km = /^    ([a-z_]+):$/.exec(ln);
  if (km) {
    key = km[1];
    continue;
  }
  const kv = /^    ([a-z_]+): (.+)$/.exec(ln);
  if (kv && !key) {
    cur.scalars[kv[1]] = unq(kv[2]);
    continue;
  }
  const im = /^      - ([A-Za-z_0-9]+)$/.exec(ln);
  if (im && (key === 'functions' || key === 'commands')) cur[key].push(im[1]);
}
if (cur) profilesRaw.push(cur);

const honke = profilesRaw.find((p) => p.functions.length === 0 && p.commands.length === 0);
const dataProfiles = profilesRaw.filter((p) => p.functions.length > 0 || p.commands.length > 0);
if (!honke || !honke.scalars.note) throw new Error('honke_1824 注记缺失');
if (dataProfiles.length !== 4) throw new Error(`应有 4 个数据档，实取 ${dataProfiles.length}`);

/* ---- registration ---- */
const [rs, re] = sectionRange('registration');
const regs = {};
let rid = null;
for (let i = rs; i < re; i++) {
  const ln = lines[i];
  const pm = /^  ([a-z_0-9]+):$/.exec(ln);
  if (pm) {
    rid = pm[1];
    regs[rid] = { unconditional: 0, conditional: {}, statements: {} };
    continue;
  }
  if (!rid) continue;
  let m = /^    commands_unconditional: (\d+)$/.exec(ln);
  if (m) {
    regs[rid].unconditional = Number(m[1]);
    continue;
  }
  m = /^      (derivation|anchor): (.+)$/.exec(ln);
  if (m) {
    regs[rid].statements[m[1]] = unq(m[2]);
    continue;
  }
  m = /^      count: (\d+)$/.exec(ln);
  if (m) {
    regs[rid].statements.count = Number(m[1]);
    continue;
  }
  m = /^      ([A-Z_0-9]+): (.+)$/.exec(ln);
  if (m) {
    regs[rid].conditional[m[1]] = unq(m[2]);
    continue;
  }
}

/* ---- dialect ---- */
const [ds, de] = sectionRange('dialect');
const switches = [];
let curSw = null;
let skey = null;
let subkey = null;
for (let i = ds; i < de; i++) {
  const ln = lines[i];
  const pm = /^  ([a-z_0-9]+):$/.exec(ln);
  if (pm) {
    if (curSw) switches.push(curSw);
    curSw = { id: pm[1], description: '', values: {}, anchors: {}, evidence: '', keywords: null };
    skey = null;
    subkey = null;
    continue;
  }
  if (!curSw) continue;
  const km = /^    ([a-z_]+):$/.exec(ln);
  if (km) {
    skey = km[1];
    subkey = null;
    continue;
  }
  const kv = /^    (description|evidence): (.+)$/.exec(ln);
  if (kv) {
    curSw[kv[1]] = unq(kv[2]);
    skey = null;
    continue;
  }
  const vm = /^      ([a-z_0-9]+): (.+)$/.exec(ln);
  if (vm && (skey === 'values' || skey === 'anchors')) {
    curSw[skey][vm[1]] = scalar(vm[2]);
    continue;
  }
  if (vm && skey === 'keywords') {
    subkey = vm[1];
    if (curSw.keywords === null) curSw.keywords = {};
    curSw.keywords[subkey] = [];
    continue;
  }
  const im = /^        - (.+)$/.exec(ln);
  if (im && skey === 'keywords' && subkey) {
    curSw.keywords[subkey].push(unq(im[1]));
    continue;
  }
}
if (curSw) switches.push(curSw);

/* ---- 自证闸 ---- */
for (const p of dataProfiles) {
  const r = regs[p.id];
  if (!r || !r.statements.count || !r.statements.derivation || !r.statements.anchor) {
    throw new Error(`registration 数据不全：${p.id}`);
  }
  const expectCmds = r.unconditional + Object.keys(r.conditional).length;
  if (p.commands.length !== expectCmds) {
    throw new Error(`${p.id} commands ${p.commands.length} ≠ 无条件 ${r.unconditional} + 条件 ${Object.keys(r.conditional).length}`);
  }
  const unionSize = new Set([...p.functions, ...p.commands]).size;
  if (unionSize !== r.statements.count) {
    throw new Error(`${p.id} 并集 ${unionSize} ≠ statements.count ${r.statements.count}`);
  }
}
if (switches.length !== 4) throw new Error(`应有 4 个 dialect 开关，实取 ${switches.length}`);
for (const sw of switches) {
  for (const id of dataProfiles.map((p) => p.id)) {
    if (!(id in sw.values) || !(id in sw.anchors)) throw new Error(`开关 ${sw.id} 缺档 ${id}`);
    if (!/\.cs:\d/.test(sw.anchors[id])) throw new Error(`开关 ${sw.id} @ ${id} 锚不带行号`);
  }
}

/* ---- 产出 ---- */
const q = (s) => JSON.stringify(s);
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const nameList = (names) => `[\n${names.slice().sort().map((n) => `      ${q(n)},`).join('\n')}\n    ]`;

const profileBlocks = dataProfiles
  .slice()
  .sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((p) => {
    const r = regs[p.id];
    const condKeys = Object.keys(r.conditional).sort();
    const cond = condKeys.length
      ? `{\n${condKeys.map((k) => `      ${k}: ${q(r.conditional[k])},`).join('\n')}\n    }`
      : '{}';
    return [
      '  {',
      `    id: ${q(p.id)},`,
      `    functions: ${nameList(p.functions)},`,
      `    commands: ${nameList(p.commands)},`,
      '    conditionalCommands: ' + cond + ',',
      '    statements: {',
      `      count: ${r.statements.count},`,
      `      derivation: ${q(r.statements.derivation)},`,
      `      anchor: ${q(r.statements.anchor)},`,
      '    },',
      '  },',
    ].join('\n');
  })
  .join('\n');

const switchBlocks = switches
  .slice()
  .sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((sw) => {
    const values = sortKeys(sw.values);
    const anchors = sortKeys(sw.anchors);
    const rec = (o) =>
      `{\n${Object.keys(o).map((k) => `      ${k}: ${q(o[k])},`).join('\n')}\n    }`;
    const kw = sw.keywords
      ? `{\n      routed: [${sw.keywords.routed.map(q).join(', ')}],\n      gated: [${sw.keywords.gated.map(q).join(', ')}],\n    }`
      : null;
    return [
      '  {',
      `    id: ${q(sw.id)},`,
      `    description: ${q(sw.description)},`,
      `    values: ${rec(values)},`,
      `    anchors: ${rec(anchors)},`,
      sw.evidence ? `    evidence: ${q(sw.evidence)},` : null,
      kw ? `    keywords: ${kw},` : null,
      '  },',
    ].filter(Boolean).join('\n');
  })
  .join('\n');

const out = `/* 本文件由 tools/gen-erb-engine-profiles.mjs 生成——勿手改；再生成：node tools/gen-erb-engine-profiles.mjs */
/**
 * ERB 引擎分档数据契约——四档引擎的「这个名字/这种写法在这台引擎上存不存在、行不行为一致」真值。
 *
 * ## 出处（可复现）
 *
 * 真源 eratw \`specs/engine-profiles.yaml\` 快照 \`tools/data/engine-profiles.yaml\`
 * （sha256 EOL 归一 = \`ERB_ENGINE_PROFILES_SHA256\`），生成器 \`tools/gen-erb-engine-profiles.mjs\`。
 * 源头由 eratw devtools/gen_engine_profiles.py 从四棵引擎树的注册代码抽取，并经 Roslyn
 * 语法树独立逐名复核（yaml meta.extraction_method）；函数面 = FunctionMethodCreator 的
 * methodList 初始化器，指令面 = FunctionIdentifier 的 addFunction 家族（带 if 条件记录）。
 *
 * ## 四档
 *
 * | id | 引擎 | 说明 |
 * | --- | --- | --- |
 * | \`snake\` | eratw 4.981（SkiaSharp） | 本项目复刻目标；eraTW 玩家在跑的引擎 |
 * | \`em_ee\` | emuera.em master | EM+EE 系（eraFL 等多数新 era 游戏） |
 * | \`v24\` | Emuera1824+v24 | 1.824 系修 bug fork；honke_1824 无树时的最近代理 |
 * | \`cs_reference\` | emuera-cs 反编译 | EM+EE 系参照，**非目标引擎** |
 *
 * \`honke_1824\`（原版 1.824）本地无树，只留注记 \`ERB_ENGINE_PROFILE_HONKE_1824_NOTE\`。
 *
 * ## dialect 行为开关（跨档 bug 差异）
 *
 * 最有名的一支：\`string_compare_ge_le\`——1.824 系把字符串 \`>=\`/\`<=\` 都编译成 \`(c<0)\`
 * （v24/cs_reference = bug，em_ee/snake = fixed），逐档带 C# 行锚；差分实验凭据在
 * \`evidence\`。未来「跨档语义警告」从这里取真值，不猜。
 *
 * ## 用法与约束
 *
 * 本文件**不进 PS-10 开机图**（\`index.ts\` 不转出；消费方走深路径 import，运行时用
 * \`await import()\` 动态装载）。判据两道：
 * \`packages/plugin-api/tests/erb-engine-profiles.test.ts\`（契约对拍）、
 * \`packages/app/tests/engine-profile-locks.test.ts\`（适配器锁档与差集钉死）。
 */

/** 四档引擎能力档位，见文件头。 */
export interface ErbEngineProfile {
  readonly id: string;
  /** 表达式函数面（methodList 初始化器逐条） */
  readonly functions: readonly string[];
  /** 指令注册面（addFunction 家族；含条件注册项） */
  readonly commands: readonly string[];
  /** 条件注册指令 → 引擎开关（如 VARI/VARS ↔ JSONConfig.Data.UseScopedVariableInstruction） */
  readonly conditionalCommands: Readonly<Record<string, string>>;
  /** 语句面 = commands ∪ functions（METHOD fallback 回填每个表达式函数为语句） */
  readonly statements: {
    readonly count: number;
    readonly derivation: string;
    readonly anchor: string;
  };
}

/** 跨档行为开关（bug 差异），见文件头。 */
export interface ErbEngineDialectSwitch {
  readonly id: string;
  readonly description: string;
  /** 档位 id → 行为取值（'bug' / 'fixed' / true / false） */
  readonly values: Readonly<Record<string, string | boolean>>;
  /** 档位 id → C# 行锚 */
  readonly anchors: Readonly<Record<string, string>>;
  /** 差分实验凭据（有实跑证据的开关才有） */
  readonly evidence?: string;
  /** GETNUM 类开关的路由细节（routed = 恒路由键；gated = 按档开关键） */
  readonly keywords?: Readonly<Record<'routed' | 'gated', readonly string[]>>;
}

export const ERB_ENGINE_PROFILES_SHA256 = ${q(sha)};

/** 原版 1.824（honke）本地无树，不要拿 v24 冒充 honke（yaml 原注）。 */
export const ERB_ENGINE_PROFILE_HONKE_1824_NOTE = ${q(honke.scalars.note)};

export const ERB_ENGINE_PROFILES: readonly ErbEngineProfile[] = [
${profileBlocks}
];

export const ERB_ENGINE_DIALECT_SWITCHES: readonly ErbEngineDialectSwitch[] = [
${switchBlocks}
];

/** 语句面并集（commands ∪ functions，字典序）；未知 id 抛错。 */
export function erbEngineStatementFace(id: string): readonly string[] {
  const p = ERB_ENGINE_PROFILES.find((x) => x.id === id);
  if (p === undefined) {
    throw new Error(\`未知引擎档：\${id}（已知：\${ERB_ENGINE_PROFILES.map((x) => x.id).join(', ')}）\`);
  }
  return [...new Set([...p.commands, ...p.functions])].sort();
}
`;

writeFileSync(TARGET, out.endsWith('\n') ? out : `${out}\n`, 'utf8');
console.log(
  `ERB_ENGINE_PROFILES: ${dataProfiles.length} 档 / ${dataProfiles.reduce((n, p) => n + p.functions.length + p.commands.length, 0)} 名 / ${switches.length} 开关 / sha ${sha.slice(0, 8)}…`,
);
