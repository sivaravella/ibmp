# Turning on Google and LinkedIn sign-in

IBMP shows "Continue with Google" and "Continue with LinkedIn" only when that provider's client ID **and** secret are set. Email and password sign-in always works. Each provider needs an app that you create in its developer console; nobody else can do that for you.

You need the address people use to open IBMP. Locally that is `http://localhost:4000`; in production it is your own domain, for example `https://app.example.com` (set `IBMP_PUBLIC_URL` to it, without a trailing slash). The two **redirect URIs** to register are:

```
<address>/v1/auth/social/google/callback
<address>/v1/auth/social/linkedin/callback
```

For example `http://localhost:4000/v1/auth/social/google/callback`. They must match exactly, including `http` or `https`.

## Google

1. Open <https://console.cloud.google.com/>, create or pick a project.
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name (IBMP), your support email and developer email. Scopes needed: `openid`, `email`, `profile` (the defaults). While the app is in *Testing*, only the test users you list can sign in; click *Publish app* when you are ready for everyone.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
4. Under **Authorised redirect URIs** add the Google URI above (add both the localhost and the production one if you use both).
5. Copy the **Client ID** and **Client secret** into `IBMP_GOOGLE_CLIENT_ID` and `IBMP_GOOGLE_CLIENT_SECRET`.

## LinkedIn

1. Open <https://www.linkedin.com/developers/apps> and **Create app** (it needs a LinkedIn Page for the company).
2. **Products** tab: add **Sign In with LinkedIn using OpenID Connect** (approval is usually immediate).
3. **Auth** tab: under **Authorized redirect URLs for your app** add the LinkedIn URI above.
4. Copy the **Client ID** and **Primary Client Secret** into `IBMP_LINKEDIN_CLIENT_ID` and `IBMP_LINKEDIN_CLIENT_SECRET`.

## Where the values go

- **On your computer:** the git-ignored `.env` at the repository root, then restart `npm run local`.
- **In production or Docker:** the same four variables in the host's environment or the `.env` next to `docker-compose.yml`, plus `IBMP_PUBLIC_URL`. Restart the app.

Never commit these values. If a secret is shared by mistake, create a new one in the provider's console and replace it.

## How people use it

- A new person chooses *Sign up with Google/LinkedIn*, is asked once for their business details and starts the free trial.
- Someone who already has a password account with the same email is asked for that password once before the provider is linked (IBMP does not verify emails at sign-up, so a matching email alone proves nothing); an account already linked to another provider is linked silently. Under **Sign-in & security** they can set a password or unlink a provider.
- Providers that do not report a verified email address are refused.

## Branding verification (Google)
Google shows your app name and logo on its consent screen only after the branding is verified. Until then the account chooser says "to continue to ibmp.apbiz.in" and no logo. Steps taken on 9 October 2026:
- The home page (https://ibmp.apbiz.in), privacy policy (/privacy) and terms (/terms) are public.
- Ownership of `https://ibmp.apbiz.in/` is verified in Google Search Console with the HTML file `google5032e72075285ceb.html` (kept in `apps/web/public/`; do not remove it or Search Console loses the verification).
- The logo must be a square PNG or JPEG of at most 1 MB, ideally 120 x 120 px or larger. `docs/ibmp-logo-google-512.png` is the apbiz symbol on white at 512 x 512 and matches the logo on the site.
- After uploading a logo, run Google Auth Platform → Branding → Verify branding. If it reports an issue, fix it, wait 24 hours when Google asks you to, then choose "I have fixed the issues". Any later change of name or logo needs verification again.
