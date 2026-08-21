/**
 * Opening one of this app's forms the way the app opens it.
 *
 * Every form here is rendered by `useFormModal` rather than mounted directly:
 * the hook owns `values`, `updateValue`, `errors` and the confirm handler, so
 * a test that mounts `<EditPadForm>` with hand-made props is testing a wiring
 * no user ever exercises. Going through the real hook is what makes "picking
 * this option ends up in the values `onSubmit` is handed" a question the test
 * can actually ask — and it is also the only way to see the markup the modal
 * really produces.
 *
 * The DOM helpers are here for the same reason `reactPanel.tsx` has its own:
 * a missing element must fail with the test id it looked for, not with
 * `null.click is not a function` three frames down.
 *
 * Unlike `reactPanel.tsx` this settles on microtasks alone. These forms do no
 * I/O on mount — a pad with sounds would read them back out of IndexedDB, and
 * the suites using this pass none — so there is nothing here for a macrotask
 * pump to wait for.
 */

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import { useFormModal } from "@/hooks/modal/useFormModal";
import { useUIStore } from "@/store/uiStore";

/** One opened form, and the values its `onSubmit` has been handed so far. */
export interface OpenedForm<V> {
  /** Every value set `onSubmit` received, in order. */
  submitted: V[];
  /** Runs the modal's own confirm handler, as the Save button does. */
  save(): Promise<void>;
}

export interface FormModalHarness {
  /** The element the modal content is rendered into. */
  container: HTMLDivElement;
  /**
   * Opens a real form modal over `initialValues` and mounts whatever content
   * it puts in the UI store, which is the same path `usePadInteractions` and
   * `usePlaybackSettings` take.
   */
  openForm<V extends Record<string, unknown>>(
    initialValues: V,
    renderForm: (props: FormModalRenderProps<V>) => React.ReactNode,
  ): OpenedForm<V>;
  /** Clicks the radio with this test id, failing loudly when it is absent. */
  chooseOption(testId: string): void;
  /** The value of the checked radio in a group, or null when none is checked. */
  checkedValueOf(groupTestId: string): string | null;
  /** Empties the container without tearing the root down. */
  clear(): void;
  /** Unmounts, removes the container and closes the modal. */
  teardown(): void;
}

/** Mounts an empty harness. Call `teardown()` from `afterEach`. */
export function mountFormModalHarness(): FormModalHarness {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  return {
    container,

    openForm<V extends Record<string, unknown>>(
      initialValues: V,
      renderForm: (props: FormModalRenderProps<V>) => React.ReactNode,
    ): OpenedForm<V> {
      const submitted: V[] = [];

      function Harness() {
        const { openFormModal } = useFormModal();
        React.useEffect(() => {
          openFormModal<V>({
            title: "Test",
            initialValues,
            renderForm,
            onSubmit: (values) => {
              submitted.push(values);
            },
          });
        }, [openFormModal]);
        const content = useUIStore((state) => state.modalConfig?.content);
        return <>{content}</>;
      }

      act(() => {
        root.render(<Harness />);
      });

      return {
        submitted,
        save: async () => {
          const onConfirm = useUIStore.getState().modalConfig?.onConfirm;
          if (!onConfirm) throw new Error("the modal has no confirm handler");
          await act(async () => {
            await onConfirm();
          });
        },
      };
    },

    chooseOption(testId: string) {
      const radio = container.querySelector<HTMLInputElement>(
        `input[data-testid="${testId}"]`,
      );
      if (!radio) throw new Error(`no radio with data-testid="${testId}"`);
      act(() => {
        radio.click();
      });
    },

    checkedValueOf(groupTestId: string): string | null {
      const group = container.querySelector(`[data-testid="${groupTestId}"]`);
      if (!group) throw new Error(`no radio group "${groupTestId}"`);
      const checked = group.querySelectorAll<HTMLInputElement>("input:checked");
      if (checked.length > 1) {
        throw new Error(`${checked.length} radios checked in "${groupTestId}"`);
      }
      return checked[0]?.value ?? null;
    },

    clear() {
      act(() => {
        root.render(<></>);
      });
    },

    teardown() {
      act(() => root.unmount());
      container.remove();
      useUIStore.getState().closeModal();
    },
  };
}
