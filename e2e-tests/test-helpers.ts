import { Page, Locator, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Helper function to create a test audio file path for testing.
 * Generates a simple sine wave audio buffer, formats it as WAV,
 * saves it to a temporary file, and returns the file path.
 */
export async function createTestAudioFilePath(fileName: string): Promise<string> {
  // Generate raw audio data (simple sine wave)
  const sampleRate = 44100;
  const durationSeconds = 60; // Shorter duration for tests
  const numChannels = 1; // Mono
  const numSamples = sampleRate * durationSeconds;
  const audioData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    audioData[i] = Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 0.1; // A4 note
  }

  // Convert Float32Array to Int16Array for WAV format
  const int16Data = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    int16Data[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32767));
  }

  // --- Create WAV Buffer ---
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const fileSize = 36 + dataSize; // 36 bytes for header before data chunk

  const buffer = Buffer.alloc(44 + dataSize); // 44 bytes for standard WAV header

  // RIFF chunk descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize, 4); // ChunkSize
  buffer.write('WAVE', 8);

  // "fmt " sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

  // "data" sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40); // Subchunk2Size

  // Write audio data
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(int16Data[i], 44 + i * 2);
  }
  // --- End WAV Buffer Creation ---

  // Create a temporary file path
  const tempDir = os.tmpdir();
  const tempFilePath = path.join(tempDir, fileName + '.wav');

  // Write the buffer to the temporary file
  await fs.promises.writeFile(tempFilePath, buffer);

  console.log(`Created temporary test audio file: ${tempFilePath}`);
  return tempFilePath;
}

/**
 * Helper function to activate a pad (tries both click and keyboard)
 * and verify it's playing
 */
export async function activatePad(
  page: Page,
  padLocator: Locator,
  keyBinding?: string
) {
  console.log('Activating pad...');
  
  // First, ensure AudioContext is resumed
  await page.evaluate(() => {
    // Resume any AudioContext instances
    const resumeAllAudioContexts = () => {
      // Define a type for window that includes our test property
      interface WindowWithAudioContextInstances extends Window {
        _audioContextInstances?: AudioContext[];
      }
      
      // Check if AudioContext exists on window
      if (typeof window.AudioContext !== 'undefined') {
        // Cast to our specific type and access the property safely
        const instances = (window as WindowWithAudioContextInstances)._audioContextInstances || [];
        // Ensure the return type is Promise<void>
        return Promise.all(
          instances
            .filter((ctx: AudioContext) => ctx.state !== 'running')
            .map((ctx: AudioContext) => ctx.resume())
        ).then(() => {}); // Chain .then to discard the void[] result
      }
      return Promise.resolve(); // This already returns Promise<void>
    };
    
    return resumeAllAudioContexts();
  });
  
  // If key binding is provided, use keyboard activation. Otherwise, click.
  if (keyBinding) {
    console.log(`Pressing key: ${keyBinding}`);
    await page.keyboard.press(keyBinding);
  } else {
    console.log('Clicking pad');
    await padLocator.click({force: true});
  }
  
  await page.waitForTimeout(300);

  // Verify the active tracks panel shows something is playing
  await expect(page.locator('text=Nothing playing')).toBeHidden({timeout: 30000});
  
  // Look for the progress bar on the pad
  const progressBar = padLocator.locator('.bg-green-500');
  await expect(progressBar).toBeVisible({timeout: 5000});
  
  console.log('Pad playing verified');
}

/**
 * Utility to prepare the audio context for testing
 * This ensures createBuffer returns non-silent buffers
 */
export async function prepareAudioContext(page: Page) {
  await page.evaluate(() => {
    // Create a mock for the AudioContext.createBuffer to return a valid buffer
    const originalCreateBuffer = AudioContext.prototype.createBuffer;
    AudioContext.prototype.createBuffer = function(numChannels, length, sampleRate) {
      const buffer = originalCreateBuffer.call(this, numChannels, length, sampleRate);
      // Fill with some data so it's not silent
      const channelData = buffer.getChannelData(0);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.sin(i / 100) * 0.5;
      }
      return buffer;
    };
  });
}
