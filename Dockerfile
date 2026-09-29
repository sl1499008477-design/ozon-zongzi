FROM node:22-alpine AS backend-deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /srv/sonli
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS backend
RUN apk add --no-cache ffmpeg tesseract-ocr tesseract-ocr-data-rus tesseract-ocr-data-eng tesseract-ocr-data-chi_sim
ENV NODE_ENV=production
ENV COLLECTOR_MEDIA_FFPROBE_PATH=/usr/bin/ffprobe
ENV OZON_VIDEO_FFMPEG_PATH=/usr/bin/ffmpeg
ENV OZON_VIDEO_FFPROBE_PATH=/usr/bin/ffprobe
WORKDIR /srv/sonli
COPY --from=backend-deps /srv/sonli/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY app/public/ai-channel-samples ./app/public/ai-channel-samples
COPY extension/manifest.json ./extension/manifest.json
USER node
CMD ["node", "server/index.mjs"]

FROM node:22-alpine AS web-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /srv/sonli/app
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY app ./
COPY shared ../shared
ARG VITE_LOCAL_API_BASE=/api
ENV VITE_LOCAL_API_BASE=$VITE_LOCAL_API_BASE
RUN pnpm build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /srv/sonli/app/dist /usr/share/nginx/html
EXPOSE 80
