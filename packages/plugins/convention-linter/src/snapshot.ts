/**
 * 约定校验结果快照（2026-10-12「体感丝滑」批）。
 *
 * ## 为什么
 * 全量校验在真实语料上实测 **3.1 s**，且插件订阅 `kojo.functionChanged` 在每次开项目
 * 后自动催动。校验是整项目粒度的纯函数（规则 = 闭包，输入 = ERB 正文 + 项目载荷），
 * 产出却很小（实测 793 条 / **307 KB**）——是级联三段里**性价比最高的缓存目标**：
 * 判据齐了就能把 3.1 s 变成一次读盘。
 *
 * ## 失效判据（四路，缺一即不缓存）
 * 1. `index.fingerprint` —— ERB 正文的体量指纹（规则读的就是它）；
 * 2. `project.inputDigest` —— adapter 吃进的非 ERB 输入（CHARA 表 / 变量名称表……
 *    有规则直接遍历 `charaIndex`）；
 * 3. `LINT_SNAPSHOT_FORMAT` —— 语义版本 salt：**改规则逻辑必须 bump**，
 *    因为规则是闭包、哈希不出它的行为；
 * 4. 规则清单摘要（`id + severity + description`）—— 增删规则或改其级别/描述即失效。
 *
 * ## 纪律
 * fail-closed：判据或结构任一不符 ⇒ null，调用方全量重跑并删除坏快照。
 * 注意「重新校验」按钮走 `run({ force: true })`——用户的显式意图是真重算，
 * 不能拿缓存糊他。
 */
import { combineDigests, foldDigest } from '@kojo/plugin-api';
import type { CacheExpect, ConventionReport, ConventionRule, ConventionSeverity, ErbIndex, GameProject } from '@kojo/plugin-api';

/** 校验语义版本；改任何规则的判定口径时 +1 */
export const LINT_SNAPSHOT_FORMAT = 1;

/** 存储键（固定：判据在快照本体里，变化即覆盖） */
export const LINT_STORE_KEY = 'lint-report-v1';

const SEVERITIES: readonly ConventionSeverity[] = ['error', 'warning', 'info'];

/** 落盘形态：报告本体 + 三重判据（`ConventionReport` 自己不带项目根） */
export interface StoredConventionReport {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly fingerprint: string;
  readonly report: ConventionReport;
}

/** 规则清单摘要：id + 级别 + 描述（逻辑变化靠 LINT_SNAPSHOT_FORMAT 兜） */
export function rulesDigest(rules: readonly ConventionRule[]): string {
  return foldDigest(rules.map((r) => `${r.id}\u0000${r.severity}\u0000${r.description ?? ''}`));
}

/** 组装本次校验的命中判据；**四路缺一 ⇒ null**（判据不全就不缓存） */
export function lintExpect(args: {
  index: Pick<ErbIndex, 'fingerprint'>;
  project: Pick<GameProject, 'rootDir' | 'adapterId' | 'inputDigest'>;
  rules: readonly ConventionRule[];
}): CacheExpect | null {
  const fingerprint = combineDigests([
    args.index.fingerprint,
    args.project.inputDigest,
    `fmt${LINT_SNAPSHOT_FORMAT}`,
    args.rules.length > 0 ? rulesDigest(args.rules) : null,
  ]);
  if (!fingerprint) return null;
  return { projectRoot: args.project.rootDir, adapterId: args.project.adapterId, fingerprint };
}

export function encodeReport(args: { report: ConventionReport; expect: CacheExpect }): StoredConventionReport {
  return {
    format: LINT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    fingerprint: args.expect.fingerprint,
    report: args.report,
  };
}

function isIssue(v: unknown): v is ConventionReport['issues'][number] {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ruleId === 'string' &&
    typeof o.message === 'string' &&
    typeof o.severity === 'string' &&
    SEVERITIES.includes(o.severity as ConventionSeverity)
  );
}

function isReport(v: unknown): v is ConventionReport {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.issues) || !Array.isArray(o.failedRules)) return false;
  if (typeof o.adapterId !== 'string' || typeof o.ruleCount !== 'number') return false;
  const counts = o.counts as Record<string, unknown> | undefined;
  if (typeof counts !== 'object' || counts === null) return false;
  if (!SEVERITIES.every((s) => typeof counts[s] === 'number')) return false;
  return o.issues.every(isIssue);
}

/** 还原报告；判据或结构任一不符 ⇒ null */
export function decodeReport(raw: unknown, expect: CacheExpect): ConventionReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredConventionReport>;
  if (s.format !== LINT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot) return null;
  if (s.adapterId !== expect.adapterId) return null;
  if (s.fingerprint !== expect.fingerprint) return null;
  if (!isReport(s.report)) return null;
  // 缓存里的报告必须是**零规则失败**的：有规则抛过错，就该让用户看到重算结果
  if (s.report.failedRules.length > 0) return null;
  return s.report;
}
