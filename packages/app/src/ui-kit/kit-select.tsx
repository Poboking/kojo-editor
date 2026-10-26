/**
 * KitSelect —— 下拉选择的单品叶子（1026 kit-converge C2-b / VIS-26）。
 *
 * 全站此前有四处"原生 `<select>` 直接落在自定义 chrome 里"（问题面板的来源过滤、检索面板
 * 的排序与范围、函数树导航器）。前三处在本批改掉；Windows 原生下拉弹层砸在自绘井上那种
 * 观感断裂，以及它顺带带来的 `-webkit-small-control` 系统字号（屏上那枚野 13.3333px 的根因）
 * 一并消失。第四处在插件包里，按解耦铁律不迁（判据见 tests/kit-field-converge.test.ts）。
 *
 * 叶子纪律照 `kit-radio`：消费方直引本文件，不经桶棒。实现自 `index.tsx` 原样搬来，
 * 桶棒改为 re-export——导出面一字不变。相对搬前只多一条 **additive** 的 `option.title`
 * （旧调用方不传即不渲染，零改动）：检索面板的「只看范围」逐档说明要它才留得住。
 */
import { type ReactElement } from 'react';

/** 类名拼接（ui-kit 总纲里那枚私有小工具；叶子各自内联一份，不为一行工具拉桶棒进图） */
const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export interface KitSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** 逐档说明（落原生 `option[title]`；缺省不渲染属性） */
  title?: string;
}

export interface KitSelectProps {
  value: string;
  /** 直接给选中项的 value，不泄漏 event */
  onChange: (value: string) => void;
  options: readonly KitSelectOption[];
  /** 无障碍名（原生 select 没有可见标题时必填语义） */
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * 下拉选择：`appearance:none` 的真 `<select>` 住在 sunken 井里 + 自绘 chevron。
 * 键盘 / 屏幕阅读器语义全部走原生（这是刻意取舍：不做 listbox 重实现，只把**外观**收进
 * 控件语言）；弹层菜单面按 token 给 `option` 底色与文字色。
 */
export function KitSelect({
  value,
  onChange,
  options,
  ariaLabel,
  title,
  disabled = false,
  id,
  className,
}: KitSelectProps): ReactElement {
  return (
    <span className={cx('kit-select', className)}>
      <select
        id={id}
        className="kit-select-input"
        value={value}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="kit-select-arrow" aria-hidden="true" />
    </span>
  );
}
