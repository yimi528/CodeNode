FROM node:22-alpine
RUN apk add --no-cache bash git && mkdir -p /app
WORKDIR /testbed
RUN git init -q && git config user.name Smoke && git config user.email smoke@localhost && printf 'baseline\n' > base.txt && git add base.txt && git commit -qm baseline
