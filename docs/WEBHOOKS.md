# MailVault webhooks: guide for the receiving system

MailVault can notify another system (ERP, document management, a script) the moment it saves a file.
An administrator adds the receiver under **Administration → Integrations** and gives you two things:
the **URL** MailVault will call, and a **signing secret** (`whsec_…`).

## What MailVault sends

`POST <your URL>` with `Content-Type: application/json` and these headers:

| Header | Example | Meaning |
|---|---|---|
| `X-MailVault-Event` | `file.saved` | Event type |
| `X-MailVault-Delivery` | `cmx3k2…` | Unique ID of this delivery (same on retries; use it to ignore duplicates) |
| `X-MailVault-Timestamp` | `1794472000` | Unix seconds when this attempt was sent |
| `X-MailVault-Signature` | `sha256=5d41…` | HMAC-SHA256 of `"<timestamp>.<raw body>"` with your secret |

Answer with any **2xx** status within **10 seconds**. Otherwise MailVault retries after 1, 5, 15, 60 and 240 minutes,
then marks the delivery failed and alerts its administrators. Process the event asynchronously if your work takes longer.

### Events

**`file.saved`**: an attachment, or a file unpacked from a ZIP / attached email, was saved.

```json
{
  "id": "cmx3k2a9f0001...",
  "event": "file.saved",
  "occurredAt": "2026-11-12T09:41:07.512Z",
  "data": {
    "downloadId": "cmx3k1z...",
    "file": {
      "name": "INV-1042.pdf",
      "path": "\\\\fs01\\Finance\\Invoices\\vendor.com\\2026\\11\\INV-1042.pdf",
      "sizeBytes": 183422,
      "sha256": "9f2c…64 hex chars…",
      "extractedFrom": { "name": "invoices.zip", "innerPath": "Nov/INV-1042.pdf" }
    },
    "email": {
      "mailbox": "accounts@company.com",
      "from": "billing@vendor.com",
      "subject": "Invoice INV-1042",
      "receivedAt": "2026-11-12T09:38:55.000Z",
      "internetMessageId": "<abc123@vendor.com>"
    },
    "rule": { "id": "cmw…", "name": "Vendor invoices" },
    "attachment": { "name": "invoices.zip", "sizeBytes": 402113 }
  }
}
```
`extractedFrom` is present only for files unpacked from a ZIP or an attached email.

**`file.failed`**: a download failed permanently. Same `data` as above (without `path`/`sha256`) plus
`"error": { "code": "SOURCE_GONE", "message": "The email or attachment no longer exists in the mailbox" }`.

**`job.completed`**: a historical job finished:
`{ "jobId", "mailbox", "mode": "simulate" | "execute", "dateFrom", "dateTo", "scanned", "matched", "filesQueued" }`.

**`ping`**: sent by the *Send a test message* button. Reply 2xx; no action needed.

## Verifying the signature

Always verify before trusting the request, and reject timestamps older than ~5 minutes.
Use the **raw request body** exactly as received (before JSON parsing).

### Node.js (Express)

```js
import express from 'express';
import crypto from 'node:crypto';

const SECRET = process.env.MAILVAULT_WEBHOOK_SECRET;
const app = express();

app.post('/api/mailvault', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('X-MailVault-Timestamp');
  const sig = req.get('X-MailVault-Signature') ?? '';
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${req.body}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).send('bad signature');
  }
  const event = JSON.parse(req.body.toString('utf8'));
  // TODO: ignore if event.id was already processed, then queue your work
  res.status(200).send('ok');
});
```

### C# (ASP.NET Core)

```csharp
app.MapPost("/api/mailvault", async (HttpRequest req) =>
{
    using var reader = new StreamReader(req.Body);
    var body = await reader.ReadToEndAsync();
    var ts = req.Headers["X-MailVault-Timestamp"].ToString();
    var sig = req.Headers["X-MailVault-Signature"].ToString();
    var secret = Environment.GetEnvironmentVariable("MAILVAULT_WEBHOOK_SECRET")!;

    using var hmac = new System.Security.Cryptography.HMACSHA256(System.Text.Encoding.UTF8.GetBytes(secret));
    var hash = hmac.ComputeHash(System.Text.Encoding.UTF8.GetBytes($"{ts}.{body}"));
    var expected = "sha256=" + Convert.ToHexString(hash).ToLowerInvariant();
    var fresh = Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - long.Parse(ts)) < 300;

    if (!fresh || !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(sig), System.Text.Encoding.UTF8.GetBytes(expected)))
        return Results.Unauthorized();

    // TODO: ignore duplicates by the "id" field, then queue your work
    return Results.Ok();
});
```

## Good practice

- Treat the delivery `id` as an idempotency key: retries resend the same `id`.
- The file path is a UNC path on your network; the receiving service account needs read access to it.
- If the secret leaks, an administrator can create a new one (Integrations → key icon); update your receiver at the same time.
