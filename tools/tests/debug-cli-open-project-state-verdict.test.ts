/**
 * KW-36 P2（2026-11-03）：`open-project` 慢盘**假 FAIL** 的收口判据。
 *
 * 现场（组长实拍）：`open-project "D:/Game/eratw/<eraTW 盘>"` 回
 * `[FAIL] 打开被应用拒绝：点开之后又回到了欢迎页…`，但随后 `state().phase` 就是 `project`、
 * 工程根也有值 —— 项目其实**开着**，红的是判据。
 *
 * 根因（读实现得出的，不是猜的）：
 * - `dom-snapshot.ts::snapshotDocument` 的 `phase` 是**从 DOM 推的**三档
 *   （有 `.welcome` ⇒ `'welcome'`；有 `.file-tree/.editor-tabs-bar/.monaco-editor` ⇒ `'project'`），
 *   应用自己那套四档 `AppPhase`（`boot/welcome/opening/project`）里的 `'opening'` **在这一族里不存在**；
 * - 于是慢盘上「正在开」那十几秒的屏还是欢迎页那一套 ⇒ 探针读到 `phase==='welcome'` 且没有树，
 *   `classifyOpenFailure` 的欢迎页回流档按**固定 1.5s settle** 判死一次成功打开。
 *
 * 修法口径（**以 state 为唯一裁决**）：
 * ① 一拍里多读两枚 state 位：`opening`＝`.welcome-open[disabled]`（应用自己说"这一趟还在开"，
 *    `WelcomeView` 的 `canOpen = kernelReady && !opening`）、`projectOpened`＝`state().project` 有根；
 * ② 这两枚任一为真 ⇒ 不是失败（纯函数直接 null）；
 * ③ 真要判死前**再复拍一次** state：复拍说树在场/弹窗在场/有根/还在开 ⇒ 不许 throw，继续走成功路径；
 * ④ 真失败（相位仍 welcome）必须带**屏上原样文案**，并说清出自哪一族
 *    （`.notice` 与 `.toast` 是两族，KW-23 的分面，别混成一格）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'tools', 'debug-cli.mjs');
const cliSrc = readFileSync(CLI, 'utf8');

/** 从源码抠出 `export function <name>(...) {...}` 并求值成真函数（同 debug-cli-open-failure 的先例） */
function extractFunction(name: string): (...args: unknown[]) => unknown {
  const head = `export function ${name}(`;
  const start = cliSrc.indexOf(head);
  expect(start, `${name} 应当被 export（纯函数，供单测直接吃）`).toBeGreaterThan(-1);
  const rest = cliSrc.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end, `${name} 的函数体应当有收尾`).toBeGreaterThan(-1);
  const src = rest.slice(0, end + 3).replace(/^export\s+/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src});`)() as (...args: unknown[]) => unknown;
}

type Verdict = { reason: string; family?: string } | null;
const classify = extractFunction('classifyOpenFailure') as (snap: unknown) => Verdict;
const said = extractFunction('saidOnScreen') as (snap: unknown, reverted: unknown) => string | undefined;

/** 欢迎页慢盘那一拍的底片：DOM 仍是 welcome、树没挂、没弹窗，但应用说"还在开" */
const slowDisk = { phase: 'welcome', hasTree: false, modal: false, revertedMs: 8000 };

describe('P2 · classifyOpenFailure：state 是唯一裁决（慢盘不许假红）', () => {
  it('① 应用自己说「还在开」（opening）⇒ null，固定 settle 判不了死', () => {
    expect(classify({ ...slowDisk, opening: true })).toBeNull();
    // 宽限早过也一样：1500ms 那一档只在"应用没说自己还在开"时才生效
    expect(classify({ ...slowDisk, revertedMs: 60000, opening: true })).toBeNull();
  });

  it('② state 已有工程根（projectOpened）⇒ null，哪怕相位影子还挂在 welcome', () => {
    expect(classify({ ...slowDisk, projectOpened: true })).toBeNull();
    expect(classify({ ...slowDisk, projectOpened: true, opening: false })).toBeNull();
  });

  it('③ 两枚裁决位都不成立、仍 welcome 超宽限 ⇒ 才是真回流（旧档位零放宽）', () => {
    const v = classify({ ...slowDisk });
    expect(v).not.toBeNull();
    expect(String(v?.reason)).toContain('欢迎页');
    expect(v?.family).toBe('welcome');
    expect(classify({ ...slowDisk, opening: false, projectOpened: false })).not.toBeNull();
    // 没到宽限不算失败（既有边界逐字不变）
    expect(classify({ phase: 'welcome', hasTree: false, modal: false, revertedMs: 300 })).toBeNull();
  });

  it('④ 树已出 / 写权限弹窗在场 ⇒ null（两条既有正常中间态不许被顺手改掉）', () => {
    expect(classify({ ...slowDisk, hasTree: true, phase: 'project' })).toBeNull();
    expect(classify({ ...slowDisk, modal: true })).toBeNull();
  });

  it('⑤ `.notice.error` 原文仍**无条件**算失败，并标 family=notice（族别混）', () => {
    const text = '这个文件夹里没有找到 CSV / ERB，看起来不是游戏目录';
    const v = classify({ ...slowDisk, errorNotices: [text] });
    expect(v?.reason).toBe(text);
    expect(v?.family).toBe('notice');
  });

  it('⑥ `.notice` 与 `.toast` **分族**判：关键词命中哪个族就报哪个族', () => {
    const toastText = '「sugar」不是可识别的游戏目录。';
    const noticeText = '打开项目失败：目录不可读';
    // 只有 toast 命中 ⇒ 报 toast 族（旧实现把两族并成一格，报出来分不清是谁说的）
    const byToast = classify({ phase: 'welcome', hasTree: false, modal: false, toasts: [toastText] });
    expect(byToast?.reason).toBe(toastText);
    expect(byToast?.family).toBe('toast');
    // 只有 notice 命中 ⇒ 报 notice 族
    const byNotice = classify({ phase: 'welcome', hasTree: false, modal: false, notices: [noticeText] });
    expect(byNotice?.reason).toBe(noticeText);
    expect(byNotice?.family).toBe('notice');
    // notice 先问（常驻卡片是更权威的那一族的原文）
    const both = classify({
      phase: 'welcome',
      hasTree: false,
      modal: false,
      notices: [noticeText],
      toasts: [toastText],
    });
    expect(both?.reason).toBe(noticeText);
    expect(both?.family).toBe('notice');
  });

  it('⑦ toast 仍**不无条件**判死：与本次打开无关的后台提示不许把正常打开钉死', () => {
    expect(classify({ ...slowDisk, opening: true, toasts: ['能力矩阵：某方言未登记'] })).toBeNull();
    expect(classify({ phase: 'opening', hasTree: false, modal: false, toasts: ['格式提示'] })).toBeNull();
  });

  it('⑧ 缺字段 / 脏值 ⇒ null（没有信号≠失败），既有入参形态逐字不抛', () => {
    expect(classify(undefined)).toBeNull();
    expect(classify({})).toBeNull();
    expect(classify({ notices: null, toasts: null, phase: null, hasTree: null, modal: null })).toBeNull();
    expect(classify({ phase: 'welcome', revertedMs: Number.NaN, opening: 1 as unknown as boolean })).toBeNull();
  });
});

describe('P2 · saidOnScreen：真失败带屏上原样文案，并说清是哪一族', () => {
  it('① 本次新 toast 优先，带 toast 标签', () => {
    expect(
      said({ freshToasts: ['「sugar」不是可识别的游戏目录。'], errorToasts: ['旧的一条'], errorNotices: ['卡片的'] }, true),
    ).toBe('toast「「sugar」不是可识别的游戏目录。」');
  });

  it('② 回流时新 toast 为空（文案与底片逐字相同被去重）⇒ 取屏上最后一条 error toast', () => {
    expect(said({ freshToasts: [], errorToasts: ['第一条', '应用真说的那句'], errorNotices: [] }, true)).toBe(
      'toast「应用真说的那句」',
    );
    // 没回流就不许把旧 error toast 当本次的原文端出去
    expect(said({ freshToasts: [], errorToasts: ['后台留的那句'], errorNotices: [] }, false)).toBeUndefined();
  });

  it('③ toast 一句没有 ⇒ 退 `.notice.error` 原文并带 notice 标签', () => {
    expect(said({ errorNotices: ['这个文件夹不是工程根'] }, true)).toBe('notice「这个文件夹不是工程根」');
  });

  it('④ 两族都空白 / 脏入参 ⇒ undefined（由调用方回落判据理由，不编造原文）', () => {
    expect(said({ freshToasts: ['   '], errorToasts: [''], errorNotices: [''] }, true)).toBeUndefined();
    expect(said({}, true)).toBeUndefined();
    expect(said(undefined, true)).toBeUndefined();
    expect(said({ freshToasts: '不是数组' }, true)).toBeUndefined();
  });
});

describe('P2 · cmdOpenProject 的源形状：判死前以 state 复拍，成功路径照旧', () => {
  const body = (): string => {
    const start = cliSrc.indexOf('async function cmdOpenProject(');
    expect(start).toBeGreaterThan(-1);
    const rest = cliSrc.slice(start);
    const end = rest.indexOf('\nfunction quickOpenSurface(');
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  };

  it('① 一拍里读齐两枚 state 裁决位（结构与 dom-snapshot 的 phase 影子同处一张拍）', () => {
    const b = body();
    expect(b).toContain(`const openBtn = d.querySelector('.welcome-open')`);
    expect(b).toContain('opening: !!openBtn && openBtn.disabled === true');
    expect(b).toContain('projectOpened: !!(st && st.project)');
  });

  it('② 两族分开交进判据（不再把 toast 并进 notices）', () => {
    const b = body();
    expect(b).toContain('notices: probe.notices ?? []');
    expect(b).toContain('toasts: probe.freshToasts ?? []');
    expect(b).not.toContain('[...(probe.notices ?? []), ...(probe.freshToasts ?? [])]');
  });

  it('③ 判死之前以 state 复拍：复拍说成了就不许 throw', () => {
    const b = body();
    expect(b).toContain('const confirm = await readProbe()');
    expect(b).toContain('if (confirm?.hasTree)');
    expect(b).toContain('if (confirm && (confirm.projectOpened === true || confirm.opening === true)) continue;');
    expect(b).toContain('const shot = confirm ?? probe');
    expect(b).toContain('saidOnScreen(shot, reverted)');
    // 既有出口形态逐字保留（固定文案 + exit 1 那条口径由 debug-cli-open-failure 钉着）
    expect(b).toContain('throw openRejectedError(abs, said || verdict.reason)');
  });

  it('④ 预算用完那条也要带 state 读数（"没信号"要说清当时应用在哪一档）', () => {
    const b = body();
    expect(b).toContain('let lastProbe = null');
    expect(b).toContain('正在打开=${lastProbe.opening}');
    expect(b).toContain('工程根=${lastProbe.projectOpened}');
  });

  it('⑤ 成功路径的硬对拍一个字没动（防假绿的 PITFALLS 230 那条腿）', () => {
    const b = body();
    expect(b).toContain(`await waitFor(cdp, \`!!document.querySelector('.file-tree')\``);
    expect(b).toContain('project.rootDir');
    expect(b).toContain('打开的目录与请求不一致（假绿拦截）');
  });

  it('⑥ 慢盘成功不靠放预算：树/弹窗命中即 break，与 --timeout 无关（既有档位保留）', () => {
    const b = body();
    expect(b).toContain("modal = 'tree'");
    expect(b).toContain("modal = 'yes'");
    expect(b).toContain('clampOpenTimeout(args?.timeout)');
  });
});
