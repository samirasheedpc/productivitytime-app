# ProductivityTime — the "all GitHub, no server" version

This `pages/` folder is the **serverless** version of the app. There's no Node
server and nothing to install: it's a web page (on GitHub Pages) that reads and
writes your data **straight to your private GitHub repo** via the GitHub API.

- **App code (this folder):** lives in a **public** repo → served free by GitHub Pages.
  There are no secrets in it (the founder "passwords" are just name labels now).
- **Your data:** stays in the **private** repo `Rali7713/ProductivityTime`, in
  `data/goals.json` — exactly where it is today. Nothing moves.
- **Security:** each person's **GitHub token** is the real lock. Only someone with a
  token that can access the private repo can read or change anything.
- **Live + synced:** everyone reads/writes the same file; the app refreshes every ~8s.

It's built **alongside** your current app — your Node/launchd setup keeps working
until you've confirmed this one, so nothing breaks mid-switch.

---

## One-time setup

### A. Make a public repo for the app
1. github.com → **New repository** → name it e.g. `productivitytime-app` → **Public** → Create.
2. Put the **contents of this `pages/` folder** in it (`index.html`, `app.js`,
   `store.js`, `styles.css`, `manifest.json`, and the `icons/` folder). Drag-and-drop
   in GitHub's web UI is fine, or push with git.

### B. Turn on GitHub Pages
1. In that repo: **Settings → Pages**.
2. Source: **Deploy from a branch** → Branch: **main**, folder: **/ (root)** → Save.
3. A minute later your app is live at
   `https://<your-username>.github.io/productivitytime-app/`. That's the link all
   three of you open (and can "Install as app" from the browser menu).

### C. Each founder makes a token (one-time, on github.com — no download)
Use a **classic** token (works for a repo you're a collaborator on; a fine-grained
one can't reach a teammate's repo):
1. github.com → your avatar → **Settings → Developer settings → Personal access
   tokens → Tokens (classic) → Generate new token (classic)**.
2. Note: `ProductivityTime`. Expiration: your call (e.g. 90 days, or No expiration).
3. Tick the top scope **`repo`** ("Full control of private repositories").
4. **Generate token** and copy it (starts with `ghp_…`).

> A classic `repo` token can touch all repos your account can access, so keep it on
> your own device only (the app stores it locally and never shares it). That's fine
> for a private 3-person tool.

### D. Open and connect
1. Open the Pages link. Enter your password (`Sami100x` / `Reyan100x` / `Ahnaf100x`)
   and paste your token (**first time on each device only** — it's saved in that
   browser, never shared).
2. You're live. Anything you do saves to GitHub; teammates' changes show up within a
   few seconds.

### E. Once you're happy
Stop the old local servers (so there's one path):
- Mac: `launchctl unload ~/Library/LaunchAgents/com.productivitytime.server.plist`
- Windows: remove the ProductivityTime VBS from the Startup folder.

---

## Notes / limits
- Works on phones (it's just a web page — open the link, add to home screen).
- Two people editing at once is safe: each save reloads the latest, re-applies your
  one change, and retries — so nothing is lost and deletes stick.
- If you regenerate or revoke a token, just paste the new one in **Settings → GitHub
  connection**.
- The app reads/writes `data/goals.json` on the `main` branch of
  `Rali7713/ProductivityTime`. To point at a different repo, set `pt_gh_owner` /
  `pt_gh_repo` in the browser's localStorage (advanced; not needed normally).
