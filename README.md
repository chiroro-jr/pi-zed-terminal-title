# pi-zed-terminal-title

Pi extension for Zed Terminal Threads.

Features:

- Sets Zed terminal title while Pi works/idles
- Uses icons only for status:
  - `⏳️ <title>` while working
  - `✅ <title>` when idle
- Generates a short AI title from the first user prompt
- Persists/restores the title across `/resume`
- Emits terminal bell on agent completion for Zed notifications
- Supports configurable cheap/fast title model

## Install

From local checkout:

```bash
pi install /home/dennis/Documents/codespaces/personal/pi-zed-terminal-title
```

Or try for one run:

```bash
pi -e /home/dennis/Documents/codespaces/personal/pi-zed-terminal-title
```

## Configure title model

In `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "terminalThreadTitleModel": "openai-codex/gpt-5.4-mini"
}
```

If unset, invalid, or unavailable, the extension falls back to the active Pi model, then a local title derived from the prompt.

## Zed sound settings

For sound notifications, enable Zed agent sound settings, for example:

```json
{
  "agent": {
    "notify_when_agent_waiting": "primary_screen",
    "play_sound_when_agent_done": "always"
  }
}
```

Use `"always"` while testing if the terminal remains visible.
