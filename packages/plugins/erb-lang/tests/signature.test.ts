/**
 * `signatureHelp` 供方闸（LAU-DUALLEG 车 5，2026-10-31）。
 *
 * 这一格今天从**双挂**收成**一枚**：宿主 `monaco/kojo-signature.ts` 那枚腿按 descriptor 的
 * 点名让开 ERB，ERB 的签名从此只由本文件的供方答。所以钉的第一件事不是"算得对不对"
 * （判据在 `@kojo/kojo-vocab/signature`，宿主那条腿与它同一把尺子，两侧的行为闸在
 * `packages/app/tests/kojo-signature.test.ts`），而是**这一格有没有人答、以什么形状答**。
 *
 * 六组断言，各自防一种真实退化：
 * 1. **三态分家**：`undefined`＝弃权（让下一家接手）／`{ signatures: [] }`＝作答但没话说
 *    （宿主不弹浮层，也不再问下一家）／一条签名＝作答。把空答写成弃权，双挂就回来了；
 *    把弃权写成空答，别的语言永远等不到自己的 provider。
 * 2. **语言分派 + 双向互斥**：本供方对 kojo2 请求弃权，kojo2 那家（`@kojo/plugin-kojo-lang`）
 *    对 ERB 请求弃权——同一请求永远只有一家作答。
 * 3. **两张表的先后**：调用协议（槽语义）优先，协议不认识才用 ERB 用户函数形参。
 * 4. **不猜**：被调名两表都不认识 ⇒ 空答，**不造 `ARG:n` 兜底名**、不按实参个数猜形参。
 * 5. **跨行**：调用括号在上一行 opened、光标在本行 ⇒ 照常应答（判据搬走后这条最容易被
 *    "只读当前行"的接线悄悄替掉）。
 * 6. **事实的缺席面**：没有 adapter / 没有索引 ⇒ 空答（退化可见）；供方取数抛错 ⇒ 空答，
 *    绝不把异常抛进击键路径。
 * 7. **插件装配**：四枚贡献分枚注册、id 稳定、`order` 相同，且签名那枚真的走同一条判据。
 */
import { describe, expect, it } from 'vitest';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  KojoCallProtocol,
  KojoCallSlot,
  PluginContext,
} from '@kojo/plugin-api';
import { functionLookupOf } from '@kojo/plugin-api';
import { provideSignatureHelp as provideKojo2SignatureHelp } from '@kojo/plugin-kojo-lang';
import { createErbLangPlugin, erbParamsOf, provideErbSignatureHelp } from '../src/index';

const ERB_PATH = 'D:/proj/ERB/口上/1_测试.ERB';

const SLOTS: readonly KojoCallSlot[] = [
  { index: 3, kind: 'int', label: '事件子参数' },
  { index: 4, kind: 'int', label: '日期偏移' },
  { index: 1, kind: 'str', label: '发言文本' },
];

/** 协议桩：只认 `F`；`seen` 用来钉"每次都现取、不缓存" */
function protocolStub(
  slots: readonly KojoCallSlot[] | null,
  seen?: (name: string) => void,
): KojoCallProtocol {
  return {
    slotsFor: (functionName: string) => {
      seen?.(functionName);
      return functionName === 'F' ? slots : null;
    },
  };
}

/** 签名请求（其余格与本供方无关：它只读 `text` / `line` / `column` + 身份两格） */
function request(
  text: string,
  line: number,
  column: number,
  over: Partial<EditorLanguageServiceRequest> = {},
): EditorLanguageServiceRequest {
  return {
    kind: 'signatureHelp',
    path: ERB_PATH,
    languageId: 'kojo-erb',
    version: 1,
    text,
    line,
    column,
    project: null,
    ...over,
  } as EditorLanguageServiceRequest;
}

/** 一份最小可用的 ERB 索引（`byName` **必须**走契约的列式构造口，见 PITFALLS 286） */
function erbIndexStub(functions: readonly ErbFunction[]): ErbIndex {
  const refs: ErbFunctionRef[] = functions.map((fn) => ({
    name: fn.name,
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    endLine: fn.endLine,
  }));
  const groups = new Map<string, ErbFunctionRef[]>();
  for (const ref of refs) {
    const list = groups.get(ref.normalizedName);
    if (list) list.push(ref);
    else groups.set(ref.normalizedName, [ref]);
  }
  const files = new Map<string, ErbFile>();
  for (const fn of functions) {
    const file = files.get(fn.filePath);
    if (file) file.functions.push(fn);
    else
      files.set(fn.filePath, {
        path: fn.filePath,
        functions: [fn],
        dims: [],
        hasFunctionDirective: false,
        lineCount: fn.endLine,
      });
  }
  return {
    files,
    byName: functionLookupOf([...groups.entries()]),
  } as unknown as ErbIndex;
}

function erbFunction(name: string, params: readonly string[], startLine = 1): ErbFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    params: params.map((p) => ({ name: p, hasDefault: false })),
    startLine,
    endLine: startLine + 4,
    filePath: ERB_PATH,
  };
}

/* ============================== ① 三态 ============================== */

describe('erb-signatureHelp · 三态分家', () => {
  it('弃权：非 `signatureHelp` 的 kind ⇒ `undefined`（不是空结果）', () => {
    const other = { ...request('F(A)', 1, 4), kind: 'hover' } as EditorLanguageServiceRequest;
    expect(provideErbSignatureHelp(other)).toBeUndefined();
  });

  it('弃权：非 ERB 的语言 ⇒ `undefined`（让 kojo2 / kojo1 那一枚接手）', () => {
    const kojo2 = request('F(A)', 1, 4, { languageId: 'kojo2', path: 'D:/proj/2.口上.kojo' });
    expect(provideErbSignatureHelp(kojo2)).toBeUndefined();
  });

  it('空答：认这门语言、但两表都不认识这个被调名 ⇒ `{ signatures: [] }`（**作答**）', () => {
    const result = provideErbSignatureHelp(request('UNKNOWN(A, B)', 1, 9));
    expect(result).toEqual({ kind: 'signatureHelp', signatures: [] });
  });

  it('作答：一条签名（`label` 与 `parameters` 逐字一致，宿主按参数标签定位高亮）', () => {
    const result = provideErbSignatureHelp(request('F(A, B)', 1, 4), {
      callProtocol: () => protocolStub(SLOTS),
    });
    expect(result?.kind).toBe('signatureHelp');
    expect(result?.signatures).toHaveLength(1);
    const signature = result!.signatures[0]!;
    expect(signature.label).toBe('F(ARG:3 事件子参数, ARG:4 日期偏移, ARGS:1 发言文本)');
    expect(signature.parameters).toEqual(['ARG:3 事件子参数', 'ARG:4 日期偏移', 'ARGS:1 发言文本']);
    expect(signature.label.split(', ').every((piece) => signature.parameters.includes(piece))).toBe(true);
    expect(signature.activeParameter).toBe(0);
  });
});

/* ============================== ② 与 kojo2 那家互斥 ============================== */

describe('两家互斥：同一请求永远只有一家作答', () => {
  it('本供方对 kojo2 请求弃权（已由 ① 钉过），kojo2 那家对 ERB 请求同样弃权', () => {
    const erb = request('F(A, B)', 1, 4);
    expect(provideKojo2SignatureHelp(erb)).toBeUndefined();
    expect(provideErbSignatureHelp(erb, { callProtocol: () => protocolStub(SLOTS) })).toBeDefined();
  });

  it('kojo2 请求由 kojo2 那家作答（本供方不参与）', () => {
    const kojo2 = request('# 模 甲(数值 乙)\n! 甲(', 2, 5, {
      languageId: 'kojo2',
      path: 'D:/proj/2.口上.kojo',
    });
    expect(provideErbSignatureHelp(kojo2)).toBeUndefined();
    expect(provideKojo2SignatureHelp(kojo2)?.signatures.length).toBeGreaterThan(0);
  });
});

/* ============================== ③④ 两张表的先后与「不猜」 ============================== */

describe('两张表：先协议、后用户函数形参；都不认就不答', () => {
  it('协议认识 ⇒ 用槽语义，形参表**不被问**（先具体后泛化）', () => {
    const asked: string[] = [];
    const index = erbIndexStub([erbFunction('F', ['不该被用'])]);
    const result = provideErbSignatureHelp(request('F(A)', 1, 4), {
      callProtocol: () =>
        protocolStub(SLOTS, (name) => {
          asked.push(name);
        }),
      index: () => index,
    });
    expect(asked).toEqual(['F']);
    expect(result!.signatures[0]!.label).toContain('ARG:3 事件子参数');
  });

  it('协议不认识 ⇒ 用 ERB 用户函数的形参**原文**（`M_FOO(ARG, ARGS:1)`）', () => {
    const index = erbIndexStub([erbFunction('M_FOO', ['ARG', 'ARGS:1'])]);
    const result = provideErbSignatureHelp(request('M_FOO(1, 2)', 1, 7), {
      callProtocol: () => protocolStub(null),
      index: () => index,
    });
    expect(result!.signatures).toEqual([
      { label: 'M_FOO(ARG, ARGS:1)', parameters: ['ARG', 'ARGS:1'], activeParameter: 1 },
    ]);
  });

  it('两表都不认识 ⇒ 空答，**不造 ARG:n 兜底名**、不按实参个数猜形参', () => {
    const result = provideErbSignatureHelp(request('M_BAR(1, 2, 3)', 1, 8), {
      callProtocol: () => protocolStub(null),
      index: () => erbIndexStub([]),
    });
    expect(result).toEqual({ kind: 'signatureHelp', signatures: [] });
  });

  it('被调名归一化口径：小写写法也查得到（Emuera 函数名大小写不敏感）', () => {
    const index = erbIndexStub([erbFunction('M_Foo', ['ARG'])]);
    expect(erbParamsOf(index, 'm_foo')?.map((p) => p.name)).toEqual(['ARG']);
    expect(erbParamsOf(index, 'M_NOPE')).toBeNull();
    expect(erbParamsOf(null, 'M_Foo')).toBeNull();
  });

  it('同名多定义：按聚合顺序第一条定义回找函数体（第一条不在该文件里 ⇒ `null`，不猜第二条）', () => {
    const index = erbIndexStub([erbFunction('M_DUP', ['第一个'], 3)]);
    expect(erbParamsOf(index, 'M_DUP')?.map((p) => p.name)).toEqual(['第一个']);
  });
});

/* ============================== ⑤ 跨行 ============================== */

describe('跨行调用照常应答（判据搬走后这条不许退成"只读当前行"）', () => {
  it('左括号在上一行：游标在本行第二个实参 ⇒ 协议表应答、activeParameter=1', () => {
    const text = ['CALL F(', '  1, 2)'].join('\n');
    const result = provideErbSignatureHelp(request(text, 2, 7), {
      callProtocol: () => protocolStub(SLOTS),
    });
    expect(result!.signatures[0]!.activeParameter).toBe(1);
  });

  it('游标在字符串字面量里 ⇒ 空答（不猜）', () => {
    const result = provideErbSignatureHelp(request('CALL F("A, B|")', 1, 12), {
      callProtocol: () => protocolStub(SLOTS),
    });
    expect(result).toEqual({ kind: 'signatureHelp', signatures: [] });
  });

  it('注释行（`;` 起头）里的调用 ⇒ 空答', () => {
    const result = provideErbSignatureHelp(request('; CALL F(A)', 1, 10), {
      callProtocol: () => protocolStub(SLOTS),
    });
    expect(result).toEqual({ kind: 'signatureHelp', signatures: [] });
  });
});

/* ============================== ⑥ 缺席面与抛错面 ============================== */

describe('事实缺席 / 取数抛错：一律退化成空答，绝不抛进击键路径', () => {
  it('没有 adapter、没有索引（deps 缺席）⇒ 空答', () => {
    expect(provideErbSignatureHelp(request('F(A)', 1, 4))).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });

  it('adapter 表取数抛错 ⇒ 空答（旧桥那枚交 `undefined`；空答同样是"这一格没话说"）', () => {
    expect(
      provideErbSignatureHelp(request('F(A)', 1, 4), {
        callProtocol: () => {
          throw new Error('槽没了');
        },
      }),
    ).toEqual({ kind: 'signatureHelp', signatures: [] });
  });

  it('索引取数抛错 ⇒ 空答（协议不认识时才会走到这一路）', () => {
    expect(
      provideErbSignatureHelp(request('M_FOO(1)', 1, 7), {
        callProtocol: () => protocolStub(null),
        index: () => {
          throw new Error('索引在途');
        },
      }),
    ).toEqual({ kind: 'signatureHelp', signatures: [] });
  });

  it('协议表自己抛错 ⇒ 空答（判据内部已吞，供方再兜一层）', () => {
    const throwing: KojoCallProtocol = {
      slotsFor: () => {
        throw new Error('表坏了');
      },
    };
    expect(
      provideErbSignatureHelp(request('F(A)', 1, 4), { callProtocol: () => throwing }),
    ).toEqual({ kind: 'signatureHelp', signatures: [] });
  });
});

/* ============================== ⑦ 插件装配 ============================== */

describe('插件装配：四枚贡献分枚注册、id 稳定', () => {
  function activate(): Map<string, EditorLanguageServiceContribution> {
    const registered = new Map<string, EditorLanguageServiceContribution>();
    const ctx = {
      slots: {
        register: (_slot: string, item: EditorLanguageServiceContribution) => {
          registered.set(item.id, item);
          return () => registered.delete(item.id);
        },
      },
      // 装配断言不碰内核服务：tryInject 一律"没有"，两路事实缺席 ⇒ 空答（正是 ⑥ 的口径）
      tryInject: () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as PluginContext;
    createErbLangPlugin().activate(ctx);
    return registered;
  }

  it('四枚都在：erb-documentHighlight / erb-selectionRange / erb-formatting / erb-signatureHelp', () => {
    expect([...activate().keys()]).toEqual([
      'erb-documentHighlight',
      'erb-selectionRange',
      'erb-formatting',
      'erb-signatureHelp',
    ]);
  });

  it('签名那枚的 provide 走同一条判据：ERB 请求作答、非 ERB 弃权（本插件不自己抄一份）', () => {
    const contribution = activate().get('erb-signatureHelp')!;
    expect(contribution.order).toBe(10);
    expect(contribution.provide(request('F(A)', 1, 4))).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
    expect(
      contribution.provide(request('F(A)', 1, 4, { languageId: 'kojo2', path: 'D:/x.kojo' })),
    ).toBeUndefined();
  });
});
