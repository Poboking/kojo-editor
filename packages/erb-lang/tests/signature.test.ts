/**
 * `@kojo/erb-lang/signature` 的**搬家闸 + 取表缝闸**（LAU-1031-SIG，2026-10-31）。
 *
 * 判据本身（半角逗号切分 / 最内层未闭合括号 / 跨行回看 / 标签夹取）在宿主
 * `packages/app/tests/kojo-signature.test.ts` 里已有整组用例——那批用例经宿主 re-export
 * 打的就是本文件这枚叶，**一条判据没改，只换了住址**。因此本文件只钉搬家引入的**新面**，
 * 每组防一种真实退化：
 *
 * 1. **窗口入口与整篇入口等价**（`erbSignatureAt` ≡ `resolveSignatureInText`）：击键路径
 *    只切 `[line-64, line]` 的窗口，切错了会出现"同一个光标，窗口版和整篇版给不同签名"
 *    ——那种漂移的表现是"浮层偶尔少一个实参"，比不弹更难查；
 * 2. **回看封顶**（`SIGNATURE_LOOKBACK_LINES`）：窗口走满仍找不到调用起点 ⇒ `null`（不猜），
 *    边界两侧各一枚用例，防止有人把封顶改成"整篇扫"（大文件每键 O(n)）；
 * 3. **取表缝**（模块级登记表，范式照 `@kojo/kojo-lang/adapter-source`）：零登记 ⇒ 空表 ⇒
 *    整条能力零产出；后登记优先；getter 抛错 / 返回非对象 ⇒ 问下一枚；注销只撤自己。
 *    对应的真实事故是"上一个项目的表带进新项目"和"注销撤了别人的登记"。
 */
import type { KojoCallProtocol, KojoCallSlot } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  erbSignatureAt,
  erbSignatureNow,
  erbSignatureSourceCount,
  findCallSiteAt,
  registerErbSignatureSource,
  resolveSignatureInText,
  SIGNATURE_LOOKBACK_LINES,
  type ErbFunctionParamsResolver,
  type ErbSignatureTables,
} from '../src/signature';

/* ============================== 夹具 ============================== */

/** 协议桩：只认 `HUNT`（两槽）与 `DEEP`（三槽），其余回 `null`（协议不认识 ⇒ 不该答） */
const protocol: KojoCallProtocol = {
  slotsFor(functionName: string): readonly KojoCallSlot[] | null {
    if (functionName === 'HUNT') {
      return [
        { index: 0, kind: 'int', label: '对象' },
        { index: 1, kind: 'str', label: '备注' },
      ];
    }
    if (functionName === 'DEEP') {
      return [
        { index: 0, kind: 'int', label: '甲' },
        { index: 1, kind: 'int', label: '乙' },
        { index: 2, kind: 'int', label: '丙' },
      ];
    }
    return null;
  },
};

/** 用户函数形参桩：协议不认识时的第二查表面（形参名原文照抄） */
const paramsOf: ErbFunctionParamsResolver = (callee) =>
  callee === 'MYFUNC' ? [{ name: 'ARG' }, { name: 'ARGS:1 = 3' }] : null;

const TABLES: ErbSignatureTables = { callProtocol: protocol, paramsOf };

/**
 * 签名夹具：注释 / 声明 / 单行调用 / 跨行调用 / 字符串 / 用户函数 / 超发实参各占一格。
 * 列号在本文件反复引用（Monaco 1 基），改行文本请同步下面的用例。
 */
const TEXT = [
  '; 注释里的 CALL HUNT(1, 2) 不是调用', // 1
  '@FUNC(A, B)', // 2
  '    CALL HUNT(1, "甲,乙")', // 3  左括号在第 14 列
  '    CALL HUNT(', // 4  跨行起点（未闭合）
  '        7,', // 5  第 10 列停在逗号上 ⇒ 仍属第 0 参；第 11 列才切到第 1 参
  '        8)', // 6  收束
  '    PRINTL "字符串里的 ( 与 , 都不算"', // 7
  '    MYFUNC(1, 2)', // 8  协议不认识、形参表认识
  '    CALL DEEP(1, 2, 3, 4)', // 9  实参比声明槽多 ⇒ 夹到最后一格
].join('\n');

/* ============================== ① 窗口入口 ≡ 整篇入口 ============================== */

describe('erbSignatureAt 与 resolveSignatureInText 逐点等价（击键窗口不许造第二套答案）', () => {
  const SPOTS: ReadonlyArray<readonly [number, number]> = [
    [1, 1], // 注释行 ⇒ 两处都 null
    [3, 14], // 左括号那一列
    [3, 15], // 单行调用，落在第 0 参
    [3, 19], // 字符串字面量内 ⇒ null
    [3, 23], // 第 1 参（引号里的逗号不切）
    [3, 24], // 右括号之后 ⇒ 不在任何未闭合括号内 ⇒ null
    [4, 16], // 跨行调用的起点行（未闭合，光标在行尾之后）
    [5, 10], // 跨行：逗号那一列（仍算第 0 参）
    [5, 11], // 跨行：逗号之后 ⇒ 第 1 参
    [6, 12], // 跨行收束行的括号之外 ⇒ null
    [7, 20], // 字符串里的左括号不算调用 ⇒ null
    [8, 14], // 协议不认识、形参表认识
    [9, 24], // 实参比声明槽多 ⇒ 夹到最后一格
    [99, 1], // 光标行越界 ⇒ null
  ];

  for (const [line, column] of SPOTS) {
    it(`第 ${line} 行第 ${column} 列：两个入口读数一致`, () => {
      expect(erbSignatureAt(TEXT, line, column, TABLES)).toEqual(
        resolveSignatureInText(TEXT, line, column, protocol, paramsOf),
      );
    });
  }

  it('抽查三格的具体读数（防止两边一起错）', () => {
    expect(erbSignatureAt(TEXT, 3, 23, TABLES)).toEqual({
      callee: 'HUNT',
      signature: {
        label: 'HUNT(ARG:0 对象, ARGS:1 备注)',
        parameters: ['ARG:0 对象', 'ARGS:1 备注'],
        activeParameter: 1,
      },
    });
    // 跨行：逗号之后才切槽（与单行同一条归属判据，因为是同一个 findCallSite）
    expect(erbSignatureAt(TEXT, 5, 10, TABLES)?.signature.activeParameter).toBe(0);
    expect(erbSignatureAt(TEXT, 5, 11, TABLES)?.signature.activeParameter).toBe(1);
    // 超发实参夹到最后一个声明槽（不假造第 4 槽）
    expect(erbSignatureAt(TEXT, 9, 24, TABLES)?.signature.activeParameter).toBe(2);
  });

  it('光标行以下的内容零影响（窗口只读到光标行为止）', () => {
    const trimmed = TEXT.split('\n').slice(0, 5).join('\n');
    expect(erbSignatureAt(trimmed, 5, 11, TABLES)).toEqual(erbSignatureAt(TEXT, 5, 11, TABLES));
  });
});

/* ============================== ② 回看封顶 ============================== */

describe(`跨行回看封顶（SIGNATURE_LOOKBACK_LINES = ${SIGNATURE_LOOKBACK_LINES}）`, () => {
  /** 第 2 行开括号，中间垫 n 行无括号文本，光标在最后一行的第 10 列 */
  function build(padLines: number): { text: string; line: number; column: number } {
    const pad = Array.from({ length: padLines }, () => '        PRINTL filler');
    const lines = ['@FUNC(A, B)', '    CALL HUNT(', ...pad, '        9'];
    return { text: lines.join('\n'), line: lines.length, column: 10 };
  }

  it('恰好在窗口内（光标行与起点行相距 64 行）⇒ 照常应答，且与整篇入口同读数', () => {
    const spot = build(SIGNATURE_LOOKBACK_LINES - 1);
    expect(spot.line - 2).toBe(SIGNATURE_LOOKBACK_LINES);
    const windowed = erbSignatureAt(spot.text, spot.line, spot.column, { callProtocol: protocol });
    expect(windowed?.callee).toBe('HUNT');
    expect(windowed).toEqual(resolveSignatureInText(spot.text, spot.line, spot.column, protocol));
  });

  it('窗口走满仍找不到调用起点 ⇒ null（不猜、不越界扫全文），两个入口同判', () => {
    const spot = build(SIGNATURE_LOOKBACK_LINES);
    expect(spot.line - 2).toBe(SIGNATURE_LOOKBACK_LINES + 1);
    expect(erbSignatureAt(spot.text, spot.line, spot.column, { callProtocol: protocol })).toBeNull();
    expect(resolveSignatureInText(spot.text, spot.line, spot.column, protocol)).toBeNull();
  });

  it('长文件（200+ 行）里远处的未闭合括号不会被捡起来（同一枚封顶，不存在第二处写死的行数）', () => {
    const lines = ['    CALL HUNT(', ...Array.from({ length: 200 }, () => '        PRINTL x'), '    1'];
    const cursorLine = lines.length;
    expect(findCallSiteAt(lines, cursorLine - 1, 5)).toBeNull();
    expect(erbSignatureAt(lines.join('\n'), cursorLine, 5, { callProtocol: protocol })).toBeNull();
  });
});

/* ============================== ③ 取表缝（模块级登记表） ============================== */

describe('两张宿主表的登记表（adapter-source 同范式：零登记 ⇒ 零产出、后登记优先、抛错问下一枚）', () => {
  it('零登记 ⇒ erbSignatureNow() 是空对象，判据按默认表不应答（不是 undefined、不抛）', () => {
    expect(erbSignatureSourceCount()).toBe(0);
    expect(erbSignatureNow()).toEqual({});
    // 项目没开 / 装配没跑到 ⇒ 这一格给不出签名（**不猜**）
    expect(erbSignatureAt(TEXT, 3, 15)).toBeNull();
  });

  it('后登记的优先（最新装配的那一份才是当前的），注销只撤自己、重复注销幂等', () => {
    const first = registerErbSignatureSource(() => ({ callProtocol: protocol }));
    expect(erbSignatureSourceCount()).toBe(1);
    expect(erbSignatureNow().callProtocol).toBe(protocol);

    const other: KojoCallProtocol = { slotsFor: () => [{ index: 0, kind: 'int', label: '别的' }] };
    const second = registerErbSignatureSource(() => ({ callProtocol: other }));
    expect(erbSignatureSourceCount()).toBe(2);
    expect(erbSignatureNow().callProtocol).toBe(other);
    // 登记表确实进了击键路径的默认参数：这一格用的是后登记那枚表
    expect(erbSignatureAt(TEXT, 3, 15)?.signature.parameters).toEqual(['ARG:0 别的']);

    second();
    expect(erbSignatureSourceCount()).toBe(1);
    expect(erbSignatureNow().callProtocol).toBe(protocol);
    first();
    expect(erbSignatureSourceCount()).toBe(0);
    first();
    second();
    expect(erbSignatureSourceCount()).toBe(0);
  });

  it('getter 抛错 ⇒ 问下一枚；只剩会抛的一枚 ⇒ 空对象（异常不带进击键路径）', () => {
    const good = registerErbSignatureSource(() => ({ callProtocol: protocol }));
    const bad = registerErbSignatureSource(() => {
      throw new Error('桩：组合根正在重建');
    });
    expect(erbSignatureSourceCount()).toBe(2);
    expect(erbSignatureNow().callProtocol).toBe(protocol); // 后登记的那枚抛错 ⇒ 退回上一枚
    bad();
    expect(erbSignatureNow().callProtocol).toBe(protocol);
    good();
    const onlyBad = registerErbSignatureSource(() => {
      throw new Error('桩：全部取不出');
    });
    expect(erbSignatureNow()).toEqual({});
    onlyBad();
    expect(erbSignatureSourceCount()).toBe(0);
  });

  it('getter 返回非对象（null / undefined）⇒ 跳过这一枚，继续问下一枚', () => {
    const good = registerErbSignatureSource(() => ({ paramsOf }));
    const nul = registerErbSignatureSource(() => null as unknown as ErbSignatureTables);
    expect(erbSignatureNow().paramsOf).toBe(paramsOf);
    nul();
    good();
    expect(erbSignatureSourceCount()).toBe(0);
  });

  it('协议不认识 ⇒ paramsOf 兜底（形参原文照抄，不造 ARG:n 兜底名）', () => {
    const off = registerErbSignatureSource(() => TABLES);
    const hit = erbSignatureAt(TEXT, 8, 14);
    expect(hit).toEqual({
      callee: 'MYFUNC',
      signature: {
        label: 'MYFUNC(ARG, ARGS:1 = 3)',
        parameters: ['ARG', 'ARGS:1 = 3'],
        activeParameter: 1,
      },
    });
    off();
    expect(erbSignatureAt(TEXT, 8, 14)).toBeNull();
  });
});
