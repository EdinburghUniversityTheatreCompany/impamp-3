'use client';

import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'; // Added forwardRef, useImperativeHandle
import { PadConfiguration, getAudioFile, AudioFile, addAudioFile } from '@/lib/db'; // Added addAudioFile
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd'; // Import dnd components
import { useUIStore } from '@/store/uiStore'; // Import modal store hook
import ConfirmModalContent from './ConfirmModalContent'; // Import confirm modal content

// Using AudioFile directly instead of SoundItem alias
// interface SoundItem extends AudioFile {
//   // Inherits id, name, type, blob, createdAt from AudioFile
// }

interface EditPadModalContentProps {
  initialConfig: PadConfiguration;
  // Callback to pass the updated configuration up when saving
  onSave: (updatedConfig: Omit<PadConfiguration, 'id' | 'createdAt' | 'updatedAt'>) => void;
}

// Define the type for the handle we'll expose via useImperativeHandle
export interface EditPadModalContentHandle {
  triggerSave: () => void;
}

// Wrap component with forwardRef
const EditPadModalContent = forwardRef<EditPadModalContentHandle, EditPadModalContentProps>(({
  initialConfig,
  onSave,
}, ref) => { // Add ref parameter
  const [padName, setPadName] = useState(initialConfig.name || '');
  const [soundItems, setSoundItems] = useState<AudioFile[]>([]); // Use AudioFile[]
  const [playMode, setPlayMode] = useState<'sequential' | 'random' | 'round-robin'>(initialConfig.playMode || 'sequential');
  const [isLoadingSounds, setIsLoadingSounds] = useState(true);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // Ref for the hidden file input
  const { openModal, closeModal } = useUIStore(); // Get modal actions

  // Fetch sound details when the component mounts or initialConfig changes
  useEffect(() => {
    const fetchSoundDetails = async () => {
      setIsLoadingSounds(true);
      if (!initialConfig.audioFileIds || initialConfig.audioFileIds.length === 0) {
        setSoundItems([]);
        setIsLoadingSounds(false);
        return;
      }

      try {
        const fetchedSounds: AudioFile[] = []; // Use AudioFile[]
        // Fetch details for each ID, maintaining the order
        for (const id of initialConfig.audioFileIds) {
          const soundData = await getAudioFile(id);
          if (soundData) {
            // We only need id and name for the list display
            fetchedSounds.push({
              id: soundData.id,
              name: soundData.name,
              type: soundData.type, // Keep type for potential future use
              blob: new Blob(), // Placeholder blob, not needed for display
              createdAt: soundData.createdAt,
            });
          } else {
            console.warn(`Could not find audio file with ID: ${id}`);
            // Add a placeholder if a sound is missing? Or just skip? Skipping for now.
          }
        }
        setSoundItems(fetchedSounds);
      } catch (error) {
        console.error("Error fetching sound details:", error);
        setSoundItems([]); // Clear on error
      } finally {
        setIsLoadingSounds(false);
      }
    };

    fetchSoundDetails();
  }, [initialConfig.audioFileIds]);

  // Focus the name input field when the modal content mounts
  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPadName(e.target.value);
  };

  const handlePlayModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPlayMode(e.target.value as 'sequential' | 'random' | 'round-robin');
  };

  // Trigger hidden file input click
  const handleUploadButtonClick = () => {
    fileInputRef.current?.click();
  };

  // Handle file selection from the hidden input
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const files = event.target.files;
    if (!files || files.length === 0) return;

    // Reset file input to allow uploading the same file(s) again if needed
    event.target.value = '';

    // TODO: Add loading indicator?
    // let filesProcessed = 0; // Removed unused variable
    let errorsEncountered = 0;
    const newSoundsToAdd: AudioFile[] = [];

    for (const file of Array.from(files)) { // Iterate through all selected files
      console.log("Processing file:", file.name, file.type);

      if (!file.type.startsWith('audio/')) {
        alert(`Skipping invalid file type: ${file.name} (${file.type}). Please select audio files.`);
        errorsEncountered++;
        continue; // Skip this file
      }

      try {
        // 1. Add audio blob to DB
        const newAudioFileId = await addAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
        });
        console.log(`Uploaded file "${file.name}" added to DB with ID: ${newAudioFileId}`);

        // 2. Fetch details (we need name, etc.)
        const soundData = await getAudioFile(newAudioFileId);
        if (soundData) {
          // Check for duplicates *against current state + already processed new files*
          if (!soundItems.some(item => item.id === soundData.id) && !newSoundsToAdd.some(item => item.id === soundData.id)) {
            const newSoundItem: AudioFile = {
              id: soundData.id,
              name: soundData.name,
              type: soundData.type,
              blob: new Blob(), // Placeholder
              createdAt: soundData.createdAt,
            };
            newSoundsToAdd.push(newSoundItem);
            console.log(`Prepared sound "${soundData.name}" (ID: ${soundData.id}) for adding to the list.`);
          } else {
            console.log(`Sound ID ${soundData.id} ("${soundData.name}") already in the list or queue.`);
            // Optionally provide user feedback here, maybe aggregate later
          }
        } else {
          console.error(`Failed to fetch details for newly added sound ID ${newAudioFileId}`);
          errorsEncountered++;
        }
      } catch (error) {
        console.error(`Error uploading or adding file "${file.name}":`, error);
        errorsEncountered++;
      } finally {
        // filesProcessed++; // Removed unused variable increment
      }
    }

    // Add all successfully processed new sounds to the state at once
    if (newSoundsToAdd.length > 0) {
      setSoundItems(prevItems => [...prevItems, ...newSoundsToAdd]);
    }

    // TODO: Remove loading indicator?

    // Report errors if any occurred
    if (errorsEncountered > 0) {
      alert(`Finished processing files. ${errorsEncountered} error(s) occurred. Please check the console for details.`);
    }
  };


  const handleRemoveSound = (idToRemove: number | undefined, soundName: string) => {
    if (idToRemove === undefined) return;

    openModal({
      title: 'Confirm Removal',
      content: <ConfirmModalContent message={`Are you sure you want to remove the sound "${soundName}"?`} />,
      confirmText: 'Remove',
      cancelText: 'Cancel',
      onConfirm: () => {
        setSoundItems(prevItems => prevItems.filter(item => item.id !== idToRemove));
        closeModal();
        console.log(`Removed sound "${soundName}" (ID: ${idToRemove})`);
      },
      onCancel: () => {
        console.log(`Removal cancelled for sound "${soundName}" (ID: ${idToRemove})`);
      }
    });
  };

  // Drag and Drop handler
  const onDragEnd = (result: DropResult) => {
    const { source, destination } = result;

    // Dropped outside the list
    if (!destination) {
      return;
    }

    // Reorder logic
    const items = Array.from(soundItems);
    const [reorderedItem] = items.splice(source.index, 1);
    items.splice(destination.index, 0, reorderedItem);

    setSoundItems(items);
    console.log('Reordered sounds:', items.map(i => i.name));
  };

  // Prepare the data and call the onSave callback
  const triggerSave = () => {
    console.log('triggerSave called inside EditPadModalContent');
    const updatedAudioFileIds = soundItems.map(item => item.id).filter((id): id is number => id !== undefined);
    const finalName = padName.trim() || `Pad ${initialConfig.padIndex + 1}`; // Default name if empty

    // Call the onSave prop passed from PadGrid
    onSave({
      profileId: initialConfig.profileId,
      pageIndex: initialConfig.pageIndex,
      padIndex: initialConfig.padIndex,
      keyBinding: initialConfig.keyBinding, // Preserve existing keybinding
      name: finalName,
      audioFileIds: updatedAudioFileIds,
      playMode: playMode,
    });
  };

  // Expose the triggerSave function using useImperativeHandle
  useImperativeHandle(ref, () => ({
    triggerSave,
  }));

  return (
    <div className="space-y-4" data-testid="edit-pad-modal-content">
      {/* Pad Name Input */}
      <div>
        <label htmlFor="pad-name-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Pad Name
        </label>
        <input
          ref={nameInputRef}
          type="text"
          id="pad-name-input"
          data-testid="pad-name-input"
          value={padName}
          onChange={handleNameChange}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:focus:ring-blue-600 dark:focus:border-blue-600"
        />
      </div>

      {/* Sound List Section */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Sounds ({soundItems.length})
        </label>
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="soundList">
            {(provided) => (
              <div
                {...provided.droppableProps}
                ref={provided.innerRef}
                className="border border-gray-300 dark:border-gray-600 rounded-md p-2 space-y-2 min-h-[100px] max-h-[250px] overflow-y-auto"
                data-testid="sound-list-droppable"
              >
                {isLoadingSounds ? (
                  <p className="text-gray-500 dark:text-gray-400 text-sm">Loading sounds...</p>
                ) : soundItems.length === 0 ? (
                  <p className="text-gray-500 dark:text-gray-400 text-sm">No sounds assigned. Upload sounds below.</p>
                ) : (
                  soundItems.map((sound, index) => (
                    <Draggable key={sound.id?.toString() ?? `sound-${index}`} draggableId={sound.id?.toString() ?? `sound-${index}`} index={index}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps} // Use the whole div as handle for simplicity
                          className={`flex items-center justify-between p-2 rounded ${snapshot.isDragging ? 'bg-blue-100 dark:bg-blue-900 shadow-lg' : 'bg-gray-100 dark:bg-gray-700'}`}
                          style={{
                            ...provided.draggableProps.style, // Apply styles from dnd
                          }}
                          data-testid={`sound-item-${sound.id}`}
                        >
                          {/* Drag Handle Icon */}
                          <span className="cursor-move mr-2 text-gray-400 dark:text-gray-500" aria-label="Drag to reorder">☰</span>
                          {/* Sound Name */}
                          <span className="text-sm text-gray-800 dark:text-gray-200 truncate flex-1 mr-2" title={sound.name}>
                            {index + 1}. {sound.name}
                          </span>
                          {/* Remove Button */}
                          <button
                            onClick={() => handleRemoveSound(sound.id, sound.name)}
                            className="text-red-600 hover:text-red-800 dark:text-red-500 dark:hover:text-red-400 text-lg font-bold flex-shrink-0"
                            aria-label={`Remove ${sound.name}`}
                            title={`Remove ${sound.name}`}
                            data-testid={`remove-sound-${sound.id}`}
                          >
                            &times;
                          </button>
                        </div>
                      )}
                    </Draggable>
                  ))
                )}
                {provided.placeholder} {/* Placeholder for dragging */}
              </div>
            )}
          </Droppable>
        </DragDropContext>
        {/* Hidden File Input - Now allows multiple */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="audio/*"
          multiple // Allow multiple file selection
          style={{ display: 'none' }}
          data-testid="upload-sound-input"
        />
        {/* Visible Upload Button */}
        <button
          onClick={handleUploadButtonClick}
          className="mt-2 w-full px-3 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 dark:focus:ring-offset-gray-800"
          data-testid="upload-sound-button"
        >
          Upload Sound File...
        </button>
      </div>

      {/* Play Mode Selector */}
      <div>
        <label htmlFor="play-mode-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Play Mode
        </label>
        <select
          id="play-mode-select"
          data-testid="play-mode-select"
          value={playMode}
          onChange={handlePlayModeChange}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:focus:ring-blue-600 dark:focus:border-blue-600"
          disabled={soundItems.length <= 1} // Disable if only 0 or 1 sound
        >
          <option value="sequential">Sequential</option>
          <option value="random">Random</option>
          <option value="round-robin">Round Robin</option>
        </select>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {playMode === 'sequential' && 'Plays sounds in order, looping back to the start.'}
          {playMode === 'random' && 'Plays a random sound from the list each time.'}
          {playMode === 'round-robin' && 'Plays a random sound, ensuring all sounds play once before repeating any.'}
        </p>
      </div>

      {/* Hidden save trigger - The parent Modal component's confirm button will call triggerSave */}
      {/* <button onClick={triggerSave}>Save (Hidden)</button> */}
    </div>
  );
}); // Close the forwardRef HOC

EditPadModalContent.displayName = 'EditPadModalContent'; // Add display name

// We need a way for the parent Modal component to trigger the save.
// One way is to pass a ref, another is to lift the state up further,
// The parent component (PadGrid via Modal) will now call triggerSave via the ref.

export default EditPadModalContent;
