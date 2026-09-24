"""Eco-Heal: doctor untuk ekosistem OpenCode.

Modes:
  diagnose  - scan + report, no changes (safe anytime)
  heal      - wait for OpenCode.exe exit, backup, repair known-safe catalog
  auto      - heal if desktop not running, diagnose if running (for scheduled task)

Usage:
  python eco-heal.py --mode diagnose
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import time

APPDATA_DIR = os.path.join(os.environ["APPDATA"], "ai.opencode.desktop")
DATA_DIR = os.path.join(os.environ["USERPROFILE"], ".local", "share", "opencode")
BACKUP_DIR = os.path.join(os.environ["TEMP"], "opencode-rca-backup")
DB_PATH = os.path.join(DATA_DIR, "opencode.db")
GLOBAL_DAT = os.path.join(APPDATA_DIR, "opencode.global.dat")
FALLBACK_WORKTREE = os.environ.get("OPENCODE_WORKSPACE_ROOT", os.getcwd())
REPORT_PATH = os.path.join(BACKUP_DIR, "eco-heal-report.json")


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    with open(os.path.join(BACKUP_DIR, "eco-heal.log"), "a", encoding="utf-8") as f:
        f.write(line + "\n")


def opencode_desktop_running():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq OpenCode.exe"],
        capture_output=True, text=True,
    ).stdout
    return "OpenCode.exe" in out


def wait_for_exit(timeout_s=240):
    log("waiting for OpenCode.exe to exit...")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not opencode_desktop_running():
            time.sleep(5)
            log("desktop closed, proceeding")
            return True
        time.sleep(2)
    log("TIMEOUT waiting for desktop exit, aborting heal")
    return False


def path_exists(p):
    if not p:
        return False
    drive = p[:2] if len(p) > 1 and p[1] == ":" else None
    try:
        return os.path.isdir(p) or os.path.isfile(p)
    except (ValueError, OSError):
        return False


def backup(src):
    if not os.path.exists(src):
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dst = os.path.join(BACKUP_DIR, os.path.basename(src) + ".heal-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(src, dst)
    return dst


def find_dead_paths():
    """Collect all dead paths referenced by DB and dat files."""
    dead = set()
    findings = {"db_project": [], "db_project_directory": [], "dat_files": []}

    if os.path.exists(DB_PATH):
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
        cur.execute("SELECT id, worktree, sandboxes FROM project")
        for pid, worktree, sandboxes in cur.fetchall():
            if worktree and worktree != "/" and not path_exists(worktree):
                dead.add(worktree)
                findings["db_project"].append({"id": pid, "worktree": worktree})
            try:
                sb_list = json.loads(sandboxes) if sandboxes else []
            except (TypeError, json.JSONDecodeError):
                sb_list = []
            for sb in sb_list:
                if sb and not path_exists(sb):
                    dead.add(sb)
                    findings["db_project"].append({"id": pid, "sandbox": sb})
        cur.execute("SELECT project_id, directory FROM project_directory")
        for pid, directory in cur.fetchall():
            if directory and not path_exists(directory):
                dead.add(directory)
                findings["db_project_directory"].append({"project_id": pid, "directory": directory})
        con.close()

    for name in os.listdir(APPDATA_DIR):
        if not (name.startswith("opencode.workspace.") or name.startswith("opencode.window.")):
            continue
        if not name.endswith(".dat"):
            continue
        full = os.path.join(APPDATA_DIR, name)
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError:
            continue
        hits = [d for d in dead if d.replace("/", "\\") in content or d in content]
        if hits:
            findings["dat_files"].append({"file": name, "dead_refs": hits})
    return dead, findings


def repair_db(dead, changes):
    if not dead:
        return
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT id, worktree FROM project")
    for pid, worktree in cur.fetchall():
        if worktree in dead:
            cur.execute(
                "UPDATE project SET worktree = ?, time_updated = ? WHERE id = ?",
                (FALLBACK_WORKTREE, int(time.time() * 1000), pid),
            )
            changes.append(f"project.worktree re-pointed: {worktree} -> {FALLBACK_WORKTREE} (id={pid[:12]})")
        cur.execute("SELECT sandboxes FROM project WHERE id = ?", (pid,))
        row = cur.fetchone()
        if row and row[0]:
            try:
                sb_list = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                sb_list = []
            kept = [s for s in sb_list if s not in dead]
            if kept != sb_list:
                cur.execute("UPDATE project SET sandboxes = ? WHERE id = ?", (json.dumps(kept), pid))
                changes.append(f"sandboxes cleaned for project {pid[:12]}: removed {len(sb_list) - len(kept)}")
    cur.execute("SELECT project_id, directory FROM project_directory")
    for pid, directory in cur.fetchall():
        if directory in dead:
            cur.execute(
                "DELETE FROM project_directory WHERE project_id = ? AND directory = ?",
                (pid, directory),
            )
            changes.append(f"project_directory deleted: {directory} (project {pid[:12]})")
    con.commit()
    con.close()


def repair_dat_files(findings, changes):
    for entry in findings["dat_files"]:
        full = os.path.join(APPDATA_DIR, entry["file"])
        if backup(full):
            os.remove(full)
            changes.append(f"stale dat removed: {entry['file']}")


def repair_global_dat(changes):
    if not os.path.exists(GLOBAL_DAT):
        return
    with open(GLOBAL_DAT, "r", encoding="utf-8") as f:
        lines = f.read().split("\n")
    changed = False
    for i, ln in enumerate(lines):
        if '"server":' not in ln:
            continue
        start = ln.index('"server":')
        tail = ln[start + len('"server":'):]
        # extract current lastProject value
        if f"lastProject" in tail and FALLBACK_WORKTREE.replace("/", "\\") not in tail:
            import re
            m = re.search(r'\\"lastProject\\":{\\"local\\":\\"(.*?)\\"}', tail)
            if m and not path_exists(m.group(1).replace("\\\\", "\\")):
                new_tail = tail.replace(m.group(1), FALLBACK_WORKTREE.replace("/", "\\\\"))
                lines[i] = ln[:start + len('"server":')] + new_tail
                changed = True
                changes.append(f"global.dat lastProject: {m.group(1)} -> {FALLBACK_WORKTREE}")
    if changed:
        backup(GLOBAL_DAT)
        with open(GLOBAL_DAT, "w", encoding="utf-8", newline="") as f:
            f.write("\n".join(lines))


def clean_local_storage(findings, changes):
    if not findings["dat_files"]:
        return
    ls = os.path.join(APPDATA_DIR, "Local Storage", "leveldb")
    if not os.path.isdir(ls):
        return
    removed = 0
    for name in os.listdir(ls):
        if name.endswith((".log", ".ldb")):
            backup(os.path.join(ls, name))
            try:
                os.remove(os.path.join(ls, name))
                removed += 1
            except OSError as e:
                log(f"cannot remove {name}: {e}")
    if removed:
        changes.append(f"localStorage leveldb cleaned: {removed} files (app was closed)")


def diagnose():
    dead, findings = find_dead_paths()
    report = {
        "mode": "diagnose",
        "desktop_running": opencode_desktop_running(),
        "dead_paths": sorted(dead),
        "findings": findings,
        "healthy": not dead and not findings["dat_files"],
    }
    os.makedirs(BACKUP_DIR, exist_ok=True)
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    log(f"dead paths: {len(dead)} | dat stale: {len(findings['dat_files'])} | healthy: {report['healthy']}")
    log(f"report: {REPORT_PATH}")
    return report


def heal():
    if opencode_desktop_running():
        if not wait_for_exit():
            return {"mode": "heal", "aborted": True}
    dead, findings = find_dead_paths()
    changes = []
    if dead or findings["dat_files"]:
        backup(DB_PATH)
        backup(GLOBAL_DAT)
        repair_db(dead, changes)
        repair_dat_files(findings, changes)
        repair_global_dat(changes)
        clean_local_storage(findings, changes)
    log(f"heal done, changes: {len(changes)}")
    for c in changes:
        log(f"  - {c}")
    return {"mode": "heal", "changes": changes, "dead_paths": sorted(dead)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["diagnose", "heal", "auto"], default="diagnose")
    args = ap.parse_args()
    mode = args.mode
    if mode == "auto":
        mode = "diagnose" if opencode_desktop_running() else "heal"
        log(f"auto -> {mode}")
    result = diagnose() if mode == "diagnose" else heal()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
