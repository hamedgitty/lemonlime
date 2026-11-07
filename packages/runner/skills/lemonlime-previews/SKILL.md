---
name: lemonlime-previews
description: Offer what you run for the user to open from LemonLime, with `lemonlime-runner preview <port>`. Use whenever you start a dev server, web app, Storybook or anything else they would want to look at.
---

# Offer what you run for preview

The user can't see your screen. When you start something they'd want to look at (a dev
server, a web app, Storybook, docs), offer its port so LemonLime can show it to them:

```sh
lemonlime-runner preview 5173 --name "web app"
```

- Do it once the server is listening, and say in your reply that it's ready to preview.
- Bind the server to `127.0.0.1` or `0.0.0.0` on that port. Use the port the tool printed,
  not a guess.
- Give it a short name the user will recognise ("web app", "storybook", "API docs").
- When you stop the server, take it back: `lemonlime-runner preview 5173 --remove`.
- Never offer ports for databases or anything with secrets: only things meant to be
  looked at in a browser.

The preview stays private: in the cloud it travels through LemonLime's own connection to
the user's desktop app, with no public URL.
