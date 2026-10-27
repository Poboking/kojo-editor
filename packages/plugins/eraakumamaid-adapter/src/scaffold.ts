/**
 * 口上项目脚手架 —— **eraAkumaMaid 侧的数据层**（2026-10-18 AM-1 P4）。
 *
 * 装配逻辑（目录名消毒、空壳段落、README 骨架、输入兜底）在契约层
 * `@kojo/plugin-api` 的 `scaffold.ts`，本文件只供游戏知识。抽取依据是项目负责人
 * 2026-10-18 的拍板（向导族抽共享骨架，不复制 eratw 向导代码）。
 *
 * ## 与 eraTW 侧的三处**形态差异**（都是游戏事实，不是风格选择）
 *
 * 1. **没有剧本号**：eraAkumaMaid 的口上目录按**角色编号**平铺
 *    （`ERB/EVENT_K/<编号 名称>/`），不存在 `剧本1..10` 的概念 ⇒ `metaLead` 为空。
 * 2. **产物按游戏根相对路径铺开**，而不是"制品目录 = 口上目录"：
 *    游戏自带的 `口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_{67,68,X1}`
 *    就是 `CSV/…` + `ERB/EVENT_K/<编号>/…` 两棵子树，作者解压覆盖到游戏根即可用。
 *    脚手架照抄这个形态 ⇒ 作者拿到的目录既是工作区也是可分发包，
 *    部署时"转译 `.kojo`→`.ERB` 后整棵覆盖到游戏根"一条规则就够。
 * 3. **必须带角色表 CSV**：eraTW 的口上包只放 ERB；本游戏的角色（名字/肩書/学年/
 *    関係/素质）全部由 `CSV/CHARA/CHARA<n>.csv` 声明，缺它游戏里根本认不到这个角色
 *    （`口上テンプレート/新キャラ追加の際に必ず読んでください.txt` §2）。
 *
 * ## 空壳一律 `.kojo`
 *
 * 与 eraTW 侧同一理由：`.kojo` 是超集（糖与原生 ERB 可混排），脚手架不替作者先
 * 收窄表达；部署时统一转译成引擎认得的 `.ERB`，工作区里只有一份源。
 *
 * ## 文件清单的来源
 *
 * 逐字取自游戏自带模板包 `KOJOPackage_67`（7 个 `.ERB`）实测函数清单
 * （`grep '^@'`）：`EVENT_K{n}` / `_CLOTHES` / `_COMM` / `_DAILY` / `_SELECT` /
 * `_SHOP` / `UPDATE_K{n}`。文件级函数归属见 `AM_SCAFFOLD_FILES[].alwaysHints`。
 */

import {
  assembleScaffold,
  buildScaffoldFaceStub,
  buildScaffoldReadme,
  faceTemplateExample,
  KOJO_LEGACY_SOURCE_EXTENSION,
  type KojoFaceTable,
  type ScaffoldFaceSpec,
  type ScaffoldIdentity,
} from '@kojo/plugin-api';
import { createErakumamaidFaceTable } from './face-templates';

/** 脚手架输入（向导字段一一对应；无剧本号） */
export interface ErakumamaidScaffoldOptions extends ScaffoldIdentity {
  /** 作者主页/发布页（可选，只进 README；空串 = 不渲染该行） */
  homepage?: string;
}

/**
 * 单文件规格。
 *
 * `face` 非空 ⇒ 从分野表取函数形态示例；为空 ⇒ 该文件的面在本游戏没有分野表条目
 * （`CLOTHES` / `COMM` / `ADDSELECT` 家族 / `SHOP` / `UPDATE` 都不在 `KojoFaceTable`
 * 的 10 个主面里），此时只靠 `alwaysHints` 告诉作者该写哪些函数。
 */
export interface AMScaffoldFileSpec {
  /** 文件名干（含 `{n}` 占位，不含扩展名） */
  readonly stem: string;
  /** 分野表键；`''` = 本文件的面不在分野表里 */
  readonly face: string;
  /** 一句话说明（进注释与 README） */
  readonly blurb: string;
  /** 本文件该写的函数清单（恒输出说明行） */
  readonly alwaysHints: readonly string[];
}

/**
 * 空壳扩展名（工作区唯一源；部署时转译成 `.ERB`）。
 *
 * LAU-3b-FLIP（2026-10-27）：`.kojo` 归 2.0，本包空壳正文是 kojo1 写法 ⇒ 落 `.kojo1`。
 */
export const AM_FACE_STUB_EXT = KOJO_LEGACY_SOURCE_EXTENSION;

/**
 * 7 个口上文件的规格（顺序 = 生成顺序 = 游戏模板包的阅读顺序）。
 *
 * 文件名的 `{n}` 在装配时替换成角色编号；目录为 `ERB/EVENT_K/<n>/`。
 */
export const AM_SCAFFOLD_FILES: readonly AMScaffoldFileSpec[] = [
  {
    stem: 'EVENT_K{n}',
    face: '指令',
    blurb: '主口上：被称呼方式（CNAME）、招募档案（EVENT_PROFILE）、调教各面与结局。',
    alwaysHints: [
      '本文件承载（函数名一律带 _K{n} 尾）：CNAME_K{n}（被称呼方式）、',
      '  EVENT_PROFILE_K{n}（招募档案：介绍文／劝说前／劝说后）、',
      '  KOJO_MESSAGE_COM_K{n}（指令）、KOJO_MESSAGE_BEFORE_COM_K{n}（指令前）、',
      '  KOJO_MESSAGE_PALAMCNG_K{n}（参数变动：初绝顶／绝顶放尿等）、',
      '  KOJO_MESSAGE_MARKCNG_K{n}（刻印／素质变化）、KOJO_COUNTER_K{n}（反击）、',
      '  KOJO_EVENT_K{n}（事件）、KOJO_MESSAGE_COMING_K{n}（绝顶）、',
      '  KOJO_MESSAGE_SHOOT_K{n}（射精）、KOJO_MESSAGE_SAMEN_AND_EXTACY_K{n}（射精与绝顶）、',
      '  KOJO_MESSAGE_BEFORE_TARGETSHOOT_K{n}／KOJO_MESSAGE_AFTERSHOOTCHANGE_K{n}（射精前／射精后变动）、',
      '  KOJO_ENDCOM_K{n}（指令结束）、KOJO_GUEST_K{n}（来客）、ADDCOND_K{n}（条件追加）、',
      '  SETFLAG_BEFORE_TRAIN_K{n}／TIMEEVENT_K{n}／PRE_EVENTTRAIN_K{n}（调教前钩子）、',
      '  IS_SINGLE_ENDING_K{n}／MENU_SINGLE_ENDING_K{n}／SINGLE_ENDING_K{n}（单人结局）。',
      '另有 K{n}_KOJO2（恋慕／屈服刻印分支口上，函数体按 TALENT／MARK 分流）。',
      '注意：这些面的**编号不进函数名**——指令号（SELECTCOM）、事件名、刻印类型都在',
      '  运行期 ARGS 里，所以写「时机 指令：」即可，不要写「时机 指令 317：」。',
    ],
  },
  {
    stem: 'EVENT_K{n}_CLOTHES',
    face: '',
    blurb: '服装与立绘：穿着判定、女仆脸（表情）、情绪开关。',
    alwaysHints: [
      '本文件承载：CLOTHES_K{n}（服装判定）、MAIDFACE_K{n}（女仆脸／表情）、',
      '  EMOTION_K{n}（情绪）。',
      '这三个面不在分野表的主面里，按原生 ERB 写法直接定义函数即可'
      + '（.kojo 允许原生逐行直通）。',
    ],
  },
  {
    stem: 'EVENT_K{n}_COMM',
    face: '',
    blurb: '通信：手机上收到／发出的消息。',
    alwaysHints: ['本文件承载：KOJO_COMM_K{n}（通信内容）。'],
  },
  {
    stem: 'EVENT_K{n}_DAILY',
    face: '日常',
    blurb: '日常：问候、日常会话、睡觉、日常指令、邮件、约会、小贴士。',
    alwaysHints: [
      '本文件还承载：KOJO_GREETING_K{n}（问候）、KOJO_SLEEP_K{n}（睡觉）、',
      '  KOJO_DAILYCOM_K{n}（日常指令）、SELFY_MAIL_K{n}（自用邮件）、',
      '  KOJO_DATE_K{n}（约会）、TIPS_K{n}（小贴士）。',
      '日常事件的**名字**走 ARGS，函数名不带事件编号尾。',
    ],
  },
  {
    stem: 'EVENT_K{n}_SELECT',
    face: '',
    blurb: '抽选口上：愿望／日常／约会／移动等场合的随机候选（ADDSELECT 家族）。',
    alwaysHints: [
      '本文件承载（函数名统一带 _ADDSELECT 尾）：WISH_K{n}_ADDSELECT、',
      '  KOJO_WISH_K{n}_ADDSELECT、DAILY1_K{n}_ADDSELECT、KOJO_DAILY1_K{n}_ADDSELECT、',
      '  DAILY2_K{n}_ADDSELECT、DAILY2_SLEEP_K{n}_ADDSELECT、',
      '  KOJO_DAILY2_K{n}_ADDSELECT、DATE_K{n}_ADDSELECT、KOJO_DATE_K{n}_ADDSELECT、',
      '  MOVE_K{n}_ADDSELECT。',
      '这一族给引擎**追加随机候选**（同一场合多句轮换），函数返回候选文本。',
      '注意 ADDSELECT 家族的尾段是函数名的一部分：`_K{n}_ADDSELECT`，不是 `_K{n}`。',
    ],
  },
  {
    stem: 'EVENT_K{n}_SHOP',
    face: '',
    blurb: '商店与愿望：买东西的台词、愿望清单。',
    alwaysHints: ['本文件承载：KOJO_WISH_K{n}（愿望）、KOJO_SHOP_K{n}（商店）。'],
  },
  {
    stem: 'UPDATE_K{n}',
    face: '',
    blurb: '更新日期：游戏内「最近更新的角色」据此排序。',
    alwaysHints: [
      '本文件承载：UPDATE_K{n}。函数体只写一行 RETURN <新日期>,<上次日期>（yymmdd），',
      '  例：RETURN 231019,221019。发布到口上库（ロダ）时游戏据此把你列为最近更新。',
    ],
  },
];

/** 角色表 CSV 的路径（游戏实际布局：`CSV/CHARA/CHARA<n>.csv`） */
export function amCharaCsvRelPath(charaNo: number): string {
  return `CSV/CHARA/CHARA${charaNo}.csv`;
}

/** 部署目标目录（相对游戏根；作者把整棵制品覆盖上去即可） */
export const AM_DEPLOY_ROOT = 'ERB/EVENT_K';

/**
 * 角色表 CSV 骨架。
 *
 * 三件事都要对：
 * - **BOM + CRLF**：本游戏全部 CSV 都是 UTF-8-BOM + CRLF（`CSV/CHARA/CHARA1.csv` 实测），
 *   跟着走能避免作者用别的工具改一行就整文件重排；
 * - **必填项齐全**：`口上テンプレート/新キャラ追加の際に必ず読んでください.txt` §2 明令
 *   `番号,名前,呼び名,基礎,肩書,学年,関係` 全部要填，缺項会导致游戏内认不到角色；
 * - **`;` 注释行可留**：引擎与模板包都接受，注释比 README 更难丢。
 *
 * 肩書/学年/関係 的键名是 `CSTR`（不是独立行），这是本游戏的角色卡结构
 * （全语料 75 个角色表实测：`CSTR,肩書` / `CSTR,学年` / `CSTR,関係`）。
 */
export function buildErakumamaidCharaCsv(opts: ErakumamaidScaffoldOptions): string {
  const no = opts.charaNo;
  const name = opts.charaName.trim();
  const lines = [
    `番号,${no}`,
    `名前,${name}`,
    `呼び名,${name}`,
    'CSTR,ふりがな,',
    '',
    '基礎,体力,2000',
    '',
    '; ---- 以下三项必填（缺项游戏内认不到这个角色）----',
    'CSTR,肩書,',
    '; 学年取值：初等部 / 中等部 / １年生 / ２年生 / ３年生 / 司書 / ～教師',
    'CSTR,学年,',
    '; 関係的取值见 ERB/EVENT_K/EVENT_K_FUNCTION.ERB 里现成的那一批',
    'CSTR,関係,',
    '',
    '; ---- 外观（可选：游戏内 设定 → 顔グラシミュレーター 生成后粘这里）----',
    '; CSTR,髪の色,',
    '; CSTR,髪型,',
    '; CSTR,目の色,',
  ];
  // 游戏侧全为 BOM + CRLF，产物跟着一致（见函数头注）
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 单文件空壳内容（纯 `;` 注释；不生成任何活函数） */
export function buildAMFileStub(
  spec: AMScaffoldFileSpec,
  opts: ErakumamaidScaffoldOptions,
  faceTable: KojoFaceTable,
): string {
  const faceSpec: ScaffoldFaceSpec = {
    stem: spec.stem.replaceAll('{n}', String(opts.charaNo)),
    face: spec.face,
    blurb: spec.blurb,
  };
  return buildScaffoldFaceStub(
    {
      face: faceSpec,
      identity: opts,
      // 本游戏无剧本号 ⇒ 元信息行只有版本与作者
      metaLead: [],
      templateExample:
        spec.face === '' ? null : faceTemplateExample(faceTable, spec.face, opts.charaNo),
      // 说明行里的 `{n}` 是同一个角色编号占位：写注释时替换成真实编号，
      // 免得作者把 `KOJO_COMM_{n}` 原样抄进函数名（引擎不认）。
      alwaysHints: spec.alwaysHints.map((l) => l.replaceAll('{n}', String(opts.charaNo))),
      // 无库内现成案例：eraAkumaMaid 侧尚未做「从语料转写可照抄片段」的案例批，
      // 宁缺勿编（eratw 那 4 条案例是从它自己的语料实测出来的，不可平移）。
      faceCase: null,
    },
    AM_FACE_STUB_EXT,
  );
}

/** 中文 README（骨架由契约层给定，这里只给本游戏的内容） */
export function buildAMReadme(opts: ErakumamaidScaffoldOptions): string {
  const no = opts.charaNo;
  const name = opts.charaName.trim();
  const metaRows = [
    { label: '作者', value: opts.authorName.trim() },
    { label: '版本', value: opts.version.trim() },
    { label: '目标角色', value: `${name}（编号 ${no}）` },
    { label: '目标游戏', value: 'eraAkumaMaid' },
  ];
  if (opts.homepage && opts.homepage.trim()) {
    metaRows.push({ label: '发布页', value: opts.homepage.trim() });
  }

  return buildScaffoldReadme({
    identity: opts,
    title: `《${opts.workName.trim()}》· ${name} 口上包`,
    metaRows,
    intro: ['> 请在这里填写作品介绍：设定、基调、与原版口上的差异点等。'],
    contentNote: [
      '本包由脚手架生成以下文件（空壳内只有 `;` 注释，不含活函数）。'
        + '扩展名是 `.kojo`：糖写法与原始 ERB 写法可以写在同一个文件里，'
        + '部署时会自动转译成游戏认得的 `.ERB`，工作区里始终只有 `.kojo` 这一份源。',
      '目录结构与游戏自带的「新角色追加包」（`口上テンプレート/新キャラ追加用パッケージ`）一致：'
        + '`CSV/` 与 `ERB/` 两棵子树都相对游戏根，整棵覆盖过去即可。',
    ],
    faces: AM_SCAFFOLD_FILES.map((f) => ({
      stem: `ERB/EVENT_K/${no}/${f.stem.replaceAll('{n}', String(no))}`,
      face: f.face,
      blurb: f.blurb,
    })),
    stubExt: AM_FACE_STUB_EXT,
    deployIntro: [
      '编辑器的「部署到游戏目录」会把本包转译后放进游戏目录，产物落在：',
    ],
    deployPath: `${AM_DEPLOY_ROOT}/${no}/`,
    deployNote: [
      `**角色表 CSV 单独落在 \`CSV/CHARA/CHARA${no}.csv\`**（本游戏的角色名字/肩書/学年/`
        + '関係/素质全由这张表声明，缺它游戏里认不到这个角色）。',
      '',
      '（游戏目录默认只读，需先批准写权限；目标已存在时不会覆盖。）',
      '',
      '手工放置也可以：先把 `.kojo` 全部转译成同名 `.ERB`，再把 `CSV/` 与 `ERB/` 两棵子树'
        + '覆盖到游戏根。**直接把 `.kojo` 放进游戏目录是不生效的**——引擎只读 `.ERB`。',
    ],
    licenseNote: [
      '本游戏目录自带 `口上ライセンス一覧.txt`（社区许可一览）。',
      '发布到口上库前请先读它，按其中某一条在包内附上 `LICENSE` 并在此处写明选用了哪一条。',
      '（LTOL 等条款全文不由脚手架代填：条款文本必须是有据可查的原文，擅自转录等于替作者改条款。）',
    ],
  });
}

/** 编号上限（游戏当前 75 个编号目录，留余量给新增；仅作明显输错时的兜底） */
const CHARA_NO_MAX = 9_999;

/**
 * 组装 eraAkumaMaid 口上项目脚手架（纯函数，无 IO）。
 *
 * 产物 `files` 的键是**相对游戏根**的 posix 路径 ⇒ 部署时整棵覆盖。
 * 输入非法时抛中文错（向导已前置校验，此处兜底）。
 */
export function scaffoldErakumamaidProject(
  opts: ErakumamaidScaffoldOptions,
  faceTable: KojoFaceTable = createErakumamaidFaceTable(),
): { dirName: string; files: Record<string, string> } {
  return assembleScaffold({
    identity: opts,
    faces: AM_SCAFFOLD_FILES.map(
      (f): ScaffoldFaceSpec => ({
        stem: `ERB/EVENT_K/${opts.charaNo}/${f.stem.replaceAll('{n}', String(opts.charaNo))}`,
        face: f.face,
        blurb: f.blurb,
      }),
    ),
    stubExt: AM_FACE_STUB_EXT,
    readme: () => buildAMReadme(opts),
    stub: (faceSpec) => {
      const fileSpec = AM_SCAFFOLD_FILES.find(
        (f) => `ERB/EVENT_K/${opts.charaNo}/${f.stem.replaceAll('{n}', String(opts.charaNo))}` === faceSpec.stem,
      );
      // faces 由本文件的 AM_SCAFFOLD_FILES 映射而来 ⇒ 找不到是不可能的；
      // 抛错而非静默兜底，是为了让"映射被改歪"在测试里立刻显形。
      if (!fileSpec) throw new Error(`脚手架文件规格缺失：${faceSpec.stem}`);
      return buildAMFileStub(fileSpec, opts, faceTable);
    },
    extraFiles: () => ({ [amCharaCsvRelPath(opts.charaNo)]: buildErakumamaidCharaCsv(opts) }),
    assertExtra: () => {
      if (!Number.isInteger(opts.charaNo) || opts.charaNo > CHARA_NO_MAX) {
        throw new Error(`角色编号超出本游戏范围（0-${CHARA_NO_MAX}）：${String(opts.charaNo)}`);
      }
    },
  });
}
