/**
 * Notices: failures the operator has to be told about.
 *
 * This replaced seventeen `window.alert` calls. A native alert halts the
 * page's JavaScript until it is dismissed, so while it was up ESC could not
 * stop a sound and Fade Out All could not fade one — the one property a
 * soundboard's error surface must not have. A notice is state here and a box
 * in `NoticeStack`; it never claims a key and never takes focus.
 *
 * Notices stay until dismissed rather than fading out on a timer, because the
 * failures they carry ("that file was not added", "the swap did not happen")
 * leave nothing else on screen to say so, and a message that disappeared
 * while the operator was looking at the board is a message that was never
 * shown.
 *
 * Callable from anywhere — hooks, stores, `lib/` — through `noticeActions`,
 * the same shape `loadingStoreActions` uses.
 *
 * @module store/noticeStore
 */

import { create } from "zustand";
import { errorMessage } from "@/lib/errorMessage";

export interface Notice {
  id: number;
  message: string;
}

/** How many notices are kept; the oldest goes when a new one arrives. */
export const MAX_NOTICES = 5;

interface NoticeStoreState {
  notices: Notice[];
  actions: {
    /**
     * Shows a failure until it is dismissed, and returns its id. A message
     * that is already showing is not shown twice — a pad that fails on every
     * press must not pile up a notice per press — and keeps its id.
     */
    error: (message: string) => number;
    dismiss: (id: number) => void;
    dismissAll: () => void;
  };
}

let nextId = 1;

export const useNoticeStore = create<NoticeStoreState>((set, get) => ({
  notices: [],
  actions: {
    error: (message) => {
      const existing = get().notices.find((n) => n.message === message);
      if (existing) return existing.id;

      const id = nextId++;
      set((state) => ({
        notices: [...state.notices, { id, message }].slice(-MAX_NOTICES),
      }));
      return id;
    },

    dismiss: (id) =>
      set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),

    dismissAll: () => set({ notices: [] }),
  },
}));

export const noticeActions = useNoticeStore.getState().actions;

/**
 * What every `catch` that used to `console.error` and then `alert` does now:
 * the thrown value goes to the console in full, and the operator sees the
 * context with the message. One call, so the two cannot drift apart or be
 * half-applied.
 */
export function reportFailure(context: string, thrown: unknown): number {
  console.error(context, thrown);
  return noticeActions.error(`${context}: ${errorMessage(thrown)}`);
}
