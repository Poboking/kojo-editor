/**
 * 口上项目脚手架（2026-10-12 口上项目批 P-C；纯函数，可单测）。
 *
 * 职责：新建口上项目向导的**落盘内容生成**——中文命名、中文文案：
 * - 包目录名：`{作品名}-{角色名} v{版本}`（文件系统非法字符消毒）；
 * - 中文 README 模板（作品信息 + 面清单 + 部署说明）；
 * - 8 核心面**空壳**（事件/日常指令/性交指令/奉仕指令/爱抚指令/绝顶/刻印取得/性骚扰指令）——
 *   内容纯 `;` 注释，**绝不生成活函数**（活函数由作者写，工具不替作者做决定）；
 * - **不生成四件套文件**（登记/配色/开关等是函数级产物，属作者后续创作）。
 *
 * ## 为什么核心面空壳是 `.kojo` 而不是 `.ERB`（用户反馈 1，2026-10-12）
 *
 * `.kojo` 是**超集**：语法糖与原始 ERB 写法可以在同一个文件里混排（原生语句按规范
 * 逐行透传），而 `.ERB` 只能写原生。新建项目时作者还没决定要用哪种，所以脚手架
 * 一律给 `.kojo`——**先不要替作者收窄表达**。导出/部署时再统一转译成游戏认得的
 * `.ERB`（见 `#17`），工作区里始终只有 `.kojo` 这一份源。
 *
 * 空壳内容全是 `;` 注释，而 `;` 注释在糖里语法完全一样 ⇒ 同一份内容在两种扩展名下
 * 都合法，改的只是"作者接下来能在这个文件里写什么"。
 *
 * 面模板示例取自本包 `face-templates.ts`（游戏知识单一真源；只代入不解释）。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';
import { createEratwFaceTable } from './face-templates';

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
  /** 是否附带 LICENSE 文件（占位模板，作者自填条款） */
  includeLicense: boolean;
}

/** 脚手架产物：包目录名 + 文件集（相对路径 → 文本内容） */
export interface KojoScaffoldResult {
  dirName: string;
  files: Record<string, string>;
}

/** 核心面空壳的文件扩展名（README 清单与实际产物必须同源于此） */
export const FACE_STUB_EXT = '.kojo';

/** 核心面空壳规格（中文命名；文件名 = stem + '.kojo'） */
export interface CoreFaceSpec {
  /** 文件名干（不含扩展名） */
  stem: string;
  /** 对应分野表键（取函数名模板用） */
  face: string;
  /** 一句话说明（进注释与 README） */
  blurb: string;
}

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
 * 文件系统非法字符消毒（单层目录段）：
 * 剔除 `\/:*?"<>|` 与控制字符，压缩连续空白，去首尾空白与尾随点号
 * （Windows 目录名不得以点/空格结尾）。合法字符一律保留（含中日文、空格）。
 */
export function sanitizeSegment(value: string): string {
  return value
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** 包目录名：`{作品名}-{角色名} v{版本}`（逐段消毒后拼接） */
export function scaffoldDirName(opts: Pick<KojoScaffoldOptions, 'workName' | 'charaName' | 'version'>): string {
  return `${sanitizeSegment(opts.workName)}-${sanitizeSegment(opts.charaName)} v${sanitizeSegment(opts.version)}`;
}

/** 面模板示例：代入家族段（空）与角色号，保留 `{i}`/`${com}` 原样供说明 */
function templateExample(faceTable: KojoFaceTable, face: string, charaNo: number): string | null {
  const template = faceTable.faces[face]?.template;
  if (!template) return null;
  return template.replaceAll('{t}', '').replaceAll('{n}', String(charaNo));
}

/** 单面空壳内容（纯 `;` 注释；不生成任何活函数） */
export function buildFaceStub(spec: CoreFaceSpec, opts: KojoScaffoldOptions, faceTable: KojoFaceTable): string {
  const lines: string[] = [];
  lines.push(`; 《${opts.workName.trim()}》· ${opts.charaName.trim()}（K${opts.charaNo}）— ${spec.stem}`);
  lines.push(`; 剧本${opts.scriptNo} · 版本 ${opts.version.trim()} · 作者：${opts.authorName.trim()}`);
  lines.push(';');
  lines.push(`; 【面说明】${spec.blurb}`);
  const example = templateExample(faceTable, spec.face, opts.charaNo);
  if (example) {
    lines.push(`; 【函数形态】${example}`);
    if (example.includes('{i}')) lines.push(';   {i} = 时机编号（按游戏内事件/指令编号填写）。');
    if (example.includes('${com}')) lines.push(';   ${com} = 指令类型段（COM / SCOM / CUSTOM_COM / CUSTOM_SCOM）。');
    lines.push(';   有家族段（别人版口上）时，家族段插在 M_KOJO 之后的下划线处。');
  }
  lines.push(';');
  lines.push('; —— 脚手架生成的空壳文件：只有注释，没有活函数 ——');
  lines.push('; 请在下方开始创作（ERB 函数定义以 @ 开头）。');
  return `${lines.join('\n')}\n`;
}

/** 中文 README 模板 */
export function buildReadme(opts: KojoScaffoldOptions): string {
  const lines: string[] = [];
  lines.push(`# 《${opts.workName.trim()}》· ${opts.charaName.trim()} 口上包`);
  lines.push('');
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| 作者 | ${opts.authorName.trim()} |`);
  lines.push(`| 版本 | ${opts.version.trim()} |`);
  lines.push(`| 目标角色 | ${opts.charaName.trim()}（编号 ${opts.charaNo}） |`);
  lines.push(`| 目标剧本 | 剧本${opts.scriptNo} |`);
  lines.push('');
  lines.push('## 简介');
  lines.push('');
  lines.push('> 请在这里填写作品介绍：设定、基调、与原版口上的差异点等。');
  lines.push('');
  lines.push('## 内容');
  lines.push('');
  lines.push(
    '本包由脚手架生成以下核心面空壳（文件内只有 `;` 注释，不含活函数）。' +
      '扩展名是 `.kojo`：语法糖与原始 ERB 写法可以写在同一个文件里，' +
      '导出或部署时会自动转译成游戏认得的 `.ERB`，工作区里始终只有 `.kojo` 这一份源。',
  );
  lines.push('');
  for (const spec of CORE_FACES) {
    lines.push(`- \`${spec.stem}${FACE_STUB_EXT}\` — ${spec.blurb}`);
  }
  lines.push('');
  lines.push('## 部署');
  lines.push('');
  lines.push('编辑器的「部署到游戏目录」会把本包转译后放进游戏目录：');
  lines.push('');
  lines.push('```');
  lines.push(`ERB/口上・メッセージ関連/個人口上/<角色口上目录>/${scaffoldDirName(opts)}/`);
  lines.push('```');
  lines.push('');
  lines.push('（游戏目录默认只读，需先批准写权限；目标已存在时不会覆盖。）');
  lines.push('');
  lines.push('手工放置也可以：先把 `.kojo` 全部转译成同名 `.ERB`，再把 `.ERB` 连同辅助文件复制过去。');
  lines.push('**直接把 `.kojo` 放进游戏目录是不生效的**——引擎只读 `.ERB`。');
  lines.push('');
  lines.push('## 许可');
  lines.push('');
  if (opts.includeLicense) {
    lines.push('见 `LICENSE` 文件（当前为占位模板，请填写正式条款）。');
  } else {
    lines.push('未指定开源协议——默认保留所有权利。');
  }
  return `${lines.join('\n')}\n`;
}

/** LICENSE 占位模板（不替作者选定协议；只落署名与待填框架） */
export function buildLicense(opts: KojoScaffoldOptions): string {
  const year = new Date().getFullYear();
  const lines: string[] = [];
  lines.push(`Copyright (c) ${year} ${opts.authorName.trim()}`);
  lines.push('');
  lines.push('（占位模板：请在此填写所选开源协议的完整条款，');
  lines.push('例如 MIT、CC BY-NC-SA 等；删除本行说明。）');
  return `${lines.join('\n')}\n`;
}

/**
 * 组装完整脚手架产物。输入非法时抛错（中文消息；向导已前置校验，此处兜底）。
 * `faceTable` 缺省取 eraTW 分野表（纯数据，无 IO）。
 */
export function scaffoldKojoProject(
  opts: KojoScaffoldOptions,
  faceTable: KojoFaceTable = createEratwFaceTable(),
): KojoScaffoldResult {
  const workName = opts.workName.trim();
  const authorName = opts.authorName.trim();
  const version = opts.version.trim();
  const charaName = opts.charaName.trim();
  if (!workName) throw new Error('作品名不能为空');
  if (!authorName) throw new Error('作者名不能为空');
  if (!version) throw new Error('版本不能为空');
  if (!charaName) throw new Error('角色名不能为空');
  if (!Number.isInteger(opts.scriptNo) || opts.scriptNo < 1 || opts.scriptNo > 10) {
    throw new Error(`剧本号必须是 1-10 的整数：${String(opts.scriptNo)}`);
  }
  if (!Number.isInteger(opts.charaNo) || opts.charaNo < 0) {
    throw new Error(`角色编号非法：${String(opts.charaNo)}`);
  }

  const files: Record<string, string> = {};
  files['README.md'] = buildReadme(opts);
  if (opts.includeLicense) files['LICENSE'] = buildLicense(opts);
  for (const spec of CORE_FACES) {
    files[`${spec.stem}${FACE_STUB_EXT}`] = buildFaceStub(spec, opts, faceTable);
  }

  return { dirName: scaffoldDirName(opts), files };
}
