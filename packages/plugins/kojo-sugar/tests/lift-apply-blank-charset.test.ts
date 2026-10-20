/**
 * CHARSET-SS 收口（2026-10-20）· `lift-apply.ts` 的第四份手写空白判定退出历史。
 *
 * 收口前该文件自带三件行工具：`leadOf`（`[ \t\u3000]*`）、`indentOf`（同集合同折算）、
 * `isBlank`（`line.trim().length === 0`，JS **宽集**：NBSP / EM SPACE 也算空白）。
 * 前两件与 `blank-charset.ts` 的 `leadingBlank` / `indentLevelOf` 同集合同折算，
 * 换手**无损**；第三件的宽集与单源口径（`[ \t\u3000]`，NBSP 是内容不是排版）不同，
 * 差异只落在**文件头声明区**的扫描/插入点上——见下面第一组用例（**先红**：
 * 旧口径会跨过 NBSP/EM SPACE 独占行，把 `旁白色:` 插到它后面）。
 *
 * 本文件钉住三件事：
 * 1. NBSP / EM SPACE 独占行是**正文**——文件头到此为止，补声明插在它之前；
 * 2. 这类行在写回时**逐字节保留**（不被清空、不被当成缩进）；
 * 3. 全角空格缩进的写回仍是全角单位（换手不改产物；TAB / 4 空格由
 *    `lift-apply.test.ts` 的逐条 `toBe` 覆盖）。
 *
 * 既有 lift fixtures 零 NBSP，本文件的第 2 组补上 NBSP / EM SPACE 行的逐字节证据。
 */

import { describe, expect, it } from 'vitest';
import type { SugarTranspileResult } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { liftSuggest, type LiftDeps } from '../src/lift';
import { applyLift } from '../src/lift-apply';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

const NBSP = '\u00a0'; // 不换行空格（**不是**空白）
const EM_SP = '\u2003'; // EM SPACE（**不是**空白）

const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '名字') return 'CALLNAME';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (['CFLAG', 'TALENT', 'ABL', 'FLAG', 'TFLAG', 'CALLNAME', 'NAME'].includes(head)) return ident;
    return undefined;
  },
};

const deps = (): LiftDeps => ({
  transpile: (source, options): SugarTranspileResult =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(source, options),
});

/** 对一份源文本做升糖扫描，返回候选（供应用用例的输入） */
const scan = (source: string) => liftSuggest(deps(), { source });

describe('CHARSET-SS / 文件头：NBSP / EM SPACE 独占行是正文，不是空白行', () => {
  /**
   * 先红用例（收口前 `isBlank` 走 `trim()` 宽集）：`//` 头注之后跟一行 NBSP /
   * EM SPACE，旧口径把它当空白行跨过去，`旁白色:` 会插在它**后面**；单源口径把它
   * 当正文（`isAllBlank` 为 false），声明区在它处结束，声明插在它**前面**。
   */
  it.each([
    ['NBSP', NBSP],
    ['EM SPACE', EM_SP],
  ])('%s 独占行：补声明插在它之前（旧 trim 口径会插在它之后）', (_name, ch) => {
    const source = ['// 头注', ch, '时机 指令 1：', '\tPRINTFORML 她红着脸，小声嘟囔着。', ''].join('\n');
    const r = scan(source);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.narrationColor).toBe('作者色');

    const out = applyLift({ source, candidates: r.candidates });
    expect(out.frontMatterChanged).toBe(true);
    expect(out.text.split('\n').slice(0, 4)).toEqual(['// 头注', '旁白色: 作者色', ch, '时机 指令 1：']);
  });
});

describe('CHARSET-SS / 写回：NBSP / EM SPACE 行逐字节保留', () => {
  it.each([
    ['NBSP', NBSP],
    ['EM SPACE', EM_SP],
  ])('候选区间之外的 %s 独占行不被清空、不被当缩进吃掉', (_name, ch) => {
    const source = [
      '角色: 1',
      '时机 指令 1：',
      '\tPRINTFORMDW 她看起来很高兴。',
      ch,
      '\tPRINTFORMDW 甲。',
      '',
    ].join('\n');
    const r = scan(source);
    expect(r.candidates).toHaveLength(2);

    const out = applyLift({ source, candidates: r.candidates });
    const lines = out.text.split('\n');
    expect(lines).toEqual(['角色: 1', '时机 指令 1：', '\t她看起来很高兴。', ch, '\t甲。', '']);
    // 逐字节：未触碰的行原样（NBSP / EM SPACE 既不是排版也不是缩进）
    expect(lines[3]).toBe(ch);
  });
});

describe('CHARSET-SS / 无损换手：缩进写法按源文件自己的单位平移', () => {
  it('全角空格缩进：写回仍是全角单位（`leadingBlank` / `indentLevelOf` 与旧手抄同判）', () => {
    const FF2 = '\u3000\u3000';
    const source = ['角色: 12', '时机 初见：', `${FF2}PRINTFORMW 「甲」`, ''].join('\n');
    const r = scan(source);
    expect(r.candidates).toHaveLength(1);

    const out = applyLift({ source, candidates: r.candidates });
    expect(out.text).toBe(['角色: 12', '时机 初见：', `${FF2}「甲」`, ''].join('\n'));
    expect(out.text.split('\n')[2]).toBe(`${FF2}「甲」`);
  });
});
