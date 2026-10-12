/**
 * 署名 / 授权抽取（2026-10-12 口上项目批 T2「署名·授权一等公民」）。
 *
 * 为什么需要它（讨论纪要 §1 实测）：**署名在 README 正文里，不在目录名上**
 * （`作者 holy / 最終更新 2023-10/07`），且 `ライセンス.txt` 出现频次极高。
 * 国内作者做二次创作 / 汉化时，最容易出的事故就是把原作者丢了。
 *
 * ## 口径：高精度、宁缺勿滥、**给证据不给结论**
 *
 * 本模块**刻意不做**的事：从散文里推断「这个包允不允许再配布」。
 * 语料实测：授权多为散文且无标签
 * （`加筆・改変・再配布等は、金銭がからまず、個人の責任で行う分には随便ください`），
 * 机器猜错的代价是真实的合规事故 —— 所以只报**可核验的事实**：
 * 抽到的字段一律带出处（文件名 + 1 基行号），界面把原文摆出来让用户自己判断。
 *
 * 三条从真实语料 dump 里学到的硬规则（别凭直觉改）：
 * 1. **模板占位要按「待填说明语句在不在」判，不能按尖括号判**：
 *    `作者：＜作者名・連絡先＞（…他人と被らないものを）` 是没填过的模板，
 *    但 `作者：＜さもま＞` 是作者把真名填进了模板括号里 —— 只按 `＜＞` 判会漏真署名；
 * 2. **「作者」二字也出现在散文里**（`作者は本口上が処女口上です`）—— 必须要求冒号分隔才算标签；
 * 3. **`ライセンステンプレ(ート).txt` 全语料出现 67 次，是空模板**，
 *    与真声明 `ライセンス.txt`（45 次）必须分开计，否则「已标注授权」全是假阳性。
 *    （2026-10-12 实测：214 包里真声明 54 / 仅模板 66 —— 混算会把 25% 报成 55%。）
 */

/** 抽取到的字段（带出处，供 UI 呈现原文） */
export interface AttributionField {
  value: string;
  /** 出处文件名（不含路径） */
  file: string;
  /** 1 基行号 */
  line: number;
}

/** 授权标注文件的形态（**只报形态，不判条款**） */
export type LicenseSignal =
  | { kind: 'statement'; file: string }
  | { kind: 'template-only'; file: string }
  | { kind: 'none' };

/** 一个作者包的署名 / 授权画像 */
export interface PackageAttribution {
  author: AttributionField | null;
  /** 更新日期或版本号（任一命中即有；标签优先） */
  updated: AttributionField | null;
  license: LicenseSignal;
  /** 包内识别到的 readme 类文件名（没抽到字段时也提示用户自己看） */
  readmeFiles: string[];
}

/** 附属文件角色 */
export type AuxFileKind = 'readme' | 'license' | 'license-template' | 'changelog';

/**
 * 署名读取态（插件闭包缓存值）：在途 / 已加载 / null = 读失败已降级为「未标注」。
 * 与面板的 `DirListState` 同形——都是"惰性 + 缓存 + 不静默"的三态。
 */
export type AttributionState = PackageAttribution | 'loading' | null;

/* ------------------------------ 文件名分类 ------------------------------ */

/**
 * readme 类文件名特征。
 *
 * 真实形态（语料 dump 得来，别以为只有 README.txt）：
 * `readme.txt` / `Read Me.txt` / `read me.txt`（带空格）/ `read_me.txt` /
 * `readme(2023.2.1).txt`（带日期）/ 带前缀 `霊夢さんのreadme` `無個性版readme`。
 *
 * **平假名谐音形态繁多，必须宽松匹配而非枚举**——实测存在的有 `れあどめ` `れあどみ`
 * `りどみ` `りーどみすちー` `れどめ`：长音 `ー` 可现可不现、`あ` 可省、尾字符 `め/み` 两写，
 * 故用 `[れり]ー?あ?ど[めみ]` 一条通吃。中文侧另有 `读我` `讀我` 与各类 `…说明`
 * （`口上说明` / `汉化说明` / `使用说明书`）。
 */
const README_PATTERN =
  /read\s*_?\s*me|^\s*readme|[れり]ー?あ?ど[めみ]|讀?読め|よめ|读我|讀我|说明|說明|搬运工的话|譯者之言|译者之言/i;

/** 授权类文件名；模板与真声明分开（见文件头规则 3） */
const LICENSE_TEMPLATE_PATTERN = /テンプレ|template|模板|樣本|样本/i;
const LICENSE_PATTERN = /ライセンス|license|lisence|许可证|许可|授權|授权|版权声明|著作権/i;

/**
 * 更新历史类文件名。
 *
 * 「履歴」在语料里有**异体字**：`更新履歴`（歴）与 `更新履历`（履）都真实存在，
 * 只写一个必漏一半；`情報/情报` 简繁两路同理。
 */
const CHANGELOG_PATTERN =
  /更新[歷历]?[履歴履历記记]|更新日志|更新記錄|更新情报|更新情報|改版[歷历]?[履歴履历記记]|changelog|change\s*log|汉化日志|汉化记录/i;

/**
 * 附属文件（非 ERB）在包里的角色分类；无关文件 → null。
 *
 * **readme 先判**：语料里存在 `Readme！（原ライセンス）.txt` 这种同时含两类 token 的名字，
 * 它实质是 readme；若 license 先判会被误归授权文件。
 * 模板则须先于真声明（`ライセンステンプレート.txt` 同时命中两者，语料规则 3）。
 */
export function classifyAuxFile(fileName: string): AuxFileKind | null {
  if (README_PATTERN.test(fileName)) return 'readme';
  if (CHANGELOG_PATTERN.test(fileName)) return 'changelog';
  if (LICENSE_TEMPLATE_PATTERN.test(fileName)) return 'license-template';
  if (LICENSE_PATTERN.test(fileName)) return 'license';
  // 无扩展名的 `HOGE`（21 次，占位反例）等一律不猜
  return null;
}

/* ------------------------------ 正文解析 ------------------------------ */

/**
 * 模板自带的「待填说明」语句。出现即说明这一行作者**根本没动过**（语料规则 1 的精确版）。
 *
/**
 * 模板自带的「待填说明」语句。出现即说明这一行作者**根本没动过**（语料规则 1 的精确版）。
 *
 * 官方ライセンス模板长这样：
 * `作者：＜猫のごろごろ＞（“XXスレ目>>123” 等でもOKなので、何か他人と被らないものを）`
 * —— `＜…＞` 里是模板示例名，后面还挂着说明括注。
 * 而作者真填过的会剩下 `作者：＜さもま＞`（说明括注被删了，只剩包裹名号的尖括号）。
 * 所以判据是**说明语句在不在**，不是尖括号在不在：只按尖括号判会把真署名一起漏掉。
 *
 * **汉化版模板把那句说明也翻译了**（实测：`＜猫呼噜＞(“XX条目>>123”等也OK，请不要和
 * 别人的方式相重合)`），故光列日文词不够 —— 另加三个**语言无关**的模板指纹：
 * `>>数字`（论坛回帖号）、`XXスレ/XX条目`、`等でもOK/等也OK`。
 */
const TEMPLATE_INSTRUCTION =
  /作者名|連絡先|他人と被らない|記入し?てください|改変者的名前|改変者の名前|your\s*name|请填写|待填|未定|未記入|>>\s*\d{2,}|XXスレ|XX条目|等でも ?OK|等也 ?OK|不要和别人|相重合/i;

/** 作者标签：必须带冒号（语料规则 2 —— `作者は〜です` 这类散文不算） */
const AUTHOR_LABEL_PATTERN = /(?:原作者|作者|作成者|著者|制作者|Author|author)\s*[:：]\s*(.+)$/;

/** 更新日期标签 */
const UPDATED_LABEL_PATTERN = /(?:最終更新|最后更新|最終更新日|更新日|更新日期|Date|date)\s*[:：]\s*(.+)$/;

/** 裸日期（`2023-10-07` / `2023/10/07` / `2023.10.07`，年份限 19xx-20xx 防版本号误命中） */
const BARE_DATE_PATTERN = /\b(19|20)\d{2}\s*[-/.,]\s*\d{1,2}\s*[-/.,]\s*\d{1,2}\b/;

/** 版本号（`ver0.965` / `ver.2.0` / `ver,0.03`（语料里真有逗号笔误）/ `Version 1.2`）
 *  `\b` 防 `cover 3` 之类词内误命中；CJK 与拉丁交界处 JS 的 \b 成立，故 `口上ver0.16` 能中。 */
const VERSION_PATTERN = /\bver(?:sion)?\s*[.:,，]?\s*(\d+(?:\.\d+)*)/i;

/** 行首注释符（ERB 风格 README 用 `;` 起头）与装饰线，去掉后再匹配 */
function cleanLine(raw: string): string {
  return raw.replace(/^\s*(?:[;；]\s*)+/, '').replace(/\s+$/, '').trim();
}

/** 值侧清理：丢行内注释尾巴，再丢前导装饰（制表符 / `->` / 箭头 / 中黑点）与尾部句读。
 *  语料里 `作者：\t-> 全人類ノ天空録` 是**真署名**，箭头只是排版装饰，该清不该拒。
 *  尾部还要吃下 README 表格的制表线（`…（小町口上作者）      │`）—— 这值要上界面，
 *  留个 `│` 尾巴看着就像渲染坏了。 */
function cleanValue(v: string): string {
  return v
    .split(/\s{2,}[;；]/)[0]!
    .replace(/^[\s\-–—→>、,，•・|]+/, '')
    .replace(/[\s。、,，|｜│┃║┆┇]+$/, '')
    .trim();
}

/**
 * 作者值判定 + 归一；返回 null = 不采纳（宁缺勿滥）。
 *
 * 顺序有讲究：**先按"待填说明语句"对整值判否**（此时括注还在），**再**剥掉包裹名号的
 * 尖括号。反过来先剥括号，模板示例名就逃过检测了。
 */
function normalizeAuthor(raw: string): string | null {
  const v = cleanValue(raw);
  if (v.length === 0) return null;
  if (TEMPLATE_INSTRUCTION.test(v)) return null;
  const core = v.replace(/^[<＜](.*?)[>＞]$/, '$1').trim();
  // 过短多半是符号，过长多半是整句散文 —— 都不采纳
  if (core.length < 2 || core.length > 40) return null;
  return core;
}

/** 单个候选字段（解析中间态） */
interface Candidate {
  value: string;
  line: number;
  /** 标签命中 = 1，裸日期/版本 = 2（同级内靠前优先） */
  rank: number;
}

/**
 * 解析一份附属文件的正文，抽出作者 / 更新 / 版本候选。
 *
 * 纯函数、零 IO。`file` 只用于回填出处。
 * 采纳顺序：**标签命中优先于裸匹配**，同级内取**首次出现**（README 头部惯例是署名区）。
 */
export function parseAttributionText(
  file: string,
  text: string,
): Pick<PackageAttribution, 'author' | 'updated'> {
  const lines = text.split(/\r?\n/);

  const authorCands: Candidate[] = [];
  const dateCands: Candidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = cleanLine(lines[i]!);
    if (line.length === 0) continue;
    const lineNo = i + 1;

    // 无冒号的「作者」一律不猜（语料规则 2）——宁可漏，不可错
    const am = AUTHOR_LABEL_PATTERN.exec(line);
    if (am) {
      const v = normalizeAuthor(am[1]!);
      if (v !== null) authorCands.push({ value: v, line: lineNo, rank: 1 });
    }

    const um = UPDATED_LABEL_PATTERN.exec(line);
    if (um) {
      const v = cleanValue(um[1]!);
      if (v.length >= 4 && !/^[<＜(（[]/.test(v)) dateCands.push({ value: v, line: lineNo, rank: 1 });
      continue;
    }
    const bare = BARE_DATE_PATTERN.exec(line);
    if (bare) {
      dateCands.push({ value: cleanValue(bare[0]), line: lineNo, rank: 2 });
      continue;
    }
    const ver = VERSION_PATTERN.exec(line);
    if (ver) dateCands.push({ value: `ver${ver[1]}`, line: lineNo, rank: 2 });
  }

  const pick = (list: Candidate[]): AttributionField | null => {
    if (list.length === 0) return null;
    const best = [...list].sort((a, b) => a.rank - b.rank || a.line - b.line)[0]!;
    return { value: best.value, file, line: best.line };
  };

  return { author: pick(authorCands), updated: pick(dateCands) };
}

/* ------------------------------ 包级编排 ------------------------------ */

/** 单文件读取上限（README 再长也不该整份进内存；语料里最长的署名信息都在头部） */
const MAX_READ_CHARS = 8000;

/** 最多读几份 readme 候选（防异常包把请求打爆） */
const MAX_READ_FILES = 3;

/**
 * 读取一个包目录的署名 / 授权画像。
 *
 * 只读列举 + 只读文本（`io.readText` 自带编码探测 —— README 可能是 Shift-JIS，
 * 用 readBytes 手工解码会踩编码坑）。源目录**绝不改动**。
 * 单个文件读失败不影响整体（记下来继续，最后 readmeFiles 仍呈现）。
 */
export async function readPackageAttribution(deps: {
  io: { listDir(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>>; readText(path: string): Promise<{ text: string }> };
  absDir: string;
}): Promise<PackageAttribution> {
  const entries = await deps.io.listDir(deps.absDir);
  const files = entries.filter((e) => !e.isDirectory);

  const readmeFiles: string[] = [];
  const licenseFiles: string[] = [];
  let templateOnly: string | null = null;

  for (const f of files) {
    const kind = classifyAuxFile(f.name);
    if (kind === 'readme' || kind === 'changelog') readmeFiles.push(f.name);
    else if (kind === 'license') licenseFiles.push(f.name);
    else if (kind === 'license-template' && templateOnly === null) templateOnly = f.name;
  }

  // 授权只报形态：有真声明 > 只有空模板 > 没有
  const license: LicenseSignal =
    licenseFiles.length > 0
      ? { kind: 'statement', file: licenseFiles[0]! }
      : templateOnly !== null
        ? { kind: 'template-only', file: templateOnly }
        : { kind: 'none' };

  // 读 readme 候选正文（readme 优先于 changelog：署名通常在 readme 头部）
  let author: AttributionField | null = null;
  let updated: AttributionField | null = null;
  for (const name of readmeFiles.slice(0, MAX_READ_FILES)) {
    const path = files.find((f) => f.name === name)?.path;
    if (!path) continue;
    let text: string;
    try {
      text = (await deps.io.readText(path)).text.slice(0, MAX_READ_CHARS);
    } catch {
      continue; // 读不动就跳过这份，不整体失败
    }
    const parsed = parseAttributionText(name, text);
    if (author === null && parsed.author) author = parsed.author;
    if (updated === null && parsed.updated) updated = parsed.updated;
    if (author !== null && updated !== null) break;
  }

  return { author, updated, license, readmeFiles };
}

/* ------------------------------ 呈现文案 ------------------------------ */

/** 授权形态 → 中文标签（**只描述文件形态，不判条款**） */
export function licenseLabel(sig: LicenseSignal): string {
  switch (sig.kind) {
    case 'statement':
      return `有授权声明文件（${sig.file}）`;
    case 'template-only':
      return `仅授权模板（${sig.file}，未见作者填写）`;
    case 'none':
      return '未见授权相关文件';
  }
}

/** 一行式摘要（面板展开态 / 导入向导预览用） */
export function attributionSummary(a: PackageAttribution): string {
  const parts: string[] = [];
  parts.push(a.author ? `原作者 ${a.author.value}` : '原作者未标注');
  if (a.updated) parts.push(`更新 ${a.updated.value}`);
  parts.push(licenseLabel(a.license));
  return parts.join(' · ');
}

/**
 * 制品 meta 用的扁平署名信息（导入时携带，见 import-wizard）。
 *
 * 只落**抽到的**键（不写 null 占位）；出处行号不进 meta——meta 是持久档案，
 * 行号会随作者改 README 失效，要核验现读现取（面板那条就是现读的）。
 */
export function attributionMeta(a: PackageAttribution | null): Record<string, unknown> {
  if (!a) return {};
  const meta: Record<string, unknown> = {};
  if (a.author) meta.originalAuthor = a.author.value;
  if (a.updated) meta.originalUpdated = a.updated.value;
  if (a.license.kind !== 'none') {
    meta.licenseKind = a.license.kind;
    meta.licenseFile = a.license.file;
  }
  return meta;
}
