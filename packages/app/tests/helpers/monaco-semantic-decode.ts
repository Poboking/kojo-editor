/**
 * 语义 token 数据的**真解码器**（测试专用）：直接调 Monaco 0.57 自己的
 * `toMultilineTokens2`，把 `SemanticTokens.data` 读回"屏幕上落在哪一行哪一列"。
 *
 * ## 为什么不再自写解码器
 *
 * 2026-10-26 坐标错位批：三份编码器都把 1 基模型坐标原样写进 `deltaLine` / 换行时的
 * `deltaStart`，而 Monaco 的解码器（`semanticTokensProviderStyling.js`）是
 * `let lastLineNumber = 1`、`lineNumber = lastLineNumber + deltaLine` ⇒ 整篇结构色**下沉一行**，
 * 真机症状＝第 11 行 `IF LOCAL` 被画到第 10 行、并从第 2 列起。闸一直绿，因为测试里那份
 * 自写解码器从 `line = 0` 起算、与编码器同为 1 基——**自洽但不等于 Monaco 的口径**。
 *
 * 所以这里不再写第二套解码逻辑：只把 Monaco 的模块拉进来跑 `data`。要让它红的办法只有
 * 一个——编码时少写这一格减一（见 `docs` 里那条取证，行长/落点都来自 Monaco 自己的
 * `SparseMultilineTokens`）。
 *
 * ## 怎么读回类型与修饰位
 *
 * `toMultilineTokens2` 只负责坐标，类型/修饰经 `styling.getMetadata(typeIndex, modifierSet)`
 * 变成主题 metadata 原样写进 destData（只有等于 `NO_STYLING` 才丢）。这里的 stub styling
 * 把两者**打包**成 metadata：`(modifierSet << 8) | (typeIndex + 1)` ⇒ 落点里能原样读回。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 一枚被 Monaco 解回来的 token（行列都是 1 基，`endColumn` 排他，与模型坐标同口径） */
export interface DecodedSemanticToken {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  /** legend 下标 */
  readonly type: number;
  /** 修饰位掩码 */
  readonly bits: number;
}

/** Monaco 的 `SemanticTokensProviderStylingConstants.NO_STYLING`（命中的 token 会被丢弃） */
const NO_STYLING = 2147483647;
/** 打包 metadata：低 8 位放 `typeIndex + 1`，高 bits 放修饰位 */
const TYPE_MASK = 0xff;

interface MonacoLineTokens {
  getCount(): number;
  /** 0 基字符位 */
  getStartCharacter(tokenIndex: number): number;
  /** 0 基字符位（排他） */
  getEndCharacter(tokenIndex: number): number;
  getMetadata(tokenIndex: number): number;
}

interface MonacoMultilineTokens {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  getLineTokens(lineNumber: number): MonacoLineTokens | null;
}

interface MonacoTokenStyling {
  getMetadata(typeIndex: number, modifierSet: number, languageId: string): number;
  warnInvalidLengthSemanticTokens(lineNumber: number, charOffset: number): void;
  warnOverlappingSemanticTokens(lineNumber: number, charOffset: number): void;
}

/** `semanticTokensProviderStyling.js` 里真正被生产路径调用的那一枚（与 `SemanticTokensProviderStyling` 同文件导出） */
interface MonacoSemanticTokensDecoderModule {
  toMultilineTokens2(
    tokens: { readonly data: Uint32Array },
    styling: MonacoTokenStyling,
    languageId: string,
  ): MonacoMultilineTokens[];
}

/** 包根：`monaco-editor` 的 exports 把 `./*` 映到 `./esm/vs/*.js`，`package.json` 子路径
 * 在某些 Node 版本下解析不到 ⇒ 先按清单子路径试，失败再从包入口往上找包根。 */
function monacoPackageRoot(): string {
  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve('monaco-editor/package.json'));
  } catch {
    let dir = dirname(require.resolve('monaco-editor'));
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    throw new Error('[monaco-semantic-decode] 找不到 monaco-editor 包根');
  }
}

let decoderPromise: Promise<MonacoSemanticTokensDecoderModule> | null = null;

/** 懒装载（每个测试进程一次；用真包路径，不复制 Monaco 的解码逻辑） */
function loadDecoder(): Promise<MonacoSemanticTokensDecoderModule> {
  decoderPromise ??= (async () => {
    const url = pathToFileURL(
      join(monacoPackageRoot(), 'esm', 'vs', 'editor', 'common', 'services', 'semanticTokensProviderStyling.js'),
    ).href;
    return (await import(url)) as MonacoSemanticTokensDecoderModule;
  })();
  return decoderPromise;
}

/**
 * 用 Monaco 自己的解码器把 `SemanticTokens.data` 读回逐条落点。
 *
 * 空数据 ⇒ 空数组（与 `toMultilineTokens2` 对 0 条 token 的应答一致）。
 */
export async function decodeWithMonaco(data: Uint32Array): Promise<DecodedSemanticToken[]> {
  const { toMultilineTokens2 } = await loadDecoder();
  const styling: MonacoTokenStyling = {
    getMetadata: (typeIndex, modifierSet) => (modifierSet << 8) | (typeIndex + 1),
    warnInvalidLengthSemanticTokens: () => undefined,
    warnOverlappingSemanticTokens: () => undefined,
  };
  const areas = toMultilineTokens2({ data }, styling, 'kojo-semantic-gate');
  const out: DecodedSemanticToken[] = [];
  for (const area of areas) {
    for (let line = area.startLineNumber; line <= area.endLineNumber; line++) {
      const tokens = area.getLineTokens(line);
      if (tokens === null) continue;
      for (let i = 0; i < tokens.getCount(); i++) {
        const metadata = tokens.getMetadata(i);
        if (metadata === NO_STYLING) continue;
        out.push({
          line,
          startColumn: tokens.getStartCharacter(i) + 1,
          endColumn: tokens.getEndCharacter(i) + 1,
          type: (metadata & TYPE_MASK) - 1,
          bits: metadata >>> 8,
        });
      }
    }
  }
  return out;
}
