/**
 * 真实语料假阳性闸（表达式波浪线收口批）。
 *
 * 守门：`KOJO_SMOKE_PROJECT`（语料解析见 `tools/corpus.mjs`；**测试只读 env，不写死路径**）。
 * 口径：递归取语料下 `.ERB`（大小写不敏感、按路径排序，上限 600 份——确定性 + 防超时），
 * 走**生产链**：erb-parser 的真 `scanControlFlow` → `collectExprSyntaxDecorations`。
 *
 * 钉死四类曾在真语料上大面积误报、实际全是合法 ERB 的形态：
 * a) `@"…"` 逐字串 / 三元 `? … # …` 的 `@`、`#` 字符诊断；
 * b) 函数实参空槽 / 尾逗号（「多了一个逗号」）与嵌套括号（「多了一个右括号」）；
 * c) `2e3` / `0b11111` 数字字面量的 `“e` / `“b` 词法诊断；
 * d) 读数必须真实打印（文件数 / 诊断总数 / 各类命中数）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { collectExprSyntaxDecorations } from '../src/decorator';
import { decodeWithProbe } from '../../../kernel/src/encoding';

const MAX_FILES = 600;

/** 递归收集 `.ERB`（不跟随符号链接），按路径码点序排序后截断。 */
function collectErbFiles(root: string): string[] {
  const stack = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && /\.erb$/i.test(ent.name)) out.push(p);
    }
  }
  out.sort();
  return out.slice(0, MAX_FILES);
}

describe.skipIf(!process.env.KOJO_SMOKE_PROJECT)('表达式波浪线 · 真实语料假阳性闸', () => {
  it(`${MAX_FILES} 份以内 .ERB：@ / # / 空槽逗号 / 右括号 / e·b 字面量误报全归零`, () => {
    const files = collectErbFiles(process.env.KOJO_SMOKE_PROJECT!);
    expect(files.length).toBeGreaterThan(0);

    let diagnostics = 0;
    let atOrHash = 0;
    let commaOrParen = 0;
    let numSuffix = 0;
    const samples: string[] = [];
    const note = (file: string, line: number, message: string): void => {
      if (samples.length < 12) samples.push(`${file}:${line} ${message}`);
    };

    for (const file of files) {
      const { text } = decodeWithProbe(readFileSync(file));
      for (const d of collectExprSyntaxDecorations(text, scanControlFlow)) {
        diagnostics++;
        if (d.message.includes('无法识别的字符“@”') || d.message.includes('无法识别的字符“#”')) {
          atOrHash++;
          note(file, d.line, d.message);
        }
        if (d.message.includes('多了一个逗号') || d.message.includes('多了一个右括号')) {
          commaOrParen++;
          note(file, d.line, d.message);
        }
        if (/“[eb]/.test(d.message)) {
          numSuffix++;
          note(file, d.line, d.message);
        }
      }
    }

    console.log(
      `[expr-fp] 扫描 ${files.length} 份 .ERB，诊断 ${diagnostics} 条；` +
        `@/# ${atOrHash} · 逗号/右括号 ${commaOrParen} · e/b 字面量 ${numSuffix}`,
    );
    expect(samples, '命中前几条（定位用）').toEqual([]);
    expect(atOrHash, '“@” / “#” 词法诊断必须归零').toBe(0);
    expect(commaOrParen, '「多了一个逗号 / 右括号」必须归零').toBe(0);
    expect(numSuffix, '“e / “b 数字字面量诊断必须归零').toBe(0);
  }, 600_000);
});
