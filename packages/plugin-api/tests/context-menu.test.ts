/**
 * 插件面板右键菜单**契约**（1023 覆盖面批 · WP5.1）。
 *
 * 判据（契约级，不依赖宿主）：
 * - 菜单项 / 请求的字段形状与宿主 `ContextMenuItem` 同形（逐字段可读、可选性一致）；
 * - **additive**：旧面板只传 `renderIcon` 也满足 `UIPanelProps`；新字段缺席时可安全短接；
 * - `hasCjkLabel` 与宿主中文化判据同一口径。
 */
import { describe, expect, it } from 'vitest';
import {
  copyTextToClipboard,
  hasCjkLabel,
  requestPluginMenu,
  type PluginContextMenuItem,
  type PluginContextMenuRequest,
  type UIPanelProps,
} from '../src/index';

/** 一份"字段全给"的菜单项：类型上必须全部可读（形状即判据） */
const FULL_ITEM: PluginContextMenuItem = {
  id: 'market.install',
  label: '安装',
  icon: 'download',
  shortcut: 'Ctrl+I',
  danger: false,
  disabled: true,
  disabledReason: '正在安装另一个包',
  checked: true,
  dividerBefore: true,
  group: '安装',
  children: [{ id: 'market.install.latest', label: '安装最新版' }],
};

describe('PluginContextMenuItem：与宿主模型同形', () => {
  it('全部字段都可读、值原样保留（不做业务判定）', () => {
    expect(FULL_ITEM.id).toBe('market.install');
    expect(FULL_ITEM.label).toBe('安装');
    expect(FULL_ITEM.icon).toBe('download');
    expect(FULL_ITEM.shortcut).toBe('Ctrl+I');
    expect(FULL_ITEM.danger).toBe(false);
    expect(FULL_ITEM.disabled).toBe(true);
    expect(FULL_ITEM.disabledReason).toBe('正在安装另一个包');
    expect(FULL_ITEM.checked).toBe(true);
    expect(FULL_ITEM.dividerBefore).toBe(true);
    expect(FULL_ITEM.group).toBe('安装');
    expect(FULL_ITEM.children?.[0]?.label).toBe('安装最新版');
  });

  it('只有 id / label 是最小合法菜单项（其余字段全可选）', () => {
    const minimal: PluginContextMenuItem = { id: 'refresh', label: '刷新' };
    expect(Object.keys(minimal)).toEqual(['id', 'label']);
  });
});

describe('PluginContextMenuRequest：一次请求的形状', () => {
  it('坐标 / 项 / 无障碍名 / 动作回调四件齐备', () => {
    const selected: string[] = [];
    const request = {
      x: 120,
      y: 240,
      items: [FULL_ITEM],
      ariaLabel: '市场菜单',
      onSelect: (id: string) => selected.push(id),
    } satisfies PluginContextMenuRequest;
    request.onSelect('market.install');
    expect(request.x).toBe(120);
    expect(request.y).toBe(240);
    expect(request.ariaLabel).toBe('市场菜单');
    expect(selected).toEqual(['market.install']);
  });
});

describe('UIPanelProps：新能力是 additive 的', () => {
  it('旧面板（只收到 renderIcon）依旧满足契约', () => {
    const legacy: UIPanelProps = { renderIcon: () => null };
    expect(legacy.openContextMenu).toBeUndefined();
  });

  it('新面板可选调用：宿主没注入时短接、不抛错', () => {
    const props: UIPanelProps = {};
    const request: PluginContextMenuRequest = {
      x: 0,
      y: 0,
      items: [{ id: 'a', label: '甲' }],
      ariaLabel: '面板菜单',
      onSelect: () => undefined,
    };
    expect(() => props.openContextMenu?.(request)).not.toThrow();
  });

  it('宿主注入后请求原样到达（坐标与项不被改写）', () => {
    const seen: PluginContextMenuRequest[] = [];
    const props: UIPanelProps = { openContextMenu: (req) => seen.push(req) };
    props.openContextMenu?.({
      x: 5,
      y: 6,
      items: [{ id: 'a', label: '甲' }],
      ariaLabel: '面板菜单',
      onSelect: () => undefined,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.x).toBe(5);
    expect(seen[0]?.items[0]?.label).toBe('甲');
  });
});

describe('hasCjkLabel：中文化判据', () => {
  it('含汉字才算中文文案', () => {
    expect(hasCjkLabel('复制路径')).toBe(true);
    expect(hasCjkLabel('安装 v1.2.0')).toBe(true);
    expect(hasCjkLabel('Copy Path')).toBe(false);
    expect(hasCjkLabel('')).toBe(false);
    expect(hasCjkLabel('——…')).toBe(false);
  });
});

describe('requestPluginMenu：面板发起口的三条口径', () => {
  const items = [{ id: 'copy', label: '复制' }];

  it('宿主没注入能力 ⇒ 返回 false、不抛错（旧宿主降级）', () => {
    let prevented = false;
    expect(
      requestPluginMenu({}, { clientX: 1, clientY: 2, preventDefault: () => (prevented = true) }, items, '菜单', () => undefined),
    ).toBe(false);
    expect(prevented).toBe(false); // 没有菜单可开时不该吞掉默认菜单
  });

  it('空菜单 ⇒ 不发请求（不弹空壳）', () => {
    const seen: PluginContextMenuRequest[] = [];
    expect(
      requestPluginMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, [], '菜单', () => undefined),
    ).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('真发起时透传坐标 / 项 / 无障碍名 / 回调，并阻断默认菜单', () => {
    const seen: PluginContextMenuRequest[] = [];
    let prevented = false;
    const ok = requestPluginMenu(
      { openContextMenu: (r) => seen.push(r) },
      { clientX: 30, clientY: 40, preventDefault: () => (prevented = true) },
      items,
      '面板菜单',
      () => undefined,
    );
    expect(ok).toBe(true);
    expect(prevented).toBe(true);
    expect(seen[0]?.x).toBe(30);
    expect(seen[0]?.y).toBe(40);
    expect(seen[0]?.ariaLabel).toBe('面板菜单');
    expect(seen[0]?.items[0]?.label).toBe('复制');
  });

  it('真发起时同时停冒泡：面板根与行/格都挂了菜单，最近的一级要赢', () => {
    let stopped = 0;
    requestPluginMenu(
      { openContextMenu: () => undefined },
      { clientX: 0, clientY: 0, stopPropagation: () => stopped++ },
      items,
      '面板菜单',
      () => undefined,
    );
    expect(stopped).toBe(1);
  });
});

describe('copyTextToClipboard：复制通道的降级口径', () => {
  it('环境没有剪贴板 ⇒ 明确返回 false（调用方据此给原因，不假装复制成功）', async () => {
    const saved = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    try {
      await expect(copyTextToClipboard('文本')).resolves.toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
    }
  });

  it('有剪贴板时按写入结果作答（成功 true / 拒绝 false）', async () => {
    const saved = (globalThis as { navigator?: unknown }).navigator;
    const writes: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (t: string) => void writes.push(t) } },
      configurable: true,
    });
    try {
      await expect(copyTextToClipboard('路径')).resolves.toBe(true);
      expect(writes).toEqual(['路径']);
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          clipboard: {
            writeText: async () => {
              throw new Error('权限被拒');
            },
          },
        },
        configurable: true,
      });
      await expect(copyTextToClipboard('路径')).resolves.toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
    }
  });
});
