import { open } from "@tauri-apps/plugin-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Check, FolderOpen, KeyRound, LoaderCircle, Music2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getPreferences, savePreferences, type Preferences, type ShortcutMap } from "@/features/settings/preferences";
import { runWorker } from "@/features/worker/client";
import type { ModelPreset } from "@/features/worker/types";

const previewModels: ModelPreset[] = [
  { id: "scnet_large_starrytong", name: "SCNet Large Starrytong", architecture: "SCNet", stems: ["vocals", "bass", "drums", "other"], description: "High quality all-round separation. SDR 9.70.", is_default: true, downloaded: false },
  { id: "scnet_xl", name: "SCNet XL", architecture: "SCNet", stems: ["vocals", "bass", "drums", "other"], description: "Highest-quality SCNet preset. SDR 10.08.", is_default: false, downloaded: false },
  { id: "bs_roformer", name: "Band-Split RoFormer", architecture: "BS-RoFormer", stems: ["vocals", "bass", "drums", "other"], description: "Transformer-based four-stem demixing. SDR 9.65.", is_default: false, downloaded: false },
  { id: "bs_mega_53stem_drums", name: "BS Mega Drums", architecture: "BS-RoFormer", stems: ["drums", "other"], description: "53-stem source model focused on drum extraction.", is_default: false, downloaded: false },
  { id: "htdemucs4_6s", name: "HTDemucs 6-stem", architecture: "HTDemucs", stems: ["vocals", "bass", "drums", "other", "piano", "guitar"], description: "Six-stem hybrid transformer separation.", is_default: false, downloaded: false },
];
const shortcutNames: Array<[keyof ShortcutMap, string]> = [["toggle", "Play / pause"], ["restart", "Start over"], ["back", "Back 10 seconds"], ["forward", "Forward 10 seconds"]];

function prettyKey(code: string) {
  return code.replace(/^Key/, "").replace(/^Arrow/, "").replace("Space", "Space");
}

export function SettingsPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [models, setModels] = useState<ModelPreset[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [hasAuthHeaders, setHasAuthHeaders] = useState(false);
  const [authConfigured, setAuthConfigured] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [recording, setRecording] = useState<keyof ShortcutMap | null>(null);
  const [saving, setSaving] = useState(false);
  const headerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const value = await getPreferences();
      if (active) setPrefs(value);
      if (isTauri()) {
        try {
          const catalog = await runWorker<{ models: ModelPreset[] }>({ operation: "list_models" });
          if (active) setModels(catalog.models);
        } catch (reason) {
          if (active) setError(reason instanceof Error ? reason.message : "Could not load model presets.");
        }
        try {
          await runWorker({ operation: "validate_ytmusic" });
          if (active) setAuthConfigured(true);
        } catch {
          if (active) setAuthConfigured(false);
        }
      } else if (active) {
        setModels(previewModels);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(event.code)) return;
      if (!prefs) return;
      const duplicate = Object.entries(prefs.shortcuts).find(([action, code]) => action !== recording && code === event.code);
      if (duplicate) setError(`${prettyKey(event.code)} is already assigned to ${shortcutNames.find(([key]) => key === duplicate[0])?.[1]}.`);
      else {
        const next = { ...prefs, shortcuts: { ...prefs.shortcuts, [recording]: event.code } };
        setPrefs(next);
        setError("");
        void savePreferences(next);
      }
      setRecording(null);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [recording, prefs]);

  const update = async (next: Preferences) => {
    setPrefs(next);
    setSaving(true);
    try { await savePreferences(next); setMessage("Settings saved."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save settings."); }
    finally { setSaving(false); window.setTimeout(() => setMessage(""), 2200); }
  };

  const chooseOutput = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Choose MakeItDrumless library folder" });
      if (typeof selected === "string" && prefs) {
        if (isTauri()) await invoke("set_library_root", { path: selected });
        await update({ ...prefs, outputDir: selected });
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not choose the library folder."); }
  };

  const configureAuth = async () => {
    setError(""); setMessage(""); setAuthBusy(true);
    try {
      const headers = headerRef.current?.value ?? "";
      await runWorker({ operation: "configure_ytmusic", headers });
      setAuthConfigured(true); setHasAuthHeaders(false);
      if (headerRef.current) headerRef.current.value = "";
      setMessage("YouTube Music connected. Your credentials are stored in the system credential store.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not validate YouTube Music credentials."); }
    finally { setAuthBusy(false); }
  };

  const clearAuth = async () => {
    try { await runWorker({ operation: "clear_ytmusic" }); setAuthConfigured(false); setMessage("YouTube Music credentials removed."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not remove credentials."); }
  };

  if (!prefs) return <section className="page"><LoaderCircle className="animate-spin" color="#b9f36b" /></section>;

  return (
    <section className="page">
      <div className="page-header">
        <div><p className="eyebrow">MAKE IT YOURS</p><h1>Settings</h1><p className="page-subtitle">Choose where your mixes live and how you want to work.</p></div>
        {saving && <span className="kicker">Saving…</span>}
      </div>
      {error && <div className="inline-error">{error}</div>}
      {message && <div className="inline-success">{message}</div>}
      <div className="settings-grid">
        <div className="surface settings-card wide">
          <h2 className="settings-title">Library folder</h2>
          <p className="settings-description">Generated songs are saved here and this folder is scanned for existing MakeItDrumless items. Changing the folder does not move previous files.</p>
          <div className="folder-row"><div className="folder-path" title={prefs.outputDir}>{prefs.outputDir}</div><Button className="secondary-button" onClick={() => void chooseOutput()}><FolderOpen size={14} /> Choose folder</Button></div>
        </div>

        <div className="surface settings-card wide">
          <h2 className="settings-title">Model preset</h2>
          <p className="settings-description">Choose the default model for new generations. Stem tracks vary by preset.</p>
          <div className="model-list">
            {models.map((model) => (
              <button key={model.id} className={`model-option ${prefs.model === model.id ? "selected" : ""}`} onClick={() => void update({ ...prefs, model: model.id })}>
                <span className="model-name"><span>{model.name}{model.is_default ? <span className="ml-2 text-[9px] text-[#a7d477]">DEFAULT</span> : null}</span><span className="flex items-center gap-2 text-[9px] font-normal text-[#9da2aa]">{model.downloaded ? "Downloaded" : "Downloads on first use"}{prefs.model === model.id && <Check size={13} color="#b9f36b" />}</span></span>
                <div className="model-tags">{model.architecture} · {model.stems.join(" · ")}</div>
                <div className="model-description">{model.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="surface settings-card">
          <h2 className="settings-title">Playback shortcuts</h2>
          <p className="settings-description">Click a key and press the shortcut you want. These only apply on the playback page.</p>
          <div className="shortcut-list">
            {shortcutNames.map(([key, label]) => <div className="shortcut-row" key={key}><span>{label}</span><button className={`shortcut-capture ${recording === key ? "recording" : ""}`} onClick={() => { setError(""); setRecording(key); }}>{recording === key ? "Press a key…" : prettyKey(prefs.shortcuts[key])}</button></div>)}
          </div>
          <p className="form-hint">Text fields keep their normal typing behavior. MIDI key mapping is planned for a later update.</p>
        </div>

        <div className="surface settings-card">
          <h2 className="settings-title">YouTube Music</h2>
          <p className="settings-description">Use the browser request headers from your signed-in YouTube Music session. Credentials stay in the operating system’s credential store.</p>
          <div className={`mb-4 flex items-center gap-2 text-[10px] ${authConfigured ? "text-[#c5e6a0]" : "text-[#a3a7b0]"}`}>
            {authConfigured ? <ShieldCheck size={14} /> : <KeyRound size={14} />}{authConfigured ? "Connected and validated" : "Not configured"}
          </div>
          {!authConfigured && <>
            <div className="mb-3 rounded-lg border border-[#30343b] bg-[#121418] p-3 text-[10px] leading-relaxed text-[#a8adb5]">In YouTube Music, open Developer Tools → Network, copy the request headers for a `browse` or `next` request, then paste them below.</div>
            <label className="label" htmlFor="yt-headers">Browser request headers</label>
            <textarea ref={headerRef} id="yt-headers" className="text-area" onChange={(event) => setHasAuthHeaders(Boolean(event.target.value))} placeholder="Paste request headers here…" autoComplete="off" />
            <div className="mt-3"><Button className="secondary-button" disabled={authBusy || !hasAuthHeaders} onClick={() => void configureAuth()}>{authBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Music2 size={13} />} Validate and save</Button></div>
          </>}
          {authConfigured && <Button className="secondary-button" onClick={() => void clearAuth()}>Disconnect YouTube Music</Button>}
        </div>
      </div>
    </section>
  );
}

export const Component = SettingsPage;
