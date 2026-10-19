/**
 * 口上项目脚手架 —— **eraTW 侧的数据层**（2026-10-12 口上项目批 P-C；
 * 2026-10-18 AM-1 P4 改为共享骨架 + 本游戏供数）。
 *
 * 装配逻辑、目录名消毒、空壳与 README 的段落骨架全部搬到契约层
 * `@kojo/plugin-api` 的 `scaffold.ts`（项目负责人 2026-10-18 拍板：向导族抽共享骨架，
 * 不复制）。本文件只留**游戏知识**：
 * - 包目录名格式沿用 `{作品名}-{角色名} v{版本}`（骨架的通用约定，两游戏一致）；
 * - 8 核心面的清单与中文命名（`CORE_FACES`）；
 * - 从真实口上库转写的现成案例（`FACE_CASES`，单一真源 `fixtures/scaffold/`）；
 * - 剧本号 1-10 的语义与校验（eraTW 特有）；
 * - 部署路径 `ERB/口上・メッセージ関連/個人口上/<dir>/` 与放置规则；
 * - 许可条款文本（`licenses.ts` —— LTOL 是 era 社区约定，刻意留在 adapter）。
 *
 * ## 为什么核心面空壳默认是 `.kojo` 而不是 `.ERB`（用户反馈 1，2026-10-12）
 *
 * `.kojo` 是**超集**：语法糖与原始 ERB 写法可以在同一个文件里混排（原生语句按规范
 * 逐行透传），而 `.ERB` 只能写原生。新建项目时作者还没决定要用哪种，所以脚手架
 * 默认给 `.kojo`——**先不要替作者收窄表达**。导出/部署时再统一转译成游戏认得的
 * `.ERB`（见 `#17`），工作区里始终只有 `.kojo` 这一份源。
 *
 * 空壳内容全是 `;` 注释，而 `;` 注释在糖里语法完全一样 ⇒ 同一份内容在两种扩展名下
 * 都合法，改的只是"作者接下来能在这个文件里写什么"。
 *
 * ## 语言档：作者自己选起手形态（用户反馈 1 的下半寸，2026-10-20 NEW-ERB）
 *
 * "默认给超集"和"只给超集"是两回事。作者已经明确只写原生时，脚手架照旧给他一份
 * `.kojo` 就是替他做了决定。于是新建向导多一格「起手写法」（档位、文案、扩展名
 * 全部由共享层 `@kojo/kojo-project-kit` 的 `lang-doc.ts` 给出，本文件只消费）：
 *
 * - **糖档（缺省，历史行为）**：产物与改前**逐字节相同**——`tests/scaffold-lang-doc.test.ts`
 *   用 sha256 逐文件钉死，抬默认档的任何改动都会红；
 * - **原生档**：**同一份骨架**写成 `.ERB`，只是①扩展名换掉、②不带【库内现成案例】块
 *   （那几段是糖写法示例，塞进只准写原生的文件里就是把作者往坑里带；宁缺勿编，
 *   与 2026-10-14 案例批同一条纪律，绝不现编"原生版案例"）。
 *
 * 原生档不破坏导出/部署链，这一点是有实据的：制品计划 `planArtifacts` 对非 `.kojo`
 * 文件**字节级原样携带**（`kit/src/artifact.ts` 规矩 2），编译器一次都不叫——
 * 上面那条 sha 断言与 `scaffold-lang-doc.test.ts` 的 `取证③` 用例把这条链钉住。
 *
 * 面模板示例取自本包 `face-templates.ts`（游戏知识单一真源；只代入不解释）。
 */

import {
  assembleScaffold,
  buildScaffoldDirName,
  buildScaffoldFaceStub,
  buildScaffoldReadme,
  faceTemplateExample,
  sanitizePathSegment,
  KOJO_SOURCE_EXTENSION,
  type KojoFaceTable,
  type ScaffoldFaceCase,
  type ScaffoldFaceSpec,
} from '@kojo/plugin-api';
import { kojoLangDocExtension, type KojoLangDoc } from '@kojo/kojo-project-kit';
import { createEratwFaceTable } from './face-templates';
import {
  buildLicenseText,
  licenseProducesFile,
  LICENSE_CHOICES,
  LICENSE_FILE_NAME,
  type LicenseKind,
} from '@kojo/kojo-project-kit';

/** 脚手架输入（向导字段一一对应） */
export interface KojoScaffoldOptions {
  /** 作品名 */
  workName: string;
  /** 作者名 */
  authorName: string;
  /** 版本（如 1.0） */
  version: string;
  /** 目标角色编号 */
  charaNo: number;
  /** 目标角色名 */
  charaName: string;
  /** 剧本号（1-10） */
  scriptNo: number;
  /**
   * 许可条款（反馈 4：从"勾不勾占位模板"升级成"选哪一种"）。
   * `'none'` = 不生成 LICENSE 文件。文本来源见 `licenses.ts` 头注。
   */
  license: LicenseKind;
  /**
   * 起手写法（语言档，NEW-ERB 2026-10-20）。**缺省 = 糖档**，与不传这个字段完全同义：
   * 历史调用方（含另一款游戏的接线路径）零改动、产物零变化。
   */
  langDoc?: KojoLangDoc;
}

/** 脚手架产物：包目录名 + 文件集（相对路径 → 文本内容） */
export interface KojoScaffoldResult {
  dirName: string;
  files: Record<string, string>;
}

/**
 * 核心面空壳的文件扩展名（README 清单与实际产物必须同源于此）。
 *
 * 值 = 契约层的表层源扩展名单源（`KOJO_SOURCE_EXTENSION`），本文件**不抄字面量**
 * （NEW-ERB 单源守卫 `kit/tests/lang-doc.test.ts` 按行钉死）。
 */
export const FACE_STUB_EXT = KOJO_SOURCE_EXTENSION;

/** 本游戏各档的起手扩展名（糖档 = `FACE_STUB_EXT`；原生档由共享层单源给） */
export function scaffoldStubExt(langDoc: KojoLangDoc | undefined): string {
  return langDoc === 'native' ? kojoLangDocExtension('native') : FACE_STUB_EXT;
}

/** 核心面空壳规格（中文命名；文件名 = stem + '.kojo'） */
export type CoreFaceSpec = ScaffoldFaceSpec;

/** 8 核心面（讨论纪要定稿清单；顺序即生成顺序） */
export const CORE_FACES: readonly CoreFaceSpec[] = [
  { stem: '事件', face: '事件', blurb: '事件面：剧情事件按事件编号触发的对白。' },
  { stem: '日常指令', face: '日常', blurb: '日常面：散步、聊天等日常相处事件的台词。' },
  { stem: '性交指令', face: '指令', blurb: '性交指令面：性交系指令（COM）时的反应台词。' },
  { stem: '奉仕指令', face: '指令', blurb: '奉仕指令面：奉仕系指令（COM）时的反应台词。' },
  { stem: '爱抚指令', face: '指令', blurb: '爱抚指令面：爱抚系指令（COM）时的反应台词。' },
  { stem: '绝顶', face: '绝顶', blurb: '绝顶面：绝顶参数（PALAM B）达标时的台词。' },
  { stem: '刻印取得', face: '标记', blurb: '刻印面：取得刻印或素质变化（MARKCNG）时的台词。' },
  { stem: '性骚扰指令', face: '指令', blurb: '性骚扰指令面：触手等性骚扰系指令（COM）时的反应台词。' },
];

/**
 * 库内现成案例（2026-10-14 案例批；用户反馈：空壳注释里要有**从真实口上库抄来的
 * 现成案例**，不许自编示例）。
 *
 * - `source` / `fn` = 取材出处（口上库内相对路径 + 函数名，逐字真实，可回去抽查）；
 * - `lines` = 该函数**原 ERB 片段**（存于 `fixtures/scaffold/<stem>.erb`）经本仓
 *   升糖投影 `liftProject`（`kojo-sugar/src/project.ts`）转成的语法糖逐行文本，
 *   台词按类目简化为 `category` 占位（亲密面「涩涩的话」／日常与事件面「日常的对话」）；
 *   转不了糖的行保留原生 ERB 原样（`.kojo` 允许原生逐行直通）。
 *
 * **只覆盖 事件／日常指令／刻印取得／性骚扰指令 4 面**（宁缺勿编，2026-10-14 案例批）：
 * 性交指令／奉仕指令／爱抚指令／绝顶 4 面的候选来源函数（真实语料实测）投影后
 * 要么出现作者写不出的形态（`IF LOCAL && …` 信封截半 ⇒ `如果` 落 0 列、转译报
 * indent-mismatch；`LOCAL && NOWEX:` 缩进则报 unknown-identifier；家族注记头），
 * 要么正文超 10 行、要么首闭合分支无台词——试满候选仍无可写形态，案例已撤。
 * 撤掉的面 `buildFaceStub` 整块不输出【库内现成案例】（不留空头）。
 *
 * **单一真源是 `fixtures/scaffold/<stem>.kojo`**；脚手架是纯函数（无 IO），故文本
 * 由本常量承载。`tests/scaffold-cases.test.ts` 钉死三者一致：
 * ① fixture 逐行 == 本常量；② 本常量派生自 fixture `.erb`（现场重跑升糖+简化）；
 * ③ 空壳注释里的案例逐行出自本常量（反向：改一个字即被抓出）；
 * ④ 案例必须拼成**可转译（零 error）**的最小文档——示例是给人照抄的。
 */
export type FaceCase = ScaffoldFaceCase;

/** 按 stem 索引的案例表（键 = `CORE_FACES[].stem`） */
export const FACE_CASES: Readonly<Record<string, FaceCase>> = {
  事件: {
    source: 'ERB/口上・メッセージ関連/個人口上/063 Kagerou [影狼]/影狼/M_KOJO_K63_イベント.ERB',
    fn: '@M_KOJO_EVENT_K63_22',
    category: '「日常的对话」',
    lines: [
      '时机 事件 22：',
      '\t;口上主はARG',
      '\t;--------------------------------------------------',
      '\t;記入チェック（=0, 非表示、1, 表示）',
      '\t;-------------',
      '\t如果 !TALENT:恋慕：',
      '\t\t「日常的对话」',
      '\t\t「日常的对话」',
    ],
  },
  日常指令: {
    source: 'ERB/口上・メッセージ関連/個人口上/111 Clownpiece [クラウンピース]/クラウンピース/M_KOJO_K111_イベント.ERB',
    fn: '@M_KOJO_DAILY_EVENT_K111_4',
    category: '「日常的对话」',
    lines: [
      '时机 日常 4：',
      '\t;地の文を変えたければコメントアウト',
      '\t;--------------------------------------------------',
      '\t;記入チェック（=0, 非表示、1, 表示）',
      '\t;-------------',
      '\t「日常的对话」',
    ],
  },
  刻印取得: {
    source: 'ERB/口上・メッセージ関連/個人口上/101 Tokiko [朱鷺子]/朱鷺子/M_KOJO_K101_刻印取得.ERB',
    fn: '@M_KOJO_MESSAGE_MARKCNG_K101',
    category: '「日常的对话」',
    lines: [
      '时机 标记：',
      '\t;このままだと地の文が表示されません',
      '\t;地の文を表示したい方は、下記のコメントアウトを削除して下さい',
      '\t;苦痛刻印',
      '\t如果 TFLAG:22 == 1：',
      '\t\t「日常的对话」',
      '\t否则如果 TFLAG:22 == 2：',
      '\t\t「日常的对话」',
      '\t否则如果 TFLAG:22 == 3：',
      '\t\t「日常的对话」',
    ],
  },
  性骚扰指令: {
    source: 'ERB/口上・メッセージ関連/個人口上/022 Lunasa [ルナサ]/ルナサ/M_KOJO_K22_セクハラコマンド.ERB',
    fn: '@M_KOJO_MESSAGE_COM_K22_317_1',
    category: '「涩涩的话」',
    lines: [
      '时机 指令 317：',
      '\t;-------------------------------------------------',
      '\t;記入チェック（=0, 非表示、1, 表示）',
      '\t;-------------------------------------------------',
      '\t「涩涩的话」',
    ],
  },
};

/** 部署目标目录（eraTW 的口上根，相对游戏目录） */
const DEPLOY_KOJO_ROOT = 'ERB/口上・メッセージ関連/個人口上';

/**
 * 文件系统非法字符消毒（单层目录段）——共享骨架的实现，本包沿用旧名导出。
 * 剔除 `\/:*?"<>|` 与控制字符，压缩连续空白，去首尾空白与尾随点号
 * （Windows 目录名不得以点/空格结尾）。合法字符一律保留（含中日文、空格）。
 */
export const sanitizeSegment = sanitizePathSegment;

/** 包目录名：`{作品名}-{角色名} v{版本}`（逐段消毒后拼接） */
export const scaffoldDirName = buildScaffoldDirName;

/** 分野表模板占位符说明（eraTW 的面模板用 `{i}` 与 `${com}` 两个占位） */
const TEMPLATE_HINTS = [
  { token: '{i}', text: '时机编号（按游戏内事件/指令编号填写）。' },
  { token: '${com}', text: '指令类型段（COM / SCOM / CUSTOM_COM / CUSTOM_SCOM）。' },
] as const;

/** 与占位符无关的恒输出说明（eraTW 有家族段维度） */
const ALWAYS_HINTS = ['有家族段（别人版口上）时，家族段插在 M_KOJO 之后的下划线处。'] as const;

/** 单面空壳内容（纯 `;` 注释；不生成任何活函数） */
export function buildFaceStub(
  spec: CoreFaceSpec,
  opts: KojoScaffoldOptions,
  faceTable: KojoFaceTable,
): string {
  const ext = scaffoldStubExt(opts.langDoc);
  return buildScaffoldFaceStub(
    {
      face: spec,
      identity: opts,
      metaLead: [`剧本${opts.scriptNo}`],
      templateExample: faceTemplateExample(faceTable, spec.face, opts.charaNo),
      templateHints: TEMPLATE_HINTS,
      alwaysHints: ALWAYS_HINTS,
      // 【库内现成案例】是**糖写法**的示例（由真实口上经升糖投影转写）。原生档的文件里
      // 只准写原生 ⇒ 整块不输出（共享骨架对 `faceCase: null` 的既定行为：不留空头、
      // 也不把"已用本工具转成 X 写法"那句收尾语塞进对不上号的档位）。绝不现编原生案例。
      faceCase: opts.langDoc === 'native' ? null : FACE_CASES[spec.stem] ?? null,
    },
    ext,
  );
}

/** 中文 README 模板 */
export function buildReadme(opts: KojoScaffoldOptions): string {
  const licenseNote: string[] = [];
  if (licenseProducesFile(opts.license)) {
    const choice = LICENSE_CHOICES.find((c) => c.kind === opts.license);
    licenseNote.push(
      `本包采用 **${choice?.label ?? opts.license}**，全文见 \`${LICENSE_FILE_NAME}\` 文件。`,
    );
    licenseNote.push('');
    if (opts.license === 'ltol') {
      licenseNote.push('注意 LTOL 有**时限**：自标注之日起一年，版本升级再续一年；');
      licenseNote.push('到期或作者失联半年后转为免费许可。发布时请留意 `LICENSE` 里记的年份。');
    } else if (opts.license === 'cc-by-nc-4.0') {
      licenseNote.push('注意：`LICENSE` 里那份是**要点速览**，具有法律效力的完整条款以文件中的官方链接为准。');
    } else if (opts.license === 'template') {
      licenseNote.push('（当前为占位模板，请填写正式条款后再发布。）');
    }
  } else {
    licenseNote.push('未指定开源协议——默认保留所有权利。');
  }

  const ext = scaffoldStubExt(opts.langDoc);
  const native = opts.langDoc === 'native';
  const nativeExt = scaffoldStubExt('native');

  return buildScaffoldReadme({
    identity: opts,
    title: `《${opts.workName.trim()}》· ${opts.charaName.trim()} 口上包`,
    metaRows: [
      { label: '作者', value: opts.authorName.trim() },
      { label: '版本', value: opts.version.trim() },
      { label: '目标角色', value: `${opts.charaName.trim()}（编号 ${opts.charaNo}）` },
      { label: '目标剧本', value: `剧本${opts.scriptNo}` },
    ],
    intro: ['> 请在这里填写作品介绍：设定、基调、与原版口上的差异点等。'],
    // 糖档这两句**一字都不许动**（默认档产物逐字节不变是这条反馈的硬约束，
    // `tests/scaffold-lang-doc.test.ts` 用 sha256 钉死）；原生档另写一套说法。
    contentNote: native
      ? [
          '本包由脚手架生成以下核心面空壳（文件内只有 `;` 注释，不含活函数）。' +
            `新建时选的是**原生写法**：起手文件就是游戏认得的 \`${ext}\`，只写原生语法，不经转译，` +
            '导出或部署时原样带走。',
          `想改成两种写法混排（糖写法 + 原生逐行直通）就把扩展名换成 \`${FACE_STUB_EXT}\`——` +
            '这一份起手内容在两种扩展名下都合法，编辑器一样认得。',
          `本包不带糖写法案例（那是 \`${FACE_STUB_EXT}\` 的写法，放进只写原生的文件里只会误导）。`,
        ]
      : [
          '本包由脚手架生成以下核心面空壳（文件内只有 `;` 注释，不含活函数）。' +
            '扩展名是 `.kojo`：.kojo 写法与原始 ERB 写法可以写在同一个文件里，' +
            '导出或部署时会自动转译成游戏认得的 `.ERB`，工作区里始终只有 `.kojo` 这一份源。',
          '部分面文件顶部带一份从口上库现成案例转写的注释示例（.kojo 写法，台词简化为类目占位）。',
        ],
    faces: CORE_FACES,
    stubExt: ext,
    deployIntro: native
      ? [`本包的起手文件就是引擎认得的格式，编辑器的「部署到游戏目录」原样放进游戏目录：`]
      : ["编辑器的「部署到游戏目录」会把本包转译后放进游戏目录："],
    deployPath: `${DEPLOY_KOJO_ROOT}/<角色口上目录>/${scaffoldDirName(opts)}/`,
    deployNote: native
      ? [
          '（游戏目录默认只读，需先批准写权限；目标已存在时不会覆盖。）',
          '',
          `手工放置也可以：把 \`${ext}\` 连同辅助文件复制过去即可（本包没有需要转译的文件）。`,
        ]
      : [
          '（游戏目录默认只读，需先批准写权限；目标已存在时不会覆盖。）',
          '',
          `手工放置也可以：先把 \`${FACE_STUB_EXT}\` 全部转译成同名 \`${nativeExt}\`，再把 \`${nativeExt}\` 连同辅助文件复制过去。`,
          `**直接把 \`${FACE_STUB_EXT}\` 放进游戏目录是不生效的**——引擎只读 \`${nativeExt}\`。`,
        ],
    licenseNote,
  });
}

/**
 * 生成 LICENSE 文件内容（条款文本单一真源在 `licenses.ts`）。
 *
 * 年份取**生成时**的本地年份：许可条款里的年份就是"哪一年署的"，
 * 不需要（也不该）可注入 —— 单测断言的是"出现年份字段"，不是某个具体年份。
 */
export function buildLicense(opts: KojoScaffoldOptions): string {
  return buildLicenseText(opts.license, {
    author: opts.authorName.trim(),
    year: new Date().getFullYear(),
    workName: opts.workName.trim(),
  });
}

/** 剧本号区间（eraTW 的多剧本编号，1-10） */
const SCRIPT_NO_MIN = 1;
const SCRIPT_NO_MAX = 10;

/**
 * 组装完整脚手架产物。输入非法时抛错（中文消息；向导已前置校验，此处兜底）。
 * `faceTable` 缺省取 eraTW 分野表（纯数据，无 IO）。
 */
export function scaffoldKojoProject(
  opts: KojoScaffoldOptions,
  faceTable: KojoFaceTable = createEratwFaceTable(),
): KojoScaffoldResult {
  return assembleScaffold({
    identity: opts,
    faces: CORE_FACES,
    stubExt: scaffoldStubExt(opts.langDoc),
    readme: () => buildReadme(opts),
    stub: (face) => buildFaceStub(face, opts, faceTable),
    extraFiles: (): Record<string, string> =>
      licenseProducesFile(opts.license) ? { [LICENSE_FILE_NAME]: buildLicense(opts) } : {},
    assertExtra: () => {
      if (!Number.isInteger(opts.scriptNo) || opts.scriptNo < SCRIPT_NO_MIN || opts.scriptNo > SCRIPT_NO_MAX) {
        throw new Error(`剧本号必须是 ${SCRIPT_NO_MIN}-${SCRIPT_NO_MAX} 的整数：${String(opts.scriptNo)}`);
      }
    },
  });
}
