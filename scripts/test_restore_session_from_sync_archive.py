#!/usr/bin/env python3
"""Unit tests for scripts/restore-session-from-sync-archive.py.

Runs with stdlib only:
    python3 scripts/test_restore_session_from_sync_archive.py

Covers:
  - reconstruct() round-trip on a synthetic sync-archive.db + session.json
    (verifies the JSON file the script writes survives a parse-back)
  - bootstrap_vessel() against a mock daemon HTTP server: success, count
    mismatch, transport failure, and HTTP error responses
"""

import contextlib
import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def _load_script_module():
    """Import the hyphen-named script as a module via importlib."""
    here = Path(__file__).resolve().parent
    path = here / "restore-session-from-sync-archive.py"
    spec = importlib.util.spec_from_file_location("restore_script", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


restore_script = _load_script_module()


def _seed_workspace(workspace_root: Path, profile: str, session_id: str,
                    messages, context_messages, system_prompt, ts=1700000000) -> int:
    """Create a synthetic sync-archive.db + session.json under workspace_root.
    Returns the event_id of the seeded sync_event."""
    profile_dir = workspace_root / "profiles" / profile / "sidecar-state"
    sessions_dir = profile_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    db_path = profile_dir / "sync-archive.db"
    db = sqlite3.connect(str(db_path))
    try:
        db.execute(
            "CREATE TABLE sync_blobs (cid TEXT PRIMARY KEY, bytes BLOB NOT NULL)"
        )
        db.execute(
            "CREATE TABLE sync_events ("
            "  event_id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  ts INTEGER NOT NULL,"
            "  session_id TEXT NOT NULL,"
            "  origin TEXT,"
            "  message_count INTEGER NOT NULL,"
            "  context_message_count INTEGER NOT NULL,"
            "  message_cids TEXT NOT NULL,"
            "  context_cids TEXT NOT NULL,"
            "  system_prompt_cid TEXT"
            ")"
        )

        def insert_blob(obj, suffix: str) -> str:
            payload = json.dumps(obj).encode("utf-8")
            cid = f"cid-{suffix}"
            db.execute(
                "INSERT INTO sync_blobs (cid, bytes) VALUES (?, ?)",
                (cid, payload),
            )
            return cid

        msg_cids = [insert_blob(m, f"m{i}") for i, m in enumerate(messages)]
        ctx_cids = [insert_blob(m, f"c{i}") for i, m in enumerate(context_messages)]
        sp_cid = None
        if system_prompt:
            sp_cid = insert_blob(system_prompt, "sp")

        cur = db.execute(
            "INSERT INTO sync_events (ts, session_id, origin, message_count, "
            "  context_message_count, message_cids, context_cids, system_prompt_cid) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ts,
                session_id,
                "ai-turn",
                len(messages),
                len(context_messages),
                json.dumps(msg_cids),
                json.dumps(ctx_cids),
                sp_cid,
            ),
        )
        db.commit()
        event_id = cur.lastrowid
    finally:
        db.close()

    # Seed the existing session.json with a SMALL bootstrap-only array — this
    # is the exact wedge state: 19 disk messages, sidecar has lots more in
    # archive, restore needs to expand the disk file back to the archive size.
    session_file = sessions_dir / f"{session_id}.json"
    session_file.write_text(json.dumps({
        "messages": [{"role": "user", "content": "bootstrap"}],
        "context": {
            "systemPrompt": "",
            "messages": [],
            "tools": [{"name": "preserved-tool"}],
        },
        "timestamp": ts - 1000,
    }))
    return event_id


class ReconstructTests(unittest.TestCase):
    def test_round_trip_writes_messages_back(self):
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
            {"role": "user", "content": "again"},
        ]
        context_messages = [
            {"role": "system-recap", "content": "summary"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            event_id = _seed_workspace(
                ws, "vega", "session_abc", messages, context_messages,
                system_prompt="you are a vessel",
            )

            result = restore_script.reconstruct(
                workspace_root=ws,
                profile="vega",
                session_id="session_abc",
                event_id=event_id,
                dry_run=False,
            )
            self.assertEqual(result["message_count"], 3)
            self.assertEqual(result["context_message_count"], 1)

            written = json.loads(
                (ws / "profiles" / "vega" / "sidecar-state" / "sessions"
                    / "session_abc.json").read_text()
            )
            self.assertEqual(written["messages"], messages)
            self.assertEqual(written["context"]["systemPrompt"], "you are a vessel")
            # tools preserved from the pre-restore file
            self.assertEqual(
                written["context"]["tools"], [{"name": "preserved-tool"}],
            )

    def test_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            event_id = _seed_workspace(
                ws, "vega", "session_abc",
                messages=[{"role": "user", "content": "x"}],
                context_messages=[], system_prompt="",
            )
            session_file = (
                ws / "profiles" / "vega" / "sidecar-state" / "sessions"
                / "session_abc.json"
            )
            before = session_file.read_text()
            restore_script.reconstruct(
                workspace_root=ws, profile="vega", session_id="session_abc",
                event_id=event_id, dry_run=True,
            )
            self.assertEqual(session_file.read_text(), before)

    def test_session_id_mismatch_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            event_id = _seed_workspace(
                ws, "vega", "session_abc",
                messages=[{"role": "user", "content": "x"}],
                context_messages=[], system_prompt="",
            )
            # The sessions/session_other.json file must exist for the script
            # to even consider running — refusing to create from scratch is
            # part of the gate. Seed a second empty session file.
            other = (
                ws / "profiles" / "vega" / "sidecar-state" / "sessions"
                / "session_other.json"
            )
            other.write_text(json.dumps({
                "messages": [], "context": {"systemPrompt": "", "messages": []},
            }))
            with self.assertRaisesRegex(RuntimeError, "session_id"):
                restore_script.reconstruct(
                    workspace_root=ws, profile="vega", session_id="session_other",
                    event_id=event_id, dry_run=False,
                )


class _MockDaemonHandler(BaseHTTPRequestHandler):
    # Test seam: each test patches RESPONSE before starting the server.
    RESPONSE = {"status": 200, "body": {"ok": True, "messageCount": 0}}
    LAST_PATH = None
    LAST_QUERY = None

    def log_message(self, *args, **kwargs):  # silence default stderr logs
        return

    def do_POST(self):  # noqa: N802 — http.server API
        type(self).LAST_PATH = self.path.split("?")[0]
        type(self).LAST_QUERY = (
            self.path.split("?", 1)[1] if "?" in self.path else ""
        )
        spec = type(self).RESPONSE
        status = spec.get("status", 200)
        body = spec.get("body", {})
        raw = json.dumps(body).encode("utf-8") if isinstance(body, (dict, list)) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@contextlib.contextmanager
def _mock_daemon(response):
    _MockDaemonHandler.RESPONSE = response
    _MockDaemonHandler.LAST_PATH = None
    _MockDaemonHandler.LAST_QUERY = None
    server = HTTPServer(("127.0.0.1", 0), _MockDaemonHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}", _MockDaemonHandler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


class BootstrapVesselTests(unittest.TestCase):
    def test_success_returns_body_and_hits_correct_url(self):
        with _mock_daemon({"status": 200, "body": {"ok": True, "messageCount": 168}}) as (url, handler):
            body = restore_script.bootstrap_vessel(
                profile="vega", daemon_url=url, expected_message_count=168,
            )
            self.assertEqual(body, {"ok": True, "messageCount": 168})
            self.assertEqual(handler.LAST_PATH, "/bootstrap-vessel")
            self.assertEqual(handler.LAST_QUERY, "profile=vega")

    def test_count_mismatch_raises(self):
        with _mock_daemon({"status": 200, "body": {"ok": True, "messageCount": 19}}) as (url, _):
            with self.assertRaisesRegex(restore_script.BootstrapError, "mismatch"):
                restore_script.bootstrap_vessel(
                    profile="vega", daemon_url=url, expected_message_count=168,
                )

    def test_http_error_raises(self):
        with _mock_daemon({"status": 500, "body": {"error": "boom"}}) as (url, _):
            with self.assertRaisesRegex(restore_script.BootstrapError, "HTTP 500"):
                restore_script.bootstrap_vessel(
                    profile="vega", daemon_url=url, expected_message_count=168,
                )

    def test_transport_failure_raises(self):
        # Bind a server then immediately close it so the port is dead.
        server = HTTPServer(("127.0.0.1", 0), _MockDaemonHandler)
        host, port = server.server_address
        server.server_close()
        with self.assertRaisesRegex(restore_script.BootstrapError, "unreachable"):
            restore_script.bootstrap_vessel(
                profile="vega",
                daemon_url=f"http://{host}:{port}",
                expected_message_count=1,
                timeout=2.0,
            )

    def test_malformed_json_body_raises(self):
        with _mock_daemon({"status": 200, "body": "not-json"}) as (url, _):
            with self.assertRaisesRegex(restore_script.BootstrapError, "non-JSON"):
                restore_script.bootstrap_vessel(
                    profile="vega", daemon_url=url, expected_message_count=1,
                )

    def test_url_with_trailing_slash_normalized(self):
        with _mock_daemon({"status": 200, "body": {"messageCount": 1}}) as (url, handler):
            restore_script.bootstrap_vessel(
                profile="vega", daemon_url=url + "/", expected_message_count=1,
            )
            self.assertEqual(handler.LAST_PATH, "/bootstrap-vessel")


if __name__ == "__main__":
    unittest.main()
