/**
 * eraFL 口上脚手架 —— **纯函数、不写盘**：给定角色编号与名称，产出两份文件的
 * 「相对游戏根路径 + 内容」，由调用方（工作区/部署链路）决定落到哪里。
 *
 * ## 为什么是**两个**文件（这是 eraFL 与 eraTW/eraAkumaMaid 的结构差异）
 *
 * eraFL 的口上主体是 **XML**，ERB 侧只有一个注册壳：`KOJO_DEFINE_K{n}` 里把
 * `XML_PATH_COM` 常量交给 `KOJO_XML_REGISTER`。引擎 `@FL_INIT_LOADER` 逐个调用
 * `KOJO_DEFINE_K0..5999`（`ERB/SYSTEM/FL_INIT_LOADER.ERB`），所以：
 * **只给 XML 不给 define 壳 = 这份口上永远不会被加载**。两份必须成对出现。
 *
 * ## 形态照真盘 `ERB/口上/1099_うふふお姉さん/KOJO_DEFINE_K1099.ERB`
 *
 * - 编码 **UTF-8 BOM + CRLF**：真盘 ERB 与 XML 都是这个形态（`1099` 两份实测），
 *   跟着走能避免作者用别的编辑器改一行就整文件重排；
 * - `#DIMS CONST XML_PATH_COM`（**DIMS**，字符串常量）与 `#DIM CONST 汎用口上番号`（数值）；
 * - `CALL KOJO_XML_REGISTER(XML_PATH_COM, 汎用口上番号, XMLID_KOJO_CLASS_COM)`；
 * - `KOJO_DEFINE_NAME_K{n}` 用 `RESULTS '= "…"` 返回显示名（口上选择画面读它）。
 *
 * ## XML 侧
 *
 * `<?xml …?>` + `<data>` + 一条 `<command com="300" name="会話" kojoPlace="TOP" priority="1">`
 * （`com=300` 会話 是 `CSV/Train.csv` 的 0 号指令之外的固定「会話」编号，见
 * `src/kojo-xml/schema.ts` 的 `KOJO_XML_SYMBOL_COMMANDS`），2 空格缩进、CRLF。
 * 只给一条能跑通的最小条目：多写几条空壳只会让作者先删后写。
 */

/** 脚手架输入（向导字段一一对应） */
export interface EraflKojoScaffoldInput {
  /** 角色编号：引擎只扫 `KOJO_DEFINE_K0..5999`，超出这个范围的 define 永远不会被调用 */
  charaNo: number;
  /** 角色显示名（同时决定口上目录名 `{编号}_{名称}` 与 XML 文件名 `{名称}口上.xml`） */
  charaName: string;
  /** 口上选择画面里的显示名（`KOJO_DEFINE_NAME_K{n}` 的返回值）；缺省 = 角色显示名 */
  kojoName?: string;
  /** 男性角色可用（`KOJO_FOR_MALE_K{n}` 返回 1）；缺省 false */
  forMale?: boolean;
  /** 女性角色可用（`KOJO_FOR_FEMALE_K{n}` 返回 1）；缺省 true（照真盘 1099 模板） */
  forFemale?: boolean;
}

/** 脚手架产物：键 = **相对游戏根**的 posix 路径（整棵覆盖到游戏根即可用） */
export interface EraflKojoScaffoldResult {
  files: Record<string, string>;
  notes: string[];
}

/** 引擎 `@FL_INIT_LOADER` 的扫描上界（含）：`KOJO_DEFINE_K0..5999` */
const DEFINE_NO_MAX = 5999;

/**
 * 目录名消毒：Windows 不允许的字符一律换成 `_`。
 *
 * 为什么不直接拒绝：目录名来自角色显示名（`ティア`、`奥蕾西娅` 这类），作者改一个
 * 全角冒号就整份脚手架失败太苛刻；而**换掉一个字符**比"静默删掉后半截"更容易被发现。
 */
function safeSegment(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
}

/**
 * 口上显示名消毒：`"` 会截断 Emuera 字符串字面量，`;` 会把它变成注释尾巴。
 * 两者都会让 `RESULTS '= "…"` 变成语法错误，故直接剔除（而不是转义——Emuera 没有通用转义）。
 */
function safeDisplayName(name: string): string {
  return name.replace(/[";]/g, '').replace(/[\r\n]/g, ' ').trim();
}

/**
 * 生成 eraFL 新角色口上骨架（两份文件，**不写盘**）。
 *
 * @throws 输入非法（编号不是 0..5999 的整数 / 名称为空）时抛中文错——
 *         向导已前置校验，这里兜底：宁可在生成前失败，也不要产出一份引擎不认的目录。
 */
export function scaffoldEraflKojo(input: EraflKojoScaffoldInput): EraflKojoScaffoldResult {
  const no = input.charaNo;
  if (!Number.isInteger(no) || no < 0 || no > DEFINE_NO_MAX) {
    throw new Error(`角色编号必须是 0-${DEFINE_NO_MAX} 的整数（引擎只扫 KOJO_DEFINE_K0..${DEFINE_NO_MAX}）：${String(no)}`);
  }
  const name = safeSegment(input.charaName);
  if (name.length === 0) throw new Error('角色名称不能为空（它同时决定口上目录名与 XML 文件名）');

  const display = safeDisplayName(input.kojoName ?? input.charaName) || name;
  const male = input.forMale === true ? 1 : 0;
  const female = input.forFemale === false ? 0 : 1;

  const dirName = `${no}_${name}`;
  const xmlRel = `ERB/口上/${dirName}/${name}口上.xml`;
  const defineRel = `ERB/口上/${dirName}/KOJO_DEFINE_K${no}.ERB`;

  /**
   * define 壳：注释头照真盘 1099 逐行同形（日文原样保留——它是游戏作者写给作者的说明，
   * 翻译过来反而让作者对不上自己那份文件）。`XML_PATH_COM` 是**相对游戏根**的路径，
   * 与目录名强绑定：改目录名必须同步改这一行（`notes` 里也再提一次）。
   */
  const defineLines = [
    ';-------------------------------------------------',
    '; @FL_INIT_LOADER から呼ばれる口上初期読み込み',
    ';-------------------------------------------------',
    `@KOJO_DEFINE_K${no}`,
    `#DIMS CONST XML_PATH_COM = "${xmlRel}"`,
    `#DIM CONST 汎用口上番号 = ${no}`,
    '',
    'CALL KOJO_XML_REGISTER(XML_PATH_COM, 汎用口上番号, XMLID_KOJO_CLASS_COM)',
    'RETURN 1',
    '',
    ';口上選択画面の表示名',
    `@KOJO_DEFINE_NAME_K${no}`,
    `RESULTS '= "${display}"`,
    'RETURN 1',
    '',
    ';男性キャラ向け口上 (0:非対応, 1:対応)',
    `@KOJO_FOR_MALE_K${no}`,
    `RETURN ${male}`,
    '',
    ';女性キャラ向け口上 (0:非対応, 1:対応)',
    `@KOJO_FOR_FEMALE_K${no}`,
    `RETURN ${female}`,
  ];

  /**
   * XML：一条最小可跑条目。`name="会話"` 与 `com="300"` 是语料里最常见的组合
   * （`KOJO_XML_SYMBOL_COMMANDS` 的 300 = 会話），`kojoPlace="TOP"` = 台词出现在开场。
   * 正文只放一个占位，作者第一件事必然是把它换成自己的台词。
   */
  const xmlLines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<data>',
    '  <command com="300" name="会話" kojoPlace="TOP" priority="1">',
    '    <contents>「……」</contents>',
    '  </command>',
    '</data>',
  ];

  const notes = [
    `两份文件必须放在同一个目录（${dirName}/）：define 里的 XML_PATH_COM 是**相对游戏根**的路径，改目录名要同步改这一行。`,
    `引擎 @FL_INIT_LOADER 只扫 KOJO_DEFINE_K0..${DEFINE_NO_MAX}：编号超出范围的 define 永远不会被调用，XML 也就永远不会被加载。`,
    '单独把 XML 放进 ERB/口上 是不生效的——引擎只通过 KOJO_DEFINE_K{n} 里的 KOJO_XML_REGISTER 打开它。',
    `KOJO_FOR_MALE_K${no}=${male} / KOJO_FOR_FEMALE_K${no}=${female}：两个都是 0 时这个口上在任何角色身上都选不到。`,
    '产物是 UTF-8 BOM + CRLF（与真盘一致）。XML 声明写了 encoding="utf-8" 就必须真的存成 UTF-8：真盘有 9 份是 UTF-16 却声明 utf-8。',
    '5xxx 段是主人公口上；普通角色请用 1–4 位编号，并确认 CSV/Chara 里有同编号的角色。',
  ];

  return {
    files: {
      [defineRel]: `\uFEFF${defineLines.join('\r\n')}\r\n`,
      [xmlRel]: `\uFEFF${xmlLines.join('\r\n')}\r\n`,
    },
    notes,
  };
}
