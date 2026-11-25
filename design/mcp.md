# The MCP server

`packages/mcp` is `@missing-elements/h5p-mcp`, shown as **H5P Author MCP by Missing Elements**: a
local MCP server over standard input and output that builds a package onto the person's disk,
checks it, and opens it in their browser, or reads one back to change it. It is for apps with no
shell, Claude Desktop first; in an app with a shell, the skill and `npx` build already. The
package's second command, `h5p-mcp-app`, is the server for a chat app on the web: *The app server*,
below.

- **It holds no rules of its own.** What both servers say alike, the content types, a source's
  fields, a build's notes and outline, is `lib/answers.mjs`. The build, the read, their checks, the outline and the
  confinement to folders (`buildPackage`, `readPackage`, `within`, `publicFetch`, `inside`) are
  h5p-author's; the check, the preview and opening the browser (`verifyPackage`, `summarize`,
  `previewPackage`, `openBrowser`) are h5p-verify's. A rule a tool needs goes into those packages
  first, exported, so the author package and the verifier are published before a server that uses
  something new of theirs.
- **Four tools, and the skill's flow as the instructions.** `h5p_types` lists the pack's content
  types, those with a type file marked, and the skill's brief; given a type, read as a build reads
  one (`sourceType`, so "true false" works), it answers with the type's file, or with `schemaOf` for
  a type with none. `h5p_build` builds a source, `h5p_preview` opens a package, and `h5p_read`
  reads one back into its source. The instructions are the flow in a few lines: the type is the one
  question, its answer is read before the source is written, then the build, where the file is and
  what the check found, and the preview offered; a package the person has is read, its source
  changed, and built. Not `SKILL.md`, whose build routes do not apply here. An app sends the descriptions and the
  instructions with every message, so they stay under about 1,500 tokens; `server.test.ts` holds
  them under 6,000 characters.
- **`h5p_build` shows a source's own fields; the build checks them.** Its `source` carries the
  fields of the author package's `sourceSchema` as JSON Schema properties (#230), so a model writes
  the authors and the licence right before its first build: without them, Haiku wrote
  `"authors": ["Unknown"]` in 2 of 3 runs that built, and with them in none of 9. Nothing is said
  to be required or forbidden, and the field takes any object, since the build reads a source
  written another way as it is meant and says every problem at once (#174), where the SDK, or an
  app that holds a call to the schema, would refuse it unread.
- **The folders: `--allow`, else the app's roots, else Desktop, Documents and Downloads.** A folder
  the person named when adding the server is their choice and comes first; the app's roots come
  next, asked on every call, since they change; both are taken as given. The defaults are never
  the home folder whole: one that is a link to the home folder, or to a folder holding it, is left
  out. A build reads local files and writes its package only there (`within`), and refuses to
  download from an address on a local network (`publicFetch`, a guard against a model's mistake or
  a planted address, not a hostile network); the preview opens only a package there (`inside`). A
  hosted video's address is no download: it is kept, and the player loads it wherever it points,
  since Panopto is often an institution's own server on its own network.
- **A build never writes over a file.** With no `output`, the package is named from its title
  (`fileStem`: the title's letters and digits, in any script, cut at 60 characters, and `-file`
  after a name Windows keeps for a device, as `con`). A name that is taken, the package's or its
  source's, by a file or by a link even to nowhere, gets the next number, and so does a taken
  `output`, as the build itself refuses to write over a file. A name is held while its build runs,
  so builds at once take names of their own. The answer names the path written. Beside the package
  goes its source, `<name>.source.json`, which the build page opens to change and build again; it
  is made new, never written over or through a link, and where it cannot be, the answer says so.
- **A build answers with the content, the check and a picture.** The build's line, the H5P core a
  site needs (`coreApiLine`), its notes, the
  outline (80 lines at most) and, with `verify`, the default, the verifier's summary of a check run
  in a temporary folder, with its screenshot as an image. Where neither Chrome, Edge nor
  Playwright's Chromium is found, the answer says "Not verified" and why. A source with problems
  is refused, every problem by its path, and nothing is written.
- **A read writes beside the package, and names its files where it wrote them** (#236).
  `h5p_read` takes a package in the folders, a name alone being the first folder's, and writes its
  source and media into a new folder beside it, named after it and numbered where the name is
  taken, as a package is. It answers with the source, each file named by its full path in that
  folder, so `h5p_build` reads them wherever its package goes, and looks for one the package lacks
  there and nowhere else. Asked to add two harder questions to the
  demo's quiz, Haiku read it and built at the first build in 6 of 6 runs. With the package
  described as a path in the server's folders, it first guessed one from its working folder in 3
  of 3; described "by its file name alone", in none of 3.
- **The SDK is v2, and the package ships its source.** `@modelcontextprotocol/server` brings only
  its core and zod, none of the HTTP frameworks v1 installed, so `bin/` and `lib/` are published as
  written, with no bundle. `McpServer` on `StdioServerTransport` serves the 2025 protocol, which
  every app speaks; protocol 2026-07-28 deprecates roots, so serving it would leave the folders to
  `--allow` and the defaults. Standard output is the protocol's, so the command sends `console.log`
  to standard error, and loads the server only after `--help` and `--version` have had their turn.
- **Tested as an app runs it.** `tests/server.test.ts` starts the command over standard input and
  output with the SDK's own client, given one folder, and calls each tool: the list, a type by a
  loose name and one with no file, a build checked in Chromium, a taken name and a link at one,
  two builds at once, a source with a problem, an output outside the folder, a preview served and
  one refused. Each test builds what it needs, so each runs alone. The test script first copies
  the skill's type files into the author package, as the author's `prepack` does.

Not built yet: the MCP registry's `server.json` and Claude Desktop's one-click bundle.

## The app server

`h5p-mcp-app` (`lib/app.mjs`, #210, #270) is an MCP server over HTTP for a chat app that shows a
card in its reply, ChatGPT first: the person asks for an activity, the reply plays it, and its
`.h5p` is saved from there. `createApp()`, the package's `./app`, is a web-standard handler,
`fetch(request)`, so a host that runs Node, or one that takes such a handler, serves it; the
command is that handler on a port. Its endpoint is `/mcp`.

- **No server of ours processes a person's file** (the owner's rule, 2026-11-24, and a goal of the
  whole toolkit). The chat sends the tool a reference to an attached file, an address and an id,
  never its bytes. The server never asks that address and never passes it on: it hands the id to
  the card, which asks the chat for the file's address (`getFileDownloadUrl`), and only the
  person's browser fetches from it. So an address that came in a call, which a model can be made
  to write, is one nobody fetches: the card fetches what the chat itself gives for a file of the
  person's. What
  the server cannot avoid is receiving the call, with the activity's source in it; it checks the
  source and keeps nothing. Each request gets a fresh server and no session; nothing of a request
  is stored and nothing is logged, not its body, not its address, not how it was answered, and no
  error of the protocol's, which may quote what was sent. `app.test.ts` holds it to this: a file
  store that counts every connection gets none, an answer carries the address nowhere, and all
  the command ever writes is where it listens.
- **Two tools, in the local server's words.** `h5p_types` answers from `answers.mjs` as the local
  one does, without the lines on folders, which it has none of. `h5p_play` takes a source and
  checks it with the author package's check that reads no file (`check` with `unread`), since a
  source's files are in the chat's store: it answers with the problems by their paths, or with
  the type, the files not checked, the notes and the outline, as `h5p_build` does, so a chat that
  changed an activity reads back what it holds (#268). The instructions say to pass an attachment
  as it is and not to open it: a reply that began with the chat's own analysis of the file drew
  no card, twice, and without it the card came (ChatGPT, 2026-11-23 and 11-24; one cause is not
  proven).
- **The model's words are in the answer's text, and its structured part comes only with an
  attachment, carrying them too** (#276). A chat may give the model the structured part in place
  of the text: Claude Code 2.1.331 gave Haiku `{"files":0}` and no word of the check, its
  outline or what to hand over (2026-11-25). The structured part is there for a card that is
  handed only it, with the attachment's id, which the card also gets in `_meta`.
- **A chat that draws no card is told to hand the source to the build page, by what it says it
  draws** (#276). MCP Apps names a chat's cards in its capabilities (`io.modelcontextprotocol/ui`,
  with `text/html;profile=mcp-app`). Protocol 2026-07-28 carries them in each request, so there
  the answer is one or the other: the card, or h5p-author's route 4, the whole source in one
  JSON block and one line with the build page's plain address. A chat on the 2025 protocols says
  them once, as it starts, to a server that keeps no session, so its answer says the card and,
  for a chat that draws none, route 4 too. Never a link that carries the source: a model breaks
  one by a character (the owner, 2026-11-16). The instructions let a model give only an address
  the answer gives. Haiku in Claude Code with the two tools and nothing else, a chat with no
  cards on the 2025 protocol, asked for a True/False question, a three-question quiz and flash
  cards: a JSON block that parses, of the right type, with the build page's plain address and
  "Paste your chat's JSON", in 3 of 3, and no link with the source (2026-11-25).
- **The file input is ChatGPT's, to the letter, and not held to.** `file` is named in
  `openai/fileParams` and its schema is the reference's: `download_url` and `file_id` required,
  `mime_type` and `file_name`, nothing else. It is shown and not enforced, as `source` is: a
  model that writes the file's name there is answered that no attachment came, where a schema
  would refuse the call unread. One file is taken: a source that names several gets the
  attachment under its own name, and the page asks the person for the rest.
- **The card is the play page's way to the chat, and holds nothing of the activity.**
  `lib/card.html` frames `/h5p/play/` of the org site with the source in its fragment; the page
  builds and plays in the person's browser, and its rules are that site's. The card gives it
  what only the chat has, by the page's messages: the attached file's address, asked of the chat
  by the file's id, and what it weighs, its bytes where the page needs them or that they did not
  come, the chat's theme, a save (`ui/download-file`), and an open tab for a link of the site's
  and no other (`openExternal`). The answer carries the source for it in `_meta`, which a chat
  shows the card and not the model, so a card drawn from the result alone, with no input, plays
  all the same (#276). It sends nothing to the server it came from and calls no tool. Its policy
  names the one site it frames and the chat's file store. A chat keeps a card by its address, so
  the address carries the card's hash.
- **Where the page cannot play in the card's frame, the card offers the activity in a tab, and
  knows it from the browser** (#274), never from a chat's name. A card with no origin
  (`self.origin` is `"null"`) was sandboxed without one, and a sandbox passes to every frame
  inside: the page there has no Service Worker, so no frame is tried (Open WebUI 0.13.4 frames a
  card with `sandbox="allow-scripts allow-downloads allow-popups"`). A chat that refuses the
  frame has the browser raise `securitypolicyviolation` for the page's address (Claude lets a card
  frame `blob:` and `data:` only, its `frameDomains` dropped). The card then
  shows one state in the loader's place, as tall as what it says: what happens, and "Open the
  activity", which asks the chat to open the play page's address with the source in it
  (`ui/open-link`, or ChatGPT's `openExternal`). The tab is the chat's to open, from its own
  page, which no sandbox holds. One the card opened itself, by a link with `target="_blank"`,
  would keep the card's sandbox and have no origin either (probed in Chromium, Firefox and
  WebKit, 2026-11-25). Whether a tab opened is not the
  card's to see, so the address is there to copy from the first press on, and at once in a chat
  that opens no link. A page that has said nothing 10 s after its frame loaded did not start
  there, refused without the browser saying so or blocked by a network, and the card offers the
  tab too, saying the activity did not start in the reply (#276): the page speaks within a moment
  of its load. The page's own word from the frame takes the card back: a wrong conclusion
  never hides a player that works. Where the page starts in the frame and the player then cannot,
  the page offers the tab itself (the site's #116). The chat's theme is ChatGPT's `window.openai.theme` or MCP
  Apps' `hostContext.theme`. In Claude the tab was seen to work (the owner, 2026-11-25). Not
  known: Open WebUI itself, which the card met only as a stand-in. A player without the Service
  Worker is not built for such a chat ([scope.md](scope.md)).
- **Until the activity comes, the card says what the chat is doing** (#276). A chat may draw the
  card while its model still writes the source, which takes longer than a moment for a long one:
  where it says so as it goes (`tool-input-partial`), the card says the chat is writing it, and
  never plays from a part. A call the chat stopped (`tool-cancelled`) is said. With no word at
  all, it says at 6 s that it waits, and at a minute that nothing came: before, it said at 6 s
  that nothing came and took it back when the source did. A word that ends the wait is as tall
  as what it says. Its colours follow the chat's theme by an attribute the card writes, not by
  `light-dark()`, and nothing asks for `URL.canParse`: Safari has them from 17.5 and 17, Chrome
  from 123 and 120, Firefox from 120 and 115 (MDN's compatibility data).
- **What ChatGPT's frame was found to do is written in the card, with its date.** A card's frame
  saves no file and opens no tab on a press; the chat saves a file handed to it of 8 MB and
  refuses one of 16 MB, downloads from no address, and takes no package into its own files; its
  file store answers any site (all 2026-11-24). So the card says it saves up to 8 MB, and a
  bigger package is saved by a tab of the play page, which the page asks the card to open. The
  card's script is one function: a chat puts names of its own on the card's window.
- **Tested as a host runs it.** `tests/app.test.ts` starts the command on a free port and asks it
  over HTTP with the SDK's own client: the two tools and their words, the file input's schema,
  the card and its policy, a source checked, one refused, an attachment handed to the card alone,
  a call whose file is no reference, a body over 1 MB, and that nothing was written.
  `tests/card.test.ts` runs the card in a browser, the verifier's, in three chats that stand in
  for the ones it was written against: one that sandboxes it without an origin, under the policy
  Open WebUI writes from the card's domains; one that refuses the frame; one that lets the page
  be framed. Each speaks MCP Apps to it, and the play page there says its height and no more:
  the source streamed, a stopped call, a result with no input, nothing for a while, and a page
  that never speaks. `app.test.ts` asks as a chat on protocol 2026-07-28 too, with and without
  cards.
  With the site's own play page the card is checked by hand in a page that stands in for a chat,
  its frame sandboxed as ChatGPT's was found to be; in ChatGPT itself ran the probe's card, which
  this one is without its test parts.

- **It is hosted as a Cloudflare Worker, at an address of ours** (`apps/mcp-worker`, #272):
  `mcp.embed-my.org`, one line of its config, since the domain's zone is on the same account.
  The free plan gives 100,000 requests a day and bills nothing. The limit is the account's, until
  midnight UTC: over it, a route set to fail closed answers Cloudflare's error 1027, and one set
  to fail open passes its requests on as if there were no Worker. This Worker is a Custom
  Domain, with no origin behind it, so either way a call gets no answer from the server. Nothing
  on another host is touched, the demo and the organisation's site among them. A function of the demo's Vercel project
  was built and dropped: on its plan one account shares 4 CPU-hours a month, and over the limit
  the whole account is paused until someone acts, the demo and `/embed` with it, which an
  endpoint with no sign-in lets anyone bring about.
- **The Worker is the same handler, and carries what the server reads.** `createApp()`, the
  package's `./app`, takes as options what `import.meta` cannot find in a bundle: `version`,
  `card`, `references`. The library pack's parts, the brief with the type files and the card are
  gathered into `staged/` by `scripts/stage.mjs` and ride in the Worker as modules
  (`find_additional_modules`), which its file system shows under `/bundle`: the server's Node
  entry reads them there as on a computer (`nodejs_compat`). 17 MB of the 64 MiB a Worker may be.
  Modules, not static assets: nothing of them is served.
- **The Worker writes no log of a call and has nowhere to keep one.** `observability.enabled`
  is `false`, which switches off Workers Logs: no invocation log and no trace is stored. No
  store is bound to it, and it has one address, no `workers.dev` name and no preview addresses.
  That setting is the Worker's alone. What Cloudflare counts for any Worker and any domain it
  serves, the requests, their statuses, the CPU time, is outside it: the privacy policy names
  that from Cloudflare's own documents, and does not say "nothing". No token of the account is in the repository or in GitHub: it
  is deployed by someone signed in to the account (`deploy:worker`), or by Cloudflare's own build
  of the repository.
- **Tested in the Workers runtime.** `tests/worker.test.ts` has wrangler bundle the Worker and
  start it on this computer, and holds each answer to the server's on Node, word for word: the
  tools, the list of types, a type's file, a type's fields from its part, a source checked, one
  refused, the card and its address. It holds the config to its logs off, no store and one address.
- **Not known until it is deployed** (2026-11-24). The free plan allows 10 ms of CPU a request,
  with leeway for an overrun now and then; a check took 14 to 22 ms a call on a laptop in the
  local runtime, and the first list of types 250 ms. A Worker may take 1 s to start, and this
  one is 17 MB. If the free plan does not hold: the paid plan (30 s a request), or the parts as
  static assets, read by the author package's entry for a page. A Worker runs near its caller
  and cannot be held to a region below the Enterprise plan.

Not built yet: the app's privacy policy and its listing (#210).
