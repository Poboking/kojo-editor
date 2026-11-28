/**
 * 由 `tools/data/engine-profiles.yaml`（eratw `specs/engine-profiles.yaml` 快照）生成
 * `packages/plugins/erb-parser/src/instructions.ts` 的 `ERB_INSTRUCTION_NAMES` 数组体。
 *
 * 口径：**4.981（snake）的语句面**，不是 `emuera.em master` 的 `FunctionCode` 枚举。
 * 本仓复刻目标是 4.981；eraTW 4.981 语料实测有 13 个 snake-only 语句名在用（103 处），
 * 旧表按 em_ee 口径取，这些行在编辑器里被当成引擎不认识的词。
 *
 * 条件注册的两枚 `VARI` / `VARS`（`UseScopedVariableInstruction`）**不进无条件面**：
 * eraTW 的 `emuera.config` 没有该开关（默认关）；eraSQC 等游戏把 `VARS` 当私有变量名
 * 用且能正常加载，收进来就是假缺陷。参见 instructions.ts 的表头注释。
 *
 * 只重写数组体；表头 KDoc 是人工维护的设计取舍，生成器不碰。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = `${ROOT}tools/data/engine-profiles.yaml`;
const TARGET = `${ROOT}packages/plugins/erb-parser/src/instructions.ts`;
const CONDITIONAL_ONLY = new Set(['VARI', 'VARS']);

/** 只解析 `profiles.snake.commands` 的 `- NAME` 列表；与判据里的解析器同源。 */
function snakeCommands() {
  const text = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n?/g, '\n');
  let inProfiles = false;
  let inSnake = false;
  let inCommands = false;
  const out = [];
  for (const line of text.split('\n')) {
    if (/^profiles:/.test(line)) {
      inProfiles = true;
      continue;
    }
    if (!inProfiles) continue;
    if (/^\S/.test(line)) break;
    const p = /^  ([a-z_0-9]+):/.exec(line);
    if (p) {
      inSnake = p[1] === 'snake';
      inCommands = false;
      continue;
    }
    if (!inSnake) continue;
    const k = /^    ([a-z_]+):/.exec(line);
    if (k) {
      inCommands = k[1] === 'commands';
      continue;
    }
    if (!inCommands) continue;
    const item = /^      - (\S+)/.exec(line);
    if (item) out.push(item[1]);
    else if (/^    \S/.test(line)) inCommands = false;
  }
  return out;
}

const names = [...new Set(snakeCommands().filter((n) => !CONDITIONAL_ONLY.has(n)))].sort();
if (names.length !== 324) {
  throw new Error(`snake 无条件语句面应为 324 名，实取 ${names.length}——快照换代了，先复核再生成`);
}

const lines = [];
for (let i = 0; i < names.length; i += 8) {
  lines.push(`  ${names.slice(i, i + 8).map((n) => `'${n}'`).join(', ')},`);
}
const body = lines.join('\n');

const src = readFileSync(TARGET, 'utf8');
const head = 'export const ERB_INSTRUCTION_NAMES: readonly string[] = [\n';
const from = src.indexOf(head);
if (from < 0) throw new Error('找不到 ERB_INSTRUCTION_NAMES 数组起点——生成器失效，不许盲写');
const to = src.indexOf('\n];', from);
if (to < 0) throw new Error('找不到 ERB_INSTRUCTION_NAMES 数组终点——生成器失效，不许盲写');

writeFileSync(TARGET, `${src.slice(0, from + head.length)}${body}${src.slice(to)}`, 'utf8');
console.log(`ERB_INSTRUCTION_NAMES: ${names.length} 名（snake 326 − VARI/VARS 2）`);
