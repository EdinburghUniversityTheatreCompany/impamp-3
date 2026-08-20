"use client";

import React, { useState } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";
import type { PageMetadata } from "@/lib/db";

export interface BankTabStripProps {
  banks: PageMetadata[];
  currentBankId: string | null;
  isEditMode: boolean;
  onSelect: (bankId: string) => void;
  onEdit: (bankId: string) => void;
  onReorder: (orderedBankIds: string[]) => void;
}

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
 * reports the new order through `onReorder`.
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

  const onDragEnd: OnDragEndResponder = (result) => {
    setIsDragging(false);
    if (!result.destination) return;
    onReorder(
      reorderBankIds(banks, result.source.index, result.destination.index),
    );
  };

  return (
    <DragDropContext
      onDragStart={() => setIsDragging(true)}
      onDragEnd={onDragEnd}
    >
      <Droppable droppableId="bankTabs" direction="horizontal">
        {(provided) => (
          <div
            {...provided.droppableProps}
            ref={provided.innerRef}
            className="flex flex-1 space-x-1 overflow-x-auto pb-1"
            role="tablist"
          >
            {banks.map((bank, position) => {
              const bankNumber = position + 1;
              const isSelected = bank.bankId === currentBankId;
              return (
                <Draggable
                  key={bank.bankId}
                  draggableId={bank.bankId}
                  index={position}
                  isDragDisabled={!canDrag}
                  // Without this the tabs cannot be dragged at all, by any
                  // sensor: `@hello-pangea/dnd` refuses a drag whose source
                  // event happened inside an interactive element, and its
                  // `interactiveTagNames` (dnd.cjs.js:5605) contains 'button',
                  // which is what a tab is. It bails before preventDefault, so
                  // the key also falls through to the global handler — that is
                  // why Space faded out all audio despite the defaultPrevented
                  // guard there. Safe to disable because the tab has no
                  // interactive content of its own: it IS the handle. Only
                  // e2e-tests/bank-reorder.spec.ts can catch a regression;
                  // jsdom cannot run dnd's sensors.
                  disableInteractiveElementBlocking
                >
                  {(provided) => (
                    <button
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                      data-bank-index={position}
                      data-bank-id={bank.bankId}
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => {
                        if (isEditMode) {
                          onEdit(bank.bankId);
                        } else {
                          onSelect(bank.bankId);
                        }
                      }}
                      className={`relative px-4 py-2 rounded-t-lg flex items-center text-sm font-medium transition-colors
                                ${
                                  isSelected
                                    ? "bg-blue-500 text-white"
                                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                                }
                                ${isEditMode ? "border-t-2 border-x-2 border-dashed border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20" : ""}
                                ${bank.isEmergency ? "ring-1 ring-red-500" : ""}`}
                      aria-label={`${isEditMode ? "Edit" : "Switch to"} bank ${bankNumber}`}
                      title={
                        isEditMode
                          ? `${bank.name}${bank.isEmergency ? " (Emergency)" : ""}\nShift+click to rename`
                          : bank.name
                      }
                    >
                      <span>
                        {bankNumber}: {bank.name}
                      </span>
                      {bank.isEmergency && (
                        <span
                          className="ml-2 w-3 h-3 bg-red-500 rounded-full"
                          title="Emergency bank"
                        ></span>
                      )}
                    </button>
                  )}
                </Draggable>
              );
            })}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
