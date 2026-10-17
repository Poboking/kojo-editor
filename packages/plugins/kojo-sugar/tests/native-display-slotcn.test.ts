/**
 * **slotCn 通道生产接线验收**（ZH-N 接线批）。
 *
 * 改前事实：`project.ts` 的 `nativeDisplayLookup` 恒给 `slotCn: () => undefined` ⇒
 * 投影里槽位原名（`噴乳`、编号）从没被换成中文名；这条能力此前只活在单测桩里。
 * 本文件钉"接通后"的三态，全程走**真链路**（adapter 真 loader + 真词典解析 +
 * `makeLookup` 逐字转发 + `liftProject` 生产接线），糖层不建第二份表：
 *
 * 1. **命中 ⇒ 中文名**：具名索引（扁平词典直查）与数字索引（族名称表 `byIndex` 换算）
 *    都走 adapter 真表口径，期望值来自 fixture 词典/CSV 的**装载结果**，不是桩名；
 * 2. **查不到 ⇒ 原名 + 一次可数退化**：命中/尝试经生产通道（`dict.slotCn`）计数；
 * 3. **通道缺席（旧装配）⇒ 逐字保持今天行为**（additive 证明）。
 *
 * 靶族 = `NOWEX` / `TFLAG`（角色状态族会被批 J 的属性反糖先认领，不进 native 显示层）。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, FileIO, Logger, VariableSchema } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { loadEratwVariableSchema } from '../../eratw-adapter/src/variable-schema';
import { liftProject } from '../src/project';
import { makeLookup } from '../src/index';
import type { LiftDeps } from '../src/lift';
import type { DictionaryLookup } from '../src/types';

const silentLog: Logger = { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} };

/** 名字对取自真盘形态（eraTW：`信頼度`（CSV 原名）→ `信赖度`（汉化词典）、`噴乳→喷乳`） */
const FILES: Record<string, string> = {
  '/game/CSV/CFLAG.csv': '2,信頼度\n4,好感度\n',
  '/game/CSV/TFLAG.csv': '2,信頼度\n',
  '/plugins/tw_csv_chs.xml':
    '<map><p><k>噴乳</k><v>喷乳</v></p><p><k>信頼度</k><v>信赖度</v></p></map>',
};

function fakeIo(): FileIO {
  const names = Object.keys(FILES).filter((p) => p.endsWith('.csv'));
  return {
    listDir: async () =>
      names.map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false })),
    readText: async (path: string) => ({ text: FILES[path] ?? '', path }),
    readTexts: async (paths: readonly string[]) => paths.map((p) => ({ text: FILES[p] ?? '', path: p })),
  } as unknown as FileIO;
}

const loadSchema = (withChs: boolean): Promise<VariableSchema> =>
  loadEratwVariableSchema({
    io: fakeIo(),
    csvDir: '/game/CSV',
    ...(withChs ? { chsMapPath: '/plugins/tw_csv_chs.xml' } : {}),
    log: silentLog,
  });

/** 生产装配（与 kojo-sugar index.ts 同链路：makeLookup → LiftDeps.dictionary → liftProject）；返回**逐行**显示形 */
const projectLines = (dict: DictionaryLookup | undefined, source: string): string[] =>
  liftProject(
    {
      transpile: () => {
        throw new Error('投影不应调用 transpile');
      },
      scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
      ...(dict ? { dictionary: () => dict } : {}),
    } satisfies LiftDeps,
    { source },
  ).segments.flatMap((s) => s.sugarText.split('\n'));

/** 经生产通道的命中/尝试计数（退化可数：未命中 = attempts − hits，两个都是整数读数） */
function counted(dict: DictionaryLookup): { lookup: DictionaryLookup; attempts: () => number; hits: () => number } {
  let attempts = 0;
  let hits = 0;
  return {
    attempts: () => attempts,
    hits: () => hits,
    lookup: {
      ...dict,
      ...(dict.slotCn
        ? {
            slotCn: (family: string, jp: string) => {
              attempts++;
              const cn = dict.slotCn!(family, jp);
              if (cn !== undefined) hits++;
              return cn;
            },
          }
        : {}),
    },
  };
}

describe('slotCn 通道 · 生产接线（真表，非桩名）', () => {
  it('转发面在位：makeLookup 把契约 VariableSchema.slotCn 逐字挂进 DictionaryLookup', async () => {
    const dict = makeLookup(await loadSchema(true));
    expect(dict.slotCn).toBeTypeOf('function');
    expect(dict.slotCn!('NOWEX', '噴乳')).toBe('喷乳'); // 具名直查（扁平词典）
    expect(dict.slotCn!('CFLAG', '2')).toBe('信赖度'); // 编号 → 主表原名 → 同一词典
    expect(dict.slotCn!('CFLAG', '4')).toBeUndefined(); // 词典缺条 ⇒ 不冒充命中
  });

  it('①命中 ⇒ 显示中文名：具名与数字索引都经真链路进投影文本', async () => {
    const dict = makeLookup(await loadSchema(true));
    // NOWEX/TFLAG 别名 = adapter 真表 FAMILY_ALIASES（现在→NOWEX、时标→TFLAG）
    expect(projectLines(dict, 'NOWEX:噴乳 = 1')).toEqual(['现在:噴乳（喷乳） = 1']);
    // `+=` 形被「步进」糖先认领（非 native 路），本通道靶形是裸赋值
    expect(projectLines(dict, 'TFLAG:2 = 3')).toEqual(['时标:2（信赖度） = 3']);
  });

  it('②查不到 ⇒ 原名 + 一次可数退化（不猜、不造近似名）', async () => {
    const c = counted(makeLookup(await loadSchema(true)));
    const out = projectLines(c.lookup, ['TFLAG:9 = 1', 'NOWEX:噴乳 = 1'].join('\n'));
    expect(out).toEqual(['时标:9 = 1', '现在:噴乳（喷乳） = 1']);
    expect(c.attempts()).toBe(2);
    expect(c.hits()).toBe(1); // 未命中 = attempts − hits = 1（退化读数）
  });

  it('③通道缺席 = 今天行为逐字保持（additive 证明）：未实现 slotCn 的旧 schema ⇒ 零注记', async () => {
    const legacy: VariableSchema = { ...(await loadSchema(true)), slotCn: undefined };
    const dict = makeLookup(legacy);
    expect(dict.slotCn).toBeUndefined();
    expect(projectLines(dict, 'NOWEX:噴乳 = 1\nTFLAG:2 = 1')).toEqual(['现在:噴乳 = 1', '时标:2 = 1']);
  });

  it('词典缺席（无文件/读失败）⇒ 全量退化回原名，零命中但尝试照数', async () => {
    const c = counted(makeLookup(await loadSchema(false)));
    const out = projectLines(c.lookup, 'NOWEX:噴乳 = 1');
    expect(out).toEqual(['现在:噴乳 = 1']);
    expect(c.attempts()).toBe(1);
    expect(c.hits()).toBe(0);
  });
});
