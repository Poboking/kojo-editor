/**
 * SMOKE-NOTICE 防再腐源形状守卫（2026-10-21，BOARD SMOKE-NOTICE）——钉死 DOM 冒烟
 * 「内核装配中…」（= DOM 还没挂好）这条结构判据的**收窄边界**。不钉住，下一批很容易
 * 无声地把它再放宽或再收窄：
 *
 * ① **判据串逐字**：`tools/smoke-tauri-dom.mjs` 的 `MOUNTING_NOTICE_SEL` 必须恒为
 *    `.notice:not(.crash-recovery)`——多一个 `:not(...)`（把 `.warn` / `.error` 也放过）
 *    即红，因为那会把「浏览器环境」「打开失败」这两条合法 `.notice` 从"装配中"里放走，
 *    判据从"宁红勿漏"退成"宁绿勿漏"。
 * ② **只有一处**：页面内表达式必须引用这根常量（`JSON.stringify(MOUNTING_NOTICE_SEL)`），
 *    工具里**零处**裸 `querySelector('.notice')`——否则有人改了常量、表达式还走旧的。
 * ③ **收窄不会连"装配中"一起放过**：「内核装配中…」那条 notice 在 `WelcomeView.tsx` 里是
 *    `className="notice welcome-notice" role="status"`（**无修饰类**，按专属类 `welcome-notice`
 *    结构性定位，不匹配界面文案）⇒ 必带 `notice`、必不带 `crash-recovery`。
 *    锚点原是 `role="status"`；本批欢迎页新增了页面级菜单回执（同为 role=status，正当用法）
 *    后换的——理由写在该用例内。
 * ④ **`:not` 真的减在 `.notice` 集合上**：崩溃恢复横幅仍以 `notice crash-recovery` 渲染
 *    （className 的独立 token 级判定）——它若哪天不再挂 `notice`，这条 `:not()` 就成了空动作，
 *    守卫要跟着说话。
 * ⑤ **结构判据不沾文案**：判据那一行不许出现 CJK（"结构 only，never match UI copy"）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SMOKE = path.join(ROOT, 'tools', 'smoke-tauri-dom.mjs');
const WELCOME = path.join(ROOT, 'packages', 'app', 'src', 'ui', 'WelcomeView.tsx');

const smokeSrc = readFileSync(SMOKE, 'utf8');
const welcomeSrc = readFileSync(WELCOME, 'utf8');

/** 期望的判据串（拼起来写，免得守卫文件自己成为"手抄一份"的样板） */
const MOUNTING_NOTICE_SEL = '.notice' + ':not(.crash-recovery)';
/** 崩溃恢复横幅的修饰类（`WelcomeView` 的 className token） */
const CRASH_CLASS = 'crash' + '-recovery';

/**
 * 抽出所有 `className` 属性值里的**独立类名 token**（空白切；与
 * `welcome-recent-selector.test.ts` 同一把尺）。覆盖 JSX 的三种常见形态：
 *   className="a b c" / className={`a ${x ? ' b' : ''}`} / className={'a'}
 */
function extractClassTokens(src: string): Set<string> {
  const tokens = new Set<string>();
  const addChunk = (raw: string) => {
    for (const t of raw.replace(/\$\{[^}]*\}/g, ' ').trim().split(/\s+/)) {
      if (t) tokens.add(t);
    }
  };
  for (const m of src.matchAll(/className="([^"]*)"/g)) addChunk(m[1]!);
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) addChunk(m[1]!);
  for (const m of src.matchAll(/className=\{'([^']*)'\}/g)) addChunk(m[1]!);
  for (const m of src.matchAll(/className=\{"([^"]*)"\}/g)) addChunk(m[1]!);
  return tokens;
}

const WELCOME_TOKENS = extractClassTokens(welcomeSrc);
const WELCOME_LINES = welcomeSrc.split(/\r?\n/);

/** 某一行上的 className token 集合（行内取第一个 className 属性） */
function lineClassTokens(line: string): Set<string> {
  const m = line.match(/className="([^"]*)"/);
  return new Set((m?.[1] ?? '').trim().split(/\s+/).filter(Boolean));
}

describe('SMOKE-NOTICE ① 判据串逐字钉死（放宽 = 红）', () => {
  it(`MOUNTING_NOTICE_SEL 恒为 ${MOUNTING_NOTICE_SEL}`, () => {
    expect(
      smokeSrc,
      '`MOUNTING_NOTICE_SEL` 被改了：收窄只准放过崩溃恢复横幅（.crash-recovery），' +
        '别顺手把 .warn / .error 也放走——那会让"浏览器环境""打开失败"两条合法 notice 不再判红',
    ).toContain(`const MOUNTING_NOTICE_SEL = '${MOUNTING_NOTICE_SEL}';`);
  });

  it('页面内表达式引用这根常量，不另抄一份', () => {
    expect(
      smokeSrc,
      '结构探针里的 `mounting` 必须写成 querySelector(JSON.stringify(MOUNTING_NOTICE_SEL))',
    ).toContain('mounting: !!document.querySelector(${JSON.stringify(MOUNTING_NOTICE_SEL)})');
  });

  it('裸 .notice 判据在 DOM 冒烟里零处（回到旧判据 = 红）', () => {
    // 拆开写，防止守卫文件自身成为命中的样本（本文件不在扫描面，但保持同一习惯）
    const bare = ['querySelector(' + "'" + '.notice' + "'" + ')', 'querySelector(' + '"' + '.notice' + '"' + ')'];
    for (const needle of bare) {
      expect(smokeSrc.includes(needle), `smoke-tauri-dom.mjs 里仍有裸判据 ${needle}`).toBe(false);
    }
  });

  it('判据那一行不沾任何界面文案（结构 only）', () => {
    const line = smokeSrc.split(/\r?\n/).find((l) => l.includes('mounting: !!document.querySelector('));
    expect(line, '结构探针里的 mounting 行').toBeTruthy();
    expect(/[\u4e00-\u9fff]/.test(line!), '判据行出现 CJK——结构判据不许匹配界面文案').toBe(false);
  });
});

describe('SMOKE-NOTICE ② 收窄不会连「内核装配中…」一起放过', () => {
  it('欢迎页存在挂了 .notice 的装配中提示（welcome-notice 那条）', () => {
    /*
     * 锚点是**两个条件同时成立**，缺一不可：
     * - `role="status"`：把「警告 / 打开失败 / 崩溃恢复」那一族（role=alert）排除掉。
     *   注意崩溃横幅同样挂 `welcome-notice`（`notice crash-recovery welcome-notice`），
     *   所以**不能只用类名**过滤，否则它会被当成装配中那条。
     * - `welcome-notice`：把 2026-10-23 本批新增的**页面级菜单回执**排除掉——它是
     *   `page-menu-note welcome-menu-note` + `role="status"`，本身就是正确的可访问性用法，
     *   不该被这条守卫逼着改语义；而且它的 `className` 与 `role` 分在两行，按行取 token
     *   时 role 行没有任何类名，旧判据（只看 role）正是这样把它误判成「notice 丢了 .notice」。
     * 类名与 role 都是结构，不是界面文案，换锚点不违反本文件的 ⑤。
     */
    const noticeLines = WELCOME_LINES.filter(
      (l) => l.includes('role="status"') && lineClassTokens(l).has('welcome-notice'),
    );
    expect(noticeLines.length, 'WelcomeView 里找不到 role=status 且带 welcome-notice 的装配中提示').toBeGreaterThanOrEqual(1);
    for (const l of noticeLines) {
      const tokens = lineClassTokens(l);
      expect(tokens.has('notice'), `装配中 notice 必须仍挂 .notice：${l.trim()}`).toBe(true);
      expect(
        tokens.has(CRASH_CLASS),
        `装配中 notice 不许挂 .${CRASH_CLASS}——否则 :not() 会把它一起放过，判据失效`,
      ).toBe(false);
    }
  });

  it('`.notice` 仍是崩溃恢复横幅的类之一（:not 真的减在 .notice 集合上）', () => {
    expect(WELCOME_TOKENS.has('notice')).toBe(true);
    expect(WELCOME_TOKENS.has(CRASH_CLASS), `WelcomeView.tsx 里已无独立类名 token "${CRASH_CLASS}"`).toBe(true);
    const bannerLines = WELCOME_LINES.filter((l) => lineClassTokens(l).has(CRASH_CLASS));
    expect(bannerLines.length, '找不到崩溃恢复横幅的 className 行').toBeGreaterThanOrEqual(1);
    for (const l of bannerLines) {
      expect(
        lineClassTokens(l).has('notice'),
        `崩溃恢复横幅不再挂 .notice ⇒ ${MOUNTING_NOTICE_SEL} 里的 :not() 成了空动作：${l.trim()}`,
      ).toBe(true);
    }
  });
});
