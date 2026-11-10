FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The render tier (RENDER_JS=true) needs a browser. It is left out unless asked for, because it
# adds about 300 MB: docker compose build --build-arg WITH_BROWSER=1 app
ARG WITH_BROWSER=0
RUN if [ "$WITH_BROWSER" = "1" ]; then apk add --no-cache chromium; fi
ENV BROWSER_EXECUTABLE=/usr/bin/chromium-browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY public ./public
COPY docs/design.html ./docs/design.html
COPY eval ./eval
EXPOSE 3000
CMD ["node", "dist/index.js"]
