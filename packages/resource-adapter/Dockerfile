FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-fusepy fuse git util-linux procps \
    && rm -rf /var/lib/apt/lists/*
COPY linux /adapter/linux
COPY native.mjs /adapter/src/native.mjs
CMD ["node", "/adapter/src/native.mjs"]
