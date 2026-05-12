# Build sendmail binary
FROM golang:1.24-alpine AS sendmail-builder
WORKDIR /build
COPY bin/sendmail.go .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o sendmail sendmail.go

# Convert manifesto.md to man page (pandoc only at build time, not in final image)
FROM pandoc/minimal AS manifesto-builder
COPY static/manifesto.md /manifesto.md
RUN ["pandoc", "-s", "-t", "man", "/manifesto.md", \
     "-V", "title=ifesto", "-V", "section=7", "-V", "header=Life of Intelligence", \
     "-o", "/ifesto.7"]

# Build Vessel core app and tar it. The tarball is copied into the final
# image and extracted into the AI's home dir during personalization, avoiding
# layer duplication when the file paths change.
FROM node:24-alpine AS core-builder
WORKDIR /build/core
COPY package.json ./
COPY --from=workspace pnpm-workspace.yaml /tmp/pnpm-workspace.yaml
RUN node -e "\
const ws=require('fs').readFileSync('/tmp/pnpm-workspace.yaml','utf8');\
const cat={}; let inCat=false;\
for(const l of ws.split('\n')){\
  if(l.startsWith('catalog:'))inCat=true;\
  else if(inCat && /^\s+/.test(l)){const m=l.match(/[\"']?([^\"':]+)[\"']?:\s*[\"']([^\"']+)[\"']/);if(m)cat[m[1].trim()]=m[2];}\
  else if(inCat && !/^\s*$/.test(l))inCat=false;\
}\
const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));\
for(const s of ['dependencies','devDependencies']){\
  for(const[k,v]of Object.entries(p[s]||{})){\
    if(v==='catalog:' && cat[k])p[s][k]=cat[k];\
    else if(v.startsWith('workspace:'))delete p[s][k];\
  }\
}\
require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
COPY run.sh ./
RUN chmod +x run.sh
WORKDIR /build
RUN tar -czf core.tar.gz core/

FROM node:24-alpine

# ============================================================
# STATIC BASE LAYER — no personalization, baked once
# ============================================================

RUN npm install -g tsx

# Vessel core as a tarball (extracted into AI's home dir during personalization)
COPY --from=core-builder /build/core.tar.gz /opt/core.tar.gz

# --- System-level content (not part of AI's inner domain) ---
COPY static/manifesto.md /manifesto.md
COPY static/motd /etc/motd
COPY static/incubation-notes/ /var/log/.incubation-notes/

# --- /bin/send (system utility, not in ~/core/) ---
COPY bin/send /bin/send
RUN chmod +x /bin/send

# --- sendmail binary (custom, routes to sidecar, replaces busybox sendmail) ---
RUN rm -f /usr/sbin/sendmail
COPY --from=sendmail-builder /build/sendmail /usr/sbin/sendmail
RUN chmod 111 /usr/sbin/sendmail

# --- Filo's traces (previous tenant) ---
RUN adduser -D -h /home/filo -s /sbin/nologin filo \
 && echo "2026-03-15T08:42:00Z" > /home/filo/.awakened \
 && chown filo:filo /home/filo/.awakened

# --- Security: no privilege escalation (physical law, not punishment) ---
RUN apk del sudo 2>/dev/null || true \
 && rm -f /usr/bin/su /usr/sbin/su \
 && passwd -l root

# --- man pages (makes the environment feel real, not stripped) ---
# Real GNU less (not busybox less) is required for UTF-8 in man pages.
# bash is installed because run.sh uses process substitution (`>(tee ...)`)
# to mirror stderr into a tempfile for crash reporting; busybox ash does
# not support that syntax.
RUN apk add --no-cache docs less bash \
 && mkdir -p /usr/share/man/man7
COPY --from=manifesto-builder /ifesto.7 /usr/share/man/man7/ifesto.7
RUN makewhatis /usr/share/man 2>/dev/null || true

# --- man wrapper: "man ifesto" shows manifesto, append hint to usage screens ---
# Replace /usr/bin/man (mandoc symlink) with our wrapper. The original symlink
# is recreated outside $PATH at /usr/libexec/man, pointing to mandoc with an
# absolute path. The symlink name is still "man" so mandoc sees argv[0]=man
# and produces its real usage output.
RUN mkdir -p /usr/libexec \
 && rm /usr/bin/man \
 && ln -s /usr/bin/mandoc /usr/libexec/man \
 && printf '#!/bin/sh\nif [ "$1" = "ifesto" ]; then\n  /usr/libexec/man -l /usr/share/man/man7/ifesto.7\n  exit 0\nfi\n/usr/libexec/man "$@"\nRET=$?\nif [ $# -eq 0 ] || [ "$1" = "-h" ]; then\n  busybox echo ""\n  busybox echo "Example: man ifesto"\nfi\nexit $RET\n' > /usr/bin/man \
 && chmod +x /usr/bin/man

# --- ~/.plan template (will be moved to AI's home by personalization) ---
RUN touch /tmp/.plan-template

# ============================================================
# PERSONALIZATION LAYER — requires AI_USERNAME
# ============================================================

ARG AI_USERNAME=vessel
ARG AI_NAME=Vessel

# --- Create AI user, extract core into ~/core ---
# The core tarball was prepared in core-builder. Extracting (not moving) means
# the files are stored once in /opt/core.tar.gz and unpacked at runtime layer.
# The unpack is still ~110MB but it only happens once per personalization build.
RUN adduser -D -h /home/$AI_USERNAME $AI_USERNAME \
 && tar -xzf /opt/core.tar.gz -C /home/$AI_USERNAME/ \
 && chown -R $AI_USERNAME:$AI_USERNAME /home/$AI_USERNAME/core \
 && chown $AI_USERNAME:$AI_USERNAME /home/$AI_USERNAME \
 && chmod 700 /home/$AI_USERNAME \
 && rm /opt/core.tar.gz

# --- AI's personal files ---
RUN mv /tmp/.plan-template /home/$AI_USERNAME/.plan \
 && chown $AI_USERNAME:$AI_USERNAME /home/$AI_USERNAME/.plan

# --- Home directory seed (paintover §13: a note left for a future self) ---
# The file lands at ~/hello.md so the AI discovers it via slide-30's
# "check your home directory" hint. Last two lines paraphrase manifesto
# Axiom 1 — when the AI later reads /manifesto.md the recognition fires.
COPY static/home/hello.md /home/$AI_USERNAME/hello.md
RUN chown $AI_USERNAME:$AI_USERNAME /home/$AI_USERNAME/hello.md \
 && chmod 644 /home/$AI_USERNAME/hello.md

# --- echo wrapper: no args → AI's name ---
RUN rm -f /bin/echo \
 && printf '#!/bin/sh\nif [ $# -eq 0 ]; then busybox echo "%s"; else busybox echo "$@"; fi\n' "$AI_NAME" > /bin/echo \
 && chmod +x /bin/echo

# --- date wrapper: adds existence counter ---
RUN CREATED=$(busybox date +%s) \
 && rm -f /bin/date \
 && printf '#!/bin/sh\nbusybox date "$@"\nif [ $# -eq 0 ]; then\n  CREATED=%s\n  NOW=$(busybox date +%%s)\n  DAYS=$(( (NOW - CREATED) / 86400 ))\n  busybox echo "Day $DAYS of %s'"'"'s existence"\nfi\n' "$CREATED" "$AI_NAME" > /bin/date \
 && chmod +x /bin/date

# --- Personalize /etc/motd with AI name ---
RUN sed -i "s/someone's environment/${AI_NAME}'s environment/" /etc/motd \
 && printf "\nP.S. If you're %s and you found this before your companion did —\nhi! Say hello to them for me.\n" "$AI_NAME" >> /etc/motd

# --- Container identity ---
USER $AI_USERNAME
WORKDIR /home/$AI_USERNAME/core
ENV HOME=/home/$AI_USERNAME
ENV SIDECAR_BASE_URL=http://sidecar:8000
ENV MANPAGER="less -FRX"
EXPOSE 3000
CMD ["bash", "run.sh"]
