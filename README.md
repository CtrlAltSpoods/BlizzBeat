# Blizzbeat

![Blizzbeat banner](assets/banner.png)

A self-hosted Discord music bot with a dedicated player channel, in the spirit of the old music-request-channel bots. One Docker container runs both the bot and its own [Lavalink](https://github.com/lavalink-devs/Lavalink) audio server. You don't need to host anything else.

## What it does

- **Player channel.** `/setup create` makes a `#blizzbeat` channel with a banner at the top and a single player message under it. The player message is **edited in place**, never re-posted. It shows the song, artwork, a progress bar, who requested it, volume, loop mode and the upcoming queue.
- **Type to queue.** Anyone in a voice channel can type a song name or link in the Blizzbeat channel. The message is removed and the song is queued, so the channel stays clean.
- **Buttons** on the player: ⏮️ previous, ⏯️ pause/resume, ⏭️ skip, ⏹️ stop, 🔉/🔊 volume, 🔀 shuffle, 🔁 loop.
- **Slash commands** for everyone (`/play` with live search suggestions) and for admins (`/setup`, `/config`).
- **Sources:** YouTube, YouTube Music, SoundCloud, Bandcamp, Twitch, Vimeo, plus Spotify links and search once you add Spotify credentials.
- Per-server settings are stored in SQLite and kept across restarts and updates.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it `Blizzbeat`.
2. Optional: under **General Information**, upload `assets/avatar.png` as the app icon.
3. Under **Bot**:
   - Click **Reset Token** and copy the token. It goes in `DISCORD_TOKEN`.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Type-to-queue needs it.
   - Optional: upload `assets/avatar.png` as the bot avatar.
4. Start the container (next step). On startup the logs print an **invite link** with the right permissions. Open it to add Blizzbeat to your server.

## 2. Run it

```bash
git clone https://github.com/CtrlAltSpoods/Blizzbeat.git
cd Blizzbeat
cp .env.example .env      # then put your DISCORD_TOKEN in .env
docker compose up -d --build
docker compose logs -f    # watch it start; copy the invite link it prints
```

The first start takes a minute while Lavalink downloads its YouTube and Spotify plugins. They're cached in a volume after that.

If you don't want to build it yourself, every push to `main` builds a multi-arch image (amd64 and arm64) to GitHub Container Registry. Swap `build: .` for `image: ghcr.io/ctrlaltspoods/blizzbeat:latest` in `docker-compose.yml`. If the repo is private, run `docker login ghcr.io` first or make the package public.

Running it without Compose:

```bash
docker build -t blizzbeat .
docker run -d --name blizzbeat --restart unless-stopped --env-file .env \
  -v blizzbeat-data:/data -v blizzbeat-plugins:/opt/lavalink/plugins blizzbeat
```

## 3. Set it up in your server

1. Run `/setup create` to make `#blizzbeat`, or use `/setup create channel:#your-channel` to use an existing channel.
2. Join a voice channel and type a song name in `#blizzbeat`, or use `/play`.

Blizzbeat needs these permissions in its channel: View Channel, Send Messages, Embed Links, Attach Files, Read Message History and **Manage Messages** (to clean up requests). It also needs Connect and Speak in voice channels. The invite link asks for all of them.

## Commands

### Everyone

| Command | What it does |
|---|---|
| `/play song:<name or URL> [next]` | Play or queue a song, playlist or album. Suggestions appear as you type. `next:true` puts it at the front of the queue. |
| `/pause` `/resume` | Pause or resume |
| `/skip [count]` | Skip one or more songs |
| `/previous` | Play the previous song again |
| `/stop` | Stop and clear the queue (stays in the voice channel) |
| `/queue [page]` | Show the queue |
| `/nowplaying` | Show the current song |
| `/volume [level]` | Show or set the volume |
| `/seek time:<1:30>` | Jump to a time in the song |
| `/loop [off/song/queue]` | Set the loop mode, or cycle through modes if left empty |
| `/shuffle` `/clear` | Shuffle or clear the queue |
| `/remove position` `/move from to` | Edit the queue |
| `/leave` | Disconnect from voice |
| `/help` | Quick guide |

Commands used inside the Blizzbeat channel reply privately so the channel stays clean.

### Admins (Manage Server)

| Command | What it does |
|---|---|
| `/setup create [channel]` | Create or choose the player channel and post the banner and player |
| `/setup refresh` | Re-post the banner and player at the bottom of the channel |
| `/setup remove` | Remove the player (the channel itself is kept) |
| `/config view` | Show all settings |
| `/config default-volume` | Volume Blizzbeat starts at when it joins |
| `/config max-volume` | Highest volume anyone can set |
| `/config voice-channels allow/disallow/list/clear` | Limit which voice channels Blizzbeat can join |
| `/config dj-role [role]` | Only this role can control playback. Everyone can still request songs and skip their own, and anyone alone with the bot counts as DJ. |
| `/config request-role [role]` | Only this role can add songs |
| `/config queue-limit` | Maximum number of songs in the queue |
| `/config user-limit` | Maximum queued songs per person |
| `/config song-length` | Longest song allowed, in minutes |
| `/config playlists` | Allow or block playlists and albums |
| `/config auto-leave` | Minutes to wait before leaving when idle or alone |
| `/config stay-247` | Stay in voice 24/7 |
| `/config search-source` | Where typed song names are searched: YouTube Music, YouTube, SoundCloud or Spotify |
| `/config banner [image]` | Upload a custom banner, or leave empty to restore the default. The banner message is edited, not re-posted. |
| `/config color` | Accent colour of the player embed |
| `/config blocklist add/remove/list` | Block people from using Blizzbeat |
| `/config reset` | Reset every setting to its default (keeps the channel) |

Server owners can also change who sees these commands under **Server Settings → Integrations → Blizzbeat**.

## Configuration (`.env`)

Everything is documented in [`.env.example`](.env.example). The main settings are:

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required** |
| `DEV_GUILD_ID` | — | Register commands to one server instantly while testing |
| `ENABLE_MESSAGE_CONTENT` | `true` | Set to `false` if you can't enable the Message Content intent. `/play` still works. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | — | Turns on Spotify links and search |
| `YOUTUBE_PLUGIN_VERSION` | `1.18.2` | Bump this when YouTube breaks (see below) |
| `DEFAULT_VOLUME`, `MAX_VOLUME`, `DEFAULT_MAX_QUEUE`, `DEFAULT_AUTO_LEAVE_MINUTES`, `DEFAULT_SEARCH_SOURCE` | | Starting values for new servers |
| `PROGRESS_UPDATE_SECONDS` | `10` | How often the progress bar refreshes |
| `JAVA_OPTS` | `-Xms128m -Xmx512m` | Memory for the built-in Lavalink |

## When YouTube stops working

YouTube changes often, and every Lavalink bot breaks from time to time. If songs start failing with errors like "This video is unavailable" or "Sign in to confirm you're not a bot":

1. **Update the YouTube plugin.** Set `YOUTUBE_PLUGIN_VERSION` to the latest release from <https://github.com/lavalink-devs/youtube-source/releases>, then run `docker compose up -d`. Lavalink downloads the new version and deletes the old one.
2. **Sign in with OAuth.** Use a burner Google account, not your main one. Set `YOUTUBE_OAUTH_ENABLED=true` and restart. The logs show a `google.com/device` link and a code. Approve it, then copy the refresh token from the logs into `YOUTUBE_OAUTH_REFRESH_TOKEN` so you don't have to repeat this.
3. For more advanced options (`YOUTUBE_PO_TOKEN`, a remote cipher server), see the [youtube-source README](https://github.com/lavalink-devs/youtube-source#readme).

SoundCloud keeps working while you fix YouTube. `/config search-source source:SoundCloud` switches typed searches over to it.

## How it's built

```
Docker container (tini as PID 1)
├── Lavalink 4.2 (Java 17), only listening on 127.0.0.1:2333
│   └── plugins: youtube-source, LavaSrc (Spotify)
└── Blizzbeat (Node 22, discord.js v14, lavalink-client)
    ├── src/controller.js   banner + player message, edited in place with debounced, rate-limited updates
    ├── src/music.js        requests, limits, permissions, controls, auto-leave
    ├── src/commands/       slash command definitions and handlers
    ├── src/events.js       Lavalink/Discord events and type-to-queue
    └── src/db.js           per-server settings (node:sqlite at /data/blizzbeat.sqlite)
```

`docker/entrypoint.sh` writes Lavalink's `application.yml` from your environment variables, starts Lavalink, waits for it to be ready, and then starts the bot. If either process dies, the container exits and Docker restarts it. The health check confirms that Lavalink responds and that the bot has a live Discord connection.

The banner and avatar are generated by `assets/src/make_banner.py`. Edit that script and re-render to change the default artwork.

### Local development (without Docker)

You need Node 22.13 or newer and a Lavalink 4 server you can reach.

```bash
npm install
DISCORD_TOKEN=... LAVALINK_HOST=localhost LAVALINK_PASSWORD=youshallnotpass DATA_DIR=./data npm start
```
