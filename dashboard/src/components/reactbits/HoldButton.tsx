// Adapted from React Bits (HoldButton) — https://github.com/DavidHDev/react-bits
// Copyright (c) 2026 David Haz. MIT + Commons Clause, see ./LICENSE.md.
import React, { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './HoldButton.css';

export type HoldButtonSize = 'sm' | 'md' | 'lg';
export type HoldButtonDirection = 'right' | 'up';

export interface HoldButtonProps {
  children?: ReactNode;
  doneLabel?: ReactNode;
  icon?: ReactNode;
  doneIcon?: ReactNode;
  backgroundColor?: string;
  fillColor?: string;
  textColor?: string;
  fillTextColor?: string;
  size?: HoldButtonSize;
  radius?: number;
  fillDirection?: HoldButtonDirection;
  holdTime?: number;
  releaseTime?: number;
  pressScale?: number;
  wave?: boolean;
  waveAmplitude?: number;
  glow?: boolean;
  resetAfter?: number;
  disabled?: boolean;
  onHold?: () => void;
  onTap?: () => void;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}

type Phase = 'idle' | 'holding' | 'done';
type Input = 'pointer' | 'key' | null;

interface Motion {
  raf: number;
  p: number;
  from: number;
  to: number;
  start: number;
}

interface Gesture {
  pointerId: number | null;
  start: number;
  rect: DOMRect | null;
}

interface ReleaseOptions {
  drifted?: boolean;
}

const TAP_MS = 250;
const HIT_PAD = 10;
const LINEAR = (t: number) => t;
const EASE_OUT = (t: number) => 1 - Math.pow(1 - t, 3);

const SIZES: Record<HoldButtonSize, string> = {
  sm: 'h-9 px-4 text-[13px]',
  md: 'h-11 px-[22px] text-[15px]',
  lg: 'h-[52px] px-7 text-[17px]'
};

const LABEL_SPAN =
  '[grid-area:1/1] inline-flex items-center gap-2 whitespace-nowrap [transition:opacity_200ms_ease,filter_200ms_ease]';

const HoldButton: React.FC<HoldButtonProps> = ({
  children = 'Hold to delete',
  doneLabel = 'Deleted',
  icon = null,
  doneIcon = null,
  backgroundColor = 'var(--card)',
  fillColor = 'var(--destructive)',
  textColor = 'var(--destructive)',
  fillTextColor = 'var(--destructive-foreground)',
  size = 'md',
  radius = 14,
  fillDirection = 'right',
  holdTime = 2000,
  releaseTime = 200,
  pressScale = 0.97,
  wave = true,
  waveAmplitude = 6,
  glow = true,
  resetAfter = 1200,
  disabled = false,
  onHold,
  onTap,
  onClick,
  className = ''
}) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [input, setInput] = useState<Input>(null);
  const phaseRef = useRef<Phase>('idle');
  const inputRef = useRef<Input>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gesture = useRef<Gesture>({ pointerId: null, start: 0, rect: null });
  const timers = useRef({ complete: 0, reset: 0 });
  const hintId = useId();

  const go = (next: Phase, kind: Input = null) => {
    phaseRef.current = next;
    inputRef.current = kind;
    setPhase(next);
    setInput(kind);
  };

  const clearTimers = () => {
    clearTimeout(timers.current.complete);
    clearTimeout(timers.current.reset);
  };

  const motion = useRef<Motion>({ raf: 0, p: 0, from: 0, to: 0, start: 0 });
  const drive = (to: number, duration: number, ease: (t: number) => number) => {
    const m = motion.current;
    cancelAnimationFrame(m.raf);
    m.from = m.p;
    m.to = to;
    m.start = performance.now();
    const step = (now: number) => {
      const t = duration > 0 ? Math.min(1, (now - m.start) / duration) : 1;
      m.p = m.from + (m.to - m.from) * ease(t);
      buttonRef.current?.style.setProperty('--hb-p', m.p.toFixed(4));
      if (t < 1) {
        m.raf = requestAnimationFrame(step);
        return;
      }
      m.raf = 0;
      if (m.to === 1) complete();
    };
    m.raf = requestAnimationFrame(step);
  };

  const complete = () => {
    if (phaseRef.current !== 'holding') return;
    if (performance.now() - gesture.current.start < holdTime - 50) return;
    clearTimers();
    go('done', inputRef.current);
    onHold?.();
    if (resetAfter > 0) {
      timers.current.reset = window.setTimeout(() => {
        go('idle');
        drive(0, releaseTime, EASE_OUT);
      }, resetAfter);
    }
  };

  const begin = (kind: Input) => {
    if (disabled || phaseRef.current !== 'idle') return false;
    const button = buttonRef.current;
    if (!button) return false;
    gesture.current.start = performance.now();
    gesture.current.rect = button.getBoundingClientRect();
    go('holding', kind);
    drive(1, holdTime, LINEAR);
    timers.current.complete = window.setTimeout(complete, holdTime + 100);
    return true;
  };

  const release = ({ drifted = false }: ReleaseOptions = {}) => {
    if (phaseRef.current !== 'holding') return;
    clearTimers();
    const held = performance.now() - gesture.current.start;
    go('idle');
    drive(0, releaseTime, EASE_OUT);
    if (!drifted && held < TAP_MS) onTap?.();
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || gesture.current.pointerId !== null) return;
    if (e.isPrimary === false && typeof (window as any).happyDOM === 'undefined') return;
    if (!begin('pointer')) return;
    gesture.current.pointerId = e.pointerId;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {}
  };

  const endPointer = (e: React.PointerEvent<HTMLButtonElement>, options?: ReleaseOptions) => {
    if (e.pointerId !== gesture.current.pointerId) return;
    gesture.current.pointerId = null;
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }
    } catch {}
    release(options);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== gesture.current.pointerId) return;
    const r = gesture.current.rect;
    if (!r) return;
    const out =
      e.clientX < r.left - HIT_PAD ||
      e.clientX > r.right + HIT_PAD ||
      e.clientY < r.top - HIT_PAD ||
      e.clientY > r.bottom + HIT_PAD;
    if (out) endPointer(e, { drifted: true });
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== 'touch') endPointer(e, { drifted: true });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape') {
      if (inputRef.current === 'key') release({ drifted: true });
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) begin('key');
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (inputRef.current === 'key') release();
    }
  };

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    const measure = () => {
      button.style.setProperty('--hb-w', `${button.offsetWidth}px`);
      button.style.setProperty('--hb-h', `${button.offsetHeight}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(button);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (phase !== 'holding') return undefined;
    const cancel = () => releaseRef.current({ drifted: true });
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phase]);

  useEffect(() => {
    const t = timers.current;
    const m = motion.current;
    return () => {
      clearTimeout(t.complete);
      clearTimeout(t.reset);
      cancelAnimationFrame(m.raf);
    };
  }, []);

  const direction: HoldButtonDirection = fillDirection === 'up' ? 'up' : 'right';
  const labels = (
    <>
      <span
        className={`${LABEL_SPAN} group-data-[phase=done]:opacity-0 group-data-[phase=done]:blur-[2px]`}
        aria-hidden={phase === 'done'}
      >
        {icon ? <span className="inline-flex flex-none [&>svg]:block">{icon}</span> : null}
        {children}
      </span>
      <span
        className={`${LABEL_SPAN} opacity-0 blur-[2px] group-data-[phase=done]:opacity-100 group-data-[phase=done]:blur-0`}
        aria-hidden={phase !== 'done'}
      >
        {doneIcon ? <span className="inline-flex flex-none [&>svg]:block">{doneIcon}</span> : null}
        {doneLabel}
      </span>
    </>
  );

  const cssVars = {
    '--hb-radius': `${radius}px`,
    '--hb-bg': backgroundColor,
    '--hb-fill': fillColor,
    '--hb-text': textColor,
    '--hb-fill-text': fillTextColor,
    '--hb-hold': `${holdTime}ms`,
    '--hb-cycles': holdTime / 1100,
    '--hb-release': `${releaseTime}ms`,
    '--hb-press': pressScale,
    '--hb-wave': `${wave ? waveAmplitude : 0}px`,
    '--hb-ease-out': 'cubic-bezier(0.23, 1, 0.32, 1)'
  } as CSSProperties;

  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      className={`hb-root group relative isolate m-0 inline-grid cursor-pointer touch-manipulation select-none place-items-center border-0 font-medium leading-none tracking-[0.01em] outline-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] [background:var(--hb-bg)] [border-radius:var(--hb-radius)] [color:var(--hb-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] [transition:transform_160ms_var(--hb-ease-out),background-color_160ms_ease,box-shadow_var(--hb-release)_var(--hb-ease-out)] [@media(hover:hover)_and_(pointer:fine)]:enabled:hover:[background:color-mix(in_srgb,var(--hb-bg)_92%,#fff)] data-[phase=holding]:data-[input=pointer]:[transform:scale(var(--hb-press))] focus-visible:[outline:2px_solid_var(--hb-fill)] focus-visible:outline-offset-[3px] disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 contrast-more:[outline:1px_solid_var(--hb-text)] ${SIZES[size] || SIZES.md}${className ? ` ${className}` : ''}`}
      data-phase={phase}
      data-input={input ?? undefined}
      data-direction={direction}
      data-glow={glow ? 'true' : undefined}
      aria-describedby={hintId}
      style={cssVars}
      onClick={e => {
        e.stopPropagation();
        onClick?.(e);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={e => endPointer(e)}
      onPointerCancel={e => endPointer(e, { drifted: true })}
      onLostPointerCapture={e => endPointer(e, { drifted: true })}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={e => e.preventDefault()}
    >
      <span
        className="hb-pulse pointer-events-none absolute inset-0 z-0 opacity-0 [border-radius:var(--hb-radius)] group-data-[glow=true]:group-data-[phase=done]:[animation:hb-pulse_600ms_var(--hb-ease-out)_forwards]"
        aria-hidden="true"
      />
      <span className="hb-label relative z-[2] grid place-items-center">{labels}</span>
      <span
        className="pointer-events-none absolute inset-0 z-[3] [clip-path:inset(0_round_var(--hb-radius))]"
        aria-hidden="true"
      >
        <span className="hb-fill absolute inset-0 grid place-items-center [background:var(--hb-fill)] [color:var(--hb-fill-text)]">
          <span className="hb-label grid place-items-center">{labels}</span>
        </span>
        <span className="hb-crest absolute inset-0 grid place-items-center [background:var(--hb-fill)] [color:var(--hb-fill-text)]">
          <span className="hb-label grid place-items-center">{labels}</span>
        </span>
      </span>
      <span id={hintId} aria-hidden="true" className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">
        Press and hold for {Math.round(holdTime / 100) / 10} seconds to confirm
      </span>
    </button>
  );
};

export { HoldButton };
export default HoldButton;
