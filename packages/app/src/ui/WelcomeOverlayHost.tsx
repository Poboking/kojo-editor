import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import { PanelBody } from './PanelHost';
import { isComposingEvent } from './shell-keys';

export interface WelcomeOverlayHostProps {
  kernel: Kernel | null;
}

/**
 * 欢迎页（无项目态）的 overlay 宿主（用户反馈 8 批）。
 *
 * 为什么需要第二个宿主：overlay 的渲染壳原本只住在 `ShellLayout`（有项目才挂载），
 * 而教程 overlay 在插件激活时就常驻注册、不依赖已打开的项目。没有项目时作者点
 * 欢迎页的教程卡片，`ui.overlay.open` 发得出去却没人接——本组件补的就是这个缺口。
 *
 * 与 `ShellLayout` 的同款契约（刻意逐条对齐，不另立一套语义）：
 * - 只认 `ui.overlay.open` / `ui.overlay.close` 两个内核事件，`payload` 原样记住但不交给组件
 *   （组件读拥有插件的闭包状态，见 `ui.overlay.open` 的契约注释）；
 * - 贡献按 `kernel.slots.query('ui.overlay')` 查 id，找不到就什么都不画（与壳层一致）；
 * - 遮罩点击 / Esc / 组件自发的 `ui.overlay.close` 走**同一条**关闭链路，重复关闭幂等。
 *
 * 差异只有两条：无项目时没有 `ShellLayout` 的全局键盘处理器，所以 Esc 在本组件里自备；
 * 打开时把焦点交给浮层、关闭后还给原控件（无项目态没有命令面板兜底，键盘用户
 * 不该在关闭教程后落回 `<body>`）。
 *
 * 只在 App 的**无项目分支**渲染：项目一打开，`ShellLayout` 接管 overlay，本组件随分支卸载。
 */
export function WelcomeOverlayHost({ kernel }: WelcomeOverlayHostProps): ReactElement | null {
  // 槽位在插件激活期注册完（内核 start 之后才有欢迎页），按 kernel 换代重查一次即可
  const overlayItems = useMemo(() => (kernel ? kernel.slots.query('ui.overlay') : []), [kernel]);
  const [active, setActive] = useState<{ id: string; payload?: unknown } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 打开浮层前的焦点落点（关闭后还回去） */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!kernel) return;
    // 内核换代 ⇒ 旧浮层属于旧内核，不能继续信
    setActive(null);
    const unOpen = kernel.bus.on('ui.overlay.open', (ev) => {
      setActive((cur) => {
        // 只有"从无到有"才记焦点落点：教程内的「查语法全表」会在浮层开着时直接换一本，
        // 那时 activeElement 在旧浮层里，记下来只会让关闭后无处可还。
        if (cur === null) {
          const opener = document.activeElement;
          returnFocusRef.current = opener instanceof HTMLElement ? opener : null;
        }
        return { id: ev.id, ...(ev.payload !== undefined ? { payload: ev.payload } : {}) };
      });
    });
    const unClose = kernel.bus.on('ui.overlay.close', (ev) => {
      // 幂等：关的不是当前这本（或已经关了）就原样返回
      setActive((cur) => (cur !== null && cur.id === ev.id ? null : cur));
    });
    return () => {
      unOpen();
      unClose();
    };
  }, [kernel]);

  const contribution = active !== null ? (overlayItems.find((o) => o.id === active.id) ?? null) : null;

  useEffect(() => {
    if (contribution !== null) {
      hostRef.current?.focus({ preventScroll: true });
      return;
    }
    const previous = returnFocusRef.current;
    returnFocusRef.current = null;
    previous?.focus({ preventScroll: true });
  }, [contribution]);

  // Esc 关闭：无项目态没有 ShellLayout 的键盘层，这里自备一条同语义的出路
  useEffect(() => {
    if (active === null || kernel === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isComposingEvent(event, false)) return;
      event.preventDefault();
      event.stopPropagation();
      // 走内核事件而不是只清本地状态：与遮罩 / 教程内「关闭」同一条关闭链路
      kernel.bus.emit('ui.overlay.close', { id: active.id, source: 'host:welcome' });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, kernel]);

  if (contribution === null || kernel === null) return null;

  /** 遮罩关闭：只发关闭意图，本地状态由上面的订阅统一收口 */
  const close = (): void => {
    kernel.bus.emit('ui.overlay.close', { id: contribution.id, source: 'host:welcome' });
  };

  return (
    <div className="overlay-backdrop" onMouseDown={close}>
      <div
        ref={hostRef}
        className={`overlay-host${contribution.size === 'wide' ? ' overlay-host-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <PanelBody contribution={contribution} />
      </div>
    </div>
  );
}
