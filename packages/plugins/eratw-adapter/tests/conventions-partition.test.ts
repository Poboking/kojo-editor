/**
 * PERF-12b 对拍（eraTW 侧）：分区路径（`partition.fileUnit` 全文件新鲜 × `combine`）
 * 与全量路径（`check`）在对抗性夹具上**逐条同产出**。
 * 夹具刻意造出"分组首现序 ≠ 朴素 walk 序"的形态（KX 大小写变体、跨文件 anchor、
 * 多文件多越界函数），把顺序等价也钉死。
 */
import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type {
  CharaInfo,
  ConventionCheckContext,
  ConventionProjectUnitEntry,
  ConventionRule,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  FileIO,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { loadEratwCallProtocol } from '../src/call-protocol';
import {
  createCallSlotCoverageRule,
  kojoCompletenessRule,
  kxPlaceholderRule,
} from '../src/conventions';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeIndex(files: Record<string, string>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [path, text] of Object.entries(files)) {
    const f = parseErbText(text, path);
    map.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: map, byName: functionLookupOf(byName) };
}

function ctxFor(
  index: ErbIndex,
  files: Record<string, string>,
  chara: CharaInfo[] = [],
  kojoDirByNo: Record<number, string> = {},
): ConventionCheckContext {
  const charaIndex = new Map<number, CharaInfo>();
  for (const c of chara) charaIndex.set(c.no, { ...c, kojoDir: kojoDirByNo[c.no] ?? c.kojoDir });
  return {
    project: {
      rootDir: '/p',
      adapterId: 'eratw',
      kojoPaths: ['/p/kojo'],
      writablePaths: [],
      charaIndex,
    },
    index,
    readFile: async (path: string) => {
      const t = files[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    log: silentLog,
  };
}

/** 分区模拟：按 walk 序逐文件现算贡献 ⇒ 合并（= 引擎"冷轮"的等价形态） */
async function viaPartition(rule: ConventionRule, ctx: ConventionCheckContext) {
  const entries: ConventionProjectUnitEntry[] = [];
  for (const file of ctx.index.files.values()) {
    entries.push({ file, unit: await rule.partition!.fileUnit(ctx, file) });
  }
  return rule.partition!.combine(ctx, entries);
}

describe('PERF-12b 分区×全量对拍（eraTW 规则）', () => {
  it('kx-placeholder：大小写变体首现、同名跨文件多命中、正常名混杂 ⇒ 逐条相同', async () => {
    const files = {
      '/p/a.ERB':
        '@M_KOJO_MESSAGE_COM_KX_1\nPRINTL x\n' +
        '@M_KOJO_COLOR_K1\nRETURN 0\n' +
        '@M_KOJO_MESSAGE_COM_KX_1\nPRINTL dup2\n' +
        '@M_KOJO_EVENT_KX_SOMETHING\nRETURN\n',
      '/p/b.ERB':
        '@M_KOJO_COLOR_KX\nRETURN\n' +
        '@M_KOJO_MESSAGE_COM_K1_1\nPRINTL normal\n' +
        '@m_kojo_message_com_kx_2\nPRINTL lower\n' +
        '@M_KOJO_SPEVENT_KX_9(ARG,ARG:1)\nRETURN\n',
      '/p/c.ERB': '@M_KOJO_COLOR_KX\nRETURN 1\n@M_KOJO_EVENT_KX_SOMETHING\nRETURN\n',
    };
    const index = makeIndex(files);
    const ctx = ctxFor(index, {});
    const full = await kxPlaceholderRule.check!(ctx);
    expect(full.length).toBeGreaterThan(0); // 夹具真的命中了（否则对拍空转）
    expect(await viaPartition(kxPlaceholderRule, ctx)).toEqual(full);
  });

  it('kojo-completeness：跨文件面集/anchor/声明分居不同文件 ⇒ 逐条相同（含 anchor 定位）', async () => {
    const chara: CharaInfo[] = [
      { no: 1, name: '角色一' },
      { no: 2, name: '角色二' },
    ];
    const files = {
      // 1 号：MESSAGE_COM 在 a（anchor 候选首现）、COLOR 也在 a、FLAGSETTING 在 b（缺失判定变齐）
      '/p/kojo/001/a.ERB': '@M_KOJO_MESSAGE_COM_K1_1\nPRINTL x\n@M_KOJO_COLOR_K1\nRETURN 0\n',
      '/p/kojo/001/b.ERB': '@M_KOJO_K1\nRESULTS = "一"\n@M_KOJO_FLAGSETTING_K1\nRETURN\n',
      // 2 号：只有 ENCOUNTER（在 c），无声明 ⇒ declare + 三项缺失，anchor 指向 c
      '/p/kojo/002/c.ERB': '@M_KOJO_ENCOUNTER_K2\nRETURN\n@HELPER_2\nRETURN\n',
    };
    const index = makeIndex(files);
    const ctx = ctxFor(index, {}, chara, { 1: '/p/kojo/001', 2: '/p/kojo/002' });
    const full = await kojoCompletenessRule.check!(ctx);
    expect(full.length).toBeGreaterThan(0);
    expect(await viaPartition(kojoCompletenessRule, ctx)).toEqual(full);
  });

  it('kojo-call-slot-coverage：多文件多越界 + 协议不认识混杂 ⇒ 逐条相同', async () => {
    const ROUTE = [
      '\tTRYCALLFORM M_KOJO%KOJO_NAME%_SPEVENT_K{NO:TARGET}_{ARG:1}(ARG:3,ARG:4)',
      '\tTRYCCALLFORM M_KOJO%KOJO_NAME%_DANMAKU_K{NO:TARGET}(ARG:3)',
      '\tTRYCALLFORM M_KOJO%KOJO_NAME%_COLOR_K{NO:TARGET}',
    ].join('\n');
    const routeIo = {
      readText: async (p: string) => ({ path: p, text: ROUTE, encoding: 'utf-8', eol: 'lf', mtimeMs: null }),
    } as unknown as FileIO;
    const proto = await loadEratwCallProtocol({ io: routeIo, routeFile: 'KOJO_MESSAGE.ERB', log: silentLog });
    expect(proto).toBeTruthy();
    const rule = createCallSlotCoverageRule(() => proto!);

    const files = {
      '/p/a.ERB':
        '@M_KOJO_TEST_SPEVENT_K1_1(ARG, ARG:1, ARG:2)\nRETURN\n' + // 越界（数值 3>2）
        '@M_KOJO_TEST_MESSAGE_COM_K1_1(ARG, ARG:1, ARG:2)\nRETURN\n' + // 协议不认识 ⇒ 跳过
        '@M_KOJO_TEST_SPEVENT_K2_5(ARGS)\nRETURN\n', // 越界（字符串 1>0）
      '/p/b.ERB': '@M_KOJO_TEST_SPEVENT_K1_2(ARG)\nRETURN\n', // 合规 ⇒ 不产
      '/p/c.ERB': '@M_KOJO_TEST_SPEVENT_K3_7(ARG, ARGS, ARGS:1)\nRETURN\n', // 越界（数值+字符串）
    };
    const index = makeIndex(files);
    const ctx = ctxFor(index, {});
    const full = await rule.check!(ctx);
    expect(full.length).toBe(3); // 三条越界各报一条（夹具自证）
    expect(await viaPartition(rule, ctx)).toEqual(full);

    // 协议摘要：同正文重建 ⇒ routeDigest 相同（跨开项目分区可复用）；改正文 ⇒ 变（必须作废）
    const proto2 = await loadEratwCallProtocol({ io: routeIo, routeFile: 'KOJO_MESSAGE.ERB', log: silentLog });
    expect(proto2!.routeDigest).toBe(proto!.routeDigest);
    expect(proto!.routeDigest).toBeTruthy();
  });

  it('call-slot 分区判据：协议缺失时单元不落缓存、combine 无产出（与 check 降级同形）', async () => {
    const rule = createCallSlotCoverageRule(() => undefined);
    const files = { '/p/a.ERB': '@M_KOJO_TEST_SPEVENT_K1_1(ARG, ARG:1, ARG:2)\nRETURN\n' };
    const index = makeIndex(files);
    const ctx = ctxFor(index, {});
    for (const file of index.files.values()) {
      expect(await rule.partition!.fileUnit(ctx, file)).toBeUndefined(); // undefined = 不缓存
    }
    expect(await rule.partition!.combine(ctx, [])).toEqual([]);
    expect(await rule.check!(ctx)).toEqual([]);
    expect(rule.partition!.key!(ctx)).toBe('none');
  });
});
