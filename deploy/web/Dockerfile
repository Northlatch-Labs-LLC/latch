# Latch web application (workspace UI + server + Latch account proxy).
# Build context: repo root. Runtime serves the built SPA from ZCODE_WEB_STATIC_ROOT.
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
# 可选 vendor 登录（z.ai / BigModel）的公开 OAuth 配置，构建期经 vite 注入 web 产物。
# 只注入公开值：client id / 授权 origin / token 端点都不是 secret；secret/token 不得进入构建。
# 删除或清空这些 ENV 即回到 Latch-only fail-safe：zaiWebOAuthConfigured=false，vendor 按钮隐藏、
# 授权跳转被拒绝（packages/web/src/auth/webZaiOAuthConfig.ts / zaiWebOAuthProvider.ts）。
# 注意：本块 ENV 只存在于 build 阶段，不会进入下面的最终运行镜像。
# LATCH_WEB_PUBLIC_ORIGIN 决定 webShareCallbackUrl（OAuth redirect_uri），必须与实际
# 部署 origin 一致，否则 vendor 回跳不会落到本应用。
ARG LATCH_WEB_PUBLIC_ORIGIN=https://latch.xlaunch.work
ENV ZCODE_BASE_URL=${LATCH_WEB_PUBLIC_ORIGIN} \
    ZAI_OAUTH_CLIENT_ID=client_P8X5CMWmlaRO9gyO-KSqtg \
    ZAI_OAUTH_ORIGIN=https://chat.z.ai \
    VITE_BIGMODEL_OAUTH_ORIGIN=https://bigmodel.cn \
    VITE_OAUTH_TOKEN_URL=https://zcode.z.ai/api/v1/oauth/token
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @zcode/server build \
 && pnpm --filter @zcode/web build
# 瘦身：构建完成后剔除 devDependencies 与 web 产物 sourcemap 再进入最终镜像。
# gf-29-latch 磁盘仅 20G，全量 COPY（node_modules ~2.6G）构建两次即写满
# （2026-09-30 1.1.0 构建曾因此 ResourceExhausted）。运行期只需要 prod 依赖：
# packages/server/package.json 的 dependencies/devDependencies 划分完整。
# prod 重装会跳过 devDeps，依赖 devDeps 的生命周期钩子随之失败（根包 prepare=husky、
# packages/desktop postinstall=electron-rebuild，均与 web 运行时无关），故先在镜像内
# 临时删掉这两个钩子再安装（不影响仓库源码）。
RUN node -e "const fs=require('fs');for(const f of ['/repo/package.json','/repo/packages/desktop/package.json']){const j=JSON.parse(fs.readFileSync(f,'utf8'));delete j.scripts.prepare;delete j.scripts.postinstall;fs.writeFileSync(f,JSON.stringify(j,null,2))}" \
 && CI=true pnpm install --prod --frozen-lockfile \
 && find /repo/packages/web/dist -name '*.map' -delete

FROM node:24-bookworm-slim
WORKDIR /repo
COPY --from=build /repo ./
# Latch billing（squad D）：下面两个 ENV 只是占位符，真实值必须在部署时由
# gf-29-latch 上的 root 可读文件（chmod 600）注入容器 env，绝不提交仓库：
#   LATCH_STRIPE_SECRET_KEY       —— founder 的 Stripe sk_test_…（STRIPE-LATCH-KEYS.txt）
#   LATCH_GATEWAY_SERVICE_TOKEN   —— gf-27-xapps 计费服务 env 里的 XLAUNCH_BILLING_SERVICE_TOKEN 值
ENV NODE_ENV=production \
    PORT=8785 \
    ZCODE_WEB_STATIC_ROOT=/repo/packages/web/dist \
    ZCODE_DATA_BASE_DIR=/data/latch \
    HOME=/data/latch \
    LATCH_STRIPE_SECRET_KEY= \
    LATCH_GATEWAY_SERVICE_TOKEN=
VOLUME /data/latch
EXPOSE 8785
CMD ["node", "packages/server/dist/entry-http.js"]
