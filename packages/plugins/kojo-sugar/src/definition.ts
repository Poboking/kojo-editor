import type {
  EditorSymbolLocation,
  ErbIndex,
  SugarSourceMapEntry,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { symbolTokenAt } from '@kojo/plugin-api';

/**
 * `.kojo` 转到定义（2026-10-15 语言服务批）。
 *
 * ## 语义（一句话，其余都从它推）
 * **`.kojo` 里的函数名 / `CALL` 指向的是编译产物 ERB 里的函数**——所以反查有两条腿：
 * 1. **本文件产出的函数**：把当前 `.kojo` 转译（纯函数，不读盘）拿到产物，找
 *    `@<名字>` 那一行，再用 `sourceOf` 把**产物行折回 `.kojo` 行**——作者要的是源码
 *    那一行，不是一份可能还不存在的生成物。函数头是**纯生成行**（`.kojo` 里没有
 *    `@`，头是编译器造的），`sourceOf` 对它返回 null；此时按"生成行取最近的下一条
 *    有源行"折回——它一定落在该函数体内，是行级可用的位置，**绝不返回别的函数**。
 * 2. **别处的函数**（库函数 / 另一个口上的产物）：复用**项目 ERB 索引** `byName`
 *    —— `.kojo` 里的名字就是 ERB 函数名，没有第二张表可查；索引里没有 = 没有定义
 *    （**不猜**）。
 *
 * 本模块是**纯函数**：转译与索引由装配层注入，自己不读盘、不写盘、不发事件。
 */
export interface KojoDefinitionDeps {
  /** 转译当前 `.kojo` 文本（本包自己的 `sugar.transpile`，纯函数） */
  transpile(source: string): SugarTranspileResult;
  /** 产物行 → 源位置（本包自己的 `sugar.transpile`.`sourceOf`；纯函数） */
  sourceOf(result: SugarTranspileResult, generatedLine: number): { line: number; column: number } | null;
  /** 当前项目 ERB 索引（软取；未打开项目 / 索引未建 → null） */
  index(): ErbIndex | null;
}

/** `.kojo` 产物里的函数定义头：`@NAME` 或 `@NAME(...)`（`参数:` 声明段可有可无） */
export function findGeneratedHeaderLine(erb: string, name: string): number | null {
  const wanted = name.toUpperCase();
  const lines = erb.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@([A-Za-z0-9_]+)/.exec(lines[i]!);
    if (m && m[1]!.toUpperCase() === wanted) return i + 1;
  }
  return null;
}

/**
 * 产物行 → 源行：命中精确映射则用之；**纯生成行**（`@` 头等）向下取最近一条有源行，
 * 但**不得越过下一个函数定义头**（越过就说明这个名字的本体已结束，宁可不给答案）。
 */
function sourceLineNear(result: SugarTranspileResult, generatedLine: number): number | null {
  const exact = result.sourceMap.find((e) => e.generatedLine === generatedLine);
  if (exact?.sourceLine != null) return exact.sourceLine;
  const lines = result.erb.split('\n');
  const ordered: SugarSourceMapEntry[] = [...result.sourceMap].sort((a, b) => a.generatedLine - b.generatedLine);
  for (const e of ordered) {
    if (e.generatedLine <= generatedLine) continue;
    if (/^@/.test(lines[e.generatedLine - 1] ?? '')) return null; // 已到下一个函数：放弃
    if (e.sourceLine !== null) return e.sourceLine;
  }
  return null;
}

/**
 * 解析一次 `.kojo` 定义请求 → 目标位置列表（空数组 = 此处没有定义）。
 *
 * `request.line` / `request.column` 为 1 基；越界行 → 空数组（**不夹取**，
 * 与 `erb-parser/symbols.ts` 同一口径：过期行号不许被伪装成命中）。
 */
export function resolveKojoDefinition(
  request: { path: string; text: string; line: number; column: number },
  deps: KojoDefinitionDeps,
): EditorSymbolLocation[] {
  const lineText = lineTextOf(request.text, request.line);
  if (lineText === undefined) return [];
  const token = symbolTokenAt(lineText, request.column);
  if (!token) return [];
  const name = token.text.toUpperCase();

  const self = selfDefinitionLocation(request.path, request.text, name, deps);
  if (self) return [self];

  const index = deps.index();
  if (!index) return [];
  const refs = index.byName.get(name) ?? [];
  return refs.map((ref) => ({ filePath: ref.filePath, line: ref.startLine }));
}

/**
 * 名字由**本文件**产出 → 折回 `.kojo` 行；不由本文件产出 → undefined。
 *
 * 产物带 `error` 诊断时**整条路放弃**：半成品的源映射不可信，折回去等于给一个
 * 错位置（作者会照着它改错地方），此时让索引那条腿说话更安全。
 */
function selfDefinitionLocation(
  path: string,
  text: string,
  name: string,
  deps: KojoDefinitionDeps,
): EditorSymbolLocation | undefined {
  const result = deps.transpile(text);
  if (result.diagnostics.some((d) => d.severity === 'error')) return undefined;
  const headerLine = findGeneratedHeaderLine(result.erb, name);
  if (headerLine === null) return undefined;
  const sourceLine = sourceLineNear(result, headerLine);
  if (sourceLine === null) return undefined;
  return { filePath: path, line: sourceLine };
}

/** 取 1 基行号的原文（越界 → undefined） */
function lineTextOf(text: string, line: number): string | undefined {
  if (!Number.isFinite(line)) return undefined;
  const n = Math.trunc(line);
  if (n < 1) return undefined;
  return text.split(/\r\n?|\n/)[n - 1];
}
