import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@renderer/lib/utils';

export interface SliderProps
  extends Omit<React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>, 'children'> {
  /** Cor da trilha preenchida. Permite espelhar a cor real do LED. */
  trackColor?: string;
}

/**
 * Slider acessivel: operavel por teclado (setas, Home/End, PageUp/Down)
 * via Radix, com area de toque confortavel e anel de foco visivel.
 */
export const Slider = React.forwardRef<HTMLSpanElement, SliderProps>(
  ({ className, trackColor, ...props }, ref) => {
    const thumbCount = Array.isArray(props.value ?? props.defaultValue)
      ? ((props.value ?? props.defaultValue) as number[]).length
      : 1;

    return (
      <SliderPrimitive.Root
        ref={ref}
        className={cn(
          'relative flex w-full touch-none select-none items-center py-2',
          'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
          className,
        )}
        {...props}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-3">
          <SliderPrimitive.Range
            className="absolute h-full rounded-full bg-primary"
            style={trackColor ? { background: trackColor } : undefined}
          />
        </SliderPrimitive.Track>

        {Array.from({ length: thumbCount }, (_, index) => (
          <SliderPrimitive.Thumb
            key={index}
            className={cn(
              'block size-4 rounded-full border-2 border-primary bg-card shadow-soft',
              'transition-transform hover:scale-110 active:scale-105',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
            style={trackColor ? { borderColor: trackColor } : undefined}
          />
        ))}
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = 'Slider';

export interface LabeledSliderProps extends SliderProps {
  label: string;
  /** Texto a direita do rotulo — normalmente o valor formatado. */
  valueLabel?: string;
  /** Icone opcional antes do rotulo. */
  icon?: React.ReactNode;
  /** Explicacao curta abaixo do controle. */
  hint?: string;
}

/**
 * Slider com rotulo, valor e dica. O rotulo e um `<label>` de verdade,
 * ligado ao slider por `aria-label`, para leitor de tela anunciar certo.
 */
export function LabeledSlider({
  label,
  valueLabel,
  icon,
  hint,
  className,
  ...props
}: LabeledSliderProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          {label}
        </span>
        {valueLabel ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{valueLabel}</span>
        ) : null}
      </div>
      <Slider aria-label={label} {...props} />
      {hint ? <p className="text-xs leading-relaxed text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}
