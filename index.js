const http = require("http");
const { Pool } = require("pg");

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const neynarApiKey = process.env.NEYNAR_API_KEY;
const backfillToken = process.env.BACKFILL_TOKEN;

if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL in Railway Variables.");
}

if (!neynarApiKey) {
  throw new Error("Missing NEYNAR_API_KEY in Railway Variables.");
}

if (!backfillToken) {
  throw new Error("Missing BACKFILL_TOKEN in Railway Variables.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const PAGE_SIZE = 100;

let backfillRunning = false;
let stopRequested = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function shortAddress(address) {
  const value = String(address ?? "");
  if (value.length < 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "Unknown";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Unknown";

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function parseInteger(value, fallback, min, max) {
  const number = Number(value);

  if (!Number.isInteger(number)) return fallback;

  return Math.min(Math.max(number, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(address) {
  const value = String(address || "").trim();
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function isValidBackfillRequest(url) {
  return url.searchParams.get("token") === backfillToken;
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(body, null, 2));
}

function walletTypeLabel(walletType) {
  const labels = {
    custody: "Custody wallet",
    verified_evm: "Verified EVM wallet",
    verified_solana: "Verified Solana wallet",
  };

  return labels[walletType] || "Farcaster-linked wallet";
}

function walletTypeClass(walletType) {
  const classes = {
    custody: "custody",
    verified_evm: "evm",
    verified_solana: "solana",
  };

  return classes[walletType] || "unknown";
}

function buildDirectoryUrl(search, pageNumber) {
  const params = new URLSearchParams();

  if (search) {
    params.set("search", search);
  }

  if (pageNumber > 1) {
    params.set("page", String(pageNumber));
  }

  const query = params.toString();

  return query ? `/?${query}` : "/";
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS farcaster_users (
      fid BIGINT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      pfp_url TEXT,
      follower_count INTEGER NOT NULL DEFAULT 0,
      following_count INTEGER NOT NULL DEFAULT 0,
      custody_address TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      fid BIGINT NOT NULL REFERENCES farcaster_users(fid) ON DELETE CASCADE,
      chain TEXT NOT NULL,
      wallet_type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'neynar',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS farcaster_users_username_idx
      ON farcaster_users (username);

    CREATE INDEX IF NOT EXISTS wallets_fid_idx
      ON wallets (fid);

    CREATE INDEX IF NOT EXISTS wallets_address_lower_idx
      ON wallets ((LOWER(address)));
  `);

  await pool.query(`
    INSERT INTO sync_state (key, value)
    VALUES
      ('backfill_next_fid', '1'),
      ('backfill_end_fid', '0'),
      ('backfill_status', 'idle'),
      ('backfill_users_imported', '0'),
      ('backfill_batches_completed', '0')
    ON CONFLICT (key) DO NOTHING
  `);
}

async function getState() {
  const result = await pool.query(`
    SELECT key, value, updated_at
    FROM sync_state
  `);

  const state = {};

  for (const row of result.rows) {
    state[row.key] = {
      value: row.value,
      updatedAt: row.updated_at,
    };
  }

  return state;
}

async function setState(key, value) {
  await pool.query(
    `
      INSERT INTO sync_state (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
    `,
    [key, String(value)]
  );
}

async function fetchUsersFromNeynar(fids) {
  const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk/");

  url.searchParams.set("fids", fids.join(","));

  const response = await fetch(url, {
    headers: {
      "x-api-key": neynarApiKey,
      accept: "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Neynar API error ${response.status}: ${text}`);
  }

  const body = JSON.parse(text);

  return Array.isArray(body.users) ? body.users : [];
}

async function saveUsers(users) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const user of users) {
      const fid = Number(user.fid);

      if (!Number.isInteger(fid) || fid <= 0) {
        continue;
      }

      await client.query(
        `
          INSERT INTO farcaster_users (
            fid,
            username,
            display_name,
            pfp_url,
            follower_count,
            following_count,
            custody_address,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (fid) DO UPDATE SET
            username = EXCLUDED.username,
            display_name = EXCLUDED.display_name,
            pfp_url = EXCLUDED.pfp_url,
            follower_count = EXCLUDED.follower_count,
            following_count = EXCLUDED.following_count,
            custody_address = EXCLUDED.custody_address,
            updated_at = NOW()
        `,
        [
          fid,
          user.username || null,
          user.display_name || null,
          user.pfp_url || null,
          Number(user.follower_count || 0),
          Number(user.following_count || 0),
          user.custody_address
            ? normalizeAddress(user.custody_address)
            : null,
        ]
      );

      const uniqueWallets = new Map();

      if (user.custody_address) {
        const address = normalizeAddress(user.custody_address);

        if (address) {
          uniqueWallets.set(address, {
            address,
            chain: "ethereum",
            walletType: "custody",
          });
        }
      }

      for (const addressValue of user.verified_addresses?.eth_addresses || []) {
        const address = normalizeAddress(addressValue);

        if (address) {
          uniqueWallets.set(address, {
            address,
            chain: "ethereum",
            walletType: "verified_evm",
          });
        }
      }

      for (const addressValue of user.verified_addresses?.sol_addresses || []) {
        const address = normalizeAddress(addressValue);

        if (address) {
          uniqueWallets.set(address, {
            address,
            chain: "solana",
            walletType: "verified_solana",
          });
        }
      }

      for (const wallet of uniqueWallets.values()) {
        await client.query(
          `
            INSERT INTO wallets (
              address,
              fid,
              chain,
              wallet_type,
              source,
              updated_at
            )
            VALUES ($1, $2, $3, $4, 'neynar', NOW())
            ON CONFLICT (address) DO UPDATE SET
              fid = EXCLUDED.fid,
              chain = EXCLUDED.chain,
              wallet_type = EXCLUDED.wallet_type,
              source = 'neynar',
              updated_at = NOW()
          `,
          [
            wallet.address,
            fid,
            wallet.chain,
            wallet.walletType,
          ]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function importFidBatch(startFid, batchSize) {
  const fids = Array.from(
    { length: batchSize },
    (_, index) => startFid + index
  );

  const users = await fetchUsersFromNeynar(fids);

  await saveUsers(users);

  return {
    fidsChecked: fids.length,
    usersImported: users.length,
    nextFid: startFid + batchSize,
  };
}

async function getNumberState(key, fallback) {
  const result = await pool.query(
    `SELECT value FROM sync_state WHERE key = $1`,
    [key]
  );

  if (result.rowCount === 0) return fallback;

  return parseInteger(result.rows[0].value, fallback, 0, 100000000);
}

async function runBackfill(endFid, batchSize, delayMs) {
  if (backfillRunning) return;

  backfillRunning = true;
  stopRequested = false;

  try {
    await setState("backfill_status", "running");
    await setState("backfill_end_fid", endFid);

    let nextFid = await getNumberState("backfill_next_fid", 1);
    let importedTotal = await getNumberState("backfill_users_imported", 0);
    let batchesTotal = await getNumberState("backfill_batches_completed", 0);

    while (nextFid <= endFid && !stopRequested) {
      const remaining = endFid - nextFid + 1;
      const currentBatchSize = Math.min(batchSize, remaining);

      try {
        const result = await importFidBatch(nextFid, currentBatchSize);

        nextFid = result.nextFid;
        importedTotal += result.usersImported;
        batchesTotal += 1;

        await setState("backfill_next_fid", nextFid);
        await setState("backfill_users_imported", importedTotal);
        await setState("backfill_batches_completed", batchesTotal);
        await setState("backfill_last_error", "");

        console.log(
          `[backfill] checked ${currentBatchSize} FIDs; ` +
          `next=${nextFid}; imported=${result.usersImported}; ` +
          `total=${importedTotal}`
        );

        await sleep(delayMs);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        console.error(`[backfill] error at FID ${nextFid}: ${message}`);

        await setState("backfill_last_error", message);
        await setState("backfill_status", "paused_after_error");

        await sleep(30000);
        break;
      }
    }

    if (stopRequested) {
      await setState("backfill_status", "stopped");
    } else if (nextFid > endFid) {
      await setState("backfill_status", "completed");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error("[backfill] fatal error:", message);

    await setState("backfill_last_error", message);
    await setState("backfill_status", "failed");
  } finally {
    backfillRunning = false;
  }
}

async function getUsers(search, pageNumber) {
  const offset = (pageNumber - 1) * PAGE_SIZE;
  const values = [];
  let where = "";

  if (search) {
    values.push(`%${search}%`);
    values.push(search);

    where = `
      WHERE
        u.username ILIKE $1
        OR u.display_name ILIKE $1
        OR CAST(u.fid AS TEXT) = $2
        OR EXISTS (
          SELECT 1
          FROM wallets search_wallet
          WHERE search_wallet.fid = u.fid
            AND search_wallet.address ILIKE $1
        )
    `;
  }

  values.push(PAGE_SIZE + 1);
  values.push(offset);

  const result = await pool.query(
    `
      SELECT
        u.fid,
        u.username,
        u.display_name,
        u.pfp_url,
        u.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'address', w.address,
              'chain', w.chain,
              'wallet_type', w.wallet_type,
              'source', w.source,
              'updated_at', w.updated_at
            )
            ORDER BY w.wallet_type, w.address
          ) FILTER (WHERE w.address IS NOT NULL),
          '[]'::json
        ) AS wallets
      FROM farcaster_users u
      LEFT JOIN wallets w ON w.fid = u.fid
      ${where}
      GROUP BY u.fid
      ORDER BY u.fid ASC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `,
    values
  );

  const hasNextPage = result.rows.length > PAGE_SIZE;
  const users = hasNextPage ? result.rows.slice(0, PAGE_SIZE) : result.rows;

  return {
    users,
    hasNextPage,
  };
}

async function getDirectoryTotals() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM farcaster_users)::int AS user_count,
      (SELECT COUNT(*) FROM wallets)::int AS wallet_count
  `);

  return result.rows[0];
}

function page(users, totals, search, pageNumber, hasNextPage) {
  const startIndex = (pageNumber - 1) * PAGE_SIZE;

  const rows = users
    .map((user, index) => {
      const profileName = user.display_name || user.username || "Unknown";
      const username = user.username || "";
      const profileUrl = username
        ? `https://warpcast.com/${encodeURIComponent(username)}`
        : "";

      const avatar = user.pfp_url
        ? `<img src="${escapeAttribute(user.pfp_url)}" alt="">`
        : `<span>${escapeHtml(profileName.slice(0, 1).toUpperCase())}</span>`;

      const profile = profileUrl
        ? `
          <a
            class="profile-link"
            href="${profileUrl}"
            target="_blank"
            rel="noreferrer"
            onclick="event.stopPropagation()"
          >
            <span class="avatar">${avatar}</span>
            <span class="profile-text">
              <strong>${escapeHtml(profileName)}</strong>
              <span class="handle">@${escapeHtml(username)}</span>
            </span>
          </a>
        `
        : `
          <span class="profile-link">
            <span class="avatar">${avatar}</span>
            <span class="profile-text">
              <strong>${escapeHtml(profileName)}</strong>
              <span class="handle">@unknown</span>
            </span>
          </span>
        `;

      const wallets = user.wallets.length
        ? user.wallets
            .map((wallet) => `
              <div class="wallet">
                <div class="wallet-main">
                  <code title="${escapeAttribute(wallet.address)}">${escapeHtml(
                    shortAddress(wallet.address)
                  )}</code>

                  <div class="wallet-details">
                    <span class="wallet-badge ${walletTypeClass(
                      wallet.wallet_type
                    )}">${escapeHtml(
                walletTypeLabel(wallet.wallet_type)
              )}</span>

                    <span class="wallet-chain">${escapeHtml(wallet.chain)}</span>
                  </div>

                  <small>
                    Source: ${escapeHtml(wallet.source || "neynar")} ·
                    synced ${escapeHtml(formatDate(wallet.updated_at))}
                  </small>
                </div>

                <div class="wallet-links">
                  <button
                    type="button"
                    onclick="event.stopPropagation(); copyWallet('${escapeAttribute(
                      wallet.address
                    )}')"
                  >
                    Copy
                  </button>

                  <a
                    href="https://intel.arkm.com/explorer/address/${encodeURIComponent(
                      wallet.address
                    )}"
                    target="_blank"
                    rel="noreferrer"
                    onclick="event.stopPropagation()"
                  >
                    Arkham ↗
                  </a>
                </div>
              </div>
            `)
            .join("")
        : `<p class="empty-wallets">No connected wallets were returned for this Farcaster user.</p>`;

      return `
        <article class="user-card">
          <button
            type="button"
            class="user-row"
            onclick="toggleUser('user-${user.fid}')"
          >
            <span class="rank">#${startIndex + index + 1}</span>

            <span class="profile">${profile}</span>

            <span class="fid">FID #${user.fid}</span>

            <span class="follower-link">
              ${
                profileUrl
                  ? `<a href="${profileUrl}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">Open Farcaster profile ↗</a>`
                  : `<span>Profile unavailable</span>`
              }
            </span>

            <span class="wallet-count">
              ${user.wallets.length}
              <small>wallets</small>
            </span>
          </button>

          <section id="user-${user.fid}" class="wallet-panel">
            <div class="wallet-panel-title">
              <div>
                <span>Farcaster-linked wallets</span>
                <small>Profile last synced: ${escapeHtml(
                  formatDate(user.updated_at)
                )}</small>
              </div>

              ${
                profileUrl
                  ? `<a href="${profileUrl}" target="_blank" rel="noreferrer">Open Farcaster profile ↗</a>`
                  : ""
              }
            </div>

            ${wallets}
          </section>
        </article>
      `;
    })
    .join("");

  const previousUrl = buildDirectoryUrl(search, Math.max(1, pageNumber - 1));
  const nextUrl = buildDirectoryUrl(search, pageNumber + 1);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Farcaster Wallet Tracker</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #090b10;
      color: #f4f4f5;
      font-family: Arial, sans-serif;
    }

    .wrap {
      max-width: 1220px;
      margin: auto;
      padding: 30px 16px 60px;
    }

    .eyebrow {
      color: #22d3ee;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 2px;
    }

    h1 {
      margin: 8px 0;
      font-size: 30px;
    }

    .description {
      color: #a1a1aa;
      margin: 0 0 22px;
    }

    form {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }

    input {
      flex: 1;
      min-width: 0;
      padding: 13px;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      background: #18181b;
      color: #fff;
      font-size: 15px;
    }

    form button {
      border: 0;
      border-radius: 8px;
      background: #22d3ee;
      color: #071014;
      padding: 0 16px;
      font-weight: 800;
      cursor: pointer;
    }

    .meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: #a1a1aa;
      font-size: 13px;
      margin: 12px 0;
    }

    .meta b {
      color: #fff;
    }

    .directory {
      border: 1px solid #27272a;
      border-radius: 12px;
      overflow: hidden;
      background: #10131a;
    }

    .user-card {
      border-bottom: 1px solid #27272a;
    }

    .user-card:last-child {
      border: 0;
    }

    .user-row {
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      display: grid;
      grid-template-columns: 60px minmax(220px, 2fr) 120px 200px 100px;
      gap: 12px;
      align-items: center;
      padding: 15px;
    }

    .user-row:hover {
      background: #171b24;
    }

    .rank {
      color: #71717a;
    }

    .profile {
      min-width: 0;
    }

    .profile-link {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      color: inherit;
      text-decoration: none;
    }

    .profile-text {
      min-width: 0;
    }

    a.profile-link:hover strong,
    a.profile-link:hover .handle {
      color: #67e8f9;
      text-decoration: underline;
    }

    .avatar {
      width: 40px;
      height: 40px;
      flex: none;
      border-radius: 50%;
      overflow: hidden;
      background: #27272a;
      display: grid;
      place-items: center;
    }

    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    strong,
    .handle {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    strong {
      font-size: 15px;
    }

    .handle {
      font-size: 13px;
      color: #22d3ee;
      margin-top: 3px;
    }

    .fid,
    .follower-link,
    .wallet-count {
      font-size: 14px;
    }

    .follower-link a {
      color: #22d3ee;
      text-decoration: none;
      font-size: 12px;
    }

    .follower-link a:hover {
      color: #67e8f9;
      text-decoration: underline;
    }

    .follower-link span {
      color: #71717a;
      font-size: 12px;
    }

    .wallet-count {
      font-weight: 700;
    }

    .wallet-count small {
      display: block;
      color: #71717a;
      font-size: 11px;
      font-weight: 400;
      margin-top: 3px;
    }

    .wallet-panel {
      display: none;
      border-top: 1px solid #27272a;
      background: #0b0e14;
      padding: 15px;
    }

    .wallet-panel.open {
      display: block;
    }

    .wallet-panel-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: #a1a1aa;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }

    .wallet-panel-title small {
      display: block;
      margin-top: 5px;
      color: #71717a;
      font-size: 11px;
      text-transform: none;
      letter-spacing: 0;
    }

    .wallet-panel-title a {
      color: #22d3ee;
      text-decoration: none;
      text-transform: none;
      letter-spacing: 0;
      white-space: nowrap;
    }

    .wallet-panel-title a:hover {
      color: #67e8f9;
      text-decoration: underline;
    }

    .wallet {
      display: flex;
      justify-content: space-between;
      gap: 15px;
      align-items: center;
      border: 1px solid #27272a;
      border-radius: 8px;
      background: #090b10;
      padding: 11px 12px;
      margin-top: 8px;
    }

    .wallet-main {
      min-width: 0;
    }

    .wallet code {
      color: #e4e4e7;
      font-size: 13px;
    }

    .wallet-details {
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 7px;
    }

    .wallet-badge,
    .wallet-chain {
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 10px;
      font-weight: 700;
    }

    .wallet-badge.custody {
      background: #27354f;
      color: #93c5fd;
    }

    .wallet-badge.evm {
      background: #16362d;
      color: #86efac;
    }

    .wallet-badge.solana {
      background: #34234b;
      color: #d8b4fe;
    }

    .wallet-badge.unknown {
      background: #3f3f46;
      color: #d4d4d8;
    }

    .wallet-chain {
      background: #27272a;
      color: #a1a1aa;
      text-transform: uppercase;
    }

    .wallet small {
      display: block;
      color: #71717a;
      margin-top: 7px;
      font-size: 11px;
    }

    .wallet-links {
      display: flex;
      gap: 8px;
      flex: none;
    }

    .wallet-links button,
    .wallet-links a {
      border: 1px solid #3f3f46;
      background: transparent;
      color: #d4d4d8;
      padding: 6px 8px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 12px;
      cursor: pointer;
    }

    .wallet-links button:hover,
    .wallet-links a:hover {
      border-color: #22d3ee;
      color: #22d3ee;
    }

    .pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-top: 18px;
    }

    .pagination a,
    .pagination span {
      border: 1px solid #3f3f46;
      border-radius: 8px;
      padding: 10px 13px;
      color: #d4d4d8;
      font-size: 13px;
      text-decoration: none;
    }

    .pagination a:hover {
      border-color: #22d3ee;
      color: #22d3ee;
    }

    .pagination .disabled {
      color: #52525b;
      border-color: #27272a;
    }

    .pagination .page-status {
      border: 0;
      color: #a1a1aa;
      padding: 0;
    }

    .empty-wallets {
      color: #71717a;
      font-size: 13px;
    }

    .empty {
      padding: 50px;
      text-align: center;
      color: #a1a1aa;
    }

    @media (max-width: 700px) {
      .user-row {
        grid-template-columns: 40px 1fr 72px;
        gap: 8px;
        padding: 13px;
      }

      .fid,
      .follower-link,
      .wallet-count {
        display: none;
      }

      .wallet {
        align-items: flex-start;
        flex-direction: column;
      }

      .wallet-links {
        width: 100%;
      }

      .wallet-links > * {
        flex: 1;
        text-align: center;
      }

      .meta {
        flex-direction: column;
        gap: 4px;
      }

      .wallet-panel-title {
        align-items: flex-start;
        flex-direction: column;
      }

      .pagination {
        flex-wrap: wrap;
      }

      .pagination .page-status {
        order: 3;
        width: 100%;
        text-align: center;
      }
    }
  </style>
</head>

<body>
  <main class="wrap">
    <div class="eyebrow">FARCASTER INTELLIGENCE</div>

    <h1>Connected Wallet Directory</h1>

    <p class="description">
      Browse Farcaster custody and verified wallet addresses.
      Open a Farcaster profile to view its current follower count.
    </p>

    <form>
      <input
        name="search"
        value="${escapeAttribute(search)}"
        placeholder="Search @username, FID, or wallet address"
      >
      <button type="submit">Search</button>
    </form>

    <div class="meta">
      <span>
        <b>${formatNumber(totals.user_count)}</b> imported Farcaster users ·
        <b>${formatNumber(totals.wallet_count)}</b> Farcaster-linked wallets
      </span>

      <span>Sort: FID ↑</span>
    </div>

    <section class="directory">
      ${
        users.length
          ? rows
          : `<div class="empty">No users match your search yet.</div>`
      }
    </section>

    <nav class="pagination" aria-label="Directory pages">
      ${
        pageNumber > 1
          ? `<a href="${escapeAttribute(previousUrl)}">← Previous</a>`
          : `<span class="disabled">← Previous</span>`
      }

      <span class="page-status">
        Page ${formatNumber(pageNumber)} · ${PAGE_SIZE} users per page
      </span>

      ${
        hasNextPage
          ? `<a href="${escapeAttribute(nextUrl)}">Next →</a>`
          : `<span class="disabled">Next →</span>`
      }
    </nav>
  </main>

  <script>
    function toggleUser(id) {
      document.getElementById(id).classList.toggle("open");
    }

    async function copyWallet(address) {
      try {
        await navigator.clipboard.writeText(address);
        alert("Wallet copied");
      } catch {
        alert("Could not copy wallet automatically: " + address);
      }
    }
  </script>
</body>
</html>`;
}

async function start() {
  await ensureSchema();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          backfillRunning,
          timestamp: new Date().toISOString(),
        });
      }

      if (url.pathname === "/backfill/status") {
        if (!isValidBackfillRequest(url)) {
          return json(res, 401, { error: "Unauthorized." });
        }

        const state = await getState();

        return json(res, 200, {
          ok: true,
          runningInThisContainer: backfillRunning,
          ...state,
        });
      }

      if (url.pathname === "/backfill/stop") {
        if (!isValidBackfillRequest(url)) {
          return json(res, 401, { error: "Unauthorized." });
        }

        stopRequested = true;
        await setState("backfill_status", "stop_requested");

        return json(res, 200, {
          ok: true,
          message: "Backfill will stop after the current batch.",
        });
      }

      if (url.pathname === "/backfill/start") {
        if (!isValidBackfillRequest(url)) {
          return json(res, 401, { error: "Unauthorized." });
        }

        if (backfillRunning) {
          return json(res, 409, {
            error: "A backfill is already running.",
          });
        }

        const endFid = parseInteger(
          url.searchParams.get("end"),
          100000,
          1,
          2000000
        );

        const batchSize = parseInteger(
          url.searchParams.get("batch"),
          100,
          1,
          100
        );

        const delayMs = parseInteger(
          url.searchParams.get("delay"),
          1200,
          500,
          10000
        );

        stopRequested = false;

        runBackfill(endFid, batchSize, delayMs).catch((error) => {
          console.error("Backfill unhandled error:", error);
        });

        return json(res, 202, {
          ok: true,
          message: "Backfill started.",
          endFid,
          batchSize,
          delayMs,
        });
      }

      if (url.pathname === "/import") {
        if (!isValidBackfillRequest(url)) {
          return json(res, 401, { error: "Unauthorized." });
        }

        const fids = (url.searchParams.get("fids") || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 100);

        if (fids.length === 0) {
          return json(res, 400, {
            error: "Use /import?fids=99&token=YOUR_BACKFILL_TOKEN",
          });
        }

        const validFids = fids
          .map(Number)
          .filter((fid) => Number.isInteger(fid) && fid > 0);

        if (validFids.length === 0) {
          return json(res, 400, {
            error: "FIDs must be positive whole numbers.",
          });
        }

        const users = await fetchUsersFromNeynar(validFids);

        await saveUsers(users);

        return json(res, 200, {
          ok: true,
          requested: validFids.length,
          imported: users.length,
        });
      }

      if (url.pathname === "/" || url.pathname === "/favicon.ico") {
        const search = url.searchParams.get("search") || "";
        const pageNumber = parseInteger(
          url.searchParams.get("page"),
          1,
          1,
          1000000
        );

        const [directory, totals] = await Promise.all([
          getUsers(search, pageNumber),
          getDirectoryTotals(),
        ]);

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });

        res.end(
          page(
            directory.users,
            totals,
            search,
            pageNumber,
            directory.hasNextPage
          )
        );

        return;
      }

      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.error("Request failed:", message);

      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });

      res.end(
        JSON.stringify({
          error: "Server error.",
          details: message,
        })
      );
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Farcaster dashboard running on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
