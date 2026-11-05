/**
 * W1 语言重构 · conformance 新旧**逐字对拍** + golden（`docs/KOJO-2.0-LANGUAGE-REDESIGN.md` §2 / §3.6）。
 *
 * 这一套钉三件事：
 *
 * 1. **同一套语义、两种表面**：`redesign-w1.kojo2` 只用 W1 新正典
 *    （方寸声明 / 冒号动作 / 若-否则 / 裸行旁白 / `※`），`redesign-w1-legacy.kojo2` 只用旧五锚点
 *    （`#` / `@` / `?` / `!` / `>`）。两者覆盖同一组构造：
 *    声明（幕/视角/挂/设/对照表/池/模/函/织）/ 叙事 / 条件 / 表 / 池 / 模 / 函 / 织 /
 *    着色 / 颜绘 / 随机 / 循环 / 重复 / 遍历 / 标跳 / 断续 / 原生。
 * 2. **真编译逐字相同**：两份源码各自走 `runLanguageSuite`（真 core + fixture adapter/backend），
 *    产物 artifact 与磁盘 golden **三方逐字节相同**——新写法没有把表面记号漏进表达式，
 *    也没有因为归一化丢语义（W1 §3.1 确定性解析 / §3.5 SourceMap / §3.6 编译语义）。
 * 3. **golden 不是"跑出来就是对的"**：golden 由**旧写法已验证产物**生成，同一测试再独立编译
 *    新写法比一次；同时把 78 行产物按构造**逐行归档**（{@link GOLDEN_ANATOMY}），
 *    行数/内容必须与 golden 完全一致——golden 被改坏时 anatomy 先红。
 *
 * 失败不洗白：把新 fixture 写坏（方寸声明缺收口 / 表体写错）时，套件必须 `differs`/`blocked`，
 * 不许因为"旧写法能跑"就记 pass（沿用 `language.test.ts` 的口径，这里再钉一次 W1 表面）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LanguageCase, LanguageIoPort, LanguageReport } from '../src/language.js';
import {
  LANGUAGE_FIXTURE_ADAPTER,
  LANGUAGE_FIXTURE_BACKEND,
  runLanguageSuite,
} from '../src/language.js';

/* ============================== 固定夹具 ============================== */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/language', import.meta.url));

const read: LanguageIoPort = { readText: (target): string => readFileSync(target, 'utf8') };

const FILE_NEW = 'redesign-w1';
const FILE_LEGACY = 'redesign-w1-legacy';

/** 新表面 fixture（W1 正典）；group 只用于报告归类，不参与判据 */
const NEW_CASE: LanguageCase = Object.freeze({
  id: 'redesign/w1-new-surface',
  group: 'program',
  file: FILE_NEW,
  expectation: 'golden',
  constructs: Object.freeze([
    '方寸声明',
    '冒号动作',
    '若/再若/否则',
    '裸行旁白',
    '※ 注释',
    '对照表',
    '池',
    '模',
    '函',
    '织',
    '着色',
    '颜绘',
    '随机',
    '循环',
    '重复',
    '遍历',
    '标/跳',
    '断/续',
    '演调用',
    '原生',
  ]),
  requires: Object.freeze([
    'presentation.heart',
    'presentation.color',
    'presentation.face',
    'presentation.random',
    'program.while',
    'program.repeat',
    'program.foreach',
    'program.goto',
    'priority:emuera-buckets',
  ] as const),
  note: 'W1 新正典完整示例：方寸声明 + 冒号动作 + 若-否则 + 裸行旁白',
});

/** 等价旧写法 fixture（旧五锚点）；与新表面 fixture 语义一一对应 */
const LEGACY_CASE: LanguageCase = Object.freeze({
  id: 'redesign/w1-legacy-surface',
  group: 'program',
  file: FILE_LEGACY,
  expectation: 'golden',
  constructs: Object.freeze(['旧五锚点等价写法']),
  requires: NEW_CASE.requires,
  note: '与 redesign/w1-new-surface 语义相同、只用 # / @ / ? / ! / > 的等价写法',
});

const CASES = Object.freeze([NEW_CASE, LEGACY_CASE]);

function runSuite(overrides: Partial<Parameters<typeof runLanguageSuite>[0]> = {}): LanguageReport {
  return runLanguageSuite({ io: read, root: FIXTURE_DIR, cases: CASES, ...overrides });
}

const BASELINE = runSuite();

const caseOf = (report: LanguageReport, id: string) => {
  const found = report.cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`报告里没有 case：${id}`);
  return found;
};

const sourceOf = (file: string): string => readFileSync(path.join(FIXTURE_DIR, `${file}.kojo2`), 'utf8');
const goldenOf = (file: string): string => readFileSync(path.join(FIXTURE_DIR, `${file}.golden.erb`), 'utf8');

/* ============================== 1. 覆盖度：两族表面真的都写到了 ============================== */

describe('W1 对拍 · 覆盖度可数（两族表面各自成族）', () => {
  const newSource = sourceOf(FILE_NEW);
  const legacySource = sourceOf(FILE_LEGACY);

  it('新表面 fixture：十个方寸声明词 / 冒号动作族 / 若-否则 / ※ / 裸行旁白逐项出现', () => {
    // §2.2 方寸声明族：本 fixture 覆盖 幕/视角/挂/设/对照表/池/模/函/织
    //（`【方言】` 是文件级断言、与本示例语义无关，单独在 core 测试里钉）
    for (const header of ['【幕 ', '【视角 ', '【挂 ', '【设 ', '【对照表 ', '【池 ', '【模 ', '【函 ', '【织 ']) {
      expect(newSource, `缺方寸声明 ${header}`).toContain(header);
    }
    // §2.3 冒号动作族
    for (const action of ['算：', '色：', '颜绘：', '择一：', '组：', '循环：', '重复：', '遍历：', '标：', '跳：', '演：']) {
      expect(newSource, `缺冒号动作 ${action}`).toMatch(new RegExp(`^\\s*${action}`, 'm'));
    }
    expect(newSource).toMatch(/^ {4}断$/m);
    expect(newSource).toMatch(/^ {4}续$/m);
    // 条件族与注释
    expect(newSource).toContain('\n若 ');
    expect(newSource).toContain('\n再若 ');
    expect(newSource).toContain('\n否则：');
    expect(newSource).toContain('\n※ ');
    // 裸行旁白：顶层正文既不写 `>`、也不当台词；缩进块内同样可以裸写
    const bareLines = newSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[【※#>?@!]/.test(line) && !/^(若|再若|否则|算|色|颜绘|择一|组|循环|重复|遍历|标|跳|演)：?/.test(line));
    expect(bareLines).toContain('晨光透过鸟居，斑驳地洒在石阶上。');
    expect(bareLines).toContain('她把脸埋进你的肩膀。');
    // 原生逃生舱按任务口径保留旧 `@原生{ … }`（W1 未改）
    expect(newSource).toContain('\n@原生{');
  });

  it('旧写法 fixture：同一套构造只用 # / @ / ? / ! / > 五锚点写出来', () => {
    for (const anchor of ['# 幕 ', '# 视角 ', '# 机 ', '# 设 ', '# 对照表 ', '# 池 ', '# 模 ', '@函 ', '@织 ']) {
      expect(legacySource, `缺旧声明 ${anchor}`).toContain(anchor);
    }
    for (const dispatch of ['@算', '@着色', '@颜绘', '@随机', '@组', '@循', '@复', '@巡', '@标', '@跳']) {
      expect(legacySource, `缺旧动作 ${dispatch}`).toMatch(new RegExp(`^\\s*${dispatch}(?=\\s|$)`, 'm'));
    }
    expect(legacySource).toContain('\n? ');
    expect(legacySource).toContain('\n? 否\n');
    expect(legacySource).toContain('\n! 早安问候');
    expect(legacySource).toContain('\n> 晨光透过鸟居');
    expect(legacySource).toContain('\n// ');
    // 旧写法里不许出现 W1 新表面记号（否则"对拍"就是两份新写法在比）
    for (const surface of ['【', '】', '\n若 ', '\n再若 ', '\n否则：', '\n※ ', '\n算：', '\n演：']) {
      expect(legacySource, `旧写法 fixture 混入了新表面 ${surface}`).not.toContain(surface);
    }
  });

  it('两份 fixture 的行数对齐（逐构造配对；注释行也配对）', () => {
    expect(newSource.split('\n')).toHaveLength(legacySource.split('\n').length);
  });
});

/* ============================== 2. 套件读数：两份都 pass 且 artifact 相同 ============================== */

describe('W1 对拍 · 套件读数（golden 期望，零 differs / 零 blocked）', () => {
  it('两个 case 都 pass；summary 2 pass / 0 differs / 0 blocked', () => {
    expect(BASELINE.ok).toBe(true);
    expect(BASELINE.failures).toEqual([]);
    expect(BASELINE.summary).toMatchObject({ cases: 2, pass: 2, differs: 0, blocked: 0 });
    expect(BASELINE.adapter).toBe(LANGUAGE_FIXTURE_ADAPTER.id);
    expect(BASELINE.backend).toBe(LANGUAGE_FIXTURE_BACKEND.id);
  });

  it('新表面 artifact === 旧写法 artifact（逐字节；这是 W1 §3.6 的直接判据）', () => {
    const next = caseOf(BASELINE, NEW_CASE.id);
    const legacy = caseOf(BASELINE, LEGACY_CASE.id);
    expect(next.status).toBe('pass');
    expect(legacy.status).toBe('pass');
    expect(next.artifact).not.toBeNull();
    expect(next.artifact).toBe(legacy.artifact);
    expect(next.diagnostics).toEqual([]);
    expect(legacy.diagnostics).toEqual([]);
  });

  it('artifact === 磁盘 golden（两份 golden 也互为逐字节副本）', () => {
    const next = caseOf(BASELINE, NEW_CASE.id);
    const legacy = caseOf(BASELINE, LEGACY_CASE.id);
    expect(next.artifact).toBe(goldenOf(FILE_NEW));
    expect(legacy.artifact).toBe(goldenOf(FILE_LEGACY));
    expect(goldenOf(FILE_NEW)).toBe(goldenOf(FILE_LEGACY));
  });

  it('golden 形状：末尾恰一个 LF、无 CRLF、非空', () => {
    const golden = goldenOf(FILE_NEW);
    expect(golden.length).toBeGreaterThan(0);
    expect(golden.endsWith('\n')).toBe(true);
    expect(golden.endsWith('\n\n')).toBe(false);
    expect(golden.includes('\r')).toBe(false);
  });
});

/* ============================== 3. golden 逐行归档（不是"跑出来就是对的"） ============================== */

/**
 * golden 的**逐行解释**（1 基行号；行号连续覆盖 1..78，由下面的测试强制）。
 *
 * 每行都对应 fixture 里的一条构造，写的是"为什么这行会出现在这里"；
 * 谁改坏 golden（或改坏 fixture）都会先在这张表上红。
 */
const GOLDEN_ANATOMY: ReadonlyArray<readonly [number, string]> = Object.freeze([
  [1, '【挂 开场】→ fixture 事件头 MACHINE 开场（旧 # 机 开场 同字节）'],
  [2, '【对照表 心情】判别槽 #SLOT（表名派生，fixture backend 只落注释）'],
  [3, '【对照表 心情】值槽 #SLOT（值类型 string 由表体字面量推出）'],
  [4, '择一： 的随机槽 #SLOT random int（槽号=块头源行号）'],
  [5, '遍历：队列 的绑定槽（下标）'],
  [6, '遍历：队列 的绑定槽（值）'],
  [7, '裸行旁白 1：不经 > ，与旧 > 旁白同 lowering'],
  [8, '台词行：说话人与正文分离，行尾 (微笑) 是导演批注'],
  [9, '若 外部计数 >= 亲近线：→ IF（条件表达式原样进 {…} 端口）'],
  [10, '心形是"已声明演出"→ 追加 ;HINT 心形（language fixture 的 hintSupport 口径）'],
  [11, '再若 外部计数 >= 100：→ ELSEIF'],
  [12, '再若分支正文'],
  [13, '否则：→ ELSE'],
  [14, '否���分支正文'],
  [15, '条件链收口 ENDIF'],
  [16, '【对照表】判别式求值一次 → SET 判别槽（表体之前）'],
  [17, '档 0..99 → IF 区间判别'],
  [18, '段内赋值 → 值槽'],
  [19, '档 100..499 → ELSEIF 区间判别'],
  [20, '段内赋值 → 值槽'],
  [21, '档 500.. → ELSEIF 开区间'],
  [22, '段内赋值 → 值槽'],
  [23, '否 → ELSE'],
  [24, '兜底档赋值'],
  [25, '表分派收口 ENDIF'],
  [26, '算： 块第一行：表值槽赋给作者变量'],
  [27, '算： 块第二行：数组下标赋值 + 函数调用表达式'],
  [28, '算： 块第三行：库属性 .长度'],
  [29, '色：0xFF8080 → 着色进入'],
  [30, '着色块内台词：颜色轴随行（fixture 端口把颜色值内联）'],
  [31, '着色块内旁白：同样带颜色轴'],
  [32, '着色块收口 → 复位颜色'],
  [33, '颜绘：笑顔 → 单行演出指令（object=me）'],
  [34, '择一：→ RANDOM <purity> <候选数>（等概率择一，不是概率分布）'],
  [35, '第一个候选正文'],
  [36, '组： 内台词（候选组不额外产生写法差异）'],
  [37, '组： 内旁白'],
  [38, '择一：块收口'],
  [39, '循环：余韵 < 2 → WHILE'],
  [40, '循环体赋值'],
  [41, '续 → CONTINUE'],
  [42, '断 → BREAK'],
  [43, '循环收口 → WEND'],
  [44, '重复：2 → REPEAT'],
  [45, '重复体正文'],
  [46, '重复收口 → REND'],
  [47, '遍历：队列 → FOREACH|array|<集合>'],
  [48, '绑定 值 → 元素槽'],
  [49, '绑定 下标 → 下标槽'],
  [50, '遍历体正文：绑定名已换槽（{下标}/{值}）'],
  [51, '遍历收口'],
  [52, '演：早安问候 → 池内联：条件链头 IF'],
  [53, '池分支正文（第一档）'],
  [54, '池第二档 → ELSEIF'],
  [55, '池第二档正文'],
  [56, '池兜底 → ELSE'],
  [57, '池兜底台词（带 (拥抱) 批注）'],
  [58, '池兜底旁白'],
  [59, '池内联收口 ENDIF'],
  [60, '演：娇羞退场("被夸奖") → 模板内联：插槽前正文（{原因} 已换实参）'],
  [61, '模板插槽正文（调用点缩进块）'],
  [62, '模板插槽后正文'],
  [63, '@标 主菜单 → LABEL'],
  [64, '标签后旁白'],
  [65, '若 余韵 == 1：→ IF（标跳前的条件）'],
  [66, '跳：战斗 → GOTO'],
  [67, '否则 → ELSE'],
  [68, '跳：主菜单 → GOTO（回跳）'],
  [69, 'ENDIF'],
  [70, '@标 战斗 → LABEL'],
  [71, '标签后旁白'],
  [72, '@原生{ … } 第一行：逐行直通（`;` 保持是 ERB 注释）'],
  [73, '@原生{ … } 第二行：逐行直通（CALL 原样）'],
  [74, '原生块之后恢复 2.0 语义的旁白'],
  [75, '事件头收口 MACHINE.END'],
  [76, '【织 开场 之前】→ 监听头（事件 + 修饰词 pri）'],
  [77, '监听体正文'],
  [78, '监听收口'],
]);

describe('W1 golden · 逐行归档（构造 ↔ 产物行）', () => {
  const lines = goldenOf(FILE_NEW).slice(0, -1).split('\n');

  it('归档行号连续覆盖 1..行数，且与 golden 行数严格一致', () => {
    expect(GOLDEN_ANATOMY.map(([line]) => line)).toEqual(lines.map((_, index) => index + 1));
    expect(GOLDEN_ANATOMY.every(([, why]) => why.trim().length > 0)).toBe(true);
  });

  it('关键构造的产物行与归档文义一致（抽样钉死，不只靠行号）', () => {
    const at = (line: number): string => lines[line - 1] ?? '';
    expect(at(1)).toBe('MACHINE 开场');
    expect(at(9)).toBe('IF {外部计数 >= 亲近线}');
    expect(at(15)).toBe('ENDIF');
    // 判别式必须是**干净的** `外部计数`：W1 修复前这里会带方寸收口符 `】`
    expect(at(16)).toBe('SET __kojo_table_心情 = {外部计数}');
    expect(lines.join('\n')).not.toContain('】');
    expect(at(33)).toBe('FACE me 笑顔');
    expect(at(34)).toBe('RANDOM group-text 2');
    expect(at(39)).toBe('WHILE {余韵 < 2}');
    expect(at(44)).toBe('REPEAT {2}');
    expect(at(47)).toBe('FOREACH|array|队列');
    expect(at(63)).toBe('LABEL 主菜单');
    expect(at(72)).toBe('; 逃生舱：底层 ERB 代码');
    expect(at(75)).toBe('MACHINE.END');
    expect(at(76)).toBe('WEAVE 开场 pri');
  });

  it('golden 覆盖的构造数 = fixture 声明的构造族数（不许有一族悄悄消失）', () => {
    const golden = goldenOf(FILE_NEW);
    // 声明族：表/池/模/函/织 都留下可指认的落点
    expect(golden).toContain(';SLOT __kojo_table_心情 table int');
    expect(golden).toContain(';SLOT __kojo_foreach_');
    expect(golden).toContain('WEAVE 开场 pri');
    expect(golden).toContain('TELL: （她红着脸，因为被夸奖而不知所措） /WAIT');
    // 动作族：算/色/颜绘/择一/循环/重复/遍历/标跳/断续/演
    for (const token of ['SET ', 'COLOR.ENTER', 'FACE me', 'RANDOM group-text', 'WHILE ', 'REPEAT ', 'FOREACH|', 'LABEL ', 'GOTO ', 'CONTINUE', 'BREAK', 'MACHINE.END']) {
      expect(golden, `golden 缺动作族落点 ${token}`).toContain(token);
    }
  });
});

/* ============================== 4. 失败不洗白（W1 表面写坏必须红） ============================== */

/** 内存 IO：真 fixture 目录 + 单文件覆盖（不改磁盘） */
function fixtureIo(overrides: Readonly<Record<string, string>> = {}): LanguageIoPort {
  // 套件的 root 归一化成 `/` 分隔（`normalizeDir` + `joinPath`），覆盖键必须同形
  const key = (name: string): string => path.join(FIXTURE_DIR, name).replaceAll('\\', '/');
  const files = new Map<string, string>();
  for (const name of readdirSync(FIXTURE_DIR)) {
    files.set(key(name), readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  }
  for (const [name, text] of Object.entries(overrides)) files.set(key(name), text);
  return {
    readText: (target): string => {
      const text = files.get(target);
      if (text === undefined) throw new Error(`ENOENT: ${target}`);
      return text;
    },
  };
}

describe('W1 对拍 · 失败不洗白', () => {
  it('新表面方寸声明缺收口 `】` → 该 case 不是 pass（编译/解析必须红）', () => {
    const io = fixtureIo({ [`${FILE_NEW}.kojo2`]: sourceOf(FILE_NEW).replace('【挂 开场】', '【挂 开场') });
    const report = runSuite({ io });
    const item = caseOf(report, NEW_CASE.id);
    expect(item.status).not.toBe('pass');
    expect(report.ok).toBe(false);
  });

  it('把新表面表体写坏（档位重叠）→ 该 case 不是 pass，且旧写法 case 仍 pass（对拍两侧独立判定）', () => {
    const io = fixtureIo({
      [`${FILE_NEW}.kojo2`]: sourceOf(FILE_NEW).replace('    100..499 → 平常', '    50..499 → 平常'),
    });
    const report = runSuite({ io });
    expect(caseOf(report, NEW_CASE.id).status).not.toBe('pass');
    expect(caseOf(report, LEGACY_CASE.id).status).toBe('pass');
    expect(report.ok).toBe(false);
  });

  it('新表面 golden 被改坏 → differs + language/golden（不静默）', () => {
    const io = fixtureIo({ [`${FILE_NEW}.golden.erb`]: goldenOf(FILE_NEW).replace('MACHINE 开场', 'MACHINE 脏') });
    const report = runSuite({ io });
    const item = caseOf(report, NEW_CASE.id);
    expect(item.status).toBe('differs');
    expect(report.failures.some((failure) => failure.id === NEW_CASE.id && failure.code === 'language/golden')).toBe(true);
  });
});
