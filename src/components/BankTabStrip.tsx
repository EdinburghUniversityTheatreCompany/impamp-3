"use client";

import React from "react";
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
 * The bank tab strip. Renders one tab per entry of `banks`, in array order —
 * callers are expected to hand it banks already in display order (as
 * `profileStore.banks` is, via `normaliseBankOrder`).
 *
 * `onReorder` is accepted but unused until Task 16 wires up dragging.
 */
export default function BankTabStrip({
  banks,
  currentBankId,
  isEditMode,
  onSelect,
  onEdit,
}: BankTabStripProps): React.JSX.Element {
  return (
    <div className="flex flex-1 space-x-1 overflow-x-auto pb-1" role="tablist">
      {banks.map((bank, position) => {
        const bankNumber = position + 1;
        const isSelected = bank.bankId === currentBankId;
        return (
          <button
            key={bank.bankId}
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
      })}
    </div>
  );
}
