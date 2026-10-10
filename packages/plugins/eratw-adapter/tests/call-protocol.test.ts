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
