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
  - **Value** — the dollar amount for that row (editable, and you can **+ Add row** or **✕ Remove row** per category)
  - **Answer** — what the host reveals after the clue
  - **Image (optional)** — click to upload, paste (Ctrl+V), or drag-and-drop one or more images onto a clue
  - Save with **Save Game**, or **Save & Play** to jump straight into the board
- **Board** — click a tile to show its value/images, click again to reveal the answer, then close it and award points to a team from the scoreboard at the bottom. Add/remove teams as needed.

Games are saved as JSON files in the `games/` folder, so you can keep as many custom boards as you want and reuse them for future game nights.

## Building the .exe yourself

```bash
npm run build:exe
```

This produces `dist/CustomJeopardy.exe` alongside a `public/` and `games/` folder — copy the whole `dist/` folder wherever you like and double-click `CustomJeopardy.exe`. Any games you create are saved into that same `games/` folder next to the exe.

Building the exe requires Node.js (for the one-time build step only) — the resulting `.exe` does not.
