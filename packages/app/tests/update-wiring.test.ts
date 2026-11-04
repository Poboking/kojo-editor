/**
 * 更新提醒的**接线面**闸（2026-11-02 UI 打磨批）。
 *
 * 为什么要有这一份静态闸，而不是"跑起来看一眼"：L05 那一批已经把右下卡、跨会话免打扰、
 * `update-flow.tsx` 三件都造好并测过了（判据与渲染面都绿），**但没有一枚消费方挂它们**——
 * `ShellLayout` 里仍焊着一整套同款内联逻辑（发现即全屏模态），欢迎页零更新入口。
 * 「组件有测试、生产没人挂」是静默失效：测试全绿，用户看到的还是旧形态。
 * 本闸钉的就是"谁挂载、内联那份是否真拆干净"。
 *
 * 口径照 `ps10-eager-graph.test.ts` / `settings-search.test.ts`：静态读源码，不起壳。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const shellLayout = read('ui/ShellLayout.tsx');
const app = read('ui/App.tsx');
const updateFlow = read('ui/update-flow.tsx');

describe('更新流程只有一处真源（内联那套必须拆干净）', () => {
  it('ShellLayout 吃 `useUpdateFlow`，不再自己调 `check()` / `downloadAndInstall()`', () => {
    expect(shellLayout).toContain('useUpdateFlow(');
    expect(shellLayout).not.toContain("from '@tauri-apps/plugin-updater'");
    expect(shellLayout).not.toContain('downloadAndInstall(');
    expect(shellLayout).not.toContain('updater_env_proxy');
    // 内联那套的指纹：状态机迁移、会话变量、弹窗开关都归 hook
    expect(shellLayout).not.toContain('reduceUpdatePhase(');
    expect(shellLayout).not.toContain('dismissedUpdateVersionInSession');
    expect(shellLayout).not.toContain('AUTO_UPDATE_CHECK_DELAY_MS');
  });

  it('宿主 API 本体只住 `update-flow.tsx`（check / 代理 / 资源释放一份）', () => {
    expect(updateFlow).toContain("import { check, type Update } from '@tauri-apps/plugin-updater'");
    expect(updateFlow).toContain("invoke<string | null>('updater_env_proxy')");
    expect(updateFlow).toContain('downloadAndInstall(');
  });

  it('右下卡与详情模态都在编辑器里有落点（卡是「后台下载」期间唯一的屏上进度）', () => {
    expect(shellLayout).toContain("<UpdateNoticeCard");
    expect(shellLayout).toContain('<UpdateDialog');
    expect(shellLayout).toContain('state={update.notice}');
  });
});

describe('欢迎页也收得到更新（缺陷①：不开项目的作者过去永远收不到）', () => {
  it('App 的无项目分支挂更新宿主，且走动态边（开机图不吃 updater 插件）', () => {
    // 前缀匹配（UPD-F 批改形）：欢迎页宿主长出了 onRestart prop（「立即重启」接线），
    // 不再是自闭合 `<LazyUpdateFlowHost />`——判据意图不变：宿主仍挂在 App 的无项目分支。
    const host = app.indexOf('<LazyUpdateFlowHost');
    expect(host, 'App.tsx 里没有 <LazyUpdateFlowHost 的 JSX 挂载').toBeGreaterThan(-1);
    expect(app).toContain("lazy(() => import('./update-flow')");
    expect(app, '更新宿主被静态 import ⇒ 会进开机图').not.toMatch(/^import .*from '.\/update-flow';$/m);
    const welcome = app.indexOf('<WelcomeOverlayHost kernel={kernel} />');
    expect(welcome).toBeGreaterThanOrEqual(0);
    expect(host, 'UpdateFlowHost 不在欢迎页那一支（应与 WelcomeOverlayHost 同侧）').toBeGreaterThan(welcome);
  });
});
