/**
 * `tools/context-menu-smoke.mjs` 是**纯 JS** 的真机冒烟脚本（Node 侧跑 CDP，
 * 不进 app 打包，也不在 `packages/app/tsconfig.json` 的 include 里）。
 *
 * `context-menu-smoke-replay.test.ts` 要用的只是它的**判定器**
 * （`judgeContextMenuProbes`）——在 happy-dom 里重演同一套判据，避免"脚本自己判自己"。
 * 这里给那一份导出面一个最小声明，不让 JS 脚本把 app 的类型检查拖红。
 *
 * 为什么不用 `@ts-expect-error`：那会把整块返回值退化成 `any`，重演测试里
 * `checks[].group / ok / name` 的拼写错误就再也抓不到了。
 *
 * 字段只声明重演测试真正读的那几个（`group / name / ok / skipped / detail`）；
 * 脚本以后加字段不需要动这里。若脚本改名或删掉 `judgeContextMenuProbes`，
 * `tools/tests/context-menu-smoke-shape.test.ts` 与这里会同时红。
 */
declare module '*context-menu-smoke.mjs' {
  export interface SmokeCheck {
    readonly group: string;
    readonly name: string;
    readonly ok: boolean;
    readonly skipped?: boolean;
    readonly detail: string;
  }

  export interface SmokeJudgement {
    readonly checks: readonly SmokeCheck[];
    readonly pass: boolean;
    readonly skipped: readonly string[];
  }

  /** 页内采集到的读数 → 四组判定（不读 DOM、不连浏览器，纯函数） */
  export function judgeContextMenuProbes(readings: unknown): SmokeJudgement;

  /** 页内采集：返回一段可被 CDP `Runtime.evaluate` 执行的表达式 */
  export function runContextMenuProbes(opts: unknown): string;

  export const CONTEXT_MENU_ARIA_EXPECT: Readonly<Record<string, string>>;
  export const FALLBACK_MENU_ARIA_LABEL_EXPECT: string;
  export const HOST_Z_INDEX_MIN: number;
  export const CTX_SMOKE_SELECTORS: Readonly<Record<string, string>>;
  export const CTX_SMOKE_GROUPS: readonly string[];
}
