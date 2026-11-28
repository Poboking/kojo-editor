/**
 * 引擎指令名表（`instructions.ts::ERB_INSTRUCTION_NAMES`）的**真源对拍**闸。
 *
 * 背景：kojo 的 301 名取自 `emuera.em master` 的 `FunctionCode` 枚举，而本仓明确复刻
 * **4.981（蛇版）**。两份面不一致：snake 的 `commands` 有 326 名（324 无条件 +
 * `VARI`/`VARS` 由 `UseScopedVariableInstruction` 条件注册），kojo 少了 23 个无条件名。
 * eraTW 4.981 真语料实测其中 13 名在用（103 处），这些行在编辑器里今天被当成
 * 「引擎不认识的词」——`#DIM` 撞名检查、写指令短表、补全都收不到。
 *
 * 本闸钉四件事：
 * 1. 快照 sha（EOL 归一化，git autocrlf 不许造成假红）；
 * 2. 生产表 == snake 无条件 commands（双向差集为空：新增不漏、假名不收）；
 * 3. 语料实证的 13 名逐条在位，且条件注册的 VARI/VARS 仍不在位；
 * 4. 规模 / 排序 / 判函数 `isInstructionName` 的大小写口径。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERB_INSTRUCTION_NAMES, isInstructionName } from '../src/instructions';

const SNAPSHOT_URL = new URL('../../../../tools/data/engine-profiles.yaml', import.meta.url);
const SNAPSHOT_SHA256 = 'd9f0e0255c4091c3a96fced3c87085d3671797f11fa61d118808eab585fe885c';

/** 只解析 `profiles.snake.commands` 的 `- NAME` 列表；不引入 yaml 依赖，口径与生成器同源。 */
function snakeCommands(): string[] {
  const text = readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8').replace(/\r\n?/g, '\n');
  let inProfiles = false;
  let inSnake = false;
  let inCommands = false;
  const out: string[] = [];
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
    if (item) out.push(item[1]!);
    else if (/^    \S/.test(line)) inCommands = false;
  }
  return out;
}

/** 游戏 `emuera.config` 没有 `USESCOPEDVARIABLEINSTRUCTION`，默认关 ⇒ 不进无条件面。 */
const CONDITIONAL_ONLY = ['VARI', 'VARS'];

/** eraTW 4.981 语料实测在用（13 名 / 103 处），按命中数降序。 */
const CORPUS_OBSERVED = [
  'SETANIMETIMER', 'SETIMAGELAYERL', 'CALLSTR', 'TINPUTSNF', 'BITMAP_CACHE_ENABLE',
  'TRYCALLSTR', 'HTML_PRINTC', 'TEXT_BGC_ON', 'HTML_PRINTLC', 'TRYCCALLSTR',
  'TINPUTNF', 'TEXT_BGC_OFF', 'SETIMAGELAYER',
];

describe('ERB 引擎指令名表 ↔ 4.981 引擎分档快照', () => {
  it('快照 sha 逐字钉住（EOL 归一化后算，autocrlf 不许造成假红）', () => {
    const text = readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8').replace(/\r\n?/g, '\n');
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(SNAPSHOT_SHA256);
  });

  it('生产表 == snake commands − 条件注册两枚（双向差集为空）', () => {
    const authoritative = new Set(snakeCommands().filter((n) => !CONDITIONAL_ONLY.includes(n)));
    const produced = new Set(ERB_INSTRUCTION_NAMES);
    expect(authoritative.size).toBe(324);
    const missing = [...authoritative].filter((n) => !produced.has(n)).sort();
    const extra = [...produced].filter((n) => !authoritative.has(n)).sort();
    expect(missing, `4.981 有、kojo 没接：${missing.join(' ')}`).toEqual([]);
    expect(extra, `kojo 有、4.981 语句面没有：${extra.join(' ')}`).toEqual([]);
  });

  it('语料实证的 13 名逐条在位；条件注册的 VARI/VARS 仍不在位', () => {
    const set = new Set(ERB_INSTRUCTION_NAMES);
    for (const name of CORPUS_OBSERVED) {
      expect(set.has(name), `${name} 在 4.981 真语料里在用，却不在指令表里`).toBe(true);
    }
    for (const name of CONDITIONAL_ONLY) {
      expect(set.has(name), `${name} 默认配置不注册，不许进无条件面`).toBe(false);
    }
  });

  it('规模 / 大写 / 字典序 / 无重复', () => {
    expect(ERB_INSTRUCTION_NAMES).toHaveLength(324);
    expect([...ERB_INSTRUCTION_NAMES].sort()).toEqual([...ERB_INSTRUCTION_NAMES]);
    for (const name of ERB_INSTRUCTION_NAMES) expect(name).toBe(name.toUpperCase());
    expect(new Set(ERB_INSTRUCTION_NAMES).size).toBe(ERB_INSTRUCTION_NAMES.length);
  });

  it('isInstructionName 对新名大小写不敏感，对 VARI/VARS 判否', () => {
    expect(isInstructionName('SETANIMETIMER')).toBe(true);
    expect(isInstructionName('  setAnimeTimer  ')).toBe(true);
    expect(isInstructionName('TRYCALLSTR')).toBe(true);
    expect(isInstructionName('VARI')).toBe(false);
    expect(isInstructionName('VARS')).toBe(false);
    expect(isInstructionName('NO_SUCH_INSTRUCTION')).toBe(false);
  });
});
