const apiKey = process.env.NEYNAR_API_KEY;
const fid = process.env.TEST_FID || "13889";

if (!apiKey) {
  console.error("Missing NEYNAR_API_KEY Railway Variable.");
  process.exit(1);
}

async function main() {
  const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk/");
  url.searchParams.set("fids", fid);

  console.log(`Looking up Farcaster FID: ${fid}`);

  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      accept: "application/json",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    console.error(`Neynar request failed: ${response.status}`);
    console.error(raw);
    process.exit(1);
  }

  const body = JSON.parse(raw);
  const users = body.users ?? [];

  if (users.length === 0) {
    console.log(`No user returned for FID ${fid}`);
    process.exit(0);
  }

  const user = users[0];

  console.log(
    JSON.stringify(
      {
        fid: user.fid,
        username: user.username,
        displayName: user.display_name,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        custodyAddress: user.custody_address ?? null,
        verifiedEvmWallets: user.verified_addresses?.eth_addresses ?? [],
        verifiedSolanaWallets: user.verified_addresses?.sol_addresses ?? [],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
