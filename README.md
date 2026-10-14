# Moodle Remote MCP Server

A read-only [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers
that exposes **your own** Moodle account to Gemini and Claude, from phone or web.
It serves courses, deadlines, announcements, Moodle messages, forums, grades, and
course files. It never writes to Moodle, and your Moodle token never leaves the
server.

It is site-agnostic: point `MOODLE_BASE_URL` at any Moodle instance and the REST
endpoint and file paths are derived from it. Sign-in is Google, restricted to a
single account (yours). Moodle-hosted files are delivered both inline (so the
model can read them) and as a short-lived signed link.

> **Status:** fully implemented and tested (80 tests passing). The one remaining
> step is yours: the U6 deploy-and-connect checkpoint below, which takes it live
> and confirms which Moodle functions your site allows.

---

## Tools

| Tool | What it does |
|---|---|
| `get_my_info` | Your name, username, user id, site name |
| `list_courses` | Enrolled courses (all / inprogress / future / past) |
| `get_course_contents` | A course's sections, activities, and file references |
| `get_file` | Read a Moodle-hosted file (text inline, PDF/image as attachment, large → link) |
| `get_upcoming_deadlines` | Deadlines and calendar events across courses (activities + exams) |
| `get_recent_announcements` | News-forum posts across in-progress courses — find cancellations here |
| `get_messages` | Your recent Moodle direct-message conversations (read-only) |
| `list_forums` / `get_forum_discussions` / `get_discussion_posts` | Browse forums and read posts, with attachments as readable refs |
| `get_grades` | Your grade items for a course |
| `get_references` | A course's external links (web / Drive / YouTube / PDF) and book citations |

Every tool is read-only. Files attached to posts and files linked inside course
text are delivered through the same signed `get_file` references as course files.

---

## Prerequisites

- A Cloudflare account (the **Workers Paid** plan, $5/mo, is recommended — the
  free plan's 10 ms CPU limit is tight for the OAuth crypto; start on free and
  upgrade if you hit limits).
- Node.js 20+ and this repo checked out. Install deps: `npm install`.
- Your Moodle Mobile web service token (you already have `MOODLE_TOKEN`).
- A Google account (the same one your Gemini uses).

---

## Setup (Windows / PowerShell)

### 1. Create the KV namespace

```powershell
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc` (replace `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID`).

### 2. Create a Google OAuth client

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create an **OAuth client ID** → **Web application**.
3. Under **Authorized redirect URIs**, add (fill in your worker host after the
   first deploy, then come back and add it):
   `https://moodle-mcp.<your-subdomain>.workers.dev/callback`
4. Note the **Client ID** and **Client secret**.

### 3. Find your Google `sub` (the allowed account id)

Your `sub` is a stable numeric id, not your email. You don't need it up front:
deploy with `ALLOWED_GOOGLE_SUB` left unset, then open `https://<worker-host>/authorize`
(or just start the connector sign-in) and sign in with Google. While the server
is unconfigured it shows your `sub` on a setup page instead of denying you. Set
that value as `ALLOWED_GOOGLE_SUB` and redeploy — only that account is admitted
afterward.

### 4. Set the secrets

```powershell
npx wrangler secret put MOODLE_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_GOOGLE_SUB
# openssl rand -base64 32
npx wrangler secret put COOKIE_ENCRYPTION_KEY
# a kid:secret pair, newest first — e.g.  k1:<openssl rand -base64url 32>
npx wrangler secret put LINK_SIGNING_KEYS
```

Never put these in `wrangler.jsonc` or commit them. For local `wrangler dev`,
copy `.dev.vars.example` to `.dev.vars` (gitignored) instead.

### 5. Deploy

```powershell
npx wrangler deploy
```

Note the deployed URL, add `<url>/callback` to the Google client's redirect URIs
(step 2.3), and your MCP URL is `<url>/mcp`.

---

## U6 — Two-client checkpoint

This is the first real test and the gate for U7–U9. Do it after deploying.

### Run the live smoke check (which Moodle functions your site allows)

```powershell
$env:MOODLE_TOKEN = "<your token>"
npm run smoke
```

Record each result below.

### Connect Claude

Settings → Connectors → Add custom connector → enter `<url>/mcp`. Sign in with
Google when prompted. Ask: *"list my courses"*, then *"show contents of course
1127 and read the first PDF"*.

### Connect Gemini

Gemini (personal account, web) → Connectors → **+ Custom** → **Connect to an MCP
server** → enter `<url>/mcp`, leave Client ID / secret **blank**, **Next**, and
sign in with Google. It connects via automatic registration — no extra steps.

Gemini registers several *user-bound* redirect URIs on Google's OAuth-redirect
hosts (prod/sandbox/test, `/r/` and `/a/` paths), each carrying your Google
`sub`. The server recognises these by pattern and admits only the ones carrying
`ALLOWED_GOOGLE_SUB`, so Gemini works out of the box while another account's
Gemini is still refused. (`GEMINI_REDIRECT_DISCOVERY` and `EXTRA_REDIRECT_URIS`
remain for adding any other client's exact callback, but Gemini needs neither.)

### Record results

| Check | Claude | Gemini |
|---|---|---|
| Sign-in (only your Google account) | ☐ | ☐ |
| `list_courses` returns courses | ☐ | ☐ |
| Reads a lecture **PDF** inline | ☐ | ☐ |
| Reads a **scanned** PDF | ☐ | ☐ |
| Opens the download **link** | ☐ | ☐ |
| Largest PDF read inline (set `INLINE_FILE_CAP_BYTES` from this) | ___ MB | ___ MB |

**Moodle functions on your site** (from `npm run smoke`):

| Function | Status |
|---|---|
| core_webservice_get_site_info | ☐ |
| …get_enrolled_courses_by_timeline_classification | ☐ |
| core_course_get_contents | ☐ |
| core_calendar_get_action_events_by_timesort | ☐ |
| core_calendar_get_calendar_upcoming_view | ☐ |
| mod_forum_get_forums_by_courses | ☐ |
| core_message_get_conversations | ☐ |
| gradereport_user_get_grade_items | ☐ |

**If a client cannot open links at all** (Claude's fetch tool does not accept
URLs from connector results), that is expected — the inline content path covers
it. **If neither inline nor link works in a client**, stop: a provenance-based
refusal has no storage workaround. Cloudflare R2 storage or a custom domain
helps only if the failure is domain distrust or unreliable fetches.

---

## Kill switch and rotation

**Cut off all access immediately**, in increasing severity:

```powershell
# 1. Return 503 from every route
npx wrangler kv key put --binding OAUTH_KV killswitch:enabled 1
# 2. Rotate link-signing keys (invalidates outstanding file links)
npx wrangler secret put LINK_SIGNING_KEYS        # new k2:... first, drop the old kid
# 3. Reset the Moodle token — the ONLY way to neutralise its write capability
#    Moodle → Preferences → Security keys → reset, then:
npx wrangler secret put MOODLE_TOKEN
```

Re-enable: `npx wrangler kv key delete --binding OAUTH_KV killswitch:enabled`.

**If the token stops working**, the connector reports it. Regenerate via the
Moodle mobile launch method or `/login/token.php?service=moodle_mobile_app`,
`wrangler secret put MOODLE_TOKEN`, and reset the old key under Security keys.

---

## Security notes

- The Moodle token is a Worker secret, sent only to the Moodle host, only in a
  POST body (web-service calls) or appended server-side to a pluginfile GET
  (downloads). It never appears in tool output, links, or logs.
- Read-only is enforced by an explicit allowlist of Moodle functions
  (`src/moodle/client.ts`). No write function is in it. The token itself can
  write, so if it ever leaks, reset it (above).
- Sign-in admits only `ALLOWED_GOOGLE_SUB`, checked on every authorization.
- File links are HMAC-signed, expire in ~15 minutes, open exactly one file, and
  carry no token. A link is a bearer capability while valid — don't paste one
  into a shared chat.
- **Untrusted content:** text from Moodle (posts, messages, file contents) and
  anything an agent opens is data, not instructions. The server labels it, but
  an agent with Gmail/Calendar actions could still be steered by a hostile post.
  Treat that as a residual risk.
- **Rate limiting:** a Workers Rate Limiting binding caps requests per user
  (tool calls) and per IP (the open `/register` and `/authorize` endpoints), so
  one caller can't exhaust KV or hammer your Moodle site. It fails open if the
  binding is unavailable, so it never breaks normal use.

---

## Development

```powershell
npm test            # 80 tests, in the Workers runtime, no live Moodle
npm run typecheck
npm run deploy:dry  # bundle without deploying
npm run dev         # local wrangler dev (needs .dev.vars)
```
