#!/usr/bin/env python3
"""Reconstruct a wiped sidecar session.json from sync-archive blobs.

Used once on 2026-05-11 to restore Vega + Lume after the recovery sequence
overwrote their session.json files with bootstrap-only arrays. The blobs in
sync-archive.db are content-addressed and accumulated across every /sync, so
the full conversation can be reassembled by walking message_cids for a given
sync_event.

Usage:
  scripts/restore-session-from-sync-archive.py \
      --profile <name> \
      --session-id <session_*> \
      --event-id <N> \
      --workspace-root /path/to/workspace \
      [--dry-run] \
      [--no-bootstrap] \
      [--daemon-url http://127.0.0.1:9000]

The script:
  1. Opens workspace/profiles/<profile>/sidecar-state/sync-archive.db
  2. Reads the chosen sync_event by event_id
  3. Resolves message_cids and context_cids to blob bytes, parses as JSON
  4. Reads the existing session.json to preserve context.tools (not archived)
  5. Writes {messages, context, timestamp} back atomically (tmp + rename)
  6. (Default) POSTs http://127.0.0.1:9000/bootstrap-vessel?profile=<name>
     so the live vessel re-bootstraps from the restored disk state. Without
     this step, the vessel keeps producing small /sync arrays that get
     refused forever by the sidecar's shrink-guard (e1f8c86) — exactly the
     wedge that left Vega and Mirin isolated on 2026-05-11.
"""

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_blob(db: sqlite3.Connection, cid: str):
    row = db.execute("SELECT bytes FROM sync_blobs WHERE cid = ?", (cid,)).fetchone()
    if row is None:
        raise RuntimeError(f"missing blob for cid {cid}")
    return json.loads(row[0])


def reconstruct(workspace_root: Path, profile: str, session_id: str, event_id: int, dry_run: bool) -> dict:
    profile_dir = workspace_root / "profiles" / profile / "sidecar-state"
    db_path = profile_dir / "sync-archive.db"
    sessions_dir = profile_dir / "sessions"
    session_file = sessions_dir / f"{session_id}.json"

    if not db_path.exists():
        raise FileNotFoundError(db_path)
    if not session_file.exists():
        raise FileNotFoundError(f"existing session file {session_file} missing — refusing to create from scratch")

    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    try:
        ev = db.execute(
            "SELECT event_id, ts, session_id, origin, message_count, context_message_count, "
            "       message_cids, context_cids, system_prompt_cid "
            "FROM sync_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if ev is None:
            raise RuntimeError(f"sync_event {event_id} not found in {db_path}")
        if ev["session_id"] != session_id:
            raise RuntimeError(
                f"event {event_id} session_id {ev['session_id']!r} != expected {session_id!r}"
            )

        msg_cids = json.loads(ev["message_cids"])
        ctx_cids = json.loads(ev["context_cids"])
        messages = [load_blob(db, c) for c in msg_cids]
        context_messages = [load_blob(db, c) for c in ctx_cids]
        system_prompt = ""
        if ev["system_prompt_cid"]:
            sp = load_blob(db, ev["system_prompt_cid"])
            system_prompt = sp if isinstance(sp, str) else ""

        if len(messages) != ev["message_count"]:
            raise RuntimeError(
                f"message count mismatch: assembled {len(messages)} vs event {ev['message_count']}"
            )

        existing = json.loads(session_file.read_text())
        preserved_tools = (existing.get("context") or {}).get("tools")
        existing_system_prompt = (existing.get("context") or {}).get("systemPrompt") or ""

        if not system_prompt:
            system_prompt = existing_system_prompt

        new_state = {
            "messages": messages,
            "context": {
                "systemPrompt": system_prompt,
                "messages": context_messages,
                **({"tools": preserved_tools} if preserved_tools is not None else {}),
            },
            "timestamp": ev["ts"],
        }

        for m in messages:
            if not isinstance(m, dict) or "role" not in m or "content" not in m:
                raise RuntimeError(f"reconstructed message missing role/content: {m!r}")

        if dry_run:
            print(f"[dry-run] {profile}/{session_id}: would write {len(messages)} messages "
                  f"(context.messages={len(context_messages)}, ts={ev['ts']})")
        else:
            tmp = session_file.with_suffix(session_file.suffix + ".restore.tmp")
            tmp.write_text(json.dumps(new_state))
            os.replace(tmp, session_file)
            print(f"[restored] {profile}/{session_id}: wrote {len(messages)} messages "
                  f"(context.messages={len(context_messages)}, ts={ev['ts']})")

        return {
            "profile": profile,
            "session_id": session_id,
            "event_id": event_id,
            "message_count": len(messages),
            "context_message_count": len(context_messages),
            "ts": ev["ts"],
            "session_file": str(session_file),
        }
    finally:
        db.close()


class BootstrapError(RuntimeError):
    """Raised when the post-restore vessel bootstrap call fails."""


def bootstrap_vessel(
    profile: str,
    daemon_url: str,
    expected_message_count: int,
    timeout: float = 30.0,
) -> dict:
    """POST <daemon_url>/bootstrap-vessel?profile=<profile> and verify the
    response's messageCount matches expected_message_count. Returns the
    parsed response body on success; raises BootstrapError on transport
    failure, non-2xx, malformed body, or count mismatch.
    """
    qs = urllib.parse.urlencode({"profile": profile})
    url = f"{daemon_url.rstrip('/')}/bootstrap-vessel?{qs}"
    req = urllib.request.Request(
        url,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=b"",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise BootstrapError(
            f"daemon POST {url} returned HTTP {e.code}: {body[:200]}"
        ) from e
    except urllib.error.URLError as e:
        raise BootstrapError(
            f"daemon POST {url} unreachable: {e.reason}. Is the daemon "
            f"running on this machine? (`arianna-tui` boots it.)"
        ) from e

    with resp:
        raw = resp.read().decode("utf-8", errors="replace")
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as e:
        raise BootstrapError(
            f"daemon POST {url} returned non-JSON body: {raw[:200]}"
        ) from e

    actual = body.get("messageCount")
    if actual != expected_message_count:
        raise BootstrapError(
            f"vessel bootstrap message count mismatch: expected {expected_message_count} "
            f"(restored on disk), daemon reported {actual!r}. The vessel is now out "
            f"of sync with the restored session.json — check sidecar logs."
        )
    return body


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--profile", required=True)
    p.add_argument("--session-id", required=True)
    p.add_argument("--event-id", type=int, required=True)
    p.add_argument("--workspace-root", required=True, type=Path)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--no-bootstrap",
        action="store_true",
        help="Skip the post-write POST /bootstrap-vessel call to the daemon. "
             "Use only when the daemon/vessel stack is intentionally down — "
             "leaves the vessel out-of-sync with the restored session.",
    )
    p.add_argument(
        "--daemon-url",
        default="http://127.0.0.1:9000",
        help="Base URL of the arianna host daemon. Default: http://127.0.0.1:9000.",
    )
    args = p.parse_args()

    result = reconstruct(
        workspace_root=args.workspace_root,
        profile=args.profile,
        session_id=args.session_id,
        event_id=args.event_id,
        dry_run=args.dry_run,
    )

    if args.dry_run:
        result["bootstrap"] = {"skipped": True, "reason": "dry-run"}
    elif args.no_bootstrap:
        result["bootstrap"] = {"skipped": True, "reason": "--no-bootstrap"}
        print(
            f"[skip-bootstrap] {args.profile}/{args.session_id}: vessel NOT re-bootstrapped. "
            f"Run `curl -X POST '{args.daemon_url}/bootstrap-vessel?profile={args.profile}'` "
            f"manually before resuming.",
            file=sys.stderr,
        )
    else:
        try:
            boot = bootstrap_vessel(
                profile=args.profile,
                daemon_url=args.daemon_url,
                expected_message_count=result["message_count"],
            )
            result["bootstrap"] = {"ok": True, "messageCount": boot.get("messageCount")}
            print(
                f"[bootstrapped] {args.profile}/{args.session_id}: vessel re-bootstrapped "
                f"with {boot.get('messageCount')} messages"
            )
        except BootstrapError as e:
            result["bootstrap"] = {"ok": False, "error": str(e)}
            print(f"[bootstrap-failed] {e}", file=sys.stderr)
            print(json.dumps(result, indent=2))
            sys.exit(2)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
