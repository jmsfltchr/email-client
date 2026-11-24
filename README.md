# Stillmail

A calm desktop Gmail client. The default is to do nothing: there is no unread count and nothing to clear. People you correspond with come first, notification mail is grouped by topic, and only out-of-the-ordinary mail asks for attention.

![Home](docs/home.png)

## Try it

```bash
npm install
```

```bash
npm run demo
```

`npm run demo` opens the app on a fictional two-account mailbox, so you can try everything without connecting Gmail. `npm start` runs it for real.

## Connecting Gmail

Stillmail talks to Gmail directly from your machine with your own Google OAuth client. No server sits in between.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Also enable the **People API** (used only for contact photos). Configure the OAuth consent screen. Add the scopes `gmail.readonly`, `gmail.send`, `contacts.readonly` and `contacts.other.readonly`, and add each of your Gmail addresses as a test user (for a Workspace account you can choose *Internal* instead).
3. Create credentials → **OAuth client ID** → application type **Desktop app**.
4. Start Stillmail, paste the client ID and secret, then **Connect a Gmail account** once per account. Each account gets a tag (Work, Personal, …) you can rename and recolour in Settings.

While the consent screen is in *Testing*, Google expires sign-ins after 7 days. Publishing the app (it can stay unverified for personal use) removes that limit.

Stillmail requests read-only access to mail and contacts, plus permission to send. It never archives, labels, marks as read or deletes anything in Gmail. All of its own state (who is important, topic order, dismissals) is stored locally.

## Connecting Notion

The Testers tab reads and writes one Notion database directly on Notion's servers, using an internal integration that you add to that database only.

1. In Notion, open **Settings → Integrations**, create an **internal integration** with read, update and insert content capabilities, and copy its secret.
2. Open the database as a full page, choose **••• → Connections**, and add the integration. It can see that page and nothing else in the workspace.
3. In Stillmail, open **Testers**, paste the secret and the database's link (**••• → Copy link**), and press **Connect**.

Stillmail adds a text column called **Conversation links** (one link per line, readable and clickable in Notion too) and, if the database has no multi-select column yet, a **Tags** column. Everything else is left as it is. The secret is stored encrypted with the operating system's keychain. *Remove* moves a person to Notion's trash, where it can be restored.

## How it works

**People.** Every conversation with a person, newest first, whoever wrote last: mail from people, your replies, and mail you start (including notes to yourself). A conversation where they wrote last shows how long it has been waiting once it is more than a few days old; one where you wrote last is shown lighter with "You:". *Dismiss* removes a conversation until something new arrives in it. A sender is a **Person** if you have ever written to them. Automatic replies (such as a vacation responder) do not count, and a mass sender (list headers or a no-reply style address) only counts once you have written to it at least twice and at least once for every ten emails it has sent.

**Machines.** An address that has sent you several emails (3 by default) and never had a reply is a **Machine**: a notification channel. So is anything with bulk-mail headers or a no-reply style address. You can override any address in the reader or in Settings.

**Topics.** Within a channel, subjects are reduced to a pattern (ids, dates and amounts are collapsed) and grouped, so `Your order #123 has shipped` and `Your order #456 has shipped` are one topic. Shared `[tags]`, single varying words, and common prefixes are also grouped. A sender whose subject changes with every issue, such as a newsletter, is treated as a single topic named after the address alone; this is detected automatically, and *One topic for this sender* forces it for any address. When that is not enough, *Define topic by pattern…* lets you group with a regular expression. Topics are shown as `Org › channel › topic` with the time of the latest email, over the period chosen at the top of the panel. Topics are listed by their most recent email, newest first.

**Attention.** A notification email is escalated when:

- its topic is new or rare for an established channel, or returns after 90+ days,
- its subject or preview contains an alarm word (overdue, expired, revoked, failed, suspended, unusual activity, … editable in Settings),
- it comes from an unfamiliar sender that is neither important nor a channel,
- or you flag it yourself.

Dismiss an item, or choose *Never flag topic* if a topic is always noise. Channels that send a different subject every time (newsletters, marketing) are not flagged for novelty.

**Faces and colours.** People are circles and organisations are rounded squares. A person shows their contact photo when your Google contacts have one, otherwise their initials. A notification channel shows its organisation's site icon at full size with no backing tile, otherwise its initial on a coloured square. The organisation's name is underlined in its brand colour, picked automatically as the dominant colour of the icon that is not near white, near black or grey; a monochrome logo gets a white underline (and a dark logo on a transparent background is inverted so it shows on the dark theme). An organisation with no icon gets a colour assigned from a fixed palette, which never changes. People at a company share its colour, while people on public mailboxes (gmail.com and similar) each get their own. Icons are fetched from Google's favicon service and cached; photos and icons can be turned off in Settings.

**Unread dot.** Rows in People and Attention show a blue dot while Gmail still has the message unread and you have not opened it here. Reading it on your phone or in Gmail clears the dot within a minute; opening it in Stillmail clears it here only, because Stillmail never changes anything in Gmail. There is still no unread count.

**Bump.** Any row in People, Attention or Notifications can be bumped (row button, reader button, or `b`). It jumps to the top, and its bump date replaces its received date for ordering and fading, so it stays on the list while untouched rows slip away. Bump again to keep it there; newer mail on a bumped topic simply takes over. The age shown is still the real one, with an ↑ marker.

**Time tabs.** People, Attention and Notifications each have their own 24h / 3d / 7d / 30d / 90d tabs, remembered separately. People and Attention use the bump date where there is one, and anything you flagged yourself stays in Attention whatever the tab. People keeps a *Show older* link so nobody is lost.

**Links.** Clicking a link in an email opens the page in a browser pane to the right of the message, with back, forward, reload and *Open in default browser*. ⌘-click (Ctrl-click on Windows and Linux) sends a link straight to your default browser instead. The pane is an isolated web page with its own cookies; it has no access to your mail and no camera, microphone, location or notification permissions. `mailto:` links start a new message.

**Reading.** A Light / Dark switch at the top of the reader sets how message bodies are shown, and is remembered. Earlier messages quoted inside a reply are folded behind a ••• button so each message shows only what is new; forwards are left open. Opening a conversation lands on the latest unread message (or the one you clicked), with any other unread messages opened too; when three or more already-seen messages precede it they are tucked into a single "N earlier messages" line. ⌘F (Ctrl+F) finds text across the open conversation, with Enter and Shift+Enter to step through matches.

**Images.** Pictures attached inside a message always show. Pictures fetched from the web load automatically in mail from people you correspond with and from senders you allow with *Always from …*; for other senders they are held back (they are how senders track opens) until you click *Show images*. Settings has a switch to load them everywhere.

**Dismissing a topic.** Hover a topic in Notifications and click *Dismiss* to hide it until a new email arrives on that topic; when it comes back it shows only what is new.

**Unsubscribe.** When a message offers a way to unsubscribe, an *Unsubscribe* action appears under it and always asks for confirmation first, saying exactly what it will do. It uses the sender's one-click unsubscribe request when offered, otherwise sends the unsubscribe email the sender asks for, otherwise opens their unsubscribe page in the browser pane for you to finish.

**Fading.** Mail is at full strength for 7 days, dimmed until 30 days, then leaves the home view and lives on in Search. Both cutoffs are settings.

**Filters.** Account tags and the org / channel / topic tree in the sidebar are multi-select and filter every view.

**Search.** Narrow by sender first: pick one or more domains, then exact addresses, then type text. Counts update as you go. Quick search covers subjects and previews of synced mail instantly; press Enter to run the same query against full message text on Gmail.

**Testers.** A separate tab for keeping track of the people you talk to during a test programme, whichever app the conversation is in. The list lives in one Notion database (see *Connecting Notion* below): each row is a person, the database's own columns (multi-select, select, status, checkbox, date, number, text) are shown and editable as tags and notes, and each person can have any number of conversation links. Paste a link and the platform is recognised from its address: Instagram, Discord, Slack and Teams open in a browser pane beside the list, anything else opens there as a plain web page, and an email address shows the latest mail with that person in the reader (or starts a new message). Each platform keeps its own pane, so switching between a Slack and a Discord conversation does not reload either, and panes stay open while you visit other tabs. The panes use their own browser profile: you sign in to each service once, and those sign-ins are kept apart from the pane that opens links found in email. ⌘-click (Ctrl-click) a link to use your default browser instead.

**Desktop notifications** fire only for mail from people and escalated mail.

## Keyboard

| Key | Action |
| --- | --- |
| `c` | Compose |
| `/` | Search |
| `g` | Focus (home) |
| `t` | Testers |
| `,` | Settings |
| `r` / `a` / `f` | Reply / reply all / forward the open conversation |
| `b` | Bump the open conversation (or its topic) to the top of its list |
| `e` | Dismiss the open conversation from its list, and close |
| `⌘F` / `Ctrl+F` | Find in the open conversation (otherwise go to Search) |
| `Esc` | Close reader or dialog |
| `Ctrl/⌘ + Enter` | Send |

## Development

```bash
npm test
```

```bash
npm run e2e
```

`npm test` runs unit tests for classification, MIME building and sync. `npm run e2e` drives the real Electron app in demo mode and needs [Playwright](https://playwright.dev/) installed (`npm i -D playwright`); on a headless Linux box wrap it in `xvfb-run -a`.

```
src/core      pure logic: sender classification, topic clustering, attention rules, MIME
src/main      Electron main process: OAuth, Gmail REST client, sync, persistence, IPC
src/renderer  UI (Preact + htm, no build step) and the demo mailbox
```

`npm run dist` packages an installer with electron-builder. The app icon lives in `assets/icon.svg`; `npm run icons` regenerates the platform files in `build/` and `src/assets/` from it (needs Playwright).

## Known limits

- The first sync fetches metadata for 12 months of received mail (configurable) and all sent mail; it runs at about 30 messages a second to stay inside Gmail's per-minute quota, so a large mailbox takes a while (roughly half an hour for 50,000 messages). The app is usable while it runs.
- Composing is plain text. Drafts are not saved to Gmail.
- Notifications need the app to be running; closing the window quits it on Windows and Linux.
- Organisation names come from the sender's registrable domain, using a built-in list of common two-level suffixes rather than the full Public Suffix List.
