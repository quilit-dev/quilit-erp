// useScrollLock — body scroll lock for modals, dropdowns and the command palette.
//
// What it prevents
// ────────────────
// When the operator opens a modal and scrolls inside the modal body, the
// scroll wheel "bleeds through" once the body hits its end and the page
// underneath starts scrolling. Same problem with the notification dropdown
// and command palette. The fix is to freeze the page scroll while any
// overlay is mounted, then restore it on cleanup.
//
// How it works
// ────────────
// A reference counter (`_locks`) tracks how many overlays are currently
// asking for the lock. Nested overlays (modal -> confirm) are common, so
// we apply `overflow: hidden` once on the first lock and only release it
// when the count returns to zero. We also preserve the existing scroll
// position by compensating for the missing scrollbar width with padding-
// right so the page doesn't shift horizontally when the lock engages.
//
// Usage
// ─────
//   import { useScrollLock } from '../hooks/useScrollLock';
//   useScrollLock(isOverlayOpen);            // boolean
//
// Re-running the effect with the same boolean is a no-op — React only
// triggers cleanup when the dependency flips.

import { useEffect } from 'react';

let _locks = 0;
let _previousOverflow = '';
let _previousPaddingRight = '';

function engage() {
  _locks += 1;
  if (_locks > 1) return;       // already locked by an earlier overlay

  const html = document.documentElement;
  // Compensate for the disappearing scrollbar so the page doesn't shift.
  // (Only if the document was actually scrollable to begin with.)
  const scrollbarWidth = window.innerWidth - html.clientWidth;

  _previousOverflow      = document.body.style.overflow;
  _previousPaddingRight  = document.body.style.paddingRight;

  document.body.style.overflow     = 'hidden';
  if (scrollbarWidth > 0) {
    document.body.style.paddingRight = `${scrollbarWidth}px`;
  }
}

function release() {
  _locks = Math.max(0, _locks - 1);
  if (_locks > 0) return;       // a deeper overlay still wants the lock

  document.body.style.overflow     = _previousOverflow;
  document.body.style.paddingRight = _previousPaddingRight;
}

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return;
    engage();
    return release;
  }, [active]);
}
