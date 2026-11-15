"""Machine-readable worker interface used by the desktop app.

The worker reads one JSON request per line on stdin and writes JSON Lines events
on stdout. Human-oriented CLI output is always captured and never mixed into the
protocol stream.
"""
from __future__ import annotations

import hashlib
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SERVICE_NAME = "MakeItDrumless"
AUTH_ACCOUNT = "youtube-music-auth"
AUTH_CHUNK_BYTES = 1700
MANIFEST_NAME = ".makeitdrumless.json"
PEAKS_DIR = ".makeitdrumless/waveforms"
_RESULT_PREFIX = "__MAKEITDRUMLESS_RESULT__"
_CANCEL = threading.Event()
_ACTIVE_CHILD: subprocess.Popen[bytes] | None = None


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def _credential_store():
    try:
        import keyring
    except Exception as exc:
        raise RuntimeError("The system credential store is unavailable.") from exc
    return keyring


def _get_auth_json() -> str | None:
    keyring = _credential_store()
    stored = keyring.get_password(SERVICE_NAME, AUTH_ACCOUNT)
    if not stored or not stored.startswith("__chunks_v1__:"):
        return stored
    try:
        _, digest, count_text = stored.split(":", 2)
        count = int(count_text)
        if count < 1 or count > 100:
            raise ValueError
        prefix = f"{AUTH_ACCOUNT}.{digest}."
        raw = b"".join(
            base64.b64decode(keyring.get_password(SERVICE_NAME, prefix + str(index)) or "", validate=True)
            for index in range(count)
        )
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError
        return raw.decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError("Stored YouTube Music credentials could not be read. Disconnect and configure them again.") from exc


def _set_auth_json(auth_json: str) -> None:
    keyring = _credential_store()
    raw = auth_json.encode("utf-8")
    previous = keyring.get_password(SERVICE_NAME, AUTH_ACCOUNT) or ""
    previous_chunks: tuple[str, int] | None = None
    if previous.startswith("__chunks_v1__:"):
        try:
            _, old_digest, old_count = previous.split(":", 2)
            previous_chunks = (old_digest, int(old_count))
        except ValueError:
            previous_chunks = None

    if len(raw) <= AUTH_CHUNK_BYTES:
        keyring.set_password(SERVICE_NAME, AUTH_ACCOUNT, auth_json)
    else:
        digest = hashlib.sha256(raw).hexdigest()
        chunks = [raw[offset:offset + AUTH_CHUNK_BYTES] for offset in range(0, len(raw), AUTH_CHUNK_BYTES)]
        prefix = f"{AUTH_ACCOUNT}.{digest}."
        for index, chunk in enumerate(chunks):
            keyring.set_password(SERVICE_NAME, prefix + str(index), base64.b64encode(chunk).decode("ascii"))
        keyring.set_password(SERVICE_NAME, AUTH_ACCOUNT, f"__chunks_v1__:{digest}:{len(chunks)}")

    if previous_chunks:
        old_digest, old_count = previous_chunks
        if old_digest != hashlib.sha256(raw).hexdigest():
            for index in range(max(0, old_count)):
                try:
                    keyring.delete_password(SERVICE_NAME, f"{AUTH_ACCOUNT}.{old_digest}.{index}")
                except Exception:
                    pass


def _delete_auth_json() -> None:
    keyring = _credential_store()
    stored = keyring.get_password(SERVICE_NAME, AUTH_ACCOUNT) or ""
    chunks: tuple[str, int] | None = None
    if stored.startswith("__chunks_v1__:"):
        try:
            _, digest, count = stored.split(":", 2)
            chunks = (digest, int(count))
        except ValueError:
            chunks = None
    try:
        keyring.delete_password(SERVICE_NAME, AUTH_ACCOUNT)
    except Exception:
        pass
    if chunks:
        digest, count = chunks
        for index in range(max(0, count)):
            try:
                keyring.delete_password(SERVICE_NAME, f"{AUTH_ACCOUNT}.{digest}.{index}")
            except Exception:
                pass


def _auth_tempfile(auth_json: str) -> Path:
    fd, name = tempfile.mkstemp(prefix="makeitdrumless-auth-", suffix=".json")
    try:
        os.chmod(name, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(auth_json)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        Path(name).unlink(missing_ok=True)
        raise
    return Path(name)


def _get_duration(path: Path) -> float | None:
    try:
        if path.suffix.lower() == ".wav":
            import soundfile as sf
            return float(sf.info(str(path)).duration)
        from mutagen import File as MutagenFile
        audio = MutagenFile(path)
        if audio and audio.info:
            return float(audio.info.length)
    except Exception:
        return None
    return None


def _stems_for_dir(stems_dir: Path) -> list[dict[str, Any]]:
    tracks = []
    if stems_dir.is_dir():
        for path in sorted(stems_dir.glob("*.wav")):
            if path.is_file() and path.stat().st_size:
                tracks.append({"id": path.stem.lower().replace(" ", "_"), "name": path.stem, "path": str(path.resolve()), "duration": _get_duration(path)})
    return tracks


def scan_library(output_dir: str) -> list[dict[str, Any]]:
    root = Path(output_dir).expanduser().resolve()
    if not root.is_dir():
        return []

    items = []
    for folder in sorted((p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")), key=lambda p: p.stat().st_mtime, reverse=True):
        manifest_path = folder / MANIFEST_NAME
        manifest: dict[str, Any] = {}
        if manifest_path.is_file():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                manifest = {}

        drumless = folder / f"{folder.name} (Drumless).mp3"
        if not drumless.is_file():
            candidates = sorted(folder.glob("* (Drumless).mp3"))
            drumless = candidates[0] if candidates else Path()
        if not drumless or not drumless.is_file():
            # Legacy items are recognized by their separated stem folders too.
            if not any(p.is_dir() and p.name.startswith("stems_") for p in folder.iterdir()):
                continue

        stems_dirs = [p for p in folder.iterdir() if p.is_dir() and p.name.startswith("stems_")]
        selected_dir = None
        declared = manifest.get("stems_directory")
        if declared:
            candidate = (folder / declared).resolve()
            if candidate.is_dir() and candidate.parent == folder:
                selected_dir = candidate
        if selected_dir is None and stems_dirs:
            stems_dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            selected_dir = stems_dirs[0]

        stem_tracks = _stems_for_dir(selected_dir) if selected_dir else []
        tracks = []
        if drumless and drumless.is_file():
            tracks.append({"id": "no_drums", "name": "No drums", "path": str(drumless.resolve()), "duration": _get_duration(drumless), "kind": "mix"})
        for track in stem_tracks:
            track["kind"] = "stem"
            tracks.append(track)
        if not tracks:
            continue

        created = manifest.get("created_at")
        if not created:
            created = datetime.fromtimestamp(folder.stat().st_mtime, timezone.utc).isoformat()
        duration = next((t["duration"] for t in tracks if t["duration"] is not None), None)
        items.append({
            "id": str(folder.resolve()),
            "title": manifest.get("title") or folder.name,
            "artist": manifest.get("artist"),
            "path": str(folder.resolve()),
            "created_at": created,
            "model": manifest.get("model") or (selected_dir.name.removeprefix("stems_") if selected_dir else "Unknown"),
            "duration": duration,
            "drumless_path": str(drumless.resolve()) if drumless and drumless.is_file() else None,
            "stems_directory": str(selected_dir.resolve()) if selected_dir else None,
            "tracks": tracks,
            "upload_status": manifest.get("upload_status", "not_uploaded"),
        })
    return items


def _model_catalog() -> list[dict[str, Any]]:
    from makeitdrumless.msst_integration.models import MODEL_REGISTRY, is_model_downloaded
    return [
        {
            "id": name,
            "name": name.replace("_", " ").title(),
            "architecture": details.get("model_type", "Unknown"),
            "stems": details.get("stems", []),
            "description": details.get("description", ""),
            "is_default": bool(details.get("default")),
            "downloaded": is_model_downloaded(name),
        }
        for name, details in MODEL_REGISTRY.items()
    ]


def _detect_phase(line: str) -> tuple[str, str] | None:
    text = line.strip()
    checks = [
        (("Downloading audio", "Download"), ("downloading", "Downloading or preparing audio")),
        (("Converting", "Using local audio", "Using existing audio"), ("preparing", "Preparing input audio")),
        (("Downloading config", "Downloading model", "weights"), ("model", "Preparing model")),
        (("Running MSST Separation", "Separating stems", "Loading model"), ("separating", "Separating stems")),
        (("Mixing non-drum", "Single backing stem", "Mixing stems"), ("mixing", "Creating drumless mix")),
        (("Track Folder:",), ("finalizing", "Saving generated item")),
    ]
    for needles, phase in checks:
        if any(needle.lower() in text.lower() for needle in needles):
            return phase
    return None


def _cli_command(args: list[str]) -> list[str]:
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable).resolve()
        cli_name = "makeitdrumless.exe" if os.name == "nt" else "makeitdrumless"
        sibling = executable.with_name(cli_name)
        if not sibling.is_file():
            raise RuntimeError("The packaged MakeItDrumless CLI is missing beside the worker.")
        return [str(sibling), *args]

    cli = shutil.which("makeitdrumless")
    if cli:
        return [cli, *args]
    return [sys.executable, "-m", "makeitdrumless.main", *args]


def _run_cli(request: dict[str, Any]) -> dict[str, Any]:
    global _ACTIVE_CHILD
    source = request.get("source") or {}
    source_kind = source.get("kind")
    source_value = source.get("value")
    if source_kind not in ("file", "youtube") or not isinstance(source_value, str) or not source_value.strip():
        raise ValueError("Choose a local audio file or enter a YouTube link.")
    if source_kind == "file" and not Path(source_value).expanduser().is_file():
        raise FileNotFoundError("The selected audio file could not be found.")
    if source_kind == "youtube" and not re.match(r"^https?://", source_value.strip(), re.I):
        raise ValueError("Enter a valid YouTube URL beginning with http:// or https://.")

    model = str(request.get("model") or "scnet_large_starrytong")
    output_dir = str(Path(request.get("output_dir") or (Path.home() / "Music" / "MakeItDrumless")).expanduser().resolve())
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    cli_args = [source_value, "--model", model, "--output-dir", output_dir, "--_worker-result"]
    command = _cli_command(cli_args)
    emit("progress", phase="starting", message="Starting generation", percent=0)
    env = os.environ.copy()
    repo_root = Path(__file__).resolve().parents[2]
    package_src = str(repo_root / "src")
    env["PYTHONPATH"] = package_src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(repo_root), start_new_session=(os.name != "nt"), creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0))
    _ACTIVE_CHILD = child

    output_result: dict[str, Any] | None = None
    phase_now = None
    logs: list[str] = []
    queue: list[str | None] = []
    queue_cond = threading.Condition()

    def read_output() -> None:
        assert child.stdout is not None
        pending = bytearray()
        while True:
            data = os.read(child.stdout.fileno(), 4096)
            if not data:
                break
            pending.extend(data)
            while True:
                separator = next((index for index, byte in enumerate(pending) if byte in (10, 13)), None)
                if separator is None:
                    break
                line = bytes(pending[:separator]).decode("utf-8", errors="replace")
                del pending[:separator + 1]
                with queue_cond:
                    queue.append(line)
                    queue_cond.notify()
        if pending:
            with queue_cond:
                queue.append(bytes(pending).decode("utf-8", errors="replace"))
                queue_cond.notify()
        with queue_cond:
            queue.append(None)
            queue_cond.notify()

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    try:
        while True:
            if _CANCEL.is_set():
                if os.name != "nt":
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                else:
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    else:
                        child.kill()
                raise InterruptedError("Generation cancelled.")

            with queue_cond:
                if not queue and child.poll() is None:
                    queue_cond.wait(timeout=0.2)
                chunk = queue.pop(0) if queue else ""
            if chunk is None:
                break
            if not chunk:
                continue
            clean = chunk.strip()
            if clean.startswith(_RESULT_PREFIX):
                try:
                    output_result = json.loads(clean[len(_RESULT_PREFIX):])
                except json.JSONDecodeError:
                    pass
                continue
            if clean:
                logs.append(clean)
                if len(logs) > 40:
                    logs.pop(0)
                print(f"[makeitdrumless] {clean}", file=sys.stderr, flush=True)
            detected = _detect_phase(clean)
            if detected and detected[0] != phase_now:
                phase_now = detected[0]
                emit("progress", phase=phase_now, message=detected[1], percent=None)
            percent_match = re.search(r"(?<!\d)(\d{1,3}(?:\.\d+)?)\s*%", clean)
            if percent_match:
                value = float(percent_match.group(1))
                emit("progress", phase=phase_now or "processing", message=clean[:180], percent=round(value, 1))
        code = child.wait()
        reader.join(timeout=1)
        if code != 0:
            detail = next((line for line in reversed(logs) if "Fatal error" in line or "Error:" in line or "not found" in line.lower()), None)
            raise RuntimeError(detail or (logs[-1] if logs else "The processing CLI exited with an error."))
        if output_result is None:
            # Human-readable CLI summary remains intact; locate its item using the source-derived folder fallback.
            candidates = scan_library(output_dir)
            if not candidates:
                raise RuntimeError("Generation completed, but the CLI did not report a discoverable output item.")
            output_result = candidates[0]
        return output_result
    finally:
        _ACTIVE_CHILD = None


def _write_manifest(result: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    track_dir = Path(result["track_dir"]).resolve()
    stems_dir = Path(result["stems_dir"]).resolve()
    stems = result.get("stems", {})
    tracks = []
    drumless = Path(result["drumless_path"]).resolve()
    if not drumless.is_file():
        raise RuntimeError("The CLI completed without creating the drumless mix file.")
    if drumless.is_file():
        tracks.append({"id": "no_drums", "name": "No drums", "path": str(drumless), "duration": _get_duration(drumless), "kind": "mix"})
    for name, raw_path in stems.items():
        path = Path(raw_path).resolve()
        if path.is_file():
            tracks.append({"id": str(name).lower().replace(" ", "_"), "name": str(name), "path": str(path), "duration": _get_duration(path), "kind": "stem"})
    duration = next((track["duration"] for track in tracks if track["duration"] is not None), None)
    manifest = {
        "schema_version": 1,
        "title": result.get("title") or track_dir.name,
        "artist": result.get("artist"),
        "source": {"kind": request["source"]["kind"], "value": request["source"]["value"]},
        "model": result.get("model") or request.get("model"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "track_dir": str(track_dir),
        "drumless_path": str(drumless),
        "stems_directory": str(stems_dir),
        "duration": duration,
        "tracks": tracks,
        "upload_status": "not_uploaded",
    }
    path = track_dir / MANIFEST_NAME
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    return manifest


def _do_upload(audio_path: str) -> None:
    auth_json = _get_auth_json()
    if not auth_json:
        raise RuntimeError("YouTube Music is not configured. Add your browser request headers in Settings.")
    from makeitdrumless.ytmusic.uploader import upload_drumless_track
    auth_path = _auth_tempfile(auth_json)
    try:
        # Capture the CLI's user-facing uploader messages so stdout remains valid JSONL.
        from contextlib import redirect_stdout, redirect_stderr
        import io
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            if not upload_drumless_track(audio_path, auth_file=str(auth_path)):
                raise RuntimeError("YouTube Music did not accept the upload. Check the credentials and try again.")
    finally:
        auth_path.unlink(missing_ok=True)


def _configure_ytmusic(headers: str) -> None:
    if not headers.strip():
        raise ValueError("Paste the request headers copied from YouTube Music.")
    from ytmusicapi import YTMusic
    from ytmusicapi.setup import setup_browser
    auth_path = _auth_tempfile("")
    try:
        with auth_path.open("w", encoding="utf-8") as file:
            file.write("")
        from contextlib import redirect_stderr, redirect_stdout
        import io
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            setup_browser(filepath=str(auth_path), headers_raw=headers.strip())
            YTMusic(str(auth_path)).get_library_uploads(limit=1)
        auth_json = auth_path.read_text(encoding="utf-8")
        _set_auth_json(auth_json)
    finally:
        auth_path.unlink(missing_ok=True)


def _validate_ytmusic() -> None:
    auth_json = _get_auth_json()
    if not auth_json:
        raise RuntimeError("YouTube Music is not configured.")
    from ytmusicapi import YTMusic
    auth_path = _auth_tempfile(auth_json)
    try:
        from contextlib import redirect_stderr, redirect_stdout
        import io
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            YTMusic(str(auth_path)).get_library_uploads(limit=1)
    finally:
        auth_path.unlink(missing_ok=True)


def _peaks(request: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf

    item_dir = Path(request["item_path"]).resolve()
    track_path = Path(request["track_path"]).resolve()
    if not track_path.is_file() or item_dir not in track_path.parents:
        raise ValueError("The requested waveform is outside the selected library item.")
    points_per_second = max(1, min(120, int(request.get("points_per_second", 40))))
    stat = track_path.stat()
    cache_dir = item_dir / PEAKS_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha1(str(track_path).encode("utf-8")).hexdigest()[:12]
    cache_path = cache_dir / (re.sub(r"[^a-zA-Z0-9_-]+", "_", track_path.stem) + f"-{cache_key}.json")
    if cache_path.is_file():
        try:
            existing = json.loads(cache_path.read_text(encoding="utf-8"))
            if existing.get("size") == stat.st_size and existing.get("mtime_ns") == stat.st_mtime_ns:
                return existing["data"]
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    emit("progress", phase="waveform", message=f"Building waveform for {track_path.stem}", percent=0)
    peaks: list[float] = []
    duration: float
    sample_rate: int
    if track_path.suffix.lower() == ".wav":
        info = sf.info(str(track_path))
        duration, sample_rate = float(info.duration), int(info.samplerate)
        chunk_frames = max(1, int(sample_rate / points_per_second))
        with sf.SoundFile(str(track_path)) as audio:
            while True:
                block = audio.read(chunk_frames, dtype="float32", always_2d=True)
                if len(block) == 0:
                    break
                peaks.append(float(np.max(np.abs(block))))
                if len(peaks) % 200 == 0:
                    emit("progress", phase="waveform", message=f"Building waveform for {track_path.stem}", percent=min(99, round(audio.tell() / max(1, info.frames) * 100)))
    else:
        # Stream decoded mono PCM from ffmpeg so long MP3/M4A files never need
        # to be loaded into one large Python audio buffer.
        from mutagen import File as MutagenFile
        audio_info = MutagenFile(track_path)
        if not audio_info or not audio_info.info:
            raise RuntimeError(f"Could not read audio metadata for {track_path.name}.")
        duration = float(audio_info.info.length)
        sample_rate = 11025
        chunk_frames = max(1, int(sample_rate / points_per_second))
        from contextlib import redirect_stdout
        from makeitdrumless.ffmpeg.manager import setup_ffmpeg_binary
        with redirect_stdout(sys.stderr):
            ffmpeg_exe = setup_ffmpeg_binary()
        command = [ffmpeg_exe or "ffmpeg", "-v", "error", "-i", str(track_path), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "f32le", "pipe:1"]
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except FileNotFoundError as exc:
            raise RuntimeError("FFmpeg is required to build a waveform for this audio format.") from exc
        assert process.stdout is not None
        frames_done = 0
        chunk_bytes = chunk_frames * 4
        try:
            while True:
                block = process.stdout.read(chunk_bytes)
                if not block:
                    break
                usable = len(block) - (len(block) % 4)
                if usable:
                    samples = np.frombuffer(block[:usable], dtype="<f4")
                    peaks.append(float(np.max(np.abs(samples))))
                    frames_done += len(samples)
                    if len(peaks) % 200 == 0:
                        percent = min(99, round(frames_done / max(1, duration * sample_rate) * 100))
                        emit("progress", phase="waveform", message=f"Building waveform for {track_path.stem}", percent=percent)
            code = process.wait()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
        if code != 0:
            raise RuntimeError(f"FFmpeg could not decode {track_path.name}.")

    result = {"peaks": [peaks], "duration": duration, "sample_rate": sample_rate, "points_per_second": points_per_second}
    cache_path.write_text(json.dumps({"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "data": result}), encoding="utf-8")
    emit("progress", phase="waveform", message=f"Waveform ready for {track_path.stem}", percent=100)
    return result


def handle_request(request: dict[str, Any]) -> Any:
    operation = request.get("operation")
    if operation == "list_items":
        return {"items": scan_library(str(request.get("output_dir") or (Path.home() / "Music" / "MakeItDrumless")))}
    if operation == "list_models":
        return {"models": _model_catalog()}
    if operation == "generate":
        result = _run_cli(request)
        manifest = _write_manifest(result, request)
        upload_status = "not_requested"
        if request.get("upload_ytmusic"):
            emit("progress", phase="uploading", message="Uploading the drumless mix to YouTube Music", percent=None)
            try:
                _do_upload(manifest["drumless_path"])
                upload_status = "uploaded"
            except Exception as exc:
                upload_status = "failed"
                emit("warning", phase="upload", message=str(exc))
            manifest["upload_status"] = upload_status
            (Path(result["track_dir"]) / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        item = next((item for item in scan_library(str(request.get("output_dir"))) if item["path"] == str(Path(result["track_dir"]).resolve())), None)
        return {"item": item or manifest, "upload_status": upload_status}
    if operation == "waveform_peaks":
        return _peaks(request)
    if operation == "configure_ytmusic":
        _configure_ytmusic(str(request.get("headers") or ""))
        return {"configured": True}
    if operation == "validate_ytmusic":
        _validate_ytmusic()
        return {"configured": True, "valid": True}
    if operation == "clear_ytmusic":
        _delete_auth_json()
        return {"configured": False}
    if operation == "upload":
        _do_upload(str(request["audio_path"]))
        return {"uploaded": True}
    if operation == "cancel":
        _CANCEL.set()
        return {"cancelled": True}
    raise ValueError(f"Unknown worker operation: {operation}")


def _listen_for_cancel() -> None:
    """Accept a second JSON line while generation runs; only cancel is honored."""
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("operation") == "cancel":
            _CANCEL.set()
            return


def main() -> None:
    try:
        first_line = sys.stdin.readline()
        if not first_line:
            raise ValueError("Expected a JSON request on stdin.")
        request = json.loads(first_line)
        if request.get("operation") == "generate":
            threading.Thread(target=_listen_for_cancel, daemon=True).start()
        result = handle_request(request)
        emit("result", result=result)
    except InterruptedError as exc:
        emit("error", code="cancelled", message=str(exc))
        raise SystemExit(130)
    except Exception as exc:
        emit("error", code=type(exc).__name__, message=str(exc))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
