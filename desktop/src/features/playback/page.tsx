import { convertFileSrc } from "@tauri-apps/api/core";
import MultiTrack from "wavesurfer-multitrack";
import { ArrowLeft, ChevronDown, Disc3, LoaderCircle, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, UIEvent, WheelEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { getPreferences, type ShortcutMap } from "@/features/settings/preferences";
import { runWorker } from "@/features/worker/client";
import type { LibraryItem, StemTrack } from "@/features/worker/types";

const colors: Record<string, string> = { no_drums: "#b9f36b", drums: "#f28c78", vocals: "#83b7fa", bass: "#c8a0ef", other: "#e0c47f", piano: "#82d7c3", guitar: "#e4a87b" };
const normalName = (value: string) => value.toLowerCase().replace(/ /g, "_").replace(/-/g, "_");
const formatTime = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
const formatPreciseTime = (seconds: number) => {
  const centiseconds = Math.floor(Math.max(0, seconds) * 100);
  const wholeSeconds = Math.floor(centiseconds / 100);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
};

function WaveCanvas({ track, peaks, duration, width, zoom, currentTime, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }: {
  track: StemTrack;
  peaks: number[];
  duration: number;
  width: number;
  zoom: number;
  currentTime: number;
  onPointerDown: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const color = colors[normalName(track.id)] ?? "#94a5a6";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const height = 104;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(dpr, dpr);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#171a1e";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#22262b";
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
    const count = Math.max(1, peaks.length);
    const trackDuration = Math.min(duration, track.duration ?? duration);
    const trackWidth = Math.min(width, trackDuration * zoom);
    const step = trackWidth / count;
    context.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const magnitude = Math.max(0.025, Math.min(1, peaks[i] ?? 0));
      const barHeight = Math.max(2, magnitude * 76);
      const x = i * step;
      context.globalAlpha = i * (trackDuration / count) < currentTime ? 0.94 : 0.46;
      context.fillRect(x, (height - barHeight) / 2, Math.max(1, step * 0.56), barHeight);
    }
    context.globalAlpha = 1;
  }, [color, currentTime, duration, peaks, track.duration, width, zoom]);

  return <canvas ref={canvasRef} className="wave-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave} aria-label={`${track.name} waveform`} role="slider" aria-valuemin={0} aria-valuemax={Math.round(duration)} />;
}

function getTicks(duration: number, zoom: number) {
  const step = zoom >= 28 ? 10 : zoom >= 13 ? 20 : 30;
  return Array.from({ length: Math.floor(duration / step) + 1 }, (_, index) => index * step);
}

export function PlaybackPage({ itemId, isVisible }: { itemId: string; isVisible: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [item, setItem] = useState<LibraryItem | null>(null);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [tracks, setTracks] = useState<StemTrack[]>([]);
  const [peaksById, setPeaksById] = useState<Record<string, number[]>>({});
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [shortcuts, setShortcuts] = useState<ShortcutMap>({ toggle: "Space", restart: "Home", back: "ArrowLeft", forward: "ArrowRight" });
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(26);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [peakStatus, setPeakStatus] = useState("Loading synchronized tracks and waveform peaks…");
  const [error, setError] = useState("");
  const playerRef = useRef<MultiTrack | null>(null);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const waveScrollRef = useRef<HTMLDivElement>(null);
  const seekingRef = useRef(false);

  const duration = Math.max(0, ...tracks.map((track) => track.duration ?? 0), item?.duration ?? 0);
  const minZoom = duration > 0 && viewportWidth > 0 ? Math.min(10, viewportWidth / duration) : 10;
  const effectiveZoom = Math.max(zoom, minZoom);
  const timelineWidth = Math.max(1, viewportWidth, Math.ceil(duration * effectiveZoom));

  useEffect(() => {
    if (itemId) setSelectedItemId(itemId);
  }, [itemId]);

  useEffect(() => {
    if (!isVisible) setHoveredTime(null);
  }, [isVisible]);

  useEffect(() => {
    const container = waveScrollRef.current;
    if (!container) return;
    const measure = () => {
      const width = container.clientWidth;
      if (width > 0) setViewportWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tracks.length]);

  useEffect(() => {
    if (!selectedItemId) return;
    let active = true;
    void (async () => {
      playerRef.current?.pause();
      setPlaying(false); setCurrentTime(0); setHoveredTime(null);
      setLoading(true); setError(""); setItem(null); setTracks([]); setPeaksById({});
      try {
        const prefs = await getPreferences();
        setShortcuts(prefs.shortcuts);
        const result = await runWorker<{ items: LibraryItem[] }>({ operation: "list_items", output_dir: prefs.outputDir });
        const match = result.items.find((candidate) => candidate.id === selectedItemId || candidate.path === selectedItemId);
        if (!match) throw new Error("This generated item is no longer in the selected library folder.");
        if (!active) return;
        setItem(match);
        setTracks(match.tracks);
        setPeaksById({});
        const initialVolumes: Record<string, number> = {};
        const initialMuted: Record<string, boolean> = {};
        for (const track of match.tracks) {
          const isMix = track.id === "no_drums";
          initialVolumes[track.id] = isMix ? 100 : track.id === "drums" ? 42 : 65;
          initialMuted[track.id] = !isMix;
        }
        setVolumes(initialVolumes); setMuted(initialMuted);
        await Promise.all(match.tracks.map(async (track) => {
          const result = await runWorker<{ peaks: number[][] }>({ operation: "waveform_peaks", item_path: match.path, track_path: track.path }, (event) => {
            if (event.type === "progress" && event.message) setPeakStatus(event.message);
          });
          if (active) setPeaksById((current) => ({ ...current, [track.id]: result.peaks?.[0] ?? [] }));
        }));
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load this track.");
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [selectedItemId]);

  useEffect(() => {
    const host = audioHostRef.current;
    if (!host || tracks.length === 0) return;
    playerRef.current?.destroy();
    host.innerHTML = "";
    const audioTracks = tracks.map((track) => ({
      id: track.id,
      url: convertFileSrc(track.path),
      // The media elements can play while cached waveform peaks are computed
      // in background workers; the visible canvases update independently.
      peaks: [[]],
      startPosition: 0,
      volume: muted[track.id] ? 0 : (volumes[track.id] ?? 0) / 100,
      options: { backend: "MediaElement" as const, height: 5, interact: false, waveColor: "transparent", progressColor: "transparent", cursorWidth: 0, hideScrollbar: true },
    }));
    try {
      const player = MultiTrack.create(audioTracks, { container: host, minPxPerSec: effectiveZoom, cursorColor: "transparent", cursorWidth: 0, trackBackground: "transparent", trackBorderColor: "transparent" });
      playerRef.current = player;
      const poll = window.setInterval(() => {
        const time = player.getCurrentTime();
        setCurrentTime(time);
        const active = player.isPlaying();
        setPlaying(active);
        if (duration > 0 && time >= duration - 0.08 && !active) setCurrentTime(duration);
      }, 90);
      return () => { window.clearInterval(poll); player.destroy(); playerRef.current = null; };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not initialize synchronized playback.");
      return;
    }
  }, [tracks, duration]);

  useEffect(() => {
    playerRef.current?.zoom(effectiveZoom);
  }, [effectiveZoom]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    tracks.forEach((track, index) => player.setTrackVolume(index, muted[track.id] ? 0 : (volumes[track.id] ?? 0) / 100));
  }, [muted, tracks, volumes]);

  const seek = useCallback((time: number) => {
    const bounded = Math.max(0, Math.min(duration, time));
    playerRef.current?.setTime(bounded);
    setCurrentTime(bounded);
  }, [duration]);
  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying()) { player.pause(); setPlaying(false); }
    else { player.play(); setPlaying(true); }
  }, []);
  const restart = useCallback(() => {
    const wasPlaying = playerRef.current?.isPlaying() ?? playing;
    playerRef.current?.pause();
    playerRef.current?.setTime(0);
    setCurrentTime(0);
    if (wasPlaying) { playerRef.current?.play(); setPlaying(true); }
  }, [playing]);
  const skip = useCallback((delta: number) => seek((playerRef.current?.getCurrentTime() ?? currentTime) + delta), [currentTime, seek]);

  const getPointerTime = useCallback((event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(timelineWidth, Math.max(0, event.clientX - rect.left));
    return Math.min(duration, Math.max(0, x / effectiveZoom));
  }, [duration, effectiveZoom, timelineWidth]);
  const beginTimelineSeek = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!duration || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekingRef.current = true;
    const time = getPointerTime(event);
    setHoveredTime(time);
    seek(time);
  }, [duration, getPointerTime, seek]);
  const moveTimelinePointer = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!duration) return;
    const time = getPointerTime(event);
    setHoveredTime(time);
    if (seekingRef.current) seek(time);
  }, [duration, getPointerTime, seek]);
  const endTimelineSeek = useCallback((event: PointerEvent<HTMLElement>) => {
    seekingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  const leaveTimeline = useCallback(() => {
    if (!seekingRef.current) setHoveredTime(null);
  }, []);
  const timelineWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.002);
    const maxZoom = Math.max(52, minZoom);
    setZoom((value) => Math.min(maxZoom, Math.max(minZoom, value * factor)));
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isVisible || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target?.tagName ?? "")) return;
      const action = (Object.keys(shortcuts) as Array<keyof ShortcutMap>).find((key) => shortcuts[key] === event.code);
      if (!action) return;
      event.preventDefault();
      if (action === "toggle") toggle();
      if (action === "restart") restart();
      if (action === "back") skip(-10);
      if (action === "forward") skip(10);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isVisible, restart, shortcuts, skip, toggle]);

  const rulerScroll = (event: UIEvent<HTMLDivElement>) => {
    const source = event.currentTarget;
    if (source === rulerRef.current && waveScrollRef.current) waveScrollRef.current.scrollLeft = source.scrollLeft;
    if (source === waveScrollRef.current && rulerRef.current) rulerRef.current.scrollLeft = source.scrollLeft;
  };
  const ticks = getTicks(duration, effectiveZoom);
  const loadingTrack = loading || (!item && Boolean(itemId));
  const mixBadge = location.state?.uploadStatus === "failed" || item?.upload_status === "failed";
  const humanDate = item ? new Date(item.created_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "";

  return (
    <section className="page play-page">
      {item || loadingTrack || error ? <div className="play-topbar">
        <div className="track-heading">
          <button className="mb-2 inline-flex items-center gap-1 border-0 bg-transparent p-0 text-[10px] text-[#8f949d] hover:text-white" onClick={() => navigate("/")}><ArrowLeft size={12} /> Library</button>
          <h1 title={item?.title}>{item?.title || (loadingTrack ? "Loading track…" : "")}</h1>
          <p className="page-subtitle !mt-1">{item?.artist || `${item?.model ?? ""} · ${humanDate}`}</p>
        </div>
        <div className="transport" aria-label="Playback controls">
          <button className="skip-button" title="Back 10 seconds" onClick={() => skip(-10)}><span>10</span><ChevronDown className="rotate-90" size={14} /></button>
          <button className="icon-button" title="Start over" onClick={restart}><RotateCcw size={16} /></button>
          <button className="primary-play" title={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}</button>
          <button className="skip-button" title="Forward 10 seconds" onClick={() => skip(10)}><ChevronDown className="-rotate-90" size={14} /><span>10</span></button>
        </div>
        <div className="time-readout"><strong>{formatTime(currentTime)}</strong><span className="mx-2 text-[#555b65]">/</span>{formatTime(duration)}</div>
      </div> : null}

      {error && <div className="inline-error mt-5">{error}</div>}
      {mixBadge && <div className="inline-error mt-5">The stems were generated, but the YouTube Music upload failed. Your files remain in the library; check Settings before your next upload.</div>}
      {loadingTrack && !item ? (
        <div className="track-loading"><LoaderCircle size={18} className="mr-2 animate-spin" color="#b9f36b" /> {peakStatus}</div>
      ) : item && tracks.length > 0 ? (
        <div className="play-content">
          <div className="play-summary">
            <p>{tracks.length} aligned tracks <span className="mx-2 text-[#545a63]">·</span> Only the no-drums mix is on by default{loading && <span className="ml-3 inline-flex items-center gap-1.5 text-[#a8d875]"><LoaderCircle size={11} className="animate-spin" />{peakStatus}</span>}</p>
            <div className="zoom-control"><span>Zoom</span><input aria-label="Timeline zoom" type="range" min={minZoom} max={Math.max(52, minZoom)} step="any" value={effectiveZoom} onChange={(event) => setZoom(Number(event.target.value))} /><span>{effectiveZoom.toFixed(1)} px/s</span></div>
          </div>
          <div className="mixer" onWheel={timelineWheel}>
            <div className="mixer-head">
              <div className="track-head-label">Track / level</div>
              <div className="ruler-scroll" ref={rulerRef} onScroll={rulerScroll}>
                <div className="ruler-canvas" style={{ width: timelineWidth }} onPointerDown={beginTimelineSeek} onPointerMove={moveTimelinePointer} onPointerUp={endTimelineSeek} onPointerCancel={endTimelineSeek} onPointerLeave={leaveTimeline}>
                  {ticks.map((time) => <div key={time} className="ruler-tick" style={{ left: time * effectiveZoom }}>{formatTime(time)}</div>)}
                  <div className="track-playhead" style={{ left: currentTime * effectiveZoom }}><span className="playhead-label">{formatPreciseTime(currentTime)}</span></div>
                  {hoveredTime != null && Math.abs(hoveredTime - currentTime) > 0.25 && <div className="track-playhead hovered" style={{ left: hoveredTime * effectiveZoom }}><span className="playhead-label">{formatPreciseTime(hoveredTime)}</span></div>}
                </div>
              </div>
            </div>
            <div className="mixer-body">
              <div className="control-column">
                {tracks.map((track) => {
                  const isMuted = muted[track.id] ?? track.id !== "no_drums";
                  const level = volumes[track.id] ?? (track.id === "no_drums" ? 100 : 60);
                  const color = colors[normalName(track.id)] ?? "#94a5a6";
                  return (
                    <div className="track-control" key={track.id} style={{ ["--stem-color" as string]: color } as CSSProperties}>
                      <div className="track-control-top"><span className="stem-indicator" /><span className="stem-name">{track.name}</span><button className={`mute-button ${!isMuted ? "active" : ""}`} title={isMuted ? `Unmute ${track.name}` : `Mute ${track.name}`} onClick={() => setMuted((current) => ({ ...current, [track.id]: !isMuted }))}>{isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button></div>
                      <div className="volume-row"><span className="text-[9px]">VOL</span><input aria-label={`${track.name} volume`} type="range" min="0" max="100" value={level} onChange={(event) => setVolumes((current) => ({ ...current, [track.id]: Number(event.target.value) }))} /><span className="volume-value">{level}%</span></div>
                    </div>
                  );
                })}
              </div>
              <div className="wave-scroll" ref={waveScrollRef} onScroll={rulerScroll}>
                <div style={{ width: timelineWidth }}>
                  {tracks.map((track) => (
                    <div className="wave-track" key={track.id}>
                      <WaveCanvas track={track} peaks={peaksById[track.id] ?? []} duration={duration} width={timelineWidth} zoom={effectiveZoom} currentTime={currentTime} onPointerDown={beginTimelineSeek} onPointerMove={moveTimelinePointer} onPointerUp={endTimelineSeek} onPointerLeave={leaveTimeline} />
                      <div className="track-playhead" style={{ left: currentTime * effectiveZoom }} />
                      {hoveredTime != null && <div className="track-playhead hovered" style={{ left: hoveredTime * effectiveZoom }} />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="play-actions"><span className="kicker">Tip · Lower the drum stem to blend live playing with the original rhythm.</span><span className="mix-badge"><Disc3 size={12} /> Local playback</span></div>
          <div className="hidden-audio-host" ref={audioHostRef} aria-hidden="true" />
        </div>
      ) : error ? null : !item ? <div className="surface empty-state player-empty-state"><div className="empty-icon"><Disc3 size={26} /></div><h2>Nothing loaded yet.</h2><p>Choose a generated track from your library or make a new practice mix to start listening.</p><button className="action-button" onClick={() => navigate("/")}><ArrowLeft size={14} /> Browse library</button></div> : <div className="track-loading">No separated stems were found for this item.</div>}
    </section>
  );
}

export const Component = PlaybackPage;
