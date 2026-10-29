/**
 * B3d 签名帮助 / 格式化两条腿的判据（`src/signature.ts` + `src/format.ts` + `plugin.ts` 接线）。
 *
 * 五组断言，各自防一种真实退化：
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——混成空结果会把宿主那门语言自己的供方顶掉；
 * 2. **adapter 纪律**：`@巡` 的绑定名要方言事实，`adapter.id === project.adapterId` 才给；
 *    对不上 / 没有 project ⇒ **少给那一部分**（签名空结果），同文件的 `! 函(` 签名照给；
 * 3. **`activeParameter` 越界夹取 + 说明跟着激活位走**：实参多于形参时夹到最后一格；
 *    契约只有一整条 `documentation`，所以交的是**激活那个形参**的说明（屏上文案不变）；
 * 4. **整篇 / 区间两路**：`request.lineRange` 缺席 ⇒ 整篇；在场 ⇒ 只落选中行，区外一字节不动；
 * 5. **空结果语义**：认这门语言但这一格没签名 / 这篇不用改 ⇒ 空签名 / 空 edits（**作答**，
 *    不是弃权）——`undefined` 只留给"不是我的活"。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution, PluginContext } from '@kojo/plugin-api';
import type { ForeachArrayRule, ForeachCollectionDecl, ForeachDeclarations, GameAdapter } from '@kojo/kojo-core';
import { registerKojo2AdapterSource } from '@kojo/kojo-lang/adapter-source';
import { createKojoLangPlugin, provideFormatting, provideSignatureHelp } from '../src/index';

const PATH = 'D:/proj/口上/1_测试.kojo2';

/** 签名夹具：一个带默认值的 `@函` + 一个要 adapter 的 `@巡` 集合 + 一条调用位 */
const SOURCE = [
  '# 幕 神社清晨', // 1
  '# 设 队伍 整数[3]', // 2
  '', // 3
  '@函 增加羁绊(目标, 数值=10)', // 4
  '    @返 数值', // 5
  '', // 6
  '@巡 队伍', // 7
  '    > {角}', // 8
  '! 增加羁绊(目标, 12)', // 9
].join('\n');

/** 格式化夹具（缩进 2 → 4 的典型口上） */
const MESSY = '# 池 问候\n  ? 恋慕 < 100\n      「早。」\n  ? 否\n      我：「嗯。」\n';

function signatureRequest(line: number, column: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'signatureHelp' as const,
    path: PATH,
    text: SOURCE,
    line,
    column,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

function formattingRequest(over: Record<string, unknown> = {}) {
  return {
    kind: 'formatting' as const,
    path: PATH,
    text: MESSY,
    project: null,
    languageId: 'kojo2',
    lineCount: 6,
    ...over,
  } as never;
}

/* ---- `@巡` 的方言事实（只填这两条腿读的两格） ---- */

const TEAM: ForeachCollectionDecl = {
  name: '队伍',
  kind: 'characters',
  elementType: 'character',
  base: 1,
  keyType: null,
  length: { kind: 'engine', counter: 'CHARANUM', minus: 1 },
  bindings: ['角', '名'],
  nameAccessor: 'CALLNAME',
};

const ARRAY_RULE: ForeachArrayRule = { base: 0, bindings: ['值', '下标'] };

function stubAdapter(id: string): GameAdapter {
  const declarations: ForeachDeclarations = { collections: [TEAM], arrayRule: ARRAY_RULE };
  return {
    id,
    programFeatures: { foreach: true },
    foreachCollections: declarations,
  } as unknown as GameAdapter;
}

/** 起插件、抓 `ui.editor.languageService` 的贡献（真实接线形状，不手搓注入） */
function activate(): Map<string, EditorLanguageServiceContribution> {
  const contributions = new Map<string, EditorLanguageServiceContribution>();
  const ctx = {
    pluginId: 'kojo-lang',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    slots: {
      register: (slot: string, item: EditorLanguageServiceContribution) => {
        if (slot === 'ui.editor.languageService') contributions.set(item.id, item);
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  createKojoLangPlugin().activate(ctx);
  return contributions;
}

/* ============================== ① 语言过滤 ============================== */

describe('语言过滤：只答 kojo2（其余弃权，不是空结果）', () => {
  it('kind 不对 / languageId 不是 kojo2 ⇒ undefined', () => {
    expect(provideSignatureHelp({ kind: 'hover', path: PATH, text: '', line: 1, column: 1, project: null } as never)).toBeUndefined();
    expect(provideSignatureHelp(signatureRequest(9, 12, { languageId: 'erb' }))).toBeUndefined();
    expect(provideFormatting({ kind: 'completion', path: PATH, text: MESSY, line: 1, column: 1, project: null } as never)).toBeUndefined();
    expect(provideFormatting(formattingRequest({ languageId: 'kojo-erb' }))).toBeUndefined();
  });

  it('没有 languageId 时退回扩展名：`.kojo2` 认，别的一律弃权', () => {
    const request = { ...(signatureRequest(9, 12) as object), languageId: undefined } as never;
    expect(provideSignatureHelp(request)).toBeDefined();
    const other = { ...(formattingRequest() as object), languageId: undefined, path: 'D:/proj/a.erb' } as never;
    expect(provideFormatting(other)).toBeUndefined();
  });
});

/* ============================== ② 签名：三态 + 文档 ============================== */

describe('signatureHelp 供方：签名串 / 参数高亮 / 激活位说明', () => {
  it('调用位 ⇒ 签名串与形参原文逐字、首参高亮、说明是首参的', () => {
    const result = provideSignatureHelp(signatureRequest(9, 8))!;
    expect(result.kind).toBe('signatureHelp');
    expect(result.signatures).toHaveLength(1);
    const signature = result.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.parameters).toEqual(['目标', '数值 = 10']);
    expect(signature.activeParameter).toBe(0);
    expect(signature.documentation).toBe('必填');
    expect(result.activeSignature).toBe(0);
  });

  it('第 2 个实参 ⇒ activeParameter = 1，说明跟着走（`默认值：10`）', () => {
    const signature = provideSignatureHelp(signatureRequest(9, 12))!.signatures[0]!;
    expect(signature.activeParameter).toBe(1);
    expect(signature.documentation).toBe('默认值：10');
  });

  it('实参多于形参 ⇒ 夹到最后一格（不假造第 3 槽）', () => {
    const text = `${SOURCE}\n! 增加羁绊(1, 2, |3)\n`;
    const line = text.split('\n').length - 2;
    const signature = provideSignatureHelp(signatureRequest(line, 13, { text }))!.signatures[0]!;
    expect(signature.parameters).toHaveLength(2);
    expect(signature.activeParameter).toBe(1);
    expect(signature.documentation).toBe('默认值：10');
  });

  it('认这门语言但这一格没有签名 ⇒ `{ signatures: [] }`（作答，不是弃权）', () => {
    // 第 3 行是空行：位置门退让
    expect(provideSignatureHelp(signatureRequest(3, 1))).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
    // 未声明的被调名同理
    const text = `${SOURCE}\n! 未声明函数(1, |2)\n`;
    const line = text.split('\n').length - 2;
    expect(provideSignatureHelp(signatureRequest(line, 15, { text }))).toEqual({
      kind: 'signatureHelp',
      signatures: [],
    });
  });
});

/* ============================== ③ adapter 纪律（`@巡`） ============================== */

describe('adapter 纪律：`@巡` 的绑定名只认 id 对得上的那一枚', () => {
  it('id 对得上 ⇒ 集合签名；对不上 / 没有 project ⇒ 空结果（同文件 `! 函(` 照给）', () => {
    const unregister = registerKojo2AdapterSource(() => stubAdapter('proj-a'));
    try {
      const contributions = activate();
      const signature = contributions.get('kojo2-signatureHelp')!;
      const matched = signature.provide(
        signatureRequest(7, 5, { project: { adapterId: 'proj-a' } as never }),
      ) as { signatures: readonly { label: string; parameters: readonly string[] }[] };
      expect(matched.signatures[0]!.label).toBe('@巡 队伍(角, 名)');
      expect(matched.signatures[0]!.parameters).toEqual(['角', '名']);

      const mismatched = signature.provide(
        signatureRequest(7, 5, { project: { adapterId: 'proj-b' } as never }),
      ) as { signatures: readonly unknown[] };
      expect(mismatched.signatures).toEqual([]);

      const noProject = signature.provide(signatureRequest(7, 5)) as { signatures: readonly unknown[] };
      expect(noProject.signatures).toEqual([]);

      // 少给的只是 adapter 那一路：`! 函(` 不依赖方言事实
      const call = signature.provide(
        signatureRequest(9, 8, { project: { adapterId: 'proj-b' } as never }),
      ) as { signatures: readonly { label: string }[] };
      expect(call.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
    } finally {
      unregister();
    }
  });
});

/* ============================== ④ 格式化：整篇 / 区间 ============================== */

describe('formatting 供方：整篇 / 区间两路 + 空结果语义', () => {
  it('没有 lineRange ⇒ 整篇（逐行升序的最小 edit）', () => {
    const result = provideFormatting(formattingRequest())!;
    expect(result.kind).toBe('formatting');
    const edits = result.edits;
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.map((edit) => edit.startLine)).toEqual([2, 3, 4, 5]);
    expect(edits.every((edit) => edit.startLine === edit.endLine)).toBe(true);
    expect(edits[0]!.newText).toBe('    ? 恋慕 < 100');
    // 升序（宿主按降序落地，契约要求供方升序）
    expect([...edits].sort((a, b) => a.startLine - b.startLine)).toEqual(edits);
  });

  it('给了 lineRange ⇒ 只落选中行：一条 edit 落在区内、区外一字节不动', () => {
    const result = provideFormatting(formattingRequest({ lineRange: { startLine: 3, endLine: 3 } }))!;
    expect(result.edits).toHaveLength(1);
    const edit = result.edits[0]!;
    expect(edit.startLine).toBe(3);
    expect(edit.endLine).toBe(3);
    expect(edit.newText).toBe('        「早。」');
    expect(edit.startColumn).toBe(1);
    expect(edit.endColumn).toBe('      「早。」'.length + 1);
  });

  it('已经合规 / 空文本 ⇒ `edits: []`（认这篇、不需要改——不是弃权）', () => {
    const tidy = '# 池 问候\n    ? 恋慕 < 100\n        「早。」\n    ? 否\n        我：「嗯。」\n';
    expect(provideFormatting(formattingRequest({ text: tidy }))).toEqual({
      kind: 'formatting',
      edits: [],
    });
    expect(provideFormatting(formattingRequest({ text: '', lineRange: { startLine: 1, endLine: 1 } }))).toEqual({
      kind: 'formatting',
      edits: [],
    });
  });
});

/* ============================== ⑤ 注册纪律 ============================== */

describe('注册纪律：两条腿分枚注册、order 10、不读切流开关', () => {
  it('`kojo2-signatureHelp` / `kojo2-formatting` 各一枚，order 都是 10', () => {
    const contributions = activate();
    const ids = [...contributions.keys()].sort();
    expect(ids).toEqual([
      'kojo2-completion',
      'kojo2-definition',
      'kojo2-documentHighlight',
      'kojo2-formatting',
      'kojo2-hover',
      'kojo2-inlay',
      'kojo2-references',
      'kojo2-rename',
      'kojo2-selectionRange',
      'kojo2-signatureHelp',
      'kojo2-symbols',
    ]);
    expect(contributions.get('kojo2-signatureHelp')!.order).toBe(10);
    expect(contributions.get('kojo2-formatting')!.order).toBe(10);
  });

  it('格式化不依赖任何 adapter 事实（没登记 adapter 也照给）', () => {
    const formatting = activate().get('kojo2-formatting')!;
    const result = formatting.provide(formattingRequest()) as { edits: readonly unknown[] };
    expect(result.edits).toHaveLength(4);
  });
});
