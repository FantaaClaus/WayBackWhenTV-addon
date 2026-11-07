# 📺 Rewind TV

A Nuvio / Stremio addon for old-school TV night: classic TV episodes, cartoons, movies, vintage commercials, shorts and newsreels from the Internet Archive.

It only lists items the Archive tags as **public domain or Creative Commons**, and it only links to the Archive's own files. It doesn't host any video.

## Rows you get in Nuvio

| Row | Source |
|---|---|
| Rewind: Classic TV | Archive "Classic TV" collection |
| Rewind: Cartoons | Classic Cartoons + Animation & Cartoons |
| Rewind: Movies | Feature Films |
| Rewind: Vintage Commercials | Prelinger Archives (ads) |
| Rewind: Shorts & Newsreels | Prelinger + News & Public Affairs |

Each row shows the 200 most-watched items and has genre filters: Comedy, Drama, Western, Sci-Fi, Horror, Noir, Mystery, Kids, Music.

## Setup (one time, about 10 minutes)

1. Make a free account at github.com if you don't have one.
2. Create a new **public** repository (yours is `WayBackWhenTV-addon`) (top right **+** → New repository).
3. On the new repo page, click **uploading an existing file** and drag in everything from this folder: `build.mjs`, `README.md`, `.gitignore`, and the `.github` folder. Commit.
   - If the `.github` folder won't drag in, create the file by hand: **Add file → Create new file**, name it `.github/workflows/build.yml`, and paste in the contents.
4. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
5. Go to the **Actions** tab, pick **Build Rewind TV addon**, and click **Run workflow**. The first build takes about 5–15 minutes.
6. When it goes green, your addon is live at:

   ```
   https://fantaaclaus.github.io/WayBackWhenTV-addon/manifest.json
   ```

7. In Nuvio: **Settings → Addons → Add Addon**, paste that URL, then **Install**.

The catalog refreshes itself every Monday. To refresh it sooner, hit **Run workflow** again.

## Tweaks

- **More items per row:** in `build.yml`, change the build step to `run: PAGES=8 node build.mjs` (400 per row). Each extra page makes the build longer.
- **Add or change rows:** edit the `CHANNELS` list at the top of `build.mjs`. Each row is just an Archive search.
- **Search:** not supported. A static addon can't answer search queries, so browse the rows and genres instead.

---

# 📺 Rewind Cable

A cable-style lineup of 70s–2000s TV: about 56 numbered channels (Happy Days, Cheers, Saved by the Bell, Star Trek, MST3K, The Price Is Right Barker era, Yo! MTV, Vevo 80s/90s and more). All of it comes from free, licensed, ad-supported services (Pluto TV, Samsung TV Plus, Xumo, Roku, Tubi, Plex), with their regular commercial breaks. The guide and channel links refresh every 3 hours.

- **Nuvio addon:** `https://fantaaclaus.github.io/WayBackWhenTV-addon/cable/manifest.json`
- **Live TV / IPTV playlist (channel numbers + guide):** `https://fantaaclaus.github.io/WayBackWhenTV-addon/cable/lineup.m3u`
- **Guide (EPG):** `https://fantaaclaus.github.io/WayBackWhenTV-addon/cable/guide.xml.gz`
- **Lineup page:** `https://fantaaclaus.github.io/WayBackWhenTV-addon/cable/`

To change channel numbers, add channels or remove them, edit `lineup.json`. The next build picks up the changes.
