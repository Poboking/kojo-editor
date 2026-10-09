import type { SlotMap, SlotName, SlotRegistry, Unsubscribe } from '@kojo/plugin-api';

interface StoredItem {
  item: SlotMap[SlotName];
  seq: number;
}

/**
 * 槽位注册表实现（对应架构文档 §4）。
 *
 * - 同槽多注册；查询结果按 `order` 升序稳定排序（缺省 0，同 order 按注册先后）；
 * - 同槽同 id 冲突 → 抛错（不做静默覆盖）；
 * - 注册项绑定插件 id；插件停用时由运行时统一撤销（本类提供 removeAllFor）。
 */
export class SlotRegistryImpl implements SlotRegistry {
  private readonly slots = new Map<SlotName, StoredItem[]>();
  private seq = 0;

  register<S extends SlotName>(slot: S, item: SlotMap[S], pluginId = ''): Unsubscribe {
    const list = this.getList(slot);
    if (list.some((x) => x.item.id === item.id)) {
      throw new Error(`Slot '${slot}' already has a contribution with id '${item.id}'`);
    }
    const stored: StoredItem = { item: { ...item, pluginId } as SlotMap[SlotName], seq: this.seq++ };
    list.push(stored);
    return () => {
      const arr = this.slots.get(slot);
      if (!arr) return;
      const idx = arr.indexOf(stored);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) this.slots.delete(slot);
    };
  }

  query<S extends SlotName>(slot: S): ReadonlyArray<SlotMap[S]> {
    const list = this.slots.get(slot) ?? [];
    return [...list]
      .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.seq - b.seq)
      .map((x) => x.item as SlotMap[S]);
  }

  /** 撤销某插件的全部注册（插件停用时调用） */
  removeAllFor(pluginId: string): void {
    for (const [slot, list] of this.slots) {
      const kept = list.filter((x) => x.item.pluginId !== pluginId);
      if (kept.length === 0) this.slots.delete(slot);
      else this.slots.set(slot, kept);
    }
  }

  private getList(slot: SlotName): StoredItem[] {
    let list = this.slots.get(slot);
    if (!list) {
      list = [];
      this.slots.set(slot, list);
    }
    return list;
  }
}
