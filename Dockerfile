FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY config ./config

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV XHS_MONITOR_HOST=0.0.0.0
ENV XHS_MONITOR_PORT=3188

EXPOSE 3188
VOLUME ["/app/data"]

CMD ["node", "server.mjs"]
