import { useEffect, useState } from "react";

/**
 * How far outside the viewport an element still counts as near, as a share of
 * the viewport. Wide enough that a normal pan does not strobe expensive
 * surfaces off and on, narrow enough that a large board only pays for what is
 * roughly in view.
 */
export const NEAR_VIEWPORT_MARGIN = "50%";

/**
 * Track whether an element is close enough to the viewport to be worth
 * rendering expensively.
 *
 * Defaults to near and only ever narrows on an observer callback, so an
 * environment without `IntersectionObserver` — or a hidden tab, where the
 * browser stops running the observer entirely — shows the real thing rather
 * than a placeholder.
 */
export function useIsNearViewport(element: HTMLElement | null): boolean {
  const [isNear, setIsNear] = useState(true);

  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") {
      setIsNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setIsNear(entry.isIntersecting);
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return isNear;
}
