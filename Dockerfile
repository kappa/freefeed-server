FROM node:22-bookworm

RUN apt-get update && \
    apt-get install -y \
    imagemagick \
    ffmpeg \
    g++ \
    git \
    make

COPY . /server
WORKDIR /server

# The base image ships Yarn 1.x, which cannot read the Yarn 4 lockfile and
# silently ignores --immutable. Enable corepack so the packageManager-pinned
# Yarn 4.18.0 performs a lockfile-exact install. The corepack cache lives in
# a shared root-owned directory so the runtime user reuses it without
# network access. Install scripts run for this build step only: the cld
# native module (bin/count-daily-stats) must compile, as with previous builds.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && \
    rm -rf node_modules && \
    rm -f log/*.log && \
    mkdir -p ./public/files/attachments && \
    YARN_ENABLE_SCRIPTS=true yarn install --immutable && \
    chmod -R a+rX /opt/corepack

ENV NODE_ENV production

RUN mkdir -p /server/log /server/public/files/attachments /tmp/yarn-cache && \
    chown -R node:node /server/log /server/public/files /tmp/yarn-cache
USER node

ENV HOME=/tmp
ENV YARN_CACHE_FOLDER=/tmp/yarn-cache

CMD ["yarn","start"]
