/**
 * 真实语料假阳性闸（表达式波浪线收口批 · 2026-11-07 D18「只在真表达式位判」）。
 *
 * 守门：`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR`（语料解析见 `tools/corpus.mjs`；
 * **测试只读 env，不写死路径；语料目录整体只读，本闸不写任何东西**）。
 * 口径：递归取语料下 `.ERB`（大小写不敏感、按路径排序，上限 5000 份——确定性 + 防超时），
 * 走**生产链**：erb-parser 的真 `scanControlFlow` → `collectExprSyntaxDecorations`。
 *
 * ## 钉死的族（每条都必须归零）
 *
 * 既有四族（2026-10-19 收口批）：
 * a) `@"…"` 逐字串 / 三元 `? … # …` 的 `@`、`#` 字符诊断；
 * b) 函数实参空槽 / 尾逗号（「多了一个逗号」）与嵌套括号（「多了一个右括号」）；
 * c) `2e3` / `0b11111` 数字字面量的 `"e` / `"b` 词法诊断；
 *
 * D18 新查出的四族（语料实测 74 条诊断里 71 条是它们，全是**非表达式位**）：
 * e) 逐字串台词被切碎：`%SPLIT_G(@"a:b:c")%` / `%FSYN("射精:射")%` —— 内层引号把
 *    `@"…"` 提前收串，台词里的 `:` `!` `/` 被当成表达式记号（「多了一个冒号」等）；
 * f) `%"　{:::＼:ヽ:_}…"%` ASCII 美术图（整段插值只是一枚字面量 = 显示文本）；
 * g) 中日文散文行（`RESULTS = 陷落状态4以上，与恋恋一起…`、更新日志 .erb 里的
 *    `SELECTCASE RAND:X误写成SELECTCASE X`）——全角断句 / 空格断词，不是表达式；
 * h) 乱码文件（非 UTF-8 补丁被探测式解码兜成 `�`）：在替换符上判语法 = 判乱码。
 *
 * ## 真阳性对照（本闸不许"把真阳性一起压掉"）
 *
 * 1. 本闸自带**不需要语料的夹具对照**（见文件末尾 `describe`）：合法表达式错照报、
 *    上述 e/f/g 形态一条不报；
 * 2. 语料面：`其它（真表达式位）` 这一族**不得归零**——归零即说明压假阳性时把
 *    表达式位上的真错也一起压掉了。
 *
 * 读数必须真实打印（文件数 / 诊断总数 / 各族命中数 / 每条残余的诊断原文）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { collectExprSyntaxDecorations } from '../src/decorator';
import { decodeWithProbe } from '../../../kernel/src/encoding';

/** 全语料 4,640 份 `.ERB`（eraTW4.981）实测整闸 ~8s；上限只为防语料爆量 */
const MAX_FILES = 5000;

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

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 全角/中日文标点与"括号里一个光问号"——散文断句标记（与生产判据独立复述一遍） */
const PROSE_PUNCT = /[\uFF0C\uFF1A\uFF1B\u3001\u3002\uFF01\uFF1F\u2026]|\(\s*\?/;
/** "记号 空白 记号"（真表达式里记号相邻必隔 ASCII 运算符） */
const SPACE_GAP = /[A-Za-z0-9_\u0080-\uffff][ \t\u3000\u00a0]+[A-Za-z0-9_\u0080-\uffff]/;
const NON_ASCII = /[^\u0000-\u007f]/;
/** 探测式解码的替换符 */
const LOSSY = '\uFFFD';

/** 诊断归族（**按行形态**判，不看生产守卫怎么想——守卫退化了这里就会响） */
function familyOf(lineText: string, message: string): string {
  if (lineText.includes(LOSSY)) return 'mojibake';
  if (message.includes('无法识别的字符“@”') || message.includes('无法识别的字符“#”')) return 'atOrHash';
  if (message.includes('多了一个逗号') || message.includes('多了一个右括号')) return 'commaOrParen';
  if (/“[eb]/.test(message)) return 'numSuffix';
  if (lineText.includes('@"')) return 'verbatim';
  if (/%\\?"/.test(lineText)) return 'aaArt';
  // 散文判据看**表达式面**：行首那枚语句关键字（`IF` / `SIF` …）自己就与操作数隔着空格，
  // 不剥掉会把 `IF 倍率 > 1.0` 这类真表达式位误算成散文
  const exprSide = lineText.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*/, '');
  if (PROSE_PUNCT.test(exprSide) || (NON_ASCII.test(exprSide) && SPACE_GAP.test(exprSide))) return 'prose';
  return 'exprPos';
}

describe.skipIf(!SMOKE)(`表达式波浪线 · 真实语料假阳性闸（${MAX_FILES} 份以内）`, () => {
  it('八族误报归零，且表达式位真错不归零', () => {
    const files = collectErbFiles(SMOKE!);
    expect(files.length).toBeGreaterThan(0);

    const counts = new Map<string, number>();
    let diagnostics = 0;
    const filesWithHits = new Set<string>();
    const samples: string[] = [];
    const bump = (family: string): void => {
      counts.set(family, (counts.get(family) ?? 0) + 1);
    };
    const note = (file: string, line: number, family: string, message: string): void => {
      if (samples.length < 12) samples.push(`[${family}] ${file}:${line} ${message}`);
    };

    for (const file of files) {
      const { text } = decodeWithProbe(readFileSync(file));
      const lines = text.split(/\r\n|\r|\n/);
      for (const d of collectExprSyntaxDecorations(text, scanControlFlow)) {
        diagnostics++;
        filesWithHits.add(file);
        const family = familyOf(lines[d.line - 1] ?? '', d.message);
        bump(family);
        note(file, d.line, family, d.message);
      }
    }
    const n = (f: string): number => counts.get(f) ?? 0;

    console.log(
      `[expr-fp] 扫描 ${files.length} 份 .ERB，诊断 ${diagnostics} 条，命中 ${filesWithHits.size} 份；` +
        `a)@/# ${n('atOrHash')} · b)逗号/右括号 ${n('commaOrParen')} · c)e/b 字面量 ${n('numSuffix')} · ` +
        `e)逐字串台词 ${n('verbatim')} · f)AA 美术图 ${n('aaArt')} · g)中日文散文 ${n('prose')} · ` +
        `h)乱码 ${n('mojibake')} · 真表达式位 ${n('exprPos')}`,
    );
    for (const s of samples) console.log(`[expr-fp] 残余 ${s}`);

    // 既有四族（判据只加不删）
    expect(n('atOrHash'), '“@” / “#” 词法诊断必须归零').toBe(0);
    expect(n('commaOrParen'), '「多了一个逗号 / 右括号」必须归零').toBe(0);
    expect(n('numSuffix'), '“e / “b 数字字面量诊断必须归零').toBe(0);
    // D18 新查出的四族
    expect(n('verbatim'), '逐字串台词里的冒号/运算符诊断必须归零（内层引号不得提前收串）').toBe(0);
    expect(n('aaArt'), '`%"…"%` ASCII 美术图诊断必须归零（插值里的字面量是显示文本）').toBe(0);
    expect(n('prose'), '中日文散文行诊断必须归零（全角断句 / 空格断词不是表达式位）').toBe(0);
    expect(n('mojibake'), '乱码文件上的词法诊断必须归零（那是在判解码替换符）').toBe(0);
    // 真阳性对照：表达式位上的真错不许被一起压掉
    expect(n('exprPos'), '真阳性对照：表达式位诊断不得归零（归零即压过了头）').toBeGreaterThan(0);
  }, 600_000);
});

/**
 * 真阳性对照（**不需要语料**，每次都跑）：D18 收窄的是"判哪"，不是"判不判"。
 * 左边合法表达式错照报；右边本批压掉的形态一条不报。
 */
describe('表达式腿 · 收窄判据不许误伤真错（夹具对照）', () => {
  const run = (line: string): ReturnType<typeof collectExprSyntaxDecorations> => {
    const text = `@TEST_FUNC\n${line}\n`;
    return collectExprSyntaxDecorations(text, scanControlFlow);
  };

  it('表达式位的真错照报：条件 / 插值 / 赋值三面', () => {
    // 条件面：多余右括号 / 缺操作数
    expect(run('IF CFLAG:100 )')).toHaveLength(1);
    expect(run('SIF (1 + ) == 0')).toHaveLength(1);
    // 插值面：多余右括号（`{D)}` 是真错，不是美术图）
    expect(run('PRINT "{D)}"')).toHaveLength(1);
    // 赋值面：括号不闭合
    expect(run('A = (B + 1')).toHaveLength(1);
  });

  it('压掉的形态一条不报：逐字串台词 / `%"…"%` 美术图 / 中日文散文 / 乱码', () => {
    // e) 逐字串台词：内层引号不提前收串，台词里的 `:` 不是表达式记号（三条都取自语料）
    expect(run('PRINTFORMW 「%SPLIT_G(@"黏糊糊一团糟%K11_ZE("daze")%:你射了好多")%」')).toEqual([]);
    expect(run('PRINTFORMDL 阿吽%SPLIT_G(@"注意到你即将高潮:感受到体内%FSYN_CN("搏动")%")%。')).toEqual([]);
    expect(run('PRINTFORMDL 荷取 %SPLIT_G(@"侵入了你的 %FSYN(@"%SPLIT_G(@"anus:ass")%",,51)%:手插进了你的")%')).toEqual(
      [],
    );
    // f) 美术图：整段插值只是一枚字面量（= 显示文本，不是格式串）
    expect(
      run('PRINTFORMDL %"　　　 {:::＼:ヽ:_}:::::::|　　　　|:.:|:|:|:|ｉ..|: : : : :＼: : : /::::::{: |. ､_Y:､:::::::::::::::::::::::"%'),
    ).toEqual([]);
    // g) 散文：全角断句 / 空格断词 / `(?)`
    expect(run('RESULTS = 陷落状态4以上，与恋恋一起待在地灵殿某处，恋恋心情好时，晚上20:00之后出发')).toEqual([]);
    expect(run('SELECTCASE RAND:X误写成SELECTCASE X')).toEqual([]);
    expect(run('RESULTS = 觉妖怪与裂空刺眼惊(?)')).toEqual([]);
    // h) 乱码：解码替换符不是作者写的字符
    expect(run('IF TALENT:���� || TALENT:���~')).toEqual([]);
  });

  it('折行续写（跨行表达式）不报，真残句照报', () => {
    const multi = ['@TEST_FUNC', 'IF MAX(', '\tITEM:キャベツ, ITEM:イチゴ,', '\tITEM:ナス) <= 0'].join('\n');
    expect(collectExprSyntaxDecorations(multi, scanControlFlow)).toEqual([]);
    // 对照：同样"括号没闭合"但下一行是新语句 ⇒ 不是折行，照报
    const broken = ['@TEST_FUNC', 'IF (A', 'PRINTL 下一句'].join('\n');
    expect(collectExprSyntaxDecorations(broken, scanControlFlow).length).toBeGreaterThan(0);
  });
});
