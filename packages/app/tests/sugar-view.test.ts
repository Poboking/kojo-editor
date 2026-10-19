/**
 * 预览（.kojo 预览）宿主侧纯逻辑单测（2026-10-12 语法糖批；2026-10-14 改为「整份糖文本写进内存 model」）。
 *
 * 钉死的是"读者视角"的几件事：
 * - **默认关**：作者打开一份文件，默认看到的正是盘上那份内容；要不要投影成 .kojo 写法由他点头
 *   （发现路径 = 首次打开游戏目录 ERB 时的那一次询问）；
 * - **偏好记住**：开过一次就一直开着、关掉就一直关着（否则每次重开都要重来）；
 * - **整份拼装口径**：`composeSugarDoc` 把糖段拼进原文——被覆盖的行换成糖文本、未覆盖的行
 *   原样留，这是"糖文本写进编辑器本身"的核心算术。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  SUGAR_TOGGLE_TITLE_EMPTY,
  SUGAR_TOGGLE_TITLE_OFF,
  SUGAR_TOGGLE_TITLE_ON,
  SUGAR_VIEW_DEFAULT,
  composeSugarDoc,
  loadSugarViewPref,
  saveSugarViewPref,
  sourceLineToSugar,
  sugarLineToSource,
  sugarSummary,
  sugarToggleTitle,
  sugarViewAllowed,
  trimSegmentBlanks,
  trimSegmentBlanksWithMap,
} from '../src/ui/sugar-view';

/** 假 localStorage：只是键值袋，够测"记忆"这一件事 */
function fakeWindow(seed: Record<string, string> = {}) {
  const bag = new Map(Object.entries(seed));
  return {
    localStorage: {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
      clear: () => bag.clear(),
      key: () => null,
      length: 0,
    },
    bag,
  };
}

const w = globalThis as unknown as { window?: unknown };
afterEach(() => {
  delete w.window;
});

describe('糖视图 / 偏好', () => {
  it('无 window（测试环境 / 非浏览器）→ 回默认（且不抛）', () => {
    expect(loadSugarViewPref()).toBe(SUGAR_VIEW_DEFAULT);
    expect(SUGAR_VIEW_DEFAULT).toBe(false);
    expect(() => saveSugarViewPref(true)).not.toThrow();
  });

  it('首次（无记录）→ 默认关；写过之后按记录走', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadSugarViewPref()).toBe(false);

    saveSugarViewPref(true);
    expect(f.bag.get('kojo.ui.sugarView.v1')).toBe('1');
    expect(loadSugarViewPref()).toBe(true);

    saveSugarViewPref(false);
    expect(loadSugarViewPref()).toBe(false);
  });

  it('localStorage 抛错（隐私模式 / 配额满）→ 降级为默认值，不让编辑器崩', () => {
    w.window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    expect(loadSugarViewPref()).toBe(SUGAR_VIEW_DEFAULT);
    expect(() => saveSugarViewPref(false)).not.toThrow();
  });
});

describe('.kojo 预览 / 摘要文案', () => {
  it('只报已覆盖的行数（未覆盖含注释与空行，加总会误导）', () => {
    expect(sugarSummary(123)).toBe('.kojo 显示 123 行');
    expect(sugarSummary(0)).toBe('.kojo 显示 0 行');
  });

  it('面向作者的读数不含实现术语（用户反馈 5：别拿内部说法当文案）', () => {
    // 「映射 / 投影 / 降级 / 覆盖」是糖投影器的词表，口上作者没有一个会说。
    for (const jargon of ['映射', '投影', '降级', '覆盖']) {
      expect(sugarSummary(312)).not.toContain(jargon);
    }
  });
});

/**
 * 糖视图可用门（ADR-0005：目录分野 × 显式解锁）。
 *
 * 这条门是两组**合流点**：口上项目组把"游戏目录 ERB 只读 / 工作区 ERB 恒可编辑"
 * 落成了轴一，本线把"解锁弹窗"落成轴二，ADR 定的是"糖视图与可编辑态互斥"。
 * 钉死它，是为了防止后来者把糖视图重新做成"任何 ERB 都能开"——那会让用户
 * 在**看不见原文**的情况下编辑自己的工作区文件。
 *
 * 2026-10-14：预览交付为常态功能，**封存总闸（`sealed.ts`）退出这道门**——
 * 输入里没有 `sealed` 这一项，总闸此后只 govern 两只面板（见 sealed.test.ts）。
 */
describe('sugarViewAllowed（.kojo 预览可用门 = 不可编辑态的派生）', () => {
  it('游戏目录 ERB、未解锁 → 唯一放行的组合', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: false })).toBe(true);
  });

  it('.kojo 不开预览（本身就是 .kojo，再投影一遍没有意义）', () => {
    expect(sugarViewAllowed({ isErbLike: false, inWorkspace: false, unlocked: false })).toBe(false);
  });

  it('工作区 ERB 不开 .kojo 预览（轴一：恒可编辑 ⟹ 原文必须看得见）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: false })).toBe(false);
    // 解锁态不影响结论（工作区根本走不到解锁这条路）
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: true })).toBe(false);
  });

  it('游戏目录 ERB 一旦解锁 → 该份 .kojo 预览禁用（轴二与互斥规则一致）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: true })).toBe(false);
  });

  it('封存总闸**不再是否决轴**：面板封存中（SEALED_DEFAULT=true）游戏目录 ERB 照样放行', () => {
    // 正向自证：输入里塞一个 `sealed: true` 也毫无作用——这道门已经不认这一项。
    // （用变量传参而不是对象字面量：字面量会因"多余属性"被类型检查拦下，那正是我们要的
    //  结构性证据——参数表里根本没有 sealed，但运行期不许被一个遗留字段否决。）
    const withStaleSealedFlag = { isErbLike: true, inWorkspace: false, unlocked: false, sealed: true };
    expect(sugarViewAllowed(withStaleSealedFlag)).toBe(true);
    // 反向自证：同一份输入把 unlocked 翻成 true 就应当关门（说明上面那条通过不是"恒真"）
    expect(sugarViewAllowed({ ...withStaleSealedFlag, unlocked: true })).toBe(false);
  });
});

/* ============ 糖段首尾空行（2026-10-13 目视体检：糖块开头一大块空白） ============ */

/**
 * 投影按原文行逐行映射，段首常带空行；拼进整份糖文本就是"这块糖没内容"的错觉。
 * 这里钉的是**只剪首尾、段内空行一根不动**——段内空行是分节，删了等于把剧本排成一行。
 */
describe('trimSegmentBlanks · 只剪段首尾，段内分节不许动', () => {
  it('段首两个空行剪掉，正文与段内空行原样保留', () => {
    const out = trimSegmentBlanks(['', '', '她说「甲」', '', '她说「乙」'].join('\n'));
    expect(out.split('\n')).toEqual(['她说「甲」', '', '她说「乙」']);
  });

  it('段尾空行（含只有空格的行）也剪', () => {
    expect(trimSegmentBlanks('PRINT A\n\n   \n').split('\n')).toEqual(['PRINT A']);
  });

  it('没有空行的段逐字不变（不制造第二次差异）', () => {
    const t = '如果 恋慕：\n  她说「甲」';
    expect(trimSegmentBlanks(t)).toBe(t);
  });

  it('整段皆空 ⇒ 原样返回（剪成零行会让糖段错位、与原文对不上）', () => {
    const t = '\n  \n';
    expect(trimSegmentBlanks(t)).toBe(t);
  });
});

/* ============ 整份糖文本拼装（composeSugarDoc） ============ */

/**
 * 「糖文本写进编辑器本身」的核心算术：逐行 1..N 走，落在某糖段区间内的行换成该段的糖文本
 * （按 `\n` 拆多行一并输出），其余行原样留。这里钉的是 segment 作为**外部数据**的健壮性：
 * 乱序 / 越界 / 反向 / 重叠都不能让拼装崩，也不能重复铺内容。
 */
describe('composeSugarDoc · 把糖段拼进整份原文', () => {
  it('空 segments ⇒ 原文逐行原样拼接（无糖可铺）', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], []).text).toBe('a\nb\nc');
  });

  it('空原文（N=0）⇒ 空串；越界糖段被丢弃（不凭空产出）', () => {
    expect(composeSugarDoc([], []).text).toBe('');
    expect(composeSugarDoc([], [{ fromLine: 1, toLine: 1, sugarText: 'X' }]).text).toBe('');
  });

  it('全被覆盖（单段覆盖整份）⇒ 只输出糖文本', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 1, toLine: 2, sugarText: '糖' }]).text).toBe('糖');
  });

  it('部分覆盖 + 前后留原文：被覆盖区间换成糖，其余行原位保留', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    expect(composeSugarDoc(lines, [{ fromLine: 2, toLine: 3, sugarText: 'X\nY' }]).text).toBe('a\nX\nY\nd\ne');
  });

  it('段行数 ≠ 原文行数：单行原文可换成多行糖（整段透传，不按行对齐）', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 2, toLine: 2, sugarText: 'X\nY\nZ' }]).text).toBe('a\nX\nY\nZ');
  });

  it('首段（fromLine=1）正确落位', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 1, toLine: 1, sugarText: 'S' }]).text).toBe('S\nb\nc');
  });

  it('尾段（toLine=N）正确落位', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 3, toLine: 3, sugarText: 'S' }]).text).toBe('a\nb\nS');
  });

  it('多段混合（不相邻）各自独立落位', () => {
    const lines = ['1', '2', '3', '4', '5', '6'];
    const segs = [
      { fromLine: 1, toLine: 1, sugarText: 'A' },
      { fromLine: 4, toLine: 4, sugarText: 'D' },
    ];
    expect(composeSugarDoc(lines, segs).text).toBe('A\n2\n3\nD\n5\n6');
  });

  it('乱序段先按 fromLine 升序再落位（输入顺序不影响结果）', () => {
    const lines = ['1', '2', '3', '4', '5'];
    const segs = [
      { fromLine: 4, toLine: 4, sugarText: 'D' },
      { fromLine: 1, toLine: 1, sugarText: 'A' },
    ];
    expect(composeSugarDoc(lines, segs).text).toBe('A\n2\n3\nD\n5');
  });

  it('重叠段先到者优先：被前段覆盖到的后到段整段丢弃（不重复铺）', () => {
    const lines = ['1', '2', '3', '4', '5'];
    const segs = [
      { fromLine: 1, toLine: 3, sugarText: 'X' },
      { fromLine: 2, toLine: 4, sugarText: 'Y' },
    ];
    expect(composeSugarDoc(lines, segs).text).toBe('X\n4\n5');
  });

  it('fromLine > toLine（反向区间）⇒ 丢弃，不动原文', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 2, toLine: 1, sugarText: 'X' }]).text).toBe('a\nb');
  });

  it('完全越界（整段落在 [1,N] 外）⇒ 丢弃，不动原文', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 5, toLine: 6, sugarText: 'X' }]).text).toBe('a\nb');
  });

  it('部分越界 ⇒ 夹取到 [1,N]（fromLine 0 → 1；toLine 超 N → N）', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 0, toLine: 2, sugarText: 'X' }]).text).toBe('X\nc');
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 2, toLine: 99, sugarText: 'Y' }]).text).toBe('a\nY');
  });

  it('单行原文（N=1）覆盖正常', () => {
    expect(composeSugarDoc(['only'], [{ fromLine: 1, toLine: 1, sugarText: 'S' }]).text).toBe('S');
  });

  it('糖段内空行原样输出（本函数不做首尾修剪，那是 trimSegmentBlanks 的职责）', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 2, toLine: 2, sugarText: '\nX\n' }]).text).toBe('a\n\nX\n\nc');
  });
});

/* ============ 预览行 ↔ 源行（lineMap 与两条反查） ============ */

/**
 * 预览面上的定位只有靠这张表才回得到源文件：糖段是 N 源行 ⇄ M 糖行，第一段多行糖一出现，
 * 预览行号就与源行号分叉。这里钉的是**分叉之后仍然对得回**，以及外部数据算不准时的退化方向。
 */
describe('composeSugarDoc · lineMap 预览行 → 源行', () => {
  it('无段（全文透传）⇒ 第 i 行就是源第 i 行', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], []).lineMap).toEqual([1, 2, 3]);
  });

  it('段前 / 段后 / 段内逐行都对得上（透传行不被段的偏移带跑）', () => {
    const got = composeSugarDoc(['a', 'b', 'c', 'd', 'e'], [{ fromLine: 2, toLine: 3, sugarText: 'X\nY' }]);
    expect(got.lineMap).toEqual([1, 2, 3, 4, 5]);
  });

  it('一行源 → 三行糖：sourceLines 给了就照它，三行各指哪一源行由投影方说了算', () => {
    const got = composeSugarDoc(['a', 'b'], [
      { fromLine: 2, toLine: 2, sugarText: 'X\nY\nZ', sourceLines: [2, 2, 2] },
    ]);
    expect(got.lineMap).toEqual([1, 2, 2, 2]);
  });

  it('缺 sourceLines ⇒ 退化到 min(fromLine+k, toLine)（宁可指回段首，不给不存在的行号）', () => {
    const got = composeSugarDoc(['a', 'b'], [{ fromLine: 2, toLine: 2, sugarText: 'X\nY\nZ' }]);
    expect(got.lineMap).toEqual([1, 2, 2, 2]);
  });

  it('sourceLines 长度与糖行数不等 ⇒ 整段按缺省处理（外部数据不许假定算准了）', () => {
    const got = composeSugarDoc(['a', 'b', 'c'], [
      { fromLine: 2, toLine: 2, sugarText: 'X\nY', sourceLines: [2] },
    ]);
    expect(got.lineMap).toEqual([1, 2, 2, 3]);
  });

  it('N 源行折成 1 糖行：映射表只有段首那一行，映射长度跟着糖走', () => {
    const got = composeSugarDoc(['1', '2', '3', '4'], [
      { fromLine: 1, toLine: 3, sugarText: '合并', sourceLines: [1] },
    ]);
    expect(got.text).toBe('合并\n4');
    expect(got.lineMap).toEqual([1, 4]);
  });
});

describe('sugarLineToSource / sourceLineToSugar · 两条反查', () => {
  const map = [1, 2, 2, 2, 5]; // 预览 2..4 行都来自源第 2 行

  it('预览 → 源：越界与 0（无源行）都判 null', () => {
    expect(sugarLineToSource(map, 1)).toBe(1);
    expect(sugarLineToSource(map, 5)).toBe(5);
    expect(sugarLineToSource(map, 6)).toBeNull();
    expect(sugarLineToSource([0], 1)).toBeNull();
    expect(sugarLineToSource(map, 0)).toBeNull();
  });

  it('源 → 预览：命中多行时取**第一行**（跳到这段糖的开头）', () => {
    expect(sourceLineToSugar(map, 2)).toBe(2);
  });

  it('源行被折进糖里没有独立成行 ⇒ 退化成它前面最近的那一行（停在包住它的那段糖上）', () => {
    expect(sourceLineToSugar([1, 1, 1, 4], 2)).toBe(3);
    expect(sourceLineToSugar([1, 1, 1, 4], 3)).toBe(3);
  });

  it('退化也有底线：源行早于表里第一行、或表空 ⇒ null（不猜、不滚到第一行）', () => {
    expect(sourceLineToSugar([5, 6], 2)).toBeNull();
    expect(sourceLineToSugar([], 1)).toBeNull();
    expect(sourceLineToSugar(map, 0)).toBeNull();
  });
});

describe('trimSegmentBlanksWithMap · 剪行与剪映射必须同一次', () => {
  it('段首两个空行剪掉，映射跟着剪掉同两行（错位是静默的，必须成对）', () => {
    const got = trimSegmentBlanksWithMap('\n\n她说「甲」\n\n她说「乙」', [7, 8, 9, 10, 11]);
    expect(got.sugarText.split('\n')).toEqual(['她说「甲」', '', '她说「乙」']);
    expect(got.sourceLines).toEqual([9, 10, 11]);
  });

  it('段尾空行（含只有空格的行）也成对剪', () => {
    const got = trimSegmentBlanksWithMap('PRINT A\n\n   \n', [3, 4, 5, 6]);
    expect(got.sugarText).toBe('PRINT A');
    expect(got.sourceLines).toEqual([3]);
  });

  it('没有映射 / 映射长度对不上 ⇒ 退化成 trimSegmentBlanks 的结果且不产出映射', () => {
    expect(trimSegmentBlanksWithMap('\nA\n', undefined)).toEqual({ sugarText: 'A' });
    expect(trimSegmentBlanksWithMap('\nA\n', [1])).toEqual({ sugarText: 'A' });
  });

  it('整段皆空 ⇒ 原样返回（剪成零行会让糖段与原文彻底对不上）', () => {
    const got = trimSegmentBlanksWithMap('\n  \n', [1, 2, 3]);
    expect(got.sugarText).toBe('\n  \n');
    expect(got.sourceLines).toEqual([1, 2, 3]);
  });
});

/* ===================== 那颗「.kojo 预览」开关的悬停文案（NATIVE-UX 2026-10-20） ===================== */

/**
 * 取证在前（`ui-sugar-lift/tests/integration.test.ts` 第三组）：`langDoc: native` 起手包的
 * 8 份 `.ERB` **每份都投出零段**，宿主那一拍（`EditorPane` 的 `applySugarView`）拿到零段就
 * return，糖 model 不挂、屏幕上就是原文。改前那颗开关只要偏好是开着的就说
 * 「已开启：当前显示的是 .kojo 写法」——那是**假话**，且是原生起手作者 100% 撞上的第一寸体验债。
 *
 * 修法只动**既有那一格**的文案（不新开 toast / 徽章 / 状态栏 / 面板，不加契约字段）。
 */
describe('糖视图 / 开关悬停的三档（第一眼必须是人话，原始读数逐字进悬停）', () => {
  it('关着：与改前那句逐字相同（纯 Promise，既有观感零改动）', () => {
    expect(sugarToggleTitle({ on: false, segments: null })).toBe(
      '把这份文件显示成 .kojo 写法——台词读起来像剧本、条件变成「如果 …：」。只改显示，不改动文件。',
    );
    expect(SUGAR_TOGGLE_TITLE_OFF).toBe(sugarToggleTitle({ on: false, segments: 0 }));
    // 开关关着时零段读数不许抢话（还没发生任何事）
    expect(sugarToggleTitle({ on: false, segments: 0 })).toBe(sugarToggleTitle({ on: false, segments: null }));
  });

  it('开着且真投出东西：与改前那句逐字相同', () => {
    expect(sugarToggleTitle({ on: true, segments: 17623 })).toBe(
      '已开启：当前显示的是 .kojo 写法。点击切回原生代码（这是显示偏好，文件内容一字未动）。',
    );
    expect(sugarToggleTitle({ on: true, segments: 3 })).toBe(SUGAR_TOGGLE_TITLE_ON);
    // 还没算过（点击那一拍到落算之间）⇒ 保持改前那句，不另造第四档
    expect(sugarToggleTitle({ on: true, segments: null })).toBe(SUGAR_TOGGLE_TITLE_ON);
  });

  it('开着但这份文件零段：不许再说"当前显示的是 .kojo 写法"，要说屏幕上就是原文', () => {
    const copy = sugarToggleTitle({ on: true, segments: 0 });
    expect(copy).toBe(SUGAR_TOGGLE_TITLE_EMPTY);
    expect(copy).not.toContain('当前显示的是');
    expect(copy).toContain('屏幕上仍是原文');
    expect(copy).toContain('文件内容一字未动');
    expect(copy).toContain('0'); // 原始读数逐字进悬停（宿主真实持有的那一件：投影段数 0）
  });

  it('三档互不相同（防空判据：恒返回一句就等于没有这一格）', () => {
    const three = new Set([
      sugarToggleTitle({ on: false, segments: null }),
      sugarToggleTitle({ on: true, segments: 5 }),
      sugarToggleTitle({ on: true, segments: 0 }),
    ]);
    expect(three.size).toBe(3);
    for (const s of three) expect(s.length).toBeGreaterThan(10);
  });
});
