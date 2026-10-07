# Data through Cast

(Without Cast, see [direct-feed.md](direct-feed.md).)

A legacy widget reads a feed (for example
`{{BASE_URL}}/cricket/live/json/{{LANG}}{{SERIESID}}_standings.json`) and
shapes it in the client parser. On Surface the plugin calls a **Cast
workflow** instead. The Cast MCP is how you find or create that workflow
while porting. The plugin never talks to the MCP.

## Setup

The `cast` MCP server is HTTP, authenticated with a bearer token, plus a
`client` header naming the tenant's Cast client.

Claude Code (project or user scope):

```bash
claude mcp add --transport http cast https://dev-fanxp.sportz.io/fanxp/api/v1/cast/mcp \
  --header "Authorization: Bearer $CAST_MCP_TOKEN" --header "client: <client>"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.cast]
url = "https://dev-fanxp.sportz.io/fanxp/api/v1/cast/mcp"
bearer_token_env_var = "CAST_MCP_TOKEN"
http_headers = { client = "<client>" }
```

Check the setup:
- Claude Code: `claude mcp list`.
- Codex: `codex mcp list`.
- In the session, the cast tools appear.

A 401 (`AUTH_02`) means the token is expired or wrong. Get a fresh one; the
skill cannot work around it. The local backend serves the same MCP at
`http://localhost:4400/fanxp/api/v1/cast/mcp`.

## While porting (agent time)

1. **List the cast tools first.** Their names and inputs are the source of
   truth; don't guess them.
2. **Know what the widget needs.** From the inventory, collect:
   - the feed template and its placeholders (`{{LANG}}`, `{{SERIESID}}` …,
     resolved by the client's API replacer);
   - the parser entry, and every field it reads;
   - the settings that change the request (series, season, team …).

   Fetch one real legacy feed response from the tenant's Surface host. The
   edge proxies the legacy paths. Keep the response as the reference.
3. **Find an existing workflow** for the tenant that serves this data. Search
   by the feed path, the sport-data endpoint behind it, or the data's name
   (standings, fixtures, squad). Run it with the settings' values.
4. **Compare its output with the legacy feed**, field by field, for
   everything the parser reads: names, nesting, types, ordering. Note what is
   missing or renamed.
5. **If nothing fits, propose a workflow to the user** and wait for a yes
   before creating it. The proposal covers:
   - name and id;
   - inputs (query params, with the settings that feed them);
   - upstream (the legacy feed path, or the sport-data API it is built from);
   - output shape (prefer the legacy feed's shape, so the legacy parser
     ports 1:1).

   Then create it with the MCP and run it.
6. **Save the workflow response as `sample.json`.** It is the test fixture,
   and it is what `prepare` parses.
7. **Record in the README:** the workflow id, its inputs, and how each setting
   maps to an input.

## In the plugin (runtime)

- `prepare` calls the workflow bound to the plugin's template:

  ```ts
  const res = await ctx.cast({ series_id: config.seriesId, lang: config.lang });
  ```

  To target a workflow other than the template's own:
  `ctx.cast.run(id, args)`. Args become query params on top of the
  renderer's context (url, device, dns, template_id, page …).
- Browser refetches (filters, season switches): pass `ctx.callWorkflow` to
  the component as a prop and call it with the new params, the way
  `fortress/listing-filter` does (`logic/use-workflow-listing.ts`).
- The response may wrap its payload (`[{ data: { … } }]`, `{ data }`). Unwrap
  it in the parser and test each shape, as `fortress/standings-filter`
  (`logic/api-url.ts`) does.
- On failure: `ctx.telemetry.captureException`, then return a model that
  still renders (for example the table header only). `prepare` never throws.
- Tests mock `ctx.cast` with `sample.json`, a failure, and an empty response.

## Admin (tell the user; never do it yourself)

Bind the workflow to the page template that carries the plugin. Without it,
`ctx.cast()` has nothing to call. Publish the workflow for the tenant's
environment (dev, then prod) along with the page.
