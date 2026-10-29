/**
 * 《Kojo 2.0 语言教程》内容自证（写法照 `tests/tutorial.test.ts`，口径同源）。
 *
 * 钉的是**结构性底线**与**三条必须成立的内容事实**：
 * 1. id / title / 导语 / 节数 / 圈码标题唯一；覆盖面按 2.0 现行构造逐个点名（钉**出现**、
 *    不钉表述——表述归文风纪律管，漏了一整个构造才是这里要抓的）；
 * 2. **样例逐字溯源**：每一张样张的每一行都必须在允许的 2.0 夹具里逐字存在（只许截取、
 *    不许改写；行首空白忽略，因为截取时会剥掉整块缩进）；
 * 3. **旧写法不许被当成正面写法教**：`如果` / `分支：` / `别名` / `隐藏情景` / `旁白色`
 *    只准出现在"这是旧稿、这是迁移"的语境里——按**句子**判，且只要求那一句自己带语境词，
 *    宁可判窄不判宽（误伤一句好话的成本，比漏掉一句坏话低）。
 *
 * 另有两条负面底线：已封存的三件不提、内部术语不进作者面正文；一条正面底线：
 * 档位口径**逐字**与其余 lane 共用同一段（这段一改就对不上，所以钉在这里）。
 *
 * ## 为什么这里**不**钉产物对照
 *
 * 本教程的样张一律不带 `erb`：仓里现成的 2.0 侧 `.erb` 只有两类，一类
 * （`kojo-core/tests/fixtures/migrate-corpus/*.2.erb`）的**源是 1.x 稿件**，配不上
 * "左边是你写的 2.0"；另一类（`eratw-adapter/tests/kojo2/backend.test.ts` 的 canonical
 * golden）走的是该测试自己的**假表达式端口**（同文件 41-48 行自述）。所以这里钉的是
 * 「一个 `erb` 字段都不许出现」——哪天真的接上全链产物，再连同出处一起翻这条断言。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOJO2_TUTORIAL } from '../src/tutorial-content-kojo2';
import type { Tutorial } from '../src/tutorial-content';

/** 一份教程的全部**叙述**文本（标题、导语、节标题、段落、样例说明、表上方那句话；不含代码与表格单元） */
function tutorialText(t: Tutorial): string {
  return [
    t.title,
    t.lead,
    ...t.sections.flatMap((s) => [
      s.heading,
      ...s.paragraphs,
      ...(s.samples ?? []).map((sample) => sample.caption ?? ''),
      ...(s.tables ?? []).map((table) => table.note ?? ''),
    ]),
  ].join('\n');
}

/* ============================== 溯源清单 ============================== */

/** 相对本测试文件起算（**不许手拆 `import.meta.url.pathname`**：中文路径 checkout 会必红，PITFALLS 172） */
const fixtureUrl = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** 允许出处的全部 2.0 夹具（`kojo2` 系；本教程的样张只许从这些文件里截） */
const KOJO2_FIXTURE_PATHS: readonly string[] = [
  '../../../kojo-core/tests/fixtures/kojo2-canonical.kojo2',
  '../../../kojo-core/tests/fixtures/e2e/canonical.kojo2',
  '../../../kojo-core/tests/fixtures/e2e/machine.kojo2',
  '../../../kojo-core/tests/fixtures/e2e/random.kojo2',
  '../../../kojo-core/tests/fixtures/migrate/mechanical.kojo2',
  '../../../kojo-core/tests/fixtures/migrate/semantic.kojo2',
  '../../../kojo-conformance/tests/fixtures/basic.kojo2',
  '../../../kojo-conformance/tests/fixtures/color.kojo2',
  '../../../app/tests/fixtures/kojo2/completion.kojo2',
  '../../../app/tests/fixtures/kojo2/hover-definition.kojo2',
  '../../../app/tests/fixtures/kojo2/sourcemap-preview.kojo2',
].map(fixtureUrl);

/** 读若干份夹具并按行归一成一集：去 BOM、统一换行、去行首空白、丢空行 */
function fixtureLineSet(paths: readonly string[]): Set<string> {
  const lines = new Set<string>();
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((raw) => raw.trimStart())
      .filter((raw) => raw.length > 0)) {
      lines.add(line);
    }
  }
  return lines;
}

/** 样张里所有"在夹具中找不到"的行（空数组 = 逐字对得上） */
function driftedLines(sample: string, allowed: Set<string>): string[] {
  return sample
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0 && !allowed.has(line));
}

/** 全部代码样张（`kojo` 侧；本教程不许出现 `erb` 侧） */
const allSamples = (t: Tutorial) => t.sections.flatMap((s) => s.samples ?? []);

describe('Kojo 2.0 语言教程（内容底线）', () => {
  it('id 是契约名 kojo2、标题与导语到位', () => {
    expect(KOJO2_TUTORIAL.id).toBe('kojo2');
    expect(KOJO2_TUTORIAL.title).toBe('Kojo 2.0 语言教程');
    expect(KOJO2_TUTORIAL.lead.trim().length).toBeGreaterThan(0);
  });

  it('节数 ≥ 10，每节标题以圈码起首且互不重复', () => {
    expect(KOJO2_TUTORIAL.sections.length).toBeGreaterThanOrEqual(10);
    const headings = KOJO2_TUTORIAL.sections.map((s) => s.heading);
    for (const heading of headings) {
      expect(/^[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]\s/u.test(heading), `标题缺圈码起首：${heading}`).toBe(true);
    }
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('每节段落非空；段落与样例说明里不含拼装泄漏', () => {
    for (const section of KOJO2_TUTORIAL.sections) {
      expect(section.paragraphs.length, section.heading).toBeGreaterThan(0);
      for (const paragraph of section.paragraphs) expect(paragraph.trim().length).toBeGreaterThan(0);
      for (const sample of section.samples ?? []) {
        expect(sample.kojo.trim().length).toBeGreaterThan(0);
        expect(`${sample.kojo}${sample.caption ?? ''}`).not.toContain('undefined');
      }
    }
  });

  it('样张 ≥ 12，且一条编译产物对照都不给（产物口径见文件头：宁缺不编）', () => {
    const samples = allSamples(KOJO2_TUTORIAL);
    expect(samples.length).toBeGreaterThanOrEqual(12);
    for (const sample of samples) expect(sample.erb, '本教程不接全链产物，不许出现 erb 样张').toBeUndefined();
  });

  /**
   * 覆盖面底线：2.0 现行实现里的正典构造名必须**逐个在场**。
   * 钉出现、不钉表述——漏了一整个构造才是这里要抓的。
   */
  it('覆盖 2.0 的全部正典构造名', () => {
    const text = `${tutorialText(KOJO2_TUTORIAL)}\n${allSamples(KOJO2_TUTORIAL)
      .map((sample) => sample.kojo)
      .join('\n')}`;
    for (const surface of [
      '# 幕',
      '# 视',
      '# 机',
      '# 常量',
      '# 变量',
      '# 对照表',
      '# 池',
      '# 模',
      '@算',
      '@着色',
      '@颜绘',
      '@随机',
      '@组',
      '@织',
      '@原生',
      '@循',
      '@断',
      '@续',
      '@复',
      '@巡',
      '@标',
      '@跳',
      '@函',
      '@返',
      '? 否',
      '[插槽]',
      '续',
      '空行',
      '选项',
      '//',
      '{我}',
      '{你}',
      '(心形)',
      '\\>',
      '存档',
      '会话',
      '.长度',
    ]) {
      expect(text, `Kojo 2.0 教程漏了构造：${surface}`).toContain(surface);
    }
  });

  /** 档位口径是**跨 lane 共用**的同一段文案：逐字钉住，改写一个字就红。 */
  it('第①节逐字带档位口径', () => {
    const first = KOJO2_TUTORIAL.sections[0]!;
    const lead = [first.heading, ...first.paragraphs].join('\n');
    expect(lead).toContain(
      '今天默认档位是「2.0 默认」（保底档）：`.kojo` 就是 kojo（2.0）的源，新装的编辑器打开 `.kojo` 走的就是这一套；' +
        '`.kojo1` 是封存的 kojo1 旧写法，默认按纯文本打开，要看它得在设置页把档位切到「双轨」或「只认 v1」。' +
        '切档后 kojo1 的配套功能要重开项目或重载窗口才装上（编辑器会提示，不会静默）。',
    );
  });
});

/* ============================== 溯源守卫（宽松口径，同 tutorial.test.ts） ============================== */

describe('Kojo 2.0 教程样例溯源守卫', () => {
  const kojoLines = fixtureLineSet(KOJO2_FIXTURE_PATHS);

  it('夹具清单真的读进了集合（十一份文件、非空、含 2.0 锚点行）', () => {
    expect(KOJO2_FIXTURE_PATHS.length).toBe(11);
    expect(kojoLines.size).toBeGreaterThan(100);
    expect(kojoLines.has('# 对照表 心情 依据 恋慕')).toBe(true);
    expect(kojoLines.has('灵梦：「{你}今天来得挺早嘛。」(微笑)')).toBe(true);
  });

  it('每一条样例行都能在允许的 2.0 夹具里逐字找到', () => {
    const drift: string[] = [];
    for (const section of KOJO2_TUTORIAL.sections) {
      for (const sample of section.samples ?? []) {
        for (const line of driftedLines(sample.kojo, kojoLines)) drift.push(`${section.heading} → ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('守卫自身有效：改一个字必须被抓出', () => {
    expect(driftedLines('    灵梦：「……好。」 续', kojoLines)).toEqual([]);
    expect(driftedLines('灵梦：「……好。」 续', kojoLines)).toEqual([]);
    // 负样本：动一个字 / 造一个夹具里没有的名字，都必须飘红
    expect(driftedLines('灵梦：「……好。 续', kojoLines)).not.toEqual([]);
    expect(driftedLines('# 对照表 心情 依据 爱欲', kojoLines)).not.toEqual([]);
    expect(driftedLines('    队列[0] = 4', kojoLines)).not.toEqual([]);
  });
});

/* ============================== 负面底线 ============================== */

/**
 * 旧写法只准待在"旧稿怎么办"的语境里。**按句判**：句子里点了这些词，就必须自己带语境词。
 * 判窄不判宽——误伤一句好话的成本比漏掉一句坏话低；表格单元是逐条对照，语境由表头那句
 * `note` 给（`tutorialText` 收 note、不收单元），所以这里只吃叙述文本。
 */
function legacyWithoutContext(text: string): string[] {
  const offenders: string[] = [];
  for (const sentence of text
    .split(/[\n。；;]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)) {
    if (!/(如果|分支：|别名|隐藏情景|隐藏口上|旁白色|口上色|`~`|数据表)/u.test(sentence)) continue;
    // 这些词单独成句时也必须自带退场语境，否则就是"把旧写法当 2.0 教"
    if (!/(旧|老|退场|迁移|不再|不认|不收|没了下文|搬到|改成|换成|对照|暂无|别照|判不出|报错)/u.test(sentence)) {
      offenders.push(sentence);
    }
  }
  return offenders;
}

describe('Kojo 2.0 教程不该出现的东西', () => {
  const prose = tutorialText(KOJO2_TUTORIAL);

  it('不把旧写法当成正面写法教（如果 / 分支：/ 别名 / 隐藏情景 / 旁白色）', () => {
    expect(legacyWithoutContext(prose), '旧写法出现在没有迁移语境的句子里').toEqual([]);
  });

  it('这一条守卫自身有效（不语境就出声，带语境就放过）', () => {
    expect(legacyWithoutContext('多档反应可以用 如果 开头，逐档写下来。')).not.toEqual([]);
    expect(legacyWithoutContext('条件挂在台词上就写 分支： 再缩进。')).not.toEqual([]);
    expect(legacyWithoutContext('如果 / 否则 已退场：写 `?` 条件链（§5.3）。')).toEqual([]);
  });

  it('不提已封存的三件（语法糖视图 / 糖预览面板 / 归档浏览器）', () => {
    for (const sealed of ['语法糖视图', '糖预览面板', '归档浏览器', '糖视图', '糖预览']) {
      expect(prose, `教程里出现了已封存功能：${sealed}`).not.toContain(sealed);
    }
  });

  it('内部术语不进作者面正文（内核 / 插件 / 契约 / adapter / AST / 码原文）', () => {
    for (const internal of ['内核', '插件', '契约', 'adapter', 'Adapter', 'AST', 'lowering', 'core/']) {
      expect(prose, `作者面正文出现了内部术语：${internal}`).not.toContain(internal);
    }
  });

  it('表格每行长度与列名一致（渲染前提）', () => {
    for (const table of KOJO2_TUTORIAL.sections.flatMap((s) => s.tables ?? [])) {
      expect(table.columns.length).toBeGreaterThan(1);
      for (const row of table.rows) expect(row.length, table.columns.join(' | ')).toBe(table.columns.length);
    }
  });
});
