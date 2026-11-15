import { isTauri } from "@tauri-apps/api/core";
import { audioDir, join } from "@tauri-apps/api/path";
import { load } from "@tauri-apps/plugin-store";

export type ShortcutMap = {
  toggle: string;
  restart: string;
  back: string;
  forward: string;
};

export type Preferences = {
  outputDir: string;
  model: string;
  shortcuts: ShortcutMap;
};

const defaults: Omit<Preferences, "outputDir"> = {
  model: "scnet_large_starrytong",
  shortcuts: {
    toggle: "Space",
    restart: "Home",
    back: "ArrowLeft",
    forward: "ArrowRight",
  },
};

let storePromise: ReturnType<typeof load> | null = null;
async function getStore() {
  if (!isTauri()) return null;
  storePromise ??= load("settings.json", { autoSave: true });
  return storePromise;
}

export async function getDefaultOutputDir() {
  if (!isTauri()) return "~/Music/MakeItDrumless";
  return join(await audioDir(), "MakeItDrumless");
}

export async function getPreferences(): Promise<Preferences> {
  const store = await getStore();
  const defaultOutputDir = await getDefaultOutputDir();
  if (!store) {
    const saved = localStorage.getItem("makeitdrumless-preferences");
    return saved ? { ...JSON.parse(saved), shortcuts: { ...defaults.shortcuts, ...JSON.parse(saved).shortcuts } } : { outputDir: defaultOutputDir, ...defaults };
  }
  return {
    outputDir: (await store.get<string>("outputDir")) ?? defaultOutputDir,
    model: (await store.get<string>("model")) ?? defaults.model,
    shortcuts: { ...defaults.shortcuts, ...((await store.get<Partial<ShortcutMap>>("shortcuts")) ?? {}) },
  };
}

export async function savePreferences(prefs: Preferences) {
  const store = await getStore();
  if (!store) {
    localStorage.setItem("makeitdrumless-preferences", JSON.stringify(prefs));
    return;
  }
  await store.set("outputDir", prefs.outputDir);
  await store.set("model", prefs.model);
  await store.set("shortcuts", prefs.shortcuts);
  await store.save();
}
