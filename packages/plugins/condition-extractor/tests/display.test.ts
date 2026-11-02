/**
 * 显示行扫描单测（v0.3 口上调试统一批；纯函数）。
 *
 * 覆盖：PRINT 系动词识别 / FORM 族才扫插值（普通 PRINT 的 `%` 是字面量）/
 * 三种插值切片（`%…%`、`{…}`、`\@…?…#…\@`）的**偏移契约**（回放侧只按
 * `start/end` 切片，偏移错一位就是错字）/ 行内注释截断 / `SIF` 同行守卫 /
 * `PRINTDATA` 块与 `[SKIPSTART]` 停用区跳过。
 */
import { describe, expect, it } from 'vitest';
import { collectDisplayLines } from '../src/display';

/** 把函数体行数组当整份文件（1 基取行）扫一遍 */
function scan(body: string[]) {
  return collectDisplayLines(body, 1, body.length);
}

/** 按切片重建文本（与回放侧同判据；`start/end` 若错位这里立刻现形） */
function render(payload: string, interps: { start: number; end: number }[], repl: string[]): string {
  let out = '';
  let cursor = 0;
  interps.forEach((it, i) => {
    out += payload.slice(cursor, it.start) + (repl[i] ?? '');
    cursor = it.end;
  });
  return out + payload.slice(cursor);
}

describe('PRINT 动词识别', () => {
  it('收 PRINT / PRINTL / PRINTFORM 族，载荷与动词分开', () => {
    const got = scan(['PRINTL 你好', 'PRINTFORMW 再见']);
    expect(got.map((d) => [d.verb, d.payload, d.line])).toEqual([
      ['PRINTL', '你好', 1],
      ['PRINTFORMW', '再见', 2],
    ]);
  });

  it('非 PRINT 语句 / 注释 / 指令 / 标签行一律不收', () => {
    const got = scan(['; 注释', '#DIM X, 1', '@TEST', '$LABEL', 'CALL FOO', '', 'PRINTL 收']);
    expect(got).toHaveLength(1);
    expect(got[0]!.line).toBe(7);
  });

  it('`PRINTX1` 这类标识符不当动词（词尾必须断开）', () => {
    expect(scan(['PRINTX1 1'])).toHaveLength(0);
  });

  it('行内注释截断（引号外的 `;`）', () => {
    const got = scan(['PRINTL 你好 ;这是注释']);
    expect(got[0]!.payload).toBe('你好');
  });

  it('引号内的 `;` 不截断', () => {
    const got = scan(['PRINTFORM "a;b"']);
    expect(got[0]!.payload).toBe('"a;b"');
  });
});

describe('插值切片', () => {
  it('普通 PRINT 不扫插值（`%` 是字面量，引擎语义）', () => {
    const got = scan(['PRINTL 好感是%CFLAG:1%']);
    expect(got[0]!.interpolations).toEqual([]);
  });

  it('FORM 族扫 `%…%`，偏移按载荷坐标系且能原样重建', () => {
    const got = scan(['PRINTFORM 好感%CFLAG:1%点']);
    const d = got[0]!;
    expect(d.interpolations).toHaveLength(1);
    expect(d.interpolations[0]!.form).toBe('percent');
    expect(d.interpolations[0]!.text).toBe('CFLAG:1');
    expect(render(d.payload, d.interpolations, ['500'])).toBe('好感500点');
  });

  it('`%%` 按字面量豁免（不产假插值）', () => {
    const got = scan(['PRINTFORM 进度%%100']);
    expect(got[0]!.interpolations).toEqual([]);
  });

  it('未闭合的 `%` 按字面量（不猜）', () => {
    const got = scan(['PRINTFORM 半截%CFLAG:1']);
    expect(got[0]!.interpolations).toEqual([]);
  });

  it('FORM 族扫 `{…}`（引擎 FORM 串另一写法）', () => {
    const got = scan(['PRINTFORM {CFLAG:1}+{CFLAG:2}']);
    const d = got[0]!;
    expect(d.interpolations.map((i) => i.form)).toEqual(['brace', 'brace']);
    expect(render(d.payload, d.interpolations, ['1', '2'])).toBe('1+2');
  });

  it('文本三元整枚切片：条件半边 + 真假两支文本', () => {
    const got = scan(['PRINTFORM \\@CFLAG:1>50?高#低\\@']);
    const d = got[0]!;
    expect(d.interpolations).toHaveLength(1);
    const it0 = d.interpolations[0]!;
    expect(it0.form).toBe('inlineTernary');
    expect(it0.text).toBe('CFLAG:1>50');
    expect(it0.thenText).toBe('高');
    expect(it0.elseText).toBe('低');
    expect(it0.start).toBe(0);
    expect(it0.end).toBe(d.payload.length);
  });

  it('文本三元缺 `#`：假支为空串（引擎语义"假支不输出"）', () => {
    const got = scan(['PRINTFORM \\@FLAG:1?只有真支\\@']);
    expect(got[0]!.interpolations[0]!.elseText).toBe('');
  });

  it('文本三元缺 `?` → 整枚按字面量（不猜）', () => {
    const got = scan(['PRINTFORM \\@FLAG:1没有问号\\@']);
    expect(got[0]!.interpolations).toEqual([]);
  });
});

describe('SIF 同行守卫', () => {
  it('`SIF 条件 PRINT…` 收成带守卫的显示行，载荷从语句起点起算', () => {
    const got = scan(['SIF CFLAG:1 > 50 PRINTFORML 好感%CFLAG:1%']);
    expect(got).toHaveLength(1);
    const d = got[0]!;
    expect(d.sifGuarded).toBe(true);
    expect(d.verb).toBe('PRINTFORML');
    expect(d.payload).toBe('好感%CFLAG:1%');
    expect(render(d.payload, d.interpolations, ['500'])).toBe('好感500');
  });

  it('条件里的字符串含 "PRINT" 时不误切（引号内不算语句起点）', () => {
    const got = scan(['SIF NAME == "PRINTL" PRINTFORML 正文']);
    expect(got[0]!.payload).toBe('正文');
  });

  it('SIF 后不是 PRINT 语句 → 本行无显示行', () => {
    expect(scan(['SIF FLAG:1 CALL FOO'])).toHaveLength(0);
  });

  it('`SIF` 单独成行不产生显示行、也不"守"下一行（引擎语义：SIF 只管同行）', () => {
    const got = scan(['SIF FLAG:1', 'PRINTL 下一行']);
    expect(got).toHaveLength(1);
    expect(got[0]!.line).toBe(2);
    expect(got[0]!.sifGuarded).toBeUndefined();
  });
});

describe('停用区 / 数据块', () => {
  it('[SKIPSTART]…[SKIPEND] 之间的 PRINT 不收', () => {
    const got = scan(['[SKIPSTART]', 'PRINTL 死文本', '[SKIPEND]', 'PRINTL 活的']);
    expect(got.map((d) => d.payload)).toEqual(['活的']);
  });

  it('PRINTDATA 块体行整块跳过（块体是数据不是语句）', () => {
    const got = scan(['PRINTDATAL', '你好', 'DATAFORM 再见', 'ENDDATA', 'PRINTL 块外']);
    expect(got.map((d) => d.payload)).toEqual(['块外']);
  });
});

describe('韧性', () => {
  it('行区间越界不抛（截到文件尾）', () => {
    expect(() => collectDisplayLines(['PRINTL a'], 1, 99)).not.toThrow();
    expect(collectDisplayLines(['PRINTL a'], 1, 99)).toHaveLength(1);
  });

  it('给了 contextOf 就带上下文路径', () => {
    const got = collectDisplayLines(['PRINTL a'], 1, 1, () => ['IF FLAG:1']);
    expect(got[0]!.context).toEqual(['IF FLAG:1']);
  });
});
