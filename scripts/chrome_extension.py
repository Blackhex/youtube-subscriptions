"""Developer tooling for the unpacked Chrome extension in ``extension/``.

Chrome never re-reads an unpacked extension from disk on its own, so after
editing ``extension/`` the developer keeps running a stale build - old version,
and any newly declared permission simply is not granted.

The primary signal is Chrome's service-worker script cache
(``<profile>/Service Worker/ScriptCache``): those cache entries hold the source
text of the worker Chrome actually registered, so comparing them against
``extension/background.js`` gives a definite verdict. A stale worker survives a
full browser restart - only the Reload arrow on the extension card (or Remove +
Load unpacked) replaces it.

The opposite failure mode is an extension loaded over the DevTools Protocol
(``Extensions.loadUnpacked``, what the chrome-devtools MCP server's
``install_extension`` uses): that install is session-scoped, never written to the
profile's ``Preferences``/``Secure Preferences``, and gone the moment Chrome
closes. Only a manual Load unpacked (or a policy/Web Store install) persists, so
a "not installed" verdict right after a successful CDP install is correct.

The version/permission reading from each profile's ``Secure Preferences`` is
kept as secondary context. Chrome writes that file lazily, so while the browser
is running the reading is reported as unverified - the extension card on
``chrome://extensions`` is the authoritative value.

  python scripts/chrome_extension.py status   report loaded vs on-disk state
  python scripts/chrome_extension.py reload   report, then open the extension card

There is no supported way to reload an unpacked extension in an already-running
Chrome from the command line: ``--load-extension`` only applies to a brand-new
browser instance with its own ``--user-data-dir`` (and is disabled in Chrome 137+
without an extra feature flag), which would not carry the developer's real
profile data. The only working fixes are the Reload button on
``chrome://extensions`` or a full Chrome restart.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_DIR = os.path.join(REPO_ROOT, "extension")
MANIFEST_PATH = os.path.join(EXTENSION_DIR, "manifest.json")

LOCATION_UNPACKED = 4

# With the browser running, preferences are flushed lazily, so the file can lag
# arbitrarily. When liveness cannot be determined, a file untouched this long is
# taken as evidence that nothing is writing it.
IDLE_SECONDS = 300

SCRIPT_CACHE_SUBDIR = os.path.join("Service Worker", "ScriptCache")
MARKER_MIN_LENGTH = 12
FRESHNESS_MARKER_COUNT = 6
IDENTITY_MARKER_COUNT = 12
# Cache entries are small; anything huge is some other blob and not worth reading.
MAX_CACHE_ENTRY_BYTES = 32 * 1024 * 1024

# Identifiers long enough to pass the length filter yet common to any extension
# or web worker, so they say nothing about *which* build is cached.
GENERIC_TOKENS = frozenset(
    {
        "addEventListener",
        "removeEventListener",
        "XMLHttpRequest",
        "getPlatformInfo",
        "setBadgeBackgroundColor",
        "setBadgeTextColor",
        "clearInterval",
        "clearTimeout",
        "createObjectURL",
        "decodeURIComponent",
        "encodeURIComponent",
        "getOwnPropertyNames",
        "hasOwnProperty",
        "lastModified",
        "onbeforeunload",
        "queueMicrotask",
        "readAsArrayBuffer",
        "requestAnimationFrame",
        "toLocaleDateString",
        "toLocaleString",
        "toLocaleTimeString",
        "toISOString",
        "unhandledrejection",
        "documentElement",
        "getBoundingClientRect",
        "contentDocument",
        "application/json",
        "Content-Type",
        "undefined",
    }
)


def compute_extension_id(path: str) -> str:
    """Chrome derives an unpacked extension ID from the absolute folder path.

    The path is hashed as UTF-16-LE (Chrome hashes the native wide string on
    Windows), and each of the first 32 hex digits is remapped into a-p.
    """
    digest = hashlib.sha256(path.encode("utf-16-le")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def normalize(path: str) -> str:
    return os.path.normcase(os.path.normpath(path.replace("/", os.sep)))


def read_manifest() -> dict:
    if not os.path.isdir(EXTENSION_DIR):
        raise SystemExit(f"Extension folder not found: {EXTENSION_DIR}")
    if not os.path.isfile(MANIFEST_PATH):
        raise SystemExit(f"Manifest not found: {MANIFEST_PATH}")
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Could not read {MANIFEST_PATH}: {exc}") from exc


def source_tokens(text: str) -> set[str]:
    """Long JS identifiers and identifier-like literals found in ``text``."""
    pattern = r"[A-Za-z_$][A-Za-z0-9_$]{%d,}" % (MARKER_MIN_LENGTH - 1)
    return {tok for tok in re.findall(pattern, text) if tok not in GENERIC_TOKENS}


def derive_markers(manifest: dict, warnings: list[str]) -> tuple[list[str], list[str]]:
    """Byte markers derived from the on-disk service worker, never hard-coded.

    Hard-coded identifiers would silently stop detecting anything the next time
    the worker is rewritten, so both sets are computed from the sources:

    * freshness markers - the longest distinctive identifiers in the worker,
      minus a stoplist of generic Web/Chrome API names. All of them must appear
      in the cached bytes for the registered worker to count as current.
    * identity markers - distinctive identifiers the worker shares with the
      extension's other scripts. Those are the cross-file protocol constants,
      which an older build of the worker almost certainly also contained, so
      they attribute a cache entry to this extension even when it is stale.

    Limitation: the markers prove the cached script contains those identifiers,
    not that it is byte-identical. An edit that introduces no new distinctive
    long identifier can still read as current.
    """
    worker_name = (manifest.get("background") or {}).get("service_worker")
    if not isinstance(worker_name, str) or not worker_name:
        warnings.append("manifest declares no background.service_worker; skipped cache check")
        return [], []

    worker_path = os.path.join(EXTENSION_DIR, worker_name.replace("/", os.sep))
    try:
        with open(worker_path, "r", encoding="utf-8", errors="replace") as fh:
            worker_source = fh.read()
    except OSError as exc:
        warnings.append(f"could not read {worker_path}: {exc}; skipped cache check")
        return [], []

    worker_tokens = source_tokens(worker_source)
    if not worker_tokens:
        warnings.append(f"no distinctive identifiers in {worker_name}; skipped cache check")
        return [], []

    sibling_tokens: set[str] = set()
    try:
        entries = sorted(os.listdir(EXTENSION_DIR))
    except OSError:
        entries = []
    for name in entries:
        if not name.endswith(".js") or normalize(name) == normalize(worker_name):
            continue
        try:
            with open(os.path.join(EXTENSION_DIR, name), "r", encoding="utf-8", errors="replace") as fh:
                sibling_tokens |= source_tokens(fh.read())
        except OSError as exc:
            warnings.append(f"skipped {name}: {exc}")

    def rank(tokens: set[str]) -> list[str]:
        return sorted(tokens, key=lambda tok: (-len(tok), tok))

    freshness = rank(worker_tokens)[:FRESHNESS_MARKER_COUNT]
    identity = rank(worker_tokens & sibling_tokens)[:IDENTITY_MARKER_COUNT]
    return freshness, identity


def blob_contains(blob: bytes, text: str) -> bool:
    """Cache entries are opaque, so match raw bytes without assuming a format."""
    for encoding in ("utf-8", "utf-16-le"):
        try:
            if text.encode(encoding) in blob:
                return True
        except UnicodeError:
            continue
    return False


def read_script_cache(profile: str, warnings: list[str]) -> dict[str, dict] | None:
    """Cache entries grouped by cache key. ``None`` when the directory is absent.

    Chrome stores one resource as sibling files ``<key>_0`` (headers) and
    ``<key>_1`` (body), so entries are grouped by the shared key and searched as
    a unit.
    """
    cache_dir = os.path.join(profile, SCRIPT_CACHE_SUBDIR)
    if not os.path.isdir(cache_dir):
        return None

    groups: dict[str, dict] = {}
    try:
        names = sorted(os.listdir(cache_dir))
    except OSError as exc:
        warnings.append(f"skipped {cache_dir}: {exc}")
        return None

    for name in names:
        path = os.path.join(cache_dir, name)
        try:
            stat = os.stat(path)
        except OSError as exc:
            warnings.append(f"skipped {path}: {exc}")
            continue
        if not os.path.isfile(path) or stat.st_size > MAX_CACHE_ENTRY_BYTES:
            continue
        try:
            with open(path, "rb") as fh:
                blob = fh.read()
        except OSError as exc:
            # Chrome may hold the entry open exclusively; report and move on.
            warnings.append(f"skipped {path}: {exc}")
            continue
        key = name.rsplit("_", 1)[0] if "_" in name else name
        group = groups.setdefault(key, {"key": key, "blobs": [], "size": 0, "mtime": 0.0})
        group["blobs"].append(blob)
        group["size"] += stat.st_size
        group["mtime"] = max(group["mtime"], stat.st_mtime)
    return groups


def inspect_script_cache(
    profile: str,
    ext_id: str,
    freshness: list[str],
    identity: list[str],
    warnings: list[str],
) -> dict | None:
    """Compare the cached worker source against the on-disk one.

    ``None`` means no verdict: no cache directory, no markers, or no entry that
    can be attributed to this extension.
    """
    if not freshness:
        return None
    groups = read_script_cache(profile, warnings)
    if not groups:
        return None

    attribution = list(dict.fromkeys(identity + freshness))
    matches: list[dict] = []
    for group in groups.values():
        blobs = group["blobs"]
        # The URL lives in the header entry, the source in the body entry, so a
        # cache key belongs to this extension if any of its files mentions it.
        owned = any(blob_contains(blob, ext_id) for blob in blobs) or any(
            blob_contains(blob, marker) for marker in attribution for blob in blobs
        )
        if not owned:
            continue
        present = [m for m in freshness if any(blob_contains(blob, m) for blob in blobs)]
        matches.append(
            {
                "key": group["key"],
                "size": group["size"],
                "mtime": group["mtime"],
                "present": present,
                "missing": [m for m in freshness if m not in present],
            }
        )

    if not matches:
        return None
    # importScripts() resources get their own cache keys and legitimately lack
    # the worker's markers, so the best-matching entry decides the verdict.
    matches.sort(key=lambda m: (len(m["present"]), m["mtime"]), reverse=True)
    best = matches[0]
    return {
        "best": best,
        "entries": len(matches),
        "total": len(freshness),
        "stale": bool(best["missing"]),
    }


def browser_roots() -> list[tuple[str, str]]:
    """Candidate (browser label, user data dir) pairs for this platform."""
    system = platform.system()
    candidates: list[tuple[str, str]] = []

    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            candidates += [
                ("Chrome", os.path.join(local, "Google", "Chrome", "User Data")),
                ("Chrome Beta", os.path.join(local, "Google", "Chrome Beta", "User Data")),
                ("Chromium", os.path.join(local, "Chromium", "User Data")),
            ]
    elif system == "Darwin":
        base = os.path.expanduser("~/Library/Application Support")
        candidates += [
            ("Chrome", os.path.join(base, "Google", "Chrome")),
            ("Chrome Beta", os.path.join(base, "Google", "Chrome Beta")),
            ("Chromium", os.path.join(base, "Chromium")),
        ]
    else:
        base = os.path.expanduser("~/.config")
        candidates += [
            ("Chrome", os.path.join(base, "google-chrome")),
            ("Chrome Beta", os.path.join(base, "google-chrome-beta")),
            ("Chromium", os.path.join(base, "chromium")),
        ]

    return [(label, root) for label, root in candidates if os.path.isdir(root)]


def profile_dirs(root: str) -> list[str]:
    """Profile directories under a user data dir, identified by a prefs file."""
    found = []
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return found
    for name in entries:
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        if os.path.isfile(os.path.join(path, "Secure Preferences")) or os.path.isfile(
            os.path.join(path, "Preferences")
        ):
            found.append(path)
    return found


def browser_is_running(root: str) -> bool | None:
    """Whether a browser holds this user data dir. ``None`` when undecidable."""
    if platform.system() == "Windows":
        lock = os.path.join(root, "lockfile")
        if not os.path.exists(lock):
            return False
        try:
            fd = os.open(lock, os.O_RDWR)
        except PermissionError:
            # Chrome keeps the lock file open without sharing write access.
            return True
        except OSError:
            return None
        os.close(fd)
        return False

    lock = os.path.join(root, "SingletonLock")
    try:
        target = os.readlink(lock)
    except OSError:
        return False if not os.path.exists(lock) else None
    host, _, pid = target.rpartition("-")
    if host and host != socket.gethostname():
        return None
    try:
        os.kill(int(pid), 0)
    except (ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def prefs_mtime(profile: str) -> float | None:
    """Newest modification time across a profile's preference files."""
    stamps = []
    for filename in ("Preferences", "Secure Preferences"):
        try:
            stamps.append(os.path.getmtime(os.path.join(profile, filename)))
        except OSError:
            continue
    return max(stamps) if stamps else None


def format_time(stamp: float | None) -> str:
    if stamp is None:
        return "unknown"
    return datetime.datetime.fromtimestamp(stamp).strftime("%Y-%m-%d %H:%M:%S")


def load_extension_settings(profile: str, warnings: list[str]) -> dict:
    """Merged ``extensions.settings`` from a profile's preference files."""
    settings: dict = {}
    for filename in ("Preferences", "Secure Preferences"):
        path = os.path.join(profile, filename)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            warnings.append(f"skipped {path}: {exc}")
            continue
        entries = data.get("extensions", {}).get("settings")
        if isinstance(entries, dict):
            settings.update(entries)
    return settings


def find_installations() -> tuple[list[dict], list[str]]:
    """Locate every profile that has this extension folder registered."""
    target = normalize(EXTENSION_DIR)
    results: list[dict] = []
    warnings: list[str] = []

    now = datetime.datetime.now().timestamp()
    for label, root in browser_roots():
        running = browser_is_running(root)
        for profile in profile_dirs(root):
            settings = load_extension_settings(profile, warnings)
            mtime = prefs_mtime(profile)
            idle = mtime is not None and (now - mtime) > IDLE_SECONDS
            # Chrome flushes preferences lazily, so the reading is only
            # trustworthy once the browser has stopped writing the file.
            trusted = running is False or (running is None and idle)
            for entry_id, entry in settings.items():
                if not isinstance(entry, dict):
                    continue
                path = entry.get("path")
                if not isinstance(path, str):
                    continue
                # Unpacked entries store an absolute path; packed ones store a
                # relative folder inside the profile, which never matches.
                if normalize(path) != target:
                    continue
                granted = entry.get("granted_permissions") or {}
                sw_info = entry.get("service_worker_registration_info") or {}
                results.append(
                    {
                        "browser": label,
                        "profile": os.path.basename(profile),
                        "profile_path": profile,
                        "id": entry_id,
                        "unpacked": entry.get("location") == LOCATION_UNPACKED,
                        "version": sw_info.get("version")
                        or (entry.get("manifest") or {}).get("version"),
                        "api": list(granted.get("api") or []),
                        "hosts": list(granted.get("scriptable_host") or []),
                        "mtime": mtime,
                        "running": running,
                        "trusted": trusted,
                    }
                )
    return results, warnings


def print_load_unpacked_steps() -> None:
    print("  1. Open chrome://extensions")
    print("  2. Turn on Developer mode (top right)")
    print("  3. Click 'Load unpacked' and select:")
    print(f"     {EXTENSION_DIR}")


def report_status() -> tuple[int, str, bool]:
    """Print the status report. Returns (exit code, extension id, installed)."""
    manifest = read_manifest()
    disk_version = str(manifest.get("version", "?"))
    disk_permissions = [p for p in manifest.get("permissions", []) if isinstance(p, str)]
    ext_id = compute_extension_id(EXTENSION_DIR)

    print(f"Extension folder : {EXTENSION_DIR}")
    print(f"Extension ID     : {ext_id}")
    print(f"On-disk version  : {disk_version}")
    print(f"On-disk perms    : {', '.join(disk_permissions) or '(none)'}")
    print()

    installations, warnings = find_installations()
    freshness, identity = derive_markers(manifest, warnings)
    for warning in warnings:
        print(f"WARNING: {warning}")
    if warnings:
        print()

    if not installations:
        print("Not installed: no Chrome profile has this folder loaded as an extension.")
        print_load_unpacked_steps()
        return 1, ext_id, False

    stale_worker = False
    confirmed_stale = False
    unverified = False
    for inst in installations:
        loaded = inst["version"] or "unknown"
        kind = "unpacked" if inst["unpacked"] else "packed"
        trusted = inst["trusted"]
        print(f"{inst['browser']} / {inst['profile']} ({kind})")
        print(f"  id             : {inst['id']}")

        cache_warnings: list[str] = []
        verdict = inspect_script_cache(
            inst["profile_path"], inst["id"], freshness, identity, cache_warnings
        )
        for warning in cache_warnings:
            print(f"  WARNING        : {warning}")

        if verdict:
            best = verdict["best"]
            found = len(best["present"])
            print(f"  worker cache   : {best['key']} ({best['size']} bytes, {format_time(best['mtime'])})")
            print(f"  worker markers : {found}/{verdict['total']} present")
            if verdict["stale"]:
                stale_worker = True
                print("  STALE SERVICE WORKER:")
                print(f"    missing from the registered worker: {', '.join(best['missing'])}")
                print("    Chrome has an older background.js registered for this extension.")
                print("    A stale worker survives a full browser restart - restarting Chrome")
                print("    does NOT replace it.")
                print("    (An extension loaded over the DevTools Protocol / MCP is the opposite")
                print("     case: it is session-scoped and does not survive a restart at all.)")
                print("    Fix: click the circular Reload arrow on the extension card at")
                print(f"      chrome://extensions/?id={ext_id}")
                print("    If Reload does not take, use Remove, then Load unpacked:")
                print(f"      {EXTENSION_DIR}")
            else:
                print("  registered worker matches extension/background.js")
        else:
            print("  worker cache   : no entry attributable to this extension")
            print("                   (falling back to the preferences reading below)")

        if trusted:
            print(f"  loaded version : {loaded}")
        else:
            print(f"  loaded version : {loaded}  (possibly stale reading)")
            print(f"  prefs written  : {format_time(inst['mtime'])}")
        print(f"  granted api    : {', '.join(inst['api']) or '(none)'}")
        print(f"  granted hosts  : {', '.join(inst['hosts']) or '(none)'}")

        missing = [p for p in disk_permissions if p not in inst["api"]]
        version_drift = loaded != disk_version
        prefs_drift = bool(version_drift or missing)
        if prefs_drift:
            if trusted:
                confirmed_stale = True
                print("  STALE (preferences):")
            else:
                unverified = True
                print("  POSSIBLY STALE (preferences, unverified):")
            if version_drift:
                print(f"    version {loaded} loaded, {disk_version} on disk")
            if missing:
                print(f"    permissions not granted: {', '.join(missing)}")
            if not trusted:
                print("    Chrome writes this file lazily (on a timer and at shutdown), so a")
                print("    running browser may already have a newer build loaded.")
                print("    Confirm: open chrome://extensions, enable Developer mode, and read")
                print("    the version on the extension's card - that value is authoritative.")
        elif trusted:
            print("  preferences up to date")
        else:
            print("  preferences match on-disk build (reading unverified)")

        if verdict and verdict["stale"] != prefs_drift:
            print("  NOTE: the two signals disagree - the script-cache verdict above is the")
            print("        conclusion, because it reads the worker source Chrome registered.")
        print()

    if stale_worker:
        print("Conclusion (from the service-worker script cache): a stale build is registered.")
    elif confirmed_stale or unverified:
        print("Conclusion (from preferences only): the loaded build may lag the on-disk one.")

    if stale_worker or confirmed_stale or unverified:
        print("Chrome does not re-read unpacked extensions from disk by itself.")
        print(f"  - open chrome://extensions/?id={ext_id} and click the circular Reload arrow")
        if not stale_worker:
            print("  - or restart Chrome (unpacked extensions are re-read at startup)")
        print("Then reload any open youtube.com tab so the new content script is injected.")

    if stale_worker:
        return 1, ext_id, True
    return (1 if confirmed_stale else 0), ext_id, True


def find_chrome() -> str | None:
    candidates = []
    if platform.system() == "Windows":
        for var in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                candidates.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    elif platform.system() == "Darwin":
        candidates.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    else:
        candidates += ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]

    for path in candidates:
        if os.path.isfile(path):
            return path
    return shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("chromium")


def do_reload() -> int:
    """Report status, then point the developer at the right action.

    The exit code reflects only whether the page could be surfaced - the
    staleness verdict belongs to ``status``, so a successful reload prompt does
    not fail the VS Code task.
    """
    _, ext_id, installed = report_status()
    # With no installation there is no card, so the id fragment resolves to
    # nothing and the whole Reload-arrow advice would be wrong.
    url = f"chrome://extensions/?id={ext_id}" if installed else "chrome://extensions"

    chrome = find_chrome()
    if chrome:
        try:
            subprocess.Popen([chrome, url], close_fds=True)
            print(f"Opened {url}")
        except OSError as exc:
            print(f"Could not launch Chrome ({exc}). Open manually: {url}")
    else:
        print(f"Chrome executable not found. Open manually: {url}")

    if not installed:
        print("There is no extension card yet, so there is nothing to reload. Do this now:")
        print("  1. Turn on Developer mode (top right) if it is off")
        print("  2. Click 'Load unpacked' and select:")
        print(f"     {EXTENSION_DIR}")
        print("  3. Reload any open youtube.com tab - the new content script is not")
        print("     injected into tabs that were already open")
        print("Note: an extension loaded over the DevTools Protocol / MCP is session-scoped")
        print("and disappears when Chrome closes; only Load unpacked persists.")
        return 0

    print("Opening the page does not reload the extension. Do this now:")
    print("  1. Turn on Developer mode (top right) if it is off")
    print("  2. Click the circular Reload arrow on the extension card")
    print("  3. Reload any open youtube.com tab - the new content script is not")
    print("     injected into tabs that were already open")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect and reload the unpacked Chrome extension in extension/."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="report the version/permissions Chrome actually loaded")
    sub.add_parser("reload", help="report status, then open the extension's card in Chrome")

    args = parser.parse_args()
    if args.command == "reload":
        return do_reload()
    return report_status()[0]


if __name__ == "__main__":
    sys.exit(main())
