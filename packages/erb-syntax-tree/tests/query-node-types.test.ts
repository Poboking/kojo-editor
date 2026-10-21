import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 查询闸：`queries/*.scm` 里引用的具名节点类型，必须都出现在 `src/node-types.json` 的具名类型集合里。
 *
 * 动机：tree-sitter 编译查询时遇到语法里不存在的节点类型会整份失败（`Invalid node type …`），
 * 一条笔误就让整张查询表失效。这里不跑 wasm（纯文本对拍，快且不依赖构建产物），
 * 缺一个就红，并按「文件:行号 → 缺失类型」列出。
 *
 * 语料只读纪律：只读本包 `queries/` 与 `src/node-types.json`。
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const QUERIES = join(PKG, 'queries');
const NODE_TYPES = join(PKG, 'src', 'node-types.json');

interface TypeRef {
  type: string;
  file: string;
  line: number;
}

/**
 * 把「字符串字面量内容」与「行尾 `;` 注释」抹成空格（保留列宽），
 * 以免 `(#match? @x "^(a)$")` 或带分号的字符串被当成节点引用。
 */
function maskLine(line: string): string {
  const out = line.split('');
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out[i] = ' ';
      } else if (c === '\\') {
        escaped = true;
        out[i] = ' ';
      } else if (c === '"') {
        inString = false;
        out[i] = ' ';
      } else {
        out[i] = ' ';
      }
    } else if (c === '"') {
      inString = true;
      out[i] = ' ';
    } else if (c === ';') {
      for (let j = i; j < line.length; j++) out[j] = ' ';
      break;
    }
  }
  return out.join('');
}

/** `(a)` / `(a) @cap` / `[(a) (b)]` / `(a field: (b))` 里的具名类型名。 */
const NODE_REF_PATTERNS = [/\(([a-z_][a-z0-9_]*)\)/g, /\(([a-z_][a-z0-9_]*)\s/g];

function collectRefs(file: string, text: string): TypeRef[] {
  const refs: TypeRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const masked = maskLine(lines[i]);
    for (const pattern of NODE_REF_PATTERNS) {
      const re = new RegExp(pattern.source, 'g');
      for (const m of masked.matchAll(re)) {
        const type = m[1];
        // `_hidden` 规则不产节点；`(#eq? …)` 一类谓词不是节点。
        if (type.startsWith('_') || type.startsWith('#')) continue;
        refs.push({ type, file, line: i + 1 });
      }
    }
  }
  return refs;
}

const namedTypes: Set<string> = new Set(
  (JSON.parse(readFileSync(NODE_TYPES, 'utf8')) as Array<{ type: string; named?: boolean }>)
    .filter((n) => n.named === true)
    .map((n) => n.type),
);

const queryFiles = readdirSync(QUERIES)
  .filter((f) => f.endsWith('.scm'))
  .sort();

describe('queries/*.scm 的节点类型 vs node-types.json', () => {
  it('引用的具名节点类型全部存在于语法中', () => {
    expect(queryFiles.length).toBeGreaterThan(0);
    expect(namedTypes.size).toBeGreaterThan(0);

    const refs = queryFiles.flatMap((f) => collectRefs(f, readFileSync(join(QUERIES, f), 'utf8')));
    expect(refs.length).toBeGreaterThan(0);

    const missing = refs
      .filter((r) => !namedTypes.has(r.type))
      .map((r) => `${r.file}:${r.line} → ${r.type}`);

    expect(missing, `查询引用了语法里不存在的节点类型：\n${missing.join('\n')}`).toEqual([]);
  });
});
