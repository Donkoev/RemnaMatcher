#!/usr/bin/env python3
"""
RemnaMatcher node agent.
Ставится на ноду по SSH при добавлении сервера. Панель проверяет присутствие ноды по HTTP
(токен в заголовке) и умеет обновлять код агента без пароля. Никакой генерации трафика.

Env:
  AGENT_TOKEN     — секрет; каждый запрос должен нести X-Agent-Token: <token>
  AGENT_PORT      — порт агента (по умолчанию 8760)
  XRAY_BIN        — путь к xray (по умолчанию рядом: ./xray)
  AGENT_TLS_CERT  — сертификат (PEM) и ключ: заданы — агент слушает TLS, панель прикалывает
  AGENT_TLS_KEY     отпечаток сертификата. Без них — открытый HTTP (только старые установки)
"""
import http.client
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("AGENT_TOKEN", "")
PORT = int(os.environ.get("AGENT_PORT", "8760"))
XRAY_BIN = os.environ.get("XRAY_BIN", os.path.join(os.path.dirname(os.path.abspath(__file__)), "xray"))
TLS_CERT = os.environ.get("AGENT_TLS_CERT", "")
TLS_KEY = os.environ.get("AGENT_TLS_KEY", "")
VERSION = "11"

# ---- спидтест силами ноды -------------------------------------------------
# Непрерывный замер: панель командует /speedtest-start и /speedtest-stop, нода держит
# два потока — постоянную загрузку и постоянную отдачу через outbound сервера подписки
# (временный xray с локальным http-прокси). /speedtest-status отдаёт живые цифры:
# текущую (окно между опросами), пиковую и среднюю скорость плюс трафик.
# Если панель перестала опрашивать статус дольше 30 с — замер глушится сам.

PING_URL = "http://connectivitycheck.gstatic.com/generate_204"
SPEED_HOST = "speed.cloudflare.com"
UP_PATH = "/__up"
# Источники загрузки: Cloudflare основной (anycast, ближайший узел), но он тротлит
# жадные выходные IP (HTTP 429) — тогда поток сам перещёлкивается на следующее зеркало.
# (tls, хост, порт, путь); зеркала без TLS ещё и дешевле по CPU
DOWN_SOURCES = [
    (True, "speed.cloudflare.com", 443, "/__down?bytes=90000000"),
    (False, "speedtest.tele2.net", 80, "/10GB.zip"),
    (True, "proof.ovh.net", 443, "/files/10Gb.dat"),
    (False, "mirror.leaseweb.com", 80, "/speedtest/10000mb.bin"),
]
UP_BURST = 64 * 1024 * 1024  # отдача порциями по 64 МБ (Content-Length), по кругу
CHUNK = 1048576  # приём по 1 МБ в заранее выделенный буфер — меньше питоновских накладных на байт
UP_CHUNK = 524288
# толстый канал одним TLS-соединением не забить — параллельные потоки, как у настоящих
# спидтестов; ssl/сокеты отпускают GIL, так что питоновские треды масштабируются
STREAMS_DOWN = 12
STREAMS_UP = 8
WATCHDOG_S = 30

SPEED_JOB = None  # единственный активный замер на ноде
SPEED_LOCK = threading.Lock()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _curl(args, timeout, stdin=None):
    """curl с -w-метриками в stdout; (код возврата, stdout)"""
    try:
        out = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", *args],
            capture_output=True, text=True, timeout=timeout, stdin=stdin,
        )
        return out.returncode, out.stdout.strip()
    except subprocess.TimeoutExpired:
        return -1, ""


def _start_xray(outbound):
    """временный xray: локальный http-прокси → присланный outbound"""
    port = _free_port()
    cfg = {
        "log": {"loglevel": "none"},
        "inbounds": [{"listen": "127.0.0.1", "port": port, "protocol": "http"}],
        "outbounds": [dict(outbound, tag="out")],
    }
    cfg_path = os.path.join(tempfile.gettempdir(), "rm-speedtest-%d.json" % port)
    with open(cfg_path, "w") as f:
        json.dump(cfg, f)
    proc = subprocess.Popen([XRAY_BIN, "run", "-c", cfg_path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.time() + 6
    while True:
        if proc.poll() is not None:
            err = (proc.stderr.read() or b"").decode(errors="replace").strip().splitlines()
            raise RuntimeError("xray не запустился" + (": " + err[-1][:200] if err else ""))
        try:
            socket.create_connection(("127.0.0.1", port), 0.3).close()
            break
        except OSError:
            if time.time() > deadline:
                proc.kill()
                raise RuntimeError("xray не открыл порт вовремя")
            time.sleep(0.15)
    return proc, port, cfg_path


def _kill_xray(proc, cfg_path):
    proc.kill()
    try:
        proc.wait(timeout=3)  # прибрать зомби-процесс
    except Exception:
        pass
    try:
        os.remove(cfg_path)
    except OSError:
        pass


def _tunnel(port):
    """HTTPS-соединение к спидтест-хосту сквозь локальный прокси (CONNECT)"""
    c = http.client.HTTPSConnection("127.0.0.1", port, timeout=15)
    c.set_tunnel(SPEED_HOST, 443)
    return c


def _tunnel_to(port, tls, host, dport):
    """соединение к произвольному хосту сквозь локальный прокси (CONNECT)"""
    cls = http.client.HTTPSConnection if tls else http.client.HTTPConnection
    c = cls("127.0.0.1", port, timeout=15)
    c.set_tunnel(host, dport)
    return c


def _watchdog_hit(job):
    """панель пропала — глушим замер, чтобы не жечь трафик впустую"""
    if time.time() - job["last_poll"] > WATCHDOG_S:
        if job["stopped_at"] is None:
            job["stopped_at"] = time.time()
        job["stop"].set()
        return True
    return False


def _down_loop(job):
    # буфер один на поток: readinto без аллокаций, соединение живёт много файлов подряд —
    # TLS-рукопожатие не съедает замер между кусками
    buf = memoryview(bytearray(CHUNK))
    src_i = 0
    while not job["stop"].is_set():
        tls, host, dport, path = DOWN_SOURCES[src_i % len(DOWN_SOURCES)]
        c = None
        try:
            c = _tunnel_to(job["port"], tls, host, dport)
            while not job["stop"].is_set() and not _watchdog_hit(job):
                c.request("GET", path)
                r = c.getresponse()
                if r.status != 200:
                    raise OSError("HTTP %d (%s)" % (r.status, host))
                while not job["stop"].is_set() and not _watchdog_hit(job):
                    n = r.readinto(buf)
                    if not n:
                        break
                    with job["lock"]:
                        job["down"] += n
                    job["down_err"] = None  # данные идут — прошлая ошибка неактуальна
                if not r.isclosed():
                    break  # остановились посреди тела — соединение дальше не годится
        except Exception as e:
            if not job["stop"].is_set():
                job["down_err"] = ("%s: %s" % (type(e).__name__, e))[:160].strip(': ')
                src_i += 1  # источник не отдаёт (429/недоступен) — пробуем следующее зеркало
                time.sleep(0.5)
        finally:
            if c:
                try:
                    c.close()
                except Exception:
                    pass


def _up_loop(job):
    chunk = b"\0" * UP_CHUNK
    while not job["stop"].is_set():
        c = None
        try:
            c = _tunnel(job["port"])
            # то же переиспользование соединения: порции по UP_BURST одна за другой
            while not job["stop"].is_set() and not _watchdog_hit(job):
                c.putrequest("POST", UP_PATH)
                c.putheader("Content-Type", "application/octet-stream")
                c.putheader("Content-Length", str(UP_BURST))
                c.endheaders()
                sent = 0
                while sent < UP_BURST and not job["stop"].is_set() and not _watchdog_hit(job):
                    c.send(chunk)
                    sent += len(chunk)
                    with job["lock"]:
                        job["up"] += len(chunk)
                    job["up_err"] = None
                if sent < UP_BURST:
                    break  # оборвали тело — соединение дальше не годится
                r = c.getresponse()
                r.read()
                if r.status >= 400:
                    raise OSError("HTTP %d" % r.status)
        except Exception as e:
            if not job["stop"].is_set():
                job["up_err"] = ("%s: %s" % (type(e).__name__, e))[:160].strip(': ')
                time.sleep(1)
        finally:
            if c:
                try:
                    c.close()
                except Exception:
                    pass


def _speed_cleanup(job):
    job["stop"].set()
    _kill_xray(job["proc"], job["cfg"])  # рубит соединения — потоки замера тут же выходят
    for t in job["threads"]:
        t.join(timeout=2)


def _speed_snapshot(job):
    now = job["stopped_at"] or time.time()
    with job["lock"]:
        down, up = job["down"], job["up"]
    elapsed = max(now - job["started"], 0.1)

    def mbps(n):
        return round(n * 8 / elapsed / 1e6, 1)

    return {
        "running": not job["stop"].is_set(),
        "pingMs": job["ping"],
        "elapsedS": round(elapsed, 1),
        "downBytes": down,
        "upBytes": up,
        "downCurrentMbps": job["cur"][0],
        "upCurrentMbps": job["cur"][1],
        "downPeakMbps": round(job["down_peak"], 1) if job["down_peak"] else None,
        "upPeakMbps": round(job["up_peak"], 1) if job["up_peak"] else None,
        "downAvgMbps": mbps(down) if down else None,
        "upAvgMbps": mbps(up) if up else None,
        # последняя ошибка направления — видно, почему поток не даёт данных
        "downError": job["down_err"],
        "upError": job["up_err"],
    }


def speed_start(outbound):
    global SPEED_JOB
    with SPEED_LOCK:
        # новый замер вытесняет предыдущий — на ноде живёт один
        if SPEED_JOB is not None:
            _speed_cleanup(SPEED_JOB)
            SPEED_JOB = None
        proc, port, cfg_path = _start_xray(outbound)
        # пинг до нагрузки: лучший из двух GET generate_204
        proxy = "http://127.0.0.1:%d" % port
        ping_ms = None
        for _ in range(2):
            code, out = _curl(["-x", proxy, "--max-time", "5", "-w", "%{time_total}", PING_URL], 8)
            if code == 0:
                try:
                    t = float(out) * 1000
                    ping_ms = t if ping_ms is None else min(ping_ms, t)
                except ValueError:
                    pass
        if ping_ms is None:
            _kill_xray(proc, cfg_path)
            return {"error": "сервер не пропускает трафик"}
        job = {
            "stop": threading.Event(), "lock": threading.Lock(),
            "proc": proc, "cfg": cfg_path, "port": port,
            "down": 0, "up": 0, "started": time.time(), "stopped_at": None,
            "ping": int(ping_ms), "last_poll": time.time(),
            "prev": None, "cur": (None, None), "down_peak": 0.0, "up_peak": 0.0,
            "down_err": None, "up_err": None,
            "threads": [],
        }
        for fn in [_down_loop] * STREAMS_DOWN + [_up_loop] * STREAMS_UP:
            t = threading.Thread(target=fn, args=(job,), daemon=True)
            job["threads"].append(t)
            t.start()
        SPEED_JOB = job
        return {"ok": True, "pingMs": job["ping"]}


def speed_status():
    with SPEED_LOCK:
        job = SPEED_JOB
        if job is None:
            return {"running": False}
        now = time.time()
        job["last_poll"] = now
        with job["lock"]:
            down, up = job["down"], job["up"]
        prev = job["prev"]
        if prev is None:
            job["prev"] = (now, down, up)
        elif now - prev[0] >= 0.5:
            # текущая скорость — окно между опросами статуса; из неё же копится пик
            dt = now - prev[0]
            cur_d = round((down - prev[1]) * 8 / dt / 1e6, 1)
            cur_u = round((up - prev[2]) * 8 / dt / 1e6, 1)
            job["cur"] = (cur_d, cur_u)
            job["down_peak"] = max(job["down_peak"], cur_d)
            job["up_peak"] = max(job["up_peak"], cur_u)
            job["prev"] = (now, down, up)
        return _speed_snapshot(job)


def speed_stop():
    global SPEED_JOB
    with SPEED_LOCK:
        job = SPEED_JOB
        if job is None:
            return {"running": False}
        if job["stopped_at"] is None:
            job["stopped_at"] = time.time()
        _speed_cleanup(job)
        SPEED_JOB = None
        final = _speed_snapshot(job)
        final["running"] = False
        return final


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 с keep-alive: панель опрашивает часто, и по одному живому соединению —
    # новые TCP-потоки на флапающем канале иногда теряются. Простой > 65с — закрываем.
    protocol_version = "HTTP/1.1"
    timeout = 65

    def log_message(self, *args):
        pass  # тихо

    def _auth(self):
        return TOKEN and self.headers.get("X-Agent-Token") == TOKEN

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._auth():
            return self._send(401, {"error": "bad token"})
        if self.path == "/health":
            return self._send(200, {
                "ok": True, "version": VERSION, "xray": os.path.exists(XRAY_BIN), "tls": _tls_enabled(),
            })
        if self.path == "/speedtest-status":
            return self._send(200, speed_status())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return self._send(401, {"error": "bad token"})
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})

        if self.path == "/self-update":
            # панель толкнула новый код агента — перезаписываем себя и перезапускаемся (systemd поднимет)
            code = body.get("code")
            if not code or "RemnaMatcher node agent" not in code:
                return self._send(400, {"error": "плохой код агента"})
            try:
                # атомарно: пишем рядом и подменяем — оборванная запись не оставит ноду без агента
                target = os.path.abspath(__file__)
                tmp = target + ".new"
                with open(tmp, "w") as f:
                    f.write(code)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, target)
            except Exception as e:
                return self._send(500, {"error": str(e)})
            self._send(200, {"ok": True})
            threading.Timer(0.8, lambda: os._exit(0)).start()  # Restart=always поднимет новый файл
            return

        if self.path == "/speedtest-start":
            outbound = body.get("outbound")
            if not isinstance(outbound, dict):
                return self._send(400, {"error": "нужен outbound"})
            try:
                return self._send(200, speed_start(outbound))
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if self.path == "/speedtest-stop":
            try:
                return self._send(200, speed_stop())
            except Exception as e:
                return self._send(500, {"error": str(e)})

        self._send(404, {"error": "not found"})


def _tls_enabled():
    return bool(TLS_CERT and TLS_KEY and os.path.exists(TLS_CERT) and os.path.exists(TLS_KEY))


def main():
    if not TOKEN:
        raise SystemExit("AGENT_TOKEN не задан")
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    if _tls_enabled():
        # самоподписанный сертификат: панель проверяет не цепочку, а закреплённый отпечаток
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(TLS_CERT, TLS_KEY)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    else:
        sys.stderr.write("WARN: AGENT_TLS_CERT/AGENT_TLS_KEY не заданы — агент слушает открытый HTTP, переустанови его из панели\n")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
