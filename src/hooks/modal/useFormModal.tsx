/**
 * Form Modal Hook
 *
 * Specialized hook for working with form modals
 *
 * @module hooks/modal/useFormModal
 */

import { useCallback, useEffect, useState } from "react";
import { useModal } from "./useModal";
import type { BaseModalOptions } from "./useModal";
import React, { type ReactNode } from "react";

// Form modal options with generic for form values
export interface FormModalOptions<TFormValues> extends BaseModalOptions {
  // Initial form values
  initialValues: TFormValues;
  // Form component to render (receives and updates values)
  renderForm: (props: FormModalRenderProps<TFormValues>) => ReactNode;
  // Called when form is submitted with valid values
  onSubmit: (values: TFormValues) => void | Promise<void>;
  // Optional validation function
  validate?: (
    values: TFormValues,
  ) => FormErrors<TFormValues> | Promise<FormErrors<TFormValues>>;
  // Called when form is cancelled
  onCancel?: () => void;
}

// Props passed to the renderForm function
export interface FormModalRenderProps<TFormValues> {
  // Current form values
  values: TFormValues;
  // Update form values
  setValues: (values: TFormValues) => void;
  // Update a single form value
  updateValue: <K extends keyof TFormValues>(
    field: K,
    value: TFormValues[K],
  ) => void;
  // Form errors
  errors: FormErrors<TFormValues>;
  // Whether the form is currently being submitted
  isSubmitting: boolean;
}

// Form errors - partial record with error messages for each field
export type FormErrors<T> = Partial<Record<keyof T, string>>;

/**
 * Custom hook for working with form modals
 *
 * @returns Object with functions for working with form modals
 */
export function useFormModal() {
  const { openContentModal, closeModal } = useModal();

  /**
   * Opens a form modal with the given options
   *
   * @param options - Configuration for the form modal
   */
  const openFormModal = useCallback(
    <TFormValues extends Record<string, unknown>>(
      options: FormModalOptions<TFormValues>,
    ) => {
      const {
        initialValues,
        renderForm,
        onSubmit,
        validate,
        onCancel,
        ...baseOptions
      } = options;

      // A box for the current submit handler, filled from an *effect* rather
      // than during render.
      //
      // It used to be a bare `let` assigned in the middle of
      // `FormModalContent`'s render, into a closure outside React's control —
      // which React 19's concurrent renderer explicitly does not guarantee: a
      // discarded or double-invoked render leaves the variable pointing at a
      // throwaway closure's `values`. Assigning after commit means the box
      // always holds a handler belonging to a render that actually happened.
      const submitBox: { current: (() => Promise<void>) | null } = {
        current: null,
      };

      // Create FormModalContent component to manage form state
      const FormModalContent = () => {
        const [values, setValues] = useState<TFormValues>(initialValues);
        const [errors, setErrors] = useState<FormErrors<TFormValues>>({});
        const [isSubmitting, setIsSubmitting] = useState(false);

        // Helper to update a single field
        const updateValue = useCallback(
          <K extends keyof TFormValues>(field: K, value: TFormValues[K]) => {
            setValues((prev) => ({
              ...prev,
              [field]: value,
            }));
          },
          [],
        );

        // Defined in component scope so it closes over the live values.
        const handleFormSubmit = useCallback(async () => {
          try {
            setIsSubmitting(true);

            // Validate the form if a validate function was provided
            if (validate) {
              const validationErrors = await validate(values);
              setErrors(validationErrors);

              // If there are any errors, abort submission
              if (Object.keys(validationErrors).length > 0) {
                setIsSubmitting(false);
                return;
              }
            }

            // Call the submit handler with the current values
            await onSubmit(values);

            // Close the modal on success
            closeModal();
          } catch (error) {
            console.error("Form submission error:", error);
            // Keep modal open on error
          } finally {
            setIsSubmitting(false);
          }
        }, [values]);

        // Commit phase, not render phase.
        useEffect(() => {
          submitBox.current = handleFormSubmit;
          return () => {
            if (submitBox.current === handleFormSubmit) {
              submitBox.current = null;
            }
          };
        }, [handleFormSubmit]);

        // Render the provided form with current state
        return renderForm({
          values,
          setValues,
          updateValue,
          errors,
          isSubmitting,
        });
      };

      // External submit handler that delegates to the internal one
      const handleSubmit = async () => {
        const submit = submitBox.current;
        if (submit) {
          await submit();
          return;
        }

        // The form has not committed, so there are no edits to lose and
        // `initialValues` is exactly what would have been on screen. Reachable
        // only if something confirms a modal whose content never rendered,
        // which is worth knowing about.
        console.warn(
          "[useFormModal] Confirmed before the form rendered; submitting the initial values.",
        );
        await onSubmit(initialValues);
        closeModal();
      };

      // Open the modal with our form content
      openContentModal({
        content: <FormModalContent />,
        onConfirm: handleSubmit,
        onCancel,
        ...baseOptions,
      });
    },
    [openContentModal, closeModal],
  );

  return {
    openFormModal,
    closeModal,
  };
}
