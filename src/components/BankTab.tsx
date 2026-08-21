"use client";

import React from "react";
import type { PageMetadata } from "@/lib/db";

/** The strip's own container classes, shared by both versions of it. */
export const BANK_TAB_STRIP_CLASSES =
  "flex flex-1 space-x-1 overflow-x-auto pb-1";

export interface BankTabProps {
  bank: PageMetadata;
  /** Display position, 0-based. The tab's number is this plus one. */
  position: number;
  isSelected: boolean;
  isEditMode: boolean;
  onSelect: (bankId: string) => void;
  onEdit: (bankId: string) => void;
  /**
   * `@hello-pangea/dnd`'s `provided.innerRef` and the two prop bags it hands
   * a Draggable's child, when this tab is being rendered inside one. Absent
   * for the plain strip, which is what the board renders until edit mode
   * turns on — see `BankTabStrip`.
   */
  innerRef?: (element: HTMLElement | null) => void;
  dragProps?: Record<string, unknown>;
}

/**
 * One bank tab.
 *
 * Its own component so that the plain strip and the drag-and-drop strip render
 * the *same* tab rather than two copies that drift — the tab carries the
 * selection, the edit-mode affordance, the emergency ring and the labels, and
 * none of that has anything to do with dragging.
 */
export default function BankTab({
  bank,
  position,
  isSelected,
  isEditMode,
  onSelect,
  onEdit,
  innerRef,
  dragProps,
}: BankTabProps): React.JSX.Element {
  const bankNumber = position + 1;

  return (
    <button
      ref={innerRef}
      {...dragProps}
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
  );
}
