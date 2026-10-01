# Latch web container (deploy/web/Dockerfile)

Builds and serves the Latch web application (workspace UI + Latch account
sign-in + `/api/latch-account` proxy) from a single container on port 8785.
Build context is the repository root:

```
docker build -f deploy/web/Dockerfile -t latch-web:1.0.0 .
```

## Optional vendor logins (z.ai / BigModel)

The build stage sets the public vendor OAuth configuration as explicit env
defaults (build stage only — none of these leak into the runtime image). They
enable the OPTIONAL vendor logins on the share landing page; they never touch
the first-party Latch account flow, which is the default sign-in path.

| Build env | Value | Purpose |
| --- | --- | --- |
| `LATCH_WEB_PUBLIC_ORIGIN` (ARG) | `https://latch.xlaunch.work` | Public origin of this deployment; becomes the OAuth `redirect_uri` (`<origin>/cn/share/callback`, `packages/shared/src/zcodeEndpoint.ts` `webShareCallbackUrl`). Must match the origin the app is actually served from. |
| `ZCODE_BASE_URL` | `=ARG` | Feeds `VITE_ZCODE_BASE_URL` via vite define; also fixes the share-preview and help-config fetch origins to same-origin. |
| `ZAI_OAUTH_CLIENT_ID` | `client_P8X5CMWmlaRO9gyO-KSqtg` | Public vendor-side OAuth client id (upstream's documented value). Injected into the web bundle via vite define (`packages/web/vite.config.ts`). |
| `ZAI_OAUTH_ORIGIN` | `https://chat.z.ai` | Vendor authorize origin (`/api/oauth/authorize`). |
| `VITE_BIGMODEL_OAUTH_ORIGIN` | `https://bigmodel.cn` | BigModel authorize entry (`/login`, `appId=zcode`). |
| `VITE_OAUTH_TOKEN_URL` | `https://zcode.z.ai/api/v1/oauth/token` | Vendor token-exchange endpoint shared by zai/bigmodel (the body carries `provider`). Unset, the web app keeps the upstream same-origin relative default `/api/v1/oauth/token`, which a standalone Latch deployment does not serve — the exchange then fails with HTTP 404. |

All of these values are public configuration (client ids and URLs), not
secrets; no secret/token may ever be injected through `VITE_` variables.

### Removing the config fail-safes to Latch-only

Deleting or blanking `ZAI_OAUTH_CLIENT_ID` / `ZAI_OAUTH_ORIGIN` makes the web
bundle resolve `zaiWebOAuthConfigured=false`
(`packages/web/src/auth/webZaiOAuthConfig.ts`):

- the vendor buttons on the share landing page do not render
  (`vendorLoginEnabled=false` in `packages/web/src/main.tsx`);
- `WebAuthService.startLogin` refuses to build any Z.ai authorize URL
  (`packages/web/src/auth/webAuthService.ts`);
- `ZaiWebOAuthProvider.buildAuthorizeUrl` throws instead of constructing an
  authorize URL with an empty client id
  (`packages/web/src/auth/zaiWebOAuthProvider.ts`);
- the BigModel authorize URL falls back to this deployment's own origin
  (`/login` → 404) instead of any vendor domain.

There is no hardcoded fallback for the retired client id in source — the
value ships only as this explicit deploy-layer env.
