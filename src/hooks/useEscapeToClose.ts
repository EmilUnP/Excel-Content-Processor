'use client';

import { useEffect } from 'react';

/**
 * Closes a modal when the user presses Escape.
 *
 * Every panel in the app can already be dismissed by clicking the backdrop, but
 * Escape is what people reach for first. The listener is only attached while the
 * panel is open, so closed panels cost nothing.
 *
 * @param isOpen  whether the panel is currently visible
 * @param onClose called once when Escape is pressed
 * @param enabled set to false to keep the panel open (e.g. while a job is running)
 */
export function useEscapeToClose(isOpen: boolean, onClose: () => void, enabled: boolean = true) {
  useEffect(() => {
    if (!isOpen || !enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, enabled, onClose]);
}
