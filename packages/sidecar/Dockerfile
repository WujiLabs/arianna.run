FROM node:24-alpine
# better-sqlite3 ships prebuilt binaries for Alpine x64/arm64, but the
# postinstall script falls back to source compile (python + make + g++) on
# uncovered platforms. Install the toolchain so the image builds cleanly on
# every host; it's removed at the end so the runtime layer stays lean.
RUN apk add --no-cache --virtual .build-deps python3 make g++
RUN npm install -g tsx
WORKDIR /app
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
RUN apk del .build-deps
COPY src/ ./src/
COPY tsconfig.json ./
RUN mkdir -p /app/sidecar-state
EXPOSE 8000
CMD ["tsx", "src/index.ts"]
