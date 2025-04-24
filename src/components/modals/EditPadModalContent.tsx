import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";
import {
  PadConfiguration,
  PlaybackType,
  getAudioFile,
  addAudioFile,
} from "@/lib/db";
import { DEFAULT_PAD_NAME } from "@/lib/constants"; // Assuming this exists for "Empty Pad"

// Interface for the internal state representing a sound in the list
interface SoundListItem {
  dndId: string; // Unique ID for drag-and-drop (can be fileId + timestamp or similar)
  fileId: number; // Actual audioFile ID from DB
  name: string; // Filename
}

// Interface for the props the component receives
interface EditPadModalContentProps {
  initialPadConfig: PadConfiguration;
  profileId: number; // Needed for saving new audio files
  pageIndex: number;
  padIndex: number;
}

// Interface for the methods exposed via the ref
export interface EditPadModalContentRef {
  getCurrentState: () => Omit<
    PadConfiguration,
    "id" | "createdAt" | "updatedAt"
  >;
}

const EditPadModalContent = forwardRef<
  EditPadModalContentRef,
  EditPadModalContentProps
>(({ initialPadConfig, profileId, pageIndex, padIndex }, ref) => {
  const [padName, setPadName] = useState<string>(
    initialPadConfig.name || DEFAULT_PAD_NAME,
  );
  const [playbackType, setPlaybackType] = useState<PlaybackType>(
    initialPadConfig.playbackType || "round-robin", // Default if somehow missing
  );
  const [sounds, setSounds] = useState<SoundListItem[]>([]);
  const [isLoadingNames, setIsLoadingNames] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch sound names on initial load
  useEffect(() => {
    const fetchNames = async () => {
      if (
        !initialPadConfig.audioFileIds ||
        initialPadConfig.audioFileIds.length === 0
      ) {
        setSounds([]);
        return;
      }
      setIsLoadingNames(true);
      try {
        const fetchedSounds: SoundListItem[] = [];
        for (const fileId of initialPadConfig.audioFileIds) {
          const audioFile = await getAudioFile(fileId);
          fetchedSounds.push({
            dndId: `${fileId}-${Date.now()}`, // Create a unique ID for DND
            fileId: fileId,
            name: audioFile?.name || `File ID ${fileId}`, // Fallback name
          });
        }
        setSounds(fetchedSounds);
      } catch (error) {
        console.error("Error fetching sound names:", error);
        // Handle error display if needed
      } finally {
        setIsLoadingNames(false);
      }
    };
    fetchNames();
  }, [initialPadConfig.audioFileIds]);

  // Drag-and-drop handler
  const onDragEnd: OnDragEndResponder = useCallback(
    (result) => {
      if (!result.destination) {
        return; // Dropped outside the list
      }
      const items = Array.from(sounds);
      const [reorderedItem] = items.splice(result.source.index, 1);
      items.splice(result.destination.index, 0, reorderedItem);
      setSounds(items);
    },
    [sounds],
  );

  // Remove sound handler
  const handleRemoveSound = (dndIdToRemove: string) => {
    setSounds((prevSounds) =>
      prevSounds.filter((sound) => sound.dndId !== dndIdToRemove),
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
      setIsLoadingNames(true); // Indicate loading while adding files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("audio/")) {
          console.warn(`Skipping non-audio file: ${file.name}`);
          continue; // Skip non-audio files
        }

        if (i === 0) {
          firstFileName = file.name.split(".").slice(0, -1).join("."); // Get name without extension
        }

        // Add file to DB
        const newFileId = await addAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
          // createdAt is added by addAudioFile
        });

        newSounds.push({
          dndId: `${newFileId}-${Date.now()}`,
          fileId: newFileId,
          name: file.name,
        });
      }

      // Update pad name if it was the default and we added at least one sound
      if (
        padName === DEFAULT_PAD_NAME &&
        firstFileName &&
        newSounds.length > 0
      ) {
        setPadName(firstFileName);
      }

      setSounds((prevSounds) => [...prevSounds, ...newSounds]);
    } catch (error) {
      console.error("Error adding audio files:", error);
      // Show error to user?
    } finally {
      setIsLoadingNames(false);
      // Reset file input value to allow selecting the same file again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  // Expose method to get current state via ref
  useImperativeHandle(ref, () => ({
    getCurrentState: () => ({
      profileId: profileId,
      pageIndex: pageIndex,
      padIndex: padIndex,
      name: padName,
      playbackType: playbackType,
      audioFileIds: sounds.map((s) => s.fileId), // Extract file IDs in current order
      keyBinding: initialPadConfig.keyBinding, // Preserve original keybinding
    }),
  }));

  return (
    <div className="flex flex-col space-y-4 text-sm">
      {/* Pad Name Input */}
      <div>
        <label
          htmlFor="padName"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Pad Name
        </label>
        <input
          type="text"
          id="padName"
          value={padName}
          onChange={(e) => setPadName(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:text-white"
          data-testid="edit-pad-name-input"
        />
      </div>

      {/* Playback Type Selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Playback Mode
        </label>
        <div
          className="flex space-x-4"
          data-testid="edit-pad-playback-mode-group"
        >
          {(["sequential", "random", "round-robin"] as PlaybackType[]).map(
            (mode) => (
              <label key={mode} className="inline-flex items-center">
                <input
                  type="radio"
                  name="playbackType"
                  data-testid={`edit-pad-playback-mode-${mode}`}
                  value={mode}
                  checked={playbackType === mode}
                  onChange={() => setPlaybackType(mode)}
                  className="form-radio h-4 w-4 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                />
                <span className="ml-2 text-gray-700 dark:text-gray-300 capitalize">
                  {mode.replace("-", " ")}
                </span>
              </label>
            ),
          )}
        </div>
      </div>

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
        >
          Add Sound(s)...
        </button>
      </div>
    </div>
  );
});

EditPadModalContent.displayName = "EditPadModalContent"; // Add display name

export default EditPadModalContent;
