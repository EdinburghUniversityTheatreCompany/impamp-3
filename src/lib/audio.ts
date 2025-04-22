import { getAudioFile } from './db';

// Detect client-side environment
const isClient = typeof window !== 'undefined';

// Define interface for active track information
export interface ActiveTrack {
  source: AudioBufferSourceNode;
  name: string;
  startTime: number;
  duration: number;
  padInfo: {
    profileId: number;
    pageIndex: number;
    padIndex: number;
  };
}

let audioContext: AudioContext | null = null;
const activeTracks: Map<string, ActiveTrack> = new Map(); // Enhanced tracking with metadata
const fadingTracks: Map<string, boolean> = new Map(); // Track which sounds are currently fading out

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

// Play an AudioBuffer with enhanced metadata
export function playAudio(
    buffer: AudioBuffer,
    playbackKey: string, // Unique key to identify this playback instance (e.g., padId)
    metadata: {
      name: string;
      padInfo: {
        profileId: number;
        pageIndex: number;
        padIndex: number;
      }
    },
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
      activeTracks.delete(playbackKey);
      console.log(`Playback finished for key: ${playbackKey}`);
    };

    source.start(0);
    
    // Store enhanced track information
    activeTracks.set(playbackKey, {
      source,
      name: metadata.name,
      startTime: context.currentTime,
      duration: buffer.duration,
      padInfo: metadata.padInfo
    });
    
    console.log(`Playback started for key: ${playbackKey}`);
    return source;
  } catch (error) {
    console.error(`Error playing audio for key ${playbackKey}:`, error);
    return null;
  }
}

// Check if a track is currently fading out
export function isTrackFading(playbackKey: string): boolean {
  return fadingTracks.get(playbackKey) === true;
}

// Stop audio playback associated with a specific key
export function stopAudio(playbackKey: string): void {
  const track = activeTracks.get(playbackKey);
  if (track) {
    try {
      track.source.stop(0);
      // Explicitly delete from activeTracks immediately - don't wait for onended
      activeTracks.delete(playbackKey);
      // Also clear from fading tracks if it was fading
      fadingTracks.delete(playbackKey);
      console.log(`Playback stopped and removed for key: ${playbackKey}`);
    } catch (error) {
      // Ignore errors if the source was already stopped or in an invalid state
      if ((error as DOMException).name !== 'InvalidStateError') {
          console.error(`Error stopping audio for key ${playbackKey}:`, error);
      }
      // Manually clean up if stop fails
      activeTracks.delete(playbackKey);
      fadingTracks.delete(playbackKey);
    }
  }
}

// Fade out audio over a specified duration
export function fadeOutAudio(playbackKey: string, durationInSeconds: number = 3): void {
  const track = activeTracks.get(playbackKey);
  if (!track) return;
  
  // If already fading, don't restart the fadeout
  if (fadingTracks.get(playbackKey)) return;
  
  try {
    const context = getAudioContext();
    const source = track.source;
    
    // Disconnect the source from its current destination
    source.disconnect();
    
    // Create a gain node
    const gainNode = context.createGain();
    // Start at current volume (1)
    gainNode.gain.setValueAtTime(1, context.currentTime);
    // Fade to 0 over the specified duration
    gainNode.gain.linearRampToValueAtTime(0, context.currentTime + durationInSeconds);
    
    // Connect source -> gain -> destination
    source.connect(gainNode);
    gainNode.connect(context.destination);
    
    // Mark track as fading
    fadingTracks.set(playbackKey, true);
    
    console.log(`Starting fadeout for key: ${playbackKey} over ${durationInSeconds} seconds`);
    
    // Remove the track from activeTracks after the fade completes
    setTimeout(() => {
      // Only try to stop if it's still active
      if (activeTracks.has(playbackKey)) {
        try {
          source.stop(0);
        } catch {
          // Ignore errors if already stopped
        }
        activeTracks.delete(playbackKey);
        fadingTracks.delete(playbackKey); // Remove from fading tracks
        console.log(`Fadeout completed for key: ${playbackKey}`);
      }
    }, durationInSeconds * 1000);
    
  } catch (error) {
    console.error(`Error fading out audio for key ${playbackKey}:`, error);
    // Fallback to immediate stop if fadeout fails
    stopAudio(playbackKey);
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

// Stop all currently playing audio tracks
export function stopAllAudio(): void {
  // Get all keys from activeTracks Map
  const keys = Array.from(activeTracks.keys());
  
  // Stop each track
  keys.forEach(key => {
    stopAudio(key);
  });
  
  console.log(`[Audio] Stopped all active tracks (${keys.length} tracks)`); // Added prefix for clarity
}

// Fade out all currently playing audio tracks
export function fadeOutAllAudio(durationInSeconds: number = 3): void {
  // Get all keys from activeTracks Map
  const keys = Array.from(activeTracks.keys());

  // Fade out each track
  keys.forEach(key => {
    // Check if the track is already fading to avoid restarting the fade
    if (!isTrackFading(key)) {
      fadeOutAudio(key, durationInSeconds);
    }
  });

  console.log(`[Audio] Initiated fade out for all active tracks (${keys.length} tracks) over ${durationInSeconds} seconds`); // Added logging
}

// Get information about currently active tracks with timing information
export function getActiveTracks(): Array<{
  key: string;
  name: string;
  remainingTime: number;
  totalDuration: number;
  progress: number;
  isFading: boolean;
  padInfo: {
    profileId: number;
    pageIndex: number;
    padIndex: number;
  };
}> {
  if (!audioContext) return [];
  
  const currentTime = audioContext.currentTime;
  return Array.from(activeTracks.entries()).map(([key, track]) => {
    const elapsed = currentTime - track.startTime;
    const remaining = Math.max(0, track.duration - elapsed);
    return {
      key,
      name: track.name,
      remainingTime: remaining,
      totalDuration: track.duration,
      progress: Math.min(1, elapsed / track.duration),
      isFading: isTrackFading(key),
      padInfo: track.padInfo
    };
  });
}

// Preload common sounds or handle initial context state if needed
// Example: Ensure context is ready on load
// getAudioContext(); // Call early if desired, but user interaction is often required first
