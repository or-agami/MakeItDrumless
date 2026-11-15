import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Check, FileAudio2, Link2, LoaderCircle, Music2, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { getPreferences } from "@/features/settings/preferences";
import { cancelWorker, runWorker } from "@/features/worker/client";
import type { LibraryItem, WorkerEvent } from "@/features/worker/types";

type InputMode = "file" | "youtube";

export function GeneratePage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<InputMode>("file");
  const [filePath, setFilePath] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [upload, setUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState("");
  const [phase, setPhase] = useState("Ready to start");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  const chooseFile = async () => {
    try {
      const selected = await open({ multiple: false, title: "Choose audio file", filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg"] }] });
      if (typeof selected === "string") setFilePath(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the file picker.");
    }
  };

  const onWorkerEvent = (event: WorkerEvent) => {
    if (event.type === "progress") {
      setPhase(event.message || event.phase || "Working");
      setProgress(event.percent ?? null);
    } else if (event.type === "warning") {
      setWarning(event.message || "The upload did not complete.");
    } else if (event.type === "error") {
      setError(event.message || "Generation failed.");
    }
  };

  const generate = async () => {
    setError("");
    setWarning("");
    if (mode === "file" && !filePath) return setError("Choose an audio file to continue.");
    if (mode === "youtube" && !youtubeUrl.trim()) return setError("Paste a YouTube link to continue.");
    const prefs = await getPreferences();
    setBusy(true);
    setProgress(null);
    setPhase("Starting generation");
    try {
      const result = await runWorker<{ item: LibraryItem; upload_status: string }>({
        operation: "generate",
        source: { kind: mode, value: mode === "file" ? filePath : youtubeUrl.trim() },
        output_dir: prefs.outputDir,
        model: prefs.model,
        upload_ytmusic: upload,
      }, onWorkerEvent, setJobId);
      navigate(`/play/${encodeURIComponent(result.item.id)}`, { state: { uploadStatus: result.upload_status } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Generation did not complete.");
    } finally {
      setBusy(false);
      setJobId("");
    }
  };

  const cancel = async () => {
    if (!jobId) return;
    try { await cancelWorker(jobId); } catch { /* Process may already be finishing. */ }
  };

  return (
    <section className="page max-w-[820px]">
      <button className="mb-7 inline-flex items-center gap-2 border-0 bg-transparent p-0 text-[11px] text-[#9297a0] hover:text-white" onClick={() => navigate(-1)}><ArrowLeft size={14} /> Back to library</button>
      <div className="page-header !mb-7">
        <div><p className="eyebrow">NEW PRACTICE MIX</p><h1>Bring in a song.</h1><p className="page-subtitle">Choose your source and we’ll separate the stems for you.</p></div>
      </div>

      <div className="surface form-card">
        <div className="form-section">
          <label className="label">Audio source</label>
          <div className="segmented mb-4">
            <button className={mode === "file" ? "selected" : ""} onClick={() => setMode("file")}><FileAudio2 size={14} /> Local file</button>
            <button className={mode === "youtube" ? "selected" : ""} onClick={() => setMode("youtube")}><Link2 size={14} /> YouTube link</button>
          </div>
          {mode === "file" ? (
            <div className="flex gap-9">
              <div className="folder-path" title={filePath}>{filePath || "No audio file selected"}</div>
              <Button className="secondary-button" onClick={() => void chooseFile()}>Browse files</Button>
            </div>
          ) : (
            <input className="text-input" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" autoComplete="off" />
          )}
          <p className="form-hint">Supported audio: WAV, MP3, FLAC, M4A, AAC, and OGG. Choose a model preset in Settings.</p>
        </div>

        <div className="form-section">
          <label className="check-row cursor-pointer">
            <input type="checkbox" checked={upload} onChange={(event) => setUpload(event.target.checked)} />
            <div><strong>Also upload the drumless mix to YouTube Music</strong><span>The generated files stay in your local library if the upload fails.</span></div>
          </label>
          <button className="mt-3 border-0 bg-transparent p-0 text-[10px] text-[#a8d875] hover:text-[#d5f4ae]" onClick={() => navigate("/settings")}>Configure YouTube Music credentials in Settings →</button>
        </div>

        {error && <div className="inline-error"><div className="flex items-start justify-between gap-4">{error}<button className="border-0 bg-transparent text-[#f2b7ba]" onClick={() => setError("")} aria-label="Dismiss error"><X size={14} /></button></div></div>}
        {warning && <div className="inline-error">Track generated. Upload issue: {warning}</div>}
        {busy && (
          <div className="progress-card surface">
            <div className="progress-head"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={14} color="#b9f36b" /> {phase}</span><span>{progress == null ? "Processing can take a few minutes" : `${progress}%`}</span></div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${progress ?? 28}%`, opacity: progress == null ? .72 : 1 }} /></div>
            <button className="mt-3 border-0 bg-transparent p-0 text-[10px] text-[#9297a0] hover:text-white" onClick={() => void cancel()}>Cancel generation</button>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-4">
          <span className="kicker inline-flex items-center gap-2"><Music2 size={13} /> Saved to your configured music folder</span>
          <Button className="action-button" onClick={() => void generate()} disabled={busy}><Check size={15} /> {busy ? "Generating…" : "Generate track"}</Button>
        </div>
      </div>
    </section>
  );
}

export const Component = GeneratePage;
