const http = require("http");
const { Pool } = require("pg");

const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL;
const neynarApiKey = process.env.NEYNAR_API_KEY;

if (!databaseUrl) {
  console.error("Missing DATABASE_URL. Add it in Railway Variables.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl ? { rejectUnauthorized: false } : undefined,
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortAddress(address) {
  if (!address || address.length < 14) return address || "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
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

    CREATE INDEX IF NOT EXISTS farcaster_users_followers_idx
      ON farcaster_users (follower_count DESC NULLS LAST);

    CREATE INDEX IF NOT EXISTS farcaster_users_username_idx
      ON farcaster_users (username);

    CREATE INDEX IF NOT EXISTS wallets_fid_idx
      ON wallets (fid);
  `);
}

function normalizeAddress(address) {
  return String(address).trim().toLowerCase();
}

async function importFids(fids) {
  if (!neynarApiKey) {
    throw new Error("Missing NEYNAR_API_KEY in Railway Variables.");
  }

  const validFids = [...new Set(
    fids
      .map((fid) => Number(fid))
      .filter((fid) => Number.isInteger(fid) && fid > 0)
  )].slice(0, 100);

  if (validFids.length === 0) {
    throw new Error("No valid FIDs supplied.");
  }

  const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk/");
  url.searchParams.set("fids", validFids.join(","));

  const response = await fetch(url, {
    headers: {
      "x-api-key": neynarApiKey,
      accept: "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Neynar error ${response.status}: ${text}`);
  }

  const body = JSON.parse(text);
  const users = body.users || [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const user of users) {
      const fid = Number(user.fid);

      await client.query(
        `
          INSERT INTO farcaster_users (
            fid, username, display_name, pfp_url,
            follower_count, following_count, custody_address, updated_at
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

      const wallets = [];

      if (user.custody_address) {
        wallets.push({
          address: user.custody_address,
          chain: "ethereum",
          walletType: "custody",
        });
      }

      for (const address of user.verified_addresses?.eth_addresses || []) {
        wallets.push({
          address,
          chain: "ethereum",
          walletType: "verified_evm",
        });
      }

      for (const address of user.verified_addresses?.sol_addresses || []) {
        wallets.push({
          address,
          chain: "solana",
          walletType: "verified_solana",
        });
      }

      for (const wallet of wallets) {
        await client.query(
          `
            INSERT INTO wallets (
              address, fid, chain, wallet_type, source, updated_at
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
            normalizeAddress(wallet.address),
            fid,
            wallet.chain,
            wallet.walletType,
          ]
        );
      }
    }

    await client.query("COMMIT");

    return {
      requested: validFids.length,
      imported: users.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getUsers(search) {
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

  const result = await pool.query(
    `
      SELECT
        u.fid,
        u.username,
        u.display_name,
        u.pfp_url,
        u.follower_count,
        u.following_count,
        COALESCE(
          json_agg(
            json_build_object(
              'address', w.address,
              'chain', w.chain,
              'wallet_type', w.wallet_type
            )
            ORDER BY w.wallet_type, w.address
          ) FILTER (WHERE w.address IS NOT NULL),
          '[]'::json
        ) AS wallets
      FROM farcaster_users u
      LEFT JOIN wallets w ON w.fid = u.fid
      ${where}
      GROUP BY u.fid
      ORDER BY u.follower_count DESC NULLS LAST, u.fid ASC
      LIMIT 250
    `,
    values
  );

  return result.rows;
}

function page(users, search) {
  const rows = users.map((user, index) => {
    const profileName = user.display_name || user.username || "Unknown";
    const handle = user.username ? `@${user.username}` : "@unknown";
    const avatar = user.pfp_url
      ? `<img src="${escapeHtml(user.pfp_url)}" alt="" />`
      : `<span>${escapeHtml(profileName.slice(0, 1).toUpperCase())}</span>`;

    const wallets = user.wallets.length
      ? user.wallets.map((wallet) => `
          <div class="wallet">
            <div>
              <code title="${escapeHtml(wallet.address)}">${escapeHtml(shortAddress(wallet.address))}</code>
              <small>${escapeHtml(wallet.wallet_type.replace("_", " "))} · ${escapeHtml(wallet.chain)}</small>
            </div>
            <div class="wallet-links">
              <button onclick="copyWallet('${escapeHtml(wallet.address)}')">Copy</button>
              <a href="https://intel.arkm.com/explorer/address/${encodeURIComponent(wallet.address)}" target="_blank" rel="noreferrer">Arkham ↗</a>
            </div>
          </div>
        `).join("")
      : `<p class="empty-wallets">No connected wallets imported.</p>`;

    return `
      <article class="user-card">
        <button class="user-row" onclick="toggleUser('user-${user.fid}')">
          <span class="rank">#${index + 1}</span>
          <span class="profile">
            <span class="avatar">${avatar}</span>
            <span>
              <strong>${escapeHtml(profileName)}</strong>
              <em>${escapeHtml(handle)}</em>
            </span>
          </span>
          <span class="fid">FID #${user.fid}</span>
          <span class="followers">${formatNumber(user.follower_count)} <small>followers</small></span>
          <span class="wallet-count">${user.wallets.length} <small>wallets</small></span>
        </button>
        <section id="user-${user.fid}" class="wallet-panel">
          <div class="wallet-panel-title">
            <span>Connected wallets</span>
            ${user.username ? `<a href="https://warpcast.com/${encodeURIComponent(user.username)}" target="_blank" rel="noreferrer">Farcaster profile ↗</a>` : ""}
          </div>
          ${wallets}
        </section>
      </article>
    `;
  }).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Farcaster Wallet Tracker</title>
  <style>
    *{box-sizing:border-box} body{margin:0;background:#090b10;color:#f4f4f5;font-family:Arial,sans-serif}
    .wrap{max-width:1220px;margin:auto;padding:30px 16px 60px}
    .eyebrow{color:#22d3ee;font-size:11px;font-weight:800;letter-spacing:2px}
    h1{margin:8px 0;font-size:30px} .description{color:#a1a1aa;margin:0 0 22px}
    form{display:flex;gap:8px;margin-bottom:20px} input{flex:1;min-width:0;padding:13px;border:1px solid #3f3f46;border-radius:8px;background:#18181b;color:#fff;font-size:15px}
    button,.button,a{font:inherit} form button{border:0;border-radius:8px;background:#22d3ee;color:#071014;padding:0 16px;font-weight:800;cursor:pointer}
    .meta{display:flex;justify-content:space-between;color:#a1a1aa;font-size:13px;margin:12px 0}.meta b{color:#fff}
    .directory{border:1px solid #27272a;border-radius:12px;overflow:hidden;background:#10131a}
    .user-card{border-bottom:1px solid #27272a}.user-card:last-child{border:0}
    .user-row{width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;display:grid;grid-template-columns:60px minmax(220px,2fr) 120px 150px 100px;gap:12px;align-items:center;padding:15px}
    .user-row:hover{background:#171b24}.rank{color:#71717a}.profile{display:flex;align-items:center;gap:12px;min-width:0}.avatar{width:40px;height:40px;flex:none;border-radius:50%;overflow:hidden;background:#27272a;display:grid;place-items:center}.avatar img{width:100%;height:100%;object-fit:cover}
    strong,em{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}strong{font-size:15px}em{font-size:13px;font-style:normal;color:#22d3ee;margin-top:3px}.fid,.followers,.wallet-count{font-size:14px}.followers{font-weight:700}.followers small,.wallet-count small{display:block;color:#71717a;font-size:11px;font-weight:400;margin-top:3px}
    .wallet-panel{display:none;border-top:1px solid #27272a;background:#0b0e14;padding:15px}.wallet-panel.open{display:block}.wallet-panel-title{display:flex;justify-content:space-between;color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}.wallet-panel-title a{color:#22d3ee;text-decoration:none;text-transform:none;letter-spacing:0}
    .wallet{display:flex;justify-content:space-between;gap:15px;align-items:center;border:1px solid #27272a;border-radius:8px;background:#090b10;padding:11px 12px;margin-top:8px}.wallet code{color:#e4e4e7;font-size:13px}.wallet small{display:block;color:#71717a;margin-top:5px;text-transform:capitalize}.wallet-links{display:flex;gap:8px}.wallet-links button,.wallet-links a{border:1px solid #3f3f46;background:transparent;color:#d4d4d8;padding:6px 8px;border-radius:6px;text-decoration:none;font-size:12px;cursor:pointer}.wallet-links button:hover,.wallet-links a:hover{border-color:#22d3ee;color:#22d3ee}.empty-wallets{color:#71717a;font-size:13px}
    .empty{padding:50px;text-align:center;color:#a1a1aa}@media(max-width:700px){.user-row{grid-template-columns:40px 1fr 72px;gap:8px;padding:13px}.fid,.wallet-count{display:none}.followers small{display:none}.wallet{align-items:flex-start;flex-direction:column}.wallet-links{width:100%}.wallet-links>*{flex:1;text-align:center}.meta{gap:10px}.user-row .followers{justify-self:end}}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">FARCASTER INTELLIGENCE</div>
    <h1>Connected Wallet Directory</h1>
    <p class="description">Farcaster FIDs and their custody / verified wallet addresses. Sorted by followers.</p>
    <form>
      <input name="search" value="${escapeHtml(search)}" placeholder="Search @username, FID, or wallet address">
      <button type="submit">Search</button>
    </form>
    <div class="meta"><span><b>${formatNumber(users.length)}</b> imported Farcaster users</span><span>Sort: Followers ↓</span></div>
    <section class="directory">
      ${users.length ? rows : `<div class="empty">No users imported yet.<br><br>Use <code>/import?fids=13889</code> to import your first FID.</div>`}
    </section>
  </main>
  <script>
    function toggleUser(id) {
      document.getElementById(id).classList.toggle("open");
    }
    async function copyWallet(address) {
      await navigator.clipboard.writeText(address);
      alert("Wallet copied");
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

      if (url.pathname === "/import") {
        const fids = (url.searchParams.get("fids") || "")
          .split(",")
          .map((value) => value.trim());

        const result = await importFids(fids);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }

      if (url.pathname === "/" || url.pathname === "/favicon.ico") {
        const search = url.searchParams.get("search") || "";
        const users = await getUsers(search);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(users, search));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      console.error(error);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Server error: ${error.message}`);
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
