/**
 * 封存层（kojo1）**首次打开说明**（LAU-3b，2026-10-27）。
 *
 * ## 为什么要有这一条
 *
 * `2.0-default` 档下 kojo1 被封存：`.kojo` / `.kojo1` 新开时落 `plaintext`——没有高亮、
 * 没有结构面、没有诊断，`.kojo 预览` 也停用。今天这件事只写在状态栏语言菜单那一行，
 * 作者打开一份旧文件看到的是"一整块白字"，很容易以为是编辑器坏了（真壳体感反馈）。
 *
 * 所以第一次遇到时给一条**可执行**的说明：说清"这是封存，不是损坏"，并给一个直达设置页
 * 的按钮。只讲一次（`localStorage` 台账），之后不再打扰；改档、重载都算作者自己的决定。
 *
 * ## 判据
 *
 * - 路径是 kojo1 源（`.kojo` / `.kojo1`，取契约层的 `KOJO_V1_SOURCE_EXTENSIONS`）；
 * - 此刻 kojo1 **封存关闭**；
 * - 这份 model 的语言确实是 `plaintext`（`.kojo` 里若是 2.0 写法会挂 `kojo2`，不弹）；
 * - 本窗口还没说过。
 *
 * 无 `window`（node 测试 / 非浏览器）⇒ 视作已说过（`true`），绝不弹。
 */
import { KOJO_V1_SOURCE_EXTENSIONS } from '@kojo/plugin-api';

/** 已说明台账的存储键（版本化：文案换代时可重新问一次） */
export const LEGACY_SEALED_NOTICE_KEY = 'kojo.ui.legacySealedNotice.v1';

/** localStorage 访问器（隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 是否已经说明过（无 window ⇒ true） */
export function loadLegacySealedNoticePrompted(): boolean {
  const s = storage();
  if (s === null) return true;
  try {
    return s.getItem(LEGACY_SEALED_NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}

/** 记下"已说明"（写不进去不算错：大不了下次再提示一次） */
export function markLegacySealedNoticePrompted(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(LEGACY_SEALED_NOTICE_KEY, '1');
  } catch {
    /* 隐私模式 / 配额满：本次提示仍有效 */
  }
}

/** 测试用：清掉台账（生产代码不调用） */
export function resetLegacySealedNoticePrompted(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.removeItem(LEGACY_SEALED_NOTICE_KEY);
  } catch {
    /* 同上 */
  }
}

export interface LegacySealedNoticeInput {
  readonly path: string;
  /** 这份 model 实际的 Monaco 语言 id */
  readonly languageId: string;
  /** kojo1 此刻可用吗（`isKojoLegacySyntaxEnabled()`） */
  readonly legacyOn: boolean;
  /** 本窗口已经说明过吗 */
  readonly prompted: boolean;
}

/** 是否该弹这一条（纯函数；判定顺序 = 从便宜到贵，全部命中才 true） */
export function shouldExplainLegacySealedOpen(input: LegacySealedNoticeInput): boolean {
  if (input.legacyOn || input.prompted) return false;
  if (input.languageId !== 'plaintext') return false;
  const lower = input.path.toLowerCase();
  return KOJO_V1_SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 作者面文案（标题 / 正文各一份；调用方原样上屏，不自己拼） */
export const LEGACY_SEALED_NOTICE_TITLE = 'kojo1 已封存，这份文件按纯文本打开';

export const LEGACY_SEALED_NOTICE_MESSAGE =
  '这是一份命令式旧写法（kojo1）的文件。kojo1 已封存且默认关闭，所以现在没有高亮、诊断和「.kojo 预览」；文件本身没有被改动。要按旧语法查看或编辑，到设置 →「Kojo 2.0 切流」选「双轨」或「只认 v1」，并按提示重载窗口。长期更推荐用「Kojo 2.0 迁移向导」把它改成 2.0 写法。';
