"use client";

import React from "react";
import { useNoticeStore } from "@/store/noticeStore";
import WarningTriangleIcon from "@/components/icons/WarningTriangleIcon";
import XIcon from "@/components/icons/XIcon";

/**
 * The failures the operator has been told about, top right, newest at the
 * bottom.
 *
 * Above the profile manager and the search modal (both `z-50`), because a
 * failed delete or export is reported from inside one of them. Given `pointer-events-none` on the column so the empty space
 * between notices never swallows a click meant for a pad. Nothing here takes
 * focus on its own: a `<button>` that did would turn the operator's next
 * Space into "dismiss" rather than "fade out all".
 */
export default function NoticeStack() {
  const notices = useNoticeStore((s) => s.notices);
  const dismiss = useNoticeStore((s) => s.actions.dismiss);

  if (notices.length === 0) return null;

  return (
    <div
      data-testid="notice-stack"
      className="pointer-events-none fixed top-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="alert"
          data-testid="notice"
          className="pointer-events-auto flex items-start gap-3 rounded-md border border-red-300 bg-red-50 p-3 shadow-lg dark:border-red-700 dark:bg-red-950"
        >
          <WarningTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-400" />
          <p className="flex-grow text-sm text-red-800 dark:text-red-200">
            {notice.message}
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(notice.id)}
            className="-m-1 rounded p-1 text-red-700 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 dark:text-red-300 dark:hover:bg-red-900"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
