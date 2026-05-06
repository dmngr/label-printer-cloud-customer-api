# label-printer-cloud-customer-api

Customer-facing read-only API Lambda for the DM Label Printer customer-facing
web app at [app.label.ninja](https://app.label.ninja). Sibling repo to
[`dmngr/label-printer-cloud-customer-pairing`](https://github.com/dmngr/label-printer-cloud-customer-pairing):
once a customer has claimed a pairing code (and therefore holds a customer
bearer), this Lambda is what they call to list their stores and devices.

| Endpoint | Method | Auth |
|---|---|---|
| `/api/v1/me/stores` | GET | strict customer bearer |
| `/api/v1/me/devices` | GET | strict customer bearer |
| `/api/v1/me/devices/{deviceCode}` | GET | strict customer bearer |
| `/api/v1/me/devices/{deviceCode}/products` | GET | strict customer bearer |
| `/api/v1/me/devices/{deviceCode}/templates` | GET | strict customer bearer |
| `/api/v1/me/devices/{deviceCode}/jobs` | GET | strict customer bearer |
| `/api/v1/me/devices/{deviceCode}/commands` | POST | strict customer bearer |
| `/api/v1/me/devices/{deviceCode}/commands/{id}` | GET | strict customer bearer |

The `commands` POST endpoint mirrors the schema the cloud admin tool's
device-command-write Lambda already produces, so the device-side
`CloudRemoteCommandService` claim/complete flow picks up customer-issued
commands unchanged. Phase 2 supports `commandType: "print-label"` only.

## Layout

- `src/handlers/customer-api.ts` — single Function URL handler with internal routing
- `src/storage/dynamo-store.ts` — DynamoDB store (low-level `@aws-sdk/client-dynamodb`)
- `src/lib/bearer-authorizer.ts` — bearer extractor + sha256 hex hasher
- `src/lib/http-results.ts` — Function URL response helpers (CORS, JSON, text)
- `src/lib/handled-errors.ts` — handled-errors `ACTION:SLACK_HANDLED_ERROR_HE1=` marker
- `src/types.ts` — wire model interfaces (response shapes locked here)
- `src/config.ts` — env-var-driven options (table names, online/active windows)
- `cloudformation/stack.json` — CloudFormation template (`nodejs24.x`, `arm64`)
- `custom_errors.policy.json` — handled-errors policy (defaults `emit_requestid_success: false`)

## Auth

Every non-OPTIONS request MUST present a customer bearer:

```
Authorization: Bearer <token>
```

Resolution flow:

1. `sha256(<bearer>)` -> 64-char lowercase hex.
2. `GetItem` on `DMLabelPrinterCloudCustomerTokens` (PK `TokenHash`).
3. If not found -> 401 + `customer_api_unauthorized` / `customer_api_invalid_token` / `customer_api_token_not_found` ACTION marker (depending on which step failed).
4. Else read `StoreIds` (SS) — the caller is authorized for those stores. The
   handler best-effort updates `LastUsedAtUtc` to the current ISO 8601 string
   (fire-and-forget; never blocks the response).

The DM cloud bearer (`DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN`) used by the
device-side codes Lambda is **not** consumed here.

## Tables (already exist in `eu-west-1`, do NOT recreate)

- `DMLabelPrinterCloudDevices` — PK `DeviceCode` (S). Read-only here. We
  project the reserved-word attribute `Group` via `ProjectionExpression "#g"` +
  `ExpressionAttributeNames {"#g": "Group"}`. There is no GSI on `Group`
  (8 devices in pre-prod; `Scan` with `FilterExpression "#g IN (...)"` is
  fine).
- `DMLabelPrinterCloudCustomerTokens` — PK `TokenHash` (S). Other: `StoreIds`
  (SS), `LastUsedAtUtc` (S), `CreatedAtUtc` (S).

## Response shapes (locked)

`GET /api/v1/me/stores`:

```json
{
  "stores": [
    { "storeId": "DM-HARDEN-PILOT", "deviceCount": 3, "onlineCount": 1 }
  ]
}
```

`GET /api/v1/me/devices`:

```json
{
  "stores": [
    {
      "storeId": "DM-HARDEN-PILOT",
      "devices": [
        {
          "deviceCode": "...",
          "deviceName": "...",
          "appVersion": "...",
          "lastSeenAtUtc": "...",
          "isActive": true,
          "isOnline": true,
          "pendingCommands": 0,
          "failedJobs": 0
        }
      ]
    }
  ]
}
```

`GET /api/v1/me/devices/{deviceCode}` returns the same single-device shape with
an extra `storeId` field, no `stores` wrapper, and 403s if the device's
`Group` is not in the caller token's authorized list.

`isOnline` is `true` when `lastSeenAtUtc` is within the last 5 minutes;
`isActive` is `true` within the last 60 minutes.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DM_LABEL_PRINTER_CLOUD_DEVICES_TABLE` | no | `DMLabelPrinterCloudDevices` | Devices table name. |
| `DM_LABEL_PRINTER_CLOUD_CUSTOMER_TOKENS_TABLE` | no | `DMLabelPrinterCloudCustomerTokens` | Customer-tokens table name. |
| `DM_LABEL_PRINTER_CLOUD_DEVICE_COMMANDS_TABLE` | no | `DMLabelPrinterCloudDeviceCommands` | Device-commands table — Phase 2 customer-api writes Pending rows here. |
| `DM_LABEL_PRINTER_CLOUD_COUNTERS_TABLE` | no | `DMLabelPrinterCloudCounters` | Monotonic counters table — `DeviceCommands` row is atomically incremented to mint command Ids. |

## Build & test

```
npm install
npm run build
npm test
```

The build emits `dist/`. The smoke tests assert the handler can be imported,
bearer extraction + sha256 hash work, `redactDeep` redacts sensitive headers,
and the policy file declares every handled-error code referenced by the
handler.

## Deploy

Follows the team's `crp-repos-harden-deploy` skill / `lambda-upload` canonical
scripts:

- `npm run deploy:prod` — code-only deploy. Builds TS, then runs
  `lambda-upload deploy-prod dm`.
- `npm run deploy:prod:check` — local validation, no AWS calls; assumes
  `nodejs24.x` for the AWS SDK dependency policy check.
- `npm run deploy:prod:upgrade` — runtime + arch upgrade path.

The CloudFormation template (`cloudformation/stack.json`) parameterizes the
function with `HandlerEntrypoint` defaulted to
`dist/handlers/customer-api.handler`.

Function URL configuration (`AuthType: NONE`, `InvokeMode: BUFFERED`) is
applied out-of-band via CRP / lambda-upload tooling.

## Handled errors

The handler emits `ACTION:SLACK_HANDLED_ERROR_HE1=<code>|<base64url(json)>`
for each policy-tracked failure. The repo-local `custom_errors.policy.json`
declares the codes used here:

- `customer_api_unauthorized` (401)
- `customer_api_invalid_token` (401)
- `customer_api_token_not_found` (401)
- `customer_api_token_no_stores` (409)
- `customer_api_device_not_found` (404)
- `customer_api_forbidden_store` (403)
- `customer_api_invalid_query_param` (400)
- `customer_api_command_invalid_body` (400)
- `customer_api_command_unsupported_type` (400)
- `customer_api_command_invalid_quantity` (400)
- `customer_api_command_product_not_found` (400)
- `customer_api_command_template_not_found` (400)
- `customer_api_command_not_found` (404)

Defaults to `emit_requestid_success: false` (no legacy Slack suppression). See
[`dmngr/lambda-policies/handled-errors/handled-error-policy.md`](https://github.com/dmngr/lambda-policies/blob/main/handled-errors/handled-error-policy.md)
for the contract.

## Next steps (operator)

1. `crp repos harden-pr label-printer-cloud-customer-api`
2. After PR merges and you've reviewed it: `crp repos harden-deploy label-printer-cloud-customer-api --aws-profile dm --region eu-west-1`
