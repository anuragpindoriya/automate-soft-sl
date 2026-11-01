# SoftSL — hourly-close stop loss

Soft stop loss for USDT-M perpetuals on **BloFin, Bitunix, BingX and WEEX**.

No stop order sits on the exchange, so wicks can't hunt it. At every **1-hour candle close** the bot checks each open position. If that closed candle finished beyond your SL, it market-closes the whole position.

- **Long:** closes when the 1h close is **below** the SL.
- **Short:** closes when the 1h close is **above** the SL.
- **Optional emergency (`hard`) level:** checked every 30 s against the latest price, for crash protection between closes. It always sits beyond the soft SL.

> **Timing.** Exchange hourly candles align to **UTC**. In IST they close at **:30** (for example 14:30, 15:30). The bot checks 5 s after each close (`CLOSE_DELAY_SEC`).

---

## Setup

Requires Node ≥ 20.12.

```bash
npm install
npm run build
cp accounts.example.json accounts.json   # add API keys
cp sl.example.json sl.json               # or use `npm run sl -- set ...`
cp .env.example .env                     # DRY_RUN=true by default
```

**API keys.** Give each key futures read + trade permission only, and **never withdrawal**. Bind each key to your server's IP. BloFin and WEEX also need the `passphrase` you set when creating the key.

**`accounts.json`** holds any number of accounts, on any mix of exchanges:

```json
[
  { "name": "bingx-main",  "exchange": "bingx",  "apiKey": "...", "apiSecret": "..." },
  { "name": "blofin-main", "exchange": "blofin", "apiKey": "...", "apiSecret": "...", "passphrase": "..." }
]
```

## Setting stops

Symbols are exchange-agnostic: `BTCUSDT`, `BTC-USDT` and `cmt_btcusdt` all mean the same thing. Sides are `long` or `short`, so hedge-mode long and short positions each get their own stop.

```bash
npm run sl -- set bingx-main BTCUSDT long 64000                  # soft SL at 64000
npm run sl -- set bingx-main BTCUSDT long 64000 --hard 62500     # + emergency price
npm run sl -- set blofin-main ETHUSDT short --pct 2 --hard-pct 1 # 2% above entry, emergency 1% beyond that
npm run sl -- rm  bingx-main BTCUSDT long
npm run sl -- list
npm run sl -- status    # live positions, their SL, last 1h close, ok/BREACHED/UNPROTECTED
npm run sl -- probe     # checks the public candle feed on all 4 exchanges (no keys)
```

You can also edit `sl.json` by hand. The bot re-reads it every check, so no restart is needed.

```json
{
  "defaults": { "slPct": null, "hardPct": null },
  "stops": [
    {"account":"bingx-main","symbol":"BTCUSDT","side":"long","sl":64000,"hard":62500}
  ]
}
```

| Field | Meaning |
|---|---|
| `sl` / `slPct` | Soft SL as a price, or as a % from entry. Checked on the 1h close. |
| `hard` | Optional emergency price, checked intra-hour. Must be beyond the soft SL (below it for a long, above it for a short). |
| `hardPct` | Optional emergency level as a **% beyond the soft SL**. For example, SL 64000 and `hardPct` 2 gives an emergency level of 62720 for a long. |
| `defaults.slPct` / `defaults.hardPct` | Applied to any position without its own rule. A rule without its own emergency level also uses `defaults.hardPct`. Leave `null` to only warn about unprotected positions. |
| `positionId` | Filled in by the bot. Ties the rule to one position (see below). |

### Rules follow one trade

A rule belongs to **one position**:

- **Set while the position is open:** `set` ties the rule to that position straight away. If the bot can't reach the exchange, it ties the rule at its next look, within 30 s.
- **Set before you open the trade:** the rule waits, and ties itself to the next matching position the bot sees. The bot looks every 30 s, so a trade opened and closed within half a minute can be missed; the rule then goes to the trade after it.
- **Once the position is gone:** the rule is removed. That covers the bot closing it, a take-profit, a manual close or a liquidation. An old stop therefore never lands on a new trade, which would otherwise be dangerous if you re-enter below an old long SL. If the bot didn't close the position itself, it waits until the position has been missing for 15 minutes, so a few glitchy API replies can't wipe your rules.
- **A new position with no rule:** reported as **unprotected**, until you set one or a default applies.
- **Standing rules:** set `KEEP_RULES_AFTER_CLOSE=true` if you want rules that are never tied or removed.

### Bad entries in `sl.json`

A bad entry never switches protection off quietly:

- An invalid rule, a duplicate, or a misspelled `"stops"` key is reported in an alert. Every other rule keeps working.
- If the whole file can't be read (a typo, or an editor mid-save), the bot keeps using the last good copy and alerts you. Rule ties and removals it couldn't write are kept in memory and written once the file is fixed.
- `list` and `status` show any problems too.

## Running

```bash
npm start            # daemon
npm run once         # evaluate the last closed hour right now, then exit (honours DRY_RUN)
```

- **One process per `sl.json`.** A second `npm start` or `npm run once` refuses to start, and the daemon sends an alert saying so. The lock is the file `sl.json.lock`. A lock left behind by a crash, a kill or a reboot is taken over automatically.
- **Restarts don't lose state.** Unfinished closes, and positions the bot has stopped touching (see *If a close makes things worse*), are kept in `sl.json.state`.
- **Starting just after a close.** If the daemon starts within 15 min after an hourly close, it checks that close straight away.
- **Late checks.** If the machine was asleep and the hourly check ran late, you get an alert naming the close that was skipped.

### Going live

1. **Probe the feeds.** Run `npm run sl -- probe`. All 4 exchanges should show `lastClosed` with a time, `final: yes` and `check: ok`.
2. **Check positions in dry run.** With `DRY_RUN=true`, run `npm run sl -- status`. Confirm the positions, sizes, entries and SL levels look right.
3. **Run the daemon in dry run.** Leave it running for a few hours. Check that the hourly lines in the log match your charts.
4. **Test both close methods on each exchange**, using a tiny position:
   - `DRY_RUN=false npm run sl -- close <account> <symbol> <side> --yes` closes it with the exchange's close-position endpoint.
   - Open another tiny position, then run the same command with `--order` added. This uses the fallback market order, which the bot only needs if the endpoint fails. If the command says the position **grew**, don't go live on that exchange.
5. **Test the bot end to end.** Stop the dry-run daemon. Set an SL that a tiny position has already breached, then run `DRY_RUN=false npm run once`.
6. **Go live.** Set `DRY_RUN=false` in `.env` and start the daemon.

`DRY_RUN` turns off **only** for an explicit `false`, `0`, `no` or `off`. An empty value or a typo keeps dry run on.

### On a VPS (pm2)

```bash
npm i -g pm2
pm2 start dist/src/index.js --name softsl --kill-timeout 35000
pm2 save && pm2 startup
pm2 logs softsl
```

On stop, the bot finishes any close already in progress before exiting. That can take up to 30 s, hence `--kill-timeout`.

> **Keep the server clock in sync** (`timedatectl` should show NTP active). Signatures are rejected when the clock is more than a few seconds off; the bot's BingX requests allow 5 s.

## Telegram alerts (optional)

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. You'll get alerts for:

- **Bot status:**
  - start and stop;
  - a refused start (another instance running, bad config);
  - an hourly check that ran late.
- **Closes:**
  - every close, or would-close in dry run;
  - failed closes, repeated at most every 15 min while the bot keeps retrying;
  - "is closed now" when a retry succeeds.
- **Close made it worse (🚨🚨):**
  - a position that grew or flipped side after a close attempt;
  - a new position that appeared right after a fallback order.
- **Positions and rules:**
  - unprotected positions;
  - rules removed because their position is gone.
- **Problems:**
  - problems in `sl.json`;
  - hours where the candle or positions couldn't be fetched, even after retrying for 15 min;
  - emergency checks failing 3 times in a row, and their recovery.

## How a check works

1. **Fetch positions.** Each account runs separately, so a slow or failing exchange never holds up the others. An empty positions list right after positions were open is double-checked before the bot believes it.
2. **Tie rules and resolve stops.**
   - Tie rules to positions and drop rules whose position is gone.
   - Resolve each position's stop: its rule, else the default %.
3. **Judge each position only on closes after it opened.** The bot uses the exchange's open time (BloFin, Bitunix, WEEX), or when it first saw the position (BingX reports no open time). A trade you open at 10:00:40 is never judged on the candle that closed at 10:00.
4. **Fetch the candle.** Fetch the 1h candle that opened at `hour − 1h`. It is used only once it's certainly **final**:
   - BloFin: the exchange's own `confirm` flag.
   - Bitunix: only closed candles are returned (documented). `probe` flags it if that's ever not true.
   - BingX and WEEX: there is no flag, so the response must already contain the *next* candle. That proves the hour is over on the exchange's own clock, even if your server clock runs ahead. Without that next candle, the bot waits until 60 s after the hour.
5. **Close a breach.** If the close is beyond the SL, the bot closes **that position by its id** using the exchange's close-position endpoint.
   - If the endpoint fails, it first re-checks the position. It may already be closed: a timeout doesn't mean the close failed.
   - It then sends a fallback market order only if the position is still there.
   - It never sends a fallback order when several positions share the symbol and side, because an order can't target just one of them.
6. **Verify the close.** Re-fetch positions and match by position id. A position counts as closed only when **two** reads a moment apart agree. The bot retries up to 3 times, closing what's left after a partial fill.
7. **If the close still fails:** alert, then retry every 30 s. The bot stops retrying when the close works, or:
   - the position disappears;
   - you remove or move its stop;
   - the next hourly close is due (that check decides afresh).
8. **If a candle or the positions couldn't be fetched:** check that account again at +1, +5 and +15 min before alerting that the hour wasn't evaluated. Retries only look at positions that weren't checked yet, and never at ones opened after the close.

The hourly check, the retries and the emergency loop are serialised per account, so they never act on the same position at once.

### If a close makes things worse

If an exchange ever handles a close wrongly, the bot stops sending orders for that position at once and sends a 🚨🚨 alert. It never retries it. This covers:

- the position getting bigger;
- the position turning into the other side;
- a new position appearing right after a fallback order.

Close the position by hand; once it's gone, the bot forgets it. To let the bot manage it again without closing it, stop the bot, delete `sl.json.state` and start the bot. That file also holds unfinished closes, so only delete it once you've checked your positions.

## Exchange notes

| | Close method | Fallback order | Size unit | Open time |
|---|---|---|---|---|
| BloFin | `POST /api/v1/trade/close-position` (+ `positionId`) | market order (`reduceOnly` in one-way, `positionSide` in hedge) | contracts | `createTime` |
| Bitunix | `POST /api/v1/futures/trade/flash_close_position` | `place_order` MARKET + `tradeSide: CLOSE` + `positionId` | coin | `ctime` |
| BingX | `POST /openApi/swap/v1/trade/closePosition` | MARKET order (`BOTH` + `reduceOnly` in one-way, `LONG`/`SHORT` in hedge) | coin | none (first seen) |
| WEEX (API V3) | `POST /capi/v3/closePositions` with `positionId` | reduce-only MARKET order | coin | `createdTime` |

- **WEEX:**
  - `closePositions` with an empty body closes every position in the account, so the adapter never calls it without a numeric `positionId`.
  - V3 has no average-price field, so entry (used by `slPct`) is calculated as `openValue / size`.
- **Bitunix:**
  - Its fallback order names the position being closed in `side` (close long → `BUY`), as its docs say. The order also carries `positionId`, so it can only close that position.
  - Its kline endpoint returns closed candles only, so the emergency check there uses the last closed 1-minute candle. That can be up to about a minute stale.
- **Unknown position data:** if an exchange reports a position side the bot doesn't recognise, it raises an error and alerts rather than guessing long or short.
- **Position ids:** these can exceed JavaScript's safe integer range. Responses are parsed so that ids stay exact.
- **Fallback order paths:** the close-by-id endpoints are the primary path, and their parameters are verified against the docs. The fallback order shapes are partly inferred, because the docs are thin. That's why step 4 of *Going live* tests them, and why the bot stops at once if a close ever makes a position bigger.

## Tests

```bash
npm test
```

The suite has 78 tests:

- **Engine** against a mock exchange:
  - wick vs close, the forming candle being ignored, candle finality and clock skew;
  - positions only judged on closes after they opened, and retries that skip what's already checked;
  - hedge sides and multi-position closes by id;
  - fallback safety, and stopping for good when a close grows or flips a position;
  - confirming closes and empty replies with a second read;
  - pending-close retries, and state that survives a restart;
  - rule tying, stale-rule removal, and a broken `sl.json`;
  - emergency levels, account isolation and alert rate limits.
- **Adapters** against a mocked `fetch`, including strict side mapping.
- **Config and lock:** `sl.json` validation, safe edits, and stale-lock takeover after crashes and reboots.
- **Signing vectors:**
  - BloFin: BloFin's own test vector.
  - Bitunix: the docs' sample.
  - WEEX and BingX: Python reference values.
