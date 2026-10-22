/**
 * 内置教程内容与接线单测（E6；E10 补「样例溯源守卫」；E12 守卫来源扩到三份 fixture；
 * 2026-10-21 Kojo 2.0 现实批补「档位口径逐字 + 2.0 定位在场 + 事件名对现行目录」三条）。
 *
 * 教程是"会过期的代码"：这里钉的是**结构性底线**（节数、标题唯一、段落/样例非空、
 * 样例不出现 `undefined` 这类拼装泄漏），三条必须成立的内容事实——
 * 语法糖教程的样例量与覆盖面（含选项块、中文运算符、指令中文名查表、自定指令）、
 * 口上教程的「两真相源」句（工作区 / 游戏目录）、以及**已封存功能一律不提**——
 * 以及**样例溯源守卫**：两个教程里的代码样例逐字取自 fixtures（只许截取、不许改写）。
 * 文风（傲娇大小姐口吻、句子长短）不靠断言，靠内容模块头注里的口径纪律。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOJO_TUTORIAL, SUGAR_TUTORIAL, TUTORIALS, type Tutorial } from '../src/tutorial-content';
import { KOJO2_TUTORIAL } from '../src/tutorial-content-kojo2';
import { ERATW_EVENT_NAMES } from '../src/kojo2/event-catalog';
import {
  KOJO2_TUTORIAL_OVERLAY_ID,
  KOJO_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
  createTutorialOverlay,
  splitHeadingMarker,
} from '../src/tutorial-overlay';

/** 一份教程的全部**叙述**文本（标题、导语、节标题、段落、样例说明；不含代码样例） */
function tutorialText(t: Tutorial): string {
  return [
    t.title,
    t.lead,
    ...t.sections.flatMap((s) => [
      s.heading,
      ...s.paragraphs,
      ...(s.samples ?? []).map((sample) => sample.caption ?? ''),
    ]),
  ].join('\n');
}

describe('教程内容（E6）', () => {
  it('四本教程 id / title 正确，且 TUTORIALS 索引与单例一致', () => {
    expect(TUTORIALS.sugar).toBe(SUGAR_TUTORIAL);
    expect(TUTORIALS.kojo).toBe(KOJO_TUTORIAL);
    expect(TUTORIALS.kojo2).toBe(KOJO2_TUTORIAL);
    expect(SUGAR_TUTORIAL.id).toBe('sugar');
    expect(KOJO_TUTORIAL.id).toBe('kojo');
    expect(KOJO2_TUTORIAL.id).toBe('kojo2');
    expect(SUGAR_TUTORIAL.title).toBe('.kojo 语言教程');
    expect(KOJO_TUTORIAL.title).toBe('口上教程');
    expect(KOJO2_TUTORIAL.title).toBe('Kojo 2.0 语言教程');
    expect(SUGAR_TUTORIAL.lead.length).toBeGreaterThan(0);
    expect(KOJO_TUTORIAL.lead.length).toBeGreaterThan(0);
    expect(KOJO2_TUTORIAL.lead.length).toBeGreaterThan(0);
  });

  /**
   * 词表登记闸（2.0 接线批）：`TUTORIALS` 的键必须与 `TutorialId` 词表**一一对应**——
   * 少一本就是某路入口点了拿不到正文（静默），多一本就是 `Record<TutorialId, Tutorial>` 编译不过。
   * 顺带钉住"旧两本提到的 2.0 教程名 = 真源 title 字面"，指路句与接线名不许各写一份。
   */
  it('TUTORIALS 键表恰好四本，且指路句里的 2.0 教程名就是正源 title', () => {
    expect(Object.keys(TUTORIALS).sort()).toEqual(['kojo', 'kojo2', 'reference', 'sugar']);
    for (const t of [SUGAR_TUTORIAL, KOJO_TUTORIAL]) {
      expect(tutorialText(t), `${t.title} 的 2.0 指路名与正源 title 不一致`).toContain(KOJO2_TUTORIAL.title);
    }
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL, KOJO2_TUTORIAL])('$title：节数 ≥ 6，标题非空且互不重复', (t) => {
    expect(t.sections.length).toBeGreaterThanOrEqual(6);
    const headings = t.sections.map((s) => s.heading);
    for (const h of headings) expect(h.trim().length).toBeGreaterThan(0);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL, KOJO2_TUTORIAL])('$title：每节段落非空、样例给定字段合法', (t) => {
    for (const s of t.sections) {
      expect(s.paragraphs.length).toBeGreaterThan(0);
      for (const p of s.paragraphs) expect(p.trim().length).toBeGreaterThan(0);
      for (const sample of s.samples ?? []) {
        expect(sample.kojo.trim().length).toBeGreaterThan(0);
        expect(sample.kojo).not.toContain('undefined');
        if (sample.erb !== undefined) {
          expect(sample.erb.trim().length).toBeGreaterThan(0);
          expect(sample.erb).not.toContain('undefined');
        }
      }
      // 对照表的渲染前提：行长必须等于列数（2.0 那本的⑬就靠这张表）
      for (const table of s.tables ?? []) {
        for (const row of table.rows) expect(row.length, `${t.title} / ${s.heading}`).toBe(table.columns.length);
      }
    }
  });

  it('.kojo 语言教程：样例 ≥ 24（每种写法都要有对照实例；E12 覆盖面重校后的底线）', () => {
    const samples = SUGAR_TUTORIAL.sections.flatMap((s) => s.samples ?? []);
    expect(samples.length).toBeGreaterThanOrEqual(24);
    for (const sample of samples) expect(sample.kojo.trim().length).toBeGreaterThan(0);
  });

  /**
   * 覆盖面底线（E12）：教程声称"每种写法都摊开"，那这几样现行实现里的写法就必须在场。
   * 钉**出现**而不是钉表述——表述归文风纪律管，漏了某项能力才是这里要抓的。
   */
  it('.kojo 语言教程覆盖现行实现的全部写法面（含 HK-11 查表与 HK-12 五钩子）', () => {
    const text = tutorialText(SUGAR_TUTORIAL);
    for (const surface of [
      '选项', // §3.7 选项块
      '自定指令', // HK-12 五钩子
      '可否使用', // HK-12 可选钩子
      'Train.csv', // HK-11② 指令中文名查表（数据源口径）
      '至少', // §4.3 中文运算符
      '隐藏情景', // §3.2 时机内子句
      '别名', // §3.1 / §3.8
      '空行', // §3.3 v1.4
      '分支', // §3.11 规则池（条件即注解）
      '[其他]', // §3.11 兜底分支
    ]) {
      expect(text, `.kojo 语言教程漏了写法面：${surface}`).toContain(surface);
    }
  });

  /**
   * Kojo 2.0 现实口径（2026-10-21 现实批）——这里钉的全是**必须逐字在场**，一条没放宽。
   *
   * ① 口上教程里那段档位说明与其余 lane 用的是**同一段字面**：三份教程各写各的"怎么切档"
   *    是最难查的漂移（读者会在两本里读到两种操作），所以整段按字符串钉死；
   * ② 两份教程都得把读者指到「Kojo 2.0 语言教程」，并说清自己教的是 v1——只有一份教程
   *    承认 2.0 存在，另一本就会把人留在旧写法里还以为学全了；
   * ③ 指路句里的教程名一律用**现行 title 字面**（`.kojo 语言教程` 由常量给，不许另抄）。
   */
  it('两份教程都交代 2.0 定位，且档位口径逐字统一', () => {
    const tierText =
      '今天默认档位是「只认 v1」：新装的编辑器打开 `.kojo` 走的还是老写法。要看这份教程里的 2.0 写法，去设置页把「Kojo 2.0 档位」切到「双轨」（老 `.kojo` 一字不动，新 `.kojo2` 走 2.0）或「2.0 默认」；切档后需要重载一次窗口，语言面与配色才全部换过来（编辑器会提示，不会静默）。';
    expect(tutorialText(KOJO_TUTORIAL), '口上教程缺档位口径（或被人改写了字面）').toContain(tierText);
    for (const t of [SUGAR_TUTORIAL, KOJO_TUTORIAL]) {
      const text = tutorialText(t);
      expect(text, `${t.title} 没指向「Kojo 2.0 语言教程」`).toContain('Kojo 2.0 语言教程');
      expect(text, `${t.title} 没交代自己讲的是 v1 / 两门分开`).toContain('v1');
      expect(text, `${t.title} 的指路句没用 .kojo 教程的现行标题`).toContain(SUGAR_TUTORIAL.title);
    }
  });

  /**
   * 2.0 的事件口径按**现行实现**列（不是按设计稿的记忆）：口上教程⑧那九条事件名必须与
   * eraTW 事件目录逐字相等、一条不缺——面名与事件名混讲是这批最容易复发的失真。
   */
  it('口上教程列出的 2.0 事件名与 eraTW 事件目录逐字一致', () => {
    const text = tutorialText(KOJO_TUTORIAL);
    for (const name of ERATW_EVENT_NAMES) {
      expect(text, `口上教程漏了 2.0 事件：${name}`).toContain(`\`${name}\``);
    }
  });

  /**
   * 两门语言的标点口径不许混在一句里：v1 的块头以全角冒号结尾是**对的**，2.0 的声明标题
   * 不写冒号也是**对的**（设计稿 §4.13），所以钉的是"两句都在场且各自归属清楚"。
   */
  it('口上教程⑦按语言分开写标点口径（v1 块头带冒号 / 2.0 声明不写冒号）', () => {
    const s7 = KOJO_TUTORIAL.sections.find((s) => s.heading.startsWith('⑦'));
    const text = s7 ? [s7.heading, ...s7.paragraphs].join('\n') : '';
    expect(text, '⑦ 节不见了').not.toBe('');
    expect(text).toContain('以全角冒号结尾');
    expect(text).toContain('声明标题不写冒号');
    expect(text).toContain('# 机');
  });

  /**
   * 已封存的三件不许出现在教程里（用户 2026-10-13 令：只留设置页一个总开关）。
   * 教程是给零基础作者的第一个信息源，提一件"其实看不见"的功能等于埋一个坑。
   * 2.0 接线批起，`kojo2` 那本同判（三本散文共一条底线）。
   */
  it('三本教程都不提已封存的三件（.kojo 预览 / .kojo 转译检查 / 归档浏览器）', () => {
    const all =
      tutorialText(SUGAR_TUTORIAL) + tutorialText(KOJO_TUTORIAL) + tutorialText(KOJO2_TUTORIAL);
    for (const sealed of ['.kojo 预览', '.kojo 转译检查', '归档浏览器', '糖视图', '语法糖视图', '糖预览']) {
      expect(all, `教程里出现了已封存功能：${sealed}`).not.toContain(sealed);
    }
  });

  it('口上教程：至少一节同时讲「工作区」与「游戏目录」（两真相源句）', () => {
    const hit = KOJO_TUTORIAL.sections.some((s) => {
      const text = [s.heading, ...s.paragraphs].join('\n');
      return text.includes('工作区') && text.includes('游戏目录');
    });
    expect(hit).toBe(true);
  });
});

/**
 * 教程样例的**溯源守卫**（E10；E12 来源扩到三份 fixture）。
 *
 * 纪律：两个教程里的代码样例逐字取自 fixtures，只允许截取、不允许改写。允许的出处
 * 就是仓库里那几份有转译验证的样例文件：
 * - `.kojo` 侧：`teaching-full.kojo`（露米娅 12 号 · 教学）、`release-check.kojo`
 *   （145 号 · 全语法面长跑）、`sample-310.kojo`（规范 §6.1 形态）；
 * - `.ERB` 侧：前两份的 `.expected.erb`（`sample-310` 没有 golden，所以它的行只许
 *   出现在源文一侧）。
 * 这里用最朴素的方式守住它：把样例按行拆开，每行去掉行首空白后，检查它在上面任意一份
 * 出处里出现过。
 *
 * 这是**宽松**守卫，宽松之处都是故意的：
 * - 只查"这一行存在"，不查"来自哪一段、哪一份"——允许把不同位置的整行拼成一个样例
 *   （教程需要把"文件头"和"某一块"放在一起讲，也需要把两份样例的同一面并排给看）；
 * - 行首空白一律忽略——截取时会剥掉整块缩进（tab 与 4 空格互换不算漂移）。
 * 它的目的不是证明内容正确，而是抓"日后有人手滑改了样例里的一个字"。
 *
 * **`kojo2` 不并进来，不是放宽**：这批出处全是 `.kojo`（v1）语料，2.0 的样张一枚都不该
 * 从里面截；它的同源守卫（十一份 `.kojo2` 夹具 + "零 erb 样张"）在
 * `tests/tutorial-content-kojo2.test.ts`，两处合起来才是四本全覆盖。
 */
const sugarFixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/sugar/${name}`, import.meta.url));

/** `.kojo` 侧允许的全部出处 */
const KOJO_FIXTURE_PATHS = ['teaching-full.kojo', 'release-check.kojo', 'sample-310.kojo'].map(sugarFixture);
/** `.ERB` 侧允许的全部出处（只含有 golden 的那两份） */
const ERB_FIXTURE_PATHS = ['teaching-full.expected.erb', 'release-check.expected.erb'].map(sugarFixture);

/** 读若干份样例并按行归一后并成一集：去 BOM、统一换行、去行首空白、丢空行 */
function fixtureLineSet(paths: string[]): Set<string> {
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

/** 样例里所有"在 fixture 中找不到"的行（空数组 = 逐字对得上） */
function driftedLines(sample: string, allowed: Set<string>): string[] {
  return sample
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0 && !allowed.has(line));
}

describe('教程样例溯源守卫（E10 立、E12 扩来源，宽松口径）', () => {
  const kojoLines = fixtureLineSet(KOJO_FIXTURE_PATHS);
  const erbLines = fixtureLineSet(ERB_FIXTURE_PATHS);

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每条 kojo 样例行都能在允许的 .kojo 出处里逐字找到', (t) => {
    const drift: string[] = [];
    for (const s of t.sections) {
      for (const sample of s.samples ?? []) {
        for (const line of driftedLines(sample.kojo, kojoLines)) drift.push(`${s.heading} → ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每条 erb 样例行都能在 .ERB golden 里逐字找到', (t) => {
    const drift: string[] = [];
    for (const s of t.sections) {
      for (const sample of s.samples ?? []) {
        if (sample.erb === undefined) continue;
        for (const line of driftedLines(sample.erb, erbLines)) drift.push(`${s.heading} → ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('守卫自身是有效的（每个改字都能抓到，且有真实命中）', () => {
    // 正样本：样例里真实存在的行（含「去掉公共缩进」的写法）必须通过
    expect(driftedLines('    「……嗯？是谁？」', kojoLines)).toEqual([]);
    expect(driftedLines('「……嗯？是谁？」', kojoLines)).toEqual([]);
    // E12 新接进来的两份出处也必须真的被读进集合（不是"路径写了但没并进来"）
    expect(driftedLines('「要不要赛点钱？」', kojoLines)).toEqual([]); // release-check.kojo
    expect(driftedLines('自定指令 赛钱 可否使用: 她的好感度 至少 50 计数器不发: 她的好感度 至少 90：', kojoLines)).toEqual(
      [],
    ); // release-check.kojo
    expect(driftedLines('    {她的胆怯 ? "眼眶里浮起一点泪光。" : ""}', kojoLines)).toEqual([]); // sample-310.kojo
    expect(driftedLines('INPUTS', erbLines)).toEqual([]); // release-check.expected.erb
    expect(driftedLines('@KOJO_发版检查_COM_NAME_K145_270', erbLines)).toEqual([]); // 同上
    // 负样本：改一个字就必须被抓出，防止守卫退化成"永远通过"
    expect(driftedLines('    「……嗯？是谁！」', kojoLines)).not.toEqual([]);
    expect(driftedLines('PRINTFORMW 「……嗯？是谁！」', erbLines)).not.toEqual([]);
    expect(driftedLines('自定指令 赛钱 可否使用: 她的好感度 至少 51', kojoLines)).not.toEqual([]);
  });
});

describe('教程浮层接线（E6）', () => {
  it('overlay id 命名与既有向导对齐（eratw. 前缀 + 教程名）', () => {
    expect(SUGAR_TUTORIAL_OVERLAY_ID).toBe('eratw.tutorialSugar');
    expect(KOJO_TUTORIAL_OVERLAY_ID).toBe('eratw.tutorialKojo');
    expect(KOJO2_TUTORIAL_OVERLAY_ID).toBe('eratw.tutorialKojo2');
  });

  it('工厂产出宿主可渲染的组件（UIPanelComponent 形态）', () => {
    for (const tutorial of [SUGAR_TUTORIAL, KOJO_TUTORIAL, KOJO2_TUTORIAL]) {
      expect(typeof createTutorialOverlay({ tutorial, close: () => {} })).toBe('function');
    }
  });
});

/**
 * 极简元素树遍历：`createElement` 产物是 `{ props: { className, children, … } }` 的嵌套对象，
 * children 可能是数组。按 className 收集节点即可钉结构，不必引第三方渲染器。
 */
type Elt = { props?: Record<string, unknown> };
function collectNodes(node: unknown, className: string, out: Elt[] = []): Elt[] {
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, className, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const el = node as Elt;
    if (el.props?.className === className) out.push(el);
    const children = el.props?.children;
    if (children !== undefined) collectNodes(children, className, out);
  }
  return out;
}

/** 真正**调用**组件拿元素树（既有接线测试只验"工厂返回函数"，没调用过——这里补上，顺带抓渲染期抛错） */
const renderOverlay = (t: Tutorial): Elt =>
  (createTutorialOverlay({ tutorial: t, close: () => {} }) as () => Elt)();

/** 恰好一个某类节点：数量不对直接失败，返回的那个已定型（免得到处 `[0]` 再断言非空） */
function onlyNode(node: unknown, className: string, label: string): Elt {
  const found = collectNodes(node, className);
  expect(found, `${label} 应有且仅有一个 .${className}`).toHaveLength(1);
  const first = found[0];
  if (first === undefined) throw new Error(`${label} 缺 .${className}`);
  return first;
}

describe('节标题圈码记号拆分（splitHeadingMarker）', () => {
  it('拆出起首圈码 + 其余标题', () => {
    expect(splitHeadingMarker('① 先分清：你写的这份')).toEqual({ marker: '①', text: '先分清：你写的这份' });
    expect(splitHeadingMarker('⑲ 写错了怎么读')).toEqual({ marker: '⑲', text: '写错了怎么读' });
    expect(splitHeadingMarker('⑳ 边界')).toEqual({ marker: '⑳', text: '边界' });
  });
  it('无起首圈码（附录各节 / 空串）原样返回 marker:null', () => {
    expect(splitHeadingMarker('文件头键')).toEqual({ marker: null, text: '文件头键' });
    expect(splitHeadingMarker('')).toEqual({ marker: null, text: '' });
  });
  it('圈码不在起首就不算记号（只认开头）', () => {
    expect(splitHeadingMarker('看① 这个')).toEqual({ marker: null, text: '看① 这个' });
  });
  it('语法全表附录各节无圈码（拆分对它是恒等）', () => {
    for (const s of TUTORIALS.reference.sections) {
      expect(splitHeadingMarker(s.heading).marker, s.heading).toBeNull();
    }
  });

  it('2.0 那本各节一律以圈码起首（目录成列的版面前提）', () => {
    for (const s of KOJO2_TUTORIAL.sections) {
      expect(splitHeadingMarker(s.heading).marker, s.heading).not.toBeNull();
    }
  });
});

/** 脚部按钮的文字（`.ghost small` 那一组：去处按钮 + 「关闭」） */
function footerLabels(node: unknown): string[] {
  const flat = (n: unknown): string =>
    typeof n === 'string' ? n : Array.isArray(n) ? n.map(flat).join('') : '';
  return collectNodes(node, 'ghost small').map((el) => flat(el.props?.children));
}

describe('脚部「查语法全表」去处（2.0 接线批）', () => {
  /**
   * 按钮给不给，只由**调用方给不给 `openReference`** 决定；`tutorial.id !== 'reference'`
   * 是第二道锁（免得全表把自己再指回自己）。这一条对新 id 天然放行 ⇒ 2.0 那本的接线
   * 故意**不传**去处：全表收的是 `.kojo`（v1）写法，2.0 的读者点过去只会拿到对不上号
   * 的产物对照（2.0 那本自己的旧写法对照表在⑬的 tables 里）。
   */
  const build = (t: Tutorial, withReference: boolean): unknown =>
    (createTutorialOverlay({
      tutorial: t,
      close: () => {},
      ...(withReference ? { openReference: () => {} } : {}),
    }) as () => unknown)();

  it('v1 两本给去处；2.0 与全表不给（全表那枚由第二道锁兜住）', () => {
    expect(footerLabels(build(SUGAR_TUTORIAL, true))).toEqual(['查语法全表', '关闭']);
    expect(footerLabels(build(KOJO_TUTORIAL, true))).toEqual(['查语法全表', '关闭']);
    // 误传去处也不许给全表画按钮（单槽位里"打开自己"是空转）
    expect(footerLabels(build(TUTORIALS.reference, true))).toEqual(['关闭']);
    // 接线事实：2.0 那本的脚部只有「关闭」
    expect(footerLabels(build(KOJO2_TUTORIAL, false))).toEqual(['关闭']);
    expect(footerLabels(build(KOJO2_TUTORIAL, true))).toEqual(['查语法全表', '关闭']);
  });
});

describe('教程浮层结构（2026-10-17 文档式重排）', () => {
  const ALL = [SUGAR_TUTORIAL, KOJO_TUTORIAL, KOJO2_TUTORIAL, TUTORIALS.reference];

  it('根是 .wizard.tutorial，含抬头 / 两列主体 / 目录栏 / 正文列', () => {
    for (const t of ALL) {
      const tree = renderOverlay(t);
      expect(tree.props?.className, t.title).toBe('wizard tutorial');
      for (const cls of ['tutorial-head', 'tutorial-main', 'tutorial-toc', 'tutorial-body', 'tutorial-doc']) {
        expect(collectNodes(tree, cls).length, `${t.title} 缺 .${cls}`).toBeGreaterThan(0);
      }
    }
  });

  it('目录项数 = 节数、正文节数 = 节数（目录与正文一一对应）', () => {
    for (const t of ALL) {
      const tree = renderOverlay(t);
      expect(collectNodes(tree, 'tutorial-toc-item'), t.title).toHaveLength(t.sections.length);
      expect(collectNodes(tree, 'tutorial-section'), t.title).toHaveLength(t.sections.length);
    }
  });

  it('初始只有首项目录点亮 aria-current（其余交给 scroll-spy）', () => {
    const items = collectNodes(renderOverlay(SUGAR_TUTORIAL), 'tutorial-toc-item');
    const current = items.filter((n) => n.props?.['aria-current'] === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(items[0]);
  });

  it('每节带锚点 id（tu-<教程>-s<i>，跳转与 spy 都靠它）', () => {
    const sections = collectNodes(renderOverlay(SUGAR_TUTORIAL), 'tutorial-section');
    sections.forEach((sec, i) => {
      expect(sec.props?.id).toBe(`tu-sugar-s${i}`);
    });
  });

  /**
   * 2026-10-18 反馈 7 回归：目录栏与正文列是 `.tutorial-main` 下的**兄弟列**，被点的目录项
   * 向上 closest('.tutorial-body') 恒为 null（旧实现），点击目录永远不滚。这里用最小假 DOM
   * （只实现用到的成员）调用渲染树里真实的 onClick，钉住"经共同父容器找正文列"这条路。
   */
  it('点目录项经 .tutorial-main 找到兄弟正文列并滚到对应节（反馈 7 回归）', () => {
    const item = collectNodes(renderOverlay(SUGAR_TUTORIAL), 'tutorial-toc-item')[2];
    expect(item, '第 3 条目录项缺失').toBeDefined();
    const scrollTops: number[] = [];
    const focuses: unknown[] = [];
    const section = {
      getBoundingClientRect: () => ({ top: 420 }),
      focus: (opts: unknown) => focuses.push(opts),
    };
    const body = {
      scrollTop: 150,
      getBoundingClientRect: () => ({ top: 60 }),
      querySelector: (sel: string) => (sel === '#tu-sugar-s2' ? section : null),
      scrollTo: (init: { top: number }) => scrollTops.push(init.top),
    };
    const main = { querySelector: (sel: string) => (sel === '.tutorial-body' ? body : null) };
    // 真实 DOM 里目录项只可能命中 .tutorial-main；旧实现找 .tutorial-body 会拿到 null
    const dirItem = { closest: (sel: string) => (sel === '.tutorial-main' ? main : null) };
    (item?.props?.onClick as (e: unknown) => void)({ currentTarget: dirItem });
    expect(scrollTops).toEqual([150 + (420 - 60) - 10]);
    expect(focuses).toEqual([{ preventScroll: true }]);
  });

  /**
   * 2026-10-18 反馈 2 的隐蔽路径：spy 旧实现用 `scrollIntoView({block:'nearest'})` 把当前条目
   * 滚进目录视野，而它会连同**所有**可滚祖先一起滚——宿主一旦可滚就把抬头顶出视野。
   * 这里钉住"只按 offsetTop 滚目录列表自身"、并且折叠态（条目全隐藏）完全不滚。
   */
  it('scroll-spy 只滚目录列表自身、折叠态不滚（反馈 2 回归）', () => {
    const runSpy = (collapsed: boolean): number[] => {
      const scrolls: number[] = [];
      const list = {
        scrollTop: 0,
        // 折叠态列表 display:none ⇒ 真实 DOM 的 clientHeight 就是 0
        clientHeight: collapsed ? 0 : 100,
        scrollTo: (init: { top: number }) => scrolls.push(init.top),
      };
      const items = Array.from({ length: SUGAR_TUTORIAL.sections.length }, (_, i) => ({
        offsetTop: i * 60,
        offsetHeight: 28,
        setAttribute: () => {},
        removeAttribute: () => {},
        scrollIntoView: () => {
          throw new Error('目录滚动不得用 scrollIntoView（会顺带滚可滚祖先，顶掉抬头）');
        },
      }));
      const toc = {
        getAttribute: (name: string) =>
          name === 'data-collapsed' ? String(collapsed) : name === 'data-active' ? '0' : null,
        setAttribute: () => {},
        querySelectorAll: () => items,
        querySelector: (sel: string) => (sel === '.tutorial-toc-list' ? list : null),
      };
      const main = { querySelector: (sel: string) => (sel === '.tutorial-toc' ? toc : null) };
      const body = {
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 1000,
        getBoundingClientRect: () => ({ top: 0 }),
        closest: (sel: string) => (sel === '.tutorial-main' ? main : null),
        // 前 3 节已越过 SPY_TOP_OFFSET ⇒ 当前节 = 2；第 3 条在列表视口（0..100）之外
        querySelector: (sel: string) => {
          const m = /^#tu-sugar-s(\d+)$/u.exec(sel);
          return m ? { getBoundingClientRect: () => ({ top: Number(m[1]) < 3 ? 10 : 500 }) } : null;
        },
      };
      const onScroll = collectNodes(renderOverlay(SUGAR_TUTORIAL), 'tutorial-body')[0]?.props?.onScroll as
        | ((e: unknown) => void)
        | undefined;
      onScroll?.({ currentTarget: body });
      return scrolls;
    };
    // items[2] = 2*60..2*60+28，视口 0..100 ⇒ 滚到 148-100=48
    expect(runSpy(false)).toEqual([48]);
    expect(runSpy(true)).toEqual([]);
  });
});

describe('教程浮层抬头（反馈 2）', () => {
  it('抬头右侧有常驻「×」关闭按钮（aria-label / title = 关闭教程），点击即关', () => {
    let closed = 0;
    const tree = (createTutorialOverlay({ tutorial: SUGAR_TUTORIAL, close: () => (closed += 1) }) as () => Elt)();
    const closer = onlyNode(tree, 'tutorial-close', SUGAR_TUTORIAL.title);
    expect(closer.props?.['aria-label']).toBe('关闭教程');
    expect(closer.props?.title).toBe('关闭教程');
    (closer.props?.onClick as () => void)();
    expect(closed).toBe(1);
  });
});

describe('目录折叠（反馈 6）', () => {
  const ALL = [SUGAR_TUTORIAL, KOJO_TUTORIAL, KOJO2_TUTORIAL, TUTORIALS.reference];

  it('目录是「标题行 + 条目列表」两级，标题行保留原 .tutorial-toc-label 并带折叠按钮', () => {
    for (const t of ALL) {
      const tree = renderOverlay(t);
      const nav = onlyNode(tree, 'tutorial-toc', t.title);
      expect(nav.props?.['data-collapsed'], t.title).toBe('false');
      onlyNode(tree, 'tutorial-toc-head', t.title);
      onlyNode(tree, 'tutorial-toc-label', t.title);
      const list = onlyNode(tree, 'tutorial-toc-list', t.title);
      expect(list.props?.id, t.title).toBe(`tu-${t.id}-toc-list`);
      const toggle = onlyNode(tree, 'tutorial-toc-toggle', t.title);
      expect(toggle.props?.['aria-expanded'], t.title).toBe('true');
      expect(toggle.props?.['aria-controls'], t.title).toBe(`tu-${t.id}-toc-list`);
      expect(toggle.props?.['aria-label'], t.title).toBe('收起目录');
      expect(toggle.props?.title, t.title).toBe('收起目录');
    }
  });

  it('点折叠按钮只切 DOM 属性：nav data-collapsed + 按钮 aria-expanded / 名称（组件无 hook）', () => {
    const tree = renderOverlay(SUGAR_TUTORIAL);
    const toggle = onlyNode(tree, 'tutorial-toc-toggle', SUGAR_TUTORIAL.title);
    const navAttrs: Record<string, string> = { 'data-collapsed': 'false' };
    const btnAttrs: Record<string, string> = {
      'aria-expanded': 'true',
      'aria-label': '收起目录',
      title: '收起目录',
    };
    const nav = {
      getAttribute: (name: string) => navAttrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        navAttrs[name] = value;
      },
      // 展开时会把当前条目滚回目录列表视野；这里不提供列表 ⇒ 只验属性切换
      querySelector: () => null,
    };
    const btn = {
      closest: (sel: string) => (sel === '.tutorial-toc' ? nav : null),
      setAttribute: (name: string, value: string) => {
        btnAttrs[name] = value;
      },
    };
    const click = toggle.props?.onClick as (e: unknown) => void;

    click({ currentTarget: btn });
    expect(navAttrs['data-collapsed']).toBe('true');
    expect(btnAttrs['aria-expanded']).toBe('false');
    expect(btnAttrs['aria-label']).toBe('展开目录');
    expect(btnAttrs.title).toBe('展开目录');

    click({ currentTarget: btn });
    expect(navAttrs['data-collapsed']).toBe('false');
    expect(btnAttrs['aria-expanded']).toBe('true');
    expect(btnAttrs['aria-label']).toBe('收起目录');
    expect(btnAttrs.title).toBe('收起目录');
  });
});
