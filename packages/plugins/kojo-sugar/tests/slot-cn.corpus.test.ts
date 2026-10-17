/**
 * **slotCn 通道 · 真实语料读数**（ZH-N 接线批；`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，
 * 语料不在位整组跳过——挂空串会让 setup 全崩，见 AGENTS.md §三）。
 *
 * 全生产链路：真盘装载 `loadEratwVariableSchema`（CSV+`.als`+汉化词典）→ `makeLookup` 逐字
 * 转发 → `liftProject` 的 `nativeDisplayLookup` → ZH-S 语句 pass。糖层零游戏知识、零第二份表。
 *
 * 两个数（改前恒 0——通道没接，槽位注记一条都产不出）：
 * - **尝试数**：语句行里带索引的别名族引用向 `slotCn` 问了一次名；
 * - **命中行数**：投影显示形里至少带一枚中文槽名注记的行数。
 * 未命中 = 尝试 − 命中（fail-closed 保持原名，退化可数）。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, FileIO, Logger, VariableSchema } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { loadEratwVariableSchema } from '../../eratw-adapter/src/variable-schema';
import { liftProject } from '../src/project';
import { makeLookup } from '../src/index';
import type { DictionaryLookup } from '../src/types';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 口上域样本（批 J 同一目录口径）；PROBE_FILE_LIMIT 可缩面快跑 */
const KOJO_DIR = SMOKE ? join(SMOKE, 'ERB', '口上・メッセージ関連') : '';
const LIMIT = Number(process.env.PROBE_FILE_LIMIT ?? 120);

function erbFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.erb$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

describe.skipIf(!SMOKE)('slotCn 通道 · 真语料命中读数（改前恒 0）', () => {
  it('口上域样本投影：尝试/命中两个数，未命中逐字保持原名', async () => {
    const io: FileIO = new FileIOServiceImpl(new NodeBridge(SMOKE!), silentLog);
    const schema: VariableSchema = await loadEratwVariableSchema({
      io,
      csvDir: join(SMOKE!, 'CSV'),
      chsMapPath: join(SMOKE!, 'plugins', 'tw_csv_chs.xml'),
      log: silentLog,
    });
    const dict = makeLookup(schema);
    expect(dict.slotCn).toBeTypeOf('function');

    let attempts = 0;
    let hits = 0;
    const counted: DictionaryLookup = {
      ...dict,
      slotCn: (family, jp) => {
        attempts++;
        const cn = dict.slotCn!(family, jp);
        if (cn !== undefined) hits++;
        return cn;
      },
    };
    /** 基线 = 改前装配（通道恒"查不到"）；命中行数用**双跑逐行差分**数，不按括号猜（别的注记形如「（逐行）」会污染） */
    const baseline: DictionaryLookup = { ...dict, slotCn: () => undefined };

    const project = (d: DictionaryLookup, source: string): string[] =>
      liftProject(
        {
          transpile: () => {
            throw new Error('投影不应调用 transpile');
          },
          scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
          dictionary: () => d,
        },
        { source },
      ).segments.flatMap((s) => s.sugarText.split('\n'));

    const files = erbFiles(KOJO_DIR).slice(0, LIMIT);
    expect(files.length).toBeGreaterThan(0);
    let hitLines = 0;
    let projectedLines = 0;
    for (const f of files) {
      const source = (await io.readText(f)).text; // 编码解码走内核 io（游戏盘是 CP932/UTF-8 混合）
      const after = project(counted, source);
      const before = project(baseline, source);
      projectedLines += after.length;
      for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) hitLines++;
    }

    // eslint-disable-next-line no-console
    console.info(
      `[slotCn·真语料] 文件 ${files.length} · 尝试 ${attempts} · 命中 ${hits} · 未命中 ${attempts - hits} · 命中行数 ${hitLines}（投影行 ${projectedLines}）`,
    );
    expect(attempts).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0); // 改前恒 0——这条断言就是"通道接通生产"的判据
    expect(hits).toBeLessThanOrEqual(attempts);
    expect(hitLines).toBeGreaterThan(0);
    expect(hitLines).toBeLessThanOrEqual(hits);
  });
});
