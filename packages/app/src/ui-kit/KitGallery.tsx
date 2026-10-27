/**
 * KitGallery — ui-kit 内部对照页（批次十一 L14）。
 *
 * 把全部件并排渲染、可交互，供集成波与真壳截图**一次性验收全站控件语言是否合一**：
 * 同一行里 checkbox / radio / switch 是否同族、四档图标钮是否同宽、99+ 徽标是否同形。
 * 已导出但暂不接线（组长下一波接入壳层）。
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../ui/icons';
import {
  KitCheck,
  KitCount,
  KitEmpty,
  KitField,
  KitIconButton,
  KitKbd,
  KitRadio,
  KitSegmented,
  KitSelect,
  KitSkeleton,
  type KitIconSize,
} from './index';

const cap = (text: string): ReactElement => <span className="kit-gallery-cap">{text}</span>;

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="kit-gallery-section">
      <h3 className="kit-gallery-h">{title}</h3>
      <div className="kit-gallery-row">{children}</div>
    </section>
  );
}

export function KitGallery(): ReactElement {
  const [checkOn, setCheckOn] = useState(true);
  const [radioStage, setRadioStage] = useState<'off' | 'dual' | 'only'>('dual');
  const [sel, setSel] = useState('all');
  const [seg, setSeg] = useState('dark');
  const [toggle, setToggle] = useState(false);
  const [count, setCount] = useState(0);
  return (
    <div className="kit-gallery">
      <Section title="KitField（设置行：标题 + 描述 + 控件槽，max 760）">
        <div className="kit-gallery-col">
          <KitField
            as="label"
            title="整行即点即切"
            description="行内放无可见文字的 KitCheck，点行内任意处都切换"
            control={<KitCheck checked={checkOn} onChange={setCheckOn} label="整行即点即切" />}
          />
          <KitField
            title="控件独立成段"
            description="控件在右轴，描述只占左列，长描述换行不撑破右轴"
            control={<KitSegmented ariaLabel="档位示意" value={seg} onChange={setSeg} options={[{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'mint', label: '薄荷' }]} />}
          />
          <KitField title="从属项" description="nested：缩进一级 + 左侧从属线" nested control={<KitCheck checked onChange={() => undefined} label="从属项" />} />
          <KitField title="停用行" description="inactive：整行降透明度、撤 hover" inactive control={<KitSelect ariaLabel="停用示意" value={sel} onChange={setSel} options={[{ value: 'all', label: '全部' }]} disabled />} />
        </div>
      </Section>

      <Section title="勾选与单选（与 Switch 同族基线）">
        <KitCheck checked={checkOn} onChange={setCheckOn} label="带可见文字的复选框">
          带可见文字的复选框
        </KitCheck>
        <KitCheck checked={false} onChange={() => undefined} label="未勾" />
        <KitCheck checked disabled onChange={() => undefined} label="禁用复选框" />
        <KitRadio checked={radioStage === 'off'} onChange={() => setRadioStage('off')} label="关" name="gallery-stage" value="off">
          关
        </KitRadio>
        <KitRadio checked={radioStage === 'dual'} onChange={() => setRadioStage('dual')} label="并行" name="gallery-stage" value="dual">
          并行
        </KitRadio>
        <KitRadio checked disabled onChange={() => undefined} label="禁用单选" />
      </Section>

      <Section title="KitSelect（appearance:none + 自绘 chevron + token 菜单面）">
        <KitSelect
          ariaLabel="按来源过滤"
          title="按来源过滤"
          value={sel}
          onChange={setSel}
          options={[
            { value: 'all', label: '全部来源' },
            { value: 'linter', label: '约定检查（12）' },
            { value: 'compile', label: '编译器（3）' },
          ]}
        />
        <KitSelect ariaLabel="禁用下拉" value="all" onChange={() => undefined} options={[{ value: 'all', label: '禁用态' }]} disabled />
      </Section>

      <Section title="KitSegmented（收编 theme-seg-btn；方向键换档即移焦）">
        <KitSegmented
          ariaLabel="主题档"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
            { value: 'mint', label: '薄荷' },
            { value: 'none', label: '不可选', disabled: true },
          ]}
        />
      </Section>

      <Section title="KitIconButton（L10 四档 12/14/16/22；toggle 态走 accent）">
        {([12, 14, 16, 22] as const).map((s: KitIconSize) => (
          <KitIconButton key={s} label={`搜索（${s}）`} size={s} onClick={() => setCount((c) => c + 1)}>
            <Icon name="search" />
          </KitIconButton>
        ))}
        <KitIconButton label="重置（toggle 态）" active={toggle} onClick={() => setToggle((v) => !v)}>
          <Icon name="reset" />
        </KitIconButton>
        <KitIconButton label="不可点" disabled>
          <Icon name="close" />
        </KitIconButton>
      </Section>

      <Section title="KitKbd（修饰键用词、方向键用符号、和弦分步留沟）">
        <KitKbd combo="Shift+Alt+F" />
        <KitKbd combo={['Ctrl+K', 'Z']} />
        <KitKbd combo="Ctrl+Enter" />
        <KitKbd combo="Up" />
        <KitKbd combo="F4" />
      </Section>

      <Section title="KitCount（pill + bg-3 井底 + tabular-nums，99+ 溢出）">
        <KitCount value={0} />
        <KitCount value={7} tone="danger" />
        <KitCount value={99} tone="accent" />
        <KitCount value={100} tone="warning" />
        <KitCount value={2048} max={9} tone="success" />
        <span className="kit-gallery-cap">点击图标钮计数：</span>
        <KitCount value={count} />
      </Section>

      <Section title="KitEmpty（stack = kb-empty 档 / inline = picker-empty 档）">
        <div className="kit-gallery-col">
          <KitEmpty
            icon={<Icon name="search" size={22} />}
            title="还没有匹配过滤条件的问题"
            hint="顶部还有一枚「清除过滤」，退路给看得见"
            action={{ label: '清除过滤', onClick: () => undefined }}
          />
          <KitEmpty variant="inline" title="没有结果" hint="换个关键词试试" />
        </div>
      </Section>

      <Section title="基座按钮档（不住在 kit 里，但每件都从这条基线取观感）">
        <div className="kit-gallery-btns">
          <button type="button">默认</button>
          <button type="button" className="primary">
            主行动
          </button>
          <button type="button" className="ghost">
            幽灵
          </button>
          <button type="button" className="danger">
            危险
          </button>
          <button type="button" className="small">
            小号
          </button>
          <button type="button" className="big">
            大号
          </button>
          <button type="button" disabled>
            禁用
          </button>
          <button type="button" className="link">
            链接式
          </button>
        </div>
        <span className="kit-gallery-cap">
          悬停看底色/描边两档，按下看 --dur-press 的跟手回程；danger 静息只转红字与描边，不与主行动抢位
        </span>
      </Section>

      <Section title="抬升三档（--elev-1 菜单 / --elev-2 浮层 / --elev-3 模态：同一族三种厚度）">
        <div className="kit-gallery-elev">
          <div className="kit-gallery-elev-cell kit-gallery-elev-1">elev-1 · 顶缘高光 + 接触影 + 切边环</div>
          <div className="kit-gallery-elev-cell kit-gallery-elev-2">elev-2 · 离地一档更远</div>
          <div className="kit-gallery-elev-cell kit-gallery-elev-3">elev-3 · 末层自带 1px 环</div>
        </div>
        <span className="kit-gallery-cap">底下垫 sunken 是为了让三块面吃同一个背景——抬升是相对关系</span>
      </Section>

      <Section title="渐隐发丝线（.u-hairline-fade-* 一族：两端淡出，不是刀切）">
        <div className="kit-gallery-col">
          <div className="u-hairline-fade" style={{ padding: 'var(--space-2) var(--space-1)' }}>
            默认下边 · 12%/88% 两端渐隐
          </div>
          <div className="u-hairline-fade-top" style={{ padding: 'var(--space-2) var(--space-1)' }}>
            方向伴生类 · 上边
          </div>
          <span className="kit-gallery-cap">弹窗页脚（.modal-actions / .wizard-actions）即本族消费方</span>
        </div>
      </Section>

      <Section title="KitSkeleton（浮层加载态：替掉那一句 .dim）">
        <KitSkeleton lines={3} label="加载中…" />
        <KitSkeleton width={140} height={22} />
      </Section>
    </div>
  );
}
