FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Tuned for the machine this actually gets built on: a Raspberry Pi, often on
# Wi-Fi, pulling a thousand-odd packages over half an hour. npm's defaults —
# two retries and fifteen parallel sockets — lose that race regularly, and an
# ECONNRESET forty minutes in throws the whole build away. Fewer sockets is
# what stops a weak link resetting them; more retries is what survives it when
# it happens anyway. Audit and funding checks are dropped because they are two
# more chances to fail on a network that is already struggling.
RUN npm ci --no-audit --no-fund \
      --maxsockets 5 \
      --fetch-retries 5 \
      --fetch-retry-mintimeout 20000 \
      --fetch-retry-maxtimeout 180000 \
      --fetch-timeout 900000
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME /data
ENV DATA_DIR=/data
EXPOSE 8420
CMD ["node", "dist/index.js"]
