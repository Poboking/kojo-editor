/**
 * K2-EDITOR-SEMANTIC · `kojo2` 悬停 / 转定义（纯函数）行为闸。
 *
 * 覆盖面：
 * - 七类声明（`# 设 / 常量 / 表 / 池 / 模`、`@函`、`# 幕`）的声明处悬停：类型 / 初值 /
 *   参数 / 表体 / 来源行；
 * - 同文件引用（调度区赋值、条件行、`{…}` 插值）→ 同一个声明；
 * - 转定义：引用 → 声明行名字段；`! 池 / 模 / 函` 调用 → 声明；声明处 F12 落在自己；
 * - 位置门：台词正文 / `@原生` 体内不悬停、不跳；`{…}` 插值内例外。
 *
 * 期望值全部从 core AST / 同一份声明索引取，不在测试里复写声明名或行号。
 *
 * B3c 车道 2（2026-10-28）：本闸从 `packages/app/tests/kojo2-hover-definition.test.ts` **整枚搬进
 * 包**（悬停判据住在 `src/hover.ts`、转定义判据早就在 `src/definition.ts`，两条闸因此同处）。
 * 文件名按搬入的那枚叶子叫 `hover.test.ts`，内容仍是悬停 + 转定义两半；断言一条未减（27 条），
 * 只换了 import 出处与夹具落点（`tests/fixtures/kojo2/`，逐字节相同）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource, type KojoDecl } from '@kojo/kojo-core';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DocumentOf,
  type Kojo2Declaration,
  type Kojo2DeclarationKind,
  type Kojo2Query,
} from '@kojo/kojo-lang';
import { kojo2HoverAt } from '../src/hover';
import { kojo2DefinitionAt } from '../src/definition';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'kojo2', 'hover-definition.kojo2'),
  'utf8',
);
const DOCUMENT = kojo2DocumentOf(FIXTURE);

/** 夹具里某一种声明的唯一一条（夹具按"每种一条"设计；缺了就当场红）。 */
function declarationOf(kind: Kojo2DeclarationKind): Kojo2Declaration {
  const found = DOCUMENT.declarations.find((declaration) => declaration.kind === kind);
  if (found === undefined) throw new Error(`夹具缺少 ${kind} 声明`);
  return found;
}

/** 1 基行列 → 0 基源偏移。 */
function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split(/\r\n|\r|\n/);
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += (lines[i] ?? '').length + 1;
  return offset + column - 1;
}

/** 0 基源偏移 → 查询（1 基行列）。 */
function queryAtOffset(source: string, offset: number): Kojo2Query {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { source, line: before.split('\n').length, column: offset - lastBreak };
}

/** 从声明行的名字段取查询（声明处悬停 / F12）。 */
function queryAtDeclaration(declaration: Kojo2Declaration): Kojo2Query {
  return queryAtOffset(
    FIXTURE,
    offsetOf(FIXTURE, declaration.line, declaration.nameStart),
  );
}

/** 找 `needle`（从 `from` 起）并返回查询；`offsetInNeedle` 指定光标落在词内第几位。 */
function queryAtNeedle(needle: string, from = 0, offsetInNeedle = 0): Kojo2Query {
  const at = FIXTURE.indexOf(needle, from);
  if (at < 0) throw new Error(`夹具里找不到 ${needle}`);
  return queryAtOffset(FIXTURE, at + offsetInNeedle);
}

/** 找 `! <名字>` 调用位（光标落在名字首字）。 */
function queryAtTrigger(name: string): Kojo2Query {
  return queryAtNeedle(`! ${name}`, 0, 2);
}

/** 找 `{名字}` 插值位（返回花括号内第一位）。 */
function queryAtInterpolation(name: string): Kojo2Query {
  const at = FIXTURE.indexOf(`{${name}}`);
  if (at < 0) throw new Error(`夹具里找不到插值 {${name}}`);
  return queryAtOffset(FIXTURE, at + 1);
}

const DECLARATION_KINDS: readonly Kojo2DeclarationKind[] = [
  'scene',
  'variable',
  'constant',
  'table',
  'pool',
  'template',
  'function',
];

describe('声明处悬停：七类声明都给名字 / 种类 / 来源行', () => {
  it.each(DECLARATION_KINDS)('%s 声明处有悬停', (kind) => {
    const declaration = declarationOf(kind);
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    expect(hit, `${kind} 声明处没有悬停`).toBeDefined();
    expect(hit?.name).toBe(declaration.name);
    expect(hit?.kind).toBe(`${KOJO2_DECL_WORD_BY_KIND[kind]}声明`);
    expect(hit?.declaration.line).toBe(declaration.line);
    expect(hit?.startColumn).toBe(declaration.nameStart);
    expect(hit?.endColumn).toBe(declaration.nameEnd);
    expect(hit?.lines).toContain(`来源行：第 ${declaration.line} 行`);
  });

  it('声明词头上也认这条声明（悬停 / F12 都不必精确压在名字上）', () => {
    const declaration = declarationOf('variable');
    const query = queryAtOffset(FIXTURE, offsetOf(FIXTURE, declaration.line, 1));
    expect(kojo2HoverAt(query)?.name).toBe(declaration.name);
    expect(kojo2DefinitionAt(query)?.line).toBe(declaration.line);
  });

  it('变量悬停带类型 / 初值 / 存储期', () => {
    const declaration = declarationOf('variable');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    const text = (hit?.lines ?? []).join('\n');
    expect(declaration.valueType).toBeDefined();
    expect(text).toContain('类型：');
    if (declaration.storage !== undefined) expect(text).toContain('存储期：');
    if (declaration.initializer !== undefined) expect(text).toContain(declaration.initializer);
  });

  it('常量悬停带类型 / 值', () => {
    const declaration = declarationOf('constant');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    const text = (hit?.lines ?? []).join('\n');
    expect(text).toContain('类型：');
    expect(declaration.constantValue).toBeDefined();
    expect(text).toContain(declaration.constantValue!);
  });

  it('表悬停带 `依据` 表达式与表体行数', () => {
    const declaration = declarationOf('table');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    const text = (hit?.lines ?? []).join('\n');
    expect(declaration.subject).toBeDefined();
    expect(text).toContain(`依据：\`${declaration.subject!}\``);
    expect(text).toContain(`表体：${declaration.rowCount!} 行`);
  });

  it('池悬停带分支数', () => {
    const declaration = declarationOf('pool');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    expect((hit?.lines ?? []).join('\n')).toContain(`分支：${declaration.branchCount!} 条`);
  });

  it('模悬停带参数与插槽', () => {
    const declaration = declarationOf('template');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    const text = (hit?.lines ?? []).join('\n');
    expect(text).toContain('参数：');
    expect(text).toContain('插槽：');
  });

  it('函悬停带参数', () => {
    const declaration = declarationOf('function');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    const text = (hit?.lines ?? []).join('\n');
    expect(text).toContain('参数：');
  });

  it('幕悬停带场景标题', () => {
    const declaration = declarationOf('scene');
    const hit = kojo2HoverAt(queryAtDeclaration(declaration));
    expect((hit?.lines ?? []).join('\n')).toContain(`场景标题：\`${declaration.sceneTitle!}\``);
  });
});

describe('引用处悬停：同文件声明在代码面里可反查', () => {
  it('调度区赋值里的变量名 → 变量声明', () => {
    const declaration = declarationOf('variable');
    const from = offsetOf(FIXTURE, declaration.line, declaration.nameStart) + declaration.name.length;
    const query = queryAtNeedle(declaration.name, from);
    const hit = kojo2HoverAt(query);
    expect(hit?.name).toBe(declaration.name);
    expect(hit?.declaration.line).toBe(declaration.line);
    // 可见区间是引用词本身，不是声明名字段
    expect(hit?.startColumn).not.toBe(declaration.nameStart);
  });

  it('条件行里的表名 → 表声明', () => {
    const declaration = declarationOf('table');
    const hit = kojo2HoverAt(queryAtNeedle(`? ${declaration.name}`, 0, 2));
    expect(hit?.name).toBe(declaration.name);
    expect(hit?.declaration.line).toBe(declaration.line);
  });

  it('台词插值 `{表名}` 里 → 表声明（插值不是台词正文）', () => {
    const declaration = declarationOf('table');
    const hit = kojo2HoverAt(queryAtInterpolation(declaration.name));
    expect(hit?.name).toBe(declaration.name);
    expect(hit?.declaration.line).toBe(declaration.line);
  });
});

describe('转定义：引用 / 调用 → 声明名字段', () => {
  it('声明处 F12 落在自己', () => {
    for (const kind of DECLARATION_KINDS) {
      const declaration = declarationOf(kind);
      const target = kojo2DefinitionAt(queryAtDeclaration(declaration));
      expect(target, `${kind} 声明处没有定义`).toBeDefined();
      expect(target?.line).toBe(declaration.line);
      expect(target?.column).toBe(declaration.nameStart);
      expect(target?.endColumn).toBe(declaration.nameEnd);
      expect(target?.kind).toBe(KOJO2_DECL_WORD_BY_KIND[kind]);
    }
  });

  it('调度区变量引用 → 变量声明行', () => {
    const declaration = declarationOf('variable');
    const from = offsetOf(FIXTURE, declaration.line, declaration.nameStart) + declaration.name.length;
    const target = kojo2DefinitionAt(queryAtNeedle(declaration.name, from));
    expect(target).toEqual({
      name: declaration.name,
      kind: KOJO2_DECL_WORD_BY_KIND.variable,
      line: declaration.line,
      column: declaration.nameStart,
      endColumn: declaration.nameEnd,
    });
  });

  it('`! 池` 调用 → 池声明', () => {
    const declaration = declarationOf('pool');
    const target = kojo2DefinitionAt(queryAtTrigger(declaration.name));
    expect(target?.line).toBe(declaration.line);
    expect(target?.name).toBe(declaration.name);
  });

  it('`! 模` 调用 → 模声明', () => {
    const declaration = declarationOf('template');
    const target = kojo2DefinitionAt(queryAtTrigger(declaration.name));
    expect(target?.line).toBe(declaration.line);
    expect(target?.name).toBe(declaration.name);
  });

  it('`! 函` 调用 → 函声明', () => {
    const declaration = declarationOf('function');
    const target = kojo2DefinitionAt(queryAtTrigger(declaration.name));
    expect(target?.line).toBe(declaration.line);
    expect(target?.name).toBe(declaration.name);
  });

  it('找不到同名声明 → 不给落点（不猜）', () => {
    const query = queryAtNeedle('晨光透过鸟居');
    expect(kojo2DefinitionAt(query)).toBeUndefined();
  });
});

describe('位置门：台词正文 / `@原生` 体内不悬停、不跳', () => {
  it('台词正文里的名字（即使与声明同名）不悬停、不跳', () => {
    const declaration = declarationOf('table');
    const source = FIXTURE.replace('今天来得', `${declaration.name}来得`);
    // 台词里先有一个 `{心情}` 插值；这里要取插值**之后**的正文命中。
    const quote = source.indexOf('灵梦：「');
    const afterInterpolation = source.indexOf('}', quote) + 1;
    const at = source.indexOf(declaration.name, afterInterpolation);
    const query = queryAtOffset(source, at);
    expect(kojo2HoverAt(query)).toBeUndefined();
    expect(kojo2DefinitionAt(query)).toBeUndefined();
  });

  it('`@原生` 体内的名字（即使与声明同名）不悬停、不跳', () => {
    const declaration = declarationOf('table');
    const source = FIXTURE.replace('CALL HPH_PRINT', `CALL ${declaration.name}`);
    const at = source.indexOf(declaration.name, source.indexOf('@原生'));
    const query = queryAtOffset(source, at);
    expect(kojo2HoverAt(query)).toBeUndefined();
    expect(kojo2DefinitionAt(query)).toBeUndefined();
  });
});

describe('索引事实与 core AST 对齐（词序 / 名字区间）', () => {
  /** core AST 的声明种类 → 本索引的种类（不是第二份词表，只是两种键名的翻译）。 */
  function expectedKindOf(decl: KojoDecl): Kojo2DeclarationKind | undefined {
    switch (decl.kind) {
      case 'var':
        return 'variable';
      case 'const':
        return 'constant';
      case 'table':
        return 'table';
      case 'pool':
        return 'pool';
      case 'template':
        return 'template';
      case 'function':
        return 'function';
      default:
        return undefined;
    }
  }

  it('声明种类 / 名字 / 行号 / 名字段与 core 解析结果一致', () => {
    const parsed = parseSource(FIXTURE);
    for (const decl of parsed.decls) {
      const expected = expectedKindOf(decl);
      if (expected === undefined) continue; // 视 / 机 / 织：本批不索引
      if (!('name' in decl)) continue;
      const found = DOCUMENT.declarations.find(
        (declaration) =>
          declaration.line === decl.span.start.line && declaration.name === decl.name,
      );
      expect(found, `索引缺少 ${decl.name}`).toBeDefined();
      expect(found?.kind).toBe(expected);
    }
    for (const scene of parsed.scenes) {
      if (scene.title === null) continue;
      const found = DOCUMENT.declarations.find(
        (declaration) => declaration.line === scene.span.start.line && declaration.kind === 'scene',
      );
      expect(found?.name).toBe(scene.title);
    }
    for (const declaration of DOCUMENT.declarations) {
      const lineText = FIXTURE.split(/\r\n|\r|\n/)[declaration.line - 1] ?? '';
      expect(lineText.slice(declaration.nameStart - 1, declaration.nameEnd - 1)).toBe(
        declaration.name,
      );
    }
  });
});
