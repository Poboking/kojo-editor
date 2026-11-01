/**
 * 新建流程的通用半边（2026-11-02 NPF-1）。
 *
 * 这一批把「新建」从"必须先打开游戏、再填四栏必填"改成两件事：
 * 1. **先选建什么**：口上作品（要游戏角色表）/ 空白工作区（不绑定任何游戏）；
 * 2. **其余字段尽量有默认**：作者名与版本从上次记住的档案预填，空白工作区连
 *    作者名都可以留空。
 *
 * 三条边界与历史一致：
 * - 本模块零游戏名词（audit A）：骨架文案只说"作品 / 文件 / 游戏"，不认任何具体游戏；
 * - 扩展名一律从契约单源现算（`lang-doc.ts`），不在这里手抄字面量；
 * - 作者档案是可选的锦上添花——`storage` 缺席时向导与历史逐字一致。
 *
 * 为什么空白工作区也走 `workspaces.create` + `createArtifact`：作者要的是"一个能写、
 * 能被编辑器索引、以后能接游戏的文件夹"，而不是一份游离在服务之外的目录。
 */

import {
  ERB_BODY_EXTENSIONS,
  KOJO_LEGACY_SOURCE_EXTENSION,
  KOJO_SOURCE_EXTENSION,
  extname,
  join,
  sanitizePathSegment,
  type ScaffoldFileSet,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { kojoLangDocExtension } from './lang-doc';

/** 可书写正文的扩展名（全部从契约单源取；折叠成小写做比较） */
const BODY_EXTENSIONS: ReadonlySet<string> = new Set(
  [KOJO_SOURCE_EXTENSION, KOJO_LEGACY_SOURCE_EXTENSION, ...ERB_BODY_EXTENSIONS].map((e) => e.toLowerCase()),
);

/* ---------------- 「新建什么」的类型分流 ---------------- */

/** 向导可建的两类项目（插件项目在后续批单独接入，不混进这两类） */
export type WizardProjectKind = 'kojo' | 'blank';

/** 类型下拉的一项 */
export interface ProjectKindChoice {
  readonly value: WizardProjectKind;
  readonly label: string;
  readonly hint: string;
  /** 非 null = 当前不可选，字符串是给作者看的下一步（不是黑话） */
  readonly disabledReason: string | null;
}

/**
 * 类型下拉（纯函数）。
 *
 * 没有打开游戏项目时**不是整窗降级**，而是把"口上作品"标成不可选并说明原因，
 * 让作者仍然能建一个空白工作区；这与"角色表来自游戏项目"是同一件事实，
 * 只是把它从一句终止语变成一条可绕开的路。
 */
export function projectKindChoices(hasGameProject: boolean): readonly ProjectKindChoice[] {
  return [
    {
      value: 'kojo',
      label: '口上作品（绑定当前游戏）',
      hint: '从当前游戏的角色表选一个目标角色，生成中文 README + 核心面空壳。',
      disabledReason: hasGameProject ? null : '需要先打开游戏项目：目标角色表来自它。',
    },
    {
      value: 'blank',
      label: '空白工作区（不绑定游戏）',
      hint: '先建一个干净、可写的作品文件夹；写什么写法、以后接哪个游戏，都由你决定。',
      disabledReason: null,
    },
  ];
}

/** 取某项类型（认不出的一律回落空白工作区——它不需要任何前置条件） */
export function projectKindChoiceOf(
  choices: readonly ProjectKindChoice[],
  kind: WizardProjectKind,
): ProjectKindChoice {
  return choices.find((c) => c.value === kind) ?? choices[1]!;
}

/* ---------------- 空白工作区的起手文件 ---------------- */

/** 空白工作区的起手文件形态 */
export type BlankSourceKind = 'erb' | 'md';

/** 起手文件下拉的一项 */
export interface BlankSourceChoice {
  readonly value: BlankSourceKind;
  readonly label: string;
  readonly hint: string;
}

/** 起手文件的扩展名（唯一取值口；ERB 形态仍然从语言档契约现算） */
export function blankSourceExtension(kind: BlankSourceKind): string {
  return kind === 'md' ? '.md' : kojoLangDocExtension('native');
}

/** 起手文件下拉（两档都只是"先写起来"，不替作者决定最终写法） */
export function blankSourceChoices(): readonly BlankSourceChoice[] {
  const erbExt = blankSourceExtension('erb');
  return [
    {
      value: 'erb',
      label: `口上正文（${erbExt}）`,
      hint: `起手文件直接是 ${erbExt}：不经转译，之后想整理成包时原样带走。`,
    },
    {
      value: 'md',
      label: '纯文本笔记（.md）',
      hint: '先写设定 / 大纲 / 草稿；等写法定了再换成正文文件。',
    },
  ];
}

/** 空白工作区的目录名：`{作品名} v{版本}`（逐段消毒；没有角色段） */
export function blankProjectDirName(workName: string, version: string): string {
  return `${sanitizePathSegment(workName)} v${sanitizePathSegment(version)}`;
}

export interface BlankProjectDraft {
  workName: string;
  /** 可以留空（空白工作区不强制署名；README 里会说明"未署名"） */
  authorName: string;
  version: string;
  sourceKind: BlankSourceKind;
}

/**
 * 空白工作区的起手产物（纯函数，不写盘）。
 *
 * 只有两件东西：一份说清"这是什么、文件放哪、以后怎么接游戏"的中文 README，
 * 以及一枚空白的起手文件。**不生成任何面空壳**——空壳是游戏知识，这里没有游戏。
 */
export function buildBlankProject(draft: BlankProjectDraft): ScaffoldFileSet {
  const workName = draft.workName.trim();
  const authorName = draft.authorName.trim();
  const version = draft.version.trim();
  const dirName = blankProjectDirName(workName, version);
  const sourceKind = draft.sourceKind;
  const sourceExt = blankSourceExtension(sourceKind);
  const sourceName = `${sourceKind === 'md' ? '笔记' : '正文'}${sourceExt}`;
  const authorLine = authorName.length > 0 ? `作者：${authorName}\n` : '作者：（未填写署名）\n';
  const files: Record<string, string> = {
    'README.md':
      `# ${workName}\n\n` +
      authorLine +
      `版本：${version}\n\n` +
      '这是一个**空白工作区**：它没有绑定任何游戏，也不替你假定某种写法。\n' +
      '你可以直接在这里放任何文件（正文、笔记、数据表），之后再把想发布的部分整理成一个包。\n\n' +
      '- 这个文件夹是**可写**的：编辑器里的修改会直接保存到这里。\n' +
      '- 要接某个游戏时，先打开游戏项目，再在「我的口上项目」里导出 / 部署。\n',
    [sourceName]: '',
  };
  return { dirName, files };
}

/**
 * 从文件名清单里挑「打开哪一枚」：
 * 1. **正文文件**（扩展名属于契约里的可书写源——`.kojo` / `.kojo1` / `.ERB` / `.erm`）；
 * 2. 没有正文时退回第一枚非 README 的文件；
 * 3. 只剩 README（或清单为空）时退回 README / null。
 *
 * 为什么先认扩展名而不是"第一个非 README"：口上脚手架的额外文件（角色表之类）
 * 排在面空壳之前，按位置挑会把作者送到一张数据表，而不是他刚想写的正文。
 */
export function pickFirstOpenName(names: readonly string[]): string | null {
  const first =
    names.find((k) => BODY_EXTENSIONS.has(extname(k).toLowerCase())) ??
    names.find((k) => k !== 'README.md') ??
    names[0];
  return first ?? null;
}

/**
 * 创建成功后要定位的文件（**绝对路径**；没有文件时 null）。
 * 挑选规则见 {@link pickFirstOpenName}。
 */
export function firstOpenPath(
  projectDir: string,
  dirName: string,
  files: Readonly<Record<string, string>>,
): string | null {
  const name = pickFirstOpenName(Object.keys(files));
  return name === null ? null : join(projectDir, dirName, name);
}

/* ---------------- 作者档案（可选持久化） ---------------- */

/** 档案在插件存储域里的键（一版一档，不和别批的键混用） */
export const WIZARD_PROFILE_KEY = 'new-project-profile-v1';

/** 上次新建留下的默认值（全部字段可选；缺省 = 没有档案） */
export interface WizardProfile {
  authorName?: string;
  version?: string;
  kind?: WizardProjectKind;
  blankSource?: BlankSourceKind;
}

/** 只用到读写的存储半边（`deps.storage` 缺席时整条档案通道关闭） */
export type WizardProfileStore = Pick<ScopedStorage, 'get' | 'set'>;

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * 读档案（**容错归空**：存储缺席 / 读失败 / 形状不对 / 越界值，一律当没有档案）。
 * 归空只意味着"这次不预填"，绝不挡住建项目。
 */
export async function readWizardProfile(store: WizardProfileStore | undefined): Promise<WizardProfile> {
  if (store === undefined) return {};
  try {
    const raw = await store.get<unknown>(WIZARD_PROFILE_KEY);
    if (typeof raw !== 'object' || raw === null) return {};
    const rec = raw as Record<string, unknown>;
    const out: WizardProfile = {};
    const authorName = nonEmpty(rec.authorName);
    const version = nonEmpty(rec.version);
    if (authorName !== null) out.authorName = authorName;
    if (version !== null) out.version = version;
    if (rec.kind === 'kojo' || rec.kind === 'blank') out.kind = rec.kind;
    if (rec.blankSource === 'erb' || rec.blankSource === 'md') out.blankSource = rec.blankSource;
    return out;
  } catch {
    return {};
  }
}

/** 写档案（失败吞掉：档案只是默认值，写不进去也不该让创建失败） */
export async function writeWizardProfile(
  store: WizardProfileStore | undefined,
  profile: WizardProfile,
): Promise<void> {
  if (store === undefined) return;
  try {
    await store.set(WIZARD_PROFILE_KEY, profile);
  } catch {
    /* 默认值没记住不构成错误 */
  }
}
