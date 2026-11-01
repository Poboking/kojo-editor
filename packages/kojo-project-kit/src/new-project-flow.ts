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
  pathKey,
  sanitizePathSegment,
  type FileIO,
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
  /**
   * 上次自选的项目位置绝对路径（P0-6b，additive）。
   * 缺省 = 走默认工作区根，与历史逐字一致；旧档案里读不到这个键时行为不变。
   */
  location?: string;
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
    const location = nonEmpty(rec.location);
    if (authorName !== null) out.authorName = authorName;
    if (version !== null) out.version = version;
    if (location !== null) out.location = location;
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

/* ---------------- 项目位置记忆（P0-6b：把「自选…」的结果留给下一次） ---------------- */

/**
 * 「项目位置」行给作者看的文案：没自选过就明说是默认位置，自选过就直接给绝对路径
 * （作者要的是"我那份作品到底落在哪"，不是内部术语）。
 *
 * 住在通用半边（而不是向导组件）是因为它要被位置记忆的纯函数复用，
 * 也方便直接单测；向导侧照旧从这里 import 并转出。
 */
export function locationLabel(chosen: string | null, defaultRoot: string | null): string {
  if (chosen !== null) return chosen;
  return defaultRoot === null ? '（默认）位置暂不可用' : `（默认）${defaultRoot}`;
}

/** 记忆位置不可用时的回落提示（一句人话；失败可见，但绝不挡创建） */
export const REMEMBERED_LOCATION_FALLBACK_NOTICE = '上次的位置已不可用，已改用默认位置。';

/**
 * 记忆位置的只读判定结果。
 *
 * `not-writable` 指"目录还在，但已不在项目位置授权清单里"（撤销授权 / 平台不再准入），
 * 由 `rememberedRootAuthorized` 核 `workspaces.roots()` 得出——这份名单正是
 * `workspaces.create` 认的那一份，不是猜出来的权限。
 */
export type RememberedLocationStatus = 'ok' | 'missing' | 'not-directory' | 'read-failed' | 'not-writable';

/**
 * 用 `deps.io` 的**只读**通道核一下记忆位置：`stat` 一次同时回答"在不在 / 是不是目录 /
 * 读不读得到"（`exists` 只有布尔、`statFiles` 不给目录类型，`stat` 是唯一够用的人选）。
 * 只读、不建目录、不试写：写权限由创建工作流自己如实拒绝，打开向导时不猜。
 */
export async function probeRememberedLocation(
  io: Pick<FileIO, 'stat'>,
  path: string | null,
): Promise<RememberedLocationStatus | null> {
  if (path === null) return null;
  try {
    const st = await io.stat(path);
    if (st === null) return 'missing';
    return st.isDirectory ? 'ok' : 'not-directory';
  } catch {
    return 'read-failed';
  }
}

/**
 * 记忆位置是否仍在**已授权项目位置清单**里（纯函数）。
 *
 * 2026-10-27 收窄后自选根的根本身不再可写（只有其下解析出的作品目录可写），
 * 所以不能拿 `io.isWritable(root)` 判"还能不能建"——那对合法自选根恒为 false。
 * 判据是 `workspaces.create` 认的那份 `roots()`（默认根 + 对话框授权根），
 * 按 `pathKey` 折叠大小写与尾分隔符。
 */
export function rememberedRootAuthorized(remembered: string, roots: readonly string[]): boolean {
  const key = pathKey(remembered);
  return roots.some((r) => pathKey(r) === key);
}

/** 记忆位置 → 预填值 / 位置行文案 / 回落提示 */
export interface RememberedLocationView {
  /** 预填进 `chosenRoot` 的值；失效回落时为 null（= 默认位置） */
  chosenRoot: string | null;
  /** 「项目位置」行回显（与 `locationLabel` 同一口径） */
  line: string;
  /** 失效回落时那句人话提示；一切正常 / 没有记忆时 null */
  notice: string | null;
}

/**
 * 把"档案里的位置 + 只读判定结果"翻成向导要的三样东西（纯函数）。
 *
 * 只有判定为 `ok` 才预填；没有记忆 / 判定缺席 / 任何失效状态都回落默认位置。
 * 失效时**不静默**：给一句提示说明为什么没沿用上次的位置，创建按钮不受影响。
 */
export function rememberedLocationView(
  remembered: string | undefined,
  status: RememberedLocationStatus | null,
  defaultRoot: string | null,
): RememberedLocationView {
  if (remembered === undefined || remembered.trim().length === 0) {
    return { chosenRoot: null, line: locationLabel(null, defaultRoot), notice: null };
  }
  if (status === 'ok') {
    return { chosenRoot: remembered, line: locationLabel(remembered, defaultRoot), notice: null };
  }
  return {
    chosenRoot: null,
    line: locationLabel(null, defaultRoot),
    notice: REMEMBERED_LOCATION_FALLBACK_NOTICE,
  };
}
