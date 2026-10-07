# How to import this project into another Claude account

There's no direct account-to-account transfer in Claude, so you move a project by recreating it and uploading its files.

## Steps

1. Sign in to the **other** Claude account at claude.ai.
2. Go to **Projects → Create project**. Name it **IBMP**.
3. Open the project's **Instructions** and paste the text from the "Suggested custom instructions" block at the end of `00_PROJECT_CONTEXT.md`.
4. Upload these files to the project's knowledge, in this order:
   - `00_PROJECT_CONTEXT.md`
   - `2_lock_and_tests/IBMP_BASELINE_LOCK.md`
   - `1_app/IBMP_App_v6.2.html` (current version)
   - `1_app/IBMP_App_v6.0_BASELINE_LOCKED.html` (frozen baseline)
   - `2_lock_and_tests/regression_check.js` and `2_lock_and_tests/baseline_v6.2.json`
   - Optional: `IBMP_App_v6.1.html`, the older baselines, and the `3_source/` files
5. Start a chat in the new project and say: *"Read the project context and confirm the current version and lock rules."*

If a file type is refused on upload, keep the original zip and attach the needed file directly in a chat when you need it.

## What's in the package

| Folder | Contents |
|---|---|
| `1_app/` | v6.0 locked baseline, v6.1, **v6.2 (current)** |
| `2_lock_and_tests/` | Lock document and version log, regression checker, baseline snapshots (v6.0/v6.1/v6.2), functional test scripts |
| `3_source/` | Returns module source (`rtn_module.html`) and the v6.2 build script (`build_v62.py`) |

## Not transferred automatically

- **Chat history:** past conversations stay in the old account. `00_PROJECT_CONTEXT.md` summarises what was decided in them.
- **Claude's memory:** memory belongs to each account. The key facts are in `00_PROJECT_CONTEXT.md`, so the new project starts with them.
- **Foundation documents** (PRD, Database Schema, API Spec, Compliance Rules Engine, GST Logic): these weren't in this project. Upload them separately if you want them in the new one.

## Running the checks yourself (optional)

You need Node.js and Playwright (`npm i playwright`, then `npx playwright install chromium`). Put the app HTML files in the same folder as the scripts, then run:

```
node regression_check.js IBMP_App_v6.2.html --baseline baseline_v6.2.json
```

## File fingerprints (SHA-256)

- v6.0: `e48e320adf818af3abc8aa1655843282abe7fb9a7cff68417eadf327e56955db`
- v6.1: `42c921e4a9614f16a3c39fb77b29800fa453f55615500a43b7f8d908539818fe`
- v6.2: `085226b217ae388ee2b6c75bb5b78e93600187e734c2e79dc8898c8714a14c6a`
