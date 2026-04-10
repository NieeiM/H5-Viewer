/**
 * Audio playback controls component.
 * Uses Web Audio API for playback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  audioBuffer: AudioBuffer | null;
  onTimeUpdate?: (currentTime: number) => void;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export default function AudioPlayer({ audioBuffer, onTimeUpdate }: Props) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [duration, setDuration] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const startTimeRef = useRef(0);
  const startOffsetRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (audioBuffer) {
      setDuration(audioBuffer.duration);
      setCurrentTime(0);
    }
  }, [audioBuffer]);

  const stopPlayback = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setPlaying(false);
  }, []);

  const startPlayback = useCallback((offset: number) => {
    if (!audioBuffer) return;

    // Create or reuse AudioContext
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ sampleRate: audioBuffer.sampleRate });
    }
    const ctx = audioCtxRef.current;

    // Create gain node
    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    gainRef.current.gain.value = volume;

    // Create source
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainRef.current);
    sourceRef.current = source;

    startTimeRef.current = ctx.currentTime;
    startOffsetRef.current = offset;

    source.start(0, offset);
    setPlaying(true);

    source.onended = () => {
      if (sourceRef.current === source) {
        stopPlayback();
        setCurrentTime(0);
        startOffsetRef.current = 0;
      }
    };

    // Animation loop for time update
    const tick = () => {
      if (!audioCtxRef.current || !sourceRef.current) return;
      const elapsed = audioCtxRef.current.currentTime - startTimeRef.current;
      const time = startOffsetRef.current + elapsed;
      if (time <= duration) {
        setCurrentTime(time);
        onTimeUpdate?.(time);
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [audioBuffer, volume, duration, onTimeUpdate, stopPlayback]);

  const togglePlay = useCallback(() => {
    if (playing) {
      // Pause: record current position
      const elapsed = audioCtxRef.current
        ? audioCtxRef.current.currentTime - startTimeRef.current
        : 0;
      startOffsetRef.current += elapsed;
      stopPlayback();
    } else {
      startPlayback(startOffsetRef.current);
    }
  }, [playing, stopPlayback, startPlayback]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    startOffsetRef.current = time;
    onTimeUpdate?.(time);
    if (playing) {
      stopPlayback();
      startPlayback(time);
    }
  }, [playing, stopPlayback, startPlayback, onTimeUpdate]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (gainRef.current) {
      gainRef.current.gain.value = v;
    }
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      stopPlayback();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, [stopPlayback]);

  if (!audioBuffer) {
    return <div style={styles.container}><span style={styles.loading}>Decoding audio...</span></div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.controls}>
        <button onClick={togglePlay} style={styles.playBtn}>
          {playing ? '⏸' : '▶'}
        </button>
        <span style={styles.time}>{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={currentTime}
          onChange={handleSeek}
          style={styles.seekbar}
        />
        <span style={styles.time}>{formatTime(duration)}</span>
        <span style={styles.volumeIcon}>🔊</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={handleVolumeChange}
          style={styles.volumeBar}
        />
      </div>
      <div style={styles.info}>
        {audioBuffer.numberOfChannels} ch · {audioBuffer.sampleRate} Hz · {formatTime(audioBuffer.duration)}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '8px 12px',
    background: '#252526',
    borderBottom: '1px solid #3c3c3c',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '1px solid #555',
    background: '#333',
    color: '#fff',
    fontSize: '14px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  time: {
    fontSize: '11px',
    color: '#999',
    fontFamily: 'monospace',
    minWidth: 65,
    flexShrink: 0,
  },
  seekbar: {
    flex: 1,
    height: 4,
    cursor: 'pointer',
    accentColor: '#4ec9b0',
  },
  volumeIcon: {
    fontSize: '12px',
    flexShrink: 0,
  },
  volumeBar: {
    width: 60,
    height: 4,
    cursor: 'pointer',
    accentColor: '#4ec9b0',
    flexShrink: 0,
  },
  info: {
    fontSize: '11px',
    color: '#666',
    marginTop: 4,
  },
  loading: {
    fontSize: '12px',
    color: '#888',
  },
};
