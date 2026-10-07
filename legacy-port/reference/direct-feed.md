# Data without Cast (direct feed)

Use this instead of [cast.md](cast.md) when the user says "no Cast" / "no
workflow", or when no workflow fits and they decline creating one. The shape
follows `fortress/sb-points-table`: `prepare` fetches with
`ctx.networkManager`, the URL is built from the tenant, and everything that
varies is a setting.

## 1. Pick the data source

In this order:

1. **A newer API.** Look for a `cricket/v1/...` (or other maintained)
   endpoint that serves the same data: the client's `widgetConfig.json`, the
   backend repo, the feeds the sibling plugins call, and the user. Do not
   accept a guessed URL because it answers 200: the tenant host returns
   `{"message":""}` with 200 for **any** unknown `cricket/v1/...` path. Prove
   an endpoint by comparing it with an obviously fake path, and by checking
   the fields the legacy parser reads.
2. **Otherwise the legacy production feed.** Take it from the widget's
   `apis` entry in `clients/<client>/js/widgetConfig.json` (the inventory
   prints it as `apis:`), e.g. `cricket/live/json/1_{{SERIESID}}_auctions.json`.
   Fetch it from the tenant's **Surface host** and from the legacy host and
   confirm both answer with the same payload; the edge proxies the legacy
   paths.

Say in the README which one was chosen and why. If it is the legacy feed,
say that a maintained API should replace it when one exists; that swap must
be a setting change plus a parser change, nothing more.

## 2. Settings

The **manifest is the single source of defaults.** Declare in
`configSchema`:

| Setting | Meaning |
|---|---|
| `api_url` | Feed path or full URL; `{series_id}` (and other placeholders) are replaced. A path is resolved against the tenant host. Default = the source chosen above. |
| `api_series_id` | Series the feed is for. Never taken from the page URL. |
| `api_client_id`, `api_lang` | When the feed takes them (the `cricket/v1` APIs do). |
| widget-specific ids | `team_id`, `active_team_ids` … whatever the legacy widget read from its mount attributes (`series-id`, `team-id`) or settings. |
| `poll_seconds` | Only for live data; `0` turns polling off. |

`ctx.config` is the binding's `config` items flattened to `{ name: default }`.
An item with no value arrives as a key whose value is `undefined`, and
`{ ...MANIFEST_DEFAULTS, ...ctx.config }` lets that `undefined` overwrite the
default. Drop undefined keys before merging:

```ts
function buildManifestDefaults(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const entry of manifest.configSchema) defaults[entry.name] = entry.default;
  return defaults;
}
const MANIFEST_DEFAULTS = buildManifestDefaults();

const defined = Object.fromEntries(
  Object.entries(ctx.config).filter(([, v]) => v !== undefined && v !== ""),
);
const config = { ...MANIFEST_DEFAULTS, ...defined };
```

Read each value through a small `readString(config, key, fallback)` helper
that trims and falls back, and validate enums against an allowlist.

## 3. The tenant, never a hard-coded host

`ctx.tenantId` is the host the page was served from: `X-Forwarded-Host`
(or `host`) in production, `process.env.DNS` under `next dev`, unless the
template carries its own `tenant_id`. Build every URL from it:

```ts
// Server (prepare): absolute, no browser base available.
const buildAbsoluteUrl = ({ path, tenantId }) =>
  path.startsWith("http") ? path : `https://${host(tenantId)}${path}`;
// Browser: the same string, or the path alone (same origin).
```

`host()` strips a scheme and trailing slashes. Production never needs it, but
a dev `DNS=https://pk.surface.fan-os.net/` otherwise yields
`https://https://…//`. Never write a tenant name, domain or CDN host in a
plugin.

## 4. `prepare`

- One `try/catch` **per fetch**, each reporting with a stage and URL, and
  falling back to an empty result:

  ```ts
  ctx.telemetry.captureException(err, { plugin: "<id>", stage: "prepare.<name>", url });
  ```

- `prepare` never throws and always returns a model the component can render.
- Parse in `logic/parse-*.ts` into a small view model; the raw feed is often
  hundreds of KB and must not travel to the browser.
- Pass the browser what it needs to refetch (the relative URL, ids), not the
  config object.

## 5. The component

- Seed state from the prepared data, so server HTML shows real content on
  first paint. Show a skeleton only when the server result was empty.
- If the server fetch failed or came back empty, retry **once** in the
  browser on mount.
- Re-sync from props when `data` changes (client navigation reusing the
  instance).
- Live data: poll with `setInterval` only while the feed says it is live (or
  incomplete), stop when it is not, add a cache-busting `?v=<timestamp>`
  when the legacy widget did, keep the current view on failure, and ignore a
  response that a newer request has overtaken (a request counter).

## 6. Tests

Mock `ctx.networkManager.get` and cover: success, the URL it was called with
(built from `ctx.tenantId`), a scheme-carrying tenant id, a failing fetch
(renderable model plus `captureException` with the stage), a missing tenant,
unset/`undefined` settings falling back to the manifest default, and the
component's retry, polling and out-of-order handling.

## 7. README "Data source"

Which source was chosen and why, the URL template, every setting and what it
changes, the tenant rule, and the freshness note (cached HTML; what refreshes
in the browser). When a Cast workflow replaces this, `parse-*.ts` is kept and
only the fetch in `prepare` changes.
