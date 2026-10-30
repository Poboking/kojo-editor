/**
 * `@kojo/plugin-kojo-lang` 的判据（B2）。
 *
 * 六组断言，各自防一种真实退化：
 * 1. **语言分派**：`languageId` 优先、缺省退回扩展名、大小写不敏感 —— 分派错了，
 *    要么整门语言哑掉，要么把 ERB 的请求接过来（那会让 ERB 的 F12 跳到一个 2.0 位置）；
 * 2. **三态**：弃权（`undefined`）与"认了但没话说"（空数组）**不能混** —— 混了之后
 *    宿主的多源合并会把空结果当成"这家说了没有"，后面的供方永远轮不到；
 * 3. **定义落点**：命中名字段（不是行首）、区间半开、`column === span.columnStart`；
 * 4. **大纲树**：`container` 组树、父恒在前、坏 `container` 退顶层（不静默丢结构）；
 * 5. **类别映射**：2.0 的十种符号压到契约的四个中性类别，**每一种都有归宿**
 *    （漏一种会静默变成 `declaration`，大纲图标从此全是同一个）；
 * 6. **提示类别映射**：包里三种语言语义（类型 / 绑定 / 表档）→ 契约三种画法
 *    （`type` / `parameter` / `text`）。**必须三档互不相同**——塌成一档的表现是
 *    "表档摘要被画成形参色"，作者会以为那是个参数；
 * 7. **adapter 注入**：命名集合的绑定名只能来自 adapter，注入才给、不注入不猜；
 * 8. **插件装配**：五枚语言服务贡献 + 一枚语言面都注册、id 稳定、只注册一次。
 * （补全 / 悬停两条腿的判据在 `completion-hover.test.ts`，B3c。）
 */
import { describe, expect, it } from 'vitest';
import type { MonacoLanguageSurface, PluginContext } from '@kojo/plugin-api';
import type { GameAdapter } from '@kojo/kojo-core';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { KOJO2_MONARCH } from '@kojo/kojo-lang/monarch';
import { KOJO2_LANGUAGE_CONFIGURATION } from '@kojo/kojo-lang/language-config';
import { KOJO2_THEME_SURFACES } from '@kojo/kojo-lang/monaco-theme';
import {
  createKojoLangPlugin,
  isKojo2Request,
  provideDefinition,
  provideDocumentSymbols,
  provideInlayHints,
  symbolFactsToTree,
} from '../src/index';

const SOURCE = [
  '// 夹具：两幕 + 表 + 池 + 模 + 函 + 织，覆盖全部有结构的种类',
  '# 幕 神社清晨',
  '# 设 今天已触发 整数 = 0 存档',
  '',
  '# 对照表 心情 依据 恋慕',
  '    0..99 -> 疏远',
  '    否 -> 未知',
  '',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 数值',
  '',
  '> 晨光透过鸟居{今天已触发}。',
  '# 幕 神社黄昏',
  '> 夕阳西下。',
].join('\n');

/** 造一份 `definition` 请求（缺省 languageId = kojo2，模拟宿主真实投递） */
function defRequest(line: number, column: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'definition' as const,
    path: 'D:/proj/口上/1_测试.kojo2',
    text: SOURCE,
    line,
    column,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

describe('语言分派（isKojo2Request）', () => {
  it('有 languageId 就以它为准（哪怕路径扩展名不符）', () => {
    expect(isKojo2Request({ languageId: 'kojo2', path: 'D:/x/a.erb' })).toBe(true);
    expect(isKojo2Request({ languageId: 'erb', path: 'D:/x/a.kojo2' })).toBe(false);
  });

  it('没有 languageId 才退回扩展名，且大小写不敏感', () => {
    expect(isKojo2Request({ path: 'D:/x/a.kojo2' })).toBe(true);
    expect(isKojo2Request({ path: 'D:/x/A.KOJO2' })).toBe(true);
    // B3j：LAU-3b-FLIP 起 `.kojo` 是 2.0 的主场扩展名——槽 `ui.editor.codeAction` 的请求
    // 只有 `path`、没有 languageId，这条路必须认得出主场文件（`.kojo1` 不匹配）。
    expect(isKojo2Request({ path: 'D:/x/a.kojo' })).toBe(true);
    expect(isKojo2Request({ path: 'D:/x/A.KOJO' })).toBe(true);
    expect(isKojo2Request({ path: 'D:/x/a.kojo1' })).toBe(false);
    expect(isKojo2Request({ path: 'D:/x/a.kojo2x' })).toBe(false);
  });
});

describe('definition 供方', () => {
  it('声明行上按 F12 ⇒ 落在自己名字段（不是行首）', () => {
    const result = provideDefinition(defRequest(3, 4));
    expect(result?.kind).toBe('definition');
    const first = result!.locations[0]!;
    expect(first.line).toBe(3);
    // `# 设 今天已触发` —— `#` 是第 1 列，空格第 2 列，`设` 第 3 列，空格，名字从第 5 列起
    expect(first.column).toBe(5);
    expect(first.span?.columnStart).toBe(5);
    expect(first.span!.columnEnd!).toBeGreaterThan(5);
  });

  it('台词插值里的名字 ⇒ 跳到声明行的名字段（插值内是代码面）', () => {
    // 第 12 行 `> 晨光透过鸟居{今天已触发}。`，`{` 在第 9 列 ⇒ 第 11 列落在名字里
    const result = provideDefinition(defRequest(12, 11));
    expect(result!.locations[0]!.line).toBe(3);
    expect(result!.locations[0]!.column).toBe(5);
  });

  it('台词正文（不在插值里）不跳 —— 那是文本，不是引用', () => {
    expect(provideDefinition(defRequest(12, 4))).toEqual({ kind: 'definition', locations: [] });
  });

  it('认这篇但此处没有可跳的声明 ⇒ 空数组（不是弃权）', () => {
    const result = provideDefinition(defRequest(12, 1));
    expect(result).toEqual({ kind: 'definition', locations: [] });
  });

  it('不是 2.0 的请求 ⇒ undefined（弃权，让下一家接手）', () => {
    expect(provideDefinition(defRequest(3, 4, { languageId: 'erb' }))).toBeUndefined();
    expect(provideDefinition({ kind: 'documentSymbol' } as never)).toBeUndefined();
  });

  it('`projectFiles` 缺席 / 空 ⇒ 与同文件判据逐字相同（旧宿主零改动）', () => {
    const baseline = provideDefinition(defRequest(12, 11));
    expect(provideDefinition(defRequest(12, 11, { projectFiles: [] }))).toEqual(baseline);
    expect(baseline!.locations).toHaveLength(1);
    expect(baseline!.locations[0]!.filePath).toBe('D:/proj/口上/1_测试.kojo2');
  });

  it('本文没有声明 ⇒ 跨文件落点带真实 `filePath`（本次新增的 additive 腿）', () => {
    const source = '灵梦：「{声望}还差一点。」';
    const result = provideDefinition(
      defRequest(1, 6, {
        text: source,
        projectFiles: [{ path: 'D:/proj/口上/0_共用.kojo2', text: '# 设 声望 整数 = 1' }],
      }),
    );
    expect(result!.locations).toHaveLength(1);
    expect(result!.locations[0]).toEqual({
      filePath: 'D:/proj/口上/0_共用.kojo2',
      line: 1,
      column: 5,
      span: { columnStart: 5, columnEnd: 7 },
      kind: 'definition',
    });
  });

  it('同文件有声明时不再交项目里的同名声明（同文件优先）', () => {
    const result = provideDefinition(
      defRequest(12, 11, {
        projectFiles: [{ path: 'D:/proj/口上/0_共用.kojo2', text: '# 设 今天已触发 整数 = 1' }],
      }),
    );
    expect(result!.locations).toHaveLength(1);
    expect(result!.locations[0]!.filePath).toBe('D:/proj/口上/1_测试.kojo2');
  });

  it('快照不完整（projectFilesComplete=false）不影响已算出的落点（只提示，不猜也不吞）', () => {
    const result = provideDefinition(
      defRequest(1, 6, {
        text: '灵梦：「{声望}还差一点。」',
        projectFiles: [{ path: 'D:/proj/口上/0_共用.kojo2', text: '# 设 声望 整数 = 1' }],
        projectFilesComplete: false,
      }),
    );
    expect(result!.locations).toHaveLength(1);
    expect(result!.locations[0]!.filePath).toBe('D:/proj/口上/0_共用.kojo2');
  });
});

describe('documentSymbol 供方', () => {
  it('交回嵌套树：第二幕的声明挂在自己那一幕下', () => {
    const result = provideDocumentSymbols({
      kind: 'documentSymbol',
      path: 'D:/proj/a.kojo2',
      text: SOURCE,
      project: null,
      languageId: 'kojo2',
    } as never);
    expect(result?.kind).toBe('documentSymbol');
    const scenes = result!.symbols.filter((s) => s.name === '神社清晨' || s.name === '神社黄昏');
    expect(scenes).toHaveLength(2);
    const first = scenes[0]!;
    expect(first.kind).toBe('section');
    expect(first.children?.map((c) => c.name)).toEqual(['今天已触发', '心情', '增加羁绊']);
    // 第二幕没有声明，不该收第一幕的孩子
    expect(scenes[1]!.children ?? []).toEqual([]);
  });

  it('不是 2.0 的请求 ⇒ undefined', () => {
    expect(
      provideDocumentSymbols({ kind: 'documentSymbol', path: 'a.erb', text: '', project: null, languageId: 'erb' } as never),
    ).toBeUndefined();
    expect(provideDefinition({ kind: 'foldingRange' } as never)).toBeUndefined();
  });
});

describe('组树（symbolFactsToTree）', () => {
  const fact = (name: string, container?: number) => ({
    name,
    detail: `# ${name}`,
    kind: 'variable' as const,
    range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
    selectionRange: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 },
    ...(container === undefined ? {} : { container }),
  });

  it('container 指向前面的符号 ⇒ 挂成子项', () => {
    const tree = symbolFactsToTree([fact('a'), fact('b', 0)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children?.map((c) => c.name)).toEqual(['b']);
  });

  it('坏 container（越界 / 负数 / 指向自己或后面）⇒ 退顶层，不静默丢结构', () => {
    const tree = symbolFactsToTree([fact('a', 5), fact('b', -1), fact('c', 2)]);
    expect(tree.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });

  it('detail 为空串时不写这一格（大纲不留空副标题）', () => {
    const tree = symbolFactsToTree([{ ...fact('a'), detail: '' }]);
    expect('detail' in tree[0]!).toBe(false);
  });
});

describe('inlayHint 供方', () => {
  /** 夹具：三种提示各一行（类型 / 表档 / 绑定） */
  const INLAY_SOURCE = [
    '# 设 队伍 整数[3]',
    '# 对照表 心情 依据 恋慕',
    '    0..99 -> 疏远',
    '    否 -> 未知',
    '@巡 队伍',
  ].join('\n');

  function inlayRequest(over: Record<string, unknown> = {}) {
    return {
      kind: 'inlayHint' as const,
      path: 'D:/proj/a.kojo2',
      text: INLAY_SOURCE,
      project: null,
      languageId: 'kojo2',
      ...over,
    } as never;
  }

  /** 只造 `@巡` 提示要读的两格；其余 adapter 字段与提示无关（cast 保测试短） */
  function fakeAdapter(
    collections: readonly { readonly name: string; readonly bindings: readonly string[] }[],
    arrayRule: { readonly bindings: readonly string[] } | null = null,
  ): GameAdapter {
    return { id: 'test', foreachCollections: { collections, arrayRule } } as unknown as GameAdapter;
  }

  const labelOf = (hints: readonly { label: string }[], needle: string): string | undefined =>
    hints.find((h) => h.label.includes(needle))?.label;

  it('三种语言语义各自落到不同的画法（塌成一档 = 表档摘要被画成形参色）', () => {
    const hints = provideInlayHints(inlayRequest())!.hints;
    const kinds = new Set(hints.map((h) => h.kind));
    expect(hints).toHaveLength(3);
    expect(kinds).toEqual(new Set(['type', 'parameter', 'text']));
    // 逐个钉：类型 → type、绑定 → parameter、表档 → text
    expect(hints.find((h) => h.label === '整数[3]')?.kind).toBe('type');
    expect(hints.find((h) => h.label.startsWith('{'))?.kind).toBe('parameter');
    expect(hints.find((h) => h.label.includes('档'))?.kind).toBe('text');
  });

  it('坐标与 label 原样透传（`lineNumber` → `line`，零换算）', () => {
    const hints = provideInlayHints(inlayRequest())!.hints;
    const type = hints.find((h) => h.kind === 'type')!;
    expect(type.line).toBe(1);
    // `# 设 队伍 整数[3]` 共 12 个字符 ⇒ 提示压在末字之后第 13 列（1 基）
    expect(type.column).toBe(13);
    expect(type.label).toBe('整数[3]');
  });

  it('`paddingLeft` 只在为真时写出（缺省 = 不写，与补 kind 之前逐字一致）', () => {
    const hints = provideInlayHints(inlayRequest())!.hints;
    expect(hints.every((h) => h.paddingLeft === true)).toBe(true);
    expect(hints.every((h) => 'paddingRight' in h)).toBe(false);
  });

  it('没有 adapter ⇒ 本文件声明的数组照给默认绑定名（`{值} {下标}`），不猜命名集合', () => {
    const hints = provideInlayHints(inlayRequest())!.hints;
    expect(labelOf(hints, '{')).toBe('{值} {下标}');
  });

  it('注入 adapter ⇒ 命名集合用 adapter 的绑定名（`{角} {名}`）', () => {
    const adapter = fakeAdapter([{ name: '队伍', bindings: ['角', '名'] }]);
    const hints = provideInlayHints(inlayRequest(), { adapter })!.hints;
    expect(labelOf(hints, '{')).toBe('{角} {名}');
  });

  it('adapter 明确不支持 `@巡`（`foreachCollections = null`）⇒ 本文件数组也不给', () => {
    const adapter = { id: 'test', foreachCollections: null } as unknown as GameAdapter;
    const hints = provideInlayHints(inlayRequest(), { adapter })!.hints;
    expect(labelOf(hints, '{')).toBeUndefined();
  });

  it('不是 2.0 的请求 / 不是 inlayHint ⇒ undefined（弃权）', () => {
    expect(provideInlayHints(inlayRequest({ languageId: 'erb' }))).toBeUndefined();
    expect(provideInlayHints({ kind: 'definition' } as never)).toBeUndefined();
  });
});

describe('插件装配', () => {
  it('注册十四枚语言服务 + 一枚语言面，id 稳定、order 相同', () => {
    const registered: { slot: string; item: { id: string; order?: number } }[] = [];
    const ctx = {
      pluginId: 'kojo-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, item: { id: string; order?: number }) => {
          registered.push({ slot, item });
          return () => undefined;
        },
      },
    } as unknown as PluginContext;

    createKojoLangPlugin().activate(ctx);

    expect(registered.map((r) => r.item.id)).toEqual([
      'kojo2-definition',
      'kojo2-symbols',
      'kojo2-inlay',
      // B3c：补全 / 悬停**分枚注册**（completion 并集型、hover 单答型，三态口径不同，不许塞进同一枚 provide）
      'kojo2-completion',
      'kojo2-hover',
      // B3d：签名帮助 / 格式化同样分枚注册（单答型；格式化不吃任何注入面）
      'kojo2-signatureHelp',
      'kojo2-formatting',
      // B3e：引用 / 改名同样分枚注册（单答型；两条腿都只读请求里的文本与项目快照）
      'kojo2-references',
      'kojo2-rename',
      // B3f：同符号高亮 / 结构化扩选同样分枚注册（单答型；一条腿的作答与否不带走另一条）
      'kojo2-documentHighlight',
      'kojo2-selectionRange',
      // B3g：行上注解同样分枚注册（单答型；整篇一次，不取 adapter）
      'kojo2-codeLens',
      // B3h：折叠区间（结构快照 → 契约区间；槽内同步作答，不 await worker）
      'kojo2-foldingRange',
      // B3 语义收口：结构化着色（捕获快照 → 契约区间；与折叠同形，槽内同步作答）
      'kojo2-semanticTokens',
      // B3j：一键迁移动作进**既有槽** `ui.editor.codeAction`（不是语言服务的第十三个 kind）
      'kojo2-codeActions',
      // B3 收口最后一格：文档级诊断进**既有专用槽** `ui.editor.decorator`（不是新判别成员）
      'kojo2-diagnostics',
      // B4：语言面（Monarch / 语言配置 / 三套主题声明）——槽不同，但同样是"注册期交出"
      'kojo2-monaco-language',
    ]);
    expect(registered.map((r) => r.slot)).toEqual([
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      // B3f 两枚（high / selection）+ B3g 一枚（codeLens）仍是同一槽
      'ui.editor.languageService',
      'ui.editor.languageService',
      'ui.editor.languageService',
      // B3h 折叠 / B3 语义收口各一枚
      'ui.editor.languageService',
      'ui.editor.languageService',
      // B3j：一键迁移走专用槽（诊断 / 快速修复各有专用槽，不开语言服务的新判别成员）
      'ui.editor.codeAction',
      // B3 收口最后一格：文档级诊断走专用槽 `ui.editor.decorator`（LineDecoration 即诊断形状）
      'ui.editor.decorator',
      'ui.monaco.language',
    ]);
    expect(new Set(registered.map((r) => r.item.order)).size).toBe(1);
  });

  it('语言面贡献交出的就是语言面库那几枚对象本体（不抄第二份数据）', () => {
    const registered: { slot: string; item: { surface?: MonacoLanguageSurface } }[] = [];
    const ctx = {
      pluginId: 'kojo-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, item: { surface?: MonacoLanguageSurface }) => {
          registered.push({ slot, item });
          return () => undefined;
        },
      },
    } as unknown as PluginContext;

    createKojoLangPlugin().activate(ctx);
    const surface = registered.find((r) => r.slot === 'ui.monaco.language')?.item.surface;
    expect(surface?.languageId).toBe(KOJO2_LANGUAGE_ID);
    // **引用相等**：契约要求稳定引用（宿主按引用判重复注册），值相等而对象两份就是抄本
    expect(surface?.monarch).toBe(KOJO2_MONARCH);
    expect(surface?.configuration).toBe(KOJO2_LANGUAGE_CONFIGURATION);
    expect(surface?.themes).toBe(KOJO2_THEME_SURFACES);
  });

  it('id 与版本是契约的一部分（改名即断链，存储域也按它分）', () => {
    const plugin = createKojoLangPlugin();
    expect(plugin.id).toBe('kojo-lang');
    expect(plugin.version).toBe('0.0.0');
    // 零依赖：判据全在 `@kojo/kojo-lang`，不吃任何服务
    expect(plugin.requires ?? []).toEqual([]);
    expect(plugin.provides ?? []).toEqual([]);
  });
});
