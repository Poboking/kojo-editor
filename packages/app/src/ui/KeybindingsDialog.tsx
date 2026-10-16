import { useState, type ReactElement } from 'react';
import { chordFromEvent, formatKeybinding, type CommandEntry } from './commands';
import { isComposingEvent } from './shell-keys';
import { useModalEscape } from './modal-stack';
import {
  chordToBinding,
  effectiveKeybindingOf,
  hasKeybindingOverride,
  keybindingConflictWith,
  keybindingSpecOf,
  setKeybindingOverride,
} from './keybindings';

/**
 * 键盘快捷键对话框（R8 快捷键批）——「一处可查、可显示、可改」的显示与改键面。
 *
 * 数据双源合并：统一命令注册表（壳层 + 插件贡献，含全部命令与生效键位）+
 * 键位注册表（哪些 id 允许改、缺省是什么）。改键 = 点行尾「修改」→ 按下新键位
 * → 覆盖表落 localStorage 并广播（壳层命令表随版本号重建，即刻生效）。
 *
 * 键盘纪律：
 * - Esc 优先归还「取消捕获」，没有捕获在跑才关窗（stopPropagation 挡住 modal 栈）；
 * - 输入法合成期一律让位（与命令面板同一条 `isComposingEvent` 判据）；
 * - 行尾按钮是真实 button，Tab 可达（UI-4）。
 */

interface Row {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly keys: string | undefined;
  readonly rebindable: boolean;
  readonly note: string | null;
  readonly overridden: boolean;
}

export function KeybindingsDialog({
  commands,
  onClose,
}: {
  commands: readonly CommandEntry[];
  onClose(): void;
}): ReactElement {
  useModalEscape(() => {
    if (capturing !== null) {
      setCapturing(null);
    } else {
      onClose();
    }
  });
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  const rows: Row[] = commands.map((c) => {
    const spec = keybindingSpecOf(c.id);
    return {
      id: c.id,
      title: c.title,
      category: c.category ?? '',
      keys: effectiveKeybindingOf(c.id) ?? c.keybinding,
      rebindable: spec?.rebindable ?? false,
      note: spec?.note ?? null,
      overridden: hasKeybindingOverride(c.id),
    };
  });

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (isComposingEvent(e.nativeEvent, false)) return;
    if (capturing === null) return; // 无捕获在跑：Esc 交给 modal 栈关窗，其余键原样
    if (e.key === 'Escape') {
      e.stopPropagation();
      setCapturing(null);
      return;
    }
    const chord = chordFromEvent(e.nativeEvent);
    if (chord === null) return; // 纯修饰键按下：等主键
    e.preventDefault();
    e.stopPropagation();
    const binding = chordToBinding(chord);
    if (!setKeybindingOverride(capturing, binding)) {
      setNotice(`「${capturing}」不允许改键（和弦与编辑器内部键位除外）`);
      setCapturing(null);
      return;
    }
    const conflict = keybindingConflictWith(chord, capturing);
    setNotice(
      conflict !== null
        ? `已绑定 ${formatKeybinding(binding)}——与「${conflict}」同键，按注册表顺序先到先得`
        : null,
    );
    setCapturing(null);
    forceRender((n) => n + 1); // 行内生效键位即时重画
  };

  return (
    <div className="modal-mask">
      <div className="modal keybindings-dialog" role="dialog" aria-modal="true" aria-label="键盘快捷键" onKeyDown={onKeyDown}>
        <h2>键盘快捷键</h2>
        <p className="dim">
          点「修改」后按下新键位（Esc 取消）。 Monaco 内建键位（编辑器内的查找、重命名等）不在此列，也不会被劫持。
        </p>
        {notice !== null ? <div className="keybindings-notice">{notice}</div> : null}
        <div className="keybindings-list">
          {rows.map((r) => (
            <div key={r.id} className={`keybindings-row ${capturing === r.id ? 'capturing' : ''}`}>
              <span className="keybindings-title">
                {r.category !== '' ? `${r.category}: ` : ''}
                {r.title}
                {r.overridden ? <span className="dim"> （已改）</span> : null}
              </span>
              <span className="keybinding-chord" title={r.note ?? undefined}>
                {capturing === r.id
                  ? '按下新键位…（Esc 取消）'
                  : r.keys !== undefined
                    ? formatKeybinding(r.keys)
                    : '—'}
              </span>
              {r.rebindable ? (
                <>
                  <button
                    className="ghost small"
                    onClick={() => {
                      setCapturing(r.id);
                    }}
                  >
                    修改
                  </button>
                  {r.overridden ? (
                    <button
                      className="ghost small"
                      title="恢复缺省键位"
                      onClick={() => {
                        setKeybindingOverride(r.id, null);
                        setNotice(null);
                        forceRender((n) => n + 1);
                      }}
                    >
                      复原
                    </button>
                  ) : null}
                </>
              ) : (
                <span className="dim small">{r.note ?? '不可改'}</span>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
