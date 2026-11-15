"""Build platform-specific CLI, worker, and FFmpeg sidecars."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_COLLECT_ALL = (
    "torch", "torchaudio", "librosa", "scipy", "soundfile", "timm",
    "torchmetrics", "ml_collections", "omegaconf", "einops",
    "rotary_embedding_torch", "julius", "beartype", "matplotlib",
    "yt_dlp", "ytmusicapi", "keyring", "utils", "models",
)
WORKER_COLLECT_ALL = ("numpy", "soundfile", "mutagen", "ytmusicapi", "requests", "keyring")
KEYRING_HIDDEN_IMPORTS = (
    "keyring.backends.macOS", "keyring.backends.Windows",
    "keyring.backends.SecretService",
)

def build_one(entry: str, name: str, build_root: Path, collect_all: tuple[str, ...], hidden_imports: tuple[str, ...]) -> Path:
    dist = build_root / name / "dist"
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--onefile", "--console", "--name", name, "--paths", str(ROOT / "src"),
        "--distpath", str(dist), "--specpath", str(build_root / name / "spec"),
        "--workpath", str(build_root / name / "work"),
    ]
    for package in collect_all:
        command.extend(["--collect-all", package])
    for module in hidden_imports:
        command.extend(["--hidden-import", module])
    command.append(str(ROOT / "scripts" / entry))
    subprocess.run(command, cwd=ROOT, check=True)
    extension = ".exe" if os.name == "nt" else ""
    return dist / f"{name}{extension}"

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-triple", required=True)
    args = parser.parse_args()
    binaries = ROOT / "desktop" / "src-tauri" / "binaries"
    binaries.mkdir(parents=True, exist_ok=True)
    build_root = ROOT / "build" / "desktop-sidecar" / args.target_triple
    if build_root.exists():
        shutil.rmtree(build_root)
    extension = ".exe" if os.name == "nt" else ""

    cli = build_one("desktop_entry.py", "makeitdrumless", build_root, CLI_COLLECT_ALL, KEYRING_HIDDEN_IMPORTS + (
        "makeitdrumless.gui_worker", "utils.settings", "utils.model_utils", "utils.audio_utils",
    ))
    worker = build_one("desktop_worker_entry.py", "makeitdrumless-worker", build_root, WORKER_COLLECT_ALL, KEYRING_HIDDEN_IMPORTS)
    cli_target = binaries / f"makeitdrumless-{args.target_triple}{extension}"
    worker_target = binaries / f"makeitdrumless-worker-{args.target_triple}{extension}"
    shutil.copy2(cli, cli_target)
    shutil.copy2(worker, worker_target)

    import imageio_ffmpeg
    ffmpeg_source = Path(imageio_ffmpeg.get_ffmpeg_exe())
    ffmpeg_target = binaries / f"makeitdrumless-ffmpeg-{args.target_triple}{extension}"
    shutil.copy2(ffmpeg_source, ffmpeg_target)
    if os.name != "nt":
        for executable in (cli_target, worker_target, ffmpeg_target):
            executable.chmod(0o755)
    print(f"Built sidecars: {worker_target}, {cli_target}, and {ffmpeg_target}")

if __name__ == "__main__":
    main()
