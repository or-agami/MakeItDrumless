import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WorkerEvent, WorkerRequest } from "./types";

type WorkerEnvelope = { job_id: string; event: WorkerEvent };

export async function runWorker<T>(
  request: WorkerRequest,
  onEvent?: (event: WorkerEvent) => void,
  onJobId?: (jobId: string) => void
): Promise<T> {
  if (!isTauri()) throw new Error("Processing is available in the installed desktop app.");
  const jobId = crypto.randomUUID();
  onJobId?.(jobId);
  const unlisten = await listen<WorkerEnvelope>("makeitdrumless-worker", ({ payload }) => {
    if (payload.job_id === jobId) onEvent?.(payload.event);
  });
  try {
    return await invoke<T>("run_worker", { jobId, request });
  } catch (reason) {
    if (reason instanceof Error) throw reason;
    throw new Error(typeof reason === "string" ? reason : "The MakeItDrumless worker failed.");
  } finally {
    unlisten();
    onJobId?.("");
  }
}

export async function cancelWorker(jobId: string) {
  if (isTauri() && jobId) await invoke("cancel_worker", { jobId });
}
