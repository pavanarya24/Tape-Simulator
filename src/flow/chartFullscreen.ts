import { useEffect, useState, type RefObject } from "react";

/**
 * Check if the browser supports native Fullscreen API on elements.
 */
export function isFullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as Document & {
    webkitFullscreenEnabled?: boolean;
    mozFullScreenEnabled?: boolean;
    msFullscreenEnabled?: boolean;
  };
  return Boolean(
    doc.fullscreenEnabled ??
    doc.webkitFullscreenEnabled ??
    doc.mozFullScreenEnabled ??
    doc.msFullscreenEnabled
  );
}

/**
 * Get the current native fullscreen element.
 */
export function getFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const doc = document as Document & {
    webkitFullscreenElement?: Element;
    mozFullScreenElement?: Element;
    msFullscreenElement?: Element;
  };
  return (
    doc.fullscreenElement ??
    doc.webkitFullscreenElement ??
    doc.mozFullScreenElement ??
    doc.msFullscreenElement ??
    null
  );
}

/**
 * Check if a specific element is currently in fullscreen (native or pseudo-fullscreen fallback).
 */
export function isElementFullscreen(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (getFullscreenElement() === element) return true;
  return element.classList.contains("flow-chart-pseudo-fullscreen");
}

/**
 * Request fullscreen on an element with graceful fallback to pseudo-fullscreen.
 * Returns true if native fullscreen was entered, or false if fallback class was used.
 */
export async function enterChartFullscreen(element: HTMLElement): Promise<boolean> {
  if (!element) return false;

  const el = element as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
    mozRequestFullScreen?: () => Promise<void>;
    msRequestFullscreen?: () => Promise<void>;
  };

  if (isFullscreenSupported()) {
    try {
      if (typeof el.requestFullscreen === "function") {
        await el.requestFullscreen();
        return true;
      }
      if (typeof el.webkitRequestFullscreen === "function") {
        await el.webkitRequestFullscreen();
        return true;
      }
      if (typeof el.mozRequestFullScreen === "function") {
        await el.mozRequestFullScreen();
        return true;
      }
      if (typeof el.msRequestFullscreen === "function") {
        await el.msRequestFullscreen();
        return true;
      }
    } catch {
      // Native request was rejected (e.g. iframe permissions, lacking user gesture)
      // Fall through to graceful pseudo-fullscreen fallback
    }
  }

  // Graceful fallback
  element.classList.add("flow-chart-pseudo-fullscreen");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("resize"));
  }
  return false;
}

/**
 * Exit fullscreen mode (either native or pseudo-fullscreen fallback).
 */
export async function exitChartFullscreen(element?: HTMLElement | null): Promise<void> {
  if (element) {
    element.classList.remove("flow-chart-pseudo-fullscreen");
  }

  if (typeof document !== "undefined" && getFullscreenElement()) {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      mozCancelFullScreen?: () => Promise<void>;
      msExitFullscreen?: () => Promise<void>;
    };

    try {
      if (typeof doc.exitFullscreen === "function") {
        await doc.exitFullscreen();
      } else if (typeof doc.webkitExitFullscreen === "function") {
        await doc.webkitExitFullscreen();
      } else if (typeof doc.mozCancelFullScreen === "function") {
        await doc.mozCancelFullScreen();
      } else if (typeof doc.msExitFullscreen === "function") {
        await doc.msExitFullscreen();
      }
    } catch {
      // Ignore exit failures
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("resize"));
  }
}

export interface UseChartFullscreenOptions {
  onResize?: () => void;
}

/**
 * React hook to manage chart fullscreen state with native API and fallback.
 */
export function useChartFullscreen(
  elementRef: RefObject<HTMLElement | null>,
  options?: UseChartFullscreenOptions,
) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = elementRef.current;
    if (!el || typeof document === "undefined") return;

    const syncState = () => {
      const active = isElementFullscreen(elementRef.current);
      setIsFullscreen(active);
      options?.onResize?.();
    };

    const handleNativeChange = () => {
      syncState();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && el.classList.contains("flow-chart-pseudo-fullscreen")) {
        el.classList.remove("flow-chart-pseudo-fullscreen");
        syncState();
      }
    };

    document.addEventListener("fullscreenchange", handleNativeChange);
    document.addEventListener("webkitfullscreenchange", handleNativeChange);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("fullscreenchange", handleNativeChange);
      document.removeEventListener("webkitfullscreenchange", handleNativeChange);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [elementRef, options]);

  const toggleFullscreen = async () => {
    const el = elementRef.current;
    if (!el) return;

    if (isElementFullscreen(el)) {
      await exitChartFullscreen(el);
      setIsFullscreen(false);
    } else {
      await enterChartFullscreen(el);
      setIsFullscreen(true);
    }
    options?.onResize?.();
  };

  return {
    isFullscreen,
    toggleFullscreen,
    enterFullscreen: async () => {
      if (elementRef.current) {
        await enterChartFullscreen(elementRef.current);
        setIsFullscreen(true);
        options?.onResize?.();
      }
    },
    exitFullscreen: async () => {
      if (elementRef.current) {
        await exitChartFullscreen(elementRef.current);
        setIsFullscreen(false);
        options?.onResize?.();
      }
    },
  };
}
