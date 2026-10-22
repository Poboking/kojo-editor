/**
 * 教程浮层的**懒装载壳**（PS-10 首屏批）。
 *
 * 为什么要它：`tutorial-content.ts` + `tutorial-reference*.ts` 是 223 KB 的纯文案，
 * 原先在 `plugin.ts` 的 `activate()` 里被 `TUTORIALS.sugar` 直接取用 ⇒ 三本教程的正文
 * 连同 `tutorial-overlay.ts` 一起进了 `main.tsx` 的**静态**依赖图 ⇒ 欢迎页（默认不开教程）
 * 也要在 `boot.welcomeInteractive` 之前解析并求值这 223 KB。
 *
 * 做法（不改任何可观察语义）：
 * - `ui.overlay` 仍在 `activate()` 里按**同一批 id / order / size** 注册七个贡献（面板顺序、
 *   `ui.tutorial.open` 映射、宽版档位一字不动），只有 `component` 换成这里的壳；
 * - 壳被渲染（= 浮层真的被打开）时才 `import()` 正文与渲染器，装载完成后换成真组件；
 * - 装载结果按教程 id 记忆化：同一本第二次打开零等待、零重复求值。
 *
 * 刻意**不**做开机预取：预取只是把字节提前，`import()` 的**求值**同样占主线程
 * （开机预取 = 和用户点「继续上次会话」抢同一根线程），而教程是"要看才装"的东西。
 *
 * 四个 overlay id 的真源也搬到这里（`tutorial-overlay.ts` 原样转发导出，旧引用零改动）：
 * 否则 `plugin.ts` 为了拿 id 仍要静态挂着渲染器与行内解析那一截。
 */
import { createElement as h, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { UIPanelComponent, UIPanelProps } from '@kojo/plugin-api';
import type { Tutorial, TutorialId } from './tutorial-content';

/** overlay 贡献 id（面板按钮 / 欢迎页发 `ui.overlay.open` 时引用） */
export const SUGAR_TUTORIAL_OVERLAY_ID = 'eratw.tutorialSugar';
export const KOJO_TUTORIAL_OVERLAY_ID = 'eratw.tutorialKojo';
export const REFERENCE_TUTORIAL_OVERLAY_ID = 'eratw.tutorialReference';
/** 《Kojo 2.0 语言教程》（additive：id 与另外三本同族，装载链路一字共用） */
export const KOJO2_TUTORIAL_OVERLAY_ID = 'eratw.tutorialKojo2';

/** 懒装载壳的依赖：与 `createTutorialOverlay` 同形，只是正文换成"按 id 现取" */
export interface LazyTutorialDeps {
  tutorial: TutorialId;
  /** 关闭自身（经内核事件，组件不持有宿主引用） */
  close(): void;
  /** 可选：把读者送去语法全表（两份教程的脚部各一枚；缺省不渲染按钮） */
  openReference?(): void;
}

/** 装载完成后拿到的浮层组件（`createTutorialOverlay` 的返回形：不吃 props） */
type BuiltOverlay = () => unknown;

/** 装载失败也要出声（内核铁律 4：不许静默）——这里的最小可观察面是浮层自己说一句 */
const LOADING_TEXT = '教程正在载入…';
const FAILED_TEXT = '教程载入失败，请关闭后重试';

/** 已装配好的浮层（按教程 id 记忆化；同一本第二次打开直接命中） */
const builtByTutorial = new Map<TutorialId, BuiltOverlay>();
/** 进行中的装配（并发打开同一本时共用一个 promise，不重复求值） */
const inflightByTutorial = new Map<TutorialId, Promise<BuiltOverlay>>();

/**
 * 装配一本教程的浮层组件：正文与渲染器都只在第一次被需要时才进主线程。
 *
 * 导出只为可测（`ps10-tutorial-lazy.test.ts` 直接验"装载出来的是真正文"）；
 * 生产路径由下面的壳调用。
 */
export function loadTutorialOverlay(deps: LazyTutorialDeps): Promise<BuiltOverlay> {
  const cached = builtByTutorial.get(deps.tutorial);
  if (cached) return Promise.resolve(cached);
  const pending = inflightByTutorial.get(deps.tutorial);
  if (pending) return pending;
  const task = Promise.all([import('./tutorial-content'), import('./tutorial-overlay')])
    .then(([content, overlay]) => {
      const tutorial: Tutorial = content.TUTORIALS[deps.tutorial];
      const built = overlay.createTutorialOverlay({
        tutorial,
        close: deps.close,
        openReference: deps.openReference,
      });
      builtByTutorial.set(deps.tutorial, built);
      return built;
    })
    .finally(() => {
      inflightByTutorial.delete(deps.tutorial);
    });
  inflightByTutorial.set(deps.tutorial, task);
  return task;
}

/**
 * `ui.overlay` 贡献用的懒壳：同步渲染只给一行占位，正文到位后换成真浮层。
 *
 * 宿主（`PanelBody`）把贡献当 React 组件渲染，所以这里可以用 hook；被装载进来的
 * `createTutorialOverlay` 本体仍是「纯函数产元素树」（它的测试照旧直接调它）。
 */
export function createLazyTutorialOverlay(deps: LazyTutorialDeps): UIPanelComponent {
  return function TutorialOverlayLazy(props: UIPanelProps): ReactNode {
    const [built, setBuilt] = useState<BuiltOverlay | null>(() => builtByTutorial.get(deps.tutorial) ?? null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (built || failed) return;
      let alive = true;
      loadTutorialOverlay(deps).then(
        (component) => {
          if (alive) setBuilt(() => component);
        },
        () => {
          if (alive) setFailed(true);
        },
      );
      return () => {
        alive = false;
      };
    }, [built, failed]);

    if (failed) return h('p', { className: 'notice error', role: 'alert' }, FAILED_TEXT);
    if (!built) return h('p', { className: 'notice', role: 'status' }, LOADING_TEXT);
    return h(built as ComponentType<UIPanelProps>, props);
  };
}
