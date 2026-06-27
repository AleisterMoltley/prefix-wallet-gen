FROM rustlang/rust:nightly-slim AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY grinder/ /build/
RUN cd /build && cargo install --path .

FROM node:22-slim

COPY --from=builder /usr/local/cargo/bin/solana-vanity /usr/local/bin/solana-vanity

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]