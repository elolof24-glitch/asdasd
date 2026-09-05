const http = require("http");

const port = process.env.PORT || 3000;

const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Farcaster Wallet Tracker</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #090b10;
      color: #f4f4f5;
      font-family: Arial, sans-serif;
    }
    .wrap {
      max-width: 1200px;
      margin: auto;
      padding: 32px 18px;
    }
    .eyebrow {
      color: #22d3ee;
      font-size: 12px;
      font-weight: bold;
      letter-spacing: 2px;
    }
    h1 { margin: 8px 0; font-size: 30px; }
    p { color: #a1a1aa; }
    .search {
      width: 100%;
      margin: 24px 0;
      padding: 13px;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      background: #18181b;
      color: white;
      font-size: 15px;
    }
    .table {
      border: 1px solid #27272a;
      border-radius: 10px;
      overflow: hidden;
      background: #10131a;
    }
    .head, .row {
      display: grid;
      grid-template-columns: 70px 2fr 100px 130px 110px;
      gap: 12px;
      align-items: center;
      padding: 16px;
    }
    .head {
      background: #18181b;
      color: #a1a1aa;
      font-size: 12px;
      font-weight: bold;
      letter-spacing: 1px;
    }
    .row { border-top: 1px solid #27272a; }
    .avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: #27272a;
      display: inline-grid;
      place-items: center;
    }
    .user { display: flex; align-items: center; gap: 12px; }
    .name { font-weight: bold; }
    .handle { color: #22d3ee; font-size: 14px; margin-top: 3px; }
    .muted { color: #a1a1aa; }
    @media (max-width: 650px) {
      .head, .row { grid-template-columns: 45px 1fr 80px; }
      .head span:nth-child(4),
      .head span:nth-child(5),
      .row > span:nth-child(4),
      .row > span:nth-child(5) { display: none; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">FARCASTER INTELLIGENCE</div>
    <h1>Connected Wallet Directory</h1>
    <p>Farcaster users and connected wallets, sorted by followers.</p>

    <input class="search" placeholder="Search @username, FID, or wallet — coming next" disabled />

    <section class="table">
      <div class="head">
        <span>RANK</span>
        <span>USER</span>
        <span>FID</span>
        <span>FOLLOWERS</span>
        <span>WALLETS</span>
      </div>

      <div class="row">
        <span class="muted">#1</span>
        <div class="user">
          <div class="avatar">F</div>
          <div>
            <div class="name">Feddas</div>
            <div class="handle">@feddas</div>
          </div>
        </div>
        <span>#13889</span>
        <span>414</span>
        <span>4</span>
      </div>
    </section>
  </main>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/favicon.ico") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Farcaster dashboard running on port ${port}`);
});
