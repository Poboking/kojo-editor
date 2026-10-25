/**
 * K6 收尾裁决 · 语料面钉子（lead 2026-10-25 指定防线）
 *
 * 防的事故形态 = 这次 K6 的「派生收口顺手把颜色收没了」：名单从别处派生时，被删族头在**单测夹具**
 * 里复现不出来（夹具只喂自造行），要等作者打开真口上才发现整片 `MARK:` / `SOURCE:` 白字。
 * 本钉把判据押在**真语料原样行**上：
 * - 取 `MARK:` / `SOURCE:` / `ITEM:` / `TEQUIP:` / `NOWEX:` 各一处（`KOJO_SMOKE_PROJECT`/`KOJO_CORPUS_DIR`
 *   指向的项目里 `ERB/` 树，按路径序走、每族取第一条**干净行**：非注释行、`HEAD:` 出现点不在行首注释
 *   之后、且不在双引号奇偶配平的串体外——避免"注释/纯文本里的同形词"制造假红），
 * - 走**真 Monarch 编译**（`monarch-harness` 的 `compileMonarch`，与 `erb-highlight.test.ts` 同一基座），
 *   断言该族头仍发 `variable` 档。
 * 语料不在盘上（两个环境变量都没给）⇒ 整组 **SKIP**，不假绿（守门口径同 `jump-to-state.corpus.test.ts`）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../src/monaco/erb-language';
import { compileMonarch, driveLine, stubMonaco, type CompiledLexer } from './monarch-harness';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const HEADS = ['MARK', 'SOURCE', 'ITEM', 'TEQUIP', 'NOWEX'] as const;

interface Sample {
  readonly head: string;
  readonly file: string;
  readonly lineNo: number;
  readonly line: string;
}

/** 行内首个合法 `HEAD:` 出现点的列（不合法返回 -1）：前一列不许是标识符字符（`XMARK:` 不算 MARK:） */
function headColumn(line: string, head: string): number {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])(${head}:[^\\s,()\\[\\]{}'"+\\-*/%<>=!&|;]+)`, 'i');
  const m = re.exec(line);
  if (!m || m.index === undefined) return -1;
  const seg = m[1];
  if (seg === undefined) return -1;
  return line.indexOf(seg);
}

/** 干净行判据（见文件头注）：非注释起行、出现点不在行中注释后、不在未配平的串体里 */
function acceptable(line: string, col: number): boolean {
  if (line.trimStart().startsWith(';')) return false;
  const semi = line.indexOf(';');
  if (semi !== -1 && semi < col) return false;
  let quotes = 0;
  for (let i = 0; i < col; i++) if (line[i] === '"') quotes++;
  return quotes % 2 === 0;
}

describe.skipIf(!SMOKE)('K6 收尾裁决 · 真语料原样行走真 Monarch 仍出 variable', () => {
  let lexer: CompiledLexer;
  let samples: Sample[] = [];

  beforeAll(async () => {
    const root = join(SMOKE!, 'ERB');
    expect(existsSync(root), `语料在项目根下没有 ERB/ 目录：${root}（KOJO_SMOKE_PROJECT 指错了？）`).toBe(true);

    // 走树（目录序 + 名序，确定性）；每族取第一条干净行，取齐即停
    const found = new Map<string, Sample>();
    const scanFile = (path: string, rel: string): void => {
      const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/);
      for (const head of HEADS) {
        if (found.has(head)) continue;
        for (let i = 0; i < lines.length; i++) {
          const col = headColumn(lines[i]!, head);
          if (col !== -1 && acceptable(lines[i]!, col)) {
            found.set(head, { head, file: rel, lineNo: i + 1, line: lines[i]! });
            break;
          }
        }
      }
    };
    const walk = (dir: string, relDir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (found.size === HEADS.length) return;
        const p = join(dir, name);
        const rel = relDir ? `${relDir}/${name}` : name;
        if (statSync(p).isDirectory()) walk(p, rel);
        else if (/\.(erb|erm|erh)$/i.test(name)) scanFile(p, rel);
      }
    };
    walk(root, '');
    samples = HEADS.map((h) => found.get(h)).filter((x): x is Sample => x !== undefined);
    expect(found.size, `五枚族头没取齐（缺：${HEADS.filter((h) => !found.has(h)).join(' / ')}）——语料在位就该取得到`).toBe(HEADS.length);

    const { monaco, captured } = stubMonaco();
    registerErbLanguage(monaco);
    const def = captured.monarchs.get(ERB_LANGUAGE_ID);
    expect(def, '桩没捕获到 ERB Monarch def（装配面漂）').toBeTruthy();
    lexer = await compileMonarch(ERB_LANGUAGE_ID, def!);
  }, 180_000);

  for (const head of HEADS) {
    it(`${head}: 真语料原样行发 variable 档`, () => {
      const s = samples.find((x) => x.head === head)!;
      const { emitted } = driveLine(lexer, s.line);
      const hit = emitted.find(
        (e) => e.token.startsWith('variable.') && e.text.toUpperCase().startsWith(`${head.toUpperCase()}:`),
      );
      expect(
        hit,
        `「${s.file}:${s.lineNo}」的 ${head}: 没进 variable（实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}）`,
      ).toBeDefined();
    });
  }
});
