#!/usr/bin/env python3
"""Exercise the real packaged Tauri app using its native WebKit WebDriver."""
import argparse
import json
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("binary", type=Path)
parser.add_argument("--port", type=int, default=4444)
parser.add_argument("--output", type=Path, default=Path("test-results"))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
base = "http://127.0.0.1:" + str(args.port)
session = None

def request(method, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(base + path, data=body, method=method, headers={"Content-Type": "application/json"})
    try:
        result = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    value = result.get("value")
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(value)
    return value

def execute(script, *values):
    return request("POST", "/session/" + session + "/execute/sync", {"script": script, "args": list(values)})

def wait(expression, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if execute("return Boolean(" + expression + ")"):
            return
        time.sleep(0.1)
    state = execute("return {url:location.href,status:document.getElementById('status')?.textContent,error:document.getElementById('error-text')?.textContent,body:document.body.innerText.slice(0,500)}")
    raise AssertionError("Timed out waiting for " + expression + ": " + str(state))

def idle():
    wait("document.getElementById('app').getAttribute('aria-busy') === 'false'")

def element(selector):
    return request("POST", "/session/" + session + "/element", {"using": "css selector", "value": selector})["element-6066-11e4-a52e-4f735466cecf"]

def click(selector):
    request("POST", "/session/" + session + "/element/" + element(selector) + "/click", {})

def fill(selector, value):
    execute("const e=document.querySelector(arguments[0]); e.value=arguments[1]; e.dispatchEvent(new Event('input',{bubbles:true}));", selector, value)

def choose(selector, value):
    execute("const e=document.querySelector(arguments[0]); e.value=arguments[1]; e.dispatchEvent(new Event('change',{bubbles:true}));", selector, value)

def git(root, *values):
    result = subprocess.run(["git", "-C", str(root), *values], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.decode().strip()

with tempfile.TemporaryDirectory(prefix="gitgui-native-") as temporary:
    root = Path(temporary) / "repository"
    root.mkdir()
    git(root, "init", "-b", "main")
    for key, value in [("user.name", "Native Test"), ("user.email", "native@example.invalid"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false"), ("push.gpgsign", "false"), ("core.hooksPath", str(root / ".git/hooks"))]:
        git(root, "config", key, value)
    def commit(name, text, subject):
        (root / name).write_text(text)
        git(root, "add", "--", name)
        git(root, "commit", "-m", subject)
    commit("base.txt", "base\n", "Initialize repository")
    initial = git(root, "rev-parse", "HEAD")
    git(root, "switch", "-c", "feat/graph")
    for i, subject in enumerate(["Allocate lanes", "Connect merge parents", "Attach branch labels", "Keep lane colors stable"]):
        commit("graph.txt", str(i) + "\n", subject)
    git(root, "switch", "main")
    for i, subject in enumerate(["Open local repositories", "Read packed refs", "Load history in pages"]):
        commit("main.txt", str(i) + "\n", subject)
    git(root, "merge", "--no-ff", "feat/graph", "-m", "Merge branch graph")
    git(root, "tag", "-a", "v0.1", "-m", "preview")
    for branch, subjects in [("fix/credentials", ["Show authentication errors", "Preserve credentials"]), ("feat/diff", ["Read working changes", "Render unified diffs"]), ("release/preview", ["Prepare Linux package", "Bundle offline fonts"])]:
        git(root, "switch", "-c", branch, initial)
        for i, subject in enumerate(subjects):
            commit(branch.replace("/", "-") + ".txt", str(i) + "\n", subject)
    git(root, "switch", "main")
    remote = Path(temporary) / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    git(root, "remote", "add", "origin", str(remote))
    expected = int(git(root, "rev-list", "--all", "--count"))
    try:
        value = request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(args.binary.resolve()), "args": [str(root)]}}}})
        session = value["sessionId"]
        request("POST", "/session/" + session + "/timeouts", {"script": 30000, "implicit": 0})
        request("POST", "/session/" + session + "/window/rect", {"width": 1280, "height": 700})
        wait("document.getElementById('history-rows')?.children.length > 0")
        idle()
        assert execute("return document.getElementById('history-rows').children.length") == expected
        assert execute("return document.querySelectorAll('#graph [data-node]').length") == expected
        assert execute("return document.getElementById('details').open") is False
        wait("document.fonts.status === 'loaded'")
        assert execute("return [...document.fonts].some(f=>f.family==='Geist' && f.status==='loaded')")
        print("PASS native startup, real graph, offline fonts, hidden details", flush=True)
        assert execute("return !document.getElementById('branch-sidebar').hidden && document.getElementById('changes').hidden")
        assert execute("return document.querySelectorAll('#ref-list .ref-item').length === document.getElementById('scope').options.length")
        assert execute("return document.querySelector('.ref-head').parentElement.textContent.includes('main')")
        assert execute("const side=document.getElementById('branch-sidebar').getBoundingClientRect(); const graph=document.getElementById('history').getBoundingClientRect(); return side.right <= graph.left && Math.abs(side.height-graph.height)<1")
        graph_branch = execute("return [...document.getElementById('scope').options].find(o=>o.textContent==='feat/graph').value")
        click('#ref-list .ref-item[data-scope="' + graph_branch + '"]'); idle()
        assert execute("return document.getElementById('history-rows').children.length") == 5
        assert execute("return document.getElementById('scope').value") == graph_branch
        assert execute("return document.activeElement.dataset.scope") == graph_branch
        assert execute("return document.querySelectorAll('#ref-list .ref-item').length === document.getElementById('scope').options.length")
        click('#ref-list .ref-item[data-scope=""]'); idle()
        assert execute("return document.getElementById('history-rows').children.length") == expected
        choose('#scope', graph_branch); idle()
        assert execute("return document.querySelector('#ref-list [aria-pressed=true]').dataset.scope") == graph_branch
        click('#ref-list .ref-item[data-scope=""]'); idle()
        click('#history-rows tr:first-child button.subject')
        print("PASS persistent branches, full-height graph, shared filters, and sidebar keyboard focus", flush=True)
        click("#details-button"); wait("document.getElementById('details').open"); idle()
        assert execute("return document.getElementById('detail-parent').options.length") == 2
        execute("document.getElementById('details').close()")
        (root / "stage-only.txt").write_text("staged from native UI\n")
        (root / "leave-untracked.txt").write_text("must stay untracked\n")
        click("#refresh"); idle(); click("#changes-button")
        execute("const rows=[...document.querySelectorAll('.file-row')]; const row=rows.find(r=>r.textContent.includes('stage-only.txt')); row.querySelector('input').click()")
        click('[data-stage-group="unstaged"]'); idle()
        assert execute("return document.getElementById('staged-count').textContent") == "1 staged file"
        fill("#summary", "Native staged-only commit")
        click("#commit-button"); idle()
        assert git(root, "log", "-1", "--format=%s") == "Native staged-only commit"
        assert git(root, "show", "HEAD:stage-only.txt") == "staged from native UI"
        assert "leave-untracked.txt" not in git(root, "ls-tree", "--name-only", "HEAD")
        assert execute("return document.getElementById('summary').value") == ""
        print("PASS native selective staging and index-only commit", flush=True)
        execute("document.querySelector('.file-row input').click()")
        click('[data-stage-group="unstaged"]'); idle()
        hook = root / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\necho native-hook-rejected >&2\nexit 1\n")
        hook.chmod(0o755)
        fill("#summary", "Draft must survive hook failure")
        click("#commit-button"); idle()
        assert execute("return document.getElementById('summary').value") == "Draft must survive hook failure"
        assert "native-hook-rejected" in execute("return document.getElementById('error-text').textContent")
        hook.unlink()
        click("#dismiss-error")
        click('[data-stage-group="staged"]'); idle()
        click("#close-changes")
        print("PASS native hook error feedback, retained draft, and unstaging", flush=True)
        click("#branch-actions"); fill("#branch-name", "native-feature"); click("#create-branch"); idle()
        assert git(root, "show-ref", "--verify", "refs/heads/native-feature")
        assert execute("return document.getElementById('history-rows').children.length") == expected + 1
        click("#branch-actions")
        branch = execute("return [...document.getElementById('branch-select').options].find(o=>o.textContent==='native-feature').value")
        choose("#branch-select", branch); click("#switch-branch"); idle()
        assert git(root, "branch", "--show-current") == "native-feature"
        print("PASS native branch creation and switching", flush=True)
        click("#push"); wait("document.getElementById('remote-dialog').open"); click("#remote-submit"); idle()
        assert git(remote, "rev-parse", "refs/heads/native-feature") == git(root, "rev-parse", "HEAD")
        assert execute("return document.getElementById('error').hidden")
        click("#fetch"); wait("document.getElementById('remote-dialog').open"); click("#remote-submit"); idle()
        assert execute("return document.getElementById('error').hidden")
        print("PASS native branch publishing and fetch through the Rust bridge", flush=True)
        execute("window.scrollTo(0,0); document.getElementById('history').scrollLeft=0")
        assert execute("return document.documentElement.scrollWidth <= innerWidth"), "App must not overflow horizontally"
        assert execute("return document.documentElement.scrollHeight <= innerHeight"), "Only history should scroll, not the whole app"
        markup = execute("return document.getElementById('app').outerHTML")
        (args.output / "desktop.html").write_text(markup)
        print("PASS native viewport geometry; captured the rendered app DOM", flush=True)
        execute("localStorage.removeItem('lastRepository'); localStorage.removeItem(arguments[0])", "draft:" + str(root))
    finally:
        if session:
            request("DELETE", "/session/" + session)
