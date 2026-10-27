/**
 * 新建口上项目向导（2026-10-12 口上项目批 P-C；`ui.overlay` 贡献）。
 *
 * 链路：面板「新建」按钮 → 内核事件 `ui.overlay.open` → 宿主打开本 overlay
 * → 填作品信息（作品名/作者名/版本/目标角色/游戏自己的附加字段/可选 LICENSE）
 * → 脚手架生成中文命名包（`deps.scaffold`，实现在 adapter）
 * → 落工作区（`kernel.workspaces`：create 项目 + createArtifact 包）
 * → 通知面板刷新 → 广播 `workspace.projectCreated` → `ui.overlay.close` 自关。
 *
 * 本向导有两个入口（反馈 3，2026-10-13）：面板的「＋ 新建」，以及
 * 「新建口上文件」在**还没有口上项目**时的引导分支。后者发语义意图
 * `workspace.newProjectRequested` 带一个关联号来（接线见 `plugin.ts`），创建成功时
 * 原样带进 `workspace.projectCreated`，由发起方把作者那份还没落盘的口上文件写进
 * 新项目——**向导本身不知道也不该知道这件事**，它只管把项目建出来。
 *
 * 知识分层：角色表来自 `kernel.project` 的 GameProject（适配器填充，本向导透传）；
 * 脚手架内容（面清单 / 空壳注释 / README 模板 / 许可段落）是**游戏知识**，
 * 住在各 adapter 的 `scaffold.ts`，经 `deps.scaffold` 注入。共享层因此一条游戏
 * 事实都不掌握——「剧本号」这类字段由 `deps.extraFields` 声明，没有的游戏就不出现。
 *
 * 「起手写法」那一格（语言档：糖 / 原生，用户反馈 1，2026-10-20 NEW-ERB）走的是
 * **同一条声明式路子**：档位本身游戏无关（住在 `lang-doc.ts`，扩展名一律由契约单源
 * 现算），但"这个游戏支持几种档"随 `deps.scaffold` 声明——没声明的游戏这一行不出现，
 * 递给脚手架的草稿连 `langDoc` 这个键都没有，产物逐字不变。
 *
 * 模板来源（KM-14）：默认走内置脚手架（上面那条链路）；也可以选一个**已安装的市场
 * 模板包**（`kind === 'template-pack'`）——那时产物文件不再由脚手架生成，而是把模板包
 * 的 contentDir 经 `workspaces.importDirectory` **字节级复制**成制品（目录名规则 / 预览 /
 * 消毒 / 位置自选 / 许可下拉全部不变）。市场缺席 / 无模板包 ⇒ 灰字说明 + 保持默认内置
 * （功能不隐藏，也不说黑话）。
 */

import { createElement as h, useEffect, useMemo, useState } from 'react';
import type {
  CharaInfo,
  FileIO,
  GameProject,
  MarketService,
  ProjectService,
  ScaffoldFileSet,
  WorkspaceService,
} from '@kojo/plugin-api';
import { buildScaffoldDirName, pathKey, sanitizePathSegment } from '@kojo/plugin-api';
import { LICENSE_CHOICES, licenseProducesFile, type LicenseKind } from './licenses';
import { readPackAuthorship, type PackAuthorship } from './attribution';
import {
  DEFAULT_KOJO_LANG_DOC,
  draftLangDoc,
  kojoLangDocChoice,
  kojoLangDocPreviewParenthesis,
  readScaffoldLangDocs,
  type KojoLangDoc,
  type KojoLangDocChoice,
} from './lang-doc';

/** 模板来源条目（`deps.listTemplates` 的返回形状；装配侧对已装 `template-pack` 记录的投影） */
export interface KojoTemplateEntry {
  id: string;
  version: string;
  name: string;
  /** 模板包 contentDir（`workspaces.importDirectory` 的源目录） */
  sourceDir: string;
}

/**
 * 游戏自己的下拉字段（如某些游戏的「剧本号」）。
 *
 * 共享层不知道哪个游戏有这一栏、取值范围是多少——**adapter 说有才有**，
 * 缺省（`extraFields` 不传）时向导与没有这些字段的游戏逐字一致。
 */
export interface WizardSelectField {
  /** 字段键（原样进制品 meta 与脚手架输入） */
  key: string;
  /** 行标签 */
  label: string;
  options: readonly { value: number; label: string }[];
  /** 初值（必须是 options 里的某一项） */
  defaultValue: number;
}

/** 脚手架输入（游戏无关部分；游戏自己的字段在 `extra` 里原样透传） */
export interface KojoScaffoldDraft {
  workName: string;
  authorName: string;
  version: string;
  charaNo: number;
  charaName: string;
  license: LicenseKind;
  extra: Readonly<Record<string, number>>;
  /**
   * 语言档（糖 / 原生，NEW-ERB 2026-10-20）。
   *
   * **本游戏没声明语言档 ⇒ 这个键不出现**（不是 `undefined` 占位）：脚手架收到的
   * 草稿与改前逐字相同，老游戏的产物一字节都不动。声明了才带上，缺省档 = 糖。
   */
  langDoc?: KojoLangDoc;
}

export interface NewKojoProjectWizardDeps {
  workspaces: WorkspaceService;
  /** 内核 IO：只用它的「自选项目位置」对话框通道（授权发生在平台命令内，见 `location-help` 注释） */
  io: FileIO;
  /** 游戏项目（角色表来源；无打开项目时向导显式不可用） */
  project: ProjectService;
  /**
   * 列出已装的市场模板包（KM-14；**可选**——组装方没接市场时向导与历史逐字一致）。
   * 返回空数组 ⇒ 向导显示灰字「（尚未安装模板包）」并保持默认内置骨架。
   */
  listTemplates?: () => Promise<readonly KojoTemplateEntry[]>;
  /** 关闭自身（经内核事件，向导不持有宿主引用） */
  close(): void;
  /** 创建成功后回调（面板刷新：目录缓存失效 + 项目列表重拉） */
  onCreated(): void;
  /**
   * 广播「项目已创建」（反馈 3）。与 `onCreated` 分开是有意的：
   * `onCreated` 是本插件内部的缓存失效，`created` 是对外的**事实通知**——
   * 谁引来的这次创建（关联号）由接线侧决定带不带，组件不参与。
   */
  created(info: { projectId: string }): void;
  /**
   * 本游戏的脚手架（面清单 / 空壳注释 / README / 许可段落全在 adapter 里）。
   * 共享层只负责把表单值装进来——产物长什么样是游戏的事。
   * 游戏若支持多种**语言档**，随这枚函数声明（见 `lang-doc.ts` 的 `withKojoLangDocs`）；
   * 没声明的游戏拿到的草稿与历史逐字相同。
   */
  scaffold(draft: KojoScaffoldDraft): ScaffoldFileSet;
  /** 核心面空壳数量（只用于「将生成 N 个文件」这句预览） */
  coreFaceCount: number;
  /** 游戏自己的下拉字段；缺省 = 本游戏没有这类字段 */
  extraFields?: readonly WizardSelectField[];
  /** 内置骨架预览的补充说明（游戏特有的一句，如「不含某类文件」）；缺省不显示 */
  previewNote?: string;
}

/**
 * 「目标角色」下拉项文案（看板 HK-9）。
 *
 * 有的游戏的 CHARA 表里含有**没有个人口上目录**的角色（如 MASTER = 玩家自己），
 * 于是"选了它 → 建得出包 → 部署时被拒"这条链会在最后一步才炸。
 * 处置是**把代价说在选择的那一刻**，而不是把选项删掉：
 * 没有口上目录的角色照样能写、能导出（手工放置是合法路径），
 * 而且"某角色还没有目录"在新整合包里是常态。
 */
export function charaOptionLabel(c: CharaInfo): string {
  return `#${c.no} ${c.name}${c.kojoDir ? '' : ' · 无个人口上目录'}`;
}

/** 选了无口上目录的角色时的后果说明；有目录或还没选角色 → null（不制造噪音） */
export function noKojoDirWarning(c: CharaInfo | null): string | null {
  if (!c || c.kojoDir) return null;
  // 用词对齐 `deploy.ts:resolveDeployTarget` 的拒绝原因（同一个概念只有一种说法）
  return `注意：#${c.no} ${c.name} 在游戏目录中没有个人口上目录——这个包照常书写、照常导出，但无法部署。`;
}

/**
 * 从 `workspace.newProjectRequested` 事件载荷里取关联号（反馈 3 的第一拍）。
 *
 * 形态不对一律归 null（= 这次开门没有请求方），**不做"尽力解析"**：
 * 误认一个号，等于把作者没要过的文件塞进一个刚建好的新项目里。
 */
export function readRequestToken(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { requestToken?: unknown }).requestToken;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** 选中协议的说明；表里查不到时返回空串（不显示，而不是显示"未知"） */
function licenseHint(kind: LicenseKind): string {
  return LICENSE_CHOICES.find((c) => c.kind === kind)?.hint ?? '';
}

/* ---------------- 项目位置（2026-10-14 自选位置批：纯函数半边，可单测） ---------------- */

/** `workspaces.create` 的入参形状（比契约窄一档：这里只管向导真的会传的那三个字段） */
export interface KojoProjectCreateInput {
  name: string;
  meta: Record<string, unknown>;
  rootDir?: string;
}

/**
 * 「项目位置」行给作者看的文案：没自选过就明说是默认位置，自选过就直接给绝对路径
 * （作者要的是"我那份作品到底落在哪"，不是内部术语）。
 */
export function locationLabel(chosen: string | null, defaultRoot: string | null): string {
  if (chosen !== null) return chosen;
  return defaultRoot === null ? '（默认）位置暂不可用' : `（默认）${defaultRoot}`;
}

/**
 * 默认工作区根的取值：`rootDir()` 在没有平台数据目录的环境（浏览器开发壳）会抛，
 * 这里吞成 `null` 只用于展示——真正的问题由「创建」那条路径如实报出来。
 */
export function defaultWorkspaceRoot(workspaces: WorkspaceService): string | null {
  try {
    return workspaces.rootDir();
  } catch {
    return null;
  }
}

/**
 * 「项目位置」对话框的**禁选根**（2026-10-27 游戏目录防护批）。
 *
 * 取当前游戏项目的根目录 + 口上域 + 存档目录（有才算），按 `pathKey` 去重、丢掉空串。
 * 平台侧对每一根做**双向包含**判定：选中的文件夹与它们相等 / 在其下 / 含它，一律拒。
 * 于是"选游戏目录"与"选游戏目录的上级（把游戏整个圈进来）"两条都在选择那一刻被挡下。
 *
 * 没有打开项目（`null`）⇒ 空数组 ⇒ 平台行为与历史逐字一致（这条防护不认识游戏，
 * 只是把当前项目的位置当作"不许当作品位置"的清单递过去）。
 */
export function gameRootsForbiddingLocation(project: GameProject | null): string[] {
  if (project === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [project.rootDir, ...project.kojoPaths, project.savDir]) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const k = pathKey(raw);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

/**
 * 组装 `workspaces.create` 的入参。
 *
 * **未自选位置 ⇒ 连 `rootDir` 这个键都不出现**（而不是传 `undefined`）：
 * 默认落点是历史行为，逐字不变才能让老作者升级后感觉不到差别。
 * 自选过 ⇒ 原样带上那条路径，由内核核对它是否在已授权根名单内
 * （授权来自目录对话框，不是来自这个字段本身）。
 */
export function buildCreateInput(
  form: { workName: string; authorName: string; version: string },
  chosenRoot: string | null,
): KojoProjectCreateInput {
  const input: KojoProjectCreateInput = {
    name: form.workName.trim(),
    meta: { author: form.authorName.trim(), version: form.version.trim() },
  };
  if (chosenRoot !== null) input.rootDir = chosenRoot;
  return input;
}

/** 「项目位置」的 tooltip：零基础作者也要能一眼看懂这行是干什么的 */
const LOCATION_HELP =
  '新建的作品文件夹放在哪里。默认放在软件自己的数据目录里；' +
  '也可以选一个你自己认得的文件夹（例如你的作品库），选好后软件会把那里当作可写的作品目录。';

/* ---------------- 模板来源（KM-14：纯函数半边，可单测） ---------------- */

/** 「模板来源」下拉的哨兵值：内置骨架（市场包 id 受 `PACK_ID_RE` 约束，空串撞不上） */
const BUILTIN_TEMPLATE_VALUE = '';

/** 无模板包时那条灰字说明的选项值（disabled，选不中；只为把"这个功能在哪"说清楚） */
const NO_TEMPLATE_VALUE = '__no-template-pack__';

/** 模板包身份键：`<id>@<version>`（下拉值与制品 meta 的 `template` 字段同一来源） */
export function templateKey(t: Pick<KojoTemplateEntry, 'id' | 'version'>): string {
  return `${t.id}@${t.version}`;
}

/** 「模板来源」下拉选项 */
export interface TemplateSourceChoice {
  value: string;
  label: string;
  /** 灰字说明项（不可选） */
  disabled?: boolean;
}

/**
 * 已装市场包 → 模板下拉条目（KM-14；市场缺席 ⇒ `[]`）。
 * 只认 `kind === 'template-pack'`——口上包 / 字典包不是模板，混进来就是把两类东西说成一样。
 * 单列成函数是为了可单测：组件在 node 测试环境渲不出来，投影规则在这里被直测；
 * 失败**向上抛**（由装配侧收口成"按没有模板包处理 + 记日志"，这里不吞错）。
 */
export async function listMarketTemplates(market: MarketService | null): Promise<KojoTemplateEntry[]> {
  if (market === null) return [];
  const out: KojoTemplateEntry[] = [];
  for (const rec of await market.installed()) {
    if (rec.kind !== 'template-pack') continue;
    out.push({
      id: rec.id,
      version: rec.version,
      name: rec.name,
      sourceDir: await market.contentDir(rec.kind, rec.id, rec.version),
    });
  }
  return out;
}

/**
 * 「模板来源」下拉选项（KM-14；纯函数）。
 * 内置骨架恒在首位且默认选中；无模板包时**不隐藏整个功能**——追加一条灰字说明，
 * 作者看得见"这里还能有别的东西"，也不用听黑话。
 */
export function templateSourceChoices(templates: readonly KojoTemplateEntry[]): TemplateSourceChoice[] {
  const builtin: TemplateSourceChoice = {
    value: BUILTIN_TEMPLATE_VALUE,
    label: '内置骨架（中文命名 + 核心面空壳）',
  };
  if (templates.length === 0) {
    return [builtin, { value: NO_TEMPLATE_VALUE, label: '（尚未安装模板包）', disabled: true }];
  }
  return [builtin, ...templates.map((t) => ({ value: templateKey(t), label: `${t.name} v${t.version}` }))];
}

/**
 * 落点预览里"模板模式"那句话（KM-14；纯函数）。
 * `fileCount === null` = 还没数出来 / 模板目录读不动——那就如实说"以导入结果为准"，
 * **不许**把内置脚手架的"将生成 N 个文件"照搬过来（那是另一份产物）。
 */
export function templatePreviewLine(template: KojoTemplateEntry, fileCount: number | null): string {
  const base = `将导入模板「${template.name} v${template.version}」`;
  return fileCount === null
    ? `${base}的全部文件（内容原样复制；数量以导入结果为准）`
    : `${base}的 ${fileCount} 个文件（内容原样复制，不再生成内置骨架）`;
}

/**
 * 模板模式下的 `workspaces.importDirectory` 入参（KM-14；纯函数，供测试直取）。
 *
 * - 目录名与内置分支**同一条规则**（共享层的目录名构造；预览 / 消毒逐字不动）；
 * - `meta` = 内置分支那几样（charaNo / charaName / 游戏自己的 extra 字段）
 *   + `template: '<id>@<version>'`，模板包署名（`pack.json` 的 author / license）
 *   读得到就一并带上（读不到不写占位）。
 */
export function buildTemplateImportInput(
  template: KojoTemplateEntry,
  form: {
    workName: string;
    charaName: string;
    version: string;
    charaNo: number;
    extra: Readonly<Record<string, number>>;
  },
  pack: PackAuthorship | null,
): { name: string; dirName: string; sourceDir: string; meta: Record<string, unknown> } {
  const dirName = buildScaffoldDirName({
    workName: form.workName,
    charaName: form.charaName,
    version: form.version,
  });
  const meta: Record<string, unknown> = {
    charaNo: form.charaNo,
    charaName: form.charaName,
    ...form.extra,
    template: templateKey(template),
  };
  if (pack !== null && pack.author.length > 0) meta.templateAuthor = pack.author;
  if (pack !== null && pack.license.length > 0) meta.templateLicense = pack.license;
  return { name: dirName, dirName, sourceDir: template.sourceDir, meta };
}

/** 「自选…」按钮的对话框标题 */
const LOCATION_DIALOG_TITLE = '选择新建作品的位置…';

/* ---------------- 语言档与落点预览（NEW-ERB 2026-10-20：纯函数半边，可单测） ---------------- */

/**
 * 内置骨架分支的落点预览那句（纯函数）。
 *
 * 糖档那句与历史文案**逐字相同**（那句括号里的扩展名由单源插入，本文件不抄字面量）；
 * 原生档换成"只写原生语法、不经转译"——作者选完档就在落点预览里看见自己会得到什么。
 */
export function scaffoldPreviewLine(args: {
  fileCount: number;
  coreFaceCount: number;
  licenseProduces: boolean;
  previewNote?: string;
  langDoc?: KojoLangDoc;
}): string {
  return (
    `将生成 ${args.fileCount} 个文件：中文 README + ${args.coreFaceCount} 个核心面空壳` +
    `${kojoLangDocPreviewParenthesis(args.langDoc)}` +
    `${args.licenseProduces ? ' + LICENSE' : ''}` +
    `${args.previewNote ? `；${args.previewNote}` : ''}`
  );
}

/**
 * 组装递给 `deps.scaffold` 的草稿（纯函数）。
 *
 * 语言档那一项**由声明决定出不出现这个键**（`draftLangDoc`），缺省档 = 糖；
 * 其余字段与历史逐字一致。
 */
export function composeScaffoldDraft(
  form: {
    workName: string;
    authorName: string;
    version: string;
    charaNo: number;
    charaName: string;
    license: LicenseKind;
    extra: Readonly<Record<string, number>>;
  },
  langDocs: readonly KojoLangDocChoice[],
  langDoc: KojoLangDoc,
): KojoScaffoldDraft {
  return {
    workName: form.workName,
    authorName: form.authorName,
    version: form.version,
    charaNo: form.charaNo,
    charaName: form.charaName,
    license: form.license,
    extra: form.extra,
    ...draftLangDoc(langDocs, langDoc),
  };
}

/** 向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createNewKojoProjectWizard(deps: NewKojoProjectWizardDeps): () => unknown {
  return function NewKojoProjectWizard(): unknown {
    const gameProject = deps.project.current();

    const [workName, setWorkName] = useState('');
    const [authorName, setAuthorName] = useState('');
    const [version, setVersion] = useState('1.0');
    const [charaNo, setCharaNo] = useState<number | null>(null);
    /** 游戏自己的下拉字段值（键来自 `deps.extraFields`；没有这些字段时恒为空对象） */
    const extraFields = deps.extraFields ?? [];
    const [extra, setExtra] = useState<Record<string, number>>(() => {
      const init: Record<string, number> = {};
      for (const f of extraFields) init[f.key] = f.defaultValue;
      return init;
    });
    /**
     * 语言档（NEW-ERB，反馈 1 的下半寸）：这一行出不出现，**只由本游戏的脚手架声明**
     * （`lang-doc.ts` 的 `withKojoLangDocs`）；没声明的游戏连这个控件都没有，
     * 表单与产物与历史逐字一致。初值 = 声明清单的第一项 = 缺省档（糖）。
     */
    const langDocs = useMemo(() => readScaffoldLangDocs(deps.scaffold), [deps.scaffold]);
    const [langDoc, setLangDoc] = useState<KojoLangDoc>(langDocs[0]?.value ?? DEFAULT_KOJO_LANG_DOC);
    // 反馈 4：从"勾不勾占位模板"升级成"选哪一种协议"。缺省 `none` ——
    // 工具不替作者选定许可，也不默认替他"开放"什么。
    const [license, setLicense] = useState<LicenseKind>('none');
    // 项目位置：null = 没自选过（走默认工作区根）；字符串 = 刚经系统对话框选定的目录
    const [chosenRoot, setChosenRoot] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 目标角色下拉：读游戏项目角色表（按编号升序）
    const charas = useMemo(() => {
      if (!gameProject) return [];
      return [...gameProject.charaIndex.values()].sort((a, b) => a.no - b.no);
    }, [gameProject]);

    /* ---------- 模板来源（KM-14；hooks 必须在无项目早退之前） ---------- */

    // 已装模板包：null = 还没拿到（或接线方没给 listTemplates）；[] = 拿到了但没有
    const [templates, setTemplates] = useState<readonly KojoTemplateEntry[] | null>(null);
    const [templateValue, setTemplateValue] = useState<string>(BUILTIN_TEMPLATE_VALUE);
    // 模板落点要复制几个文件：null = 还没数出来 / 目录读不动（预览如实说"以导入结果为准"）
    const [templateFileCount, setTemplateFileCount] = useState<number | null>(null);

    // 拉取已装模板包：失败按"没装"处理——模板来源是锦上添花，绝不挡住建项目
    useEffect(() => {
      const list = deps.listTemplates;
      if (list === undefined) return;
      let cancelled = false;
      void list().then(
        (entries) => {
          if (!cancelled) setTemplates([...entries]);
        },
        () => {
          if (!cancelled) setTemplates([]);
        },
      );
      return () => {
        cancelled = true;
      };
    }, [deps]);

    const selectedTemplate = useMemo(
      () => (templates === null ? null : (templates.find((t) => templateKey(t) === templateValue) ?? null)),
      [templates, templateValue],
    );

    // 数模板文件：与 `importDirectory` 同一条枚举口径（walkDir(includeFiles) 里跳过目录），
    // 让"将导入 N 个文件"这句话数与产物一致
    useEffect(() => {
      if (selectedTemplate === null) {
        setTemplateFileCount(null);
        return;
      }
      let cancelled = false;
      setTemplateFileCount(null);
      void deps.io.walkDir(selectedTemplate.sourceDir, { includeFiles: true }).then(
        (entries) => {
          if (!cancelled) setTemplateFileCount(entries.filter((e) => !e.isDirectory).length);
        },
        () => {
          if (!cancelled) setTemplateFileCount(null);
        },
      );
      return () => {
        cancelled = true;
      };
    }, [deps, selectedTemplate]);

    /* ---------- 无游戏项目：显式降级（角色表无处可取，不猜） ---------- */
    if (!gameProject) {
      return h('div', { className: 'wizard' },
        h('h3', null, '新建口上项目'),
        h('p', { className: 'dim' }, '当前无打开的游戏项目。目标角色表来自游戏项目，请先打开项目再新建。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    const chara = charaNo === null ? null : (charas.find((c) => c.no === charaNo) ?? null);

    // 目录名实时预览（逐段消毒；任一段为空 → 预览空 → 禁用创建）
    const segmentsOk =
      sanitizePathSegment(workName).length > 0 &&
      sanitizePathSegment(version).length > 0 &&
      (chara ? sanitizePathSegment(chara.name).length > 0 : false);
    const dirNamePreview = chara && segmentsOk
      ? buildScaffoldDirName({ workName, charaName: chara.name, version })
      : '';
    const kojoDirWarning = noKojoDirWarning(chara);

    const canCreate =
      !busy &&
      workName.trim().length > 0 &&
      authorName.trim().length > 0 &&
      version.trim().length > 0 &&
      chara !== null &&
      dirNamePreview.length > 0;

    const create = async (): Promise<void> => {
      if (!chara) return;
      setBusy(true);
      setError(null);
      try {
        if (selectedTemplate !== null) {
          // 模板模式（KM-14）：产物 = 模板包 contentDir 的字节级复制；
          // 包署名先从 pack.json 读（读不到也不挡创建，importDirectory 会如实报源目录问题）
          const pack = await readPackAuthorship({ io: deps.io, contentDir: selectedTemplate.sourceDir });
          const wsProject = await deps.workspaces.create(
            buildCreateInput({ workName, authorName, version }, chosenRoot),
          );
          await deps.workspaces.importDirectory(
            wsProject.id,
            buildTemplateImportInput(
              selectedTemplate,
              { workName, charaName: chara.name, version, charaNo: chara.no, extra },
              pack,
            ),
          );
          deps.onCreated();
          deps.created({ projectId: wsProject.id });
          deps.close();
          return;
        }
        const result = deps.scaffold(
          composeScaffoldDraft(
            { workName, authorName, version, charaNo: chara.no, charaName: chara.name, license, extra },
            langDocs,
            langDoc,
          ),
        );
        const wsProject = await deps.workspaces.create(
          buildCreateInput({ workName, authorName, version }, chosenRoot),
        );
        await deps.workspaces.createArtifact(wsProject.id, {
          name: result.dirName,
          dirName: result.dirName,
          files: result.files,
          meta: { charaNo: chara.no, charaName: chara.name, ...extra },
        });
        deps.onCreated();
        deps.created({ projectId: wsProject.id });
        deps.close();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    };

    /**
     * 自选项目位置：走内核 IO 的对话框通道（`io.chooseWorkspaceRoot`）。
     *
     * 这里**不拼路径、不校验目录、不申请权限**——选定即授权发生在平台命令内部
     * （系统目录对话框 + 登记常驻授权根绑成一个原子动作，铁律 6 的法定形态，
     * 与导出用的 `io.exportFile` 同族）。取消返回 null，状态原样不动。
     *
     * 2026-10-27 游戏目录防护批：把当前**游戏根 / 口上域 / 存档目录**作为 `forbidRoots`
     * 递过去，平台侧在**登记之前**拒掉与它们重叠的选择（相等 / 在其下 / 含它）。
     * 选到游戏目录（或游戏目录的上级）当作品位置，等于把整个游戏目录圈进可写域；
     * 这条要在选择那一刻就说"不行"，别等事后收窄。拒因是平台给的中文原文，原样上屏。
     */
    const pickLocation = async (): Promise<void> => {
      setError(null);
      try {
        const picked = await deps.io.chooseWorkspaceRoot({
          title: LOCATION_DIALOG_TITLE,
          forbidRoots: gameRootsForbiddingLocation(gameProject),
        });
        if (picked !== null) setChosenRoot(picked);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    const fileCount = 1 + (licenseProducesFile(license) ? 1 : 0) + deps.coreFaceCount;
    const defaultRoot = defaultWorkspaceRoot(deps.workspaces);

    return h('div', { className: 'wizard' },
      h('h3', null, '新建口上项目'),

      // 作品名
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '作品名'),
        h('input', {
          value: workName,
          placeholder: '如：东方口上合集',
          onChange: (e: { target: { value: string } }) => setWorkName(e.target.value),
        })),

      // 作者名
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '作者名'),
        h('input', {
          value: authorName,
          placeholder: '你的署名（导入他人包时不会被覆盖）',
          onChange: (e: { target: { value: string } }) => setAuthorName(e.target.value),
        })),

      // 版本
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '版本'),
        h('input', {
          value: version,
          placeholder: '如：1.0',
          onChange: (e: { target: { value: string } }) => setVersion(e.target.value),
        })),

      // 目标角色（游戏项目角色表）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '目标角色'),
        h('select', {
          value: charaNo === null ? '' : String(charaNo),
          onChange: (e: { target: { value: string } }) =>
            setCharaNo(e.target.value === '' ? null : Number(e.target.value)),
        },
          h('option', { value: '' }, charas.length > 0 ? '选择角色…' : '（游戏项目无角色表）'),
          charas.map((c) => h('option', { key: c.no, value: String(c.no) }, charaOptionLabel(c)))),

      // 语言档（NEW-ERB，反馈 1）：本游戏的脚手架声明了才出现这一行。
      // 选中项那句人话常驻显示（与「许可协议」同一手法）——"选了糖也能逐行直写原生"
      // 这件事不写出来，作者就只能猜，而这条反馈的原始症状正是"以为没有原生这条路"。
      langDocs.length >= 2
        ? h('div', { className: 'wizard-field' },
            h('span', { className: 'wizard-label' }, '起手写法'),
            h('select', {
              value: langDoc,
              onChange: (e: { target: { value: string } }) =>
                setLangDoc(langDocs.find((c) => c.value === e.target.value)?.value ?? DEFAULT_KOJO_LANG_DOC),
            },
              langDocs.map((c) => h('option', { key: c.value, value: c.value }, c.label))),
            h('div', { className: 'wizard-hint dim' }, kojoLangDocChoice(langDoc).hint))
        : null,

      // 模板来源（KM-14）：接线方给了 listTemplates 才出现这行（没接市场 ⇒ 与历史逐字一致）。
      // 无模板包时不是把功能藏起来，而是给一条灰字说明——作者看得见"这里还能有别的东西"。
      deps.listTemplates !== undefined
        ? h('div', { className: 'wizard-field' },
            h('span', { className: 'wizard-label' }, '模板来源'),
            h('select', {
              value: templateValue,
              onChange: (e: { target: { value: string } }) => setTemplateValue(e.target.value),
            },
              templateSourceChoices(templates ?? []).map((c) =>
                h('option', { key: c.value, value: c.value, disabled: c.disabled === true }, c.label))),
            h('div', { className: 'wizard-hint dim' }, '默认用内置骨架；装了模板包，也可以直接从模板开始。'))
        : null,

      // 游戏自己的下拉字段（如「剧本号」）：adapter 说有才有，取值域也由它给。
      ...extraFields.map((f) =>
        h('label', { className: 'wizard-field', key: f.key },
          h('span', { className: 'wizard-label' }, f.label),
          h('select', {
            value: String(extra[f.key] ?? f.defaultValue),
            onChange: (e: { target: { value: string } }) =>
              setExtra((prev) => ({ ...prev, [f.key]: Number(e.target.value) })),
          },
            f.options.map((o) => h('option', { key: o.value, value: String(o.value) }, o.label))))),

      // 许可协议（反馈 4）：下拉选一种，选中项的一句话说明实时显示在下面。
      // 不用一堆单选按钮：7 个选项会把向导撑长，而作者真正需要的是"选完知道别人能干什么"。
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '许可协议'),
        h('select', {
          value: license,
          onChange: (e: { target: { value: string } }) => setLicense(e.target.value as LicenseKind),
        },
          LICENSE_CHOICES.map((c) => h('option', { key: c.kind, value: c.kind }, c.label))),
        h('div', { className: 'wizard-hint dim' }, licenseHint(license))),

      // 项目位置（2026-10-14 自选位置批）：默认落点仍是软件自己的数据目录，
      // 作者可以改成"一个自己认得的文件夹"。文案与样式全部复用既有 wizard-* 类，
      // 不新增 CSS 体系；说明既做 tooltip 也常驻显示（零基础作者不必悬停才发现这行能点）。
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '项目位置'),
        h('div', { className: 'dim' }, locationLabel(chosenRoot, defaultRoot)),
        h('div', null,
          h('button', {
            className: 'ghost small',
            onClick: () => void pickLocation(),
            disabled: busy,
            title: LOCATION_HELP,
          }, chosenRoot === null ? '自选…' : '改选别的文件夹…')),
        h('div', { className: 'wizard-hint dim' }, LOCATION_HELP)),

      // 落点预览
      h('div', { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '包目录名'),
          h('code', null, dirNamePreview || '—')),
        h('div', { className: 'dim' },
          dirNamePreview
            ? (selectedTemplate !== null
              ? templatePreviewLine(selectedTemplate, templateFileCount)
              : scaffoldPreviewLine({
                  fileCount,
                  coreFaceCount: deps.coreFaceCount,
                  licenseProduces: licenseProducesFile(license),
                  previewNote: deps.previewNote,
                  langDoc: langDocs.length >= 2 ? langDoc : undefined,
                }))
            : '作品名 / 版本 / 角色名不得为空或仅含非法字符')),
        // 后果提前说到选它的那一刻，而不是等作者点「部署」才吃一个拒绝（看板 HK-9）。
        // class 用既有的 `.wizard-warn`（amber）——部署/导入/新建文件三家向导同一口径，
        // 自己新加一处灰字提示就是风格分裂的开始。
        kojoDirWarning ? h('div', { className: 'wizard-warn' }, kojoDirWarning) : null),

      error ? h('div', { className: 'wizard-error' }, error) : null,

      // 动作
      h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          disabled: !canCreate,
          onClick: () => void create(),
        }, busy ? '创建中…' : '创建项目')));
  };
}
