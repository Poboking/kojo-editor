/**
 * 守门测试：**跨进程桥上，`walkDir` 的 `filter` 到底算不算数**（2026-10-16 walkDir filter 批）。
 *
 * ## 这条测试存在的全部理由
 *
 * 桌面壳实测：点「最近项目」到欢迎页让位 25 秒，其中 **24.4 秒**花在 `loadEratwVariableSchema`
 * 一个函数上。根因不是算法，是**桥分叉**——
 * `variable-schema.ts` 递了一个 JS 闭包 `filter` 给 `io.walkDir`，
 * 而 Tauri 侧 `invoke('walk_dir', { opts })` 过一次 JSON：闭包整键消失，
 * Rust 的 `WalkOptionsDto` 里本来也没有这个字段。于是**整个 ERB 根下 4,519 份文件**
 * 全部返回，接着逐份串行 `readText` 进「作者自定名表」（只该收 153 份 `.ERH`）。
 *
 * node 测试桥自己实现了 JS 递归并**兑现** `filter` ⇒ 全仓测试对此全绿、产品是错的。
 * 本文件用一具**按线的行为建模**的「Tauri 形」桥（`helpers/ipc-shaped-bridge`）跑同一条生产链路，
 * 断言的是**读盘事实**而不是返回值：读了哪几份、走单读还是批量、谓词有没有被当成可跨进程的参数。
 *
 * ## 五条判据（前三条在修复前必须是红的）
 *
 * 1. 递到桥手上的 opts **不得含 `filter`**——谓词是闭包，交给桥就是"类型说有、桥不管"；
 * 2. ERB 根下实际读到的文件集合 = 该根下全部 `.ERH`，**不多一份**（正文 `.ERB` 一份都不读）；
 * 3. 字典的两条读循环一律走批量原语：ERB 侧与 CSV 侧的**单文件读趟数 = 0**；
 * 4. 正文 `.ERB` 里的 `#DIM CONST` 既不进名表、也不进 `inputDigest`
 *    （改一份正文 ⇒ 摘要逐字不变；改一份 `.ERH` ⇒ 摘要必须变）；
 * 5. 收窄不等于少收：三份 `.ERH`（含嵌套目录与小写扩展名）的具名常量逐条查得到。
 *
 * 合成夹具落在系统临时目录，**不碰语料盘**（语料盘只读是硬约束）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@kojo/plugin-api';
import { isPathUnder } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import {
  newWireFacts,
  tauriShapedBridge,
  type WireFacts,
} from '../../../kernel/tests/helpers/ipc-shaped-bridge';
import { loadEratwVariableSchema } from '../src/variable-schema';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 正文份数：够大才量得出"整棵树 vs 只读声明"的差别（真语料是 4,519 份） */
const BODY_COUNT = 240;

const ERH_TOP = '#DIM CONST IPC_TEST_FROM_ERH = 900\n';
const ERH_DEEP = '#DIM CONST IPC_TEST_DEEP_ERH = 901\n';
const ERH_LOWER = '#DIM CONST IPC_TEST_LOWER_ERH = 902\n';
const bodyText = (i: number): string =>
  `#DIM CONST IPC_TEST_FROM_ERB = ${i}\n@MESSAGE_K1_${i}\nPRINT 1\n`;

const CSV_FILES: Record<string, string> = {
  'CFLAG.csv': '1,既成事実\n2,好感度\n',
  'CFLAG.als': '145,泥酔\n',
  'Abl.csv': '1,Ｃ感覚\n',
};

let root = '';
let csvDir = '';
let erbDir = '';
let facts: WireFacts;
/** ERB 根下全部 `.ERH` 的路径（夹具自己数的独立口径——判据不许复用被测代码的枚举结果） */
let erhPaths: string[] = [];

function buildFixture(): void {
  mkdirSync(join(root, 'CSV'), { recursive: true });
  for (const [name, body] of Object.entries(CSV_FILES)) writeFileSync(join(csvDir, name), body, 'utf8');

  mkdirSync(join(erbDir, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(erbDir, 'a.ERH'), ERH_TOP, 'utf8');
  writeFileSync(join(erbDir, 'sub', 'b.ERH'), ERH_DEEP, 'utf8');
  writeFileSync(join(erbDir, 'sub', 'deep', 'c.erh'), ERH_LOWER, 'utf8');
  writeFileSync(join(erbDir, 'sub', 'deep', 'note.txt'), '不是方言文件，一份也不该读\n', 'utf8');
  for (let i = 0; i < BODY_COUNT; i++) {
    writeFileSync(join(erbDir, 'sub', `body-${String(i).padStart(3, '0')}.ERB`), bodyText(i), 'utf8');
  }
  erhPaths = [
    join(erbDir, 'a.ERH'),
    join(erbDir, 'sub', 'b.ERH'),
    join(erbDir, 'sub', 'deep', 'c.erh'),
  ].sort();
}

/** 过境的读盘事实里，落在某个根下的那部分路径（去重 + 排序 ⇒ 判据与调用顺序无关） */
function readUnder(dir: string, paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => isPathUnder(dir, p)))].sort();
}

const load = () =>
  loadEratwVariableSchema({
    io: new FileIOServiceImpl(tauriShapedBridge(new NodeBridge(root), facts), silentLog),
    csvDir,
    erbDir,
    log: silentLog,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kojo-walkdir-ipc-'));
  csvDir = join(root, 'CSV');
  erbDir = join(root, 'ERB');
  buildFixture();
  facts = newWireFacts();
});

/** 每条判据只看自己这一轮的过线事实（读数累加会把上一轮的账算进本轮） */
beforeEach(() => {
  facts = newWireFacts();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('walkDir filter 跨 IPC：作者自定名表只该读 `.ERH`（桥分叉守门）', () => {
  it('谓词不得作为跨进程参数递给平台桥（闭包过不了 JSON）', async () => {
    await load();
    expect(facts.walkOptKeys.length).toBeGreaterThan(0);
    const offenders = facts.walkOptKeys.filter((keys) => keys.includes('filter'));
    expect(
      offenders,
      `filter 是 JS 闭包，交给平台桥 = 类型说有、桥不管（生产里它被 JSON 静默吃掉 ⇒ 整棵树回来）`,
    ).toEqual([]);
  });

  it('ERB 根下实际读到的文件 = 全部 `.ERH`，正文一份都不读', async () => {
    await load();
    const read = readUnder(erbDir, [...facts.singleReads, ...facts.batchReads]);
    expect(
      read,
      `只该读 ${erhPaths.length} 份 .ERH，实际读了 ${read.length} 份（真语料上这就是 4,519 份串行读 = 24.4s）`,
    ).toEqual(erhPaths);
  });

  it('两条读循环都走批量原语：单文件读趟数为 0', async () => {
    await load();
    expect(readUnder(erbDir, facts.singleReads)).toEqual([]);
    expect(readUnder(csvDir, facts.singleReads)).toEqual([]);
    // 批量接口按批调用，不许退化成"一次一份"（那与串行 await-in-loop 同价）
    expect(facts.batchInvocations.every((b) => b.size > 0)).toBe(true);
    const erhBatches = facts.batchInvocations.length;
    expect(erhBatches).toBeLessThanOrEqual(4);
  });

  it('正文 `.ERB` 的 `#DIM CONST` 既不进名表也不进摘要；`.ERH` 的改动必须动摘要', async () => {
    const base = await load();
    expect(
      base.lookup('CFLAG', 'IPC_TEST_FROM_ERB')?.resolvedIndex,
      '函数体/正文里的具名常量属"作用域未定"，并进全局自定名表就是猜',
    ).toBeUndefined();

    const editedBody = join(erbDir, 'sub', 'body-000.ERB');
    const original = '#DIM CONST IPC_TEST_FROM_ERB = 0\n@MESSAGE_K1_0\nPRINT 1\n';
    writeFileSync(editedBody, '@MESSAGE_K1_0\nPRINT 2\n', 'utf8');
    const afterBody = await load();
    expect(afterBody.inputDigest, '正文字节不该折进字典的输入摘要').toBe(base.inputDigest);
    writeFileSync(editedBody, original, 'utf8');

    writeFileSync(join(erbDir, 'a.ERH'), `${ERH_TOP}#DIM CONST IPC_TEST_ADDED = 903\n`, 'utf8');
    const afterErh = await load();
    expect(afterErh.inputDigest).not.toBe(base.inputDigest);
    expect(afterErh.lookup('CFLAG', 'IPC_TEST_ADDED')?.resolvedIndex).toBe(903);
    writeFileSync(join(erbDir, 'a.ERH'), ERH_TOP, 'utf8');
  });

  it('收窄不等于少收：三份 `.ERH`（嵌套目录 + 小写扩展名）逐条可查', async () => {
    const schema = await load();
    expect(schema.lookup('CFLAG', 'IPC_TEST_FROM_ERH')?.resolvedIndex).toBe(900);
    expect(schema.lookup('CFLAG', 'IPC_TEST_DEEP_ERH')?.resolvedIndex).toBe(901);
    expect(schema.lookup('ABL', 'IPC_TEST_LOWER_ERH')?.resolvedIndex).toBe(902);
    // 名称表本身不受影响
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('CFLAG', '泥酔')?.resolvedIndex).toBe(145);
  });
});
