# Walrus Club Beta: feedback tool

A phone-friendly page where beta testers post bugs, ideas and other comments during the 30-day
test, and see what everyone else posted. No accounts, nothing to install, free to run.

Built from `../beta-feedback-spec.md`. That file holds the decisions and the reasoning; this one
holds the operating instructions.

## The three pieces

| Piece | What it is | Who sees it |
|---|---|---|
| The page | `index.html`, one file, served by GitHub Pages | Testers |
| The door | A Google Apps Script web app attached to the Sheet | Nobody |
| The store | One Google Sheet, two tabs | Operator only |

The page cannot store anything by itself. A file on GitHub Pages is just a file, so without the
door and the store each phone would only ever see its own posts.

## Layout

```
index.html              the whole page: HTML, CSS and JavaScript, no dependencies
apps-script/Code.gs     the door. Source of truth, pasted into Google by hand
README.md               this file
```

One constant at the top of `index.html` holds the Apps Script URL:

```js
var API_URL = 'PASTE_THE_APPS_SCRIPT_WEB_APP_URL_HERE';
```

That is the only thing that changes between "built" and "live". The URL is not a secret: the page
is public anyway.

## Setup, Google side (about ten minutes)

These need clicks in Google's interface and cannot be done from the terminal.

1. **Make the Sheet.** In Google Drive, create a blank Sheet named `Walrus Club Beta Feedback`.
   Rename the first tab to `reports`, add a second tab named `votes`. Put these headers in row 1,
   one per column, spelled exactly like this and all lower case:

   - `reports`: `id`, `created_at`, `updated_at`, `name`, `type`, `level`, `text`, `device`, `deleted`
   - `votes`: `report_id`, `name`, `created_at`

   The script finds columns by header name, so the order can change later, but a misspelled header
   will stop it with a message naming the column it could not find.

2. **Paste the script.** Extensions → Apps Script. Delete the sample `myFunction` code, paste the
   whole of `apps-script/Code.gs`, save.

3. **Deploy it.** Deploy → New deployment → gear icon → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**

   Then Deploy. "Anyone" means anyone with the URL can call it; that is the point, since testers
   have no accounts.

4. **Authorise.** Google will ask you to allow the script to open your Sheet, and will show a
   "Google hasn't verified this app" warning. Click Advanced, then "Go to ... (unsafe)". You are
   allowing your own script to touch your own Sheet, nothing else.

5. **Connect the page.** Copy the web app URL (it ends in `/exec`). Paste it into `API_URL` at the
   top of `index.html`, replacing the placeholder. Commit and push.

6. **Test it.** Open the live page on your phone. Post a report, vote on it, edit it, delete it.
   Then clear the test rows in the Sheet, or leave them and delete from the page.

Until step 5 is done the page shows "Not connected yet" instead of a list. That is expected.

### The one non-obvious rule

**Any later change to `Code.gs` needs a new deployment version**, or the live door keeps running
the old code. Deploy → Manage deployments → pencil icon → Version: **New version** → Deploy.
Editing and saving the script in the editor is not enough. This catches everyone once.

## Setup, GitHub side

```bash
cd ~/Developer/walrus-club/beta-feedback
gh repo create gmullebr/beta-feedback --public --source . --push
```

Then Settings → Pages → Source: Deploy from a branch → Branch `main`, folder `/ (root)`.

The address is `https://gmullebr.github.io/beta-feedback/`. Each `git push` updates the live page
within about a minute.

### Putting a Walrus Club address in front of it (decision 25)

Pending a name agreed with the founder. Pages keeps serving the page either way, so the one-minute
deploy loop does not change. When the name is settled, it is two steps:

1. Whoever holds the DNS adds one `CNAME` record, for example `feedback` pointing at
   `gmullebr.github.io.` (the trailing dot matters).
2. In the repo, add a file named `CNAME` containing just the full domain, then push. Settings → Pages
   → Custom domain will pick it up and issue the certificate, which takes a few minutes.

Do not add the `CNAME` file before the DNS record exists and resolves. Pages will start serving on a
domain that does not answer, and the live page goes dark until you remove it.

## Go-live checklist

Run these before sending the link to testers, on a phone or in a browser's phone emulation.

- [ ] Two different names on two browsers: each sees the other's posts.
- [ ] Edit and Delete appear only on your own posts.
- [ ] Vote from one phone shows on the other after Refresh; unvote removes it.
- [ ] The same name from two browsers counts as one vote.
- [ ] Bug requires a level; Other has no level field; Send stays greyed out until the required
      fields are filled.
- [ ] Delete asks for confirmation, and the Sheet row is marked `TRUE` in `deleted` rather than
      removed.
- [ ] Airplane mode on Send: the error line shows, the typed text stays, retry works when back on.
- [ ] Private browsing: everything works, the name is asked each time.
- [ ] Filters and both sorts behave; an empty filter shows a friendly line.
- [ ] Nothing scrolls sideways on a narrow phone, and the Report button stays reachable.

All of these were verified during the build against a local stand-in for Apps Script. They are
repeated here because the real thing is Google's, not the stand-in's.

## Operating the test

- **The Sheet is the admin screen.** Open it to read, sort, filter or export. There is no admin UI
  and there is not meant to be.
- **Deleting for real.** Testers' deletes are soft: the row stays with `deleted` set to `TRUE`. To
  remove a row permanently, delete it in the Sheet.
- **Device is operator-only.** Every report records the phone it was written on, but the page never
  shows it. Read it in the Sheet when you need to know whether a bug is iPhone-only.
- **Reading a reference.** Testers quote reports as `#B14`, `#I7`, `#O3`. The letter is just the type
  (Bug, Idea, Other) and is worked out by the page; only the number is stored. So `#B14` is the row with
  `id` 14. If someone edited that report's type since posting, the letter shown will have changed but the
  number never does, so look up the number and ignore the letter.
- **Screenshots** go in the WhatsApp group with the report number, for example `#B14`. The page says
  so at the top.
- **Fixing data by hand** is fine. Edit cells in the Sheet directly; the page picks the change up on
  the next Refresh. Do not renumber `id`, since `votes.report_id` points at it.

## Out of scope for the 30 days

Status labels, comments, notifications, brand styling, login, image upload, admin screen. Section 11
of the spec lists what could come later.
