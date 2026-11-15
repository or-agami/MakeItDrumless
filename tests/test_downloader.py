"""Tests for audio download setup."""
from __future__ import annotations

import tempfile
import unittest
from unittest.mock import patch

from makeitdrumless.audio import downloader


class DownloadAudioTests(unittest.TestCase):
    def test_passes_resolved_ffmpeg_path_to_yt_dlp(self) -> None:
        info = {"title": "Test Track", "uploader": "Test Artist"}
        ffmpeg_path = "/bundled/tools/ffmpeg"
        download_options: dict[str, object] = {}

        class FakeYoutubeDL:
            def __init__(self, options: dict[str, object]) -> None:
                if "postprocessors" in options:
                    download_options.update(options)

            def __enter__(self) -> "FakeYoutubeDL":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def extract_info(self, link: str, download: bool = False) -> dict[str, str]:
                return info

        with tempfile.TemporaryDirectory() as output_dir:
            with (
                patch.object(downloader, "YoutubeDL", FakeYoutubeDL),
                patch("makeitdrumless.ffmpeg.manager.setup_ffmpeg_binary", return_value=ffmpeg_path),
                patch.object(downloader, "spinner"),
            ):
                downloader.download_audio("https://example.com/watch?v=test", output_dir)

        self.assertEqual(download_options["ffmpeg_location"], ffmpeg_path)


if __name__ == "__main__":
    unittest.main()
