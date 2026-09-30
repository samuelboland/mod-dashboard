"""Exercise the full dashboard against a controllable realm and real standalone host.

Run after `cd standalone && npm ci && npm run build`. Requires Selenium/Edge.
No game server or model requests are made. The lore gate and external assets are
blocked in this test; the dashboard's existing no-map-library fallback is used.
"""

import argparse
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

from accounting_browser import fixture

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    if args.artifacts:
        args.artifacts.mkdir(parents=True, exist_ok=True)
    status = {"online": False}
    settings = [
        dict(key="AiPlayerbot.PersistentProgression", value="0", writable=True,
             file="playerbots.conf", reload="reload config"),
        dict(key="AiPlayerbot.LevelBrackets.Enabled", value="0", writable=True,
             file="playerbots.conf", reload="reload config"),
        dict(key="AiPlayerbot.ResetBotLevel.Enabled", value="0", writable=True,
             file="playerbots.conf", reload="reload config"),
        dict(key="OllamaChat.Conversation.Enable", value="0", writable=True,
             file="mod_ollama_chat.conf", reload="ollama reload"),
        dict(key="OllamaChat.Conversation.HoldSeconds", value="120", writable=False,
             file="", reload=""),
    ]
    changes = []
    bot = dict(guid=18, name="Fixturebot", bot=True, level=12, **{"class": 1}, race=1,
               team=0, map=0, zone=12, zone_name="Elwynn Forest", map_name="Eastern Kingdoms",
               x=0, y=0, z=0, instance=False, combat=False, dead=False, mounted=False,
               flight=False, group_leader=0, active=True, paused=False, rpg=0,
               strategies=[], combat_strategies=[])

    class Realm(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            responses = {
                "/bots": dict(ts=int(time.time()), players=[bot],
                              counts=dict(bots=1, real=0, active=1, paused=0),
                              update_ms=dict(avg=1, max=2, last=1)),
                "/worldmap": dict(zones=[], continents={"0": "Eastern Kingdoms"}),
                "/commands": dict(enabled=True, recent=[]),
                "/settings": dict(enabled=True, writable=True, file="", reload="", settings=settings),
            }
            self.send_response(200 if status["online"] else 503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(responses.get(self.path, {}) if status["online"] else {"error": "not ready"}).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            allowed = self.path == "/cmd/setting" and self.headers.get("X-Dashboard-Token") == "fixture-command-token"
            setting = next((s for s in settings if s["key"] == body.get("key") and s["writable"]), None)
            self.send_response(200 if allowed and setting else 403)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if allowed and setting:
                changes.append(body)
                setting["value"] = body["value"]
            self.wfile.write(json.dumps(dict(ok=bool(allowed and setting), message="Saved" if allowed and setting else "Denied")).encode())

    realm = ThreadingHTTPServer(("127.0.0.1", 0), Realm)
    worker = threading.Thread(target=realm.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="standalone-browser-") as temp:
            directory = Path(temp)
            (directory / "accounting.json").write_text(json.dumps(fixture()), encoding="utf8")
            lore = dict(generated=int(time.time()), characters=[dict(guid=18, name="Fixturebot", kind="main",
                        race="Human", cls="Warrior", has_sheet=True, has_story=True, has_traits=True)])
            (directory / "lore-edit.json").write_text(json.dumps(lore), encoding="utf8")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = dict(os.environ, DASHBOARD_PORT=str(port), DASHBOARD_DATA_ROOT=temp,
                       DASHBOARD_WEB_ROOT=str(ROOT / "web"),
                       DASHBOARD_WORLD_URL=f"http://127.0.0.1:{realm.server_port}")
            with (directory / "host.log").open("w") as log:
                process = subprocess.Popen(["node", "dist/main.js"], cwd=ROOT / "standalone", env=env,
                                           stdout=log, stderr=log,
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                try:
                    url = f"http://127.0.0.1:{port}"
                    for _ in range(100):
                        try:
                            with urlopen(url + "/host-health", timeout=1):
                                break
                        except OSError:
                            if process.poll() is not None:
                                raise RuntimeError((directory / "host.log").read_text())
                            time.sleep(0.1)
                    else:
                        raise RuntimeError("Host did not start")
                    options = webdriver.EdgeOptions()
                    options.add_argument("--headless=new")
                    options.add_argument("--no-first-run")
                    options.add_argument("--window-size=1440,1000")
                    options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
                    with webdriver.Edge(options=options) as driver:
                        driver.execute_cdp_cmd("Network.enable", {})
                        driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": ["*://*:8788/*", "https://*"]})
                        driver.get(url + "/#costs")
                        wait = WebDriverWait(driver, 15)
                        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".cost-request"))
                        wait.until(lambda d: "Realm unavailable" in d.find_element(By.CSS_SELECTOR, ".conn").get_attribute("textContent"))
                        wait.until(lambda d: "$0.03" in d.find_element(By.CSS_SELECTOR, ".cost-page").text)
                        if args.artifacts:
                            driver.save_screenshot(str(args.artifacts / "offline-costs.png"))
                        driver.find_element(By.CSS_SELECTOR, '[aria-label="Close costs"]').click()
                        driver.execute_async_script("const done=arguments[0];import('./js/actions.js').then(a=>{a.setPanel('lore');done(true)});")
                        wait.until(lambda d: "Fixturebot" in d.find_element(By.CSS_SELECTOR, '[data-panel="lore"]').text)
                        status["online"] = True
                        wait.until(lambda d: "Live" in d.find_element(By.CSS_SELECTOR, ".conn").text)
                        assert driver.execute_async_script("const done=arguments[0];import('./js/state.js').then(({state})=>done(!!state.worldmap));")
                        driver.execute_async_script("const done=arguments[0];import('./js/actions.js').then(a=>{a.select(18);done(true)});")
                        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, ".hero .btn-primary").is_enabled())
                        status["online"] = False
                        wait.until(lambda d: "last update" in d.find_element(By.CSS_SELECTOR, ".conn").get_attribute("textContent"))
                        assert not driver.find_element(By.CSS_SELECTOR, ".hero .btn-primary").is_enabled()
                        if args.artifacts:
                            driver.save_screenshot(str(args.artifacts / "disconnected-inspector.png"))
                        # Reload while disconnected: saved data works without an in-memory snapshot.
                        driver.get(url + "/#costs")
                        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".cost-request"))
                        status["online"] = True
                        wait.until(lambda d: "Live" in d.find_element(By.CSS_SELECTOR, ".conn").get_attribute("textContent"))
                        driver.find_element(By.CSS_SELECTOR, '[aria-label="Close costs"]').click()
                        driver.execute_async_script("const done=arguments[0];import('./js/state.js').then(({state})=>{state.token='fixture-command-token';done(true)});")
                        driver.execute_async_script("const done=arguments[0];import('./js/actions.js').then(a=>{a.clearSelection();a.setPanel('settings');done(true)});")
                        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '[data-panel="settings"] .setting'))
                        persistent = driver.find_element(By.CSS_SELECTOR, '[aria-label="Persistent bot progression"]')
                        assert persistent.is_enabled() and not persistent.is_selected()
                        assert not driver.find_element(By.CSS_SELECTOR, '[aria-label="Waits for you (seconds)"]').is_enabled()
                        persistent.click()
                        wait.until(lambda d: changes == [dict(key="AiPlayerbot.PersistentProgression", value="1")])
                        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '[aria-label="Persistent bot progression"]').is_selected())
                        assert "playerbots.conf" in driver.find_element(By.CSS_SELECTOR, '[data-panel="settings"]').text
                        assert "ollama reload" in driver.find_element(By.CSS_SELECTOR, '[data-panel="settings"]').text
                        for width in (1440, 430):
                            driver.set_window_size(width, 1000)
                            wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '[aria-label="Persistent bot progression"]').is_displayed())
                            driver.execute_script("document.querySelector('[aria-label=\"Persistent bot progression\"]').scrollIntoView({block:'center'})")
                            wait.until(lambda d: d.execute_script("const e=document.querySelector('[aria-label=\"Persistent bot progression\"]');const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))"))
                            assert driver.execute_script("return document.documentElement.scrollWidth <= innerWidth + 1")
                            if args.artifacts:
                                driver.save_screenshot(str(args.artifacts / f"settings-{width}.png"))
                        errors = [entry["message"] for entry in driver.get_log("browser")
                                  if "handler failed" in entry["message"] or "Uncaught" in entry["message"]]
                        assert not errors, errors
                        print("PASS offline/reconnect behavior, playerbot settings, authenticated save, read-only keys and desktop/mobile layout")
                finally:
                    process.terminate()
                    process.wait(timeout=10)
    finally:
        realm.shutdown()
        realm.server_close()
        worker.join()


if __name__ == "__main__":
    main()
