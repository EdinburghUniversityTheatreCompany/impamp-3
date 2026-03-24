/**
 * Audio Module - Waveform
 *
 * Utility to downsample an AudioBuffer into drawable peak data
 * for canvas-based waveform visualization.
 *
 * @module lib/audio/waveform
 */

export interface WaveformPeak {
  min: number;
  max: number;
}

/**
 * Downsample an AudioBuffer into peak data suitable for canvas rendering.
 * Merges all channels into a single mono representation.
 *
 * @param buffer - The decoded AudioBuffer
 * @param targetPoints - Number of data points to produce (default: 800)
 * @returns Array of min/max peak pairs
 */
export function getWaveformPeaks(
  buffer: AudioBuffer,
  targetPoints: number = 800,
): WaveformPeak[] {
  const length = buffer.length;
  const numberOfChannels = buffer.numberOfChannels;
  const samplesPerPoint = Math.floor(length / targetPoints);

  if (samplesPerPoint < 1) {
    // Buffer is shorter than target points — use one point per sample
    const peaks: WaveformPeak[] = [];
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      let sum = channelData[i];
      for (let ch = 1; ch < numberOfChannels; ch++) {
        sum += buffer.getChannelData(ch)[i];
      }
      const avg = sum / numberOfChannels;
      peaks.push({ min: avg, max: avg });
    }
    return peaks;
  }

  // Pre-fetch all channel data arrays
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  const peaks: WaveformPeak[] = [];

  for (let i = 0; i < targetPoints; i++) {
    const start = i * samplesPerPoint;
    const end = Math.min(start + samplesPerPoint, length);

    let min = Infinity;
    let max = -Infinity;

    for (let j = start; j < end; j++) {
      // Average across channels
      let sum = 0;
      for (let ch = 0; ch < numberOfChannels; ch++) {
        sum += channels[ch][j];
      }
      const avg = sum / numberOfChannels;

      if (avg < min) min = avg;
      if (avg > max) max = avg;
    }

    peaks.push({ min, max });
  }

  return peaks;
}
