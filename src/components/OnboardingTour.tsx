'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

export type TourStep = {
  id: string;
  title: string;
  description: string;
  selector: string;
};

type OnboardingTourProps = {
  steps: TourStep[];
  isOpen: boolean;
  onClose: (markSeen: boolean) => void;
};

type Rect = { top: number; left: number; width: number; height: number };
type Placement = 'top' | 'right' | 'bottom' | 'left';

export function OnboardingTour({ steps, isOpen, onClose }: OnboardingTourProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [tooltipPlacement, setTooltipPlacement] = useState<Placement>('bottom');
  const [arrowOffset, setArrowOffset] = useState(24);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const recheckTimeoutRef = useRef<number | null>(null);

  const activeStep = steps[activeIndex];

  const updateTargetRect = useCallback(() => {
    if (!isOpen || !activeStep) return;
    const el = document.querySelector(activeStep.selector) as HTMLElement | null;
    if (!el) {
      setTargetRect(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const isHidden = rect.width === 0 && rect.height === 0;
    const isOffscreen =
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth;
    if (isOffscreen || isHidden) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      if (recheckTimeoutRef.current) {
        window.clearTimeout(recheckTimeoutRef.current);
      }
      recheckTimeoutRef.current = window.setTimeout(() => {
        const nextRect = el.getBoundingClientRect();
        setTargetRect({ top: nextRect.top, left: nextRect.left, width: nextRect.width, height: nextRect.height });
      }, 350);
    }
    setTargetRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
  }, [activeStep, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const rafId = window.requestAnimationFrame(() => updateTargetRect());
    const onResize = () => updateTargetRect();
    const onScroll = () => updateTargetRect();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      if (recheckTimeoutRef.current) {
        window.clearTimeout(recheckTimeoutRef.current);
        recheckTimeoutRef.current = null;
      }
    };
  }, [isOpen, updateTargetRect]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const padding = 12;
    const margin = 12;
    const tooltipRect = tooltip.getBoundingClientRect();
    const target = targetRect;

    if (!target) {
      setTooltipPos({
        top: Math.max(margin, (window.innerHeight - tooltipRect.height) / 2),
        left: Math.max(margin, (window.innerWidth - tooltipRect.width) / 2),
      });
      setTooltipPlacement('bottom');
      return;
    }

    const centerX = target.left + target.width / 2;
    const centerY = target.top + target.height / 2;
    const available = {
      top: target.top - margin,
      bottom: window.innerHeight - target.top - target.height - margin,
      left: target.left - margin,
      right: window.innerWidth - target.left - target.width - margin,
    };

    const fits = (placement: Placement) => {
      if (placement === 'top' || placement === 'bottom') {
        const space = placement === 'top' ? available.top : available.bottom;
        return space >= tooltipRect.height + padding;
      }
      const space = placement === 'left' ? available.left : available.right;
      return space >= tooltipRect.width + padding;
    };

    const preferred: Placement[] = ['bottom', 'right', 'left', 'top'];
    const placement = preferred.find(fits) ?? (['top', 'bottom', 'left', 'right'] as Placement[]).reduce((best, next) => {
      return available[next] > available[best] ? next : best;
    }, 'bottom');

    let top = 0;
    let left = 0;

    if (placement === 'bottom') {
      top = target.top + target.height + padding;
      left = centerX - tooltipRect.width / 2;
    } else if (placement === 'top') {
      top = target.top - tooltipRect.height - padding;
      left = centerX - tooltipRect.width / 2;
    } else if (placement === 'right') {
      top = centerY - tooltipRect.height / 2;
      left = target.left + target.width + padding;
    } else {
      top = centerY - tooltipRect.height / 2;
      left = target.left - tooltipRect.width - padding;
    }

    const maxLeft = window.innerWidth - tooltipRect.width - margin;
    const maxTop = window.innerHeight - tooltipRect.height - margin;
    left = Math.min(Math.max(left, margin), Math.max(margin, maxLeft));
    top = Math.min(Math.max(top, margin), Math.max(margin, maxTop));

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    const arrowPadding = 12;
    const nextArrowOffset = placement === 'top' || placement === 'bottom'
      ? clamp(centerX - left, arrowPadding, tooltipRect.width - arrowPadding)
      : clamp(centerY - top, arrowPadding, tooltipRect.height - arrowPadding);

    setTooltipPos({ top, left });
    setTooltipPlacement(placement);
    setArrowOffset(nextArrowOffset);
  }, [isOpen, targetRect, activeIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose(true);
      } else if (e.key === 'ArrowRight') {
        setActiveIndex((prev) => Math.min(prev + 1, steps.length - 1));
      } else if (e.key === 'ArrowLeft') {
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, steps.length]);

  const spotlightStyle = useMemo(() => {
    if (!targetRect) return {};
    const padding = 6;
    return {
      top: Math.max(0, targetRect.top - padding),
      left: Math.max(0, targetRect.left - padding),
      width: targetRect.width + padding * 2,
      height: targetRect.height + padding * 2,
    };
  }, [targetRect]);

  if (!isOpen || steps.length === 0) return null;

  const isLastStep = activeIndex === steps.length - 1;
  const tooltipStyle = {
    top: tooltipPos.top,
    left: tooltipPos.left,
    ['--tour-arrow-offset' as string]: `${arrowOffset}px`,
  } as CSSProperties;

  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label="Onboarding tutorial">
      {targetRect ? (
        <div className="tour-spotlight" style={spotlightStyle} />
      ) : (
        <div className="tour-backdrop" />
      )}

      <div
        ref={tooltipRef}
        className="tour-tooltip"
        data-placement={tooltipPlacement}
        data-has-target={targetRect ? 'true' : 'false'}
        style={tooltipStyle}
      >
        <div className="tour-step-count">Step {activeIndex + 1} of {steps.length}</div>
        <h3 className="tour-title">{activeStep.title}</h3>
        <p className="tour-description">{activeStep.description}</p>
        <div className="tour-actions">
          <button
            type="button"
            className="tour-secondary"
            onClick={() => onClose(true)}
          >
            Skip
          </button>
          <div className="tour-nav">
            <button
              type="button"
              className="tour-secondary"
              onClick={() => setActiveIndex((prev) => Math.max(prev - 1, 0))}
              disabled={activeIndex === 0}
            >
              Back
            </button>
            <button
              type="button"
              className="tour-primary"
              onClick={() => {
                if (isLastStep) {
                  onClose(true);
                } else {
                  setActiveIndex((prev) => Math.min(prev + 1, steps.length - 1));
                }
              }}
            >
              {isLastStep ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
        <div className="tour-hint">Use Left/Right arrows to navigate, Esc to exit.</div>
      </div>
    </div>
  );
}
