/**
 * B3d · Kojo 2.0 签名帮助的**宿主翻译层**闸（判据已整块搬进 `@kojo/kojo-lang/signature`）。
 *
 * 本文件只钉宿主自己那一格——**"契约 → Monaco"与"注册"**，五件事：
 * 1. **翻译形状**：`label` / `parameters` 原样交、`documentation` 只在有值时出现、
 *    顶层 `activeParameter` 取激活签名的那一格、空表 ⇒ `undefined`（不占浮层）；
 * 2. **触发字符**：`(` / `,`（宿主自定，只服务注册）+ 与既有清单合并去重；
 * 3. **共享收口**：经 `registerForLanguageServices(..., 'signatureHelp')` 挂到
 *    "全铺语言 + descriptor 点名了这枚能力"的语言上；dispose 幂等、半途抛错回滚；
 * 4. **三态**：无人应答（`undefined`）⇒ 宿主也 `undefined`（继续问下一家）；
 *    有人答空表 ⇒ `undefined`（不弹也不回顶）；有签名 ⇒ `{ value, dispose }`；
 * 5. **请求构造**：身份三格 / 全文 / 光标位点 / 项目原样递，行数同一把尺。
 *
 * 判据（调用位 / 声明头 / `@巡` 集合名 / 夹取口径 / 跨行回看）一条都不在这里——
 * 它们在 `packages/kojo-lang/tests/signature.test.ts`，搬走时逐条保留。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorLanguageServiceContribution, EditorSignature } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { languageDescriptors } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
// SDK-B5b 车 2（2026-10-31）：宿主翻译层从 `monaco/kojo2-signature.ts` 并进语言无关的槽腿
// 工厂（`legOf('signatureHelp', …)`）；触发字符与合并去重仍是**注册期语言事实**，同住工厂。
import {
  KOJO2_SIGNATURE_TRIGGER_CHARS,
  installSlotServiceLegs,
  mergeTriggerCharacters,
  toMonacoSignatureHelp,
} from '../src/monaco/slot-service-providers';

const HERE = import.meta.dirname;
const LAYER_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'slot-service-providers.ts'),
  'utf8',
);

/* ============================== 共享收口的期望 selector ============================== */

/**
 * 期望 selector **从 descriptor 表现算**，不手抄语言 id 清单（与补全 / 悬停同一条纪律）：
 * 手抄一份就成"第二张真源"，哪天新语言点名了这条腿，这里会跟着自动覆盖。
 */
const SIGNATURE_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('signatureHelp') === true,
  )
  .map((descriptor) => descriptor.id);

/* ============================== 假 Monaco / 假 model / 假内核 ============================== */

interface Registration {
  readonly selector: unknown;
  readonly provider: Monaco.languages.SignatureHelpProvider;
}

function fakeMonaco(failAt = -1): {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: () => number;
} {
  const registrations: Registration[] = [];
  let disposeCalls = 0;
  const fake = {
    languages: {
      registerSignatureHelpProvider: (
        selector: unknown,
        provider: Monaco.languages.SignatureHelpProvider,
      ) => {
        if (registrations.length === failAt) throw new Error('桩：注册抛错');
        registrations.push({ selector, provider });
        return {
          dispose: () => {
            disposeCalls += 1;
          },
        };
      },
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    registrations,
    disposeCalls: () => disposeCalls,
  };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakGetValue: () => void;
}

function fakeModel(text: string, languageId = KOJO2_LANGUAGE_ID): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLanguageId: () => languageId,
    getVersionId: () => 7,
    uri: { scheme: 'file', path: '/proj/chara.kojo2', fsPath: '/proj/chara.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    breakGetValue: () => {
      broken = true;
    },
  };
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

/** 装一枚假内核：`slots.query` 交回给定的贡献（与 `kernel.slots.query` 同形状） */
function installKernel(
  contributions: readonly EditorLanguageServiceContribution[],
  project: unknown = { adapterId: 'proj-a' },
): void {
  setGlobalKernel({
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []),
    },
    project: { current: () => project },
  } as unknown as KernelLike);
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const CONTEXT = {
  triggerKind: 1,
  triggerCharacter: '(',
  isRetrigger: false,
} as unknown as Monaco.languages.SignatureHelpContext;

/** provider 的"问一次"捷径（第 3 / 4 参本层不用） */
function ask(
  provider: Monaco.languages.SignatureHelpProvider,
  model: Monaco.editor.ITextModel,
  line = 1,
  column = 1,
): Monaco.languages.SignatureHelp | undefined {
  const result = provider.provideSignatureHelp(
    model,
    { lineNumber: line, column } as Monaco.Position,
    TOKEN,
    CONTEXT,
  ) as Monaco.languages.SignatureHelpResult | undefined;
  return result?.value;
}

/** 一条贡献（`provide` 的返回由用例决定） */
function contributionOf(
  provide: EditorLanguageServiceContribution['provide'],
  id = 'stub-signature',
): EditorLanguageServiceContribution {
  return { id, provide };
}

/** 只认 `signatureHelp`、答固定签名的贡献 */
function signatureContribution(
  signatures: readonly EditorSignature[],
  id = 'stub-signature',
): EditorLanguageServiceContribution {
  return contributionOf(
    (request) =>
      request.kind === 'signatureHelp' ? { kind: 'signatureHelp', signatures } : undefined,
    id,
  );
}

const SIGNATURE: EditorSignature = {
  label: '增加羁绊(目标, 数值 = 10)',
  parameters: ['目标', '数值 = 10'],
  activeParameter: 1,
  documentation: '默认值：10',
};

/** 装一条槽腿，取回 kojo2 上那一枚 provider（没挂上直接抛：证据缺席不许静默） */
function kojo2ProviderOf(): Monaco.languages.SignatureHelpProvider {
  const fake = fakeMonaco();
  installSlotServiceLegs(fake.monaco, ['signatureHelp']);
  const provider = fake.registrations.find(
    (entry) => entry.selector === KOJO2_LANGUAGE_ID,
  )?.provider;
  if (provider === undefined) throw new Error('kojo2 上没有挂签名 provider');
  return provider;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================== ① 契约 → Monaco ============================== */

describe('①契约 → Monaco：标签原样、说明只在有值时出现、夹取下标', () => {
  it('一整条签名：parameters 只带 label、documentation 落在签名级、顶层 activeParameter 跟激活签名', () => {
    const help = toMonacoSignatureHelp([SIGNATURE])!;
    expect(help.activeSignature).toBe(0);
    expect(help.activeParameter).toBe(1);
    const signature = help.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.parameters).toEqual([{ label: '目标' }, { label: '数值 = 10' }]);
    expect(signature.activeParameter).toBe(1);
    expect(signature.documentation).toBe('默认值：10');
  });

  it('没有 documentation ⇒ 该键**不出现**（不是 `undefined` 占位——Monaco 会渲染一个空行）', () => {
    const help = toMonacoSignatureHelp([
      { label: '无参()', parameters: [], activeParameter: 0 },
    ])!;
    expect('documentation' in help.signatures[0]!).toBe(false);
  });

  it('空表 ⇒ `undefined`（不返回空 help 把提示占住）', () => {
    expect(toMonacoSignatureHelp([])).toBeUndefined();
  });

  it('activeSignature 越界夹取；顶层 activeParameter 取**激活那一份**的格子', () => {
    const second: EditorSignature = {
      label: '取整(值, 基数=1)',
      parameters: ['值', '基数=1'],
      activeParameter: 0,
    };
    const high = toMonacoSignatureHelp([SIGNATURE, second], 99)!;
    expect(high.activeSignature).toBe(1);
    expect(high.activeParameter).toBe(0);
    const low = toMonacoSignatureHelp([SIGNATURE, second], -3)!;
    expect(low.activeSignature).toBe(0);
    expect(low.activeParameter).toBe(1);
    // 非整数下标按截断走（Monaco 传进来的只会是整数，这一格只防别人手搓）
    expect(toMonacoSignatureHelp([SIGNATURE, second], 1.9)!.activeSignature).toBe(1);
  });
});

/* ============================== ② 触发字符 ============================== */

describe('②触发字符：`(` / `,`（只服务注册）+ 合并去重', () => {
  it('基础清单 = `(` / `,`（半角逗号才是实参分隔符；`)` 不收——调用写完了）', () => {
    expect([...KOJO2_SIGNATURE_TRIGGER_CHARS]).toEqual(['(', ',']);
  });

  it('合并保持"先出现者在前"，重复 / 空串丢弃', () => {
    expect(mergeTriggerCharacters(KOJO2_SIGNATURE_TRIGGER_CHARS, [',', ')'])).toEqual([
      '(',
      ',',
      ')',
    ]);
    expect(mergeTriggerCharacters(['('], ['', '(', ' '])).toEqual(['(', ' ']);
    // 不给额外清单 ⇒ 一份副本（不是同一数组：provider 那份被 Monaco 读，别让人从外面改）
    const copy = mergeTriggerCharacters(KOJO2_SIGNATURE_TRIGGER_CHARS, undefined);
    expect(copy).toEqual(['(', ',']);
    expect(copy).not.toBe(KOJO2_SIGNATURE_TRIGGER_CHARS);
  });

  it('provider 真带上合并后的清单（生产不传 extra ⇒ 就是基础那两枚，且是一份副本）', () => {
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['signatureHelp']);
    for (const registration of fake.registrations) {
      expect(registration.provider.signatureHelpTriggerCharacters).toEqual(['(', ',']);
      // 副本：Monaco 读的是它自己那一份，别让人从外面改回包叶常量
      expect(registration.provider.signatureHelpTriggerCharacters).not.toBe(
        KOJO2_SIGNATURE_TRIGGER_CHARS,
      );
    }
  });
});

/* ============================== ③ 注册（共享收口） ============================== */

describe('③注册：共享收口 + 能力名 `signatureHelp`（不读开关）', () => {
  it('selector 清单 = descriptor 现算：全铺语言 + 点名了 `signatureHelp` 的语言', () => {
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['signatureHelp']);
    expect(fake.registrations.map((entry) => entry.selector)).toEqual(SIGNATURE_SELECTORS);
    // 反证：kojo2 确实在列（descriptor 点名了这枚能力），且不止它一门
    expect(SIGNATURE_SELECTORS).toContain(KOJO2_LANGUAGE_ID);
    expect(SIGNATURE_SELECTORS).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]);
  });

  it('每一门挂的是**同一枚** provider；dispose 幂等（逐枚各撤一次，第二次零动作）', () => {
    const fake = fakeMonaco();
    const handle = installSlotServiceLegs(fake.monaco, ['signatureHelp']);
    const providers = new Set(fake.registrations.map((entry) => entry.provider));
    expect(providers.size).toBe(1);
    handle.dispose();
    expect(fake.disposeCalls()).toBe(SIGNATURE_SELECTORS.length);
    handle.dispose();
    expect(fake.disposeCalls()).toBe(SIGNATURE_SELECTORS.length);
  });

  it('半途抛错 ⇒ 已挂上的先撤回，错误原样外抛', () => {
    const fake = fakeMonaco(1);
    expect(() => installSlotServiceLegs(fake.monaco, ['signatureHelp'])).toThrow(/桩：注册抛错/);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.disposeCalls()).toBe(1);
  });

  it('源码钉子：走共享收口、带能力名；判据与开关都不在本层', () => {
    expect(LAYER_SOURCE).toContain('registerForLanguageServices(');
    expect(LAYER_SOURCE).toContain("'signatureHelp',");
    // 原生自建注册（第一参写死 kojo2）已删干净——闸门按这条形状 grep 归零
    expect(LAYER_SOURCE).not.toMatch(/registerSignatureHelpProvider\(\s*KOJO2_LANGUAGE_ID/);
    // 判据搬走了：本层**代码**不再出现纯判据入口，也不读切流开关（头注提到搬去哪不算）
    const code = codeOf(LAYER_SOURCE);
    expect(code).not.toContain('kojo2SignatureAt');
    expect(code).not.toContain('isKojo2CutoverEnabled');
  });
});

/* ============================== ④ provider 三态（经取数腿） ============================== */

describe('④provider 三态：弃权 / 空表 / 有签名', () => {
  it('槽里无人应答（全部 `undefined`）⇒ `undefined`：不用空结果顶掉下一家', () => {
    installKernel([contributionOf(() => undefined)]);
    expect(ask(kojo2ProviderOf(), fakeModel('! 增加羁绊(1)\n').model, 1, 8)).toBeUndefined();
  });

  it('有人答空表 ⇒ `undefined`，且**不再问下一家**（空结果也是作答）', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    installKernel([signatureContribution([], 'first'), contributionOf(second, 'second')]);
    expect(ask(kojo2ProviderOf(), fakeModel('! 增加羁绊(1)\n').model, 1, 6)).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
  });

  it('有签名 ⇒ `{ value, dispose }`；**第一家**说了算（第二家不再被问）', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    installKernel([signatureContribution([SIGNATURE], 'first'), contributionOf(second, 'second')]);
    const model = fakeModel('! 增加羁绊(目标, 12)\n').model;
    const result = kojo2ProviderOf().provideSignatureHelp(
      model,
      { lineNumber: 1, column: 12 } as Monaco.Position,
      TOKEN,
      CONTEXT,
    ) as Monaco.languages.SignatureHelpResult | undefined;
    expect(result).toBeDefined();
    expect(typeof result!.dispose).toBe('function');
    expect(result!.value.signatures[0]!.label).toBe(SIGNATURE.label);
    expect(second).not.toHaveBeenCalled();
    // dispose 是"提示生命周期"的钩子，调用它不许抛
    expect(() => result!.dispose()).not.toThrow();
  });

  it('一家抛错只让这家缺席（warn 带贡献 id），下一家照答', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installKernel([
      contributionOf(() => {
        throw new Error('桩：供方炸了');
      }, 'boom'),
      signatureContribution([SIGNATURE], 'ok'),
    ]);
    const help = ask(kojo2ProviderOf(), fakeModel('! 增加羁绊(目标, 12)\n').model, 1, 12);
    expect(help!.signatures[0]!.label).toBe(SIGNATURE.label);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('boom');
  });

  it('取文抛错（模型已释放）⇒ `undefined`，不抛进击键路径', () => {
    installKernel([signatureContribution([SIGNATURE])]);
    const broken = fakeModel('! 增加羁绊(目标, 12)\n');
    broken.breakGetValue();
    expect(ask(kojo2ProviderOf(), broken.model, 1, 12)).toBeUndefined();
  });

  it('非 signatureHelp 的应答不算答（kind 不对 ⇒ 继续问下一家）', () => {
    installKernel([
      contributionOf(() => ({ kind: 'hover', contents: '不是签名' }) as never, 'wrong-kind'),
      signatureContribution([SIGNATURE], 'ok'),
    ]);
    expect(
      ask(kojo2ProviderOf(), fakeModel('! 增加羁绊(目标, 12)\n').model, 1, 12)!.signatures[0]!
        .label,
    ).toBe(SIGNATURE.label);
  });
});

/* ============================== 小工具 ============================== */

/** 纯代码面（剥掉整行注释与块注释）：源码针只钉**代码**，注释里提到搬去哪不该把针弄红 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/* ============================== ⑤ 请求形状 ============================== */

describe('⑤请求形状：身份三格 / 全文 / 光标位点 / 项目原样递', () => {
  it('请求就是 legs 的 `signatureRequestOf` 产物（1 基行列，不换算）', () => {
    let seen: unknown;
    installKernel(
      [
        contributionOf((request) => {
          seen = request;
          return { kind: 'signatureHelp', signatures: [] };
        }),
      ],
      { adapterId: 'proj-a' },
    );
    const text = '! 增加羁绊(目标, 12)\n> 第二行\n';
    ask(kojo2ProviderOf(), fakeModel(text).model, 2, 3);
    expect(seen).toEqual({
      kind: 'signatureHelp',
      path: '/proj/chara.kojo2',
      languageId: KOJO2_LANGUAGE_ID,
      version: 7,
      text,
      line: 2,
      column: 3,
      project: { adapterId: 'proj-a' },
      // Monaco 口径：结尾换行后那一格也算一行 ⇒ 两枚 `\n` = 3 行
      lineCount: 3,
    });
  });
});
