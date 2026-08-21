"use client";

import React from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";
import type { PageMetadata } from "@/lib/db";
import BankTab, { BANK_TAB_STRIP_CLASSES } from "./BankTab";

export interface BankTabsDraggableProps {
  banks: PageMetadata[];
  currentBankId: string | null;
  isEditMode: boolean;
  /** False while a drag is neither possible nor in progress. */
  canDrag: boolean;
  onSelect: (bankId: string) => void;
  onEdit: (bankId: string) => void;
  onDragStart: () => void;
  /** `destinationIndex` is null when the drag was cancelled or dropped away. */
  onDrop: (sourceIndex: number, destinationIndex: number | null) => void;
}

/**
 * The bank tab strip with dragging wired up.
 *
 * Split out of `BankTabStrip` so that `@hello-pangea/dnd` — 92 KB raw, 28 KB
 * gzipped — is not in the first-load graph of a board that is only ever
 * dragged in edit mode. See `BankTabStrip` for how and when this is loaded.
 *
 * The reorder arithmetic deliberately stays in the parent: this reports the
 * two indices and nothing else, so `reorderBankIds` keeps one caller and this
 * module keeps no knowledge of what a bank id is.
 */
export default function BankTabsDraggable({
  banks,
  currentBankId,
  isEditMode,
  canDrag,
  onSelect,
  onEdit,
  onDragStart,
  onDrop,
}: BankTabsDraggableProps): React.JSX.Element {
  const onDragEnd: OnDragEndResponder = (result) => {
    onDrop(result.source.index, result.destination?.index ?? null);
  };

  return (
    <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <Droppable droppableId="bankTabs" direction="horizontal">
        {(provided) => (
          <div
            {...provided.droppableProps}
            ref={provided.innerRef}
            className={BANK_TAB_STRIP_CLASSES}
            role="tablist"
          >
            {banks.map((bank, position) => (
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
                {(draggable) => (
                  <BankTab
                    bank={bank}
                    position={position}
                    isSelected={bank.bankId === currentBankId}
                    isEditMode={isEditMode}
                    onSelect={onSelect}
                    onEdit={onEdit}
                    innerRef={draggable.innerRef}
                    dragProps={{
                      ...draggable.draggableProps,
                      ...draggable.dragHandleProps,
                    }}
                  />
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
