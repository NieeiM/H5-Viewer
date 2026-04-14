/**
 * Audio playback engine + controls.
 * Uses direct DOM manipulation for playhead animation (not React setState).
 * Adapted from vscode-audio-preview playerService/playerComponent (MIT).
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface AudioPlayerHandle {
  seek: (timeSec: number) => void;
  toggle: () => void;
  getCurrentTime: () => number;
  isPlaying: () => boolean;
}

interface Props {
  audioBuffer: AudioBuffer | null;
  /** Direct DOM refs for playhead elements — updated via rAF, not React */
  playheadRefs?: React.RefObject<HTMLDivElement | null>[];
  /** Called on every animation frame with current time in seconds */
  onTimeUpdate?: (timeSec: number) => void;
  /** Enable HPF */
  hpfEnabled?: boolean;
  hpfFrequency?: number;
  /** Enable LPF */
  lpfEnabled?: boolean;
  lpfFrequency?: number;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(({
  audioBuffer, playheadRefs, onTimeUpdate,
  hpfEnabled, hpfFrequency, lpfEnabled, lpfFrequency,
}, ref) => {
  const [playing, setPlaying] = useState(false);
  const [volumeDb, setVolumeDb] = useState(0); // dB mode: -80 to 0
  const [volumeLinear, setVolumeLinear] = useState(100); // linear mode: 0-100
  const [useDbVolume, setUseDbVolume] = useState(false);
  const [duration, setDuration] = useState(0);

  // Direct DOM refs for time display (bypasses React for 60fps)
  const seekDisplayRef = useRef<HTMLInputElement>(null);
  const posTextRef = useRef<HTMLSpanElement>(null);

  // Audio engine refs
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const hpfRef = useRef<BiquadFilterNode | null>(null);
  const lpfRef = useRef<BiquadFilterNode | null>(null);
  const rafRef = useRef(0);
  const startWallRef = useRef(0);
  const currentSecRef = useRef(0);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    if (audioBuffer) { setDuration(audioBuffer.duration); currentSecRef.current = 0; }
  }, [audioBuffer]);

  const getVolume = useCallback((): number => {
    if (useDbVolume) {
      return volumeDb <= -80 ? 0 : Math.pow(10, volumeDb / 20);
    }
    return volumeLinear / 100;
  }, [useDbVolume, volumeDb, volumeLinear]);

  const updatePlayheads = useCallback((timeSec: number) => {
    if (!audioBuffer || audioBuffer.duration <= 0) return;
    const pct = (timeSec / audioBuffer.duration) * 100;
    // Update all playhead DOM elements directly
    if (playheadRefs) {
      for (const r of playheadRefs) {
        if (r.current) r.current.style.left = `${pct}%`;
      }
    }
    // Update seekbar display
    if (seekDisplayRef.current) {
      seekDisplayRef.current.value = String(pct);
    }
    // Update position text
    if (posTextRef.current) {
      posTextRef.current.textContent = `${fmt(timeSec)} / ${fmt(audioBuffer.duration)}`;
    }
    onTimeUpdate?.(timeSec);
  }, [audioBuffer, playheadRefs, onTimeUpdate]);

  const stop = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    try { srcRef.current?.stop(); } catch { /* ok */ }
    srcRef.current = null;
    isPlayingRef.current = false;
    setPlaying(false);
  }, []);

  const play = useCallback((fromSec: number) => {
    if (!audioBuffer) return;
    if (!ctxRef.current) ctxRef.current = new AudioContext({ sampleRate: audioBuffer.sampleRate });
    const ctx = ctxRef.current;

    // Build filter chain: source → [hpf] → [lpf] → gain → destination
    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
    }
    gainRef.current.gain.value = getVolume();

    let lastNode: AudioNode = gainRef.current;
    gainRef.current.disconnect();
    gainRef.current.connect(ctx.destination);

    // LPF
    if (lpfEnabled && lpfFrequency) {
      if (!lpfRef.current) {
        lpfRef.current = ctx.createBiquadFilter();
        lpfRef.current.type = 'lowpass';
        lpfRef.current.Q.value = Math.SQRT1_2;
      }
      lpfRef.current.frequency.value = lpfFrequency;
      lpfRef.current.disconnect();
      lpfRef.current.connect(gainRef.current);
      lastNode = lpfRef.current;
    }

    // HPF
    if (hpfEnabled && hpfFrequency) {
      if (!hpfRef.current) {
        hpfRef.current = ctx.createBiquadFilter();
        hpfRef.current.type = 'highpass';
        hpfRef.current.Q.value = Math.SQRT1_2;
      }
      hpfRef.current.frequency.value = hpfFrequency;
      hpfRef.current.disconnect();
      if (lpfEnabled && lpfRef.current) {
        hpfRef.current.connect(lpfRef.current);
      } else {
        hpfRef.current.connect(gainRef.current);
      }
      lastNode = hpfRef.current;
    }

    // Source
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    if (hpfEnabled && hpfRef.current) {
      src.connect(hpfRef.current);
    } else if (lpfEnabled && lpfRef.current) {
      src.connect(lpfRef.current);
    } else {
      src.connect(gainRef.current);
    }
    srcRef.current = src;
    startWallRef.current = ctx.currentTime;
    currentSecRef.current = fromSec;

    src.start(0, fromSec);
    isPlayingRef.current = true;
    setPlaying(true);

    src.onended = () => {
      if (srcRef.current === src) {
        stop();
        currentSecRef.current = 0;
        updatePlayheads(0);
      }
    };

    // Animation loop — direct DOM updates, no React setState
    const tick = () => {
      if (!isPlayingRef.current || !ctxRef.current) return;
      const elapsed = ctxRef.current.currentTime - startWallRef.current;
      const current = currentSecRef.current + elapsed;
      if (current <= duration) {
        updatePlayheads(current);
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [audioBuffer, duration, getVolume, hpfEnabled, hpfFrequency, lpfEnabled, lpfFrequency, stop, updatePlayheads]);

  const toggle = useCallback(() => {
    if (isPlayingRef.current) {
      // Pause: accumulate elapsed time
      const elapsed = ctxRef.current ? ctxRef.current.currentTime - startWallRef.current : 0;
      currentSecRef.current += elapsed;
      stop();
    } else {
      play(currentSecRef.current);
    }
  }, [stop, play]);

  const seekTo = useCallback((timeSec: number) => {
    currentSecRef.current = Math.max(0, Math.min(timeSec, duration));
    updatePlayheads(currentSecRef.current);
    if (isPlayingRef.current) {
      stop();
      play(currentSecRef.current);
    }
  }, [duration, stop, play, updatePlayheads]);

  useImperativeHandle(ref, () => ({
    seek: seekTo,
    toggle,
    getCurrentTime: () => {
      if (isPlayingRef.current && ctxRef.current) {
        return currentSecRef.current + (ctxRef.current.currentTime - startWallRef.current);
      }
      return currentSecRef.current;
    },
    isPlaying: () => isPlayingRef.current,
  }), [seekTo, toggle]);

  // Update gain when volume changes
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = getVolume();
  }, [getVolume]);

  // Cleanup
  useEffect(() => () => {
    stop();
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, [stop]);

  // User seekbar input handler
  const handleSeekInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const pct = parseFloat(e.target.value);
    seekTo((pct / 100) * duration);
    // Reset the invisible input
    e.target.value = '100';
  }, [seekTo, duration]);

  if (!audioBuffer) return <div className="h5v-panel-loading">Decoding audio...</div>;

  return (
    <div>
      <div className="h5v-audio-controls">
        <button className="h5v-play-btn" onClick={toggle}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="h5v-time" ref={posTextRef}>
          {fmt(0)} / {fmt(duration)}
        </span>
        <div className="h5v-seekbar-box">
          {/* Visible display seekbar (read-only, updated by rAF) */}
          <input
            type="range"
            className="h5v-seekbar h5v-seekbar-display"
            min={0} max={100} step={0.01}
            defaultValue={0}
            ref={seekDisplayRef}
            readOnly
            tabIndex={-1}
          />
          {/* Invisible user input seekbar */}
          <input
            type="range"
            className="h5v-seekbar h5v-seekbar-input"
            min={0} max={100} step={0.01}
            defaultValue={100}
            onChange={handleSeekInput}
          />
        </div>
      </div>
      <div className="h5v-audio-toolbar">
        <label className="h5v-wrap-label">
          <input type="checkbox" checked={useDbVolume} onChange={(e) => setUseDbVolume(e.target.checked)} />
          dB
        </label>
        {useDbVolume ? (
          <>
            <span className="h5v-time">vol {volumeDb.toFixed(1)} dB</span>
            <input
              type="range" className="h5v-volume-bar"
              min={-80} max={0} step={0.5}
              value={volumeDb}
              onChange={(e) => setVolumeDb(parseFloat(e.target.value))}
            />
          </>
        ) : (
          <>
            <span className="h5v-time">vol {volumeLinear}</span>
            <input
              type="range" className="h5v-volume-bar"
              min={0} max={100} step={1}
              value={volumeLinear}
              onChange={(e) => setVolumeLinear(parseInt(e.target.value))}
            />
          </>
        )}
        <span className="h5v-audio-info-inline">
          {audioBuffer.numberOfChannels}ch · {audioBuffer.sampleRate.toLocaleString()} Hz · {fmt(duration)}
        </span>
      </div>
    </div>
  );
});

AudioPlayer.displayName = 'AudioPlayer';
export default AudioPlayer;
