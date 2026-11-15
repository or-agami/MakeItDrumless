export type StemTrack = {
  id: string;
  name: string;
  path: string;
  duration: number | null;
  kind?: "mix" | "stem";
};

export type LibraryItem = {
  id: string;
  title: string;
  artist?: string | null;
  path: string;
  created_at: string;
  model: string;
  duration: number | null;
  drumless_path?: string | null;
  stems_directory?: string | null;
  tracks: StemTrack[];
  upload_status?: string;
};

export type ModelPreset = {
  id: string;
  name: string;
  architecture: string;
  stems: string[];
  description: string;
  is_default: boolean;
  downloaded: boolean;
};

export type WorkerRequest = Record<string, unknown> & { operation: string };
export type WorkerEvent = {
  type: "progress" | "warning" | "error" | "result";
  phase?: string;
  message?: string;
  percent?: number | null;
  code?: string;
  result?: unknown;
};
