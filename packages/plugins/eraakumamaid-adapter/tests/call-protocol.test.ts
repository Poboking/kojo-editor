/**
 * 口上调用协议解析单测（eraAkumaMaid；合成路由文本 + FileIO stub，形态照 eratw-adapter）。
 *
 * 覆盖：模板 → 正则转换（中段 / 尾部 / 字面转义 / 数值段消歧）/ 槽位类型与按序绑定 /
 * 同模板多行取槽位最多 / `, ARGS`·`, LOCALS` 修饰后缀不污染模板（本游戏特有）/
 * 引擎自有行（COM_ABLE）跳过 / literalLen 优先级 / 协议不认识返回 null /
 * deriveCallContext 只填确定事实 / 文件缺失与 BOM 降级。
 *
 * ROUTE = ERB/EVENT_K/EVENT_K.ERB 实测路由行逐行抄录（16 条口上 + 2 条引擎自有）；
 * ROUTE2 / ROUTE3 = 合成（eraAkumaMaid 实测路由零具名转发，具名转发 / 具体性等
 * 结构能力用合成文本验证——与 eratw 同口径）。
 */
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadErakumamaidCallProtocol } from '../src/call-protocol';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ioWith(text: string): FileIO {
  return {
    readText: async () => ({ text, encoding: 'utf-8', eol: '\n' }),
  } as unknown as FileIO;
}

/** ERB/EVENT_K/EVENT_K.ERB 实测路由行（逐行抄录；含 2 条引擎自有 COM_ABLE 与
 *  重复 3 次的 KOJO_MESSAGE_COM 模板、5 条带 `, ARGS`/`, LOCALS` 修饰的行） */
const ROUTE = `
;====================================================================
;口上有無を行数でチェック（实测形态抄录）
;====================================================================
	TRYCALLFORM KOJO_MESSAGE_COMING_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}
	TRYCALLFORM COM_ABLE{TEQUIP:シックスナイン}
	TRYCALLFORM COM_ABLE{TEQUIP:PLAYER:シックスナイン}
	TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}
	TRYCALLFORM KOJO_ENDCOM_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_BEFORE_COM_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_PALAMCNG_K{NO:TARGET}, LOCALS
	TRYCALLFORM KOJO_MESSAGE_SAMEN_AND_EXTACY_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_DAISYUKI_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_SHOOT_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_AFTERSHOOTCHANGE_K{NO:TARGET}
	TRYCALLFORM KOJO_MESSAGE_BEFORE_TARGETSHOOT_K{NO:TARGET}
	TRYCALLFORM KOJO_COUNTER_K{NO:TARGET}, ARGS
	TRYCALLFORM KOJO_MESSAGE_MARKCNG_K{NO:TARGET}, ARGS
	TRYCALLFORM KOJO_EVENT_K{NO:TARGET}, ARGS
	TRYCALLFORM KOJO_GUEST_K{NO:TARGET}, ARGS
`;

describe('loadErakumamaidCallProtocol —— 实测路由（EVENT_K.ERB 抄录）', () => {
  async function proto(text: string = ROUTE) {
    const p = await loadErakumamaidCallProtocol({ io: ioWith(text), routeFile: 'EVENT_K.ERB', log: silentLog });
    expect(p).toBeTruthy();
    return p!;
  }

  it('实测路由家族函数 → 空槽位表（协议认识、零具名转发——实测读数）', async () => {
    const p = await proto();
    // 14 个去重口上家族模板逐一验证（实测零 `(ARG…)` 转发 ⇒ 恒空槽）
    const names = [
      'KOJO_MESSAGE_COMING_K1',
      'KOJO_MESSAGE_COM_K1',
      'KOJO_ENDCOM_K1',
      'KOJO_MESSAGE_BEFORE_COM_K1',
      'KOJO_MESSAGE_PALAMCNG_K1',
      'KOJO_MESSAGE_SAMEN_AND_EXTACY_K1',
      'KOJO_MESSAGE_DAISYUKI_K1',
      'KOJO_MESSAGE_SHOOT_K1',
      'KOJO_MESSAGE_AFTERSHOOTCHANGE_K1',
      'KOJO_MESSAGE_BEFORE_TARGETSHOOT_K1',
      'KOJO_COUNTER_K49',
      'KOJO_MESSAGE_MARKCNG_K2',
      'KOJO_EVENT_K1',
      'KOJO_GUEST_K1',
    ];
    for (const name of names) {
      const slots = p.slotsFor(name);
      expect(slots, name).not.toBeNull();
      expect(slots, name).toHaveLength(0);
    }
  });

  it('`, ARGS` / `, LOCALS` 修饰后缀不污染模板（本游戏特有：逗号处截断）', async () => {
    const p = await proto();
    // 无截断时模板会变成 `KOJO_COUNTER_K{NO:TARGET},`（带尾逗号）⇒ 永远配不上函数名
    expect(p.slotsFor('KOJO_COUNTER_K1')).not.toBeNull();
    expect(p.slotsFor('KOJO_MESSAGE_PALAMCNG_K1')).not.toBeNull();
    expect(p.slotsFor('KOJO_EVENT_K1')).not.toBeNull();
    expect(p.slotsFor('KOJO_GUEST_K1')).not.toBeNull();
  });

  it('引擎自有行（COM_ABLE{TEQUIP:…}，无 `_K{` 家族锚）→ 跳过', async () => {
    const p = await proto();
    expect(p.slotsFor('COM_ABLE99')).toBeNull();
    expect(p.slotsFor('COM_ABLE{TEQUIP:シックスナイン}')).toBeNull();
  });

  it('同模板多行（KOJO_MESSAGE_COM ×3）→ 去重后仍认识', async () => {
    const p = await proto();
    expect(p.slotsFor('KOJO_MESSAGE_COM_K1')).not.toBeNull();
  });

  it('协议不认识的函数 → null', async () => {
    const p = await proto();
    expect(p.slotsFor('KOJO_MESSAGE_UNKNOWN_K1')).toBeNull();
    expect(p.slotsFor('TRAIN_MESSAGE_C')).toBeNull();
    expect(p.slotsFor('M_KOJO_K49_完全无关函数')).toBeNull();
  });

  it('尾段严格锚定（`\\d+$`）：`_1` 时机后缀形态不可达 ⇒ 不匹配', async () => {
    const p = await proto();
    // 实测：路由只生成 `KOJO_MESSAGE_COM_K{角色号}`；`15 槞彁/遺産` 里旧系统残留的
    // `@KOJO_MESSAGE_COM_K15_1` 无对应路由模板（EVENT_K.ERB 全文无时机号路由）
    expect(p.slotsFor('KOJO_MESSAGE_COM_K15_1')).toBeNull();
    expect(p.slotsFor('KOJO_MESSAGE_COM_K15')).not.toBeNull();
  });

  it('maxForwardedSlotsFor：`, ARGS` 折算 1 串槽；协议不认识 → null', async () => {
    const p = await proto();
    // `TRYCALLFORM KOJO_EVENT_K{NO:TARGET}, ARGS`：整数组透传 = 被调方 1 个字符串槽
    // （不是具名转发，但确实是转发——覆盖校验必须计入，否则全语料误报 369 条）
    expect(p.maxForwardedSlotsFor('KOJO_EVENT_K1')).toEqual({ int: 0, str: 1 });
    // 无修饰后缀的口上家族（`TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}`）
    expect(p.maxForwardedSlotsFor('KOJO_MESSAGE_COM_K1')).toEqual({ int: 0, str: 0 });
    expect(p.maxForwardedSlotsFor('COM_ABLE99')).toBeNull();
  });

  it('deriveCallContext：实测路由零具名转发 ⇒ 无确定事实，恒 undefined（不猜）', async () => {
    const p = await proto();
    expect(p.deriveCallContext!('KOJO_EVENT_K1', 49)).toBeUndefined();
    expect(p.deriveCallContext!('KOJO_MESSAGE_COM_K1', 1)).toBeUndefined();
    expect(p.deriveCallContext!('KOJO_GUEST_K1', 7)).toBeUndefined();
  });

  it('routeDigest：同内容同摘要、异内容异摘要', async () => {
    const p1 = await proto();
    const p2 = await proto();
    const p3 = await proto(ROUTE + '\tTRYCALLFORM KOJO_EXTRA_K{NO:TARGET}\n');
    expect(typeof p1.routeDigest).toBe('string');
    expect(p1.routeDigest).toBe(p2.routeDigest);
    expect(p1.routeDigest).not.toBe(p3.routeDigest);
  });

  it('UTF-8-BOM 正文正常解析（实测本游戏 ERB 均带 BOM）', async () => {
    const p = await proto('\uFEFF' + ROUTE);
    expect(p.slotsFor('KOJO_MESSAGE_COM_K1')).not.toBeNull();
  });

  it('注释行中的 CALLFORM 不解析', async () => {
    const p = await proto(ROUTE + ';TRYCALLFORM KOJO_DEAD_K{NO:TARGET}\n');
    expect(p.slotsFor('KOJO_DEAD_K1')).toBeNull();
  });

  it('文件缺失 → undefined（优雅降级）', async () => {
    const io = {
      readText: async () => {
        throw new Error('ENOENT');
      },
    } as unknown as FileIO;
    const p = await loadErakumamaidCallProtocol({ io, routeFile: 'missing.ERB', log: silentLog });
    expect(p).toBeUndefined();
  });

  it('无口上家族模板（空正文 / 仅引擎自有行）→ undefined', async () => {
    expect(await loadErakumamaidCallProtocol({ io: ioWith(''), routeFile: 'x', log: silentLog })).toBeUndefined();
    expect(
      await loadErakumamaidCallProtocol({
        io: ioWith('\tTRYCALLFORM COM_ABLE{TEQUIP:シックスナイン}\n'),
        routeFile: 'x',
        log: silentLog,
      }),
    ).toBeUndefined();
  });
});

/** 具体性 / TRYC 系关键字 / 覆盖语义（maxForwardedSlotsFor）/ 模板→正则细节 */
const ROUTE2 = `
	TRYCALLFORM KOJO_EVENT_K{NO:TARGET}
	TRYCALLFORM KOJO_DAILY_EVENT_K{NO:TARGET}(ARG:2,ARG:3,ARG:4,ARG:5,ARG:6,ARGS:1,ARGS:2)
	TRYCALLFORM KOJO_EVENT_K{NO:TARGET}_26_1(ARGS:1)
	TRYCCALLFORM KOJO_EVENT_K{NO:TARGET}_ONABARE_{ARG:1}(ARG:3)
	TRYCCALLFORM KOJO_EVENT_K{NO:TARGET}_ONABARE_{ARG:1}(ARG:3, ARG:4, ARG:5, ARG:6)
	TRYCCALLFORM KOJO_EVENT_K{NO:TARGET}_CHILD_%ARGS:1%
	TRYCCALLFORM KOJO_EVENT_K{NO:TARGET}_CHILD_DAILY_口上手紙(ARG:3)
	TRYCALLFORM KOJO_A_%X%_K{NO:TARGET}(ARG:1)
	TRYCALLFORM KOJO_A_B_%X%_K{NO:TARGET}(ARG:1,ARG:2)
	TRYCALLFORM KOJO_W_K{NO:TARGET}(ARG:1)
	TRYCALLFORM KOJO_W_K{NO:TARGET}_%Y%(ARGS:1)
	TRYCALLFORM KOJO_T_K{NO:TARGET}(ARG:1)
	TRYCALLFORM KOJO_T_K{NO:TARGET}%Y%(ARGS:1)
	TRYCALLFORM KOJO_N_K{NO:TARGET}_M{ARG:1}
	CALLFORM KOJO_A.B_C_K{NO:TARGET}
	TRYCALLFORM KOJO_DUP_K{NO:TARGET}(ARG:1)
	TRYCALLFORM KOJO_DUP_K{NO:TARGET}(ARG:1,ARG:2)
	TRYCALLFORM KOJO_MIX_K{NO:TARGET}(ARG:1, OVERRIDE_TARGET, ARG:2)
	TRYCALLFORM KOJO_M_%X%_K{NO:TARGET}
`;

describe('loadErakumamaidCallProtocol —— 模板→正则与槽位绑定', () => {
  async function proto2() {
    const p = await loadErakumamaidCallProtocol({ io: ioWith(ROUTE2), routeFile: 'EVENT_K.ERB', log: silentLog });
    expect(p).toBeTruthy();
    return p!;
  }

  it('尾部 `{NO:TARGET}` → `\\d+`（角色号；非 eratw 的数值时机号）', async () => {
    const p = await proto2();
    expect(p.slotsFor('KOJO_EVENT_K1')).not.toBeNull();
    expect(p.slotsFor('KOJO_EVENT_K49')).not.toBeNull();
    expect(p.slotsFor('KOJO_EVENT_KABC')).toBeNull(); // 角色号恒数值
  });

  it('中段 `{…}` 同为数值通配；中段 `%…%` 为任意文本', async () => {
    const p = await proto2();
    // 中段内嵌表达式（合成；实测路由无中段 {…}）→ \d+
    expect(p.slotsFor('KOJO_N_K1_M2')).not.toBeNull();
    expect(p.slotsFor('KOJO_N_K1_MX')).toBeNull();
    // 中段插值 → .+
    expect(p.slotsFor('KOJO_M_ANY_K1')).not.toBeNull();
    expect(p.slotsFor('KOJO_M_口上名_K49')).not.toBeNull();
  });

  it('字面转义：模板里的 `.` 不配任意字符', async () => {
    const p = await proto2();
    expect(p.slotsFor('KOJO_A.B_C_K1')).not.toBeNull();
    expect(p.slotsFor('KOJO_AXB_C_K1')).toBeNull();
  });

  it('字面最长优先：互相包含的模板取最具体（`%…%` 中段可吞掉更短模板的字面）', async () => {
    const p = await proto2();
    // KOJO_A_%X%_K…（字面 9）与 KOJO_A_B_%X%_K…（字面 11）都命中 → 取字面更长的（2 槽）
    const slots = p.slotsFor('KOJO_A_B_C_K1');
    expect(slots).toHaveLength(2);
    expect(slots!.every((s) => s.kind === 'int')).toBe(true);
  });

  it('同字面长时数值段模板优先（尾部 `{NO:TARGET}` 胜过尾部 `%Y%`）', async () => {
    const p = await proto2();
    // 数值时机名（合成）：只命中 `{NO:TARGET}` 尾模板 → 1 int 槽
    const numeric = p.slotsFor('KOJO_W_K7');
    expect(numeric).toHaveLength(1);
    expect(numeric![0]).toMatchObject({ index: 0, kind: 'int' });
    // 字符串时机名（`_%Y%` 尾，合成）：只命中 `.+` 尾模板 → 1 str 槽
    const str = p.slotsFor('KOJO_W_K7_口上手紙');
    expect(str).toHaveLength(1);
    expect(str![0]).toMatchObject({ index: 0, kind: 'str' });
    // 同字面长（均 8）且两个模板都命中（KOJO_T_K77：`\d+` 吞 77 / `\d+`+`.+` 吞 7+7）
    // → numericTail 消歧取数值段模板（1 int 槽）
    const tie = p.slotsFor('KOJO_T_K77');
    expect(tie).toHaveLength(1);
    expect(tie![0]).toMatchObject({ index: 0, kind: 'int' });
  });

  it('槽位按序绑定：ARG→int 槽 / ARGS→str 槽（混合 5+2）', async () => {
    const p = await proto2();
    // AM 路由模板不含时机号段 ⇒ 函数名到角色号为止（实测主流形态）
    const slots = p.slotsFor('KOJO_DAILY_EVENT_K1');
    expect(slots).toHaveLength(7);
    expect(slots!.filter((s) => s.kind === 'int')).toHaveLength(5);
    expect(slots!.filter((s) => s.kind === 'str')).toHaveLength(2);
    expect(slots!.slice(0, 5).every((s, i) => s.kind === 'int' && s.index === i)).toBe(true);
    expect(slots!.slice(5).every((s, i) => s.kind === 'str' && s.index === i)).toBe(true);
    expect(slots![0]!.label).toContain('ARG:2');
  });

  it('非平凡实参（OVERRIDE_TARGET）→ 不建模（按序绑定其余槽）', async () => {
    const p = await proto2();
    const slots = p.slotsFor('KOJO_MIX_K5');
    expect(slots).toHaveLength(2);
    expect(slots!.every((s) => s.kind === 'int')).toBe(true);
  });

  it('TRYC 系关键字（TRYCCALLFORM）：同模板多行取槽位更多者', async () => {
    const p = await proto2();
    const slots = p.slotsFor('KOJO_EVENT_K1_ONABARE_3');
    expect(slots).toHaveLength(4); // 1 槽与 4 槽两条同模板 → 取 4
    expect(slots!.every((s) => s.kind === 'int')).toBe(true);
  });

  it('同模板多行取槽位更多（DUP：1 槽 vs 2 槽）', async () => {
    const p = await proto2();
    expect(p.slotsFor('KOJO_DUP_K1')).toHaveLength(2);
  });

  it('maxForwardedSlotsFor：逐类取所有匹配模板的最大值（存在性覆盖）', async () => {
    const p = await proto2();
    // CHILD 通用模板 0 槽 + CHILD_DAILY 字面 1 数值槽 → 逐类最大 1 数值
    expect(p.maxForwardedSlotsFor('KOJO_EVENT_K1_CHILD_DAILY_口上手紙')).toEqual({ int: 1, str: 0 });
    // 仅命中 0 槽通用模板 → 全 0（协议认识，但无任何转发）
    expect(p.maxForwardedSlotsFor('KOJO_EVENT_K1_CHILD_FOO')).toEqual({ int: 0, str: 0 });
    // ONABARE 同模板合并为 4 数值
    expect(p.maxForwardedSlotsFor('KOJO_EVENT_K1_ONABARE_3')).toEqual({ int: 4, str: 0 });
    // _26_1：字面模板 1 字符串（AM 无 %…% 前缀通配 ⇒ 通用模板不命中它）
    expect(p.maxForwardedSlotsFor('KOJO_EVENT_K1_26_1')).toEqual({ int: 0, str: 1 });
    // DAILY_EVENT：字面 5 数值 + 2 字符串
    expect(p.maxForwardedSlotsFor('KOJO_DAILY_EVENT_K1')).toEqual({ int: 5, str: 2 });
    // W：数值名只命中 `{NO:TARGET}` 模板（1 int）；字符串时机名只命中 `_%Y%` 模板（1 str）
    expect(p.maxForwardedSlotsFor('KOJO_W_K7')).toEqual({ int: 1, str: 0 });
    expect(p.maxForwardedSlotsFor('KOJO_W_K7_口上手紙')).toEqual({ int: 0, str: 1 });
  });

  it('maxForwardedSlotsFor：协议不认识的函数 → null', async () => {
    const p = await proto2();
    expect(p.maxForwardedSlotsFor('KOJO_UNKNOWN_K49')).toBeNull();
  });
});

/** 调用上下文推导（HK-20）：只填**确定事实**，场景输入不猜 */
describe('deriveCallContext —— 确定槽值推导', () => {
  const ROUTE3 = `
	TRYCALLFORM KOJO_SPEAK_K{NO:TARGET}(ARG:2, ARG:3)
	TRYCALLFORM KOJO_STRFIRST_K{NO:TARGET}(ARGS:1, ARGS:2, ARG:2)
	TRYCALLFORM KOJO_EVENT_K{NO:TARGET}
	TRYCALLFORM KOJO_EVENT_K{NO:TARGET}, ARGS
`;
  async function proto3() {
    const p = await loadErakumamaidCallProtocol({ io: ioWith(ROUTE3), routeFile: 'EVENT_K.ERB', log: silentLog });
    expect(p).toBeTruthy();
    return p!;
  }

  it('路由转发 ARG:2（= 発言者 = {NO:TARGET}）的槽 → 回放角色号；场景槽保持 undefined', async () => {
    const p = await proto3();
    const ctx = p.deriveCallContext!('KOJO_SPEAK_K1', 49);
    expect(ctx).toBeTruthy();
    expect(ctx!.ints?.[0]).toBe(49);
    expect(ctx!.ints?.[1]).toBeUndefined();
  });

  it('字符串槽在前（IRAI 形态）：数值 slot0 ← ARG:2 → 角色号', async () => {
    const p = await proto3();
    const ctx = p.deriveCallContext!('KOJO_STRFIRST_K1', 12);
    expect(ctx!.ints?.[0]).toBe(12);
    expect(ctx!.strs?.[0]).toBeUndefined(); // ARGS:1 = 场景输入
    expect(ctx!.strs?.[1]).toBeUndefined();
  });

  it('无 ARG:2 转发的路由 → undefined（无确定事实，不猜）', async () => {
    const p = await proto3();
    expect(p.deriveCallContext!('KOJO_EVENT_K1', 49)).toBeUndefined();
  });

  it('协议不认识的函数（无路由匹配）→ undefined', async () => {
    const p = await proto3();
    expect(p.deriveCallContext!('KOJO_UNKNOWN_K49', 49)).toBeUndefined();
  });
});
