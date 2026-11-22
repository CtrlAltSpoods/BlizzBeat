# Third-party software

Blizzbeat's own code is under the [MIT License](LICENSE). The Docker image also contains, downloads or
installs the software below. Each keeps its own license; Blizzbeat's license does not apply to it.

## npm packages (installed into the image)

| Package | License |
|---|---|
| [discord.js](https://github.com/discordjs/discord.js) (and its `@discordjs/*` packages) | Apache-2.0 |
| [lavalink-client](https://github.com/Tomato6966/lavalink-client) | MIT |

Their own dependencies are listed in `package-lock.json`, each with its license.

## Audio engine

| Software | License | How it's included |
|---|---|---|
| [Lavalink](https://github.com/lavalink-devs/Lavalink) (with [Lavaplayer](https://github.com/lavalink-devs/lavaplayer)) | MIT (Lavaplayer: Apache-2.0) | `Lavalink.jar` downloaded at build time; newer releases by the in-container updater |
| [youtube-source](https://github.com/lavalink-devs/youtube-source) (Lavalink plugin) | MIT | Downloaded by Lavalink at startup |
| [LavaSrc](https://github.com/topi314/LavaSrc) (Lavalink plugin) | Apache-2.0 | Downloaded by Lavalink at startup |

## Tools

| Software | License | How it's included |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | Release download at build time; updates by the in-container updater |
| [yt-dlp/ejs](https://github.com/yt-dlp/ejs) | Unlicense | Built into yt-cipher at build time |
| [yt-cipher](https://github.com/kikkia/yt-cipher) | **No license stated** by its author | Built from source at build time (see the note below) |
| [Deno](https://github.com/denoland/deno) | MIT | Copied from the official `denoland/deno` image |
| [FFmpeg](https://ffmpeg.org/) (Debian package) | GPL-2.0-or-later (Debian's build enables GPL parts) | Installed with apt |
| [OpenJDK 17](https://openjdk.org/) (Debian package) | GPL-2.0 with the Classpath Exception | Installed with apt |
| [Node.js](https://github.com/nodejs/node) | MIT | Base image `node:22-bookworm-slim` |
| [tini](https://github.com/krallin/tini) | MIT | Installed with apt |
| Debian (base system) | Various free-software licenses | Base image; see `/usr/share/doc/*/copyright` inside the container |

Source code for the GPL components is available from Debian (`apt-get source <package>`) and from the
projects linked above.

**yt-cipher:** its repository has no license file, which by default means its author keeps all rights.
Blizzbeat builds it from its public source so the YouTube plugin can decode stream signatures. If you
redistribute the image and want to avoid it, set `YOUTUBE_BUILTIN_CIPHER=false` at runtime, or remove
the `ytcipher` stage from the Dockerfile.

## Services

Blizzbeat talks to Discord, YouTube, Spotify, SoundCloud and other sites. Using them is subject to their
own terms of service.
