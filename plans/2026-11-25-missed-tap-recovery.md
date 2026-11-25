# Missed-tap recovery and send retries

## Problem

On 2026-11-25 a commenter on a team account's post got the Opening DM twice (two automations)
and tapped "Send it!" 12 times. Nothing happened: both runs are still `opening_sent`.

Instagram recorded every tap: each shows in the conversation as a message from them with the button's text. But
Instagram never sent a `messaging_postbacks` webhook for any of them. Adeli's records prove it never received one:

| Hop | Record | 12:20 to 12:30 ET |
| --- | --- | --- |
| Instagram → Adeli | Adeli PostHog `webhook_received` (every request, any outcome) | 30 requests, all `processed`, 0 rejected all day |
| Adeli parses | Adeli log `Instagram webhook received` (postback count per request) | 6 postbacks for that account, 1 per request |
| Adeli → LedaChat | `webhook_deliveries` | 6 delivered, all from two other people. 0 from the affected person all day |

The taps reached Adeli's database only at 3:06 PM, when someone opened the Adeli inbox and it synced the thread from
the Graph API.

It is not rare, and it is per person:

- On the account with the most data, 116 people tapped a button (per the threads). 101 had every tap delivered, **14 (about 1 in 8)
  had none**, 1 lost some. Those 14 never got their link.
- Typed messages are dropped too: 193 of 2,228 inbound texts (about 9%) only reached Adeli through inbox sync.
- Follow status and follower count don't explain who is affected.
- Meta documents no delivery guarantee. It retries only deliveries that fail at the receiver; an event it never
  sends is never retried, and there is no replay API. ManyChat's forum shows the same symptom ("tap does nothing",
  "works with some accounts only") with no recovery.

Separately, a send that fails with a temporary error marks the run `failed` for good. In the last 30 days that was
3 Opening DMs (`provider_error`, one workspace, 2026-11-25) out of 420 triggered runs.

PR #48 (wait 30s before the follow check) was based on a wrong diagnosis. Close it.

## Goal

1. A person who tapped gets their reply even when Instagram drops the tap's webhook, within about a minute in the
   common case.
2. A send that fails with a temporary error is retried before the run is marked `failed`.
3. The database can still scale to zero: no cron, nothing that wakes it when no runs are waiting.

## Design

### How a missed tap is found

A dropped tap looks the same as someone who hasn't tapped yet, so it can only be found by reading the thread. After
each button DM (Opening DM, follow gate), a durable workflow checks that one conversation at **+1, +5 and +30
minutes**, and stops as soon as the run moves on.

```
Button DM sent → start missedTapCheck(run, step)
  sleep 1m → check → sleep 4m → check → sleep 25m → check → end
check: load run; if it has moved on, end.
       read the newest messages of that conversation (Adeli, 1 Graph call)
       a message from them, newer than our button DM, whose text equals this step's button label?
         yes → handle it exactly like a tap (same claim, follow check, gate or link)
         no  → next sleep
```

- **Cost.** Runs that finish normally (about 90%) cost nothing extra. A waiting run costs at most 3 reads per button
  DM (4 Graph calls counting the first conversation lookup). Cost grows with stuck runs, not with time or inbox size.
- **Idle database.** Workflow `sleep()` holds no compute and no connection. The database is touched only when a
  check fires, and the +1 and +5 minute checks land while it is usually still awake from the comment.
- **No double sends.** The existing claim (`update ... where state = 'opening_sent'` / `'awaiting_follow'`) lets only
  the first of the real webhook and a check through.
- **Matching.** Exact button label only (`openingDm.buttonLabel` for `opening`, `followGate.buttonLabel` for
  `follow`), case-sensitive after trimming, from the run's person, sent after `lastButtonDmAt`. Labels are whatever
  the automation had when the DM went out, so store the label on the run with the timestamp (below). Unrelated chat
  is never treated as a tap.
- **Who the person is.** Comment runs: `igUserId` (the comment's `from.id`, which equals the messaging IGSID on
  Instagram Login; verified for 3 people on 2026-11-25). Story reply runs: `igSenderId`.
- **Why Workflow, not a cron.** A per-minute cron would query the database every minute and keep Neon from suspending.
  Adeli already uses Vercel Workflow the same way (`apps/web/workflows/webhook-delivery.ts`,
  `scheduled-publication.ts`).

### Send retries

Built in process, not as workflow steps: each DM send (Opening DM, follow gate, email request, Final DM) goes through
`sendWithRetry` in `handle.ts`, which waits 2s and 6s between tries.

- **Retried:** `provider_error`, `rate_limited` and any 5xx from Adeli. These mean nothing went out.
- **Network failures and timeouts:** retried only for the Opening DM's private reply. A plain DM might have gone out,
  so retrying it could double-message someone. Instagram refuses a second private reply to the same comment, and
  `private_reply_already_sent` on a retry counts as sent.
- **Everything else** fails at once, as before. The `sendAfterTap` window retries (3s, 10s) and the `awaiting_message`
  hold stay as they are.

Not built: moving webhook handling into a workflow step so a crash mid-handling is retried. It hasn't happened in the
last 30 days, and doing it means every event depends on the Workflow runtime. Revisit if crashes show up.

## Changes

### Adeli (separate PR in `~/repos/adeli`, plan in its `plans/`)

New endpoint: read one Instagram conversation's newest messages, live.

```
GET /api/v1/messages/instagram/conversations/:igsid?accountId=<uuid>&limit=5
→ { platform, accountId, profileId, conversationId,
    messages: [{ id, direction, from, text, createdAt }] }   // newest first, limit 1 to 20
```

- Graph calls: `GET /me/conversations?platform=instagram&user_id=<igsid>` (cached per account and IGSID once found),
  then `GET /<conversation_id>/messages?fields=id,from,created_time,message&limit=<n>`. Adeli already makes the
  second call inside the inbox sync (`apps/web/lib/instagram.ts:948`, `:970`).
- Never cached (callers ask for freshness), needs `inbox.read`, same 409/404 mapping as `getInstagramUser`.
- Store what it reads into the inbox as the sync does, so the dashboard stays consistent.
- Add to `@adeli/sdk` (`messages.getInstagramConversation`), `docs/public-api.md` and the public docs.
- Meta limits: only the 20 newest messages are returned; Requests-folder threads inactive for 30 days are not. Neither
  matters at +30 minutes.

LedaChat records this in PRD §12A as a missing piece until it ships.

### LedaChat

1. **Workflow setup.** Add `workflow` and `withWorkflow` (`apps/web/next.config.ts`). Workflows are unit-tested by mocking
   `workflow`, as Adeli's unit tests do; no `@workflow/vitest` integration harness yet.
2. **Schema** (`apps/web/src/lib/db/schema.ts`, one migration): on `runs`, add `last_button_dm_at` (timestamptz) and
   `last_button_label` (text). Set them in `sendOpeningDm` and when the follow gate or its retry text goes out.
3. **Adeli wrapper.** `readConversation(adeliAccountId, igsid, limit)` in `apps/web/src/lib/adeli/conversations.ts`. It
   detects whether the installed SDK has `messages.getInstagramConversation` and reports `available: false` until it
   does, so this can merge before the SDK release; bump `@adeli/sdk` and drop the detection afterwards. The only
   caller of the new SDK method.
4. **Workflow** `apps/web/src/workflows/missed-tap-check.ts`: `missedTapCheckWorkflow({ runId, step, sentAt })` as above. The check step
   loads the run, returns early unless its state matches the step (`opening_sent` for `opening`, `awaiting_follow` for
   `follow`) and its `last_button_dm_at` is the one the workflow started for, reads the thread, and on a match calls
   the shared tap handler.
5. **Shared tap handler.** Split `handlePostback` into the webhook adapter and `handleTap(userId, { runId, senderId,
   adeliAccountId, source: "webhook" | "recovered" })`, so a recovered tap runs the exact same code. The `source` goes on the
   `dm_button_tapped` event.
6. **Start points.** `scheduleMissedTapCheck({ runId, step: "opening", sentAt })` after a successful Opening DM, and `"follow"` after
   the follow gate or retry text. A run's older workflow ends on its own once the state or `last_button_dm_at` no
   longer matches.
7. **Send retries.** `sendWithRetry` around the four sends, with the rules above.
8. **Without Workflow.** `scheduleMissedTapCheck` never throws: if `start()` fails the flow carries on as before, only
   without recovery. `MISSED_TAP_RECOVERY=off` turns it off (README env table, `.env.example`). Local dev uses the
   DevKit's local backend.
9. **Analytics** (`docs/analytics.md`): `missed_tap_recovered` (step, check number), `missed_tap_check_exhausted`
   (step), `send_retried` (step, error_code). Ids and outcomes only.
10. **Docs.** PRD FR-8.11 (missed taps), FR-8.12 (send retries) and §12A A7.

## Tests

Fake fetch and in-memory PGlite as today; the workflow with `workflow` mocked. The conversation read is mocked in the
runtime tests until the SDK has it.

- A tap whose webhook never arrives is recovered at the first check that sees the label, and the Final DM goes once.
- The real webhook arrives after a check already recovered the tap: nothing more is sent.
- No matching message: three checks, then the run stays `opening_sent`; `missed_tap_check_exhausted` tracked.
- Only an exact label from the person, newer than the button DM, counts. Older messages, other text, and our own
  messages don't.
- Follow gate: a recovered "I followed!" re-checks the follow and sends the retry text or the link; the retry text
  starts a new schedule and the old workflow ends.
- A run that moved on before a check makes no Adeli call.
- Story reply runs use `igSenderId`.
- Sends: `provider_error` is retried and then succeeds; a final error fails at once; `private_reply_already_sent` on a
  retry counts as sent.
- With Workflow unavailable, the runtime behaves as today.

## Rollout

1. Adeli endpoint and SDK release.
2. LedaChat behind `MISSED_TAP_RECOVERY` (default on in production once verified).
3. Recover today's stuck runs once: a one-off script runs the check for `opening_sent` and `awaiting_follow` runs from
   the last 24 hours (Instagram's reply window, counted from their tap), so the person above, still inside it,
   gets their link. Older ones are outside the window and can't be messaged.
4. Watch `missed_tap_recovered` against `dm_button_tapped` for a week. Expect roughly 10%.

## Open questions

- Schedule: +1/+5/+30 minutes is a guess at the balance between speed and reads. The share of recoveries at each
  check, after a week, says whether to move them.
- Also recover typed replies (any message, not only the label)? Useful once LedaChat accepts typed replies; out of
  scope here.
- Report the per-user webhook gaps to Meta with the affected message ids. It may not change anything, but it is on
  record.
