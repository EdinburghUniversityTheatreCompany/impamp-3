/**
 * Form Modal Usage Example
 *
 * This file demonstrates how to use the form modal pattern
 * for editing a pad directly, without using the legacy EditPadModalContent wrapper.
 *
 * @module examples/FormModalUsage
 */

import React from "react";
import { useFormModal } from "@/hooks/modal/useFormModal";
import EditPadForm from "@/components/modals/EditPadForm";
import type { PadFormValues, FormErrors } from "@/types/forms";
import type { PadConfiguration } from "@/lib/db";
import { DEFAULT_PAD_NAME } from "@/lib/constants";
import { upsertPadConfiguration } from "@/lib/db";

interface UseEditPadModalOptions {
  activeProfileId: number;
  currentPageIndex: number;
  padIndex: number;
  initialPadConfig?: Partial<PadConfiguration>;
}

/**
 * Hook to open a pad edit modal using the form modal pattern
 */
export function useEditPadModal() {
  const { openFormModal } = useFormModal();

  /**
   * Opens a modal to edit a pad's configuration
   */
  const openEditPadModal = async ({
    activeProfileId,
    currentPageIndex,
    padIndex,
    initialPadConfig = {},
  }: UseEditPadModalOptions) => {
    if (activeProfileId === null) {
      console.error("Cannot edit pad: No active profile selected");
      return;
    }

    // Set up initial values from the pad configuration
    const initialValues: PadFormValues = {
      name: initialPadConfig.name || DEFAULT_PAD_NAME,
      playbackType: initialPadConfig.playbackType || "sequential",
      audioFileIds: initialPadConfig.audioFileIds || [],
    };

    // Open form modal with edit pad form
    openFormModal<PadFormValues>({
      title: `Edit Pad ${padIndex + 1}`,
      initialValues,
      renderForm: (props) => (
        <EditPadForm {...props} profileId={activeProfileId} />
      ),
      validate: (values) => {
        const errors: FormErrors<PadFormValues> = {};

        // Add validation as needed
        if (!values.name.trim()) {
          errors.name = "Pad name is required";
        }

        return errors;
      },
      onSubmit: async (values) => {
        try {
          // Save the pad configuration with updated values
          await upsertPadConfiguration({
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: padIndex,
            name: values.name,
            playbackType: values.playbackType,
            audioFileIds: values.audioFileIds,
            // Preserve other fields that might be in the initial configuration
            keyBinding: initialPadConfig.keyBinding,
          });

          console.log(`Pad ${padIndex + 1} updated successfully`);
        } catch (error) {
          console.error("Failed to update pad:", error);
          throw error; // Re-throw to prevent modal from closing
        }
      },
      confirmText: "Save Changes",
      size: "md",
    });
  };

  return { openEditPadModal };
}

/**
 * Example usage in a component:
 *
 * ```tsx
 * const ExampleComponent = () => {
 *   const { openEditPadModal } = useEditPadModal();
 *   const activeProfileId = useProfileStore(state => state.activeProfileId);
 *   const currentPageIndex = useProfileStore(state => state.currentPageIndex);
 *
 *   // Example pad configuration
 *   const padConfig = {
 *     name: 'My Pad',
 *     playbackType: 'sequential' as const,
 *     audioFileIds: [1, 2, 3],
 *   };
 *
 *   return (
 *     <button
 *       onClick={() => openEditPadModal({
 *         activeProfileId,
 *         currentPageIndex,
 *         padIndex: 0, // First pad
 *         initialPadConfig: padConfig,
 *       })}
 *     >
 *       Edit Pad
 *     </button>
 *   );
 * };
 * ```
 */
