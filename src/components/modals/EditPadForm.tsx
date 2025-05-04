/**
 * Edit Pad Form Component
 *
 * Form for editing pad name, playback type and sound list
 *
 * @module components/modals/EditPadForm
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";
import { FormField, RadioGroup } from "@/components/forms";
import { TextInput } from "@/components/forms";
import type { PadFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import { getAudioFile, addAudioFile, PlaybackType } from "@/lib/db";
import { DEFAULT_PAD_NAME } from "@/lib/constants";

// Extension of the render props to include profile ID which is needed for sound uploads
interface EditPadFormProps extends FormModalRenderProps<PadFormValues> {
  profileId: number;
}

// Internal state for managing sound display
interface SoundListItem {
  dndId: string; // Unique ID for drag-and-drop
  fileId: number; // Actual audioFile ID
  name: string; // Display name
}

/**
 * Form component for editing a pad's properties
 */
const EditPadForm: React.FC<EditPadFormProps> = ({
  values,
  updateValue,
  errors,
  isSubmitting,
  profileId: _profileId, // eslint-disable-line @typescript-eslint/no-unused-vars
}) => {
  const [sounds, setSounds] = useState<SoundListItem[]>([]);
  const [isLoadingNames, setIsLoadingNames] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep track of whether we're doing the initial load
  const initialLoadRef = useRef(true);

  // Generate consistent IDs for the same audio files across renders
  const getDndId = useCallback((fileId: number, index: number) => {
    return `sound-${fileId}-${index}`;
  }, []);

  // Load sound names when audioFileIds change
  useEffect(() => {
    const fetchSoundNames = async () => {
      if (!values.audioFileIds || values.audioFileIds.length === 0) {
        setSounds([]);
        return;
      }

      setIsLoadingNames(true);
      try {
        const fetchedSounds: SoundListItem[] = [];
        for (let i = 0; i < values.audioFileIds.length; i++) {
          const fileId = values.audioFileIds[i];
          const audioFile = await getAudioFile(fileId);
          fetchedSounds.push({
            dndId: getDndId(fileId, i), // Create a consistent ID
            fileId: fileId,
            name: audioFile?.name || `File ID ${fileId}`, // Fallback name
          });
        }
        setSounds(fetchedSounds);

        // Log for debugging
        if (initialLoadRef.current) {
          console.log("Initial sound load completed:", fetchedSounds);
          initialLoadRef.current = false;
        }
      } catch (error) {
        console.error("Error fetching sound names:", error);
      } finally {
        setIsLoadingNames(false);
      }
    };

    fetchSoundNames();
  }, [values.audioFileIds, getDndId]);

  // Drag-and-drop handler
  const onDragEnd: OnDragEndResponder = (result) => {
    if (!result.destination) {
      return; // Dropped outside the list
    }

    const items = Array.from(sounds);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);
    setSounds(items);

    // Update the audio file IDs in the form state based on the new order
    updateValue(
      "audioFileIds",
      items.map((item) => item.fileId),
    );
  };

  // Remove sound handler
  const handleRemoveSound = (dndIdToRemove: string) => {
    const updatedSounds = sounds.filter(
      (sound) => sound.dndId !== dndIdToRemove,
    );
    setSounds(updatedSounds);

    // Update the audio file IDs in the form state
    updateValue(
      "audioFileIds",
      updatedSounds.map((item) => item.fileId),
    );
  };

  // File input change handler
  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    console.log(`Adding ${files.length} new sounds...`);
    const newSounds: SoundListItem[] = [];
    let firstFileName: string | null = null;

    try {
      setIsLoadingNames(true);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("audio/")) {
          console.warn(`Skipping non-audio file: ${file.name}`);
          continue;
        }

        if (i === 0) {
          firstFileName = file.name.split(".").slice(0, -1).join(".");
        }

        // Add file to DB
        const newFileId = await addAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
          // Note: The pad itself is associated with the profile, so we don't need to
          // explicitly associate the audio file with the profile here
        });

        newSounds.push({
          dndId: `${newFileId}-${Date.now()}`,
          fileId: newFileId,
          name: file.name,
        });
      }

      // Update pad name if it was the default and we added at least one sound
      if (
        values.name === DEFAULT_PAD_NAME &&
        firstFileName &&
        newSounds.length > 0
      ) {
        updateValue("name", firstFileName);
      }

      // Combine existing sounds with new ones and update the form state
      const updatedSounds = [...sounds, ...newSounds];
      setSounds(updatedSounds);
      updateValue(
        "audioFileIds",
        updatedSounds.map((item) => item.fileId),
      );
    } catch (error) {
      console.error("Error adding audio files:", error);
    } finally {
      setIsLoadingNames(false);
      // Reset file input value to allow selecting the same file again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  // Playback type options
  const playbackTypeOptions = [
    { value: "sequential", label: "Sequential" },
    { value: "random", label: "Random" },
    { value: "round-robin", label: "Round Robin" },
  ];

  return (
    <div className="flex flex-col space-y-4 text-sm relative">
      {isSubmitting && (
        <div className="absolute inset-0 bg-white/50 dark:bg-gray-800/50 flex items-center justify-center z-10">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      )}

      {/* Pad Name Input */}
      <FormField id="padName" label="Pad Name" error={errors.name}>
        <TextInput
          id="padName"
          value={values.name}
          onChange={(value) => updateValue("name", value)}
          autoFocus
          selectOnFocus
          error={errors.name}
          data-testid="edit-pad-name-input"
        />
      </FormField>

      {/* Playback Type Selector */}
      <FormField
        id="playbackType"
        label="Playback Mode"
        error={errors.playbackType}
      >
        <RadioGroup
          id="playbackType"
          name="playbackType"
          options={playbackTypeOptions}
          value={values.playbackType}
          onChange={(value) =>
            updateValue("playbackType", value as PlaybackType)
          }
          error={errors.playbackType}
          horizontal
          data-testid="edit-pad-playback-mode-group"
        />
      </FormField>

      {/* Sounds List & DND */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Sounds (Drag to Reorder)
        </label>
        {isLoadingNames ? (
          <p className="text-gray-500 dark:text-gray-400">Loading sounds...</p>
        ) : sounds.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 italic">
            No sounds assigned. Add sounds below.
          </p>
        ) : (
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId="soundsList">
              {(provided) => (
                <ul
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className="border border-gray-300 dark:border-gray-600 rounded-md max-h-48 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700"
                  data-testid="edit-pad-sounds-list"
                >
                  {sounds.map((sound, index) => (
                    <Draggable
                      key={sound.dndId}
                      draggableId={sound.dndId}
                      index={index}
                    >
                      {(provided) => (
                        <li
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          className="p-2 flex items-center justify-between bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                          data-testid={`edit-pad-sound-item-${sound.fileId}`}
                        >
                          <span className="text-gray-800 dark:text-gray-200 truncate">
                            {sound.name}
                          </span>
                          <button
                            onClick={() => handleRemoveSound(sound.dndId)}
                            className="ml-2 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-xs font-bold"
                            aria-label={`Remove ${sound.name}`}
                            title={`Remove ${sound.name}`}
                            data-testid={`edit-pad-remove-sound-${sound.fileId}`}
                            type="button"
                          >
                            ✕
                          </button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>

      {/* Add Sounds Button */}
      <div>
        <input
          type="file"
          multiple
          accept="audio/*"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden" // Hide the actual input
          id="addSoundsInput"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()} // Trigger hidden input
          className="w-full inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-600 dark:focus:ring-offset-gray-800"
          data-testid="edit-pad-add-sounds-button"
          disabled={isSubmitting}
        >
          Add Sound(s)...
        </button>
      </div>
    </div>
  );
};

export default EditPadForm;
