# Yomu extensions

Declarative source adapters and runtime-store metadata for Yomu. **This repository is Yomu's community extension pack** — point the Worker at it with `EXTENSIONS_REPO`.

```bash
npx wrangler secret put EXTENSIONS_REPO
# https://raw.githubusercontent.com/<you>/yomu-extensions/main
```

## Two extension lanes

Yomu intentionally separates safe Worker-native descriptors from executable Mihon/Aniyomi extensions.

### 1. Declarative descriptors

Cloudflare Workers do not execute adapter code fetched from a repository. These adapters are **data**: they declare URLs, JSON paths, CSS selectors, transforms, rate limits, and host allowlists. The executor lives in the Worker.

The practical consequence is that a site change normally needs only a descriptor version bump. The security consequence is that a hostile descriptor cannot run arbitrary code or contact a host it did not declare.

### 2. Runtime stores

`runtime-stores.json` contains community extension repositories discovered from Wotaku's Mihon/Aniyomi list. These repositories contain APK/JAR source extensions and are **not** executed by Cloudflare.

Yomu's Universal Extension Runtime sends them to an isolated JVM engine (currently the miwayomi bridge), which loads the real Mihon/Aniyomi source implementation and exposes a normalized read-only contract back to Yomu:

`popular/latest/search -> details -> chapters -> pages`

The same HTTP contract can be implemented by another reader, so readers do not need to understand Android APK bytecode themselves.

Runtime-store metadata never grants public install/uninstall access. Installing third-party executable extensions remains an operator-controlled action on the isolated runtime.

## Layout

```text
index.json                    declarative adapter registry
sourcepack.json               verified website Source Forge pack
runtime-stores.json           Mihon/Aniyomi executable store registry
schema/extension.schema.json  declarative adapter schema
sources/<id>.json             one declarative adapter per file
```

## Publishing a declarative update

1. Edit `sources/<id>.json`.
2. Increment `version` there **and** in the matching `index.json` entry — they must agree, or the descriptor is rejected.
3. Push. Yomu revalidates within its registry cache window (15 minutes), or immediately via `/api/ext/refresh`.

## What a descriptor may do

`GET`/`POST`, query parameters, headers, pagination arithmetic, JSON responses with path extraction (including `[0]` indices and `[key=value]` predicates), HTML responses with CSS selectors and attribute extraction, request chaining, filtering, and the transform list in the schema (regex, replace, trim, prefix/suffix, concat, numeric, date, pluck, map, default, URL resolution). Per-source timeouts, rate limits and cache lifetimes are declared here too.

## What it may not do

Run code. Contact a host outside its `hosts` allowlist. Defeat a login, paywall, CAPTCHA, DRM, or access control.

## When a source does not fit

Do not stretch the descriptor engine.

- **`native-required`** — needs first-party custom logic. Write a native provider in `worker/providers/`.
- **`runtime-required`** — a maintained Mihon/Aniyomi extension already implements the source. Execute it in the isolated Universal Extension Runtime instead of reimplementing it in Cloudflare.
- **`browser-required`** — needs interactive browser state. Keep it out of Worker execution and report the requirement honestly.

A source may also be partially expressible. For example, a descriptor can contribute discovery while reading is delegated to a stronger provider/runtime.
