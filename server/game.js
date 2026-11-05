
const tileTypes = [
  "1m", "9m",
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}s`),
  "E", "S", "W", "N", "H", "F", "C"
];

function shuffledTiles() {
  const tiles = tileTypes.flatMap(code =>
    Array.from({ length: 4 }, (_, copy) => ({
      id: `${code}-${copy}`,
      code,
      red: (code === "5p" || code === "5s") && copy === 0
    }))
  );

  const random = new Uint32Array(1);
  const max = 2 ** 32;

  for (let i = tiles.length - 1; i > 0; i--) {
    const range = i + 1;
    const limit = Math.floor(max / range) * range;
    let number;

    do {
      crypto.getRandomValues(random);
      number = random[0];
    } while (number >= limit);

    const j = number % range;
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }

  return tiles;
}

export function createTestGame(players) {
  if (players.length !== 3) {
    throw new Error("Three players are required");
  }

  const tiles = shuffledTiles();
  const deadWall = tiles.splice(-14);
  const hands = [[], [], []];

  for (let count = 0; count < 13; count++) {
    for (let seat = 0; seat < 3; seat++) {
      hands[seat].push(tiles.pop());
    }
  }

  hands[0].push(tiles.pop());

  return {
    phase: "playing",
    players,
    hands,
    wall: tiles,
    deadWall,
    discards: [[], [], []],
    turn: 0,
    actionId: 0
  };
}

export function applyDiscard(
  game, playerId, tileId, actionId
) {
  if (
    game.phase !== "playing" ||
    game.actionId !== actionId
  ) {
    return false;
  }

  const seat = game.players.findIndex(
    p => p.id === playerId
  );

  if (seat !== game.turn) return false;

  const hand = game.hands[seat];
  const position = hand.findIndex(
    t => t.id === tileId
  );

  if (position === -1) return false;

  game.discards[seat].push(
    hand.splice(position, 1)[0]
  );
  game.actionId++;

  while (true) {
    if (game.wall.length === 0) {
      game.phase = "finished";
      break;
    }

    game.turn = (game.turn + 1) % 3;

    const drawn = game.wall.pop();
    game.hands[game.turn].push(drawn);

    if (!game.players[game.turn].com) {
      break;
    }

    // テスト用COMはツモ切りする
    game.discards[game.turn].push(
      game.hands[game.turn].pop()
    );
    game.actionId++;
  }

  return true;
}

export function gameView(game, playerId) {
  const seat = game.players.findIndex(
    p => p.id === playerId
  );

  if (seat < 0) return null;

  return {
    type: "game",
    phase: game.phase,
    players: game.players.map(p => ({
      name: p.name,
      com: p.com
    })),
    discards: game.discards,
    hand: game.hands[seat],
    mySeat: seat + 1,
    turnSeat: game.turn + 1,
    remaining: game.wall.length,
    actionId: game.actionId
  };
}
