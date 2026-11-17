# Set up skylight-mcp, step by step

This guide takes you from nothing to an AI assistant that can read and change your Skylight Calendar. It starts with `git clone` and shows what each command prints when it works, so you can tell early when something is off.

There are two parts. Part 1 puts the server on your Mac for Claude Desktop and takes about 15 minutes. Part 2 is optional. It puts a shared server in your own Cloudflare account so the rest of the family can use Claude, ChatGPT or Gemini from any device. Allow about an hour for that one, most of it spent in the Cloudflare and Google consoles.

The same guide is also a web page with copy buttons and a checklist that remembers where you stopped: `docs/setup-guide.html`. GitHub shows HTML files as source code, so open it from your clone with `open docs/setup-guide.html`.

> Read [Use at your own risk](../README.md#use-at-your-own-risk) before you start. skylight-mcp is unofficial and not affiliated with Skylight. It uses Skylight's private API, which can break or be blocked at any time, and using it may be against Skylight's terms of service. Its tools change real family data, and deletes are permanent. There is no support and no warranty.

## Before you start

You need all of these for Part 1:

- A Mac. The server does not run on Windows or Linux.
- A Skylight Calendar, and the email and password you use in the Skylight app.
- Google Chrome. The sign-in step reads its result from Chrome's history.
- Claude Desktop, installed and signed in.
- Node.js 20 or newer.
- Git.

Open Terminal (press Command-Space, type `Terminal`, press Return) and check the last two:

```sh
node --version
git --version
```

Node should print `v20` or higher. If the command is not found, install the LTS version from nodejs.org, then close Terminal and open it again. If `git` is missing, macOS offers to install the Command Line Tools the first time you run it. Accept, wait for the install to finish, and run the command again.

Every command in this guide is typed into Terminal.

## Part 1. Your Mac and Claude Desktop

### Step 1. Download the code with Git

```sh
cd ~
git clone https://github.com/jordanlawson1988/skylight-mcp-public skylight-mcp
cd skylight-mcp
```

Git prints `Cloning into 'skylight-mcp'...` and a few progress lines. You now have a folder named `skylight-mcp` in your home folder, and Terminal is inside it.

Leave the folder where it is. Claude Desktop runs the server from this folder, so moving or deleting it later breaks the connection until you repeat Steps 5 and 6.

### Step 2. Install and build

```sh
npm install
npm run build
```

`npm install` downloads the libraries the server needs and ends with a line that starts with `added` and a package count. `npm run build` prints the build command and returns to the prompt. If neither shows an error, both worked. Together they take a minute or two.

### Step 3. Make the `skylight-mcp` command available

```sh
npm link
skylight-mcp --version
```

The second command prints a version number such as `0.1.0`.

If `npm link` stops with a permissions error (`EACCES`), skip it. Everywhere this guide says `skylight-mcp`, type `node dist/cli.js` instead while you are inside the `skylight-mcp` folder. `node dist/cli.js --version` prints the same number.

### Step 4. Sign in to Skylight

```sh
skylight-mcp login
```

It prints a long link and waits for you:

```text
1. Open this link in your browser and sign in to Skylight:

   https://app.ourskylight.com/oauth/authorize?client_id=...

2. After sign-in, Skylight bounces you straight to its home page, so you
   usually can't copy the callback address. That's fine: just come back here.

3. Press Enter to finish (reads the sign-in result from Chrome's history),
   or paste the https://ourskylight.com/welcome?code=... address if you have it:
```

1. Copy the link and open it in Google Chrome. If Chrome is not your default browser, paste the link into Chrome's address bar, because clicking it in Terminal opens the default browser.
2. Sign in with your Skylight email and password. Skylight may ask for them even if its web app is already open in another tab.
3. Skylight sends you on to its home page. That is expected.
4. Go back to Terminal and press Return (the key the prompt calls Enter).

When it works you see:

```text
Logged in. Access token valid until Tue Nov 17, 4:57 PM EST.
Run `skylight-mcp doctor` to finish setup.
```

If it answers `No sign-in found in Chrome's history yet`, the sign-in did not happen in Chrome or did not finish. Sign in with the link in Chrome, then press Return again. You have 10 minutes from the moment the link was printed. After that, run `skylight-mcp login` again for a fresh link.

Pressing Return makes skylight-mcp look in Chrome's history for the one address Skylight sent you to after sign-in, and for nothing else. The README's [Login](../README.md#login) section describes that lookup in detail. The sign-in is stored encrypted on this Mac, with the key in your macOS Keychain.

### Step 5. Run the setup check

```sh
skylight-mcp doctor
```

`doctor` checks the sign-in, lists the people on your Skylight and prints the settings Claude Desktop needs. Your ids, names and paths will differ from this example:

```text
skylight-mcp doctor

API host:   app.ourskylight.com
Timezone:   America/New_York (set SKYLIGHT_TIMEZONE to change)
Toolsets:   all (set SKYLIGHT_TOOLSETS to a comma list to trim the tool list)
Login:      Logged in (token valid until Tue Nov 17, 4:57 PM EST)
Frames:     1234567 (Home)
Frame:      1234567
Profiles:   Ellie (111), Sam (222)

Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):

{
  "mcpServers": {
    "skylight": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "/Users/you/skylight-mcp/dist/server.js"
      ]
    }
  }
}
```

Check two lines. `Login` must say `Logged in`, and if it does not, go back to Step 4. `Profiles` should list your family.

Then select everything from the first `{` to the last `}` in your own Terminal window and copy it. That block is what you paste in the next step.

Times are shown in Eastern time unless you change the zone. The README explains how under [Time zones](../README.md#time-zones).

### Step 6. Add the server to Claude Desktop

1. Open Claude Desktop. In the menu bar choose Claude, then Settings, then Developer, then Edit Config. Finder opens with a file named `claude_desktop_config.json` selected.
2. Open that file in TextEdit (right-click it, then Open With, then TextEdit).
3. If the file is empty or contains only `{}`, replace everything with the block you copied in Step 5.
4. If the file already has an `mcpServers` section, keep it and add only the `skylight` entry inside it. Put a comma after the entry that comes before it:

   ```json
   {
     "mcpServers": {
       "another-server": {
         "command": "/path/it/already/had"
       },
       "skylight": {
         "command": "/opt/homebrew/bin/node",
         "args": [
           "/Users/you/skylight-mcp/dist/server.js"
         ]
       }
     }
   }
   ```

5. Save the file. Quit Claude Desktop completely with Command-Q, then open it again. Closing the window is not enough.

Use the `command` and `args` values that `doctor` printed for you, not the ones in this example.

To confirm it loaded, go back to Settings, then Developer. `skylight` should be in the list and marked as running.

### Step 7. Ask Claude about your Skylight

Start a new chat in Claude Desktop and type:

```text
Use the Skylight tools to check my login status, then list the profiles on our Skylight.
```

Claude asks permission the first time it uses each tool. Allow it, and you should get your family's profile names back. Then ask for something real that changes nothing:

```text
What chores are on our Skylight for the next seven days?
```

Before you let it change anything, ask for a dry run so you can see what it would do:

```text
Do a dry run of a weekly chore: Sam takes out the trash every Tuesday. Don't create anything yet.
```

More ideas are under [Example prompts](../README.md#example-prompts) in the README. Every delete shows a preview first and needs your confirmation.

Part 1 ends here. If only you use it, on this Mac, you are done.

## Part 2. A shared server for the family (optional)

Part 1 works on one Mac with Claude Desktop. Part 2 puts the same tools on a small server in your own Cloudflare account, so each person in the family can use them from Claude, ChatGPT or Gemini on a phone or any computer. Everyone signs in with their own Google account, and only the email addresses you list get in.

Finish Part 1 first. You also need:

- A Cloudflare account. The free plan is enough to start.
- A Google account that can use the Google Cloud console, to create the sign-in client.

Collect the Google email address of each family member who will connect. You need that list in Steps 11 and 12.

The repository describes two copies of the server: `staging` for trying things out and `production` for the one you keep. Do every step with `staging` first. Step 15 repeats them for `production`.

Run all commands from inside the `skylight-mcp` folder.

### Step 8. Sign in to Cloudflare

```sh
cd ~/skylight-mcp
npx wrangler login
```

A browser window opens and asks you to allow Wrangler, Cloudflare's command-line tool. Click Allow. Terminal then confirms that you are logged in.

### Step 9. Deploy the server for the first time

```sh
npm run remote:deploy:staging
```

If this is your first Worker, Wrangler may ask you to choose a `workers.dev` subdomain. Pick a short name, because it becomes part of your server's address. Near the end of the output is that address:

```text
https://skylight-mcp-staging.<your-subdomain>.workers.dev
```

Copy it somewhere handy. Wherever this guide shows `<your-subdomain>`, use your real one.

To check that the server is up, open this address in a browser:

```text
https://skylight-mcp-staging.<your-subdomain>.workers.dev/health
```

It should show `{"ok":true}`. The server runs, but nobody can use it yet: it has no secrets and no sign-in.

### Step 10. Create the server's own secrets

```sh
skylight-mcp remote setup --env staging --url https://skylight-mcp-staging.<your-subdomain>.workers.dev
```

This saves the address, creates two random secrets, uploads them to the server and keeps one of them in your Keychain. Neither is shown on screen. Look for this line near the end:

```text
Done: SKYLIGHT_TOKEN_KEY and ADMIN_TOKEN are set on the staging Worker, and the admin token is in your Keychain.
```

Below it is a checklist of what is still to do. Steps 11 to 14 of this guide are that checklist.

Run setup once per server. Running it again replaces both secrets, and you would have to repeat Step 13.

### Step 11. Create a Google sign-in client

Family members prove who they are by signing in with Google. For that, Google needs to know about your server.

1. Go to console.cloud.google.com and sign in. Create a project with any name, for example `family-skylight`, or pick one you already have.
2. In the search bar at the top, type `Google Auth Platform` and open it. If it asks you to get started, enter an app name, pick your email as the support email, choose External as the audience, and finish.
3. Open Audience. Under Test users, click Add users and add the Google email of every family member, yours included. Leave the publishing status on Testing.
4. Open Clients and create a client. The application type is Web application. Under Authorized redirect URIs, add both of these. The second one saves you a trip back here for Step 15.

   ```text
   https://skylight-mcp-staging.<your-subdomain>.workers.dev/callback
   https://skylight-mcp.<your-subdomain>.workers.dev/callback
   ```

5. Google shows a Client ID, which ends in `.apps.googleusercontent.com`, and a Client secret, which starts with `GOCSPX-`. Keep that window open or copy both. You need them in the next step.

Test users are not added under IAM. IAM gives people access to the Google Cloud project itself, which family members do not need.

Google renames these screens from time to time. If yours look different, the two things to find are the OAuth consent screen, for the test users, and an OAuth client ID of type Web application.

### Step 12. Give the server the Google client and the family list

Run these one at a time. Each asks for a value and hides what you type or paste.

```sh
npx wrangler secret put GOOGLE_CLIENT_ID --env staging
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
npx wrangler secret put ALLOWED_EMAILS --env staging
```

The first two are the Client ID and the Client secret from Step 11. `ALLOWED_EMAILS` is the family list: Google email addresses separated by commas, such as `you@gmail.com,spouse@gmail.com`.

Because the input is hidden, pasting the secret where the ID belongs is easy to do and hard to notice. Copy each value right before the command that needs it.

`ALLOWED_EMAILS` is replaced as a whole every time you set it. To add someone later, enter the complete list again, not just the new address.

Then deploy once more, as the checklist from Step 10 asks:

```sh
npm run remote:deploy:staging
```

### Step 13. Sign the server in to Skylight

The server keeps its own Skylight sign-in, separate from the one on your Mac.

```sh
skylight-mcp remote login --env staging
```

It works like Step 4: open the printed link in Chrome, sign in to Skylight, come back and press Return. The last line is:

```text
Shared server signed in to Skylight. Token valid until Tue Nov 17, 4:57 PM EST.
```

Now check the server:

```sh
skylight-mcp remote status --env staging
```

```json
{
  "env": "staging",
  "url": "https://skylight-mcp-staging.<your-subdomain>.workers.dev",
  "mcpUrl": "https://skylight-mcp-staging.<your-subdomain>.workers.dev/mcp",
  "loggedIn": true,
  "needsLogin": false,
  "tokenExpiresAt": "2026-11-17T21:57:05.531Z",
  "credentialError": null,
  "tokenExpiresWhen": "Tue Nov 17, 4:57 PM EST"
}
```

`loggedIn` should be `true`. The `mcpUrl` line is the address you give to the assistants in the next step.

### Step 14. Connect Claude, ChatGPT or Gemini

Each person does this once, in their own account. The address to enter is your server's address with `/mcp` on the end:

```text
https://skylight-mcp-staging.<your-subdomain>.workers.dev/mcp
```

In Claude, open Customize, then Connectors, then Add custom connector. Paste the address, leave the OAuth client fields empty, and click Connect. Claude on the web, Claude Desktop and the iPhone app share connectors, so adding it once is enough. Claude's free plan allows one custom connector.

ChatGPT needs Developer mode first. In a ChatGPT Business workspace, the owner turns it on for apps in the workspace settings. Then go to Settings, then Apps, add a custom MCP server with the same address, and choose OAuth as the authentication. A workspace that belongs to an employer may not allow a personal connector.

For Gemini, use gemini.google.com (the website, not the phone app). Go to Settings, then Connected Apps, then Custom apps, and add the same address. Leave Advanced features empty. Gemini needs a personal Google account in the US, 18 or older, with English as the language and Keep Activity turned on. Once added on the web, it also works in the Gemini phone apps.

All three then show the same two pages. The first comes from your server and asks `Allow Claude to use the family Skylight?` (or ChatGPT, or Gemini). Click Allow and continue with Google. Then Google asks which account to use, and the person picks the one that is on the family list. Google may add a notice that the app is still being tested. That app is your own sign-in client from Step 11, so continue.

Test it with a question that only reads:

```text
What chores are on our Skylight today?
```

A connection lasts up to 30 days. After that the assistant asks the person to connect again. These menus belong to Anthropic, OpenAI and Google and they move, so if a name here does not match what you see, look for custom connectors or custom MCP servers in the settings.

### Step 15. Move to production

Staging is a complete server and you can keep using it. Production is the same server under a shorter address, meant to be the one you leave alone while you try changes on staging. The README recommends running production on Cloudflare's Workers Paid plan ($5 a month), because the free plan has a daily write limit that sign-ins can use up. Its notes on limits are under [Use from Claude, ChatGPT and Gemini on any device](../README.md#use-from-claude-chatgpt-and-gemini-on-any-device).

Repeat Steps 9, 10, 12 and 13 with `production`. Run these one at a time, as before, because several of them stop and ask you for something.

```sh
npm run remote:deploy:production
skylight-mcp remote setup --env production --url https://skylight-mcp.<your-subdomain>.workers.dev
npx wrangler secret put GOOGLE_CLIENT_ID --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
npx wrangler secret put ALLOWED_EMAILS --env production
npm run remote:deploy:production
skylight-mcp remote login --env production
```

Then connect each assistant again as in Step 14, this time with:

```text
https://skylight-mcp.<your-subdomain>.workers.dev/mcp
```

The Google client from Step 11 already has the production redirect address, so nothing changes in Google.

## Add or remove a family member

To add someone, do these in order:

1. Add their Google email as a test user in the Google Cloud console (Step 11, item 3).
2. Set the family list again with every address on it, the new one included: `npx wrangler secret put ALLOWED_EMAILS --env staging`.
3. Have them connect their assistant (Step 14).

To remove someone, disconnect their apps and then set the list again without their address. Run the first command, wait for it to finish, then run the second.

```sh
skylight-mcp remote revoke someone@gmail.com --env staging
npx wrangler secret put ALLOWED_EMAILS --env staging
```

The list is checked on every request, so the change takes effect immediately.

## Update to a newer version

```sh
cd ~/skylight-mcp
git pull
npm install
npm run build
```

Quit and reopen Claude Desktop so it starts the new build. If you run the shared server, deploy it again with `npm run remote:deploy:staging`, and with `npm run remote:deploy:production` if you use production. Your sign-ins and secrets stay as they are.

## When something goes wrong

On your Mac:

| What you see | What to do |
| --- | --- |
| `command not found: skylight-mcp` | `npm link` did not take. From inside the `skylight-mcp` folder, type `node dist/cli.js` in place of `skylight-mcp`. |
| `No sign-in found in Chrome's history yet` | Open the link in Google Chrome, not Safari. Finish signing in, then press Return again. |
| `The login attempt expired` | More than 10 minutes passed. Run `skylight-mcp login` again. |
| `doctor` says `not logged in` or `session expired or revoked` | Run `skylight-mcp login` again. |
| `doctor` says `This account has several frames` | It lists their ids. Add `"env": { "SKYLIGHT_FRAME_ID": "<id>" }` to the `skylight` entry in the Claude Desktop config. |
| Claude Desktop does not list `skylight`, or shows an error next to it | The config file is the usual cause. Check it with the first command below, then quit and reopen Claude Desktop. |
| Claude has the tools but they fail | Run `skylight-mcp doctor` and fix what it reports. Then read the server's log with the second command below. |
| Claude struggles with the number of tools | Trim the list with `SKYLIGHT_TOOLSETS`. See [Toolsets](../README.md#toolsets) in the README. |

```sh
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("The config file is valid JSON.")' "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
tail -n 20 "$HOME/Library/Logs/Claude/mcp-server-skylight.log"
```

The first command prints `The config file is valid JSON.` or the position of the mistake, which is most often a missing or extra comma.

On the shared server:

| What you see | What to do |
| --- | --- |
| `This Google account is not on the family list.` | The address is missing from `ALLOWED_EMAILS` or misspelled. Set the whole list again (Step 12). |
| Google says `Access blocked` or `Error 403: access_denied` | The person is not a test user of your Google sign-in client. Add them (Step 11, item 3). |
| Google says `Error 400: redirect_uri_mismatch` | The redirect address in the Google client must be exactly your server's address followed by `/callback` (Step 11, item 4). |
| A page titled `Not set up yet` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `ALLOWED_EMAILS` is missing, or a value went into the wrong prompt. Repeat Step 12. |
| `This app cannot connect to the family Skylight.` | Only Claude, ChatGPT and Gemini are allowed to connect. |
| Tools answer that the server owner needs to run `skylight-mcp remote login` | The server's Skylight sign-in is missing or expired. Repeat Step 13. |
| `The staging server answered 401` | The admin token no longer matches. Run `skylight-mcp remote setup` for that server again, then repeat Step 13. |
| `The staging server answered 404` | The address is wrong or the Worker is not deployed. Check the address from Step 9. |

To watch requests arrive while someone tries to connect, run this and leave it open. Control-C stops it.

```sh
npx wrangler tail --env staging
```

## Remove it

If you set up the shared server, remove it first, because these commands need the folder and the `skylight-mcp` command. The first takes away the server's Skylight sign-in and the second deletes the Worker. Both ask before they do anything, so run them one at a time.

```sh
skylight-mcp remote logout --env staging
npx wrangler delete --env staging
```

Do the same with `production` if you deployed it, then delete the client you created in the Google Cloud console.

On your Mac, sign out and remove the command:

```sh
skylight-mcp logout
npm uninstall -g @jordanlawson/skylight-mcp
```

Last, delete the `skylight` entry from the Claude Desktop config, restart Claude Desktop, and move the `skylight-mcp` folder to the Trash.
