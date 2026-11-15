"""Tests for legacy-library compatibility and the desktop worker protocol."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from makeitdrumless import gui_worker
from makeitdrumless.gui_worker import MANIFEST_NAME, scan_library


class LibraryDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def _legacy_item(self, root: Path, title: str) -> Path:
        folder = root / title
        folder.mkdir(parents=True)
        (folder / f"{title} (Drumless).mp3").write_bytes(b"legacy audio")
        stems = folder / "stems_scnet_large_starrytong"
        stems.mkdir()
        (stems / "drums.wav").write_bytes(b"legacy wav")
        (stems / "vocals.wav").write_bytes(b"legacy wav")
        return folder

    def test_scans_legacy_cli_layout(self) -> None:
        folder = self._legacy_item(self.root, "Legacy Song")
        items = scan_library(str(self.root))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], str(folder.resolve()))
        self.assertEqual(items[0]["title"], "Legacy Song")
        self.assertEqual(items[0]["model"], "scnet_large_starrytong")
        self.assertEqual({track["id"] for track in items[0]["tracks"]}, {"no_drums", "drums", "vocals"})

    def test_scans_manifest_metadata_and_upload_status(self) -> None:
        folder = self._legacy_item(self.root, "Manifest Song")
        manifest = {
            "schema_version": 1,
            "title": "A Better Title",
            "artist": "The Artist",
            "model": "htdemucs4_6s",
            "created_at": "2025-01-02T03:04:05+00:00",
            "stems_directory": "stems_scnet_large_starrytong",
            "upload_status": "failed",
        }
        (folder / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        item = scan_library(str(self.root))[0]
        self.assertEqual(item["title"], "A Better Title")
        self.assertEqual(item["artist"], "The Artist")
        self.assertEqual(item["model"], "htdemucs4_6s")
        self.assertEqual(item["created_at"], manifest["created_at"])
        self.assertEqual(item["upload_status"], "failed")

    def test_output_roots_are_scanned_independently(self) -> None:
        other = self.root / "other-library"
        other.mkdir()
        self._legacy_item(self.root, "First Library Song")
        self._legacy_item(other, "Second Library Song")
        self.assertEqual([item["title"] for item in scan_library(str(self.root))], ["First Library Song"])
        self.assertEqual([item["title"] for item in scan_library(str(other))], ["Second Library Song"])


class WorkerProtocolTests(unittest.TestCase):
    def test_list_items_returns_one_jsonl_result(self) -> None:
        with tempfile.TemporaryDirectory() as output_dir:
            env = os.environ.copy()
            src = str(Path(__file__).resolve().parents[1] / "src")
            env["PYTHONPATH"] = src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
            request = {"operation": "list_items", "output_dir": output_dir}
            completed = subprocess.run(
                [sys.executable, "-m", "makeitdrumless.gui_worker"],
                input=json.dumps(request) + "\n",
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, "")
        lines = completed.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        event = json.loads(lines[0])
        self.assertEqual(event["type"], "result")
        self.assertEqual(event["result"], {"items": []})

    def test_cli_help_and_model_listing_stay_human_readable(self) -> None:
        env = os.environ.copy()
        src = str(Path(__file__).resolve().parents[1] / "src")
        env["PYTHONPATH"] = src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        help_result = subprocess.run([sys.executable, "-m", "makeitdrumless.main", "--help"], capture_output=True, text=True, env=env, check=False)
        list_result = subprocess.run([sys.executable, "-m", "makeitdrumless.main", "--list-models"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("YouTube URL or path to a local audio file", help_result.stdout)
        self.assertNotIn("_worker-result", help_result.stdout)
        self.assertEqual(list_result.returncode, 0, list_result.stderr)
        self.assertIn("scnet_large_starrytong", list_result.stdout)


class CredentialStorageTests(unittest.TestCase):
    def test_large_auth_bundle_round_trips_through_small_keyring_entries(self) -> None:
        class FakeKeyring:
            values: dict[tuple[str, str], str] = {}

            def get_password(self, service: str, account: str) -> str | None:
                return self.values.get((service, account))

            def set_password(self, service: str, account: str, value: str) -> None:
                self.values[(service, account)] = value

            def delete_password(self, service: str, account: str) -> None:
                del self.values[(service, account)]

        keyring = FakeKeyring()
        auth_json = '{"cookie":"' + ("c" * 9000) + '"}'
        with patch("makeitdrumless.gui_worker._credential_store", return_value=keyring):
            gui_worker._set_auth_json(auth_json)
            self.assertEqual(gui_worker._get_auth_json(), auth_json)
            self.assertTrue(all(len(value) <= 2300 for value in keyring.values.values()))
            gui_worker._delete_auth_json()
        self.assertEqual(keyring.values, {})


if __name__ == "__main__":
    unittest.main()
