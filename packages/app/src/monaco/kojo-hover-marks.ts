import type { HoverHit } from './kojo-hover';
import {
  ERB_CONTINUATION_MARKERS,
  erbContinuationRoleOf,
  erbPreprocRoleOf,
  unicodeTokenAt,
} from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { ERB_DECLARATION_DIRECTIVES, ERB_DIRECTIVES } from './erb-directives';
import { classifyKojoLine } from './kojo-native-zone';

/**
 * 原生标记的**悬停分类**（v1.9 P2「悬停」面）。
 *
 * 只回答"这是什么"——`[IF …]` 是预处理标记、`#DIM` 是 ERB 声明、`{` / `}` 是行连接标记、
 * 行首大写词是 ERB 语句。**不给逐词文档**（补充稿：不承诺逐词文档），也不抢前六路的
 * 事实（变量名 / 函数中文名 / 位号 / 指令编号 / 定义正文）。
 *
 * 判据全部来自单源：
 * - 预处理角色 = `plugin-api/erb.ts` 的 `erbPreprocRoleOf`（与转译器 / 高亮同一枚）；
 * - 行连接角色 = 同文件的 `erbContinuationRoleOf`；
 * - 声明族 / 语句词表 = `erb-directives.ts`（与补全 / 高亮同一份）。
 */

const DECLARATION_SET: ReadonlySet<string> = new Set(ERB_DECLARATION_DIRECTIVES);
const DIRECTIVE_SET: ReadonlySet<string> = new Set(ERB_DIRECTIVES);
const FAMILY_SET: ReadonlySet<string> = new Set(ENGINE_VARIABLE_FAMILIES);

/** 行首（缩进之后）第一个字符的 0 基下标 */
function firstNonBlank(line: string): number {
  const m = /^[ \t\u3000]*/.exec(line);
  return m === null ? 0 : m[0].length;
}

/**
 * 解析光标处的原生标记分类；不是可分类的标记 ⇒ `undefined`（不猜）。
 * `column` = Monaco 的 1 基列。
 */
export function resolveErbMarkHover(lineText: string, column: number): HoverHit | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  const trimmed = lineText.trim();
  if (trimmed.length === 0) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  // 1) `{` / `}` 行连接标记（整行严格等值）
  if (erbContinuationRoleOf(trimmed) !== null) {
    const start = firstNonBlank(lineText);
    if (col0 !== start) return undefined; // 只认标记字符本身
    const mark = lineText.slice(start, start + 1);
    return {
      name: `行连接标记 ${mark}`,
      kind: '引擎记号 · 行连接',
      startColumn: start + 1,
      endColumn: start + 2,
      lines: [
        `引擎把 \`${ERB_CONTINUATION_MARKERS.open}\` … \`${ERB_CONTINUATION_MARKERS.close}\` 之间的物理行拼成一条逻辑行。`,
      ],
    };
  }

  // 2) 预处理标记 `[IF …]` 族（整行严格等值）
  if (erbPreprocRoleOf(trimmed) !== null) {
    const start = firstNonBlank(lineText);
    if (col0 < start) return undefined;
    return {
      name: trimmed,
      kind: '预处理标记',
      startColumn: start + 1,
      endColumn: Math.min(lineText.length, start + trimmed.length) + 1,
      lines: [
        '整行严格等值（大小写不敏感），引擎按文件级裁剪。',
        '糖形写法：`预处理 如果 <宏>：` … `预处理结束`（回读为同一批标记）。',
      ],
    };
  }

  const token = unicodeTokenAt(lineText, column);
  if (token === null) return undefined;
  const upper = token.text.toUpperCase();

  // 3) `#` 声明族（`#DIM` / `#FUNCTION` …）
  const prefix = lineText.slice(0, token.startColumn - 1);
  if (prefix.trimEnd().endsWith('#')) {
    if (!DECLARATION_SET.has(upper)) return undefined;
    return {
      name: `#${upper}`,
      kind: 'ERB 声明',
      startColumn: token.startColumn - 1,
      endColumn: token.endColumn,
      lines: ['文件级 / 返回类型声明：逐字节直通，不拆中文写形。'],
    };
  }

  // 4) 行首大写词：ERB 语句 / 引擎族头（糖区行必须落到原生直通行类，避免把台词里的
  //    大写单词当语句——词法判据用同一枚 `classifyKojoLine`，不另写规则）
  if (token.startColumn - 1 !== firstNonBlank(lineText)) return undefined;
  if (classifyKojoLine(lineText).kind !== 'rawLine') {
    if (!FAMILY_SET.has(upper)) return undefined;
    return {
      name: upper,
      kind: '引擎族头',
      startColumn: token.startColumn,
      endColumn: token.endColumn,
      lines: ['引擎变量族头（`族:段:…` 引用形态）。'],
    };
  }
  if (!DIRECTIVE_SET.has(upper)) return undefined;
  return {
    name: upper,
    kind: 'ERB 语句',
    startColumn: token.startColumn,
    endColumn: token.endColumn,
    lines: ['原生 ERB 语句（整行直通，不拆糖形）。'],
  };
}
