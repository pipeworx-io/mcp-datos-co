interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * datos.gov.co — Colombia's national open-data portal (Socrata platform).
 *
 * Keyless: Socrata serves moderate traffic without an app token, so no API key
 * is required. Content is in Spanish (column names, values, descriptions).
 *
 * Workflow:
 *   1. search_datasets(q)        -> find datasets + their Socrata 4x4 ids (e.g. "gt2j-8ykr")
 *   2. dataset_columns(datasetId)-> learn field names/types to $select/$where on
 *   3. query_dataset(datasetId)  -> pull rows with SoQL ($select/$where/$order/$group/$q)
 *
 * Collective investment funds (FIC): co_fic_search / co_fic_unit_value look a fund up by
 * name (accent/case/word-order forgiving) and return its unit values and returns.
 * Proxied per request; daily regulator data, so the gateway's default cache is fine.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Datos CO');
}


const CATALOG = 'https://api.us.socrata.com/api/catalog/v1';
const PORTAL = 'https://www.datos.gov.co';
const UA = 'pipeworx-mcp-datos-co/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_datasets',
    description:
      'Search datasets published on Colombia\'s open-data portal datos.gov.co. Returns each dataset\'s ' +
      'Socrata 4x4 id (e.g. "gt2j-8ykr"), name, and description (Spanish). Use the id with dataset_columns ' +
      'and query_dataset. Query terms can be Spanish or English (e.g. "covid", "presupuesto", "contratos").',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Full-text search query (Spanish or English).' },
        limit: { type: 'number', description: 'Max datasets to return (default 20).' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
      required: ['q'],
    },
  },
  {
    name: 'dataset_columns',
    description:
      'List the columns of a datos.gov.co dataset: field name (used in SoQL $select/$where), human label, ' +
      'and data type. Call this before query_dataset so you know which fields exist. datasetId is the ' +
      'Socrata 4x4 code from search_datasets.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Socrata 4x4 id, e.g. "gt2j-8ykr".' },
      },
      required: ['datasetId'],
    },
  },
  {
    name: 'query_dataset',
    description:
      'Query rows from a datos.gov.co dataset using SoQL. datasetId is the Socrata 4x4 code from ' +
      'search_datasets. SoQL clauses: $select (columns / aggregates like "count(*)"), $where (SQL-like ' +
      'filter, e.g. "departamento_nom=\'BOGOTA\' AND edad > 60"), $order ("count desc"), $group, ' +
      '$q (full-text across the row). Use dataset_columns first to learn field names. Returns an array of ' +
      'row objects keyed by field name. Default $limit is 50 (Socrata max per page is 50000).',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Socrata 4x4 id, e.g. "gt2j-8ykr".' },
        $select: { type: 'string', description: 'Columns or aggregates, e.g. "departamento_nom, count(*)".' },
        $where: { type: 'string', description: 'SQL-like filter, e.g. "edad > 60 AND sexo=\'F\'".' },
        $order: { type: 'string', description: 'Sort, e.g. "fecha_reporte_web desc".' },
        $group: { type: 'string', description: 'Group-by field(s) for aggregation.' },
        $q: { type: 'string', description: 'Full-text search across the whole row.' },
        $limit: { type: 'number', description: 'Rows to return (default 50).' },
        $offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
      required: ['datasetId'],
    },
  },
  {
    name: 'co_fic_search',
    description:
      'Find a Colombian collective investment fund (fondo de inversión colectiva, FIC) by name. Accepts the ' +
      'fund or the fiduciaria / management company in any case, with or without accents, in any word order ' +
      '(e.g. "Fiducoldex Capital Inteligente", "fondo abierto bancolombia"). Returns ranked candidates with ' +
      'entity, fund name and fund_code, or found:false with the closest fund names when nothing matches. ' +
      'Source: Superintendencia Financiera de Colombia.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Fund name, or fund manager name, e.g. "Fiducoldex Capital Inteligente".' },
        limit: { type: 'number', description: 'Max candidates to return (default 10, max 25).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'co_fic_unit_value',
    description:
      'Unit value (valor de la unidad) and returns (rentabilidad diaria/mensual/semestral/anual) for a Colombian ' +
      'collective investment fund (FIC), per participation class, with fund size and number of investors. Give ' +
      'the fund by name (forgiving match) or by fund_code from co_fic_search. Default is the latest published day; ' +
      'pass date (YYYY-MM-DD) for one day or from/to for a history. An unknown fund returns found:false with ' +
      'close fund names; an ambiguous name returns the candidates to choose from. Source: Superintendencia ' +
      'Financiera de Colombia, FIC daily series.',
    inputSchema: {
      type: 'object',
      properties: {
        fund: { type: 'string', description: 'Fund name, e.g. "Fiducoldex Capital Inteligente". Optional if fund_code is given.' },
        fund_code: { type: 'number', description: 'Fund code from co_fic_search (exact; skips name matching).' },
        date: { type: 'string', description: 'One day, YYYY-MM-DD (the regulator publishes with a few days lag).' },
        from: { type: 'string', description: 'History start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'History end, YYYY-MM-DD (default latest).' },
        participation_class: { type: 'number', description: 'Only this participation class (tipo de participación), e.g. 450.' },
        limit: { type: 'number', description: 'Max rows when a range is requested (default 60, max 400).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_datasets': {
      const q = reqStr(args, 'q', '"covid"');
      const params = new URLSearchParams({ domains: 'datos.gov.co', q });
      params.set('limit', String(numOr(args.limit, 20)));
      params.set('offset', String(numOr(args.offset, 0)));
      return getJson(`${CATALOG}?${params.toString()}`);
    }
    case 'dataset_columns': {
      const id = reqStr(args, 'datasetId', '"gt2j-8ykr"');
      return getJson(`${PORTAL}/api/views/${encodeURIComponent(id)}.json`);
    }
    case 'query_dataset': {
      const id = reqStr(args, 'datasetId', '"gt2j-8ykr"');
      const params = new URLSearchParams();
      for (const clause of ['$select', '$where', '$order', '$group', '$q']) {
        const v = args[clause];
        if (typeof v === 'string' && v.trim()) params.set(clause, v);
      }
      params.set('$limit', String(numOr(args.$limit, 50)));
      params.set('$offset', String(numOr(args.$offset, 0)));
      return getJson(`${PORTAL}/resource/${encodeURIComponent(id)}.json?${params.toString()}`);
    }
    case 'co_fic_search':
      return ficSearch(args);
    case 'co_fic_unit_value':
      return ficUnitValue(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await pwFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`datos.gov.co: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Collective investment funds (FIC)
// ---------------------------------------------------------------------------

const FIC_VIEW = 'qhpu-8ixx';
const FIC_SOURCE =
  'Superintendencia Financiera de Colombia, daily collective investment fund (FIC) series, via the Colombian national open-data portal';
// A fund counts as active if it reported within this many days of the latest published day.
const FIC_ACTIVE_DAYS = 30;
const FIC_LIST_TTL_MS = 6 * 3600 * 1000;

interface FicFund { entity: string; fund: string; fund_code: number; last_reported: string }
let ficListCache: { at: number; asOf: string; funds: FicFund[] } | null = null;

const STOP = new Set([
  'FONDO', 'FONDOS', 'DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'E', 'INVERSION', 'INVERSIONES', 'COLECTIVA',
  'COLECTIVAS', 'FIC', 'FI', 'SA', 'S', 'A', 'SOCIEDAD', 'FIDUCIARIA', 'FIDUCIARIO', 'ABIERTO', 'ABIERTA', 'FUND', 'THE', 'OF',
]);

function normalise(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
function tokens(s: string, keepStop = false): string[] {
  const all = normalise(s).split(' ').filter(Boolean);
  const kept = all.filter((t) => !STOP.has(t));
  return keepStop || kept.length === 0 ? all : kept;
}
function editLe1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length) { i++; j++; } else if (a.length > b.length) i++; else j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function tokenHit(q: string, c: string): number {
  if (q === c) return 1;
  if (q.length >= 4 && (c.startsWith(q) || q.startsWith(c) && c.length >= 4)) return 0.9;
  if (q.length >= 5 && c.length >= 5 && editLe1(q, c)) return 0.85;
  return 0;
}
/** coverage = share of the query's tokens found in the candidate; brevity breaks ties. */
function scoreFund(qTokens: string[], f: FicFund): { coverage: number; score: number } {
  const cTokens = tokens(`${f.entity} ${f.fund}`);
  let found = 0;
  let quality = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const c of cTokens) best = Math.max(best, tokenHit(q, c));
    if (best > 0) found++;
    quality += best;
  }
  const n = qTokens.length || 1;
  const coverage = found / n; // 1 = every word of the query found (exactly, as a prefix, or one typo away)
  const brevity = qTokens.length / Math.max(qTokens.length, new Set(cTokens).size);
  return { coverage, score: coverage + 0.2 * (quality / n) + 0.1 * brevity };
}

async function loadFunds(): Promise<{ asOf: string; funds: FicFund[] }> {
  if (ficListCache && Date.now() - ficListCache.at < FIC_LIST_TTL_MS) return ficListCache;
  const base = `${PORTAL}/resource/${FIC_VIEW}.json`;
  const mx = (await getJson(`${base}?${new URLSearchParams({ $select: 'max(fecha_corte) as m' })}`)) as Array<{ m?: string }>;
  const asOf = mx[0]?.m?.slice(0, 10);
  if (!asOf) throw new Error('Colombian FIC series: could not read the latest published date (upstream returned no rows).');
  const since = new Date(Date.parse(asOf) - FIC_ACTIVE_DAYS * 86400000).toISOString().slice(0, 10);
  const rows = (await getJson(
    `${base}?${new URLSearchParams({
      $select: 'nombre_entidad,nombre_patrimonio,codigo_negocio,max(fecha_corte) as last',
      $where: `fecha_corte >= '${since}T00:00:00'`,
      $group: 'nombre_entidad,nombre_patrimonio,codigo_negocio',
      $limit: '5000',
    })}`,
  )) as Array<Record<string, string>>;
  const funds = rows.map((r) => ({
    entity: r.nombre_entidad,
    fund: r.nombre_patrimonio,
    fund_code: Number(r.codigo_negocio),
    last_reported: (r.last ?? '').slice(0, 10),
  }));
  if (!funds.length) throw new Error('Colombian FIC series: fund list came back empty (upstream returned no rows).');
  ficListCache = { at: Date.now(), asOf, funds };
  return ficListCache;
}

function rank(qTokens: string[], funds: FicFund[]) {
  return funds
    .map((f) => ({ f, ...scoreFund(qTokens, f) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.fund.localeCompare(b.f.fund));
}

async function ficSearch(args: Record<string, unknown>) {
  const name = reqStr(args, 'name', '"Fiducoldex Capital Inteligente"');
  const limit = Math.min(Math.max(numOr(args.limit, 10), 1), 25);
  const qTokens = tokens(name);
  if (!qTokens.length) throw new Error('Argument "name" has no usable letters or digits. Pass a fund name like "Fiducoldex Capital Inteligente".');
  const { asOf, funds } = await loadFunds();
  const ranked = rank(qTokens, funds);
  const matches = ranked.filter((x) => x.coverage >= 0.99).slice(0, limit);
  if (matches.length) {
    return {
      found: true,
      query: name,
      count: matches.length,
      funds: matches.map((x) => ({ ...x.f, match_score: Number(x.score.toFixed(2)) })),
      data_as_of: asOf,
      source: FIC_SOURCE,
    };
  }
  return {
    found: false,
    reason: 'no_fund_matches_all_words',
    query: name,
    searched_words: qTokens,
    note: `No active Colombian collective investment fund matches all of those words (${funds.length} funds reported in the last ${FIC_ACTIVE_DAYS} days). Closest names are listed; this is a miss on the name, not a malformed request.`,
    closest: ranked.slice(0, Math.min(limit, 8)).map((x) => ({ ...x.f, match_score: Number(x.score.toFixed(2)) })),
    data_as_of: asOf,
    source: FIC_SOURCE,
  };
}

function isoDate(v: unknown, key: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`Argument "${key}" must be a date like "2026-10-22" (YYYY-MM-DD); got ${JSON.stringify(v)}.`);
  }
  return v;
}
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

async function ficUnitValue(args: Record<string, unknown>) {
  const nameArg = typeof args.fund === 'string' && args.fund.trim() ? args.fund : undefined;
  const codeArg = num(args.fund_code);
  if (!nameArg && codeArg === null) {
    throw new Error('Pass "fund" (a fund name like "Fiducoldex Capital Inteligente") or "fund_code" (from co_fic_search).');
  }
  const date = isoDate(args.date, 'date');
  const from = isoDate(args.from, 'from');
  const to = isoDate(args.to, 'to');
  const cls = num(args.participation_class);
  const { asOf, funds } = await loadFunds();

  let fund: FicFund | undefined;
  if (codeArg !== null) {
    fund = funds.find((f) => f.fund_code === codeArg);
    if (!fund) {
      return { found: false, reason: 'unknown_fund_code', fund_code: codeArg, note: `No active fund has code ${codeArg}. Use co_fic_search to find it by name.`, data_as_of: asOf, source: FIC_SOURCE };
    }
  } else {
    const qTokens = tokens(nameArg!);
    if (!qTokens.length) throw new Error('Argument "fund" has no usable letters or digits.');
    const ranked = rank(qTokens, funds);
    const full = ranked.filter((x) => x.coverage >= 0.99);
    if (!full.length) {
      return {
        found: false,
        reason: 'no_fund_matches_all_words',
        query: nameArg,
        searched_words: qTokens,
        note: `No active Colombian collective investment fund matches all of those words (${funds.length} funds reported in the last ${FIC_ACTIVE_DAYS} days). Closest names listed; this is a miss on the name, not a malformed request.`,
        closest: ranked.slice(0, 8).map((x) => ({ ...x.f, match_score: Number(x.score.toFixed(2)) })),
        data_as_of: asOf,
        source: FIC_SOURCE,
      };
    }
    const exact = full.filter((x) => normalise(x.f.fund) === normalise(nameArg!));
    // A clear winner: one full match, or the best beats the runner-up by a real margin.
    const pick = exact.length === 1 ? exact[0] : full.length === 1 || full[0].score - full[1].score >= 0.08 ? full[0] : undefined;
    if (!pick) {
      return {
        found: false,
        reason: 'ambiguous_fund_name',
        query: nameArg,
        note: 'More than one fund matches. Call again with fund_code (or a fuller name) for the one you want.',
        candidates: full.slice(0, 10).map((x) => ({ ...x.f, match_score: Number(x.score.toFixed(2)) })),
        data_as_of: asOf,
        source: FIC_SOURCE,
      };
    }
    fund = pick.f;
  }

  const range = Boolean(from || (to && !date));
  const clauses = [`codigo_negocio = ${fund.fund_code}`];
  if (date) clauses.push(`fecha_corte = '${date}T00:00:00'`);
  else {
    if (from) clauses.push(`fecha_corte >= '${from}T00:00:00'`);
    if (to) clauses.push(`fecha_corte <= '${to}T23:59:59'`);
    // Latest-day default: bound the scan so the large table never times out.
    if (!from && !to) clauses.push(`fecha_corte >= '${new Date(Date.parse(fund.last_reported) - 7 * 86400000).toISOString().slice(0, 10)}T00:00:00'`);
  }
  if (cls !== null) clauses.push(`tipo_participacion = ${cls}`);
  const limit = Math.min(Math.max(numOr(args.limit, 60), 1), 400);
  const raw = (await getJson(
    `${PORTAL}/resource/${FIC_VIEW}.json?${new URLSearchParams({
      $where: clauses.join(' AND '),
      $order: 'fecha_corte DESC, tipo_participacion',
      $limit: String(range ? Math.min(limit * 2, 800) : 200),
    })}`,
  )) as Array<Record<string, string>>;

  // Upstream repeats identical rows; keep one per day / class / compartment.
  const seen = new Set<string>();
  let rows = raw.filter((r) => {
    const k = `${r.fecha_corte}|${r.tipo_participacion}|${r.principal_compartimento}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!range && !date && rows.length) {
    const latest = rows[0].fecha_corte;
    rows = rows.filter((r) => r.fecha_corte === latest);
  }
  if (range) rows = rows.slice(0, limit);

  if (!rows.length) {
    return {
      found: false,
      reason: 'fund_matched_but_no_rows_for_request',
      fund: fund.fund,
      entity: fund.entity,
      fund_code: fund.fund_code,
      note: 'The fund exists but has no published rows for that date, range or participation class. The regulator publishes with a lag of a few days.',
      fund_last_reported: fund.last_reported,
      data_as_of: asOf,
      source: FIC_SOURCE,
    };
  }
  return {
    found: true,
    entity: fund.entity,
    fund: fund.fund,
    fund_code: fund.fund_code,
    fund_last_reported: fund.last_reported,
    row_count: rows.length,
    rows: rows.map((r) => ({
      date: r.fecha_corte.slice(0, 10),
      participation_class: num(r.tipo_participacion),
      unit_value: num(r.valor_unidad_operaciones),
      fund_value_cop: num(r.valor_fondo_cierre_dia_t),
      investors: num(r.numero_inversionistas),
      return_daily_pct: num(r.rentabilidad_diaria),
      return_monthly_pct: num(r.rentabilidad_mensual),
      return_semester_pct: num(r.rentabilidad_semestral),
      return_annual_pct: num(r.rentabilidad_anual),
    })),
    notes: 'unit_value is the price of one fund unit in COP. The four return_*_pct fields are published by the regulator as percentages but the publisher does not document their basis; the basis stated here is OUR reading, checked arithmetically against the same unit_value series, not the regulator\'s statement. Each is an effective annual rate (compounded to 365 days) computed from the unit_value change over a trailing window: daily = 1 day, monthly = 30 days, semester = 183 days, annual = 365 days. So return_daily_pct is an annualised rate, NOT the day\'s price change (the one-day change is unit_value[t]/unit_value[t-1]-1), and a semester figure above the annual one is normal. Unit values are per participation class; fee treatment follows the publisher\'s unit value.',
    data_as_of: asOf,
    source: FIC_SOURCE,
  };
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
