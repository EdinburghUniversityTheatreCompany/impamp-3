"use client";

import React, { Suspense, useEffect, useState } from "react";
import type { PageMetadata } from "@/lib/db";
import BankTab, { BANK_TAB_STRIP_CLASSES } from "./BankTab";

export interface BankTabStripProps {
  banks: PageMetadata[];
  currentBankId: string | null;
  isEditMode: boolean;
  onSelect: (bankId: string) => void;
  onEdit: (bankId: string) => void;
  onReorder: (orderedBankIds: string[]) => void;
}

/**
 * Everything about the strip that involves `@hello-pangea/dnd`, in a chunk of
 * its own.
 *
 * The library is 92 KB raw / 28 KB gzipped — measured on this build, the
 * largest single dependency in the payload — and the strip is on screen from
 * the first paint, so a static import made it a `<script async>` on the
 * prerendered document: roughly 9% of the gzipped first load, for a gesture
 * that only exists in edit mode. It is downloaded after first paint instead
 * (see the preload below), and the service worker still precaches it, because
 * the worker walks the asset graph through chunk contents rather than only the
 * HTML.
 */
const BankTabsDraggable = React.lazy(() => import("./BankTabsDraggable"));

/**
 * The bank ids in their new order after moving the one at `sourceIndex` to
 * `destinationIndex`. Pure and exported so the reorder math can be tested
 * without driving an actual drag gesture through `@hello-pangea/dnd`.
 *
 * Deliberately keyed by `bankId`, not by index: a migrated bank's id equals
 * `String(pageIndex)`, so an index-only implementation could pass a test
 * whose fixture ids happen to equal their positions. Callers must use
 * fixtures where they don't (see BankTabStrip.test.tsx).
 */
export function reorderBankIds(
  banks: PageMetadata[],
  sourceIndex: number,
  destinationIndex: number,
): string[] {
  const ids = banks.map((bank) => bank.bankId);
  const [moved] = ids.splice(sourceIndex, 1);
  ids.splice(destinationIndex, 0, moved);
  return ids;
}

/**
 * The bank tab strip. Renders one tab per entry of `banks`, in array order —
 * callers are expected to hand it banks already in display order (as
 * `profileStore.banks` is, via `normaliseBankOrder`).
 *
 * Dragging is enabled in edit mode (or mid-drag; see `canDrag` below) and
 * reports the new order through `onReorder`. Until the drag chunk has arrived
 * — a moment after first paint — the strip is the same tabs without a
 * `DragDropContext` around them, so the board is drawn and playable without
 * ever waiting on the drag library.
 */
export default function BankTabStrip({
  banks,
  currentBankId,
  isEditMode,
  onSelect,
  onEdit,
  onReorder,
}: BankTabStripProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  // Edit mode turns on while Shift is held. A release in the middle of a
  // drag would unmount the list under the pointer, so stay mounted until
  // the drop lands.
  const canDrag = isEditMode || isDragging;

  // Fetch the drag chunk once the board is up, and swap the strip over as
  // soon as it lands — not when edit mode turns on.
  //
  // That timing is the point. Edit mode is one keystroke away at any moment,
  // and swapping the strip at that moment would replace the very button the
  // operator had just focused, losing the focus dnd's keyboard sensor needs to
  // lift a tab. It also means the drag strip is mounted with dragging merely
  // *disabled* until edit mode, which is exactly the arrangement this
  // component had before the chunk was split out — `isDragDisabled` toggles,
  // nothing remounts.
  //
  // The download costs nothing on the critical path: it runs after paint and
  // the chunk is not referenced by the document. If it never arrives — offline
  // before the service worker has precached it — the plain strip stays, and
  // the board is fully usable without being reorderable.
  const [isDragStripReady, setIsDragStripReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const preload = () => {
      void import("./BankTabsDraggable").then(() => {
        if (!cancelled) setIsDragStripReady(true);
      });
    };
    const idle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void) => number;
      }
    ).requestIdleCallback;
    if (idle) {
      idle(preload);
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(preload, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const plainTabs = (
    <div className={BANK_TAB_STRIP_CLASSES} role="tablist">
      {banks.map((bank, position) => (
        <BankTab
          key={bank.bankId}
          bank={bank}
          position={position}
          isSelected={bank.bankId === currentBankId}
          isEditMode={isEditMode}
          onSelect={onSelect}
          onEdit={onEdit}
        />
      ))}
    </div>
  );

  if (!isDragStripReady) return plainTabs;

  return (
    <Suspense fallback={plainTabs}>
      <BankTabsDraggable
        banks={banks}
        currentBankId={currentBankId}
        isEditMode={isEditMode}
        canDrag={canDrag}
        onSelect={onSelect}
        onEdit={onEdit}
        onDragStart={() => setIsDragging(true)}
        onDrop={(sourceIndex, destinationIndex) => {
          setIsDragging(false);
          if (destinationIndex === null) return;
          onReorder(reorderBankIds(banks, sourceIndex, destinationIndex));
        }}
      />
    </Suspense>
  );
}
