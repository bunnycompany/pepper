# Deploying Pepper's broadcast site

`pepper export` writes a fully static site to `./pepper-site` (change it with
`--out <dir>`). It contains the 3D newsroom, your ten newest bulletins in
`data/broadcast.json`, and your avatar if you have one. There is no server
code: visitors' browsers render the studio and synthesize Pepper's voice with
their own TTS. Any static host works — this guide uses Cloudflare Pages.

## Option A — Cloudflare Pages dashboard (drag and drop)

1. Run `pepper export`.
2. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers &
   Pages** → **Create** → **Pages** → **Upload assets**.
3. Name the project (this becomes `<project>.pages.dev`).
4. Drag the `pepper-site` folder into the upload box and hit **Deploy**.

She's live at `https://<project>.pages.dev` a few seconds later.

## Name your station

The exported site ships with the default branding — `MNN — Model News Network`
in the browser tab and on the bug. Make it yours before exporting:

```sh
pepper config set site.title "KPEP — Pepper's Public Wire"
pepper config set site.tagline "Your beat. Every hour."
pepper export
```

(Or set `site.title` / `site.tagline` in `~/.pepper/config.json` by hand.)
The export picks the new name up immediately; an already-running local studio
reads config once at start, so restart `pepper start` to see it there too.

## Option B — wrangler CLI

```sh
pepper export
npx wrangler login                                    # first time only
npx wrangler pages deploy pepper-site --project-name my-mnn
```

## Custom domain

Works for any domain you own:

1. In the Pages project, open **Custom domains** → **Set up a custom domain**.
2. Enter your domain or a subdomain (e.g. `mnn.example.com`).
3. If the domain's DNS is already on Cloudflare, the record is added for you.
   Otherwise, add the CNAME it shows you at your registrar, pointing at your
   `<project>.pages.dev` hostname.
4. Wait for DNS and the certificate to go active (usually minutes). Done.

## Keeping the show fresh

The export is a snapshot of the desk at the moment you ran it. To refresh the
broadcast, re-run the export and redeploy:

```sh
pepper export && npx wrangler pages deploy pepper-site --project-name my-mnn
```

To automate it, add a cron job on the machine where Pepper runs (crontab -e):

```cron
# Refresh the broadcast at the top of every hour
0 * * * * cd $HOME && pepper export --out $HOME/pepper-site && npx wrangler pages deploy $HOME/pepper-site --project-name my-mnn >> $HOME/.pepper/logs/deploy.log 2>&1
```

Cron runs with a minimal PATH — if `pepper` or `npx` aren't found, use
absolute paths (`which pepper` / `which npx` to find them).
