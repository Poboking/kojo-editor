/**
 * 2026-10-19 · 增减行「直写」形态（`KojoMutatorSpec.form === 'assign'`）。
 *
 * 背景：`geek-numchange.test.ts` 钉的是 eraTW 那套**降成 `CALL`** 的口径（游戏有
 * `CHANGE_CFLAG` / `BUFF_BASE` 封装函数）。eraAkumaMaid **一个封装函数都没有**，
 * 增减就是直写 `族:对象:槽 += n`；契约因此加了 `assign` 形态，本文件钉它的产物。
 *
 * 与 call 形态**故意不同**的两处（各自的理由都写在 `codegen.ts::emitMutator` 头注）：
 * - `-=` **不取负**：ERB 的复合赋值本身就是"左值 减 (右值)"，再前置负号会变成加；
 * - `=` 按字面降成**赋值**（call 形态那边 `=` 沿用既定口径"视为变动值"，因为它表达不了"设为"）。
 *
 * 夹具用 eraAkumaMaid adapter 的**真实**表（增减族表 + 分野表），断言贴近生产；
 * 审计 C 项对 `tests/` 豁免，故测试可跨包 import。
 */

import { describe, expect, it } from 'vitest';
import {
  AM_MUTATOR_FAMILIES,
  createErakumamaidFaceTable,
  createErakumamaidMutatorTable,
} from '@kojo/plugin-eraakumamaid-adapter';
import { createSugarTranspileService } from '../src/service';
import { stubDict } from './support';

/** AM 专属夹具：本游戏的分野表 + 本游戏的增减族表（两者同源，别用 eratw 的表混搭） */
const svc = () =>
  createSugarTranspileService({
    dictionary: stubDict,
    faceTable: createErakumamaidFaceTable(),
    mutatorTable: createErakumamaidMutatorTable(AM_MUTATOR_FAMILIES),
  });
const t = (src: string) => svc().transpile(src);

/** 正文落在 `时机 绝顶：` 体内（AM 表 → `KOJO_MESSAGE_COMING_K12`） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

const outLines = (src: string): string[] => t(src).erb.split('\n').map((l) => l.trim());
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');

describe('增减 · assign 形态（eraAkumaMaid：直写，不经函数）', () => {
  it('`+=` 原样落到左值：`增减 CFLAG:TARGET:好感度 += 1` → `CFLAG:TARGET:好感度 += 1`', () => {
    const src = doc('\t增减 CFLAG:TARGET:好感度 += 1');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CFLAG:TARGET:好感度 += 1');
  });

  it('`-=` **不取负**：`增减 BASE:MASTER:体力 -= 100` → `BASE:MASTER:体力 -= 100`（不是 `-= -100`）', () => {
    const src = doc('\t增减 BASE:MASTER:体力 -= 100');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('BASE:MASTER:体力 -= 100');
    // 反向钉死：任何前置负号都是错的
    expect(outLines(src).some((l) => l.startsWith('BASE:MASTER:体力') && l.includes('-=') && /-\s*-/.test(l))).toBe(
      false,
    );
  });

  it('`-=` 含顶层运算符也不加括号（复合赋值语义已是"减右值"）', () => {
    const src = doc('\t增减 BASE:MASTER:体力 -= 10 + 5');
    expect(errs(src)).toEqual([]);
    const line = outLines(src).find((l) => l.startsWith('BASE:MASTER:体力'));
    expect(line).toBeDefined();
    expect(line).not.toContain('-(10 + 5)');
    expect(line).toMatch(/^BASE:MASTER:体力 -= 10 \+ 5$/);
  });

  it('`=` 降成赋值（直写形态表达得了"设为"，与 call 形态的既定口径不同）', () => {
    const src = doc('\t增减 CFLAG:TARGET:好感度 = 50');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CFLAG:TARGET:好感度 = 50');
  });

  it('其余三族同样直写（EXP / PALAM / ABL 的模板各自拼左值）', () => {
    const cases: Array<[string, string]> = [
      ['\t增减 EXP:PLAYER:経験 += 1', 'EXP:PLAYER:経験 += 1'],
      ['\t增减 PALAM:TARGET:反感 += 2', 'PALAM:TARGET:反感 += 2'],
      ['\t增减 ABL:MASTER:技巧 += 1', 'ABL:MASTER:技巧 += 1'],
    ];
    for (const [body, expected] of cases) {
      const src = doc(body);
      expect(errs(src), body).toEqual([]);
      expect(outLines(src), body).toContain(expected);
    }
  });

  it('对象段可以是表达式（`FIND_COND("真")`），**原样透传**不被表达式降糖误报', () => {
    const src = doc('\t增减 EXP:FIND_COND("真"):経験 += 1');
    expect(errs(src)).toEqual([]);
    expect(outLines(src).some((l) => l.startsWith('EXP:FIND_COND("真"):経験 +='))).toBe(true);
  });

  it('运算符两侧无空白也同产（`CFLAG:TARGET:好感度+=1`）', () => {
    expect(outLines(doc('\t增减 CFLAG:TARGET:好感度+=1'))).toContain('CFLAG:TARGET:好感度 += 1');
  });

  it('行内体（`如果 …：增减 …`）同样直写', () => {
    const src = doc('\t如果 1 == 1： 增减 CFLAG:TARGET:好感度 += 1');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CFLAG:TARGET:好感度 += 1');
  });

  it('产物里**没有**任何 `CALL <增减函数>`（assign 形态的定义就在"不调函数"）', () => {
    const src = doc('\t增减 CFLAG:TARGET:好感度 += 1');
    expect(outLines(src).some((l) => /^CALL (CHANGE_CFLAG|BUFF_BASE)\(/.test(l))).toBe(false);
  });
});

describe('增减 · assign 形态的 fail-closed（与 call 形态同一套文案）', () => {
  it('族头未登记（`JUEL` 是一维族，本表故意不收）：报错且不落任何行', () => {
    const src = doc('\t增减 JUEL:TARGET:欲情 += 1');
    const e = errs(src);
    expect(e).toHaveLength(1);
    expect(e[0]!.code).toBe('unknown-identifier');
    expect(e[0]!.message).toContain('增减族表');
    expect(outLines(src).some((l) => l.startsWith('JUEL:TARGET:欲情'))).toBe(false);
  });

  it('引用非三段：文案含「变量槽」，不落行', () => {
    const src = doc('\t增减 CFLAG:好感度 += 1');
    const e = errs(src);
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('变量槽');
    expect(outLines(src).some((l) => l === 'CFLAG:好感度 += 1')).toBe(false);
  });
});
