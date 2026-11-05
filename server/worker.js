
import { DurableObject } from "cloudflare:workers";

import {
  createTestGame,
  applyDiscard,
  gameView
} from "./game.js";


const send = (ws, data) => {
  try {
    ws.send(JSON.stringify(data));
  } catch (_) {}
};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const websocket =
      request.headers.get("Upgrade")?.toLowerCase()
      === "websocket";

    if (!websocket) {
      return new Response(
        path === "/"
          ? "Mahjong WebSocket server is running!"
          : "WebSocket required",
        { status: path === "/" ? 200 : 426 }
      );
    }

    if (path === "/") {
      const [client, server] =
        Object.values(new WebSocketPair());

      server.accept();
      server.addEventListener("message", event => {
        if (
          typeof event.data === "string" &&
          event.data.length <= 1000
        ) {
          server.send("Echo: " + event.data);
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    const match =
      /^\/room\/([A-Z0-9]{6})$/.exec(path);

    if (!match) {
      return new Response("Invalid room code", {
        status: 400
      });
    }

    return env.ROOM.getByName(match[1]).fetch(request);
  }
};

export class MahjongRoom extends DurableObject {
  members() {
    return this.ctx.getWebSockets()
      .filter(ws => ws.readyState === WebSocket.OPEN)
      .map(ws => ({
        ws,
        data: ws.deserializeAttachment()
      }))
      .filter(item => item.data?.id)
      .sort((a, b) =>
        a.data.joinedAt - b.data.joinedAt
      );
  }

  broadcastState() {
    const members = this.members();

    const players = members.map(({ data }, index) => ({
      seat: index + 1,
      name: data.name,
ready: index === 0 || data.ready,

      host: index === 0
    }));
    
    
    if (members[0]?.data.comEnabled) {
      players.push({
        seat: 3,
        name: "COM（テスト）",
        ready: true,
        host: false,
        com: true
      });
    }


    members.forEach(({ ws }, index) => {
      send(ws, {
        type: "state",
        selfSeat: index + 1,
        players
      });
    });
  }
  
  
  broadcastGame(game) {
    for (const { ws, data } of this.members()) {
      const view = gameView(game, data.id);
      if (view) send(ws, view);
    }
  }


  async fetch() {
    if (this.ctx.getWebSockets().length >= 6) {
      return new Response("Too many connections", {
        status: 429
      });
    }

    const [client, server] =
      Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

async webSocketMessage(ws, message) {

    if (
      typeof message !== "string" ||
      message.length > 700
    ) return;

    let packet;
    try {
      packet = JSON.parse(message);
    } catch {
      return;
    }

    if (!packet || typeof packet !== "object") {
      return;
    }

    const current = ws.deserializeAttachment();


    const game =
      await this.ctx.storage.get("testGame");


    if (!current) {
      if (packet.type !== "join") return;

      const name =
        typeof packet.name === "string"
          ? packet.name
              .replace(/[\u0000-\u001f\u007f]/g, "")
              .trim()
              .slice(0, 12)
          : "";

      const id =
        typeof packet.id === "string"
          ? packet.id
          : "";

      if (!name || !/^[0-9a-f-]{36}$/i.test(id)) {
        send(ws, {
          type: "notice",
          text: "名前または参加情報が不正です"
        });
        ws.close(1008, "Invalid join");
        return;
      }
      
      
      if (
        game?.phase === "playing" &&
        !game.players.some(p => p.id === id)
      ) {
        send(ws, {
          type: "notice",
          text: "対局中のため新規参加できません"
        });
        ws.close(1008, "Game in progress");
        return;
      }


      const members = this.members();
      const previous =
        members.find(member => member.data.id === id);

      
      
      if (
        !previous &&
        (
          members.length >= 3 ||
          (
            members.length >= 2 &&
            members[0]?.data.comEnabled
          )
        )
      ) {
        send(ws, {
          type: "notice",
          text: "満席です"
        });
        ws.close(1008, "Room full");
        return;
      }

      if (previous) {

        previous.ws.serializeAttachment(null);
        previous.ws.close(
          1000,
          "Replaced by another tab"
        );
      }

      ws.serializeAttachment({
        id,
        name,
        ready: previous?.data.ready ?? false,
        joinedAt:
          previous?.data.joinedAt ??
          Math.max(
            Date.now() * 1000,
            0,
            ...members.map(
              member => member.data.joinedAt + 1
            )
          ),
        
        lastChat: 0,
        comEnabled: previous?.data.comEnabled ?? false

      });

      
      this.broadcastState();
      if (game) this.broadcastGame(game);
      return;

    }


    if (packet.type === "discard") {
      if (
        game &&
        typeof packet.tileId === "string" &&
        Number.isSafeInteger(packet.actionId) &&
        applyDiscard(
          game,
          current.id,
          packet.tileId,
          packet.actionId
        )
      ) {
        await this.ctx.storage.put(
          "testGame", game
        );
        this.broadcastGame(game);
      }
      return;
    }

    if (
      game?.phase === "playing" &&
      packet.type !== "chat"
    ) {
      return;
    }


    if (
      packet.type === "ready" &&
      typeof packet.ready === "boolean"
    ) {
      ws.serializeAttachment({
        ...current,
        ready: packet.ready
      });
      this.broadcastState();
    }

    if (
      packet.type === "chat" &&
      typeof packet.text === "string"
    ) {
      const text = packet.text
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 100);

      if (
        !text ||
        Date.now() - current.lastChat < 750
      ) return;

      ws.serializeAttachment({
        ...current,
        lastChat: Date.now()
      });

      for (const peer of this.members()) {
        send(peer.ws, {
          type: "chat",
          name: current.name,
          text
        });
      }
    }


    if (
      packet.type === "com" &&
      typeof packet.enabled === "boolean"
    ) {
      const members = this.members();

      if (members[0]?.ws !== ws) return;

      if (
        packet.enabled &&
        members.length !== 2
      ) return;

      ws.serializeAttachment({
        ...current,
        comEnabled: packet.enabled
      });

      this.broadcastState();
      return;
    }


    
    if (packet.type === "start") {
      const members = this.members();

      if (members[0]?.ws !== ws) return;

      const hasCom =
        !!members[0]?.data.comEnabled;

      if (
        members.length + (hasCom ? 1 : 0) !== 3 ||

        members.some((m, index) =>
          index !== 0 && !m.data.ready
        )

      ) return;

      if (game?.phase === "playing") return;

      const players = members.map(m => ({
        id: m.data.id,
        name: m.data.name,
        com: false
      }));

      if (hasCom) {
        players.push({
          id: "COM",
          name: "COM（テスト）",
          com: true
        });
      }

      const nextGame = createTestGame(players);

      await this.ctx.storage.put(
        "testGame", nextGame
      );

      this.broadcastGame(nextGame);
      return;
    }

  }

  webSocketClose() {
    this.broadcastState();
  }

  webSocketError() {
    this.broadcastState();
  }
}
