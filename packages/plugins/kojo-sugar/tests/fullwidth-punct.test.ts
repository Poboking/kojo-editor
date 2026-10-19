/**
 * 1019 批 P0 · 表达式里的全角标点（`：` / `＝`）——引擎不认，必须 **error + 拒绝落盘**。
 *
 * 两条历史缺陷（本文件的逐字复现）：
 * 1. `如果 CFLAG：1：2 == 0：` 编出 `IF CFLAG：1：2 == 0`——零诊断、坏字节；
 * 2. `CFLAG：1：2 ＝ 3` 被归成台词，编出 `PRINTFORMDW CFLAG：1：2 ＝ 3`——把赋值打印出去。
 *
 * 正例断言 `severity === 'error'`、`loc` 指到具体字符，且 `compileToBytes` 抛「编译被拒绝」；
 * 反例断言**零诊断**：块头末尾分隔冒号 / 台词正文 / 双引号串 / 行内注释 / 半角正常形。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { compileToBytes } from '../src/compile';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
/** 文档骨架：正文挂在 `时机 指令 310：` 之下（第 3 行起） */
const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;
const transpile = (src: string) => svc().transpile(src);
const punctOf = (src: string): SugarDiagnostic[] =>
  transpile(src).diagnostics.filter((d) => d.code === 'fullwidth-expr-punct');

/* ============================ 正例：4 条 ============================ */

describe('正例 · 全角标点 → fullwidth-expr-punct error + 拒绝产字节', () => {
  /** 断言：有诊断、全为 error、且编译闸抛「编译被拒绝」（既有拒绝通道，无第二条） */
  const rejected = (src: string): SugarDiagnostic[] => {
    const diags = punctOf(src);
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d.severity).toBe('error');
    expect(() => compileToBytes(svc().transpile, src)).toThrow(/编译被拒绝/);
    return diags;
  };

  it('条件内 `：`（旧缺陷逐字复现）：`如果 CFLAG：1：2 == 0：`', () => {
    const src = doc('    如果 CFLAG：1：2 == 0：\n        「甲」\n');
    const diags = rejected(src);
    expect(diags).toHaveLength(2); // 条件里的两个全角冒号
    for (const d of diags) {
      expect(d.message).toContain('全角「：」');
      expect(d.message).toContain('半角「:」');
    }
    // loc 指到**具体字符**：第 3 行第 13 列（`CFLAG` 后那个 `：`）
    expect(diags[0]!.loc).toEqual({ line: 3, column: 13 });
  });

  it('赋值 `＝`（旧缺陷：被当台词打印）：`CFLAG：1：2 ＝ 3`', () => {
    const src = doc('    CFLAG：1：2 ＝ 3\n');
    const diags = rejected(src);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('全角「＝」');
    expect(diags[0]!.message).toContain('半角「=」');
    expect(diags[0]!.loc).toEqual({ line: 3, column: 15 });
    // 不落 text：坏行不以台词形式进产物
    const erb = transpile(src).erb;
    expect(erb).not.toContain('PRINTFORMDW CFLAG：1：2 ＝ 3');
    expect(erb).not.toContain('CFLAG：1：2 ＝ 3');
  });

  it('两者混合：`如果 CFLAG：1：2 ＝ 0：`（两个 `：` + 一个 `＝`）', () => {
    const src = doc('    如果 CFLAG：1：2 ＝ 0：\n        「甲」\n');
    const diags = rejected(src);
    expect(diags).toHaveLength(3);
    expect(diags.some((d) => d.message.includes('全角「：」'))).toBe(true);
    expect(diags.some((d) => d.message.includes('全角「＝」'))).toBe(true);
  });

  it('带缩进：嵌套块里缩进更深的赋值行同样命中', () => {
    const src = doc('    如果 FLAG:1：\n        CFLAG：1：2 ＝ 3\n');
    const diags = rejected(src);
    expect(diags).toHaveLength(1);
    // 8 空格缩进 + `CFLAG：1：2`（9）+ 空格 → `＝` 在第 19 列
    expect(diags[0]!.loc).toEqual({ line: 4, column: 19 });
  });

  it('赋值语句里的全角冒号（半角等号）：`CFLAG：1：2 = 3`', () => {
    const src = doc('    CFLAG：1：2 = 3\n');
    const diags = rejected(src);
    expect(diags).toHaveLength(2); // assign.target 里的两个全角冒号
    for (const d of diags) expect(d.message).toContain('全角「：」');
  });

  it('索引 + 无空格全角等号：`CFLAG：1：2＝3`（索引形优先命中）', () => {
    const src = doc('    CFLAG：1：2＝3\n');
    const diags = rejected(src);
    expect(diags.some((d) => d.message.includes('全角「＝」'))).toBe(true);
  });

  it('中文变量名 + 空格 + 全角等号：`順位 ＝ 3`（保守赋值形，不许静默进台词）', () => {
    const src = doc('    順位 ＝ 3\n');
    const diags = rejected(src);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('全角「＝」');
  });
});

/* ============================ 反例：5 条（零报） ============================ */

describe('反例 · 五类写法必须零报', () => {
  /** 断言：无 fullwidth-expr-punct、且整份文件零 error */
  const clean = (src: string): void => {
    const diags = transpile(src).diagnostics;
    expect(diags.filter((d) => d.code === 'fullwidth-expr-punct')).toEqual([]);
    expect(diags.filter((d) => d.severity === 'error')).toEqual([]);
  };

  it('块头：`时机 …：` / `如果 …：` 末尾的全角冒号是分隔符，不是表达式', () => {
    clean(doc('    如果 TFLAG:193：\n        「甲」\n'));
  });

  it('台词正文含 `：` / `＝`（「…」开头，保守赋值形不误伤）', () => {
    clean(doc('    「她的心情：很好，Ａ＝Ｂ」\n'));
  });

  it('双引号串里的全角标点：表达式扫描跳过字面量内部', () => {
    clean(doc('    如果 TFLAG:193 == "Ａ：Ｂ＝３"：\n        「甲」\n'));
  });

  it('行内注释里的全角标点：扫的是去注释后的表达式切片', () => {
    clean(doc('    她的心情 = 1 ; 备注：全角 ＝ 号\n'));
  });

  it('半角正常形 `CFLAG:1:2` 零诊断、正常产字节', () => {
    const src = doc('    如果 CFLAG:1:2 == 0：\n        「甲」\n');
    clean(src);
    const bytes = compileToBytes(svc().transpile, src);
    expect(bytes.bytes.length).toBeGreaterThan(0);
  });

  it('裸旁白里的 `＝`（无索引、无空格）不误伤：`比叡山＝延暦寺`', () => {
    clean(doc('    比叡山＝延暦寺\n'));
  });
});
