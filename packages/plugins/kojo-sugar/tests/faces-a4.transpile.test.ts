/**
 * A4：附录 C **之外**的实测调用面（角色介绍 / 礼物 / 参数变动 / 触手 / 房间描述 /
 * 游玩指南 ×3）——写侧糖头 → ERB 逐字节 + 反解可写回 + 投影往返。
 *
 * caller 出处见 adapter `face-templates.ts` 各条目注释（引擎源码确证，非猜测）。
 * 本文件是这批补面的**可执行凭证**：模板 / 分段 / 反解任一处漂移，此处先红。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFaceNameIndex } from '../src/faces-reverse';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const dir = new URL('./goldens/a4/', import.meta.url);
const readKojo = (name: string) =>
  readFileSync(new URL(name, dir), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n');
const readRaw = (name: string) => readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
/** 投影依赖：带 faceTable（批 I 的函数头反解用） */
const projectDeps = (): LiftDeps => ({
  transpile: (s) => svc().transpile(s),
  faceTable: () => stubFaceTable(),
});
const idx = buildFaceNameIndex(stubFaceTable());

const doc = (head: string) => `角色: 12\n${head}\n\t「甲。」\n`;

describe('A4 补面 · golden 逐字节转译', () => {
  it('标准版（无家族段）：8 面产物逐字节一致，诊断为空', () => {
    const res = svc().transpile(readKojo('a4-faces.kojo'));
    expect(res.diagnostics).toEqual([]);
    expect(res.erb).toBe(readRaw('a4-faces.expected.erb.todo'));
  });

  it('家族版（`口上: TOKI`）：`{t}` 段落位逐字节一致（房间描述 = `K{n}{t}`，家族段在编号后）', () => {
    const res = svc().transpile(readKojo('a4-faces-family.kojo'));
    expect(res.diagnostics).toEqual([]);
    expect(res.erb).toBe(readRaw('a4-faces-family.expected.erb.todo'));
  });

  it('锚点：8 面目标函数名齐备（写侧模板落对）', () => {
    const { erb } = svc().transpile(readKojo('a4-faces.kojo'));
    for (const fn of [
      'CHARA_INFO_KOJO_K12',
      'M_KOJO_EVENT_K12_GIFT',
      'M_KOJO_MESSAGE_PALAMCNG_D_K12',
      'M_KOJO_MESSAGE_PALAMCNG_E_K12',
      'K12_ROOM_DESCRIPTION',
      'KOJO_OPTION_K12',
      'KOJO_OPTION_EXIST_K12',
      'KOJO_OPTION_K12_RESULT_3',
    ]) {
      expect(erb).toContain(`@${fn}`);
      expect(erb).toContain(`@${fn}_1`);
    }
  });
});

describe('A4 补面 · 函数头反解（看见的即写得出的）', () => {
  const cases: Array<[string, string]> = [
    ['CHARA_INFO_KOJO_K12', '时机 角色介绍：'],
    ['M_KOJO_EVENT_K12_GIFT', '时机 礼物：'],
    ['M_KOJO_MESSAGE_PALAMCNG_D_K12', '时机 参数变动：'],
    ['M_KOJO_MESSAGE_PALAMCNG_E_K12', '时机 触手：'],
    ['K12_ROOM_DESCRIPTION', '时机 房间描述：'],
    ['KOJO_OPTION_K12', '时机 游玩指南：'],
    ['KOJO_OPTION_EXIST_K12', '时机 游玩指南存在：'],
    ['KOJO_OPTION_K12_RESULT_3', '时机 游玩指南结果 3：'],
  ];

  it('标准版函数名 → 可写块头，且标签可写回同一函数名', () => {
    for (const [fn, label] of cases) {
      expect(idx.label(fn), fn).toBe(label);
      expect(idx.family(fn), fn).toBeUndefined();
      // 写回：照抄标签 → 转译 → 同名函数（第一原则）
      expect(svc().transpile(doc(label)).erb, label).toContain(`@${fn}`);
    }
  });

  it('家族版（`_TOKI`）→ 块头不含家族，家族名走 family() 出口（E13-1 同口径）', () => {
    const familyCases: Array<[string, string]> = [
      ['CHARA_INFO_KOJO_TOKI_K12', '时机 角色介绍：'],
      ['K12_TOKI_ROOM_DESCRIPTION', '时机 房间描述：'],
      ['KOJO_TOKI_OPTION_K12', '时机 游玩指南：'],
      ['KOJO_TOKI_OPTION_K12_RESULT_3', '时机 游玩指南结果 3：'],
    ];
    for (const [fn, label] of familyCases) {
      expect(idx.label(fn), fn).toBe(label);
      expect(idx.family(fn), fn).toBe('TOKI');
    }
    // 写回：标签 + `口上: TOKI` → 同名家族函数
    const { erb } = svc().transpile(`角色: 12\n口上: TOKI\n${familyCases[1]![1]}\n\t「甲。」\n`);
    expect(erb).toContain('@K12_TOKI_ROOM_DESCRIPTION');
  });
});

describe('A4 补面 · 投影往返（原生 ERB → 糖块头）', () => {
  it('标准版产物投影回可写块头（每面至少一个 `时机 …：` 命中）', () => {
    const { erb } = svc().transpile(readKojo('a4-faces.kojo'));
    const sugar = liftProject(projectDeps(), { source: erb })
      .segments.map((s: { sugarText: string }) => s.sugarText)
      .join('\n');
    for (const label of [
      '时机 角色介绍：',
      '时机 礼物：',
      '时机 参数变动：',
      '时机 触手：',
      '时机 房间描述：',
      '时机 游玩指南：',
      '时机 游玩指南存在：',
      '时机 游玩指南结果 3：',
    ]) {
      expect(sugar, label).toContain(label);
    }
  });

  it('家族版产物投影发出文件头 `口上: TOKI`（家族声明可写回）', () => {
    const { erb } = svc().transpile(readKojo('a4-faces-family.kojo'));
    const sugar = liftProject(projectDeps(), { source: erb })
      .segments.map((s: { sugarText: string }) => s.sugarText)
      .join('\n');
    expect(sugar).toContain('口上: TOKI');
    expect(sugar).toContain('时机 房间描述：');
    expect(sugar).toContain('时机 游玩指南：');
  });
});
