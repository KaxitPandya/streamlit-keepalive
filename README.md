# streamlit-keepalive

Keeps Streamlit Community Cloud apps awake, and wakes them automatically when they do fall asleep.

Apps covered — see [`apps.json`](apps.json):

- [Q&A Documents](https://q-adocuments.streamlit.app/)
- [Instagram Caption Generator](https://instagram-caption-generator-smudvyyr8eprlaxctt6ulg.streamlit.app/)
- [AI Support Agent](https://ai-support-agent1.streamlit.app/)

## Why HTTP pings stopped working

A plain `GET https://<app>.streamlit.app/` returns the Community Cloud **dashboard SPA** — a
static React shell — with `HTTP 200` **whether the app is awake or asleep**. It never reaches
the app container.

That breaks ping-based keep-alives in two ways:

1. **No traffic is registered.** The container is never contacted, so the inactivity timer
   doesn't reset.
2. **Monitoring lies.** UptimeRobot and friends report a healthy `200` for an app that is
   fast asleep.

Reverse-engineering the SPA bundle shows how it really works:

| Thing | Location |
| --- | --- |
| Actual Streamlit app | `https://<app>.streamlit.app/~/+/` (an **iframe**) |
| Real container health | `https://<app>.streamlit.app/~/+/_stcore/health` → `ok` |
| Sleep screen | outer frame, `[data-testid="wakeup-button-viewer"]` |

Reaching the app also requires completing a redirect handshake that sets
`_streamlit_csrf` / `streamlit_session` cookies — `curl` without a cookie jar just
loops between `/-/auth/app` and `/-/login`.

## What this does instead

[`keepalive.js`](keepalive.js) visits each app the way a real visitor does:

1. Checks `/~/+/_stcore/health` (cheap, and unlike the app root it tells the truth).
2. Loads the page in headless Chromium.
3. If the sleep screen is up, clicks **"Yes, get this app back up!"** and waits for boot.
4. Confirms `[data-testid="stApp"]` rendered inside the `/~/+/` iframe, then dwells a few
   seconds so the session registers.

Runs every 6 hours via [GitHub Actions](.github/workflows/keepalive.yml), and writes a status
table to the job summary. Exit code is non-zero if any app errored or failed to wake.

> **Prevent vs. wake.** Whether a headless visit resets the undocumented ~7-day sleep timer
> can't be verified from outside without waiting it out. That's deliberately not what this
> relies on: even if an app does sleep, the next scheduled run wakes it — so the worst case is
> a ≤6-hour window rather than an app that stays down until you notice.

## Setup

Push this to a **public** repo (Actions minutes are free for public repos), then:

`Settings → Actions → General → Workflow permissions → Read and write permissions`

That's required for the heartbeat step. Trigger a first run from the **Actions** tab
(**Run workflow**) to confirm it's green.

To add or remove apps, edit `apps.json`.

## The 60-day gotcha

**GitHub automatically disables scheduled workflows in repos with no commit activity for 60
days** — silently. If your previous keep-alive was a GitHub Action, this is the most likely
reason it stopped.

The `Heartbeat commit` step writes a timestamp to `.last-run` on each scheduled run, which
keeps the repo active and the schedule enabled indefinitely.

## Running locally

```bash
npm install
npx playwright install chromium
node keepalive.js
```

Sample output:

```
=== q-adocuments
   [14.7s] health: ok
   [20.7s] AWAKE — app already rendered
```
