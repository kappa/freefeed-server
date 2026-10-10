# Container security

Runtime identity and filesystem expectations for the FreeFeed server image.
Deployment side (UID discovery, bind mounts) lives in the `server` role of
freefeed-ansible; both changes roll out together.

## Runtime identity

- The image default is `USER node` (UID/GID 1000). Application code, media
  tools (ImageMagick, ffmpeg, exiftool) and cron-job commands all run
  unprivileged; there is no root entrypoint and no startup chown.
- Where host bind mounts require it, Ansible overrides the container user
  with the numeric host `freefeed` UID/GID discovered via getent. The host
  UID is not assumed to equal 1000.
- `HOME=/tmp` and `YARN_CACHE_FOLDER=/tmp/yarn-cache` keep runtime-writable
  tool state off the root-owned dependency tree. Startup never modifies
  `/server/node_modules`, `/opt/corepack` (read-only Yarn toolchain cache)
  or the mounted configuration.

## Path expectations

| Path | Mount | Access |
|---|---|---|
| `/server/config/local-*.json`, `/server/config/welcome-directs/local-*.yml` | host config files, read-only | readable by the runtime UID; never written |
| `/etc/freefeed/banlist.txt`, `/etc/freefeed/mailchecker.txt` | host files, read-only | readable by the runtime UID; never written |
| `/server/log` | host log dir | writable by the runtime UID (host dir owned by `freefeed`) |
| `/server/public/files` | host `runtime-files` dir (numeric-UID deploys) | writable by the runtime UID; `attachments/` and `profilepics/` subdirectories are pre-created by Ansible because profile-picture writes do not create parent directories |
| shared-media dir (`/media-tmp`) | host `media-tmp` dir | writable by the runtime UID (host dir owned by `freefeed`) |
| `/tmp` | container tmpfs | writable; `HOME` and Yarn cache live here |

No `chmod 777` anywhere. Log rotation keeps using `copytruncate` so no
log-directory ownership dance is needed on rotate.

## Build hygiene

- `.dockerignore` excludes VCS data, dependencies, logs, coverage,
  security-scan output, `.env*` files, local config overrides
  (`config/local*`, `config/welcome-directs/local*`), generated attachment
  uploads, private keys (`*.pem`, `*.key`) and editor/tool state. Default
  config, mail/view assets and `.yarn/releases` + `.yarn/plugins`
  (required by the configured Yarn 4) stay in the build.
- The build uses `COPY` (not `ADD`) and a lockfile-exact
  `yarn install --immutable` under the packageManager-pinned Yarn 4.18.0
  (corepack; the base image default Yarn 1.x cannot read the Yarn 4
  lockfile). Install scripts run for the build step only so the `cld`
  native module compiles.
- Secret exclusion is verified by building from a probe context that
  contains a dummy secret marker in excluded local config plus a fake log,
  then inspecting every layer (`docker save`) and the final filesystem:
  neither marker may appear in any layer. Never use a real secret for this.

## Rollout

1. Deploy the Ansible mount-permission changes first (log dir, media-tmp,
   runtime-files with subdirectories, all owned by `freefeed`).
2. Roll the new image with the numeric `user:` override to a single
   instance; validate `/v2/server-info`, login, image upload/thumbnail,
   video preview and one background media job under the deployed UID.
3. Expand to remaining instances. Roll the container version and UID
   override back together if the stage fails.
