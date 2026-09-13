#!/usr/bin/env python3
"""
RemnaMatcher node agent.
Ставится на ноду по SSH при добавлении сервера. Панель проверяет присутствие ноды по HTTP
(токен в заголовке) и умеет обновлять код агента без пароля. Трафик нода генерирует только
по команде панели — в спидтесте.

Env:
  AGENT_TOKEN     — секрет; каждый запрос должен нести X-Agent-Token: <token>
  AGENT_PORT      — порт агента (по умолчанию 8760)
  XRAY_BIN        — путь к xray (по умолчанию рядом: ./xray)
  AGENT_TLS_CERT  — сертификат (PEM) и ключ: заданы — агент слушает TLS, панель прикалывает
  AGENT_TLS_KEY     отпечаток сертификата. Без них — открытый HTTP (только старые установки)
"""
import collections
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
from urllib.parse import urlsplit

TOKEN = os.environ.get("AGENT_TOKEN", "")
PORT = int(os.environ.get("AGENT_PORT", "8760"))
XRAY_BIN = os.environ.get("XRAY_BIN", os.path.join(os.path.dirname(os.path.abspath(__file__)), "xray"))
TLS_CERT = os.environ.get("AGENT_TLS_CERT", "")
TLS_KEY = os.environ.get("AGENT_TLS_KEY", "")
VERSION = "12"

# ---- спидтест силами ноды -------------------------------------------------
# Непрерывный замер: панель командует /speedtest-start и /speedtest-stop, нода гоняет
# параллельные потоки загрузки и отдачи через outbound сервера подписки (временный xray
# с локальным http-прокси). Потоки раскиданы по многим источникам сразу: на старте каждый
# источник пробуется коротким куском, дальше планировщик держит потоки на тех, кто отдаёт
# быстрее всего, и уводит с тех, кто режет (HTTP 429) или тормозит. Так меряется ёмкость
# пути нода → сервер → интернет, а не лимит одного зеркала на один IP: байты считаются
# на ноде, и больше узкого места этого пути сумма по источникам показать не может.
# /speedtest-status отдаёт живые цифры: текущую (последняя секунда), устойчивую (среднее
# за 10 с), пиковую и среднюю (без прогрева) скорость, трафик, CPU ноды и разбивку по
# источникам. Если панель не опрашивает статус дольше 30 с — замер глушится сам.

UA = "RemnaMatcher-speedtest/2"
PING_HOST, PING_PATH = "connectivitycheck.gstatic.com", "/generate_204"

# Источники загрузки: (имя, tls, хост, порт, путь). География широкая — сервер подписки
# может стоять где угодно, ближние выберет проба на старте. Зеркала без TLS дешевле по CPU
DOWN_SOURCES = [
    ("Cloudflare", True, "speed.cloudflare.com", 443, "/__down?bytes=25000000"),  # больше — 403
    ("OVH FR", True, "proof.ovh.net", 443, "/files/10Gb.dat"),
    ("OVH CA", True, "proof.ovh.ca", 443, "/files/10Gb.dat"),
    ("OVH SG", True, "sgp.proof.ovh.net", 443, "/files/10Gb.dat"),
    ("OVH AU", True, "syd.proof.ovh.net", 443, "/files/10Gb.dat"),
    ("OVH US", True, "hil.proof.ovh.us", 443, "/files/10Gb.dat"),
    ("Hetzner DE", True, "fsn1-speed.hetzner.com", 443, "/10GB.bin"),
    ("Hetzner FI", True, "hel1-speed.hetzner.com", 443, "/10GB.bin"),
    ("Hetzner US-E", True, "ash-speed.hetzner.com", 443, "/10GB.bin"),
    ("Hetzner US-W", True, "hil-speed.hetzner.com", 443, "/10GB.bin"),
    ("Hetzner SG", True, "sin-speed.hetzner.com", 443, "/10GB.bin"),
    ("Linode SG", False, "speedtest.singapore.linode.com", 80, "/1GB-singapore.bin"),
    ("Linode JP", False, "speedtest.tokyo2.linode.com", 80, "/1GB-tokyo2.bin"),
    ("Linode IN", False, "speedtest.mumbai1.linode.com", 80, "/1GB-mumbai.bin"),
    ("Linode AU", False, "speedtest.sydney.linode.com", 80, "/1GB-sydney.bin"),
    ("Linode UK", False, "speedtest.london.linode.com", 80, "/1GB-london.bin"),
    ("Linode DE", False, "speedtest.frankfurt.linode.com", 80, "/1GB-frankfurt.bin"),
    ("Linode US-E", False, "speedtest.newark.linode.com", 80, "/1GB-newark.bin"),
    ("Linode US-W", False, "speedtest.fremont.linode.com", 80, "/1GB-fremont.bin"),
    ("Vultr JP", True, "hnd-jp-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr IN", True, "bom-in-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr AU", True, "syd-au-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr DE", True, "fra-de-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr NL", True, "ams-nl-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr UK", True, "lon-gb-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr US-E", True, "nj-us-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr US-W", True, "lax-ca-us-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr BR", True, "sao-br-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Vultr ZA", True, "jnb-za-ping.vultr.com", 443, "/vultr.com.1000MB.bin"),
    ("Tele2 SE", False, "speedtest.tele2.net", 80, "/10GB.zip"),
    ("ThinkBroadband UK", False, "ipv4.download.thinkbroadband.com", 80, "/1GB.zip"),
]
# Приёмники отдачи: публичных мало — Cloudflare плюс серверы Netflix из fast.com (ниже)
UP_SOURCES = [("Cloudflare", True, "speed.cloudflare.com", 443, "/__up")]
# fast.com отдаёт ближайшие к выходному IP сервера Netflix; они принимают и GET, и POST.
# Токен публичный — зашит в скрипт самого fast.com
FAST_API_HOST = "api.fast.com"
FAST_API_PATH = "/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5"

# толстый канал одним соединением не забить — параллельные потоки, как у настоящих
# спидтестов; ssl/сокеты отпускают GIL, так что питоновские треды масштабируются по ядрам
STREAMS_DOWN = 16
STREAMS_UP = 8
CHUNK = 1048576  # приём по 1 МБ в заранее выделенный буфер — меньше питоновских накладных на байт
UP_CHUNK = 524288
UP_BURST = 32 * 1024 * 1024  # отдача порциями по 32 МБ (Content-Length), по кругу
PROBE_BYTES = 2 * 1024 * 1024  # проба источника на старте: короткий кусок
PROBE_TIMEOUT_S = 5.0
SAMPLE_S = 1.0  # шаг сэмплера: текущая скорость — последняя секунда
WINDOW_N = 10  # «устойчивая» скорость — среднее последних 10 сэмплов
WARMUP_S = 6.0  # прогрев: первые секунды основной фазы в среднее не идут
REBALANCE_EVERY = 5  # перераспределение потоков раз в N сэмплов
SETTLE_S = 12.0  # только что привязанный поток не трогаем — дай TCP разогнаться
MOVE_RATIO = 0.35  # источник медленный, если даёт на поток меньше 35% от среднего по потокам
SLOW_ROUNDS = 2  # ...и держится таким два раунда подряд — одиночный провал не повод переезжать
MAX_MOVES = 2  # переездов за раунд на направление: переезд = переподключение и разгон заново
EXPLORE_RATIO = 2.0  # простаивающий источник с ожиданием вдвое выше среднего стоит попробовать
COOL_429_S = 60.0  # источник режет (429) — пауза для него
COOL_ERR_S = 20.0  # прочие ошибки: пауза растёт с каждой подряд
COOL_MAX_S = 300.0
WATCHDOG_S = 30
CONN_TIMEOUT_S = 15

SPEED_JOB = None  # единственный замер на ноде: живой или последний завершённый
SPEED_LOCK = threading.Lock()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _start_xray(outbound):
    """временный xray: локальный http-прокси → присланный outbound"""
    port = _free_port()
    outbound = dict(outbound, tag="out")
    # mux схлопнул бы потоки в пару соединений — для замера ёмкости он только мешает
    outbound.pop("mux", None)
    cfg = {
        "log": {"loglevel": "none"},
        "inbounds": [{"listen": "127.0.0.1", "port": port, "protocol": "http"}],
        "outbounds": [outbound],
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
    """рубит xray (и с ним все соединения замера); повторный вызов безвреден"""
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)  # прибрать зомби-процесс
    except Exception:
        pass
    try:
        os.remove(cfg_path)
    except OSError:
        pass


def _tunnel_to(port, tls, host, dport, timeout=CONN_TIMEOUT_S):
    """соединение к произвольному хосту сквозь локальный прокси (CONNECT)"""
    cls = http.client.HTTPSConnection if tls else http.client.HTTPConnection
    c = cls("127.0.0.1", port, timeout=timeout)
    c.set_tunnel(host, dport)
    return c


def _measure_latency(port):
    """Задержка запроса через сервер по прогретому соединению: лучший из трёх GET generate_204,
    первый запрос (с рукопожатиями) не считаем. None — сервер не пропускает трафик"""
    c = _tunnel_to(port, False, PING_HOST, 80, timeout=5)
    first = best = None
    try:
        for i in range(4):
            t0 = time.monotonic()
            c.request("GET", PING_PATH, headers={"User-Agent": UA})
            r = c.getresponse()
            r.read()
            if r.status >= 400:
                return None
            dt = (time.monotonic() - t0) * 1000
            if i == 0:
                first = dt
            else:
                best = dt if best is None else min(best, dt)
    except Exception:
        pass
    finally:
        c.close()
    return best if best is not None else first


def _fast_targets(port):
    """ближайшие к выходному IP сервера Netflix (fast.com): [(имя, хост, путь)]"""
    c = _tunnel_to(port, True, FAST_API_HOST, 443, timeout=6)
    try:
        c.request("GET", FAST_API_PATH, headers={"User-Agent": UA})
        r = c.getresponse()
        data = json.loads(r.read().decode())
    finally:
        c.close()
    out, seen = [], {}
    for t in data.get("targets", []):
        u = urlsplit(str(t.get("url", "")))
        if u.scheme != "https" or not u.hostname:
            continue
        loc = t.get("location") or {}
        base = "Netflix %s" % (loc.get("city") or loc.get("country") or u.hostname.split(".")[0])
        seen[base] = seen.get(base, 0) + 1
        name = base if seen[base] == 1 else "%s %d" % (base, seen[base])
        out.append((name, u.hostname, u.path + ("?" + u.query if u.query else "")))
    return out


def _mk_source(sid, dirn, name, tls, host, port, path):
    return {
        "id": sid, "dir": dirn, "name": name, "tls": tls, "host": host, "port": port, "path": path,
        "bytes": 0, "last_bytes": 0, "streams": 0,
        "rate": None,  # Мбит/с, скользящее среднее сэмплов; до пробы неизвестно
        "probe": None,  # Мбит/с одним потоком по пробе на старте
        "cool_until": 0.0, "err": None, "errors": 0,
        "slow": 0,  # сколько раундов подряд источник медленнее среднего
        "tried": False,  # на нём уже сидели потоки основной фазы — оценка не с пробы
    }


# ---- планировщик: какие потоки на каком источнике (всё под job["lock"]) ----

def _fail_locked(src, exc, now=None):
    """источник не отдаёт: запоминаем причину, ставим на паузу (429 — подольше, прочее — с ростом)"""
    now = now or time.time()
    msg = ("%s: %s" % (type(exc).__name__, exc))[:160].strip(": ")
    src["err"] = msg
    src["errors"] += 1
    cool = COOL_429_S if "429" in msg else min(COOL_ERR_S * (2 ** min(src["errors"] - 1, 4)), COOL_MAX_S)
    src["cool_until"] = now + cool
    if src["rate"]:
        src["rate"] *= 0.5  # после паузы источник не должен выглядеть лучше, чем есть


def _pick_locked(job, dirn, idx, now):
    """источник для потока: наибольшая ожидаемая скорость на поток с учётом уже сидящих там потоков;
    непроверенный источник — сначала попробовать. None — все на паузе"""
    best, best_score = None, -1.0
    for s in job["sources"]:
        if s["dir"] != dirn or s["cool_until"] > now:
            continue
        est = s["rate"] if s["rate"] is not None else (s["probe"] if s["probe"] is not None else 1e9)
        score = est / (s["streams"] + 1)
        if score > best_score:
            best, best_score = s, score
    if best is not None:
        best["streams"] += 1
        if job["phase"] == "run":
            best["tried"] = True
        job["assign"][idx] = best
        job["since"][idx] = now
        job["move"][idx] = False
    return best


def _release_locked(job, idx):
    s = job["assign"][idx]
    if s is not None:
        s["streams"] -= 1
        job["assign"][idx] = None


def _mark_move_locked(job, src, now):
    """пометить один давно сидящий поток источника на переезд; False — нечего переселять"""
    for idx, a in enumerate(job["assign"]):
        if a is src and not job["move"][idx] and now - job["since"][idx] >= SETTLE_S:
            job["move"][idx] = True
            return True
    return False


def _rebalance_locked(job, dirn, now):
    """Раунд перераспределения. Мерило — среднее по потокам направления: если узкое место общее
    (аплинк сервера), все источники дают примерно поровну и никто не переезжает. Источник,
    два раунда подряд дающий на поток много меньше среднего, отдаёт поток; переехавший поток
    сядет туда, где ожидание выше (в т.ч. на простаивающий источник). Отдельно — разведка:
    простаивающий источник с ожиданием заметно выше среднего пробуется одним потоком.
    Переездов за раунд немного: каждый — это переподключение и разгон TCP заново"""
    active, idle = [], []
    for s in job["sources"]:
        if s["dir"] != dirn or s["cool_until"] > now:
            continue
        if s["streams"] > 0:
            if s["rate"] is not None:
                active.append(s)
        else:
            s["slow"] = 0
            if not s["tried"] and s["probe"] is not None:
                idle.append(s)
    total_streams = sum(s["streams"] for s in active)
    if not active or total_streams == 0:
        return
    mean = sum(s["rate"] for s in active) / total_streams
    moves = 0
    for s in sorted(active, key=lambda x: x["rate"] / x["streams"]):
        if moves >= MAX_MOVES:
            break
        if s["rate"] / s["streams"] < MOVE_RATIO * mean:
            s["slow"] += 1
            if s["slow"] >= SLOW_ROUNDS and _mark_move_locked(job, s, now):
                moves += 1
        else:
            s["slow"] = 0
    if moves == 0 and idle:
        best = max(idle, key=lambda x: x["probe"])
        if best["probe"] >= EXPLORE_RATIO * mean:
            # донор — самый медленный на поток из тех, у кого потоков больше одного
            donors = [s for s in active if s["streams"] > 1]
            if donors:
                _mark_move_locked(job, min(donors, key=lambda x: x["rate"] / x["streams"]), now)


# ---- потоки замера ----

def _probe_source(job, src):
    """Короткая проба одним потоком: сколько Мбит/с даёт источник на PROBE_BYTES (отдача — POST).
    Пробы идут все разом и делят канал, поэтому таймаут с уже полученными байтами — не провал,
    а просто низкая оценка; провал — только когда источник не дал ничего или ответил ошибкой"""
    c, got = None, 0
    t0 = time.monotonic()
    err = None
    try:
        c = _tunnel_to(job["port"], src["tls"], src["host"], src["port"], timeout=PROBE_TIMEOUT_S)
        if src["dir"] == "down":
            # без Range: Cloudflare на него отвечает 403 — читаем начало файла и рвём соединение
            c.request("GET", src["path"], headers={"User-Agent": UA})
            r = c.getresponse()
            if r.status != 200:
                raise OSError("HTTP %d (%s)" % (r.status, src["host"]))
            buf = memoryview(bytearray(262144))
            while got < PROBE_BYTES and not job["stop"].is_set():
                n = r.readinto(buf)
                if not n:
                    break
                got += n
                with job["lock"]:
                    job["down"] += n
                    src["bytes"] += n
        else:
            chunk = job["up_chunk"]
            c.putrequest("POST", src["path"])
            c.putheader("User-Agent", UA)
            c.putheader("Content-Type", "application/octet-stream")
            c.putheader("Content-Length", str(PROBE_BYTES))
            c.endheaders()
            while got < PROBE_BYTES and not job["stop"].is_set():
                part = chunk[: min(len(chunk), PROBE_BYTES - got)]
                c.send(part)
                got += len(part)
                with job["lock"]:
                    job["up"] += len(part)
                    src["bytes"] += len(part)
            r = c.getresponse()
            r.read()
            if r.status >= 400:
                raise OSError("HTTP %d (%s)" % (r.status, src["host"]))
    except Exception as e:
        err = e
    finally:
        if c:
            try:
                c.close()
            except Exception:
                pass
    if job["stop"].is_set():
        return
    is_http = isinstance(err, OSError) and str(err).startswith("HTTP ")
    with job["lock"]:
        if got and not is_http:
            src["probe"] = round(got * 8 / max(time.monotonic() - t0, 0.05) / 1e6, 1)
            src["rate"] = src["probe"]
        else:
            _fail_locked(src, err or OSError("пустой ответ (%s)" % src["host"]))


def _down_stream(job, idx):
    # буфер один на поток: readinto без аллокаций; соединение живёт много файлов подряд —
    # рукопожатие не съедает замер между кусками
    buf = memoryview(bytearray(CHUNK))
    while not job["stop"].is_set():
        with job["lock"]:
            src = _pick_locked(job, "down", idx, time.time())
        if src is None:
            time.sleep(1.0)  # все источники на паузе — подождём
            continue
        c = None
        try:
            c = _tunnel_to(job["port"], src["tls"], src["host"], src["port"])
            while not job["stop"].is_set() and not job["move"][idx]:
                c.request("GET", src["path"], headers={"User-Agent": UA})
                r = c.getresponse()
                if r.status != 200:
                    raise OSError("HTTP %d (%s)" % (r.status, src["host"]))
                while not job["stop"].is_set() and not job["move"][idx]:
                    n = r.readinto(buf)
                    if not n:
                        break
                    with job["lock"]:
                        job["down"] += n
                        src["bytes"] += n
                        src["err"] = None  # данные идут — прошлая ошибка неактуальна
                if not r.isclosed():
                    break  # оборвали тело — соединение дальше не годится
                with job["lock"]:
                    src["errors"] = 0
        except Exception as e:
            if not job["stop"].is_set():
                with job["lock"]:
                    _fail_locked(src, e)
                time.sleep(0.3)
        finally:
            if c:
                try:
                    c.close()
                except Exception:
                    pass
            with job["lock"]:
                _release_locked(job, idx)


def _up_stream(job, idx):
    chunk = job["up_chunk"]  # случайные байты: даже сжимающий транспорт их не ужмёт
    while not job["stop"].is_set():
        with job["lock"]:
            src = _pick_locked(job, "up", idx, time.time())
        if src is None:
            time.sleep(1.0)
            continue
        c = None
        try:
            c = _tunnel_to(job["port"], src["tls"], src["host"], src["port"])
            # то же переиспользование соединения: порции по UP_BURST одна за другой
            while not job["stop"].is_set() and not job["move"][idx]:
                c.putrequest("POST", src["path"])
                c.putheader("User-Agent", UA)
                c.putheader("Content-Type", "application/octet-stream")
                c.putheader("Content-Length", str(UP_BURST))
                c.endheaders()
                sent = 0
                while sent < UP_BURST and not job["stop"].is_set() and not job["move"][idx]:
                    c.send(chunk)
                    sent += len(chunk)
                    with job["lock"]:
                        job["up"] += len(chunk)
                        src["bytes"] += len(chunk)
                        src["err"] = None
                if sent < UP_BURST:
                    break  # оборвали тело — соединение дальше не годится
                r = c.getresponse()
                r.read()
                if r.status >= 400:
                    raise OSError("HTTP %d (%s)" % (r.status, src["host"]))
                with job["lock"]:
                    src["errors"] = 0
        except Exception as e:
            if not job["stop"].is_set():
                with job["lock"]:
                    _fail_locked(src, e)
                time.sleep(0.3)
        finally:
            if c:
                try:
                    c.close()
                except Exception:
                    pass
            with job["lock"]:
                _release_locked(job, idx)


def _cpu_times():
    """(простой, всего) тиков CPU из /proc/stat; None вне Linux"""
    try:
        with open("/proc/stat") as f:
            vals = [int(x) for x in f.readline().split()[1:9]]
        return vals[3] + vals[4], sum(vals)
    except Exception:
        return None


def _finish(job, note=None):
    """замер окончен (стоп или вотчдог): фиксируем время, глушим xray — с ним рвутся все
    соединения, и потоки тут же выходят. Итог остаётся в job для /speedtest-status"""
    if job["stopped_at"] is None:
        job["stopped_at"] = time.time()
    if note:
        job["note"] = note
    job["stop"].set()
    job["phase"] = "done"
    _kill_xray(job["proc"], job["cfg"])


def _sampler(job):
    """раз в секунду: сэмплы скорости (текущая/устойчивая/пик), скорость источников, CPU ноды,
    перераспределение потоков, вотчдог"""
    prev_t = time.monotonic()
    with job["lock"]:
        prev_d, prev_u = job["down"], job["up"]
    cpu_prev = _cpu_times()
    tick = 0
    while not job["stop"].wait(SAMPLE_S):
        tick += 1
        now, mono = time.time(), time.monotonic()
        dt = max(mono - prev_t, 0.2)
        prev_t = mono
        with job["lock"]:
            d, u = job["down"], job["up"]
            rd, ru = (d - prev_d) * 8 / dt / 1e6, (u - prev_u) * 8 / dt / 1e6
            prev_d, prev_u = d, u
            job["samples_d"].append(rd)
            job["samples_u"].append(ru)
            job["cur"] = (round(rd, 1), round(ru, 1))
            job["down_peak"] = max(job["down_peak"], rd)
            job["up_peak"] = max(job["up_peak"], ru)
            for s in job["sources"]:
                delta = s["bytes"] - s["last_bytes"]
                s["last_bytes"] = s["bytes"]
                if s["streams"] > 0 or delta > 0:
                    r = delta * 8 / dt / 1e6
                    s["rate"] = r if s["rate"] is None else 0.5 * s["rate"] + 0.5 * r
            if job["phase"] == "run":
                if job["warm"] is None and now - job["run_since"] >= WARMUP_S:
                    job["warm"] = (now, d, u)  # отсюда считается среднее
                if tick % REBALANCE_EVERY == 0:
                    _rebalance_locked(job, "down", now)
                    _rebalance_locked(job, "up", now)
        cpu = _cpu_times()
        if cpu and cpu_prev and cpu[1] > cpu_prev[1]:
            job["cpu"] = round(100 * (1 - (cpu[0] - cpu_prev[0]) / (cpu[1] - cpu_prev[1])))
        cpu_prev = cpu
        if now - job["last_poll"] > WATCHDOG_S:
            # панель пропала — глушим, чтобы не жечь трафик впустую
            _finish(job, "панель перестала опрашивать статус — замер остановлен")


def _coordinator(job):
    """старт замера: серверы Netflix из fast.com, проба всех источников разом, затем потоки"""
    try:
        for name, host, path in _fast_targets(job["port"]):
            for dirn in ("down", "up"):
                job["sources"].append(_mk_source("%s%d" % (dirn[0], len(job["sources"])), dirn, name, True, host, 443, path))
    except Exception as e:
        job["notes"].append("fast.com через сервер недоступен: %s" % str(e)[:80])
    probes = [threading.Thread(target=_probe_source, args=(job, s), daemon=True) for s in job["sources"]]
    for t in probes:
        t.start()
    deadline = time.monotonic() + PROBE_TIMEOUT_S + 2
    for t in probes:
        t.join(max(0.0, deadline - time.monotonic()))
    if job["stop"].is_set():
        return
    job["phase"] = "run"
    job["run_since"] = time.time()
    for idx in range(STREAMS_DOWN + STREAMS_UP):
        fn = _down_stream if idx < STREAMS_DOWN else _up_stream
        t = threading.Thread(target=fn, args=(job, idx), daemon=True)
        job["threads"].append(t)
        t.start()


def _speed_cleanup(job):
    _finish(job)
    deadline = time.monotonic() + 5
    for t in job["threads"]:
        t.join(max(0.0, deadline - time.monotonic()))


def _speed_snapshot(job):
    now = job["stopped_at"] or time.time()
    with job["lock"]:
        down, up = job["down"], job["up"]
        sd, su = list(job["samples_d"]), list(job["samples_u"])
        warm, cur = job["warm"], job["cur"]
        dpk, upk = job["down_peak"], job["up_peak"]
        srcs = [dict(s) for s in job["sources"]]
    elapsed = max(now - job["started"], 0.1)
    running = not job["stop"].is_set()

    def avg(total, i):
        # среднее без прогрева; пока прогрев не прошёл — с начала замера
        if warm and now - warm[0] >= 1.0:
            n, t = total - warm[i], now - warm[0]
        else:
            n, t = total, elapsed
        return round(n * 8 / t / 1e6, 1) if n > 0 else None

    def mean(xs):
        return round(sum(xs) / len(xs), 1) if xs else None

    def dir_error(dirn):
        # направление стоит посреди замера: ни один источник не даёт данных — показываем
        # последнюю причину. В пробе и после остановки потоков нет по определению
        if not running or job["phase"] != "run":
            return None
        mine = [s for s in srcs if s["dir"] == dirn]
        if any(s["rate"] and s["streams"] > 0 for s in mine):
            return None
        errs = [s for s in mine if s["err"]]
        return max(errs, key=lambda s: s["cool_until"])["err"] if errs else None

    sources = []
    for s in srcs:
        if s["streams"] == 0 and s["bytes"] == 0 and not s["err"]:
            continue
        sources.append({
            "name": s["name"], "dir": s["dir"], "mbps": round(s["rate"], 1) if s["rate"] else 0.0,
            "streams": s["streams"], "bytes": s["bytes"],
            "error": s["err"] if s["cool_until"] > now else None,
        })
    sources.sort(key=lambda x: (x["dir"] != "down", -x["streams"], -x["mbps"]))
    return {
        "running": running,
        "phase": job["phase"],
        "pingMs": job["ping"],
        "elapsedS": round(elapsed, 1),
        "downBytes": down,
        "upBytes": up,
        "downCurrentMbps": cur[0],
        "upCurrentMbps": cur[1],
        "downSustainedMbps": mean(sd),
        "upSustainedMbps": mean(su),
        "downPeakMbps": round(dpk, 1) if dpk else None,
        "upPeakMbps": round(upk, 1) if upk else None,
        "downAvgMbps": avg(down, 1),
        "upAvgMbps": avg(up, 2),
        "downError": dir_error("down"),
        "upError": dir_error("up"),
        "cpuPct": job["cpu"],
        "streamsDown": sum(s["streams"] for s in srcs if s["dir"] == "down"),
        "streamsUp": sum(s["streams"] for s in srcs if s["dir"] == "up"),
        "sources": sources,
        "notes": list(job["notes"]) + ([job["note"]] if job["note"] else []),
        "version": VERSION,
    }


def speed_start(outbound):
    global SPEED_JOB
    with SPEED_LOCK:
        # новый замер вытесняет предыдущий (живой или завершённый) — на ноде живёт один
        if SPEED_JOB is not None:
            _speed_cleanup(SPEED_JOB)
            SPEED_JOB = None
        proc, port, cfg_path = _start_xray(outbound)
        try:
            ping_ms = _measure_latency(port)
        except Exception:
            ping_ms = None
        if ping_ms is None:
            _kill_xray(proc, cfg_path)
            return {"error": "сервер не пропускает трафик"}
        sources = []
        for name, tls, host, dport, path in DOWN_SOURCES:
            sources.append(_mk_source("d%d" % len(sources), "down", name, tls, host, dport, path))
        for name, tls, host, dport, path in UP_SOURCES:
            sources.append(_mk_source("u%d" % len(sources), "up", name, tls, host, dport, path))
        n = STREAMS_DOWN + STREAMS_UP
        job = {
            "stop": threading.Event(), "lock": threading.Lock(),
            "proc": proc, "cfg": cfg_path, "port": port,
            "phase": "probe", "started": time.time(), "run_since": None, "stopped_at": None,
            "ping": int(ping_ms), "last_poll": time.time(),
            "down": 0, "up": 0, "warm": None, "cur": (None, None),
            "samples_d": collections.deque(maxlen=WINDOW_N), "samples_u": collections.deque(maxlen=WINDOW_N),
            "down_peak": 0.0, "up_peak": 0.0, "cpu": None,
            "sources": sources, "assign": [None] * n, "since": [0.0] * n, "move": [False] * n,
            "up_chunk": os.urandom(UP_CHUNK),
            "notes": [], "note": None, "threads": [],
        }
        for fn in (_sampler, _coordinator):
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
        job["last_poll"] = time.time()
        return _speed_snapshot(job)


def speed_stop():
    with SPEED_LOCK:
        job = SPEED_JOB
        if job is None:
            return {"running": False}
        _speed_cleanup(job)  # итог остаётся в job — статус отдаёт его до следующего старта
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
