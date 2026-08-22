/**
 * Edit Pad Form Component
 *
 * Form for editing pad name, playback type and sound list
 *
 * @module components/modals/EditPadForm
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";
import { Checkbox, FormField, RadioGroup } from "@/components/forms";
import {
  FOLLOW_PROFILE,
  padActivePadBehaviorOptions,
} from "@/components/forms/activePadBehaviorOptions";
import { TextInput } from "@/components/forms";
import GainControl from "@/components/GainControl";
import type { PadFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import {
  getAudioFile,
  addOrReuseAudioFile,
  type ActivePadBehavior,
  PlaybackType,
} from "@/lib/db";
import { DEFAULT_PAD_NAME } from "@/lib/constants";

const WaveformTrimmer = lazy(() => import("@/components/WaveformTrimmer"));

// Extension of the render props to include profile ID which is needed for sound uploads
interface EditPadFormProps extends FormModalRenderProps<PadFormValues> {
  /**
   * Reports audio files this form has just written to IndexedDB. They exist
   * before the pad is saved, so the caller has to know which ones to discard
   * if the edit is abandoned.
   */
  onSoundsAdded?: (fileIds: number[]) => void;
}

// Internal state for managing sound display
interface SoundListItem {
  /**
   * Identifies this *row*, not the sound in it: `${fileId}-${occurrence}`.
   *
   * Everything that has to name one row and not its twin is built from this —
   * the drag id, all four test ids, and the accessible names of the row's
   * buttons. `fileId` alone cannot do that job any more; see `placeSounds`.
   */
  rowId: string;
  dndId: string; // Unique ID for drag-and-drop
  fileId: number; // Actual audioFile ID
  name: string; // Display name
  /**
   * Distinguishes the second and later copies of one sound by name, e.g.
   * " (copy 2)". Empty for the first, so an ordinary pad reads as it always
   * did. Appended to the labels a screen reader announces, which would
   * otherwise be three pairs of identical buttons doing different things.
   */
  copyLabel: string;
}

/** A sound before it has been given its place in the list. */
type UnplacedSound = Omit<SoundListItem, "rowId" | "dndId" | "copyLabel">;

/**
 * Hands each sound a row identity that is unique even when one pad names the
 * same sound twice.
 *
 * Audio rows are reused by content hash, so adding the same bytes twice
 * returns one id both times and `${fileId}` stopped being unique within a
 * pad. Two identical ids give @hello-pangea/dnd two draggables claiming one
 * id, React two children with one key, `handleRemoveSound` — which matches on
 * the drag id — every copy instead of the one clicked, two `<li>`s answering
 * one `data-testid`, and two Remove buttons a screen reader cannot tell
 * apart. A pad that plays a sound twice in a sequence is a thing users ask
 * for, so the answer is to number the copies rather than to refuse the
 * second.
 *
 * Numbering the drag id alone is not enough, and was the shape of the bug
 * this replaced: the neighbouring test ids were left on `fileId` and went on
 * colliding. Everything that names a row derives from `rowId` here, so there
 * is one place to get it right.
 *
 * @param sounds - The list in display order
 * @returns The same list, each entry carrying a distinct `rowId` and `dndId`
 */
function placeSounds(sounds: UnplacedSound[]): SoundListItem[] {
  const seen = new Map<number, number>();
  return sounds.map((sound) => {
    const occurrence = seen.get(sound.fileId) ?? 0;
    seen.set(sound.fileId, occurrence + 1);
    const rowId = `${sound.fileId}-${occurrence}`;
    return {
      ...sound,
      rowId,
      dndId: `sound-${rowId}`,
      copyLabel: occurrence === 0 ? "" : ` (copy ${occurrence + 1})`,
    };
  });
}

/**
 * Form component for editing a pad's properties
 */
const EditPadForm: React.FC<EditPadFormProps> = ({
  values,
  updateValue,
  errors,
  isSubmitting,
  onSoundsAdded,
}) => {
  const [sounds, setSounds] = useState<SoundListItem[]>([]);
  const [isLoadingNames, setIsLoadingNames] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [trimmingSound, setTrimmingSound] = useState<SoundListItem | null>(
    null,
  );

  // Keep track of whether we're doing the initial load
  const initialLoadRef = useRef(true);

  // Cache of already resolved sound names, keyed by audio file ID
  const soundNamesRef = useRef(new Map<number, string>());

  // Load sound names when audioFileIds change
  useEffect(() => {
    let cancelled = false;

    const fetchSoundNames = async () => {
      if (!values.audioFileIds || values.audioFileIds.length === 0) {
        setSounds([]);
        return;
      }

      setIsLoadingNames(true);
      try {
        const nameCache = soundNamesRef.current;
        const fetchedSounds: UnplacedSound[] = [];
        for (const fileId of values.audioFileIds) {
          if (!nameCache.has(fileId)) {
            const audioFile = await getAudioFile(fileId);
            if (cancelled) return;
            nameCache.set(fileId, audioFile?.name || `File ID ${fileId}`); // Fallback name
          }
          fetchedSounds.push({
            fileId: fileId,
            name: nameCache.get(fileId)!,
          });
        }
        if (cancelled) return;
        setSounds(placeSounds(fetchedSounds));

        // Log for debugging
        if (initialLoadRef.current) {
          console.log("Initial sound load completed:", fetchedSounds);
          initialLoadRef.current = false;
        }
      } catch (error) {
        console.error("Error fetching sound names:", error);
      } finally {
        if (!cancelled) {
          setIsLoadingNames(false);
        }
      }
    };

    fetchSoundNames();
    return () => {
      cancelled = true;
    };
  }, [values.audioFileIds]);

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
    const newSounds: UnplacedSound[] = [];
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

        // Reuse by content hash rather than adding unconditionally: the same
        // sound added to a second pad, or added here twice, must name one
        // row. Note: The pad itself is associated with the profile, so we
        // don't need to explicitly associate the audio file with the profile
        // here.
        const { id: newFileId, reused } = await addOrReuseAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
        });

        // A reused row keeps the name it was first written under — that is
        // the documented contract of `addOrReuseAudioFile` — so the name on
        // the file the user just picked is not this sound's name. Writing it
        // into the cache anyway made the editor display a name that exists
        // nowhere, and, because the cache is keyed by file id, made it
        // display that name on *every* row naming the same sound: adding
        // `soundA` and then `soundB` with identical bytes showed two rows
        // both reading "soundB", while the stored row was "soundA".
        let storedName = soundNamesRef.current.get(newFileId);
        if (storedName === undefined) {
          storedName = reused
            ? ((await getAudioFile(newFileId))?.name ?? file.name)
            : file.name;
          soundNamesRef.current.set(newFileId, storedName);
        }
        newSounds.push({
          fileId: newFileId,
          name: storedName,
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

      onSoundsAdded?.(newSounds.map((sound) => sound.fileId));

      // Combine existing sounds with new ones and update the form state
      const updatedSounds = placeSounds([...sounds, ...newSounds]);
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

      {/* Active / Disabled Toggle */}
      <Checkbox
        id="padActive"
        label="Pad active"
        description="Untick to disable this pad. It keeps its sounds and name but will not play when clicked or triggered by its key."
        checked={!values.isDisabled}
        onChange={(checked) => updateValue("isDisabled", !checked)}
        data-testid="edit-pad-active-checkbox"
      />

      {/* Playback Type Selector */}
      <FormField
        id="playbackType"
        label="Playback Mode"
        error={errors.playbackType}
        labelsGroup
      >
        <RadioGroup
          id="playbackType"
          name="playbackType"
          options={playbackTypeOptions}
          value={values.playbackType}
          onChange={(value) =>
            updateValue("playbackType", value as PlaybackType)
          }
          horizontal
          data-testid="edit-pad-playback-mode-group"
          optionTestIdPrefix="edit-pad-playback-mode"
        />
      </FormField>

      {/* Behaviour when this pad is triggered while it is already playing */}
      <FormField
        id="activePadBehavior"
        label="When already playing"
        error={errors.activePadBehavior as string}
        labelsGroup
      >
        <RadioGroup
          id="activePadBehavior"
          name="activePadBehavior"
          options={padActivePadBehaviorOptions}
          // `undefined` has no radio of its own, so it shows as the
          // "follow the profile" option — and goes back out as `undefined`
          // below, never as the profile's current answer.
          value={values.activePadBehavior ?? FOLLOW_PROFILE}
          onChange={(value) =>
            updateValue(
              "activePadBehavior",
              value === FOLLOW_PROFILE
                ? undefined
                : (value as ActivePadBehavior),
            )
          }
          data-testid="edit-pad-active-behavior-group"
          optionTestIdPrefix="edit-pad-active-behavior"
        />
      </FormField>

      {/* Sounds List & DND */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-0.5">
          Sounds (Drag to Reorder)
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          Use <span className="font-medium">Trim</span> to set start/end points
          for each sound.
        </p>
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
                          data-testid={`edit-pad-sound-item-${sound.rowId}`}
                        >
                          <span className="text-gray-800 dark:text-gray-200 truncate flex-1">
                            {sound.name}
                          </span>
                          <div className="flex items-center gap-2 ml-2 shrink-0">
                            {/*
                              The row's *identity* is `rowId`; its *value* is
                              still keyed by `fileId`, and deliberately so —
                              `audioGainSettings` (like `audioTrimSettings`
                              below) is a Record keyed by audio file ID, so
                              two copies of one sound share one gain. Only
                              what names the element moves to `rowId`.
                            */}
                            <GainControl
                              compact
                              label={`Gain for ${sound.name}${sound.copyLabel}`}
                              valueDb={
                                values.audioGainSettings?.[sound.fileId] ?? 0
                              }
                              testId={`edit-pad-gain-sound-${sound.rowId}`}
                              onChange={(db) =>
                                updateValue("audioGainSettings", {
                                  ...(values.audioGainSettings ?? {}),
                                  [sound.fileId]: db,
                                })
                              }
                            />
                            <button
                              onClick={() => setTrimmingSound(sound)}
                              className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800"
                              aria-label={`Trim ${sound.name}${sound.copyLabel}`}
                              title={`Trim ${sound.name}${sound.copyLabel}`}
                              data-testid={`edit-pad-trim-sound-${sound.rowId}`}
                              type="button"
                            >
                              Trim
                            </button>
                            <button
                              onClick={() => handleRemoveSound(sound.dndId)}
                              className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-xs font-bold"
                              aria-label={`Remove ${sound.name}${sound.copyLabel}`}
                              title={`Remove ${sound.name}${sound.copyLabel}`}
                              data-testid={`edit-pad-remove-sound-${sound.rowId}`}
                              type="button"
                            >
                              ✕
                            </button>
                          </div>
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

      <div>
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Pad gain
        </span>
        <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
          Applied on top of every sound&apos;s own gain.
        </p>
        <GainControl
          label="Pad gain"
          valueDb={values.padGainDb ?? 0}
          testId="edit-pad-gain-pad"
          onChange={(db) => updateValue("padGainDb", db)}
        />
      </div>

      {/* Waveform Trimmer Overlay */}
      {trimmingSound && (
        <Suspense fallback={null}>
          <WaveformTrimmer
            audioFileId={trimmingSound.fileId}
            audioFileName={trimmingSound.name}
            trimStart={
              values.audioTrimSettings?.[trimmingSound.fileId]?.trimStart ?? 0
            }
            trimEnd={
              values.audioTrimSettings?.[trimmingSound.fileId]?.trimEnd ?? 0
            }
            soundGainDb={values.audioGainSettings?.[trimmingSound.fileId] ?? 0}
            padGainDb={values.padGainDb ?? 0}
            onTrimChange={(trimStart, trimEnd) => {
              const current = values.audioTrimSettings ?? {};
              updateValue("audioTrimSettings", {
                ...current,
                [trimmingSound.fileId]: { trimStart, trimEnd },
              });
            }}
            onClose={() => setTrimmingSound(null)}
          />
        </Suspense>
      )}

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
