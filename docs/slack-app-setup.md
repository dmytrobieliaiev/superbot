# Slack App setup (M1.2)

One-time manual setup. ~5 min.

## 1. Create the app from manifest

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From a manifest**
3. Pick your workspace (the single internal workspace)
4. Paste contents of `docs/slack-app-manifest.yaml`
5. Click **Create**

The manifest registers:
- Bot user named "superbot" (shows **App** badge in Slack)
- All required OAuth scopes
- Socket Mode enabled
- Slash commands: `/ask`, `/memory`, `/forget`, `/remember`, `/skill`, `/audit`, `/help`
- Event subscriptions: `app_mention`, `message.*`, `reaction_added`
- Interactivity enabled

## 2. Generate tokens

### Bot token (`xoxb-...`)
- **OAuth & Permissions** → **Install to Workspace** → **Allow**
- Copy **Bot User OAuth Token** → `.env` as `SLACK_BOT_TOKEN`

### App-level token (`xapp-...`)
- **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**
- Name: `socket`, scope: `connections:write`
- Copy token → `.env` as `SLACK_APP_TOKEN`

### Signing secret
- **Basic Information** → **App Credentials** → **Signing Secret**
- Copy → `.env` as `SLACK_SIGNING_SECRET`

## 3. Verify in code

```bash
pnpm dev
```

You should see:
```
slack auth ok { bot_user_id: 'U0...' }
```

## 4. Test in Slack

In any channel where the bot is added (or invite it with `/invite @superbot`):

```
@superbot hello
```

Bot should receive the event (visible in logs as `turn enqueued`).
Tool-loop response wiring comes in M2.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `slack auth.test failed` | Bot token wrong or app not reinstalled after scope change |
| `socket connect failed` | App-level token wrong scope (needs `connections:write`) |
| No event received | App not invited to the channel; or event subscriptions missing |
| Duplicate events | Expected — Redis dedupe drops them; check `dedup_hit` debug logs |
