# Custom Jeopardy

A simple host-controlled Jeopardy board you can run on your own computer and play with friends over a call (e.g. Discord). One person (the host) runs the app and shares their screen; buzzing in happens out-of-band (verbally, or by pinging in voice/chat) and the host just clicks the board.

## Quick start (Windows, no Node required)

Download the latest `CustomJeopardy-win-x64.zip` from the [Releases page](https://github.com/nicole-creech/Jeopardy/releases/latest), unzip it, and double-click `CustomJeopardy.exe`. It opens `http://localhost:3000` in your browser automatically.

## Setup from source (any OS)

You need [Node.js](https://nodejs.org/) installed (no other dependencies required).

```bash
git clone https://github.com/nicole-creech/Jeopardy.git
cd Jeopardy
node server.js
```

Then open **http://localhost:3000** in your browser.

## How to use it

- **Home screen** — lists your saved games. Click **+ New Game** to build one from scratch, or **Play**/**Edit** an existing one.
- **Editor** — set the board title, edit each category name, and fill in clues:
  - **Value** — the dollar amount for that row (editable; **+ Add row** / **✕ Remove** a row, and use **▲ ▼** to reorder rows within a category — handy if you added something as a $200 and want it down at $800 later)
  - **Daily Double** checkbox — marks that row as a Daily Double (see the realtime buzzer section below for how it plays out)
  - **Answer** — what the host reveals after the clue
  - **Clue Media (optional)** and **Answer Media (optional)** — click the box then paste (Ctrl+V), drag-and-drop, or click **Browse files…** to attach images, GIFs, video clips, or audio clips (any mix, multiple per clue). Clue media shows right away; answer media stays hidden until the answer is revealed. Dragging an image straight from a webpage works too, not just local files. Video/audio clips are capped at 25MB each since — unlike images — they can't be auto-compressed.
  - Save with **Save Game**, or **Save & Play** to jump straight into the board
- **Board** — click a tile to show its value/images, click again to reveal the answer, then close it and award points to a team from the scoreboard at the bottom. The main +/- buttons match the open clue's value; smaller +100/-100 buttons below them let you give partial credit or make manual corrections. Add/remove teams as needed.

Games are saved as JSON files in the `games/` folder, so you can keep as many custom boards as you want and reuse them for future game nights.

## Realtime buzzer (`feature/buzzer-v2` branch)

If you run `server.js` somewhere your friends can reach (not just `localhost`), they can buzz in for real from their own device instead of over voice chat:

1. Set your own passwords in `config.json` (`playerPassword` and `hostPassword` — change the defaults before hosting publicly).
2. Whoever runs the server opens `http://<server-address>:3000/` and logs in with the **host password** to unlock the board/editor and connect the buzzer.
3. Players open `http://<server-address>:3000/play.html`, enter their name and the **player password**, and get a big BUZZ button.
4. When the host opens a clue, everyone's buzzer unlocks at once. First buzz wins and locks everyone else out; the host sees who buzzed live and marks **✓ Correct** or **✕ Wrong**.
   - **Correct** closes out the clue — buzzers go idle until the next one.
   - **Wrong** excludes just that player and reopens the buzzer for everyone else on the same clue (so someone who's already gotten it wrong can't buzz in again on that clue, but nobody else who hasn't tried yet is penalized).
   - **Reopen buzzer (clear exclusions)** is a manual override if you need to undo an exclusion and let everyone try again.
5. If a player's connection drops and reconnects mid-clue, they're brought back up to date automatically rather than showing a stale buzzer.

The server is the single source of truth for buzz order and who's excluded — player devices never decide this themselves, so a slow or manipulated client can't jump the line.

### Daily Double

Clicking a tile marked **Daily Double** in the editor skips the normal buzzer entirely:

1. The host picks which connected player is wagering and sets a max wager (defaults to the highest dollar value on the board), then clicks **Start Wager**.
2. Only that player sees a wager prompt (everyone else just sees "Daily Double! Waiting on \_\_\_..." with no buzzer). They enter an amount up to the max and lock it in.
3. The host sees the wager land, then clicks **Reveal Clue** — the clue displays using the wagered amount in place of its printed dollar value, and the scoreboard's +/- buttons award/deduct that wagered amount instead of the tile's face value.
4. Closing the clue as normal returns everything to the regular buzzer for the next tile.

## Building the .exe yourself

```bash
npm run build:exe
```

This produces `dist/CustomJeopardy.exe` alongside a `public/` and `games/` folder — copy the whole `dist/` folder wherever you like and double-click `CustomJeopardy.exe`. Any games you create are saved into that same `games/` folder next to the exe.

Building the exe requires Node.js (for the one-time build step only) — the resulting `.exe` does not.
