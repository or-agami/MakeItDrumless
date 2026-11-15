import { ArrowUpRight, Disc3, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { getPreferences } from "@/features/settings/preferences";
import { runWorker } from "@/features/worker/client";
import type { LibraryItem } from "@/features/worker/types";

function durationLabel(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Recently added" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function LibraryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const prefs = await getPreferences();
      setOutputDir(prefs.outputDir);
      const result = await runWorker<{ items: LibraryItem[] }>({ operation: "list_items", output_dir: prefs.outputDir });
      setItems(result.items ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the generated library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">YOUR PRACTICE LIBRARY</p>
          <h1>Good to see you.</h1>
          <p className="page-subtitle">Your drumless mixes, ready when you are.</p>
        </div>
        <Button className="action-button" onClick={() => navigate("/generate")}>
          <Plus size={16} /> Generate new
        </Button>
      </div>

      <div className="library-toolbar">
        <span>{loading ? "Scanning your library…" : `${items.length} ${items.length === 1 ? "track" : "tracks"}`}</span>
        <button className="secondary-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      {error && <div className="inline-error">{error}</div>}

      {loading && items.length === 0 ? (
        <div className="surface empty-state"><LoaderCircle className="animate-spin" size={24} color="#b9f36b" /><p className="page-subtitle">Looking for generated tracks…</p></div>
      ) : items.length === 0 ? (
        <div className="surface empty-state">
          <div className="empty-icon"><Disc3 size={26} /></div>
          <h2>Your first practice mix starts here.</h2>
          <p>Choose a local audio file or paste a YouTube link. MakeItDrumless will split the song into stems and keep everything in your local library.</p>
          <Button className="action-button" onClick={() => navigate("/generate")}><Plus size={15} /> Generate your first mix</Button>
        </div>
      ) : (
        <div className="item-list">
          {items.map((item) => {
            return (
              <button className="item-card text-left" key={item.id} onClick={() => navigate(`/play/${encodeURIComponent(item.id)}`)}>
                <div className="item-art" aria-hidden="true"><Disc3 size={21} strokeWidth={1.6} /></div>
                <div className="min-w-0">
                  <div className="item-title">{item.title}</div>
                  <div className="item-artist">{item.artist || `${item.model} · ${dateLabel(item.created_at)}`}</div>
                </div>
                <div className="item-meta"><span className="status-pill">{item.model}</span><div className="mt-2">{dateLabel(item.created_at)}</div></div>
                <div className="flex items-center gap-4"><span className="item-length">{durationLabel(item.duration)}</span><ArrowUpRight size={15} color="#7d838d" /></div>
              </button>
            );
          })}
        </div>
      )}
      <div className="kicker mt-5 truncate" title={outputDir}>Library folder · {outputDir}</div>
    </section>
  );
}

export const Component = LibraryPage;
