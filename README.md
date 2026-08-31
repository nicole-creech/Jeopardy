# Custom Jeopardy

A simple host-controlled Jeopardy board you can run on your own computer and play with friends over a call (e.g. Discord). One person (the host) runs the app and shares their screen; buzzing in happens out-of-band (verbally, or by pinging in voice/chat) and the host just clicks the board.

## Quick start (Windows, no Node required)

Download the latest `CustomJeopardy-win-x64.zip` from the [Releases page](https://github.com/nicole-creech/Jeopardy/releases/latest), unzip it, and double-click `CustomJeopardy.exe`. It opens `http://localhost:3000` in your browser automatically.

## Setup from source (any OS)

You need [Node.js](https://nodejs.org/) installed.

```bash
git clone https://github.com/nicole-creech/Jeopardy.git
cd Jeopardy
npm install
node server.js
```

Then open **http://localhost:3000** in your browser.

## How to use it

- **Home screen** — lists your saved games. Click **+ New Game** to build one from scratch, or **Play**/**Edit** an existing one.
- **Editor** — set the board title, edit each category name, and fill in clues:
  - **Value** — the dollar amount for that row (editable, and you can **+ Add row** or **✕ Remove row** per category)
  - **Answer** — what the host reveals after the clue
  - **Image (optional)** — click to upload, paste (Ctrl+V), or drag-and-drop one or more images onto a clue
  - Save with **Save Game**, or **Save & Play** to jump straight into the board
- **Board** — click a tile to show its value/images, click again to reveal the answer, then close it and award points to a team from the scoreboard at the bottom. Add/remove teams as needed.

Games are saved as JSON files in the `games/` folder, so you can keep as many custom boards as you want and reuse them for future game nights.

## Realtime buzzing (experimental — `feature/realtime-buzzing` branch)

If you host `server.js` somewhere reachable by your friends (not just `localhost`), players can join from their own phone/laptop and buzz in for real instead of over Discord voice:

1. Set your own passwords in `config.json` (`playerPassword` and `hostPassword` — defaults are `jeopardy` / `hostpass`, change them before hosting publicly).
2. Whoever runs the server opens `http://<server-address>:3000/` and logs in with the **host password**. This connects them to the live buzzer session and unlocks the usual board/editor.
3. Players open `http://<server-address>:3000/play.html`, enter their name and the **player password**, and get a big BUZZ button.
4. When the host opens a clue, every player's buzzer unlocks at the same moment. The host sees a live, ranked list of who buzzed and how fast (in ms) right inside the clue overlay, and can hit **Reset Buzzers** to reopen buzzing (e.g. after a wrong answer) without changing the clue.

This is an early pass — there's no reconnect/session-recovery handling yet, and scoring still has to be entered manually from the buzz order shown to the host.

```bash
npm run build:exe
```

This produces `dist/CustomJeopardy.exe` alongside a `public/` and `games/` folder — copy the whole `dist/` folder wherever you like and double-click `CustomJeopardy.exe`. Any games you create are saved into that same `games/` folder next to the exe.

Building the exe requires Node.js (for the one-time build step only) — the resulting `.exe` does not.
