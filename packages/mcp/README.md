# H5P Author MCP by Missing Elements

`@missing-elements/h5p-mcp` lets an AI app make H5P content on your computer: quizzes, fill in the
blanks, flash cards, presentations, interactive books, branching scenarios and the rest of the
content types the H5P hub serves. It writes a playable `.h5p` that carries its libraries, checks
that it plays in a real H5P player, and opens it in your browser. It reads a `.h5p` you have back
into its source too, to change it and build it again. No H5P site, server or account.

It is a local [MCP](https://modelcontextprotocol.io) server: your app starts it on your computer,
and it sends nothing to a server of ours. It needs Node 22 or newer, and Chrome or Edge for the
check; without either, run `npx playwright install chromium` once. For a chat app on the web there
is [the app server](#the-app-server-for-a-chat-app-on-the-web).

## Add it to your app

**Claude Desktop**: Settings, Developer, Edit Config, then in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "h5p": { "command": "npx", "args": ["-y", "@missing-elements/h5p-mcp"] }
  }
}
```

**Claude Code**: `claude mcp add h5p -- npx -y @missing-elements/h5p-mcp`

**VS Code**: in `.vscode/mcp.json`:

```json
{ "servers": { "h5p": { "command": "npx", "args": ["-y", "@missing-elements/h5p-mcp"] } } }
```

Then ask, for example: "Make a five-question quiz about the water cycle as an H5P file."

## The folders it uses

It reads the files your content names, and writes packages, only in its folders. They are the
first of:

1. the folders you give with `--allow`, repeated for more, as in
   `"args": ["-y", "@missing-elements/h5p-mcp", "--allow", "/Users/me/Lessons"]`;
2. the folders your app gives it;
3. your Desktop, Documents and Downloads, and never your home folder whole.

It never writes over a file: a name that is taken gets a number, and it says which. With
`--no-open`, a preview is answered with its address instead of opening the browser.

## Tools

| Tool | What it does |
|---|---|
| `h5p_types` | Lists the content types, and says how to write a source for one |
| `h5p_build` | Builds a package from a source, with its source beside it as `.source.json`, and checks that it plays. It says what the package holds and which H5P core a site needs to take it. A source with problems is refused, each problem named |
| `h5p_media` | Says what a picture, a video or a recording is before your content names it: a picture's size, an mp4's length, which an Interactive Video's times are kept within |
| `h5p_preview` | Opens a package in your browser, in the real player, served from your computer until its tab is closed |
| `h5p_read` | Reads a package back into its source, with its pictures and other files, in a new folder beside it. It says what a source cannot hold, such as the author's comments |

Both servers also serve the
[h5p-author skill](https://github.com/missing-elements/h5p-toolkit/tree/main/skills/h5p-author)
over MCP's Skills extension (SEP-2640), for an app that loads skills from a server. Installed in
your agent instead, with `npx skills add missing-elements/h5p-toolkit --skill h5p-author`, the
same skill builds with these tools wherever they are connected.

## What leaves your computer

- **A file named by web address is downloaded.** An address on your local network is refused: a
  guard against a mistaken or planted address, not against a hostile network.
- **A video on YouTube, Vimeo, Panopto or Echo360 is not downloaded.** It stays an address, which
  the player loads wherever it points, as H5P does anywhere. A YouTube or Vimeo address is sent
  to that site's oEmbed, to ask whether it has the video; Vimeo answers with its length where it has one.
- **Nothing else.** Math is drawn by the package's own copy of MathJax, and the check and the
  preview play the package from your computer.

Your app sends your conversation to its model, as it does without this server.

## The app server, for a chat app on the web

The package has a second command, `h5p-mcp-app`: an MCP server over HTTP for a chat app that shows
a card in its reply, ChatGPT first. The person asks for an activity, the reply plays it, and its
`.h5p` is saved from there. A chat app on the web reaches it only at a public https address, so
host it where one is served; on your computer, to try it:

```sh
npx -y -p @missing-elements/h5p-mcp h5p-mcp-app --port 8787
```

Its endpoint is `/mcp`, with no sign-in. `--host` is the address it listens on, `127.0.0.1` by
default, and `--site` the origin whose play page the card frames. It has two tools: `h5p_types`,
as above, and `h5p_play`, which checks an activity's source and shows the card.

- **The card frames the play page** of
  [missing-elements.github.io](https://missing-elements.github.io/h5p/), which builds the activity
  in the person's browser and plays it there.
- **Where a chat does not let a card frame a page**, or gives the card no origin of its own, the
  card asks the chat to open the same page in a new tab, and shows the page's link to copy in case none opens.
- **A chat that draws no card** is answered with the way to the
  [build page](https://missing-elements.github.io/h5p/build/): the model gives the source, and the
  person pastes it there.

What the server receives, and what it keeps:

- A call of `h5p_play` brings it the activity's source, which it checks and gives back in its
  answer for the card. A call of `h5p_types` brings it the name of a content type, or nothing.
- It never receives a file. For a file attached in the chat, the chat sends a reference, an
  address and an id. The server does not ask that address and does not pass it on: it hands the
  id to the card, which asks the chat for the file's address, and the person's browser fetches
  the file from the chat's own store.
- It stores nothing and logs nothing of a request. Whoever hosts it may log requests on their own
  side: that is the host's to say.
- A package up to about 8 MB is saved through the chat. A bigger one, with a video in it, is saved
  by a tab of the play page, which fetches the video from the chat and builds the package again.

A host that takes a web-standard handler serves the same server without the command:

```js
import { createApp } from '@missing-elements/h5p-mcp/app'

const app = await createApp()
export default { fetch: (request) => app.fetch(request) }
```

`createApp({ site, libraries, references, card, version })`: `site` is the origin whose play page
the card frames. A bundle has no package folder beside its code, so it names all it carries:
`libraries`, the library pack's `parts/` folder, `references`, the author package's `references/`
folder, `card`, the text of this package's `lib/card.html`, and `version`.

## Licence

MIT. The H5P libraries a package carries are under their own licences, listed in it.

H5P is a trademark of H5P Group. This server is made by Missing Elements and is not affiliated with
or endorsed by H5P Group.
