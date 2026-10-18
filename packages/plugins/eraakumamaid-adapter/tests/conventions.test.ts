/**
 * eraAkumaMaid 约定规则测试（形态照 eratw-adapter/tests/conventions.test.ts
 * 与 conventions-partition.test.ts，合并为单文件）。
 *
 * 覆盖：每条规则命中/不命中/边界；PERF-12b 分区×全量对拍（combine 产出与
 * `check` 逐条同形）；零误报样本（正常口上文件不应触发任何规则）。
 *
 * 协议对象为**手搓夹具**（不依赖 call-protocol 的路由表解析——那层的加载
 * 语义由 call-protocol 自己的测试管）；本文件只钉"规则消费协议"的行为。
 */
import { describe, expect, it } from 'vitest';
import type {
  CharaInfo,
  ConventionCheckContext,
  ConventionIssue,
  ConventionProjectUnitEntry,
  ConventionRule,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import type { ErakumamaidCallProtocol } from '../src/call-protocol';
import { createCallSlotCoverageRule, formTripleSymbolRule, kxPlaceholderRule } from '../src/conventions';

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
  return { files: map, byName };
}

function ctxFor(index: ErbIndex, files: Record<string, string>, chara: CharaInfo[] = []): ConventionCheckContext {
  const charaIndex = new Map<number, CharaInfo>();
  for (const c of chara) charaIndex.set(c.no, c);
  return {
    project: {
      rootDir: '/p',
      adapterId: 'eraakumamaid',
      kojoPaths: ['/p/ERB/EVENT_K'],
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

/**
 * 逐文件规则跑遍整个索引（与引擎的装配同构）。
 * `scope:'file'` 的规则没有 `check`，用它保持原有断言口径——这也顺带证明了
 * "按文件切"与"整项目扫"产出**同一批问题**（改判 scope 的等价性守门）。
 */
async function runFileRule(rule: ConventionRule, ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
  const out: ConventionIssue[] = [];
  for (const file of ctx.index.files.values()) out.push(...((await rule.checkFile!(ctx, file)) ?? []));
  return out;
}

/** 分区模拟：按 walk 序逐文件现算贡献 ⇒ 合并（= 引擎"冷轮"的等价形态） */
async function viaPartition(rule: ConventionRule, ctx: ConventionCheckContext) {
  const entries: ConventionProjectUnitEntry[] = [];
  for (const file of ctx.index.files.values()) {
    entries.push({ file, unit: await rule.partition!.fileUnit(ctx, file) });
  }
  return rule.partition!.combine(ctx, entries);
}

/**
 * 手搓协议夹具：`maxForwardedSlotsFor` 按归一化名查表（null = 协议不认识），
 * `slotsFor` 恒 null（本规则集不消费它）；`routeDigest` 固定值。
 * 形态取自 AM 路由表实测：MESSAGE_COM 无实参转发（0 槽）；
 * PALAMCNG/COUNTER 的 `, LOCALS`/`, ARGS` 修饰 = 整数组透传 1 个字符串槽。
 */
function makeFakeProtocol(table: Record<string, { int: number; str: number } | null>): ErakumamaidCallProtocol {
  return {
    slotsFor: () => null,
    maxForwardedSlotsFor: (name: string) => table[name.toUpperCase()] ?? null,
    routeDigest: 'fake-route-digest',
  };
}

describe('eraakumamaid 约定规则', () => {
  describe('kx-placeholder（KX 占位符残留）', () => {
    it('按归一化函数名去重：同名多处只报一条（跨文件合并计数）', async () => {
      const index = makeIndex({
        '/p/a.ERB': '@KOJO_MESSAGE_COM_KX1\nPRINTL x\n',
        '/p/b.ERB': '@KOJO_MESSAGE_COM_KX1\nPRINTL y\n@KOJO_GREETING_KX1, ARGS\nRETURN\n',
      });
      const ctx = ctxFor(index, {});
      const issues = (await kxPlaceholderRule.check!(ctx)) as { message: string; severity: string; key: string }[];
      expect(issues).toHaveLength(2); // MESSAGE_COM_KX1（2 处合并）+ GREETING_KX1
      expect(issues.every((i) => i.severity === 'warning')).toBe(true);
      expect(issues.some((i) => i.message.includes('共 2 处'))).toBe(true);
      expect(issues.map((i) => i.key)).toContain('eraakumamaid.kx-placeholder|KOJO_MESSAGE_COM_KX1');
    });

    it('大小写变体并入同组（Emuera 函数名大小写不敏感）', async () => {
      const index = makeIndex({
        '/p/a.ERB': '@KOJO_MESSAGE_COM_KX1\nPRINTL x\n@kojo_message_com_kx1\nPRINTL y\n',
      });
      const issues = (await kxPlaceholderRule.check!(ctxFor(index, {}))) as { message: string }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('共 2 处');
    });

    it('正常函数（K{角色号}）不误报', async () => {
      const index = makeIndex({
        '/p/a.ERB': '@KOJO_MESSAGE_COM_K1\nPRINTL x\n@KOJO_GREETING_K15, ARGS\nRETURN\n@CNAME_K1\nRETURN\n',
      });
      expect(await kxPlaceholderRule.check!(ctxFor(index, {}))).toEqual([]);
    });
  });

  describe('form-triple-symbol（PRINTFORM 三连符号）', () => {
    it('PRINTFORM 串里的三连符号报 warning；注释行与普通 PRINTL 不报', async () => {
      const text =
        '@KOJO_MESSAGE_COM_K1\n' +
        '; PRINTFORML "==="\n' +
        'PRINTFORML "===分隔==="\n' +
        'PRINTL "/// 无 FORM 处理 ///"\n';
      const files = { '/p/a.ERB': text };
      const index = makeIndex(files);
      const issues = (await runFileRule(formTripleSymbolRule, ctxFor(index, files))) as {
        line: number;
        message: string;
        severity: string;
      }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.line).toBe(3);
      expect(issues[0]!.message).toContain('===');
      expect(issues[0]!.message).toContain('CALLNAME:PLAYER');
      expect(issues[0]!.severity).toBe('warning');
    });

    it('每文件每符号聚合为一条（含出现次数与首次行号）', async () => {
      const text =
        '@KOJO_MESSAGE_COM_K1\n' +
        'PRINTFORML "a///b"\n' +
        'PRINTFORMDL "c///d///e"\n';
      const files = { '/p/a.ERB': text };
      const index = makeIndex(files);
      const issues = (await runFileRule(formTripleSymbolRule, ctxFor(index, files))) as {
        line: number;
        message: string;
      }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.line).toBe(2);
      expect(issues[0]!.message).toContain('3 处');
    });

    it('四个符号各命中一次 ⇒ 四条 issue（key 按符号区分）', async () => {
      const text =
        '@KOJO_MESSAGE_COM_K1\n' +
        'PRINTFORML "==="\n' +
        'PRINTFORML "***"\n' +
        'PRINTFORML "///"\n' +
        'PRINTFORML "$$$"\n';
      const files = { '/p/a.ERB': text };
      const index = makeIndex(files);
      const issues = (await runFileRule(formTripleSymbolRule, ctxFor(index, files))) as { key: string }[];
      expect(issues.map((i) => i.key).sort()).toEqual([
        'eraakumamaid.form-triple-symbol|/p/a.ERB|$$$',
        'eraakumamaid.form-triple-symbol|/p/a.ERB|***',
        'eraakumamaid.form-triple-symbol|/p/a.ERB|///',
        'eraakumamaid.form-triple-symbol|/p/a.ERB|===',
      ]);
    });

    it('`+++`（有意的主人名占位/AA 画）不报', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_COM_K1\nPRINTFORMDW +++轻轻吻了她\n' };
      const index = makeIndex(files);
      expect(await runFileRule(formTripleSymbolRule, ctxFor(index, files))).toEqual([]);
    });

    it('更长串（「====」）也命中（连续 3 个同符号即触发）', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_COM_K1\nPRINTFORML "====长分隔===="\n' };
      const index = makeIndex(files);
      const issues = (await runFileRule(formTripleSymbolRule, ctxFor(index, files))) as { message: string }[];
      expect(issues).toHaveLength(1);
      // 「====」头段 1 处 + 「====」尾段 1 处（不重叠计数）
      expect(issues[0]!.message).toContain('2 处');
      expect(issues[0]!.message).toContain('「===」');
    });
  });

  describe('kojo-call-slot-coverage（签名槽 vs 路由转发）', () => {
    // 形态取自 AM 路由表实测：MESSAGE_COM 无实参转发（0 槽）；
    // PALAMCNG `, LOCALS` / COUNTER `, ARGS` 转发 1 个字符串槽。
    const proto = () =>
      makeFakeProtocol({
        'KOJO_MESSAGE_COM_K1': { int: 0, str: 0 },
        'KOJO_MESSAGE_COM_K15': { int: 0, str: 0 },
        'KOJO_MESSAGE_PALAMCNG_K1': { int: 0, str: 1 },
        'KOJO_COUNTER_K1': { int: 0, str: 1 },
      });

    it('声明槽多于转发槽 → 产出 warning（含逐类计数与角色号）', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_PALAMCNG_K1, ARGS, ARGS:1\nRETURN\n' };
      const index = makeIndex(files);
      const issues = (await createCallSlotCoverageRule(proto).check!(ctxFor(index, files))) as {
        severity: string;
        message: string;
        characterNo?: number;
      }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.severity).toBe('warning');
      expect(issues[0]!.message).toContain('字符串槽 声明 2 / 转发 1');
      expect(issues[0]!.characterNo).toBe(1);
    });

    it('数值槽与字符串槽同时越界 ⇒ 两类都写进 message', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_COM_K1, ARG, ARGS\nRETURN\n' };
      const index = makeIndex(files);
      const issues = (await createCallSlotCoverageRule(proto).check!(ctxFor(index, files))) as { message: string }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('数值槽 声明 1 / 转发 0');
      expect(issues[0]!.message).toContain('字符串槽 声明 1 / 转发 0');
    });

    it('声明槽不超过转发槽 → 无问题', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_PALAMCNG_K1, ARGS\nRETURN\n' };
      const index = makeIndex(files);
      expect(await createCallSlotCoverageRule(proto).check!(ctxFor(index, files))).toEqual([]);
    });

    it('零槽家族零参数声明 → 无问题（AM 主流形态：单函数 + SELECTCASE）', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_COM_K1\nSELECTCASE SELECTCOM\nCASE 0\nRETURN\nENDSELECT\n' };
      const index = makeIndex(files);
      expect(await createCallSlotCoverageRule(proto).check!(ctxFor(index, files))).toEqual([]);
    });

    it('协议不可用（getProtocol → undefined）→ 降级不产出', async () => {
      const files = { '/p/a.ERB': '@KOJO_MESSAGE_COM_K1, ARG, ARG:1\nRETURN\n' };
      const index = makeIndex(files);
      expect(await createCallSlotCoverageRule(() => undefined).check!(ctxFor(index, files))).toEqual([]);
    });

    it('协议不认识该函数（非路由可达家族）→ 跳过', async () => {
      const files = { '/p/a.ERB': '@KOJO_WISH_K1, ARG, ARG:1\nRETURN\n' };
      const index = makeIndex(files);
      expect(await createCallSlotCoverageRule(proto).check!(ctxFor(index, files))).toEqual([]);
    });
  });

  describe('零误报样本（正常口上文件不应触发任何规则）', () => {
    it('一段写实的 MESSAGE_COM 口上 + 协议认识该家族 ⇒ 全部规则零产出', async () => {
      // 形态取自 AM 真实语料（单函数 + SELECTCASE SELECTCOM + TEXTR 泛用）
      const text = [
        '@KOJO_MESSAGE_COM_K1',
        'SELECTCASE SELECTCOM',
        'CASE 0',
        '	PRINTFORML 「你好」',
        '	PRINTFORMDW 今天也很努力呢……',
        'CASE 350',
        '	; 肛交',
        '	PRINTFORML 「嗯……啊……」',
        'CASEELSE',
        '	PRINTFORML %TEXTR("嗯/啊/哈")%',
        'ENDSELECT',
        '',
        '@KOJO_ENDCOM_K1',
        'RETURN',
        '',
        '@KOJO_GREETING_K1, ARGS',
        'SELECTCASE ARGS',
        'CASE "朝"',
        '	PRINTFORML 「早上好」',
        'ENDSELECT',
        '',
        '@CNAME_K1',
        'RESULTS = 测试角色',
        '',
      ].join('\n');
      const files = { '/p/ERB/EVENT_K/001/EVENT_K1.ERB': text };
      const index = makeIndex(files);
      const ctx = ctxFor(index, files, [{ no: 1, name: '测试角色' }]);
      expect(await kxPlaceholderRule.check!(ctx)).toEqual([]);
      expect(await runFileRule(formTripleSymbolRule, ctx)).toEqual([]);
      const protocol = makeFakeProtocol({ 'KOJO_MESSAGE_COM_K1': { int: 0, str: 0 } });
      expect(await createCallSlotCoverageRule(() => protocol).check!(ctx)).toEqual([]);
    });
  });
});

describe('PERF-12b 分区×全量对拍（eraakumamaid 规则）', () => {
  it('kx-placeholder：大小写变体首现、同名跨文件多命中、正常名混杂 ⇒ 逐条相同', async () => {
    const files = {
      '/p/a.ERB':
        '@KOJO_MESSAGE_COM_KX1\nPRINTL x\n' +
        '@KOJO_GREETING_K1, ARGS\nRETURN\n' +
        '@KOJO_MESSAGE_COM_KX1\nPRINTL dup2\n' +
        '@KOJO_SLEEP_KX1\nRETURN\n',
      '/p/b.ERB':
        '@KOJO_DAILYCOM_KX1, ARGS\nRETURN\n' +
        '@KOJO_MESSAGE_COM_K1\nPRINTL normal\n' +
        '@kojo_message_com_kx1\nPRINTL lower\n',
      '/p/c.ERB': '@KOJO_SLEEP_KX1\nRETURN 1\n@KOJO_DATE_KX1, ARGS\nRETURN\n',
    };
    const index = makeIndex(files);
    const ctx = ctxFor(index, {});
    const full = await kxPlaceholderRule.check!(ctx);
    expect(full.length).toBeGreaterThan(0); // 夹具真的命中了（否则对拍空转）
    expect(await viaPartition(kxPlaceholderRule, ctx)).toEqual(full);
  });

  it('kojo-call-slot-coverage：多文件多越界 + 协议不认识混杂 ⇒ 逐条相同', async () => {
    const proto = () =>
      makeFakeProtocol({
        'KOJO_MESSAGE_PALAMCNG_K1': { int: 0, str: 1 },
        'KOJO_MESSAGE_PALAMCNG_K2': { int: 0, str: 1 },
        'KOJO_MESSAGE_COM_K1': { int: 0, str: 0 },
      });
    const rule = createCallSlotCoverageRule(proto);
    const files = {
      '/p/a.ERB':
        '@KOJO_MESSAGE_PALAMCNG_K1, ARGS, ARGS:1\nRETURN\n' + // 越界（字符串 2>1）
        '@KOJO_MESSAGE_COM_K1, ARG, ARG:1\nRETURN\n' + // 越界（数值 2>0）
        '@KOJO_WISH_K1, ARG, ARG:1\nRETURN\n' + // 协议不认识 ⇒ 跳过
        '@KOJO_MESSAGE_PALAMCNG_K2, ARGS\nRETURN\n', // 合规 ⇒ 不产
      '/p/b.ERB': '@KOJO_MESSAGE_PALAMCNG_K1, ARGS\nRETURN\n', // 合规 ⇒ 不产
    };
    const index = makeIndex(files);
    const ctx = ctxFor(index, {});
    const full = await rule.check!(ctx);
    expect(full.length).toBe(2); // 两条越界各报一条（夹具自证）
    expect(await viaPartition(rule, ctx)).toEqual(full);
  });

  it('call-slot 分区判据：协议缺失时单元不落缓存、combine 无产出（与 check 降级同形）', async () => {
    const rule = createCallSlotCoverageRule(() => undefined);
    const files = { '/p/a.ERB': '@KOJO_MESSAGE_COM_K1, ARG, ARG:1\nRETURN\n' };
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
