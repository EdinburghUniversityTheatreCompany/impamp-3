import React, { useMemo } from 'react';
import { useDropzone, Accept } from 'react-dropzone';

// Import the default key mapping function
const getDefaultKeyForPadIndex = (padIndex: number, cols: number = 8): string | undefined => {
  // Define keyboard rows with their keys
  const keyboardRows = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']
  ];
  
  // Calculate row and column for the pad index
  const row = Math.floor(padIndex / cols);
  const col = padIndex % cols;
  
  // Check if we have a key defined for this position
  if (row < keyboardRows.length && col < keyboardRows[row].length) {
    return keyboardRows[row][col];
  }
  
  return undefined; // No default key for this position
};

interface PadProps {
  id: string; // Unique identifier for the pad element itself
  padIndex: number; // Index of the pad within its page/grid
  profileId: number | null; // ID of the current profile
  pageIndex: number; // Index of the current page
  keyBinding?: string;
  name?: string;
  isConfigured: boolean;
  isPlaying: boolean;
  playProgress?: number; // New prop to show play progress (0 to 1)
  isEditMode: boolean; // Whether we're in edit mode (shift key is pressed)
  onClick: () => void;
  onShiftClick: () => void; // Callback for shift+click (for renaming)
  onDropAudio: (acceptedFiles: File[], padIndex: number) => Promise<void>; // Callback for drop
  onRemoveSound?: () => void; // New callback for removing sound from pad
}

const Pad: React.FC<PadProps> = ({
  id,
  padIndex,
  keyBinding,
  name = 'Empty Pad',
  isConfigured,
  isPlaying,
  playProgress = 0,
  isEditMode,
  onClick,
  onShiftClick,
  onDropAudio,
  onRemoveSound,
  // profileId and pageIndex are passed but not used directly in this component
}) => {
  // Get the default key binding for this pad position if no custom binding is set
  const displayKeyBinding = useMemo(() => {
    return keyBinding || getDefaultKeyForPadIndex(padIndex);
  }, [keyBinding, padIndex]);
  const handleDrop = React.useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onDropAudio(acceptedFiles, padIndex);
      }
    },
    [onDropAudio, padIndex]
  );

  const { getRootProps, getInputProps, isDragActive, isDragAccept, isDragReject } = useDropzone({
    onDrop: handleDrop,
    accept: { 'audio/*': [] } as Accept, // Accept all audio types
    noClick: true, // Prevent opening file dialog on click (we handle click for playback)
    noKeyboard: true, // Prevent opening file dialog with keyboard
    multiple: false, // Accept only one file at a time
  });

  // Log props for debugging
  React.useEffect(() => {
    if (isPlaying) {
      console.log(`[Pad ${padIndex}] Playing: ${isPlaying}, Progress: ${playProgress}`);
    }
  }, [isPlaying, playProgress, padIndex]);

  // --- Styling ---
  const baseStyle =
    'relative aspect-square border rounded-md flex flex-col items-center justify-center p-2 text-center cursor-pointer transition-all duration-150 overflow-hidden'; // Added relative and overflow-hidden
  const configuredStyle = isConfigured
    ? 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600'
    : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700';
  
  const editModeStyle = isEditMode
    ? 'border-2 border-amber-500 hover:border-amber-600 dark:border-amber-400'
    : '';
    
  const playingStyle = isPlaying
    ? 'ring-2 ring-offset-2 dark:ring-offset-gray-900 ring-blue-500' // Ensure ring is visible
    : '';
  
  const textStyle = isConfigured
    ? 'text-gray-800 dark:text-gray-200'
    : 'text-gray-500 dark:text-gray-400';

  // Dropzone visual feedback styles
  const dropzoneActiveStyle = isDragActive 
    ? 'border-blue-500 border-dashed' 
    : isEditMode 
      ? '' // Edit mode already has a border style
      : 'border-gray-300 dark:border-gray-600';
  const dropzoneAcceptStyle = isDragAccept ? 'bg-green-100 dark:bg-green-900 border-green-500' : '';
  const dropzoneRejectStyle = isDragReject ? 'bg-red-100 dark:bg-red-900 border-red-500' : '';

  return (
    // Spread dropzone props onto the root div
    <div
      {...getRootProps()}
      id={id} // Use the passed unique ID
      className={`${baseStyle} ${configuredStyle} ${editModeStyle} ${playingStyle} ${textStyle} ${dropzoneActiveStyle} ${dropzoneAcceptStyle} ${dropzoneRejectStyle}`}
      // Make clickable area separate from dropzone root if needed, but here it's combined
      // The single onClick handler below manages both playback and prevents dropzone default click
      onClick={(e) => {
          // Prevent dropzone's default click behavior if necessary, though noClick should handle it
          e.stopPropagation();
          
          // console.log(`[Pad ${padIndex} Click] e.shiftKey=${e.shiftKey}, props.isEditMode=${isEditMode}`); // <-- REMOVED LOG
          // Rely solely on isEditMode prop from the store
          if (isEditMode) { 
            onShiftClick();
          } else {
            onClick();
          }
      }}
      role="button"
      tabIndex={0} // Make it focusable
      onKeyDown={(e) => {
        // Allow space/enter for playback activation, but not dropzone activation
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); // Prevent potential default actions
          onClick();
        }
      }}
      aria-label={`Sound pad ${padIndex + 1}${name !== 'Empty Pad' ? `: ${name}` : ''}${displayKeyBinding ? `, key ${displayKeyBinding}` : ''}`}
    >
      {/* Input element required by react-dropzone - add data-testid */}
      <input {...getInputProps()} data-testid={`pad-drop-input-${padIndex}`} />

      {/* Pad Name Display - with better wrapping and edit mode indicator */}
      <span className="text-sm font-medium break-all w-full text-center z-10">
        {name}
      </span>

      {/* Key Binding Display at the bottom - show default key binding if no custom binding */}
      {displayKeyBinding && (
        <span className="absolute bottom-1 left-1/2 transform -translate-x-1/2 text-xs font-mono bg-gray-300 dark:bg-gray-600 px-1 rounded z-10">
          {displayKeyBinding}
        </span>
      )}

      {/* Progress bar with more dramatic styling (only shown when playing) */}
      {isPlaying && (
        <div className="absolute bottom-0 left-0 right-0 h-4 bg-gray-200 dark:bg-gray-700 z-50">
          <div 
            className="h-full bg-green-500 transition-all duration-100" 
            style={{ width: `${playProgress * 100}%` }}
          />
        </div>
      )}

      {/* Dropzone overlay message */}
      {isDragActive && (
        <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center z-20">
          <span className="text-white text-lg font-semibold">
            {isDragAccept && 'Drop audio here'}
            {isDragReject && 'Invalid file type'}
            {!isDragAccept && !isDragReject && 'Drop audio file'}
          </span>
        </div>
      )}

      {/* Remove Sound Button - only shown in edit mode for configured pads */}
      {isEditMode && isConfigured && onRemoveSound && (
        <button
          className="absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity z-30"
          onClick={(e) => {
            e.stopPropagation(); // Prevent triggering pad click
            onRemoveSound();
          }}
          aria-label="Remove sound"
          title="Remove sound"
        >
          <span className="text-xs font-bold">×</span>
        </button>
      )}
    </div>
  );
};

export default Pad;
