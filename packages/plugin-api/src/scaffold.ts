/**
 * 口上项目脚手架的**共享骨架**（游戏无关；2026-10-18 AM-1 P4 抽取）。
 *
 * ## 为什么住在契约层
 *
 * 脚手架在 eraTW 侧先落地（`eratw-adapter/src/scaffold.ts`，2026-10-12 口上项目批 P-C）。
 * 接入第二个游戏时，向导族面临"复制一份"vs"抽共享骨架"——项目负责人 2026-10-18 拍板
 * **抽共享骨架**：两适配器共用同一份装配逻辑，本适配器只通过契约向骨架**供数**。
 *
 * 抽的判据是"**去掉游戏名词还成立吗**"：目录名消毒、`{作品}-{角色} v{版本}` 命名、
 * 空壳注释的分段与尾注、README 的骨架（元信息表 / 面清单 / 部署块 / 许可块）、
 * 输入兜底校验——这些与哪个 era 游戏无关，故住这里；**面清单、分野表模板、
 * 库内现成案例、部署路径与放置规则、许可条款文本**是游戏知识，一律由 adapter 注入。
 *
 * 因此本模块**不含任何游戏名、口上前缀、具体旗标**（`tools/audit-decoupling.mjs`
 * 的 A 项守着这条线）。许可条款（LTOL 等）仍留在 adapter：它是 era 社区的圈内约定，
 * 见 `eratw-adapter/src/licenses.ts` 头注的既定决定；骨架只接收渲染好的许可段落文本。
 *
 * ## 一条纪律：**空壳只放注释，不生成活函数**
 *
 * 活函数由作者写，工具不替作者做决定。`buildScaffoldFaceStub` 只产出 `;` 注释行，
 * 作者在注释之后开始创作。两个适配器都受这条约束（各自测试钉住"无非注释行"）。
 */

import type { KojoFaceTable } from './game';

/** 面规格（文件名干 + 分野表键 + 一句话说明） */
export interface ScaffoldFaceSpec {
  /** 文件名干（不含扩展名） */
  readonly stem: string;
  /** 对应分野表键（取函数名模板用） */
  readonly face: string;
  /** 一句话说明（进注释与 README） */
  readonly blurb: string;
}

/**
 * 库内现成案例（从真实口上库转写的可照抄片段）。
 *
 * 只收"投影即可写、正文 ≤10 行"的案例，宁缺勿编：作者会照抄，编出来的示例
 * 会把错误写法扩散出去。
 */
export interface ScaffoldFaceCase {
  /** 口上库内相对路径（相对剧本根，逐字照抄，可回去抽查） */
  readonly source: string;
  /** 来源函数名（含 `@`） */
  readonly fn: string;
  /** 台词类目占位（如「涩涩的话」／「日常的对话」） */
  readonly category: string;
  /** 转糖后的案例正文（逐行，未加 `; ` 前缀） */
  readonly lines: readonly string[];
}

/** 脚手架的通用身份字段（两游戏一致的部分） */
export interface ScaffoldIdentity {
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
}

/** README 元信息表的一行 */
export interface ScaffoldMetaRow {
  readonly label: string;
  readonly value: string;
}

/** 分野表模板里的占位符说明（只在示例里真出现时才渲染） */
export interface ScaffoldTemplateHint {
  /** 占位符原样（如 `{i}`、`${com}`） */
  readonly token: string;
  /** 说明文本（不含占位符与本行缩进） */
  readonly text: string;
}

/** 单面空壳的渲染输入 */
export interface ScaffoldStubSpec {
  readonly face: ScaffoldFaceSpec;
  readonly identity: ScaffoldIdentity;
  /**
   * 元信息行第一段的各段内容（`; ` 之后、`· 版本 …` 之前）。
   * eraTW 给 `['剧本1']`，eraAkumaMaid 无剧本概念 ⇒ 空数组（只留版本与作者）。
   */
  readonly metaLead: readonly string[];
  /** 函数形态示例（已代入角色号）；`null` = 该面在分野表里没有模板 */
  readonly templateExample: string | null;
  /** 模板占位符说明（按示例里实际出现的占位符筛选后渲染） */
  readonly templateHints?: readonly ScaffoldTemplateHint[];
  /** 与占位符无关、恒输出的说明行（如家族段插法）；`undefined` = 本游戏无此概念 */
  readonly alwaysHints?: readonly string[];
  /** 库内现成案例；`null` = 该面无案例（整块不输出，不留空头） */
  readonly faceCase: ScaffoldFaceCase | null;
  /** 案例之后的收尾说明；`undefined` 用共享默认句 */
  readonly caseFooter?: readonly string[];
  /** 「空壳文件」尾注段；`undefined` 用共享默认段 */
  readonly tailNotes?: readonly string[];
}

/** 脚手架产物：包目录名 + 文件集（相对路径 → 文本内容） */
export interface ScaffoldFileSet {
  readonly dirName: string;
  readonly files: Record<string, string>;
}

/**
 * 文件系统非法字符消毒（单层目录段）：
 * 剔除 `\/:*?"<>|` 与控制字符，压缩连续空白，去首尾空白与尾随点号
 * （Windows 目录名不得以点/空格结尾）。合法字符一律保留（含中日文、空格）。
 */
export function sanitizePathSegment(value: string): string {
  return value
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** 包目录名：`{作品名}-{角色名} v{版本}`（逐段消毒后拼接） */
export function buildScaffoldDirName(
  o: Pick<ScaffoldIdentity, 'workName' | 'charaName' | 'version'>,
): string {
  return `${sanitizePathSegment(o.workName)}-${sanitizePathSegment(o.charaName)} v${sanitizePathSegment(o.version)}`;
}

/**
 * 面模板示例：代入角色号，清掉家族段占位（空家族 = 本角色版），
 * 保留 `{i}` / `${com}` 一类占位**原样**供作者看形态。
 */
export function faceTemplateExample(
  faceTable: KojoFaceTable,
  face: string,
  charaNo: number,
): string | null {
  const template = faceTable.faces[face]?.template;
  if (!template) return null;
  return template.replaceAll('{t}', '').replaceAll('{n}', String(charaNo));
}

/** 空壳尾注默认段（两游戏一致：只有注释、不生成活函数） */
const DEFAULT_TAIL_NOTES: readonly string[] = [
  '—— 脚手架生成的空壳文件：只有注释，没有活函数 ——',
  '请在下方开始创作（ERB 函数定义以 @ 开头）。',
];

/** 案例之后默认收尾句里的扩展名占位（`{.kojo}` 由调用方给的 ext 替换） */
const DEFAULT_CASE_FOOTER = '上面的编号与角色号来自那份现成口上，照你自己要写的场合改；写法详见「{ext} 语言教程」。';

/**
 * 单面空壳内容（纯 `;` 注释；**不生成任何活函数**）。
 *
 * 段落次序：标题 → 元信息 → 面说明 → 函数形态（含占位符说明）→ 库内现成案例 → 尾注。
 * 任一段的输入为 `null`/空即整段不输出——不留空头（"宁缺勿编"的同一口径）。
 */
export function buildScaffoldFaceStub(spec: ScaffoldStubSpec, stubExt: string): string {
  const { face, identity } = spec;
  const lines: string[] = [];
  const lead = spec.metaLead.filter((s) => s.length > 0);
  lines.push(`; 《${identity.workName.trim()}》· ${identity.charaName.trim()}（K${identity.charaNo}）— ${face.stem}`);
  const metaParts = [...lead, `版本 ${identity.version.trim()}`, `作者：${identity.authorName.trim()}`];
  lines.push(`; ${metaParts.join(' · ')}`);
  lines.push(';');
  lines.push(`; 【面说明】${face.blurb}`);
  if (spec.templateExample) {
    lines.push(`; 【函数形态】${spec.templateExample}`);
    for (const hint of spec.templateHints ?? []) {
      if (!spec.templateExample.includes(hint.token)) continue;
      lines.push(`;   ${hint.token} = ${hint.text}`);
    }
  }
  // 恒输出说明：**不寄在函数形态段里**——有的游戏某些面没有分野表模板，
  // 却同样要告诉作者"这个文件里该写哪些函数"（如 eraAkumaMaid 的分文件布局）。
  for (const always of spec.alwaysHints ?? []) lines.push(`;   ${always}`);
  if (spec.faceCase) {
    const c = spec.faceCase;
    lines.push(';');
    lines.push(`; 【库内现成案例】照抄 ${c.source}`);
    lines.push(`; 的 ${c.fn}，已用本工具转成 ${stubExt} 写法，台词简化为类目占位。`);
    for (const caseLine of c.lines) lines.push(caseLine.length > 0 ? `; ${caseLine}` : ';');
    const footer = spec.caseFooter ?? [DEFAULT_CASE_FOOTER.replace('{ext}', stubExt)];
    for (const f of footer) lines.push(`; ${f}`);
  }
  lines.push(';');
  for (const note of spec.tailNotes ?? DEFAULT_TAIL_NOTES) lines.push(`; ${note}`);
  return `${lines.join('\n')}\n`;
}

/** README 渲染输入 */
export interface ScaffoldReadmeSpec {
  readonly identity: ScaffoldIdentity;
  /** 一级标题（不含 `# `） */
  readonly title: string;
  /** 元信息表的行（作者 / 版本 / 目标角色 已由适配器给全） */
  readonly metaRows: readonly ScaffoldMetaRow[];
  /** 「简介」段的正文行 */
  readonly intro: readonly string[];
  /** 「内容」段开头的说明行 */
  readonly contentNote: readonly string[];
  readonly faces: readonly ScaffoldFaceSpec[];
  readonly stubExt: string;
  /** 「部署」段开头的说明行 */
  readonly deployIntro: readonly string[];
  /** 部署目标路径（单行，进代码块） */
  readonly deployPath: string;
  /** 部署块之后的补充说明行 */
  readonly deployNote: readonly string[];
  /** 「许可」段的正文行（条款知识在 adapter，骨架只排版） */
  readonly licenseNote: readonly string[];
}

/** 中文 README 模板（段落次序与两游戏共用） */
export function buildScaffoldReadme(spec: ScaffoldReadmeSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title}`);
  lines.push('');
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  for (const row of spec.metaRows) lines.push(`| ${row.label} | ${row.value} |`);
  lines.push('');
  lines.push('## 简介');
  lines.push('');
  for (const l of spec.intro) lines.push(l);
  lines.push('');
  lines.push('## 内容');
  lines.push('');
  for (const l of spec.contentNote) lines.push(l);
  lines.push('');
  for (const f of spec.faces) lines.push(`- \`${f.stem}${spec.stubExt}\` — ${f.blurb}`);
  lines.push('');
  lines.push('## 部署');
  lines.push('');
  for (const l of spec.deployIntro) lines.push(l);
  lines.push('');
  lines.push('```');
  lines.push(spec.deployPath);
  lines.push('```');
  lines.push('');
  for (const l of spec.deployNote) lines.push(l);
  lines.push('');
  lines.push('## 许可');
  lines.push('');
  for (const l of spec.licenseNote) lines.push(l);
  return `${lines.join('\n')}\n`;
}

/** 通用输入兜底校验（中文消息；向导已前置校验，此处兜底） */
export function assertScaffoldIdentity(identity: ScaffoldIdentity): void {
  if (!identity.workName.trim()) throw new Error('作品名不能为空');
  if (!identity.authorName.trim()) throw new Error('作者名不能为空');
  if (!identity.version.trim()) throw new Error('版本不能为空');
  if (!identity.charaName.trim()) throw new Error('角色名不能为空');
  if (!Number.isInteger(identity.charaNo) || identity.charaNo < 0) {
    throw new Error(`角色编号非法：${String(identity.charaNo)}`);
  }
}

/** 装配输入：骨架只做"校验 + 拼文件表"，内容由 adapter 的构件函数产出 */
export interface ScaffoldParts {
  readonly identity: ScaffoldIdentity;
  readonly faces: readonly ScaffoldFaceSpec[];
  readonly stubExt: string;
  /** README 内容（惰性：只在真装配时求值） */
  readonly readme: () => string;
  /** 单面空壳内容 */
  readonly stub: (face: ScaffoldFaceSpec) => string;
  /** 附加文件（如游戏要求的角色表 CSV）；`undefined` = 无 */
  readonly extraFiles?: () => Record<string, string>;
  /** 游戏特有的附加校验（如剧本号区间）；`undefined` = 无 */
  readonly assertExtra?: (identity: ScaffoldIdentity) => void;
}

/**
 * 组装完整脚手架产物。
 *
 * 键次序：`README.md` → 附加文件 → 各面空壳（`faces` 的顺序即生成顺序）。
 * 附加文件刻意排在空壳之前：游戏要求的**声明类文件**（角色表等）比作者创作的
 * 台词文件更"基础设施"，作者在文件树里从上往下看时先看到它更合直觉。
 */
export function assembleScaffold(parts: ScaffoldParts): ScaffoldFileSet {
  assertScaffoldIdentity(parts.identity);
  parts.assertExtra?.(parts.identity);

  const files: Record<string, string> = {};
  files['README.md'] = parts.readme();
  for (const [name, text] of Object.entries(parts.extraFiles?.() ?? {})) files[name] = text;
  for (const face of parts.faces) files[`${face.stem}${parts.stubExt}`] = parts.stub(face);

  return { dirName: buildScaffoldDirName(parts.identity), files };
}
