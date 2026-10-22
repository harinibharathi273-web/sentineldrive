"""WebSocket fan-out to every connected dashboard."""

import asyncio
import logging

log = logging.getLogger("sentinel.hub")


class Hub:
    def __init__(self):
        self.clients = set()
        self.loop = None

    def attach_loop(self):
        self.loop = asyncio.get_running_loop()

    async def broadcast(self, event):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def broadcast_many(self, events):
        for ev in events:
            await self.broadcast(ev)

    def broadcast_threadsafe(self, event):
        """Schedule a broadcast from a worker thread (e.g. after geocoding)."""
        if self.loop is None:
            return
        asyncio.run_coroutine_threadsafe(self.broadcast(event), self.loop)


hub = Hub()
