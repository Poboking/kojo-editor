/**
 * S2 批验收：转译产物必须是"**可回放形态**"。
 *
 * 判据：产物经 erb-parser 的控制流骨架扫描 + condition-extractor 的表达式解析后，
 * **零 opaque**（opaque = 表达式无法完整解析、整体降级为原文）。这是 S2 的硬性验收项：
 * 糖生成的代码（直线赋值 / IF 链 / SELECTCASE / CALL 子集）必须能被回放链路解析。
 *
 * 覆盖：§6.1 / §6.2 两份 golden 产物 + 一份覆盖全部糖形态的合成样例。
 *
 * 说明：本文件是**测试**，按解耦审计规则 C 的豁免（测试属宿主层面集成）可直接
 * import 其它插件包；非测试源码一律不得交叉 import。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseErbText, scanControlFlow } from '@kojo/plugin-erb-parser';
import { extractFunctionPredicates } from '@kojo/plugin-condition-extractor';
import { createSugarTranspileService } from '../src/service';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '胆怯' || name === '恋慕' || name === '思慕') return 'TALENT';
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '名字') return 'CALLNAME';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (
      ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR', 'FLAG', 'TFLAG'].includes(head)
    ) {
      return ident;
    }
    return undefined;
  },
};

const GOLDENS = path.resolve(import.meta.dirname, 'goldens');
/** 剥掉 fixture 顶部的 `//` 注释头（不计入糖源） */
const stripBanner = (text: string) => text.split('\n').filter((l) => !l.startsWith('//')).join('\n');

const ERB_PATH = '/sugar.ERB';

/**
 * 对一份 ERB 产物：抽全部函数的谓词明细 → 统计 opaque 条数。
 * @returns opaque 条数（0 = 全部表达式可完整解析）
 */
function countOpaque(erb: string): number {
  const root = parseErbText(erb, ERB_PATH);
  const stmts = scanControlFlow(erb);
  const lines = erb.split(/\r\n|\n|\r/);
  let opaque = 0;
  let total = 0;
  for (const fn of root.functions) {
    const preds = extractFunctionPredicates(
      { normalizedName: fn.normalizedName, filePath: ERB_PATH, startLine: fn.startLine },
      stmts.filter((s) => s.line >= fn.startLine),
      { endLine: fn.endLine, lines },
    );
    for (const p of preds.predicates) {
      total++;
      if (p.expr.kind === 'opaque') opaque++;
    }
  }
  // 至少要有谓词被抽到，否则"零 opaque"是空洞的（不伪造通过）
  expect(total, `产物未抽到任何谓词（断言无效）：${JSON.stringify(erb)}`).toBeGreaterThan(0);
  return opaque;
}

describe('S2 验收：转译产物过 condition-extractor 零 opaque', () => {
  const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

  it('§6.1 golden 产物：无编译错误且零 opaque', () => {
    const src = stripBanner(fs.readFileSync(path.join(GOLDENS, 'spec-6.1-lumia-310.kojo'), 'utf8'));
    const res = svc().transpile(src);
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(countOpaque(res.erb)).toBe(0);
  });

  it('§6.2 golden 产物：无编译错误且零 opaque', () => {
    const src = stripBanner(fs.readFileSync(path.join(GOLDENS, 'spec-6.2-choice-heart-random.kojo'), 'utf8'));
    const res = svc().transpile(src);
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(countOpaque(res.erb)).toBe(0);
  });

  it('合成样例（覆盖 §3 全部糖形态）：无编译错误且零 opaque', () => {
    const src = [
      '角色: 12',
      '口上: 破空',
      '开关:',
      '    FLAG:70 关',
      '别名 她的好感度 = CFLAG:TARGET:好感度',
      '别名 阈值 = 500',
      '别名 恋慕心 = TALENT:TARGET:恋慕',
      '时机 指令 310：',
      '    隐藏口上: TFLAG:193 == 1',
      '    「今天也来训练了？」',
      '    她点了点头。',
      '    「……」 续',
      '    她叹了口气。 续',
      '    「好感度是{她的好感度}。」',
      '    {恋慕心 ? "她的耳朵红了。" : ""}',
      '    如果 她的好感度 >= 500：',
      '        「已经足够了呢。」',
      '    否则如果 她的好感度 >= 100：',
      '        「还不错。」',
      '    否则：',
      '        「再努力一点吧。」',
      '    当 她的好感度：',
      '        是 0 到 99：',
      '            「还早呢。」',
      '        是 100 到 499：',
      '            「还不错。」',
      '        否则：',
      '            「已经很好了。」',
      '    随机：',
      '        「嗯。」',
      '        「哦？」',
      '    着色 C_蓝：',
      '        「这句话是蓝色的。」',
      '    她的心情 = 如果 她的好感度 >= 阈值：',
      '        "热情"',
      '    否则：',
      '        "冷淡"',
      '    她的心情 = 当 她的好感度：',
      '        是 0 到 99 -> 0',
      '        是 100 到 499 -> 1',
      '        否则 -> 2',
      '    藏起来',
      '',
      '时机 指令 311：',
      '    选项：',
      '        「用亲吻代替回答」：',
      '            「……唔。」',
      '            心形 「虽然，还不太明白……但是、不讨厌。」',
      '        「摸摸头」：',
      '            「……好。」',
      '',
    ].join('\n');
    const res = svc().transpile(src);
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(countOpaque(res.erb)).toBe(0);
  });
});
