import React from 'react';
import { useDropzone, Accept } from 'react-dropzone';

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
  onClick: () => void;
  onDropAudio: (acceptedFiles: File[], padIndex: number) => Promise<void>; // Callback for drop
}

const Pad: React.FC<PadProps> = ({
  id,
  padIndex,
  keyBinding,
  name = 'Empty Pad',
  isConfigured,
  isPlaying,
  playProgress = 0,
  onClick,
  onDropAudio,
  // profileId and pageIndex are passed but not used directly in this component
}) => {
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
  const playingStyle = isPlaying
    ? 'ring-2 ring-offset-2 dark:ring-offset-gray-900 ring-blue-500' // Ensure ring is visible
    : '';
  const textStyle = isConfigured
    ? 'text-gray-800 dark:text-gray-200'
    : 'text-gray-500 dark:text-gray-400';

  // Dropzone visual feedback styles
  const dropzoneActiveStyle = isDragActive ? 'border-blue-500 border-dashed' : 'border-gray-300 dark:border-gray-600';
  const dropzoneAcceptStyle = isDragAccept ? 'bg-green-100 dark:bg-green-900 border-green-500' : '';
  const dropzoneRejectStyle = isDragReject ? 'bg-red-100 dark:bg-red-900 border-red-500' : '';

  return (
    // Spread dropzone props onto the root div
    <div
      {...getRootProps()}
      id={id} // Use the passed unique ID
      className={`${baseStyle} ${configuredStyle} ${playingStyle} ${textStyle} ${dropzoneActiveStyle} ${dropzoneAcceptStyle} ${dropzoneRejectStyle}`}
      // Make clickable area separate from dropzone root if needed, but here it's combined
      // The single onClick handler below manages both playback and prevents dropzone default click
      onClick={(e) => {
          // Prevent dropzone's default click behavior if necessary, though noClick should handle it
          e.stopPropagation();
          onClick();
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
      aria-label={`Sound pad ${padIndex + 1}${name !== 'Empty Pad' ? `: ${name}` : ''}${keyBinding ? `, key ${keyBinding}` : ''}`}
    >
      {/* Input element required by react-dropzone */}
      <input {...getInputProps()} />

      {/* Key Binding Display */}
      {keyBinding && (
        <span className="absolute top-1 left-1 text-xs font-mono bg-gray-300 dark:bg-gray-600 px-1 rounded z-10">
          {keyBinding}
        </span>
      )}

      {/* Pad Name Display */}
      <span className="text-sm font-medium break-words z-10">{name}</span>

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
    </div>
  );
};

export default Pad;
