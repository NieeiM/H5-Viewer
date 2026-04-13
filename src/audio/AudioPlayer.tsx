/**
 * Audio playback controls. Exposes seek/toggle via forwardRef.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

interface Props {
  audioBuffer: AudioBuffer | null;
  onTimeUpdate?: (t: number) => void;
}

export interface AudioPlayerHandle {
  seek: (t: number) => void;
  toggle: () => void;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(({ audioBuffer, onTimeUpdate }, ref) => {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [duration, setDuration] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const startWallRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (audioBuffer) { setDuration(audioBuffer.duration); setCurrentTime(0); offsetRef.current = 0; }
  }, [audioBuffer]);

  const stop = useCallback(() => {
    try { srcRef.current?.stop(); } catch { /* ok */ }
    srcRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    setPlaying(false);
  }, []);

  const play = useCallback((from: number) => {
    if (!audioBuffer) return;
    if (!ctxRef.current) ctxRef.current = new AudioContext({ sampleRate: audioBuffer.sampleRate });
    const ctx = ctxRef.current;
    if (!gainRef.current) { gainRef.current = ctx.createGain(); gainRef.current.connect(ctx.destination); }
    gainRef.current.gain.value = volume;

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(gainRef.current);
    srcRef.current = src;
    startWallRef.current = ctx.currentTime;
    offsetRef.current = from;
    src.start(0, from);
    setPlaying(true);

    src.onended = () => { if (srcRef.current === src) { stop(); setCurrentTime(0); offsetRef.current = 0; } };

    const tick = () => {
      if (!ctxRef.current || !srcRef.current) return;
      const t = offsetRef.current + (ctxRef.current.currentTime - startWallRef.current);
      if (t <= duration) { setCurrentTime(t); onTimeUpdate?.(t); rafRef.current = requestAnimationFrame(tick); }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [audioBuffer, volume, duration, onTimeUpdate, stop]);

  const toggle = useCallback(() => {
    if (playing) {
      offsetRef.current += ctxRef.current ? ctxRef.current.currentTime - startWallRef.current : 0;
      stop();
    } else {
      play(offsetRef.current);
    }
  }, [playing, stop, play]);

  const seekTo = useCallback((t: number) => {
    offsetRef.current = t;
    setCurrentTime(t);
    onTimeUpdate?.(t);
    if (playing) { stop(); play(t); }
  }, [playing, stop, play, onTimeUpdate]);

  useImperativeHandle(ref, () => ({ seek: seekTo, toggle }), [seekTo, toggle]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => seekTo(parseFloat(e.target.value)), [seekTo]);
  const handleVol = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value); setVolume(v); if (gainRef.current) gainRef.current.gain.value = v;
  }, []);

  useEffect(() => () => { stop(); ctxRef.current?.close().catch(() => {}); ctxRef.current = null; }, [stop]);

  if (!audioBuffer) return <div className="h5v-panel-loading">Decoding audio...</div>;

  return (
    <div>
      <div className="h5v-audio-controls">
        <button className="h5v-play-btn" onClick={toggle}>{playing ? '⏸' : '▶'}</button>
        <span className="h5v-time">{fmt(currentTime)}</span>
        <input type="range" className="h5v-seekbar" min={0} max={duration} step={0.01} value={currentTime} onChange={handleSeek} />
        <span className="h5v-time">{fmt(duration)}</span>
        <span style={{ fontSize: 12, flexShrink: 0 }}>🔊</span>
        <input type="range" className="h5v-volume-bar" min={0} max={1} step={0.01} value={volume} onChange={handleVol} />
      </div>
      <div className="h5v-audio-info">
        {audioBuffer.numberOfChannels} ch · {audioBuffer.sampleRate} Hz · {fmt(audioBuffer.duration)}
      </div>
    </div>
  );
});

AudioPlayer.displayName = 'AudioPlayer';
export default AudioPlayer;
