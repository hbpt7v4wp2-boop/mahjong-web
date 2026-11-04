
import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const isWebSocket =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (!isWebSocket) {
      return new Response(
        path === "/" ? "Mahjong WebSocket server is running!" : "WebSocket required",
        { status: path === "/" ? 200 : 426 }
      );
    }

    // Keep the existing Version 0.2 echo test working.
    if (path === "/") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => {
        if (typeof event.data === "string" && event.data.length <= 1000) {
          server.send("Echo: " + event.data);
        }
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    const match = path.match(/^\/room\/([A-Z0-9]{6})$/);
    if (!match) return new Response("Invalid room code", { status: 400 });
    return env.ROOM.getByName(match[1]).fetch(request);
  }
};

export class MahjongRoom extends DurableObject {
  async fetch(request) {
    if (this.ctx.getWebSockets().length >= 3) {
      return new Response("Room full", { status: 403 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "joined" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 512) return;
    let packet;
    try {
      packet = JSON.parse(message);
    } catch {
      return;
    }
    if (packet?.type !== "chat" || typeof packet.text !== "string") return;
    const text = packet.text.trim();
    if (!text || text.length > 100) return;

    const outgoing = JSON.stringify({ type: "chat", text });
    for (const peer of this.ctx.getWebSockets()) {
      try { peer.send(outgoing); } catch {}
    }
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
  }
}
