/**
 * 口上调用协议解析单测（v0.2 第十批；合成路由文本 + FileIO stub）。
 *
 * 覆盖：模板 → 正则转换（插值段 / 内嵌表达式段）/ 槽位类型与按序绑定 /
 * 同家族多模板取槽位最多 / 无括号 CALLFORM / 非平凡实参跳过 / 文件缺失降级 /
 * 家族名提取失败行跳过。
 */
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadEratwCallProtocol } from '../src/call-protocol';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ioWith(text: string): FileIO {
  return {
    readText: async () => ({ text, encoding: 'utf-8', eol: '\n' }),
  } as unknown as FileIO;
}

const ROUTE = `
;====================================================================
;KOJO表示総合管理
;@KOJO_MESSAGE_SEND
;ARGS   => 口上種類
;ARG:1 => 口上タイミング
;====================================================================
@KOJO_MESSAGE_SEND(ARGS, ARG:1, ARG:2, ARG:3, ARG:4, ARGS:1, ARGS:2, ARG:5, ARG:6, OVERRIDE_TARGET = -1)
	CASE "SP_EVENT"
		TRYCALLFORM M_KOJO%KOJO_NAME%_SPEVENT_MESSAGECHECK_K{NO:TARGET}_{ARG:1}
		TRYCALLFORM M_KOJO%KOJO_NAME%_SPEVENT_K{NO:TARGET}_{ARG:1}(ARG:3,ARG:4)
	CASE "EVENT"
		TRYCALLFORM M_KOJO%RESULTS%_EVENT_K{NO:TARGET}_%ARGS:1%(ARGS:2,ARG:3,ARG:4)
		TRYCALLFORM M_KOJO%RESULTS%_EVENT_K{NO:TARGET}_{ARG:1}(ARG:3,ARG:4)
	CASE "ENCOUNTER"
		TRYCALLFORM M_KOJO%RESULTS%_ENCOUNTER_K{NO:TARGET}
	CASE "CHILD"
		TRYCALLFORM M_KOJO%R%_EVENT_K{n}_CHILD_{ARGS:1}
	CALLFORM M_KOJO%R%_DIRECT_K{n}_{ARG:1}
`;

describe('loadEratwCallProtocol', () => {
  it('解析家族模板并匹配函数名（SPEVENT → 2 数值槽）', async () => {
    const proto = await loadEratwCallProtocol({ io: ioWith(ROUTE), routeFile: 'KOJO_MESSAGE.ERB', log: silentLog });
    expect(proto).toBeTruthy();
    const slots = proto!.slotsFor('M_KOJO_ORTHODOX_SPEVENT_K49_2');
    expect(slots).not.toBeNull();
    expect(slots).toHaveLength(2);
    expect(slots![0]).toMatchObject({ index: 0, kind: 'int' });
    expect(slots![1]).toMatchObject({ index: 1, kind: 'int' });
    expect(slots![0]!.label).toContain('ARG:3');
  });

  it('同家族多模板（字符串时机 3 槽 / 普通 2 槽）→ 数值函数名取槽位最多', async () => {
    const proto = await loadEratwCallProtocol({ io: ioWith(ROUTE), routeFile: 'x', log: silentLog });
    // 数值时机函数名（_K49_1）
    const numeric = proto!.slotsFor('M_KOJO_ORTHODOX_EVENT_K49_1');
    expect(numeric).toHaveLength(2);
    // 字符串时机函数名（_K49_口上手紙）——两个模板都匹配（%ARGS:1% 与 {ARG:1} 都是 .+）→ 取最多（3 槽，含 1 str）
    const str = proto!.slotsFor('M_KOJO_ORTHODOX_EVENT_K49_口上手紙');
    expect(str).toHaveLength(3);
    expect(str![0]).toMatchObject({ index: 0, kind: 'str' });
    expect(str![1]).toMatchObject({ index: 0, kind: 'int' });
    expect(str![2]).toMatchObject({ index: 1, kind: 'int' });
  });

  it('无实参模板（ENCOUNTER）→ 空槽位表（协议认识但无参数）', async () => {
    const proto = await loadEratwCallProtocol({ io: ioWith(ROUTE), routeFile: 'x', log: silentLog });
    const slots = proto!.slotsFor('M_KOJO_ORTHODOX_ENCOUNTER_K49');
    expect(slots).not.toBeNull();
    expect(slots).toHaveLength(0);
  });

  it('协议不认识的函数 → null', async () => {
    const proto = await loadEratwCallProtocol({ io: ioWith(ROUTE), routeFile: 'x', log: silentLog });
    expect(proto!.slotsFor('M_KOJO_K49_完全无关函数')).toBeNull();
    expect(proto!.slotsFor('陷落状态')).toBeNull();
  });

  it('文件缺失 → undefined（优雅降级）', async () => {
    const io = {
      readText: async () => {
        throw new Error('ENOENT');
      },
    } as unknown as FileIO;
    const proto = await loadEratwCallProtocol({ io, routeFile: 'missing.ERB', log: silentLog });
    expect(proto).toBeUndefined();
  });
});

/** 具体性 / TRYC 系关键字 / 覆盖语义（maxForwardedSlotsFor） */
const ROUTE2 = `
	TRYCALLFORM M_KOJO%KOJO_NAME%_EVENT_K{NO:TARGET}_{ARG:1}(ARG:3,ARG:4)
	TRYCALLFORM M_KOJO%KOJO_NAME%_DAILY_EVENT_K{NO:TARGET}_{ARG:1}(ARG:2,ARG:3,ARG:4,ARG:5,ARG:6,ARGS:1,ARGS:2)
	TRYCALLFORM M_KOJO%KOJO_NAME%_EVENT_K{NO:TARGET}_26_1(ARGS:1)
	TRYCCALLFORM M_KOJO%KOJO_NAME%_EVENT_K{NO:TARGET}_ONABARE_{ARG:1}(ARG:3)
	TRYCCALLFORM M_KOJO%KOJO_NAME%_EVENT_K{NO:TARGET}_ONABARE_{ARG:1}(ARG:3, ARG:4, ARG:5, ARG:6)
	TRYCCALLFORM M_KOJO%KOJO_NAME%_EVENT_K{NO:TARGET}_CHILD_%ARGS:1%
	TRYCCALLFORM M_KOJO%KOJO_NAME%_EVENT_K{NO:TARGET}_CHILD_DAILY_口上手紙(ARG:3)
`;

describe('loadEratwCallProtocol —— 模板具体性与覆盖语义', () => {
  async function proto2() {
    const p = await loadEratwCallProtocol({ io: ioWith(ROUTE2), routeFile: 'KOJO_MESSAGE.ERB', log: silentLog });
    expect(p).toBeTruthy();
    return p!;
  }

  it('字面最长优先：DAILY_EVENT 不被更短的 EVENT 模板截胡', async () => {
    const p = await proto2();
    const slots = p.slotsFor('M_KOJO_X_DAILY_EVENT_K1_2');
    expect(slots).toHaveLength(7); // 5 数值 + 2 字符串
    expect(slots!.filter((s) => s.kind === 'int')).toHaveLength(5);
    expect(slots!.filter((s) => s.kind === 'str')).toHaveLength(2);
  });

  it('字面模板优先：_EVENT_K*_26_1 取字面模板（1 字符串槽）', async () => {
    const p = await proto2();
    const slots = p.slotsFor('M_KOJO_X_EVENT_K1_26_1');
    expect(slots).toHaveLength(1);
    expect(slots![0]).toMatchObject({ kind: 'str', index: 0 });
  });

  it('TRYC 系关键字（TRYCCALLFORM）：同模板多行取槽位更多者', async () => {
    const p = await proto2();
    const slots = p.slotsFor('M_KOJO_X_EVENT_K1_ONABARE_3');
    expect(slots).toHaveLength(4); // 1 槽与 4 槽两条同模板 → 取 4
    expect(slots!.every((s) => s.kind === 'int')).toBe(true);
  });

  it('maxForwardedSlotsFor：逐类取所有匹配模板的最大值（存在性覆盖）', async () => {
    const p = await proto2();
    // CHILD 通用模板 0 槽 + CHILD_DAILY 字面 1 数值槽 → 逐类最大 1 数值
    expect(p.maxForwardedSlotsFor('M_KOJO_X_EVENT_K1_CHILD_DAILY_口上手紙')).toEqual({ int: 1, str: 0 });
    // 仅命中 0 槽通用模板 → 全 0（协议认识，但无任何转发）
    expect(p.maxForwardedSlotsFor('M_KOJO_X_EVENT_K1_CHILD_FOO')).toEqual({ int: 0, str: 0 });
    // DAILY_EVENT 字面 5 数值 + 2 字符串，且被通用 EVENT 同时命中 → 逐类最大仍 5/2
    expect(p.maxForwardedSlotsFor('M_KOJO_X_DAILY_EVENT_K1_2')).toEqual({ int: 5, str: 2 });
    // ONABARE 同模板合并为 4 数值
    expect(p.maxForwardedSlotsFor('M_KOJO_X_EVENT_K1_ONABARE_3')).toEqual({ int: 4, str: 0 });
    // _26_1：字面模板 1 字符串 + 通用 EVENT 的宽松匹配（{NO:TARGET}=.+）2 数值 → 逐类最大 2/1
    expect(p.maxForwardedSlotsFor('M_KOJO_X_EVENT_K1_26_1')).toEqual({ int: 2, str: 1 });
  });

  it('maxForwardedSlotsFor：协议不认识的函数 → null', async () => {
    const p = await proto2();
    expect(p.maxForwardedSlotsFor('M_KOJO_K49_完全无关函数')).toBeNull();
  });
});
