/**
 * `@kojo/plugin-erb-lang` 的 **signatureHelp 供方闸**（LAU-1031-SIG，2026-10-31）。
 *
 * 判据在 `@kojo/erb-lang/signature`（宿主旧桥共读同一份，等价性由
 * `packages/erb-lang/tests/signature.test.ts` 与 `packages/app/tests/kojo-signature.test.ts`
 * 钉），本文件只钉**供方这一格的四件事**，每件防一种真实退化：
 *
 * 1. **三态分得开**：非 ERB / 非这个 kind ⇒ `undefined`（**弃权**，让下一家接手）；
 *    认这门语言但这一格给不出签名 ⇒ `{ signatures: [] }`（**作答空**，宿主据此不弹浮层、
 *    也不再问下一家）。两者混成一个的话，"插件没装载"（应显示 inactive 的可见退化）会伪装成
 *    "这里确实没有签名"，铁律 4（内核不许静默）就是从这条破口开始的；
 * 2. **两张宿主表只经注入/登记表进来**：插件零 IO、不碰内核 —— 缺表时**不应答**而不是猜；
 * 3. **形状对齐 kojo2 那家**（同一条槽、同一份契约、`activeSignature` 恒 0、互斥作答）；
 * 4. **抛错收成交作答空**（宿主会把 throw 吞成"提示突然没了"，这里给出有语义的答复）。
 */
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSignatureHelpResult,
  KojoCallProtocol,
  KojoCallSlot,
  PluginContext,
} from '@kojo/plugin-api';
import { registerErbSignatureSource, type ErbSignatureTables } from '@kojo/erb-lang/signature';
import { describe, expect, it } from 'vitest';
import { provideSignatureHelp as provideKojo2SignatureHelp } from '@kojo/plugin-kojo-lang';
import { createErbLangPlugin, provideErbSignatureHelp } from '../src/index';

const PATH = 'D:/proj/ERB/口上/1_测试.erb';

/** 与 erb-lang 侧同一夹具（行号 3 = 单行调用、5 = 跨行中间行、8 = 用户函数、7 = 字符串） */
const TEXT = [
  '; 注释里的 CALL HUNT(1, 2) 不是调用', // 1
  '@FUNC(A, B)', // 2
  '    CALL HUNT(1, "甲,乙")', // 3
  '    CALL HUNT(', // 4
  '        7,', // 5
  '        8)', // 6
  '    PRINTL "字符串里的 ( 与 , 都不算"', // 7
  '    MYFUNC(1, 2)', // 8
].join('\n');

const protocol: KojoCallProtocol = {
  slotsFor(functionName: string): readonly KojoCallSlot[] | null {
    if (functionName !== 'HUNT') return null;
    return [
      { index: 0, kind: 'int', label: '对象' },
      { index: 1, kind: 'str', label: '备注' },
    ];
  },
};

const TABLES: ErbSignatureTables = {
  callProtocol: protocol,
  paramsOf: (callee) => (callee === 'MYFUNC' ? [{ name: 'ARG' }, { name: 'ARGS:1 = 3' }] : null),
};

function signatureRequest(
  line: number,
  column: number,
  over: Record<string, unknown> = {},
): EditorLanguageServiceRequest {
  return {
    kind: 'signatureHelp',
    path: PATH,
    text: TEXT,
    line,
    column,
    project: null,
    languageId: 'kojo-erb',
    lineCount: TEXT.split('\n').length,
    ...over,
  } as unknown as EditorLanguageServiceRequest;
}

/* ============================== ① 弃权：不是这个 kind / 不是 ERB ============================== */

describe('弃权面：不是 signatureHelp 或不是 ERB ⇒ undefined（不是空数组）', () => {
  it('kind 不对 ⇒ 弃权（同一枚供方不许顺手回答别的 kind）', () => {
    expect(
      provideErbSignatureHelp(signatureRequest(3, 15, { kind: 'hover' }), { tables: TABLES }),
    ).toBeUndefined();
    expect(
      provideErbSignatureHelp(signatureRequest(3, 15, { kind: 'documentHighlight' }), {
        tables: TABLES,
      }),
    ).toBeUndefined();
  });

  it('languageId 是 kojo2 / plaintext ⇒ 弃权；kojo-erb 与短形式 erb 都认', () => {
    expect(
      provideErbSignatureHelp(signatureRequest(3, 15, { languageId: 'kojo2' }), { tables: TABLES }),
    ).toBeUndefined();
    expect(
      provideErbSignatureHelp(signatureRequest(3, 15, { languageId: 'plaintext' }), { tables: TABLES }),
    ).toBeUndefined();
    expect(
      (provideErbSignatureHelp(signatureRequest(3, 15, { languageId: 'erb' }), { tables: TABLES }) as EditorSignatureHelpResult)
        .signatures,
    ).toHaveLength(1);
  });

  it('没有 languageId 时退回扩展名：`.erb` 认、`.kojo2` 弃权', () => {
    const erb = provideErbSignatureHelp(
      signatureRequest(3, 15, { languageId: undefined, path: 'D:/proj/a.ERB' }),
      { tables: TABLES },
    );
    expect(erb).toBeDefined();
    expect(
      provideErbSignatureHelp(signatureRequest(3, 15, { languageId: undefined, path: 'D:/proj/a.kojo2' }), {
        tables: TABLES,
      }),
    ).toBeUndefined();
  });

  it('双向弃权：kojo2 那家对 ERB 请求弃权，本供方对 kojo2 请求弃权（同一条槽永远只有一家作答）', () => {
    const erbAsk = signatureRequest(3, 15);
    expect(provideKojo2SignatureHelp(erbAsk)).toBeUndefined();
    expect(provideErbSignatureHelp(erbAsk, { tables: TABLES })).toBeDefined();

    const kojo2Ask = {
      kind: 'signatureHelp',
      path: 'D:/proj/口上/1_测试.kojo2',
      text: ['# 幕 一', '@函 甲(心情)', '    心情 = 1'].join('\n'),
      line: 2,
      column: 6,
      project: null,
      languageId: 'kojo2',
    } as unknown as EditorLanguageServiceRequest;
    expect(provideErbSignatureHelp(kojo2Ask, { tables: TABLES })).toBeUndefined();
  });
});

/* ============================== ② 作答空：认这门语言、这一格给不出签名 ============================== */

describe('作答空：{ signatures: [] } 是**答复**（不是弃权），宿主据此不弹浮层也不再问下一家', () => {
  it('零表（项目没开 / 组合根没登记）⇒ 处处作答空，绝不猜', () => {
    for (const [line, column] of [
      [3, 15],
      [5, 11],
      [8, 14],
    ] as const) {
      expect(provideErbSignatureHelp(signatureRequest(line, column), { tables: {} })).toEqual({
        kind: 'signatureHelp',
        signatures: [],
      });
    }
  });

  it('有表但这一格不是调用位点：注释行 / 字符串里 / 括号外 ⇒ 作答空', () => {
    expect(provideErbSignatureHelp(signatureRequest(1, 20), { tables: TABLES })).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
    expect(provideErbSignatureHelp(signatureRequest(7, 20), { tables: TABLES })).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
    expect(provideErbSignatureHelp(signatureRequest(2, 12), { tables: TABLES })).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });

  it('两表皆不认识这个被调名 ⇒ 作答空（不造 ARG:n 兜底名、不猜形参个数）', () => {
    expect(
      provideErbSignatureHelp(signatureRequest(2, 11), { tables: TABLES })?.kind,
    ).toBe('signatureHelp');
    const result = provideErbSignatureHelp(signatureRequest(2, 11), { tables: TABLES })!;
    expect(result.signatures).toEqual([]);
  });
});

/* ============================== ③ 有结果：原样穿过契约 ============================== */

describe('有结果：一条签名 + activeSignature 恒 0（形状与 kojo2 那家对齐）', () => {
  it('协议命中（槽语义）：label 逐字含每个参数标签，activeParameter 落在光标那一参', () => {
    const result = provideErbSignatureHelp(signatureRequest(3, 23), { tables: TABLES })!;
    expect(result.kind).toBe('signatureHelp');
    expect(result.activeSignature).toBe(0);
    expect(result.signatures).toEqual([
      {
        label: 'HUNT(ARG:0 对象, ARGS:1 备注)',
        parameters: ['ARG:0 对象', 'ARGS:1 备注'],
        activeParameter: 1,
      },
    ]);
  });

  it('跨行调用经供方照样应答（窗口切分在包里，供方只搬运）', () => {
    const result = provideErbSignatureHelp(signatureRequest(5, 11), { tables: TABLES })!;
    expect(result.signatures[0]?.label).toBe('HUNT(ARG:0 对象, ARGS:1 备注)');
    expect(result.signatures[0]?.activeParameter).toBe(1);
  });

  it('协议不认识 ⇒ 用户函数形参原文兜底（第二查表面）', () => {
    const result = provideErbSignatureHelp(signatureRequest(8, 14), { tables: TABLES })!;
    expect(result.signatures).toEqual([
      {
        label: 'MYFUNC(ARG, ARGS:1 = 3)',
        parameters: ['ARG', 'ARGS:1 = 3'],
        activeParameter: 1,
      },
    ]);
  });

  it('契约条目零多余字段（判据没说的话这里也不许编：没有 documentation / 没有第二张签名）', () => {
    const hit = provideErbSignatureHelp(signatureRequest(3, 15), { tables: TABLES })!;
    expect(Object.keys(hit).sort()).toEqual(['activeSignature', 'kind', 'signatures']);
    expect(Object.keys(hit.signatures[0]!).sort()).toEqual(['activeParameter', 'label', 'parameters']);
  });
});

/* ============================== ④ 取表缝：缺省经登记表现取 ============================== */

describe('缺省取表：injection 缺席 ⇒ 每次请求经模块级登记表现取（表随项目开闭重建，不缓存）', () => {
  it('零登记 ⇒ 作答空；登记后同一请求 ⇒ 有结果；注销后回到作答空', () => {
    expect(provideErbSignatureHelp(signatureRequest(3, 15))).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
    const off = registerErbSignatureSource(() => TABLES);
    const hit = provideErbSignatureHelp(signatureRequest(3, 15))!;
    expect(hit.signatures[0]?.label).toBe('HUNT(ARG:0 对象, ARGS:1 备注)');
    off();
    expect(provideErbSignatureHelp(signatureRequest(3, 15))).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });

  it('injection 优先于登记表（单测注入桩，不依赖宿主装配）', () => {
    const off = registerErbSignatureSource(() => ({}));
    const hit = provideErbSignatureHelp(signatureRequest(3, 15), { tables: TABLES })!;
    expect(hit.signatures).toHaveLength(1);
    off();
  });
});

/* ============================== ⑤ 抛错面 ============================== */

describe('抛错成交付空（宿主吞 throw ⇒ 这里给有语义的答复）', () => {
  it('协议表 getter 抛错 ⇒ 作答空，不冒到宿主', () => {
    const poison: KojoCallProtocol = {
      slotsFor() {
        throw new Error('桩：协议表读不了');
      },
    };
    expect(provideErbSignatureHelp(signatureRequest(3, 15), { tables: { callProtocol: poison } })).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });

  it('paramsOf 抛错按"不认识"处理 ⇒ 作答空（退化可见、不让提示崩）', () => {
    const tables: ErbSignatureTables = {
      paramsOf: () => {
        throw new Error('桩：索引正在重建');
      },
    };
    expect(provideErbSignatureHelp(signatureRequest(3, 15), { tables })).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });

  it('请求自带越界（行号 9999）⇒ 作答空，不抛', () => {
    expect(provideErbSignatureHelp(signatureRequest(9_999, 1), { tables: TABLES })).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });
});

/* ============================== ⑥ 装配：第四枚贡献接到这条腿上 ============================== */

describe('插件装配：erb-signatureHelp 贡献真的供 signatureHelp', () => {
  function signatureContribution(): EditorLanguageServiceContribution {
    const registered: Array<{ slot: string; item: EditorLanguageServiceContribution }> = [];
    const ctx = {
      pluginId: 'erb-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, item: EditorLanguageServiceContribution) => {
          registered.push({ slot, item });
          return () => undefined;
        },
      },
    } as unknown as PluginContext;
    createErbLangPlugin().activate(ctx);
    const found = registered.find((r) => r.item.id === 'erb-signatureHelp');
    if (!found) throw new Error('erb-signatureHelp 贡献没注册（四件同批的第②件缺了 ⇒ 静默没有）');
    expect(found.slot).toBe('ui.editor.languageService');
    expect(found.item.order).toBe(10);
    return found.item;
  }

  /** 只允许这枚贡献回答 signatureHelp；答了别的 kind 直接算失败 */
  function ask(
    item: EditorLanguageServiceContribution,
    request: EditorLanguageServiceRequest,
  ): EditorSignatureHelpResult | undefined {
    const out = item.provide(request);
    if (out === undefined) return undefined;
    if (out.kind !== 'signatureHelp') throw new Error(`signatureHelp 贡献答了别的 kind：${out.kind}`);
    return out;
  }

  it('经槽问一次：ERB 请求作答（零登记时是作答空，不是弃权），kojo2 请求弃权', () => {
    const item = signatureContribution();
    expect(ask(item, signatureRequest(1, 20))).toEqual({ kind: 'signatureHelp', signatures: [] });
    expect(ask(item, signatureRequest(3, 15, { languageId: 'kojo2' }))).toBeUndefined();
  });

  it('装配 + 登记表合起来才给出结果（宿主表在组合根登记，插件不读内核）', () => {
    const item = signatureContribution();
    const off = registerErbSignatureSource(() => TABLES);
    expect(ask(item, signatureRequest(3, 23))?.signatures[0]?.label).toBe(
      'HUNT(ARG:0 对象, ARGS:1 备注)',
    );
    off();
  });
});
