# Leaderboard and admin guide

Everything needed to run, test and hand over the KSFO Ground Trainer's LEADERBOARD: how it works, the admin view, adding admins, sign-in methods, the Firebase console, rule changes and local testing.

## At a glance

- The trainer is a static site on GitHub Pages. Scores live in Firestore, in the Firebase project **ksfo-ground-trainer**.
- The page talks to Firestore's REST API with plain `fetch`, so the normal page loads no Firebase library.
- Players never sign in. Only admins do, and only on the hidden `?admin` view.
- Firebase console: https://console.firebase.google.com/project/ksfo-ground-trainer/overview
- Live site: https://jimpdx.github.io/sfoguesser2/ (admin view: https://jimpdx.github.io/sfoguesser2/?admin)

### Files

- `firestore.rules`: who may read, post and delete. This is the real protection.
- `firestore.indexes.json`: the index the top 10 query needs.
- `firebase.json`: points the Firebase CLI at those two files and sets the emulator port (8085).
- `.firebaserc`: makes ksfo-ground-trainer the default project for `firebase` commands in this folder.
- `data/sfo/airport.json`, the `leaderboard` block:
  - `projectId`: the Firebase project. Leave it empty and the board is hidden; everything else still works.
  - `apiKey`: the web app's key. Firebase web keys are meant to be public; the rules protect the data.
  - `authDomain`: used by the admin view's sign-in.
  - `signIn`: which sign-in buttons the admin view shows (`google`, `github`).

### What's stored

- `airports/KSFO/scores/{id}`: one document per posted score.
  - name, mode (`ten` or `streak`), pool (the set of areas, like `A,B,C,D,E,F,G,spots`), score, of (Quick 10 only: questions asked), ms (time in milliseconds), at (when it was posted).
- `airports/KSFO/runs/{id}`: one per challenge started, with startedAt, endedAt and used. Nobody sees these; they only exist so the rules can check times. They pile up harmlessly and can be ignored.
- `admins/{user ID}`: one document per admin. See "Managing admins".

`KSFO` isn't a separate record, just the folder the trainer's data sits under, so a future airport could share the project.

## How the boards work

- There's a separate top 10 for each mode (Quick 10, Streak) and each set of areas. The panel names the board, like "Quick 10: All gates and spots" or "Streak: Areas E, F + spots". New visitors start with every area on, so most people play the full-airport boards.
- Ranking:
  - Quick 10: percent, then shorter time.
  - Streak: count, then shorter time.
  - Exact ties: whoever posted first stays ahead.
- Times:
  - Quick 10 runs from Start to the end of the last question. That includes the 2-second green "Correct" banners and the pause after a miss until you tap or press Space.
  - Streak stops at your last correct answer, so the click that ends the run doesn't count.
- When a finished run would make the top 10, a name row opens at its rank. Names are 1 to 6 characters of A-Z, 0-9 and _ (like ZOA_JT or JIMT). The last name used on that device is filled in. Enter saves, Esc skips.
- Runs that don't make the board never ask for a name. Personal bests are still kept in that browser.

## How scores are kept honest

All of this is enforced by `firestore.rules`, on Google's side, not by the page:

- Starting a challenge creates a run record whose start time Firestore stamps itself. Finishing stamps its end time once.
- A score is posted in the same write that marks its run used, so each run can post at most once.
- A Quick 10 time has to match Firestore's own measurement of the run to within 3 seconds either way. A Streak time can't be longer than the run.
- No time can beat the floor the game sets: each correct answer holds the screen for 2 seconds (the rules allow 1.9 for timer jitter).
- Names must match the format above, and a short list of rude words is refused. The same list is in `app.js` (`NAME_RUDE`) so the page can say so before posting; keep the two in step.
- Nobody can edit a score. Only admins can delete one.
- The public can read the boards only 10 scores at a time, and can't read run records or the admin list.

The limit: someone determined could script a run that genuinely waits out the time and posts a perfect score. Treat the board as a friendly one, and delete anything silly.

## The admin view

Open the site with `?admin` added, for example https://jimpdx.github.io/sfoguesser2/?admin, then switch to **Quick 10** or **Streak**. The Admin box sits under the LEADERBOARD, and Learn mode has no board, so it won't show there.

- The box and its sign-in buttons appear only with `?admin`. Ordinary visitors never see them, and the Firebase sign-in library loads only in this view.
- Anyone can find `?admin` by reading the public code. That's fine: signing in gets them nothing unless their account is on the admin list in Firestore.
- Signed in as an admin you get:
  - an × on each score, to delete that one entry,
  - **Clear this board**, which deletes every score on the board you're looking at,
  - **Clear all boards**, which deletes every KSFO score in both modes and every set of areas. It asks you to type CLEAR.
- Deleted scores can't be restored.
- Signed in with an account that isn't an admin, the box shows that account's user ID with a **Copy user ID** button. That's how new admins get their ID to you.

## Managing admins

### Accounts and sign-in methods

Firebase keeps two things apart:

- **The account**: one record per person, with one **user ID**. The admin list names accounts by user ID.
- **The sign-in method**: how you prove you're that person (Google or GitHub).

Think of the account as a locker and the sign-in methods as keys. The admin list names the locker, so any key that opens it works.

Firebase allows **one account per email address** by default. When someone signs in with a second method that uses the same email:

- Usually Firebase refuses, and the box says "That email already signs in another way." Use the method used before.
- If Google manages that email address (Gmail or Google Workspace), Firebase lets the Google sign-in into the existing account instead, so both methods reach the same user ID. It sometimes drops the earlier method when it does this; the Providers column in Authentication, Users shows which methods an account still has.
- To allow a separate account per method instead, change Authentication, Settings, User account linking to "Create multiple accounts for each identity provider".

A different email address always gets its own account and its own user ID, so one person can be an admin through two accounts (for example a personal and a VATUSA Google account). Each needs its own entry.

### Adding an admin

1. They open `?admin`, switch to Quick 10 or Streak, sign in, and click **Copy user ID**. They send you the ID.
   - Or find it yourself after they've signed in once: Authentication, Users tab, User UID column.
2. In the Firebase console, open Firestore Database, Data tab.
3. Open the `admins` collection. The first time, click **Start collection** and enter `admins` as the collection ID.
4. Add a document:
   - Document ID: paste the user ID exactly. Don't use Auto-ID.
   - Field: `name`, Type: string, Value: who it is, like `GO` or `Jim (VATUSA)`.
   - Save.
5. They reload the admin view and get the delete and clear buttons.

The name field is only a label for you; the rules only check that a document with that ID exists. Nobody can add themselves: the page has no write access to `admins`, only the console does.

### Removing an admin

Delete their document from `admins`. Their next action is refused.

### Admins versus project owners

- Page admins (the `admins` list) can delete scores from the admin view and nothing else.
- Firebase project owners and editors can do anything in the console: see and delete data, change sign-in settings, deploy rules. Manage them under Project settings, Users and permissions.

## Sign-in methods

The buttons come from `leaderboard.signIn` in `data/sfo/airport.json`. Each method listed there also has to be turned on in the console under Authentication, Sign-in method, or its button fails. Remove a method from the list to hide its button; no code change is needed.

### Google

- Turned on under Authentication, Sign-in method, Google, with a project support email.
- Google's sign-in window may say you're continuing to "project-32372736558". That's the project's default public name. Change it under Project settings, General, Public-facing name.

### GitHub

GitHub sign-in uses a GitHub OAuth App:

1. In Firebase, Authentication, Sign-in method, add GitHub and turn on Enable. Note the callback URL it shows: `https://ksfo-ground-trainer.firebaseapp.com/__/auth/handler`.
2. On GitHub: Settings, Developer settings, OAuth Apps, New OAuth App (or the same under an organization, so others can manage it).
   - Homepage URL: https://jimpdx.github.io/sfoguesser2/
   - Authorization callback URL (some forms call it Redirect URI): the handler URL above.
3. Register it, generate a client secret, and paste the Client ID and the secret into Firebase's GitHub panel. Save.

The client secret belongs in Firebase only: never in this repo, a chat or an email. If it leaks, generate a new one on the GitHub app page, delete the old one, and paste the new one into Firebase.

### Authorized domains

Sign-in only works from host names on Authentication, Settings, Authorized domains. Enter bare host names, with no `https://` and no path. The list now has `localhost`, `127.0.0.1` and `jimpdx.github.io` (plus Firebase's own two). If the trainer moves to another host, add it there.

### Sign-in errors and what they mean

- **auth/configuration-not-found**: Authentication was never set up in this project. Click Get started under Authentication.
- **auth/operation-not-allowed**: that sign-in method isn't turned on (or wasn't saved) in this project. Check the project name at the top left of the console, since it reopens the last project you used.
- **"This site isn't on the Firebase sign-in list yet"**: add the host name under Authorized domains.
- **"That email already signs in another way"**: the one-account-per-email rule. See "Accounts and sign-in methods".
- **GitHub says the redirect_uri isn't associated with this application**: the OAuth App's callback URL doesn't exactly match the handler URL.

## The Firebase console

Data: https://console.firebase.google.com/project/ksfo-ground-trainer/firestore/databases/-default-/data

- The Data tab has three columns: collections, documents, fields. Go `airports`, `KSFO`, then `scores` or `runs`.
- To delete a score, select it and use the menu at the top of the fields column. To wipe a whole collection, use the menu on the collection.
- A collection only appears after something has been written to it.
- The console works whatever the rules say, so it's always the fallback for cleaning up.

## Changing the rules or the index

1. Sign the CLI in once per machine: `firebase login`.
2. Edit `firestore.rules`.
3. Test against the emulator (next section). The emulator reloads the rules whenever you save.
4. Deploy, from the repo folder:
   - Rules only: `firebase deploy --only firestore:rules`
   - Rules and index: `firebase deploy --only firestore`
5. Rule changes take up to a minute to reach everyone. A new or changed index takes a few minutes to build; until then the board says it's offline.

Things that are tied together:

- The 1.9-second floor in the rules matches `CORRECT_MS` (2000) in `app.js`. Change one and you need to change the other.
- The rude-word list is in both `firestore.rules` and `app.js` (`NAME_RUDE`).
- The top 10 query in `app.js` (`fetchBoard`) needs the index in `firestore.indexes.json`. Changing its filters or sort order means changing the index.

## Testing locally

Run the local server from the repo folder (`python -I tools/serve.py`, then open http://127.0.0.1:8000). From there:

- **Plain URL**: the leaderboard uses the **live** project. Scores you post are real and appear on the public boards. Clean up with the admin view afterward.
- **`?emulator`**: the leaderboard uses a throwaway Firestore on your own PC instead.

### The emulator

The Firestore emulator is a local copy of Firestore that comes with the Firebase CLI and needs Java. Start it from the repo folder:

```
firebase emulators:start --only firestore --project demo-ksfo
```

- It listens on port 8085 (set in `firebase.json`). Open http://127.0.0.1:8000/?emulator to play against it, or `?emulator=PORT` if you run it elsewhere.
- `demo-ksfo` is a throwaway project ID, so nothing reaches Google.
- It uses this repo's `firestore.rules`, reloaded whenever you save the file, so you can try rule changes before deploying them.
- Its data lives in memory and is gone when you stop it with Ctrl+C.
- It doesn't need an internet connection.
- The admin view needs the live project (the emulator has no sign-in), so with `?emulator` the Admin box just says so.
- On the public site, `?emulator` does nothing harmful: the visitor's browser looks for an emulator on their own computer, finds none, and the board says it's offline.

## Moving or handing over

- **Moving the site** (to a ZOA domain or a vhcf.net subdomain): add the new host name under Authorized domains and update the GitHub OAuth App's Homepage URL. The callback URL stays the same. Nothing in `airport.json` depends on the host.
- **Handing it to someone else** (GO, as ZOA webmaster):
  - Firebase: add them as an Owner under Project settings, Users and permissions.
  - Admin view: add their user ID to `admins`.
  - GitHub OAuth App: transfer it from its settings page, or create a new one under their account or the ZOA organization and paste its Client ID and secret into Firebase.
  - The repo itself: transfer it on GitHub, or let them fork it.
- **Cost**: the project is on Firebase's free Spark plan. Each challenge costs a couple of writes and each board view about ten reads, far inside the free daily allowance.
