/**
 * K2-EXPAND-VIEW · 展开视图（模板 / 池 / 随机）的行为闸。
 *
 * 覆盖六块：
 * 1. **命中判据**：调用行（`! 名` / `@随机` 块头）、展开体源行（定义体行 / 随机候选行）、
 *    产物坐标（`side: 'generated'`）；列不敏感、行敏感；
 * 2. **双向事实**：产物行区间里每一行都带着同一个 `call-site` 锚点；`callSite` / `definition`
 *    与 core source map 的 `origins` 逐字一致（顺序 = `[call-site, 定义处]`，不反过来）；
 * 3. **嵌套展开**：池的分支里调模板 ⇒ 内层调用行命中内层模板、外层池的产物包络包含内层产物行、
 *    产物坐标取最内层；
 * 4. **不猜**：声明行 / 注释 / 普通文本 / 空行 / 插槽内容行 / 越界 / 非正整数 / 空产物 ⇒
 *    **显式 `none`**（同一个单例）；无源文 ⇒ 随机块 `none` 且不编名字；
 * 5. **Markdown 形状**：`**模板 名**` / 定义处 + 调用处行号 / 产物行区间 / ```` ```erb ```` 代码块，
 *    随机块用「块头」而不是「定义处」；
 * 6. **供方追加**：悬停的**同一枚**供方追加展开段（B3c 起供方＝插件 `kojo2-hover`，
 *    宿主 `registerForLanguageServices(..., 'hover')` 只挂一枚）、转定义的
 *    **两条** LocationLink（仅 `via === 'definition'`）、无编译缓存 / 读取端抛错 ⇒ 与旧行为一致且不抛。
 *
 * 期望值全部从 core 编译结果与 source map 现算（不抄行号、不抄产物行），夹具见
 * `tests/fixtures/kojo2/expand-view.kojo2`。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { KojoSpan } from '@kojo/kojo-core';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND, compileKojoSource } from '@kojo/kojo-core';
import type * as Monaco from '../src/monaco/entry';
import {
  KOJO2_NO_EXPAND_VIEW,
  expandViewAt,
  expandViewMarkdown,
  type Kojo2ExpandCompilation,
  type Kojo2ExpandView,
  type Kojo2ExpandViewResult,
} from '@kojo/kojo-lang';
import {
  buildKojo2SourceMapModel,
  splitKojo2GeneratedLines,
  type Kojo2SourceMapModel,
} from '@kojo/kojo-lang';
import { kojo2HoverAt, kojo2HoverMarkdown } from '@kojo/kojo-lang/hover';
import { toMonacoHover } from '../src/monaco/kojo2-providers';
import { toDefinitionLinks, type DefinitionLocation } from '../src/monaco/kojo-definition';
import { provideDefinition, provideHover } from '@kojo/plugin-kojo-lang';
import {
  kojo2ExpandCompilationFor,
  kojo2ExpandCompileSourceCount,
  registerKojo2ExpandCompileSource,
} from '../src/ui/kojo2-expand-compile';

/* ============================== 夹具 ============================== */

const FIXTURE = readFileSync(
  fileURLToPath(new URL('./fixtures/kojo2/expand-view.kojo2', import.meta.url)),
  'utf8',
);
const SOURCE_LINES = FIXTURE.split(/\r\n|\r|\n/);

const COMPILED = compileKojoSource({
  source: FIXTURE,
  filePath: 'expand-view.kojo2',
  adapter: FIXTURE_ADAPTER,
  backend: FIXTURE_BACKEND,
});
const MODEL: Kojo2SourceMapModel = buildKojo2SourceMapModel(COMPILED);
const GENERATED_LINES = splitKojo2GeneratedLines(COMPILED.erb);
const COMPILATION: Kojo2ExpandCompilation = {
  compiled: { erb: COMPILED.erb },
  sourceMapModel: MODEL,
};
const MODEL_PATH = 'D:/proj/chara/灵梦/expand-view.kojo2';

/** 夹具里第一条包含 `needle` 的源行（1 基）；找不到当场红（夹具漂了不许静默） */
function sourceLineOf(needle: string): number {
  const index = SOURCE_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`夹具里找不到源行：${needle}`);
  return index + 1;
}

/** 产物里第一条包含 `needle` 的行（1 基） */
function generatedLineOf(needle: string): number {
  const index = GENERATED_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`产物里找不到行：${needle}`);
  return index + 1;
}

const CALL_POOL = sourceLineOf('! 问候');
const CALL_TEMPLATE = sourceLineOf('! 外框("乙")');
const CALL_NESTED = sourceLineOf('! 内层("甲")');
const POOL_DEF_LINE = sourceLineOf('# 池 问候');
const POOL_BODY_LINE = sourceLineOf('> 池头');
const TEMPLATE_DEF_LINE = sourceLineOf('# 模 外框(名)');
const TEMPLATE_BODY_LINE = sourceLineOf('> 框头{名}');
const INNER_TEMPLATE_DEF_LINE = sourceLineOf('# 模 内层(名)');
const INNER_TEMPLATE_BODY_LINE = sourceLineOf('> 内层{名}');
const RANDOM_HEAD_LINE = sourceLineOf('@随机');
const RANDOM_CANDIDATE_LINE = sourceLineOf('> 候选一');
const SLOT_CONTENT_LINE = sourceLineOf('灵梦：「插槽行」');
const PLAIN_LINE = sourceLineOf('> 尾声');
const COMMENT_LINE = 1;
const BLANK_LINE = sourceLineOf('@随机') - 1; // `@随机` 之前的物理空行

/* ============================== 位置 / 断言小工具 ============================== */

function positionAt(line: number, column = 1): { line: number; column: number } {
  return { line, column };
}

function expandAt(
  line: number,
  column = 1,
  options: { side?: 'kojo' | 'generated'; source?: string } = { source: FIXTURE },
): Kojo2ExpandView {
  const view = expandViewAt(COMPILED, MODEL, positionAt(line, column), options);
  if (view.kind !== 'expand') throw new Error(`${line}:${column} 应当命中展开，实际 none`);
  return view;
}

function resultAt(
  line: number,
  column = 1,
  options: { side?: 'kojo' | 'generated'; source?: string } = { source: FIXTURE },
): Kojo2ExpandViewResult {
  return expandViewAt(COMPILED, MODEL, positionAt(line, column), options);
}

function sameSpan(a: KojoSpan, b: KojoSpan): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.column === b.start.column &&
    a.end.line === b.end.line &&
    a.end.column === b.end.column
  );
}

/** 产物行的 `call-site` 锚点（core 写死的顺序：`origins[0]`；这里按 kind 取，不按下标猜） */
function callSiteOriginOf(generatedLine: number): KojoSpan | null {
  const mapping = MODEL.lineAt(generatedLine);
  const call = mapping?.origins.find((origin) => origin.kind === 'call-site');
  return call?.span ?? null;
}

function definitionOriginOf(generatedLine: number): KojoSpan | null {
  const mapping = MODEL.lineAt(generatedLine);
  const definition = mapping?.origins.find((origin) => origin.kind !== 'call-site');
  return definition?.span ?? null;
}

/* ============================== 假 Monaco / 假 model ============================== */

function fakeMonaco(): typeof Monaco {
  const fake = {
    Uri: {
      file: (path: string) => ({
        scheme: 'file',
        path,
        fsPath: path,
        toString: () => `file:///${path.replace(/\\/g, '/')}`,
      }),
    },
  };
  return fake as unknown as typeof Monaco;
}

function fakeModel(text = FIXTURE): Monaco.editor.ITextModel {
  const rows = text.split(/\r\n|\r|\n/);
  const uri = {
    scheme: 'file',
    path: MODEL_PATH,
    fsPath: MODEL_PATH,
    toString: () => `file:///${MODEL_PATH}`,
  };
  return {
    getValue: () => text,
    getLineContent: (line: number) => rows[line - 1] ?? '',
    getLineCount: () => rows.length,
    // `toDefinitionLinks` 的落点判据要问行长（`getLineMaxColumn` = 行长度 + 1，Monaco 口径）
    getLineMaxColumn: (line: number) => (rows[line - 1] ?? '').length + 1,
    isDisposed: () => false,
    uri,
  } as unknown as Monaco.editor.ITextModel;
}

function monacoPosition(line: number, column = 1): Monaco.Position {
  return { lineNumber: line, column } as Monaco.Position;
}


/* ============================== 登记表清理 ============================== */

const unregisters: (() => void)[] = [];

function withCompileSource(source: (filePath: string) => Kojo2ExpandCompilation | null): void {
  unregisters.push(registerKojo2ExpandCompileSource(source));
}

afterEach(() => {
  while (unregisters.length > 0) unregisters.pop()?.();
  expect(kojo2ExpandCompileSourceCount()).toBe(0);
});

/* ============================== 1. 调用行命中 ============================== */

describe('调用行命中：模板 / 池 / 随机块头', () => {
  it('`! 池 名` 调用行命中池展开（种类 / 名字 / 命中方式）', () => {
    const view = expandAt(CALL_POOL, 1);
    expect(view.kindTag).toBe('pool');
    expect(view.name).toBe('问候');
    expect(view.via).toBe('call-site');
    expect(view.callSite.start.line).toBe(CALL_POOL);
    expect(view.definition.start.line).toBe(POOL_DEF_LINE);
  });

  it('池展开的产物区间覆盖两个分支与 IF/ENDIF 骨架', () => {
    const view = expandAt(CALL_POOL);
    expect(view.generated.lines).toContain(`IF {恋慕 < 100}`);
    expect(view.generated.lines).toContain('TELL: 池头 /WAIT');
    expect(view.generated.lines).toContain('TELL: 池二 /WAIT');
    expect(view.generated.lines).toContain('ENDIF');
    expect(view.generated.lines.length).toBe(view.generated.endLine - view.generated.startLine + 1);
  });

  it('产物区间里每一行都带着同一个 call-site 锚点（区间不是靠邻居行凑的）', () => {
    const view = expandAt(CALL_POOL);
    for (let line = view.generated.startLine; line <= view.generated.endLine; line++) {
      const origin = callSiteOriginOf(line);
      expect(origin, `产物第 ${line} 行缺 call-site 锚点`).not.toBeNull();
      expect(sameSpan(origin!, view.callSite)).toBe(true);
    }
  });

  it('`! 模 名` 调用行命中模板展开（含插槽内容行）', () => {
    const view = expandAt(CALL_TEMPLATE);
    expect(view.kindTag).toBe('template');
    expect(view.name).toBe('外框');
    expect(view.via).toBe('call-site');
    expect(view.definition.start.line).toBe(TEMPLATE_DEF_LINE);
    expect(view.generated.lines).toContain('TELL: 框头乙 /WAIT');
    expect(view.generated.lines).toContain('SAY 灵梦: 插槽行 /WAIT');
  });

  it('callSite / definition 与 source map 的 origins 逐字一致（顺序不反）', () => {
    const view = expandAt(CALL_TEMPLATE);
    const generatedLine = view.generated.startLine;
    expect(sameSpan(callSiteOriginOf(generatedLine)!, view.callSite)).toBe(true);
    expect(sameSpan(definitionOriginOf(generatedLine)!, view.definition)).toBe(true);
    const mapping = MODEL.lineAt(generatedLine)!;
    expect(mapping.origins[0]!.kind).toBe('call-site');
    expect(sameSpan(mapping.origins[0]!.span, view.callSite)).toBe(true);
  });

  it('调用行的命中与列无关（行首 / 行中 / 行尾同一答案）', () => {
    const head = expandAt(CALL_POOL, 1);
    const middle = expandAt(CALL_POOL, 3);
    const tail = expandAt(CALL_POOL, SOURCE_LINES[CALL_POOL - 1]!.length + 1);
    for (const view of [middle, tail]) {
      expect(view.kindTag).toBe(head.kindTag);
      expect(sameSpan(view.callSite, head.callSite)).toBe(true);
      expect(view.generated.startLine).toBe(head.generated.startLine);
      expect(view.generated.endLine).toBe(head.generated.endLine);
    }
  });

  it('`@随机` 块头行命中随机展开（无名字、命中方式 = 调用点）', () => {
    const view = expandAt(RANDOM_HEAD_LINE, 1);
    expect(view.kindTag).toBe('random');
    expect(view.name).toBeNull();
    expect(view.via).toBe('call-site');
    expect(view.callSite.start.line).toBe(RANDOM_HEAD_LINE);
    expect(view.definition.start.line).toBe(RANDOM_HEAD_LINE);
  });

  it('随机块的产物区间从 RANDOM 头一路到 RANDOM.END', () => {
    const view = expandAt(RANDOM_HEAD_LINE);
    expect(view.generated.lines[0]).toContain('RANDOM');
    expect(view.generated.lines[view.generated.lines.length - 1]).toContain('RANDOM.END');
    expect(view.generated.lines).toContain('TELL: 候选一 /WAIT');
    expect(view.generated.lines).toContain('TELL: 候选二 /WAIT');
  });

  it('随机块头行的 callSite 列区间取自词法（`@随机` 三个字，不含行尾空白）', () => {
    const view = expandAt(RANDOM_HEAD_LINE);
    expect(view.callSite.end.column).toBe('@随机'.length + 1);
  });
});

/* ============================== 2. 展开体源行（definition） ============================== */

describe('展开体源行命中：这一行是被谁展开出来的', () => {
  it('池体行命中池展开，调用处指向 `! 问候` 行', () => {
    const view = expandAt(POOL_BODY_LINE, 1);
    expect(view.kindTag).toBe('pool');
    expect(view.via).toBe('definition');
    expect(view.callSite.start.line).toBe(CALL_POOL);
  });

  it('模板体行命中模板展开，调用处指向 `! 外框` 行', () => {
    const view = expandAt(TEMPLATE_BODY_LINE);
    expect(view.kindTag).toBe('template');
    expect(view.name).toBe('外框');
    expect(view.via).toBe('definition');
    expect(view.callSite.start.line).toBe(CALL_TEMPLATE);
  });

  it('定义 span 覆盖命中的展开体行（不是随便一段声明）', () => {
    for (const [line, tag] of [
      [POOL_BODY_LINE, 'pool'],
      [TEMPLATE_BODY_LINE, 'template'],
    ] as const) {
      const view = expandAt(line);
      expect(view.kindTag).toBe(tag);
      expect(view.definition.start.line).toBeLessThanOrEqual(line);
      expect(view.definition.end.line).toBeGreaterThanOrEqual(line);
    }
  });

  it('随机候选行命中随机展开（命中方式 = 展开体源行）', () => {
    const view = expandAt(RANDOM_CANDIDATE_LINE, 1);
    expect(view.kindTag).toBe('random');
    expect(view.via).toBe('definition');
    expect(view.callSite.start.line).toBe(RANDOM_HEAD_LINE);
    expect(view.definition.start.line).toBe(RANDOM_HEAD_LINE);
    expect(view.definition.end.line).toBeGreaterThanOrEqual(RANDOM_CANDIDATE_LINE);
  });
});

/* ============================== 3. 嵌套展开 ============================== */

describe('嵌套展开：池的分支里再调模板', () => {
  it('内层调用行命中内层模板，而不是外层池', () => {
    const view = expandAt(CALL_NESTED);
    expect(view.kindTag).toBe('template');
    expect(view.name).toBe('内层');
    expect(view.callSite.start.line).toBe(CALL_NESTED);
    expect(view.definition.start.line).toBe(INNER_TEMPLATE_DEF_LINE);
    expect(view.generated.lines).toEqual(['TELL: 内层甲 /WAIT']);
  });

  it('外层的产物包络包含内层产物行（一次展开的完整产物）', () => {
    const outer = expandAt(CALL_POOL);
    const inner = expandAt(CALL_NESTED);
    expect(inner.generated.startLine).toBeGreaterThanOrEqual(outer.generated.startLine);
    expect(inner.generated.endLine).toBeLessThanOrEqual(outer.generated.endLine);
    expect(outer.generated.lines).toContain(inner.generated.lines[0]!);
  });

  it('内层模板体行命中内层模板（最贴近光标的定义）', () => {
    const view = expandAt(INNER_TEMPLATE_BODY_LINE);
    expect(view.kindTag).toBe('template');
    expect(view.name).toBe('内层');
    expect(view.callSite.start.line).toBe(CALL_NESTED);
  });

  it('嵌套产物行在产物坐标下取最内层锚点', () => {
    const inner = expandAt(CALL_NESTED);
    const view = expandAt(inner.generated.startLine, 1, { side: 'generated', source: FIXTURE });
    expect(view.via).toBe('generated');
    expect(view.kindTag).toBe('template');
    expect(view.name).toBe('内层');
    expect(view.callSite.start.line).toBe(CALL_NESTED);
  });
});

/* ============================== 4. 不猜：显式 none ============================== */

describe('不猜：不可映射 / 越界 / 空产物一律显式 none', () => {
  it('池声明行没有展开（声明不是调用点，也不是展开体）', () => {
    expect(resultAt(POOL_DEF_LINE, 1)).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('注释行没有展开', () => {
    expect(resultAt(COMMENT_LINE, 3)).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('普通文本行没有展开', () => {
    expect(resultAt(PLAIN_LINE, 1)).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('物理空行没有展开', () => {
    expect(resultAt(BLANK_LINE, 1)).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('模板插槽内容行没有展开（它属于调用处内容，不是模板定义体的一行）', () => {
    expect(resultAt(SLOT_CONTENT_LINE, 1)).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('越界行号没有展开', () => {
    expect(resultAt(SOURCE_LINES.length + 50, 1)).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('非正整数位置没有展开（行 0 / 列 0 / 小数）', () => {
    expect(expandViewAt(COMPILED, MODEL, { line: 0, column: 1 }, { source: FIXTURE })).toBe(
      KOJO2_NO_EXPAND_VIEW,
    );
    expect(expandViewAt(COMPILED, MODEL, { line: 1, column: 0 }, { source: FIXTURE })).toBe(
      KOJO2_NO_EXPAND_VIEW,
    );
    expect(expandViewAt(COMPILED, MODEL, { line: 1.5, column: 1 }, { source: FIXTURE })).toBe(
      KOJO2_NO_EXPAND_VIEW,
    );
  });

  it('空产物没有展开', () => {
    const empty = compileKojoSource({
      source: '',
      filePath: 'empty.kojo2',
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });
    const emptyModel = buildKojo2SourceMapModel(empty);
    expect(expandViewAt(empty, emptyModel, { line: 1, column: 1 }, { source: '' })).toBe(
      KOJO2_NO_EXPAND_VIEW,
    );
  });

  it('没有源文时不认随机块（跨行 span 不是"随机"的证据）', () => {
    expect(resultAt(RANDOM_HEAD_LINE, 1, {})).toBe(KOJO2_NO_EXPAND_VIEW);
    expect(resultAt(RANDOM_CANDIDATE_LINE, 1, {})).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('没有源文时不编名字（模板 / 池照常命中，name 为 null）', () => {
    const view = expandAt(CALL_POOL, 1, {});
    expect(view.name).toBeNull();
    expect(view.kindTag).toBe('pool');
    expect(view.via).toBe('call-site');
  });

  it('源文与产物不同源（源码被改短）时按"读到的词法"判，不当场猜', () => {
    const shorter = FIXTURE.split('\n').slice(0, 5).join('\n');
    expect(resultAt(RANDOM_HEAD_LINE, 1, { source: shorter })).toBe(KOJO2_NO_EXPAND_VIEW);
  });
});

/* ============================== 5. 产物坐标 ============================== */

describe('产物坐标（side: generated）：光标直接在产物行上', () => {
  it('池产物行命中池展开，调用处 / 定义处齐备', () => {
    const view = expandAt(generatedLineOf('TELL: 池头'), 1, { side: 'generated', source: FIXTURE });
    expect(view.kindTag).toBe('pool');
    expect(view.via).toBe('generated');
    expect(view.callSite.start.line).toBe(CALL_POOL);
    expect(view.definition.start.line).toBe(POOL_DEF_LINE);
  });

  it('模板产物行命中模板展开', () => {
    const view = expandAt(generatedLineOf('TELL: 框头乙'), 1, {
      side: 'generated',
      source: FIXTURE,
    });
    expect(view.kindTag).toBe('template');
    expect(view.name).toBe('外框');
    expect(view.callSite.start.line).toBe(CALL_TEMPLATE);
  });

  it('随机产物行命中随机展开', () => {
    const view = expandAt(generatedLineOf('TELL: 候选二'), 1, {
      side: 'generated',
      source: FIXTURE,
    });
    expect(view.kindTag).toBe('random');
    expect(view.callSite.start.line).toBe(RANDOM_HEAD_LINE);
  });

  it('纯生成 / 未映射的产物行没有展开', () => {
    expect(
      expandViewAt(COMPILED, MODEL, positionAt(1, 1), { side: 'generated', source: FIXTURE }),
    ).toBe(KOJO2_NO_EXPAND_VIEW);
  });

  it('产物行越界没有展开', () => {
    expect(
      expandViewAt(COMPILED, MODEL, positionAt(GENERATED_LINES.length + 10, 1), {
        side: 'generated',
        source: FIXTURE,
      }),
    ).toBe(KOJO2_NO_EXPAND_VIEW);
  });
});

/* ============================== 6. Markdown ============================== */

describe('Markdown 形状', () => {
  it('模板：标题 / 定义处 + 调用处 / 产物行区间 / erb 代码块', () => {
    const view = expandAt(CALL_TEMPLATE);
    const markdown = expandViewMarkdown(view).value;
    expect(markdown.split('\n')[0]).toBe('**模板 外框**');
    expect(markdown).toContain(
      `定义处：第 ${view.definition.start.line} 行 · 调用处：第 ${view.callSite.start.line} 行`,
    );
    expect(markdown).toContain(
      `展开产物：第 ${view.generated.startLine}–${view.generated.endLine} 行（${view.generated.lines.length} 行）`,
    );
    expect(markdown).toContain('```erb');
    expect(markdown.endsWith('```')).toBe(true);
  });

  it('代码块正文 = 产物行逐字（不多一行、不少一行）', () => {
    const view = expandAt(CALL_TEMPLATE);
    const markdown = expandViewMarkdown(view).value;
    const blockStart = markdown.indexOf('```erb\n') + '```erb\n'.length;
    const blockEnd = markdown.lastIndexOf('\n```');
    expect(markdown.slice(blockStart, blockEnd)).toBe(view.generated.lines.join('\n'));
  });

  it('池：标题带池名，产物行区间是闭区间', () => {
    const view = expandAt(CALL_POOL);
    const markdown = expandViewMarkdown(view).value;
    expect(markdown.split('\n')[0]).toBe('**池 问候**');
    const firstLine = view.generated.lines.length === 1;
    expect(markdown).toContain(
      firstLine
        ? `第 ${view.generated.startLine} 行`
        : `第 ${view.generated.startLine}–${view.generated.endLine} 行`,
    );
  });

  it('随机：用「块头」而不是「定义处」，且没有名字', () => {
    const view = expandAt(RANDOM_HEAD_LINE);
    const markdown = expandViewMarkdown(view).value;
    expect(markdown.split('\n')[0]).toBe('**随机块**');
    expect(markdown).toContain(`块头：第 ${RANDOM_HEAD_LINE} 行`);
    expect(markdown).not.toContain('定义处');
  });

  it('没有名字时只说种类（不编名字）', () => {
    const view = expandAt(CALL_POOL, 1, {});
    const markdown = expandViewMarkdown(view).value;
    expect(markdown.split('\n')[0]).toBe('**池**');
  });

  it('Markdown 里不放跳转指令（跳转由宿主菜单 / definition 承担）', () => {
    for (const view of [expandAt(CALL_POOL), expandAt(CALL_TEMPLATE), expandAt(RANDOM_HEAD_LINE)]) {
      const markdown = expandViewMarkdown(view).value;
      expect(markdown).not.toContain('跳转');
      expect(markdown).not.toContain('点击');
      expect(markdown).not.toContain('command:');
    }
  });
});

/* ============================== 7. definition 两条落点（插件给 + 宿主翻） ==============================
 *
 * B3b（2026-10-24）起这条腿的**判据归插件** `@kojo/plugin-kojo-lang`（它经
 * `ui.editor.languageService` 槽的 `kind: 'definition'` 应答），宿主只做翻译
 * （`toDefinitionLinks`）。所以本节测的是**整条链**：插件 `provideDefinition` 给契约落点
 * → 宿主翻成 `LocationLink`。
 *
 * 判据与切槽之前**逐字相同**（两条 link、指向同一文件、区间与 core source map 一致），
 * 变的只有取数路径。为什么值得这样测而不是各测一半：展开落点是"插件能不能真的接管
 * 转定义"的唯一证据——插件若拿不到编译成品（B3a 之前它确实拿不到），这一节会当场红。
 *
 * 唯一的**有意差别**：`targetSelectionRange` 不再等于 `range`。跨行段落点若把整段当选区，
 * 编辑器一进去就选中几百行；现在 `range` = 整段（Peek 里框住），`targetSelectionRange`
 * = 起点行那一行（光标落在声明头）。
 */

describe('转定义：展开体源行 → 调用处 / 定义处两条落点（插件给 + 宿主翻）', () => {
  const findModel = (path: string): Monaco.editor.ITextModel | undefined =>
    path === MODEL_PATH ? fakeModel() : undefined;

  /** 按宿主的问法投递（`languageId` 来自 model，这里显式给 `kojo2`） */
  function locationsAt(line: number, column = 1): DefinitionLocation[] {
    const result = provideDefinition({
      kind: 'definition',
      path: MODEL_PATH,
      text: FIXTURE,
      project: null,
      lineCount: SOURCE_LINES.length,
      languageId: 'kojo2',
      version: 1,
      line,
      column,
    } as never);
    return result?.locations ?? [];
  }

  it('展开体源行给出两条 link（调用处在前、定义处在后），且指向同一文件', () => {
    withCompileSource(() => COMPILATION);
    const links = toDefinitionLinks(locationsAt(POOL_BODY_LINE), findModel);
    expect(links).toHaveLength(2);
    const view = expandAt(POOL_BODY_LINE);
    for (const link of links) expect(link.uri.fsPath).toBe(MODEL_PATH);
    expect(links[0]!.range).toEqual({
      startLineNumber: view.callSite.start.line,
      startColumn: view.callSite.start.column,
      endLineNumber: view.callSite.end.line,
      endColumn: view.callSite.end.column,
    });
    expect(links[1]!.range).toEqual({
      startLineNumber: view.definition.start.line,
      startColumn: view.definition.start.column,
      endLineNumber: view.definition.end.line,
      endColumn: view.definition.end.column,
    });
  });

  it('跨行段落点：`range` 框住整段，`targetSelectionRange` 只落在起点行（别把几百行当选区）', () => {
    withCompileSource(() => COMPILATION);
    const links = toDefinitionLinks(locationsAt(POOL_BODY_LINE), findModel);
    const whole = links[1]!;
    expect(whole.range.endLineNumber).toBeGreaterThan(whole.range.startLineNumber);
    expect(whole.targetSelectionRange!.startLineNumber).toBe(whole.range.startLineNumber);
    expect(whole.targetSelectionRange!.endLineNumber).toBe(whole.range.startLineNumber);
  });

  it('随机候选行也给两条 link（跳到块头）', () => {
    withCompileSource(() => COMPILATION);
    const links = toDefinitionLinks(locationsAt(RANDOM_CANDIDATE_LINE), findModel);
    expect(links).toHaveLength(2);
    expect(links[0]!.range.startLineNumber).toBe(RANDOM_HEAD_LINE);
  });

  it('调用行不追加展开 link（那里 F12 该跳声明）', () => {
    withCompileSource(() => COMPILATION);
    const links = toDefinitionLinks(locationsAt(CALL_POOL, 3), findModel);
    expect(links).toHaveLength(1);
    expect(links[0]!.range.startLineNumber).toBe(POOL_DEF_LINE);
  });

  it('没有编译成品时不追加、不抛（与切槽之前一致）', () => {
    let links: Monaco.languages.LocationLink[] = [];
    expect(() => {
      links = toDefinitionLinks(locationsAt(POOL_BODY_LINE), findModel);
    }).not.toThrow();
    expect(links).toHaveLength(0);
  });

  it('成品读取端抛错时只是没有展开段，原声明落点照旧', () => {
    withCompileSource(() => {
      throw new Error('桩：缓存读取端炸了');
    });
    let links: Monaco.languages.LocationLink[] = [];
    expect(() => {
      links = toDefinitionLinks(locationsAt(CALL_POOL, 3), findModel);
    }).not.toThrow();
    expect(links).toHaveLength(1);
    expect(links[0]!.range.startLineNumber).toBe(POOL_DEF_LINE);
  });
});

/* ============================== 8. 悬停追加展开段 ==============================
 *
 * B3c（2026-10-28）起这条腿的**供方是插件**（`@kojo/plugin-kojo-lang` 的 `kojo2-hover`
 * 贡献，经 `ui.editor.languageService` 槽应答），宿主 `kojo2-providers.ts` 只剩协议翻译。
 * 字段形状随之变化：旧宿主交 Monaco `Hover.contents` 的**两个 part**，契约只有一枚
 * `contents` 字符串 ⇒ 两段以 `'\n\n'` 相连（**正文逐字相同**，这是本批唯一允许的呈现差量）。
 * 判据仍是"展开段的悬停只走一条 provider、只措辞一次"——落点从宿主搬到了插件/包。
 */

/** 插件供方的悬停请求（与宿主 provider 现构的形状一致；`path` 决定查哪份编译成品） */
function hoverRequestAt(line: number, column = 1) {
  return {
    kind: 'hover' as const,
    path: MODEL_PATH,
    text: FIXTURE,
    line,
    column,
    project: null,
    languageId: 'kojo2',
  };
}

/** 声明段的正文（包内措辞）——用来逐字断言两段的拼接，而不是抄一份文字 */
function declarationMarkdownAt(line: number, column = 1): string | undefined {
  const hover = kojo2HoverAt({ source: FIXTURE, line, column }, { adapter: null });
  return hover === undefined ? undefined : kojo2HoverMarkdown(hover);
}

describe('悬停：同一枚供方追加展开段（宿主只翻译）', () => {
  it('调用行给两段：声明正文 + 展开段，`\\n\\n` 相连且顺序固定（声明在前）', () => {
    withCompileSource(() => COMPILATION);
    const hover = provideHover(hoverRequestAt(CALL_POOL, 3));
    expect(hover).toBeDefined();
    expect(hover!.format).toBe('markdown');
    const declaration = declarationMarkdownAt(CALL_POOL, 3);
    expect(declaration).toBeDefined();
    expect(hover!.contents).toBe(
      `${declaration!}\n\n${expandViewMarkdown(expandAt(CALL_POOL, 3)).value}`,
    );
  });

  it('悬停区间仍是声明的名字段（展开段不改旧区间），宿主翻成 IRange 逐格相同', () => {
    withCompileSource(() => COMPILATION);
    const hover = provideHover(hoverRequestAt(CALL_POOL, 3));
    expect(hover!.range).toEqual({
      line: CALL_POOL,
      startColumn: 3,
      endColumn: 3 + '问候'.length,
    });
    expect(toMonacoHover(hover)!.range).toEqual({
      startLineNumber: CALL_POOL,
      startColumn: 3,
      endLineNumber: CALL_POOL,
      endColumn: 3 + '问候'.length,
    });
  });

  it('没有声明事实的位置（`@随机` 块头）也有展开段：区间取调用处 span', () => {
    withCompileSource(() => COMPILATION);
    const hover = provideHover(hoverRequestAt(RANDOM_HEAD_LINE, 1));
    expect(hover).toBeDefined();
    expect(hover!.contents).toBe(expandViewMarkdown(expandAt(RANDOM_HEAD_LINE)).value);
    expect(hover!.format).toBe('markdown');
    expect(hover!.range).toEqual({
      line: RANDOM_HEAD_LINE,
      startColumn: 1,
      endColumn: '@随机'.length + 1,
    });
  });

  it('展开体源行不追加展开段（那是 definition 的活）', () => {
    withCompileSource(() => COMPILATION);
    // `> 池头` 是旁白正文：声明悬停本来就没有，展开段也不追加 ⇒ 整条应答缺席
    expect(provideHover(hoverRequestAt(POOL_BODY_LINE, 1))).toBeUndefined();
  });

  it('没有编译缓存时悬停与旧行为一致（只有声明正文那一段）', () => {
    const hover = provideHover(hoverRequestAt(CALL_POOL, 3));
    expect(hover).toBeDefined();
    expect(hover!.contents).toBe(declarationMarkdownAt(CALL_POOL, 3));
  });

  it('缓存读取端抛错时悬停不抛、只少展开段', () => {
    withCompileSource(() => {
      throw new Error('桩：缓存读取端炸了');
    });
    let hover: ReturnType<typeof provideHover>;
    expect(() => {
      hover = provideHover(hoverRequestAt(CALL_POOL, 3));
    }).not.toThrow();
    expect(hover!.contents).toBe(declarationMarkdownAt(CALL_POOL, 3));
  });

  it('渲染失败的编译成品（产物不是字符串）只是没有展开段', () => {
    withCompileSource(
      () =>
        ({ compiled: { erb: 42 }, sourceMapModel: MODEL }) as unknown as Kojo2ExpandCompilation,
    );
    const hover = provideHover(hoverRequestAt(CALL_POOL, 3));
    expect(hover!.contents).toBe(declarationMarkdownAt(CALL_POOL, 3));
  });

  it('宿主翻译：两段合成一条 contents（一个 part 两段），正文逐字不变', () => {
    withCompileSource(() => COMPILATION);
    const monacoHover = toMonacoHover(provideHover(hoverRequestAt(CALL_POOL, 3)));
    expect(monacoHover!.contents).toHaveLength(1);
    expect((monacoHover!.contents[0] as { value: string }).value).toContain('**问候**');
    expect((monacoHover!.contents[0] as { value: string }).value).toContain('**池 问候**');
  });
});

/* ============================== 9. 编译成品登记表 ============================== */

describe('编译成品登记表：面板登记、provider 按路径问', () => {
  it('登记后按路径取到同一份成品', () => {
    withCompileSource(() => COMPILATION);
    expect(kojo2ExpandCompilationFor(MODEL_PATH)).toBe(COMPILATION);
  });

  it('注销后取不到（卸载不留登记）', () => {
    const unregister = registerKojo2ExpandCompileSource(() => COMPILATION);
    expect(kojo2ExpandCompilationFor(MODEL_PATH)).toBe(COMPILATION);
    unregister();
    expect(kojo2ExpandCompilationFor(MODEL_PATH)).toBeNull();
  });

  it('后登记的先问（面板重挂时新实例优先）', () => {
    const older: Kojo2ExpandCompilation = { ...COMPILATION, compiled: { erb: 'OLD' } };
    const newer: Kojo2ExpandCompilation = { ...COMPILATION, compiled: { erb: 'NEW' } };
    withCompileSource(() => older);
    withCompileSource(() => newer);
    expect(kojo2ExpandCompilationFor(MODEL_PATH)).toBe(newer);
  });

  it('不认识这一路径的登记表回 null（多面板各管各的）', () => {
    withCompileSource(() => COMPILATION);
    expect(kojo2ExpandCompilationFor('D:/proj/other.kojo2')).toBe(COMPILATION);
    expect(kojo2ExpandCompilationFor('')).toBeNull();
  });

  it('读取器抛错 ⇒ 跳过它，不抛进 provider', () => {
    withCompileSource(() => {
      throw new Error('桩：面板正在重建');
    });
    withCompileSource(() => COMPILATION);
    expect(kojo2ExpandCompilationFor(MODEL_PATH)).toBe(COMPILATION);
  });

  it('形状不对（没有产物字符串 / 没有 source map 模型）不算数', () => {
    withCompileSource(
      () =>
        ({ compiled: { erb: 7 }, sourceMapModel: MODEL }) as unknown as Kojo2ExpandCompilation,
    );
    expect(kojo2ExpandCompilationFor(MODEL_PATH)).toBeNull();
  });

  it('供方缺省经登记表取成品（不注入 getCompile 也能出展开段）', () => {
    withCompileSource(() => COMPILATION);
    const hover = provideHover(hoverRequestAt(CALL_POOL, 3));
    expect(hover!.contents).toBe(
      `${declarationMarkdownAt(CALL_POOL, 3)!}\n\n${expandViewMarkdown(expandAt(CALL_POOL, 3)).value}`,
    );
    expect(hover!.contents).toContain('**池 问候**');
    expect(hover!.contents).toContain('```erb');
  });
});

/* ============================== 10. 纯函数纪律 ============================== */

describe('纯函数纪律：同一查询永远同一答案', () => {
  it('连续两次查询结果逐字段相同（无隐藏状态）', () => {
    const first = expandAt(CALL_POOL, 2);
    const second = expandAt(CALL_POOL, 2);
    expect(second).toEqual(first);
  });

  it('不修改传入的编译结果与模型（产物行数组来自同一次切分）', () => {
    const before = COMPILED.erb;
    expandAt(CALL_TEMPLATE);
    expect(COMPILED.erb).toBe(before);
    expect(GENERATED_LINES.length).toBe(splitKojo2GeneratedLines(COMPILED.erb).length);
  });
});

/* ============================== 11. 注册纪律（源码断言） ==============================
 *
 * 判据原文**一字未改**：展开段的悬停只走**一条** provider、措辞只写在**一处**。
 * B3c 把落点从"宿主直挂"改成"共享收口 + 插件供方"，所以取证也跟着换位置——**不是放宽**：
 * 旧形态是"宿主里 `registerHoverProvider` 恰好 1 枚、`expandViewMarkdown` 恰好 1 处"，
 * 新形态是"宿主里仍然恰好 1 枚（且经 `registerForLanguageServices(..., 'hover')` 挂上）、
 * 宿主里 `expandViewMarkdown` **归零**，而插件供方里恰好 1 处"。
 */

describe('注册纪律：展开段不新造第二个 provider，措辞仍只有一处', () => {
  const providerSource = readFileSync(
    fileURLToPath(new URL('../src/monaco/kojo2-providers.ts', import.meta.url)),
    'utf8',
  );
  const pluginHoverSource = readFileSync(
    fileURLToPath(new URL('../../plugins/kojo-lang/src/hover.ts', import.meta.url)),
    'utf8',
  );

  it('悬停只有一枚注册入口，且经共享收口点名 `hover`；转定义**零枚**', () => {
    expect(providerSource.match(/registerHoverProvider\(/g) ?? []).toHaveLength(1);
    // 收口调用只数**调用形状**（`registerForLanguageServices(\n  monaco,`）：头注提及不算。
    // completion + hover 各一次（多出来的第二次收口 = 第二条悬停路）
    expect(providerSource.match(/registerForLanguageServices\(\s+monaco,/g) ?? []).toHaveLength(2);
    expect(providerSource).toMatch(/registerHoverProvider\(id, hoverProvider\)[\s\S]{0,120}'hover',/);
    // 这条断言在 B3b 之前是"恰好 1"，现在是"恰好 0"——**收紧，不是放宽**：
    // 转定义由 descriptor 的 `slotServices: ['definition']` 经共享收口挂上（供方是插件），
    // 本文件再注册一枚就是两个 DefinitionProvider 并存，Monaco 的合并顺序不可控，
    // `F12` 到底跳哪一条从此不可断言。这一格归零正是"这条腿真的交出去了"的判据。
    expect(providerSource.match(/registerDefinitionProvider\(/g) ?? []).toHaveLength(0);
  });

  it('展开 Markdown 只在插件供方一处进悬停：宿主零措辞、零展开调用', () => {
    expect(providerSource.match(/expandViewMarkdown\(/g) ?? []).toHaveLength(0);
    expect(providerSource.match(/expandViewAt\(/g) ?? []).toHaveLength(0);
    expect(pluginHoverSource.match(/expandViewMarkdown\(/g) ?? []).toHaveLength(1);
    expect(pluginHoverSource.match(/expandViewAt\(/g) ?? []).toHaveLength(1);
  });
});
