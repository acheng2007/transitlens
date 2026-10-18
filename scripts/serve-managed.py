"""One managed service: public Node gateway and two loopback-only Python APIs."""
import asyncio
import os
from pathlib import Path
import signal
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


async def serve():
    bus_port = int(os.getenv('TRANSIT_BUS_PORT', '8003'))
    voice_port = int(os.getenv('TRANSIT_VOICE_PORT', '8002'))
    public_port = int(os.getenv('PORT', '8080'))
    ports = (bus_port, voice_port, public_port)
    if len(set(ports)) != 3 or any(not 1 <= port <= 65535 for port in ports):
        raise ValueError('Public and internal ports must be distinct valid ports')
    bus_url = f'http://127.0.0.1:{bus_port}'
    voice_url = f'http://127.0.0.1:{voice_port}'
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopping.set)
    children = []
    waits = []
    stop_wait = asyncio.create_task(stopping.wait())

    async def launch(name, command, cwd, env):
        process = await asyncio.create_subprocess_exec(*command, cwd=cwd, env=env)
        children.append((name, process))
        return process

    async def ready(process, url):
        deadline = loop.time() + 60
        while loop.time() < deadline and not stopping.is_set():
            if process.returncode is not None:
                raise RuntimeError('An API service exited during startup')
            try:
                def check():
                    with urllib.request.urlopen(url, timeout=2) as response:
                        return response.status == 200
                if await asyncio.to_thread(check):
                    return
            except (OSError, TimeoutError):
                pass
            await asyncio.sleep(0.2)
        if not stopping.is_set():
            raise RuntimeError('API readiness timed out')

    try:
        bus_env = os.environ.copy()
        bus_env.pop('GEMINI_API_KEY', None)
        voice_env = os.environ.copy()
        voice_env.pop('RTS_API_KEY', None)
        voice_env['BUS_SERVICE_URL'] = bus_url
        bus = await launch('bus API', [sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1',
            '--port', str(bus_port), '--workers', '1', '--no-access-log'], ROOT / 'bus-service', bus_env)
        voice = await launch('voice API', [sys.executable, '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1',
            '--port', str(voice_port), '--workers', '1', '--no-access-log'], ROOT / 'voice-service', voice_env)
        await asyncio.gather(ready(bus, bus_url + '/api/buses/health'), ready(voice, voice_url + '/api/voice/health'))
        if stopping.is_set():
            return 0
        web_env = os.environ.copy()
        for key in ('RTS_API_KEY', 'GEMINI_API_KEY'):
            web_env.pop(key, None)
        web_env.update(BUS_SERVICE_URL=bus_url, VOICE_SERVICE_URL=voice_url, PORT=str(public_port),
            HOST='0.0.0.0', NODE_ENV='production')
        if os.getenv('RENDER_EXTERNAL_URL'):
            web_env['PUBLIC_URL'] = os.environ['RENDER_EXTERNAL_URL']
        await launch('web gateway', ['node', 'server/production.ts'], ROOT / 'web', web_env)
        waits = [asyncio.create_task(process.wait()) for _, process in children]
        await asyncio.wait([stop_wait, *waits], return_when=asyncio.FIRST_COMPLETED)
        if stopping.is_set():
            return 0
        print('A service exited; stopping the app so the host can restart it.', file=sys.stderr)
        return 1
    finally:
        for _, process in children:
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
        try:
            await asyncio.wait_for(asyncio.gather(*(p.wait() for _, p in children)), timeout=10)
        except TimeoutError:
            for _, process in children:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
            await asyncio.gather(*(p.wait() for _, p in children))
        for task in [stop_wait, *waits]:
            task.cancel()
        await asyncio.gather(stop_wait, *waits, return_exceptions=True)


if __name__ == '__main__':
    try:
        sys.exit(asyncio.run(serve()))
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
