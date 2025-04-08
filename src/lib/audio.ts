import { getAudioFile } from './db';

// Detect client-side environment
const isClient = typeof window !== 'undefined';

let audioContext: AudioContext | null = null;
const activeSources: Map<string, AudioBufferSourceNode> = new Map(); // Track active sounds by a unique key (e.g., padId)

// Define an interface for window with potential webkitAudioContext
interface ExtendedWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

// Initialize AudioContext lazily on first interaction
function getAudioContext(): AudioContext {
  // Ensure we only run this on the client side
  if (!isClient) {
    throw new Error('AudioContext is not available on the server');
  }
  
  if (!audioContext) {
    // Cast window to the extended type to check for webkitAudioContext
    const extendedWindow = window as ExtendedWindow;
    audioContext = new (window.AudioContext || extendedWindow.webkitAudioContext)();
    // Resume context if it was suspended (e.g., due to browser policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }
  return audioContext;
}

// Decode audio data from a Blob
async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const context = getAudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } catch (error) {
    console.error('Error decoding audio data:', error);
    throw new Error('Failed to decode audio data.');
  }
}

// Load audio file from DB and decode it
export async function loadAndDecodeAudio(audioFileId: number): Promise<AudioBuffer | null> {
  try {
    const audioFileData = await getAudioFile(audioFileId);
    if (!audioFileData?.blob) {
      console.warn(`Audio file with ID ${audioFileId} not found or has no blob.`);
      return null;
    }
    console.log(`Decoding audio for file ID: ${audioFileId}, name: ${audioFileData.name}`);
    return await decodeAudioBlob(audioFileData.blob);
  } catch (error) {
    console.error(`Error loading/decoding audio file ID ${audioFileId}:`, error);
    return null;
  }
}

// Play an AudioBuffer
export function playAudio(
    buffer: AudioBuffer,
    playbackKey: string, // Unique key to identify this playback instance (e.g., padId)
    volume: number = 1.0 // Volume from 0.0 to 1.0
): AudioBufferSourceNode | null {
  try {
    const context = getAudioContext();

    // Stop any existing sound playing with the same key
    stopAudio(playbackKey);

    const source = context.createBufferSource();
    source.buffer = buffer;

    const gainNode = context.createGain();
    gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), context.currentTime); // Clamp volume

    source.connect(gainNode);
    gainNode.connect(context.destination);

    source.onended = () => {
      // Clean up when playback finishes naturally
      activeSources.delete(playbackKey);
      console.log(`Playback finished for key: ${playbackKey}`);
    };

    source.start(0);
    activeSources.set(playbackKey, source); // Track the new source
    console.log(`Playback started for key: ${playbackKey}`);
    return source;
  } catch (error) {
    console.error(`Error playing audio for key ${playbackKey}:`, error);
    return null;
  }
}

// Stop audio playback associated with a specific key
export function stopAudio(playbackKey: string): void {
  const source = activeSources.get(playbackKey);
  if (source) {
    try {
      source.stop(0);
      // onended callback will handle cleanup from activeSources map
      console.log(`Playback stopped for key: ${playbackKey}`);
    } catch (error) {
      // Ignore errors if the source was already stopped or in an invalid state
      if ((error as DOMException).name !== 'InvalidStateError') {
          console.error(`Error stopping audio for key ${playbackKey}:`, error);
      }
      // Manually clean up if stop fails or onended doesn't fire
      activeSources.delete(playbackKey);
    }
  }
}

// Function to resume AudioContext on user interaction (call this from a UI event handler)
export function resumeAudioContext(): void {
  const context = getAudioContext();
  if (context.state === 'suspended') {
    context.resume().then(() => {
      console.log('AudioContext resumed successfully.');
    }).catch(err => {
      console.error('Failed to resume AudioContext:', err);
    });
  }
}

// Preload common sounds or handle initial context state if needed
// Example: Ensure context is ready on load
// getAudioContext(); // Call early if desired, but user interaction is often required first
